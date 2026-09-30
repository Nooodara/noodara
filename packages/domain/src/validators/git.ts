// Pure Git input validators (SVC-08, 11-CONTEXT D-05/D-06/D-08). Every value validated here later
// reaches a remote shell through a closed command template, so the rules are an allowlist per
// shape, dangerous characters are checked first, and each rejection has its own named code.

import type { Brand } from './branded.js';
import { type ValidationResult, assertDefined, fail, ok } from './network.js';

export type RepositoryUrl = Brand<string, 'RepositoryUrl'>;
export type GitBranch = Brand<string, 'GitBranch'>;
export type CommitSha = Brand<string, 'CommitSha'>;

const MAX_REPOSITORY_URL_LENGTH = 512;
const MAX_HOSTNAME_LENGTH = 253;
const MAX_BRANCH_LENGTH = 255;

// `?` and `#` are deliberately absent: they are reported as REPOSITORY_URL_QUERY_OR_FRAGMENT.
// `[` and `]` are also absent here and handled by BRACKET_PATTERN, because a bracketed IPv6
// literal is legal in the host position only.
const URL_METACHARACTER_PATTERN = /[;|&$`()<>\\"'*{}!]/;
const BRACKET_PATTERN = /[[\]]/;
// A bracketed IPv6 literal right where the host starts, for each of the three shapes.
const LEADING_IPV6_HOST_PATTERN = /^(https:\/\/|ssh:\/\/[^/@]*@|[^/@:]*@)\[[0-9a-fA-F:.]*\]/;

const USER_PATTERN = /^[a-z_][a-z0-9_-]{0,31}$/;
const PORT_PATTERN = /^\d{1,5}$/;
const PATH_CHARACTER_PATTERN = /^[A-Za-z0-9._~/-]+$/;
const HOSTNAME_LABEL_PATTERN = /^[a-zA-Z0-9]([a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?$/;
const IPV4_PATTERN = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;
const IPV6_PATTERN =
  /^(([0-9a-fA-F]{1,4}:){7}[0-9a-fA-F]{1,4}|([0-9a-fA-F]{1,4}:){1,7}:|([0-9a-fA-F]{1,4}:){1,6}:[0-9a-fA-F]{1,4}|([0-9a-fA-F]{1,4}:){1,5}(:[0-9a-fA-F]{1,4}){1,2}|([0-9a-fA-F]{1,4}:){1,4}(:[0-9a-fA-F]{1,4}){1,3}|([0-9a-fA-F]{1,4}:){1,3}(:[0-9a-fA-F]{1,4}){1,4}|([0-9a-fA-F]{1,4}:){1,2}(:[0-9a-fA-F]{1,4}){1,5}|[0-9a-fA-F]{1,4}:((:[0-9a-fA-F]{1,4}){1,6})|:((:[0-9a-fA-F]{1,4}){1,7}|:))$/;

const BRANCH_CHARACTER_PATTERN = /^[A-Za-z0-9._/-]+$/;
const BRANCH_SUBSET =
  'Branch must use only [A-Za-z0-9._/-], be at most 255 characters, not start with "-", "/" or ".", not end with "/", "." or ".lock", and contain no ".." or "//"';

const COMMIT_SHA_PATTERN = /^[0-9a-f]{40}$/;

type Failure = { code: string; message: string } | null;

function problem(code: string, message: string): Failure {
  return { code, message };
}

/**
 * D-06: syntactic public-host check, no DNS. Rejects localhost, private/loopback/link-local/CGNAT
 * IP literals and invalid hostnames. A hostname must also survive WHATWG URL host parsing
 * unchanged, which rejects IPv4 shorthands such as `127.1` or `0x7f.0.0.1` that git/curl would
 * otherwise resolve to a private address.
 */
function checkHost(host: string): Failure {
  const invalid = (reason: string): Failure =>
    problem('REPOSITORY_URL_INVALID_HOST', `Repository host ${reason}`);

  // A "[" here is always closed: LEADING_IPV6_HOST_PATTERN lets only a well-formed bracket through.
  if (host.startsWith('[')) {
    return checkIpv6(host.slice(1, -1).toLowerCase()) ? null : invalid('must be a public address');
  }

  const ipv4 = IPV4_PATTERN.exec(host);
  if (ipv4) {
    const octets = [ipv4[1], ipv4[2], ipv4[3], ipv4[4]].map(assertDefined);
    if (octets.some((octet) => octet.length > 1 && octet.startsWith('0'))) {
      return invalid('must not use leading zeros in an IPv4 address');
    }
    const [a, b, c, d] = octets.map(Number) as [number, number, number, number];
    if ([a, b, c, d].some((octet) => octet > 255)) {
      return invalid('has an IPv4 octet out of range');
    }
    return isPublicIpv4(a, b) ? null : invalid('must be a public address');
  }

  if (host.length > MAX_HOSTNAME_LENGTH) {
    return invalid(`must be at most ${MAX_HOSTNAME_LENGTH.toString()} characters`);
  }
  if (!host.split('.').every((label) => HOSTNAME_LABEL_PATTERN.test(label))) {
    return invalid('is not a valid hostname');
  }
  const lower = host.toLowerCase();
  if (lower === 'localhost' || lower.endsWith('.localhost')) {
    return invalid('must not be localhost');
  }
  if (whatwgHostname(host) !== lower) {
    return invalid('is not a valid public hostname');
  }
  return null;
}

function whatwgHostname(host: string): string | null {
  try {
    return new URL(`https://${host}/`).hostname;
  } catch {
    return null;
  }
}

