// 12-11b (W1): the deploy BullMQ worker and its wiring into src/worker.ts.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { WorkerOptions } from 'bullmq';
import type { Redis } from 'ioredis';
import { describe, expect, it, vi } from 'vitest';
import { DEFAULT_POST_START_POLL_POLICY } from '@noodara/domain/deployment';
import type { Database } from '../db/client.js';
import { BULLMQ_PREFIX } from '../queue/connect-server-queue.js';
import { computeDeployJobLockDurationMs } from '../queue/deploy-job-budget.js';
import { DEPLOY_QUEUE_NAME } from '../queue/deploy-queue.js';
import { noopServerEventPublisher } from '../events/server-event-publisher.js';
import { createDeployJobDeps, startDeployWorker, type DeployWorkerLike } from './deploy-runtime.js';
import { noopDeploymentLogSink } from './log-sink.js';
import { SERVICE_OPERATION_JOB_NAME } from './service-ops-job.js';

const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
const connection = {} as Redis;

function fakeWorkerFactory() {
  const calls: { name: string; processor: (job: { name?: string; data: unknown }, token?: string, signal?: AbortSignal) => Promise<unknown>; opts: WorkerOptions }[] = [];
  const order: string[] = [];
  const listeners = new Map<string, (...args: unknown[]) => void>();
  const worker: DeployWorkerLike = {
    on: (event, listener) => {
      listeners.set(event, listener as (...args: unknown[]) => void);
    },
    cancelAllJobs: () => {
      order.push('cancelAllJobs');
    },
    close: () => {
      order.push('close');
      return Promise.resolve();
    },
  };
  const createWorker = vi.fn((name: string, processor: (typeof calls)[number]['processor'], opts: WorkerOptions) => {
    calls.push({ name, processor, opts });
    return worker;
  });
  return { createWorker, calls, order, listeners };
}

describe('startDeployWorker', () => {
  it('consumes the deploy queue with the configured concurrency, the deploy lock and maxStalledCount 0', () => {
    const fake = fakeWorkerFactory();
    startDeployWorker({
      handler: () => Promise.resolve({ outcome: 'SUCCESS' as const }),
      connection,
      concurrency: 3,
      deployMaxMs: 600_000,
      logger,
      createWorker: fake.createWorker,
    });
    const call = fake.calls[0];
    expect(call?.name).toBe(DEPLOY_QUEUE_NAME);
    expect(call?.opts).toMatchObject({
      connection,
      prefix: BULLMQ_PREFIX,
      concurrency: 3,
      lockDuration: computeDeployJobLockDurationMs(600_000),
      maxStalledCount: 0,
    });
  });

  it('hands the job data and the BullMQ abort signal to the handler', async () => {
    const fake = fakeWorkerFactory();
    const handler = vi.fn(() => Promise.resolve({ outcome: 'ALREADY_CLAIMED' as const }));
    startDeployWorker({ handler, connection, concurrency: 1, deployMaxMs: 600_000, logger, createWorker: fake.createWorker });
    const signal = new AbortController().signal;
    const result = await fake.calls[0]?.processor({ data: { deploymentId: 'x' } }, 'token', signal);
    expect(handler).toHaveBeenCalledWith({ deploymentId: 'x' }, signal);
    expect(result).toEqual({ outcome: 'ALREADY_CLAIMED' });
  });

  it('dispatches service-operation jobs to the service operation handler, never to the deploy handler', async () => {
    const fake = fakeWorkerFactory();
    const handler = vi.fn(() => Promise.resolve({ outcome: 'SUCCESS' as const }));
    const serviceOperationHandler = vi.fn(() => Promise.resolve('succeeded' as const));
    startDeployWorker({
      handler,
      serviceOperationHandler,
      connection,
      concurrency: 1,
      deployMaxMs: 600_000,
      logger,
      createWorker: fake.createWorker,
    });
    const data = { serviceId: 'svc', operation: 'stop', actorId: null };
    const result = await fake.calls[0]?.processor({ name: SERVICE_OPERATION_JOB_NAME, data });
    expect(serviceOperationHandler).toHaveBeenCalledWith(data);
    expect(handler).not.toHaveBeenCalled();
    expect(result).toEqual({ outcome: 'succeeded' });
  });

  it('keeps deploy jobs on the deploy handler when a service operation handler is wired', async () => {
    const fake = fakeWorkerFactory();
    const handler = vi.fn(() => Promise.resolve({ outcome: 'SUCCESS' as const }));
    const serviceOperationHandler = vi.fn(() => Promise.resolve('succeeded' as const));
    startDeployWorker({ handler, serviceOperationHandler, connection, concurrency: 1, deployMaxMs: 600_000, logger, createWorker: fake.createWorker });
    await fake.calls[0]?.processor({ name: 'deploy-service', data: { deploymentId: 'x' } });
    expect(handler).toHaveBeenCalledTimes(1);
    expect(serviceOperationHandler).not.toHaveBeenCalled();
  });

  it('ignores a service-operation job when no handler is wired (never runs it as a deploy)', async () => {
    const fake = fakeWorkerFactory();
    const handler = vi.fn(() => Promise.resolve({ outcome: 'SUCCESS' as const }));
    startDeployWorker({ handler, connection, concurrency: 1, deployMaxMs: 600_000, logger, createWorker: fake.createWorker });
    const result = await fake.calls[0]?.processor({ name: SERVICE_OPERATION_JOB_NAME, data: {} });
    expect(handler).not.toHaveBeenCalled();
    expect(result).toEqual({ outcome: 'invalid_payload' });
  });

  it('logs worker errors without their message (a Redis error can carry a URL)', () => {
    const fake = fakeWorkerFactory();
    startDeployWorker({
      handler: () => Promise.resolve({ outcome: 'SUCCESS' as const }),
      connection,
      concurrency: 1,
      deployMaxMs: 600_000,
      logger,
      createWorker: fake.createWorker,
    });
    fake.listeners.get('error')?.(new Error('redis://user:hunter2@host'));
    const logged = JSON.stringify(logger.error.mock.calls);
    expect(logged).not.toContain('hunter2');
    expect(logger.error).toHaveBeenCalled();
  });

  it('close cancels in-flight jobs (their cleanup runs) before closing the worker', async () => {
    const fake = fakeWorkerFactory();
    const handle = startDeployWorker({
      handler: () => Promise.resolve({ outcome: 'SUCCESS' as const }),
      connection,
      concurrency: 1,
      deployMaxMs: 600_000,
      logger,
      createWorker: fake.createWorker,
    });
    await handle.close();
    expect(fake.order).toEqual(['cancelAllJobs', 'close']);
  });
});

