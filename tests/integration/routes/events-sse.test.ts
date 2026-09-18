// D-01/D-02/D-05/D-06/D-07/D-25/D-27/SERV-06: `GET /api/events`, its guards, and the shutdown
// hooks that make it all closable. Every stream is read via `app.inject({ payloadAsStream: true })`
// + `response.stream()` — never a plain `await app.inject(...)`, which would hang forever on a
// response that never ends by design (RESEARCH Pitfall 4).
import { randomBytes, randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import parseSetCookie from 'set-cookie-parser';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SshPort } from '@noodara/ssh';
import { revealSecret } from '@noodara/domain/security';
import { SERVER_EVENTS_CHANNEL } from '../../../apps/control-plane/src/events/redis-server-event-publisher.js';
import { issueToken } from '../../../apps/control-plane/src/services/setup-token-repository.js';
import { startPostgres, type PostgresFixture } from '../helpers/postgres.js';
import { startRedis, type RedisFixture } from '../helpers/redis.js';
import { startTestApp, type TestAppFixture } from '../helpers/app.js';
import { buildFakeSshPort } from '../services/helpers/service-fixture.js';

const ADMIN_EMAIL = 'admin@noodara.test';
const ADMIN_PASSWORD = 'correct horse battery staple';

const noopLogger = {
  warn: () => undefined,
  error: () => undefined,
  info: () => undefined,
  debug: () => undefined,
  trace: () => undefined,
  fatal: () => undefined,
};

let fixture: TestAppFixture | undefined;
let redis: RedisFixture | undefined;
let standalonePostgres: PostgresFixture | undefined;
let stopWorker: (() => Promise<void>) | undefined;

beforeEach(() => {
  vi.resetModules();
});

