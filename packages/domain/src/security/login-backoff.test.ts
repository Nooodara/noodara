import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_MAX_ATTEMPTS,
  DEFAULT_MAX_BACKOFF_SECONDS,
  DEFAULT_WINDOW_SECONDS,
  clearOnSuccess,
  evaluateFailure,
  isLockedOut,
  lockoutDurationSeconds,
  type LoginAttemptState,
} from './login-backoff.js';

// D-07: five failures per 15-minute window, counted independently per IP and per account
// (RESEARCH Pitfall 2 — this module is scope-agnostic; login-attempt-repository.ts and
// login-guard.ts, Plan 01-13's Task 2, apply it once per scope). Each successive lockout doubles
// the wait, capped at 24h, never permanent. Every `now` is a parameter (noodara-tdd skill §4).

const SOURCE_PATH = fileURLToPath(new URL('./login-backoff.ts', import.meta.url));

function freshState(overrides: Partial<LoginAttemptState> = {}): LoginAttemptState {
  return {
    failureCount: 0,
    windowStartedAt: new Date('2026-01-01T00:00:00.000Z'),
    lockedUntil: null,
    lockoutCount: 0,
    ...overrides,
  };
}

describe('constants', () => {
  it('DEFAULT_MAX_ATTEMPTS is 5', () => {
    expect(DEFAULT_MAX_ATTEMPTS).toBe(5);
  });

  it('DEFAULT_WINDOW_SECONDS is 900 (15 minutes)', () => {
    expect(DEFAULT_WINDOW_SECONDS).toBe(900);
  });

  it('DEFAULT_MAX_BACKOFF_SECONDS is 86400 (24 hours)', () => {
    expect(DEFAULT_MAX_BACKOFF_SECONDS).toBe(86400);
  });
});

describe('lockoutDurationSeconds', () => {
  it('doubles for each successive lockout: 900, 1800, 3600, 7200', () => {
    expect(lockoutDurationSeconds(1)).toBe(900);
    expect(lockoutDurationSeconds(2)).toBe(1800);
    expect(lockoutDurationSeconds(3)).toBe(3600);
    expect(lockoutDurationSeconds(4)).toBe(7200);
  });

  it('is 0 for lockoutCount 0 (no lockout has occurred yet)', () => {
    expect(lockoutDurationSeconds(0)).toBe(0);
  });

  it('is 0 for a negative lockoutCount', () => {
    expect(lockoutDurationSeconds(-3)).toBe(0);
  });

  it('is capped at 86400 for a lockout count large enough to exceed it', () => {
    // 2^7 * 900 = 115200 > 86400 (2^6 * 900 = 57600, still under)
    expect(lockoutDurationSeconds(8)).toBe(86400);
    expect(lockoutDurationSeconds(20)).toBe(86400);
  });

  it('is finite, positive, and at most 86400 for every lockoutCount from 1 to 1000', () => {
    for (let n = 1; n <= 1000; n++) {
      const duration = lockoutDurationSeconds(n);
      expect(Number.isFinite(duration)).toBe(true);
      expect(duration).toBeGreaterThan(0);
      expect(duration).toBeLessThanOrEqual(86400);
    }
  });

  it('respects a custom config (different window/cap)', () => {
    const config = { maxAttempts: 5, windowSeconds: 60, maxBackoffSeconds: 300 };
    expect(lockoutDurationSeconds(1, config)).toBe(60);
    expect(lockoutDurationSeconds(2, config)).toBe(120);
    expect(lockoutDurationSeconds(3, config)).toBe(240);
    expect(lockoutDurationSeconds(4, config)).toBe(300); // 480 capped to 300
  });
});

