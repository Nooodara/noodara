// 12-15: the worker's reconcile wiring (src/worker.ts), shared with the integration test so the
// fixture proves the same composition the worker runs.
// 14-08: the stale-QUEUED sweep rides along: once when the loop starts (the worker's startup
// sweep) and before every reconcile tick, reading deploy jobs through the same queue lookup.
import { Queue, type ConnectionOptions } from 'bullmq';
import type { Database } from '../db/client.js';
import {
  createDeployJobLookup,
  sweepStaleQueuedDeployments,
  type StaleQueuedSweepResult,
} from '../deploy/deploy-sweep.js';
import type { DeployJobDeps, DeployJobLogger } from '../deploy/deploy-worker.js';
import { createDeploymentStore } from '../deploy/deployment-store.js';
import type { ServerEventPublisher } from '../events/server-event-publisher.js';
import { BULLMQ_PREFIX } from '../queue/connect-server-queue.js';
import { DEPLOY_QUEUE_NAME } from '../queue/deploy-queue.js';
import { startReconcileLoop, type ReconcileLoopHandle } from './reconcile-runtime.js';
import {
  createOperationInFlight,
  listReconcileServers,
  loadReconcileServices,
  recordReconcileDiscrepancy,
  writeReconcileStatus,
} from './reconcile-store.js';
import { createReconcileTick, type ReconcileTickSummary } from './reconcile-tick.js';

export interface WorkerReconcileDeps {
  readonly db: Database;
  readonly connect: DeployJobDeps['connect'];
  readonly createRedactor: DeployJobDeps['createRedactor'];
  readonly events: ServerEventPublisher;
  readonly logger: DeployJobLogger;
  /** NOODARA_SSH_COMMAND_TIMEOUT_MS. */
  readonly commandMs: number;
  /** NOODARA_RECONCILE_INTERVAL_MS. */
  readonly intervalMs: number;
  readonly queueConnection: ConnectionOptions;
  readonly workerConnection: ConnectionOptions;
  readonly now?: () => Date;
  /** NOODARA_DEPLOY_QUEUED_STALE_MS; omitted, no stale-QUEUED sweep runs. */
  readonly staleQueued?: { readonly thresholdMs: number; readonly batchLimit?: number };
}

export interface WorkerReconcileTickSummary extends ReconcileTickSummary {
  /** Deployments the stale-QUEUED sweep of this tick ended ENQUEUE_FAILED. */
  readonly staleQueuedFailed: number;
}

const NO_STALE_SWEEP: StaleQueuedSweepResult = Object.freeze({ failed: [], unknown: 0 });

export interface WorkerReconcileTick {
  readonly tick: () => Promise<WorkerReconcileTickSummary>;
  /** The stale-QUEUED sweep alone; never rejects. */
  readonly sweepStaleQueued: () => Promise<StaleQueuedSweepResult>;
  /** Closes the queue lookup the tick reads service-operation jobs through. */
  close(): Promise<void>;
}

/** The tick over the database, the deploy connect and the shared `deployments` queue. */
export function createWorkerReconcileTick(
  deps: Omit<WorkerReconcileDeps, 'intervalMs' | 'workerConnection'>,
): WorkerReconcileTick {
  const now = deps.now ?? (() => new Date());
  // Read-only lookups of service-operation jobs on the shared `deployments` queue.
  const deployQueue = new Queue(DEPLOY_QUEUE_NAME, { connection: deps.queueConnection, prefix: BULLMQ_PREFIX });
  const staleQueued = deps.staleQueued;
  const store = createDeploymentStore({ db: deps.db, now, events: deps.events });
  const jobLookup = createDeployJobLookup(deployQueue);
  const sweepStaleQueued = (): Promise<StaleQueuedSweepResult> =>
    staleQueued === undefined
      ? Promise.resolve(NO_STALE_SWEEP)
      : sweepStaleQueuedDeployments({
          store,
          jobLookup,
          thresholdMs: staleQueued.thresholdMs,
          ...(staleQueued.batchLimit === undefined ? {} : { batchLimit: staleQueued.batchLimit }),
          now,
          logger: deps.logger,
        });
  const reconcileTick = createReconcileTick({
    listServers: () => listReconcileServers(deps.db),
    loadServices: (serverId) => loadReconcileServices(deps.db, serverId),
    operationInFlight: createOperationInFlight(deployQueue),
    connect: deps.connect,
    createRedactor: deps.createRedactor,
    commandMs: deps.commandMs,
    writeStatus: (write) => writeReconcileStatus(deps.db, now, write),
    recordDiscrepancy: (record) => recordReconcileDiscrepancy(deps.db, now, record),
    events: deps.events,
    logger: deps.logger,
  });
  // The sweep never rejects and runs first, so a failing reconcile tick never starves it.
  const tick = async (): Promise<WorkerReconcileTickSummary> => {
    const stale = await sweepStaleQueued();
    const summary = await reconcileTick();
    return { ...summary, staleQueuedFailed: stale.failed.length };
  };
  return { tick, sweepStaleQueued, close: () => deployQueue.close() };
}

export async function startWorkerReconcile(deps: WorkerReconcileDeps): Promise<ReconcileLoopHandle> {
  const reconcile = createWorkerReconcileTick(deps);
  let loop: ReconcileLoopHandle;
  try {
    // The worker's startup sweep: before the first tick, never blocking boot on Redis/Postgres.
    const startup = await reconcile.sweepStaleQueued();
    deps.logger.info({ failedCount: startup.failed.length, unknown: startup.unknown }, 'worker startup sweep for stale queued deployments complete');
    loop = await startReconcileLoop({
      intervalMs: deps.intervalMs,
      tick: reconcile.tick,
      queueConnection: deps.queueConnection,
      workerConnection: deps.workerConnection,
      logger: deps.logger,
    });
  } catch (error) {
    await reconcile.close();
    throw error;
  }
  return {
    async close() {
      await loop.close();
      await reconcile.close();
    },
  };
}
