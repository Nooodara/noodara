import { describe, expect, it, vi } from 'vitest';
import type { Database } from '../db/client.js';
import type { ServerEvent } from '../events/server-event-publisher.js';
import type { DeployEnqueueResult } from '../queue/deploy-queue.js';
import {
  DEPLOYMENT_VIEW_FIELDS,
  planRollback,
  rollbackFingerprint,
  sourceSnapshotFromService,
  toDeploymentView,
  triggerDeploy,
  triggerRollback,
  type DeploymentRow,
  type DeploymentServicesDeps,
  type DeploymentView,
} from './deployment-services.js';
import type { ServiceView } from './service-view.js';

const USER_ID = '0192f1a4-7b3c-7d2e-8f00-00000000aaaa';
const SERVICE_ID = '0192f1a4-7b3c-7d2e-8f00-00000000bbbb';
const DEPLOYMENT_ID = '0192f1a4-7b3c-7d2e-8f00-00000000cccc';
const ACTOR = { type: 'user', id: USER_ID } as const;
const NOW = new Date('2026-10-04T12:00:00.000Z');

const SOURCE = {
  sourceType: 'git',
  repositoryUrl: 'https://github.com/acme/api.git',
  branch: 'main',
  buildContext: '.',
  dockerfilePath: 'Dockerfile',
  buildTarget: null,
  imageRef: null,
  internalPort: 3000,
  publishedPort: 8080,
} as const;

