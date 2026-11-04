// Infrastructure Graph types (v0.5, ADR 0012 "Data placement"). The graph is derived on read by
// `buildGraph` over one DB snapshot; there are no graph tables and no manual edges.

import type { EnvValue } from '../env/env-value.js';

export const GRAPH_NODE_KINDS = Object.freeze([
  'Server',
  'Project',
  'Environment',
  'Service',
  'Domain',
] as const);
export type GraphNodeKind = (typeof GRAPH_NODE_KINDS)[number];

export const GRAPH_RELATION_TYPES = Object.freeze([
  'RUNS_ON',
  'BELONGS_TO',
  'EXPOSED_BY',
  'DEPENDS_ON',
] as const);
export type GraphRelationType = (typeof GRAPH_RELATION_TYPES)[number];

/** Registered entities, as read in one consistent DB snapshot. */
export interface GraphSnapshot {
  readonly servers: readonly { readonly id: string; readonly name: string }[];
  readonly projects: readonly { readonly id: string; readonly name: string }[];
  readonly environments: readonly {
    readonly id: string;
    readonly projectId: string;
    readonly name: string;
  }[];
  readonly services: readonly {
    readonly id: string;
    readonly environmentId: string;
    readonly serverId: string;
    readonly name: string;
  }[];
  readonly domains: readonly {
    readonly id: string;
    readonly serviceId: string;
    readonly hostname: string;
  }[];
  /** Each service's effective env (resolveEnv output). Secret references are never resolved. */
  readonly serviceEnv: readonly {
    readonly serviceId: string;
    readonly key: string;
    readonly value: EnvValue;
  }[];
}

interface NodeBase {
  /** `<kind in lower case>:<entityId>`, unique across kinds. */
  readonly id: string;
  readonly entityId: string;
  readonly label: string;
}

export interface ServerNode extends NodeBase {
  readonly kind: 'Server';
}
export interface ProjectNode extends NodeBase {
  readonly kind: 'Project';
}
export interface EnvironmentNode extends NodeBase {
  readonly kind: 'Environment';
  readonly projectId: string;
}
export interface ServiceNode extends NodeBase {
  readonly kind: 'Service';
  readonly projectId: string;
  readonly environmentId: string;
  readonly serverId: string;
}
export interface DomainNode extends NodeBase {
  readonly kind: 'Domain';
  readonly projectId: string;
  readonly environmentId: string;
  readonly serviceId: string;
}

export type InfrastructureNode =
  ServerNode | ProjectNode | EnvironmentNode | ServiceNode | DomainNode;

export interface InfrastructureRelation {
  /** `<type>:<from>-><to>`. */
  readonly id: string;
  readonly type: GraphRelationType;
  readonly from: string;
  readonly to: string;
  /** DEPENDS_ON only: the env keys (never values) whose plain value names the target. */
  readonly envKeys?: readonly string[];
}

export const GRAPH_OMIT_REASONS = Object.freeze(['duplicate_id', 'missing_parent'] as const);
export type GraphOmitReason = (typeof GRAPH_OMIT_REASONS)[number];

/** An entity left out so the graph keeps its invariants (a snapshot race or a bad row). */
export interface GraphOmission {
  readonly kind: GraphNodeKind;
  readonly entityId: string;
  readonly reason: GraphOmitReason;
}

export interface InfrastructureGraph {
  readonly nodes: readonly InfrastructureNode[];
  readonly relations: readonly InfrastructureRelation[];
  readonly omitted: readonly GraphOmission[];
}

export function graphNodeId(kind: GraphNodeKind, entityId: string): string {
  return `${kind.toLowerCase()}:${entityId}`;
}

export function graphRelationId(type: GraphRelationType, from: string, to: string): string {
  return `${type}:${from}->${to}`;
}

/** Locale-independent code-unit order, so the output never depends on the host's ICU data. */
export function compareGraphKeys(a: string, b: string): number {
  if (a < b) return -1;
  return a > b ? 1 : 0;
}
