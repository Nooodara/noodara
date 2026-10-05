// 12-15 (A1, H1): the repeatable reconcile job and its non-overlap guarantee.
import { describe, expect, it, vi } from 'vitest';
import {
  RECONCILE_JOB_NAME,
  RECONCILE_QUEUE_NAME,
  RECONCILE_SCHEDULER_ID,
  serializeTicks,
  startReconcileLoop,
  type ReconcileQueueLike,
  type ReconcileWorkerLike,
} from './reconcile-runtime.js';

function deferred() {
  let resolve: () => void = () => undefined;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

const flush = () => new Promise((resolve) => setImmediate(resolve));

function silentLogger() {
  const logs: { level: string; fields: Record<string, unknown>; message: string }[] = [];
  return {
    logs,
    logger: {
      info: (fields: Record<string, unknown>, message: string) => logs.push({ level: 'info', fields, message }),
      warn: (fields: Record<string, unknown>, message: string) => logs.push({ level: 'warn', fields, message }),
      error: (fields: Record<string, unknown>, message: string) => logs.push({ level: 'error', fields, message }),
    },
  };
}

describe('serializeTicks (H1)', () => {
  it('a slow tick delays the next one instead of running concurrently', async () => {
    let active = 0;
    let maxActive = 0;
    const gates = [deferred(), deferred()];
    let calls = 0;
    const run = serializeTicks(async () => {
      const gate = gates[calls];
      calls += 1;
      active += 1;
      maxActive = Math.max(maxActive, active);
      await gate?.promise;
      active -= 1;
      return calls;
    });

    const first = run();
    const second = run();
    await flush();
    expect(calls).toBe(1);
    gates[0]?.resolve();
    await first;
    await flush();
    expect(calls).toBe(2);
    gates[1]?.resolve();
    await second;
    expect(maxActive).toBe(1);
  });

  it('coalesces calls made while one is already waiting', async () => {
    const gate = deferred();
    let calls = 0;
    const run = serializeTicks(async () => {
      calls += 1;
      if (calls === 1) await gate.promise;
      return calls;
    });
    const first = run();
    const second = run();
    const third = run();
    expect(second).toBe(third);
    gate.resolve();
    await Promise.all([first, second, third]);
    expect(calls).toBe(2);
  });

  it('a rejected tick never blocks the next one', async () => {
    let calls = 0;
    const run = serializeTicks(() => {
      calls += 1;
      return calls === 1 ? Promise.reject(new Error('boom')) : Promise.resolve(calls);
    });
    await expect(run()).rejects.toThrow('boom');
    await expect(run()).resolves.toBe(2);
  });
});

describe('startReconcileLoop (A1, H1)', () => {
  function fakes() {
    const schedulers: unknown[][] = [];
    const queueClose = vi.fn(() => Promise.resolve());
    const workerClose = vi.fn(() => Promise.resolve());
    const queue: ReconcileQueueLike = {
      upsertJobScheduler: vi.fn((...args: unknown[]) => {
        schedulers.push(args);
        return Promise.resolve({});
      }),
      close: queueClose,
    };
    let processor: ((job: { name?: string }) => Promise<unknown>) | undefined;
    let options: Record<string, unknown> | undefined;
    const listeners = new Map<string, (...args: unknown[]) => void>();
    const worker: ReconcileWorkerLike = {
      on: vi.fn((event: string, listener: (...args: unknown[]) => void) => {
        listeners.set(event, listener);
        return worker;
      }),
      close: workerClose,
    };
    return {
      queue,
      worker,
      queueClose,
      workerClose,
      schedulers,
      listeners,
      processor: () => {
        if (processor === undefined) throw new Error('no processor');
        return processor;
      },
      options: () => options,
      createWorker: vi.fn((name: string, p: (job: { name?: string }) => Promise<unknown>, opts: Record<string, unknown>) => {
        expect(name).toBe(RECONCILE_QUEUE_NAME);
        processor = p;
        options = opts;
        return worker;
      }),
      createQueue: vi.fn((name: string) => {
        expect(name).toBe(RECONCILE_QUEUE_NAME);
        return queue;
      }),
    };
  }

  it('schedules one repeatable job every intervalMs and processes it with concurrency 1', async () => {
    const f = fakes();
    const tick = vi.fn(() => Promise.resolve({ servers: 0 }));
    const { logger } = silentLogger();
    const handle = await startReconcileLoop({
      intervalMs: 30_000,
      tick,
      queueConnection: {},
      workerConnection: {},
      logger,
      createQueue: f.createQueue,
      createWorker: f.createWorker,
    });
    expect(f.schedulers).toHaveLength(1);
    const [id, repeat, template] = f.schedulers[0] ?? [];
    expect(id).toBe(RECONCILE_SCHEDULER_ID);
    expect(repeat).toEqual({ every: 30_000 });
    expect(template).toMatchObject({ name: RECONCILE_JOB_NAME });
    expect(f.options()).toMatchObject({ concurrency: 1 });

    await f.processor()({ name: RECONCILE_JOB_NAME });
    expect(tick).toHaveBeenCalledTimes(1);
    expect(f.listeners.has('error')).toBe(true);

    await handle.close();
    expect(f.workerClose).toHaveBeenCalled();
    expect(f.queueClose).toHaveBeenCalled();
  });

  it('two jobs delivered at once never run the tick concurrently', async () => {
    const f = fakes();
    let active = 0;
    let maxActive = 0;
    const gate = deferred();
    const tick = vi.fn(async () => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      await gate.promise;
      active -= 1;
      return {};
    });
    const { logger } = silentLogger();
    await startReconcileLoop({
      intervalMs: 5_000,
      tick,
      queueConnection: {},
      workerConnection: {},
      logger,
      createQueue: f.createQueue,
      createWorker: f.createWorker,
    });
    const a = f.processor()({ name: RECONCILE_JOB_NAME });
    const b = f.processor()({ name: RECONCILE_JOB_NAME });
    await flush();
    gate.resolve();
    await Promise.all([a, b]);
    expect(maxActive).toBe(1);
  });

  it('a throwing tick is logged by kind only and never fails the job', async () => {
    const f = fakes();
    const { logger, logs } = silentLogger();
    await startReconcileLoop({
      intervalMs: 5_000,
      tick: () => Promise.reject(new Error('redis://:secret@host')),
      queueConnection: {},
      workerConnection: {},
      logger,
      createQueue: f.createQueue,
      createWorker: f.createWorker,
    });
    await expect(f.processor()({ name: RECONCILE_JOB_NAME })).resolves.toBeDefined();
    expect(JSON.stringify(logs)).not.toContain('secret');
    expect(logs.some((l) => l.level === 'error')).toBe(true);
  });
});
