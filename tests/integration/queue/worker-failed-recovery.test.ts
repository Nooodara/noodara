// DETL-01/DETL-02/T-5G-26-01: worker-level regression test for the CONNECTING wedge fix
// (05-26-PLAN.md). tests/integration/servers/connect-wedge.test.ts already proves the fix at the
// service layer (calling `connectAndDiscover` directly); this suite proves the identical
// behaviour holds when a genuinely failing job is routed through the real BullMQ infrastructure
// this repo runs in production — `createWorker`'s job handler, its `'failed'` listener, and the
// exact `services.failInFlightConnection` both `connectAndDiscover`'s own post-TX1 catch and the
// worker's `'failed'` listener share.
//
// Distinct from stalled-recovery.test.ts (Plan 04-07/D-12): that suite reproduces a worker that
// *hangs* mid-SSH-session and never resolves, recovered by the `'stalled'` listener once
// `stalledInterval` elapses. This suite reproduces a job whose handler genuinely *throws* — a
// credential that no longer decodes (the exact `SecretTamperError` scenario 05-26-PLAN.md's own
// objective names as realistic).
import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { afterEach, describe, expect, it } from 'vitest';
import type { HostFingerprint } from '@noodara/ssh';
import { activityEvents, credentials, servers } from '../../../apps/control-plane/src/db/schema/index.js';
import { assertNoStrayTestContainers } from '../helpers/ssh.js';
import { startWorkerFixture, type WorkerFixture } from '../helpers/worker-fixture.js';
import { buildFakeSshPort, buildFakeSshSession } from '../services/helpers/service-fixture.js';

let fixture: WorkerFixture | undefined;

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

function freshPassword(): string {
  return randomUUID().replace(/-/g, '');
}

function uniqueName(): string {
  return `srv-${randomUUID().replace(/-/g, '').slice(0, 16)}`;
}

function uniqueHost(): string {
  return `${randomUUID().replace(/-/g, '').slice(0, 12)}.example.test`;
}

async function registerFixtureServer(fx: WorkerFixture) {
  const { registerServer } = await import('../../../apps/control-plane/src/services/register-server.js');
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

/** Flips one character of the stored envelope's auth-tag segment so the next `decodeCredential`
 *  call fails GCM authentication and throws a real `SecretTamperError` — the same corruption
 *  technique tests/integration/servers/connect-wedge.test.ts uses at the service layer, here
 *  driving the identical failure through the real worker/BullMQ path instead. */
async function corruptServerCredential(fx: WorkerFixture, serverId: string): Promise<void> {
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

/**
 * Patches `fx.db.transaction` in place so that exactly the `failOnCallNumber`-th call (counted
 * from the moment this is installed, across every caller sharing `fx.deps.db`) rejects instead of
 * running — every other call passes straight through to the original implementation. Mirrors
 * worker-fixture.ts's own `setDbFailing` Proxy technique one level more precisely: that toggle is
 * all-or-nothing, but this suite specifically needs `connectAndDiscover`'s own post-TX1 recovery
 * attempt (the 2nd `db.transaction` call after TX1 itself) to fail — simulating a transient
 * Postgres blip — so that only the worker's `'failed'` listener's own, later recovery attempt (the
 * 3rd call) is what actually resolves the row. `fx.db` is the real underlying Drizzle instance
 * (worker-fixture.ts's `dbProxy` wraps it but forwards to it via `Reflect.get` whenever
 * `dbFailing` is off), so patching it here is visible to every service call without needing a
 * second Proxy layer.
 */
function installNthTransactionFailure(fx: WorkerFixture, failOnCallNumber: number): void {
  const db = fx.db as unknown as { transaction: (...args: unknown[]) => Promise<unknown> };
  const original = db.transaction.bind(fx.db);
  let callCount = 0;
  db.transaction = (...args: unknown[]): Promise<unknown> => {
    callCount += 1;
    if (callCount === failOnCallNumber) {
      return Promise.reject(
        new Error('worker-failed-recovery.test: simulated transient Postgres failure'),
      );
    }
    return original(...args);
  };
}

async function enqueueJob(fx: WorkerFixture, serverId: string): Promise<string> {
  const result = await fx.queue.enqueue({
    serverId,
    actor: SYSTEM,
    requestedAt: new Date().toISOString(),
    trigger: 'connect',
  });
  if (!result.ok) {
    throw new Error(`enqueue failed unexpectedly: ${result.code} ${result.message}`);
  }
  return result.jobId;
}

function waitForCompletion(
  fx: WorkerFixture,
  jobId: string,
  timeoutMs = 20_000,
): Promise<{ outcome: string }> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`job ${jobId} did not complete within ${String(timeoutMs)}ms`));
    }, timeoutMs);
    fx.worker.worker.on('completed', (job, result: { outcome: string }) => {
      if (job.id === jobId) {
        clearTimeout(timer);
        resolve(result);
      }
    });
  });
}

function waitForFailure(fx: WorkerFixture, jobId: string, timeoutMs = 20_000): Promise<Error> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`job ${jobId} did not fail within ${String(timeoutMs)}ms`));
    }, timeoutMs);
    fx.worker.worker.on('failed', (job, err) => {
      if (job?.id === jobId) {
        clearTimeout(timer);
        resolve(err);
      }
    });
  });
}

