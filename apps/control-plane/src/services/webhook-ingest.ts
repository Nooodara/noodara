// 18-02 (HOOK-02): the GitHub push receiver behind `POST /webhooks/github/:hookId`.
//
// Order: resolve the hook's secret, verify X-Hub-Signature-256 over the raw bytes exactly as
// received (no JSON round trip), then validate the delivery headers, then parse. Unknown, disabled
// and badly signed deliveries are one indistinguishable `unauthorized`.
//
// One transaction per delivery: the project row FOR SHARE, then the service row FOR UPDATE (the
// order manual deploys use), then the dedupe read, the delivery row and, for a matching push, the
// webhook deployment. The service lock serialises concurrent deliveries of one hook, and the unique
// index (service_id, delivery_id) is the backstop, so a repeated X-GitHub-Delivery creates nothing
// and answers with the original deployment id (A4, H2). A failed enqueue after the commit ends the
// deployment FAILED/ENQUEUE_FAILED instead of leaving it QUEUED without a job (H3); redelivering
// that delivery retries it unless a newer push or deployment exists (then it is `superseded`).
//
// Nothing here logs the payload, the signature header or the secret (A5).
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { and, desc, eq, gt, inArray, isNotNull, isNull, notExists, sql } from 'drizzle-orm';
import { uuidv7 } from 'uuidv7';
import { NON_TERMINAL_DEPLOYMENT_STATUSES } from '@noodara/domain/deployment';
import { revealSecret } from '@noodara/domain/security';
import { decideDelivery, decidePendingTrigger, matchPush, type WebhookDeliveryOutcome } from '@noodara/domain';
import { writeActivityEvent } from '../activity/write-activity-event.js';
import type { Database } from '../db/client.js';
import { deployments } from '../db/schema/deployments.js';
import { projects } from '../db/schema/projects.js';
import { services } from '../db/schema/services.js';
import { webhookDeliveries } from '../db/schema/webhook-deliveries.js';
import { buildDeploymentUpdatedEvent, buildServiceUpdatedEvent } from '../events/deploy-engine-events.js';
import { publishServerEvent, type ServerEventPublisher } from '../events/server-event-publisher.js';
import type { DeployQueue } from '../queue/deploy-queue.js';
import { sourceSnapshotFromService, toDeploymentView, type DeploymentView } from './deployment-services.js';
import type { MasterKeys } from './server-service-deps.js';
import { toServiceView, type ServiceView } from './service-view.js';
import { nextUpdatedAtSql } from './updated-at.js';
import { resolveWebhookSecret } from './webhook-config.js';

/** A1: the receiver's body cap (1 MiB); GitHub caps payloads at 25 MB, pushes stay far below. */
export const WEBHOOK_BODY_LIMIT_BYTES = 1_048_576;

const SIGNATURE_PATTERN = /^sha256=([0-9a-fA-F]{64})$/;
/** X-GitHub-Delivery is a GUID; the column allows 1..128 characters. */
const DELIVERY_ID_PATTERN = /^[A-Za-z0-9-]{1,128}$/;
/** X-GitHub-Event names are lowercase snake case; the column allows 1..64 characters. */
const EVENT_PATTERN = /^[a-z_]{1,64}$/;
const ACTIVE_DEPLOYMENT_CONSTRAINT = 'deployments_service_active_unique_idx';
const DELIVERY_CONSTRAINT = 'webhook_deliveries_service_delivery_unique_idx';
/** A transaction that lost a race on one of the two unique indexes is replayed this many times. */
const MAX_ATTEMPTS = 3;

// ---------------------------------------------------------------------------------------------
// Signature (A2, H1)
// ---------------------------------------------------------------------------------------------

/**
 * Verifies `sha256=<hex>` against HMAC-SHA256(secret, rawBody). The header must be exactly 64 hex
 * digits; the digests are compared with `timingSafeEqual` only once both are 32 bytes, so a length
 * mismatch is a plain `false`, never a throw.
 */
export function verifyGithubSignature(secret: string, rawBody: Buffer, header: string | undefined): boolean {
  if (header === undefined) return false;
  const hex = SIGNATURE_PATTERN.exec(header)?.[1];
  if (hex === undefined) return false;
  const provided = Buffer.from(hex, 'hex');
  const expected = createHmac('sha256', secret).update(rawBody).digest();
  if (provided.length !== expected.length) return false;
  return timingSafeEqual(provided, expected);
}

/** Spends the same HMAC work for an unknown hook id as for a known one. */
const DUMMY_SECRET = randomBytes(32).toString('hex');

// ---------------------------------------------------------------------------------------------
// Rate limit (A3, H1): fixed windows in a bounded, insertion-ordered map
// ---------------------------------------------------------------------------------------------

