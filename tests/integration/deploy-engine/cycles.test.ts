// 20-02: 100 deploy/rollback cycles on the real sshd + dockerd fixture, through the production
// path: webhook ingest / deployment services -> BullMQ on a real Redis -> the deploy worker -> the
// DB-backed log sink. After one priming push the cycles alternate:
//   good       a new commit pushed and delivered as a signed GitHub webhook -> SUCCESS
//   unhealthy  the service switched to unhealthy-api on /healthz, manual deploy -> ROLLED_BACK
//              (HEALTHCHECK_FAILED, the previous version restored automatically), then switched back
//   manual     triggerRollback to the good deployment before the running one -> SUCCESS, no build
// The manual rollback names its target explicitly (the good deployment before the running one),
// so each cycle exercises the same edge instead of depending on how the default target walks
// earlier rollback rows.
//
// Checked afterwards (A1, A2, H1):
// - one deployments row per request, every row terminal, every published status sequence valid
//   when replayed through transitionDeployment (a status announced twice in a row is one state;
//   the row is inserted QUEUED, so a missing QUEUED event is the insert);
// - deployment_log_chunks: every chunk each deployment's sink produced is exactly one row (none
//   dropped, failed, duplicated or foreign); webhook_deliveries: one `deployed` row per push;
// - on the deploy host: one service container, no -prev container, no extra container, network
//   or volume, an empty workspace root, the service images equal to the retention set the API
//   derives (imageRetention over the SUCCESS rows), the non-service image set unchanged since the
//   warm-up, and docker system df stable: Containers and Local Volumes back at baseline (+1 for the
//   service container), Images size within DF_IMAGES_GROWTH_BOUND_BYTES of the post-warm-up
//   reference. Build cache is excluded (BuildKit-owned, DECISIONS 2026-10-05);
// - no iteration over NOODARA_DEPLOY_MAX_MS (default 300000).
// Per-iteration duration and docker system df go to a JSON artifact rewritten after every
// iteration, in NOODARA_CYCLES_ARTIFACT_DIR (default <os tmpdir>/noodara-cycles-artifacts).
//
// Opt-in: without NOODARA_STRESS=1 the suite reports as skipped. Run it with:
//   NOODARA_STRESS=1 NOODARA_TEST_UBUNTU=24.04 pnpm exec vitest run --config vitest.integration.config.ts tests/integration/deploy-engine/cycles.test.ts
// NOODARA_CYCLES (default 100, minimum 3) shortens a local smoke run; nightly uses the default.
//
// App modules are imported dynamically after a valid test env is written: several of them import
// env.ts, which fail-fasts at import time (INST-06).
import { createHmac, randomBytes, randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { and, desc, eq, sql } from 'drizzle-orm';
import { Redis } from 'ioredis';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  DEFAULT_IMAGE_RETENTION,
  TERMINAL_DEPLOYMENT_STATUSES,
  imageRetention,
  type DeploymentStatus,
  type HealthcheckConfig,
} from '@noodara/domain/deployment';
import { createRedactor, revealSecret, secretValue } from '@noodara/domain/security';
import { createSsh2Adapter, formatFingerprint } from '@noodara/ssh';
import {
  credentials,
  deploymentLogChunks,
  deployments,
  environments,
  projects,
  servers,
  services,
  webhookDeliveries,
} from '../../../apps/control-plane/src/db/schema/index.js';
import type { ServerEvent } from '../../../apps/control-plane/src/events/server-event-publisher.js';
import type { DeploymentLogChunkWriter } from '../../../apps/control-plane/src/deploy/log-sink.js';
import {
  DEPLOY_ENGINE_UBUNTU_VERSIONS,
  startDeployEngineStack,
  type DeployEngineStack,
} from '../helpers/deploy-engine.js';
import {
  DF_FORMAT,
  dfRow,
  extraEntries,
  parseDf,
  reconcileLogChunks,
  reconcileWebhookDeliveries,
  replayDeploymentStatuses,
  type DfRow,
  type LogLedgerEntry,
} from '../helpers/deploy-cycles.js';
import { startPostgres, type PostgresFixture } from '../helpers/postgres.js';
import { startRedis, type RedisFixture } from '../helpers/redis.js';
import { runTeardown, settleWithin } from '../helpers/teardown.js';

