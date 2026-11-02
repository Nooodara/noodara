// 25-04 A3: abuse inputs against the v0.4 surfaces (domains, dynamic config, env, secrets,
// published ports, Traefik API exposure, ports preflight). Every attempt is rejected with a named
// error and never reaches the route apply. HTTP surface on a migrated Postgres; the route apply,
// proxy queue and DNS resolver are fakes. The live "API from outside the host is refused" probe
// runs against a real Traefik in proxy-templates.test.ts (A3 reach check); here the rendered
// config that guarantees it is asserted.
import { randomBytes, randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import parseSetCookie from 'set-cookie-parser';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  PROXY_API_PORT,
  PROXY_API_ROUTER_NAME,
  RESERVED_PUBLISHED_PORTS,
  renderDynamicConfig,
  renderStaticConfig,
  type Hostname,
} from '@noodara/domain';
import { revealSecret } from '@noodara/domain/security';
import { parsePortsInUse } from '@noodara/ssh';
import type { buildApp as BuildApp } from '../../../apps/control-plane/src/app.js';
import { servers } from '../../../apps/control-plane/src/db/schema/servers.js';
import type { DnsResolverLike } from '../../../apps/control-plane/src/domains/domain-dns.js';
import type { ApplyOutcome } from '../../../apps/control-plane/src/domains/domain-services.js';
import type { ServerEventPublisher } from '../../../apps/control-plane/src/events/server-event-publisher.js';
import type { ProxyServiceDeps } from '../../../apps/control-plane/src/proxy/proxy-service.js';
import { issueToken } from '../../../apps/control-plane/src/services/setup-token-repository.js';
import { startPostgres, type PostgresFixture } from '../helpers/postgres.js';

const ADMIN_EMAIL = 'admin@noodara.dev';
const ADMIN_PASSWORD = 'correct horse battery staple';
const PUBLIC_HOST = 'panel.noodara.dev';

type Json = Record<string, unknown>;

let postgres: PostgresFixture;
let app: ReturnType<typeof BuildApp>;
let cookie: string;

const applied: string[] = [];
function domainApply(serviceId: string): Promise<ApplyOutcome> {
  applied.push(serviceId);
  return Promise.resolve({ ok: true });
}
const resolver: DnsResolverLike = {
  resolve4: () => Promise.reject(Object.assign(new Error('ENOTFOUND'), { code: 'ENOTFOUND' })),
  resolve6: () => Promise.reject(Object.assign(new Error('ENODATA'), { code: 'ENODATA' })),
};
const events: ServerEventPublisher = { publish: () => Promise.resolve() };

function short(): string {
  return randomUUID().replace(/-/g, '').slice(0, 10);
}

async function call(
  method: 'GET' | 'POST' | 'PATCH' | 'DELETE',
  url: string,
  payload?: unknown,
): Promise<{ statusCode: number; body: Json; raw: string }> {
  const response = await app.inject({
    method,
    url,
    headers: { cookie, origin: `https://${PUBLIC_HOST}` },
    ...(payload !== undefined ? { payload: payload as Json } : {}),
  });
  const body = response.body === '' ? {} : (response.json() as Json);
  return { statusCode: response.statusCode, body, raw: response.body };
}

async function signIn(): Promise<string> {
  const issued = await issueToken(postgres.db, 'setup', new Date());
  const setup = await app.inject({
    method: 'POST',
    url: '/api/setup',
    payload: { token: revealSecret(issued.token), email: ADMIN_EMAIL, password: ADMIN_PASSWORD, name: 'Admin' },
  });
  if (setup.statusCode !== 200) throw new Error(`setup failed: ${setup.statusCode.toString()}`);
  const response = await app.inject({
    method: 'POST',
    url: '/api/auth/sign-in/email',
    payload: { email: ADMIN_EMAIL, password: ADMIN_PASSWORD },
  });
  if (response.statusCode !== 200) throw new Error(`sign-in failed: ${response.statusCode.toString()}`);
  const raw = response.headers['set-cookie'];
  const rawCookies = Array.isArray(raw) ? raw : raw !== undefined ? [String(raw)] : [];
  return parseSetCookie
    .parse(rawCookies, { map: false })
    .map((entry) => `${entry.name}=${entry.value}`)
    .join('; ');
}

interface Fixture {
  readonly projectId: string;
  readonly environmentId: string;
  readonly serverId: string;
  readonly serviceId: string;
}

