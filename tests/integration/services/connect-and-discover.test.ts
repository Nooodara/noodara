// DISC-03/ACT-01: RED for `connectAndDiscover`. Every expectation below fails today for the same
// reason — `apps/control-plane/src/services/connect-and-discover.ts` does not exist yet.
// `connectAndDiscover` itself is loaded via a dynamic `await import(...)` on every call (never a
// static top-level import), mirroring `register-server.test.ts`'s own discipline: the module
// transitively imports `apps/control-plane/src/activity/redaction.ts`, which reads
// `env.NOODARA_MASTER_KEY` at import time (INST-06) and would otherwise crash the whole worker
// process if imported before `startServiceFixture()` has written a valid test env.
//
// Chosen seam (03-CONTEXT.md D-01, this plan's own Task 1 instruction): scripting `runDiscovery`'s
// internals through the fake `SshSession`'s `exec` map is impractical for the discovery-outcome
// matrix this suite needs (D-02's warnings/checks combinations). Instead, `connectAndDiscover`
// accepts an optional `discover?: typeof runDiscovery` on its own input (Task 2/3 add this),
// defaulting to the real `runDiscovery` in production. Every test below that needs a specific
// `DiscoverySnapshot` passes a `discover` override that ignores its `RunDiscoveryInput` and
// resolves directly to a fixture-built snapshot.
//
// `patchServerRow` (a direct `drizzle` `UPDATE ... WHERE id = ...`, not a service call) stands in
// for "raw SQL" in this plan's own Task 1 instruction — it bypasses `packages/domain`'s
// `transition()`/`applyConnectionResult` entirely, which is the only property this suite's
// arrangement step actually needs (setting an otherwise-unreachable starting row state, e.g.
// status `CONNECTING`, a pinned `host_fingerprint`, or pre-existing discovery facts).
import { randomUUID } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import { afterEach, describe, expect, it } from 'vitest';
import { formatFingerprint, parseFingerprint, type HostFingerprint } from '@noodara/ssh';
import type {
  DiscoveryCheck,
  DiscoveryCheckId,
  DiscoveryCheckStatus,
  DiscoveryFacts,
  DiscoverySnapshot,
} from '@noodara/domain/discovery';
import type { ServerErrorCode } from '@noodara/domain/server';
import {
  activityEvents,
  discoverySnapshots,
  servers,
} from '../../../apps/control-plane/src/db/schema/index.js';
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

/** Loaded dynamically on every call — see the file-header note on why this cannot be a static
 *  top-level import. */
async function loadConnectAndDiscover() {
  return import('../../../apps/control-plane/src/services/connect-and-discover.js');
}

/** Loaded dynamically for the same reason `registerServer` is in register-server.test.ts — used
 *  here only to arrange a real `servers`/`credentials` row for `connectAndDiscover` to act on. */
async function loadRegisterServer() {
  return import('../../../apps/control-plane/src/services/register-server.js');
}

interface RegisterFixtureServerOverrides {
  readonly name?: string;
  readonly host?: string;
  readonly sshPort?: number;
  readonly sshUser?: string;
  readonly password?: string;
}

async function registerFixtureServer(
  fx: ServiceFixture,
  overrides: RegisterFixtureServerOverrides = {},
) {
  const { registerServer } = await loadRegisterServer();
  const result = await registerServer(fx.deps, {
    actor: SYSTEM,
    name: overrides.name ?? uniqueName(),
    host: overrides.host ?? uniqueHost(),
    ...(overrides.sshPort !== undefined ? { sshPort: overrides.sshPort } : {}),
    ...(overrides.sshUser !== undefined ? { sshUser: overrides.sshUser } : {}),
    credential: { kind: 'password', password: overrides.password ?? freshPassword() },
  });
  if (!result.ok) {
    throw new Error(`registerFixtureServer failed unexpectedly: ${result.code} ${result.message}`);
  }
  return result.server;
}

