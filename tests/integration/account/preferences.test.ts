import { sql } from 'drizzle-orm';
import parseSetCookie from 'set-cookie-parser';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { revealSecret } from '@noodara/domain/security';
import { activityEvents } from '../../../apps/control-plane/src/db/schema/activity-events.js';
import { users } from '../../../apps/control-plane/src/db/schema/auth.js';
import { issueToken } from '../../../apps/control-plane/src/services/setup-token-repository.js';
import { startTestApp, type TestAppFixture } from '../helpers/app.js';

// SET-04/SET-05/D-09/D-10/D-16: `GET`/`PATCH /api/account/preferences` against a real HTTP
// surface and a real migrated Postgres. The server is the source of truth for theme/reduceMotion/
// density (D-16), and every response refreshes the `noodara-prefs` mirror cookie (D-09) so a
// second browser session sees whatever the first one saved (D-10).

const ADMIN_EMAIL = 'admin@noodara.test';
const ADMIN_PASSWORD = 'correct horse battery staple';
const FOREIGN_ORIGIN = 'https://evil.example';

let fixture: TestAppFixture | undefined;

beforeEach(() => {
  vi.resetModules();
  delete process.env.NOODARA_COOKIE_INSECURE;
});

afterEach(async () => {
  await fixture?.stop();
  fixture = undefined;
  delete process.env.NOODARA_COOKIE_INSECURE;

  const { getContainerRuntimeClient } = await import('testcontainers');
  const client = await getContainerRuntimeClient();
  const containers = await client.container.list();
  const stray = containers.filter((c) => c.Labels['noodara.test'] === 'true');
  expect(stray).toHaveLength(0);
});

function cookieHeaderFrom(response: { headers: Record<string, unknown> }): string {
  const raw = response.headers['set-cookie'];
  const rawCookies = Array.isArray(raw) ? raw : raw !== undefined ? [String(raw)] : [];
  const parsed = parseSetCookie.parse(rawCookies, { map: false });
  return parsed.map((cookie) => `${cookie.name}=${cookie.value}`).join('; ');
}

function preferencesCookieFrom(response: { headers: Record<string, unknown> }): ReturnType<typeof parseSetCookie.parse> {
  const raw = response.headers['set-cookie'];
  const rawCookies = Array.isArray(raw) ? raw : raw !== undefined ? [String(raw)] : [];
  const parsed = parseSetCookie.parse(rawCookies, { map: false });
  return parsed.filter((cookie) => cookie.name === 'noodara-prefs');
}

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

