// D-20/T-4-11/T-4-40: RED for `listActivityEvents` — apps/control-plane/src/services/
// read-activity.ts does not exist yet. Seeds rows two ways: through real services
// (`registerServer`, whose fixture clock is fixed — see FIXED_NOW below — so every row it writes
// already shares one identical `occurredAt`, which is exactly D-20's tie-break scenario) and via
// direct `writeActivityEvent` calls for a row with a deliberately different, later timestamp, to
// prove `occurredAt` orders ahead of the `id` tiebreak, not the other way round.
import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { assertNoStrayTestContainers } from '../helpers/ssh.js';
import { startServiceFixture, type ServiceFixture } from './helpers/service-fixture.js';

let fixture: ServiceFixture | undefined;

afterEach(async () => {
  await fixture?.stop();
  fixture = undefined;
  await assertNoStrayTestContainers();
});

type FixtureActor = { readonly type: 'user'; readonly id: string } | { readonly type: 'system' };
const SYSTEM: FixtureActor = { type: 'system' };

function uniqueName(suffix: string): string {
  return `srv-${suffix}-${randomUUID().replace(/-/g, '').slice(0, 12)}`;
}

function uniqueHost(): string {
  return `${randomUUID().replace(/-/g, '').slice(0, 12)}.example.test`;
}

function freshPassword(): string {
  return randomUUID().replace(/-/g, '');
}

async function loadRegisterServer() {
  return import('../../../apps/control-plane/src/services/register-server.js');
}

async function loadReadActivity() {
  return import('../../../apps/control-plane/src/services/read-activity.js');
}

async function loadWriteActivityEvent() {
  return import('../../../apps/control-plane/src/activity/write-activity-event.js');
}

/** Every `registerServer` call the fixture's fixed clock stamps with the exact same
 *  `occurredAt` — the default tie-break scenario D-20 must handle correctly. */
async function seedServerCreatedEvents(fx: ServiceFixture, count: number): Promise<void> {
  const { registerServer } = await loadRegisterServer();
  for (let i = 0; i < count; i += 1) {
    const result = await registerServer(fx.deps, {
      actor: SYSTEM,
      name: uniqueName(`seed-${String(i)}`),
      host: uniqueHost(),
      credential: { kind: 'password', password: freshPassword() },
    });
    if (!result.ok) {
      throw new Error(`seedServerCreatedEvents: registerServer failed: ${result.code} ${result.message}`);
    }
  }
}

/** All activity_events ids currently in the fixture's database, ordered exactly the way D-20
 *  requires (`occurred_at desc, id desc`) — the independent "ground truth" every pagination
 *  assertion below compares against. */
async function allEventIdsOrdered(fx: ServiceFixture): Promise<string[]> {
  const { activityEvents } = await import('../../../apps/control-plane/src/db/schema/activity-events.js');
  const { desc } = await import('drizzle-orm');
  const rows = await fx.db
    .select({ id: activityEvents.id })
    .from(activityEvents)
    .orderBy(desc(activityEvents.occurredAt), desc(activityEvents.id));
  return rows.map((row) => row.id);
}

