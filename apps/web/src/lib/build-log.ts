// 13-04: client-side build-log fold. Merges `GET /api/deployments/:id/logs` pages and SSE
// `deployment.log_chunk` events into one text, ordered by phase (prepare, build, deploy) then seq.
//
// - Only a contiguous prefix is shown. A chunk is next when it is the same phase with seq + 1, or
//   when a GET page linked it to the cursor (pages are authoritative: items follow `after` and
//   each other with no holes, which is the only way to learn that a phase ended).
// - Anything ahead of the cursor waits in a bounded buffer and asks for a resync with the exact
//   (phase, since) cursor; anything at or before the cursor is ignored (no replay), except a full
//   chunk that replaces a shown SSE chunk the server cut (`truncated`), in place.
// - Bounded (H1): shown text per phase is capped at the server's phase cap with a visible marker,
//   the buffer is capped, and a resync that makes no progress gives up after a few pages.
// - Inert (H2): chunk text is data. It is never parsed, sanitised or logged here.
//
// Pure: no I/O, no timers, no console. State is immutable; `foldBuildLog` returns a new one.
import {
  DEFAULT_LOG_CHUNKER_POLICY,
  DEPLOYMENT_LOG_PHASES,
  type DeploymentLogPhase,
} from '@noodara/domain/deployment';

export interface LogPosition {
  readonly phase: DeploymentLogPhase;
  readonly seq: number;
}

/** The resync cursor, ready for `GET /logs?phase=&since=`. */
export interface BuildLogResyncCursor {
  readonly phase: DeploymentLogPhase;
  readonly since: number;
}

/** Wire shape of an SSE `deployment.log_chunk` payload (validated at runtime here). */
export interface BuildLogChunkEventInput {
  readonly kind: 'event';
  readonly event: unknown;
}

/** One `GET /logs` response plus the cursor it was requested with. */
export interface BuildLogPageInput {
  readonly kind: 'page';
  readonly after: BuildLogResyncCursor;
  readonly items: readonly unknown[];
  readonly hasMore: boolean;
}

export type BuildLogInput = BuildLogChunkEventInput | BuildLogPageInput;

export interface BuildLogSegment {
  readonly phase: DeploymentLogPhase;
  readonly text: string;
  /** Set on a shown chunk the server cut; a full chunk with this key replaces it. */
  readonly replaceKey: string | null;
  /** Cursor just before the cut chunk: where a resync must start to fetch it in full. */
  readonly before: LogPosition | null;
  readonly marker: boolean;
}

interface PendingChunk {
  readonly phase: DeploymentLogPhase;
  readonly seq: number;
  readonly text: string;
  readonly partial: boolean;
}

export interface BuildLogLimits {
  /** Shown UTF-8 bytes per phase; the server's chunker cap by default. */
  readonly maxPhaseBytes: number;
  readonly maxPendingChunks: number;
  readonly maxPendingBytes: number;
  /** Shown cut chunks that stay replaceable; later ones are shown as cut. */
  readonly maxReplaceable: number;
  /** Pages in a row that make no progress before the resync gives up. */
  readonly maxResyncMisses: number;
}

export const DEFAULT_BUILD_LOG_LIMITS: BuildLogLimits = Object.freeze({
  maxPhaseBytes: DEFAULT_LOG_CHUNKER_POLICY.maxPhaseBytes,
  maxPendingChunks: 512,
  maxPendingBytes: 4 * 1024 * 1024,
  maxReplaceable: 256,
  maxResyncMisses: 3,
});

export interface BuildLogState {
  readonly deploymentId: string;
  readonly limits: BuildLogLimits;
  /** Last shown chunk; `seq: 0` in `prepare` before anything is shown. */
  readonly cursor: LogPosition;
  readonly segments: readonly BuildLogSegment[];
  readonly phaseBytes: Readonly<Record<DeploymentLogPhase, number>>;
  readonly cappedPhases: ReadonlySet<DeploymentLogPhase>;
  readonly pending: ReadonlyMap<string, PendingChunk>;
  readonly pendingBytes: number;
  /** Page links `prevKey -> nextKey` that cross a phase (or skip a seq). */
  readonly links: ReadonlyMap<string, string>;
  /** Last page said there is more after this position. */
  readonly moreAfter: LogPosition | null;
  /** Null when nothing is missing (or the resync gave up). */
  readonly resync: BuildLogResyncCursor | null;
  readonly resyncMisses: number;
  /** The resync made no progress `maxResyncMisses` pages in a row; it resumes on progress. */
  readonly stalled: boolean;
}

