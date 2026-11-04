// RFC 3339 timestamps for log entries and filters. `docker logs --timestamps` prints 9 fraction
// digits; activity and chunks carry milliseconds. Nanoseconds are kept apart so mixed precisions
// order correctly without floating-point loss.

const RFC3339 =
  /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:\.(\d{1,9}))?(?:Z|([+-])(\d{2}):(\d{2}))$/;

export interface LogTimestamp {
  /** Epoch milliseconds of the whole second. */
  readonly secondMs: number;
  /** Fraction of the second, 0..999 999 999. */
  readonly nanos: number;
}

/** Parses an RFC 3339 timestamp with an explicit zone; impossible dates (Feb 30) are null. */
export function parseLogTimestamp(input: string): LogTimestamp | null {
  const match = RFC3339.exec(input);
  if (match === null) return null;
  const [, base = '', fraction = '', sign, hours = '00', minutes = '00'] = match;
  const utcMs = Date.parse(`${base}Z`);
  // Round-trip rejects what Date.parse silently rolls over (Feb 30, 24:00:00, 23:59:60).
  if (Number.isNaN(utcMs) || new Date(utcMs).toISOString().slice(0, 19) !== base) return null;
  if (Number(hours) > 23 || Number(minutes) > 59) return null;
  const offsetMs = (Number(hours) * 60 + Number(minutes)) * 60_000;
  return {
    secondMs: sign === '-' ? utcMs + offsetMs : utcMs - offsetMs,
    nanos: Number(fraction.padEnd(9, '0')),
  };
}

export function logTimestampMs(timestamp: LogTimestamp): number {
  return timestamp.secondMs + Math.floor(timestamp.nanos / 1_000_000);
}

export function compareLogTimestamps(a: LogTimestamp, b: LogTimestamp): number {
  return a.secondMs - b.secondMs || a.nanos - b.nanos;
}
