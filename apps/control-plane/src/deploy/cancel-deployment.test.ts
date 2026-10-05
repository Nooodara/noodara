// 12-13: cancel service (A1, A2 API side, H1, ERR) and its route.
import Fastify, { type FastifyInstance } from 'fastify';
import { hasZodFastifySchemaValidationErrors, serializerCompiler, validatorCompiler } from '@fastify/type-provider-zod';
import { afterEach, describe, expect, it, vi } from 'vitest';
import deploymentsRoutes from '../routes/deployments.js';
import { toValidationErrorBody } from '../routes/http-errors.js';
import type { DeploymentView } from '../services/deployment-services.js';
import { createCancelDeployment, type CancelDeployment, type CancelDeploymentDeps } from './cancel-deployment.js';
import type { StoreCancelResult } from './deployment-store.js';

const DEPLOYMENT_ID = '0192f1a4-7b3c-7d2e-8f00-00000000cccc';
const SERVICE_ID = '0192f1a4-7b3c-7d2e-8f00-00000000bbbb';
const ACTOR = { type: 'user', id: '0192f1a4-7b3c-7d2e-8f00-00000000dddd' } as const;
const RAW = 'ReplyError: NOAUTH redis://:hunter2@redis:6379';

function view(status: DeploymentView['status']): DeploymentView {
  return {
    id: DEPLOYMENT_ID,
    serviceId: SERVICE_ID,
    status,
    trigger: 'manual',
    triggeredBy: ACTOR.id,
    source: {
      sourceType: 'image',
      repositoryUrl: null,
      branch: null,
      buildContext: null,
      dockerfilePath: null,
      buildTarget: null,
      imageRef: 'nginx:1.27',
      internalPort: 80,
      publishedPort: null,
    },
    commitSha: null,
    previousDeploymentId: null,
    startedAt: null,
    completedAt: null,
    durationMs: null,
    errorCode: null,
    errorMessage: null,
    createdAt: '2026-10-05T10:00:00.000Z',
    updatedAt: '2026-10-05T10:00:00.000Z',
  };
}

function harness(result: StoreCancelResult, flag: 'requested' | 'already_requested' | 'unavailable' = 'requested') {
  const logs: { fields: Record<string, unknown>; message: string }[] = [];
  const deps = {
    store: {
      requestCancel: vi.fn(() => Promise.resolve(result)),
      recordCancelRequested: vi.fn(() => Promise.resolve()),
    },
    flags: { request: vi.fn(() => Promise.resolve(flag)) },
    queue: { removeJob: vi.fn(() => Promise.resolve(true)) },
    logger: { warn: (fields: Record<string, unknown>, message: string) => void logs.push({ fields, message }) },
  } satisfies CancelDeploymentDeps;
  return { deps, logs, cancel: createCancelDeployment(deps) };
}

