// 12-11 (C3, H1): the deploy worker's only write path for a deployment row.
// - claim: QUEUED -> PREPARING under SELECT ... FOR UPDATE in one transaction. Any other status
//   (a BullMQ re-delivery of a job already past QUEUED) returns null, so the caller runs nothing.
// - progress: every edge goes through `transitionDeployment` and an UPDATE on the expected status
//   under the row lock; a row that moved underneath is a conflict, never a silent overwrite.
//   13-03: the edge's step boundary (`stepBoundaryOfTransition`) is set in that same UPDATE, and
//   the start -> verify boundary is one conditional UPDATE allowed only while DEPLOYING, so a
//   terminal row never gains a boundary after its status.
// - updatedAt (13-02 H1): every write moves it strictly forward (`nextUpdatedAt` on the locked
//   row), and the events carry that value.
// - finish: terminal status, timings, error code/message, the services.status cache (D5), the
//   `deployment.finished` activity event in the same transaction, then deployment.updated and
//   service.updated after commit. Idempotent: an already terminal row is left alone.
// - requestCancel (12-13): under the same row lock a QUEUED row ends CANCELLED here (the worker's
//   claim then finds nothing to run); a running row is only reported, its worker does the
//   transition. Terminal rows are reported, never touched (H1).
// - failStaleQueued (14-08): a QUEUED row whose job never reached the queue ends
//   FAILED/ENQUEUE_FAILED under the same row lock, with a conditional UPDATE on status 'QUEUED',
//   so a worker's concurrent claim and a second sweep both leave it alone. Only this path may fail
//   an unclaimed row; `finish` refuses one.
// Error messages are the pipeline's fixed texts (never raw remote output), capped here again.
import { and, asc, eq, inArray, lte } from 'drizzle-orm';
import {
  canEnterVerifyStep,
  deriveServiceStatus,
  InvalidDeploymentTransitionError,
  isTerminalDeploymentStatus,
  stepBoundaryOfTransition,
  transitionDeployment,
  type ContainerObservation,
  type DeploymentErrorCode,
  type DeploymentStatus,
  type DeploymentStepBoundary,
} from '@noodara/domain/deployment';
import type { CommitSha } from '@noodara/domain/validators';
import type { Database } from '../db/client.js';
import { deployments } from '../db/schema/deployments.js';
import { services } from '../db/schema/services.js';
import { buildDeploymentUpdatedEvent, buildServiceUpdatedEvent } from '../events/deploy-engine-events.js';
import { publishServerEvent, type ServerEventPublisher } from '../events/server-event-publisher.js';
import {
  toDeploymentView,
  writeDeploymentCancelRequestedEvent,
  writeDeploymentFinishedEvent,
  type DeploymentRow,
  type DeploymentView,
} from '../services/deployment-services.js';
import type { ServiceActor } from '../services/server-service-deps.js';
import { containerObservationFromCache, toServiceView, type ServiceView } from '../services/service-view.js';
import { nextUpdatedAt } from '../services/updated-at.js';
import { DEPLOY_MESSAGES, type DeploymentProgress, type DeploymentWarning } from './run-deployment.js';

export interface DeploymentStoreDeps {
  readonly db: Database;
  readonly now: () => Date;
  readonly events: ServerEventPublisher;
}

export interface FinishDeploymentInput {
  readonly status: 'SUCCESS' | 'FAILED' | 'CANCELLED';
  readonly errorCode: DeploymentErrorCode | null;
  readonly errorMessage: string | null;
  readonly commitSha: CommitSha | null;
  /** What the attempt observed of `noodara-<serviceId>`; null keeps the cached observation. */
  readonly container: ContainerObservation | null;
  /** H2: carried by the `deployment.finished` event as its errorCode (the row keeps its code). */
  readonly warning?: DeploymentWarning;
}

export type StoreCancelResult =
  | { readonly kind: 'missing' }
  | { readonly kind: 'terminal'; readonly deployment: DeploymentView }
  /** It was QUEUED: it is CANCELLED now and no job may run it. */
  | { readonly kind: 'cancelled'; readonly deployment: DeploymentView }
  /** Claimed by a worker: only that worker may move it (A2). */
  | { readonly kind: 'running'; readonly deployment: DeploymentView };

/** A deployment a worker had claimed, with the server it ran against (the crash sweep's input). */
export interface InFlightDeployment {
  readonly deploymentId: string;
  readonly serviceId: string;
  readonly serverId: string;
  readonly status: DeploymentStatus;
}

