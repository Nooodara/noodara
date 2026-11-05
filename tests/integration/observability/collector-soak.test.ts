// 31-02 (A1): metrics collector soak on the real sshd + dockerd fixture. Several server rows (all
// on the one fixture sshd) with several managed containers each, ticked through the worker
// composition (collector-runtime, real Redis tick lock) on a simulated clock, one interval per tick.
// - Part A: NOODARA_SOAK_REAL_TICKS fully real ticks (real probes, ~1-3 s each).
// - Part B: NOODARA_SOAK_TICKS ticks with a real SSH connect + close per server, where the host and
//   container probes replay the stdout recorded in Part A (a real probe costs >= 1 s, so thousands
//   of real probes do not fit a gate; see .planning/DECISIONS.md).
// Checked: sample tables stay within the retention window, every opened session is closed after
// each tick, no sshd session or deploy-user process is left, no handle growth, each tick's wall time
// stays under the interval and the tick deadline. A JSON artifact goes to
// NOODARA_METRICS_SOAK_ARTIFACT_DIR (default <os tmpdir>/noodara-metrics-soak-artifacts).
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { count, eq } from 'drizzle-orm';
import { Redis } from 'ioredis';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createRedactor, secretValue } from '@noodara/domain/security';
import { createSsh2Adapter, formatFingerprint, type SshDeploySession, type StreamResult } from '@noodara/ssh';
import {
  containerMetricSamples,
  containerObservations,
  credentials,
  environments,
  hostMetricSamples,
  projects,
  servers,
  services,
} from '../../../apps/control-plane/src/db/schema/index.js';
import { DEPLOY_ENGINE_UBUNTU_VERSIONS, startDeployEngineStack, type DeployEngineStack } from '../helpers/deploy-engine.js';
import { countHandles, handleGrowth, summarizeLatency, type HandleCounts, type HandleInfo, type LatencySummary } from '../helpers/domain-cycles.js';
import { startPostgres, type PostgresFixture } from '../helpers/postgres.js';
import { startRedis, type RedisFixture } from '../helpers/redis.js';
import { assertNoStrayTestContainers } from '../helpers/ssh.js';
import { runTeardown, settleWithin } from '../helpers/teardown.js';

type DeployRuntimeModule = typeof import('../../../apps/control-plane/src/deploy/deploy-runtime.js');
type RuntimeModule = typeof import('../../../apps/control-plane/src/observability/collector-runtime.js');
type CredentialStoreModule = typeof import('../../../apps/control-plane/src/services/credential-store.js');
type SshModule = typeof import('@noodara/ssh');
type SecurityModule = typeof import('@noodara/domain/security');
type WorkerCollectorDeps = Parameters<RuntimeModule['createWorkerCollectorTick']>[0];
type ConnectFn = WorkerCollectorDeps['connect'];
type StreamCommand = Parameters<SshDeploySession['stream']>[0];
type StreamOptions = Parameters<SshDeploySession['stream']>[1];

function envFlag(name: string): boolean {
  const value = process.env[name];
  return value === '1' || value === 'true';
}
function envInt(name: string, fallback: number): number {
  const value = Number(process.env[name]);
  return Number.isInteger(value) && value > 0 ? value : fallback;
}

const STRESS_ENABLED = envFlag('NOODARA_STRESS');
const REAL_TICKS = envInt('NOODARA_SOAK_REAL_TICKS', 20);
const REPLAYED_TICKS = envInt('NOODARA_SOAK_TICKS', 2000);
const ARTIFACT_DIR = process.env['NOODARA_METRICS_SOAK_ARTIFACT_DIR'] ?? path.join(tmpdir(), 'noodara-metrics-soak-artifacts');

const SERVER_COUNT = 4;
const SERVICES_PER_SERVER = 3;
const SERVICE_COUNT = SERVER_COUNT * SERVICES_PER_SERVER;
/** DEFAULT_METRICS_INTERVAL_MS: one simulated interval per tick. */
const INTERVAL_MS = 60_000;
const RETENTION_HOURS = 1;
/** Rows inside the retention window: sampled_at >= now - 1 h, one per interval, both ends kept. */
const WINDOW_ROWS = (RETENTION_HOURS * 3_600_000) / INTERVAL_MS + 1;
/** Each service's latest state is always kept; a stable container writes one more at most. */
const MAX_OBSERVATIONS = SERVICE_COUNT * 2;
const CHECK_EVERY = 25;
const KEY_VERSION = 1;
const PG_POOL_MAX = 10;
const STACK_TIMEOUT_MS = 900_000;
const PENDING_START_WAIT_MS = 180_000;
const TEARDOWN_STEP_TIMEOUT_MS = 30_000;
const FIXTURE_STOP_TIMEOUT_MS = 60_000;
const STACK_STOP_TIMEOUT_MS = 300_000;
const LEAK_DEADLINE_MS = 30_000;
const POLL_MS = 250;
const STDOUT_TAIL_BYTES = 8_192;
const REPLAYED_COMMANDS = new Set(['metrics.host_sample', 'docker.stats']);

