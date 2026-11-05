// 30-03: typed read of the 27-05 project graph route. The project id is checked before it reaches
// a URL. The answer is sanitised here: a node whose ids are not UUIDs, or a relation that names a
// node not in the answer, is dropped, so every link the view builds rests on a validated id.
import type { GraphView } from '@noodara/domain/api-contract';
import { apiGet, type ApiResult } from '../api-client';

type GraphNodeView = GraphView['nodes'][number];

export interface GraphRelation {
  readonly id: string;
  readonly type: 'RUNS_ON' | 'BELONGS_TO' | 'EXPOSED_BY' | 'DEPENDS_ON';
  readonly from: string;
  readonly to: string;
}

export interface ProjectGraph {
  readonly nodes: readonly GraphNodeView[];
  readonly relations: readonly GraphRelation[];
  readonly truncated: boolean;
}

export type { GraphNodeView };

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const RELATION_TYPES: ReadonlySet<string> = new Set(['RUNS_ON', 'BELONGS_TO', 'EXPOSED_BY', 'DEPENDS_ON']);

export function isUuid(value: unknown): value is string {
  return typeof value === 'string' && UUID_PATTERN.test(value);
}

interface RawGraph {
  readonly nodes?: unknown;
  readonly relations?: unknown;
  readonly truncated?: unknown;
}

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : null;
}

function parentIdsValid(node: Record<string, unknown>): boolean {
  switch (node.kind) {
    case 'Server':
    case 'Project':
      return true;
    case 'Environment':
      return isUuid(node.projectId);
    case 'Service':
      return isUuid(node.projectId) && isUuid(node.environmentId) && isUuid(node.serverId);
    case 'Domain':
      return isUuid(node.projectId) && isUuid(node.environmentId) && isUuid(node.serviceId);
    default:
      return false;
  }
}

/** Keeps only nodes with UUID ids and a string label, and relations between kept nodes. */
export function sanitizeGraph(raw: RawGraph): ProjectGraph {
  const nodes: GraphNodeView[] = [];
  const ids = new Set<string>();
  for (const value of Array.isArray(raw.nodes) ? (raw.nodes as unknown[]) : []) {
    const node = record(value);
    if (node === null || typeof node.id !== 'string' || typeof node.label !== 'string') continue;
    if (!isUuid(node.entityId) || !parentIdsValid(node) || ids.has(node.id)) continue;
    ids.add(node.id);
    nodes.push(node as unknown as GraphNodeView);
  }
  const relations: GraphRelation[] = [];
  for (const value of Array.isArray(raw.relations) ? (raw.relations as unknown[]) : []) {
    const relation = record(value);
    if (relation === null || typeof relation.type !== 'string' || !RELATION_TYPES.has(relation.type)) continue;
    if (typeof relation.from !== 'string' || typeof relation.to !== 'string') continue;
    if (!ids.has(relation.from) || !ids.has(relation.to)) continue;
    relations.push({
      id: typeof relation.id === 'string' ? relation.id : `${relation.type}:${relation.from}->${relation.to}`,
      type: relation.type as GraphRelation['type'],
      from: relation.from,
      to: relation.to,
    });
  }
  return { nodes, relations, truncated: raw.truncated === true };
}

export async function getProjectGraph(projectId: string): Promise<ApiResult<ProjectGraph>> {
  if (!isUuid(projectId)) {
    return { ok: false, code: 'NOT_FOUND', message: 'Not found.', unauthorized: false };
  }
  const result = await apiGet<RawGraph>(`/api/projects/${encodeURIComponent(projectId)}/graph`);
  if (!result.ok) return result;
  return { ...result, data: sanitizeGraph(result.data) };
}
