// 12-14: the `service-operation` job: producer (dedup per service) and worker-side handler.
import { createRedactor } from '@noodara/domain/security';
import type { SshDeploySession } from '@noodara/ssh';
import { describe, expect, it, vi } from 'vitest';
import type { ServerEvent } from '../events/server-event-publisher.js';
import type { ServiceView } from '../services/service-view.js';
import { DEFAULT_SERVICE_OPS_LIMITS, SERVICE_OPS_MESSAGES, type ServiceOperationResult } from './service-ops.js';
import {
  createServiceOperationJobHandler,
  createServiceOperationQueue,
  jobIdForServiceOperation,
  parseServiceOperationJobPayload,
  SERVICE_OPERATION_JOB_NAME,
  type ServiceOperationBullQueue,
  type ServiceOperationJobDeps,
} from './service-ops-job.js';

const SERVICE_ID = '7c9e6679-7425-40de-944b-e07fc1f90ae7';
const SERVER_ID = '5d6e7f80-1a2b-4c3d-8e4f-5a6b7c8d9e0f';
const USER_ID = '0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d';
const payload = { serviceId: SERVICE_ID, operation: 'stop', actorId: USER_ID } as const;

describe('parseServiceOperationJobPayload', () => {
  it('accepts an ids-only payload, with a null actor for system jobs', () => {
    expect(parseServiceOperationJobPayload(payload)).toEqual({ ok: true, payload });
    expect(parseServiceOperationJobPayload({ ...payload, actorId: null })).toMatchObject({ ok: true });
  });

  it.each([
    ['an extra field', { ...payload, host: '10.0.0.1' }],
    ['an unknown operation', { ...payload, operation: 'exec' }],
    ['a non-uuid service', { ...payload, serviceId: '../x' }],
    ['a missing actor', { serviceId: SERVICE_ID, operation: 'stop' }],
  ])('rejects %s without echoing the value', (_label, data) => {
    const parsed = parseServiceOperationJobPayload(data);
    expect(parsed.ok).toBe(false);
    expect(JSON.stringify(parsed)).not.toContain('10.0.0.1');
  });
});

function fakeQueue(existingState: string | null = null) {
  const removed = vi.fn(() => Promise.resolve());
  const queue = {
    add: vi.fn((_name: string, _data: unknown, opts: { jobId: string }) => Promise.resolve({ id: opts.jobId })),
    getJob: vi.fn(() =>
      Promise.resolve(existingState === null ? undefined : { getState: () => Promise.resolve(existingState), remove: removed }),
    ),
    close: vi.fn(() => Promise.resolve()),
  };
  const bull: ServiceOperationBullQueue = queue;
  return { queue: bull, add: queue.add, getJob: queue.getJob, removed };
}

