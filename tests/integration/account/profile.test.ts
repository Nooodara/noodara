import parseSetCookie from 'set-cookie-parser';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_MAX_ATTEMPTS, revealSecret } from '@noodara/domain/security';
import type { DnsChecker, DnsCheckOutcome } from '../../../apps/control-plane/src/auth/dns-checker.js';
import { activityEvents } from '../../../apps/control-plane/src/db/schema/activity-events.js';
import { accounts, users } from '../../../apps/control-plane/src/db/schema/auth.js';
import { issueToken } from '../../../apps/control-plane/src/services/setup-token-repository.js';
import { startTestApp, type TestAppFixture } from '../helpers/app.js';

// SET-02/D-02/D-03/D-08: `PATCH /api/account/profile` against the real HTTP surface, a real
// migrated Postgres and a fake, injected `DnsChecker` (ADR 0004 — never the machine's own
// resolver in a test process).

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

function fakeDnsChecker(outcome: DnsCheckOutcome): DnsChecker & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    async checkEmailDomain(domain: string) {
      calls.push(domain);
      return outcome;
    },
  };
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

async function activityRowsFor(db: TestAppFixture['db'], entityId: string): Promise<(typeof activityEvents.$inferSelect)[]> {
  const { eq } = await import('drizzle-orm');
  return db.select().from(activityEvents).where(eq(activityEvents.entityId, entityId));
}

