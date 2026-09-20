// D-04/T-4-05/T-4-17/T-4-18/T-4-19: the four post-commit publication sites from Task 2
// (registerServer/editServer/deleteServer/trustFingerprint publish exactly once each) plus
// connectAndDiscover's two-publish case (Task 3): TX1's CONNECTING, then TX2's outcome.
//
// `connectAndDiscover`'s ordering proof (D-04's "CONNECTING is visible the instant the worker
// picks up the job") is the one behaviour that cannot be asserted after the fact: the fake
// `SshPort.connect` reads `fixture.events.length` *at call time*, before this suite's own
// assertions ever run, which is the only way to prove the first publish happened strictly before
// the SSH phase started.
import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { afterEach, describe, expect, it } from 'vitest';
import { formatFingerprint, type HostFingerprint } from '@noodara/ssh';
import type { DiscoveryCheck, DiscoveryFacts, DiscoverySnapshot } from '@noodara/domain/discovery';
import { SERVER_VIEW_KEYS } from '../../../apps/control-plane/src/services/server-view.js';
import { assertNoStrayTestContainers } from '../helpers/ssh.js';
import {
  buildFakeSshPort,
  buildFakeSshSession,
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

function buildCheck(): DiscoveryCheck {
  return { id: 'hostname', status: 'pass', detail: 'hostname: pass', durationMs: 5 };
}

function buildSnapshot(): DiscoverySnapshot {
  return { facts: buildFacts(), checks: [buildCheck()], warnings: [] };
}

/** Every module under test is loaded via `await import(...)` on every call, never a static
 *  top-level import — see register-server.test.ts's own file-header note for why (env.ts's
 *  INST-06 fail-fast import-time side effect). */
async function loadRegisterServer() {
  return import('../../../apps/control-plane/src/services/register-server.js');
}
async function loadEditServer() {
  return import('../../../apps/control-plane/src/services/edit-server.js');
}
async function loadDeleteServer() {
  return import('../../../apps/control-plane/src/services/delete-server.js');
}
async function loadTrustFingerprint() {
  return import('../../../apps/control-plane/src/services/trust-fingerprint.js');
}
async function loadConnectAndDiscover() {
  return import('../../../apps/control-plane/src/services/connect-and-discover.js');
}

async function registerFixtureServer(fx: ServiceFixture, name?: string, host?: string) {
  const { registerServer } = await loadRegisterServer();
  const result = await registerServer(fx.deps, {
    actor: SYSTEM,
    name: name ?? uniqueName(),
    host: host ?? uniqueHost(),
    credential: { kind: 'password', password: freshPassword() },
  });
  if (!result.ok) {
    throw new Error(`registerFixtureServer arrangement failed: ${result.code} ${result.message}`);
  }
  return result.server;
}

/**
 * Arranges a real ERROR row with a real pending_fingerprint (mirrors
 * trust-fingerprint.test.ts's own arrangement): connects once successfully (pinning
 * host_fingerprint to FP1), then again with a scripted HOST_KEY_CHANGED outcome (FP2) — never a
 * direct column write.
 */
async function arrangeServerWithPendingFingerprint(
  fx: ServiceFixture,
): Promise<{ readonly serverId: string; readonly fingerprint: string }> {
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
  if (!second.ok || second.server.status !== 'ERROR' || second.server.pendingFingerprint === null) {
    throw new Error('arrangeServerWithPendingFingerprint: arrangement did not land as expected');
  }

  // Drain the two events this arrangement's own connects published, so the test that calls this
  // helper starts from a clean events array.
  fixture!.events.length = 0;

  return { serverId: server.id, fingerprint: second.server.pendingFingerprint };
}

describe('registerServer publication (D-04)', () => {
  it('publishes exactly one server.updated deep-equal to the returned server', async () => {
    fixture = await startServiceFixture();

    const server = await registerFixtureServer(fixture);

    expect(fixture.events).toHaveLength(1);
    expect(fixture.events[0]).toEqual({ type: 'server.updated', server });
  });

  it('publishes nothing on a NAME_TAKEN failure', async () => {
    fixture = await startServiceFixture();
    const name = uniqueName();
    await registerFixtureServer(fixture, name);
    fixture.events.length = 0;

    const { registerServer } = await loadRegisterServer();
    const second = await registerServer(fixture.deps, {
      actor: SYSTEM,
      name,
      host: uniqueHost(),
      credential: { kind: 'password', password: freshPassword() },
    });

    expect(second).toMatchObject({ ok: false, code: 'NAME_TAKEN' });
    expect(fixture.events).toHaveLength(0);
  });

  it('a rolled-back transaction never publishes: a genuine unique-violation race yields exactly one event for two concurrent calls', async () => {
    fixture = await startServiceFixture();
    const name = uniqueName();

    const { registerServer } = await loadRegisterServer();
    const [first, second] = await Promise.all([
      registerServer(fixture.deps, {
        actor: SYSTEM,
        name,
        host: uniqueHost(),
        credential: { kind: 'password', password: freshPassword() },
      }),
      registerServer(fixture.deps, {
        actor: SYSTEM,
        name,
        host: uniqueHost(),
        credential: { kind: 'password', password: freshPassword() },
      }),
    ]);

    const outcomes = [first, second];
    const succeeded = outcomes.filter((r) => r.ok);
    const failed = outcomes.filter((r) => !r.ok);
    expect(succeeded).toHaveLength(1);
    expect(failed).toHaveLength(1);
    expect(failed[0]).toMatchObject({ code: 'NAME_TAKEN' });
    // Only the winner's transaction committed; the loser's transaction rolled back and never
    // reached its publish call (T-4-17).
    expect(fixture.events).toHaveLength(1);
  });

  it('still returns ok: true and commits the row when the injected publisher rejects (D-04)', async () => {
    fixture = await startServiceFixture();
    fixture.setEventPublisher({ publish: () => Promise.reject(new Error('publish boom')) });

    const result = await registerFixtureServer(fixture);

    expect(result).toBeDefined();
  });
});

describe('editServer publication (D-04)', () => {
  it('publishes exactly one server.updated reflecting the committed change', async () => {
    fixture = await startServiceFixture();
    const server = await registerFixtureServer(fixture);
    fixture.events.length = 0;
    const newName = uniqueName();
    const newHost = uniqueHost();

    const { editServer } = await loadEditServer();
    const result = await editServer(fixture.deps, {
      actor: SYSTEM,
      serverId: server.id,
      name: newName,
      host: newHost,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(fixture.events).toHaveLength(1);
    expect(fixture.events[0]).toEqual({ type: 'server.updated', server: result.server });
    expect(result.server.name).toBe(newName);
    expect(result.server.host).toBe(newHost);
  });

  it('publishes nothing on a NOT_FOUND failure', async () => {
    fixture = await startServiceFixture();

    const { editServer } = await loadEditServer();
    const result = await editServer(fixture.deps, {
      actor: SYSTEM,
      serverId: randomUUID(),
      name: uniqueName(),
    });

    expect(result).toMatchObject({ ok: false, code: 'NOT_FOUND' });
    expect(fixture.events).toHaveLength(0);
  });
});

describe('deleteServer publication (D-04)', () => {
  it('publishes exactly one server.deleted with { id } and no server field', async () => {
    fixture = await startServiceFixture();
    const server = await registerFixtureServer(fixture);
    fixture.events.length = 0;

    const { deleteServer } = await loadDeleteServer();
    const result = await deleteServer(fixture.deps, {
      actor: SYSTEM,
      serverId: server.id,
      confirmName: server.name,
    });

    expect(result).toMatchObject({ ok: true, serverId: server.id });
    expect(fixture.events).toHaveLength(1);
    expect(fixture.events[0]).toEqual({ type: 'server.deleted', id: server.id });
    expect(fixture.events[0]).not.toHaveProperty('server');
  });

  it('publishes nothing on a CONFIRMATION_MISMATCH failure', async () => {
    fixture = await startServiceFixture();
    const server = await registerFixtureServer(fixture);
    fixture.events.length = 0;

    const { deleteServer } = await loadDeleteServer();
    const result = await deleteServer(fixture.deps, {
      actor: SYSTEM,
      serverId: server.id,
      confirmName: `not-${server.name}`,
    });

    expect(result).toMatchObject({ ok: false, code: 'CONFIRMATION_MISMATCH' });
    expect(fixture.events).toHaveLength(0);
  });
});

describe('trustFingerprint publication (D-04)', () => {
  it('publishes exactly one server.updated with the newly trusted fingerprint and a null pendingFingerprint', async () => {
    fixture = await startServiceFixture();
    const { serverId, fingerprint } = await arrangeServerWithPendingFingerprint(fixture);

    const { trustFingerprint } = await loadTrustFingerprint();
    const result = await trustFingerprint(fixture.deps, { actor: SYSTEM, serverId, fingerprint });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(fixture.events).toHaveLength(1);
    expect(fixture.events[0]).toEqual({ type: 'server.updated', server: result.server });
    expect(result.server.hostFingerprint).toBe(formatFingerprint(FP2));
    expect(result.server.pendingFingerprint).toBeNull();
  });

  it('publishes nothing on a NO_PENDING_FINGERPRINT failure', async () => {
    fixture = await startServiceFixture();
    const server = await registerFixtureServer(fixture);
    fixture.events.length = 0;

    const { trustFingerprint } = await loadTrustFingerprint();
    // NO_PENDING_FINGERPRINT is returned before any fingerprint comparison — value is irrelevant.
    const result = await trustFingerprint(fixture.deps, {
      actor: SYSTEM,
      serverId: server.id,
      fingerprint: 'unused',
    });

    expect(result).toMatchObject({ ok: false, code: 'NO_PENDING_FINGERPRINT' });
    expect(fixture.events).toHaveLength(0);
  });
});

describe('connectAndDiscover publication (D-04)', () => {
  it('publishes exactly two server.updated events for a successful connect + discovery', async () => {
    fixture = await startServiceFixture();
    const server = await registerFixtureServer(fixture);
    fixture.events.length = 0;

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
    expect(fixture.events).toHaveLength(2);
    expect(fixture.events[0]).toMatchObject({ type: 'server.updated' });
    expect(fixture.events[1]).toMatchObject({ type: 'server.updated' });

    const first = fixture.events[0] as { type: 'server.updated'; server: { status: string } };
    expect(first.server.status).toBe('CONNECTING');

    const second = fixture.events[1] as { type: 'server.updated'; server: unknown };
    expect(second.server).toEqual(result.server);
    expect((second.server as { status: string }).status).toBe('CONNECTED');
  });

  it('publishes the CONNECTING event before the SSH phase begins', async () => {
    fixture = await startServiceFixture();
    const server = await registerFixtureServer(fixture);
    fixture.events.length = 0;
    const fx = fixture;

    let eventCountAtConnectTime = -1;
    // A hand-written SshPort (not buildFakeSshPort) so `connect` can read `fx.events.length` at
    // the exact moment the SSH phase would start, before resolving — this is the only way to
    // prove the CONNECTING publish happened strictly before the SSH work, not just before this
    // test's own assertions run.
    fx.setSshPort({
      connect: () => {
        eventCountAtConnectTime = fx.events.length;
        return Promise.resolve({
          ok: true as const,
          session: buildFakeSshSession({}),
          fingerprint: FP1,
          fingerprintCaptured: true,
          attempts: 1,
        });
      },
    });

    const { connectAndDiscover } = await loadConnectAndDiscover();
    const result = await connectAndDiscover(fixture.deps, {
      actor: SYSTEM,
      serverId: server.id,
      discover: () => Promise.resolve(buildSnapshot()),
    });

    expect(result.ok).toBe(true);
    expect(eventCountAtConnectTime).toBe(1);
    const firstEvent = fixture.events[0] as { type: 'server.updated'; server: { status: string } };
    expect(firstEvent.server.status).toBe('CONNECTING');
  });

  it('publishes two events with the failure status/lastErrorCode when SSH connect fails', async () => {
    fixture = await startServiceFixture();
    const server = await registerFixtureServer(fixture);
    fixture.events.length = 0;

    fixture.setSshPort(
      buildFakeSshPort({
        ok: false,
        errorCode: 'AUTH_FAILED',
        message: 'bad credential',
        attempts: 1,
      }),
    );

    const { connectAndDiscover } = await loadConnectAndDiscover();
    const result = await connectAndDiscover(fixture.deps, { actor: SYSTEM, serverId: server.id });

    expect(result.ok).toBe(true);
    expect(fixture.events).toHaveLength(2);
    const second = fixture.events[1] as {
      type: 'server.updated';
      server: { status: string; lastErrorCode: string | null };
    };
    expect(second.server.status).toBe('ERROR');
    expect(second.server.lastErrorCode).toBe('AUTH_FAILED');
  });

  it('publishes nothing for ALREADY_CONNECTING', async () => {
    fixture = await startServiceFixture();
    const server = await registerFixtureServer(fixture);
    // Deterministic arrangement (mirrors trust-fingerprint.test.ts's own SERVER_BUSY case): a
    // direct row patch to CONNECTING, since a genuine CONNECTING row is a transient in-flight
    // state no service call can be made to pause on.
    await fixture.db.execute(
      sql`update servers set status = 'CONNECTING'::server_status where id = ${server.id}`,
    );
    fixture.events.length = 0;

    const { connectAndDiscover } = await loadConnectAndDiscover();
    const result = await connectAndDiscover(fixture.deps, { actor: SYSTEM, serverId: server.id });

    expect(result).toMatchObject({ ok: false, code: 'ALREADY_CONNECTING' });
    expect(fixture.events).toHaveLength(0);
  });

  it('publishes nothing for NOT_FOUND', async () => {
    fixture = await startServiceFixture();

    const { connectAndDiscover } = await loadConnectAndDiscover();
    const result = await connectAndDiscover(fixture.deps, {
      actor: SYSTEM,
      serverId: randomUUID(),
    });

    expect(result).toMatchObject({ ok: false, code: 'NOT_FOUND' });
    expect(fixture.events).toHaveLength(0);
  });

  it('both published events carry exactly the 27 SERVER_VIEW_KEYS', async () => {
    fixture = await startServiceFixture();
    const server = await registerFixtureServer(fixture);
    fixture.events.length = 0;

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
    expect(fixture.events).toHaveLength(2);
    for (const event of fixture.events) {
      expect(event.type).toBe('server.updated');
      const server = (event as { server: object }).server;
      expect(Object.keys(server).sort()).toEqual([...SERVER_VIEW_KEYS].sort());
    }
  });
});
