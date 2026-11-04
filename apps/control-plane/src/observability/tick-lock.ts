// 27-02 (H1): the collector tick never overlaps itself, across workers or in one process. A Redis
// key (SET NX PX) is held for the tick; its TTL (deadline + margin) frees it if a worker dies
// mid-tick, and release only deletes the key while it still holds this tick's token.
import { randomUUID } from 'node:crypto';
import type { Redis } from 'ioredis';

export const METRICS_TICK_LOCK_KEY = 'noodara:metrics:tick-lock';

export interface TickLockRedis {
  setNxPx(key: string, value: string, ttlMs: number): Promise<boolean>;
  /** Deletes `key` only while it holds `value`. */
  delIfEquals(key: string, value: string): Promise<void>;
}

const RELEASE_SCRIPT = "if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('del', KEYS[1]) else return 0 end";

export function tickLockRedisFrom(redis: Redis): TickLockRedis {
  return {
    async setNxPx(key, value, ttlMs) {
      return (await redis.set(key, value, 'PX', ttlMs, 'NX')) === 'OK';
    },
    async delIfEquals(key, value) {
      await redis.eval(RELEASE_SCRIPT, 1, key, value);
    },
  };
}

export type GuardedRun<T> = { readonly ran: true; readonly value: T } | { readonly ran: false };

/** Runs `tick` only when no other tick (here or in another worker) holds the lock. */
export function guardTick<T>(
  tick: () => Promise<T>,
  options: { readonly redis: TickLockRedis; readonly ttlMs: number; readonly key?: string },
): () => Promise<GuardedRun<T>> {
  const key = options.key ?? METRICS_TICK_LOCK_KEY;
  let running = false;
  return async () => {
    if (running) return { ran: false };
    running = true;
    try {
      const token = randomUUID();
      if (!(await options.redis.setNxPx(key, token, options.ttlMs))) return { ran: false };
      try {
        return { ran: true, value: await tick() };
      } finally {
        try {
          await options.redis.delIfEquals(key, token);
        } catch {
          // The TTL frees the key.
        }
      }
    } finally {
      running = false;
    }
  };
}