describe('cancelDeployment', () => {
  it('a QUEUED deployment is CANCELLED by the store and its job removed; no flag is raised (A1)', async () => {
    const h = harness({ kind: 'cancelled', deployment: view('CANCELLED') });

    expect(await h.cancel(DEPLOYMENT_ID, ACTOR)).toEqual({ ok: true, deployment: view('CANCELLED') });
    expect(h.deps.store.requestCancel).toHaveBeenCalledWith(DEPLOYMENT_ID, ACTOR);
    expect(h.deps.queue.removeJob).toHaveBeenCalledWith(DEPLOYMENT_ID);
    expect(h.deps.flags.request).not.toHaveBeenCalled();
  });

  it('a job that cannot be removed still answers the cancel, logged by kind only', async () => {
    const h = harness({ kind: 'cancelled', deployment: view('CANCELLED') });
    h.deps.queue.removeJob.mockRejectedValueOnce(new Error(RAW));

    expect(await h.cancel(DEPLOYMENT_ID, ACTOR)).toMatchObject({ ok: true });
    expect(JSON.stringify(h.logs)).not.toContain('hunter2');
  });

  it('a running deployment raises the flag and records cancel_requested once; it never moves the row (A2)', async () => {
    const h = harness({ kind: 'running', deployment: view('BUILDING') });

    expect(await h.cancel(DEPLOYMENT_ID, ACTOR)).toEqual({ ok: true, deployment: view('BUILDING') });
    expect(h.deps.flags.request).toHaveBeenCalledWith(DEPLOYMENT_ID);
    expect(h.deps.store.recordCancelRequested).toHaveBeenCalledWith(view('BUILDING'), ACTOR);
    expect(h.deps.queue.removeJob).not.toHaveBeenCalled();
  });

  it('a second cancel while the flag is up is a no-op with the same answer (H1)', async () => {
    const h = harness({ kind: 'running', deployment: view('BUILDING') }, 'already_requested');

    expect(await h.cancel(DEPLOYMENT_ID, ACTOR)).toEqual({ ok: true, deployment: view('BUILDING') });
    expect(h.deps.store.recordCancelRequested).not.toHaveBeenCalled();
  });

  it('a terminal deployment is a named DEPLOYMENT_NOT_CANCELLABLE (H1)', async () => {
    const h = harness({ kind: 'terminal', deployment: view('SUCCESS') });

    const result = await h.cancel(DEPLOYMENT_ID, ACTOR);

    expect(result).toMatchObject({ ok: false, code: 'DEPLOYMENT_NOT_CANCELLABLE' });
    expect(h.deps.flags.request).not.toHaveBeenCalled();
  });

  it('a missing deployment is NOT_FOUND; a Redis that cannot take the flag is QUEUE_UNAVAILABLE (ERR)', async () => {
    expect(await harness({ kind: 'missing' }).cancel(DEPLOYMENT_ID, ACTOR)).toMatchObject({ ok: false, code: 'NOT_FOUND' });
    const down = harness({ kind: 'running', deployment: view('DEPLOYING') }, 'unavailable');
    expect(await down.cancel(DEPLOYMENT_ID, ACTOR)).toMatchObject({ ok: false, code: 'QUEUE_UNAVAILABLE' });
    expect(down.deps.store.recordCancelRequested).not.toHaveBeenCalled();
  });

  it('an activity write failure does not undo an accepted cancel', async () => {
    const h = harness({ kind: 'running', deployment: view('BUILDING') });
    h.deps.store.recordCancelRequested.mockRejectedValueOnce(new Error(RAW));

    expect(await h.cancel(DEPLOYMENT_ID, ACTOR)).toMatchObject({ ok: true });
    expect(JSON.stringify(h.logs)).not.toContain('hunter2');
  });
});

describe('POST /api/deployments/:deploymentId/cancel', () => {
  let app: FastifyInstance | null = null;

  afterEach(async () => {
    await app?.close();
    app = null;
  });

  async function build(cancelDeployment: CancelDeployment): Promise<FastifyInstance> {
    const instance = Fastify();
    instance.setValidatorCompiler(validatorCompiler);
    instance.setSerializerCompiler(serializerCompiler);
    instance.setErrorHandler((error, _request, reply) => {
      if (hasZodFastifySchemaValidationErrors(error)) {
        void reply.code(400).send(toValidationErrorBody(error.validation));
        return;
      }
      void reply.code(500).send({ error: 'INTERNAL_ERROR', message: 'Internal error' });
    });
    instance.decorateRequest('actor', null);
    instance.addHook('onRequest', (request, _reply, done) => {
      request.actor = ACTOR;
      done();
    });
    await instance.register(deploymentsRoutes, { cancelDeployment });
    await instance.ready();
    app = instance;
    return instance;
  }

  it('answers 202 with the deployment view and passes the session actor', async () => {
    const cancel = vi.fn<CancelDeployment>(() => Promise.resolve({ ok: true, deployment: view('BUILDING') }));
    const instance = await build(cancel);

    const response = await instance.inject({ method: 'POST', url: `/api/deployments/${DEPLOYMENT_ID}/cancel` });

    expect(response.statusCode).toBe(202);
    expect(response.json()).toMatchObject({ id: DEPLOYMENT_ID, status: 'BUILDING' });
    expect(cancel).toHaveBeenCalledWith(DEPLOYMENT_ID, ACTOR);
  });

  it.each([
    ['NOT_FOUND', 404],
    ['DEPLOYMENT_NOT_CANCELLABLE', 409],
    ['QUEUE_UNAVAILABLE', 503],
  ] as const)('maps %s to %i with a closed error body', async (code, status) => {
    const instance = await build(() => Promise.resolve({ ok: false, code, message: 'fixed text' }));

    const response = await instance.inject({ method: 'POST', url: `/api/deployments/${DEPLOYMENT_ID}/cancel` });

    expect(response.statusCode).toBe(status);
    expect(response.json()).toEqual({ error: code, message: 'fixed text' });
  });

  it('rejects a malformed id with 400 before any cancel', async () => {
    const cancel = vi.fn<CancelDeployment>();
    const instance = await build(cancel);

    const response = await instance.inject({ method: 'POST', url: '/api/deployments/not-a-uuid/cancel' });

    expect(response.statusCode).toBe(400);
    expect(cancel).not.toHaveBeenCalled();
  });
});
