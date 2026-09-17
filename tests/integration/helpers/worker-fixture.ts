// Composes startPostgres() + startRedis() with a resolved ServerServicesDeps and starts a real,
// in-process BullMQ worker via the exact same createWorker(deps, options) that worker.ts uses
// (Plan 04-07) — small lockDurationMs/stalledIntervalMs so tests/integration/queue/*.test.ts
// finish in seconds. Reuses service-fixture.ts's fake SshPort/event-recording builders rather than
// duplicating them.
//
// Mirrors tests/integration/services/helpers/service-fixture.ts's env-before-import discipline:
// env.ts fail-fasts by reading process.env at *module import time* (INST-06), so a complete, valid
// test environment is written to process.env before any apps/control-plane/src module is ever
// imported — via dynamic `await import(...)`, never a static top-level import.
import { randomBytes, randomUUID } from 'node:crypto';
import type { FastifyBaseLogger } from 'fastify';
import type { Redis } from 'ioredis';
import type { SshPort } from '@noodara/ssh';
import { startPostgres, type PostgresFixture } from './postgres.js';
import { startRedis } from './redis.js';
import {
  buildUnconfiguredSshPort,
  FIXED_NOW,
  type ServiceFixtureDeps,
  type ServiceFixtureEvent,
  type ServiceFixtureEventPublisher,
} from '../services/helpers/service-fixture.js';

function setTestEnv(connectionString: string, redisUrl: string): void {
  process.env.NOODARA_MASTER_KEY = randomBytes(32).toString('base64');
  process.env.BETTER_AUTH_SECRET = `test-fixture-${randomUUID()}-${randomUUID()}`;
  process.env.DATABASE_URL = connectionString;
  process.env.REDIS_URL = redisUrl;
  process.env.NOODARA_PUBLIC_URL = 'http://localhost:3000';
}

export interface LogRecord {
  readonly level: 'warn' | 'error';
  readonly obj: unknown;
  readonly msg?: string;
}

// This file's own dynamic-import surfaces — resolved lazily, only once a valid test env exists.
type ConnectServerQueueModule = typeof import('../../../apps/control-plane/src/queue/connect-server-queue.js');
export type ConnectServerQueue = ReturnType<ConnectServerQueueModule['createConnectServerQueue']>;

type ConnectServerWorkerModule = typeof import('../../../apps/control-plane/src/queue/connect-server-worker.js');
export type ConnectServerWorkerHandle = ReturnType<ConnectServerWorkerModule['createWorker']>;

export interface WorkerFixtureOptions {
  readonly lockDurationMs?: number;
  readonly stalledIntervalMs?: number;
  readonly concurrency?: number;
}

export interface SpawnedWorker {
  readonly handle: ConnectServerWorkerHandle;
  readonly logs: LogRecord[];
  /** Safe to call more than once. */
  close(): Promise<void>;
}

export interface WorkerFixture {
  readonly db: PostgresFixture['db'];
  readonly deps: ServiceFixtureDeps;
  /** Every `ServerEvent` published through `deps.events` during this fixture's lifetime, in call
   *  order (D-04). */
  readonly events: ServiceFixtureEvent[];
  readonly queue: ConnectServerQueue;
  readonly redisUrl: string;
  /** The fixture's own, auto-started worker — small `lockDurationMs`/`stalledIntervalMs` by
   *  default (Task 1's single-worker suites). */
  readonly worker: ConnectServerWorkerHandle;
  /** Every `warn`/`error` record the primary worker's fake logger received, in call order. */
  readonly logs: LogRecord[];
  /** Swaps the `SshPort` implementation every service call forwards to. */
  setSshPort(port: SshPort): void;
  /** Swaps the `ServerEventPublisher` implementation every service call forwards to. */
  setEventPublisher(publisher: ServiceFixtureEventPublisher): void;
  /** When `true`, every `deps.db.transaction(...)` call rejects immediately — the "inject a deps
   *  whose db rejects" double Task 1's failed-job test needs, without replacing the whole `db`. */
  setDbFailing(shouldFail: boolean): void;
  /** Simulates the primary worker crashing mid-job: hard-disconnects its Redis connection (no
   *  graceful `worker.close()`) so lock renewal stops and a later `stalledInterval` check on
   *  another worker can detect the stall (Task 2). */
  killPrimaryWorker(): Promise<void>;
  /** Starts an additional, independent worker (its own Redis connection, its own fake logger)
   *  against the same queue/deps — used by stalled-recovery tests to simulate a second worker
   *  process recovering a job the first one died mid-flight on. */
  spawnWorker(options?: WorkerFixtureOptions): Promise<SpawnedWorker>;
  /** Safe to call more than once. */
  stop(): Promise<void>;
}

// A minimal structural fake covering only what createWorker/sweepAbandonedConnections actually
// call — cast to FastifyBaseLogger below rather than fabricating the rest of that interface
// (child(), level, silent(), the string-message overloads) just to satisfy TypeScript.
function buildRecordingLogger(): { logger: FastifyBaseLogger; records: LogRecord[] } {
  const records: LogRecord[] = [];
  const noop = (): void => {
    // intentionally empty — info/debug/trace/fatal are not asserted on by any test in this phase
  };
  const fake = {
    warn: (obj: unknown, msg?: string) => {
      records.push({ level: 'warn', obj, msg });
    },
    error: (obj: unknown, msg?: string) => {
      records.push({ level: 'error', obj, msg });
    },
    info: noop,
    debug: noop,
    trace: noop,
    fatal: noop,
  };
  return { logger: fake as unknown as FastifyBaseLogger, records };
}

