// 12-11: the `deploy-service` job handler, over injected ports (the BullMQ Worker, the real target
// loader and the SSH connector are wired in 12-11b). Rules:
// - H1: the store claim (QUEUED -> PREPARING under a row lock) is the guard. A re-delivered job
//   for a deployment already past QUEUED returns before any remote command; the worker also runs
//   with `maxStalledCount: 0` and the queue enqueues with `attempts: 1`.
// - ERR: a failure before the pipeline is a closed code with a fixed message from this module;
//   a thrown error becomes FAILED / WORKER_CRASHED. Nothing here throws, and no error text is
//   ever logged or persisted (a driver or SSH message can carry a host, a URL or a secret).
// - SEC: one Redactor per run, shared by the connector and the pipeline.
// - 12-13 cancel: a claimed run watches its Redis cancel flag; the flag (or BullMQ's own signal)
//   aborts the run. Seen before the connection, it ends CANCELLED without any remote command;
//   inside the pipeline, runDeployment kills and confirms (A2, H2). Only this handler moves a
//   claimed row. The watch stops and the flag is cleared on every exit.
// - 17-03: ROLLED_BACK is a terminal outcome like SUCCESS/FAILED/CANCELLED. The handler records it
//   once and resolves (never throws), so BullMQ (`attempts: 1`, `maxStalledCount: 0`) never runs
//   the job, or its rollback, again. 17-07: the rollback itself runs inside runDeployment (one
//   attempt); the loaded target carries autoRollback, previousSuccess and the event recorder.
// - 17-04: after a SUCCESS or ROLLED_BACK run, image retention runs on the still-open session and
//   *before* the terminal write, so it stays under the service's one-active-deployment slot (H1).
//   It never throws into the handler and never changes the recorded outcome (A2).
// - 17-05: a claimed `rollback` row carries its target and that target's runtime snapshot. A row
//   whose snapshot or target id does not validate ends FAILED/ROLLBACK_TARGET_UNAVAILABLE before
//   any connection; after a rollback SUCCESS retention sees the restored target as running.
// - 18-05 (ADR 0010 A3, H2): a re-delivered job whose claim fails never re-runs a step. A row this
//   process is still running is left alone; a row in flight elsewhere (PREPARING..ROLLING_BACK) runs
//   the crash recovery shared with the boot sweep (restore `-prev` if present, end FAILED /
//   WORKER_CRASHED, clean its workspace); a terminal or missing row exits without a remote command.
import {
  parseRuntimeConfigSnapshot,
  V03_DEPLOYMENT_ERROR_MESSAGES,
  type DeploymentErrorCode,
  type PostStartPollPolicy,
} from '@noodara/domain/deployment';
import type { Redactor } from '@noodara/domain/security';
import { validateResourceId } from '@noodara/domain/validators';
import type { SshDeploySession } from '@noodara/ssh';
import { computeDeployJobLockDurationMs } from '../queue/deploy-job-budget.js';
import { sweepCrashedDeployments } from './deploy-sweep.js';
import { parseDeployServiceJobPayload } from '../queue/deploy-job-payload.js';
import type { DeploymentStore, FinishDeploymentInput } from './deployment-store.js';
import type { DeployCancelWatch } from './cancel-flag.js';
import type { ImageRetentionRunner } from './image-retention.js';
import type { DeploymentLogSink } from './log-sink.js';
import {
  DEPLOY_MESSAGES,
  runDeployment,
  type DeployClock,
  type DeployRunLimits,
  type DeploymentOutcome,
  type ManualRollbackTarget,
  type PreviousSuccessDeployment,
  type RunDeploymentInput,
} from './run-deployment.js';

export type { PreviousSuccessDeployment } from './run-deployment.js';

/** 17-03: what an automatic rollback needs; loaded with the target, read by the pipeline (17-07). */
export interface DeployRollbackInputs {
  /** services.autoRollback; true when the column was never set. */
  readonly autoRollback: boolean;
  /** null when the service never had another SUCCESS deployment. */
  readonly previousSuccess: PreviousSuccessDeployment | null;
}

/** Everything the pipeline needs that comes from the database (ids, source, ports, credential). */
export type DeployTarget = Omit<
  RunDeploymentInput,
  'session' | 'redactor' | 'limits' | 'pollPolicy' | 'progress' | 'sink' | 'clock' | 'signal'
