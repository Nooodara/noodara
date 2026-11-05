import { SensitiveMetadataError } from '@noodara/domain/activity';
import { describe, expect, it, vi } from 'vitest';
import { activityEvents } from '../db/schema/activity-events.js';
import { writeAiQuestionEvent } from './ai-events.js';
import type { ActivityWriteHandle } from './write-activity-event.js';

function createMockHandle(): { handle: ActivityWriteHandle; insert: ReturnType<typeof vi.fn>; values: ReturnType<typeof vi.fn> } {
  const returning = vi.fn().mockResolvedValue([{ id: 'event-row-id' }]);
  const values = vi.fn().mockReturnValue({ returning });
  const insert = vi.fn().mockReturnValue({ values });
  return { handle: { insert } as unknown as ActivityWriteHandle, insert, values };
}

const CONVERSATION = '0190b5a0-0000-7000-8000-000000000001';
const USER = '0190b5a0-0000-7000-8000-0000000000aa';
const at = new Date('2026-11-04T00:00:00.000Z');

describe('writeAiQuestionEvent (28-05 A4)', () => {
  it('writes one actor-ai row with the conversation id and the distinct tool names', async () => {
    const mock = createMockHandle();
    const id = await writeAiQuestionEvent(
      mock.handle,
      {
        userId: USER,
        conversationId: CONVERSATION,
        outcome: 'answered',
        toolNames: ['list_servers', 'get_logs', 'list_servers'],
        unauthorizedAttempts: 1,
      },
      at,
    );
    expect(id).toBe('event-row-id');
    expect(mock.insert).toHaveBeenCalledWith(activityEvents);
    const row = mock.values.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(row).toMatchObject({
      actorType: 'ai',
      actorId: USER,
      entityType: 'ai_conversation',
      entityId: CONVERSATION,
      action: 'ai.question_answered',
      outcome: 'success',
      metadata: { conversationId: CONVERSATION, tools: ['list_servers', 'get_logs'], toolCalls: 3, unauthorizedAttempts: 1 },
    });
    expect(row.errorCode ?? null).toBeNull();
  });

  it('maps failed and aborted outcomes to failure actions with the error code', async () => {
    const failed = createMockHandle();
    await writeAiQuestionEvent(
      failed.handle,
      { userId: USER, conversationId: CONVERSATION, outcome: 'failed', toolNames: [], unauthorizedAttempts: 0, errorCode: 'AI_PROVIDER_UNAVAILABLE' },
      at,
    );
    expect(failed.values.mock.calls[0]?.[0]).toMatchObject({
      action: 'ai.question_failed',
      outcome: 'failure',
      errorCode: 'AI_PROVIDER_UNAVAILABLE',
    });
    const aborted = createMockHandle();
    await writeAiQuestionEvent(
      aborted.handle,
      { userId: USER, conversationId: CONVERSATION, outcome: 'aborted', toolNames: ['get_server'], unauthorizedAttempts: 0 },
      at,
    );
    expect(aborted.values.mock.calls[0]?.[0]).toMatchObject({ action: 'ai.question_aborted', outcome: 'failure' });
  });

  it('refuses a tool name that is not a tool identifier, so free text never lands in metadata', async () => {
    const mock = createMockHandle();
    await expect(
      writeAiQuestionEvent(
        mock.handle,
        { userId: USER, conversationId: CONVERSATION, outcome: 'answered', toolNames: ['why is prod down?'], unauthorizedAttempts: 0 },
        at,
      ),
    ).rejects.toThrow(SensitiveMetadataError);
    expect(mock.insert).not.toHaveBeenCalled();
  });
});
