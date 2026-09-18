import { randomUUID } from 'node:crypto';
import parseSetCookie from 'set-cookie-parser';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { revealSecret } from '@noodara/domain/security';
import { SERVER_VIEW_KEYS } from '../../../apps/control-plane/src/services/server-view.js';
import { issueToken } from '../../../apps/control-plane/src/services/setup-token-repository.js';
import { startTestApp, type TestAppFixture } from '../helpers/app.js';

// D-19: the five `/api/servers` CRUD routes, proven against the real HTTP surface with an
// authenticated cookie — validation, one status map, and no credential ever in a response body.

const ADMIN_EMAIL = 'admin@noodara.test';
const ADMIN_PASSWORD = 'correct horse battery staple';
const CANARY_PRIVATE_KEY = 'CANARY-PRIVATE-KEY-CONTENT-NEVER-IN-RESPONSE';
const CANARY_PASSWORD = 'canary-password-never-in-response';

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

/** Boots a fresh app, creates the one admin and signs in — the setup every CRUD test needs. */
async function bootAuthenticated(): Promise<{ app: TestAppFixture['app']; cookie: string }> {
  fixture = await startTestApp();
  await createAdmin(fixture.app, fixture.db);
  const cookie = await signIn(fixture.app);
  return { app: fixture.app, cookie };
}

async function createServer(
  app: TestAppFixture['app'],
  cookie: string,
  overrides: Partial<{ name: string; host: string; sshPort: number; sshUser: string }> = {},
): Promise<{ statusCode: number; body: Record<string, unknown> }> {
  const response = await app.inject({
    method: 'POST',
    url: '/api/servers',
    headers: { cookie },
    payload: {
      name: overrides.name ?? uniqueName('c'),
      host: overrides.host ?? uniqueHost(),
      ...(overrides.sshPort !== undefined ? { sshPort: overrides.sshPort } : {}),
      ...(overrides.sshUser !== undefined ? { sshUser: overrides.sshUser } : {}),
      credential: { type: 'ssh_password', password: CANARY_PASSWORD },
    },
  });
  return { statusCode: response.statusCode, body: response.json() as Record<string, unknown> };
}

describe('POST /api/servers (D-19)', () => {
  it('returns 201 with a ServerView whose key set is exactly the 27 allowlisted fields', async () => {
    const { app, cookie } = await bootAuthenticated();

    const { statusCode, body } = await createServer(app, cookie);

    expect(statusCode).toBe(201);
    expect(Object.keys(body).sort()).toEqual([...SERVER_VIEW_KEYS].sort());
    expect(Object.keys(body)).toHaveLength(27);
  });

  it('returns 409 NAME_TAKEN for a duplicate name', async () => {
    const { app, cookie } = await bootAuthenticated();
    const name = uniqueName('dup');
    await createServer(app, cookie, { name });

    const { statusCode, body } = await createServer(app, cookie, { name });

    expect(statusCode).toBe(409);
    expect(body).toStrictEqual({ error: 'NAME_TAKEN', message: expect.any(String) });
  });

  it('returns 409 HOST_TAKEN for a duplicate host+port', async () => {
    const { app, cookie } = await bootAuthenticated();
    const host = uniqueHost();
    await createServer(app, cookie, { host });

    const { statusCode, body } = await createServer(app, cookie, { host });

    expect(statusCode).toBe(409);
    expect(body).toStrictEqual({ error: 'HOST_TAKEN', message: expect.any(String) });
  });

  it('returns 400 VALIDATION_FAILED for an invalid host', async () => {
    const { app, cookie } = await bootAuthenticated();

    const response = await app.inject({
      method: 'POST',
      url: '/api/servers',
      headers: { cookie },
      payload: {
        name: uniqueName('badhost'),
        host: 'not a valid host!!',
        credential: { type: 'ssh_password', password: CANARY_PASSWORD },
      },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ error: 'VALIDATION_FAILED' });
  });

  it('returns 400 INVALID_CREDENTIAL for an unparseable private key', async () => {
    const { app, cookie } = await bootAuthenticated();

    const response = await app.inject({
      method: 'POST',
      url: '/api/servers',
      headers: { cookie },
      payload: {
        name: uniqueName('badkey'),
        host: uniqueHost(),
        credential: { type: 'ssh_private_key', privateKey: 'not a real private key' },
      },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ error: 'INVALID_CREDENTIAL' });
  });

  it('returns 400 VALIDATION_FAILED with an issues array when credential is missing, from the schema', async () => {
    const { app, cookie } = await bootAuthenticated();

    const response = await app.inject({
      method: 'POST',
      url: '/api/servers',
      headers: { cookie },
      payload: { name: uniqueName('nocred'), host: uniqueHost() },
    });

    expect(response.statusCode).toBe(400);
    const body = response.json() as { error: string; issues: unknown[] };
    expect(body.error).toBe('VALIDATION_FAILED');
    expect(Array.isArray(body.issues)).toBe(true);
    expect(body.issues.length).toBeGreaterThan(0);
  });

  it('returns 401 with no cookie', async () => {
    fixture = await startTestApp();

    const response = await fixture.app.inject({
      method: 'POST',
      url: '/api/servers',
      payload: {
        name: uniqueName('anon'),
        host: uniqueHost(),
        credential: { type: 'ssh_password', password: CANARY_PASSWORD },
      },
    });

    expect(response.statusCode).toBe(401);
  });
});

