// 12-10: enqueue and read deployments. A deploy inserts a QUEUED row (source snapshot) in one
// transaction, then enqueues an ids-only job (`deploy-<deploymentId>`). The partial unique index
// `deployments_service_active_unique_idx` is the single source of truth for "one active deploy
// per service" (A2). If the enqueue fails the insert is undone, so no deployment stays QUEUED
// without a job (H1). Views are allowlisted: ids, statuses and the source snapshot, never secrets.
import { and, desc, eq, inArray, lt, or } from 'drizzle-orm';
import { uuidv7 } from 'uuidv7';
import { z } from 'zod';
import {
  imageRetention,
  NON_TERMINAL_DEPLOYMENT_STATUSES,
  requestFingerprint,
  selectRollbackTarget,
  type DeploymentErrorCode,
  type DeploymentStatus,
  type DeploymentTrigger,
  type RollbackRefusal,
} from '@noodara/domain/deployment';
import { writeActivityEvent } from '../activity/write-activity-event.js';
import type { Database } from '../db/client.js';
import { activityEvents } from '../db/schema/activity-events.js';
import { deployments } from '../db/schema/deployments.js';
import { projects } from '../db/schema/projects.js';
import { servers } from '../db/schema/servers.js';
import { services } from '../db/schema/services.js';
import { buildDeploymentUpdatedEvent, buildServiceUpdatedEvent } from '../events/deploy-engine-events.js';
import { publishServerEvent, type ServerEventPublisher } from '../events/server-event-publisher.js';
import type { DeployQueue } from '../queue/deploy-queue.js';
import { encodeActivityCursor } from '../routes/activity-cursor.js';
import type { ServiceActor } from './server-service-deps.js';
import { toServiceView, type ServiceRow, type ServiceView } from './service-view.js';
import { nextUpdatedAtSql } from './updated-at.js';

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
const IDEMPOTENCY_KEY_CONSTRAINT = 'deployments_service_idempotency_key_unique_idx';

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
  // 17-05 (A4): always set by toDeploymentView; optional in the type like the wire schema.
  readonly rollbackOfDeploymentId?: string | null;
  readonly imageRef?: string | null;
  readonly webhookDeliveryId?: string | null;
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
  'rollbackOfDeploymentId',
  'imageRef',
  'webhookDeliveryId',
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
    rollbackOfDeploymentId: row.rollbackOfDeploymentId,
    imageRef: row.imageRef,
    webhookDeliveryId: row.webhookDeliveryId,
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

type GuardResult =
  | { readonly ok: true; readonly service: ServiceRow }
  | Failure<'NOT_FOUND' | 'PROJECT_ARCHIVED' | 'SERVER_NOT_CONNECTED'>;

/** The deploy guards: the service exists, its project is not archived, its server is connected. */
async function guardDeployableService(tx: Transaction, serviceId: string): Promise<GuardResult> {
  const [service] = await tx.select().from(services).where(eq(services.id, serviceId)).limit(1);
  if (!service) return { ok: false, code: 'NOT_FOUND', message: `Service "${serviceId}" not found` };
  // FOR SHARE: archiving the project (an UPDATE) waits for this insert, never races past it.
  const [project] = await tx
    .select({ archivedAt: projects.archivedAt })
    .from(projects)
    .where(eq(projects.id, service.projectId))
    .for('share');
  if (!project) return { ok: false, code: 'NOT_FOUND', message: `Service "${serviceId}" not found` };
  if (project.archivedAt !== null) {
    return { ok: false, code: 'PROJECT_ARCHIVED', message: 'This project is archived; unarchive it to deploy' };
  }
  const [server] = await tx.select({ status: servers.status }).from(servers).where(eq(servers.id, service.serverId)).for('share');
  if (server?.status !== 'CONNECTED') {
    return { ok: false, code: 'SERVER_NOT_CONNECTED', message: 'The server must be connected before deploying' };
  }
  return { ok: true, service };
}

