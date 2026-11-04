// 27-04 (A1, A4): converts each source's rows into unified log entries. Every entry's text is
// redacted with the service's redactor, then sanitized (ANSI, CR, binary) and cut to
// LOG_LINE_MAX_LENGTH before anything filters or searches it (H2: search sees redacted text only).
import { DIAGNOSES, compareLogTimestamps, parseLogTimestamp, type Diagnosis, type LogLevel, type LogSource } from '@noodara/domain';
import { LOG_LINE_MAX_LENGTH, type LogEntryView } from '@noodara/domain/api-contract';
import { sanitizeLogText, type DeploymentLogPhase } from '@noodara/domain/deployment';
import type { Redactor } from '@noodara/domain/security';
import type { LogPosition } from './log-cursor.js';

/** An entry with its pagination position (`seq`), in its source's ascending order. */
export type PositionedEntry = LogEntryView & { readonly seq: number };

/** An entry before redaction and positioning. */
export interface RawEntry {
  readonly source: LogSource;
  readonly timestamp: string;
  readonly stream: 'stdout' | 'stderr' | null;
  readonly text: string;
  readonly level?: LogLevel;
  readonly truncated?: boolean;
}

const ERROR_WORDS = /\b(error|fatal|failed|failure|panic|exception)\b/i;
const WARN_WORDS = /\b(warn|warning|deprecated)\b/i;

/** A best-effort level for free-form lines: no source carries a structured level. */
export function inferLogLevel(text: string): LogLevel {
  if (ERROR_WORDS.test(text)) return 'error';
  if (WARN_WORDS.test(text)) return 'warn';
  return 'info';
}

/** Build-side phases are the `build` source; the rest of a deployment's output is `deploy`. */
export function sourceOfPhase(phase: DeploymentLogPhase): 'build' | 'deploy' {
  return phase === 'prepare' || phase === 'build' ? 'build' : 'deploy';
}

export interface ChunkRow {
  readonly phase: DeploymentLogPhase;
  readonly content: string;
  readonly createdAt: Date;
}

/** One entry per line of a stored chunk, stamped with the chunk's time. */
export function chunkEntries(chunk: ChunkRow): RawEntry[] {
  const lines = chunk.content.split('\n');
  if (lines.at(-1) === '') lines.pop();
  const timestamp = chunk.createdAt.toISOString();
  const source = sourceOfPhase(chunk.phase);
  return lines.map((text) => ({ source, timestamp, stream: null, text }));
}

export interface ActivityRow {
  readonly occurredAt: Date;
  readonly action: string;
  readonly outcome: 'success' | 'failure';
  readonly errorCode: string | null;
  readonly metadata?: unknown;
}

/** The collector's incident diagnosis (27-02), the only metadata value an entry may show. */
function observedState(metadata: unknown): Diagnosis | null {
  if (typeof metadata !== 'object' || metadata === null) return null;
  const value: unknown = (metadata as Record<string, unknown>).observedState;
  return DIAGNOSES.find((diagnosis) => diagnosis !== 'unknown' && diagnosis === value) ?? null;
}

/** Action, outcome and an allowlisted observedState only: other metadata never reaches an entry. */
export function activityEntry(row: ActivityRow): RawEntry {
  const failed = row.outcome === 'failure';
  const state = observedState(row.metadata);
  let text = failed ? `${row.action} failed${row.errorCode === null ? '' : ` (${row.errorCode})`}` : row.action;
  if (state !== null) text = `${text}: ${state}`;
  return {
    source: 'activity',
    timestamp: row.occurredAt.toISOString(),
    stream: null,
    text,
    level: failed ? 'error' : state !== null ? 'warn' : 'info',
  };
}

function cut(text: string): { text: string; truncated: boolean } {
  if (text.length <= LOG_LINE_MAX_LENGTH) return { text, truncated: false };
  let head = text.slice(0, LOG_LINE_MAX_LENGTH);
  const last = head.charCodeAt(head.length - 1);
  if (last >= 0xd800 && last <= 0xdbff) head = head.slice(0, -1);
  return { text: head, truncated: true };
}

/** Redacts, sanitizes and bounds one entry; the level is inferred from the redacted text. */
export function finalizeEntry(raw: RawEntry, redactor: Redactor): LogEntryView {
  const clean = sanitizeLogText(redactor.redact(raw.text)).replace(/\n/g, ' ');
  // Redact once more: sanitizing can join pieces of a value split by control characters.
  const bounded = cut(redactor.redact(clean));
  return {
    source: raw.source,
    timestamp: raw.timestamp,
    level: raw.level ?? inferLogLevel(bounded.text),
    stream: raw.stream,
    text: bounded.text,
    truncated: bounded.truncated || raw.truncated === true,
  };
}

/**
 * Sorts one source's entries ascending (stable) and numbers entries sharing an instant, so each
 * gets a position. Entries with an unparseable timestamp are dropped: they can never be paged.
 */
export function positionEntries(entries: readonly LogEntryView[]): PositionedEntry[] {
  const parsed = entries
    .map((entry, index) => ({ entry, at: parseLogTimestamp(entry.timestamp), index }))
    .filter((item): item is { entry: LogEntryView; at: NonNullable<typeof item.at>; index: number } => item.at !== null)
    .sort((a, b) => compareLogTimestamps(a.at, b.at) || a.index - b.index);
  const out: PositionedEntry[] = [];
  let seq = 0;
  parsed.forEach((item, i) => {
    const previous = parsed[i - 1];
    seq = previous !== undefined && compareLogTimestamps(previous.at, item.at) === 0 ? seq + 1 : 0;
    out.push({ ...item.entry, seq });
  });
  return out;
}

export function positionOf(entry: PositionedEntry): LogPosition {
  return { timestamp: entry.timestamp, source: entry.source, seq: entry.seq };
}

/** The wire view: the position stays server-side (it travels only inside the cursor). */
export function toView(entry: PositionedEntry): LogEntryView {
  return {
    source: entry.source,
    timestamp: entry.timestamp,
    level: entry.level,
    stream: entry.stream,
    text: entry.text,
    truncated: entry.truncated,
  };
}
