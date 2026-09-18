// D-09/D-27/D-28: RED for the queue producer. Every expectation below fails today for the same
// reason — apps/control-plane/src/redis/connections.ts and
// apps/control-plane/src/queue/connect-server-queue.ts do not exist yet.
//
// Proves: dedupe by deterministic jobId (D-09 first layer), a hard ~2s bound with no thrown
// exception when Redis is unreachable (D-27), the noodara key prefix (D-28), and that the stored
// job.data round-trips through parseConnectServerJobPayload cleanly.
import { randomUUID } from 'node:crypto';
import Redis from 'ioredis';
import { afterEach, describe, expect, it } from 'vitest';
import { parseConnectServerJobPayload, type ConnectServerJobPayload } from '../../../apps/control-plane/src/queue/job-payload.js';
import { assertNoStrayTestContainers } from '../helpers/ssh.js';
import { startRedis, type RedisFixture } from '../helpers/redis.js';

async function loadConnections() {
  return import('../../../apps/control-plane/src/redis/connections.js');
}

async function loadConnectServerQueue() {
  return import('../../../apps/control-plane/src/queue/connect-server-queue.js');
}

let fixture: RedisFixture | undefined;
let extraConnections: Redis[] = [];

afterEach(async () => {
  for (const conn of extraConnections) {
    conn.disconnect();
  }
  extraConnections = [];

  await fixture?.stop();
  fixture = undefined;

  await assertNoStrayTestContainers();
});

function buildPayload(serverId: string): ConnectServerJobPayload {
  return {
    serverId,
    actor: { type: 'system' },
    requestedAt: new Date().toISOString(),
    trigger: 'connect',
  };
}