> &
  DeployRollbackInputs;

/** The pipeline's result as the worker records it; ROLLED_BACK is terminal (17-03). */
export type DeployRunOutcome = DeploymentOutcome;

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
  /** 18-05: with `inFlight` and `sweepRuntime` a re-delivered job of a crashed run recovers it (A3). */
  readonly store: Pick<DeploymentStore, 'claim' | 'progress' | 'finish'> & Partial<Pick<DeploymentStore, 'inFlight' | 'sweepRuntime'>>;
  /** Reads the claimed deployment's service, server and decrypted credential. */
  readonly loadTarget: (deployment: { readonly id: string; readonly serviceId: string }) => Promise<LoadTargetResult>;
  /** Opens the deploy session; the redactor is the run's, so server secrets are masked too. */
  readonly connect: (serverId: string, redactor: Redactor, signal: AbortSignal | undefined) => Promise<ConnectResult>;
  readonly run?: (input: RunDeploymentInput) => Promise<DeployRunOutcome>;
  readonly createRedactor: () => Redactor;
  readonly sinkFor: (deploymentId: string) => DeploymentLogSink;
  readonly limits: DeployRunLimits;
  readonly pollPolicy: PostStartPollPolicy;
  readonly clock: DeployClock;
  readonly logger: DeployJobLogger;
  /** 12-13: the Redis cancel flag of a claimed run; absent, only BullMQ's signal aborts it. */
  readonly cancel?: {
    watch(deploymentId: string): DeployCancelWatch;
    clear(deploymentId: string): Promise<void>;
  };
  /** 17-04: image retention after SUCCESS / ROLLED_BACK; absent, no image is ever removed. */
  readonly retention?: ImageRetentionRunner;
  /**
   * 18-04 (A2, H2): runs the service's coalesced webhook push once its deployment ends. Called after
   * every job with a valid payload (the drain itself waits while a deployment is still active);
   * absent, a pending trigger waits for the sweep.
   */
  readonly drainPendingTrigger?: (serviceId: string) => Promise<unknown>;
}

export type DeployJobOutcome =
  | 'INVALID_PAYLOAD'
  | 'CLAIM_FAILED'
  | 'ALREADY_CLAIMED'
  | 'CRASH_RECOVERED'
  | 'SUCCESS'
  | 'FAILED'
  | 'ROLLED_BACK'
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

const cancelledBeforeRun: FinishDeploymentInput = Object.freeze({
  status: 'CANCELLED',
  errorCode: null,
  errorMessage: null,
  commitSha: null,
  container: null,
});

function failedWith(code: DeployJobFailureCode): FinishDeploymentInput {
  return { status: 'FAILED', errorCode: code, errorMessage: DEPLOY_JOB_MESSAGES[code], commitSha: null, container: null };
}

const rollbackTargetUnavailable: FinishDeploymentInput = Object.freeze({
  status: 'FAILED',
  errorCode: 'ROLLBACK_TARGET_UNAVAILABLE',
  errorMessage: V03_DEPLOYMENT_ERROR_MESSAGES.ROLLBACK_TARGET_UNAVAILABLE,
  commitSha: null,
  container: null,
});