describe('createDeployJobDeps', () => {
  it('derives the run limits from the deploy config and uses the default poll policy and the noop sink', () => {
    const deps = createDeployJobDeps({
      db: {} as Database,
      events: noopServerEventPublisher,
      ssh: { connect: vi.fn() },
      timeouts: { connectMs: 1, commandMs: 1, discoveryMs: 1 },
      masterKeys: () => Promise.reject(new Error('unused')),
      panelPorts: [],
      config: { deployMaxMs: 600_000, idleMs: 120_000, logMaxBytes: 1_000_000, logLineMaxBytes: 16_384 },
      logger,
    });
    expect(deps.limits).toEqual({
      deployMaxMs: 600_000,
      idleMs: 120_000,
      maxTotalBytes: 1_000_000,
      maxLineBytes: 16_384,
      stopTimeoutSeconds: 10,
      killConfirmMs: 10_000,
      killPollMs: 250,
      cleanupStepMs: 60_000,
    });
    expect(deps.pollPolicy).toBe(DEFAULT_POST_START_POLL_POLICY);
    expect(deps.sinkFor('d')).toBe(noopDeploymentLogSink);
    expect(deps.createRedactor()).not.toBe(deps.createRedactor());
  });
});

describe('src/worker.ts wiring (W1)', () => {
  const source = readFileSync(fileURLToPath(new URL('../worker.ts', import.meta.url)), 'utf8');

  it('wires the service-operation handler into the deploy worker (12-14)', () => {
    expect(source).toMatch(/createServiceOperationJobHandler\(\s*createServiceOperationJobDeps\(deployJobDeps/);
    expect(source).toMatch(/startDeployWorker\(\{[\s\S]*serviceOperationHandler,/);
    expect(source).toMatch(/loadServiceOperationTarget\(db, serviceId\)/);
    expect(source).toMatch(/recordServiceOperation\(db,/);
  });

  it('starts the deploy worker with NOODARA_DEPLOY_CONCURRENCY on its own Redis connection', () => {
    expect(source).toMatch(/startDeployWorker\(\{[\s\S]*concurrency: env\.NOODARA_DEPLOY_CONCURRENCY/);
    expect(source).toMatch(/deployMaxMs: env\.NOODARA_DEPLOY_MAX_MS/);
    expect(source).toMatch(/const deployWorkerConnection = createWorkerRedisConnection\(/);
  });

  it('closes the deploy worker and disconnects its connection in the shutdown sequence', () => {
    const shutdown = source.slice(source.indexOf('runWorkerShutdown({'));
    expect(shutdown).toContain('deployHandle.close()');
    expect(shutdown).toContain('deployWorkerConnection.disconnect()');
  });
});