describe('listActivityEvents (D-20)', () => {
  it('returns the 2 most recent events, newest first, plus a nextCursor', async () => {
    fixture = await startServiceFixture();
    await seedServerCreatedEvents(fixture, 3);

    const { listActivityEvents } = await loadReadActivity();
    const result = await listActivityEvents(fixture.deps, { limit: 2 });

    expect(result.items).toHaveLength(2);
    expect(result.nextCursor).not.toBeNull();

    const expectedIds = await allEventIdsOrdered(fixture);
    expect(result.items.map((item) => item.id)).toEqual(expectedIds.slice(0, 2));
  });

  it('walks at least 4 pages of 2 with no row repeated and none skipped', async () => {
    fixture = await startServiceFixture();
    await seedServerCreatedEvents(fixture, 8);

    const { listActivityEvents } = await loadReadActivity();
    const { decodeActivityCursor } = await import('../../../apps/control-plane/src/routes/activity-cursor.js');

    const expectedIds = await allEventIdsOrdered(fixture);
    expect(expectedIds.length).toBeGreaterThanOrEqual(8);

    const collectedIds: string[] = [];
    let cursor: { occurredAt: Date; id: string } | undefined;
    let pages = 0;

    for (;;) {
      const page = await listActivityEvents(fixture.deps, { limit: 2, ...(cursor ? { cursor } : {}) });
      pages += 1;
      collectedIds.push(...page.items.map((item) => item.id));
      if (page.nextCursor === null) {
        break;
      }
      const decoded = decodeActivityCursor(page.nextCursor);
      if (!decoded.ok) {
        throw new Error('unexpected undecodable nextCursor');
      }
      cursor = decoded.cursor;
    }

    expect(pages).toBeGreaterThanOrEqual(4);
    expect(collectedIds).toEqual(expectedIds);
    expect(new Set(collectedIds).size).toBe(collectedIds.length);
  });

  it('returns nextCursor: null on the last page', async () => {
    fixture = await startServiceFixture();
    await seedServerCreatedEvents(fixture, 2);

    const { listActivityEvents } = await loadReadActivity();
    const result = await listActivityEvents(fixture.deps, { limit: 200 });

    expect(result.nextCursor).toBeNull();
  });

  it('orders two events sharing an identical occurred_at deterministically and paginates across the boundary', async () => {
    fixture = await startServiceFixture();
    // The fixture's registerServer clock is fixed (FIXED_NOW) — every seeded row below already
    // shares one identical occurredAt, which is exactly this test's scenario.
    await seedServerCreatedEvents(fixture, 3);

    const { listActivityEvents } = await loadReadActivity();
    const { decodeActivityCursor } = await import('../../../apps/control-plane/src/routes/activity-cursor.js');

    const expectedIds = await allEventIdsOrdered(fixture);
    expect(expectedIds).toHaveLength(3);

    const page1 = await listActivityEvents(fixture.deps, { limit: 2 });
    expect(page1.items.map((item) => item.id)).toEqual(expectedIds.slice(0, 2));
    expect(page1.nextCursor).not.toBeNull();

    const decoded = decodeActivityCursor(page1.nextCursor as string);
    if (!decoded.ok) throw new Error('unexpected undecodable nextCursor');

    const page2 = await listActivityEvents(fixture.deps, { limit: 2, cursor: decoded.cursor });
    expect(page2.items.map((item) => item.id)).toEqual(expectedIds.slice(2));
    expect(page2.nextCursor).toBeNull();
  });

  it('orders a later-occurredAt event ahead of an earlier one regardless of id ordering', async () => {
    fixture = await startServiceFixture();
    const { writeActivityEvent } = await loadWriteActivityEvent();

    const earlyId = await writeActivityEvent(
      fixture.db,
      { actorType: 'system', entityType: 'server', entityId: randomUUID(), action: 'server.created', outcome: 'success' },
      new Date('2020-01-01T00:00:00.000Z'),
    );
    const lateId = await writeActivityEvent(
      fixture.db,
      { actorType: 'system', entityType: 'server', entityId: randomUUID(), action: 'server.created', outcome: 'success' },
      new Date('2030-01-01T00:00:00.000Z'),
    );

    const { listActivityEvents } = await loadReadActivity();
    const result = await listActivityEvents(fixture.deps, { limit: 1 });

    expect(result.items).toHaveLength(1);
    expect(result.items[0]?.id).toBe(lateId);
    expect(result.items[0]?.id).not.toBe(earlyId);
  });

  it('each item exposes exactly the ten documented fields, and never createdAt', async () => {
    fixture = await startServiceFixture();
    await seedServerCreatedEvents(fixture, 1);

    const { listActivityEvents } = await loadReadActivity();
    const result = await listActivityEvents(fixture.deps, { limit: 1 });

    expect(result.items).toHaveLength(1);
    expect(Object.keys(result.items[0] ?? {}).sort()).toEqual(
      [
        'id',
        'occurredAt',
        'actorType',
        'actorId',
        'entityType',
        'entityId',
        'action',
        'outcome',
        'errorCode',
        'metadata',
      ].sort(),
    );
  });

  it('passes metadata through exactly as stored (already redacted on write), no re-redaction', async () => {
    fixture = await startServiceFixture();
    const { writeActivityEvent } = await loadWriteActivityEvent();

    const id = await writeActivityEvent(
      fixture.db,
      {
        actorType: 'system',
        entityType: 'server',
        entityId: randomUUID(),
        action: 'server.created',
        outcome: 'success',
        metadata: { note: 'plain-metadata-value' },
      },
      new Date('2026-06-01T00:00:00.000Z'),
    );

    const { listActivityEvents } = await loadReadActivity();
    const result = await listActivityEvents(fixture.deps, { limit: 1 });

    expect(result.items[0]?.id).toBe(id);
    expect(result.items[0]?.metadata).toEqual({ note: 'plain-metadata-value' });
  });
});
