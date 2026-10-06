// 13-08: service/deployment lists kept live from snapshots + events, and the per-deployment log
// router (A4, H1, H2). Pure: fake loaders, no EventSource.
import { describe, expect, it, vi } from 'vitest';
import {
  createDeploymentLogRouter,
  createSyncedCollection,
  deploymentWriteFromEvent,
  insertServiceByName,
  serviceWriteFromEvent,
} from './deploy-store';
import type { DeploymentView, ServiceView } from './deploy-api';
import type { DeployEntityEvent, DeploymentLogChunkEvent } from './server-events';

const T1 = '2026-10-06T10:00:01.000Z';
const T2 = '2026-10-06T10:00:02.000Z';
const T3 = '2026-10-06T10:00:03.000Z';

function service(id: string, name: string, updatedAt = T1, environmentId = 'env-1'): ServiceView {
  return {
    id,
    projectId: 'proj-1',
    environmentId,
    serverId: 'srv-1',
    name,
    sourceType: 'image',
    repositoryUrl: null,
    branch: null,
    buildContext: null,
    dockerfilePath: null,
    buildTarget: null,
    imageRef: 'nginx:1.27',
    internalPort: 80,
    publishedPort: null,
    status: 'RUNNING',
    createdAt: T1,
    updatedAt,
  };
}

function deployment(id: string, updatedAt = T1, serviceId = 'svc-1'): DeploymentView {
  return {
    id,
    serviceId,
    status: 'BUILDING',
    trigger: 'manual',
    triggeredBy: null,
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
    createdAt: T1,
    updatedAt,
  };
}

function deploymentUpdated(id: string, updatedAt: string, serviceId = 'svc-1'): DeployEntityEvent {
  return {
    type: 'deployment.updated',
    deployment: { id, serviceId, status: 'SUCCESS', errorCode: null, updatedAt },
  };
}

function chunk(deploymentId: string, seq = 0): DeploymentLogChunkEvent {
  return { type: 'deployment.log_chunk', deploymentId, phase: 'build', seq, text: 'line\n', truncated: false };
}

/** A loader whose next call resolves only when the test says so. */
function deferredLoader<T>() {
  const pending: ((value: readonly T[] | null) => void)[] = [];
  const load = vi.fn(
    () =>
      new Promise<readonly T[] | null>((resolve) => {
        pending.push(resolve);
      }),
  );
  return {
    load,
    resolveNext(value: readonly T[] | null) {
      const resolve = pending.shift();
      if (resolve === undefined) throw new Error('no load in flight');
      resolve(value);
    },
  };
}

