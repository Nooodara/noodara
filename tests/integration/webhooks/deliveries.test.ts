import { randomBytes, randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import parseSetCookie from 'set-cookie-parser';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { revealSecret } from '@noodara/domain/security';
import { servers } from '../../../apps/control-plane/src/db/schema/servers.js';
import { webhookDeliveries } from '../../../apps/control-plane/src/db/schema/webhook-deliveries.js';
import { issueToken } from '../../../apps/control-plane/src/services/setup-token-repository.js';
import { startPostgres, type PostgresFixture } from '../helpers/postgres.js';

// 19-08 A3: GET /api/projects/:projectId/services/:serviceId/webhook/deliveries over the real HTTP
// surface and a migrated Postgres: malformed cursor, keyset paging, per-service scoping, no payload.

const ADMIN_EMAIL = 'admin@noodara.test';
const ADMIN_PASSWORD = 'correct horse battery staple';

type Json = Record<string, unknown>;

let postgres: PostgresFixture;
let app: FastifyInstance;
let cookie: string;

function short(): string {
  return randomUUID().replace(/-/g, '').slice(0, 10);
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

async function post(url: string, payload: Json): Promise<{ statusCode: number; body: Json; raw: string }> {
  const response = await app.inject({ method: 'POST', url, headers: { cookie }, payload });
  return { statusCode: response.statusCode, body: response.json() as Json, raw: response.body };
}

interface Fixture {
  readonly projectId: string;
  readonly serviceIds: readonly [string, string];
}

async function newFixture(): Promise<Fixture> {
  const project = await post('/api/projects', { name: `Hook ${short()}` });
  expect(project.statusCode, project.raw).toBe(201);
  const projectId = String(project.body.id);
  const environment = await post(`/api/projects/${projectId}/environments`, { name: 'production' });
  expect(environment.statusCode, environment.raw).toBe(201);
  const server = await post('/api/servers', {
    name: `srv-${short()}`,
    host: `${short()}.example.test`,
    credential: { type: 'ssh_password', password: 'not-used-by-this-test' },
  });
  expect(server.statusCode, server.raw).toBe(201);
  const serverId = String(server.body.id);
  await postgres.db
    .update(servers)
    .set({ status: 'CONNECTED', dockerInstalled: true, dockerBuildkitAvailable: true })
    .where(eq(servers.id, serverId));
  const ids: string[] = [];
  for (let n = 0; n < 2; n += 1) {
    const service = await post(`/api/projects/${projectId}/services`, {
      environmentId: String(environment.body.id),
      serverId,
      name: `svc-${short()}`,
      source: { kind: 'git', repositoryUrl: 'https://github.com/acme/api.git', branch: 'main' },
      internalPort: 8080 + n,
    });
    expect(service.statusCode, service.raw).toBe(201);
    ids.push(String(service.body.id));
  }
  return { projectId, serviceIds: [String(ids[0]), String(ids[1])] };
}

const SHA = '0123456789abcdef0123456789abcdef01234567';

async function seed(serviceId: string, count: number, prefix: string): Promise<void> {
  const base = Date.parse('2026-10-16T12:00:00.000Z');
  await postgres.db.insert(webhookDeliveries).values(
    Array.from({ length: count }, (_, i) => ({
      serviceId,
      deliveryId: `${prefix}-${String(i)}`,
      event: 'push',
      outcome: 'deployed' as const,
      pushedSha: SHA,
      receivedAt: new Date(base + i * 1000),
    })),
  );
}

function url(fx: Fixture, serviceId: string, query = ''): string {
  return `/api/projects/${fx.projectId}/services/${serviceId}/webhook/deliveries${query}`;
}

async function get(path: string): Promise<{ statusCode: number; body: Json; raw: string }> {
  const response = await app.inject({ method: 'GET', url: path, headers: { cookie } });
  return { statusCode: response.statusCode, body: response.json() as Json, raw: response.body };
}

beforeAll(async () => {
  postgres = await startPostgres();
  process.env.NOODARA_MASTER_KEY = randomBytes(32).toString('base64');
  process.env.BETTER_AUTH_SECRET = `test-fixture-${randomUUID()}-${randomUUID()}`;
  process.env.DATABASE_URL = postgres.connectionString;
  process.env.REDIS_URL = 'redis://localhost:6379';
  process.env.NOODARA_PUBLIC_URL = 'http://noodara.example.test:3000';
  const { buildApp } = await import('../../../apps/control-plane/src/app.js');
  app = buildApp();
  cookie = await signIn();
});

afterAll(async () => {
  await app.close();
  await postgres.stop();
});

describe('GET webhook/deliveries (19-08 A3)', () => {
  it('answers 400 for a malformed cursor', async () => {
    const fx = await newFixture();
    for (const cursor of ['not-a-cursor', 'AAAA', Buffer.from('{"t":"x","id":"y"}').toString('base64url'), '%20']) {
      const res = await get(url(fx, fx.serviceIds[0], `?cursor=${cursor}`));
      expect(res.statusCode, `${cursor}: ${res.raw}`).toBe(400);
      expect(res.body.error).toBe('VALIDATION_FAILED');
    }
  });

  it('pages newest first with a keyset cursor and no overlap', async () => {
    const fx = await newFixture();
    await seed(fx.serviceIds[0], 5, 'a');
    const seen: string[] = [];
    let cursor: string | null = null;
    let pages = 0;
    do {
      const res = await get(url(fx, fx.serviceIds[0], `?limit=2${cursor === null ? '' : `&cursor=${cursor}`}`));
      expect(res.statusCode, res.raw).toBe(200);
      const rows = res.body.deliveries as { deliveryId: string }[];
      seen.push(...rows.map((row) => row.deliveryId));
      cursor = res.body.nextCursor as string | null;
      pages += 1;
    } while (cursor !== null && pages < 10);
    expect(pages).toBe(3);
    expect(seen).toStrictEqual(['a-4', 'a-3', 'a-2', 'a-1', 'a-0']);
  });

  it('scopes rows to the service and exposes no payload fields', async () => {
    const fx = await newFixture();
    await seed(fx.serviceIds[0], 2, 'mine');
    await seed(fx.serviceIds[1], 3, 'other');
    const res = await get(url(fx, fx.serviceIds[0]));
    expect(res.statusCode, res.raw).toBe(200);
    const rows = res.body.deliveries as Json[];
    expect(rows.map((row) => row.deliveryId).sort()).toStrictEqual(['mine-0', 'mine-1']);
    expect(res.raw).not.toContain('other-');
    for (const row of rows) {
      expect(Object.keys(row).sort()).toStrictEqual(
        ['deliveryId', 'deploymentId', 'event', 'id', 'outcome', 'pushedSha', 'receivedAt'],
      );
    }
    expect(res.raw).not.toMatch(/payload|signature|secret/i);
  });
});
