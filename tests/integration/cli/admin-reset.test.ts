import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { revealSecret } from '@noodara/domain/security';
import { activityEvents } from '../../../apps/control-plane/src/db/schema/activity-events.js';
import { sessions, users } from '../../../apps/control-plane/src/db/schema/auth.js';
import { setupTokens } from '../../../apps/control-plane/src/db/schema/setup-tokens.js';
import { issueToken } from '../../../apps/control-plane/src/services/setup-token-repository.js';
import { startTestApp, type TestAppFixture } from '../helpers/app.js';

// `setup-token-repository.ts` (`issueToken`) has no top-level `env.ts`/`auth.ts` import, so it is
// safe to import statically here (same precedent as `tests/integration/auth/setup.test.ts`).
// `adminResetCommand` (`cli/admin-reset.ts`) transitively imports `setup-service.ts` -> `auth.ts`
// -> `env.ts`, which fail-fasts on `process.env` at *import* time (INST-06) — it must be imported
// dynamically, once per test, only after `startTestApp()` has written a valid environment.
async function loadAdminResetCommand(): Promise<
  typeof import('../../../apps/control-plane/src/cli/admin-reset.js').adminResetCommand
> {
  const { adminResetCommand } = await import('../../../apps/control-plane/src/cli/admin-reset.js');
  return adminResetCommand;
}

const ADMIN_EMAIL = 'admin@noodara.test';
const ADMIN_PASSWORD = 'correct horse battery staple';
const NEW_PASSWORD = 'a totally different passphrase 42';

const CONTROL_PLANE_DIR = path.resolve(import.meta.dirname, '../../../apps/control-plane');
const TSX_BIN = path.join(CONTROL_PLANE_DIR, 'node_modules', '.bin', 'tsx');
const CLI_ENTRY = path.join(CONTROL_PLANE_DIR, 'src', 'cli', 'index.ts');

let fixture: TestAppFixture | undefined;

beforeEach(() => {
  vi.resetModules();
});

afterEach(async () => {
  await fixture?.stop();
  fixture = undefined;

  // noodara-tdd skill §5: no stray container labelled noodara.test=true survives a run.
  const { getContainerRuntimeClient } = await import('testcontainers');
  const client = await getContainerRuntimeClient();
  const containers = await client.container.list();
  const stray = containers.filter((c) => c.Labels['noodara.test'] === 'true');
  expect(stray).toHaveLength(0);
});

async function createAdmin(f: TestAppFixture): Promise<void> {
  const issued = await issueToken(f.db, 'setup', new Date());
  const response = await f.app.inject({
    method: 'POST',
    url: '/api/setup',
    payload: { token: revealSecret(issued.token), email: ADMIN_EMAIL, password: ADMIN_PASSWORD },
  });
  expect(response.statusCode).toBe(200);
}

async function signIn(f: TestAppFixture, password: string): Promise<number> {
  const response = await f.app.inject({
    method: 'POST',
    url: '/api/auth/sign-in/email',
    payload: { email: ADMIN_EMAIL, password },
  });
  return response.statusCode;
}

interface CliResult {
  status: number | null;
  stdout: string;
  stderr: string;
}

/** Spawns the real `cli/index.ts` entrypoint through `tsx` — the same tool `db:migrate` already
 *  uses (Plan 01-07) to work around `packages/domain`'s `.ts`-source-only `exports`, which plain
 *  `node` cannot resolve. */
