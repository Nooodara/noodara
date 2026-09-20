// Phase 4's headline proof (roadmap criteria 1-4, SERV-06, DISC-05): one ordered flow, driven at
// the real HTTP layer against a real Ubuntu sshd Testcontainer, a real Redis, a real in-process
// BullMQ worker and a genuinely open SSE socket — never a fake SshPort, never `app.inject()` for
// the stream. `tests/integration/activity/canary-full-flow.test.ts` proves the same shape at the
// service layer (Phase 3); this file proves it again at the HTTP/queue/worker/SSE layer this phase
// adds, exactly once, end to end.
//
// `app.listen({ port: 0 })` + a real `fetch()` client is used for every request in this file (not
// just the SSE stream): D-31 allows either `app.inject`'s stream mode or a real listening socket
// for the SSE assertion, and once a real socket exists there is no reason to mix `app.inject` and
// real HTTP in the same flow — a single real-socket client keeps this test's proof literal about
// the two-process, real-network path the roadmap criteria describe ("la conexion SSH se ejecuta en
// el worker, fuera del hilo de la API").
import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import parseSetCookie from 'set-cookie-parser';
import { afterEach, describe, expect, it } from 'vitest';
import { revealSecret } from '@noodara/domain/security';
import { discoverySnapshots } from '../../../apps/control-plane/src/db/schema/index.js';
import { SERVER_EVENTS_CHANNEL } from '../../../apps/control-plane/src/events/redis-server-event-publisher.js';
import { issueToken } from '../../../apps/control-plane/src/services/setup-token-repository.js';
import { assertNoStrayTestContainers, startSshd, type SshdFixture } from '../helpers/ssh.js';
import { startRedis, type RedisFixture } from '../helpers/redis.js';
import { startTestApp, type TestAppFixture } from '../helpers/app.js';

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
let sshdFixture: SshdFixture | undefined;
let stopWorker: (() => Promise<void>) | undefined;

afterEach(async () => {
  await stopWorker?.();
  stopWorker = undefined;
  await sshdFixture?.stop();
  sshdFixture = undefined;
  await fixture?.stop();
  fixture = undefined;
  await redis?.stop();
  redis = undefined;

  // noodara-tdd skill §5: no stray container labelled noodara.test=true survives a run.
  await assertNoStrayTestContainers();
});

interface ApiResponse {
  readonly status: number;
  readonly json: unknown;
  readonly headers: Headers;
}

async function apiRequest(
  baseUrl: string,
  method: string,
  path: string,
  options: { readonly cookie?: string; readonly body?: unknown } = {},
): Promise<ApiResponse> {
  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers: {
      // Only sent when there actually is a body — Fastify's own JSON body parser rejects an empty
      // body whose Content-Type claims `application/json` (the bodyless /connect, /discover and
      // /trust-fingerprint routes would otherwise 500 on this test's own header, not on anything
      // the route itself does wrong).
      ...(options.body !== undefined ? { 'content-type': 'application/json' } : {}),
      ...(options.cookie !== undefined ? { cookie: options.cookie } : {}),
    },
    ...(options.body !== undefined ? { body: JSON.stringify(options.body) } : {}),
  });
  const text = await response.text();
  return { status: response.status, json: text.length > 0 ? JSON.parse(text) : undefined, headers: response.headers };
}

function cookieFromResponse(headers: Headers): string {
  const raw = headers.getSetCookie();
  const parsed = parseSetCookie.parse(raw, { map: false });
  return parsed.map((cookie) => `${cookie.name}=${cookie.value}`).join('; ');
}

async function createAdmin(baseUrl: string, db: TestAppFixture['db']): Promise<void> {
  const issued = await issueToken(db, 'setup', new Date());
  const response = await apiRequest(baseUrl, 'POST', '/api/setup', {
    body: { token: revealSecret(issued.token), email: ADMIN_EMAIL, password: ADMIN_PASSWORD, name: 'Admin' },
  });
  if (response.status !== 200) {
    throw new Error(`setup failed: ${String(response.status)} ${JSON.stringify(response.json)}`);
  }
}

