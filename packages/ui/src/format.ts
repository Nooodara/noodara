// Pure formatting module (05-UI-SPEC.md §2.5/§6/§10) -- the one place every number, byte count,
// duration and timestamp in the UI is formatted. No function here ever reads the wall clock or
// the host's locale itself: `formatRelativeTime` takes `now: Date` as an explicit parameter
// (matching `packages/domain`'s own discipline of taking `now: Date` as a parameter instead of
// reading the platform clock directly), and every `Intl.*` call below pins the `en` locale explicitly
// so output never depends on the runner's own `LANG`/`Intl.getCanonicalLocales()` default.

/** The shared "no value" glyph -- every formatter below renders this, never "Invalid Date" and
 *  never an empty string, whenever its input is null or otherwise unparsable. */
export const PLACEHOLDER = '—';

const MINUTE_SECONDS = 60;
const HOUR_SECONDS = 60 * MINUTE_SECONDS;
const DAY_SECONDS = 24 * HOUR_SECONDS;
const JUST_NOW_THRESHOLD_SECONDS = 60;

const RELATIVE_TIME_FORMATTER = new Intl.RelativeTimeFormat('en', { numeric: 'always' });

const RELATIVE_TIME_UNITS: readonly [unitSeconds: number, unit: Intl.RelativeTimeFormatUnit][] = [
  [DAY_SECONDS, 'day'],
  [HOUR_SECONDS, 'hour'],
  [MINUTE_SECONDS, 'minute'],
];

function toValidDate(value: Date | string): Date | null {
  const date = typeof value === 'string' ? new Date(value) : value;
  return Number.isNaN(date.getTime()) ? null : date;
}

/**
 * Relative time from `value` to the caller-supplied `now` clock -- "just now" inside a 60-second
 * window, otherwise the largest applicable unit (minute/hour/day) via `Intl.RelativeTimeFormat`,
 * which also produces "in {n} {unit}" for a future `value`. Never reads the platform clock itself.
 */
export function formatRelativeTime(value: Date | string | null, now: Date): string {
  if (value === null) {
    return PLACEHOLDER;
  }

  const date = toValidDate(value);
  if (date === null) {
    return PLACEHOLDER;
  }

  const diffSeconds = (now.getTime() - date.getTime()) / 1000;
  const absSeconds = Math.abs(diffSeconds);

  if (absSeconds < JUST_NOW_THRESHOLD_SECONDS) {
    return 'just now';
  }

  for (const [unitSeconds, unit] of RELATIVE_TIME_UNITS) {
    if (absSeconds >= unitSeconds) {
      const magnitude = -Math.round(diffSeconds / unitSeconds);
      return RELATIVE_TIME_FORMATTER.format(magnitude, unit);
    }
  }

  // Unreachable: absSeconds >= JUST_NOW_THRESHOLD_SECONDS (60) always matches the minute bucket.
  return PLACEHOLDER;
}

/** Full ISO 8601 string for `value`, or the placeholder for null/unparsable input. Never reads
 *  the clock -- this is a pure reformat, not a "now" computation. */
export function formatIso(value: Date | string | null): string {
  if (value === null) {
    return PLACEHOLDER;
  }

  const date = toValidDate(value);
  return date === null ? PLACEHOLDER : date.toISOString();
}

const MB_PER_GB = 1024;
const MB_NUMBER_FORMATTER = new Intl.NumberFormat('en', { maximumFractionDigits: 0, useGrouping: false });
const GB_NUMBER_FORMATTER = new Intl.NumberFormat('en', { maximumFractionDigits: 1, useGrouping: false });

/**
 * Byte-count formatter over `ServerView`'s `ramMb`/`diskTotalMb`/`diskUsedMb` fields: below the
 * 1024 MB boundary renders whole megabytes, at or above it renders gigabytes (at most one decimal
 * place, so a fractional value like 1536 MB never silently rounds to "0 GB" or "2 GB"). `null`
 * and non-finite input (`NaN`/`Infinity`) both render the placeholder -- never zero.
 */
export function formatMb(mb: number | null): string {
  if (mb === null || !Number.isFinite(mb)) {
    return PLACEHOLDER;
  }

  if (Math.abs(mb) >= MB_PER_GB) {
    return `${GB_NUMBER_FORMATTER.format(mb / MB_PER_GB)} GB`;
  }

  return `${MB_NUMBER_FORMATTER.format(mb)} MB`;
}

const UPTIME_UNITS: readonly [label: string, unitSeconds: number][] = [
  ['day', DAY_SECONDS],
  ['hour', HOUR_SECONDS],
  ['minute', MINUTE_SECONDS],
];

function pluralize(count: number, label: string): string {
  return `${count.toString(10)} ${label}${count === 1 ? '' : 's'}`;
}

/**
 * Uptime in seconds rendered as its largest two non-zero units (day/hour/minute), never seconds
 * once the total reaches a full minute -- below that it renders the whole-second count directly
 * ("45 seconds"). Negative, `NaN` and `Infinity` all render the placeholder rather than a
 * nonsensical duration; `null` renders the placeholder too.
 */
export function formatUptime(seconds: number | null): string {
  if (seconds === null || !Number.isFinite(seconds) || seconds < 0) {
    return PLACEHOLDER;
  }

  const whole = Math.floor(seconds);

  if (whole < MINUTE_SECONDS) {
    return pluralize(whole, 'second');
  }

  let remaining = whole;
  const parts: string[] = [];

  for (const [label, unitSeconds] of UPTIME_UNITS) {
    const count = Math.floor(remaining / unitSeconds);
    if (count > 0) {
      parts.push(pluralize(count, label));
      remaining -= count * unitSeconds;
    }
    if (parts.length === 2) {
      break;
    }
  }

  return parts.join(', ');
}

export interface DiskUsage {
  readonly text: string;
  readonly fraction: number | null;
}

/**
 * Disk used-of-total for the detail page's stat tile meter (05-UI-SPEC.md §2.5): a human string
 * ("18 GB of 40 GB") built from `formatMb`, plus a 0..1 fraction for the meter's fill. Either
 * input being `null` (or non-finite/negative) yields the placeholder text and a `null` fraction;
 * a `total` of exactly 0 never divides by zero -- the fraction is `null`, not `NaN`.
 */
export function formatDiskUsage(usedMb: number | null, totalMb: number | null): DiskUsage {
  if (
    usedMb === null ||
    totalMb === null ||
    !Number.isFinite(usedMb) ||
    !Number.isFinite(totalMb) ||
    usedMb < 0 ||
    totalMb < 0
  ) {
    return { text: PLACEHOLDER, fraction: null };
  }

  const text = `${formatMb(usedMb)} of ${formatMb(totalMb)}`;
  const fraction = totalMb === 0 ? null : usedMb / totalMb;

  return { text, fraction };
}
