// T-5-50 (05-12-PLAN.md threat register): the client-side second allowlist for the shared SSE
// stream. `apps/control-plane/src/events/sse-broadcaster.ts`'s `KNOWN_EVENT_TYPES` already drops
// any foreign/malformed message before it ever reaches a browser -- this file is defence in
// depth, never trusting the frame that does arrive at face value. Pure parsing/reducer helpers
// only: no `EventSource`, no I/O. `use-server-events.ts` is the only caller.
//
// The seven event names mirror the control plane's `SSE_EVENT_TYPES` exactly: the three
// `ServerEvent`s of `server-event-publisher.ts` plus the four deploy-engine events of
// `deploy-engine-events.ts` (13-08) -- never a superset, never a wildcard/prefix match (same
// T-4-36/T-5-14 discipline the server-side allowlist documents). `ServerView` is hand-copied from
// `api-client.ts` (itself hand-copied from the control plane, per that file's own documented
// rule) rather than imported across the apps/web/apps/control-plane boundary.
import {
  DEPLOYMENT_ERROR_CODES,
  DEPLOYMENT_LOG_PHASES,
  DEPLOYMENT_STATUSES,
  SERVICE_STATUSES,
  type DeploymentErrorCode,
  type DeploymentLogPhase,
  type DeploymentStatus,
} from '@noodara/domain/deployment';
import { DISCOVERY_CHECK_IDS, type DiscoveryCheck } from '@noodara/domain/discovery';
import type { ServerView } from './api-client';
import type { ServiceView } from './deploy-api';

export type ServerEventType = 'server.updated' | 'server.deleted' | 'server.discovery_progress';

export type DeployEngineEventType =
  | 'service.updated'
  | 'service.deleted'
  | 'deployment.updated'
  | 'deployment.log_chunk';

export type KnownEventType = ServerEventType | DeployEngineEventType;

export const KNOWN_EVENT_TYPES: ReadonlySet<KnownEventType> = new Set<KnownEventType>([
  'server.updated',
  'server.deleted',
  'server.discovery_progress',
  'service.updated',
  'service.deleted',
  'deployment.updated',
  'deployment.log_chunk',
]);

/** Accepts exactly the seven allowlisted strings; rejects anything else, including a near-miss
 *  type string and an empty string -- never a prefix/wildcard match. */
export function isKnownEventType(value: string): value is KnownEventType {
  return KNOWN_EVENT_TYPES.has(value as KnownEventType);
}

export interface ServerUpdatedEvent {
  readonly type: 'server.updated';
  readonly server: ServerView;
}

export interface ServerDeletedEvent {
  readonly type: 'server.deleted';
  readonly id: string;
}

export interface ServerDiscoveryProgressEvent {
  readonly type: 'server.discovery_progress';
  readonly serverId: string;
  readonly check: DiscoveryCheck;
}

export type ServerEvent = ServerUpdatedEvent | ServerDeletedEvent | ServerDiscoveryProgressEvent;

export interface ServiceUpdatedEvent {
  readonly type: 'service.updated';
  readonly service: ServiceView;
}

export interface ServiceDeletedEvent {
  readonly type: 'service.deleted';
  readonly id: string;
}

/** The control plane's allowlisted `DeploymentEventView`: never `errorMessage` nor the source. */
export interface DeploymentEventView {
  readonly id: string;
  readonly serviceId: string;
  readonly status: DeploymentStatus;
  readonly errorCode: DeploymentErrorCode | null;
  readonly updatedAt: string;
}

export interface DeploymentUpdatedEvent {
  readonly type: 'deployment.updated';
  readonly deployment: DeploymentEventView;
}

export interface DeploymentLogChunkEvent {
  readonly type: 'deployment.log_chunk';
  readonly deploymentId: string;
  readonly phase: DeploymentLogPhase;
  readonly seq: number;
  readonly text: string;
  readonly truncated: boolean;
}

/** The deploy-engine events that change a service or deployment list (everything but logs). */
export type DeployEntityEvent = ServiceUpdatedEvent | ServiceDeletedEvent | DeploymentUpdatedEvent;

export type DeployEngineEvent = DeployEntityEvent | DeploymentLogChunkEvent;

export type StreamEvent = ServerEvent | DeployEngineEvent;

export function isServerEvent(event: StreamEvent): event is ServerEvent {
  return event.type.startsWith('server.');
}

export type ParseServerEventFrameResult =
  | { readonly ok: true; readonly event: StreamEvent }
  | { readonly ok: false };

const REJECTED: ParseServerEventFrameResult = { ok: false };

const KNOWN_CHECK_IDS: ReadonlySet<string> = new Set(DISCOVERY_CHECK_IDS);
const SERVICE_STATUS_SET: ReadonlySet<string> = new Set(SERVICE_STATUSES);
const DEPLOYMENT_STATUS_SET: ReadonlySet<string> = new Set(DEPLOYMENT_STATUSES);
const DEPLOYMENT_ERROR_CODE_SET: ReadonlySet<string> = new Set(DEPLOYMENT_ERROR_CODES);
const LOG_PHASE_SET: ReadonlySet<string> = new Set(DEPLOYMENT_LOG_PHASES);
/** Same id rule as the control plane's `DEPLOYMENT_ID_PATTERN`. */
const ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;
/** The control plane caps chunk text at 64 KiB of UTF-8; a UTF-16 length is never larger. */
const MAX_LOG_CHUNK_TEXT_LENGTH = 64 * 1024;

