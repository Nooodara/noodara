import { describe, expect, it } from 'vitest';
import type { GraphNodeView, GraphRelation, ProjectGraph } from '../../lib/api/graph-api';
import { buildGraphModel, nodeHref } from './graph-model';

const PRJ = '22222222-2222-4222-8222-222222222222';
const PROD = '33333333-3333-4333-8333-333333333333';
const STAGING = '33333333-3333-4333-8333-333333333334';
const API = '44444444-4444-4444-8444-444444444441';
const WORKER = '44444444-4444-4444-8444-444444444442';
const SRV1 = '11111111-1111-4111-8111-111111111111';
const SRV2 = '11111111-1111-4111-8111-111111111112';
const DOM = '55555555-5555-4555-8555-555555555555';

const nodes: GraphNodeView[] = [
  { id: `project:${PRJ}`, entityId: PRJ, label: 'shop', kind: 'Project' },
  { id: `environment:${PROD}`, entityId: PROD, label: 'production', kind: 'Environment', projectId: PRJ },
  { id: `environment:${STAGING}`, entityId: STAGING, label: 'Staging', kind: 'Environment', projectId: PRJ },
  { id: `server:${SRV1}`, entityId: SRV1, label: 'Server-01', kind: 'Server' },
  { id: `server:${SRV2}`, entityId: SRV2, label: 'Server-02', kind: 'Server' },
  { id: `service:${WORKER}`, entityId: WORKER, label: 'Worker', kind: 'Service', projectId: PRJ, environmentId: PROD, serverId: SRV2 },
  { id: `service:${API}`, entityId: API, label: 'API', kind: 'Service', projectId: PRJ, environmentId: PROD, serverId: SRV1 },
  {
    id: `domain:${DOM}`,
    entityId: DOM,
    label: 'api.example.com',
    kind: 'Domain',
    projectId: PRJ,
    environmentId: PROD,
    serviceId: API,
  },
];

function rel(type: GraphRelation['type'], from: string, to: string): GraphRelation {
  return { id: `${type}:${from}->${to}`, type, from, to };
}

const relations: GraphRelation[] = [
  rel('BELONGS_TO', `environment:${PROD}`, `project:${PRJ}`),
  rel('BELONGS_TO', `service:${API}`, `environment:${PROD}`),
  rel('BELONGS_TO', `service:${WORKER}`, `environment:${PROD}`),
  rel('RUNS_ON', `service:${API}`, `server:${SRV1}`),
  rel('RUNS_ON', `service:${WORKER}`, `server:${SRV2}`),
  rel('EXPOSED_BY', `service:${API}`, `domain:${DOM}`),
  rel('DEPENDS_ON', `service:${WORKER}`, `service:${API}`),
];

const graph: ProjectGraph = { nodes, relations, truncated: false };

describe('buildGraphModel', () => {
  it('groups services under environments with their edges, as in roadmap §10.3', () => {
    const model = buildGraphModel(graph);
    expect(model.project?.href).toBe(`/projects/${PRJ}`);
    expect(model.environments.map((environment) => environment.label)).toEqual(['production', 'Staging']);
    const [production, staging] = model.environments;
    expect(production?.href).toBe(`/projects/${PRJ}#environment-${PROD}`);
    expect(staging?.services).toEqual([]);
    expect(production?.services.map((service) => service.label)).toEqual(['API', 'Worker']);
    const [api, worker] = production?.services ?? [];
    expect(api?.href).toBe(`/projects/${PRJ}/services/${API}`);
    expect(api?.servers).toEqual([{ nodeId: `server:${SRV1}`, label: 'Server-01', href: `/servers/${SRV1}` }]);
    expect(api?.domains).toEqual([
      { nodeId: `domain:${DOM}`, hostname: 'api.example.com', settingsHref: `/projects/${PRJ}/services/${API}` },
    ]);
    expect(worker?.dependsOn.map((target) => target.href)).toEqual([`/projects/${PRJ}/services/${API}`]);
    expect(model.servers.map((server) => server.label)).toEqual(['Server-01', 'Server-02']);
    expect(model.serviceCount).toBe(2);
  });

  it('builds hrefs from ids only; a hostile label never reaches an href', () => {
    const hostile: ProjectGraph = {
      nodes: nodes.map((node) => ({ ...node, label: 'javascript:alert(1)' })),
      relations,
      truncated: true,
    };
    const model = buildGraphModel(hostile);
    const hrefs = [
      ...model.environments.map((e) => e.href),
      ...model.environments.flatMap((e) => e.services.flatMap((s) => [s.href, ...s.servers.map((x) => x.href), ...s.domains.map((d) => d.settingsHref)])),
    ];
    expect(hrefs.length).toBeGreaterThan(0);
    for (const href of hrefs) expect(href.startsWith('/')).toBe(true);
    expect(hrefs.join(' ')).not.toContain('javascript');
    expect(model.truncated).toBe(true);
  });

  it('falls back to the node environment id when BELONGS_TO is missing', () => {
    const model = buildGraphModel({ nodes, relations: relations.filter((r) => r.type !== 'BELONGS_TO'), truncated: false });
    expect(model.environments[0]?.services).toHaveLength(2);
  });

  it('ignores relations whose targets are of the wrong kind', () => {
    const model = buildGraphModel({
      nodes,
      relations: [...relations, rel('RUNS_ON', `service:${API}`, `domain:${DOM}`), rel('DEPENDS_ON', `service:${API}`, `server:${SRV1}`)],
      truncated: false,
    });
    const api = model.environments[0]?.services[0];
    expect(api?.servers).toHaveLength(1);
    expect(api?.dependsOn).toHaveLength(0);
  });
});

describe('nodeHref', () => {
  it('returns null for any node whose ids are not UUIDs', () => {
    const bad = 'javascript:alert(1)';
    expect(nodeHref({ id: 'x', entityId: bad, label: 'x', kind: 'Server' })).toBeNull();
    expect(nodeHref({ id: 'x', entityId: PROD, label: 'x', kind: 'Environment', projectId: bad })).toBeNull();
    expect(
      nodeHref({ id: 'x', entityId: API, label: 'x', kind: 'Service', projectId: bad, environmentId: PROD, serverId: SRV1 }),
    ).toBeNull();
    expect(
      nodeHref({ id: 'x', entityId: DOM, label: 'x', kind: 'Domain', projectId: PRJ, environmentId: PROD, serviceId: bad }),
    ).toBeNull();
  });
});
