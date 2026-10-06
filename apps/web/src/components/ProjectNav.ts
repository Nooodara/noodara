// 13-09: the Projects branch of the sidebar, built from plain data. No React and no fetch of its
// own: `loadProjectNavData` takes the deploy-api calls as arguments so tests inject fakes.
//
// Hrefs are built here, from ids that pass SAFE_ID, the same routes activity-copy.ts links to.
// Names are only ever labels (rendered as text by NavTree), never part of an href.
import { Box, FolderKanban, FolderClosed, Layers } from 'lucide-react';
import type { NavTreeItem } from '@noodara/ui';

const SAFE_ID = /^[A-Za-z0-9_-]{1,128}$/;

/** True for an id safe to put in a route (UUIDs server-side; never a slash or `..`). */
export function isRoutableId(id: string): boolean {
  return SAFE_ID.test(id);
}

export interface NavProject {
  readonly id: string;
  readonly name: string;
  readonly archivedAt: string | null;
}

export interface NavEnvironment {
  readonly id: string;
  readonly projectId: string;
  readonly name: string;
}

export interface NavService {
  readonly id: string;
  readonly projectId: string;
  readonly environmentId: string;
  readonly name: string;
}

export interface ProjectNavData<S extends NavService = NavService> {
  readonly projects: readonly NavProject[];
  readonly environments: readonly NavEnvironment[];
  readonly services: readonly S[];
}

export const EMPTY_PROJECT_NAV: ProjectNavData = Object.freeze({ projects: [], environments: [], services: [] });

export const PROJECTS_HREF = '/projects';

export function projectHref(projectId: string): string {
  return `${PROJECTS_HREF}/${projectId}`;
}

export function environmentHref(projectId: string, environmentId: string): string {
  return `${projectHref(projectId)}#environment-${environmentId}`;
}

export function serviceHref(projectId: string, serviceId: string): string {
  return `${projectHref(projectId)}/services/${serviceId}`;
}

function byName<T extends { readonly name: string }>(a: T, b: T): number {
  return a.name.localeCompare(b.name, undefined, { sensitivity: 'base' });
}

function safe<T extends { readonly id: string }>(items: readonly T[]): T[] {
  return items.filter((item) => SAFE_ID.test(item.id));
}

/** The Projects item: active projects by name, then archived ones; each project holds its
 *  environments, each environment its services. A project or environment with nothing under it
 *  is a plain leaf. */
export function buildProjectNav(data: ProjectNavData): NavTreeItem {
  const servicesByEnvironment = new Map<string, NavService[]>();
  for (const service of safe(data.services)) {
    const list = servicesByEnvironment.get(service.environmentId) ?? [];
    list.push(service);
    servicesByEnvironment.set(service.environmentId, list);
  }
  const environmentsByProject = new Map<string, NavEnvironment[]>();
  for (const environment of safe(data.environments)) {
    const list = environmentsByProject.get(environment.projectId) ?? [];
    list.push(environment);
    environmentsByProject.set(environment.projectId, list);
  }

  const projects = safe(data.projects);
  const ordered = [
    ...projects.filter((project) => project.archivedAt === null).sort(byName),
    ...projects.filter((project) => project.archivedAt !== null).sort(byName),
  ];

  const children = ordered.map((project): NavTreeItem => {
    const environments = (environmentsByProject.get(project.id) ?? []).sort(byName).map((environment): NavTreeItem => {
      const services = (servicesByEnvironment.get(environment.id) ?? [])
        .filter((service) => service.projectId === project.id)
        .sort(byName)
        .map(
          (service): NavTreeItem => ({
            id: `service-${service.id}`,
            label: service.name,
            href: serviceHref(project.id, service.id),
            icon: Box,
          }),
        );
      return withChildren(
        { id: `environment-${environment.id}`, label: environment.name, href: environmentHref(project.id, environment.id), icon: Layers },
        services,
      );
    });
    return withChildren(
      { id: `project-${project.id}`, label: project.name, href: projectHref(project.id), icon: FolderClosed },
      environments,
    );
  });

  return withChildren({ id: 'projects', label: 'Projects', href: PROJECTS_HREF, icon: FolderKanban }, children);
}

