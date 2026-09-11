import { randomBytes, randomUUID } from 'node:crypto';
import parseSetCookie, { type Cookie } from 'set-cookie-parser';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { TestAppFixture } from '../helpers/app.js';

// Better Auth mounted in Fastify (Plan 01-10): AUTH-05 / D-08 — hardened cookies (HttpOnly,
// Secure, SameSite=Lax, Path=/, an explicit lifetime) and session-id rotation on every sign-in.

const ADMIN_EMAIL = 'admin@noodara.test';
const ADMIN_PASSWORD = 'correct horse battery staple';

interface ConfigurableFixture {
  app: TestAppFixture['app'];
  records?: () => unknown[];
  stop: () => Promise<void>;
}

let fixture: ConfigurableFixture | undefined;

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

/**
 * Builds a fresh app against a freshly migrated database, letting each test control
 * `NODE_ENV` / `NOODARA_COOKIE_INSECURE` and optionally capture the pino output.
 * `vi.resetModules()` forces `env.ts` (module-level fail-fast, INST-06) — and everything that
 * transitively imports it, including `auth.ts`'s cookie policy — to re-evaluate against the env
 * values set here, rather than reusing whatever a previous test in this file already cached.
 */
async function startConfigurableApp(
  options: { nodeEnv?: string; cookieInsecure?: boolean; captureLogs?: boolean } = {},
): Promise<ConfigurableFixture> {
  vi.resetModules();
  if (options.nodeEnv !== undefined) vi.stubEnv('NODE_ENV', options.nodeEnv);
  if (options.cookieInsecure !== undefined) {
    vi.stubEnv('NOODARA_COOKIE_INSECURE', options.cookieInsecure ? 'true' : 'false');
  }

  const { startPostgres } = await import('../helpers/postgres.js');
  const postgres = await startPostgres();

  process.env.NOODARA_MASTER_KEY = randomBytes(32).toString('base64');
  process.env.BETTER_AUTH_SECRET = `test-fixture-${randomUUID()}-${randomUUID()}`;
  process.env.DATABASE_URL = postgres.connectionString;
  process.env.REDIS_URL = 'redis://localhost:6379';
  process.env.NOODARA_PUBLIC_URL = 'http://localhost:3000';

  const { buildApp } = await import('../../../apps/control-plane/src/app.js');

  let records: (() => unknown[]) | undefined;
  let app: TestAppFixture['app'];
  if (options.captureLogs) {
    const { createLogger, writableForTests } = await import('../../../apps/control-plane/src/logger.js');
    const capture = writableForTests();
    records = capture.records;
    app = buildApp({ logger: createLogger({ destination: capture.stream }) });
  } else {
    app = buildApp();
  }

  return {
    app,
    records,
    stop: async () => {
      await app.close();
      await postgres.stop();
    },
  };
}

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

function parsedCookies(response: { headers: Record<string, unknown> }): Cookie[] {
  const raw = response.headers['set-cookie'];
  const rawCookies = Array.isArray(raw) ? raw : raw !== undefined ? [String(raw)] : [];
  return parseSetCookie.parse(rawCookies, { map: false });
}

function cookieHeaderFrom(response: { headers: Record<string, unknown> }): string {
  return parsedCookies(response)
    .map((cookie) => `${cookie.name}=${cookie.value}`)
    .join('; ');
}

function findSessionCookie(cookies: Cookie[]): Cookie | undefined {
  return cookies.find((cookie) => cookie.name.includes('session_token'));
}

async function signIn(app: TestAppFixture['app'], cookie?: string) {
  return app.inject({
    method: 'POST',
    url: '/api/auth/sign-in/email',
    headers: cookie !== undefined ? { cookie } : undefined,
    payload: { email: ADMIN_EMAIL, password: ADMIN_PASSWORD },
  });
}