async function waitUntil<T>(
  fn: () => Promise<T | undefined | null | false>,
  timeoutMs: number,
  intervalMs = 100,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const result = await fn();
    if (result) return result;
    if (Date.now() >= deadline) {
      throw new Error(`waitUntil: condition not met within ${String(timeoutMs)}ms`);
    }
    await new Promise((resolve) => {
      setTimeout(resolve, intervalMs);
    });
  }
}

async function connectionAttemptedEvents(fx: WorkerFixture, serverId: string) {
  const rows = await fx.db.select().from(activityEvents).where(eq(activityEvents.entityId, serverId));
  return rows.filter((row) => row.action === 'server.connection_attempted');
}

describe('connect-server-worker: genuinely failing job recovery (T-5G-26-01)', () => {
  it('a job whose handler throws (corrupted credential) drives the row out of CONNECTING with exactly one recovery event, and never re-attempts SSH', async () => {
    fixture = await startWorkerFixture();
    const server = await registerFixtureServer(fixture);
    await corruptServerCredential(fixture, server.id);
    // Never actually reached: decodeCredential throws before ssh.connect is ever called. A
    // pre-wired SshPort just makes that assertion meaningful instead of vacuous.
    const fakeSsh = buildFakeSshPort({
      ok: true,
      session: buildFakeSshSession({}),
      fingerprint: FP1,
      fingerprintCaptured: true,
      attempts: 1,
    });
    fixture.setSshPort(fakeSsh);

    const jobId = await enqueueJob(fixture, server.id);
    const err = await waitForFailure(fixture, jobId);
    expect(err).toBeInstanceOf(Error);

    const row = await waitUntil(async () => {
      const [current] = await fixture!.db.select().from(servers).where(eq(servers.id, server.id));
      return current?.status !== 'CONNECTING' ? current : undefined;
    }, 10_000);

    // The load-bearing assertion: the row is never left wedged in CONNECTING through the real
    // worker path.
    expect(row.status).toBe('ERROR');
    expect(row.lastErrorCode).toBe('CONNECTION_LOST');

    // decodeCredential throws before deps.ssh.connect is ever invoked — no second SSH attempt,
    // consistent with maxStalledCount: 0 and attempts: 1 already forbidding any retry.
    expect(fakeSsh.calls).toHaveLength(0);

    // Idempotency: `connectAndDiscover`'s own post-TX1 catch (reason: connect_service_threw) and
    // the worker's `'failed'` listener (reason: worker_job_failed) both call
    // `failInFlightConnection` for the same job — exactly one recovery event must survive, never
    // two, proving the row-lock/skip guard in fail-in-flight-connection.ts holds under the real
    // worker's own async dispatch, not just a directly-awaited service call.
    const events = await connectionAttemptedEvents(fixture, server.id);
    expect(events).toHaveLength(1);
    expect(events[0]?.outcome).toBe('failure');
    expect(events[0]?.errorCode).toBe('CONNECTION_LOST');

    // The worker keeps serving subsequent jobs: the `'failed'` listener's own recovery attempt is
    // wrapped in try/catch (mirroring the `'stalled'` listener), so it can never crash the worker
    // process via an unhandled rejection.
    const healthyServer = await registerFixtureServer(fixture);
    fixture.setSshPort(
      buildFakeSshPort({
        ok: false,
        errorCode: 'AUTH_FAILED',
        message: 'bad credentials',
        attempts: 1,
      }),
    );
    const healthyJobId = await enqueueJob(fixture, healthyServer.id);
    const healthyResult = await waitForCompletion(fixture, healthyJobId);
    expect(healthyResult).toEqual({ outcome: 'ok' });
  });

  it("recovers via the worker's own 'failed' listener when connectAndDiscover's own recovery attempt itself fails", async () => {
    fixture = await startWorkerFixture();
    const server = await registerFixtureServer(fixture);
    await corruptServerCredential(fixture, server.id);
    fixture.setSshPort(
      buildFakeSshPort({
        ok: true,
        session: buildFakeSshSession({}),
        fingerprint: FP1,
        fingerprintCaptured: true,
        attempts: 1,
      }),
    );

    // Call 1 = TX1 (lockAndBeginConnecting, commits CONNECTING) — must succeed.
    // Call 2 = connectAndDiscover's own post-TX1 catch calling failInFlightConnection — forced to
    // fail here, simulating a transient Postgres blip during recovery itself (05-26-PLAN.md's own
    // "if recovery also throws, the ORIGINAL error is still rethrown" contract).
    // Call 3 = the worker's 'failed' listener's own failInFlightConnection call — must succeed, or
    // this test's row would stay wedged in CONNECTING forever, proving the listener is not merely
    // redundant with the service-level catch but a genuine second line of defense.
    installNthTransactionFailure(fixture, 2);

    const jobId = await enqueueJob(fixture, server.id);
    const err = await waitForFailure(fixture, jobId);
    expect(err).toBeInstanceOf(Error);

    const row = await waitUntil(async () => {
      const [current] = await fixture!.db.select().from(servers).where(eq(servers.id, server.id));
      return current?.status !== 'CONNECTING' ? current : undefined;
    }, 10_000);

    expect(row.status).toBe('ERROR');
    expect(row.lastErrorCode).toBe('CONNECTION_LOST');

    // The service-level catch's own recovery attempt (call 2) was forced to fail and wrote
    // nothing; exactly one recovery event survives, written by the worker's 'failed' listener
    // (call 3).
    const events = await connectionAttemptedEvents(fixture, server.id);
    expect(events).toHaveLength(1);
    expect(events[0]?.outcome).toBe('failure');
    expect(events[0]?.errorCode).toBe('CONNECTION_LOST');
  });
});
