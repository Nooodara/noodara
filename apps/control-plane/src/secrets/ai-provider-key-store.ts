// 28-02: the BYOK AI provider key at rest. A key enters only as a `SecretValue` of kind
// `ai_provider_key`, is encrypted into `credentials` (type ai_provider_key, same AES-256-GCM
// envelope and key-version space as every other secret) and leaves only as a `SecretValue`.
// - Input checks are fixed-message and never quote the key (H1).
// - The hint is a fixed mask plus at most the last 4 characters (H1, H2): never a prefix.
// - `assertAiProviderKeyCredential` is the service-layer guard behind H2: the 0019 trigger deletes
//   whatever credential a settings row points at, so a row may only ever point at this type.
import { AI_PROVIDER_KEY_MAX_LENGTH, AI_PROVIDER_KEY_MIN_LENGTH } from '@noodara/domain/api-contract';
import { encryptSecret, revealSecret, secretValue, type SecretValue } from '@noodara/domain/security';
import { eq } from 'drizzle-orm';
import { credentials } from '../db/schema/credentials.js';
import { decryptCredentialEnvelope } from '../services/credential-store.js';
import type { MasterKeys } from '../services/server-service-deps.js';
import { currentSecretKeyVersion, type SecretStoreHandle } from './secret-store.js';

export const AI_KEY_HINT_MASK = '••••••••';
export const AI_KEY_HINT_VISIBLE = 4;
/** Printable ASCII without space: no whitespace, no control characters, no non-ASCII. */
const AI_KEY_CHARSET = /^[\x21-\x7e]+$/;

export type AiProviderKeyInvalidReason = 'too_short' | 'too_long' | 'invalid_characters';

export type AiProviderKeyInput =
  | { readonly ok: true; readonly key: SecretValue }
  | { readonly ok: false; readonly reason: AiProviderKeyInvalidReason };

/** Server-side key checks (H1). The raw string is wrapped at once and never echoed. */
export function parseAiProviderKey(raw: string): AiProviderKeyInput {
  if (raw.length > AI_PROVIDER_KEY_MAX_LENGTH) return { ok: false, reason: 'too_long' };
  if (raw.length < AI_PROVIDER_KEY_MIN_LENGTH) return { ok: false, reason: 'too_short' };
  if (!AI_KEY_CHARSET.test(raw)) return { ok: false, reason: 'invalid_characters' };
  return { ok: true, key: secretValue(raw, 'ai_provider_key') };
}

/** The redacted hint: the fixed mask and the last 4 characters, never a prefix (H1, H2). */
export function aiKeyHint(raw: string): string {
  const visible = raw.length >= AI_PROVIDER_KEY_MIN_LENGTH ? raw.slice(-AI_KEY_HINT_VISIBLE) : '';
  return `${AI_KEY_HINT_MASK}${visible}`;
}

function revealProviderKey(value: SecretValue): string {
  if (value.kind !== 'ai_provider_key') throw new Error('expected an ai_provider_key secret');
  return revealSecret(value);
}

export interface StoredAiProviderKey {
  readonly credentialId: string;
  readonly keyHint: string;
}

/** Encrypts and inserts the key as a `credentials` row of type ai_provider_key. */
export async function insertAiProviderKey(
  handle: SecretStoreHandle,
  value: SecretValue,
  masterKeys: MasterKeys,
  now: Date,
): Promise<StoredAiProviderKey> {
  const raw = revealProviderKey(value);
  const keyVersion = await currentSecretKeyVersion(handle);
  const [row] = await handle
    .insert(credentials)
    .values({
      type: 'ai_provider_key',
      encryptedValue: encryptSecret(raw, { key: masterKeys.current, version: keyVersion }),
      keyVersion,
      publicKey: null,
      createdAt: now,
      updatedAt: now,
    })
    .returning({ id: credentials.id });
  if (row === undefined) throw new Error('ai provider key insert returned no row');
  return { credentialId: row.id, keyHint: aiKeyHint(raw) };
}

/** Raised when a settings row would point at (or already points at) a non-AI credential (H2). */
export class AiProviderCredentialTypeError extends Error {
  constructor() {
    super('AI provider settings may only reference an ai_provider_key credential');
    this.name = 'AiProviderCredentialTypeError';
  }
}

/** H2: settings may reference only an ai_provider_key credential. Locks the row FOR UPDATE. */
export async function assertAiProviderKeyCredential(handle: SecretStoreHandle, credentialId: string): Promise<void> {
  const [row] = await handle
    .select({ type: credentials.type })
    .from(credentials)
    .where(eq(credentials.id, credentialId))
    .for('update');
  if (row?.type !== 'ai_provider_key') throw new AiProviderCredentialTypeError();
}

/** Decrypts the stored key (current master key, then previous) into a `SecretValue`. */
export async function readAiProviderKey(
  handle: SecretStoreHandle,
  credentialId: string,
  masterKeys: MasterKeys,
): Promise<SecretValue> {
  const [row] = await handle
    .select({ type: credentials.type, encryptedValue: credentials.encryptedValue, keyVersion: credentials.keyVersion })
    .from(credentials)
    .where(eq(credentials.id, credentialId));
  if (row?.type !== 'ai_provider_key') throw new AiProviderCredentialTypeError();
  return secretValue(decryptCredentialEnvelope(row, masterKeys), 'ai_provider_key');
}
