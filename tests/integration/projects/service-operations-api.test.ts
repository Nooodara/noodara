import { randomBytes, randomUUID } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import parseSetCookie from 'set-cookie-parser';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { revealSecret } from '@noodara/domain/security';
import { activityEvents } from '../../../apps/control-plane/src/db/schema/activity-events.js';
import { credentials } from '../../../apps/control-plane/src/db/schema/credentials.js';
import { deployments } from '../../../apps/control-plane/src/db/schema/deployments.js';
import { projects } from '../../../apps/control-plane/src/db/schema/projects.js';
import { servers } from '../../../apps/control-plane/src/db/schema/servers.js';
import { services } from '../../../apps/control-plane/src/db/schema/services.js';
import type {
  ServiceOperationEnqueueResult,
  ServiceOperationJobPayload,
  ServiceOperationQueue,
} from '../../../apps/control-plane/src/deploy/service-ops-job.js';
import type {
  ServiceCleanupResult,
  ServiceRemoteCleanupRequest,
} from '../../../apps/control-plane/src/deploy/service-ops.js';
import type { ServerEvent, ServerEventPublisher } from '../../../apps/control-plane/src/events/server-event-publisher.js';
import type { DeployQueue } from '../../../apps/control-plane/src/queue/deploy-queue.js';
import { issueToken } from '../../../apps/control-plane/src/services/setup-token-repository.js';
import { startPostgres, type PostgresFixture } from '../helpers/postgres.js';

// 12-14: service operations (stop / restart / remove / redeploy) and service + project delete with
// remote cleanup, against the real HTTP surface and a migrated Postgres. The operation queue, the
// deploy queue and the remote cleanup are fakes: no SSH, no Redis.

const ADMIN_EMAIL = 'admin@noodara.test';
const ADMIN_PASSWORD = 'correct horse battery staple';

type Json = Record<string, unknown>;

let postgres: PostgresFixture;
let app: FastifyInstance;
let cookie: string;
const published: ServerEvent[] = [];

const recorder: ServerEventPublisher = {
  publish(event) {
    published.push(event);
    return Promise.resolve();
  },
};

const enqueued: ServiceOperationJobPayload[] = [];
let nextEnqueue: ServiceOperationEnqueueResult | null = null;
const operationQueue: ServiceOperationQueue = {
  enqueue(payload) {
    enqueued.push(payload);
    const result = nextEnqueue ?? { ok: true as const, jobId: `service-op-${payload.serviceId}` };
    nextEnqueue = null;
    return Promise.resolve(result);
  },
  close: () => Promise.resolve(),
};

const cleanupCalls: ServiceRemoteCleanupRequest[] = [];
let cleanupResults: ServiceCleanupResult[] = [];
function remoteCleanup(request: ServiceRemoteCleanupRequest): Promise<ServiceCleanupResult> {
  cleanupCalls.push(request);
  return Promise.resolve(cleanupResults.shift() ?? { ok: true });
}

const deployQueue: DeployQueue = {
  enqueue: (payload) => Promise.resolve({ ok: true, jobId: payload.deploymentId }),
  removeJob: () => Promise.resolve(true),
  isJobPending: () => Promise.resolve(false),
  close: () => Promise.resolve(),
};

