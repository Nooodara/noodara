import { afterEach, describe, expect, it, vi } from 'vitest';
import { getServerMetrics, getServiceMetrics, getServiceStatus } from './metrics-api';

const SERVER_ID = '11111111-1111-4111-8111-111111111111';
const PROJECT_ID = '22222222-2222-4222-8222-222222222222';
const SERVICE_ID = '33333333-3333-4333-8333-333333333333';

function stubFetch(body: unknown, status = 200) {
  const fetchMock = vi.fn(() =>
    Promise.resolve(new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })),
  );
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

function calledUrl(fetchMock: ReturnType<typeof stubFetch>): string {
  const call = fetchMock.mock.calls[0] as unknown as [string] | undefined;
  return call?.[0] ?? '';
}

describe('metrics-api', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('reads server metrics from the server metrics route', async () => {
    const fetchMock = stubFetch({ series: [], server: { serverId: SERVER_ID } });
    const result = await getServerMetrics(SERVER_ID);
    expect(result.ok).toBe(true);
    expect(calledUrl(fetchMock)).toBe(`/api/servers/${SERVER_ID}/metrics`);
  });

  it('reads service metrics and status from the scoped project routes', async () => {
    const fetchMock = stubFetch({ series: [] });
    await getServiceMetrics(PROJECT_ID, SERVICE_ID);
    expect(calledUrl(fetchMock)).toBe(`/api/projects/${PROJECT_ID}/services/${SERVICE_ID}/metrics`);
    fetchMock.mockClear();
    await getServiceStatus(PROJECT_ID, SERVICE_ID);
    expect(calledUrl(fetchMock)).toBe(`/api/projects/${PROJECT_ID}/services/${SERVICE_ID}/status`);
  });

  it('never sends a malformed id to the network', async () => {
    const fetchMock = stubFetch({});
    const results = await Promise.all([
      getServerMetrics('../admin'),
      getServiceMetrics('x', SERVICE_ID),
      getServiceStatus(PROJECT_ID, 'y/z'),
    ]);
    expect(results.every((result) => !result.ok && result.code === 'NOT_FOUND')).toBe(true);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('maps a failed read to a failure result', async () => {
    stubFetch({ error: 'NOT_FOUND', message: 'Server not found' }, 404);
    const result = await getServerMetrics(SERVER_ID);
    expect(result.ok).toBe(false);
  });
});
