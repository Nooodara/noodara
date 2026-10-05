// 12-11: the `deploy-service` job handler, over injected ports (the BullMQ Worker, the real target
// loader and the SSH connector are wired in 12-11b). Rules:
// - H1: the store claim (QUEUED -> PREPARING under a row lock) is the guard. A re-delivered job
//   for a deployment already past QUEUED returns before any remote command; the worker also runs
//   with `maxStalledCount: 0` and the queue enqueues with `attempts: 1`.
// - ERR: a failure before the pipeline is a closed code with a fixed message from this module;
//   a thrown error becomes FAILED / WORKER_CRASHED. Nothing here throws, and no error text is
//   ever logged or persisted (a driver or SSH message can carry a host, a URL or a secret).
// - SEC: one Redactor per run, shared by the connector and the pipeline.
import type { DeploymentErrorCode, PostStartPollPolicy } from '@noodara/domain/deployment';
import type { Redactor } from '@noodara/domain/security';
import type { SshDeploySession } from '@noodara/ssh';
import { computeDeployJobLockDurationMs } from '../queue/deploy-job-budget.js';
import { parseDeployServiceJobPayload } from '../queue/deploy-job-payload.js';
import type { DeploymentStore, FinishDeploymentInput } from './deployment-store.js';
import type { DeploymentLogSink } from './log-sink.js';
import {
  DEPLOY_MESSAGES,
  runDeployment,
  type DeployClock,
  type DeployRunLimits,
  type DeploymentOutcome,
  type RunDeploymentInput,
} from './run-deployment.js';

/** Everything the pipeline needs that comes from the database (ids, source, ports, credential). */
export type DeployTarget = Omit<
  RunDeploymentInput,
  'session' | 'redactor' | 'limits' | 'pollPolicy' | 'progress' | 'sink' | 'clock' | 'signal'
>;

/** The closed codes a failure before the pipeline can end with. */
export type DeployJobFailureCode = Extract<
  DeploymentErrorCode,
  'SERVER_UNREACHABLE' | 'DOCKER_UNAVAILABLE' | 'REPOSITORY_AUTH_FAILED' | 'REGISTRY_AUTH_FAILED'
>;

export const DEPLOY_JOB_MESSAGES: Readonly<Record<DeployJobFailureCode, string>> = Object.freeze({
  SERVER_UNREACHABLE:
    'Noodara could not open an SSH connection to the server. Check that the server is online and reachable, then redeploy.',
  DOCKER_UNAVAILABLE: 'Docker is not available on the server. Check that Docker is installed and running, then redeploy.',
  REPOSITORY_AUTH_FAILED:
    "The service's repository credential could not be used. Replace the deploy key or access token, then redeploy.",
  REGISTRY_AUTH_FAILED:
    "The service's registry credential could not be used. Replace the registry password, then redeploy.",
});

export type LoadTargetResult =
  | { readonly ok: true; readonly target: DeployTarget; readonly serverId: string }
  | { readonly ok: false; readonly code: DeployJobFailureCode };

export type ConnectResult =
  | { readonly ok: true; readonly session: SshDeploySession; readonly close: () => Promise<void> }
  | { readonly ok: false; readonly code: DeployJobFailureCode };

export interface DeployJobLogger {
  info(fields: Record<string, unknown>, message: string): void;
  warn(fields: Record<string, unknown>, message: string): void;
  error(fields: Record<string, unknown>, message: string): void;
}

export interface DeployJobDeps {
  readonly store: Pick<DeploymentStore, 'claim' | 'progress' | 'finish'>;
  /** Reads the claimed deployment's service, server and decrypted credential. */
  readonly loadTarget: (deployment: { readonly id: string; readonly serviceId: string }) => Promise<LoadTargetResult>;
  /** Opens the deploy session; the redactor is the run's, so server secrets are masked too. */
  readonly connect: (serverId: string, redactor: Redactor, signal: AbortSignal | undefined) => Promise<ConnectResult>;
  readonly run?: (input: RunDeploymentInput) => Promise<DeploymentOutcome>;
  readonly createRedactor: () => Redactor;
  readonly sinkFor: (deploymentId: string) => DeploymentLogSink;
  readonly limits: DeployRunLimits;
  readonly pollPolicy: PostStartPollPolicy;
  readonly clock: DeployClock;
  readonly logger: DeployJobLogger;
}

export type DeployJobOutcome =
  | 'INVALID_PAYLOAD'
  | 'CLAIM_FAILED'
  | 'ALREADY_CLAIMED'
  | 'SUCCESS'
  | 'FAILED'
  | 'CANCELLED'
  | 'WORKER_CRASHED';

