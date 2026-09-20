// DETL-01/DETL-02: RED for the CONNECTING wedge (05-VERIFICATION.md gap 2, backend half;
// 05-REVIEW.md WR-A-01). Before this plan's fix, `connectAndDiscover` committed `CONNECTING` in
// TX1 and then ran `decodeCredential`, the SSH phase, `session.close()` and TX2 with no
// `try/catch` around any of it — a throw from any of those left the row wedged in `CONNECTING`
// until a worker restart's startup sweep. Every later mutation was refused as `ALREADY_CONNECTING`
// (`SERVER_BUSY` at the HTTP layer) and the detail screen had no DETL-02 state to render, only an
// endless "Connecting…" spinner.
//
// This suite corrupts a real, persisted credential's AES-256-GCM auth tag (a one-byte flip on the
// stored envelope's last segment) so `decodeCredential` throws a genuine `SecretTamperError`
// immediately after TX1 commits — the same failure shape 05-26-PLAN.md's own objective names as
// realistic (a credential that no longer decodes after a master-key rotation), reproduced here
// without touching `NOODARA_MASTER_KEY` itself. Mirrors
// tests/integration/services/connect-and-discover.test.ts's own `patchServerRow` precedent: a
// direct Drizzle `UPDATE`, bypassing every service/domain rule, standing in for "corrupt data
// already in Postgres" rather than inventing a new harness.
import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { afterEach, describe, expect, it } from 'vitest';
import {
  activityEvents,
  credentials,
  servers,
} from '../../../apps/control-plane/src/db/schema/index.js';
import { assertNoStrayTestContainers } from '../helpers/ssh.js';
import { startServiceFixture, type ServiceFixture } from '../services/helpers/service-fixture.js';

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

/** Loaded dynamically on every call, mirroring connect-and-discover.test.ts's own discipline:
 *  the module transitively imports apps/control-plane/src/activity/redaction.ts, which reads
 *  env.NOODARA_MASTER_KEY at import time (INST-06) and would crash the process if imported before
 *  startServiceFixture() has written a valid test env. */
async function loadConnectAndDiscover() {
  return import('../../../apps/control-plane/src/services/connect-and-discover.js');
}

async function loadRegisterServer() {
  return import('../../../apps/control-plane/src/services/register-server.js');
}

async function loadFailInFlightConnection() {
  return import('../../../apps/control-plane/src/services/fail-in-flight-connection.js');
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

/** Flips one character of the stored envelope's auth-tag segment (the last `:`-delimited segment,
 *  D-10's `v<version>:<nonce_b64>:<ciphertext_b64>:<tag_b64>` format) so the next
 *  `decodeCredential` call fails GCM authentication and throws a real `SecretTamperError` — never
 *  a `MalformedBlobError`, since the shape (segment count, base64-ness, decoded lengths) is left
 *  intact. */
async function corruptServerCredential(fx: ServiceFixture, serverId: string): Promise<void> {
  const [server] = await fx.db.select().from(servers).where(eq(servers.id, serverId));
  if (!server) throw new Error('corruptServerCredential: server row not found');
  const [credentialRow] = await fx.db
    .select()
    .from(credentials)
    .where(eq(credentials.id, server.credentialId));
  if (!credentialRow) throw new Error('corruptServerCredential: credential row not found');

  const segments = credentialRow.encryptedValue.split(':');
  const tag = segments[3];
  if (segments.length !== 4 || tag === undefined || tag.length === 0) {
    throw new Error('corruptServerCredential: unexpected envelope shape');
  }
  const flippedFirstChar = tag[0] === 'A' ? 'B' : 'A';
  segments[3] = flippedFirstChar + tag.slice(1);

  await fx.db
    .update(credentials)
    .set({ encryptedValue: segments.join(':') })
    .where(eq(credentials.id, credentialRow.id));
}

async function serverRow(fx: ServiceFixture, serverId: string) {
  const [row] = await fx.db.select().from(servers).where(eq(servers.id, serverId));
  return row;
}

async function connectionAttemptedEvents(fx: ServiceFixture, serverId: string) {
  return fx.db.select().from(activityEvents).where(eq(activityEvents.entityId, serverId));
}

describe('CONNECTING wedge recovery (05-VERIFICATION.md gap 2, WR-A-01)', () => {
  it('a post-TX1 throw (corrupted credential) resolves the row out of CONNECTING instead of wedging it', async () => {
    fixture = await startServiceFixture();
    const server = await registerFixtureServer(fixture);
    await corruptServerCredential(fixture, server.id);

    const { connectAndDiscover } = await loadConnectAndDiscover();

    await expect(
      connectAndDiscover(fixture.deps, { actor: SYSTEM, serverId: server.id }),
    ).rejects.toThrow();

    const row = await serverRow(fixture, server.id);
    // The load-bearing assertion this test exists to prove: before this plan's fix, `row?.status`
    // stayed 'CONNECTING' here — wedged until a worker restart's sweep.
    expect(row?.status).not.toBe('CONNECTING');
    expect(row?.status).toBe('ERROR');
    expect(row?.lastErrorCode).toBe('CONNECTION_LOST');
  });

  it('recovery is idempotent: a second failInFlightConnection call for the same server is a no-op', async () => {
    fixture = await startServiceFixture();
    const server = await registerFixtureServer(fixture);
    await corruptServerCredential(fixture, server.id);

    const { connectAndDiscover } = await loadConnectAndDiscover();
    await connectAndDiscover(fixture.deps, { actor: SYSTEM, serverId: server.id }).catch(
      () => undefined,
    );

    const rowAfterFirstRecovery = await serverRow(fixture, server.id);
    expect(rowAfterFirstRecovery?.status).toBe('ERROR');
    const eventsAfterFirstRecovery = await connectionAttemptedEvents(fixture, server.id);

    const { failInFlightConnection } = await loadFailInFlightConnection();
    const second = await failInFlightConnection(fixture.deps, {
      actor: SYSTEM,
      serverId: server.id,
      // An existing, already-valid reason literal — this test is about the row-lock/skip
      // mechanism `failInFlightConnection` already owns, not about which reason string this
      // plan's own new catch site passes.
      reason: 'worker_stalled',
    });

    expect(second).toMatchObject({ ok: true, skipped: true });
    const eventsAfterSecondRecovery = await connectionAttemptedEvents(fixture, server.id);
    expect(eventsAfterSecondRecovery).toHaveLength(eventsAfterFirstRecovery.length);
    const rowAfterSecondRecovery = await serverRow(fixture, server.id);
    expect(rowAfterSecondRecovery?.updatedAt).toEqual(rowAfterFirstRecovery?.updatedAt);
  });
});
