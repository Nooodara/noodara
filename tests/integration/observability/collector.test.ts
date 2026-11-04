// 27-02 (A1-A4, H1): the metrics collector on the real sshd + dockerd fixture, through the same
// composition src/worker.ts runs (collector-runtime). Fixture containers are started as root with
// `stack.exec`; the SSH adapter is wrapped to count connects per port. App modules are imported
// after a valid test env is written: several import env.ts, which fail-fasts at import time.
import { randomBytes, randomUUID } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { and, count, eq, sql } from 'drizzle-orm';
import { Redis } from 'ioredis';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createRedactor, secretValue } from '@noodara/domain/security';
import { createSsh2Adapter, formatFingerprint } from '@noodara/ssh';
import {
  activityEvents,
  containerMetricSamples,
  containerObservations,
  credentials,
  deployments,
  environments,
  hostMetricSamples,
  projects,
  servers,
  services,
} from '../../../apps/control-plane/src/db/schema/index.js';
import { DEPLOY_ENGINE_UBUNTU_VERSIONS, startDeployEngineStack, type DeployEngineStack } from '../helpers/deploy-engine.js';
import { startPostgres, type PostgresFixture } from '../helpers/postgres.js';
import { startRedis, type RedisFixture } from '../helpers/redis.js';
import { runTeardown, settleWithin } from '../helpers/teardown.js';

type DeployRuntimeModule = typeof import('../../../apps/control-plane/src/deploy/deploy-runtime.js');
type RuntimeModule = typeof import('../../../apps/control-plane/src/observability/collector-runtime.js');
type StoreModule = typeof import('../../../apps/control-plane/src/observability/collector-store.js');
type CredentialStoreModule = typeof import('../../../apps/control-plane/src/services/credential-store.js');
type SshAdapter = ReturnType<typeof createSsh2Adapter>;
type ConnectOptions = Parameters<SshAdapter['connect']>[0];
type WorkerCollectorDeps = Parameters<RuntimeModule['createWorkerCollectorTick']>[0];
type TickRun = Awaited<ReturnType<ReturnType<RuntimeModule['createWorkerCollectorTick']>>>;

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES = path.resolve(HERE, '../fixtures');
const STACK_TIMEOUT_MS = 900_000;
const PENDING_START_WAIT_MS = 180_000;
const TEARDOWN_STEP_TIMEOUT_MS = 30_000;
const FIXTURE_STOP_TIMEOUT_MS = 60_000;
const STACK_STOP_TIMEOUT_MS = 300_000;
const CASE_TIMEOUT_MS = 300_000;
const WAIT_MS = 120_000;
const POLL_MS = 250;
const KEY_VERSION = 1;
const INCIDENT = 'service.container_changed';
/** Nothing listens here: connecting is refused at once. */
const UNREACHABLE = { host: '127.0.0.1', port: 1 } as const;
const HOUR_MS = 3_600_000;

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function fixtureFiles(fixture: string): { dockerfile: string; script: string; name: string } {
  const dir = path.join(FIXTURES, fixture);
  const [name = ''] = readdirSync(dir).filter((file) => file.endsWith('.sh'));
  return {
    dockerfile: readFileSync(path.join(dir, 'Dockerfile'), 'utf8'),
    script: readFileSync(path.join(dir, name), 'utf8'),
    name,
  };
}

