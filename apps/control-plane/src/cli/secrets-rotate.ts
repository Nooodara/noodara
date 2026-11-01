// D-11/SEC-01: `noodara secrets rotate` — re-encrypts every `credentials` and `secrets` row from
// the previous master key to the new one, inside one transaction, moving both tables to one shared
// `key_version`. Every row is locked FOR UPDATE first, so a concurrent secret replace and the
// rotation serialize and no row ends with a ciphertext/key_version pair from two writers (23-01
// H3). A failure anywhere aborts the whole run: every row still decrypts as before (T-1-47).
import { eq } from 'drizzle-orm';
import {
  decryptSecret,
  reencryptSecret,
  SecretTamperError,
  type EncryptedBlob,
} from '@noodara/domain/security';
import type { ActivityWriteHandle } from '../activity/write-activity-event.js';
import { decodeMasterKey, masterKeyFingerprint } from '../boot/master-key.js';
import { credentials } from '../db/schema/credentials.js';
import type { Env } from '../env.js';
import { lockSecretEnvelopes, writeSecretEnvelope } from '../secrets/secret-store.js';

export interface SecretsRotateLogger {
  error(msg: string): void;
  info(msg: string): void;
}

export interface SecretsRotateDeps {
  readonly db: ActivityWriteHandle;
  readonly env: Pick<Env, 'NOODARA_MASTER_KEY' | 'NOODARA_MASTER_KEY_PREVIOUS'>;
  readonly logger: SecretsRotateLogger;
}

/** The envelope columns of one row of either table. */
export interface EnvelopeRow {
  readonly id: string;
  readonly encryptedValue: string;
  readonly keyVersion: number;
}

export interface RotationUpdate {
  readonly id: string;
  readonly encryptedValue: string;
  readonly keyVersion: number;
}

function decryptsUnder(row: EnvelopeRow, key: Buffer): boolean {
  try {
    decryptSecret(row.encryptedValue as EncryptedBlob, new Map([[row.keyVersion, key]]));
    return true;
  } catch {
    return false;
  }
}

/**
 * The version every rotated row ends up at. When every row at the current max `key_version`
 * already decrypts under `newKey`, that version is the target (a safe re-run after a successful
 * rotation with the same key pair). Otherwise it is one past the max, a version never used.
 */
export function pickTargetVersion(rows: readonly EnvelopeRow[], newKey: Buffer): number {
  const maxVersion = rows.reduce((max, row) => Math.max(max, row.keyVersion), 0);
  const atMax = rows.filter((row) => row.keyVersion === maxVersion);
  return atMax.length > 0 && atMax.every((row) => decryptsUnder(row, newKey)) ? maxVersion : maxVersion + 1;
}

/**
 * Pure: the writes that move `rows` to `target` under `newKey`. A row already at `target` is left
 * alone. Any other row is re-encrypted from `previousKey`, or from `newKey` when it was written
 * under the new key during the rotation window. A row that decrypts under neither key throws
 * (SecretTamperError or an envelope error), so the caller's transaction rolls back.
 */
export function planRotation(
  rows: readonly EnvelopeRow[],
  target: number,
  previousKey: Buffer,
  newKey: Buffer,
): RotationUpdate[] {
  const updates: RotationUpdate[] = [];
  for (const row of rows) {
    if (row.keyVersion === target) continue;
    const blob = row.encryptedValue as EncryptedBlob;
    const to = { key: newKey, version: target };
    let encryptedValue: string;
    try {
      encryptedValue = reencryptSecret(blob, new Map([[row.keyVersion, previousKey]]), to);
    } catch (error) {
      if (!(error instanceof SecretTamperError)) throw error;
      encryptedValue = reencryptSecret(blob, new Map([[row.keyVersion, newKey]]), to);
    }
    updates.push({ id: row.id, encryptedValue, keyVersion: target });
  }
  return updates;
}

async function rotateAll(tx: ActivityWriteHandle, previousKey: Buffer, newKey: Buffer): Promise<number> {
  const credentialRows = await tx
    .select({
      id: credentials.id,
      encryptedValue: credentials.encryptedValue,
      keyVersion: credentials.keyVersion,
    })
    .from(credentials)
    .for('update');
  const secretRows = await lockSecretEnvelopes(tx);
  const all = [...credentialRows, ...secretRows];
  if (all.length === 0) return 0;

  const target = pickTargetVersion(all, newKey);
  const credentialUpdates = planRotation(credentialRows, target, previousKey, newKey);
  const secretUpdates = planRotation(secretRows, target, previousKey, newKey);
  for (const update of credentialUpdates) {
    await tx
      .update(credentials)
      .set({ encryptedValue: update.encryptedValue, keyVersion: update.keyVersion })
      .where(eq(credentials.id, update.id));
  }
  for (const update of secretUpdates) {
    await writeSecretEnvelope(tx, update.id, update.encryptedValue, update.keyVersion);
  }
  return credentialUpdates.length + secretUpdates.length;
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
    const rotated = await db.transaction(async (tx) => rotateAll(tx, previousKey, newKey));

    logger.info(
      `Rotated ${rotated.toString()} credential and secret row(s) (old key ${masterKeyFingerprint(previousKey)} -> new key ${masterKeyFingerprint(newKey)}).`,
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
