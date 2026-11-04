import { describe, expect, it, vi } from 'vitest';
import { activityEvents } from '../db/schema/activity-events.js';
import { writeContainerIncidentEvent } from './observability-events.js';
import type { ActivityWriteHandle } from './write-activity-event.js';

function createMockHandle() {
  const returning = vi.fn().mockResolvedValue([{ id: 'event-row-id' }]);
  const values = vi.fn().mockReturnValue({ returning });
  const insert = vi.fn().mockReturnValue({ values });
  return { handle: { insert } as unknown as ActivityWriteHandle, insert, values };
}

describe('writeContainerIncidentEvent (27-02 A3)', () => {
  it.each(['crash_loop', 'out_of_memory'] as const)(
    'writes one system service.container_changed row with ids and the %s diagnosis only',
    async (diagnosis) => {
      const mock = createMockHandle();
      const at = new Date('2026-11-04T00:00:00.000Z');

      const id = await writeContainerIncidentEvent(mock.handle, { serviceId: 'svc-1', serverId: 'srv-1', diagnosis }, at);

      expect(id).toBe('event-row-id');
      expect(mock.insert).toHaveBeenCalledTimes(1);
      expect(mock.insert).toHaveBeenCalledWith(activityEvents);
      const row = mock.values.mock.calls[0]?.[0] as Record<string, unknown>;
      expect(row).toMatchObject({
        actorType: 'system',
        actorId: null,
        entityType: 'service',
        entityId: 'svc-1',
        action: 'service.container_changed',
        outcome: 'success',
        occurredAt: at,
      });
      expect(row.metadata).toEqual({ serverId: 'srv-1', observedState: diagnosis });
    },
  );
});
