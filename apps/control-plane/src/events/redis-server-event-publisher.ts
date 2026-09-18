// D-03/D-04/T-4-38: the Redis-backed implementation of the `ServerEventPublisher` port
// (`server-event-publisher.ts`, Plan 04-03). Owns the one channel every publisher and subscriber
// in this codebase must agree on (`SERVER_EVENTS_CHANNEL`) — the broadcaster (Task 2) imports the
// constant from here rather than re-typing the literal a second time.
import type { FastifyBaseLogger } from 'fastify';
import type { Redis } from 'ioredis';
import type { Logger } from 'pino';
import type { ServerEvent, ServerEventPublisher } from './server-event-publisher.js';

export const SERVER_EVENTS_CHANNEL = 'noodara:server-events';

/**
 * Builds the Redis-backed `ServerEventPublisher`. `publish` never re-projects or filters
 * `event.server` — `toServerView`'s allowlist is already the one place that decides what leaves
 * the process, and a second, drifting filter here would be worse than none. The `at` timestamp is
 * this adapter's own (never the caller's), added once, right before serialisation.
 *
 * D-04's contract: a `redis.publish` rejection or throw is caught here, logged at warn through
 * pino's `err` serializer with a fixed message (T-4-38: no Redis URL/host/port ever gets
 * string-interpolated into the log line), and `publish` still resolves — Postgres is the truth,
 * SSE is best-effort.
 */
export function createRedisServerEventPublisher(
  redis: Redis,
  logger: FastifyBaseLogger | Logger,
): ServerEventPublisher {
  return {
    async publish(event: ServerEvent): Promise<void> {
      try {
        const payload = JSON.stringify({ ...event, at: new Date().toISOString() });
        await redis.publish(SERVER_EVENTS_CHANNEL, payload);
      } catch (err) {
        logger.warn({ err }, 'failed to publish server event');
      }
    },
  };
}
