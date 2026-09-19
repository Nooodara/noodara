import { describe, expect, it } from 'vitest';
import {
  formatDiskUsage,
  formatIso,
  formatMb,
  formatRelativeTime,
  formatUptime,
  PLACEHOLDER,
} from './format.js';

// Every function under test is pure and clock-injected: `now` is always an explicit parameter,
// never read from the wall clock inside the module (grep-gated in the plan's own acceptance
// criteria: zero `Date.now()`/`new Date()` occurrences in format.ts). That is what keeps this
// suite -- and every caller downstream -- deterministic regardless of the machine's own TZ or
// locale.

describe('formatRelativeTime', () => {
  const NOW = new Date('2026-09-19T12:00:00.000Z');

  it('renders "just now" for a timestamp 30 seconds before the reference clock', () => {
    const thirtySecondsAgo = new Date(NOW.getTime() - 30_000);

    expect(formatRelativeTime(thirtySecondsAgo, NOW)).toBe('just now');
  });

  it('renders "1 minute ago" (singular) for exactly one minute before the reference clock', () => {
    const oneMinuteAgo = new Date(NOW.getTime() - 60_000);

    expect(formatRelativeTime(oneMinuteAgo, NOW)).toBe('1 minute ago');
  });

  it('renders "5 minutes ago" for five minutes before the reference clock', () => {
    const fiveMinutesAgo = new Date(NOW.getTime() - 5 * 60_000);

    expect(formatRelativeTime(fiveMinutesAgo, NOW)).toBe('5 minutes ago');
  });

  it('renders "3 hours ago" for approximately three hours before the reference clock', () => {
    const threeHoursAgo = new Date(NOW.getTime() - 3 * 60 * 60_000);

    expect(formatRelativeTime(threeHoursAgo, NOW)).toBe('3 hours ago');
  });

  it('renders "2 days ago" for approximately two days before the reference clock', () => {
    const twoDaysAgo = new Date(NOW.getTime() - 2 * 24 * 60 * 60_000);

    expect(formatRelativeTime(twoDaysAgo, NOW)).toBe('2 days ago');
  });

  it('renders "in 5 minutes" for a timestamp five minutes after the reference clock', () => {
    const fiveMinutesFromNow = new Date(NOW.getTime() + 5 * 60_000);

    expect(formatRelativeTime(fiveMinutesFromNow, NOW)).toBe('in 5 minutes');
  });

  it('returns the shared placeholder for null, never "Invalid Date" and never an empty string', () => {
    const result = formatRelativeTime(null, NOW);

    expect(result).toBe(PLACEHOLDER);
    expect(result).not.toBe('');
    expect(result).not.toMatch(/invalid/i);
  });

  it('returns the shared placeholder for an unparsable date string, never "Invalid Date"', () => {
    const result = formatRelativeTime('not-a-real-date', NOW);

    expect(result).toBe(PLACEHOLDER);
    expect(result).not.toMatch(/invalid/i);
  });

  it('accepts an ISO string (the wire format lastSeenAt actually carries) identically to a Date', () => {
    const isoFiveMinutesAgo = new Date(NOW.getTime() - 5 * 60_000).toISOString();

    expect(formatRelativeTime(isoFiveMinutesAgo, NOW)).toBe('5 minutes ago');
  });
});

describe('formatIso', () => {
  it('returns the full ISO 8601 string for a valid Date input', () => {
    const date = new Date('2026-09-19T12:00:00.000Z');

    expect(formatIso(date)).toBe('2026-09-19T12:00:00.000Z');
  });

  it('returns the full ISO 8601 string for a valid ISO string input', () => {
    expect(formatIso('2026-09-19T12:00:00.000Z')).toBe('2026-09-19T12:00:00.000Z');
  });

  it('returns the shared placeholder for null', () => {
    expect(formatIso(null)).toBe(PLACEHOLDER);
  });

  it('returns the shared placeholder for an unparsable date string, never "Invalid Date"', () => {
    const result = formatIso('not-a-real-date');

    expect(result).toBe(PLACEHOLDER);
    expect(result).not.toMatch(/invalid/i);
  });
});

