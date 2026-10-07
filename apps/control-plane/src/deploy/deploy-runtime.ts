// 12-11b (W1): the production wiring of the deploy job. `createDeployJobDeps` binds the handler's
// ports to the database, the SSH adapter and the deploy config; `startDeployWorker` runs it on a
// BullMQ Worker. Nothing here imports env.js: src/worker.ts passes the config in, so tests can
// build the runtime without parsing the process environment.
// - H1: `maxStalledCount: 0` and the lock from deploy-job-budget (see deploy-worker.ts).
// - Shutdown cancels in-flight jobs first, so each one's ledger cleanup runs before the worker
//   closes (BullMQ 6 aborts the processor's signal on `cancelAllJobs`).
import { setTimeout as sleep } from 'node:timers/promises';
import { Worker, type WorkerOptions } from 'bullmq';
import { and, eq, ne } from 'drizzle-orm';
import type { Redis } from 'ioredis';
import { DEFAULT_POST_START_POLL_POLICY } from '@noodara/domain/deployment';
import { createRedactor } from '@noodara/domain/security';
import type { SshDeploySession, SshPort, SshTimeouts } from '@noodara/ssh';
import type { Database } from '../db/client.js';
import { deployments } from '../db/schema/deployments.js';
import { services } from '../db/schema/services.js';
import { createGitHostKeyStore } from '../db/git-host-key-store.js';
import type { ServerEventPublisher } from '../events/server-event-publisher.js';
import { BULLMQ_PREFIX } from '../queue/connect-server-queue.js';
import { DEPLOY_QUEUE_NAME } from '../queue/deploy-queue.js';
import type { MasterKeys } from '../services/server-service-deps.js';
import { createBuildCachePrune, type BuildCachePruneRedis } from './build-cache-prune.js';
import { createDeployConnect, loadDeployServerFromDb } from './deploy-connect.js';
import { createLoadTarget, type PanelPorts } from './deploy-target.js';
import { deployWorkerOptions, type DeployJobDeps, type DeployJobLogger, type DeployJobOutcome } from './deploy-worker.js';
import { createDeploymentStore } from './deployment-store.js';
import { noopDeploymentLogSink } from './log-sink.js';
import { runDeployment, type DeployRunLimits } from './run-deployment.js';
import {
  SERVICE_OPERATION_JOB_NAME,
  type ServiceOperationJobDeps,
  type ServiceOperationJobOutcome,
} from './service-ops-job.js';
import { DEFAULT_SERVICE_OPS_LIMITS } from './service-ops.js';

export interface DeployRuntimeConfig {
  /** NOODARA_DEPLOY_MAX_MS */
  readonly deployMaxMs: number;
  /** NOODARA_DEPLOY_IDLE_MS */
  readonly idleMs: number;
  /** NOODARA_DEPLOY_LOG_MAX_BYTES */
  readonly logMaxBytes: number;
  /** DEPLOY_LOG_LINE_MAX_BYTES */
  readonly logLineMaxBytes: number;
}

/** Fixed pipeline limits that are not operator tunables. */
const STOP_TIMEOUT_SECONDS = 10;
const KILL_CONFIRM_MS = 10_000;
const KILL_POLL_MS = 250;
const CLEANUP_STEP_MS = 60_000;

export function deployRunLimits(config: DeployRuntimeConfig): DeployRunLimits {
  return {
    deployMaxMs: config.deployMaxMs,
    idleMs: config.idleMs,
    maxTotalBytes: config.logMaxBytes,
    maxLineBytes: config.logLineMaxBytes,
    stopTimeoutSeconds: STOP_TIMEOUT_SECONDS,
    killConfirmMs: KILL_CONFIRM_MS,
    killPollMs: KILL_POLL_MS,
    cleanupStepMs: CLEANUP_STEP_MS,
  };
}

