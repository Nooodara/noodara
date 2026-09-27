import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_MAX_ATTEMPTS, revealSecret } from '@noodara/domain/security';
import { activityEvents } from '../../../apps/control-plane/src/db/schema/activity-events.js';
import { sessions, users } from '../../../apps/control-plane/src/db/schema/auth.js';
import { issueToken } from '../../../apps/control-plane/src/services/setup-token-repository.js';
import { startTestApp, type TestAppFixture } from '../helpers/app.js';

// SET-03/D-05/D-06/D-07/D-08: `POST /api/account/password` against the real HTTP surface and a
// real, migrated Postgres. The "Better Auth 1.7.4 changePassword contract" describe below pins
// the exact third-party behaviour (ADR 0004) the rest of this plan is built around, calling
// `auth.api.changePassword` directly rather than through this plan's own not-yet-written route.

const ADMIN_EMAIL = 'admin@noodara.test';
const ADMIN_PASSWORD = 'correct horse battery staple';
const NEW_PASSWORD = 'another correct horse battery staple';

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
  return rawCookies.map((cookie) => String(cookie).split(';')[0]).join('; ');
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

describe('Better Auth 1.7.4 changePassword contract', () => {
  it(
    'revokeOtherSessions deletes every other session and rotates the caller\'s own token, ' +
      'returning { headers, response: { token, user } } with no revoked-session count',
    async () => {
      fixture = await startTestApp();
      await createAdmin(fixture.app, fixture.db, ADMIN_EMAIL, ADMIN_PASSWORD);
      const cookieA = await signIn(fixture.app, ADMIN_EMAIL, ADMIN_PASSWORD);
      const cookieB = await signIn(fixture.app, ADMIN_EMAIL, ADMIN_PASSWORD);

      const { auth } = await import('../../../apps/control-plane/src/auth/auth.js');

      const result = await auth.api.changePassword({
        body: { currentPassword: ADMIN_PASSWORD, newPassword: NEW_PASSWORD, revokeOtherSessions: true },
        headers: new Headers({ cookie: cookieA }),
        returnHeaders: true,
      });

      expect(result.response.user.email).toBe(ADMIN_EMAIL);
      expect(result.response).not.toHaveProperty('sessionsRevoked');
      const setCookie = result.headers.get('set-cookie');
      expect(setCookie).toBeTruthy();

      const checkA = await fixture.app.inject({
        method: 'GET',
        url: '/api/auth/get-session',
        headers: { cookie: cookieA },
      });
      expect(checkA.statusCode).toBe(200);
      expect(checkA.json()).toBeNull();

      const checkB = await fixture.app.inject({
        method: 'GET',
        url: '/api/auth/get-session',
        headers: { cookie: cookieB },
      });
      expect(checkB.statusCode).toBe(200);
      expect(checkB.json()).toBeNull();

      const rotatedCookie = String(setCookie).split(';')[0];
      const checkRotated = await fixture.app.inject({
        method: 'GET',
        url: '/api/auth/get-session',
        headers: { cookie: rotatedCookie },
      });
      expect(checkRotated.statusCode).toBe(200);
      expect(checkRotated.json()).not.toBeNull();
    },
  );

  it('a wrong currentPassword rejects with an APIError shaped { status: "BAD_REQUEST", body: { code: "INVALID_PASSWORD" } }', async () => {
    fixture = await startTestApp();
    await createAdmin(fixture.app, fixture.db, ADMIN_EMAIL, ADMIN_PASSWORD);
    const cookieA = await signIn(fixture.app, ADMIN_EMAIL, ADMIN_PASSWORD);

    const { auth } = await import('../../../apps/control-plane/src/auth/auth.js');

    // `better-auth/api` is only a direct dependency of apps/control-plane, not of this test's own
    // workspace location — resolved structurally here (status/statusCode/body.code) rather than
    // via a bare `better-auth/api` import, which would fail to resolve from tests/. Production
    // code (change-account-password.ts, inside apps/control-plane) still uses the real
    // `isAPIError` from `better-auth/api`, exactly like login-guard.ts already does.
    let caught: unknown;
    try {
      await auth.api.changePassword({
        body: { currentPassword: 'totally wrong', newPassword: NEW_PASSWORD, revokeOtherSessions: true },
        headers: new Headers({ cookie: cookieA }),
        returnHeaders: true,
      });
    } catch (error) {
      caught = error;
    }

    const apiError = caught as { name?: string; status?: string; statusCode?: number; body?: { code?: string } };
    expect(apiError.name).toBe('APIError');
    expect(apiError.status).toBe('BAD_REQUEST');
    expect(apiError.statusCode).toBe(400);
    expect(apiError.body?.code).toBe('INVALID_PASSWORD');

    const stillValid = await fixture.app.inject({
      method: 'GET',
      url: '/api/auth/get-session',
      headers: { cookie: cookieA },
    });
    expect(stillValid.statusCode).toBe(200);
    expect(stillValid.json()).not.toBeNull();
  });
});

