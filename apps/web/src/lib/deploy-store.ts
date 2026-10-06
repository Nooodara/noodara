// 13-08: the service and deployment lists the shell keeps live, plus the router that hands
// `deployment.log_chunk` events to whoever is viewing that deployment. No React and no EventSource
// here: `use-server-events.ts` wires these to the shared stream.
//
// Both lists reconcile through `entity-reconcile.ts` (REC-02), the same function as servers:
// - `service.updated` carries the full allowlisted `ServiceView`: a put.
// - `deployment.updated` carries only id, serviceId, status, errorCode and updatedAt: a patch onto
//   the deployment already shown. A patch for a deployment the list does not hold (a deployment
//   that just started) asks the collection to refetch its snapshot.
// - `service.deleted` is a tombstone: no stale snapshot or event resurrects it.
//
// Log chunks are never stored here: a chunk for a deployment nobody subscribed to is dropped
// without creating any per-deployment state (13-08 A4/H1).
import {
  applyEntityStoreWrite,
  beginEntitySnapshot,
  completeEntitySnapshot,
  createEntityStore,
  type EntityStore,
  type EntityWrite,
  type ReconcileOptions,
  type VersionedEntity,
} from './entity-reconcile';
import type { DeploymentView, ServiceView } from './deploy-api';
import type { DeployEntityEvent, DeploymentLogChunkEvent } from './server-events';

/** Case-insensitive, like the servers list. */
export function insertServiceByName<T extends ServiceView>(list: readonly T[], service: T): readonly T[] {
  const next = [...list];
  let index = next.findIndex(
    (entry) => entry.name.localeCompare(service.name, undefined, { sensitivity: 'base' }) > 0,
  );
  if (index === -1) index = next.length;
  next.splice(index, 0, service);
  return next;
}

/** `service.updated` / `service.deleted` as a write; `null` for any other event or a service the
 *  scope excludes. */
export function serviceWriteFromEvent<T extends ServiceView>(
  event: DeployEntityEvent,
  scope?: (service: ServiceView) => boolean,
): EntityWrite<T> | null {
  if (event.type === 'service.deleted') return { kind: 'delete', id: event.id };
  if (event.type !== 'service.updated') return null;
  if (scope !== undefined && !scope(event.service)) return null;
  return { kind: 'put', entity: event.service as T };
}

/** `deployment.updated` as a patch; `null` for any other event or another service's deployment.
 *  A deleted service takes its deployments with it, so `service.deleted` for `serviceId` is
 *  reported by the caller, not here. */
export function deploymentWriteFromEvent<T extends DeploymentView>(
  event: DeployEntityEvent,
  serviceId?: string,
): EntityWrite<T> | null {
  if (event.type !== 'deployment.updated') return null;
  const { deployment } = event;
  if (serviceId !== undefined && deployment.serviceId !== serviceId) return null;
  const patch = { status: deployment.status, errorCode: deployment.errorCode } as Partial<T>;
  return { kind: 'patch', id: deployment.id, updatedAt: deployment.updatedAt, patch };
}

export interface SyncedCollectionOptions<T extends VersionedEntity> {
  /** Reads the snapshot; `null` (or a rejection) keeps what is shown. */
  readonly load: () => Promise<readonly T[] | null>;
  readonly toWrite: (event: DeployEntityEvent) => EntityWrite<T> | null;
  readonly onChange: (entities: readonly T[]) => void;
  readonly reconcile?: ReconcileOptions<T>;
}

export interface SyncedCollection<T extends VersionedEntity> {
  /** Starts a snapshot read and reconciles it with every write that arrives meanwhile. */
  readonly refetch: () => Promise<void>;
  readonly handleEvent: (event: DeployEntityEvent) => void;
  readonly entities: () => readonly T[];
  /** Stops every later `onChange` and refetch; an in-flight load is ignored when it settles. */
  readonly dispose: () => void;
}

