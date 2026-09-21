// Must be the very first import: `env.ts`'s module-level `loadEnv(process.env)` call is the
// INST-06 fail-fast gate — it must run, and exit the process on failure, before anything else
// (the DB pool, Redis connections, the BullMQ worker) is even constructed. Mirrors server.ts's
// entrypoint shape exactly (D-23): env-first, fail-fast dependencies, then start.
import './env.js';

import { hostname } from 'node:os';
import { getDb } from './db/client.js';
import { env } from './env.js';
import { createRedisServerEventPublisher } from './events/redis-server-event-publisher.js';
import { createLogger } from './logger.js';
import { computeJobLockDurationMs } from './queue/job-budget.js';
import { createConnectServerQueue } from './queue/connect-server-queue.js';
import { createWorker, sweepAbandonedConnections } from './queue/connect-server-worker.js';
import { startWorkerHeartbeat } from './queue/worker-heartbeat.js';
import { runWorkerShutdown } from './queue/worker-shutdown.js';
import {
  createPublisherRedisConnection,
  createQueueRedisConnection,
  createWorkerRedisConnection,
} from './redis/connections.js';
import { resolveServerServicesDeps } from './services/server-service-deps.js';
import { createServerServices } from './services/server-services.js';

const logger = createLogger();
const workerId = `${hostname()}-${String(process.pid)}`;

async function main(): Promise<void> {
  // D-25: the worker demands both Postgres and Redis at startup (fail-fast) — a Postgres pool
  // that never establishes, or a Redis that never answers a bounded `ping`, must abort the boot
  // loudly rather than start a worker that silently never processes a job.
  const db = await getDb();

  const queueConnection = createQueueRedisConnection(env.REDIS_URL);
  const workerConnection = createWorkerRedisConnection(env.REDIS_URL);
  // The queue connection's own `commandTimeout`/`maxRetriesPerRequest: 1` (D-27) bound this ping
  // to a few seconds — the worker connection deliberately has neither (BullMQ's own requirement),
  // so it is never the one probed for reachability at boot.
  await queueConnection.ping();

  // D-04: the worker publishes through the same Redis-backed adapter the API's HTTP routes do —
  // `connectAndDiscover`'s two publish sites (Plan 04-03) reach the API's SSE broadcaster only
  // because this is a real `ServerEventPublisher`, not the noop default.
  const publisherConnection = createPublisherRedisConnection(env.REDIS_URL);
  const eventPublisher = createRedisServerEventPublisher(publisherConnection, logger);
  // GR-03: the worker's own module-level `logger` above — no second logger instance — so a
  // swallowed `connectAndDiscover` recovery failure surfaces through the same log stream every
  // other worker log line already goes through.
  const deps = await resolveServerServicesDeps({ db, events: eventPublisher, logger });
  const services = createServerServices(deps);
  const queue = createConnectServerQueue({ connection: queueConnection });

  const lockDurationMs = computeJobLockDurationMs({
    connectMs: env.NOODARA_SSH_CONNECT_TIMEOUT_MS,
    commandMs: env.NOODARA_SSH_COMMAND_TIMEOUT_MS,
    discoveryMs: env.NOODARA_SSH_DISCOVERY_TIMEOUT_MS,
  });

  const sweptCount = await sweepAbandonedConnections(services, queue, logger);
  logger.info({ sweptCount }, 'worker startup sweep for abandoned CONNECTING servers complete');

  const stopHeartbeat = startWorkerHeartbeat(workerConnection, workerId);

  const handle = createWorker(deps, {
    connection: workerConnection,
    queue,
    logger,
    concurrency: env.NOODARA_WORKER_CONCURRENCY,
    lockDurationMs,
    stalledIntervalMs: lockDurationMs,
  });

  // The literal "Worker ready" is the boot smoke test's deterministic stdout marker, mirroring
  // how server.ts's "Server listening" line is used today.
  logger.info({ concurrency: env.NOODARA_WORKER_CONCURRENCY, workerId }, 'Worker ready');

  // T-4-32: kept alongside `runWorkerShutdown`'s own identity-keyed re-entry guard — this local
  // flag is checked/set synchronously before `runWorkerShutdown` is even called, so a second
  // SIGTERM/SIGINT arriving while shutdown is already in flight never starts a second shutdown
  // sequence (the helper's own guard would not dedupe two separately-built deps object literals).
  let shuttingDown = false;
  async function shutdown(): Promise<void> {
    if (shuttingDown) return;
    shuttingDown = true;

    // D-25: stop intake and wait for active jobs up to the D-14 budget; exceeding it still exits
    // — the next startup's CONNECTING sweep cleans up whatever was mid-flight. Every cleanup step
    // now runs even if `handle.close()` or `queue.close()` rejects (T-4-32).
    await runWorkerShutdown({
      close: () => handle.close(),
      graceMs: lockDurationMs,
      stopHeartbeat,
      closeQueue: () => queue.close(),
      disconnect: [
        () => {
          workerConnection.disconnect();
        },
        () => {
          queueConnection.disconnect();
        },
        () => {
          publisherConnection.disconnect();
        },
      ],
      logger,
      exit: (code) => {
        process.exit(code);
      },
    });
  }

  process.on('SIGTERM', () => void shutdown());
  process.on('SIGINT', () => void shutdown());
}

// UF-02/04-SECURITY.md: this entrypoint used to invoke `main` with a bare, uncaught `void` call,
// which let a boot-time rejection (an unreachable Postgres/Redis, `resolveServerServicesDeps`'s
// master-key decode, `sweepAbandonedConnections`) surface as a raw Node crash dump (stack, own
// properties, `cause` via `util.inspect`) instead of a structured, redaction-covered pino line --
// and relied entirely on Node's own default `--unhandled-rejections` mode for the process to exit
// non-zero at all. `server.ts`'s own entrypoint (D-23's documented sibling shape) has no guard on
// its own equivalent bottom-level call either, so there is no existing guard to match here; this
// uses the shape 05-34-PLAN.md's own fallback names, and `server.ts`'s equivalent gap is out of
// this plan's scope (05-REVIEW.md's own "out-of-scope observation" already flags it separately).
main().catch((err: unknown) => {
  logger.error({ err }, 'worker boot failed');
  process.exit(1);
});
