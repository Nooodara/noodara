// 30-02: typed client of the 27-04 unified logs routes.
// - getServiceLogs: one page (`GET .../logs/entries`), same transport as every other read.
// - followServiceLogs: the NDJSON follow stream (`.../logs/entries/follow`). One fetch per follow,
//   aborted by the caller's signal; the reader is cancelled on every exit, so closing the view
//   leaves no open stream. Frames are parsed defensively: a malformed or oversized frame is
//   skipped, never fatal. Line text is never logged.
import { LOG_SEARCH_MAX_LENGTH, LOG_SOURCES, type LogLevel, type LogSource } from '@noodara/domain';
import type { LogEntryView, LogPage } from '@noodara/domain/api-contract';
import {
  deployApiGet,
  networkFailure,
  toDeployApiFailure,
  type ApiFailure,
  type ApiResult,
  type DeployApiErrorCode,
} from '../api-client';

export type LogsFailure = ApiFailure<DeployApiErrorCode>;

export type { LogEntryView, LogLevel, LogSource };
export { LOG_SEARCH_MAX_LENGTH, LOG_SOURCES };

export interface ServiceLogsPage extends LogPage {
  readonly nextCursor: string | null;
  readonly truncated: boolean;
}

export interface LogsQuery {
  readonly sources: readonly LogSource[];
  readonly since?: string;
  readonly until?: string;
  readonly level?: LogLevel | null;
  readonly search?: string | null;
  readonly limit?: number;
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function entriesPath(projectId: string, serviceId: string): string | null {
  if (!UUID_PATTERN.test(projectId) || !UUID_PATTERN.test(serviceId)) return null;
  return `/api/projects/${encodeURIComponent(projectId)}/services/${encodeURIComponent(serviceId)}/logs/entries`;
}

/** Builds the query string; the search is cut to the server max so a long paste never 422s. */
export function logsQueryString(query: LogsQuery, follow = false): string {
  const params = new URLSearchParams();
  params.set('sources', query.sources.join(','));
  if (query.since !== undefined) params.set('since', query.since);
  if (!follow && query.until !== undefined) params.set('until', query.until);
  if (query.level !== undefined && query.level !== null) params.set('level', query.level);
  const search = query.search?.slice(0, LOG_SEARCH_MAX_LENGTH) ?? '';
  if (search !== '') params.set('search', search);
  if (!follow && query.limit !== undefined) params.set('limit', String(query.limit));
  return params.toString();
}

const INVALID_ID: LogsFailure = { ok: false, code: 'NOT_FOUND', message: 'Not found.', unauthorized: false };

export function getServiceLogs(
  projectId: string,
  serviceId: string,
  query: LogsQuery,
  signal?: AbortSignal,
): Promise<ApiResult<ServiceLogsPage, DeployApiErrorCode>> {
  const path = entriesPath(projectId, serviceId);
  if (path === null) return Promise.resolve(INVALID_ID);
  return deployApiGet<ServiceLogsPage>(`${path}?${logsQueryString(query)}`, signal === undefined ? {} : { signal });
}

// ---- follow -----------------------------------------------------------------------------------

/** Server-side end reasons (FollowEndReason in log-follow.ts). */
const END_REASONS = ['idle', 'max_duration', 'client_closed', 'shutdown'] as const;
export type LogFollowEndReason = (typeof END_REASONS)[number] | 'unknown';

/** A raw frame longer than this is dropped unparsed (an 8 KiB line escaped fits well inside). */
export const LOG_FOLLOW_MAX_FRAME_CHARS = 128 * 1024;
/** Client cap on one follow: the server's hard max lifetime (600 s) plus slack. */
export const LOG_FOLLOW_MAX_MS = 660_000;
export const LOG_FOLLOW_OPEN_TIMEOUT_MS = 15_000;

export type LogFollowResult =
  | { readonly ok: true; readonly reason: 'aborted' }
  | { readonly ok: true; readonly reason: 'server_end'; readonly serverReason: LogFollowEndReason }
  | LogsFailure;

export interface FollowServiceLogsOptions {
  readonly projectId: string;
  readonly serviceId: string;
  readonly query: LogsQuery;
  readonly signal: AbortSignal;
  readonly onEntries: (entries: readonly LogEntryView[]) => void;
  readonly onUnavailable?: (source: LogSource) => void;
  readonly openTimeoutMs?: number;
  readonly maxDurationMs?: number;
}

type Frame =
  | { readonly kind: 'entry'; readonly entry: LogEntryView }
  | { readonly kind: 'unavailable'; readonly source: LogSource }
  | { readonly kind: 'end'; readonly reason: LogFollowEndReason }
  | { readonly kind: 'skip' };

const LEVELS: readonly string[] = ['info', 'warn', 'error'];

function isSource(value: unknown): value is LogSource {
  return (LOG_SOURCES as readonly unknown[]).includes(value);
}

function toEntry(value: unknown): LogEntryView | null {
  if (typeof value !== 'object' || value === null) return null;
  const e = value as Record<string, unknown>;
  if (!isSource(e.source) || typeof e.timestamp !== 'string' || typeof e.text !== 'string') return null;
  if (typeof e.level !== 'string' || !LEVELS.includes(e.level)) return null;
  const stream = e.stream === 'stdout' || e.stream === 'stderr' ? e.stream : null;
  return {
    source: e.source,
    timestamp: e.timestamp,
    level: e.level as LogLevel,
    stream,
    text: e.text,
    truncated: e.truncated === true,
  };
}

export function parseFollowFrame(raw: string): Frame {
  let value: unknown;
  try {
    value = JSON.parse(raw) as unknown;
  } catch {
    return { kind: 'skip' };
  }
  if (typeof value !== 'object' || value === null) return { kind: 'skip' };
  const frame = value as Record<string, unknown>;
  if (frame.type === 'entry') {
    const entry = toEntry(frame.entry);
    return entry === null ? { kind: 'skip' } : { kind: 'entry', entry };
  }
  if (frame.type === 'unavailable') {
    return isSource(frame.source) ? { kind: 'unavailable', source: frame.source } : { kind: 'skip' };
  }
  if (frame.type === 'end') {
    const reason = (END_REASONS as readonly unknown[]).includes(frame.reason)
      ? (frame.reason as LogFollowEndReason)
      : 'unknown';
    return { kind: 'end', reason };
  }
  return { kind: 'skip' };
}

/** Splits decoded text into whole frames; an oversized frame is discarded up to its newline. */
export class FrameSplitter {
  private pending = '';
  private discarding = false;