/**
 * The n-th spelling of the fixture's host: servers are unique on (host, port), and DNS names are
 * case-insensitive, so each server row reaches the same sshd under its own spelling.
 */
function hostAlias(host: string, n: number): string {
  if (n === 0) return host;
  const letters = [...host].map((ch, i) => (/[a-z]/i.test(ch) ? i : -1)).filter((i) => i >= 0);
  if (letters.length < n) throw new Error(`cannot spell ${host} ${String(n + 1)} ways`);
  const flip = new Set(letters.slice(0, n));
  return [...host].map((ch, i) => (flip.has(i) ? (ch === ch.toUpperCase() ? ch.toLowerCase() : ch.toUpperCase()) : ch)).join('');
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** This process's libuv handles, reduced to type and peer port. */
function activeHandles(): HandleInfo[] {
  const getter = (process as unknown as { _getActiveHandles?: () => unknown[] })._getActiveHandles;
  if (getter === undefined) throw new Error('process._getActiveHandles is not available');
  return getter.call(process).map((handle) => {
    const named = handle as { constructor?: { name?: string }; remotePort?: unknown };
    return {
      type: named.constructor?.name ?? 'unknown',
      remotePort: typeof named.remotePort === 'number' ? named.remotePort : undefined,
    };
  });
}

interface SoakArtifact {
  ubuntu: string;
  servers: number;
  services: number;
  intervalMs: number;
  retentionHours: number;
  realTicks: number;
  replayedTicks: number;
  tickMs: { real: LatencySummary | null; replayed: LatencySummary | null };
  maxRows: { hostPerServer: number; containerPerService: number; observations: number };
  sessions: { opened: number; closed: number };
  logs: { info: number; warn: number; error: number };
  baseline: { handles: HandleCounts; sshdSessions: number } | null;
  final: { handles: HandleCounts; sshdSessions: number; deployUserProcesses: string[] } | null;
  problems: string[];
}

describe.skipIf(!STRESS_ENABLED)(`31-02 soak: metrics collector over ${String(SERVER_COUNT)} servers`, () => {
  describe.each(DEPLOY_ENGINE_UBUNTU_VERSIONS)('Ubuntu %s', (ubuntu) => {
    let stack: DeployEngineStack | undefined;
    let stackStart: Promise<DeployEngineStack> | undefined;
    let pgStart: Promise<PostgresFixture> | undefined;
    let redisStart: Promise<RedisFixture> | undefined;
    let postgres: PostgresFixture | undefined;
    let redis: RedisFixture | undefined;
    let lockConnection: Redis | undefined;
    let runtime: RuntimeModule | undefined;
    let credentialStore: CredentialStoreModule | undefined;
    let baseConnect: ConnectFn | undefined;
    let appRedactor: WorkerCollectorDeps['createRedactor'] | undefined;

    const masterKey = randomBytes(32);
    const startedContainers: string[] = [];
    const serverIds: string[] = [];
    const serviceIds: string[] = [];
    let fingerprint = '';
    let projectId = '';
    let environmentId = '';

    /** Simulated clock: every `now()` of a tick reads the tick's time. */
    const totalTicks = REAL_TICKS + REPLAYED_TICKS;
    let clockMs = Date.now() - (totalTicks + 10) * INTERVAL_MS;
    const sessions = { opened: 0, closed: 0 };
    const logCounts = { info: 0, warn: 0, error: 0 };
    const errorLogs: { fields: Record<string, unknown>; message: string }[] = [];
    /** Last stdout of each replayed probe, recorded from the real ticks. */
    const recorded = new Map<string, string[]>();
    let replay = false;
    const realTickMs: number[] = [];
    const replayedTickMs: number[] = [];

    const artifactPath = path.join(ARTIFACT_DIR, `metrics-soak-ubuntu-${ubuntu}.json`);
    const artifact: SoakArtifact = {
      ubuntu,
      servers: SERVER_COUNT,
      services: SERVICE_COUNT,
      intervalMs: INTERVAL_MS,
      retentionHours: RETENTION_HOURS,
      realTicks: 0,
      replayedTicks: 0,
      tickMs: { real: null, replayed: null },
      maxRows: { hostPerServer: 0, containerPerService: 0, observations: 0 },
      sessions,
      logs: logCounts,
      baseline: null,
      final: null,
      problems: [],
    };
    const writeArtifact = (): void => {
      artifact.tickMs = {
        real: realTickMs.length === 0 ? null : summarizeLatency(realTickMs),
        replayed: replayedTickMs.length === 0 ? null : summarizeLatency(replayedTickMs),
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
    const root = async (script: string, args: readonly string[] = []): Promise<string> => {
      const result = await s().exec(['bash', '--noprofile', '--norc', '-c', script, 'noodara-test', ...args], { user: 'root' });
      if (result.exitCode !== 0) throw new Error(`exit ${String(result.exitCode)}: ${script.slice(0, 80)}: ${result.stderr}`);
      return result.stdout.trim();
    };

    // Established TCP sessions on the fixture's sshd; a missing `ss` fails instead of reading 0.
    const sshdSessions = async (): Promise<number> => {
      const out = await root("command -v ss >/dev/null || exit 127; ss -tnH state established '( sport = :22 )' | wc -l");
      const n = Number(out);
      if (!Number.isInteger(n)) throw new Error(`unexpected ss output: ${out}`);
      return n;
    };
    // Every process of the deploy user (its sshd session children included): none between ticks.
    const deployUserProcesses = async (): Promise<string[]> => {
      const out = await root(`u=$(id -u -- "$1") || exit 3; ps -e -o uid=,pid=,args= | awk -v u="$u" '$1 == u'`, [s().ssh.user]);
      return out === '' ? [] : out.split('\n');
    };
    const handleCounts = (): HandleCounts => {
      const pgPort = Number(new URL(postgres?.connectionString ?? 'postgres://x:1/').port);
      return countHandles(activeHandles(), { ssh: s().ssh.port, postgres: pgPort });
    };

    /** A session whose observability probes replay recorded stdout (Part B) or record it (Part A). */
    const replaying = (session: SshDeploySession): SshDeploySession => {
      const view = Object.create(session) as SshDeploySession;
      Object.defineProperty(view, 'stream', {
        value: async (command: StreamCommand, options: StreamOptions): Promise<StreamResult> => {
          if (!REPLAYED_COMMANDS.has(command.name)) return session.stream(command, options);
          if (!replay) {
            const chunks: string[] = [];
            const result = await session.stream(command, {
              ...options,
              onChunk: (chunk) => {
                if (chunk.stream === 'stdout') chunks.push(chunk.text);
                options.onChunk(chunk);
              },
            });
            if (result.outcome === 'completed' && result.exitCode === 0) recorded.set(command.name, chunks);
            return result;
          }
          const chunks = recorded.get(command.name);
          if (chunks === undefined) throw new Error(`no recorded output for ${command.name}`);
          if (options.signal?.aborted === true) {
            return { commandName: command.name, outcome: 'aborted', exitCode: null, exitSignal: null, durationMs: 0, totalBytes: 0, truncated: false, stdoutTail: '', stderrTail: '' };
          }
          let seq = 0;
          for (const text of chunks) options.onChunk({ stream: 'stdout', text, seq: seq++, truncatedLine: false });
          const stdout = chunks.join('');
          return {
            commandName: command.name,
            outcome: 'completed',
            exitCode: 0,
            exitSignal: null,
            durationMs: 0,
            totalBytes: Buffer.byteLength(stdout),
            truncated: false,
            stdoutTail: stdout.slice(-STDOUT_TAIL_BYTES),
            stderrTail: '',
          };
        },
      });
      return view;
    };

    /** Real connect + close, counted; the session's probes go through `replaying`. */
    const countingConnect: ConnectFn = async (serverId, redactor, signal) => {
      if (baseConnect === undefined) throw new Error('collector not wired');
      const result = await baseConnect(serverId, redactor, signal);
      if (!result.ok) return result;
      sessions.opened += 1;
      let closed = false;
      return {
        ok: true,
        session: replaying(result.session),
        close: async () => {
          if (!closed) {
            closed = true;
            sessions.closed += 1;
          }
          await result.close();
        },
      };
    };

    const logger = {
      info: () => {
        logCounts.info += 1;
      },
      warn: (fields: Record<string, unknown>, message: string) => {
        logCounts.warn += 1;
        if (errorLogs.length < 20) errorLogs.push({ fields, message });
      },
      error: (fields: Record<string, unknown>, message: string) => {
        logCounts.error += 1;
        if (errorLogs.length < 20) errorLogs.push({ fields, message });
      },
    };

    const collectorDeps = (): WorkerCollectorDeps => {
      if (lockConnection === undefined || postgres === undefined) throw new Error('fixtures not started');
      return {
        db: db(),
        connect: countingConnect,
        createRedactor: appRedactor ?? createRedactor,
        logger,
        intervalMs: INTERVAL_MS,
        retentionHours: RETENTION_HOURS,
        redis: lockConnection,
        now: () => new Date(clockMs),
      };
    };

    const maxPer = async (column: typeof hostMetricSamples.serverId | typeof containerMetricSamples.serviceId, table: typeof hostMetricSamples | typeof containerMetricSamples): Promise<{ max: number; min: number; groups: number }> => {
      const rows = await db().select({ key: column, n: count() }).from(table).groupBy(column);
      const counts = rows.map((row) => row.n);
      return { max: Math.max(0, ...counts), min: counts.length === 0 ? 0 : Math.min(...counts), groups: rows.length };
    };
    const observationCount = async (): Promise<number> => (await db().select({ n: count() }).from(containerObservations))[0]?.n ?? 0;

    const checkBounds = async (): Promise<void> => {
      const host = await maxPer(hostMetricSamples.serverId, hostMetricSamples);
      const container = await maxPer(containerMetricSamples.serviceId, containerMetricSamples);
      const observations = await observationCount();
      artifact.maxRows.hostPerServer = Math.max(artifact.maxRows.hostPerServer, host.max);
      artifact.maxRows.containerPerService = Math.max(artifact.maxRows.containerPerService, container.max);
      artifact.maxRows.observations = Math.max(artifact.maxRows.observations, observations);
      expect(host.max).toBeLessThanOrEqual(WINDOW_ROWS);
      expect(container.max).toBeLessThanOrEqual(WINDOW_ROWS);
      expect(observations).toBeLessThanOrEqual(MAX_OBSERVATIONS);
    };

    const runTick = async (index: number, samples: number[]): Promise<void> => {
      if (runtime === undefined) throw new Error('modules not loaded');
      clockMs += INTERVAL_MS;
      const openedBefore = sessions.opened;
      const started = performance.now();
      const run = await runtime.createWorkerCollectorTick(collectorDeps())();
      const wallMs = performance.now() - started;
      samples.push(wallMs);
      if (!run.ran) throw new Error(`tick ${String(index)} did not take the lock`);
      if (logCounts.error > 0 || logCounts.warn > 0) throw new Error(`tick ${String(index)} logged: ${JSON.stringify(errorLogs)}`);
      expect(wallMs).toBeLessThan(INTERVAL_MS);
      expect(wallMs).toBeLessThan(runtime.collectorDeadlineMs(INTERVAL_MS));
      expect(Object.values(run.value.outcomes)).toEqual(Array.from({ length: SERVER_COUNT }, () => 'sampled'));
      expect(run.value.containers).toBe(SERVICE_COUNT);
      // One session per server, and every opened session closed before the tick returned.
      expect(sessions.opened - openedBefore).toBe(SERVER_COUNT);
      expect(sessions.closed).toBe(sessions.opened);
    };

    beforeAll(async () => {
      vi.resetModules();
      stackStart = startDeployEngineStack({ ubuntu, seedRepositories: [] });
      pgStart = startPostgres();
      redisStart = startRedis();
      const [stackStarted, pgStarted, redisStarted] = await Promise.all([stackStart, pgStart, redisStart]);
      stack = stackStarted;
      postgres = pgStarted;
      redis = redisStarted;

      process.env.NOODARA_MASTER_KEY = masterKey.toString('base64');
      process.env.BETTER_AUTH_SECRET = `metrics-soak-${randomUUID()}-${randomUUID()}`;
      process.env.DATABASE_URL = postgres.connectionString;
      process.env.REDIS_URL = redis.connectionUrl;
      process.env.NOODARA_PUBLIC_URL = 'http://localhost:3000';
      const deployRuntime: DeployRuntimeModule = await import('../../../apps/control-plane/src/deploy/deploy-runtime.js');
      runtime = await import('../../../apps/control-plane/src/observability/collector-runtime.js');
      credentialStore = await import('../../../apps/control-plane/src/services/credential-store.js');
      // After vi.resetModules the app's SecretValue class is a fresh one: the adapter and redactor
      // it is handed must come from the same module graph.
      const appSsh: SshModule = await import('@noodara/ssh');
      const appSecurity: SecurityModule = await import('@noodara/domain/security');

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
        .values({ name: 'soak', slug: `soak-${randomUUID().slice(0, 8)}`, createdAt: now, updatedAt: now })
        .returning({ id: projects.id });
      if (!projectRow) throw new Error('project insert returned no row');
      const [environmentRow] = await db()
        .insert(environments)
        .values({ projectId: projectRow.id, name: 'production', createdAt: now, updatedAt: now })
        .returning({ id: environments.id });
      if (!environmentRow) throw new Error('environment insert returned no row');
      projectId = projectRow.id;
      environmentId = environmentRow.id;

      for (let n = 0; n < SERVER_COUNT; n += 1) {
        const encoded = credentialStore.encodeCredential(
          { kind: 'private_key', privateKey: stack.ssh.privateKey },
          { key: masterKey, version: KEY_VERSION },
          appSecurity.createRedactor(),
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
            name: `soak-host-${String(n)}-${ubuntu}`,
            host: hostAlias(stack.ssh.host, n),
            sshPort: stack.ssh.port,
            sshUser: stack.ssh.user,
            credentialId: credentialRow.id,
            status: 'CONNECTED',
            hostFingerprint: fingerprint,
            dockerInstalled: true,
          })
          .returning({ id: servers.id });
        if (!serverRow) throw new Error('server insert returned no row');
        serverIds.push(serverRow.id);
        for (let k = 0; k < SERVICES_PER_SERVER; k += 1) {
          const [serviceRow] = await db()
            .insert(services)
            .values({
              projectId,
              environmentId,
              serverId: serverRow.id,
              name: `soak-${String(n)}-${String(k)}-${randomUUID().slice(0, 6)}`,
              sourceType: 'git',
              repositoryUrl: 'https://example.invalid/soak.git',
              branch: 'main',
              buildContext: '.',
              dockerfilePath: 'Dockerfile',
              internalPort: 3000,
              publishedPort: null,
              status: 'RUNNING',
            })
            .returning({ id: services.id });
          if (!serviceRow) throw new Error('service insert returned no row');
          serviceIds.push(serviceRow.id);
        }
      }

      const nodeImage = stack.baseImages.find((ref) => ref.startsWith('node:'));
      if (nodeImage === undefined) throw new Error('no node base image preloaded');
      for (const serviceId of serviceIds) {
        const name = `noodara-${serviceId}`;
        await root(
          `docker run --detach --pull never --name "$1" --label noodara.managed=true --label noodara.test=true --memory 48m -- "$2" node -e 'setInterval(() => {}, 1000)' >/dev/null`,
          [name, nodeImage],
        );
        startedContainers.push(name);
      }

      const baseDeps = deployRuntime.createDeployJobDeps({
        db: db(),
        events: { publish: () => Promise.resolve() },
        ssh: appSsh.createSsh2Adapter(),
        timeouts: { connectMs: 20_000, commandMs: 45_000, discoveryMs: 120_000 },
        masterKeys: () => Promise.resolve({ current: masterKey }),
        panelPorts: [],
        config: { deployMaxMs: 300_000, idleMs: 120_000, logMaxBytes: 1_048_576, logLineMaxBytes: 16_384 },
        logger,
      });
      baseConnect = baseDeps.connect;
      appRedactor = baseDeps.createRedactor;
      lockConnection = new Redis(redis.connectionUrl, { maxRetriesPerRequest: null });
    }, STACK_TIMEOUT_MS);

    afterAll(async () => {
      if (artifact.realTicks > 0 || artifact.problems.length > 0) writeArtifact();
      const [stk, pg, rd] = await Promise.all([
        stack ?? settleWithin(stackStart, PENDING_START_WAIT_MS),
        postgres ?? settleWithin(pgStart, PENDING_START_WAIT_MS),
        redis ?? settleWithin(redisStart, PENDING_START_WAIT_MS),
      ]);
      await runTeardown(
        `metrics soak (Ubuntu ${ubuntu})`,
        [
          {
            name: 'remove fixture containers',
            run: async () => {
              if (stk === undefined) return;
              for (const name of startedContainers) await stk.exec(['docker', 'rm', '-f', name], { user: 'root' }).catch(() => undefined);
            },
          },
          { name: 'disconnect redis', run: () => lockConnection?.disconnect() },
          { name: 'redis.stop', run: () => rd?.stop(), timeoutMs: FIXTURE_STOP_TIMEOUT_MS },
          { name: 'postgres.stop', run: () => pg?.stop(), timeoutMs: FIXTURE_STOP_TIMEOUT_MS },
          { name: 'stack.stop', run: () => stk?.stop(), timeoutMs: STACK_STOP_TIMEOUT_MS },
        ],
        { stepTimeoutMs: TEARDOWN_STEP_TIMEOUT_MS },
      );
      await assertNoStrayTestContainers();
    }, STACK_TIMEOUT_MS);

    it(
      `A1: ${String(REAL_TICKS)} real ticks sample every server and container within the interval`,
      async () => {
        // Handles last: the docker exec behind the probes keeps its own socket to the daemon.
        const sshdBefore = await sshdSessions();
        expect(await deployUserProcesses()).toEqual([]);
        artifact.baseline = { handles: handleCounts(), sshdSessions: sshdBefore };
        for (let i = 0; i < REAL_TICKS; i += 1) {
          await runTick(i, realTickMs);
          artifact.realTicks += 1;
          if ((i + 1) % CHECK_EVERY === 0) await checkBounds();
        }
        await checkBounds();
        expect(recorded.size).toBe(REPLAYED_COMMANDS.size);
        // Real samples landed: every server and every service has rows.
        expect((await maxPer(hostMetricSamples.serverId, hostMetricSamples)).groups).toBe(SERVER_COUNT);
        expect((await maxPer(containerMetricSamples.serviceId, containerMetricSamples)).groups).toBe(SERVICE_COUNT);
      },
      REAL_TICKS * 30_000 + 60_000,
    );

    it(
      `A1: ${String(REPLAYED_TICKS)} more ticks (real connects, replayed probes) keep the tables within the retention window`,
      async () => {
        replay = true;
        for (let i = 0; i < REPLAYED_TICKS; i += 1) {
          await runTick(REAL_TICKS + i, replayedTickMs);
          artifact.replayedTicks += 1;
          if ((i + 1) % CHECK_EVERY === 0) await checkBounds();
        }
        await checkBounds();
        if (totalTicks >= WINDOW_ROWS) {
          // Exactly the window: pruning keeps up tick for tick.
          const host = await maxPer(hostMetricSamples.serverId, hostMetricSamples);
          const container = await maxPer(containerMetricSamples.serviceId, containerMetricSamples);
          expect(host).toEqual({ max: WINDOW_ROWS, min: WINDOW_ROWS, groups: SERVER_COUNT });
          expect(container).toEqual({ max: WINDOW_ROWS, min: WINDOW_ROWS, groups: SERVICE_COUNT });
        }
        const [oldest] = await db()
          .select({ sampledAt: hostMetricSamples.sampledAt })
          .from(hostMetricSamples)
          .where(eq(hostMetricSamples.serverId, serverIds[0] ?? ''))
          .orderBy(hostMetricSamples.sampledAt)
          .limit(1);
        expect(oldest?.sampledAt.getTime()).toBeGreaterThanOrEqual(clockMs - RETENTION_HOURS * 3_600_000);
      },
      REPLAYED_TICKS * 5_000 + 60_000,
    );

    it(
      'A1: no SSH session, deploy-user process or handle is left after the soak',
      async () => {
        expect(sessions.closed).toBe(sessions.opened);
        expect(sessions.opened).toBe(totalTicks * SERVER_COUNT);
        const baseline = artifact.baseline;
        if (baseline === null) throw new Error('no baseline');
        const deadline = Date.now() + LEAK_DEADLINE_MS;
        let problems: string[] = [];
        for (;;) {
          const sshd = await sshdSessions();
          const procs = await deployUserProcesses();
          const handles = handleCounts();
          artifact.final = { handles, sshdSessions: sshd, deployUserProcesses: procs };
          problems = [
            ...handleGrowth(baseline.handles, handles, PG_POOL_MAX),
            ...(sshd > baseline.sshdSessions ? [`${String(sshd - baseline.sshdSessions)} sshd sessions left open`] : []),
            ...(procs.length > 0 ? [`${String(procs.length)} deploy-user processes left`] : []),
          ];
          if (problems.length === 0 || Date.now() > deadline) break;
          await delay(POLL_MS);
        }
        artifact.problems.push(...problems);
        expect(problems).toEqual([]);
        expect(artifact.final?.sshdSessions).toBe(0);
      },
      LEAK_DEADLINE_MS + 60_000,
    );
  });
});