function withChildren(item: NavTreeItem, children: readonly NavTreeItem[]): NavTreeItem {
  return children.length === 0 ? item : { ...item, children };
}

function sameItems(a: readonly NavTreeItem[], b: readonly NavTreeItem[]): boolean {
  return a.length === b.length && a.every((item, index) => item === b[index]);
}

/** Returns `next` with every node equal to its `prev` counterpart (same id, label, href, icon and
 *  identical children) replaced by that `prev` object, so memoized tree rows skip unchanged
 *  branches. Whole result is `prev` when nothing changed. */
export function shareStructure(prev: NavTreeItem | null, next: NavTreeItem): NavTreeItem {
  if (prev?.id !== next.id) return next;
  let children = next.children;
  if (children !== undefined) {
    const previous = new Map((prev.children ?? []).map((child) => [child.id, child]));
    const shared = children.map((child) => shareStructure(previous.get(child.id) ?? null, child));
    children = prev.children !== undefined && sameItems(prev.children, shared) ? prev.children : shared;
  }
  if (prev.label === next.label && prev.href === next.href && prev.icon === next.icon && prev.children === children) {
    return prev;
  }
  return children === undefined ? next : { ...next, children };
}

export interface ServiceRoute {
  readonly projectId: string;
  readonly serviceId: string;
}

const SERVICE_ROUTE = /^\/projects\/([A-Za-z0-9_-]{1,128})\/services\/([A-Za-z0-9_-]{1,128})(?:\/.*)?$/;

/** The project and service ids of a service page (or any page under it); `null` elsewhere. */
export function serviceRouteOf(pathname: string | null): ServiceRoute | null {
  if (pathname === null) return null;
  const match = SERVICE_ROUTE.exec(pathname);
  if (match === null) return null;
  const [, projectId, serviceId] = match;
  if (projectId === undefined || serviceId === undefined) return null;
  return { projectId, serviceId };
}

/** Replaces or removes one service in the data, keeping every untouched array as is. */
export function withService(data: ProjectNavData, service: NavService): ProjectNavData {
  const index = data.services.findIndex((entry) => entry.id === service.id);
  const services = index === -1 ? [...data.services, service] : data.services.map((entry, i) => (i === index ? service : entry));
  return { ...data, services };
}

export function withoutService(data: ProjectNavData, serviceId: string): ProjectNavData {
  if (!data.services.some((entry) => entry.id === serviceId)) return data;
  return { ...data, services: data.services.filter((entry) => entry.id !== serviceId) };
}

type Result<T> = { readonly ok: true; readonly data: T } | { readonly ok: false };

export interface ProjectNavApi<S extends NavService = NavService> {
  readonly listProjects: () => Promise<Result<{ readonly items: readonly NavProject[] }>>;
  readonly listEnvironments: (projectId: string) => Promise<Result<{ readonly items: readonly NavEnvironment[] }>>;
  readonly listServices: (projectId: string) => Promise<Result<{ readonly items: readonly S[] }>>;
}

/** One snapshot of every project, environment and service; `null` when any read fails, so the
 *  caller keeps what it shows instead of dropping a branch. */
export async function loadProjectNavData<S extends NavService>(api: ProjectNavApi<S>): Promise<ProjectNavData<S> | null> {
  const projects = await api.listProjects();
  if (!projects.ok) return null;
  const items = safe(projects.data.items);
  const perProject = await Promise.all(
    items.map(async (project) => {
      const [environments, services] = await Promise.all([api.listEnvironments(project.id), api.listServices(project.id)]);
      return environments.ok && services.ok ? { environments: environments.data.items, services: services.data.items } : null;
    }),
  );
  if (perProject.some((entry) => entry === null)) return null;
  return {
    projects: items,
    environments: perProject.flatMap((entry) => entry?.environments ?? []),
    services: perProject.flatMap((entry) => entry?.services ?? []),
  };
}

// A project created or changed on the projects page reaches the sidebar through this bus: there
// is no project event on the stream in v0.2.
const projectListeners = new Set<() => void>();

export function subscribeProjectsChanged(listener: () => void): () => void {
  projectListeners.add(listener);
  return () => {
    projectListeners.delete(listener);
  };
}

export function notifyProjectsChanged(): void {
  for (const listener of [...projectListeners]) listener();
}
