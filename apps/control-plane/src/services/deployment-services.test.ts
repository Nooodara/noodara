import { describe, expect, it, vi } from 'vitest';
import type { Database } from '../db/client.js';
import type { ServerEvent } from '../events/server-event-publisher.js';
import type { DeployEnqueueResult } from '../queue/deploy-queue.js';
import {
  DEPLOYMENT_VIEW_FIELDS,
  sourceSnapshotFromService,
  toDeploymentView,
  triggerDeploy,
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
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

const SERVICE_VIEW = { id: SERVICE_ID, projectId: 'p', environmentId: 'e', serverId: 's', status: 'DEPLOYING' } as unknown as ServiceView;

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
    expect(h.published.map((event) => event.type)).toEqual(['deployment.updated', 'service.updated']);
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
