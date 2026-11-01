// SEC-04 (23-01): the single boundary between a `secrets` row's AES-256-GCM envelope and the rest
// of the control plane. This is the ONLY file in `apps/control-plane` that imports both the
// envelope primitives and the `secrets` schema (boundary.test.ts). A value enters and leaves this
// module only as `SecretValue` of kind `app_secret`; every stored or returned record is
// value-free (hint only). Decrypted values are registered in the caller's Redactor for one deploy
// attempt and released by the caller through the returned lease.
import {
  decryptSecret,
  encryptSecret,
  MalformedBlobError,
  revealSecret,
  secretValue,
  SecretTamperError,
  UnknownKeyVersionError,
  type EncryptedBlob,
  type EncryptionKey,
  type Redactor,
  type SecretValue,
} from '@noodara/domain/security';
import type { EnvScope } from '@noodara/domain';
import { and, eq, inArray, or, sql } from 'drizzle-orm';
import type { NodePgQueryResultHKT } from 'drizzle-orm/node-postgres';
import type { PgDatabase } from 'drizzle-orm/pg-core';
import { credentials } from '../db/schema/credentials.js';
import type * as schema from '../db/schema/index.js';
import { secrets } from '../db/schema/secrets.js';
import type { MasterKeys } from '../services/server-service-deps.js';

/** A Drizzle handle or transaction bound to the full schema (kept local: ACT-01 forbids importing
 *  the activity writer's handle type outside src/services/ and src/activity/). */
export type SecretStoreHandle = PgDatabase<NodePgQueryResultHKT, typeof schema>;

/** The hint shows the last 4 characters only for values at least this long (shorter ones: ''). */
export const HINT_MIN_VALUE_LENGTH = 16;
const HINT_LENGTH = 4;

/**
 * H2: values shorter than this are not registered in the Redactor. The Redactor replaces every
 * substring occurrence, so a 3-character value would corrupt unrelated log text and turn each
 * redaction marker into an oracle for the value. Rule recorded in the noodara-security skill §3.
 */
export const MIN_REDACTABLE_SECRET_LENGTH = 8;

export type SecretStoreErrorCode =
  | 'SECRET_TAMPERED'
  | 'SECRET_KEY_UNKNOWN'
  | 'SECRET_MALFORMED'
  | 'SECRET_NOT_FOUND'
  | 'SECRET_NOT_IN_SCOPE'
  | 'SECRET_VALUE_INVALID';

const ERROR_MESSAGES: Readonly<Record<SecretStoreErrorCode, string>> = Object.freeze({
  SECRET_TAMPERED: 'Stored secret failed authentication',
  SECRET_KEY_UNKNOWN: 'Stored secret was encrypted with an unknown key version',
  SECRET_MALFORMED: 'Stored secret is malformed',
  SECRET_NOT_FOUND: 'Secret not found',
  SECRET_NOT_IN_SCOPE: "Secret is outside the deploying service's scope chain",
  SECRET_VALUE_INVALID: 'Secret value must be a non-empty app_secret',
});

/** A store failure as a closed code with a fixed message: never the value, the ciphertext, the
 *  key or the envelope error as `cause`; serializes to its closed fields only. */
export class SecretStoreError extends Error {
  readonly code: SecretStoreErrorCode;
  readonly secretId: string | undefined;

  constructor(code: SecretStoreErrorCode, secretId?: string) {
    super(ERROR_MESSAGES[code]);
    this.name = 'SecretStoreError';
    this.code = code;
    this.secretId = secretId;
  }

  toJSON(): { name: string; code: SecretStoreErrorCode; message: string; secretId?: string } {
    return {
      name: this.name,
      code: this.code,
      message: this.message,
      ...(this.secretId === undefined ? {} : { secretId: this.secretId }),
    };
  }
}

/** The owner of a secret row; ids not used by the scope are absent. */
export type SecretOwner =
  | { readonly scope: 'project'; readonly projectId: string }
  | { readonly scope: 'environment'; readonly projectId: string; readonly environmentId: string }
  | { readonly scope: 'service'; readonly projectId: string; readonly serviceId: string };

/** H1: the deploying service's owner chain; only secrets owned by one of these three resolve. */
export interface ScopeChain {
  readonly projectId: string;
  readonly environmentId: string;
  readonly serviceId: string;
}

