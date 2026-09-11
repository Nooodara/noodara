import { describe, expect, it, vi } from 'vitest';
import { SecretValue, secretValue } from '@noodara/domain/security';
import { activityEvents } from '../db/schema/activity-events.js';
import { appRedactor, toLogSafe } from './redaction.js';
import { writeActivityEvent, type ActivityWriteHandle } from './write-activity-event.js';

interface MockHandle {
  handle: ActivityWriteHandle;
  insert: ReturnType<typeof vi.fn>;
  values: ReturnType<typeof vi.fn>;
  returning: ReturnType<typeof vi.fn>;
}

/**
 * Mocks the database handle at the boundary Drizzle presents (`.insert(table).values(v).returning()`)
 * rather than mocking `write-activity-event.ts` itself, so every assertion below exercises the
 * real `writeActivityEvent` logic (build -> redact -> insert) against a fake persistence layer.
 */
function createMockHandle(insertedId = 'test-row-id'): MockHandle {
  const returning = vi.fn().mockResolvedValue([{ id: insertedId }]);
  const values = vi.fn().mockReturnValue({ returning });
  const insert = vi.fn().mockReturnValue({ values });
  return { handle: { insert } as unknown as ActivityWriteHandle, insert, values, returning };
}

describe('writeActivityEvent', () => {
  it('builds the event, redacts metadata, and inserts exactly one row', async () => {
    const mock = createMockHandle();

    const id = await writeActivityEvent(
      mock.handle,
      {
        actorType: 'user',
        actorId: 'admin-id',
        entityType: 'user',
        entityId: 'admin-id',
        action: 'auth.login_succeeded',
        outcome: 'success',
        metadata: { ip: '10.0.0.1' },
      },
      new Date('2026-01-01T00:00:00.000Z'),
    );

    expect(id).toBe('test-row-id');
    expect(mock.insert).toHaveBeenCalledTimes(1);
    expect(mock.insert).toHaveBeenCalledWith(activityEvents);
    expect(mock.values).toHaveBeenCalledTimes(1);
    const inserted = mock.values.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(inserted.actorType).toBe('user');
    expect(inserted.action).toBe('auth.login_succeeded');
    expect(inserted.outcome).toBe('success');
    expect(inserted.occurredAt).toEqual(new Date('2026-01-01T00:00:00.000Z'));
  });

  it('accepts a transaction-shaped handle without opening its own transaction', async () => {
    // Structurally identical to the real handle from the caller's point of view — this test only
    // proves `writeActivityEvent` does not branch on handle identity; the "never opens its own
    // transaction" guarantee is enforced by the acceptance-criteria grep, not by this mock.
    const mock = createMockHandle('tx-row-id');

    const id = await writeActivityEvent(mock.handle, {
      actorType: 'system',
      actorId: null,
      entityType: 'server',
      entityId: 'server-id',
      action: 'auth.setup_completed',
      outcome: 'success',
    });

    expect(id).toBe('tx-row-id');
    expect(mock.insert).toHaveBeenCalledTimes(1);
  });

  it('redacts a registered canary value nested two levels deep in metadata before persisting', async () => {
    const mock = createMockHandle();
    const canary = 'unit-test-canary-value-12345';
    appRedactor.register(canary, 'test_canary');

    try {
      await writeActivityEvent(mock.handle, {
        actorType: 'user',
        actorId: 'admin-id',
        entityType: 'user',
        entityId: 'admin-id',
        action: 'auth.login_failed',
        outcome: 'failure',
        metadata: { attempt: { detail: { note: canary } } },
      });

      const inserted = mock.values.mock.calls[0]?.[0] as { metadata: { attempt: { detail: { note: string } } } };
      expect(inserted.metadata.attempt.detail.note).toContain('[REDACTED:');
      expect(inserted.metadata.attempt.detail.note).not.toContain(canary);
    } finally {
      appRedactor.release(canary);
    }
  });

  it('rejects metadata containing a forbidden key and never touches the database', async () => {
    const mock = createMockHandle();

    await expect(
      writeActivityEvent(mock.handle, {
        actorType: 'user',
        actorId: null,
        entityType: 'user',
        entityId: 'unknown@example.com',
        action: 'auth.login_failed',
        outcome: 'failure',
        metadata: { email: 'unknown@example.com', password: 'hunter2' },
      }),
    ).rejects.toThrow('sensitive value');

    expect(mock.insert).not.toHaveBeenCalled();
  });

  it('defaults occurredAt to the current time when no clock is injected', async () => {
    const mock = createMockHandle();
    const before = Date.now();

    await writeActivityEvent(mock.handle, {
      actorType: 'system',
      actorId: null,
      entityType: 'user',
      entityId: 'admin-id',
      action: 'auth.logout',
      outcome: 'success',
    });

    const after = Date.now();
    const inserted = mock.values.mock.calls[0]?.[0] as { occurredAt: Date };
    expect(inserted.occurredAt.getTime()).toBeGreaterThanOrEqual(before);
    expect(inserted.occurredAt.getTime()).toBeLessThanOrEqual(after);
  });
});

describe('toLogSafe', () => {
  it('drops credentialId and any forbidden-named field from a servers-shaped entity', () => {
    const safe = toLogSafe({
      id: 'server-id',
      name: 'prod-1',
      host: '10.0.0.5',
      credentialId: 'credential-id',
      sshPassword: 'hunter2',
    });

    expect(safe).toEqual({ id: 'server-id', name: 'prod-1', host: '10.0.0.5' });
    expect(safe).not.toHaveProperty('credentialId');
    expect(safe).not.toHaveProperty('sshPassword');
  });

  it('never returns a SecretValue instance for any field', () => {
    const secret = secretValue('raw-value', 'ssh_password');
    const safe = toLogSafe({ id: 'server-id', name: 'prod-1', pending: secret });

    expect(Object.values(safe).some((value) => value instanceof SecretValue)).toBe(false);
  });

  it('maps a credentials row to only { id, type, keyVersion }', () => {
    const safe = toLogSafe({
      id: 'credential-id',
      type: 'ssh_password',
      encryptedValue: 'v1:nonce:cipher:tag',
      keyVersion: 1,
      createdAt: new Date('2026-01-01T00:00:00.000Z'),
      updatedAt: new Date('2026-01-01T00:00:00.000Z'),
    });

    expect(safe).toEqual({ id: 'credential-id', type: 'ssh_password', keyVersion: 1 });
    expect(safe).not.toHaveProperty('encryptedValue');
  });
});
