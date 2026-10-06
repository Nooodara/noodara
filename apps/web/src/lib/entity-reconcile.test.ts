// 13-08 A2/A3: the one reconcile function (REC-02) and the store built on it. The reorder suite
// runs every arrival permutation of (snapshot in flight, updated event, deleted event) and checks
// the list always ends at the newest write.
import { describe, expect, it } from 'vitest';
import {
  applyEntityStoreWrite,
  applyEntityWrite,
  beginEntitySnapshot,
  completeEntitySnapshot,
  createEntityStore,
  reconcileEntities,
  versionOf,
  type EntityStore,
  type EntityWrite,
} from './entity-reconcile';

interface Item {
  readonly id: string;
  readonly updatedAt: string;
  readonly label: string;
}

const T1 = '2026-10-06T10:00:01.000Z';
const T2 = '2026-10-06T10:00:02.000Z';
const T3 = '2026-10-06T10:00:03.000Z';

function item(id: string, updatedAt: string, label = `${id}@${updatedAt}`): Item {
  return { id, updatedAt, label };
}

function permutations<T>(values: readonly T[]): T[][] {
  if (values.length <= 1) return [[...values]];
  return values.flatMap((value, index) =>
    permutations([...values.slice(0, index), ...values.slice(index + 1)]).map((rest) => [value, ...rest]),
  );
}

describe('versionOf', () => {
  it('parses an ISO instant and refuses anything it cannot order', () => {
    expect(versionOf(T1)).toBe(Date.parse(T1));
    expect(versionOf('not a date')).toBeNull();
    expect(versionOf('')).toBeNull();
    expect(versionOf(undefined)).toBeNull();
    expect(versionOf(42)).toBeNull();
  });
});

describe('applyEntityWrite', () => {
  it('puts a newer or equal version in place, keeping sibling identity', () => {
    const a = item('a', T1);
    const b = item('b', T1);
    const list = [a, b];
    const newer = applyEntityWrite(list, { kind: 'put', entity: item('a', T2) }).entities;
    expect(newer[0]).toEqual(item('a', T2));
    expect(newer[1]).toBe(b);
    const equal = item('a', T1, 'same version, new body');
    expect(applyEntityWrite(list, { kind: 'put', entity: equal }).entities[0]).toBe(equal);
  });

  it('never regresses an entity to an older version', () => {
    const list = [item('a', T2)];
    const result = applyEntityWrite(list, { kind: 'put', entity: item('a', T1) });
    expect(result.entities).toBe(list);
  });

  it('ignores a write whose updatedAt is missing or invalid', () => {
    const list = [item('a', T1)];
    expect(applyEntityWrite(list, { kind: 'put', entity: item('a', 'garbage') }).entities).toBe(list);
    expect(applyEntityWrite(list, { kind: 'put', entity: item('b', '') }).entities).toBe(list);
    const patch: EntityWrite<Item> = { kind: 'patch', id: 'a', updatedAt: 'nope', patch: { label: 'x' } };
    expect(applyEntityWrite(list, patch).entities).toBe(list);
  });

  it('lets a valid write replace an entity whose own updatedAt cannot be ordered', () => {
    const list = [item('a', 'garbage')];
    expect(applyEntityWrite(list, { kind: 'put', entity: item('a', T1) }).entities).toEqual([item('a', T1)]);
  });

  it('inserts an unknown put with the insert option, appending by default', () => {
    const list = [item('b', T1)];
    expect(applyEntityWrite(list, { kind: 'put', entity: item('c', T1) }).entities.map((e) => e.id)).toEqual([
      'b',
      'c',
    ]);
    const first = applyEntityWrite(list, { kind: 'put', entity: item('a', T1) }, {
      insert: (current, entity) => [entity, ...current],
    });
    expect(first.entities.map((e) => e.id)).toEqual(['a', 'b']);
  });

  it('merges a patch onto the held entity and reports a patch for an unknown id as missing', () => {
    const list = [item('a', T1, 'old')];
    const patched = applyEntityWrite(list, { kind: 'patch', id: 'a', updatedAt: T2, patch: { label: 'new' } });
    expect(patched.entities).toEqual([{ id: 'a', updatedAt: T2, label: 'new' }]);
    expect(patched.missing).toEqual([]);

    const unknown = applyEntityWrite(list, { kind: 'patch', id: 'z', updatedAt: T2, patch: { label: 'x' } });
    expect(unknown.entities).toBe(list);
    expect(unknown.missing).toEqual(['z']);
  });

  it('never lets a patch overwrite the id', () => {
    const list = [item('a', T1)];
    const result = applyEntityWrite(list, {
      kind: 'patch',
      id: 'a',
      updatedAt: T2,
      patch: { id: 'evil' },
    });
    expect(result.entities[0]?.id).toBe('a');
  });

  it('a delete removes the entity and tombstones the id, even when it was never shown', () => {
    const list = [item('a', T1)];
    const removed = applyEntityWrite(list, { kind: 'delete', id: 'a' });
    expect(removed.entities).toEqual([]);
    expect(removed.tombstones.has('a')).toBe(true);

    const unknown = applyEntityWrite(list, { kind: 'delete', id: 'z' });
    expect(unknown.entities).toBe(list);
    expect(unknown.tombstones.has('z')).toBe(true);
  });

  it('never resurrects a tombstoned id, whatever its version', () => {
    const tombstones = new Set(['a']);
    const result = applyEntityWrite<Item>([], { kind: 'put', entity: item('a', T3) }, { tombstones });
    expect(result.entities).toEqual([]);
  });
});

