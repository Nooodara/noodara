import { sql } from 'drizzle-orm';
import parseSetCookie from 'set-cookie-parser';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { revealSecret } from '@noodara/domain/security';
import { hashPassword } from '../../../apps/control-plane/src/auth/password-hasher.js';
import { accounts, users } from '../../../apps/control-plane/src/db/schema/auth.js';
import { issueToken } from '../../../apps/control-plane/src/services/setup-token-repository.js';
import { startTestApp, type TestAppFixture } from '../helpers/app.js';

// D-06: multi-session listing and revocation. Proven against a real, migrated PostgreSQL through
// the real HTTP surface — three sessions for the same admin (three different user agents), one
// other user's session to prove the not-my-session 404 path (AUTH-01 forbids a second admin
// through any public path, so that other user is inserted directly — see
// `createOtherUserDirectly` below), and the activity log's `auth.session_revoked` row per
// revocation (noodara-security §5, ARCHITECTURE.md §6).

const ADMIN_EMAIL = 'admin@noodara.test';
const ADMIN_PASSWORD = 'correct horse battery staple';
const OTHER_ADMIN_EMAIL = 'other-admin@noodara.test';
const OTHER_ADMIN_PASSWORD = 'another correct horse battery';

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

/**
 * Inserts a second user row directly (bypassing every public HTTP path) purely to exercise
 * `session-service.ts`'s ownership-based 404 against a genuinely different `userId`. AUTH-01
 * makes this the only way to get a second row into `users` at all once the real admin exists —
 * both `/sign-up/email` and `/api/setup` structurally refuse to ever create a second account,
 * by design. Signing in as this row afterwards still goes through the real, ungated
 * `/sign-in/email` path.
 */
