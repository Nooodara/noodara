import { createHmac, randomBytes, randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import parseSetCookie from 'set-cookie-parser';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createRedactor, revealSecret } from '@noodara/domain/security';
import type { PostStartPollPolicy } from '@noodara/domain/deployment';
import { deployments } from '../../../apps/control-plane/src/db/schema/deployments.js';
import { servers } from '../../../apps/control-plane/src/db/schema/servers.js';
import { services } from '../../../apps/control-plane/src/db/schema/services.js';
import { webhookDeliveries } from '../../../apps/control-plane/src/db/schema/webhook-deliveries.js';
import type { DeployTarget } from '../../../apps/control-plane/src/deploy/deploy-worker.js';
import type { RunDeploymentInput } from '../../../apps/control-plane/src/deploy/run-deployment.js';
import { noopServerEventPublisher } from '../../../apps/control-plane/src/events/server-event-publisher.js';
import type { DeployServiceJobPayload } from '../../../apps/control-plane/src/queue/deploy-job-payload.js';
import type { DeployEnqueueResult, DeployQueue } from '../../../apps/control-plane/src/queue/deploy-queue.js';
import { issueToken } from '../../../apps/control-plane/src/services/setup-token-repository.js';
import type { PendingTriggerDrainDeps } from '../../../apps/control-plane/src/services/webhook-ingest.js';
import { startPostgres, type PostgresFixture } from '../helpers/postgres.js';

// 18-04: a push during an active deployment takes the service's single pending slot (latest wins)
// and runs once that deployment ends, from the deploy worker or the sweep. Real HTTP surface and a
// migrated Postgres; the deploy queue is a recording fake whose enqueue can fail (H2).

const ADMIN_EMAIL = 'admin@noodara.test';
const ADMIN_PASSWORD = 'correct horse battery staple';
const PUBLIC_URL = 'http://noodara.example.test:3000';
const REPO = 'https://github.com/acme/api.git';

type Json = Record<string, unknown>;

let postgres: PostgresFixture;
let app: FastifyInstance;
let cookie: string;
const enqueued: DeployServiceJobPayload[] = [];
let enqueueMode: 'ok' | 'unavailable' | 'throw' = 'ok';
const stubBroadcaster = { start: () => Promise.resolve(), stop: () => Promise.resolve(), closeAll: () => Promise.resolve() };
const silent = { info: () => undefined, warn: () => undefined, error: () => undefined };
// Loaded after the env is set: these modules read it at import time.
let createDeployJobHandler: typeof import('../../../apps/control-plane/src/deploy/deploy-worker.js').createDeployJobHandler;
let createDeploymentStore: typeof import('../../../apps/control-plane/src/deploy/deployment-store.js').createDeploymentStore;
let drainPendingTrigger: typeof import('../../../apps/control-plane/src/services/webhook-ingest.js').drainPendingTrigger;
let drainAllPendingTriggers: typeof import('../../../apps/control-plane/src/services/webhook-ingest.js').drainAllPendingTriggers;

const queue: DeployQueue = {
  enqueue(payload): Promise<DeployEnqueueResult> {
    if (enqueueMode === 'throw') return Promise.reject(new Error('redis down'));
    if (enqueueMode === 'unavailable') return Promise.resolve({ ok: false, code: 'QUEUE_UNAVAILABLE', message: 'down' });
    enqueued.push(payload);
    return Promise.resolve({ ok: true, jobId: payload.deploymentId });
  },
  removeJob: () => Promise.resolve(false),
  isJobPending: () => Promise.resolve(false),
  close: () => Promise.resolve(),
};

function storeOf() {
  return createDeploymentStore({ db: postgres.db, now: () => new Date(), events: noopServerEventPublisher });
}