function spawnCli(args: string[], env: NodeJS.ProcessEnv): CliResult {
  const result = spawnSync(TSX_BIN, [CLI_ENTRY, ...args], {
    cwd: CONTROL_PLANE_DIR,
    env,
    encoding: 'utf8',
  });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

describe('noodara --help', () => {
  it('exits 0 and names both subcommands', () => {
    const result = spawnCli(['--help'], {
      ...process.env,
      NOODARA_MASTER_KEY: 'eWB5OqY8pzJkJZV29xSd3tXvJl4T6vytT1ChtZa7wRM=',
      BETTER_AUTH_SECRET: 'cli-fixture-better-auth-secret-not-real-32-chars',
      DATABASE_URL: 'postgres://test_user:test-fixture-pw@localhost:5432/noodara_test',
      REDIS_URL: 'redis://localhost:6379',
      NOODARA_PUBLIC_URL: 'http://localhost:3000',
    });

    expect(result.status).toBe(0);
    expect(result.stdout).toMatch(/admin/);
    expect(result.stdout).toMatch(/secrets/);
  });
});

describe('adminResetCommand (D-03)', () => {
  it('issues a recovery token, stores only its hash, and exits 0 when an admin exists', async () => {
    fixture = await startTestApp();
    await createAdmin(fixture);
    const adminResetCommand = await loadAdminResetCommand();
    const writeSpy = vi.spyOn(process.stdout, 'write').mockReturnValue(true);
    const errorLogger = { error: vi.fn() };

    try {
      const exitCode = await adminResetCommand({ db: fixture.db, logger: errorLogger });
      expect(exitCode).toBe(0);

      const printedCall = writeSpy.mock.calls.find((call) =>
        String(call[0]).startsWith('NOODARA_RECOVERY_TOKEN='),
      );
      expect(printedCall).toBeDefined();
      const printedToken = String(printedCall?.[0]).replace('NOODARA_RECOVERY_TOKEN=', '').trim();

      const rows = await fixture.db.select().from(setupTokens).where(eq(setupTokens.purpose, 'recovery'));
      expect(rows).toHaveLength(1);
      expect(rows[0]?.tokenHash).not.toBe(printedToken);
    } finally {
      writeSpy.mockRestore();
    }
  });

  it('exits non-zero and points at the setup token flow when no admin exists', async () => {
    fixture = await startTestApp();
    const adminResetCommand = await loadAdminResetCommand();
    const errorLogger = { error: vi.fn() };

    const exitCode = await adminResetCommand({ db: fixture.db, logger: errorLogger });

    expect(exitCode).toBe(1);
    expect(errorLogger.error).toHaveBeenCalledTimes(1);
    expect(String(errorLogger.error.mock.calls[0]?.[0])).toMatch(/setup token/i);
  });

  it('exits non-zero with an actionable message and never prints DATABASE_URL when the database is unreachable', () => {
    const badDatabaseUrl = 'postgres://test_user:test-fixture-pw@127.0.0.1:1/noodara_test';
    const result = spawnCli(['admin', 'reset'], {
      ...process.env,
      NOODARA_MASTER_KEY: 'eWB5OqY8pzJkJZV29xSd3tXvJl4T6vytT1ChtZa7wRM=',
      BETTER_AUTH_SECRET: 'cli-fixture-better-auth-secret-not-real-32-chars',
      DATABASE_URL: badDatabaseUrl,
      REDIS_URL: 'redis://localhost:6379',
      NOODARA_PUBLIC_URL: 'http://localhost:3000',
    });

    expect(result.status).not.toBe(0);
    expect(result.stderr).not.toContain(badDatabaseUrl);
    expect(result.stderr).not.toContain('test-fixture-pw');
    expect(result.stderr.length).toBeGreaterThan(0);
  });
});

describe('POST /api/recovery (D-03)', () => {
  it('redeems a recovery token: new password works, all sessions are revoked, token is marked used', async () => {
    fixture = await startTestApp();
    await createAdmin(fixture);
    expect(await signIn(fixture, ADMIN_PASSWORD)).toBe(200);

    const [admin] = await fixture.db.select({ id: users.id }).from(users).limit(1);
    const sessionsBefore = await fixture.db.select().from(sessions).where(eq(sessions.userId, admin!.id));
    expect(sessionsBefore.length).toBeGreaterThan(0);

    const issued = await issueToken(fixture.db, 'recovery', new Date());
    const response = await fixture.app.inject({
      method: 'POST',
      url: '/api/recovery',
      payload: { token: revealSecret(issued.token), newPassword: NEW_PASSWORD },
    });
    expect(response.statusCode).toBe(200);

    const sessionsImmediatelyAfter = await fixture.db
      .select()
      .from(sessions)
      .where(eq(sessions.userId, admin!.id));
    expect(sessionsImmediatelyAfter).toHaveLength(0);

    expect(await signIn(fixture, ADMIN_PASSWORD)).not.toBe(200);
    expect(await signIn(fixture, NEW_PASSWORD)).toBe(200);

    const [tokenRow] = await fixture.db.select().from(setupTokens).where(eq(setupTokens.id, issued.id));
    expect(tokenRow?.usedAt).not.toBeNull();

    const events = await fixture.db
      .select()
      .from(activityEvents)
      .where(eq(activityEvents.action, 'auth.password_reset'));
    expect(events).toHaveLength(1);
    expect(events[0]?.metadata).toEqual({});
  });

  it('rejects a setup-purpose token at POST /api/recovery, leaving used_at null', async () => {
    fixture = await startTestApp();
    await createAdmin(fixture);
    const issued = await issueToken(fixture.db, 'setup', new Date());

    const response = await fixture.app.inject({
      method: 'POST',
      url: '/api/recovery',
      payload: { token: revealSecret(issued.token), newPassword: NEW_PASSWORD },
    });

    expect(response.statusCode).toBe(400);
    const [row] = await fixture.db.select().from(setupTokens).where(eq(setupTokens.id, issued.id));
    expect(row?.usedAt).toBeNull();
  });

  it('rejects a recovery-purpose token at POST /api/setup (4xx), leaving used_at null', async () => {
    fixture = await startTestApp();
    await createAdmin(fixture);
    const issued = await issueToken(fixture.db, 'recovery', new Date());

    // D-02's door-closing rule (adminExists() checked before any token is evaluated) already
    // 404s this route once an admin exists — which a recovery token, by construction, implies.
    const response = await fixture.app.inject({
      method: 'POST',
      url: '/api/setup',
      payload: {
        token: revealSecret(issued.token),
        email: 'someone-else@noodara.test',
        password: 'irrelevant password value 123',
      },
    });
    expect(response.statusCode).toBeGreaterThanOrEqual(400);
    expect(response.statusCode).toBeLessThan(500);

    const [row] = await fixture.db.select().from(setupTokens).where(eq(setupTokens.id, issued.id));
    expect(row?.usedAt).toBeNull();
  });

  it('purpose is checked at the service layer, not just usability: a recovery token is rejected by redeemSetupToken', async () => {
    fixture = await startTestApp();
    const { redeemSetupToken } = await import('../../../apps/control-plane/src/services/setup-service.js');
    const issued = await issueToken(fixture.db, 'recovery', new Date());

    const result = await redeemSetupToken({
      token: revealSecret(issued.token),
      email: 'someone@noodara.test',
      password: 'irrelevant password value 123',
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe('TOKEN_INVALID');
    }
    const [row] = await fixture.db.select().from(setupTokens).where(eq(setupTokens.id, issued.id));
    expect(row?.usedAt).toBeNull();
  });

  it('purpose is checked at the service layer, not just usability: a setup token is rejected by redeemRecoveryToken', async () => {
    fixture = await startTestApp();
    const { redeemRecoveryToken } = await import('../../../apps/control-plane/src/services/setup-service.js');
    const issued = await issueToken(fixture.db, 'setup', new Date());

    const result = await redeemRecoveryToken({
      token: revealSecret(issued.token),
      newPassword: NEW_PASSWORD,
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe('TOKEN_INVALID');
    }
    const [row] = await fixture.db.select().from(setupTokens).where(eq(setupTokens.id, issued.id));
    expect(row?.usedAt).toBeNull();
  });
});
