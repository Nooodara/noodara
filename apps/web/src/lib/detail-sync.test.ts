// 05-29-PLAN.md Task 2: the pure decision behind the detail page's single write path
// (05-VERIFICATION.md gap 2 / SC2). This module is new, so these tests start GREEN once the
// implementation exists (acceptable for a new pure unit per the plan's own action text) -- the RED
// proof for the *bug* this closes is the page-level reproduction in Task 3's E2E specs, plus this
// plan's SUMMARY quoting the finding it fixes.
import { describe, expect, it } from 'vitest';
import { reconcileDetailSnapshot, type DetailSnapshotLike } from './detail-sync';

interface Fixture extends DetailSnapshotLike {
  readonly id: string;
  readonly updatedAt: string;
}

function server(overrides: Partial<Fixture> = {}): Fixture {
  return { id: 'srv-1', updatedAt: '2026-09-20T12:00:00.000Z', ...overrides };
}

describe('reconcileDetailSnapshot', () => {
  it('rejects a snapshot whose updatedAt is strictly older than the currently held server', () => {
    const held = server({ updatedAt: '2026-09-20T12:00:05.000Z' });
    const incoming = server({ updatedAt: '2026-09-20T12:00:00.000Z' });

    const decision = reconcileDetailSnapshot({
      held,
      incoming,
      source: 'snapshot',
      isDeleted: false,
      requestSequence: 2,
      latestRequestSequence: 2,
    });

    expect(decision).toEqual({ accept: false, reason: 'stale-snapshot' });
  });

  it('accepts a snapshot whose updatedAt is equal to or newer than the currently held server', () => {
    const held = server({ updatedAt: '2026-09-20T12:00:00.000Z' });

    const equal = reconcileDetailSnapshot({
      held,
      incoming: server({ updatedAt: '2026-09-20T12:00:00.000Z' }),
      source: 'snapshot',
      isDeleted: false,
      requestSequence: 1,
      latestRequestSequence: 1,
    });
    const newer = reconcileDetailSnapshot({
      held,
      incoming: server({ updatedAt: '2026-09-20T12:00:05.000Z' }),
      source: 'snapshot',
      isDeleted: false,
      requestSequence: 1,
      latestRequestSequence: 1,
    });

    expect(equal).toEqual({ accept: true });
    expect(newer).toEqual({ accept: true });
  });

  it('accepts the very first snapshot when nothing is held yet, regardless of updatedAt', () => {
    const decision = reconcileDetailSnapshot({
      held: null,
      incoming: server({ updatedAt: '2020-01-01T00:00:00.000Z' }),
      source: 'snapshot',
      isDeleted: false,
      requestSequence: 1,
      latestRequestSequence: 1,
    });

    expect(decision).toEqual({ accept: true });
  });

  it('rejects any snapshot for a server already known deleted, regardless of updatedAt', () => {
    const held = server({ updatedAt: '2026-09-20T12:00:00.000Z' });
    const decision = reconcileDetailSnapshot({
      held,
      incoming: server({ updatedAt: '2026-09-20T13:00:00.000Z' }), // strictly newer, still rejected
      source: 'snapshot',
      isDeleted: true,
      requestSequence: 5,
      latestRequestSequence: 5,
    });

    expect(decision).toEqual({ accept: false, reason: 'deleted' });
  });

  it('rejects an event too once the server is known deleted -- nothing resurrects it', () => {
    const decision = reconcileDetailSnapshot({
      held: null,
      incoming: server({ updatedAt: '2026-09-20T13:00:00.000Z' }),
      source: 'event',
      isDeleted: true,
      requestSequence: null,
      latestRequestSequence: 5,
    });

    expect(decision).toEqual({ accept: false, reason: 'deleted' });
  });

  it('rejects a snapshot from a superseded request (a lower sequence than the latest issued)', () => {
    const decision = reconcileDetailSnapshot({
      held: null,
      incoming: server(),
      source: 'snapshot',
      isDeleted: false,
      requestSequence: 1,
      latestRequestSequence: 2,
    });

    expect(decision).toEqual({ accept: false, reason: 'superseded-request' });
  });

  it('accepts an event over a held snapshot of the same or older updatedAt -- events are the live source', () => {
    const held = server({ updatedAt: '2026-09-20T12:00:05.000Z' });
    const olderEvent = reconcileDetailSnapshot({
      held,
      incoming: server({ updatedAt: '2026-09-20T12:00:00.000Z' }), // older than held, still accepted
      source: 'event',
      isDeleted: false,
      requestSequence: null,
      latestRequestSequence: 3,
    });
    const sameEvent = reconcileDetailSnapshot({
      held,
      incoming: server({ updatedAt: '2026-09-20T12:00:05.000Z' }),
      source: 'event',
      isDeleted: false,
      requestSequence: null,
      latestRequestSequence: 3,
    });

    expect(olderEvent).toEqual({ accept: true });
    expect(sameEvent).toEqual({ accept: true });
  });

  it('is pure: calling it repeatedly with the same input always returns the same decision', () => {
    const input = {
      held: server({ updatedAt: '2026-09-20T12:00:00.000Z' }),
      incoming: server({ updatedAt: '2026-09-20T11:00:00.000Z' }),
      source: 'snapshot' as const,
      isDeleted: false,
      requestSequence: 1,
      latestRequestSequence: 1,
    };

    expect(reconcileDetailSnapshot(input)).toEqual(reconcileDetailSnapshot(input));
  });
});