function isPublicIpv4(a: number, b: number): boolean {
  if (a === 0 || a === 10 || a === 127 || a >= 224) return false;
  if (a === 100 && b >= 64 && b <= 127) return false; // CGNAT 100.64.0.0/10
  if (a === 169 && b === 254) return false; // link-local
  if (a === 172 && b >= 16 && b <= 31) return false;
  if (a === 192 && b === 168) return false;
  return true;
}

function checkIpv6(address: string): boolean {
  if (!IPV6_PATTERN.test(address)) return false;
  if (address === '::' || address === '::1') return false;
  if (address.startsWith('::ffff:')) return false; // IPv4-mapped
  // fe80::/10 link-local, fec0::/10 site-local, fc00::/7 unique-local.
  return !/^(fe[89ab]|fe[c-f]|f[cd])/.test(address);
}

function checkPort(port: string | undefined): Failure {
  if (port === undefined) return null;
  if (!PORT_PATTERN.test(port) || Number(port) < 1 || Number(port) > 65535) {
    return problem(
      'REPOSITORY_URL_INVALID_PORT',
      'Repository port must be a number from 1 to 65535',
    );
  }
  return null;
}

/** `host`, `host:port`, `[v6]` or `[v6]:port`. */
function checkHostPort(hostPort: string): Failure {
  let host = hostPort;
  let port: string | undefined;
  if (hostPort.startsWith('[')) {
    const close = hostPort.indexOf(']');
    host = hostPort.slice(0, close + 1);
    const rest = hostPort.slice(close + 1);
    if (rest !== '') {
      port = rest.startsWith(':') ? rest.slice(1) : rest;
    }
  } else {
    const colon = hostPort.indexOf(':');
    if (colon !== -1) {
      host = hostPort.slice(0, colon);
      port = hostPort.slice(colon + 1);
    }
  }
  return checkHost(host) ?? checkPort(port);
}

function checkUser(user: string): Failure {
  if (user.includes(':')) {
    return problem(
      'REPOSITORY_URL_EMBEDDED_CREDENTIALS',
      'Repository URL must not embed credentials; configure a deploy key or token instead',
    );
  }
  if (!USER_PATTERN.test(user)) {
    return problem(
      'REPOSITORY_URL_INVALID_USER',
      'Repository SSH user must match [a-z_][a-z0-9_-]{0,31}',
    );
  }
  return null;
}

/** Path after the host. `absolute` paths keep their leading "/" (scp-like `host:/srv/x.git`). */
function checkPath(path: string): Failure {
  const segments = path.startsWith('/') ? path.slice(1).split('/') : path.split('/');
  if (segments.includes('..')) {
    return problem('REPOSITORY_URL_PATH_TRAVERSAL', 'Repository path must not contain ".."');
  }
  const invalid = problem(
    'REPOSITORY_URL_INVALID_PATH',
    'Repository path must be non-empty, use only [A-Za-z0-9._~/-], and have no empty, "." or "-"-prefixed segments',
  );
  if (!PATH_CHARACTER_PATTERN.test(path)) return invalid;
  if (segments.some((segment) => segment === '' || segment === '.' || segment.startsWith('-'))) {
    return invalid;
  }
  return null;
}

function checkSchemeUrl(scheme: string, rest: string): Failure {
  const slash = rest.indexOf('/');
  const authority = slash === -1 ? rest : rest.slice(0, slash);
  const path = slash === -1 ? '' : rest.slice(slash);
  const at = authority.lastIndexOf('@');
  const hostPort = authority.slice(at + 1);

  if (scheme === 'https') {
    if (at !== -1) {
      return problem(
        'REPOSITORY_URL_EMBEDDED_CREDENTIALS',
        'Repository URL must not embed credentials; configure a token instead',
      );
    }
  } else {
    if (at === -1) {
      return problem('REPOSITORY_URL_INVALID_USER', 'An ssh:// repository URL must include a user');
    }
    const userFailure = checkUser(authority.slice(0, at));
    if (userFailure) return userFailure;
  }
  return checkHostPort(hostPort) ?? checkPath(path);
}

