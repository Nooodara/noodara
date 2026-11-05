// 28-05 (A4): the activity event one AI question records, actor `ai`. Metadata is the conversation
// id, the distinct tool names used and two counts: never the question, a tool output or the answer.
import type { AiAction } from '@noodara/domain/activity';
import { writeActivityEvent, type ActivityWriteHandle } from './write-activity-event.js';

export type AiQuestionOutcome = 'answered' | 'failed' | 'aborted';

export interface AiQuestionEventInput {
  /** The user who asked; the event's actor is the agent acting for them. */
  readonly userId: string;
  readonly conversationId: string;
  readonly outcome: AiQuestionOutcome;
  /** Every tool call of the question, in order; only the distinct names are recorded. */
  readonly toolNames: readonly string[];
  readonly unauthorizedAttempts: number;
  readonly errorCode?: string | null;
}

const ACTIONS: Readonly<Record<AiQuestionOutcome, AiAction>> = {
  answered: 'ai.question_answered',
  failed: 'ai.question_failed',
  aborted: 'ai.question_aborted',
};

export function writeAiQuestionEvent(handle: ActivityWriteHandle, input: AiQuestionEventInput, at: Date): Promise<string> {
  const tools = [...new Set(input.toolNames)];
  return writeActivityEvent(
    handle,
    {
      actorType: 'ai',
      actorId: input.userId,
      entityType: 'ai_conversation',
      entityId: input.conversationId,
      action: ACTIONS[input.outcome],
      outcome: input.outcome === 'answered' ? 'success' : 'failure',
      ...(input.errorCode !== undefined && input.errorCode !== null ? { errorCode: input.errorCode } : {}),
      metadata: {
        conversationId: input.conversationId,
        tools,
        toolCalls: input.toolNames.length,
        unauthorizedAttempts: input.unauthorizedAttempts,
      },
    },
    at,
  );
}
