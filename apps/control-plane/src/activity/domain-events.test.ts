import { describe, expect, it, vi } from 'vitest';
import { activityEvents } from '../db/schema/activity-events.js';
import { writeDomainActivityEvent, writeServiceDomainsChangedEvent } from './domain-events.js';
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

describe('writeDomainActivityEvent (22-04 A3, H4)', () => {
  const at = new Date('2026-10-31T00:00:00.000Z');

  it('writes a domain.certificate_failed row with the error code and allowlisted metadata', async () => {
    const mock = createMockHandle();

    const id = await writeDomainActivityEvent(
      mock.handle,
      {
        actorType: 'system',
        entityType: 'domain',
        entityId: 'dom-1',
        action: 'domain.certificate_failed',
        outcome: 'failure',
        errorCode: 'CERT_DNS_MISMATCH',
        metadata: { serviceId: 'svc-1', previousStatus: 'PENDING' },
      },
      at,
    );

    expect(id).toBe('event-row-id');
    expect(mock.insert).toHaveBeenCalledWith(activityEvents);
    const row = insertedRow(mock.values);
    expect(row.actorType).toBe('system');
    expect(row.entityType).toBe('domain');
    expect(row.entityId).toBe('dom-1');
    expect(row.action).toBe('domain.certificate_failed');
    expect(row.outcome).toBe('failure');
    expect(row.errorCode).toBe('CERT_DNS_MISMATCH');
    expect(row.occurredAt).toEqual(at);
    expect(row.metadata).toEqual({ serviceId: 'svc-1', previousStatus: 'PENDING' });
  });

  it('writes a domain.route_restored row on the service', async () => {
    const mock = createMockHandle();

    await writeDomainActivityEvent(
      mock.handle,
      {
        actorType: 'system',
        entityType: 'service',
        entityId: 'svc-2',
        action: 'domain.route_restored',
        outcome: 'success',
        metadata: { serviceId: 'svc-2', durationMs: 12 },
      },
      at,
    );

    const row = insertedRow(mock.values);
    expect(row.entityType).toBe('service');
    expect(row.action).toBe('domain.route_restored');
    expect(row.metadata).toEqual({ serviceId: 'svc-2', durationMs: 12 });
  });
});