export interface FixedWindowLimiterOptions {
  readonly limit: number;
  readonly windowMs: number;
  /** Hard cap on tracked keys; the oldest window is evicted first. */
  readonly maxKeys: number;
  /** Monotonic clock in ms; defaults to `performance.now`. */
  readonly now?: () => number;
}

export interface FixedWindowLimiter {
  /** Counts one hit for `key`; `false` once the key is over its limit in the current window. */
  hit(key: string): boolean;
  size(): number;
}

export function createFixedWindowLimiter(options: FixedWindowLimiterOptions): FixedWindowLimiter {
  const now = options.now ?? (() => performance.now());
  // A window is re-inserted whenever it restarts, so iteration order is start order: expired
  // windows sit at the front and pruning stops at the first live one.
  const windows = new Map<string, { start: number; count: number }>();

  const prune = (at: number): void => {
    for (const [key, window] of windows) {
      if (at - window.start < options.windowMs) break;
      windows.delete(key);
    }
  };

  return {
    hit(key) {
      const at = now();
      let window = windows.get(key);
      if (window !== undefined && at - window.start >= options.windowMs) {
        windows.delete(key);
        window = undefined;
      }
      if (window === undefined) {
        prune(at);
        while (windows.size >= options.maxKeys) {
          const oldest = windows.keys().next();
          if (oldest.done === true) break;
          windows.delete(oldest.value);
        }
        window = { start: at, count: 0 };
        windows.set(key, window);
      }
      if (window.count <= options.limit) window.count += 1;
      return window.count <= options.limit;
    },
    size: () => windows.size,
  };
}

export interface WebhookRateLimits {
  readonly perHook: { readonly limit: number; readonly windowMs: number };
  readonly perIp: { readonly limit: number; readonly windowMs: number };
  readonly maxKeys: number;
}

export const DEFAULT_WEBHOOK_RATE_LIMITS: WebhookRateLimits = Object.freeze({
  perHook: Object.freeze({ limit: 60, windowMs: 60_000 }),
  perIp: Object.freeze({ limit: 300, windowMs: 60_000 }),
  maxKeys: 10_000,
});

export interface WebhookRateLimiter {
  allow(hookId: string, ip: string): boolean;
}

/** Both counters move on every request, so a flood on one hook from many IPs is still capped. */
export function createWebhookRateLimiter(
  limits: WebhookRateLimits = DEFAULT_WEBHOOK_RATE_LIMITS,
  now?: () => number,
): WebhookRateLimiter {
  const clock = now === undefined ? {} : { now };
  const perIp = createFixedWindowLimiter({ ...limits.perIp, maxKeys: limits.maxKeys, ...clock });
  const perHook = createFixedWindowLimiter({ ...limits.perHook, maxKeys: limits.maxKeys, ...clock });
  return {
    allow(hookId, ip) {
      const ipAllowed = perIp.hit(ip);
      const hookAllowed = perHook.hit(hookId);
      return ipAllowed && hookAllowed;
    },
  };
}

// ---------------------------------------------------------------------------------------------
// Classification (pure)
// ---------------------------------------------------------------------------------------------

export interface DeliveryServiceState {
  readonly sourceType: 'git' | 'image';
  readonly repositoryUrl: string | null;
  readonly branch: string | null;
  readonly projectArchived: boolean;
}

export type DeliveryClassification =
  | { readonly kind: 'deploy'; readonly sha: string }
  | { readonly kind: 'record'; readonly outcome: WebhookDeliveryOutcome; readonly status: 200 | 422 };

const RECORD_STATUS: Readonly<Partial<Record<WebhookDeliveryOutcome, 200 | 422>>> = Object.freeze({
  invalid_payload: 422,
  invalid_sha: 422,
  repository_mismatch: 422,
});

function record(outcome: WebhookDeliveryOutcome): DeliveryClassification {
  return { kind: 'record', outcome, status: RECORD_STATUS[outcome] ?? 200 };
}

function parseJson(body: Buffer): { ok: true; value: unknown } | { ok: false } {
  try {
    return { ok: true, value: JSON.parse(body.toString('utf8')) as unknown };
  } catch {
    return { ok: false };
  }
}

/**
 * What a verified delivery does. Ping and non-push events are answered before the service state
 * matters; a push never deploys an image service or an archived project (H3).
 */