/** 17-05: the claimed row's rollback target; undefined for other triggers, null when unusable. */
function rollbackTargetOf(row: {
  readonly trigger: string;
  readonly rollbackOfDeploymentId: string | null;
  readonly runtimeConfig: unknown;
}): ManualRollbackTarget | null | undefined {
  if (row.trigger !== 'rollback') return undefined;
  const id = validateResourceId(row.rollbackOfDeploymentId ?? '');
  const snapshot = parseRuntimeConfigSnapshot(row.runtimeConfig);
  if (!id.ok || !snapshot.ok) return null;
  return { id: id.value, runtimeConfig: snapshot.value };
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

  /** A2: retention is best effort; a throw is logged by class and the outcome stands. */
  const retainImages = async (retention: ImageRetentionRunner, input: Parameters<ImageRetentionRunner>[0]): Promise<void> => {
    try {
      await retention(input);
    } catch (error) {
      logger.warn({ deploymentId: input.deploymentId, errorKind: errorKind(error) }, 'image retention failed; the deployment result stands');
    }
  };

  /** 18-04: never throws and never changes the job's outcome; a failed drain waits for the sweep. */
  const drainPending = async (deploymentId: string, serviceId: string): Promise<void> => {
    const drain = deps.drainPendingTrigger;
    if (drain === undefined) return;
    try {
      await drain(serviceId);
    } catch (error) {
      logger.warn({ deploymentId, errorKind: errorKind(error) }, 'deploy job could not drain the pending webhook trigger');
    }
  };

  /** Deployments this process is running: a duplicate delivery never recovers a live run. */
  const running = new Set<string>();

  /** ADR 0010 A3: the claim failed; recover a crashed run, or exit with no remote command. */
  const recoverUnclaimed = async (deploymentId: string, serviceId: string): Promise<{ outcome: DeployJobOutcome; serviceId: string }> => {
    const { inFlight, sweepRuntime } = deps.store;
    if (running.has(deploymentId) || inFlight === undefined || sweepRuntime === undefined) {
      logger.info({ deploymentId }, 'deploy job skipped: deployment is no longer QUEUED');
      return { outcome: 'ALREADY_CLAIMED', serviceId };
    }
    let own;
    try {
      own = (await inFlight()).filter((row) => row.deploymentId === deploymentId);
    } catch (error) {
      logger.error({ deploymentId, errorKind: errorKind(error) }, 'deploy job could not read its deployment state');
      return { outcome: 'CLAIM_FAILED', serviceId };
    }
    const [row] = own;
    if (row === undefined) {
      // Terminal (or missing): nothing to run and nothing to clean.
      logger.info({ deploymentId }, 'deploy job skipped: deployment is no longer QUEUED');
      return { outcome: 'ALREADY_CLAIMED', serviceId };
    }
    logger.warn({ deploymentId, previousStatus: row.status }, 'deploy job re-delivered for a crashed deployment; recovering it');
    const recovered = await sweepCrashedDeployments({
      store: {
        inFlight: () => Promise.resolve(own),
        finish: (id, input) => deps.store.finish(id, input),
        sweepRuntime: (id, expected, recover) => sweepRuntime(id, expected, recover),
      },
      connect: deps.connect,
      createRedactor: deps.createRedactor,
      limits: deps.limits,
      logger,
    });
    await recovered.cleanup;
    return { outcome: 'CRASH_RECOVERED', serviceId: row.serviceId };
  };

  return async (data, signal) => {
    const parsed = parseDeployServiceJobPayload(data);
    if (!parsed.ok) {
      logger.warn({ message: parsed.message }, 'deploy-service job payload invalid');
      return { outcome: 'INVALID_PAYLOAD' };
    }
    const { deploymentId, serviceId } = parsed.payload;
    const handled = await handle(deploymentId, serviceId, signal);
    // The deployment's own service (a mismatched payload never drains a foreign service).
    await drainPending(deploymentId, handled.serviceId);
    return { outcome: handled.outcome };
  };

  async function handle(
    deploymentId: string,
    serviceId: string,
    signal: AbortSignal | undefined,
  ): Promise<{ outcome: DeployJobOutcome; serviceId: string }> {
    let claimed;
    try {
      claimed = await deps.store.claim(deploymentId);
    } catch (error) {
      logger.error({ deploymentId, errorKind: errorKind(error) }, 'deploy job could not claim its deployment');
      return { outcome: 'CLAIM_FAILED', serviceId };
    }
    if (claimed === null) {
      // A QUEUED deployment cancelled before its job ran is a terminal event too.
      return recoverUnclaimed(deploymentId, serviceId);
    }
    running.add(deploymentId);
    try {
      return await runClaimed(claimed, deploymentId, serviceId, signal);
    } finally {
      running.delete(deploymentId);
    }
  }

  async function runClaimed(
    claimed: NonNullable<Awaited<ReturnType<DeployJobDeps['store']['claim']>>>,
    deploymentId: string,
    serviceId: string,
    signal: AbortSignal | undefined,
  ): Promise<{ outcome: DeployJobOutcome; serviceId: string }> {

    let watch: DeployCancelWatch | null = null;
    try {
      watch = deps.cancel?.watch(deploymentId) ?? null;
    } catch (error) {
      logger.warn({ deploymentId, errorKind: errorKind(error) }, 'deploy job could not watch its cancel flag');
    }
    const signals = [signal, watch?.signal].filter((value): value is AbortSignal => value !== undefined);
    const runSignal = signals.length <= 1 ? signals[0] : AbortSignal.any(signals);
    const aborted = (): boolean => runSignal?.aborted === true;

    const sink = deps.sinkFor(deploymentId);
    let close: (() => Promise<void>) | null = null;
    let finish: FinishDeploymentInput;
    let outcome: DeployJobOutcome;
    try {
      const rollbackTarget = rollbackTargetOf(claimed);
      if (claimed.serviceId !== serviceId) {
        logger.error({ deploymentId }, 'deploy job serviceId does not match its deployment');
        finish = crashed;
        outcome = 'FAILED';
      } else if (rollbackTarget === null) {
        logger.warn({ deploymentId }, 'rollback deployment has no usable target snapshot');
        finish = rollbackTargetUnavailable;
        outcome = 'FAILED';
      } else {
        const loaded = await deps.loadTarget({ id: claimed.id, serviceId: claimed.serviceId });
        if (aborted()) {
          finish = cancelledBeforeRun;
          outcome = 'CANCELLED';
        } else if (!loaded.ok) {
          finish = failedWith(loaded.code);
          outcome = 'FAILED';
        } else {
          const redactor = deps.createRedactor();
          const connected = await deps.connect(loaded.serverId, redactor, runSignal);
          if (connected.ok) close = connected.close;
          if (aborted()) {
            // A connect cut short by the cancel is the cancel, not an unreachable server.
            finish = cancelledBeforeRun;
            outcome = 'CANCELLED';
          } else if (!connected.ok) {
            finish = failedWith(connected.code);
            outcome = 'FAILED';
          } else {
            const result = await run({
              ...loaded.target,
              session: connected.session,
              redactor,
              limits: deps.limits,
              pollPolicy: deps.pollPolicy,
              progress: deps.store.progress(deploymentId),
              sink,
              clock: deps.clock,
              ...(runSignal === undefined ? {} : { signal: runSignal }),
              ...(rollbackTarget === undefined ? {} : { rollbackTarget }),
            });
            finish = {
              status: result.status,
              errorCode: result.errorCode,
              errorMessage: result.errorMessage,
              commitSha: result.commitSha,
              container: result.container,
              ...(result.warning === undefined ? {} : { warning: result.warning }),
            };
            outcome = result.status;
            if (result.warning !== undefined) {
              logger.warn({ deploymentId, warning: result.warning }, 'deploy cancel could not confirm the remote process stopped');
            }
            if ((result.status === 'SUCCESS' || result.status === 'ROLLED_BACK') && deps.retention !== undefined) {
              await retainImages(deps.retention, {
                serviceId: loaded.target.serviceId,
                // 17-05: after a rollback SUCCESS the restored target's image is the running one.
                deploymentId:
                  rollbackTarget !== undefined && result.status === 'SUCCESS' ? rollbackTarget.id : loaded.target.deploymentId,
                outcome: result.status,
                previousSuccessId: loaded.target.previousSuccess?.id ?? null,
                session: connected.session,
                redactor,
                ...(runSignal === undefined ? {} : { signal: runSignal }),
              });
            }
          }
        }
      }
    } catch (error) {
      logger.error({ deploymentId, errorKind: errorKind(error) }, 'deploy job failed on an unexpected error');
      finish = crashed;
      outcome = 'WORKER_CRASHED';
    }

    watch?.stop();
    if (close !== null) await closeQuietly('session', deploymentId, close);
    await closeQuietly('log sink', deploymentId, () => sink.close());

    try {
      await deps.store.finish(deploymentId, finish);
    } catch (error) {
      // The row stays non-terminal; the startup sweep ends it as WORKER_CRASHED.
      logger.error({ deploymentId, errorKind: errorKind(error) }, 'deploy job could not record its outcome');
      return { outcome: 'WORKER_CRASHED', serviceId: claimed.serviceId };
    } finally {
      const cancel = deps.cancel;
      if (cancel !== undefined) {
        await closeQuietly('cancel flag', deploymentId, () => cancel.clear(deploymentId));
      }
    }
    return { outcome, serviceId: claimed.serviceId };
  }
}