function row(overrides: Partial<DeploymentRow> = {}): DeploymentRow {
  return {
    id: DEPLOYMENT_ID,
    serviceId: SERVICE_ID,
    status: 'QUEUED',
    trigger: 'manual',
    triggeredBy: USER_ID,
    source: SOURCE,
    commitSha: null,
    previousDeploymentId: null,
    startedAt: null,
    completedAt: null,
    durationMs: null,
    errorCode: null,
    errorMessage: null,
    buildingStartedAt: null,
    deployingStartedAt: null,
    verifyingStartedAt: null,
    imageRef: null,
    rollbackOfDeploymentId: null,
    webhookDeliveryId: null,
    idempotencyKey: null,
    requestFingerprint: null,
    runtimeConfig: null,
    healthcheckStartedAt: null,
    rollbackStartedAt: null,
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

const SERVICE_VIEW: ServiceView = {
  id: SERVICE_ID,
  projectId: 'p',
  environmentId: 'e',
  serverId: 's',
  name: 'api',
  ...SOURCE,
  status: 'DEPLOYING',
  createdAt: '2026-10-04T11:00:00.000Z',
  updatedAt: NOW.toISOString(),
};

function harness(options: {
  transactions: (() => Promise<unknown>)[];
  enqueue?: DeployEnqueueResult;
}): {
  deps: DeploymentServicesDeps;
  transaction: ReturnType<typeof vi.fn>;
  enqueue: ReturnType<typeof vi.fn>;
  published: ServerEvent[];
  logger: { warn: ReturnType<typeof vi.fn>; error: ReturnType<typeof vi.fn> };
} {
  const transaction = vi.fn();
  for (const impl of options.transactions) transaction.mockImplementationOnce(impl);
  const enqueue = vi.fn((): Promise<DeployEnqueueResult> => Promise.resolve(options.enqueue ?? { ok: true, jobId: `deploy-${DEPLOYMENT_ID}` }));
  const published: ServerEvent[] = [];
  const logger = { warn: vi.fn(), error: vi.fn() };
  const deps: DeploymentServicesDeps = {
    db: { transaction } as unknown as Database,
    now: () => NOW,
    events: {
      publish(event) {
        published.push(event);
        return Promise.resolve();
      },
    },
    queue: { enqueue },
    logger,
  };
  return { deps, transaction, enqueue, published, logger };
}

const inserted = () =>
  Promise.resolve({ ok: true, deployment: toDeploymentView(row()), service: SERVICE_VIEW, activityEventId: 'evt-1' });

describe('toDeploymentView', () => {
  it('builds the allowlisted wire view with ISO timestamps', () => {
    const view = toDeploymentView(row({ startedAt: NOW, errorCode: 'BUILD_FAILED' }));
    expect(Object.keys(view)).toEqual([...DEPLOYMENT_VIEW_FIELDS]);
    expect(view.createdAt).toBe(NOW.toISOString());
    expect(view.startedAt).toBe(NOW.toISOString());
    expect(view.completedAt).toBeNull();
    expect(view.errorCode).toBe('BUILD_FAILED');
    expect(view.source).toEqual(SOURCE);
  });

  it('keeps only the allowlisted snapshot keys, even if the stored JSON carries more', () => {
    const view = toDeploymentView(row({ source: { ...SOURCE, token: 'ghp_canary', registryPassword: 'pw' } }));
    expect(JSON.stringify(view)).not.toContain('ghp_canary');
    expect(Object.keys(view.source).sort()).toEqual(Object.keys(SOURCE).sort());
  });

  it('throws on a malformed snapshot rather than inventing one', () => {
    expect(() => toDeploymentView(row({ source: { sourceType: 'ftp' } }))).toThrow();
  });
});

describe('sourceSnapshotFromService', () => {
  it('copies the source columns and ports only, never credential ids', () => {
    const snapshot = sourceSnapshotFromService({
      ...SOURCE,
      repositoryCredentialId: 'cred-1',
      registryCredentialId: 'cred-2',
    } as never);
    expect(snapshot).toEqual(SOURCE);
  });
});

describe('triggerDeploy', () => {
  it('enqueues an ids-only payload for the inserted QUEUED deployment and publishes after', async () => {
    const h = harness({ transactions: [inserted] });

    const result = await triggerDeploy(h.deps, { actor: ACTOR, serviceId: SERVICE_ID });

    expect(result).toEqual({ ok: true, deployment: toDeploymentView(row()) });
    expect(h.enqueue).toHaveBeenCalledWith({
      deploymentId: DEPLOYMENT_ID,
      serviceId: SERVICE_ID,
      actor: ACTOR,
      requestedAt: NOW.toISOString(),
    });
    expect(h.published).toEqual([
      {
        type: 'deployment.updated',
        deployment: { id: DEPLOYMENT_ID, serviceId: SERVICE_ID, status: 'QUEUED', errorCode: null, updatedAt: NOW.toISOString() },
      },
      { type: 'service.updated', service: SERVICE_VIEW },
    ]);
  });

  it('passes a guard failure through without enqueuing', async () => {
    const h = harness({
      transactions: [() => Promise.resolve({ ok: false, code: 'PROJECT_ARCHIVED', message: 'archived' })],
    });

    const result = await triggerDeploy(h.deps, { actor: ACTOR, serviceId: SERVICE_ID });

    expect(result).toMatchObject({ ok: false, code: 'PROJECT_ARCHIVED' });
    expect(h.enqueue).not.toHaveBeenCalled();
    expect(h.published).toEqual([]);
  });

  it('turns the partial unique index violation into DEPLOYMENT_IN_PROGRESS', async () => {
    const violation = Object.assign(new Error('Failed query'), {
      cause: { code: '23505', constraint: 'deployments_service_active_unique_idx' },
    });
    const h = harness({ transactions: [() => Promise.reject(violation)] });

    const result = await triggerDeploy(h.deps, { actor: ACTOR, serviceId: SERVICE_ID });

    expect(result).toMatchObject({ ok: false, code: 'DEPLOYMENT_IN_PROGRESS' });
    expect(h.enqueue).not.toHaveBeenCalled();
  });

  it('rethrows any other database error', async () => {
    const other = Object.assign(new Error('Failed query'), { cause: { code: '23505', constraint: 'other_idx' } });
    const h = harness({ transactions: [() => Promise.reject(other)] });
    await expect(triggerDeploy(h.deps, { actor: ACTOR, serviceId: SERVICE_ID })).rejects.toBe(other);
  });

  describe('H1: enqueue failure after the QUEUED insert', () => {
    const queueDown: DeployEnqueueResult = { ok: false, code: 'QUEUE_UNAVAILABLE', message: 'Job queue is unavailable' };

    it('rolls the insert back and answers a named QUEUE_UNAVAILABLE, publishing nothing', async () => {
      const h = harness({ transactions: [inserted, () => Promise.resolve({ kind: 'rolled_back' })], enqueue: queueDown });

      const result = await triggerDeploy(h.deps, { actor: ACTOR, serviceId: SERVICE_ID });

      expect(result).toEqual({ ok: false, code: 'QUEUE_UNAVAILABLE', message: 'Job queue is unavailable; try again shortly' });
      expect(h.transaction).toHaveBeenCalledTimes(2);
      expect(h.published).toEqual([]);
      expect(h.logger.warn).toHaveBeenCalledWith({ deploymentId: DEPLOYMENT_ID }, expect.any(String));
    });

    it('reports success when the job ran anyway and the deployment already left QUEUED', async () => {
      const moved = toDeploymentView(row({ status: 'PREPARING' }));
      const h = harness({ transactions: [inserted, () => Promise.resolve({ kind: 'moved', deployment: moved })], enqueue: queueDown });

      const result = await triggerDeploy(h.deps, { actor: ACTOR, serviceId: SERVICE_ID });

      expect(result).toEqual({ ok: true, deployment: moved });
    });

    it('answers QUEUE_UNAVAILABLE when the row vanished meanwhile (service deleted)', async () => {
      const h = harness({ transactions: [inserted, () => Promise.resolve({ kind: 'missing' })], enqueue: queueDown });
      await expect(triggerDeploy(h.deps, { actor: ACTOR, serviceId: SERVICE_ID })).resolves.toMatchObject({
        ok: false,
        code: 'QUEUE_UNAVAILABLE',
      });
    });

    it('never crashes when the rollback itself fails: logs without error text and answers 503', async () => {
      const h = harness({
        transactions: [inserted, () => Promise.reject(new Error('connection to postgres://u:pw@db lost'))],
        enqueue: queueDown,
      });

      const result = await triggerDeploy(h.deps, { actor: ACTOR, serviceId: SERVICE_ID });

      expect(result).toMatchObject({ ok: false, code: 'QUEUE_UNAVAILABLE' });
      expect(h.logger.error).toHaveBeenCalledTimes(1);
      expect(JSON.stringify(h.logger.error.mock.calls)).not.toContain('pw@db');
    });
  });
});

describe('DeploymentView never carries secrets', () => {
  it('has no credential-shaped field', () => {
    const view: DeploymentView = toDeploymentView(row());
    for (const key of Object.keys(view)) {
      expect(key).not.toMatch(/token|password|secret|credential|key$/i);
    }
  });
});

// ---------------------------------------------------------------------------------------------
// 17-05: manual rollback
// ---------------------------------------------------------------------------------------------

const id = (n: number): string => `0192f1a4-7b3c-7d2e-8f00-${n.toString().padStart(12, '0')}`;
const HC = { type: 'tcp', port: 3000, probeTimeoutS: 2, intervalS: 5, retries: 3, startPeriodS: 0 } as const;
const runtime = (imageRef: string) => ({ version: 1, imageRef, internalPort: 3000, publishedPort: 8080, healthcheck: HC });

/** A SUCCESS row with a runtime config; `n` orders it (higher is newer). */
function success(n: number, imageRef = `noodara/${SERVICE_ID}:${id(n)}`, overrides: Partial<DeploymentRow> = {}): DeploymentRow {
  return row({
    id: id(n),
    status: 'SUCCESS',
    imageRef,
    runtimeConfig: runtime(imageRef) as DeploymentRow['runtimeConfig'],
    commitSha: 'a'.repeat(40),
    createdAt: new Date(NOW.getTime() + n * 1000),
    ...overrides,
  });
}

describe('planRollback (17-05 A1, A2)', () => {
  const newestFirst = (...rows: DeploymentRow[]) => [...rows].sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());

  it('defaults to the newest retained known-good deployment before the running one', () => {
    const plan = planRollback({ serviceId: SERVICE_ID, retention: 3, successes: newestFirst(success(1), success(2), success(3)) });
    expect(plan).toMatchObject({ ok: true, target: { id: id(2) }, current: { id: id(3) } });
  });

  it('skips a candidate running the same image as the current version', () => {
    // 4 is a rollback to 2: same image as 2, so the default goes to 3.
    const image2 = `noodara/${SERVICE_ID}:${id(2)}`;
    const plan = planRollback({
      serviceId: SERVICE_ID,
      retention: 3,
      successes: newestFirst(success(1), success(2), success(3), success(4, image2, { trigger: 'rollback' })),
    });
    expect(plan).toMatchObject({ ok: true, target: { id: id(3) } });
  });

  it('takes an explicit retained target', () => {
    const plan = planRollback({
      serviceId: SERVICE_ID,
      retention: 3,
      successes: newestFirst(success(1), success(2), success(3)),
      explicit: { id: id(1), row: success(1) },
    });
    expect(plan).toMatchObject({ ok: true, target: { id: id(1) } });
  });

  it('answers 422 not_deployed when the service never had a SUCCESS deployment', () => {
    expect(planRollback({ serviceId: SERVICE_ID, retention: 3, successes: [] })).toMatchObject({
      ok: false,
      code: 'ROLLBACK_TARGET_UNAVAILABLE',
      reason: 'not_deployed',
    });
  });

  it('answers 422 none when only the running version exists', () => {
    expect(planRollback({ serviceId: SERVICE_ID, retention: 3, successes: [success(1)] })).toMatchObject({
      ok: false,
      code: 'ROLLBACK_TARGET_UNAVAILABLE',
      reason: 'none',
    });
  });

  it('answers 422 image_pruned for a known-good target outside the retention window', () => {
    const plan = planRollback({
      serviceId: SERVICE_ID,
      retention: 1,
      successes: newestFirst(success(1), success(2), success(3)),
      explicit: { id: id(1), row: success(1) },
    });
    expect(plan).toMatchObject({ ok: false, code: 'ROLLBACK_TARGET_UNAVAILABLE', reason: 'image_pruned' });
    expect(plan.ok ? '' : plan.message).toContain('image_pruned');
  });

  it.each([
    ['a FAILED target', row({ id: id(1), status: 'FAILED' })],
    ['a SUCCESS target without runtime config (v0.2 row)', row({ id: id(1), status: 'SUCCESS' })],
  ])('answers 422 not_known_good for %s', (_label, target) => {
    const plan = planRollback({
      serviceId: SERVICE_ID,
      retention: 3,
      successes: newestFirst(success(2), success(3)),
      explicit: { id: id(1), row: target },
    });
    expect(plan).toMatchObject({ ok: false, code: 'ROLLBACK_TARGET_UNAVAILABLE', reason: 'not_known_good' });
  });

  it('answers 422 same_as_current for the running deployment or one running the same image', () => {
    const successes = newestFirst(success(1), success(2), success(3, `noodara/${SERVICE_ID}:${id(2)}`));
    expect(planRollback({ serviceId: SERVICE_ID, retention: 3, successes, explicit: { id: id(3), row: successes[0] ?? null } })).toMatchObject({
      reason: 'same_as_current',
    });
    expect(planRollback({ serviceId: SERVICE_ID, retention: 3, successes, explicit: { id: id(2), row: success(2) } })).toMatchObject({
      reason: 'same_as_current',
    });
  });

  it('answers 404 for a target that is missing or belongs to another service (no existence leak)', () => {
    const successes = newestFirst(success(1), success(2));
    const missing = planRollback({ serviceId: SERVICE_ID, retention: 3, successes, explicit: { id: id(9), row: null } });
    const foreign = planRollback({
      serviceId: SERVICE_ID,
      retention: 3,
      successes,
      explicit: { id: id(9), row: success(9, 'x:y', { serviceId: id(77) }) },
    });
    expect(missing).toEqual({ ok: false, code: 'NOT_FOUND', reason: 'none', message: `Deployment "${id(9)}" not found` });
    expect(foreign).toEqual(missing);
  });
});

describe('rollbackFingerprint (17-05 H1)', () => {
  it('is stable for the same request and differs per target', () => {
    expect(rollbackFingerprint(SERVICE_ID, undefined)).toBe(rollbackFingerprint(SERVICE_ID, undefined));
    expect(rollbackFingerprint(SERVICE_ID, id(1))).not.toBe(rollbackFingerprint(SERVICE_ID, undefined));
    expect(rollbackFingerprint(SERVICE_ID, id(1))).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe('triggerRollback (17-05 A1, A2, H1)', () => {
  const rollbackRow = () => row({ trigger: 'rollback', rollbackOfDeploymentId: id(2), previousDeploymentId: id(3) });
  const insertedRollback = () =>
    Promise.resolve({ kind: 'inserted', deployment: toDeploymentView(rollbackRow()), service: SERVICE_VIEW, activityEventId: 'evt-1' });
  const violation = (constraint: string) => Object.assign(new Error('Failed query'), { cause: { code: '23505', constraint } });

  it('enqueues the inserted rollback deployment and publishes after', async () => {
    const h = harness({ transactions: [insertedRollback] });

    const result = await triggerRollback(h.deps, { actor: ACTOR, serviceId: SERVICE_ID });

    expect(result).toEqual({ ok: true, replayed: false, deployment: toDeploymentView(rollbackRow()) });
    expect(h.enqueue).toHaveBeenCalledWith({ deploymentId: DEPLOYMENT_ID, serviceId: SERVICE_ID, actor: ACTOR, requestedAt: NOW.toISOString() });
    expect(h.published.map((event) => event.type)).toEqual(['deployment.updated', 'service.updated']);
  });

  it('replays the original deployment for a reused key and request, without enqueuing again', async () => {
    const original = toDeploymentView(rollbackRow());
    const h = harness({ transactions: [() => Promise.resolve({ kind: 'replay', deployment: original })] });

    const result = await triggerRollback(h.deps, { actor: ACTOR, serviceId: SERVICE_ID, idempotencyKey: 'k-1' });

    expect(result).toEqual({ ok: true, replayed: true, deployment: original });
    expect(h.enqueue).not.toHaveBeenCalled();
    expect(h.published).toEqual([]);
  });

  it('passes a refusal through without enqueuing', async () => {
    const refusal = { ok: false, code: 'ROLLBACK_TARGET_UNAVAILABLE', message: 'm (image_pruned)' } as const;
    const h = harness({ transactions: [() => Promise.resolve({ kind: 'failed', failure: refusal })] });

    await expect(triggerRollback(h.deps, { actor: ACTOR, serviceId: SERVICE_ID })).resolves.toEqual(refusal);
    expect(h.enqueue).not.toHaveBeenCalled();
  });

  it('turns the active-deployment index violation into DEPLOYMENT_IN_PROGRESS (no key)', async () => {
    const h = harness({ transactions: [() => Promise.reject(violation('deployments_service_active_unique_idx'))] });
    await expect(triggerRollback(h.deps, { actor: ACTOR, serviceId: SERVICE_ID })).resolves.toMatchObject({
      ok: false,
      code: 'DEPLOYMENT_IN_PROGRESS',
    });
    expect(h.transaction).toHaveBeenCalledTimes(1);
  });

  it.each(['deployments_service_active_unique_idx', 'deployments_service_idempotency_key_unique_idx'])(
    'replays the concurrent winner on %s when it carries the same key and request',
    async (constraint) => {
      const original = toDeploymentView(rollbackRow());
      const h = harness({
        transactions: [() => Promise.reject(violation(constraint)), () => Promise.resolve({ kind: 'replay', deployment: original })],
      });

      const result = await triggerRollback(h.deps, { actor: ACTOR, serviceId: SERVICE_ID, idempotencyKey: 'k-1' });

      expect(result).toEqual({ ok: true, replayed: true, deployment: original });
      expect(h.enqueue).not.toHaveBeenCalled();
    },
  );

  it('answers DEPLOYMENT_IN_PROGRESS when the concurrent winner used another key', async () => {
    const h = harness({
      transactions: [
        () => Promise.reject(violation('deployments_service_active_unique_idx')),
        () => Promise.resolve({ kind: 'absent' }),
      ],
    });
    await expect(triggerRollback(h.deps, { actor: ACTOR, serviceId: SERVICE_ID, idempotencyKey: 'k-1' })).resolves.toMatchObject({
      code: 'DEPLOYMENT_IN_PROGRESS',
    });
  });

  it('rethrows any other database error', async () => {
    const other = violation('other_idx');
    const h = harness({ transactions: [() => Promise.reject(other)] });
    await expect(triggerRollback(h.deps, { actor: ACTOR, serviceId: SERVICE_ID })).rejects.toBe(other);
  });

  it('undoes the insert and answers QUEUE_UNAVAILABLE when the enqueue fails', async () => {
    const h = harness({
      transactions: [insertedRollback, () => Promise.resolve({ kind: 'rolled_back' })],
      enqueue: { ok: false, code: 'QUEUE_UNAVAILABLE', message: 'down' },
    });
    await expect(triggerRollback(h.deps, { actor: ACTOR, serviceId: SERVICE_ID })).resolves.toMatchObject({
      ok: false,
      code: 'QUEUE_UNAVAILABLE',
    });
    expect(h.published).toEqual([]);
  });
});
