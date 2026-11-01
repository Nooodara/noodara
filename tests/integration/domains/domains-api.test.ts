import { randomBytes, randomUUID } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import parseSetCookie from 'set-cookie-parser';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { revealSecret } from '@noodara/domain/security';
import { activityEvents } from '../../../apps/control-plane/src/db/schema/activity-events.js';
import { domains } from '../../../apps/control-plane/src/db/schema/domains.js';
import { servers } from '../../../apps/control-plane/src/db/schema/servers.js';
import type { DnsResolverLike } from '../../../apps/control-plane/src/domains/domain-dns.js';
import type { ApplyOutcome } from '../../../apps/control-plane/src/domains/domain-services.js';
import type { ServerEventPublisher } from '../../../apps/control-plane/src/events/server-event-publisher.js';
import type { ProxyServiceDeps } from '../../../apps/control-plane/src/proxy/proxy-service.js';
import type { ProxyInstallJobPayload } from '../../../apps/control-plane/src/queue/proxy-queue.js';
import { issueToken } from '../../../apps/control-plane/src/services/setup-token-repository.js';
import { startPostgres, type PostgresFixture } from '../helpers/postgres.js';

// 22-03 (A1-A3, H1, H2): the domains API against the real HTTP surface and a migrated Postgres.
// The route apply, the proxy install queue and the DNS resolver are fakes: no SSH, no Redis, no
// network. The real apply path is proven in tests/integration/proxy/domain-apply.test.ts.

const ADMIN_EMAIL = 'admin@noodara.dev';
const ADMIN_PASSWORD = 'correct horse battery staple';
const PUBLIC_HOST = 'panel.noodara.dev';
let serverOctet = 10;
const SERVER_PASSWORD = 'server-password-never-returned';

type Json = Record<string, unknown>;

let postgres: PostgresFixture;
let app: FastifyInstance;
let cookie: string;

const applied: string[] = [];
let nextApply: ApplyOutcome[] = [];
function domainApply(serviceId: string): Promise<ApplyOutcome> {
  applied.push(serviceId);
  return Promise.resolve(nextApply.shift() ?? { ok: true });
}

const resolved: string[] = [];
const dnsTable: Record<string, string[]> = {};
const resolver: DnsResolverLike = {
  resolve4: (hostname) => {
    resolved.push(hostname);
    const answer = dnsTable[hostname];
    return answer === undefined
      ? Promise.reject(Object.assign(new Error('ENOTFOUND'), { code: 'ENOTFOUND' }))
      : Promise.resolve(answer);
  },
  resolve6: (hostname) => {
    resolved.push(hostname);
    return Promise.reject(Object.assign(new Error('ENODATA'), { code: 'ENODATA' }));
  },
};

const installs: ProxyInstallJobPayload[] = [];
const events: ServerEventPublisher = { publish: () => Promise.resolve() };

function setTestEnv(connectionString: string): void {
  process.env.NOODARA_MASTER_KEY = randomBytes(32).toString('base64');
  process.env.BETTER_AUTH_SECRET = `test-fixture-${randomUUID()}-${randomUUID()}`;
  process.env.DATABASE_URL = connectionString;
  process.env.REDIS_URL = 'redis://localhost:6379';
  process.env.NOODARA_PUBLIC_URL = `https://${PUBLIC_HOST}`;
}

