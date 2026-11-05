// 30-01: pure helpers behind the metrics panels. No React, no fetch: everything a chart or a
// threshold pill decides is computed here and unit-tested.
import { HIGH_DISK_PERCENT, HIGH_MEMORY_PERCENT } from '@noodara/domain';
import { METRIC_SERIES_MAX_POINTS, type MetricSeries } from '@noodara/domain/api-contract';
import { PLACEHOLDER, type Tone } from '@noodara/ui';

export type MetricName = MetricSeries['metric'];
export type MetricUnit = 'percent' | 'count';

export function findSeries(series: readonly MetricSeries[], metric: MetricName): MetricSeries | null {
  return series.find((entry) => entry.metric === metric) ?? null;
}

/** The newest non-null value; a bucket without samples is never read as zero. */
export function latestValue(series: MetricSeries | null): number | null {
  if (series === null) return null;
  for (let index = series.points.length - 1; index >= 0; index -= 1) {
    const value = series.points[index]?.v;
    if (value !== null && value !== undefined) return value;
  }
  return null;
}

export function hasSamples(series: readonly MetricSeries[]): boolean {
  return series.some((entry) => entry.points.some((point) => point.v !== null));
}

/** The API caps a series at METRIC_SERIES_MAX_POINTS buckets; a full series was downsampled. */
export function isTruncated(series: readonly MetricSeries[]): boolean {
  return series.some((entry) => entry.points.length >= METRIC_SERIES_MAX_POINTS);
}

export function formatMetricValue(value: number | null, unit: MetricUnit): string {
  if (value === null || !Number.isFinite(value)) return PLACEHOLDER;
  if (unit === 'count') return String(Math.round(value));
  return `${(Math.round(value * 10) / 10).toString(10)}%`;
}

/** Semantic colour only for a crossed threshold; below it the value stays plain ink. */
export function thresholdTone(value: number | null, threshold: number): Tone | null {
  return value !== null && value >= threshold ? 'warn' : null;
}

export interface ServerThresholds {
  readonly highMemory: boolean;
  readonly highDisk: boolean;
}

/** Same thresholds the backend flags use (packages/domain thresholds.ts). */
export function serverThresholds(series: readonly MetricSeries[]): ServerThresholds {
  return {
    highMemory: thresholdTone(latestValue(findSeries(series, 'memory_percent')), HIGH_MEMORY_PERCENT) !== null,
    highDisk: thresholdTone(latestValue(findSeries(series, 'disk_used_percent')), HIGH_DISK_PERCENT) !== null,
  };
}

const UNREACHABLE_STATES = new Set(['UNREACHABLE', 'ERROR', 'DISCONNECTED']);

export function isUnreachable(connectionState: string): boolean {
  return UNREACHABLE_STATES.has(connectionState);
}

export interface ChartBox {
  readonly width: number;
  readonly height: number;
}

/** The y-axis top: 100 for a percentage, the series max (at least 1) for a count. */
export function chartMax(points: MetricSeries['points'], unit: MetricUnit): number {
  if (unit === 'percent') return 100;
  let max = 1;
  for (const point of points) if (point.v !== null && point.v > max) max = point.v;
  return max;
}

export function xAt(index: number, count: number, box: ChartBox): number {
  return count <= 1 ? box.width / 2 : (index * box.width) / (count - 1);
}

export function yAt(value: number, max: number, box: ChartBox): number {
  const clamped = Math.min(Math.max(value, 0), max);
  return box.height - (clamped / max) * box.height;
}

function round(value: number): string {
  return (Math.round(value * 100) / 100).toString(10);
}

/** One SVG path per run of samples: a null bucket breaks the line, it is never interpolated. */
export function linePaths(points: MetricSeries['points'], max: number, box: ChartBox): string[] {
  const paths: string[] = [];
  let current = '';
  points.forEach((point, index) => {
    if (point.v === null) {
      if (current !== '') paths.push(current);
      current = '';
      return;
    }
    const command = current === '' ? 'M' : 'L';
    current += `${command}${round(xAt(index, points.length, box))} ${round(yAt(point.v, max, box))}`;
  });
  if (current !== '') paths.push(current);
  return paths;
}

/** The bucket nearest a horizontal position (0..1 of the plot width), for the hover crosshair. */
export function nearestIndex(fraction: number, count: number): number | null {
  if (count === 0) return null;
  const clamped = Math.min(Math.max(fraction, 0), 1);
  return Math.round(clamped * (count - 1));
}
