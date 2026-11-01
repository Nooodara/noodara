// 12-13 / A1-A4: cancellation and the worker-crash sweep on real infrastructure (sshd + dockerd).
// - A1: a QUEUED deployment is cancelled before any worker sees it; no remote command ever runs.
// - A2/A3: a running build is cancelled through the Redis flag; the worker kills the supervised
//   process group, cleans up and ends CANCELLED, leaving no image, network, container or workspace.
// - A4: a worker that dies mid-build (emulated in-process: its SSH connection drops and it never
//   runs another step) leaves a BUILDING row; the startup sweep ends it FAILED/WORKER_CRASHED and
//   cleans the per-deployment resources, never the per-service container.
// - 17-06 A1: a cancel during HEALTHCHECK removes the new container and puts `-prev` back under the
//   service name (CANCELLED); a cancel during ROLLING_BACK is the named 409 ROLLBACK_IN_PROGRESS and
//   the rollback runs to ROLLED_BACK.
// - 22-08 A7: a cancel raised while a routed service's deployment is DEPLOYING ends CANCELLED and
//   the route (real Traefik, installed against Pebble) keeps answering the previous deployment.
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { eq } from 'drizzle-orm';
import { Redis } from 'ioredis';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { HealthcheckConfig } from '@noodara/domain/deployment';
import { createRedactor, secretValue } from '@noodara/domain/security';
import { createSsh2Adapter, formatFingerprint } from '@noodara/ssh';
import {
  credentials,
  deployments,
  domains,
  environments,
  projects,
  servers,
  services,
} from '../../../apps/control-plane/src/db/schema/index.js';
import type { ServerEvent } from '../../../apps/control-plane/src/events/server-event-publisher.js';
import type { CancelDeployment, CancelDeploymentResult } from '../../../apps/control-plane/src/deploy/cancel-deployment.js';
import { mapServiceCodeToStatus } from '../../../apps/control-plane/src/routes/http-errors.js';
import type { DeployJobDeps } from '../../../apps/control-plane/src/deploy/deploy-worker.js';
import {
  DEPLOY_ENGINE_UBUNTU_VERSIONS,
  resolveBaseImages,
  startDeployEngineStack,
  type DeployEngineStack,
} from '../helpers/deploy-engine.js';
import { PEBBLE_ACME_DIRECTORY_URL, PEBBLE_HOSTNAME, TRAEFIK_IMAGE, startPebble, type StartedPebble } from '../helpers/pebble.js';
import { startPostgres, type PostgresFixture } from '../helpers/postgres.js';
import { startRedis, type RedisFixture } from '../helpers/redis.js';
import { runTeardown, settleWithin } from '../helpers/teardown.js';

type DeployRuntimeModule = typeof import('../../../apps/control-plane/src/deploy/deploy-runtime.js');
type DeployWorkerModule = typeof import('../../../apps/control-plane/src/deploy/deploy-worker.js');
type DeploymentServicesModule = typeof import('../../../apps/control-plane/src/services/deployment-services.js');
type DeployQueueModule = typeof import('../../../apps/control-plane/src/queue/deploy-queue.js');
type CredentialStoreModule = typeof import('../../../apps/control-plane/src/services/credential-store.js');
type DeployQueue = import('../../../apps/control-plane/src/queue/deploy-queue.js').DeployQueue;

const STACK_TIMEOUT_MS = 900_000;
// Teardown budget (14-27), inside STACK_TIMEOUT_MS: pending start 180 s + steps x 30 s + db/redis 2 x 60 s + stack stop 300 s.
const PENDING_START_WAIT_MS = 180_000;
const TEARDOWN_STEP_TIMEOUT_MS = 30_000;
const FIXTURE_STOP_TIMEOUT_MS = 60_000;
const STACK_STOP_TIMEOUT_MS = 300_000;
const CASE_TIMEOUT_MS = 600_000;
const WAIT_MS = 300_000;
const POLL_MS = 500;
const WORKSPACE_ROOT = '/home/deployer/.noodara/deploy';
const KEY_VERSION = 1;
const DEPLOY_MAX_MS = 300_000;
const TERMINAL = new Set(['SUCCESS', 'FAILED', 'CANCELLED', 'ROLLED_BACK']);
const SLOW_REPO = 'slow-build';
const FIXTURES_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../fixtures');
const REPOS = { healthy: 'node-api', unhealthy: 'unhealthy-api' } as const;
/** 17-06: HTTP healthcheck; `startPeriodS` stretches a failing check so a cancel lands inside it. */
const httpCheck = (checkPath: string, startPeriodS = 10): HealthcheckConfig => ({
  type: 'http',
  path: checkPath,
  port: 3000,
  expectedStatuses: [200],
  probeTimeoutS: 2,
  intervalS: 1,
  retries: 3,
  startPeriodS,
});
/** Bound on BuildKit cache growth per cancelled build (the measured orphan record is ~8 kB, ADR 0008). */
const MAX_CACHE_GROWTH_PER_CANCEL = 64_000;
/** The ps marker of the slow build's RUN step: unique to this file. */
const SLOW_MARKER = 'sleep 307';
const ACTOR = { type: 'system' } as const;
const TIMEOUTS = { connectMs: 20_000, commandMs: 60_000, discoveryMs: 120_000 } as const;
const ROUTED_CASE_TIMEOUT_MS = 900_000;
const ROUTE_WAIT_MS = 20_000;
const CERT_VALIDITY_SECONDS = 3600;

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function nodeBaseOf(baseImages: readonly string[]): string {
  const base = baseImages.find((ref) => ref.startsWith('node:'));
  if (base === undefined) throw new Error('harness preloaded no node base image');
  return base;
}

