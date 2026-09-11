import { sql } from 'drizzle-orm';
import parseSetCookie from 'set-cookie-parser';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { revealSecret } from '@noodara/domain/security';
import { issueToken } from '../../../apps/control-plane/src/services/setup-token-repository.js';
import { startTestApp, type TestAppFixture } from '../helpers/app.js';

// Better Auth's session config (Plan 01-11, session-policy.ts): D-05's sliding-7-day/hard-30-day
// ceiling proven against a real, migrated PostgreSQL through the real HTTP surface. Elapsed time
// is simulated by writing directly to `sessions.expires_at`/`absolute_expires_at` via SQL —
// deliberately never a fake-timers API, since the database's own stored timestamps (not the Node
// process clock) are what `session-policy.ts`'s hooks and Better Auth's own refresh calculation
// both read.

const ADMIN_EMAIL = 'admin@noodara.test';
const ADMIN_PASSWORD = 'correct horse battery staple';
const SEVEN_DAYS_SECONDS = 604800;
const THIRTY_DAYS_SECONDS = 2592000;
const TOLERANCE_MS = 60_000;

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

// Plan 01-12 closed the generic `/sign-up/email` door for good (AUTH-01) — the admin is created
// through `POST /api/setup` with a freshly issued one-shot token instead.
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

/** The raw bearer value Better Auth stores in `sessions.token` is the part of the cookie before any signature suffix. */
function sessionTokenFromCookie(cookie: string): string {
  const match = /session_token=([^;]+)/.exec(cookie);
  if (!match?.[1]) throw new Error('no session_token cookie found');
  return decodeURIComponent(match[1]).split('.')[0] ?? '';
}

interface SessionRow {
  created_at: Date;
  expires_at: Date;
  absolute_expires_at: Date;
}

interface RawSessionRow {
  created_at: string | Date;
  expires_at: string | Date;
  absolute_expires_at: string | Date;
}

/** `db.execute()`'s raw driver result may return timestamptz columns as ISO strings rather than
 *  already-parsed `Date` instances (unlike Drizzle's own query builder) — always coerce. */
async function readSession(db: TestAppFixture['db'], token: string): Promise<SessionRow> {
  const result = await db.execute<RawSessionRow>(
    sql`select created_at, expires_at, absolute_expires_at from sessions where token = ${token}`,
  );
  const row = result.rows[0];
  if (!row) throw new Error(`no session row found for token`);
  return {
    created_at: new Date(row.created_at),
    expires_at: new Date(row.expires_at),
    absolute_expires_at: new Date(row.absolute_expires_at),
  };
}

async function signInAndGetCookie(app: TestAppFixture['app']): Promise<{ cookie: string; token: string }> {
  const response = await app.inject({
    method: 'POST',
    url: '/api/auth/sign-in/email',
    payload: { email: ADMIN_EMAIL, password: ADMIN_PASSWORD },
  });
  const cookie = cookieHeaderFrom(response);
  return { cookie, token: sessionTokenFromCookie(cookie) };
}

describe('session lifetime (D-05: 7-day sliding, 30-day absolute ceiling)', () => {
  it('sets expires_at ~7 days out and absolute_expires_at ~30 days out on creation', async () => {
    fixture = await startTestApp();
    await createAdmin(fixture.app, fixture.db, ADMIN_EMAIL, ADMIN_PASSWORD);
    const { token } = await signInAndGetCookie(fixture.app);

    const row = await readSession(fixture.db, token);

    const expectedExpiresAt = row.created_at.getTime() + SEVEN_DAYS_SECONDS * 1000;
    const expectedAbsoluteExpiresAt = row.created_at.getTime() + THIRTY_DAYS_SECONDS * 1000;
    expect(Math.abs(row.expires_at.getTime() - expectedExpiresAt)).toBeLessThan(TOLERANCE_MS);
    expect(Math.abs(row.absolute_expires_at.getTime() - expectedAbsoluteExpiresAt)).toBeLessThan(TOLERANCE_MS);
  });

  it('leaves expires_at byte-identical on a second request inside the same updateAge window', async () => {
    fixture = await startTestApp();
    await createAdmin(fixture.app, fixture.db, ADMIN_EMAIL, ADMIN_PASSWORD);
    const { cookie, token } = await signInAndGetCookie(fixture.app);

    const before = await readSession(fixture.db, token);

    const response = await fixture.app.inject({
      method: 'GET',
      url: '/api/auth/get-session',
      headers: { cookie },
    });
    expect(response.statusCode).toBe(200);

    const after = await readSession(fixture.db, token);
    expect(after.expires_at).toEqual(before.expires_at);
  });

  it('extends expires_at on a refresh past updateAge, never exceeding absolute_expires_at', async () => {
    fixture = await startTestApp();
    await createAdmin(fixture.app, fixture.db, ADMIN_EMAIL, ADMIN_PASSWORD);
    const { cookie, token } = await signInAndGetCookie(fixture.app);

    // Backdate expires_at so Better Auth's own `shouldBeUpdated` calculation is true (still in
    // the future, so the session is not simply expired — just due for a sliding refresh).
    await fixture.db.execute(
      sql`update sessions set expires_at = now() + interval '1 hour' where token = ${token}`,
    );
    const before = await readSession(fixture.db, token);

    const response = await fixture.app.inject({
      method: 'GET',
      url: '/api/auth/get-session',
      headers: { cookie },
    });
    expect(response.statusCode).toBe(200);

    const after = await readSession(fixture.db, token);
    expect(after.expires_at.getTime()).toBeGreaterThan(before.expires_at.getTime());
    expect(after.expires_at.getTime()).toBeLessThanOrEqual(after.absolute_expires_at.getTime());
  });

  it('clamps expires_at into the past when absolute_expires_at has already passed, rejecting the cookie afterwards', async () => {
    fixture = await startTestApp();
    await createAdmin(fixture.app, fixture.db, ADMIN_EMAIL, ADMIN_PASSWORD);
    const { cookie, token } = await signInAndGetCookie(fixture.app);

    await fixture.db.execute(
      sql`update sessions set expires_at = now() + interval '1 hour', absolute_expires_at = now() - interval '1 day' where token = ${token}`,
    );

    // First request triggers the refresh; session-policy.ts's update hook clamps the proposed
    // new expires_at down to the already-past absolute_expires_at.
    const refreshResponse = await fixture.app.inject({
      method: 'GET',
      url: '/api/auth/get-session',
      headers: { cookie },
    });
    expect(refreshResponse.statusCode).toBe(200);

    const after = await readSession(fixture.db, token);
    expect(after.expires_at.getTime()).toBeLessThan(Date.now());

    // Second request now sees an already-expired session and reports unauthenticated.
    const replayResponse = await fixture.app.inject({
      method: 'GET',
      url: '/api/auth/get-session',
      headers: { cookie },
    });
    expect(replayResponse.statusCode).toBe(200);
    expect(replayResponse.json()).toBeNull();
  });

  it('rejects a session simply left idle past expires_at', async () => {
    fixture = await startTestApp();
    await createAdmin(fixture.app, fixture.db, ADMIN_EMAIL, ADMIN_PASSWORD);
    const { cookie, token } = await signInAndGetCookie(fixture.app);

    await fixture.db.execute(sql`update sessions set expires_at = now() - interval '1 hour' where token = ${token}`);

    const response = await fixture.app.inject({
      method: 'GET',
      url: '/api/auth/get-session',
      headers: { cookie },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toBeNull();
  });
});
