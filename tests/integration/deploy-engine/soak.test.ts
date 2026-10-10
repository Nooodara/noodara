// 12-18 / QA-08: the deploy-engine soak. 20 consecutive node-api deployments through the real
// worker, then 20 service create -> deploy -> delete cycles that must leave no container, network,
// image or workspace behind (docker system df Images/Containers/Local Volumes back at baseline,
// checked twice in a row, never pruned; build cache excluded per the 2026-10-05 decision in
// .planning/DECISIONS.md). Every iteration's duration and df snapshot go to a JSON artifact.
//
// Opt-in like tests/integration/ssh/stress-connections.test.ts: without NOODARA_SOAK=1 the suite
// reports as skipped. Run it with:
//   NOODARA_SOAK=1 NOODARA_TEST_UBUNTU=24.04 pnpm exec vitest run --config vitest.integration.config.ts tests/integration/deploy-engine/soak.test.ts
// The artifact lands in NOODARA_SOAK_ARTIFACT_DIR (default: <os tmpdir>/noodara-soak-artifacts).
//
// App modules are imported dynamically after a valid test env is written: several of them import
// env.ts, which fail-fasts at import time (INST-06).
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { eq, inArray } from 'drizzle-orm';
import { Redis } from 'ioredis';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createRedactor, secretValue } from '@noodara/domain/security';
import { createSsh2Adapter, formatFingerprint } from '@noodara/ssh';
import {
  credentials,
  deployments,
  environments,
  projects,
  servers,
  services,
} from '../../../apps/control-plane/src/db/schema/index.js';
import type { ServerEvent } from '../../../apps/control-plane/src/events/server-event-publisher.js';
import type { ServiceServices } from '../../../apps/control-plane/src/services/service-services.js';
import {
  DEPLOY_ENGINE_UBUNTU_VERSIONS,
  startDeployEngineStack,
  type DeployEngineStack,
} from '../helpers/deploy-engine.js';
import { startPostgres, type PostgresFixture } from '../helpers/postgres.js';
import { startRedis, type RedisFixture } from '../helpers/redis.js';
import { runTeardown, settleWithin } from '../helpers/teardown.js';

type DeployRuntimeModule = typeof import('../../../apps/control-plane/src/deploy/deploy-runtime.js');
type DeployWorkerModule = typeof import('../../../apps/control-plane/src/deploy/deploy-worker.js');
type ServiceOpsModule = typeof import('../../../apps/control-plane/src/deploy/service-ops.js');
type ServiceOpsJobModule = typeof import('../../../apps/control-plane/src/deploy/service-ops-job.js');
type DeploymentServicesModule = typeof import('../../../apps/control-plane/src/services/deployment-services.js');
type ServiceServicesModule = typeof import('../../../apps/control-plane/src/services/service-services.js');
type DeployQueueModule = typeof import('../../../apps/control-plane/src/queue/deploy-queue.js');
type ServiceCredentialsModule = typeof import('../../../apps/control-plane/src/services/service-credentials.js');
type CredentialStoreModule = typeof import('../../../apps/control-plane/src/services/credential-store.js');

const SOAK_ENABLED = process.env['NOODARA_SOAK'] === '1' || process.env['NOODARA_SOAK'] === 'true';
const ARTIFACT_DIR = process.env['NOODARA_SOAK_ARTIFACT_DIR'] ?? path.join(tmpdir(), 'noodara-soak-artifacts');

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES_DIR = path.resolve(HERE, '../../../fixtures');
const ITERATIONS = 20;
const DEPLOY_MAX_MS = 300_000;
const STACK_TIMEOUT_MS = 900_000;
// Teardown budget (14-27), inside STACK_TIMEOUT_MS: pending start 180 s + steps x 30 s + db/redis 2 x 60 s + stack stop 300 s.
const PENDING_START_WAIT_MS = 180_000;
const TEARDOWN_STEP_TIMEOUT_MS = 30_000;
const FIXTURE_STOP_TIMEOUT_MS = 60_000;
const STACK_STOP_TIMEOUT_MS = 300_000;
/** Worst case is every iteration hitting the deploy max; a healthy run takes a few minutes. */
const SOAK_CASE_TIMEOUT_MS = 3_600_000;
/** Past the worker's own deploy max, so an over-long deploy is measured instead of abandoned. */
const WAIT_MS = DEPLOY_MAX_MS + 60_000;
const POLL_MS = 500;
const WORKSPACE_ROOT = '/opt/noodara-deploy';
const PORTS = { deploys: 13_240, cycles: 13_241 } as const;
const KEY_VERSION = 1;
const TERMINAL = new Set(['SUCCESS', 'FAILED', 'CANCELLED']);
const ACTOR = { type: 'system' } as const;
const NODE_API = 'node-api';

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

