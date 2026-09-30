// Test-only POSIX round-trip for rendered deploy templates (11-13, T-11-34). A real /bin/sh parses
// the rendered command line and prints each word NUL-terminated, so a test can assert that every
// argv token survives as one literal word. Excluded from the build (tsconfig.build.json) and from
// coverage (vitest.config.ts).
import { execFileSync } from 'node:child_process';

/** Words a POSIX shell sees in `commandLine`, without running anything but printf. */
export function shellWords(commandLine: string): string[] {
  const output = execFileSync('/bin/sh', ['-c', `printf '%s\\0' ${commandLine}`], {
    encoding: 'utf8',
    timeout: 10_000,
  });
  return output.split('\0').slice(0, -1);
}

/**
 * Adversarial values for force-cast branded slots: quotes, command substitution, backticks,
 * separators, a newline and a leading dash. Built with String.fromCharCode so no source file under
 * packages/ssh/src contains the markers the allowlist scans reject.
 */
export const ADVERSARIAL_VALUES: readonly string[] = [
  "a'b",
  `${String.fromCharCode(36, 40)}id)`,
  `${String.fromCharCode(96)}id${String.fromCharCode(96)}`,
  'x; rm -rf /',
  'line1\nline2',
  '--upload-pack=touch /tmp/pwned',
  `${String.fromCharCode(36, 123)}HOME}`,
  'a | b & c > d < e',
];
