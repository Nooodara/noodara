// Domain hostnames (DMN-01, ADR 0011). `validateHostname` accepts only what Traefik can route and
// an ACME CA can issue for over HTTP-01: a lowercase public FQDN. It never normalises; callers run
// `normaliseHostname` first. Each rejection has its own code, checked in a fixed order, and no
// message echoes the input. `node:net` is banned here, so IP literals are detected by regex.

import type { Brand } from '../validators/branded.js';
import { type ValidationResult, fail, ok } from '../validators/network.js';

export type Hostname = Brand<string, 'Hostname'>;

export const MAX_HOSTNAME_LENGTH = 253;
export const MAX_HOSTNAME_LABEL_LENGTH = 63;
export const MAX_DOMAINS_PER_SERVICE = 10;

/**
 * Special-use TLDs (RFC 6761, 6762, 7686, 9476, ICANN `.internal`) that no public CA issues for.
 * `.test` is deliberately absent: fixtures and Pebble tests use it.
 */
export const SPECIAL_USE_TLDS = Object.freeze([
  'localhost',
  'local',
  'internal',
  'arpa',
  'onion',
  'example',
  'invalid',
  'alt',
] as const);

export const HOSTNAME_ERROR_CODES = Object.freeze([
  'HOSTNAME_REQUIRED',
  'HOSTNAME_TOO_LONG',
  'HOSTNAME_CONTAINS_WHITESPACE',
  'HOSTNAME_CONTAINS_SCHEME',
  'HOSTNAME_CONTAINS_PATH',
  'HOSTNAME_IP_LITERAL',
  'HOSTNAME_CONTAINS_PORT',
  'HOSTNAME_WILDCARD',
  'HOSTNAME_TRAILING_DOT',
  'HOSTNAME_UPPERCASE',
  'HOSTNAME_LOCALHOST',
  'HOSTNAME_SINGLE_LABEL',
  'HOSTNAME_EMPTY_LABEL',
  'HOSTNAME_LABEL_TOO_LONG',
  'HOSTNAME_INVALID_CHARACTER',
  'HOSTNAME_LABEL_HYPHEN',
  'HOSTNAME_RESERVED_LABEL',
  'HOSTNAME_NUMERIC_TLD',
  'HOSTNAME_SPECIAL_USE_TLD',
] as const);

export type HostnameErrorCode = (typeof HOSTNAME_ERROR_CODES)[number];

const IPV4_PATTERN =
  /^(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)\.(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)\.(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)\.(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)$/;
const IPV4_SHAPE_PATTERN = /^\d+\.\d+\.\d+\.\d+$/;
// Same grammar as validators/network.ts (full form, `::` compression and every mix).
const IPV6_PATTERN =
  /^(([0-9a-fA-F]{1,4}:){7}[0-9a-fA-F]{1,4}|([0-9a-fA-F]{1,4}:){1,7}:|([0-9a-fA-F]{1,4}:){1,6}:[0-9a-fA-F]{1,4}|([0-9a-fA-F]{1,4}:){1,5}(:[0-9a-fA-F]{1,4}){1,2}|([0-9a-fA-F]{1,4}:){1,4}(:[0-9a-fA-F]{1,4}){1,3}|([0-9a-fA-F]{1,4}:){1,3}(:[0-9a-fA-F]{1,4}){1,4}|([0-9a-fA-F]{1,4}:){1,2}(:[0-9a-fA-F]{1,4}){1,5}|[0-9a-fA-F]{1,4}:((:[0-9a-fA-F]{1,4}){1,6})|:((:[0-9a-fA-F]{1,4}){1,7}|:))$/;