function writeSlowRepo(root: string, nodeBase: string): string {
  const dir = path.join(root, SLOW_REPO);
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, 'Dockerfile'), [`FROM ${nodeBase}`, `RUN echo noodara-cancel-build && ${SLOW_MARKER}`, ''].join('\n'));
  return dir;
}

/** A promise that settles only while `isCrashed()` is false; after the crash it never settles. */
function gate<T>(work: Promise<T>, isCrashed: () => boolean): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    work.then(
      (value) => {
        if (!isCrashed()) resolve(value);
      },
      (error: unknown) => {
        if (!isCrashed()) reject(error instanceof Error ? error : new Error(String(error)));
      },
    );
  });
}

/** Every async method of `target` freezes once `isCrashed()` turns true: a dead process takes no further step. */
function freezeOnCrash<T extends object>(target: T, isCrashed: () => boolean): T {
  return new Proxy(target, {
    get(object, property, receiver) {
      const value: unknown = Reflect.get(object, property, receiver);
      if (typeof value !== 'function') return value;
      return (...args: unknown[]): unknown => {
        if (isCrashed()) return new Promise(() => undefined);
        const result: unknown = (value as (...a: unknown[]) => unknown).apply(object, args);
        return result instanceof Promise ? gate(result, isCrashed) : result;
      };
    },
  });
}

interface LoggedLine {
  readonly level: string;
  readonly fields: Record<string, unknown>;
  readonly message: string;
}

