// T-09-01/T-09-20: a bounded, per-user throttle for the "current password" confirmation every
// account endpoint (09-06/09-09) requires (D-02). Reuses v0.1's already-tested progressive-backoff
// math (packages/domain/src/security/login-backoff.ts) via the same three functions
// login-guard.ts delegates to (loadAttempt/recordFailure/clearAttempts), but under a distinct
// `reauth:<userId>` scope key — never the email-keyed `login_attempts` row `login-guard.ts` owns.
// This separation is deliberate: a stolen session cookie can guess the current password
// repeatedly, but must never be able to lock the real admin out of *signing in* by exhausting the
// same counter. This module never sees a password; callers decide what counts as a failure.
import { DEFAULT_LOGIN_BACKOFF_CONFIG, evaluateFailure, isLockedOut, type LockoutStatus, type LoginBackoffConfig } from '@noodara/domain/security';
import type { ActivityWriteHandle } from '../activity/write-activity-event.js';
import { clearAttempts, loadAttempt, recordFailure } from '../services/login-attempt-repository.js';

/** Prefixes the `login_attempts.scope_key` so a reauth counter can never collide with the
 *  email-keyed login-lockout row for the same account. */
export const REAUTH_SCOPE_KEY_PREFIX = 'reauth:';

export interface ReauthGuard {
  check(userId: string): Promise<LockoutStatus>;
  recordFailure(userId: string): Promise<void>;
  clear(userId: string): Promise<void>;
}

export interface ReauthGuardDeps {
  readonly db: ActivityWriteHandle;
  readonly now?: () => Date;
  /** Defaults to `DEFAULT_LOGIN_BACKOFF_CONFIG` — login-guard.ts's own `backoffConfig()` builder
   *  (env-derived) is a private, unexported function in that module, so there is nothing to reuse
   *  by reference; this reads the same defaults that builder falls back to. */
  readonly config?: LoginBackoffConfig;
}

function scopeKey(userId: string): string {
  return `${REAUTH_SCOPE_KEY_PREFIX}${userId}`;
}

/** `createReauthGuard` composes `packages/domain`'s pure backoff math with
 *  `login-attempt-repository.ts`'s existing persistence — the exact same building blocks
 *  `login-guard.ts` uses for the sign-in path, applied to scope `'account'` under a `reauth:`
 *  prefixed key so the two lockouts can never interfere with each other. */
export function createReauthGuard(deps: ReauthGuardDeps): ReauthGuard {
  const now = deps.now ?? (() => new Date());
  const config = deps.config ?? DEFAULT_LOGIN_BACKOFF_CONFIG;
  const key = (userId: string) => scopeKey(userId);

  return {
    async check(userId: string): Promise<LockoutStatus> {
      const at = now();
      const state = await loadAttempt(deps.db, 'account', key(userId), at);
      return isLockedOut(state, at);
    },

    async recordFailure(userId: string): Promise<void> {
      const at = now();
      const state = await loadAttempt(deps.db, 'account', key(userId), at);
      const next = evaluateFailure(state, at, config);
      await recordFailure(deps.db, 'account', key(userId), next, at);
    },

    async clear(userId: string): Promise<void> {
      await clearAttempts(deps.db, [{ scope: 'account', key: key(userId) }]);
    },
  };
}
