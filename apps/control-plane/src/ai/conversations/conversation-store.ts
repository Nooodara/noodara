// 28-05 (A2, H1, H2): AI conversations in Postgres. Every read and write is scoped to the owner, so
// another user's conversation is indistinguishable from a missing one. Ids are minted here (UUID
// v7). Text columns take only `Redacted<T>` values. An ask claims the conversation under a row lock:
// a pending assistant message means one is running, unless it is older than the stale bound.
import { and, asc, desc, eq, inArray, lt } from 'drizzle-orm';
import type { AIMessage } from '@noodara/ai';
import {
  AI_CONVERSATION_TITLE_MAX_LENGTH,
  AI_MESSAGE_MAX_LENGTH,
  type AiConversationView,
  type AiMessageView,
  type AiStructuredAnswer,
  type AiToolCallRecord,
  type V05ServiceErrorCode,
} from '@noodara/domain/api-contract';
import type { Redactor } from '@noodara/domain/security';
import { uuidv7 } from 'uuidv7';
import { writeAiQuestionEvent, type AiQuestionOutcome } from '../../activity/ai-events.js';
import type { Database } from '../../db/client.js';
import { redactForStorage } from '../../db/schema/repositories/ai-message-repository.js';
import { aiConversations, aiMessages, aiToolCalls, type Redacted } from '../../db/schema/v05-ai.js';

/** Most conversations a list answers, newest first. */
export const AI_CONVERSATION_LIST_MAX = 200;
/** Most earlier question/answer pairs replayed to the model. */
export const AI_HISTORY_MAX_PAIRS = 20;

type ConversationRow = typeof aiConversations.$inferSelect;
type MessageRow = typeof aiMessages.$inferSelect;
type ToolCallRow = typeof aiToolCalls.$inferSelect;

function iso(value: Date): string {
  return value.toISOString();
}

export function toConversationView(row: ConversationRow): AiConversationView {
  return { id: row.id, title: row.title, createdAt: iso(row.createdAt), updatedAt: iso(row.updatedAt) };
}

function toToolCallView(row: ToolCallRow): AiToolCallRecord {
  return {
    id: row.id,
    name: row.name,
    scope:
      row.scopeKind !== null && row.scopeId !== null
        ? ({ kind: row.scopeKind, id: row.scopeId } as NonNullable<AiToolCallRecord['scope']>)
        : null,
    status: row.status as AiToolCallRecord['status'],
    errorCode: row.errorCode as AiToolCallRecord['errorCode'],
    durationMs: row.durationMs,
    createdAt: iso(row.createdAt),
  };
}

function toMessageView(row: MessageRow, toolCalls: readonly ToolCallRow[]): AiMessageView {
  return {
    id: row.id,
    conversationId: row.conversationId,
    role: row.role as AiMessageView['role'],
    status: row.status as AiMessageView['status'],
    content: row.content,
    answer: row.answer,
    toolCalls: toolCalls.map(toToolCallView),
    errorCode: row.errorCode as AiMessageView['errorCode'],
    createdAt: iso(row.createdAt),
  };
}

/** Cuts redacted text to a column bound without splitting a surrogate pair. */
export function clip(text: string, max: number): string {
  if (text.length <= max) return text;
  const cut = text.slice(0, max);
  return /[\uD800-\uDBFF]$/.test(cut) ? cut.slice(0, -1) : cut;
}

export async function createConversation(
  db: Database,
  redactor: Redactor,
  input: { readonly userId: string; readonly title?: string | undefined; readonly now: Date },
): Promise<AiConversationView> {
  const title = redactForStorage(redactor, clip(input.title ?? '', AI_CONVERSATION_TITLE_MAX_LENGTH));
  const [row] = await db
    .insert(aiConversations)
    .values({ id: uuidv7(), userId: input.userId, title: clip(title, AI_CONVERSATION_TITLE_MAX_LENGTH) as Redacted<string>, createdAt: input.now, updatedAt: input.now })
    .returning();
  if (row === undefined) throw new Error('ai_conversations insert returned no row');
  return toConversationView(row);
}

