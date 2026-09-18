import { Queue } from 'bullmq';
import type { Redis } from 'ioredis';
import type { ConnectServerJobPayload } from './job-payload.js';

// D-09/D-27/D-28: the producer half of the background connect path. This module never imports
// `env.js` — the connection is injected, which is what lets the integration test point it at a
// Testcontainers Redis instead of the real one.

export const QUEUE_NAME = 'servers';
export const CONNECT_SERVER_JOB_NAME = 'connect-server';
export const BULLMQ_PREFIX = 'noodara';

// D-09: deterministic per-server jobId so BullMQ dedupes a second `queue.add` while the first
// job is still waiting/active/delayed. Uses `-`, not `:`, as the separator: BullMQ 6.x's own
// `Job.validateOptions` rejects any custom jobId containing exactly one `:` ("Custom Id cannot
// contain :" — it reserves that shape for its own internal repeatable-job ids, verified against
// bullmq@6.3.6's actual runtime behavior, not just its types). `connect:<serverId>` — the literal
// format named in 04-CONTEXT.md's D-09 — throws at every single `enqueue` call; `connect-<id>` is
// the same deterministic-per-server contract without relying on that undocumented, TODO-marked
// compatibility carve-out.
export function jobIdForServer(serverId: string): string {
  return `connect-${serverId}`;
}

export type EnqueueResult =
  | { readonly ok: true; readonly jobId: string }
  | { readonly ok: false; readonly code: 'QUEUE_UNAVAILABLE'; readonly message: string };

export interface ConnectServerQueue {
  enqueue(payload: ConnectServerJobPayload): Promise<EnqueueResult>;
  isJobPending(serverId: string): Promise<boolean>;
  close(): Promise<void>;
}

// D-27's ~2s bound on the route path. Belt-and-braces over ioredis's own `commandTimeout`: a
// connection stuck mid-reconnect can sit in ioredis's offline command queue indefinitely instead
// of ever rejecting on its own.
const ENQUEUE_TIMEOUT_MS = 2000;

// A job in any of these states means "still live" for D-09's dedupe purposes; `completed`/
// `failed` jobs are no longer in flight even if `removeOnComplete`/`removeOnFail` hasn't swept
// them yet.
const PENDING_JOB_STATES = new Set(['waiting', 'active', 'delayed']);

export function createConnectServerQueue(options: { readonly connection: Redis }): ConnectServerQueue {
  const queue = new Queue<ConnectServerJobPayload>(QUEUE_NAME, {
    connection: options.connection,
    prefix: BULLMQ_PREFIX,
  });

  /**
   * BullMQ's own `add()` treats *any* existing job hash under a given `jobId` — including one
   * that already reached `completed`/`failed` and is only still present because
   * `removeOnComplete`/`removeOnFail`'s count-based retention hasn't swept it yet — as a
   * duplicate: it silently returns the stale job reference without ever creating a new "waiting"
   * entry (bullmq's own `addStandardJob` Lua script, `handleDuplicatedJob`). D-09's dedupe window
   * only intends to cover a job that is still `waiting`/`active`/`delayed`; left unhandled, every
   * `/connect` or `/discover` call issued after the very first job for a server ever finished
   * would 202 with a jobId the worker never touches again, silently breaking DISC-05's "re-run
   * discovery" the moment a server has connected once. Clearing a genuinely terminal job before
   * adding restores the intended semantics without weakening the real in-flight dedupe an active
   * double-click still needs (an active/waiting/delayed job is left untouched).
   */
  async function addFreshJob(payload: ConnectServerJobPayload, jobId: string) {
    const existing = await queue.getJob(jobId);
    if (existing) {
      const state = await existing.getState();
      if (!PENDING_JOB_STATES.has(state)) {
        await existing.remove();
      }
    }

    return queue.add(CONNECT_SERVER_JOB_NAME, payload, {
      jobId,
      // D-12: the SSH adapter already retries transients itself (Phase 2 D-10) and
      // connectAndDiscover never throws for an SSH failure, so a BullMQ retry could only ever
      // re-run a job whose failure was a real bug.
      attempts: 1,
      removeOnComplete: { count: 100 },
      removeOnFail: { count: 500 },
    });
  }

  async function enqueue(payload: ConnectServerJobPayload): Promise<EnqueueResult> {
    const jobId = jobIdForServer(payload.serverId);
    let timeoutHandle: ReturnType<typeof setTimeout> | undefined;

    try {
      const job = await Promise.race([
        addFreshJob(payload, jobId),
        new Promise<never>((_resolve, reject) => {
          timeoutHandle = setTimeout(() => {
            reject(new Error('connect-server-queue: enqueue timed out'));
          }, ENQUEUE_TIMEOUT_MS);
        }),
      ]);

      return { ok: true, jobId: job.id ?? jobId };
    } catch {
      // Fixed message — never the underlying ioredis/BullMQ error text, which can embed the
      // Redis host and port (T-4-27).
      return { ok: false, code: 'QUEUE_UNAVAILABLE', message: 'Job queue is unavailable' };
    } finally {
      if (timeoutHandle !== undefined) clearTimeout(timeoutHandle);
    }
  }

  async function isJobPending(serverId: string): Promise<boolean> {
    try {
      const job = await queue.getJob(jobIdForServer(serverId));
      if (!job) return false;

      const state = await job.getState();
      return PENDING_JOB_STATES.has(state);
    } catch {
      // "Cannot tell" is treated as "no live job" — the safe direction, since the worker's
      // startup sweep (Plan 04-07) acts on this and that action is itself idempotent.
      return false;
    }
  }

  async function close(): Promise<void> {
    // Closes only the Queue instance, never `options.connection` — the caller owns the
    // connection's lifetime.
    await queue.close();
  }

  return { enqueue, isJobPending, close };
}
