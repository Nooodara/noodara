// 12-12 (A4): build-log retention. The purge itself (SQL) is proven in
// tests/integration/deploy-engine/runtime-build-logs.test.ts; here the cutoff and the scheduler.
import { describe, expect, it, vi } from 'vitest';
import { logRetentionCutoff, startDeploymentLogRetention, type RetentionTimers } from './log-retention.js';

function fakeTimers() {
  const scheduled: { fn: () => void; ms: number; id: number }[] = [];
  let nextId = 1;
  const timers: RetentionTimers = {
    setTimeout(fn, ms) {
      const id = nextId++;
      scheduled.push({ fn, ms, id });
      return id;
    },
    clearTimeout(handle) {
      const index = scheduled.findIndex((entry) => entry.id === handle);
      if (index >= 0) scheduled.splice(index, 1);
    },
  };
  return {
    timers,
    scheduled,
    async fireNext() {
      const next = scheduled.shift();
      next?.fn();
      for (let i = 0; i < 20; i += 1) await Promise.resolve();
    },
  };
}

const logger = () => ({ info: vi.fn(), warn: vi.fn() });

describe('logRetentionCutoff', () => {
  it('is exactly retentionDays before now', () => {
    expect(logRetentionCutoff(new Date('2026-10-31T12:00:00Z'), 30).toISOString()).toBe('2026-10-01T12:00:00.000Z');
  });

  it.each([0, -1, 1.5, 366, Number.NaN])('rejects %s days', (days) => {
    expect(() => logRetentionCutoff(new Date(), days)).toThrow(RangeError);
  });
});

describe('startDeploymentLogRetention', () => {
  it('purges once at start and then every interval with the cutoff for that run', async () => {
    const time = fakeTimers();
    let now = new Date('2026-10-31T00:00:00Z');
    const purge = vi.fn((_cutoff: Date) => Promise.resolve(3));
    const log = logger();
    const handle = startDeploymentLogRetention({
      purge,
      retentionDays: 7,
      intervalMs: 3_600_000,
      now: () => now,
      logger: log,
      timers: time.timers,
    });
    expect(time.scheduled[0]?.ms).toBe(0);
    await time.fireNext();
    expect(purge).toHaveBeenLastCalledWith(new Date('2026-10-24T00:00:00Z'));
    expect(log.info).toHaveBeenCalledWith({ deletedChunks: 3, retentionDays: 7 }, 'deployment log retention purge complete');
    expect(time.scheduled[0]?.ms).toBe(3_600_000);

    now = new Date('2026-11-01T00:00:00Z');
    await time.fireNext();
    expect(purge).toHaveBeenLastCalledWith(new Date('2026-10-25T00:00:00Z'));
    await handle.stop();
    expect(time.scheduled).toHaveLength(0);
  });

  it('logs a failed purge by error class only and keeps the schedule', async () => {
    const time = fakeTimers();
    const purge = vi.fn(() => Promise.reject(new Error('relation "x" password=hunter2')));
    const log = logger();
    const handle = startDeploymentLogRetention({ purge, retentionDays: 30, intervalMs: 60_000, logger: log, timers: time.timers });
    await time.fireNext();
    expect(log.warn).toHaveBeenCalledWith({ errorKind: 'Error' }, 'deployment log retention purge failed');
    expect(JSON.stringify(log.warn.mock.calls)).not.toContain('hunter2');
    expect(time.scheduled).toHaveLength(1);
    await handle.stop();
  });

  it('stop waits for an in-flight purge and schedules nothing after it', async () => {
    const time = fakeTimers();
    let release: (value: number) => void = () => undefined;
    const purge = vi.fn(() => new Promise<number>((resolve) => (release = resolve)));
    const handle = startDeploymentLogRetention({ purge, retentionDays: 30, intervalMs: 60_000, logger: logger(), timers: time.timers });
    await time.fireNext();
    let stopped = false;
    void handle.stop().then(() => {
      stopped = true;
    });
    await Promise.resolve();
    expect(stopped).toBe(false);
    release(0);
    for (let i = 0; i < 20; i += 1) await Promise.resolve();
    expect(stopped).toBe(true);
    expect(time.scheduled).toHaveLength(0);
  });

  it('rejects a non-positive interval', () => {
    expect(() =>
      startDeploymentLogRetention({ purge: () => Promise.resolve(0), retentionDays: 30, intervalMs: 0, logger: logger() }),
    ).toThrow(RangeError);
  });
});
