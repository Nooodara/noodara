import { describe, expect, it, vi, type Mock } from 'vitest';
import type { PostStartPollPolicy } from '@noodara/domain/deployment';
import { createRedactor } from '@noodara/domain/security';
import { createDeployJobHandler, deployWorkerOptions, type DeployJobDeps } from '../deploy/deploy-worker.js';
import type { FinishDeploymentInput, InFlightDeployment } from '../deploy/deployment-store.js';
import type { RunDeploymentInput } from '../deploy/run-deployment.js';
import type { DeploymentRow, DeploymentView } from '../services/deployment-services.js';
import {
  computeDeployJobLockDurationMs,
  DEPLOY_MAX_MS_DEFAULT,
  DEPLOY_MAX_MS_RANGE,
} from './deploy-job-budget.js';
import type { DeployServiceJobPayload } from './deploy-job-payload.js';
import {
  createDeployQueue,
  DEPLOY_QUEUE_NAME,
  DEPLOY_SERVICE_JOB_NAME,
  jobIdForDeployment,
  type DeployBullQueue,
} from './deploy-queue.js';

const SERVER_ID = '0192f1a4-7b3c-7d2e-8f00-000000000003';
const OTHER_DEPLOYMENT_ID = '0192f1a4-7b3c-7d2e-8f00-000000000004';

const PAYLOAD: DeployServiceJobPayload = {
  deploymentId: '0192f1a4-7b3c-7d2e-8f00-000000000001',
  serviceId: '0192f1a4-7b3c-7d2e-8f00-000000000002',
  actor: { type: 'system' },
  requestedAt: '2026-10-04T12:00:00.000Z',
};

interface FakeQueue {
  add: Mock<DeployBullQueue['add']>;
  getJob: Mock<DeployBullQueue['getJob']>;
  close: Mock<DeployBullQueue['close']>;
}

/** Mocks as properties (not methods), so asserting on them never unbinds a method. */
function fakeQueue(overrides: Partial<Record<keyof FakeQueue, ReturnType<typeof vi.fn>>> = {}): FakeQueue {
  return {
    add: vi.fn((_name: string, _data: unknown, opts: { jobId: string }) => Promise.resolve({ id: opts.jobId })),
    getJob: vi.fn(() => Promise.resolve(undefined)),
    close: vi.fn(() => Promise.resolve()),
    ...overrides,
  } as FakeQueue;
}

describe('deploy queue naming', () => {
  it('uses a deterministic per-deployment jobId with no colon (BullMQ rejects one colon)', () => {
    expect(jobIdForDeployment(PAYLOAD.deploymentId)).toBe(`deploy-${PAYLOAD.deploymentId}`);
    expect(jobIdForDeployment(PAYLOAD.deploymentId)).not.toContain(':');
  });

  it('names its own queue and job, separate from the connect-server queue', () => {
    expect(DEPLOY_QUEUE_NAME).toBe('deployments');
    expect(DEPLOY_SERVICE_JOB_NAME).toBe('deploy-service');
  });
});