interface DfRow {
  readonly type: string;
  readonly total: string;
  readonly active: string;
  readonly size: string;
}

/** `docker system df` with a `|` delimiter: "Local Volumes" and "Build Cache" contain spaces. */
const DF_FORMAT = '{{.Type}}|{{.TotalCount}}|{{.Active}}|{{.Size}}';

function parseDf(raw: string): DfRow[] {
  return raw
    .split('\n')
    .filter((line) => line.trim() !== '')
    .map((line) => {
      const [type = '', total = '', active = '', size = ''] = line.split('|');
      return { type, total, active, size };
    });
}

/** Images, Containers and Local Volumes only: build cache is BuildKit-owned (DECISIONS 2026-10-05). */
function withoutBuildCache(raw: string): string {
  return raw
    .split('\n')
    .filter((line) => !line.startsWith('Build Cache'))
    .join('\n');
}

function percentile(values: readonly number[], p: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[index] ?? 0;
}

interface DeployIteration {
  readonly iteration: number;
  readonly deploymentId: string;
  readonly status: string;
  readonly errorCode: string | null;
  readonly durationMs: number;
  readonly df: DfRow[];
}

interface CycleIteration {
  readonly iteration: number;
  readonly serviceId: string;
  readonly deploymentId: string;
  readonly status: string;
  readonly errorCode: string | null;
  readonly deployMs: number;
  readonly deleteMs: number;
  readonly cycleMs: number;
  readonly df: DfRow[];
}

interface SoakArtifact {
  readonly ubuntu: string;
  readonly startedAt: string;
  readonly deployMaxMs: number;
  readonly iterations: number;
  baseline: DfRow[];
  readonly deploys: DeployIteration[];
  readonly cycles: CycleIteration[];
  afterDeploys: DfRow[];
  finalChecks: DfRow[][];
  summary: Record<string, number>;
}

