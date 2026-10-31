import { Queue, type JobsOptions } from 'bullmq';
import type { Redis } from 'ioredis';
import { BULLMQ_PREFIX } from './connect-server-queue.js';
import {
  ProxyInstallJobPayloadSchema,
  jobIdForProxyInstall,
  type ProxyInstallJobPayload,
} from './proxy-job-payload.js';

// 22-02: producer half of the proxy install. Its own queue (and worker), so a proxy install never
// waits behind a minutes-long build. One job per server (`proxy-install-<serverId>`): a request
// while one is queued or running collapses into it (H1). Never retried: a retry would re-run remote
// commands; the service's state guard is the other half.

export const PROXY_QUEUE_NAME = 'proxy';
export const PROXY_INSTALL_JOB_NAME = 'proxy-install';

export type ProxyEnqueueResult =
  | { readonly ok: true; readonly jobId: string; readonly collapsed: boolean }
  | { readonly ok: false; readonly code: 'QUEUE_UNAVAILABLE'; readonly message: string };

export interface ProxyQueue {
  enqueue(payload: ProxyInstallJobPayload): Promise<ProxyEnqueueResult>;
  /** Waiting, delayed or active. Never throws; `false` when the queue cannot answer. */
  isInstallPending(serverId: string): Promise<boolean>;
  close(): Promise<void>;
}

interface ProxyBullJob {
  getState(): Promise<string>;
  remove(): Promise<void>;
}

/** The slice of BullMQ's `Queue` this module uses; a unit test passes a fake. */
export interface ProxyBullQueue {
  add(name: string, data: ProxyInstallJobPayload, opts: JobsOptions & { jobId: string }): Promise<{ id?: string | undefined }>;
  getJob(jobId: string): Promise<ProxyBullJob | undefined>;
  close(): Promise<void>;
}

export type CreateProxyQueueOptions = (
  | { readonly connection: Redis; readonly queue?: never }
  | { readonly queue: ProxyBullQueue; readonly connection?: never }
) & {
  readonly enqueueTimeoutMs?: number;
};

const DEFAULT_ENQUEUE_TIMEOUT_MS = 2000;
const PENDING_JOB_STATES = new Set(['waiting', 'active', 'delayed', 'prioritized', 'waiting-children']);
const UNAVAILABLE = { ok: false, code: 'QUEUE_UNAVAILABLE', message: 'Job queue is unavailable' } as const;

async function withTimeout<T>(work: Promise<T>, timeoutMs: number): Promise<T> {
  let handle: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<never>((_resolve, reject) => {
        handle = setTimeout(() => {
          reject(new Error('proxy-queue: operation timed out'));
        }, timeoutMs);
      }),
    ]);
  } finally {
    if (handle !== undefined) clearTimeout(handle);
  }
}

export function createProxyQueue(options: CreateProxyQueueOptions): ProxyQueue {
  const queue: ProxyBullQueue =
    options.queue ??
    new Queue<ProxyInstallJobPayload>(PROXY_QUEUE_NAME, { connection: options.connection, prefix: BULLMQ_PREFIX });
  const timeoutMs = options.enqueueTimeoutMs ?? DEFAULT_ENQUEUE_TIMEOUT_MS;

  async function enqueue(payload: ProxyInstallJobPayload): Promise<ProxyEnqueueResult> {
    // Defence in depth: only the ids-and-email payload ever reaches Redis.
    const parsed = ProxyInstallJobPayloadSchema.safeParse(payload);
    if (!parsed.success) return UNAVAILABLE;
    const jobId = jobIdForProxyInstall(parsed.data.serverId);
    try {
      return await withTimeout(
        (async (): Promise<ProxyEnqueueResult> => {
          const existing = await queue.getJob(jobId);
          if (existing) {
            if (PENDING_JOB_STATES.has(await existing.getState())) return { ok: true, jobId, collapsed: true };
            // A finished job still stored would make BullMQ ignore the add (same jobId).
            await existing.remove();
          }
          const job = await queue.add(PROXY_INSTALL_JOB_NAME, parsed.data, {
            jobId,
            attempts: 1,
            removeOnComplete: true,
            removeOnFail: true,
          });
          return { ok: true, jobId: job.id ?? jobId, collapsed: false };
        })(),
        timeoutMs,
      );
    } catch {
      // Fixed message: ioredis/BullMQ error text can embed the Redis host, port or password.
      return UNAVAILABLE;
    }
  }

  async function isInstallPending(serverId: string): Promise<boolean> {
    try {
      return await withTimeout(
        (async () => {
          const job = await queue.getJob(jobIdForProxyInstall(serverId));
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

  return { enqueue, isInstallPending, close };
}
