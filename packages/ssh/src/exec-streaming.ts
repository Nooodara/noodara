// Streaming exec for long deploy operations (11-14, ROADMAP criterion 4, T-11-39/40/42). Sibling of
// exec-with-timeout.ts: same structural channel typing and single-settle discipline, but output is
// delivered incrementally as line-oriented chunks instead of being buffered to the end.
//
// Redaction works on complete lines: bytes are buffered per stream until a newline, so a secret
// split across data events is whole again before `redactor.redact` sees it. Multi-line secrets are
// registered line by line (registerSecretForStreaming). Closing the channel never stops the remote
// process (ADR 0008 G2): timeouts and aborts only stop reading; the caller kills the group.
import { revealSecret, type Redactor } from "@noodara/domain/security";
import { renderRemoteCommand, type RemoteCommand } from "./commands/index.js";
import { TransportClosedError } from "./errors.js";
import type { ExecChannel } from "./exec-with-timeout.js";
import type { StreamChunk, StreamOptions, StreamResult } from "./ssh-port.js";

/** 16 KiB per line (research "Numbers That Are Reasoned Defaults"; kept after the 11-14 run). */
export const DEFAULT_MAX_LINE_BYTES = 16_384;
/** Redacted output kept per stream for the error classifiers. */
export const DEFAULT_TAIL_BYTES = 8_192;
/**
 * Raw bytes kept past `maxLineBytes` before an over-long line is redacted and cut, so a registered
 * secret (or line of one) up to this size straddling the cut is still matched whole.
 */
export const REDACTION_LOOKAHEAD_BYTES = 4_096;
/** Shorter lines of a multi-line secret are not registered on their own (too many false hits). */
const MIN_SECRET_LINE_LENGTH = 8;
const NEWLINE = 0x0a;

/** exec-with-timeout's channel plus the stdin half (ssh2 `ClientChannel` satisfies it). */
export interface StreamChannel extends ExecChannel {
  write(data: string | Buffer): boolean;
  end(): void;
}

export interface ExecStreamingInput {
  readonly client: {
    exec(
      command: string,
      callback: (err: Error | undefined, channel: StreamChannel) => void,
    ): void;
  };
  readonly command: RemoteCommand;
  readonly options: StreamOptions;
  readonly redactor: Redactor;
}

/**
 * Registers `value` and every line of it of at least 8 characters, so a multi-line secret (a PEM
 * key) printed line by line is still redacted per line. Returns a function that releases exactly
 * what was registered.
 */
export function registerSecretForStreaming(
  redactor: Redactor,
  value: string,
  type: string,
): () => void {
  const registered = new Set<string>();
  if (value.length > 0) registered.add(value);
  for (const line of value.split(/\r?\n/)) {
    if (line.length >= MIN_SECRET_LINE_LENGTH) registered.add(line);
  }
  for (const entry of registered) redactor.register(entry, type);
  let released = false;
  return () => {
    // Idempotent: a second call must not decrement a registration another holder owns.
    if (released) return;
    released = true;
    for (const entry of registered) redactor.release(entry);
  };
}

/** Largest prefix length <= `end` that does not split a UTF-8 sequence. */
function utf8SafeEnd(buf: Buffer, end: number): number {
  let cut = Math.min(end, buf.length);
  while (
    cut > 0 &&
    cut < buf.length &&
    ((buf[cut] ?? 0) & 0b1100_0000) === 0b1000_0000
  )
    cut -= 1;
  return cut;
}

/** Last `maxBytes` of `buf`, starting on a character boundary. */
function utf8SafeTail(buf: Buffer, maxBytes: number): Buffer {
  if (buf.length <= maxBytes) return buf;
  let start = buf.length - maxBytes;
  while (
    start < buf.length &&
    ((buf[start] ?? 0) & 0b1100_0000) === 0b1000_0000
  )
    start += 1;
  return buf.subarray(start);
}

interface RawLine {
  readonly text: string;
  readonly newline: boolean;
  readonly windowed: boolean;
}

interface StreamState {
  readonly name: StreamChunk["stream"];
  pending: Buffer[];
  pendingBytes: number;
  /** Dropping the rest of a line that was already cut and delivered. */
  discarding: boolean;
  tail: Buffer;
}

function newState(name: StreamChunk["stream"]): StreamState {
  return {
    name,
    pending: [],
    pendingBytes: 0,
    discarding: false,
    tail: Buffer.alloc(0),
  };
}

function assertPositiveInteger(name: string, value: number): void {
  if (!Number.isInteger(value) || value <= 0) {
    throw new RangeError(`${name} must be a positive integer`);
  }
}

