import { describe, expect, it } from 'vitest';
import { MAX_DOMAINS_PER_SERVICE } from './hostname.js';
import {
  domainAdmissionRejection,
  initialDomainCertState,
  validateDomainCreateInput,
  validateDomainEditInput,
} from './domain.js';

describe('validateDomainCreateInput', () => {
  it('normalises the hostname and defaults httpsRedirect to on', () => {
    expect(validateDomainCreateInput({ hostname: ' App.Example.com. ' })).toEqual({
      ok: true,
      value: { hostname: 'app.example.com', httpsRedirect: true },
    });
  });

  it('keeps an explicit httpsRedirect', () => {
    expect(
      validateDomainCreateInput({
        hostname: 'app.example.com',
        httpsRedirect: false,
      }),
    ).toEqual({
      ok: true,
      value: { hostname: 'app.example.com', httpsRedirect: false },
    });
  });

  it.each<[string, unknown, string]>([
    ['not an object', 'app.example.com', 'DOMAIN_INVALID'],
    ['array', [], 'DOMAIN_INVALID'],
    [
      'unknown key',
      { hostname: 'app.example.com', certStatus: 'ISSUED' },
      'DOMAIN_UNSUPPORTED_FIELD',
    ],
    ['missing hostname', {}, 'HOSTNAME_REQUIRED'],
    ['numeric hostname', { hostname: 7 }, 'HOSTNAME_REQUIRED'],
    ['rejected hostname', { hostname: 'printer.local' }, 'HOSTNAME_SPECIAL_USE_TLD'],
    ['path', { hostname: 'app.example.com/x' }, 'HOSTNAME_CONTAINS_PATH'],
    [
      'non-boolean redirect',
      { hostname: 'a.example.com', httpsRedirect: 'yes' },
      'DOMAIN_HTTPS_REDIRECT_INVALID',
    ],
  ])('rejects %s', (_name, input, code) => {
    const result = validateDomainCreateInput(input);
    expect(result.ok).toBe(false);
    expect(result.ok ? null : result.code).toBe(code);
  });
});

describe('validateDomainEditInput', () => {
  it('accepts an httpsRedirect switch', () => {
    expect(validateDomainEditInput({ httpsRedirect: false })).toEqual({
      ok: true,
      value: { httpsRedirect: false },
    });
  });

  it.each<[string, unknown, string]>([
    ['not an object', null, 'DOMAIN_INVALID'],
    ['hostname change', { hostname: 'b.example.com' }, 'DOMAIN_UNSUPPORTED_FIELD'],
    ['empty edit', {}, 'DOMAIN_HTTPS_REDIRECT_INVALID'],
    ['non-boolean', { httpsRedirect: 1 }, 'DOMAIN_HTTPS_REDIRECT_INVALID'],
  ])('rejects %s', (_name, input, code) => {
    const result = validateDomainEditInput(input);
    expect(result.ok ? null : result.code).toBe(code);
  });
});

describe('domainAdmissionRejection (A4)', () => {
  const base = {
    hostname: 'app.example.com',
    publicUrlHost: 'panel.example.com',
  };

  it('admits a hostname under the limit that is not the panel host', () => {
    expect(domainAdmissionRejection({ ...base, existingDomainCount: 0 })).toBeNull();
    expect(
      domainAdmissionRejection({
        ...base,
        existingDomainCount: MAX_DOMAINS_PER_SERVICE - 1,
      }),
    ).toBeNull();
  });

  it('rejects the panel host as DOMAIN_RESERVED', () => {
    expect(
      domainAdmissionRejection({
        hostname: 'panel.example.com',
        publicUrlHost: 'panel.example.com',
        existingDomainCount: 0,
      }),
    ).toBe('DOMAIN_RESERVED');
  });

  it('rejects the eleventh domain as DOMAIN_LIMIT_REACHED', () => {
    expect(
      domainAdmissionRejection({
        ...base,
        existingDomainCount: MAX_DOMAINS_PER_SERVICE,
      }),
    ).toBe('DOMAIN_LIMIT_REACHED');
    expect(domainAdmissionRejection({ ...base, existingDomainCount: 25 })).toBe(
      'DOMAIN_LIMIT_REACHED',
    );
  });
});

describe('initialDomainCertState', () => {
  it('enters PENDING through NONE -> PENDING (domain added)', () => {
    expect(initialDomainCertState()).toEqual({
      certStatus: 'PENDING',
      certNotAfter: null,
      certErrorCode: null,
    });
  });
});
