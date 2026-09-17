// D-12/ACT-01: RED for `failInFlightConnection` and `listConnectingServerIds`. Every expectation
// below fails today for the same reason — apps/control-plane/src/services/
// fail-in-flight-connection.ts does not exist yet.
//
// A worker never reconnects over SSH when recovering an abandoned CONNECTING row (D-12) — this
// suite proves it never touches deps.ssh (the fixture's default unconfigured SshPort rejects
// loudly the instant .connect is called), records exactly one server.connection_attempted
// failure event per real recovery, and is a true no-op (no event, no status change) for every
// status other than CONNECTING.
import { randomUUID } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import { afterEach, describe, expect, it } from 'vitest';
import { SERVER_STATUSES, type ServerStatus } from '@noodara/domain/server';
import { activityEvents, servers } from '../../../apps/control-plane/src/db/schema/index.js';
import { assertNoStrayTestContainers } from '../helpers/ssh.js';
import {
  startServiceFixture,
  type ServiceFixture,
} from './helpers/service-fixture.js';

let fixture: ServiceFixture | undefined;

afterEach(async () => {
  await fixture?.stop();
  fixture = undefined;

  // noodara-tdd skill §5: no stray container labelled noodara.test=true survives a run.
  await assertNoStrayTestContainers();
});

type FixtureActor = { readonly type: 'user'; readonly id: string } | { readonly type: 'system' };

const SYSTEM: FixtureActor = { type: 'system' };

function freshPassword(): string {
  return randomUUID().replace(/-/g, '');
}

function uniqueName(): string {
  return `srv-${randomUUID().replace(/-/g, '').slice(0, 16)}`;
}

function uniqueHost(): string {
  return `${randomUUID().replace(/-/g, '').slice(0, 12)}.example.test`;
}

/** Loaded dynamically on every call — mirrors trust-fingerprint.test.ts's own discipline: the
 *  module transitively imports apps/control-plane/src/activity/redaction.ts, which reads
 *  env.NOODARA_MASTER_KEY at import time (INST-06) and would otherwise crash the whole worker
 *  process if imported before startServiceFixture() has written a valid test env. */
async function loadFailInFlightConnection() {
  return import('../../../apps/control-plane/src/services/fail-in-flight-connection.js');
}

async function loadServerServices() {
  return import('../../../apps/control-plane/src/services/server-services.js');
}

async function loadRegisterServer() {
  return import('../../../apps/control-plane/src/services/register-server.js');
}

async function registerFixtureServer(fx: ServiceFixture) {
  const { registerServer } = await loadRegisterServer();
  const result = await registerServer(fx.deps, {
    actor: SYSTEM,
    name: uniqueName(),
    host: uniqueHost(),
    credential: { kind: 'password', password: freshPassword() },
  });
  if (!result.ok) {
    throw new Error(`registerFixtureServer failed unexpectedly: ${result.code} ${result.message}`);
  }
  return result.server;
}

/** Direct row UPDATE, used only to arrange a specific starting status — never used to fabricate
 *  a real connection outcome. */
async function patchServerRow(
  fx: ServiceFixture,
  serverId: string,
  patch: Partial<typeof servers.$inferInsert>,
): Promise<void> {
  await fx.db.update(servers).set(patch).where(eq(servers.id, serverId));
}

async function rawServerRow(fx: ServiceFixture, serverId: string) {
  const [row] = await fx.db.select().from(servers).where(eq(servers.id, serverId));
  if (!row) {
    throw new Error(`rawServerRow: server ${serverId} not found`);
  }
  return row;
}

/** Only `server.connection_attempted` rows — `registerFixtureServer` itself already writes a
 *  `server.created` event for the same entityId, which must not be counted here. */
async function connectionAttemptedEvents(fx: ServiceFixture, serverId: string) {
  return fx.db
    .select()
    .from(activityEvents)
    .where(
      and(
        eq(activityEvents.entityId, serverId),
        eq(activityEvents.action, 'server.connection_attempted'),
      ),
    );
}

const NON_CONNECTING_STATUSES: readonly ServerStatus[] = SERVER_STATUSES.filter(
  (status) => status !== 'CONNECTING',
);

