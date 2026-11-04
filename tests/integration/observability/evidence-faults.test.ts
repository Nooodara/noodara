// 27-06 (A1, A2): diagnosis evidence from real faults on the sshd + dockerd fixture. Each fault is
// produced for real (constrained OOM, crash loop, docker stop, slow /health, closed port, failing
// build, full DockerRootDir, high memory, stopped sshd), the collector ticks through the same
// composition src/worker.ts runs, and loadServiceEvidence + classifyEvidence must rank that
// diagnosis first. Right after, the metrics, status and logs APIs are read over HTTP (inject) and
// the test records which API surfaced each diagnosis (feeds the 28-03 tools).
import { randomBytes, randomUUID } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { eq } from 'drizzle-orm';
import { Redis } from 'ioredis';
import parseSetCookie from 'set-cookie-parser';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { classifyEvidence, type Diagnosis, type Evidence } from '@noodara/domain';
import type { HealthcheckConfig } from '@noodara/domain/deployment';
import { createRedactor, revealSecret, secretValue } from '@noodara/domain/security';
import { createSsh2Adapter, formatFingerprint } from '@noodara/ssh';
import {
  credentials,
  environments,
  projects,
  servers,
  services,
} from '../../../apps/control-plane/src/db/schema/index.js';
import { parseDockerSize } from '../helpers/deploy-cycles.js';
import { DEPLOY_ENGINE_UBUNTU_VERSIONS, startDeployEngineStack, type DeployEngineStack } from '../helpers/deploy-engine.js';
import { startPostgres, type PostgresFixture } from '../helpers/postgres.js';
import { startRedis, type RedisFixture } from '../helpers/redis.js';
import { runTeardown, settleWithin } from '../helpers/teardown.js';

type RuntimeModule = typeof import('../../../apps/control-plane/src/observability/collector-runtime.js');
type EvidenceModule = typeof import('../../../apps/control-plane/src/observability/diagnosis-evidence.js');
type DeployWorkerModule = typeof import('../../../apps/control-plane/src/deploy/deploy-worker.js');
type WorkerCollectorDeps = Parameters<RuntimeModule['createWorkerCollectorTick']>[0];
type JobHandler = ReturnType<DeployWorkerModule['createDeployJobHandler']>;
type ApiApp = ReturnType<typeof import('../../../apps/control-plane/src/app.js')['buildApp']>;
type ApiSurface = import('../../../apps/control-plane/src/observability/diagnosis-evidence.js').ApiSurface;
type Json = Record<string, unknown>;

