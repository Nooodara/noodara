// D-04/ACT-01: RED for `trustFingerprint` and the `createServerServices` factory. Every
// expectation below fails today for the same reason — apps/control-plane/src/services/
// trust-fingerprint.ts and server-services.ts do not exist yet.
//
// The pending fingerprint this suite trusts is never hand-written onto a row: every arrangement
// registers a server, connects it once successfully via the real `connectAndDiscover` (pinning
// `host_fingerprint`), then runs `connectAndDiscover` a second time with a scripted
// `HOST_KEY_CHANGED` outcome — landing the row on `ERROR` with a real `pending_fingerprint`,
// mirroring connect-and-discover.test.ts's own HOST_KEY_CHANGED arrangement (03-08). The one
// exception is the `SERVER_BUSY` case, which — exactly like connect-and-discover.test.ts's own
// `ALREADY_CONNECTING` test — patches `status` directly, since a genuine `CONNECTING` row is a
// transient in-flight state no service call can be made to pause on.
import { randomUUID } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import { afterEach, describe, expect, it } from 'vitest';
import type { HostFingerprint } from '@noodara/ssh';
import type {
  DiscoveryCheck,
  DiscoveryCheckId,
  DiscoveryFacts,
  DiscoverySnapshot,
} from '@noodara/domain/discovery';
import { activityEvents, servers } from '../../../apps/control-plane/src/db/schema/index.js';
import { assertNoStrayTestContainers } from '../helpers/ssh.js';
import {
  buildFakeSshPort,
  buildFakeSshSession,
  FIXED_NOW,
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

const FP1: HostFingerprint = {
  keyType: 'ssh-ed25519',
  fingerprint: 'SHA256:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
};
const FP2: HostFingerprint = {
  keyType: 'ssh-ed25519',
  fingerprint: 'SHA256:BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB',
};

function freshPassword(): string {
  return randomUUID().replace(/-/g, '');
}

function uniqueName(): string {
  return `srv-${randomUUID().replace(/-/g, '').slice(0, 16)}`;
}

function uniqueHost(): string {
  return `${randomUUID().replace(/-/g, '').slice(0, 12)}.example.test`;
}

function buildFacts(overrides: Partial<DiscoveryFacts> = {}): DiscoveryFacts {
  return {
    hostname: null,
    osDistribution: null,
    osVersion: null,
    arch: null,
    cpuCores: null,
    ramMb: null,
    diskTotalMb: null,
    diskUsedMb: null,
    uptimeSeconds: null,
    dockerInstalled: null,
    dockerVersion: null,
    dockerComposeVersion: null,
    ...overrides,
  };
}

function buildCheck(id: DiscoveryCheckId = 'hostname'): DiscoveryCheck {
  return { id, status: 'pass', detail: `${id}: pass`, durationMs: 5 };
}

function buildSnapshot(): DiscoverySnapshot {
  return { facts: buildFacts(), checks: [buildCheck()], warnings: [] };
}

/** Loaded dynamically on every call — mirrors register-server.test.ts's own discipline: the
 *  module transitively imports apps/control-plane/src/activity/redaction.ts, which reads
 *  env.NOODARA_MASTER_KEY at import time (INST-06) and would otherwise crash the whole worker
 *  process if imported before startServiceFixture() has written a valid test env. */
async function loadTrustFingerprint() {
  return import('../../../apps/control-plane/src/services/trust-fingerprint.js');
}

async function loadServerServices() {
  return import('../../../apps/control-plane/src/services/server-services.js');
}

async function loadRegisterServer() {
  return import('../../../apps/control-plane/src/services/register-server.js');
}

async function loadConnectAndDiscover() {
  return import('../../../apps/control-plane/src/services/connect-and-discover.js');
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

/** Direct row UPDATE, used only to arrange the transient CONNECTING status the SERVER_BUSY case
 *  needs — never used to fabricate a pending fingerprint. */
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

async function fingerprintTrustedEvents(fx: ServiceFixture, serverId: string) {
  return fx.db
    .select()
    .from(activityEvents)
    .where(
      and(
        eq(activityEvents.entityId, serverId),
        eq(activityEvents.action, 'server.fingerprint_trusted'),
      ),
    );
}

async function eventsFor(fx: ServiceFixture, serverId: string) {
  return fx.db.select().from(activityEvents).where(eq(activityEvents.entityId, serverId));
}

/**
 * Arranges a real ERROR row with a real pending_fingerprint (D-04): connects once successfully
 * via connectAndDiscover (pinning host_fingerprint to FP1), then runs connectAndDiscover again
 * with a scripted HOST_KEY_CHANGED outcome (observed fingerprint FP2) — never a direct column
 * write. Returns the server id and the actor used for the arrangement's own two connect calls
 * (irrelevant to the trust call itself, which takes its own actor).
 */
async function arrangeServerWithPendingFingerprint(fx: ServiceFixture): Promise<string> {
  const server = await registerFixtureServer(fx);
  const { connectAndDiscover } = await loadConnectAndDiscover();

  fx.setSshPort(
    buildFakeSshPort({
      ok: true,
      session: buildFakeSshSession({}),
      fingerprint: FP1,
      fingerprintCaptured: true,
      attempts: 1,
    }),
  );
  const first = await connectAndDiscover(fx.deps, {
    actor: SYSTEM,
    serverId: server.id,
    discover: () => Promise.resolve(buildSnapshot()),
  });
  if (!first.ok) {
    throw new Error('arrangeServerWithPendingFingerprint: first connect failed unexpectedly');
  }

  fx.setSshPort(
    buildFakeSshPort({
      ok: false,
      errorCode: 'HOST_KEY_CHANGED',
      message: 'host key changed',
      attempts: 1,
      observedFingerprint: FP2,
    }),
  );
  const second = await connectAndDiscover(fx.deps, { actor: SYSTEM, serverId: server.id });
  if (!second.ok) {
    throw new Error('arrangeServerWithPendingFingerprint: second connect failed unexpectedly');
  }
  if (second.server.status !== 'ERROR' || second.server.pendingFingerprint === null) {
    throw new Error(
      'arrangeServerWithPendingFingerprint: arrangement did not land on ERROR with a pending fingerprint',
    );
  }

  return server.id;
}

describe('trustFingerprint (D-04)', () => {
  it('returns NOT_FOUND for an unknown serverId', async () => {
    fixture = await startServiceFixture();
    const { trustFingerprint } = await loadTrustFingerprint();

    const result = await trustFingerprint(fixture.deps, {
      actor: SYSTEM,
      serverId: randomUUID(),
    });

    expect(result).toMatchObject({ ok: false, code: 'NOT_FOUND' });
  });

  it('returns SERVER_BUSY and changes nothing when the server is CONNECTING', async () => {
    fixture = await startServiceFixture();
    const server = await registerFixtureServer(fixture);
    await patchServerRow(fixture, server.id, { status: 'CONNECTING' });
    const before = await rawServerRow(fixture, server.id);

    const { trustFingerprint } = await loadTrustFingerprint();
    const result = await trustFingerprint(fixture.deps, { actor: SYSTEM, serverId: server.id });

    expect(result).toMatchObject({ ok: false, code: 'SERVER_BUSY' });
    const after = await rawServerRow(fixture, server.id);
    expect(after).toEqual(before);
  });

  it('returns NO_PENDING_FINGERPRINT and changes nothing when there is no pending fingerprint', async () => {
    fixture = await startServiceFixture();
    const server = await registerFixtureServer(fixture);
    const before = await rawServerRow(fixture, server.id);
    const beforeEvents = await eventsFor(fixture, server.id);

    const { trustFingerprint } = await loadTrustFingerprint();
    const result = await trustFingerprint(fixture.deps, { actor: SYSTEM, serverId: server.id });

    expect(result).toMatchObject({ ok: false, code: 'NO_PENDING_FINGERPRINT' });
    const after = await rawServerRow(fixture, server.id);
    expect(after).toEqual(before);
    const afterEventsResult = await eventsFor(fixture, server.id);
    expect(afterEventsResult).toHaveLength(beforeEvents.length);
  });

  it('promotes the pending fingerprint into host_fingerprint and transitions ERROR -> PENDING', async () => {
    fixture = await startServiceFixture();
    const serverId = await arrangeServerWithPendingFingerprint(fixture);
    const before = await rawServerRow(fixture, serverId);
    const pending = before.pendingFingerprint;
    expect(pending).not.toBeNull();

    const { trustFingerprint } = await loadTrustFingerprint();
    const result = await trustFingerprint(fixture.deps, { actor: SYSTEM, serverId });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.server.hostFingerprint).toBe(pending);
    expect(result.server.hostFingerprintCapturedAt).toEqual(FIXED_NOW);
    expect(result.server.pendingFingerprint).toBeNull();
    expect(result.server.pendingFingerprintSeenAt).toBeNull();
    expect(result.server.status).toBe('PENDING');
    // D-04: the trust action does not clear the recorded reason for the prior ERROR.
    expect(result.server.lastErrorCode).toBe(before.lastErrorCode);
  });

  it('writes exactly one server.fingerprint_trusted event with the real before/after fingerprints', async () => {
    fixture = await startServiceFixture();
    const serverId = await arrangeServerWithPendingFingerprint(fixture);
    const before = await rawServerRow(fixture, serverId);
    const previousFingerprint = before.hostFingerprint;
    const newFingerprint = before.pendingFingerprint;
    expect(previousFingerprint).not.toBeNull();
    expect(newFingerprint).not.toBeNull();

    const { trustFingerprint } = await loadTrustFingerprint();
    const result = await trustFingerprint(fixture.deps, { actor: SYSTEM, serverId });
    expect(result.ok).toBe(true);

    const events = await fingerprintTrustedEvents(fixture, serverId);
    expect(events).toHaveLength(1);
    const [event] = events;
    expect(event?.entityType).toBe('server');
    expect(event?.outcome).toBe('success');
    expect(event?.metadata).toEqual({ previousFingerprint, newFingerprint });
  });

  it('calling it twice in a row returns NO_PENDING_FINGERPRINT the second time and writes no second event', async () => {
    fixture = await startServiceFixture();
    const serverId = await arrangeServerWithPendingFingerprint(fixture);

    const { trustFingerprint } = await loadTrustFingerprint();
    const first = await trustFingerprint(fixture.deps, { actor: SYSTEM, serverId });
    expect(first.ok).toBe(true);

    const second = await trustFingerprint(fixture.deps, { actor: SYSTEM, serverId });
    expect(second).toMatchObject({ ok: false, code: 'NO_PENDING_FINGERPRINT' });

    const events = await fingerprintTrustedEvents(fixture, serverId);
    expect(events).toHaveLength(1);
  });

  it('attributes the event to a user actor (D-17)', async () => {
    fixture = await startServiceFixture();
    const serverId = await arrangeServerWithPendingFingerprint(fixture);
    const userId = randomUUID();

    const { trustFingerprint } = await loadTrustFingerprint();
    const result = await trustFingerprint(fixture.deps, {
      actor: { type: 'user', id: userId },
      serverId,
    });
    expect(result.ok).toBe(true);

    const events = await fingerprintTrustedEvents(fixture, serverId);
    expect(events).toHaveLength(1);
    expect(events[0]?.actorType).toBe('user');
    expect(events[0]?.actorId).toBe(userId);
  });

  it('attributes the event to the system actor with a null actorId (D-17)', async () => {
    fixture = await startServiceFixture();
    const serverId = await arrangeServerWithPendingFingerprint(fixture);

    const { trustFingerprint } = await loadTrustFingerprint();
    const result = await trustFingerprint(fixture.deps, { actor: SYSTEM, serverId });
    expect(result.ok).toBe(true);

    const events = await fingerprintTrustedEvents(fixture, serverId);
    expect(events).toHaveLength(1);
    expect(events[0]?.actorType).toBe('system');
    expect(events[0]?.actorId).toBeNull();
  });

  it('returns a ServerView with no credentialId or credential envelope', async () => {
    fixture = await startServiceFixture();
    const serverId = await arrangeServerWithPendingFingerprint(fixture);

    const { trustFingerprint } = await loadTrustFingerprint();
    const result = await trustFingerprint(fixture.deps, { actor: SYSTEM, serverId });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.server).not.toHaveProperty('credentialId');
    expect(result.server).not.toHaveProperty('encryptedValue');
    expect(result.server).not.toHaveProperty('keyVersion');
    expect(result.server.credentialType).toBe('ssh_password');
  });
});

