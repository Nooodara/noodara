// 12-10: enqueue and read deployments. A deploy inserts a QUEUED row (source snapshot) in one
// transaction, then enqueues an ids-only job (`deploy-<deploymentId>`). The partial unique index
// `deployments_service_active_unique_idx` is the single source of truth for "one active deploy
// per service" (A2). If the enqueue fails the insert is undone, so no deployment stays QUEUED
// without a job (H1). Views are allowlisted: ids, statuses and the source snapshot, never secrets.
import { and, desc, eq, lt, or } from 'drizzle-orm';
import { uuidv7 } from 'uuidv7';
import { z } from 'zod';
import type { DeploymentErrorCode, DeploymentStatus, DeploymentTrigger } from '@noodara/domain/deployment';
import { writeActivityEvent } from '../activity/write-activity-event.js';
import type { Database } from '../db/client.js';
import { activityEvents } from '../db/schema/activity-events.js';
import { deployments } from '../db/schema/deployments.js';
import { projects } from '../db/schema/projects.js';
import { servers } from '../db/schema/servers.js';
import { services } from '../db/schema/services.js';
import { publishServerEvent, type ServerEventPublisher } from '../events/server-event-publisher.js';
import type { DeployQueue } from '../queue/deploy-queue.js';
import { encodeActivityCursor } from '../routes/activity-cursor.js';
import type { ServiceActor } from './server-service-deps.js';
import { toServiceView, type ServiceRow, type ServiceView } from './service-view.js';

export interface DeploymentServicesLogger {
  warn(fields: Record<string, unknown>, message: string): void;
  error(fields: Record<string, unknown>, message: string): void;
}

export interface DeploymentServicesDeps {
  readonly db: Database;
  readonly now: () => Date;
  readonly events: ServerEventPublisher;
  readonly queue: Pick<DeployQueue, 'enqueue'>;
  readonly logger: DeploymentServicesLogger;
}

type Transaction = Parameters<Parameters<Database['transaction']>[0]>[0];

const ACTIVE_DEPLOYMENT_CONSTRAINT = 'deployments_service_active_unique_idx';

// ---------------------------------------------------------------------------------------------
// Views
// ---------------------------------------------------------------------------------------------

/** The snapshot of the service source a deployment builds from. Stored JSON may carry more keys;
 *  only these ever leave the API. */
const DeploymentSourceSchema = z.object({
  sourceType: z.enum(['git', 'image']),
  repositoryUrl: z.string().nullable(),
  branch: z.string().nullable(),
  buildContext: z.string().nullable(),
  dockerfilePath: z.string().nullable(),
  buildTarget: z.string().nullable(),
  imageRef: z.string().nullable(),
  internalPort: z.number().int(),
  publishedPort: z.number().int().nullable(),
});

export type DeploymentSourceSnapshot = z.infer<typeof DeploymentSourceSchema>;

export type DeploymentRow = typeof deployments.$inferSelect;

