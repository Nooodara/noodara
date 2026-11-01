import Fastify, { type FastifyInstance } from 'fastify';
import { hasZodFastifySchemaValidationErrors, serializerCompiler, validatorCompiler } from '@fastify/type-provider-zod';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  DEPLOYMENT_VIEW_FIELDS,
  type DeploymentServices,
  type DeploymentView,
} from '../services/deployment-services.js';
import deploymentsRoutes from './deployments.js';
import { toValidationErrorBody } from './http-errors.js';
import {
  DEPLOYMENT_LIST_MAX_LIMIT,
  DEPLOYMENT_ROUTE_BODY_LIMIT_BYTES,
  DeployBodySchema,
  DeploymentListQuerySchema,
  DeploymentListResponseSchema,
  DeploymentViewSchema,
  DeploymentWithStepsViewSchema,
  RollbackBodySchema,
  ServiceDeploymentParamsSchema,
  unknownDeployFields,
} from './deployment-schemas.js';

const SERVICE_ID = '0192f1a4-7b3c-7d2e-8f00-00000000bbbb';
const DEPLOYMENT_ID = '0192f1a4-7b3c-7d2e-8f00-00000000cccc';

const VIEW = {
  id: DEPLOYMENT_ID,
  serviceId: SERVICE_ID,
  status: 'QUEUED',
  trigger: 'manual',
  triggeredBy: '0192f1a4-7b3c-7d2e-8f00-00000000aaaa',
  source: {
    sourceType: 'image',
    repositoryUrl: null,
    branch: null,
    buildContext: null,
    dockerfilePath: null,
    buildTarget: null,
    imageRef: 'nginx:1.27',
    internalPort: 80,
    publishedPort: 8080,
  },
  commitSha: null,
  previousDeploymentId: null,
  rollbackOfDeploymentId: null,
  imageRef: null,
  webhookDeliveryId: null,
  startedAt: null,
  completedAt: null,
  durationMs: null,
  errorCode: null,
  errorMessage: null,
  createdAt: '2026-10-04T00:00:00.000Z',
  updatedAt: '2026-10-04T00:00:00.000Z',
};

describe('deploy request body (H3)', () => {
  it('caps the body at 1 KiB', () => {
    expect(DEPLOYMENT_ROUTE_BODY_LIMIT_BYTES).toBe(1024);
  });

  it('accepts no body or an empty object', () => {
    expect(DeployBodySchema.parse(undefined)).toBeUndefined();
    expect(unknownDeployFields(DeployBodySchema.parse({}))).toEqual([]);
    expect(unknownDeployFields(undefined)).toEqual([]);
    expect(unknownDeployFields(DeployBodySchema.parse(null))).toEqual([]);
  });

  it('keeps unknown keys so the handler can answer a named 422 listing them', () => {
    const body = DeployBodySchema.parse({ branch: 'dev', force: true });
    expect(unknownDeployFields(body)).toEqual(['branch', 'force']);
  });

  it('rejects a non-object body at validation', () => {
    expect(DeployBodySchema.safeParse('deploy').success).toBe(false);
    expect(DeployBodySchema.safeParse([1]).success).toBe(false);
  });
});

describe('deployment list query (H2)', () => {
  it('defaults to 20 items', () => {
    expect(DeploymentListQuerySchema.parse({})).toEqual({ limit: 20 });
  });

  it('accepts limits within 1..max and coerces query strings', () => {
    expect(DeploymentListQuerySchema.parse({ limit: '1' }).limit).toBe(1);
    expect(DeploymentListQuerySchema.parse({ limit: String(DEPLOYMENT_LIST_MAX_LIMIT) }).limit).toBe(100);
  });

  it.each(['0', '-1', '101', '1.5', 'abc', '1e9'])('rejects limit=%s', (limit) => {
    expect(DeploymentListQuerySchema.safeParse({ limit }).success).toBe(false);
  });

  it('rejects an empty or oversized cursor before decoding', () => {
    expect(DeploymentListQuerySchema.safeParse({ cursor: '' }).success).toBe(false);
    expect(DeploymentListQuerySchema.safeParse({ cursor: 'a'.repeat(513) }).success).toBe(false);
  });

  it('rejects unknown query keys', () => {
    expect(DeploymentListQuerySchema.safeParse({ limit: '5', status: 'FAILED' }).success).toBe(false);
  });
});

