// D-07: independent per-IP and per-account attempt counters. This is the only file that touches
// `login_attempts` rows directly — `login-guard.ts` (Plan 01-13's Task 2) always goes through
// these three functions, applying `packages/domain/security/login-backoff.ts`'s pure math to
// decide what the *next* state should be before calling `recordFailure`.
import { and, eq } from 'drizzle-orm';
import { DEFAULT_LOGIN_BACKOFF_CONFIG, type LoginAttemptState } from '@noodara/domain/security';
import type { ActivityWriteHandle } from '../activity/write-activity-event.js';
import { loginAttempts } from '../db/schema/login-attempts.js';

export type LoginAttemptScope = 'ip' | 'account';

/**
 * Reads the current attempt state for `(scope, key)`. A scope/key pair with no row yet is a
 * brand-new counter — `windowStartedAt` starts at `now` so the very first failure is never
 * treated as arriving after an already-elapsed window.
 */
export async function loadAttempt(
  handle: ActivityWriteHandle,
  scope: LoginAttemptScope,
  key: string,
  now: Date,
): Promise<LoginAttemptState> {
  const [row] = await handle
    .select()
    .from(loginAttempts)
    .where(and(eq(loginAttempts.scope, scope), eq(loginAttempts.scopeKey, key)));

  if (!row) {
    return { failureCount: 0, windowStartedAt: now, lockedUntil: null, lockoutCount: 0 };
  }

  return {
    failureCount: row.failureCount,
    windowStartedAt: row.windowStartedAt,
    lockedUntil: row.lockedUntil,
    lockoutCount: row.lockoutCount,
  };
}

/**
 * Persists `nextState` (the result of `evaluateFailure`, computed by the caller) for
 * `(scope, key)`. Upserts on the unique `(scope, scope_key)` index (Plan 01-07) so two concurrent
 * failures against the same scope/key can never create duplicate rows — the later write always
 * wins, matching `evaluateFailure`'s own last-write-wins semantics for a single scope.
 */
export async function recordFailure(
  handle: ActivityWriteHandle,
  scope: LoginAttemptScope,
  key: string,
  nextState: LoginAttemptState,
  now: Date,
): Promise<void> {
  await handle
    .insert(loginAttempts)
    .values({
      scope,
      scopeKey: key,
      failureCount: nextState.failureCount,
      windowStartedAt: nextState.windowStartedAt,
      lockedUntil: nextState.lockedUntil,
      lockoutCount: nextState.lockoutCount,
      lastFailureAt: now,
    })
    .onConflictDoUpdate({
      target: [loginAttempts.scope, loginAttempts.scopeKey],
      set: {
        failureCount: nextState.failureCount,
        windowStartedAt: nextState.windowStartedAt,
        lockedUntil: nextState.lockedUntil,
        lockoutCount: nextState.lockoutCount,
        lastFailureAt: now,
        updatedAt: now,
      },
    });
}

/**
 * Deletes every row in `keys` (D-07: a successful login forgives history for both the IP and the
 * account scope at once). Deleting rather than zeroing them in place keeps a scope that has never
 * failed genuinely absent from the table, matching `loadAttempt`'s own "no row = fresh counter"
 * contract.
 */
export async function clearAttempts(
  handle: ActivityWriteHandle,
  keys: readonly { readonly scope: LoginAttemptScope; readonly key: string }[],
): Promise<void> {
  for (const { scope, key } of keys) {
    await handle.delete(loginAttempts).where(and(eq(loginAttempts.scope, scope), eq(loginAttempts.scopeKey, key)));
  }
}

/** Re-exported so `login-guard.ts` can build a default `LoginBackoffConfig` from `env.ts`'s
 *  tuning knobs without importing `packages/domain` twice under two different names. */
export { DEFAULT_LOGIN_BACKOFF_CONFIG };
