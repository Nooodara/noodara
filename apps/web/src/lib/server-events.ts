// T-5-50 (05-12-PLAN.md threat register): the client-side second allowlist for the shared SSE
// stream. `apps/control-plane/src/events/sse-broadcaster.ts`'s `KNOWN_EVENT_TYPES` already drops
// any foreign/malformed message before it ever reaches a browser -- this file is defence in
// depth, never trusting the frame that does arrive at face value. Pure parsing/reducer helpers
// only: no `EventSource`, no I/O. `use-server-events.ts` is the only caller.
//
// The three event names mirror `apps/control-plane/src/events/server-event-publisher.ts`'s
// `ServerEvent` union exactly -- never a superset, never a wildcard/prefix match (same T-4-36/
// T-5-14 discipline the server-side allowlist documents). `ServerView` is hand-copied from
// `api-client.ts` (itself hand-copied from the control plane, per that file's own documented
// rule) rather than imported across the apps/web/apps/control-plane boundary.
import { DISCOVERY_CHECK_IDS, type DiscoveryCheck } from '@noodara/domain/discovery';
import type { ServerView } from './api-client';

export type KnownEventType = 'server.updated' | 'server.deleted' | 'server.discovery_progress';

export const KNOWN_EVENT_TYPES: ReadonlySet<KnownEventType> = new Set([
  'server.updated',
  'server.deleted',
  'server.discovery_progress',
]);

/** Accepts exactly the three allowlisted strings; rejects anything else, including a near-miss
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

export type ParseServerEventFrameResult =
  | { readonly ok: true; readonly event: ServerEvent }
  | { readonly ok: false };

const REJECTED: ParseServerEventFrameResult = { ok: false };

const KNOWN_CHECK_IDS: ReadonlySet<string> = new Set(DISCOVERY_CHECK_IDS);

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
    default: {
      return REJECTED;
    }
  }
}
