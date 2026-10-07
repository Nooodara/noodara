// Git host key pinning (14-06). Pure parsing of OpenSSH known_hosts lines, the bundled published
// keys and the known_hosts content written for a clone. Every line is untrusted (keyscan output,
// persisted rows, vendor data) until it passes parseGitHostKeyLine, and known_hosts content is
// built only from parsed parts, so no repo-controlled text reaches ssh or a shell.

import type { Brand } from './branded.js';
import { BUNDLED_GIT_HOST_KEY_ENTRIES } from './bundled-git-host-keys.js';
import type { RepositoryUrl } from './git.js';
import { type ValidationResult, assertDefined, fail, ok } from './network.js';

export const GIT_HOST_KEY_TYPES = Object.freeze([
  'ssh-ed25519',
  'ecdsa-sha2-nistp256',
  'ecdsa-sha2-nistp384',
  'ecdsa-sha2-nistp521',
  'ssh-rsa',
] as const);
export type GitHostKeyType = (typeof GIT_HOST_KEY_TYPES)[number];

/** `host` (port 22) or `[host]:port`, lowercase, without trailing dots. */
export type KnownHostsHost = Brand<string, 'KnownHostsHost'>;

/** Produced only by parseGitHostKeyLine. */
export type GitHostKey = Brand<
  { readonly host: KnownHostsHost; readonly type: GitHostKeyType; readonly key: string },
  'GitHostKey'
>;

/** The SSH host of a repository URL: produced only by gitSshEndpoint. */
export type GitSshEndpoint = Brand<
  { readonly host: string; readonly port: number; readonly knownHostsHost: KnownHostsHost },
  'GitSshEndpoint'
>;

export const MAX_HOST_KEY_LINE_LENGTH = 4096;
const MAX_KEYSCAN_OUTPUT_LENGTH = 64 * 1024;
const MAX_HOSTNAME_LENGTH = 253;
const DEFAULT_SSH_PORT = 22;

// eslint-disable-next-line no-control-regex -- deliberately matching control characters
const CONTROL_CHARACTER_PATTERN = /[\u0000-\u001f\u007f]/;
const WILDCARD_PATTERN = /[*?!]/;
const HOSTNAME_LABEL_PATTERN = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/;
const IPV6_PATTERN = /^[0-9a-f:.]+$/;
const PORT_PATTERN = /^[1-9]\d{0,4}$/;
const BASE64_PATTERN = /^[A-Za-z0-9+/]+={0,2}$/;

/** Lowercase and strip trailing dots, so `GitHub.com.` and `github.com` are the same host. */
export function normalizeGitHost(host: string): string {
  return host.toLowerCase().replace(/\.+$/, '');
}

function isHostname(host: string): boolean {
  return (
    host.length > 0 &&
    host.length <= MAX_HOSTNAME_LENGTH &&
    host.split('.').every((label) => HOSTNAME_LABEL_PATTERN.test(label))
  );
}

function isIpv6(host: string): boolean {
  return IPV6_PATTERN.test(host) && host.split(':').length >= 3;
}

function isPort(port: string): boolean {
  return PORT_PATTERN.test(port) && Number(port) <= 65535;
}

/** Validated, normalized host for a known_hosts line, or null. */
function normalizedHost(raw: string): string | null {
  const host = normalizeGitHost(raw);
  return isHostname(host) || isIpv6(host) ? host : null;
}

/** `host` on port 22, `[host]:port` otherwise. The host must already be validated. */
export function knownHostsHostFor(host: string, port: number): KnownHostsHost {
  const normalized = normalizeGitHost(host);
  return (port === DEFAULT_SSH_PORT ? normalized : `[${normalized}]:${String(port)}`) as KnownHostsHost;
}

/** Case-insensitive, trailing-dot-insensitive comparison of two known_hosts host fields. */
export function sameKnownHostsHost(a: string, b: string): boolean {
  return canonicalKnownHostsHost(a) === canonicalKnownHostsHost(b);
}

