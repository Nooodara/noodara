// T-09-01/T-09-20: ReauthGuard reuses v0.1's tested progressive-backoff math
// (packages/domain/src/security/login-backoff.ts) under a per-user `reauth:<userId>` key,
// entirely separate from the email-keyed login lockout `login-guard.ts` owns — a stolen session
// guessing the current password repeatedly must never lock the admin out of sign-in.
import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { afterEach, describe, expect, it } from 'vitest';
import { DEFAULT_MAX_ATTEMPTS } from '@noodara/domain/security';
import { createReauthGuard, REAUTH_SCOPE_KEY_PREFIX } from '../../../apps/control-plane/src/auth/reauth-guard.js';
import { startPostgres, type PostgresFixture } from '../helpers/postgres.js';

let fixture: PostgresFixture | undefined;

afterEach(async () => {
  await fixture?.stop();
  fixture = undefined;
});

describe('createReauthGuard', () => {
  it('check() on a fresh user returns not locked', async () => {
    fixture = await startPostgres();
    const guard = createReauthGuard({ db: fixture.db });

    const status = await guard.check(randomUUID());

    expect(status).toStrictEqual({ locked: false });
  });

  it('locks after DEFAULT_MAX_ATTEMPTS recordFailure calls within the window', async () => {
    fixture = await startPostgres();
    const userId = randomUUID();
    const guard = createReauthGuard({ db: fixture.db });

    for (let i = 0; i < DEFAULT_MAX_ATTEMPTS; i++) {
      await guard.recordFailure(userId);
    }

    const status = await guard.check(userId);

    expect(status.locked).toBe(true);
    if (status.locked) {
      expect(status.retryAfterSeconds).toBeGreaterThan(0);
    }
  });

  it('stores the lock under scope "account" / scope_key "reauth:<userId>", never a bare userId', async () => {
    fixture = await startPostgres();
    const userId = randomUUID();
    const guard = createReauthGuard({ db: fixture.db });

    for (let i = 0; i < DEFAULT_MAX_ATTEMPTS; i++) {
      await guard.recordFailure(userId);
    }

    const result = await fixture.db.execute<{ scope: string; scope_key: string }>(
      sql`select scope, scope_key from login_attempts`,
    );

    expect(result.rows).toHaveLength(1);
    expect(result.rows[0]?.scope).toBe('account');
    expect(result.rows[0]?.scope_key).toBe(`${REAUTH_SCOPE_KEY_PREFIX}${userId}`);
    expect(result.rows[0]?.scope_key).not.toBe(userId);
  });

  it('clear() deletes the reauth row so check() returns not locked', async () => {
    fixture = await startPostgres();
    const userId = randomUUID();
    const guard = createReauthGuard({ db: fixture.db });

    for (let i = 0; i < DEFAULT_MAX_ATTEMPTS; i++) {
      await guard.recordFailure(userId);
    }
    expect((await guard.check(userId)).locked).toBe(true);

    await guard.clear(userId);

    expect(await guard.check(userId)).toStrictEqual({ locked: false });
  });

  it('two different user ids never share a counter', async () => {
    fixture = await startPostgres();
    const guard = createReauthGuard({ db: fixture.db });
    const userA = randomUUID();
    const userB = randomUUID();

    for (let i = 0; i < DEFAULT_MAX_ATTEMPTS; i++) {
      await guard.recordFailure(userA);
    }

    expect((await guard.check(userA)).locked).toBe(true);
    expect((await guard.check(userB)).locked).toBe(false);
  });

  it('injects time so lockout expiry is testable without sleeping', async () => {
    fixture = await startPostgres();
    const userId = randomUUID();
    let now = new Date('2026-01-01T00:00:00Z');
    const guard = createReauthGuard({ db: fixture.db, now: () => now });

    for (let i = 0; i < DEFAULT_MAX_ATTEMPTS; i++) {
      await guard.recordFailure(userId);
    }
    expect((await guard.check(userId)).locked).toBe(true);

    // Advance well past the first lockout's duration (900s default window).
    now = new Date(now.getTime() + 1000 * 1000);

    expect((await guard.check(userId)).locked).toBe(false);
  });
});
