// 24-01: fixed copy and semantic tones for the Domains panel. Every status maps to a word and one
// of the four infrastructure tones; a value this build does not know gets a fallback word, never
// the raw string. Hostname errors use the shared validator's codes (the same names the API sends
// as `reason`), each with fixed text that never echoes the input.
import {
  CERT_FAILURE_MESSAGES,
  HOSTNAME_ERROR_CODES,
  normaliseHostname,
  validateHostname,
  type CertFailureCause,
  type HostnameErrorCode,
} from '@noodara/domain';
import { V04_SERVICE_ERROR_CODES, type V04ServiceErrorCode } from '@noodara/domain/api-contract';
import type { Tone } from '@noodara/ui';
import { copyForV04ErrorCode } from './error-copy';

export interface PillCopy {
  readonly label: string;
  readonly tone: Tone;
}

export const UNKNOWN_STATUS_LABEL = 'Unknown';
const UNKNOWN_PILL: PillCopy = Object.freeze({ label: UNKNOWN_STATUS_LABEL, tone: 'idle' });

function lookup<T>(table: Readonly<Record<string, T>>, key: unknown): T | null {
  return typeof key === 'string' && Object.hasOwn(table, key) ? (table[key] ?? null) : null;
}

const DNS_PILLS: Readonly<Record<string, PillCopy>> = Object.freeze({
  RESOLVES: { label: 'Resolves', tone: 'ok' },
  MISMATCH: { label: 'Mismatch', tone: 'error' },
  UNRESOLVED: { label: 'Unresolved', tone: 'warn' },
  UNAVAILABLE: { label: 'Check unavailable', tone: 'idle' },
});
const DNS_UNCHECKED: PillCopy = Object.freeze({ label: 'Unchecked', tone: 'idle' });

/** `null` is a domain whose DNS was never checked. */
export function dnsPill(status: unknown): PillCopy {
  if (status === null || status === undefined) return DNS_UNCHECKED;
  return lookup(DNS_PILLS, status) ?? UNKNOWN_PILL;
}

const DNS_DETAILS: Readonly<Record<string, string>> = Object.freeze({
  RESOLVES: 'The domain points at this server.',
  MISMATCH: 'The domain resolves, but not to this server. Change its A/AAAA record to the server IP.',
  UNRESOLVED: 'The domain has no A/AAAA record yet. Add one pointing at the server IP; DNS changes can take a few minutes.',
  UNAVAILABLE: 'DNS could not be checked right now. Run the DNS check again in a moment.',
});

export function dnsDetail(status: unknown): string {
  if (status === null || status === undefined) return 'DNS has not been checked yet. Run the DNS check after you add the record.';
  return lookup(DNS_DETAILS, status) ?? 'The DNS status is not recognized by this version of Noodara.';
}

const CERT_PILLS: Readonly<Record<string, PillCopy>> = Object.freeze({
  NONE: { label: 'No certificate', tone: 'idle' },
  PENDING: { label: 'Pending', tone: 'warn' },
  ISSUED: { label: 'Issued', tone: 'ok' },
  RENEWING: { label: 'Renewing', tone: 'warn' },
  FAILED: { label: 'Failed', tone: 'error' },
  EXPIRED: { label: 'Expired', tone: 'error' },
});

export function certPill(status: unknown): PillCopy {
  return lookup(CERT_PILLS, status) ?? UNKNOWN_PILL;
}

const CERT_CAUSES: Readonly<Record<string, string>> = Object.freeze({ ...CERT_FAILURE_MESSAGES } satisfies Record<
  CertFailureCause,
  string
>);

/** The failure cause as text, or null when there is none; an unknown cause gets fixed text. */
export function certFailureCopy(cause: unknown): string | null {
  if (cause === null || cause === undefined) return null;
  return lookup(CERT_CAUSES, cause) ?? 'The certificate could not be issued. Run the DNS check to retry.';
}

const APPLY_COPY: Readonly<Record<string, string>> = Object.freeze({
  PENDING: 'Applying the route on the server proxy.',
  APPLIED: 'The route is live on the server proxy.',
  FAILED: 'The route could not be applied on the server proxy. Run the DNS check to retry.',
});

export function applyStatusCopy(status: unknown): string {
  return lookup(APPLY_COPY, status) ?? 'The route status is not recognized by this version of Noodara.';
}

export const PROXY_SERVES_HTTPS_COPY = 'HTTPS is served by the proxy on this service’s server. Certificates are issued and renewed automatically.';

const PROXY_PILLS: Readonly<Record<string, PillCopy>> = Object.freeze({
  NOT_INSTALLED: { label: 'Not installed', tone: 'idle' },
  INSTALLING: { label: 'Installing', tone: 'warn' },
  RUNNING: { label: 'Running', tone: 'ok' },
  FAILED: { label: 'Failed', tone: 'error' },
});