function cookieHeaderFrom(response: { headers: Record<string, unknown> }): string {
  const raw = response.headers['set-cookie'];
  const rawCookies = Array.isArray(raw) ? raw : raw !== undefined ? [String(raw)] : [];
  return parseSetCookie
    .parse(rawCookies, { map: false })
    .map((entry) => `${entry.name}=${entry.value}`)
    .join('; ');
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
  return cookieHeaderFrom(response);
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

function short(): string {
  return randomUUID().replace(/-/g, '').slice(0, 10);
}

interface Fixture {
  readonly projectId: string;
  readonly serverId: string;
  readonly serverIp: string;
  readonly serviceId: string;
  readonly url: string;
}

async function newFixture(proxyStatus: 'RUNNING' | 'NOT_INSTALLED' = 'RUNNING'): Promise<Fixture> {
  serverOctet += 1;
  const serverIp = `203.0.113.${serverOctet.toString()}`;
  const project = await call('POST', '/api/projects', { name: `Domains ${short()}` });
  expect(project.statusCode, project.raw).toBe(201);
  const projectId = String(project.body.id);
  const environment = await call('POST', `/api/projects/${projectId}/environments`, { name: 'production' });
  expect(environment.statusCode, environment.raw).toBe(201);
  const server = await call('POST', '/api/servers', {
    name: `srv-${short()}`,
    host: serverIp,
    credential: { type: 'ssh_password', password: SERVER_PASSWORD },
  });
  expect(server.statusCode, server.raw).toBe(201);
  const serverId = String(server.body.id);
  await postgres.db
    .update(servers)
    .set({ status: 'CONNECTED', dockerInstalled: true, dockerBuildkitAvailable: true, proxyStatus })
    .where(eq(servers.id, serverId));
  const service = await call('POST', `/api/projects/${projectId}/services`, {
    environmentId: String(environment.body.id),
    serverId,
    name: `api-${short()}`,
    source: { kind: 'image', imageRef: 'nginx:1.27' },
    internalPort: 80,
  });
  expect(service.statusCode, service.raw).toBe(201);
  const serviceId = String(service.body.id);
  return { projectId, serverId, serverIp, serviceId, url: `/api/projects/${projectId}/services/${serviceId}/domains` };
}

function host(): string {
  return `app-${short()}.example.com`;
}

beforeAll(async () => {
  postgres = await startPostgres();
  setTestEnv(postgres.connectionString);
  const { buildApp } = await import('../../../apps/control-plane/src/app.js');
  const proxyService: ProxyServiceDeps = {
    db: postgres.db,
    now: () => new Date(),
    events,
    enqueue: (payload) => {
      installs.push(payload);
      return Promise.resolve({ ok: true, jobId: payload.jobId, collapsed: false });
    },
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
  nextApply = [];
  resolved.length = 0;
  installs.length = 0;
});

describe('POST .../domains (A1, H1)', () => {
  it('stores the hostname lowercased, applies the routes and writes one activity event', async () => {
    const fx = await newFixture();
    const name = host();
    const created = await call('POST', fx.url, { hostname: `  ${name.toUpperCase()}. ` });
    expect(created.statusCode, created.raw).toBe(201);
    expect(created.body).toMatchObject({ hostname: name, serviceId: fx.serviceId, httpsRedirect: true, applyStatus: 'PENDING' });
    expect(applied).toEqual([fx.serviceId]);
    const [row] = await postgres.db.select().from(domains).where(eq(domains.id, String(created.body.id)));
    expect(row?.hostname).toBe(name);
    const activity = await postgres.db
      .select()
      .from(activityEvents)
      .where(and(eq(activityEvents.entityId, fx.serviceId), eq(activityEvents.action, 'service.updated')));
    expect(activity.length).toBeGreaterThanOrEqual(1);
  });

  it('H1: two concurrent POSTs of one hostname give one 201 and one 409, never 500', async () => {
    const [a, b] = await Promise.all([newFixture(), newFixture()]);
    const name = host();
    const results = await Promise.all([
      call('POST', a.url, { hostname: name }),
      call('POST', b.url, { hostname: name.toUpperCase() }),
    ]);
    expect(results.map((r) => r.statusCode).sort()).toEqual([201, 409]);
    expect(results.find((r) => r.statusCode === 409)?.body.error).toBe('DOMAIN_ALREADY_ASSIGNED');
    const same = await Promise.all([call('POST', a.url, { hostname: `x${name}` }), call('POST', a.url, { hostname: `x${name}` })]);
    expect(same.map((r) => r.statusCode).sort()).toEqual([201, 409]);
  });

  it('422 DOMAIN_RESERVED for the panel host, DOMAIN_LIMIT_REACHED past ten, DOMAIN_INPUT_INVALID with a reason', async () => {
    const fx = await newFixture();
    const reserved = await call('POST', fx.url, { hostname: PUBLIC_HOST.toUpperCase() });
    expect(reserved.statusCode, reserved.raw).toBe(422);
    expect(reserved.body.error).toBe('DOMAIN_RESERVED');

    for (let i = 0; i < 10; i += 1) {
      const ok = await call('POST', fx.url, { hostname: host() });
      expect(ok.statusCode, ok.raw).toBe(201);
    }
    const limit = await call('POST', fx.url, { hostname: host() });
    expect(limit.statusCode, limit.raw).toBe(422);
    expect(limit.body.error).toBe('DOMAIN_LIMIT_REACHED');

    const invalid = await call('POST', fx.url, { hostname: 'bad_host!.example.com' });
    expect(invalid.statusCode, invalid.raw).toBe(422);
    expect(invalid.body).toMatchObject({ error: 'DOMAIN_INPUT_INVALID' });
    expect(typeof invalid.body.reason).toBe('string');
  });

  it('H2: an oversized or unknown-field body is rejected; responses carry no credential or ACME data', async () => {
    const fx = await newFixture();
    const huge = await app.inject({
      method: 'POST',
      url: fx.url,
      headers: { cookie, origin: `https://${PUBLIC_HOST}`, 'content-type': 'application/json' },
      payload: JSON.stringify({ hostname: host(), pad: 'x'.repeat(8192) }),
    });
    expect(huge.statusCode).toBe(413);
    const extra = await call('POST', fx.url, { hostname: host(), acmeEmail: 'x@y.dev' });
    expect([400, 422]).toContain(extra.statusCode);

    const created = await call('POST', fx.url, { hostname: host() });
    const listed = await call('GET', fx.url);
    for (const raw of [created.raw, listed.raw]) {
      expect(raw).not.toContain(SERVER_PASSWORD);
      expect(raw).not.toMatch(/acme|credential|password/i);
    }
  });

  it('a NOT_INSTALLED proxy enqueues the install job and keeps the row PENDING without applying', async () => {
    const fx = await newFixture('NOT_INSTALLED');
    const created = await call('POST', fx.url, { hostname: host() });
    expect(created.statusCode, created.raw).toBe(201);
    expect(created.body.applyStatus).toBe('PENDING');
    expect(applied).toEqual([]);
    expect(installs.map((job) => job.serverId)).toEqual([fx.serverId]);
    const [server] = await postgres.db.select().from(servers).where(eq(servers.id, fx.serverId));
    expect(server?.proxyStatus).toBe('INSTALLING');
  });

  it('an apply failure keeps the row and maps to 503 PROXY_UNAVAILABLE / 502 SERVER_UNREACHABLE', async () => {
    const fx = await newFixture();
    nextApply = [{ ok: false, code: 'PROXY_UNAVAILABLE' }];
    const unavailable = await call('POST', fx.url, { hostname: host() });
    expect(unavailable.statusCode, unavailable.raw).toBe(503);
    expect(unavailable.body.error).toBe('PROXY_UNAVAILABLE');
    nextApply = [{ ok: false, code: 'SERVER_UNREACHABLE' }];
    const unreachable = await call('POST', fx.url, { hostname: host() });
    expect(unreachable.statusCode, unreachable.raw).toBe(502);
    expect(unreachable.body.error).toBe('SERVER_UNREACHABLE');
    const listed = await call('GET', fx.url);
    expect((listed.body.items as Json[]).length).toBe(2);
  });
});

describe('GET, PATCH, DELETE and dns-check (A2-A4)', () => {
  it('GET lists the view fields and the DNS instructions to the server IP', async () => {
    const fx = await newFixture();
    const name = host();
    await call('POST', fx.url, { hostname: name });
    const listed = await call('GET', fx.url);
    expect(listed.statusCode, listed.raw).toBe(200);
    const [item] = listed.body.items as Json[];
    expect(Object.keys(item ?? {}).sort()).toEqual(
      [
        'applyStatus',
        'certErrorCode',
        'certNotAfter',
        'certStatus',
        'createdAt',
        'dnsCheckedAt',
        'dnsStatus',
        'hostname',
        'httpsRedirect',
        'id',
        'projectId',
        'serviceId',
        'updatedAt',
      ].sort(),
    );
    expect(listed.body.dnsInstructions).toEqual([
      {
        hostname: name,
        records: [{ type: 'A', name, value: fx.serverIp }],
        cnameAlternative: { type: 'CNAME', name, target: null },
      },
    ]);
    expect(resolved).toEqual([]);
  });

  it('PATCH httpsRedirect re-applies the routes', async () => {
    const fx = await newFixture();
    const created = await call('POST', fx.url, { hostname: host() });
    applied.length = 0;
    const patched = await call('PATCH', `${fx.url}/${String(created.body.id)}`, { httpsRedirect: false });
    expect(patched.statusCode, patched.raw).toBe(200);
    expect(patched.body.httpsRedirect).toBe(false);
    expect(applied).toEqual([fx.serviceId]);
  });

  it('dns-check resolves only the stored hostname, records the outcome and is rate-limited', async () => {
    const fx = await newFixture();
    const name = host();
    dnsTable[name] = [fx.serverIp];
    const created = await call('POST', fx.url, { hostname: name });
    const id = String(created.body.id);
    const checked = await call('POST', `${fx.url}/${id}/dns-check`);
    expect(checked.statusCode, checked.raw).toBe(200);
    expect(checked.body.dnsStatus).toBe('RESOLVES');
    expect(typeof checked.body.dnsCheckedAt).toBe('string');
    expect(new Set(resolved)).toEqual(new Set([name]));
    const again = await call('POST', `${fx.url}/${id}/dns-check`);
    expect(again.statusCode, again.raw).toBe(429);
    expect(again.body.error).toBe('RATE_LIMITED');
  });

  it('DELETE removes the row and re-applies; a foreign project id is a 404 that leaks nothing', async () => {
    const fx = await newFixture();
    const other = await newFixture();
    const created = await call('POST', fx.url, { hostname: host() });
    const id = String(created.body.id);
    applied.length = 0;

    const foreignUrl = `/api/projects/${other.projectId}/services/${fx.serviceId}/domains`;
    const missingUrl = `/api/projects/${other.projectId}/services/${randomUUID()}/domains`;
    const foreign = await call('DELETE', `${foreignUrl}/${id}`);
    const missing = await call('DELETE', `${missingUrl}/${randomUUID()}`);
    expect(foreign.statusCode).toBe(404);
    expect(missing.statusCode).toBe(404);
    expect(foreign.body.error).toBe(missing.body.error);
    expect((await call('GET', foreignUrl)).statusCode).toBe(404);
    expect((await call('POST', `${foreignUrl}/${id}/dns-check`)).statusCode).toBe(404);
    expect(applied).toEqual([]);

    const removed = await call('DELETE', `${fx.url}/${id}`);
    expect(removed.statusCode, removed.raw).toBe(204);
    expect(applied).toEqual([fx.serviceId]);
    expect(await postgres.db.select().from(domains).where(eq(domains.id, id))).toEqual([]);
    expect((await call('DELETE', `${fx.url}/${id}`)).statusCode).toBe(404);
  });
});