export interface DeployRuntimeDeps {
  readonly db: Database;
  readonly events: ServerEventPublisher;
  readonly ssh: SshPort<SshDeploySession>;
  readonly timeouts: SshTimeouts;
  readonly masterKeys: () => Promise<MasterKeys>;
  readonly panelPorts: PanelPorts;
  readonly config: DeployRuntimeConfig;
  readonly logger: DeployJobLogger;
  readonly now?: () => Date;
  /** 14-10 (D12): NOODARA_BUILD_CACHE_PRUNE and the Redis port for the once-per-24h key. */
  readonly buildCachePrune?: { readonly mode: 'on' | 'off'; readonly redis: BuildCachePruneRedis };
}

/** True when another deployment on the same server is BUILDING (the prune would slow its build). */
function otherBuildingOnServer(db: Database): (serverId: string, deploymentId: string) => Promise<boolean> {
  return async (serverId, deploymentId) => {
    const rows = await db
      .select({ id: deployments.id })
      .from(deployments)
      .innerJoin(services, eq(services.id, deployments.serviceId))
      .where(and(eq(services.serverId, serverId), eq(deployments.status, 'BUILDING'), ne(deployments.id, deploymentId)))
      .limit(1);
    return rows.length > 0;
  };
}

export function createDeployJobDeps(deps: DeployRuntimeDeps): DeployJobDeps {
  const now = deps.now ?? (() => new Date());
  // 14-07: a non-bundled SSH Git host is pinned per service in the database (TOFU).
  const gitHostKeys = createGitHostKeyStore(deps.db);
  const loadTarget = createLoadTarget({ db: deps.db, masterKeys: deps.masterKeys, panelPorts: deps.panelPorts });
  const pruneConfig = deps.buildCachePrune;
  const afterSuccess =
    pruneConfig === undefined
      ? undefined
      : createBuildCachePrune({
          mode: pruneConfig.mode,
          redis: pruneConfig.redis,
          hasOtherBuilding: otherBuildingOnServer(deps.db),
          logger: deps.logger,
        });
  // The run input carries no server id; remember it from loadTarget, keyed by deployment.
  const serverByDeployment = new Map<string, string>();
  return {
    store: createDeploymentStore({ db: deps.db, now, events: deps.events }),
    loadTarget: async (deployment) => {
      const loaded = await loadTarget(deployment);
      if (loaded.ok) serverByDeployment.set(deployment.id, loaded.serverId);
      return loaded;
    },
    connect: createDeployConnect({
      loadServer: loadDeployServerFromDb(deps.db),
      ssh: deps.ssh,
      timeouts: deps.timeouts,
      masterKeys: deps.masterKeys,
    }),
    createRedactor,
    // The chunked DB sink and `deployment.log_chunk` events are 12-12.
    sinkFor: () => noopDeploymentLogSink,
    limits: deployRunLimits(deps.config),
    pollPolicy: DEFAULT_POST_START_POLL_POLICY,
    clock: { now: () => Date.now(), sleep: (ms) => sleep(ms) },
    logger: deps.logger,
    run: async (input) => {
      const serverId = serverByDeployment.get(input.deploymentId);
      serverByDeployment.delete(input.deploymentId);
      const outcome = await runDeployment({ ...input, gitHostKeys });
      // Best effort: the prune never throws and never changes the outcome (A2).
      if (outcome.status === 'SUCCESS' && afterSuccess !== undefined && serverId !== undefined) {
        await afterSuccess({ serverId, deploymentId: input.deploymentId, session: input.session, redactor: input.redactor });
      }
      return outcome;
    },
  };
}

/** What a job on the shared `deployments` queue resolves to. */
export interface DeployQueueJobResult {
  outcome: DeployJobOutcome | ServiceOperationJobOutcome;
}

export interface ServiceOperationRuntimeDeps {
  readonly loadTarget: ServiceOperationJobDeps['loadTarget'];
  readonly record: ServiceOperationJobDeps['record'];
}