let octet = 40;
async function newFixture(): Promise<Fixture> {
  octet += 1;
  const project = await call('POST', '/api/projects', { name: `Abuse ${short()}` });
  expect(project.statusCode, project.raw).toBe(201);
  const projectId = String(project.body.id);
  const environment = await call('POST', `/api/projects/${projectId}/environments`, { name: 'production' });
  expect(environment.statusCode, environment.raw).toBe(201);
  const environmentId = String(environment.body.id);
  const server = await call('POST', '/api/servers', {
    name: `srv-${short()}`,
    host: `203.0.113.${octet.toString()}`,
    credential: { type: 'ssh_password', password: 'server-password-never-returned' },
  });
  expect(server.statusCode, server.raw).toBe(201);
  const serverId = String(server.body.id);
  await postgres.db
    .update(servers)
    .set({ status: 'CONNECTED', dockerInstalled: true, dockerBuildkitAvailable: true, proxyStatus: 'RUNNING' })
    .where(eq(servers.id, serverId));
  const service = await call('POST', `/api/projects/${projectId}/services`, {
    environmentId,
    serverId,
    name: `api-${short()}`,
    source: { kind: 'image', imageRef: 'nginx:1.27' },
    internalPort: 80,
  });
  expect(service.statusCode, service.raw).toBe(201);
  return { projectId, environmentId, serverId, serviceId: String(service.body.id) };
}

beforeAll(async () => {
  postgres = await startPostgres();
  process.env.NOODARA_MASTER_KEY = randomBytes(32).toString('base64');
  process.env.BETTER_AUTH_SECRET = `test-fixture-${randomUUID()}-${randomUUID()}`;
  process.env.DATABASE_URL = postgres.connectionString;
  process.env.REDIS_URL = 'redis://localhost:6379';
  process.env.NOODARA_PUBLIC_URL = `https://${PUBLIC_HOST}`;
  const { buildApp } = await import('../../../apps/control-plane/src/app.js');
  const proxyService: ProxyServiceDeps = {
    db: postgres.db,
    now: () => new Date(),
    events,
    enqueue: (payload) => Promise.resolve({ ok: true, jobId: payload.jobId, collapsed: false }),
    acmeCaUrl: 'https://pebble:14000/dir',
    remove: () => Promise.resolve({ ok: true }) as never,
    removeTimeoutMs: 5_000,
  };
  app = buildApp({ eventPublisher: events, proxyService, domainApply, domainDnsResolver: resolver });
  cookie = await signIn();
});

afterAll(async () => {
  await app.close();
  await postgres.stop();
});

beforeEach(() => {
  applied.length = 0;
});

