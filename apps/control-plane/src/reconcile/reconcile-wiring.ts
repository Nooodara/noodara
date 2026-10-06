// 12-15: the worker's reconcile wiring (src/worker.ts), shared with the integration test so the
// fixture proves the same composition the worker runs.
import { Queue, type ConnectionOptions } from 'bullmq';
import type { Database } from '../db/client.js';
import type { DeployJobDeps, DeployJobLogger } from '../deploy/deploy-worker.js';
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
}

export interface WorkerReconcileTick {
  readonly tick: () => Promise<ReconcileTickSummary>;
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
  const tick = createReconcileTick({
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
  return { tick, close: () => deployQueue.close() };
}

export async function startWorkerReconcile(deps: WorkerReconcileDeps): Promise<ReconcileLoopHandle> {
  const reconcile = createWorkerReconcileTick(deps);
  let loop: ReconcileLoopHandle;
  try {
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
