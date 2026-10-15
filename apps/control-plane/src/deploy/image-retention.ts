// 17-04: image retention after a terminal SUCCESS or ROLLED_BACK. Best effort: every outcome is
// returned, nothing throws, and nothing here can change a deployment's result (A2).
// - H1: the deploy handler runs it before the terminal write, while the deployment still holds the
//   service's one-active slot (the partial unique index on non-terminal deployments). No other
//   deploy or manual rollback of the service can be QUEUED or PREPARING meanwhile, so no image a
//   rollback target needs can be removed under it.
// - H1: candidates come only from `listServiceImages` (repository noodara/<serviceId> AND the
//   noodara.service_id label); removal is `docker image rm` of noodara/<serviceId>:<deploymentId>,
//   never forced, so an image a container still uses is refused by Docker and reported as kept.
// - The keep set is the domain's imageRetention over the deployments whose images are on the host:
//   the running image, non-terminal attempts and the newest N known-good (SUCCESS) images.
// - Failures are logged by class only (a remote message can carry a host or a path).
import { and, eq, inArray } from 'drizzle-orm';
import {
  listServiceImages,
  removeServiceImage,
  type ImageInUse,
  type ServiceImagesResult,
  type StepLimits,
  type StepResult,
} from '@noodara/docker';
import { imageRetention, type DeploymentStatus, type RetentionDeployment } from '@noodara/domain/deployment';
import type { Redactor } from '@noodara/domain/security';
import type { ResourceId } from '@noodara/domain/validators';
import type { SshDeploySession } from '@noodara/ssh';
import type { Database } from '../db/client.js';
import { deployments } from '../db/schema/deployments.js';
import { services } from '../db/schema/services.js';

/** The listing prints one JSON line per image; 1 MiB holds a few thousand. */
export const IMAGE_RETENTION_LIST_LIMITS: StepLimits = Object.freeze({
  maxDurationMs: 30_000,
  idleTimeoutMs: 30_000,
  maxTotalBytes: 1_048_576,
  maxLineBytes: 8192,
});

export const IMAGE_RETENTION_REMOVE_LIMITS: StepLimits = Object.freeze({
  maxDurationMs: 30_000,
  idleTimeoutMs: 30_000,
  maxTotalBytes: 65_536,
  maxLineBytes: 4096,
});

/** One run removes at most this many images; the rest goes on the next terminal deployment. */
export const IMAGE_RETENTION_MAX_REMOVALS = 10;

export interface ImageRetentionRunInput {
  readonly serviceId: ResourceId;
  /** The deployment that just ended; its row is still non-terminal while retention runs (H1). */
  readonly deploymentId: ResourceId;
  readonly outcome: 'SUCCESS' | 'ROLLED_BACK';
  /** After ROLLED_BACK: the deployment whose container was restored (the running image). */
  readonly previousSuccessId: ResourceId | null;
  readonly session: SshDeploySession;
  readonly redactor: Redactor;
  readonly signal?: AbortSignal;
}

export interface RetentionHistory {
  /** services.imageRetention */
  readonly retention: number;
  readonly deployments: readonly {
    readonly id: string;
    readonly status: DeploymentStatus;
    readonly createdAt: number;
  }[];
}

/** The service's retention and the named deployments of that service; null when the service is gone. */
export type RetentionHistoryLoader = (serviceId: ResourceId, deploymentIds: readonly string[]) => Promise<RetentionHistory | null>;

export type ImageRetentionOutcome =
  | 'done'
  | 'skipped_aborted'
  | 'skipped_list_failed'
  | 'skipped_load_failed'
  | 'skipped_service_missing';

export interface ImageRetentionFailure {
  readonly imageRef: string;
  /** A closed code, a step outcome, `in_use` or an error class name; never remote text. */
  readonly kind: string;
}

export interface ImageRetentionReport {
  readonly outcome: ImageRetentionOutcome;
  readonly kept: readonly string[];
  readonly removed: readonly string[];
  readonly failed: readonly ImageRetentionFailure[];
}

export interface ImageRetentionLogger {
  info(fields: Record<string, unknown>, message: string): void;
  warn(fields: Record<string, unknown>, message: string): void;
}

export interface ImageRetentionDeps {
  readonly load: RetentionHistoryLoader;
  readonly list?: (input: ImageRetentionRunInput) => Promise<StepResult<ServiceImagesResult>>;
  readonly remove?: (input: ImageRetentionRunInput, deploymentId: ResourceId) => Promise<StepResult<unknown> | ImageInUse>;
  readonly logger: ImageRetentionLogger;
}

export type ImageRetentionRunner = (input: ImageRetentionRunInput) => Promise<ImageRetentionReport>;

function errorKind(error: unknown): string {
  return error instanceof Error ? error.name : typeof error;
}

function failureKind(result: Exclude<StepResult<unknown> | ImageInUse, { ok: true }>): string {
  if (result.kind === 'failed') return result.code;
  if (result.kind === 'interrupted') return result.outcome;
  return result.kind;
}

function defaultList(input: ImageRetentionRunInput): Promise<StepResult<ServiceImagesResult>> {
  return listServiceImages(
    { session: input.session, redactor: input.redactor, limits: IMAGE_RETENTION_LIST_LIMITS, ...signalOf(input) },
    { serviceId: input.serviceId },
  );
}

