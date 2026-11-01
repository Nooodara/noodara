import { describe, expect, it, vi } from 'vitest';
import { requestFingerprint } from '@noodara/domain/deployment';
import type { Database } from '../db/client.js';
import type { ServerEvent } from '../events/server-event-publisher.js';
import type { DeployEnqueueResult } from '../queue/deploy-queue.js';
import {
  DEPLOYMENT_VIEW_FIELDS,
  planRollback,
  deployFingerprint,
  expireIdempotencyKeys,
  getDeployment,
  getServiceDeployment,
  IDEMPOTENCY_EXPIRY_BATCH_LIMIT,
  IDEMPOTENCY_KEY_TTL_MS,
  idempotencyCutoff,
  listDeployments,
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

/** 20-07: a trigger answers its deployment with imageRetained; a row that is not SUCCESS is never retained. */
const answered = (view: DeploymentView): DeploymentView => ({ ...view, imageRetained: false });

const inserted = () =>
  Promise.resolve({ kind: 'inserted', deployment: toDeploymentView(row()), service: SERVICE_VIEW, activityEventId: 'evt-1' });

describe('toDeploymentView', () => {
  it('builds the allowlisted wire view with ISO timestamps', () => {
    const view = toDeploymentView(row({ startedAt: NOW, errorCode: 'BUILD_FAILED' }));
    // imageRetained needs the service's retention: the services add it (20-07), toDeploymentView never does.
    expect(Object.keys(view)).toEqual(DEPLOYMENT_VIEW_FIELDS.filter((field) => field !== 'imageRetained'));
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

    expect(result).toEqual({ ok: true, replayed: false, deployment: answered(toDeploymentView(row())) });
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
      transactions: [() => Promise.resolve({ kind: 'failed', failure: { ok: false, code: 'PROJECT_ARCHIVED', message: 'archived' } })],
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

      expect(result).toEqual({ ok: true, replayed: false, deployment: answered(moved) });
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

    expect(result).toEqual({ ok: true, replayed: false, deployment: answered(toDeploymentView(rollbackRow())) });
    expect(h.enqueue).toHaveBeenCalledWith({ deploymentId: DEPLOYMENT_ID, serviceId: SERVICE_ID, actor: ACTOR, requestedAt: NOW.toISOString() });
    expect(h.published.map((event) => event.type)).toEqual(['deployment.updated', 'service.updated']);
  });

  it('replays the original deployment for a reused key and request, without enqueuing again', async () => {
    const original = toDeploymentView(rollbackRow());
    const h = harness({ transactions: [() => Promise.resolve({ kind: 'replay', deployment: original })] });

    const result = await triggerRollback(h.deps, { actor: ACTOR, serviceId: SERVICE_ID, idempotencyKey: 'k-1' });

    expect(result).toEqual({ ok: true, replayed: true, deployment: answered(original) });
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

      expect(result).toEqual({ ok: true, replayed: true, deployment: answered(original) });
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

describe('triggerDeploy Idempotency-Key (18-05 A1, H1, H9)', () => {
  const violation = (constraint: string) => Object.assign(new Error('Failed query'), { cause: { code: '23505', constraint } });

  it('replays the original deployment for a reused key and request, without enqueuing again', async () => {
    const original = toDeploymentView(row({ status: 'BUILDING' }));
    const h = harness({ transactions: [() => Promise.resolve({ kind: 'replay', deployment: original })] });

    const result = await triggerDeploy(h.deps, { actor: ACTOR, serviceId: SERVICE_ID, idempotencyKey: 'k-1' });

    expect(result).toEqual({ ok: true, replayed: true, deployment: answered(original) });
    expect(h.enqueue).not.toHaveBeenCalled();
    expect(h.published).toEqual([]);
  });

  it('answers IDEMPOTENCY_KEY_REUSED when the key was used for another request', async () => {
    const reused = { ok: false, code: 'IDEMPOTENCY_KEY_REUSED', message: 'm' } as const;
    const h = harness({ transactions: [() => Promise.resolve({ kind: 'failed', failure: reused })] });

    await expect(triggerDeploy(h.deps, { actor: ACTOR, serviceId: SERVICE_ID, idempotencyKey: 'k-1' })).resolves.toEqual(reused);
    expect(h.enqueue).not.toHaveBeenCalled();
  });

  it.each(['deployments_service_active_unique_idx', 'deployments_service_idempotency_key_unique_idx'])(
    'H9: replays the concurrent winner on %s instead of a 500',
    async (constraint) => {
      const original = toDeploymentView(row());
      const h = harness({
        transactions: [() => Promise.reject(violation(constraint)), () => Promise.resolve({ kind: 'replay', deployment: original })],
      });

      const result = await triggerDeploy(h.deps, { actor: ACTOR, serviceId: SERVICE_ID, idempotencyKey: 'k-1' });

      expect(result).toEqual({ ok: true, replayed: true, deployment: answered(original) });
      expect(h.enqueue).not.toHaveBeenCalled();
    },
  );

  it('H9: answers DEPLOYMENT_IN_PROGRESS when the winner of a key race is gone or used another key', async () => {
    const h = harness({
      transactions: [
        () => Promise.reject(violation('deployments_service_idempotency_key_unique_idx')),
        () => Promise.resolve({ kind: 'absent' }),
      ],
    });
    await expect(triggerDeploy(h.deps, { actor: ACTOR, serviceId: SERVICE_ID, idempotencyKey: 'k-1' })).resolves.toMatchObject({
      ok: false,
      code: 'DEPLOYMENT_IN_PROGRESS',
    });
  });

  it('runs one bounded expiry pass after a keyed request and survives its failure', async () => {
    const h = harness({ transactions: [inserted, () => Promise.reject(new Error('postgres://u:pw@db down'))] });

    const result = await triggerDeploy(h.deps, { actor: ACTOR, serviceId: SERVICE_ID, idempotencyKey: 'k-1' });

    expect(result).toMatchObject({ ok: true, replayed: false });
    expect(h.transaction).toHaveBeenCalledTimes(2);
    expect(JSON.stringify(h.logger.warn.mock.calls)).not.toContain('pw@db');
  });

  it('runs no expiry pass for an unkeyed request', async () => {
    const h = harness({ transactions: [inserted] });
    await triggerDeploy(h.deps, { actor: ACTOR, serviceId: SERVICE_ID });
    expect(h.transaction).toHaveBeenCalledTimes(1);
  });
});

describe('deployFingerprint (18-05 H1)', () => {
  it('is a SHA-256 hex of the action and service only, stable and distinct per action', () => {
    expect(deployFingerprint('deploy', SERVICE_ID)).toMatch(/^[0-9a-f]{64}$/);
    expect(deployFingerprint('deploy', SERVICE_ID)).toBe(deployFingerprint('deploy', SERVICE_ID));
    expect(deployFingerprint('redeploy', SERVICE_ID)).not.toBe(deployFingerprint('deploy', SERVICE_ID));
    expect(deployFingerprint('deploy', SERVICE_ID)).not.toBe(rollbackFingerprint(SERVICE_ID, undefined));
  });

  it('is the hash of { action, serviceId } only: no actor, key, body or secret is stored', () => {
    expect(deployFingerprint('deploy', SERVICE_ID)).toBe(requestFingerprint({ action: 'deploy', serviceId: SERVICE_ID }));
  });

  it('23-04 H1: excludes env values: a variable or secret change never changes the fingerprint', () => {
    // The fingerprint takes the action and the service only; the env is read by the worker.
    expect(deployFingerprint.length).toBe(2);
    expect(rollbackFingerprint.length).toBe(2);
    expect(rollbackFingerprint(SERVICE_ID, undefined)).toBe(
      requestFingerprint({ action: 'rollback', serviceId: SERVICE_ID, targetDeploymentId: null }),
    );
  });
});

describe('idempotency expiry (18-05 H1)', () => {
  it('keeps a key for exactly 24 h', () => {
    expect(IDEMPOTENCY_KEY_TTL_MS).toBe(24 * 60 * 60 * 1000);
    expect(idempotencyCutoff(NOW).toISOString()).toBe('2026-10-03T12:00:00.000Z');
  });

  function expiryDb(ids: string[]) {
    const limit = vi.fn();
    const forLock = vi.fn(() => Promise.resolve(ids.map((value) => ({ id: value }))));
    const set = vi.fn(() => ({ where: () => Promise.resolve() }));
    const tx = {
      select: () => ({ from: () => ({ where: () => ({ orderBy: () => ({ limit: (n: number) => (limit(n), { for: forLock }) }) }) }) }),
      update: () => ({ set }),
    };
    const db = { transaction: (fn: (t: unknown) => Promise<number>) => fn(tx) } as unknown as Database;
    return { db, limit, forLock, set };
  }

  it('releases at most the batch limit, skipping locked rows, and nulls key and fingerprint', async () => {
    const f = expiryDb([id(1), id(2)]);
    await expect(expireIdempotencyKeys({ db: f.db, now: () => NOW }, 10_000)).resolves.toBe(2);
    expect(f.limit).toHaveBeenCalledWith(IDEMPOTENCY_EXPIRY_BATCH_LIMIT);
    expect(f.forLock).toHaveBeenCalledWith('update', { skipLocked: true });
    expect(f.set).toHaveBeenCalledWith({ idempotencyKey: null, requestFingerprint: null });
  });

  it('writes nothing when no key expired', async () => {
    const f = expiryDb([]);
    await expect(expireIdempotencyKeys({ db: f.db, now: () => NOW }, 0)).resolves.toBe(0);
    expect(f.limit).toHaveBeenCalledWith(1);
    expect(f.set).not.toHaveBeenCalled();
  });
});

/** A db whose n-th select() resolves to results[n]; every chain method returns the chain. */
function fakeDb(results: unknown[][]): Pick<Database, 'select'> {
  let call = 0;
  const select = vi.fn((): unknown => {
    const result = results[call++] ?? [];
    const chain: Record<string, unknown> = {};
    for (const method of ['from', 'where', 'orderBy', 'limit']) chain[method] = () => chain;
    chain.then = (resolve: (value: unknown) => unknown) => resolve(result);
    return chain;
  });
  return { select } as unknown as Pick<Database, 'select'>;
}

describe('listDeployments imageRetained (19-04 H2)', () => {
  it('flags only successful rows whose image planRollback would still retain', async () => {
    const at = (minutes: number) => new Date(NOW.getTime() - minutes * 60_000);
    const a = row({ id: id(1), status: 'SUCCESS', imageRef: 'img:a', createdAt: at(1) });
    const b = row({ id: id(2), status: 'SUCCESS', imageRef: 'img:b', createdAt: at(2) });
    const c = row({ id: id(3), status: 'SUCCESS', imageRef: 'img:c', createdAt: at(3) });
    const failed = row({ id: id(4), status: 'FAILED', imageRef: 'img:b', createdAt: at(4) });
    const db = fakeDb([[{ id: SERVICE_ID }], [a, b, c, failed], [a, b, c], [{ retention: 1 }]]);

    const page = await listDeployments({ db } as Pick<DeploymentServicesDeps, 'db'>, SERVICE_ID, { limit: 10 });

    expect(page?.items.map((item) => item.imageRetained)).toEqual([true, true, false, false]);
  });
});

describe('every deployment response carries imageRetained (20-07)', () => {
  const at = (minutes: number) => new Date(NOW.getTime() - minutes * 60_000);
  const success = (n: number, imageRef: string, minutes: number) =>
    row({ id: id(n), status: 'SUCCESS', imageRef, createdAt: at(minutes), updatedAt: at(minutes) });
  /** retainedImageRefs reads the SUCCESS rows newest first, then the service's retention. */
  const retentionReads = (successes: DeploymentRow[], retention: number): unknown[][] => [successes, [{ retention }]];

  it('triggerDeploy answers the full wire view, imageRetained false for the new QUEUED row', async () => {
    const h = harness({ transactions: [inserted] });

    const result = await triggerDeploy(h.deps, { actor: ACTOR, serviceId: SERVICE_ID, action: 'redeploy' });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(Object.keys(result.deployment)).toEqual([...DEPLOYMENT_VIEW_FIELDS]);
    expect(result.deployment.imageRetained).toBe(false);
  });

  it('triggerRollback answers the full wire view, imageRetained false for the new QUEUED row', async () => {
    const queuedRollback = toDeploymentView(row({ trigger: 'rollback', imageRef: 'img:a', rollbackOfDeploymentId: id(2) }));
    const h = harness({
      transactions: [() => Promise.resolve({ kind: 'inserted', deployment: queuedRollback, service: SERVICE_VIEW, activityEventId: 'evt-1' })],
    });

    const result = await triggerRollback(h.deps, { actor: ACTOR, serviceId: SERVICE_ID });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(Object.keys(result.deployment)).toEqual([...DEPLOYMENT_VIEW_FIELDS]);
    expect(result.deployment.imageRetained).toBe(false);
  });

  it('a replayed deployment that has since succeeded reports its image by the retention rule', async () => {
    const newest = success(1, 'img:b', 1);
    const original = success(2, 'img:a', 2);
    const h = harness({ transactions: [() => Promise.resolve({ kind: 'replay', deployment: toDeploymentView(original) })] });
    const db = fakeDb(retentionReads([newest, original], 2));
    const deps = { ...h.deps, db: { transaction: h.transaction, select: db.select } as unknown as Database };

    const result = await triggerDeploy(deps, { actor: ACTOR, serviceId: SERVICE_ID, idempotencyKey: 'k-1' });

    expect(result).toMatchObject({ ok: true, replayed: true, deployment: { id: id(2), imageRetained: true } });
    if (result.ok) expect(Object.keys(result.deployment)).toEqual([...DEPLOYMENT_VIEW_FIELDS]);
  });

  it('a replayed rollback whose image fell out of retention reports false', async () => {
    const oldest = success(3, 'img:a', 3);
    const rows = [success(1, 'img:c', 1), success(2, 'img:b', 2), oldest];
    const h = harness({ transactions: [() => Promise.resolve({ kind: 'replay', deployment: toDeploymentView(oldest) })] });
    const db = fakeDb(retentionReads(rows, 1));
    const deps = { ...h.deps, db: { transaction: h.transaction, select: db.select } as unknown as Database };

    const result = await triggerRollback(deps, { actor: ACTOR, serviceId: SERVICE_ID, idempotencyKey: 'k-1' });

    expect(result).toMatchObject({ ok: true, replayed: true, deployment: { id: id(3), imageRetained: false } });
  });

  it('getDeployment and getServiceDeployment flag a retained SUCCESS row in wire order', async () => {
    const oldest = success(3, 'img:a', 3);
    const rows = [success(1, 'img:c', 1), success(2, 'img:b', 2), oldest];

    const byId = await getDeployment({ db: fakeDb([[oldest], ...retentionReads(rows, 3)]) as Database }, id(3));
    const scoped = await getServiceDeployment({ db: fakeDb([[oldest], ...retentionReads(rows, 1)]) as Database }, SERVICE_ID, id(3));

    expect(byId && Object.keys(byId)).toEqual([...DEPLOYMENT_VIEW_FIELDS]);
    expect(byId?.imageRetained).toBe(true);
    expect(scoped?.imageRetained).toBe(false);
  });

  it('a row that is not SUCCESS is never retained and reads no retention', async () => {
    const db = fakeDb([[row({ status: 'FAILED', imageRef: 'img:a' })]]);

    const view = await getDeployment({ db: db as Database }, DEPLOYMENT_ID);

    expect(view?.imageRetained).toBe(false);
    expect(db.select).toHaveBeenCalledTimes(1);
  });

  it('a missing deployment is still null', async () => {
    await expect(getDeployment({ db: fakeDb([[]]) as Database }, DEPLOYMENT_ID)).resolves.toBeNull();
    await expect(getServiceDeployment({ db: fakeDb([[]]) as Database }, SERVICE_ID, DEPLOYMENT_ID)).resolves.toBeNull();
  });

  it('listDeployments items keep the wire order', async () => {
    const only = success(1, 'img:a', 1);
    const page = await listDeployments({ db: fakeDb([[{ id: SERVICE_ID }], [only], ...retentionReads([only], 1)]) as Database }, SERVICE_ID, {
      limit: 10,
    });
    expect(page?.items.map((item) => Object.keys(item))).toEqual([[...DEPLOYMENT_VIEW_FIELDS]]);
  });
});
