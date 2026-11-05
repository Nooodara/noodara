// 28-05 (A1-A4, H1, H2): one question against the read-only agent. Everything that can refuse the
// question (missing conversation, busy, rate limit, no provider) answers before the stream opens.
// Once it opens, the ask always ends with a settled assistant message, an activity event and a
// `done` event; a provider error or an unexpected throw becomes a named failure, never a crash.
import {
  createAIProvider,
  createToolRegistry,
  runAgent,
  type AgentBudget,
  type AgentRunResult,
  type AgentToolCallRecord,
  type AIProvider,
  type ReadToolBackend,
  type ToolOutcome,
} from '@noodara/ai';
import {
  V05_ERROR_MESSAGES,
  V05_SERVICE_ERROR_CODES,
  type AiStructuredAnswer,
  type V05ServiceErrorCode,
} from '@noodara/domain/api-contract';
import type { Redactor } from '@noodara/domain/security';
import type { FastifyBaseLogger } from 'fastify';
import type { Database } from '../../db/client.js';
import { redactForStorage } from '../../db/schema/repositories/ai-message-repository.js';
import type { Redacted } from '../../db/schema/v05-ai.js';
import type { MasterKeys } from '../../services/server-service-deps.js';
import { withStoredAiProvider, type StoredAiProvider } from '../settings/ai-settings-service.js';
import type { AiAskRuntime, AskSlot } from './ask-runtime.js';
import { beginAsk, findOwnedConversation, finishAsk, type FinishedToolCall } from './conversation-store.js';

export interface AiAskLimits {
  /** Hard bound of one stream, from open to `done`. */
  readonly maxStreamMs: number;
  /** Characters per `text` event when the final answer is streamed. */
  readonly answerChunkChars: number;
  readonly budget?: Partial<AgentBudget>;
}

export const DEFAULT_AI_ASK_LIMITS: AiAskLimits = Object.freeze({ maxStreamMs: 120_000, answerChunkChars: 200 });

/** A pending answer older than this many stream bounds is a crashed ask and no longer blocks. */
const STALE_FACTOR = 2;

export type AskStreamEvent =
  | { readonly type: 'start'; readonly data: { conversationId: string; questionId: string; messageId: string } }
  | { readonly type: 'text'; readonly data: { text: string } }
  | { readonly type: 'tool_call'; readonly data: { name: string; scope: { kind: string; id: string } | null } }
  | { readonly type: 'answer'; readonly data: { answer: AiStructuredAnswer } }
  | { readonly type: 'error'; readonly data: { error: V05ServiceErrorCode; message: string } }
  | { readonly type: 'done'; readonly data: { messageId: string; status: 'complete' | 'failed' | 'aborted' } };

export interface AskSink {
  send(event: AskStreamEvent): void;
}

export interface AskServiceDeps {
  readonly db: Database;
  readonly redactor: Redactor;
  readonly masterKeys: MasterKeys;
  readonly runtime: AiAskRuntime;
  readonly backend: ReadToolBackend;
  readonly createProvider: (stored: StoredAiProvider) => AIProvider;
  readonly limits: AiAskLimits;
  readonly now: () => Date;
  readonly log?: FastifyBaseLogger;
}

export interface AskInput {
  readonly userId: string;
  readonly conversationId: string;
  readonly question: string;
  /** Aborted when the client disconnects. */
  readonly clientGone: AbortSignal;
  /** Opens the stream; called once, only after the question is stored. */
  readonly open: () => AskSink;
}

export type AskRefusal =
  | { readonly code: 'AI_CONVERSATION_NOT_FOUND' }
  | { readonly code: 'AI_CONVERSATION_BUSY' }
  | { readonly code: 'RATE_LIMITED'; readonly retryAfterMs: number }
  | { readonly code: 'AI_PROVIDER_NOT_CONFIGURED' }
  | { readonly code: 'AI_PROVIDER_UNAVAILABLE' };

export type AskResult = { readonly streamed: true } | ({ readonly streamed: false } & AskRefusal);

export function defaultCreateProvider(stored: StoredAiProvider): AIProvider {
  return createAIProvider({ id: stored.provider, apiKey: stored.apiKey, model: stored.model });
}

const TOOL_UNAVAILABLE: ToolOutcome = Object.freeze({ ok: false, code: 'TOOL_UNAVAILABLE' });