async function flush(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

describe('event to write mapping', () => {
  it('service.updated is a put, service.deleted a delete, anything else nothing', () => {
    const view = service('svc-1', 'api');
    expect(serviceWriteFromEvent({ type: 'service.updated', service: view })).toEqual({ kind: 'put', entity: view });
    expect(serviceWriteFromEvent({ type: 'service.deleted', id: 'svc-1' })).toEqual({ kind: 'delete', id: 'svc-1' });
    expect(serviceWriteFromEvent(deploymentUpdated('d1', T1))).toBeNull();
  });

  it('a service outside the scope is not written', () => {
    const other = service('svc-2', 'web', T1, 'env-2');
    expect(
      serviceWriteFromEvent({ type: 'service.updated', service: other }, (s) => s.environmentId === 'env-1'),
    ).toBeNull();
  });

  it('deployment.updated is a patch of status and errorCode, scoped to one service', () => {
    expect(deploymentWriteFromEvent(deploymentUpdated('d1', T2))).toEqual({
      kind: 'patch',
      id: 'd1',
      updatedAt: T2,
      patch: { status: 'SUCCESS', errorCode: null },
    });
    expect(deploymentWriteFromEvent(deploymentUpdated('d1', T2, 'svc-9'), 'svc-1')).toBeNull();
    expect(deploymentWriteFromEvent({ type: 'service.deleted', id: 'svc-1' })).toBeNull();
  });

  it('inserts a service at its case-insensitive name position', () => {
    const list = [service('1', 'Alpha'), service('3', 'charlie')];
    expect(insertServiceByName(list, service('2', 'bravo')).map((s) => s.name)).toEqual(['Alpha', 'bravo', 'charlie']);
    expect(insertServiceByName(list, service('4', 'zulu')).map((s) => s.name)).toEqual(['Alpha', 'charlie', 'zulu']);
  });
});

describe('createSyncedCollection', () => {
  it('reports the first snapshot, even an empty one', async () => {
    const onChange = vi.fn();
    const collection = createSyncedCollection<ServiceView>({
      load: () => Promise.resolve([]),
      toWrite: (event) => serviceWriteFromEvent(event),
      onChange,
    });
    await collection.refetch();
    expect(onChange).toHaveBeenCalledWith([]);
  });

  it('reconciles a snapshot with the events that arrived while it was in flight', async () => {
    const loader = deferredLoader<ServiceView>();
    const onChange = vi.fn();
    const collection = createSyncedCollection<ServiceView>({
      load: loader.load,
      toWrite: (event) => serviceWriteFromEvent(event),
      onChange,
      reconcile: { insert: insertServiceByName },
    });
    const done = collection.refetch();
    collection.handleEvent({ type: 'service.updated', service: service('a', 'api', T3) });
    collection.handleEvent({ type: 'service.deleted', id: 'b' });
    loader.resolveNext([service('a', 'api', T1), service('b', 'worker', T1)]);
    await done;
    expect(collection.entities()).toEqual([service('a', 'api', T3)]);
    expect(onChange).toHaveBeenLastCalledWith([service('a', 'api', T3)]);
  });

  it('refetches once when a deployment.updated names a deployment it does not hold', async () => {
    const load = vi
      .fn<() => Promise<readonly DeploymentView[] | null>>()
      .mockResolvedValueOnce([deployment('d1')])
      .mockResolvedValueOnce([deployment('d2', T1), deployment('d1')]);
    const collection = createSyncedCollection<DeploymentView>({
      load,
      toWrite: (event) => deploymentWriteFromEvent(event, 'svc-1'),
      onChange: () => undefined,
    });
    await collection.refetch();
    collection.handleEvent(deploymentUpdated('d2', T2));
    await flush();
    await flush();
    expect(load).toHaveBeenCalledTimes(2);
    // The refetched snapshot is older than the buffered patch: the patch wins.
    expect(collection.entities().find((d) => d.id === 'd2')?.status).toBe('SUCCESS');
  });

  it('does not loop when the refetch still lacks the deployment', async () => {
    const load = vi.fn<() => Promise<readonly DeploymentView[] | null>>().mockResolvedValue([]);
    const collection = createSyncedCollection<DeploymentView>({
      load,
      toWrite: (event) => deploymentWriteFromEvent(event),
      onChange: () => undefined,
    });
    await collection.refetch();
    collection.handleEvent(deploymentUpdated('ghost', T2));
    for (let i = 0; i < 5; i += 1) await flush();
    expect(load).toHaveBeenCalledTimes(2);
  });

  it('ignores another service deployments without refetching', async () => {
    const load = vi.fn<() => Promise<readonly DeploymentView[] | null>>().mockResolvedValue([]);
    const collection = createSyncedCollection<DeploymentView>({
      load,
      toWrite: (event) => deploymentWriteFromEvent(event, 'svc-1'),
      onChange: () => undefined,
    });
    await collection.refetch();
    collection.handleEvent(deploymentUpdated('d9', T2, 'svc-2'));
    await flush();
    expect(load).toHaveBeenCalledTimes(1);
  });

  it('keeps what is shown when a load fails or rejects', async () => {
    const load = vi
      .fn<() => Promise<readonly ServiceView[] | null>>()
      .mockResolvedValueOnce([service('a', 'api')])
      .mockResolvedValueOnce(null)
      .mockRejectedValueOnce(new Error('network'));
    const collection = createSyncedCollection<ServiceView>({
      load,
      toWrite: (event) => serviceWriteFromEvent(event),
      onChange: () => undefined,
    });
    await collection.refetch();
    await collection.refetch();
    await collection.refetch();
    expect(collection.entities()).toEqual([service('a', 'api')]);
  });

  it('reports nothing after dispose, even for a load that settles later', async () => {
    const loader = deferredLoader<ServiceView>();
    const onChange = vi.fn();
    const collection = createSyncedCollection<ServiceView>({
      load: loader.load,
      toWrite: (event) => serviceWriteFromEvent(event),
      onChange,
    });
    const done = collection.refetch();
    collection.dispose();
    loader.resolveNext([service('a', 'api')]);
    await done;
    collection.handleEvent({ type: 'service.updated', service: service('b', 'web') });
    await collection.refetch();
    expect(onChange).not.toHaveBeenCalled();
    expect(loader.load).toHaveBeenCalledTimes(1);
  });
});

describe('createDeploymentLogRouter', () => {
  it('delivers a chunk only to the handlers of its deployment', () => {
    const router = createDeploymentLogRouter();
    const a = vi.fn();
    const b = vi.fn();
    router.subscribe('dep-a', a);
    router.subscribe('dep-b', b);
    expect(router.dispatch(chunk('dep-a'))).toBe(true);
    expect(a).toHaveBeenCalledWith(chunk('dep-a'));
    expect(b).not.toHaveBeenCalled();
  });

  it('drops a chunk for an unsubscribed deployment without creating state for it', () => {
    const router = createDeploymentLogRouter();
    router.subscribe('dep-a', () => undefined);
    expect(router.dispatch(chunk('dep-nobody'))).toBe(false);
    expect(router.deploymentCount()).toBe(1);
    expect(router.handlerCount()).toBe(1);
  });

  it('delivers nothing after unsubscribe, and unsubscribing twice is harmless', () => {
    const router = createDeploymentLogRouter();
    const handler = vi.fn();
    const off = router.subscribe('dep-a', handler);
    off();
    off();
    expect(router.dispatch(chunk('dep-a'))).toBe(false);
    expect(handler).not.toHaveBeenCalled();
    expect(router.deploymentCount()).toBe(0);
  });

  it('the same handler subscribed twice is two registrations, each removed by its own unsubscribe', () => {
    const router = createDeploymentLogRouter();
    const handler = vi.fn();
    const first = router.subscribe('dep-a', handler);
    const second = router.subscribe('dep-a', handler);
    first();
    router.dispatch(chunk('dep-a'));
    expect(handler).toHaveBeenCalledTimes(1);
    second();
    expect(router.handlerCount()).toBe(0);
  });

  it('one throwing handler never stops the others', () => {
    const router = createDeploymentLogRouter();
    const healthy = vi.fn();
    router.subscribe('dep-a', () => {
      throw new Error('panel crashed');
    });
    router.subscribe('dep-a', healthy);
    expect(() => router.dispatch(chunk('dep-a'))).not.toThrow();
    expect(healthy).toHaveBeenCalledTimes(1);
  });

  it('1000 subscribe/unsubscribe cycles leave zero registered handlers (leak test)', () => {
    const router = createDeploymentLogRouter();
    const handler = vi.fn();
    for (let i = 0; i < 1000; i += 1) {
      const off = router.subscribe(`dep-${String(i % 7)}`, handler);
      router.dispatch(chunk(`dep-${String(i % 7)}`, i));
      off();
    }
    expect(router.handlerCount()).toBe(0);
    expect(router.deploymentCount()).toBe(0);
    router.dispatch(chunk('dep-0'));
    expect(handler).toHaveBeenCalledTimes(1000);
  });
});