/** Direct row UPDATE, bypassing every service/domain rule — see the file-header note. */
async function patchServerRow(
  fx: ServiceFixture,
  serverId: string,
  patch: Partial<typeof servers.$inferInsert>,
): Promise<void> {
  await fx.db.update(servers).set(patch).where(eq(servers.id, serverId));
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

function buildCheck(
  id: DiscoveryCheckId,
  status: DiscoveryCheckStatus,
  detail = `${id}: ${status}`,
): DiscoveryCheck {
  return { id, status, detail, durationMs: 5 };
}

function buildSnapshot(overrides: Partial<DiscoverySnapshot> = {}): DiscoverySnapshot {
  return {
    facts: buildFacts(),
    checks: [buildCheck('hostname', 'pass')],
    warnings: [],
    ...overrides,
  };
}

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

async function discoveryCompletedEvents(fx: ServiceFixture, serverId: string) {
  return fx.db
    .select()
    .from(activityEvents)
    .where(
      and(
        eq(activityEvents.entityId, serverId),
        eq(activityEvents.action, 'server.discovery_completed'),
      ),
    );
}

async function eventsFor(fx: ServiceFixture, serverId: string) {
  return fx.db.select().from(activityEvents).where(eq(activityEvents.entityId, serverId));
}

async function snapshotsFor(fx: ServiceFixture, serverId: string) {
  return fx.db.select().from(discoverySnapshots).where(eq(discoverySnapshots.serverId, serverId));
}

async function serverRow(fx: ServiceFixture, serverId: string) {
  const [row] = await fx.db.select().from(servers).where(eq(servers.id, serverId));
  return row;
}

describe('connect phase (D-01, D-05, fingerprints)', () => {
  it('returns NOT_FOUND for an unknown serverId', async () => {
    fixture = await startServiceFixture();
    const { connectAndDiscover } = await loadConnectAndDiscover();

    const result = await connectAndDiscover(fixture.deps, {
      actor: SYSTEM,
      serverId: randomUUID(),
    });

    expect(result).toMatchObject({ ok: false, code: 'NOT_FOUND' });
  });

  it('returns ALREADY_CONNECTING without opening SSH or writing an event (D-05)', async () => {
    fixture = await startServiceFixture();
    const server = await registerFixtureServer(fixture);
    await patchServerRow(fixture, server.id, { status: 'CONNECTING' });
    const fakeSsh = buildFakeSshPort({
      ok: true,
      session: buildFakeSshSession({}),
      fingerprint: FP1,
      fingerprintCaptured: true,
      attempts: 1,
    });
    fixture.setSshPort(fakeSsh);
    const before = await eventsFor(fixture, server.id);

    const { connectAndDiscover } = await loadConnectAndDiscover();
    const result = await connectAndDiscover(fixture.deps, { actor: SYSTEM, serverId: server.id });

    expect(result).toMatchObject({ ok: false, code: 'ALREADY_CONNECTING' });
    expect(fakeSsh.calls).toHaveLength(0);
    const after = await eventsFor(fixture, server.id);
    expect(after).toHaveLength(before.length);
  });

  it('passes target/timeouts/redactor and a null trustedFingerprint on a first connect', async () => {
    fixture = await startServiceFixture();
    const server = await registerFixtureServer(fixture, { sshPort: 2201, sshUser: 'deployer' });
    const session = buildFakeSshSession({});
    const fakeSsh = buildFakeSshPort({
      ok: true,
      session,
      fingerprint: FP1,
      fingerprintCaptured: true,
      attempts: 1,
    });
    fixture.setSshPort(fakeSsh);

    const { connectAndDiscover } = await loadConnectAndDiscover();
    await connectAndDiscover(fixture.deps, {
      actor: SYSTEM,
      serverId: server.id,
      discover: () => Promise.resolve(buildSnapshot()),
    });

    expect(fakeSsh.calls).toHaveLength(1);
    const [input] = fakeSsh.calls;
    expect(input?.target).toEqual({
      host: server.host,
      port: server.sshPort,
      user: server.sshUser,
    });
    expect(input?.timeouts).toBe(fixture.deps.timeouts);
    expect(input?.redactor).toBe(fixture.deps.redactor);
    expect(input?.trustedFingerprint).toBeNull();
  });

  it('passes the pinned trustedFingerprint when one is already stored', async () => {
    fixture = await startServiceFixture();
    const server = await registerFixtureServer(fixture);
    const pinned = formatFingerprint(FP1);
    await patchServerRow(fixture, server.id, { hostFingerprint: pinned });
    const fakeSsh = buildFakeSshPort({
      ok: true,
      session: buildFakeSshSession({}),
      fingerprint: FP1,
      fingerprintCaptured: false,
      attempts: 1,
    });
    fixture.setSshPort(fakeSsh);

    const { connectAndDiscover } = await loadConnectAndDiscover();
    await connectAndDiscover(fixture.deps, {
      actor: SYSTEM,
      serverId: server.id,
      discover: () => Promise.resolve(buildSnapshot()),
    });

    const [input] = fakeSsh.calls;
    expect(input?.trustedFingerprint).toEqual(FP1);
  });

  it('lands CONNECTED with host_fingerprint/last_seen_at set on a fully successful run', async () => {
    fixture = await startServiceFixture();
    const server = await registerFixtureServer(fixture);
    fixture.setSshPort(
      buildFakeSshPort({
        ok: true,
        session: buildFakeSshSession({}),
        fingerprint: FP1,
        fingerprintCaptured: true,
        attempts: 1,
      }),
    );

    const { connectAndDiscover } = await loadConnectAndDiscover();
    const result = await connectAndDiscover(fixture.deps, {
      actor: SYSTEM,
      serverId: server.id,
      discover: () => Promise.resolve(buildSnapshot()),
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.server.status).toBe('CONNECTED');
    expect(result.server.hostFingerprint).toBe(formatFingerprint(FP1));
    expect(result.server.hostFingerprintCapturedAt).toEqual(FIXED_NOW);
    expect(result.server.lastSeenAt).toEqual(FIXED_NOW);
    expect(result.server.lastErrorCode).toBeNull();
  });

  it('leaves host_fingerprint_captured_at unchanged on a repeat connect with fingerprintCaptured false', async () => {
    fixture = await startServiceFixture();
    const server = await registerFixtureServer(fixture);
    fixture.setSshPort(
      buildFakeSshPort({
        ok: true,
        session: buildFakeSshSession({}),
        fingerprint: FP1,
        fingerprintCaptured: true,
        attempts: 1,
      }),
    );
    const { connectAndDiscover } = await loadConnectAndDiscover();
    const first = await connectAndDiscover(fixture.deps, {
      actor: SYSTEM,
      serverId: server.id,
      discover: () => Promise.resolve(buildSnapshot()),
    });
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    const capturedAt = first.server.hostFingerprintCapturedAt;

    fixture.setSshPort(
      buildFakeSshPort({
        ok: true,
        session: buildFakeSshSession({}),
        fingerprint: FP1,
        fingerprintCaptured: false,
        attempts: 1,
      }),
    );
    const second = await connectAndDiscover(fixture.deps, {
      actor: SYSTEM,
      serverId: server.id,
      discover: () => Promise.resolve(buildSnapshot()),
    });
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    expect(second.server.hostFingerprintCapturedAt).toEqual(capturedAt);
  });

  it('AUTH_FAILED connect failure is a successful service call landing on ERROR (SERV-07)', async () => {
    fixture = await startServiceFixture();
    const server = await registerFixtureServer(fixture);
    fixture.setSshPort(
      buildFakeSshPort({
        ok: false,
        errorCode: 'AUTH_FAILED',
        message: 'bad credentials',
        attempts: 1,
      }),
    );

    const { connectAndDiscover } = await loadConnectAndDiscover();
    const result = await connectAndDiscover(fixture.deps, { actor: SYSTEM, serverId: server.id });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.connection.ok).toBe(false);
    expect(result.connection.errorCode).toBe('AUTH_FAILED');
    expect(result.server.status).toBe('ERROR');
    expect(result.server.lastErrorCode).toBe('AUTH_FAILED');

    const snapshots = await snapshotsFor(fixture, server.id);
    expect(snapshots).toHaveLength(0);
  });

  it('CONNECT_TIMEOUT connect failure lands on UNREACHABLE', async () => {
    fixture = await startServiceFixture();
    const server = await registerFixtureServer(fixture);
    fixture.setSshPort(
      buildFakeSshPort({
        ok: false,
        errorCode: 'CONNECT_TIMEOUT',
        message: 'timed out',
        attempts: 2,
      }),
    );

    const { connectAndDiscover } = await loadConnectAndDiscover();
    const result = await connectAndDiscover(fixture.deps, { actor: SYSTEM, serverId: server.id });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.server.status).toBe('UNREACHABLE');
    expect(result.server.lastErrorCode).toBe('CONNECT_TIMEOUT');
  });

  it('HOST_KEY_CHANGED parks the observed fingerprint without touching host_fingerprint', async () => {
    fixture = await startServiceFixture();
    const server = await registerFixtureServer(fixture);
    const pinned = formatFingerprint(FP1);
    await patchServerRow(fixture, server.id, { hostFingerprint: pinned });
    fixture.setSshPort(
      buildFakeSshPort({
        ok: false,
        errorCode: 'HOST_KEY_CHANGED',
        message: 'host key changed',
        attempts: 1,
        observedFingerprint: FP2,
      }),
    );

    const { connectAndDiscover } = await loadConnectAndDiscover();
    const result = await connectAndDiscover(fixture.deps, { actor: SYSTEM, serverId: server.id });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.server.status).toBe('ERROR');
    expect(result.server.pendingFingerprint).toBe(formatFingerprint(FP2));
    expect(result.server.pendingFingerprintSeenAt).toEqual(FIXED_NOW);
    expect(result.server.hostFingerprint).toBe(pinned);
  });

  it('writes exactly one server.connection_attempted event on success with D-16 metadata', async () => {
    fixture = await startServiceFixture();
    const server = await registerFixtureServer(fixture);
    fixture.setSshPort(
      buildFakeSshPort({
        ok: true,
        session: buildFakeSshSession({}),
        fingerprint: FP1,
        fingerprintCaptured: true,
        attempts: 1,
      }),
    );

    const { connectAndDiscover } = await loadConnectAndDiscover();
    await connectAndDiscover(fixture.deps, {
      actor: SYSTEM,
      serverId: server.id,
      discover: () => Promise.resolve(buildSnapshot()),
    });

    const events = await connectionAttemptedEvents(fixture, server.id);
    expect(events).toHaveLength(1);
    const [event] = events;
    expect(event?.outcome).toBe('success');
    expect(event?.errorCode).toBeNull();
    expect(event?.metadata).toEqual({
      attempts: 1,
      durationMs: expect.any(Number),
      fingerprintCaptured: true,
    });
    expect((event?.metadata as { durationMs: number }).durationMs).toBeGreaterThanOrEqual(0);
    const json = JSON.stringify(event?.metadata);
    expect(json).not.toContain('"host"');
    expect(json).not.toContain('credential');
  });

  it('writes exactly one server.connection_attempted event on failure with errorCode set', async () => {
    fixture = await startServiceFixture();
    const server = await registerFixtureServer(fixture);
    fixture.setSshPort(
      buildFakeSshPort({
        ok: false,
        errorCode: 'AUTH_FAILED',
        message: 'bad credentials',
        attempts: 1,
      }),
    );

    const { connectAndDiscover } = await loadConnectAndDiscover();
    await connectAndDiscover(fixture.deps, { actor: SYSTEM, serverId: server.id });

    const events = await connectionAttemptedEvents(fixture, server.id);
    expect(events).toHaveLength(1);
    const [event] = events;
    expect(event?.outcome).toBe('failure');
    expect(event?.errorCode).toBe('AUTH_FAILED');
    expect(event?.metadata).toEqual({
      attempts: 1,
      durationMs: expect.any(Number),
      fingerprintCaptured: false,
    });
  });

  it('writes no server.discovery_completed event when the connect fails', async () => {
    fixture = await startServiceFixture();
    const server = await registerFixtureServer(fixture);
    fixture.setSshPort(
      buildFakeSshPort({
        ok: false,
        errorCode: 'AUTH_FAILED',
        message: 'bad credentials',
        attempts: 1,
      }),
    );

    const { connectAndDiscover } = await loadConnectAndDiscover();
    await connectAndDiscover(fixture.deps, { actor: SYSTEM, serverId: server.id });

    const events = await discoveryCompletedEvents(fixture, server.id);
    expect(events).toHaveLength(0);
  });

  it('closes the session exactly once on a successful run', async () => {
    fixture = await startServiceFixture();
    const server = await registerFixtureServer(fixture);
    const session = buildFakeSshSession({});
    fixture.setSshPort(
      buildFakeSshPort({
        ok: true,
        session,
        fingerprint: FP1,
        fingerprintCaptured: true,
        attempts: 1,
      }),
    );

    const { connectAndDiscover } = await loadConnectAndDiscover();
    await connectAndDiscover(fixture.deps, {
      actor: SYSTEM,
      serverId: server.id,
      discover: () => Promise.resolve(buildSnapshot()),
    });

    expect(session.closeCallCount).toBe(1);
  });

  it('closes the session exactly once even when discovery rejects (the finally contract)', async () => {
    fixture = await startServiceFixture();
    const server = await registerFixtureServer(fixture);
    const session = buildFakeSshSession({});
    fixture.setSshPort(
      buildFakeSshPort({
        ok: true,
        session,
        fingerprint: FP1,
        fingerprintCaptured: true,
        attempts: 1,
      }),
    );

    const { connectAndDiscover } = await loadConnectAndDiscover();
    await connectAndDiscover(fixture.deps, {
      actor: SYSTEM,
      serverId: server.id,
      discover: () => Promise.reject(new Error('discovery blew up')),
    }).catch(() => undefined);

    expect(session.closeCallCount).toBe(1);
  });
});

