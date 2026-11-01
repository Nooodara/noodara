import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  addDomain,
  checkDomainDns,
  listDomains,
  readProxy,
  removeDomain,
  retryProxyInstall,
  setHttpsRedirect,
  toDomainList,
  toDomainRow,
} from './domain-api';

const P = '11111111-1111-4111-8111-111111111111';
const S = '44444444-4444-4444-8444-444444444444';
const D = '66666666-6666-4666-8666-666666666666';
const SRV = '55555555-5555-4555-8555-555555555555';

const DOMAIN = {
  id: D,
  projectId: P,
  serviceId: S,
  hostname: 'app.example.com',
  httpsRedirect: true,
  certStatus: 'PENDING',
  certNotAfter: null,
  certErrorCode: null,
  dnsStatus: null,
  dnsCheckedAt: null,
  applyStatus: 'APPLIED',
  createdAt: '2026-10-30T00:00:00.000Z',
  updatedAt: '2026-10-30T00:00:00.000Z',
};

function mockFetch(body: unknown = {}, status = 200) {
  const fn = vi.fn(() =>
    Promise.resolve(
      status === 204
        ? new Response(null, { status })
        : new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } }),
    ),
  );
  vi.stubGlobal('fetch', fn);
  return fn;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('domain-api', () => {
  it('calls the domain routes with the right methods, paths and bodies', async () => {
    const fn = mockFetch(DOMAIN);
    await addDomain(P, S, 'app.example.com');
    await setHttpsRedirect(P, S, D, false);
    await checkDomainDns(P, S, D);
    const calls = fn.mock.calls as unknown as [string, RequestInit][];
    expect(calls.map(([url, init]) => `${init.method ?? '?'} ${url} ${typeof init.body === 'string' ? init.body : ''}`)).toEqual([
      `POST /api/projects/${P}/services/${S}/domains {"hostname":"app.example.com"}`,
      `PATCH /api/projects/${P}/services/${S}/domains/${D} {"httpsRedirect":false}`,
      `POST /api/projects/${P}/services/${S}/domains/${D}/dns-check {}`,
    ]);
  });

  it('lists domains with their DNS instructions', async () => {
    mockFetch({
      items: [DOMAIN],
      dnsInstructions: [
        {
          hostname: 'app.example.com',
          records: [{ type: 'A', name: 'app.example.com', value: '203.0.113.7' }],
          cnameAlternative: { type: 'CNAME', name: 'app.example.com', target: null },
        },
      ],
    });
    const result = await listDomains(P, S);
    expect(result.ok && result.data.items[0]?.hostname).toBe('app.example.com');
    expect(result.ok && result.data.dnsInstructions[0]?.records).toEqual([{ type: 'A', name: 'app.example.com', value: '203.0.113.7' }]);
  });

  it('removes a domain on 204', async () => {
    const fn = mockFetch(null, 204);
    expect(await removeDomain(P, S, D)).toEqual({ ok: true, data: null });
    const [url, init] = (fn.mock.calls as unknown as [string, RequestInit][])[0] ?? ['', {}];
    expect(`${init.method ?? ''} ${url}`).toBe(`DELETE /api/projects/${P}/services/${S}/domains/${D}`);
  });

  it('retries the proxy install and reads only the proxy fields', async () => {
    const fn = mockFetch({ id: SRV, name: 'edge', proxyStatus: 'INSTALLING', proxyErrorCode: null, hostFingerprint: 'x' });
    const result = await retryProxyInstall(SRV);
    expect(result).toEqual({ ok: true, data: { status: 'INSTALLING', errorCode: null } });
    expect((fn.mock.calls as unknown as [string, RequestInit][])[0]?.[0]).toBe(`/api/servers/${SRV}/proxy`);
  });

  it('refuses unsafe ids without fetching', async () => {
    const fn = mockFetch(DOMAIN);
    for (const result of await Promise.all([
      listDomains('../x', S),
      addDomain(P, 'a/b', 'app.example.com'),
      setHttpsRedirect(P, S, '../../x', true),
      checkDomainDns(P, S, 'x?y'),
      removeDomain(P, S, ''),
      retryProxyInstall('../../x'),
    ])) {
      expect(result.ok).toBe(false);
    }
    expect(fn).not.toHaveBeenCalled();
  });

  it('turns a malformed success body into a failure', async () => {
    mockFetch({ nope: true });
    expect((await addDomain(P, S, 'app.example.com')).ok).toBe(false);
    expect((await listDomains(P, S)).ok).toBe(false);
    expect((await retryProxyInstall(SRV)).ok).toBe(false);
  });

  it('passes failures through with their safe reason', async () => {
    mockFetch({ error: 'DOMAIN_INPUT_INVALID', message: 'x', reason: 'HOSTNAME_WILDCARD' }, 422);
    const result = await addDomain(P, S, '*.example.com');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('HOSTNAME_WILDCARD');
  });
});

describe('response readers', () => {
  it('drops unknown fields and keeps unknown statuses as strings', () => {
    const row = toDomainRow({ ...DOMAIN, certStatus: 'BRAND_NEW', extra: '<script>' });
    expect(row).not.toHaveProperty('extra');
    expect(row?.certStatus).toBe('BRAND_NEW');
    expect(row).not.toHaveProperty('projectId');
  });

  it('rejects rows without an id or hostname, and tolerates odd shapes', () => {
    expect(toDomainRow(null)).toBeNull();
    expect(toDomainRow({ id: D })).toBeNull();
    expect(toDomainRow([])).toBeNull();
    const row = toDomainRow({ id: D, hostname: 'a.example.com', httpsRedirect: 'yes', certStatus: 1 });
    expect(row?.httpsRedirect).toBe(false);
    expect(row?.certStatus).toBe('');
    expect(toDomainList({ items: 'x' })).toBeNull();
    expect(
      toDomainList({
        items: [DOMAIN, { bad: true }],
        dnsInstructions: [{ hostname: 'a.example.com', records: [{ type: 'A' }, 'x'], cnameAlternative: 3 }, null],
      }),
    ).toEqual({
      items: [toDomainRow(DOMAIN)],
      dnsInstructions: [{ hostname: 'a.example.com', records: [], cnameAlternative: null }],
    });
    expect(toDomainList({ items: [] })).toEqual({ items: [], dnsInstructions: [] });
  });

  it('reads the proxy state from a server view, null when absent', () => {
    expect(readProxy({ proxyStatus: 'FAILED', proxyErrorCode: 'PROXY_PORT_IN_USE' })).toEqual({ status: 'FAILED', errorCode: 'PROXY_PORT_IN_USE' });
    expect(readProxy({ name: 'x' })).toBeNull();
    expect(readProxy(null)).toBeNull();
  });
});