describe('session revocation markers', () => {
  it('records and finds an unexpired marker, and never stores the raw token', async () => {
    fixture = await startTestApp();
    const { recordPasswordChangeRevocations, findRevocationReason } = await import(
      '../../../apps/control-plane/src/auth/session-revocation-markers.js'
    );
    const { verifications } = await import('../../../apps/control-plane/src/db/schema/auth.js');

    const now = new Date('2026-01-01T00:00:00Z');
    const token = 'super-secret-raw-session-token';
    const expiresAt = new Date(now.getTime() + 60_000);

    await recordPasswordChangeRevocations(fixture.db, [{ token, expiresAt }], now);

    const reason = await findRevocationReason(fixture.db, token, now);
    expect(reason).toBe('password_changed');

    const rows = await fixture.db.select().from(verifications);
    const serialized = JSON.stringify(rows);
    expect(serialized).not.toContain(token);
  });

  it('returns null for an unknown token', async () => {
    fixture = await startTestApp();
    const { findRevocationReason } = await import('../../../apps/control-plane/src/auth/session-revocation-markers.js');

    const reason = await findRevocationReason(fixture.db, 'never-recorded-token', new Date());
    expect(reason).toBeNull();
  });

  it('returns null for an expired marker', async () => {
    fixture = await startTestApp();
    const { recordPasswordChangeRevocations, findRevocationReason } = await import(
      '../../../apps/control-plane/src/auth/session-revocation-markers.js'
    );

    const now = new Date('2026-01-01T00:00:00Z');
    const token = 'a-token-that-will-expire';
    const expiresAt = new Date(now.getTime() - 1000);

    await recordPasswordChangeRevocations(fixture.db, [{ token, expiresAt }], now);

    const reason = await findRevocationReason(fixture.db, token, now);
    expect(reason).toBeNull();
  });

  it('is a no-op for an empty session list', async () => {
    fixture = await startTestApp();
    const { recordPasswordChangeRevocations } = await import(
      '../../../apps/control-plane/src/auth/session-revocation-markers.js'
    );

    await expect(recordPasswordChangeRevocations(fixture.db, [], new Date())).resolves.toBeUndefined();
  });
});

async function activityRowsFor(db: TestAppFixture['db'], entityId: string): Promise<(typeof activityEvents.$inferSelect)[]> {
  return db.select().from(activityEvents).where(eq(activityEvents.entityId, entityId));
}

async function adminId(db: TestAppFixture['db'], email: string): Promise<string> {
  const [row] = await db.select({ id: users.id }).from(users).where(eq(users.email, email));
  if (!row) throw new Error('admin row not found');
  return row.id;
}

/** `auth.api.signUpEmail` (setup-service.ts, out of this plan's scope) auto-creates a session row
 *  nobody ever captures a cookie for — deleting it here gives each test below a genuinely known
 *  session count to assert against, matching this plan's own literal behavior bullets ("a
 *  single-session admin" etc.) rather than this pre-existing, unrelated setup quirk. */
async function clearAllSessions(db: TestAppFixture['db']): Promise<void> {
  await db.delete(sessions);
}