function canonicalKnownHostsHost(value: string): string {
  const bracketed = /^\[([^\]]*)\]:(\d+)$/.exec(value);
  if (bracketed) return knownHostsHostFor(assertDefined(bracketed[1]), Number(bracketed[2]));
  return normalizeGitHost(value);
}

function parseHostField(field: string): ValidationResult<KnownHostsHost> {
  const invalid = fail<KnownHostsHost>(
    'HOST_KEY_INVALID_HOST',
    'Host key host must be a hostname, an IP address or [host]:port',
  );
  if (field.startsWith('|')) {
    return fail('HOST_KEY_HASHED_HOST', 'Hashed known_hosts hosts are not accepted');
  }
  if (WILDCARD_PATTERN.test(field)) {
    return fail('HOST_KEY_WILDCARD_HOST', 'Host key host must not contain *, ? or !');
  }
  if (field.includes(',')) {
    return fail('HOST_KEY_MULTIPLE_HOSTS', 'Host key line must name exactly one host');
  }
  if (field.startsWith('[')) {
    const match = /^\[([^[\]]+)\]:(\d+)$/.exec(field);
    if (!match) return invalid;
    const host = normalizedHost(assertDefined(match[1]));
    const port = assertDefined(match[2]);
    return host === null || !isPort(port) ? invalid : ok(knownHostsHostFor(host, Number(port)));
  }
  const host = normalizedHost(field);
  return host === null ? invalid : ok(host as KnownHostsHost);
}

/** Decodes `key` (already base64-checked) and checks the blob's embedded type string. */
function blobMatchesType(key: string, type: string): boolean {
  const binary = atob(key);
  if (binary.length < 4) return false;
  const length =
    ((binary.charCodeAt(0) << 24) |
      (binary.charCodeAt(1) << 16) |
      (binary.charCodeAt(2) << 8) |
      binary.charCodeAt(3)) >>>
    0;
  if (length !== type.length || 4 + length > binary.length) return false;
  return binary.slice(4, 4 + length) === type;
}

function isHostKeyType(value: string): value is GitHostKeyType {
  return (GIT_HOST_KEY_TYPES as readonly string[]).includes(value);
}

/**
 * Parses one OpenSSH known_hosts line `host type base64` (exactly three space-separated fields).
 * Markers, hashed hosts, wildcards, host lists, comments and certificate types are rejected.
 */
export function parseGitHostKeyLine(line: string): ValidationResult<GitHostKey> {
  if (typeof line !== 'string' || line.length === 0) {
    return fail('HOST_KEY_LINE_MALFORMED', 'Host key line must be "host type key"');
  }
  if (line.length > MAX_HOST_KEY_LINE_LENGTH) {
    return fail(
      'HOST_KEY_LINE_TOO_LONG',
      `Host key line must be at most ${String(MAX_HOST_KEY_LINE_LENGTH)} characters`,
    );
  }
  if (CONTROL_CHARACTER_PATTERN.test(line)) {
    return fail('HOST_KEY_LINE_CONTROL_CHARACTER', 'Host key line must be a single plain line');
  }
  if (line.startsWith('@')) {
    return fail('HOST_KEY_LINE_MARKER', 'Host key line must not carry a marker');
  }
  const fields = line.split(' ');
  if (fields.length !== 3 || fields.some((field) => field === '')) {
    return fail('HOST_KEY_LINE_MALFORMED', 'Host key line must be "host type key"');
  }
  const [hostField, type, key] = fields as [string, string, string];

  const host = parseHostField(hostField);
  if (!host.ok) return fail(host.code, host.message);
  if (!isHostKeyType(type)) {
    return fail(
      'HOST_KEY_UNSUPPORTED_TYPE',
      'Host key type must be ssh-ed25519, ecdsa-sha2-nistp256/384/521 or ssh-rsa',
    );
  }
  if (!BASE64_PATTERN.test(key) || key.length % 4 !== 0) {
    return fail('HOST_KEY_INVALID_BASE64', 'Host key must be base64');
  }
  if (!blobMatchesType(key, type)) {
    return fail('HOST_KEY_TYPE_MISMATCH', 'Host key blob does not match its declared type');
  }
  return ok({ host: host.value, type, key } as GitHostKey);
}

