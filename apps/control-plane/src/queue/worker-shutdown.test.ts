// T-4-32: RED for the extracted, unit-tested worker shutdown sequence. Every cleanup step
// (stopHeartbeat, closeQueue, each disconnect) must run even when an earlier step rejects or
// throws, and `exit` must always eventually be called with 0. Mirrors `session-lookup.test.ts`'s
// fake-timer style for the never-settling `close` case.
import { describe, expect, it, vi } from 'vitest';
import { runWorkerShutdown } from './worker-shutdown.js';

function createDeps(overrides: Partial<Parameters<typeof runWorkerShutdown>[0]> = {}) {
  const disconnectCalls: string[] = [];
  const disconnect = [
    vi.fn(() => {
      disconnectCalls.push('worker');
    }),
    vi.fn(() => {
      disconnectCalls.push('queue');
    }),
    vi.fn(() => {
      disconnectCalls.push('publisher');
    }),
  ];

  return {
    close: vi.fn(() => Promise.resolve()),
    graceMs: 1000,
    stopHeartbeat: vi.fn(),
    closeQueue: vi.fn(() => Promise.resolve()),
    disconnect,
    logger: { warn: vi.fn() },
    exit: vi.fn(),
    disconnectCalls,
    ...overrides,
  };
}

describe('runWorkerShutdown', () => {
  it('runs every cleanup step exactly once, in order, and exits 0 when close resolves', async () => {
    const deps = createDeps();

    await runWorkerShutdown(deps);

    expect(deps.stopHeartbeat).toHaveBeenCalledTimes(1);
    expect(deps.closeQueue).toHaveBeenCalledTimes(1);
    for (const fn of deps.disconnect) {
      expect(fn).toHaveBeenCalledTimes(1);
    }
    expect(deps.disconnectCalls).toEqual(['worker', 'queue', 'publisher']);
    expect(deps.exit).toHaveBeenCalledExactlyOnceWith(0);
  });

  it('still runs every cleanup step and exits 0 when close rejects', async () => {
    const deps = createDeps({ close: vi.fn(() => Promise.reject(new Error('close failed'))) });

    await runWorkerShutdown(deps);

    expect(deps.stopHeartbeat).toHaveBeenCalledTimes(1);
    expect(deps.closeQueue).toHaveBeenCalledTimes(1);
    for (const fn of deps.disconnect) {
      expect(fn).toHaveBeenCalledTimes(1);
    }
    expect(deps.exit).toHaveBeenCalledExactlyOnceWith(0);
    expect(deps.logger.warn).toHaveBeenCalledTimes(1);
  });

  it('proceeds after the grace bound elapses when close never settles, still running every step', async () => {
    vi.useFakeTimers();
    try {
      const deps = createDeps({
        close: vi.fn(() => new Promise<void>(() => undefined)),
        graceMs: 50,
      });

      const pending = runWorkerShutdown(deps);
      await vi.advanceTimersByTimeAsync(50);
      await pending;

      expect(deps.stopHeartbeat).toHaveBeenCalledTimes(1);
      expect(deps.closeQueue).toHaveBeenCalledTimes(1);
      for (const fn of deps.disconnect) {
        expect(fn).toHaveBeenCalledTimes(1);
      }
      expect(deps.exit).toHaveBeenCalledExactlyOnceWith(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('still runs every disconnect and exits 0 when closeQueue rejects', async () => {
    const deps = createDeps({ closeQueue: vi.fn(() => Promise.reject(new Error('queue close failed'))) });

    await runWorkerShutdown(deps);

    for (const fn of deps.disconnect) {
      expect(fn).toHaveBeenCalledTimes(1);
    }
    expect(deps.exit).toHaveBeenCalledExactlyOnceWith(0);
  });

  it('runs the sequence only once across two concurrent invocations', async () => {
    const deps = createDeps();

    await Promise.all([runWorkerShutdown(deps), runWorkerShutdown(deps)]);

    expect(deps.stopHeartbeat).toHaveBeenCalledTimes(1);
    expect(deps.closeQueue).toHaveBeenCalledTimes(1);
    expect(deps.exit).toHaveBeenCalledTimes(1);
  });
});
