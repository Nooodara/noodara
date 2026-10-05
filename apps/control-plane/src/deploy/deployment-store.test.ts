import { describe, expect, it } from 'vitest';
import type { CommitSha } from '@noodara/domain/validators';
import type { Database } from '../db/client.js';
import { activityEvents } from '../db/schema/activity-events.js';
import { deployments } from '../db/schema/deployments.js';
import { services } from '../db/schema/services.js';
import type { ServerEvent } from '../events/server-event-publisher.js';
import type { DeploymentRow } from '../services/deployment-services.js';
import { createDeploymentStore, DeploymentConflictError, type FinishDeploymentInput } from './deployment-store.js';
import { DEPLOY_MESSAGES } from './run-deployment.js';

const SERVICE_ID = '0192f1a4-7b3c-7d2e-8f00-00000000bbbb';
const DEPLOYMENT_ID = '0192f1a4-7b3c-7d2e-8f00-00000000cccc';
const CREATED = new Date('2026-10-05T10:00:00.000Z');
const STARTED = new Date('2026-10-05T10:00:02.000Z');
const NOW = new Date('2026-10-05T10:01:00.000Z');
const SHA = 'a'.repeat(40) as CommitSha;

type ServiceRowFull = typeof services.$inferSelect;

function deploymentRow(overrides: Partial<DeploymentRow> = {}): DeploymentRow {
  return {
    id: DEPLOYMENT_ID,
    serviceId: SERVICE_ID,
    status: 'QUEUED',
    trigger: 'manual',
    triggeredBy: null,
    source: {
      sourceType: 'git',
      repositoryUrl: 'https://github.com/acme/api.git',
      branch: 'main',
      buildContext: '.',
      dockerfilePath: 'Dockerfile',
      buildTarget: null,
      imageRef: null,
      internalPort: 3000,
      publishedPort: 8080,
    },
    commitSha: null,
    previousDeploymentId: null,
    startedAt: null,
    completedAt: null,
    durationMs: null,
    errorCode: null,
    errorMessage: null,
    createdAt: CREATED,
    updatedAt: CREATED,
    ...overrides,
  };
}

function serviceRow(overrides: Partial<ServiceRowFull> = {}): ServiceRowFull {
  return {
    id: SERVICE_ID,
    projectId: '0192f1a4-7b3c-7d2e-8f00-00000000aaa1',
    environmentId: '0192f1a4-7b3c-7d2e-8f00-00000000aaa2',
    serverId: '0192f1a4-7b3c-7d2e-8f00-00000000aaa3',
    name: 'api',
    sourceType: 'git',
    repositoryUrl: 'https://github.com/acme/api.git',
    branch: 'main',
    buildContext: '.',
    dockerfilePath: 'Dockerfile',
    buildTarget: null,
    imageRef: null,
    internalPort: 3000,
    publishedPort: 8080,
    repositoryCredentialId: null,
    registryCredentialId: null,
    status: 'RUNNING',
    createdAt: CREATED,
    updatedAt: CREATED,
    ...overrides,
  };
}

interface Op {
  readonly root: 'select' | 'update' | 'insert' | 'delete';
  readonly table: unknown;
  readonly inTx: boolean;
  readonly calls: { method: string; args: unknown[] }[];
}

/** A recording, thenable query-builder fake: every chain is one op; awaiting it answers from the
 *  in-memory rows. Conditional updates can be forced to match nothing with `updateMisses`. */
