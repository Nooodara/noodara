// 27-02 (A1, H1): the repeatable metrics job; the processor never throws.
import { describe, expect, it, vi } from 'vitest';
import {
  collectorDeadlineMs,
  METRICS_JOB_NAME,
  METRICS_QUEUE_NAME,
  METRICS_SCHEDULER_ID,
  startCollectorLoop,
  type MetricsQueueLike,
  type MetricsWorkerLike,
} from './collector-runtime.js';

function silentLogger() {
  const logs: { level: string; fields: Record<string, unknown>; message: string }[] = [];
  const push = (level: string) => (fields: Record<string, unknown>, message: string) => logs.push({ level, fields, message });
  return { logs, logger: { info: push('info'), warn: push('warn'), error: push('error') } };
}

type Processor = (job: { readonly name?: string }) => Promise<unknown>;

function fakes() {
  const upsertJobScheduler = vi.fn(() => Promise.resolve());
  const queueClose = vi.fn(() => Promise.resolve());
  const workerClose = vi.fn(() => Promise.resolve());
  const queue: MetricsQueueLike = { upsertJobScheduler, close: queueClose };
  const listeners: ((error: Error) => void)[] = [];
  let processor: Processor = () => Promise.resolve();
  let workerOpts: unknown;
  const worker: MetricsWorkerLike = {
    on: (_event, listener) => listeners.push(listener),
    close: workerClose,
  };
  return {
    upsertJobScheduler,
    queueClose,
    workerClose,
    listeners,
    process: (job: { readonly name?: string }) => processor(job),
    opts: () => workerOpts,
    createQueue: (name: string) => {
      expect(name).toBe(METRICS_QUEUE_NAME);
      return queue;
    },
    createWorker: (name: string, p: Processor, opts: unknown) => {
      expect(name).toBe(METRICS_QUEUE_NAME);
      processor = p;
      workerOpts = opts;
      return worker;
    },
  };
}

describe('startCollectorLoop (27-02)', () => {
  it('upserts one scheduler every interval and runs the worker with concurrency 1', async () => {
    const f = fakes();
    const { logger } = silentLogger();
    const handle = await startCollectorLoop({
      intervalMs: 60_000,
      tick: () => Promise.resolve('summary'),
      queueConnection: {},
      workerConnection: {},
      logger,
      createQueue: f.createQueue,
      createWorker: f.createWorker,
    });
    expect(f.upsertJobScheduler).toHaveBeenCalledWith(
      METRICS_SCHEDULER_ID,
      { every: 60_000 },
      { name: METRICS_JOB_NAME, opts: { removeOnComplete: true, removeOnFail: true } },
    );
    expect(f.opts()).toMatchObject({ concurrency: 1 });
    expect(await f.process({ name: METRICS_JOB_NAME })).toEqual({ summary: 'summary' });
    await handle.close();
    expect(f.workerClose).toHaveBeenCalled();
    expect(f.queueClose).toHaveBeenCalled();
  });

  it('a failing tick is logged by error kind and never throws; worker errors are handled', async () => {
    const f = fakes();
    const { logs, logger } = silentLogger();
    await startCollectorLoop({
      intervalMs: 60_000,
      tick: () => Promise.reject(new TypeError('postgres://user:secret@db')),
      queueConnection: {},
      workerConnection: {},
      logger,
      createQueue: f.createQueue,
      createWorker: f.createWorker,
    });
    expect(await f.process({})).toEqual({ summary: null });
    expect(f.listeners).toHaveLength(1);
    f.listeners[0]?.(new RangeError('redis secret'));
    expect(logs.map((l) => l.fields)).toEqual([{ errorKind: 'TypeError' }, { errorKind: 'RangeError' }]);
    expect(JSON.stringify(logs)).not.toContain('secret');
  });
});

describe('collectorDeadlineMs', () => {
  it('stays under the interval and never below 20 s', () => {
    expect(collectorDeadlineMs(60_000)).toBe(55_000);
    expect(collectorDeadlineMs(300_000)).toBe(295_000);
    expect(collectorDeadlineMs(21_000)).toBe(20_000);
  });
});