describe.each(DEPLOY_ENGINE_UBUNTU_VERSIONS)('27-02 metrics collector on real infrastructure, Ubuntu %s', (ubuntu) => {
  let stack: DeployEngineStack | undefined;
  let stackStart: Promise<DeployEngineStack> | undefined;
  let pgStart: Promise<PostgresFixture> | undefined;
  let redisStart: Promise<RedisFixture> | undefined;
  let postgres: PostgresFixture | undefined;
  let redis: RedisFixture | undefined;
  let queueConnection: Redis | undefined;
  let workerConnection: Redis | undefined;
  let runtime: RuntimeModule | undefined;
  let store: StoreModule | undefined;
  let credentialStore: CredentialStoreModule | undefined;
  let collectorDeps: WorkerCollectorDeps | undefined;

  const masterKey = randomBytes(32);
  const canary = `NOODARA_CANARY_${randomUUID()}`;
  const connects: number[] = [];
  const logs: { level: string; fields: Record<string, unknown>; message: string }[] = [];
  const startedContainers: string[] = [];
  let fingerprint = '';
  const ids = { server: '', unreachableServer: '', project: '', environment: '', running: '', crash: '', oom: '' };

  const s = (): DeployEngineStack => {
    if (stack === undefined) throw new Error('stack not started');
    return stack;
  };
  const db = (): PostgresFixture['db'] => {
    if (postgres === undefined) throw new Error('postgres not started');
    return postgres.db;
  };
  const deps = (): WorkerCollectorDeps => {
    if (collectorDeps === undefined) throw new Error('collector not wired');
    return collectorDeps;
  };
  const rt = (): RuntimeModule => {
    if (runtime === undefined) throw new Error('modules not loaded');
    return runtime;
  };
  const tick = async (): Promise<NonNullable<Extract<TickRun, { ran: true }>['value']>> => {
    const run = await rt().createWorkerCollectorTick(deps())();
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
  const runManaged = async (serviceId: string, flags: string, image: string, cmd: readonly string[] = []) => {
    const name = `noodara-${serviceId}`;
    await root(
      `docker run --detach --pull never --name "$1" --label noodara.managed=true --label noodara.test=true --env "SVC_SECRET=$2" ${flags} -- "$3" "\${@:4}" >/dev/null`,
      [name, canary, image, ...cmd],
    );
    startedContainers.push(name);
  };
  const inspect = (serviceId: string, format: string) => root(`docker inspect --format "$2" -- "$1"`, [`noodara-${serviceId}`, format]);

  const recordingAdapter = (inner: SshAdapter): SshAdapter => ({
    ...inner,
    connect(options: ConnectOptions) {
      connects.push(options.target.port);
      return inner.connect(options);
    },
  });

  const insertServer = async (name: string, target: { host: string; port: number }): Promise<string> => {
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
        host: target.host,
        sshPort: target.port,
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

  const insertService = async (serverId: string): Promise<string> => {
    const [row] = await db()
      .insert(services)
      .values({
        projectId: ids.project,
        environmentId: ids.environment,
        serverId,
        name: `svc-${randomUUID().slice(0, 8)}`,
        sourceType: 'git',
        repositoryUrl: 'https://example.invalid/metrics.git',
        branch: 'main',
        buildContext: '.',
        dockerfilePath: 'Dockerfile',
        internalPort: 3000,
        publishedPort: null,
        status: 'RUNNING',
      })
      .returning({ id: services.id });
    if (!row) throw new Error('service insert returned no row');
    return row.id;
  };

  const hostSamplesOf = async (serverId: string): Promise<number> => {
    const [row] = await db().select({ n: count() }).from(hostMetricSamples).where(eq(hostMetricSamples.serverId, serverId));
    return row?.n ?? 0;
  };
  const incidentsOf = (serviceId: string) =>
    db()
      .select()
      .from(activityEvents)
      .where(and(eq(activityEvents.entityId, serviceId), eq(activityEvents.action, INCIDENT)));

  beforeAll(async () => {
    stackStart = startDeployEngineStack({ ubuntu, seedRepositories: [] });
    pgStart = startPostgres();
    redisStart = startRedis();
    const [stackStarted, pgStarted, redisStarted] = await Promise.all([stackStart, pgStart, redisStart]);
    stack = stackStarted;
    postgres = pgStarted;
    redis = redisStarted;

    process.env.NOODARA_MASTER_KEY = masterKey.toString('base64');
    process.env.BETTER_AUTH_SECRET = `metrics-collector-${randomUUID()}-${randomUUID()}`;
    process.env.DATABASE_URL = postgres.connectionString;
    process.env.REDIS_URL = redis.connectionUrl;
    process.env.NOODARA_PUBLIC_URL = 'http://localhost:3000';
    const deployRuntime: DeployRuntimeModule = await import('../../../apps/control-plane/src/deploy/deploy-runtime.js');
    runtime = await import('../../../apps/control-plane/src/observability/collector-runtime.js');
    store = await import('../../../apps/control-plane/src/observability/collector-store.js');
    credentialStore = await import('../../../apps/control-plane/src/services/credential-store.js');

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

    const now = new Date();
    const [projectRow] = await db()
      .insert(projects)
      .values({ name: 'metrics', slug: `met-${randomUUID().slice(0, 8)}`, createdAt: now, updatedAt: now })
      .returning({ id: projects.id });
    if (!projectRow) throw new Error('project insert returned no row');
    const [environmentRow] = await db()
      .insert(environments)
      .values({ projectId: projectRow.id, name: 'production', createdAt: now, updatedAt: now })
      .returning({ id: environments.id });
    if (!environmentRow) throw new Error('environment insert returned no row');
    ids.project = projectRow.id;
    ids.environment = environmentRow.id;
    ids.server = await insertServer(`metrics-host-${ubuntu}`, { host: stack.ssh.host, port: stack.ssh.port });
    ids.unreachableServer = await insertServer(`metrics-unreachable-${ubuntu}`, UNREACHABLE);
    ids.running = await insertService(ids.server);
    ids.crash = await insertService(ids.server);
    ids.oom = await insertService(ids.server);
    await insertService(ids.unreachableServer);

    const nodeImage = stack.baseImages.find((ref) => ref.startsWith('node:'));
    if (nodeImage === undefined) throw new Error('no node base image preloaded');
    const [oomImage, crashImage] = await Promise.all([build('oom-allocator'), build('crash-loop')]);
    await runManaged(ids.running, '--memory 64m', nodeImage, ['node', '-e', 'setInterval(() => {}, 1000)']);
    await runManaged(ids.oom, '--memory 32m --memory-swap 32m', oomImage);
    await waitFor('the OOM fixture to exit', async () => (await inspect(ids.oom, '{{.State.Status}}')) === 'exited');

    const logger = {
      info: (fields: Record<string, unknown>, message: string) => logs.push({ level: 'info', fields, message }),
      warn: (fields: Record<string, unknown>, message: string) => logs.push({ level: 'warn', fields, message }),
      error: (fields: Record<string, unknown>, message: string) => logs.push({ level: 'error', fields, message }),
    };
    const baseDeps = deployRuntime.createDeployJobDeps({
      db: db(),
      events: { publish: () => Promise.resolve() },
      ssh: recordingAdapter(createSsh2Adapter()),
      timeouts: { connectMs: 20_000, commandMs: 45_000, discoveryMs: 120_000 },
      masterKeys: () => Promise.resolve({ current: masterKey }),
      panelPorts: [],
      config: { deployMaxMs: 300_000, idleMs: 120_000, logMaxBytes: 1_048_576, logLineMaxBytes: 16_384 },
      logger,
    });
    queueConnection = new Redis(redis.connectionUrl, { maxRetriesPerRequest: null });
    workerConnection = new Redis(redis.connectionUrl, { maxRetriesPerRequest: null });
    collectorDeps = {
      db: db(),
      connect: baseDeps.connect,
      createRedactor: baseDeps.createRedactor,
      logger,
      intervalMs: 60_000,
      retentionHours: 168,
      redis: queueConnection,
    };
    // The crash loop starts last, so the first tick sees its earliest restarts.
    await runManaged(ids.crash, '--restart on-failure', crashImage);
    await waitFor('the crash-loop fixture to restart', async () => Number(await inspect(ids.crash, '{{.RestartCount}}')) >= 1);
  }, STACK_TIMEOUT_MS);

  afterAll(async () => {
    const [stk, pg, rd] = await Promise.all([
      stack ?? settleWithin(stackStart, PENDING_START_WAIT_MS),
      postgres ?? settleWithin(pgStart, PENDING_START_WAIT_MS),
      redis ?? settleWithin(redisStart, PENDING_START_WAIT_MS),
    ]);
    await runTeardown(
      `metrics collector (Ubuntu ${ubuntu})`,
      [
        {
          name: 'remove fixture containers',
          run: async () => {
            if (stk === undefined) return;
            for (const name of startedContainers) await stk.exec(['docker', 'rm', '-f', name], { user: 'root' }).catch(() => undefined);
          },
        },
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
    'A1, A2: one session per CONNECTED server per tick; host and managed containers written together; the unreachable server writes nothing',
    async () => {
      const port = s().ssh.port;
      const connectsBefore = connects.filter((p) => p === port).length;
      const summary = await tick();

      expect(connects.filter((p) => p === port).length - connectsBefore).toBe(1);
      expect(summary.outcomes).toMatchObject({ [ids.server]: 'sampled', [ids.unreachableServer]: 'unreachable' });
      expect(await hostSamplesOf(ids.server)).toBe(1);
      expect(await hostSamplesOf(ids.unreachableServer)).toBe(0);

      const [host] = await db().select().from(hostMetricSamples).where(eq(hostMetricSamples.serverId, ids.server));
      const containerRows = await db().select().from(containerMetricSamples);
      expect(new Set(containerRows.map((row) => row.serviceId))).toEqual(new Set([ids.running, ids.crash, ids.oom]));
      for (const row of containerRows) expect(row.sampledAt.getTime()).toBe(host?.sampledAt.getTime());
      expect(host?.memoryTotalBytes).toBeGreaterThan(0);
      const running = containerRows.find((row) => row.serviceId === ids.running);
      expect(running).toMatchObject({ running: true, memoryLimitBytes: 64 * 1024 * 1024 });
      expect(running?.memoryUsedBytes).toBeGreaterThan(0);

      const [unreachable] = await db().select({ lastSeenAt: servers.lastSeenAt }).from(servers).where(eq(servers.id, ids.unreachableServer));
      const [reached] = await db().select({ lastSeenAt: servers.lastSeenAt }).from(servers).where(eq(servers.id, ids.server));
      expect(unreachable?.lastSeenAt ?? null).toBeNull();
      expect(reached?.lastSeenAt?.getTime()).toBe(host?.sampledAt.getTime());
    },
    CASE_TIMEOUT_MS,
  );

  it(
    'A3: observations are stored on change; a new OOM and a new crash loop write one system event each, with ids and the diagnosis only',
    async () => {
      const oomEvents = await incidentsOf(ids.oom);
      expect(oomEvents).toHaveLength(1);
      expect(oomEvents[0]).toMatchObject({ actorType: 'system', entityType: 'service', entityId: ids.oom });
      expect(oomEvents[0]?.metadata).toEqual({ serverId: ids.server, observedState: 'out_of_memory' });

      const [first] = await db()
        .select({ restartCount: containerObservations.restartCount })
        .from(containerObservations)
        .where(eq(containerObservations.serviceId, ids.crash));
      const seen = first?.restartCount ?? 0;
      await waitFor('three more restarts', async () => Number(await inspect(ids.crash, '{{.RestartCount}}')) >= seen + 3);
      await tick();
      const crashEvents = await incidentsOf(ids.crash);
      expect(crashEvents).toHaveLength(1);
      expect(crashEvents[0]?.metadata).toEqual({ serverId: ids.server, observedState: 'crash_loop' });

      // Nothing new on the next tick: the running and OOM containers have not changed.
      const before = await db().select({ serviceId: containerObservations.serviceId }).from(containerObservations);
      await tick();
      const after = await db().select({ serviceId: containerObservations.serviceId }).from(containerObservations);
      const added = after.length - before.length;
      expect(after.filter((row) => row.serviceId === ids.running)).toHaveLength(1);
      expect(after.filter((row) => row.serviceId === ids.oom)).toHaveLength(1);
      expect(added).toBeLessThanOrEqual(1);
      expect(await incidentsOf(ids.oom)).toHaveLength(1);
      expect(await incidentsOf(ids.crash)).toHaveLength(1);
      expect(JSON.stringify(logs)).not.toContain(canary);
    },
    CASE_TIMEOUT_MS,
  );

  it(
    'H1: a server whose connection a deploy holds is skipped; two workers never run the same tick',
    async () => {
      const port = s().ssh.port;
      const [deployment] = await db()
        .insert(deployments)
        .values({
          serviceId: ids.running,
          status: 'BUILDING',
          source: { type: 'git', repositoryUrl: 'https://example.invalid/metrics.git', branch: 'main' },
        })
        .returning({ id: deployments.id });
      if (!deployment) throw new Error('deployment insert returned no row');
      try {
        const connectsBefore = connects.filter((p) => p === port).length;
        const samplesBefore = await hostSamplesOf(ids.server);
        const summary = await tick();
        expect(summary.outcomes[ids.server]).toBe('busy');
        expect(connects.filter((p) => p === port).length).toBe(connectsBefore);
        expect(await hostSamplesOf(ids.server)).toBe(samplesBefore);
      } finally {
        await db().update(deployments).set({ status: 'FAILED' }).where(eq(deployments.id, deployment.id));
      }

      const workerA = rt().createWorkerCollectorTick(deps());
      const workerB = rt().createWorkerCollectorTick(deps());
      const runs = await Promise.all([workerA(), workerB()]);
      expect(runs.filter((run) => run.ran)).toHaveLength(1);
      // The lock is released: the next tick runs.
      expect((await workerB()).ran).toBe(true);

      const allowed = new Set([
        'serverId',
        'serviceId',
        'errorKind',
        'diagnosis',
        'parseErrors',
        'servers',
        'sampled',
        'unreachable',
        'busy',
        'deadline',
        'failed',
        'containers',
        'incidents',
        'pruned',
      ]);
      for (const entry of logs) for (const key of Object.keys(entry.fields)) expect(allowed.has(key)).toBe(true);
      expect(JSON.stringify(logs)).not.toContain(canary);
    },
    CASE_TIMEOUT_MS,
  );

  it(
    'A1: the repeatable job samples on its own, never overlapping',
    async () => {
      if (queueConnection === undefined || workerConnection === undefined) throw new Error('redis not connected');
      const before = await hostSamplesOf(ids.server);
      const loop = await rt().startWorkerCollector({ ...deps(), intervalMs: 3_000, queueConnection, workerConnection });
      try {
        await waitFor('two scheduled ticks', async () => (await hostSamplesOf(ids.server)) - before >= 2);
      } finally {
        await loop.close();
      }
      const rows = await db()
        .select({ sampledAt: hostMetricSamples.sampledAt })
        .from(hostMetricSamples)
        .where(eq(hostMetricSamples.serverId, ids.server))
        .orderBy(hostMetricSamples.sampledAt);
      const times = rows.map((row) => row.sampledAt.getTime());
      expect(new Set(times).size).toBe(times.length);
    },
    CASE_TIMEOUT_MS,
  );

  it(
    'H2: a parse-error observation is stored next to the host sample (database contract)',
    async () => {
      if (store === undefined) throw new Error('modules not loaded');
      const at = new Date();
      await store.writeServerTick(db(), {
        serverId: ids.server,
        sampledAt: at,
        host: { cpuPercent: 1, memoryTotalBytes: 100, memoryUsedBytes: 10, diskUsedPercent: 5, filesystems: [], uptimeSeconds: 1 },
        containers: [],
        observations: [{ kind: 'parse_error', serviceId: ids.running, containerId: null }],
        incidents: [],
      });
      const [row] = await db()
        .select()
        .from(containerObservations)
        .where(and(eq(containerObservations.serviceId, ids.running), eq(containerObservations.observedAt, at)));
      expect(row).toMatchObject({ parseError: 'CONTAINER_SAMPLE_MALFORMED', status: null });
      // A parse error never becomes the last known state.
      const last = await store.loadLastContainerStates(db(), [ids.running]);
      expect(last.get(ids.running)?.state.status).toBe('running');
    },
    CASE_TIMEOUT_MS,
  );

  it(
    'A4: retention prunes in bounded batches; a simulated week of ticks keeps the tables bounded and the last state',
    async () => {
      if (store === undefined) throw new Error('modules not loaded');
      const { pruneMetrics } = store;
      const retentionHours = 24;
      const perHour = 60;
      const start = Date.now() - 400 * HOUR_MS;
      const hostCount = async () => (await db().select({ n: count() }).from(hostMetricSamples))[0]?.n ?? 0;

      // Bounded batches: 3 batches of 50 per call, the rest waits for later calls.
      await db().execute(sql`DELETE FROM host_metric_samples`);
      await db().insert(hostMetricSamples).values(
        Array.from({ length: 400 }, (_, i) => ({
          serverId: ids.server,
          sampledAt: new Date(start + i * 1_000),
          cpuPercent: 1,
          memoryTotalBytes: 100,
          memoryUsedBytes: 10,
          diskUsedPercent: 1,
          uptimeSeconds: 1,
        })),
      );
      const capped = await pruneMetrics(db(), new Date(), { batchSize: 50, maxBatches: 3 });
      // Host rows: 150 of 400 (other tables count towards `deleted` too).
      expect(capped.capped).toBe(true);
      expect(await hostCount()).toBe(250);
      await db().execute(sql`DELETE FROM host_metric_samples`);

      // A week of hourly ticks, one sample per minute and an observation per hour.
      let maxRows = 0;
      for (let hour = 0; hour < 7 * 24; hour += 1) {
        const tickAt = start + hour * HOUR_MS;
        await db().insert(hostMetricSamples).values(
          Array.from({ length: perHour }, (_, minute) => ({
            serverId: ids.server,
            sampledAt: new Date(tickAt - minute * 60_000),
            cpuPercent: 1,
            memoryTotalBytes: 100,
            memoryUsedBytes: 10,
            diskUsedPercent: 1,
            uptimeSeconds: 1,
          })),
        );
        await db().insert(containerObservations).values({
          serviceId: ids.oom,
          containerId: 'f'.repeat(64),
          observedAt: new Date(tickAt),
          status: 'exited',
          restartCount: hour,
        });
        await pruneMetrics(db(), new Date(tickAt - retentionHours * HOUR_MS));
        maxRows = Math.max(maxRows, await hostCount());
      }
      expect(maxRows).toBeLessThanOrEqual((retentionHours + 1) * perHour);
      const observations = await db()
        .select({ restartCount: containerObservations.restartCount })
        .from(containerObservations)
        .where(eq(containerObservations.serviceId, ids.oom));
      // The window's hourly rows plus the real (latest) OOM observation, which is always kept.
      expect(observations.length).toBeLessThanOrEqual(retentionHours + 2);
      expect(Math.max(...observations.map((row) => row.restartCount))).toBe(7 * 24 - 1);

      // Pruning far past every row still keeps each service's latest state observation.
      await pruneMetrics(db(), new Date(Date.now() + HOUR_MS));
      const kept = await store.loadLastContainerStates(db(), [ids.oom, ids.running]);
      // The real OOM observation is newer than every synthetic one.
      expect(kept.get(ids.oom)?.state.oomKilled).toBe(true);
      expect(kept.has(ids.running)).toBe(true);
    },
    CASE_TIMEOUT_MS,
  );
});
