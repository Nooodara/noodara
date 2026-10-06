// 13-05: reader for the runtime-log follow stream, `GET .../logs/follow` (NDJSON, 12-16). The
// server writes `{"type":"line",stream,timestamp,text}` frames and one closing
// `{"type":"end",reason}` frame. This client stays bounded whatever the server sends:
//
//   - one follow is one fetch, aborted by the caller's signal, an open timeout or a max duration;
//   - a frame split across reads is reassembled; a malformed frame is skipped, not fatal;
//   - an oversized frame is dropped without buffering it, a long `text` is truncated;
//   - the kept lines are a ring of at most `maxBufferedLines`;
//   - the reader is cancelled and released on every exit path (abort, end, error).
//
// Failures resolve, never reject: HTTP errors use api-client's parser (deploy vocabulary, so
// RUNTIME_LOG_FOLLOW_LIMIT_REACHED / RUNTIME_LOGS_FAILED / RUNTIME_LOGS_TIMEOUT stay typed), and a
// dropped connection is NETWORK_ERROR. Line text is never logged.
import {
  networkFailure,
  toDeployApiFailure,
  type ApiFailure,
  type DeployApiErrorCode,
} from "./api-client";
import { runtimeLogFollowPath, type RuntimeLogLine } from "./deploy-api";

/** Until the response headers arrive; same budget as every other API call. */
export const RUNTIME_LOG_OPEN_TIMEOUT_MS = 15_000;
/** Client cap on one follow: the server's default max (NOODARA_RUNTIME_LOG_FOLLOW_MAX_MS, 600s)
 *  plus slack, so a server that never ends its stream cannot hold the connection forever. */
export const RUNTIME_LOG_FOLLOW_MAX_MS = 660_000;
/** The server caps a line at 16 KiB; text past this many characters is cut client-side. */
export const RUNTIME_LOG_MAX_LINE_CHARS = 16_384;
/** A raw frame longer than this is dropped unparsed (escaped 16 KiB text fits well inside). */
export const RUNTIME_LOG_MAX_FRAME_CHARS = 256 * 1024;
/** Lines kept in memory; older ones are dropped first. */
export const RUNTIME_LOG_MAX_BUFFERED_LINES = 5_000;

/** Server-side end reasons (FollowEndReason in apps/control-plane/src/services/container-logs.ts). */
const SERVER_END_REASONS = [
  "max_duration",
  "client_closed",
  "container_exited",
  "output_limit",
  "connection_lost",
  "shutdown",
] as const;
export type RuntimeLogServerEndReason =
  (typeof SERVER_END_REASONS)[number] | "unknown";

export interface StreamedLogLine extends RuntimeLogLine {
  /** True when `text` was cut at `maxLineChars`. */
  readonly truncated: boolean;
}

export type RuntimeLogFollowEnd =
  /** The caller aborted. */
  | { readonly ok: true; readonly reason: "aborted" }
  /** The client-side max duration elapsed. */
  | { readonly ok: true; readonly reason: "max_duration" }
  /** The server sent its end frame. */
  | {
      readonly ok: true;
      readonly reason: "server_end";
      readonly serverReason: RuntimeLogServerEndReason;
    };

export type RuntimeLogFollowResult =
  RuntimeLogFollowEnd | ApiFailure<DeployApiErrorCode>;

export interface RuntimeLogFollowLimits {
  readonly openTimeoutMs: number;
  readonly maxDurationMs: number;
  readonly maxLineChars: number;
  readonly maxFrameChars: number;
  readonly maxBufferedLines: number;
}

const DEFAULT_LIMITS: RuntimeLogFollowLimits = Object.freeze({
  openTimeoutMs: RUNTIME_LOG_OPEN_TIMEOUT_MS,
  maxDurationMs: RUNTIME_LOG_FOLLOW_MAX_MS,
  maxLineChars: RUNTIME_LOG_MAX_LINE_CHARS,
  maxFrameChars: RUNTIME_LOG_MAX_FRAME_CHARS,
  maxBufferedLines: RUNTIME_LOG_MAX_BUFFERED_LINES,
});

