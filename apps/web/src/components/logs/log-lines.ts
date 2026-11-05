// 30-02: pure helpers of the logs view: a bounded line buffer, the virtual window and the
// timestamp format. No DOM, no I/O.
import type { LogEntryView, LogSource } from '../../lib/api/logs-api';

export interface LogLine {
  /** Stable key, assigned in insertion order. */
  readonly id: number;
  readonly entry: LogEntryView;
}

/** Lines kept in memory; older ones are dropped first. */
export const MAX_LOG_LINES = 10_000;

export interface LineBuffer {
  readonly lines: readonly LogLine[];
  readonly nextId: number;
  /** True once older lines were dropped to stay under the cap. */
  readonly dropped: boolean;
}

export const EMPTY_BUFFER: LineBuffer = Object.freeze({ lines: [], nextId: 0, dropped: false });

/** Appends entries (ascending) and keeps the newest `max`. */
export function appendLines(
  buffer: LineBuffer,
  entries: readonly LogEntryView[],
  max: number = MAX_LOG_LINES,
): LineBuffer {
  if (entries.length === 0) return buffer;
  let id = buffer.nextId;
  const added = entries.map((entry) => ({ id: id++, entry }));
  const all = buffer.lines.length === 0 ? added : [...buffer.lines, ...added];
  const overflow = all.length - max;
  return {
    lines: overflow > 0 ? all.slice(overflow) : all,
    nextId: id,
    dropped: buffer.dropped || overflow > 0,
  };
}

/** A page comes newest first; the view shows oldest first. */
export function bufferFromPage(entries: readonly LogEntryView[], max: number = MAX_LOG_LINES): LineBuffer {
  return appendLines(EMPTY_BUFFER, [...entries].reverse(), max);
}

export interface VisibleRange {
  readonly start: number;
  readonly end: number;
}

/** Rows to render for a fixed-height virtual list: the viewport plus `overscan` on each side. */
export function visibleRange(
  count: number,
  scrollTop: number,
  viewportHeight: number,
  rowHeight: number,
  overscan: number,
): VisibleRange {
  if (count === 0 || rowHeight <= 0) return { start: 0, end: 0 };
  const first = Math.floor(Math.max(0, scrollTop) / rowHeight);
  const shown = Math.ceil(Math.max(0, viewportHeight) / rowHeight);
  const start = Math.max(0, Math.min(count, first) - overscan);
  const end = Math.min(count, first + shown + overscan);
  return { start, end };
}

function pad(value: number, width = 2): string {
  return String(value).padStart(width, '0');
}

/** `YYYY-MM-DD HH:MM:SS.mmm` in local time; the raw value when it is not a date. */
export function formatLogTime(timestamp: string): string {
  const ms = Date.parse(timestamp);
  if (Number.isNaN(ms)) return timestamp;
  const d = new Date(ms);
  return (
    `${String(d.getFullYear())}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ` +
    `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.${pad(d.getMilliseconds(), 3)}`
  );
}

export const SOURCE_LABELS: Readonly<Record<LogSource, string>> = Object.freeze({
  build: 'Build',
  deploy: 'Deploy',
  runtime: 'Runtime',
  activity: 'Activity',
});

// C0 controls and DEL: the server refuses a search with them, so they never reach it.
// eslint-disable-next-line no-control-regex -- deliberately matching control characters
const CONTROL_CHARS = /[\u0000-\u001f\u007f]/g;

/** One line of search text, at most `max` characters. */
export function cleanSearch(value: string, max: number): string {
  return value.replace(CONTROL_CHARS, '').slice(0, max);
}