describe('createServerServices factory (D-01, D-17)', () => {
  // Plan 04-05 grows this facade to seven members (failInFlightConnection,
  // listConnectingServerIds); the exhaustive-membership assertion itself now lives in
  // fail-in-flight-connection.test.ts's own "ServerServices facade exposes recovery" suite.
  it('returns the five phase-3 service keys plus the phase-4 recovery members', async () => {
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

  it('registerServer through the factory produces the same result as calling the service directly', async () => {
    fixture = await startServiceFixture();
    const { createServerServices } = await loadServerServices();
    const { registerServer } = await loadRegisterServer();
    const services = createServerServices(fixture.deps);

    const viaFactory = await services.registerServer({
      actor: SYSTEM,
      name: uniqueName(),
      host: uniqueHost(),
      credential: { kind: 'password', password: freshPassword() },
    });
    const viaDirectCall = await registerServer(fixture.deps, {
      actor: SYSTEM,
      name: uniqueName(),
      host: uniqueHost(),
      credential: { kind: 'password', password: freshPassword() },
    });

    expect(viaFactory.ok).toBe(true);
    expect(viaDirectCall.ok).toBe(true);
    if (!viaFactory.ok || !viaDirectCall.ok) return;
    // Both calls used distinct name/host, so compare shape, not identity — the fields present and
    // their types must be identical, proving the factory is a thin binding, not a divergent path.
    expect(Object.keys(viaFactory.server).sort()).toEqual(Object.keys(viaDirectCall.server).sort());
    expect(viaFactory.server.status).toBe(viaDirectCall.server.status);
    expect(viaFactory.server.credentialType).toBe(viaDirectCall.server.credentialType);
  });
});
