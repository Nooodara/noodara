import { randomBytes } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { decryptSecret, encryptSecret, type EncryptedBlob } from '@noodara/domain/security';
import { secretsRotateCommand } from '../../../apps/control-plane/src/cli/secrets-rotate.js';
import { credentials } from '../../../apps/control-plane/src/db/schema/credentials.js';
import { projects } from '../../../apps/control-plane/src/db/schema/projects.js';
import { secrets } from '../../../apps/control-plane/src/db/schema/secrets.js';
import { startPostgres, type PostgresFixture } from '../helpers/postgres.js';

// D-11/SEC-01 (01-14-PLAN.md): `noodara secrets rotate` re-encrypts every `credentials` row in
// one transaction under a new master key. `secrets-rotate.ts` has no top-level `env.ts`/`auth.ts`
// import (env is an injected parameter), so — unlike auth-adjacent modules elsewhere in this
// phase — it is safe to import statically here.

const OLD_KEY = randomBytes(32);
const NEW_KEY = randomBytes(32);

let fixture: PostgresFixture | undefined;

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

function envWith(overrides: { previous?: Buffer | undefined; current?: Buffer } = {}): {
  NOODARA_MASTER_KEY: string;
  NOODARA_MASTER_KEY_PREVIOUS?: string;
} {
  const current = overrides.current ?? NEW_KEY;
  const previous = overrides.previous;
  return {
    NOODARA_MASTER_KEY: current.toString('base64'),
    ...(previous !== undefined ? { NOODARA_MASTER_KEY_PREVIOUS: previous.toString('base64') } : {}),
  };
}

function createLogger(): { error: ReturnType<typeof vi.fn>; info: ReturnType<typeof vi.fn> } {
  return { error: vi.fn(), info: vi.fn() };
}

async function seedRow(
  db: PostgresFixture['db'],
  plaintext: string,
  key: Buffer,
  version: number,
): Promise<string> {
  const blob = encryptSecret(plaintext, { key, version });
  const [row] = await db
    .insert(credentials)
    .values({ type: 'ssh_password', encryptedValue: blob, keyVersion: version })
    .returning({ id: credentials.id });
  return row!.id;
}

async function allRows(db: PostgresFixture['db']): Promise<(typeof credentials.$inferSelect)[]> {
  return db.select().from(credentials);
}

async function seedSecretRow(db: PostgresFixture['db'], projectId: string, name: string, plaintext: string, key: Buffer, version: number): Promise<string> {
  const [row] = await db
    .insert(secrets)
    .values({ scope: 'project', projectId, name, encryptedValue: encryptSecret(plaintext, { key, version }), keyVersion: version, hint: '' })
    .returning({ id: secrets.id });
  return row!.id;
}

async function seedProject(db: PostgresFixture['db']): Promise<string> {
  const [row] = await db.insert(projects).values({ name: 'Rotate', slug: 'rotate' }).returning({ id: projects.id });
  return row!.id;
}

