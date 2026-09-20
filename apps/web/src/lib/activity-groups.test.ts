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

  // WR-B-06: the same instant must group under a different calendar day depending only on the
  // injected timeZone, with TODAY/YESTERDAY computed in that same zone -- never a mix of a UTC
  // todayKey and a locally-zoned dayKey. Both assertions below run in the same test file with the
  // zone injected explicitly, so the result is independent of the runner's own TZ (also verified
  // by running this suite twice with different `TZ=` env values -- see 05-32-SUMMARY.md).
  it('groups the same instant into TODAY under UTC and YESTERDAY under a zone 6 hours behind (viewer time zone injected explicitly)', () => {
    const now = new Date('2026-03-15T12:00:00.000Z');
    const eventAt = '2026-03-15T02:30:00.000Z';

    const utcGroups = groupByDay([item('evt', eventAt)], now, 'UTC');
    expect(utcGroups[0]?.label).toBe('TODAY');

    const mexicoCityGroups = groupByDay([item('evt', eventAt)], now, 'America/Mexico_City');
    expect(mexicoCityGroups[0]?.label).toBe('YESTERDAY');
  });

  it('groups the same instant under two distinct calendar-day abbreviated labels once "now" has moved far enough that neither zone reports TODAY/YESTERDAY', () => {
    const eventAt = '2026-03-15T02:30:00.000Z'; // 2026-03-14T20:30 in America/Mexico_City (UTC-6)
    const muchLaterNow = new Date('2026-03-20T12:00:00.000Z');

    const utcGroups = groupByDay([item('evt', eventAt)], muchLaterNow, 'UTC');
    const mexicoCityGroups = groupByDay([item('evt', eventAt)], muchLaterNow, 'America/Mexico_City');

    expect(utcGroups[0]?.label).toBe('MAR 15');
    expect(mexicoCityGroups[0]?.label).toBe('MAR 14');
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
  // Matches apps/web/src/app/(shell)/activity/page.tsx's own PAGE_LIMIT.
  const PAGE_LIMIT = 50;

  it('prepends genuinely new items without discarding already-loaded older pages, and reports contiguous (overlap present)', () => {
    const existing = [item('b', '2026-09-18T10:00:00.000Z'), item('a-old', '2026-09-10T10:00:00.000Z')];
    const incoming = [item('c-new', '2026-09-19T10:00:00.000Z'), item('b', '2026-09-18T10:00:00.000Z')];

    const result = mergePage(existing, incoming, 'refresh', PAGE_LIMIT);

    expect(result.contiguous).toBe(true);
    expect(result.items).toEqual([
      item('c-new', '2026-09-19T10:00:00.000Z'),
      item('b', '2026-09-18T10:00:00.000Z'),
      item('a-old', '2026-09-10T10:00:00.000Z'),
    ]);
  });

  it('preserves the existing array reference and reports contiguous when the refresh finds nothing new', () => {
    const existing = [item('a', '2026-09-19T10:00:00.000Z')];
    const incoming = [item('a', '2026-09-19T10:00:00.000Z')];

    const result = mergePage(existing, incoming, 'refresh', PAGE_LIMIT);

    expect(result.contiguous).toBe(true);
    expect(result.items).toBe(existing);
  });

  it('is contiguous when the incoming page is shorter than pageLimit, even with zero overlap (WR-B-05 behaviour spec, non-gap case)', () => {
    const existing = [item('newest-existing', '2026-09-19T10:00:00.000Z')];
    const incoming = [item('fresh-1', '2026-09-19T11:00:00.000Z'), item('fresh-2', '2026-09-19T10:30:00.000Z')];

    const result = mergePage(existing, incoming, 'refresh', PAGE_LIMIT);

    expect(result.contiguous).toBe(true);
    expect(result.items).toEqual([...incoming, ...existing]);
  });

  it('detects a gap when an exactly-pageLimit-sized incoming refresh page shares no id with existing (WR-B-05 reproduction)', () => {
    const existing = [item('newest-existing', '2026-09-19T10:00:00.000Z')];
    const incoming = Array.from({ length: PAGE_LIMIT }, (_, i) =>
      item(`fresh-${String(i)}`, new Date(Date.parse('2026-09-19T11:00:00.000Z') - i * 1000).toISOString()),
    );

    const result = mergePage(existing, incoming, 'refresh', PAGE_LIMIT);

    expect(result.contiguous).toBe(false);
  });
});