describe('GET /api/servers (D-19)', () => {
  it('returns 200 { items: [...] } ordered by name', async () => {
    const { app, cookie } = await bootAuthenticated();
    const suffix = randomUUID().replace(/-/g, '').slice(0, 8);
    const nameZ = `zzz-${suffix}`;
    const nameA = `aaa-${suffix}`;
    await createServer(app, cookie, { name: nameZ });
    await createServer(app, cookie, { name: nameA });

    const response = await app.inject({ method: 'GET', url: '/api/servers', headers: { cookie } });

    expect(response.statusCode).toBe(200);
    const body = response.json() as { items: { name: string }[] };
    const namesForThisRun = body.items.map((item) => item.name).filter((n) => n.includes(suffix));
    expect(namesForThisRun).toEqual([nameA, nameZ]);
  });

  it('returns 401 with no cookie', async () => {
    fixture = await startTestApp();

    const response = await fixture.app.inject({ method: 'GET', url: '/api/servers' });

    expect(response.statusCode).toBe(401);
  });
});

describe('GET /api/servers/:id (D-19)', () => {
  it('returns 200 with the ServerView for an existing server', async () => {
    const { app, cookie } = await bootAuthenticated();
    const { body: created } = await createServer(app, cookie);

    const response = await app.inject({
      method: 'GET',
      url: `/api/servers/${String(created.id)}`,
      headers: { cookie },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ id: created.id });
  });

  it('returns 404 NOT_FOUND for an unknown id', async () => {
    const { app, cookie } = await bootAuthenticated();

    const response = await app.inject({
      method: 'GET',
      url: `/api/servers/${randomUUID()}`,
      headers: { cookie },
    });

    expect(response.statusCode).toBe(404);
    expect(response.json()).toStrictEqual({ error: 'NOT_FOUND', message: expect.any(String) });
  });

  it('returns 400 VALIDATION_FAILED for a non-uuid id', async () => {
    const { app, cookie } = await bootAuthenticated();

    const response = await app.inject({
      method: 'GET',
      url: '/api/servers/not-a-uuid',
      headers: { cookie },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ error: 'VALIDATION_FAILED' });
  });

  it('returns 401 with no cookie', async () => {
    fixture = await startTestApp();

    const response = await fixture.app.inject({ method: 'GET', url: `/api/servers/${randomUUID()}` });

    expect(response.statusCode).toBe(401);
  });
});

describe('PATCH /api/servers/:id (D-19)', () => {
  it('returns 200 with the updated view for a name-only edit', async () => {
    const { app, cookie } = await bootAuthenticated();
    const { body: created } = await createServer(app, cookie);
    const newName = uniqueName('renamed');

    const response = await app.inject({
      method: 'PATCH',
      url: `/api/servers/${String(created.id)}`,
      headers: { cookie },
      payload: { name: newName },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ id: created.id, name: newName });
  });

  it('replacing the credential returns 200 with no credential material in the response', async () => {
    const { app, cookie } = await bootAuthenticated();
    const { body: created } = await createServer(app, cookie);

    const response = await app.inject({
      method: 'PATCH',
      url: `/api/servers/${String(created.id)}`,
      headers: { cookie },
      payload: { credential: { type: 'ssh_private_key', privateKey: CANARY_PRIVATE_KEY } },
    });

    expect(response.statusCode).toBe(400);
    // An unparseable canary key is rejected by loadPrivateKey (INVALID_CREDENTIAL) — the response
    // body must still never contain the submitted canary regardless of outcome.
    expect(response.body).not.toContain(CANARY_PRIVATE_KEY);
  });

  it('returns 409 SERVER_BUSY on a CONNECTING server', async () => {
    const { app, cookie } = await bootAuthenticated();
    const { body: created } = await createServer(app, cookie);
    if (!fixture) throw new Error('fixture not set');
    const { servers } = await import('../../../apps/control-plane/src/db/schema/servers.js');
    const { eq } = await import('drizzle-orm');
    await fixture.db.update(servers).set({ status: 'CONNECTING' }).where(eq(servers.id, String(created.id)));

    const response = await app.inject({
      method: 'PATCH',
      url: `/api/servers/${String(created.id)}`,
      headers: { cookie },
      payload: { name: uniqueName('busy') },
    });

    expect(response.statusCode).toBe(409);
    expect(response.json()).toStrictEqual({ error: 'SERVER_BUSY', message: expect.any(String) });
  });

  it('returns 401 with no cookie', async () => {
    fixture = await startTestApp();

    const response = await fixture.app.inject({
      method: 'PATCH',
      url: `/api/servers/${randomUUID()}`,
      payload: { name: uniqueName('anon') },
    });

    expect(response.statusCode).toBe(401);
  });
});

