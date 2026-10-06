// 13-08 (REC-02): the one pure reconcile function every live list in the shell shares -- servers,
// services and deployments. An entity is keyed by `id` and versioned by `updatedAt`, which every
// write on the control plane bumps (13-02), so a list can always keep the newest of what a
// snapshot (GET) and the SSE stream said about one id, whatever order they arrived in:
//
// - a `put` (full view) or `patch` (partial view) applies unless the entity already held is
//   strictly newer; an equal `updatedAt` applies (the event announces the write the row now has).
// - a write with a missing or unparseable `updatedAt` is ignored: it cannot be ordered.
// - a `delete` is final. Ids are never reused, so a deleted id becomes a tombstone and no later
//   put, patch or stale snapshot can bring it back.
// - a `patch` for an id the list does not hold cannot be applied (there is nothing to merge
//   onto); its id is reported in `missing` so the caller can refetch.
//
// No React, no fetching, no clock. Unchanged inputs come back as the same references.

export interface VersionedEntity {
  readonly id: string;
  readonly updatedAt: string;
}

export type EntityWrite<T extends VersionedEntity> =
  | { readonly kind: 'put'; readonly entity: T }
  | {
      readonly kind: 'patch';
      readonly id: string;
      readonly updatedAt: string;
      readonly patch: Partial<T>;
    }
  | { readonly kind: 'delete'; readonly id: string };

export interface ReconcileOptions<T extends VersionedEntity> {
  /** Places an entity the list does not hold yet; appends when omitted. */
  readonly insert?: (list: readonly T[], entity: T) => readonly T[];
  /** Ids already known to be deleted. */
  readonly tombstones?: ReadonlySet<string>;
  /** What the caller holds right now: a snapshot entry older than its counterpart here is
   *  replaced by it, so a slow snapshot never regresses a newer write already shown. */
  readonly current?: readonly T[];
}

export interface ReconcileResult<T extends VersionedEntity> {
  readonly entities: readonly T[];
  readonly tombstones: ReadonlySet<string>;
  /** Ids of patches that found no entity to apply to. */
  readonly missing: readonly string[];
}

const EMPTY_TOMBSTONES: ReadonlySet<string> = new Set();
const NO_MISSING: readonly string[] = [];

/** Milliseconds since the epoch, or `null` when `updatedAt` cannot be ordered. */
export function versionOf(updatedAt: unknown): number | null {
  if (typeof updatedAt !== 'string') return null;
  const ms = Date.parse(updatedAt);
  return Number.isFinite(ms) ? ms : null;
}

/** True when `held` is strictly newer than a write versioned `incoming`. An unorderable held
 *  version never blocks a valid write. */
function isStrictlyNewer(held: VersionedEntity, incoming: number): boolean {
  const heldVersion = versionOf(held.updatedAt);
  return heldVersion !== null && heldVersion > incoming;
}

function append<T>(list: readonly T[], entity: T): readonly T[] {
  return [...list, entity];
}

function replaceAt<T>(list: readonly T[], index: number, entity: T): readonly T[] {
  const next = [...list];
  next[index] = entity;
  return next;
}

/** Folds one write onto `list`. */
export function applyEntityWrite<T extends VersionedEntity>(
  list: readonly T[],
  write: EntityWrite<T>,
  options: ReconcileOptions<T> = {},
): ReconcileResult<T> {
  const tombstones = options.tombstones ?? EMPTY_TOMBSTONES;
  const unchanged: ReconcileResult<T> = { entities: list, tombstones, missing: NO_MISSING };

  if (write.kind === 'delete') {
    const nextTombstones = tombstones.has(write.id) ? tombstones : new Set([...tombstones, write.id]);
    const index = list.findIndex((entry) => entry.id === write.id);
    const entities = index === -1 ? list : list.filter((entry) => entry.id !== write.id);
    return { entities, tombstones: nextTombstones, missing: NO_MISSING };
  }

  const id = write.kind === 'put' ? write.entity.id : write.id;
  const updatedAt = write.kind === 'put' ? write.entity.updatedAt : write.updatedAt;
  const incoming = versionOf(updatedAt);
  if (incoming === null || tombstones.has(id)) return unchanged;

  const index = list.findIndex((entry) => entry.id === id);
  const held = index === -1 ? undefined : list[index];

  if (held === undefined) {
    if (write.kind === 'patch') return { ...unchanged, missing: [id] };
    const insert = options.insert ?? append;
    return { ...unchanged, entities: insert(list, write.entity) };
  }

  if (isStrictlyNewer(held, incoming)) return unchanged;

  const entity: T = write.kind === 'put' ? write.entity : { ...held, ...write.patch, id: held.id, updatedAt };
  return { ...unchanged, entities: replaceAt(list, index, entity) };
}

