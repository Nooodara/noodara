import parseSetCookie from 'set-cookie-parser';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { startTestApp, type TestAppFixture } from '../helpers/app.js';

// Better Auth mounted in Fastify (Plan 01-10): AUTH-02 (argon2id login, session survives a
// second request) proven against a real, migrated PostgreSQL through the real HTTP surface.

const UUID_V7_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const ADMIN_EMAIL = 'admin@noodara.test';
const ADMIN_PASSWORD = 'correct horse battery staple';

let fixture: TestAppFixture | undefined;

// `auth.ts` opens its own `pg.Pool` at module scope, bound to whatever `DATABASE_URL` was current
// at first import (Plan 01-10) — unlike the harness's own `db`, it is not re-derived per
// `startTestApp()` call. `vi.resetModules()` forces the whole `app.js` module graph (including
// `auth.ts`) to re-evaluate against *this* test's freshly started container, so a later test in
// this file never reuses a pool bound to an already-stopped container from an earlier test.
beforeEach(() => {
  vi.resetModules();
});

afterEach(async () => {
  await fixture?.stop();
  fixture = undefined;

  // noodara-tdd skill §5: no stray container labelled noodara.test=true survives a run.
  const { getContainerRuntimeClient } = await import('testcontainers');
  const client = await getContainerRuntimeClient();
  const containers = await client.container.list();
  const stray = containers.filter((c) => c.Labels['noodara.test'] === 'true');
  expect(stray).toHaveLength(0);
});

/**
 * Creates the admin via the (currently open, ungated — Plan 01-12 owns the gate) sign-up
 * endpoint, so every test in this file exercises the real argon2id hasher wired into Better
 * Auth end to end rather than seeding a hash by hand.
 */
async function createAdmin(app: TestAppFixture['app'], email: string, password: string): Promise<void> {
  const response = await app.inject({
    method: 'POST',
    url: '/api/auth/sign-up/email',
    payload: { email, password, name: 'Admin' },
  });
  if (response.statusCode !== 200) {
    throw new Error(`sign-up failed: ${response.statusCode.toString()} ${response.body}`);
  }
}

/** Parses every `Set-Cookie` header on `response` into a single `name=value; ...` string usable as a `Cookie` request header. */
function cookieHeaderFrom(response: { headers: Record<string, unknown> }): string {
  const raw = response.headers['set-cookie'];
  const rawCookies = Array.isArray(raw) ? raw : raw !== undefined ? [String(raw)] : [];
  const parsed = parseSetCookie.parse(rawCookies, { map: false });
  return parsed.map((cookie) => `${cookie.name}=${cookie.value}`).join('; ');
}

describe('login (AUTH-02)', () => {
  it('signs in with a valid email/password and returns a Set-Cookie header', async () => {
    fixture = await startTestApp();
    await createAdmin(fixture.app, ADMIN_EMAIL, ADMIN_PASSWORD);

    const response = await fixture.app.inject({
      method: 'POST',
      url: '/api/auth/sign-in/email',
      payload: { email: ADMIN_EMAIL, password: ADMIN_PASSWORD },
    });

    expect(response.statusCode).toBe(200);
    expect(response.headers['set-cookie']).toBeDefined();
  });

  it('keeps the session alive for a second request carrying only the cookie (session survives a reload)', async () => {
    fixture = await startTestApp();
    await createAdmin(fixture.app, ADMIN_EMAIL, ADMIN_PASSWORD);

    const signInResponse = await fixture.app.inject({
      method: 'POST',
      url: '/api/auth/sign-in/email',
      payload: { email: ADMIN_EMAIL, password: ADMIN_PASSWORD },
    });
    const cookie = cookieHeaderFrom(signInResponse);

    const sessionResponse = await fixture.app.inject({
      method: 'GET',
      url: '/api/auth/get-session',
      headers: { cookie },
    });

    expect(sessionResponse.statusCode).toBe(200);
    const body = sessionResponse.json() as { user: { email: string } } | null;
    expect(body?.user.email).toBe(ADMIN_EMAIL);
  });

  it('rejects a wrong password with 401 and no Set-Cookie header', async () => {
    fixture = await startTestApp();
    await createAdmin(fixture.app, ADMIN_EMAIL, ADMIN_PASSWORD);

    const response = await fixture.app.inject({
      method: 'POST',
      url: '/api/auth/sign-in/email',
      payload: { email: ADMIN_EMAIL, password: 'totally the wrong password' },
    });

    expect(response.statusCode).toBe(401);
    expect(response.headers['set-cookie']).toBeUndefined();
  });

  it('generates UUIDv7 ids (version nibble 7)', async () => {
    fixture = await startTestApp();
    await createAdmin(fixture.app, ADMIN_EMAIL, ADMIN_PASSWORD);

    const signInResponse = await fixture.app.inject({
      method: 'POST',
      url: '/api/auth/sign-in/email',
      payload: { email: ADMIN_EMAIL, password: ADMIN_PASSWORD },
    });
    const cookie = cookieHeaderFrom(signInResponse);

    const sessionResponse = await fixture.app.inject({
      method: 'GET',
      url: '/api/auth/get-session',
      headers: { cookie },
    });
    const body = sessionResponse.json() as { session: { id: string }; user: { id: string } };

    expect(body.session.id).toMatch(UUID_V7_PATTERN);
    expect(body.user.id).toMatch(UUID_V7_PATTERN);
  });
});
