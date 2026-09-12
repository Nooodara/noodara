import { and, eq, isNull } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { activityEvents } from '../../../apps/control-plane/src/db/schema/activity-events.js';
import { users } from '../../../apps/control-plane/src/db/schema/auth.js';
import { setupTokens } from '../../../apps/control-plane/src/db/schema/setup-tokens.js';
import { startTestApp, type TestAppFixture } from '../helpers/app.js';

// D-01/D-04 (01-14-PLAN.md): first-boot admin bootstrap. Every scenario is driven against a real
// PostgreSQL through `bootstrapAdmin` directly (never through HTTP), matching the plan's own
// framing of this as a boot-time decision, not a route.
//
// `bootstrap-admin.ts` transitively imports `setup-service.ts` -> `auth.ts` -> `env.ts`, and
// `env.ts` fail-fasts on `process.env` at *import* time (INST-06) — so, like `auth.js`/`env.js`
// themselves, it must be imported dynamically, once per test, only after `startTestApp()` has
// written a valid environment. `@noodara/domain/security`'s `revealSecret`/`hashSetupToken` are
// loaded from that same dynamic pass (not a static top-level import) so every helper used in a
// given test resolves the identical `SecretValue` class instance `bootstrap-admin.ts` itself
// used — a private-field brand mismatch otherwise throws across two separately-loaded copies.

const ADMIN_EMAIL = 'admin@noodara.test';
const ADMIN_PASSWORD = 'correct horse battery staple';

let fixture: TestAppFixture | undefined;

beforeEach(() => {
  vi.resetModules();
  delete process.env.NOODARA_ADMIN_EMAIL;
  delete process.env.NOODARA_ADMIN_PASSWORD;
});

afterEach(async () => {
  delete process.env.NOODARA_ADMIN_EMAIL;
  delete process.env.NOODARA_ADMIN_PASSWORD;
  await fixture?.stop();
  fixture = undefined;

  // noodara-tdd skill §5: no stray container labelled noodara.test=true survives a run.
  const { getContainerRuntimeClient } = await import('testcontainers');
  const client = await getContainerRuntimeClient();
  const containers = await client.container.list();
  const stray = containers.filter((c) => c.Labels['noodara.test'] === 'true');
  expect(stray).toHaveLength(0);
});

async function loadDeps(): Promise<{
  bootstrapAdmin: typeof import('../../../apps/control-plane/src/boot/bootstrap-admin.js').bootstrapAdmin;
  deriveSetupTokenValue: typeof import('../../../apps/control-plane/src/boot/bootstrap-admin.js').deriveSetupTokenValue;
  auth: typeof import('../../../apps/control-plane/src/auth/auth.js').auth;
  env: typeof import('../../../apps/control-plane/src/env.js').env;
  revealSecret: typeof import('@noodara/domain/security').revealSecret;
  hashSetupToken: typeof import('@noodara/domain/security').hashSetupToken;
}> {
  const { bootstrapAdmin, deriveSetupTokenValue } = await import(
    '../../../apps/control-plane/src/boot/bootstrap-admin.js'
  );
  const { auth } = await import('../../../apps/control-plane/src/auth/auth.js');
  const { env } = await import('../../../apps/control-plane/src/env.js');
  const { revealSecret, hashSetupToken } = await import('@noodara/domain/security');
  return { bootstrapAdmin, deriveSetupTokenValue, auth, env, revealSecret, hashSetupToken };
}

async function userCount(db: TestAppFixture['db']): Promise<number> {
  const rows = await db.select({ id: users.id }).from(users);
  return rows.length;
}

