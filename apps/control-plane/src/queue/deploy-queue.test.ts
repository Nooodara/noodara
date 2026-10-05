import { describe, expect, it, vi, type Mock } from 'vitest';
import type { DeployServiceJobPayload } from './deploy-job-payload.js';
import {
  createDeployQueue,
  DEPLOY_QUEUE_NAME,
  DEPLOY_SERVICE_JOB_NAME,
  jobIdForDeployment,
  type DeployBullQueue,
} from './deploy-queue.js';

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
