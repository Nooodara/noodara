// 12-05 (D22): the deploy engine's SSE events. Exactly four types join the server events on the
// same global stream and Redis channel: `service.updated`, `service.deleted`,
// `deployment.updated` and `deployment.log_chunk`. There is deliberately no `project.*` or
// `environment.*` event: clients refetch those after their own mutations.
//
// `service.updated` / `deployment.updated` carry the caller's allowlisted view (12-08's
// `ServiceView`, the deployment read view); the interfaces below are the minimum each view must
// expose, never a raw row. `deployment.log_chunk` is bounded: it can only be built through
// `buildDeploymentLogChunkEvent` (branded type), which caps `text` at
// `MAX_LOG_CHUNK_EVENT_TEXT_BYTES`, and the broadcaster re-checks shape and size before fan-out.
import {
  DEPLOYMENT_LOG_PHASES,
  type DeploymentErrorCode,
  type DeploymentLogPhase,
  type DeploymentStatus,
  type ServiceStatus,
} from '@noodara/domain/deployment';

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
}

export interface DeploymentEventView {
  readonly id: string;
  readonly serviceId: string;
  readonly status: DeploymentStatus;
  readonly errorCode: DeploymentErrorCode | null;
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

export type DeployEngineEvent =
  | { readonly type: 'service.updated'; readonly service: ServiceEventView }
  | { readonly type: 'service.deleted'; readonly id: string }
  | { readonly type: 'deployment.updated'; readonly deployment: DeploymentEventView }
  | DeploymentLogChunkEvent;

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
