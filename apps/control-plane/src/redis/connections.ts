// Named import (not `import Redis from 'ioredis'`): under this project's `verbatimModuleSyntax`
// + `nodenext` ESM config, the default-import binding type-checks as the whole CJS module
// namespace (no construct signature) even though it works fine at runtime — the named `Redis`
// export is both the real class value and its own type, so `new Redis(...)` and `: Redis` both
// resolve correctly from the same import.
import { Redis } from 'ioredis';

// D-27/D-28: each BullMQ role needs a different, easily-swapped-by-mistake ioredis setting — see
// RESEARCH.md "Anti-Patterns to Avoid" and 04-CONTEXT.md's D-27/D-28. Both factories take an
// explicit `url` parameter and never read `env.js` themselves, so a test can point either one at
// a Testcontainers Redis without booting the whole app's environment validation.

/**
 * Connection for the Queue *producer* (API process, `connect-server-queue.ts`). This connection
 * only ever issues short `queue.add`/`getJob` commands, so it is safe — and required by D-27 — to
 * bound every command to ~2s and fail fast rather than retry indefinitely against a dead Redis.
 */
export function createQueueRedisConnection(url: string): Redis {
  const connection = new Redis(url, {
    commandTimeout: 2000,
    maxRetriesPerRequest: 1,
    lazyConnect: false,
  });

  // D-27: an ioredis connection error must never escape as an unhandled rejection/exception.
  // Logged without `err.message` — a REDIS_URL can carry a password, and ioredis connection
  // errors sometimes echo back the options they failed with.
  connection.on('error', (err: Error) => {
    console.warn(`[redis] queue connection error: ${err.name}`);
  });

  return connection;
}

/**
 * Connection for the BullMQ Worker (worker process, Plan 04-07). BullMQ's Worker relies on a
 * long-blocking Redis command to wait for new jobs, so it must never receive a `commandTimeout` —
 * doing so would make the worker's own idle-wait fail spuriously (RESEARCH's own anti-pattern).
 * `maxRetriesPerRequest: null` is BullMQ's own hard requirement for a Worker connection.
 */
export function createWorkerRedisConnection(url: string): Redis {
  const connection = new Redis(url, {
    maxRetriesPerRequest: null,
  });

  connection.on('error', (err: Error) => {
    console.warn(`[redis] worker connection error: ${err.name}`);
  });

  return connection;
}