export function classifyDelivery(service: DeliveryServiceState, event: string, body: Buffer): DeliveryClassification {
  if (event !== 'ping' && event !== 'push') return record('ignored_event');
  const parsed = parseJson(body);
  if (event === 'ping') {
    if (!parsed.ok) return record('invalid_payload');
    const ping = matchPush({ repositoryUrl: '', branch: '' }, 'ping', parsed.value);
    return record(ping.kind === 'ping' ? 'ping' : 'invalid_payload');
  }
  if (service.sourceType !== 'git' || service.repositoryUrl === null || service.branch === null) {
    return record('source_not_git');
  }
  if (service.projectArchived) return record('project_archived');
  if (!parsed.ok) return record('invalid_payload');
  const match = matchPush({ repositoryUrl: service.repositoryUrl, branch: service.branch }, 'push', parsed.value);
  return match.kind === 'deploy' ? { kind: 'deploy', sha: match.sha } : record(match.outcome);
}

// ---------------------------------------------------------------------------------------------
// Ingest
// ---------------------------------------------------------------------------------------------

export interface WebhookIngestLogger {
  info(fields: Record<string, unknown>, message: string): void;
  warn(fields: Record<string, unknown>, message: string): void;
  error(fields: Record<string, unknown>, message: string): void;
}

export interface WebhookIngestDeps {
  readonly db: Database;
  readonly now: () => Date;
  readonly events: ServerEventPublisher;
  readonly queue: Pick<DeployQueue, 'enqueue'>;
  readonly masterKeys: () => Promise<MasterKeys>;
  /** H3: ends a committed QUEUED webhook deployment FAILED/ENQUEUE_FAILED (the deployment store). */
  readonly failUnqueued: (deploymentId: string, cutoff: Date) => Promise<unknown>;
  readonly logger: WebhookIngestLogger;
}

export interface WebhookDeliveryInput {
  readonly hookId: string;
  /** Header values; a repeated header arrives as `undefined` (rejected). */
  readonly signature: string | undefined;
  readonly deliveryId: string | undefined;
  readonly event: string | undefined;
  readonly rawBody: Buffer;
}

export type WebhookIngestResult =
  | { readonly kind: 'unauthorized' }
  | { readonly kind: 'bad_request'; readonly message: string }
  | { readonly kind: 'queue_unavailable' }
  | {
      readonly kind: 'recorded';
      readonly status: 200 | 202 | 422;
      readonly outcome: WebhookDeliveryOutcome;
      readonly deploymentId: string | null;
      readonly duplicate: boolean;
    };

export interface WebhookIngest {
  ingest(input: WebhookDeliveryInput): Promise<WebhookIngestResult>;
}

type Transaction = Parameters<Parameters<Database['transaction']>[0]>[0];

type Recorded =
  | { readonly kind: 'unauthorized' }
  | {
      readonly kind: 'recorded';
      readonly status: 200 | 202 | 422;
      readonly outcome: WebhookDeliveryOutcome;
      readonly deploymentId: string | null;
      readonly duplicate: boolean;
      /** Set only when this delivery created the deployment; it still has to be enqueued. */
      readonly created?: { readonly deployment: DeploymentView; readonly service: ServiceView };
    };

const UNAUTHORIZED = Object.freeze({ kind: 'unauthorized' } as const);

function uniqueViolationConstraint(error: unknown): string | undefined {
  const cause = (error as { cause?: { code?: string; constraint?: string } } | undefined)?.cause;
  return cause?.code === '23505' ? cause.constraint : undefined;
}

const DEPLOYED_STATUS = { deployed: 202, coalesced: 202 } as const;

async function serviceSnapshot(tx: Transaction, serviceId: string) {
  const [shallow] = await tx.select({ projectId: services.projectId }).from(services).where(eq(services.id, serviceId)).limit(1);
  if (!shallow) return null;
  // FOR SHARE first: archiving the project waits for this delivery, the order triggerDeploy uses.
  const [project] = await tx
    .select({ archivedAt: projects.archivedAt })
    .from(projects)
    .where(eq(projects.id, shallow.projectId))
    .for('share');
  const [service] = await tx.select().from(services).where(eq(services.id, serviceId)).for('update');
  if (!project || !service) return null;
  return { service, projectArchived: project.archivedAt !== null };
}

async function deploymentState(tx: Transaction, serviceId: string) {
  const [active] = await tx
    .select({ id: deployments.id, commitSha: deployments.commitSha })
    .from(deployments)
    .where(and(eq(deployments.serviceId, serviceId), inArray(deployments.status, [...NON_TERMINAL_DEPLOYMENT_STATUSES])))
    .limit(1);
  const [deployed] = await tx
    .select({ commitSha: deployments.commitSha })
    .from(deployments)
    .where(and(eq(deployments.serviceId, serviceId), eq(deployments.status, 'SUCCESS')))
    .orderBy(sql`${deployments.completedAt} DESC NULLS LAST`, desc(deployments.createdAt))
    .limit(1);
  return {
    active: active ? { deploymentId: active.id, sha: active.commitSha } : null,
    deployedSha: deployed?.commitSha ?? null,
  };
}