describe.each(DEPLOY_ENGINE_UBUNTU_VERSIONS)('12-13 / A1-A4: cancel and worker-crash sweep on real infrastructure, Ubuntu %s', (ubuntu) => {
  let stack: DeployEngineStack | undefined;
  let stackStart: Promise<DeployEngineStack> | undefined;
  let pgStart: Promise<PostgresFixture> | undefined;
  let redisStart: Promise<RedisFixture> | undefined;
  let postgres: PostgresFixture | undefined;
  let redis: RedisFixture | undefined;
  let queueConnection: Redis | undefined;
  let workerConnection: Redis | undefined;
  let worker: { close(): Promise<void> } | undefined;
  let deployQueue: DeployQueue | undefined;
  let tempRoot: string | undefined;
  let runtime: DeployRuntimeModule | undefined;
  let workerModule: DeployWorkerModule | undefined;
  let baseDeps: DeployJobDeps | undefined;
  let startWorker: (() => void) | undefined;
  let triggerDeploy: ((serviceId: string) => Promise<string>) | undefined;
  let createRowOnly: ((serviceId: string) => Promise<string>) | undefined;
  let cancelDeployment: CancelDeployment | undefined;
  let pebble: StartedPebble | undefined;

  const masterKey = randomBytes(32);
  const events: ServerEvent[] = [];
  /** 17-06: called on every published event, so a test can act the moment a status is recorded. */
  let onEvent: ((event: ServerEvent) => void) | null = null;
  const logged: LoggedLine[] = [];
  let connects = 0;
  let projectId = '';
  let environmentId = '';
  let serverId = '';
  let nodeBase = '';

  const s = (): DeployEngineStack => {
    if (stack === undefined) throw new Error('stack not started');
    return stack;
  };
  const db = (): PostgresFixture['db'] => {
    if (postgres === undefined) throw new Error('postgres not started');
    return postgres.db;
  };
  const deps = (): DeployJobDeps => {
    if (baseDeps === undefined) throw new Error('runtime not started');
    return baseDeps;
  };
  const cancel = (deploymentId: string) => {
    if (cancelDeployment === undefined) throw new Error('runtime not started');
    return cancelDeployment(deploymentId, ACTOR);
  };
  const root = (argv: readonly string[]) => s().exec(argv, { user: 'root' });
  const rootOut = async (argv: readonly string[]): Promise<string> => (await root(argv)).stdout.trim();
  const exists = async (argv: readonly string[]): Promise<boolean> => (await root(argv)).exitCode === 0;
  const imageExists = (ref: string) => exists(['docker', 'image', 'inspect', ref]);
  const networkExists = (name: string) => exists(['docker', 'network', 'inspect', name]);
  const containerExists = (name: string) => exists(['docker', 'container', 'inspect', name]);
  const pathGone = async (target: string): Promise<boolean> => !(await exists(['test', '-e', target]));
  // 14-30: the base persists once any workspace was made, so this proves the path checked is real.
  const workspaceBaseExists = async (): Promise<boolean> => exists(['test', '-d', WORKSPACE_ROOT]);
  const markerRunning = async (): Promise<boolean> =>
    (await rootOut(['sh', '-c', 'ps -eww -o args= | grep -F -- "$0" | grep -v grep || true', SLOW_MARKER])) !== '';
  const dockerFootprint = async (): Promise<string> =>
    rootOut(['docker', 'system', 'df', '--format', '{{.Type}} {{.TotalCount}} {{.Active}} {{.Size}}']);
  /** A3 compares Images/Containers/Local Volumes only; BuildKit cache is checked as bounded growth (ADR 0008). */
  const withoutBuildCache = (footprint: string): string =>
    footprint
      .split('\n')
      .filter((line) => !line.startsWith('Build Cache'))
      .join('\n');
  /** Total bytes of BuildKit cache records, from `docker buildx du --verbose`. */
  const buildCacheBytes = async (): Promise<number> => {
    const du = await root(['docker', 'buildx', 'du', '--verbose']);
    expect(du.exitCode, du.stderr).toBe(0);
    let total = 0;
    for (const match of du.stdout.matchAll(/^Size:\s+([\d.]+)\s*([kMGT]?B)$/gm)) {
      const unit = { B: 1, kB: 1e3, MB: 1e6, GB: 1e9, TB: 1e12 }[match[2] as 'B' | 'kB' | 'MB' | 'GB' | 'TB'];
      total += Number(match[1]) * unit;
    }
    return total;
  };

  const waitFor = async (what: string, check: () => Promise<boolean>, timeoutMs = WAIT_MS): Promise<void> => {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      if (await check()) return;
      if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
      await delay(POLL_MS);
    }
  };

  const deploymentRow = async (deploymentId: string) => {
    const [row] = await db().select().from(deployments).where(eq(deployments.id, deploymentId));
    if (!row) throw new Error(`deployment ${deploymentId} missing`);
    return row;
  };
  const waitStatus = async (deploymentId: string, accept: (status: string) => boolean) => {
    await waitFor(`deployment ${deploymentId}`, async () => accept((await deploymentRow(deploymentId)).status));
    return deploymentRow(deploymentId);
  };
  const deploymentStatuses = (deploymentId: string): string[] =>
    events.flatMap((event) =>
      event.type === 'deployment.updated' && event.deployment.id === deploymentId ? [event.deployment.status] : [],
    );

  const insertService = async (repo: string, healthcheck: HealthcheckConfig | null): Promise<string> => {
    const serviceCredentials = await import('../../../apps/control-plane/src/services/service-credentials.js');
    const encoded = serviceCredentials.encodeServiceCredential(
      {
        kind: 'deploy_key',
        privateKey: secretValue(s().deployKey.privateKey, 'ssh_private_key'),
        publicKey: s().deployKey.publicKey,
      },
      { key: masterKey, version: KEY_VERSION },
    );
    const credentialId = await db().transaction((tx) => serviceCredentials.insertServiceCredential(tx, encoded, new Date()));
    const [row] = await db()
      .insert(services)
      .values({
        projectId,
        environmentId,
        serverId,
        name: `cancel-${randomUUID().slice(0, 8)}`,
        sourceType: 'git',
        repositoryUrl: s().gitRepoUrl(repo),
        branch: 'main',
        buildContext: '.',
        dockerfilePath: 'Dockerfile',
        buildTarget: null,
        internalPort: 3000,
        publishedPort: null,
        repositoryCredentialId: credentialId,
        healthcheck,
      })
      .returning({ id: services.id });
    if (!row) throw new Error('service insert returned no row');
    return row.id;
  };
  const insertSlowService = (): Promise<string> => insertService(SLOW_REPO, null);

  /** A1/A3: nothing the deployment created is left on the server. */
  const expectNoDeploymentResources = async (serviceId: string, deploymentId: string): Promise<void> => {
    expect(await imageExists(`noodara/${serviceId}:${deploymentId}`)).toBe(false);
    expect(await networkExists(`noodara-net-${serviceId}`)).toBe(false);
    expect(await workspaceBaseExists(), 'workspace base missing: the check below would be vacuous').toBe(true);
    expect(await pathGone(`${WORKSPACE_ROOT}/${deploymentId}`)).toBe(true);
  };

  beforeAll(async () => {
    stackStart = (async () => {
        tempRoot = mkdtempSync(path.join(tmpdir(), 'noodara-runtime-cancel-'));
        const slowDir = writeSlowRepo(tempRoot, nodeBaseOf(resolveBaseImages()));
        return startDeployEngineStack({
          ubuntu,
          seedRepositories: [
            { name: SLOW_REPO, sourceDir: slowDir },
            { name: REPOS.healthy, sourceDir: path.join(FIXTURES_DIR, 'node-api') },
            { name: REPOS.unhealthy, sourceDir: path.join(FIXTURES_DIR, 'unhealthy-api') },
          ],
        });
      })();
    pgStart = startPostgres();
    redisStart = startRedis();
    const [stackStarted, pgStarted, redisStarted] = await Promise.all([stackStart, pgStart, redisStart]);
    stack = stackStarted;
    postgres = pgStarted;
    redis = redisStarted;
    nodeBase = nodeBaseOf(stack.baseImages);

    process.env.NOODARA_MASTER_KEY = masterKey.toString('base64');
    process.env.BETTER_AUTH_SECRET = `runtime-cancel-${randomUUID()}-${randomUUID()}`;
    process.env.DATABASE_URL = postgres.connectionString;
    process.env.REDIS_URL = redis.connectionUrl;
    process.env.NOODARA_PUBLIC_URL = 'http://localhost:3000';

    runtime = await import('../../../apps/control-plane/src/deploy/deploy-runtime.js');
    workerModule = await import('../../../apps/control-plane/src/deploy/deploy-worker.js');
    const deploymentServices: DeploymentServicesModule = await import(
      '../../../apps/control-plane/src/services/deployment-services.js'
    );
    const queueModule: DeployQueueModule = await import('../../../apps/control-plane/src/queue/deploy-queue.js');
    const credentialStore: CredentialStoreModule = await import('../../../apps/control-plane/src/services/credential-store.js');
    const cancelFlagModule = await import('../../../apps/control-plane/src/deploy/cancel-flag.js');
    const cancelModule = await import('../../../apps/control-plane/src/deploy/cancel-deployment.js');
    const storeModule = await import('../../../apps/control-plane/src/deploy/deployment-store.js');
    const budget = await import('../../../apps/control-plane/src/queue/deploy-job-budget.js');

    const redactor = createRedactor();
    const probe = await createSsh2Adapter().connect({
      target: { host: stack.ssh.host, port: stack.ssh.port, user: stack.ssh.user },
      credential: { kind: 'private_key', privateKey: secretValue(stack.ssh.privateKey, 'ssh_private_key') },
      timeouts: { connectMs: 20_000, commandMs: 60_000, discoveryMs: 120_000 },
      trustedFingerprint: null,
      redactor,
    });
    if (!probe.ok) throw new Error(`fingerprint probe failed: ${probe.errorCode}`);
    const fingerprint = formatFingerprint(probe.fingerprint);
    await probe.session.close();

    const encoded = credentialStore.encodeCredential(
      { kind: 'private_key', privateKey: stack.ssh.privateKey },
      { key: masterKey, version: KEY_VERSION },
      redactor,
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
        name: `cancel-host-${ubuntu}`,
        host: stack.ssh.host,
        sshPort: stack.ssh.port,
        sshUser: stack.ssh.user,
        credentialId: credentialRow.id,
        status: 'CONNECTED',
        hostFingerprint: fingerprint,
        dockerInstalled: true,
      })
      .returning({ id: servers.id });
    if (!serverRow) throw new Error('server insert returned no row');
    serverId = serverRow.id;

    const now = new Date();
    const [projectRow] = await db()
      .insert(projects)
      .values({ name: 'Runtime cancel', slug: `cancel-${randomUUID().slice(0, 8)}`, createdAt: now, updatedAt: now })
      .returning({ id: projects.id });
    if (!projectRow) throw new Error('project insert returned no row');
    projectId = projectRow.id;
    const [environmentRow] = await db()
      .insert(environments)
      .values({ projectId, name: 'production', createdAt: now, updatedAt: now })
      .returning({ id: environments.id });
    if (!environmentRow) throw new Error('environment insert returned no row');
    environmentId = environmentRow.id;

    const recordingEvents = {
      publish(event: ServerEvent): Promise<void> {
        events.push(event);
        onEvent?.(event);
        return Promise.resolve();
      },
    };
    const logger = {
      info: (fields: Record<string, unknown>, message: string) => logged.push({ level: 'info', fields, message }),
      warn: (fields: Record<string, unknown>, message: string) => logged.push({ level: 'warn', fields, message }),
      error: (fields: Record<string, unknown>, message: string) => logged.push({ level: 'error', fields, message }),
    };
    const created = runtime.createDeployJobDeps({
      db: db(),
      events: recordingEvents,
      ssh: createSsh2Adapter(),
      timeouts: { connectMs: 20_000, commandMs: 60_000, discoveryMs: 120_000 },
      masterKeys: () => Promise.resolve({ current: masterKey }),
      panelPorts: [],
      config: { deployMaxMs: DEPLOY_MAX_MS, idleMs: 120_000, logMaxBytes: 1_048_576, logLineMaxBytes: 16_384 },
      logger,
    });
    // A1: every remote session the worker opens is counted.
    baseDeps = {
      ...created,
      connect: (id, runRedactor, signal) => {
        connects += 1;
        return created.connect(id, runRedactor, signal);
      },
    };

    queueConnection = new Redis(redis.connectionUrl, { maxRetriesPerRequest: null });
    workerConnection = new Redis(redis.connectionUrl, { maxRetriesPerRequest: null });
    const flags = cancelFlagModule.createDeployCancelFlags({
      redis: cancelFlagModule.cancelFlagRedisFrom(queueConnection),
      ttlMs: budget.computeDeployCancelKeyTtlMs(DEPLOY_MAX_MS),
    });
    deployQueue = queueModule.createDeployQueue({ connection: queueConnection, enqueueTimeoutMs: 10_000 });
    const queueRef = deployQueue;
    const store = storeModule.createDeploymentStore({ db: db(), now: () => new Date(), events: recordingEvents });
    cancelDeployment = cancelModule.createCancelDeployment({ store, flags, queue: queueRef, logger });

    const handler = workerModule.createDeployJobHandler({
      ...baseDeps,
      cancel: {
        watch: (deploymentId) => cancelFlagModule.watchDeployCancel({ flags, deploymentId, pollMs: 250 }),
        clear: (deploymentId) => flags.clear(deploymentId),
      },
    });
    const runtimeRef = runtime;
    const workerRedis = workerConnection;
    startWorker = () => {
      worker ??= runtimeRef.startDeployWorker({
        handler,
        connection: workerRedis,
        concurrency: 2,
        deployMaxMs: DEPLOY_MAX_MS,
        logger,
      });
    };

    const api = deploymentServices.createDeploymentServices({
      db: db(),
      now: () => new Date(),
      events: recordingEvents,
      queue: queueRef,
      logger,
    });
    triggerDeploy = async (serviceId) => {
      const result = await api.triggerDeploy({ actor: ACTOR, serviceId });
      if (!result.ok) throw new Error(`triggerDeploy failed: ${result.code}`);
      return result.deployment.id;
    };
    // A4: a QUEUED row with no job, so only the emulated (doomed) worker below ever claims it.
    const rowOnly = deploymentServices.createDeploymentServices({
      db: db(),
      now: () => new Date(),
      events: recordingEvents,
      queue: { enqueue: () => Promise.resolve({ ok: true, jobId: 'unused' } as const) },
      logger,
    });
    createRowOnly = async (serviceId) => {
      const result = await rowOnly.triggerDeploy({ actor: ACTOR, serviceId });
      if (!result.ok) throw new Error(`triggerDeploy failed: ${result.code}`);
      return result.deployment.id;
    };
  }, STACK_TIMEOUT_MS);

  afterAll(async () => {
    // 14-27: bounded steps; a start still pending when beforeAll timed out is awaited briefly and stopped too.
    const [stk, pg, rd] = await Promise.all([
      stack ?? settleWithin(stackStart, PENDING_START_WAIT_MS),
      postgres ?? settleWithin(pgStart, PENDING_START_WAIT_MS),
      redis ?? settleWithin(redisStart, PENDING_START_WAIT_MS),
    ]);
    await runTeardown(
      `runtime cancel (Ubuntu ${ubuntu})`,
      [
        { name: 'worker.close', run: () => worker?.close() },
        { name: 'deployQueue.close', run: () => deployQueue?.close() },
        { name: 'disconnect redis connections', run: () => { workerConnection?.disconnect(); queueConnection?.disconnect(); } },
        { name: 'pebble.stop', run: () => pebble?.stop(), timeoutMs: FIXTURE_STOP_TIMEOUT_MS },
        { name: 'redis.stop', run: () => rd?.stop(), timeoutMs: FIXTURE_STOP_TIMEOUT_MS },
        { name: 'postgres.stop', run: () => pg?.stop(), timeoutMs: FIXTURE_STOP_TIMEOUT_MS },
        { name: 'stack.stop', run: () => stk?.stop(), timeoutMs: STACK_STOP_TIMEOUT_MS },
        { name: 'remove temp dir', run: () => { if (tempRoot !== undefined) rmSync(tempRoot, { recursive: true, force: true }); } },
      ],
      { stepTimeoutMs: TEARDOWN_STEP_TIMEOUT_MS },
    );
  }, STACK_TIMEOUT_MS);

  it('A1: cancelling a QUEUED deployment removes its job and ends CANCELLED without any remote command', async () => {
    if (triggerDeploy === undefined || startWorker === undefined || deployQueue === undefined) throw new Error('runtime not started');
    const serviceId = await insertSlowService();
    // No worker runs yet, so the deployment stays QUEUED with its job waiting.
    const deploymentId = await triggerDeploy(serviceId);
    expect(await deployQueue.isJobPending(deploymentId)).toBe(true);

    const result = await cancel(deploymentId);

    expect(result).toMatchObject({ ok: true, deployment: { id: deploymentId, status: 'CANCELLED' } });
    expect((await deploymentRow(deploymentId)).status).toBe('CANCELLED');
    expect(await deployQueue.isJobPending(deploymentId)).toBe(false);
    // The worker starts afterwards and still never opens a session for it.
    startWorker();
    await delay(3_000);
    expect(connects).toBe(0);
    expect((await deploymentRow(deploymentId)).status).toBe('CANCELLED');
    expect(await pathGone(`${WORKSPACE_ROOT}/${deploymentId}`)).toBe(true);

    // H1: the terminal deployment is a named 409 at the service layer.
    expect(await cancel(deploymentId)).toMatchObject({ ok: false, code: 'DEPLOYMENT_NOT_CANCELLABLE' });
  }, CASE_TIMEOUT_MS);

  /** Starts a slow build and cancels it once its RUN step is live; resolves with the terminal row. */
  const deployAndCancelMidBuild = async (serviceId: string) => {
    if (triggerDeploy === undefined) throw new Error('runtime not started');
    const deploymentId = await triggerDeploy(serviceId);
    await waitStatus(deploymentId, (status) => status === 'BUILDING');
    await waitFor('the slow build step to run', markerRunning);

    const result = await cancel(deploymentId);
    // Only the worker transitions a claimed deployment: the API answers with the row as it was.
    expect(result).toMatchObject({ ok: true, deployment: { id: deploymentId } });
    if (result.ok) expect(result.deployment.status).not.toBe('CANCELLED');
    // H1: a second cancel while the flag is up is a no-op that answers the same way.
    expect(await cancel(deploymentId)).toMatchObject({ ok: true, deployment: { id: deploymentId } });

    return waitStatus(deploymentId, (status) => TERMINAL.has(status));
  };

  /** docker system df once BuildKit has released the cancelled build's refs (two equal reads in a row). */
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

  it('A2/A3: cancelling a running build kills its process group, cleans up and ends CANCELLED with docker df unchanged (build cache bounded)', async () => {
    if (startWorker === undefined) throw new Error('runtime not started');
    startWorker();
    // Any build attempt records the shared base-image layers and the clone context in BuildKit's
    // cache, cancelled or not. A first cancel warms that shared cache; the second adds at most one
    // small orphan record (bounded below).
    const warmUp = await deployAndCancelMidBuild(await insertSlowService());
    expect(warmUp.status).toBe('CANCELLED');
    const serviceId = await insertSlowService();
    const before = await settledFootprint();
    const cacheBefore = await buildCacheBytes();

    const row = await deployAndCancelMidBuild(serviceId);
    expect(row.status).toBe('CANCELLED');
    expect(deploymentStatuses(row.id).at(-1)).toBe('CANCELLED');
    expect(deploymentStatuses(row.id)).toContain('BUILDING');

    // A2: the build's process group is gone from the server, not merely detached.
    expect(await markerRunning()).toBe(false);
    // A3: no container, partial image, network, workspace or secrets file remains.
    expect(await containerExists(`noodara-${serviceId}`)).toBe(false);
    await expectNoDeploymentResources(serviceId, row.id);
    const after = await settledFootprint();
    expect(withoutBuildCache(after), `docker system df before:\n${before}`).toBe(withoutBuildCache(before));
    // An interrupted build leaves one unused ~8 kB BuildKit record (ADR 0008); growth stays bounded.
    const cacheGrowth = (await buildCacheBytes()) - cacheBefore;
    const cacheDetail =
      cacheGrowth <= MAX_CACHE_GROWTH_PER_CANCEL ? '' : (await rootOut(['docker', 'buildx', 'du', '--verbose'])).slice(-4_000);
    expect(cacheGrowth, cacheDetail).toBeLessThanOrEqual(MAX_CACHE_GROWTH_PER_CANCEL);
    expect(JSON.stringify(logged)).not.toContain('CANCEL_UNCONFIRMED');
  }, CASE_TIMEOUT_MS);

  it('A4: a worker killed mid-build is swept FAILED/WORKER_CRASHED; per-deployment resources go, the per-service container stays', async () => {
    if (createRowOnly === undefined || workerModule === undefined || runtime === undefined) throw new Error('runtime not started');
    const serviceId = await insertSlowService();
    const serviceContainer = `noodara-${serviceId}`;
    const foreign = await root(['docker', 'create', '--name', serviceContainer, nodeBase, 'true']);
    expect(foreign.exitCode, foreign.stderr).toBe(0);
    const serviceContainerId = foreign.stdout.trim();

    try {
      const deploymentId = await createRowOnly(serviceId);
      // The doomed worker: once `crashed`, its session and store freeze and its SSH connection drops.
      let crashed = false;
      const isCrashed = (): boolean => crashed;
      const closes: (() => Promise<void>)[] = [];
      const streamed: string[] = [];
      const doomed = workerModule.createDeployJobHandler({
        ...deps(),
        sinkFor: () => ({ write: (entry) => streamed.push(entry.text), close: () => Promise.resolve() }),
        store: freezeOnCrash(deps().store, isCrashed),
        connect: async (id, runRedactor, signal) => {
          const connected = await deps().connect(id, runRedactor, signal);
          if (!connected.ok) return connected;
          closes.push(connected.close);
          return { ...connected, session: freezeOnCrash(connected.session, isCrashed), close: () => gate(connected.close(), isCrashed) };
        },
      });
      void doomed({ deploymentId, serviceId, actor: ACTOR, requestedAt: new Date().toISOString() });

      await waitStatus(deploymentId, (status) => status === 'BUILDING');
      await waitFor('the slow build step to run', markerRunning);
      // The docker CLI streams the build over the SSH channel: a write after the channel is gone
      // kills it (EPIPE) and BuildKit then cancels the step. Crash only once the RUN step's echo
      // reached the worker, so the CLI has nothing left to print until `sleep 307` ends.
      await waitFor('the RUN step output to reach the worker', () =>
        Promise.resolve(/#\d+ [\d.]+ noodara-cancel-build/.test(streamed.join(''))),
      );
      crashed = true;
      await Promise.all(closes.map((close) => close().catch(() => undefined)));
      // The build survives its dead worker (setsid -w): only the sweep can stop it.
      expect(await markerRunning()).toBe(true);
      expect((await deploymentRow(deploymentId)).status).toBe('BUILDING');

      const sweepModule = await import('../../../apps/control-plane/src/deploy/deploy-sweep.js');
      const storeModule = await import('../../../apps/control-plane/src/deploy/deployment-store.js');
      const sweep = await sweepModule.sweepCrashedDeployments({
        store: storeModule.createDeploymentStore({ db: db(), now: () => new Date(), events: { publish: () => Promise.resolve() } }),
        connect: deps().connect,
        createRedactor: deps().createRedactor,
        limits: deps().limits,
        logger: deps().logger,
      });
      expect(sweep.swept).toEqual([deploymentId]);
      const row = await deploymentRow(deploymentId);
      expect({ status: row.status, errorCode: row.errorCode }).toEqual({ status: 'FAILED', errorCode: 'WORKER_CRASHED' });

      await sweep.cleanup;
      await waitFor('the orphaned build to stop', async () => !(await markerRunning()), 60_000);
      expect(await imageExists(`noodara/${serviceId}:${deploymentId}`)).toBe(false);
      expect(await workspaceBaseExists()).toBe(true);
      expect(await pathGone(`${WORKSPACE_ROOT}/${deploymentId}`)).toBe(true);
      // Never the per-service container.
      expect(await rootOut(['docker', 'container', 'inspect', serviceContainer, '--format', '{{.Id}}'])).toBe(serviceContainerId);
    } finally {
      await root(['docker', 'rm', '-f', serviceContainerId]);
    }
  }, CASE_TIMEOUT_MS);

  const containerField = (name: string, format: string) =>
    rootOut(['docker', 'container', 'inspect', '--format', format, name]);
  /** No orphan: the service's only managed container is the one under its name. */
  const serviceContainers = async (serviceId: string): Promise<string[]> =>
    (await rootOut(['docker', 'ps', '-a', '--filter', 'label=noodara.managed=true', '--format', '{{.Names}}']))
      .split('\n')
      .filter((name) => name.startsWith(`noodara-${serviceId}`))
      .sort();
  const updateService = async (serviceId: string, repo: string, healthcheck: HealthcheckConfig): Promise<void> => {
    await db()
      .update(services)
      .set({ repositoryUrl: s().gitRepoUrl(repo), healthcheck })
      .where(eq(services.id, serviceId));
  };
  /** A healthy first deploy through the worker, then the service points at unhealthy-api. */
  const deployThenBreak = async (serviceId: string, startPeriodS: number) => {
    if (triggerDeploy === undefined || startWorker === undefined) throw new Error('runtime not started');
    startWorker();
    const first = await waitStatus(await triggerDeploy(serviceId), (status) => TERMINAL.has(status));
    expect({ status: first.status, errorCode: first.errorCode }).toEqual({ status: 'SUCCESS', errorCode: null });
    await updateService(serviceId, REPOS.unhealthy, httpCheck('/healthz', startPeriodS));
    return first;
  };

  it('17-06 A1: a cancel during HEALTHCHECK removes the new container, restores -prev and ends CANCELLED', async () => {
    if (triggerDeploy === undefined) throw new Error('runtime not started');
    const serviceId = await insertService(REPOS.healthy, httpCheck('/health'));
    try {
      const first = await deployThenBreak(serviceId, 120);
      const deploymentId = await triggerDeploy(serviceId);
      await waitStatus(deploymentId, (status) => status === 'HEALTHCHECK');
      // The swap is done: the new version runs under the service name, the previous one is kept.
      expect(await containerField(`noodara-${serviceId}`, '{{.Config.Image}}')).toBe(`noodara/${serviceId}:${deploymentId}`);
      expect(await containerExists(`noodara-${serviceId}-prev`)).toBe(true);

      const result = await cancel(deploymentId);
      // Only the worker moves a claimed row: the API answers 202 with the row as it was.
      expect(result).toMatchObject({ ok: true, deployment: { id: deploymentId, status: 'HEALTHCHECK' } });

      const row = await waitStatus(deploymentId, (status) => TERMINAL.has(status));
      expect({ status: row.status, errorCode: row.errorCode }).toEqual({ status: 'CANCELLED', errorCode: null });
      expect(deploymentStatuses(deploymentId).filter((status) => TERMINAL.has(status))).toEqual(['CANCELLED']);
      expect(deploymentStatuses(deploymentId)).toContain('HEALTHCHECK');
      // The previous version is back under the service name and running; nothing else is left.
      expect(await containerField(`noodara-${serviceId}`, '{{.State.Status}} {{.Config.Image}}')).toBe(
        `running noodara/${serviceId}:${first.id}`,
      );
      expect(await serviceContainers(serviceId)).toEqual([`noodara-${serviceId}`]);
      expect(await imageExists(`noodara/${serviceId}:${deploymentId}`)).toBe(false);
      expect(await imageExists(`noodara/${serviceId}:${first.id}`)).toBe(true);
      expect(await workspaceBaseExists()).toBe(true);
      expect(await pathGone(`${WORKSPACE_ROOT}/${deploymentId}`)).toBe(true);
      expect(JSON.stringify(logged)).not.toContain('CANCEL_UNCONFIRMED');
    } finally {
      await root(['docker', 'rm', '-f', `noodara-${serviceId}`, `noodara-${serviceId}-prev`]);
    }
  }, CASE_TIMEOUT_MS);

  it('17-06 A1: a cancel during ROLLING_BACK is a named 409 ROLLBACK_IN_PROGRESS and the rollback completes', async () => {
    if (triggerDeploy === undefined) throw new Error('runtime not started');
    const serviceId = await insertService(REPOS.healthy, httpCheck('/health'));
    try {
      const first = await deployThenBreak(serviceId, 5);
      const deploymentId = await triggerDeploy(serviceId);
      // The cancel goes out the moment the store records ROLLING_BACK (before any restore step).
      let rejected: Promise<CancelDeploymentResult> | undefined;
      onEvent = (event) => {
        if (event.type !== 'deployment.updated' || event.deployment.id !== deploymentId) return;
        if (event.deployment.status === 'ROLLING_BACK') rejected ??= cancel(deploymentId);
      };
      const row = await waitStatus(deploymentId, (status) => TERMINAL.has(status));
      onEvent = null;

      if (rejected === undefined) throw new Error('ROLLING_BACK was never published');
      const result = await rejected;
      expect(result).toMatchObject({ ok: false, code: 'ROLLBACK_IN_PROGRESS' });
      if (!result.ok) expect(mapServiceCodeToStatus(result.code)).toBe(409);
      // The rollback ran to its end: the previous version is restored and checked.
      expect({ status: row.status, errorCode: row.errorCode }).toEqual({ status: 'ROLLED_BACK', errorCode: 'HEALTHCHECK_FAILED' });
      expect(deploymentStatuses(deploymentId).filter((status) => TERMINAL.has(status))).toEqual(['ROLLED_BACK']);
      expect(await containerField(`noodara-${serviceId}`, '{{.State.Status}} {{.Config.Image}}')).toBe(
        `running noodara/${serviceId}:${first.id}`,
      );
      expect(await serviceContainers(serviceId)).toEqual([`noodara-${serviceId}`]);
      expect(await pathGone(`${WORKSPACE_ROOT}/${deploymentId}`)).toBe(true);
      // No cancel flag was raised, so a later cancel is the terminal 409.
      expect(await cancel(deploymentId)).toMatchObject({ ok: false, code: 'DEPLOYMENT_NOT_CANCELLABLE' });
    } finally {
      onEvent = null;
      await root(['docker', 'rm', '-f', `noodara-${serviceId}`, `noodara-${serviceId}-prev`]);
    }
  }, CASE_TIMEOUT_MS);

  /** 22-08 A7: installs the real proxy (Traefik against Pebble) and returns the domain applier's re-apply. */
  const installRoutedProxy = async (): Promise<() => Promise<{ applied: number; failed: number }>> => {
    if (tempRoot === undefined) throw new Error('runtime not started');
    const proxyJob = await import('../../../apps/control-plane/src/proxy/proxy-job.js');
    const proxyWiring = await import('../../../apps/control-plane/src/proxy/proxy-wiring.js');
    const deployConnect = await import('../../../apps/control-plane/src/deploy/deploy-connect.js');
    const domainServices = await import('../../../apps/control-plane/src/domains/domain-services.js');
    const domainApply = await import('../../../apps/control-plane/src/domains/domain-apply.js');
    pebble = await startPebble({ networkName: s().networkName, validitySeconds: CERT_VALIDITY_SECONDS });
    const caRootFile = path.join(tempRoot, 'ca-root.pem');
    writeFileSync(caRootFile, pebble.listenerRootPem, { mode: 0o600 });
    const quiet = { info: () => undefined, warn: () => undefined, error: () => undefined };
    const ssh = createSsh2Adapter();
    const masterKeys = () => Promise.resolve({ current: masterKey });
    const install = proxyJob.createProxyInstallJobHandler(
      proxyWiring.createProxyInstallJobDeps({
        db: db(),
        events: { publish: () => Promise.resolve() },
        ssh,
        timeouts: TIMEOUTS,
        masterKeys,
        image: TRAEFIK_IMAGE,
        acmeCaUrl: PEBBLE_ACME_DIRECTORY_URL,
        acmeCaRootFile: caRootFile,
        maxLineBytes: 16_384,
        logger: quiet,
        extraHosts: [{ name: PEBBLE_HOSTNAME, ip: pebble.ip }],
      }),
    );
    await db().update(servers).set({ proxyStatus: 'INSTALLING' }).where(eq(servers.id, serverId));
    expect(await install({ serverId, acmeEmail: 'admin@noodara.dev', jobId: `proxy-install-${serverId}` })).not.toBe('failed');
    const [server] = await db().select({ proxyStatus: servers.proxyStatus }).from(servers).where(eq(servers.id, serverId));
    expect(server?.proxyStatus).toBe('RUNNING');
    const connect = deployConnect.createDeployConnect({
      loadServer: deployConnect.loadDeployServerFromDb(db()),
      ssh,
      timeouts: TIMEOUTS,
      masterKeys,
    });
    const apply = domainServices.createDomainApplier({
      db: db(),
      connect,
      createRedactor,
      limits: domainApply.domainApplyLimits(TIMEOUTS.commandMs),
    });
    return () => domainServices.reapplyPendingDomains({ db: db(), apply, logger: { warn: () => undefined } });
  };
  /** Status code and body of `/` through Traefik (Host header), curl as root on the deploy host. */
  const hit = async (host: string): Promise<{ code: string; body: string }> => {
    const result = await root(['curl', '-s', '--max-time', '3', '-H', `Host: ${host}`, '-w', ' %{http_code}', 'http://127.0.0.1/']);
    const at = result.stdout.lastIndexOf(' ');
    return { code: result.stdout.slice(at + 1).trim(), body: result.stdout.slice(0, Math.max(at, 0)) };
  };
  const waitAnswer = async (host: string, body: string): Promise<{ code: string; body: string }> => {
    const deadline = Date.now() + ROUTE_WAIT_MS;
    for (;;) {
      const current = await hit(host);
      if ((current.code === '200' && current.body === body) || Date.now() >= deadline) return current;
      await delay(250);
    }
  };

  it('22-08 A7: a cancel during DEPLOYING on a routed service ends CANCELLED and the route keeps serving the previous deployment', async () => {
    if (triggerDeploy === undefined) throw new Error('runtime not started');
    const reapplyPending = await installRoutedProxy();
    const host = `c${randomUUID().slice(0, 8)}.cancel.noodara.test`;
    const previous = JSON.stringify({ service: 'node-api', ok: true });
    const serviceId = await insertService(REPOS.healthy, httpCheck('/health'));
    try {
      await db().insert(domains).values({ projectId, serviceId, hostname: host, httpsRedirect: false, applyStatus: 'PENDING' });
      // A long start period keeps a new (unhealthy) version in HEALTHCHECK until the cancel lands.
      const first = await deployThenBreak(serviceId, 120);
      expect(await reapplyPending()).toEqual({ applied: 1, failed: 0 });
      expect(await waitAnswer(host, previous)).toEqual({ code: '200', body: previous });

      const deploymentId = await triggerDeploy(serviceId);
      let accepted: Promise<CancelDeploymentResult> | undefined;
      onEvent = (event) => {
        if (event.type !== 'deployment.updated' || event.deployment.id !== deploymentId) return;
        if (event.deployment.status === 'DEPLOYING') accepted ??= cancel(deploymentId);
      };
      const row = await waitStatus(deploymentId, (status) => TERMINAL.has(status));
      onEvent = null;

      if (accepted === undefined) throw new Error('DEPLOYING was never published');
      // Only the worker moves a claimed row: the API answers 202 with the row as it was.
      expect(await accepted).toMatchObject({ ok: true, deployment: { id: deploymentId, status: 'DEPLOYING' } });
      expect({ status: row.status, errorCode: row.errorCode }).toEqual({ status: 'CANCELLED', errorCode: null });
      expect(deploymentStatuses(deploymentId)).toContain('DEPLOYING');
      expect(deploymentStatuses(deploymentId).filter((status) => TERMINAL.has(status))).toEqual(['CANCELLED']);
      // The previous deployment runs under the service name and the route answers it over HTTP.
      expect(await containerField(`noodara-${serviceId}`, '{{.State.Status}} {{.Config.Image}}')).toBe(
        `running noodara/${serviceId}:${first.id}`,
      );
      expect(await waitAnswer(host, previous)).toEqual({ code: '200', body: previous });
      // Stable, not a transient answer: three more samples all hit the previous deployment.
      for (let sample = 0; sample < 3; sample += 1) {
        expect(await hit(host)).toEqual({ code: '200', body: previous });
        await delay(250);
      }
      expect(await serviceContainers(serviceId)).toEqual([`noodara-${serviceId}`]);
    } finally {
      onEvent = null;
      await root(['docker', 'rm', '-f', `noodara-${serviceId}`, `noodara-${serviceId}-prev`]);
    }
  }, ROUTED_CASE_TIMEOUT_MS);

  it('noodara-security: no credential reaches events, logs or deployment rows', async () => {
    const rows = await db().select().from(deployments);
    const surface = JSON.stringify({ events, logged, rows });
    expect(surface).not.toContain(s().deployKey.privateKey.split('\n')[1] ?? s().deployKey.privateKey);
    expect(surface).not.toContain(s().ssh.privateKey.split('\n')[1] ?? s().ssh.privateKey);
    expect(surface).not.toContain(masterKey.toString('base64'));
  });
});
