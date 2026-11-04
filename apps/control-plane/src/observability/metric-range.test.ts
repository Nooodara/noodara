import { describe, expect, it } from 'vitest';
import {
  METRIC_DEFAULT_SPAN_MS,
  METRIC_MIN_INTERVAL_SECONDS,
  METRIC_POINTS_DEFAULT,
  METRIC_POINTS_MAX,
  METRIC_RANGE_SKEW_MS,
  fillBuckets,
  parseMetricRange,
  planBuckets,
} from './metric-range.js';

const HOUR = 3_600_000;
const NOW = Date.parse('2026-11-04T12:00:30.000Z');
const RETENTION = 168 * HOUR;
const opts = { nowMs: NOW, retentionMs: RETENTION };
const iso = (ms: number): string => new Date(ms).toISOString();

function issuesOf(query: Parameters<typeof parseMetricRange>[0]) {
  const result = parseMetricRange(query, opts);
  if (result.ok) throw new Error('expected an invalid range');
  return result.issues;
}

describe('parseMetricRange (H1)', () => {
  it('defaults to the last hour ending now with the default points cap', () => {
    expect(parseMetricRange({}, opts)).toEqual({
      ok: true,
      range: { fromMs: NOW - METRIC_DEFAULT_SPAN_MS, toMs: NOW, points: METRIC_POINTS_DEFAULT },
    });
  });

  it('a lone `to` gets the default span, a lone `from` ends now', () => {
    const to = NOW - 2 * HOUR;
    expect(parseMetricRange({ to: iso(to) }, opts)).toMatchObject({ ok: true, range: { fromMs: to - HOUR, toMs: to } });
    const from = NOW - 3 * HOUR;
    expect(parseMetricRange({ from: iso(from) }, opts)).toMatchObject({ ok: true, range: { fromMs: from, toMs: NOW } });
  });

  it('the default span never exceeds the retention', () => {
    const result = parseMetricRange({}, { nowMs: NOW, retentionMs: HOUR / 2 });
    expect(result).toMatchObject({ ok: true, range: { fromMs: NOW - HOUR / 2, toMs: NOW } });
  });

  it('accepts explicit offsets and bounded points', () => {
    const result = parseMetricRange({ from: '2026-11-04T10:00:00+02:00', to: '2026-11-04T11:00:00Z', points: '500' }, opts);
    expect(result).toEqual({
      ok: true,
      range: { fromMs: Date.parse('2026-11-04T08:00:00Z'), toMs: Date.parse('2026-11-04T11:00:00Z'), points: 500 },
    });
  });

  it.each([
    [{ from: 'yesterday' }, 'from'],
    [{ from: '2026-11-04' }, 'from'],
    [{ to: '2026-11-04T10:00:00' }, 'to'],
    [{ to: '' }, 'to'],
    [{ points: '0' }, 'points'],
    [{ points: '-1' }, 'points'],
    [{ points: '1.5' }, 'points'],
    [{ points: String(METRIC_POINTS_MAX + 1) }, 'points'],
    [{ points: '1e2' }, 'points'],
  ])('rejects a malformed value %j on %s', (query, path) => {
    expect(issuesOf(query).map((issue) => issue.path)).toContain(path);
  });

  it('rejects from >= to', () => {
    expect(issuesOf({ from: iso(NOW - HOUR), to: iso(NOW - HOUR) })).toEqual([{ path: 'from', message: 'from must be before to' }]);
    expect(issuesOf({ from: iso(NOW - HOUR), to: iso(NOW - 2 * HOUR) })[0]?.path).toBe('from');
  });

  it('rejects a span longer than the retention and a from older than the retention', () => {
    expect(issuesOf({ from: iso(NOW - RETENTION - HOUR), to: iso(NOW) }).map((issue) => issue.path)).toEqual(['to', 'from']);
    expect(issuesOf({ from: iso(NOW - RETENTION - METRIC_RANGE_SKEW_MS - 1), to: iso(NOW - RETENTION + HOUR) })).toEqual([
      { path: 'from', message: 'from is older than the metrics retention' },
    ]);
    // Exactly the retention (a client clock slightly behind) is fine.
    expect(parseMetricRange({ from: iso(NOW - RETENTION), to: iso(NOW) }, opts).ok).toBe(true);
  });

  it('rejects a to in the future beyond the clock skew allowance', () => {
    expect(parseMetricRange({ to: iso(NOW + METRIC_RANGE_SKEW_MS) }, opts).ok).toBe(true);
    expect(issuesOf({ to: iso(NOW + METRIC_RANGE_SKEW_MS + 1) })).toEqual([{ path: 'to', message: 'to is in the future' }]);
  });
});

