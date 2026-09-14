// D-10's single-retry policy (SERV-07, PITFALLS.md #8, T-2-34). Every test injects its own `sleep`
// so nothing here waits real wall-clock time; the injected clock proves the exact wait, not the
// exact elapsed time.
import { SERVER_ERROR_CODES, type ServerErrorCode } from '@noodara/domain/server';
import { describe, expect, it, vi } from 'vitest';
import { RETRYABLE_ERROR_CODES, withRetry } from './retry.js';

interface FakeOutcome {
  readonly ok: boolean;
  readonly errorCode?: ServerErrorCode;
  readonly value: string;
}

function ok(value = 'ok'): FakeOutcome {
  return { ok: true, value };
}

function fail(errorCode: ServerErrorCode): FakeOutcome {
  return { ok: false, errorCode, value: 'fail' };
}

describe('RETRYABLE_ERROR_CODES', () => {
  it('is exactly CONNECT_TIMEOUT and CONNECTION_LOST', () => {
    expect(RETRYABLE_ERROR_CODES).toEqual(['CONNECT_TIMEOUT', 'CONNECTION_LOST']);
  });

  it.each(SERVER_ERROR_CODES)('retries a %s failure only when it is CONNECT_TIMEOUT or CONNECTION_LOST', async (code) => {
    const attempt = vi.fn(() => Promise.resolve(fail(code)));
    const sleep = vi.fn(() => Promise.resolve(undefined));

    const outcome = await withRetry(attempt, { sleep });

    const expectedAttempts = code === 'CONNECT_TIMEOUT' || code === 'CONNECTION_LOST' ? 2 : 1;
    expect(attempt).toHaveBeenCalledTimes(expectedAttempts);
    expect(outcome.attempts).toBe(expectedAttempts);
    expect(sleep).toHaveBeenCalledTimes(expectedAttempts - 1);
  });
});

describe('withRetry', () => {
  it('reports attempts: 1 on an immediate success and never calls sleep', async () => {
    const attempt = vi.fn(() => Promise.resolve(ok()));
    const sleep = vi.fn(() => Promise.resolve(undefined));

    const outcome = await withRetry(attempt, { sleep });

    expect(outcome).toMatchObject({ ok: true, attempts: 1 });
    expect(attempt).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();
  });

  it('waits exactly 2000ms via the injected clock before the second attempt', async () => {
    const attempt = vi.fn(() => Promise.resolve(fail('CONNECT_TIMEOUT')));
    const sleep = vi.fn(() => Promise.resolve(undefined));

    await withRetry(attempt, { sleep });

    expect(sleep).toHaveBeenCalledTimes(1);
    expect(sleep).toHaveBeenCalledWith(2000);
  });

  it('retries exactly once and reports attempts: 2 when the retry also fails, never a third attempt', async () => {
    const attempt = vi.fn(() => Promise.resolve(fail('CONNECTION_LOST')));
    const sleep = vi.fn(() => Promise.resolve(undefined));

    const outcome = await withRetry(attempt, { sleep });

    expect(attempt).toHaveBeenCalledTimes(2);
    expect(outcome).toMatchObject({ ok: false, attempts: 2 });
  });

  it('reports attempts: 2 for a retried-then-successful connect', async () => {
    const attempt = vi.fn<() => Promise<FakeOutcome>>();
    attempt.mockResolvedValueOnce(fail('CONNECTION_LOST'));
    attempt.mockResolvedValueOnce(ok('recovered'));
    const sleep = vi.fn(() => Promise.resolve(undefined));

    const outcome = await withRetry(attempt, { sleep });

    expect(outcome).toMatchObject({ ok: true, attempts: 2, value: 'recovered' });
  });

  it('returns immediately with attempts: 1 for a non-retryable failure and never calls sleep', async () => {
    const attempt = vi.fn(() => Promise.resolve(fail('AUTH_FAILED')));
    const sleep = vi.fn(() => Promise.resolve(undefined));

    const outcome = await withRetry(attempt, { sleep });

    expect(attempt).toHaveBeenCalledTimes(1);
    expect(outcome).toMatchObject({ ok: false, attempts: 1 });
    expect(sleep).not.toHaveBeenCalled();
  });
});
