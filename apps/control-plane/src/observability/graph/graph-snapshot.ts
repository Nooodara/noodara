// 27-05: loads one consistent GraphSnapshot and derives the scoped Infrastructure Graph. Every row
// (scope check included) is read in a single REPEATABLE READ, READ ONLY transaction, so a
// concurrent delete can never produce a relation to a missing node. Env values are parsed and
// resolved (service > environment > project) only to feed DEPENDS_ON inference; buildGraph skips
// secret references by kind and the result carries no value.
import {
  buildGraph,
  parseEnvValue,
  resolveEnv,
  scopeGraph,
  type EnvDefinition,
  type EnvValue,
  type GraphSnapshot,
  type InfrastructureGraph,
} from '@noodara/domain';
import { and, eq } from 'drizzle-orm';
import type { Database } from '../../db/client.js';
import { domains, environmentVariables, environments, projects, servers, services } from '../../db/schema/index.js';

export type GraphScopeRequest =
  | { readonly kind: 'global' }
  | { readonly kind: 'project'; readonly projectId: string }
  | { readonly kind: 'environment'; readonly projectId: string; readonly environmentId: string };

export type GraphLoadResult =
  | { readonly found: true; readonly graph: InfrastructureGraph }
  | { readonly found: false; readonly missing: 'project' | 'environment' };

interface EnvRow {
  readonly scope: 'project' | 'environment' | 'service';
  readonly projectId: string;
  readonly environmentId: string | null;
  readonly serviceId: string | null;
  readonly key: string;
  readonly value: string;
}

function storedValue(raw: string): EnvValue {
  const parsed = parseEnvValue(raw);
  // Rows are validated on write; an unparseable one is plain text, never a secret reference.
  return parsed.ok ? parsed.value : { kind: 'plain', value: raw };
}

function push(index: Map<string, EnvDefinition[]>, owner: string, definition: EnvDefinition): void {
  const list = index.get(owner) ?? [];
  list.push(definition);
  index.set(owner, list);
}

/** Each service's effective env, resolved with the same precedence as a deploy. */
export function serviceEnvOf(
  serviceRows: readonly { readonly id: string; readonly projectId: string; readonly environmentId: string }[],
  envRows: readonly EnvRow[],
): GraphSnapshot['serviceEnv'] {
  const byProject = new Map<string, EnvDefinition[]>();
  const byEnvironment = new Map<string, EnvDefinition[]>();
  const byService = new Map<string, EnvDefinition[]>();
  for (const row of envRows) {
    const definition = { key: row.key, value: storedValue(row.value) };
    if (row.scope === 'project') push(byProject, row.projectId, definition);
    else if (row.scope === 'environment' && row.environmentId !== null) push(byEnvironment, row.environmentId, definition);
    else if (row.scope === 'service' && row.serviceId !== null) push(byService, row.serviceId, definition);
  }
  const out: { serviceId: string; key: string; value: EnvValue }[] = [];
  for (const service of serviceRows) {
    const resolved = resolveEnv(
      byProject.get(service.projectId) ?? [],
      byEnvironment.get(service.environmentId) ?? [],
      byService.get(service.id) ?? [],
    );
    for (const entry of resolved) out.push({ serviceId: service.id, key: entry.key, value: entry.value });
  }
  return out;
}

export async function loadScopedGraph(db: Database, scope: GraphScopeRequest): Promise<GraphLoadResult> {
  return db.transaction(
    async (tx) => {
      const projectId = scope.kind === 'global' ? null : scope.projectId;
      if (projectId !== null) {
        const [project] = await tx.select({ id: projects.id }).from(projects).where(eq(projects.id, projectId));
        if (project === undefined) return { found: false, missing: 'project' } as const;
      }
      if (scope.kind === 'environment') {
        const [environment] = await tx
          .select({ id: environments.id })
          .from(environments)
          .where(and(eq(environments.id, scope.environmentId), eq(environments.projectId, scope.projectId)));
        if (environment === undefined) return { found: false, missing: 'environment' } as const;
      }

      const serverRows = await tx.select({ id: servers.id, name: servers.name }).from(servers);
      const projectRows = await tx
        .select({ id: projects.id, name: projects.name })
        .from(projects)
        .where(projectId === null ? undefined : eq(projects.id, projectId));
      const environmentRows = await tx
        .select({ id: environments.id, projectId: environments.projectId, name: environments.name })
        .from(environments)
        .where(projectId === null ? undefined : eq(environments.projectId, projectId));
      const serviceRows = await tx
        .select({
          id: services.id,
          projectId: services.projectId,
          environmentId: services.environmentId,
          serverId: services.serverId,
          name: services.name,
        })
        .from(services)
        .where(projectId === null ? undefined : eq(services.projectId, projectId));
      const domainRows = await tx
        .select({ id: domains.id, serviceId: domains.serviceId, hostname: domains.hostname })
        .from(domains)
        .where(projectId === null ? undefined : eq(domains.projectId, projectId));
      const envRows = await tx
        .select({
          scope: environmentVariables.scope,
          projectId: environmentVariables.projectId,
          environmentId: environmentVariables.environmentId,
          serviceId: environmentVariables.serviceId,
          key: environmentVariables.key,
          value: environmentVariables.value,
        })
        .from(environmentVariables)
        .where(projectId === null ? undefined : eq(environmentVariables.projectId, projectId));

      const graph = buildGraph({
        servers: serverRows,
        projects: projectRows,
        environments: environmentRows,
        services: serviceRows,
        domains: domainRows,
        serviceEnv: serviceEnvOf(serviceRows, envRows),
      });
      if (scope.kind === 'global') return { found: true, graph } as const;
      const scoped =
        scope.kind === 'project'
          ? scopeGraph(graph, { projectIds: [scope.projectId] })
          : scopeGraph(graph, { environmentIds: [scope.environmentId] });
      return { found: true, graph: scoped } as const;
    },
    { isolationLevel: 'repeatable read', accessMode: 'read only' },
  );
}
