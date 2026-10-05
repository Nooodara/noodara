// Build-log chunker (ROADMAP LOG-01/LOG-02; SUMMARY defaults: flush 250 ms / 16 KB, 16 KB per
// line, 10 MiB per phase). The deploy worker pushes redacted stream text per phase; the chunker
// groups it into chunks that are persisted append-only and broadcast as `deployment.log_chunk`.
//
// - A chunk is emitted when its oldest byte is `flushIntervalMs` old (checked on `push` and
//   `tick`, against the injected clock) or when it reaches `flushBytes`.
// - Every chunk carries a `seq` that starts at 1 and increases by one per deployment and phase.
// - A line longer than `maxLineBytes` is cut on a UTF-8 character boundary and ends with
//   `LOG_LINE_TRUNCATED_MARKER`, still within `maxLineBytes`; the rest of that line is dropped.
// - Once a phase has emitted `maxPhaseBytes` it stops accepting output and emits one
//   `phase_truncated` notice chunk.
//
// Pure: no I/O and no timers. The caller owns the timer and uses `msUntilNextFlush()` to schedule
// `tick()`, and calls `flush()` when a phase or the deployment ends.

import {
  assertDefined,
  fail,
  ok,
  type ValidationResult,
} from "../validators/network.js";
import {
  DEPLOYMENT_LOG_PHASES,
  type DeploymentLogPhase,
} from "./deployment-state.js";

export interface LogChunkerPolicy {
  readonly flushIntervalMs: number;
  readonly flushBytes: number;
  readonly maxLineBytes: number;
  readonly maxPhaseBytes: number;
}

export const DEFAULT_LOG_CHUNKER_POLICY: LogChunkerPolicy = Object.freeze({
  flushIntervalMs: 250,
  flushBytes: 16_384,
  maxLineBytes: 16_384,
  maxPhaseBytes: 10 * 1024 * 1024,
});

/** Appended to a line cut at `maxLineBytes`. ASCII, so its UTF-16 length equals its byte length. */
export const LOG_LINE_TRUNCATED_MARKER = " [line truncated]";

const MARKER_BYTES = LOG_LINE_TRUNCATED_MARKER.length;
const MIB = 1024 * 1024;
const FLUSH_INTERVAL_RANGE = [50, 5000] as const;
const MIN_BYTES = 1024;
const MAX_LINE_BYTES = MIB;
const MAX_PHASE_BYTES = 100 * MIB;

function isInt(value: number, min: number, max: number): boolean {
  return Number.isInteger(value) && value >= min && value <= max;
}

export function createLogChunkerPolicy(
  input: LogChunkerPolicy,
): ValidationResult<LogChunkerPolicy> {
  const { flushIntervalMs, flushBytes, maxLineBytes, maxPhaseBytes } = input;
  if (
    !isInt(flushIntervalMs, FLUSH_INTERVAL_RANGE[0], FLUSH_INTERVAL_RANGE[1]) ||
    !isInt(maxLineBytes, MIN_BYTES, MAX_LINE_BYTES) ||
    !isInt(flushBytes, MIN_BYTES, maxLineBytes) ||
    !isInt(maxPhaseBytes, maxLineBytes, MAX_PHASE_BYTES)
  ) {
    return fail(
      "LOG_CHUNKER_POLICY_INVALID",
      `Log chunker needs a ${String(FLUSH_INTERVAL_RANGE[0])}-${String(FLUSH_INTERVAL_RANGE[1])} ms flush interval, a line cap of ${String(MIN_BYTES)} bytes to 1 MiB, a flush size of ${String(MIN_BYTES)} bytes up to the line cap, and a phase cap from the line cap up to 100 MiB`,
    );
  }
  return ok({ flushIntervalMs, flushBytes, maxLineBytes, maxPhaseBytes });
}

export interface BuildLogChunk {
  readonly deploymentId: string;
  readonly phase: DeploymentLogPhase;
  /** 1-based, contiguous per deployment and phase. */
  readonly seq: number;
  /** `phase_truncated` is the single notice emitted when the phase hits `maxPhaseBytes`. */
  readonly kind: "output" | "phase_truncated";
  readonly text: string;
  /** UTF-8 byte length of `text`. */
  readonly byteLength: number;
  /** A line in this chunk was cut at `maxLineBytes`, or this is the phase truncation notice. */
  readonly truncated: boolean;
}

export interface BuildLogChunker {
  /** Accepts redacted text for a phase; returns the chunks that became due. */
  push(phase: DeploymentLogPhase, text: string): readonly BuildLogChunk[];
  /** Emits the chunks whose flush interval elapsed. */
  tick(): readonly BuildLogChunk[];
  /** Emits everything pending for one phase (or all, in phase order), ending a partial line. */
  flush(phase?: DeploymentLogPhase): readonly BuildLogChunk[];
  /** Milliseconds until `tick()` has something to emit, or null when nothing is pending. */
  msUntilNextFlush(): number | null;
}

