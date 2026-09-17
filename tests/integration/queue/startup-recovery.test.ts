// D-12: RED for the worker's startup sweep. `sweepAbandonedConnections` is callable independently
// of a running worker (it takes `services` and `queue`, not a `Worker`) — `worker.ts` runs it once
// before the worker starts consuming, and this suite calls it directly, matching this plan's own
// Task 2 instruction.
import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { afterEach, describe, expect, it } from 'vitest';
import type { FastifyBaseLogger } from 'fastify';
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

// A structural no-op logger — sweepAbandonedConnections only ever calls `.info`.
const silentLogger = {
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
  debug: () => undefined,
  trace: () => undefined,
  fatal: () => undefined,
} as unknown as FastifyBaseLogger;

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

async function runSweep(fx: WorkerFixture): Promise<number> {
  const { createServerServices } = await import('../../../apps/control-plane/src/services/server-services.js');
  const { sweepAbandonedConnections } = await import(
    '../../../apps/control-plane/src/queue/connect-server-worker.js'
  );
  const services = createServerServices(fx.deps);
  return sweepAbandonedConnections(services, fx.queue, silentLogger);
}

describe('worker startup sweep (D-12)', () => {
  it('resolves a CONNECTING server with no live job, attributed to the system actor', async () => {
    fixture = await startWorkerFixture();
    // The sweep is proven independently of a running worker — close the fixture's own worker so
    // nothing else consumes jobs or touches rows during this test.
    await fixture.worker.close();

    const server = await registerFixtureServer(fixture);
    await fixture.db.update(servers).set({ status: 'CONNECTING' }).where(eq(servers.id, server.id));

    const resolvedCount = await runSweep(fixture);
    expect(resolvedCount).toBe(1);

    const [row] = await fixture.db.select().from(servers).where(eq(servers.id, server.id));
    expect(row?.status).toBe('ERROR');
    expect(row?.lastErrorCode).toBe('CONNECTION_LOST');

    const activityRows = await connectionAttemptedEvents(fixture, server.id);
    const connectionAttempted = activityRows.filter((r) => r.action === 'server.connection_attempted');
    expect(connectionAttempted).toHaveLength(1);
    expect(connectionAttempted[0]?.actorType).toBe('system');
    expect(connectionAttempted[0]?.actorId).toBeNull();
    expect(connectionAttempted[0]?.metadata).toEqual({ reason: 'worker_startup_sweep' });
  });

  it('leaves alone a CONNECTING server that has a pending job in the queue', async () => {
    fixture = await startWorkerFixture();
    await fixture.worker.close();

    const server = await registerFixtureServer(fixture);
    await fixture.db.update(servers).set({ status: 'CONNECTING' }).where(eq(servers.id, server.id));

    // The fixture's own worker is closed, so this job sits in `waiting` for the whole test.
    const enqueueResult = await fixture.queue.enqueue({
      serverId: server.id,
      actor: SYSTEM,
      requestedAt: new Date().toISOString(),
      trigger: 'connect',
    });
    if (!enqueueResult.ok) throw new Error(`enqueue failed unexpectedly: ${enqueueResult.code}`);
    expect(await fixture.queue.isJobPending(server.id)).toBe(true);

    const resolvedCount = await runSweep(fixture);
    expect(resolvedCount).toBe(0);

    const [row] = await fixture.db.select().from(servers).where(eq(servers.id, server.id));
    expect(row?.status).toBe('CONNECTING');
    const activityRows = await connectionAttemptedEvents(fixture, server.id);
    expect(activityRows.filter((r) => r.action === 'server.connection_attempted')).toHaveLength(0);
  });

  it('returns 0 and touches nothing when there are no CONNECTING rows', async () => {
    fixture = await startWorkerFixture();
    await fixture.worker.close();

    const server = await registerFixtureServer(fixture);

    const resolvedCount = await runSweep(fixture);
    expect(resolvedCount).toBe(0);

    const [row] = await fixture.db.select().from(servers).where(eq(servers.id, server.id));
    expect(row?.status).toBe('PENDING');
  });
});
