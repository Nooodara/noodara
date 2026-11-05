// 29-01 (A1): the in-memory ReadToolBackend behind the real tool registry. It mirrors the
// control-plane backend (apps/control-plane/src/ai/tools/read-tool-backend.ts): the same AI
// projections (no host, SSH user, credentials or webhook ids), the same scoping (an id outside the
// conversation's scope is NOT_FOUND, never FORBIDDEN) and the same graph view. Only the storage
// differs: a FixtureModel instead of Postgres and the runtime log window.
import type { AuthorizationScope, ReadToolBackend, ToolOutcome } from '@noodara/ai';
import {
  buildGraph,
  highDisk,
  highMemory,
  isTerminalDeploymentStatus,
  logEntryMatches,
  memoryPercent,
  diskUsedPercent,
  scopeGraph,
  type Redactor,
} from '@noodara/domain';
import { toGraphView } from '../../../../apps/control-plane/src/observability/graph/graph-view.js';
import {
  MIB,
  SAMPLE_INTERVAL_SECONDS,
  containerMemoryReadings,
  rootFilesystem,
  serverOf,
  type FixtureModel,
  type ModelDeployment,
  type ModelServer,
  type ModelService,
} from './fixture-model.js';

/** Rows a list tool answers at most, as AI_TOOL_LIST_MAX_ROWS in the control plane. */
export const FIXTURE_LIST_MAX_ROWS = 100;

const NOT_FOUND: ToolOutcome = Object.freeze({ ok: false, code: 'NOT_FOUND' });
const ok = (data: unknown): ToolOutcome => ({ ok: true, data });
const page = <T>(rows: readonly T[]) => ({
  items: rows.slice(0, FIXTURE_LIST_MAX_ROWS),
  truncated: rows.length > FIXTURE_LIST_MAX_ROWS,
});
const byName = <T extends { readonly name: string; readonly id: string }>(a: T, b: T) =>
  a.name < b.name ? -1 : a.name > b.name ? 1 : a.id < b.id ? -1 : 1;

export interface FixtureBackendOptions {
  /** Applied to every log line, as the control plane redacts with the service's secret values. */
  readonly redactor?: Redactor;
}