describe('createDeployQueue.enqueue', () => {
  it('adds one deploy-service job with jobId deploy-<deploymentId>, single attempt and bounded retention', async () => {
    const queue = fakeQueue();
    const deployQueue = createDeployQueue({ queue });

    const result = await deployQueue.enqueue(PAYLOAD);

    expect(result).toEqual({ ok: true, jobId: `deploy-${PAYLOAD.deploymentId}` });
    expect(queue.add).toHaveBeenCalledTimes(1);
    const [name, data, opts] = queue.add.mock.calls[0] ?? [];
    expect(name).toBe('deploy-service');
    expect(data).toEqual(PAYLOAD);
    expect(opts).toMatchObject({ jobId: `deploy-${PAYLOAD.deploymentId}`, attempts: 1 });
    expect(opts?.removeOnComplete).toBeDefined();
    expect(opts?.removeOnFail).toBeDefined();
  });

  it('refuses a payload that is not ids-only, before touching Redis', async () => {
    const queue = fakeQueue();
    const deployQueue = createDeployQueue({ queue });

    const result = await deployQueue.enqueue({ ...PAYLOAD, token: 'secret' } as unknown as DeployServiceJobPayload);

    expect(result.ok).toBe(false);
    expect(queue.add).not.toHaveBeenCalled();
  });

  it('returns a fixed QUEUE_UNAVAILABLE (never the Redis error text) when add rejects', async () => {
    const queue = fakeQueue({
      add: vi.fn(() => Promise.reject(new Error('connect ECONNREFUSED redis://:pw@10.0.0.9:6379'))),
    });
    const result = await createDeployQueue({ queue }).enqueue(PAYLOAD);

    expect(result).toEqual({ ok: false, code: 'QUEUE_UNAVAILABLE', message: 'Job queue is unavailable' });
  });

  it('bounds a hung add with its own timeout', async () => {
    vi.useFakeTimers();
    try {
      const queue = fakeQueue({ add: vi.fn(() => new Promise<never>(() => undefined)) });
      const pending = createDeployQueue({ queue, enqueueTimeoutMs: 50 }).enqueue(PAYLOAD);
      await vi.advanceTimersByTimeAsync(60);
      await expect(pending).resolves.toMatchObject({ ok: false, code: 'QUEUE_UNAVAILABLE' });
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('createDeployQueue.removeJob / isJobPending', () => {
  it('removes a waiting job and reports it', async () => {
    const remove = vi.fn(() => Promise.resolve());
    const queue = fakeQueue({
      getJob: vi.fn(() => Promise.resolve({ remove, getState: () => Promise.resolve('waiting') })),
    });
    const deployQueue = createDeployQueue({ queue });

    await expect(deployQueue.removeJob(PAYLOAD.deploymentId)).resolves.toBe(true);
    expect(queue.getJob).toHaveBeenCalledWith(`deploy-${PAYLOAD.deploymentId}`);
    expect(remove).toHaveBeenCalledTimes(1);
  });

  it('never removes an active job (the worker owns it)', async () => {
    const remove = vi.fn(() => Promise.resolve());
    const queue = fakeQueue({
      getJob: vi.fn(() => Promise.resolve({ remove, getState: () => Promise.resolve('active') })),
    });
    await expect(createDeployQueue({ queue }).removeJob(PAYLOAD.deploymentId)).resolves.toBe(false);
    expect(remove).not.toHaveBeenCalled();
  });

  it('reports false when no job exists or Redis fails, never throwing', async () => {
    await expect(createDeployQueue({ queue: fakeQueue() }).removeJob(PAYLOAD.deploymentId)).resolves.toBe(false);
    const broken = fakeQueue({ getJob: vi.fn(() => Promise.reject(new Error('down'))) });
    await expect(createDeployQueue({ queue: broken }).removeJob(PAYLOAD.deploymentId)).resolves.toBe(false);
    await expect(createDeployQueue({ queue: broken }).isJobPending(PAYLOAD.deploymentId)).resolves.toBe(false);
  });

  it('treats waiting, active and delayed as pending', async () => {
    for (const [state, pending] of [
      ['waiting', true],
      ['active', true],
      ['delayed', true],
      ['completed', false],
      ['failed', false],
    ] as const) {
      const queue = fakeQueue({
        getJob: vi.fn(() => Promise.resolve({ remove: vi.fn(), getState: () => Promise.resolve(state) })),
      });
      await expect(createDeployQueue({ queue }).isJobPending(PAYLOAD.deploymentId)).resolves.toBe(pending);
    }
  });

  it('close() closes only the queue it was given', async () => {
    const queue = fakeQueue();
    await createDeployQueue({ queue }).close();
    expect(queue.close).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------------------------
// 18-05: worker retry contract (ADR 0010 A3) and BullMQ settings derived from deployMaxMs (D15)
// ---------------------------------------------------------------------------------------------

describe('deploy worker settings (18-05 A4, D15)', () => {
  it.each([DEPLOY_MAX_MS_RANGE.min, DEPLOY_MAX_MS_DEFAULT, DEPLOY_MAX_MS_RANGE.max])(
    'derives the lock from NOODARA_DEPLOY_MAX_MS=%i and never lets a stalled job run twice',
    (deployMaxMs) => {
      const options = deployWorkerOptions({ deployMaxMs, concurrency: 2 });
      expect(options.lockDuration).toBe(computeDeployJobLockDurationMs(deployMaxMs));
      expect(options.lockDuration).toBeGreaterThan(deployMaxMs);
      expect(options.maxStalledCount).toBe(0);
      expect(options.concurrency).toBe(2);
    },
  );

  it('a longer deploy budget yields a longer lock', () => {
    expect(deployWorkerOptions({ deployMaxMs: 600_000, concurrency: 1 }).lockDuration).toBeLessThan(
      deployWorkerOptions({ deployMaxMs: 1_200_000, concurrency: 1 }).lockDuration,
    );
  });

  it('enqueues with a single attempt (no automatic re-enqueue)', async () => {
    const bull = fakeQueue();
    await createDeployQueue({ queue: bull as unknown as DeployBullQueue }).enqueue(PAYLOAD);
    expect(bull.add.mock.calls[0]?.[2]).toMatchObject({ attempts: 1 });
  });
});

describe('re-delivered deploy job (18-05 A2, H2, ADR 0010 A3)', () => {
  function worker(inFlight: InFlightDeployment[], claim: () => Promise<DeploymentRow | null> = () => Promise.resolve(null)) {
    const finished: { id: string; input: FinishDeploymentInput }[] = [];
    const connect = vi.fn(() => Promise.resolve({ ok: false as const, code: 'SERVER_UNREACHABLE' as const }));
    const run = vi.fn(() => Promise.reject(new Error('a step must never re-run')));
    const loadTarget = vi.fn(() => Promise.reject(new Error('never loaded')));
    const deps: DeployJobDeps = {
      store: {
        claim: vi.fn(claim),
        progress: () => ({ advance: () => Promise.resolve(), recordCommitSha: () => Promise.resolve() }),
        finish: vi.fn((id: string, input: FinishDeploymentInput) => {
          finished.push({ id, input });
          return Promise.resolve({ id } as unknown as DeploymentView);
        }),
        inFlight: vi.fn(() => Promise.resolve(inFlight)),
        sweepRuntime: vi.fn(() => Promise.resolve({ kind: 'left' as const })),
      },
      loadTarget,
      connect,
      run,
      createRedactor,
      sinkFor: () => ({ write: vi.fn(), close: () => Promise.resolve() }),
      limits: {} as RunDeploymentInput['limits'],
      pollPolicy: {} as PostStartPollPolicy,
      clock: { now: () => 0, sleep: () => Promise.resolve() },
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    };
    return { deps, handle: createDeployJobHandler(deps), finished, connect, run, loadTarget };
  }

  it('exits on a terminal row without any remote command', async () => {
    const w = worker([]);
    await expect(w.handle(PAYLOAD)).resolves.toEqual({ outcome: 'ALREADY_CLAIMED' });
    expect(w.connect).toHaveBeenCalledTimes(0);
    expect(w.run).toHaveBeenCalledTimes(0);
    expect(w.finished).toEqual([]);
  });

  it.each(['PREPARING', 'BUILDING', 'DEPLOYING'] as const)(
    'recovers a %s row left by a crashed worker: ends it WORKER_CRASHED and never re-runs a step',
    async (status) => {
      const w = worker([
        { deploymentId: PAYLOAD.deploymentId, serviceId: PAYLOAD.serviceId, serverId: SERVER_ID, status },
        { deploymentId: OTHER_DEPLOYMENT_ID, serviceId: PAYLOAD.serviceId, serverId: SERVER_ID, status: 'BUILDING' },
      ]);

      await expect(w.handle(PAYLOAD)).resolves.toEqual({ outcome: 'CRASH_RECOVERED' });

      expect(w.finished.map((call) => call.id)).toEqual([PAYLOAD.deploymentId]);
      expect(w.finished[0]?.input).toMatchObject({ status: 'FAILED', errorCode: 'WORKER_CRASHED' });
      expect(w.run).toHaveBeenCalledTimes(0);
      expect(w.loadTarget).toHaveBeenCalledTimes(0);
      // Only the cleanup connection (no `docker create`/`start`: no second noodara-<serviceId>).
      expect(w.connect).toHaveBeenCalledTimes(1);
    },
  );

  it('leaves alone a row this process is still running (duplicate delivery)', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const claims = [{ id: PAYLOAD.deploymentId, serviceId: PAYLOAD.serviceId, status: 'PREPARING' } as unknown as DeploymentRow, null];
    const w = worker(
      [{ deploymentId: PAYLOAD.deploymentId, serviceId: PAYLOAD.serviceId, serverId: SERVER_ID, status: 'PREPARING' }],
      () => Promise.resolve(claims.shift() ?? null),
    );
    w.loadTarget.mockImplementationOnce(() => gate.then(() => ({ ok: false as const, code: 'SERVER_UNREACHABLE' as const })) as never);

    const first = w.handle(PAYLOAD);
    await expect(w.handle(PAYLOAD)).resolves.toEqual({ outcome: 'ALREADY_CLAIMED' });
    expect(w.deps.store.inFlight).not.toHaveBeenCalled();
    release();
    await expect(first).resolves.toEqual({ outcome: 'FAILED' });
  });
});