describe('A3: hostname and dynamic-config injection', () => {
  const injections: readonly (readonly [string, string, string])[] = [
    ['double quote', 'a"b.example.com', 'HOSTNAME_INVALID_CHARACTER'],
    ['single quote', "a'b.example.com", 'HOSTNAME_INVALID_CHARACTER'],
    ['backtick (Traefik rule breakout)', 'a`) || Host(`evil.example.com', 'HOSTNAME_CONTAINS_WHITESPACE'],
    ['backtick without spaces', 'a`b.example.com', 'HOSTNAME_INVALID_CHARACTER'],
    ['JSON breakout', 'x.example.com","service":"api@internal', 'HOSTNAME_CONTAINS_PORT'],
    ['brace and comma', 'x.example.com},{a', 'HOSTNAME_INVALID_CHARACTER'],
    ['newline', 'a.example.com\nrule: Host(`evil.example.com`)', 'HOSTNAME_CONTAINS_WHITESPACE'],
    ['carriage return', 'a.example\r.com', 'HOSTNAME_CONTAINS_WHITESPACE'],
    ['NUL byte', 'a.example\u0000.com', 'HOSTNAME_INVALID_CHARACTER'],
    ['userinfo @', 'user@a.example.com', 'HOSTNAME_INVALID_CHARACTER'],
    ['unicode (IDN not punycoded)', 'bücher.example.de', 'HOSTNAME_INVALID_CHARACTER'],
    ['Cyrillic homoglyph', 'аpple.example.com', 'HOSTNAME_INVALID_CHARACTER'],
    ['fullwidth letters', 'ｅxample.com', 'HOSTNAME_INVALID_CHARACTER'],
    ['zero-width space', 'a​.example.com', 'HOSTNAME_INVALID_CHARACTER'],
    ['wildcard', '*.example.com', 'HOSTNAME_WILDCARD'],
    ['path traversal', '../../etc/passwd', 'HOSTNAME_CONTAINS_PATH'],
    ['scheme', 'https://a.example.com', 'HOSTNAME_CONTAINS_SCHEME'],
    ['port', 'a.example.com:9180', 'HOSTNAME_CONTAINS_PORT'],
    ['IP literal', '127.0.0.1', 'HOSTNAME_IP_LITERAL'],
    ['localhost', 'localhost', 'HOSTNAME_LOCALHOST'],
  ];

  it.each(injections)('%s is a 422 DOMAIN_INPUT_INVALID and never reaches the proxy', async (_label, hostname, reason) => {
    const fx = await newFixture();
    const url = `/api/projects/${fx.projectId}/services/${fx.serviceId}/domains`;
    const response = await call('POST', url, { hostname });
    expect(response.statusCode, response.raw).toBe(422);
    expect(response.body).toMatchObject({ error: 'DOMAIN_INPUT_INVALID', reason });
    expect(applied).toEqual([]);
    const listed = await call('GET', url);
    expect(listed.raw).not.toContain('evil');
    expect(listed.raw).not.toContain('api@internal');
  });

  it('an oversized hostname is a named 400 and never reaches the proxy', async () => {
    const fx = await newFixture();
    const response = await call('POST', `/api/projects/${fx.projectId}/services/${fx.serviceId}/domains`, {
      hostname: `${'a'.repeat(60)}.`.repeat(5) + 'example.com',
    });
    expect(response.statusCode, response.raw).toBe(400);
    expect(response.body.error).toBe('VALIDATION_FAILED');
    expect(applied).toEqual([]);
  });

  it('the renderer re-validates: an injected hostname or service id never becomes config', () => {
    const service = { id: randomUUID(), internalPort: 80 };
    const domain = (hostname: string) => ({ id: randomUUID(), hostname: hostname as Hostname, httpsRedirect: true });
    for (const hostname of injections.map(([, value]) => value)) {
      const rendered = renderDynamicConfig(service, [domain(hostname)]);
      expect(rendered.ok, hostname).toBe(false);
      expect(!rendered.ok && rendered.code).toBe('PROXY_CONFIG_HOSTNAME_INVALID');
    }
    const apiService = renderDynamicConfig({ id: 'api@internal', internalPort: 80 }, [domain('a.example.com')]);
    expect(!apiService.ok && apiService.code).toBe('PROXY_CONFIG_SERVICE_ID_INVALID');
    const badPort = renderDynamicConfig({ id: service.id, internalPort: 70_000 }, [domain('a.example.com')]);
    expect(!badPort.ok && badPort.code).toBe('PROXY_CONFIG_PORT_INVALID');
  });
});

describe('A3: oversized env values and malformed secret references', () => {
  it('rejects each attempt with a named error and stores nothing', async () => {
    const fx = await newFixture();
    const env = `/api/projects/${fx.projectId}/services/${fx.serviceId}/env`;
    const secrets = `/api/projects/${fx.projectId}/secrets`;

    const oversizedAscii = await call('POST', env, { key: 'BIG', value: 'x'.repeat(32 * 1024 + 1) });
    expect(oversizedAscii.statusCode).toBe(400);
    expect(oversizedAscii.body.error).toBe('VALIDATION_FAILED');

    // Under the character cap, over the byte cap: the validator counts UTF-8 bytes.
    const oversizedBytes = await call('POST', env, { key: 'BIG', value: 'é'.repeat(16 * 1024 + 1) });
    expect(oversizedBytes.statusCode, oversizedBytes.raw).toBe(422);
    expect(oversizedBytes.body).toMatchObject({ error: 'ENV_INPUT_INVALID', reason: 'ENV_VALUE_TOO_LARGE' });

    for (const value of ['<secret:../x>', '<secret:x/../../y>', '<SECRET:x>', 'pre<secret:x>', '< secret:x >']) {
      const response = await call('POST', env, { key: 'REF', value });
      expect(response.statusCode, value).toBe(422);
      expect(response.body, value).toMatchObject({ error: 'ENV_INPUT_INVALID', reason: 'ENV_SECRET_REF_MALFORMED' });
    }

    const traversalName = await call('POST', secrets, { name: '../x', value: 'v' });
    expect(traversalName.statusCode, traversalName.raw).toBe(422);
    expect(traversalName.body).toMatchObject({ error: 'ENV_INPUT_INVALID', reason: 'SECRET_NAME_INVALID' });

    const oversizedSecret = await call('POST', secrets, { name: 'huge', value: 'x'.repeat(64 * 1024 + 1) });
    expect(oversizedSecret.statusCode).toBe(400);
    expect(oversizedSecret.body.error).toBe('VALIDATION_FAILED');

    const listedEnv = await call('GET', env);
    expect(listedEnv.raw).not.toContain('REF');
    expect(listedEnv.raw).not.toContain('BIG');
    const listedSecrets = await call('GET', secrets);
    expect(listedSecrets.raw).not.toContain('huge');
  });
});

