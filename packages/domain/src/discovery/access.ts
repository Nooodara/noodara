// SERV-08's two access checks (D-13): passwordless sudo and Docker group membership. Neither can
// meaningfully "fail to parse" — the input is always either an exit code or a fixed-format
// `id -nG` line — so these return direct values rather than a `ValidationResult`.

/** `sudo -n true`'s outcome. `detail` carries the already-redacted stderr, verbatim, on failure. */
export interface SudoCheckResult {
  readonly status: 'pass' | 'fail';
  readonly detail: string;
}

export function parseSudoCheck(input: { exitCode: number; stderr: string }): SudoCheckResult {
  if (input.exitCode === 0) {
    return { status: 'pass', detail: '' };
  }
  return { status: 'fail', detail: input.stderr };
}

/**
 * `id -nG` output: a whitespace-separated list of group names. Membership is a whole-token
 * comparison, never a substring check — `docker-compose` or `dockerx` must not be mistaken for
 * `docker` (T-2-18).
 */
export function parseDockerGroupMembership(stdout: string): boolean {
  const groups = stdout.trim().split(/\s+/);
  return groups.some((group) => group === 'docker');
}
