'use client';

// 30-01 (A1/A2): a service's runtime status and metrics. Reads GET .../status and GET .../metrics
// together and refreshes once a minute. The status row shows the runtime status, container state,
// restarts, health check, and the last deployment; the charts show CPU, memory and restarts. The
// backend's highMemory/highDisk flags only add warn pills with words.
import { useCallback, useEffect, useState, type ReactNode } from 'react';
import { EmptyState, formatRelativeTime, Notice, PLACEHOLDER, TonePill, type Tone } from '@noodara/ui';
import {
  getServiceMetrics,
  getServiceStatus,
  type MetricSeries,
  type ServiceStatusSummary,
} from '../../lib/api/metrics-api';
import { deploymentStatusPresentation, serviceStatusPresentation, shortSha } from '../../lib/service-status-copy';
import { MetricChart } from './MetricChart';
import { findSeries, hasSamples, isTruncated } from './metric-view';
import { METRICS_COPY, METRICS_REFRESH_MS, MetricsHeading, MetricsLoadFailed, MetricsSkeleton } from './ServerMetricsPanel';

export const SERVICE_METRICS_COPY = Object.freeze({
  noContainer: 'No container',
  emptyServiceBody: 'Noodara collects a sample every minute while the container is running.',
  noDeployment: 'None yet',
  containerUnobserved:
    "Noodara hasn't observed this service's container yet. Check that the server is reachable.",
});

const CONTAINER_STATE = {
  created: { word: 'Created', tone: 'idle' },
  running: { word: 'Running', tone: 'ok' },
  paused: { word: 'Paused', tone: 'idle' },
  restarting: { word: 'Restarting', tone: 'warn' },
  removing: { word: 'Removing', tone: 'warn' },
  exited: { word: 'Exited', tone: 'error' },
  dead: { word: 'Dead', tone: 'error' },
} as const satisfies Record<string, { word: string; tone: Tone }>;

const HEALTH = {
  none: { word: 'No health check', tone: 'idle' },
  starting: { word: 'Starting', tone: 'warn' },
  healthy: { word: 'Healthy', tone: 'ok' },
  failing: { word: 'Failing', tone: 'error' },
  timeout: { word: 'Timed out', tone: 'error' },
} as const satisfies Record<string, { word: string; tone: Tone }>;

interface Presentation {
  readonly word: string;
  readonly tone: Tone;
}

/** An unknown value shows as itself on an idle pill: never a guess that it is fine. */
function lookup(table: Readonly<Record<string, Presentation>>, key: string): Presentation {
  return (Object.hasOwn(table, key) ? table[key] : undefined) ?? { word: key, tone: 'idle' };
}

interface ReadyView {
  readonly status: ServiceStatusSummary;
  readonly series: readonly MetricSeries[];
}

type PanelState = { readonly kind: 'loading' } | { readonly kind: 'error' } | { readonly kind: 'ready'; readonly view: ReadyView };

function Fact({ label, testId, children }: { readonly label: string; readonly testId: string; readonly children: ReactNode }) {
  return (
    <div className="flex flex-col gap-1">
      <dt className="text-caption text-ink-secondary">{label}</dt>
      <dd data-testid={testId} className="flex items-center gap-2 text-callout text-ink">
        {children}
      </dd>
    </div>
  );
}

export interface ServiceMetricsPanelProps {
  readonly projectId: string;
  readonly serviceId: string;
  readonly now: Date;
}