  constructor(private readonly maxFrameChars: number = LOG_FOLLOW_MAX_FRAME_CHARS) {}

  push(chunk: string): string[] {
    const frames: string[] = [];
    let rest = chunk;
    for (;;) {
      const newline = rest.indexOf('\n');
      if (newline === -1) break;
      const piece = rest.slice(0, newline);
      rest = rest.slice(newline + 1);
      if (this.discarding) {
        this.discarding = false;
        continue;
      }
      const frame = this.pending + piece;
      this.pending = '';
      if (frame.length <= this.maxFrameChars && frame.trim() !== '') frames.push(frame);
    }
    if (!this.discarding) {
      this.pending += rest;
      if (this.pending.length > this.maxFrameChars) {
        this.pending = '';
        this.discarding = true;
      }
    }
    return frames;
  }

  flush(): string[] {
    const last = this.discarding ? '' : this.pending;
    this.pending = '';
    this.discarding = false;
    return last.trim() === '' ? [] : [last];
  }
}

/** Opens one follow. Settles once it is over; never rejects. */
export async function followServiceLogs(options: FollowServiceLogsOptions): Promise<LogFollowResult> {
  const base = entriesPath(options.projectId, options.serviceId);
  if (base === null) return INVALID_ID;
  if (options.signal.aborted) return { ok: true, reason: 'aborted' };

  const controller = new AbortController();
  let reader: ReadableStreamDefaultReader<Uint8Array> | null = null;
  let stopCause: 'caller' | 'timeout' | null = null;
  const stop = (cause: 'caller' | 'timeout'): void => {
    stopCause ??= cause;
    controller.abort();
    if (reader !== null) reader.cancel().catch(() => undefined);
  };
  const onAbort = (): void => {
    stop('caller');
  };
  options.signal.addEventListener('abort', onAbort);
  const openTimer = setTimeout(() => {
    stop('timeout');
  }, options.openTimeoutMs ?? LOG_FOLLOW_OPEN_TIMEOUT_MS);
  const maxTimer = setTimeout(() => {
    stop('timeout');
  }, options.maxDurationMs ?? LOG_FOLLOW_MAX_MS);
  const stopped = (): LogFollowResult | null =>
    stopCause === 'caller' ? { ok: true, reason: 'aborted' } : stopCause === 'timeout' ? networkFailure() : null;

  try {
    let response: Response;
    try {
      response = await fetch(`${base}/follow?${logsQueryString(options.query, true)}`, {
        method: 'GET',
        credentials: 'same-origin',
        headers: { Accept: 'application/x-ndjson' },
        signal: controller.signal,
      });
    } catch {
      return stopped() ?? networkFailure();
    } finally {
      clearTimeout(openTimer);
    }
    if (!response.ok) {
      try {
        return await toDeployApiFailure(response);
      } catch {
        return networkFailure();
      }
    }
    if (response.body === null) return networkFailure();

    const active = response.body.getReader();
    reader = active;
    if (stopped() !== null) active.cancel().catch(() => undefined);
    const splitter = new FrameSplitter();
    const decoder = new TextDecoder();
    try {
      for (;;) {
        let chunk: ReadableStreamReadResult<Uint8Array>;
        try {
          chunk = await active.read();
        } catch {
          return stopped() ?? networkFailure();
        }
        const halted = stopped();
        if (halted !== null) return halted;
        const frames = chunk.done
          ? [...splitter.push(decoder.decode()), ...splitter.flush()]
          : splitter.push(decoder.decode(chunk.value, { stream: true }));
        const batch: LogEntryView[] = [];
        let end: LogFollowEndReason | null = null;
        for (const raw of frames) {
          const frame = parseFollowFrame(raw);
          if (frame.kind === 'entry') batch.push(frame.entry);
          else if (frame.kind === 'unavailable') options.onUnavailable?.(frame.source);
          else if (frame.kind === 'end') {
            end = frame.reason;
            break;
          }
        }
        if (batch.length > 0) options.onEntries(batch);
        if (end !== null) return { ok: true, reason: 'server_end', serverReason: end };
        if (chunk.done) return networkFailure();
      }
    } finally {
      await active.cancel().catch(() => undefined);
      active.releaseLock();
    }
  } finally {
    clearTimeout(openTimer);
    clearTimeout(maxTimer);
    options.signal.removeEventListener('abort', onAbort);
  }
}
