import { Queue, type JobsOptions } from 'bullmq';
import type { Redis } from 'ioredis';
import { BULLMQ_PREFIX } from './connect-server-queue.js';
import { DeployServiceJobPayloadSchema, type DeployServiceJobPayload } from './deploy-job-payload.js';

// 12-10 (D16): producer half of the deploy path. Sibling of connect-server-queue.ts with its own
// queue name, so minutes-long builds never share a worker (or a lock budget) with seconds-long
// connect jobs; the worker side (12-11) sets the lock from deploy-job-budget.ts. Like its sibling,
// this module never imports env.js: the connection (or a BullMQ-shaped queue, in unit tests) is
// injected, and the caller owns the connection's lifetime.

export const DEPLOY_QUEUE_NAME = 'deployments';
export const DEPLOY_SERVICE_JOB_NAME = 'deploy-service';

/** `deploy-<deploymentId>`. `-`, not `:`: BullMQ rejects a custom jobId with exactly one colon. */
export function jobIdForDeployment(deploymentId: string): string {
  return `deploy-${deploymentId}`;
}

export type DeployEnqueueResult =
  | { readonly ok: true; readonly jobId: string }
  | { readonly ok: false; readonly code: 'QUEUE_UNAVAILABLE'; readonly message: string };

export interface DeployQueue {
  enqueue(payload: DeployServiceJobPayload): Promise<DeployEnqueueResult>;
  /** Removes a job that has not started (waiting/delayed). Never throws; `false` otherwise. */
  removeJob(deploymentId: string): Promise<boolean>;
  isJobPending(deploymentId: string): Promise<boolean>;
  close(): Promise<void>;
}

interface DeployBullJob {
  getState(): Promise<string>;
  remove(): Promise<void>;
}

/** The slice of BullMQ's `Queue` this module uses; a unit test passes a fake. */
export interface DeployBullQueue {
  add(name: string, data: DeployServiceJobPayload, opts: JobsOptions & { jobId: string }): Promise<{ id?: string | undefined }>;
  getJob(jobId: string): Promise<DeployBullJob | undefined>;
  close(): Promise<void>;
}

export type CreateDeployQueueOptions = (
  | { readonly connection: Redis; readonly queue?: never }
  | { readonly queue: DeployBullQueue; readonly connection?: never }
) & {
  /** Bound on the route path; ioredis can hold a command in its offline queue indefinitely. */
  readonly enqueueTimeoutMs?: number;
};

const DEFAULT_ENQUEUE_TIMEOUT_MS = 2000;
const PENDING_JOB_STATES = new Set(['waiting', 'active', 'delayed']);
const REMOVABLE_JOB_STATES = new Set(['waiting', 'delayed', 'prioritized', 'waiting-children']);
const UNAVAILABLE = { ok: false, code: 'QUEUE_UNAVAILABLE', message: 'Job queue is unavailable' } as const;

async function withTimeout<T>(work: Promise<T>, timeoutMs: number): Promise<T> {
  let handle: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<never>((_resolve, reject) => {
        handle = setTimeout(() => {
          reject(new Error('deploy-queue: operation timed out'));
        }, timeoutMs);
      }),
    ]);
  } finally {
    if (handle !== undefined) clearTimeout(handle);
  }
}

export function createDeployQueue(options: CreateDeployQueueOptions): DeployQueue {
  const queue: DeployBullQueue =
    options.queue ??
    new Queue<DeployServiceJobPayload>(DEPLOY_QUEUE_NAME, {
      connection: options.connection,
      prefix: BULLMQ_PREFIX,
    });
  const timeoutMs = options.enqueueTimeoutMs ?? DEFAULT_ENQUEUE_TIMEOUT_MS;

  async function enqueue(payload: DeployServiceJobPayload): Promise<DeployEnqueueResult> {
    // Defence in depth: only an ids-only payload ever reaches Redis.
    const parsed = DeployServiceJobPayloadSchema.safeParse(payload);
    if (!parsed.success) return UNAVAILABLE;
    const jobId = jobIdForDeployment(parsed.data.deploymentId);
    try {
      const job = await withTimeout(
        queue.add(DEPLOY_SERVICE_JOB_NAME, parsed.data, {
          jobId,
          // A retry would re-run remote commands; the worker's state guard (12-11) is the other half.
          attempts: 1,
          removeOnComplete: { count: 100 },
          removeOnFail: { count: 500 },
        }),
        timeoutMs,
      );
      return { ok: true, jobId: job.id ?? jobId };
    } catch {
      // Fixed message: ioredis/BullMQ error text can embed the Redis host, port or password.
      return UNAVAILABLE;
    }
  }

  async function removeJob(deploymentId: string): Promise<boolean> {
    try {
      return await withTimeout(
        (async () => {
          const job = await queue.getJob(jobIdForDeployment(deploymentId));
          if (!job) return false;
          if (!REMOVABLE_JOB_STATES.has(await job.getState())) return false;
          await job.remove();
          return true;
        })(),
        timeoutMs,
      );
    } catch {
      return false;
    }
  }

  async function isJobPending(deploymentId: string): Promise<boolean> {
    try {
      return await withTimeout(
        (async () => {
          const job = await queue.getJob(jobIdForDeployment(deploymentId));
          return job ? PENDING_JOB_STATES.has(await job.getState()) : false;
        })(),
        timeoutMs,
      );
    } catch {
      return false;
    }
  }

  async function close(): Promise<void> {
    await queue.close();
  }

  return { enqueue, removeJob, isJobPending, close };
}