export function proxyPill(status: unknown): PillCopy {
  return lookup(PROXY_PILLS, status) ?? UNKNOWN_PILL;
}

const PROXY_ERRORS: Readonly<Record<string, string>> = Object.freeze({
  PROXY_PORT_IN_USE: copyForV04ErrorCode('PROXY_PORT_IN_USE'),
  PROXY_INSTALL_FAILED: copyForV04ErrorCode('PROXY_INSTALL_FAILED'),
  PROXY_UNAVAILABLE: copyForV04ErrorCode('PROXY_UNAVAILABLE'),
});

export function proxyFailureCopy(code: unknown): string {
  return lookup(PROXY_ERRORS, code) ?? 'The proxy on this server failed. Try installing it again.';
}

export const HOSTNAME_ERROR_COPY = Object.freeze({
  HOSTNAME_REQUIRED: 'Hostname is required',
  HOSTNAME_TOO_LONG: 'Hostname must be at most 253 characters',
  HOSTNAME_CONTAINS_WHITESPACE: 'Hostname must not contain whitespace',
  HOSTNAME_CONTAINS_SCHEME: 'Enter the hostname only, without http:// or https://',
  HOSTNAME_CONTAINS_PATH: 'Enter the hostname only, without a path, query or fragment',
  HOSTNAME_IP_LITERAL: 'A domain must be a hostname, not an IP address',
  HOSTNAME_CONTAINS_PORT: 'Enter the hostname only, without a port',
  HOSTNAME_WILDCARD: 'Wildcard domains are not supported',
  HOSTNAME_TRAILING_DOT: 'Hostname must not end with a dot',
  HOSTNAME_UPPERCASE: 'Hostname must be lowercase',
  HOSTNAME_LOCALHOST: 'A loopback name cannot be used as a domain',
  HOSTNAME_SINGLE_LABEL: 'Hostname must be a fully qualified domain name (for example app.example.com)',
  HOSTNAME_EMPTY_LABEL: 'Hostname must not contain an empty label (two dots in a row or a leading dot)',
  HOSTNAME_LABEL_TOO_LONG: 'Each hostname label must be at most 63 characters',
  HOSTNAME_INVALID_CHARACTER:
    'Hostname may only contain a-z, 0-9, hyphens and dots; convert an internationalised name to punycode (xn--)',
  HOSTNAME_LABEL_HYPHEN: 'A hostname label must not start or end with a hyphen',
  HOSTNAME_RESERVED_LABEL:
    'A hostname label with "--" in the third and fourth positions is reserved unless it is punycode (xn--)',
  HOSTNAME_NUMERIC_TLD: 'The last label of a hostname must not be numeric',
  HOSTNAME_SPECIAL_USE_TLD: 'Names under this top-level domain are special-use and cannot get a public certificate',
} as const satisfies Record<HostnameErrorCode, string>);

function isHostnameErrorCode(value: unknown): value is HostnameErrorCode {
  return typeof value === 'string' && (HOSTNAME_ERROR_CODES as readonly string[]).includes(value);
}

export type HostnameCheck =
  | { readonly ok: true; readonly hostname: string }
  | { readonly ok: false; readonly code: HostnameErrorCode; readonly message: string };

/** Client-side check with the shared validator: normalise, then validate (same order as the API). */
export function checkHostnameInput(input: string): HostnameCheck {
  const hostname = normaliseHostname(input);
  const result = validateHostname(hostname);
  if (result.ok) return { ok: true, hostname: result.value };
  const code = isHostnameErrorCode(result.code) ? result.code : 'HOSTNAME_REQUIRED';
  return { ok: false, code, message: HOSTNAME_ERROR_COPY[code] };
}

/** A validated hostname or null: the only value the panel ever puts in an href. */
export function safeHostname(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const result = validateHostname(value);
  return result.ok ? result.value : null;
}

export const DOMAIN_GENERIC_FAILURE_COPY = "Couldn't update the domain. Check your connection and try again.";
export const DOMAIN_NOT_FOUND_COPY = 'This domain no longer exists. Refresh to see the current list.';
export const DOMAIN_RATE_LIMITED_COPY = 'Too many DNS checks in a short time. Wait a moment, then try again.';

function isV04Code(value: string): value is V04ServiceErrorCode {
  return (V04_SERVICE_ERROR_CODES as readonly string[]).includes(value);
}

/** Text for a failed domain call: never the raw code, never server free text. */
export function domainFailureCopy(failure: { readonly code: string; readonly reason?: string }): string {
  if (isHostnameErrorCode(failure.reason)) return HOSTNAME_ERROR_COPY[failure.reason];
  if (isV04Code(failure.code)) return copyForV04ErrorCode(failure.code);
  if (failure.code === 'NOT_FOUND') return DOMAIN_NOT_FOUND_COPY;
  if (failure.code === 'RATE_LIMITED') return DOMAIN_RATE_LIMITED_COPY;
  return DOMAIN_GENERIC_FAILURE_COPY;
}
