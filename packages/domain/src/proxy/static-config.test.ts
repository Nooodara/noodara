import { describe, expect, it } from 'vitest';
import {
  LETS_ENCRYPT_PRODUCTION_CA_URL,
  PROXY_API_PORT,
  PROXY_PUBLISHED_PORTS,
  type ProxyAcmeSettings,
  type ProxyStaticConfig,
  renderStaticConfig,
} from './static-config.js';

const ACME: ProxyAcmeSettings = { email: 'ops@acme.dev', caUrl: LETS_ENCRYPT_PRODUCTION_CA_URL };

function render(acme: ProxyAcmeSettings): ProxyStaticConfig {
  const result = renderStaticConfig(acme);
  if (!result.ok) throw new Error(`unexpected failure ${result.code}`);
  return result.value;
}

function codeOf(result: { ok: boolean; code?: string }): string | undefined {
  return result.ok ? undefined : result.code;
}

describe('renderStaticConfig (ADR 0011 A2, H2)', () => {
  it('renders entrypoints, the HTTP-01 resolver, file provider only, hardened globals (snapshot)', () => {
    const expected = {
      api: { dashboard: false, insecure: false },
      certificatesResolvers: {
        noodara: {
          acme: {
            caServer: 'https://acme-v02.api.letsencrypt.org/directory',
            email: 'ops@acme.dev',
            httpChallenge: { entryPoint: 'web' },
            storage: '/etc/traefik/acme/acme.json',
          },
        },
      },
      entryPoints: {
        traefik: { address: ':9180' },
        web: { address: ':80' },
        websecure: { address: ':443' },
      },
      global: { checkNewVersion: false, sendAnonymousUsage: false },
      log: { level: 'WARN' },
      providers: { file: { directory: '/etc/traefik/dynamic', watch: true } },
    };

    expect(render(ACME).traefikConfig).toBe(`${JSON.stringify(expected, null, 2)}\n`);
    expect(LETS_ENCRYPT_PRODUCTION_CA_URL).toBe('https://acme-v02.api.letsencrypt.org/directory');
  });

  it('H2: telemetry, update checks, dashboard, insecure api and access log are off; log level WARN', () => {
    const parsed = JSON.parse(render(ACME).traefikConfig) as Record<string, unknown>;
    expect(parsed.global).toEqual({ checkNewVersion: false, sendAnonymousUsage: false });
    expect(parsed.api).toEqual({ dashboard: false, insecure: false });
    expect(parsed.log).toEqual({ level: 'WARN' });
    expect(parsed).not.toHaveProperty('accessLog');
    expect(parsed).not.toHaveProperty('metrics');
    expect(parsed).not.toHaveProperty('tracing');
    expect(parsed.providers).toEqual({ file: { directory: '/etc/traefik/dynamic', watch: true } });
    expect(parsed.providers).not.toHaveProperty('docker');
  });

  it('serves the read-only API through an explicit router on the traefik entrypoint only (snapshot)', () => {
    const expected = {
      http: {
        routers: {
          'noodara-api': {
            entryPoints: ['traefik'],
            rule: 'PathPrefix(`/api`)',
            service: 'api@internal',
          },
        },
      },
    };
    expect(render(ACME).apiRouterConfig).toBe(`${JSON.stringify(expected, null, 2)}\n`);
  });

  it('binds the API port to 127.0.0.1 only and publishes 80 and 443', () => {
    expect(PROXY_API_PORT).toBe(9180);
    expect(render(ACME).publishedPorts).toEqual(['80:80', '443:443', '127.0.0.1:9180:9180']);
    expect(PROXY_PUBLISHED_PORTS).toEqual(render(ACME).publishedPorts);
    const apiBindings = PROXY_PUBLISHED_PORTS.filter((binding) => binding.endsWith(':9180'));
    expect(apiBindings).toEqual(['127.0.0.1:9180:9180']);
    expect(Object.isFrozen(PROXY_PUBLISHED_PORTS)).toBe(true);
  });

  it('is byte-identical for the same input', () => {
    expect(render({ ...ACME })).toEqual(render(ACME));
  });

  it('lowercases the email and sets certificatesDuration only through the test seam', () => {
    const parsed = JSON.parse(
      render({ ...ACME, email: 'Ops@Acme.dev', certificatesDurationHours: 1 }).traefikConfig,
    ) as { certificatesResolvers: { noodara: { acme: Record<string, unknown> } } };
    expect(parsed.certificatesResolvers.noodara.acme.email).toBe('ops@acme.dev');
    expect(parsed.certificatesResolvers.noodara.acme.certificatesDuration).toBe(1);
    const production = JSON.parse(render(ACME).traefikConfig) as typeof parsed;
    expect(production.certificatesResolvers.noodara.acme).not.toHaveProperty('certificatesDuration');
  });

  it.each([0, -1, 1.5, 2161, Number.NaN])('rejects certificatesDurationHours %s', (hours) => {
    expect(codeOf(renderStaticConfig({ ...ACME, certificatesDurationHours: hours }))).toBe(
      'PROXY_ACME_DURATION_INVALID',
    );
  });
});

describe('caUrl', () => {
  it('requires https unless the explicit test seam allows http', () => {
    const pebbleHttp = { ...ACME, caUrl: 'http://pebble:14000/dir' };
    expect(codeOf(renderStaticConfig(pebbleHttp))).toBe('PROXY_ACME_CA_URL_INSECURE');
    expect(codeOf(renderStaticConfig({ ...pebbleHttp, allowInsecureCaUrl: false }))).toBe(
      'PROXY_ACME_CA_URL_INSECURE',
    );
    const allowed = render({ ...pebbleHttp, allowInsecureCaUrl: true });
    expect(allowed.traefikConfig).toContain('"caServer": "http://pebble:14000/dir"');
  });

  it('accepts the Pebble https directory used by fixtures', () => {
    expect(render({ ...ACME, caUrl: 'https://pebble:14000/dir' }).traefikConfig).toContain(
      '"caServer": "https://pebble:14000/dir"',
    );
  });

  it.each([
    '',
    'not a url',
    'ftp://ca.example.org/dir',
    'https://user:pw@ca.example.org/dir',
    'https://ca.example.org/dir#x',
    'https://ca.example.org/dir ',
    ' https://ca.example.org/dir',
    'https://ca.example.org/d"ir',
    'https://ca.example.org/d`ir',
    'https://ca.example.org/dir\n',
    `https://ca.example.org/${'a'.repeat(2048)}`,
  ])('rejects %j', (caUrl) => {
    const code = codeOf(renderStaticConfig({ ...ACME, caUrl, allowInsecureCaUrl: true }));
    expect(code).toBe('PROXY_ACME_CA_URL_INVALID');
  });
});

describe('email', () => {
  it.each(['', 'no-at', 'a b@acme.dev', 'a"b@acme.dev', 'a`b@acme.dev', 'ops@acme.dev\n', 'ops@acme', '@acme.dev'])(
    'rejects %j',
    (email) => {
      expect(codeOf(renderStaticConfig({ ...ACME, email }))).toBe('PROXY_ACME_EMAIL_INVALID');
    },
  );

  it('never echoes the rejected email or URL in the failure message', () => {
    const email = renderStaticConfig({ ...ACME, email: 'secret-person"@x' });
    const url = renderStaticConfig({ ...ACME, caUrl: 'https://u:topsecret@ca.example.org/' });
    expect(email.ok || email.message.includes('secret-person')).toBe(false);
    expect(url.ok || url.message.includes('topsecret')).toBe(false);
  });
});
