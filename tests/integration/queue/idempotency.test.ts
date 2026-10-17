import { createHmac, randomBytes, randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import type { Redis } from 'ioredis';
import parseSetCookie from 'set-cookie-parser';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { PostStartPollPolicy } from '@noodara/domain/deployment';
import { createRedactor, revealSecret } from '@noodara/domain/security';
import type { DeployJobDeps } from '../../../apps/control-plane/src/deploy/deploy-worker.js';
import type { RunDeploymentInput } from '../../../apps/control-plane/src/deploy/run-deployment.js';
import { deployments } from '../../../apps/control-plane/src/db/schema/deployments.js';
import { servers } from '../../../apps/control-plane/src/db/schema/servers.js';
import { noopServerEventPublisher } from '../../../apps/control-plane/src/events/server-event-publisher.js';
import { createDeployQueue, type DeployQueue } from '../../../apps/control-plane/src/queue/deploy-queue.js';
import { createQueueRedisConnection } from '../../../apps/control-plane/src/redis/connections.js';
import { issueToken } from '../../../apps/control-plane/src/services/setup-token-repository.js';
import { startPostgres, type PostgresFixture } from '../helpers/postgres.js';
import { startRedis, type RedisFixture } from '../helpers/redis.js';
import { runTeardown, settleWithin } from '../helpers/teardown.js';

// 18-05: Idempotency-Key on deploy / redeploy (A1, H1, H9) against the real HTTP surface, a migrated
// Postgres and a real BullMQ queue (no worker runs: rows stay QUEUED unless a test moves them), and
// the worker's re-delivery rule (A2, H2, ADR 0010 A3) over the real store with fake remote ports.

const ADMIN_EMAIL = 'admin@noodara.test';
const ADMIN_PASSWORD = 'correct horse battery staple';
const CANARY = 'ghp_idempotencyCanary0123456789abcdefAB';
const PUBLIC_URL = 'http://localhost:3000';
const DAY_MS = 24 * 60 * 60 * 1000;

type Json = Record<string, unknown>;

let postgres: PostgresFixture;
let redis: RedisFixture;
let queueConnection: Redis;
let deployQueue: DeployQueue;
let app: FastifyInstance;
let postgresStart: Promise<PostgresFixture> | undefined;
let redisStart: Promise<RedisFixture> | undefined;
let cookie: string;
const errorBodies: string[] = [];

const maybe = <T>(value: T): T | undefined => value;

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

interface Answer {
  readonly statusCode: number;
  readonly body: Json;
  readonly replayed: boolean;
}

async function call(method: 'GET' | 'POST' | 'PUT', url: string, payload?: unknown, key?: string): Promise<Answer> {
  const response = await app.inject({
    method,
    url,
    headers: { cookie, ...(key === undefined ? {} : { 'idempotency-key': key }) },
    ...(payload !== undefined ? { payload: payload as Json } : {}),
  });
  if (response.statusCode >= 500) errorBodies.push(response.body);
  return {
    statusCode: response.statusCode,
    body: response.body.length > 0 ? (response.json() as Json) : {},
    replayed: response.headers['idempotency-replayed'] === 'true',
  };
}

interface Svc {
  readonly projectId: string;
  readonly serviceId: string;
}

const deploy = (svc: Svc, key?: string) => call('POST', `/api/services/${svc.serviceId}/deploy`, undefined, key);
const redeploy = (svc: Svc, key?: string) =>
  call('POST', `/api/projects/${svc.projectId}/services/${svc.serviceId}/redeploy`, {}, key);

function short(): string {
  return randomUUID().replace(/-/g, '').slice(0, 10);
}

async function newService(): Promise<Svc> {
  const project = await call('POST', '/api/projects', { name: `Idem ${short()}` });
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
  await postgres.db
    .update(servers)
    .set({ status: 'CONNECTED', dockerInstalled: true, dockerBuildkitAvailable: true })
    .where(eq(servers.id, String(server.body.id)));
  const service = await call('POST', `/api/projects/${projectId}/services`, {
    environmentId: String(environment.body.id),
    name: `api-${short()}`,
    serverId: String(server.body.id),
    source: { kind: 'git', repositoryUrl: 'https://github.com/acme/api.git', branch: 'main' },
    internalPort: 3000,
  });
  expect(service.statusCode, JSON.stringify(service.body)).toBe(201);
  const serviceId = String(service.body.id);
  const credential = await call('PUT', `/api/projects/${projectId}/services/${serviceId}/credentials/repository`, {
    kind: 'https_token',
    token: CANARY,
  });
  expect(credential.statusCode).toBe(200);
  return { projectId, serviceId };
}

async function rowsFor(serviceId: string) {
  return postgres.db.select().from(deployments).where(eq(deployments.serviceId, serviceId));
}

/** Ends a row as if its worker finished it, freeing the service's one-active slot. */
async function endRow(deploymentId: string, status: 'FAILED' | 'CANCELLED' | 'SUCCESS' = 'CANCELLED'): Promise<void> {
  await postgres.db.update(deployments).set({ status, completedAt: new Date() }).where(eq(deployments.id, deploymentId));
}

async function ageRow(deploymentId: string, ms: number): Promise<void> {
  await postgres.db
    .update(deployments)
    .set({ createdAt: new Date(Date.now() - ms) })
    .where(eq(deployments.id, deploymentId));
}

beforeAll(async () => {
  postgresStart = startPostgres();
  redisStart = startRedis();
  [postgres, redis] = await Promise.all([postgresStart, redisStart]);
  process.env.NOODARA_MASTER_KEY = randomBytes(32).toString('base64');
  process.env.BETTER_AUTH_SECRET = `test-fixture-${randomUUID()}-${randomUUID()}`;
  process.env.DATABASE_URL = postgres.connectionString;
  process.env.REDIS_URL = redis.connectionUrl;
  process.env.NOODARA_PUBLIC_URL = PUBLIC_URL;
  queueConnection = createQueueRedisConnection(redis.connectionUrl);
  deployQueue = createDeployQueue({ connection: queueConnection });
  const { buildApp } = await import('../../../apps/control-plane/src/app.js');
  app = buildApp({ eventPublisher: noopServerEventPublisher, deployQueue });
  cookie = await signIn();
}, 120_000);

afterAll(async () => {
  const [pg, rd] = await Promise.all([settleWithin(postgresStart, 60_000), settleWithin(redisStart, 60_000)]);
  await runTeardown(
    'idempotency',
    [
      { name: 'app.close', run: () => maybe(app)?.close() },
      { name: 'deployQueue.close', run: () => maybe(deployQueue)?.close().catch(() => undefined) },
      { name: 'disconnect redis', run: () => void maybe(queueConnection)?.disconnect() },
      { name: 'redis.stop', run: () => rd?.stop(), timeoutMs: 60_000 },
      { name: 'postgres.stop', run: () => pg?.stop(), timeoutMs: 60_000 },
    ],
    { stepTimeoutMs: 30_000 },
  );
}, 240_000);

describe('Idempotency-Key replay (A1)', () => {
  it('a repeated deploy with the same key replays the original deployment and creates no second row', async () => {
    const svc = await newService();
    const key = `deploy-${short()}`;

    const first = await deploy(svc, key);
    const second = await deploy(svc, key);

    expect(first.statusCode, JSON.stringify(first.body)).toBe(201);
    expect(first.replayed).toBe(false);
    expect(second.statusCode).toBe(201);
    expect(second.replayed).toBe(true);
    expect(second.body.id).toBe(first.body.id);
    expect(await rowsFor(svc.serviceId)).toHaveLength(1);
  });

  it('replays after the deployment ended, instead of starting another one', async () => {
    const svc = await newService();
    const key = `ended-${short()}`;
    const first = await deploy(svc, key);
    await endRow(String(first.body.id), 'SUCCESS');

    const again = await deploy(svc, key);

    expect(again.statusCode).toBe(201);
    expect(again.replayed).toBe(true);
    expect(again.body).toMatchObject({ id: first.body.id, status: 'SUCCESS' });
    expect(await rowsFor(svc.serviceId)).toHaveLength(1);
  });

  it('a redeploy with the same key replays too', async () => {
    const svc = await newService();
    const key = `redeploy-${short()}`;
    const first = await redeploy(svc, key);
    const second = await redeploy(svc, key);
    expect(first.statusCode, JSON.stringify(first.body)).toBe(201);
    expect(second.replayed).toBe(true);
    expect(second.body.id).toBe(first.body.id);
    expect(await rowsFor(svc.serviceId)).toHaveLength(1);
  });

  it('the same key for a different request answers 422 IDEMPOTENCY_KEY_REUSED and creates nothing', async () => {
    const svc = await newService();
    const key = `reuse-${short()}`;
    const first = await deploy(svc, key);
    await endRow(String(first.body.id));

    const asRedeploy = await redeploy(svc, key);
    const asRollback = await call('POST', `/api/services/${svc.serviceId}/rollback`, {}, key);

    expect(asRedeploy.statusCode).toBe(422);
    expect(asRedeploy.body.error).toBe('IDEMPOTENCY_KEY_REUSED');
    expect(asRollback.statusCode).toBe(422);
    expect(asRollback.body.error).toBe('IDEMPOTENCY_KEY_REUSED');
    expect(await rowsFor(svc.serviceId)).toHaveLength(1);
  });

  it('a key is scoped to its service', async () => {
    const [a, b] = [await newService(), await newService()];
    const key = `shared-${short()}`;
    const first = await deploy(a, key);
    const second = await deploy(b, key);
    expect(second.statusCode).toBe(201);
    expect(second.replayed).toBe(false);
    expect(second.body.id).not.toBe(first.body.id);
  });

  it('concurrent requests with one key create exactly one row and all answer it (A1, H9)', async () => {
    const svc = await newService();
    const key = `race-${short()}`;

    const answers = await Promise.all(Array.from({ length: 6 }, () => deploy(svc, key)));

    expect(answers.map((answer) => answer.statusCode)).toStrictEqual(Array(6).fill(201));
    expect(new Set(answers.map((answer) => answer.body.id)).size).toBe(1);
    expect(answers.filter((answer) => !answer.replayed)).toHaveLength(1);
    expect(await rowsFor(svc.serviceId)).toHaveLength(1);
  });

  it('concurrent requests with different keys answer one 201 and typed 409s, never a 500 (H9)', async () => {
    const svc = await newService();

    const answers = await Promise.all(Array.from({ length: 4 }, (_, n) => deploy(svc, `k${n.toString()}-${short()}`)));

    expect(answers.map((answer) => answer.statusCode).sort()).toStrictEqual([201, 409, 409, 409]);
    expect(answers.filter((answer) => answer.statusCode === 409).every((answer) => answer.body.error === 'DEPLOYMENT_IN_PROGRESS')).toBe(true);
    expect(await rowsFor(svc.serviceId)).toHaveLength(1);
  });
});

describe('Idempotency-Key validation, storage and expiry (H1)', () => {
  it.each([
    ['longer than 255 characters', 'k'.repeat(256)],
    ['a space', 'bad key'],
    ['a non-ASCII character', 'clé'],
  ])('a key with %s answers 400 without creating a deployment', async (_label, key) => {
    const svc = await newService();
    const viaDeploy = await deploy(svc, key);
    const viaRedeploy = await redeploy(svc, key);
    expect(viaDeploy.statusCode).toBe(400);
    expect(viaDeploy.body.error).toBe('IDEMPOTENCY_KEY_INVALID');
    expect(viaRedeploy.statusCode).toBe(400);
    expect(viaRedeploy.body.error).toBe('IDEMPOTENCY_KEY_INVALID');
    expect(await rowsFor(svc.serviceId)).toHaveLength(0);
  });

  it('accepts a key of exactly 255 characters', async () => {
    const svc = await newService();
    expect((await deploy(svc, 'k'.repeat(255))).statusCode).toBe(201);
  });

  it('stores only a SHA-256 fingerprint of { action, serviceId }: no credential, actor or body', async () => {
    const svc = await newService();
    const key = `fp-${short()}`;
    await deploy(svc, key);
    const { deployFingerprint } = await import('../../../apps/control-plane/src/services/deployment-services.js');
    const [row] = await rowsFor(svc.serviceId);
    expect(row?.idempotencyKey).toBe(key);
    expect(row?.requestFingerprint).toBe(deployFingerprint('deploy', svc.serviceId));
    expect(row?.requestFingerprint).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.stringify(row)).not.toContain(CANARY);
  });

  it('a key older than 24 h no longer replays: it creates a new deployment and the old one releases it', async () => {
    const svc = await newService();
    const key = `old-${short()}`;
    const first = await deploy(svc, key);
    await endRow(String(first.body.id));
    await ageRow(String(first.body.id), DAY_MS + 60_000);

    const again = await deploy(svc, key);

    expect(again.statusCode, JSON.stringify(again.body)).toBe(201);
    expect(again.replayed).toBe(false);
    expect(again.body.id).not.toBe(first.body.id);
    const rows = await rowsFor(svc.serviceId);
    expect(rows.find((row) => row.id === first.body.id)).toMatchObject({ idempotencyKey: null, requestFingerprint: null });
    expect(rows.find((row) => row.id === again.body.id)?.idempotencyKey).toBe(key);
  });

  it('a key just under 24 h old still replays', async () => {
    const svc = await newService();
    const key = `young-${short()}`;
    const first = await deploy(svc, key);
    await ageRow(String(first.body.id), DAY_MS - 60_000);
    const again = await deploy(svc, key);
    expect(again.replayed).toBe(true);
    expect(again.body.id).toBe(first.body.id);
  });

  it('the expiry job releases expired keys in bounded batches and leaves live ones', async () => {
    const svc = await newService();
    const ids: string[] = [];
    for (let n = 0; n < 3; n += 1) {
      const answer = await deploy(svc, `batch-${n.toString()}-${short()}`);
      expect(answer.statusCode).toBe(201);
      ids.push(String(answer.body.id));
      await endRow(String(answer.body.id));
    }
    for (const id of ids.slice(0, 2)) await ageRow(id, 2 * DAY_MS);
    const { expireIdempotencyKeys } = await import('../../../apps/control-plane/src/services/deployment-services.js');
    const deps = { db: postgres.db, now: () => new Date() };

    expect(await expireIdempotencyKeys(deps, 1)).toBe(1);
    let released = 1;
    for (let pass = 0; pass < 50; pass += 1) {
      const n = await expireIdempotencyKeys(deps, 100);
      released += n;
      if (n === 0) break;
    }
    expect(released).toBeGreaterThanOrEqual(2);

    const rows = await rowsFor(svc.serviceId);
    expect(rows.filter((row) => ids.slice(0, 2).includes(row.id)).map((row) => row.idempotencyKey)).toStrictEqual([null, null]);
    expect(rows.find((row) => row.id === ids[2])?.idempotencyKey).not.toBeNull();
  });
});