/**
 * H3: what a repeated X-GitHub-Delivery does. A redelivery whose deployment ended ENQUEUE_FAILED is
 * the advertised recovery from a 503 and runs again, unless a newer push or deployment of the
 * service exists (replaying it would deploy an older commit); any other repeat is a duplicate.
 */
async function redeliveryKind(
  tx: Transaction,
  service: { readonly id: string; readonly pendingTriggerDeliveryId: string | null },
  existing: { readonly deliveryId: string; readonly deploymentId: string | null },
): Promise<'duplicate' | 'retry' | 'superseded'> {
  if (existing.deploymentId === null) return 'duplicate';
  const [linked] = await tx
    .select({ status: deployments.status, errorCode: deployments.errorCode, createdAt: deployments.createdAt })
    .from(deployments)
    .where(eq(deployments.id, existing.deploymentId))
    .limit(1);
  if (linked?.status !== 'FAILED' || linked.errorCode !== 'ENQUEUE_FAILED') return 'duplicate';
  if (service.pendingTriggerDeliveryId !== null && service.pendingTriggerDeliveryId !== existing.deliveryId) return 'superseded';
  const [newer] = await tx
    .select({ id: deployments.id })
    .from(deployments)
    .where(and(eq(deployments.serviceId, service.id), gt(deployments.createdAt, linked.createdAt)))
    .limit(1);
  return newer ? 'superseded' : 'retry';
}

async function recordInTransaction(
  tx: Transaction,
  deps: WebhookIngestDeps,
  serviceId: string,
  input: { hookId: string; deliveryId: string; event: string; rawBody: Buffer },
): Promise<Recorded> {
  const snapshot = await serviceSnapshot(tx, serviceId);
  // Disabled or re-keyed between the signature check and this lock: the same 401 as unknown.
  if (snapshot?.service.webhookHookId !== input.hookId || snapshot.service.webhookSecretCredentialId === null) {
    return UNAUTHORIZED;
  }
  const { service, projectArchived } = snapshot;

  const [existing] = await tx
    .select({ id: webhookDeliveries.id, outcome: webhookDeliveries.outcome, deploymentId: webhookDeliveries.deploymentId })
    .from(webhookDeliveries)
    .where(and(eq(webhookDeliveries.serviceId, service.id), eq(webhookDeliveries.deliveryId, input.deliveryId)))
    .limit(1);
  let retriedRowId: string | null = null;
  if (existing) {
    const kind = await redeliveryKind(tx, service, { deliveryId: input.deliveryId, deploymentId: existing.deploymentId });
    if (kind === 'superseded') {
      await tx.update(webhookDeliveries).set({ outcome: 'superseded', deploymentId: null }).where(eq(webhookDeliveries.id, existing.id));
      return { kind: 'recorded', status: 200, outcome: 'superseded', deploymentId: null, duplicate: true };
    }
    if (kind === 'duplicate') {
      const status = existing.deploymentId !== null ? 202 : (RECORD_STATUS[existing.outcome] ?? 200);
      return { kind: 'recorded', status, outcome: existing.outcome, deploymentId: existing.deploymentId, duplicate: true };
    }
    // Processed again on the same delivery row.
    retriedRowId = existing.id;
  }

  const now = deps.now();
  const insertDelivery = async (outcome: WebhookDeliveryOutcome, pushedSha: string | null) => {
    if (retriedRowId !== null) {
      await tx
        .update(webhookDeliveries)
        .set({ outcome, pushedSha, deploymentId: null })
        .where(eq(webhookDeliveries.id, retriedRowId));
      return retriedRowId;
    }
    const [row] = await tx
      .insert(webhookDeliveries)
      .values({ id: uuidv7(), serviceId: service.id, deliveryId: input.deliveryId, event: input.event, outcome, pushedSha, receivedAt: now })
      .returning({ id: webhookDeliveries.id });
    if (!row) throw new Error('webhook-ingest: delivery insert returned no row');
    return row.id;
  };

  const classification = classifyDelivery(
    { sourceType: service.sourceType, repositoryUrl: service.repositoryUrl, branch: service.branch, projectArchived },
    input.event,
    input.rawBody,
  );
  if (classification.kind === 'record') {
    await insertDelivery(classification.outcome, null);
    return { kind: 'recorded', status: classification.status, outcome: classification.outcome, deploymentId: null, duplicate: false };
  }

  const state = await deploymentState(tx, service.id);
  const pending =
    service.pendingTriggerDeliveryId !== null && service.pendingTriggerSha !== null
      ? { deliveryId: service.pendingTriggerDeliveryId, sha: service.pendingTriggerSha }
      : null;
  const decision = decideDelivery({
    incoming: { deliveryId: input.deliveryId, sha: classification.sha },
    existing: null,
    active: state.active,
    pending,
    deployedSha: state.deployedSha,
  });
  if (decision.kind === 'duplicate') throw new Error('webhook-ingest: duplicate decided without an existing delivery');

  if (decision.supersededDeliveryId !== null) {
    // A pending delivery a drain already turned into a deployment keeps its `deployed` outcome.
    await tx
      .update(webhookDeliveries)
      .set({ outcome: 'superseded' })
      .where(
        and(
          eq(webhookDeliveries.serviceId, service.id),
          eq(webhookDeliveries.deliveryId, decision.supersededDeliveryId),
          isNull(webhookDeliveries.deploymentId),
        ),
      );
  }

  if (decision.kind === 'coalesce') {
    // 18-04 (A1, H1): the single pending slot, latest wins under the service lock; the drain below
    // runs it when the active deployment ends.
    await tx
      .update(services)
      .set({ pendingTriggerDeliveryId: input.deliveryId, pendingTriggerSha: decision.sha, pendingTriggerAt: now })
      .where(eq(services.id, service.id));
    await insertDelivery('coalesced', decision.sha);
    return { kind: 'recorded', status: DEPLOYED_STATUS.coalesced, outcome: 'coalesced', deploymentId: null, duplicate: false };
  }

  if (pending !== null) {
    await tx
      .update(services)
      .set({ pendingTriggerDeliveryId: null, pendingTriggerSha: null, pendingTriggerAt: null })
      .where(eq(services.id, service.id));
  }

  if (decision.kind === 'drop') {
    await insertDelivery('already_deployed', classification.sha);
    return { kind: 'recorded', status: 200, outcome: 'already_deployed', deploymentId: null, duplicate: false };
  }

  const deliveryRowId = await insertDelivery('deployed', decision.sha);
  const [row] = await tx
    .insert(deployments)
    .values({
      id: uuidv7(),
      serviceId: service.id,
      status: 'QUEUED',
      trigger: 'webhook',
      triggeredBy: `github:${input.deliveryId}`,
      source: sourceSnapshotFromService(service),
      // The requested SHA; the worker checks it out exactly (18-03).
      commitSha: decision.sha,
      webhookDeliveryId: deliveryRowId,
      createdAt: now,
      updatedAt: now,
    })
    .returning();
  if (!row) throw new Error('webhook-ingest: deployment insert returned no row');
  await tx.update(webhookDeliveries).set({ deploymentId: row.id }).where(eq(webhookDeliveries.id, deliveryRowId));
  const [touched] = await tx
    .update(services)
    .set({ updatedAt: nextUpdatedAtSql(services.updatedAt, now) })
    .where(eq(services.id, service.id))
    .returning();
  if (!touched) throw new Error('webhook-ingest: service touch returned no row');
  await writeActivityEvent(
    tx,
    {
      actorType: 'system',
      actorId: null,
      entityType: 'deployment',
      entityId: row.id,
      action: 'deployment.queued',
      outcome: 'success',
      metadata: { serviceId: service.id, trigger: row.trigger },
    },
    now,
  );
  return {
    kind: 'recorded',
    status: DEPLOYED_STATUS.deployed,
    outcome: 'deployed',
    deploymentId: row.id,
    duplicate: false,
    created: { deployment: toDeploymentView(row), service: toServiceView(touched, { status: row.status }) },
  };
}

