// AUTH-01: the transactional core of the first-admin bootstrap. `redeemSetupToken` is the one
// place D-02's three rules (single use, 24h expiry, disappears once an admin exists) and T-1-34's
// race defense (pg_advisory_xact_lock + an in-lock admin-existence re-check) come together.
//
// `auth.api.signUpEmail` runs against Better Auth's own dedicated `pg.Pool` (auth.ts, Plan
// 01-10) — a different connection from this service's own `db.transaction()`. True single-
// transaction atomicity across both is therefore not achievable without editing auth.ts, which
// this plan (and every plan since 01-10) is required not to touch. What *is* guaranteed, because
// `pg_advisory_xact_lock` is a server-side lock keyed by database, not by connection pool: no
// second redemption can pass its own lock acquisition until the winning request's outer
// transaction (which holds the lock for its full duration) commits or rolls back — so the
// exactly-one-admin race guarantee (T-1-34) holds regardless of which pool created the user row.
import { sql } from 'drizzle-orm';
import { hashSetupToken, isTokenUsable } from '@noodara/domain/security';
import { validateEmail, validatePassword } from '@noodara/domain/validators';
import { auth } from '../auth/auth.js';
import { runInBootstrap } from '../auth/bootstrap-context.js';
import { writeActivityEvent, type ActivityWriteHandle } from '../activity/write-activity-event.js';
import { getDb } from '../db/client.js';
import { users } from '../db/schema/auth.js';
import { findUsableByHash, markUsed } from './setup-token-repository.js';

// Fixed, arbitrary application-wide advisory-lock key (Postgres `bigint` key space; any constant
// works as long as every redemption attempt uses the same one). Scoped to this one use — no other
// code in this codebase may call `pg_advisory_xact_lock` with this key.
const SETUP_BOOTSTRAP_LOCK_KEY = 78_321_001;

/**
 * `'ADMIN_EXISTS'` | `'TOKEN_INVALID'` | `'ALREADY_USED'` | `'EXPIRED'`, or a domain validator's
 * own failure code (`EMAIL_INVALID`, `PASSWORD_TOO_SHORT`, ...) passed through unchanged — kept as
 * a plain `string` rather than a closed union so this type never has to be widened again as the
 * validators it delegates to grow their own codes.
 */
export type RedeemSetupTokenFailureCode = string;

export type RedeemSetupTokenResult =
  | { readonly ok: true; readonly userId: string }
  | { readonly ok: false; readonly code: RedeemSetupTokenFailureCode; readonly message: string };

export interface RedeemSetupTokenInput {
  readonly token: string;
  readonly email: string;
  readonly password: string;
  readonly now?: Date;
}

/** Whether at least one user row exists. Called both by the route (to 404 before evaluating the
 *  token, D-02) and inside `redeemSetupToken`'s own advisory lock (the race's actual defense). */
export async function adminExists(handle: ActivityWriteHandle): Promise<boolean> {
  const [row] = await handle.select({ id: users.id }).from(users).limit(1);
  return row !== undefined;
}

/**
 * Redeems a setup token: locks out concurrent redemptions, re-checks admin existence inside the
 * lock, validates the token's usability and the submitted email/password, creates the admin via
 * Better Auth's own sign-up (inside the bootstrap window `signup-gate.ts` requires), marks the
 * token used, and writes a redaction-safe `auth.setup_completed` activity event. Any failure
 * before the sign-up call leaves the token unconsumed.
 */
export async function redeemSetupToken(input: RedeemSetupTokenInput): Promise<RedeemSetupTokenResult> {
  const now = input.now ?? new Date();
  const db = await getDb();

  return db.transaction(async (tx) => {
    // T-1-34: serializes every concurrent redemption database-wide, regardless of which
    // connection pool acquires it — a `FOR UPDATE` on the token row alone would not stop two
    // requests from both observing "no admin yet" before either commits.
    await tx.execute(sql`select pg_advisory_xact_lock(${SETUP_BOOTSTRAP_LOCK_KEY})`);

    if (await adminExists(tx)) {
      return { ok: false, code: 'ADMIN_EXISTS', message: 'An admin already exists' };
    }

    // Looked up by its hash (an indexed equality match, not a secret-dependent branch) before any
    // other check, so an unknown token and a known-but-invalid one take a comparable path.
    const tokenHash = hashSetupToken(input.token);
    const row = await findUsableByHash(tx, tokenHash, 'setup');
    if (!row) {
      return { ok: false, code: 'TOKEN_INVALID', message: 'Invalid or unknown setup token' };
    }

    const usability = isTokenUsable(row, now);
    if (!usability.usable) {
      return {
        ok: false,
        code: usability.reason,
        message: usability.reason === 'ALREADY_USED' ? 'Setup token was already used' : 'Setup token has expired',
      };
    }

    const emailResult = validateEmail(input.email);
    if (!emailResult.ok) {
      return { ok: false, code: emailResult.code, message: emailResult.message };
    }

    const passwordResult = validatePassword(input.password, { email: emailResult.value });
    if (!passwordResult.ok) {
      return { ok: false, code: passwordResult.code, message: passwordResult.message };
    }

    const signUpResult = (await runInBootstrap(() =>
      auth.api.signUpEmail({
        body: { name: 'Admin', email: emailResult.value, password: passwordResult.value },
      }),
    )) as { user: { id: string } };

    await markUsed(tx, row.id, now);
    await writeActivityEvent(
      tx,
      {
        actorType: 'system',
        actorId: null,
        entityType: 'user',
        entityId: signUpResult.user.id,
        action: 'auth.setup_completed',
        outcome: 'success',
        metadata: { email: emailResult.value },
      },
      now,
    );

    return { ok: true, userId: signUpResult.user.id };
  });
}
