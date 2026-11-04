// Unified log model (v0.5, LOG-05/06, ADR 0012 "docker logs"). Build and deploy chunks and
// activity live in Postgres; runtime lines are a bounded `docker logs` window fetched on demand.

export const LOG_SOURCES = Object.freeze(['build', 'deploy', 'runtime', 'activity'] as const);
export type LogSource = (typeof LOG_SOURCES)[number];

/** Ascending severity; a filter level keeps entries at that level or above. */
export const LOG_LEVELS = Object.freeze(['info', 'warn', 'error'] as const);
export type LogLevel = (typeof LOG_LEVELS)[number];

/** ADR 0012: default window now - 15 min, never wider than 24 h. */
export const LOG_WINDOW_DEFAULT_MS = 15 * 60_000;
export const LOG_WINDOW_MAX_MS = 24 * 60 * 60_000;

/** Max search term length in UTF-16 code units. */
export const LOG_SEARCH_MAX_LENGTH = 200;

export const LOG_FILTER_ERRORS = Object.freeze([
  'LOG_FILTER_INVALID',
  'LOG_SOURCE_UNKNOWN',
  'LOG_SOURCES_EMPTY',
  'LOG_LEVEL_UNKNOWN',
  'LOG_TIME_INVALID',
  'LOG_RANGE_INVERTED',
  'LOG_RANGE_TOO_WIDE',
  'LOG_SEARCH_INVALID',
  'LOG_SEARCH_TOO_LONG',
] as const);
export type LogFilterError = (typeof LOG_FILTER_ERRORS)[number];

export function isLogSource(value: unknown): value is LogSource {
  return (LOG_SOURCES as readonly unknown[]).includes(value);
}

export function isLogLevel(value: unknown): value is LogLevel {
  return (LOG_LEVELS as readonly unknown[]).includes(value);
}
