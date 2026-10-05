// Runtime-log sanitizer (ROADMAP D8, LOG-03). `docker logs` output is shown to a person but never
// persisted, and a container can print anything: colour codes, cursor movement, terminal titles,
// or raw binary. The sanitizer strips ANSI escape sequences, turns CR/CRLF into LF and replaces
// invalid UTF-8, lone surrogates and other control characters with one placeholder per run.
// Newlines and tabs survive. It never throws, and its output is a fixed point (sanitizing twice is
// a no-op). Pure: no I/O. Redaction is the caller's job and must happen before this.

import { assertDefined } from "../validators/network.js";

/** U+FFFD REPLACEMENT CHARACTER: stands in for each run of binary or invalid input. */
export const LOG_BINARY_PLACEHOLDER = "\uFFFD";

// Linear-time alternatives (disjoint character classes, no nested quantifiers), in this order:
// CSI (7-bit and 8-bit), OSC up to BEL/ST or end of text, DCS/SOS/PM/APC up to ST or end of
// text, then any other escape (Fp, Fe, Fs, and nF with intermediates such as `ESC ( B`).
const ANSI_SEQUENCE = new RegExp(
  [
    "(?:\\u001B\\[|\\u009B)[0-?]*[ -/]*[@-~]",
    "\\u001B\\][^\\u0007\\u001B]*(?:\\u0007|\\u001B\\\\)?",
    "\\u001B[PX^_][^\\u001B]*(?:\\u001B\\\\)?",
    "\\u001B[ -/]*[0-~]",
  ].join("|"),
  "g",
);

const ESC = 0x1b;

function isReplaced(code: number): boolean {
  return (
    (code <= 0x1f && code !== 0x09 && code !== 0x0a) ||
    (code >= 0x7f && code <= 0x9f) ||
    (code >= 0xd800 && code <= 0xdfff) ||
    code === 0xfffd
  );
}

/** Sanitizes already-decoded log text. Never throws. */
export function sanitizeLogText(text: string): string {
  const stripped = text.replace(ANSI_SEQUENCE, "").replace(/\r\n?/g, "\n");
  let out = "";
  let inRun = false;
  // `for...of` walks code points; a lone surrogate comes through as a single unit.
  for (const ch of stripped) {
    const code = assertDefined(ch.codePointAt(0));
    if (code === ESC) continue;
    if (isReplaced(code)) {
      if (!inRun) out += LOG_BINARY_PLACEHOLDER;
      inRun = true;
      continue;
    }
    out += ch;
    inRun = false;
  }
  return out;
}

const decoder = new TextDecoder("utf-8", { fatal: false, ignoreBOM: true });

/** Decodes raw log bytes (invalid UTF-8 becomes the placeholder) and sanitizes them. */
export function sanitizeLogBytes(bytes: Uint8Array): string {
  return sanitizeLogText(decoder.decode(bytes));
}
