// 27-06: stored observability rows -> classifier evidence (domain classifyEvidence).
// - assembleServiceEvidence is pure: the snapshot already holds fresh readings only.
// - loadServiceEvidence reads the same tables the metrics, status and logs APIs read, so every
//   evidence item is also retrievable through one of them (EVIDENCE_SURFACES, feeds 28-03).
// - Refs are entity ids only: never container names, IPs, commands or log text.
import { and, asc, eq, inArray } from 'drizzle-orm';
import {
  CRASH_LOOP_WINDOW_MS,
  observeContainer,
  type ContainerStatePoint,
  type DeploymentStatus,
  type Evidence,
  type FilesystemUsage,
  type HealthcheckConfig,
  type MemoryReading,
  type ServerStatus,
} from '@noodara/domain';
import type { Database } from '../db/client.js';
import { deploymentLogChunks } from '../db/schema/deployment-log-chunks.js';
import { services } from '../db/schema/services.js';
import { loadContainerHistory, loadLastContainerStates } from './collector-store.js';
import {
  DISK_FRESH_INTERVALS,
  MEMORY_FRESH_INTERVALS,
  findServer,
  lastDeployment,
  latestHostSample,
  recentHostMemoryReadings,
  recentMemoryReadings,
} from './metrics-read.js';

/** A CONNECTED server whose last sample is older than this many intervals is unreachable. */
export const SERVER_STALE_INTERVALS = 1.5;

export type ApiSurface = 'server_metrics' | 'service_metrics' | 'service_status' | 'logs';

/** Which API returns the data behind each evidence kind. */
export const EVIDENCE_SURFACES: Readonly<Record<Evidence['kind'], readonly ApiSurface[]>> = Object.freeze({
  server: ['server_metrics'],
  container: ['service_status', 'service_metrics', 'logs'],
  deployment: ['service_status', 'logs'],
  port: ['logs'],
  host_memory: ['server_metrics'],
  container_memory: ['service_metrics', 'service_status'],
  filesystem: ['server_metrics', 'service_status'],
});

export interface ServiceEvidenceSnapshot {
  readonly serviceId: string;
  readonly server: { readonly id: string; readonly status: ServerStatus; readonly lastSeenAt: Date | null };
  readonly container: { readonly containerId: string; readonly history: readonly ContainerStatePoint[] } | null;
  readonly hostTotalBytes: number | null;
  /** Oldest first, fresh only. */
  readonly containerMemory: readonly MemoryReading[];
  readonly hostMemory: readonly MemoryReading[];
  /** From a fresh host sample only. */
  readonly filesystems: readonly FilesystemUsage[];
  readonly deployment: {
    readonly id: string;
    readonly status: DeploymentStatus;
    readonly port: number;
    /** From the engine's healthcheck lines; null when they say nothing about the port. */
    readonly portResponding: boolean | null;
  } | null;
}

export interface EvidenceOptions {
  readonly nowMs: number;
  /** The collector interval. */
  readonly intervalMs: number;
}

function serverEvidence(server: ServiceEvidenceSnapshot['server'], options: EvidenceOptions): Evidence | null {
  const ref = `server:${server.id}`;
  if (server.status === 'UNREACHABLE') return { kind: 'server', ref, reachable: false };
  if (server.status !== 'CONNECTED' || server.lastSeenAt === null) return null;
  const staleBefore = options.nowMs - options.intervalMs * SERVER_STALE_INTERVALS;
  return { kind: 'server', ref, reachable: server.lastSeenAt.getTime() >= staleBefore };
}