export interface DeploymentView {
  readonly id: string;
  readonly serviceId: string;
  readonly status: DeploymentStatus;
  readonly trigger: DeploymentTrigger;
  readonly triggeredBy: string | null;
  readonly source: DeploymentSourceSnapshot;
  readonly commitSha: string | null;
  readonly previousDeploymentId: string | null;
  readonly startedAt: string | null;
  readonly completedAt: string | null;
  readonly durationMs: number | null;
  readonly errorCode: DeploymentErrorCode | null;
  readonly errorMessage: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

/** Wire order of the view; the unit test pins it. */
export const DEPLOYMENT_VIEW_FIELDS = Object.freeze([
  'id',
  'serviceId',
  'status',
  'trigger',
  'triggeredBy',
  'source',
  'commitSha',
  'previousDeploymentId',
  'startedAt',
  'completedAt',
  'durationMs',
  'errorCode',
  'errorMessage',
  'createdAt',
  'updatedAt',
] as const satisfies readonly (keyof DeploymentView)[]);

const iso = (value: Date | null): string | null => (value === null ? null : value.toISOString());

/** Throws on a malformed snapshot: a corrupt row is a bug, never something to paper over. */
export function toDeploymentView(row: DeploymentRow): DeploymentView {
  return {
    id: row.id,
    serviceId: row.serviceId,
    status: row.status,
    trigger: row.trigger,
    triggeredBy: row.triggeredBy,
    source: DeploymentSourceSchema.parse(row.source),
    commitSha: row.commitSha,
    previousDeploymentId: row.previousDeploymentId,
    startedAt: iso(row.startedAt),
    completedAt: iso(row.completedAt),
    durationMs: row.durationMs,
    errorCode: row.errorCode,
    errorMessage: row.errorMessage,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

type SnapshotColumns = Pick<
  ServiceRow,
  | 'sourceType'
  | 'repositoryUrl'
  | 'branch'
  | 'buildContext'
  | 'dockerfilePath'
  | 'buildTarget'
  | 'imageRef'
  | 'internalPort'
  | 'publishedPort'
>;

/** Source columns and ports only: credential ids stay on the service, resolved by the worker. */
export function sourceSnapshotFromService(row: SnapshotColumns): DeploymentSourceSnapshot {
  return {
    sourceType: row.sourceType,
    repositoryUrl: row.repositoryUrl,
    branch: row.branch,
    buildContext: row.buildContext,
    dockerfilePath: row.dockerfilePath,
    buildTarget: row.buildTarget,
    imageRef: row.imageRef,
    internalPort: row.internalPort,
    publishedPort: row.publishedPort,
  };
}

// ---------------------------------------------------------------------------------------------
// Failures
// ---------------------------------------------------------------------------------------------

interface Failure<Code extends string> {
  readonly ok: false;
  readonly code: Code;
  readonly message: string;
}

export type TriggerDeployFailureCode =
  | 'NOT_FOUND'
  | 'PROJECT_ARCHIVED'
  | 'SERVER_NOT_CONNECTED'
  | 'DEPLOYMENT_IN_PROGRESS'
  | 'QUEUE_UNAVAILABLE';

export type TriggerDeployResult = { readonly ok: true; readonly deployment: DeploymentView } | Failure<TriggerDeployFailureCode>;

const inProgress = (): Failure<'DEPLOYMENT_IN_PROGRESS'> => ({
  ok: false,
  code: 'DEPLOYMENT_IN_PROGRESS',
  message: 'This service already has a deployment in progress',
});

const queueUnavailable = (): Failure<'QUEUE_UNAVAILABLE'> => ({
  ok: false,
  code: 'QUEUE_UNAVAILABLE',
  message: 'Job queue is unavailable; try again shortly',
});

/** drizzle wraps the `pg` error; `.code`/`.constraint` live on `cause` (see project-services.ts). */
function uniqueViolationConstraint(error: unknown): string | undefined {
  const cause = (error as { cause?: { code?: string; constraint?: string } } | undefined)?.cause;
  return cause?.code === '23505' ? cause.constraint : undefined;
}

// ---------------------------------------------------------------------------------------------
// Trigger
// ---------------------------------------------------------------------------------------------

export interface TriggerDeployInput {
  readonly actor: ServiceActor;
  readonly serviceId: string;
}

type InsertResult =
  | { readonly ok: true; readonly deployment: DeploymentView; readonly service: ServiceView; readonly activityEventId: string }
  | Failure<Exclude<TriggerDeployFailureCode, 'DEPLOYMENT_IN_PROGRESS' | 'QUEUE_UNAVAILABLE'>>;

type UndoResult =
  | { readonly kind: 'rolled_back' }
  | { readonly kind: 'moved'; readonly deployment: DeploymentView }
  | { readonly kind: 'missing' };

async function insertQueuedDeployment(tx: Transaction, deps: DeploymentServicesDeps, input: TriggerDeployInput): Promise<InsertResult> {
  const [service] = await tx.select().from(services).where(eq(services.id, input.serviceId)).limit(1);
  if (!service) return { ok: false, code: 'NOT_FOUND', message: `Service "${input.serviceId}" not found` };
  // FOR SHARE: archiving the project (an UPDATE) waits for this insert, never races past it.
  const [project] = await tx
    .select({ archivedAt: projects.archivedAt })
    .from(projects)
    .where(eq(projects.id, service.projectId))
    .for('share');
  if (!project) return { ok: false, code: 'NOT_FOUND', message: `Service "${input.serviceId}" not found` };
  if (project.archivedAt !== null) {
    return { ok: false, code: 'PROJECT_ARCHIVED', message: 'This project is archived; unarchive it to deploy' };
  }
  const [server] = await tx.select({ status: servers.status }).from(servers).where(eq(servers.id, service.serverId)).for('share');
  if (server?.status !== 'CONNECTED') {
    return { ok: false, code: 'SERVER_NOT_CONNECTED', message: 'The server must be connected before deploying' };
  }

  const now = deps.now();
  const [row] = await tx
    .insert(deployments)
    .values({
      id: uuidv7(),
      serviceId: service.id,
      status: 'QUEUED',
      trigger: 'manual',
      triggeredBy: input.actor.type === 'user' ? input.actor.id : null,
      source: sourceSnapshotFromService(service),
      createdAt: now,
      updatedAt: now,
    })
    .returning();
  if (!row) throw new Error('triggerDeploy: insert returned no row');

  const activityEventId = await writeActivityEvent(
    tx,
    {
      actorType: input.actor.type,
      actorId: input.actor.type === 'user' ? input.actor.id : null,
      entityType: 'deployment',
      entityId: row.id,
      action: 'deployment.queued',
      outcome: 'success',
      metadata: { serviceId: service.id, trigger: row.trigger },
    },
    now,
  );
  return {
    ok: true,
    deployment: toDeploymentView(row),
    service: toServiceView(service, { status: row.status }),
    activityEventId,
  };
}

/** Undoes the insert only while the row is still QUEUED; a row the worker already moved stays. */
async function undoQueuedDeployment(tx: Transaction, deploymentId: string, activityEventId: string): Promise<UndoResult> {
  const [current] = await tx.select().from(deployments).where(eq(deployments.id, deploymentId)).for('update');
  if (!current) return { kind: 'missing' };
  if (current.status !== 'QUEUED') return { kind: 'moved', deployment: toDeploymentView(current) };
  await tx.delete(deployments).where(eq(deployments.id, deploymentId));
  await tx.delete(activityEvents).where(eq(activityEvents.id, activityEventId));
  return { kind: 'rolled_back' };
}

export async function triggerDeploy(deps: DeploymentServicesDeps, input: TriggerDeployInput): Promise<TriggerDeployResult> {
  let inserted: InsertResult;
  try {
    inserted = await deps.db.transaction((tx) => insertQueuedDeployment(tx, deps, input));
  } catch (error) {
    if (uniqueViolationConstraint(error) === ACTIVE_DEPLOYMENT_CONSTRAINT) return inProgress();
    throw error;
  }
  if (!inserted.ok) return inserted;

  const { deployment } = inserted;
  const enqueued = await deps.queue.enqueue({
    deploymentId: deployment.id,
    serviceId: deployment.serviceId,
    actor: input.actor,
    requestedAt: deployment.createdAt,
  });

  if (!enqueued.ok) {
    let undo: UndoResult;
    try {
      undo = await deps.db.transaction((tx) => undoQueuedDeployment(tx, deployment.id, inserted.activityEventId));
    } catch {
      // Never log the error itself: a driver message can carry a connection string.
      deps.logger.error({ deploymentId: deployment.id }, 'deploy enqueue failed and the QUEUED deployment could not be undone');
      return queueUnavailable();
    }
    if (undo.kind === 'moved') return { ok: true, deployment: undo.deployment };
    deps.logger.warn({ deploymentId: deployment.id }, 'deploy enqueue failed; QUEUED deployment rolled back');
    return queueUnavailable();
  }

  await publishServerEvent(deps.events, {
    type: 'deployment.updated',
    deployment: { id: deployment.id, serviceId: deployment.serviceId, status: deployment.status, errorCode: deployment.errorCode },
  });
  await publishServerEvent(deps.events, { type: 'service.updated', service: inserted.service });
  return { ok: true, deployment };
}

// ---------------------------------------------------------------------------------------------
// Worker outcome (12-11)
// ---------------------------------------------------------------------------------------------

export interface DeploymentFinishedEventInput {
  readonly deploymentId: string;
  readonly serviceId: string;
  readonly status: DeploymentStatus;
  readonly durationMs: number;
  readonly commitSha: string | null;
  readonly errorCode: DeploymentErrorCode | null;
}

/** The deploy store's `deployment.finished` row, inside its finish transaction. ACT-01 keeps
 *  `writeActivityEvent` behind src/services/; the worker is the system actor. */
export function writeDeploymentFinishedEvent(tx: Transaction, input: DeploymentFinishedEventInput, now: Date): Promise<string> {
  return writeActivityEvent(
    tx,
    {
      actorType: 'system',
      entityType: 'deployment',
      entityId: input.deploymentId,
      action: 'deployment.finished',
      outcome: input.status === 'SUCCESS' ? 'success' : 'failure',
      ...(input.errorCode === null ? {} : { errorCode: input.errorCode }),
      metadata: { serviceId: input.serviceId, status: input.status, durationMs: input.durationMs, commitSha: input.commitSha },
    },
    now,
  );
}

// ---------------------------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------------------------

export interface ListDeploymentsInput {
  readonly limit: number;
  readonly cursor?: { readonly occurredAt: Date; readonly id: string };
}

export interface DeploymentPage {
  readonly items: DeploymentView[];
  readonly nextCursor: string | null;
}

/** Newest first, keyset on (createdAt, id). `null` when the service does not exist. */
export async function listDeployments(
  deps: Pick<DeploymentServicesDeps, 'db'>,
  serviceId: string,
  input: ListDeploymentsInput,
): Promise<DeploymentPage | null> {
  const [service] = await deps.db.select({ id: services.id }).from(services).where(eq(services.id, serviceId)).limit(1);
  if (!service) return null;
  const { limit, cursor } = input;
  const rows = await deps.db
    .select()
    .from(deployments)
    .where(
      and(
        eq(deployments.serviceId, serviceId),
        cursor
          ? or(
              lt(deployments.createdAt, cursor.occurredAt),
              and(eq(deployments.createdAt, cursor.occurredAt), lt(deployments.id, cursor.id)),
            )
          : undefined,
      ),
    )
    .orderBy(desc(deployments.createdAt), desc(deployments.id))
    .limit(limit + 1);
  const hasMore = rows.length > limit;
  const page = hasMore ? rows.slice(0, limit) : rows;
  const last = page.at(-1);
  return {
    items: page.map(toDeploymentView),
    nextCursor: hasMore && last ? encodeActivityCursor({ occurredAt: last.createdAt, id: last.id }) : null,
  };
}

export async function getDeployment(deps: Pick<DeploymentServicesDeps, 'db'>, deploymentId: string): Promise<DeploymentView | null> {
  const [row] = await deps.db.select().from(deployments).where(eq(deployments.id, deploymentId)).limit(1);
  return row ? toDeploymentView(row) : null;
}

/** Scoped by both ids: a deployment of another service reads exactly like a missing one (H2). */
export async function getServiceDeployment(
  deps: Pick<DeploymentServicesDeps, 'db'>,
  serviceId: string,
  deploymentId: string,
): Promise<DeploymentView | null> {
  const [row] = await deps.db
    .select()
    .from(deployments)
    .where(and(eq(deployments.id, deploymentId), eq(deployments.serviceId, serviceId)))
    .limit(1);
  return row ? toDeploymentView(row) : null;
}

// ---------------------------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------------------------

export interface DeploymentServices {
  triggerDeploy(input: TriggerDeployInput): Promise<TriggerDeployResult>;
  listDeployments(serviceId: string, input: ListDeploymentsInput): Promise<DeploymentPage | null>;
  getDeployment(deploymentId: string): Promise<DeploymentView | null>;
  getServiceDeployment(serviceId: string, deploymentId: string): Promise<DeploymentView | null>;
}

export function createDeploymentServices(deps: DeploymentServicesDeps): DeploymentServices {
  return {
    triggerDeploy: (input) => triggerDeploy(deps, input),
    listDeployments: (serviceId, input) => listDeployments(deps, serviceId, input),
    getDeployment: (deploymentId) => getDeployment(deps, deploymentId),
    getServiceDeployment: (serviceId, deploymentId) => getServiceDeployment(deps, serviceId, deploymentId),
  };
}
