// 30-01: typed reads of the 27-03 metrics and service status routes. Same transport as every
// other screen (apiGet: relative path, 15s timeout, fixed failure vocabulary). Ids are checked
// before they reach a URL; a malformed id never leaves the browser.
import type { MetricSeries, ServiceStatusSummary } from '@noodara/domain/api-contract';
import { apiGet, type ApiResult } from '../api-client';

export type { MetricSeries, ServiceStatusSummary };

export interface ServerMetricsView {
  readonly series: readonly MetricSeries[];
  readonly server: {
    readonly serverId: string;
    readonly connectionState: string;
    readonly lastSeenAt: string | null;
    readonly uptimeSeconds: number | null;
    readonly sampledAt: string | null;
  };
}

export interface ServiceMetricsView {
  readonly series: readonly MetricSeries[];
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function invalidId<T>(): Promise<ApiResult<T>> {
  return Promise.resolve({ ok: false, code: 'NOT_FOUND', message: 'Not found.', unauthorized: false });
}

export function getServerMetrics(serverId: string): Promise<ApiResult<ServerMetricsView>> {
  if (!UUID_PATTERN.test(serverId)) return invalidId();
  return apiGet<ServerMetricsView>(`/api/servers/${encodeURIComponent(serverId)}/metrics`);
}

function servicePath(projectId: string, serviceId: string, leaf: 'metrics' | 'status'): string {
  return `/api/projects/${encodeURIComponent(projectId)}/services/${encodeURIComponent(serviceId)}/${leaf}`;
}

export function getServiceMetrics(projectId: string, serviceId: string): Promise<ApiResult<ServiceMetricsView>> {
  if (!UUID_PATTERN.test(projectId) || !UUID_PATTERN.test(serviceId)) return invalidId();
  return apiGet<ServiceMetricsView>(servicePath(projectId, serviceId, 'metrics'));
}

export function getServiceStatus(projectId: string, serviceId: string): Promise<ApiResult<ServiceStatusSummary>> {
  if (!UUID_PATTERN.test(projectId) || !UUID_PATTERN.test(serviceId)) return invalidId();
  return apiGet<ServiceStatusSummary>(servicePath(projectId, serviceId, 'status'));
}
