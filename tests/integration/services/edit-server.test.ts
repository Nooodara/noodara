// SERV-02/ACT-01/D-11/D-13/D-14/D-16: RED for `editServer`. Every expectation below fails today
// for the same reason — `apps/control-plane/src/services/edit-server.ts` does not exist yet —
// mirroring register-server.test.ts's own dynamic-import discipline: `editServer` is loaded via
// `await import(...)` on every call (never a static top-level import), since it transitively
// imports `apps/control-plane/src/activity/redaction.ts`, which reads `env.NOODARA_MASTER_KEY` at
// import time (INST-06) and would otherwise crash the whole worker process if imported before
// `startServiceFixture()` has written a valid test env.
import { generateKeyPairSync, randomBytes, randomUUID } from 'node:crypto';
import { and, eq, sql } from 'drizzle-orm';
import { afterEach, describe, expect, it } from 'vitest';
import type { ConnectInput, ConnectOutcome, HostFingerprint } from '@noodara/ssh';
import type {
  DiscoveryCheck,
  DiscoveryCheckId,
  DiscoveryFacts,
  DiscoverySnapshot,
} from '@noodara/domain/discovery';
import {
  activityEvents,
  credentials,
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

function buildRsaPem(modulusLength: number): string {
  const { privateKey } = generateKeyPairSync('rsa', {
    modulusLength,
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs1', format: 'pem' },
  });
  return privateKey;
}

/** Real, per-run RSA key material — never a committed literal (matches register-server.test.ts). */
const VALID_PRIVATE_KEY = buildRsaPem(2048);
const TOO_SMALL_PRIVATE_KEY = buildRsaPem(1024);

function freshPassword(): string {
  return randomBytes(24).toString('base64url');
}

function uniqueName(): string {
  return `srv-${randomUUID().replace(/-/g, '').slice(0, 16)}`;
}

function uniqueHost(): string {
  return `${randomUUID().replace(/-/g, '').slice(0, 12)}.example.test`;
}

type FixtureCredential =
  | { readonly kind: 'password'; readonly password: string }
  | {
      readonly kind: 'private_key';
      readonly privateKey: string;
      readonly passphrase?: string;
    };

type FixtureActor = { readonly type: 'user'; readonly id: string } | { readonly type: 'system' };

interface RegisterFixtureServerOverrides {
  readonly name?: string;
  readonly host?: string;
  readonly sshPort?: number;
  readonly sshUser?: string;
  readonly credential?: FixtureCredential;
  readonly actor?: FixtureActor;
}

/** Loaded dynamically on every call — see the file-header note. */
async function loadRegisterServer() {
  return import('../../../apps/control-plane/src/services/register-server.js');
}

/** Loaded dynamically on every call — the module under RED test does not exist yet. */
async function loadEditServer() {
  return import('../../../apps/control-plane/src/services/edit-server.js');
}

/** Loaded dynamically on every call — mirrors this file's own `loadEditServer` discipline
 *  (avoids importing `activity/redaction.ts`, which reads `env.NOODARA_MASTER_KEY` at import
 *  time, before `startServiceFixture()` has written a valid test env). */
async function loadTrustFingerprint() {
  return import('../../../apps/control-plane/src/services/trust-fingerprint.js');
}

/** Loaded dynamically on every call — same discipline as `loadEditServer`/`loadTrustFingerprint`.
 *  Task 2 (05-40-PLAN.md): the real-HTTP harness (`tests/integration/servers/
 *  edit-clears-pending-fingerprint.test.ts`) cannot script an SSH outcome — its `/connect` route
 *  enqueues through BullMQ — so the "next connect after a re-point" behaviour is proven here
 *  instead, driving `connectAndDiscover` directly against the service fixture's fake SSH port,
 *  exactly like `trust-fingerprint.test.ts`'s own `arrangeServerWithPendingFingerprint`. */
async function loadConnectAndDiscover() {
  return import('../../../apps/control-plane/src/services/connect-and-discover.js');
}

function buildDiscoveryFacts(overrides: Partial<DiscoveryFacts> = {}): DiscoveryFacts {
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

function buildDiscoveryCheck(id: DiscoveryCheckId = 'hostname'): DiscoveryCheck {
  return { id, status: 'pass', detail: `${id}: pass`, durationMs: 5 };
}

function buildDiscoverySnapshot(): DiscoverySnapshot {
  return { facts: buildDiscoveryFacts(), checks: [buildDiscoveryCheck()], warnings: [] };
}

/**
 * A fake `SshPort` whose `connect` result depends on `input.trustedFingerprint`, mirroring the
 * real `packages/ssh` adapter's own TOFU-vs-mismatch contract (`ssh-port.ts` lines ~83-100):
 * `trustedFingerprint === null` is always a first capture (never a mismatch); a non-null value
 * that differs from `presented` is a `HOST_KEY_CHANGED`; a non-null value that matches is a plain
 * reconnect. Task 2 (05-40-PLAN.md) needs this — not a fixed scripted outcome — because the
 * behaviour under test is exactly "does the row's `trustedFingerprint` change what the next
 * connect does", which a fixed outcome could not distinguish.
 */
function buildTofuAwareSshPort(presented: HostFingerprint) {
  return buildFakeSshPort((input: ConnectInput): ConnectOutcome => {
    if (input.trustedFingerprint === null) {
      return {
        ok: true,
        session: buildFakeSshSession({}),
        fingerprint: presented,
        fingerprintCaptured: true,
        attempts: 1,
      };
    }
    if (input.trustedFingerprint.fingerprint === presented.fingerprint) {
      return {
        ok: true,
        session: buildFakeSshSession({}),
        fingerprint: presented,
        fingerprintCaptured: false,
        attempts: 1,
      };
    }
    return {
      ok: false,
      errorCode: 'HOST_KEY_CHANGED',
      message: 'host key changed',
      attempts: 1,
      observedFingerprint: presented,
    };
  });
}

const FP_OLD_HOST: HostFingerprint = {
  keyType: 'ssh-ed25519',
  fingerprint: 'SHA256:OLDOLDOLDOLDOLDOLDOLDOLDOLDOLDOLDOLDOLDOLDOLD',
};
const FP_NEW_HOST: HostFingerprint = {
  keyType: 'ssh-ed25519',
  fingerprint: 'SHA256:NEWNEWNEWNEWNEWNEWNEWNEWNEWNEWNEWNEWNEWNEWNEW',
};

async function registerFixtureServer(
  fx: ServiceFixture,
  overrides: RegisterFixtureServerOverrides = {},
) {
  const { registerServer } = await loadRegisterServer();
  const result = await registerServer(fx.deps, {
    actor: overrides.actor ?? { type: 'system' },
    name: overrides.name ?? uniqueName(),
    host: overrides.host ?? uniqueHost(),
    ...(overrides.sshPort !== undefined ? { sshPort: overrides.sshPort } : {}),
    ...(overrides.sshUser !== undefined ? { sshUser: overrides.sshUser } : {}),
    credential: overrides.credential ?? {
      kind: 'password',
      password: freshPassword(),
    },
  });
  if (!result.ok) {
    throw new Error(`registerFixtureServer arrangement failed: ${result.code} ${result.message}`);
  }
  return result.server;
}

interface EditFixtureInput {
  readonly actor?: FixtureActor;
  readonly serverId: string;
  readonly name?: string;
  readonly host?: string;
  readonly sshPort?: number;
  readonly sshUser?: string;
  readonly credential?: FixtureCredential;
}

async function editFixtureServer(fx: ServiceFixture, input: EditFixtureInput) {
  const { editServer } = await loadEditServer();
  return editServer(fx.deps, {
    actor: input.actor ?? { type: 'system' },
    serverId: input.serverId,
    ...(input.name !== undefined ? { name: input.name } : {}),
    ...(input.host !== undefined ? { host: input.host } : {}),
    ...(input.sshPort !== undefined ? { sshPort: input.sshPort } : {}),
    ...(input.sshUser !== undefined ? { sshUser: input.sshUser } : {}),
    ...(input.credential !== undefined ? { credential: input.credential } : {}),
  });
}

/** Test-arrangement-only raw SQL: sets a server's status directly, bypassing every service and
 *  the domain state machine, so a suite case can start from a status `registerServer` itself
 *  cannot produce (CONNECTING, CONNECTED, ERROR, UNREACHABLE, DISCONNECTED). Never used by
 *  production code — `editServer` itself must go exclusively through `transition()`. */
async function setServerStatus(
  fx: ServiceFixture,
  serverId: string,
  status: 'CONNECTING' | 'CONNECTED' | 'ERROR' | 'UNREACHABLE' | 'DISCONNECTED' | 'PENDING',
): Promise<void> {
  await fx.db.execute(
    sql`update servers set status = ${status}::server_status where id = ${serverId}`,
  );
}

/** Test-arrangement-only raw SQL: stamps a host fingerprint directly, needed to prove D-14's
 *  identity-change edge clears it and its access-change edge preserves it. */
async function setServerFingerprint(
  fx: ServiceFixture,
  serverId: string,
  fingerprint: string,
): Promise<void> {
  await fx.db.execute(
    sql`update servers
        set host_fingerprint = ${fingerprint}, host_fingerprint_captured_at = now()
        where id = ${serverId}`,
  );
}

/** Test-arrangement-only raw SQL: lands a row in `ERROR` with a non-null `pendingFingerprint`
 *  the way a real `HOST_KEY_CHANGED` connect failure would, without driving an actual SSH
 *  session (per this plan's own action note — a direct Drizzle/SQL update of status,
 *  lastErrorCode, pendingFingerprint and pendingFingerprintSeenAt is preferable here). Only
 *  ever used to arrange UF-01's regression state — `editServer` itself must never write
 *  `pendingFingerprint` outside its own new ERROR-branch clear. */
async function setServerErrorWithPendingFingerprint(
  fx: ServiceFixture,
  serverId: string,
  pendingFingerprint: string,
): Promise<void> {
  await fx.db.execute(
    sql`update servers
        set status = 'ERROR'::server_status,
            last_error_code = 'HOST_KEY_CHANGED'::server_error_code,
            pending_fingerprint = ${pendingFingerprint},
            pending_fingerprint_seen_at = now()
        where id = ${serverId}`,
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

async function fetchActivityEventsFor(fx: ServiceFixture, entityId: string) {
  return fx.db.select().from(activityEvents).where(eq(activityEvents.entityId, entityId));
}

/** `registerFixtureServer` arrangement already writes one `server.created` event for the same
 *  entity, so any assertion about the `server.updated` event this suite is actually testing must
 *  filter to that specific action rather than assume array position. */
async function fetchServerUpdatedEvent(fx: ServiceFixture, entityId: string) {
  const [event] = await fx.db
    .select()
    .from(activityEvents)
    .where(and(eq(activityEvents.entityId, entityId), eq(activityEvents.action, 'server.updated')));
  return event;
}

describe('editServer (SERV-02, ACT-01, D-11, D-13, D-14, D-16)', () => {
  it('returns NOT_FOUND for an unknown serverId', async () => {
    fixture = await startServiceFixture();

    const result = await editFixtureServer(fixture, {
      serverId: randomUUID(),
      name: uniqueName(),
    });

    expect(result).toMatchObject({ ok: false, code: 'NOT_FOUND' });
  });

  it('returns SERVER_BUSY for a CONNECTING server, leaves the row byte-identical and writes no event', async () => {
    fixture = await startServiceFixture();
    const server = await registerFixtureServer(fixture);
    await setServerStatus(fixture, server.id, 'CONNECTING');
    const before = await fetchServerRow(fixture, server.id);
    const eventsBefore = await fetchActivityEventsFor(fixture, server.id);

    const result = await editFixtureServer(fixture, { serverId: server.id, name: uniqueName() });

    expect(result).toMatchObject({ ok: false, code: 'SERVER_BUSY' });
    const after = await fetchServerRow(fixture, server.id);
    expect(after).toEqual(before);
    const eventsAfter = await fetchActivityEventsFor(fixture, server.id);
    expect(eventsAfter).toHaveLength(eventsBefore.length);
  });

  it('renames a server to a valid new name and writes a server.updated event with name-only metadata', async () => {
    fixture = await startServiceFixture();
    const server = await registerFixtureServer(fixture);
    const newName = uniqueName();

    const result = await editFixtureServer(fixture, { serverId: server.id, name: newName });

    expect(result).toMatchObject({ ok: true });
    if (!result.ok) return;
    expect(result.server.name).toBe(newName);

    const row = await fetchServerRow(fixture, server.id);
    expect(row?.name).toBe(newName);

    const event = await fetchServerUpdatedEvent(fixture, server.id);
    expect(event?.action).toBe('server.updated');
    expect(event?.metadata).toEqual({ changedFields: ['name'], credentialReplaced: false });
  });

  it('rejects a rename colliding with another server (D-10 lower() uniqueness) with NAME_TAKEN and writes nothing', async () => {
    // Server names are already-lowercase slugs (validateServerName rejects uppercase outright,
    // matching register-server.test.ts's own precedent), so a genuinely case-differing valid
    // input can never reach this check — the exact-duplicate case below is what the `lower()`
    // uniqueness index actually guards in practice.
    fixture = await startServiceFixture();
    const other = await registerFixtureServer(fixture, { name: 'srv-taken-name' });
    const server = await registerFixtureServer(fixture);
    const before = await fetchServerRow(fixture, server.id);

    const result = await editFixtureServer(fixture, {
      serverId: server.id,
      name: other.name,
    });

    expect(result).toMatchObject({ ok: false, code: 'NAME_TAKEN' });
    const after = await fetchServerRow(fixture, server.id);
    expect(after).toEqual(before);
  });

  it('rejects a host+port change colliding with another server with HOST_TAKEN', async () => {
    fixture = await startServiceFixture();
    const other = await registerFixtureServer(fixture, { host: uniqueHost(), sshPort: 2222 });
    const server = await registerFixtureServer(fixture);

    const result = await editFixtureServer(fixture, {
      serverId: server.id,
      host: other.host,
      sshPort: other.sshPort,
    });

    expect(result).toMatchObject({ ok: false, code: 'HOST_TAKEN' });
  });

  it('rejects an invalid ssh user with VALIDATION_FAILED', async () => {
    fixture = await startServiceFixture();
    const server = await registerFixtureServer(fixture);

    const result = await editFixtureServer(fixture, { serverId: server.id, sshUser: '1invalid' });

    expect(result).toMatchObject({ ok: false, code: 'VALIDATION_FAILED' });
  });

  it('replaces the credential in place: same credentials.id, different encrypted_value, key_version set, updated_at changed, servers.credential_id unchanged (D-13)', async () => {
    fixture = await startServiceFixture();
    const server = await registerFixtureServer(fixture);
    const rowBefore = await fetchServerRow(fixture, server.id);
    const credentialBefore = await fetchCredentialRow(fixture, rowBefore!.credentialId);

    const result = await editFixtureServer(fixture, {
      serverId: server.id,
      credential: { kind: 'password', password: freshPassword() },
    });

    expect(result).toMatchObject({ ok: true });
    const rowAfter = await fetchServerRow(fixture, server.id);
    expect(rowAfter?.credentialId).toBe(rowBefore!.credentialId);

    const credentialAfter = await fetchCredentialRow(fixture, rowBefore!.credentialId);
    expect(credentialAfter?.id).toBe(credentialBefore?.id);
    expect(credentialAfter?.encryptedValue).not.toBe(credentialBefore?.encryptedValue);
    expect(credentialAfter?.keyVersion).toBe(1);
    expect(credentialAfter?.updatedAt).not.toEqual(credentialBefore?.updatedAt);
    expect(credentialAfter?.updatedAt).toEqual(FIXED_NOW);
  });

  it('switches credential kind from private key to password, changing credentials.type on the same row', async () => {
    fixture = await startServiceFixture();
    const server = await registerFixtureServer(fixture, {
      credential: { kind: 'private_key', privateKey: VALID_PRIVATE_KEY },
    });
    const rowBefore = await fetchServerRow(fixture, server.id);

    const result = await editFixtureServer(fixture, {
      serverId: server.id,
      credential: { kind: 'password', password: freshPassword() },
    });

    expect(result).toMatchObject({ ok: true });
    if (!result.ok) return;
    expect(result.server.credentialType).toBe('ssh_password');

    const credentialAfter = await fetchCredentialRow(fixture, rowBefore!.credentialId);
    expect(credentialAfter?.type).toBe('ssh_password');
  });

  it('rejects an invalid replacement key with INVALID_CREDENTIAL and leaves the stored encrypted_value unchanged', async () => {
    fixture = await startServiceFixture();
    const server = await registerFixtureServer(fixture);
    const rowBefore = await fetchServerRow(fixture, server.id);
    const credentialBefore = await fetchCredentialRow(fixture, rowBefore!.credentialId);

    const result = await editFixtureServer(fixture, {
      serverId: server.id,
      credential: { kind: 'private_key', privateKey: TOO_SMALL_PRIVATE_KEY },
    });

    expect(result).toMatchObject({ ok: false, code: 'INVALID_CREDENTIAL' });
    const credentialAfter = await fetchCredentialRow(fixture, rowBefore!.credentialId);
    expect(credentialAfter?.encryptedValue).toBe(credentialBefore?.encryptedValue);
  });

  it('never carries the credential in the result: no credentialId key, no old or new secret material in the JSON', async () => {
    fixture = await startServiceFixture();
    const oldPassword = freshPassword();
    const newPassword = freshPassword();
    const server = await registerFixtureServer(fixture, {
      credential: { kind: 'password', password: oldPassword },
    });

    const result = await editFixtureServer(fixture, {
      serverId: server.id,
      credential: { kind: 'password', password: newPassword },
    });

    expect(result).toMatchObject({ ok: true });
    if (!result.ok) return;
    expect(Object.keys(result.server)).not.toContain('credentialId');
    const json = JSON.stringify(result);
    expect(json).not.toContain(oldPassword);
    expect(json).not.toContain(newPassword);
  });

  it('CONNECTED + host change transitions to PENDING and clears the host fingerprint (D-14 identity)', async () => {
    fixture = await startServiceFixture();
    const server = await registerFixtureServer(fixture);
    await setServerStatus(fixture, server.id, 'CONNECTED');
    await setServerFingerprint(fixture, server.id, 'SHA256:fake-fingerprint');

    const result = await editFixtureServer(fixture, { serverId: server.id, host: uniqueHost() });

    expect(result).toMatchObject({ ok: true });
    if (!result.ok) return;
    expect(result.server.status).toBe('PENDING');
    const row = await fetchServerRow(fixture, server.id);
    expect(row?.hostFingerprint).toBeNull();
    expect(row?.hostFingerprintCapturedAt).toBeNull();

    const event = await fetchServerUpdatedEvent(fixture, server.id);
    expect((event?.metadata as { changedFields: string[] } | null)?.changedFields).toContain(
      'host',
    );
  });

  it('CONNECTED + ssh port change transitions to PENDING (D-14 identity)', async () => {
    fixture = await startServiceFixture();
    const server = await registerFixtureServer(fixture, { sshPort: 22 });
    await setServerStatus(fixture, server.id, 'CONNECTED');

    const result = await editFixtureServer(fixture, { serverId: server.id, sshPort: 2222 });

    expect(result).toMatchObject({ ok: true });
    if (!result.ok) return;
    expect(result.server.status).toBe('PENDING');
  });

  it('CONNECTED + ssh user change only transitions to DISCONNECTED and preserves the fingerprint (D-14 access)', async () => {
    fixture = await startServiceFixture();
    const server = await registerFixtureServer(fixture, { sshUser: 'deployer' });
    await setServerStatus(fixture, server.id, 'CONNECTED');
    await setServerFingerprint(fixture, server.id, 'SHA256:fake-fingerprint');

    const result = await editFixtureServer(fixture, { serverId: server.id, sshUser: 'operator' });

    expect(result).toMatchObject({ ok: true });
    if (!result.ok) return;
    expect(result.server.status).toBe('DISCONNECTED');
    const row = await fetchServerRow(fixture, server.id);
    expect(row?.hostFingerprint).not.toBeNull();
  });

  it('CONNECTED + credential replacement only transitions to DISCONNECTED with credentialReplaced true (D-14 access)', async () => {
    fixture = await startServiceFixture();
    const server = await registerFixtureServer(fixture);
    await setServerStatus(fixture, server.id, 'CONNECTED');

    const result = await editFixtureServer(fixture, {
      serverId: server.id,
      credential: { kind: 'password', password: freshPassword() },
    });

    expect(result).toMatchObject({ ok: true });
    if (!result.ok) return;
    expect(result.server.status).toBe('DISCONNECTED');

    const event = await fetchServerUpdatedEvent(fixture, server.id);
    expect((event?.metadata as { credentialReplaced: boolean } | null)?.credentialReplaced).toBe(
      true,
    );
  });

  it('CONNECTED + name change only stays CONNECTED (a rename is neither identity nor access)', async () => {
    fixture = await startServiceFixture();
    const server = await registerFixtureServer(fixture);
    await setServerStatus(fixture, server.id, 'CONNECTED');

    const result = await editFixtureServer(fixture, { serverId: server.id, name: uniqueName() });

    expect(result).toMatchObject({ ok: true });
    if (!result.ok) return;
    expect(result.server.status).toBe('CONNECTED');
  });

  it.each(['ERROR', 'PENDING', 'UNREACHABLE', 'DISCONNECTED'] as const)(
    '%s + host change updates the field without attempting a transition or throwing',
    async (status) => {
      fixture = await startServiceFixture();
      const server = await registerFixtureServer(fixture);
      await setServerStatus(fixture, server.id, status);
      const newHost = uniqueHost();

      const result = await editFixtureServer(fixture, { serverId: server.id, host: newHost });

      expect(result).toMatchObject({ ok: true });
      if (!result.ok) return;
      expect(result.server.host).toBe(newHost);
      expect(result.server.status).toBe(status);
    },
  );

  it('an edit that changes nothing returns the unchanged view and writes no new activity event', async () => {
    fixture = await startServiceFixture();
    const server = await registerFixtureServer(fixture);
    const eventsBefore = await fetchActivityEventsFor(fixture, server.id);

    const result = await editFixtureServer(fixture, { serverId: server.id });

    expect(result).toMatchObject({ ok: true });
    if (!result.ok) return;
    expect(result.server).toEqual(server);
    const eventsAfter = await fetchActivityEventsFor(fixture, server.id);
    expect(eventsAfter).toHaveLength(eventsBefore.length);
  });

  it('changedFields is sorted and contains only field names, never a value', async () => {
    fixture = await startServiceFixture();
    const server = await registerFixtureServer(fixture, { sshUser: 'deployer' });

    const result = await editFixtureServer(fixture, {
      serverId: server.id,
      name: uniqueName(),
      host: uniqueHost(),
      sshPort: 2200,
      sshUser: 'operator',
    });

    expect(result).toMatchObject({ ok: true });
    const event = await fetchServerUpdatedEvent(fixture, server.id);
    const metadata = event?.metadata as { changedFields: string[] } | null;
    expect(metadata?.changedFields).toEqual([...metadata!.changedFields].sort());
    for (const field of metadata?.changedFields ?? []) {
      expect(['name', 'host', 'sshPort', 'sshUser']).toContain(field);
    }
    const json = JSON.stringify(metadata?.changedFields);
    expect(json).not.toContain('operator');
    expect(json).not.toContain('2200');
  });

  it('attributes the event to a user actor (D-17)', async () => {
    fixture = await startServiceFixture();
    const server = await registerFixtureServer(fixture);
    const userId = randomUUID();

    const result = await editFixtureServer(fixture, {
      serverId: server.id,
      name: uniqueName(),
      actor: { type: 'user', id: userId },
    });

    expect(result).toMatchObject({ ok: true });
    const event = await fetchServerUpdatedEvent(fixture, server.id);
    expect(event?.actorType).toBe('user');
    expect(event?.actorId).toBe(userId);
  });

  it('attributes the event to a system actor with a null actorId (D-17)', async () => {
    fixture = await startServiceFixture();
    const server = await registerFixtureServer(fixture);

    const result = await editFixtureServer(fixture, {
      serverId: server.id,
      name: uniqueName(),
      actor: { type: 'system' },
    });

    expect(result).toMatchObject({ ok: true });
    const event = await fetchServerUpdatedEvent(fixture, server.id);
    expect(event?.actorType).toBe('system');
    expect(event?.actorId).toBeNull();
  });

  describe('UF-01: a stale pendingFingerprint on an ERROR-status identity edit', () => {
    it('clears pendingFingerprint and pendingFingerprintSeenAt on a host change, so a following trustFingerprint fails safely', async () => {
      fixture = await startServiceFixture();
      const server = await registerFixtureServer(fixture);
      await setServerErrorWithPendingFingerprint(fixture, server.id, 'SHA256:stale-pending-fp');
      const rowBefore = await fetchServerRow(fixture, server.id);
      expect(rowBefore?.pendingFingerprint).not.toBeNull();

      const result = await editFixtureServer(fixture, { serverId: server.id, host: uniqueHost() });

      expect(result).toMatchObject({ ok: true });
      const row = await fetchServerRow(fixture, server.id);
      expect(row?.pendingFingerprint).toBeNull();
      expect(row?.pendingFingerprintSeenAt).toBeNull();

      const { trustFingerprint } = await loadTrustFingerprint();
      // NO_PENDING_FINGERPRINT is returned before any fingerprint comparison — value is
      // irrelevant (the edit above already cleared pendingFingerprint, per WR-A-02).
      const trustResult = await trustFingerprint(fixture.deps, {
        actor: { type: 'system' },
        serverId: server.id,
        fingerprint: 'unused',
      });
      expect(trustResult).toMatchObject({ ok: false, code: 'NO_PENDING_FINGERPRINT' });
      const rowAfterTrust = await fetchServerRow(fixture, server.id);
      expect(rowAfterTrust?.hostFingerprint).toBe(rowBefore?.hostFingerprint ?? null);
    });

    it('clears pendingFingerprint on an sshPort-only change', async () => {
      fixture = await startServiceFixture();
      const server = await registerFixtureServer(fixture, { sshPort: 22 });
      await setServerErrorWithPendingFingerprint(fixture, server.id, 'SHA256:stale-pending-fp');

      const result = await editFixtureServer(fixture, { serverId: server.id, sshPort: 2222 });

      expect(result).toMatchObject({ ok: true });
      const row = await fetchServerRow(fixture, server.id);
      expect(row?.pendingFingerprint).toBeNull();
      expect(row?.pendingFingerprintSeenAt).toBeNull();
    });

    it('clears pendingFingerprint on an sshUser-only change', async () => {
      fixture = await startServiceFixture();
      const server = await registerFixtureServer(fixture, { sshUser: 'deployer' });
      await setServerErrorWithPendingFingerprint(fixture, server.id, 'SHA256:stale-pending-fp');

      const result = await editFixtureServer(fixture, { serverId: server.id, sshUser: 'operator' });

      expect(result).toMatchObject({ ok: true });
      const row = await fetchServerRow(fixture, server.id);
      expect(row?.pendingFingerprint).toBeNull();
      expect(row?.pendingFingerprintSeenAt).toBeNull();
    });

    it('leaves pendingFingerprint untouched on a non-identity (name-only) edit', async () => {
      fixture = await startServiceFixture();
      const server = await registerFixtureServer(fixture);
      await setServerErrorWithPendingFingerprint(fixture, server.id, 'SHA256:stale-pending-fp');

      const result = await editFixtureServer(fixture, { serverId: server.id, name: uniqueName() });

      expect(result).toMatchObject({ ok: true });
      const row = await fetchServerRow(fixture, server.id);
      expect(row?.pendingFingerprint).toBe('SHA256:stale-pending-fp');
      expect(row?.pendingFingerprintSeenAt).not.toBeNull();

      const { trustFingerprint } = await loadTrustFingerprint();
      const trustResult = await trustFingerprint(fixture.deps, {
        actor: { type: 'system' },
        serverId: server.id,
        fingerprint: 'SHA256:stale-pending-fp',
      });
      expect(trustResult).toMatchObject({ ok: true });
    });
  });

  describe('GR-02 (05-REVIEW.md; 05-VERIFICATION.md gap 6): a host/port change clears the trusted host key from any status; an sshUser change does not', () => {
    it('ERROR + host change clears hostFingerprint/hostFingerprintCapturedAt and leaves status untouched', async () => {
      fixture = await startServiceFixture();
      const server = await registerFixtureServer(fixture);
      await setServerStatus(fixture, server.id, 'ERROR');
      await setServerFingerprint(fixture, server.id, 'SHA256:old-host');

      const result = await editFixtureServer(fixture, { serverId: server.id, host: uniqueHost() });

      expect(result).toMatchObject({ ok: true });
      if (!result.ok) return;
      expect(result.server.status).toBe('ERROR');
      const row = await fetchServerRow(fixture, server.id);
      expect(row?.hostFingerprint).toBeNull();
      expect(row?.hostFingerprintCapturedAt).toBeNull();
    });

    it('UNREACHABLE + sshPort change clears hostFingerprint/hostFingerprintCapturedAt and leaves status untouched', async () => {
      fixture = await startServiceFixture();
      const server = await registerFixtureServer(fixture, { sshPort: 22 });
      await setServerStatus(fixture, server.id, 'UNREACHABLE');
      await setServerFingerprint(fixture, server.id, 'SHA256:old-host');

      const result = await editFixtureServer(fixture, { serverId: server.id, sshPort: 2222 });

      expect(result).toMatchObject({ ok: true });
      if (!result.ok) return;
      expect(result.server.status).toBe('UNREACHABLE');
      const row = await fetchServerRow(fixture, server.id);
      expect(row?.hostFingerprint).toBeNull();
      expect(row?.hostFingerprintCapturedAt).toBeNull();
    });

    it.each(['DISCONNECTED', 'PENDING'] as const)(
      '%s + host change clears hostFingerprint/hostFingerprintCapturedAt and leaves status untouched',
      async (status) => {
        fixture = await startServiceFixture();
        const server = await registerFixtureServer(fixture);
        await setServerStatus(fixture, server.id, status);
        await setServerFingerprint(fixture, server.id, 'SHA256:old-host');

        const result = await editFixtureServer(fixture, { serverId: server.id, host: uniqueHost() });

        expect(result).toMatchObject({ ok: true });
        if (!result.ok) return;
        expect(result.server.status).toBe(status);
        const row = await fetchServerRow(fixture, server.id);
        expect(row?.hostFingerprint).toBeNull();
        expect(row?.hostFingerprintCapturedAt).toBeNull();
      },
    );

    it('ERROR + sshUser-only change preserves hostFingerprint/hostFingerprintCapturedAt while still clearing pendingFingerprint (T-5G-40-02)', async () => {
      fixture = await startServiceFixture();
      const server = await registerFixtureServer(fixture, { sshUser: 'deployer' });
      await setServerErrorWithPendingFingerprint(fixture, server.id, 'SHA256:stale-pending-fp');
      await setServerFingerprint(fixture, server.id, 'SHA256:old-host');
      const rowBefore = await fetchServerRow(fixture, server.id);
      expect(rowBefore?.hostFingerprint).toBe('SHA256:old-host');
      expect(rowBefore?.hostFingerprintCapturedAt).not.toBeNull();

      const result = await editFixtureServer(fixture, { serverId: server.id, sshUser: 'operator' });

      expect(result).toMatchObject({ ok: true });
      const row = await fetchServerRow(fixture, server.id);
      expect(row?.hostFingerprint).toBe('SHA256:old-host');
      expect(row?.hostFingerprintCapturedAt).toEqual(rowBefore?.hostFingerprintCapturedAt);
      // The existing identityChanged behaviour (WR-A-02) is unaffected by this narrower predicate.
      expect(row?.pendingFingerprint).toBeNull();
      expect(row?.pendingFingerprintSeenAt).toBeNull();
    });

    it('a name-only edit from ERROR leaves hostFingerprint/hostFingerprintCapturedAt untouched', async () => {
      fixture = await startServiceFixture();
      const server = await registerFixtureServer(fixture);
      await setServerStatus(fixture, server.id, 'ERROR');
      await setServerFingerprint(fixture, server.id, 'SHA256:old-host');
      const rowBefore = await fetchServerRow(fixture, server.id);

      const result = await editFixtureServer(fixture, { serverId: server.id, name: uniqueName() });

      expect(result).toMatchObject({ ok: true });
      const row = await fetchServerRow(fixture, server.id);
      expect(row?.hostFingerprint).toBe('SHA256:old-host');
      expect(row?.hostFingerprintCapturedAt).toEqual(rowBefore?.hostFingerprintCapturedAt);
    });

    it('Test A: after a host re-point, a connect presenting a different key is a clean TOFU first capture, not HOST_KEY_CHANGED', async () => {
      fixture = await startServiceFixture();
      const server = await registerFixtureServer(fixture);
      const { connectAndDiscover } = await loadConnectAndDiscover();

      fixture.setSshPort(buildTofuAwareSshPort(FP_OLD_HOST));
      const first = await connectAndDiscover(fixture.deps, {
        actor: { type: 'system' },
        serverId: server.id,
        discover: () => Promise.resolve(buildDiscoverySnapshot()),
      });
      if (!first.ok) throw new Error('arrangement: first connect failed unexpectedly');
      expect(first.server.status).toBe('CONNECTED');
      expect(first.server.hostFingerprint).toBe(`${FP_OLD_HOST.keyType} ${FP_OLD_HOST.fingerprint}`);

      // Moved off CONNECTED before the edit — deliberately, so this test isolates GR-02's new
      // status-independent `hostIdentityChanged` clear from D-14's pre-existing CONNECTED-branch
      // clear (which would otherwise also clear the fingerprint here and mask a regression).
      await setServerStatus(fixture, server.id, 'UNREACHABLE');
      const edited = await editFixtureServer(fixture, { serverId: server.id, host: uniqueHost() });
      expect(edited).toMatchObject({ ok: true });
      const rowAfterEdit = await fetchServerRow(fixture, server.id);
      expect(rowAfterEdit?.status).toBe('UNREACHABLE');
      expect(rowAfterEdit?.hostFingerprint).toBeNull();

      // Before the Task 1 fix, this second connect would present a key that differs from the
      // still-attached *old* host's trusted fingerprint and would spuriously fail HOST_KEY_CHANGED
      // even though the row now points at a different machine entirely.
      fixture.setSshPort(buildTofuAwareSshPort(FP_NEW_HOST));
      const second = await connectAndDiscover(fixture.deps, {
        actor: { type: 'system' },
        serverId: server.id,
        discover: () => Promise.resolve(buildDiscoverySnapshot()),
      });

      if (!second.ok) throw new Error('second connect failed unexpectedly');
      expect(second.connection.ok).toBe(true);
      expect(second.server.status).toBe('CONNECTED');
      expect(second.server.lastErrorCode).not.toBe('HOST_KEY_CHANGED');
      expect(second.server.hostFingerprint).toBe(`${FP_NEW_HOST.keyType} ${FP_NEW_HOST.fingerprint}`);
    });

    it('Test B (control): the same sequence WITHOUT the edit still produces HOST_KEY_CHANGED with the observed value parked', async () => {
      fixture = await startServiceFixture();
      const server = await registerFixtureServer(fixture);
      const { connectAndDiscover } = await loadConnectAndDiscover();

      fixture.setSshPort(buildTofuAwareSshPort(FP_OLD_HOST));
      const first = await connectAndDiscover(fixture.deps, {
        actor: { type: 'system' },
        serverId: server.id,
        discover: () => Promise.resolve(buildDiscoverySnapshot()),
      });
      if (!first.ok) throw new Error('arrangement: first connect failed unexpectedly');
      expect(first.server.hostFingerprint).toBe(`${FP_OLD_HOST.keyType} ${FP_OLD_HOST.fingerprint}`);

      // Same status move as Test A, but NO edit — proves Test A's pass is caused by the edit
      // clearing the fingerprint, not by the mismatch detection itself being broken, and not by
      // the status change alone.
      await setServerStatus(fixture, server.id, 'UNREACHABLE');
      fixture.setSshPort(buildTofuAwareSshPort(FP_NEW_HOST));
      const second = await connectAndDiscover(fixture.deps, {
        actor: { type: 'system' },
        serverId: server.id,
      });

      if (!second.ok) throw new Error('second connect failed unexpectedly');
      expect(second.connection.ok).toBe(false);
      expect(second.server.status).toBe('ERROR');
      expect(second.server.lastErrorCode).toBe('HOST_KEY_CHANGED');
      expect(second.server.pendingFingerprint).toBe(`${FP_NEW_HOST.keyType} ${FP_NEW_HOST.fingerprint}`);
      // The old host's trusted fingerprint is untouched — this is the pre-existing mismatch path,
      // not this plan's fix.
      expect(second.server.hostFingerprint).toBe(`${FP_OLD_HOST.keyType} ${FP_OLD_HOST.fingerprint}`);
    });
  });
});
