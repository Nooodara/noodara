import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { renderUi, screen, userEvent } from '@noodara/ui/testing';
import type { MetricSeries } from '@noodara/domain/api-contract';
import type { ServerMetricsView } from '../../lib/api/metrics-api';
import { METRICS_COPY, ServerMetricsPanel } from './ServerMetricsPanel';

const SRV = '11111111-1111-4111-8111-111111111111';
const NOW = new Date('2026-11-05T11:00:00.000Z');

const api = vi.hoisted(() => ({ getServerMetrics: vi.fn() }));
vi.mock('../../lib/api/metrics-api', () => ({
  getServerMetrics: (...a: unknown[]) => api.getServerMetrics(...a) as unknown,
}));

function series(metric: MetricSeries['metric'], values: readonly (number | null)[]): MetricSeries {
  return {
    scope: 'server',
    entityId: SRV,
    metric,
    from: '2026-11-05T10:00:00.000Z',
    to: '2026-11-05T11:00:00.000Z',
    intervalSeconds: 60,
    points: values.map((v, index) => ({ t: new Date(Date.UTC(2026, 10, 5, 10, index)).toISOString(), v })),
  };
}

function view(overrides: Partial<ServerMetricsView['server']> = {}, list?: MetricSeries[]): ServerMetricsView {
  return {
    series: list ?? [series('cpu_percent', [10, 20]), series('memory_percent', [40, 50]), series('disk_used_percent', [60, 61])],
    server: {
      serverId: SRV,
      connectionState: 'CONNECTED',
      lastSeenAt: '2026-11-05T10:59:00.000Z',
      uptimeSeconds: 90_000,
      sampledAt: '2026-11-05T10:59:00.000Z',
      ...overrides,
    },
  };
}

beforeEach(() => {
  api.getServerMetrics.mockReset();
});
afterEach(() => {
  vi.useRealTimers();
});

describe('ServerMetricsPanel', () => {
  it('shows a skeleton while loading', () => {
    api.getServerMetrics.mockReturnValue(new Promise(() => undefined));
    renderUi(<ServerMetricsPanel serverId={SRV} now={NOW} />);
    expect(screen.getByTestId('server-metrics-loading')).toBeInTheDocument();
  });

  it('shows connection state, uptime and the three charts', async () => {
    api.getServerMetrics.mockResolvedValue({ ok: true, data: view() });
    renderUi(<ServerMetricsPanel serverId={SRV} now={NOW} />);
    expect(await screen.findByTestId('server-metric-cpu')).toBeInTheDocument();
    expect(screen.getByTestId('server-metrics-connection')).toHaveTextContent('Connected');
    expect(screen.getByTestId('server-metrics-uptime')).toHaveTextContent('1 day, 1 hour');
    expect(screen.getByTestId('server-metric-cpu-latest')).toHaveTextContent('20%');
    expect(screen.getByTestId('server-metric-memory')).toHaveAttribute('data-alert', 'false');
    expect(screen.queryByTestId('server-metrics-unreachable')).toBeNull();
    expect(screen.queryByTestId('server-metrics-truncated')).toBeNull();
    expect(api.getServerMetrics).toHaveBeenCalledWith(SRV);
  });

  it('flags high memory and high disk with a worded warn pill', async () => {
    const list = [series('cpu_percent', [5]), series('memory_percent', [92]), series('disk_used_percent', [95])];
    api.getServerMetrics.mockResolvedValue({ ok: true, data: view({}, list) });
    renderUi(<ServerMetricsPanel serverId={SRV} now={NOW} />);
    const memoryAlert = await screen.findByTestId('server-metric-memory-alert');
    expect(memoryAlert).toHaveTextContent(METRICS_COPY.highMemory);
    expect(memoryAlert).toHaveAttribute('data-tone', 'warn');
    expect(screen.getByTestId('server-metric-disk-alert')).toHaveTextContent(METRICS_COPY.highDisk);
    expect(screen.queryByTestId('server-metric-cpu-alert')).toBeNull();
  });

  it('explains an empty range', async () => {
    api.getServerMetrics.mockResolvedValue({ ok: true, data: view({ uptimeSeconds: null, sampledAt: null }, [series('cpu_percent', [null])]) });
    renderUi(<ServerMetricsPanel serverId={SRV} now={NOW} />);
    expect(await screen.findByTestId('server-metrics-empty')).toHaveTextContent(METRICS_COPY.emptyTitle);
  });

  it('keeps the last samples and says when the server is unreachable', async () => {
    api.getServerMetrics.mockResolvedValue({ ok: true, data: view({ connectionState: 'UNREACHABLE' }) });
    renderUi(<ServerMetricsPanel serverId={SRV} now={NOW} />);
    expect(await screen.findByTestId('server-metrics-unreachable')).toHaveTextContent(METRICS_COPY.unreachable);
    expect(screen.getByTestId('server-metric-cpu')).toBeInTheDocument();
  });

  it('says when a range was downsampled', async () => {
    const full = new Array<number>(500).fill(10);
    api.getServerMetrics.mockResolvedValue({ ok: true, data: view({}, [series('cpu_percent', full)]) });
    renderUi(<ServerMetricsPanel serverId={SRV} now={NOW} />);
    expect(await screen.findByTestId('server-metrics-truncated')).toHaveTextContent(METRICS_COPY.truncated);
  });

  it('shows fixed copy on a failed read and retries', async () => {
    api.getServerMetrics.mockResolvedValueOnce({ ok: false, code: 'INTERNAL_ERROR', message: 'raw', unauthorized: false });
    api.getServerMetrics.mockResolvedValueOnce({ ok: true, data: view() });
    renderUi(<ServerMetricsPanel serverId={SRV} now={NOW} />);
    const error = await screen.findByTestId('server-metrics-error');
    expect(error).toHaveTextContent(METRICS_COPY.loadFailed);
    expect(error).not.toHaveTextContent('raw');
    await userEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(await screen.findByTestId('server-metric-cpu')).toBeInTheDocument();
  });
});