describe('formatMb', () => {
  it('renders 2048 as "2 GB"', () => {
    expect(formatMb(2048)).toBe('2 GB');
  });

  it('renders 512 as "512 MB"', () => {
    expect(formatMb(512)).toBe('512 MB');
  });

  it('renders null as the placeholder', () => {
    expect(formatMb(null)).toBe(PLACEHOLDER);
  });

  it('renders the 1023/1024 MB unit boundary correctly -- 1023 stays MB, 1024 becomes GB', () => {
    expect(formatMb(1023)).toBe('1023 MB');
    expect(formatMb(1024)).toBe('1 GB');
  });

  it('renders 0 as "0 MB", never silently rounded away or treated as the placeholder', () => {
    expect(formatMb(0)).toBe('0 MB');
  });

  it('renders a fractional GB value with at most one decimal, never rounded to zero', () => {
    expect(formatMb(1536)).toBe('1.5 GB');
  });

  it('renders a very large value in GB without overflowing to a nonsensical unit', () => {
    expect(formatMb(1024 * 1024)).toBe('1024 GB');
  });

  it('returns the placeholder for NaN and Infinity, never a silently-zeroed value', () => {
    expect(formatMb(Number.NaN)).toBe(PLACEHOLDER);
    expect(formatMb(Number.POSITIVE_INFINITY)).toBe(PLACEHOLDER);
  });
});

describe('formatUptime', () => {
  it('renders 93784 seconds as "1 day, 2 hours" (largest two units, no seconds)', () => {
    expect(formatUptime(93_784)).toBe('1 day, 2 hours');
  });

  it('renders 45 seconds as "45 seconds"', () => {
    expect(formatUptime(45)).toBe('45 seconds');
  });

  it('renders null as the placeholder', () => {
    expect(formatUptime(null)).toBe(PLACEHOLDER);
  });

  it('renders 1 second as "1 second" (singular)', () => {
    expect(formatUptime(1)).toBe('1 second');
  });

  it('renders 0 seconds as "0 seconds", never the placeholder', () => {
    expect(formatUptime(0)).toBe('0 seconds');
  });

  it('renders exactly 60 seconds as "1 minute", with no dangling ", 0 seconds"', () => {
    expect(formatUptime(60)).toBe('1 minute');
  });

  it('returns the placeholder for a negative value, never a nonsensical negative duration', () => {
    expect(formatUptime(-10)).toBe(PLACEHOLDER);
  });

  it('returns the placeholder for NaN and Infinity', () => {
    expect(formatUptime(Number.NaN)).toBe(PLACEHOLDER);
    expect(formatUptime(Number.POSITIVE_INFINITY)).toBe(PLACEHOLDER);
  });
});

describe('formatDiskUsage', () => {
  it('renders "18 GB of 40 GB" and a fraction between 0 and 1 for the meter', () => {
    const result = formatDiskUsage(18 * 1024, 40 * 1024);

    expect(result.text).toBe('18 GB of 40 GB');
    expect(result.fraction).toBeCloseTo(0.45);
  });

  it('returns the placeholder and a null fraction when used is null', () => {
    const result = formatDiskUsage(null, 40 * 1024);

    expect(result.text).toBe(PLACEHOLDER);
    expect(result.fraction).toBeNull();
  });

  it('returns the placeholder and a null fraction when total is null', () => {
    const result = formatDiskUsage(18 * 1024, null);

    expect(result.text).toBe(PLACEHOLDER);
    expect(result.fraction).toBeNull();
  });

  it('does not divide by zero when total is 0 -- the fraction is null, not NaN', () => {
    const result = formatDiskUsage(0, 0);

    expect(result.fraction).not.toBeNaN();
    expect(result.fraction).toBeNull();
  });
});
