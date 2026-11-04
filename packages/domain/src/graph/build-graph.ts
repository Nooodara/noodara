// buildGraph (v0.5, ADR 0012, GRF-01): a pure derivation of the Infrastructure Graph from one
// snapshot of registered entities. The output is sorted by id, so the same entities in any order
// give a byte-identical graph. Entities whose parent is missing (or whose id is duplicated) are
// left out and listed in `omitted`, which keeps the invariants: every Service has one RUNS_ON and
// one BELONGS_TO, every Environment one BELONGS_TO, every relation endpoint exists, no orphan
// Domain.

import { containerNameFor } from '../validators/docker-naming.js';
import {
  compareGraphKeys,
  graphNodeId,
  graphRelationId,
  type DomainNode,
  type EnvironmentNode,
  type GraphNodeKind,
  type GraphOmission,
  type GraphSnapshot,
  type InfrastructureGraph,
  type InfrastructureNode,
  type InfrastructureRelation,
  type ProjectNode,
  type ServerNode,
  type ServiceNode,
} from './graph-types.js';

const KIND_ORDER: Readonly<Record<GraphNodeKind, number>> = {
  Server: 0,
  Project: 1,
  Environment: 2,
  Service: 3,
  Domain: 4,
};

const URL_SCHEME = /^[a-z][a-z0-9+.-]*:\/\//i;

/** Keeps the entities whose id is unique; every copy of a duplicated id is omitted. */
function uniqueById<T extends { readonly id: string }>(
  kind: GraphNodeKind,
  items: readonly T[],
  omitted: GraphOmission[],
): Map<string, T> {
  const counts = new Map<string, number>();
  for (const item of items) counts.set(item.id, (counts.get(item.id) ?? 0) + 1);
  const unique = new Map<string, T>();
  for (const item of items) {
    if (counts.get(item.id) === 1) unique.set(item.id, item);
  }
  for (const [id, count] of counts) {
    if (count > 1) omitted.push({ kind, entityId: id, reason: 'duplicate_id' });
  }
  return unique;
}

/**
 * The names a plain env value can use for a service (ADR 0012): the whole value, and the host
 * part when the value is a URL. Compared in lower case, as Docker DNS and hostnames are.
 */
export function namesInEnvValue(value: string): readonly string[] {
  const whole = value.toLowerCase();
  if (!URL_SCHEME.test(value)) return [whole];
  let host: string;
  try {
    host = new URL(value).hostname.toLowerCase();
  } catch {
    return [whole];
  }
  // The scheme keeps `whole` longer than the host, so the two never coincide.
  return host === '' ? [whole] : [whole, host];
}

function indexName(index: Map<string, Set<ServiceNode>>, name: string, service: ServiceNode): void {
  const named = index.get(name) ?? new Set<ServiceNode>();
  named.add(service);
  index.set(name, named);
}

function inferDependsOn(
  snapshot: GraphSnapshot,
  services: ReadonlyMap<string, ServiceNode>,
  hostnames: readonly { readonly hostname: string; readonly service: ServiceNode }[],
): InfrastructureRelation[] {
  // name (container name or hostname, lower case) -> the services it names. A name shared by
  // two services is ambiguous and never yields an edge.
  const index = new Map<string, Set<ServiceNode>>();
  for (const service of services.values()) {
    const container = containerNameFor(service.entityId);
    if (container.ok) indexName(index, container.value, service);
  }
  for (const { hostname, service } of hostnames) indexName(index, hostname.toLowerCase(), service);

  const edges = new Map<string, Set<string>>();
  for (const entry of snapshot.serviceEnv) {
    const source = services.get(entry.serviceId);
    // Secret references are skipped by kind alone: their name is never read or resolved.
    if (source === undefined || entry.value.kind !== 'plain') continue;
    for (const name of namesInEnvValue(entry.value.value)) {
      const named = index.get(name);
      if (named?.size !== 1) continue;
      const [target] = [...named] as [ServiceNode];
      if (target.entityId === source.entityId || target.projectId !== source.projectId) continue;
      const pair = `${source.id}\n${target.id}`;
      const keys = edges.get(pair) ?? new Set<string>();
      keys.add(entry.key);
      edges.set(pair, keys);
    }
  }

  return [...edges].map(([pair, keys]) => {
    const [from, to] = pair.split('\n') as [string, string];
    return {
      id: graphRelationId('DEPENDS_ON', from, to),
      type: 'DEPENDS_ON',
      from,
      to,
      envKeys: [...keys].sort(compareGraphKeys),
    };
  });
}