export interface DeployWorkerOptions {
  readonly concurrency: number;
  readonly lockDuration: number;
  /** 0: BullMQ fails a stalled job instead of handing it to a second worker (H1). */
  readonly maxStalledCount: 0;
}

export function deployWorkerOptions(input: { readonly deployMaxMs: number; readonly concurrency: number }): DeployWorkerOptions {
  return {
    concurrency: input.concurrency,
    lockDuration: computeDeployJobLockDurationMs(input.deployMaxMs),
    maxStalledCount: 0,
  };
}

const crashed: FinishDeploymentInput = Object.freeze({
  status: 'FAILED',
  errorCode: 'WORKER_CRASHED',
  errorMessage: DEPLOY_MESSAGES.WORKER_CRASHED,
  commitSha: null,
  container: null,
});

function failedWith(code: DeployJobFailureCode): FinishDeploymentInput {
  return { status: 'FAILED', errorCode: code, errorMessage: DEPLOY_JOB_MESSAGES[code], commitSha: null, container: null };
}

/** Only the error's class name: its message can carry a host, a URL or a secret. */
function errorKind(error: unknown): string {
  return error instanceof Error ? error.name : typeof error;
}

export function createDeployJobHandler(deps: DeployJobDeps): (data: unknown, signal?: AbortSignal) => Promise<{ outcome: DeployJobOutcome }> {
  const run = deps.run ?? runDeployment;
  const { logger } = deps;

  const closeQuietly = async (what: string, deploymentId: string, close: () => Promise<void>): Promise<void> => {
    try {
      await close();
    } catch (error) {
      logger.warn({ deploymentId, errorKind: errorKind(error) }, `deploy ${what} failed to close`);
    }
  };

  return async (data, signal) => {
    const parsed = parseDeployServiceJobPayload(data);
    if (!parsed.ok) {
      logger.warn({ message: parsed.message }, 'deploy-service job payload invalid');
      return { outcome: 'INVALID_PAYLOAD' };
    }
    const { deploymentId, serviceId } = parsed.payload;

    let claimed;
    try {
      claimed = await deps.store.claim(deploymentId);
    } catch (error) {
      logger.error({ deploymentId, errorKind: errorKind(error) }, 'deploy job could not claim its deployment');
      return { outcome: 'CLAIM_FAILED' };
    }
    if (claimed === null) {
      logger.info({ deploymentId }, 'deploy job skipped: deployment is no longer QUEUED');
      return { outcome: 'ALREADY_CLAIMED' };
    }

    const sink = deps.sinkFor(deploymentId);
    let close: (() => Promise<void>) | null = null;
    let finish: FinishDeploymentInput;
    let outcome: DeployJobOutcome;
    try {
      if (claimed.serviceId !== serviceId) {
        logger.error({ deploymentId }, 'deploy job serviceId does not match its deployment');
        finish = crashed;
        outcome = 'FAILED';
      } else {
        const loaded = await deps.loadTarget({ id: claimed.id, serviceId: claimed.serviceId });
        if (!loaded.ok) {
          finish = failedWith(loaded.code);
          outcome = 'FAILED';
        } else {
          const redactor = deps.createRedactor();
          const connected = await deps.connect(loaded.serverId, redactor, signal);
          if (!connected.ok) {
            finish = failedWith(connected.code);
            outcome = 'FAILED';
          } else {
            close = connected.close;
            const result = await run({
              ...loaded.target,
              session: connected.session,
              redactor,
              limits: deps.limits,
              pollPolicy: deps.pollPolicy,
              progress: deps.store.progress(deploymentId),
              sink,
              clock: deps.clock,
              ...(signal === undefined ? {} : { signal }),
            });
            finish = {
              status: result.status,
              errorCode: result.errorCode,
              errorMessage: result.errorMessage,
              commitSha: result.commitSha,
              container: result.container,
            };
            outcome = result.status;
          }
        }
      }
    } catch (error) {
      logger.error({ deploymentId, errorKind: errorKind(error) }, 'deploy job failed on an unexpected error');
      finish = crashed;
      outcome = 'WORKER_CRASHED';
    }

    if (close !== null) await closeQuietly('session', deploymentId, close);
    await closeQuietly('log sink', deploymentId, () => sink.close());

    try {
      await deps.store.finish(deploymentId, finish);
    } catch (error) {
      // The row stays non-terminal; the startup sweep ends it as WORKER_CRASHED.
      logger.error({ deploymentId, errorKind: errorKind(error) }, 'deploy job could not record its outcome');
      return { outcome: 'WORKER_CRASHED' };
    }
    return { outcome };
  };
}
