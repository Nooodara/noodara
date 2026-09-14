// Docker CLI/daemon detection (D-12, T-2-17). ADR 0004 measured three real shapes of
// `docker version --format '{{json .}}'` and one hand-written ("derived", never captured) fourth
// shape; this parser returns a four-way discriminated union — never a boolean, never a nullable
// string — because collapsing "I could not understand the output" into "it is not installed"
// (Pitfall 6) is exactly the bug D-12 exists to prevent.

// Measured in ADR 0004, Open Question 2: `docker` absent from PATH makes the shell itself exit
// 127 with nothing at all on stdout — a stable POSIX-shell contract (command-not-found), not a
// localisable message this parser would otherwise have to match against.
const COMMAND_NOT_FOUND_EXIT_CODE = 127;

export interface CommandOutput {
  readonly stdout: string;
  readonly stderr: string;
  readonly exitCode: number;
}

export type DockerVersionResult =
  | { readonly kind: 'not_installed' }
  | { readonly kind: 'daemon_unreachable'; readonly clientVersion: string }
  | { readonly kind: 'installed'; readonly clientVersion: string; readonly serverVersion: string }
  | { readonly kind: 'unparseable'; readonly reason: string };

interface DockerVersionJsonShape {
  readonly Client?: { readonly Version?: unknown };
  readonly Server?: { readonly Version?: unknown } | null;
}

function readStringVersion(value: unknown): string | null {
  if (typeof value !== 'object' || value === null) {
    return null;
  }
  const version = (value as { Version?: unknown }).Version;
  return typeof version === 'string' ? version : null;
}

export function parseDockerVersion(input: CommandOutput): DockerVersionResult {
  const stdout = input.stdout.trim();

  if (input.exitCode === COMMAND_NOT_FOUND_EXIT_CODE && stdout.length === 0) {
    return { kind: 'not_installed' };
  }

  if (stdout.length === 0) {
    return { kind: 'unparseable', reason: 'Command produced no output' };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout) as unknown;
  } catch {
    return { kind: 'unparseable', reason: 'Output was not valid JSON' };
  }

  if (typeof parsed !== 'object' || parsed === null) {
    return { kind: 'unparseable', reason: 'JSON output was not an object' };
  }

  const shape = parsed as DockerVersionJsonShape;
  const clientVersion = readStringVersion(shape.Client);
  if (clientVersion === null) {
    return { kind: 'unparseable', reason: 'JSON output did not contain a Client.Version string' };
  }

  if (shape.Server === null || shape.Server === undefined) {
    return { kind: 'daemon_unreachable', clientVersion };
  }

  const serverVersion = readStringVersion(shape.Server);
  if (serverVersion === null) {
    return { kind: 'unparseable', reason: 'JSON output had a Server object with no Version string' };
  }

  return { kind: 'installed', clientVersion, serverVersion };
}

export type ComposeVersionResult =
  | { readonly kind: 'installed'; readonly version: string }
  | { readonly kind: 'not_installed'; readonly version: null }
  | { readonly kind: 'unparseable'; readonly reason: string };

export function parseComposeVersion(input: CommandOutput): ComposeVersionResult {
  const stdout = input.stdout.trim();

  if (input.exitCode === COMMAND_NOT_FOUND_EXIT_CODE && stdout.length === 0) {
    return { kind: 'not_installed', version: null };
  }

  if (stdout.length === 0) {
    return { kind: 'unparseable', reason: 'Command produced no output' };
  }

  const lines = stdout.split('\n');
  if (lines.length > 1) {
    return { kind: 'unparseable', reason: 'Expected a single line of version output' };
  }

  return { kind: 'installed', version: stdout };
}
