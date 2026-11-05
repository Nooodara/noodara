import { afterEach, describe, expect, it, vi } from 'vitest';
import { getProjectGraph, sanitizeGraph } from './graph-api';

const PRJ = '22222222-2222-4222-8222-222222222222';
const ENV = '33333333-3333-4333-8333-333333333333';
const SVC = '44444444-4444-4444-8444-444444444444';
const SRV = '11111111-1111-4111-8111-111111111111';

function stubFetch(body: unknown, status = 200) {
  const fetchMock = vi.fn(() =>
    Promise.resolve(new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })),
  );
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

const NODES = [
  { id: `project:${PRJ}`, entityId: PRJ, label: 'shop', kind: 'Project' },
  { id: `environment:${ENV}`, entityId: ENV, label: 'production', kind: 'Environment', projectId: PRJ },
  { id: `server:${SRV}`, entityId: SRV, label: 'srv-1', kind: 'Server' },
  { id: `service:${SVC}`, entityId: SVC, label: 'api', kind: 'Service', projectId: PRJ, environmentId: ENV, serverId: SRV },
];

describe('graph-api', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('reads the project graph route', async () => {
    const fetchMock = stubFetch({ nodes: NODES, relations: [], omitted: [], truncated: false });
    const result = await getProjectGraph(PRJ);
    expect(result.ok).toBe(true);
    const call = fetchMock.mock.calls[0] as unknown as [string];
    expect(call[0]).toBe(`/api/projects/${PRJ}/graph`);
    if (result.ok) expect(result.data.nodes).toHaveLength(4);
  });

  it('never calls the network for a malformed project id', async () => {
    const fetchMock = stubFetch({});
    const result = await getProjectGraph('../servers');
    expect(result).toMatchObject({ ok: false, code: 'NOT_FOUND' });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('passes failures through', async () => {
    stubFetch({ error: 'NOT_FOUND', message: 'nope' }, 404);
    const result = await getProjectGraph(PRJ);
    expect(result.ok).toBe(false);
  });

  it('drops nodes with non-UUID ids and relations to dropped nodes', () => {
    const graph = sanitizeGraph({
      nodes: [
        ...NODES,
        { id: 'server:bad', entityId: 'javascript:alert(1)', label: 'evil', kind: 'Server' },
        { id: 'service:bad', entityId: SVC, label: 'x', kind: 'Service', projectId: 'data:x', environmentId: ENV, serverId: SRV },
        { id: 'weird', entityId: SVC, label: 'x', kind: 'Volume' },
        { id: `server:${SRV}`, entityId: SRV, label: 'dup', kind: 'Server' },
        null,
        { id: 'no-label', entityId: SRV, kind: 'Server' },
      ],
      relations: [
        { id: 'r1', type: 'RUNS_ON', from: `service:${SVC}`, to: `server:${SRV}` },
        { type: 'RUNS_ON', from: `service:${SVC}`, to: 'server:bad' },
        { type: 'OWNS', from: `service:${SVC}`, to: `server:${SRV}` },
        { type: 'BELONGS_TO', from: `service:${SVC}`, to: `environment:${ENV}` },
        { type: 'BELONGS_TO', from: 1, to: 2 },
        'junk',
      ],
      truncated: true,
    });
    expect(graph.nodes.map((node) => node.id)).toEqual(NODES.map((node) => node.id));
    expect(graph.relations).toEqual([
      { id: 'r1', type: 'RUNS_ON', from: `service:${SVC}`, to: `server:${SRV}` },
      {
        id: `BELONGS_TO:service:${SVC}->environment:${ENV}`,
        type: 'BELONGS_TO',
        from: `service:${SVC}`,
        to: `environment:${ENV}`,
      },
    ]);
    expect(graph.truncated).toBe(true);
  });

  it('treats a body without arrays as an empty graph', () => {
    expect(sanitizeGraph({})).toEqual({ nodes: [], relations: [], truncated: false });
  });
});
