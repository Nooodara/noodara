// 12-08: the service read view (SVC-05). Built field by field from an allowlist, so a column added
// to `services` (credential ids today) never reaches the wire or the SSE stream by accident.
//
// `status` is always `deriveServiceStatus` (SVC-07, ROADMAP D5): the `services.status` column is
// only D5's cache of the last derived value, written by the engine and the reconciler. The read
// turns that cache back into the last container observation and derives again with the latest
// deployment, so a deployment that moved since the cache was written is reflected at once.
import {
  deriveServiceStatus,
  type ContainerObservation,
  type DeploymentStatus,
  type ServiceStatus,
} from '@noodara/domain/deployment';
import type { services } from '../db/schema/services.js';

export type ServiceRow = Pick<
  typeof services.$inferSelect,
  | 'id'
  | 'projectId'
  | 'environmentId'
  | 'serverId'
  | 'name'
  | 'sourceType'
  | 'repositoryUrl'
  | 'branch'
  | 'buildContext'
  | 'dockerfilePath'
  | 'buildTarget'
  | 'imageRef'
  | 'internalPort'
  | 'publishedPort'
  | 'status'
  | 'createdAt'
  | 'updatedAt'
>;

export interface ServiceView {
  readonly id: string;
  readonly projectId: string;
  readonly environmentId: string;
  readonly serverId: string;
  readonly name: string;
  readonly sourceType: 'git' | 'image';
  readonly repositoryUrl: string | null;
  readonly branch: string | null;
  readonly buildContext: string | null;
  readonly dockerfilePath: string | null;
  readonly buildTarget: string | null;
  readonly imageRef: string | null;
  readonly internalPort: number;
  readonly publishedPort: number | null;
  readonly status: ServiceStatus;
  readonly createdAt: string;
  readonly updatedAt: string;
}

/** Wire order of the view; the unit test pins it. */
export const SERVICE_VIEW_FIELDS = Object.freeze([
  'id',
  'projectId',
  'environmentId',
  'serverId',
  'name',
  'sourceType',
  'repositoryUrl',
  'branch',
  'buildContext',
  'dockerfilePath',
  'buildTarget',
  'imageRef',
  'internalPort',
  'publishedPort',
  'status',
  'createdAt',
  'updatedAt',
] as const satisfies readonly (keyof ServiceView)[]);

/** The container observation the cached status was derived from. A cache that never saw a
 *  container (never deployed, or written mid-deploy) observed nothing: `absent`. */
export function containerObservationFromCache(cached: ServiceStatus): ContainerObservation {
  switch (cached) {
    case 'RUNNING':
      return { kind: 'running' };
    case 'STOPPED':
    case 'FAILED':
      return { kind: 'stopped', exitCode: null };
    case 'UNKNOWN':
      return { kind: 'unknown' };
    case 'NEVER_DEPLOYED':
    case 'DEPLOYING':
      return { kind: 'absent' };
  }
}

export function toServiceView(
  row: ServiceRow,
  latestDeployment: { readonly status: DeploymentStatus } | null,
): ServiceView {
  return {
    id: row.id,
    projectId: row.projectId,
    environmentId: row.environmentId,
    serverId: row.serverId,
    name: row.name,
    sourceType: row.sourceType,
    repositoryUrl: row.repositoryUrl,
    branch: row.branch,
    buildContext: row.buildContext,
    dockerfilePath: row.dockerfilePath,
    buildTarget: row.buildTarget,
    imageRef: row.imageRef,
    internalPort: row.internalPort,
    publishedPort: row.publishedPort,
    status: deriveServiceStatus({
      latestDeployment: latestDeployment === null ? null : { status: latestDeployment.status },
      container: containerObservationFromCache(row.status),
    }),
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}
