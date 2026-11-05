// 28-04 H1: history bounds keep tool pairs whole, open with a user turn, and never drop the question.
import { describe, expect, it } from 'vitest';
import type { AIMessage } from '../types.js';
import { boundHistory, estimateTokens } from './history.js';

const user = (content: string): AIMessage => ({ role: 'user', content });
const assistant = (content: string, calls = 0): AIMessage => ({
  role: 'assistant',
  content,
  toolCalls: Array.from({ length: calls }, (_, i) => ({ id: `${content}-${String(i)}`, name: 'list_servers', input: {} })),
});
const tool = (id: string): AIMessage => ({ role: 'tool', results: [{ toolCallId: id, content: '{}', isError: false }] });

describe('boundHistory', () => {
  it('returns everything when it fits', () => {
    const messages = [user('q1'), assistant('a1'), user('q2')];
    expect(boundHistory(messages, 2, { maxMessages: 10, maxTokens: 10_000 })).toEqual(
      expect.objectContaining({ messages, dropped: 0 }),
    );
  });

  it('drops the oldest turns first and keeps the question', () => {
    const messages = [user('q1'), assistant('a1'), user('q2'), assistant('a2'), user('q3')];
    const bounded = boundHistory(messages, 4, { maxMessages: 3, maxTokens: 10_000 });
    expect(bounded.messages).toEqual([user('q2'), assistant('a2'), user('q3')]);
    expect(bounded.dropped).toBe(2);
  });

  it('never splits an assistant tool call from its results, and drops current-run pairs after older turns', () => {
    const messages = [user('q1'), assistant('a1'), user('q2'), assistant('t1', 1), tool('t1-0'), assistant('t2', 1), tool('t2-0')];
    const bounded = boundHistory(messages, 2, { maxMessages: 3, maxTokens: 10_000 });
    expect(bounded.messages).toEqual([user('q2'), assistant('t2', 1), tool('t2-0')]);
  });

  it('opens with a user turn after dropping', () => {
    const messages = [assistant('orphan'), user('q1'), assistant('a1'), user('q2')];
    const bounded = boundHistory(messages, 3, { maxMessages: 10, maxTokens: 10_000 });
    expect(bounded.messages[0]).toEqual(user('q1'));
  });

  it('counts the fixed overhead against the token bound but never drops the question', () => {
    const messages = [user('x'.repeat(4_000)), assistant('y'.repeat(4_000)), user('now')];
    const bounded = boundHistory(messages, 2, { maxMessages: 10, maxTokens: 1_500 }, 1_000);
    expect(bounded.messages).toEqual([user('now')]);
    expect(bounded.estimatedTokens).toBe(1_000 + estimateTokens(user('now')));
    expect(boundHistory([user('q')], 0, { maxMessages: 0, maxTokens: 0 }).messages).toEqual([user('q')]);
  });
});
