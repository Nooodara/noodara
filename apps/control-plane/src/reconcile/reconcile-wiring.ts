// 12-15: the worker's reconcile wiring (src/worker.ts), shared with the integration test so the
// fixture proves the same composition the worker runs.
// 14-08: the stale-QUEUED sweep rides along: once when the loop starts (the worker's startup
// sweep) and before every reconcile tick, reading deploy jobs through the same queue lookup.
// 18-04 (H2): pending webhook triggers drain after every stale-QUEUED sweep, so a follow-up whose
// enqueue failed (and that the sweep just ended ENQUEUE_FAILED) is retried on the same pass.
// 22-04: the certificate status reconciler runs beside the tick as its own in-process poll
// (ADR 0011), sharing the tick's domain applier so one service's route writes stay serialized.
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
import { createCertReconciler, createCertStore, startCertReconcileLoop, type CertReconcileLoopHandle } from '../domains/cert-reconciler.js';
import { domainApplyLimits } from '../domains/domain-apply.js';
import { createDomainApplier, reapplyPendingDomains, type DomainApplier } from '../domains/domain-services.js';
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
  /** 18-04 (H2): drains every service's pending webhook trigger; runs after each stale-QUEUED sweep. */
  readonly drainPendingTriggers?: () => Promise<unknown>;
  /** 22-03 (H3): re-applies PENDING domain routes after each tick; defaults to SSH via `connect`. */
  readonly domainApply?: DomainApplier;
  /** 22-04: NOODARA_CERT_CHECK_INTERVAL_MS / NOODARA_CERT_ISSUE_TIMEOUT_MS; omitted, no certificate checks run. */
  readonly cert?: WorkerCertReconcileConfig;
}

export interface WorkerCertReconcileConfig {
  readonly intervalMs: number;
  readonly issueTimeoutMs: number;
  /** How often due cycles are looked for; defaults to min(5 s, intervalMs). */
  readonly pollMs?: number;
  /** Test seam: the post-change backoff (defaults to the domain table). */
  readonly checkDelayMs?: (checksSinceChange: number, intervalMs: number) => number;
}

const CERT_POLL_MAX_MS = 5_000;

export interface WorkerReconcileTickSummary extends ReconcileTickSummary {
  /** Deployments the stale-QUEUED sweep of this tick ended ENQUEUE_FAILED. */
  readonly staleQueuedFailed: number;
  /** 22-03: services whose PENDING domain routes this tick re-applied, and those still failing. */
  readonly domainsReapplied: number;
  readonly domainsReapplyFailed: number;
}

const NO_STALE_SWEEP: StaleQueuedSweepResult = Object.freeze({ failed: [], unknown: 0 });

export interface WorkerReconcileTick {
  readonly tick: () => Promise<WorkerReconcileTickSummary>;
  /** The stale-QUEUED sweep, then the pending-trigger drain; never rejects. */
  readonly sweepStaleQueued: () => Promise<StaleQueuedSweepResult>;
  /** The domain applier the tick re-applies PENDING routes through (shared with the cert checks). */
  readonly domainApply: DomainApplier;
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
  const drainPendingTriggers = deps.drainPendingTriggers;
  const sweepStaleQueued = async (): Promise<StaleQueuedSweepResult> => {
    const result =
      staleQueued === undefined
        ? NO_STALE_SWEEP
        : await sweepStaleQueuedDeployments({
            store,
            jobLookup,
            thresholdMs: staleQueued.thresholdMs,
            ...(staleQueued.batchLimit === undefined ? {} : { batchLimit: staleQueued.batchLimit }),
            now,
            logger: deps.logger,
          });
    if (drainPendingTriggers !== undefined) {
      try {
        await drainPendingTriggers();
      } catch (error) {
        // The slots stay; the next tick or terminal event drains them.
        deps.logger.warn({ errorKind: error instanceof Error ? error.name : typeof error }, 'pending webhook trigger drain failed');
      }
    }
    return result;
  };
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
  const domainApply =
    deps.domainApply ??
    createDomainApplier({
      db: deps.db,
      connect: deps.connect,
      createRedactor: deps.createRedactor,
      limits: domainApplyLimits(deps.commandMs),
      now,
    });
  // The sweep never rejects and runs first, so a failing reconcile tick never starves it; the
  // domain re-apply never rejects either and runs last, on the servers the tick just reached.
  const tick = async (): Promise<WorkerReconcileTickSummary> => {
    const stale = await sweepStaleQueued();
    const summary = await reconcileTick();
    const domains = await reapplyPendingDomains({ db: deps.db, apply: domainApply, logger: deps.logger });
    return {
      ...summary,
      staleQueuedFailed: stale.failed.length,
      domainsReapplied: domains.applied,
      domainsReapplyFailed: domains.failed,
    };
  };
  return { tick, sweepStaleQueued, domainApply, close: () => deployQueue.close() };
}

export async function startWorkerReconcile(deps: WorkerReconcileDeps): Promise<ReconcileLoopHandle> {
  const reconcile = createWorkerReconcileTick(deps);
  let loop: ReconcileLoopHandle;
  let certLoop: CertReconcileLoopHandle | null = null;
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
  if (deps.cert !== undefined) {
    const cert = deps.cert;
    const reconciler = createCertReconciler({
      store: createCertStore(deps.db),
      connect: deps.connect,
      createRedactor: deps.createRedactor,
      apply: reconcile.domainApply,
      events: deps.events,
      logger: deps.logger,
      intervalMs: cert.intervalMs,
      issueTimeoutMs: cert.issueTimeoutMs,
      commandMs: deps.commandMs,
      ...(deps.now === undefined ? {} : { now: deps.now }),
      ...(cert.checkDelayMs === undefined ? {} : { checkDelayMs: cert.checkDelayMs }),
    });
    certLoop = startCertReconcileLoop({
      reconciler,
      pollMs: cert.pollMs ?? Math.min(CERT_POLL_MAX_MS, cert.intervalMs),
      logger: deps.logger,
    });
  }
  return {
    async close() {
      if (certLoop !== null) await certLoop.close();
      await loop.close();
      await reconcile.close();
    },
  };
}
