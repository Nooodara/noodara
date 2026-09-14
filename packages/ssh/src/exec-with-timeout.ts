// Per-command timeout, redaction and truncation wrapper (SEC-04, SEC-05, D-08). The underlying
// SSH client library has no native per-exec timeout — this `Promise.race`-shaped wrapper is the
// entire implementation of "every command has an explicit timeout" and the last step before a
// command's output can reach a caller unredacted or unbounded.
import type { Redactor } from '@noodara/domain/security';
import { commandFor, type CommandName } from './commands/index.js';
import type { ExecResult } from './ssh-port.js';
import { CommandTimeoutError } from './errors.js';

/** 64 KB per stream (SEC-05). */
export const MAX_OUTPUT_BYTES = 65_536;

/**
 * The narrowest structural shape this module needs from a live exec channel: `on('data')` (and
 * the same on `stderr`), `on('close')`, and `destroy()`. A structural type — not the underlying
 * library's own concrete channel type — keeps this module's unit tests honest fakes rather than
 * mocks of a mock (02-RESEARCH.md's "no mocked Client for connection-outcome scenarios" rule is
 * about connection *outcomes*; this module's behaviour under test is timer and stream mechanics,
 * covered against real containers by plans 02-08/02-10 instead).
 */
export interface ExecChannel {
  on(event: 'data', listener: (chunk: Buffer) => void): void;
  on(event: 'close', listener: (code: number | null, signal?: string) => void): void;
  readonly stderr: { on(event: 'data', listener: (chunk: Buffer) => void): void };
  destroy(): void;
}

export interface ExecWithTimeoutInput {
  /** The narrowest structural client shape: only `exec` is ever called. Never the concrete
   *  underlying-library client type, so a timeout can never reach into `.end()`/`.destroy()`. */
  readonly client: {
    exec(command: string, callback: (err: Error | undefined, channel: ExecChannel) => void): void;
  };
  readonly commandName: CommandName;
  readonly timeoutMs: number;
  readonly redactor: Redactor;
}

interface StreamAccumulator {
  chunks: Buffer[];
  remaining: number;
  truncated: boolean;
}

function makeAccumulator(): StreamAccumulator {
  return { chunks: [], remaining: MAX_OUTPUT_BYTES, truncated: false };
}

/**
 * Walks back up to 3 bytes from the end of `buf` looking for an incomplete multi-byte UTF-8
 * sequence introduced by a hard byte-count cut, and trims it off entirely (rather than leaving
 * partial bytes for `toString('utf8')` to turn into a U+FFFD replacement character). A buffer that
 * already ends cleanly (on an ASCII byte or a fully-present sequence) is returned unchanged.
 */
function trimIncompleteUtf8Tail(buf: Buffer): Buffer {
  const len = buf.length;
  for (let back = 1; back <= 3 && back <= len; back++) {
    const byte = buf[len - back];
    if (byte === undefined) break;

    const isContinuationByte = (byte & 0b1100_0000) === 0b1000_0000;
    if (isContinuationByte) continue;

    const isAscii = (byte & 0b1000_0000) === 0;
    if (isAscii) return buf;

    let expectedLength = 0;
    if ((byte & 0b1110_0000) === 0b1100_0000) expectedLength = 2;
    else if ((byte & 0b1111_0000) === 0b1110_0000) expectedLength = 3;
    else if ((byte & 0b1111_1000) === 0b1111_0000) expectedLength = 4;
    else return buf; // Not a valid UTF-8 leading byte at all — not this function's concern.

    return back < expectedLength ? buf.subarray(0, len - back) : buf;
  }
  return buf;
}

/**
 * Appends `chunk` to `acc`, counting bytes (not UTF-16 code units) and stopping exactly at
 * `MAX_OUTPUT_BYTES`. A chunk that would cross the limit is sliced to the remaining budget and
 * trimmed of any incomplete trailing multi-byte character before being kept.
 */
function appendChunk(acc: StreamAccumulator, chunk: Buffer): void {
  if (acc.remaining <= 0) {
    if (chunk.length > 0) acc.truncated = true;
    return;
  }
  if (chunk.length <= acc.remaining) {
    acc.chunks.push(chunk);
    acc.remaining -= chunk.length;
    return;
  }
  const slice = trimIncompleteUtf8Tail(chunk.subarray(0, acc.remaining));
  acc.chunks.push(slice);
  acc.remaining = 0;
  acc.truncated = true;
}

function finalizeAccumulator(acc: StreamAccumulator): { readonly text: string; readonly truncated: boolean } {
  return { text: Buffer.concat(acc.chunks).toString('utf8'), truncated: acc.truncated };
}

/**
 * Races a single allowlisted command against an independent timeout (D-08). Resolves with an
 * `ExecResult` (stdout/stderr already redacted and truncated) when the channel closes within
 * budget; rejects with `CommandTimeoutError` when the budget elapses first, destroying only the
 * channel — never the client connection. Settlement is guarded by a single flag checked by every
 * callback, so data arriving after the timeout has fired can never resolve an already-settled
 * promise, and the timer is cleared in the one place every exit path routes through.
 */
export function execWithTimeout(input: ExecWithTimeoutInput): Promise<ExecResult> {
  const { client, commandName, timeoutMs, redactor } = input;
  const command = commandFor(commandName);

  return new Promise<ExecResult>((resolve, reject) => {
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let channel: ExecChannel | undefined;
    const startedAt = performance.now();
    const stdoutAcc = makeAccumulator();
    const stderrAcc = makeAccumulator();

    function settle(action: () => void): void {
      if (settled) return;
      settled = true;
      if (timer !== undefined) {
        clearTimeout(timer);
        timer = undefined;
      }
      action();
    }

    timer = setTimeout(() => {
      channel?.destroy();
      settle(() => {
        reject(new CommandTimeoutError(commandName, timeoutMs));
      });
    }, timeoutMs);

    client.exec(command, (err, execChannel) => {
      if (settled) return; // The timeout already fired before ssh2 invoked this callback.
      if (err) {
        settle(() => {
          reject(err);
        });
        return;
      }

      channel = execChannel;
      execChannel.on('data', (chunk: Buffer) => {
        if (settled) return;
        appendChunk(stdoutAcc, chunk);
      });
      execChannel.stderr.on('data', (chunk: Buffer) => {
        if (settled) return;
        appendChunk(stderrAcc, chunk);
      });
      execChannel.on('close', (code: number | null) => {
        if (settled) return;
        const durationMs = performance.now() - startedAt;
        const stdoutFinal = finalizeAccumulator(stdoutAcc);
        const stderrFinal = finalizeAccumulator(stderrAcc);
        settle(() => {
          resolve({
            commandName,
            stdout: redactor.redact(stdoutFinal.text),
            stderr: redactor.redact(stderrFinal.text),
            exitCode: code,
            durationMs,
            truncated: stdoutFinal.truncated || stderrFinal.truncated,
          });
        });
      });
    });
  });
}
