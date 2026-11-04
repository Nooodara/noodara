// Shared bounds for the ADR 0012 probe outputs. Every probe runs under `head -c <cap>`, so output
// of exactly the cap was cut by head and anything above it never came from the probe. Error
// messages name a line number or field, never the raw output.

import { fail, ok, type ValidationResult } from '../validators/network.js';

/** ADR 0012 default cap for the host and container samples (64 KiB). */
export const SAMPLE_OUTPUT_CAP_BYTES = 65_536;

export const OBSERVABILITY_PARSE_ERRORS = Object.freeze([
  'OUTPUT_TOO_LARGE',
  'OUTPUT_TRUNCATED',
  'HOST_SAMPLE_MALFORMED',
  'HOST_SAMPLE_INCOMPLETE',
  'CONTAINER_SAMPLE_MALFORMED',
] as const);

export type ObservabilityParseError = (typeof OBSERVABILITY_PARSE_ERRORS)[number];

export interface ParseOptions {
  /** The `head -c` cap the probe ran with; defaults to SAMPLE_OUTPUT_CAP_BYTES. */
  readonly capBytes?: number;
}

function utf8Length(text: string): number {
  return new TextEncoder().encode(text).length;
}

/**
 * Splits a bounded probe output into lines. A non-empty output must end with a newline (every
 * probe line is printed with one), so a missing one means the stream was cut mid-line.
 */
export function boundedLines(stdout: string, options: ParseOptions = {}): ValidationResult<string[]> {
  const cap = options.capBytes ?? SAMPLE_OUTPUT_CAP_BYTES;
  // UTF-8 never has fewer bytes than UTF-16 code units, so a long string is rejected unencoded.
  const bytes = stdout.length > cap ? cap + 1 : utf8Length(stdout);
  if (bytes > cap) {
    return fail('OUTPUT_TOO_LARGE', `Probe output is larger than the ${String(cap)}-byte cap`);
  }
  if (bytes === cap || (stdout !== '' && !stdout.endsWith('\n'))) {
    return fail('OUTPUT_TRUNCATED', 'Probe output was cut before its last line ended');
  }
  return ok(stdout === '' ? [] : stdout.slice(0, -1).split('\n'));
}

const UNSIGNED_INTEGER = /^\d+$/;

/** A base-10 unsigned integer that fits a JS safe integer, or null. */
export function safeUnsigned(text: string): number | null {
  if (!UNSIGNED_INTEGER.test(text)) return null;
  const value = Number(text);
  return Number.isSafeInteger(value) ? value : null;
}