type DeployRuntimeModule = typeof import('../../../apps/control-plane/src/deploy/deploy-runtime.js');
type DeployWorkerModule = typeof import('../../../apps/control-plane/src/deploy/deploy-worker.js');
type DeploymentStoreModule = typeof import('../../../apps/control-plane/src/deploy/deployment-store.js');
type LogSinkModule = typeof import('../../../apps/control-plane/src/deploy/log-sink.js');
type DeploymentServicesModule = typeof import('../../../apps/control-plane/src/services/deployment-services.js');
type DeploymentServices = ReturnType<DeploymentServicesModule['createDeploymentServices']>;
type DeployQueueModule = typeof import('../../../apps/control-plane/src/queue/deploy-queue.js');
type ServiceCredentialsModule = typeof import('../../../apps/control-plane/src/services/service-credentials.js');
type CredentialStoreModule = typeof import('../../../apps/control-plane/src/services/credential-store.js');
type WebhookConfigModule = typeof import('../../../apps/control-plane/src/services/webhook-config.js');
type WebhookIngestModule = typeof import('../../../apps/control-plane/src/services/webhook-ingest.js');
type WebhookIngest = ReturnType<WebhookIngestModule['createWebhookIngest']>;

function envFlag(name: string): boolean {
  const value = process.env[name];
  return value === '1' || value === 'true';
}

function envInt(name: string, fallback: number, min: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < min) throw new Error(`${name} must be an integer >= ${String(min)}, got "${raw}"`);
  return value;
}

const STRESS_ENABLED = envFlag('NOODARA_STRESS');
const CYCLES = envInt('NOODARA_CYCLES', 100, 3);
const DEPLOY_MAX_MS = envInt('NOODARA_DEPLOY_MAX_MS', 300_000, 1_000);
const ARTIFACT_DIR = process.env['NOODARA_CYCLES_ARTIFACT_DIR'] ?? path.join(tmpdir(), 'noodara-cycles-artifacts');

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES_DIR = path.resolve(HERE, '../../../fixtures');
const STACK_TIMEOUT_MS = 900_000;
// Teardown budget (14-27), inside STACK_TIMEOUT_MS.
const PENDING_START_WAIT_MS = 180_000;
const TEARDOWN_STEP_TIMEOUT_MS = 30_000;
const FIXTURE_STOP_TIMEOUT_MS = 60_000;
const STACK_STOP_TIMEOUT_MS = 300_000;
/** Past the worker's own deploy max, so an over-long iteration is measured instead of abandoned. */
const WAIT_MS = DEPLOY_MAX_MS + 60_000;
/** A healthy iteration takes 10-30 s; this only bounds a run that is wedged on every iteration. */
const CASE_TIMEOUT_MS = (CYCLES + 1) * 90_000 + 600_000;
const POLL_MS = 500;
const KEY_VERSION = 1;
const WORKSPACE_ROOT = '/home/deployer/.noodara/deploy';
const PUBLIC_ORIGIN = 'http://localhost:3000';
const REPOS = { healthy: 'node-api', unhealthy: 'unhealthy-api' } as const;
const USER = { type: 'user', id: randomUUID() } as const;
const JOB_ACTOR = { type: 'system' } as const;
/**
 * A2's documented df bound: the retention set holds at most 1 + DEFAULT_IMAGE_RETENTION images of
 * one fixture sharing their base layers, so after the warm-up only per-build app layers can move
 * the Images size. 128 MB is far above that noise and far below one leaked base image per cycle.
 */
const DF_IMAGES_GROWTH_BOUND_BYTES = 128 * 1024 * 1024;
/** Iteration after which the retention set is full (prime + 3 good deploys). */
const WARMUP_INDEX = Math.min(CYCLES - 1, 8);
const TERMINAL: ReadonlySet<string> = new Set(TERMINAL_DEPLOYMENT_STATUSES);

const HEALTHY_CHECK: HealthcheckConfig = {
  type: 'http',
  path: '/health',
  port: 3000,
  expectedStatuses: [200],
  probeTimeoutS: 2,
  intervalS: 1,
  retries: 3,
  startPeriodS: 10,
};
const UNHEALTHY_CHECK: HealthcheckConfig = { ...HEALTHY_CHECK, path: '/healthz' };

type CycleKind = 'prime' | 'good' | 'unhealthy' | 'manual';
const CYCLE_KINDS = ['good', 'unhealthy', 'manual'] as const;

interface Request {
  readonly iteration: number;
  readonly kind: CycleKind;
  readonly deploymentId: string;
  readonly deliveryId: string | null;
}

interface IterationRecord {
  readonly iteration: number;
  readonly kind: CycleKind;
  readonly deploymentId: string;
  readonly status: string;
  readonly errorCode: string | null;
  readonly durationMs: number;
  readonly df: DfRow[];
}

interface CyclesArtifact {
  readonly ubuntu: string;
  readonly startedAt: string;
  readonly cycles: number;
  readonly deployMaxMs: number;
  readonly dfImagesGrowthBoundBytes: number;
  baseline: DfRow[];
  readonly iterations: IterationRecord[];
  final: DfRow[];
  summary: Record<string, number>;
  problems: string[];
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function percentile(values: readonly number[], p: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[index] ?? 0;
}

const lines = (raw: string): string[] =>
  raw
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '');

