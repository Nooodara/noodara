// 30-04 (H1): routes for the entity chips of an answer. A route is built only from UUIDs: the
// entity's own id (already validated by sanitizeAnswer) and parent ids read from the API, each
// checked again here. Labels never enter a route. An entity whose parent cannot be resolved (or a
// Domain, which has no page of its own) gets no route and renders as a plain chip.
import { useEffect, useState } from 'react';
import { isUuid } from '../../lib/api/graph-api';
import type { AiEntity } from '../../lib/api/ai-api';
import { getDeployment, listEnvironments, listProjects, listServices } from '../../lib/deploy-api';
import { environmentHref, loadProjectNavData, projectHref, serviceHref } from '../ProjectNav';

export interface EntityIndex {
  /** environment id -> project id */
  readonly environments: ReadonlyMap<string, string>;
  /** service id -> project id */
  readonly services: ReadonlyMap<string, string>;
  /** deployment id -> service id */
  readonly deployments: ReadonlyMap<string, string>;
}

export const EMPTY_ENTITY_INDEX: EntityIndex = Object.freeze({
  environments: new Map<string, string>(),
  services: new Map<string, string>(),
  deployments: new Map<string, string>(),
});

function key(id: string): string {
  return id.toLowerCase();
}

export function entityHref(entity: AiEntity, index: EntityIndex): string | null {
  if (!isUuid(entity.id)) return null;
  const id = key(entity.id);
  switch (entity.kind) {
    case 'Server':
      return `/servers/${id}`;
    case 'Project':
      return projectHref(id);
    case 'Environment': {
      const projectId = index.environments.get(id);
      return isUuid(projectId) ? environmentHref(key(projectId), id) : null;
    }
    case 'Service': {
      const projectId = index.services.get(id);
      return isUuid(projectId) ? serviceHref(key(projectId), id) : null;
    }
    case 'Deployment': {
      const serviceId = index.deployments.get(id);
      const projectId = serviceId === undefined ? undefined : index.services.get(key(serviceId));
      return isUuid(serviceId) && isUuid(projectId) ? `${serviceHref(key(projectId), key(serviceId))}?deployment=${id}` : null;
    }
    default:
      return null;
  }
}

function needsLookup(entity: AiEntity): boolean {
  return entity.kind === 'Environment' || entity.kind === 'Service' || entity.kind === 'Deployment';
}

/** Reads the parent ids the given entities need (one project listing, plus one read per
 *  deployment). Any failure leaves that entity without a route. */
export async function loadEntityIndex(entities: readonly AiEntity[]): Promise<EntityIndex> {
  if (!entities.some(needsLookup)) return EMPTY_ENTITY_INDEX;
  const environments = new Map<string, string>();
  const services = new Map<string, string>();
  const deployments = new Map<string, string>();
  const deploymentIds = [...new Set(entities.filter((e) => e.kind === 'Deployment').map((e) => key(e.id)))];
  const [nav, reads] = await Promise.all([
    loadProjectNavData({ listProjects, listEnvironments, listServices }).catch(() => null),
    Promise.all(deploymentIds.map((id) => getDeployment(id).catch(() => null))),
  ]);
  for (const environment of nav?.environments ?? []) {
    if (isUuid(environment.id) && isUuid(environment.projectId)) environments.set(key(environment.id), environment.projectId);
  }
  for (const service of nav?.services ?? []) {
    if (isUuid(service.id) && isUuid(service.projectId)) services.set(key(service.id), service.projectId);
  }
  reads.forEach((result, position) => {
    const id = deploymentIds[position];
    if (id !== undefined && result?.ok === true && isUuid(result.data.serviceId)) deployments.set(id, result.data.serviceId);
  });
  return { environments, services, deployments };
}

/** The index for the given entities, loaded once per distinct entity set. */
export function useEntityIndex(entities: readonly AiEntity[]): EntityIndex {
  const [index, setIndex] = useState<EntityIndex>(EMPTY_ENTITY_INDEX);
  const signature = entities.map((e) => `${e.kind}:${e.id}`).join(',');
  useEffect(() => {
    let cancelled = false;
    void loadEntityIndex(entities).then((loaded) => {
      if (!cancelled) setIndex(loaded);
    });
    return () => {
      cancelled = true;
    };
    // `signature` stands for `entities`: a new array with the same entities must not refetch.
  }, [signature]);
  return index;
}