describe('secretsRotateCommand (D-11, SEC-01)', () => {
  it('23-01 A2: rotates credentials and secrets together to one key version, decryptable under the new key', async () => {
    fixture = await startPostgres();
    await seedRow(fixture.db, 'plaintext-cred-one', OLD_KEY, 1);
    await seedRow(fixture.db, 'plaintext-cred-two', OLD_KEY, 1);
    const projectId = await seedProject(fixture.db);
    await seedSecretRow(fixture.db, projectId, 'one', 'plaintext-secret-one', OLD_KEY, 1);
    await seedSecretRow(fixture.db, projectId, 'two', 'plaintext-secret-two', OLD_KEY, 1);
    const [before] = await fixture.db.select({ version: secrets.version }).from(secrets).limit(1);
    const logger = createLogger();
    const writeSpy = vi.spyOn(process.stdout, 'write').mockReturnValue(true);

    try {
      const env = envWith({ previous: OLD_KEY, current: NEW_KEY });
      expect(await secretsRotateCommand({ db: fixture.db, env, logger })).toBe(0);
      expect(writeSpy.mock.calls.map((call) => String(call[0])).join('')).toMatch(/Rotated 4 row/);

      const rows = [
        ...(await allRows(fixture.db)).map((row) => ({ ...row, table: 'credentials' })),
        ...(await fixture.db.select().from(secrets)).map((row) => ({ ...row, table: 'secrets' })),
      ];
      expect(rows).toHaveLength(4);
      for (const row of rows) {
        expect(row.keyVersion).toBe(2);
        expect(row.encryptedValue.startsWith('v2:')).toBe(true);
        expect(decryptSecret(row.encryptedValue as EncryptedBlob, new Map([[2, NEW_KEY]]))).toMatch(
          row.table === 'credentials' ? /^plaintext-cred-/ : /^plaintext-secret-/,
        );
        expect(() => decryptSecret(row.encryptedValue as EncryptedBlob, new Map([[2, OLD_KEY]]))).toThrow();
      }
      // Rotation re-encrypts; it is not a value change, so the secret version stays put.
      const after = await fixture.db.select({ version: secrets.version }).from(secrets);
      expect(after.every((row) => row.version === before!.version)).toBe(true);

      // A second run with the same key pair changes nothing in either table.
      expect(await secretsRotateCommand({ db: fixture.db, env, logger })).toBe(0);
      const again = [...(await allRows(fixture.db)), ...(await fixture.db.select().from(secrets))];
      expect(again.map((row) => row.encryptedValue).sort()).toEqual(rows.map((row) => row.encryptedValue).sort());
    } finally {
      writeSpy.mockRestore();
    }
  });

  it('23-01 A2: a corrupt secrets row aborts the run and leaves both tables unchanged', async () => {
    fixture = await startPostgres();
    const credId = await seedRow(fixture.db, 'plaintext-cred', OLD_KEY, 1);
    const projectId = await seedProject(fixture.db);
    await seedSecretRow(fixture.db, projectId, 'bad', 'plaintext-secret', randomBytes(32), 1);
    const logger = createLogger();

    const exitCode = await secretsRotateCommand({ db: fixture.db, env: envWith({ previous: OLD_KEY, current: NEW_KEY }), logger });

    expect(exitCode).toBe(1);
    const [cred] = await fixture.db.select().from(credentials).where(eq(credentials.id, credId));
    expect(cred!.keyVersion).toBe(1);
    expect(decryptSecret(cred!.encryptedValue as EncryptedBlob, new Map([[1, OLD_KEY]]))).toBe('plaintext-cred');
    const secretRows = await fixture.db.select().from(secrets);
    expect(secretRows.every((row) => row.keyVersion === 1)).toBe(true);
  });

  it('rotates every row to a new key version, decryptable only under the new key', async () => {
    fixture = await startPostgres();
    await seedRow(fixture.db, 'plaintext-one', OLD_KEY, 1);
    await seedRow(fixture.db, 'plaintext-two', OLD_KEY, 1);
    await seedRow(fixture.db, 'plaintext-three', OLD_KEY, 1);
    const logger = createLogger();

    const exitCode = await secretsRotateCommand({
      db: fixture.db,
      env: envWith({ previous: OLD_KEY, current: NEW_KEY }),
      logger,
    });

    expect(exitCode).toBe(0);
    const rows = await allRows(fixture.db);
    expect(rows).toHaveLength(3);
    for (const row of rows) {
      expect(row.keyVersion).toBe(2);
      const plaintext = decryptSecret(row.encryptedValue as EncryptedBlob, new Map([[2, NEW_KEY]]));
      expect(plaintext).toMatch(/^plaintext-/);
      expect(() => decryptSecret(row.encryptedValue as EncryptedBlob, new Map([[2, OLD_KEY]]))).toThrow();
    }
  });

  it('aborts the transaction with zero rows changed when a row is corrupt, leaving every row decryptable under the previous key', async () => {
    fixture = await startPostgres();
    const goodId = await seedRow(fixture.db, 'plaintext-good', OLD_KEY, 1);
    const validBlob = encryptSecret('plaintext-corrupt', { key: OLD_KEY, version: 1 });
    const segments = validBlob.split(':');
    // Replace the auth tag (last segment) with a different, still-valid-shaped 16-byte tag —
    // GCM authentication fails under either key, exactly the "corrupt row" scenario D-11 guards
    // against.
    const corruptTag = randomBytes(16).toString('base64');
    const corruptBlob = [...segments.slice(0, -1), corruptTag].join(':');
    await fixture.db.insert(credentials).values({ type: 'ssh_password', encryptedValue: corruptBlob, keyVersion: 1 });
    const logger = createLogger();

    const exitCode = await secretsRotateCommand({
      db: fixture.db,
      env: envWith({ previous: OLD_KEY, current: NEW_KEY }),
      logger,
    });

    expect(exitCode).toBe(1);
    expect(logger.error).toHaveBeenCalled();
    const rows = await allRows(fixture.db);
    expect(rows.every((row) => row.keyVersion === 1)).toBe(true);
    const [goodRow] = rows.filter((row) => row.id === goodId);
    expect(decryptSecret(goodRow!.encryptedValue as EncryptedBlob, new Map([[1, OLD_KEY]]))).toBe(
      'plaintext-good',
    );
  });

  it('reports zero rotated rows and changes nothing on a second consecutive run', async () => {
    fixture = await startPostgres();
    await seedRow(fixture.db, 'plaintext-one', OLD_KEY, 1);
    await seedRow(fixture.db, 'plaintext-two', OLD_KEY, 1);
    const logger = createLogger();
    const env = envWith({ previous: OLD_KEY, current: NEW_KEY });

    const first = await secretsRotateCommand({ db: fixture.db, env, logger });
    expect(first).toBe(0);
    const afterFirst = await allRows(fixture.db);

    const second = await secretsRotateCommand({ db: fixture.db, env, logger });
    expect(second).toBe(0);
    const afterSecond = await allRows(fixture.db);

    expect(afterSecond).toEqual(afterFirst);
  });

  it('exits non-zero and rotates nothing when NOODARA_MASTER_KEY_PREVIOUS is missing', async () => {
    fixture = await startPostgres();
    await seedRow(fixture.db, 'plaintext-one', OLD_KEY, 1);
    const logger = createLogger();

    const exitCode = await secretsRotateCommand({
      db: fixture.db,
      env: envWith({ current: NEW_KEY }),
      logger,
    });

    expect(exitCode).toBe(1);
    expect(logger.error.mock.calls[0]?.[0]).toMatch(/NOODARA_MASTER_KEY_PREVIOUS/);
    const rows = await allRows(fixture.db);
    expect(rows.every((row) => row.keyVersion === 1)).toBe(true);
  });

  it('exits non-zero and rotates nothing when the two keys are identical', async () => {
    fixture = await startPostgres();
    await seedRow(fixture.db, 'plaintext-one', OLD_KEY, 1);
    const logger = createLogger();

    const exitCode = await secretsRotateCommand({
      db: fixture.db,
      env: envWith({ previous: OLD_KEY, current: OLD_KEY }),
      logger,
    });

    expect(exitCode).toBe(1);
    const rows = await allRows(fixture.db);
    expect(rows.every((row) => row.keyVersion === 1)).toBe(true);
  });

  it('never prints either key, plaintext, or any ciphertext substring in its output', async () => {
    fixture = await startPostgres();
    const id = await seedRow(fixture.db, 'super-secret-plaintext-value', OLD_KEY, 1);
    const [seededRow] = await fixture.db.select().from(credentials).where(eq(credentials.id, id));
    const logger = createLogger();
    const writeSpy = vi.spyOn(process.stdout, 'write').mockReturnValue(true);

    try {
      await secretsRotateCommand({
        db: fixture.db,
        env: envWith({ previous: OLD_KEY, current: NEW_KEY }),
        logger,
      });

      const captured = [
        ...writeSpy.mock.calls.map((call) => String(call[0])),
        ...logger.error.mock.calls.map((call) => String(call[0])),
        ...logger.info.mock.calls.map((call) => String(call[0])),
      ].join('\n');

      expect(captured).not.toContain(OLD_KEY.toString('base64'));
      expect(captured).not.toContain(NEW_KEY.toString('base64'));
      expect(captured).not.toContain('super-secret-plaintext-value');
      expect(captured).not.toContain(seededRow!.encryptedValue);
    } finally {
      writeSpy.mockRestore();
    }
  });

  it('prints a line telling the operator NOODARA_MASTER_KEY_PREVIOUS can be removed on success', async () => {
    fixture = await startPostgres();
    await seedRow(fixture.db, 'plaintext-one', OLD_KEY, 1);
    const logger = createLogger();
    const writeSpy = vi.spyOn(process.stdout, 'write').mockReturnValue(true);

    try {
      await secretsRotateCommand({
        db: fixture.db,
        env: envWith({ previous: OLD_KEY, current: NEW_KEY }),
        logger,
      });

      const printed = writeSpy.mock.calls.map((call) => String(call[0])).join('\n');
      expect(printed).toMatch(/NOODARA_MASTER_KEY_PREVIOUS/);
      expect(printed).toMatch(/removed/i);
    } finally {
      writeSpy.mockRestore();
    }
  });
});
