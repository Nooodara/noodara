// D-03/ADR-0004: unit tests for the injectable email-domain MX/A checker. Every test substitutes
// a hand-built fake implementing `DnsResolverLike` — never `vi.mock('node:dns')` — so this suite
// never depends on the machine's real resolver (ADR 0004's lesson).
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createDnsChecker, EMAIL_DOMAIN_LOOKUP_TIMEOUT_MS, type DnsResolverLike } from './dns-checker.js';

function dnsError(code: string): NodeJS.ErrnoException {
  const err = new Error(code) as NodeJS.ErrnoException;
  err.code = code;
  return err;
}

function fakeResolver(overrides: Partial<DnsResolverLike> = {}): DnsResolverLike {
  return {
    resolveMx: overrides.resolveMx ?? (() => Promise.reject(dnsError('ENOTFOUND'))),
    resolve4: overrides.resolve4 ?? (() => Promise.reject(dnsError('ENOTFOUND'))),
    cancel: overrides.cancel,
  };
}

afterEach(() => {
  vi.useRealTimers();
});

describe('createDnsChecker', () => {
  it('is resolvable when resolveMx returns at least one MX record', async () => {
    const resolver = fakeResolver({
      resolveMx: () => Promise.resolve([{ exchange: 'mx.example.com', priority: 10 }]),
    });
    const checker = createDnsChecker({ resolver });

    await expect(checker.checkEmailDomain('example.com')).resolves.toBe('resolvable');
  });

  it('is resolvable when resolveMx rejects with ENODATA but resolve4 returns an address', async () => {
    const resolver = fakeResolver({
      resolveMx: () => Promise.reject(dnsError('ENODATA')),
      resolve4: () => Promise.resolve(['93.184.215.14']),
    });
    const checker = createDnsChecker({ resolver });

    await expect(checker.checkEmailDomain('example.com')).resolves.toBe('resolvable');
  });

  it('is unresolvable when both resolveMx and resolve4 reject with ENOTFOUND', async () => {
    const resolver = fakeResolver({
      resolveMx: () => Promise.reject(dnsError('ENOTFOUND')),
      resolve4: () => Promise.reject(dnsError('ENOTFOUND')),
    });
    const checker = createDnsChecker({ resolver });

    await expect(checker.checkEmailDomain('nowhere.example')).resolves.toBe('unresolvable');
  });

  it('is unresolvable when both resolveMx and resolve4 reject with ENODATA', async () => {
    const resolver = fakeResolver({
      resolveMx: () => Promise.reject(dnsError('ENODATA')),
      resolve4: () => Promise.reject(dnsError('ENODATA')),
    });
    const checker = createDnsChecker({ resolver });

    await expect(checker.checkEmailDomain('nowhere.example')).resolves.toBe('unresolvable');
  });

  it('is unresolvable when both resolveMx and resolve4 fulfil with empty arrays', async () => {
    const resolver = fakeResolver({
      resolveMx: () => Promise.resolve([]),
      resolve4: () => Promise.resolve([]),
    });
    const checker = createDnsChecker({ resolver });

    await expect(checker.checkEmailDomain('nowhere.example')).resolves.toBe('unresolvable');
  });

  it('is unavailable when one lookup times out/fails transiently and the other is merely ENODATA', async () => {
    const resolver = fakeResolver({
      resolveMx: () => Promise.reject(dnsError('ETIMEOUT')),
      resolve4: () => Promise.reject(dnsError('ENODATA')),
    });
    const checker = createDnsChecker({ resolver });

    await expect(checker.checkEmailDomain('flaky.example')).resolves.toBe('unavailable');
  });

  it('is unavailable when resolveMx rejects with ESERVFAIL and resolve4 rejects with ENODATA', async () => {
    const resolver = fakeResolver({
      resolveMx: () => Promise.reject(dnsError('ESERVFAIL')),
      resolve4: () => Promise.reject(dnsError('ENODATA')),
    });
    const checker = createDnsChecker({ resolver });

    await expect(checker.checkEmailDomain('flaky.example')).resolves.toBe('unavailable');
  });

  it('is unavailable when resolveMx rejects with ECONNREFUSED and resolve4 rejects with ENODATA', async () => {
    const resolver = fakeResolver({
      resolveMx: () => Promise.reject(dnsError('ECONNREFUSED')),
      resolve4: () => Promise.reject(dnsError('ENODATA')),
    });
    const checker = createDnsChecker({ resolver });

    await expect(checker.checkEmailDomain('flaky.example')).resolves.toBe('unavailable');
  });

  it('is unavailable when resolveMx rejects with EREFUSED and resolve4 rejects with ENODATA', async () => {
    const resolver = fakeResolver({
      resolveMx: () => Promise.reject(dnsError('EREFUSED')),
      resolve4: () => Promise.reject(dnsError('ENODATA')),
    });
    const checker = createDnsChecker({ resolver });

    await expect(checker.checkEmailDomain('flaky.example')).resolves.toBe('unavailable');
  });

  it('is unavailable after exactly the timeout when the resolver never settles, and calls resolver.cancel()', async () => {
    vi.useFakeTimers();
    const cancel = vi.fn();
    const resolver = fakeResolver({
      resolveMx: () => new Promise<never>(() => undefined),
      resolve4: () => new Promise<never>(() => undefined),
      cancel,
    });
    const checker = createDnsChecker({ resolver, timeoutMs: 500 });

    const pending = checker.checkEmailDomain('hangs.example');
    const assertion = expect(pending).resolves.toBe('unavailable');

    await vi.advanceTimersByTimeAsync(500);
    await assertion;

    expect(cancel).toHaveBeenCalledTimes(1);
  });

  it('uses EMAIL_DOMAIN_LOOKUP_TIMEOUT_MS as the default bound when no explicit timeoutMs is passed', async () => {
    vi.useFakeTimers();
    const resolver = fakeResolver({
      resolveMx: () => new Promise<never>(() => undefined),
      resolve4: () => new Promise<never>(() => undefined),
    });
    const checker = createDnsChecker({ resolver });

    const pending = checker.checkEmailDomain('hangs.example');
    const assertion = expect(pending).resolves.toBe('unavailable');

    await vi.advanceTimersByTimeAsync(EMAIL_DOMAIN_LOOKUP_TIMEOUT_MS);
    await assertion;
  });

  it('clears the timer on the fast-resolution path (no leaked timer)', async () => {
    const clearSpy = vi.spyOn(global, 'clearTimeout');
    const resolver = fakeResolver({
      resolveMx: () => Promise.resolve([{ exchange: 'mx.example.com', priority: 10 }]),
    });
    const checker = createDnsChecker({ resolver });

    await checker.checkEmailDomain('example.com');

    expect(clearSpy).toHaveBeenCalled();
    clearSpy.mockRestore();
  });

  it('rejects an empty domain as unresolvable without calling the resolver', async () => {
    const resolveMx = vi.fn(() => Promise.resolve([{ exchange: 'mx.example.com', priority: 10 }]));
    const resolve4 = vi.fn(() => Promise.resolve(['93.184.215.14']));
    const checker = createDnsChecker({ resolver: fakeResolver({ resolveMx, resolve4 }) });

    await expect(checker.checkEmailDomain('')).resolves.toBe('unresolvable');
    expect(resolveMx).not.toHaveBeenCalled();
    expect(resolve4).not.toHaveBeenCalled();
  });

  it('rejects a domain longer than 253 characters as unresolvable without calling the resolver', async () => {
    const resolveMx = vi.fn(() => Promise.resolve([{ exchange: 'mx.example.com', priority: 10 }]));
    const longDomain = `${'a'.repeat(250)}.com`; // > 253 chars total
    const checker = createDnsChecker({ resolver: fakeResolver({ resolveMx }) });

    await expect(checker.checkEmailDomain(longDomain)).resolves.toBe('unresolvable');
    expect(resolveMx).not.toHaveBeenCalled();
  });

  it('rejects a domain with a label longer than 63 characters as unresolvable without calling the resolver', async () => {
    const resolveMx = vi.fn(() => Promise.resolve([{ exchange: 'mx.example.com', priority: 10 }]));
    const longLabel = `${'a'.repeat(64)}.com`;
    const checker = createDnsChecker({ resolver: fakeResolver({ resolveMx }) });

    await expect(checker.checkEmailDomain(longLabel)).resolves.toBe('unresolvable');
    expect(resolveMx).not.toHaveBeenCalled();
  });

  it('rejects a domain with characters outside [a-z0-9-.] as unresolvable without calling the resolver', async () => {
    const resolveMx = vi.fn(() => Promise.resolve([{ exchange: 'mx.example.com', priority: 10 }]));
    const checker = createDnsChecker({ resolver: fakeResolver({ resolveMx }) });

    await expect(checker.checkEmailDomain('exa mple!.com')).resolves.toBe('unresolvable');
    expect(resolveMx).not.toHaveBeenCalled();
  });

  it('rejects a domain with a leading hyphen in a label as unresolvable without calling the resolver', async () => {
    const resolveMx = vi.fn(() => Promise.resolve([{ exchange: 'mx.example.com', priority: 10 }]));
    const checker = createDnsChecker({ resolver: fakeResolver({ resolveMx }) });

    await expect(checker.checkEmailDomain('-example.com')).resolves.toBe('unresolvable');
    expect(resolveMx).not.toHaveBeenCalled();
  });

  it('rejects a domain with a trailing hyphen in a label as unresolvable without calling the resolver', async () => {
    const resolveMx = vi.fn(() => Promise.resolve([{ exchange: 'mx.example.com', priority: 10 }]));
    const checker = createDnsChecker({ resolver: fakeResolver({ resolveMx }) });

    await expect(checker.checkEmailDomain('example-.com')).resolves.toBe('unresolvable');
    expect(resolveMx).not.toHaveBeenCalled();
  });

  it('lowercases the domain before the lookup', async () => {
    const seen: string[] = [];
    const resolver = fakeResolver({
      resolveMx: (hostname: string) => {
        seen.push(hostname);
        return Promise.resolve([{ exchange: 'mx.example.com', priority: 10 }]);
      },
    });
    const checker = createDnsChecker({ resolver });

    await checker.checkEmailDomain('EXAMPLE.COM');

    expect(seen).toStrictEqual(['example.com']);
  });

  it('never throws, mapping an unexpected synchronous-style rejection to unavailable', async () => {
    const resolver = fakeResolver({
      resolveMx: () => Promise.reject(new Error('boom, not a DNS error at all')),
      resolve4: () => Promise.reject(new Error('boom, not a DNS error at all')),
    });
    const checker = createDnsChecker({ resolver });

    await expect(checker.checkEmailDomain('example.com')).resolves.toBe('unavailable');
  });
});
