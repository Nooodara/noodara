// 12-15 (A1-A4, H1): the reconciliation tick on the real sshd + dockerd fixture, through the same
// composition src/worker.ts runs (reconcile-wiring). Containers are started and stopped "outside
// Noodara" as root with `stack.exec`; the SSH adapter is wrapped to count connects and commands.
// App modules are imported dynamically after a valid test env is written: several of them import
// env.ts, which fail-fasts at import time (INST-06).
import { randomBytes, randomUUID } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
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
import {
  DEPLOY_ENGINE_UBUNTU_VERSIONS,
  resolveBaseImages,
  startDeployEngineStack,
  type DeployEngineStack,
} from '../helpers/deploy-engine.js';
import { startPostgres, type PostgresFixture } from '../helpers/postgres.js';
import { startRedis, type RedisFixture } from '../helpers/redis.js';

type DeployRuntimeModule = typeof import('../../../apps/control-plane/src/deploy/deploy-runtime.js');
type ReconcileWiringModule = typeof import('../../../apps/control-plane/src/reconcile/reconcile-wiring.js');
type CredentialStoreModule = typeof import('../../../apps/control-plane/src/services/credential-store.js');
type ServiceServicesModule = typeof import('../../../apps/control-plane/src/services/service-services.js');
type SshAdapter = ReturnType<typeof createSsh2Adapter>;
type ConnectOptions = Parameters<SshAdapter['connect']>[0];
type DeployJobDeps = ReturnType<DeployRuntimeModule['createDeployJobDeps']>;

const STACK_TIMEOUT_MS = 900_000;
const CASE_TIMEOUT_MS = 300_000;
const WAIT_MS = 120_000;
const POLL_MS = 250;
const KEY_VERSION = 1;
const COMMAND_MS = 45_000;
const INTERVAL_MS = 5_000;
const CHANGED = 'service.container_changed';
/** Nothing listens on these: connecting is refused at once. */
const UNREACHABLE = { host: '127.0.0.1', port: 1 } as const;
const PENDING_TARGET = { host: '127.0.0.1', port: 2 } as const;

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function nodeBaseOf(baseImages: readonly string[]): string {
  const base = baseImages.find((ref) => ref.startsWith('node:'));
  if (base === undefined) throw new Error('harness preloaded no node base image');
  return base;
}

interface RecordedCall {
  readonly port: number;
  readonly method: string;
  readonly command: string;
  readonly maxDurationMs: unknown;
}

/** Finds the first option bag carrying maxDurationMs among a session call's arguments. */
function maxDurationOf(args: readonly unknown[]): unknown {
  for (const arg of args) {
    if (typeof arg === 'object' && arg !== null && 'maxDurationMs' in arg) {
      return arg.maxDurationMs;
    }
  }
  return undefined;
}

