// D-26/T-4-41/T-4-42: `GET /health` — Postgres/Redis/worker-heartbeat checks, individually
// time-bounded, distinguishing a dead Postgres (503) from a degraded Redis/worker (200, so an
// orchestrator never restarts the API just because the worker or Redis is down).
import { randomBytes, randomUUID } from 'node:crypto';
import { createServer, type Server, type Socket } from 'node:net';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { startPostgres, type PostgresFixture } from '../helpers/postgres.js';
import { startRedis, type RedisFixture } from '../helpers/redis.js';
import { startTestApp, type TestAppFixture } from '../helpers/app.js';

let fixture: TestAppFixture | undefined;
let redis: RedisFixture | undefined;
let standalonePostgres: PostgresFixture | undefined;
let standaloneApp: TestAppFixture['app'] | undefined;
let blackhole: { close: () => Promise<void> } | undefined;

beforeEach(() => {
  vi.resetModules();
});

afterEach(async () => {
  // Closed first: destroying the blackhole's accepted sockets before `fixture.stop()`/
  // `app.close()` run means the app's own ioredis clients never need to gracefully tear down a
  // connection this fixture is about to yank out from under them anyway.
  await blackhole?.close();
  blackhole = undefined;
  await standaloneApp?.close();
  standaloneApp = undefined;
  await fixture?.stop();
  fixture = undefined;
  await standalonePostgres?.stop();
  standalonePostgres = undefined;
  await redis?.stop();
  redis = undefined;

  const { getContainerRuntimeClient } = await import('testcontainers');
  const client = await getContainerRuntimeClient();
  const containers = await client.container.list();
  const stray = containers.filter((c) => c.Labels['noodara.test'] === 'true');
  expect(stray).toHaveLength(0);
});

interface HealthBody {
  status: 'ok' | 'degraded';
  version: string;
  checks: { postgres: 'pass' | 'fail'; redis: 'pass' | 'fail'; worker: 'pass' | 'fail' };
}

async function writeHeartbeatKey(redisUrl: string, workerId = 'test-worker'): Promise<void> {
  const { Redis } = await import('ioredis');
  const { workerHeartbeatKey } = await import('../../../apps/control-plane/src/queue/worker-heartbeat.js');
  const client = new Redis(redisUrl, { commandTimeout: 2000, maxRetriesPerRequest: 1 });
  try {
    await client.set(workerHeartbeatKey(workerId), JSON.stringify({ workerId, at: new Date().toISOString() }), 'EX', 30);
  } finally {
    client.disconnect();
  }
}

/**
 * A TCP server that accepts connections and then sends nothing — a real network hang, not a fast
 * ECONNREFUSED, so the "each check is individually time-bounded" must-have is proven against an
 * actual wedged dependency. Tracks every accepted socket and destroys it on `close()`: a plain
 * `server.close()` alone waits for every open connection to end on its own, and a client-side
 * `ioredis.disconnect()` against a connection stuck mid-handshake does not reliably tear down the
 * underlying socket fast enough to unblock that wait — destroying the server-side socket directly
 * is what actually guarantees this fixture's own cleanup can never hang the test suite.
 */
async function startBlackholeTcpServer(): Promise<{ url: string; close: () => Promise<void> }> {
  const sockets = new Set<Socket>();
  const server: Server = createServer((socket) => {
    sockets.add(socket);
    socket.on('close', () => {
      sockets.delete(socket);
    });
    socket.on('error', () => undefined);
  });
  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  if (address === null || typeof address === 'string') {
    throw new Error('startBlackholeTcpServer: failed to bind');
  }
  return {
    url: `redis://127.0.0.1:${String(address.port)}`,
    close: () =>
      new Promise<void>((resolve) => {
        for (const socket of sockets) {
          socket.destroy();
        }
        server.close(() => {
          resolve();
        });
      }),
  };
}