function setTestEnv(connectionString: string): void {
  process.env.NOODARA_MASTER_KEY = randomBytes(32).toString('base64');
  process.env.BETTER_AUTH_SECRET = `test-fixture-${randomUUID()}-${randomUUID()}`;
  process.env.DATABASE_URL = connectionString;
  process.env.REDIS_URL = 'redis://localhost:6379';
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

async function call(
  method: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE',
  url: string,
  payload?: unknown,
): Promise<{ statusCode: number; body: Json; raw: string }> {
  const response = await app.inject({
    method,
    url,
    headers: { cookie },
    ...(payload !== undefined ? { payload: payload as Json } : {}),
  });
  return { statusCode: response.statusCode, body: response.json() as Json, raw: response.body };
}

async function callRaw(method: 'POST' | 'DELETE', url: string, payload: string): Promise<{ statusCode: number; raw: string }> {
  const response = await app.inject({ method, url, headers: { cookie, 'content-type': 'application/json' }, payload });
  return { statusCode: response.statusCode, raw: response.body };
}

function short(): string {
  return randomUUID().replace(/-/g, '').slice(0, 10);
}

interface Fixture {
  readonly projectId: string;
  readonly projectName: string;
  readonly environmentId: string;
  readonly serverId: string;
  readonly serviceId: string;
  readonly serviceName: string;
  readonly url: string;
}

async function newFixture(): Promise<Fixture> {
  const projectName = `Ops ${short()}`;
  const project = await call('POST', '/api/projects', { name: projectName });
  expect(project.statusCode, project.raw).toBe(201);
  const projectId = String(project.body.id);
  const environment = await call('POST', `/api/projects/${projectId}/environments`, { name: 'production' });
  expect(environment.statusCode, environment.raw).toBe(201);
  const server = await call('POST', '/api/servers', {
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
  const serviceName = `api-${short()}`;
  const service = await call('POST', `/api/projects/${projectId}/services`, {
    environmentId: String(environment.body.id),
    serverId,
    name: serviceName,
    source: { kind: 'image', imageRef: 'nginx:1.27' },
    internalPort: 80,
  });
  expect(service.statusCode, service.raw).toBe(201);
  const serviceId = String(service.body.id);
  return {
    projectId,
    projectName,
    environmentId: String(environment.body.id),
    serverId,
    serviceId,
    serviceName,
    url: `/api/projects/${projectId}/services/${serviceId}`,
  };
}

async function addDeployment(
  serviceId: string,
  status: 'QUEUED' | 'BUILDING' | 'SUCCESS' | 'FAILED',
  claimed: boolean,
): Promise<string> {
  const [row] = await postgres.db
    .insert(deployments)
    .values({
      serviceId,
      status,
      source: { kind: 'image', imageRef: 'nginx:1.27' },
      ...(claimed ? { startedAt: new Date() } : {}),
    })
    .returning({ id: deployments.id });
  if (!row) throw new Error('deployment insert failed');
  return row.id;
}

async function activityFor(entityId: string, action: string) {
  return postgres.db
    .select()
    .from(activityEvents)
    .where(and(eq(activityEvents.entityId, entityId), eq(activityEvents.action, action)));
}

beforeAll(async () => {
  postgres = await startPostgres();
  setTestEnv(postgres.connectionString);
  const { buildApp } = await import('../../../apps/control-plane/src/app.js');
  app = buildApp({
    eventPublisher: recorder,
    serviceOperationQueue: operationQueue,
    serviceRemoteCleanup: remoteCleanup,
    deployQueue,
  });
  cookie = await signIn();
});

afterAll(async () => {
  await app.close();
  await postgres.stop();
});

beforeEach(() => {
  enqueued.length = 0;
  cleanupCalls.length = 0;
  cleanupResults = [];
  nextEnqueue = null;
  published.length = 0;
});

describe('POST .../services/:serviceId/{stop,restart,remove}', () => {
  it('queues the operation for a deployed service and answers 202 with the service', async () => {
    const fx = await newFixture();
    await addDeployment(fx.serviceId, 'SUCCESS', true);
    for (const operation of ['stop', 'restart', 'remove'] as const) {
      const response = await call('POST', `${fx.url}/${operation}`);
      expect(response.statusCode, response.raw).toBe(202);
      expect((response.body.service as Json).id).toBe(fx.serviceId);
    }
    expect(enqueued.map((payload) => payload.operation)).toEqual(['stop', 'restart', 'remove']);
    expect(enqueued[0]?.serviceId).toBe(fx.serviceId);
    expect(typeof enqueued[0]?.actorId).toBe('string');
  });

  it('accepts an empty JSON object body', async () => {
    const fx = await newFixture();
    await addDeployment(fx.serviceId, 'SUCCESS', true);
    const response = await call('POST', `${fx.url}/stop`, {});
    expect(response.statusCode, response.raw).toBe(202);
  });

  it('answers 409 SERVICE_NOT_DEPLOYED for a never-deployed service, without queueing', async () => {
    const fx = await newFixture();
    const response = await call('POST', `${fx.url}/stop`);
    expect(response.statusCode).toBe(409);
    expect(response.body.error).toBe('SERVICE_NOT_DEPLOYED');
    expect(enqueued).toHaveLength(0);
  });

  it('answers 409 DEPLOYMENT_IN_PROGRESS while a deployment is active', async () => {
    const fx = await newFixture();
    await addDeployment(fx.serviceId, 'SUCCESS', true);
    await addDeployment(fx.serviceId, 'BUILDING', true);
    const response = await call('POST', `${fx.url}/restart`);
    expect(response.statusCode).toBe(409);
    expect(response.body.error).toBe('DEPLOYMENT_IN_PROGRESS');
    expect(enqueued).toHaveLength(0);
  });

  it('answers 409 SERVICE_OPERATION_IN_PROGRESS when an operation is already pending', async () => {
    const fx = await newFixture();
    await addDeployment(fx.serviceId, 'SUCCESS', true);
    nextEnqueue = { ok: false, code: 'SERVICE_OPERATION_IN_PROGRESS', message: 'pending' };
    const response = await call('POST', `${fx.url}/stop`);
    expect(response.statusCode).toBe(409);
    expect(response.body.error).toBe('SERVICE_OPERATION_IN_PROGRESS');
  });

  it('answers 503 QUEUE_UNAVAILABLE when the queue cannot take the job', async () => {
    const fx = await newFixture();
    await addDeployment(fx.serviceId, 'SUCCESS', true);
    nextEnqueue = { ok: false, code: 'QUEUE_UNAVAILABLE', message: 'down' };
    const response = await call('POST', `${fx.url}/stop`);
    expect(response.statusCode).toBe(503);
    expect(response.body.error).toBe('QUEUE_UNAVAILABLE');
  });

  it('answers 422 SERVICE_OPERATION_INVALID for any body field, naming the field only', async () => {
    const fx = await newFixture();
    await addDeployment(fx.serviceId, 'SUCCESS', true);
    const response = await call('POST', `${fx.url}/stop`, { force: 'CANARY-VALUE' });
    expect(response.statusCode).toBe(422);
    expect(response.body.error).toBe('SERVICE_OPERATION_INVALID');
    expect(response.raw).not.toContain('CANARY-VALUE');
    expect(enqueued).toHaveLength(0);
  });

  it('answers 413 for an oversized body', async () => {
    const fx = await newFixture();
    const response = await callRaw('POST', `${fx.url}/stop`, JSON.stringify({ pad: 'x'.repeat(200_000) }));
    expect(response.statusCode).toBe(413);
  });

  it('answers 404 for an unknown service and for a service of another project', async () => {
    const fx = await newFixture();
    const other = await newFixture();
    await addDeployment(fx.serviceId, 'SUCCESS', true);
    expect((await call('POST', `/api/projects/${fx.projectId}/services/${randomUUID()}/stop`)).statusCode).toBe(404);
    expect((await call('POST', `/api/projects/${other.projectId}/services/${fx.serviceId}/stop`)).statusCode).toBe(404);
    expect(enqueued).toHaveLength(0);
  });
});

describe('POST .../services/:serviceId/redeploy', () => {
  it('queues a deployment of the service (201) and is scoped to the project', async () => {
    const fx = await newFixture();
    const other = await newFixture();
    expect((await call('POST', `/api/projects/${other.projectId}/services/${fx.serviceId}/redeploy`)).statusCode).toBe(404);
    const response = await call('POST', `${fx.url}/redeploy`);
    expect(response.statusCode, response.raw).toBe(201);
    expect(response.body.serviceId).toBe(fx.serviceId);
    expect(response.body.status).toBe('QUEUED');
  });
});

describe('service operation job helpers', () => {
  it('loads the target and records an operation as activity plus the status cache', async () => {
    const { loadServiceOperationTarget, recordServiceOperation } = await import(
      '../../../apps/control-plane/src/services/service-services.js'
    );
    const fx = await newFixture();
    expect(await loadServiceOperationTarget(postgres.db, randomUUID())).toBeNull();
    await addDeployment(fx.serviceId, 'SUCCESS', true);
    expect(await loadServiceOperationTarget(postgres.db, fx.serviceId)).toEqual({
      serverId: fx.serverId,
      activeDeployment: false,
    });

    const view = await recordServiceOperation(postgres.db, () => new Date(), {
      serviceId: fx.serviceId,
      serverId: fx.serverId,
      operation: 'stop',
      actor: { type: 'system' },
      result: {
        ok: true,
        operation: 'stop',
        previousState: 'running',
        container: { kind: 'stopped', exitCode: 0 },
        durationMs: 120,
      },
    });
    expect(view?.status).toBe('STOPPED');
    const [row] = await postgres.db.select({ status: services.status }).from(services).where(eq(services.id, fx.serviceId));
    expect(row?.status).toBe('STOPPED');
    const [stopped] = await activityFor(fx.serviceId, 'service.stopped');
    expect(stopped?.outcome).toBe('success');
    expect(stopped?.metadata).toEqual({ serverId: fx.serverId, durationMs: 120 });

    await recordServiceOperation(postgres.db, () => new Date(), {
      serviceId: fx.serviceId,
      serverId: fx.serverId,
      operation: 'restart',
      actor: { type: 'system' },
      result: { ok: false, code: 'SERVICE_OPERATION_TIMEOUT', message: 'timed out', durationMs: 60_000 },
    });
    const [restarted] = await activityFor(fx.serviceId, 'service.restarted');
    expect(restarted?.outcome).toBe('failure');
    expect(restarted?.errorCode).toBe('SERVICE_OPERATION_TIMEOUT');

    await recordServiceOperation(postgres.db, () => new Date(), {
      serviceId: fx.serviceId,
      serverId: fx.serverId,
      operation: 'remove',
      actor: { type: 'system' },
      result: {
        ok: true,
        operation: 'remove',
        previousState: 'exited',
        container: { kind: 'absent' },
        durationMs: 80,
      },
    });
    const [changed] = await activityFor(fx.serviceId, 'service.container_changed');
    expect(changed?.metadata).toEqual({ serverId: fx.serverId, previousStatus: 'STOPPED', observedState: 'absent' });

    await addDeployment(fx.serviceId, 'BUILDING', true);
    expect((await loadServiceOperationTarget(postgres.db, fx.serviceId))?.activeDeployment).toBe(true);
  });
});

describe('DELETE .../services/:serviceId', () => {
  it('rejects a mismatched confirmation name with 422 before any remote work', async () => {
    const fx = await newFixture();
    await addDeployment(fx.serviceId, 'SUCCESS', true);
    const response = await call('DELETE', fx.url, { confirmName: `${fx.serviceName}-nope` });
    expect(response.statusCode).toBe(422);
    expect(response.body.error).toBe('DELETE_CONFIRMATION_MISMATCH');
    expect(cleanupCalls).toHaveLength(0);
  });

  it('rejects a missing body with 422 SERVICE_OPERATION_INVALID', async () => {
    const fx = await newFixture();
    const response = await call('DELETE', fx.url);
    expect(response.statusCode).toBe(422);
    expect(response.body.error).toBe('SERVICE_OPERATION_INVALID');
  });

  it('deletes a never-deployed service without touching the server', async () => {
    const fx = await newFixture();
    const response = await call('DELETE', fx.url, { confirmName: fx.serviceName });
    expect(response.statusCode, response.raw).toBe(200);
    expect(response.body).toEqual({ ok: true, serviceId: fx.serviceId });
    expect(cleanupCalls).toHaveLength(0);
    expect(await postgres.db.select().from(services).where(eq(services.id, fx.serviceId))).toHaveLength(0);
    const [deleted] = await activityFor(fx.serviceId, 'service.deleted');
    expect(deleted?.outcome).toBe('success');
    expect(deleted?.metadata).toEqual({
      projectId: fx.projectId,
      environmentId: fx.environmentId,
      serverId: fx.serverId,
      name: fx.serviceName,
    });
    expect(published).toContainEqual({ type: 'service.deleted', id: fx.serviceId });
  });

  it('answers 409 DEPLOYMENT_IN_PROGRESS while a deployment is active', async () => {
    const fx = await newFixture();
    await addDeployment(fx.serviceId, 'QUEUED', false);
    const response = await call('DELETE', fx.url, { confirmName: fx.serviceName });
    expect(response.statusCode).toBe(409);
    expect(response.body.error).toBe('DEPLOYMENT_IN_PROGRESS');
    expect(await postgres.db.select().from(services).where(eq(services.id, fx.serviceId))).toHaveLength(1);
  });

  it('keeps the row when remote cleanup fails, then deletes it (and its credentials) on retry', async () => {
    const fx = await newFixture();
    const older = await addDeployment(fx.serviceId, 'FAILED', true);
    const newer = await addDeployment(fx.serviceId, 'SUCCESS', true);
    await addDeployment(fx.serviceId, 'FAILED', false);
    const [credential] = await postgres.db
      .insert(credentials)
      .values({ type: 'registry_password', encryptedValue: 'opaque-test-ciphertext', keyVersion: 1 })
      .returning({ id: credentials.id });
    if (!credential) throw new Error('credential insert failed');
    await postgres.db.update(services).set({ registryCredentialId: credential.id }).where(eq(services.id, fx.serviceId));

    cleanupResults = [{ ok: false, code: 'SERVER_UNREACHABLE', message: 'The server could not be reached over SSH.' }];
    const failed = await call('DELETE', fx.url, { confirmName: fx.serviceName });
    expect(failed.statusCode).toBe(502);
    expect(failed.body.error).toBe('SERVER_UNREACHABLE');
    expect(await postgres.db.select().from(services).where(eq(services.id, fx.serviceId))).toHaveLength(1);
    const [failure] = await activityFor(fx.serviceId, 'service.deleted');
    expect(failure?.outcome).toBe('failure');
    expect(failure?.errorCode).toBe('SERVER_UNREACHABLE');
    expect(cleanupCalls[0]).toEqual({ serverId: fx.serverId, serviceId: fx.serviceId, deploymentIds: [newer, older] });

    cleanupResults = [{ ok: false, code: 'SERVER_DOCKER_UNAVAILABLE', message: 'Docker is not available.' }];
    const dockerDown = await call('DELETE', fx.url, { confirmName: fx.serviceName });
    expect(dockerDown.statusCode).toBe(409);
    expect(dockerDown.body.error).toBe('SERVER_DOCKER_UNAVAILABLE');

    const deleted = await call('DELETE', fx.url, { confirmName: fx.serviceName });
    expect(deleted.statusCode, deleted.raw).toBe(200);
    expect(await postgres.db.select().from(services).where(eq(services.id, fx.serviceId))).toHaveLength(0);
    expect(await postgres.db.select().from(credentials).where(eq(credentials.id, credential.id))).toHaveLength(0);
  });
});

describe('DELETE /api/projects/:projectId with deployed services', () => {
  it('cleans each deployed service remotely before deleting the project', async () => {
    const fx = await newFixture();
    const deploymentId = await addDeployment(fx.serviceId, 'SUCCESS', true);
    await call('POST', `/api/projects/${fx.projectId}/archive`);

    cleanupResults = [{ ok: false, code: 'SERVICE_CLEANUP_FAILED', message: 'cleanup failed' }];
    const failed = await call('DELETE', `/api/projects/${fx.projectId}`, { confirmName: fx.projectName });
    expect(failed.statusCode).toBe(502);
    expect(failed.body.error).toBe('SERVICE_CLEANUP_FAILED');
    expect(await postgres.db.select().from(projects).where(eq(projects.id, fx.projectId))).toHaveLength(1);

    const deleted = await call('DELETE', `/api/projects/${fx.projectId}`, { confirmName: fx.projectName });
    expect(deleted.statusCode, deleted.raw).toBe(200);
    expect(cleanupCalls.at(-1)).toEqual({ serverId: fx.serverId, serviceId: fx.serviceId, deploymentIds: [deploymentId] });
    expect(await postgres.db.select().from(projects).where(eq(projects.id, fx.projectId))).toHaveLength(0);
    expect(published).toContainEqual({ type: 'service.deleted', id: fx.serviceId });
  });

  it('answers 409 DEPLOYMENT_IN_PROGRESS while a deployment is running', async () => {
    const fx = await newFixture();
    await addDeployment(fx.serviceId, 'BUILDING', true);
    await call('POST', `/api/projects/${fx.projectId}/archive`);
    const response = await call('DELETE', `/api/projects/${fx.projectId}`, { confirmName: fx.projectName });
    expect(response.statusCode).toBe(409);
    expect(response.body.error).toBe('DEPLOYMENT_IN_PROGRESS');
    expect(cleanupCalls).toHaveLength(0);
  });
});
