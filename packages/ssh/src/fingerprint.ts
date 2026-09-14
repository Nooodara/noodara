// Host key fingerprint derivation (D-04/D-05, SEC-03, T-2-21/T-2-22/T-2-25). Pure computation
// over `node:crypto` and `ssh2`'s own key parser only — no I/O. `computeFingerprint` is the one
// place the "SHA256:<base64-no-padding>" rendering `ssh-keygen -lf` prints is produced;
// docs/adr/0004-ssh-adapter-empirical-contracts.md's standing integration test
// (tests/integration/ssh/contracts.test.ts) is the authoritative byte-for-byte cross-check
// against real `ssh-keygen -lf` output — this file's own unit tests check the digest by an
// independently-computed value, never by duplicating that integration assertion.
import { createHash } from 'node:crypto';
import { utils } from 'ssh2';
import type { HostFingerprint } from './ssh-port.js';

/** Raised for a host key blob this module cannot safely fingerprint. Never carries key bytes. */
export class InvalidHostKeyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidHostKeyError';
  }
}

// "<keyType> SHA256:<base64>" — D-04's exact rendering. Key type names (`ssh-ed25519`,
// `ecdsa-sha2-nistp256`, `rsa-sha2-512`, ...) never contain whitespace, so a single space
// separator with no whitespace inside either group is unambiguous to parse back out.
const FINGERPRINT_PATTERN = /^(\S+) (SHA256:[A-Za-z0-9+/]+)$/;

/**
 * ADR 0004's chosen technique (a): `utils.parseKey` accepts the raw RFC 4253 host-key-blob layout
 * directly via its own binary-fallback parse branch, and `.type` is the algorithm name — measured
 * to match a manual length-prefix decode exactly, with no hand-rolled byte offsets needed here.
 */
function readAlgorithmName(rawHostKey: Buffer): string {
  const parsed = utils.parseKey(rawHostKey);
  if (parsed instanceof Error || Array.isArray(parsed)) {
    throw new InvalidHostKeyError('unable to determine the host key algorithm from this blob');
  }
  return parsed.type;
}

/**
 * `SHA256:` + base64(sha256(rawHostKey)) with trailing `=` padding stripped, plus the algorithm
 * name resolved per ADR 0004. Rejects a zero-length/non-`Buffer` input outright (a digest of
 * nothing is never a valid fingerprint), and independently validates the RFC 4253 4-byte
 * big-endian length prefix against the buffer's actual length *before* handing the blob to
 * `utils.parseKey` (T-2-25: a malformed blob is a validation failure, never an out-of-bounds read
 * or an uncaught exception, regardless of how robust ssh2's own parser happens to be).
 */
export function computeFingerprint(rawHostKey: Buffer): HostFingerprint {
  if (!Buffer.isBuffer(rawHostKey) || rawHostKey.length === 0) {
    throw new InvalidHostKeyError('host key blob must be a non-empty Buffer');
  }
  if (rawHostKey.length < 4) {
    throw new InvalidHostKeyError('host key blob is too short to contain an algorithm-name length prefix');
  }

  const declaredLength = rawHostKey.readUInt32BE(0);
  if (4 + declaredLength > rawHostKey.length) {
    throw new InvalidHostKeyError("host key blob's algorithm-name length prefix exceeds the buffer");
  }

  const keyType = readAlgorithmName(rawHostKey);
  const digest = createHash('sha256').update(rawHostKey).digest('base64').replace(/=+$/, '');

  return { keyType, fingerprint: `SHA256:${digest}` };
}

/** `"<keyType> SHA256:<base64>"` — the exact line `ssh-keygen -lf` prints (D-04/D-05). */
export function formatFingerprint(fp: HostFingerprint): string {
  return `${fp.keyType} ${fp.fingerprint}`;
}

/** The exact inverse of `formatFingerprint`. Rejects any string not in that form. */
export function parseFingerprint(value: string): HostFingerprint {
  const match = FINGERPRINT_PATTERN.exec(value);
  if (match === null) {
    throw new InvalidHostKeyError(
      `not a valid "<keyType> SHA256:<base64>" fingerprint string: ${JSON.stringify(value)}`,
    );
  }
  const [, keyType, fingerprint] = match;
  if (keyType === undefined || fingerprint === undefined) {
    throw new InvalidHostKeyError(`not a valid "<keyType> SHA256:<base64>" fingerprint string`);
  }
  return { keyType, fingerprint };
}

/**
 * True only when both the key type and the digest match (D-05). A key-type change with an
 * identical digest, and a digest change with an identical key type, are both a mismatch — this is
 * the whole point of storing `keyType` alongside `fingerprint` rather than the digest alone.
 */
export function fingerprintsEqual(a: HostFingerprint, b: HostFingerprint): boolean {
  return a.keyType === b.keyType && a.fingerprint === b.fingerprint;
}
