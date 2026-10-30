import { describe, expect, it } from 'vitest';
import type { Hostname } from '../domain/hostname.js';
import {
  PROXY_CERT_RESOLVER,
  PROXY_TLS_MIN_VERSION,
  type ProxyRouteDomain,
  proxyRouterNamesFor,
  renderDynamicConfig,
} from './dynamic-config.js';

const S = '3f2b8c1e-9a4d-4e7b-8c2f-1a2b3c4d5e6f';
const D1 = '7c9e6679-7425-40de-944b-e07fc1f90ae7';
const D2 = '0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d';
const SERVICE = { id: S, internalPort: 3000 };

function domain(id: string, hostname: string, httpsRedirect: boolean): ProxyRouteDomain {
  return { id, hostname: hostname as Hostname, httpsRedirect };
}

function render(domains: readonly ProxyRouteDomain[], service = SERVICE): string {
  const result = renderDynamicConfig(service, domains);
  if (!result.ok) throw new Error(`unexpected failure ${result.code}`);
  return result.value;
}

function codeOf(result: { ok: boolean; code?: string }): string | undefined {
  return result.ok ? undefined : result.code;
}

interface Router {
  entryPoints: string[];
  rule: string;
  service: string;
  middlewares?: string[];
  tls?: { certResolver: string; options: string };
}
interface Parsed {
  http: {
    routers: Record<string, Router>;
    middlewares?: Record<string, { redirectScheme: { scheme: string; permanent: boolean } }>;
    services: Record<string, { loadBalancer: { servers: { url: string }[] } }>;
  };
  tls: { options: Record<string, { minVersion: string }> };
}