/**
 * A list kept live from snapshots and events. `refetch` runs on mount and on every stream
 * (re)open; an event that needs a snapshot (a patch for an unknown id) triggers one refetch,
 * never a loop: a patch still unknown after its snapshot is dropped.
 */
export function createSyncedCollection<T extends VersionedEntity>(
  options: SyncedCollectionOptions<T>,
): SyncedCollection<T> {
  let store: EntityStore<T> = createEntityStore<T>();
  let disposed = false;
  // A call, not a narrowed local: `dispose()` can run while a `load()` is awaited.
  const isDisposed = (): boolean => disposed;
  let loaded = false;

  /** `force`: the first snapshot is reported even when it is as empty as the initial list. */
  function publish(next: EntityStore<T>, force = false): void {
    const changed = force || next.entities !== store.entities;
    store = next;
    if (changed && !isDisposed()) options.onChange(store.entities);
  }

  async function refetch(carried: readonly EntityWrite<T>[] = []): Promise<void> {
    if (isDisposed()) return;
    store = beginEntitySnapshot(store, carried);
    let snapshot: readonly T[] | null;
    try {
      snapshot = await options.load();
    } catch {
      snapshot = null;
    }
    if (isDisposed()) return;
    const step = completeEntitySnapshot(store, snapshot, options.reconcile);
    const firstLoad = !loaded && snapshot !== null;
    if (snapshot !== null) loaded = true;
    publish(step.store, firstLoad);
  }

  function handleEvent(event: DeployEntityEvent): void {
    if (isDisposed()) return;
    const write = options.toWrite(event);
    if (write === null) return;
    const step = applyEntityStoreWrite(store, write, options.reconcile);
    publish(step.store);
    // The write is retried on top of the snapshot it asked for.
    if (step.missing.length > 0) void refetch([write]);
  }

  return {
    refetch: () => refetch(),
    handleEvent,
    entities: () => store.entities,
    dispose: () => {
      disposed = true;
    },
  };
}

export type DeploymentLogHandler = (chunk: DeploymentLogChunkEvent) => void;

export interface DeploymentLogRouter {
  /** Registers `handler` for one deployment's chunks; the returned function is idempotent. */
  readonly subscribe: (deploymentId: string, handler: DeploymentLogHandler) => () => void;
  /** Hands `chunk` to its deployment's handlers; `false` when nobody is subscribed. */
  readonly dispatch: (chunk: DeploymentLogChunkEvent) => boolean;
  /** Registered handlers across every deployment (leak checks). */
  readonly handlerCount: () => number;
  /** Deployments with at least one handler. */
  readonly deploymentCount: () => number;
}

export function createDeploymentLogRouter(): DeploymentLogRouter {
  const handlers = new Map<string, Set<DeploymentLogHandler>>();

  return {
    subscribe(deploymentId, handler) {
      let set = handlers.get(deploymentId);
      if (set === undefined) {
        set = new Set();
        handlers.set(deploymentId, set);
      }
      // A fresh wrapper per subscription, so the same handler subscribed twice is two
      // registrations and each unsubscribe removes exactly its own.
      const registration: DeploymentLogHandler = (chunk) => {
        handler(chunk);
      };
      set.add(registration);
      let active = true;
      return () => {
        if (!active) return;
        active = false;
        const current = handlers.get(deploymentId);
        if (current === undefined) return;
        current.delete(registration);
        if (current.size === 0) handlers.delete(deploymentId);
      };
    },
    dispatch(chunk) {
      const set = handlers.get(chunk.deploymentId);
      if (set === undefined) return false;
      for (const handler of [...set]) {
        try {
          handler(chunk);
        } catch {
          // One panel's failure never stops another panel's log.
        }
      }
      return true;
    },
    handlerCount() {
      let count = 0;
      for (const set of handlers.values()) count += set.size;
      return count;
    },
    deploymentCount: () => handlers.size,
  };
}