describe('GET/PATCH /api/account/preferences (SET-04/SET-05)', () => {
  it('GET returns defaults for a fresh admin and sets the noodara-prefs mirror cookie', async () => {
    fixture = await startTestApp();
    await createAdmin(fixture.app, fixture.db, ADMIN_EMAIL, ADMIN_PASSWORD);
    const cookie = await signIn(fixture.app, ADMIN_EMAIL, ADMIN_PASSWORD);

    const response = await fixture.app.inject({
      method: 'GET',
      url: '/api/account/preferences',
      headers: { cookie },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toStrictEqual({ theme: 'auto', reduceMotion: 'system', density: 'comfortable' });

    const prefsCookies = preferencesCookieFrom(response);
    expect(prefsCookies).toHaveLength(1);
    expect(prefsCookies[0]?.value).toBe('auto.system.comfortable');
  });

  it('PATCH { theme: dark } persists on the user, returns the merged result, and sets the mirror cookie', async () => {
    fixture = await startTestApp();
    await createAdmin(fixture.app, fixture.db, ADMIN_EMAIL, ADMIN_PASSWORD);
    const cookie = await signIn(fixture.app, ADMIN_EMAIL, ADMIN_PASSWORD);

    const response = await fixture.app.inject({
      method: 'PATCH',
      url: '/api/account/preferences',
      headers: { cookie },
      payload: { theme: 'dark' },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toStrictEqual({ theme: 'dark', reduceMotion: 'system', density: 'comfortable' });

    const [row] = await fixture.db.select({ preferences: users.preferences }).from(users);
    expect(row?.preferences).toStrictEqual({ theme: 'dark', reduceMotion: 'system', density: 'comfortable' });

    const prefsCookies = preferencesCookieFrom(response);
    expect(prefsCookies).toHaveLength(1);
    expect(prefsCookies[0]?.value).toBe('dark.system.comfortable');
  });

  it('a second PATCH { density: compact } keeps the previously set theme (D-16 merge)', async () => {
    fixture = await startTestApp();
    await createAdmin(fixture.app, fixture.db, ADMIN_EMAIL, ADMIN_PASSWORD);
    const cookie = await signIn(fixture.app, ADMIN_EMAIL, ADMIN_PASSWORD);

    await fixture.app.inject({
      method: 'PATCH',
      url: '/api/account/preferences',
      headers: { cookie },
      payload: { theme: 'dark' },
    });

    const response = await fixture.app.inject({
      method: 'PATCH',
      url: '/api/account/preferences',
      headers: { cookie },
      payload: { density: 'compact' },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toStrictEqual({ theme: 'dark', reduceMotion: 'system', density: 'compact' });
  });

  it('a second session GETs the value the first session PATCHed (D-10)', async () => {
    fixture = await startTestApp();
    await createAdmin(fixture.app, fixture.db, ADMIN_EMAIL, ADMIN_PASSWORD);
    const firstCookie = await signIn(fixture.app, ADMIN_EMAIL, ADMIN_PASSWORD);

    await fixture.app.inject({
      method: 'PATCH',
      url: '/api/account/preferences',
      headers: { cookie: firstCookie },
      payload: { theme: 'dark', density: 'compact' },
    });

    const secondCookie = await signIn(fixture.app, ADMIN_EMAIL, ADMIN_PASSWORD);
    const response = await fixture.app.inject({
      method: 'GET',
      url: '/api/account/preferences',
      headers: { cookie: secondCookie },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toStrictEqual({ theme: 'dark', reduceMotion: 'system', density: 'compact' });
  });

  it('rejects an empty patch with 400 and leaves the DB unchanged', async () => {
    fixture = await startTestApp();
    await createAdmin(fixture.app, fixture.db, ADMIN_EMAIL, ADMIN_PASSWORD);
    const cookie = await signIn(fixture.app, ADMIN_EMAIL, ADMIN_PASSWORD);

    const response = await fixture.app.inject({
      method: 'PATCH',
      url: '/api/account/preferences',
      headers: { cookie },
      payload: {},
    });

    expect(response.statusCode).toBe(400);

    const [row] = await fixture.db.select({ preferences: users.preferences }).from(users);
    expect(row?.preferences).toStrictEqual({});
  });

  it('rejects an invalid enum value with 400 and leaves the DB unchanged', async () => {
    fixture = await startTestApp();
    await createAdmin(fixture.app, fixture.db, ADMIN_EMAIL, ADMIN_PASSWORD);
    const cookie = await signIn(fixture.app, ADMIN_EMAIL, ADMIN_PASSWORD);

    const response = await fixture.app.inject({
      method: 'PATCH',
      url: '/api/account/preferences',
      headers: { cookie },
      payload: { theme: 'purple' },
    });

    expect(response.statusCode).toBe(400);

    const [row] = await fixture.db.select({ preferences: users.preferences }).from(users);
    expect(row?.preferences).toStrictEqual({});
  });

  it('rejects a mass-assignment attempt (userId key) with 400 and leaves the DB unchanged', async () => {
    fixture = await startTestApp();
    await createAdmin(fixture.app, fixture.db, ADMIN_EMAIL, ADMIN_PASSWORD);
    const cookie = await signIn(fixture.app, ADMIN_EMAIL, ADMIN_PASSWORD);

    const response = await fixture.app.inject({
      method: 'PATCH',
      url: '/api/account/preferences',
      headers: { cookie },
      payload: { theme: 'dark', userId: 'someone-else' },
    });

    expect(response.statusCode).toBe(400);

    const [row] = await fixture.db.select({ preferences: users.preferences }).from(users);
    expect(row?.preferences).toStrictEqual({});
  });

  it('rejects an unauthenticated GET with 401', async () => {
    fixture = await startTestApp();
    await createAdmin(fixture.app, fixture.db, ADMIN_EMAIL, ADMIN_PASSWORD);

    const response = await fixture.app.inject({ method: 'GET', url: '/api/account/preferences' });

    expect(response.statusCode).toBe(401);
  });

  it('rejects a cross-origin PATCH with 403 FORBIDDEN_ORIGIN', async () => {
    fixture = await startTestApp();
    await createAdmin(fixture.app, fixture.db, ADMIN_EMAIL, ADMIN_PASSWORD);
    const cookie = await signIn(fixture.app, ADMIN_EMAIL, ADMIN_PASSWORD);

    const response = await fixture.app.inject({
      method: 'PATCH',
      url: '/api/account/preferences',
      headers: { cookie, origin: FOREIGN_ORIGIN },
      payload: { theme: 'dark' },
    });

    expect(response.statusCode).toBe(403);
    expect(response.json()).toStrictEqual({ error: 'FORBIDDEN_ORIGIN', message: expect.any(String) });
  });

  it('GET on a corrupted jsonb row defaults the bad field and ignores extra keys (T-09-26)', async () => {
    fixture = await startTestApp();
    await createAdmin(fixture.app, fixture.db, ADMIN_EMAIL, ADMIN_PASSWORD);
    const cookie = await signIn(fixture.app, ADMIN_EMAIL, ADMIN_PASSWORD);

    await fixture.db.execute(
      sql`update "users" set preferences = '{"theme": 42, "extra": true, "density": "compact"}'::jsonb`,
    );

    const response = await fixture.app.inject({
      method: 'GET',
      url: '/api/account/preferences',
      headers: { cookie },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toStrictEqual({ theme: 'auto', reduceMotion: 'system', density: 'compact' });
  });

  it('never writes an activity event for a preference change (D-08)', async () => {
    fixture = await startTestApp();
    await createAdmin(fixture.app, fixture.db, ADMIN_EMAIL, ADMIN_PASSWORD);
    const cookie = await signIn(fixture.app, ADMIN_EMAIL, ADMIN_PASSWORD);

    const before = await fixture.db.select().from(activityEvents);

    await fixture.app.inject({
      method: 'PATCH',
      url: '/api/account/preferences',
      headers: { cookie },
      payload: { theme: 'dark' },
    });
    await fixture.app.inject({
      method: 'PATCH',
      url: '/api/account/preferences',
      headers: { cookie },
      payload: { density: 'compact' },
    });
    await fixture.app.inject({ method: 'GET', url: '/api/account/preferences', headers: { cookie } });

    const after = await fixture.db.select().from(activityEvents);
    expect(after).toHaveLength(before.length);
  });

  it('sets a non-HttpOnly, Secure mirror cookie by default', async () => {
    fixture = await startTestApp();
    await createAdmin(fixture.app, fixture.db, ADMIN_EMAIL, ADMIN_PASSWORD);
    const cookie = await signIn(fixture.app, ADMIN_EMAIL, ADMIN_PASSWORD);

    const response = await fixture.app.inject({
      method: 'GET',
      url: '/api/account/preferences',
      headers: { cookie },
    });

    const prefsCookies = preferencesCookieFrom(response);
    expect(prefsCookies).toHaveLength(1);
    expect(prefsCookies[0]?.httpOnly).toBeFalsy();
    expect(prefsCookies[0]?.secure).toBe(true);
  });

  it('omits Secure when NOODARA_COOKIE_INSECURE is true', async () => {
    process.env.NOODARA_COOKIE_INSECURE = 'true';
    fixture = await startTestApp();
    await createAdmin(fixture.app, fixture.db, ADMIN_EMAIL, ADMIN_PASSWORD);
    const cookie = await signIn(fixture.app, ADMIN_EMAIL, ADMIN_PASSWORD);

    const response = await fixture.app.inject({
      method: 'GET',
      url: '/api/account/preferences',
      headers: { cookie },
    });

    const prefsCookies = preferencesCookieFrom(response);
    expect(prefsCookies).toHaveLength(1);
    expect(prefsCookies[0]?.secure).toBeFalsy();
  });
});
