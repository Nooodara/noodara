'use client';

// 30-01 (A1/A2): the server's metrics -- connection state, uptime, and CPU, memory and disk over
// the default range. Reads GET /api/servers/:id/metrics and refreshes once a minute (the sample
// interval). Every state has its own copy: loading (skeleton), failed read, no samples yet,
// unreachable server (the last samples stay visible) and a downsampled range. High memory and
// high disk only add a warn pill with a word, never decorative colour.
import { useCallback, useEffect, useState, type ReactNode } from 'react';
import { SERVER_STATUSES, type ServerStatus } from '@noodara/domain/server';
import { Button, EmptyState, formatRelativeTime, formatUptime, Notice, Skeleton, StatusPill } from '@noodara/ui';
import { getServerMetrics, type ServerMetricsView } from '../../lib/api/metrics-api';
import { MetricChart } from './MetricChart';
import { findSeries, hasSamples, isTruncated, isUnreachable, serverThresholds } from './metric-view';

export const METRICS_REFRESH_MS = 60_000;

export const METRICS_COPY = Object.freeze({
  loadFailed: "Couldn't load metrics. Check your connection and try again.",
  emptyTitle: 'No metrics yet.',
  emptyServerBody: 'Noodara collects a sample every minute once the server is connected.',
  unreachable: "Noodara can't reach this server right now. The charts show the last samples it collected.",
  truncated: 'This range has more samples than fit on a chart, so they are averaged into 500 points.',
  highMemory: 'High memory',
  highDisk: 'High disk',
});

type PanelState =
  | { readonly kind: 'loading' }
  | { readonly kind: 'error' }
  | { readonly kind: 'ready'; readonly view: ServerMetricsView };

function isServerStatus(value: string): value is ServerStatus {
  return (SERVER_STATUSES as readonly string[]).includes(value);
}

export function MetricsHeading({ children }: { readonly children: ReactNode }): ReactNode {
  return <h3 className="text-label uppercase text-ink-secondary">{children}</h3>;
}

export function MetricsSkeleton({ testId }: { readonly testId: string }): ReactNode {
  return (
    <div data-testid={testId} className="grid grid-cols-1 gap-4 md:grid-cols-3">
      <Skeleton width="100%" height="10rem" />
      <Skeleton width="100%" height="10rem" />
      <Skeleton width="100%" height="10rem" />
    </div>
  );
}

export function MetricsLoadFailed({ testId, onRetry }: { readonly testId: string; readonly onRetry: () => void }): ReactNode {
  return (
    <div data-testid={testId} className="flex flex-col items-start gap-3">
      <p className="text-body text-ink">{METRICS_COPY.loadFailed}</p>
      <Button type="button" variant="secondary" onClick={onRetry}>
        Try again
      </Button>
    </div>
  );
}

export interface ServerMetricsPanelProps {
  readonly serverId: string;
  readonly now: Date;
}

export function ServerMetricsPanel({ serverId, now }: ServerMetricsPanelProps): ReactNode {
  const [state, setState] = useState<PanelState>({ kind: 'loading' });

  const load = useCallback(async () => {
    const result = await getServerMetrics(serverId);
    setState((prev) => {
      if (result.ok) return { kind: 'ready', view: result.data };
      // A failed refresh keeps the last good view on screen.
      return prev.kind === 'ready' ? prev : { kind: 'error' };
    });
  }, [serverId]);

  useEffect(() => {
    void load();
    const timer = setInterval(() => {
      void load();
    }, METRICS_REFRESH_MS);
    return () => {
      clearInterval(timer);
    };
  }, [load]);

  let body: ReactNode;
  if (state.kind === 'loading') {
    body = <MetricsSkeleton testId="server-metrics-loading" />;
  } else if (state.kind === 'error') {
    body = (
      <MetricsLoadFailed
        testId="server-metrics-error"
        onRetry={() => {
          setState({ kind: 'loading' });
          void load();
        }}
      />
    );
  } else {
    const { series, server } = state.view;
    const thresholds = serverThresholds(series);
    const connection = server.connectionState;
    body = (
      <div className="flex flex-col gap-4">
        <dl className="flex flex-wrap items-center gap-x-8 gap-y-2 text-callout">
          <div className="flex items-center gap-2">
            <dt className="text-ink-secondary">Connection</dt>
            <dd data-testid="server-metrics-connection">
              {isServerStatus(connection) ? <StatusPill status={connection} /> : connection}
            </dd>
          </div>
          <div className="flex items-center gap-2">
            <dt className="text-ink-secondary">Uptime</dt>
            <dd data-testid="server-metrics-uptime" className="font-mono tabular-nums text-ink">
              {formatUptime(server.uptimeSeconds)}
            </dd>
          </div>
          <div className="flex items-center gap-2">
            <dt className="text-ink-secondary">Last sample</dt>
            <dd data-testid="server-metrics-sampled" className="text-ink">
              {formatRelativeTime(server.sampledAt, now)}
            </dd>
          </div>
        </dl>
        {isUnreachable(connection) ? <Notice data-testid="server-metrics-unreachable" message={METRICS_COPY.unreachable} /> : null}
        {hasSamples(series) ? (
          <>
            <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
              <MetricChart data-testid="server-metric-cpu" title="CPU" unit="percent" series={findSeries(series, 'cpu_percent')} />
              <MetricChart
                data-testid="server-metric-memory"
                title="Memory"
                unit="percent"
                series={findSeries(series, 'memory_percent')}
                alert={thresholds.highMemory ? METRICS_COPY.highMemory : null}
              />
              <MetricChart
                data-testid="server-metric-disk"
                title="Disk"
                unit="percent"
                series={findSeries(series, 'disk_used_percent')}
                alert={thresholds.highDisk ? METRICS_COPY.highDisk : null}
              />
            </div>
            {isTruncated(series) ? (
              <p data-testid="server-metrics-truncated" className="text-caption text-ink-tertiary">
                {METRICS_COPY.truncated}
              </p>
            ) : null}
          </>
        ) : (
          <EmptyState data-testid="server-metrics-empty" title={METRICS_COPY.emptyTitle} body={METRICS_COPY.emptyServerBody} />
        )}
      </div>
    );
  }

  return (
    <section data-testid="server-metrics" aria-label="Metrics" className="flex flex-col gap-3">
      <MetricsHeading>Metrics</MetricsHeading>
      {body}
    </section>
  );
}