export interface BuildLogChunkerOptions {
  readonly deploymentId: string;
  readonly now: () => number;
  readonly policy?: LogChunkerPolicy;
}

interface PhaseState {
  readonly phase: DeploymentLogPhase;
  nextSeq: number;
  /** Committed text not yet emitted. */
  pending: string[];
  pendingBytes: number;
  pendingTruncated: boolean;
  pendingSince: number;
  /** Bytes of the current line already committed. */
  lineBytes: number;
  /** Tail of the current line past the marker budget; committed only if the line fits the cap. */
  held: string;
  heldBytes: number;
  /** The current line was cut; drop input until its newline. */
  dropping: boolean;
  /** The last committed character was a newline (or nothing was committed yet). */
  atLineStart: boolean;
  phaseBytes: number;
  capped: boolean;
}

function codePointBytes(code: number): number {
  if (code < 0x80) return 1;
  if (code < 0x800) return 2;
  // Lone surrogates encode as U+FFFD (3 bytes), the same as any other BMP code point.
  if (code < 0x10000) return 3;
  return 4;
}

function utf8Length(text: string): number {
  let bytes = 0;
  for (const ch of text)
    bytes += codePointBytes(assertDefined(ch.codePointAt(0)));
  return bytes;
}

/** Longest prefix of `text` within `maxBytes` UTF-8 bytes that never splits a code point. */
function utf8Prefix(
  text: string,
  maxBytes: number,
): { readonly text: string; readonly bytes: number } {
  let bytes = 0;
  let units = 0;
  for (const ch of text) {
    const size = codePointBytes(assertDefined(ch.codePointAt(0)));
    if (bytes + size > maxBytes) break;
    bytes += size;
    units += ch.length;
  }
  return { text: text.slice(0, units), bytes };
}

function formatBytes(bytes: number): string {
  return bytes % MIB === 0
    ? `${String(bytes / MIB)} MiB`
    : `${String(bytes)} bytes`;
}