describe('renderDynamicConfig (ADR 0011 A1)', () => {
  it('renders one service, an http and an https router per domain, redirect and TLS options (snapshot)', () => {
    const expected = {
      http: {
        middlewares: {
          [`noodara-${S}-${D1}-redirect`]: { redirectScheme: { permanent: false, scheme: 'https' } },
        },
        routers: {
          [`noodara-${S}-${D1}-web`]: {
            entryPoints: ['web'],
            middlewares: [`noodara-${S}-${D1}-redirect`],
            rule: 'Host(`app.example.com`)',
            service: `noodara-${S}`,
          },
          [`noodara-${S}-${D1}-websecure`]: {
            entryPoints: ['websecure'],
            rule: 'Host(`app.example.com`)',
            service: `noodara-${S}`,
            tls: { certResolver: 'noodara', options: `noodara-${S}-tls` },
          },
        },
        services: {
          [`noodara-${S}`]: { loadBalancer: { servers: [{ url: `http://noodara-${S}:3000` }] } },
        },
      },
      tls: { options: { [`noodara-${S}-tls`]: { minVersion: 'VersionTLS12' } } },
    };

    expect(render([domain(D1, 'app.example.com', true)])).toBe(
      `${JSON.stringify(expected, null, 2)}\n`,
    );
    expect(PROXY_CERT_RESOLVER).toBe('noodara');
    expect(PROXY_TLS_MIN_VERSION).toBe('VersionTLS12');
  });

  it('omits the redirect middleware when httpsRedirect is off (snapshot)', () => {
    const expected = {
      http: {
        routers: {
          [`noodara-${S}-${D2}-web`]: {
            entryPoints: ['web'],
            rule: 'Host(`api.acme.dev`)',
            service: `noodara-${S}`,
          },
          [`noodara-${S}-${D2}-websecure`]: {
            entryPoints: ['websecure'],
            rule: 'Host(`api.acme.dev`)',
            service: `noodara-${S}`,
            tls: { certResolver: 'noodara', options: `noodara-${S}-tls` },
          },
        },
        services: {
          [`noodara-${S}`]: { loadBalancer: { servers: [{ url: `http://noodara-${S}:8080` }] } },
        },
      },
      tls: { options: { [`noodara-${S}-tls`]: { minVersion: 'VersionTLS12' } } },
    };

    expect(render([domain(D2, 'api.acme.dev', false)], { id: S, internalPort: 8080 })).toBe(
      `${JSON.stringify(expected, null, 2)}\n`,
    );
  });

  it('renders a service without routers when it has no domains (the ACME retry write)', () => {
    const parsed = JSON.parse(render([])) as Parsed;
    expect(parsed.http.routers).toEqual({});
    expect(parsed.http.middlewares).toBeUndefined();
    expect(Object.keys(parsed.http.services)).toEqual([`noodara-${S}`]);
  });

  it('is byte-identical for the same domains in any order', () => {
    const a = domain(D1, 'app.example.com', true);
    const b = domain(D2, 'api.acme.dev', false);
    const c = domain('11111111-2222-4333-8444-555555555555', 'www.acme.dev', true);
    const reference = render([a, b, c]);
    for (const order of [[a, c, b], [b, a, c], [b, c, a], [c, a, b], [c, b, a]]) {
      expect(render(order)).toBe(reference);
    }
    expect(render([a, b, c])).toBe(reference);
  });

  it('lists the router names verify must see, sorted', () => {
    expect(
      proxyRouterNamesFor(S, [domain(D1, 'app.example.com', true), domain(D2, 'api.acme.dev', false)]),
    ).toEqual([
      `noodara-${S}-${D2}-web`,
      `noodara-${S}-${D2}-websecure`,
      `noodara-${S}-${D1}-web`,
      `noodara-${S}-${D1}-websecure`,
    ]);
  });

  it.each([0, -1, 65536, 3.5, Number.NaN])('rejects internal port %s', (port) => {
    expect(codeOf(renderDynamicConfig({ id: S, internalPort: port }, []))).toBe(
      'PROXY_CONFIG_PORT_INVALID',
    );
  });

  it('rejects duplicate domain ids and duplicate hostnames', () => {
    expect(
      codeOf(
        renderDynamicConfig(SERVICE, [
          domain(D1, 'app.example.com', true),
          domain(D1, 'other.example.com', true),
        ]),
      ),
    ).toBe('PROXY_CONFIG_DUPLICATE_DOMAIN');
    expect(
      codeOf(
        renderDynamicConfig(SERVICE, [
          domain(D1, 'app.example.com', true),
          domain(D2, 'app.example.com', false),
        ]),
      ),
    ).toBe('PROXY_CONFIG_DUPLICATE_DOMAIN');
  });

  it('rejects more than MAX_DOMAINS_PER_SERVICE domains', () => {
    const many = Array.from({ length: 11 }, (_, i) =>
      domain(`00000000-0000-4000-8000-${i.toString().padStart(12, '0')}`, `d${i.toString()}.acme.dev`, true),
    );
    expect(codeOf(renderDynamicConfig(SERVICE, many))).toBe('PROXY_CONFIG_TOO_MANY_DOMAINS');
    expect(renderDynamicConfig(SERVICE, many.slice(0, 10)).ok).toBe(true);
  });
});

