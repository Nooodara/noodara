// SERV-03/ACT-01/D-11/D-12/D-14: RED for `deleteServer`. Every expectation below fails today for
// the same reason — `apps/control-plane/src/services/delete-server.ts` does not exist yet —
// mirroring edit-server.test.ts's own dynamic-import discipline: `deleteServer` is loaded via
// `await import(...)` on every call (never a static top-level import), since it transitively
// imports `apps/control-plane/src/activity/redaction.ts`, which reads `env.NOODARA_MASTER_KEY` at
// import time (INST-06) and would otherwise crash the whole worker process if imported before
// `startServiceFixture()` has written a valid test env.
import { randomUUID } from 'node:crypto';
import { eq, sql } from 'drizzle-orm';
import { afterEach, describe, expect, it } from 'vitest';
import {
  activityEvents,
  credentials,
  discoverySnapshots,
  servers,
} from '../../../apps/control-plane/src/db/schema/index.js';
import { seedDiscoverySnapshot } from '../fixtures/representative-data.js';
import { assertNoStrayTestContainers } from '../helpers/ssh.js';
import { startServiceFixture, type ServiceFixture } from './helpers/service-fixture.js';

let fixture: ServiceFixture | undefined;

afterEach(async () => {
  await fixture?.stop();
  fixture = undefined;

  // noodara-tdd skill §5: no stray container labelled noodara.test=true survives a run.
  await assertNoStrayTestContainers();
});

function freshPassword(): string {
  return randomUUID();
}

function uniqueName(): string {
  return `srv-${randomUUID().replace(/-/g, '').slice(0, 16)}`;
}

function uniqueHost(): string {
  return `${randomUUID().replace(/-/g, '').slice(0, 12)}.example.test`;
}

type FixtureActor = { readonly type: 'user'; readonly id: string } | { readonly type: 'system' };

interface RegisterFixtureServerOverrides {
  readonly name?: string;
  readonly host?: string;
  readonly actor?: FixtureActor;
}

/** Loaded dynamically on every call — see the file-header note. */
async function loadRegisterServer() {
  return import('../../../apps/control-plane/src/services/register-server.js');
}

/** Loaded dynamically on every call — the module under RED test does not exist yet. */
async function loadDeleteServer() {
  return import('../../../apps/control-plane/src/services/delete-server.js');
}

async function registerFixtureServer(
  fx: ServiceFixture,
  overrides: RegisterFixtureServerOverrides = {},
) {
  const { registerServer } = await loadRegisterServer();
  const result = await registerServer(fx.deps, {
    actor: overrides.actor ?? { type: 'system' },
    name: overrides.name ?? uniqueName(),
    host: overrides.host ?? uniqueHost(),
    credential: { kind: 'password', password: freshPassword() },
  });
  if (!result.ok) {
    throw new Error(`registerFixtureServer arrangement failed: ${result.code} ${result.message}`);
  }
  return result.server;
}

interface DeleteFixtureInput {
  readonly actor?: FixtureActor;
  readonly serverId: string;
  readonly confirmName: string;
}

async function deleteFixtureServer(fx: ServiceFixture, input: DeleteFixtureInput) {
  const { deleteServer } = await loadDeleteServer();
  return deleteServer(fx.deps, {
    actor: input.actor ?? { type: 'system' },
    serverId: input.serverId,
    confirmName: input.confirmName,
  });
}

/** Test-arrangement-only raw SQL: sets a server's status directly, bypassing every service and
 *  the domain state machine, so a suite case can start from a status `registerServer` itself
 *  cannot produce (CONNECTING). Never used by production code. */
async function setServerStatus(
  fx: ServiceFixture,
  serverId: string,
  status: 'CONNECTING' | 'CONNECTED' | 'ERROR' | 'UNREACHABLE' | 'DISCONNECTED' | 'PENDING',
): Promise<void> {
  await fx.db.execute(
    sql`update servers set status = ${status}::server_status where id = ${serverId}`,
  );
}

