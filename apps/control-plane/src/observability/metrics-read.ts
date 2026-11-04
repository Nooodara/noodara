// 27-03: read side of the metrics tables (migration 0019) for the metrics and status API.
// - Series are aggregated in SQL per aligned bucket (metric-range.ts plans them), so a query
//   returns at most `points` rows whatever the range; avg for gauges, max for the restart counter.
// - Service lookups always carry the project id: a service is never read through another project.
// - Flags reuse the domain threshold policies over fresh samples only; a stale reading never flags.
import { and, desc, eq, gte, isNotNull, isNull, sql } from 'drizzle-orm';
import type { MetricSeries, ServiceStatusSummary } from '@noodara/domain/api-contract';
import type { ServiceStatus } from '@noodara/domain/deployment';
import {
  HIGH_MEMORY_SUSTAINED_SAMPLES,
  healthcheckOutcome,
  highMemory,
  nearFullDisk,
  type ContainerHealthStatus,
  type DockerContainerState,
  type MemoryReading,
  type ServerStatus,
} from '@noodara/domain';
import type { Database } from '../db/client.js';
import { deployments } from '../db/schema/deployments.js';
import { servers } from '../db/schema/servers.js';
import { services } from '../db/schema/services.js';
import { containerMetricSamples, containerObservations, hostMetricSamples } from '../db/schema/v05-observability.js';
import { fillBuckets, planBuckets, type BucketPlan, type MetricRange } from './metric-range.js';

type MetricName = MetricSeries['metric'];

export interface ServerRef {
  readonly id: string;
  readonly status: ServerStatus;
  readonly lastSeenAt: Date | null;
}

export interface ServiceRef {
  readonly id: string;
  readonly serverId: string;
  readonly status: ServiceStatus;
}

export async function findServer(db: Database, serverId: string): Promise<ServerRef | null> {
  const [row] = await db
    .select({ id: servers.id, status: servers.status, lastSeenAt: servers.lastSeenAt })
    .from(servers)
    .where(eq(servers.id, serverId));
  return row ?? null;
}

export async function findServiceInProject(db: Database, projectId: string, serviceId: string): Promise<ServiceRef | null> {
  const [row] = await db
    .select({ id: services.id, serverId: services.serverId, status: services.status })
    .from(services)
    .where(and(eq(services.id, serviceId), eq(services.projectId, projectId)));
  return row ?? null;
}

export async function latestHostSample(db: Database, serverId: string) {
  const [row] = await db
    .select({
      sampledAt: hostMetricSamples.sampledAt,
      memoryTotalBytes: hostMetricSamples.memoryTotalBytes,
      memoryUsedBytes: hostMetricSamples.memoryUsedBytes,
      uptimeSeconds: hostMetricSamples.uptimeSeconds,
      filesystems: hostMetricSamples.filesystems,
    })
    .from(hostMetricSamples)
    .where(eq(hostMetricSamples.serverId, serverId))
    .orderBy(desc(hostMetricSamples.sampledAt), desc(hostMetricSamples.id))
    .limit(1);
  return row ?? null;
}

