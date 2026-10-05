// 12-15 (A1, H1): the reconcile tick as a BullMQ repeatable job on its own queue.
// - One job scheduler (`upsertJobScheduler`, idempotent across restarts) fires every
//   NOODARA_RECONCILE_INTERVAL_MS; BullMQ keeps at most one pending iteration.
// - Never overlapping: the worker runs with concurrency 1 and the tick is serialized in-process,
//   so a slow tick delays the next instead of running beside it. v0.2 runs one worker process.
// - The processor never throws: a failed tick is logged by error kind and the next one retries.
import { Queue, Worker, type ConnectionOptions } from 'bullmq';
import type { DeployJobLogger } from '../deploy/deploy-worker.js';
import { BULLMQ_PREFIX } from '../queue/connect-server-queue.js';

export const RECONCILE_QUEUE_NAME = 'reconcile';
export const RECONCILE_JOB_NAME = 'reconcile-tick';
export const RECONCILE_SCHEDULER_ID = 'reconcile-tick';

/** The slices of BullMQ this module uses; injectable for the unit test. */
export interface ReconcileQueueLike {
  upsertJobScheduler(
    id: string,
    repeat: { every: number },
    template: { name: string; opts: { removeOnComplete: boolean; removeOnFail: boolean } },
  ): Promise<unknown>;
  close(): Promise<void>;
}

export interface ReconcileWorkerLike {
  on(event: 'error', listener: (error: Error) => void): unknown;
  close(): Promise<void>;
}

type ReconcileProcessor = (job: { readonly name?: string }) => Promise<unknown>;

export interface StartReconcileLoopOptions {
  readonly intervalMs: number;
  readonly tick: () => Promise<unknown>;
  readonly queueConnection: ConnectionOptions;
  /** A dedicated worker connection (`maxRetriesPerRequest: null`), never the queue's. */
  readonly workerConnection: ConnectionOptions;
  readonly logger: DeployJobLogger;
  readonly createQueue?: (name: string, connection: ConnectionOptions) => ReconcileQueueLike;
  readonly createWorker?: (
    name: string,
    processor: ReconcileProcessor,
    opts: { connection: ConnectionOptions; prefix: string; concurrency: number },
  ) => ReconcileWorkerLike;
}

export interface ReconcileLoopHandle {
  close(): Promise<void>;
}

/**
 * Runs `tick` one at a time: a call while one runs waits for it, and calls made while one is
 * already waiting share that waiting run, so ticks never overlap and never pile up.
 */
export function serializeTicks<T>(tick: () => Promise<T>): () => Promise<T> {
  let running: Promise<T> | null = null;
  let queued: Promise<T> | null = null;

  const start = (): Promise<T> => {
    const current = tick();
    running = current;
    const clear = () => {
      if (running === current) running = null;
    };
    current.then(clear, clear);
    return current;
  };

  return () => {
    if (queued !== null) return queued;
    if (running === null) return start();
    const waitFor = running;
    const next = waitFor.then(
      () => undefined,
      () => undefined,
    ).then(() => {
      queued = null;
      return start();
    });
    queued = next;
    return next;
  };
}

/** Only the error's class name: a driver or SSH message can carry a URL or a secret. */
function errorKind(error: unknown): string {
  return error instanceof Error ? error.name : typeof error;
}

const createBullQueue = (name: string, connection: ConnectionOptions): ReconcileQueueLike =>
  new Queue(name, { connection, prefix: BULLMQ_PREFIX });

const createBullWorker: NonNullable<StartReconcileLoopOptions['createWorker']> = (name, processor, opts) =>
  new Worker(name, (job) => processor(job), opts);

export async function startReconcileLoop(options: StartReconcileLoopOptions): Promise<ReconcileLoopHandle> {
  const { logger } = options;
  const queue = (options.createQueue ?? createBullQueue)(RECONCILE_QUEUE_NAME, options.queueConnection);
  await queue.upsertJobScheduler(
    RECONCILE_SCHEDULER_ID,
    { every: options.intervalMs },
    { name: RECONCILE_JOB_NAME, opts: { removeOnComplete: true, removeOnFail: true } },
  );

  const run = serializeTicks(options.tick);
  const worker = (options.createWorker ?? createBullWorker)(
    RECONCILE_QUEUE_NAME,
    async () => {
      try {
        return { summary: await run() };
      } catch (error) {
        logger.error({ errorKind: errorKind(error) }, 'reconcile tick failed');
        return { summary: null };
      }
    },
    { connection: options.workerConnection, prefix: BULLMQ_PREFIX, concurrency: 1 },
  );
  // An EventEmitter 'error' without a listener would crash the process.
  worker.on('error', (error) => {
    logger.error({ errorKind: errorKind(error) }, 'reconcile worker error');
  });

  return {
    async close() {
      await worker.close();
      await queue.close();
    },
  };
}