function fakeDb(state: { deployment: DeploymentRow | null; service: ServiceRowFull | null; updateMisses?: boolean; failActivity?: boolean }) {
  const ops: Op[] = [];
  let inTx = false;
  const tableOf = (op: Op): unknown => op.table ?? op.calls.find((c) => c.method === 'from')?.args[0];
  const setOf = (op: Op): Record<string, unknown> =>
    (op.calls.find((c) => c.method === 'set')?.args[0] ?? {}) as Record<string, unknown>;
  const respond = (op: Op): unknown[] => {
    const table = tableOf(op);
    if (op.root === 'insert' && table === activityEvents) {
      if (state.failActivity) throw new Error('insert failed: postgres://noodara:pw@db:5432');
      return [{ id: 'activity-1' }];
    }
    if (table === deployments) {
      if (op.root === 'select') return state.deployment ? [state.deployment] : [];
      if (op.root === 'update') {
        if (state.updateMisses || !state.deployment) return [];
        state.deployment = { ...state.deployment, ...setOf(op) };
        return [state.deployment];
      }
    }
    if (table === services) {
      if (op.root === 'select') return state.service ? [state.service] : [];
      if (op.root === 'update' && state.service) {
        state.service = { ...state.service, ...setOf(op) };
        return [state.service];
      }
    }
    return [];
  };
  const start = (root: Op['root'], table: unknown): unknown => {
    const op: Op = { root, table, inTx, calls: [] };
    ops.push(op);
    const proxy: unknown = new Proxy(
      {},
      {
        get(_target, prop) {
          if (prop === 'then') {
            return (resolve: (v: unknown) => void, reject: (e: unknown) => void) => {
              try {
                resolve(respond(op));
              } catch (error) {
                reject(error);
              }
            };
          }
          return (...args: unknown[]) => {
            op.calls.push({ method: String(prop), args });
            return proxy;
          };
        },
      },
    );
    return proxy;
  };
  const handle = {
    select: () => start('select', undefined),
    update: (table: unknown) => start('update', table),
    insert: (table: unknown) => start('insert', table),
    delete: (table: unknown) => start('delete', table),
    transaction: async <T>(fn: (tx: unknown) => Promise<T>): Promise<T> => {
      inTx = true;
      try {
        return await fn(handle);
      } finally {
        inTx = false;
      }
    },
  };
  return { db: handle as unknown as Database, ops, state, tableOf, setOf };
}

function harness(state: Parameters<typeof fakeDb>[0]) {
  const fake = fakeDb(state);
  const published: ServerEvent[] = [];
  const store = createDeploymentStore({
    db: fake.db,
    now: () => NOW,
    events: { publish: (event) => Promise.resolve(void published.push(event)) },
  });
  return { ...fake, published, store };
}

const finishInput = (overrides: Partial<FinishDeploymentInput> = {}): FinishDeploymentInput => ({
  status: 'SUCCESS',
  errorCode: null,
  errorMessage: null,
  commitSha: SHA,
  container: { kind: 'running' },
  ...overrides,
});

describe('deployment store: claim (C3, H1)', () => {
  it('moves QUEUED to PREPARING under a row lock inside one transaction and stamps startedAt', async () => {
    const h = harness({ deployment: deploymentRow(), service: serviceRow() });

    const claimed = await h.store.claim(DEPLOYMENT_ID);

    expect(claimed).toMatchObject({ id: DEPLOYMENT_ID, status: 'PREPARING', startedAt: NOW });
    const [select, update] = h.ops;
    if (!update) throw new Error('expected an update');
    expect(select?.inTx).toBe(true);
    expect(select?.calls).toContainEqual({ method: 'for', args: ['update'] });
    expect(update.inTx).toBe(true);
    expect(h.setOf(update)).toMatchObject({ status: 'PREPARING', startedAt: NOW, updatedAt: NOW });
    expect(h.published).toEqual([
      { type: 'deployment.updated', deployment: { id: DEPLOYMENT_ID, serviceId: SERVICE_ID, status: 'PREPARING', errorCode: null } },
    ]);
  });

  it.each(['PREPARING', 'BUILDING', 'DEPLOYING', 'SUCCESS', 'FAILED', 'CANCELLED'] as const)(
    'returns null and writes nothing for a re-delivered job already at %s',
    async (status) => {
      const h = harness({ deployment: deploymentRow({ status }), service: serviceRow() });
      expect(await h.store.claim(DEPLOYMENT_ID)).toBeNull();
      expect(h.ops.filter((op) => op.root !== 'select')).toEqual([]);
      expect(h.published).toEqual([]);
    },
  );

  it('returns null for a missing deployment', async () => {
    const h = harness({ deployment: null, service: null });
    expect(await h.store.claim(DEPLOYMENT_ID)).toBeNull();
  });
});

