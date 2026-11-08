// 28-03 (A2-A4): the control-plane side of the AI read-only tools. Each read goes to Postgres or
// to the 27-xx observability reads; the only remote operation reachable is the runtime log window
// (docker.logs_window) through queryServiceLogs. Every read is checked against the conversation's
// AuthorizationScope: an id outside it answers NOT_FOUND, exactly like a missing one.
//
// The types here mirror packages/ai/src/tools/types.ts structurally (the registry composes this
// backend as its ReadToolBackend); they are kept local so this module does not import @noodara/ai.
import { and, asc, eq, inArray } from 'drizzle-orm';
import type { LogFilter } from '@noodara/domain';
import type { Database } from '../../db/client.js';
import { environments, projects, servers, services } from '../../db/schema/index.js';
import { loadScopedGraph, type GraphScopeRequest } from '../../observability/graph/graph-snapshot.js';
import { toGraphView } from '../../observability/graph/graph-view.js';
import { openServiceRedactor, type LogConnect, type LogServiceRef, type ServiceRedactor } from '../../observability/logs/log-sources.js';
import { queryServiceLogs } from '../../observability/logs/log-query.js';
import { parseMetricRange } from '../../observability/metric-range.js';
import { readServerMetrics, readServiceMetrics, readServiceStatus, type ServerRef, type ServiceRef } from '../../observability/metrics-read.js';
import type { MasterKeys } from '../../services/server-service-deps.js';
import { getDeployment, listDeployments } from '../../services/deployment-services.js';
import { SERVER_COLUMNS, SERVICE_COLUMNS } from './read-projections.js';

export type ToolScope = { readonly kind: 'global' } | { readonly kind: 'project'; readonly projectId: string };

export type ReadErrorCode = 'NOT_FOUND' | 'INVALID_ARGUMENTS' | 'TOOL_UNAVAILABLE' | 'LOG_SOURCE_UNAVAILABLE' | 'METRICS_UNAVAILABLE';

export type ReadOutcome = { readonly ok: true; readonly data: unknown } | { readonly ok: false; readonly code: ReadErrorCode };

type Read<I> = (input: I, scope: ToolScope) => Promise<ReadOutcome>;

export interface ControlPlaneReadTools {
  readonly get_server: Read<{ readonly serverId: string }>;
  readonly list_servers: Read<unknown>;
  readonly get_service: Read<{ readonly serviceId: string }>;
  readonly list_services: Read<{ readonly projectId?: string | undefined; readonly environmentId?: string | undefined }>;
  readonly get_deployment: Read<{ readonly deploymentId: string }>;
  readonly list_deployments: Read<{ readonly serviceId: string; readonly limit: number }>;
  readonly get_health: Read<{ readonly serviceId: string }>;
  readonly get_metrics: Read<{
    readonly target: 'server' | 'service';
    readonly id: string;
    readonly from?: string | undefined;
    readonly to?: string | undefined;
    readonly points: number;
  }>;
  readonly get_logs: Read<{ readonly serviceId: string; readonly filter: LogFilter; readonly limit: number; readonly maxBytes: number }>;
  readonly get_infrastructure_graph: Read<{
    readonly projectId?: string | undefined;
    readonly environmentId?: string | undefined;
    readonly maxNodes: number;
  }>;
}

export interface ReadToolBackendDeps {
  readonly db: Database;
  /** Opens the runtime log session; only docker.logs_window runs over it. */
  readonly connect: LogConnect;
  readonly masterKeys: () => Promise<MasterKeys>;
  readonly metricsIntervalMs: number;
  readonly metricsRetentionMs: number;
  /** Bound of one runtime log read (connect + fetch). */
  readonly runtimeTimeoutMs?: number;
  readonly now?: () => number;
}

/** Rows a list tool answers at most; the envelope caps bytes on top. */
export const AI_TOOL_LIST_MAX_ROWS = 100;
const RUNTIME_TIMEOUT_DEFAULT_MS = 15_000;

const NOT_FOUND: ReadOutcome = Object.freeze({ ok: false, code: 'NOT_FOUND' });
const UNAVAILABLE: ReadOutcome = Object.freeze({ ok: false, code: 'TOOL_UNAVAILABLE' });
const INVALID: ReadOutcome = Object.freeze({ ok: false, code: 'INVALID_ARGUMENTS' });

function ok(data: unknown): ReadOutcome {
  return { ok: true, data };
}

function page<T>(rows: readonly T[]): { items: T[]; truncated: boolean } {
  return { items: rows.slice(0, AI_TOOL_LIST_MAX_ROWS), truncated: rows.length > AI_TOOL_LIST_MAX_ROWS };
}

