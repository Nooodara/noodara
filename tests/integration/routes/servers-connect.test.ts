import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import parseSetCookie from 'set-cookie-parser';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { revealSecret } from '@noodara/domain/security';
import { activityEvents } from '../../../apps/control-plane/src/db/schema/activity-events.js';
import { servers } from '../../../apps/control-plane/src/db/schema/servers.js';
import { issueToken } from '../../../apps/control-plane/src/services/setup-token-repository.js';
import { startRedis, type RedisFixture } from '../helpers/redis.js';
import { startTestApp, type TestAppFixture } from '../helpers/app.js';

// D-08/D-09/D-27: `POST /api/servers/:id/connect` answers 202 with `{ server, jobId }` in
// milliseconds — no worker runs in this suite, which is exactly what proves the route never
// waits on SSH. Every RED assertion below fails today because the route does not exist yet
// (`/api/servers/:id/connect` 404s under the CRUD-only servers.ts from Task 2).

const ADMIN_EMAIL = 'admin@noodara.test';
const ADMIN_PASSWORD = 'correct horse battery staple';

let fixture: TestAppFixture | undefined;
let redis: RedisFixture | undefined;

beforeEach(() => {
  vi.resetModules();
});

afterEach(async () => {
  await fixture?.stop();
  fixture = undefined;
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

async function createAdmin(app: TestAppFixture['app'], db: TestAppFixture['db']): Promise<void> {
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

async function signIn(app: TestAppFixture['app']): Promise<string> {
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

async function bootAuthenticated(): Promise<{ app: TestAppFixture['app']; cookie: string }> {
  redis = await startRedis();
  fixture = await startTestApp({ redisUrl: redis.connectionUrl });
  await createAdmin(fixture.app, fixture.db);
  const cookie = await signIn(fixture.app);
  return { app: fixture.app, cookie };
}

async function createServer(app: TestAppFixture['app'], cookie: string, name = uniqueName('s')): Promise<string> {
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

async function setStatus(serverId: string, status: 'PENDING' | 'CONNECTING' | 'CONNECTED'): Promise<void> {
  if (!fixture) throw new Error('fixture not set');
  await fixture.db.update(servers).set({ status }).where(eq(servers.id, serverId));
}

async function activityEventCount(serverId: string): Promise<number> {
  if (!fixture) throw new Error('fixture not set');
  const rows = await fixture.db.select().from(activityEvents).where(eq(activityEvents.entityId, serverId));
  return rows.length;
}

describe('POST /api/servers/:id/connect (D-08, D-09, D-27)', () => {
  it('on a PENDING server returns 202 with { server, jobId } without running SSH', async () => {
    const { app, cookie } = await bootAuthenticated();
    const serverId = await createServer(app, cookie);

    const response = await app.inject({
      method: 'POST',
      url: `/api/servers/${serverId}/connect`,
      headers: { cookie },
    });

    expect(response.statusCode).toBe(202);
    const body = response.json() as { server: { id: string; status: string }; jobId: string };
    expect(body.server.id).toBe(serverId);
    expect(body.jobId).toBe(`connect-${serverId}`);
    // The route never calls connectAndDiscover itself — the row's status is still whatever the
    // service left it at (PENDING), proving no SSH work happened inside the request.
    expect(body.server.status).toBe('PENDING');
  });

  it('on a CONNECTING server returns 409 ALREADY_CONNECTING', async () => {
    const { app, cookie } = await bootAuthenticated();
    const serverId = await createServer(app, cookie);
    await setStatus(serverId, 'CONNECTING');

    const response = await app.inject({
      method: 'POST',
      url: `/api/servers/${serverId}/connect`,
      headers: { cookie },
    });

    expect(response.statusCode).toBe(409);
    expect(response.json()).toStrictEqual({ error: 'ALREADY_CONNECTING', message: expect.any(String) });
  });

  it('on a CONNECTED server returns 202 (reconnect is allowed)', async () => {
    const { app, cookie } = await bootAuthenticated();
    const serverId = await createServer(app, cookie);
    await setStatus(serverId, 'CONNECTED');

    const response = await app.inject({
      method: 'POST',
      url: `/api/servers/${serverId}/connect`,
      headers: { cookie },
    });

    expect(response.statusCode).toBe(202);
  });

  it('two consecutive connect POSTs return the same jobId and the queue holds one job', async () => {
    const { app, cookie } = await bootAuthenticated();
    const serverId = await createServer(app, cookie);

    const first = await app.inject({ method: 'POST', url: `/api/servers/${serverId}/connect`, headers: { cookie } });
    const second = await app.inject({ method: 'POST', url: `/api/servers/${serverId}/connect`, headers: { cookie } });

    expect(first.statusCode).toBe(202);
    expect(second.statusCode).toBe(202);
    const firstBody = first.json() as { jobId: string };
    const secondBody = second.json() as { jobId: string };
    expect(secondBody.jobId).toBe(firstBody.jobId);

    if (!redis) throw new Error('redis fixture not set');
    const { createQueueRedisConnection } = await import('../../../apps/control-plane/src/redis/connections.js');
    const bullmq = await import('bullmq');
    const connection = createQueueRedisConnection(redis.connectionUrl);
    const rawQueue = new bullmq.Queue('servers', { connection, prefix: 'noodara' });
    const waitingJobs = await rawQueue.getJobs(['waiting', 'active', 'delayed']);
    await rawQueue.close();
    connection.disconnect();
    expect(waitingJobs.length).toBe(1);
  });

  it('returns 404 NOT_FOUND for an unknown id', async () => {
    const { app, cookie } = await bootAuthenticated();

    const response = await app.inject({
      method: 'POST',
      url: `/api/servers/${randomUUID()}/connect`,
      headers: { cookie },
    });

    expect(response.statusCode).toBe(404);
    expect(response.json()).toStrictEqual({ error: 'NOT_FOUND', message: expect.any(String) });
  });

  it('writes no activity event — the activity_events row count is unchanged', async () => {
    const { app, cookie } = await bootAuthenticated();
    const serverId = await createServer(app, cookie);
    const before = await activityEventCount(serverId);

    const response = await app.inject({
      method: 'POST',
      url: `/api/servers/${serverId}/connect`,
      headers: { cookie },
    });
    expect(response.statusCode).toBe(202);

    const after = await activityEventCount(serverId);
    expect(after).toBe(before);
  });

  it('logs one info record with serverId, jobId and trigger', async () => {
    redis = await startRedis();
    let records: (() => unknown[]) | undefined;
    fixture = await startTestApp({
      redisUrl: redis.connectionUrl,
      buildLogger: async () => {
        const { writableForTests, createLogger } = await import('../../../apps/control-plane/src/logger.js');
        const capture = writableForTests();
        records = capture.records;
        return createLogger({ level: 'info', destination: capture.stream });
      },
    });
    await createAdmin(fixture.app, fixture.db);
    const cookie = await signIn(fixture.app);
    const serverId = await createServer(fixture.app, cookie);

    const response = await fixture.app.inject({
      method: 'POST',
      url: `/api/servers/${serverId}/connect`,
      headers: { cookie },
    });
    expect(response.statusCode).toBe(202);

    const logged = (records?.() ?? []) as { msg?: string; serverId?: string; jobId?: string; trigger?: string }[];
    const enqueueLog = logged.find((r) => r.msg === 'connect-server job enqueued');
    expect(enqueueLog).toBeDefined();
    expect(enqueueLog?.serverId).toBe(serverId);
    expect(enqueueLog?.jobId).toBe(`connect-${serverId}`);
    expect(enqueueLog?.trigger).toBe('connect');
  });

  it('with Redis stopped, returns 503 QUEUE_UNAVAILABLE within ~3s while GET /api/servers still returns 200', async () => {
    const { app, cookie } = await bootAuthenticated();
    const serverId = await createServer(app, cookie);
    if (!redis) throw new Error('redis fixture not set');
    await redis.stop();

    const startedAt = Date.now();
    const response = await app.inject({
      method: 'POST',
      url: `/api/servers/${serverId}/connect`,
      headers: { cookie },
    });
    const elapsedMs = Date.now() - startedAt;

    expect(response.statusCode).toBe(503);
    expect(response.json()).toStrictEqual({ error: 'QUEUE_UNAVAILABLE', message: expect.any(String) });
    expect(elapsedMs).toBeLessThan(3000);

    const listResponse = await app.inject({ method: 'GET', url: '/api/servers', headers: { cookie } });
    expect(listResponse.statusCode).toBe(200);
  });

  it('returns 401 with no cookie', async () => {
    redis = await startRedis();
    fixture = await startTestApp({ redisUrl: redis.connectionUrl });

    const response = await fixture.app.inject({
      method: 'POST',
      url: `/api/servers/${randomUUID()}/connect`,
    });

    expect(response.statusCode).toBe(401);
  });
});
