import { describe, expect, it } from 'vitest';
import { deriveDeploymentSteps } from '@noodara/domain/deployment';
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
    buildingStartedAt: null,
    deployingStartedAt: null,
    verifyingStartedAt: null,
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
      {
        type: 'deployment.updated',
        deployment: { id: DEPLOYMENT_ID, serviceId: SERVICE_ID, status: 'PREPARING', errorCode: null, updatedAt: NOW.toISOString() },
      },
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

describe('deployment store: step boundaries (13-03 A2, H1)', () => {
  const stepsOf = (row: DeploymentRow | null) => {
    if (!row) throw new Error('row missing');
    return deriveDeploymentSteps({ ...row, sourceType: 'git' }).map((s) => s.state);
  };
  const at = <T,>(items: readonly T[], index: number): T => {
    const item = items[index];
    if (item === undefined) throw new Error(`no item at ${String(index)}`);
    return item;
  };

  it('writes each status edge and its step boundary in one UPDATE', async () => {
    const h = harness({ deployment: deploymentRow({ status: 'PREPARING', startedAt: STARTED }), service: serviceRow() });
    const progress = h.store.progress(DEPLOYMENT_ID);

    await progress.advance('PREPARING', 'BUILDING');
    const building = h.ops.filter((op) => op.root === 'update');
    expect(building).toHaveLength(1);
    expect(h.setOf(at(building, 0))).toMatchObject({ status: 'BUILDING', buildingStartedAt: NOW });

    await progress.advance('BUILDING', 'DEPLOYING');
    const updates = h.ops.filter((op) => op.root === 'update');
    expect(updates).toHaveLength(2);
    expect(h.setOf(at(updates, 1))).toMatchObject({ status: 'DEPLOYING', deployingStartedAt: NOW });
    expect(h.setOf(at(updates, 1))).not.toHaveProperty('buildingStartedAt');
    expect(stepsOf(h.state.deployment)).toEqual(['success', 'success', 'running', 'pending']);
  });

  it('enters verify with one conditional UPDATE while DEPLOYING and publishes it', async () => {
    const h = harness({ deployment: deploymentRow({ status: 'DEPLOYING', startedAt: STARTED }), service: serviceRow() });
    await h.store.progress(DEPLOYMENT_ID).enterVerify();
    const updates = h.ops.filter((op) => op.root === 'update');
    expect(updates).toHaveLength(1);
    expect(h.setOf(at(updates, 0))).toMatchObject({ verifyingStartedAt: NOW });
    expect(h.setOf(at(updates, 0))).not.toHaveProperty('status');
    expect(updates[0]?.inTx).toBe(true);
    expect(h.published.at(-1)).toMatchObject({ type: 'deployment.updated', deployment: { status: 'DEPLOYING' } });
    expect(stepsOf(h.state.deployment)).toEqual(['success', 'success', 'success', 'running']);
  });

  it.each(['SUCCESS', 'FAILED', 'CANCELLED', 'BUILDING'] as const)('never enters verify on a %s row', async (status) => {
    const h = harness({ deployment: deploymentRow({ status, startedAt: STARTED }), service: serviceRow() });
    await h.store.progress(DEPLOYMENT_ID).enterVerify();
    expect(h.ops.filter((op) => op.root === 'update')).toEqual([]);
    expect(h.published).toEqual([]);
  });

  it('enters verify once', async () => {
    const h = harness({ deployment: deploymentRow({ status: 'DEPLOYING', verifyingStartedAt: STARTED }), service: serviceRow() });
    await h.store.progress(DEPLOYMENT_ID).enterVerify();
    expect(h.ops.filter((op) => op.root === 'update')).toEqual([]);
  });

  it('a missing row records nothing', async () => {
    const h = harness({ deployment: null, service: null });
    await h.store.progress(DEPLOYMENT_ID).enterVerify();
    expect(h.published).toEqual([]);
  });

  it('a concurrent cancel and success leave one terminal status and no running step', async () => {
    const h = harness({
      deployment: deploymentRow({ status: 'DEPLOYING', startedAt: STARTED, buildingStartedAt: STARTED, deployingStartedAt: STARTED }),
      service: serviceRow(),
    });
    const progress = h.store.progress(DEPLOYMENT_ID);
    const cancelled = await h.store.finish(DEPLOYMENT_ID, finishInput({ status: 'CANCELLED', container: null }));
    const succeeded = await h.store.finish(DEPLOYMENT_ID, finishInput());
    await progress.enterVerify();

    expect(cancelled?.status).toBe('CANCELLED');
    expect(succeeded).toBeNull();
    expect(h.state.deployment?.status).toBe('CANCELLED');
    expect(h.state.deployment?.verifyingStartedAt).toBeNull();
    expect(stepsOf(h.state.deployment)).toEqual(['success', 'success', 'cancelled', 'pending']);
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
      {
        type: 'deployment.updated',
        deployment: { id: DEPLOYMENT_ID, serviceId: SERVICE_ID, status: 'SUCCESS', errorCode: null, updatedAt: NOW.toISOString() },
      },
      {
        type: 'service.updated',
        service: expect.objectContaining({ id: SERVICE_ID, status: 'RUNNING', updatedAt: NOW.toISOString() }) as unknown,
      },
    ]);
    // A1: the service row's updated_at is written in the same transaction as its status cache.
    const serviceWrite = h.ops.find((op) => op.root === 'update' && op.table === services);
    if (!serviceWrite) throw new Error('expected a services status-cache write');
    expect(serviceWrite.inTx).toBe(true);
    expect(h.setOf(serviceWrite)).toEqual({ status: 'RUNNING', updatedAt: NOW });
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

describe('deployment store: updatedAt on events (13-02 A1, H1)', () => {
  const updatedAtOf = (event: ServerEvent | undefined): string | undefined =>
    event?.type === 'deployment.updated' ? event.deployment.updatedAt : event?.type === 'service.updated' ? event.service.updatedAt : undefined;

  it('each event carries the updatedAt written by its own transaction', async () => {
    const h = harness({ deployment: deploymentRow(), service: serviceRow() });
    await h.store.claim(DEPLOYMENT_ID);
    expect(updatedAtOf(h.published.at(-1))).toBe(h.state.deployment?.updatedAt.toISOString());
    await h.store.progress(DEPLOYMENT_ID).advance('PREPARING', 'BUILDING');
    expect(updatedAtOf(h.published.at(-1))).toBe(h.state.deployment?.updatedAt.toISOString());
  });

  it('rapid writes with a frozen clock publish strictly increasing updatedAt per deployment and service', async () => {
    // Every write lands in the same millisecond as the row's stored updated_at.
    const h = harness({
      deployment: deploymentRow({ updatedAt: NOW, createdAt: NOW }),
      service: serviceRow({ updatedAt: NOW }),
    });
    await h.store.claim(DEPLOYMENT_ID);
    const progress = h.store.progress(DEPLOYMENT_ID);
    await progress.advance('PREPARING', 'BUILDING');
    await progress.recordCommitSha(SHA);
    await progress.advance('BUILDING', 'DEPLOYING');
    await h.store.finish(DEPLOYMENT_ID, finishInput());

    const deploymentTimes = h.published.filter((e) => e.type === 'deployment.updated').map(updatedAtOf);
    const serviceTimes = h.published.filter((e) => e.type === 'service.updated').map(updatedAtOf);
    expect(deploymentTimes).toEqual([
      '2026-10-05T10:01:00.001Z',
      '2026-10-05T10:01:00.002Z',
      '2026-10-05T10:01:00.004Z',
      '2026-10-05T10:01:00.005Z',
    ]);
    expect(serviceTimes).toEqual(['2026-10-05T10:01:00.001Z']);
  });

  it('a clock that steps back never publishes an older updatedAt', async () => {
    const later = new Date(NOW.getTime() + 60_000);
    const h = harness({ deployment: deploymentRow({ status: 'PREPARING', updatedAt: later }), service: serviceRow({ updatedAt: later }) });
    await h.store.progress(DEPLOYMENT_ID).advance('PREPARING', 'BUILDING');
    expect(updatedAtOf(h.published.at(-1))).toBe(new Date(later.getTime() + 1).toISOString());
  });

  it('progress writes under the row lock inside one transaction', async () => {
    const h = harness({ deployment: deploymentRow({ status: 'PREPARING' }), service: serviceRow() });
    await h.store.progress(DEPLOYMENT_ID).advance('PREPARING', 'BUILDING');
    const [lock, update] = h.ops;
    expect(lock?.inTx).toBe(true);
    expect(lock?.calls).toContainEqual({ method: 'for', args: ['update'] });
    expect(update?.inTx).toBe(true);
  });

  it('the deployment event never carries errorMessage or the source snapshot (H1)', async () => {
    const h = harness({ deployment: deploymentRow({ status: 'BUILDING', startedAt: STARTED }), service: serviceRow() });
    await h.store.finish(DEPLOYMENT_ID, finishInput({ status: 'FAILED', errorCode: 'BUILD_FAILED', errorMessage: 'The Docker build failed.', container: null }));
    const event = h.published.find((e) => e.type === 'deployment.updated');
    expect(event?.type === 'deployment.updated' ? Object.keys(event.deployment) : []).toEqual([
      'id',
      'serviceId',
      'status',
      'errorCode',
      'updatedAt',
    ]);
  });
});

describe('deployment store: cancel (12-13 A1, H1, H2)', () => {
  const ACTOR = { type: 'user', id: '0192f1a4-7b3c-7d2e-8f00-00000000dddd' } as const;
  const activityValues = (h: ReturnType<typeof harness>): unknown[] =>
    h.ops
      .filter((op) => op.root === 'insert' && op.table === activityEvents)
      .map((op) => op.calls.find((c) => c.method === 'values')?.args[0]);

  it('a QUEUED deployment ends CANCELLED under the row lock, with both events, in one transaction (A1)', async () => {
    const h = harness({ deployment: deploymentRow({ status: 'QUEUED' }), service: serviceRow({ status: 'RUNNING' }) });

    const result = await h.store.requestCancel(DEPLOYMENT_ID, ACTOR);

    expect(result).toMatchObject({ kind: 'cancelled', deployment: { status: 'CANCELLED', errorCode: null } });
    expect(h.state.deployment).toMatchObject({ status: 'CANCELLED', completedAt: NOW });
    const lock = h.ops.find((op) => op.root === 'select');
    expect(lock?.inTx).toBe(true);
    expect(lock?.calls.some((c) => c.method === 'for' && c.args[0] === 'update')).toBe(true);
    expect(activityValues(h)).toEqual([
      expect.objectContaining({ actorType: 'user', actorId: ACTOR.id, action: 'deployment.cancel_requested', metadata: { serviceId: SERVICE_ID, status: 'QUEUED' } }),
      expect.objectContaining({ actorType: 'system', action: 'deployment.finished', outcome: 'failure', metadata: expect.objectContaining({ status: 'CANCELLED' }) as unknown }),
    ]);
    expect(h.published.map((event) => event.type)).toEqual(['deployment.updated', 'service.updated']);
  });

  it.each(['PREPARING', 'BUILDING', 'DEPLOYING'] as const)('a %s deployment is reported running and left to its worker (A2)', async (status) => {
    const h = harness({ deployment: deploymentRow({ status, startedAt: STARTED }), service: serviceRow() });

    const result = await h.store.requestCancel(DEPLOYMENT_ID, ACTOR);

    expect(result).toMatchObject({ kind: 'running', deployment: { status } });
    expect(h.ops.filter((op) => op.root !== 'select')).toEqual([]);
    expect(h.published).toEqual([]);
  });

  it.each(['SUCCESS', 'FAILED', 'CANCELLED'] as const)('a %s deployment is reported terminal and never touched (H1)', async (status) => {
    const h = harness({ deployment: deploymentRow({ status }), service: serviceRow() });

    const result = await h.store.requestCancel(DEPLOYMENT_ID, ACTOR);

    expect(result).toMatchObject({ kind: 'terminal', deployment: { status } });
    expect(h.ops.filter((op) => op.root !== 'select')).toEqual([]);
    expect(h.published).toEqual([]);
  });

  it('a missing deployment is reported missing', async () => {
    const h = harness({ deployment: null, service: null });
    expect(await h.store.requestCancel(DEPLOYMENT_ID, ACTOR)).toEqual({ kind: 'missing' });
  });

  it('records the cancel_requested event of a running deployment with the actor', async () => {
    const h = harness({ deployment: deploymentRow({ status: 'BUILDING', startedAt: STARTED }), service: serviceRow() });
    const result = await h.store.requestCancel(DEPLOYMENT_ID, ACTOR);
    if (result.kind !== 'running') throw new Error('expected running');

    await h.store.recordCancelRequested(result.deployment, ACTOR);

    expect(activityValues(h)).toEqual([
      expect.objectContaining({ actorId: ACTOR.id, action: 'deployment.cancel_requested', metadata: { serviceId: SERVICE_ID, status: 'BUILDING' } }),
    ]);
  });

  it('an unconfirmed cancel keeps the row code and puts the named warning on the finished event (H2)', async () => {
    const h = harness({ deployment: deploymentRow({ status: 'BUILDING', startedAt: STARTED }), service: serviceRow() });

    await h.store.finish(
      DEPLOYMENT_ID,
      finishInput({ status: 'FAILED', errorCode: 'SERVER_UNREACHABLE', errorMessage: DEPLOY_MESSAGES.CANCEL_UNCONFIRMED, container: null, warning: 'CANCEL_UNCONFIRMED' }),
    );

    expect(h.state.deployment).toMatchObject({ status: 'FAILED', errorCode: 'SERVER_UNREACHABLE', errorMessage: DEPLOY_MESSAGES.CANCEL_UNCONFIRMED });
    expect(activityValues(h)).toEqual([expect.objectContaining({ action: 'deployment.finished', outcome: 'failure', errorCode: 'CANCEL_UNCONFIRMED' })]);
  });

  it('lists in-flight deployments joined to their service server', async () => {
    const h = harness({ deployment: deploymentRow({ status: 'BUILDING' }), service: serviceRow() });
    await h.store.inFlight();
    const op = h.ops[0];
    expect(op?.calls.map((c) => c.method)).toEqual(['from', 'innerJoin', 'where']);
  });
});