function drainDeps(): PendingTriggerDrainDeps {
  const store = storeOf();
  return {
    db: postgres.db,
    now: () => new Date(),
    events: noopServerEventPublisher,
    queue,
    failUnqueued: (deploymentId, cutoff) => store.failStaleQueued(deploymentId, cutoff),
    logger: silent,
  };
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

async function api(url: string, payload?: Json): Promise<{ statusCode: number; body: Json }> {
  const response = await app.inject({ method: 'POST', url, headers: { cookie }, ...(payload !== undefined ? { payload } : {}) });
  return { statusCode: response.statusCode, body: (response.body.length > 0 ? response.json() : {}) as Json };
}

function short(): string {
  return randomUUID().replace(/-/g, '').slice(0, 10);
}

interface Hooked {
  readonly serviceId: string;
  readonly hookId: string;
  readonly secret: string;
}

async function hookedService(): Promise<Hooked> {
  const project = await api('/api/projects', { name: `Coalesce ${short()}` });
  expect(project.statusCode).toBe(201);
  const projectId = String(project.body.id);
  const environment = await api(`/api/projects/${projectId}/environments`, { name: 'production' });
  const server = await api('/api/servers', {
    name: `srv-${short()}`,
    host: `${short()}.example.test`,
    credential: { type: 'ssh_password', password: 'not-used-by-this-test' },
  });
  expect(server.statusCode).toBe(201);
  await postgres.db
    .update(servers)
    .set({ status: 'CONNECTED', dockerInstalled: true, dockerBuildkitAvailable: true })
    .where(eq(servers.id, String(server.body.id)));
  const service = await api(`/api/projects/${projectId}/services`, {
    environmentId: String(environment.body.id),
    serverId: String(server.body.id),
    name: `svc-${short()}`,
    source: { kind: 'git', repositoryUrl: REPO, branch: 'main' },
    internalPort: 8080,
  });
  expect(service.statusCode).toBe(201);
  const serviceId = String(service.body.id);
  const enabled = await api(`/api/projects/${projectId}/services/${serviceId}/webhook`);
  expect(enabled.statusCode).toBe(200);
  return {
    serviceId,
    hookId: String(enabled.body.payloadUrl).slice(`${PUBLIC_URL}/webhooks/github/`.length),
    secret: String(enabled.body.secret),
  };
}

function newSha(): string {
  return randomBytes(20).toString('hex');
}

function pushBody(sha: string): string {
  return JSON.stringify({
    ref: 'refs/heads/main',
    after: sha,
    deleted: false,
    repository: { clone_url: REPO, ssh_url: 'git@github.com:acme/api.git' },
    head_commit: { id: sha },
  });
}

async function push(hook: Hooked, sha: string, delivery: string = randomUUID()) {
  const body = pushBody(sha);
  const response = await app.inject({
    method: 'POST',
    url: `/webhooks/github/${hook.hookId}`,
    headers: {
      'content-type': 'application/json',
      'x-github-event': 'push',
      'x-github-delivery': delivery,
      'x-hub-signature-256': `sha256=${createHmac('sha256', hook.secret).update(body).digest('hex')}`,
    },
    payload: body,
  });
  return { statusCode: response.statusCode, body: response.json<Json>(), delivery };
}

async function deploymentsOf(serviceId: string) {
  return postgres.db.select().from(deployments).where(eq(deployments.serviceId, serviceId)).orderBy(deployments.createdAt);
}

async function deliveriesOf(serviceId: string) {
  return postgres.db.select().from(webhookDeliveries).where(eq(webhookDeliveries.serviceId, serviceId));
}

async function pendingOf(serviceId: string) {
  const [row] = await postgres.db
    .select({ deliveryId: services.pendingTriggerDeliveryId, sha: services.pendingTriggerSha })
    .from(services)
    .where(eq(services.id, serviceId));
  return row;
}

/** Ends a deployment directly, as the worker or a sweep would. */
async function endDeployment(
  deploymentId: string,
  status: 'SUCCESS' | 'FAILED' | 'CANCELLED' | 'ROLLED_BACK',
  extra: Partial<typeof deployments.$inferInsert> = {},
): Promise<void> {
  await postgres.db
    .update(deployments)
    .set({ status, completedAt: new Date(), ...extra })
    .where(eq(deployments.id, deploymentId));
}

/** A service with one active (QUEUED) webhook deployment for `sha`. */
async function activeService(sha = newSha()) {
  const hook = await hookedService();
  const first = await push(hook, sha);
  expect(first.statusCode).toBe(202);
  expect(first.body.outcome).toBe('deployed');
  return { hook, activeId: String(first.body.deploymentId), activeSha: sha, firstDelivery: first.delivery };
}

beforeAll(async () => {
  postgres = await startPostgres();
  process.env.NOODARA_MASTER_KEY = randomBytes(32).toString('base64');
  process.env.BETTER_AUTH_SECRET = `test-fixture-${randomUUID()}-${randomUUID()}`;
  process.env.DATABASE_URL = postgres.connectionString;
  process.env.REDIS_URL = 'redis://localhost:6379';
  process.env.NOODARA_PUBLIC_URL = PUBLIC_URL;
  const { buildApp } = await import('../../../apps/control-plane/src/app.js');
  ({ createDeployJobHandler } = await import('../../../apps/control-plane/src/deploy/deploy-worker.js'));
  ({ createDeploymentStore } = await import('../../../apps/control-plane/src/deploy/deployment-store.js'));
  ({ drainPendingTrigger, drainAllPendingTriggers } = await import('../../../apps/control-plane/src/services/webhook-ingest.js'));
  app = buildApp({
    eventPublisher: noopServerEventPublisher,
    broadcaster: stubBroadcaster as never,
    deployQueue: queue,
    webhookRateLimits: { perHook: { limit: 1000, windowMs: 60_000 }, perIp: { limit: 10_000, windowMs: 60_000 }, maxKeys: 1000 },
  });
  cookie = await signIn();
});

afterAll(async () => {
  await app.close();
  await postgres.stop();
});

describe('coalescing during an active deployment (A1)', () => {
  it('a push while a deployment is active takes the pending slot; a newer one replaces it and supersedes the older', async () => {
    const { hook, activeId } = await activeService();
    const before = enqueued.length;

    const shaB = newSha();
    const b = await push(hook, shaB);
    expect(b.statusCode).toBe(202);
    expect(b.body.outcome).toBe('coalesced');
    expect(await pendingOf(hook.serviceId)).toStrictEqual({ deliveryId: b.delivery, sha: shaB });

    const shaC = newSha();
    const c = await push(hook, shaC);
    expect(c.statusCode).toBe(202);
    expect(c.body.outcome).toBe('coalesced');
    expect(await pendingOf(hook.serviceId)).toStrictEqual({ deliveryId: c.delivery, sha: shaC });

    const byDelivery = new Map((await deliveriesOf(hook.serviceId)).map((row) => [row.deliveryId, row]));
    expect(byDelivery.get(b.delivery)).toMatchObject({ outcome: 'superseded', pushedSha: shaB, deploymentId: null });
    expect(byDelivery.get(c.delivery)).toMatchObject({ outcome: 'coalesced', pushedSha: shaC, deploymentId: null });
    expect((await deploymentsOf(hook.serviceId)).map((row) => row.id)).toStrictEqual([activeId]);
    expect(enqueued.length).toBe(before);
  });
});

describe('drain when the active deployment ends (A2, A3)', () => {
  it('the deploy worker claims the pending trigger after a terminal run and enqueues one webhook deployment', async () => {
    const { hook, activeId } = await activeService();
    const shaB = newSha();
    const b = await push(hook, shaB);
    expect(b.body.outcome).toBe('coalesced');
    const before = enqueued.length;

    const store = storeOf();
    const deps = drainDeps();
    const handle = createDeployJobHandler({
      store,
      loadTarget: () =>
        Promise.resolve({ ok: true as const, target: { serviceId: hook.serviceId, deploymentId: activeId } as unknown as DeployTarget, serverId: randomUUID() }),
      connect: () => Promise.resolve({ ok: false as const, code: 'SERVER_UNREACHABLE' as const }),
      createRedactor,
      sinkFor: () => ({ write: () => undefined, close: () => Promise.resolve() }),
      limits: {} as RunDeploymentInput['limits'],
      pollPolicy: {} as PostStartPollPolicy,
      clock: { now: () => 0, sleep: () => Promise.resolve() },
      logger: silent,
      drainPendingTrigger: (serviceId) => drainPendingTrigger(deps, serviceId),
    });

    const result = await handle({ deploymentId: activeId, serviceId: hook.serviceId, actor: { type: 'system' }, requestedAt: new Date().toISOString() });
    expect(result).toStrictEqual({ outcome: 'FAILED' });

    const rows = await deploymentsOf(hook.serviceId);
    expect(rows).toHaveLength(2);
    const followUp = rows[1];
    expect(followUp).toMatchObject({ status: 'QUEUED', trigger: 'webhook', triggeredBy: `github:${b.delivery}`, commitSha: shaB });
    const [delivery] = (await deliveriesOf(hook.serviceId)).filter((row) => row.deliveryId === b.delivery);
    expect(delivery).toMatchObject({ outcome: 'deployed', deploymentId: followUp?.id });
    expect(followUp?.webhookDeliveryId).toBe(delivery?.id);
    expect(await pendingOf(hook.serviceId)).toStrictEqual({ deliveryId: null, sha: null });
    expect(enqueued.slice(before)).toStrictEqual([expect.objectContaining({ deploymentId: followUp?.id, serviceId: hook.serviceId })]);
  });

  it('runs after any terminal state, and concurrent terminal events enqueue exactly one deployment', async () => {
    for (const status of ['SUCCESS', 'FAILED', 'CANCELLED', 'ROLLED_BACK'] as const) {
      const { hook, activeId } = await activeService();
      const shaB = newSha();
      expect((await push(hook, shaB)).body.outcome).toBe('coalesced');
      await endDeployment(activeId, status);
      const before = enqueued.length;

      const results = await Promise.all(Array.from({ length: 6 }, () => drainPendingTrigger(drainDeps(), hook.serviceId)));

      expect(results.filter((r) => r.kind === 'enqueued')).toHaveLength(1);
      const followUps = (await deploymentsOf(hook.serviceId)).filter((row) => row.id !== activeId);
      expect(followUps, status).toHaveLength(1);
      expect(followUps[0]).toMatchObject({ status: 'QUEUED', commitSha: shaB });
      expect(enqueued.length - before).toBe(1);
      expect(await pendingOf(hook.serviceId)).toStrictEqual({ deliveryId: null, sha: null });
    }
  });

  it('waits while a deployment is still active (busy) and changes nothing', async () => {
    const { hook } = await activeService();
    const shaB = newSha();
    const b = await push(hook, shaB);
    expect(await drainPendingTrigger(drainDeps(), hook.serviceId)).toStrictEqual({ kind: 'busy' });
    expect(await pendingOf(hook.serviceId)).toStrictEqual({ deliveryId: b.delivery, sha: shaB });
    expect(await deploymentsOf(hook.serviceId)).toHaveLength(1);
  });

  it('A3: a pending SHA equal to the SHA just deployed is dropped with outcome already_deployed', async () => {
    const sha = newSha();
    const { hook, activeId } = await activeService(sha);
    const again = await push(hook, sha);
    expect(again.body.outcome).toBe('coalesced');
    await endDeployment(activeId, 'SUCCESS', { commitSha: sha });
    const before = enqueued.length;

    expect(await drainPendingTrigger(drainDeps(), hook.serviceId)).toStrictEqual({ kind: 'dropped', outcome: 'already_deployed' });

    const [delivery] = (await deliveriesOf(hook.serviceId)).filter((row) => row.deliveryId === again.delivery);
    expect(delivery).toMatchObject({ outcome: 'already_deployed', deploymentId: null });
    expect(await deploymentsOf(hook.serviceId)).toHaveLength(1);
    expect(await pendingOf(hook.serviceId)).toStrictEqual({ deliveryId: null, sha: null });
    expect(enqueued.length).toBe(before);
  });

  it('a push during the follow-up coalesces behind it and leaves the drained delivery deployed', async () => {
    const { hook, activeId } = await activeService();
    const b = await push(hook, newSha());
    await endDeployment(activeId, 'FAILED');
    const drained = await drainPendingTrigger(drainDeps(), hook.serviceId);
    expect(drained.kind).toBe('enqueued');

    const shaC = newSha();
    const c = await push(hook, shaC);
    expect(c.body.outcome).toBe('coalesced');
    const byDelivery = new Map((await deliveriesOf(hook.serviceId)).map((row) => [row.deliveryId, row]));
    expect(byDelivery.get(b.delivery)?.outcome).toBe('deployed');
    expect(await pendingOf(hook.serviceId)).toStrictEqual({ deliveryId: c.delivery, sha: shaC });
  });
});

describe('race safety and retention (H1, H2)', () => {
  it('H1: N parallel pushes during a deploy leave one pending trigger (the newest), supersede the rest, and drain once', async () => {
    const { hook, activeId } = await activeService();
    const shas = Array.from({ length: 8 }, () => newSha());

    const responses = await Promise.all(shas.map((sha) => push(hook, sha)));
    for (const response of responses) {
      expect(response.statusCode).toBe(202);
      expect(response.body.outcome).toBe('coalesced');
    }

    const rows = (await deliveriesOf(hook.serviceId)).filter((row) => responses.some((r) => r.delivery === row.deliveryId));
    const coalesced = rows.filter((row) => row.outcome === 'coalesced');
    expect(coalesced).toHaveLength(1);
    expect(rows.filter((row) => row.outcome === 'superseded')).toHaveLength(shas.length - 1);
    const newest = coalesced[0];
    // The newest by receipt order: recorded no earlier than any delivery it superseded.
    for (const row of rows) expect(row.receivedAt.getTime()).toBeLessThanOrEqual(newest?.receivedAt.getTime() ?? 0);
    expect(await pendingOf(hook.serviceId)).toStrictEqual({ deliveryId: newest?.deliveryId, sha: newest?.pushedSha });

    await endDeployment(activeId, 'SUCCESS');
    const before = enqueued.length;
    await Promise.all([drainPendingTrigger(drainDeps(), hook.serviceId), drainPendingTrigger(drainDeps(), hook.serviceId)]);
    const followUps = (await deploymentsOf(hook.serviceId)).filter((row) => row.id !== activeId);
    expect(followUps).toHaveLength(1);
    expect(followUps[0]?.commitSha).toBe(newest?.pushedSha);
    expect(enqueued.length - before).toBe(1);
  });

  it('H2: a failed follow-up enqueue retains the pending trigger and the next drain runs it', async () => {
    const { hook, activeId } = await activeService();
    const shaB = newSha();
    const b = await push(hook, shaB);
    await endDeployment(activeId, 'FAILED');

    for (const mode of ['unavailable', 'throw'] as const) {
      enqueueMode = mode;
      try {
        const failed = await drainPendingTrigger(drainDeps(), hook.serviceId);
        expect(failed.kind).toBe('enqueue_failed');
      } finally {
        enqueueMode = 'ok';
      }
      expect(await pendingOf(hook.serviceId)).toStrictEqual({ deliveryId: b.delivery, sha: shaB });
      const [delivery] = (await deliveriesOf(hook.serviceId)).filter((row) => row.deliveryId === b.delivery);
      expect(delivery).toMatchObject({ outcome: 'coalesced', deploymentId: null });
    }
    const failedFollowUps = (await deploymentsOf(hook.serviceId)).filter((row) => row.id !== activeId);
    expect(failedFollowUps.map((row) => [row.status, row.errorCode])).toStrictEqual([
      ['FAILED', 'ENQUEUE_FAILED'],
      ['FAILED', 'ENQUEUE_FAILED'],
    ]);

    const retried = await drainPendingTrigger(drainDeps(), hook.serviceId);
    expect(retried.kind).toBe('enqueued');
    const [delivery] = (await deliveriesOf(hook.serviceId)).filter((row) => row.deliveryId === b.delivery);
    expect(delivery).toMatchObject({ outcome: 'deployed', deploymentId: retried.kind === 'enqueued' ? retried.deploymentId : null });
    expect(await pendingOf(hook.serviceId)).toStrictEqual({ deliveryId: null, sha: null });
  });

  it('H2: a pending delivery whose follow-up was enqueued but never cleared is not deployed twice', async () => {
    const { hook, activeId } = await activeService();
    const b = await push(hook, newSha());
    await endDeployment(activeId, 'FAILED');
    const drained = await drainPendingTrigger(drainDeps(), hook.serviceId);
    expect(drained.kind).toBe('enqueued');
    // Simulate a lost clear: the slot still names the delivery that already ran.
    const [delivery] = (await deliveriesOf(hook.serviceId)).filter((row) => row.deliveryId === b.delivery);
    await postgres.db
      .update(services)
      .set({ pendingTriggerDeliveryId: b.delivery, pendingTriggerSha: delivery?.pushedSha ?? null, pendingTriggerAt: new Date() })
      .where(eq(services.id, hook.serviceId));
    if (drained.kind === 'enqueued') await endDeployment(drained.deploymentId, 'FAILED');

    expect(await drainPendingTrigger(drainDeps(), hook.serviceId)).toStrictEqual({ kind: 'none' });
    expect(await deploymentsOf(hook.serviceId)).toHaveLength(2);
    expect(await pendingOf(hook.serviceId)).toStrictEqual({ deliveryId: null, sha: null });
  });

  it('H2: the sweep path drains a service whose deployment a crashed worker left behind', async () => {
    const { hook, activeId } = await activeService();
    const shaB = newSha();
    await push(hook, shaB);
    const busy = await activeService();
    await push(busy.hook, newSha());

    // The crash sweep ends the stranded row FAILED/WORKER_CRASHED; no job will ever run for it.
    await endDeployment(activeId, 'FAILED', { errorCode: 'WORKER_CRASHED' });
    const results = await drainAllPendingTriggers(drainDeps());

    expect(results).toContainEqual({ kind: 'enqueued', deploymentId: expect.any(String) });
    const followUps = (await deploymentsOf(hook.serviceId)).filter((row) => row.id !== activeId);
    expect(followUps).toHaveLength(1);
    expect(followUps[0]).toMatchObject({ status: 'QUEUED', commitSha: shaB });
    // A service whose deployment is still active is left for its own terminal event.
    expect(await deploymentsOf(busy.hook.serviceId)).toHaveLength(1);
    expect((await pendingOf(busy.hook.serviceId))?.deliveryId).not.toBeNull();
  });
});
