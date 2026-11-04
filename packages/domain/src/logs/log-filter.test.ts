import { describe, expect, it } from 'vitest';
import {
  logEntryMatches,
  parseLogFilter,
  type FilterableLogEntry,
  type LogFilter,
} from './log-filter.js';
import {
  isLogLevel,
  isLogSource,
  LOG_LEVELS,
  LOG_SEARCH_MAX_LENGTH,
  LOG_SOURCES,
  LOG_WINDOW_DEFAULT_MS,
  LOG_WINDOW_MAX_MS,
} from './log-model.js';
import { compareLogTimestamps, logTimestampMs, parseLogTimestamp } from './log-timestamp.js';

// 26-03 A5 (LOG-06): this file alone holds log-filter.ts and log-timestamp.ts at 100% in
// coverage-state-machine.

const NOW = Date.parse('2026-11-03T12:00:00.000Z');
const HOUR = 3_600_000;

function parsed(input: unknown): LogFilter {
  const result = parseLogFilter(input, NOW);
  if (!result.ok) throw new Error(`expected ok, got ${result.code}`);
  return result.value;
}

function code(input: unknown): string {
  const result = parseLogFilter(input, NOW);
  return result.ok ? 'OK' : result.code;
}

describe('log model', () => {
  it('fixes the four sources and three levels', () => {
    expect(LOG_SOURCES).toEqual(['build', 'deploy', 'runtime', 'activity']);
    expect(LOG_LEVELS).toEqual(['info', 'warn', 'error']);
    expect(isLogSource('runtime')).toBe(true);
    expect(isLogSource('stdout')).toBe(false);
    expect(isLogLevel('warn')).toBe(true);
    expect(isLogLevel('debug')).toBe(false);
  });
});

describe('parseLogTimestamp', () => {
  it('parses docker nanosecond, millisecond and whole-second timestamps', () => {
    expect(parseLogTimestamp('2026-11-03T18:37:14.689777509Z')).toEqual({
      secondMs: Date.parse('2026-11-03T18:37:14Z'),
      nanos: 689_777_509,
    });
    expect(parseLogTimestamp('2026-11-03T18:37:14.5Z')?.nanos).toBe(500_000_000);
    expect(parseLogTimestamp('2026-11-03T18:37:14Z')?.nanos).toBe(0);
  });

  it('applies positive and negative offsets', () => {
    const utc = parseLogTimestamp('2026-11-03T12:00:00Z');
    expect(parseLogTimestamp('2026-11-03T14:30:00+02:30')).toEqual(utc);
    expect(parseLogTimestamp('2026-11-03T07:00:00-05:00')).toEqual(utc);
  });

  it.each([
    '',
    '2026-11-03T18:37:14',
    '2026-11-03 18:37:14Z',
    '2026-11-03T18:37:14.1234567890Z',
    '1730000000000',
    '2026-13-01T00:00:00Z',
    '2026-02-30T00:00:00Z',
    '2026-11-03T24:00:00Z',
    '2026-11-03T12:00:60Z',
    '2026-11-03T12:00:00+24:00',
    '2026-11-03T12:00:00+05:60',
  ])('rejects %j', (input) => {
    expect(parseLogTimestamp(input)).toBeNull();
  });

  it('orders by second, then nanoseconds, and converts to milliseconds', () => {
    const a = parseLogTimestamp('2026-11-03T12:00:00.000000001Z');
    const b = parseLogTimestamp('2026-11-03T12:00:00.000000002Z');
    const c = parseLogTimestamp('2026-11-03T12:00:01Z');
    if (a === null || b === null || c === null) throw new Error('fixture');
    expect(compareLogTimestamps(a, b)).toBeLessThan(0);
    expect(compareLogTimestamps(c, b)).toBeGreaterThan(0);
    expect(compareLogTimestamps(a, a)).toBe(0);
    const last = parseLogTimestamp('2026-11-03T12:00:00.999999999Z');
    expect(last === null ? null : logTimestampMs(last)).toBe(
      Date.parse('2026-11-03T12:00:00.999Z'),
    );
  });
});