const HERE = path.dirname(fileURLToPath(import.meta.url));
const TEST_FIXTURES = path.resolve(HERE, '../fixtures');
const REPO_FIXTURES = path.resolve(HERE, '../../../fixtures');
const STACK_TIMEOUT_MS = 900_000;
const PENDING_START_WAIT_MS = 180_000;
const TEARDOWN_STEP_TIMEOUT_MS = 30_000;
const FIXTURE_STOP_TIMEOUT_MS = 60_000;
const STACK_STOP_TIMEOUT_MS = 300_000;
const CASE_TIMEOUT_MS = 600_000;
const WAIT_MS = 120_000;
const POLL_MS = 250;
const KEY_VERSION = 1;
/** The smallest interval env.ts accepts; the API reads the same value. */
const INTERVAL_MS = 30_000;
const ADMIN_EMAIL = 'admin@noodara.dev';
const ADMIN_PASSWORD = 'correct horse battery staple';
const ACTOR = { type: 'system' } as const;
const REPOS = { healthy: 'node-api', failing: 'failing-build' } as const;
/** Nothing listens on 3001 in fixtures/node-api: every TCP probe is refused. */
const CLOSED_PORT_CHECK: HealthcheckConfig = { type: 'tcp', port: 3001, probeTimeoutS: 2, intervalS: 1, retries: 2, startPeriodS: 0 };
const IDLE_NODE = ['node', '-e', "process.on('SIGTERM', () => process.exit(0)); setInterval(() => {}, 1000)"];
const SLOW_HEALTH_NODE = [
  'node',
  '-e',
  "process.on('SIGTERM', () => process.exit(0)); require('http').createServer((q, s) => setTimeout(() => s.end('ok'), 20000)).listen(3000)",
];
const HOLD_MEMORY_NODE = [
  'node',
  '-e',
  "process.on('SIGTERM', () => process.exit(0)); const b = Buffer.alloc(48 * 1024 * 1024, 1); setInterval(() => { b[0] += 1; }, 1000)",
];
/** Fails the health command by its timeout (docker records exit code -1). */
const SLOW_HEALTH_FLAGS = [
  '--health-cmd',
  "node -e \"require('http').get('http://127.0.0.1:3000/health', () => process.exit(0))\"",
  '--health-timeout',
  '1s',
  '--health-interval',
  '1s',
  '--health-retries',
  '2',
];
const DIAGNOSES_UNDER_TEST: readonly Exclude<Diagnosis, 'unknown'>[] = [
  'out_of_memory',
  'crash_loop',
  'container_stopped',
  'healthcheck_timeout',
  'high_memory',
  'port_not_responding',
  'failed_deployment',
  'high_disk',
  'server_unreachable',
];
const FAILED_STATUSES = ['FAILED', 'ROLLED_BACK'];

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function fixtureFiles(fixture: string): { dockerfile: string; script: string; name: string } {
  const dir = path.join(TEST_FIXTURES, fixture);
  const [name = ''] = readdirSync(dir).filter((file) => file.endsWith('.sh'));
  return {
    dockerfile: readFileSync(path.join(dir, 'Dockerfile'), 'utf8'),
    script: readFileSync(path.join(dir, name), 'utf8'),
    name,
  };
}

interface Point {
  t: string;
  v: number | null;
}

function latest(body: Json, metric: string): number | null {
  const series = (body.series as { metric: string; points: Point[] }[]).find((item) => item.metric === metric);
  const points = (series?.points ?? []).filter((point) => point.v !== null);
  return points.at(-1)?.v ?? null;
}

interface ApiReads {
  readonly serverMetrics: Json;
  readonly serviceMetrics: Json;
  readonly status: Json;
  readonly logs: { source: string; text: string; level: string }[];
}

/** Whether one API response carries the evidence behind a diagnosis. */
function surfacesOf(diagnosis: Diagnosis, reads: ApiReads): ApiSurface[] {
  const server = reads.serverMetrics.server as { connectionState: string; lastSeenAt: string | null };
  const status = reads.status as {
    container: { state: string; restartCount: number; healthcheck: string } | null;
    lastDeployment: { status: string } | null;
    flags: { highMemory: boolean; highDisk: boolean };
  };
  const activity = reads.logs.filter((entry) => entry.source === 'activity').map((entry) => entry.text);
  const deployLines = reads.logs.filter((entry) => entry.source === 'deploy').map((entry) => entry.text);
  const lastSeen = server.lastSeenAt === null ? null : Date.parse(server.lastSeenAt);
  const checks: Record<ApiSurface, boolean> = {
    server_metrics: false,
    service_metrics: false,
    service_status: false,
    logs: false,
  };
  switch (diagnosis) {
    case 'server_unreachable':
      checks.server_metrics =
        server.connectionState === 'UNREACHABLE' || (lastSeen !== null && Date.now() - lastSeen > INTERVAL_MS * 1.5);
      break;
    case 'out_of_memory':
      checks.logs = activity.some((text) => text.endsWith(': out_of_memory'));
      break;
    case 'crash_loop':
      checks.logs = activity.some((text) => text.endsWith(': crash_loop'));
      checks.service_status = (status.container?.restartCount ?? 0) >= 3;
      checks.service_metrics = (latest(reads.serviceMetrics, 'restart_count') ?? 0) >= 3;
      break;
    case 'container_stopped':
      checks.service_status = status.container?.state === 'exited' || status.container?.state === 'dead';
      break;
    case 'healthcheck_timeout':
      checks.service_status = status.container?.healthcheck === 'timeout';
      break;
    case 'port_not_responding':
      checks.logs = deployLines.some((text) => /^Healthcheck attempt \d+: connection refused$/.test(text));
      break;
    case 'failed_deployment':
      checks.service_status = FAILED_STATUSES.includes(status.lastDeployment?.status ?? '');
      checks.logs = activity.some((text) => text.startsWith('deployment.finished failed'));
      break;
    case 'high_memory':
      checks.service_status = status.flags.highMemory;
      checks.service_metrics = (latest(reads.serviceMetrics, 'memory_percent') ?? 0) >= 90;
      break;
    case 'high_disk':
      checks.service_status = status.flags.highDisk;
      checks.server_metrics = (latest(reads.serverMetrics, 'disk_used_percent') ?? 0) >= 90;
      break;
    case 'unknown':
      break;
  }
  return (Object.keys(checks) as ApiSurface[]).filter((surface) => checks[surface]);
}