const START: LogPosition = Object.freeze({ phase: 'prepare', seq: 0 });
const MAX_SEQ = 2_147_483_647;
const PHASE_SET: ReadonlySet<string> = new Set(DEPLOYMENT_LOG_PHASES);
const MIB = 1024 * 1024;

function zeroBytes(): Record<DeploymentLogPhase, number> {
  return { prepare: 0, build: 0, deploy: 0 };
}

export function createBuildLogState(
  deploymentId: string,
  limits: Partial<BuildLogLimits> = {},
): BuildLogState {
  return {
    deploymentId,
    limits: { ...DEFAULT_BUILD_LOG_LIMITS, ...limits },
    cursor: START,
    segments: [],
    phaseBytes: zeroBytes(),
    cappedPhases: new Set(),
    pending: new Map(),
    pendingBytes: 0,
    links: new Map(),
    moreAfter: null,
    resync: null,
    resyncMisses: 0,
    stalled: false,
  };
}

/** The shown text, in order. */
export function buildLogText(state: BuildLogState): string {
  return state.segments.map((segment) => segment.text).join('');
}

// --- Positions and validation ---------------------------------------------------------------

function keyOf(position: LogPosition): string {
  return `${position.phase}:${String(position.seq)}`;
}

function compare(a: LogPosition, b: LogPosition): number {
  const byPhase = DEPLOYMENT_LOG_PHASES.indexOf(a.phase) - DEPLOYMENT_LOG_PHASES.indexOf(b.phase);
  return byPhase !== 0 ? byPhase : a.seq - b.seq;
}

function isPhase(value: unknown): value is DeploymentLogPhase {
  return typeof value === 'string' && PHASE_SET.has(value);
}

function isSeq(value: unknown, min: number): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= min && value <= MAX_SEQ;
}

function readRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : null;
}

/** A chunk from the wire, or null when malformed (unknown phase, bad seq, non-string text). */
function parseChunk(value: unknown, partial: boolean): PendingChunk | null {
  const record = readRecord(value);
  if (record === null) return null;
  const { phase, seq, text } = record;
  if (!isPhase(phase) || !isSeq(seq, 1) || typeof text !== 'string') return null;
  return { phase, seq, text, partial };
}

function parseCursor(value: unknown): LogPosition | null {
  const record = readRecord(value);
  if (record === null) return null;
  const { phase, since } = record;
  return isPhase(phase) && isSeq(since, 0) ? { phase, seq: since } : null;
}

function codePointBytes(code: number): number {
  if (code < 0x80) return 1;
  if (code < 0x800) return 2;
  if (code < 0x10000) return 3;
  return 4;
}

function utf8Length(text: string): number {
  let bytes = 0;
  for (const ch of text) bytes += codePointBytes(ch.codePointAt(0) ?? 0);
  return bytes;
}

function utf8Prefix(text: string, maxBytes: number): string {
  let bytes = 0;
  let units = 0;
  for (const ch of text) {
    const size = codePointBytes(ch.codePointAt(0) ?? 0);
    if (bytes + size > maxBytes) break;
    bytes += size;
    units += ch.length;
  }
  return text.slice(0, units);
}

function formatBytes(bytes: number): string {
  return bytes % MIB === 0 ? `${String(bytes / MIB)} MiB` : `${String(bytes)} bytes`;
}

/** Shown once per phase where its text was cut at `maxPhaseBytes`. */
export function buildLogCapMarker(phase: DeploymentLogPhase, maxPhaseBytes: number): string {
  return `\n[noodara] Build log for phase "${phase}" exceeds the ${formatBytes(maxPhaseBytes)} view limit; further output is hidden.\n`;
}

// --- Fold -------------------------------------------------------------------------------------

interface Draft {
  cursor: LogPosition;
  segments: BuildLogSegment[];
  phaseBytes: Record<DeploymentLogPhase, number>;
  cappedPhases: Set<DeploymentLogPhase>;
  pending: Map<string, PendingChunk>;
  pendingBytes: number;
  links: Map<string, string>;
  moreAfter: LogPosition | null;
  replaceable: number;
  progressed: boolean;
}

function toDraft(state: BuildLogState): Draft {
  return {
    cursor: state.cursor,
    segments: [...state.segments],
    phaseBytes: { ...state.phaseBytes },
    cappedPhases: new Set(state.cappedPhases),
    pending: new Map(state.pending),
    pendingBytes: state.pendingBytes,
    links: new Map(state.links),
    moreAfter: state.moreAfter,
    replaceable: state.segments.filter((segment) => segment.replaceKey !== null).length,
    progressed: false,
  };
}