describe('deployment params', () => {
  it('requires uuids', () => {
    expect(ServiceDeploymentParamsSchema.safeParse({ serviceId: SERVICE_ID, deploymentId: DEPLOYMENT_ID }).success).toBe(true);
    expect(ServiceDeploymentParamsSchema.safeParse({ serviceId: SERVICE_ID, deploymentId: '../x' }).success).toBe(false);
  });
});

describe('deployment view schema', () => {
  it('matches the service view field list', () => {
    expect(Object.keys(DeploymentViewSchema.shape)).toEqual([...DEPLOYMENT_VIEW_FIELDS]);
  });

  it('strips any extra key on serialization, including inside the source snapshot', () => {
    const parsed = DeploymentViewSchema.parse({ ...VIEW, token: 'ghp_canary', source: { ...VIEW.source, password: 'pw' } });
    expect(JSON.stringify(parsed)).not.toContain('ghp_canary');
    expect(JSON.stringify(parsed)).not.toContain('"pw"');
  });

  it('wraps pages with a nullable next cursor', () => {
    expect(DeploymentListResponseSchema.parse({ items: [WITH_STEPS], nextCursor: null }).items).toHaveLength(1);
  });

  it('list items carry the step timeline (13-03 A3)', () => {
    expect(DeploymentListResponseSchema.safeParse({ items: [VIEW], nextCursor: null }).success).toBe(false);
  });
});

const pendingStep = (name: string) => ({ name, state: 'pending', startedAt: null, completedAt: null, durationMs: null });
const WITH_STEPS = {
  ...VIEW,
  steps: [
    pendingStep('pull'),
    pendingStep('configure'),
    { ...pendingStep('build'), state: 'skipped' },
    pendingStep('start'),
    pendingStep('verify'),
  ],
};

describe('DeploymentWithStepsViewSchema (13-03 A3)', () => {
  it('accepts exactly five steps with a known name and state (23-04: configure)', () => {
    expect(DeploymentWithStepsViewSchema.parse(WITH_STEPS).steps.map((step) => step.name)).toEqual([
      'pull',
      'configure',
      'build',
      'start',
      'verify',
    ]);
  });

  it('rejects a timeline that is not five steps long', () => {
    expect(DeploymentWithStepsViewSchema.safeParse({ ...WITH_STEPS, steps: WITH_STEPS.steps.slice(0, 4) }).success).toBe(false);
  });

  it('rejects unknown states, unknown names and negative durations', () => {
    const withStep = (step: Record<string, unknown>) => ({ ...WITH_STEPS, steps: [step, ...WITH_STEPS.steps.slice(1)] });
    expect(DeploymentWithStepsViewSchema.safeParse(withStep({ ...pendingStep('pull'), state: 'done' })).success).toBe(false);
    expect(DeploymentWithStepsViewSchema.safeParse(withStep(pendingStep('deploy'))).success).toBe(false);
    expect(DeploymentWithStepsViewSchema.safeParse(withStep({ ...pendingStep('pull'), durationMs: -1 })).success).toBe(false);
  });

  it('a configure step carries counts only (23-04 A4): non-negative integers, no other key', () => {
    const withConfigure = (counts: unknown) => ({
      ...WITH_STEPS,
      steps: [WITH_STEPS.steps[0], { ...pendingStep('configure'), state: 'success', counts }, ...WITH_STEPS.steps.slice(2)],
    });
    expect(DeploymentWithStepsViewSchema.safeParse(withConfigure({ variables: 2, secrets: 1 })).success).toBe(true);
    expect(DeploymentWithStepsViewSchema.safeParse(withConfigure({ variables: -1, secrets: 1 })).success).toBe(false);
    expect(DeploymentWithStepsViewSchema.safeParse(withConfigure({ variables: 1, secrets: 1, keys: ['A'] })).success).toBe(false);
  });

  it('the plain view (POST responses) has no steps key', () => {
    expect(Object.keys(DeploymentViewSchema.shape)).not.toContain('steps');
  });
});