type QueuedValues = Omit<typeof deployments.$inferInsert, 'id' | 'serviceId' | 'status' | 'triggeredBy' | 'createdAt' | 'updatedAt'>;

/** Inserts the QUEUED row, touches the service and writes `deployment.queued`, inside `tx`. */
async function insertQueuedRow(
  tx: Transaction,
  deps: DeploymentServicesDeps,
  service: ServiceRow,
  actor: ServiceActor,
  values: QueuedValues,
  metadata: Record<string, unknown> = {},
): Promise<InsertResult> {
  const now = deps.now();
  const [row] = await tx
    .insert(deployments)
    .values({
      ...values,
      id: uuidv7(),
      serviceId: service.id,
      status: 'QUEUED',
      triggeredBy: actor.type === 'user' ? actor.id : null,
      createdAt: now,
      updatedAt: now,
    })
    .returning();
  if (!row) throw new Error('triggerDeploy: insert returned no row');
  // The service's derived status moves to DEPLOYING with this row, so its updatedAt moves too
  // (13-02): the service.updated published after the commit carries this value. Taken after the
  // server lock, the same order as the service writes that lock the server first.
  const [touched] = await tx
    .update(services)
    .set({ updatedAt: nextUpdatedAtSql(services.updatedAt, now) })
    .where(eq(services.id, service.id))
    .returning();
  if (!touched) return { ok: false, code: 'NOT_FOUND', message: `Service "${service.id}" not found` };

  const activityEventId = await writeActivityEvent(
    tx,
    {
      actorType: actor.type,
      actorId: actor.type === 'user' ? actor.id : null,
      entityType: 'deployment',
      entityId: row.id,
      action: 'deployment.queued',
      outcome: 'success',
      metadata: { serviceId: service.id, trigger: row.trigger, ...metadata },
    },
    now,
  );
  return {
    ok: true,
    deployment: toDeploymentView(row),
    service: toServiceView(touched, { status: row.status }),
    activityEventId,
  };
}

