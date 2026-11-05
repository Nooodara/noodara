import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AiEntity } from '../../lib/api/ai-api';

const PROJECT = '11111111-1111-4111-8111-111111111111';
const ENV = '22222222-2222-4222-8222-222222222222';
const SERVICE = '44444444-4444-4444-8444-444444444444';
const DEPLOYMENT = '55555555-5555-4555-8555-555555555555';
const SERVER = '66666666-6666-4666-8666-666666666666';

const api = vi.hoisted(() => ({
  getDeployment: vi.fn(),
  listProjects: vi.fn(),
  listEnvironments: vi.fn(),
  listServices: vi.fn(),
}));
vi.mock('../../lib/deploy-api', () => api);
const nav = vi.hoisted(() => ({ load: vi.fn() }));
vi.mock('../ProjectNav', () => ({
  loadProjectNavData: nav.load,
  projectHref: (p: string) => `/projects/${p}`,
  environmentHref: (p: string, e: string) => `/projects/${p}/environments/${e}`,
  serviceHref: (p: string, s: string) => `/projects/${p}/services/${s}`,
}));

const { EMPTY_ENTITY_INDEX, entityHref, loadEntityIndex } = await import('./entity-links');

const entity = (kind: AiEntity['kind'], id: string): AiEntity => ({ kind, id, label: 'x' });

afterEach(() => {
  vi.clearAllMocks();
});

describe('entityHref', () => {
  const index = {
    environments: new Map([[ENV, PROJECT]]),
    services: new Map([[SERVICE, PROJECT]]),
    deployments: new Map([[DEPLOYMENT, SERVICE]]),
  };

  it('builds routes only from validated ids', () => {
    expect(entityHref(entity('Server', SERVER), index)).toBe(`/servers/${SERVER}`);
    expect(entityHref(entity('Project', PROJECT), index)).toBe(`/projects/${PROJECT}`);
    expect(entityHref(entity('Environment', ENV), index)).toBe(`/projects/${PROJECT}/environments/${ENV}`);
    expect(entityHref(entity('Service', SERVICE), index)).toBe(`/projects/${PROJECT}/services/${SERVICE}`);
    expect(entityHref(entity('Deployment', DEPLOYMENT), index)).toBe(`/projects/${PROJECT}/services/${SERVICE}?deployment=${DEPLOYMENT}`);
  });

  it('gives no route to a bad id, an unresolved parent or a Domain', () => {
    expect(entityHref(entity('Server', 'https://evil.example'), index)).toBeNull();
    expect(entityHref(entity('Server', '../../admin'), index)).toBeNull();
    expect(entityHref(entity('Service', SERVER), index)).toBeNull();
    expect(entityHref(entity('Environment', SERVER), index)).toBeNull();
    expect(entityHref(entity('Deployment', SERVER), index)).toBeNull();
    expect(entityHref(entity('Domain', SERVER), index)).toBeNull();
    expect(entityHref(entity('Service', SERVICE), EMPTY_ENTITY_INDEX)).toBeNull();
  });

  it('rejects a parent id that is not a UUID', () => {
    const bad = { ...index, services: new Map([[SERVICE, 'javascript:alert(1)']]) };
    expect(entityHref(entity('Service', SERVICE), bad)).toBeNull();
  });
});

describe('loadEntityIndex', () => {
  it('skips lookups when no entity needs a parent', async () => {
    await expect(loadEntityIndex([entity('Server', SERVER)])).resolves.toBe(EMPTY_ENTITY_INDEX);
    expect(nav.load).not.toHaveBeenCalled();
  });

  it('reads parents from the API and drops invalid ones', async () => {
    nav.load.mockResolvedValue({
      environments: [{ id: ENV, projectId: PROJECT }, { id: 'nope', projectId: PROJECT }],
      services: [{ id: SERVICE, projectId: PROJECT }],
    });
    api.getDeployment.mockResolvedValue({ ok: true, data: { serviceId: SERVICE } });
    const index = await loadEntityIndex([entity('Deployment', DEPLOYMENT), entity('Environment', ENV)]);
    expect(index.environments.get(ENV)).toBe(PROJECT);
    expect(index.environments.size).toBe(1);
    expect(index.deployments.get(DEPLOYMENT)).toBe(SERVICE);
  });

  it('survives failed reads', async () => {
    nav.load.mockRejectedValue(new Error('down'));
    api.getDeployment.mockRejectedValue(new Error('down'));
    const index = await loadEntityIndex([entity('Deployment', DEPLOYMENT)]);
    expect(index.deployments.size).toBe(0);
    expect(index.services.size).toBe(0);
  });
});