export function createFixtureBackend(model: FixtureModel, options: FixtureBackendOptions = {}): ReadToolBackend {
  const iso = (msAgo: number) => new Date(model.nowMs - msAgo).toISOString();
  const createdAt = iso(30 * 24 * 3600 * 1000);

  function visibleService(serviceId: string, scope: AuthorizationScope): ModelService | null {
    const service = model.services.find((candidate) => candidate.id === serviceId);
    if (service === undefined) return null;
    return scope.kind === 'project' && service.projectId !== scope.projectId ? null : service;
  }
  function serverVisible(server: ModelServer, scope: AuthorizationScope): boolean {
    return scope.kind === 'global' || model.services.some((s) => s.serverId === server.id && s.projectId === scope.projectId);
  }
  function visibleServer(serverId: string, scope: AuthorizationScope): ModelServer | null {
    const server = model.servers.find((candidate) => candidate.id === serverId);
    return server !== undefined && serverVisible(server, scope) ? server : null;
  }
  function narrow(
    input: { readonly projectId?: string | undefined; readonly environmentId?: string | undefined },
    scope: AuthorizationScope,
  ): { projectId: string | null; environmentId: string | null } | null {
    if (input.projectId !== undefined) {
      if (scope.kind === 'project' && input.projectId !== scope.projectId) return null;
      if (!model.projects.some((project) => project.id === input.projectId)) return null;
    }
    if (input.environmentId !== undefined) {
      const environment = model.environments.find((candidate) => candidate.id === input.environmentId);
      if (environment === undefined) return null;
      if (scope.kind === 'project' && environment.projectId !== scope.projectId) return null;
      if (input.projectId !== undefined && environment.projectId !== input.projectId) return null;
      return { projectId: environment.projectId, environmentId: environment.id };
    }
    return { projectId: input.projectId ?? (scope.kind === 'project' ? scope.projectId : null), environmentId: null };
  }

  const serverView = (server: ModelServer) => ({
    id: server.id,
    name: server.name,
    status: server.status,
    hostname: server.name,
    osDistribution: 'ubuntu',
    osVersion: server.os,
    arch: server.arch,
    cpuCores: server.cpuCores,
    ramMb: server.ramMb,
    diskTotalMb: server.diskTotalMb,
    diskUsedMb: server.diskUsedMb,
    uptimeSeconds: server.uptimeSeconds,
    dockerInstalled: true,
    dockerVersion: '27.3.1',
    dockerComposeVersion: '2.29.7',
    dockerBuildkitAvailable: true,
    proxyStatus: null,
    proxyErrorCode: null,
    lastSeenAt: iso(server.lastSeenSecondsAgo * 1000),
    createdAt,
  });

  const source = (service: ModelService) => ({
    sourceType: service.image === undefined ? ('git' as const) : ('image' as const),
    repositoryUrl: service.repository ?? null,
    branch: service.repository === undefined ? null : service.branch,
    buildContext: service.repository === undefined ? null : '.',
    dockerfilePath: service.repository === undefined ? null : 'Dockerfile',
    buildTarget: null,
    imageRef: service.image ?? null,
    internalPort: service.internalPort,
    publishedPort: service.publishedPort,
  });

  const serviceView = (service: ModelService) => {
    const { sourceType, repositoryUrl, branch, buildContext, dockerfilePath, buildTarget, imageRef, internalPort, publishedPort } = source(service);
    return {
      id: service.id,
      projectId: service.projectId,
      environmentId: service.environmentId,
      serverId: service.serverId,
      name: service.name,
      sourceType,
      repositoryUrl,
      branch,
      buildContext,
      dockerfilePath,
      buildTarget,
      imageRef,
      internalPort,
      publishedPort,
      healthcheck: service.healthcheckPath === null ? null : { path: service.healthcheckPath },
      autoRollback: true,
      imageRetention: 3,
      status: service.status,
      createdAt,
      updatedAt: iso(0),
    };
  };

  function deploymentView(service: ModelService, deployment: ModelDeployment) {
    const startedMs = model.nowMs - deployment.startedMinutesAgo * 60_000;
    const terminal = isTerminalDeploymentStatus(deployment.status);
    const durationMs = terminal && deployment.durationSeconds !== null ? deployment.durationSeconds * 1000 : null;
    const started = new Date(startedMs).toISOString();
    return {
      id: deployment.id,
      serviceId: service.id,
      status: deployment.status,
      trigger: deployment.trigger,
      triggeredBy: deployment.trigger === 'webhook' ? null : 'admin',
      source: source(service),
      commitSha: deployment.commit,
      previousDeploymentId: deployment.previousDeploymentId,
      rollbackOfDeploymentId: null,
      imageRef: deployment.imageRef,
      webhookDeliveryId: null,
      startedAt: started,
      completedAt: durationMs === null ? null : new Date(startedMs + durationMs).toISOString(),
      durationMs,
      errorCode: deployment.errorCode,
      errorMessage: deployment.errorMessage,
      createdAt: started,
      updatedAt: durationMs === null ? started : new Date(startedMs + durationMs).toISOString(),
    };
  }

  function healthView(service: ModelService) {
    const server = serverOf(model, service.serverId);
    const last = service.deployments.at(-1);
    const lastView = last === undefined ? null : deploymentView(service, last);
    return {
      serviceId: service.id,
      runtimeStatus: service.status,
      container:
        service.container === null
          ? null
          : {
              state: service.container.state,
              restartCount: service.container.restartCount,
              healthcheck: service.container.healthcheck,
              observedAt: iso(service.container.observedSecondsAgo * 1000),
            },
      lastDeployment:
        last === undefined || lastView === null
          ? null
          : { id: last.id, status: last.status, commitSha: last.commit, finishedAt: lastView.completedAt },
      flags: {
        highMemory: highMemory(containerMemoryReadings(service), { hostTotalBytes: server.ramMb * MIB }),
        highDisk: server.status === 'CONNECTED' && highDisk(rootFilesystem(server)),
      },
    };
  }

  function series(scope: 'server' | 'service', entityId: string, metric: string, values: readonly (number | null)[], points: number) {
    const kept = values.slice(-points);
    const at = (index: number) => iso((kept.length - 1 - index) * SAMPLE_INTERVAL_SECONDS * 1000);
    return {
      scope,
      entityId,
      metric,
      from: kept.length === 0 ? iso(0) : at(0),
      to: iso(0),
      intervalSeconds: SAMPLE_INTERVAL_SECONDS,
      points: kept.map((v, index) => ({ t: at(index), v })),
    };
  }

  return {
    get_server(input, scope) {
      const server = visibleServer(input.serverId, scope);
      return Promise.resolve(server === null ? NOT_FOUND : ok(serverView(server)));
    },
    list_servers(_input, scope) {
      const rows = model.servers.filter((server) => serverVisible(server, scope)).sort(byName).map(serverView);
      return Promise.resolve(ok(page(rows)));
    },
    get_service(input, scope) {
      const service = visibleService(input.serviceId, scope);
      return Promise.resolve(service === null ? NOT_FOUND : ok(serviceView(service)));
    },
    list_services(input, scope) {
      const target = narrow(input, scope);
      if (target === null) return Promise.resolve(NOT_FOUND);
      const rows = model.services
        .filter(
          (service) =>
            (target.projectId === null || service.projectId === target.projectId) &&
            (target.environmentId === null || service.environmentId === target.environmentId),
        )
        .sort(byName)
        .map(serviceView);
      return Promise.resolve(ok(page(rows)));
    },
    get_deployment(input, scope) {
      for (const service of model.services) {
        const deployment = service.deployments.find((candidate) => candidate.id === input.deploymentId);
        if (deployment === undefined) continue;
        return Promise.resolve(visibleService(service.id, scope) === null ? NOT_FOUND : ok(deploymentView(service, deployment)));
      }
      return Promise.resolve(NOT_FOUND);
    },
    list_deployments(input, scope) {
      const service = visibleService(input.serviceId, scope);
      if (service === null) return Promise.resolve(NOT_FOUND);
      const newestFirst = [...service.deployments].reverse();
      return Promise.resolve(
        ok({ items: newestFirst.slice(0, input.limit).map((d) => deploymentView(service, d)), hasOlder: newestFirst.length > input.limit }),
      );
    },
    get_health(input, scope) {
      const service = visibleService(input.serviceId, scope);
      return Promise.resolve(service === null ? NOT_FOUND : ok(healthView(service)));
    },
    get_metrics(input, scope) {
      if (input.target === 'server') {
        const server = visibleServer(input.id, scope);
        if (server === null) return Promise.resolve(NOT_FOUND);
        const memory = server.memoryUsedMb.map((mb) => mb * MIB);
        const disk = diskUsedPercent(rootFilesystem(server));
        return Promise.resolve(
          ok({
            series: [
              series('server', server.id, 'cpu_percent', server.cpuPercent, input.points),
              series('server', server.id, 'memory_used_bytes', memory, input.points),
              series('server', server.id, 'memory_percent', memory.map((b) => (b * 100) / (server.ramMb * MIB)), input.points),
              series('server', server.id, 'disk_used_percent', [disk], input.points),
            ],
            server: {
              serverId: server.id,
              connectionState: server.status,
              lastSeenAt: iso(server.lastSeenSecondsAgo * 1000),
              uptimeSeconds: server.uptimeSeconds,
              sampledAt: server.status === 'CONNECTED' ? iso(0) : null,
            },
          }),
        );
      }
      const service = visibleService(input.id, scope);
      if (service === null) return Promise.resolve(NOT_FOUND);
      const hostTotal = serverOf(model, service.serverId).ramMb * MIB;
      const readings = containerMemoryReadings(service);
      const restarts = service.container === null ? [] : [service.container.restartCount];
      return Promise.resolve(
        ok({
          series: [
            series('service', service.id, 'cpu_percent', service.cpuPercent, input.points),
            series('service', service.id, 'memory_used_bytes', readings.map((r) => r.usedBytes), input.points),
            series('service', service.id, 'memory_percent', readings.map((r) => memoryPercent(r, hostTotal)), input.points),
            series('service', service.id, 'restart_count', restarts, input.points),
          ],
        }),
      );
    },
    get_logs(input, scope) {
      const service = visibleService(input.serviceId, scope);
      if (service === null) return Promise.resolve(NOT_FOUND);
      const runtimeReadable = serverOf(model, service.serverId).status === 'CONNECTED';
      const sources = input.filter.sources.filter((s) => s !== 'runtime' || runtimeReadable);
      if (sources.length === 0) return Promise.resolve({ ok: false, code: 'LOG_SOURCE_UNAVAILABLE' } as const);
      const matched = service.logs.filter((entry) => logEntryMatches(entry, { ...input.filter, sources }));
      const window = matched.slice(-input.limit);
      const entries = [];
      let bytes = 0;
      let truncated = false;
      for (const entry of [...window].reverse()) {
        const text = options.redactor === undefined ? entry.text : options.redactor.redact(entry.text);
        bytes += Buffer.byteLength(text);
        if (bytes > input.maxBytes) {
          truncated = true;
          break;
        }
        entries.unshift({ ...entry, text, truncated: false });
      }
      return Promise.resolve(
        ok({
          entries,
          truncated,
          hasOlder: matched.length > entries.length,
          unavailable: input.filter.sources.filter((s) => !sources.includes(s)),
        }),
      );
    },
    get_infrastructure_graph(input, scope) {
      const target = narrow(input, scope);
      if (target === null) return Promise.resolve(NOT_FOUND);
      const graph = buildGraph({
        servers: model.servers.map(({ id, name }) => ({ id, name })),
        projects: model.projects,
        environments: model.environments,
        services: model.services.map(({ id, environmentId, serverId, name }) => ({ id, environmentId, serverId, name })),
        domains: model.services.flatMap((service) => service.domains.map((d) => ({ id: d.id, serviceId: service.id, hostname: d.hostname }))),
        serviceEnv: model.services.flatMap((service) => service.env.map((e) => ({ serviceId: service.id, key: e.key, value: e.value }))),
      });
      const scoped =
        target.projectId === null
          ? graph
          : scopeGraph(graph, target.environmentId === null ? { projectIds: [target.projectId] } : { environmentIds: [target.environmentId] });
      return Promise.resolve(ok(toGraphView(scoped, input.maxNodes)));
    },
  };
}
