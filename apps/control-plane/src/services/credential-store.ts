// D-15/SEC-02: the single boundary between a `credentials` row's AES-256-GCM envelope and
// `@noodara/ssh`'s `SshCredential`. This is the ONLY file in `apps/control-plane` that imports
// both `envelope.ts`'s primitives and the `credentials` schema.
//
// The decrypted credential leaves this module only as `SecretValue` — never as a plain `string`,
// never logged, never returned in any other shape. Registration/release with a `Redactor` across
// the lifetime of a live SSH session is owned by `@noodara/ssh`'s own session lifecycle (RESEARCH
// Pitfall 3, T-3-22); this module deliberately calls `redactor.register`/`release` nowhere itself
// — the only registration that happens here is `loadPrivateKey`'s own internal call during
// pre-persist validation (D-15), which is `@noodara/ssh`'s documented contract, not something this
// file does directly. No caller may call `revealSecret` on `decodeCredential`'s result outside of
// handing it straight to `SshPort.connect`.
import {
  encryptSecret,
  decryptSecret,
  secretValue,
  SecretTamperError,
  type EncryptedBlob,
  type EncryptionKey,
  type Redactor,
  type SecretValue,
} from '@noodara/domain/security';
import { loadPrivateKey, type PrivateKeyCredential, type SshCredential } from '@noodara/ssh';
import { sql } from 'drizzle-orm';
import { credentials } from '../db/schema/credentials.js';
import type { ActivityWriteHandle } from '../activity/write-activity-event.js';
import type { MasterKeys } from './server-service-deps.js';

export type CredentialInput =
  | { readonly kind: 'private_key'; readonly privateKey: string; readonly passphrase?: string }
  | { readonly kind: 'password'; readonly password: string };

export type CredentialType = 'ssh_private_key' | 'ssh_password';

export interface EncodedCredential {
  readonly type: CredentialType;
  readonly encryptedValue: EncryptedBlob;
  readonly keyVersion: number;
}

export type EncodeCredentialResult =
  | ({ readonly ok: true } & EncodedCredential)
  | { readonly ok: false; readonly code: 'INVALID_CREDENTIAL'; readonly message: string };

export interface CredentialRow {
  readonly type: CredentialType;
  readonly encryptedValue: string;
  readonly keyVersion: number;
}

function encodePassword(password: string, key: EncryptionKey): EncodeCredentialResult {
  if (password.length === 0) {
    return { ok: false, code: 'INVALID_CREDENTIAL', message: 'password must not be empty' };
  }
  return {
    ok: true,
    type: 'ssh_password',
    encryptedValue: encryptSecret(password, key),
    keyVersion: key.version,
  };
}

function encodePrivateKey(
  input: Extract<CredentialInput, { kind: 'private_key' }>,
  key: EncryptionKey,
  redactor: Redactor,
): EncodeCredentialResult {
  // Built only to hand to `loadPrivateKey` for D-15's pre-persist validation, reusing
  // `@noodara/ssh`'s own accepted-format/type/size rules — never re-implemented locally (T-3-10).
  const credential: PrivateKeyCredential =
    input.passphrase === undefined
      ? { kind: 'private_key', privateKey: secretValue(input.privateKey, 'ssh_private_key') }
      : {
          kind: 'private_key',
          privateKey: secretValue(input.privateKey, 'ssh_private_key'),
          passphrase: secretValue(input.passphrase, 'ssh_private_key'),
        };

  const loaded = loadPrivateKey(credential, redactor);
  if (!loaded.ok) {
    // Both `loaded.kind === 'validation'` (malformed/unsupported/too-small) and
    // `loaded.kind === 'auth'` (wrong passphrase) are registration-time rejections here — neither
    // is an `AUTH_FAILED` connection outcome, since no connection was ever attempted.
    return { ok: false, code: 'INVALID_CREDENTIAL', message: loaded.message };
  }

  // D-15: the envelope's plaintext is JSON with `passphrase` omitted entirely when absent — never
  // present as `null`/`undefined`.
  const plaintext =
    input.passphrase === undefined
      ? JSON.stringify({ privateKey: input.privateKey })
      : JSON.stringify({ privateKey: input.privateKey, passphrase: input.passphrase });

  return {
    ok: true,
    type: 'ssh_private_key',
    encryptedValue: encryptSecret(plaintext, key),
    keyVersion: key.version,
  };
}

/**
 * Validates `input` with `@noodara/ssh`'s own rules (private keys) or a basic non-empty check
 * (passwords), then produces the single AES-256-GCM envelope stored in `credentials.encryptedValue`.
 * Never persists anything itself — the caller (a plan 03-05+ service, inside its own transaction)
 * writes the returned `{ type, encryptedValue, keyVersion }` into the `credentials` table.
 */
export function encodeCredential(
  input: CredentialInput,
  key: EncryptionKey,
  redactor: Redactor,
): EncodeCredentialResult {
  return input.kind === 'password' ? encodePassword(input.password, key) : encodePrivateKey(input, key, redactor);
}

/**
 * Decrypts `row.encryptedValue` under `masterKeys.current`, falling back to `masterKeys.previous`
 * (the D-11 rotation window) if the first attempt fails GCM authentication. Returns an
 * `SshCredential` whose fields are `SecretValue` only. Any other decryption failure (an
 * `UnknownKeyVersionError`, or a `SecretTamperError` with no `previous` to retry) propagates
 * uncaught — a corrupt or unrecoverable row is an infra failure, not an expected result.
 */
export function decodeCredential(row: CredentialRow, masterKeys: MasterKeys): SshCredential {
  const blob = row.encryptedValue as EncryptedBlob;
  let plaintext: string;
  try {
    plaintext = decryptSecret(blob, new Map([[row.keyVersion, masterKeys.current]]));
  } catch (error) {
    if (error instanceof SecretTamperError && masterKeys.previous !== undefined) {
      plaintext = decryptSecret(blob, new Map([[row.keyVersion, masterKeys.previous]]));
    } else {
      throw error;
    }
  }

  if (row.type === 'ssh_password') {
    return { kind: 'password', password: secretValue(plaintext, 'ssh_password') };
  }

  const parsed = JSON.parse(plaintext) as { privateKey: string; passphrase?: string };
  return parsed.passphrase === undefined
    ? { kind: 'private_key', privateKey: secretValue(parsed.privateKey, 'ssh_private_key') }
    : {
        kind: 'private_key',
        privateKey: secretValue(parsed.privateKey, 'ssh_private_key'),
        // SecretKind stays closed this phase (no dedicated "key passphrase" kind) — reusing
        // 'ssh_private_key' protects the same key material; the redactor's label is cosmetic.
        passphrase: secretValue(parsed.passphrase, 'ssh_private_key'),
      };
}

/** The `key_version` a newly-encrypted credential should use — the current maximum across every
 *  `credentials` row, or `1` when the table is empty (a brand-new install). */
export async function currentKeyVersion(handle: ActivityWriteHandle): Promise<number> {
  const [row] = await handle
    .select({ maxVersion: sql<number | null>`max(${credentials.keyVersion})` })
    .from(credentials);
  return row?.maxVersion ?? 1;
}

// Re-exported so a caller never needs to reach past this module into `@noodara/domain/security`
// just to read back a decoded value.
export type { SecretValue };
