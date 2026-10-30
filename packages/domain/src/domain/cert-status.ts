// Certificate status of a Domain (TLS-01..03, ADR 0011 A3). The single authority for cert status
// changes: every one of the 36 ordered pairs is asserted in cert-status.test.ts (gate
// coverage-state-machine: 100%). The status is derived from a host-side TLS probe, so the probe is
// ground truth: a valid certificate observed always wins (-> ISSUED), and a certificate that
// disappears (default certificate served again) goes back to PENDING. Those two rules complete the
// ADR table; docs/domain/cert-status-transitions.md lists them.

import type { DnsOutcome } from './dns.js';

export const CERT_STATUSES = Object.freeze([
  'NONE',
  'PENDING',
  'ISSUED',
  'RENEWING',
  'FAILED',
  'EXPIRED',
] as const);

export type CertStatus = (typeof CERT_STATUSES)[number];

export const CERT_FAILURE_CAUSES = Object.freeze([
  'CERT_DNS_MISMATCH',
  'CERT_ISSUANCE_FAILED',
  'CERT_PROXY_UNAVAILABLE',
] as const);

export type CertFailureCause = (typeof CERT_FAILURE_CAUSES)[number];

export const CERT_FAILURE_MESSAGES: Readonly<Record<CertFailureCause, string>> = Object.freeze({
  CERT_DNS_MISMATCH:
    'The certificate was not issued because the domain does not point at this server. Point its A/AAAA record at the server IP, then run the DNS check to retry.',
  CERT_ISSUANCE_FAILED:
    'The certificate authority did not issue a certificate in time. Check that port 80 on the server is reachable from the internet, then run the DNS check to retry.',
  CERT_PROXY_UNAVAILABLE:
    'The proxy on this server is not answering on port 443. Check the noodara-traefik container on the server; the status updates on the next check.',
});

const MINUTE_MS = 60_000;
const DAY_MS = 24 * 60 * MINUTE_MS;

export const DEFAULT_CERT_ISSUE_TIMEOUT_MS = 10 * MINUTE_MS;
export const DEFAULT_CERT_CHECK_INTERVAL_MS = 10 * MINUTE_MS;
/** Traefik renews 30 days before `notAfter`; inside that window the status is RENEWING. */
export const CERT_RENEWAL_WINDOW_MS = 30 * DAY_MS;
/** Checks after a domain change (issuance measured at 2-8 s plus the 2 s throttle). */
export const CERT_POST_CHANGE_CHECK_DELAYS_MS = Object.freeze([15_000, 30_000, 60_000] as const);

export interface CertTimings {
  readonly issueTimeoutMs: number;
  readonly renewalWindowMs: number;
}

export const DEFAULT_CERT_TIMINGS: CertTimings = Object.freeze({
  issueTimeoutMs: DEFAULT_CERT_ISSUE_TIMEOUT_MS,
  renewalWindowMs: CERT_RENEWAL_WINDOW_MS,
});

const TRANSITIONS: Readonly<Record<CertStatus, readonly CertStatus[]>> = Object.freeze({
  NONE: ['PENDING'],
  PENDING: ['ISSUED', 'FAILED'],
  ISSUED: ['RENEWING', 'EXPIRED', 'PENDING'],
  RENEWING: ['ISSUED', 'EXPIRED', 'PENDING'],
  FAILED: ['PENDING', 'ISSUED'],
  EXPIRED: ['ISSUED', 'PENDING'],
} satisfies Record<CertStatus, readonly CertStatus[]>);

export class InvalidCertStatusTransitionError extends Error {
  readonly from: CertStatus;
  readonly to: CertStatus;

  constructor(from: CertStatus, to: CertStatus) {
    super(`Invalid certificate status transition: ${from} -> ${to}`);
    this.name = 'InvalidCertStatusTransitionError';
    this.from = from;
    this.to = to;
  }
}

export function canTransitionCertStatus(from: CertStatus, to: CertStatus): boolean {
  return TRANSITIONS[from].includes(to);
}

/** The only function allowed to produce a new certificate status. */
export function transitionCertStatus(from: CertStatus, to: CertStatus): CertStatus {
  if (!canTransitionCertStatus(from, to)) throw new InvalidCertStatusTransitionError(from, to);
  return to;
}

/** A dns-check RESOLVES or a PATCH retries a FAILED certificate; any other status is kept. */
export function retryCertStatus(status: CertStatus): CertStatus {
  return status === 'FAILED' ? transitionCertStatus(status, 'PENDING') : status;
}