describe('deployment store: progress (C1)', () => {
  it('advances only along a state-machine edge with a conditional update and publishes it', async () => {
    const h = harness({ deployment: deploymentRow({ status: 'PREPARING', startedAt: STARTED }), service: serviceRow() });

    await h.store.progress(DEPLOYMENT_ID).advance('PREPARING', 'BUILDING');

    expect(h.state.deployment?.status).toBe('BUILDING');
    expect(h.published.at(-1)).toMatchObject({ type: 'deployment.updated', deployment: { status: 'BUILDING' } });
  });

  it('rejects an edge the state machine does not allow before touching the database', async () => {
    const h = harness({ deployment: deploymentRow({ status: 'PREPARING' }), service: serviceRow() });
    await expect(h.store.progress(DEPLOYMENT_ID).advance('PREPARING', 'SUCCESS')).rejects.toThrow(/Invalid deployment transition/);
    expect(h.ops).toEqual([]);
  });

  it('throws a conflict when the row is no longer at the expected status', async () => {
    const h = harness({ deployment: deploymentRow({ status: 'CANCELLED' }), service: serviceRow(), updateMisses: true });
    await expect(h.store.progress(DEPLOYMENT_ID).advance('BUILDING', 'DEPLOYING')).rejects.toBeInstanceOf(DeploymentConflictError);
    expect(h.published).toEqual([]);
  });

  it('records the commit SHA', async () => {
    const h = harness({ deployment: deploymentRow({ status: 'PREPARING' }), service: serviceRow() });
    await h.store.progress(DEPLOYMENT_ID).recordCommitSha(SHA);
    expect(h.state.deployment?.commitSha).toBe(SHA);
  });
});