describe('GET /health (D-26)', () => {
  it('remains reachable with no session', async () => {
    fixture = await startTestApp();
    const response = await fixture.app.inject({ method: 'GET', url: '/health' });
    expect(response.statusCode).not.toBe(401);
  });

  it('with Postgres, Redis and a live worker heartbeat, returns 200 with all three checks pass', async () => {
    redis = await startRedis();
    fixture = await startTestApp({ redisUrl: redis.connectionUrl });
    await writeHeartbeatKey(redis.connectionUrl);

    const response = await fixture.app.inject({ method: 'GET', url: '/health' });

    expect(response.statusCode).toBe(200);
    const body = response.json() as HealthBody;
    expect(body.status).toBe('ok');
    expect(body.checks).toStrictEqual({ postgres: 'pass', redis: 'pass', worker: 'pass' });
    expect(typeof body.version).toBe('string');
  });

  it('with no worker heartbeat key present, returns 200 degraded with checks.worker fail', async () => {
    redis = await startRedis();
    fixture = await startTestApp({ redisUrl: redis.connectionUrl });
    // Deliberately no writeHeartbeatKey call.

    const response = await fixture.app.inject({ method: 'GET', url: '/health' });

    expect(response.statusCode).toBe(200);
    const body = response.json() as HealthBody;
    expect(body.status).toBe('degraded');
    expect(body.checks.worker).toBe('fail');
    expect(body.checks.postgres).toBe('pass');
  });

  it('with Redis unreachable, returns 200 degraded with checks.redis and checks.worker fail', async () => {
    redis = await startRedis();
    fixture = await startTestApp({ redisUrl: redis.connectionUrl });
    await writeHeartbeatKey(redis.connectionUrl);
    await redis.stop();

    const response = await fixture.app.inject({ method: 'GET', url: '/health' });

    expect(response.statusCode).toBe(200);
    const body = response.json() as HealthBody;
    expect(body.status).toBe('degraded');
    expect(body.checks.redis).toBe('fail');
    expect(body.checks.worker).toBe('fail');
    expect(body.checks.postgres).toBe('pass');
  });

  // Its own fixture (never sharing `fixture`/`redis`/`standalonePostgres`) so killing Postgres
  // here can never poison a later test's afterEach cleanup.
  it('with Postgres unreachable, returns 503 with checks.postgres fail', async () => {
    standalonePostgres = await startPostgres();
    process.env.NOODARA_MASTER_KEY = randomBytes(32).toString('base64');
    process.env.BETTER_AUTH_SECRET = `test-fixture-${randomUUID()}-${randomUUID()}`;
    process.env.DATABASE_URL = standalonePostgres.connectionString;
    process.env.REDIS_URL = 'redis://localhost:6379';
    process.env.NOODARA_PUBLIC_URL = 'http://localhost:3000';

    const { buildApp } = await import('../../../apps/control-plane/src/app.js');
    standaloneApp = buildApp();

    await standalonePostgres.stop();

    const response = await standaloneApp.inject({ method: 'GET', url: '/health' });

    expect(response.statusCode).toBe(503);
    const body = response.json() as HealthBody;
    expect(body.checks.postgres).toBe('fail');
  });

  it('responds within a couple of seconds even when Redis is genuinely hanging, not merely refused', async () => {
    blackhole = await startBlackholeTcpServer();
    fixture = await startTestApp({ redisUrl: blackhole.url });
    // `app.ready()` itself races the SSE broadcaster's own bounded subscribe (2s, D-27) — awaited
    // here first so the timer below measures only the /health request itself, never app boot.
    await fixture.app.ready();

    const startedAt = Date.now();
    const response = await fixture.app.inject({ method: 'GET', url: '/health' });
    const elapsedMs = Date.now() - startedAt;

    expect(elapsedMs).toBeLessThan(3500);
    expect(response.statusCode).toBe(200);
    const body = response.json() as HealthBody;
    expect(body.status).toBe('degraded');
    expect(body.checks.postgres).toBe('pass');
  });
});
