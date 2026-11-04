// mergeLogEntries (v0.5, LOG-05): one timeline from several sources. Order is timestamp, then
// LOG_SOURCES order, then the entry's position in its own source (ADR 0012: ties keep fetch
// order). Input is keyed by source, so the result never depends on argument order. Entries with
// an unparseable timestamp go last, in the same source/position order.

import { LOG_SOURCES, type LogSource } from './log-model.js';
import { compareLogTimestamps, parseLogTimestamp, type LogTimestamp } from './log-timestamp.js';

export type LogEntriesBySource<T> = Readonly<Partial<Record<LogSource, readonly T[]>>>;

interface Keyed<T> {
  readonly entry: T & { readonly source: LogSource };
  readonly timestamp: LogTimestamp | null;
  readonly sourceIndex: number;
  readonly position: number;
}

function compareKeyed<T>(a: Keyed<T>, b: Keyed<T>): number {
  const byTime =
    a.timestamp === null || b.timestamp === null
      ? Number(a.timestamp === null) - Number(b.timestamp === null)
      : compareLogTimestamps(a.timestamp, b.timestamp);
  return byTime || a.sourceIndex - b.sourceIndex || a.position - b.position;
}

export function mergeLogEntries<T extends { readonly timestamp: string }>(
  bySource: LogEntriesBySource<T>,
): (T & { readonly source: LogSource })[] {
  const keyed: Keyed<T>[] = [];
  LOG_SOURCES.forEach((source, sourceIndex) => {
    (bySource[source] ?? []).forEach((entry, position) => {
      keyed.push({
        entry: { ...entry, source },
        timestamp: parseLogTimestamp(entry.timestamp),
        sourceIndex,
        position,
      });
    });
  });
  return keyed.sort(compareKeyed).map((item) => item.entry);
}
