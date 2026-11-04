// H1 (26-05): AI text columns accept only `Redacted<T>`. The @ts-expect-error lines are checked by
// the control-plane typecheck; the runtime half (redaction of a registered canary) runs here and
// against Postgres in tests/integration/db/migration-0018-0019.test.ts.
import { createRedactor } from '@noodara/domain/security';
import { describe, expect, expectTypeOf, it } from 'vitest';
import type { Database } from '../../client.js';
import { aiConversations, aiMessages, type Redacted } from '../v05-ai.js';
import {
  insertAiConversation,
  insertAiMessage,
  redactForStorage,
  updateAiMessage,
  type NewAiMessage,
} from './ai-message-repository.js';

const CANARY = 'nd-canary-ai-message-7f3a9c21e4';

// Never invoked: these bodies exist only so the typecheck proves the brand is required.
function typeOnlyAssertions(db: Database, conversationId: string): void {
  // @ts-expect-error plain string content is rejected by the repository
  void insertAiMessage(db, { conversationId, role: 'user', status: 'complete', content: 'raw text' });
  // @ts-expect-error plain string content is rejected by drizzle's insert type too
  void db.insert(aiMessages).values({ conversationId, role: 'user', status: 'complete', content: 'raw text' });
  // @ts-expect-error plain string title is rejected
  void insertAiConversation(db, { userId: conversationId, title: 'raw title' });
  // @ts-expect-error plain string title is rejected by drizzle's insert type too
  void db.insert(aiConversations).values({ userId: conversationId, title: 'raw title' });
  // @ts-expect-error a patch cannot set unredacted content
  void updateAiMessage(db, 'id', { content: 'raw text' });
}
describe('redactForStorage', () => {
  it('the brand assertions above are type-checked', () => {
    expectTypeOf(typeOnlyAssertions).toBeFunction();
  });

  it('redacts a registered canary and brands the result', () => {
    const redactor = createRedactor();
    redactor.register(CANARY, 'ai_provider_key');
    const stored = redactForStorage<string>(redactor, `my key is ${CANARY}, why does it fail?`);
    expectTypeOf(stored).toEqualTypeOf<Redacted<string>>();
    expect(stored).not.toContain(CANARY);
    expect(stored).toContain('[REDACTED:ai_provider_key]');
  });

  it('walks structured answers and keeps their shape', () => {
    const redactor = createRedactor();
    redactor.register(CANARY, 'secret');
    const stored = redactForStorage(redactor, { summary: `leaked ${CANARY}`, items: [CANARY] });
    expect(JSON.stringify(stored)).not.toContain(CANARY);
    expect(stored.items).toHaveLength(1);
  });

  it('produces values the message insert type accepts', () => {
    const redactor = createRedactor();
    const values: NewAiMessage = {
      conversationId: '00000000-0000-7000-8000-000000000000',
      role: 'user',
      status: 'complete',
      content: redactForStorage(redactor, 'hello'),
    };
    expect(values.content).toBe('hello');
  });
});
