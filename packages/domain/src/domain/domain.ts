// Domain entity (DMN-01..03, ADR 0011). A hostname routed by the server's proxy to one Service,
// globally unique (DOMAIN_ALREADY_ASSIGNED is enforced by the unique index, 21-05). Create input
// normalises the hostname before validating it; the panel host and an 11th domain are refused.

import { hasKey, parseInputRecord } from '../project/input.js';
import { type ValidationResult, fail, ok } from '../validators/network.js';
import { type CertFailureCause, type CertStatus, transitionCertStatus } from './cert-status.js';
import type { DnsOutcome } from './dns.js';
import {
  type Hostname,
  MAX_DOMAINS_PER_SERVICE,
  isReservedHostname,
  normaliseHostname,
  validateHostname,
} from './hostname.js';

export interface Domain {
  readonly id: string;
  readonly projectId: string;
  readonly serviceId: string;
  readonly hostname: Hostname;
  readonly httpsRedirect: boolean;
  readonly certStatus: CertStatus;
  readonly certNotAfter: Date | null;
  readonly certErrorCode: CertFailureCause | null;
  readonly dnsStatus: DnsOutcome | null;
  readonly dnsCheckedAt: Date | null;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

export interface DomainCreateInput {
  readonly hostname: Hostname;
  readonly httpsRedirect: boolean;
}

export interface DomainEditInput {
  readonly httpsRedirect: boolean;
}

export type DomainAdmissionRejection = 'DOMAIN_RESERVED' | 'DOMAIN_LIMIT_REACHED';

const CREATE_FIELDS: readonly string[] = ['hostname', 'httpsRedirect'];
const EDIT_FIELDS: readonly string[] = ['httpsRedirect'];

function invalidRedirect<T>(): ValidationResult<T> {
  return fail('DOMAIN_HTTPS_REDIRECT_INVALID', 'httpsRedirect must be true or false');
}

export function validateDomainCreateInput(input: unknown): ValidationResult<DomainCreateInput> {
  const record = parseInputRecord(input, CREATE_FIELDS, 'DOMAIN', 'Domain');
  if (!record.ok) return record;
  const raw = record.value.hostname;
  const hostname = validateHostname(typeof raw === 'string' ? normaliseHostname(raw) : raw);
  if (!hostname.ok) return hostname;
  const redirect = hasKey(record.value, 'httpsRedirect') ? record.value.httpsRedirect : true;
  if (typeof redirect !== 'boolean') return invalidRedirect();
  return ok({ hostname: hostname.value, httpsRedirect: redirect });
}

/** Only `httpsRedirect` is editable; a hostname change is a delete plus a create. */
export function validateDomainEditInput(input: unknown): ValidationResult<DomainEditInput> {
  const record = parseInputRecord(input, EDIT_FIELDS, 'DOMAIN', 'Domain');
  if (!record.ok) return record;
  const redirect = record.value.httpsRedirect;
  if (typeof redirect !== 'boolean') return invalidRedirect();
  return ok({ httpsRedirect: redirect });
}

/** Why a validated hostname cannot be added to a service, or null when it can. */
export function domainAdmissionRejection(input: {
  readonly hostname: Hostname | string;
  readonly publicUrlHost: string | null | undefined;
  readonly existingDomainCount: number;
}): DomainAdmissionRejection | null {
  if (isReservedHostname(input.hostname, input.publicUrlHost)) return 'DOMAIN_RESERVED';
  if (input.existingDomainCount >= MAX_DOMAINS_PER_SERVICE) return 'DOMAIN_LIMIT_REACHED';
  return null;
}

/** Certificate columns of a new row: "domain added" moves NONE -> PENDING. */
export function initialDomainCertState(): {
  readonly certStatus: CertStatus;
  readonly certNotAfter: null;
  readonly certErrorCode: null;
} {
  return {
    certStatus: transitionCertStatus('NONE', 'PENDING'),
    certNotAfter: null,
    certErrorCode: null,
  };
}
