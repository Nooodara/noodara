// D-26: the worker's liveness signal in Redis. `/health` (Plan 04-10) scans this key namespace to
// report `checks.worker` — the prefix and key-building function live here so no later file
// re-types the literal `noodara:worker:` namespace.
import type { Redis } from 'ioredis';

export const WORKER_HEARTBEAT_KEY_PREFIX = 'noodara:worker:';

export function workerHeartbeatKey(workerId: string): string {
  return `${WORKER_HEARTBEAT_KEY_PREFIX}${workerId}`;
}

export interface StartWorkerHeartbeatOptions {
  readonly intervalMs?: number;
  readonly ttlSeconds?: number;
}

/**
 * Writes `noodara:worker:<workerId>` immediately (so a freshly started worker is visible without
 * waiting a tick), then again on every `intervalMs` tick, each write carrying a fresh
 * `EX ttlSeconds` TTL. The value carries only a timestamp and the workerId — no env, no host
 * list, no job data (D-26).
 *
 * A Redis error on any single write logs at warn and never rejects (D-25: Redis trouble never
 * kills the worker) — `console.warn`, not the shared `createLogger`/pino setup, since importing
 * `logger.ts` would transitively import `env.ts` purely to log a warning (same reasoning as
 * `redis/connections.ts`).
 *
 * `.unref()` on the interval so the heartbeat can never keep the process alive on its own. The
 * returned stop function clears the interval; no further writes occur after it is called.
 */
export function startWorkerHeartbeat(
  redis: Redis,
  workerId: string,
  options: StartWorkerHeartbeatOptions = {},
): () => void {
  const intervalMs = options.intervalMs ?? 10_000;
  const ttlSeconds = options.ttlSeconds ?? 30;
  const key = workerHeartbeatKey(workerId);

  function write(): void {
    const value = JSON.stringify({ workerId, at: new Date().toISOString() });
    redis.set(key, value, 'EX', ttlSeconds).catch((err: unknown) => {
      const name = err instanceof Error ? err.name : 'UnknownError';
      console.warn(`[worker-heartbeat] write failed: ${name}`);
    });
  }

  write();
  const timer = setInterval(write, intervalMs);
  timer.unref();

  return function stopWorkerHeartbeat(): void {
    clearInterval(timer);
  };
}