describe('rollback request body (17-05 A5)', () => {
  it('accepts no body, an empty object or a uuid target', () => {
    expect(RollbackBodySchema.parse(undefined)).toBeUndefined();
    expect(RollbackBodySchema.parse(null)).toBeNull();
    expect(RollbackBodySchema.parse({})).toEqual({});
    expect(RollbackBodySchema.parse({ targetDeploymentId: DEPLOYMENT_ID })).toEqual({ targetDeploymentId: DEPLOYMENT_ID });
  });

  it.each([
    ['a non-uuid target', { targetDeploymentId: '../x' }],
    ['a numeric target', { targetDeploymentId: 7 }],
    ['an unknown field', { targetDeploymentId: DEPLOYMENT_ID, force: true }],
    ['a string body', 'rollback'],
    ['an array body', [DEPLOYMENT_ID]],
  ])('rejects %s', (_label, body) => {
    expect(RollbackBodySchema.safeParse(body).success).toBe(false);
  });
});

describe('history view (17-05 A4)', () => {
  it('carries trigger, actor, delivery, commit, image, previous and rollback_of', () => {
    const parsed = DeploymentViewSchema.parse({
      ...VIEW,
      trigger: 'rollback',
      previousDeploymentId: SERVICE_ID,
      rollbackOfDeploymentId: DEPLOYMENT_ID,
      imageRef: 'noodara/x:y',
    });
    expect(parsed).toMatchObject({
      trigger: 'rollback',
      triggeredBy: VIEW.triggeredBy,
      webhookDeliveryId: null,
      commitSha: null,
      imageRef: 'noodara/x:y',
      previousDeploymentId: SERVICE_ID,
      rollbackOfDeploymentId: DEPLOYMENT_ID,
    });
  });

  it('never carries the idempotency key or fingerprint', () => {
    const parsed = DeploymentViewSchema.parse({ ...VIEW, idempotencyKey: 'k-canary', requestFingerprint: 'f'.repeat(64) });
    expect(JSON.stringify(parsed)).not.toContain('k-canary');
    expect(Object.keys(DeploymentViewSchema.shape)).not.toContain('idempotencyKey');
    expect(Object.keys(DeploymentViewSchema.shape)).not.toContain('runtimeConfig');
  });
});