describe('reconcileEntities', () => {
  it('returns the snapshot itself when nothing was buffered', () => {
    const snapshot = [item('a', T1)];
    expect(reconcileEntities(snapshot, []).entities).toBe(snapshot);
  });

  it('drops snapshot entries for tombstoned ids', () => {
    const result = reconcileEntities([item('a', T1), item('b', T1)], [], { tombstones: new Set(['a']) });
    expect(result.entities.map((e) => e.id)).toEqual(['b']);
  });

  it('keeps the held entity when it is newer than the snapshot entry', () => {
    const held = item('a', T3);
    const result = reconcileEntities([item('a', T1)], [], { current: [held] });
    expect(result.entities[0]).toBe(held);
  });

  it('keeps the snapshot entry when it is the newer one', () => {
    const snapshot = [item('a', T3)];
    expect(reconcileEntities(snapshot, [], { current: [item('a', T1)] }).entities).toBe(snapshot);
  });

  it('a delete followed by an update for the same id stays deleted', () => {
    const result = reconcileEntities(
      [item('a', T1)],
      [
        { kind: 'delete', id: 'a' },
        { kind: 'put', entity: item('a', T3) },
      ],
    );
    expect(result.entities).toEqual([]);
  });

  it('clears a missing patch that a later put satisfied', () => {
    const result = reconcileEntities<Item>(
      [],
      [
        { kind: 'patch', id: 'a', updatedAt: T1, patch: { label: 'p' } },
        { kind: 'put', entity: item('a', T2) },
      ],
    );
    expect(result.missing).toEqual([]);
    expect(result.entities).toEqual([item('a', T2)]);
  });

  it('reports a patch that found nothing to apply to', () => {
    const result = reconcileEntities<Item>([], [{ kind: 'patch', id: 'a', updatedAt: T1, patch: {} }]);
    expect(result.missing).toEqual(['a']);
  });
});

type Step = 'snapshot' | 'updated' | 'deleted';

/** Starts a snapshot, then delivers the three steps in `order`. */
function runOrder(order: readonly Step[], snapshot: readonly Item[], initial: readonly Item[]): EntityStore<Item> {
  let store = beginEntitySnapshot(createEntityStore(initial));
  for (const step of order) {
    if (step === 'snapshot') store = completeEntitySnapshot(store, snapshot).store;
    if (step === 'updated') store = applyEntityStoreWrite(store, { kind: 'put', entity: item('a', T2) }).store;
    if (step === 'deleted') store = applyEntityStoreWrite(store, { kind: 'delete', id: 'a' }).store;
  }
  return store;
}

