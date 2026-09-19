import { randomUUID } from 'node:crypto';
import parseSetCookie from 'set-cookie-parser';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { revealSecret } from '@noodara/domain/security';
import { discoverySnapshots } from '../../../apps/control-plane/src/db/schema/discovery-snapshots.js';
import { issueToken } from '../../../apps/control-plane/src/services/setup-token-repository.js';
import { startTestApp, type TestAppFixture } from '../helpers/app.js';

// D-05/DISC-02: `GET /api/servers/:id/discovery` — the ninth `/api/servers` route, read-only and
// guarded, never 404 for an empty discovery history.

const ADMIN_EMAIL = 'admin@noodara.test';
const ADMIN_PASSWORD = 'correct horse battery staple';

let fixture: TestAppFixture | undefined;

beforeEach(() => {
  vi.resetModules();
});

afterEach(async () => {
  await fixture?.stop();
  fixture = undefined;

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
  fixture = await startTestApp();
  await createAdmin(fixture.app, fixture.db);
  const cookie = await signIn(fixture.app);
  return { app: fixture.app, cookie };
}

async function createServer(app: TestAppFixture['app'], cookie: string): Promise<string> {
  const response = await app.inject({
    method: 'POST',
    url: '/api/servers',
    headers: { cookie },
    payload: {
      name: uniqueName('d'),
      host: uniqueHost(),
      credential: { type: 'ssh_password', password: 'hunter2-test-password' },
    },
  });
  const body = response.json() as { id: string };
  return body.id;
}

async function insertCompletedSnapshot(serverId: string): Promise<void> {
  if (!fixture) throw new Error('fixture not set');
  await fixture.db.insert(discoverySnapshots).values({
    serverId,
    collectedAt: new Date('2026-01-05T00:00:00.000Z'),
    outcome: 'ok',
    payload: {
      facts: { hostname: 'not-forwarded' },
      checks: [
        { id: 'hostname', status: 'pass', detail: 'srv-01', durationMs: 10 },
        { id: 'arch', status: 'pass', detail: 'amd64', durationMs: 5 },
      ],
      warnings: [],
    },
  });
}

describe('GET /api/servers/:id/discovery (D-05, DISC-02)', () => {
  it('returns 200 with the latest run for a server with a completed discovery', async () => {
    const { app, cookie } = await bootAuthenticated();
    const serverId = await createServer(app, cookie);
    await insertCompletedSnapshot(serverId);

    const response = await app.inject({
      method: 'GET',
      url: `/api/servers/${serverId}/discovery`,
      headers: { cookie },
    });

    expect(response.statusCode).toBe(200);
    const body = response.json() as {
      collectedAt: string;
      outcome: string;
      checks: { id: string }[];
      warnings: string[];
    };
    expect(body.outcome).toBe('ok');
    expect(body.collectedAt).toBe('2026-01-05T00:00:00.000Z');
    expect(body.checks).toHaveLength(2);
    expect(body.checks.map((c) => c.id)).toEqual(['hostname', 'arch']);
    expect(body.warnings).toEqual([]);
    expect(JSON.stringify(body)).not.toContain('not-forwarded');
  });

  it('returns 200 with the empty shape for a server with no discovery history', async () => {
    const { app, cookie } = await bootAuthenticated();
    const serverId = await createServer(app, cookie);

    const response = await app.inject({
      method: 'GET',
      url: `/api/servers/${serverId}/discovery`,
      headers: { cookie },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toStrictEqual({
      collectedAt: null,
      outcome: null,
      checks: [],
      warnings: [],
    });
  });

  it('returns 404 NOT_FOUND for a random UUID that is not a server', async () => {
    const { app, cookie } = await bootAuthenticated();

    const response = await app.inject({
      method: 'GET',
      url: `/api/servers/${randomUUID()}/discovery`,
      headers: { cookie },
    });

    expect(response.statusCode).toBe(404);
    expect(response.json()).toStrictEqual({ error: 'NOT_FOUND', message: expect.any(String) });
  });

  it('returns 401 with no session cookie', async () => {
    fixture = await startTestApp();

    const response = await fixture.app.inject({
      method: 'GET',
      url: `/api/servers/${randomUUID()}/discovery`,
    });

    expect(response.statusCode).toBe(401);
    expect(response.json()).toStrictEqual({ error: 'UNAUTHORIZED', message: expect.any(String) });
  });

  it('returns 400 VALIDATION_FAILED for a non-UUID id', async () => {
    const { app, cookie } = await bootAuthenticated();

    const response = await app.inject({
      method: 'GET',
      url: '/api/servers/not-a-uuid/discovery',
      headers: { cookie },
    });

    expect(response.statusCode).toBe(400);
    const body = response.json() as { error: string };
    expect(body.error).toBe('VALIDATION_FAILED');
  });
});
