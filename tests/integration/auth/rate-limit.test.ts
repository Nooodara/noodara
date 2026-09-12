import { randomBytes, randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { revealSecret } from '@noodara/domain/security';
import { issueToken } from '../../../apps/control-plane/src/services/setup-token-repository.js';
import type { TestAppFixture } from '../helpers/app.js';

// D-07/AUTH-04: the real per-IP and per-account progressive-backoff lockout — the mechanism
// RESEARCH's Pitfall 2 says Better Auth's own IP+path-keyed `rateLimit` cannot provide. Both
// scenarios this suite drives (locking an account via many source IPs, locking an IP via many
// accounts) are exactly the two RESEARCH names as the giveaway for a wrong (IP-only) implementation.

const ADMIN_EMAIL = 'admin@noodara.test';
const ADMIN_PASSWORD = 'correct horse battery staple';
const WRONG_PASSWORD = 'definitely the wrong password';

interface RateLimitFixture {
  app: TestAppFixture['app'];
  db: TestAppFixture['db'];
  stop: () => Promise<void>;
}

let fixture: RateLimitFixture | undefined;

beforeEach(() => {
  // `auth.ts` caches its own `pg.Pool` at module scope (Plan 01-10) — every test needs a fresh
  // module graph bound to its own freshly started container.
  vi.resetModules();
});

afterEach(async () => {
  await fixture?.stop();
  fixture = undefined;
  vi.unstubAllEnvs();

  // noodara-tdd skill §5: no stray container labelled noodara.test=true survives a run.
  const { getContainerRuntimeClient } = await import('testcontainers');
  const client = await getContainerRuntimeClient();
  const containers = await client.container.list();
  const stray = containers.filter((c) => c.Labels['noodara.test'] === 'true');
  expect(stray).toHaveLength(0);
});

/** Starts a fresh app against a freshly migrated database, optionally with `NOODARA_TRUST_PROXY`
 *  set — mirrors `cookies.test.ts`'s `startConfigurableApp` convention (Plan 01-10). */
async function startConfigurableApp(options: { trustProxy?: boolean } = {}): Promise<RateLimitFixture> {
  if (options.trustProxy !== undefined) {
    vi.stubEnv('NOODARA_TRUST_PROXY', options.trustProxy ? 'true' : 'false');
  }

  const { startPostgres } = await import('../helpers/postgres.js');
  const postgres = await startPostgres();

  process.env.NOODARA_MASTER_KEY = randomBytes(32).toString('base64');
  process.env.BETTER_AUTH_SECRET = `test-fixture-${randomUUID()}-${randomUUID()}`;
  process.env.DATABASE_URL = postgres.connectionString;
  process.env.REDIS_URL = 'redis://localhost:6379';
  process.env.NOODARA_PUBLIC_URL = 'http://localhost:3000';

  const { buildApp } = await import('../../../apps/control-plane/src/app.js');
  const app = buildApp();

  return {
    app,
    db: postgres.db,
    stop: async () => {
      await app.close();
      await postgres.stop();
    },
  };
}

async function createAdmin(app: RateLimitFixture['app'], db: RateLimitFixture['db']): Promise<void> {
  const issued = await issueToken(db, 'setup', new Date());
  const response = await app.inject({
    method: 'POST',
    url: '/api/setup',
    payload: { token: revealSecret(issued.token), email: ADMIN_EMAIL, password: ADMIN_PASSWORD, name: 'Admin' },
  });
  if (response.statusCode !== 200) {
    throw new Error(`setup failed: ${response.statusCode.toString()} ${response.body}`);
  }
}

interface SignInOptions {
  email: string;
  password: string;
  remoteAddress?: string;
  forwardedFor?: string;
}

async function signIn(app: RateLimitFixture['app'], options: SignInOptions) {
  return app.inject({
    method: 'POST',
    url: '/api/auth/sign-in/email',
    remoteAddress: options.remoteAddress,
    headers: options.forwardedFor !== undefined ? { 'x-forwarded-for': options.forwardedFor } : undefined,
    payload: { email: options.email, password: options.password },
  });
}

/** D-07's own "advancing locked_until into the past allows the next request through" escape
 *  hatch — used here to force a *second* lockout (proving the doubling schedule) without waiting
 *  15 real minutes between the two. */
async function unlockEverything(db: RateLimitFixture['db']): Promise<void> {
  await db.execute(sql`update login_attempts set locked_until = now() - interval '1 second'`);
}

interface LoginAttemptRow {
  scope: string;
  scope_key: string;
  failure_count: number;
  lockout_count: number;
}

async function loginAttemptRows(db: RateLimitFixture['db']): Promise<LoginAttemptRow[]> {
  const result = await db.execute<LoginAttemptRow>(
    sql`select scope, scope_key, failure_count, lockout_count from login_attempts`,
  );
  return result.rows;
}

interface ActivityEventRow {
  action: string;
  metadata: unknown;
}

async function activityEventsByAction(db: RateLimitFixture['db'], action: string): Promise<ActivityEventRow[]> {
  const result = await db.execute<ActivityEventRow>(
    sql`select action, metadata from activity_events where action = ${action} order by occurred_at asc`,
  );
  return result.rows;
}

describe('login rate limiting (AUTH-04, D-07)', () => {
  it('locks the account after 5 failures from 5 distinct IPs (per-account scope, not IP-only)', async () => {
    fixture = await startConfigurableApp();
    await createAdmin(fixture.app, fixture.db);

    for (let i = 1; i <= 5; i++) {
      const response = await signIn(fixture.app, {
        email: ADMIN_EMAIL,
        password: WRONG_PASSWORD,
        remoteAddress: `10.0.0.${i.toString()}`,
      });
      expect(response.statusCode).toBe(401);
    }

    const sixth = await signIn(fixture.app, {
      email: ADMIN_EMAIL,
      password: WRONG_PASSWORD,
      remoteAddress: '10.0.0.6',
    });
    expect(sixth.statusCode).toBe(429);
  });

  it('locks the IP after 5 failures against 5 distinct emails (per-IP scope, not account-only)', async () => {
    fixture = await startConfigurableApp();
    await createAdmin(fixture.app, fixture.db);
    const attackerIp = '10.1.1.1';

    for (let i = 1; i <= 5; i++) {
      const response = await signIn(fixture.app, {
        email: `nobody-${i.toString()}@example.com`,
        password: WRONG_PASSWORD,
        remoteAddress: attackerIp,
      });
      expect(response.statusCode).toBe(401);
    }

    // Valid email, even the *correct* password: the IP scope is what's locked, and this proves
    // the block happens before credentials are ever checked (RESEARCH's named giveaway scenario).
    const sixth = await signIn(fixture.app, {
      email: ADMIN_EMAIL,
      password: ADMIN_PASSWORD,
      remoteAddress: attackerIp,
    });
    expect(sixth.statusCode).toBe(429);
  });

  it('rejects the correct password with 429 while locked out (the handler never runs)', async () => {
    fixture = await startConfigurableApp();
    await createAdmin(fixture.app, fixture.db);
    const ip = '10.2.2.2';

    for (let i = 0; i < 5; i++) {
      await signIn(fixture.app, { email: ADMIN_EMAIL, password: WRONG_PASSWORD, remoteAddress: ip });
    }

    const response = await signIn(fixture.app, { email: ADMIN_EMAIL, password: ADMIN_PASSWORD, remoteAddress: ip });

    expect(response.statusCode).toBe(429);
    expect(response.headers['set-cookie']).toBeUndefined();
  });

  it('sets a Retry-After of roughly 900s on the first lockout and 1800s on the second (doubling)', async () => {
    fixture = await startConfigurableApp();
    await createAdmin(fixture.app, fixture.db);
    const ip = '10.3.3.3';

    for (let i = 0; i < 5; i++) {
      await signIn(fixture.app, { email: ADMIN_EMAIL, password: WRONG_PASSWORD, remoteAddress: ip });
    }
    const firstLockout = await signIn(fixture.app, {
      email: ADMIN_EMAIL,
      password: WRONG_PASSWORD,
      remoteAddress: ip,
    });
    expect(firstLockout.statusCode).toBe(429);
    const firstRetryAfter = Number(firstLockout.headers['retry-after']);
    expect(firstRetryAfter).toBeGreaterThanOrEqual(890);
    expect(firstRetryAfter).toBeLessThanOrEqual(900);

    // D-07's own recovery path: advancing locked_until into the past lets the next request
    // through without waiting 15 real minutes.
    await unlockEverything(fixture.db);

    for (let i = 0; i < 5; i++) {
      const response = await signIn(fixture.app, { email: ADMIN_EMAIL, password: WRONG_PASSWORD, remoteAddress: ip });
      expect(response.statusCode).toBe(401);
    }
    const secondLockout = await signIn(fixture.app, {
      email: ADMIN_EMAIL,
      password: WRONG_PASSWORD,
      remoteAddress: ip,
    });
    expect(secondLockout.statusCode).toBe(429);
    const secondRetryAfter = Number(secondLockout.headers['retry-after']);
    expect(secondRetryAfter).toBeGreaterThanOrEqual(1790);
    expect(secondRetryAfter).toBeLessThanOrEqual(1800);
  });

  it('clears both scopes on a successful login, leaving zero rows behind', async () => {
    fixture = await startConfigurableApp();
    await createAdmin(fixture.app, fixture.db);
    const ip = '10.4.4.4';

    await signIn(fixture.app, { email: ADMIN_EMAIL, password: WRONG_PASSWORD, remoteAddress: ip });
    await signIn(fixture.app, { email: ADMIN_EMAIL, password: WRONG_PASSWORD, remoteAddress: ip });

    const beforeSuccess = await loginAttemptRows(fixture.db);
    expect(beforeSuccess.length).toBeGreaterThan(0);

    const success = await signIn(fixture.app, { email: ADMIN_EMAIL, password: ADMIN_PASSWORD, remoteAddress: ip });
    expect(success.statusCode).toBe(200);

    const afterSuccess = await loginAttemptRows(fixture.db);
    expect(afterSuccess).toHaveLength(0);
  });

  it('never lets no lockout be permanent: advancing locked_until into the past unlocks immediately', async () => {
    fixture = await startConfigurableApp();
    await createAdmin(fixture.app, fixture.db);
    const ip = '10.5.5.5';

    for (let i = 0; i < 5; i++) {
      await signIn(fixture.app, { email: ADMIN_EMAIL, password: WRONG_PASSWORD, remoteAddress: ip });
    }
    const blocked = await signIn(fixture.app, { email: ADMIN_EMAIL, password: WRONG_PASSWORD, remoteAddress: ip });
    expect(blocked.statusCode).toBe(429);

    await unlockEverything(fixture.db);

    const unblocked = await signIn(fixture.app, { email: ADMIN_EMAIL, password: ADMIN_PASSWORD, remoteAddress: ip });
    expect(unblocked.statusCode).toBe(200);
  });

  it('writes auth.login_failed with email/ip metadata but never the submitted password', async () => {
    fixture = await startConfigurableApp();
    await createAdmin(fixture.app, fixture.db);

    await signIn(fixture.app, { email: ADMIN_EMAIL, password: WRONG_PASSWORD, remoteAddress: '10.6.6.6' });

    const rows = await activityEventsByAction(fixture.db, 'auth.login_failed');
    expect(rows).toHaveLength(1);
    const serialized = JSON.stringify(rows[0]?.metadata);
    expect(serialized).not.toContain(WRONG_PASSWORD);
    expect(serialized).toContain(ADMIN_EMAIL);
    expect(serialized).toContain('10.6.6.6');
  });

  it('writes exactly one auth.login_blocked event per blocked attempt and one auth.login_succeeded on success', async () => {
    fixture = await startConfigurableApp();
    await createAdmin(fixture.app, fixture.db);
    const ip = '10.7.7.7';

    for (let i = 0; i < 5; i++) {
      await signIn(fixture.app, { email: ADMIN_EMAIL, password: WRONG_PASSWORD, remoteAddress: ip });
    }
    await signIn(fixture.app, { email: ADMIN_EMAIL, password: WRONG_PASSWORD, remoteAddress: ip });

    const blockedRows = await activityEventsByAction(fixture.db, 'auth.login_blocked');
    expect(blockedRows).toHaveLength(1);

    await unlockEverything(fixture.db);
    const success = await signIn(fixture.app, { email: ADMIN_EMAIL, password: ADMIN_PASSWORD, remoteAddress: ip });
    expect(success.statusCode).toBe(200);

    const succeededRows = await activityEventsByAction(fixture.db, 'auth.login_succeeded');
    expect(succeededRows).toHaveLength(1);
  });

  it('ignores X-Forwarded-For when NOODARA_TRUST_PROXY is unset (per-IP scope uses the real socket address)', async () => {
    fixture = await startConfigurableApp({ trustProxy: false });
    await createAdmin(fixture.app, fixture.db);
    const realIp = '10.8.8.8';

    for (let i = 1; i <= 5; i++) {
      const response = await signIn(fixture.app, {
        email: `nobody-${i.toString()}@example.com`,
        password: WRONG_PASSWORD,
        remoteAddress: realIp,
        forwardedFor: `203.0.113.${i.toString()}`,
      });
      expect(response.statusCode).toBe(401);
    }

    // Despite five different X-Forwarded-For values, the real socket address never changed, so
    // the IP scope is locked — proving the forwarded header was never consulted.
    const sixth = await signIn(fixture.app, {
      email: ADMIN_EMAIL,
      password: ADMIN_PASSWORD,
      remoteAddress: realIp,
      forwardedFor: '203.0.113.250',
    });
    expect(sixth.statusCode).toBe(429);
  });

  it('uses the leftmost X-Forwarded-For address when NOODARA_TRUST_PROXY is enabled', async () => {
    fixture = await startConfigurableApp({ trustProxy: true });
    await createAdmin(fixture.app, fixture.db);
    const trustedProxyIp = '10.9.9.9';
    const leftmostClientIp = '198.51.100.9';

    for (let i = 1; i <= 5; i++) {
      const response = await signIn(fixture.app, {
        email: `nobody-${i.toString()}@example.com`,
        password: WRONG_PASSWORD,
        remoteAddress: trustedProxyIp,
        forwardedFor: `${leftmostClientIp}, 10.0.0.${i.toString()}`,
      });
      expect(response.statusCode).toBe(401);
    }

    // Same leftmost client IP every time (only the second hop varies) — the per-IP scope is
    // keyed on that leftmost address, so it is now locked even against a fresh, valid email.
    const sixth = await signIn(fixture.app, {
      email: ADMIN_EMAIL,
      password: ADMIN_PASSWORD,
      remoteAddress: trustedProxyIp,
      forwardedFor: `${leftmostClientIp}, 10.0.0.99`,
    });
    expect(sixth.statusCode).toBe(429);
  });
});