function numberOrNull(value: unknown): number | null {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'string' && value !== '') {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

type BucketRow = Record<string, unknown>;

function bucketExpr(column: ReturnType<typeof sql.raw>, plan: BucketPlan) {
  return sql`floor((extract(epoch FROM ${column}) * 1000 - ${plan.startMs}::numeric) / ${plan.intervalSeconds * 1000}::numeric)::int`;
}

function toSeries(
  scope: MetricSeries['scope'],
  entityId: string,
  range: MetricRange,
  plan: BucketPlan,
  rows: readonly BucketRow[],
  metrics: readonly MetricName[],
): MetricSeries[] {
  return metrics.map((metric) => ({
    scope,
    entityId,
    metric,
    from: new Date(plan.startMs).toISOString(),
    to: new Date(range.toMs).toISOString(),
    intervalSeconds: plan.intervalSeconds,
    points: fillBuckets(
      plan,
      rows.map((row) => ({ bucket: numberOrNull(row.bucket) ?? -1, value: numberOrNull(row[metric]) })),
    ),
  }));
}

const SERVER_METRICS = ['cpu_percent', 'memory_used_bytes', 'memory_percent', 'disk_used_percent'] as const;
const SERVICE_METRICS = ['cpu_percent', 'memory_used_bytes', 'memory_percent', 'restart_count'] as const;

export interface ServerMetrics {
  readonly series: MetricSeries[];
  readonly server: {
    readonly serverId: string;
    readonly connectionState: ServerStatus;
    readonly lastSeenAt: string | null;
    readonly uptimeSeconds: number | null;
    readonly sampledAt: string | null;
  };
}

export async function readServerMetrics(db: Database, server: ServerRef, range: MetricRange): Promise<ServerMetrics> {
  const plan = planBuckets(range);
  const bucket = bucketExpr(sql.raw('sampled_at'), plan);
  const result = await db.execute(sql`
    SELECT ${bucket} AS bucket,
      avg(cpu_percent)::float8 AS cpu_percent,
      avg(memory_used_bytes)::float8 AS memory_used_bytes,
      avg(memory_used_bytes * 100.0 / nullif(memory_total_bytes, 0))::float8 AS memory_percent,
      avg(disk_used_percent)::float8 AS disk_used_percent
    FROM host_metric_samples
    WHERE server_id = ${server.id}
      AND sampled_at >= ${new Date(plan.startMs).toISOString()}::timestamptz
      AND sampled_at < ${new Date(range.toMs).toISOString()}::timestamptz
    GROUP BY 1 ORDER BY 1`);
  const latest = await latestHostSample(db, server.id);
  return {
    series: toSeries('server', server.id, range, plan, result.rows, SERVER_METRICS),
    server: {
      serverId: server.id,
      connectionState: server.status,
      lastSeenAt: server.lastSeenAt?.toISOString() ?? null,
      uptimeSeconds: latest?.uptimeSeconds ?? null,
      sampledAt: latest?.sampledAt.toISOString() ?? null,
    },
  };
}

/** A container without a memory limit is measured against the host total (domain memoryPercent). */
export async function readServiceMetrics(db: Database, service: ServiceRef, range: MetricRange): Promise<MetricSeries[]> {
  const plan = planBuckets(range);
  const hostTotal = (await latestHostSample(db, service.serverId))?.memoryTotalBytes ?? null;
  const bucket = bucketExpr(sql.raw('sampled_at'), plan);
  const result = await db.execute(sql`
    SELECT ${bucket} AS bucket,
      avg(cpu_percent)::float8 AS cpu_percent,
      avg(memory_used_bytes)::float8 AS memory_used_bytes,
      avg(memory_used_bytes * 100.0 / coalesce(nullif(memory_limit_bytes, 0), nullif(${hostTotal}::bigint, 0)))::float8 AS memory_percent,
      max(restart_count) AS restart_count
    FROM container_metric_samples
    WHERE service_id = ${service.id}
      AND sampled_at >= ${new Date(plan.startMs).toISOString()}::timestamptz
      AND sampled_at < ${new Date(range.toMs).toISOString()}::timestamptz
    GROUP BY 1 ORDER BY 1`);
  return toSeries('service', service.id, range, plan, result.rows, SERVICE_METRICS);
}

export interface StatusOptions {
  readonly nowMs: number;
  /** The collector interval; flags read only samples from the last few intervals. */
  readonly intervalMs: number;
}

const SHA_PATTERN = /^[0-9a-f]{7,64}$/;
/** Collector ticks can run late; a reading older than this many intervals is stale. */
export const DISK_FRESH_INTERVALS = 3;
export const MEMORY_FRESH_INTERVALS = HIGH_MEMORY_SUSTAINED_SAMPLES + 2;

async function latestObservation(db: Database, serviceId: string) {
  const [row] = await db
    .select()
    .from(containerObservations)
    .where(and(eq(containerObservations.serviceId, serviceId), isNull(containerObservations.parseError)))
    .orderBy(desc(containerObservations.observedAt), desc(containerObservations.id))
    .limit(1);
  return row ?? null;
}

export async function lastDeployment(db: Database, serviceId: string) {
  const [row] = await db
    .select({
      id: deployments.id,
      status: deployments.status,
      commitSha: deployments.commitSha,
      completedAt: deployments.completedAt,
    })
    .from(deployments)
    .where(eq(deployments.serviceId, serviceId))
    .orderBy(desc(deployments.createdAt), desc(deployments.id))
    .limit(1);
  return row ?? null;
}

export async function recentMemoryReadings(db: Database, serviceId: string, since: Date): Promise<MemoryReading[]> {
  const rows = await db
    .select({ usedBytes: containerMetricSamples.memoryUsedBytes, limitBytes: containerMetricSamples.memoryLimitBytes })
    .from(containerMetricSamples)
    .where(
      and(
        eq(containerMetricSamples.serviceId, serviceId),
        isNotNull(containerMetricSamples.memoryUsedBytes),
        gte(containerMetricSamples.sampledAt, since),
      ),
    )
    .orderBy(desc(containerMetricSamples.sampledAt), desc(containerMetricSamples.id))
    .limit(HIGH_MEMORY_SUSTAINED_SAMPLES);
  // Oldest first, as highMemory expects.
  return rows.reverse().map((row) => ({ usedBytes: row.usedBytes ?? 0, limitBytes: row.limitBytes }));
}

/** The last N host memory readings since `since`, oldest first (limit = host MemTotal). */
export async function recentHostMemoryReadings(db: Database, serverId: string, since: Date): Promise<MemoryReading[]> {
  const rows = await db
    .select({ usedBytes: hostMetricSamples.memoryUsedBytes, limitBytes: hostMetricSamples.memoryTotalBytes })
    .from(hostMetricSamples)
    .where(and(eq(hostMetricSamples.serverId, serverId), gte(hostMetricSamples.sampledAt, since)))
    .orderBy(desc(hostMetricSamples.sampledAt), desc(hostMetricSamples.id))
    .limit(HIGH_MEMORY_SUSTAINED_SAMPLES);
  return rows.reverse();
}

type Observation = typeof containerObservations.$inferSelect;

function containerView(observation: Observation | null): ServiceStatusSummary['container'] {
  if (observation?.status == null) return null;
  return {
    state: observation.status as DockerContainerState,
    restartCount: observation.restartCount,
    healthcheck: healthcheckOutcome({
      health: observation.health as ContainerHealthStatus | null,
      healthExitCodes: observation.healthExitCodes,
    }),
    observedAt: observation.observedAt.toISOString(),
  };
}

export async function readServiceStatus(db: Database, service: ServiceRef, options: StatusOptions): Promise<ServiceStatusSummary> {
  const [observation, deployment, host] = await Promise.all([
    latestObservation(db, service.id),
    lastDeployment(db, service.id),
    latestHostSample(db, service.serverId),
  ]);
  const readings = await recentMemoryReadings(db, service.id, new Date(options.nowMs - options.intervalMs * MEMORY_FRESH_INTERVALS));
  const hostFresh = host !== null && host.sampledAt.getTime() >= options.nowMs - options.intervalMs * DISK_FRESH_INTERVALS;
  return {
    serviceId: service.id,
    runtimeStatus: service.status,
    container: containerView(observation),
    lastDeployment:
      deployment === null
        ? null
        : {
            id: deployment.id,
            status: deployment.status,
            commitSha: deployment.commitSha !== null && SHA_PATTERN.test(deployment.commitSha) ? deployment.commitSha : null,
            finishedAt: deployment.completedAt?.toISOString() ?? null,
          },
    flags: {
      highMemory: highMemory(readings, { hostTotalBytes: host?.memoryTotalBytes ?? null }),
      highDisk: hostFresh && nearFullDisk(host.filesystems) !== null,
    },
  };
}