describe('POST /api/services/:serviceId/rollback (17-05 A1/A2/A5/H1)', () => {
  const ACTOR = { type: 'user', id: '0192f1a4-7b3c-7d2e-8f00-00000000dddd' } as const;
  const TARGET_ID = '0192f1a4-7b3c-7d2e-8f00-00000000eeee';
  const URL = `/api/services/${SERVICE_ID}/rollback`;
  const ROLLBACK_VIEW = {
    ...VIEW,
    trigger: 'rollback',
    rollbackOfDeploymentId: TARGET_ID,
    imageRef: `noodara/${SERVICE_ID}:${TARGET_ID}`,
  } as unknown as DeploymentView;
  let app: FastifyInstance | null = null;

  afterEach(async () => {
    await app?.close();
    app = null;
  });

  async function build(triggerRollback: DeploymentServices['triggerRollback']): Promise<FastifyInstance> {
    const instance = Fastify();
    instance.setValidatorCompiler(validatorCompiler);
    instance.setSerializerCompiler(serializerCompiler);
    instance.setErrorHandler((error, _request, reply) => {
      if (hasZodFastifySchemaValidationErrors(error)) {
        void reply.code(400).send(toValidationErrorBody(error.validation));
        return;
      }
      const status = (error as { statusCode?: number }).statusCode ?? 500;
      void reply.code(status).send({ error: status === 413 ? 'PAYLOAD_TOO_LARGE' : 'INTERNAL_ERROR', message: 'error' });
    });
    instance.decorate('getDeploymentServices', () =>
      Promise.resolve({ triggerRollback } as unknown as DeploymentServices),
    );
    instance.decorateRequest('actor', null);
    instance.addHook('onRequest', (request, _reply, done) => {
      request.actor = ACTOR;
      done();
    });
    await instance.register(deploymentsRoutes, { cancelDeployment: vi.fn() });
    await instance.ready();
    app = instance;
    return instance;
  }

  const okResult = (replayed: boolean) => () => Promise.resolve({ ok: true as const, deployment: ROLLBACK_VIEW, replayed });

  it('answers 202 with the rollback view and passes actor, service, target and key', async () => {
    const trigger = vi.fn<DeploymentServices['triggerRollback']>(okResult(false));
    const instance = await build(trigger);

    const response = await instance.inject({
      method: 'POST',
      url: URL,
      headers: { 'idempotency-key': 'rb-1' },
      payload: { targetDeploymentId: TARGET_ID },
    });

    expect(response.statusCode).toBe(202);
    expect(response.json()).toMatchObject({ trigger: 'rollback', rollbackOfDeploymentId: TARGET_ID });
    expect(response.headers['idempotency-replayed']).toBeUndefined();
    expect(trigger).toHaveBeenCalledWith({
      actor: ACTOR,
      serviceId: SERVICE_ID,
      targetDeploymentId: TARGET_ID,
      idempotencyKey: 'rb-1',
    });
  });

  it.each<[string, object | undefined]>([
    ['no body', undefined],
    ['an empty object', {}],
  ])('accepts %s and lets the service pick the default target', async (_label, payload) => {
    const trigger = vi.fn<DeploymentServices['triggerRollback']>(okResult(false));
    const instance = await build(trigger);

    const response = await instance.inject({ method: 'POST', url: URL, ...(payload === undefined ? {} : { payload }) });

    expect(response.statusCode).toBe(202);
    expect(trigger).toHaveBeenCalledWith({ actor: ACTOR, serviceId: SERVICE_ID });
  });

  it('marks a replayed response with Idempotency-Replayed (H1)', async () => {
    const instance = await build(okResult(true));

    const response = await instance.inject({ method: 'POST', url: URL, headers: { 'idempotency-key': 'rb-1' } });

    expect(response.statusCode).toBe(202);
    expect(response.headers['idempotency-replayed']).toBe('true');
  });

  it.each([
    ['NOT_FOUND', 404],
    ['DEPLOYMENT_IN_PROGRESS', 409],
    ['ROLLBACK_TARGET_UNAVAILABLE', 422],
    ['IDEMPOTENCY_KEY_REUSED', 422],
    ['QUEUE_UNAVAILABLE', 503],
  ] as const)('maps %s to %i with a closed error body', async (code, status) => {
    const instance = await build(() => Promise.resolve({ ok: false, code, message: 'fixed text' }));

    const response = await instance.inject({ method: 'POST', url: URL });

    expect(response.statusCode).toBe(status);
    expect(response.json()).toEqual({ error: code, message: 'fixed text' });
  });

  it.each<[string, string, object | undefined]>([
    ['a malformed service id', '/api/services/not-a-uuid/rollback', undefined],
    ['a non-uuid target', URL, { targetDeploymentId: 'abc' }],
    ['an unknown field', URL, { targetDeploymentId: TARGET_ID, force: true }],
    ['a non-object body', URL, [TARGET_ID]],
  ])('rejects %s with 400 before any rollback (A5)', async (_label, url, payload) => {
    const trigger = vi.fn<DeploymentServices['triggerRollback']>();
    const instance = await build(trigger);

    const response = await instance.inject({ method: 'POST', url, ...(payload === undefined ? {} : { payload }) });

    expect(response.statusCode).toBe(400);
    expect(trigger).not.toHaveBeenCalled();
  });

  it.each([
    ['an empty key', ''],
    ['a key with spaces', 'a b'],
    ['a key over 255 chars', 'k'.repeat(256)],
    ['a non-ASCII key', 'clé'],
  ])('rejects %s with 400 IDEMPOTENCY_KEY_INVALID (H1)', async (_label, key) => {
    const trigger = vi.fn<DeploymentServices['triggerRollback']>();
    const instance = await build(trigger);

    const response = await instance.inject({ method: 'POST', url: URL, headers: { 'idempotency-key': key } });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ error: 'IDEMPOTENCY_KEY_INVALID' });
    expect(trigger).not.toHaveBeenCalled();
  });

  it('caps the body at the route limit (A5)', async () => {
    const trigger = vi.fn<DeploymentServices['triggerRollback']>();
    const instance = await build(trigger);

    const response = await instance.inject({
      method: 'POST',
      url: URL,
      headers: { 'content-type': 'application/json' },
      payload: JSON.stringify({ targetDeploymentId: TARGET_ID, pad: 'x'.repeat(DEPLOYMENT_ROUTE_BODY_LIMIT_BYTES) }),
    });

    expect(response.statusCode).toBe(413);
    expect(trigger).not.toHaveBeenCalled();
  });

  it('never serializes a field outside the view contract (A5)', async () => {
    const leaky = {
      ...ROLLBACK_VIEW,
      runtimeConfig: { env: { TOKEN: 'ghp_canary' } },
      credential: 'k-canary',
    } as unknown as DeploymentView;
    const instance = await build(() => Promise.resolve({ ok: true, deployment: leaky, replayed: false }));

    const response = await instance.inject({ method: 'POST', url: URL });

    expect(response.statusCode).toBe(202);
    expect(response.body).not.toContain('ghp_canary');
    expect(response.body).not.toContain('k-canary');
  });
});