describe('parseLogFilter (A5)', () => {
  it('defaults to every source, the last 15 minutes, any level and no search', () => {
    expect(parsed({})).toEqual({
      sources: LOG_SOURCES,
      sinceMs: NOW - LOG_WINDOW_DEFAULT_MS,
      untilMs: NOW,
      level: null,
      search: null,
    });
  });

  it('accepts sources as a comma list or an array, de-duplicated in canonical order', () => {
    expect(parsed({ sources: 'runtime,build,runtime' }).sources).toEqual(['build', 'runtime']);
    expect(parsed({ sources: ['activity', 'deploy'] }).sources).toEqual(['deploy', 'activity']);
  });

  it.each([
    [{ sources: [] }, 'LOG_SOURCES_EMPTY'],
    [{ sources: '' }, 'LOG_SOURCE_UNKNOWN'],
    [{ sources: 'build,stdout' }, 'LOG_SOURCE_UNKNOWN'],
    [{ sources: 'Build' }, 'LOG_SOURCE_UNKNOWN'],
    [{ sources: [1] }, 'LOG_SOURCE_UNKNOWN'],
    [{ sources: 7 }, 'LOG_SOURCE_UNKNOWN'],
  ])('rejects source set %j with %s', (input, expected) => {
    expect(code(input)).toBe(expected);
  });

  it('accepts a level and rejects an unknown one', () => {
    expect(parsed({ level: 'warn' }).level).toBe('warn');
    expect(code({ level: 'debug' })).toBe('LOG_LEVEL_UNKNOWN');
    expect(code({ level: 2 })).toBe('LOG_LEVEL_UNKNOWN');
  });

  it('accepts an explicit window and derives a missing bound', () => {
    expect(
      parsed({
        since: '2026-11-03T10:00:00Z',
        until: '2026-11-03T11:00:00.250Z',
      }),
    ).toMatchObject({
      sinceMs: NOW - 2 * HOUR,
      untilMs: NOW - HOUR + 250,
    });
    expect(parsed({ since: '2026-11-03T11:00:00Z' })).toMatchObject({
      sinceMs: NOW - HOUR,
      untilMs: NOW,
    });
    expect(parsed({ until: '2026-11-03T11:00:00Z' })).toMatchObject({
      sinceMs: NOW - HOUR - LOG_WINDOW_DEFAULT_MS,
      untilMs: NOW - HOUR,
    });
  });

  it('clamps until to now and accepts a zero-width window', () => {
    expect(parsed({ until: '2026-11-04T00:00:00Z' }).untilMs).toBe(NOW);
    const instant = parsed({
      since: '2026-11-03T11:00:00Z',
      until: '2026-11-03T11:00:00Z',
    });
    expect(instant.sinceMs).toBe(instant.untilMs);
  });

  it('bounds the window at 24 hours, inclusive', () => {
    expect(parsed({ since: '2026-11-02T12:00:00Z' }).sinceMs).toBe(NOW - LOG_WINDOW_MAX_MS);
    expect(code({ since: '2026-11-02T11:59:59.999Z' })).toBe('LOG_RANGE_TOO_WIDE');
  });

  it.each([
    [{ since: 'yesterday' }, 'LOG_TIME_INVALID'],
    [{ since: 1_730_000_000_000 }, 'LOG_TIME_INVALID'],
    [{ until: '2026-11-03T11:00:00' }, 'LOG_TIME_INVALID'],
    [{ since: '2026-11-03T11:30:00Z', until: '2026-11-03T11:00:00Z' }, 'LOG_RANGE_INVERTED'],
    [{ since: '2026-11-03T12:30:00Z' }, 'LOG_RANGE_INVERTED'],
  ])('rejects time range %j with %s', (input, expected) => {
    expect(code(input)).toBe(expected);
  });

  it('keeps a search term as a literal substring, regex characters included', () => {
    expect(parsed({ search: 'GET /api/(v1|v2)?.*' }).search).toBe('GET /api/(v1|v2)?.*');
    expect(parsed({ search: '' }).search).toBeNull();
    expect(parsed({ search: 'x'.repeat(LOG_SEARCH_MAX_LENGTH) }).search).toHaveLength(
      LOG_SEARCH_MAX_LENGTH,
    );
  });

  it.each([
    [{ search: 'x'.repeat(LOG_SEARCH_MAX_LENGTH + 1) }, 'LOG_SEARCH_TOO_LONG'],
    [{ search: 'line\nbreak' }, 'LOG_SEARCH_INVALID'],
    [{ search: 'nul\u0000' }, 'LOG_SEARCH_INVALID'],
    [{ search: 'del\u007f' }, 'LOG_SEARCH_INVALID'],
    [{ search: ['a'] }, 'LOG_SEARCH_INVALID'],
  ])('rejects search %#', (input, expected) => {
    expect(code(input)).toBe(expected);
  });

  it('never echoes the search term in an error', () => {
    const term = 'sk-live-canary-'.padEnd(LOG_SEARCH_MAX_LENGTH + 5, 'z');
    const result = parseLogFilter({ search: term }, NOW);
    expect(result.ok).toBe(false);
    expect(JSON.stringify(result)).not.toContain('canary');
  });

  it.each([null, 'build', ['build'], 42])('rejects a non-object filter %j', (input) => {
    expect(code(input)).toBe('LOG_FILTER_INVALID');
  });

  it('ignores unknown keys', () => {
    expect(code({ cursor: 'abc', follow: true })).toBe('OK');
  });
});

describe('logEntryMatches', () => {
  const filter = parsed({
    sources: 'runtime,activity',
    since: '2026-11-03T11:00:00Z',
    until: '2026-11-03T11:30:00Z',
    level: 'warn',
    search: 'Timeout',
  });
  const entry = (overrides: Partial<FilterableLogEntry> = {}): FilterableLogEntry => ({
    source: 'runtime',
    timestamp: '2026-11-03T11:15:00.123456789Z',
    level: 'error',
    text: 'upstream TIMEOUT after 30s',
    ...overrides,
  });

  it('matches on source, inclusive window, minimum level and case-insensitive substring', () => {
    expect(logEntryMatches(entry(), filter)).toBe(true);
    expect(
      logEntryMatches(entry({ timestamp: '2026-11-03T11:00:00Z', level: 'warn' }), filter),
    ).toBe(true);
    expect(logEntryMatches(entry({ timestamp: '2026-11-03T11:30:00.000999999Z' }), filter)).toBe(
      true,
    );
  });

  it.each([
    ['source', { source: 'build' as const }],
    ['before the window', { timestamp: '2026-11-03T10:59:59.999Z' }],
    ['after the window', { timestamp: '2026-11-03T11:30:00.001Z' }],
    ['below the level', { level: 'info' as const }],
    ['search miss', { text: 'all good' }],
    ['bad timestamp', { timestamp: 'garbage' }],
  ])('rejects on %s', (_name, overrides) => {
    expect(logEntryMatches(entry(overrides), filter)).toBe(false);
  });

  it('with no level and no search keeps every level and text', () => {
    const open = parsed({ since: '2026-11-03T11:00:00Z' });
    expect(logEntryMatches(entry({ level: 'info', text: 'anything' }), open)).toBe(true);
  });
});
