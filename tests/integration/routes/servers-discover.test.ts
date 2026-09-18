import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import parseSetCookie from 'set-cookie-parser';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { revealSecret } from '@noodara/domain/security';
import { servers } from '../../../apps/control-plane/src/db/schema/servers.js';
import { issueToken } from '../../../apps/control-plane/src/services/setup-token-repository.js';
import { startRedis, type RedisFixture } from '../helpers/redis.js';
import { startTestApp, type TestAppFixture } from '../helpers/app.js';

// D-10: `POST /api/servers/:id/discover` (DISC-05) reuses the exact same connect-server job as
// `/connect`, differing only in its precondition — 409 SERVER_NOT_CONNECTED off CONNECTED, 202
// on it. Every RED assertion below fails today because the route does not exist yet.

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

async function setStatus(serverId: string, status: 'PENDING' | 'CONNECTED'): Promise<void> {
  if (!fixture) throw new Error('fixture not set');
  await fixture.db.update(servers).set({ status }).where(eq(servers.id, serverId));
}

describe('POST /api/servers/:id/discover (D-10, DISC-05)', () => {
  it('on a PENDING (non-CONNECTED) server returns 409 SERVER_NOT_CONNECTED', async () => {
    const { app, cookie } = await bootAuthenticated();
    const serverId = await createServer(app, cookie);

    const response = await app.inject({
      method: 'POST',
      url: `/api/servers/${serverId}/discover`,
      headers: { cookie },
    });

    expect(response.statusCode).toBe(409);
    expect(response.json()).toStrictEqual({ error: 'SERVER_NOT_CONNECTED', message: expect.any(String) });
  });

  it('on a CONNECTED server returns 202 with the same job shape as connect (jobId, server)', async () => {
    const { app, cookie } = await bootAuthenticated();
    const serverId = await createServer(app, cookie);
    await setStatus(serverId, 'CONNECTED');

    const response = await app.inject({
      method: 'POST',
      url: `/api/servers/${serverId}/discover`,
      headers: { cookie },
    });

    expect(response.statusCode).toBe(202);
    const body = response.json() as { server: { id: string }; jobId: string };
    expect(body.server.id).toBe(serverId);
    expect(body.jobId).toBe(`connect-${serverId}`);
  });

  it('reuses the exact same job as a prior connect call for the same server (D-10)', async () => {
    const { app, cookie } = await bootAuthenticated();
    const serverId = await createServer(app, cookie);
    await setStatus(serverId, 'CONNECTED');

    const connectResponse = await app.inject({
      method: 'POST',
      url: `/api/servers/${serverId}/connect`,
      headers: { cookie },
    });
    const discoverResponse = await app.inject({
      method: 'POST',
      url: `/api/servers/${serverId}/discover`,
      headers: { cookie },
    });

    expect(connectResponse.statusCode).toBe(202);
    expect(discoverResponse.statusCode).toBe(202);
    const connectBody = connectResponse.json() as { jobId: string };
    const discoverBody = discoverResponse.json() as { jobId: string };
    expect(discoverBody.jobId).toBe(connectBody.jobId);
  });

  it('returns 404 NOT_FOUND for an unknown id', async () => {
    const { app, cookie } = await bootAuthenticated();

    const response = await app.inject({
      method: 'POST',
      url: `/api/servers/${randomUUID()}/discover`,
      headers: { cookie },
    });

    expect(response.statusCode).toBe(404);
    expect(response.json()).toStrictEqual({ error: 'NOT_FOUND', message: expect.any(String) });
  });

  it('on a CONNECTING server returns 409 ALREADY_CONNECTING, not SERVER_NOT_CONNECTED', async () => {
    const { app, cookie } = await bootAuthenticated();
    const serverId = await createServer(app, cookie);
    if (!fixture) throw new Error('fixture not set');
    await fixture.db.update(servers).set({ status: 'CONNECTING' }).where(eq(servers.id, serverId));

    const response = await app.inject({
      method: 'POST',
      url: `/api/servers/${serverId}/discover`,
      headers: { cookie },
    });

    expect(response.statusCode).toBe(409);
    expect(response.json()).toStrictEqual({ error: 'ALREADY_CONNECTING', message: expect.any(String) });
  });

  it('with Redis stopped, returns 503 QUEUE_UNAVAILABLE while GET /api/servers still returns 200', async () => {
    const { app, cookie } = await bootAuthenticated();
    const serverId = await createServer(app, cookie);
    await setStatus(serverId, 'CONNECTED');
    if (!redis) throw new Error('redis fixture not set');
    await redis.stop();

    const response = await app.inject({
      method: 'POST',
      url: `/api/servers/${serverId}/discover`,
      headers: { cookie },
    });

    expect(response.statusCode).toBe(503);
    expect(response.json()).toStrictEqual({ error: 'QUEUE_UNAVAILABLE', message: expect.any(String) });

    const listResponse = await app.inject({ method: 'GET', url: '/api/servers', headers: { cookie } });
    expect(listResponse.statusCode).toBe(200);
  });

  it('returns 401 with no cookie', async () => {
    redis = await startRedis();
    fixture = await startTestApp({ redisUrl: redis.connectionUrl });

    const response = await fixture.app.inject({
      method: 'POST',
      url: `/api/servers/${randomUUID()}/discover`,
    });

    expect(response.statusCode).toBe(401);
  });
});
