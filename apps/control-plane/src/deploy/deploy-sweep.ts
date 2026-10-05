// 12-13 (A4): the worker's startup sweep. A deployment left PREPARING, BUILDING or DEPLOYING
// belongs to a worker that died (v0.2 runs one deploy worker, and BullMQ never re-delivers a
// stalled deploy job: maxStalledCount 0). The sweep ends each one FAILED / WORKER_CRASHED first
// (synchronously, before the worker takes new jobs), then cleans its per-deployment resources in
// the background: kill any surviving clone/build/pull group (ADR 0008), remove the workspace
// (its secrets go with it) and the unused deployment image. The per-service container and network
// are never touched: an image still used by the container is refused by Docker, never forced.
// Nothing here throws; only error class names are logged.
import { createResourceLedger, type ResourceLedger } from '@noodara/domain/deployment';
import type { Redactor } from '@noodara/domain/security';
import {
  deployWorkspaceFor,
  DEPLOYMENT_SUPERVISED_OPERATIONS,
  validateResourceId,
  type DeployWorkspace,
} from '@noodara/domain/validators';
import { killSupervisedOperation } from '@noodara/ssh';
import type { DeployJobDeps, DeployJobLogger } from './deploy-worker.js';
import type { DeploymentStore, FinishDeploymentInput, InFlightDeployment } from './deployment-store.js';
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
