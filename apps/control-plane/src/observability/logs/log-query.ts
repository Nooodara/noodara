// 27-04 (A1, A2, A4, H2): one page of a service's unified logs. Every requested source is read
// under the service's redactor; a runtime read that fails or times out marks only `runtime`
// unavailable while build, deploy and activity still answer. The redactor's lease is released on
// every exit path.
import { logTimestampMs, parseLogTimestamp, type LogFilter, type LogSource } from '@noodara/domain';
import type { Database } from '../../db/client.js';
import type { MasterKeys } from '../../services/server-service-deps.js';
import type { LogPosition } from './log-cursor.js';
import { buildLogPage, type BuiltLogPage, type SourceScan } from './log-page.js';
import {
  openServiceRedactor,
  scanActivity,
  scanChunks,
  scanRuntime,
  type LogConnect,
  type LogServiceRef,
  type ScanWindow,
  type ServiceRedactor,
} from './log-sources.js';

export interface LogQueryDeps {
  readonly db: Database;
  readonly connect: LogConnect;
  readonly masterKeys: () => Promise<MasterKeys>;
  /** Bound of the whole runtime read (connect + fetch). */
  readonly runtimeTimeoutMs: number;
  /** Cap on the summed UTF-8 length of a page's texts. */
  readonly pageMaxBytes: number;
}

export interface LogQueryInput {
  readonly filter: LogFilter;
  readonly cursor: LogPosition | null;
  readonly limit: number;
  readonly windowClamped: boolean;
}

export type LogQueryResult =
  | { readonly ok: true; readonly page: BuiltLogPage; readonly unavailable: readonly LogSource[] }
  | { readonly ok: false; readonly code: 'LOG_SOURCE_UNAVAILABLE' };

const EMPTY: SourceScan = { entries: [], boundary: null };

/** The service's redactor, or null when its secrets could not be read (fail closed). */
export async function tryServiceRedactor(
  deps: Pick<LogQueryDeps, 'db' | 'masterKeys'>,
  service: LogServiceRef,
): Promise<ServiceRedactor | null> {
  try {
    return await openServiceRedactor(deps.db, service, deps.masterKeys);
  } catch {
    return null;
  }
}

export async function queryServiceLogs(
  deps: LogQueryDeps,
  service: LogServiceRef,
  input: LogQueryInput,
): Promise<LogQueryResult> {
  const { filter, cursor } = input;
  const cursorAt = cursor === null ? null : parseLogTimestamp(cursor.timestamp);
  const upperMs = cursorAt === null ? filter.untilMs : Math.min(filter.untilMs, logTimestampMs(cursorAt));
  const window: ScanWindow = { sinceMs: filter.sinceMs, upperMs };
  const wants = (source: LogSource): boolean => filter.sources.includes(source);
  const empty = upperMs < filter.sinceMs;

  const opened = await tryServiceRedactor(deps, service);
  if (opened === null) return { ok: false, code: 'LOG_SOURCE_UNAVAILABLE' };
  try {
    const { redactor } = opened;
    const [chunks, activity, runtime] = await Promise.all([
      !empty && (wants('build') || wants('deploy')) ? scanChunks(deps.db, service.id, window, redactor) : null,
      !empty && wants('activity') ? scanActivity(deps.db, service.id, window, redactor) : null,
      !empty && wants('runtime') ? scanRuntime(deps.connect, service, window, redactor, deps.runtimeTimeoutMs) : null,
    ]);
    const unavailable: LogSource[] = runtime !== null && !runtime.ok ? ['runtime'] : [];
    if (unavailable.length > 0 && unavailable.length === filter.sources.length) {
      return { ok: false, code: 'LOG_SOURCE_UNAVAILABLE' };
    }
    const scans: Partial<Record<LogSource, SourceScan>> = {
      build: chunks?.build ?? EMPTY,
      deploy: chunks?.deploy ?? EMPTY,
      activity: activity ?? EMPTY,
      runtime: runtime?.ok === true ? runtime.scan : EMPTY,
    };
    const page = buildLogPage({
      filter,
      cursor,
      limit: input.limit,
      maxBytes: deps.pageMaxBytes,
      scans,
      windowClamped: input.windowClamped,
    });
    return { ok: true, page, unavailable };
  } finally {
    opened.release();
  }
}
