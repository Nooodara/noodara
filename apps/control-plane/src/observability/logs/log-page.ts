// 27-04 (A1, A2, H1): assembles one backwards page from every source's scan. Each scan holds a
// source's newest entries at or below the page's upper bound, already redacted and positioned.
// A scan that hit its cap reports a `boundary`: nothing of that source below it was read, so no
// entry from any source below the highest such boundary is returned on this page (the next page
// resumes there). A boundary that is not below the cursor means the source cannot go further back
// (the runtime window is newest-first only): that source stops and the page says `truncated`.
import { logEntryMatches, mergeLogEntries, type LogFilter, type LogSource } from '@noodara/domain';
import type { LogEntryView } from '@noodara/domain/api-contract';
import { compareLogPositions, type LogPosition } from './log-cursor.js';
import { positionOf, toView, type PositionedEntry } from './log-entries.js';

export interface SourceScan {
  /** Ascending by position. */
  readonly entries: readonly PositionedEntry[];
  /** The lowest position read when the scan hit its cap; null when it read everything in range. */
  readonly boundary: LogPosition | null;
  /** The source itself dropped data (an output cap) that no later page can reach. */
  readonly capped?: boolean;
}

export interface BuildLogPageInput {
  readonly filter: LogFilter;
  /** Exclusive upper position from the request's cursor, or null for the first page. */
  readonly cursor: LogPosition | null;
  readonly limit: number;
  /** Cap on the summed UTF-8 length of the page's texts. */
  readonly maxBytes: number;
  readonly scans: Readonly<Partial<Record<LogSource, SourceScan>>>;
  /** The window itself was clamped to its maximum width. */
  readonly windowClamped?: boolean;
}

export interface BuiltLogPage {
  /** Ascending. */
  readonly entries: LogEntryView[];
  /** Exclusive upper position of the next (older) page, or null when nothing older remains. */
  readonly next: LogPosition | null;
  readonly truncated: boolean;
}

function below(position: LogPosition, cursor: LogPosition | null): boolean {
  return cursor === null || compareLogPositions(position, cursor) < 0;
}

export function buildLogPage(input: BuildLogPageInput): BuiltLogPage {
  const { filter, cursor } = input;
  let truncated = input.windowClamped === true;
  let cutoff: LogPosition | null = null;
  const bySource: Partial<Record<LogSource, PositionedEntry[]>> = {};

  for (const source of filter.sources) {
    const scan = input.scans[source];
    if (scan === undefined) continue;
    if (scan.capped === true) truncated = true;
    const kept = scan.entries.filter((entry) => below(positionOf(entry), cursor));
    if (scan.boundary !== null) {
      if (below(scan.boundary, cursor) && kept.length > 0) {
        if (cutoff === null || compareLogPositions(scan.boundary, cutoff) > 0) cutoff = scan.boundary;
      } else {
        // Nothing of this source can be read below the cursor any more.
        truncated = true;
      }
    }
    bySource[source] = kept.filter((entry) => logEntryMatches(entry, filter));
  }

  const lowest = cutoff;
  const merged = mergeLogEntries(bySource).filter(
    (entry) => lowest === null || compareLogPositions(positionOf(entry), lowest) >= 0,
  );
  const dropped = merged.length;

  // Newest first until the line or byte cap, then back to ascending order.
  const picked: PositionedEntry[] = [];
  let bytes = 0;
  for (let i = merged.length - 1; i >= 0 && picked.length < input.limit; i -= 1) {
    const entry = merged[i];
    if (entry === undefined) break;
    const size = Buffer.byteLength(entry.text, 'utf8');
    if (picked.length > 0 && bytes + size > input.maxBytes) {
      truncated = true;
      break;
    }
    bytes += size;
    picked.push(entry);
  }
  picked.reverse();

  const oldest = picked[0];
  let next: LogPosition | null = null;
  if (oldest !== undefined && (picked.length < dropped || lowest !== null)) next = positionOf(oldest);
  else if (oldest === undefined && lowest !== null) next = lowest;
  return { entries: picked.map(toView), next, truncated };
}
