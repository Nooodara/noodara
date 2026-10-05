// 12-13: the API side of a cancel. It never moves a claimed deployment itself (A2: only the worker
// transitions a running row); it either ends a QUEUED row under its row lock and drops the job
// (A1), or raises the Redis cancel flag the running worker watches. Rules:
// - H1: a terminal deployment is a named 409; a second cancel while the flag is up is a no-op
//   that answers the same 202; a cancel racing the worker's own finish leaves one terminal state
//   (the store's finish is idempotent and the worker clears the flag on every exit).
// - ERR: a Redis that cannot take the flag is QUEUE_UNAVAILABLE (503), never a 500; job removal
//   and the activity event are best effort and only logged by error class name.
import type { DeploymentView } from '../services/deployment-services.js';
import type { ServiceActor } from '../services/server-service-deps.js';
import type { DeployQueue } from '../queue/deploy-queue.js';
import type { DeployCancelFlags } from './cancel-flag.js';
import type { DeploymentStore } from './deployment-store.js';

export type CancelDeploymentFailureCode = 'NOT_FOUND' | 'DEPLOYMENT_NOT_CANCELLABLE' | 'QUEUE_UNAVAILABLE';

export type CancelDeploymentResult =
  | { readonly ok: true; readonly deployment: DeploymentView }
  | { readonly ok: false; readonly code: CancelDeploymentFailureCode; readonly message: string };

export interface CancelDeploymentLogger {
  warn(fields: Record<string, unknown>, message: string): void;
}

export interface CancelDeploymentDeps {
  readonly store: Pick<DeploymentStore, 'requestCancel' | 'recordCancelRequested'>;
  readonly flags: Pick<DeployCancelFlags, 'request'>;
  readonly queue: Pick<DeployQueue, 'removeJob'>;
  readonly logger: CancelDeploymentLogger;
}

export type CancelDeployment = (deploymentId: string, actor: ServiceActor) => Promise<CancelDeploymentResult>;

function errorKind(error: unknown): string {
  return error instanceof Error ? error.name : typeof error;
}

export function createCancelDeployment(deps: CancelDeploymentDeps): CancelDeployment {
  return async (deploymentId, actor) => {
    const result = await deps.store.requestCancel(deploymentId, actor);
    switch (result.kind) {
      case 'missing':
        return { ok: false, code: 'NOT_FOUND', message: `Deployment "${deploymentId}" not found` };
      case 'terminal':
        return {
          ok: false,
          code: 'DEPLOYMENT_NOT_CANCELLABLE',
          message: `Deployment "${deploymentId}" already ended (${result.deployment.status}). Only a queued or running deployment can be cancelled.`,
        };
      case 'cancelled':
        // The row is CANCELLED, so a job that still runs finds nothing to claim; removal is tidiness.
        try {
          await deps.queue.removeJob(deploymentId);
        } catch (error) {
          deps.logger.warn({ deploymentId, errorKind: errorKind(error) }, 'cancelled deployment job could not be removed');
        }
        return { ok: true, deployment: result.deployment };
      case 'running': {
        const flag = await deps.flags.request(deploymentId);
        if (flag === 'unavailable') {
          return {
            ok: false,
            code: 'QUEUE_UNAVAILABLE',
            message: 'The deployment could not be cancelled because the job queue is unavailable. Try again in a moment.',
          };
        }
        if (flag === 'requested') {
          try {
            await deps.store.recordCancelRequested(result.deployment, actor);
          } catch (error) {
            deps.logger.warn({ deploymentId, errorKind: errorKind(error) }, 'cancel request activity event could not be written');
          }
        }
        return { ok: true, deployment: result.deployment };
      }
    }
  };
}