// Two or more colons over hex digits and dots: an IPv6 literal (incl. IPv4-mapped), never a port.
const IPV6_SHAPE_PATTERN = /^[0-9a-fA-F.]*:[0-9a-fA-F.]*:[0-9a-fA-F.:]*$/;
const LDH_PATTERN = /^[a-z0-9-]+$/;
const NUMERIC_PATTERN = /^\d+$/;
const WHITESPACE_PATTERN = /\s/;
const PATH_PATTERN = /[/?#\\]/;
const UPPERCASE_PATTERN = /[A-Z]/;

/** 4 or 6 for a strict IPv4/IPv6 literal, otherwise null. */
export function ipFamily(value: string): 4 | 6 | null {
  if (IPV4_PATTERN.test(value)) return 4;
  if (IPV6_PATTERN.test(value)) return 6;
  return null;
}

function isWhitespace(char: string): boolean {
  return WHITESPACE_PATTERN.test(char);
}

/**
 * Lowercases, trims and drops trailing dots. Idempotent, and linear: a loop instead of a
 * `[\s.]+$` regex, which backtracks quadratically on long inner whitespace.
 */
export function normaliseHostname(input: string): string {
  const lower = input.toLowerCase();
  let start = 0;
  while (start < lower.length && isWhitespace(lower.charAt(start))) start += 1;
  let end = lower.length;
  while (end > start && (lower.charAt(end - 1) === '.' || isWhitespace(lower.charAt(end - 1)))) {
    end -= 1;
  }
  return lower.slice(start, end);
}

function reject(code: HostnameErrorCode, message: string): ValidationResult<Hostname> {
  return fail(code, message);
}

function validateLabel(label: string): ValidationResult<Hostname> | null {
  if (label.length === 0) {
    return reject(
      'HOSTNAME_EMPTY_LABEL',
      'Hostname must not contain an empty label (two dots in a row or a leading dot)',
    );
  }
  if (label.length > MAX_HOSTNAME_LABEL_LENGTH) {
    return reject('HOSTNAME_LABEL_TOO_LONG', 'Each hostname label must be at most 63 characters');
  }
  if (!LDH_PATTERN.test(label)) {
    return reject(
      'HOSTNAME_INVALID_CHARACTER',
      'Hostname may only contain a-z, 0-9, hyphens and dots; convert an internationalised name to punycode (xn--)',
    );
  }
  if (label.startsWith('-') || label.endsWith('-')) {
    return reject('HOSTNAME_LABEL_HYPHEN', 'A hostname label must not start or end with a hyphen');
  }
  if (label.slice(2, 4) === '--' && !label.startsWith('xn--')) {
    return reject(
      'HOSTNAME_RESERVED_LABEL',
      'A hostname label with "--" in the third and fourth positions is reserved unless it is punycode (xn--)',
    );
  }
  return null;
}

/**
 * Validates an already-normalised hostname. Returns it unchanged (branded) or the first rule it
 * breaks. Accepts any input type so it can sit at an untyped boundary; never throws.
 */
export function validateHostname(input: unknown): ValidationResult<Hostname> {
  if (typeof input !== 'string' || input.length === 0) {
    return reject('HOSTNAME_REQUIRED', 'Hostname is required');
  }
  if (input.length > MAX_HOSTNAME_LENGTH) {
    return reject('HOSTNAME_TOO_LONG', 'Hostname must be at most 253 characters');
  }
  if (WHITESPACE_PATTERN.test(input)) {
    return reject('HOSTNAME_CONTAINS_WHITESPACE', 'Hostname must not contain whitespace');
  }
  if (input.includes('://')) {
    return reject(
      'HOSTNAME_CONTAINS_SCHEME',
      'Enter the hostname only, without http:// or https://',
    );
  }
  if (PATH_PATTERN.test(input)) {
    return reject(
      'HOSTNAME_CONTAINS_PATH',
      'Enter the hostname only, without a path, query or fragment',
    );
  }
  if (
    input.startsWith('[') ||
    IPV4_SHAPE_PATTERN.test(input) ||
    IPV6_PATTERN.test(input) ||
    IPV6_SHAPE_PATTERN.test(input)
  ) {
    return reject('HOSTNAME_IP_LITERAL', 'A domain must be a hostname, not an IP address');
  }
  if (input.includes(':')) {
    return reject('HOSTNAME_CONTAINS_PORT', 'Enter the hostname only, without a port');
  }
  if (input.includes('*')) {
    return reject('HOSTNAME_WILDCARD', 'Wildcard domains are not supported');
  }
  if (input.endsWith('.')) {
    return reject('HOSTNAME_TRAILING_DOT', 'Hostname must not end with a dot');
  }
  if (UPPERCASE_PATTERN.test(input)) {
    return reject('HOSTNAME_UPPERCASE', 'Hostname must be lowercase');
  }
  if (input === 'localhost') {
    return reject('HOSTNAME_LOCALHOST', 'A loopback name cannot be used as a domain');
  }
  const labels = input.split('.');
  if (labels.length === 1) {
    return reject(
      'HOSTNAME_SINGLE_LABEL',
      'Hostname must be a fully qualified domain name (for example app.example.com)',
    );
  }
  for (const label of labels) {
    const failure = validateLabel(label);
    if (failure !== null) return failure;
  }
  // `labels` has at least two entries here, so the last one exists.
  const tld = labels[labels.length - 1] ?? '';
  if (NUMERIC_PATTERN.test(tld)) {
    return reject('HOSTNAME_NUMERIC_TLD', 'The last label of a hostname must not be numeric');
  }
  if ((SPECIAL_USE_TLDS as readonly string[]).includes(tld)) {
    return reject(
      'HOSTNAME_SPECIAL_USE_TLD',
      `Names under .${tld} are special-use and cannot get a public certificate`,
    );
  }
  return ok(input as Hostname);
}

/**
 * True when `hostname` is the panel's own host (`NOODARA_PUBLIC_URL`), which a service may not
 * claim (`DOMAIN_RESERVED`). Exact match after normalisation; an IP or empty panel host reserves
 * nothing.
 */
export function isReservedHostname(
  hostname: string,
  publicUrlHost: string | null | undefined,
): boolean {
  if (publicUrlHost === null || publicUrlHost === undefined) return false;
  const panel = normaliseHostname(publicUrlHost);
  if (panel.length === 0 || ipFamily(panel) !== null) return false;
  return normaliseHostname(hostname) === panel;
}