async function recordDelivery(
  deps: WebhookIngestDeps,
  serviceId: string,
  input: { hookId: string; deliveryId: string; event: string; rawBody: Buffer },
): Promise<Recorded> {
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await deps.db.transaction((tx) => recordInTransaction(tx, deps, serviceId, input));
    } catch (error) {
      // A manual deploy that won the active slot, or a concurrent copy of this delivery that
      // committed first: replaying reads the winner (coalesce or duplicate).
      const constraint = uniqueViolationConstraint(error);
      const retriable = constraint === ACTIVE_DEPLOYMENT_CONSTRAINT || constraint === DELIVERY_CONSTRAINT;
      if (!retriable || attempt >= MAX_ATTEMPTS) throw error;
    }
  }
}

/** H3: the delivery row stays; its deployment ends FAILED/ENQUEUE_FAILED, never QUEUED without a job. */
async function enqueueCreated(
  deps: WebhookIngestDeps,
  created: NonNullable<Extract<Recorded, { kind: 'recorded' }>['created']>,
): Promise<boolean> {
  const { deployment, service } = created;
  let enqueued = false;
  try {
    const result = await deps.queue.enqueue({
      deploymentId: deployment.id,
      serviceId: deployment.serviceId,
      actor: { type: 'system' },
      requestedAt: deployment.createdAt,
    });
    enqueued = result.ok;
  } catch {
    enqueued = false;
  }
  if (!enqueued) {
    let failed: unknown;
    try {
      failed = await deps.failUnqueued(deployment.id, deps.now());
    } catch {
      // The stale-QUEUED sweep ends it ENQUEUE_FAILED later. Never log the error (driver text).
      deps.logger.error({ deploymentId: deployment.id }, 'webhook deployment enqueue failed and could not be marked failed');
      return false;
    }
    // null: the row already left QUEUED, so a worker claimed it (the enqueue did land).
    enqueued = failed === null;
  }
  if (enqueued) {
    await publishServerEvent(deps.events, buildDeploymentUpdatedEvent(deployment));
    await publishServerEvent(deps.events, buildServiceUpdatedEvent(service));
    return true;
  }
  deps.logger.warn({ deploymentId: deployment.id }, 'webhook deployment enqueue failed; deployment ended ENQUEUE_FAILED');
  // 18-04 (A2): ENQUEUE_FAILED is a terminal event too; a push coalesced meanwhile must not strand.
  await drainQuietly(deps, deployment.serviceId);
  return false;
}

