// scopeGraph (v0.5, DECISIONS 2026-11-03): narrows a graph to the authorized projects or
// environments before it leaves the backend. It fails closed: an empty scope yields an empty
// graph, and a relation survives only when both endpoints are in scope.

import type { InfrastructureGraph, InfrastructureNode } from './graph-types.js';

export interface GraphScope {
  readonly projectIds?: readonly string[];
  readonly environmentIds?: readonly string[];
}

export function scopeGraph(graph: InfrastructureGraph, scope: GraphScope): InfrastructureGraph {
  const projectIds = new Set(scope.projectIds ?? []);
  const environmentIds = new Set(scope.environmentIds ?? []);
  const inScope = (projectId: string, environmentId: string): boolean =>
    projectIds.has(projectId) || environmentIds.has(environmentId);

  const kept = new Set<string>();
  const serverIds = new Set<string>();
  for (const node of graph.nodes) {
    if (
      (node.kind === 'Project' && projectIds.has(node.entityId)) ||
      (node.kind === 'Environment' && inScope(node.projectId, node.entityId)) ||
      (node.kind === 'Domain' && inScope(node.projectId, node.environmentId))
    ) {
      kept.add(node.id);
    } else if (node.kind === 'Service' && inScope(node.projectId, node.environmentId)) {
      kept.add(node.id);
      serverIds.add(node.serverId);
    }
  }
  const isKept = (node: InfrastructureNode): boolean =>
    kept.has(node.id) || (node.kind === 'Server' && serverIds.has(node.entityId));

  const nodes = graph.nodes.filter(isKept);
  const nodeIds = new Set(nodes.map((node) => node.id));
  return {
    nodes,
    relations: graph.relations.filter((r) => nodeIds.has(r.from) && nodeIds.has(r.to)),
    // Omissions carry ids that cannot be placed in a scope, so a scoped graph never lists them.
    omitted: [],
  };
}
