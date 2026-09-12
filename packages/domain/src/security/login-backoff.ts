// D-07: per-IP and per-account progressive login-backoff arithmetic. This module owns exactly
// the pure math — how many failures fit in a window, how long each successive lockout lasts, and
// whether a given state is currently locked. It knows nothing about IP addresses, accounts, or
// persistence: the scope (per-IP vs per-account) is entirely a concern of the caller
// (apps/control-plane/src/services/login-attempt-repository.ts and auth/login-guard.ts, Plan
// 01-13's own Task 2). Every "now" is a parameter — this module never reads the platform clock,
// keeping it deterministic and testable without timers (noodara-tdd skill §4).

/** D-07: five failures per 15-minute window. */
export const DEFAULT_MAX_ATTEMPTS = 5;

/** D-07: the failure-counting window, in seconds (15 minutes). Also the duration of the first
 *  lockout — D-07's schedule starts at exactly the window length and doubles from there. */
export const DEFAULT_WINDOW_SECONDS = 900;

/** D-07: no lockout ever exceeds 24 hours, however many consecutive lockouts have occurred. */
export const DEFAULT_MAX_BACKOFF_SECONDS = 86400;

export interface LoginBackoffConfig {
  readonly maxAttempts: number;
  readonly windowSeconds: number;
  readonly maxBackoffSeconds: number;
}

export const DEFAULT_LOGIN_BACKOFF_CONFIG: LoginBackoffConfig = {
  maxAttempts: DEFAULT_MAX_ATTEMPTS,
  windowSeconds: DEFAULT_WINDOW_SECONDS,
  maxBackoffSeconds: DEFAULT_MAX_BACKOFF_SECONDS,
};

/**
 * One scope's (an IP or an account) attempt-tracking state. `lockoutCount` is the number of
 * lockouts this scope has ever triggered — it is never reset except by `clearOnSuccess`, which is
 * exactly what makes each successive lockout longer than the last (D-07's doubling).
 */
export interface LoginAttemptState {
  readonly failureCount: number;
  readonly windowStartedAt: Date;
  readonly lockedUntil: Date | null;
  readonly lockoutCount: number;
}

export type LockoutStatus = { readonly locked: true; readonly retryAfterSeconds: number } | { readonly locked: false };

// A bound on the exponent, not on the result: 2^100 is already many orders of magnitude larger
// than any `maxBackoffSeconds` this project will ever configure, so clamping the exponent here
// (before `Math.pow` ever runs) guarantees the multiplication below can never approach
// `Infinity` for any `lockoutCount`, no matter how large — the real cap is still applied
// afterward by `Math.min`, so the clamp never changes a correct, in-range result.
const MAX_SAFE_DOUBLING_EXPONENT = 100;

/**
 * The duration of the Nth lockout (1-indexed): `windowSeconds * 2^(n-1)`, capped at
 * `maxBackoffSeconds`. `lockoutDurationSeconds(0)` is 0 (no lockout has occurred yet) and the
 * function never returns a negative number for any input.
 */
export function lockoutDurationSeconds(
  lockoutCount: number,
  config: LoginBackoffConfig = DEFAULT_LOGIN_BACKOFF_CONFIG,
): number {
  if (lockoutCount <= 0) {
    return 0;
  }
  const exponent = Math.min(lockoutCount - 1, MAX_SAFE_DOUBLING_EXPONENT);
  const duration = config.windowSeconds * Math.pow(2, exponent);
  return Math.min(duration, config.maxBackoffSeconds);
}

/**
 * Applies one failed attempt to `state`. If the previous counting window has already elapsed
 * (`now` is at or past `windowStartedAt + windowSeconds`), the window restarts at a single
 * failure rather than accumulating across an expired window. Once `failureCount` reaches
 * `maxAttempts`, this failure is the one that triggers a lockout: `lockoutCount` increments,
 * `lockedUntil` is set to `now + lockoutDurationSeconds(lockoutCount + 1)`, and `failureCount`
 * resets to 0 so the next window (once the lock elapses) starts clean.
 */
export function evaluateFailure(
  state: LoginAttemptState,
  now: Date,
  config: LoginBackoffConfig = DEFAULT_LOGIN_BACKOFF_CONFIG,
): LoginAttemptState {
  const windowElapsed = now.getTime() >= state.windowStartedAt.getTime() + config.windowSeconds * 1000;
  const failureCount = windowElapsed ? 1 : state.failureCount + 1;
  const windowStartedAt = windowElapsed ? now : state.windowStartedAt;

  if (failureCount >= config.maxAttempts) {
    const lockoutCount = state.lockoutCount + 1;
    const lockedUntil = new Date(now.getTime() + lockoutDurationSeconds(lockoutCount, config) * 1000);
    return { failureCount: 0, windowStartedAt: now, lockedUntil, lockoutCount };
  }

  return { failureCount, windowStartedAt, lockedUntil: state.lockedUntil, lockoutCount: state.lockoutCount };
}

/**
 * A successful login fully forgives history: no accumulated failures, no active lock, and the
 * next lockout (if any) starts back at the first, shortest duration — never a permanently
 * escalating penalty for an account that eventually authenticates correctly.
 */
export function clearOnSuccess(state: LoginAttemptState): LoginAttemptState {
  return { ...state, failureCount: 0, lockedUntil: null, lockoutCount: 0 };
}

/**
 * Whether `state` is locked at `now`. At exactly `lockedUntil` the lock has already elapsed
 * (`locked: false`) — asserted at that exact boundary by this module's own test suite. No
 * `LoginAttemptState` is ever permanently locked: `lockedUntil` is always a finite point in time
 * (capped by `lockoutDurationSeconds`), so some future `now` always makes this `false`.
 */
export function isLockedOut(state: LoginAttemptState, now: Date): LockoutStatus {
  if (state.lockedUntil === null || now.getTime() >= state.lockedUntil.getTime()) {
    return { locked: false };
  }
  const retryAfterSeconds = Math.ceil((state.lockedUntil.getTime() - now.getTime()) / 1000);
  return { locked: true, retryAfterSeconds };
}
