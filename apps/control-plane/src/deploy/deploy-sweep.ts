// 12-13 (A4): the worker's startup sweep. A deployment left PREPARING, BUILDING or DEPLOYING
// belongs to a worker that died (v0.2 runs one deploy worker, and BullMQ never re-delivers a
// stalled deploy job: maxStalledCount 0). The sweep ends each one FAILED / WORKER_CRASHED first
// (synchronously, before the worker takes new jobs), then cleans its per-deployment resources in
// the background: kill any surviving clone/build/pull group (ADR 0008), remove the workspace
// (its secrets go with it) and the unused deployment image. The per-service container and network
// are never touched: an image still used by the container is refused by Docker, never forced.
// Nothing here throws; only error class names are logged.
//
// 14-08: `sweepStaleQueuedDeployments` runs at worker startup and on every reconcile tick. A QUEUED
// deployment older than NOODARA_DEPLOY_QUEUED_STALE_MS whose BullMQ job is confirmed absent (the
// API's enqueue and its undo both failed) ends FAILED/ENQUEUE_FAILED, releasing the service's
// deploy lock. A job lookup that errors is unknown: skipped and retried on the next tick, so a
// Redis outage never fails a healthy deployment. Bounded per call by STALE_QUEUED_BATCH_LIMIT.
import {
  createResourceLedger,
  decideStaleQueued,
  staleQueuedCutoff,
  type ResourceLedger,
  type StaleQueuedJob,
} from '@noodara/domain/deployment';
import type { Redactor } from '@noodara/domain/security';
import {
  deployWorkspaceFor,
  DEPLOYMENT_SUPERVISED_OPERATIONS,
  validateResourceId,
  type DeployWorkspace,
} from '@noodara/domain/validators';
import { killSupervisedOperation } from '@noodara/ssh';
import type { DeployJobDeps, DeployJobLogger } from './deploy-worker.js';
import { jobIdForDeployment } from '../queue/deploy-queue.js';
import type { DeploymentStore, FinishDeploymentInput, InFlightDeployment, StaleQueuedDeployment } from './deployment-store.js';
import { DEPLOY_MESSAGES, runLedgerCleanup, type DeployRunLimits } from './run-deployment.js';

export interface DeploySweepDeps {
  readonly store: Pick<DeploymentStore, 'inFlight' | 'finish'>;
  readonly connect: DeployJobDeps['connect'];
  readonly createRedactor: () => Redactor;
  readonly limits: Pick<DeployRunLimits, 'killConfirmMs' | 'killPollMs' | 'cleanupStepMs' | 'maxLineBytes'>;
  readonly logger: DeployJobLogger;
}

export interface DeploySweepResult {
  /** Deployments this sweep ended WORKER_CRASHED. */
  readonly swept: readonly string[];
  /** The background remote cleanup; never rejects. */
  readonly cleanup: Promise<void>;
}

const workerCrashed: FinishDeploymentInput = Object.freeze({
  status: 'FAILED',
  errorCode: 'WORKER_CRASHED',
  errorMessage: DEPLOY_MESSAGES.WORKER_CRASHED,
  commitSha: null,
  container: null,
});

function errorKind(error: unknown): string {
  return error instanceof Error ? error.name : typeof error;
}

interface CleanupTarget {
  readonly row: InFlightDeployment;
  readonly workspace: DeployWorkspace;
  readonly ledger: ResourceLedger;
}

function cleanupTargetOf(row: InFlightDeployment): CleanupTarget | null {
  const serviceId = validateResourceId(row.serviceId);
  const deploymentId = validateResourceId(row.deploymentId);
  if (!serviceId.ok || !deploymentId.ok) return null;
  const workspace = deployWorkspaceFor(deploymentId.value);
  const ledger = createResourceLedger(serviceId.value, deploymentId.value);
  if (!workspace.ok || !ledger.ok) return null;
  return { row, workspace: workspace.value, ledger: ledger.value };
}

async function cleanUp(deps: DeploySweepDeps, target: CleanupTarget): Promise<void> {
  const { deploymentId, serverId } = target.row;
  const redactor = deps.createRedactor();
  let close: (() => Promise<void>) | null = null;
  try {
    const connected = await deps.connect(serverId, redactor, undefined);
    if (!connected.ok) {
      deps.logger.warn({ deploymentId, code: connected.code }, 'deploy sweep could not reach the server to clean up');
      return;
    }
    close = connected.close;
    // Deployment operations only: a runtime log follow is never a deployment's leftover.
    for (const op of DEPLOYMENT_SUPERVISED_OPERATIONS) {
      const killed = await killSupervisedOperation({
        session: connected.session,
        pidFile: target.workspace.pidFile(op),
        buildContainer: null,
        confirmTimeoutMs: deps.limits.killConfirmMs,
        pollIntervalMs: deps.limits.killPollMs,
        redactor,
      });
      if (!killed.confirmed) deps.logger.warn({ deploymentId, operation: op }, 'deploy sweep could not confirm a leftover process stopped');
    }
    const reports = await runLedgerCleanup(connected.session, deps.limits, target.workspace, target.ledger, 'WORKER_CRASHED');
    deps.logger.info({ deploymentId, cleanup: reports }, 'deploy sweep cleaned up a crashed deployment');
  } catch (error) {
    deps.logger.warn({ deploymentId, errorKind: errorKind(error) }, 'deploy sweep cleanup failed');
  } finally {
    if (close !== null) {
      try {
        await close();
      } catch (error) {
        deps.logger.warn({ deploymentId, errorKind: errorKind(error) }, 'deploy sweep session failed to close');
      }
    }
  }
}

