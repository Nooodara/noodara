// 27-02 (A1, H1): the metrics collector as a BullMQ repeatable job on its own queue.
// - One job scheduler (idempotent across restarts) fires every NOODARA_METRICS_INTERVAL_MS.
// - Never overlapping: concurrency 1 per worker plus a Redis tick lock shared by every worker, so
//   two workers never run the same tick and a tick still running makes the next one a no-op.
// - The processor never throws: a failed tick is logged by error kind and the next one retries.
import { Queue, Worker, type ConnectionOptions } from 'bullmq';
import type { Redis } from 'ioredis';
import type { Database } from '../db/client.js';
import type { DeployJobDeps, DeployJobLogger } from '../deploy/deploy-worker.js';
import { BULLMQ_PREFIX } from '../queue/connect-server-queue.js';
import {
  isServerBusy,
  listCollectorServers,
  listCollectorServices,
  loadContainerHistory,
  loadLastContainerStates,
  pruneMetrics,
  writeServerTick,
  type PruneOptions,
} from './collector-store.js';
import { createCollectorTick, type CollectorTickSummary } from './collector-tick.js';
import { guardTick, tickLockRedisFrom, type GuardedRun, type TickLockRedis } from './tick-lock.js';

export const METRICS_QUEUE_NAME = 'metrics';
export const METRICS_JOB_NAME = 'metrics-tick';
export const METRICS_SCHEDULER_ID = 'metrics-tick';

/** The tick lock outlives the deadline by this margin, so only a dead worker's lock expires. */
const LOCK_MARGIN_MS = 30_000;
/** The tick deadline stays under the interval, so a slow tick ends before the next fires. */
const DEADLINE_HEADROOM_MS = 5_000;
const HOUR_MS = 3_600_000;

export interface MetricsQueueLike {
  upsertJobScheduler(
    id: string,
    repeat: { every: number },
    template: { name: string; opts: { removeOnComplete: boolean; removeOnFail: boolean } },
  ): Promise<unknown>;
  close(): Promise<void>;
}

export interface MetricsWorkerLike {
  on(event: 'error', listener: (error: Error) => void): unknown;
  close(): Promise<void>;
}

type MetricsProcessor = (job: { readonly name?: string }) => Promise<unknown>;

export interface StartCollectorLoopOptions {
  readonly intervalMs: number;
  readonly tick: () => Promise<unknown>;
  readonly queueConnection: ConnectionOptions;
  /** A dedicated worker connection (`maxRetriesPerRequest: null`), never the queue's. */
  readonly workerConnection: ConnectionOptions;
  readonly logger: DeployJobLogger;
  readonly createQueue?: (name: string, connection: ConnectionOptions) => MetricsQueueLike;
  readonly createWorker?: (
    name: string,
    processor: MetricsProcessor,
    opts: { connection: ConnectionOptions; prefix: string; concurrency: number },
  ) => MetricsWorkerLike;
}

export interface CollectorLoopHandle {
  close(): Promise<void>;
}

function errorKind(error: unknown): string {
  return error instanceof Error ? error.name : typeof error;
}

/** The tick deadline for an interval: under the interval, never below 20 s. */
export function collectorDeadlineMs(intervalMs: number): number {
  return Math.max(20_000, intervalMs - DEADLINE_HEADROOM_MS);
}

