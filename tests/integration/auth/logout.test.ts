import { sql } from 'drizzle-orm';
import parseSetCookie from 'set-cookie-parser';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { startTestApp, type TestAppFixture } from '../helpers/app.js';

// Better Auth mounted in Fastify (Plan 01-10): AUTH-03 — logout invalidates the session
// server-side, not just by clearing the browser's cookie.

const ADMIN_EMAIL = 'admin@noodara.test';
const ADMIN_PASSWORD = 'correct horse battery staple';

let fixture: TestAppFixture | undefined;

// See login.test.ts: `auth.ts` caches its own `pg.Pool` at module scope, so each test needs a
// fresh module graph bound to its own freshly started container.
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

function cookieHeaderFrom(response: { headers: Record<string, unknown> }): string {
  const raw = response.headers['set-cookie'];
  const rawCookies = Array.isArray(raw) ? raw : raw !== undefined ? [String(raw)] : [];
  const parsed = parseSetCookie.parse(rawCookies, { map: false });
  return parsed.map((cookie) => `${cookie.name}=${cookie.value}`).join('; ');
}

/** The raw bearer value Better Auth stores in `sessions.token` is the part of the cookie before any signature suffix. */
function sessionTokenFromCookie(cookie: string): string {
  const match = /session_token=([^;]+)/.exec(cookie);
  if (!match?.[1]) throw new Error('no session_token cookie found');
  return decodeURIComponent(match[1]).split('.')[0] ?? '';
}

describe('logout (AUTH-03)', () => {
  it('returns 200 and, replaying the same cookie afterwards, get-session reports no session', async () => {
    fixture = await startTestApp();
    await createAdmin(fixture.app, ADMIN_EMAIL, ADMIN_PASSWORD);

    const signInResponse = await fixture.app.inject({
      method: 'POST',
      url: '/api/auth/sign-in/email',
      payload: { email: ADMIN_EMAIL, password: ADMIN_PASSWORD },
    });
    const cookie = cookieHeaderFrom(signInResponse);

    const signOutResponse = await fixture.app.inject({
      method: 'POST',
      url: '/api/auth/sign-out',
      headers: { cookie },
    });
    expect(signOutResponse.statusCode).toBe(200);

    const replayedResponse = await fixture.app.inject({
      method: 'GET',
      url: '/api/auth/get-session',
      headers: { cookie },
    });
    expect(replayedResponse.statusCode).toBe(200);
    expect(replayedResponse.json()).toBeNull();
  });

  it('deletes the corresponding row from the sessions table (server-side invalidation)', async () => {
    fixture = await startTestApp();
    await createAdmin(fixture.app, ADMIN_EMAIL, ADMIN_PASSWORD);

    const signInResponse = await fixture.app.inject({
      method: 'POST',
      url: '/api/auth/sign-in/email',
      payload: { email: ADMIN_EMAIL, password: ADMIN_PASSWORD },
    });
    const cookie = cookieHeaderFrom(signInResponse);
    const token = sessionTokenFromCookie(cookie);

    const beforeCount = await fixture.db.execute<{ count: string }>(
      sql`select count(*)::text as count from sessions where token = ${token}`,
    );
    expect(beforeCount.rows[0]?.count).toBe('1');

    await fixture.app.inject({ method: 'POST', url: '/api/auth/sign-out', headers: { cookie } });

    const afterCount = await fixture.db.execute<{ count: string }>(
      sql`select count(*)::text as count from sessions where token = ${token}`,
    );
    expect(afterCount.rows[0]?.count).toBe('0');
  });
});