async function signIn(baseUrl: string): Promise<string> {
  const response = await apiRequest(baseUrl, 'POST', '/api/auth/sign-in/email', {
    body: { email: ADMIN_EMAIL, password: ADMIN_PASSWORD },
  });
  if (response.status !== 200) {
    throw new Error(`sign-in failed: ${String(response.status)} ${JSON.stringify(response.json)}`);
  }
  return cookieFromResponse(response.headers);
}

/**
 * Mirrors `worker.ts`'s real `main()` almost exactly (env-derived Redis connections, the real
 * default `SshPort` `resolveServerServicesDeps` already resolves to `createSsh2Adapter()` when no
 * override is given, the real D-14 lock-duration formula) — omitting only the startup sweep and
 * heartbeat, which Plan 04-07/04-10's own suites already prove independently and which this test's
 * assertions do not depend on.
 */
async function startRealWorker(): Promise<() => Promise<void>> {
  const { env } = await import('../../../apps/control-plane/src/env.js');
  const { createRedisServerEventPublisher } = await import(
    '../../../apps/control-plane/src/events/redis-server-event-publisher.js'
  );
  const { createPublisherRedisConnection, createQueueRedisConnection, createWorkerRedisConnection } = await import(
    '../../../apps/control-plane/src/redis/connections.js'
  );
  const { createConnectServerQueue } = await import('../../../apps/control-plane/src/queue/connect-server-queue.js');
  const { createWorker } = await import('../../../apps/control-plane/src/queue/connect-server-worker.js');
  const { computeJobLockDurationMs } = await import('../../../apps/control-plane/src/queue/job-budget.js');
  const { resolveServerServicesDeps } = await import(
    '../../../apps/control-plane/src/services/server-service-deps.js'
  );

  const publisherConnection = createPublisherRedisConnection(env.REDIS_URL);
  const eventPublisher = createRedisServerEventPublisher(publisherConnection, noopLogger as never);
  // No `ssh` override: the real default is `createSsh2Adapter()` (server-service-deps.ts), the
  // exact same real adapter `worker.ts` uses in production — this is what makes the connect below
  // a genuine SSH session against the sshd container, not a fake.
  const deps = await resolveServerServicesDeps({ events: eventPublisher });

  const workerConnection = createWorkerRedisConnection(env.REDIS_URL);
  const queueConnection = createQueueRedisConnection(env.REDIS_URL);
  const queue = createConnectServerQueue({ connection: queueConnection });

  const lockDurationMs = computeJobLockDurationMs({
    connectMs: env.NOODARA_SSH_CONNECT_TIMEOUT_MS,
    commandMs: env.NOODARA_SSH_COMMAND_TIMEOUT_MS,
    discoveryMs: env.NOODARA_SSH_DISCOVERY_TIMEOUT_MS,
  });

  const handle = createWorker(deps, {
    connection: workerConnection,
    queue,
    logger: noopLogger as never,
    concurrency: env.NOODARA_WORKER_CONCURRENCY,
    lockDurationMs,
    stalledIntervalMs: lockDurationMs,
  });

  return async () => {
    await handle.close();
    await queue.close();
    workerConnection.disconnect();
    queueConnection.disconnect();
    publisherConnection.disconnect();
  };
}

/** Same `PUBSUB NUMSUB` poll `tests/integration/routes/events-sse.test.ts` already established:
 *  `app.ready()`/`app.listen()` resolving only proves the *bounded* (2s, D-27) initial subscribe
 *  attempt was raced, not that the real `SUBSCRIBE` has actually landed on a contended machine —
 *  publishing before it lands would silently drop the message (Redis pub/sub has no persistence,
 *  by design, D-05). */