/** Value-free view of a stored secret. */
export interface SecretRecord {
  readonly id: string;
  readonly scope: EnvScope;
  readonly projectId: string;
  readonly environmentId: string | null;
  readonly serviceId: string | null;
  readonly name: string;
  readonly version: number;
  readonly hint: string;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

export interface EncodedSecret {
  readonly encryptedValue: EncryptedBlob;
  readonly keyVersion: number;
  readonly hint: string;
}

interface EnvelopeRow {
  readonly id: string;
  readonly encryptedValue: string;
  readonly keyVersion: number;
}

interface OwnedRow {
  readonly scope: EnvScope;
  readonly projectId: string;
  readonly environmentId: string | null;
  readonly serviceId: string | null;
}

/** Last 4 characters only when the value has at least 16; otherwise an empty hint. */
export function secretHint(raw: string): string {
  return raw.length >= HINT_MIN_VALUE_LENGTH ? raw.slice(-HINT_LENGTH) : '';
}

function revealAppSecret(value: SecretValue): string {
  // A kind check, not `instanceof`: a second module instance of the domain package would fail it.
  if (value.kind !== 'app_secret') {
    throw new SecretStoreError('SECRET_VALUE_INVALID');
  }
  const raw = revealSecret(value);
  if (raw.length === 0) throw new SecretStoreError('SECRET_VALUE_INVALID');
  return raw;
}

/** Encrypts an `app_secret` value under `key`. Pure; persists nothing. */
export function encodeSecret(value: SecretValue, key: EncryptionKey): EncodedSecret {
  const raw = revealAppSecret(value);
  return { encryptedValue: encryptSecret(raw, key), keyVersion: key.version, hint: secretHint(raw) };
}

function decryptCodeOf(error: unknown): SecretStoreErrorCode | null {
  if (error instanceof SecretTamperError) return 'SECRET_TAMPERED';
  if (error instanceof UnknownKeyVersionError) return 'SECRET_KEY_UNKNOWN';
  if (error instanceof MalformedBlobError) return 'SECRET_MALFORMED';
  return null;
}

/**
 * Decrypts a row under `masterKeys.current`, falling back to `previous` on an authentication
 * failure (the rotation window), exactly like credential-store. Every envelope failure becomes a
 * `SecretStoreError` carrying only its code and the row id.
 */
export function openSecretEnvelope(row: EnvelopeRow, masterKeys: MasterKeys): SecretValue {
  const blob = row.encryptedValue as EncryptedBlob;
  const attempt = (key: Buffer): SecretValue =>
    secretValue(decryptSecret(blob, new Map([[row.keyVersion, key]])), 'app_secret');
  let code: SecretStoreErrorCode | null;
  try {
    return attempt(masterKeys.current);
  } catch (error) {
    code = decryptCodeOf(error);
    if (code === null) throw error;
  }
  if (code === 'SECRET_TAMPERED' && masterKeys.previous !== undefined) {
    try {
      return attempt(masterKeys.previous);
    } catch (error) {
      code = decryptCodeOf(error);
      if (code === null) throw error;
    }
  }
  throw new SecretStoreError(code, row.id);
}

/** H1: whether a row is owned by one of the chain's project, environment or service. */
export function isInScopeChain(row: OwnedRow, chain: ScopeChain): boolean {
  if (row.projectId !== chain.projectId) return false;
  switch (row.scope) {
    case 'project':
      return true;
    case 'environment':
      return row.environmentId === chain.environmentId;
    case 'service':
      return row.serviceId === chain.serviceId;
  }
}

/** A deploy attempt's decrypted secrets, keyed by secret id. `release` is idempotent. */
export interface SecretLease {
  readonly values: ReadonlyMap<string, SecretValue>;
  release(): void;
}

/**
 * Registers each value of at least MIN_REDACTABLE_SECRET_LENGTH characters in `redactor` under
 * `app_secret` and returns a lease whose `release` drops exactly those registrations once.
 */
export function leaseSecrets(values: ReadonlyMap<string, SecretValue>, redactor: Redactor): SecretLease {
  const registered: string[] = [];
  for (const value of values.values()) {
    const raw = revealSecret(value);
    if (raw.length < MIN_REDACTABLE_SECRET_LENGTH) continue;
    redactor.register(raw, 'app_secret');
    registered.push(raw);
  }
  let released = false;
  return {
    values,
    release: () => {
      if (released) return;
      released = true;
      for (const raw of registered) redactor.release(raw);
    },
  };
}

function toRecord(row: typeof secrets.$inferSelect): SecretRecord {
  return {
    id: row.id,
    scope: row.scope,
    projectId: row.projectId,
    environmentId: row.environmentId,
    serviceId: row.serviceId,
    name: row.name,
    version: row.version,
    hint: row.hint,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

/**
 * The `key_version` a newly encrypted secret uses: the current maximum across `secrets` and
 * `credentials` (one master-key version space, rotated together), or 1 on an empty install.
 */
export async function currentSecretKeyVersion(handle: SecretStoreHandle): Promise<number> {
  const result = await handle.execute<{ v: number | string | null }>(
    sql`SELECT GREATEST((SELECT max(${secrets.keyVersion}) FROM ${secrets}), (SELECT max(${credentials.keyVersion}) FROM ${credentials})) AS v`,
  );
  const value = result.rows[0]?.v;
  return value === null || value === undefined ? 1 : Number(value);
}

export interface CreateSecretInput {
  readonly owner: SecretOwner;
  readonly name: string;
  readonly value: SecretValue;
}

/** Inserts a secret at version 1. A unique violation (same name per owner) propagates. */
export async function createSecret(
  handle: SecretStoreHandle,
  input: CreateSecretInput,
  masterKeys: MasterKeys,
): Promise<SecretRecord> {
  const keyVersion = await currentSecretKeyVersion(handle);
  const encoded = encodeSecret(input.value, { key: masterKeys.current, version: keyVersion });
  const { owner } = input;
  const [row] = await handle
    .insert(secrets)
    .values({
      scope: owner.scope,
      projectId: owner.projectId,
      environmentId: owner.scope === 'environment' ? owner.environmentId : null,
      serviceId: owner.scope === 'service' ? owner.serviceId : null,
      name: input.name,
      encryptedValue: encoded.encryptedValue,
      keyVersion: encoded.keyVersion,
      hint: encoded.hint,
    })
    .returning();
  if (row === undefined) throw new Error('secret insert returned no row');
  return toRecord(row);
}

/**
 * H3: replaces the value and bumps `version` in a single `UPDATE ... SET version = version + 1`
 * (never read-modify-write). The row is locked first so a concurrent `secrets rotate` (which locks
 * every row) and this write serialize, and the key version is read after the lock.
 */
export async function replaceSecret(
  handle: SecretStoreHandle,
  id: string,
  value: SecretValue,
  masterKeys: MasterKeys,
): Promise<SecretRecord> {
  revealAppSecret(value);
  return handle.transaction(async (tx) => {
    const locked = await tx.select({ id: secrets.id }).from(secrets).where(eq(secrets.id, id)).for('update');
    if (locked.length === 0) throw new SecretStoreError('SECRET_NOT_FOUND', id);
    const keyVersion = await currentSecretKeyVersion(tx);
    const encoded = encodeSecret(value, { key: masterKeys.current, version: keyVersion });
    const [row] = await tx
      .update(secrets)
      .set({
        encryptedValue: encoded.encryptedValue,
        keyVersion: encoded.keyVersion,
        hint: encoded.hint,
        version: sql`${secrets.version} + 1`,
        updatedAt: sql`now()`,
      })
      .where(eq(secrets.id, id))
      .returning();
    if (row === undefined) throw new SecretStoreError('SECRET_NOT_FOUND', id);
    return toRecord(row);
  });
}

export interface DecryptForDeployInput {
  readonly chain: ScopeChain;
  readonly secretIds: readonly string[];
}

/**
 * Decrypts the given secrets for one deploy attempt and registers them in `redactor`. Every id
 * must belong to `chain` (H1): an id outside it, or unknown, fails the whole call with
 * SECRET_NOT_IN_SCOPE before anything is decrypted or registered. The caller must call
 * `release()` on the lease after the attempt, on every exit path.
 */
export async function decryptForDeploy(
  handle: SecretStoreHandle,
  input: DecryptForDeployInput,
  masterKeys: MasterKeys,
  redactor: Redactor,
): Promise<SecretLease> {
  const ids = [...new Set(input.secretIds)];
  if (ids.length === 0) return leaseSecrets(new Map(), redactor);
  const { chain } = input;
  const rows = await handle
    .select()
    .from(secrets)
    .where(
      and(
        inArray(secrets.id, ids),
        eq(secrets.projectId, chain.projectId),
        or(
          eq(secrets.scope, 'project'),
          and(eq(secrets.scope, 'environment'), eq(secrets.environmentId, chain.environmentId)),
          and(eq(secrets.scope, 'service'), eq(secrets.serviceId, chain.serviceId)),
        ),
      ),
    );
  const byId = new Map(rows.filter((row) => isInScopeChain(row, chain)).map((row) => [row.id, row]));
  for (const id of ids) {
    if (!byId.has(id)) throw new SecretStoreError('SECRET_NOT_IN_SCOPE', id);
  }
  const values = new Map<string, SecretValue>();
  for (const id of ids) {
    const row = byId.get(id);
    if (row !== undefined) values.set(id, openSecretEnvelope(row, masterKeys));
  }
  return leaseSecrets(values, redactor);
}

/** The envelope columns of every `secrets` row, locked FOR UPDATE inside `tx` (secrets rotate). */
export async function lockSecretEnvelopes(tx: SecretStoreHandle): Promise<EnvelopeRow[]> {
  return tx
    .select({ id: secrets.id, encryptedValue: secrets.encryptedValue, keyVersion: secrets.keyVersion })
    .from(secrets)
    .for('update');
}

/** Writes one rotated envelope (ciphertext and key version together) inside `tx`. */
export async function writeSecretEnvelope(
  tx: SecretStoreHandle,
  id: string,
  encryptedValue: string,
  keyVersion: number,
): Promise<void> {
  await tx.update(secrets).set({ encryptedValue, keyVersion }).where(eq(secrets.id, id));
}