const IN_FLIGHT_STATUSES = ['PREPARING', 'BUILDING', 'DEPLOYING'] as const;

/** A QUEUED deployment old enough for the stale-QUEUED sweep to look at its job. */
export interface StaleQueuedDeployment {
  readonly deploymentId: string;
  readonly serviceId: string;
  readonly createdAt: Date;
}

/** H3: fixed and actionable; never carries Redis/Postgres error text. */
export const ENQUEUE_FAILED_MESSAGE =
  'The deployment never reached the job queue, so it was never started. Check that Redis and Postgres are reachable, then deploy again.';

export interface DeploymentStore {
  /** QUEUED -> PREPARING, or null when the row is missing or already past QUEUED (H1). */
  claim(deploymentId: string): Promise<DeploymentRow | null>;
  progress(deploymentId: string): DeploymentProgress;
  /** The terminal write; null when the row is missing or already terminal. */
  finish(deploymentId: string, input: FinishDeploymentInput): Promise<DeploymentView | null>;
  requestCancel(deploymentId: string, actor: ServiceActor): Promise<StoreCancelResult>;
  /** The `deployment.cancel_requested` event of an accepted cancel on a running deployment. */
  recordCancelRequested(deployment: DeploymentView, actor: ServiceActor): Promise<void>;
  inFlight(): Promise<InFlightDeployment[]>;
  /** QUEUED rows created at or before `cutoff`, oldest first, at most `limit` (H3). */
  staleQueued(cutoff: Date, limit: number): Promise<StaleQueuedDeployment[]>;
  /** QUEUED -> FAILED/ENQUEUE_FAILED; null when the row is missing, newer than `cutoff` or no longer QUEUED. */
  failStaleQueued(deploymentId: string, cutoff: Date): Promise<DeploymentView | null>;
}

/** The row was not at the status the worker expected (cancelled or finished elsewhere). */
export class DeploymentConflictError extends Error {
  constructor(
    readonly deploymentId: string,
    readonly expected: DeploymentStatus,
  ) {
    super(`Deployment ${deploymentId} is no longer ${expected}`);
    this.name = 'DeploymentConflictError';
  }
}

export const MAX_ERROR_MESSAGE_LENGTH = 1024;

type Transaction = Parameters<Parameters<Database['transaction']>[0]>[0];

function capMessage(message: string): string {
  return message.length <= MAX_ERROR_MESSAGE_LENGTH ? message : `${message.slice(0, MAX_ERROR_MESSAGE_LENGTH - 1)}…`;
}

function boundaryOf(from: DeploymentStatus, to: DeploymentStatus, now: Date): Partial<Record<DeploymentStepBoundary, Date>> {
  const boundary = stepBoundaryOfTransition(from, to);
  return boundary === null ? {} : { [boundary]: now };
}

async function publishDeployment(deps: DeploymentStoreDeps, row: DeploymentRow): Promise<void> {
  await publishServerEvent(deps.events, buildDeploymentUpdatedEvent({ ...row, updatedAt: row.updatedAt.toISOString() }));
}

async function claimRow(tx: Transaction, deps: DeploymentStoreDeps, deploymentId: string): Promise<DeploymentRow | null> {
  const [row] = await tx.select().from(deployments).where(eq(deployments.id, deploymentId)).for('update');
  if (row?.status !== 'QUEUED') return null;
  const status = transitionDeployment(row.status, 'PREPARING');
  const now = deps.now();
  const [claimed] = await tx
    .update(deployments)
    .set({ status, startedAt: now, updatedAt: nextUpdatedAt(row.updatedAt, now) })
    .where(eq(deployments.id, deploymentId))
    .returning();
  return claimed ?? null;
}

interface Finished {
  readonly deployment: DeploymentRow;
  readonly service: ServiceView | null;
}

async function finishRow(
  tx: Transaction,
  deps: DeploymentStoreDeps,
  deploymentId: string,
  input: FinishDeploymentInput,
): Promise<Finished | null> {
  const [row] = await tx.select().from(deployments).where(eq(deployments.id, deploymentId)).for('update');
  if (!row || isTerminalDeploymentStatus(row.status)) return null;
  // QUEUED -> FAILED is the stale-QUEUED sweep's edge only (14-08); a worker fails claimed rows.
  if (row.status === 'QUEUED' && input.status === 'FAILED') throw new InvalidDeploymentTransitionError(row.status, input.status);
  const finished = await finishLockedRow(tx, deps, row, input);
  if (!finished) throw new Error('finishDeployment: update returned no row');
  return finished;
}