async function waitForActiveSubscriber(redisUrl: string, timeoutMs = 20_000): Promise<void> {
  const { Redis } = await import('ioredis');
  const probe = new Redis(redisUrl, { commandTimeout: 2000, maxRetriesPerRequest: 1 });
  probe.on('error', () => undefined);
  try {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      try {
        const counts = (await probe.call('PUBSUB', 'NUMSUB', SERVER_EVENTS_CHANNEL)) as [string, number];
        if (Number(counts[1]) > 0) return;
      } catch {
        // Transient probe-side error — retry until the deadline rather than failing on one hiccup.
      }
      if (Date.now() > deadline) {
        throw new Error(`waitForActiveSubscriber: no subscriber on ${SERVER_EVENTS_CHANNEL} after ${String(timeoutMs)}ms`);
      }
      await new Promise((resolve) => {
        setTimeout(resolve, 100);
      });
    }
  } finally {
    probe.disconnect();
  }
}

interface LiveStream {
  readFrame(): Promise<string>;
  destroy(): void;
}

const SSE_FRAME_DELIMITER = '\n\n';

/** A genuinely open socket read via `fetch()`'s streaming body — never `app.inject()`, which
 *  would either buffer the whole (never-ending, by design) response or require the
 *  `payloadAsStream` escape hatch this test does not need once a real listener exists. */
async function openLiveEventStream(baseUrl: string, cookie: string): Promise<{ status: number; stream: LiveStream }> {
  const controller = new AbortController();
  const response = await fetch(`${baseUrl}/api/events`, { headers: { cookie }, signal: controller.signal });

  const reader = response.body?.getReader();
  if (reader === undefined) {
    throw new Error('openLiveEventStream: response has no readable body');
  }
  const decoder = new TextDecoder();
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

  void (async (): Promise<void> => {
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) return;
        buffer += decoder.decode(value, { stream: true });
        drainBuffer();
      }
    } catch {
      // Aborted by destroy() below, or the server ended the response — neither is this helper's
      // concern; a caller awaiting readFrame() past this point would simply hang, which no
      // assertion in this file does.
    }
  })();

  const readFrame = (): Promise<string> => {
    const next = queuedFrames.shift();
    if (next !== undefined) return Promise.resolve(next);
    return new Promise((resolve) => {
      waiters.push(resolve);
    });
  };

  return {
    status: response.status,
    stream: {
      readFrame,
      destroy: () => {
        controller.abort();
      },
    },
  };
}

/** Skips any `: keepalive` comment frame and returns the next real `event:`/`data:` frame, parsed.
 *  The 15s default heartbeat should not fire during this test's own bounded steps, but skipping it
 *  defensively costs nothing and removes any dependency on exact timing. */
async function readServerEventFrame(stream: LiveStream): Promise<{ event: string; data: Record<string, unknown> }> {
  for (;;) {
    const frame = await stream.readFrame();
    if (frame.startsWith(':')) continue;
    const lines = frame.split('\n');
    const eventLine = lines.find((line) => line.startsWith('event: '));
    const dataLine = lines.find((line) => line.startsWith('data: '));
    if (eventLine === undefined || dataLine === undefined) continue;
    return {
      event: eventLine.slice('event: '.length),
      data: JSON.parse(dataLine.slice('data: '.length)) as Record<string, unknown>,
    };
  }
}

/** Reads frames until one of `eventType` arrives, returning it together with the event names it
 *  skipped over. Since plan 05-04 the stream carries one `server.discovery_progress` frame per
 *  discovery check between CONNECTING and the terminal status, so status frames are selected by
 *  type rather than assumed adjacent -- and the skipped names let a caller pin exactly what was
 *  allowed to sit in between. */
async function readFrameOfType(
  stream: LiveStream,
  eventType: string,
): Promise<{ frame: { event: string; data: Record<string, unknown> }; skipped: string[] }> {
  const skipped: string[] = [];
  for (;;) {
    const frame = await readServerEventFrame(stream);
    if (frame.event === eventType) return { frame, skipped };
    skipped.push(frame.event);
  }
}

