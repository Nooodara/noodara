// 14-08 (A1, H2): the worker's reconcile wiring runs the stale-QUEUED sweep once at startup and
// before every reconcile tick, through the deploy queue's job lookup.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Database } from '../db/client.js';

const mocks = vi.hoisted(() => ({
  getJob: vi.fn<(jobId: string) => Promise<{ getState(): Promise<string> } | undefined>>(),
  staleQueued: vi.fn<(cutoff: Date, limit: number) => Promise<{ deploymentId: string; serviceId: string; createdAt: Date }[]>>(),
  failStaleQueued: vi.fn<(id: string, cutoff: Date) => Promise<unknown>>(),
  listServers: vi.fn<() => Promise<string[]>>(),
  pendingDomainServices: vi.fn<(db: unknown, limit: number) => Promise<string[]>>(),
  orphanRouteServices: vi.fn<(db: unknown, limit: number) => Promise<string[]>>(),
  recordRouteCleanup: vi.fn<(db: unknown, input: unknown) => Promise<void>>(),
  loopTick: { current: null as null | (() => Promise<unknown>) },
  order: [] as string[],
  certDeps: vi.fn<(deps: Record<string, unknown>) => void>(),
  certLoop: vi.fn<(input: { pollMs: number; reconciler: unknown }) => void>(),
  certClose: vi.fn<() => Promise<void>>(),
}));

vi.mock('../domains/cert-reconciler.js', () => ({
  createCertStore: () => ({}),
  createCertReconciler: (deps: Record<string, unknown>) => {
    mocks.certDeps(deps);
    return { runDue: () => Promise.resolve() };
  },
  startCertReconcileLoop: (input: { pollMs: number; reconciler: unknown }) => {
    mocks.order.push('cert-loop');
    mocks.certLoop(input);
    return {
      close: () => {
        mocks.order.push('cert-close');
        return mocks.certClose();
      },
    };
  },
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

vi.mock('../domains/domain-store.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../domains/domain-store.js')>()),
  listPendingDomainServices: (db: unknown, limit: number) => {
    mocks.order.push('domains');
    return mocks.pendingDomainServices(db, limit);
  },
  listOrphanRouteServices: (db: unknown, limit: number) => {
    mocks.order.push('orphans');
    return mocks.orphanRouteServices(db, limit);
  },
  recordRouteCleanup: (db: unknown, input: unknown) => mocks.recordRouteCleanup(db, input),
}));

