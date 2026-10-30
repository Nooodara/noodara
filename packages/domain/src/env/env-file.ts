// Renders the file passed to `docker create --env-file` (ADR 0011 A4). Measured docker semantics:
// one `NAME=value` per line, split at the first `=`, no quoting or escape processing, `#` only
// starts a comment at line start, a bare name inherits the CLI env and a line over 65,535 bytes
// fails. So: always `KEY=VALUE`, values validated single-line, keys sorted, no duplicates.

import { type EnvFailure, type EnvResult, utf8ByteLength, validateEnvKey, validateEnvValue } from './env-value.js';

/** Measured in 21-01: a 65,535-byte line works, 65,536 fails (`bufio.Scanner: token too long`). */
export const MAX_ENV_FILE_LINE_BYTES = 65_535;

/**
 * Aggregate cap: sixteen measured maximal lines (1 MiB). The env reaches the container process
 * through execve, whose argv + envp budget on stock Ubuntu is 2 MiB, so the file stays at half.
 */
export const MAX_ENV_FILE_BYTES = 16 * (MAX_ENV_FILE_LINE_BYTES + 1);

export interface EnvFileEntry {
  readonly key: string;
  readonly value: string;
}

// Keys are unique here (duplicates rejected above), so equality never occurs.
function compareKeys(a: EnvFileEntry, b: EnvFileEntry): number {
  return a.key < b.key ? -1 : 1;
}

/** Deterministic env-file content, or a named error. Never a truncated file. */
export function renderEnvFile(entries: readonly EnvFileEntry[]): EnvResult<string> {
  const seen = new Set<string>();
  for (const entry of entries) {
    const key = validateEnvKey(entry.key);
    if (!key.ok) return key;
    if (seen.has(entry.key)) {
      const duplicate: EnvFailure = {
        ok: false,
        code: 'ENV_FILE_DUPLICATE_KEY',
        message: `Variable ${entry.key} is defined more than once`,
        key: entry.key,
      };
      return duplicate;
    }
    seen.add(entry.key);
    const value = validateEnvValue(entry.value, entry.key);
    if (!value.ok) return value;
  }

  const lines = [...entries].sort(compareKeys).map((entry) => `${entry.key}=${entry.value}\n`);
  const content = lines.join('');
  const byteLength = utf8ByteLength(content);
  if (byteLength > MAX_ENV_FILE_BYTES) {
    const tooLarge: EnvFailure = {
      ok: false,
      code: 'ENV_FILE_TOO_LARGE',
      message: `Environment must be at most ${MAX_ENV_FILE_BYTES.toString()} bytes in total`,
      byteLength,
    };
    return tooLarge;
  }
  return { ok: true, value: content };
}
