import { describe, expect, it } from 'vitest';
import { parseRetryAfter, resolveLimits } from './call.js';
import { errorForStatus } from './errors.js';

describe('parseRetryAfter', () => {
  const headers = (entries: Record<string, string>) => new Headers(entries);

  it('reads retry-after-ms first, then seconds, then an HTTP date', () => {
    expect(parseRetryAfter(headers({ 'retry-after-ms': '250', 'retry-after': '9' }))).toBe(250);
    expect(parseRetryAfter(headers({ 'retry-after': '3' }))).toBe(3_000);
    const now = Date.parse('2026-11-04T00:00:00Z');
    expect(parseRetryAfter(headers({ 'retry-after': 'Wed, 04 Nov 2026 00:00:05 GMT' }), now)).toBe(5_000);
  });

  it('ignores missing or junk values', () => {
    expect(parseRetryAfter(undefined)).toBeUndefined();
    expect(parseRetryAfter(headers({}))).toBeUndefined();
    expect(parseRetryAfter(headers({ 'retry-after': 'soon' }))).toBeUndefined();
  });
});

describe('errorForStatus', () => {
  it('never retries auth failures and retries rate limits and 5xx', () => {
    expect(errorForStatus(401).retryable).toBe(false);
    expect(errorForStatus(403).retryable).toBe(false);
    expect(errorForStatus(400).retryable).toBe(false);
    expect(errorForStatus(429, 1_000)).toMatchObject({ retryable: true, retryAfterMs: 1_000 });
    expect(errorForStatus(502)).toMatchObject({ code: 'AI_PROVIDER_UNAVAILABLE', retryable: true });
  });
});

describe('resolveLimits', () => {
  it('requires an explicit positive timeout, idle timeout and size cap', () => {
    expect(resolveLimits().timeoutMs).toBe(60_000);
    expect(() => resolveLimits({ timeoutMs: 0 })).toThrow(RangeError);
    expect(() => resolveLimits({ idleTimeoutMs: Number.POSITIVE_INFINITY })).toThrow(RangeError);
    expect(() => resolveLimits({ maxResponseBytes: -1 })).toThrow(RangeError);
  });
});
