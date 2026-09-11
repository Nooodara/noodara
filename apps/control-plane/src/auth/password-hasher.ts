import * as argon2 from 'argon2';

// AUTH-02 / noodara-security §5, RESEARCH Pattern 2: argon2id via the `argon2` native bindings,
// wired directly into Better Auth's `emailAndPassword.password.hash`/`.verify` (auth.ts) instead
// of Better Auth's own default (scrypt-based) hasher.

/** Hashes `password` with argon2id. Matches Better Auth's `password.hash` signature. */
export async function hashPassword(password: string): Promise<string> {
  return argon2.hash(password, { type: argon2.argon2id });
}

/**
 * Verifies `password` against `hash`. Matches Better Auth's `password.verify` signature.
 * Returns `false` — never throws — for a malformed/foreign-format stored hash, so a corrupted or
 * legacy row fails a login attempt instead of crashing the request.
 */
export async function verifyPassword({
  hash,
  password,
}: {
  hash: string;
  password: string;
}): Promise<boolean> {
  try {
    return await argon2.verify(hash, password);
  } catch {
    return false;
  }
}
