import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { revealSecret } from '@noodara/domain/security';
import { activityEvents } from '../../../apps/control-plane/src/db/schema/activity-events.js';
import { users } from '../../../apps/control-plane/src/db/schema/auth.js';
import { setupTokens } from '../../../apps/control-plane/src/db/schema/setup-tokens.js';
import { issueToken } from '../../../apps/control-plane/src/services/setup-token-repository.js';
import { startTestApp, type TestAppFixture } from '../helpers/app.js';

// AUTH-01/D-02: the only way the first admin gets created is by redeeming a valid, single-use,
// 24-hour setup token; once an admin exists, the setup route and the generic sign-up route both
// disappear (404). T-1-34/T-1-35/T-1-36/T-1-37 (01-12-PLAN.md threat register).

const ADMIN_EMAIL = 'admin@noodara.test';
const ADMIN_PASSWORD = 'correct horse battery staple';

let fixture: TestAppFixture | undefined;

// `auth.ts` opens its own `pg.Pool` at module scope bound to whatever `DATABASE_URL` was current
// at first import (Plan 01-10) — reset the module graph before every test so it re-evaluates
// against this test's freshly started container (same pattern as login.test.ts).
beforeEach(() => {
  vi.resetModules();
});

afterEach(async () => {
  await fixture?.stop();
  fixture = undefined;

  // noodara-tdd skill §5: no stray container labelled noodara.test=true survives a run.
  const { getContainerRuntimeClient } = await import('testcontainers');
  const client = await getContainerRuntimeClient();
  const client_ = await client.container.list();
  const stray = client_.filter((c) => c.Labels['noodara.test'] === 'true');
  expect(stray).toHaveLength(0);
});

async function issueSetupToken(db: TestAppFixture['db'], now = new Date()): Promise<string> {
  const issued = await issueToken(db, 'setup', now);
  return revealSecret(issued.token);
}

async function userCount(db: TestAppFixture['db']): Promise<number> {
  const rows = await db.select({ id: users.id }).from(users);
  return rows.length;
}