/** The SSH host and port of an ssh:// or scp-like URL; null for https (no host key involved). */
export function gitSshEndpoint(url: RepositoryUrl): GitSshEndpoint | null {
  let hostPort: string;
  let port = DEFAULT_SSH_PORT;
  if (url.startsWith('https://')) return null;
  if (url.startsWith('ssh://')) {
    const rest = url.slice('ssh://'.length);
    const authority = rest.includes('/') ? rest.slice(0, rest.indexOf('/')) : rest;
    hostPort = authority.slice(authority.lastIndexOf('@') + 1);
    const portMatch = /^(\[[^\]]+\]|[^:]+):(\d+)$/.exec(hostPort);
    if (portMatch) {
      hostPort = assertDefined(portMatch[1]);
      port = Number(portMatch[2]);
    }
  } else {
    const afterUser = url.slice(url.indexOf('@') + 1);
    hostPort = afterUser.startsWith('[')
      ? afterUser.slice(0, afterUser.indexOf(']') + 1)
      : afterUser.slice(0, afterUser.indexOf(':'));
  }
  const host = normalizeGitHost(hostPort.replace(/^\[(.*)\]$/, '$1'));
  return { host, port, knownHostsHost: knownHostsHostFor(host, port) } as GitSshEndpoint;
}

export interface BundledGitHostKey {
  readonly host: string;
  readonly type: GitHostKeyType;
  /** The known_hosts line as published by the vendor. */
  readonly line: string;
  /** The vendor-published SHA256 fingerprint, checked against `line` in CI. */
  readonly fingerprint: string;
  readonly provenance: {
    readonly url: string;
    readonly fingerprintUrl: string;
    readonly fetchedAt: string;
  };
}

export const BUNDLED_GIT_HOST_KEYS: readonly BundledGitHostKey[] = BUNDLED_GIT_HOST_KEY_ENTRIES;

/** The bundled published keys for this endpoint; only on port 22, where the vendors publish them. */
export function bundledGitHostKeysFor(endpoint: GitSshEndpoint): readonly GitHostKey[] {
  if (endpoint.port !== DEFAULT_SSH_PORT) return [];
  return BUNDLED_GIT_HOST_KEYS.filter((entry) => entry.host === endpoint.host).flatMap((entry) => {
    const parsed = parseGitHostKeyLine(entry.line);
    return parsed.ok ? [parsed.value] : [];
  });
}

/**
 * Filters untrusted ssh-keyscan output: only lines for the requested host with an accepted type
 * survive, duplicates are dropped, and over-long output yields nothing (fail closed).
 */
export function parseKeyscanOutput(output: string, endpoint: GitSshEndpoint): readonly GitHostKey[] {
  if (typeof output !== 'string' || output.length > MAX_KEYSCAN_OUTPUT_LENGTH) return [];
  const keys: GitHostKey[] = [];
  for (const line of output.split('\n')) {
    if (line === '' || line.startsWith('#')) continue;
    const parsed = parseGitHostKeyLine(line);
    if (!parsed.ok || !sameKnownHostsHost(parsed.value.host, endpoint.knownHostsHost)) continue;
    if (keys.some((key) => key.type === parsed.value.type && key.key === parsed.value.key)) continue;
    keys.push(parsed.value);
  }
  return keys;
}

/** known_hosts content from re-validated keys; anything that does not re-parse is dropped. */
export function knownHostsContent(keys: readonly GitHostKey[]): string {
  return keys
    .flatMap((key) => {
      const parsed = parseGitHostKeyLine(`${key.host} ${key.type} ${key.key}`);
      return parsed.ok ? [`${parsed.value.host} ${parsed.value.type} ${parsed.value.key}\n`] : [];
    })
    .join('');
}