describe('bootstrapAdmin (D-01/D-04)', () => {
  it('issues and prints a setup token, storing only its hash, when no admin and no pre-seed vars exist', async () => {
    fixture = await startTestApp();
    const { bootstrapAdmin, deriveSetupTokenValue, auth, env, revealSecret, hashSetupToken } = await loadDeps();
    const writeSpy = vi.spyOn(process.stdout, 'write').mockReturnValue(true);

    try {
      await bootstrapAdmin({ db: fixture.db, auth, logger: fixture.app.log, env });

      const printedCall = writeSpy.mock.calls.find((call) =>
        String(call[0]).startsWith('NOODARA_SETUP_TOKEN='),
      );
      expect(printedCall).toBeDefined();
      const printedToken = String(printedCall?.[0]).replace('NOODARA_SETUP_TOKEN=', '').trim();

      const rows = await fixture.db.select().from(setupTokens);
      expect(rows).toHaveLength(1);
      expect(rows[0]?.tokenHash).toBe(hashSetupToken(printedToken));
      expect(rows[0]?.tokenHash).not.toBe(printedToken);

      // The printed token is genuinely redeemable through the real setup route.
      const response = await fixture.app.inject({
        method: 'POST',
        url: '/api/setup',
        payload: { token: printedToken, email: ADMIN_EMAIL, password: ADMIN_PASSWORD },
      });
      expect(response.statusCode).toBe(200);
      expect(await userCount(fixture.db)).toBe(1);
    } finally {
      writeSpy.mockRestore();
    }
  });

  it('reprints the exact same token and leaves exactly one row across two consecutive boots', async () => {
    fixture = await startTestApp();
    const { bootstrapAdmin, deriveSetupTokenValue, auth, env, revealSecret, hashSetupToken } = await loadDeps();
    const writeSpy = vi.spyOn(process.stdout, 'write').mockReturnValue(true);

    try {
      await bootstrapAdmin({ db: fixture.db, auth, logger: fixture.app.log, env });
      const first = writeSpy.mock.calls.find((call) => String(call[0]).startsWith('NOODARA_SETUP_TOKEN='));
      writeSpy.mockClear();

      await bootstrapAdmin({ db: fixture.db, auth, logger: fixture.app.log, env });
      const second = writeSpy.mock.calls.find((call) => String(call[0]).startsWith('NOODARA_SETUP_TOKEN='));

      expect(first?.[0]).toBe(second?.[0]);
      const rows = await fixture.db.select().from(setupTokens);
      expect(rows).toHaveLength(1);
    } finally {
      writeSpy.mockRestore();
    }
  });

  it('issues a fresh token and leaves the expired row for audit when the previous one expired', async () => {
    fixture = await startTestApp();
    const { bootstrapAdmin, deriveSetupTokenValue, auth, env, revealSecret, hashSetupToken } = await loadDeps();
    const writeSpy = vi.spyOn(process.stdout, 'write').mockReturnValue(true);

    try {
      const firstBoot = new Date('2026-01-01T00:00:00.000Z');
      await bootstrapAdmin({ db: fixture.db, auth, logger: fixture.app.log, env, now: firstBoot });
      const first = writeSpy.mock.calls.find((call) => String(call[0]).startsWith('NOODARA_SETUP_TOKEN='));
      writeSpy.mockClear();

      const secondBoot = new Date(firstBoot.getTime() + 25 * 60 * 60 * 1000); // 25h later, past the 24h TTL
      await bootstrapAdmin({ db: fixture.db, auth, logger: fixture.app.log, env, now: secondBoot });
      const second = writeSpy.mock.calls.find((call) => String(call[0]).startsWith('NOODARA_SETUP_TOKEN='));

      expect(second?.[0]).not.toBe(first?.[0]);
      const rows = await fixture.db.select().from(setupTokens);
      expect(rows).toHaveLength(2);
    } finally {
      writeSpy.mockRestore();
    }
  });

  it('creates the admin directly, writes one auth.admin_preseeded event and issues zero tokens', async () => {
    process.env.NOODARA_ADMIN_EMAIL = ADMIN_EMAIL;
    process.env.NOODARA_ADMIN_PASSWORD = ADMIN_PASSWORD;
    fixture = await startTestApp();
    const { bootstrapAdmin, deriveSetupTokenValue, auth, env, revealSecret, hashSetupToken } = await loadDeps();
    const writeSpy = vi.spyOn(process.stdout, 'write').mockReturnValue(true);

    try {
      await bootstrapAdmin({ db: fixture.db, auth, logger: fixture.app.log, env });

      expect(await userCount(fixture.db)).toBe(1);
      const tokenRows = await fixture.db.select().from(setupTokens);
      expect(tokenRows).toHaveLength(0);
      expect(writeSpy.mock.calls.some((call) => String(call[0]).startsWith('NOODARA_SETUP_TOKEN='))).toBe(
        false,
      );

      const events = await fixture.db
        .select()
        .from(activityEvents)
        .where(eq(activityEvents.action, 'auth.admin_preseeded'));
      expect(events).toHaveLength(1);
      expect(events[0]?.metadata).toEqual({ email: ADMIN_EMAIL });
    } finally {
      writeSpy.mockRestore();
    }
  });

  it('aborts the boot without creating a user when the pre-seed password fails policy', async () => {
    process.env.NOODARA_ADMIN_EMAIL = ADMIN_EMAIL;
    process.env.NOODARA_ADMIN_PASSWORD = 'short';
    fixture = await startTestApp();
    const { bootstrapAdmin, deriveSetupTokenValue, auth, env, revealSecret, hashSetupToken } = await loadDeps();

    await expect(bootstrapAdmin({ db: fixture.db, auth, logger: fixture.app.log, env })).rejects.toThrow(
      /password/i,
    );
    expect(await userCount(fixture.db)).toBe(0);
  });

  it('ignores NOODARA_ADMIN_* and warns naming both variables when an admin already exists', async () => {
    fixture = await startTestApp();
    const { bootstrapAdmin, deriveSetupTokenValue, auth, env, revealSecret, hashSetupToken } = await loadDeps();

    // Establish the admin first (no pre-seed vars set yet).
    await bootstrapAdmin({ db: fixture.db, auth, logger: fixture.app.log, env });
    const [activeRow] = await fixture.db
      .select()
      .from(setupTokens)
      .where(and(eq(setupTokens.purpose, 'setup'), isNull(setupTokens.usedAt)));
    expect(activeRow).toBeDefined();
    // Redeem it so an admin genuinely exists for this scenario.
    // The token value is derived deterministically inside bootstrap-admin.ts; recompute it here
    // via the same derivation to avoid depending on stdout capture across two calls.
    const rawToken = revealSecret(deriveSetupTokenValue(activeRow!.id, env.BETTER_AUTH_SECRET));
    const setupResponse = await fixture.app.inject({
      method: 'POST',
      url: '/api/setup',
      payload: { token: rawToken, email: ADMIN_EMAIL, password: ADMIN_PASSWORD },
    });
    expect(setupResponse.statusCode).toBe(200);
    expect(await userCount(fixture.db)).toBe(1);

    process.env.NOODARA_ADMIN_EMAIL = 'someone-else@noodara.test';
    process.env.NOODARA_ADMIN_PASSWORD = 'another good password 123';
    const warnCalls: unknown[][] = [];
    const fakeLogger = { warn: (...args: unknown[]) => warnCalls.push(args) };

    await bootstrapAdmin({
      db: fixture.db,
      auth,
      logger: fakeLogger,
      env: { ...env, NOODARA_ADMIN_EMAIL: process.env.NOODARA_ADMIN_EMAIL, NOODARA_ADMIN_PASSWORD: process.env.NOODARA_ADMIN_PASSWORD },
    });

    expect(await userCount(fixture.db)).toBe(1);
    expect(warnCalls).toHaveLength(1);
    const [meta] = warnCalls[0] as [Record<string, unknown>, string];
    expect(meta.ignoredVariables).toEqual(['NOODARA_ADMIN_EMAIL', 'NOODARA_ADMIN_PASSWORD']);
  });

  it('does nothing when an admin already exists and no pre-seed vars are set', async () => {
    fixture = await startTestApp();
    const { bootstrapAdmin, deriveSetupTokenValue, auth, env, revealSecret, hashSetupToken } = await loadDeps();

    await bootstrapAdmin({ db: fixture.db, auth, logger: fixture.app.log, env });
    const [activeRow] = await fixture.db
      .select()
      .from(setupTokens)
      .where(and(eq(setupTokens.purpose, 'setup'), isNull(setupTokens.usedAt)));
    const rawToken = revealSecret(deriveSetupTokenValue(activeRow!.id, env.BETTER_AUTH_SECRET));
    await fixture.app.inject({
      method: 'POST',
      url: '/api/setup',
      payload: { token: rawToken, email: ADMIN_EMAIL, password: ADMIN_PASSWORD },
    });

    const writeSpy = vi.spyOn(process.stdout, 'write').mockReturnValue(true);
    const warnCalls: unknown[][] = [];
    const fakeLogger = { warn: (...args: unknown[]) => warnCalls.push(args) };

    try {
      await bootstrapAdmin({ db: fixture.db, auth, logger: fakeLogger, env });

      expect(await userCount(fixture.db)).toBe(1);
      expect(warnCalls).toHaveLength(0);
      expect(writeSpy.mock.calls.some((call) => String(call[0]).startsWith('NOODARA_SETUP_TOKEN='))).toBe(
        false,
      );
    } finally {
      writeSpy.mockRestore();
    }
  });
});