describe.skipIf(!STRESS_ENABLED)(`20-02 stress: ${String(CYCLES)} deploy/rollback cycles`, () => {
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
    let api: DeploymentServices | undefined;
    let ingest: WebhookIngest | undefined;
    let webhookConfig: WebhookConfigModule | undefined;
    let serviceCredentials: ServiceCredentialsModule | undefined;
    let projectId = '';
    let environmentId = '';
    let serverId = '';

    const masterKey = randomBytes(32);
    /** deployment.updated statuses per deployment, in publish order (with the row's updatedAt). */
    const published = new Map<string, { status: DeploymentStatus; updatedAt: string }[]>();
    const inserted = new Map<string, number>();
    const ledger = new Map<string, LogLedgerEntry>();
    const sinksOpened = new Map<string, number>();
    const closed = new Map<string, { promise: Promise<void>; resolve: () => void }>();
    const warnings: string[] = [];

    const artifactPath = path.join(ARTIFACT_DIR, `cycles-ubuntu-${ubuntu}.json`);
    const artifact: CyclesArtifact = {
      ubuntu,
      startedAt: new Date().toISOString(),
      cycles: CYCLES,
      deployMaxMs: DEPLOY_MAX_MS,
      dfImagesGrowthBoundBytes: DF_IMAGES_GROWTH_BOUND_BYTES,
      baseline: [],
      iterations: [],
      final: [],
      summary: {},
      problems: [],
    };
    /** Rewritten after every iteration so a run that dies midway still leaves its numbers. */
    const flushArtifact = (): void => {
      const durations = artifact.iterations.map((entry) => entry.durationMs);
      artifact.summary = {
        iterations: artifact.iterations.length,
        p50Ms: percentile(durations, 50),
        p95Ms: percentile(durations, 95),
        maxMs: durations.length === 0 ? 0 : Math.max(...durations),
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
    const services$ = (): DeploymentServices => {
      if (api === undefined) throw new Error('deployment services not started');
      return api;
    };
    const rootOut = async (argv: readonly string[]): Promise<string> => {
      const result = await s().exec(argv, { user: 'root' });
      if (result.exitCode !== 0) throw new Error(`${argv.join(' ')} exited ${String(result.exitCode)}: ${result.stderr}`);
      return result.stdout.trim();
    };
    const df = async (): Promise<DfRow[]> => parseDf(await rootOut(['docker', 'system', 'df', '--format', DF_FORMAT]));
    const containerNames = async (): Promise<string[]> =>
      lines(await rootOut(['docker', 'ps', '--all', '--format', '{{.Names}}'])).sort();
    const networkNames = async (): Promise<string[]> =>
      lines(await rootOut(['docker', 'network', 'ls', '--format', '{{.Name}}'])).sort();
    const volumeNames = async (): Promise<string[]> =>
      lines(await rootOut(['docker', 'volume', 'ls', '--format', '{{.Name}}'])).sort();
    /** id + repo:tag of every image, untagged ones included. */
    const imageList = async (): Promise<{ id: string; ref: string }[]> =>
      lines(await rootOut(['docker', 'image', 'ls', '--all', '--no-trunc', '--format', '{{.ID}} {{.Repository}}:{{.Tag}}'])).map(
        (line) => {
          const [id = '', ref = ''] = line.split(' ');
          return { id, ref };
        },
      );
    const serviceRepo = (serviceId: string) => `noodara/${serviceId}`;
    const nonServiceImageIds = async (serviceId: string): Promise<string[]> => {
      const images = await imageList();
      const serviceIds = new Set(images.filter((image) => image.ref.startsWith(`${serviceRepo(serviceId)}:`)).map((image) => image.id));
      return [...new Set(images.map((image) => image.id).filter((id) => !serviceIds.has(id)))].sort();
    };
    const serviceImageRefs = async (serviceId: string): Promise<string[]> =>
      lines(await rootOut(['docker', 'image', 'ls', '--format', '{{.Repository}}:{{.Tag}}', serviceRepo(serviceId)])).sort();

    const closedFor = (deploymentId: string) => {
      let entry = closed.get(deploymentId);
      if (entry === undefined) {
        let resolve: () => void = () => undefined;
        const promise = new Promise<void>((done) => {
          resolve = done;
        });
        entry = { promise, resolve };
        closed.set(deploymentId, entry);
      }
      return entry;
    };

    const deploymentRow = async (deploymentId: string) => {
      const [row] = await db().select().from(deployments).where(eq(deployments.id, deploymentId));
      if (!row) throw new Error(`deployment ${deploymentId} missing`);
      return row;
    };

    /** Terminal row and the sink closed: the job finished its cleanup, retention included. */
    const settle = async (deploymentId: string) => {
      const deadline = Date.now() + WAIT_MS;
      const sinkClosed = closedFor(deploymentId).promise;
      for (;;) {
        const row = await deploymentRow(deploymentId);
        if (TERMINAL.has(row.status)) {
          const left = Math.max(1, deadline - Date.now());
          let timer: ReturnType<typeof setTimeout> | undefined;
          await Promise.race([
            sinkClosed,
            new Promise<never>((_resolve, reject) => {
              timer = setTimeout(() => reject(new Error(`deployment ${deploymentId}: log sink never closed`)), left);
            }),
          ]).finally(() => clearTimeout(timer));
          return row;
        }
        if (Date.now() > deadline) throw new Error(`deployment ${deploymentId} stuck in ${row.status}`);
        await delay(POLL_MS);
      }
    };

    const insertService = async (): Promise<string> => {
      if (serviceCredentials === undefined) throw new Error('runtime not started');
      const encoded = serviceCredentials.encodeServiceCredential(
        {
          kind: 'deploy_key',
          privateKey: secretValue(s().deployKey.privateKey, 'ssh_private_key'),
          publicKey: s().deployKey.publicKey,
        },
        { key: masterKey, version: KEY_VERSION },
      );
      const creds = serviceCredentials;
      const credentialId = await db().transaction((tx) => creds.insertServiceCredential(tx, encoded, new Date()));
      const [row] = await db()
        .insert(services)
        .values({
          projectId,
          environmentId,
          serverId,
          name: `cycles-${randomUUID().slice(0, 8)}`,
          sourceType: 'git',
          repositoryUrl: s().gitRepoUrl(REPOS.healthy),
          branch: 'main',
          buildContext: '.',
          dockerfilePath: 'Dockerfile',
          buildTarget: null,
          internalPort: 3000,
          publishedPort: null,
          repositoryCredentialId: credentialId,
          healthcheck: HEALTHY_CHECK,
          autoRollback: true,
        })
        .returning({ id: services.id });
      if (!row) throw new Error('service insert returned no row');
      return row.id;
    };

    const setSource = async (serviceId: string, repo: string, healthcheck: HealthcheckConfig): Promise<void> => {
      await db().update(services).set({ repositoryUrl: s().gitRepoUrl(repo), healthcheck }).where(eq(services.id, serviceId));
    };

    /** A new commit on main with the same tree: a push the webhook dedupe never drops as already deployed. */
    const pushCommit = async (label: string): Promise<string> => {
      const repo = `/srv/git/${REPOS.healthy}.git`;
      const git = async (args: readonly string[]): Promise<string> => {
        const result = await s().exec(['git', '-C', repo, '-c', 'user.name=Noodara Stress', '-c', 'user.email=stress@noodara.test', ...args], {
          user: 'git',
        });
        if (result.exitCode !== 0) throw new Error(`git ${args.join(' ')} exited ${String(result.exitCode)}: ${result.stderr}`);
        return result.stdout.trim();
      };
      const sha = await git(['commit-tree', 'main^{tree}', '-p', 'main', '-m', `stress ${label}`]);
      await git(['update-ref', 'refs/heads/main', sha]);
      return sha;
    };

    beforeAll(async () => {
      flushArtifact();
      stackStart = startDeployEngineStack({
        ubuntu,
        seedRepositories: [
          { name: REPOS.healthy, sourceDir: path.join(FIXTURES_DIR, 'node-api') },
          { name: REPOS.unhealthy, sourceDir: path.join(FIXTURES_DIR, 'unhealthy-api') },
        ],
      });
      pgStart = startPostgres();
      redisStart = startRedis();
      const [stackStarted, pgStarted, redisStarted] = await Promise.all([stackStart, pgStart, redisStart]);
      stack = stackStarted;
      postgres = pgStarted;
      redis = redisStarted;

      process.env.NOODARA_MASTER_KEY = masterKey.toString('base64');
      process.env.BETTER_AUTH_SECRET = `cycles-${randomUUID()}-${randomUUID()}`;
      process.env.DATABASE_URL = postgres.connectionString;
      process.env.REDIS_URL = redis.connectionUrl;
      process.env.NOODARA_PUBLIC_URL = PUBLIC_ORIGIN;

      const runtime: DeployRuntimeModule = await import('../../../apps/control-plane/src/deploy/deploy-runtime.js');
      const workerModule: DeployWorkerModule = await import('../../../apps/control-plane/src/deploy/deploy-worker.js');
      const storeModule: DeploymentStoreModule = await import('../../../apps/control-plane/src/deploy/deployment-store.js');
      const logSink: LogSinkModule = await import('../../../apps/control-plane/src/deploy/log-sink.js');
      const deploymentServices: DeploymentServicesModule = await import(
        '../../../apps/control-plane/src/services/deployment-services.js'
      );
      const queueModule: DeployQueueModule = await import('../../../apps/control-plane/src/queue/deploy-queue.js');
      const credentialStore: CredentialStoreModule = await import('../../../apps/control-plane/src/services/credential-store.js');
      const ingestModule: WebhookIngestModule = await import('../../../apps/control-plane/src/services/webhook-ingest.js');
      serviceCredentials = await import('../../../apps/control-plane/src/services/service-credentials.js');
      webhookConfig = await import('../../../apps/control-plane/src/services/webhook-config.js');

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
          name: `cycles-host-${ubuntu}`,
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
        .values({ name: 'Cycles', slug: `cycles-${randomUUID().slice(0, 8)}`, createdAt: now, updatedAt: now })
        .returning({ id: projects.id });
      if (!projectRow) throw new Error('project insert returned no row');
      projectId = projectRow.id;
      const [environmentRow] = await db()
        .insert(environments)
        .values({ projectId, name: 'production', createdAt: now, updatedAt: now })
        .returning({ id: environments.id });
      if (!environmentRow) throw new Error('environment insert returned no row');
      environmentId = environmentRow.id;

      const events = {
        publish(event: ServerEvent): Promise<void> {
          if (event.type === 'deployment.updated') {
            const list = published.get(event.deployment.id) ?? [];
            list.push({ status: event.deployment.status, updatedAt: event.deployment.updatedAt });
            published.set(event.deployment.id, list);
          }
          return Promise.resolve();
        },
      };
      const logger = {
        info: () => undefined,
        warn: (_fields: Record<string, unknown>, message: string) => void warnings.push(message),
        error: (_fields: Record<string, unknown>, message: string) => void warnings.push(message),
      };

      // H1: the production DB writer, counting the rows it inserted without an error.
      const dbWriter = logSink.createDbLogChunkWriter(db());
      const countingWriter: DeploymentLogChunkWriter = {
        async insert(row) {
          await dbWriter.insert(row);
          inserted.set(row.deploymentId, (inserted.get(row.deploymentId) ?? 0) + 1);
        },
      };
      const sinkFactory = logSink.createDeploymentLogSinkFactory({
        writer: countingWriter,
        events,
        logger,
        policy: { flushIntervalMs: 250, flushBytes: 16_384, maxLineBytes: 16_384, maxPhaseBytes: 10_485_760 },
      });
      const deps = runtime.createDeployJobDeps({
        db: db(),
        events,
        ssh: createSsh2Adapter(),
        timeouts: { connectMs: 20_000, commandMs: 60_000, discoveryMs: 120_000 },
        masterKeys: () => Promise.resolve({ current: masterKey }),
        panelPorts: [],
        config: { deployMaxMs: DEPLOY_MAX_MS, idleMs: 120_000, logMaxBytes: 10_485_760, logLineMaxBytes: 16_384 },
        logger,
      });
      const handler = workerModule.createDeployJobHandler({
        ...deps,
        sinkFor: (deploymentId) => {
          sinksOpened.set(deploymentId, (sinksOpened.get(deploymentId) ?? 0) + 1);
          const sink = sinkFactory(deploymentId);
          return {
            write: (entry) => sink.write(entry),
            close: async () => {
              await sink.close();
              const stats = sink.stats();
              ledger.set(deploymentId, {
                inserted: inserted.get(deploymentId) ?? 0,
                persistedChunks: stats.persistedChunks,
                droppedChunks: stats.droppedChunks,
                persistFailures: stats.persistFailures,
              });
              closedFor(deploymentId).resolve();
            },
          };
        },
      });

      workerConnection = new Redis(redis.connectionUrl, { maxRetriesPerRequest: null });
      queueConnection = new Redis(redis.connectionUrl, { maxRetriesPerRequest: null });
      worker = runtime.startDeployWorker({ handler, connection: workerConnection, concurrency: 2, deployMaxMs: DEPLOY_MAX_MS, logger });
      const deployQueue = queueModule.createDeployQueue({ connection: queueConnection, enqueueTimeoutMs: 10_000 });
      queue = deployQueue;
      api = deploymentServices.createDeploymentServices({ db: db(), now: () => new Date(), events, queue: deployQueue, logger });
      const store = storeModule.createDeploymentStore({ db: db(), now: () => new Date(), events });
      ingest = ingestModule.createWebhookIngest({
        db: db(),
        now: () => new Date(),
        events,
        queue: deployQueue,
        masterKeys: () => Promise.resolve({ current: masterKey }),
        failUnqueued: (deploymentId, cutoff) => store.failStaleQueued(deploymentId, cutoff),
        logger,
      });
    }, STACK_TIMEOUT_MS);

    afterAll(async () => {
      flushArtifact();
      const [stk, pg, rd] = await Promise.all([
        stack ?? settleWithin(stackStart, PENDING_START_WAIT_MS),
        postgres ?? settleWithin(pgStart, PENDING_START_WAIT_MS),
        redis ?? settleWithin(redisStart, PENDING_START_WAIT_MS),
      ]);
      await runTeardown(
        `deploy cycles (Ubuntu ${ubuntu})`,
        [
          { name: 'worker.close', run: () => worker?.close() },
          { name: 'queue.close', run: () => queue?.close() },
          {
            name: 'disconnect redis connections',
            run: () => {
              workerConnection?.disconnect();
              queueConnection?.disconnect();
            },
          },
          { name: 'redis.stop', run: () => rd?.stop(), timeoutMs: FIXTURE_STOP_TIMEOUT_MS },
          { name: 'postgres.stop', run: () => pg?.stop(), timeoutMs: FIXTURE_STOP_TIMEOUT_MS },
          { name: 'stack.stop', run: () => stk?.stop(), timeoutMs: STACK_STOP_TIMEOUT_MS },
        ],
        { stepTimeoutMs: TEARDOWN_STEP_TIMEOUT_MS },
      );
    }, STACK_TIMEOUT_MS);

    it(
      `A1/A2/H1: ${String(CYCLES)} cycles leave one row per request, valid status paths, no lost records and no orphans`,
      async () => {
        if (ingest === undefined || webhookConfig === undefined) throw new Error('runtime not started');
        const hooks = ingest;
        const serviceId = await insertService();
        const container = `noodara-${serviceId}`;
        const network = `noodara-net-${serviceId}`;
        const imageOf = (deploymentId: string) => `${serviceRepo(serviceId)}:${deploymentId}`;

        const enabled = await webhookConfig.enableWebhook(
          { db: db(), now: () => new Date(), masterKeys: () => Promise.resolve({ current: masterKey }), publicOrigin: PUBLIC_ORIGIN },
          { actor: JOB_ACTOR, projectId, serviceId },
        );
        if (!enabled.ok) throw new Error(`enableWebhook failed: ${enabled.code}`);
        const hookId = enabled.webhook.payloadUrl.slice(`${PUBLIC_ORIGIN}${webhookConfig.WEBHOOK_PATH_PREFIX}`.length);
        const hookSecret = revealSecret(enabled.webhook.secret);
        const repositoryUrl = s().gitRepoUrl(REPOS.healthy);

        const deliverPush = async (label: string): Promise<{ deploymentId: string; deliveryId: string }> => {
          const sha = await pushCommit(label);
          const rawBody = Buffer.from(
            JSON.stringify({
              ref: 'refs/heads/main',
              after: sha,
              deleted: false,
              repository: { clone_url: repositoryUrl, ssh_url: repositoryUrl },
              head_commit: { id: sha },
            }),
          );
          const signature = `sha256=${createHmac('sha256', hookSecret).update(rawBody).digest('hex')}`;
          const deliveryId = randomUUID();
          const answer = await hooks.ingest({ hookId, signature, deliveryId, event: 'push', rawBody });
          if (answer.kind !== 'recorded' || answer.deploymentId === null || answer.duplicate) {
            throw new Error(`push ${label} did not create a deployment: ${JSON.stringify(answer)}`);
          }
          return { deploymentId: answer.deploymentId, deliveryId };
        };

        // Baseline before the first deployment.
        const baseline = {
          containers: await containerNames(),
          networks: await networkNames(),
          volumes: await volumeNames(),
          df: await df(),
        };
        artifact.baseline = baseline.df;
        flushArtifact();

        const requests: Request[] = [];
        const goods: string[] = [];
        let reference: { imageIds: string[]; df: DfRow[] } | undefined;

        const runIteration = async (iteration: number, kind: CycleKind): Promise<void> => {
          const started = Date.now();
          let request: Request;
          if (kind === 'prime' || kind === 'good') {
            const pushed = await deliverPush(`${kind} ${String(iteration)}`);
            request = { iteration, kind, deploymentId: pushed.deploymentId, deliveryId: pushed.deliveryId };
          } else if (kind === 'unhealthy') {
            await setSource(serviceId, REPOS.unhealthy, UNHEALTHY_CHECK);
            const result = await services$().triggerDeploy({ actor: USER, serviceId });
            if (!result.ok) throw new Error(`triggerDeploy failed at ${String(iteration)}: ${result.code}`);
            request = { iteration, kind, deploymentId: result.deployment.id, deliveryId: null };
          } else {
            const target = goods.at(-2);
            if (target === undefined) throw new Error(`no earlier good deployment to roll back to at ${String(iteration)}`);
            const result = await services$().triggerRollback({ actor: USER, serviceId, targetDeploymentId: target });
            if (!result.ok) throw new Error(`triggerRollback failed at ${String(iteration)}: ${result.code} ${result.message}`);
            request = { iteration, kind, deploymentId: result.deployment.id, deliveryId: null };
          }
          requests.push(request);
          const row = await settle(request.deploymentId);
          const durationMs = Date.now() - started;
          if (kind === 'unhealthy') await setSource(serviceId, REPOS.healthy, HEALTHY_CHECK);
          const snapshot = await df();
          artifact.iterations.push({
            iteration,
            kind,
            deploymentId: row.id,
            status: row.status,
            errorCode: row.errorCode,
            durationMs,
            df: snapshot,
          });
          flushArtifact();

          const outcome = { iteration, kind, status: row.status, errorCode: row.errorCode };
          if (kind === 'unhealthy') {
            expect(outcome).toEqual({ iteration, kind, status: 'ROLLED_BACK', errorCode: 'HEALTHCHECK_FAILED' });
          } else {
            expect(outcome).toEqual({ iteration, kind, status: 'SUCCESS', errorCode: null });
          }
          if (kind === 'prime' || kind === 'good') goods.push(row.id);
          // The running version: the new build, the restored one, or the rollback's target image.
          const runningImage = kind === 'manual' ? imageOf(goods.at(-2) ?? '') : imageOf(goods.at(-1) ?? '');
          expect(
            await rootOut(['docker', 'container', 'inspect', '--format', '{{.State.Status}} {{.Config.Image}}', container]),
            `iteration ${String(iteration)} (${kind})`,
          ).toBe(`running ${runningImage}`);
          // Orphans show up the iteration they appear in, not only at the end.
          const own = lines(
            await rootOut(['docker', 'ps', '--all', '--filter', `label=noodara.service_id=${serviceId}`, '--format', '{{.Names}}']),
          );
          expect(own, `iteration ${String(iteration)} (${kind}) containers`).toEqual([container]);
          if (iteration === WARMUP_INDEX) reference = { imageIds: await nonServiceImageIds(serviceId), df: snapshot };
        };

        await runIteration(-1, 'prime');
        for (let iteration = 0; iteration < CYCLES; iteration += 1) {
          const kind = CYCLE_KINDS[iteration % CYCLE_KINDS.length];
          if (kind === undefined) throw new Error('unreachable');
          // A manual rollback after the good deploy that came right after another rollback still
          // targets the good deployment before the running one (goods.at(-2)).
          await runIteration(iteration, kind);
        }

        const problems: string[] = [];

        // A1: one row per request, all terminal, every published path valid.
        const rows = await db().select().from(deployments).where(eq(deployments.serviceId, serviceId));
        const requested = new Set(requests.map((request) => request.deploymentId));
        expect(requested.size).toBe(requests.length);
        expect(rows.length).toBe(requests.length);
        for (const row of rows) {
          if (!requested.has(row.id)) problems.push(`${row.id}: a deployment no request created`);
          if (!TERMINAL.has(row.status)) problems.push(`${row.id}: left in ${row.status}`);
          const statuses = [...(published.get(row.id) ?? [])]
            .sort((a, b) => a.updatedAt.localeCompare(b.updatedAt))
            .map((entry) => entry.status);
          // The row is inserted QUEUED; only its later edges are published by the worker.
          if (statuses[0] !== 'QUEUED') statuses.unshift('QUEUED');
          const replay = replayDeploymentStatuses(statuses, row.trigger);
          if (!replay.ok) problems.push(`${row.id} (${row.trigger}): ${replay.reason}`);
          else if (replay.final !== row.status) problems.push(`${row.id}: replay ends ${replay.final}, row is ${row.status}`);
          const opened = sinksOpened.get(row.id) ?? 0;
          if (opened !== 1) problems.push(`${row.id}: ${String(opened)} log sinks opened`);
        }
        const triggers = (trigger: string) => rows.filter((row) => row.trigger === trigger).length;
        const kinds = (...wanted: CycleKind[]) => requests.filter((request) => wanted.includes(request.kind)).length;
        expect({ webhook: triggers('webhook'), manual: triggers('manual'), rollback: triggers('rollback') }).toEqual({
          webhook: kinds('prime', 'good'),
          manual: kinds('unhealthy'),
          rollback: kinds('manual'),
        });

        // H1: deployment_log_chunks and webhook_deliveries match the requests issued.
        const chunkCounts = await db()
          .select({ deploymentId: deploymentLogChunks.deploymentId, count: sql<number>`count(*)::int` })
          .from(deploymentLogChunks)
          .groupBy(deploymentLogChunks.deploymentId);
        problems.push(
          ...reconcileLogChunks(
            requests.map((request) => request.deploymentId),
            ledger,
            new Map(chunkCounts.map((entry) => [entry.deploymentId, Number(entry.count)])),
          ),
        );
        const deliveries = await db()
          .select({ deliveryId: webhookDeliveries.deliveryId, outcome: webhookDeliveries.outcome, deploymentId: webhookDeliveries.deploymentId })
          .from(webhookDeliveries);
        const issued = new Map(
          requests.flatMap((request) => (request.deliveryId === null ? [] : [[request.deliveryId, request.deploymentId] as const])),
        );
        problems.push(...reconcileWebhookDeliveries(issued, deliveries));

        // A2: the deploy host after the run.
        const final = await df();
        artifact.final = final;
        const leftContainers = extraEntries(baseline.containers, await containerNames());
        if (leftContainers.join(',') !== container) problems.push(`containers left: ${leftContainers.join(', ') || 'none'}`);
        const leftNetworks = extraEntries(baseline.networks, await networkNames());
        if (leftNetworks.join(',') !== network) problems.push(`networks left: ${leftNetworks.join(', ') || 'none'}`);
        const leftVolumes = extraEntries(baseline.volumes, await volumeNames());
        if (leftVolumes.length > 0) problems.push(`volumes left: ${leftVolumes.join(', ')}`);
        const workspaces = lines(await rootOut(['ls', '-A', WORKSPACE_ROOT]));
        if (workspaces.length > 0) problems.push(`workspaces left: ${workspaces.join(', ')}`);

        // The retention set the API derives (deployment-services retainedImageRefs): imageRetention
        // over the SUCCESS rows, newest first, with the newest one's image as the running image.
        const [serviceRow] = await db().select({ retention: services.imageRetention }).from(services).where(eq(services.id, serviceId));
        const successes = await db()
          .select()
          .from(deployments)
          .where(and(eq(deployments.serviceId, serviceId), eq(deployments.status, 'SUCCESS')))
          .orderBy(desc(deployments.createdAt), desc(deployments.id));
        const current = successes[0];
        if (current === undefined) throw new Error('no successful deployment');
        const retentionSet = imageRetention(
          successes.map((row) => ({ id: row.id, status: row.status, imageRef: row.imageRef, createdAt: row.createdAt.getTime() })),
          current.imageRef,
          serviceRow?.retention ?? DEFAULT_IMAGE_RETENTION,
        ).keep;
        expect([...retentionSet].sort(), 'retention set').toContain(current.imageRef);
        const onHost = await serviceImageRefs(serviceId);
        expect(onHost, 'service images vs the retention set').toEqual([...new Set(retentionSet)].sort());

        if (reference === undefined) throw new Error('no warm-up reference was taken');
        const extraImages = extraEntries(reference.imageIds, await nonServiceImageIds(serviceId));
        if (extraImages.length > 0) problems.push(`non-service images appeared after the warm-up: ${extraImages.join(', ')}`);
        const growth = dfRow(final, 'Images').sizeBytes - dfRow(reference.df, 'Images').sizeBytes;
        if (!(growth <= DF_IMAGES_GROWTH_BOUND_BYTES)) {
          problems.push(`docker system df Images grew ${String(growth)} B after the warm-up (bound ${String(DF_IMAGES_GROWTH_BOUND_BYTES)} B)`);
        }
        if (dfRow(final, 'Containers').total !== dfRow(baseline.df, 'Containers').total + 1) {
          problems.push(
            `docker system df Containers ${String(dfRow(final, 'Containers').total)}, baseline ${String(dfRow(baseline.df, 'Containers').total)} + 1`,
          );
        }
        if (dfRow(final, 'Local Volumes').total !== dfRow(baseline.df, 'Local Volumes').total) {
          problems.push(`docker system df Local Volumes ${String(dfRow(final, 'Local Volumes').total)}, baseline ${String(dfRow(baseline.df, 'Local Volumes').total)}`);
        }

        // H1: no iteration over the deploy max.
        for (const entry of artifact.iterations) {
          if (entry.durationMs > DEPLOY_MAX_MS) {
            problems.push(`iteration ${String(entry.iteration)} (${entry.kind}) took ${String(entry.durationMs)} ms > ${String(DEPLOY_MAX_MS)} ms`);
          }
        }

        artifact.problems = problems;
        flushArtifact();
        expect(problems).toEqual([]);
      },
      CASE_TIMEOUT_MS,
    );
  });
});
