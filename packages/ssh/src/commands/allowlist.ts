// The complete, frozen SSH command allowlist (SEC-04, T-2-01, T-2-02). This — plus `SshSession.exec`
// taking a `CommandName` instead of a string (ssh-port.ts) — is the whole of "no user input ever
// reaches a shell". allowlist.test.ts is the exactness guard: it asserts this set is exactly 11
// entries, in this order, none containing an interpolation marker.
import { ACCESS_COMMANDS } from './access.js';
import { DISCOVERY_COMMANDS } from './discovery.js';
import { DOCKER_COMMANDS } from './docker.js';

export const COMMAND_TEMPLATES = {
  ...DISCOVERY_COMMANDS,
  ...DOCKER_COMMANDS,
  ...ACCESS_COMMANDS,
} as const;

export type CommandName = keyof typeof COMMAND_TEMPLATES;

/** Frozen, ordered list of every allowlisted command name (insertion order of COMMAND_TEMPLATES). */
export const COMMAND_NAMES = Object.keys(COMMAND_TEMPLATES) as readonly CommandName[];

/**
 * Returns the fixed template for `name`. A plain object index, not a switch: `name`'s type is
 * exactly `keyof typeof COMMAND_TEMPLATES`, so every valid `CommandName` is guaranteed by the type
 * checker to have an entry here — no default branch, no cast, no possibility of returning
 * `undefined` for a value the type system accepts.
 */
export function commandFor(name: CommandName): string {
  return COMMAND_TEMPLATES[name];
}

/**
 * Wraps `value` in single quotes for safe use as a POSIX shell argument, closing and reopening the
 * quote around each embedded single quote (the standard `'\''` idiom). This is a quoting function,
 * not a sanitiser: it rejects nothing and transforms nothing but the quote character itself.
 * 02-RESEARCH.md's Pitfall 5 documents that a blocklist / "clean the input" approach is exactly
 * what produced Dokploy's CVSS 9.9 command-injection CVE. No v0.1 template takes an argument yet —
 * this is forward-looking infrastructure for the day one does.
 */
export function escapeShellArg(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}
