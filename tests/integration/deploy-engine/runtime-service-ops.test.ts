// 12-14b (A1-A4): service operations and deletion on the real sshd + dockerd fixture.
// Stop / restart / remove go through requestServiceOperation -> BullMQ -> startDeployWorker's
// service-operation handler (the src/worker.ts wiring); redeploy through triggerDeploy. Deletes go
// through deleteService / deleteProject with the SSH remote cleanup app.ts builds. Root-side truth
// comes from `stack.exec`. Cleanup is compared with `docker system df` Images / Containers / Local
// Volumes; BuildKit cache is excluded (2026-10-05 decision, ADR 0008).
// App modules are imported dynamically after a valid test env is written: several of them import
// env.ts, which fail-fasts at import time (INST-06).
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { and, eq, inArray } from 'drizzle-orm';
import { Redis } from 'ioredis';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createRedactor, secretValue } from '@noodara/domain/security';
import { createSsh2Adapter, formatFingerprint } from '@noodara/ssh';
import {
  activityEvents,
  credentials,
  deployments,
  environments,
  projects,
  servers,
  services,
} from '../../../apps/control-plane/src/db/schema/index.js';
import type { ServerEvent } from '../../../apps/control-plane/src/events/server-event-publisher.js';
import type { ServiceServices } from '../../../apps/control-plane/src/services/service-services.js';
import type { ProjectServices } from '../../../apps/control-plane/src/services/project-services.js';
import {
  DEPLOY_ENGINE_UBUNTU_VERSIONS,
  resolveBaseImages,
  startDeployEngineStack,
  type DeployEngineStack,
} from '../helpers/deploy-engine.js';
import { startPostgres, type PostgresFixture } from '../helpers/postgres.js';
import { startRedis, type RedisFixture } from '../helpers/redis.js';

type DeployRuntimeModule = typeof import('../../../apps/control-plane/src/deploy/deploy-runtime.js');
type DeployWorkerModule = typeof import('../../../apps/control-plane/src/deploy/deploy-worker.js');
type ServiceOpsModule = typeof import('../../../apps/control-plane/src/deploy/service-ops.js');
type ServiceOpsJobModule = typeof import('../../../apps/control-plane/src/deploy/service-ops-job.js');
type DeploymentServicesModule = typeof import('../../../apps/control-plane/src/services/deployment-services.js');
type ServiceServicesModule = typeof import('../../../apps/control-plane/src/services/service-services.js');
type ProjectServicesModule = typeof import('../../../apps/control-plane/src/services/project-services.js');
type DeployQueueModule = typeof import('../../../apps/control-plane/src/queue/deploy-queue.js');
type ServiceCredentialsModule = typeof import('../../../apps/control-plane/src/services/service-credentials.js');
type CredentialStoreModule = typeof import('../../../apps/control-plane/src/services/credential-store.js');
type HttpErrorsModule = typeof import('../../../apps/control-plane/src/routes/http-errors.js');

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES_DIR = path.resolve(HERE, '../../../fixtures');
const STACK_TIMEOUT_MS = 900_000;
const CASE_TIMEOUT_MS = 600_000;
const WAIT_MS = 300_000;
const POLL_MS = 500;
const WORKSPACE_ROOT = '/opt/noodara-deploy';
const PORTS = { ops: 13_220, project: 13_221 } as const;
const KEY_VERSION = 1;
const DEPLOY_MAX_MS = 300_000;
const TERMINAL = new Set(['SUCCESS', 'FAILED', 'CANCELLED']);
const RUNNING = new Set(['PREPARING', 'BUILDING', 'DEPLOYING']);
const ACTOR = { type: 'system' } as const;
const REPOS = { nodeApi: 'node-api', slow: 'slow-ops-build' } as const;
/** Long enough to act on the in-flight build, short enough to wait for its success. */
const SLOW_BUILD_SECONDS = 25;
/** Nothing listens here: connecting is refused at once. */
const UNREACHABLE = { host: '127.0.0.1', port: 1 } as const;

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function nodeBaseOf(baseImages: readonly string[]): string {
  const base = baseImages.find((ref) => ref.startsWith('node:'));
  if (base === undefined) throw new Error('harness preloaded no node base image');
  return base;
}

/** A build that stays in BUILDING for a while, then yields a runnable image. */
function writeSlowRepo(root: string, nodeBase: string): string {
  const dir = path.join(root, REPOS.slow);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    path.join(dir, 'Dockerfile'),
    [`FROM ${nodeBase}`, `RUN sleep ${SLOW_BUILD_SECONDS}`, 'CMD ["node","-e","setInterval(() => {}, 1000)"]', ''].join('\n'),
  );
  return dir;
}