export async function startCollectorLoop(options: StartCollectorLoopOptions): Promise<CollectorLoopHandle> {
  const { logger } = options;
  const queue = (options.createQueue ?? ((name, connection) => new Queue(name, { connection, prefix: BULLMQ_PREFIX })))(
    METRICS_QUEUE_NAME,
    options.queueConnection,
  );
  await queue.upsertJobScheduler(
    METRICS_SCHEDULER_ID,
    { every: options.intervalMs },
    { name: METRICS_JOB_NAME, opts: { removeOnComplete: true, removeOnFail: true } },
  );
  const createWorker =
    options.createWorker ?? ((name, processor, opts) => new Worker(name, (job) => processor(job), opts));
  const worker = createWorker(
    METRICS_QUEUE_NAME,
    async () => {
      try {
        return { summary: await options.tick() };
      } catch (error) {
        logger.error({ errorKind: errorKind(error) }, 'metrics tick failed');
        return { summary: null };
      }
    },
    { connection: options.workerConnection, prefix: BULLMQ_PREFIX, concurrency: 1 },
  );
  // An EventEmitter 'error' without a listener would crash the process.
  worker.on('error', (error) => {
    logger.error({ errorKind: errorKind(error) }, 'metrics worker error');
  });
  return {
    async close() {
      await worker.close();
      await queue.close();
    },
  };
}

export interface WorkerCollectorDeps {
  readonly db: Database;
  readonly connect: DeployJobDeps['connect'];
  readonly createRedactor: DeployJobDeps['createRedactor'];
  readonly logger: DeployJobLogger;
  /** NOODARA_METRICS_INTERVAL_MS. */
  readonly intervalMs: number;
  /** NOODARA_METRICS_RETENTION_HOURS. */
  readonly retentionHours: number;
  /** The tick lock's Redis (the queue connection). */
  readonly redis: Redis | TickLockRedis;
  readonly now?: () => Date;
  /** Test seams. */
  readonly deadlineMs?: number;
  readonly hostDeltaSeconds?: number;
  readonly prune?: PruneOptions;
}

export type GuardedCollectorTick = () => Promise<GuardedRun<CollectorTickSummary>>;

function isTickLockRedis(redis: Redis | TickLockRedis): redis is TickLockRedis {
  return 'setNxPx' in redis && 'delIfEquals' in redis;
}

/** The guarded tick over the database and the deploy connect (shared with the integration test). */
export function createWorkerCollectorTick(deps: WorkerCollectorDeps): GuardedCollectorTick {
  const deadlineMs = deps.deadlineMs ?? collectorDeadlineMs(deps.intervalMs);
  const tick = createCollectorTick({
    listServers: () => listCollectorServers(deps.db),
    serverBusy: (serverId) => isServerBusy(deps.db, serverId),
    listServices: (serverId) => listCollectorServices(deps.db, serverId),
    lastStates: (serviceIds) => loadLastContainerStates(deps.db, serviceIds),
    history: (serviceId, containerId, since) => loadContainerHistory(deps.db, serviceId, containerId, since),
    writeServerTick: (write) => writeServerTick(deps.db, write),
    prune: (cutoff) => pruneMetrics(deps.db, cutoff, deps.prune),
    connect: deps.connect,
    createRedactor: deps.createRedactor,
    deadlineMs,
    retentionMs: deps.retentionHours * HOUR_MS,
    logger: deps.logger,
    ...(deps.now === undefined ? {} : { now: deps.now }),
    ...(deps.hostDeltaSeconds === undefined ? {} : { hostDeltaSeconds: deps.hostDeltaSeconds }),
  });
  const redis = isTickLockRedis(deps.redis) ? deps.redis : tickLockRedisFrom(deps.redis);
  return guardTick(tick, { redis, ttlMs: deadlineMs + LOCK_MARGIN_MS });
}

export async function startWorkerCollector(
  deps: WorkerCollectorDeps & { readonly queueConnection: ConnectionOptions; readonly workerConnection: ConnectionOptions },
): Promise<CollectorLoopHandle> {
  const tick = createWorkerCollectorTick(deps);
  return startCollectorLoop({
    intervalMs: deps.intervalMs,
    tick: async () => {
      const run = await tick();
      if (!run.ran) deps.logger.info({}, 'metrics tick skipped: another tick holds the lock');
      return run;
    },
    queueConnection: deps.queueConnection,
    workerConnection: deps.workerConnection,
    logger: deps.logger,
  });
}
