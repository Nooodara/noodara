// D-26: RED for the worker heartbeat. `startWorkerHeartbeat` never imports `env.js`, so this file
// runs as a plain unit test with a fake Redis (no Testcontainers needed).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Redis } from 'ioredis';
import { startWorkerHeartbeat, workerHeartbeatKey, WORKER_HEARTBEAT_KEY_PREFIX } from './worker-heartbeat.js';

interface RecordedSet {
  readonly key: string;
  readonly value: string;
  readonly mode: string;
  readonly ttlSeconds: number;
}

function buildFakeRedis(options: { reject?: boolean } = {}): { redis: Redis; calls: RecordedSet[] } {
  const calls: RecordedSet[] = [];
  const fake = {
    set: vi.fn((key: string, value: string, mode: string, ttlSeconds: number) => {
      calls.push({ key, value, mode, ttlSeconds });
      return options.reject ? Promise.reject(new Error('redis unavailable')) : Promise.resolve('OK');
    }),
  };
  return { redis: fake as unknown as Redis, calls };
}

describe('workerHeartbeatKey / WORKER_HEARTBEAT_KEY_PREFIX', () => {
  it('builds the noodara:worker:<id> key from the shared prefix', () => {
    expect(WORKER_HEARTBEAT_KEY_PREFIX).toBe('noodara:worker:');
    expect(workerHeartbeatKey('worker-abc')).toBe('noodara:worker:worker-abc');
  });
});

describe('startWorkerHeartbeat', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('writes the key immediately with an EX 30 TTL by default', () => {
    const { redis, calls } = buildFakeRedis();
    const stop = startWorkerHeartbeat(redis, 'worker-1');

    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ key: 'noodara:worker:worker-1', mode: 'EX', ttlSeconds: 30 });
    const value = JSON.parse(calls[0]?.value ?? '{}') as { workerId: string; at: string };
    expect(value.workerId).toBe('worker-1');
    expect(typeof value.at).toBe('string');

    stop();
  });

  it('refreshes the key on every interval tick', () => {
    const { redis, calls } = buildFakeRedis();
    const stop = startWorkerHeartbeat(redis, 'worker-1', { intervalMs: 5000 });

    expect(calls).toHaveLength(1);
    vi.advanceTimersByTime(5000);
    expect(calls).toHaveLength(2);
    vi.advanceTimersByTime(5000);
    expect(calls).toHaveLength(3);

    stop();
  });

  it('honors a custom ttlSeconds on every write', () => {
    const { redis, calls } = buildFakeRedis();
    const stop = startWorkerHeartbeat(redis, 'worker-1', { intervalMs: 1000, ttlSeconds: 45 });

    vi.advanceTimersByTime(1000);
    expect(calls.every((call) => call.ttlSeconds === 45)).toBe(true);

    stop();
  });

  it('stop() halts further writes', () => {
    const { redis, calls } = buildFakeRedis();
    const stop = startWorkerHeartbeat(redis, 'worker-1', { intervalMs: 5000 });

    stop();
    vi.advanceTimersByTime(50_000);
    expect(calls).toHaveLength(1);
  });

  it('a rejecting redis.set logs a warning and never throws or rejects unhandled', async () => {
    const { redis } = buildFakeRedis({ reject: true });
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    const stop = startWorkerHeartbeat(redis, 'worker-1', { intervalMs: 5000 });
    await vi.advanceTimersByTimeAsync(0);

    expect(warnSpy).toHaveBeenCalled();
    expect(String(warnSpy.mock.calls[0]?.[0])).not.toContain('redis unavailable');

    stop();
    warnSpy.mockRestore();
  });
});
