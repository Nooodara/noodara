// 12-11b (A1-A5): the production deploy runtime end to end on the real sshd + dockerd fixture.
// triggerDeploy (Postgres row + BullMQ job) -> startDeployWorker on a real Redis -> the handler built
// by createDeployJobDeps (DB target loader, DB-backed connect with a pinned fingerprint, deploy store)
// -> runDeployment over createSsh2Adapter. Root-side truth comes from `stack.exec` (inspect, ps,
// test -e). Images are compared by RootFS.Layers, never `.Id` (ADR 0008).
// App modules are imported dynamically after a valid test env is written: several of them import
// env.ts, which fail-fasts at import time (INST-06).
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { eq, sql } from 'drizzle-orm';
import { Redis } from 'ioredis';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { deriveDeploymentSteps, type DeploymentStep } from '@noodara/domain/deployment';
import { createRedactor, secretValue } from '@noodara/domain/security';
import { createSsh2Adapter, formatFingerprint } from '@noodara/ssh';
import {
  activityEvents,
  credentials,
  deploymentLogChunks,
  deployments,
  environments,
  projects,
  servers,
  services,
} from '../../../apps/control-plane/src/db/schema/index.js';
import type { ServerEvent } from '../../../apps/control-plane/src/events/server-event-publisher.js';
import type { DeployRunLimits } from '../../../apps/control-plane/src/deploy/run-deployment.js';
import { readDeploymentStepStamps } from '../../../apps/control-plane/src/deploy/deployment-steps-view.js';
import { runMigrations } from '../../../apps/control-plane/src/db/migrate.js';
import { applyMigrationsUpTo } from '../helpers/migrations.js';
import {
  DEPLOY_ENGINE_UBUNTU_VERSIONS,
  GIT_HOST_ALIAS,
  preloadedRefFor,
  resolveBaseImages,
  startDeployEngineStack,
  type DeployEngineStack,
} from '../helpers/deploy-engine.js';
import { fixtureGitHostKey, wrongGitHostKey } from '../helpers/git-host-key.js';
import { startPostgres, type PostgresFixture } from '../helpers/postgres.js';
import { startRedis, type RedisFixture } from '../helpers/redis.js';
import { runTeardown, settleWithin } from '../helpers/teardown.js';

type DeploymentStoreModule = typeof import('../../../apps/control-plane/src/deploy/deployment-store.js');
type BuildCachePruneModule = typeof import('../../../apps/control-plane/src/deploy/build-cache-prune.js');
type DeployRuntimeModule = typeof import('../../../apps/control-plane/src/deploy/deploy-runtime.js');
type DeployWorkerModule = typeof import('../../../apps/control-plane/src/deploy/deploy-worker.js');
type DeploymentServicesModule = typeof import('../../../apps/control-plane/src/services/deployment-services.js');
type DeployQueueModule = typeof import('../../../apps/control-plane/src/queue/deploy-queue.js');
type ServiceCredentialsModule = typeof import('../../../apps/control-plane/src/services/service-credentials.js');
type CredentialStoreModule = typeof import('../../../apps/control-plane/src/services/credential-store.js');
type ServiceServicesModule = typeof import('../../../apps/control-plane/src/services/service-services.js');
type GitHostKeyStoreModule = typeof import('../../../apps/control-plane/src/db/git-host-key-store.js');
type ResetHostKeyCliModule = typeof import('../../../apps/control-plane/src/cli/services-reset-host-key.js');

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES_DIR = path.resolve(HERE, '../../../fixtures');
const STACK_TIMEOUT_MS = 900_000;
// Teardown budget (14-27), inside STACK_TIMEOUT_MS: pending start 180 s + steps x 30 s + db/redis 2 x 60 s + stack stop 300 s.
const PENDING_START_WAIT_MS = 180_000;
const TEARDOWN_STEP_TIMEOUT_MS = 30_000;
const FIXTURE_STOP_TIMEOUT_MS = 60_000;
const STACK_STOP_TIMEOUT_MS = 300_000;
const CASE_TIMEOUT_MS = 600_000;
const TERMINAL_WAIT_MS = 300_000;
const POLL_MS = 500;
const WORKSPACE_ROOT = '/opt/noodara-deploy';
const PORTS = { app: 13_210, squatted: 13_211, image: 13_212 } as const;
const KEY_VERSION = 1;
const DEPLOY_MAX_MS = 300_000;
const TERMINAL = new Set(['SUCCESS', 'FAILED', 'CANCELLED']);

const REPOS = {
  nodeApi: 'node-api',
  failingBuild: 'failing-build',
  multiStage: 'multi-stage',
  silent: 'silent-build',
  chatty: 'chatty-build',
} as const;

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function nodeBaseOf(baseImages: readonly string[]): string {
  const base = baseImages.find((ref) => ref.startsWith('node:'));
  if (base === undefined) throw new Error('harness preloaded no node base image');
  return base;
}

/** Temp build contexts the fixtures/ directory does not carry: a named target, a silent and a chatty build. */
function writeTempRepos(root: string, nodeBase: string): Record<'multiStage' | 'silent' | 'chatty', string> {
  const write = (name: string, dockerfile: string): string => {
    const dir = path.join(root, name);
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, 'Dockerfile'), dockerfile);
    return dir;
  };
  return {
    // Building without `--target app` reaches the `broken` stage and fails: success proves the target.
    multiStage: write(
      REPOS.multiStage,
      [
        `FROM ${nodeBase} AS base`,
        'WORKDIR /app',
        'FROM base AS app',
        'RUN echo app-stage > /app/marker',
        'CMD ["node","-e","setInterval(() => {}, 1000)"]',
        'FROM base AS broken',
        'RUN echo "NOODARA_TARGET_PROOF: the default stage must not build" >&2 && exit 3',
        '',
      ].join('\n'),
    ),
    silent: write(REPOS.silent, [`FROM ${nodeBase}`, 'RUN sleep 311', ''].join('\n')),
    chatty: write(
      REPOS.chatty,
      [
        `FROM ${nodeBase}`,
        'RUN i=0; while [ "$i" -lt 600 ]; do echo "noodara-tick $i"; i=$((i+1)); sleep 0.5; done',
        '',
      ].join('\n'),
    ),
  };
}

interface LoggedLine {
  readonly level: string;
  readonly fields: Record<string, unknown>;
  readonly message: string;
}

