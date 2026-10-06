import { describe, expect, it, vi } from 'vitest';
import type { NavTreeItem } from '@noodara/ui';
import {
  buildProjectNav,
  EMPTY_PROJECT_NAV,
  loadProjectNavData,
  notifyProjectsChanged,
  serviceRouteOf,
  shareStructure,
  subscribeProjectsChanged,
  withoutService,
  withService,
  type NavService,
  type ProjectNavApi,
  type ProjectNavData,
} from './ProjectNav';

const DATA: ProjectNavData = {
  projects: [
    { id: 'p2', name: 'beta', archivedAt: null },
    { id: 'p3', name: 'Old', archivedAt: '2026-01-01T00:00:00.000Z' },
    { id: 'p1', name: 'Alpha', archivedAt: null },
  ],
  environments: [
    { id: 'e1', projectId: 'p1', name: 'production' },
    { id: 'e2', projectId: 'p2', name: 'production' },
  ],
  services: [
    { id: 's2', projectId: 'p1', environmentId: 'e1', name: 'web' },
    { id: 's1', projectId: 'p1', environmentId: 'e1', name: 'API' },
  ],
};

function labels(items: readonly NavTreeItem[] | undefined): string[] {
  return (items ?? []).map((item) => item.label);
}

function find(root: NavTreeItem, id: string): NavTreeItem | undefined {
  if (root.id === id) return root;
  for (const child of root.children ?? []) {
    const hit = find(child, id);
    if (hit !== undefined) return hit;
  }
  return undefined;
}

describe('buildProjectNav (13-09 A1)', () => {
  it('builds Projects -> project -> environment -> service with routed hrefs', () => {
    const root = buildProjectNav(DATA);
    expect(root).toMatchObject({ id: 'projects', label: 'Projects', href: '/projects' });
    expect(find(root, 'project-p1')?.href).toBe('/projects/p1');
    expect(find(root, 'environment-e1')?.href).toBe('/projects/p1#environment-e1');
    expect(find(root, 'service-s1')?.href).toBe('/projects/p1/services/s1');
    expect(labels(find(root, 'environment-e1')?.children)).toEqual(['API', 'web']);
  });

  it('lists active projects by name, then archived ones', () => {
    expect(labels(buildProjectNav(DATA).children)).toEqual(['Alpha', 'beta', 'Old']);
  });

  it('renders empty projects and environments as leaves, and no projects as a leaf Projects item', () => {
    const root = buildProjectNav(DATA);
    expect(find(root, 'project-p3')?.children).toBeUndefined();
    expect(find(root, 'environment-e2')?.children).toBeUndefined();
    expect(buildProjectNav(EMPTY_PROJECT_NAV).children).toBeUndefined();
  });

  it('drops entries whose id could alter a route, and keeps hostile names only as labels (H1)', () => {
    const root = buildProjectNav({
      projects: [
        { id: '../x', name: 'evil', archivedAt: null },
        { id: 'p9', name: '<img src=x onerror=alert(1)>', archivedAt: null },
      ],
      environments: [],
      services: [],
    });
    expect(labels(root.children)).toEqual(['<img src=x onerror=alert(1)>']);
    expect(root.children?.[0]?.href).toBe('/projects/p9');
  });
});

describe('shareStructure (13-09 H2)', () => {
  it('returns the previous tree itself when nothing changed', () => {
    const prev = buildProjectNav(DATA);
    expect(shareStructure(prev, buildProjectNav(DATA))).toBe(prev);
  });

  it('keeps unaffected project branches identical across 200 service updates', () => {
    const many: ProjectNavData = {
      projects: Array.from({ length: 20 }, (_, i) => ({ id: `p${String(i)}`, name: `project ${String(i)}`, archivedAt: null })),
      environments: Array.from({ length: 20 }, (_, i) => ({ id: `e${String(i)}`, projectId: `p${String(i)}`, name: 'production' })),
      services: Array.from({ length: 20 }, (_, i) => ({
        id: `s${String(i)}`,
        projectId: `p${String(i)}`,
        environmentId: `e${String(i)}`,
        name: `svc ${String(i)}`,
      })),
    };
    let data = many;
    const first = buildProjectNav(data);
    let tree = first;
    for (let i = 0; i < 200; i += 1) {
      const service: NavService = { id: 's3', projectId: 'p3', environmentId: 'e3', name: `svc 3 v${String(i)}` };
      data = withService(data, service);
      tree = shareStructure(tree, buildProjectNav(data));
    }
    expect(find(tree, 'service-s3')?.label).toBe('svc 3 v199');
    for (const id of ['project-p0', 'project-p7', 'project-p19']) {
      expect(find(tree, id)).toBe(find(first, id));
    }
    expect(find(tree, 'project-p3')).not.toBe(find(first, 'project-p3'));
  });

  it('removes a deleted service and keeps its siblings', () => {
    const prev = buildProjectNav(DATA);
    const next = shareStructure(prev, buildProjectNav(withoutService(DATA, 's1')));
    expect(labels(find(next, 'environment-e1')?.children)).toEqual(['web']);
    expect(find(next, 'service-s2')).toBe(find(prev, 'service-s2'));
    expect(find(next, 'project-p2')).toBe(find(prev, 'project-p2'));
  });

  it('leaves the data untouched when the deleted service is unknown', () => {
    expect(withoutService(DATA, 'nope')).toBe(DATA);
  });
});

describe('serviceRouteOf', () => {
  it('reads project and service ids from a service page and pages under it', () => {
    expect(serviceRouteOf('/projects/p1/services/s1')).toEqual({ projectId: 'p1', serviceId: 's1' });
    expect(serviceRouteOf('/projects/p1/services/s1/deployments/d1')).toEqual({ projectId: 'p1', serviceId: 's1' });
  });

  it('returns null anywhere else', () => {
    for (const path of [null, '/projects', '/projects/p1', '/servers/s1', '/projects/p1/services/', '/projects/../services/s1']) {
      expect(serviceRouteOf(path)).toBeNull();
    }
  });
});

describe('loadProjectNavData', () => {
  function api(overrides: Partial<ProjectNavApi> = {}): ProjectNavApi {
    return {
      listProjects: () => Promise.resolve({ ok: true, data: { items: DATA.projects } }),
      listEnvironments: (projectId) =>
        Promise.resolve({ ok: true, data: { items: DATA.environments.filter((e) => e.projectId === projectId) } }),
      listServices: (projectId) =>
        Promise.resolve({ ok: true, data: { items: DATA.services.filter((s) => s.projectId === projectId) } }),
      ...overrides,
    };
  }

  it('reads every project with its environments and services', async () => {
    const data = await loadProjectNavData(api());
    expect(data?.projects).toHaveLength(3);
    expect(data?.environments.map((e) => e.id).sort()).toEqual(['e1', 'e2']);
    expect(data?.services.map((s) => s.id).sort()).toEqual(['s1', 's2']);
  });

  it('returns null when any read fails', async () => {
    expect(await loadProjectNavData(api({ listProjects: () => Promise.resolve({ ok: false }) }))).toBeNull();
    expect(await loadProjectNavData(api({ listServices: () => Promise.resolve({ ok: false }) }))).toBeNull();
  });
});

describe('projects-changed bus', () => {
  it('notifies subscribers until they unsubscribe', () => {
    const listener = vi.fn();
    const off = subscribeProjectsChanged(listener);
    notifyProjectsChanged();
    off();
    notifyProjectsChanged();
    expect(listener).toHaveBeenCalledTimes(1);
  });
});