async function failStaleRow(tx: Transaction, deps: DeploymentStoreDeps, deploymentId: string, cutoff: Date): Promise<Finished | null> {
  const [row] = await tx.select().from(deployments).where(eq(deployments.id, deploymentId)).for('update');
  if (row?.status !== 'QUEUED' || row.createdAt.getTime() > cutoff.getTime()) return null;
  return finishLockedRow(tx, deps, row, {
    status: 'FAILED',
    errorCode: 'ENQUEUE_FAILED',
    errorMessage: ENQUEUE_FAILED_MESSAGE,
    commitSha: null,
    container: null,
  });
}

/** The terminal write on a row locked by the caller; null when the conditional UPDATE matched nothing. */
async function finishLockedRow(
  tx: Transaction,
  deps: DeploymentStoreDeps,
  row: DeploymentRow,
  input: FinishDeploymentInput,
): Promise<Finished | null> {
  const deploymentId = row.id;
  const status = transitionDeployment(row.status, input.status);
  const now = deps.now();
  const durationMs = Math.max(0, now.getTime() - (row.startedAt ?? row.createdAt).getTime());
  const failed = status === 'FAILED';
  const errorCode: DeploymentErrorCode | null = failed ? (input.errorCode ?? 'WORKER_CRASHED') : null;
  const errorMessage = failed
    ? capMessage(input.errorCode === null || input.errorMessage === null ? DEPLOY_MESSAGES.WORKER_CRASHED : input.errorMessage)
    : null;
  const commitSha = input.commitSha ?? row.commitSha;

  const [updated] = await tx
    .update(deployments)
    .set({ status, completedAt: now, durationMs, errorCode, errorMessage, commitSha, updatedAt: nextUpdatedAt(row.updatedAt, now) })
    .where(and(eq(deployments.id, deploymentId), eq(deployments.status, row.status)))
    .returning();
  if (!updated) return null;

  let serviceView: ServiceView | null = null;
  const [service] = await tx.select().from(services).where(eq(services.id, row.serviceId)).for('update');
  if (service) {
    const container = input.container ?? containerObservationFromCache(service.status);
    const cached = deriveServiceStatus({ latestDeployment: { status }, container });
    // The derived status changed with this deployment, so the service row's updatedAt moves too.
    const updatedAt = nextUpdatedAt(service.updatedAt, now);
    const [cachedRow] = await tx
      .update(services)
      .set({ status: cached, updatedAt })
      .where(eq(services.id, service.id))
      .returning();
    serviceView = toServiceView(cachedRow ?? { ...service, status: cached, updatedAt }, { status });
  }

  await writeDeploymentFinishedEvent(
    tx,
    { deploymentId, serviceId: row.serviceId, status, durationMs, commitSha, errorCode: input.warning ?? errorCode },
    now,
  );
  return { deployment: updated, service: serviceView };
}

type CancelRow =
  | { readonly kind: 'missing' }
  | { readonly kind: 'terminal' | 'running'; readonly row: DeploymentRow }
  | { readonly kind: 'cancelled'; readonly finished: Finished };

async function cancelRow(tx: Transaction, deps: DeploymentStoreDeps, deploymentId: string, actor: ServiceActor): Promise<CancelRow> {
  const [row] = await tx.select().from(deployments).where(eq(deployments.id, deploymentId)).for('update');
  if (!row) return { kind: 'missing' };
  if (isTerminalDeploymentStatus(row.status)) return { kind: 'terminal', row };
  if (row.status !== 'QUEUED') return { kind: 'running', row };
  await writeDeploymentCancelRequestedEvent(tx, { deploymentId, serviceId: row.serviceId, status: row.status, actor }, deps.now());
  const finished = await finishRow(tx, deps, deploymentId, {
    status: 'CANCELLED',
    errorCode: null,
    errorMessage: null,
    commitSha: null,
    container: null,
  });
  if (!finished) throw new Error('requestCancel: the locked QUEUED row could not be finished');
  return { kind: 'cancelled', finished };
}

async function publishFinished(deps: DeploymentStoreDeps, finished: Finished): Promise<void> {
  await publishDeployment(deps, finished.deployment);
  if (finished.service) await publishServerEvent(deps.events, buildServiceUpdatedEvent(finished.service));
}

