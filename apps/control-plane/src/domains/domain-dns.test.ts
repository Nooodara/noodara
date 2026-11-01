// 22-03 (A3): the advisory DNS check goes through the DnsResolverLike seam only, is bounded,
// resolves nothing but the domain and the server host, and is rate-limited per domain.
import { describe, expect, it, vi } from 'vitest';
import {
  checkDomainDns,
  createDnsCheckLimiter,
  instructionsFor,
  lookupAddresses,
  serverAddresses,
  type DnsResolverLike,
} from './domain-dns.js';

function dnsError(code: string): Error {
  return Object.assign(new Error(code), { code });
}

function resolver(table: Record<string, { a?: string[] | Error; aaaa?: string[] | Error }>): DnsResolverLike & {
  asked: string[];
} {
  const asked: string[] = [];
  const answer = (value: string[] | Error | undefined) =>
    value instanceof Error ? Promise.reject(value) : Promise.resolve(value ?? []);
  return {
    asked,
    resolve4: (hostname) => {
      asked.push(hostname);
      const entry = table[hostname];
      return entry === undefined ? Promise.reject(dnsError('ENOTFOUND')) : answer(entry.a);
    },
    resolve6: (hostname) => {
      asked.push(hostname);
      const entry = table[hostname];
      return entry === undefined ? Promise.reject(dnsError('ENOTFOUND')) : answer(entry.aaaa ?? dnsError('ENODATA'));
    },
  };
}

describe('lookupAddresses', () => {
  it('joins A and AAAA answers', async () => {
    const r = resolver({ 'app.example.com': { a: ['203.0.113.7'], aaaa: ['2001:db8::7'] } });
    expect(await lookupAddresses(r, 'app.example.com')).toEqual({ kind: 'addresses', addresses: ['203.0.113.7', '2001:db8::7'] });
  });

  it('ENOTFOUND / ENODATA on both is not-found; any other failure is an error', async () => {
    expect(await lookupAddresses(resolver({}), 'gone.example.com')).toEqual({ kind: 'not-found' });
    const broken = resolver({ 'x.example.com': { a: dnsError('ESERVFAIL'), aaaa: dnsError('ENODATA') } });
    expect(await lookupAddresses(broken, 'x.example.com')).toEqual({ kind: 'error' });
  });

  it('times out as an error and cancels the resolver', async () => {
    vi.useFakeTimers();
    try {
      const cancel = vi.fn();
      const hanging: DnsResolverLike = {
        resolve4: () => new Promise(() => undefined),
        resolve6: () => new Promise(() => undefined),
        cancel,
      };
      const pending = lookupAddresses(hanging, 'slow.example.com', 3000);
      await vi.advanceTimersByTimeAsync(3000);
      expect(await pending).toEqual({ kind: 'error' });
      expect(cancel).toHaveBeenCalledOnce();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('checkDomainDns', () => {
  it('RESOLVES when the domain points at the IP-literal server; only the domain is resolved', async () => {
    const r = resolver({ 'app.example.com': { a: ['203.0.113.7'] } });
    expect(await checkDomainDns(r, 'app.example.com', '203.0.113.7')).toBe('RESOLVES');
    expect(new Set(r.asked)).toEqual(new Set(['app.example.com']));
  });

  it('MISMATCH, UNRESOLVED, and a server host resolved by name', async () => {
    const r = resolver({
      'app.example.com': { a: ['198.51.100.1'] },
      'vps.example.net': { a: ['203.0.113.7'] },
    });
    expect(await checkDomainDns(r, 'app.example.com', 'vps.example.net')).toBe('MISMATCH');
    expect(await checkDomainDns(r, 'none.example.com', '203.0.113.7')).toBe('UNRESOLVED');
    expect(new Set(r.asked)).toEqual(new Set(['app.example.com', 'vps.example.net', 'none.example.com']));
  });

  it('never resolves an invalid hostname or server host', async () => {
    const r = resolver({});
    expect(await checkDomainDns(r, 'bad host;rm -rf', '203.0.113.7')).toBe('UNAVAILABLE');
    expect(await serverAddresses(r, '-bad-')).toBeNull();
    expect(r.asked).toEqual([]);
  });

  it('UNAVAILABLE when the domain answers but the server host does not resolve', async () => {
    const r = resolver({ 'app.example.com': { a: ['203.0.113.7'] } });
    expect(await checkDomainDns(r, 'app.example.com', 'vps.example.net')).toBe('UNAVAILABLE');
  });
});

describe('instructionsFor', () => {
  it('A record to an IP-literal server, CNAME alternative otherwise', () => {
    expect(instructionsFor('app.example.com', '203.0.113.7')).toMatchObject({
      hostname: 'app.example.com',
      records: [{ type: 'A', name: 'app.example.com', value: '203.0.113.7' }],
      cnameAlternative: { type: 'CNAME', name: 'app.example.com', target: null },
    });
    expect(instructionsFor('app.example.com', 'vps.example.net')).toMatchObject({
      records: [],
      cnameAlternative: { target: 'vps.example.net' },
    });
  });
});

describe('createDnsCheckLimiter', () => {
  it('allows one check per domain per interval', () => {
    let now = 0;
    const limiter = createDnsCheckLimiter(10_000, () => now);
    expect(limiter.take('a')).toBe(true);
    expect(limiter.take('a')).toBe(false);
    expect(limiter.take('b')).toBe(true);
    now = 10_000;
    expect(limiter.take('a')).toBe(true);
  });
});