afterEach(async () => {
  // The SSE_LIMIT_REACHED test sets this directly on process.env (vi.resetModules() does not
  // touch process.env) — cleared unconditionally so a later test in this file never inherits it.
  delete process.env.NOODARA_SSE_MAX_CONNECTIONS;

  await stopWorker?.();
  stopWorker = undefined;
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

function uniqueName(suffix: string): string {
  return `srv-${suffix}-${randomUUID().replace(/-/g, '').slice(0, 12)}`;
}

function uniqueHost(): string {
  return `${randomUUID().replace(/-/g, '').slice(0, 12)}.example.test`;
}

async function createAdmin(app: FastifyInstance, db: TestAppFixture['db']): Promise<void> {
  const issued = await issueToken(db, 'setup', new Date());
  const response = await app.inject({
    method: 'POST',
    url: '/api/setup',
    payload: { token: revealSecret(issued.token), email: ADMIN_EMAIL, password: ADMIN_PASSWORD, name: 'Admin' },
  });
  if (response.statusCode !== 200) {
    throw new Error(`setup failed: ${response.statusCode.toString()} ${response.body}`);
  }
}

function cookieHeaderFrom(response: { headers: Record<string, unknown> }): string {
  const raw = response.headers['set-cookie'];
  const rawCookies = Array.isArray(raw) ? raw : raw !== undefined ? [String(raw)] : [];
  const parsed = parseSetCookie.parse(rawCookies, { map: false });
  return parsed.map((cookie) => `${cookie.name}=${cookie.value}`).join('; ');
}

async function signIn(app: FastifyInstance): Promise<string> {
  const response = await app.inject({
    method: 'POST',
    url: '/api/auth/sign-in/email',
    payload: { email: ADMIN_EMAIL, password: ADMIN_PASSWORD },
  });
  if (response.statusCode !== 200) {
    throw new Error(`sign-in failed: ${response.statusCode.toString()} ${response.body}`);
  }
  return cookieHeaderFrom(response);
}

async function signOut(app: FastifyInstance, cookie: string): Promise<void> {
  const response = await app.inject({
    method: 'POST',
    url: '/api/auth/sign-out',
    headers: { cookie },
  });
  if (response.statusCode !== 200) {
    throw new Error(`sign-out failed: ${response.statusCode.toString()} ${response.body}`);
  }
}

async function createServer(app: FastifyInstance, cookie: string, name = uniqueName('s')): Promise<string> {
  const response = await app.inject({
    method: 'POST',
    url: '/api/servers',
    headers: { cookie },
    payload: {
      name,
      host: uniqueHost(),
      credential: { type: 'ssh_password', password: 'hunter2-test-password' },
    },
  });
  const body = response.json() as { id: string };
  return body.id;
}

/** Mirrors `tests/integration/helpers/app.ts`'s own `startTestApp()` internals, but calls
 *  `buildApp()` directly so `sseHeartbeatMs` can be injected — `startTestApp()` itself has no such
 *  option (Plan 04-09's own files-modified list does not touch that shared helper). */
async function startAppWithHeartbeat(redisUrl: string, sseHeartbeatMs?: number): Promise<TestAppFixture> {
  const postgres = await startPostgres();
  process.env.NOODARA_MASTER_KEY = randomBytes(32).toString('base64');
  process.env.BETTER_AUTH_SECRET = `test-fixture-${randomUUID()}-${randomUUID()}`;
  process.env.DATABASE_URL = postgres.connectionString;
  process.env.REDIS_URL = redisUrl;
  process.env.NOODARA_PUBLIC_URL = 'http://localhost:3000';

  const { buildApp } = await import('../../../apps/control-plane/src/app.js');
  const app = buildApp(sseHeartbeatMs !== undefined ? { sseHeartbeatMs } : {});

  let stopped = false;
  const stop = async (): Promise<void> => {
    if (stopped) return;
    stopped = true;
    await app.close();
    await postgres.stop();
  };

  return { app, db: postgres.db, stop };
}

/** Starts a real, in-process BullMQ worker against the *same* Postgres/Redis the app under test
 *  uses, wired to a Redis-backed `ServerEventPublisher` on the same channel the app's broadcaster
 *  subscribes to — this is what makes `connectAndDiscover`'s two publish sites (Plan 04-03) reach
 *  the SSE stream under test, exactly like a real worker process would. */
async function startTestWorker(db: TestAppFixture['db'], redisUrl: string, ssh: SshPort): Promise<() => Promise<void>> {
  const { resolveServerServicesDeps } = await import(
    '../../../apps/control-plane/src/services/server-service-deps.js'
  );
  const { createRedisServerEventPublisher } = await import(
    '../../../apps/control-plane/src/events/redis-server-event-publisher.js'
  );
  const { createPublisherRedisConnection, createQueueRedisConnection, createWorkerRedisConnection } = await import(
    '../../../apps/control-plane/src/redis/connections.js'
  );
  const { createConnectServerQueue } = await import('../../../apps/control-plane/src/queue/connect-server-queue.js');
  const { createWorker } = await import('../../../apps/control-plane/src/queue/connect-server-worker.js');

  const publisherConnection = createPublisherRedisConnection(redisUrl);
  const eventPublisher = createRedisServerEventPublisher(publisherConnection, noopLogger as never);
  const deps = await resolveServerServicesDeps({ db, ssh, events: eventPublisher });

  const workerConnection = createWorkerRedisConnection(redisUrl);
  const queueConnection = createQueueRedisConnection(redisUrl);
  const queue = createConnectServerQueue({ connection: queueConnection });

  const handle = createWorker(deps, {
    connection: workerConnection,
    queue,
    logger: noopLogger as never,
    concurrency: 5,
    lockDurationMs: 10_000,
    stalledIntervalMs: 10_000,
  });

  return async () => {
    await handle.close();
    await queue.close();
    workerConnection.disconnect();
    queueConnection.disconnect();
    publisherConnection.disconnect();
  };
}

/**
 * Polls Redis's own `PUBSUB NUMSUB` until at least one client is subscribed to
 * `noodara:server-events`, or `timeoutMs` elapses. The app's `onReady` hook bounds its own
 * *initial* subscribe attempt to ~2s so an unreachable Redis never blocks boot (D-27) — but on a
 * contended dev machine, a *reachable-but-slow* Redis can genuinely take longer than that to
 * finish the real `SUBSCRIBE`, which keeps running in the background regardless of the bound.
 * A test that publishes before that real subscription lands would see its message silently
 * dropped (pub/sub has no persistence, by design — D-05) for a reason that has nothing to do with
 * the behavior under test. Polling this first is the correct fix, not a longer fixed sleep.
 */
async function waitForActiveSubscriber(redisUrl: string, timeoutMs = 20_000): Promise<void> {
  const { Redis } = await import('ioredis');
  const probe = new Redis(redisUrl, { commandTimeout: 2000, maxRetriesPerRequest: 1 });
  probe.on('error', () => undefined); // this probe's own transient errors are not the test's concern
  try {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      try {
        const counts = (await probe.call('PUBSUB', 'NUMSUB', SERVER_EVENTS_CHANNEL)) as [string, number];
        if (Number(counts[1]) > 0) return;
      } catch {
        // A transient probe-side error (e.g. this shared machine's own Docker/network flakiness,
        // see SUMMARY "Issues Encountered") is not itself proof of "no subscriber" — retry until
        // the deadline rather than failing on the first hiccup.
      }
      if (Date.now() > deadline) {
        throw new Error(`waitForActiveSubscriber: no subscriber on ${SERVER_EVENTS_CHANNEL} after ${timeoutMs}ms`);
      }
      await new Promise((resolve) => {
        setTimeout(resolve, 100);
      });
    }
  } finally {
    probe.disconnect();
  }
}

interface OpenStream {
  readonly statusCode: number;
  readonly headers: Record<string, unknown>;
  /** Reads the next raw SSE frame (everything up to and including its trailing blank line).
   *  Buffers and re-splits on `\n\n` internally — a single `write()` call on the server side is
   *  *not* guaranteed to arrive as exactly one Node `'data'` event (two frames written in quick
   *  succession can coalesce into one chunk, and a large frame can split across several), so
   *  framing must never assume a 1:1 mapping between `write()` calls and `'data'` events. */
  readFrame(): Promise<string>;
  /** Resolves once the underlying readable ends or closes — how a test observes the server
   *  ending the response itself (D-06's revocation close, D-25's `app.close()`). */
  waitForClose(timeoutMs?: number): Promise<boolean>;
  destroy(): void;
}

const SSE_FRAME_DELIMITER = '\n\n';

/** `app.inject({ payloadAsStream: true })` resolves as soon as headers are available — the
 *  response itself never ends, so a plain `await app.inject(...)` would hang forever
 *  (RESEARCH Pitfall 4). `readFrame()` lets a test pull one SSE frame at a time, in arrival
 *  order, regardless of how the underlying bytes were chunked into `'data'` events. */
async function openEventStream(app: FastifyInstance, cookie?: string): Promise<OpenStream> {
  const response = await app.inject({
    method: 'GET',
    url: '/api/events',
    headers: cookie !== undefined ? { cookie } : {},
    payloadAsStream: true,
  });

  const stream = response.stream();
  let buffer = '';
  const queuedFrames: string[] = [];
  const waiters: ((frame: string) => void)[] = [];

  function drainBuffer(): void {
    for (;;) {
      const delimiterIndex = buffer.indexOf(SSE_FRAME_DELIMITER);
      if (delimiterIndex === -1) return;
      const frame = buffer.slice(0, delimiterIndex + SSE_FRAME_DELIMITER.length);
      buffer = buffer.slice(delimiterIndex + SSE_FRAME_DELIMITER.length);
      const waiter = waiters.shift();
      if (waiter) {
        waiter(frame);
      } else {
        queuedFrames.push(frame);
      }
    }
  }

  stream.on('data', (chunk: Buffer) => {
    buffer += chunk.toString('utf8');
    drainBuffer();
  });

  const readFrame = (): Promise<string> => {
    const next = queuedFrames.shift();
    if (next !== undefined) return Promise.resolve(next);
    return new Promise((resolve) => {
      waiters.push(resolve);
    });
  };

  let closed = false;
  stream.once('end', () => {
    closed = true;
  });
  stream.once('close', () => {
    closed = true;
  });

  const waitForClose = (timeoutMs = 2000): Promise<boolean> => {
    if (closed) return Promise.resolve(true);
    return new Promise((resolve) => {
      const onClosed = (): void => {
        clearTimeout(timer);
        resolve(true);
      };
      const timer = setTimeout(() => {
        stream.off('end', onClosed);
        stream.off('close', onClosed);
        resolve(closed);
      }, timeoutMs);
      stream.once('end', onClosed);
      stream.once('close', onClosed);
    });
  };

  return {
    statusCode: response.statusCode,
    headers: response.headers,
    readFrame,
    waitForClose,
    destroy: () => {
      stream.destroy();
    },
  };
}

async function bootAuthenticated(sseHeartbeatMs?: number): Promise<{ app: FastifyInstance; cookie: string }> {
  redis = await startRedis();
  fixture = await startAppWithHeartbeat(redis.connectionUrl, sseHeartbeatMs);
  await createAdmin(fixture.app, fixture.db);
  const cookie = await signIn(fixture.app);
  return { app: fixture.app, cookie };
}

describe('GET /api/events (D-01, D-05, D-06, D-07, D-25, D-27, SERV-06)', () => {
  it('an anonymous request returns 401 and no stream is opened', async () => {
    redis = await startRedis();
    fixture = await startAppWithHeartbeat(redis.connectionUrl);

    const response = await fixture.app.inject({ method: 'GET', url: '/api/events' });

    expect(response.statusCode).toBe(401);
    expect(response.json()).toStrictEqual({ error: 'UNAUTHORIZED', message: expect.any(String) });
  });

  it('an authenticated request opens a stream whose first chunk contains retry: 5000', async () => {
    const { app, cookie } = await bootAuthenticated();

    const stream = await openEventStream(app, cookie);
    expect(stream.statusCode).toBe(200);
    expect(stream.headers['content-type']).toBe('text/event-stream');
    expect(stream.headers['cache-control']).toBe('no-cache');

    const firstChunk = await stream.readFrame();
    expect(firstChunk).toContain('retry: 5000');

    stream.destroy();
  });

  it('a server.updated publish delivers a frame whose data.server key set is exactly the 27 ServerView keys', async () => {
    const { app, cookie } = await bootAuthenticated();

    // Every dynamic `import()` resolved *before* opening the stream: the heartbeat interval below
    // starts ticking the instant the stream opens, and after `vi.resetModules()` a cold dynamic
    // import of a large module graph (drizzle/ioredis/etc.) can itself take several seconds —
    // resolving these first keeps the window between "stream open" and "publish" to a single fast
    // network round trip, never racing the (still real, 15s-default) heartbeat.
    const { SERVER_VIEW_KEYS } = await import('../../../apps/control-plane/src/services/server-view.js');
    const { createRedisServerEventPublisher } = await import(
      '../../../apps/control-plane/src/events/redis-server-event-publisher.js'
    );
    const { createPublisherRedisConnection } = await import('../../../apps/control-plane/src/redis/connections.js');
    if (!redis) throw new Error('redis fixture not set');
    const publisherConnection = createPublisherRedisConnection(redis.connectionUrl);
    const publisher = createRedisServerEventPublisher(publisherConnection, noopLogger as never);

    const stream = await openEventStream(app, cookie);
    await stream.readFrame(); // retry: 5000
    await waitForActiveSubscriber(redis.connectionUrl);

    const server = Object.fromEntries(SERVER_VIEW_KEYS.map((key) => [key, null])) as never;
    await publisher.publish({ type: 'server.updated', server });
    publisherConnection.disconnect();

    const frame = await stream.readFrame();
    expect(frame.startsWith('event: server.updated\n')).toBe(true);
    const dataLine = frame.split('\n').find((line) => line.startsWith('data: '));
    const parsed = JSON.parse((dataLine ?? '').slice('data: '.length)) as { server: Record<string, unknown> };
    expect(Object.keys(parsed.server).sort()).toStrictEqual([...SERVER_VIEW_KEYS].sort());

    stream.destroy();
  });

  it('a server.deleted publish delivers a frame with data.id', async () => {
    const { app, cookie } = await bootAuthenticated();

    const { createRedisServerEventPublisher } = await import(
      '../../../apps/control-plane/src/events/redis-server-event-publisher.js'
    );
    const { createPublisherRedisConnection } = await import('../../../apps/control-plane/src/redis/connections.js');
    if (!redis) throw new Error('redis fixture not set');
    const publisherConnection = createPublisherRedisConnection(redis.connectionUrl);
    const publisher = createRedisServerEventPublisher(publisherConnection, noopLogger as never);

    const stream = await openEventStream(app, cookie);
    await stream.readFrame(); // retry: 5000
    await waitForActiveSubscriber(redis.connectionUrl);

    await publisher.publish({ type: 'server.deleted', id: 'deleted-id-123' });
    publisherConnection.disconnect();

    const frame = await stream.readFrame();
    expect(frame.startsWith('event: server.deleted\n')).toBe(true);
    const dataLine = frame.split('\n').find((line) => line.startsWith('data: '));
    const parsed = JSON.parse((dataLine ?? '').slice('data: '.length)) as { id: string };
    expect(parsed.id).toBe('deleted-id-123');

    stream.destroy();
  });

  it(
    'a real connect POST plus the in-process worker delivers a CONNECTING frame and a later ' +
      'terminal-status frame on one open stream, with no intervening GET',
    async () => {
      const { app, cookie } = await bootAuthenticated();
      const serverId = await createServer(app, cookie);
      if (!fixture || !redis) throw new Error('fixture not set');

      // Started before the stream opens — `startTestWorker`'s several dynamic imports must not
      // eat into the (real, 15s-default) heartbeat window the way an import after stream-open
      // would.
      stopWorker = await startTestWorker(
        fixture.db,
        redis.connectionUrl,
        buildFakeSshPort({ ok: false, errorCode: 'AUTH_FAILED', message: 'bad credentials', attempts: 1 }),
      );

      const stream = await openEventStream(app, cookie);
      await stream.readFrame(); // retry: 5000
      await waitForActiveSubscriber(redis.connectionUrl);

      const connectResponse = await app.inject({
        method: 'POST',
        url: `/api/servers/${serverId}/connect`,
        headers: { cookie },
      });
      expect(connectResponse.statusCode).toBe(202);

      const firstFrame = await stream.readFrame();
      expect(firstFrame.startsWith('event: server.updated\n')).toBe(true);
      const firstData = JSON.parse(
        (firstFrame.split('\n').find((l) => l.startsWith('data: ')) ?? '').slice('data: '.length),
      ) as { server: { id: string; status: string } };
      expect(firstData.server.id).toBe(serverId);
      expect(firstData.server.status).toBe('CONNECTING');

      const secondFrame = await stream.readFrame();
      const secondData = JSON.parse(
        (secondFrame.split('\n').find((l) => l.startsWith('data: ')) ?? '').slice('data: '.length),
      ) as { server: { id: string; status: string } };
      expect(secondData.server.id).toBe(serverId);
      expect(secondData.server.status).not.toBe('CONNECTING');
      expect(secondData.server.status).not.toBe('PENDING');

      stream.destroy();
    },
  );

  it('with a small heartbeat interval, a : keepalive comment line arrives', async () => {
    const { app, cookie } = await bootAuthenticated(200);
    const stream = await openEventStream(app, cookie);
    await stream.readFrame(); // retry: 5000

    const keepalive = await stream.readFrame();
    expect(keepalive).toBe(': keepalive\n\n');

    stream.destroy();
  });

  it('closes the stream within two heartbeat intervals after the session is revoked', async () => {
    const { app, cookie } = await bootAuthenticated(200);
    const stream = await openEventStream(app, cookie);
    await stream.readFrame(); // retry: 5000

    await signOut(app, cookie);

    // D-06: the next heartbeat re-resolves the (now revoked) session and ends the raw response —
    // observed here as the readable stream itself ending, well within two 200ms intervals.
    const closedWithinBudget = await stream.waitForClose(1000);
    expect(closedWithinBudget).toBe(true);
  });

  it('with NOODARA_SSE_MAX_CONNECTIONS exceeded, returns 503 SSE_LIMIT_REACHED with Retry-After', async () => {
    process.env.NOODARA_SSE_MAX_CONNECTIONS = '1';
    redis = await startRedis();
    fixture = await startTestApp({ redisUrl: redis.connectionUrl });
    await createAdmin(fixture.app, fixture.db);
    const cookie = await signIn(fixture.app);

    const first = await openEventStream(fixture.app, cookie);
    await first.readFrame(); // retry: 5000 — the one connection under the limit

    const second = await fixture.app.inject({
      method: 'GET',
      url: '/api/events',
      headers: { cookie },
    });

    expect(second.statusCode).toBe(503);
    expect(second.headers['retry-after']).toBe('5');
    expect(second.json()).toStrictEqual({ error: 'SSE_LIMIT_REACHED', message: expect.any(String) });

    first.destroy();
  });

  it('app.close() resolves in under 5000ms with a stream still open', async () => {
    const { app, cookie } = await bootAuthenticated();
    const stream = await openEventStream(app, cookie);
    await stream.readFrame(); // retry: 5000

    if (!fixture) throw new Error('fixture not set');
    const startedAt = Date.now();
    await fixture.app.close();
    const elapsedMs = Date.now() - startedAt;

    expect(elapsedMs).toBeLessThan(5000);
    stream.destroy();
    // Deliberately does NOT null `fixture` here: `startAppWithHeartbeat`'s own `stop()` closure
    // still needs to run in `afterEach` to stop the underlying Postgres container — Fastify's own
    // `close()` is itself safe to call a second time (it resolves immediately once already
    // closed), but there is no second chance to stop Postgres if `fixture` is discarded here.
  });

  it('with Redis unreachable at app build time, the stream still opens (200) and still heartbeats', async () => {
    standalonePostgres = await startPostgres();
    process.env.NOODARA_MASTER_KEY = randomBytes(32).toString('base64');
    process.env.BETTER_AUTH_SECRET = `test-fixture-${randomUUID()}-${randomUUID()}`;
    process.env.DATABASE_URL = standalonePostgres.connectionString;
    process.env.REDIS_URL = 'redis://localhost:6379'; // unreachable placeholder — no fixture started
    process.env.NOODARA_PUBLIC_URL = 'http://localhost:3000';

    const { buildApp } = await import('../../../apps/control-plane/src/app.js');
    const app = buildApp({ sseHeartbeatMs: 200 });

    await createAdmin(app, standalonePostgres.db);
    const cookie = await signIn(app);

    const stream = await openEventStream(app, cookie);
    expect(stream.statusCode).toBe(200);

    const firstChunk = await stream.readFrame();
    expect(firstChunk).toContain('retry: 5000');
    const keepalive = await stream.readFrame();
    expect(keepalive).toBe(': keepalive\n\n');

    stream.destroy();
    await app.close();
  });
});
