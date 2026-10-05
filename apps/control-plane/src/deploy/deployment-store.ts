// 12-11 (C3, H1): the deploy worker's only write path for a deployment row.
// - claim: QUEUED -> PREPARING under SELECT ... FOR UPDATE in one transaction. Any other status
//   (a BullMQ re-delivery of a job already past QUEUED) returns null, so the caller runs nothing.
// - progress: every edge goes through `transitionDeployment` and a conditional UPDATE on the
//   expected status; a row that moved underneath is a conflict, never a silent overwrite.
// - finish: terminal status, timings, error code/message, the services.status cache (D5), the
//   `deployment.finished` activity event in the same transaction, then deployment.updated and
//   service.updated after commit. Idempotent: an already terminal row is left alone.
// - requestCancel (12-13): under the same row lock a QUEUED row ends CANCELLED here (the worker's
//   claim then finds nothing to run); a running row is only reported, its worker does the
//   transition. Terminal rows are reported, never touched (H1).
// Error messages are the pipeline's fixed texts (never raw remote output), capped here again.
import { and, eq, inArray } from 'drizzle-orm';
import {
  deriveServiceStatus,
  isTerminalDeploymentStatus,
  transitionDeployment,
  type ContainerObservation,
  type DeploymentErrorCode,
  type DeploymentStatus,
} from '@noodara/domain/deployment';
import type { CommitSha } from '@noodara/domain/validators';
import type { Database } from '../db/client.js';
import { deployments } from '../db/schema/deployments.js';
import { services } from '../db/schema/services.js';
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

async function publishDeployment(deps: DeploymentStoreDeps, row: DeploymentRow): Promise<void> {
  await publishServerEvent(deps.events, {
    type: 'deployment.updated',
    deployment: { id: row.id, serviceId: row.serviceId, status: row.status, errorCode: row.errorCode },
  });
}

async function claimRow(tx: Transaction, deps: DeploymentStoreDeps, deploymentId: string): Promise<DeploymentRow | null> {
  const [row] = await tx.select().from(deployments).where(eq(deployments.id, deploymentId)).for('update');
  if (row?.status !== 'QUEUED') return null;
  const status = transitionDeployment(row.status, 'PREPARING');
  const now = deps.now();
  const [claimed] = await tx
    .update(deployments)
    .set({ status, startedAt: now, updatedAt: now })
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
    .set({ status, completedAt: now, durationMs, errorCode, errorMessage, commitSha, updatedAt: now })
    .where(eq(deployments.id, deploymentId))
    .returning();
  if (!updated) throw new Error('finishDeployment: update returned no row');

  let serviceView: ServiceView | null = null;
  const [service] = await tx.select().from(services).where(eq(services.id, row.serviceId)).for('update');
  if (service) {
    const container = input.container ?? containerObservationFromCache(service.status);
    const cached = deriveServiceStatus({ latestDeployment: { status }, container });
    const [cachedRow] = await tx.update(services).set({ status: cached }).where(eq(services.id, service.id)).returning();
    serviceView = toServiceView(cachedRow ?? { ...service, status: cached }, { status });
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
  if (finished.service) await publishServerEvent(deps.events, { type: 'service.updated', service: finished.service });
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
          const [row] = await deps.db
            .update(deployments)
            .set({ status: next, updatedAt: deps.now() })
            .where(and(eq(deployments.id, deploymentId), eq(deployments.status, from)))
            .returning();
          if (!row) throw new DeploymentConflictError(deploymentId, from);
          await publishDeployment(deps, row);
        },
        async recordCommitSha(sha) {
          await deps.db
            .update(deployments)
            .set({ commitSha: sha, updatedAt: deps.now() })
            .where(eq(deployments.id, deploymentId));
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
  };
}