describe('re-delivered deploy job (A2, H2, ADR 0010 A3)', () => {
  async function workerOverRealStore() {
    const { createDeploymentStore } = await import('../../../apps/control-plane/src/deploy/deployment-store.js');
    const { createDeployJobHandler } = await import('../../../apps/control-plane/src/deploy/deploy-worker.js');
    const store = createDeploymentStore({ db: postgres.db, now: () => new Date(), events: noopServerEventPublisher });
    // Unreachable: any remote command would need this port; its call count proves none ran.
    const connect = vi.fn(() => Promise.resolve({ ok: false as const, code: 'SERVER_UNREACHABLE' as const }));
    const run = vi.fn(() => Promise.reject(new Error('a step must never re-run after a crash')));
    const deps: DeployJobDeps = {
      store,
      loadTarget: vi.fn(() => Promise.reject(new Error('never loaded on a re-delivery'))),
      connect,
      run,
      createRedactor,
      sinkFor: () => ({ write: () => undefined, close: () => Promise.resolve() }),
      limits: { killConfirmMs: 1000, killPollMs: 50, cleanupStepMs: 1000, maxLineBytes: 4096 } as RunDeploymentInput['limits'],
      pollPolicy: {} as PostStartPollPolicy,
      clock: { now: () => Date.now(), sleep: () => Promise.resolve() },
      logger: { info: () => undefined, warn: () => undefined, error: () => undefined },
    };
    return { handle: createDeployJobHandler(deps), connect, run };
  }

  const payloadOf = (svc: Svc, deploymentId: string) => ({
    deploymentId,
    serviceId: svc.serviceId,
    actor: { type: 'system' },
    requestedAt: new Date().toISOString(),
  });

  it.each(['SUCCESS', 'FAILED', 'CANCELLED'] as const)('a job for a %s row exits without any remote command', async (status) => {
    const svc = await newService();
    const first = await deploy(svc);
    await endRow(String(first.body.id), status);
    const w = await workerOverRealStore();

    await expect(w.handle(payloadOf(svc, String(first.body.id)))).resolves.toEqual({ outcome: 'ALREADY_CLAIMED' });

    expect(w.connect).toHaveBeenCalledTimes(0);
    expect(w.run).toHaveBeenCalledTimes(0);
    expect((await rowsFor(svc.serviceId))[0]?.status).toBe(status);
  });

  it.each(['PREPARING', 'BUILDING', 'DEPLOYING'] as const)(
    'a job for a %s row left by a crashed worker recovers it (FAILED / WORKER_CRASHED) and never re-runs a step',
    async (status) => {
      const svc = await newService();
      const first = await deploy(svc);
      await postgres.db.update(deployments).set({ status, startedAt: new Date() }).where(eq(deployments.id, String(first.body.id)));
      const w = await workerOverRealStore();

      await expect(w.handle(payloadOf(svc, String(first.body.id)))).resolves.toEqual({ outcome: 'CRASH_RECOVERED' });

      expect(w.run).toHaveBeenCalledTimes(0);
      // Only the recovery's cleanup connection; no step (no `docker create`) ran again.
      expect(w.connect).toHaveBeenCalledTimes(1);
      const rows = await rowsFor(svc.serviceId);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ status: 'FAILED', errorCode: 'WORKER_CRASHED' });

      // A third delivery finds the row terminal: no remote command at all.
      await expect(w.handle(payloadOf(svc, String(first.body.id)))).resolves.toEqual({ outcome: 'ALREADY_CLAIMED' });
      expect(w.connect).toHaveBeenCalledTimes(1);
    },
  );
});