function checkScpLike(input: string): Failure {
  const unsupported = problem(
    'REPOSITORY_URL_UNSUPPORTED_SCHEME',
    'Repository URL must be https://host/path, ssh://user@host[:port]/path or user@host:path',
  );
  const at = input.indexOf('@');
  if (at === -1) return unsupported;
  const afterUser = input.slice(at + 1);
  const hostEnd = afterUser.startsWith('[') ? afterUser.indexOf(']') + 1 : 0;
  const colon = afterUser.indexOf(':', hostEnd);
  if (colon === -1) return unsupported;

  return (
    checkUser(input.slice(0, at)) ??
    checkHost(afterUser.slice(0, colon)) ??
    checkPath(afterUser.slice(colon + 1))
  );
}

/**
 * Validates a repository URL against D-05's three accepted shapes: `https://host[:port]/path`,
 * `ssh://user@host[:port]/path` and scp-like `user@host:path`. Returns the input unchanged (no
 * normalization) so git receives exactly what was validated.
 */
export function validateRepositoryUrl(input: string): ValidationResult<RepositoryUrl> {
  const failure = checkRepositoryUrl(input);
  return failure ? fail(failure.code, failure.message) : ok(input as RepositoryUrl);
}

function checkRepositoryUrl(input: string): Failure {
  if (input.length === 0) {
    return problem('REPOSITORY_URL_EMPTY', 'Repository URL must not be empty');
  }
  if (input.length > MAX_REPOSITORY_URL_LENGTH) {
    return problem(
      'REPOSITORY_URL_TOO_LONG',
      `Repository URL must be at most ${MAX_REPOSITORY_URL_LENGTH.toString()} characters`,
    );
  }
  const metacharacter = URL_METACHARACTER_PATTERN.exec(input);
  const bracket = BRACKET_PATTERN.exec(input.replace(LEADING_IPV6_HOST_PATTERN, '$1'));
  const offending = metacharacter ?? bracket;
  if (offending) {
    return problem(
      'REPOSITORY_URL_CONTAINS_METACHARACTER',
      `Repository URL must not contain the shell metacharacter ${offending[0]}`,
    );
  }
  if (/\s/.test(input)) {
    return problem(
      'REPOSITORY_URL_CONTAINS_WHITESPACE',
      'Repository URL must not contain whitespace',
    );
  }
  if (/[?#]/.test(input)) {
    return problem(
      'REPOSITORY_URL_QUERY_OR_FRAGMENT',
      'Repository URL must not contain a query string (?) or fragment (#)',
    );
  }

  const schemeEnd = input.indexOf('://');
  if (schemeEnd === -1) {
    return checkScpLike(input);
  }
  const scheme = input.slice(0, schemeEnd);
  if (scheme !== 'https' && scheme !== 'ssh') {
    return problem(
      'REPOSITORY_URL_UNSUPPORTED_SCHEME',
      'Repository URL scheme must be https:// or ssh:// (http, git, file and others are not supported)',
    );
  }
  return checkSchemeUrl(scheme, input.slice(schemeEnd + 3));
}

/** D-08: a strict subset of `git check-ref-format`, documented in every failure message. */
export function validateGitBranch(input: string): ValidationResult<GitBranch> {
  const reject = (code: string): ValidationResult<GitBranch> => fail(code, BRANCH_SUBSET);

  if (input.length === 0) return reject('GIT_BRANCH_EMPTY');
  if (input.length > MAX_BRANCH_LENGTH) return reject('GIT_BRANCH_TOO_LONG');
  if (!BRANCH_CHARACTER_PATTERN.test(input)) return reject('GIT_BRANCH_INVALID_CHARACTER');
  if (input.includes('..')) return reject('GIT_BRANCH_PATH_TRAVERSAL');
  if (input.includes('//')) return reject('GIT_BRANCH_EMPTY_SEGMENT');
  const segments = input.split('/');
  if (
    input.startsWith('-') ||
    input.startsWith('/') ||
    input.endsWith('/') ||
    input.endsWith('.') ||
    segments.some((segment) => segment.startsWith('.'))
  ) {
    return reject('GIT_BRANCH_INVALID_BOUNDARY');
  }
  if (segments.some((segment) => segment.endsWith('.lock')))
    return reject('GIT_BRANCH_LOCK_SUFFIX');
  return ok(input as GitBranch);
}

/** A full 40-character lowercase hex SHA-1, as `git rev-parse` prints it. */
export function validateCommitSha(input: string): ValidationResult<CommitSha> {
  if (!COMMIT_SHA_PATTERN.test(input)) {
    return fail('COMMIT_SHA_INVALID', 'Commit SHA must be exactly 40 lowercase hex characters');
  }
  return ok(input as CommitSha);
}