describe('failInFlightConnection (D-12)', () => {
  it('returns NOT_FOUND for an unknown serverId and writes nothing', async () => {
    fixture = await startServiceFixture();
    const { failInFlightConnection } = await loadFailInFlightConnection();

    const result = await failInFlightConnection(fixture.deps, {
      actor: SYSTEM,
      serverId: randomUUID(),
      reason: 'worker_stalled',
    });

    expect(result).toMatchObject({ ok: false, code: 'NOT_FOUND' });
  });

  it('resolves a CONNECTING server to ERROR/CONNECTION_LOST', async () => {
    fixture = await startServiceFixture();
    const server = await registerFixtureServer(fixture);
    await patchServerRow(fixture, server.id, { status: 'CONNECTING' });

    const { failInFlightConnection } = await loadFailInFlightConnection();
    const result = await failInFlightConnection(fixture.deps, {
      actor: SYSTEM,
      serverId: server.id,
      reason: 'worker_stalled',
    });

    expect(result.ok).toBe(true);
    if (!result.ok || result.skipped) throw new Error('expected a non-skipped success');
    expect(result.server.status).toBe('ERROR');
    expect(result.server.lastErrorCode).toBe('CONNECTION_LOST');
  });

  it('never calls deps.ssh.connect', async () => {
    fixture = await startServiceFixture();
    const server = await registerFixtureServer(fixture);
    await patchServerRow(fixture, server.id, { status: 'CONNECTING' });

    // The fixture's default SshPort (never configured via setSshPort) rejects loudly the instant
    // connect() is called — if failInFlightConnection ever touched deps.ssh, this call would
    // reject instead of resolving.
    const { failInFlightConnection } = await loadFailInFlightConnection();
    const result = await failInFlightConnection(fixture.deps, {
      actor: SYSTEM,
      serverId: server.id,
      reason: 'worker_stalled',
    });

    expect(result.ok).toBe(true);
  });

  it('writes exactly one server.connection_attempted failure event with reason and error code', async () => {
    fixture = await startServiceFixture();
    const server = await registerFixtureServer(fixture);
    await patchServerRow(fixture, server.id, { status: 'CONNECTING' });

    const { failInFlightConnection } = await loadFailInFlightConnection();
    const result = await failInFlightConnection(fixture.deps, {
      actor: SYSTEM,
      serverId: server.id,
      reason: 'worker_stalled',
    });
    expect(result.ok).toBe(true);

    const events = await connectionAttemptedEvents(fixture, server.id);
    expect(events).toHaveLength(1);
    const [event] = events;
    expect(event?.action).toBe('server.connection_attempted');
    expect(event?.outcome).toBe('failure');
    expect(event?.errorCode).toBe('CONNECTION_LOST');
    expect(event?.metadata).toEqual({ reason: 'worker_stalled' });
  });

  it('publishes exactly one server.updated event carrying the ERROR-status ServerView', async () => {
    fixture = await startServiceFixture();
    const server = await registerFixtureServer(fixture);
    await patchServerRow(fixture, server.id, { status: 'CONNECTING' });

    const { failInFlightConnection } = await loadFailInFlightConnection();
    const before = fixture.events.length;
    const result = await failInFlightConnection(fixture.deps, {
      actor: SYSTEM,
      serverId: server.id,
      reason: 'worker_stalled',
    });
    expect(result.ok).toBe(true);

    const published = fixture.events.slice(before);
    expect(published).toHaveLength(1);
    expect(published[0]).toMatchObject({
      type: 'server.updated',
      server: { id: server.id, status: 'ERROR', lastErrorCode: 'CONNECTION_LOST' },
    });
  });

  it('attributes the event to a user actor (D-17)', async () => {
    fixture = await startServiceFixture();
    const server = await registerFixtureServer(fixture);
    await patchServerRow(fixture, server.id, { status: 'CONNECTING' });
    const userId = randomUUID();

    const { failInFlightConnection } = await loadFailInFlightConnection();
    const result = await failInFlightConnection(fixture.deps, {
      actor: { type: 'user', id: userId },
      serverId: server.id,
      reason: 'worker_startup_sweep',
    });
    expect(result.ok).toBe(true);

    const events = await connectionAttemptedEvents(fixture, server.id);
    expect(events).toHaveLength(1);
    expect(events[0]?.actorType).toBe('user');
    expect(events[0]?.actorId).toBe(userId);
    expect(events[0]?.metadata).toEqual({ reason: 'worker_startup_sweep' });
  });

  it('attributes the event to the system actor with a null actorId (D-17)', async () => {
    fixture = await startServiceFixture();
    const server = await registerFixtureServer(fixture);
    await patchServerRow(fixture, server.id, { status: 'CONNECTING' });

    const { failInFlightConnection } = await loadFailInFlightConnection();
    const result = await failInFlightConnection(fixture.deps, {
      actor: SYSTEM,
      serverId: server.id,
      reason: 'worker_stalled',
    });
    expect(result.ok).toBe(true);

    const events = await connectionAttemptedEvents(fixture, server.id);
    expect(events).toHaveLength(1);
    expect(events[0]?.actorType).toBe('system');
    expect(events[0]?.actorId).toBeNull();
  });

  it('calling it twice in a row on the same CONNECTING server produces exactly one activity row', async () => {
    fixture = await startServiceFixture();
    const server = await registerFixtureServer(fixture);
    await patchServerRow(fixture, server.id, { status: 'CONNECTING' });

    const { failInFlightConnection } = await loadFailInFlightConnection();
    const first = await failInFlightConnection(fixture.deps, {
      actor: SYSTEM,
      serverId: server.id,
      reason: 'worker_stalled',
    });
    expect(first.ok).toBe(true);
    if (!first.ok || first.skipped) throw new Error('expected first call to be a non-skipped success');

    const second = await failInFlightConnection(fixture.deps, {
      actor: SYSTEM,
      serverId: server.id,
      reason: 'worker_stalled',
    });
    expect(second).toMatchObject({ ok: true, skipped: true });

    const events = await connectionAttemptedEvents(fixture, server.id);
    expect(events).toHaveLength(1);
  });

  it.each(NON_CONNECTING_STATUSES)(
    'is a no-op for a server in %s: skipped true, no activity row, no publish, row unchanged',
    async (status) => {
      fixture = await startServiceFixture();
      const server = await registerFixtureServer(fixture);
      await patchServerRow(fixture, server.id, { status });
      const before = await rawServerRow(fixture, server.id);
      const eventsBefore = fixture.events.length;

      const { failInFlightConnection } = await loadFailInFlightConnection();
      const result = await failInFlightConnection(fixture.deps, {
        actor: SYSTEM,
        serverId: server.id,
        reason: 'worker_stalled',
      });

      expect(result).toEqual({ ok: true, skipped: true });
      const after = await rawServerRow(fixture, server.id);
      expect(after).toEqual(before);
      const activityRows = await connectionAttemptedEvents(fixture, server.id);
      expect(activityRows).toHaveLength(0);
      expect(fixture.events.length).toBe(eventsBefore);
    },
  );
});

