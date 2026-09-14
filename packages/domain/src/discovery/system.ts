// Four one-line discovery transforms (DISC-01), kept in a single module because splitting them
// into four files would be noise for four one-liners: hostname, architecture, CPU core count and
// uptime. Each returns `ValidationResult` and never throws.

import type { ValidationResult } from '../validators/network.js';
import { assertDefined, fail, ok } from '../validators/network.js';

/** `hostname` output. Rejects empty/whitespace-only output — a server always has a hostname. */
export function parseHostname(stdout: string): ValidationResult<string> {
  const trimmed = stdout.trim();
  if (trimmed.length === 0) {
    return fail('HOSTNAME_EMPTY', 'hostname output was empty');
  }
  return ok(trimmed);
}

/** `uname -m` output. */
export function parseArch(stdout: string): ValidationResult<string> {
  const trimmed = stdout.trim();
  if (trimmed.length === 0) {
    return fail('ARCH_EMPTY', 'uname -m output was empty');
  }
  return ok(trimmed);
}

const POSITIVE_INTEGER_PATTERN = /^\d+$/;

/** `nproc` output. Only a plain positive integer (no sign, no decimal point) is accepted. */
export function parseCpuCores(stdout: string): ValidationResult<number> {
  const trimmed = stdout.trim();
  if (!POSITIVE_INTEGER_PATTERN.test(trimmed)) {
    return fail(
      'CPU_CORES_NOT_A_POSITIVE_INTEGER',
      `nproc output is not a positive integer: "${trimmed}"`,
    );
  }

  const cores = Number(trimmed);
  if (cores < 1) {
    return fail(
      'CPU_CORES_NOT_A_POSITIVE_INTEGER',
      `nproc output is not a positive integer: "${trimmed}"`,
    );
  }

  return ok(cores);
}

/** `/proc/uptime` output: two space-separated fields, "uptime idle". Floors the first field. */
export function parseUptimeSeconds(stdout: string): ValidationResult<number> {
  const fields = stdout.trim().split(/\s+/);
  if (fields.length < 2) {
    return fail(
      'UPTIME_MALFORMED',
      'Expected two space-separated fields in /proc/uptime output',
    );
  }

  const rawUptime = assertDefined(fields[0]);
  const uptime = Number(rawUptime);
  if (!Number.isFinite(uptime) || uptime < 0) {
    return fail(
      'UPTIME_MALFORMED',
      `First field of /proc/uptime is not a valid non-negative number: "${rawUptime}"`,
    );
  }

  return ok(Math.floor(uptime));
}
