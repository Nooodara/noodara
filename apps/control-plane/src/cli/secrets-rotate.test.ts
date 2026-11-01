// D-11/SEC-01 (23-01 A2): the pure planning half of `noodara secrets rotate`. The transaction,
// row locks and both tables are covered by tests/integration/cli/secrets-rotate.test.ts.
import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { decryptSecret, encryptSecret, SecretTamperError, type EncryptedBlob } from '@noodara/domain/security';
import { pickTargetVersion, planRotation, secretsRotateCommand, type EnvelopeRow } from './secrets-rotate.js';

const OLD_KEY = randomBytes(32);
const NEW_KEY = randomBytes(32);

function row(id: string, plaintext: string, key: Buffer, version: number): EnvelopeRow {
  return { id, encryptedValue: encryptSecret(plaintext, { key, version }), keyVersion: version };
}

describe('pickTargetVersion', () => {
  it('is one past the max when rows are still under the previous key', () => {
    expect(pickTargetVersion([row('a', 'x', OLD_KEY, 1), row('b', 'y', OLD_KEY, 2)], NEW_KEY)).toBe(3);
  });

  it('is the max on a re-run after every max-version row moved to the new key', () => {
    expect(pickTargetVersion([row('a', 'x', NEW_KEY, 2), row('b', 'y', NEW_KEY, 2)], NEW_KEY)).toBe(2);
  });

  it('is one past the max when only some max-version rows are under the new key', () => {
    // A row written under the new key during the rotation window must not hide an old-key row.
    expect(pickTargetVersion([row('a', 'x', NEW_KEY, 1), row('b', 'y', OLD_KEY, 1)], NEW_KEY)).toBe(2);
  });

  it('is 1 for an empty set', () => {
    expect(pickTargetVersion([], NEW_KEY)).toBe(1);
  });
});

describe('planRotation', () => {
  it('re-encrypts previous-key rows and new-key window rows to the target, skipping rows at it', () => {
    const rows = [row('old', 'p-old', OLD_KEY, 1), row('window', 'p-window', NEW_KEY, 1), row('done', 'p-done', NEW_KEY, 2)];
    const updates = planRotation(rows, 2, OLD_KEY, NEW_KEY);
    expect(updates.map((update) => update.id)).toEqual(['old', 'window']);
    for (const update of updates) {
      expect(update.keyVersion).toBe(2);
      expect(update.encryptedValue.startsWith('v2:')).toBe(true);
      const plaintext = decryptSecret(update.encryptedValue as EncryptedBlob, new Map([[2, NEW_KEY]]));
      expect(plaintext).toBe(update.id === 'old' ? 'p-old' : 'p-window');
    }
  });

  it('throws on a row that decrypts under neither key', () => {
    const foreign = row('bad', 'p', randomBytes(32), 1);
    expect(() => planRotation([foreign], 2, OLD_KEY, NEW_KEY)).toThrow(SecretTamperError);
  });
});

describe('secretsRotateCommand preconditions', () => {
  const env = (current: Buffer, previous?: Buffer) => ({
    NOODARA_MASTER_KEY: current.toString('base64'),
    ...(previous === undefined ? {} : { NOODARA_MASTER_KEY_PREVIOUS: previous.toString('base64') }),
  });
  const noDb = {
    transaction: () => {
      throw new Error('must not open a transaction');
    },
  } as unknown as Parameters<typeof secretsRotateCommand>[0]['db'];

  it('refuses without a previous key and without touching the database', async () => {
    const errors: string[] = [];
    const code = await secretsRotateCommand({ db: noDb, env: env(NEW_KEY), logger: { error: (m) => errors.push(m), info: () => undefined } });
    expect(code).toBe(1);
    expect(errors[0]).toMatch(/NOODARA_MASTER_KEY_PREVIOUS/);
  });

  it('refuses identical keys', async () => {
    const code = await secretsRotateCommand({ db: noDb, env: env(NEW_KEY, NEW_KEY), logger: { error: () => undefined, info: () => undefined } });
    expect(code).toBe(1);
  });
});