describe('GET /api/services/:serviceId/deployments (17-05 H2)', () => {
  const URL = `/api/services/${SERVICE_ID}/deployments`;
  let app: FastifyInstance | null = null;

  afterEach(async () => {
    await app?.close();
    app = null;
  });

  async function build(listDeployments: DeploymentServices['listDeployments']): Promise<FastifyInstance> {
    const instance = Fastify();
    instance.setValidatorCompiler(validatorCompiler);
    instance.setSerializerCompiler(serializerCompiler);
    instance.setErrorHandler((error, _request, reply) => {
      if (hasZodFastifySchemaValidationErrors(error)) {
        void reply.code(400).send(toValidationErrorBody(error.validation));
        return;
      }
      void reply.code(500).send({ error: 'INTERNAL_ERROR', message: 'error' });
    });
    instance.decorate('getDeploymentServices', () => Promise.resolve({ listDeployments } as unknown as DeploymentServices));
    instance.decorateRequest('actor', null);
    await instance.register(deploymentsRoutes, { cancelDeployment: vi.fn(), readStepStamps: () => Promise.resolve(new Map()) });
    await instance.ready();
    app = instance;
    return instance;
  }

  it.each([
    ['a limit over the cap', `${URL}?limit=${String(DEPLOYMENT_LIST_MAX_LIMIT + 1)}`],
    ['a zero limit', `${URL}?limit=0`],
    ['a malformed cursor', `${URL}?cursor=not-a-cursor`],
    ['an unknown query key', `${URL}?offset=10`],
  ])('rejects %s with 400 and never reads the history', async (_label, url) => {
    const list = vi.fn<DeploymentServices['listDeployments']>();
    const instance = await build(list);

    const response = await instance.inject({ method: 'GET', url });

    expect(response.statusCode).toBe(400);
    expect(list).not.toHaveBeenCalled();
  });

  it('scopes the rows to the service in the path: an unknown or foreign service is 404', async () => {
    const list = vi.fn<DeploymentServices['listDeployments']>(() => Promise.resolve(null));
    const instance = await build(list);

    const response = await instance.inject({ method: 'GET', url: `${URL}?limit=5` });

    expect(response.statusCode).toBe(404);
    expect(list).toHaveBeenCalledWith(SERVICE_ID, { limit: 5 });
  });
});