/** Each read stops waiting once the ask is aborted, so a hung read never outlives the stream. */
export function abortableBackend(backend: ReadToolBackend, signal: AbortSignal): ReadToolBackend {
  const wrap =
    (read: (input: never, scope: never) => Promise<ToolOutcome>) =>
    (input: never, scope: never): Promise<ToolOutcome> => {
      if (signal.aborted) return Promise.resolve(TOOL_UNAVAILABLE);
      return new Promise<ToolOutcome>((resolve, reject) => {
        const onAbort = (): void => {
          resolve(TOOL_UNAVAILABLE);
        };
        signal.addEventListener('abort', onAbort, { once: true });
        read(input, scope).then(
          (outcome) => {
            signal.removeEventListener('abort', onAbort);
            resolve(outcome);
          },
          (error: unknown) => {
            signal.removeEventListener('abort', onAbort);
            reject(error instanceof Error ? error : new Error('tool read failed'));
          },
        );
      });
    };
  const out: Record<string, unknown> = {};
  for (const [name, read] of Object.entries(backend)) {
    out[name] = wrap((read as (input: never, scope: never) => Promise<ToolOutcome>).bind(backend));
  }
  return out as ReadToolBackend;
}

function toV05Code(code: string | null): V05ServiceErrorCode | null {
  return code !== null && (V05_SERVICE_ERROR_CODES as readonly string[]).includes(code) ? (code as V05ServiceErrorCode) : null;
}

function toFinishedCall(record: AgentToolCallRecord): FinishedToolCall {
  return {
    name: record.name,
    scope: record.target === null ? null : { kind: record.target.kind, id: record.target.id },
    status: record.status,
    errorCode: toV05Code(record.errorCode),
    durationMs: record.durationMs,
  };
}

function chunks(text: string, size: number): string[] {
  const out: string[] = [];
  const chars = Array.from(text);
  for (let i = 0; i < chars.length; i += size) out.push(chars.slice(i, i + size).join(''));
  return out;
}

interface Settled {
  readonly outcome: 'answered' | 'failed' | 'aborted';
  readonly answer: AiStructuredAnswer | null;
  readonly errorCode: V05ServiceErrorCode | null;
  readonly toolCalls: readonly AgentToolCallRecord[];
  readonly unauthorizedAttempts: number;
}

function settle(result: AgentRunResult | null, slot: AskSlot): Settled {
  if (result === null) {
    return { outcome: 'failed', answer: null, errorCode: 'AI_PROVIDER_UNAVAILABLE', toolCalls: [], unauthorizedAttempts: 0 };
  }
  const common = { toolCalls: result.toolCalls, unauthorizedAttempts: result.unauthorizedAttempts };
  if (result.status === 'answered') return { ...common, outcome: 'answered', answer: result.answer, errorCode: null };
  if (result.status === 'failed') return { ...common, outcome: 'failed', answer: null, errorCode: result.errorCode };
  // The stream bound is a budget: the question ran out of time, it was not withdrawn.
  if (slot.reason === 'timeout') return { ...common, outcome: 'failed', answer: null, errorCode: 'AI_BUDGET_EXCEEDED' };
  return { ...common, outcome: 'aborted', answer: null, errorCode: null };
}