async function createOtherUserDirectly(db: TestAppFixture['db'], email: string, password: string): Promise<void> {
  const passwordHash = await hashPassword(password);
  const [user] = await db.insert(users).values({ name: 'Other', email }).returning({ id: users.id });
  if (!user) throw new Error('failed to insert the other test user');
  await db.insert(accounts).values({
    accountId: user.id,
    providerId: 'credential',
    userId: user.id,
    password: passwordHash,
  });
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

async function signIn(
  app: TestAppFixture['app'],
  email: string,
  password: string,
  userAgent: string,
): Promise<{ cookie: string; token: string }> {
  const response = await app.inject({
    method: 'POST',
    url: '/api/auth/sign-in/email',
    payload: { email, password },
    headers: { 'user-agent': userAgent },
  });
  if (response.statusCode !== 200) {
    throw new Error(`sign-in failed: ${response.statusCode.toString()} ${response.body}`);
  }
  const cookie = cookieHeaderFrom(response);
  return { cookie, token: sessionTokenFromCookie(cookie) };
}

interface SessionListItem {
  id: string;
  userAgent: string | null;
  ipAddress: string | null;
  createdAt: string;
  lastSeenAt: string | null;
  expiresAt: string;
  isCurrent: boolean;
}

async function sessionIdForToken(db: TestAppFixture['db'], token: string): Promise<string> {
  const result = await db.execute<{ id: string }>(sql`select id from sessions where token = ${token}`);
  const row = result.rows[0];
  if (!row) throw new Error('no session row found for token');
  return row.id;
}

async function activityEventCount(db: TestAppFixture['db'], sessionId: string): Promise<number> {
  const result = await db.execute<{ count: string }>(
    sql`select count(*)::text as count from activity_events where action = 'auth.session_revoked' and entity_id = ${sessionId}`,
  );
  return Number(result.rows[0]?.count ?? '0');
}

describe('session management (D-06)', () => {
  it('returns 401 for GET /api/sessions without a valid cookie', async () => {
    fixture = await startTestApp();
    await createAdmin(fixture.app, fixture.db, ADMIN_EMAIL, ADMIN_PASSWORD);

    const response = await fixture.app.inject({ method: 'GET', url: '/api/sessions' });

    expect(response.statusCode).toBe(401);
  });

  it('lists every session for the caller with the required fields and exactly one isCurrent', async () => {
    fixture = await startTestApp();
    await createAdmin(fixture.app, fixture.db, ADMIN_EMAIL, ADMIN_PASSWORD);
    const session1 = await signIn(fixture.app, ADMIN_EMAIL, ADMIN_PASSWORD, 'device-1');
    const session2 = await signIn(fixture.app, ADMIN_EMAIL, ADMIN_PASSWORD, 'device-2');
    const session3 = await signIn(fixture.app, ADMIN_EMAIL, ADMIN_PASSWORD, 'device-3');

    const response = await fixture.app.inject({
      method: 'GET',
      url: '/api/sessions',
      headers: { cookie: session1.cookie },
    });

    expect(response.statusCode).toBe(200);
    const body = response.json() as SessionListItem[];
    // 4, not 3: `createAdmin` redeems the setup token via `/api/setup`, which internally signs
    // the admin up through Better Auth (auto-sign-in enabled) — that internal sign-up already
    // creates one session, in addition to the three explicit `signIn` calls above.
    expect(body).toHaveLength(4);
    for (const item of body) {
      expect(item).toHaveProperty('id');
      expect(item).toHaveProperty('userAgent');
      expect(item).toHaveProperty('ipAddress');
      expect(item).toHaveProperty('createdAt');
      expect(item).toHaveProperty('lastSeenAt');
      expect(item).toHaveProperty('expiresAt');
      expect(item).toHaveProperty('isCurrent');
    }

    const current = body.filter((item) => item.isCurrent);
    expect(current).toHaveLength(1);

    const bodyText = JSON.stringify(body);
    expect(bodyText).not.toContain(session1.token);
    expect(bodyText).not.toContain(session2.token);
    expect(bodyText).not.toContain(session3.token);
  });

  it('revokes a single session by id: the row is gone and its cookie is rejected afterwards', async () => {
    fixture = await startTestApp();
    await createAdmin(fixture.app, fixture.db, ADMIN_EMAIL, ADMIN_PASSWORD);
    const session1 = await signIn(fixture.app, ADMIN_EMAIL, ADMIN_PASSWORD, 'device-1');
    const session2 = await signIn(fixture.app, ADMIN_EMAIL, ADMIN_PASSWORD, 'device-2');
    const session2Id = await sessionIdForToken(fixture.db, session2.token);

    const deleteResponse = await fixture.app.inject({
      method: 'DELETE',
      url: `/api/sessions/${session2Id}`,
      headers: { cookie: session1.cookie },
    });
    expect(deleteResponse.statusCode).toBe(200);

    const replay = await fixture.app.inject({
      method: 'GET',
      url: '/api/auth/get-session',
      headers: { cookie: session2.cookie },
    });
    expect(replay.statusCode).toBe(200);
    expect(replay.json()).toBeNull();

    expect(await activityEventCount(fixture.db, session2Id)).toBe(1);
  });

  it('returns 404 for a session id that does not exist', async () => {
    fixture = await startTestApp();
    await createAdmin(fixture.app, fixture.db, ADMIN_EMAIL, ADMIN_PASSWORD);
    const session1 = await signIn(fixture.app, ADMIN_EMAIL, ADMIN_PASSWORD, 'device-1');

    const response = await fixture.app.inject({
      method: 'DELETE',
      url: '/api/sessions/00000000-0000-7000-8000-000000000000',
      headers: { cookie: session1.cookie },
    });

    expect(response.statusCode).toBe(404);
  });

  it('returns 404 (not 403) for a session id belonging to a different user', async () => {
    fixture = await startTestApp();
    await createAdmin(fixture.app, fixture.db, ADMIN_EMAIL, ADMIN_PASSWORD);
    await createOtherUserDirectly(fixture.db, OTHER_ADMIN_EMAIL, OTHER_ADMIN_PASSWORD);
    const session1 = await signIn(fixture.app, ADMIN_EMAIL, ADMIN_PASSWORD, 'device-1');
    const otherSession = await signIn(fixture.app, OTHER_ADMIN_EMAIL, OTHER_ADMIN_PASSWORD, 'device-other');
    const otherSessionId = await sessionIdForToken(fixture.db, otherSession.token);

    const response = await fixture.app.inject({
      method: 'DELETE',
      url: `/api/sessions/${otherSessionId}`,
      headers: { cookie: session1.cookie },
    });

    expect(response.statusCode).toBe(404);
  });

  it('revoking the current session behaves like a sign-out', async () => {
    fixture = await startTestApp();
    await createAdmin(fixture.app, fixture.db, ADMIN_EMAIL, ADMIN_PASSWORD);
    const session1 = await signIn(fixture.app, ADMIN_EMAIL, ADMIN_PASSWORD, 'device-1');
    const session1Id = await sessionIdForToken(fixture.db, session1.token);

    const response = await fixture.app.inject({
      method: 'DELETE',
      url: `/api/sessions/${session1Id}`,
      headers: { cookie: session1.cookie },
    });
    expect(response.statusCode).toBe(200);

    const replay = await fixture.app.inject({
      method: 'GET',
      url: '/api/auth/get-session',
      headers: { cookie: session1.cookie },
    });
    expect(replay.json()).toBeNull();
  });

  it('DELETE /api/sessions revokes every other session, leaving the current cookie valid', async () => {
    fixture = await startTestApp();
    await createAdmin(fixture.app, fixture.db, ADMIN_EMAIL, ADMIN_PASSWORD);
    const session1 = await signIn(fixture.app, ADMIN_EMAIL, ADMIN_PASSWORD, 'device-1');
    const session2 = await signIn(fixture.app, ADMIN_EMAIL, ADMIN_PASSWORD, 'device-2');
    const session3 = await signIn(fixture.app, ADMIN_EMAIL, ADMIN_PASSWORD, 'device-3');
    const session2Id = await sessionIdForToken(fixture.db, session2.token);
    const session3Id = await sessionIdForToken(fixture.db, session3.token);

    const response = await fixture.app.inject({
      method: 'DELETE',
      url: '/api/sessions',
      headers: { cookie: session1.cookie },
    });
    expect(response.statusCode).toBe(200);

    const remaining = await fixture.db.execute<{ count: string }>(
      sql`select count(*)::text as count from sessions where user_id = (select user_id from sessions where token = ${session1.token})`,
    );
    expect(remaining.rows[0]?.count).toBe('1');

    const stillValid = await fixture.app.inject({
      method: 'GET',
      url: '/api/auth/get-session',
      headers: { cookie: session1.cookie },
    });
    expect(stillValid.statusCode).toBe(200);
    expect(stillValid.json()).not.toBeNull();

    expect(await activityEventCount(fixture.db, session2Id)).toBe(1);
    expect(await activityEventCount(fixture.db, session3Id)).toBe(1);
  });

  it('records auth.session_revoked activity events with the session id and no token in metadata', async () => {
    fixture = await startTestApp();
    await createAdmin(fixture.app, fixture.db, ADMIN_EMAIL, ADMIN_PASSWORD);
    const session1 = await signIn(fixture.app, ADMIN_EMAIL, ADMIN_PASSWORD, 'device-1');
    const session2 = await signIn(fixture.app, ADMIN_EMAIL, ADMIN_PASSWORD, 'device-2');
    const session2Id = await sessionIdForToken(fixture.db, session2.token);

    await fixture.app.inject({
      method: 'DELETE',
      url: `/api/sessions/${session2Id}`,
      headers: { cookie: session1.cookie },
    });

    const rows = await fixture.db.execute<{ metadata: unknown }>(
      sql`select metadata from activity_events where action = 'auth.session_revoked' and entity_id = ${session2Id}`,
    );
    expect(rows.rows).toHaveLength(1);
    const metadataText = JSON.stringify(rows.rows[0]?.metadata);
    expect(metadataText).toContain(session2Id);
    expect(metadataText).not.toContain(session2.token);
  });
});