describe('listConnectingServerIds (D-12)', () => {
  it('returns an empty array when there are no CONNECTING servers', async () => {
    fixture = await startServiceFixture();
    const { listConnectingServerIds } = await loadFailInFlightConnection();

    const ids = await listConnectingServerIds(fixture.deps);

    expect(ids).toEqual([]);
  });

  it('returns only the ids of servers whose status is CONNECTING', async () => {
    fixture = await startServiceFixture();
    const connectingOne = await registerFixtureServer(fixture);
    const connectingTwo = await registerFixtureServer(fixture);
    const pending = await registerFixtureServer(fixture);
    await patchServerRow(fixture, connectingOne.id, { status: 'CONNECTING' });
    await patchServerRow(fixture, connectingTwo.id, { status: 'CONNECTING' });

    const { listConnectingServerIds } = await loadFailInFlightConnection();
    const ids = await listConnectingServerIds(fixture.deps);

    expect(ids.sort()).toEqual([connectingOne.id, connectingTwo.id].sort());
    expect(ids).not.toContain(pending.id);
  });
});

describe('ServerServices facade exposes recovery (D-01, D-17)', () => {
  it('createServerServices(deps).failInFlightConnection behaves identically to the direct call', async () => {
    fixture = await startServiceFixture();
    const server = await registerFixtureServer(fixture);
    await patchServerRow(fixture, server.id, { status: 'CONNECTING' });

    const { createServerServices } = await loadServerServices();
    const services = createServerServices(fixture.deps);

    const result = await services.failInFlightConnection({
      actor: SYSTEM,
      serverId: server.id,
      reason: 'worker_stalled',
    });

    expect(result.ok).toBe(true);
    if (!result.ok || result.skipped) throw new Error('expected a non-skipped success');
    expect(result.server.status).toBe('ERROR');
    expect(result.server.lastErrorCode).toBe('CONNECTION_LOST');
  });

  it('createServerServices(deps).listConnectingServerIds returns the same ids as the direct call', async () => {
    fixture = await startServiceFixture();
    const server = await registerFixtureServer(fixture);
    await patchServerRow(fixture, server.id, { status: 'CONNECTING' });

    const { createServerServices } = await loadServerServices();
    const { listConnectingServerIds } = await loadFailInFlightConnection();
    const services = createServerServices(fixture.deps);

    const viaFacade = await services.listConnectingServerIds();
    const viaDirectCall = await listConnectingServerIds(fixture.deps);

    expect(viaFacade.sort()).toEqual(viaDirectCall.sort());
    expect(viaFacade).toContain(server.id);
  });

  it('returns exactly seven members from createServerServices', async () => {
    fixture = await startServiceFixture();
    const { createServerServices } = await loadServerServices();

    const services = createServerServices(fixture.deps);

    expect(Object.keys(services).sort()).toEqual(
      [
        'connectAndDiscover',
        'deleteServer',
        'editServer',
        'failInFlightConnection',
        'listConnectingServerIds',
        'registerServer',
        'trustFingerprint',
      ].sort(),
    );
  });
});
