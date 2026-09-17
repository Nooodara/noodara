import parseSetCookie from 'set-cookie-parser';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { revealSecret } from '@noodara/domain/security';
import { issueToken } from '../../../apps/control-plane/src/services/setup-token-repository.js';
import { startTestApp, type TestAppFixture } from '../helpers/app.js';

// D-17/D-29 (Plan 04-04, Task 3): the guarded/unguarded matrix and the Origin/CSRF-lite guard,
// proven against the real HTTP surface. `/health`, `/api/auth/*`, `/api/setup`, `/api/recovery`
// stay reachable with no session; `/api/sessions` (today) — and every future route this phase
// adds to the same scope — sits behind `requireSession` + `createOriginGuard`.

const ADMIN_EMAIL = 'admin@noodara.test';
const ADMIN_PASSWORD = 'correct horse battery staple';
const FOREIGN_ORIGIN = 'https://evil.example';

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

async function createAdmin(
  app: TestAppFixture['app'],
  db: TestAppFixture['db'],
  email: string,
  password: string,
): Promise<void> {
  const issued = await issueToken(db, 'setup', new Date());
  const response = await app.inject({
    method: 'POST',
    url: '/api/setup',
    payload: { token: revealSecret(issued.token), email, password, name: 'Admin' },
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

async function signIn(app: TestAppFixture['app'], email: string, password: string): Promise<string> {
  const response = await app.inject({
    method: 'POST',
    url: '/api/auth/sign-in/email',
    payload: { email, password },
  });
  if (response.statusCode !== 200) {
    throw new Error(`sign-in failed: ${response.statusCode.toString()} ${response.body}`);
  }
  return cookieHeaderFrom(response);
}

describe('api-scope guarded/unguarded matrix (D-17)', () => {
  it('GET /api/sessions without a cookie returns 401 { error: UNAUTHORIZED, message }', async () => {
    fixture = await startTestApp();
    await createAdmin(fixture.app, fixture.db, ADMIN_EMAIL, ADMIN_PASSWORD);

    const response = await fixture.app.inject({ method: 'GET', url: '/api/sessions' });

    expect(response.statusCode).toBe(401);
    expect(response.json()).toStrictEqual({ error: 'UNAUTHORIZED', message: expect.any(String) });
  });

  it('GET /health, POST /api/setup and POST /api/recovery stay reachable with no session', async () => {
    fixture = await startTestApp();

    const health = await fixture.app.inject({ method: 'GET', url: '/health' });
    expect(health.statusCode).toBe(200);

    const setup = await fixture.app.inject({
      method: 'POST',
      url: '/api/setup',
      payload: { token: 'not-a-real-token', email: ADMIN_EMAIL, password: ADMIN_PASSWORD },
    });
    expect(setup.statusCode).toBe(400);

    const recovery = await fixture.app.inject({
      method: 'POST',
      url: '/api/recovery',
      payload: { token: 'not-a-real-token', newPassword: ADMIN_PASSWORD },
    });
    expect(recovery.statusCode).toBe(400);
  });

  it('POST /api/setup once an admin exists still returns 404, never 403, now with { error: NOT_FOUND }', async () => {
    fixture = await startTestApp();
    await createAdmin(fixture.app, fixture.db, ADMIN_EMAIL, ADMIN_PASSWORD);

    const response = await fixture.app.inject({
      method: 'POST',
      url: '/api/setup',
      payload: { token: 'irrelevant', email: 'other@noodara.test', password: ADMIN_PASSWORD },
    });

    expect(response.statusCode).toBe(404);
    expect(response.statusCode).not.toBe(403);
    expect(response.json()).toStrictEqual({ error: 'NOT_FOUND', message: expect.any(String) });
  });

  it('POST /api/setup with an invalid token still returns 400 with an UPPER_SNAKE code', async () => {
    fixture = await startTestApp();

    const response = await fixture.app.inject({
      method: 'POST',
      url: '/api/setup',
      payload: { token: 'this-token-was-never-issued', email: ADMIN_EMAIL, password: ADMIN_PASSWORD },
    });

    expect(response.statusCode).toBe(400);
    const body = response.json() as { error: string; message: string };
    expect(body.error).toMatch(/^[A-Z_]+$/);
    expect(typeof body.message).toBe('string');
  });

  it('DELETE /api/sessions/:id for a session that is not the caller’s still returns 404 { error: NOT_FOUND }', async () => {
    fixture = await startTestApp();
    await createAdmin(fixture.app, fixture.db, ADMIN_EMAIL, ADMIN_PASSWORD);
    const cookie = await signIn(fixture.app, ADMIN_EMAIL, ADMIN_PASSWORD);

    const response = await fixture.app.inject({
      method: 'DELETE',
      url: '/api/sessions/00000000-0000-7000-8000-000000000000',
      headers: { cookie },
    });

    expect(response.statusCode).toBe(404);
    expect(response.json()).toStrictEqual({ error: 'NOT_FOUND', message: expect.any(String) });
  });

  it('DELETE /api/sessions/:id with a foreign Origin returns 403 FORBIDDEN_ORIGIN', async () => {
    fixture = await startTestApp();
    await createAdmin(fixture.app, fixture.db, ADMIN_EMAIL, ADMIN_PASSWORD);
    const cookie = await signIn(fixture.app, ADMIN_EMAIL, ADMIN_PASSWORD);

    const response = await fixture.app.inject({
      method: 'DELETE',
      url: '/api/sessions/00000000-0000-7000-8000-000000000000',
      headers: { cookie, origin: FOREIGN_ORIGIN },
    });

    expect(response.statusCode).toBe(403);
    expect(response.json()).toStrictEqual({ error: 'FORBIDDEN_ORIGIN', message: expect.any(String) });
  });

  it('GET /api/sessions with a mismatched Origin still returns its normal response (guard is mutation-only)', async () => {
    fixture = await startTestApp();
    await createAdmin(fixture.app, fixture.db, ADMIN_EMAIL, ADMIN_PASSWORD);
    const cookie = await signIn(fixture.app, ADMIN_EMAIL, ADMIN_PASSWORD);

    const response = await fixture.app.inject({
      method: 'GET',
      url: '/api/sessions',
      headers: { cookie, origin: FOREIGN_ORIGIN },
    });

    expect(response.statusCode).toBe(200);
  });

  it('no response body anywhere under the guarded/unguarded matrix uses a lowercase error code', async () => {
    fixture = await startTestApp();
    await createAdmin(fixture.app, fixture.db, ADMIN_EMAIL, ADMIN_PASSWORD);

    const unauthenticated = await fixture.app.inject({ method: 'GET', url: '/api/sessions' });
    expect(unauthenticated.body).not.toContain('"unauthorized"');
    expect(unauthenticated.body).not.toContain('"not_found"');

    const notFound = await fixture.app.inject({
      method: 'DELETE',
      url: '/api/sessions/00000000-0000-7000-8000-000000000000',
      headers: { cookie: await signIn(fixture.app, ADMIN_EMAIL, ADMIN_PASSWORD) },
    });
    expect(notFound.body).not.toContain('"not_found"');
    expect(notFound.body).not.toContain('"unauthorized"');
  });
});
