import type { MetricSeries } from '@noodara/domain/api-contract';
import { describe, expect, it } from 'vitest';
import {
  chartMax,
  findSeries,
  formatMetricValue,
  hasSamples,
  isTruncated,
  isUnreachable,
  latestValue,
  linePaths,
  nearestIndex,
  serverThresholds,
  thresholdTone,
} from './metric-view';

function series(metric: MetricSeries['metric'], values: readonly (number | null)[]): MetricSeries {
  return {
    scope: 'server',
    entityId: '11111111-1111-4111-8111-111111111111',
    metric,
    from: '2026-11-05T10:00:00.000Z',
    to: '2026-11-05T11:00:00.000Z',
    intervalSeconds: 60,
    points: values.map((v, index) => ({ t: new Date(Date.UTC(2026, 10, 5, 10, index)).toISOString(), v })),
  };
}

const BOX = { width: 100, height: 50 };

describe('metric-view', () => {
  it('finds a series by metric name, or null', () => {
    const cpu = series('cpu_percent', [1]);
    expect(findSeries([cpu], 'cpu_percent')).toBe(cpu);
    expect(findSeries([cpu], 'memory_percent')).toBeNull();
  });

  it('reads the newest non-null value and never turns a gap into zero', () => {
    expect(latestValue(series('cpu_percent', [10, 20, null]))).toBe(20);
    expect(latestValue(series('cpu_percent', [null, null]))).toBeNull();
    expect(latestValue(null)).toBeNull();
  });

  it('knows when there are no samples at all', () => {
    expect(hasSamples([series('cpu_percent', [null])])).toBe(false);
    expect(hasSamples([])).toBe(false);
    expect(hasSamples([series('cpu_percent', [null, 3])])).toBe(true);
  });

  it('flags a series at the API point cap as truncated', () => {
    expect(isTruncated([series('cpu_percent', new Array<number>(500).fill(1))])).toBe(true);
    expect(isTruncated([series('cpu_percent', [1, 2])])).toBe(false);
  });

  it('formats percentages and counts, with a placeholder for no value', () => {
    expect(formatMetricValue(42.345, 'percent')).toBe('42.3%');
    expect(formatMetricValue(3, 'count')).toBe('3');
    expect(formatMetricValue(null, 'percent')).toBe('—');
    expect(formatMetricValue(Number.NaN, 'count')).toBe('—');
  });

  it('uses a warn tone at or above the threshold and nothing below it', () => {
    expect(thresholdTone(90, 90)).toBe('warn');
    expect(thresholdTone(89.9, 90)).toBeNull();
    expect(thresholdTone(null, 90)).toBeNull();
  });

  it('derives server high memory and high disk from the latest values', () => {
    expect(serverThresholds([series('memory_percent', [95, 50]), series('disk_used_percent', [91])])).toEqual({
      highMemory: false,
      highDisk: true,
    });
    expect(serverThresholds([])).toEqual({ highMemory: false, highDisk: false });
  });

  it('treats unreachable, error and disconnected servers as unreachable', () => {
    expect(isUnreachable('UNREACHABLE')).toBe(true);
    expect(isUnreachable('ERROR')).toBe(true);
    expect(isUnreachable('DISCONNECTED')).toBe(true);
    expect(isUnreachable('CONNECTED')).toBe(false);
  });

  it('scales percentages to 100 and counts to their max', () => {
    expect(chartMax(series('cpu_percent', [5]).points, 'percent')).toBe(100);
    expect(chartMax(series('restart_count', [0, 4, null]).points, 'count')).toBe(4);
    expect(chartMax(series('restart_count', [0]).points, 'count')).toBe(1);
  });

  it('breaks the line at a gap instead of interpolating', () => {
    const paths = linePaths(series('cpu_percent', [0, 100, null, 50, 50]).points, 100, BOX);
    expect(paths).toEqual(['M0 50L25 0', 'M75 25L100 25']);
  });

  it('draws a single sample in the middle and clamps out-of-range values', () => {
    expect(linePaths(series('cpu_percent', [150]).points, 100, BOX)).toEqual(['M50 0']);
    expect(linePaths(series('cpu_percent', [null]).points, 100, BOX)).toEqual([]);
  });

  it('maps a hover position to the nearest bucket', () => {
    expect(nearestIndex(0.5, 5)).toBe(2);
    expect(nearestIndex(-1, 5)).toBe(0);
    expect(nearestIndex(2, 5)).toBe(4);
    expect(nearestIndex(0.5, 0)).toBeNull();
  });
});