export async function listConversations(db: Database, userId: string): Promise<AiConversationView[]> {
  const rows = await db
    .select()
    .from(aiConversations)
    .where(eq(aiConversations.userId, userId))
    .orderBy(desc(aiConversations.updatedAt), desc(aiConversations.id))
    .limit(AI_CONVERSATION_LIST_MAX);
  return rows.map(toConversationView);
}

export async function findOwnedConversation(db: Database, userId: string, id: string): Promise<ConversationRow | null> {
  const [row] = await db
    .select()
    .from(aiConversations)
    .where(and(eq(aiConversations.id, id), eq(aiConversations.userId, userId)))
    .limit(1);
  return row ?? null;
}

export async function getConversationDetail(
  db: Database,
  userId: string,
  id: string,
): Promise<{ conversation: AiConversationView; messages: AiMessageView[] } | null> {
  const conversation = await findOwnedConversation(db, userId, id);
  if (conversation === null) return null;
  const messages = await db
    .select()
    .from(aiMessages)
    .where(eq(aiMessages.conversationId, id))
    .orderBy(asc(aiMessages.createdAt), asc(aiMessages.id));
  const ids = messages.map((message) => message.id);
  const calls =
    ids.length === 0
      ? []
      : await db
          .select()
          .from(aiToolCalls)
          .where(inArray(aiToolCalls.messageId, ids))
          .orderBy(asc(aiToolCalls.createdAt), asc(aiToolCalls.id));
  const byMessage = new Map<string, ToolCallRow[]>();
  for (const call of calls) byMessage.set(call.messageId, [...(byMessage.get(call.messageId) ?? []), call]);
  return {
    conversation: toConversationView(conversation),
    messages: messages.map((message) => toMessageView(message, byMessage.get(message.id) ?? [])),
  };
}

/** Deletes the conversation; its messages and tool calls go with it (ON DELETE CASCADE). */
export async function deleteConversation(db: Database, userId: string, id: string): Promise<boolean> {
  const rows = await db
    .delete(aiConversations)
    .where(and(eq(aiConversations.id, id), eq(aiConversations.userId, userId)))
    .returning({ id: aiConversations.id });
  return rows.length > 0;
}

/** The replayed history: complete question/answer pairs only, oldest first. */
function historyFrom(rows: readonly MessageRow[]): AIMessage[] {
  const pairs: [AIMessage, AIMessage][] = [];
  for (let i = 0; i < rows.length - 1; i += 1) {
    const question = rows[i];
    const reply = rows[i + 1];
    if (question?.role !== 'user' || reply?.role !== 'assistant' || reply.status !== 'complete') continue;
    const text = reply.answer?.answer ?? reply.content;
    if (text === '') continue;
    pairs.push([
      { role: 'user', content: question.content },
      { role: 'assistant', content: text, toolCalls: [] },
    ]);
  }
  return pairs.slice(-AI_HISTORY_MAX_PAIRS).flat();
}

export type BeginAskResult =
  | {
      readonly ok: true;
      readonly questionId: string;
      readonly messageId: string;
      readonly history: AIMessage[];
    }
  | { readonly ok: false; readonly code: 'NOT_FOUND' | 'BUSY' };

/**
 * Claims the conversation for one question: locks its row, refuses while another assistant message
 * is pending (H1), marks a pending one older than `staleBefore` aborted (a crashed ask must not keep
 * the conversation locked forever), then stores the question and a pending assistant message.
 */