/** `Worker.close()` can hang if its underlying Redis connection was already hard-disconnected
 *  (exactly what `killPrimaryWorker`/a simulated crash does) — bounded so fixture teardown can
 *  never stall a test suite on a worker that will never finish closing gracefully. */
async function closeWithTimeout(handle: ConnectServerWorkerHandle, timeoutMs = 5000): Promise<void> {
  await Promise.race([
    handle.close().catch(() => undefined),
    new Promise<void>((resolve) => {
      setTimeout(resolve, timeoutMs);
    }),
  ]);
}

async function buildWorker(
  deps: ServiceFixtureDeps,
  queue: ConnectServerQueue,
  redisUrl: string,
  options: WorkerFixtureOptions,
): Promise<{ handle: ConnectServerWorkerHandle; logs: LogRecord[]; workerConnection: Redis }> {
  const { createWorkerRedisConnection } = await import('../../../apps/control-plane/src/redis/connections.js');
  const { createWorker } = await import('../../../apps/control-plane/src/queue/connect-server-worker.js');

  const workerConnection = createWorkerRedisConnection(redisUrl);
  const { logger, records } = buildRecordingLogger();

  const handle = createWorker(deps, {
    connection: workerConnection,
    queue,
    logger,
    concurrency: options.concurrency ?? 5,
    lockDurationMs: options.lockDurationMs ?? 2000,
    stalledIntervalMs: options.stalledIntervalMs ?? 1000,
  });

  return { handle, logs: records, workerConnection };
}

export async function startWorkerFixture(options: WorkerFixtureOptions = {}): Promise<WorkerFixture> {
  const postgres = await startPostgres();
  const redis = await startRedis();
  setTestEnv(postgres.connectionString, redis.connectionUrl);

  const { resolveServerServicesDeps } = await import(
    '../../../apps/control-plane/src/services/server-service-deps.js'
  );
  const { createConnectServerQueue } = await import(
    '../../../apps/control-plane/src/queue/connect-server-queue.js'
  );
  const { createQueueRedisConnection } = await import('../../../apps/control-plane/src/redis/connections.js');

  let currentSsh: SshPort = buildUnconfiguredSshPort();
  const forwardingSsh: SshPort = {
    connect: (input) => currentSsh.connect(input),
  };

  const events: ServiceFixtureEvent[] = [];
  const recordingEventPublisher: ServiceFixtureEventPublisher = {
    publish(event) {
      events.push(event);
      return Promise.resolve();
    },
  };
  let currentEventPublisher: ServiceFixtureEventPublisher = recordingEventPublisher;
  const forwardingEventPublisher: ServiceFixtureEventPublisher = {
    publish: (event) => currentEventPublisher.publish(event),
  };

  let dbFailing = false;
  const realDb = postgres.db;
  const dbProxy = new Proxy(realDb as object, {
    get(target, prop, receiver) {
      if (prop === 'transaction' && dbFailing) {
        return () => Promise.reject(new Error('worker-fixture: simulated Postgres failure'));
      }
      return Reflect.get(target, prop, receiver);
    },
  }) as typeof realDb;

  const deps = await resolveServerServicesDeps({
    db: dbProxy,
    ssh: forwardingSsh,
    events: forwardingEventPublisher,
    now: () => FIXED_NOW,
  });

  const queueConnection = createQueueRedisConnection(redis.connectionUrl);
  const queue = createConnectServerQueue({ connection: queueConnection });

  const primary = await buildWorker(deps, queue, redis.connectionUrl, options);

  const spawned: { handle: ConnectServerWorkerHandle; workerConnection: Redis }[] = [
    { handle: primary.handle, workerConnection: primary.workerConnection },
  ];

  const setSshPort = (port: SshPort): void => {
    currentSsh = port;
  };
  const setEventPublisher = (publisher: ServiceFixtureEventPublisher): void => {
    currentEventPublisher = publisher;
  };
  const setDbFailing = (shouldFail: boolean): void => {
    dbFailing = shouldFail;
  };

  const killPrimaryWorker = async (): Promise<void> => {
    primary.workerConnection.disconnect();
  };

  const spawnWorker = async (spawnOptions: WorkerFixtureOptions = {}): Promise<SpawnedWorker> => {
    const built = await buildWorker(deps, queue, redis.connectionUrl, spawnOptions);
    spawned.push({ handle: built.handle, workerConnection: built.workerConnection });

    let closed = false;
    const close = async (): Promise<void> => {
      if (closed) return;
      closed = true;
      await closeWithTimeout(built.handle);
      built.workerConnection.disconnect();
    };

    return { handle: built.handle, logs: built.logs, close };
  };

  let stopped = false;
  const stop = async (): Promise<void> => {
    if (stopped) return;
    stopped = true;

    for (const entry of spawned) {
      await closeWithTimeout(entry.handle);
      entry.workerConnection.disconnect();
    }
    await queue.close();
    queueConnection.disconnect();
    await postgres.stop();
    await redis.stop();
  };

  return {
    db: postgres.db,
    deps,
    events,
    queue,
    redisUrl: redis.connectionUrl,
    worker: primary.handle,
    logs: primary.logs,
    setSshPort,
    setEventPublisher,
    setDbFailing,
    killPrimaryWorker,
    spawnWorker,
    stop,
  };
}
