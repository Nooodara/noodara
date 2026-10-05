// 12-15: one reconcile tick (ROADMAP D3, REC-01, REC-03).
// - A1: one `docker ps --size=false` per CONNECTED server with services, never per service, each
//   bounded by commandMs (duration and idle); the session is always closed.
// - A2: the cached status is written (compare-and-set) and `service.updated` emitted only when
//   the derived status changes.
// - A3: a container stopped or removed outside Noodara writes one activity event through the
//   services helper. Only a cached RUNNING can raise one: the cache cannot tell a stopped
//   container from a missing one, so STOPPED -> absent stays silent and nothing repeats.
// - A4: an unreachable server (connect, transport, daemon or timeout) marks its services UNKNOWN,
//   never STOPPED; a failure on one server never stops the others.
// - H1: services with an active deployment or a queued/running service operation are skipped.
//   The rows are re-read after `docker ps`, so a deploy that started meanwhile is seen.
// Logs carry ids, counts and error kinds only: no command output, driver or SSH message.
import { listManagedContainers } from '@noodara/docker';
import {
  deriveServiceStatus,
  diffReconcileSnapshot,
  type ContainerObservation,
  type DeploymentStatus,
  type DockerPsResult,
  type ReconcileDiscrepancyKind,
  type ServiceStatus,
} from '@noodara/domain/deployment';
import type { Redactor } from '@noodara/domain/security';
import type { DeployJobDeps, DeployJobLogger } from '../deploy/deploy-worker.js';
import { publishServerEvent, type ServerEventPublisher } from '../events/server-event-publisher.js';
import { containerObservationFromCache, type ServiceView } from '../services/service-view.js';

export interface ReconcileServiceRow {
  readonly serviceId: string;
  /** The status cache (D5). */
  readonly cachedStatus: ServiceStatus;
  readonly latestDeployment: { readonly status: DeploymentStatus } | null;
  /** A non-terminal deployment exists: the deploy owns the container and its status. */
  readonly activeDeployment: boolean;
}

export interface ReconcileStatusWrite {
  readonly serviceId: string;
  /** Compare-and-set: the write only lands while the cache still holds this value. */
  readonly expected: ServiceStatus;
  readonly status: ServiceStatus;
}

export interface ReconcileDiscrepancyRecord {
  readonly serviceId: string;
  readonly serverId: string;
  readonly kind: ReconcileDiscrepancyKind;
  readonly container: ContainerObservation;
}

export interface ReconcileTickDeps {
  /** CONNECTED servers that have at least one service. */
  readonly listServers: () => Promise<readonly string[]>;
  readonly loadServices: (serverId: string) => Promise<readonly ReconcileServiceRow[]>;
  /** A stop / restart / remove job is queued or running for the service. */
  readonly operationInFlight: (serviceId: string) => Promise<boolean>;
  readonly connect: DeployJobDeps['connect'];
  readonly createRedactor: () => Redactor;
  /** NOODARA_SSH_COMMAND_TIMEOUT_MS: bounds the one `docker ps` per server. */
  readonly commandMs: number;
  /** `null` when the compare-and-set lost (the cache changed) or the service is gone. */
  readonly writeStatus: (write: ReconcileStatusWrite) => Promise<ServiceView | null>;
  /** Activity event + status cache in one transaction (services helper, ACT-01). */
  readonly recordDiscrepancy: (record: ReconcileDiscrepancyRecord) => Promise<ServiceView | null>;
  readonly events: ServerEventPublisher;
  readonly logger: DeployJobLogger;
  /** Servers reconciled at once; default 4. */
  readonly serverConcurrency?: number;
}

export interface ReconcileTickSummary {
  readonly servers: number;
  readonly unreachable: number;
  readonly failed: number;
  readonly updated: number;
  readonly discrepancies: number;
  readonly skipped: number;
}

const PS_MAX_TOTAL_BYTES = 1_048_576;
const PS_MAX_LINE_BYTES = 16_384;
const DEFAULT_SERVER_CONCURRENCY = 4;
const UNREACHABLE_SNAPSHOT: DockerPsResult = Object.freeze({ kind: 'unparseable', reason: 'server unreachable' });

interface Counters {
  servers: number;
  unreachable: number;
  failed: number;
  updated: number;
  discrepancies: number;
  skipped: number;
}

/** Only the error's class name: a driver or SSH message can carry a URL or a secret. */
function errorKind(error: unknown): string {
  return error instanceof Error ? error.name : typeof error;
}

