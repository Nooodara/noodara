import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { afterEach, describe, expect, it } from 'vitest';
import { AUTH_ACTIONS } from '@noodara/domain/activity';
import { startTestApp, type TestAppFixture } from '../helpers/app.js';

// `writeActivityEvent`/`appRedactor` transitively import `apps/control-plane/src/env.ts`, which
// fail-fasts at *import time* (INST-06). Every dynamic import below happens only after
// `startTestApp()` has already written a valid test environment to `process.env` (Plan 01-07's
// `tests/integration/helpers/app.ts` convention) — a static top-level import here would crash the
// whole worker before any test ran, the same class of bug documented in Plan 01-07's Summary.

let fixture: TestAppFixture | undefined;

afterEach(async () => {
  await fixture?.stop();
  fixture = undefined;

  // noodara-tdd skill §5: no stray container labelled noodara.test=true survives a run.
  const { getContainerRuntimeClient } = await import('testcontainers');
  const client = await getContainerRuntimeClient();
  const containers = await client.container.list();
  const stray = containers.filter((c) => c.Labels['noodara.test'] === 'true');
  expect(stray).toHaveLength(0);
});

function expectedOutcome(action: string): 'success' | 'failure' {
  return action.includes('failed') || action.includes('blocked') ? 'failure' : 'success';
}

interface ActivityRow {
  action: string;
  outcome: string;
  actor_type: string;
}

describe('auth events land correctly in a real database (AUTH-04)', () => {
  it('writes one row per AUTH_ACTIONS entry with the correct action, outcome and actor_type', async () => {
    fixture = await startTestApp();
    const { writeActivityEvent } = await import(
      '../../../apps/control-plane/src/activity/write-activity-event.js'
    );
    const adminId = randomUUID();

    let occurredAt = new Date('2026-01-01T00:00:00.000Z');
    for (const action of AUTH_ACTIONS) {
      await writeActivityEvent(
        fixture.db,
        {
          actorType: 'user',
          actorId: adminId,
          entityType: 'user',
          entityId: adminId,
          action,
          outcome: expectedOutcome(action),
        },
        occurredAt,
      );
      occurredAt = new Date(occurredAt.getTime() + 1000);
    }

    // Queried via raw SQL (not the ORM) so a column-name mismatch between the domain shape and
    // the Drizzle schema is caught, per this task's own instruction.
    const result = await fixture.db.execute<ActivityRow>(
      sql`select action, outcome, actor_type from activity_events order by occurred_at asc`,
    );
    expect(result.rows).toHaveLength(AUTH_ACTIONS.length);
    for (const [index, action] of AUTH_ACTIONS.entries()) {
      const row = result.rows[index];
      expect(row).toBeDefined();
      expect(row?.action).toBe(action);
      expect(row?.outcome).toBe(expectedOutcome(action));
      expect(row?.actor_type).toBe('user');
    }
  });

  it('persists email and ip for a failed login, and rejects a password key before touching the database', async () => {
    fixture = await startTestApp();
    const { writeActivityEvent } = await import(
      '../../../apps/control-plane/src/activity/write-activity-event.js'
    );

    await writeActivityEvent(fixture.db, {
      actorType: 'user',
      actorId: null,
      entityType: 'user',
      entityId: randomUUID(),
      action: 'auth.login_failed',
      outcome: 'failure',
      metadata: { email: 'unknown@example.com', ip: '203.0.113.7' },
    });

    const beforeCount = await fixture.db.execute<{ count: string }>(
      sql`select count(*)::text as count from activity_events`,
    );

    await expect(
      writeActivityEvent(fixture.db, {
        actorType: 'user',
        actorId: null,
        entityType: 'user',
        entityId: randomUUID(),
        action: 'auth.login_failed',
        outcome: 'failure',
        metadata: { email: 'unknown@example.com', password: 'hunter2' },
      }),
    ).rejects.toThrow('sensitive value');

    const afterCount = await fixture.db.execute<{ count: string }>(
      sql`select count(*)::text as count from activity_events`,
    );
    expect(afterCount.rows[0]?.count).toBe(beforeCount.rows[0]?.count);

    const persisted = await fixture.db.execute<{ metadata: { email: string; ip: string } }>(
      sql`select metadata from activity_events where action = 'auth.login_failed' limit 1`,
    );
    expect(persisted.rows[0]?.metadata.email).toBe('unknown@example.com');
    expect(persisted.rows[0]?.metadata.ip).toBe('203.0.113.7');
  });

  it('discards the event row when the enclosing transaction is rolled back', async () => {
    fixture = await startTestApp();
    const { writeActivityEvent } = await import(
      '../../../apps/control-plane/src/activity/write-activity-event.js'
    );

    await expect(
      fixture.db.transaction(async (tx) => {
        await writeActivityEvent(tx, {
          actorType: 'system',
          actorId: null,
          entityType: 'user',
          entityId: randomUUID(),
          action: 'auth.logout',
          outcome: 'success',
        });
        throw new Error('rollback marker');
      }),
    ).rejects.toThrow('rollback marker');

    const result = await fixture.db.execute<{ count: string }>(
      sql`select count(*)::text as count from activity_events`,
    );
    expect(result.rows[0]?.count).toBe('0');
  });

  it('reads rows back newest-first using the occurred_at desc index', async () => {
    fixture = await startTestApp();
    const { writeActivityEvent } = await import(
      '../../../apps/control-plane/src/activity/write-activity-event.js'
    );

    const times = [
      new Date('2026-01-01T00:00:00.000Z'),
      new Date('2026-01-03T00:00:00.000Z'),
      new Date('2026-01-02T00:00:00.000Z'),
    ];
    for (const occurredAt of times) {
      await writeActivityEvent(
        fixture.db,
        {
          actorType: 'system',
          actorId: null,
          entityType: 'user',
          entityId: randomUUID(),
          action: 'auth.logout',
          outcome: 'success',
        },
        occurredAt,
      );
    }

    const result = await fixture.db.execute<{ occurred_at: Date }>(
      sql`select occurred_at from activity_events order by occurred_at desc`,
    );
    const returned = result.rows.map((row) => new Date(row.occurred_at).getTime());
    const expected = [...times].map((d) => d.getTime()).sort((a, b) => b - a);
    expect(returned).toEqual(expected);
  });
});
