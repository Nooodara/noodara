// 27-03 (H1): pure range validation and bucket planning for the metrics API.
// - A range is [from, to), from < to, span <= retention, from no older than the retention and to
//   not in the future (both with a small clock-skew allowance).
// - Buckets are aligned to the interval on the Unix epoch, so the same query (and any overlapping
//   query with the same interval) gets the same bucket boundaries.
// - A bucket without samples is null: gaps are never interpolated or zero-filled.
import { METRIC_SERIES_MAX_POINTS } from '@noodara/domain/api-contract';
import { z } from 'zod';

export const METRIC_POINTS_DEFAULT = 120;
export const METRIC_POINTS_MAX = METRIC_SERIES_MAX_POINTS;
export const METRIC_DEFAULT_SPAN_MS = 3_600_000;
/** Allowance for a client clock ahead of or behind the control plane. */
export const METRIC_RANGE_SKEW_MS = 5 * 60_000;
/** Samples arrive every 30-300 s; a finer bucket would only add empty buckets. */
export const METRIC_MIN_INTERVAL_SECONDS = 60;
const INTERVAL_LADDER_SECONDS = [60, 120, 300, 600, 900, 1800, 3600, 7200, 10_800, 21_600, 43_200, 86_400] as const;

export interface MetricRangeQuery {
  readonly from?: string | undefined;
  readonly to?: string | undefined;
  readonly points?: string | undefined;
}

export interface MetricRange {
  readonly fromMs: number;
  readonly toMs: number;
  readonly points: number;
}

export interface MetricRangeIssue {
  readonly path: 'from' | 'to' | 'points';
  readonly message: string;
}

export type MetricRangeResult =
  | { readonly ok: true; readonly range: MetricRange }
  | { readonly ok: false; readonly issues: readonly MetricRangeIssue[] };

export interface MetricRangeOptions {
  readonly nowMs: number;
  readonly retentionMs: number;
}

const IsoTimestamp = z.iso.datetime({ offset: true });
const POINTS_PATTERN = /^[1-9]\d{0,3}$/;

function parseTimestamp(value: string | undefined): number | null | undefined {
  if (value === undefined) return undefined;
  if (!IsoTimestamp.safeParse(value).success) return null;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : null;
}

function parsePoints(value: string | undefined): number | null {
  if (value === undefined) return METRIC_POINTS_DEFAULT;
  if (!POINTS_PATTERN.test(value)) return null;
  const points = Number(value);
  return points <= METRIC_POINTS_MAX ? points : null;
}

export function parseMetricRange(query: MetricRangeQuery, options: MetricRangeOptions): MetricRangeResult {
  const issues: MetricRangeIssue[] = [];
  const from = parseTimestamp(query.from);
  const to = parseTimestamp(query.to);
  const points = parsePoints(query.points);
  if (from === null) issues.push({ path: 'from', message: 'from must be an ISO 8601 timestamp with an offset' });
  if (to === null) issues.push({ path: 'to', message: 'to must be an ISO 8601 timestamp with an offset' });
  if (points === null) {
    issues.push({ path: 'points', message: `points must be an integer from 1 to ${METRIC_POINTS_MAX.toString()}` });
  }
  if (from === null || to === null || points === null) return { ok: false, issues };

  const defaultSpan = Math.min(METRIC_DEFAULT_SPAN_MS, options.retentionMs);
  const toMs = to ?? options.nowMs;
  const fromMs = from ?? toMs - defaultSpan;

  if (fromMs >= toMs) {
    issues.push({ path: 'from', message: 'from must be before to' });
  } else if (toMs - fromMs > options.retentionMs) {
    issues.push({ path: 'to', message: 'the range is longer than the metrics retention' });
  }
  if (fromMs < options.nowMs - options.retentionMs - METRIC_RANGE_SKEW_MS) {
    issues.push({ path: 'from', message: 'from is older than the metrics retention' });
  }
  if (toMs > options.nowMs + METRIC_RANGE_SKEW_MS) issues.push({ path: 'to', message: 'to is in the future' });
  return issues.length > 0 ? { ok: false, issues } : { ok: true, range: { fromMs, toMs, points } };
}

export interface BucketPlan {
  /** Start of the first bucket, a multiple of the interval (<= from). */
  readonly startMs: number;
  readonly intervalSeconds: number;
  /** Buckets until `to` is covered; never more than the requested points. */
  readonly count: number;
}

function bucketsFor(range: MetricRange, stepMs: number): { startMs: number; count: number } {
  const startMs = Math.floor(range.fromMs / stepMs) * stepMs;
  return { startMs, count: Math.max(1, Math.ceil((range.toMs - startMs) / stepMs)) };
}

/** The smallest interval from a fixed ladder (then doubling) whose aligned buckets fit the cap. */
export function planBuckets(range: MetricRange): BucketPlan {
  for (const seconds of INTERVAL_LADDER_SECONDS) {
    const plan = bucketsFor(range, seconds * 1000);
    if (plan.count <= range.points) return { ...plan, intervalSeconds: seconds };
  }
  const last = INTERVAL_LADDER_SECONDS[INTERVAL_LADDER_SECONDS.length - 1] ?? METRIC_MIN_INTERVAL_SECONDS;
  const spanSeconds = Math.ceil((range.toMs - range.fromMs) / 1000);
  let seconds = Math.max(last, Math.ceil(spanSeconds / Math.max(1, range.points - 1)));
  for (;;) {
    const plan = bucketsFor(range, seconds * 1000);
    if (plan.count <= range.points) return { ...plan, intervalSeconds: seconds };
    seconds *= 2;
  }
}

export interface BucketValue {
  /** Zero-based bucket index from `plan.startMs`. */
  readonly bucket: number;
  readonly value: number | null;
}

export interface MetricPoint {
  readonly t: string;
  readonly v: number | null;
}

/** One point per bucket; a bucket without an aggregate (or a non-finite one) is null. */
export function fillBuckets(plan: BucketPlan, values: readonly BucketValue[]): MetricPoint[] {
  const byBucket = new Map<number, number>();
  for (const { bucket, value } of values) {
    if (!Number.isInteger(bucket) || bucket < 0 || bucket >= plan.count) continue;
    if (value === null || !Number.isFinite(value)) continue;
    byBucket.set(bucket, value);
  }
  const stepMs = plan.intervalSeconds * 1000;
  return Array.from({ length: plan.count }, (_, bucket) => ({
    t: new Date(plan.startMs + bucket * stepMs).toISOString(),
    v: byBucket.get(bucket) ?? null,
  }));
}