// ---------------------------------------------------------------------------------------------
// Pending trigger drain (18-04)
// ---------------------------------------------------------------------------------------------
//
// Runs whenever a deployment may have ended (after every deploy job, after an ingest enqueue
// failure, after the crash and stale-QUEUED sweeps). Self-guarding: under the service lock it does
// nothing while any deployment of the service is non-terminal, so a spurious call is harmless and
// concurrent terminal events create exactly one follow-up (A2).
//
// The pending slot is cleared only once the follow-up's job is enqueued (H2). Until then the
// delivery row links the follow-up deployment; a later drain treats a pending delivery linked to a
// deployment that did not end ENQUEUE_FAILED as consumed and only clears the slot, so neither a
// lost enqueue nor a lost clear ever deploys twice or drops the push.

export type PendingTriggerDrainDeps = Pick<WebhookIngestDeps, 'db' | 'now' | 'events' | 'queue' | 'failUnqueued' | 'logger'>;

export type PendingTriggerDrainResult =
  | { readonly kind: 'none' }
  /** A deployment of the service is still non-terminal; its own end drains the slot. */
  | { readonly kind: 'busy' }
  | { readonly kind: 'dropped'; readonly outcome: WebhookDeliveryOutcome }
  | { readonly kind: 'enqueued'; readonly deploymentId: string }
  /** The slot is retained; the next terminal event or sweep retries it. */
  | { readonly kind: 'enqueue_failed'; readonly deploymentId: string };

type DrainClaim =
  | Exclude<PendingTriggerDrainResult, { kind: 'enqueued' } | { kind: 'enqueue_failed' }>
  | {
      readonly kind: 'created';
      readonly pendingDeliveryId: string;
      readonly deliveryRowId: string;
      readonly deployment: DeploymentView;
      readonly service: ServiceView;
    };

const NONE = Object.freeze({ kind: 'none' } as const);
const BUSY = Object.freeze({ kind: 'busy' } as const);

async function clearPending(tx: Transaction, serviceId: string, deliveryId: string): Promise<void> {
  await tx
    .update(services)
    .set({ pendingTriggerDeliveryId: null, pendingTriggerSha: null, pendingTriggerAt: null })
    .where(and(eq(services.id, serviceId), eq(services.pendingTriggerDeliveryId, deliveryId)));
}

