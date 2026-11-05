// 30-03: the project graph as a view model. Pure. Environment -> Service, each service with its
// RUNS_ON server, EXPOSED_BY domains and DEPENDS_ON services. Every href is built from a node's
// entity id (a UUID, checked again here); names, labels and hostnames are only ever text.
import type { GraphNodeView, ProjectGraph } from '../../lib/api/graph-api';
import { isUuid } from '../../lib/api/graph-api';
import { environmentHref, projectHref, serviceHref } from '../ProjectNav';

export interface GraphLink {
  readonly nodeId: string;
  readonly label: string;
  readonly href: string;
}

export interface GraphDomain {
  readonly nodeId: string;
  readonly hostname: string;
  /** The owning service's page, where the domain is managed. */
  readonly settingsHref: string;
}

export interface GraphService extends GraphLink {
  readonly servers: readonly GraphLink[];
  readonly domains: readonly GraphDomain[];
  readonly dependsOn: readonly GraphLink[];
}

export interface GraphEnvironment extends GraphLink {
  readonly services: readonly GraphService[];
}

export interface GraphModel {
  readonly project: GraphLink | null;
  readonly environments: readonly GraphEnvironment[];
  readonly servers: readonly GraphLink[];
  readonly serviceCount: number;
  readonly truncated: boolean;
}

type NodeOf<K extends GraphNodeView['kind']> = Extract<GraphNodeView, { kind: K }>;

function byLabel(a: { readonly label: string }, b: { readonly label: string }): number {
  return a.label.localeCompare(b.label, undefined, { sensitivity: 'base' });
}

/** The node's detail page, or null when an id it needs is not a UUID. */
export function nodeHref(node: GraphNodeView): string | null {
  if (!isUuid(node.entityId)) return null;
  switch (node.kind) {
    case 'Server':
      return `/servers/${node.entityId}`;
    case 'Project':
      return projectHref(node.entityId);
    case 'Environment':
      return isUuid(node.projectId) ? environmentHref(node.projectId, node.entityId) : null;
    case 'Service':
      return isUuid(node.projectId) ? serviceHref(node.projectId, node.entityId) : null;
    case 'Domain':
      return isUuid(node.projectId) && isUuid(node.serviceId) ? serviceHref(node.projectId, node.serviceId) : null;
  }
}

function link(node: GraphNodeView): GraphLink | null {
  const href = nodeHref(node);
  return href === null ? null : { nodeId: node.id, label: node.label, href };
}

function present<T>(value: T | null): value is T {
  return value !== null;
}

export function buildGraphModel(graph: ProjectGraph): GraphModel {
  const byId = new Map<string, GraphNodeView>();
  for (const node of graph.nodes) byId.set(node.id, node);
  const ofKind = <K extends GraphNodeView['kind']>(id: string, kind: K): NodeOf<K> | null => {
    const node = byId.get(id);
    return node?.kind === kind ? (node as NodeOf<K>) : null;
  };

  const outgoing = new Map<string, Map<string, string[]>>();
  for (const relation of graph.relations) {
    const byType = outgoing.get(relation.from) ?? new Map<string, string[]>();
    const targets = byType.get(relation.type) ?? [];
    targets.push(relation.to);
    byType.set(relation.type, targets);
    outgoing.set(relation.from, byType);
  }
  const targets = (from: string, type: string): readonly string[] => outgoing.get(from)?.get(type) ?? [];

  const servicesByEnvironment = new Map<string, GraphService[]>();
  let serviceCount = 0;
  for (const node of graph.nodes) {
    if (node.kind !== 'Service') continue;
    const self = link(node);
    if (self === null) continue;
    const environmentNodeId =
      targets(node.id, 'BELONGS_TO').find((id) => ofKind(id, 'Environment') !== null) ?? `environment:${node.environmentId}`;
    const servers = targets(node.id, 'RUNS_ON')
      .map((id) => ofKind(id, 'Server'))
      .filter(present)
      .map(link)
      .filter(present)
      .sort(byLabel);
    const domains = targets(node.id, 'EXPOSED_BY')
      .map((id) => ofKind(id, 'Domain'))
      .filter(present)
      .map((domain): GraphDomain | null => {
        const settingsHref = nodeHref(domain);
        return settingsHref === null ? null : { nodeId: domain.id, hostname: domain.label, settingsHref };
      })
      .filter(present)
      .sort((a, b) => a.hostname.localeCompare(b.hostname));
    const dependsOn = targets(node.id, 'DEPENDS_ON')
      .map((id) => ofKind(id, 'Service'))
      .filter(present)
      .map(link)
      .filter(present)
      .sort(byLabel);
    const list = servicesByEnvironment.get(environmentNodeId) ?? [];
    list.push({ ...self, servers, domains, dependsOn });
    servicesByEnvironment.set(environmentNodeId, list);
    serviceCount += 1;
  }

  const environments: GraphEnvironment[] = [];
  const servers: GraphLink[] = [];
  let project: GraphLink | null = null;
  for (const node of graph.nodes) {
    if (node.kind === 'Environment') {
      const self = link(node);
      if (self === null) continue;
      environments.push({ ...self, services: (servicesByEnvironment.get(node.id) ?? []).sort(byLabel) });
    } else if (node.kind === 'Server') {
      const self = link(node);
      if (self !== null) servers.push(self);
    } else if (node.kind === 'Project' && project === null) {
      project = link(node);
    }
  }

  return {
    project,
    environments: environments.sort(byLabel),
    servers: servers.sort(byLabel),
    serviceCount,
    truncated: graph.truncated,
  };
}
