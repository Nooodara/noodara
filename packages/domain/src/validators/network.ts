// Pure network validators (SERV-05, roadmap §6.4, PITFALLS.md #9 — command injection at the
// source). `node:net` is banned in packages/domain (see purity.test.ts's BANNED_SPECIFIERS), so
// IPv4/IPv6 literal detection is implemented here with plain regexes instead of `net.isIP`.
//
// Every validator across packages/domain/src/validators returns this same `ValidationResult`
// instead of throwing, so phase 4's HTTP handlers can map a failure `code` to a field-level API
// error without try/catch or string matching. Throwing stays reserved for programmer error.

export interface ValidationSuccess<T> {
  readonly ok: true;
  readonly value: T;
}

export interface ValidationFailure {
  readonly ok: false;
  readonly code: string;
  readonly message: string;
}

export type ValidationResult<T> = ValidationSuccess<T> | ValidationFailure;

export function ok<T>(value: T): ValidationResult<T> {
  return { ok: true, value };
}

export function fail<T>(code: string, message: string): ValidationResult<T> {
  return { ok: false, code, message };
}

/**
 * Narrows `T | undefined` to `T` once the caller has already guaranteed the value is present —
 * mirrors `security/envelope.ts`'s `assertDefined`, needed here for regex capture groups under
 * `noUncheckedIndexedAccess` (a match on a fixed-group regex always yields those groups).
 */
export function assertDefined<T>(value: T | undefined): T {
  return value as T;
}

// Checked first, before any other host rule, so the most dangerous input class (a shell
// metacharacter that could reach a remote command template in phase 2's SSH adapter) always gets
// an unambiguous, unmistakable code — see the threat model's T-1-13 mitigation.
const SHELL_METACHARACTER_PATTERN = /[;|&$`()<>]/;

const IPV4_PATTERN = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;

// Standard IPv6 literal grammar (full 8-group form, "::" compression, and every mix in between).
const IPV6_PATTERN =
  /^(([0-9a-fA-F]{1,4}:){7}[0-9a-fA-F]{1,4}|([0-9a-fA-F]{1,4}:){1,7}:|([0-9a-fA-F]{1,4}:){1,6}:[0-9a-fA-F]{1,4}|([0-9a-fA-F]{1,4}:){1,5}(:[0-9a-fA-F]{1,4}){1,2}|([0-9a-fA-F]{1,4}:){1,4}(:[0-9a-fA-F]{1,4}){1,3}|([0-9a-fA-F]{1,4}:){1,3}(:[0-9a-fA-F]{1,4}){1,4}|([0-9a-fA-F]{1,4}:){1,2}(:[0-9a-fA-F]{1,4}){1,5}|[0-9a-fA-F]{1,4}:((:[0-9a-fA-F]{1,4}){1,6})|:((:[0-9a-fA-F]{1,4}){1,7}|:))$/;

const HOSTNAME_LABEL_PATTERN = /^[a-zA-Z0-9]([a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?$/;

const MAX_HOSTNAME_LENGTH = 253;

/**
 * Validates a `Server.host` value (SSH target): an IPv4 literal, an IPv6 literal, or an RFC 1123
 * hostname. Branches explicitly on each of the three shapes (rather than one catch-all regex) so
 * each path is individually covered and the failure `code` is always specific. IP literals are
 * returned unchanged; hostnames are lowercased with any trailing dot removed.
 */
export function validateHost(input: string): ValidationResult<string> {
  if (SHELL_METACHARACTER_PATTERN.test(input)) {
    return fail(
      'HOST_CONTAINS_METACHARACTER',
      'Host must not contain a shell metacharacter (;|&$`()<>)',
    );
  }
  if (input.length === 0) {
    return fail('HOST_EMPTY', 'Host must not be empty');
  }
  if (/\s/.test(input)) {
    return fail('HOST_CONTAINS_WHITESPACE', 'Host must not contain whitespace');
  }
  if (input.includes('://')) {
    return fail('HOST_CONTAINS_SCHEME', 'Host must not include a URL scheme');
  }

  if (IPV6_PATTERN.test(input)) {
    return ok(input);
  }

  const ipv4Match = IPV4_PATTERN.exec(input);
  if (ipv4Match) {
    const octets = [
      assertDefined(ipv4Match[1]),
      assertDefined(ipv4Match[2]),
      assertDefined(ipv4Match[3]),
      assertDefined(ipv4Match[4]),
    ];
    const invalidOctet = octets.find((octet) => Number(octet) > 255);
    if (invalidOctet !== undefined) {
      return fail('HOST_INVALID_IPV4_OCTET', `IPv4 octet out of range (0-255): ${invalidOctet}`);
    }
    return ok(input);
  }

  if (input.includes(':')) {
    return fail('HOST_CONTAINS_PORT', 'Host must not include a port; validate the port separately');
  }

  const withoutTrailingDot = input.endsWith('.') ? input.slice(0, -1) : input;
  if (withoutTrailingDot.length > MAX_HOSTNAME_LENGTH) {
    return fail(
      'HOST_TOO_LONG',
      `Host must be at most ${MAX_HOSTNAME_LENGTH.toString()} characters`,
    );
  }

  for (const label of withoutTrailingDot.split('.')) {
    if (!HOSTNAME_LABEL_PATTERN.test(label)) {
      return fail('HOST_INVALID_LABEL', `Invalid hostname label: "${label}"`);
    }
  }

  return ok(withoutTrailingDot.toLowerCase());
}

/**
 * Validates `Server.ssh_port` (skill §2: 1-65535, default 22). Rejects anything that isn't a
 * runtime integer in range — including a numeric string, since the type system alone doesn't
 * stop a value coming from an untyped boundary (JSON body, env var) at runtime.
 */
export function validateSshPort(input: unknown): ValidationResult<number> {
  if (typeof input !== 'number' || !Number.isInteger(input)) {
    return fail('PORT_NOT_INTEGER', 'SSH port must be an integer number, not a string or decimal');
  }
  if (input < 1 || input > 65535) {
    return fail('PORT_OUT_OF_RANGE', `SSH port must be between 1 and 65535, got ${input.toString()}`);
  }
  return ok(input);
}
