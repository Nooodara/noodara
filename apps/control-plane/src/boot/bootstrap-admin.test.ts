import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SetupTokenRow } from '../services/setup-token-repository.js';
import type { BootstrapAdminAuth, BootstrapAdminLogger } from './bootstrap-admin.js';

vi.mock('../services/setup-service.js', () => ({ adminExists: vi.fn() }));
vi.mock('../services/setup-token-repository.js', () => ({ markUsed: vi.fn() }));
vi.mock('../activity/write-activity-event.js', () => ({
  writeActivityEvent: vi.fn().mockResolvedValue('activity-id'),
}));
vi.mock('../auth/bootstrap-context.js', () => ({
  runInBootstrap: vi.fn(async (fn: () => Promise<unknown>) => fn()),
}));

// Imported after the mocks above so the mocked bindings are the ones bootstrap-admin.ts resolves.
const { adminExists } = await import('../services/setup-service.js');
const { markUsed } = await import('../services/setup-token-repository.js');
const { writeActivityEvent } = await import('../activity/write-activity-event.js');
const { runInBootstrap } = await import('../auth/bootstrap-context.js');
const { bootstrapAdmin, AdminPreseedPolicyError, deriveSetupTokenValue } = await import(
  './bootstrap-admin.js'
);

const SECRET = 'unit-test-better-auth-secret-at-least-32-chars';
const NOW = new Date('2026-09-12T00:00:00.000Z');

interface FakeDb {
  select: ReturnType<typeof vi.fn>;
  insert: ReturnType<typeof vi.fn>;
  transaction: ReturnType<typeof vi.fn>;
  insertedValues: Record<string, unknown>[];
}

function createFakeDb(activeRow?: Partial<SetupTokenRow>): FakeDb {
  const insertedValues: Record<string, unknown>[] = [];
  const where = vi.fn().mockResolvedValue(activeRow ? [activeRow] : []);
  const from = vi.fn().mockReturnValue({ where });
  const select = vi.fn().mockReturnValue({ from });

  const values = vi.fn().mockImplementation((v: Record<string, unknown>) => {
    insertedValues.push(v);
    return Promise.resolve(undefined);
  });
  const insert = vi.fn().mockReturnValue({ values });

  const transaction = vi.fn().mockImplementation(async (cb: (tx: unknown) => Promise<void>) => {
    await cb(fakeDb);
  });

  const fakeDb: FakeDb = { select, insert, transaction, insertedValues };
  return fakeDb;
}

interface FakeLogger {
  warn: ReturnType<typeof vi.fn>;
}

function createLogger(): FakeLogger {
  return { warn: vi.fn() };
}

function asAuthDep(auth: { api: { signUpEmail: ReturnType<typeof vi.fn> } }): BootstrapAdminAuth {
  return auth as unknown as BootstrapAdminAuth;
}

function asLoggerDep(logger: FakeLogger): BootstrapAdminLogger {
  return logger as unknown as BootstrapAdminLogger;
}

function createAuth(userId = 'admin-id'): { api: { signUpEmail: ReturnType<typeof vi.fn> } } {
  return { api: { signUpEmail: vi.fn().mockResolvedValue({ user: { id: userId } }) } };
}

