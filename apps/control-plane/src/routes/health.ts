// D-26/T-4-41/T-4-42: `GET /health` — reports Postgres, Redis and worker-heartbeat liveness
// individually. A dead Postgres is 503 (the orchestrator should restart the API); a missing
// worker heartbeat or an unreachable Redis is 200 `degraded` — the orchestrator must never
// restart the API just because the worker or Redis is down. Every check is individually
// time-bounded and never throws out of the handler: a container healthcheck must get an answer
// within a couple of seconds even when a dependency is genuinely wedged, not merely refused.
import type { ZodTypeProvider } from '@fastify/type-provider-zod';
import type { FastifyInstance, FastifyPluginCallback } from 'fastify';
import type { Redis } from 'ioredis';
import { sql } from 'drizzle-orm';
import { z } from 'zod';
import { CONTROL_PLANE_VERSION } from '../config-version.js';
import { getDb } from '../db/client.js';
import { WORKER_HEARTBEAT_KEY_PREFIX } from '../queue/worker-heartbeat.js';

declare module 'fastify' {
  interface FastifyInstance {
    getHealthRedis(): Redis;
  }
}

const CHECK_TIMEOUT_MS = 2000;
const WORKER_SCAN_COUNT = 10;
const MAX_SCAN_ITERATIONS = 1000;

type CheckResult = 'pass' | 'fail';

/** Races `fn()` against a fixed timer — a hung dependency resolves to the timeout branch, never
 *  leaving the caller waiting past `ms`. The loser (a still-pending `fn()` promise) is simply
 *  abandoned, exactly like `app.ts`'s own onReady/preClose bounded races. */
function withTimeout<T>(fn: () => Promise<T>, ms: number): Promise<T> {
  return Promise.race([
    fn(),
    new Promise<never>((_resolve, reject) => {
      setTimeout(() => {
        reject(new Error('health check timed out'));
      }, ms);
    }),
  ]);
}

async function checkPostgres(): Promise<CheckResult> {
  try {
    const db = await getDb();
    await withTimeout(() => db.execute(sql`select 1`), CHECK_TIMEOUT_MS);
    return 'pass';
  } catch {
    return 'fail';
  }
}

async function checkRedis(redis: Redis): Promise<CheckResult> {
  try {
    await withTimeout(() => redis.ping(), CHECK_TIMEOUT_MS);
    return 'pass';
  } catch {
    return 'fail';
  }
}

/** `SCAN`, never `KEYS` (D-26/RESEARCH): a full `KEYS noodara:worker:*` walk blocks Redis's single
 *  event loop for the duration of the scan on a large keyspace; a bounded-`COUNT` `SCAN` never
 *  does. `pass`es the instant one cursor iteration turns up at least one matching key — proving
 *  one live worker is enough, there is no need to enumerate every one. `MAX_SCAN_ITERATIONS`
 *  guards against an unbounded loop if Redis ever returned a cursor that never converges back to
 *  `'0'` (defensive only — `withTimeout`'s own bound is what actually protects the caller). */
async function checkWorker(redis: Redis): Promise<CheckResult> {
  try {
    return await withTimeout(async () => {
      let cursor = '0';
      for (let iteration = 0; iteration < MAX_SCAN_ITERATIONS; iteration += 1) {
        const [nextCursor, keys] = await redis.scan(
          cursor,
          'MATCH',
          `${WORKER_HEARTBEAT_KEY_PREFIX}*`,
          'COUNT',
          WORKER_SCAN_COUNT,
        );
        if (keys.length > 0) {
          return 'pass';
        }
        cursor = nextCursor;
        if (cursor === '0') {
          return 'fail';
        }
      }
      return 'fail';
    }, CHECK_TIMEOUT_MS);
  } catch {
    return 'fail';
  }
}

const HealthChecksSchema = z.object({
  postgres: z.enum(['pass', 'fail']),
  redis: z.enum(['pass', 'fail']),
  worker: z.enum(['pass', 'fail']),
});

const HealthResponseSchema = z.object({
  status: z.enum(['ok', 'degraded']),
  version: z.string(),
  checks: HealthChecksSchema,
});

const healthRoutes: FastifyPluginCallback = (fastify: FastifyInstance, _opts, done) => {
  fastify.withTypeProvider<ZodTypeProvider>().route({
    method: 'GET',
    url: '/health',
    schema: {
      response: {
        200: HealthResponseSchema,
        503: HealthResponseSchema,
      },
    },
    handler: async (_request, reply) => {
      const redis = fastify.getHealthRedis();
      const [postgres, redisCheck, worker] = await Promise.all([
        checkPostgres(),
        checkRedis(redis),
        checkWorker(redis),
      ]);

      const checks = { postgres, redis: redisCheck, worker };

      // D-26: Postgres is the only check that ever produces a non-2xx status — the orchestrator
      // must restart the API for a dead database, but never merely because Redis or the worker
      // is unavailable.
      if (postgres === 'fail') {
        await reply.code(503).send({ status: 'degraded' as const, version: CONTROL_PLANE_VERSION, checks });
        return;
      }

      const status = redisCheck === 'fail' || worker === 'fail' ? ('degraded' as const) : ('ok' as const);
      await reply.send({ status, version: CONTROL_PLANE_VERSION, checks });
    },
  });

  done();
};

export default healthRoutes;
