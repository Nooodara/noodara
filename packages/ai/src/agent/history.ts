// 28-04 (H1): bounds the history sent to the provider. Messages are grouped into units (an
// assistant turn with tool calls travels with its tool results, so a pair is never split); the
// oldest units go first until the message count and the estimated tokens fit. The system prompt and
// the tool definitions are not messages: they are always sent and count as fixed overhead. The
// current question and the latest unit are never dropped.
import type { AIMessage } from '../types.js';

export interface HistoryLimits {
  readonly maxMessages: number;
  readonly maxTokens: number;
}

export const DEFAULT_HISTORY_LIMITS: HistoryLimits = Object.freeze({ maxMessages: 40, maxTokens: 24_000 });

/** Rough token estimate (about 4 characters per token); good enough for a ceiling. */
export function estimateTokens(value: unknown): number {
  const text = typeof value === 'string' ? value : (JSON.stringify(value) as string | undefined) ?? '';
  return Math.ceil(text.length / 4);
}

export interface BoundedHistory {
  readonly messages: readonly AIMessage[];
  readonly dropped: number;
  readonly estimatedTokens: number;
}

interface Unit {
  readonly messages: readonly AIMessage[];
  readonly tokens: number;
  /** Index of the unit's first message in the input. */
  readonly start: number;
}

function toUnits(messages: readonly AIMessage[]): Unit[] {
  const units: Unit[] = [];
  let index = 0;
  while (index < messages.length) {
    const start = index;
    const first = messages[index] as AIMessage;
    const group: AIMessage[] = [first];
    index += 1;
    if (first.role === 'assistant' && first.toolCalls.length > 0) {
      while (index < messages.length && (messages[index] as AIMessage).role === 'tool') {
        group.push(messages[index] as AIMessage);
        index += 1;
      }
    }
    units.push({ messages: group, tokens: group.reduce((sum, message) => sum + estimateTokens(message), 0), start });
  }
  return units;
}

/**
 * @param protectedFrom index of the current question; it is never dropped.
 * @param overheadTokens system prompt and tool definitions, always sent.
 */
export function boundHistory(
  messages: readonly AIMessage[],
  protectedFrom: number,
  limits: HistoryLimits,
  overheadTokens = 0,
): BoundedHistory {
  const units = toUnits(messages);
  const kept = units.map(() => true);
  const count = (): { messages: number; tokens: number } =>
    units.reduce(
      (sum, unit, i) => (kept[i] === true ? { messages: sum.messages + unit.messages.length, tokens: sum.tokens + unit.tokens } : sum),
      { messages: 0, tokens: overheadTokens },
    );
  const droppable = (i: number): boolean => {
    const unit = units[i] as Unit;
    return unit.start !== protectedFrom && i !== units.length - 1;
  };

  for (let i = 0; i < units.length; i += 1) {
    const total = count();
    if (total.messages <= limits.maxMessages && total.tokens <= limits.maxTokens) break;
    if (droppable(i)) kept[i] = false;
  }
  // A history must open with a user turn: drop any leading non-user unit before the question.
  for (let i = 0; i < units.length; i += 1) {
    if (kept[i] !== true) continue;
    const unit = units[i] as Unit;
    if ((unit.messages[0] as AIMessage).role === 'user' || !droppable(i)) break;
    kept[i] = false;
  }

  const out: AIMessage[] = [];
  let dropped = 0;
  units.forEach((unit, i) => {
    if (kept[i] === true) out.push(...unit.messages);
    else dropped += unit.messages.length;
  });
  return { messages: out, dropped, estimatedTokens: count().tokens };
}