/**
 * Reconciles a snapshot with the writes that arrived while it was in flight, in arrival order.
 * Snapshot entries for tombstoned ids are dropped; with `current`, a snapshot entry older than
 * the one already held is replaced by it. Returns `snapshot` itself when nothing changed.
 */
export function reconcileEntities<T extends VersionedEntity>(
  snapshot: readonly T[],
  writes: readonly EntityWrite<T>[],
  options: ReconcileOptions<T> = {},
): ReconcileResult<T> {
  let tombstones = options.tombstones ?? EMPTY_TOMBSTONES;
  let entities = snapshot;

  if (tombstones.size > 0 && entities.some((entry) => tombstones.has(entry.id))) {
    entities = entities.filter((entry) => !tombstones.has(entry.id));
  }

  const current = options.current;
  if (current !== undefined && current.length > 0) {
    const held = new Map(current.map((entry) => [entry.id, entry]));
    const base = entities;
    const merged = base.map((entry) => {
      const newer = held.get(entry.id);
      const entryVersion = versionOf(entry.updatedAt);
      const newerVersion = newer === undefined ? null : versionOf(newer.updatedAt);
      const keepHeld = newerVersion !== null && (entryVersion === null || newerVersion > entryVersion);
      return keepHeld && newer !== undefined ? newer : entry;
    });
    if (merged.some((entry, index) => entry !== base[index])) entities = merged;
  }

  const missing = new Set<string>();
  for (const write of writes) {
    const result = applyEntityWrite(entities, write, { ...options, tombstones });
    entities = result.entities;
    tombstones = result.tombstones;
    for (const id of result.missing) missing.add(id);
  }
  // A patch that missed early may have found its entity through a later put.
  for (const id of missing) {
    if (entities.some((entry) => entry.id === id) || tombstones.has(id)) missing.delete(id);
  }

  return { entities, tombstones, missing: missing.size === 0 ? NO_MISSING : [...missing] };
}

/**
 * A live list: what is shown now, the tombstones, and the writes buffered while one or more
 * snapshots are in flight. Every write applies to `entities` at once and is also buffered, so a
 * snapshot that completes later is reconciled with everything that happened since it started.
 */
export interface EntityStore<T extends VersionedEntity> {
  readonly entities: readonly T[];
  readonly tombstones: ReadonlySet<string>;
  readonly inFlight: number;
  readonly buffer: readonly EntityWrite<T>[];
}

export interface EntityStoreStep<T extends VersionedEntity> {
  readonly store: EntityStore<T>;
  /** Ids the caller should refetch for: patches with nothing to apply to and no snapshot coming. */
  readonly missing: readonly string[];
}

export function createEntityStore<T extends VersionedEntity>(entities: readonly T[] = []): EntityStore<T> {
  return { entities, tombstones: EMPTY_TOMBSTONES, inFlight: 0, buffer: [] };
}

/** A snapshot request just started: buffer writes until it completes. `carried` are writes to
 *  retry on top of it (the patch that found nothing to apply to and asked for this snapshot). */
export function beginEntitySnapshot<T extends VersionedEntity>(
  store: EntityStore<T>,
  carried: readonly EntityWrite<T>[] = [],
): EntityStore<T> {
  const buffer = carried.length === 0 ? store.buffer : [...store.buffer, ...carried];
  return { ...store, inFlight: store.inFlight + 1, buffer };
}

/** Applies a live write; buffers it while a snapshot is in flight. */
export function applyEntityStoreWrite<T extends VersionedEntity>(
  store: EntityStore<T>,
  write: EntityWrite<T>,
  options: ReconcileOptions<T> = {},
): EntityStoreStep<T> {
  const result = applyEntityWrite(store.entities, write, { ...options, tombstones: store.tombstones });
  const next: EntityStore<T> = {
    ...store,
    entities: result.entities,
    tombstones: result.tombstones,
    buffer: store.inFlight > 0 ? [...store.buffer, write] : store.buffer,
  };
  // While a snapshot is in flight the buffered patch is retried when it completes.
  return { store: next, missing: store.inFlight > 0 ? NO_MISSING : result.missing };
}

/** A snapshot arrived (`snapshot`), or failed (`null`: what is shown stays as it is). */
export function completeEntitySnapshot<T extends VersionedEntity>(
  store: EntityStore<T>,
  snapshot: readonly T[] | null,
  options: ReconcileOptions<T> = {},
): EntityStoreStep<T> {
  const inFlight = Math.max(0, store.inFlight - 1);
  const buffer = inFlight === 0 ? [] : store.buffer;
  if (snapshot === null) {
    return { store: { ...store, inFlight, buffer }, missing: NO_MISSING };
  }
  const result = reconcileEntities(snapshot, store.buffer, {
    ...options,
    tombstones: store.tombstones,
    current: store.entities,
  });
  return {
    store: { entities: result.entities, tombstones: result.tombstones, inFlight, buffer },
    missing: result.missing,
  };
}