describe('planBuckets (H1)', () => {
  it('aligns buckets to the interval on the epoch, so the same query gives the same buckets', () => {
    const range = { fromMs: Date.parse('2026-11-04T10:00:17Z'), toMs: Date.parse('2026-11-04T11:00:17Z'), points: 120 };
    const plan = planBuckets(range);
    expect(plan).toEqual(planBuckets({ ...range }));
    expect(plan.intervalSeconds).toBe(METRIC_MIN_INTERVAL_SECONDS);
    expect(plan.startMs).toBe(Date.parse('2026-11-04T10:00:00Z'));
    expect(plan.startMs % (plan.intervalSeconds * 1000)).toBe(0);
    expect(plan.count).toBe(61);
  });

  it('two overlapping queries share bucket boundaries', () => {
    const a = planBuckets({ fromMs: Date.parse('2026-11-04T10:00:05Z'), toMs: Date.parse('2026-11-04T11:00:00Z'), points: 100 });
    const b = planBuckets({ fromMs: Date.parse('2026-11-04T10:20:41Z'), toMs: Date.parse('2026-11-04T11:19:00Z'), points: 100 });
    expect(a.intervalSeconds).toBe(b.intervalSeconds);
    expect((b.startMs - a.startMs) % (a.intervalSeconds * 1000)).toBe(0);
  });

  it('never exceeds the points cap, across spans and caps', () => {
    for (const span of [1_000, 59_000, HOUR, 6 * HOUR, 24 * HOUR, 7 * 24 * HOUR, 720 * HOUR]) {
      for (const points of [1, 2, 3, 7, 60, 120, 499, METRIC_POINTS_MAX]) {
        const fromMs = NOW - span - 12_345;
        const plan = planBuckets({ fromMs, toMs: fromMs + span, points });
        expect(plan.count).toBeLessThanOrEqual(points);
        expect(plan.count).toBeGreaterThanOrEqual(1);
        expect(plan.startMs).toBeLessThanOrEqual(fromMs);
        expect(plan.startMs + plan.count * plan.intervalSeconds * 1000).toBeGreaterThanOrEqual(fromMs + span);
        expect(plan.startMs % (plan.intervalSeconds * 1000)).toBe(0);
        expect(plan.intervalSeconds).toBeGreaterThanOrEqual(METRIC_MIN_INTERVAL_SECONDS);
      }
    }
  });

  it('picks a coarser interval for a longer span', () => {
    const day = planBuckets({ fromMs: NOW - 24 * HOUR, toMs: NOW, points: 120 });
    expect(day.intervalSeconds).toBeGreaterThan(METRIC_MIN_INTERVAL_SECONDS);
    expect(day.count).toBeLessThanOrEqual(120);
  });
});

describe('fillBuckets (H1)', () => {
  const plan = { startMs: Date.parse('2026-11-04T10:00:00Z'), intervalSeconds: 60, count: 4 };

  it('an empty series is every bucket as null', () => {
    expect(fillBuckets(plan, [])).toEqual([
      { t: '2026-11-04T10:00:00.000Z', v: null },
      { t: '2026-11-04T10:01:00.000Z', v: null },
      { t: '2026-11-04T10:02:00.000Z', v: null },
      { t: '2026-11-04T10:03:00.000Z', v: null },
    ]);
  });

  it('a single point lands in its bucket and the rest stay null', () => {
    expect(fillBuckets(plan, [{ bucket: 2, value: 41.5 }]).map((point) => point.v)).toEqual([null, null, 41.5, null]);
  });

  it('gaps are null, never interpolated or zero-filled; a null aggregate stays null', () => {
    const points = fillBuckets(plan, [
      { bucket: 0, value: 10 },
      { bucket: 1, value: null },
      { bucket: 3, value: 30 },
    ]);
    expect(points.map((point) => point.v)).toEqual([10, null, null, 30]);
  });

  it('ignores buckets outside the plan and non-finite values', () => {
    const points = fillBuckets(plan, [
      { bucket: -1, value: 1 },
      { bucket: 4, value: 2 },
      { bucket: 1.5, value: 3 },
      { bucket: 0, value: Number.NaN },
    ]);
    expect(points.map((point) => point.v)).toEqual([null, null, null, null]);
  });
});
