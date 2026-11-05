import { beforeEach, describe, expect, it, vi } from 'vitest';
import { renderUi, screen } from '@noodara/ui/testing';
import type { MetricSeries, ServiceStatusSummary } from '@noodara/domain/api-contract';
import { METRICS_COPY } from './ServerMetricsPanel';
import { SERVICE_METRICS_COPY, ServiceMetricsPanel } from './ServiceMetricsPanel';

const PRJ = '22222222-2222-4222-8222-222222222222';
const SVC = '33333333-3333-4333-8333-333333333333';
const DEP = '44444444-4444-4444-8444-444444444444';
const NOW = new Date('2026-11-05T11:00:00.000Z');

const api = vi.hoisted(() => ({ getServiceMetrics: vi.fn(), getServiceStatus: vi.fn() }));
vi.mock('../../lib/api/metrics-api', () => ({
  getServiceMetrics: (...a: unknown[]) => api.getServiceMetrics(...a) as unknown,
  getServiceStatus: (...a: unknown[]) => api.getServiceStatus(...a) as unknown,
}));

function series(metric: MetricSeries['metric'], values: readonly (number | null)[]): MetricSeries {
  return {
    scope: 'service',
    entityId: SVC,
    metric,
    from: '2026-11-05T10:00:00.000Z',
    to: '2026-11-05T11:00:00.000Z',
    intervalSeconds: 60,
    points: values.map((v, index) => ({ t: new Date(Date.UTC(2026, 10, 5, 10, index)).toISOString(), v })),
  };
}

function status(overrides: Partial<ServiceStatusSummary> = {}): ServiceStatusSummary {
  return {
    serviceId: SVC,
    runtimeStatus: 'RUNNING',
    container: { state: 'running', restartCount: 3, healthcheck: 'healthy', observedAt: '2026-11-05T10:59:00.000Z' },
    lastDeployment: { id: DEP, status: 'SUCCESS', commitSha: 'abcdef1234567', finishedAt: '2026-11-05T10:00:00.000Z' },
    flags: { highMemory: false, highDisk: false },
    ...overrides,
  };
}

const SERIES = [series('cpu_percent', [1, 2]), series('memory_percent', [30]), series('restart_count', [0, 3])];

function respond(summary: ServiceStatusSummary, list: MetricSeries[] = SERIES) {
  api.getServiceStatus.mockResolvedValue({ ok: true, data: summary });
  api.getServiceMetrics.mockResolvedValue({ ok: true, data: { series: list } });
}

beforeEach(() => {
  api.getServiceMetrics.mockReset();
  api.getServiceStatus.mockReset();
});

describe('ServiceMetricsPanel', () => {
  it('shows a skeleton while loading', () => {
    api.getServiceStatus.mockReturnValue(new Promise(() => undefined));
    api.getServiceMetrics.mockReturnValue(new Promise(() => undefined));
    renderUi(<ServiceMetricsPanel projectId={PRJ} serviceId={SVC} now={NOW} />);
    expect(screen.getByTestId('service-metrics-loading')).toBeInTheDocument();
  });

  it('shows runtime status, container, restarts, health, last deployment and charts', async () => {
    respond(status());
    renderUi(<ServiceMetricsPanel projectId={PRJ} serviceId={SVC} now={NOW} />);
    expect(await screen.findByTestId('service-metric-restarts')).toBeInTheDocument();
    expect(screen.getByTestId('service-status-runtime')).toHaveTextContent('Running');
    expect(screen.getByTestId('service-status-container')).toHaveTextContent('Running');
    expect(screen.getByTestId('service-status-restarts')).toHaveTextContent('3');
    expect(screen.getByTestId('service-status-health')).toHaveTextContent('Healthy');
    expect(screen.getByTestId('service-status-last-deployment')).toHaveTextContent('Success');
    expect(screen.getByTestId('service-status-last-deployment')).toHaveTextContent('abcdef1');
    expect(screen.getByTestId('service-metric-restarts-latest')).toHaveTextContent('3');
    expect(api.getServiceStatus).toHaveBeenCalledWith(PRJ, SVC);
  });

  it('uses the backend flags for high memory and high disk pills', async () => {
    respond(status({ flags: { highMemory: true, highDisk: true } }));
    renderUi(<ServiceMetricsPanel projectId={PRJ} serviceId={SVC} now={NOW} />);
    expect(await screen.findByTestId('service-metric-memory-alert')).toHaveTextContent(METRICS_COPY.highMemory);
    expect(screen.getByTestId('service-status-high-disk')).toHaveAttribute('data-tone', 'warn');
  });

  it('explains a never-deployed service with no samples', async () => {
    respond(status({ runtimeStatus: 'NEVER_DEPLOYED', container: null, lastDeployment: null }), []);
    renderUi(<ServiceMetricsPanel projectId={PRJ} serviceId={SVC} now={NOW} />);
    expect(await screen.findByTestId('service-metrics-empty')).toHaveTextContent(METRICS_COPY.emptyTitle);
    expect(screen.getByTestId('service-status-container')).toHaveTextContent(SERVICE_METRICS_COPY.noContainer);
    expect(screen.getByTestId('service-status-last-deployment')).toHaveTextContent(SERVICE_METRICS_COPY.noDeployment);
    expect(screen.queryByTestId('service-metrics-unobserved')).toBeNull();
  });

  it('says when a deployed container was not observed', async () => {
    respond(status({ runtimeStatus: 'UNKNOWN', container: null }));
    renderUi(<ServiceMetricsPanel projectId={PRJ} serviceId={SVC} now={NOW} />);
    expect(await screen.findByTestId('service-metrics-unobserved')).toHaveTextContent(SERVICE_METRICS_COPY.containerUnobserved);
  });

  it('says when a range was downsampled', async () => {
    respond(status(), [series('cpu_percent', new Array<number>(500).fill(1))]);
    renderUi(<ServiceMetricsPanel projectId={PRJ} serviceId={SVC} now={NOW} />);
    expect(await screen.findByTestId('service-metrics-truncated')).toHaveTextContent(METRICS_COPY.truncated);
  });

  it('shows fixed copy when either read fails', async () => {
    api.getServiceStatus.mockResolvedValue({ ok: true, data: status() });
    api.getServiceMetrics.mockResolvedValue({ ok: false, code: 'INTERNAL_ERROR', message: 'raw', unauthorized: false });
    renderUi(<ServiceMetricsPanel projectId={PRJ} serviceId={SVC} now={NOW} />);
    expect(await screen.findByTestId('service-metrics-error')).toHaveTextContent(METRICS_COPY.loadFailed);
  });
});