describe.each(DEPLOY_ENGINE_UBUNTU_VERSIONS)(
  '12-11b / A1-A5: the deploy worker runs the pipeline on real infrastructure, Ubuntu %s',
  (ubuntu) => {
    let stack: DeployEngineStack | undefined;
    let stackStart: Promise<DeployEngineStack> | undefined;
    let pgStart: Promise<PostgresFixture> | undefined;
    let redisStart: Promise<RedisFixture> | undefined;
    let postgres: PostgresFixture | undefined;
    let redis: RedisFixture | undefined;
    let queueConnection: Redis | undefined;
    let workerConnection: Redis | undefined;
    let pruneConnection: Redis | undefined;
    let buildCachePrune: BuildCachePruneModule;
    let worker: { close(): Promise<void> } | undefined;
    let queue: { close(): Promise<void> } | undefined;
    let tempRoot: string | undefined;
    let triggerDeploy: ((serviceId: string) => Promise<string>) | undefined;
    let serviceCredentials: ServiceCredentialsModule | undefined;

    const masterKey = randomBytes(32);
    const events: ServerEvent[] = [];
    const logged: LoggedLine[] = [];
    const limitOverrides = new Map<string, DeployRunLimits>();
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
    const creds = (): ServiceCredentialsModule => {
      if (serviceCredentials === undefined) throw new Error('modules not loaded');
      return serviceCredentials;
    };
    const root = (argv: readonly string[]) => s().exec(argv, { user: 'root' });
    const rootOut = async (argv: readonly string[]): Promise<string> => (await root(argv)).stdout.trim();
    const exists = async (argv: readonly string[]): Promise<boolean> => (await root(argv)).exitCode === 0;
    const imageExists = (ref: string) => exists(['docker', 'image', 'inspect', ref]);
    const networkExists = (name: string) => exists(['docker', 'network', 'inspect', name]);
    const containerExists = (name: string) => exists(['docker', 'container', 'inspect', name]);
    const pathGone = async (target: string): Promise<boolean> => !(await exists(['test', '-e', target]));
    const layersOf = async (argv: readonly string[]): Promise<string[]> =>
      JSON.parse(await rootOut([...argv, '--format', '{{json .RootFS.Layers}}'])) as string[];
    const containerImageLayers = async (container: string): Promise<string[]> => {
      const imageId = await rootOut(['docker', 'container', 'inspect', container, '--format', '{{.Image}}']);
      return layersOf(['docker', 'image', 'inspect', imageId]);
    };
    const inspectContainer = async (name: string, template: string): Promise<string> =>
      rootOut(['docker', 'container', 'inspect', name, '--format', template]);

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

    const insertRegistryCredential = async (): Promise<string> => {
      const encoded = creds().encodeServiceCredential(
        {
          kind: 'registry',
          host: s().registry.host,
          username: s().registry.username,
          password: secretValue(s().registry.password, 'api_key'),
        },
        { key: masterKey, version: KEY_VERSION },
      );
      return db().transaction((tx) => creds().insertServiceCredential(tx, encoded, new Date()));
    };

    const insertGitService = async (input: {
      readonly repo: string;
      readonly publishedPort: number | null;
      readonly buildTarget?: string;
    }): Promise<string> => {
      const [row] = await db()
        .insert(services)
        .values({
          projectId,
          environmentId,
          serverId,
          name: `svc-${randomUUID().slice(0, 8)}`,
          sourceType: 'git',
          repositoryUrl: s().gitRepoUrl(input.repo),
          branch: 'main',
          buildContext: '.',
          dockerfilePath: 'Dockerfile',
          buildTarget: input.buildTarget ?? null,
          internalPort: 3000,
          publishedPort: input.publishedPort,
          repositoryCredentialId: await insertRepositoryCredential(),
        })
        .returning({ id: services.id });
      if (!row) throw new Error('service insert returned no row');
      return row.id;
    };

    const insertImageService = async (imageRef: string, publishedPort: number): Promise<string> => {
      const [row] = await db()
        .insert(services)
        .values({
          projectId,
          environmentId,
          serverId,
          name: `img-${randomUUID().slice(0, 8)}`,
          sourceType: 'image',
          imageRef,
          internalPort: 80,
          publishedPort,
          registryCredentialId: await insertRegistryCredential(),
        })
        .returning({ id: services.id });
      if (!row) throw new Error('service insert returned no row');
      return row.id;
    };

    const deploymentRow = async (deploymentId: string) => {
      const [row] = await db().select().from(deployments).where(eq(deployments.id, deploymentId));
      if (!row) throw new Error(`deployment ${deploymentId} missing`);
      return row;
    };

    /** 13-03: the timeline the GET views derive, from the stored row. */
    const stepsOf = (row: typeof deployments.$inferSelect): DeploymentStep[] =>
      deriveDeploymentSteps({ ...row, sourceType: (row.source as { sourceType: 'git' | 'image' }).sourceType });
    const stepStates = (row: typeof deployments.$inferSelect): string[] => stepsOf(row).map((step) => step.state);

    /** Triggers through the real API service path and waits for the worker to finish the row. */
    const deploy = async (serviceId: string) => {
      if (triggerDeploy === undefined) throw new Error('runtime not started');
      const deploymentId = await triggerDeploy(serviceId);
      const deadline = Date.now() + TERMINAL_WAIT_MS;
      for (;;) {
        const row = await deploymentRow(deploymentId);
        if (TERMINAL.has(row.status)) return row;
        if (Date.now() > deadline) throw new Error(`deployment ${deploymentId} stuck in ${row.status}`);
        await delay(POLL_MS);
      }
    };

    const deploymentStatuses = (deploymentId: string): string[] =>
      events.flatMap((event) =>
        event.type === 'deployment.updated' && event.deployment.id === deploymentId ? [event.deployment.status] : [],
      );
    const lastServiceStatus = (serviceId: string): string | undefined =>
      events
        .flatMap((event) => (event.type === 'service.updated' && event.service.id === serviceId ? [event.service.status] : []))
        .at(-1);
    const serviceStatus = async (serviceId: string): Promise<string> => {
      const [row] = await db().select({ status: services.status }).from(services).where(eq(services.id, serviceId));
      if (!row) throw new Error('service missing');
      return row.status;
    };

    /** The worker's own edges, in order; QUEUED is published by triggerDeploy and may race the claim. */
    const expectStatusPath = (deploymentId: string, terminal: readonly string[]): void => {
      const statuses = deploymentStatuses(deploymentId);
      expect(statuses).toContain('QUEUED');
      // 13-03: entering the verify step publishes a DEPLOYING update with no status edge; collapse
      // consecutive repeats so the path lists status edges only.
      const edges = statuses.filter((status, i) => status !== 'QUEUED' && status !== statuses[i - 1]);
      expect(edges).toEqual(['PREPARING', ...terminal]);
    };

    /** A1/A5: workspace, its secrets and the registry --config dir are gone on every exit. */
    const expectWorkspaceGone = async (deploymentId: string): Promise<void> => {
      expect(await pathGone(`${WORKSPACE_ROOT}/${deploymentId}`)).toBe(true);
    };

    beforeAll(async () => {
      stackStart = (async () => {
          const base = nodeBaseOf(resolveBaseImages());
          tempRoot = mkdtempSync(path.join(tmpdir(), 'noodara-runtime-pipeline-'));
          const temp = writeTempRepos(tempRoot, base);
          return startDeployEngineStack({
            ubuntu,
            seedRepositories: [
              { name: REPOS.nodeApi, sourceDir: path.join(FIXTURES_DIR, 'node-api') },
              { name: REPOS.failingBuild, sourceDir: path.join(FIXTURES_DIR, 'failing-build') },
              { name: REPOS.multiStage, sourceDir: temp.multiStage },
              { name: REPOS.silent, sourceDir: temp.silent },
              { name: REPOS.chatty, sourceDir: temp.chatty },
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
      process.env.BETTER_AUTH_SECRET = `runtime-pipeline-${randomUUID()}-${randomUUID()}`;
      process.env.DATABASE_URL = postgres.connectionString;
      process.env.REDIS_URL = redis.connectionUrl;
      process.env.NOODARA_PUBLIC_URL = 'http://localhost:3000';

      buildCachePrune = await import('../../../apps/control-plane/src/deploy/build-cache-prune.js');
      const runtime: DeployRuntimeModule = await import('../../../apps/control-plane/src/deploy/deploy-runtime.js');
      const workerModule: DeployWorkerModule = await import('../../../apps/control-plane/src/deploy/deploy-worker.js');
      const deploymentServices: DeploymentServicesModule = await import(
        '../../../apps/control-plane/src/services/deployment-services.js'
      );
      const queueModule: DeployQueueModule = await import('../../../apps/control-plane/src/queue/deploy-queue.js');
      const credentialStore: CredentialStoreModule = await import('../../../apps/control-plane/src/services/credential-store.js');
      serviceCredentials = await import('../../../apps/control-plane/src/services/service-credentials.js');

      // Server row: CONNECTED, Docker present, fingerprint pinned from a first trusted connect.
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
          name: `deploy-host-${ubuntu}`,
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
        .values({ name: 'Runtime pipeline', slug: `runtime-${randomUUID().slice(0, 8)}`, createdAt: now, updatedAt: now })
        .returning({ id: projects.id });
      if (!projectRow) throw new Error('project insert returned no row');
      projectId = projectRow.id;
      const [environmentRow] = await db()
        .insert(environments)
        .values({ projectId, name: 'production', createdAt: now, updatedAt: now })
        .returning({ id: environments.id });
      if (!environmentRow) throw new Error('environment insert returned no row');
      environmentId = environmentRow.id;

      // Runtime: the same wiring src/worker.ts uses, with a recording publisher and logger.
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
      pruneConnection = new Redis(redis.connectionUrl, { maxRetriesPerRequest: null });
      const pruneRedis = buildCachePrune.buildCachePruneRedisFrom(pruneConnection);
      const baseDeps = runtime.createDeployJobDeps({
        db: db(),
        events: recordingEvents,
        ssh: createSsh2Adapter(),
        timeouts: { connectMs: 20_000, commandMs: 60_000, discoveryMs: 120_000 },
        masterKeys: () => Promise.resolve({ current: masterKey }),
        panelPorts: [],
        config: { deployMaxMs: DEPLOY_MAX_MS, idleMs: 120_000, logMaxBytes: 1_048_576, logLineMaxBytes: 16_384 },
        // 14-10: the same wiring as src/worker.ts; the wrapper counts how often the key was taken.
        buildCachePrune: {
          mode: 'on',
          redis: {
            setNxEx: async (key, ttlSeconds) => {
              const taken = await pruneRedis.setNxEx(key, ttlSeconds);
              if (taken) pruneKeysTaken.push(key);
              return taken;
            },
            del: (key) => pruneRedis.del(key),
          },
        },
        logger,
      });
      const defaultHandler = workerModule.createDeployJobHandler(baseDeps);
      const handler = (data: unknown, signal?: AbortSignal) => {
        const serviceId = (data as { serviceId?: unknown } | null)?.serviceId;
        const limits = typeof serviceId === 'string' ? limitOverrides.get(serviceId) : undefined;
        return limits === undefined
          ? defaultHandler(data, signal)
          : workerModule.createDeployJobHandler({ ...baseDeps, limits })(data, signal);
      };

      workerConnection = new Redis(redis.connectionUrl, { maxRetriesPerRequest: null });
      queueConnection = new Redis(redis.connectionUrl, { maxRetriesPerRequest: null });
      worker = runtime.startDeployWorker({
        handler,
        connection: workerConnection,
        concurrency: 2,
        deployMaxMs: DEPLOY_MAX_MS,
        logger,
      });
      const deployQueue = queueModule.createDeployQueue({ connection: queueConnection, enqueueTimeoutMs: 10_000 });
      queue = deployQueue;
      const deploymentApi = deploymentServices.createDeploymentServices({
        db: db(),
        now: () => new Date(),
        events: recordingEvents,
        queue: deployQueue,
        logger,
      });
      triggerDeploy = async (serviceId) => {
        const result = await deploymentApi.triggerDeploy({ actor: { type: 'system' }, serviceId });
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
        `runtime pipeline (Ubuntu ${ubuntu})`,
        [
          { name: 'worker.close', run: () => worker?.close() },
          { name: 'queue.close', run: () => queue?.close() },
          { name: 'disconnect redis connections', run: () => { workerConnection?.disconnect(); pruneConnection?.disconnect(); queueConnection?.disconnect(); } },
          { name: 'redis.stop', run: () => rd?.stop(), timeoutMs: FIXTURE_STOP_TIMEOUT_MS },
          { name: 'postgres.stop', run: () => pg?.stop(), timeoutMs: FIXTURE_STOP_TIMEOUT_MS },
          { name: 'stack.stop', run: () => stk?.stop(), timeoutMs: STACK_STOP_TIMEOUT_MS },
          { name: 'remove temp dir', run: () => { if (tempRoot !== undefined) rmSync(tempRoot, { recursive: true, force: true }); } },
        ],
        { stepTimeoutMs: TEARDOWN_STEP_TIMEOUT_MS },
      );
    }, STACK_TIMEOUT_MS);

    let appServiceId = '';
    const pruneKeysTaken: string[] = [];
    let secondContainerId = '';
    let secondImage = '';

    it('A1/A2/A3/A5: a git deploy clones, builds, replaces the container and removes the superseded image', async () => {
      appServiceId = await insertGitService({ repo: REPOS.nodeApi, publishedPort: PORTS.app });
      const container = `noodara-${appServiceId}`;
      const network = `noodara-net-${appServiceId}`;

      const first = await deploy(appServiceId);
      expect({ status: first.status, errorCode: first.errorCode }).toEqual({ status: 'SUCCESS', errorCode: null });
      // A1: --depth 1 clone, SHA captured from the clone.
      const headSha = (
        await s().exec(['git', '-C', `/srv/git/${REPOS.nodeApi}.git`, 'rev-parse', 'main'], { user: 'git' })
      ).stdout.trim();
      expect(headSha).toMatch(/^[0-9a-f]{40}$/);
      expect(first.commitSha).toBe(headSha);
      const firstImage = `noodara/${appServiceId}:${first.id}`;
      expect(await imageExists(firstImage)).toBe(true);
      // A2: named container on the per-service network, bounded json-file logs, published port live.
      expect(await inspectContainer(container, '{{.State.Running}}')).toBe('true');
      expect(await inspectContainer(container, '{{.Config.Image}}')).toBe(firstImage);
      const networks = JSON.parse(await inspectContainer(container, '{{json .NetworkSettings.Networks}}')) as Record<string, unknown>;
      expect(Object.keys(networks)).toContain(network);
      const logConfig = JSON.parse(await inspectContainer(container, '{{json .HostConfig.LogConfig}}')) as {
        Type: string;
        Config: Record<string, string>;
      };
      expect(logConfig.Config['max-size']).toBeTruthy();
      expect(logConfig.Config['max-file']).toBeTruthy();
      expect(await rootOut(['curl', '-fsS', `http://127.0.0.1:${String(PORTS.app)}/health`])).toBe('ok');
      // A3: every edge through the state machine, the cache recomputed and published.
      expectStatusPath(first.id, ['BUILDING', 'DEPLOYING', 'SUCCESS']);
      // 13-03 A4: four ordered steps, each with a duration, chained boundary to boundary.
      const steps = stepsOf(first);
      expect(steps.map((step) => [step.name, step.state])).toEqual([
        ['clone', 'success'],
        ['build', 'success'],
        ['start', 'success'],
        ['verify', 'success'],
      ]);
      for (const [index, step] of steps.entries()) {
        expect(step.durationMs, step.name).not.toBeNull();
        expect(step.startedAt, step.name).not.toBeNull();
        const next = steps[index + 1];
        if (next) {
          expect(next.startedAt?.getTime()).toBeGreaterThanOrEqual(step.startedAt?.getTime() ?? Infinity);
          expect(step.completedAt).toEqual(next.startedAt);
        }
      }
      expect(steps[0]?.startedAt).toEqual(first.startedAt);
      expect(steps[3]?.completedAt).toEqual(first.completedAt);
      // The GET views read the same boundaries.
      expect((await readDeploymentStepStamps(db(), [first.id])).get(first.id)).toEqual({
        buildingStartedAt: first.buildingStartedAt,
        deployingStartedAt: first.deployingStartedAt,
        verifyingStartedAt: first.verifyingStartedAt,
      });
      expect(await serviceStatus(appServiceId)).toBe('RUNNING');
      expect(lastServiceStatus(appServiceId)).toBe('RUNNING');
      await expectWorkspaceGone(first.id);
      const firstContainerId = await inspectContainer(container, '{{.Id}}');

      const second = await deploy(appServiceId);
      expect({ status: second.status, errorCode: second.errorCode }).toEqual({ status: 'SUCCESS', errorCode: null });
      secondImage = `noodara/${appServiceId}:${second.id}`;
      secondContainerId = await inspectContainer(container, '{{.Id}}');
      expect(secondContainerId).not.toBe(firstContainerId);
      expect(await inspectContainer(container, '{{.Config.Image}}')).toBe(secondImage);
      // A5: the superseded own image is gone once the new container runs; identity by layers, not .Id.
      expect(await imageExists(firstImage)).toBe(false);
      expect(await containerImageLayers(container)).toEqual(await layersOf(['docker', 'image', 'inspect', secondImage]));
      expectStatusPath(second.id, ['BUILDING', 'DEPLOYING', 'SUCCESS']);
      await expectWorkspaceGone(second.id);
    }, CASE_TIMEOUT_MS);

    it('14-10 A3: the build cache prune ran once for two consecutive deployments and left the running container and its image', async () => {
      // The first test deployed twice on one server: SET NX admitted exactly one prune.
      expect(pruneKeysTaken).toEqual([buildCachePrune.buildCachePruneKey(serverId)]);
      const ttl = await queueConnection?.ttl(buildCachePrune.buildCachePruneKey(serverId));
      expect(ttl ?? 0).toBeGreaterThan(0);
      expect(ttl ?? 0).toBeLessThanOrEqual(86_400);
      const container = `noodara-${appServiceId}`;
      expect(await inspectContainer(container, '{{.State.Running}}')).toBe('true');
      expect(await imageExists(secondImage)).toBe(true);
      // Output (cache ids) never reaches the deployment logs or the process logger.
      expect(JSON.stringify(logged)).not.toMatch(/Total reclaimed space|\bdeleted\b/i);
    }, CASE_TIMEOUT_MS);

    it('A4/A5: a failing build ends FAILED/BUILD_FAILED, the previous container keeps running and the partial image is removed', async () => {
      expect(appServiceId).not.toBe('');
      const container = `noodara-${appServiceId}`;
      await db()
        .update(services)
        .set({ repositoryUrl: s().gitRepoUrl(REPOS.failingBuild) })
        .where(eq(services.id, appServiceId));
      try {
        const failed = await deploy(appServiceId);
        expect({ status: failed.status, errorCode: failed.errorCode }).toEqual({ status: 'FAILED', errorCode: 'BUILD_FAILED' });
        expect(failed.errorMessage).not.toContain('NOODARA_FIXTURE_BUILD_FAILURE');
        expectStatusPath(failed.id, ['BUILDING', 'FAILED']);
        // 13-03 A4: the build step failed, the later steps never started.
        expect(stepStates(failed)).toEqual(['success', 'failed', 'pending', 'pending']);
        expect(stepsOf(failed)[1]?.durationMs).not.toBeNull();
        expect(failed.deployingStartedAt).toBeNull();
        expect(failed.verifyingStartedAt).toBeNull();
        expect(await inspectContainer(container, '{{.Id}}')).toBe(secondContainerId);
        expect(await inspectContainer(container, '{{.State.Running}}')).toBe('true');
        expect(await imageExists(secondImage)).toBe(true);
        expect(await imageExists(`noodara/${appServiceId}:${failed.id}`)).toBe(false);
        expect(await serviceStatus(appServiceId)).toBe(lastServiceStatus(appServiceId));
        await expectWorkspaceGone(failed.id);
      } finally {
        await db()
          .update(services)
          .set({ repositoryUrl: s().gitRepoUrl(REPOS.nodeApi) })
          .where(eq(services.id, appServiceId));
      }
    }, CASE_TIMEOUT_MS);

    it('A2: the port preflight reads the real docker ps and fails PORT_IN_USE before touching any container', async () => {
      const squatter = `runtime-squatter-${randomUUID().slice(0, 8)}`;
      const created = await root([
        'docker', 'run', '-d', '--name', squatter,
        '--label', 'noodara.managed=true',
        '--label', `noodara.service_id=${randomUUID()}`,
        '-p', `${String(PORTS.squatted)}:3000`,
        nodeBase, 'sleep', '600',
      ]);
      expect(created.exitCode, created.stderr).toBe(0);
      try {
        const serviceId = await insertGitService({ repo: REPOS.nodeApi, publishedPort: PORTS.squatted });
        const blocked = await deploy(serviceId);
        expect({ status: blocked.status, errorCode: blocked.errorCode }).toEqual({ status: 'FAILED', errorCode: 'PORT_IN_USE' });
        expectStatusPath(blocked.id, ['BUILDING', 'DEPLOYING', 'FAILED']);
        expect(stepStates(blocked)).toEqual(['success', 'success', 'failed', 'pending']);
        expect(await containerExists(`noodara-${serviceId}`)).toBe(false);
        expect(await networkExists(`noodara-net-${serviceId}`)).toBe(false);
        // A5: the built image never got a container, so the ledger removes it.
        expect(await imageExists(`noodara/${serviceId}:${blocked.id}`)).toBe(false);
        expect(await inspectContainer(squatter, '{{.State.Running}}')).toBe('true');
        await expectWorkspaceGone(blocked.id);
      } finally {
        await root(['docker', 'rm', '-f', squatter]);
      }
    }, CASE_TIMEOUT_MS);

    it('A1: a git source with a build target builds only that stage', async () => {
      const serviceId = await insertGitService({ repo: REPOS.multiStage, publishedPort: null, buildTarget: 'app' });
      const done = await deploy(serviceId);
      expect({ status: done.status, errorCode: done.errorCode }).toEqual({ status: 'SUCCESS', errorCode: null });
      const container = `noodara-${serviceId}`;
      expect(await inspectContainer(container, '{{.State.Running}}')).toBe('true');
      expect(await rootOut(['docker', 'exec', container, 'cat', '/app/marker'])).toBe('app-stage');
      await expectWorkspaceGone(done.id);
    }, CASE_TIMEOUT_MS);

    it('A1: an image source pulls from the htpasswd registry with its credential and runs it', async () => {
      const nginx = s().baseImages.find((ref) => ref.startsWith('nginx:'));
      if (nginx === undefined) throw new Error('harness preloaded no nginx base image');
      const imageRef = preloadedRefFor(s().registry.host, nginx);
      const serviceId = await insertImageService(imageRef, PORTS.image);
      const done = await deploy(serviceId);
      expect({ status: done.status, errorCode: done.errorCode }).toEqual({ status: 'SUCCESS', errorCode: null });
      expect(done.commitSha).toBeNull();
      expectStatusPath(done.id, ['BUILDING', 'DEPLOYING', 'SUCCESS']);
      // 13-03: an image source pulls and skips the build.
      expect(stepsOf(done).map((step) => [step.name, step.state])).toEqual([
        ['pull', 'success'],
        ['build', 'skipped'],
        ['start', 'success'],
        ['verify', 'success'],
      ]);
      const container = `noodara-${serviceId}`;
      expect(await inspectContainer(container, '{{.Config.Image}}')).toBe(imageRef);
      expect(await containerImageLayers(container)).toEqual(await layersOf(['docker', 'image', 'inspect', imageRef]));
      expect(await root(['curl', '-fsS', '-o', '/dev/null', `http://127.0.0.1:${String(PORTS.image)}/`])).toMatchObject({ exitCode: 0 });
      // The per-deployment --config dir (registry auth) went with the workspace.
      await expectWorkspaceGone(done.id);
    }, CASE_TIMEOUT_MS);

    it('A5: a container create that fails after the network was created removes the network and the partial image', async () => {
      const serviceId = await insertGitService({ repo: REPOS.nodeApi, publishedPort: null });
      const name = `noodara-${serviceId}`;
      // A foreign, unmanaged container holding the name: invisible to the managed docker ps.
      const foreign = await root(['docker', 'create', '--name', name, nodeBase, 'true']);
      expect(foreign.exitCode, foreign.stderr).toBe(0);
      const foreignId = foreign.stdout.trim();
      try {
        const failed = await deploy(serviceId);
        expect(failed.status).toBe('FAILED');
        expect(failed.errorCode).not.toBeNull();
        expectStatusPath(failed.id, ['BUILDING', 'DEPLOYING', 'FAILED']);
        expect(await networkExists(`noodara-net-${serviceId}`)).toBe(false);
        expect(await imageExists(`noodara/${serviceId}:${failed.id}`)).toBe(false);
        expect(await inspectContainer(name, '{{.Id}}')).toBe(foreignId);
        await expectWorkspaceGone(failed.id);
      } finally {
        await root(['docker', 'rm', '-f', foreignId]);
      }
    }, CASE_TIMEOUT_MS);

    const buildProcessGone = async (marker: string): Promise<boolean> => {
      const deadline = Date.now() + 60_000;
      for (;;) {
        const ps = await rootOut(['sh', '-c', 'ps -eww -o args= | grep -F -- "$0" | grep -v grep || true', marker]);
        if (ps === '') return true;
        if (Date.now() > deadline) return false;
        await delay(1_000);
      }
    };

    it('A4: a silent build hits the idle timeout (BUILD_STALLED) and a chatty one the max timeout (BUILD_TIMEOUT)', async () => {
      const silentId = await insertGitService({ repo: REPOS.silent, publishedPort: null });
      const chattyId = await insertGitService({ repo: REPOS.chatty, publishedPort: null });
      const limits = (await import('../../../apps/control-plane/src/deploy/deploy-runtime.js')).deployRunLimits;
      limitOverrides.set(silentId, {
        ...limits({ deployMaxMs: 240_000, idleMs: 15_000, logMaxBytes: 1_048_576, logLineMaxBytes: 16_384 }),
      });
      limitOverrides.set(chattyId, {
        ...limits({ deployMaxMs: 40_000, idleMs: 20_000, logMaxBytes: 1_048_576, logLineMaxBytes: 16_384 }),
      });

      const [silent, chatty] = await Promise.all([deploy(silentId), deploy(chattyId)]);
      expect({ status: silent.status, errorCode: silent.errorCode }).toEqual({ status: 'FAILED', errorCode: 'BUILD_STALLED' });
      expect({ status: chatty.status, errorCode: chatty.errorCode }).toEqual({ status: 'FAILED', errorCode: 'BUILD_TIMEOUT' });
      for (const [serviceId, row] of [[silentId, silent], [chattyId, chatty]] as const) {
        expectStatusPath(row.id, ['BUILDING', 'FAILED']);
        expect(await imageExists(`noodara/${serviceId}:${row.id}`)).toBe(false);
        expect(await containerExists(`noodara-${serviceId}`)).toBe(false);
        await expectWorkspaceGone(row.id);
      }
      // The interrupted builds were killed, not left running on the server.
      expect(await buildProcessGone('sleep 311')).toBe(true);
      expect(await buildProcessGone('noodara-tick')).toBe(true);
    }, CASE_TIMEOUT_MS);

    // 14-07: blobs of the fixture host key; the security case checks none reached a surface.
    const hostKeyBlobs: string[] = [];
    const gitHostKeyColumns = async (serviceId: string) => {
      const [row] = await db()
        .select({ host: services.gitHostKeyHost, key: services.gitHostKey })
        .from(services)
        .where(eq(services.id, serviceId));
      if (!row) throw new Error('service missing');
      return row;
    };

    it('14-07 A1/A2/A3/H3/H4: first clone pins the host key, later clones verify it, a rotated key fails and the CLI reset re-pins', async () => {
      const fixtureKey = await fixtureGitHostKey(s());
      const wrongKey = wrongGitHostKey();
      hostKeyBlobs.push(fixtureKey.key, wrongKey.key);
      const serviceId = await insertGitService({ repo: REPOS.nodeApi, publishedPort: null });
      expect(await gitHostKeyColumns(serviceId)).toEqual({ host: null, key: null });

      // A1: first clone of the non-bundled host stores its key (TOFU).
      const first = await deploy(serviceId);
      expect({ status: first.status, errorCode: first.errorCode }).toEqual({ status: 'SUCCESS', errorCode: null });
      const pinned = await gitHostKeyColumns(serviceId);
      expect(pinned.host).toBe(GIT_HOST_ALIAS);
      expect(pinned.key).toContain(fixtureKey.key);
      await expectWorkspaceGone(first.id);

      // A1: the second clone pins it and leaves the stored key untouched.
      const second = await deploy(serviceId);
      expect(second.status).toBe('SUCCESS');
      expect(await gitHostKeyColumns(serviceId)).toEqual(pinned);
      await expectWorkspaceGone(second.id);

      // A2/H1: a rotated host key (the stored pin no longer matches the host) fails closed and is
      // never auto-replaced.
      const rotated = `${wrongKey.host} ${wrongKey.type} ${wrongKey.key}`;
      await db().update(services).set({ gitHostKey: rotated }).where(eq(services.id, serviceId));
      const mismatch = await deploy(serviceId);
      expect({ status: mismatch.status, errorCode: mismatch.errorCode }).toEqual({
        status: 'FAILED',
        errorCode: 'GIT_HOST_KEY_MISMATCH',
      });
      expect(mismatch.errorMessage).toContain(`reset-host-key ${serviceId}`);
      // H3: neither the pinned nor the offered key blob is echoed.
      expect(mismatch.errorMessage).not.toContain(fixtureKey.key);
      expect(mismatch.errorMessage).not.toContain(wrongKey.key);
      expect(await gitHostKeyColumns(serviceId)).toEqual({ host: GIT_HOST_ALIAS, key: rotated });
      await expectWorkspaceGone(mismatch.id);

      // A3/H4: the operator CLI forgets the pin; the activity event carries no key material.
      const serviceModule: ServiceServicesModule = await import('../../../apps/control-plane/src/services/service-services.js');
      const cli: ResetHostKeyCliModule = await import('../../../apps/control-plane/src/cli/services-reset-host-key.js');
      const lines: string[] = [];
      const runCli = (id: string) =>
        cli.servicesResetHostKeyCommand({
          serviceId: id,
          reset: (target) => serviceModule.resetGitHostKey(db(), target),
          out: (line) => lines.push(line),
          err: (line) => lines.push(line),
        });
      const activityBefore = await db().select().from(activityEvents);
      expect(await runCli(serviceId)).toBe(0);
      expect(await gitHostKeyColumns(serviceId)).toEqual({ host: null, key: null });
      const activity = (await db().select().from(activityEvents)).filter(
        (row) => !activityBefore.some((before) => before.id === row.id),
      );
      expect(activity).toHaveLength(1);
      expect(activity[0]).toMatchObject({ entityType: 'service', entityId: serviceId, action: 'service.updated' });
      expect(JSON.stringify(activity)).not.toContain(wrongKey.key);
      expect(JSON.stringify(activity)).not.toContain(fixtureKey.key);
      // H4: idempotent on no pin, non-zero without a DB write on a bad or unknown id.
      expect(await runCli(serviceId)).toBe(0);
      expect(await runCli('not-a-uuid')).toBe(2);
      expect(await runCli(randomUUID())).toBe(1);
      expect((await db().select().from(activityEvents)).length).toBe(activityBefore.length + 1);
      expect(lines.join('\n')).not.toContain(fixtureKey.key);

      // H4: the reset takes effect on the next deploy, which re-pins the host's current key.
      const repinned = await deploy(serviceId);
      expect(repinned.status).toBe('SUCCESS');
      const after = await gitHostKeyColumns(serviceId);
      expect(after.host).toBe(GIT_HOST_ALIAS);
      expect(after.key).toContain(fixtureKey.key);
      await expectWorkspaceGone(repinned.id);
    }, CASE_TIMEOUT_MS);

    it('14-07 H1: two concurrent first pins of one host store exactly one key; the loser reads the winner', async () => {
      const storeModule: GitHostKeyStoreModule = await import('../../../apps/control-plane/src/db/git-host-key-store.js');
      const serviceId = await insertGitService({ repo: REPOS.nodeApi, publishedPort: null });
      const fixtureKey = await fixtureGitHostKey(s());
      const wrongKey = wrongGitHostKey();
      const storeA = storeModule.createGitHostKeyStore(db());
      const storeB = storeModule.createGitHostKeyStore(db());
      const results = await Promise.all([
        storeA.pin(serviceId, { host: GIT_HOST_ALIAS, keys: [fixtureKey] }),
        storeB.pin(serviceId, { host: GIT_HOST_ALIAS, keys: [wrongKey] }),
      ]);
      expect(results.map((result) => result.kind).sort()).toEqual(['existing', 'stored']);
      const winner = results[0]?.kind === 'stored' ? fixtureKey : wrongKey;
      const loser = results.find((result) => result.kind === 'existing');
      expect(loser?.kind === 'existing' ? loser.pinned.keys.map((key) => key.key) : []).toEqual([winner.key]);
      const stored = await storeA.load(serviceId);
      expect(stored?.keys.map((key) => key.key)).toEqual([winner.key]);
      // A later pin for the same host never replaces the stored key.
      const again = await storeA.pin(serviceId, { host: GIT_HOST_ALIAS, keys: [winner === fixtureKey ? wrongKey : fixtureKey] });
      expect(again.kind).toBe('existing');
      expect((await storeA.load(serviceId))?.keys.map((key) => key.key)).toEqual([winner.key]);

      // H2: editing the repository URL keeps the pin on the same host and clears it for another one.
      const serviceModule: ServiceServicesModule = await import('../../../apps/control-plane/src/services/service-services.js');
      const api = serviceModule.createServiceServices({
        db: db(),
        now: () => new Date(),
        events: { publish: () => Promise.resolve() },
        panelPorts: [],
        masterKeys: () => Promise.resolve({ current: masterKey }),
      });
      const edit = (repositoryUrl: string) =>
        api.updateService({
          actor: { type: 'system' },
          projectId,
          serviceId,
          fields: { source: { kind: 'git', repositoryUrl, branch: 'main' } },
        });
      // Service edits to a git source require BuildKit on the server; the fixture host has it.
      await db().update(servers).set({ dockerBuildkitAvailable: true }).where(eq(servers.id, serverId));
      const sameHost = await edit(s().gitRepoUrl(REPOS.multiStage));
      expect(sameHost).toMatchObject({ ok: true });
      expect((await gitHostKeyColumns(serviceId)).host).toBe(GIT_HOST_ALIAS);
      const otherHost = await edit('ssh://git@git.other.example:2222/acme/api.git');
      expect(otherHost).toMatchObject({ ok: true });
      expect(await gitHostKeyColumns(serviceId)).toEqual({ host: null, key: null });
    }, CASE_TIMEOUT_MS);

    it('noodara-security: no credential reaches events, logs or deployment rows', async () => {
      const rows = await db().select().from(deployments);
      const surface = JSON.stringify({ events, logged, rows });
      expect(surface).not.toContain(s().registry.password);
      expect(surface).not.toContain(s().deployKey.privateKey.split('\n')[1] ?? s().deployKey.privateKey);
      expect(surface).not.toContain(s().ssh.privateKey.split('\n')[1] ?? s().ssh.privateKey);
      expect(surface).not.toContain(masterKey.toString('base64'));
      // 14-07 H3: no host key blob in events, logs, rows, stored build logs or activity.
      expect(hostKeyBlobs.length).toBeGreaterThan(0);
      const keySurface = JSON.stringify({
        surface,
        chunks: await db().select().from(deploymentLogChunks),
        activity: await db().select().from(activityEvents),
      });
      for (const blob of hostKeyBlobs) expect(keySurface).not.toContain(blob);
    });
  },
);

// 13-03 H3: the step-boundary migration is additive. A database at the previous migration with a
// deployment in flight upgrades through the production migrator; the row keeps null boundaries,
// derives a valid timeline from its status, and the boot sweep's terminal write still works on it.
describe('13-03 H3: step boundaries migrate onto a database with deployments in flight', () => {
  let pg: PostgresFixture | undefined;

  afterAll(async () => {
    await pg?.stop();
  }, STACK_TIMEOUT_MS);

  it('migrates mid-deploy, derives from status alone, and finishes the in-flight row', async () => {
    pg = await startPostgres({ migrate: false });
    const { db } = pg;
    await applyMigrationsUpTo(db, '0005_phase11_deploy_engine');

    const [credential] = await db
      .insert(credentials)
      .values({ type: 'ssh_private_key', encryptedValue: 'not-a-real-ciphertext', keyVersion: KEY_VERSION })
      .returning({ id: credentials.id });
    if (!credential) throw new Error('credential insert returned no row');
    const [server] = await db
      .insert(servers)
      .values({ name: 'legacy-host', host: '203.0.113.10', sshPort: 22, sshUser: 'deployer', credentialId: credential.id })
      .returning({ id: servers.id });
    if (!server) throw new Error('server insert returned no row');
    const now = new Date();
    const [project] = await db
      .insert(projects)
      .values({ name: 'Legacy', slug: `legacy-${randomUUID().slice(0, 8)}`, createdAt: now, updatedAt: now })
      .returning({ id: projects.id });
    if (!project) throw new Error('project insert returned no row');
    const [environment] = await db
      .insert(environments)
      .values({ projectId: project.id, name: 'production', createdAt: now, updatedAt: now })
      .returning({ id: environments.id });
    if (!environment) throw new Error('environment insert returned no row');
    // Raw SQL: the pre-0008 services table has no git host key columns for drizzle's insert to name.
    const service = { id: randomUUID() };
    await db.execute(sql`
      insert into services (id, project_id, environment_id, server_id, name, source_type, repository_url, branch,
                            build_context, dockerfile_path, internal_port, created_at, updated_at)
      values (${service.id}, ${project.id}, ${environment.id}, ${server.id}, 'legacy-api', 'git',
              'https://example.com/acme/api.git', 'main', '.', 'Dockerfile', 3000, now(), now())`);

    // Raw SQL: the pre-13-03 table has no step columns for drizzle's insert to name.
    const source = JSON.stringify({
      sourceType: 'git',
      repositoryUrl: 'https://example.com/acme/api.git',
      branch: 'main',
      buildContext: '.',
      dockerfilePath: 'Dockerfile',
      buildTarget: null,
      imageRef: null,
      internalPort: 3000,
      publishedPort: null,
    });
    const inFlightId = randomUUID();
    const failedId = randomUUID();
    await db.execute(sql`
      insert into deployments (id, service_id, status, source, started_at, created_at, updated_at)
      values (${inFlightId}, ${service.id}, 'BUILDING', ${source}::jsonb, now() - interval '30 seconds', now(), now())`);
    await db.execute(sql`
      insert into deployments (id, service_id, status, source, started_at, completed_at, duration_ms, error_code, error_message, created_at, updated_at)
      values (${failedId}, ${service.id}, 'FAILED', ${source}::jsonb, now() - interval '2 minutes', now() - interval '1 minute',
              60000, 'BUILD_FAILED', 'The Docker build failed.', now() - interval '2 minutes', now())`);

    // Boot: the production migrator applies only what is missing.
    await runMigrations(db);

    const rowOf = async (id: string) => {
      const [row] = await db.select().from(deployments).where(eq(deployments.id, id));
      if (!row) throw new Error(`deployment ${id} missing`);
      return row;
    };
    const statesOf = (row: typeof deployments.$inferSelect): string[] =>
      deriveDeploymentSteps({ ...row, sourceType: 'git' }).map((step) => step.state);

    const inFlight = await rowOf(inFlightId);
    expect([inFlight.buildingStartedAt, inFlight.deployingStartedAt, inFlight.verifyingStartedAt]).toEqual([null, null, null]);
    expect(statesOf(inFlight)).toEqual(['success', 'running', 'pending', 'pending']);
    expect(statesOf(await rowOf(failedId))).toEqual(['success', 'failed', 'pending', 'pending']);
    const stamps = await readDeploymentStepStamps(db, [inFlightId, failedId]);
    expect(stamps.get(inFlightId)).toEqual({ buildingStartedAt: null, deployingStartedAt: null, verifyingStartedAt: null });

    // The boot sweep's write path: in-flight rows end WORKER_CRASHED without throwing.
    process.env.NOODARA_MASTER_KEY ??= randomBytes(32).toString('base64');
    process.env.BETTER_AUTH_SECRET ??= `runtime-pipeline-${randomUUID()}-${randomUUID()}`;
    process.env.DATABASE_URL ??= pg.connectionString;
    process.env.REDIS_URL ??= 'redis://127.0.0.1:6379';
    process.env.NOODARA_PUBLIC_URL ??= 'http://localhost:3000';
    const storeModule: DeploymentStoreModule = await import('../../../apps/control-plane/src/deploy/deployment-store.js');
    const store = storeModule.createDeploymentStore({ db, now: () => new Date(), events: { publish: () => Promise.resolve() } });
    const swept = await store.inFlight();
    expect(swept.map((row) => row.deploymentId)).toEqual([inFlightId]);
    await store.finish(inFlightId, {
      status: 'FAILED',
      errorCode: 'WORKER_CRASHED',
      errorMessage: 'The deploy worker stopped before this deployment finished.',
      commitSha: null,
      container: null,
    });
    const finished = await rowOf(inFlightId);
    expect(finished.status).toBe('FAILED');
    const timeline = deriveDeploymentSteps({ ...finished, sourceType: 'git' });
    expect(timeline).toHaveLength(4);
    expect(timeline.filter((step) => step.state === 'running')).toEqual([]);
  }, CASE_TIMEOUT_MS);
});

// 14-07 H2: the git host key columns are additive and nullable. A database at the previous
// migration with an existing ssh service upgrades cleanly; the service has no pin and the store
// treats it as a first clone.
describe('14-07 H2: git host key columns migrate onto a database with existing services', () => {
  let pg: PostgresFixture | undefined;

  afterAll(async () => {
    await pg?.stop();
  }, STACK_TIMEOUT_MS);

  it('applies 0008 over existing services, which load no pinned key', async () => {
    pg = await startPostgres({ migrate: false });
    const { db } = pg;
    await applyMigrationsUpTo(db, '0007_phase14_git_host_key_codes');

    const [credential] = await db
      .insert(credentials)
      .values({ type: 'ssh_private_key', encryptedValue: 'not-a-real-ciphertext', keyVersion: KEY_VERSION })
      .returning({ id: credentials.id });
    if (!credential) throw new Error('credential insert returned no row');
    const [server] = await db
      .insert(servers)
      .values({ name: 'legacy-host', host: '203.0.113.11', sshPort: 22, sshUser: 'deployer', credentialId: credential.id })
      .returning({ id: servers.id });
    if (!server) throw new Error('server insert returned no row');
    const now = new Date();
    const [project] = await db
      .insert(projects)
      .values({ name: 'Legacy', slug: `legacy-${randomUUID().slice(0, 8)}`, createdAt: now, updatedAt: now })
      .returning({ id: projects.id });
    if (!project) throw new Error('project insert returned no row');
    const [environment] = await db
      .insert(environments)
      .values({ projectId: project.id, name: 'production', createdAt: now, updatedAt: now })
      .returning({ id: environments.id });
    if (!environment) throw new Error('environment insert returned no row');
    // Raw SQL: the pre-0008 table has no git host key columns for drizzle's insert to name.
    const serviceId = randomUUID();
    await db.execute(sql`
      insert into services (id, project_id, environment_id, server_id, name, source_type, repository_url, branch,
                            build_context, dockerfile_path, internal_port, created_at, updated_at)
      values (${serviceId}, ${project.id}, ${environment.id}, ${server.id}, 'legacy-ssh', 'git',
              'git@git.example.com:acme/api.git', 'main', '.', 'Dockerfile', 3000, now(), now())`);

    await runMigrations(db);

    const [row] = await db
      .select({ host: services.gitHostKeyHost, key: services.gitHostKey, name: services.name })
      .from(services)
      .where(eq(services.id, serviceId));
    expect(row).toEqual({ host: null, key: null, name: 'legacy-ssh' });

    process.env.NOODARA_MASTER_KEY ??= randomBytes(32).toString('base64');
    process.env.BETTER_AUTH_SECRET ??= `runtime-pipeline-${randomUUID()}-${randomUUID()}`;
    process.env.DATABASE_URL ??= pg.connectionString;
    process.env.REDIS_URL ??= 'redis://127.0.0.1:6379';
    process.env.NOODARA_PUBLIC_URL ??= 'http://localhost:3000';
    const storeModule: GitHostKeyStoreModule = await import('../../../apps/control-plane/src/db/git-host-key-store.js');
    expect(await storeModule.createGitHostKeyStore(db).load(serviceId)).toBeNull();

    // The pair check rejects a half-written pin.
    await expect(
      db.execute(sql`update services set git_host_key_host = 'git.example.com' where id = ${serviceId}`),
    ).rejects.toThrow();
  }, CASE_TIMEOUT_MS);
});
