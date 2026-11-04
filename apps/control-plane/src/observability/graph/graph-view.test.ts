import { buildGraph, type GraphSnapshot } from '@noodara/domain';
import { GRAPH_MAX_NODES } from '@noodara/domain/api-contract';
import { describe, expect, it } from 'vitest';
import { toGraphView } from './graph-view.js';

const SRV = '00000000-0000-4000-8000-000000000001';
const PRJ = '00000000-0000-4000-8000-000000000002';
const ENV = '00000000-0000-4000-8000-000000000003';
const API = '00000000-0000-4000-8000-000000000004';
const DB = '00000000-0000-4000-8000-000000000005';
const DOM = '00000000-0000-4000-8000-000000000006';

function snapshot(): GraphSnapshot {
  return {
    servers: [{ id: SRV, name: 'srv' }],
    projects: [{ id: PRJ, name: 'prj' }],
    environments: [{ id: ENV, projectId: PRJ, name: 'production' }],
    services: [
      { id: API, environmentId: ENV, serverId: SRV, name: 'api' },
      { id: DB, environmentId: ENV, serverId: SRV, name: 'db' },
    ],
    domains: [{ id: DOM, serviceId: API, hostname: 'api.example.test' }],
    serviceEnv: [
      { serviceId: API, key: 'DATABASE_URL', value: { kind: 'plain', value: `postgres://u:p@noodara-${DB}/x` } },
    ],
  };
}

describe('toGraphView', () => {
  it('keeps every node under the cap and strips DEPENDS_ON env keys', () => {
    const graph = buildGraph(snapshot());
    expect(graph.relations.some((relation) => relation.envKeys !== undefined)).toBe(true);
    const view = toGraphView(graph);
    expect(view.truncated).toBe(false);
    expect(view.nodes).toEqual(graph.nodes);
    expect(view.relations).toHaveLength(graph.relations.length);
    for (const relation of view.relations) {
      expect(Object.keys(relation).sort()).toEqual(['from', 'id', 'to', 'type']);
    }
    expect(JSON.stringify(view)).not.toContain('DATABASE_URL');
  });

  it('caps nodes parents first, keeps id order and drops relations to cut nodes', () => {
    const view = toGraphView(buildGraph(snapshot()), 3);
    expect(view.truncated).toBe(true);
    expect(view.nodes.map((node) => node.kind).sort()).toEqual(['Environment', 'Project', 'Server']);
    expect(view.nodes.map((node) => node.id)).toEqual([...view.nodes.map((node) => node.id)].sort());
    expect(view.relations.map((relation) => relation.type)).toEqual(['BELONGS_TO']);
  });

  it('a cap of zero or above the contract maximum stays within bounds', () => {
    const graph = buildGraph(snapshot());
    expect(toGraphView(graph, 0)).toMatchObject({ nodes: [], relations: [], truncated: true });
    expect(toGraphView(graph, GRAPH_MAX_NODES * 10).truncated).toBe(false);
    expect(toGraphView(graph, graph.nodes.length).truncated).toBe(false);
  });

  it('caps omissions at the contract maximum', () => {
    const many = Array.from({ length: GRAPH_MAX_NODES + 1 }, (_, i) => ({
      id: `00000000-0000-4000-9000-${i.toString().padStart(12, '0')}`,
      projectId: '00000000-0000-4000-8000-0000000000ff',
      name: 'orphan',
    }));
    const view = toGraphView(buildGraph({ ...snapshot(), environments: many }));
    expect(view.omitted).toHaveLength(GRAPH_MAX_NODES);
    expect(view.truncated).toBe(true);
  });
});
