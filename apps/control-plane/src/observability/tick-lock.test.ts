// 27-02 (H1): the collector tick never overlaps itself, in one process or across workers.
import { describe, expect, it } from 'vitest';
import { guardTick, METRICS_TICK_LOCK_KEY, type TickLockRedis } from './tick-lock.js';

function memoryRedis() {
  const keys = new Map<string, { value: string; ttlMs: number }>();
  const redis: TickLockRedis = {
    setNxPx(key, value, ttlMs) {
      if (keys.has(key)) return Promise.resolve(false);
      keys.set(key, { value, ttlMs });
      return Promise.resolve(true);
    },
    delIfEquals(key, value) {
      if (keys.get(key)?.value === value) keys.delete(key);
      return Promise.resolve();
    },
  };
  return { keys, redis };
}

function deferred() {
  let resolve: () => void = () => undefined;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

describe('guardTick (27-02 H1)', () => {
  it('two workers sharing Redis run one tick; the lock is released afterwards', async () => {
    const { keys, redis } = memoryRedis();
    const gate = deferred();
    let runs = 0;
    const tick = async () => {
      runs += 1;
      await gate.promise;
      return runs;
    };
    const workerA = guardTick(tick, { redis, ttlMs: 90_000 });
    const workerB = guardTick(tick, { redis, ttlMs: 90_000 });

    const first = workerA();
    const second = await workerB();
    expect(second).toEqual({ ran: false });
    expect(keys.get(METRICS_TICK_LOCK_KEY)?.ttlMs).toBe(90_000);
    gate.resolve();
    expect(await first).toEqual({ ran: true, value: 1 });
    expect(runs).toBe(1);
    expect(keys.size).toBe(0);
    expect(await workerB()).toEqual({ ran: true, value: 2 });
  });

  it('a tick still running in this process makes the next one a no-op', async () => {
    const { redis } = memoryRedis();
    const gate = deferred();
    const guarded = guardTick(() => gate.promise.then(() => 'done'), { redis, ttlMs: 1_000 });
    const first = guarded();
    expect(await guarded()).toEqual({ ran: false });
    gate.resolve();
    expect(await first).toEqual({ ran: true, value: 'done' });
  });

  it('never deletes a lock another worker took after this one expired', async () => {
    const { keys, redis } = memoryRedis();
    const guarded = guardTick(
      () => {
        // This tick's lock expired and another worker now holds the key.
        keys.set(METRICS_TICK_LOCK_KEY, { value: 'other-token', ttlMs: 1 });
        return Promise.resolve(0);
      },
      { redis, ttlMs: 1_000 },
    );
    await guarded();
    expect(keys.get(METRICS_TICK_LOCK_KEY)?.value).toBe('other-token');
  });

  it('releases the lock when the tick throws, and a failed release leaves it to the TTL', async () => {
    const { keys, redis } = memoryRedis();
    const failing = guardTick(() => Promise.reject(new Error('boom')), { redis, ttlMs: 1_000 });
    await expect(failing()).rejects.toThrow('boom');
    expect(keys.size).toBe(0);

    const brokenRelease: TickLockRedis = { ...redis, delIfEquals: () => Promise.reject(new Error('redis down')) };
    const guarded = guardTick(() => Promise.resolve(1), { redis: brokenRelease, ttlMs: 1_000 });
    expect(await guarded()).toEqual({ ran: true, value: 1 });
  });
});
