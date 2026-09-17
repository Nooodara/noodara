// D-12/T-4-29: RED for stalled-job recovery. This suite is the empirical gate on RESEARCH's
// Assumption A3 (`maxStalledCount: 0` plus a `stalled` listener really does prevent
// reprocessing) — see this plan's SUMMARY for the "Measured, not assumed" record of what BullMQ
// actually did when this suite first ran green.
//
// A worker that takes a `connect-server` job and dies mid-`connectAndDiscover` (its SSH `connect`
// call hangs forever, then its Redis connection is hard-disconnected — simulating a crash, never
// a graceful `worker.close()`) must be recovered by a second worker sharing the same queue: the
// server row ends `ERROR`/`CONNECTION_LOST`, `connectAndDiscover` is never invoked a second time
// (exactly one SSH `connect` call total), and exactly one additional `server.connection_attempted`
// failure event plus one additional `server.updated` publish result from the recovery.
import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { afterEach, describe, expect, it } from 'vitest';
import type { ConnectOutcome, SshPort } from '@noodara/ssh';
import { activityEvents, servers } from '../../../apps/control-plane/src/db/schema/index.js';
import { assertNoStrayTestContainers } from '../helpers/ssh.js';
import { startWorkerFixture, type WorkerFixture } from '../helpers/worker-fixture.js';

let fixture: WorkerFixture | undefined;

afterEach(async () => {
  await fixture?.stop();
  fixture = undefined;

  // noodara-tdd skill §5: no stray container labelled noodara.test=true survives a run.
  await assertNoStrayTestContainers();
});

type FixtureActor = { readonly type: 'user'; readonly id: string } | { readonly type: 'system' };
const SYSTEM: FixtureActor = { type: 'system' };

// Small enough that a stall is detectable inside a normal test timeout, per this plan's own
// instruction (1-2s range).
const LOCK_DURATION_MS = 1500;
const STALLED_INTERVAL_MS = 500;

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

async function connectionAttemptedEvents(fx: WorkerFixture, serverId: string) {
  return fx.db
    .select()
    .from(activityEvents)
    .where(eq(activityEvents.entityId, serverId));
}

/** An `SshPort` whose `connect` never resolves nor rejects — simulates a worker that grabbed the
 *  job and is genuinely stuck mid-SSH-session, counting every `connect` call it ever received so
 *  the test can assert "exactly one attempt total" across the whole stalled-and-recovered
 *  sequence. */
function buildHangingSshPort(): SshPort & { readonly callCount: () => number } {
  let calls = 0;
  return {
    connect(): Promise<ConnectOutcome> {
      calls += 1;
      return new Promise(() => {
        // Deliberately never settles.
      });
    },
    callCount: () => calls,
  };
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

describe('stalled connect-server job recovery (D-12)', () => {
  it('recovers to ERROR/CONNECTION_LOST with exactly one SSH connect call and one additional activity/publish', async () => {
    fixture = await startWorkerFixture({
      lockDurationMs: LOCK_DURATION_MS,
      stalledIntervalMs: STALLED_INTERVAL_MS,
    });
    const server = await registerFixtureServer(fixture);

    const hangingSsh = buildHangingSshPort();
    fixture.setSshPort(hangingSsh);

    const eventsBefore = fixture.events.length;
    const enqueueResult = await fixture.queue.enqueue({
      serverId: server.id,
      actor: SYSTEM,
      requestedAt: new Date().toISOString(),
      trigger: 'connect',
    });
    if (!enqueueResult.ok) throw new Error(`enqueue failed unexpectedly: ${enqueueResult.code}`);

    // Wait until the primary worker has actually started the job: TX1 committed CONNECTING and
    // the (hanging) SSH connect call is in flight.
    await waitUntil(async () => {
      const [row] = await fixture!.db.select().from(servers).where(eq(servers.id, server.id));
      return row?.status === 'CONNECTING';
    }, 10_000);
    expect(hangingSsh.callCount()).toBe(1);

    // Simulate the primary worker crashing: no graceful worker.close(), just a hard disconnect —
    // lock renewal stops the instant this fires.
    await fixture.killPrimaryWorker();

    // A second worker, sharing the same queue/deps, is the one whose own stalledInterval check
    // detects the abandoned lock and recovers it.
    const secondWorker = await fixture.spawnWorker({
      lockDurationMs: LOCK_DURATION_MS,
      stalledIntervalMs: STALLED_INTERVAL_MS,
    });

    try {
      const row = await waitUntil(async () => {
        const [current] = await fixture!.db.select().from(servers).where(eq(servers.id, server.id));
        return current?.status === 'ERROR' ? current : undefined;
      }, 20_000);

      expect(row.status).toBe('ERROR');
      expect(row.lastErrorCode).toBe('CONNECTION_LOST');

      // The load-bearing assertion: recovery never re-ran connectAndDiscover, so the hanging
      // SshPort was never called a second time.
      expect(hangingSsh.callCount()).toBe(1);

      const activityRows = await connectionAttemptedEvents(fixture, server.id);
      const connectionAttempted = activityRows.filter(
        (row_) => row_.action === 'server.connection_attempted',
      );
      expect(connectionAttempted).toHaveLength(1);
      expect(connectionAttempted[0]?.outcome).toBe('failure');
      expect(connectionAttempted[0]?.errorCode).toBe('CONNECTION_LOST');

      const published = fixture.events.slice(eventsBefore);
      expect(published).toHaveLength(2);
      expect(published[0]).toMatchObject({ type: 'server.updated', server: { status: 'CONNECTING' } });
      expect(published[1]).toMatchObject({
        type: 'server.updated',
        server: { status: 'ERROR', lastErrorCode: 'CONNECTION_LOST' },
      });
    } finally {
      await secondWorker.close();
    }
  });
});
