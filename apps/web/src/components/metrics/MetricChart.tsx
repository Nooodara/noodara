'use client';

// 30-01: one metric over time (dataviz: change over time -> a single-series line). One series per
// chart, so no legend: the title names it. The line wears the one accent token (both themes come
// from tokens.css); text stays in ink tokens; grid is a recessive hairline. A null bucket breaks
// the line (never interpolated). Hover shows a crosshair and a tooltip with time and value; the
// same data is in a visually hidden table for screen readers. A crossed threshold adds a warn
// pill with a word, so state is never colour-only.
import { useState, type PointerEvent, type ReactNode } from 'react';
import type { MetricSeries } from '@noodara/domain/api-contract';
import { formatIso, TonePill } from '@noodara/ui';
import {
  chartMax,
  formatMetricValue,
  latestValue,
  linePaths,
  nearestIndex,
  xAt,
  yAt,
  type MetricUnit,
} from './metric-view';

const BOX = { width: 600, height: 120 } as const;

export interface MetricChartProps {
  readonly title: string;
  readonly series: MetricSeries | null;
  readonly unit: MetricUnit;
  /** A crossed threshold: the word for the warn pill ("High memory"), or null. */
  readonly alert?: string | null;
  readonly 'data-testid'?: string;
}

export function MetricChart({ title, series, unit, alert = null, 'data-testid': testId }: MetricChartProps): ReactNode {
  const [hover, setHover] = useState<number | null>(null);
  const points = series?.points ?? [];
  const max = chartMax(points, unit);
  const paths = linePaths(points, max, BOX);
  const latest = latestValue(series);
  const hovered = hover === null ? null : (points[hover] ?? null);

  const onMove = (event: PointerEvent<SVGSVGElement>) => {
    const rect = event.currentTarget.getBoundingClientRect();
    setHover(rect.width > 0 ? nearestIndex((event.clientX - rect.left) / rect.width, points.length) : null);
  };

  return (
    <figure
      data-testid={testId}
      data-alert={alert === null ? 'false' : 'true'}
      className="flex flex-col gap-3 rounded-md border border-hairline bg-surface-1 p-5"
    >
      <figcaption className="flex items-center justify-between gap-3">
        <span className="text-label uppercase text-ink-secondary">{title}</span>
        <span className="flex items-center gap-2">
          {alert === null ? null : <TonePill tone="warn" label={alert} data-testid={`${testId ?? 'metric'}-alert`} />}
          <span data-testid={`${testId ?? 'metric'}-latest`} className="font-mono text-headline tabular-nums text-ink">
            {formatMetricValue(latest, unit)}
          </span>
        </span>
      </figcaption>
      {paths.length === 0 ? (
        <p data-testid={`${testId ?? 'metric'}-empty`} className="text-callout text-ink-tertiary">
          No samples in this range.
        </p>
      ) : (
        <div className="relative">
          <svg
            viewBox={`0 0 ${String(BOX.width)} ${String(BOX.height)}`}
            preserveAspectRatio="none"
            role="img"
            aria-label={`${title}, latest ${formatMetricValue(latest, unit)}`}
            className="h-28 w-full overflow-visible"
            onPointerMove={onMove}
            onPointerLeave={() => {
              setHover(null);
            }}
          >
            <line x1={0} x2={BOX.width} y1={BOX.height} y2={BOX.height} className="stroke-hairline-strong" strokeWidth={1} vectorEffect="non-scaling-stroke" />
            <line x1={0} x2={BOX.width} y1={0} y2={0} className="stroke-hairline" strokeWidth={1} vectorEffect="non-scaling-stroke" />
            {paths.map((d) => (
              <path
                key={d}
                d={d}
                fill="none"
                className="stroke-accent"
                strokeWidth={2}
                strokeLinecap="round"
                strokeLinejoin="round"
                vectorEffect="non-scaling-stroke"
              />
            ))}
            {hover !== null && hovered !== null ? (
              <line
                data-testid={`${testId ?? 'metric'}-crosshair`}
                x1={xAt(hover, points.length, BOX)}
                x2={xAt(hover, points.length, BOX)}
                y1={0}
                y2={BOX.height}
                className="stroke-ink-tertiary"
                strokeWidth={1}
                vectorEffect="non-scaling-stroke"
              />
            ) : null}
            {hover !== null && hovered?.v != null ? (
              <circle
                cx={xAt(hover, points.length, BOX)}
                cy={yAt(hovered.v, max, BOX)}
                r={4}
                className="fill-accent stroke-surface-1"
                strokeWidth={2}
                vectorEffect="non-scaling-stroke"
              />
            ) : null}
          </svg>
          {hovered === null ? null : (
            <div
              data-testid={`${testId ?? 'metric'}-tooltip`}
              role="presentation"
              className="pointer-events-none absolute top-0 right-0 rounded-sm border border-hairline bg-surface-elevated px-2 py-1 text-caption text-ink"
            >
              <span className="font-mono tabular-nums">{formatMetricValue(hovered.v, unit)}</span>
              <span className="ml-2 text-ink-secondary">{formatIso(hovered.t)}</span>
            </div>
          )}
          <div className="mt-1 flex justify-between text-caption text-ink-tertiary">
            <span>{series === null ? '' : formatIso(series.from)}</span>
            <span>{series === null ? '' : formatIso(series.to)}</span>
          </div>
        </div>
      )}
      <table className="sr-only">
        <caption>{title}</caption>
        <thead>
          <tr>
            <th scope="col">Time</th>
            <th scope="col">Value</th>
          </tr>
        </thead>
        <tbody>
          {points
            .filter((point) => point.v !== null)
            .map((point) => (
              <tr key={point.t}>
                <td>{point.t}</td>
                <td>{formatMetricValue(point.v, unit)}</td>
              </tr>
            ))}
        </tbody>
      </table>
    </figure>
  );
}
