// D-01/D-02/D-03: pure setup/recovery token rules. This module owns exactly three concerns —
// generating high-entropy token material, hashing it for storage, and deciding whether a stored
// token row is still usable — shared verbatim by the setup route (Plan 01-12) and the
// `noodara admin reset` CLI (Plan 01-14, D-03's "same token model for both"). No database, no
// environment variable, no wall-clock read: every "now" this module needs is a parameter, so both
// callers (an HTTP request and a CLI invocation) get identical, independently testable behavior.
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { secretValue, type SecretValue } from './secret-value.js';

/** D-02: a setup or recovery token is valid for 24 hours from issuance. */
export const SETUP_TOKEN_TTL_SECONDS = 86400;

/** D-03: the setup token (first-admin bootstrap) and the recovery token (`admin reset`) share
 *  this one model, distinguished only by `purpose`. */
export const SETUP_TOKEN_PURPOSES = ['setup', 'recovery'] as const;
export type SetupTokenPurpose = (typeof SETUP_TOKEN_PURPOSES)[number];

// 32 raw bytes of `randomBytes` entropy — matches the noodara-security skill's bar for anything
// standing in for a credential (NOODARA_MASTER_KEY is also 32 bytes). base64url avoids the `+`/`/`
// characters that would need URL-escaping if this value ever traveled in a query string.
const TOKEN_BYTES = 32;

/**
 * Generates a fresh setup/recovery token. The raw value is wrapped in a `SecretValue` immediately
 * — nothing outside this function ever sees the bare string, so it cannot be logged by accident
 * on its way from here to stdout (D-01) or to the operator's terminal (D-03).
 */
export function generateSetupToken(): SecretValue {
  const raw = randomBytes(TOKEN_BYTES).toString('base64url');
  return secretValue(raw, 'setup_token');
}

/**
 * Hashes a revealed token value with SHA-256, lowercase hex. Only this digest is ever persisted
 * (D-01) — the raw value exists in memory just long enough to be printed or handed to the
 * operator and then hashed.
 */
export function hashSetupToken(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

/**
 * Constant-time comparison of a candidate token against its stored hash. Both sides are hashed
 * hex digests, not raw tokens, so this is a fixed-length comparison regardless of the candidate's
 * length. `timingSafeEqual` throws on a length mismatch (Node's own documented behavior) — a
 * malformed or truncated `storedHash` must never crash the request, so the length check happens
 * first and short-circuits to `false` instead of letting that exception escape.
 */
export function verifyTokenHash(candidate: string, storedHash: string): boolean {
  const candidateHash = Buffer.from(hashSetupToken(candidate), 'hex');
  const storedHashBuffer = Buffer.from(storedHash, 'hex');
  if (candidateHash.length !== storedHashBuffer.length) {
    return false;
  }
  return timingSafeEqual(candidateHash, storedHashBuffer);
}

export type TokenUsabilityReason = 'ALREADY_USED' | 'EXPIRED';

export type TokenUsability = { usable: true } | { usable: false; reason: TokenUsabilityReason };

export interface TokenUsabilityInput {
  readonly expiresAt: Date;
  readonly usedAt: Date | null;
}

/**
 * A token is usable only when it has never been redeemed and the caller-supplied `now` is still
 * strictly before `expiresAt` — at the exact boundary (`now === expiresAt`) it is already expired,
 * asserted explicitly by this module's own test suite (noodara-tdd skill §4). `ALREADY_USED` wins
 * when a token is both used and expired: a replayed token should always be reported as a replay,
 * never mistaken for one that merely aged out.
 */
export function isTokenUsable(input: TokenUsabilityInput, now: Date): TokenUsability {
  if (input.usedAt !== null) {
    return { usable: false, reason: 'ALREADY_USED' };
  }
  if (now >= input.expiresAt) {
    return { usable: false, reason: 'EXPIRED' };
  }
  return { usable: true };
}
