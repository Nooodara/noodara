// 14-08 (A1, H2): the worker's reconcile wiring runs the stale-QUEUED sweep once at startup and
// before every reconcile tick, through the deploy queue's job lookup.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Database } from '../db/client.js';

const mocks = vi.hoisted(() => ({
  getJob: vi.fn<(jobId: string) => Promise<{ getState(): Promise<string> } | undefined>>(),
  staleQueued: vi.fn<(cutoff: Date, limit: number) => Promise<{ deploymentId: string; serviceId: string; createdAt: Date }[]>>(),
  failStaleQueued: vi.fn<(id: string, cutoff: Date) => Promise<unknown>>(),
  listServers: vi.fn<() => Promise<string[]>>(),
  loopTick: { current: null as null | (() => Promise<unknown>) },
  order: [] as string[],
}));

vi.mock('bullmq', () => ({
  Queue: class {
    getJob = mocks.getJob;
    close = () => Promise.resolve();
  },
}));

vi.mock('../deploy/deployment-store.js', () => ({
  createDeploymentStore: () => ({ staleQueued: mocks.staleQueued, failStaleQueued: mocks.failStaleQueued }),
}));

vi.mock('./reconcile-store.js', () => ({
  createOperationInFlight: () => () => Promise.resolve(false),
  listReconcileServers: () => {
    mocks.order.push('reconcile');
    return mocks.listServers();
  },
  loadReconcileServices: () => Promise.resolve([]),
  recordReconcileDiscrepancy: () => Promise.resolve(),
  writeReconcileStatus: () => Promise.resolve(),
}));

vi.mock('./reconcile-runtime.js', () => ({
  startReconcileLoop: (options: { tick: () => Promise<unknown> }) => {
    mocks.order.push('loop');
    mocks.loopTick.current = options.tick;
    return Promise.resolve({ close: () => Promise.resolve() });
  },
}));

const { createWorkerReconcileTick, startWorkerReconcile } = await import('./reconcile-wiring.js');

const NOW = new Date('2026-10-07T12:00:00.000Z');
const DEPLOYMENT_ID = '0192f1a4-7b3c-7d2e-8f00-00000000cccc';
const SERVICE_ID = '0192f1a4-7b3c-7d2e-8f00-00000000bbbb';
const THRESHOLD = 120_000;

function deps(overrides: Record<string, unknown> = {}) {
  return {
    db: {} as Database,
    connect: vi.fn(),
    createRedactor: vi.fn(),
    events: { publish: () => Promise.resolve() },
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    commandMs: 5_000,
    intervalMs: 30_000,
    queueConnection: {},
    workerConnection: {},
    now: () => NOW,
    staleQueued: { thresholdMs: THRESHOLD },
    ...overrides,
  } as Parameters<typeof startWorkerReconcile>[0];
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.order.length = 0;
  mocks.loopTick.current = null;
  mocks.staleQueued.mockImplementation(() => {
    mocks.order.push('stale');
    return Promise.resolve([{ deploymentId: DEPLOYMENT_ID, serviceId: SERVICE_ID, createdAt: new Date(NOW.getTime() - THRESHOLD - 1) }]);
  });
  mocks.failStaleQueued.mockResolvedValue({ id: DEPLOYMENT_ID, status: 'FAILED' });
  mocks.getJob.mockResolvedValue(undefined);
  mocks.listServers.mockResolvedValue([]);
});

describe('worker reconcile wiring: stale QUEUED sweep (14-08)', () => {
  it('sweeps once at startup, before the reconcile loop starts (A1)', async () => {
    const handle = await startWorkerReconcile(deps());

    expect(mocks.order).toEqual(['stale', 'loop']);
    expect(mocks.getJob).toHaveBeenCalledWith(`deploy-${DEPLOYMENT_ID}`);
    expect(mocks.failStaleQueued).toHaveBeenCalledWith(DEPLOYMENT_ID, new Date(NOW.getTime() - THRESHOLD));
    await handle.close();
  });

  it('sweeps on every repeatable tick before reconciling and reports the count (A1)', async () => {
    await startWorkerReconcile(deps());
    mocks.order.length = 0;

    const summary = await mocks.loopTick.current?.();

    expect(mocks.order).toEqual(['stale', 'reconcile']);
    expect(summary).toMatchObject({ staleQueuedFailed: 1, servers: 0 });
  });

  it('a Redis error on the job lookup never fails the deployment (H2)', async () => {
    mocks.getJob.mockRejectedValue(new Error('connect ECONNREFUSED 127.0.0.1:6379'));
    const reconcile = createWorkerReconcileTick(deps());

    expect(await reconcile.sweepStaleQueued()).toEqual({ failed: [], unknown: 1 });
    expect(mocks.failStaleQueued).not.toHaveBeenCalled();
  });

  it('a live job keeps the deployment QUEUED (A2)', async () => {
    mocks.getJob.mockResolvedValue({ getState: () => Promise.resolve('waiting') });
    const reconcile = createWorkerReconcileTick(deps());

    expect((await reconcile.tick()).staleQueuedFailed).toBe(0);
    expect(mocks.failStaleQueued).not.toHaveBeenCalled();
  });

  it('a failing reconcile tick still ran the sweep first', async () => {
    mocks.listServers.mockRejectedValue(new Error('db down'));
    const reconcile = createWorkerReconcileTick(deps());

    await expect(reconcile.tick()).rejects.toThrow('db down');
    expect(mocks.failStaleQueued).toHaveBeenCalledTimes(1);
  });

  it('without a threshold no stale sweep runs', async () => {
    const reconcile = createWorkerReconcileTick(deps({ staleQueued: undefined }));

    expect(await reconcile.sweepStaleQueued()).toEqual({ failed: [], unknown: 0 });
    expect(mocks.staleQueued).not.toHaveBeenCalled();
  });
});