function defaultRemove(input: ImageRetentionRunInput, deploymentId: ResourceId): Promise<StepResult<unknown> | ImageInUse> {
  // No onChunk: retention output never reaches the deployment log.
  return removeServiceImage(
    { session: input.session, redactor: input.redactor, limits: IMAGE_RETENTION_REMOVE_LIMITS, ...signalOf(input) },
    { serviceId: input.serviceId, deploymentId },
  );
}

function signalOf(input: ImageRetentionRunInput): { signal?: AbortSignal } {
  return input.signal === undefined ? {} : { signal: input.signal };
}

/** The image a service deployment built (the `noodara/<serviceId>:<deploymentId>` tag). */
function tagOf(serviceId: string, deploymentId: string): string {
  return `noodara/${serviceId}:${deploymentId}`;
}

const skipped = (outcome: ImageRetentionOutcome): ImageRetentionReport => ({ outcome, kept: [], removed: [], failed: [] });

export function createImageRetention(deps: ImageRetentionDeps): ImageRetentionRunner {
  const list = deps.list ?? defaultList;
  const remove = deps.remove ?? defaultRemove;
  const { logger } = deps;

  return async (input) => {
    const { serviceId, deploymentId } = input;
    const fields = { serviceId, deploymentId };
    if (input.signal?.aborted === true) return skipped('skipped_aborted');

    let listing: StepResult<ServiceImagesResult>;
    try {
      listing = await list(input);
    } catch (error) {
      logger.warn({ ...fields, errorKind: errorKind(error) }, 'image retention skipped: the image list failed');
      return skipped('skipped_list_failed');
    }
    if (!listing.ok || listing.value.kind !== 'ok') {
      const kind = !listing.ok ? failureKind(listing) : 'unparseable';
      logger.warn({ ...fields, errorKind: kind }, 'image retention skipped: the image list failed');
      return skipped('skipped_list_failed');
    }
    const onHost = new Set(listing.value.images.map((image) => image.deploymentId as string));
    if (onHost.size === 0) return skipped('done');

    const wanted = new Set<string>([...onHost, deploymentId]);
    if (input.previousSuccessId !== null) wanted.add(input.previousSuccessId);
    let history: RetentionHistory | null;
    try {
      history = await deps.load(serviceId, [...wanted]);
    } catch (error) {
      logger.warn({ ...fields, errorKind: errorKind(error) }, 'image retention skipped: the deployment history could not be read');
      return skipped('skipped_load_failed');
    }
    if (history === null) return skipped('skipped_service_missing');

    // The current row is still non-terminal (H1); the plan sees it with the outcome it will record.
    const known: RetentionDeployment[] = history.deployments.map((row) => ({
      id: row.id,
      status: row.id === deploymentId ? input.outcome : row.status,
      imageRef: onHost.has(row.id) ? tagOf(serviceId, row.id) : null,
      createdAt: row.createdAt,
    }));
    const runningId = input.outcome === 'SUCCESS' ? deploymentId : input.previousSuccessId;
    const running = runningId !== null && onHost.has(runningId) ? tagOf(serviceId, runningId) : null;
    const keep = new Set(imageRetention(known, running, history.retention).keep);

    // Images on the host without a row of the service are outside the keep set too.
    const candidates = [...onHost].filter((id) => id !== runningId && !keep.has(tagOf(serviceId, id)));
    const removed: string[] = [];
    const failed: ImageRetentionFailure[] = [];
    for (const id of candidates.slice(0, IMAGE_RETENTION_MAX_REMOVALS)) {
      const imageRef = tagOf(serviceId, id);
      let kind: string | null = null;
      let interrupted = false;
      try {
        const result = await remove(input, id as ResourceId);
        if (!result.ok) {
          kind = failureKind(result);
          interrupted = result.kind === 'interrupted';
        }
      } catch (error) {
        kind = errorKind(error);
      }
      if (kind === null) {
        removed.push(imageRef);
        continue;
      }
      failed.push({ imageRef, kind });
      logger.warn({ ...fields, image: imageRef, errorKind: kind }, 'image retention could not remove an image; it was kept');
      // A timed-out or aborted step can mean a dead session: leave the rest for the next run.
      if (interrupted) break;
    }
    const removedSet = new Set(removed);
    const kept = [...onHost].map((id) => tagOf(serviceId, id)).filter((imageRef) => !removedSet.has(imageRef));
    logger.info(
      { ...fields, keptCount: kept.length, removedCount: removed.length, failedCount: failed.length },
      'image retention finished',
    );
    return { outcome: 'done', kept, removed, failed };
  };
}

/** Production loader: services.imageRetention and the named deployments of that service. */
export function loadRetentionHistoryFromDb(db: Database): RetentionHistoryLoader {
  return async (serviceId, deploymentIds) => {
    const [service] = await db
      .select({ retention: services.imageRetention })
      .from(services)
      .where(eq(services.id, serviceId));
    if (!service) return null;
    const rows =
      deploymentIds.length === 0
        ? []
        : await db
            .select({ id: deployments.id, status: deployments.status, createdAt: deployments.createdAt })
            .from(deployments)
            .where(and(eq(deployments.serviceId, serviceId), inArray(deployments.id, [...deploymentIds])));
    return {
      retention: service.retention,
      deployments: rows.map((row) => ({ id: row.id, status: row.status, createdAt: row.createdAt.getTime() })),
    };
  };
}
