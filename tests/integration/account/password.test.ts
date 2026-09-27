import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { revealSecret } from '@noodara/domain/security';
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