export function ServiceMetricsPanel({ projectId, serviceId, now }: ServiceMetricsPanelProps): ReactNode {
  const [state, setState] = useState<PanelState>({ kind: 'loading' });

  const load = useCallback(async () => {
    const [status, metrics] = await Promise.all([
      getServiceStatus(projectId, serviceId),
      getServiceMetrics(projectId, serviceId),
    ]);
    setState((prev) => {
      if (status.ok && metrics.ok) return { kind: 'ready', view: { status: status.data, series: metrics.data.series } };
      return prev.kind === 'ready' ? prev : { kind: 'error' };
    });
  }, [projectId, serviceId]);

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
    body = <MetricsSkeleton testId="service-metrics-loading" />;
  } else if (state.kind === 'error') {
    body = (
      <MetricsLoadFailed
        testId="service-metrics-error"
        onRetry={() => {
          setState({ kind: 'loading' });
          void load();
        }}
      />
    );
  } else {
    const { status, series } = state.view;
    const runtime = serviceStatusPresentation(status.runtimeStatus);
    const container = status.container;
    const containerState = container === null ? null : lookup(CONTAINER_STATE, container.state);
    const health = container === null ? null : lookup(HEALTH, container.healthcheck);
    const deployment = status.lastDeployment;
    const deploymentPresentation = deployment === null ? null : deploymentStatusPresentation(deployment.status);

    body = (
      <div className="flex flex-col gap-4">
        <dl className="grid grid-cols-2 gap-4 rounded-md border border-hairline bg-surface-1 p-5 md:grid-cols-5">
          <Fact label="Runtime status" testId="service-status-runtime">
            <TonePill tone={runtime.tone} label={runtime.word} data-testid="service-status-runtime-pill" />
          </Fact>
          <Fact label="Container" testId="service-status-container">
            {containerState === null ? (
              <span className="text-ink-tertiary">{SERVICE_METRICS_COPY.noContainer}</span>
            ) : (
              <TonePill tone={containerState.tone} label={containerState.word} data-testid="service-status-container-pill" />
            )}
          </Fact>
          <Fact label="Restarts" testId="service-status-restarts">
            <span className="font-mono tabular-nums">{container === null ? PLACEHOLDER : String(container.restartCount)}</span>
          </Fact>
          <Fact label="Health" testId="service-status-health">
            {health === null ? (
              <span className="text-ink-tertiary">{PLACEHOLDER}</span>
            ) : (
              <TonePill tone={health.tone} label={health.word} data-testid="service-status-health-pill" />
            )}
          </Fact>
          <Fact label="Last deployment" testId="service-status-last-deployment">
            {deployment === null || deploymentPresentation === null ? (
              <span className="text-ink-tertiary">{SERVICE_METRICS_COPY.noDeployment}</span>
            ) : (
              <>
                <TonePill tone={deploymentPresentation.tone} label={deploymentPresentation.word} data-testid="service-status-deployment-pill" />
                <span className="font-mono text-ink-secondary">{shortSha(deployment.commitSha)}</span>
                {deployment.finishedAt === null ? null : (
                  <span className="text-ink-tertiary">{formatRelativeTime(deployment.finishedAt, now)}</span>
                )}
              </>
            )}
          </Fact>
        </dl>
        {status.flags.highDisk ? (
          <div>
            <TonePill tone="warn" label={METRICS_COPY.highDisk} data-testid="service-status-high-disk" />
          </div>
        ) : null}
        {container === null && status.runtimeStatus !== 'NEVER_DEPLOYED' ? (
          <Notice data-testid="service-metrics-unobserved" message={SERVICE_METRICS_COPY.containerUnobserved} />
        ) : null}
        {hasSamples(series) ? (
          <>
            <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
              <MetricChart data-testid="service-metric-cpu" title="CPU" unit="percent" series={findSeries(series, 'cpu_percent')} />
              <MetricChart
                data-testid="service-metric-memory"
                title="Memory"
                unit="percent"
                series={findSeries(series, 'memory_percent')}
                alert={status.flags.highMemory ? METRICS_COPY.highMemory : null}
              />
              <MetricChart data-testid="service-metric-restarts" title="Restarts" unit="count" series={findSeries(series, 'restart_count')} />
            </div>
            {isTruncated(series) ? (
              <p data-testid="service-metrics-truncated" className="text-caption text-ink-tertiary">
                {METRICS_COPY.truncated}
              </p>
            ) : null}
          </>
        ) : (
          <EmptyState data-testid="service-metrics-empty" title={METRICS_COPY.emptyTitle} body={SERVICE_METRICS_COPY.emptyServiceBody} />
        )}
      </div>
    );
  }

  return (
    <section data-testid="service-metrics" aria-label="Status and metrics" className="flex flex-col gap-3">
      <MetricsHeading>Status and metrics</MetricsHeading>
      {body}
    </section>
  );
}