export function createReadToolBackend(deps: ReadToolBackendDeps): ControlPlaneReadTools {
  const { db } = deps;
  const now = deps.now ?? Date.now;
  const runtimeTimeoutMs = deps.runtimeTimeoutMs ?? RUNTIME_TIMEOUT_DEFAULT_MS;

  /** The service, when it exists and is visible in the scope. */
  async function visibleService(serviceId: string, scope: ToolScope): Promise<(LogServiceRef & ServiceRef) | null> {
    const [row] = await db
      .select({
        id: services.id,
        projectId: services.projectId,
        environmentId: services.environmentId,
        serverId: services.serverId,
        status: services.status,
      })
      .from(services)
      .where(scope.kind === 'project' ? and(eq(services.id, serviceId), eq(services.projectId, scope.projectId)) : eq(services.id, serviceId))
      .limit(1);
    return row ?? null;
  }

  /**
   * 31-11 (A3): `value` redacted with the secret values of every service in `refs` (project,
   * environment and service scope), released afterwards; null when a secret cannot be read, so the
   * caller fails closed instead of answering unredacted.
   */
  async function redactForServices<T>(refs: readonly LogServiceRef[], value: T): Promise<{ value: T } | null> {
    const opened: ServiceRedactor[] = [];
    try {
      for (const ref of refs) opened.push(await openServiceRedactor(db, ref, deps.masterKeys));
      let redacted = value;
      for (const entry of opened) redacted = entry.redactor.redact(redacted);
      return { value: redacted };
    } catch {
      return null;
    } finally {
      for (const entry of opened) entry.release();
    }
  }

  /** Host-discovered text is whatever the host printed: redact it with every hosted service's secrets. */
  async function redactServerRows<T>(serverIds: readonly string[], value: T): Promise<{ value: T } | null> {
    if (serverIds.length === 0) return { value };
    const hosted = await db
      .select({ id: services.id, projectId: services.projectId, environmentId: services.environmentId, serverId: services.serverId })
      .from(services)
      .where(inArray(services.serverId, [...serverIds]));
    return redactForServices(hosted, value);
  }

  /** In a project scope a server is visible only while it hosts one of the project's services. */
  function serverVisibility(scope: ToolScope) {
    return scope.kind === 'project'
      ? inArray(servers.id, db.select({ id: services.serverId }).from(services).where(eq(services.projectId, scope.projectId)))
      : undefined;
  }

  async function visibleServer(serverId: string, scope: ToolScope): Promise<ServerRef | null> {
    const [row] = await db
      .select({ id: servers.id, status: servers.status, lastSeenAt: servers.lastSeenAt })
      .from(servers)
      .where(and(eq(servers.id, serverId), serverVisibility(scope)))
      .limit(1);
    return row ?? null;
  }

  /** The project an environment belongs to, when it exists and is visible. */
  async function environmentProject(environmentId: string, scope: ToolScope): Promise<string | null> {
    const [row] = await db
      .select({ projectId: environments.projectId })
      .from(environments)
      .where(eq(environments.id, environmentId))
      .limit(1);
    if (row === undefined) return null;
    return scope.kind === 'project' && row.projectId !== scope.projectId ? null : row.projectId;
  }

  async function projectVisible(projectId: string, scope: ToolScope): Promise<boolean> {
    if (scope.kind === 'project' && projectId !== scope.projectId) return false;
    const [row] = await db.select({ id: projects.id }).from(projects).where(eq(projects.id, projectId)).limit(1);
    return row !== undefined;
  }

  /** Resolves optional project/environment ids against the scope; null when either is not visible. */
  async function narrow(
    input: { readonly projectId?: string | undefined; readonly environmentId?: string | undefined },
    scope: ToolScope,
  ): Promise<{ projectId: string | null; environmentId: string | null } | null> {
    if (input.projectId !== undefined && !(await projectVisible(input.projectId, scope))) return null;
    if (input.environmentId !== undefined) {
      const projectId = await environmentProject(input.environmentId, scope);
      if (projectId === null || (input.projectId !== undefined && projectId !== input.projectId)) return null;
      return { projectId, environmentId: input.environmentId };
    }
    return { projectId: input.projectId ?? (scope.kind === 'project' ? scope.projectId : null), environmentId: null };
  }

  return {
    async get_server(input, scope) {
      const [row] = await db
        .select(SERVER_COLUMNS)
        .from(servers)
        .where(and(eq(servers.id, input.serverId), serverVisibility(scope)))
        .limit(1);
      if (row === undefined) return NOT_FOUND;
      const redacted = await redactServerRows([row.id], row);
      return redacted === null ? UNAVAILABLE : ok(redacted.value);
    },

    async list_servers(_input, scope) {
      const rows = await db
        .select(SERVER_COLUMNS)
        .from(servers)
        .where(serverVisibility(scope))
        .orderBy(asc(servers.name), asc(servers.id))
        .limit(AI_TOOL_LIST_MAX_ROWS + 1);
      const listed = page(rows);
      const redacted = await redactServerRows(
        listed.items.map((row) => row.id),
        listed,
      );
      return redacted === null ? UNAVAILABLE : ok(redacted.value);
    },

    async get_service(input, scope) {
      const visible = await visibleService(input.serviceId, scope);
      if (visible === null) return NOT_FOUND;
      const [row] = await db.select(SERVICE_COLUMNS).from(services).where(eq(services.id, visible.id)).limit(1);
      if (row === undefined) return NOT_FOUND;
      const redacted = await redactForServices([visible], row);
      return redacted === null ? UNAVAILABLE : ok(redacted.value);
    },

    async list_services(input, scope) {
      const target = await narrow(input, scope);
      if (target === null) return NOT_FOUND;
      const rows = await db
        .select(SERVICE_COLUMNS)
        .from(services)
        .where(
          and(
            target.projectId === null ? undefined : eq(services.projectId, target.projectId),
            target.environmentId === null ? undefined : eq(services.environmentId, target.environmentId),
          ),
        )
        .orderBy(asc(services.name), asc(services.id))
        .limit(AI_TOOL_LIST_MAX_ROWS + 1);
      const listed = page(rows);
      const redacted = await redactForServices(listed.items, listed);
      return redacted === null ? UNAVAILABLE : ok(redacted.value);
    },

    async get_deployment(input, scope) {
      const deployment = await getDeployment({ db }, input.deploymentId);
      if (deployment === null) return NOT_FOUND;
      const service = await visibleService(deployment.serviceId, scope);
      if (service === null) return NOT_FOUND;
      const redacted = await redactForServices([service], deployment);
      return redacted === null ? UNAVAILABLE : ok(redacted.value);
    },

    async list_deployments(input, scope) {
      const service = await visibleService(input.serviceId, scope);
      if (service === null) return NOT_FOUND;
      const result = await listDeployments({ db }, input.serviceId, { limit: input.limit });
      if (result === null) return NOT_FOUND;
      const redacted = await redactForServices([service], { items: result.items, hasOlder: result.nextCursor !== null });
      return redacted === null ? UNAVAILABLE : ok(redacted.value);
    },

    async get_health(input, scope) {
      const service = await visibleService(input.serviceId, scope);
      if (service === null) return NOT_FOUND;
      return ok(await readServiceStatus(db, service, { nowMs: now(), intervalMs: deps.metricsIntervalMs }));
    },

    async get_metrics(input, scope) {
      const range = parseMetricRange(
        { from: input.from, to: input.to, points: String(input.points) },
        { nowMs: now(), retentionMs: deps.metricsRetentionMs },
      );
      if (!range.ok) return INVALID;
      if (input.target === 'server') {
        const server = await visibleServer(input.id, scope);
        return server === null ? NOT_FOUND : ok(await readServerMetrics(db, server, range.range));
      }
      const service = await visibleService(input.id, scope);
      return service === null ? NOT_FOUND : ok({ series: await readServiceMetrics(db, service, range.range) });
    },

    async get_logs(input, scope) {
      const service = await visibleService(input.serviceId, scope);
      if (service === null) return NOT_FOUND;
      const result = await queryServiceLogs(
        { db, connect: deps.connect, masterKeys: deps.masterKeys, runtimeTimeoutMs, pageMaxBytes: input.maxBytes },
        service,
        { filter: input.filter, cursor: null, limit: input.limit, windowClamped: false },
      );
      if (!result.ok) return { ok: false, code: result.code };
      return ok({
        entries: result.page.entries,
        truncated: result.page.truncated,
        hasOlder: result.page.next !== null,
        unavailable: result.unavailable,
      });
    },

    async get_infrastructure_graph(input, scope) {
      const target = await narrow(input, scope);
      if (target === null) return NOT_FOUND;
      const request: GraphScopeRequest =
        target.projectId === null
          ? { kind: 'global' }
          : target.environmentId === null
            ? { kind: 'project', projectId: target.projectId }
            : { kind: 'environment', projectId: target.projectId, environmentId: target.environmentId };
      const result = await loadScopedGraph(db, request);
      return result.found ? ok(toGraphView(result.graph, input.maxNodes)) : NOT_FOUND;
    },
  };
}