export function createBuildLogChunker(
  options: BuildLogChunkerOptions,
): BuildLogChunker {
  const { deploymentId, now } = options;
  if (deploymentId.length === 0) {
    throw new RangeError("Build log chunker requires a deploymentId");
  }
  const validated = createLogChunkerPolicy(
    options.policy ?? DEFAULT_LOG_CHUNKER_POLICY,
  );
  if (!validated.ok) {
    throw new RangeError(validated.message);
  }
  const policy = validated.value;
  const lineBudget = policy.maxLineBytes - MARKER_BYTES;
  const phases = new Map<DeploymentLogPhase, PhaseState>();

  function stateFor(phase: DeploymentLogPhase): PhaseState {
    if (!DEPLOYMENT_LOG_PHASES.includes(phase)) {
      throw new RangeError("Build log chunker requires a known phase");
    }
    let state = phases.get(phase);
    if (state === undefined) {
      state = {
        phase,
        nextSeq: 1,
        pending: [],
        pendingBytes: 0,
        pendingTruncated: false,
        pendingSince: 0,
        lineBytes: 0,
        held: "",
        heldBytes: 0,
        dropping: false,
        atLineStart: true,
        phaseBytes: 0,
        capped: false,
      };
      phases.set(phase, state);
    }
    return state;
  }

  function emit(
    state: PhaseState,
    out: BuildLogChunk[],
    kind: BuildLogChunk["kind"],
    text: string,
    byteLength: number,
    truncated: boolean,
  ): void {
    out.push({
      deploymentId,
      phase: state.phase,
      seq: state.nextSeq,
      kind,
      text,
      byteLength,
      truncated,
    });
    state.nextSeq += 1;
  }

  function emitPending(state: PhaseState, out: BuildLogChunk[]): void {
    if (state.pendingBytes === 0) return;
    emit(
      state,
      out,
      "output",
      state.pending.join(""),
      state.pendingBytes,
      state.pendingTruncated,
    );
    state.pending = [];
    state.pendingBytes = 0;
    state.pendingTruncated = false;
  }

  function addPending(
    state: PhaseState,
    text: string,
    bytes: number,
    truncated: boolean,
  ): void {
    if (state.pendingBytes === 0) state.pendingSince = now();
    if (truncated) state.pendingTruncated = true;
    state.pending.push(text);
    state.pendingBytes += bytes;
    state.phaseBytes += bytes;
    state.atLineStart = text.endsWith("\n");
  }

  function capPhase(state: PhaseState, out: BuildLogChunk[]): void {
    state.capped = true;
    state.held = "";
    state.heldBytes = 0;
    emitPending(state, out);
    const notice = `${state.atLineStart ? "" : "\n"}[noodara] Build log for phase "${state.phase}" reached the ${formatBytes(policy.maxPhaseBytes)} limit; further output was dropped.\n`;
    emit(state, out, "phase_truncated", notice, notice.length, true);
  }

  /** Moves text into the pending chunk, honouring the phase cap and the flush size. */
  function commit(
    state: PhaseState,
    text: string,
    bytes: number,
    out: BuildLogChunk[],
    truncated = false,
  ): void {
    if (state.capped || bytes === 0) return;
    const remaining = policy.maxPhaseBytes - state.phaseBytes;
    if (bytes > remaining) {
      const head = utf8Prefix(text, remaining);
      if (head.bytes > 0) addPending(state, head.text, head.bytes, truncated);
      capPhase(state, out);
      return;
    }
    if (state.pendingBytes + bytes > policy.flushBytes) emitPending(state, out);
    addPending(state, text, bytes, truncated);
    if (state.pendingBytes >= policy.flushBytes) emitPending(state, out);
  }

  function appendToLine(
    state: PhaseState,
    segment: string,
    out: BuildLogChunk[],
  ): void {
    if (state.dropping) return;
    const combined = state.held + segment;
    const combinedBytes = state.heldBytes + utf8Length(segment);
    const lineTotal = state.lineBytes + combinedBytes;
    if (lineTotal <= lineBudget) {
      state.held = "";
      state.heldBytes = 0;
      state.lineBytes = lineTotal;
      commit(state, combined, combinedBytes, out);
      return;
    }
    const head = utf8Prefix(
      combined,
      Math.max(0, lineBudget - state.lineBytes),
    );
    commit(state, head.text, head.bytes, out);
    state.lineBytes += head.bytes;
    if (lineTotal <= policy.maxLineBytes) {
      // Might still fit the cap untruncated: hold the tail until the line ends or grows.
      state.held = combined.slice(head.text.length);
      state.heldBytes = combinedBytes - head.bytes;
      return;
    }
    state.held = "";
    state.heldBytes = 0;
    state.dropping = true;
    commit(state, LOG_LINE_TRUNCATED_MARKER, MARKER_BYTES, out, true);
  }

  function endLine(state: PhaseState, out: BuildLogChunk[]): void {
    commit(state, state.held, state.heldBytes, out);
    commit(state, "\n", 1, out);
    state.held = "";
    state.heldBytes = 0;
    state.lineBytes = 0;
    state.dropping = false;
  }

  function isDue(state: PhaseState, at: number): boolean {
    if (state.pendingBytes === 0) return false;
    // A clock that moved backwards restarts the interval rather than stalling the flush forever.
    if (at < state.pendingSince) state.pendingSince = at;
    return at - state.pendingSince >= policy.flushIntervalMs;
  }

  function orderedStates(): PhaseState[] {
    return DEPLOYMENT_LOG_PHASES.flatMap((phase) => {
      const state = phases.get(phase);
      return state === undefined ? [] : [state];
    });
  }

  function flushState(state: PhaseState, out: BuildLogChunk[]): void {
    if (state.capped) return;
    // A partial line (held tail included: it only exists mid-line) is ended so the next push to
    // this phase starts a fresh line and the per-line cap keeps holding.
    if (!state.atLineStart) endLine(state, out);
    emitPending(state, out);
  }

  return {
    push(phase, text) {
      const state = stateFor(phase);
      const out: BuildLogChunk[] = [];
      const segments = text.split("\n");
      for (const [index, segment] of segments.entries()) {
        if (state.capped) break;
        if (segment.length > 0) appendToLine(state, segment, out);
        if (index < segments.length - 1) endLine(state, out);
      }
      if (isDue(state, now())) emitPending(state, out);
      return out;
    },

    tick() {
      const out: BuildLogChunk[] = [];
      const at = now();
      for (const state of orderedStates()) {
        if (isDue(state, at)) emitPending(state, out);
      }
      return out;
    },

    flush(phase) {
      const out: BuildLogChunk[] = [];
      if (phase === undefined) {
        for (const state of orderedStates()) flushState(state, out);
      } else {
        flushState(stateFor(phase), out);
      }
      return out;
    },

    msUntilNextFlush() {
      const at = now();
      let soonest: number | null = null;
      for (const state of phases.values()) {
        if (state.pendingBytes === 0) continue;
        const elapsed = Math.max(0, at - state.pendingSince);
        const wait = Math.max(0, policy.flushIntervalMs - elapsed);
        soonest = soonest === null ? wait : Math.min(soonest, wait);
      }
      return soonest;
    },
  };
}
