// T-4-02/T-5-02: RED for the shared bounded session-lookup helper both `require-session.ts` and
// `routes/events.ts` wrap their `getSession` awaits in. Mirrors `routes/health.ts`'s own
// `withTimeout` proven `Promise.race` shape (see 05-PATTERNS.md "Bounded async operations").
import { describe, expect, it, vi } from 'vitest';
import { SESSION_LOOKUP_TIMEOUT_MS, withSessionLookupTimeout } from './session-lookup.js';

describe('withSessionLookupTimeout', () => {
  it('resolves to the wrapped function\'s value when it settles before the bound', async () => {
    const result = await withSessionLookupTimeout(() => Promise.resolve('a-session'));

    expect(result).toBe('a-session');
  });

  it('rejects within roughly the given bound when the wrapped function never settles, with a fixed message carrying no caller input', async () => {
    vi.useFakeTimers();
    try {
      const neverSettles = () => new Promise<string>(() => undefined);
      const pending = withSessionLookupTimeout(neverSettles, 20);
      const assertion = expect(pending).rejects.toThrow('session lookup timed out');

      await vi.advanceTimersByTimeAsync(20);
      await assertion;
    } finally {
      vi.useRealTimers();
    }
  });

  it('propagates a rejection from the wrapped function unchanged, with no retry', async () => {
    const attempts: number[] = [];
    const alwaysRejects = () => {
      attempts.push(1);
      return Promise.reject(new Error('super-secret-internal-db-detail'));
    };

    await expect(withSessionLookupTimeout(alwaysRejects, 50)).rejects.toThrow(
      'super-secret-internal-db-detail',
    );
    expect(attempts).toHaveLength(1);
  });

  it('uses SESSION_LOOKUP_TIMEOUT_MS as the default bound when no explicit ms is passed', async () => {
    vi.useFakeTimers();
    try {
      const neverSettles = () => new Promise<string>(() => undefined);
      const pending = withSessionLookupTimeout(neverSettles);
      const assertion = expect(pending).rejects.toThrow('session lookup timed out');

      await vi.advanceTimersByTimeAsync(SESSION_LOOKUP_TIMEOUT_MS);
      await assertion;
    } finally {
      vi.useRealTimers();
    }
  });
});
