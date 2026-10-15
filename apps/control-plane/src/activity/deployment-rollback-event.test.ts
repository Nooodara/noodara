import { describe, expect, it, vi } from 'vitest';
import { activityEvents } from '../db/schema/activity-events.js';
import { writeDeploymentRollbackStartedEvent } from './deployment-rollback-event.js';
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

describe('writeDeploymentRollbackStartedEvent (17-07 A4)', () => {
  it('writes one system-actor deployment.rollback_started row with ids-only metadata', async () => {
    const mock = createMockHandle();
    const now = new Date('2026-10-15T00:00:00.000Z');

    const id = await writeDeploymentRollbackStartedEvent(
      mock.handle,
      { deploymentId: 'dep-new', serviceId: 'svc-1', targetDeploymentId: 'dep-old' },
      now,
    );

    expect(id).toBe('event-row-id');
    expect(mock.insert).toHaveBeenCalledTimes(1);
    expect(mock.insert).toHaveBeenCalledWith(activityEvents);
    const row = insertedRow(mock.values);
    expect(row.actorType).toBe('system');
    expect(row.actorId).toBeNull();
    expect(row.entityType).toBe('deployment');
    expect(row.entityId).toBe('dep-new');
    expect(row.action).toBe('deployment.rollback_started');
    expect(row.outcome).toBe('success');
    expect(row.occurredAt).toEqual(now);
    expect(row.metadata).toEqual({
      deploymentId: 'dep-new',
      serviceId: 'svc-1',
      targetDeploymentId: 'dep-old',
    });
  });

  it('omits targetDeploymentId when there is no earlier successful deployment', async () => {
    const mock = createMockHandle();

    await writeDeploymentRollbackStartedEvent(mock.handle, {
      deploymentId: 'dep-new',
      serviceId: 'svc-1',
      targetDeploymentId: null,
    });

    const metadata = insertedRow(mock.values).metadata as Record<string, unknown>;
    expect(metadata).toEqual({ deploymentId: 'dep-new', serviceId: 'svc-1' });
    expect('targetDeploymentId' in metadata).toBe(false);
  });

  it('never carries image refs, runtime config or error text in the metadata', async () => {
    const mock = createMockHandle();

    await writeDeploymentRollbackStartedEvent(mock.handle, {
      deploymentId: 'dep-new',
      serviceId: 'svc-1',
      targetDeploymentId: 'dep-old',
    });

    const metadata = insertedRow(mock.values).metadata as Record<string, unknown>;
    expect(Object.keys(metadata).sort()).toEqual(['deploymentId', 'serviceId', 'targetDeploymentId']);
    expect(insertedRow(mock.values).errorCode).toBeUndefined();
  });
});