function appendText(draft: Draft, phase: DeploymentLogPhase, text: string): void {
  if (text.length === 0) return;
  const last = draft.segments.at(-1);
  if (last?.replaceKey === null && !last.marker && last.phase === phase) {
    draft.segments[draft.segments.length - 1] = {
      ...last,
      text: last.text + text,
    };
    return;
  }
  draft.segments.push({
    phase,
    text,
    replaceKey: null,
    before: null,
    marker: false,
  });
}

/** Shows `chunk` right after the cursor, honouring the phase cap. */
function show(draft: Draft, chunk: PendingChunk, limits: BuildLogLimits): void {
  const before = draft.cursor;
  draft.cursor = { phase: chunk.phase, seq: chunk.seq };
  draft.progressed = true;
  if (draft.cappedPhases.has(chunk.phase)) return;
  const bytes = utf8Length(chunk.text);
  const remaining = limits.maxPhaseBytes - draft.phaseBytes[chunk.phase];
  if (bytes > remaining) {
    appendText(draft, chunk.phase, utf8Prefix(chunk.text, remaining));
    draft.phaseBytes[chunk.phase] = limits.maxPhaseBytes;
    draft.cappedPhases.add(chunk.phase);
    draft.segments.push({
      phase: chunk.phase,
      text: buildLogCapMarker(chunk.phase, limits.maxPhaseBytes),
      replaceKey: null,
      before: null,
      marker: true,
    });
    return;
  }
  draft.phaseBytes[chunk.phase] += bytes;
  if (chunk.partial && chunk.text.length > 0 && draft.replaceable < limits.maxReplaceable) {
    draft.replaceable += 1;
    draft.segments.push({
      phase: chunk.phase,
      text: chunk.text,
      replaceKey: keyOf(chunk),
      before,
      marker: false,
    });
    return;
  }
  appendText(draft, chunk.phase, chunk.text);
}

/** A full chunk at or before the cursor: replaces a shown cut chunk with the same key, if any. */
function replaceShown(draft: Draft, chunk: PendingChunk, limits: BuildLogLimits): void {
  if (chunk.partial) return;
  const key = keyOf(chunk);
  const index = draft.segments.findIndex((segment) => segment.replaceKey === key);
  const old = draft.segments[index];
  if (old === undefined) return;
  const delta = utf8Length(chunk.text) - utf8Length(old.text);
  draft.replaceable -= 1;
  draft.progressed = true;
  if (draft.phaseBytes[chunk.phase] + delta > limits.maxPhaseBytes) {
    // Pathological: the full text no longer fits the phase cap. Keep the cut text, stop asking.
    draft.segments[index] = { ...old, replaceKey: null, before: null };
    return;
  }
  draft.phaseBytes[chunk.phase] += delta;
  draft.segments[index] = {
    ...old,
    text: chunk.text,
    replaceKey: null,
    before: null,
  };
}

function removePending(draft: Draft, key: string): void {
  const entry = draft.pending.get(key);
  if (entry === undefined) return;
  draft.pending.delete(key);
  draft.pendingBytes -= utf8Length(entry.text);
}

/** Buffers a chunk ahead of the cursor; a full chunk wins over a cut one with the same key. */
function addPending(draft: Draft, chunk: PendingChunk): void {
  const key = keyOf(chunk);
  const existing = draft.pending.get(key);
  if (existing !== undefined && (chunk.partial || !existing.partial)) return;
  removePending(draft, key);
  draft.pending.set(key, chunk);
  draft.pendingBytes += utf8Length(chunk.text);
}

function accept(draft: Draft, chunk: PendingChunk, limits: BuildLogLimits): void {
  if (compare(chunk, draft.cursor) <= 0) {
    replaceShown(draft, chunk, limits);
    return;
  }
  addPending(draft, chunk);
}

function advance(draft: Draft, limits: BuildLogLimits): void {
  for (;;) {
    const cursorKey = keyOf(draft.cursor);
    const directKey = keyOf({
      phase: draft.cursor.phase,
      seq: draft.cursor.seq + 1,
    });
    const linkedKey = draft.links.get(cursorKey);
    const nextKey = draft.pending.has(directKey) ? directKey : linkedKey;
    const next = nextKey === undefined ? undefined : draft.pending.get(nextKey);
    if (nextKey === undefined || next === undefined) return;
    removePending(draft, nextKey);
    draft.links.delete(cursorKey);
    show(draft, next, limits);
  }
}