describe.skipIf(!SOAK_ENABLED)('12-18 / QA-08 soak: 20 deploys and 20 create/delete cycles', () => {
  describe.each(DEPLOY_ENGINE_UBUNTU_VERSIONS)('Ubuntu %s', (ubuntu) => {
    let stack: DeployEngineStack | undefined;
    let stackStart: Promise<DeployEngineStack> | undefined;
    let pgStart: Promise<PostgresFixture> | undefined;
    let redisStart: Promise<RedisFixture> | undefined;
    let postgres: PostgresFixture | undefined;
    let redis: RedisFixture | undefined;
    let queueConnection: Redis | undefined;
    let workerConnection: Redis | undefined;
    let worker: { close(): Promise<void> } | undefined;
    let queue: { close(): Promise<void> } | undefined;
    let operationQueue: { close(): Promise<void> } | undefined;
    let triggerDeploy:
      | ((serviceId: string) => Promise<{ ok: true; id: string } | { ok: false; code: string }>)
      | undefined;
    let serviceCredentials: ServiceCredentialsModule | undefined;
    let credentialStore: CredentialStoreModule | undefined;
    let serviceApi: ServiceServices | undefined;

    const masterKey = randomBytes(32);
    let serverId = '';
    let fingerprint = '';
    let baseline = '';
    let baselineWorkspaces = '';
    let baselineNetworks = '';
    let baselineContainers = '';
    let projectId = '';
    let environmentId = '';

    const artifactPath = path.join(ARTIFACT_DIR, `soak-ubuntu-${ubuntu}.json`);
    const artifact: SoakArtifact = {
      ubuntu,
      startedAt: new Date().toISOString(),
      deployMaxMs: DEPLOY_MAX_MS,
      iterations: ITERATIONS,
      baseline: [],
      deploys: [],
      cycles: [],
      afterDeploys: [],
      finalChecks: [],
      summary: {},
    };
    /** Rewritten after every iteration so a run that dies midway still leaves its numbers. */
    const flushArtifact = (): void => {
      const deployDurations = artifact.deploys.map((entry) => entry.durationMs);
      const cycleDeployDurations = artifact.cycles.map((entry) => entry.deployMs);
      const cycleDurations = artifact.cycles.map((entry) => entry.cycleMs);
      artifact.summary = {
        deployP50Ms: percentile(deployDurations, 50),
        deployMaxMs: Math.max(0, ...deployDurations),
        cycleDeployP50Ms: percentile(cycleDeployDurations, 50),
        cycleDeployMaxMs: Math.max(0, ...cycleDeployDurations),
        cycleP50Ms: percentile(cycleDurations, 50),
        cycleMaxMs: Math.max(0, ...cycleDurations),
      };
      mkdirSync(ARTIFACT_DIR, { recursive: true });
      writeFileSync(artifactPath, `${JSON.stringify(artifact, null, 2)}\n`);
    };

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
    const root = (argv: readonly string[]) => s().exec(argv, { user: 'root' });
    const rootOut = async (argv: readonly string[]): Promise<string> => (await root(argv)).stdout.trim();
    const exists = async (argv: readonly string[]): Promise<boolean> => (await root(argv)).exitCode === 0;
    const networkExists = (name: string) => exists(['docker', 'network', 'inspect', name]);
    const containerExists = (name: string) => exists(['docker', 'container', 'inspect', name]);
    const pathGone = async (target: string): Promise<boolean> => !(await exists(['test', '-e', target]));
    const serviceImages = async (serviceId: string): Promise<string> =>
      rootOut(['docker', 'image', 'ls', '--filter', `reference=noodara/${serviceId}`, '--format', '{{.Repository}}:{{.Tag}}']);
    const workspaceListing = async (): Promise<string> =>
      rootOut(['sh', '-c', `ls -A ${WORKSPACE_ROOT} 2>/dev/null || true`]);
    const noodaraNetworks = async (): Promise<string> =>
      rootOut(['docker', 'network', 'ls', '--filter', 'name=noodara-', '--format', '{{.Name}}']);
    const noodaraContainers = async (): Promise<string> =>
      rootOut(['docker', 'ps', '-a', '--filter', 'name=noodara-', '--format', '{{.Names}}']);
    const dockerFootprint = async (): Promise<string> => rootOut(['docker', 'system', 'df', '--format', DF_FORMAT]);
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
        .values({ name, slug: `soak-${randomUUID().slice(0, 8)}`, createdAt: now, updatedAt: now })
        .returning({ id: projects.id });
      if (!projectRow) throw new Error('project insert returned no row');
      const [environmentRow] = await db()
        .insert(environments)
        .values({ projectId: projectRow.id, name: 'production', createdAt: now, updatedAt: now })
        .returning({ id: environments.id });
      if (!environmentRow) throw new Error('environment insert returned no row');
      return { projectId: projectRow.id, environmentId: environmentRow.id };
    };

    const insertGitService = async (publishedPort: number): Promise<{ id: string; name: string; credentialId: string }> => {
      const name = `svc-${randomUUID().slice(0, 8)}`;
      const credentialId = await insertRepositoryCredential();
      const [row] = await db()
        .insert(services)
        .values({
          projectId,
          environmentId,
          serverId,
          name,
          sourceType: 'git',
          repositoryUrl: s().gitRepoUrl(NODE_API),
          branch: 'main',
          buildContext: '.',
          dockerfilePath: 'Dockerfile',
          internalPort: 3000,
          publishedPort,
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
    /** Trigger to terminal status, timed from the caller's side (queueing included). */
    const timedDeploy = async (serviceId: string) => {
      if (triggerDeploy === undefined) throw new Error('runtime not started');
      const started = Date.now();
      const result = await triggerDeploy(serviceId);
      if (!result.ok) throw new Error(`triggerDeploy failed: ${result.code}`);
      const deadline = started + WAIT_MS;
      for (;;) {
        const row = await deploymentRow(result.id);
        if (TERMINAL.has(row.status)) return { row, durationMs: Date.now() - started };
        if (Date.now() > deadline) throw new Error(`deployment ${result.id} stuck in ${row.status}`);
        await delay(POLL_MS);
      }
    };

    const deleteService = async (service: { id: string; name: string }): Promise<void> => {
      const deleted = await svcApi().deleteService({
        actor: ACTOR,
        projectId,
        serviceId: service.id,
        confirmName: service.name,
      });
      expect(deleted).toEqual({ ok: true, serviceId: service.id });
    };

    /** The per-service and per-deployment remote resources and rows are all gone. */
    const expectServiceGone = async (
      service: { id: string; credentialId: string },
      deploymentIds: readonly string[],
    ): Promise<void> => {
      expect(await containerExists(`noodara-${service.id}`)).toBe(false);
      expect(await networkExists(`noodara-net-${service.id}`)).toBe(false);
      expect(await serviceImages(service.id)).toBe('');
      for (const deploymentId of deploymentIds) {
        expect(await pathGone(`${WORKSPACE_ROOT}/${deploymentId}`)).toBe(true);
      }
      const serviceRows = await db().select({ id: services.id }).from(services).where(eq(services.id, service.id));
      const deploymentRows = await db()
        .select({ id: deployments.id })
        .from(deployments)
        .where(eq(deployments.serviceId, service.id));
      const credentialRows = await db()
        .select({ id: credentials.id })
        .from(credentials)
        .where(inArray(credentials.id, [service.credentialId]));
      expect({ services: serviceRows.length, deployments: deploymentRows.length, credentials: credentialRows.length }).toEqual(
        { services: 0, deployments: 0, credentials: 0 },
      );
    };

    /** Nothing Noodara created survives: df, workspaces, networks and containers match the baseline. */
    const expectAtBaseline = async (): Promise<string> => {
      const footprint = await settledFootprint();
      expect(withoutBuildCache(footprint), `docker system df baseline:\n${baseline}`).toBe(withoutBuildCache(baseline));
      expect(await workspaceListing()).toBe(baselineWorkspaces);
      expect(await noodaraNetworks()).toBe(baselineNetworks);
      expect(await noodaraContainers()).toBe(baselineContainers);
      return footprint;
    };

    beforeAll(async () => {
      stackStart = startDeployEngineStack({
          ubuntu,
          seedRepositories: [{ name: NODE_API, sourceDir: path.join(FIXTURES_DIR, 'node-api') }],
        });
      pgStart = startPostgres();
      redisStart = startRedis();
      const [stackStarted, pgStarted, redisStarted] = await Promise.all([stackStart, pgStart, redisStart]);
      stack = stackStarted;
      postgres = pgStarted;
      redis = redisStarted;

      process.env.NOODARA_MASTER_KEY = masterKey.toString('base64');
      process.env.BETTER_AUTH_SECRET = `soak-${randomUUID()}-${randomUUID()}`;
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
      const queueModule: DeployQueueModule = await import('../../../apps/control-plane/src/queue/deploy-queue.js');
      credentialStore = await import('../../../apps/control-plane/src/services/credential-store.js');
      serviceCredentials = await import('../../../apps/control-plane/src/services/service-credentials.js');

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
      serverId = await insertServer(`soak-host-${ubuntu}`, stack.ssh.host, stack.ssh.port);

      // Runtime: the same wiring src/worker.ts and src/app.ts use, with a no-op publisher and logger.
      const events = {
        publish(_event: ServerEvent): Promise<void> {
          return Promise.resolve();
        },
      };
      const logger = {
        info: (_fields: Record<string, unknown>, _message: string) => undefined,
        warn: (_fields: Record<string, unknown>, _message: string) => undefined,
        error: (_fields: Record<string, unknown>, _message: string) => undefined,
      };
      const baseDeps = runtime.createDeployJobDeps({
        db: db(),
        events,
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
          events,
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
        events,
        panelPorts: [],
        masterKeys: () => Promise.resolve({ current: masterKey }),
        operationQueue: opsQueue,
        remoteCleanup,
      });
      const deploymentApi = deploymentServices.createDeploymentServices({
        db: db(),
        now: () => new Date(),
        events,
        queue: deployQueue,
        logger,
      });
      triggerDeploy = async (serviceId) => {
        const result = await deploymentApi.triggerDeploy({ actor: ACTOR, serviceId });
        return result.ok ? { ok: true, id: result.deployment.id } : { ok: false, code: result.code };
      };

      ({ projectId, environmentId } = await insertProject('Soak'));
      baseline = await settledFootprint();
      baselineWorkspaces = await workspaceListing();
      baselineNetworks = await noodaraNetworks();
      baselineContainers = await noodaraContainers();
      artifact.baseline = parseDf(baseline);
      flushArtifact();
      process.stdout.write(`[soak] Ubuntu ${ubuntu}: writing per-iteration artifact to ${artifactPath}\n`);
    }, STACK_TIMEOUT_MS);

    afterAll(async () => {
      if (artifact.deploys.length > 0 || artifact.cycles.length > 0) {
        flushArtifact();
        process.stdout.write(
          `[soak] Ubuntu ${ubuntu}: artifact ${artifactPath} summary ${JSON.stringify(artifact.summary)}\n`,
        );
      }
      // 14-27: bounded steps; a start still pending when beforeAll timed out is awaited briefly and stopped too.
      const [stk, pg, rd] = await Promise.all([
        stack ?? settleWithin(stackStart, PENDING_START_WAIT_MS),
        postgres ?? settleWithin(pgStart, PENDING_START_WAIT_MS),
        redis ?? settleWithin(redisStart, PENDING_START_WAIT_MS),
      ]);
      await runTeardown(
        `runtime soak (Ubuntu ${ubuntu})`,
        [
          { name: 'worker.close', run: () => worker?.close() },
          { name: 'operationQueue.close', run: () => operationQueue?.close() },
          { name: 'queue.close', run: () => queue?.close() },
          { name: 'disconnect redis connections', run: () => { workerConnection?.disconnect(); queueConnection?.disconnect(); } },
          { name: 'redis.stop', run: () => rd?.stop(), timeoutMs: FIXTURE_STOP_TIMEOUT_MS },
          { name: 'postgres.stop', run: () => pg?.stop(), timeoutMs: FIXTURE_STOP_TIMEOUT_MS },
          { name: 'stack.stop', run: () => stk?.stop(), timeoutMs: STACK_STOP_TIMEOUT_MS },
        ],
        { stepTimeoutMs: TEARDOWN_STEP_TIMEOUT_MS },
      );
    }, STACK_TIMEOUT_MS);

    it(
      `A1/H1: ${String(ITERATIONS)} consecutive node-api deployments through the real worker all end SUCCESS within the deploy max`,
      async () => {
        const service = await insertGitService(PORTS.deploys);
        const deploymentIds: string[] = [];

        for (let iteration = 1; iteration <= ITERATIONS; iteration += 1) {
          const { row, durationMs } = await timedDeploy(service.id);
          deploymentIds.push(row.id);
          artifact.deploys.push({
            iteration,
            deploymentId: row.id,
            status: row.status,
            errorCode: row.errorCode,
            durationMs,
            df: parseDf(await dockerFootprint()),
          });
          flushArtifact();
        }

        // Asserted after the loop so one bad iteration still leaves every other number recorded.
        expect(artifact.deploys.map((entry) => `${String(entry.iteration)}:${entry.status}:${String(entry.errorCode)}`)).toEqual(
          artifact.deploys.map((entry) => `${String(entry.iteration)}:SUCCESS:null`),
        );
        const overLimit = artifact.deploys.filter((entry) => entry.durationMs > DEPLOY_MAX_MS);
        expect(overLimit, `iterations over the ${String(DEPLOY_MAX_MS)}ms deploy max`).toEqual([]);

        artifact.afterDeploys = parseDf(await dockerFootprint());
        flushArtifact();

        await deleteService(service);
        await expectServiceGone(service, deploymentIds);
        await expectAtBaseline();
      },
      SOAK_CASE_TIMEOUT_MS,
    );

    it(
      `A2/H1: ${String(ITERATIONS)} create -> deploy -> delete cycles leave no container, network, image or workspace; df at baseline twice in a row`,
      async () => {
        for (let iteration = 1; iteration <= ITERATIONS; iteration += 1) {
          const cycleStarted = Date.now();
          const service = await insertGitService(PORTS.cycles);
          const { row, durationMs } = await timedDeploy(service.id);
          const deleteStarted = Date.now();
          await deleteService(service);
          const deleteMs = Date.now() - deleteStarted;
          artifact.cycles.push({
            iteration,
            serviceId: service.id,
            deploymentId: row.id,
            status: row.status,
            errorCode: row.errorCode,
            deployMs: durationMs,
            deleteMs,
            cycleMs: Date.now() - cycleStarted,
            df: parseDf(await dockerFootprint()),
          });
          flushArtifact();

          expect({ iteration, status: row.status, errorCode: row.errorCode }).toEqual({
            iteration,
            status: 'SUCCESS',
            errorCode: null,
          });
          expect(durationMs, `cycle ${String(iteration)} deploy exceeded the deploy max`).toBeLessThanOrEqual(DEPLOY_MAX_MS);
          await expectServiceGone(service, [row.id]);
        }

        // Checked twice in a row, with no prune anywhere: the footprint stays at baseline.
        for (let check = 0; check < 2; check += 1) {
          artifact.finalChecks.push(parseDf(await expectAtBaseline()));
          flushArtifact();
        }
      },
      SOAK_CASE_TIMEOUT_MS,
    );
  });
});
