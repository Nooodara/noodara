// parseLogFilter (v0.5, LOG-06): validates a logs query into a bounded filter. Unknown query keys
// are ignored (paging and follow belong to the API). Messages name the field, never echo the
// search term. The search is a plain substring, never compiled as a regex.

import { fail, ok, type ValidationResult } from '../validators/network.js';
import {
  isLogLevel,
  isLogSource,
  LOG_LEVELS,
  LOG_SEARCH_MAX_LENGTH,
  LOG_SOURCES,
  LOG_WINDOW_DEFAULT_MS,
  LOG_WINDOW_MAX_MS,
  type LogLevel,
  type LogSource,
} from './log-model.js';
import { logTimestampMs, parseLogTimestamp } from './log-timestamp.js';

export interface LogFilter {
  /** De-duplicated, in LOG_SOURCES order. */
  readonly sources: readonly LogSource[];
  /** Inclusive window, epoch milliseconds. */
  readonly sinceMs: number;
  readonly untilMs: number;
  /** Minimum level, or null for every level. */
  readonly level: LogLevel | null;
  /** Plain substring, matched case-insensitively, or null. */
  readonly search: string | null;
}

// C0 controls and DEL: a search term is one line of text.
// eslint-disable-next-line no-control-regex -- deliberately matching control characters
const CONTROL_CHAR = /[\u0000-\u001f\u007f]/;

function parseSources(raw: unknown): ValidationResult<readonly LogSource[]> {
  if (raw === undefined) return ok(LOG_SOURCES);
  const items: unknown[] =
    typeof raw === 'string' ? raw.split(',') : Array.isArray(raw) ? raw : [raw];
  if (items.length === 0) return fail('LOG_SOURCES_EMPTY', 'Pick at least one log source');
  if (!items.every(isLogSource))
    return fail('LOG_SOURCE_UNKNOWN', 'sources has an unknown log source');
  const picked = new Set<unknown>(items);
  return ok(LOG_SOURCES.filter((source) => picked.has(source)));
}

function parseTime(raw: unknown, field: string): ValidationResult<number | undefined> {
  if (raw === undefined) return ok(undefined);
  const timestamp = typeof raw === 'string' ? parseLogTimestamp(raw) : null;
  if (timestamp === null)
    return fail('LOG_TIME_INVALID', `${field} must be an RFC 3339 timestamp with a zone`);
  return ok(logTimestampMs(timestamp));
}

function parseSearch(raw: unknown): ValidationResult<string | null> {
  if (raw === undefined || raw === '') return ok(null);
  if (typeof raw !== 'string' || CONTROL_CHAR.test(raw)) {
    return fail('LOG_SEARCH_INVALID', 'search must be one line of text');
  }
  if (raw.length > LOG_SEARCH_MAX_LENGTH) {
    return fail(
      'LOG_SEARCH_TOO_LONG',
      `search is longer than ${String(LOG_SEARCH_MAX_LENGTH)} characters`,
    );
  }
  return ok(raw);
}

/**
 * `until` defaults to now and is clamped to now; `since` defaults to until - 15 min. The window
 * is inclusive and at most 24 h wide.
 */
export function parseLogFilter(input: unknown, nowMs: number): ValidationResult<LogFilter> {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    return fail('LOG_FILTER_INVALID', 'The log filter must be an object');
  }
  const raw = input as Record<string, unknown>;

  const sources = parseSources(raw.sources);
  if (!sources.ok) return sources;

  const level = raw.level;
  if (level !== undefined && !isLogLevel(level)) {
    return fail('LOG_LEVEL_UNKNOWN', `level must be one of ${LOG_LEVELS.join(', ')}`);
  }

  const since = parseTime(raw.since, 'since');
  if (!since.ok) return since;
  const until = parseTime(raw.until, 'until');
  if (!until.ok) return until;
  const untilMs = Math.min(until.value ?? nowMs, nowMs);
  const sinceMs = since.value ?? untilMs - LOG_WINDOW_DEFAULT_MS;
  if (sinceMs > untilMs) return fail('LOG_RANGE_INVERTED', 'since must not be after until');
  if (untilMs - sinceMs > LOG_WINDOW_MAX_MS) {
    return fail('LOG_RANGE_TOO_WIDE', 'The log window is wider than 24 hours');
  }

  const search = parseSearch(raw.search);
  if (!search.ok) return search;

  return ok({
    sources: sources.value,
    sinceMs,
    untilMs,
    level: level ?? null,
    search: search.value,
  });
}

export interface FilterableLogEntry {
  readonly source: LogSource;
  readonly timestamp: string;
  readonly level: LogLevel;
  readonly text: string;
}

/** Applies a parsed filter to one entry; an entry with an unparseable timestamp never matches. */
export function logEntryMatches(entry: FilterableLogEntry, filter: LogFilter): boolean {
  const timestamp = parseLogTimestamp(entry.timestamp);
  if (timestamp === null || !filter.sources.includes(entry.source)) return false;
  const ms = logTimestampMs(timestamp);
  if (ms < filter.sinceMs || ms > filter.untilMs) return false;
  if (filter.level !== null && LOG_LEVELS.indexOf(entry.level) < LOG_LEVELS.indexOf(filter.level))
    return false;
  return filter.search === null || entry.text.toLowerCase().includes(filter.search.toLowerCase());
}