describe('webhook hook-id and delivery uniqueness (H9)', () => {
  it('two concurrent identical deliveries answer typed 2xx, never a 500, with one deployment', async () => {
    const svc = await newService();
    const enabled = await call('POST', `/api/projects/${svc.projectId}/services/${svc.serviceId}/webhook`);
    expect(enabled.statusCode, JSON.stringify(enabled.body)).toBe(200);
    const secret = String(enabled.body.secret);
    const hookId = String(enabled.body.payloadUrl).split('/webhooks/github/')[1] ?? '';
    const sha = randomBytes(20).toString('hex');
    const body = `{"ref":"refs/heads/main","after":"${sha}","deleted":false,"repository":{"clone_url":"https://github.com/acme/api.git","ssh_url":"git@github.com:acme/api.git"},"head_commit":{"id":"${sha}"}}`;
    const signature = `sha256=${createHmac('sha256', secret).update(body).digest('hex')}`;
    const delivery = randomUUID();
    const send = () =>
      app.inject({
        method: 'POST',
        url: `/webhooks/github/${hookId}`,
        headers: {
          'content-type': 'application/json',
          'x-github-event': 'push',
          'x-github-delivery': delivery,
          'x-hub-signature-256': signature,
          'user-agent': 'GitHub-Hookshot/abc123',
        },
        payload: body,
      });

    const answers = await Promise.all([send(), send(), send()]);

    for (const answer of answers) expect(answer.statusCode, answer.body).toBeLessThan(500);
    expect(answers.map((answer) => answer.statusCode)).toStrictEqual([202, 202, 202]);
    expect(await rowsFor(svc.serviceId)).toHaveLength(1);
  });

  it('no request in this suite answered a 500', () => {
    expect(errorBodies).toStrictEqual([]);
  });
});