export function createDeploymentStore(deps: DeploymentStoreDeps): DeploymentStore {
  return {
    async claim(deploymentId) {
      const claimed = await deps.db.transaction((tx) => claimRow(tx, deps, deploymentId));
      if (claimed) await publishDeployment(deps, claimed);
      return claimed;
    },

    progress(deploymentId) {
      return {
        async advance(from, to) {
          const next = transitionDeployment(from, to);
          // Under the row lock, so the new updatedAt is computed from the stored one (H1).
          const row = await deps.db.transaction(async (tx) => {
            const [current] = await tx.select().from(deployments).where(eq(deployments.id, deploymentId)).for('update');
            if (current?.status !== from) return null;
            const now = deps.now();
            const [updated] = await tx
              .update(deployments)
              .set({ status: next, updatedAt: nextUpdatedAt(current.updatedAt, now), ...boundaryOf(from, next, now) })
              .where(and(eq(deployments.id, deploymentId), eq(deployments.status, from)))
              .returning();
            return updated ?? null;
          });
          if (!row) throw new DeploymentConflictError(deploymentId, from);
          await publishDeployment(deps, row);
        },
        async enterVerify() {
          const row = await deps.db.transaction(async (tx) => {
            const [current] = await tx.select().from(deployments).where(eq(deployments.id, deploymentId)).for('update');
            if (!current || !canEnterVerifyStep(current.status) || current.verifyingStartedAt !== null) return null;
            const now = deps.now();
            const [updated] = await tx
              .update(deployments)
              .set({ verifyingStartedAt: now, updatedAt: nextUpdatedAt(current.updatedAt, now) })
              .where(and(eq(deployments.id, deploymentId), eq(deployments.status, current.status)))
              .returning();
            return updated ?? null;
          });
          // Not DEPLOYING any more (finished elsewhere): nothing to record, the status explains it.
          if (row) await publishDeployment(deps, row);
        },
        async recordCommitSha(sha) {
          await deps.db.transaction(async (tx) => {
            const [current] = await tx.select().from(deployments).where(eq(deployments.id, deploymentId)).for('update');
            if (!current) return;
            await tx
              .update(deployments)
              .set({ commitSha: sha, updatedAt: nextUpdatedAt(current.updatedAt, deps.now()) })
              .where(eq(deployments.id, deploymentId));
          });
        },
      };
    },

    async finish(deploymentId, input) {
      const finished = await deps.db.transaction((tx) => finishRow(tx, deps, deploymentId, input));
      if (!finished) return null;
      await publishFinished(deps, finished);
      return toDeploymentView(finished.deployment);
    },

    async requestCancel(deploymentId, actor) {
      const result = await deps.db.transaction((tx) => cancelRow(tx, deps, deploymentId, actor));
      switch (result.kind) {
        case 'missing':
          return result;
        case 'cancelled':
          await publishFinished(deps, result.finished);
          return { kind: 'cancelled', deployment: toDeploymentView(result.finished.deployment) };
        default:
          return { kind: result.kind, deployment: toDeploymentView(result.row) };
      }
    },

    async recordCancelRequested(deployment, actor) {
      await deps.db.transaction((tx) =>
        writeDeploymentCancelRequestedEvent(
          tx,
          { deploymentId: deployment.id, serviceId: deployment.serviceId, status: deployment.status, actor },
          deps.now(),
        ),
      );
    },

    async inFlight() {
      return deps.db
        .select({
          deploymentId: deployments.id,
          serviceId: deployments.serviceId,
          serverId: services.serverId,
          status: deployments.status,
        })
        .from(deployments)
        .innerJoin(services, eq(services.id, deployments.serviceId))
        .where(inArray(deployments.status, [...IN_FLIGHT_STATUSES]));
    },

    async staleQueued(cutoff, limit) {
      return deps.db
        .select({ deploymentId: deployments.id, serviceId: deployments.serviceId, createdAt: deployments.createdAt })
        .from(deployments)
        .where(and(eq(deployments.status, 'QUEUED'), lte(deployments.createdAt, cutoff)))
        .orderBy(asc(deployments.createdAt))
        .limit(limit);
    },

    async failStaleQueued(deploymentId, cutoff) {
      const finished = await deps.db.transaction((tx) => failStaleRow(tx, deps, deploymentId, cutoff));
      if (!finished) return null;
      await publishFinished(deps, finished);
      return toDeploymentView(finished.deployment);
    },
  };
}
