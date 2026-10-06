import { randomBytes, randomUUID } from 'node:crypto';
import { Queue } from 'bullmq';
import { eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import type { Redis } from 'ioredis';
import parseSetCookie from 'set-cookie-parser';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { revealSecret } from '@noodara/domain/security';
import { activityEvents } from '../../../apps/control-plane/src/db/schema/activity-events.js';
import { deployments } from '../../../apps/control-plane/src/db/schema/deployments.js';
import { servers } from '../../../apps/control-plane/src/db/schema/servers.js';
import type { ServerEvent, ServerEventPublisher } from '../../../apps/control-plane/src/events/server-event-publisher.js';
import { BULLMQ_PREFIX } from '../../../apps/control-plane/src/queue/connect-server-queue.js';
import { createDeployQueue, DEPLOY_QUEUE_NAME, type DeployQueue } from '../../../apps/control-plane/src/queue/deploy-queue.js';
import { createQueueRedisConnection } from '../../../apps/control-plane/src/redis/connections.js';
import { issueToken } from '../../../apps/control-plane/src/services/setup-token-repository.js';
import { startPostgres, type PostgresFixture } from '../helpers/postgres.js';
import { startRedis, type RedisFixture } from '../helpers/redis.js';

// 12-10: `POST /api/services/:serviceId/deploy` and the deployment reads against the real HTTP
// surface, a migrated Postgres and a real Redis/BullMQ queue. No worker runs here, so every job
// stays waiting and every deployment stays QUEUED unless a test moves it. The Redis-down case runs
// last because it stops the container.

const ADMIN_EMAIL = 'admin@noodara.test';
const ADMIN_PASSWORD = 'correct horse battery staple';
const CANARY = 'ghp_deployCanary0123456789abcdefABCDEF';

type Json = Record<string, unknown>;

let postgres: PostgresFixture;
let redis: RedisFixture;
let queueConnection: Redis;
let inspectConnection: Redis;
let deployQueue: DeployQueue;
let inspector: Queue;
let app: FastifyInstance;
let cookie: string;
/** Loaded after `setTestEnv`: deployment-services pulls in env.ts through the activity redactor. */
let viewFields: readonly string[];
const published: ServerEvent[] = [];

const recorder: ServerEventPublisher = {
  publish(event) {
    published.push(event);
    return Promise.resolve();
  },
};

function setTestEnv(connectionString: string, redisUrl: string): void {
  process.env.NOODARA_MASTER_KEY = randomBytes(32).toString('base64');
  process.env.BETTER_AUTH_SECRET = `test-fixture-${randomUUID()}-${randomUUID()}`;
  process.env.DATABASE_URL = connectionString;
  process.env.REDIS_URL = redisUrl;
  process.env.NOODARA_PUBLIC_URL = 'http://localhost:3000';
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

async function call(method: 'GET' | 'POST' | 'PUT', url: string, payload?: unknown): Promise<{ statusCode: number; body: Json }> {
  const response = await app.inject({
    method,
    url,
    headers: { cookie },
    ...(payload !== undefined ? { payload: payload as Json } : {}),
  });
  return { statusCode: response.statusCode, body: response.json() as Json };
}

const deploy = (serviceId: string, payload?: unknown) => call('POST', `/api/services/${serviceId}/deploy`, payload);

function short(): string {
  return randomUUID().replace(/-/g, '').slice(0, 10);
}

/** A git service with an HTTPS token stored on it, so a leak of the credential would be visible. */
async function newService(): Promise<{ projectId: string; serviceId: string; serverId: string }> {
  const project = await call('POST', '/api/projects', { name: `Deploy ${short()}` });
  expect(project.statusCode, JSON.stringify(project.body)).toBe(201);
  const projectId = String(project.body.id);
  const environment = await call('POST', `/api/projects/${projectId}/environments`, { name: 'production' });
  expect(environment.statusCode).toBe(201);
  const server = await call('POST', '/api/servers', {
    name: `srv-${short()}`,
    host: `${short()}.example.test`,
    credential: { type: 'ssh_password', password: 'not-used-by-this-test' },
  });
  expect(server.statusCode).toBe(201);
  const serverId = String(server.body.id);
  await postgres.db
    .update(servers)
    .set({ status: 'CONNECTED', dockerInstalled: true, dockerBuildkitAvailable: true })
    .where(eq(servers.id, serverId));
  const service = await call('POST', `/api/projects/${projectId}/services`, {
    environmentId: String(environment.body.id),
    name: `api-${short()}`,
    serverId,
    source: { kind: 'git', repositoryUrl: 'https://github.com/acme/api.git', branch: 'main' },
    internalPort: 3000,
    publishedPort: 20000 + Math.floor(Math.random() * 20000),
  });
  expect(service.statusCode, JSON.stringify(service.body)).toBe(201);
  const serviceId = String(service.body.id);
  const credential = await call('PUT', `/api/projects/${projectId}/services/${serviceId}/credentials/repository`, {
    kind: 'https_token',
    token: CANARY,
  });
  expect(credential.statusCode, JSON.stringify(credential.body)).toBe(200);
  published.length = 0;
  return { projectId, serviceId, serverId };
}

async function rowsFor(serviceId: string) {
  return postgres.db.select().from(deployments).where(eq(deployments.serviceId, serviceId));
}

beforeAll(async () => {
  [postgres, redis] = await Promise.all([startPostgres(), startRedis()]);
  setTestEnv(postgres.connectionString, redis.connectionUrl);
  queueConnection = createQueueRedisConnection(redis.connectionUrl);
  inspectConnection = createQueueRedisConnection(redis.connectionUrl);
  deployQueue = createDeployQueue({ connection: queueConnection });
  inspector = new Queue(DEPLOY_QUEUE_NAME, { connection: inspectConnection, prefix: BULLMQ_PREFIX });
  const { buildApp } = await import('../../../apps/control-plane/src/app.js');
  ({ DEPLOYMENT_VIEW_FIELDS: viewFields } = await import('../../../apps/control-plane/src/services/deployment-services.js'));
  app = buildApp({ eventPublisher: recorder, deployQueue });
  cookie = await signIn();
}, 120_000);

afterAll(async () => {
  await app.close();
  await inspector.close().catch(() => undefined);
  await deployQueue.close().catch(() => undefined);
  queueConnection.disconnect();
  inspectConnection.disconnect();
  await redis.stop();
  await postgres.stop();
});

beforeEach(() => {
  published.length = 0;
});

describe('deploy (A1)', () => {
  it('inserts a QUEUED deployment with a source snapshot and enqueues deploy-<id> with ids only', async () => {
    const { serviceId } = await newService();

    const response = await deploy(serviceId);

    expect(response.statusCode, JSON.stringify(response.body)).toBe(201);
    expect(Object.keys(response.body)).toEqual([...viewFields]);
    expect(response.body).toMatchObject({
      serviceId,
      status: 'QUEUED',
      trigger: 'manual',
      source: { sourceType: 'git', repositoryUrl: 'https://github.com/acme/api.git', branch: 'main', internalPort: 3000 },
    });
    const deploymentId = String(response.body.id);

    const rows = await rowsFor(serviceId);
    expect(rows.map((row) => row.status)).toEqual(['QUEUED']);
    expect(JSON.stringify(rows[0]?.source)).not.toContain(CANARY);
    expect(JSON.stringify(rows[0]?.source)).not.toMatch(/credential/i);

    const job = await inspector.getJob(`deploy-${deploymentId}`);
    expect(job?.id).toBe(`deploy-${deploymentId}`);
    expect(Object.keys(job?.data as Json).sort()).toEqual(['actor', 'deploymentId', 'requestedAt', 'serviceId']);
    expect(job?.data).toMatchObject({ deploymentId, serviceId, actor: { type: 'user' } });
    expect(JSON.stringify(job?.data)).not.toContain(CANARY);

    const activity = await postgres.db.select().from(activityEvents).where(eq(activityEvents.entityId, deploymentId));
    expect(activity.map((event) => event.action)).toEqual(['deployment.queued']);

    expect(published.map((event) => event.type)).toEqual(['deployment.updated', 'service.updated']);
    expect(JSON.stringify(published)).not.toContain(CANARY);
  });

  it('accepts an explicit empty JSON object', async () => {
    const { serviceId } = await newService();
    expect((await deploy(serviceId, {})).statusCode).toBe(201);
  });

  it('answers 404 for an unknown service and 400 for a malformed id', async () => {
    expect((await deploy(randomUUID())).statusCode).toBe(404);
    expect((await deploy('not-a-uuid')).statusCode).toBe(400);
  });

  it('refuses a disconnected server with a named error', async () => {
    const { serviceId, serverId } = await newService();
    await postgres.db.update(servers).set({ status: 'UNREACHABLE' }).where(eq(servers.id, serverId));
    const response = await deploy(serviceId);
    expect(response.statusCode).toBe(409);
    expect(response.body.error).toBe('SERVER_NOT_CONNECTED');
    expect(await rowsFor(serviceId)).toHaveLength(0);
  });
});

describe('one active deployment per service (A2)', () => {
  it('answers 409 DEPLOYMENT_IN_PROGRESS for a second deploy while one is active', async () => {
    const { serviceId } = await newService();
    expect((await deploy(serviceId)).statusCode).toBe(201);

    const second = await deploy(serviceId);

    expect(second.statusCode).toBe(409);
    expect(second.body).toStrictEqual({ error: 'DEPLOYMENT_IN_PROGRESS', message: expect.any(String) });
    expect(await rowsFor(serviceId)).toHaveLength(1);
  });

  it('lets exactly one of two parallel deploys win', async () => {
    const { serviceId } = await newService();

    const results = await Promise.all([deploy(serviceId), deploy(serviceId)]);

    expect(results.map((result) => result.statusCode).sort()).toEqual([201, 409]);
    expect(results.find((result) => result.statusCode === 409)?.body.error).toBe('DEPLOYMENT_IN_PROGRESS');
    expect(await rowsFor(serviceId)).toHaveLength(1);
  });

  it('allows a new deploy once the previous one is terminal', async () => {
    const { serviceId } = await newService();
    const first = await deploy(serviceId);
    await postgres.db.update(deployments).set({ status: 'FAILED' }).where(eq(deployments.id, String(first.body.id)));
    expect((await deploy(serviceId)).statusCode).toBe(201);
  });
});

describe('archived project (A3)', () => {
  it('blocks deploys with PROJECT_ARCHIVED and creates nothing', async () => {
    const { projectId, serviceId } = await newService();
    expect((await call('POST', `/api/projects/${projectId}/archive`)).statusCode).toBe(200);

    const response = await deploy(serviceId);

    expect(response.statusCode).toBe(409);
    expect(response.body).toStrictEqual({ error: 'PROJECT_ARCHIVED', message: expect.any(String) });
    expect(await rowsFor(serviceId)).toHaveLength(0);
  });
});

describe('reads (A4, H2)', () => {
  it('lists newest first with keyset pagination and reads the detail', async () => {
    const { serviceId } = await newService();
    const ids: string[] = [];
    for (let index = 0; index < 3; index += 1) {
      const created = await deploy(serviceId);
      expect(created.statusCode).toBe(201);
      ids.push(String(created.body.id));
      await postgres.db.update(deployments).set({ status: 'SUCCESS' }).where(eq(deployments.id, String(created.body.id)));
    }

    const first = await call('GET', `/api/services/${serviceId}/deployments?limit=2`);
    expect(first.statusCode).toBe(200);
    const firstItems = first.body.items as Json[];
    expect(firstItems.map((item) => item.id)).toEqual([ids[2], ids[1]]);
    expect(first.body.nextCursor).toEqual(expect.any(String));

    const second = await call('GET', `/api/services/${serviceId}/deployments?limit=2&cursor=${String(first.body.nextCursor)}`);
    expect(second.statusCode).toBe(200);
    expect((second.body.items as Json[]).map((item) => item.id)).toEqual([ids[0]]);
    expect(second.body.nextCursor).toBeNull();

    const detail = await call('GET', `/api/services/${serviceId}/deployments/${String(ids[0])}`);
    expect(detail.statusCode).toBe(200);
    expect(detail.body.id).toBe(ids[0]);
    const byId = await call('GET', `/api/deployments/${String(ids[0])}`);
    expect(byId.statusCode).toBe(200);
    expect(byId.body).toStrictEqual(detail.body);

    expect(JSON.stringify([first.body, second.body, detail.body])).not.toContain(CANARY);
  });

  it('caps the page size and rejects malformed limits and cursors with 400', async () => {
    const { serviceId } = await newService();
    for (const query of ['limit=0', 'limit=101', 'limit=abc', 'cursor=', 'cursor=not-a-cursor', `cursor=${'a'.repeat(600)}`]) {
      const response = await call('GET', `/api/services/${serviceId}/deployments?${query}`);
      expect(response.statusCode, query).toBe(400);
    }
    expect((await call('GET', `/api/services/${serviceId}/deployments?limit=100`)).statusCode).toBe(200);
  });

  it('answers 404 for a deployment read under another service and for unknown ids', async () => {
    const owner = await newService();
    const other = await newService();
    const created = await deploy(owner.serviceId);
    const deploymentId = String(created.body.id);

    expect((await call('GET', `/api/services/${other.serviceId}/deployments/${deploymentId}`)).statusCode).toBe(404);
    expect((await call('GET', `/api/services/${randomUUID()}/deployments`)).statusCode).toBe(404);
    expect((await call('GET', `/api/deployments/${randomUUID()}`)).statusCode).toBe(404);
  });

  it('requires a session', async () => {
    const response = await app.inject({ method: 'GET', url: `/api/deployments/${randomUUID()}` });
    expect(response.statusCode).toBe(401);
  });
});

describe('deploy body (H3)', () => {
  it('rejects unknown fields with a named 422 and creates nothing', async () => {
    const { serviceId } = await newService();
    const response = await deploy(serviceId, { branch: 'dev' });
    expect(response.statusCode).toBe(422);
    expect(response.body).toStrictEqual({ error: 'DEPLOYMENT_INPUT_INVALID', message: expect.any(String) });
    expect(await rowsFor(serviceId)).toHaveLength(0);
  });

  it('enforces the body cap with 413', async () => {
    const { serviceId } = await newService();
    const response = await deploy(serviceId, { padding: 'x'.repeat(2048) });
    expect(response.statusCode).toBe(413);
    expect(response.body.error).toBe('PAYLOAD_TOO_LARGE');
    expect(await rowsFor(serviceId)).toHaveLength(0);
  });
});

// Runs last: it stops the Redis container.
describe('cancel body (12-10 H3)', () => {
  const cancel = (id: string, payload?: unknown) => call('POST', `/api/deployments/${id}/cancel`, payload);

  async function queued(): Promise<{ serviceId: string; id: string }> {
    const { serviceId } = await newService();
    const response = await deploy(serviceId);
    expect(response.statusCode).toBe(201);
    return { serviceId, id: response.body.id as string };
  }

  it('rejects unknown fields with the named 422 and cancels nothing', async () => {
    const { serviceId, id } = await queued();
    const response = await cancel(id, { x: 1 });
    expect(response.statusCode).toBe(422);
    expect(response.body).toStrictEqual({ error: 'DEPLOYMENT_INPUT_INVALID', message: expect.any(String) });
    expect((await rowsFor(serviceId))[0]?.status).toBe('QUEUED');
  });

  it('enforces the body cap with 413 and cancels nothing', async () => {
    const { serviceId, id } = await queued();
    const response = await cancel(id, { padding: 'x'.repeat(2048) });
    expect(response.statusCode).toBe(413);
    expect((await rowsFor(serviceId))[0]?.status).toBe('QUEUED');
  });

  it('still cancels with an empty object or no body', async () => {
    const first = await queued();
    expect((await cancel(first.id, {})).statusCode).toBe(202);
    const second = await queued();
    expect((await cancel(second.id)).statusCode).toBe(202);
  });
});

describe('queue unavailable (H1)', () => {
  it('answers a named 503 and leaves no QUEUED deployment behind when Redis is down', async () => {
    const { serviceId } = await newService();
    await redis.stop();

    const started = Date.now();
    const response = await deploy(serviceId);

    expect(response.statusCode).toBe(503);
    expect(response.body).toStrictEqual({ error: 'QUEUE_UNAVAILABLE', message: expect.any(String) });
    expect(Date.now() - started).toBeLessThan(10_000);
    expect(await rowsFor(serviceId)).toHaveLength(0);
    expect(published).toEqual([]);

    // The API is still up and serving reads.
    expect((await call('GET', `/api/services/${serviceId}/deployments`)).statusCode).toBe(200);
  }, 30_000);
});