/** 12-14: the service-operation handler's deps, sharing the deploy job's SSH connect. */
export function createServiceOperationJobDeps(
  deploy: Pick<DeployJobDeps, 'connect' | 'createRedactor'>,
  deps: ServiceOperationRuntimeDeps & { readonly events: ServerEventPublisher; readonly logger: DeployJobLogger },
): ServiceOperationJobDeps {
  return {
    loadTarget: deps.loadTarget,
    record: deps.record,
    events: deps.events,
    connect: deploy.connect,
    createRedactor: deploy.createRedactor,
    limits: DEFAULT_SERVICE_OPS_LIMITS,
    logger: deps.logger,
  };
}

type DeployProcessor = (
  job: { readonly name?: string; readonly data: unknown },
  token?: string,
  signal?: AbortSignal,
) => Promise<DeployQueueJobResult>;

/** The slice of a BullMQ Worker this module uses; injectable for the unit test. */
export interface DeployWorkerLike {
  on(event: 'error', listener: (error: Error) => void): unknown;
  on(event: 'failed', listener: (job: unknown, error: Error) => void): unknown;
  cancelAllJobs(reason?: string): void;
  close(): Promise<void>;
}

export type CreateDeployBullWorker = (name: string, processor: DeployProcessor, opts: WorkerOptions) => DeployWorkerLike;

const createBullWorker: CreateDeployBullWorker = (name, processor, opts) =>
  new Worker<unknown, DeployQueueJobResult>(name, (job, token, signal) => processor(job, token, signal), opts);

export interface StartDeployWorkerOptions {
  readonly handler: (data: unknown, signal?: AbortSignal) => Promise<{ outcome: DeployJobOutcome }>;
  /** 12-14: handles `service-operation` jobs (same queue, same worker). Without it they are dropped. */
  readonly serviceOperationHandler?: (data: unknown) => Promise<ServiceOperationJobOutcome>;
  /** A dedicated worker connection (`maxRetriesPerRequest: null`), never the queue's. */
  readonly connection: Redis;
  readonly concurrency: number;
  readonly deployMaxMs: number;
  readonly logger: DeployJobLogger;
  readonly createWorker?: CreateDeployBullWorker;
}

export interface DeployWorkerHandle {
  close(): Promise<void>;
}

/** Only the error's class name: a Redis or driver message can carry a URL or a secret. */
function errorKind(error: unknown): string {
  return error instanceof Error ? error.name : typeof error;
}

export function startDeployWorker(options: StartDeployWorkerOptions): DeployWorkerHandle {
  const create = options.createWorker ?? createBullWorker;
  const { logger } = options;
  const worker = create(
    DEPLOY_QUEUE_NAME,
    async (job, _token, signal) => {
      // A service-operation job never reaches the deploy handler (it would fail its payload parse
      // and, worse, be counted as a deploy).
      if (job.name === SERVICE_OPERATION_JOB_NAME) {
        if (options.serviceOperationHandler === undefined) {
          logger.warn({}, 'service operation job ignored: no handler wired');
          return { outcome: 'invalid_payload' };
        }
        return { outcome: await options.serviceOperationHandler(job.data) };
      }
      return options.handler(job.data, signal);
    },
    {
      connection: options.connection,
      prefix: BULLMQ_PREFIX,
      ...deployWorkerOptions({ deployMaxMs: options.deployMaxMs, concurrency: options.concurrency }),
    },
  );
  // An EventEmitter 'error' without a listener would crash the process.
  worker.on('error', (error) => {
    logger.error({ errorKind: errorKind(error) }, 'deploy worker error');
  });
  // The handler never throws; a failed job here is a lost lock or a stalled job (H1).
  worker.on('failed', (_job, error) => {
    logger.error({ errorKind: errorKind(error) }, 'deploy job failed in the queue');
  });

  return {
    async close() {
      worker.cancelAllJobs('worker shutdown');
      await worker.close();
    },
  };
}