vi.mock('./reconcile-runtime.js', () => ({
  startReconcileLoop: (options: { tick: () => Promise<unknown> }) => {
    mocks.order.push('loop');
    mocks.loopTick.current = options.tick;
    return Promise.resolve({
      close: () => {
        mocks.order.push('loop-close');
        return Promise.resolve();
      },
    });
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
  mocks.pendingDomainServices.mockResolvedValue([]);
  mocks.orphanRouteServices.mockResolvedValue([]);
  mocks.recordRouteCleanup.mockResolvedValue(undefined);
  mocks.certClose.mockResolvedValue(undefined);
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

    expect(mocks.order).toEqual(['stale', 'reconcile', 'domains', 'orphans']);
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

describe('worker reconcile wiring: pending domain routes (22-03 H3)', () => {
  const OTHER = '0192f1a4-7b3c-7d2e-8f00-00000000dddd';

  it('re-applies each PENDING service after the tick and reports the counts', async () => {
    mocks.pendingDomainServices.mockResolvedValue([SERVICE_ID, OTHER]);
    const domainApply = vi.fn((serviceId: string) =>
      Promise.resolve(serviceId === SERVICE_ID ? { ok: true as const } : { ok: false as const, code: 'SERVER_UNREACHABLE' as const }),
    );
    const warn = vi.fn();
    const d = deps({ domainApply, logger: { info: vi.fn(), warn, error: vi.fn() } });
    const summary = await createWorkerReconcileTick(d).tick();

    expect(mocks.order).toEqual(['stale', 'reconcile', 'domains', 'orphans']);
    expect(mocks.pendingDomainServices).toHaveBeenCalledWith(d.db, 50);
    expect(domainApply.mock.calls.map((call) => call[0])).toEqual([SERVICE_ID, OTHER]);
    expect(summary).toMatchObject({ domainsReapplied: 1, domainsReapplyFailed: 1 });
    expect(warn).toHaveBeenCalledWith({ serviceId: OTHER, code: 'SERVER_UNREACHABLE' }, 'domain route re-apply failed');
  });

  it('a throwing apply or a failing lookup never fails the tick', async () => {
    mocks.pendingDomainServices.mockResolvedValueOnce([SERVICE_ID]);
    const domainApply = vi.fn(() => Promise.reject(new Error('boom')));
    const reconcile = createWorkerReconcileTick(deps({ domainApply }));

    expect(await reconcile.tick()).toMatchObject({ domainsReapplied: 0, domainsReapplyFailed: 1 });
    mocks.pendingDomainServices.mockRejectedValueOnce(new Error('db down'));
    expect(await reconcile.tick()).toMatchObject({ domainsReapplied: 0, domainsReapplyFailed: 0 });
  });
});

describe('worker reconcile wiring: orphan route files (22-08 A1)', () => {
  const OTHER = '0192f1a4-7b3c-7d2e-8f00-00000000dddd';

  it('removes each orphan route through the shared applier after the re-apply and clears its mark', async () => {
    mocks.orphanRouteServices.mockResolvedValue([SERVICE_ID, OTHER]);
    const domainApply = vi.fn((serviceId: string) =>
      Promise.resolve(serviceId === SERVICE_ID ? { ok: true as const } : { ok: false as const, code: 'SERVER_UNREACHABLE' as const }),
    );
    const warn = vi.fn();
    const d = deps({ domainApply, logger: { info: vi.fn(), warn, error: vi.fn() } });
    const summary = await createWorkerReconcileTick(d).tick();

    expect(mocks.order).toEqual(['stale', 'reconcile', 'domains', 'orphans']);
    expect(mocks.orphanRouteServices).toHaveBeenCalledWith(d.db, 50);
    expect(domainApply.mock.calls.map((call) => call[0])).toEqual([SERVICE_ID, OTHER]);
    expect(summary).toMatchObject({ orphanRoutesRemoved: 1, orphanRoutesFailed: 1 });
    // Only the removed one is cleared; the failing one stays marked for the next tick.
    expect(mocks.recordRouteCleanup).toHaveBeenCalledTimes(1);
    expect(mocks.recordRouteCleanup).toHaveBeenCalledWith(d.db, {
      actor: { type: 'system' },
      serviceId: SERVICE_ID,
      outcome: 'success',
      at: NOW,
    });
    expect(warn).toHaveBeenCalledWith({ serviceId: OTHER, code: 'SERVER_UNREACHABLE' }, 'orphan route cleanup failed');
  });

  it('a throwing apply or a failing lookup never fails the tick', async () => {
    mocks.orphanRouteServices.mockResolvedValueOnce([SERVICE_ID]);
    const domainApply = vi.fn(() => Promise.reject(new Error('boom')));
    const reconcile = createWorkerReconcileTick(deps({ domainApply }));

    expect(await reconcile.tick()).toMatchObject({ orphanRoutesRemoved: 0, orphanRoutesFailed: 1 });
    mocks.orphanRouteServices.mockRejectedValueOnce(new Error('db down'));
    expect(await reconcile.tick()).toMatchObject({ orphanRoutesRemoved: 0, orphanRoutesFailed: 0 });
    expect(mocks.recordRouteCleanup).not.toHaveBeenCalled();
  });
});

describe('worker reconcile wiring: certificate checks (22-04 A1, A2)', () => {
  it('starts the certificate loop after the reconcile loop with the configured timings and the shared applier', async () => {
    const domainApply = vi.fn(() => Promise.resolve({ ok: true as const }));
    const d = deps({ domainApply, cert: { intervalMs: 600_000, issueTimeoutMs: 900_000 } });
    const handle = await startWorkerReconcile(d);

    expect(mocks.order).toEqual(['stale', 'loop', 'cert-loop']);
    expect(mocks.certDeps).toHaveBeenCalledWith(
      expect.objectContaining({ intervalMs: 600_000, issueTimeoutMs: 900_000, commandMs: 5_000, apply: domainApply, connect: d.connect }),
    );
    expect(mocks.certLoop).toHaveBeenCalledWith(expect.objectContaining({ pollMs: 5_000 }));

    mocks.order.length = 0;
    await handle.close();
    expect(mocks.order).toEqual(['cert-close', 'loop-close']);
  });

  it('polls no slower than a short interval and passes the backoff seam through', async () => {
    const checkDelayMs = () => 100;
    await startWorkerReconcile(deps({ cert: { intervalMs: 1_000, issueTimeoutMs: 2_000, checkDelayMs } }));

    expect(mocks.certLoop).toHaveBeenCalledWith(expect.objectContaining({ pollMs: 1_000 }));
    expect(mocks.certDeps).toHaveBeenCalledWith(expect.objectContaining({ checkDelayMs }));
  });

  it('without a cert config no certificate loop starts', async () => {
    const handle = await startWorkerReconcile(deps());

    expect(mocks.certLoop).not.toHaveBeenCalled();
    await handle.close();
    expect(mocks.order).not.toContain('cert-close');
  });
});