function validate(command: RemoteCommand, options: StreamOptions): void {
  assertPositiveInteger("maxDurationMs", options.maxDurationMs);
  assertPositiveInteger("idleTimeoutMs", options.idleTimeoutMs);
  assertPositiveInteger("maxTotalBytes", options.maxTotalBytes);
  assertPositiveInteger("maxLineBytes", options.maxLineBytes);
  // Usage errors are RangeError/TypeError so the adapter can pass them through unclassified.
  if (command.stdin === "secret" && options.stdin === undefined) {
    throw new TypeError(
      `${command.name} reads a secret from stdin; options.stdin is required`,
    );
  }
  if (command.stdin === "none" && options.stdin !== undefined) {
    throw new TypeError(
      `${command.name} takes no stdin; refusing to send a secret to it`,
    );
  }
}

/**
 * Runs one `RemoteCommand` and streams its output. Resolves (never rejects) for every outcome of a
 * channel that opened: completed, timed_out, idle_timeout, aborted. Rejects only for a usage error
 * (before any channel is opened), a channel that could not be opened, or a channel 'error'
 * (`TransportClosedError`).
 */
export function execStreaming(
  input: ExecStreamingInput,
): Promise<StreamResult> {
  const { client, command, options, redactor } = input;
  try {
    validate(command, options);
  } catch (error) {
    return Promise.reject(
      error instanceof Error ? error : new Error(String(error)),
    );
  }
  const {
    maxDurationMs,
    idleTimeoutMs,
    maxTotalBytes,
    maxLineBytes,
    signal,
    onChunk,
  } = options;
  const lineLimit = maxLineBytes + REDACTION_LOOKAHEAD_BYTES;

  // Revealed once and registered before any output can arrive. The registration is reference
  // counted, so the release below (after the final flush, exactly once) only drops our own hold.
  const stdinPlaintext =
    options.stdin === undefined ? undefined : revealSecret(options.stdin);
  const releaseStdin =
    stdinPlaintext !== undefined && options.stdin !== undefined
      ? registerSecretForStreaming(redactor, stdinPlaintext, options.stdin.kind)
      : undefined;
  /** Never throws: a failing release must not crash the worker or change the stream outcome. */
  function releaseStdinSecrets(): void {
    try {
      releaseStdin?.();
    } catch {
      // Swallowed on purpose; the error could carry nothing safe to log.
    }
  }

  const startedAt = performance.now();
  const stdout = newState("stdout");
  const stderr = newState("stderr");
  let seq = 0;
  let totalBytes = 0;
  let deliveredBytes = 0;
  let capReached = false;
  let truncated = false;

  const result = (
    outcome: StreamResult["outcome"],
    exitCode: number | null,
    exitSignal: string | null,
  ): StreamResult => ({
    commandName: command.name,
    outcome,
    exitCode,
    exitSignal,
    durationMs: performance.now() - startedAt,
    totalBytes,
    truncated,
    stdoutTail: stdout.tail.toString("utf8"),
    stderrTail: stderr.tail.toString("utf8"),
  });

  if (signal?.aborted === true) {
    releaseStdinSecrets();
    return Promise.resolve(result("aborted", null, null));
  }

  /** A raw line cut to the redaction window (bounds redaction cost and memory). */
  function rawLine(content: Buffer, newline: boolean): RawLine {
    if (content.length <= lineLimit)
      return { text: content.toString("utf8"), newline, windowed: false };
    return {
      text: content
        .subarray(0, utf8SafeEnd(content, lineLimit))
        .toString("utf8"),
      newline,
      windowed: true,
    };
  }

  function takePending(state: StreamState, extra?: Buffer): Buffer {
    const content = Buffer.concat(
      extra === undefined ? state.pending : [...state.pending, extra],
    );
    state.pending = [];
    state.pendingBytes = 0;
    return content;
  }

  function safeOnChunk(chunk: StreamChunk): void {
    try {
      onChunk(chunk);
    } catch {
      // A consumer bug must not break the stream or crash the process from an ssh2 event.
    }
  }

  /** Redacts the group as one string, re-applies the line cap on redacted text, delivers. */
  function deliver(state: StreamState, lines: readonly RawLine[]): void {
    if (lines.length === 0) return;
    const joined = lines
      .map((line) => (line.newline ? `${line.text}\n` : line.text))
      .join("");
    const redacted = redactor.redact(joined);
    let cut = lines.some((line) => line.windowed);
    const capped: string[] = [];
    for (const line of redacted.match(/[^\n]*\n|[^\n]+$/g) ?? []) {
      const hasNewline = line.endsWith("\n");
      const body = Buffer.from(hasNewline ? line.slice(0, -1) : line, "utf8");
      if (body.length > maxLineBytes) {
        cut = true;
        const kept = body
          .subarray(0, utf8SafeEnd(body, maxLineBytes))
          .toString("utf8");
        capped.push(hasNewline ? `${kept}\n` : kept);
      } else {
        capped.push(line);
      }
    }
    if (cut) truncated = true;

    const text = capped.join("");
    state.tail = utf8SafeTail(
      Buffer.concat([state.tail, Buffer.from(text, "utf8")]),
      DEFAULT_TAIL_BYTES,
    );

    if (capReached) return;
    let deliveredText = "";
    for (const line of capped) {
      const size = Buffer.byteLength(line, "utf8");
      if (deliveredBytes + size > maxTotalBytes) {
        capReached = true;
        truncated = true;
        break;
      }
      deliveredBytes += size;
      deliveredText += line;
    }
    if (deliveredText.length > 0) {
      safeOnChunk({
        stream: state.name,
        text: deliveredText,
        seq,
        truncatedLine: cut,
      });
      seq += 1;
    }
  }

  function onData(state: StreamState, buf: Buffer): void {
    totalBytes += buf.length;
    const lines: RawLine[] = [];
    let offset = 0;
    for (
      let nl = buf.indexOf(NEWLINE, offset);
      nl !== -1;
      nl = buf.indexOf(NEWLINE, offset)
    ) {
      const piece = buf.subarray(offset, nl);
      offset = nl + 1;
      if (state.discarding) {
        state.discarding = false;
        continue;
      }
      lines.push(rawLine(takePending(state, piece), true));
    }
    const rest = buf.subarray(offset);
    if (!state.discarding && rest.length > 0) {
      state.pending.push(rest);
      state.pendingBytes += rest.length;
      if (state.pendingBytes > lineLimit) {
        // The line can never fit: deliver its cut start now and drop the rest until a newline.
        lines.push(rawLine(takePending(state), true));
        state.discarding = true;
      }
    }
    deliver(state, lines);
  }

  function flush(state: StreamState): void {
    if (state.discarding || state.pendingBytes === 0) return;
    deliver(state, [rawLine(takePending(state), false)]);
  }

  return new Promise<StreamResult>((resolve, reject) => {
    let settled = false;
    let channel: StreamChannel | undefined;
    // Function declarations below are hoisted; none runs before this line.
    const durationTimer = setTimeout(() => {
      stopReading("timed_out");
    }, maxDurationMs);
    let idleTimer: ReturnType<typeof setTimeout> | undefined;

    function cleanup(): void {
      settled = true;
      clearTimeout(durationTimer);
      clearTimeout(idleTimer);
      signal?.removeEventListener("abort", onAbort);
    }

    function finish(
      outcome: StreamResult["outcome"],
      exitCode: number | null,
      exitSignal: string | null,
    ): void {
      if (settled) return;
      flush(stdout);
      flush(stderr);
      cleanup();
      releaseStdinSecrets();
      resolve(result(outcome, exitCode, exitSignal));
    }

    function fail(error: Error): void {
      if (settled) return;
      cleanup();
      releaseStdinSecrets();
      reject(error);
    }

    function stopReading(outcome: StreamResult["outcome"]): void {
      if (settled) return;
      channel?.destroy();
      finish(outcome, null, null);
    }

    function armIdle(): void {
      clearTimeout(idleTimer);
      idleTimer = setTimeout(() => {
        stopReading("idle_timeout");
      }, idleTimeoutMs);
    }

    function onAbort(): void {
      stopReading("aborted");
    }

    armIdle();
    signal?.addEventListener("abort", onAbort, { once: true });

    client.exec(renderRemoteCommand(command), (err, execChannel) => {
      if (settled) {
        // Late arrival after a timeout/abort: never leave it open and unmanaged (CR-01).
        if (err === undefined) {
          execChannel.on("error", () => {
            // Discarded channel; nothing left to settle.
          });
          execChannel.destroy();
        }
        return;
      }
      if (err !== undefined) {
        fail(err);
        return;
      }
      channel = execChannel;
      execChannel.on("error", () => {
        fail(new TransportClosedError(command.name));
      });
      execChannel.on("data", (chunk: Buffer) => {
        if (settled) return;
        armIdle();
        onData(stdout, chunk);
      });
      execChannel.stderr.on("data", (chunk: Buffer) => {
        if (settled) return;
        armIdle();
        onData(stderr, chunk);
      });
      execChannel.on("close", (code: number | null, exitSignal?: string) => {
        finish("completed", code ?? null, exitSignal ?? null);
      });
      if (stdinPlaintext !== undefined) execChannel.write(stdinPlaintext);
      execChannel.end();
    });
  });
}