async function fetchServerRow(fx: ServiceFixture, serverId: string) {
  const [row] = await fx.db.select().from(servers).where(eq(servers.id, serverId));
  return row;
}

async function fetchCredentialRow(fx: ServiceFixture, credentialId: string) {
  const [row] = await fx.db.select().from(credentials).where(eq(credentials.id, credentialId));
  return row;
}

async function countDiscoverySnapshots(fx: ServiceFixture, serverId: string): Promise<number> {
  const rows = await fx.db
    .select({ id: discoverySnapshots.id })
    .from(discoverySnapshots)
    .where(eq(discoverySnapshots.serverId, serverId));
  return rows.length;
}

async function fetchActivityEventsFor(fx: ServiceFixture, entityId: string) {
  return fx.db.select().from(activityEvents).where(eq(activityEvents.entityId, entityId));
}

/** `registerFixtureServer` arrangement already writes one `server.created` event for the same
 *  entity, so any assertion about the `server.deleted` event this suite is actually testing must
 *  filter to that specific action rather than assume array position. */
async function fetchServerDeletedEvent(fx: ServiceFixture, entityId: string) {
  const events = await fetchActivityEventsFor(fx, entityId);
  return events.find((event) => event.action === 'server.deleted');
}

describe('deleteServer (SERV-03, ACT-01, D-11, D-12, D-14)', () => {
  it('returns NOT_FOUND for an unknown serverId', async () => {
    fixture = await startServiceFixture();

    const result = await deleteFixtureServer(fixture, {
      serverId: randomUUID(),
      confirmName: 'does-not-matter',
    });

    expect(result).toMatchObject({ ok: false, code: 'NOT_FOUND' });
  });

  it('returns SERVER_BUSY for a CONNECTING server, leaves the row intact and writes no event (D-11)', async () => {
    fixture = await startServiceFixture();
    const server = await registerFixtureServer(fixture);
    await setServerStatus(fixture, server.id, 'CONNECTING');
    const eventsBefore = await fetchActivityEventsFor(fixture, server.id);

    const result = await deleteFixtureServer(fixture, {
      serverId: server.id,
      confirmName: server.name,
    });

    expect(result).toMatchObject({ ok: false, code: 'SERVER_BUSY' });
    const row = await fetchServerRow(fixture, server.id);
    expect(row).toBeDefined();
    const eventsAfter = await fetchActivityEventsFor(fixture, server.id);
    expect(eventsAfter).toHaveLength(eventsBefore.length);
  });

  it('rejects a confirmName differing only by case with CONFIRMATION_MISMATCH and deletes nothing (D-12)', async () => {
    fixture = await startServiceFixture();
    const server = await registerFixtureServer(fixture);

    const result = await deleteFixtureServer(fixture, {
      serverId: server.id,
      confirmName: server.name.toUpperCase(),
    });

    expect(result).toMatchObject({ ok: false, code: 'CONFIRMATION_MISMATCH' });
    const row = await fetchServerRow(fixture, server.id);
    expect(row).toBeDefined();
    const events = await fetchActivityEventsFor(fixture, server.id);
    expect(events.some((event) => event.action === 'server.deleted')).toBe(false);
  });

  it('rejects a confirmName with surrounding whitespace with CONFIRMATION_MISMATCH (no trimming, D-12)', async () => {
    fixture = await startServiceFixture();
    const server = await registerFixtureServer(fixture);

    const result = await deleteFixtureServer(fixture, {
      serverId: server.id,
      confirmName: ` ${server.name} `,
    });

    expect(result).toMatchObject({ ok: false, code: 'CONFIRMATION_MISMATCH' });
    const row = await fetchServerRow(fixture, server.id);
    expect(row).toBeDefined();
  });

  it(
    'deletes the server, its credential and its discovery snapshots (cascade), and writes a ' +
      'server.deleted event that outlives the row and the earlier server.created event (D-14)',
    async () => {
      fixture = await startServiceFixture();
      const server = await registerFixtureServer(fixture);
      const rowBefore = await fetchServerRow(fixture, server.id);
      await seedDiscoverySnapshot(fixture.db, server.id);
      await seedDiscoverySnapshot(fixture.db, server.id);
      expect(await countDiscoverySnapshots(fixture, server.id)).toBe(2);

      const result = await deleteFixtureServer(fixture, {
        serverId: server.id,
        confirmName: server.name,
      });

      expect(result).toMatchObject({ ok: true, serverId: server.id });

      const rowAfter = await fetchServerRow(fixture, server.id);
      expect(rowAfter).toBeUndefined();

      const credentialAfter = await fetchCredentialRow(fixture, rowBefore!.credentialId);
      expect(credentialAfter).toBeUndefined();

      expect(await countDiscoverySnapshots(fixture, server.id)).toBe(0);

      const events = await fetchActivityEventsFor(fixture, server.id);
      const createdEvent = events.find((event) => event.action === 'server.created');
      const deletedEvent = events.find((event) => event.action === 'server.deleted');
      expect(createdEvent).toBeDefined();
      expect(deletedEvent).toBeDefined();
      expect(deletedEvent?.entityType).toBe('server');
      expect(deletedEvent?.entityId).toBe(server.id);
      expect(deletedEvent?.outcome).toBe('success');
      expect(deletedEvent?.metadata).toEqual({ name: server.name, host: server.host });
    },
  );

  it('attributes the server.deleted event to a user actor (D-17)', async () => {
    fixture = await startServiceFixture();
    const server = await registerFixtureServer(fixture);
    const userId = randomUUID();

    const result = await deleteFixtureServer(fixture, {
      serverId: server.id,
      confirmName: server.name,
      actor: { type: 'user', id: userId },
    });

    expect(result).toMatchObject({ ok: true });
    const deletedEvent = await fetchServerDeletedEvent(fixture, server.id);
    expect(deletedEvent?.actorType).toBe('user');
    expect(deletedEvent?.actorId).toBe(userId);
  });

  it('attributes the server.deleted event to a system actor with a null actorId (D-17)', async () => {
    fixture = await startServiceFixture();
    const server = await registerFixtureServer(fixture);

    const result = await deleteFixtureServer(fixture, {
      serverId: server.id,
      confirmName: server.name,
      actor: { type: 'system' },
    });

    expect(result).toMatchObject({ ok: true });
    const deletedEvent = await fetchServerDeletedEvent(fixture, server.id);
    expect(deletedEvent?.actorType).toBe('system');
    expect(deletedEvent?.actorId).toBeNull();
  });

  it('does not touch any other server, its credential or its snapshots', async () => {
    fixture = await startServiceFixture();
    const other = await registerFixtureServer(fixture);
    await seedDiscoverySnapshot(fixture.db, other.id);
    const target = await registerFixtureServer(fixture);
    const otherRowBefore = await fetchServerRow(fixture, other.id);

    const result = await deleteFixtureServer(fixture, {
      serverId: target.id,
      confirmName: target.name,
    });

    expect(result).toMatchObject({ ok: true });

    const otherRowAfter = await fetchServerRow(fixture, other.id);
    expect(otherRowAfter).toEqual(otherRowBefore);
    const otherCredential = await fetchCredentialRow(fixture, other.credentialId);
    expect(otherCredential).toBeDefined();
    expect(await countDiscoverySnapshots(fixture, other.id)).toBe(1);
  });

  it('never carries credential material in the result JSON', async () => {
    fixture = await startServiceFixture();
    const server = await registerFixtureServer(fixture);

    const result = await deleteFixtureServer(fixture, {
      serverId: server.id,
      confirmName: server.name,
    });

    expect(result).toMatchObject({ ok: true });
    const json = JSON.stringify(result);
    expect(json).not.toContain('encryptedValue');
    expect(json).not.toContain('credentialId');
  });
});