describe('POST /api/setup (AUTH-01)', () => {
  it('rejects /api/auth/sign-up/email with 404 before any admin exists', async () => {
    fixture = await startTestApp();

    const response = await fixture.app.inject({
      method: 'POST',
      url: '/api/auth/sign-up/email',
      payload: { email: ADMIN_EMAIL, password: ADMIN_PASSWORD, name: 'Admin' },
    });

    expect(response.statusCode).toBe(404);
  });

  it('creates exactly one admin with a valid unused token and marks it used', async () => {
    fixture = await startTestApp();
    const token = await issueSetupToken(fixture.db);

    const response = await fixture.app.inject({
      method: 'POST',
      url: '/api/setup',
      payload: { token, email: ADMIN_EMAIL, password: ADMIN_PASSWORD },
    });

    expect(response.statusCode).toBe(200);
    expect(await userCount(fixture.db)).toBe(1);

    const [row] = await fixture.db.select().from(setupTokens);
    expect(row?.usedAt).not.toBeNull();
  });

  it('rejects /api/auth/sign-up/email with 404 after an admin exists', async () => {
    fixture = await startTestApp();
    const token = await issueSetupToken(fixture.db);
    await fixture.app.inject({
      method: 'POST',
      url: '/api/setup',
      payload: { token, email: ADMIN_EMAIL, password: ADMIN_PASSWORD },
    });

    const response = await fixture.app.inject({
      method: 'POST',
      url: '/api/auth/sign-up/email',
      payload: { email: 'someone-else@noodara.test', password: ADMIN_PASSWORD, name: 'Someone' },
    });

    expect(response.statusCode).toBe(404);
  });

  it('rejects a replayed token with 400 and leaves the user count at 1', async () => {
    fixture = await startTestApp();
    const token = await issueSetupToken(fixture.db);
    const first = await fixture.app.inject({
      method: 'POST',
      url: '/api/setup',
      payload: { token, email: ADMIN_EMAIL, password: ADMIN_PASSWORD },
    });
    expect(first.statusCode).toBe(200);

    const replay = await fixture.app.inject({
      method: 'POST',
      url: '/api/setup',
      payload: { token, email: 'second-admin@noodara.test', password: ADMIN_PASSWORD },
    });

    expect(replay.statusCode).toBe(400);
    expect(await userCount(fixture.db)).toBe(1);
  });

  it('rejects an expired token with 400', async () => {
    fixture = await startTestApp();
    // Issued 25 hours ago: expiresAt = issuedAt + 24h, one hour in the past relative to "now".
    const twentyFiveHoursAgo = new Date(Date.now() - 25 * 60 * 60 * 1000);
    const token = await issueSetupToken(fixture.db, twentyFiveHoursAgo);

    const response = await fixture.app.inject({
      method: 'POST',
      url: '/api/setup',
      payload: { token, email: ADMIN_EMAIL, password: ADMIN_PASSWORD },
    });

    expect(response.statusCode).toBe(400);
    expect(await userCount(fixture.db)).toBe(0);
  });

  it('rejects an unknown token with 400 (generic code, no admin-existence oracle)', async () => {
    fixture = await startTestApp();

    const response = await fixture.app.inject({
      method: 'POST',
      url: '/api/setup',
      payload: { token: 'this-token-was-never-issued', email: ADMIN_EMAIL, password: ADMIN_PASSWORD },
    });

    expect(response.statusCode).toBe(400);
  });

  it('returns 404 (not 403) once an admin exists, before evaluating the token', async () => {
    fixture = await startTestApp();
    const token = await issueSetupToken(fixture.db);
    await fixture.app.inject({
      method: 'POST',
      url: '/api/setup',
      payload: { token, email: ADMIN_EMAIL, password: ADMIN_PASSWORD },
    });

    const response = await fixture.app.inject({
      method: 'POST',
      url: '/api/setup',
      payload: { token: 'a-completely-bogus-token', email: 'other@noodara.test', password: ADMIN_PASSWORD },
    });

    expect(response.statusCode).toBe(404);
    expect(response.statusCode).not.toBe(403);
  });

  it('rejects a weak password with 400 and leaves the token unused', async () => {
    fixture = await startTestApp();
    const token = await issueSetupToken(fixture.db);

    const response = await fixture.app.inject({
      method: 'POST',
      url: '/api/setup',
      payload: { token, email: ADMIN_EMAIL, password: 'too-short' },
    });

    expect(response.statusCode).toBe(400);
    expect(await userCount(fixture.db)).toBe(0);

    const [row] = await fixture.db.select().from(setupTokens);
    expect(row?.usedAt).toBeNull();
  });

  it('writes exactly one auth.setup_completed event whose metadata carries neither the token nor the password', async () => {
    fixture = await startTestApp();
    const token = await issueSetupToken(fixture.db);

    const response = await fixture.app.inject({
      method: 'POST',
      url: '/api/setup',
      payload: { token, email: ADMIN_EMAIL, password: ADMIN_PASSWORD },
    });
    expect(response.statusCode).toBe(200);

    const events = await fixture.db
      .select()
      .from(activityEvents)
      .where(eq(activityEvents.action, 'auth.setup_completed'));
    expect(events).toHaveLength(1);

    const serialized = JSON.stringify(events[0]);
    expect(serialized).not.toContain(token);
    expect(serialized).not.toContain(ADMIN_PASSWORD);
  });

  it('never echoes the submitted token or password in the success or error response body', async () => {
    fixture = await startTestApp();
    const token = await issueSetupToken(fixture.db);

    const response = await fixture.app.inject({
      method: 'POST',
      url: '/api/setup',
      payload: { token, email: ADMIN_EMAIL, password: ADMIN_PASSWORD },
    });

    const serialized = response.body;
    expect(serialized).not.toContain(token);
    expect(serialized).not.toContain(ADMIN_PASSWORD);

    const replay = await fixture.app.inject({
      method: 'POST',
      url: '/api/setup',
      payload: { token, email: ADMIN_EMAIL, password: ADMIN_PASSWORD },
    });
    expect(replay.body).not.toContain(token);
    expect(replay.body).not.toContain(ADMIN_PASSWORD);
  });
});