describe('connect-server-queue', () => {
  it('enqueues a fresh server and returns the deterministic jobId', async () => {
    fixture = await startRedis();
    const { createQueueRedisConnection } = await loadConnections();
    const { createConnectServerQueue } = await loadConnectServerQueue();

    const connection = createQueueRedisConnection(fixture.connectionUrl);
    extraConnections.push(connection);
    const queue = createConnectServerQueue({ connection });

    try {
      const serverId = randomUUID();
      const result = await queue.enqueue(buildPayload(serverId));

      expect(result).toEqual({ ok: true, jobId: `connect-${serverId}` });
    } finally {
      await queue.close();
    }
  });

  it('dedupes two enqueues for the same server while the job is still waiting (D-09)', async () => {
    fixture = await startRedis();
    const { createQueueRedisConnection } = await loadConnections();
    const { createConnectServerQueue } = await loadConnectServerQueue();

    const connection = createQueueRedisConnection(fixture.connectionUrl);
    extraConnections.push(connection);
    const queue = createConnectServerQueue({ connection });

    try {
      const serverId = randomUUID();
      const first = await queue.enqueue(buildPayload(serverId));
      const second = await queue.enqueue(buildPayload(serverId));

      expect(first.ok).toBe(true);
      expect(second.ok).toBe(true);
      if (!first.ok || !second.ok) throw new Error('expected both enqueues to succeed');
      expect(second.jobId).toBe(first.jobId);

      const bullmq = await import('bullmq');
      const rawQueue = new bullmq.Queue('servers', { connection, prefix: 'noodara' });
      const waitingJobs = await rawQueue.getJobs(['waiting', 'active', 'delayed']);
      await rawQueue.close();
      expect(waitingJobs.length).toBe(1);
    } finally {
      await queue.close();
    }
  });

  it('allows a new enqueue for the same server once the prior job is removed', async () => {
    fixture = await startRedis();
    const { createQueueRedisConnection } = await loadConnections();
    const { createConnectServerQueue } = await loadConnectServerQueue();

    const connection = createQueueRedisConnection(fixture.connectionUrl);
    extraConnections.push(connection);
    const queue = createConnectServerQueue({ connection });

    try {
      const serverId = randomUUID();
      await queue.enqueue(buildPayload(serverId));

      const bullmq = await import('bullmq');
      const rawQueue = new bullmq.Queue('servers', { connection, prefix: 'noodara' });
      const job = await rawQueue.getJob(`connect-${serverId}`);
      await job?.remove();
      await rawQueue.close();

      const second = await queue.enqueue(buildPayload(serverId));

      expect(second).toEqual({ ok: true, jobId: `connect-${serverId}` });
    } finally {
      await queue.close();
    }
  });

  // Plan 04-11's own real-worker E2E test found this: BullMQ's `add()` treats *any* existing job
  // hash under a jobId as a duplicate and returns the stale reference without ever creating a new
  // "waiting" entry — including a job that has already reached `completed` and is only still
  // present because `removeOnComplete: { count: 100 }` keeps it around for observability. Without
  // handling this, every `/connect` or `/discover` call issued after the very first job for a
  // server ever finishes would 202 with a jobId the worker never touches again, silently breaking
  // DISC-05 ("re-run discovery") the moment a server has connected even once.
  it('allows a fresh enqueue once the prior job has genuinely COMPLETED (not just been manually removed)', async () => {
    fixture = await startRedis();
    const { createQueueRedisConnection, createWorkerRedisConnection } = await loadConnections();
    const { createConnectServerQueue } = await loadConnectServerQueue();

    const connection = createQueueRedisConnection(fixture.connectionUrl);
    extraConnections.push(connection);
    const queue = createConnectServerQueue({ connection });

    try {
      const serverId = randomUUID();
      const first = await queue.enqueue(buildPayload(serverId));
      expect(first.ok).toBe(true);

      const bullmq = await import('bullmq');
      const workerConnection = createWorkerRedisConnection(fixture.connectionUrl);
      extraConnections.push(workerConnection);
      const worker = new bullmq.Worker('servers', () => Promise.resolve({ outcome: 'ok' }), {
        connection: workerConnection,
        prefix: 'noodara',
      });
      try {
        await new Promise<void>((resolve, reject) => {
          worker.on('completed', () => {
            resolve();
          });
          worker.on('failed', (_job, err: unknown) => {
            reject(err instanceof Error ? err : new Error(String(err)));
          });
        });
      } finally {
        await worker.close();
      }

      // The prior job for this server has now genuinely completed — its jobId hash still exists
      // in Redis (removeOnComplete's count-based retention), which is exactly the condition that
      // previously made a second enqueue a silent no-op.
      const second = await queue.enqueue(buildPayload(serverId));
      expect(second).toEqual({ ok: true, jobId: `connect-${serverId}` });
      expect(await queue.isJobPending(serverId)).toBe(true);
    } finally {
      await queue.close();
    }
  });

  it('creates a job with attempts 1, removeOnComplete 100, removeOnFail 500 and name connect-server', async () => {
    fixture = await startRedis();
    const { createQueueRedisConnection } = await loadConnections();
    const { createConnectServerQueue } = await loadConnectServerQueue();

    const connection = createQueueRedisConnection(fixture.connectionUrl);
    extraConnections.push(connection);
    const queue = createConnectServerQueue({ connection });

    try {
      const serverId = randomUUID();
      await queue.enqueue(buildPayload(serverId));

      const bullmq = await import('bullmq');
      const rawQueue = new bullmq.Queue('servers', { connection, prefix: 'noodara' });
      const job = await rawQueue.getJob(`connect-${serverId}`);
      await rawQueue.close();

      expect(job).toBeDefined();
      expect(job?.name).toBe('connect-server');
      expect(job?.opts.attempts).toBe(1);
      expect(job?.opts.removeOnComplete).toEqual({ count: 100 });
      expect(job?.opts.removeOnFail).toEqual({ count: 500 });
    } finally {
      await queue.close();
    }
  });

  it('scopes every key it creates under the noodara: prefix (D-28)', async () => {
    fixture = await startRedis();
    const { createQueueRedisConnection } = await loadConnections();
    const { createConnectServerQueue } = await loadConnectServerQueue();

    const connection = createQueueRedisConnection(fixture.connectionUrl);
    extraConnections.push(connection);
    const queue = createConnectServerQueue({ connection });

    try {
      await queue.enqueue(buildPayload(randomUUID()));

      const scanClient = new Redis(fixture.connectionUrl);
      extraConnections.push(scanClient);
      const allKeys = await scanClient.keys('*');

      expect(allKeys.length).toBeGreaterThan(0);
      for (const key of allKeys) {
        expect(key.startsWith('noodara:')).toBe(true);
      }
    } finally {
      await queue.close();
    }
  });

  it('isJobPending is true while waiting and false for a server with no job', async () => {
    fixture = await startRedis();
    const { createQueueRedisConnection } = await loadConnections();
    const { createConnectServerQueue } = await loadConnectServerQueue();

    const connection = createQueueRedisConnection(fixture.connectionUrl);
    extraConnections.push(connection);
    const queue = createConnectServerQueue({ connection });

    try {
      const serverId = randomUUID();
      expect(await queue.isJobPending(serverId)).toBe(false);

      await queue.enqueue(buildPayload(serverId));
      expect(await queue.isJobPending(serverId)).toBe(true);
    } finally {
      await queue.close();
    }
  });

  it('with Redis stopped, enqueue resolves QUEUE_UNAVAILABLE in under 3s without rejecting', async () => {
    fixture = await startRedis();
    const { createQueueRedisConnection } = await loadConnections();
    const { createConnectServerQueue } = await loadConnectServerQueue();

    const connectionUrl = fixture.connectionUrl;
    const host = new URL(connectionUrl).hostname;

    const connection = createQueueRedisConnection(connectionUrl);
    extraConnections.push(connection);
    const queue = createConnectServerQueue({ connection });

    await fixture.stop();

    const startedAt = Date.now();
    const result = await queue.enqueue(buildPayload(randomUUID()));
    const elapsedMs = Date.now() - startedAt;

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected failure');
    expect(result.code).toBe('QUEUE_UNAVAILABLE');
    expect(elapsedMs).toBeLessThan(3000);
    expect(result.message).not.toContain('6379');
    expect(result.message).not.toContain(host);
  });

  it('with Redis stopped, isJobPending resolves false rather than rejecting', async () => {
    fixture = await startRedis();
    const { createQueueRedisConnection } = await loadConnections();
    const { createConnectServerQueue } = await loadConnectServerQueue();

    const connection = createQueueRedisConnection(fixture.connectionUrl);
    extraConnections.push(connection);
    const queue = createConnectServerQueue({ connection });

    await fixture.stop();

    await expect(queue.isJobPending(randomUUID())).resolves.toBe(false);
  });

  it('the stored job.data parses cleanly through parseConnectServerJobPayload', async () => {
    fixture = await startRedis();
    const { createQueueRedisConnection } = await loadConnections();
    const { createConnectServerQueue } = await loadConnectServerQueue();

    const connection = createQueueRedisConnection(fixture.connectionUrl);
    extraConnections.push(connection);
    const queue = createConnectServerQueue({ connection });

    try {
      const serverId = randomUUID();
      const payload = buildPayload(serverId);
      await queue.enqueue(payload);

      const bullmq = await import('bullmq');
      const rawQueue = new bullmq.Queue('servers', { connection, prefix: 'noodara' });
      const job = await rawQueue.getJob(`connect-${serverId}`);
      await rawQueue.close();

      const parsed = parseConnectServerJobPayload(job?.data);
      expect(parsed).toEqual({ ok: true, payload });
    } finally {
      await queue.close();
    }
  });
});