describe('reorder: snapshot in flight, updated event, deleted event', () => {
  const snapshots: Record<string, readonly Item[]> = {
    'read before the update': [item('a', T1)],
    'read after the update': [item('a', T2)],
    'read after the delete': [],
  };

  for (const order of permutations<Step>(['snapshot', 'updated', 'deleted'])) {
    for (const [label, snapshot] of Object.entries(snapshots)) {
      it(`${order.join(' -> ')} (snapshot ${label}) ends deleted`, () => {
        const store = runOrder(order, snapshot, [item('a', T1)]);
        expect(store.entities).toEqual([]);
        expect(store.tombstones.has('a')).toBe(true);
        expect(store.inFlight).toBe(0);
        expect(store.buffer).toEqual([]);
      });
    }
  }

  for (const order of permutations<Exclude<Step, 'deleted'>>(['snapshot', 'updated'])) {
    it(`${order.join(' -> ')}: a stale snapshot never regresses the update`, () => {
      const store = runOrder(order, [item('a', T1)], [item('a', T1)]);
      expect(store.entities).toEqual([item('a', T2)]);
    });

    it(`${order.join(' -> ')}: an older event never regresses a newer snapshot`, () => {
      const store = runOrder(order, [item('a', T3)], [item('a', T1)]);
      expect(store.entities).toEqual([item('a', T3)]);
    });

    it(`${order.join(' -> ')}: an entity created after the snapshot read is kept`, () => {
      const store = runOrder(order, [], []);
      expect(store.entities).toEqual([item('a', T2)]);
    });
  }

  it('a delete is never resurrected by a later event or a later stale snapshot', () => {
    let store = applyEntityStoreWrite(createEntityStore([item('a', T1)]), { kind: 'delete', id: 'a' }).store;
    store = applyEntityStoreWrite(store, { kind: 'put', entity: item('a', T3) }).store;
    store = completeEntitySnapshot(beginEntitySnapshot(store), [item('a', T3)]).store;
    expect(store.entities).toEqual([]);
  });

  it('overlapping snapshots completing out of order still end at the newest write', () => {
    let store = beginEntitySnapshot(createEntityStore([item('a', T1)]));
    store = applyEntityStoreWrite(store, { kind: 'put', entity: item('a', T2) }).store;
    store = beginEntitySnapshot(store);
    store = applyEntityStoreWrite(store, { kind: 'put', entity: item('a', T3) }).store;
    store = completeEntitySnapshot(store, [item('a', T3)]).store;
    store = completeEntitySnapshot(store, [item('a', T1)]).store;
    expect(store.entities).toEqual([item('a', T3)]);
    expect(store.inFlight).toBe(0);
    expect(store.buffer).toEqual([]);
  });
});

describe('entity store', () => {
  it('buffers writes only while a snapshot is in flight', () => {
    const idle = applyEntityStoreWrite(createEntityStore<Item>(), { kind: 'put', entity: item('a', T1) }).store;
    expect(idle.buffer).toEqual([]);
    const busy = applyEntityStoreWrite(beginEntitySnapshot(createEntityStore<Item>()), {
      kind: 'put',
      entity: item('a', T1),
    }).store;
    expect(busy.buffer).toHaveLength(1);
  });

  it('reports a missing patch only when no snapshot is coming', () => {
    const patch: EntityWrite<Item> = { kind: 'patch', id: 'a', updatedAt: T1, patch: {} };
    expect(applyEntityStoreWrite(createEntityStore<Item>(), patch).missing).toEqual(['a']);
    const busy = beginEntitySnapshot(createEntityStore<Item>());
    const step = applyEntityStoreWrite(busy, patch);
    expect(step.missing).toEqual([]);
    expect(completeEntitySnapshot(step.store, []).missing).toEqual(['a']);
    expect(completeEntitySnapshot(step.store, [item('a', T1, 'base')]).store.entities).toEqual([
      item('a', T1, 'base'),
    ]);
  });

  it('a failed snapshot keeps what is shown and ends the flight', () => {
    const shown = [item('a', T1)];
    const store = beginEntitySnapshot(createEntityStore(shown));
    const step = completeEntitySnapshot(store, null);
    expect(step.store.entities).toBe(shown);
    expect(step.store.inFlight).toBe(0);
  });
});