/** One `docker ps` over a fresh session; anything short of a parsed snapshot is "unreachable". */
async function snapshotOf(deps: ReconcileTickDeps, serverId: string): Promise<DockerPsResult> {
  const redactor = deps.createRedactor();
  let connected;
  try {
    connected = await deps.connect(serverId, redactor, undefined);
  } catch {
    return UNREACHABLE_SNAPSHOT;
  }
  if (!connected.ok) return UNREACHABLE_SNAPSHOT;
  try {
    const listed = await listManagedContainers({
      session: connected.session,
      redactor,
      limits: {
        maxDurationMs: deps.commandMs,
        idleTimeoutMs: deps.commandMs,
        maxTotalBytes: PS_MAX_TOTAL_BYTES,
        maxLineBytes: PS_MAX_LINE_BYTES,
      },
    });
    return listed.ok ? listed.value : UNREACHABLE_SNAPSHOT;
  } catch {
    return UNREACHABLE_SNAPSHOT;
  } finally {
    try {
      await connected.close();
    } catch {
      // A failed close never changes the snapshot.
    }
  }
}

async function eligible(deps: ReconcileTickDeps, rows: readonly ReconcileServiceRow[], counters: Counters) {
  const kept: ReconcileServiceRow[] = [];
  for (const row of rows) {
    if (row.activeDeployment || (await deps.operationInFlight(row.serviceId))) {
      counters.skipped += 1;
      continue;
    }
    kept.push(row);
  }
  return kept;
}

async function reconcileServer(deps: ReconcileTickDeps, serverId: string, counters: Counters): Promise<void> {
  if ((await deps.loadServices(serverId)).length === 0) return;
  counters.servers += 1;
  const snapshot = await snapshotOf(deps, serverId);
  if (snapshot.kind !== 'ok') {
    counters.unreachable += 1;
    deps.logger.warn({ serverId, snapshot: snapshot.kind }, 'reconcile: server state could not be observed');
  }

  // Re-read after `docker ps`: a deploy or operation that started meanwhile now owns the service.
  const rows = await eligible(deps, await deps.loadServices(serverId), counters);
  const byId = new Map(rows.map((row) => [row.serviceId, row]));
  const diff = diffReconcileSnapshot(
    rows.map((row) => ({
      serviceId: row.serviceId,
      lastObserved: containerObservationFromCache(row.cachedStatus),
      operationInFlight: false,
    })),
    snapshot,
  );
  const discrepancies = new Map(
    diff.discrepancies.filter((d) => d.previous.kind === 'running').map((d) => [d.serviceId, d.kind]),
  );

  for (const { serviceId, observation } of diff.observations) {
    const row = byId.get(serviceId);
    if (row === undefined) continue;
    try {
      const kind = discrepancies.get(serviceId);
      let view: ServiceView | null = null;
      if (kind !== undefined) {
        view = await deps.recordDiscrepancy({ serviceId, serverId, kind, container: observation });
        if (view !== null) counters.discrepancies += 1;
      } else {
        const status = deriveServiceStatus({ latestDeployment: row.latestDeployment, container: observation });
        if (status === row.cachedStatus) continue;
        view = await deps.writeStatus({ serviceId, expected: row.cachedStatus, status });
      }
      if (view === null) continue;
      counters.updated += 1;
      await publishServerEvent(deps.events, { type: 'service.updated', service: view });
    } catch (error) {
      counters.failed += 1;
      deps.logger.error({ serverId, serviceId, errorKind: errorKind(error) }, 'reconcile: service update failed');
    }
  }
}

export function createReconcileTick(deps: ReconcileTickDeps): () => Promise<ReconcileTickSummary> {
  const concurrency = Math.max(1, deps.serverConcurrency ?? DEFAULT_SERVER_CONCURRENCY);
  return async () => {
    const counters: Counters = { servers: 0, unreachable: 0, failed: 0, updated: 0, discrepancies: 0, skipped: 0 };
    const pending = [...(await deps.listServers())];
    const lane = async (): Promise<void> => {
      for (let serverId = pending.shift(); serverId !== undefined; serverId = pending.shift()) {
        try {
          await reconcileServer(deps, serverId, counters);
        } catch (error) {
          counters.failed += 1;
          deps.logger.error({ serverId, errorKind: errorKind(error) }, 'reconcile: server tick failed');
        }
      }
    };
    await Promise.all(Array.from({ length: Math.min(concurrency, pending.length) }, lane));
    return { ...counters };
  };
}