function uniqueServerName(): string {
  return `e2e-${randomUUID().replace(/-/g, '').slice(0, 12)}`;
}

describe('Phase 4 end-to-end: real sshd + real Redis + real worker + real SSE socket (roadmap criteria 1-4, SERV-06, DISC-05)', () => {
  it(
    'proves connect answers in <1s, SSE carries CONNECTING then CONNECTED with no polling, ' +
      're-discovery writes a second snapshot, pre-CONNECTED /discover is 409, delete streams ' +
      'server.deleted, and the API survives the whole flow',
    async () => {
      // Arrange: real sshd (Ubuntu 24.04, password-auth account), real Redis, a real Fastify
      // socket, and a real in-process worker sharing that same Redis/Postgres.
      sshdFixture = await startSshd({ ubuntu: '24.04' });
      redis = await startRedis();
      fixture = await startTestApp({ redisUrl: redis.connectionUrl });

      await fixture.app.listen({ port: 0, host: '127.0.0.1' });
      const address = fixture.app.server.address();
      if (address === null || typeof address === 'string') {
        throw new Error('expected a real listening TCP address');
      }
      const baseUrl = `http://127.0.0.1:${String(address.port)}`;

      await createAdmin(baseUrl, fixture.db);
      const cookie = await signIn(baseUrl);

      stopWorker = await startRealWorker();

      // Act 1: register the server against the real sshd container's password-only account.
      const serverName = uniqueServerName();
      const registerResponse = await apiRequest(baseUrl, 'POST', '/api/servers', {
        cookie,
        body: {
          name: serverName,
          host: sshdFixture.host,
          sshPort: sshdFixture.port,
          sshUser: 'pwuser',
          credential: { type: 'ssh_password', password: sshdFixture.password },
        },
      });
      expect(registerResponse.status).toBe(201);
      const serverId = (registerResponse.json as { id: string }).id;

      // Act 2: open the SSE stream before the connect is triggered — it stays open across the
      // whole flow below, and every status transition is observed on this one connection, never a
      // second GET.
      const { status: streamStatus, stream } = await openLiveEventStream(baseUrl, cookie);
      expect(streamStatus).toBe(200);
      const retryFrame = await stream.readFrame();
      expect(retryFrame).toContain('retry: 5000');
      await waitForActiveSubscriber(redis.connectionUrl);

      // Act 3 / Assert: /discover before the first connect (still PENDING) is 409.
      const prematureDiscoverResponse = await apiRequest(baseUrl, 'POST', `/api/servers/${serverId}/discover`, {
        cookie,
      });
      expect(prematureDiscoverResponse.status).toBe(409);
      expect((prematureDiscoverResponse.json as { error: string }).error).toBe('SERVER_NOT_CONNECTED');

      // Act 4 / Assert (roadmap criterion 1): /connect answers in well under the SSH connect
      // timeout — proof the request never waited on SSH.
      const connectStartedAt = Date.now();
      const connectResponse = await apiRequest(baseUrl, 'POST', `/api/servers/${serverId}/connect`, { cookie });
      const connectElapsedMs = Date.now() - connectStartedAt;
      expect(connectResponse.status).toBe(202);
      expect(connectElapsedMs).toBeLessThan(1000);

      // Assert (roadmap criterion 2): the SSE client sees CONNECTING then CONNECTED with zero
      // intervening GET /api/servers/:id requests.
      const connectingFrame = await readServerEventFrame(stream);
      expect(connectingFrame.event).toBe('server.updated');
      const connectingServer = connectingFrame.data.server as { id: string; status: string };
      expect(connectingServer.id).toBe(serverId);
      expect(connectingServer.status).toBe('CONNECTING');

      // Between the two status frames sits the live per-check discovery progress (plan 05-04) --
      // a real run against a real sshd emits at least one, and nothing else may interleave.
      const { frame: connectedFrame, skipped: firstRunProgress } = await readFrameOfType(stream, 'server.updated');
      expect(firstRunProgress.length).toBeGreaterThan(0);
      expect(firstRunProgress.every((event) => event === 'server.discovery_progress')).toBe(true);
      const connectedServer = connectedFrame.data.server as { id: string; status: string };
      expect(connectedServer.id).toBe(serverId);
      expect(connectedServer.status).not.toBe('CONNECTING');
      expect(connectedServer.status).not.toBe('PENDING');

      // Act 5: the discovered facts the worker's real SSH session collected.
      const detailResponse = await apiRequest(baseUrl, 'GET', `/api/servers/${serverId}`, { cookie });
      expect(detailResponse.status).toBe(200);
      const detail = detailResponse.json as {
        status: string;
        hostname: string | null;
        osDistribution: string | null;
        arch: string | null;
      };
      expect(detail.status).toBe('CONNECTED');
      expect(detail.hostname).not.toBeNull();
      expect(detail.osDistribution).not.toBeNull();
      expect(detail.arch).not.toBeNull();

      // Act 6 (DISC-05, roadmap criterion 3): re-run discovery on the now-CONNECTED server through
      // the same worker path.
      const discoverResponse = await apiRequest(baseUrl, 'POST', `/api/servers/${serverId}/discover`, { cookie });
      expect(discoverResponse.status).toBe(202);

      const secondConnectingFrame = await readServerEventFrame(stream);
      expect((secondConnectingFrame.data.server as { status: string }).status).toBe('CONNECTING');
      const { frame: secondTerminalFrame, skipped: secondRunProgress } = await readFrameOfType(stream, 'server.updated');
      expect(secondRunProgress.length).toBeGreaterThan(0);
      expect(secondRunProgress.every((event) => event === 'server.discovery_progress')).toBe(true);
      const secondTerminalServer = secondTerminalFrame.data.server as { id: string; status: string };
      expect(secondTerminalServer.id).toBe(serverId);
      expect(secondTerminalServer.status).not.toBe('CONNECTING');

      // Assert: a second discovery_snapshots row now exists for this server.
      const snapshotsForServer = await fixture.db
        .select()
        .from(discoverySnapshots)
        .where(eq(discoverySnapshots.serverId, serverId));
      expect(snapshotsForServer).toHaveLength(2);

      // Act 7: activity lists this flow's events, newest first.
      const activityResponse = await apiRequest(baseUrl, 'GET', '/api/activity?limit=200', { cookie });
      expect(activityResponse.status).toBe(200);
      const activityBody = activityResponse.json as {
        items: { occurredAt: string; entityId: string | null; action: string }[];
      };
      for (let i = 1; i < activityBody.items.length; i += 1) {
        const previous = activityBody.items[i - 1];
        const current = activityBody.items[i];
        if (previous === undefined || current === undefined) continue;
        expect(new Date(previous.occurredAt).getTime()).toBeGreaterThanOrEqual(new Date(current.occurredAt).getTime());
      }
      const serverActions = activityBody.items
        .filter((item) => item.entityId === serverId)
        .map((item) => item.action);
      expect(serverActions).toContain('server.created');
      expect(serverActions).toContain('server.connection_attempted');
      expect(serverActions).toContain('server.discovery_completed');

      // Act 8: delete, confirming with the server's exact name — the SSE client receives
      // server.deleted.
      const deleteResponse = await apiRequest(baseUrl, 'DELETE', `/api/servers/${serverId}`, {
        cookie,
        body: { confirmName: serverName },
      });
      expect(deleteResponse.status).toBe(200);

      const deletedFrame = await readServerEventFrame(stream);
      expect(deletedFrame.event).toBe('server.deleted');
      expect((deletedFrame.data as { id: string }).id).toBe(serverId);

      // Final assertion (roadmap criterion 4): the API process never crashed.
      const healthResponse = await apiRequest(baseUrl, 'GET', '/health');
      expect(healthResponse.status).toBe(200);

      stream.destroy();
    },
    120_000,
  );
});