describe('createServiceOperationQueue', () => {
  it('enqueues one job per service, never retried, removed once done', async () => {
    const { queue, add } = fakeQueue();

    const result = await createServiceOperationQueue({ queue }).enqueue(payload);

    expect(result).toEqual({ ok: true, jobId: `service-op-${SERVICE_ID}` });
    expect(jobIdForServiceOperation(SERVICE_ID)).toBe(`service-op-${SERVICE_ID}`);
    expect(add).toHaveBeenCalledWith(SERVICE_OPERATION_JOB_NAME, payload, {
      jobId: `service-op-${SERVICE_ID}`,
      attempts: 1,
      removeOnComplete: true,
      removeOnFail: true,
    });
  });

  it.each(['waiting', 'active', 'delayed'])('reports SERVICE_OPERATION_IN_PROGRESS while a %s job exists', async (state) => {
    const { queue, add } = fakeQueue(state);

    const result = await createServiceOperationQueue({ queue }).enqueue(payload);

    expect(result).toMatchObject({ ok: false, code: 'SERVICE_OPERATION_IN_PROGRESS' });
    expect(add).not.toHaveBeenCalled();
  });

  it('drops a finished job that is still stored before enqueueing a new one', async () => {
    const { queue, removed } = fakeQueue('completed');

    const result = await createServiceOperationQueue({ queue }).enqueue(payload);

    expect(result).toMatchObject({ ok: true });
    expect(removed).toHaveBeenCalledOnce();
  });

  it('maps a Redis error or a hung Redis to QUEUE_UNAVAILABLE with a fixed message', async () => {
    const { queue, add } = fakeQueue();
    add.mockImplementationOnce(() => Promise.reject(new Error('redis://:secretpw@redis:6379 refused')));
    const failed = await createServiceOperationQueue({ queue }).enqueue(payload);
    expect(failed).toEqual({ ok: false, code: 'QUEUE_UNAVAILABLE', message: 'Job queue is unavailable' });

    const hung = fakeQueue();
    hung.getJob.mockImplementationOnce(() => new Promise(() => undefined));
    const timedOut = await createServiceOperationQueue({ queue: hung.queue, enqueueTimeoutMs: 20 }).enqueue(payload);
    expect(timedOut).toMatchObject({ ok: false, code: 'QUEUE_UNAVAILABLE' });
  });

  it('refuses a tampered payload before it reaches Redis', async () => {
    const { queue, add } = fakeQueue();

    const result = await createServiceOperationQueue({ queue }).enqueue({ ...payload, operation: 'exec' } as never);

    expect(result).toMatchObject({ ok: false, code: 'QUEUE_UNAVAILABLE' });
    expect(add).not.toHaveBeenCalled();
  });
});

const VIEW: ServiceView = {
  id: SERVICE_ID,
  projectId: 'p',
  environmentId: 'e',
  serverId: 'v',
  name: 'api',
  sourceType: 'image',
  repositoryUrl: null,
  branch: null,
  buildContext: null,
  dockerfilePath: null,
  buildTarget: null,
  imageRef: 'nginx:1.27',
  internalPort: 80,
  publishedPort: null,
  status: 'STOPPED',
  createdAt: '2026-10-05T10:00:00.000Z',
  updatedAt: '2026-10-05T10:00:01.000Z',
};

function handler(overrides: Partial<ServiceOperationJobDeps> = {}) {
  const events: ServerEvent[] = [];
  const close = vi.fn(() => Promise.resolve());
  const session = {} as SshDeploySession;
  const warn = vi.fn();
  const success: ServiceOperationResult = {
    ok: true,
    operation: 'stop',
    previousState: 'running',
    container: { kind: 'stopped', exitCode: 0 },
    durationMs: 12,
  };
  const deps: ServiceOperationJobDeps = {
    loadTarget: vi.fn(() => Promise.resolve({ serverId: SERVER_ID, activeDeployment: false })),
    record: vi.fn(() => Promise.resolve(VIEW)),
    events: { publish: (event: ServerEvent) => (events.push(event), Promise.resolve()) },
    connect: vi.fn(() => Promise.resolve({ ok: true as const, session, close })),
    createRedactor,
    limits: DEFAULT_SERVICE_OPS_LIMITS,
    run: vi.fn(() => Promise.resolve(success)),
    logger: { info: vi.fn(), warn, error: vi.fn() },
    ...overrides,
  };
  return { deps, events, close, session, warn, run: createServiceOperationJobHandler(deps) };
}

