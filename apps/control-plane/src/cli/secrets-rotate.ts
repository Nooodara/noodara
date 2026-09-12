// D-11/SEC-01: `noodara secrets rotate` — re-encrypts every `credentials` row from the previous
// master key to the new one, inside one transaction, incrementing `key_version`. A failure
// anywhere aborts the whole run: every row still decrypts under the previous key (T-1-47).
import { eq, type SQL } from 'drizzle-orm';
import {
  decryptSecret,
  reencryptSecret,
  type EncryptedBlob,
} from '@noodara/domain/security';
import { decodeMasterKey, masterKeyFingerprint } from '../boot/master-key.js';
import { credentials } from '../db/schema/credentials.js';
import type { Env } from '../env.js';

export interface SecretsRotateLogger {
  error(msg: string): void;
  info(msg: string): void;
}

export interface SecretsRotateDb {
  transaction<T>(cb: (tx: SecretsRotateTx) => Promise<T>): Promise<T>;
}

/** Narrow structural shape of the parts of the Drizzle handle this command needs inside its own
 *  transaction — kept independently mockable in unit-style tests. */
export interface SecretsRotateTx {
  select(): { from: (table: typeof credentials) => Promise<CredentialRow[]> };
  update(table: typeof credentials): {
    set: (values: { encryptedValue: string; keyVersion: number }) => {
      where: (predicate: SQL | undefined) => Promise<unknown>;
    };
  };
}

export type CredentialRow = typeof credentials.$inferSelect;

export interface SecretsRotateDeps {
  readonly db: SecretsRotateDb;
  readonly env: Pick<Env, 'NOODARA_MASTER_KEY' | 'NOODARA_MASTER_KEY_PREVIOUS'>;
  readonly logger: SecretsRotateLogger;
}

/**
 * Picks the version number every rotated row should end up at. If any row already decrypts under
 * `newKey` at the table's current max `key_version`, that version *is* the target — this run is a
 * safe re-run after a prior successful rotation with the same key pair, and nothing needs to
 * change. Otherwise the target is one past the current max, a version never used before.
 */
function pickTargetVersion(rows: CredentialRow[], newKey: Buffer): number {
  const maxVersion = rows.reduce((max, row) => Math.max(max, row.keyVersion), 0);
  const probe = rows.find((row) => row.keyVersion === maxVersion);
  if (probe) {
    try {
      decryptSecret(probe.encryptedValue as EncryptedBlob, new Map([[maxVersion, newKey]]));
      return maxVersion;
    } catch {
      // Not yet under the new key — fall through to a fresh version.
    }
  }
  return maxVersion + 1;
}

/**
 * Re-encrypts every `credentials` row not already at `target` from its own stored `key_version`
 * (assumed to be under `previousKey`) to `target` (under `newKey`), inside `tx`. Returns the
 * number of rows actually changed. Any thrown error (a corrupt row that decrypts under neither
 * key) propagates out of `tx` uncaught, so the caller's transaction rolls back automatically —
 * this function never catches and continues past a row it cannot verify.
 */
async function rotateRows(
  tx: SecretsRotateTx,
  rows: CredentialRow[],
  target: number,
  previousKey: Buffer,
  newKey: Buffer,
): Promise<number> {
  let rotated = 0;
  for (const row of rows) {
    if (row.keyVersion === target) {
      continue;
    }
    const keyMap = new Map([[row.keyVersion, previousKey]]);
    const newBlob = reencryptSecret(row.encryptedValue as EncryptedBlob, keyMap, {
      key: newKey,
      version: target,
    });
    await tx
      .update(credentials)
      .set({ encryptedValue: newBlob, keyVersion: target })
      .where(eq(credentials.id, row.id));
    rotated += 1;
  }
  return rotated;
}

/**
 * Returns the process's intended exit code (0 success, 1 failure) rather than calling
 * `process.exit` itself — `cli/index.ts` is the single place that decides the real exit code.
 */
export async function secretsRotateCommand(deps: SecretsRotateDeps): Promise<number> {
  const { env, db, logger } = deps;

  if (env.NOODARA_MASTER_KEY_PREVIOUS === undefined) {
    logger.error(
      'NOODARA_MASTER_KEY_PREVIOUS is not set — set it to the key currently in use before rotating to a new NOODARA_MASTER_KEY.',
    );
    return 1;
  }

  const newKey = decodeMasterKey(env.NOODARA_MASTER_KEY);
  const previousKey = decodeMasterKey(env.NOODARA_MASTER_KEY_PREVIOUS);

  if (newKey.equals(previousKey)) {
    logger.error('NOODARA_MASTER_KEY and NOODARA_MASTER_KEY_PREVIOUS are identical — nothing to rotate.');
    return 1;
  }

  try {
    const rotated = await db.transaction(async (tx) => {
      const rows = await tx.select().from(credentials);
      if (rows.length === 0) {
        return 0;
      }
      const target = pickTargetVersion(rows, newKey);
      return rotateRows(tx, rows, target, previousKey, newKey);
    });

    logger.info(
      `Rotated ${rotated.toString()} credential row(s) (old key ${masterKeyFingerprint(previousKey)} -> new key ${masterKeyFingerprint(newKey)}).`,
    );
    process.stdout.write(
      `Rotated ${rotated.toString()} row(s). NOODARA_MASTER_KEY_PREVIOUS can now be removed from .env.\n`,
    );
    return 0;
  } catch {
    // Never echo the underlying error: it could be a SecretTamperError/MalformedBlobError whose
    // message construction is already safe, but a driver-level error is not guaranteed to be —
    // and neither key, plaintext nor ciphertext may appear in this command's output at any
    // verbosity (T-1-48).
    logger.error('Rotation aborted: a row could not be verified under either key. No rows were changed.');
    return 1;
  }
}