describe('A3: published ports and the proxy ports preflight', () => {
  it('reserves the proxy, SSH and Docker ports; a service cannot take 80/443/9180 while the proxy is down', async () => {
    expect([...RESERVED_PUBLISHED_PORTS]).toEqual(expect.arrayContaining([22, 80, 443, PROXY_API_PORT]));
    const fx = await newFixture();
    const base = `/api/projects/${fx.projectId}/services`;
    for (const publishedPort of [22, 80, 443, PROXY_API_PORT, 2375, 2376]) {
      const created = await call('POST', base, {
        environmentId: fx.environmentId,
        serverId: fx.serverId,
        name: `p-${short()}`,
        source: { kind: 'image', imageRef: 'nginx:1.27' },
        internalPort: 80,
        publishedPort,
      });
      expect(created.statusCode, String(publishedPort)).toBe(422);
      expect(created.body).toMatchObject({ error: 'SERVICE_INPUT_INVALID', reason: 'PUBLISHED_PORT_RESERVED' });
      const edited = await call('PATCH', `${base}/${fx.serviceId}`, { publishedPort });
      expect(edited.statusCode, String(publishedPort)).toBe(422);
      expect(edited.body).toMatchObject({ error: 'SERVICE_INPUT_INVALID', reason: 'PUBLISHED_PORT_RESERVED' });
    }
    for (const publishedPort of [0, 65_536, 80.5]) {
      const edited = await call('PATCH', `${base}/${fx.serviceId}`, { publishedPort });
      expect(edited.statusCode, String(publishedPort)).toBe(422);
      expect(edited.body).toMatchObject({ error: 'SERVICE_INPUT_INVALID', reason: 'PUBLISHED_PORT_INVALID' });
    }
  });

  it('a listener that is not the proxy own docker-proxy is foreign, even when traefik publishes the port', () => {
    const traefikPorts = ['P 80/tcp -> 0.0.0.0:80', 'P 443/tcp -> 0.0.0.0:443'].join('\n');
    // Another container's docker-proxy on 80 while the proxy is stopped (nothing published).
    const otherContainer = 'S LISTEN 0 4096 0.0.0.0:80 0.0.0.0:* users:(("docker-proxy",pid=10,fd=4))';
    expect(parsePortsInUse(`${otherContainer}\nNOODARA_PORTS done\n`)).toEqual({
      kind: 'ok',
      foreign: [{ port: 80, process: 'docker-proxy' }],
    });
    // A host process sharing the socket with docker-proxy (SO_REUSEPORT) cannot hide behind it.
    const shared = 'S LISTEN 0 4096 [::]:443 [::]:* users:(("docker-proxy",pid=11,fd=4),("socat",pid=12,fd=3))';
    expect(parsePortsInUse(`${shared}\n${traefikPorts}\nNOODARA_PORTS done\n`)).toEqual({
      kind: 'ok',
      foreign: [{ port: 443, process: 'docker-proxy' }],
    });
    // Truncated output (no terminator) is never read as "ports free".
    expect(parsePortsInUse(`${traefikPorts}\n`)).toEqual({ kind: 'unknown' });
    expect(parsePortsInUse('NOODARA_PORTS no_ss\nNOODARA_PORTS done\n')).toEqual({ kind: 'unknown' });
  });
});

describe('A3: the Traefik API is not reachable from outside the host', () => {
  it('binds the API entrypoint to 127.0.0.1 only and exposes no API router on web or websecure', () => {
    const rendered = renderStaticConfig({ email: 'ops@noodara.dev', caUrl: 'https://pebble:14000/dir' });
    expect(rendered.ok).toBe(true);
    if (!rendered.ok) return;
    const apiBindings = rendered.value.publishedPorts.filter((port) => port.endsWith(`:${PROXY_API_PORT.toString()}`));
    expect(apiBindings).toEqual([`127.0.0.1:${PROXY_API_PORT.toString()}:${PROXY_API_PORT.toString()}`]);
    const traefik = JSON.parse(rendered.value.traefikConfig) as Json;
    expect(traefik.api).toEqual({ dashboard: false, insecure: false });
    const router = JSON.parse(rendered.value.apiRouterConfig) as {
      http: { routers: Record<string, { entryPoints: string[]; service: string }> };
    };
    expect(Object.keys(router.http.routers)).toEqual([PROXY_API_ROUTER_NAME]);
    expect(router.http.routers[PROXY_API_ROUTER_NAME]?.entryPoints).toEqual(['traefik']);

    const insecureCa = renderStaticConfig({ email: 'ops@noodara.dev', caUrl: 'http://pebble:14000/plain-http' });
    expect(insecureCa.ok).toBe(false);
  });
});
