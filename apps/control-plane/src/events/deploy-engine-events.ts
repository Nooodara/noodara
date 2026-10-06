// 12-05 (D22): the deploy engine's SSE events. Exactly four types join the server events on the
// same global stream and Redis channel: `service.updated`, `service.deleted`,
// `deployment.updated` and `deployment.log_chunk`. There is deliberately no `project.*` or
// `environment.*` event: clients refetch those after their own mutations.
//
// `service.updated` / `deployment.updated` carry an allowlisted view built only through
// `buildServiceUpdatedEvent` / `buildDeploymentUpdatedEvent` (12-08's `ServiceView` fields; the
// deployment's id, serviceId, status, errorCode), never a raw row and never `errorMessage`. Both
// carry `updatedAt` (13-02): the row's `updated_at` written with the change they announce, strictly
// increasing per row, so a client keeps the newest of snapshot and event per id.
// `deployment.log_chunk` is bounded: it can only be built through `buildDeploymentLogChunkEvent`
// (branded type), which caps `text` at `MAX_LOG_CHUNK_EVENT_TEXT_BYTES`, and the broadcaster
// re-checks shape and size before fan-out.
import {
  DEPLOYMENT_LOG_PHASES,
  DEPLOYMENT_STATUSES,
  SERVICE_STATUSES,
  type DeploymentErrorCode,
  type DeploymentLogPhase,
  type DeploymentStatus,
  type ServiceStatus,
} from '@noodara/domain/deployment';
import { SERVICE_VIEW_FIELDS, type ServiceView } from '../services/service-view.js';

export const DEPLOY_ENGINE_EVENT_TYPES = Object.freeze([
  'service.updated',
  'service.deleted',
  'deployment.updated',
  'deployment.log_chunk',
] as const);

export interface ServiceEventView {
  readonly id: string;
  readonly projectId: string;
  readonly environmentId: string;
  readonly serverId: string;
  readonly status: ServiceStatus;
  /** ISO-8601; the row's `updated_at` after the write this event announces. */
  readonly updatedAt: string;
}

export interface DeploymentEventView {
  readonly id: string;
  readonly serviceId: string;
  readonly status: DeploymentStatus;
  readonly errorCode: DeploymentErrorCode | null;
  /** ISO-8601; the row's `updated_at` after the write this event announces. */
  readonly updatedAt: string;
}

declare const logChunkBrand: unique symbol;

export interface DeploymentLogChunkEvent {
  readonly type: 'deployment.log_chunk';
  readonly deploymentId: string;
  readonly phase: DeploymentLogPhase;
  readonly seq: number;
  readonly text: string;
  /** True when `text` was cut to `MAX_LOG_CHUNK_EVENT_TEXT_BYTES` here. */
  readonly truncated: boolean;
  readonly [logChunkBrand]: true;
}

declare const updatedBrand: unique symbol;

export interface ServiceUpdatedEvent {
  readonly type: 'service.updated';
  /** 12-08's allowlisted read view; it satisfies `ServiceEventView`. */
  readonly service: ServiceView & ServiceEventView;
  readonly [updatedBrand]: true;
}

export interface DeploymentUpdatedEvent {
  readonly type: 'deployment.updated';
  readonly deployment: DeploymentEventView;
  readonly [updatedBrand]: true;
}

export type DeployEngineEvent =
  | ServiceUpdatedEvent
  | { readonly type: 'service.deleted'; readonly id: string }
  | DeploymentUpdatedEvent
  | DeploymentLogChunkEvent;

const SERVICE_STATUS_SET: ReadonlySet<string> = new Set(SERVICE_STATUSES);
const DEPLOYMENT_STATUS_SET: ReadonlySet<string> = new Set(DEPLOYMENT_STATUSES);
const ISO_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

/** A canonical `Date#toISOString()` value; anything else is a programming error. */
function requireUpdatedAt(type: string, value: unknown): string {
  if (typeof value !== 'string' || !ISO_INSTANT.test(value) || new Date(value).toISOString() !== value) {
    throw new RangeError(`${type} requires the row's updatedAt as an ISO-8601 string`);
  }
  return value;
}

/**
 * The only constructor of a `service.updated` event: the view is copied field by field from
 * `SERVICE_VIEW_FIELDS` (its allowlist, in wire order), so an extra property on the input (a
 * credential id, a raw row column) never reaches the stream. `updatedAt` must be a valid ISO instant.
 */
export function buildServiceUpdatedEvent(view: ServiceView): ServiceUpdatedEvent {
  if (!SERVICE_STATUS_SET.has(view.status)) {
    throw new RangeError('service.updated requires a known status');
  }
  requireUpdatedAt('service.updated', view.updatedAt);
  const service: Record<string, unknown> = {};
  for (const field of SERVICE_VIEW_FIELDS) service[field] = view[field];
  const event = { type: 'service.updated', service: service as unknown as ServiceView } as const;
  return event as ServiceUpdatedEvent;
}