async function insertQueuedDeployment(tx: Transaction, deps: DeploymentServicesDeps, input: TriggerDeployInput): Promise<InsertResult> {
  const guard = await guardDeployableService(tx, input.serviceId);
  if (!guard.ok) return guard;
  return insertQueuedRow(tx, deps, guard.service, input.actor, { trigger: 'manual', source: sourceSnapshotFromService(guard.service) });
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

type Inserted = Extract<InsertResult, { ok: true }>;

/** H1: enqueues the committed QUEUED row; a failed enqueue undoes it while it is still QUEUED. */
async function enqueueInserted(
  deps: DeploymentServicesDeps,
  inserted: Inserted,
  actor: ServiceActor,
): Promise<{ readonly ok: true; readonly deployment: DeploymentView } | Failure<'QUEUE_UNAVAILABLE'>> {
  const { deployment } = inserted;
  const enqueued = await deps.queue.enqueue({
    deploymentId: deployment.id,
    serviceId: deployment.serviceId,
    actor,
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

  await publishServerEvent(deps.events, buildDeploymentUpdatedEvent(deployment));
  await publishServerEvent(deps.events, buildServiceUpdatedEvent(inserted.service));
  return { ok: true, deployment };
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
  return enqueueInserted(deps, inserted, input.actor);
}

// ---------------------------------------------------------------------------------------------
// Manual rollback (17-05)
// ---------------------------------------------------------------------------------------------

/** How many of the service's newest SUCCESS rows the target selection reads (retention is <= 10). */
const ROLLBACK_HISTORY_LIMIT = 100;

export type RollbackReason = RollbackRefusal | 'not_deployed';

const ROLLBACK_REASON_MESSAGES: Readonly<Record<Exclude<RollbackReason, 'other_service'>, string>> = Object.freeze({
  not_deployed: 'the service has no successful deployment to roll back from',
  none: 'no earlier successful deployment with a retained image exists',
  image_pruned: "the target's image is no longer retained on the server",
  not_known_good: 'the target is not a successful deployment with a recorded runtime configuration',
  same_as_current: 'the target is the version already running',
});

export interface RollbackPlanInput {
  readonly serviceId: string;
  /** services.imageRetention */
  readonly retention: number;
  /** The service's SUCCESS deployments, newest first; the first one is the running version. */
  readonly successes: readonly DeploymentRow[];
  /** The explicit target as read under the service's id: `row` is null when it was not found. */
  readonly explicit?: { readonly id: string; readonly row: DeploymentRow | null };
}

export type RollbackPlan =
  | { readonly ok: true; readonly target: DeploymentRow; readonly current: DeploymentRow }
  | {
      readonly ok: false;
      readonly code: 'NOT_FOUND' | 'ROLLBACK_TARGET_UNAVAILABLE';
      readonly reason: RollbackReason;
      readonly message: string;
    };

function unavailable(reason: Exclude<RollbackReason, 'other_service'>): RollbackPlan {
  return {
    ok: false,
    code: 'ROLLBACK_TARGET_UNAVAILABLE',
    reason,
    message: `Rollback target unavailable (${reason}): ${ROLLBACK_REASON_MESSAGES[reason]}`,
  };
}

/** A1/A2: the domain's target selection over the retained images; pure, never throws. */
export function planRollback(input: RollbackPlanInput): RollbackPlan {
  const { explicit } = input;
  // A2: a missing target and another service's target read the same (no existence leak).
  const notFound = (targetId: string): RollbackPlan => ({
    ok: false,
    code: 'NOT_FOUND',
    reason: 'none',
    message: `Deployment "${targetId}" not found`,
  });
  if (explicit !== undefined && (explicit.row === null || explicit.row.serviceId !== input.serviceId)) {
    return notFound(explicit.id);
  }
  const [current] = input.successes;
  if (current === undefined) return unavailable('not_deployed');

  const retained = imageRetention(
    input.successes.map((row) => ({ id: row.id, status: row.status, imageRef: row.imageRef, createdAt: row.createdAt.getTime() })),
    current.imageRef,
    input.retention,
  ).keep;
  const sameImage = (row: DeploymentRow): boolean => row.id !== current.id && row.imageRef !== null && row.imageRef === current.imageRef;
  const rows = input.successes.filter((row) => !sameImage(row));
  if (explicit?.row && !rows.some((row) => row.id === explicit.id)) {
    if (sameImage(explicit.row)) return unavailable('same_as_current');
    rows.push(explicit.row);
  }
  const selection = selectRollbackTarget(
    {
      serviceId: input.serviceId,
      currentDeploymentId: current.id,
      deployments: rows.map((row) => ({ ...row, createdAt: row.createdAt.getTime() })),
    },
    retained,
    explicit?.id,
  );
  if (!selection.ok) {
    if (selection.reason === 'other_service') return notFound(explicit?.id ?? '');
    if (explicit !== undefined && selection.reason === 'none') return notFound(explicit.id);
    return unavailable(selection.reason);
  }
  const target = rows.find((row) => row.id === selection.target.id);
  if (!target) return unavailable('none');
  return { ok: true, target, current };
}

/** H1: the idempotency fingerprint of a rollback request. */
export function rollbackFingerprint(serviceId: string, targetDeploymentId: string | undefined): string {
  return requestFingerprint({ action: 'rollback', serviceId, targetDeploymentId: targetDeploymentId ?? null });
}

export interface TriggerRollbackInput {
  readonly actor: ServiceActor;
  readonly serviceId: string;
  readonly targetDeploymentId?: string;
  /** Already validated by the route (validateIdempotencyKey). */
  readonly idempotencyKey?: string;
}

export type TriggerRollbackFailureCode = TriggerDeployFailureCode | 'ROLLBACK_TARGET_UNAVAILABLE' | 'IDEMPOTENCY_KEY_REUSED';

export type TriggerRollbackResult =
  | { readonly ok: true; readonly deployment: DeploymentView; readonly replayed: boolean }
  | Failure<TriggerRollbackFailureCode>;

type RollbackTxResult =
  | ({ readonly kind: 'inserted' } & Omit<Inserted, 'ok'>)
  | { readonly kind: 'replay'; readonly deployment: DeploymentView }
  | { readonly kind: 'failed'; readonly failure: Failure<TriggerRollbackFailureCode> }
  | { readonly kind: 'absent' };

const keyReused = (): Failure<'IDEMPOTENCY_KEY_REUSED'> => ({
  ok: false,
  code: 'IDEMPOTENCY_KEY_REUSED',
  message: 'This Idempotency-Key was already used for a different request',
});

/** The row an Idempotency-Key already created: replayed when the request matches, refused otherwise. */
async function lookupIdempotent(
  tx: Pick<Transaction, 'select'>,
  serviceId: string,
  key: string,
  fingerprint: string,
): Promise<RollbackTxResult> {
  const [existing] = await tx
    .select()
    .from(deployments)
    .where(and(eq(deployments.serviceId, serviceId), eq(deployments.idempotencyKey, key)))
    .limit(1);
  if (!existing) return { kind: 'absent' };
  if (existing.requestFingerprint !== fingerprint) return { kind: 'failed', failure: keyReused() };
  return { kind: 'replay', deployment: toDeploymentView(existing) };
}

async function insertRollbackDeployment(
  tx: Transaction,
  deps: DeploymentServicesDeps,
  input: TriggerRollbackInput,
  fingerprint: string,
): Promise<RollbackTxResult> {
  const guard = await guardDeployableService(tx, input.serviceId);
  if (!guard.ok) {
    // A replay answers even if the server dropped since; a missing service never replays.
    if (guard.code !== 'NOT_FOUND' && input.idempotencyKey !== undefined) {
      const replay = await lookupIdempotent(tx, input.serviceId, input.idempotencyKey, fingerprint);
      if (replay.kind !== 'absent') return replay;
    }
    return { kind: 'failed', failure: guard };
  }
  const { service } = guard;
  if (input.idempotencyKey !== undefined) {
    const replay = await lookupIdempotent(tx, service.id, input.idempotencyKey, fingerprint);
    if (replay.kind !== 'absent') return replay;
  }
  // A2: one active deployment per service; the unique index still decides a race.
  const [active] = await tx
    .select({ id: deployments.id })
    .from(deployments)
    .where(and(eq(deployments.serviceId, service.id), inArray(deployments.status, [...NON_TERMINAL_DEPLOYMENT_STATUSES])))
    .limit(1);
  if (active) return { kind: 'failed', failure: inProgress() };

  const successes = await tx
    .select()
    .from(deployments)
    .where(and(eq(deployments.serviceId, service.id), eq(deployments.status, 'SUCCESS')))
    .orderBy(desc(deployments.createdAt), desc(deployments.id))
    .limit(ROLLBACK_HISTORY_LIMIT);
  let explicit: RollbackPlanInput['explicit'];
  if (input.targetDeploymentId !== undefined) {
    // Scoped by the service: another service's deployment is never read (A2).
    const [targetRow] = await tx
      .select()
      .from(deployments)
      .where(and(eq(deployments.id, input.targetDeploymentId), eq(deployments.serviceId, service.id)))
      .limit(1);
    explicit = { id: input.targetDeploymentId, row: targetRow ?? null };
  }
  const plan = planRollback({
    serviceId: service.id,
    retention: service.imageRetention,
    successes,
    ...(explicit === undefined ? {} : { explicit }),
  });
  if (!plan.ok) return { kind: 'failed', failure: { ok: false, code: plan.code, message: plan.message } };

  const { target, current } = plan;
  const inserted = await insertQueuedRow(
    tx,
    deps,
    service,
    input.actor,
    {
      trigger: 'rollback',
      source: target.source,
      commitSha: target.commitSha,
      imageRef: target.imageRef,
      runtimeConfig: target.runtimeConfig,
      rollbackOfDeploymentId: target.id,
      previousDeploymentId: current.id,
      ...(input.idempotencyKey === undefined ? {} : { idempotencyKey: input.idempotencyKey, requestFingerprint: fingerprint }),
    },
    { rollbackOfDeploymentId: target.id },
  );
  if (!inserted.ok) return { kind: 'failed', failure: inserted };
  return { kind: 'inserted', deployment: inserted.deployment, service: inserted.service, activityEventId: inserted.activityEventId };
}

/** A1/A2/H1: queues a `rollback` deployment of a retained known-good version. */
export async function triggerRollback(deps: DeploymentServicesDeps, input: TriggerRollbackInput): Promise<TriggerRollbackResult> {
  const fingerprint = rollbackFingerprint(input.serviceId, input.targetDeploymentId);
  let result: RollbackTxResult;
  try {
    result = await deps.db.transaction((tx) => insertRollbackDeployment(tx, deps, input, fingerprint));
  } catch (error) {
    const constraint = uniqueViolationConstraint(error);
    if (constraint !== ACTIVE_DEPLOYMENT_CONSTRAINT && constraint !== IDEMPOTENCY_KEY_CONSTRAINT) throw error;
    // H1: a concurrent request won the race; with the same key and request it is replayed.
    const key = input.idempotencyKey;
    if (key === undefined) return inProgress();
    result = await deps.db.transaction((tx) => lookupIdempotent(tx, input.serviceId, key, fingerprint));
  }
  switch (result.kind) {
    case 'absent':
      return inProgress();
    case 'failed':
      return result.failure;
    case 'replay':
      return { ok: true, deployment: result.deployment, replayed: true };
    case 'inserted': {
      const enqueued = await enqueueInserted(deps, { ok: true, ...result }, input.actor);
      return enqueued.ok ? { ...enqueued, replayed: false } : enqueued;
    }
  }
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
  /** The row's code, or the named warning of an unconfirmed cancel (12-13 H2). */
  readonly errorCode: DeploymentErrorCode | 'CANCEL_UNCONFIRMED' | null;
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

export interface DeploymentCancelRequestedEventInput {
  readonly deploymentId: string;
  readonly serviceId: string;
  /** The status the deployment had when the cancel was requested. */
  readonly status: DeploymentStatus;
  readonly actor: ServiceActor;
}

/** 12-13: `deployment.cancel_requested`, written once per accepted cancel (ACT-01). */
export function writeDeploymentCancelRequestedEvent(
  tx: Transaction,
  input: DeploymentCancelRequestedEventInput,
  now: Date,
): Promise<string> {
  return writeActivityEvent(
    tx,
    {
      actorType: input.actor.type,
      actorId: input.actor.type === 'user' ? input.actor.id : null,
      entityType: 'deployment',
      entityId: input.deploymentId,
      action: 'deployment.cancel_requested',
      outcome: 'success',
      metadata: { serviceId: input.serviceId, status: input.status },
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
  triggerRollback(input: TriggerRollbackInput): Promise<TriggerRollbackResult>;
  listDeployments(serviceId: string, input: ListDeploymentsInput): Promise<DeploymentPage | null>;
  getDeployment(deploymentId: string): Promise<DeploymentView | null>;
  getServiceDeployment(serviceId: string, deploymentId: string): Promise<DeploymentView | null>;
}

export function createDeploymentServices(deps: DeploymentServicesDeps): DeploymentServices {
  return {
    triggerDeploy: (input) => triggerDeploy(deps, input),
    triggerRollback: (input) => triggerRollback(deps, input),
    listDeployments: (serviceId, input) => listDeployments(deps, serviceId, input),
    getDeployment: (deploymentId) => getDeployment(deps, deploymentId),
    getServiceDeployment: (serviceId, deploymentId) => getServiceDeployment(deps, serviceId, deploymentId),
  };
}
