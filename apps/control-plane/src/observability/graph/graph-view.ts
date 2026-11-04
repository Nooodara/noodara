// 27-05: the wire view of an Infrastructure Graph. Pure. Nodes are capped with parents first
// (Server, Project, Environment, Service, Domain), so a truncated graph keeps the hierarchy's top;
// a relation survives only when both endpoints do. DEPENDS_ON edges leave the backend with their
// two service ids only: the env keys behind the inference stay server-side.
import type { GraphNodeKind, InfrastructureGraph, InfrastructureRelation } from '@noodara/domain';
import { GRAPH_MAX_NODES, GRAPH_MAX_RELATIONS, type GraphView } from '@noodara/domain/api-contract';

const KIND_ORDER: Readonly<Record<GraphNodeKind, number>> = {
  Server: 0,
  Project: 1,
  Environment: 2,
  Service: 3,
  Domain: 4,
};

export type GraphRelationView = Pick<InfrastructureRelation, 'id' | 'type' | 'from' | 'to'>;

export interface GraphResponseView extends Omit<GraphView, 'relations'> {
  readonly relations: GraphRelationView[];
  /** True when nodes, relations or omissions were cut to fit the cap. */
  readonly truncated: boolean;
}

function byKindThenId(
  a: { readonly kind: GraphNodeKind; readonly id: string },
  b: { readonly kind: GraphNodeKind; readonly id: string },
): number {
  const kind = KIND_ORDER[a.kind] - KIND_ORDER[b.kind];
  if (kind !== 0) return kind;
  if (a.id < b.id) return -1;
  return a.id > b.id ? 1 : 0;
}

export function toGraphView(graph: InfrastructureGraph, maxNodes: number = GRAPH_MAX_NODES): GraphResponseView {
  const cap = Math.max(0, Math.min(Math.floor(maxNodes), GRAPH_MAX_NODES));
  let truncated = false;

  let nodes = [...graph.nodes];
  if (nodes.length > cap) {
    truncated = true;
    const kept = new Set([...nodes].sort(byKindThenId).slice(0, cap).map((node) => node.id));
    nodes = nodes.filter((node) => kept.has(node.id));
  }

  const nodeIds = new Set(nodes.map((node) => node.id));
  let relations: GraphRelationView[] = graph.relations
    .filter((relation) => nodeIds.has(relation.from) && nodeIds.has(relation.to))
    .map(({ id, type, from, to }) => ({ id, type, from, to }));
  if (relations.length > GRAPH_MAX_RELATIONS) {
    truncated = true;
    relations = relations.slice(0, GRAPH_MAX_RELATIONS);
  }

  let omitted = [...graph.omitted];
  if (omitted.length > GRAPH_MAX_NODES) {
    truncated = true;
    omitted = omitted.slice(0, GRAPH_MAX_NODES);
  }

  return { nodes, relations, omitted, truncated };
}