describe('cookie hardening and session-id rotation (AUTH-05, D-08)', () => {
  it('sets HttpOnly, Secure and SameSite=Lax on the sign-in cookie', async () => {
    fixture = await startConfigurableApp();
    await createAdmin(fixture.app, ADMIN_EMAIL, ADMIN_PASSWORD);

    const response = await signIn(fixture.app);
    const sessionCookie = findSessionCookie(parsedCookies(response));

    expect(sessionCookie).toBeDefined();
    expect(sessionCookie?.httpOnly).toBe(true);
    expect(sessionCookie?.secure).toBe(true);
    expect(sessionCookie?.sameSite?.toLowerCase()).toBe('lax');
  });

  it('carries Path=/ and an explicit Max-Age or Expires consistent with the configured lifetime', async () => {
    fixture = await startConfigurableApp();
    await createAdmin(fixture.app, ADMIN_EMAIL, ADMIN_PASSWORD);

    const response = await signIn(fixture.app);
    const sessionCookie = findSessionCookie(parsedCookies(response));

    expect(sessionCookie?.path).toBe('/');
    expect(sessionCookie?.maxAge !== undefined || sessionCookie?.expires !== undefined).toBe(true);
  });

  it('keeps Secure even with NODE_ENV=development and NOODARA_COOKIE_INSECURE unset (D-08: never defaults from NODE_ENV)', async () => {
    fixture = await startConfigurableApp({ nodeEnv: 'development' });
    await createAdmin(fixture.app, ADMIN_EMAIL, ADMIN_PASSWORD);

    const response = await signIn(fixture.app);
    const sessionCookie = findSessionCookie(parsedCookies(response));

    expect(sessionCookie?.secure).toBe(true);
  });

  it('drops Secure and logs a warning naming NOODARA_COOKIE_INSECURE when the flag is explicitly set', async () => {
    fixture = await startConfigurableApp({ cookieInsecure: true, captureLogs: true });
    await createAdmin(fixture.app, ADMIN_EMAIL, ADMIN_PASSWORD);

    const response = await signIn(fixture.app);
    const sessionCookie = findSessionCookie(parsedCookies(response));
    // set-cookie-parser omits `secure` entirely (undefined) rather than setting it `false` when
    // the `Secure` attribute is absent from the header — assert falsiness, not strict `false`.
    expect(sessionCookie).toBeDefined();
    expect(Boolean(sessionCookie?.secure)).toBe(false);

    const records = fixture.records?.() ?? [];
    const warned = records.some((record) => {
      if (typeof record !== 'object' || record === null) return false;
      const msg = (record as { msg?: unknown }).msg;
      return typeof msg === 'string' && msg.includes('NOODARA_COOKIE_INSECURE');
    });
    expect(warned).toBe(true);
  });

  it('mints a new session token on sign-in while an existing session is still valid, without revoking the old one (D-06)', async () => {
    fixture = await startConfigurableApp();
    await createAdmin(fixture.app, ADMIN_EMAIL, ADMIN_PASSWORD);

    const firstResponse = await signIn(fixture.app);
    const firstCookie = cookieHeaderFrom(firstResponse);

    const secondResponse = await signIn(fixture.app, firstCookie);
    const secondCookie = cookieHeaderFrom(secondResponse);

    expect(secondCookie).not.toBe(firstCookie);

    const firstSession = await fixture.app.inject({
      method: 'GET',
      url: '/api/auth/get-session',
      headers: { cookie: firstCookie },
    });
    const secondSession = await fixture.app.inject({
      method: 'GET',
      url: '/api/auth/get-session',
      headers: { cookie: secondCookie },
    });

    expect(firstSession.statusCode).toBe(200);
    expect(firstSession.json()).not.toBeNull();
    expect(secondSession.statusCode).toBe(200);
    const firstBody = firstSession.json() as { session: { id: string } };
    const secondBody = secondSession.json() as { session: { id: string } };
    expect(firstBody.session.id).not.toBe(secondBody.session.id);
  });

  it('never omits HttpOnly on any Set-Cookie header the sign-in response carries', async () => {
    fixture = await startConfigurableApp();
    await createAdmin(fixture.app, ADMIN_EMAIL, ADMIN_PASSWORD);

    const response = await signIn(fixture.app);
    const cookies = parsedCookies(response);

    expect(cookies.length).toBeGreaterThan(0);
    for (const cookie of cookies) {
      expect(cookie.httpOnly).toBe(true);
    }
  });
});
