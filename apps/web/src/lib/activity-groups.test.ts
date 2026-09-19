// Task 2 RED (05-15-PLAN.md): `activity-groups.ts` does not exist yet -- the import below fails
// to resolve, the right reason for this file to fail before implementation exists.
import { describe, expect, it } from 'vitest';
import { groupByDay, mergePage } from './activity-groups';

interface Item {
  readonly id: string;
  readonly occurredAt: string;
}

function item(id: string, occurredAt: string): Item {
  return { id, occurredAt };
}

describe('groupByDay -- ordering, labels and the injected reference date', () => {
  it('returns no buckets for an empty input', () => {
    expect(groupByDay<Item>([], new Date('2026-09-19T12:00:00.000Z'))).toEqual([]);
  });

  it('places a single item in one TODAY bucket', () => {
    const now = new Date('2026-09-19T12:00:00.000Z');
    const groups = groupByDay([item('a', '2026-09-19T08:00:00.000Z')], now);

    expect(groups).toHaveLength(1);
    expect(groups[0]?.label).toBe('TODAY');
    expect(groups[0]?.items).toEqual([item('a', '2026-09-19T08:00:00.000Z')]);
  });

  it('labels the reference day TODAY, the previous calendar day YESTERDAY, and an older day by abbreviated date', () => {
    const now = new Date('2026-09-19T12:00:00.000Z');
    const groups = groupByDay(
      [
        item('today', '2026-09-19T09:00:00.000Z'),
        item('yesterday', '2026-09-18T09:00:00.000Z'),
        item('older', '2026-09-10T09:00:00.000Z'),
      ],
      now,
    );

    expect(groups.map((g) => g.label)).toEqual(['TODAY', 'YESTERDAY', 'SEP 10']);
  });

  it('splits items across a midnight boundary into two distinct buckets, newest bucket first', () => {
    const now = new Date('2026-09-19T00:30:00.000Z');
    const groups = groupByDay(
      [item('just-after-midnight', '2026-09-19T00:05:00.000Z'), item('just-before-midnight', '2026-09-18T23:55:00.000Z')],
      now,
    );

    expect(groups.map((g) => g.label)).toEqual(['TODAY', 'YESTERDAY']);
    expect(groups[0]?.items).toEqual([item('just-after-midnight', '2026-09-19T00:05:00.000Z')]);
    expect(groups[1]?.items).toEqual([item('just-before-midnight', '2026-09-18T23:55:00.000Z')]);
  });

  it('orders items within a bucket newest first regardless of input order', () => {
    const now = new Date('2026-09-19T12:00:00.000Z');
    const groups = groupByDay(
      [item('earlier', '2026-09-19T08:00:00.000Z'), item('later', '2026-09-19T10:00:00.000Z')],
      now,
    );

    expect(groups).toHaveLength(1);
    expect(groups[0]?.items.map((i) => i.id)).toEqual(['later', 'earlier']);
  });

  it('is deterministic across a DST-change day in a real zoned timeZone (America/New_York, spring-forward)', () => {
    // 2026-03-08 is the US spring-forward DST transition (2:00 AM -> 3:00 AM EST -> EDT).
    const now = new Date('2026-03-08T20:00:00.000Z'); // 2026-03-08T15:00 EDT (after the jump)
    const groups = groupByDay(
      [item('dst-day', '2026-03-08T10:00:00.000Z')], // 2026-03-08T05:00 EST (before the jump)
      now,
      'America/New_York',
    );

    expect(groups).toHaveLength(1);
    expect(groups[0]?.label).toBe('TODAY');
  });

  it('never reads the platform clock -- the same input+now pair is stable across repeated calls', () => {
    const now = new Date('2026-09-19T12:00:00.000Z');
    const items = [item('a', '2026-09-19T08:00:00.000Z')];

    expect(groupByDay(items, now)).toEqual(groupByDay(items, now));
  });
});

describe('mergePage -- append (Load older) mode', () => {
  it('appends a later page after the existing items, newest-loaded-first order preserved', () => {
    const existing = [item('a', '2026-09-19T10:00:00.000Z')];
    const incoming = [item('b', '2026-09-18T10:00:00.000Z')];

    expect(mergePage(existing, incoming, 'append')).toEqual([item('a', '2026-09-19T10:00:00.000Z'), item('b', '2026-09-18T10:00:00.000Z')]);
  });

  it('de-duplicates by id when the incoming page overlaps the existing items', () => {
    const existing = [item('a', '2026-09-19T10:00:00.000Z'), item('b', '2026-09-18T10:00:00.000Z')];
    const incoming = [item('b', '2026-09-18T10:00:00.000Z'), item('c', '2026-09-17T10:00:00.000Z')];

    expect(mergePage(existing, incoming, 'append')).toEqual([
      item('a', '2026-09-19T10:00:00.000Z'),
      item('b', '2026-09-18T10:00:00.000Z'),
      item('c', '2026-09-17T10:00:00.000Z'),
    ]);
  });

  it('preserves the existing array reference when the incoming page adds nothing new', () => {
    const existing = [item('a', '2026-09-19T10:00:00.000Z')];
    const incoming = [item('a', '2026-09-19T10:00:00.000Z')];

    expect(mergePage(existing, incoming, 'append')).toBe(existing);
  });
});

describe('mergePage -- refresh (page-1 resync) mode', () => {
  it('prepends genuinely new items without discarding already-loaded older pages', () => {
    const existing = [item('b', '2026-09-18T10:00:00.000Z'), item('a-old', '2026-09-10T10:00:00.000Z')];
    const incoming = [item('c-new', '2026-09-19T10:00:00.000Z'), item('b', '2026-09-18T10:00:00.000Z')];

    expect(mergePage(existing, incoming, 'refresh')).toEqual([
      item('c-new', '2026-09-19T10:00:00.000Z'),
      item('b', '2026-09-18T10:00:00.000Z'),
      item('a-old', '2026-09-10T10:00:00.000Z'),
    ]);
  });

  it('preserves the existing array reference when the refresh finds nothing new', () => {
    const existing = [item('a', '2026-09-19T10:00:00.000Z')];
    const incoming = [item('a', '2026-09-19T10:00:00.000Z')];

    expect(mergePage(existing, incoming, 'refresh')).toBe(existing);
  });
});