describe('H1: names and rules derive only from UUIDs and validated hostnames', () => {
  const HOSTILE = ['"', "'", '\n', '\r', '@', '/', ' ', '\t', '`', '\\', '{', '}', '$', '#', ':', ' '];

  it.each(HOSTILE)('rejects a service id containing %j', (char) => {
    const result = renderDynamicConfig({ id: `${S.slice(0, -1)}${char}`, internalPort: 3000 }, []);
    expect(codeOf(result)).toBe('PROXY_CONFIG_SERVICE_ID_INVALID');
    const injected = renderDynamicConfig({ id: `${S}${char}`, internalPort: 3000 }, []);
    expect(codeOf(injected)).toBe('PROXY_CONFIG_SERVICE_ID_INVALID');
  });

  it.each(HOSTILE)('rejects a domain id containing %j', (char) => {
    const result = renderDynamicConfig(SERVICE, [domain(`${D1}${char}`, 'app.example.com', true)]);
    expect(codeOf(result)).toBe('PROXY_CONFIG_DOMAIN_ID_INVALID');
  });

  it.each(HOSTILE)('rejects a hostname containing %j, even when typed as Hostname', (char) => {
    const result = renderDynamicConfig(SERVICE, [domain(D1, `app${char}x.example.com`, true)]);
    expect(codeOf(result)).toBe('PROXY_CONFIG_HOSTNAME_INVALID');
  });

  it('never echoes the rejected input in the failure message', () => {
    const result = renderDynamicConfig(SERVICE, [domain(D1, 'evil`)||Host(`x.com', true)]);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.message).not.toContain('evil');
  });

  it('every rendered key and string value is drawn from a closed alphabet', () => {
    const parsed: unknown = JSON.parse(
      render([
        domain(D1, 'app.example.com', true),
        domain(D2, 'xn--bcher-kva.acme.dev', false),
      ]),
    );
    const strings: string[] = [];
    const walk = (node: unknown): void => {
      if (typeof node === 'string') strings.push(node);
      else if (Array.isArray(node)) node.forEach(walk);
      else if (node !== null && typeof node === 'object') {
        for (const [key, value] of Object.entries(node)) {
          strings.push(key);
          walk(value);
        }
      }
    };
    walk(parsed);
    for (const value of strings) {
      if (value.startsWith('http://')) {
        expect(value).toMatch(/^http:\/\/noodara-[0-9a-f-]{36}:\d{1,5}$/);
      } else if (value.startsWith('Host(')) {
        expect(value).toMatch(/^Host\(`[a-z0-9.-]+`\)$/);
      } else {
        expect(value).toMatch(/^[A-Za-z0-9-]+$/);
      }
      expect(value).not.toMatch(/["'@\s\\]/);
    }
  });
});

describe('H3: no router serves TLS below 1.2', () => {
  it('every websecure router has TLS with an options block at minVersion VersionTLS12', () => {
    const parsed = JSON.parse(
      render([domain(D1, 'app.example.com', true), domain(D2, 'api.acme.dev', false)]),
    ) as Parsed;
    const routers = Object.values(parsed.http.routers);
    expect(routers.filter((r) => r.entryPoints.includes('websecure'))).toHaveLength(2);
    for (const router of routers) {
      if (router.entryPoints.includes('websecure')) {
        expect(router.tls?.certResolver).toBe('noodara');
        const options = parsed.tls.options[router.tls?.options ?? ''];
        expect(options?.minVersion).toBe('VersionTLS12');
      } else {
        expect(router.tls).toBeUndefined();
      }
    }
    for (const options of Object.values(parsed.tls.options)) {
      expect(['VersionTLS12', 'VersionTLS13']).toContain(options.minVersion);
    }
  });
});

describe('H5: the redirect is never permanent', () => {
  it('renders redirectScheme with permanent=false (302) for every redirecting domain', () => {
    const output = render([
      domain(D1, 'app.example.com', true),
      domain(D2, 'api.acme.dev', true),
    ]);
    const parsed = JSON.parse(output) as Parsed;
    const middlewares = Object.values(parsed.http.middlewares ?? {});
    expect(middlewares).toHaveLength(2);
    for (const middleware of middlewares) {
      expect(middleware.redirectScheme).toEqual({ permanent: false, scheme: 'https' });
    }
    expect(output).not.toMatch(/"permanent":\s*true/);
    expect(output).not.toMatch(/redirectRegex|301|308/);
  });

  it('toggling httpsRedirect off removes the middleware and its reference', () => {
    const on = JSON.parse(render([domain(D1, 'app.example.com', true)])) as Parsed;
    const off = JSON.parse(render([domain(D1, 'app.example.com', false)])) as Parsed;
    expect(on.http.routers[`noodara-${S}-${D1}-web`]?.middlewares).toHaveLength(1);
    expect(off.http.routers[`noodara-${S}-${D1}-web`]?.middlewares).toBeUndefined();
    expect(off.http.middlewares).toBeUndefined();
  });
});