describe('createServiceOperationJobHandler', () => {
  it('connects to the service server, runs the operation, records it and publishes service.updated', async () => {
    const h = handler();

    const outcome = await h.run(payload);

    expect(outcome).toBe('succeeded');
    expect(h.deps.connect).toHaveBeenCalledWith(SERVER_ID, expect.anything(), undefined);
    expect(h.deps.run).toHaveBeenCalledWith(
      expect.objectContaining({ session: h.session, serviceId: SERVICE_ID, operation: 'stop', limits: DEFAULT_SERVICE_OPS_LIMITS }),
    );
    expect(h.deps.record).toHaveBeenCalledWith({
      serviceId: SERVICE_ID,
      serverId: SERVER_ID,
      operation: 'stop',
      actor: { type: 'user', id: USER_ID },
      result: expect.objectContaining({ ok: true }) as unknown,
    });
    expect(h.events).toEqual([{ type: 'service.updated', service: VIEW }]);
    expect(h.close).toHaveBeenCalledOnce();
  });

  it('records a system actor when the payload has none', async () => {
    const h = handler();

    await h.run({ ...payload, actorId: null });

    expect(h.deps.record).toHaveBeenCalledWith(expect.objectContaining({ actor: { type: 'system' } }));
  });

  it('skips without touching the server when a deployment became active meanwhile', async () => {
    const h = handler({ loadTarget: vi.fn(() => Promise.resolve({ serverId: SERVER_ID, activeDeployment: true })) });

    expect(await h.run(payload)).toBe('skipped_active_deployment');
    expect(h.deps.connect).not.toHaveBeenCalled();
    expect(h.deps.record).not.toHaveBeenCalled();
  });

  it('skips a service deleted meanwhile', async () => {
    const h = handler({ loadTarget: vi.fn(() => Promise.resolve(null)) });

    expect(await h.run(payload)).toBe('skipped_missing');
    expect(h.deps.connect).not.toHaveBeenCalled();
  });

  it('ignores an invalid payload', async () => {
    const h = handler();

    expect(await h.run({ ...payload, operation: 'exec' })).toBe('invalid_payload');
    expect(h.deps.loadTarget).not.toHaveBeenCalled();
  });

  it('records a failed operation with its code and still publishes', async () => {
    const failure: ServiceOperationResult = {
      ok: false,
      code: 'CONTAINER_NOT_FOUND',
      message: SERVICE_OPS_MESSAGES.CONTAINER_NOT_FOUND,
      durationMs: 3,
    };
    const h = handler({ run: vi.fn(() => Promise.resolve(failure)) });

    expect(await h.run(payload)).toBe('failed');
    expect(h.deps.record).toHaveBeenCalledWith(expect.objectContaining({ result: failure }));
    expect(h.events).toHaveLength(1);
  });

  it.each([
    ['SERVER_UNREACHABLE', 'SERVER_UNREACHABLE'],
    ['DOCKER_UNAVAILABLE', 'SERVER_DOCKER_UNAVAILABLE'],
  ] as const)('records a %s connect failure as %s, without running anything', async (connectCode, code) => {
    const h = handler({ connect: vi.fn(() => Promise.resolve({ ok: false as const, code: connectCode })) });

    expect(await h.run(payload)).toBe('failed');
    expect(h.deps.run).not.toHaveBeenCalled();
    expect(h.deps.record).toHaveBeenCalledWith(
      expect.objectContaining({ result: expect.objectContaining({ ok: false, code }) as unknown }),
    );
  });

  it('never throws: a rejected connect is SERVER_UNREACHABLE, a failing record or publish is only logged', async () => {
    const h = handler({
      connect: vi.fn(() => Promise.reject(new Error('ssh: password=hunter2'))),
      record: vi.fn(() => Promise.reject(new Error('db down'))),
    });

    expect(await h.run(payload)).toBe('failed');
    expect(h.deps.record).toHaveBeenCalledWith(
      expect.objectContaining({ result: expect.objectContaining({ code: 'SERVER_UNREACHABLE' }) as unknown }),
    );
    expect(h.warn).toHaveBeenCalled();
    expect(JSON.stringify(h.warn.mock.calls)).not.toContain('hunter2');
  });

  it('skips the publish when record returns no view (service deleted mid-operation)', async () => {
    const h = handler({ record: vi.fn(() => Promise.resolve(null)) });

    await h.run(payload);

    expect(h.events).toEqual([]);
  });
});