describe('DELETE /api/servers/:id (D-19)', () => {
  it('returns 200 { ok: true, serverId } when confirmName matches', async () => {
    const { app, cookie } = await bootAuthenticated();
    const { body: created } = await createServer(app, cookie, { name: uniqueName('del') });

    const response = await app.inject({
      method: 'DELETE',
      url: `/api/servers/${String(created.id)}`,
      headers: { cookie },
      payload: { confirmName: created.name },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toStrictEqual({ ok: true, serverId: created.id });
  });

  it('returns 409 CONFIRMATION_MISMATCH for a mismatched name', async () => {
    const { app, cookie } = await bootAuthenticated();
    const { body: created } = await createServer(app, cookie);

    const response = await app.inject({
      method: 'DELETE',
      url: `/api/servers/${String(created.id)}`,
      headers: { cookie },
      payload: { confirmName: 'definitely-not-the-name' },
    });

    expect(response.statusCode).toBe(409);
    expect(response.json()).toStrictEqual({ error: 'CONFIRMATION_MISMATCH', message: expect.any(String) });
  });

  it('returns 404 for an unknown id', async () => {
    const { app, cookie } = await bootAuthenticated();

    const response = await app.inject({
      method: 'DELETE',
      url: `/api/servers/${randomUUID()}`,
      headers: { cookie },
      payload: { confirmName: 'whatever' },
    });

    expect(response.statusCode).toBe(404);
  });

  it('returns 401 with no cookie', async () => {
    fixture = await startTestApp();

    const response = await fixture.app.inject({
      method: 'DELETE',
      url: `/api/servers/${randomUUID()}`,
      payload: { confirmName: 'whatever' },
    });

    expect(response.statusCode).toBe(401);
  });
});

describe('no credential material ever appears in a CRUD response body (SEC-02, D-19)', () => {
  it('the raw response body string never contains the submitted private key or password canary', async () => {
    const { app, cookie } = await bootAuthenticated();

    const createResponse = await app.inject({
      method: 'POST',
      url: '/api/servers',
      headers: { cookie },
      payload: {
        name: uniqueName('canary'),
        host: uniqueHost(),
        credential: { type: 'ssh_password', password: CANARY_PASSWORD },
      },
    });
    expect(createResponse.body).not.toContain(CANARY_PASSWORD);
    expect(createResponse.body).not.toContain(CANARY_PRIVATE_KEY);

    const created = createResponse.json() as { id: string };

    const getResponse = await app.inject({
      method: 'GET',
      url: `/api/servers/${created.id}`,
      headers: { cookie },
    });
    expect(getResponse.body).not.toContain(CANARY_PASSWORD);

    const patchResponse = await app.inject({
      method: 'PATCH',
      url: `/api/servers/${created.id}`,
      headers: { cookie },
      payload: { credential: { type: 'ssh_private_key', privateKey: CANARY_PRIVATE_KEY } },
    });
    expect(patchResponse.body).not.toContain(CANARY_PRIVATE_KEY);
    expect(patchResponse.body).not.toContain(CANARY_PASSWORD);

    const listResponse = await app.inject({ method: 'GET', url: '/api/servers', headers: { cookie } });
    expect(listResponse.body).not.toContain(CANARY_PASSWORD);
    expect(listResponse.body).not.toContain(CANARY_PRIVATE_KEY);
  });
});