function relation(
  type: InfrastructureRelation['type'],
  from: string,
  to: string,
): InfrastructureRelation {
  return { id: graphRelationId(type, from, to), type, from, to };
}

export function buildGraph(snapshot: GraphSnapshot): InfrastructureGraph {
  const omitted: GraphOmission[] = [];
  const missing = (kind: GraphNodeKind, entityId: string): void => {
    omitted.push({ kind, entityId, reason: 'missing_parent' });
  };

  const servers = new Map<string, ServerNode>();
  for (const s of uniqueById('Server', snapshot.servers, omitted).values()) {
    servers.set(s.id, {
      id: graphNodeId('Server', s.id),
      kind: 'Server',
      entityId: s.id,
      label: s.name,
    });
  }
  const projects = new Map<string, ProjectNode>();
  for (const p of uniqueById('Project', snapshot.projects, omitted).values()) {
    projects.set(p.id, {
      id: graphNodeId('Project', p.id),
      kind: 'Project',
      entityId: p.id,
      label: p.name,
    });
  }
  const environments = new Map<string, EnvironmentNode>();
  for (const e of uniqueById('Environment', snapshot.environments, omitted).values()) {
    if (!projects.has(e.projectId)) {
      missing('Environment', e.id);
      continue;
    }
    environments.set(e.id, {
      id: graphNodeId('Environment', e.id),
      kind: 'Environment',
      entityId: e.id,
      label: e.name,
      projectId: e.projectId,
    });
  }
  const services = new Map<string, ServiceNode>();
  for (const s of uniqueById('Service', snapshot.services, omitted).values()) {
    const environment = environments.get(s.environmentId);
    if (environment === undefined || !servers.has(s.serverId)) {
      missing('Service', s.id);
      continue;
    }
    services.set(s.id, {
      id: graphNodeId('Service', s.id),
      kind: 'Service',
      entityId: s.id,
      label: s.name,
      projectId: environment.projectId,
      environmentId: s.environmentId,
      serverId: s.serverId,
    });
  }
  const domains: DomainNode[] = [];
  const hostnames: { readonly hostname: string; readonly service: ServiceNode }[] = [];
  for (const d of uniqueById('Domain', snapshot.domains, omitted).values()) {
    const service = services.get(d.serviceId);
    if (service === undefined) {
      missing('Domain', d.id);
      continue;
    }
    domains.push({
      id: graphNodeId('Domain', d.id),
      kind: 'Domain',
      entityId: d.id,
      label: d.hostname,
      projectId: service.projectId,
      environmentId: service.environmentId,
      serviceId: service.entityId,
    });
    hostnames.push({ hostname: d.hostname, service });
  }

  const relations: InfrastructureRelation[] = [];
  for (const e of environments.values()) {
    relations.push(relation('BELONGS_TO', e.id, graphNodeId('Project', e.projectId)));
  }
  for (const s of services.values()) {
    relations.push(relation('RUNS_ON', s.id, graphNodeId('Server', s.serverId)));
    relations.push(relation('BELONGS_TO', s.id, graphNodeId('Environment', s.environmentId)));
  }
  for (const d of domains) {
    relations.push(relation('EXPOSED_BY', graphNodeId('Service', d.serviceId), d.id));
  }
  relations.push(...inferDependsOn(snapshot, services, hostnames));

  const nodes: InfrastructureNode[] = [
    ...servers.values(),
    ...projects.values(),
    ...environments.values(),
    ...services.values(),
    ...domains,
  ];
  return {
    nodes: nodes.sort((a, b) => compareGraphKeys(a.id, b.id)),
    relations: relations.sort((a, b) => compareGraphKeys(a.id, b.id)),
    // One omission per (kind, entityId): duplicates are dropped before parents are checked.
    omitted: omitted.sort(
      (a, b) => KIND_ORDER[a.kind] - KIND_ORDER[b.kind] || compareGraphKeys(a.entityId, b.entityId),
    ),
  };
}