async function claimPendingInTransaction(tx: Transaction, deps: PendingTriggerDrainDeps, serviceId: string): Promise<DrainClaim> {
  const snapshot = await serviceSnapshot(tx, serviceId);
  if (snapshot === null) return NONE;
  const { service, projectArchived } = snapshot;
  if (service.pendingTriggerDeliveryId === null || service.pendingTriggerSha === null) return NONE;
  const pending = { deliveryId: service.pendingTriggerDeliveryId, sha: service.pendingTriggerSha };

  const state = await deploymentState(tx, service.id);
  if (state.active !== null) return BUSY;

  const [delivery] = await tx
    .select({ id: webhookDeliveries.id, deploymentId: webhookDeliveries.deploymentId })
    .from(webhookDeliveries)
    .where(and(eq(webhookDeliveries.serviceId, service.id), eq(webhookDeliveries.deliveryId, pending.deliveryId)))
    .limit(1);
  if (!delivery) {
    await clearPending(tx, service.id, pending.deliveryId);
    return NONE;
  }
  if (delivery.deploymentId !== null) {
    const [linked] = await tx
      .select({ status: deployments.status, errorCode: deployments.errorCode })
      .from(deployments)
      .where(eq(deployments.id, delivery.deploymentId))
      .limit(1);
    const enqueueFailed = linked?.status === 'FAILED' && linked.errorCode === 'ENQUEUE_FAILED';
    if (linked !== undefined && !enqueueFailed) {
      // Already ran (its enqueue succeeded but the slot was never cleared).
      await clearPending(tx, service.id, pending.deliveryId);
      return NONE;
    }
  }

  const now = deps.now();
  const drop = async (outcome: WebhookDeliveryOutcome): Promise<DrainClaim> => {
    await tx.update(webhookDeliveries).set({ outcome, deploymentId: null }).where(eq(webhookDeliveries.id, delivery.id));
    await clearPending(tx, service.id, pending.deliveryId);
    return { kind: 'dropped', outcome };
  };
  // Never deploy what a push could not deploy now (H3 of 18-02).
  if (service.sourceType !== 'git' || service.repositoryUrl === null || service.branch === null) return drop('source_not_git');
  if (projectArchived) return drop('project_archived');
  const decision = decidePendingTrigger(pending, state.deployedSha);
  if (decision.kind === 'none') return NONE;
  if (decision.kind === 'drop') return drop(decision.outcome);

  const [row] = await tx
    .insert(deployments)
    .values({
      id: uuidv7(),
      serviceId: service.id,
      status: 'QUEUED',
      trigger: 'webhook',
      triggeredBy: `github:${pending.deliveryId}`,
      source: sourceSnapshotFromService(service),
      commitSha: decision.sha,
      webhookDeliveryId: delivery.id,
      createdAt: now,
      updatedAt: now,
    })
    .returning();
  if (!row) throw new Error('webhook-ingest: follow-up deployment insert returned no row');
  await tx.update(webhookDeliveries).set({ outcome: 'deployed', deploymentId: row.id }).where(eq(webhookDeliveries.id, delivery.id));
  const [touched] = await tx
    .update(services)
    .set({ updatedAt: nextUpdatedAtSql(services.updatedAt, now) })
    .where(eq(services.id, service.id))
    .returning();
  if (!touched) throw new Error('webhook-ingest: service touch returned no row');
  await writeActivityEvent(
    tx,
    {
      actorType: 'system',
      actorId: null,
      entityType: 'deployment',
      entityId: row.id,
      action: 'deployment.queued',
      outcome: 'success',
      metadata: { serviceId: service.id, trigger: row.trigger },
    },
    now,
  );
  return {
    kind: 'created',
    pendingDeliveryId: pending.deliveryId,
    deliveryRowId: delivery.id,
    deployment: toDeploymentView(row),
    service: toServiceView(touched, { status: row.status }),
  };
}

async function claimPending(deps: PendingTriggerDrainDeps, serviceId: string): Promise<DrainClaim> {
  try {
    return await deps.db.transaction((tx) => claimPendingInTransaction(tx, deps, serviceId));
  } catch (error) {
    // A manual deploy took the active slot between our read and insert: its end drains the slot.
    if (uniqueViolationConstraint(error) === ACTIVE_DEPLOYMENT_CONSTRAINT) return BUSY;
    throw error;
  }
}

/**
 * Runs or drops the service's pending trigger once no deployment of it is active. Throws only on a
 * database error before anything is enqueued (callers log by class); the slot then stays for a
 * later drain.
 */
export async function drainPendingTrigger(deps: PendingTriggerDrainDeps, serviceId: string): Promise<PendingTriggerDrainResult> {
  const claim = await claimPending(deps, serviceId);
  if (claim.kind !== 'created') {
    if (claim.kind === 'dropped') deps.logger.info({ serviceId, outcome: claim.outcome }, 'pending webhook trigger dropped');
    return claim;
  }
  const { deployment } = claim;
  let enqueued = false;
  try {
    const result = await deps.queue.enqueue({
      deploymentId: deployment.id,
      serviceId: deployment.serviceId,
      actor: { type: 'system' },
      requestedAt: deployment.createdAt,
    });
    enqueued = result.ok;
  } catch {
    enqueued = false;
  }

  if (!enqueued) {
    // H2: the slot is untouched; end the follow-up ENQUEUE_FAILED so the next drain retries it.
    let failed: unknown = undefined;
    try {
      failed = await deps.failUnqueued(deployment.id, deps.now());
    } catch {
      // Still QUEUED: the stale-QUEUED sweep ends it ENQUEUE_FAILED; the slot still holds the push.
      deps.logger.error({ deploymentId: deployment.id }, 'pending webhook follow-up enqueue failed and could not be marked failed');
    }
    // null: the row already left QUEUED, so a worker claimed it (the enqueue did land).
    enqueued = failed === null;
    if (!enqueued) {
      if (failed !== undefined) {
        try {
          await deps.db
            .update(webhookDeliveries)
            .set({ outcome: 'coalesced', deploymentId: null })
            .where(and(eq(webhookDeliveries.id, claim.deliveryRowId), eq(webhookDeliveries.deploymentId, deployment.id)));
        } catch {
          // The next drain sees the link to an ENQUEUE_FAILED deployment and retries all the same.
        }
      }
      deps.logger.warn({ serviceId, deploymentId: deployment.id }, 'pending webhook follow-up enqueue failed; the trigger is retained');
      return { kind: 'enqueue_failed', deploymentId: deployment.id };
    }
  }

  try {
    await deps.db.transaction((tx) => clearPending(tx, serviceId, claim.pendingDeliveryId));
  } catch {
    // The next drain sees the delivery linked to a live deployment and only clears the slot.
    deps.logger.warn({ serviceId, deploymentId: deployment.id }, 'pending webhook trigger could not be cleared after enqueue');
  }
  await publishServerEvent(deps.events, buildDeploymentUpdatedEvent(deployment));
  await publishServerEvent(deps.events, buildServiceUpdatedEvent(claim.service));
  deps.logger.info({ serviceId, deploymentId: deployment.id }, 'pending webhook trigger enqueued');
  return { kind: 'enqueued', deploymentId: deployment.id };
}

