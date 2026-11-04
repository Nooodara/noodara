import { eq } from 'drizzle-orm';
import type { Redactor } from '@noodara/domain/security';
import type { Database } from '../../client.js';
import { aiConversations, aiMessages, type Redacted } from '../v05-ai.js';

// H1 (26-05): the only way to mint a `Redacted<T>` value. Every AI text column (conversation
// title, message content and answer) requires the brand, so a plain string cannot be written
// to them without first going through a Redactor.

/** Redacts `value` with `redactor` and brands the result as safe to store. */
export function redactForStorage<T>(redactor: Redactor, value: T): Redacted<T> {
  return redactor.redact(value) as Redacted<T>;
}

type Writer = Pick<Database, 'insert' | 'update'>;

export type NewAiConversation = typeof aiConversations.$inferInsert;
export type NewAiMessage = typeof aiMessages.$inferInsert;
export type AiMessageRow = typeof aiMessages.$inferSelect;
export type AiConversationRow = typeof aiConversations.$inferSelect;

export async function insertAiConversation(db: Writer, values: NewAiConversation): Promise<AiConversationRow> {
  const [row] = await db.insert(aiConversations).values(values).returning();
  if (row === undefined) throw new Error('ai_conversations insert returned no row');
  return row;
}

export async function insertAiMessage(db: Writer, values: NewAiMessage): Promise<AiMessageRow> {
  const [row] = await db.insert(aiMessages).values(values).returning();
  if (row === undefined) throw new Error('ai_messages insert returned no row');
  return row;
}

export type AiMessagePatch = Partial<Pick<NewAiMessage, 'status' | 'content' | 'answer' | 'errorCode'>>;

export async function updateAiMessage(db: Writer, id: string, patch: AiMessagePatch): Promise<AiMessageRow | undefined> {
  const [row] = await db
    .update(aiMessages)
    .set({ ...patch, updatedAt: new Date() })
    .where(eq(aiMessages.id, id))
    .returning();
  return row;
}