export interface FollowRuntimeLogsOptions {
  readonly projectId: string;
  readonly serviceId: string;
  /** Lines of history before following (server default when omitted, 1-10000). */
  readonly tail?: number;
  /** The caller's AbortController signal: aborting ends the follow and releases the reader. */
  readonly signal?: AbortSignal;
  /** Called once per read with the lines it completed (already capped and truncated). */
  readonly onLines?: (lines: readonly StreamedLogLine[]) => void;
  readonly limits?: Partial<RuntimeLogFollowLimits>;
}

export interface RuntimeLogSnapshot {
  readonly lines: readonly StreamedLogLine[];
  /** Lines dropped from the front of the ring since the follow started. */
  readonly droppedLines: number;
  /** Frames skipped because they were malformed or oversized. */
  readonly skippedFrames: number;
}

export interface RuntimeLogFollow {
  /** Settles once the follow is over; never rejects. */
  readonly done: Promise<RuntimeLogFollowResult>;
  /** The lines kept so far (a copy). */
  snapshot(): RuntimeLogSnapshot;
}

/** Fixed-size ring of the most recent lines. */
class LineRing {
  private readonly items: StreamedLogLine[] = [];
  dropped = 0;

  constructor(private readonly capacity: number) {}

  push(line: StreamedLogLine): void {
    this.items.push(line);
    if (this.items.length > this.capacity) {
      this.items.shift();
      this.dropped += 1;
    }
  }

  toArray(): StreamedLogLine[] {
    return [...this.items];
  }
}

type ParsedFrame =
  | { readonly kind: "line"; readonly line: StreamedLogLine }
  | { readonly kind: "end"; readonly reason: RuntimeLogServerEndReason }
  | { readonly kind: "skip" };

function toServerEndReason(value: unknown): RuntimeLogServerEndReason {
  return typeof value === "string" &&
    (SERVER_END_REASONS as readonly string[]).includes(value)
    ? (value as RuntimeLogServerEndReason)
    : "unknown";
}

function parseFrame(raw: string, maxLineChars: number): ParsedFrame {
  let value: unknown;
  try {
    value = JSON.parse(raw) as unknown;
  } catch {
    return { kind: "skip" };
  }
  if (typeof value !== "object" || value === null) return { kind: "skip" };
  const frame = value as Record<string, unknown>;
  if (frame.type === "end")
    return { kind: "end", reason: toServerEndReason(frame.reason) };
  if (frame.type !== "line") return { kind: "skip" };
  const { stream, timestamp, text } = frame;
  if (stream !== "stdout" && stream !== "stderr") return { kind: "skip" };
  if (timestamp !== null && typeof timestamp !== "string")
    return { kind: "skip" };
  if (typeof text !== "string") return { kind: "skip" };
  const truncated = text.length > maxLineChars;
  return {
    kind: "line",
    line: {
      stream,
      timestamp,
      text: truncated ? text.slice(0, maxLineChars) : text,
      truncated,
    },
  };
}

/** Splits decoded text into complete frames, holding back a partial one and dropping any frame
 *  that grows past `maxFrameChars` (it is discarded up to its newline, never buffered whole). */
class FrameSplitter {
  private pending = "";
  private discarding = false;
  skipped = 0;

  constructor(private readonly maxFrameChars: number) {}

  push(chunk: string): string[] {
    const frames: string[] = [];
    let rest = chunk;
    for (;;) {
      const newline = rest.indexOf("\n");
      if (newline === -1) break;
      const piece = rest.slice(0, newline);
      rest = rest.slice(newline + 1);
      if (this.discarding) {
        this.discarding = false;
        continue;
      }
      const frame = this.pending + piece;
      this.pending = "";
      if (frame.length > this.maxFrameChars) {
        this.skipped += 1;
        continue;
      }
      if (frame.trim() !== "") frames.push(frame);
    }
    if (!this.discarding) {
      this.pending += rest;
      if (this.pending.length > this.maxFrameChars) {
        this.pending = "";
        this.discarding = true;
        this.skipped += 1;
      }
    }
    return frames;
  }

  /** The trailing frame once the body closes (a server that ends without a final newline). */
  flush(): string[] {
    const last = this.discarding ? "" : this.pending;
    this.pending = "";
    this.discarding = false;
    return last.trim() === "" ? [] : [last];
  }
}

