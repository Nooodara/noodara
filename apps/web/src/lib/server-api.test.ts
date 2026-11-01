import { afterEach, describe, expect, it, vi } from 'vitest';
import { installProxy, readServerProxy, removeProxy, setProxyAcmeEmail } from './server-api';

const SRV = '55555555-5555-4555-8555-555555555555';

const SERVER = {
  id: SRV,
  name: 'web-1',
  proxyStatus: 'RUNNING',
  proxyErrorCode: null,
  proxyAcmeEmail: 'ops@example.com',
  proxyInstalledAt: '2026-10-30T00:00:00.000Z',
};

function mockFetch(body: unknown = {}, status = 200) {
  const fn = vi.fn((_url: string, _init?: RequestInit) =>
    Promise.resolve(new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })),
  );
  vi.stubGlobal('fetch', fn);
  return fn;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('readServerProxy', () => {
  it('reads the proxy fields from a server view', () => {
    expect(readServerProxy(SERVER)).toEqual({
      status: 'RUNNING',
      errorCode: null,
      acmeEmail: 'ops@example.com',
      installedAt: '2026-10-30T00:00:00.000Z',
    });
  });

  it('keeps an unknown status as a plain string and drops non-string fields', () => {
    expect(readServerProxy({ proxyStatus: 'UPGRADING', proxyErrorCode: 7, proxyAcmeEmail: {} })).toEqual({
      status: 'UPGRADING',
      errorCode: null,
      acmeEmail: null,
      installedAt: null,
    });
  });

  it('returns null without a proxy status or for a non-object', () => {
    expect(readServerProxy({ id: SRV })).toBeNull();
    expect(readServerProxy(null)).toBeNull();
    expect(readServerProxy([SERVER])).toBeNull();
  });
});

describe('installProxy', () => {
  it('POSTs the proxy install and maps the returned server', async () => {
    const fetch = mockFetch({ ...SERVER, proxyStatus: 'INSTALLING' }, 202);
    const result = await installProxy(SRV);
    expect(result).toEqual({
      ok: true,
      data: { status: 'INSTALLING', errorCode: null, acmeEmail: 'ops@example.com', installedAt: '2026-10-30T00:00:00.000Z' },
    });
    const [url, init] = fetch.mock.calls[0] ?? [];
    expect(url).toBe(`/api/servers/${SRV}/proxy`);
    expect(init?.method).toBe('POST');
    expect(JSON.parse(init?.body as string)).toEqual({});
  });

  it('sends the ACME email when given', async () => {
    const fetch = mockFetch(SERVER, 202);
    await installProxy(SRV, 'ops@example.com');
    expect(JSON.parse(fetch.mock.calls[0]?.[1]?.body as string)).toEqual({ acmeEmail: 'ops@example.com' });
  });

  it('rejects an unsafe id without a request', async () => {
    const fetch = mockFetch();
    const result = await installProxy('../x');
    expect(result.ok).toBe(false);
    expect(fetch).not.toHaveBeenCalled();
  });

  it('reports a malformed body', async () => {
    mockFetch({ id: SRV }, 202);
    const result = await installProxy(SRV);
    expect(result).toMatchObject({ ok: false, code: 'INTERNAL_ERROR' });
  });
});

describe('removeProxy', () => {
  it('POSTs the remove path', async () => {
    const fetch = mockFetch({ ...SERVER, proxyStatus: 'NOT_INSTALLED' });
    const result = await removeProxy(SRV);
    expect(result).toMatchObject({ ok: true, data: { status: 'NOT_INSTALLED' } });
    expect(fetch.mock.calls[0]?.[0]).toBe(`/api/servers/${SRV}/proxy/remove`);
    expect(fetch.mock.calls[0]?.[1]?.method).toBe('POST');
  });

  it('passes a PROXY_IN_USE conflict through', async () => {
    mockFetch({ error: 'PROXY_IN_USE', message: 'in use' }, 409);
    const result = await removeProxy(SRV);
    expect(result).toMatchObject({ ok: false, code: 'PROXY_IN_USE' });
  });

  it('rejects an unsafe id without a request', async () => {
    const fetch = mockFetch();
    expect((await removeProxy('a/b')).ok).toBe(false);
    expect(fetch).not.toHaveBeenCalled();
  });
});

describe('setProxyAcmeEmail', () => {
  it('PATCHes the server with the email alone', async () => {
    const fetch = mockFetch({ ...SERVER, proxyAcmeEmail: 'new@example.com' });
    const result = await setProxyAcmeEmail(SRV, 'new@example.com');
    expect(result).toMatchObject({ ok: true, data: { acmeEmail: 'new@example.com' } });
    expect(fetch.mock.calls[0]?.[0]).toBe(`/api/servers/${SRV}`);
    expect(fetch.mock.calls[0]?.[1]?.method).toBe('PATCH');
    expect(JSON.parse(fetch.mock.calls[0]?.[1]?.body as string)).toEqual({ proxyAcmeEmail: 'new@example.com' });
  });

  it('rejects an unsafe id without a request', async () => {
    const fetch = mockFetch();
    expect((await setProxyAcmeEmail('x y', 'a@b.co')).ok).toBe(false);
    expect(fetch).not.toHaveBeenCalled();
  });
});