describe('deployment store: finish (C3, ERR)', () => {
  it('ends SUCCESS with duration, service status cache, activity event and both events', async () => {
    const h = harness({ deployment: deploymentRow({ status: 'DEPLOYING', startedAt: STARTED }), service: serviceRow({ status: 'NEVER_DEPLOYED' }) });

    const view = await h.store.finish(DEPLOYMENT_ID, finishInput());

    expect(view).toMatchObject({ status: 'SUCCESS', commitSha: SHA, durationMs: 58_000, errorCode: null, errorMessage: null });
    expect(h.state.deployment).toMatchObject({ completedAt: NOW, durationMs: 58_000 });
    expect(h.state.service?.status).toBe('RUNNING');
    const activity = h.ops.find((op) => op.root === 'insert' && op.table === activityEvents);
    expect(activity?.inTx).toBe(true);
    expect(activity?.calls.find((c) => c.method === 'values')?.args[0]).toMatchObject({
      actorType: 'system',
      entityType: 'deployment',
      entityId: DEPLOYMENT_ID,
      action: 'deployment.finished',
      outcome: 'success',
      metadata: { serviceId: SERVICE_ID, status: 'SUCCESS', durationMs: 58_000, commitSha: SHA },
    });
    expect(h.published).toEqual([
      { type: 'deployment.updated', deployment: { id: DEPLOYMENT_ID, serviceId: SERVICE_ID, status: 'SUCCESS', errorCode: null } },
      { type: 'service.updated', service: expect.objectContaining({ id: SERVICE_ID, status: 'RUNNING' }) as unknown },
    ]);
  });

  it('a failed build keeps the service RUNNING from the cache when the container was never touched', async () => {
    const h = harness({ deployment: deploymentRow({ status: 'BUILDING', startedAt: STARTED }), service: serviceRow({ status: 'RUNNING' }) });

    await h.store.finish(
      DEPLOYMENT_ID,
      finishInput({ status: 'FAILED', errorCode: 'BUILD_FAILED', errorMessage: 'The Docker build failed.', commitSha: null, container: null }),
    );

    expect(h.state.deployment).toMatchObject({ status: 'FAILED', errorCode: 'BUILD_FAILED', errorMessage: 'The Docker build failed.' });
    expect(h.state.service?.status).toBe('RUNNING');
    const values = h.ops.find((op) => op.table === activityEvents)?.calls.find((c) => c.method === 'values')?.args[0];
    expect(values).toMatchObject({ outcome: 'failure', errorCode: 'BUILD_FAILED' });
  });

  it('a container that stopped after a failed start caches FAILED', async () => {
    const h = harness({ deployment: deploymentRow({ status: 'DEPLOYING', startedAt: STARTED }), service: serviceRow({ status: 'RUNNING' }) });
    await h.store.finish(
      DEPLOYMENT_ID,
      finishInput({ status: 'FAILED', errorCode: 'START_FAILED', errorMessage: 'stopped', container: { kind: 'stopped', exitCode: 1 } }),
    );
    expect(h.state.service?.status).toBe('FAILED');
  });

  it('a FAILED outcome without a code is stored as WORKER_CRASHED with its fixed message', async () => {
    const h = harness({ deployment: deploymentRow({ status: 'PREPARING', startedAt: STARTED }), service: serviceRow() });
    await h.store.finish(DEPLOYMENT_ID, finishInput({ status: 'FAILED', errorCode: null, errorMessage: null, container: null }));
    expect(h.state.deployment).toMatchObject({ errorCode: 'WORKER_CRASHED', errorMessage: DEPLOY_MESSAGES.WORKER_CRASHED });
  });

  it('CANCELLED stores no error code and keeps an earlier recorded SHA', async () => {
    const h = harness({ deployment: deploymentRow({ status: 'BUILDING', startedAt: STARTED, commitSha: SHA }), service: serviceRow() });
    await h.store.finish(DEPLOYMENT_ID, finishInput({ status: 'CANCELLED', errorCode: 'BUILD_FAILED', errorMessage: 'x', commitSha: null, container: null }));
    expect(h.state.deployment).toMatchObject({ status: 'CANCELLED', errorCode: null, errorMessage: null, commitSha: SHA });
  });

  it('is idempotent: an already terminal deployment is left alone and nothing is published', async () => {
    const h = harness({ deployment: deploymentRow({ status: 'SUCCESS' }), service: serviceRow() });
    expect(await h.store.finish(DEPLOYMENT_ID, finishInput())).toBeNull();
    expect(h.ops.filter((op) => op.root !== 'select')).toEqual([]);
    expect(h.published).toEqual([]);
  });

  it('refuses to finish a deployment that was never claimed (QUEUED has no FAILED edge)', async () => {
    const h = harness({ deployment: deploymentRow({ status: 'QUEUED' }), service: serviceRow() });
    await expect(h.store.finish(DEPLOYMENT_ID, finishInput({ status: 'FAILED', errorCode: 'WORKER_CRASHED' }))).rejects.toThrow(
      /Invalid deployment transition/,
    );
    expect(h.published).toEqual([]);
  });

  it('caps the stored error message', async () => {
    const h = harness({ deployment: deploymentRow({ status: 'BUILDING', startedAt: STARTED }), service: serviceRow() });
    await h.store.finish(DEPLOYMENT_ID, finishInput({ status: 'FAILED', errorCode: 'BUILD_FAILED', errorMessage: 'x'.repeat(5000), container: null }));
    expect(h.state.deployment?.errorMessage?.length).toBeLessThanOrEqual(1024);
  });

  it('publishes nothing when the transaction fails', async () => {
    const h = harness({ deployment: deploymentRow({ status: 'DEPLOYING', startedAt: STARTED }), service: serviceRow(), failActivity: true });
    await expect(h.store.finish(DEPLOYMENT_ID, finishInput())).rejects.toThrow();
    expect(h.published).toEqual([]);
  });
});
