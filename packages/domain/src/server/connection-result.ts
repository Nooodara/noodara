// Connection-result to Server-status/error-code mapping (SERV-05). Every SSH connection outcome
// phase 2 can produce lands here as exactly one status, and the mapping never assigns a status
// literal — it always routes through `transition()` from server-state.ts.

import { InvalidTransitionError, transition, type ServerStatus } from './server-state.js';

/** The seven connection error codes a phase-2 SSH attempt can report. */
export const SERVER_ERROR_CODES = [
  'AUTH_FAILED',
  'HOST_UNRESOLVED',
  'CONNECT_TIMEOUT',
  'COMMAND_TIMEOUT',
  'HOST_KEY_CHANGED',
  'CONNECTION_LOST',
  'UNSUPPORTED_OS',
] as const;

export type ServerErrorCode = (typeof SERVER_ERROR_CODES)[number];

export type ConnectionResult =
  | { ok: true; fingerprint: string }
  | { ok: false; errorCode: ServerErrorCode; observedFingerprint?: string };

/** The subset of Server fields `applyConnectionResult` owns. */
export interface ServerConnectionState {
  status: ServerStatus;
  lastErrorCode: ServerErrorCode | null;
  hostFingerprint: string | null;
  pendingFingerprint: string | null;
  lastSeenAt: Date | null;
}

/**
 * Landing status per error code. `AUTH_FAILED`/`COMMAND_TIMEOUT`/`HOST_KEY_CHANGED` are treated as
 * ERROR (something is wrong with credentials, the remote command, or host identity);
 * `HOST_UNRESOLVED`/`CONNECT_TIMEOUT`/`CONNECTION_LOST` are UNREACHABLE (network-level, may
 * resolve on retry). `UNSUPPORTED_OS` is neither: the connection and discovery both succeeded,
 * the platform is simply outside the supported matrix (Ubuntu 22.04/24.04) — D-11 lands it on
 * CONNECTED, carrying the code in `last_error_code` as a warning for the detail view, since v0.2
 * will use that warning to block deploys rather than this phase blocking the connection itself.
 */
const ERROR_CODE_STATUS = {
  AUTH_FAILED: 'ERROR',
  COMMAND_TIMEOUT: 'ERROR',
  HOST_KEY_CHANGED: 'ERROR',
  UNSUPPORTED_OS: 'CONNECTED',
  HOST_UNRESOLVED: 'UNREACHABLE',
  CONNECT_TIMEOUT: 'UNREACHABLE',
  CONNECTION_LOST: 'UNREACHABLE',
} satisfies Record<ServerErrorCode, ServerStatus>;

export function statusForErrorCode(code: ServerErrorCode): ServerStatus {
  return ERROR_CODE_STATUS[code];
}

/**
 * Applies a connection result to the current state. Only accepts results while the server is
 * CONNECTING (results only arrive while a connection attempt is in flight — any other source
 * status throws `InvalidTransitionError`, even for a target status otherwise reachable from it).
 * Returns a new object; never mutates `state`.
 */
export function applyConnectionResult(
  state: ServerConnectionState,
  result: ConnectionResult,
  now: Date,
): ServerConnectionState {
  const targetStatus: ServerStatus = result.ok ? 'CONNECTED' : statusForErrorCode(result.errorCode);

  if (state.status !== 'CONNECTING') {
    throw new InvalidTransitionError(state.status, targetStatus);
  }

  const nextStatus = transition(state.status, targetStatus);

  if (result.ok) {
    return {
      ...state,
      status: nextStatus,
      lastErrorCode: null,
      hostFingerprint: state.hostFingerprint ?? result.fingerprint,
      lastSeenAt: now,
    };
  }

  return {
    ...state,
    status: nextStatus,
    lastErrorCode: result.errorCode,
    pendingFingerprint:
      result.errorCode === 'HOST_KEY_CHANGED' && result.observedFingerprint !== undefined
        ? result.observedFingerprint
        : state.pendingFingerprint,
  };
}