describe('PATCH /api/account/profile (SET-02)', () => {
  it('rejects a wrong currentPassword with 400 INVALID_CREDENTIAL, no write, no activity row, no DNS call', async () => {
    const dnsChecker = fakeDnsChecker('resolvable');
    fixture = await startTestApp({ dnsChecker });
    await createAdmin(fixture.app, fixture.db, ADMIN_EMAIL, ADMIN_PASSWORD);
    const cookie = await signIn(fixture.app, ADMIN_EMAIL, ADMIN_PASSWORD);

    const response = await fixture.app.inject({
      method: 'PATCH',
      url: '/api/account/profile',
      headers: { cookie },
      payload: { name: 'Ada', currentPassword: 'totally wrong' },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toStrictEqual({
      error: 'INVALID_CREDENTIAL',
      message: expect.any(String),
      issues: [{ path: 'currentPassword', message: expect.any(String) }],
    });

    const [row] = await fixture.db.select().from(users);
    expect(row?.name).toBe('Admin');
    expect(dnsChecker.calls).toHaveLength(0);

    const rows = await activityRowsFor(fixture.db, row?.id ?? '');
    expect(rows.filter((r) => r.action.startsWith('account.'))).toHaveLength(0);
  });

  it('locks after 5 wrong attempts with 429 REAUTH_LOCKED and a Retry-After header; a correct password stays 429', async () => {
    fixture = await startTestApp({ dnsChecker: fakeDnsChecker('resolvable') });
    await createAdmin(fixture.app, fixture.db, ADMIN_EMAIL, ADMIN_PASSWORD);
    const cookie = await signIn(fixture.app, ADMIN_EMAIL, ADMIN_PASSWORD);

    for (let i = 0; i < DEFAULT_MAX_ATTEMPTS; i++) {
      await fixture.app.inject({
        method: 'PATCH',
        url: '/api/account/profile',
        headers: { cookie },
        payload: { name: 'Ada', currentPassword: 'totally wrong' },
      });
    }

    const locked = await fixture.app.inject({
      method: 'PATCH',
      url: '/api/account/profile',
      headers: { cookie },
      payload: { name: 'Ada', currentPassword: 'totally wrong' },
    });
    expect(locked.statusCode).toBe(429);
    expect(locked.headers['retry-after']).toBeDefined();

    const stillLocked = await fixture.app.inject({
      method: 'PATCH',
      url: '/api/account/profile',
      headers: { cookie },
      payload: { name: 'Ada', currentPassword: ADMIN_PASSWORD },
    });
    expect(stillLocked.statusCode).toBe(429);
  });

  it('updates the name with a correct current password and writes one account.name_changed row', async () => {
    fixture = await startTestApp({ dnsChecker: fakeDnsChecker('resolvable') });
    await createAdmin(fixture.app, fixture.db, ADMIN_EMAIL, ADMIN_PASSWORD);
    const cookie = await signIn(fixture.app, ADMIN_EMAIL, ADMIN_PASSWORD);

    const response = await fixture.app.inject({
      method: 'PATCH',
      url: '/api/account/profile',
      headers: { cookie },
      payload: { name: '  Ada  ', currentPassword: ADMIN_PASSWORD },
    });

    expect(response.statusCode).toBe(200);
    const body = response.json() as { name: string; email: string };
    expect(body.name).toBe('Ada');

    const [row] = await fixture.db.select().from(users);
    expect(row?.name).toBe('Ada');

    const rows = await activityRowsFor(fixture.db, row?.id ?? '');
    const nameChanged = rows.filter((r) => r.action === 'account.name_changed');
    expect(nameChanged).toHaveLength(1);
    expect(nameChanged[0]?.metadata).toStrictEqual({ name: 'Ada' });
    expect(nameChanged[0]?.entityType).toBe('user');
    expect(nameChanged[0]?.entityId).toBe(row?.id);
  });

  it('updates the email (lowercased) with a resolvable domain and writes one account.email_changed row', async () => {
    const dnsChecker = fakeDnsChecker('resolvable');
    fixture = await startTestApp({ dnsChecker });
    await createAdmin(fixture.app, fixture.db, ADMIN_EMAIL, ADMIN_PASSWORD);
    const cookie = await signIn(fixture.app, ADMIN_EMAIL, ADMIN_PASSWORD);

    const response = await fixture.app.inject({
      method: 'PATCH',
      url: '/api/account/profile',
      headers: { cookie },
      payload: { email: 'New@Example.com', currentPassword: ADMIN_PASSWORD },
    });

    expect(response.statusCode).toBe(200);
    const body = response.json() as { name: string; email: string };
    expect(body.email).toBe('new@example.com');
    expect(dnsChecker.calls).toStrictEqual(['example.com']);

    const [row] = await fixture.db.select().from(users);
    expect(row?.email).toBe('new@example.com');

    const rows = await activityRowsFor(fixture.db, row?.id ?? '');
    const emailChanged = rows.filter((r) => r.action === 'account.email_changed');
    expect(emailChanged).toHaveLength(1);
    expect(emailChanged[0]?.metadata).toStrictEqual({ email: 'new@example.com' });
  });

  it('rejects an unresolvable email domain with 400 EMAIL_DOMAIN_UNRESOLVABLE and no write', async () => {
    fixture = await startTestApp({ dnsChecker: fakeDnsChecker('unresolvable') });
    await createAdmin(fixture.app, fixture.db, ADMIN_EMAIL, ADMIN_PASSWORD);
    const cookie = await signIn(fixture.app, ADMIN_EMAIL, ADMIN_PASSWORD);

    const response = await fixture.app.inject({
      method: 'PATCH',
      url: '/api/account/profile',
      headers: { cookie },
      payload: { email: 'new@no-such-domain.invalid', currentPassword: ADMIN_PASSWORD },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toStrictEqual({
      error: 'EMAIL_DOMAIN_UNRESOLVABLE',
      message: expect.any(String),
      issues: [{ path: 'email', message: expect.any(String) }],
    });

    const [row] = await fixture.db.select().from(users);
    expect(row?.email).toBe(ADMIN_EMAIL);
  });

  it('rejects an unavailable DNS check with 503 EMAIL_DOMAIN_CHECK_UNAVAILABLE and no write', async () => {
    fixture = await startTestApp({ dnsChecker: fakeDnsChecker('unavailable') });
    await createAdmin(fixture.app, fixture.db, ADMIN_EMAIL, ADMIN_PASSWORD);
    const cookie = await signIn(fixture.app, ADMIN_EMAIL, ADMIN_PASSWORD);

    const response = await fixture.app.inject({
      method: 'PATCH',
      url: '/api/account/profile',
      headers: { cookie },
      payload: { email: 'new@example.com', currentPassword: ADMIN_PASSWORD },
    });

    expect(response.statusCode).toBe(503);
    expect(response.json()).toMatchObject({ error: 'EMAIL_DOMAIN_CHECK_UNAVAILABLE' });

    const [row] = await fixture.db.select().from(users);
    expect(row?.email).toBe(ADMIN_EMAIL);
  });

  it('rejects an invalid (empty) name with 400 VALIDATION_FAILED, issues path "name"', async () => {
    fixture = await startTestApp({ dnsChecker: fakeDnsChecker('resolvable') });
    await createAdmin(fixture.app, fixture.db, ADMIN_EMAIL, ADMIN_PASSWORD);
    const cookie = await signIn(fixture.app, ADMIN_EMAIL, ADMIN_PASSWORD);

    const response = await fixture.app.inject({
      method: 'PATCH',
      url: '/api/account/profile',
      headers: { cookie },
      payload: { name: '   ', currentPassword: ADMIN_PASSWORD },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toStrictEqual({
      error: 'VALIDATION_FAILED',
      message: expect.any(String),
      issues: [{ path: 'name', message: expect.any(String) }],
    });
  });

  it('rejects an invalid email with 400 VALIDATION_FAILED, issues path "email"', async () => {
    fixture = await startTestApp({ dnsChecker: fakeDnsChecker('resolvable') });
    await createAdmin(fixture.app, fixture.db, ADMIN_EMAIL, ADMIN_PASSWORD);
    const cookie = await signIn(fixture.app, ADMIN_EMAIL, ADMIN_PASSWORD);

    const response = await fixture.app.inject({
      method: 'PATCH',
      url: '/api/account/profile',
      headers: { cookie },
      payload: { email: 'not-an-email', currentPassword: ADMIN_PASSWORD },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toStrictEqual({
      error: 'VALIDATION_FAILED',
      message: expect.any(String),
      issues: [{ path: 'email', message: expect.any(String) }],
    });
  });

  it('a same-email edit in different case triggers no DNS call and no email_changed event', async () => {
    const dnsChecker = fakeDnsChecker('resolvable');
    fixture = await startTestApp({ dnsChecker });
    await createAdmin(fixture.app, fixture.db, ADMIN_EMAIL, ADMIN_PASSWORD);
    const cookie = await signIn(fixture.app, ADMIN_EMAIL, ADMIN_PASSWORD);

    const response = await fixture.app.inject({
      method: 'PATCH',
      url: '/api/account/profile',
      headers: { cookie },
      payload: { email: ADMIN_EMAIL.toUpperCase(), currentPassword: ADMIN_PASSWORD },
    });

    expect(response.statusCode).toBe(200);
    expect(dnsChecker.calls).toHaveLength(0);

    const [row] = await fixture.db.select().from(users);
    const rows = await activityRowsFor(fixture.db, row?.id ?? '');
    expect(rows.filter((r) => r.action === 'account.email_changed')).toHaveLength(0);
  });

  it('rejects a body with userId with 400 (schema, mass-assignment guard)', async () => {
    fixture = await startTestApp({ dnsChecker: fakeDnsChecker('resolvable') });
    await createAdmin(fixture.app, fixture.db, ADMIN_EMAIL, ADMIN_PASSWORD);
    const cookie = await signIn(fixture.app, ADMIN_EMAIL, ADMIN_PASSWORD);

    const response = await fixture.app.inject({
      method: 'PATCH',
      url: '/api/account/profile',
      headers: { cookie },
      payload: { name: 'Ada', currentPassword: ADMIN_PASSWORD, userId: 'someone-else' },
    });

    expect(response.statusCode).toBe(400);
  });

  it('rejects an unauthenticated request with 401', async () => {
    fixture = await startTestApp({ dnsChecker: fakeDnsChecker('resolvable') });
    await createAdmin(fixture.app, fixture.db, ADMIN_EMAIL, ADMIN_PASSWORD);

    const response = await fixture.app.inject({
      method: 'PATCH',
      url: '/api/account/profile',
      payload: { name: 'Ada', currentPassword: ADMIN_PASSWORD },
    });

    expect(response.statusCode).toBe(401);
  });

  it('rejects a cross-origin request with 403 FORBIDDEN_ORIGIN', async () => {
    fixture = await startTestApp({ dnsChecker: fakeDnsChecker('resolvable') });
    await createAdmin(fixture.app, fixture.db, ADMIN_EMAIL, ADMIN_PASSWORD);
    const cookie = await signIn(fixture.app, ADMIN_EMAIL, ADMIN_PASSWORD);

    const response = await fixture.app.inject({
      method: 'PATCH',
      url: '/api/account/profile',
      headers: { cookie, origin: FOREIGN_ORIGIN },
      payload: { name: 'Ada', currentPassword: ADMIN_PASSWORD },
    });

    expect(response.statusCode).toBe(403);
    expect(response.json()).toStrictEqual({ error: 'FORBIDDEN_ORIGIN', message: expect.any(String) });
  });

  it('reflects a successful name change on a subsequent GET /api/auth/get-session with the same cookie', async () => {
    fixture = await startTestApp({ dnsChecker: fakeDnsChecker('resolvable') });
    await createAdmin(fixture.app, fixture.db, ADMIN_EMAIL, ADMIN_PASSWORD);
    const cookie = await signIn(fixture.app, ADMIN_EMAIL, ADMIN_PASSWORD);

    await fixture.app.inject({
      method: 'PATCH',
      url: '/api/account/profile',
      headers: { cookie },
      payload: { name: 'Ada', currentPassword: ADMIN_PASSWORD },
    });

    const session = await fixture.app.inject({
      method: 'GET',
      url: '/api/auth/get-session',
      headers: { cookie },
    });
    expect(session.statusCode).toBe(200);
    const sessionBody = session.json() as { user: { name: string } };
    expect(sessionBody.user.name).toBe('Ada');
  });

  it('never leaks the current password or the argon2 hash prefix into the response, logs or activity metadata', async () => {
    // logger.ts imports env.js, which fail-fasts at import time (INST-06) — it must not be
    // imported before startTestApp() has written a valid test environment, so the import happens
    // *inside* the buildLogger callback (helpers/app.ts's own documented contract), not here.
    let records: (() => unknown[]) | undefined;
    fixture = await startTestApp({
      dnsChecker: fakeDnsChecker('resolvable'),
      buildLogger: async () => {
        const { createLogger, writableForTests } = await import('../../../apps/control-plane/src/logger.js');
        const capture = writableForTests();
        records = capture.records;
        return createLogger({ destination: capture.stream });
      },
    });
    await createAdmin(fixture.app, fixture.db, ADMIN_EMAIL, ADMIN_PASSWORD);
    const cookie = await signIn(fixture.app, ADMIN_EMAIL, ADMIN_PASSWORD);

    const response = await fixture.app.inject({
      method: 'PATCH',
      url: '/api/account/profile',
      headers: { cookie },
      payload: { name: 'Ada', currentPassword: ADMIN_PASSWORD },
    });
    expect(response.statusCode).toBe(200);

    expect(response.body).not.toContain(ADMIN_PASSWORD);
    expect(response.body).not.toContain('$argon2');

    const logLines = JSON.stringify(records?.() ?? []);
    expect(logLines).not.toContain(ADMIN_PASSWORD);
    expect(logLines).not.toContain('$argon2');

    const rows = await fixture.db.select().from(activityEvents);
    const serializedActivity = JSON.stringify(rows);
    expect(serializedActivity).not.toContain(ADMIN_PASSWORD);
    expect(serializedActivity).not.toContain('$argon2');

    const [accountRow] = await fixture.db.select().from(accounts);
    expect(accountRow?.password).toBeDefined();
  });
});