/** The only constructor of a `deployment.updated` event: id, serviceId, status, errorCode and
 *  updatedAt; never `errorMessage`, the source snapshot or anything else of the row. */
export function buildDeploymentUpdatedEvent(view: DeploymentEventView): DeploymentUpdatedEvent {
  if (!DEPLOYMENT_STATUS_SET.has(view.status)) {
    throw new RangeError('deployment.updated requires a known status');
  }
  const event = {
    type: 'deployment.updated',
    deployment: {
      id: view.id,
      serviceId: view.serviceId,
      status: view.status,
      errorCode: view.errorCode,
      updatedAt: requireUpdatedAt('deployment.updated', view.updatedAt),
    },
  } as const;
  return event as DeploymentUpdatedEvent;
}

/** 4x the 12-03 chunker's 16 KB flush size: a normal chunk is never cut here. */
export const MAX_LOG_CHUNK_EVENT_TEXT_BYTES = 64 * 1024;

/** Worst case for a serialized chunk: JSON escapes a control byte as six characters (`\u0001`),
 *  plus a fixed allowance for the envelope (type, ids, seq, `at`). Two such frames still fit well
 *  inside the route's 1 MiB backpressure budget, so one chunk can never evict a healthy client. */
export const MAX_LOG_CHUNK_EVENT_MESSAGE_BYTES = 6 * MAX_LOG_CHUNK_EVENT_TEXT_BYTES + 1024;

const DEPLOYMENT_ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;
const LOG_PHASES: ReadonlySet<string> = new Set(DEPLOYMENT_LOG_PHASES);


export interface DeploymentLogChunkInput {
  readonly deploymentId: string;
  readonly phase: DeploymentLogPhase;
  readonly seq: number;
  readonly text: string;
}

function isValidSeq(seq: unknown): seq is number {
  return typeof seq === 'number' && Number.isSafeInteger(seq) && seq >= 0;
}

/** Cuts `text` to at most `maxBytes` UTF-8 bytes on a code point boundary. */
function truncateUtf8(text: string, maxBytes: number): string {
  const bytes = Buffer.from(text, 'utf8');
  let end = maxBytes;
  // Step back over continuation bytes (10xxxxxx) so the cut never lands inside a character.
  while (end > 0 && ((bytes[end] ?? 0) & 0xc0) === 0x80) {
    end -= 1;
  }
  return bytes.subarray(0, end).toString('utf8');
}

/**
 * The only constructor of a `deployment.log_chunk` event. Invalid ids, phases or sequence numbers
 * are programming errors (`RangeError`); oversized text is cut, never rejected, so a log burst can
 * never fail a deployment.
 */
export function buildDeploymentLogChunkEvent(input: DeploymentLogChunkInput): DeploymentLogChunkEvent {
  if (!DEPLOYMENT_ID_PATTERN.test(input.deploymentId)) {
    throw new RangeError('deployment.log_chunk requires a valid deploymentId');
  }
  if (!LOG_PHASES.has(input.phase)) {
    throw new RangeError('deployment.log_chunk requires a known phase');
  }
  if (!isValidSeq(input.seq)) {
    throw new RangeError('deployment.log_chunk requires a non-negative integer seq');
  }

  const fits = Buffer.byteLength(input.text, 'utf8') <= MAX_LOG_CHUNK_EVENT_TEXT_BYTES;
  const event = {
    type: 'deployment.log_chunk',
    deploymentId: input.deploymentId,
    phase: input.phase,
    seq: input.seq,
    text: fits ? input.text : truncateUtf8(input.text, MAX_LOG_CHUNK_EVENT_TEXT_BYTES),
    truncated: !fits,
  } as const;
  return event as DeploymentLogChunkEvent;
}

/**
 * The broadcaster's check before fanning out a `deployment.log_chunk` read from Redis: the raw
 * message is within `MAX_LOG_CHUNK_EVENT_MESSAGE_BYTES` and carries a valid `deploymentId`,
 * `phase`, `seq` and bounded `text`. Anything else (a foreign or buggy publisher) is dropped.
 */
export function isWellFormedLogChunkMessage(parsed: unknown, messageBytes: number): boolean {
  if (messageBytes > MAX_LOG_CHUNK_EVENT_MESSAGE_BYTES) return false;
  if (typeof parsed !== 'object' || parsed === null) return false;
  const candidate = parsed as Record<string, unknown>;
  return (
    typeof candidate.deploymentId === 'string' &&
    DEPLOYMENT_ID_PATTERN.test(candidate.deploymentId) &&
    typeof candidate.phase === 'string' &&
    LOG_PHASES.has(candidate.phase) &&
    isValidSeq(candidate.seq) &&
    typeof candidate.text === 'string' &&
    Buffer.byteLength(candidate.text, 'utf8') <= MAX_LOG_CHUNK_EVENT_TEXT_BYTES
  );
}