/** Delay before the next check: 15 s, 30 s, 60 s after a change, then `intervalMs`. */
export function certCheckDelayMs(checksSinceChange: number, intervalMs: number): number {
  return CERT_POST_CHANGE_CHECK_DELAYS_MS[Math.max(0, checksSinceChange)] ?? intervalMs;
}

/** The parsed probe line: an issued certificate, Traefik's default certificate, or no listener. */
export type CertProbe =
  | { readonly kind: 'issued'; readonly notAfter: Date }
  | { readonly kind: 'default' }
  | { readonly kind: 'down' };

export interface CertState {
  readonly status: CertStatus;
  readonly notAfter: Date | null;
  readonly errorCode: CertFailureCause | null;
  /** When the domain entered PENDING; null is treated as "just now" (never timed out). */
  readonly pendingSince: Date | null;
  readonly dnsStatus: DnsOutcome | null;
}

export interface CertDecision {
  readonly status: CertStatus;
  readonly notAfter: Date | null;
  readonly errorCode: CertFailureCause | null;
  readonly statusChanged: boolean;
}

function decision(
  current: CertState,
  status: CertStatus,
  notAfter: Date | null,
  errorCode: CertFailureCause | null,
): CertDecision {
  const statusChanged = status !== current.status;
  if (statusChanged) transitionCertStatus(current.status, status);
  return { status, notAfter, errorCode, statusChanged };
}

function issueTimedOut(current: CertState, now: Date, timings: CertTimings): boolean {
  return (
    current.pendingSince !== null &&
    now.getTime() - current.pendingSince.getTime() > timings.issueTimeoutMs
  );
}

function pendingDecision(current: CertState, now: Date, timings: CertTimings): CertDecision {
  if (!issueTimedOut(current, now, timings)) return decision(current, 'PENDING', null, null);
  const cause = current.dnsStatus === 'RESOLVES' ? 'CERT_ISSUANCE_FAILED' : 'CERT_DNS_MISMATCH';
  return decision(current, 'FAILED', null, cause);
}

/** ISSUED, RENEWING or EXPIRED observing a certificate that is still valid at `now`. */
function validCertDecision(
  current: CertState,
  notAfter: Date,
  now: Date,
  timings: CertTimings,
): CertDecision {
  if (current.status === 'RENEWING') {
    const later = current.notAfter === null || notAfter.getTime() > current.notAfter.getTime();
    return decision(current, later ? 'ISSUED' : 'RENEWING', notAfter, null);
  }
  const inWindow = notAfter.getTime() - now.getTime() <= timings.renewalWindowMs;
  return decision(
    current,
    current.status === 'ISSUED' && inWindow ? 'RENEWING' : 'ISSUED',
    notAfter,
    null,
  );
}

/**
 * Pure: the next certificate state for `current` given one probe result at `now`. A proxy that
 * is down keeps the status (FAILED only when a PENDING issuance times out) and records
 * CERT_PROXY_UNAVAILABLE. NONE only leaves through "domain added", never through a probe.
 */
export function decideCertStatus(
  current: CertState,
  probe: CertProbe,
  now: Date,
  timings: CertTimings = DEFAULT_CERT_TIMINGS,
): CertDecision {
  if (probe.kind === 'down') {
    if (current.status === 'PENDING' && issueTimedOut(current, now, timings)) {
      return decision(current, 'FAILED', null, 'CERT_PROXY_UNAVAILABLE');
    }
    return decision(current, current.status, current.notAfter, 'CERT_PROXY_UNAVAILABLE');
  }
  const notAfter = probe.kind === 'issued' ? probe.notAfter : null;
  if (notAfter !== null && !Number.isFinite(notAfter.getTime())) {
    return decision(current, current.status, current.notAfter, current.errorCode);
  }
  const valid = notAfter !== null && notAfter.getTime() >= now.getTime() ? notAfter : null;

  switch (current.status) {
    case 'NONE':
      return decision(current, 'NONE', current.notAfter, current.errorCode);
    case 'PENDING':
      return valid === null
        ? pendingDecision(current, now, timings)
        : decision(current, 'ISSUED', valid, null);
    case 'FAILED':
      return valid === null
        ? decision(current, 'FAILED', current.notAfter, current.errorCode)
        : decision(current, 'ISSUED', valid, null);
    case 'ISSUED':
    case 'RENEWING':
    case 'EXPIRED':
      if (notAfter === null) return decision(current, 'PENDING', null, null);
      if (valid === null) return decision(current, 'EXPIRED', notAfter, null);
      return validCertDecision(current, valid, now, timings);
  }
}