function isId(value: unknown): value is string {
  return typeof value === 'string' && ID_PATTERN.test(value);
}

/** An ISO-8601 instant `Date.parse` understands; the stores order writes by it (13-08 H1). */
export function isValidUpdatedAt(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && Number.isFinite(Date.parse(value));
}

function parseServiceView(value: unknown): ServiceView | null {
  if (!isRecord(value)) return null;
  if (!isId(value.id) || typeof value.name !== 'string') return null;
  if (typeof value.status !== 'string' || !SERVICE_STATUS_SET.has(value.status)) return null;
  if (!isValidUpdatedAt(value.updatedAt)) return null;
  return value as unknown as ServiceView;
}

function parseDeploymentEventView(value: unknown): DeploymentEventView | null {
  if (!isRecord(value)) return null;
  if (!isId(value.id) || !isId(value.serviceId)) return null;
  if (typeof value.status !== 'string' || !DEPLOYMENT_STATUS_SET.has(value.status)) return null;
  const errorCode = value.errorCode;
  if (errorCode !== null && (typeof errorCode !== 'string' || !DEPLOYMENT_ERROR_CODE_SET.has(errorCode))) {
    return null;
  }
  if (!isValidUpdatedAt(value.updatedAt)) return null;
  return {
    id: value.id,
    serviceId: value.serviceId,
    status: value.status as DeploymentStatus,
    errorCode: errorCode as DeploymentErrorCode | null,
    updatedAt: value.updatedAt,
  };
}

function parseLogChunk(value: Record<string, unknown>): DeploymentLogChunkEvent | null {
  const { deploymentId, phase, seq, text, truncated } = value;
  if (!isId(deploymentId)) return null;
  if (typeof phase !== 'string' || !LOG_PHASE_SET.has(phase)) return null;
  if (typeof seq !== 'number' || !Number.isSafeInteger(seq) || seq < 0) return null;
  if (typeof text !== 'string' || text.length > MAX_LOG_CHUNK_TEXT_LENGTH) return null;
  if (typeof truncated !== 'boolean') return null;
  return {
    type: 'deployment.log_chunk',
    deploymentId,
    phase: phase as DeploymentLogPhase,
    seq,
    text,
    truncated,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

/** The UI never renders a check it cannot place in one of the six fixed discovery steps -- a
 *  `check.id` outside `DISCOVERY_CHECK_IDS` (or a structurally incomplete check) is rejected
 *  rather than rendered as an unknown step. */
function isValidDiscoveryCheck(value: unknown): value is DiscoveryCheck {
  if (!isRecord(value)) return false;
  return (
    typeof value.id === 'string' &&
    KNOWN_CHECK_IDS.has(value.id) &&
    typeof value.status === 'string' &&
    typeof value.detail === 'string' &&
    typeof value.durationMs === 'number'
  );
}

/**
 * Decodes one SSE frame. `listenerType` is the event name the browser's own
 * `addEventListener(type, ...)` fired under; `rawData` is the frame's `data:` payload. Both the
 * listener's event name and the payload's own `type` field must agree -- a payload whose `type`
 * disagrees with the listener it arrived under is rejected rather than trusted, and malformed
 * JSON returns a rejection result instead of throwing, so one bad frame can never break the
 * stream for every other subscriber sharing this hook.
 */
export function parseServerEventFrame(listenerType: string, rawData: string): ParseServerEventFrameResult {
  if (!isKnownEventType(listenerType)) return REJECTED;

  let parsed: unknown;
  try {
    parsed = JSON.parse(rawData);
  } catch {
    return REJECTED;
  }

  if (!isRecord(parsed) || parsed.type !== listenerType) return REJECTED;

  switch (listenerType) {
    case 'server.updated': {
      if (!isRecord(parsed.server)) return REJECTED;
      return { ok: true, event: { type: 'server.updated', server: parsed.server as unknown as ServerView } };
    }
    case 'server.deleted': {
      if (typeof parsed.id !== 'string' || parsed.id.length === 0) return REJECTED;
      return { ok: true, event: { type: 'server.deleted', id: parsed.id } };
    }
    case 'server.discovery_progress': {
      if (typeof parsed.serverId !== 'string' || parsed.serverId.length === 0) return REJECTED;
      if (!isValidDiscoveryCheck(parsed.check)) return REJECTED;
      return {
        ok: true,
        event: { type: 'server.discovery_progress', serverId: parsed.serverId, check: parsed.check },
      };
    }
    case 'service.updated': {
      const service = parseServiceView(parsed.service);
      return service === null ? REJECTED : { ok: true, event: { type: 'service.updated', service } };
    }
    case 'service.deleted': {
      if (!isId(parsed.id)) return REJECTED;
      return { ok: true, event: { type: 'service.deleted', id: parsed.id } };
    }
    case 'deployment.updated': {
      const deployment = parseDeploymentEventView(parsed.deployment);
      return deployment === null ? REJECTED : { ok: true, event: { type: 'deployment.updated', deployment } };
    }
    case 'deployment.log_chunk': {
      const chunk = parseLogChunk(parsed);
      return chunk === null ? REJECTED : { ok: true, event: chunk };
    }
    default: {
      return REJECTED;
    }
  }
}