interface Captured {
  readonly evidence: Evidence[];
  readonly top: Diagnosis | undefined;
  readonly supporting: readonly string[];
  readonly surfaces: ApiSurface[];
  readonly elapsedMs: number;
}

describe.each(DEPLOY_ENGINE_UBUNTU_VERSIONS)('27-06 diagnosis evidence from real faults, Ubuntu %s', (ubuntu) => {
  let stack: DeployEngineStack | undefined;
  let stackStart: Promise<DeployEngineStack> | undefined;
  let pgStart: Promise<PostgresFixture> | undefined;
  let redisStart: Promise<RedisFixture> | undefined;
  let postgres: PostgresFixture | undefined;
  let redis: RedisFixture | undefined;
  let runtime: RuntimeModule | undefined;
  let evidenceModule: EvidenceModule | undefined;
  let collectorDeps: WorkerCollectorDeps | undefined;
  let handler: JobHandler | undefined;
  let createRow: ((serviceId: string) => Promise<string>) | undefined;
  let app: ApiApp | undefined;
  let lockConnection: Redis | undefined;
  let cookie = '';
  let dockerRoot = '';
  let diskMounted = false;
  let sshdStopped = false;

  const masterKey = randomBytes(32);
  const startedContainers: string[] = [];
  const recorded = new Map<Diagnosis, Captured>();
  const ids = { server: '', project: '', environment: '', serverCredential: '' };
  let fingerprint = '';
  let nodeImage = '';

  const s = (): DeployEngineStack => {
    if (stack === undefined) throw new Error('stack not started');
    return stack;
  };
  const db = (): PostgresFixture['db'] => {
    if (postgres === undefined) throw new Error('postgres not started');
    return postgres.db;
  };
  const tick = async () => {
    if (runtime === undefined || collectorDeps === undefined) throw new Error('collector not wired');
    const run = await runtime.createWorkerCollectorTick(collectorDeps)();
    if (!run.ran) throw new Error('tick did not take the lock');
    return run.value;
  };
  const root = async (script: string, args: readonly string[] = []): Promise<string> => {
    const result = await s().exec(['bash', '--noprofile', '--norc', '-c', script, 'noodara-test', ...args], { user: 'root' });
    if (result.exitCode !== 0) throw new Error(`exit ${String(result.exitCode)}: ${script.slice(0, 80)}: ${result.stderr}`);
    return result.stdout.trim();
  };
  const waitFor = async (what: string, check: () => Promise<boolean>, timeoutMs = WAIT_MS): Promise<void> => {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      if (await check()) return;
      if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
      await delay(POLL_MS);
    }
  };
  const build = async (fixture: string): Promise<string> => {
    const { dockerfile, script, name } = fixtureFiles(fixture);
    const tag = `noodara-test/${fixture}:${randomUUID().slice(0, 12)}`;
    await root(
      `d=$(mktemp -d); printf '%s' "$1" > "$d/Dockerfile"; printf '%s' "$2" > "$d/$3"
docker build --quiet --tag "$4" "$d" >/dev/null; rc=$?; rm -rf -- "$d"; exit $rc`,
      [dockerfile, script, name, tag],
    );
    return tag;
  };
  const runManaged = async (serviceId: string, flags: readonly string[], image: string, cmd: readonly string[] = []) => {
    const name = `noodara-${serviceId}`;
    await root('docker run --detach --pull never --label noodara.managed=true --label noodara.test=true "$@" >/dev/null', [
      '--name',
      name,
      ...flags,
      '--',
      image,
      ...cmd,
    ]);
    startedContainers.push(name);
  };
  const inspect = (serviceId: string, format: string) => root(`docker inspect --format "$2" -- "$1"`, [`noodara-${serviceId}`, format]);

  const insertService = async (
    options: { repo?: string; healthcheck?: HealthcheckConfig | null } = {},
  ): Promise<string> => {
    let repositoryCredentialId: string | null = null;
    if (options.repo !== undefined) {
      const serviceCredentials = await import('../../../apps/control-plane/src/services/service-credentials.js');
      const encoded = serviceCredentials.encodeServiceCredential(
        {
          kind: 'deploy_key',
          privateKey: secretValue(s().deployKey.privateKey, 'ssh_private_key'),
          publicKey: s().deployKey.publicKey,
        },
        { key: masterKey, version: KEY_VERSION },
      );
      repositoryCredentialId = await db().transaction((tx) => serviceCredentials.insertServiceCredential(tx, encoded, new Date()));
    }
    const [row] = await db()
      .insert(services)
      .values({
        projectId: ids.project,
        environmentId: ids.environment,
        serverId: ids.server,
        name: `ev-${randomUUID().slice(0, 8)}`,
        sourceType: 'git',
        repositoryUrl: options.repo === undefined ? 'https://example.invalid/evidence.git' : s().gitRepoUrl(options.repo),
        branch: 'main',
        buildContext: '.',
        dockerfilePath: 'Dockerfile',
        buildTarget: null,
        internalPort: 3000,
        publishedPort: null,
        repositoryCredentialId,
        healthcheck: options.healthcheck ?? null,
        autoRollback: false,
        status: 'RUNNING',
      })
      .returning({ id: services.id });
    if (!row) throw new Error('service insert returned no row');
    return row.id;
  };

  const deploy = async (serviceId: string): Promise<string> => {
    if (handler === undefined || createRow === undefined) throw new Error('deploy runtime not wired');
    const deploymentId = await createRow(serviceId);
    await handler({ deploymentId, serviceId, actor: ACTOR, requestedAt: new Date().toISOString() });
    startedContainers.push(`noodara-${serviceId}`, `noodara-${serviceId}-prev`);
    return deploymentId;
  };

  const get = async (url: string): Promise<Json> => {
    if (app === undefined) throw new Error('app not built');
    const response = await app.inject({ method: 'GET', url, headers: { cookie } });
    expect(response.statusCode, `${url}: ${response.body}`).toBe(200);
    return response.json<Json>();
  };

  /**
   * Ticks (unless the fault is the tick itself), loads the stored evidence, asserts the top
   * candidate, then reads every API within the same collector interval and records the surfaces.
   */
  const capture = async (diagnosis: Exclude<Diagnosis, 'unknown'>, serviceId: string, options: { tick?: boolean } = {}) => {
    if (evidenceModule === undefined) throw new Error('modules not loaded');
    if (options.tick !== false) await tick();
    const tickedAt = Date.now();
    const loaded = await evidenceModule.loadServiceEvidence(db(), serviceId, { nowMs: Date.now(), intervalMs: INTERVAL_MS });
    if (loaded === null) throw new Error('service evidence missing');
    const candidates = classifyEvidence(loaded.evidence);
    expect(candidates[0]?.diagnosis, JSON.stringify(loaded.evidence)).toBe(diagnosis);

    const servicePath = `/api/projects/${ids.project}/services/${serviceId}`;
    const [serverMetrics, serviceMetrics, status, logs] = await Promise.all([
      get(`/api/servers/${ids.server}/metrics`),
      get(`${servicePath}/metrics`),
      get(`${servicePath}/status`),
      get(`${servicePath}/logs/entries?sources=build&sources=deploy&sources=activity&limit=1000`),
    ]);
    const elapsedMs = Date.now() - tickedAt;
    const surfaces = surfacesOf(diagnosis, {
      serverMetrics,
      serviceMetrics,
      status,
      logs: logs.entries as ApiReads['logs'],
    });
    const captured: Captured = {
      evidence: loaded.evidence,
      top: candidates[0]?.diagnosis,
      supporting: candidates[0]?.evidence ?? [],
      surfaces,
      elapsedMs,
    };
    recorded.set(diagnosis, captured);
    expect(surfaces, `${diagnosis} was not surfaced by any API`).not.toHaveLength(0);
    expect(elapsedMs).toBeLessThan(INTERVAL_MS);
    return captured;
  };

  beforeAll(async () => {
    stackStart = startDeployEngineStack({
      ubuntu,
      seedRepositories: [
        { name: REPOS.healthy, sourceDir: path.join(REPO_FIXTURES, 'node-api') },
        { name: REPOS.failing, sourceDir: path.join(REPO_FIXTURES, 'failing-build') },
      ],
    });
    pgStart = startPostgres();
    redisStart = startRedis();
    const [stackStarted, pgStarted, redisStarted] = await Promise.all([stackStart, pgStart, redisStart]);
    stack = stackStarted;
    postgres = pgStarted;
    redis = redisStarted;

    process.env.NOODARA_MASTER_KEY = masterKey.toString('base64');
    process.env.BETTER_AUTH_SECRET = `evidence-faults-${randomUUID()}-${randomUUID()}`;
    process.env.DATABASE_URL = postgres.connectionString;
    process.env.REDIS_URL = redis.connectionUrl;
    process.env.NOODARA_PUBLIC_URL = 'http://localhost:3000';
    process.env.NOODARA_METRICS_INTERVAL_MS = String(INTERVAL_MS);
    const deployRuntime = await import('../../../apps/control-plane/src/deploy/deploy-runtime.js');
    const workerModule: DeployWorkerModule = await import('../../../apps/control-plane/src/deploy/deploy-worker.js');
    const logSink = await import('../../../apps/control-plane/src/deploy/log-sink.js');
    const deploymentServices = await import('../../../apps/control-plane/src/services/deployment-services.js');
    const credentialStore = await import('../../../apps/control-plane/src/services/credential-store.js');
    const { issueToken } = await import('../../../apps/control-plane/src/services/setup-token-repository.js');
    const { buildApp } = await import('../../../apps/control-plane/src/app.js');
    runtime = await import('../../../apps/control-plane/src/observability/collector-runtime.js');
    evidenceModule = await import('../../../apps/control-plane/src/observability/diagnosis-evidence.js');

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

    const encoded = credentialStore.encodeCredential(
      { kind: 'private_key', privateKey: stack.ssh.privateKey },
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
        name: `evidence-host-${ubuntu}`,
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
    ids.server = serverRow.id;
    const now = new Date();
    const [projectRow] = await db()
      .insert(projects)
      .values({ name: 'evidence', slug: `ev-${randomUUID().slice(0, 8)}`, createdAt: now, updatedAt: now })
      .returning({ id: projects.id });
    if (!projectRow) throw new Error('project insert returned no row');
    ids.project = projectRow.id;
    const [environmentRow] = await db()
      .insert(environments)
      .values({ projectId: projectRow.id, name: 'production', createdAt: now, updatedAt: now })
      .returning({ id: environments.id });
    if (!environmentRow) throw new Error('environment insert returned no row');
    ids.environment = environmentRow.id;

    const found = stack.baseImages.find((ref) => ref.startsWith('node:'));
    if (found === undefined) throw new Error('no node base image preloaded');
    nodeImage = found;
    dockerRoot = await root(`docker info --format '{{.DockerRootDir}}'`);

    const logger = { info: () => undefined, warn: () => undefined, error: () => undefined };
    const events = { publish: () => Promise.resolve() };
    const baseDeps = deployRuntime.createDeployJobDeps({
      db: db(),
      events,
      ssh: createSsh2Adapter(),
      timeouts: { connectMs: 20_000, commandMs: 60_000, discoveryMs: 120_000 },
      masterKeys: () => Promise.resolve({ current: masterKey }),
      panelPorts: [],
      config: { deployMaxMs: 300_000, idleMs: 120_000, logMaxBytes: 1_048_576, logLineMaxBytes: 16_384 },
      logger,
    });
    // The worker's chunked DB sink: the healthcheck lines must reach deployment_log_chunks.
    handler = workerModule.createDeployJobHandler({
      ...baseDeps,
      sinkFor: logSink.createDeploymentLogSinkFactory({
        writer: logSink.createDbLogChunkWriter(db()),
        events,
        logger,
        policy: { flushIntervalMs: 200, flushBytes: 16_384, maxLineBytes: 16_384, maxPhaseBytes: 1_048_576 },
      }),
    });
    const api = deploymentServices.createDeploymentServices({
      db: db(),
      now: () => new Date(),
      events,
      queue: { enqueue: () => Promise.resolve({ ok: true, jobId: 'unused' } as const) },
      logger,
    });
    createRow = async (serviceId) => {
      const result = await api.triggerDeploy({ actor: ACTOR, serviceId });
      if (!result.ok) throw new Error(`triggerDeploy failed: ${result.code}`);
      return result.deployment.id;
    };
    lockConnection = new Redis(redis.connectionUrl, { maxRetriesPerRequest: null });
    collectorDeps = {
      db: db(),
      connect: baseDeps.connect,
      createRedactor: baseDeps.createRedactor,
      logger,
      intervalMs: INTERVAL_MS,
      retentionHours: 168,
      redis: lockConnection,
    };

    app = buildApp({ eventPublisher: events });
    await app.ready();
    const issued = await issueToken(db(), 'setup', new Date());
    const setup = await app.inject({
      method: 'POST',
      url: '/api/setup',
      payload: { token: revealSecret(issued.token), email: ADMIN_EMAIL, password: ADMIN_PASSWORD, name: 'Admin' },
    });
    if (setup.statusCode !== 200) throw new Error(`setup failed: ${String(setup.statusCode)}`);
    const signIn = await app.inject({
      method: 'POST',
      url: '/api/auth/sign-in/email',
      payload: { email: ADMIN_EMAIL, password: ADMIN_PASSWORD },
    });
    if (signIn.statusCode !== 200) throw new Error(`sign-in failed: ${String(signIn.statusCode)}`);
    const raw = signIn.headers['set-cookie'];
    const rawCookies = Array.isArray(raw) ? raw : raw !== undefined ? [String(raw)] : [];
    cookie = parseSetCookie
      .parse(rawCookies, { map: false })
      .map((entry) => `${entry.name}=${entry.value}`)
      .join('; ');
  }, STACK_TIMEOUT_MS);

  afterAll(async () => {
    const [stk, pg, rd] = await Promise.all([
      stack ?? settleWithin(stackStart, PENDING_START_WAIT_MS),
      postgres ?? settleWithin(pgStart, PENDING_START_WAIT_MS),
      redis ?? settleWithin(redisStart, PENDING_START_WAIT_MS),
    ]);
    await runTeardown(
      `evidence faults (Ubuntu ${ubuntu})`,
      [
        {
          name: 'restore the docker root and sshd',
          run: async () => {
            if (stk === undefined) return;
            if (diskMounted) await stk.exec(['umount', '-l', dockerRoot], { user: 'root' }).catch(() => undefined);
            if (sshdStopped) await stk.exec(['/usr/sbin/sshd'], { user: 'root' }).catch(() => undefined);
          },
        },
        {
          name: 'remove fixture containers',
          run: async () => {
            if (stk === undefined) return;
            for (const name of startedContainers) await stk.exec(['docker', 'rm', '-f', name], { user: 'root' }).catch(() => undefined);
          },
        },
        { name: 'app.close', run: () => app?.close() },
        { name: 'disconnect redis', run: () => lockConnection?.disconnect() },
        { name: 'redis.stop', run: () => rd?.stop(), timeoutMs: FIXTURE_STOP_TIMEOUT_MS },
        { name: 'postgres.stop', run: () => pg?.stop(), timeoutMs: FIXTURE_STOP_TIMEOUT_MS },
        { name: 'stack.stop', run: () => stk?.stop(), timeoutMs: STACK_STOP_TIMEOUT_MS },
      ],
      { stepTimeoutMs: TEARDOWN_STEP_TIMEOUT_MS },
    );
  }, STACK_TIMEOUT_MS);

  it(
    'A1: a memory-constrained allocator is OOM-killed -> out_of_memory',
    async () => {
      const serviceId = await insertService();
      await runManaged(serviceId, ['--memory', '32m', '--memory-swap', '32m'], await build('oom-allocator'));
      await waitFor('the OOM fixture to exit', async () => (await inspect(serviceId, '{{.State.Status}}')) === 'exited');
      const captured = await capture('out_of_memory', serviceId);
      expect(captured.surfaces).toContain('logs');
    },
    CASE_TIMEOUT_MS,
  );

  it(
    'A1: a restarting container that keeps crashing -> crash_loop',
    async () => {
      const serviceId = await insertService();
      await runManaged(serviceId, ['--restart', 'on-failure'], await build('crash-loop'));
      await waitFor('a first restart', async () => Number(await inspect(serviceId, '{{.RestartCount}}')) >= 1);
      await tick();
      const seen = Number(await inspect(serviceId, '{{.RestartCount}}'));
      await waitFor('three more restarts', async () => Number(await inspect(serviceId, '{{.RestartCount}}')) >= seen + 3);
      const captured = await capture('crash_loop', serviceId);
      expect(captured.surfaces).toContain('logs');
      // The loop must not keep restarting into the later disk fault.
      await root('docker update --restart no -- "$1" >/dev/null; docker rm -f -- "$1" >/dev/null', [`noodara-${serviceId}`]);
    },
    CASE_TIMEOUT_MS,
  );

  it(
    'A1: docker stop -> container_stopped',
    async () => {
      const serviceId = await insertService();
      await runManaged(serviceId, ['--memory', '128m'], nodeImage, IDLE_NODE);
      await tick();
      await root('docker stop --time 10 -- "$1" >/dev/null', [`noodara-${serviceId}`]);
      const captured = await capture('container_stopped', serviceId);
      expect(captured.surfaces).toContain('service_status');
    },
    CASE_TIMEOUT_MS,
  );

  it(
    'A1: a /health that answers after the probe timeout -> healthcheck_timeout',
    async () => {
      const serviceId = await insertService();
      await runManaged(serviceId, ['--memory', '128m', ...SLOW_HEALTH_FLAGS], nodeImage, SLOW_HEALTH_NODE);
      await waitFor(
        'the healthcheck to time out',
        async () => (await inspect(serviceId, '{{.State.Health.Status}}')) === 'unhealthy',
      );
      const captured = await capture('healthcheck_timeout', serviceId);
      expect(captured.surfaces).toContain('service_status');
      await root('docker rm -f -- "$1" >/dev/null', [`noodara-${serviceId}`]);
    },
    CASE_TIMEOUT_MS,
  );

  it(
    'A1: a container held above 90% of its memory limit for three samples -> high_memory',
    async () => {
      const serviceId = await insertService();
      await runManaged(serviceId, [], nodeImage, HOLD_MEMORY_NODE);
      const name = `noodara-${serviceId}`;
      let used = 0;
      await waitFor('the buffer to be resident', async () => {
        const usage = await root(`docker stats --no-stream --format '{{.MemUsage}}' -- "$1"`, [name]);
        used = parseDockerSize(usage.split('/')[0] ?? '');
        return used >= 48 * 1024 * 1024;
      });
      const limit = Math.ceil(used / 0.93);
      await root('docker update --memory "$2" --memory-swap "$2" -- "$1" >/dev/null', [name, String(limit)]);
      await tick();
      await tick();
      const captured = await capture('high_memory', serviceId);
      expect(captured.surfaces).toContain('service_status');
      await root('docker rm -f -- "$1" >/dev/null', [name]);
    },
    CASE_TIMEOUT_MS,
  );

  it(
    'A1: a deploy whose TCP healthcheck port is closed -> port_not_responding',
    async () => {
      const serviceId = await insertService({ repo: REPOS.healthy, healthcheck: CLOSED_PORT_CHECK });
      await deploy(serviceId);
      const captured = await capture('port_not_responding', serviceId);
      expect(captured.evidence.find((item) => item.kind === 'port')).toMatchObject({ port: 3001, responding: false });
      expect(captured.surfaces).toContain('logs');
    },
    CASE_TIMEOUT_MS,
  );

  it(
    'A1: a failing build -> failed_deployment',
    async () => {
      const serviceId = await insertService({ repo: REPOS.failing });
      await deploy(serviceId);
      const captured = await capture('failed_deployment', serviceId);
      expect(captured.surfaces).toContain('service_status');
    },
    CASE_TIMEOUT_MS,
  );

  it(
    'A1: a near-full DockerRootDir (small tmpfs, filled) -> high_disk',
    async () => {
      const serviceId = await insertService();
      await runManaged(serviceId, ['--memory', '128m'], nodeImage, IDLE_NODE);
      await tick();
      await root('mount -t tmpfs -o size=8m tmpfs "$1"', [dockerRoot]);
      diskMounted = true;
      try {
        await root('dd if=/dev/zero of="$1/noodara-fill" bs=512K count=15 status=none', [dockerRoot]);
        const captured = await capture('high_disk', serviceId);
        expect(captured.evidence.find((item) => item.kind === 'filesystem' && item.ref.endsWith(`:${dockerRoot}`))).toBeDefined();
        expect(captured.surfaces).toContain('service_status');
      } finally {
        await root('umount "$1" || umount -l "$1"', [dockerRoot]);
        diskMounted = false;
      }
    },
    CASE_TIMEOUT_MS,
  );

  it(
    'A1: sshd stopped, no sample for 1.5 intervals -> server_unreachable',
    async () => {
      const serviceId = await insertService();
      await runManaged(serviceId, ['--memory', '128m'], nodeImage, IDLE_NODE);
      const sampled = await tick();
      expect(sampled.outcomes[ids.server]).toBe('sampled');
      const [row] = await db().select({ lastSeenAt: servers.lastSeenAt }).from(servers).where(eq(servers.id, ids.server));
      const lastSeen = row?.lastSeenAt?.getTime() ?? Date.now();
      await root('pkill -x sshd || true');
      sshdStopped = true;
      try {
        await delay(Math.max(0, lastSeen + INTERVAL_MS * 1.5 + 1_000 - Date.now()));
        const missed = await tick();
        expect(missed.outcomes[ids.server]).not.toBe('sampled');
        const captured = await capture('server_unreachable', serviceId, { tick: false });
        expect(captured.surfaces).toContain('server_metrics');
      } finally {
        await root('mkdir -p /run/sshd; /usr/sbin/sshd');
        sshdStopped = false;
      }
    },
    CASE_TIMEOUT_MS,
  );

  it('A2: every diagnosis was surfaced by an API within one interval, matching EVIDENCE_SURFACES', () => {
    if (evidenceModule === undefined) throw new Error('modules not loaded');
    const record: Record<string, { surfaces: ApiSurface[]; elapsedMs: number }> = {};
    for (const diagnosis of DIAGNOSES_UNDER_TEST) {
      const captured = recorded.get(diagnosis);
      expect(captured?.top, `${diagnosis} was not captured`).toBe(diagnosis);
      if (captured === undefined) continue;
      record[diagnosis] = { surfaces: captured.surfaces, elapsedMs: captured.elapsedMs };
      // At least one supporting evidence kind names a surface this run actually saw.
      const kinds = captured.evidence.filter((item) => captured.supporting.includes(item.ref)).map((item) => item.kind);
      const declared = new Set(kinds.flatMap((kind) => evidenceModule?.EVIDENCE_SURFACES[kind] ?? []));
      expect(
        captured.surfaces.some((surface) => declared.has(surface)),
        `${diagnosis}: ${JSON.stringify({ kinds, surfaces: captured.surfaces })}`,
      ).toBe(true);
    }
    // The record the 28-03 tools build on: diagnosis -> APIs that returned its evidence.
    expect(Object.keys(record).sort()).toEqual([...DIAGNOSES_UNDER_TEST].sort());
  });
});