describe('discovery phase (DISC-03, D-02, D-06, D-07)', () => {
  it('inserts exactly one discovery_snapshots row with outcome ok and the verbatim payload', async () => {
    fixture = await startServiceFixture();
    const server = await registerFixtureServer(fixture);
    fixture.setSshPort(
      buildFakeSshPort({
        ok: true,
        session: buildFakeSshSession({}),
        fingerprint: FP1,
        fingerprintCaptured: true,
        attempts: 1,
      }),
    );
    const snapshot = buildSnapshot({
      facts: buildFacts({ hostname: 'srv1', cpuCores: 4 }),
      checks: [buildCheck('hostname', 'pass'), buildCheck('cpu', 'pass')],
    });

    const { connectAndDiscover } = await loadConnectAndDiscover();
    const result = await connectAndDiscover(fixture.deps, {
      actor: SYSTEM,
      serverId: server.id,
      discover: () => Promise.resolve(snapshot),
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const rows = await snapshotsFor(fixture, server.id);
    expect(rows).toHaveLength(1);
    const [row] = rows;
    expect(row?.serverId).toBe(server.id);
    expect(row?.outcome).toBe('ok');
    expect(row?.errorCode).toBeNull();
    expect(row?.payload).toEqual(snapshot);
  });

  it('denormalizes every discovery fact onto servers, including dockerComposeVersion', async () => {
    fixture = await startServiceFixture();
    const server = await registerFixtureServer(fixture);
    fixture.setSshPort(
      buildFakeSshPort({
        ok: true,
        session: buildFakeSshSession({}),
        fingerprint: FP1,
        fingerprintCaptured: true,
        attempts: 1,
      }),
    );
    const facts = buildFacts({
      hostname: 'h',
      osDistribution: 'Ubuntu',
      osVersion: '24.04',
      arch: 'x86_64',
      cpuCores: 4,
      ramMb: 8192,
      diskTotalMb: 100000,
      diskUsedMb: 20000,
      uptimeSeconds: 1000,
      dockerInstalled: true,
      dockerVersion: '27.0.0',
      dockerComposeVersion: '2.29.0',
    });
    const snapshot = buildSnapshot({ facts, checks: [buildCheck('hostname', 'pass')] });

    const { connectAndDiscover } = await loadConnectAndDiscover();
    const result = await connectAndDiscover(fixture.deps, {
      actor: SYSTEM,
      serverId: server.id,
      discover: () => Promise.resolve(snapshot),
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.server.hostname).toBe('h');
    expect(result.server.osDistribution).toBe('Ubuntu');
    expect(result.server.osVersion).toBe('24.04');
    expect(result.server.arch).toBe('x86_64');
    expect(result.server.cpuCores).toBe(4);
    expect(result.server.ramMb).toBe(8192);
    expect(result.server.diskTotalMb).toBe(100000);
    expect(result.server.diskUsedMb).toBe(20000);
    expect(result.server.uptimeSeconds).toBe(1000);
    expect(result.server.dockerInstalled).toBe(true);
    expect(result.server.dockerVersion).toBe('27.0.0');
    expect(result.server.dockerComposeVersion).toBe('2.29.0');
  });

  it('D-07: preserves previously known facts when a later run reports them null', async () => {
    fixture = await startServiceFixture();
    const server = await registerFixtureServer(fixture);
    fixture.setSshPort(
      buildFakeSshPort({
        ok: true,
        session: buildFakeSshSession({}),
        fingerprint: FP1,
        fingerprintCaptured: true,
        attempts: 1,
      }),
    );
    const { connectAndDiscover } = await loadConnectAndDiscover();
    const firstSnapshot = buildSnapshot({
      facts: buildFacts({ hostname: 'h1', cpuCores: 4 }),
      checks: [buildCheck('hostname', 'pass'), buildCheck('cpu', 'pass')],
    });
    const first = await connectAndDiscover(fixture.deps, {
      actor: SYSTEM,
      serverId: server.id,
      discover: () => Promise.resolve(firstSnapshot),
    });
    expect(first.ok).toBe(true);

    fixture.setSshPort(
      buildFakeSshPort({
        ok: true,
        session: buildFakeSshSession({}),
        fingerprint: FP1,
        fingerprintCaptured: false,
        attempts: 1,
      }),
    );
    const secondSnapshot = buildSnapshot({
      facts: buildFacts({ hostname: null, cpuCores: 8 }),
      checks: [buildCheck('hostname', 'skipped'), buildCheck('cpu', 'pass')],
    });
    const second = await connectAndDiscover(fixture.deps, {
      actor: SYSTEM,
      serverId: server.id,
      discover: () => Promise.resolve(secondSnapshot),
    });

    expect(second.ok).toBe(true);
    if (!second.ok) return;
    expect(second.server.hostname).toBe('h1');
    expect(second.server.cpuCores).toBe(8);
  });

  it('a mixed-result discovery persists outcome partial and still denormalizes the facts it got (D-07)', async () => {
    fixture = await startServiceFixture();
    const server = await registerFixtureServer(fixture);
    fixture.setSshPort(
      buildFakeSshPort({
        ok: true,
        session: buildFakeSshSession({}),
        fingerprint: FP1,
        fingerprintCaptured: true,
        attempts: 1,
      }),
    );
    const snapshot = buildSnapshot({
      facts: buildFacts({ hostname: 'h1' }),
      checks: [buildCheck('hostname', 'pass'), buildCheck('cpu', 'fail')],
    });

    const { connectAndDiscover } = await loadConnectAndDiscover();
    const result = await connectAndDiscover(fixture.deps, {
      actor: SYSTEM,
      serverId: server.id,
      discover: () => Promise.resolve(snapshot),
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.discovery?.outcome).toBe('partial');
    expect(result.server.hostname).toBe('h1');
    const [row] = await snapshotsFor(fixture, server.id);
    expect(row?.outcome).toBe('partial');
  });

  it('COMMAND_TIMEOUT warning lands CONNECTED -> ERROR and still writes the snapshot (D-02)', async () => {
    fixture = await startServiceFixture();
    const server = await registerFixtureServer(fixture);
    fixture.setSshPort(
      buildFakeSshPort({
        ok: true,
        session: buildFakeSshSession({}),
        fingerprint: FP1,
        fingerprintCaptured: true,
        attempts: 1,
      }),
    );
    const snapshot = buildSnapshot({
      warnings: ['COMMAND_TIMEOUT'],
      checks: [buildCheck('hostname', 'pass'), buildCheck('cpu', 'fail')],
    });

    const { connectAndDiscover } = await loadConnectAndDiscover();
    const result = await connectAndDiscover(fixture.deps, {
      actor: SYSTEM,
      serverId: server.id,
      discover: () => Promise.resolve(snapshot),
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.server.status).toBe('ERROR');
    expect(result.server.lastErrorCode).toBe('COMMAND_TIMEOUT');
    const rows = await snapshotsFor(fixture, server.id);
    expect(rows).toHaveLength(1);
  });

  it('an all-checks-failed discovery lands CONNECTED -> UNREACHABLE with outcome failed (D-02)', async () => {
    fixture = await startServiceFixture();
    const server = await registerFixtureServer(fixture);
    fixture.setSshPort(
      buildFakeSshPort({
        ok: true,
        session: buildFakeSshSession({}),
        fingerprint: FP1,
        fingerprintCaptured: true,
        attempts: 1,
      }),
    );
    const snapshot = buildSnapshot({
      warnings: [],
      checks: [buildCheck('hostname', 'fail'), buildCheck('cpu', 'fail')],
    });

    const { connectAndDiscover } = await loadConnectAndDiscover();
    const result = await connectAndDiscover(fixture.deps, {
      actor: SYSTEM,
      serverId: server.id,
      discover: () => Promise.resolve(snapshot),
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.server.status).toBe('UNREACHABLE');
    expect(result.server.lastErrorCode).toBe('CONNECTION_LOST');
    expect(result.discovery?.outcome).toBe('failed');
  });

  it('an UNSUPPORTED_OS-only warning stays CONNECTED with last_error_code UNSUPPORTED_OS', async () => {
    fixture = await startServiceFixture();
    const server = await registerFixtureServer(fixture);
    fixture.setSshPort(
      buildFakeSshPort({
        ok: true,
        session: buildFakeSshSession({}),
        fingerprint: FP1,
        fingerprintCaptured: true,
        attempts: 1,
      }),
    );
    const snapshot = buildSnapshot({
      warnings: ['UNSUPPORTED_OS'],
      checks: [buildCheck('hostname', 'pass')],
    });

    const { connectAndDiscover } = await loadConnectAndDiscover();
    const result = await connectAndDiscover(fixture.deps, {
      actor: SYSTEM,
      serverId: server.id,
      discover: () => Promise.resolve(snapshot),
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.server.status).toBe('CONNECTED');
    expect(result.server.lastErrorCode).toBe('UNSUPPORTED_OS');
    expect(result.discovery?.outcome).toBe('ok');
  });

  it('a fully successful run never lands on DISCONNECTED (D-03)', async () => {
    fixture = await startServiceFixture();
    const server = await registerFixtureServer(fixture);
    fixture.setSshPort(
      buildFakeSshPort({
        ok: true,
        session: buildFakeSshSession({}),
        fingerprint: FP1,
        fingerprintCaptured: true,
        attempts: 1,
      }),
    );

    const { connectAndDiscover } = await loadConnectAndDiscover();
    const result = await connectAndDiscover(fixture.deps, {
      actor: SYSTEM,
      serverId: server.id,
      discover: () => Promise.resolve(buildSnapshot()),
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.server.status).toBe('CONNECTED');
    expect(result.server.status).not.toBe('DISCONNECTED');
  });

  it('writes exactly one server.discovery_completed event with D-16 metadata', async () => {
    fixture = await startServiceFixture();
    const server = await registerFixtureServer(fixture);
    fixture.setSshPort(
      buildFakeSshPort({
        ok: true,
        session: buildFakeSshSession({}),
        fingerprint: FP1,
        fingerprintCaptured: true,
        attempts: 1,
      }),
    );
    const snapshot = buildSnapshot({
      checks: [buildCheck('hostname', 'pass'), buildCheck('cpu', 'fail')],
      warnings: [],
    });

    const { connectAndDiscover } = await loadConnectAndDiscover();
    const result = await connectAndDiscover(fixture.deps, {
      actor: SYSTEM,
      serverId: server.id,
      discover: () => Promise.resolve(snapshot),
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const events = await discoveryCompletedEvents(fixture, server.id);
    expect(events).toHaveLength(1);
    const [event] = events;
    const [row] = await snapshotsFor(fixture, server.id);
    expect(event?.metadata).toEqual({
      snapshotId: row?.id,
      warnings: [],
      checksFailed: ['cpu'],
    });
  });

  it('is atomic across the connection result, the snapshot and both events', async () => {
    fixture = await startServiceFixture();
    const server = await registerFixtureServer(fixture);
    fixture.setSshPort(
      buildFakeSshPort({
        ok: true,
        session: buildFakeSshSession({}),
        fingerprint: FP1,
        fingerprintCaptured: true,
        attempts: 1,
      }),
    );
    // A fake discover whose warnings array smuggles a forbidden-key object, so the metadata the
    // real service builds for `server.discovery_completed` (`{ warnings, ... }`) fails
    // `buildActivityEvent`'s SensitiveMetadataError guard partway through TX2 — proving the
    // connection result, the snapshot insert and the denormalization all roll back together.
    const poisonedSnapshot = {
      ...buildSnapshot({ checks: [buildCheck('hostname', 'pass')] }),
      warnings: [{ password: 'leaked' }] as unknown as readonly ServerErrorCode[],
    };

    const { connectAndDiscover } = await loadConnectAndDiscover();
    await expect(
      connectAndDiscover(fixture.deps, {
        actor: SYSTEM,
        serverId: server.id,
        discover: () => Promise.resolve(poisonedSnapshot),
      }),
    ).rejects.toThrow();

    const rows = await snapshotsFor(fixture, server.id);
    expect(rows).toHaveLength(0);
    const row = await serverRow(fixture, server.id);
    // TX1 (the CONNECTING transition) already committed on its own before SSH work began; TX2's
    // attempted CONNECTED transition, snapshot and both events must not have survived on top of it.
    expect(row?.status).toBe('CONNECTING');
    expect(row?.hostFingerprint).toBeNull();
    const events = await eventsFor(fixture, server.id);
    expect(events).toHaveLength(0);
  });

  it('attributes both events to a user actor (D-17)', async () => {
    fixture = await startServiceFixture();
    const server = await registerFixtureServer(fixture);
    const userId = randomUUID();
    fixture.setSshPort(
      buildFakeSshPort({
        ok: true,
        session: buildFakeSshSession({}),
        fingerprint: FP1,
        fingerprintCaptured: true,
        attempts: 1,
      }),
    );

    const { connectAndDiscover } = await loadConnectAndDiscover();
    await connectAndDiscover(fixture.deps, {
      actor: { type: 'user', id: userId },
      serverId: server.id,
      discover: () => Promise.resolve(buildSnapshot()),
    });

    const events = await eventsFor(fixture, server.id);
    expect(events.length).toBeGreaterThanOrEqual(2);
    for (const event of events) {
      expect(event.actorType).toBe('user');
      expect(event.actorId).toBe(userId);
    }
  });

  it('attributes both events to the system actor with a null actorId (D-17)', async () => {
    fixture = await startServiceFixture();
    const server = await registerFixtureServer(fixture);
    fixture.setSshPort(
      buildFakeSshPort({
        ok: true,
        session: buildFakeSshSession({}),
        fingerprint: FP1,
        fingerprintCaptured: true,
        attempts: 1,
      }),
    );

    const { connectAndDiscover } = await loadConnectAndDiscover();
    await connectAndDiscover(fixture.deps, {
      actor: SYSTEM,
      serverId: server.id,
      discover: () => Promise.resolve(buildSnapshot()),
    });

    const events = await eventsFor(fixture, server.id);
    expect(events.length).toBeGreaterThanOrEqual(2);
    for (const event of events) {
      expect(event.actorType).toBe('system');
      expect(event.actorId).toBeNull();
    }
  });

  it('never leaks credential material in the result or the persisted snapshot', async () => {
    fixture = await startServiceFixture();
    const password = freshPassword();
    const server = await registerFixtureServer(fixture, { password });
    fixture.setSshPort(
      buildFakeSshPort({
        ok: true,
        session: buildFakeSshSession({}),
        fingerprint: FP1,
        fingerprintCaptured: true,
        attempts: 1,
      }),
    );

    const { connectAndDiscover } = await loadConnectAndDiscover();
    const result = await connectAndDiscover(fixture.deps, {
      actor: SYSTEM,
      serverId: server.id,
      discover: () => Promise.resolve(buildSnapshot()),
    });

    expect(JSON.stringify(result)).not.toContain(password);
    const [row] = await snapshotsFor(fixture, server.id);
    expect(JSON.stringify(row?.payload)).not.toContain(password);
  });
});
