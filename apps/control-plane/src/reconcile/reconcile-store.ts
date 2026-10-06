// 12-15: the reconcile tick's database and queue ports.
// - Status cache writes are compare-and-set on the cached value, so a deploy or an operation that
//   wrote the cache after the tick read it always wins.
// - The out-of-band activity event goes through the services helper (ACT-01): the reconcile
//   record is `recordServiceOperation`'s `service.container_changed` event with a system actor,
//   exactly the event the domain reserves for the reconcile tick (activity-event.ts).
import { and, desc, eq, inArray, notExists } from 'drizzle-orm';
import { NON_TERMINAL_DEPLOYMENT_STATUSES, type DeploymentStatus } from '@noodara/domain/deployment';
import type { Database } from '../db/client.js';
import { deployments } from '../db/schema/deployments.js';
import { servers } from '../db/schema/servers.js';
import { services } from '../db/schema/services.js';
import { jobIdForServiceOperation } from '../deploy/service-ops-job.js';
import { recordServiceOperation } from '../services/service-services.js';
import { toServiceView, type ServiceView } from '../services/service-view.js';
import { nextUpdatedAtSql } from '../services/updated-at.js';
import type { ReconcileDiscrepancyRecord, ReconcileServiceRow, ReconcileStatusWrite } from './reconcile-tick.js';

/** CONNECTED servers with at least one service. */
export async function listReconcileServers(db: Database): Promise<string[]> {
  const rows = await db
    .selectDistinct({ id: servers.id })
    .from(servers)
    .innerJoin(services, eq(services.serverId, servers.id))
    .where(eq(servers.status, 'CONNECTED'))
    .orderBy(servers.id);
  return rows.map((row) => row.id);
}

async function latestDeployments(db: Database, serviceIds: readonly string[]): Promise<Map<string, DeploymentStatus>> {
  if (serviceIds.length === 0) return new Map();
  const rows = await db
    .selectDistinctOn([deployments.serviceId], { serviceId: deployments.serviceId, status: deployments.status })
    .from(deployments)
    .where(inArray(deployments.serviceId, [...serviceIds]))
    .orderBy(deployments.serviceId, desc(deployments.createdAt), desc(deployments.id));
  return new Map(rows.map((row) => [row.serviceId, row.status]));
}

const NON_TERMINAL = new Set<DeploymentStatus>(NON_TERMINAL_DEPLOYMENT_STATUSES);

export async function loadReconcileServices(db: Database, serverId: string): Promise<ReconcileServiceRow[]> {
  const rows = await db
    .select({ id: services.id, status: services.status })
    .from(services)
    .where(eq(services.serverId, serverId))
    .orderBy(services.id);
  const ids = rows.map((row) => row.id);
  const [latest, active] = await Promise.all([
    latestDeployments(db, ids),
    ids.length === 0
      ? Promise.resolve([])
      : db
          .selectDistinct({ serviceId: deployments.serviceId })
          .from(deployments)
          .where(
            and(inArray(deployments.serviceId, ids), inArray(deployments.status, [...NON_TERMINAL_DEPLOYMENT_STATUSES])),
          ),
  ]);
  const activeIds = new Set(active.map((row) => row.serviceId));
  return rows.map((row) => {
    const status = latest.get(row.id);
    return {
      serviceId: row.id,
      cachedStatus: row.status,
      latestDeployment: status === undefined ? null : { status },
      activeDeployment: activeIds.has(row.id) || (status !== undefined && NON_TERMINAL.has(status)),
    };
  });
}

/** Compare-and-set on the cached status; never while a deployment is active. */
export async function writeReconcileStatus(
  db: Database,
  now: () => Date,
  write: ReconcileStatusWrite,
): Promise<ServiceView | null> {
  const activeDeployment = db
    .select({ id: deployments.id })
    .from(deployments)
    .where(
      and(
        eq(deployments.serviceId, write.serviceId),
        inArray(deployments.status, [...NON_TERMINAL_DEPLOYMENT_STATUSES]),
      ),
    );
  const [row] = await db
    .update(services)
    // Never read under a lock, so the strictly-increasing rule runs in SQL (13-02 H1).
    .set({ status: write.status, updatedAt: nextUpdatedAtSql(services.updatedAt, now()) })
    .where(and(eq(services.id, write.serviceId), eq(services.status, write.expected), notExists(activeDeployment)))
    .returning();
  if (row === undefined) return null;
  const status = (await latestDeployments(db, [row.id])).get(row.id);
  return toServiceView(row, status === undefined ? null : { status });
}

/** One `service.container_changed` activity event + status cache, in one transaction. */
export function recordReconcileDiscrepancy(
  db: Database,
  now: () => Date,
  record: ReconcileDiscrepancyRecord,
): Promise<ServiceView | null> {
  return recordServiceOperation(db, now, {
    serviceId: record.serviceId,
    serverId: record.serverId,
    operation: 'remove',
    actor: { type: 'system' },
    result: {
      ok: true,
      operation: 'remove',
      previousState: 'running',
      container: record.container,
      durationMs: 0,
    },
  });
}

/** The slice of a BullMQ Queue on the `deployments` queue this port uses. */
export interface OperationJobLookup {
  getJob(jobId: string): Promise<{ getState(): Promise<string> } | undefined>;
}

const FINISHED_JOB_STATES = new Set(['completed', 'failed', 'unknown']);

/** A stop / restart / remove job of the service is still stored unfinished. An unanswerable
 *  lookup counts as in flight: the service is skipped this tick rather than guessed. */
export function createOperationInFlight(queue: OperationJobLookup): (serviceId: string) => Promise<boolean> {
  return async (serviceId) => {
    try {
      const job = await queue.getJob(jobIdForServiceOperation(serviceId));
      if (job === undefined) return false;
      return !FINISHED_JOB_STATES.has(await job.getState());
    } catch {
      return true;
    }
  };
}