describe('POST /api/account/password (SET-03)', () => {
  it('revokes every other session, keeps the caller signed in via its rotated cookie, and reports the exact count', async () => {
    fixture = await startTestApp();
    await createAdmin(fixture.app, fixture.db, ADMIN_EMAIL, ADMIN_PASSWORD);
    await clearAllSessions(fixture.db);
    const cookieA = await signIn(fixture.app, ADMIN_EMAIL, ADMIN_PASSWORD);
    const cookieB = await signIn(fixture.app, ADMIN_EMAIL, ADMIN_PASSWORD);
    const cookieC = await signIn(fixture.app, ADMIN_EMAIL, ADMIN_PASSWORD);

    const response = await fixture.app.inject({
      method: 'POST',
      url: '/api/account/password',
      headers: { cookie: cookieA },
      payload: { currentPassword: ADMIN_PASSWORD, newPassword: NEW_PASSWORD },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toStrictEqual({ sessionsRevoked: 2 });
    expect(response.body).not.toContain('token');

    const rotatedCookie = cookieHeaderFrom(response);
    expect(rotatedCookie).toBeTruthy();

    const withRotated = await fixture.app.inject({ method: 'GET', url: '/api/config', headers: { cookie: rotatedCookie } });
    expect(withRotated.statusCode).toBe(200);

    const withB = await fixture.app.inject({ method: 'GET', url: '/api/config', headers: { cookie: cookieB } });
    expect(withB.statusCode).toBe(401);
    expect(withB.json()).toStrictEqual({ error: 'SESSION_REVOKED_PASSWORD_CHANGED', message: expect.any(String) });

    const withC = await fixture.app.inject({ method: 'GET', url: '/api/config', headers: { cookie: cookieC } });
    expect(withC.statusCode).toBe(401);
    expect(withC.json()).toStrictEqual({ error: 'SESSION_REVOKED_PASSWORD_CHANGED', message: expect.any(String) });

    const withInvalid = await fixture.app.inject({
      method: 'GET',
      url: '/api/config',
      headers: { cookie: 'noodara-unrelated-cookie=never-valid-at-all' },
    });
    expect(withInvalid.statusCode).toBe(401);
    expect(withInvalid.json()).toStrictEqual({ error: 'UNAUTHORIZED', message: expect.any(String) });

    const oldPasswordSignIn = await fixture.app.inject({
      method: 'POST',
      url: '/api/auth/sign-in/email',
      payload: { email: ADMIN_EMAIL, password: ADMIN_PASSWORD },
    });
    expect(oldPasswordSignIn.statusCode).not.toBe(200);

    const newPasswordSignIn = await fixture.app.inject({
      method: 'POST',
      url: '/api/auth/sign-in/email',
      payload: { email: ADMIN_EMAIL, password: NEW_PASSWORD },
    });
    expect(newPasswordSignIn.statusCode).toBe(200);

    const id = await adminId(fixture.db, ADMIN_EMAIL);
    const rows = await activityRowsFor(fixture.db, id);
    const passwordChanged = rows.filter((r) => r.action === 'account.password_changed');
    expect(passwordChanged).toHaveLength(1);
    expect(passwordChanged[0]?.metadata).toStrictEqual({ sessions_revoked: 2 });
  });

  it('a single-session admin sees { sessionsRevoked: 0 }', async () => {
    fixture = await startTestApp();
    await createAdmin(fixture.app, fixture.db, ADMIN_EMAIL, ADMIN_PASSWORD);
    await clearAllSessions(fixture.db);
    const cookie = await signIn(fixture.app, ADMIN_EMAIL, ADMIN_PASSWORD);

    const response = await fixture.app.inject({
      method: 'POST',
      url: '/api/account/password',
      headers: { cookie },
      payload: { currentPassword: ADMIN_PASSWORD, newPassword: NEW_PASSWORD },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toStrictEqual({ sessionsRevoked: 0 });
  });

  it('rejects a wrong currentPassword with 400 INVALID_CREDENTIAL, keeps other sessions alive, writes no activity row', async () => {
    fixture = await startTestApp();
    await createAdmin(fixture.app, fixture.db, ADMIN_EMAIL, ADMIN_PASSWORD);
    await clearAllSessions(fixture.db);
    const cookieA = await signIn(fixture.app, ADMIN_EMAIL, ADMIN_PASSWORD);
    const cookieB = await signIn(fixture.app, ADMIN_EMAIL, ADMIN_PASSWORD);

    const response = await fixture.app.inject({
      method: 'POST',
      url: '/api/account/password',
      headers: { cookie: cookieA },
      payload: { currentPassword: 'totally wrong', newPassword: NEW_PASSWORD },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toStrictEqual({
      error: 'INVALID_CREDENTIAL',
      message: expect.any(String),
      issues: [{ path: 'currentPassword', message: expect.any(String) }],
    });

    const stillValidB = await fixture.app.inject({ method: 'GET', url: '/api/config', headers: { cookie: cookieB } });
    expect(stillValidB.statusCode).toBe(200);

    const id = await adminId(fixture.db, ADMIN_EMAIL);
    const rows = await activityRowsFor(fixture.db, id);
    expect(rows.filter((r) => r.action === 'account.password_changed')).toHaveLength(0);
  });

  it('locks after 5 wrong attempts with 429 REAUTH_LOCKED and a Retry-After header', async () => {
    fixture = await startTestApp();
    await createAdmin(fixture.app, fixture.db, ADMIN_EMAIL, ADMIN_PASSWORD);
    await clearAllSessions(fixture.db);
    const cookie = await signIn(fixture.app, ADMIN_EMAIL, ADMIN_PASSWORD);

    for (let i = 0; i < DEFAULT_MAX_ATTEMPTS; i++) {
      await fixture.app.inject({
        method: 'POST',
        url: '/api/account/password',
        headers: { cookie },
        payload: { currentPassword: 'totally wrong', newPassword: NEW_PASSWORD },
      });
    }

    const locked = await fixture.app.inject({
      method: 'POST',
      url: '/api/account/password',
      headers: { cookie },
      payload: { currentPassword: 'totally wrong', newPassword: NEW_PASSWORD },
    });
    expect(locked.statusCode).toBe(429);
    expect(locked.headers['retry-after']).toBeDefined();
  });

  it.each([
    ['too short', 'short12345'],
    ['too long', `${'a'.repeat(129)}`],
    ['common password', 'password1234'],
  ])('rejects a weak new password (%s) with 400 VALIDATION_FAILED and revokes nothing', async (_label, newPassword) => {
    fixture = await startTestApp();
    await createAdmin(fixture.app, fixture.db, ADMIN_EMAIL, ADMIN_PASSWORD);
    await clearAllSessions(fixture.db);
    const cookieA = await signIn(fixture.app, ADMIN_EMAIL, ADMIN_PASSWORD);
    const cookieB = await signIn(fixture.app, ADMIN_EMAIL, ADMIN_PASSWORD);

    const response = await fixture.app.inject({
      method: 'POST',
      url: '/api/account/password',
      headers: { cookie: cookieA },
      payload: { currentPassword: ADMIN_PASSWORD, newPassword },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toStrictEqual({
      error: 'VALIDATION_FAILED',
      message: expect.any(String),
      issues: [{ path: 'newPassword', message: expect.any(String) }],
    });

    const stillValidB = await fixture.app.inject({ method: 'GET', url: '/api/config', headers: { cookie: cookieB } });
    expect(stillValidB.statusCode).toBe(200);
  });

  it('rejects a body carrying revokeOtherSessions or userId with 400 (schema, mass-assignment guard)', async () => {
    fixture = await startTestApp();
    await createAdmin(fixture.app, fixture.db, ADMIN_EMAIL, ADMIN_PASSWORD);
    await clearAllSessions(fixture.db);
    const cookie = await signIn(fixture.app, ADMIN_EMAIL, ADMIN_PASSWORD);

    const withRevoke = await fixture.app.inject({
      method: 'POST',
      url: '/api/account/password',
      headers: { cookie },
      payload: { currentPassword: ADMIN_PASSWORD, newPassword: NEW_PASSWORD, revokeOtherSessions: false },
    });
    expect(withRevoke.statusCode).toBe(400);

    const withUserId = await fixture.app.inject({
      method: 'POST',
      url: '/api/account/password',
      headers: { cookie },
      payload: { currentPassword: ADMIN_PASSWORD, newPassword: NEW_PASSWORD, userId: 'someone-else' },
    });
    expect(withUserId.statusCode).toBe(400);
  });

  it('rejects an unauthenticated request with 401', async () => {
    fixture = await startTestApp();
    await createAdmin(fixture.app, fixture.db, ADMIN_EMAIL, ADMIN_PASSWORD);
    await clearAllSessions(fixture.db);

    const response = await fixture.app.inject({
      method: 'POST',
      url: '/api/account/password',
      payload: { currentPassword: ADMIN_PASSWORD, newPassword: NEW_PASSWORD },
    });

    expect(response.statusCode).toBe(401);
  });

  it('rejects a cross-origin request with 403 FORBIDDEN_ORIGIN', async () => {
    fixture = await startTestApp();
    await createAdmin(fixture.app, fixture.db, ADMIN_EMAIL, ADMIN_PASSWORD);
    await clearAllSessions(fixture.db);
    const cookie = await signIn(fixture.app, ADMIN_EMAIL, ADMIN_PASSWORD);

    const response = await fixture.app.inject({
      method: 'POST',
      url: '/api/account/password',
      headers: { cookie, origin: 'https://evil.example' },
      payload: { currentPassword: ADMIN_PASSWORD, newPassword: NEW_PASSWORD },
    });

    expect(response.statusCode).toBe(403);
    expect(response.json()).toStrictEqual({ error: 'FORBIDDEN_ORIGIN', message: expect.any(String) });
  });
});