/** Opens the follow stream for one service. */
export function followRuntimeLogs(
  options: FollowRuntimeLogsOptions,
): RuntimeLogFollow {
  const limits: RuntimeLogFollowLimits = {
    ...DEFAULT_LIMITS,
    ...options.limits,
  };
  const ring = new LineRing(limits.maxBufferedLines);
  const splitter = new FrameSplitter(limits.maxFrameChars);
  let malformed = 0;

  const snapshot = (): RuntimeLogSnapshot => ({
    lines: ring.toArray(),
    droppedLines: ring.dropped,
    skippedFrames: splitter.skipped + malformed,
  });

  const done = run().catch((): RuntimeLogFollowResult => networkFailure());
  return { done, snapshot };

  async function run(): Promise<RuntimeLogFollowResult> {
    const path = runtimeLogFollowPath(
      options.projectId,
      options.serviceId,
      options.tail,
    );
    if (path === null) {
      return {
        ok: false,
        code: "VALIDATION_FAILED",
        message: "This link is not valid.",
        unauthorized: false,
      };
    }

    const controller = new AbortController();
    let stopCause: "caller" | "open_timeout" | "max_duration" | null = null;
    let reader: ReadableStreamDefaultReader<Uint8Array> | null = null;
    const stop = (cause: "caller" | "open_timeout" | "max_duration"): void => {
      stopCause ??= cause;
      controller.abort();
      // A pending read resolves once the reader is cancelled, even if the body ignores the signal.
      if (reader !== null) reader.cancel().catch(() => undefined);
    };
    const onCallerAbort = (): void => {
      stop("caller");
    };
    if (options.signal?.aborted === true)
      return { ok: true, reason: "aborted" };
    options.signal?.addEventListener("abort", onCallerAbort);
    const openTimer = setTimeout(() => {
      stop("open_timeout");
    }, limits.openTimeoutMs);
    const maxTimer = setTimeout(() => {
      stop("max_duration");
    }, limits.maxDurationMs);

    const stoppedResult = (): RuntimeLogFollowResult | null => {
      if (stopCause === "caller") return { ok: true, reason: "aborted" };
      if (stopCause === "max_duration")
        return { ok: true, reason: "max_duration" };
      if (stopCause === "open_timeout") return networkFailure();
      return null;
    };

    try {
      let response: Response;
      try {
        response = await fetch(path, {
          method: "GET",
          credentials: "same-origin",
          headers: { Accept: "application/x-ndjson" },
          signal: controller.signal,
        });
      } catch {
        return stoppedResult() ?? networkFailure();
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
      if (response.body === null) {
        return {
          ok: false,
          code: "INTERNAL_ERROR",
          message: "Something went wrong. Try again.",
          unauthorized: false,
        };
      }

      const activeReader = response.body.getReader();
      reader = activeReader;
      // `stop` may have run while the headers were in flight, before there was a reader to cancel.
      if (stoppedResult() !== null)
        activeReader.cancel().catch(() => undefined);
      const decoder = new TextDecoder();
      try {
        for (;;) {
          let chunk: ReadableStreamReadResult<Uint8Array>;
          try {
            chunk = await activeReader.read();
          } catch {
            return stoppedResult() ?? networkFailure();
          }
          const stopped = stoppedResult();
          if (stopped !== null) return stopped;
          const frames = chunk.done
            ? [...splitter.push(decoder.decode()), ...splitter.flush()]
            : splitter.push(decoder.decode(chunk.value, { stream: true }));
          const batch: StreamedLogLine[] = [];
          let end: RuntimeLogServerEndReason | null = null;
          for (const raw of frames) {
            const frame = parseFrame(raw, limits.maxLineChars);
            if (frame.kind === "skip") {
              malformed += 1;
            } else if (frame.kind === "end") {
              end = frame.reason;
              break;
            } else {
              ring.push(frame.line);
              batch.push(frame.line);
            }
          }
          if (batch.length > 0)
            options.onLines?.(batch.slice(-limits.maxBufferedLines));
          if (end !== null)
            return { ok: true, reason: "server_end", serverReason: end };
          // The body closed without an end frame: the connection dropped mid-stream.
          if (chunk.done) return networkFailure();
        }
      } finally {
        // Releases the connection on every exit: end frame, abort, error or a dropped body.
        await activeReader.cancel().catch(() => undefined);
        activeReader.releaseLock();
      }
    } finally {
      clearTimeout(openTimer);
      clearTimeout(maxTimer);
      options.signal?.removeEventListener("abort", onCallerAbort);
    }
  }
}