describe('bootstrapAdmin', () => {
  beforeEach(() => {
    vi.mocked(adminExists).mockReset();
    vi.mocked(markUsed).mockReset().mockResolvedValue(undefined);
    vi.mocked(writeActivityEvent).mockReset().mockResolvedValue('activity-id');
    vi.mocked(runInBootstrap).mockReset().mockImplementation(async (fn: () => Promise<unknown>) => fn());
  });

  it('warns naming both variables and creates nothing when an admin exists and pre-seed vars are set', async () => {
    vi.mocked(adminExists).mockResolvedValue(true);
    const db = createFakeDb();
    const logger = createLogger();
    const auth = createAuth();

    await bootstrapAdmin({
      db: db as never,
      auth: asAuthDep(auth),
      logger: asLoggerDep(logger),
      env: { NOODARA_ADMIN_EMAIL: 'admin@noodara.test', NOODARA_ADMIN_PASSWORD: 'correct horse battery staple', BETTER_AUTH_SECRET: SECRET },
      now: NOW,
    });

    expect(logger.warn).toHaveBeenCalledTimes(1);
    const [meta, message] = logger.warn.mock.calls[0] as [Record<string, unknown>, string];
    expect(meta.ignoredVariables).toEqual(['NOODARA_ADMIN_EMAIL', 'NOODARA_ADMIN_PASSWORD']);
    expect(message).toMatch(/ignored/);
    expect(auth.api.signUpEmail).not.toHaveBeenCalled();
    expect(db.insert).not.toHaveBeenCalled();
  });

  it('does nothing when an admin exists and no pre-seed vars are set', async () => {
    vi.mocked(adminExists).mockResolvedValue(true);
    const db = createFakeDb();
    const logger = createLogger();
    const auth = createAuth();

    await bootstrapAdmin({
      db: db as never,
      auth: asAuthDep(auth),
      logger: asLoggerDep(logger),
      env: { BETTER_AUTH_SECRET: SECRET },
      now: NOW,
    });

    expect(logger.warn).not.toHaveBeenCalled();
    expect(auth.api.signUpEmail).not.toHaveBeenCalled();
    expect(db.insert).not.toHaveBeenCalled();
    expect(db.select).not.toHaveBeenCalled();
  });

  it('creates the admin, writes one auth.admin_preseeded event and issues zero tokens', async () => {
    vi.mocked(adminExists).mockResolvedValue(false);
    const db = createFakeDb();
    const logger = createLogger();
    const auth = createAuth('preseeded-admin-id');

    await bootstrapAdmin({
      db: db as never,
      auth: asAuthDep(auth),
      logger: asLoggerDep(logger),
      env: {
        NOODARA_ADMIN_EMAIL: 'admin@noodara.test',
        NOODARA_ADMIN_PASSWORD: 'correct horse battery staple',
        BETTER_AUTH_SECRET: SECRET,
      },
      now: NOW,
    });

    expect(auth.api.signUpEmail).toHaveBeenCalledTimes(1);
    expect(runInBootstrap).toHaveBeenCalledTimes(1);
    expect(writeActivityEvent).toHaveBeenCalledTimes(1);
    const call = vi.mocked(writeActivityEvent).mock.calls[0];
    const input = call?.[1] as unknown as Record<string, unknown>;
    expect(input.action).toBe('auth.admin_preseeded');
    expect(input.entityId).toBe('preseeded-admin-id');
    expect(input.metadata).toEqual({ email: 'admin@noodara.test' });
    expect(db.insert).not.toHaveBeenCalled();
    expect(db.transaction).toHaveBeenCalledTimes(1);
  });

  it('aborts without creating a user when the pre-seed password fails policy', async () => {
    vi.mocked(adminExists).mockResolvedValue(false);
    const db = createFakeDb();
    const logger = createLogger();
    const auth = createAuth();

    await expect(
      bootstrapAdmin({
        db: db as never,
        auth: asAuthDep(auth),
        logger: asLoggerDep(logger),
        env: { NOODARA_ADMIN_EMAIL: 'admin@noodara.test', NOODARA_ADMIN_PASSWORD: 'short', BETTER_AUTH_SECRET: SECRET },
        now: NOW,
      }),
    ).rejects.toThrow(AdminPreseedPolicyError);

    expect(auth.api.signUpEmail).not.toHaveBeenCalled();
    expect(writeActivityEvent).not.toHaveBeenCalled();
  });

  it('issues and prints a setup token, inserting exactly one row, when no admin and no pre-seed vars exist', async () => {
    vi.mocked(adminExists).mockResolvedValue(false);
    const db = createFakeDb(undefined);
    const logger = createLogger();
    const auth = createAuth();
    const writeSpy = vi.spyOn(process.stdout, 'write').mockReturnValue(true);

    try {
      await bootstrapAdmin({ db: db as never, auth: asAuthDep(auth), logger: asLoggerDep(logger), env: { BETTER_AUTH_SECRET: SECRET }, now: NOW });

      expect(db.insertedValues).toHaveLength(1);
      expect(markUsed).not.toHaveBeenCalled();
      expect(writeSpy).toHaveBeenCalledTimes(1);
      const printed = writeSpy.mock.calls[0]?.[0] as string;
      expect(printed).toMatch(/^NOODARA_SETUP_TOKEN=.+\n$/);

      const inserted = db.insertedValues[0] as { id: string; tokenHash: string; purpose: string };
      expect(inserted.purpose).toBe('setup');
      const printedToken = printed.replace('NOODARA_SETUP_TOKEN=', '').trim();
      expect(inserted.tokenHash).not.toBe(printedToken);
      const expected = deriveSetupTokenValue(inserted.id, SECRET);
      const { revealSecret } = await import('@noodara/domain/security');
      expect(printedToken).toBe(revealSecret(expected));
    } finally {
      writeSpy.mockRestore();
    }
  });

  it('reprints the exact same token on a second boot when the active row is unused and unexpired', async () => {
    vi.mocked(adminExists).mockResolvedValue(false);
    const rowId = 'row-1';
    const activeRow: Partial<SetupTokenRow> = {
      id: rowId,
      usedAt: null,
      expiresAt: new Date(NOW.getTime() + 60_000),
    };
    const db = createFakeDb(activeRow);
    const logger = createLogger();
    const auth = createAuth();
    const writeSpy = vi.spyOn(process.stdout, 'write').mockReturnValue(true);

    try {
      await bootstrapAdmin({ db: db as never, auth: asAuthDep(auth), logger: asLoggerDep(logger), env: { BETTER_AUTH_SECRET: SECRET }, now: NOW });

      expect(db.insert).not.toHaveBeenCalled();
      expect(markUsed).not.toHaveBeenCalled();
      const printed = writeSpy.mock.calls[0]?.[0] as string;
      const { revealSecret } = await import('@noodara/domain/security');
      expect(printed).toBe(`NOODARA_SETUP_TOKEN=${revealSecret(deriveSetupTokenValue(rowId, SECRET))}\n`);
    } finally {
      writeSpy.mockRestore();
    }
  });

  it('issues a new token and marks the old one used when the active row has expired', async () => {
    vi.mocked(adminExists).mockResolvedValue(false);
    const oldRowId = 'old-row';
    const activeRow: Partial<SetupTokenRow> = {
      id: oldRowId,
      usedAt: null,
      expiresAt: new Date(NOW.getTime() - 1000),
    };
    const db = createFakeDb(activeRow);
    const logger = createLogger();
    const auth = createAuth();
    const writeSpy = vi.spyOn(process.stdout, 'write').mockReturnValue(true);

    try {
      await bootstrapAdmin({ db: db as never, auth: asAuthDep(auth), logger: asLoggerDep(logger), env: { BETTER_AUTH_SECRET: SECRET }, now: NOW });

      expect(markUsed).toHaveBeenCalledWith(db, oldRowId, NOW);
      expect(db.insertedValues).toHaveLength(1);
      const printed = writeSpy.mock.calls[0]?.[0] as string;
      const { revealSecret } = await import('@noodara/domain/security');
      const oldToken = revealSecret(deriveSetupTokenValue(oldRowId, SECRET));
      expect(printed).not.toContain(oldToken);
    } finally {
      writeSpy.mockRestore();
    }
  });
});

describe('deriveSetupTokenValue', () => {
  it('is deterministic for the same row id and secret', async () => {
    const { revealSecret } = await import('@noodara/domain/security');
    const a = deriveSetupTokenValue('row-x', SECRET);
    const b = deriveSetupTokenValue('row-x', SECRET);
    expect(revealSecret(a)).toBe(revealSecret(b));
  });

  it('differs across row ids', async () => {
    const { revealSecret } = await import('@noodara/domain/security');
    const a = deriveSetupTokenValue('row-x', SECRET);
    const b = deriveSetupTokenValue('row-y', SECRET);
    expect(revealSecret(a)).not.toBe(revealSecret(b));
  });
});