export function assembleServiceEvidence(snapshot: ServiceEvidenceSnapshot, options: EvidenceOptions): Evidence[] {
  const evidence: Evidence[] = [];
  const server = serverEvidence(snapshot.server, options);
  if (server !== null) evidence.push(server);

  if (snapshot.container !== null) {
    const observation = observeContainer(snapshot.container.history, { hostTotalBytes: snapshot.hostTotalBytes });
    if (observation !== null) {
      evidence.push({
        kind: 'container',
        ref: `container:${snapshot.serviceId}`,
        container: snapshot.container.containerId,
        observation,
      });
    }
  }

  const { deployment } = snapshot;
  if (deployment !== null) {
    evidence.push({ kind: 'deployment', ref: `deployment:${deployment.id}`, status: deployment.status });
    if (deployment.portResponding !== null) {
      evidence.push({
        kind: 'port',
        ref: `port:${snapshot.serviceId}:${String(deployment.port)}`,
        port: deployment.port,
        responding: deployment.portResponding,
      });
    }
  }

  if (snapshot.containerMemory.length > 0) {
    evidence.push({
      kind: 'container_memory',
      ref: `memory:${snapshot.serviceId}`,
      container: snapshot.container?.containerId ?? '',
      readings: snapshot.containerMemory,
      hostTotalBytes: snapshot.hostTotalBytes,
    });
  }
  if (snapshot.hostMemory.length > 0) {
    evidence.push({ kind: 'host_memory', ref: `host-memory:${snapshot.server.id}`, readings: snapshot.hostMemory });
  }
  for (const filesystem of snapshot.filesystems) {
    evidence.push({ kind: 'filesystem', ref: `filesystem:${snapshot.server.id}:${filesystem.target}`, filesystem });
  }
  return evidence;
}

const HEALTHCHECK_ATTEMPT = /^Healthcheck attempt \d+: (.+)$/;

/** The last engine healthcheck attempt line decides; other text is ignored. */
export function healthcheckPortResponding(lines: readonly string[]): boolean | null {
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const match = HEALTHCHECK_ATTEMPT.exec(lines[index] ?? '');
    const result = match?.[1];
    if (result === undefined) continue;
    if (result === 'connection refused') return false;
    if (result === 'port open' || /^HTTP \d{3}$/.test(result)) return true;
    return null;
  }
  return null;
}

function probedPort(healthcheck: HealthcheckConfig | null, internalPort: number): number {
  return healthcheck !== null && healthcheck.type !== 'container' ? healthcheck.port : internalPort;
}

async function healthcheckLines(db: Database, deploymentId: string): Promise<string[]> {
  const rows = await db
    .select({ content: deploymentLogChunks.content })
    .from(deploymentLogChunks)
    .where(and(eq(deploymentLogChunks.deploymentId, deploymentId), inArray(deploymentLogChunks.phase, ['healthcheck'])))
    .orderBy(asc(deploymentLogChunks.seq));
  return rows.flatMap((row) => row.content.split('\n')).map((line) => line.trimEnd());
}

/** null when the service does not exist. */
export async function loadServiceEvidence(
  db: Database,
  serviceId: string,
  options: EvidenceOptions,
): Promise<{ snapshot: ServiceEvidenceSnapshot; evidence: Evidence[] } | null> {
  const [service] = await db
    .select({ id: services.id, serverId: services.serverId, internalPort: services.internalPort, healthcheck: services.healthcheck })
    .from(services)
    .where(eq(services.id, serviceId));
  if (service === undefined) return null;
  const server = await findServer(db, service.serverId);
  if (server === null) return null;

  const [lastStates, deployment, host] = await Promise.all([
    loadLastContainerStates(db, [serviceId]),
    lastDeployment(db, serviceId),
    latestHostSample(db, service.serverId),
  ]);
  const last = lastStates.get(serviceId);
  const history =
    last === undefined || last.containerId === ''
      ? null
      : await loadContainerHistory(db, serviceId, last.containerId, new Date(last.observedAtMs - CRASH_LOOP_WINDOW_MS));

  const memorySince = new Date(options.nowMs - options.intervalMs * MEMORY_FRESH_INTERVALS);
  const [containerMemory, hostMemory, lines] = await Promise.all([
    recentMemoryReadings(db, serviceId, memorySince),
    recentHostMemoryReadings(db, service.serverId, memorySince),
    deployment === null ? Promise.resolve([]) : healthcheckLines(db, deployment.id),
  ]);
  const hostFresh = host !== null && host.sampledAt.getTime() >= options.nowMs - options.intervalMs * DISK_FRESH_INTERVALS;

  const snapshot: ServiceEvidenceSnapshot = {
    serviceId,
    server,
    container: history === null || last === undefined ? null : { containerId: last.containerId, history },
    hostTotalBytes: host?.memoryTotalBytes ?? null,
    containerMemory,
    hostMemory,
    filesystems: hostFresh ? host.filesystems : [],
    deployment:
      deployment === null
        ? null
        : {
            id: deployment.id,
            status: deployment.status,
            port: probedPort(service.healthcheck, service.internalPort),
            portResponding: healthcheckPortResponding(lines),
          },
  };
  return { snapshot, evidence: assembleServiceEvidence(snapshot, options) };
}
