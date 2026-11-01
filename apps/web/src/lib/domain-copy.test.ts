import { describe, expect, it } from 'vitest';
import { CERT_FAILURE_CAUSES, CERT_STATUSES, DNS_OUTCOMES, HOSTNAME_ERROR_CODES, PROXY_STATUSES, validateHostname } from '@noodara/domain';
import {
  applyStatusCopy,
  certFailureCopy,
  certPill,
  checkHostnameInput,
  dnsDetail,
  dnsPill,
  DOMAIN_GENERIC_FAILURE_COPY,
  DOMAIN_NOT_FOUND_COPY,
  DOMAIN_RATE_LIMITED_COPY,
  domainFailureCopy,
  HOSTNAME_ERROR_COPY,
  proxyFailureCopy,
  proxyPill,
  safeHostname,
  UNKNOWN_STATUS_LABEL,
} from './domain-copy';
import { V04_ERROR_COPY } from './error-copy';

const TONES = ['ok', 'warn', 'error', 'idle'];

describe('domain-copy pills', () => {
  it('maps every DNS outcome to a word and a semantic tone, and null to Unchecked', () => {
    for (const outcome of DNS_OUTCOMES) {
      const pill = dnsPill(outcome);
      expect(pill.label).not.toBe(UNKNOWN_STATUS_LABEL);
      expect(TONES).toContain(pill.tone);
      expect(dnsDetail(outcome)).not.toMatch(/not recognized/);
    }
    expect(dnsPill(null)).toEqual({ label: 'Unchecked', tone: 'idle' });
    expect(dnsPill('RESOLVES')).toEqual({ label: 'Resolves', tone: 'ok' });
    expect(dnsPill('MISMATCH').tone).toBe('error');
    expect(dnsPill('UNRESOLVED')).toEqual({ label: 'Unresolved', tone: 'warn' });
    expect(dnsDetail(null)).toMatch(/not been checked/);
  });

  it('maps every certificate status, ISSUED ok and FAILED/EXPIRED error', () => {
    for (const status of CERT_STATUSES) expect(certPill(status).label).not.toBe(UNKNOWN_STATUS_LABEL);
    expect(certPill('NONE')).toEqual({ label: 'No certificate', tone: 'idle' });
    expect(certPill('PENDING').label).toBe('Pending');
    expect(certPill('ISSUED')).toEqual({ label: 'Issued', tone: 'ok' });
    expect(certPill('RENEWING').label).toBe('Renewing');
    expect(certPill('FAILED').tone).toBe('error');
    expect(certPill('EXPIRED')).toEqual({ label: 'Expired', tone: 'error' });
  });

  it('maps every proxy status', () => {
    for (const status of PROXY_STATUSES) expect(proxyPill(status).label).not.toBe(UNKNOWN_STATUS_LABEL);
    expect(proxyPill('INSTALLING').tone).toBe('warn');
    expect(proxyPill('FAILED').tone).toBe('error');
  });

  it.each([
    ['dns', dnsPill],
    ['cert', certPill],
    ['proxy', proxyPill],
  ] as const)('falls back to Unknown for an unrecognized %s status, never the raw string', (_name, fn) => {
    for (const value of ['WEIRD_NEW', 'toString', '__proto__', 42, {}]) {
      expect(fn(value)).toEqual({ label: UNKNOWN_STATUS_LABEL, tone: 'idle' });
    }
  });

  it('gives fixed text for unknown DNS, apply, cert-cause and proxy-error values', () => {
    expect(dnsDetail('WEIRD')).toMatch(/not recognized/);
    expect(applyStatusCopy('WEIRD')).toMatch(/not recognized/);
    expect(applyStatusCopy('APPLIED')).toMatch(/live/);
    expect(applyStatusCopy('PENDING')).toMatch(/Applying/);
    expect(applyStatusCopy('FAILED')).toMatch(/could not be applied/);
    expect(certFailureCopy(null)).toBeNull();
    expect(certFailureCopy('WEIRD')).not.toContain('WEIRD');
    for (const cause of CERT_FAILURE_CAUSES) expect(certFailureCopy(cause)).not.toContain(cause);
    expect(proxyFailureCopy('PROXY_PORT_IN_USE')).toBe(V04_ERROR_COPY.PROXY_PORT_IN_USE);
    expect(proxyFailureCopy(null)).toMatch(/proxy/);
  });
});

describe('checkHostnameInput', () => {
  it('normalises then accepts a valid hostname', () => {
    expect(checkHostnameInput('  App.Example.COM. ')).toEqual({ ok: true, hostname: 'app.example.com' });
  });

  it.each([
    ['', 'HOSTNAME_REQUIRED'],
    ['https://app.example.com', 'HOSTNAME_CONTAINS_SCHEME'],
    ['app.example.com/x', 'HOSTNAME_CONTAINS_PATH'],
    ['10.0.0.1', 'HOSTNAME_IP_LITERAL'],
    ['app.example.com:8080', 'HOSTNAME_CONTAINS_PORT'],
    ['*.example.com', 'HOSTNAME_WILDCARD'],
    ['localhost', 'HOSTNAME_LOCALHOST'],
    ['intranet', 'HOSTNAME_SINGLE_LABEL'],
    ['app.local', 'HOSTNAME_SPECIAL_USE_TLD'],
  ])('rejects %j with the shared validator code %s and fixed copy', (input, code) => {
    const result = checkHostnameInput(input);
    expect(result).toEqual({ ok: false, code, message: HOSTNAME_ERROR_COPY[code as keyof typeof HOSTNAME_ERROR_COPY] });
    if (!result.ok && input !== '') expect(result.message).not.toContain(input);
  });

  it('has copy for every validator code, matching the validator text where it is fixed', () => {
    expect(Object.keys(HOSTNAME_ERROR_COPY).sort()).toEqual([...HOSTNAME_ERROR_CODES].sort());
    const sample = validateHostname('a b.com');
    expect(sample.ok).toBe(false);
    if (!sample.ok) expect(HOSTNAME_ERROR_COPY.HOSTNAME_CONTAINS_WHITESPACE).toBe(sample.message);
  });
});

describe('safeHostname', () => {
  it('returns only validated hostnames', () => {
    expect(safeHostname('app.example.com')).toBe('app.example.com');
    expect(safeHostname('javascript:alert(1)')).toBeNull();
    expect(safeHostname('evil.com/@x')).toBeNull();
    expect(safeHostname(null)).toBeNull();
  });
});

describe('domainFailureCopy', () => {
  it('routes a hostname reason, a v0.4 code, not found, rate limit and anything else to fixed copy', () => {
    expect(domainFailureCopy({ code: 'INTERNAL_ERROR', reason: 'HOSTNAME_WILDCARD' })).toBe(HOSTNAME_ERROR_COPY.HOSTNAME_WILDCARD);
    expect(domainFailureCopy({ code: 'DOMAIN_ALREADY_ASSIGNED' })).toBe(V04_ERROR_COPY.DOMAIN_ALREADY_ASSIGNED);
    expect(domainFailureCopy({ code: 'NOT_FOUND' })).toBe(DOMAIN_NOT_FOUND_COPY);
    expect(domainFailureCopy({ code: 'RATE_LIMITED' })).toBe(DOMAIN_RATE_LIMITED_COPY);
    expect(domainFailureCopy({ code: 'SOMETHING_ELSE', reason: 'NOT_A_HOSTNAME_CODE' })).toBe(DOMAIN_GENERIC_FAILURE_COPY);
  });
});
