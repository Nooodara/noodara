import { describe, expect, it, vi } from 'vitest';
import { activityEvents } from '../db/schema/activity-events.js';
import { writeServiceDomainsChangedEvent } from './domain-events.js';
import type { ActivityWriteHandle } from './write-activity-event.js';

function createMockHandle(): {
  handle: ActivityWriteHandle;
  insert: ReturnType<typeof vi.fn>;
  values: ReturnType<typeof vi.fn>;
} {
  const returning = vi.fn().mockResolvedValue([{ id: 'event-row-id' }]);
  const values = vi.fn().mockReturnValue({ returning });
  const insert = vi.fn().mockReturnValue({ values });
  return { handle: { insert } as unknown as ActivityWriteHandle, insert, values };
}

function insertedRow(values: ReturnType<typeof vi.fn>): Record<string, unknown> {
  return values.mock.calls[0]?.[0] as Record<string, unknown>;
}

describe('writeServiceDomainsChangedEvent (22-03 A1)', () => {
  const at = new Date('2026-10-31T00:00:00.000Z');

  it('writes one service.updated row for a user actor with domains-only metadata', async () => {
    const mock = createMockHandle();

    const id = await writeServiceDomainsChangedEvent(
      mock.handle,
      { actor: { type: 'user', id: 'user-1' }, serviceId: 'svc-1' },
      at,
    );

    expect(id).toBe('event-row-id');
    expect(mock.insert).toHaveBeenCalledTimes(1);
    expect(mock.insert).toHaveBeenCalledWith(activityEvents);
    const row = insertedRow(mock.values);
    expect(row.actorType).toBe('user');
    expect(row.actorId).toBe('user-1');
    expect(row.entityType).toBe('service');
    expect(row.entityId).toBe('svc-1');
    expect(row.action).toBe('service.updated');
    expect(row.outcome).toBe('success');
    expect(row.occurredAt).toEqual(at);
    expect(row.metadata).toEqual({
      changedFields: ['domains'],
      requiresRedeploy: false,
      credentialReplaced: false,
    });
  });

  it('records a system actor with a null actorId (reconcile path)', async () => {
    const mock = createMockHandle();

    await writeServiceDomainsChangedEvent(mock.handle, { actor: { type: 'system' }, serviceId: 'svc-2' }, at);

    const row = insertedRow(mock.values);
    expect(row.actorType).toBe('system');
    expect(row.actorId).toBeNull();
    expect(row.entityId).toBe('svc-2');
  });
});