interface LoggedLine {
  readonly level: string;
  readonly fields: Record<string, unknown>;
  readonly message: string;
}

describe.each(DEPLOY_ENGINE_UBUNTU_VERSIONS)(
  '12-14b / A1-A4: service operations and deletion on real infrastructure, Ubuntu %s',
  (ubuntu) => {
    let stack: DeployEngineStack | undefined;
    let postgres: PostgresFixture | undefined;
    let redis: RedisFixture | undefined;
    let queueConnection: Redis | undefined;
    let workerConnection: Redis | undefined;
    let worker: { close(): Promise<void> } | undefined;
    let queue: { close(): Promise<void> } | undefined;
    let operationQueue: { close(): Promise<void> } | undefined;
    let tempRoot: string | undefined;
    let triggerDeploy:
      | ((serviceId: string) => Promise<{ ok: true; id: string } | { ok: false; code: string }>)
      | undefined;
    let serviceCredentials: ServiceCredentialsModule | undefined;
    let credentialStore: CredentialStoreModule | undefined;
    let serviceApi: ServiceServices | undefined;
    let projectApi: ProjectServices | undefined;
    let httpErrors: HttpErrorsModule | undefined;

    const masterKey = randomBytes(32);
    const events: ServerEvent[] = [];
    const logged: LoggedLine[] = [];
    let serverId = '';
    let fingerprint = '';
    let baseline = '';

    const s = (): DeployEngineStack => {
      if (stack === undefined) throw new Error('stack not started');
      return stack;
    };
    const db = (): PostgresFixture['db'] => {
      if (postgres === undefined) throw new Error('postgres not started');
      return postgres.db;
    };
    const creds = (): ServiceCredentialsModule => {
      if (serviceCredentials === undefined) throw new Error('modules not loaded');
      return serviceCredentials;
    };
    const svcApi = (): ServiceServices => {
      if (serviceApi === undefined) throw new Error('modules not loaded');
      return serviceApi;
    };
    const projApi = (): ProjectServices => {
      if (projectApi === undefined) throw new Error('modules not loaded');
      return projectApi;
    };
    const statusOf = (code: string): number => {
      if (httpErrors === undefined) throw new Error('modules not loaded');
      return httpErrors.mapServiceCodeToStatus(code);
    };
    const root = (argv: readonly string[]) => s().exec(argv, { user: 'root' });
    const rootOut = async (argv: readonly string[]): Promise<string> => (await root(argv)).stdout.trim();
    const exists = async (argv: readonly string[]): Promise<boolean> => (await root(argv)).exitCode === 0;
    const imageExists = (ref: string) => exists(['docker', 'image', 'inspect', ref]);
    const networkExists = (name: string) => exists(['docker', 'network', 'inspect', name]);
    const containerExists = (name: string) => exists(['docker', 'container', 'inspect', name]);
    const pathGone = async (target: string): Promise<boolean> => !(await exists(['test', '-e', target]));
    const inspectContainer = async (name: string, template: string): Promise<string> =>
      rootOut(['docker', 'container', 'inspect', name, '--format', template]);
    const serviceImages = async (serviceId: string): Promise<string> =>
      rootOut(['docker', 'image', 'ls', '--filter', `reference=noodara/${serviceId}`, '--format', '{{.Repository}}:{{.Tag}}']);
    const dockerFootprint = async (): Promise<string> =>
      rootOut(['docker', 'system', 'df', '--format', '{{.Type}} {{.TotalCount}} {{.Active}} {{.Size}}']);
    const withoutBuildCache = (footprint: string): string =>
      footprint
        .split('\n')
        .filter((line) => !line.startsWith('Build Cache'))
        .join('\n');
    /** docker system df once BuildKit has released its refs (two equal reads in a row). */
    const settledFootprint = async (): Promise<string> => {
      let previous = await dockerFootprint();
      const deadline = Date.now() + 60_000;
      for (;;) {
        await delay(2_000);
        const current = await dockerFootprint();
        if (current === previous || Date.now() > deadline) return current;
        previous = current;
      }
    };
    const expectFootprintAtBaseline = async (): Promise<void> => {
      const after = await settledFootprint();
      expect(withoutBuildCache(after), `docker system df baseline:\n${baseline}`).toBe(withoutBuildCache(baseline));
    };

    const waitFor = async (what: string, check: () => Promise<boolean>, timeoutMs = WAIT_MS): Promise<void> => {
      const deadline = Date.now() + timeoutMs;
      for (;;) {
        if (await check()) return;
        if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
        await delay(POLL_MS);
      }
    };

    const insertRepositoryCredential = async (): Promise<string> => {
      const encoded = creds().encodeServiceCredential(
        {
          kind: 'deploy_key',
          privateKey: secretValue(s().deployKey.privateKey, 'ssh_private_key'),
          publicKey: s().deployKey.publicKey,
        },
        { key: masterKey, version: KEY_VERSION },
      );
      return db().transaction((tx) => creds().insertServiceCredential(tx, encoded, new Date()));
    };

    const insertServer = async (name: string, host: string, port: number): Promise<string> => {
      if (credentialStore === undefined) throw new Error('modules not loaded');
      const encoded = credentialStore.encodeCredential(
        { kind: 'private_key', privateKey: s().ssh.privateKey },
        { key: masterKey, version: KEY_VERSION },
        createRedactor(),
      );
      if (!encoded.ok) throw new Error(`server credential rejected: ${encoded.code}`);
      const [credentialRow] = await db()
        .insert(credentials)
        .values({ type: encoded.type, encryptedValue: encoded.encryptedValue, keyVersion: encoded.keyVersion })
        .returning({ id: credentials.id });
      if (!credentialRow) throw new Error('credential insert returned no row');
      const [serverRow] = await db()
        .insert(servers)
        .values({
          name,
          host,
          sshPort: port,
          sshUser: s().ssh.user,
          credentialId: credentialRow.id,
          status: 'CONNECTED',
          hostFingerprint: fingerprint,
          dockerInstalled: true,
        })
        .returning({ id: servers.id });
      if (!serverRow) throw new Error('server insert returned no row');
      return serverRow.id;
    };

    const insertProject = async (name: string): Promise<{ projectId: string; environmentId: string }> => {
      const now = new Date();
      const [projectRow] = await db()
        .insert(projects)
        .values({ name, slug: `ops-${randomUUID().slice(0, 8)}`, createdAt: now, updatedAt: now })
        .returning({ id: projects.id });
      if (!projectRow) throw new Error('project insert returned no row');
      const [environmentRow] = await db()
        .insert(environments)
        .values({ projectId: projectRow.id, name: 'production', createdAt: now, updatedAt: now })
        .returning({ id: environments.id });
      if (!environmentRow) throw new Error('environment insert returned no row');
      return { projectId: projectRow.id, environmentId: environmentRow.id };
    };

    const archive = async (projectId: string): Promise<void> => {
      await db().update(projects).set({ archivedAt: new Date() }).where(eq(projects.id, projectId));
    };

    const insertGitService = async (input: {
      readonly projectId: string;
      readonly environmentId: string;
      readonly repo: string;
      readonly publishedPort: number | null;
      readonly serverId?: string;
    }): Promise<{ id: string; name: string; credentialId: string }> => {
      const name = `svc-${randomUUID().slice(0, 8)}`;
      const credentialId = await insertRepositoryCredential();
      const [row] = await db()
        .insert(services)
        .values({
          projectId: input.projectId,
          environmentId: input.environmentId,
          serverId: input.serverId ?? serverId,
          name,
          sourceType: 'git',
          repositoryUrl: s().gitRepoUrl(input.repo),
          branch: 'main',
          buildContext: '.',
          dockerfilePath: 'Dockerfile',
          internalPort: 3000,
          publishedPort: input.publishedPort,
          repositoryCredentialId: credentialId,
        })
        .returning({ id: services.id });
      if (!row) throw new Error('service insert returned no row');
      return { id: row.id, name, credentialId };
    };

    const deploymentRow = async (deploymentId: string) => {
      const [row] = await db().select().from(deployments).where(eq(deployments.id, deploymentId));
      if (!row) throw new Error(`deployment ${deploymentId} missing`);
      return row;
    };

    const startDeploy = async (serviceId: string): Promise<string> => {
      if (triggerDeploy === undefined) throw new Error('runtime not started');
      const result = await triggerDeploy(serviceId);
      if (!result.ok) throw new Error(`triggerDeploy failed: ${result.code}`);
      return result.id;
    };
    const waitTerminal = async (deploymentId: string) => {
      const deadline = Date.now() + WAIT_MS;
      for (;;) {
        const row = await deploymentRow(deploymentId);
        if (TERMINAL.has(row.status)) return row;
        if (Date.now() > deadline) throw new Error(`deployment ${deploymentId} stuck in ${row.status}`);
        await delay(POLL_MS);
      }
    };
    const deploy = async (serviceId: string) => waitTerminal(await startDeploy(serviceId));

    const activityFor = async (entityId: string, action: string) =>
      db()
        .select()
        .from(activityEvents)
        .where(and(eq(activityEvents.entityId, entityId), eq(activityEvents.action, action)));
    const waitActivity = async (entityId: string, action: string) => {
      await waitFor(`${action} activity for ${entityId}`, async () => (await activityFor(entityId, action)).length > 0);
      const rows = await activityFor(entityId, action);
      expect(rows).toHaveLength(1);
      const [row] = rows;
      if (!row) throw new Error('activity row missing');
      return row;
    };

    const serviceUpdates = (serviceId: string): string[] =>
      events.flatMap((event) =>
        event.type === 'service.updated' && event.service.id === serviceId ? [event.service.status] : [],
      );
    const deletedEvents = (serviceId: string): number =>
      events.filter((event) => event.type === 'service.deleted' && event.id === serviceId).length;
    const serviceRowStatus = async (serviceId: string): Promise<string> => {
      const [row] = await db().select({ status: services.status }).from(services).where(eq(services.id, serviceId));
      if (!row) throw new Error('service missing');
      return row.status;
    };

    /** Runs one queued operation and returns its activity row and the service.updated it published. */
    const operate = async (
      projectId: string,
      serviceId: string,
      operation: 'stop' | 'restart' | 'remove',
      action: string,
    ) => {
      const updatesBefore = serviceUpdates(serviceId).length;
      const requested = await svcApi().requestServiceOperation({ actor: ACTOR, projectId, serviceId, operation });
      expect(requested.ok, JSON.stringify(requested)).toBe(true);
      const activity = await waitActivity(serviceId, action);
      await waitFor(`service.updated after ${operation}`, () =>
        Promise.resolve(serviceUpdates(serviceId).length > updatesBefore),
      );
      return { activity, published: serviceUpdates(serviceId).at(-1) };
    };

    /** A2/A3: the per-service and per-deployment remote resources are all gone. */
    const expectRemoteGone = async (serviceId: string, deploymentIds: readonly string[]): Promise<void> => {
      expect(await containerExists(`noodara-${serviceId}`)).toBe(false);
      expect(await networkExists(`noodara-net-${serviceId}`)).toBe(false);
      expect(await serviceImages(serviceId)).toBe('');
      for (const deploymentId of deploymentIds) {
        expect(await pathGone(`${WORKSPACE_ROOT}/${deploymentId}`)).toBe(true);
      }
    };

    const rowsLeft = async (input: {
      readonly serviceIds: readonly string[];
      readonly credentialIds: readonly string[];
    }): Promise<{ services: number; deployments: number; credentials: number }> => ({
      services: (await db().select({ id: services.id }).from(services).where(inArray(services.id, [...input.serviceIds])))
        .length,
      deployments: (
        await db()
          .select({ id: deployments.id })
          .from(deployments)
          .where(inArray(deployments.serviceId, [...input.serviceIds]))
      ).length,
      credentials: (
        await db()
          .select({ id: credentials.id })
          .from(credentials)
          .where(inArray(credentials.id, [...input.credentialIds]))
      ).length,
    });

    beforeAll(async () => {
      const [stackStarted, pgStarted, redisStarted] = await Promise.all([
        (async () => {
          const base = nodeBaseOf(resolveBaseImages());
          tempRoot = mkdtempSync(path.join(tmpdir(), 'noodara-runtime-service-ops-'));
          return startDeployEngineStack({
            ubuntu,
            seedRepositories: [
              { name: REPOS.nodeApi, sourceDir: path.join(FIXTURES_DIR, 'node-api') },
              { name: REPOS.slow, sourceDir: writeSlowRepo(tempRoot, base) },
            ],
          });
        })(),
        startPostgres(),
        startRedis(),
      ]);
      stack = stackStarted;
      postgres = pgStarted;
      redis = redisStarted;

      process.env.NOODARA_MASTER_KEY = masterKey.toString('base64');
      process.env.BETTER_AUTH_SECRET = `runtime-service-ops-${randomUUID()}-${randomUUID()}`;
      process.env.DATABASE_URL = postgres.connectionString;
      process.env.REDIS_URL = redis.connectionUrl;
      process.env.NOODARA_PUBLIC_URL = 'http://localhost:3000';

      const runtime: DeployRuntimeModule = await import('../../../apps/control-plane/src/deploy/deploy-runtime.js');
      const workerModule: DeployWorkerModule = await import('../../../apps/control-plane/src/deploy/deploy-worker.js');
      const serviceOps: ServiceOpsModule = await import('../../../apps/control-plane/src/deploy/service-ops.js');
      const serviceOpsJob: ServiceOpsJobModule = await import('../../../apps/control-plane/src/deploy/service-ops-job.js');
      const deploymentServices: DeploymentServicesModule = await import(
        '../../../apps/control-plane/src/services/deployment-services.js'
      );
      const serviceServices: ServiceServicesModule = await import(
        '../../../apps/control-plane/src/services/service-services.js'
      );
      const projectServices: ProjectServicesModule = await import(
        '../../../apps/control-plane/src/services/project-services.js'
      );
      const queueModule: DeployQueueModule = await import('../../../apps/control-plane/src/queue/deploy-queue.js');
      credentialStore = await import('../../../apps/control-plane/src/services/credential-store.js');
      serviceCredentials = await import('../../../apps/control-plane/src/services/service-credentials.js');
      httpErrors = await import('../../../apps/control-plane/src/routes/http-errors.js');

      // Server row: CONNECTED, Docker present, fingerprint pinned from a first trusted connect.
      const probe = await createSsh2Adapter().connect({
        target: { host: stack.ssh.host, port: stack.ssh.port, user: stack.ssh.user },
        credential: { kind: 'private_key', privateKey: secretValue(stack.ssh.privateKey, 'ssh_private_key') },
        timeouts: { connectMs: 20_000, commandMs: 60_000, discoveryMs: 120_000 },
        trustedFingerprint: null,
        redactor: createRedactor(),
      });
      if (!probe.ok) throw new Error(`fingerprint probe failed: ${probe.errorCode}`);
      fingerprint = formatFingerprint(probe.fingerprint);
      await probe.session.close();
      serverId = await insertServer(`deploy-host-${ubuntu}`, stack.ssh.host, stack.ssh.port);

      // Runtime: the same wiring src/worker.ts and src/app.ts use, with a recording publisher and logger.
      const recordingEvents = {
        publish(event: ServerEvent): Promise<void> {
          events.push(event);
          return Promise.resolve();
        },
      };
      const logger = {
        info: (fields: Record<string, unknown>, message: string) => logged.push({ level: 'info', fields, message }),
        warn: (fields: Record<string, unknown>, message: string) => logged.push({ level: 'warn', fields, message }),
        error: (fields: Record<string, unknown>, message: string) => logged.push({ level: 'error', fields, message }),
      };
      const baseDeps = runtime.createDeployJobDeps({
        db: db(),
        events: recordingEvents,
        ssh: createSsh2Adapter(),
        timeouts: { connectMs: 20_000, commandMs: 60_000, discoveryMs: 120_000 },
        masterKeys: () => Promise.resolve({ current: masterKey }),
        panelPorts: [],
        config: { deployMaxMs: DEPLOY_MAX_MS, idleMs: 120_000, logMaxBytes: 1_048_576, logLineMaxBytes: 16_384 },
        logger,
      });
      const serviceOperationHandler = serviceOpsJob.createServiceOperationJobHandler(
        runtime.createServiceOperationJobDeps(baseDeps, {
          loadTarget: (serviceId) => serviceServices.loadServiceOperationTarget(db(), serviceId),
          record: (input) => serviceServices.recordServiceOperation(db(), () => new Date(), input),
          events: recordingEvents,
          logger,
        }),
      );

      workerConnection = new Redis(redis.connectionUrl, { maxRetriesPerRequest: null });
      queueConnection = new Redis(redis.connectionUrl, { maxRetriesPerRequest: null });
      worker = runtime.startDeployWorker({
        handler: workerModule.createDeployJobHandler(baseDeps),
        serviceOperationHandler,
        connection: workerConnection,
        concurrency: 2,
        deployMaxMs: DEPLOY_MAX_MS,
        logger,
      });
      const deployQueue = queueModule.createDeployQueue({ connection: queueConnection, enqueueTimeoutMs: 10_000 });
      queue = deployQueue;
      const opsQueue = serviceOpsJob.createServiceOperationQueue({ connection: queueConnection });
      operationQueue = opsQueue;
      const remoteCleanup = serviceOps.createServiceRemoteCleanup({
        connect: baseDeps.connect,
        createRedactor: baseDeps.createRedactor,
        limits: serviceOps.DEFAULT_SERVICE_OPS_LIMITS,
      });
      serviceApi = serviceServices.createServiceServices({
        db: db(),
        now: () => new Date(),
        events: recordingEvents,
        panelPorts: [],
        masterKeys: () => Promise.resolve({ current: masterKey }),
        operationQueue: opsQueue,
        remoteCleanup,
      });
      projectApi = projectServices.createProjectServices({
        db: db(),
        now: () => new Date(),
        events: recordingEvents,
        remoteCleanup,
      });
      const deploymentApi = deploymentServices.createDeploymentServices({
        db: db(),
        now: () => new Date(),
        events: recordingEvents,
        queue: deployQueue,
        logger,
      });
      triggerDeploy = async (serviceId) => {
        const result = await deploymentApi.triggerDeploy({ actor: ACTOR, serviceId });
        return result.ok ? { ok: true, id: result.deployment.id } : { ok: false, code: result.code };
      };

      baseline = await settledFootprint();
    }, STACK_TIMEOUT_MS);

    afterAll(async () => {
      await worker?.close();
      await operationQueue?.close();
      await queue?.close();
      workerConnection?.disconnect();
      queueConnection?.disconnect();
      await redis?.stop();
      await postgres?.stop();
      await stack?.stop();
      if (tempRoot !== undefined) rmSync(tempRoot, { recursive: true, force: true });
    }, STACK_TIMEOUT_MS);

    let opsProjectId = '';
    let opsService = { id: '', name: '', credentialId: '' };
    const opsDeploymentIds: string[] = [];

    it('A1: stop, restart, remove and redeploy run as timed jobs with activity events and service.updated', async () => {
      ({ projectId: opsProjectId } = await insertProject('Service ops'));
      const [environment] = await db()
        .select({ id: environments.id })
        .from(environments)
        .where(eq(environments.projectId, opsProjectId));
      if (!environment) throw new Error('environment missing');
      opsService = await insertGitService({
        projectId: opsProjectId,
        environmentId: environment.id,
        repo: REPOS.nodeApi,
        publishedPort: PORTS.ops,
      });
      const container = `noodara-${opsService.id}`;

      const first = await deploy(opsService.id);
      expect({ status: first.status, errorCode: first.errorCode }).toEqual({ status: 'SUCCESS', errorCode: null });
      opsDeploymentIds.push(first.id);
      expect(await inspectContainer(container, '{{.State.Running}}')).toBe('true');
      const startedAt = await inspectContainer(container, '{{.State.StartedAt}}');

      const stopped = await operate(opsProjectId, opsService.id, 'stop', 'service.stopped');
      expect({ outcome: stopped.activity.outcome, errorCode: stopped.activity.errorCode }).toEqual({
        outcome: 'success',
        errorCode: null,
      });
      expect(stopped.activity.metadata).toMatchObject({ serverId, durationMs: expect.any(Number) });
      expect(await inspectContainer(container, '{{.State.Running}}')).toBe('false');
      expect(stopped.published).toBe('STOPPED');
      expect(await serviceRowStatus(opsService.id)).toBe('STOPPED');

      const restarted = await operate(opsProjectId, opsService.id, 'restart', 'service.restarted');
      expect(restarted.activity.outcome).toBe('success');
      expect(restarted.activity.metadata).toMatchObject({ serverId, durationMs: expect.any(Number) });
      expect(await inspectContainer(container, '{{.State.Running}}')).toBe('true');
      expect(await inspectContainer(container, '{{.State.StartedAt}}')).not.toBe(startedAt);
      expect(restarted.published).toBe('RUNNING');

      const removed = await operate(opsProjectId, opsService.id, 'remove', 'service.container_changed');
      expect(removed.activity.outcome).toBe('success');
      expect(removed.activity.metadata).toMatchObject({ serverId, previousStatus: 'RUNNING', observedState: 'absent' });
      expect(await containerExists(container)).toBe(false);
      expect(removed.published).toBe('STOPPED');

      // Redeploy is the deployment job: claimed, timed and finished like any deploy.
      const redeployed = await deploy(opsService.id);
      expect({ status: redeployed.status, errorCode: redeployed.errorCode }).toEqual({ status: 'SUCCESS', errorCode: null });
      opsDeploymentIds.push(redeployed.id);
      expect(redeployed.startedAt).not.toBeNull();
      expect(redeployed.completedAt).not.toBeNull();
      expect(redeployed.durationMs).toEqual(expect.any(Number));
      expect(await inspectContainer(container, '{{.State.Running}}')).toBe('true');
      expect(await inspectContainer(container, '{{.Config.Image}}')).toBe(`noodara/${opsService.id}:${redeployed.id}`);
      expect(serviceUpdates(opsService.id).at(-1)).toBe('RUNNING');
    }, CASE_TIMEOUT_MS);

    it('A2: deleting a service (exact name) removes its container, network, images, workspaces, credentials and rows', async () => {
      expect(opsService.id).not.toBe('');
      const container = `noodara-${opsService.id}`;

      for (const confirmName of [`${opsService.name} `, opsService.name.toUpperCase(), '']) {
        const refused = await svcApi().deleteService({
          actor: ACTOR,
          projectId: opsProjectId,
          serviceId: opsService.id,
          confirmName,
        });
        expect(refused).toMatchObject({ ok: false, code: 'DELETE_CONFIRMATION_MISMATCH' });
      }
      expect(await containerExists(container)).toBe(true);

      const deleted = await svcApi().deleteService({
        actor: ACTOR,
        projectId: opsProjectId,
        serviceId: opsService.id,
        confirmName: opsService.name,
      });
      expect(deleted).toEqual({ ok: true, serviceId: opsService.id });

      await expectRemoteGone(opsService.id, opsDeploymentIds);
      expect(await rowsLeft({ serviceIds: [opsService.id], credentialIds: [opsService.credentialId] })).toEqual({
        services: 0,
        deployments: 0,
        credentials: 0,
      });
      const activity = await activityFor(opsService.id, 'service.deleted');
      expect(activity.map((row) => row.outcome)).toEqual(['success']);
      expect(deletedEvents(opsService.id)).toBe(1);
      await expectFootprintAtBaseline();
    }, CASE_TIMEOUT_MS);

    it('A3: deleting an archived project cleans every service first; an unreachable server keeps every row', async () => {
      const { projectId, environmentId } = await insertProject('Project cleanup');
      const live = await insertGitService({ projectId, environmentId, repo: REPOS.nodeApi, publishedPort: PORTS.project });
      const liveDeploy = await deploy(live.id);
      expect(liveDeploy.status).toBe('SUCCESS');

      // A second service whose server is gone: a claimed deployment means it owns remote resources.
      const lostServerId = await insertServer(`lost-host-${ubuntu}`, UNREACHABLE.host, UNREACHABLE.port);
      const lost = await insertGitService({
        projectId,
        environmentId,
        repo: REPOS.nodeApi,
        publishedPort: null,
        serverId: lostServerId,
      });
      const now = new Date();
      const [lostDeploy] = await db()
        .insert(deployments)
        .values({
          serviceId: lost.id,
          status: 'FAILED',
          source: liveDeploy.source,
          startedAt: now,
          completedAt: now,
          durationMs: 0,
        })
        .returning({ id: deployments.id });
      if (!lostDeploy) throw new Error('deployment insert returned no row');

      const serviceIds = [live.id, lost.id];
      const credentialIds = [live.credentialId, lost.credentialId];
      const [project] = await db().select({ name: projects.name }).from(projects).where(eq(projects.id, projectId));
      if (!project) throw new Error('project missing');

      const active = await projApi().deleteProject({ actor: ACTOR, projectId, confirmName: project.name });
      expect(active).toMatchObject({ ok: false, code: 'PROJECT_NOT_ARCHIVED' });
      await archive(projectId);

      const unreachable = await projApi().deleteProject({ actor: ACTOR, projectId, confirmName: project.name });
      expect(unreachable).toMatchObject({ ok: false, code: 'SERVER_UNREACHABLE' });
      if (unreachable.ok) throw new Error('unreachable delete succeeded');
      expect(unreachable.message).not.toBe('');
      expect(statusOf(unreachable.code)).toBe(502);
      // Nothing was deleted: the project, both services, their deployments and credentials remain.
      expect(await db().select({ id: projects.id }).from(projects).where(eq(projects.id, projectId))).toHaveLength(1);
      expect(await rowsLeft({ serviceIds, credentialIds })).toEqual({ services: 2, deployments: 2, credentials: 2 });
      expect(await activityFor(projectId, 'project.deleted')).toHaveLength(0);
      expect(deletedEvents(live.id) + deletedEvents(lost.id)).toBe(0);

      // The service is moved to a reachable server ((host, port) is unique, so the lost row cannot
      // take the live address): the retry cleans both services, idempotently.
      await db().update(services).set({ serverId }).where(eq(services.id, lost.id));
      const deleted = await projApi().deleteProject({ actor: ACTOR, projectId, confirmName: project.name });
      expect(deleted).toEqual({ ok: true, projectId });

      await expectRemoteGone(live.id, [liveDeploy.id]);
      await expectRemoteGone(lost.id, [lostDeploy.id]);
      expect(await db().select({ id: projects.id }).from(projects).where(eq(projects.id, projectId))).toHaveLength(0);
      expect(
        await db().select({ id: environments.id }).from(environments).where(eq(environments.id, environmentId)),
      ).toHaveLength(0);
      expect(await rowsLeft({ serviceIds, credentialIds })).toEqual({ services: 0, deployments: 0, credentials: 0 });
      expect((await activityFor(projectId, 'project.deleted')).map((row) => row.outcome)).toEqual(['success']);
      expect(deletedEvents(live.id)).toBe(1);
      expect(deletedEvents(lost.id)).toBe(1);
      await expectFootprintAtBaseline();
    }, CASE_TIMEOUT_MS);

    it('A4: every operation on a service with an active deployment returns 409 DEPLOYMENT_IN_PROGRESS', async () => {
      const { projectId, environmentId } = await insertProject('In-flight deploy');
      const slow = await insertGitService({ projectId, environmentId, repo: REPOS.slow, publishedPort: null });
      const deploymentId = await startDeploy(slow.id);
      await waitFor('the slow deployment to be claimed', async () => RUNNING.has((await deploymentRow(deploymentId)).status));

      const refusals: { readonly what: string; readonly code: string | null }[] = [];
      for (const operation of ['stop', 'restart', 'remove'] as const) {
        const result = await svcApi().requestServiceOperation({ actor: ACTOR, projectId, serviceId: slow.id, operation });
        refusals.push({ what: operation, code: result.ok ? null : result.code });
      }
      const redeploy = await startDeploy(slow.id).then(
        () => null,
        (error: unknown) => (error instanceof Error ? error.message : String(error)),
      );
      refusals.push({ what: 'redeploy', code: redeploy?.replace('triggerDeploy failed: ', '') ?? null });
      const deletion = await svcApi().deleteService({ actor: ACTOR, projectId, serviceId: slow.id, confirmName: slow.name });
      refusals.push({ what: 'delete', code: deletion.ok ? null : deletion.code });
      await archive(projectId);
      const [project] = await db().select({ name: projects.name }).from(projects).where(eq(projects.id, projectId));
      if (!project) throw new Error('project missing');
      const projectDeletion = await projApi().deleteProject({ actor: ACTOR, projectId, confirmName: project.name });
      refusals.push({ what: 'project delete', code: projectDeletion.ok ? null : projectDeletion.code });

      // Still in flight: every refusal above raced nothing.
      expect(RUNNING.has((await deploymentRow(deploymentId)).status)).toBe(true);
      expect(refusals).toEqual(
        ['stop', 'restart', 'remove', 'redeploy', 'delete', 'project delete'].map((what) => ({
          what,
          code: 'DEPLOYMENT_IN_PROGRESS',
        })),
      );
      expect(statusOf('DEPLOYMENT_IN_PROGRESS')).toBe(409);
      for (const action of ['service.stopped', 'service.restarted', 'service.container_changed', 'service.deleted']) {
        expect(await activityFor(slow.id, action)).toHaveLength(0);
      }
      expect(await rowsLeft({ serviceIds: [slow.id], credentialIds: [slow.credentialId] })).toEqual({
        services: 1,
        deployments: 1,
        credentials: 1,
      });

      // Once the deploy finishes, the same project delete goes through and leaves nothing behind.
      const finished = await waitTerminal(deploymentId);
      expect(finished.status).toBe('SUCCESS');
      const deleted = await projApi().deleteProject({ actor: ACTOR, projectId, confirmName: project.name });
      expect(deleted).toEqual({ ok: true, projectId });
      await expectRemoteGone(slow.id, [deploymentId]);
      await expectFootprintAtBaseline();
    }, CASE_TIMEOUT_MS);

    it('noodara-security: no credential reaches events, logs or activity metadata', async () => {
      const activity = await db().select({ metadata: activityEvents.metadata, errorCode: activityEvents.errorCode }).from(activityEvents);
      const surface = JSON.stringify({ events, logged, activity });
      expect(surface).not.toContain(s().deployKey.privateKey.split('\n')[1] ?? s().deployKey.privateKey);
      expect(surface).not.toContain(s().ssh.privateKey.split('\n')[1] ?? s().ssh.privateKey);
      expect(surface).not.toContain(masterKey.toString('base64'));
    });
  },
);