export async function sweepCrashedDeployments(deps: DeploySweepDeps): Promise<DeploySweepResult> {
  let rows: InFlightDeployment[];
  try {
    rows = await deps.store.inFlight();
  } catch (error) {
    deps.logger.error({ errorKind: errorKind(error) }, 'deploy sweep could not list in-flight deployments');
    return { swept: [], cleanup: Promise.resolve() };
  }

  const swept: string[] = [];
  const targets: CleanupTarget[] = [];
  for (const row of rows) {
    try {
      // null: the row turned terminal meanwhile; its resources are not this sweep's.
      if ((await deps.store.finish(row.deploymentId, workerCrashed)) === null) continue;
    } catch (error) {
      deps.logger.error({ deploymentId: row.deploymentId, errorKind: errorKind(error) }, 'deploy sweep could not end a crashed deployment');
      continue;
    }
    swept.push(row.deploymentId);
    deps.logger.warn({ deploymentId: row.deploymentId, previousStatus: row.status }, 'deploy sweep ended a crashed deployment');
    const target = cleanupTargetOf(row);
    if (target !== null) targets.push(target);
  }

  const cleanup = (async () => {
    for (const target of targets) await cleanUp(deps, target);
  })();
  return { swept, cleanup };
}

/** H3: at most this many stale rows per sweep; the rest wait for the next tick. */
export const STALE_QUEUED_BATCH_LIMIT = 50;

export interface StaleQueuedSweepDeps {
  readonly store: Pick<DeploymentStore, 'staleQueued' | 'failStaleQueued'>;
  /** Authoritative BullMQ lookup; a rejection counts as `unknown`. */
  readonly jobLookup: (deploymentId: string) => Promise<StaleQueuedJob>;
  /** NOODARA_DEPLOY_QUEUED_STALE_MS. */
  readonly thresholdMs: number;
  readonly batchLimit?: number;
  readonly now: () => Date;
  readonly logger: DeployJobLogger;
}

export interface StaleQueuedSweepResult {
  /** Deployments this sweep ended ENQUEUE_FAILED. */
  readonly failed: readonly string[];
  /** Stale rows skipped because their job lookup failed; retried next tick. */
  readonly unknown: number;
}

export async function sweepStaleQueuedDeployments(deps: StaleQueuedSweepDeps): Promise<StaleQueuedSweepResult> {
  const now = deps.now();
  const cutoff = staleQueuedCutoff(now, deps.thresholdMs);
  let rows: StaleQueuedDeployment[];
  try {
    rows = await deps.store.staleQueued(cutoff, deps.batchLimit ?? STALE_QUEUED_BATCH_LIMIT);
  } catch (error) {
    deps.logger.error({ errorKind: errorKind(error) }, 'stale queued sweep could not list queued deployments');
    return { failed: [], unknown: 0 };
  }

  const failed: string[] = [];
  let unknown = 0;
  for (const row of rows) {
    let job: StaleQueuedJob;
    try {
      job = await deps.jobLookup(row.deploymentId);
    } catch {
      job = 'unknown';
    }
    if (job === 'unknown') unknown += 1;
    const decision = decideStaleQueued({ status: 'QUEUED', createdAt: row.createdAt, now, thresholdMs: deps.thresholdMs, job });
    if (decision === 'skip') continue;
    try {
      // null: claimed, cancelled or already failed meanwhile (the conditional UPDATE matched nothing).
      if ((await deps.store.failStaleQueued(row.deploymentId, cutoff)) === null) continue;
    } catch (error) {
      deps.logger.error({ deploymentId: row.deploymentId, errorKind: errorKind(error) }, 'stale queued sweep could not fail a deployment');
      continue;
    }
    failed.push(row.deploymentId);
    deps.logger.warn({ deploymentId: row.deploymentId, serviceId: row.serviceId }, 'stale queued sweep failed a deployment that never reached the queue');
  }
  if (unknown > 0) deps.logger.warn({ unknown }, 'stale queued sweep skipped deployments whose job lookup failed');
  return { failed, unknown };
}

/** The slice of BullMQ's `Queue` the lookup reads; a unit test passes a fake. */
export interface DeployJobLookupQueue {
  getJob(jobId: string): Promise<{ getState(): Promise<string> } | undefined>;
}

// A finished job, or one whose key vanished between getJob and getState, never runs the deployment.
const DEAD_JOB_STATES = new Set(['completed', 'failed', 'unknown']);
const DEFAULT_JOB_LOOKUP_TIMEOUT_MS = 5_000;

/** `live` / `absent` from BullMQ; any error or a lookup past the timeout is `unknown` (H2). */
export function createDeployJobLookup(
  queue: DeployJobLookupQueue,
  options: { readonly timeoutMs?: number } = {},
): (deploymentId: string) => Promise<StaleQueuedJob> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_JOB_LOOKUP_TIMEOUT_MS;
  return async (deploymentId) => {
    let handle: ReturnType<typeof setTimeout> | undefined;
    const lookup = (async (): Promise<StaleQueuedJob> => {
      const job = await queue.getJob(jobIdForDeployment(deploymentId));
      if (job === undefined) return 'absent';
      return DEAD_JOB_STATES.has(await job.getState()) ? 'absent' : 'live';
    })();
    try {
      return await Promise.race([
        lookup,
        new Promise<StaleQueuedJob>((resolve) => {
          handle = setTimeout(() => {
            resolve('unknown');
          }, timeoutMs);
        }),
      ]);
    } catch {
      return 'unknown';
    } finally {
      if (handle !== undefined) clearTimeout(handle);
      // A lookup still pending after the timeout must not surface as an unhandled rejection.
      lookup.catch(() => undefined);
    }
  };
}
