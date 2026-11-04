// 27-02: the metrics collector's database ports (tables of migration 0019).
// - writeServerTick: host sample, container samples, observations, incident events (through the
//   activity helper, ACT-01) and servers.last_seen_at in one transaction.
// - prune: deletes rows older than the cutoff in bounded batches; the latest state observation
//   of each service is kept, so a long-unchanged container never looks new after a prune.
import { and, desc, eq, gte, inArray, isNull, sql } from 'drizzle-orm';
import { NON_TERMINAL_DEPLOYMENT_STATUSES } from '@noodara/domain/deployment';
import type { ContainerState, ContainerStatePoint, DockerContainerState } from '@noodara/domain';
import { writeContainerIncidentEvent } from '../activity/observability-events.js';
import type { Database } from '../db/client.js';
import { deployments } from '../db/schema/deployments.js';
import { servers } from '../db/schema/servers.js';
import { services } from '../db/schema/services.js';
import { containerMetricSamples, containerObservations, hostMetricSamples } from '../db/schema/v05-observability.js';
import type { LastContainerState, PruneResult, ServerTickWrite } from './collector-tick.js';

/** CONNECTED servers, oldest id first. */
export async function listCollectorServers(db: Database): Promise<string[]> {
  const rows = await db.select({ id: servers.id }).from(servers).where(eq(servers.status, 'CONNECTED')).orderBy(servers.id);
  return rows.map((row) => row.id);
}

/** H1: a deploy (non-terminal deployment) or a proxy install owns the server's connection. */
export async function isServerBusy(db: Database, serverId: string): Promise<boolean> {
  const [server] = await db.select({ proxyStatus: servers.proxyStatus }).from(servers).where(eq(servers.id, serverId));
  if (server?.proxyStatus === 'INSTALLING') return true;
  const [active] = await db
    .select({ id: deployments.id })
    .from(deployments)
    .innerJoin(services, eq(services.id, deployments.serviceId))
    .where(and(eq(services.serverId, serverId), inArray(deployments.status, [...NON_TERMINAL_DEPLOYMENT_STATUSES])))
    .limit(1);
  return active !== undefined;
}

export async function listCollectorServices(db: Database, serverId: string): Promise<string[]> {
  const rows = await db.select({ id: services.id }).from(services).where(eq(services.serverId, serverId)).orderBy(services.id);
  return rows.map((row) => row.id);
}

type ObservationRow = typeof containerObservations.$inferSelect;

function stateOf(row: ObservationRow): ContainerState {
  return {
    status: row.status as DockerContainerState,
    running: row.running,
    restarting: row.restarting,
    restartCount: row.restartCount,
    oomKilled: row.oomKilled,
    exitCode: row.exitCode ?? 0,
    health: row.health as ContainerState['health'],
    healthExitCodes: row.healthExitCodes,
    memoryLimitBytes: row.memoryLimitBytes,
    memoryUsedBytes: row.memoryUsedBytes,
  };
}

export async function loadLastContainerStates(
  db: Database,
  serviceIds: readonly string[],
): Promise<Map<string, LastContainerState>> {
  if (serviceIds.length === 0) return new Map();
  const rows = await db
    .selectDistinctOn([containerObservations.serviceId])
    .from(containerObservations)
    .where(and(inArray(containerObservations.serviceId, [...serviceIds]), isNull(containerObservations.parseError)))
    .orderBy(containerObservations.serviceId, desc(containerObservations.observedAt), desc(containerObservations.id));
  return new Map(
    rows.map((row) => [
      row.serviceId,
      { containerId: row.containerId ?? '', observedAtMs: row.observedAt.getTime(), state: stateOf(row) },
    ]),
  );
}

export async function loadContainerHistory(
  db: Database,
  serviceId: string,
  containerId: string,
  since: Date,
): Promise<ContainerStatePoint[]> {
  const rows = await db
    .select()
    .from(containerObservations)
    .where(
      and(
        eq(containerObservations.serviceId, serviceId),
        eq(containerObservations.containerId, containerId),
        isNull(containerObservations.parseError),
        gte(containerObservations.observedAt, since),
      ),
    )
    .orderBy(containerObservations.observedAt);
  return rows.map((row) => ({ observedAtMs: row.observedAt.getTime(), state: stateOf(row) }));
}