describe('evaluateFailure', () => {
  it('increments failureCount within the same window', () => {
    const t0 = new Date('2026-01-01T00:00:00.000Z');
    let state = freshState({ windowStartedAt: t0 });

    state = evaluateFailure(state, new Date(t0.getTime() + 1000));
    expect(state.failureCount).toBe(1);

    state = evaluateFailure(state, new Date(t0.getTime() + 2000));
    expect(state.failureCount).toBe(2);

    state = evaluateFailure(state, new Date(t0.getTime() + 3000));
    expect(state.failureCount).toBe(3);
  });

  it('restarts the window at 1 when the previous window has elapsed', () => {
    const t0 = new Date('2026-01-01T00:00:00.000Z');
    const state = freshState({ windowStartedAt: t0, failureCount: 3 });

    // 900s window: exactly at/after t0 + 900s the window has elapsed.
    const afterWindow = new Date(t0.getTime() + 900_000);
    const next = evaluateFailure(state, afterWindow);

    expect(next.failureCount).toBe(1);
    expect(next.windowStartedAt).toEqual(afterWindow);
  });

  it('does not restart the window one millisecond before it elapses', () => {
    const t0 = new Date('2026-01-01T00:00:00.000Z');
    const state = freshState({ windowStartedAt: t0, failureCount: 3 });

    const justBefore = new Date(t0.getTime() + 900_000 - 1);
    const next = evaluateFailure(state, justBefore);

    expect(next.failureCount).toBe(4);
    expect(next.windowStartedAt).toEqual(t0);
  });

  it('triggers a lockout when failureCount reaches maxAttempts, resetting failureCount to 0', () => {
    const t0 = new Date('2026-01-01T00:00:00.000Z');
    let state = freshState({ windowStartedAt: t0 });

    for (let i = 0; i < 4; i++) {
      state = evaluateFailure(state, new Date(t0.getTime() + i * 1000));
    }
    expect(state.failureCount).toBe(4);
    expect(state.lockedUntil).toBeNull();

    const fifthFailureAt = new Date(t0.getTime() + 4000);
    state = evaluateFailure(state, fifthFailureAt);

    expect(state.failureCount).toBe(0);
    expect(state.lockoutCount).toBe(1);
    expect(state.lockedUntil).toEqual(new Date(fifthFailureAt.getTime() + 900_000));
  });

  it('doubles the lockout duration on the second consecutive lockout', () => {
    const t0 = new Date('2026-01-01T00:00:00.000Z');
    // Simulate a scope that has already been locked out once.
    let state = freshState({ windowStartedAt: t0, lockoutCount: 1 });

    for (let i = 0; i < 4; i++) {
      state = evaluateFailure(state, new Date(t0.getTime() + i * 1000));
    }
    const fifthFailureAt = new Date(t0.getTime() + 4000);
    state = evaluateFailure(state, fifthFailureAt);

    expect(state.lockoutCount).toBe(2);
    expect(state.lockedUntil).toEqual(new Date(fifthFailureAt.getTime() + 1800_000));
  });
});

describe('clearOnSuccess', () => {
  it('zeroes failureCount, lockedUntil, and lockoutCount', () => {
    const state = freshState({
      failureCount: 4,
      lockedUntil: new Date('2026-01-01T01:00:00.000Z'),
      lockoutCount: 3,
    });

    const cleared = clearOnSuccess(state);

    expect(cleared.failureCount).toBe(0);
    expect(cleared.lockedUntil).toBeNull();
    expect(cleared.lockoutCount).toBe(0);
  });
});

describe('isLockedOut', () => {
  it('is not locked when lockedUntil is null', () => {
    const state = freshState({ lockedUntil: null });
    expect(isLockedOut(state, new Date())).toEqual({ locked: false });
  });

  it('is locked with a positive retryAfterSeconds while now is before lockedUntil', () => {
    const lockedUntil = new Date('2026-01-01T00:15:00.000Z');
    const state = freshState({ lockedUntil });
    const now = new Date('2026-01-01T00:00:00.000Z');

    const status = isLockedOut(state, now);

    expect(status.locked).toBe(true);
    if (status.locked) {
      expect(status.retryAfterSeconds).toBe(900);
    }
  });

  it('is not locked at exactly lockedUntil (the boundary)', () => {
    const lockedUntil = new Date('2026-01-01T00:15:00.000Z');
    const state = freshState({ lockedUntil });

    expect(isLockedOut(state, lockedUntil)).toEqual({ locked: false });
  });

  it('is not locked one millisecond before lockedUntil is false — it is still locked', () => {
    const lockedUntil = new Date('2026-01-01T00:15:00.000Z');
    const state = freshState({ lockedUntil });
    const justBefore = new Date(lockedUntil.getTime() - 1);

    const status = isLockedOut(state, justBefore);
    expect(status.locked).toBe(true);
  });

  it('no state is permanent: some future now always resolves to unlocked', () => {
    const lockedUntil = new Date('2026-01-02T00:00:00.000Z');
    const state = freshState({ lockedUntil, lockoutCount: 999 });
    // lockoutDurationSeconds caps at 86400s regardless of lockoutCount, so lockedUntil is always
    // finite — evaluating at exactly that instant is always enough to prove it is not permanent.
    expect(isLockedOut(state, lockedUntil)).toEqual({ locked: false });
  });
});

describe('module purity', () => {
  it('never calls Date.now() — every "now" is a parameter', () => {
    const source = readFileSync(SOURCE_PATH, 'utf8');
    expect(source).not.toContain('Date.now()');
  });
});