/** H2: the sweep path. Drains every service that holds a pending trigger and has no active deployment. */
export async function drainAllPendingTriggers(deps: PendingTriggerDrainDeps): Promise<readonly PendingTriggerDrainResult[]> {
  let candidates: { id: string }[];
  try {
    candidates = await deps.db
      .select({ id: services.id })
      .from(services)
      .where(
        and(
          isNotNull(services.pendingTriggerDeliveryId),
          notExists(
            deps.db
              .select({ one: sql`1` })
              .from(deployments)
              .where(and(eq(deployments.serviceId, services.id), inArray(deployments.status, [...NON_TERMINAL_DEPLOYMENT_STATUSES]))),
          ),
        ),
      );
  } catch (error) {
    deps.logger.error({ errorKind: error instanceof Error ? error.name : typeof error }, 'pending webhook trigger sweep could not list services');
    return [];
  }
  const results: PendingTriggerDrainResult[] = [];
  for (const candidate of candidates) {
    const result = await drainQuietly(deps, candidate.id);
    if (result !== null) results.push(result);
  }
  return results;
}

/** Never throws: a drain that fails on the database leaves the slot for the next terminal event or sweep. */
export async function drainQuietly(deps: PendingTriggerDrainDeps, serviceId: string): Promise<PendingTriggerDrainResult | null> {
  try {
    return await drainPendingTrigger(deps, serviceId);
  } catch (error) {
    deps.logger.error(
      { serviceId, errorKind: error instanceof Error ? error.name : typeof error },
      'pending webhook trigger could not be drained',
    );
    return null;
  }
}

function headerValid(value: string | undefined, pattern: RegExp): value is string {
  return value !== undefined && pattern.test(value);
}

export async function ingestGithubDelivery(deps: WebhookIngestDeps, input: WebhookDeliveryInput): Promise<WebhookIngestResult> {
  const resolved = await resolveWebhookSecret(deps, input.hookId);
  const verified = verifyGithubSignature(
    resolved === null ? DUMMY_SECRET : revealSecret(resolved.secret),
    input.rawBody,
    input.signature,
  );
  if (resolved === null || !verified) return UNAUTHORIZED;

  // H2: header checks run only after the signature, so an unsigned caller learns nothing more.
  if (!headerValid(input.deliveryId, DELIVERY_ID_PATTERN)) {
    return { kind: 'bad_request', message: 'Missing or invalid X-GitHub-Delivery header' };
  }
  if (!headerValid(input.event, EVENT_PATTERN)) {
    return { kind: 'bad_request', message: 'Missing or invalid X-GitHub-Event header' };
  }

  const recorded = await recordDelivery(deps, resolved.serviceId, {
    hookId: input.hookId,
    deliveryId: input.deliveryId,
    event: input.event,
    rawBody: input.rawBody,
  });
  if (recorded.kind === 'unauthorized') return UNAUTHORIZED;
  deps.logger.info(
    { serviceId: resolved.serviceId, outcome: recorded.outcome, duplicate: recorded.duplicate },
    'github webhook delivery recorded',
  );
  if (recorded.created !== undefined && !(await enqueueCreated(deps, recorded.created))) {
    return { kind: 'queue_unavailable' };
  }
  return {
    kind: 'recorded',
    status: recorded.status,
    outcome: recorded.outcome,
    deploymentId: recorded.deploymentId,
    duplicate: recorded.duplicate,
  };
}

export function createWebhookIngest(deps: WebhookIngestDeps): WebhookIngest {
  return { ingest: (input) => ingestGithubDelivery(deps, input) };
}
