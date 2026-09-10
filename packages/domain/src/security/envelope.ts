// AES-256-GCM envelope with per-row key version (SEC-01, D-09, D-10, D-11). node:crypto is pure
// computation (no file/network/process I/O) and is explicitly allowed in packages/domain per
// RESEARCH Pitfall 4 — see purity.test.ts. This module never reads NOODARA_MASTER_KEY itself;
// that stays in apps/control-plane/src/env.ts and boot/master-key.ts, keeping the domain pure.

import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

const ALGORITHM = 'aes-256-gcm';
const KEY_LENGTH = 32;
const NONCE_LENGTH = 12;
const TAG_LENGTH = 16;

// D-10's exact stored format: v<version>:<nonce_b64>:<ciphertext_b64>:<tag_b64>.
const VERSION_SEGMENT_PATTERN = /^v(\d+)$/;
const BASE64_SEGMENT_PATTERN = /^[A-Za-z0-9+/]*={0,2}$/;

/** A string that has passed `parseBlob`'s shape validation — never construct this by hand. */
export type EncryptedBlob = string & { readonly __brand: 'EncryptedBlob' };

export interface EncryptionKey {
  readonly key: Buffer;
  readonly version: number;
}

/**
 * Raised when GCM authentication fails on decrypt: a tampered ciphertext, a tampered auth tag,
 * or the wrong key. All three produce an identical authentication failure at the crypto layer,
 * so they are indistinguishable by design (T-1-10) — the message never carries the plaintext,
 * ciphertext or key material (T-1-11).
 */
export class SecretTamperError extends Error {
  constructor() {
    super('Ciphertext or authentication tag failed verification');
    this.name = 'SecretTamperError';
  }
}

/** Raised when a blob's `key_version` has no matching entry in the caller's key map. */
export class UnknownKeyVersionError extends Error {
  readonly version: number;

  constructor(version: number) {
    super(`Unknown key version: ${version.toString()}`);
    this.name = 'UnknownKeyVersionError';
    this.version = version;
  }
}

/** Raised when a key is not exactly 32 bytes (AES-256 requires a 256-bit key). */
export class InvalidKeyLengthError extends Error {
  constructor(actualLength: number) {
    super(`Key must be exactly ${KEY_LENGTH.toString()} bytes, got ${actualLength.toString()}`);
    this.name = 'InvalidKeyLengthError';
  }
}

/**
 * Raised when a blob does not match D-10's `v<version>:<nonce>:<ciphertext>:<tag>` shape (wrong
 * segment count, non-numeric version, non-base64 segment, or a segment that decodes to the wrong
 * byte length). The message never echoes the offending blob or any of its segments (T-1-11).
 */
export class MalformedBlobError extends Error {
  constructor(reason: string) {
    super(`Malformed encrypted blob: ${reason}`);
    this.name = 'MalformedBlobError';
  }
}

function assertKeyLength(key: Buffer): void {
  if (key.length !== KEY_LENGTH) {
    throw new InvalidKeyLengthError(key.length);
  }
}

/**
 * Encrypts `plaintext` with AES-256-GCM under `key`, using a fresh random 12-byte nonce for this
 * call (SEC-01: unique nonce per operation). Returns the D-10 stored format.
 */
export function encryptSecret(plaintext: string, { key, version }: EncryptionKey): EncryptedBlob {
  assertKeyLength(key);
  const nonce = randomBytes(NONCE_LENGTH);
  const cipher = createCipheriv(ALGORITHM, key, nonce);
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `v${version.toString()}:${nonce.toString('base64')}:${ciphertext.toString('base64')}:${tag.toString('base64')}` as EncryptedBlob;
}

interface ParsedBlob {
  readonly version: number;
  readonly nonce: Buffer;
  readonly ciphertext: Buffer;
  readonly tag: Buffer;
}

/** Narrows `T | undefined` to `T` once the caller has already guaranteed the value is present. */
function assertDefined<T>(value: T | undefined): T {
  return value as T;
}

function parseBlob(blob: string): ParsedBlob {
  const segments = blob.split(':');
  if (segments.length !== 4) {
    throw new MalformedBlobError(`expected 4 segments, got ${segments.length.toString()}`);
  }

  // `segments.length === 4` was just confirmed above, so all four indices are present.
  const versionSegment = assertDefined(segments[0]);
  const nonceSegment = assertDefined(segments[1]);
  const ciphertextSegment = assertDefined(segments[2]);
  const tagSegment = assertDefined(segments[3]);

  const versionMatch = VERSION_SEGMENT_PATTERN.exec(versionSegment);
  if (!versionMatch) {
    throw new MalformedBlobError('version segment must match v<number>');
  }
  for (const segment of [nonceSegment, ciphertextSegment, tagSegment]) {
    if (!BASE64_SEGMENT_PATTERN.test(segment)) {
      throw new MalformedBlobError('a segment is not valid base64');
    }
  }

  // `(\d+)` always captures at least one digit when the overall pattern matches.
  const versionText = assertDefined(versionMatch[1]);
  const version = Number(versionText);
  const nonce = Buffer.from(nonceSegment, 'base64');
  const ciphertext = Buffer.from(ciphertextSegment, 'base64');
  const tag = Buffer.from(tagSegment, 'base64');

  if (nonce.length !== NONCE_LENGTH) {
    throw new MalformedBlobError('nonce segment must decode to 12 bytes');
  }
  if (tag.length !== TAG_LENGTH) {
    throw new MalformedBlobError('auth tag segment must decode to 16 bytes');
  }

  return { version, nonce, ciphertext, tag };
}

/**
 * Decrypts `blob` using the key registered for its `key_version` in `keyMap`. `keyMap` may hold
 * several versions at once so old and new rows both decrypt during a `noodara secrets rotate`
 * window (D-11). Any GCM authentication failure — tampered ciphertext, tampered tag, or the
 * wrong key — surfaces uniformly as `SecretTamperError`, never a generic crypto error.
 */
export function decryptSecret(blob: EncryptedBlob, keyMap: ReadonlyMap<number, Buffer>): string {
  const parsed = parseBlob(blob);
  const key = keyMap.get(parsed.version);
  if (!key) {
    throw new UnknownKeyVersionError(parsed.version);
  }
  assertKeyLength(key);

  try {
    const decipher = createDecipheriv(ALGORITHM, key, parsed.nonce);
    decipher.setAuthTag(parsed.tag);
    const plaintext = Buffer.concat([decipher.update(parsed.ciphertext), decipher.final()]);
    return plaintext.toString('utf8');
  } catch {
    throw new SecretTamperError();
  }
}

/**
 * Decrypts `blob` under whichever version in `keyMap` it was written with, then re-encrypts the
 * recovered plaintext under `target`. This is the primitive `noodara secrets rotate` (Plan 01-14)
 * uses to move every row from the old master key to the new one inside a single transaction.
 */
export function reencryptSecret(
  blob: EncryptedBlob,
  keyMap: ReadonlyMap<number, Buffer>,
  target: EncryptionKey,
): EncryptedBlob {
  const plaintext = decryptSecret(blob, keyMap);
  return encryptSecret(plaintext, target);
}