export async function beginAsk(
  db: Database,
  input: {
    readonly userId: string;
    readonly conversationId: string;
    readonly question: Redacted<string>;
    readonly now: Date;
    readonly staleBefore: Date;
  },
): Promise<BeginAskResult> {
  return db.transaction(async (tx) => {
    const [conversation] = await tx
      .select()
      .from(aiConversations)
      .where(and(eq(aiConversations.id, input.conversationId), eq(aiConversations.userId, input.userId)))
      .for('update');
    if (conversation === undefined) return { ok: false, code: 'NOT_FOUND' } as const;

    await tx
      .update(aiMessages)
      .set({ status: 'aborted', updatedAt: input.now })
      .where(
        and(
          eq(aiMessages.conversationId, input.conversationId),
          eq(aiMessages.status, 'pending'),
          lt(aiMessages.createdAt, input.staleBefore),
        ),
      );
    const rows = await tx
      .select()
      .from(aiMessages)
      .where(eq(aiMessages.conversationId, input.conversationId))
      .orderBy(asc(aiMessages.createdAt), asc(aiMessages.id));
    if (rows.some((row) => row.status === 'pending')) return { ok: false, code: 'BUSY' } as const;

    const questionId = uuidv7();
    const messageId = uuidv7();
    // The assistant row is created a millisecond later so the pair always sorts question first.
    await tx.insert(aiMessages).values([
      {
        id: questionId,
        conversationId: input.conversationId,
        role: 'user',
        status: 'complete',
        content: clip(input.question, AI_MESSAGE_MAX_LENGTH) as Redacted<string>,
        createdAt: input.now,
        updatedAt: input.now,
      },
      {
        id: messageId,
        conversationId: input.conversationId,
        role: 'assistant',
        status: 'pending',
        content: '' as Redacted<string>,
        createdAt: new Date(input.now.getTime() + 1),
        updatedAt: input.now,
      },
    ]);
    const title =
      conversation.title === ''
        ? (clip(input.question.replace(/\s+/g, ' ').trim(), AI_CONVERSATION_TITLE_MAX_LENGTH) as Redacted<string>)
        : conversation.title;
    await tx
      .update(aiConversations)
      .set({ title, updatedAt: input.now })
      .where(eq(aiConversations.id, input.conversationId));
    return { ok: true, questionId, messageId, history: historyFrom(rows) } as const;
  });
}

export interface FinishedToolCall {
  readonly name: string;
  readonly scope: { readonly kind: string; readonly id: string } | null;
  readonly status: 'ok' | 'error' | 'refused';
  readonly errorCode: V05ServiceErrorCode | null;
  readonly durationMs: number;
}

export interface FinishAskInput {
  readonly userId: string;
  readonly conversationId: string;
  readonly messageId: string;
  readonly outcome: AiQuestionOutcome;
  /** Redacted streamed text; never marked complete unless `answer` is set. */
  readonly content: Redacted<string>;
  readonly answer: Redacted<AiStructuredAnswer> | null;
  readonly errorCode: V05ServiceErrorCode | null;
  readonly toolCalls: readonly FinishedToolCall[];
  readonly unauthorizedAttempts: number;
  readonly now: Date;
}

/**
 * Settles the assistant message, its tool-call records and the activity event in one transaction.
 * A message deleted meanwhile (its conversation was deleted) only records the event.
 */
export async function finishAsk(db: Database, input: FinishAskInput): Promise<void> {
  const status = input.outcome === 'answered' && input.answer !== null ? 'complete' : input.outcome === 'aborted' ? 'aborted' : 'failed';
  await db.transaction(async (tx) => {
    const [message] = await tx
      .update(aiMessages)
      .set({
        status,
        content: clip(input.content, AI_MESSAGE_MAX_LENGTH) as Redacted<string>,
        answer: status === 'complete' ? input.answer : null,
        errorCode: input.errorCode,
        updatedAt: input.now,
      })
      .where(and(eq(aiMessages.id, input.messageId), eq(aiMessages.status, 'pending')))
      .returning({ id: aiMessages.id });
    if (message !== undefined) {
      if (input.toolCalls.length > 0) {
        await tx.insert(aiToolCalls).values(
          input.toolCalls.map((call, index) => ({
            id: uuidv7(),
            messageId: input.messageId,
            name: call.name,
            scopeKind: call.scope?.kind ?? null,
            scopeId: call.scope?.id ?? null,
            status: call.status,
            errorCode: call.errorCode,
            durationMs: Math.max(0, Math.round(call.durationMs)),
            createdAt: new Date(input.now.getTime() - input.toolCalls.length + index),
          })),
        );
      }
      await tx.update(aiConversations).set({ updatedAt: input.now }).where(eq(aiConversations.id, input.conversationId));
    }
    await writeAiQuestionEvent(
      tx,
      {
        userId: input.userId,
        conversationId: input.conversationId,
        outcome: status === 'complete' ? 'answered' : input.outcome === 'aborted' ? 'aborted' : 'failed',
        toolNames: input.toolCalls.map((call) => call.name),
        unauthorizedAttempts: input.unauthorizedAttempts,
        errorCode: input.errorCode,
      },
      input.now,
    );
  });
}
