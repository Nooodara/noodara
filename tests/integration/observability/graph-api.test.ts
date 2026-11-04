import { randomBytes, randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import parseSetCookie from 'set-cookie-parser';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { revealSecret } from '@noodara/domain/security';
import type { buildApp as BuildApp } from '../../../apps/control-plane/src/app.js';
import { domains, environmentVariables, servers, services } from '../../../apps/control-plane/src/db/schema/index.js';
import type { ServerEventPublisher } from '../../../apps/control-plane/src/events/server-event-publisher.js';
import { issueToken } from '../../../apps/control-plane/src/services/setup-token-repository.js';
import { startPostgres, type PostgresFixture } from '../helpers/postgres.js';

// 27-05 (A1-A3, H1): the Infrastructure Graph API on the real HTTP surface and a migrated
// Postgres. One seed (2 servers, 2 projects, 4 services across 3 environments, 2 domains, one
// env-based dependency) is shared by every test; the deletion test runs last.

const ADMIN_EMAIL = 'admin@noodara.dev';
const ADMIN_PASSWORD = 'correct horse battery staple';
const PUBLIC_HOST = 'panel.noodara.dev';
const VALUE_CANARY = 'graphValueCanary7f3a';
const SECRET_CANARY = 'graph_secret_canary_9c1e';

type Json = Record<string, unknown>;
interface Node {
  id: string;
  kind: string;
  entityId: string;
  label: string;
}
interface Relation {
  id: string;
  type: string;
  from: string;
  to: string;
  [key: string]: unknown;
}
interface Graph {
  nodes: Node[];
  relations: Relation[];
  omitted: unknown[];
  truncated: boolean;
}

let postgres: PostgresFixture;
let app: ReturnType<typeof BuildApp>;
let cookie: string;

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

async function call(method: 'GET' | 'POST', url: string, payload?: unknown): Promise<{ statusCode: number; body: Json; raw: string }> {
  const response = await app.inject({
    method,
    url,
    headers: { cookie, origin: `https://${PUBLIC_HOST}` },
    ...(payload !== undefined ? { payload: payload as Json } : {}),
  });
  const body = response.body === '' ? {} : (response.json() as Json);
  return { statusCode: response.statusCode, body, raw: response.body };
}

async function graph(url: string): Promise<{ graph: Graph; raw: string }> {
  const response = await call('GET', url);
  expect(response.statusCode, response.raw).toBe(200);
  return { graph: response.body as unknown as Graph, raw: response.raw };
}

function short(): string {
  return randomUUID().replace(/-/g, '').slice(0, 10);
}

async function created(url: string, payload: Json): Promise<string> {
  const response = await call('POST', url, payload);
  expect(response.statusCode, response.raw).toBe(201);
  return String(response.body.id);
}

interface Seed {
  s1: string;
  s2: string;
  p1: string;
  p2: string;
  e1: string;
  e2: string;
  e3: string;
  api: string;
  db: string;
  web: string;
  worker: string;
  domApi: string;
  domWeb: string;
  apiHost: string;
}

let seed: Seed;

async function seedInfrastructure(): Promise<Seed> {
  const s1 = await created('/api/servers', {
    name: 'graph-srv-1',
    host: '203.0.113.71',
    credential: { type: 'ssh_password', password: 'server-password-never-returned' },
  });
  const s2 = await created('/api/servers', {
    name: 'graph-srv-2',
    host: '203.0.113.72',
    credential: { type: 'ssh_password', password: 'server-password-never-returned' },
  });
  for (const id of [s1, s2]) {
    await postgres.db
      .update(servers)
      .set({ status: 'CONNECTED', dockerInstalled: true, dockerBuildkitAvailable: true })
      .where(eq(servers.id, id));
  }
  const p1 = await created('/api/projects', { name: 'Graph One' });
  const p2 = await created('/api/projects', { name: 'Graph Two' });
  const e1 = await created(`/api/projects/${p1}/environments`, { name: 'production' });
  const e2 = await created(`/api/projects/${p1}/environments`, { name: 'staging' });
  const e3 = await created(`/api/projects/${p2}/environments`, { name: 'production' });
  const service = (projectId: string, environmentId: string, serverId: string, name: string): Promise<string> =>
    created(`/api/projects/${projectId}/services`, {
      environmentId,
      serverId,
      name,
      source: { kind: 'image', imageRef: 'nginx:1.27' },
      internalPort: 80,
    });
  const api = await service(p1, e1, s1, 'api');
  const db = await service(p1, e1, s2, 'db');
  const web = await service(p1, e2, s1, 'web');
  const worker = await service(p2, e3, s2, 'worker');

  const apiHost = `api-${short()}.graph.test`;
  const [domApiRow] = await postgres.db
    .insert(domains)
    .values({ projectId: p1, serviceId: api, hostname: apiHost })
    .returning({ id: domains.id });
  const [domWebRow] = await postgres.db
    .insert(domains)
    .values({ projectId: p1, serviceId: web, hostname: `web-${short()}.graph.test` })
    .returning({ id: domains.id });

  await postgres.db.insert(environmentVariables).values([
    // api -> db through the container name in a URL host; the password is a value canary.
    {
      scope: 'service',
      projectId: p1,
      serviceId: api,
      key: 'DATABASE_URL',
      value: `postgres://app:${VALUE_CANARY}@noodara-${db}:5432/app`,
    },
    // A secret reference is never read: neither its name nor an edge reaches the graph.
    { scope: 'service', projectId: p1, serviceId: api, key: 'TOKEN', value: `<secret:${SECRET_CANARY}>` },
    { scope: 'project', projectId: p1, key: 'HINT', value: `plain-${VALUE_CANARY}` },
    { scope: 'environment', projectId: p1, environmentId: e2, key: 'WEB_HINT', value: `noodara-${db}` },
    // Cross-project names never yield an edge.
    { scope: 'service', projectId: p2, serviceId: worker, key: 'UPSTREAM', value: `https://${apiHost}` },
  ]);

  return {
    s1,
    s2,
    p1,
    p2,
    e1,
    e2,
    e3,
    api,
    db,
    web,
    worker,
    domApi: String(domApiRow?.id),
    domWeb: String(domWebRow?.id),
    apiHost,
  };
}

const n = (kind: string, id: string): string => `${kind.toLowerCase()}:${id}`;
const r = (type: string, from: string, to: string): string => `${type}:${from}->${to}`;

function nodeIds(g: Graph): string[] {
  return g.nodes.map((node) => node.id).sort();
}

function relationIds(g: Graph): string[] {
  return g.relations.map((relation) => relation.id).sort();
}

function expectNoDangling(g: Graph): void {
  const ids = new Set(g.nodes.map((node) => node.id));
  for (const relation of g.relations) {
    expect(ids.has(relation.from), relation.id).toBe(true);
    expect(ids.has(relation.to), relation.id).toBe(true);
  }
}

beforeAll(async () => {
  postgres = await startPostgres();
  setTestEnv(postgres.connectionString);
  const { buildApp } = await import('../../../apps/control-plane/src/app.js');
  app = buildApp({ eventPublisher: events });
  cookie = await signIn();
  seed = await seedInfrastructure();
});

afterAll(async () => {
  await app.close();
  await postgres.stop();
});

describe('graph from registered infrastructure (A1, A2)', () => {
  it('global graph has exactly the seeded nodes and relations', async () => {
    const { graph: g } = await graph('/api/graph');
    const s = seed;
    expect(nodeIds(g)).toEqual(
      [
        n('Server', s.s1),
        n('Server', s.s2),
        n('Project', s.p1),
        n('Project', s.p2),
        n('Environment', s.e1),
        n('Environment', s.e2),
        n('Environment', s.e3),
        n('Service', s.api),
        n('Service', s.db),
        n('Service', s.web),
        n('Service', s.worker),
        n('Domain', s.domApi),
        n('Domain', s.domWeb),
      ].sort(),
    );
    expect(relationIds(g)).toEqual(
      [
        r('BELONGS_TO', n('Environment', s.e1), n('Project', s.p1)),
        r('BELONGS_TO', n('Environment', s.e2), n('Project', s.p1)),
        r('BELONGS_TO', n('Environment', s.e3), n('Project', s.p2)),
        r('RUNS_ON', n('Service', s.api), n('Server', s.s1)),
        r('RUNS_ON', n('Service', s.db), n('Server', s.s2)),
        r('RUNS_ON', n('Service', s.web), n('Server', s.s1)),
        r('RUNS_ON', n('Service', s.worker), n('Server', s.s2)),
        r('BELONGS_TO', n('Service', s.api), n('Environment', s.e1)),
        r('BELONGS_TO', n('Service', s.db), n('Environment', s.e1)),
        r('BELONGS_TO', n('Service', s.web), n('Environment', s.e2)),
        r('BELONGS_TO', n('Service', s.worker), n('Environment', s.e3)),
        r('EXPOSED_BY', n('Service', s.api), n('Domain', s.domApi)),
        r('EXPOSED_BY', n('Service', s.web), n('Domain', s.domWeb)),
        r('DEPENDS_ON', n('Service', s.api), n('Service', s.db)),
        r('DEPENDS_ON', n('Service', s.web), n('Service', s.db)),
      ].sort(),
    );
    expect(g.truncated).toBe(false);
    expect(g.omitted).toEqual([]);
    expect(g.nodes.find((node) => node.id === n('Domain', s.domApi))?.label).toBe(s.apiHost);
    expectNoDangling(g);
  });

  it('project graph keeps the project, its environments, services, domains and their servers', async () => {
    const s = seed;
    const { graph: g } = await graph(`/api/projects/${s.p1}/graph`);
    expect(nodeIds(g)).toEqual(
      [
        n('Server', s.s1),
        n('Server', s.s2),
        n('Project', s.p1),
        n('Environment', s.e1),
        n('Environment', s.e2),
        n('Service', s.api),
        n('Service', s.db),
        n('Service', s.web),
        n('Domain', s.domApi),
        n('Domain', s.domWeb),
      ].sort(),
    );
    expect(g.relations).toHaveLength(12);
    expect(relationIds(g).some((id) => id.includes(s.worker) || id.includes(s.p2))).toBe(false);
    expect(g.truncated).toBe(false);
    expectNoDangling(g);

    const { graph: other } = await graph(`/api/projects/${s.p2}/graph`);
    expect(nodeIds(other)).toEqual(
      [n('Server', s.s2), n('Project', s.p2), n('Environment', s.e3), n('Service', s.worker)].sort(),
    );
    expect(relationIds(other).some((id) => id.startsWith('DEPENDS_ON'))).toBe(false);
  });

  it('environment graph keeps only that environment and drops cross-environment edges', async () => {
    const s = seed;
    const { graph: g } = await graph(`/api/projects/${s.p1}/environments/${s.e1}/graph`);
    expect(nodeIds(g)).toEqual(
      [
        n('Server', s.s1),
        n('Server', s.s2),
        n('Environment', s.e1),
        n('Service', s.api),
        n('Service', s.db),
        n('Domain', s.domApi),
      ].sort(),
    );
    expect(relationIds(g)).toContain(r('DEPENDS_ON', n('Service', s.api), n('Service', s.db)));
    expect(g.relations).toHaveLength(6);
    expectNoDangling(g);

    const { graph: staging } = await graph(`/api/projects/${s.p1}/environments/${s.e2}/graph`);
    expect(nodeIds(staging)).toEqual(
      [n('Server', s.s1), n('Environment', s.e2), n('Service', s.web), n('Domain', s.domWeb)].sort(),
    );
    // web -> db crosses into production, which is out of scope.
    expect(relationIds(staging).some((id) => id.startsWith('DEPENDS_ON'))).toBe(false);
    expectNoDangling(staging);
  });
});

describe('graph never leaks env values or secret names (A3)', () => {
  it('no value or secret name in any scope, DEPENDS_ON carries only the two service ids', async () => {
    const s = seed;
    for (const url of ['/api/graph', `/api/projects/${s.p1}/graph`, `/api/projects/${s.p1}/environments/${s.e1}/graph`]) {
      const { graph: g, raw } = await graph(url);
      expect(raw).not.toContain(VALUE_CANARY);
      expect(raw).not.toContain(SECRET_CANARY);
      expect(raw).not.toContain('postgres://');
      expect(raw).not.toContain('DATABASE_URL');
      expect(raw).not.toContain('TOKEN');
      const depends = g.relations.filter((relation) => relation.type === 'DEPENDS_ON');
      expect(depends.length).toBeGreaterThan(0);
      for (const edge of depends) {
        expect(Object.keys(edge).sort()).toEqual(['from', 'id', 'to', 'type']);
        expect(edge.from.startsWith('service:')).toBe(true);
        expect(edge.to.startsWith('service:')).toBe(true);
      }
    }
  });
});

describe('graph scope validation and cap (H1)', () => {
  it('malformed ids are a named 400 that does not echo the input', async () => {
    const s = seed;
    for (const url of [
      '/api/projects/not-a-uuid/graph',
      `/api/projects/${s.p1}/environments/zzz-bad/graph`,
      `/api/projects/${s.p1.toUpperCase()}x/graph`,
    ]) {
      const response = await call('GET', url);
      expect(response.statusCode, `${url}: ${response.raw}`).toBe(400);
      expect(response.body.error).toBe('GRAPH_QUERY_INVALID');
      expect(response.raw).not.toContain('not-a-uuid');
      expect(response.raw).not.toContain('zzz-bad');
    }
  });

  it('unknown or out-of-scope ids are 404', async () => {
    const s = seed;
    for (const url of [
      `/api/projects/${randomUUID()}/graph`,
      `/api/projects/${s.p1}/environments/${randomUUID()}/graph`,
      // e3 belongs to p2, so it is out of p1's scope.
      `/api/projects/${s.p1}/environments/${s.e3}/graph`,
    ]) {
      const response = await call('GET', url);
      expect(response.statusCode, `${url}: ${response.raw}`).toBe(404);
      expect(response.body.error).toBe('NOT_FOUND');
    }
  });

  it('caps the node count with a truncated flag and no dangling relation', async () => {
    const { graph: g } = await graph('/api/graph?limit=5');
    expect(g.nodes).toHaveLength(5);
    expect(g.truncated).toBe(true);
    // Parents come first: servers and projects before environments, services and domains.
    expect(g.nodes.filter((node) => node.kind === 'Server')).toHaveLength(2);
    expect(g.nodes.filter((node) => node.kind === 'Project')).toHaveLength(2);
    expect(g.nodes.filter((node) => node.kind === 'Environment')).toHaveLength(1);
    expectNoDangling(g);

    const { graph: scoped } = await graph(`/api/projects/${seed.p1}/graph?limit=3`);
    expect(scoped.nodes).toHaveLength(3);
    expect(scoped.truncated).toBe(true);
    expectNoDangling(scoped);

    const { graph: whole } = await graph('/api/graph?limit=13');
    expect(whole.truncated).toBe(false);

    for (const limit of ['0', '-1', 'abc', '5001', '1.5']) {
      const response = await call('GET', `/api/graph?limit=${limit}`);
      expect(response.statusCode, `${limit}: ${response.raw}`).toBe(400);
      expect(response.body.error).toBe('GRAPH_QUERY_INVALID');
    }
    const unknownKey = await call('GET', '/api/graph?depth=2');
    expect(unknownKey.statusCode).toBe(400);
  });

  it('requires a session', async () => {
    for (const url of ['/api/graph', `/api/projects/${seed.p1}/graph`]) {
      const response = await app.inject({ method: 'GET', url });
      expect(response.statusCode).toBe(401);
    }
  });
});

describe('graph follows deletions (A2)', () => {
  it('drops a deleted service and a deleted domain with no dangling relation', async () => {
    const s = seed;
    await postgres.db.delete(domains).where(eq(domains.id, s.domApi));
    await postgres.db.delete(services).where(eq(services.id, s.web));

    const { graph: g } = await graph('/api/graph');
    const ids = nodeIds(g);
    expect(ids).not.toContain(n('Service', s.web));
    expect(ids).not.toContain(n('Domain', s.domWeb));
    expect(ids).not.toContain(n('Domain', s.domApi));
    expect(g.nodes).toHaveLength(10);
    expect(relationIds(g)).toEqual(
      [
        r('BELONGS_TO', n('Environment', s.e1), n('Project', s.p1)),
        r('BELONGS_TO', n('Environment', s.e2), n('Project', s.p1)),
        r('BELONGS_TO', n('Environment', s.e3), n('Project', s.p2)),
        r('RUNS_ON', n('Service', s.api), n('Server', s.s1)),
        r('RUNS_ON', n('Service', s.db), n('Server', s.s2)),
        r('RUNS_ON', n('Service', s.worker), n('Server', s.s2)),
        r('BELONGS_TO', n('Service', s.api), n('Environment', s.e1)),
        r('BELONGS_TO', n('Service', s.db), n('Environment', s.e1)),
        r('BELONGS_TO', n('Service', s.worker), n('Environment', s.e3)),
        r('DEPENDS_ON', n('Service', s.api), n('Service', s.db)),
      ].sort(),
    );
    expect(g.omitted).toEqual([]);
    expectNoDangling(g);

    const { graph: staging } = await graph(`/api/projects/${s.p1}/environments/${s.e2}/graph`);
    expect(nodeIds(staging)).toEqual([n('Environment', s.e2)]);
    expect(staging.relations).toEqual([]);
  });
});