/** Drops what the cursor passed and evicts the furthest chunks past the buffer caps. */
function compact(draft: Draft, limits: BuildLogLimits): void {
  for (const [key, chunk] of draft.pending) {
    if (compare(chunk, draft.cursor) <= 0) removePending(draft, key);
  }
  if (draft.pending.size > limits.maxPendingChunks || draft.pendingBytes > limits.maxPendingBytes) {
    const ordered = [...draft.pending.values()].sort((a, b) => compare(b, a));
    for (const chunk of ordered) {
      if (
        draft.pending.size <= limits.maxPendingChunks &&
        draft.pendingBytes <= limits.maxPendingBytes
      )
        break;
      removePending(draft, keyOf(chunk));
    }
  }
  for (const [prev, next] of draft.links) {
    if (!draft.pending.has(next)) draft.links.delete(prev);
  }
}

function foldEvent(
  draft: Draft,
  deploymentId: string,
  event: unknown,
  limits: BuildLogLimits,
): void {
  const record = readRecord(event);
  if (record?.type !== 'deployment.log_chunk' || record.deploymentId !== deploymentId) return;
  const chunk = parseChunk(record, record.truncated === true);
  if (chunk !== null) accept(draft, chunk, limits);
}

function foldPage(draft: Draft, page: BuildLogPageInput, limits: BuildLogLimits): void {
  let prev = parseCursor(page.after);
  let last: LogPosition | null = prev;
  const items = Array.isArray(page.items) ? page.items : [];
  for (const item of items) {
    const chunk = parseChunk(item, false);
    if (chunk === null) {
      prev = null;
      continue;
    }
    const isSuccessor = prev !== null && prev.phase === chunk.phase && prev.seq + 1 === chunk.seq;
    if (
      prev !== null &&
      !isSuccessor &&
      compare(prev, chunk) < 0 &&
      compare(chunk, draft.cursor) > 0
    ) {
      draft.links.set(keyOf(prev), keyOf(chunk));
    }
    accept(draft, chunk, limits);
    prev = chunk;
    last = chunk;
  }
  if (last !== null && (draft.moreAfter === null || compare(last, draft.moreAfter) >= 0)) {
    const hasMore: unknown = page.hasMore;
    draft.moreAfter = hasMore === true ? { phase: last.phase, seq: last.seq } : null;
  }
}

function resyncCursor(draft: Draft): BuildLogResyncCursor | null {
  const cut = draft.segments.find((segment) => segment.before !== null)?.before ?? null;
  if (cut !== null) return { phase: cut.phase, since: cut.seq };
  const atFrontier = draft.moreAfter !== null && compare(draft.moreAfter, draft.cursor) === 0;
  if (draft.pending.size > 0 || atFrontier)
    return { phase: draft.cursor.phase, since: draft.cursor.seq };
  return null;
}

/**
 * Folds one GET page or SSE `deployment.log_chunk` payload into the state. Malformed input is
 * dropped; this never throws on wire data.
 */
export function foldBuildLog(state: BuildLogState, input: BuildLogInput): BuildLogState {
  const { limits } = state;
  const draft = toDraft(state);
  // `kind` comes from the caller but is checked anyway: unknown input leaves the state as is.
  const kind: unknown = input.kind;
  const isPage = kind === 'page';
  if (isPage) foldPage(draft, input as BuildLogPageInput, limits);
  else if (kind === 'event')
    foldEvent(draft, state.deploymentId, (input as BuildLogChunkEventInput).event, limits);
  else return state;
  advance(draft, limits);
  compact(draft, limits);

  let misses = draft.progressed ? 0 : state.resyncMisses;
  if (isPage && !draft.progressed && state.resync !== null) misses += 1;
  const wanted = resyncCursor(draft);
  const stalled = wanted !== null && misses >= limits.maxResyncMisses;

  return {
    deploymentId: state.deploymentId,
    limits,
    cursor: draft.cursor,
    segments: draft.segments,
    phaseBytes: draft.phaseBytes,
    cappedPhases: draft.cappedPhases,
    pending: draft.pending,
    pendingBytes: draft.pendingBytes,
    links: draft.links,
    moreAfter: draft.moreAfter,
    resync: stalled ? null : wanted,
    resyncMisses: misses,
    stalled,
  };
}