async function runStream(
  deps: AskServiceDeps,
  input: AskInput,
  slot: AskSlot,
  stored: StoredAiProvider,
  question: Redacted<string>,
): Promise<AskResult> {
  const now = deps.now();
  const begun = await beginAsk(deps.db, {
    userId: input.userId,
    conversationId: input.conversationId,
    question,
    now,
    staleBefore: new Date(now.getTime() - deps.limits.maxStreamMs * STALE_FACTOR),
  });
  if (!begun.ok) {
    return { streamed: false, code: begun.code === 'NOT_FOUND' ? 'AI_CONVERSATION_NOT_FOUND' : 'AI_CONVERSATION_BUSY' };
  }

  const sink = input.open();
  const send = (event: AskStreamEvent): void => {
    try {
      sink.send(event);
    } catch {
      // A failed write is a gone client; the ask still settles below.
    }
  };
  send({ type: 'start', data: { conversationId: input.conversationId, questionId: begun.questionId, messageId: begun.messageId } });

  let streamed = '';
  let result: AgentRunResult | null = null;
  try {
    const provider = deps.runtime.track(deps.createProvider(stored));
    result = await runAgent({
      provider,
      registry: createToolRegistry(abortableBackend(deps.backend, slot.signal)),
      redactor: deps.redactor,
      scope: { kind: 'global' },
      question,
      history: begun.history,
      budget: { ...deps.limits.budget, maxWallClockMs: Math.min(deps.limits.budget?.maxWallClockMs ?? deps.limits.maxStreamMs, deps.limits.maxStreamMs) },
      signal: slot.signal,
      onEvent: (event) => {
        if (event.type === 'text') {
          streamed += event.text;
          send({ type: 'text', data: { text: event.text } });
        } else {
          const call = event.call;
          send({
            type: 'tool_call',
            data: { name: call.name, scope: call.target === null ? null : { kind: call.target.kind, id: call.target.id } },
          });
        }
      },
    });
  } catch (error) {
    deps.log?.warn({ errorName: error instanceof Error ? error.name : 'unknown' }, 'ai ask failed unexpectedly');
    result = null;
  }

  const settled = settle(result, slot);
  if (settled.answer !== null) {
    const text = settled.answer.answer;
    if (streamed !== '') streamed += '\n\n';
    streamed += text;
    for (const piece of chunks(text, deps.limits.answerChunkChars)) send({ type: 'text', data: { text: piece } });
    send({ type: 'answer', data: { answer: settled.answer } });
  } else if (settled.errorCode !== null) {
    send({ type: 'error', data: { error: settled.errorCode, message: V05_ERROR_MESSAGES[settled.errorCode] } });
  }

  const status = settled.outcome === 'answered' ? 'complete' : settled.outcome;
  try {
    await finishAsk(deps.db, {
      userId: input.userId,
      conversationId: input.conversationId,
      messageId: begun.messageId,
      outcome: settled.outcome,
      content: redactForStorage(deps.redactor, streamed),
      answer: settled.answer === null ? null : redactForStorage(deps.redactor, settled.answer),
      errorCode: settled.errorCode,
      toolCalls: settled.toolCalls.map(toFinishedCall),
      unauthorizedAttempts: settled.unauthorizedAttempts,
      now: deps.now(),
    });
  } catch (error) {
    // The stale bound frees the conversation later; the stream still ends cleanly.
    deps.log?.error({ errorName: error instanceof Error ? error.name : 'unknown' }, 'ai ask could not be stored');
  }
  send({ type: 'done', data: { messageId: begun.messageId, status } });
  return { streamed: true };
}

/** Runs one question. Returns a refusal before the stream opens, or `streamed` once it has ended. */
export async function askQuestion(deps: AskServiceDeps, input: AskInput): Promise<AskResult> {
  const owned = await findOwnedConversation(deps.db, input.userId, input.conversationId);
  if (owned === null) return { streamed: false, code: 'AI_CONVERSATION_NOT_FOUND' };

  const slot = deps.runtime.acquire(input.conversationId);
  if (slot === null) return { streamed: false, code: 'AI_CONVERSATION_BUSY' };

  const onClientGone = (): void => {
    slot.abort('client_gone');
  };
  let timer: NodeJS.Timeout | undefined;
  try {
    const rate = deps.runtime.takeQuestion(input.userId, deps.now().getTime());
    if (!rate.ok) return { streamed: false, code: 'RATE_LIMITED', retryAfterMs: rate.retryAfterMs };

    if (input.clientGone.aborted) slot.abort('client_gone');
    input.clientGone.addEventListener('abort', onClientGone, { once: true });
    timer = setTimeout(() => {
      slot.abort('timeout');
    }, deps.limits.maxStreamMs);
    timer.unref();

    const ran = await withStoredAiProvider(deps, async (stored) =>
      runStream(deps, input, slot, stored, redactForStorage(deps.redactor, input.question)),
    );
    if (!ran.ok) {
      return { streamed: false, code: ran.code === 'AI_PROVIDER_NOT_CONFIGURED' ? 'AI_PROVIDER_NOT_CONFIGURED' : 'AI_PROVIDER_UNAVAILABLE' };
    }
    return ran.value;
  } catch (error) {
    deps.log?.error({ errorName: error instanceof Error ? error.name : 'unknown' }, 'ai ask could not start');
    return { streamed: false, code: 'AI_PROVIDER_UNAVAILABLE' };
  } finally {
    clearTimeout(timer);
    input.clientGone.removeEventListener('abort', onClientGone);
    slot.release();
  }
}
