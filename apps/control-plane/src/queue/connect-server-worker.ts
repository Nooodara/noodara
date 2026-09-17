// D-10/D-12/D-15/ACT-01: the job handler side of the connect-server background path — the second
// half of the pair with `connect-server-queue.ts`. Runs `connectAndDiscover` off the API thread,
// recovers a stalled job by resolving to `ERROR` (never reconnecting), and sweeps `CONNECTING`
// rows abandoned by a crashed worker at startup. This file must never reach into the activity
// write path or a Drizzle schema table directly (the ACT-01 boundary test forbids a worker
// writing activity events itself) — every state change flows through `ServerServices`.
import { Job, Worker } from 'bullmq';
import type { FastifyBaseLogger } from 'fastify';
import type { Redis } from 'ioredis';
import type { Logger } from 'pino';
import { createServerServices, type ServerServices } from '../services/server-services.js';
import type { ServerServicesDeps } from '../services/server-service-deps.js';
import { BULLMQ_PREFIX, QUEUE_NAME, type ConnectServerQueue } from './connect-server-queue.js';
import { parseConnectServerJobPayload } from './job-payload.js';

export interface ConnectServerWorkerHandle {
  readonly worker: Worker;
  close(): Promise<void>;
}

export interface CreateWorkerOptions {
  readonly connection: Redis;
  // Accepted for API symmetry with worker.ts's single options bag (and for callers that want to
  // build the whole worker+queue+sweep together) — the `stalled` listener below fetches the job
  // via BullMQ's own `Job.fromId(worker, jobId)` instead, since `ConnectServerQueue`'s
  // deliberately narrow port never exposes `getJob`.
  readonly queue: ConnectServerQueue;
  readonly logger: FastifyBaseLogger | Logger;
  readonly concurrency: number;
  readonly lockDurationMs: number;
  readonly stalledIntervalMs: number;
}

interface JobOutcome {
  readonly outcome: string;
}

/**
 * Builds the real BullMQ `Worker` for the `servers` queue: `createServerServices(deps)` once, a
 * handler that always drives the same `connectAndDiscover` regardless of `trigger` (D-10), a
 * `failed` listener that never logs the job payload (D-15/T-4-10), and a `stalled` listener that
 * recovers via `failInFlightConnection` instead of ever reconnecting (D-12/T-4-29).
 *
 * `maxStalledCount: 0` is load-bearing: BullMQ's default of 1 would move a stalled job back to
 * `waiting` and let a second worker re-run `connectAndDiscover` once before giving up — exactly
 * the double-SSH-execution D-12 forbids (RESEARCH Pitfall 1).
 */
export function createWorker(
  deps: ServerServicesDeps,
  options: CreateWorkerOptions,
): ConnectServerWorkerHandle {
  const services = createServerServices(deps);

  const worker = new Worker<unknown, JobOutcome>(
    QUEUE_NAME,
    async (job: Job<unknown, JobOutcome>): Promise<JobOutcome> => {
      const parsed = parseConnectServerJobPayload(job.data);
      if (!parsed.ok) {
        // T-4-03: a malformed/tampered Redis entry completes the job — it is not a bug in our
        // code and must never crash or retry the worker.
        options.logger.warn(
          { jobId: job.id, message: parsed.message },
          'connect-server job payload invalid',
        );
        return { outcome: 'INVALID_PAYLOAD' };
      }

      const { payload } = parsed;
      // D-10: one handler, one service call, regardless of whether `trigger` is 'connect' or
      // 'discover' — the HTTP-level precondition already differs between the two routes.
      const result = await services.connectAndDiscover({
        actor: payload.actor,
        serverId: payload.serverId,
      });

      if (result.ok) {
        return { outcome: 'ok' };
      }

      // D-15: an expected failure code is a completed job, logged at warn — never failed.
      options.logger.warn(
        { jobId: job.id, serverId: payload.serverId, code: result.code },
        'connect-server job completed with an expected failure code',
      );
      return { outcome: result.code };
    },
    {
      connection: options.connection,
      prefix: BULLMQ_PREFIX,
      concurrency: options.concurrency,
      lockDuration: options.lockDurationMs,
      stalledInterval: options.stalledIntervalMs,
      maxStalledCount: 0,
    },
  );

  // D-15/T-4-10: only `jobId` and the (pino-redaction-covered) `err` — never `job.data`, which a
  // careless `{ job }` here would otherwise capture wholesale.
  worker.on('failed', (job, err) => {
    options.logger.error({ jobId: job?.id, err }, 'connect-server job failed');
  });

  // D-12/T-4-29: recovery never reconnects over SSH. The whole body is wrapped in try/catch — an
  // unhandled rejection inside a BullMQ event listener would take the whole process down.
  worker.on('stalled', (jobId: string) => {
    void (async (): Promise<void> => {
      try {
        const job = await Job.fromId<unknown, JobOutcome>(worker, jobId);
        if (!job) return;

        const parsed = parseConnectServerJobPayload(job.data);
        if (!parsed.ok) {
          options.logger.warn(
            { jobId, message: parsed.message },
            'stalled connect-server job has an invalid payload; skipping recovery',
          );
          return;
        }

        await services.failInFlightConnection({
          serverId: parsed.payload.serverId,
          actor: parsed.payload.actor,
          reason: 'worker_stalled',
        });
      } catch (err) {
        options.logger.error({ jobId, err }, 'connect-server stalled-job recovery failed');
      }
    })();
  });

  async function close(): Promise<void> {
    await worker.close();
  }

  return { worker, close };
}

/**
 * D-12's startup half: resolves every `CONNECTING` server that has no live job in the queue,
 * attributed to the system actor since no admin requested this recovery. Callable independently
 * of a running worker — `worker.ts` runs it once before starting to consume jobs, and
 * `startup-recovery.test.ts` calls it directly.
 */
export async function sweepAbandonedConnections(
  services: ServerServices,
  queue: ConnectServerQueue,
  logger: FastifyBaseLogger | Logger,
): Promise<number> {
  const ids = await services.listConnectingServerIds();
  let resolvedCount = 0;

  for (const id of ids) {
    const pending = await queue.isJobPending(id);
    if (pending) continue;

    const result = await services.failInFlightConnection({
      serverId: id,
      actor: { type: 'system' },
      reason: 'worker_startup_sweep',
    });
    if (result.ok && !result.skipped) {
      resolvedCount += 1;
    }
  }

  logger.info(
    { scanned: ids.length, resolvedCount },
    'worker startup sweep for abandoned CONNECTING servers',
  );
  return resolvedCount;
}