export async function writeServerTick(db: Database, write: ServerTickWrite): Promise<void> {
  const at = write.sampledAt;
  await db.transaction(async (tx) => {
    if (write.host !== null) {
      await tx.insert(hostMetricSamples).values({ serverId: write.serverId, sampledAt: at, ...write.host });
    }
    if (write.containers.length > 0) {
      await tx.insert(containerMetricSamples).values(write.containers.map((row) => ({ ...row, sampledAt: at })));
    }
    if (write.observations.length > 0) {
      await tx.insert(containerObservations).values(
        write.observations.map((row) =>
          row.kind === 'parse_error'
            ? { serviceId: row.serviceId, containerId: row.containerId, observedAt: at, parseError: 'CONTAINER_SAMPLE_MALFORMED' }
            : {
                serviceId: row.serviceId,
                containerId: row.containerId,
                observedAt: at,
                status: row.state.status,
                running: row.state.running,
                restarting: row.state.restarting,
                restartCount: row.state.restartCount,
                oomKilled: row.state.oomKilled,
                exitCode: row.state.exitCode,
                health: row.state.health,
                healthExitCodes: [...row.state.healthExitCodes],
                memoryUsedBytes: row.state.memoryUsedBytes,
                memoryLimitBytes: row.state.memoryLimitBytes,
              },
        ),
      );
    }
    for (const incident of write.incidents) {
      await writeContainerIncidentEvent(tx, { serviceId: incident.serviceId, serverId: write.serverId, diagnosis: incident.diagnosis }, at);
    }
    // Connection state: the server answered this tick.
    await tx.update(servers).set({ lastSeenAt: at }).where(eq(servers.id, write.serverId));
  });
}

export interface PruneOptions {
  readonly batchSize?: number;
  /** Batches per table per call; the rest waits for the next tick. */
  readonly maxBatches?: number;
}

const DEFAULT_BATCH_SIZE = 5_000;
const DEFAULT_MAX_BATCHES = 20;

async function deleteBatches(run: () => Promise<number>, batchSize: number, maxBatches: number) {
  let deleted = 0;
  for (let batch = 0; batch < maxBatches; batch += 1) {
    const count = await run();
    deleted += count;
    if (count < batchSize) return { deleted, capped: false };
  }
  return { deleted, capped: true };
}

/** A4: rows older than `cutoff`, at most batchSize × maxBatches per table per call. */
export async function pruneMetrics(db: Database, cutoff: Date, options: PruneOptions = {}): Promise<PruneResult> {
  const batchSize = options.batchSize ?? DEFAULT_BATCH_SIZE;
  const maxBatches = options.maxBatches ?? DEFAULT_MAX_BATCHES;
  const iso = cutoff.toISOString();
  const host = await deleteBatches(
    async () =>
      (
        await db.execute(sql`DELETE FROM host_metric_samples WHERE id IN (
          SELECT id FROM host_metric_samples WHERE sampled_at < ${iso}::timestamptz LIMIT ${batchSize})`)
      ).rowCount ?? 0,
    batchSize,
    maxBatches,
  );
  const container = await deleteBatches(
    async () =>
      (
        await db.execute(sql`DELETE FROM container_metric_samples WHERE id IN (
          SELECT id FROM container_metric_samples WHERE sampled_at < ${iso}::timestamptz LIMIT ${batchSize})`)
      ).rowCount ?? 0,
    batchSize,
    maxBatches,
  );
  const observations = await deleteBatches(
    async () =>
      (
        await db.execute(sql`DELETE FROM container_observations WHERE id IN (
          SELECT o.id FROM container_observations o
          WHERE o.observed_at < ${iso}::timestamptz
            AND o.id NOT IN (
              SELECT DISTINCT ON (l.service_id) l.id FROM container_observations l
              WHERE l.parse_error IS NULL ORDER BY l.service_id, l.observed_at DESC, l.id DESC)
          LIMIT ${batchSize})`)
      ).rowCount ?? 0,
    batchSize,
    maxBatches,
  );
  return {
    deleted: host.deleted + container.deleted + observations.deleted,
    capped: host.capped || container.capped || observations.capped,
  };
}