describe.each(DEPLOY_ENGINE_UBUNTU_VERSIONS)(
  '12-15 / A1-A4: reconciliation tick on real infrastructure, Ubuntu %s',
  (ubuntu) => {
    let stack: DeployEngineStack | undefined;
    let postgres: PostgresFixture | undefined;
    let redis: RedisFixture | undefined;
    let queueConnection: Redis | undefined;
    let workerConnection: Redis | undefined;
    let wiring: ReconcileWiringModule | undefined;
    let credentialStore: CredentialStoreModule | undefined;
    let serviceServices: ServiceServicesModule | undefined;
    let reconcileDeps: Omit<Parameters<ReconcileWiringModule['startWorkerReconcile']>[0], 'intervalMs'> | undefined;
    let reconcile: { tick: () => Promise<unknown>; close(): Promise<void> } | undefined;

    const masterKey = randomBytes(32);
    const events: ServerEvent[] = [];
    const calls: RecordedCall[] = [];
    const connects: number[] = [];
    const startedContainers: string[] = [];
    let fingerprint = '';
    let nodeBase = '';
    const ids = {
      project: '',
      server: '',
      unreachableServer: '',
      pendingServer: '',
      fresh: '',
      steady: '',
      building: '',
      unreachable: '',
      pending: '',
    };

    const s = (): DeployEngineStack => {
      if (stack === undefined) throw new Error('stack not started');
      return stack;
    };
    const db = (): PostgresFixture['db'] => {
      if (postgres === undefined) throw new Error('postgres not started');
      return postgres.db;
    };
    const tick = async (): Promise<unknown> => {
      if (reconcile === undefined) throw new Error('reconcile not wired');
      return reconcile.tick();
    };
    const root = (argv: readonly string[]) => s().exec(argv, { user: 'root' });
    const containerName = (serviceId: string): string => `noodara-${serviceId}`;

    const waitFor = async (what: string, check: () => Promise<boolean>, timeoutMs = WAIT_MS): Promise<void> => {
      const deadline = Date.now() + timeoutMs;
      for (;;) {
        if (await check()) return;
        if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
        await delay(POLL_MS);
      }
    };

    /** Wraps the adapter: records connect ports and every session method call (name, command, limits). */
    const recordingAdapter = (inner: SshAdapter): SshAdapter => ({
      ...inner,
      async connect(options: ConnectOptions) {
        const port = options.target.port;
        connects.push(port);
        const result = await inner.connect(options);
        if (!result.ok) return result;
        const session = new Proxy(result.session, {
          get(target, prop, receiver) {
            const value: unknown = Reflect.get(target, prop, receiver);
            if (typeof value !== 'function') return value;
            const method = String(prop);
            return (...args: unknown[]) => {
              if (method !== 'close') {
                calls.push({
                  port,
                  method,
                  command: JSON.stringify(args[0]),
                  maxDurationMs: maxDurationOf(args),
                });
              }
              return (value as (...a: unknown[]) => unknown).apply(target, args);
            };
          },
        });
        return { ...result, session };
      },
    });

    const insertServer = async (
      name: string,
      target: { host: string; port: number },
      status: 'CONNECTED' | 'PENDING',
    ): Promise<string> => {
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
          status,
          hostFingerprint: fingerprint,
          dockerInstalled: true,
        })
        .returning({ id: servers.id });
      if (!serverRow) throw new Error('server insert returned no row');
      return serverRow.id;
    };

    const insertProject = async (): Promise<{ projectId: string; environmentId: string }> => {
      const now = new Date();
      const [projectRow] = await db()
        .insert(projects)
        .values({ name: 'reconcile', slug: `rec-${randomUUID().slice(0, 8)}`, createdAt: now, updatedAt: now })
        .returning({ id: projects.id });
      if (!projectRow) throw new Error('project insert returned no row');
      const [environmentRow] = await db()
        .insert(environments)
        .values({ projectId: projectRow.id, name: 'production', createdAt: now, updatedAt: now })
        .returning({ id: environments.id });
      if (!environmentRow) throw new Error('environment insert returned no row');
      return { projectId: projectRow.id, environmentId: environmentRow.id };
    };

    /** A service whose latest deployment is `deploymentStatus`, with `cached` as its status cache. */
    const insertService = async (input: {
      readonly projectId: string;
      readonly environmentId: string;
      readonly serverId: string;
      readonly cached: 'RUNNING' | 'STOPPED';
      readonly deploymentStatus: 'SUCCESS' | 'BUILDING';
    }): Promise<string> => {
      const [row] = await db()
        .insert(services)
        .values({
          projectId: input.projectId,
          environmentId: input.environmentId,
          serverId: input.serverId,
          name: `svc-${randomUUID().slice(0, 8)}`,
          sourceType: 'git',
          repositoryUrl: 'https://example.invalid/reconcile.git',
          branch: 'main',
          buildContext: '.',
          dockerfilePath: 'Dockerfile',
          internalPort: 3000,
          publishedPort: null,
          status: input.cached,
        })
        .returning({ id: services.id });
      if (!row) throw new Error('service insert returned no row');
      await db()
        .insert(deployments)
        .values({
          serviceId: row.id,
          status: input.deploymentStatus,
          source: { type: 'git', repositoryUrl: 'https://example.invalid/reconcile.git', branch: 'main' },
        });
      return row.id;
    };

    const startContainer = async (serviceId: string): Promise<void> => {
      const name = containerName(serviceId);
      const result = await root([
        'docker',
        'run',
        '-d',
        '--name',
        name,
        '--label',
        'noodara.managed=true',
        '--label',
        'noodara.test=true',
        nodeBase,
        'node',
        '-e',
        'setInterval(() => {}, 1000)',
      ]);
      if (result.exitCode !== 0) throw new Error(`docker run ${name} failed: ${result.stderr}`);
      startedContainers.push(name);
    };

    const statusOf = async (serviceId: string): Promise<string> => {
      const [row] = await db().select({ status: services.status }).from(services).where(eq(services.id, serviceId));
      if (!row) throw new Error('service missing');
      return row.status;
    };
    const updatesFor = (serviceId: string): string[] =>
      events.flatMap((event) =>
        event.type === 'service.updated' && event.service.id === serviceId ? [event.service.status] : [],
      );
    /** updatedAt carried by every recorded service.updated for this service, in publish order. */
    const updatedAtsFor = (serviceId: string): string[] =>
      events.flatMap((event) =>
        event.type === 'service.updated' && event.service.id === serviceId ? [event.service.updatedAt] : [],
      );
    /** What the snapshot GET (getService) returns as updatedAt for this service right now. */
    const snapshotUpdatedAt = async (serviceId: string): Promise<string> => {
      if (serviceServices === undefined) throw new Error('modules not loaded');
      const view = await serviceServices.getService(
        { db: db(), now: () => new Date(), events: { publish: () => Promise.resolve() }, panelPorts: [] },
        ids.project,
        serviceId,
      );
      if (view === null) throw new Error('service missing from the snapshot');
      return view.updatedAt;
    };
    const ms = (iso: string | undefined): number => {
      if (iso === undefined) throw new Error('no updatedAt recorded');
      return Date.parse(iso);
    };
    const changedActivity = async (serviceId: string) =>
      db()
        .select()
        .from(activityEvents)
        .where(and(eq(activityEvents.entityId, serviceId), eq(activityEvents.action, CHANGED)));

    beforeAll(async () => {
      const [stackStarted, pgStarted, redisStarted] = await Promise.all([
        startDeployEngineStack({ ubuntu, seedRepositories: [] }),
        startPostgres(),
        startRedis(),
      ]);
      stack = stackStarted;
      postgres = pgStarted;
      redis = redisStarted;
      nodeBase = nodeBaseOf(resolveBaseImages());

      process.env.NOODARA_MASTER_KEY = masterKey.toString('base64');
      process.env.BETTER_AUTH_SECRET = `runtime-reconcile-${randomUUID()}-${randomUUID()}`;
      process.env.DATABASE_URL = postgres.connectionString;
      process.env.REDIS_URL = redis.connectionUrl;
      process.env.NOODARA_PUBLIC_URL = 'http://localhost:3000';

      const runtime: DeployRuntimeModule = await import('../../../apps/control-plane/src/deploy/deploy-runtime.js');
      wiring = await import('../../../apps/control-plane/src/reconcile/reconcile-wiring.js');
      credentialStore = await import('../../../apps/control-plane/src/services/credential-store.js');
      serviceServices = await import('../../../apps/control-plane/src/services/service-services.js');

      // Fingerprint pinned from a first trusted connect.
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

      ids.server = await insertServer(`reconcile-host-${ubuntu}`, { host: stack.ssh.host, port: stack.ssh.port }, 'CONNECTED');
      ids.unreachableServer = await insertServer(`reconcile-unreachable-${ubuntu}`, UNREACHABLE, 'CONNECTED');
      ids.pendingServer = await insertServer(`reconcile-pending-${ubuntu}`, PENDING_TARGET, 'PENDING');
      const { projectId, environmentId } = await insertProject();
      ids.project = projectId;
      const base = { projectId, environmentId };
      // fresh: container runs, cache says STOPPED -> A2 writes RUNNING.
      ids.fresh = await insertService({ ...base, serverId: ids.server, cached: 'STOPPED', deploymentStatus: 'SUCCESS' });
      // steady: container runs, cache already RUNNING -> A2 emits nothing.
      ids.steady = await insertService({ ...base, serverId: ids.server, cached: 'RUNNING', deploymentStatus: 'SUCCESS' });
      // building: a deployment is in flight -> H1 skips it, whatever the container says.
      ids.building = await insertService({ ...base, serverId: ids.server, cached: 'STOPPED', deploymentStatus: 'BUILDING' });
      ids.unreachable = await insertService({
        ...base,
        serverId: ids.unreachableServer,
        cached: 'RUNNING',
        deploymentStatus: 'SUCCESS',
      });
      ids.pending = await insertService({ ...base, serverId: ids.pendingServer, cached: 'RUNNING', deploymentStatus: 'SUCCESS' });
      await startContainer(ids.fresh);
      await startContainer(ids.steady);
      await startContainer(ids.building);

      const recordingEvents = {
        publish(event: ServerEvent): Promise<void> {
          events.push(event);
          return Promise.resolve();
        },
      };
      const logger = { info: () => undefined, warn: () => undefined, error: () => undefined };
      const baseDeps: DeployJobDeps = runtime.createDeployJobDeps({
        db: db(),
        events: recordingEvents,
        ssh: recordingAdapter(createSsh2Adapter()),
        timeouts: { connectMs: 20_000, commandMs: COMMAND_MS, discoveryMs: 120_000 },
        masterKeys: () => Promise.resolve({ current: masterKey }),
        panelPorts: [],
        config: { deployMaxMs: 300_000, idleMs: 120_000, logMaxBytes: 1_048_576, logLineMaxBytes: 16_384 },
        logger,
      });
      workerConnection = new Redis(redis.connectionUrl, { maxRetriesPerRequest: null });
      queueConnection = new Redis(redis.connectionUrl, { maxRetriesPerRequest: null });
      reconcileDeps = {
        db: db(),
        connect: baseDeps.connect,
        createRedactor: baseDeps.createRedactor,
        events: recordingEvents,
        logger,
        commandMs: COMMAND_MS,
        queueConnection,
        workerConnection,
      };
      reconcile = wiring.createWorkerReconcileTick(reconcileDeps);
    }, STACK_TIMEOUT_MS);

    afterAll(async () => {
      await reconcile?.close();
      if (stack !== undefined) {
        for (const name of startedContainers) await root(['docker', 'rm', '-f', name]);
      }
      workerConnection?.disconnect();
      queueConnection?.disconnect();
      await redis?.stop();
      await postgres?.stop();
      await stack?.stop();
    }, STACK_TIMEOUT_MS);

    it(
      'A2/A4/H1: a changed state updates the cache and emits once; unreachable -> UNKNOWN; in-flight deploys are skipped',
      async () => {
        const freshBefore = await snapshotUpdatedAt(ids.fresh);
        const unreachableBefore = await snapshotUpdatedAt(ids.unreachable);
        await tick();

        // 13-02 A4: a reconcile-driven service.updated carries the row's post-write updatedAt: never older than
        // the snapshot GET taken before the tick, and exactly what the snapshot GET returns after it.
        for (const [id, before] of [
          [ids.fresh, freshBefore],
          [ids.unreachable, unreachableBefore],
        ] as const) {
          const [published] = updatedAtsFor(id);
          expect(ms(published)).toBeGreaterThanOrEqual(ms(before));
          expect(published).toBe(await snapshotUpdatedAt(id));
        }

        // A2: changed -> written + one service.updated; unchanged -> nothing.
        expect(await statusOf(ids.fresh)).toBe('RUNNING');
        expect(updatesFor(ids.fresh)).toEqual(['RUNNING']);
        expect(await statusOf(ids.steady)).toBe('RUNNING');
        expect(updatesFor(ids.steady)).toEqual([]);
        // H1: an active deployment owns the container and its status.
        expect(await statusOf(ids.building)).toBe('STOPPED');
        expect(updatesFor(ids.building)).toEqual([]);
        // A4: UNKNOWN, never STOPPED, and the reachable server was still reconciled in the same tick.
        expect(await statusOf(ids.unreachable)).toBe('UNKNOWN');
        expect(updatesFor(ids.unreachable)).toEqual(['UNKNOWN']);
        expect(await changedActivity(ids.unreachable)).toHaveLength(0);
        // Only CONNECTED servers are visited.
        expect(connects).not.toContain(PENDING_TARGET.port);
        expect(await statusOf(ids.pending)).toBe('RUNNING');

        // A second tick with nothing changed emits nothing.
        const before = events.length;
        await tick();
        expect(events.length).toBe(before);
        expect(await statusOf(ids.unreachable)).toBe('UNKNOWN');
      },
      CASE_TIMEOUT_MS,
    );

    it(
      'A3: a container stopped or removed outside Noodara shows in the next tick with one activity event, never repeated',
      async () => {
        const steadyBefore = await snapshotUpdatedAt(ids.steady);
        expect((await root(['docker', 'stop', '-t', '1', containerName(ids.steady)])).exitCode).toBe(0);
        await tick();
        expect(await statusOf(ids.steady)).toBe('STOPPED');
        expect(updatesFor(ids.steady)).toEqual(['STOPPED']);
        // 13-02 A4: the discrepancy event carries the post-write updatedAt the snapshot GET then returns.
        const [steadyPublished] = updatedAtsFor(ids.steady);
        expect(ms(steadyPublished)).toBeGreaterThanOrEqual(ms(steadyBefore));
        expect(steadyPublished).toBe(await snapshotUpdatedAt(ids.steady));
        expect(await changedActivity(ids.steady)).toHaveLength(1);

        expect((await root(['docker', 'rm', '-f', containerName(ids.fresh)])).exitCode).toBe(0);
        await tick();
        expect(await statusOf(ids.fresh)).not.toBe('RUNNING');
        expect(updatesFor(ids.fresh)).toHaveLength(2);
        // 13-02 H1: per-entity monotonic, and the latest event matches the snapshot GET.
        const [freshFirst, freshSecond] = updatedAtsFor(ids.fresh);
        expect(ms(freshSecond)).toBeGreaterThan(ms(freshFirst));
        expect(freshSecond).toBe(await snapshotUpdatedAt(ids.fresh));
        expect(await changedActivity(ids.fresh)).toHaveLength(1);

        // Later ticks repeat neither the activity nor the event.
        const before = events.length;
        await tick();
        await tick();
        expect(events.length).toBe(before);
        expect(await changedActivity(ids.steady)).toHaveLength(1);
        expect(await changedActivity(ids.fresh)).toHaveLength(1);
      },
      CASE_TIMEOUT_MS,
    );

    it(
      'A1: the repeatable job runs one docker ps --size=false per CONNECTED server per tick, with the commandMs limit',
      async () => {
        if (wiring === undefined || reconcileDeps === undefined) throw new Error('reconcile not wired');
        const port = s().ssh.port;
        const connectsBefore = connects.filter((p) => p === port).length;
        const callsBefore = calls.filter((c) => c.port === port).length;
        const loop = await wiring.startWorkerReconcile({ ...reconcileDeps, intervalMs: INTERVAL_MS });
        try {
          await waitFor('two reconcile ticks', () =>
            Promise.resolve(connects.filter((p) => p === port).length - connectsBefore >= 2),
          );
          // Let the second tick's command finish before reading.
          await waitFor('the second tick to run its command', () =>
            Promise.resolve(calls.filter((c) => c.port === port).length - callsBefore >= 2),
          );
        } finally {
          await loop.close();
        }

        const ticks = connects.filter((p) => p === port).length - connectsBefore;
        const tickCalls = calls.filter((c) => c.port === port).slice(callsBefore);
        expect(ticks).toBeGreaterThanOrEqual(2);
        // One command per connection, never one per service (3 services live on this server).
        expect(tickCalls).toHaveLength(ticks);
        for (const call of tickCalls) {
          expect(call.command).toContain('ps');
          expect(call.command).toContain('--size=false');
          expect(call.maxDurationMs).toBe(COMMAND_MS);
        }
        expect(connects).not.toContain(PENDING_TARGET.port);
      },
      CASE_TIMEOUT_MS,
    );
  },
);
