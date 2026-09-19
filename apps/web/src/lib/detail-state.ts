// Pure derivation of the server detail screen's own state and single primary action
// (DETL-01/DETL-02, 05-UI-SPEC.md SS2.5, 02-CONTEXT.md D-11, 05-CONTEXT.md D-10..D-12). Branches
// only on `status`, `lastErrorCode` and `hostname` -- never on an individual fact field (CPU
// cores, RAM, disk, uptime, ...) -- because the backend's `mergeDiscoveryFacts` guarantee
// (05-RESEARCH.md Pitfall 4) means a known fact is never overwritten with `null`: once `hostname`
// is non-null the rest of a good discovery's facts are trustworthy too, so this module never
// needs a second, per-field null check to decide what the screen shows.
import type { ServerStatus } from '@noodara/domain/server';
import type { ServerView } from './api-client';

export type DetailState = 'never-discovered' | 'failed-no-history' | 'failed-with-history' | 'discovered' | 'host-key-changed';

export type DetailStateServer = Pick<ServerView, 'hostname' | 'lastErrorCode'>;

/**
 * Which of the five detail-screen states `server` is in.
 *
 * `HOST_KEY_CHANGED` wins over the generic failed-* states even though it is itself a
 * `lastErrorCode` value, so the dedicated D-03 banner (a later plan) always renders instead of
 * the generic DETL-02 banner for that one code.
 *
 * `UNSUPPORTED_OS` is deliberately excluded from the "lastErrorCode is set -> failed" rule:
 * `packages/domain/src/server/connection-result.ts`'s `statusForErrorCode('UNSUPPORTED_OS')`
 * lands the server on `CONNECTED` (the connection and discovery both actually succeeded), with
 * the code recorded in `lastErrorCode` purely as a warning (05-UI-SPEC.md SS5.1: "Not an error
 * banner -- inline warning note under the OS line"). Treating it as a blocking error here would
 * show the generic failure banner over a server that is, in truth, healthy -- a real bug the
 * plan's own literal Task 1 behaviour text did not call out, caught while implementing this
 * function against 05-UI-SPEC.md SS5.1's own table.
 */
export function deriveDetailState(server: DetailStateServer): DetailState {
  if (server.lastErrorCode === 'HOST_KEY_CHANGED') {
    return 'host-key-changed';
  }

  const isBlockingError = server.lastErrorCode !== null && server.lastErrorCode !== 'UNSUPPORTED_OS';
  if (isBlockingError) {
    return server.hostname === null ? 'failed-no-history' : 'failed-with-history';
  }

  return server.hostname === null ? 'never-discovered' : 'discovered';
}

export interface PrimaryAction {
  readonly label: string;
  readonly endpoint: '/connect' | '/discover';
  readonly disabled: boolean;
}

export type PrimaryActionServer = Pick<ServerView, 'status' | 'lastErrorCode'>;

function connectAction(disabled: boolean): PrimaryAction {
  return { label: 'Connect', endpoint: '/connect', disabled };
}

function retryAction(): PrimaryAction {
  return { label: 'Retry', endpoint: '/connect', disabled: false };
}

/**
 * The single toolbar action for `server`, or `null` when the toolbar carries no action at all.
 *
 * `ERROR` with `lastErrorCode === 'HOST_KEY_CHANGED'` is the one status/code pair with no toolbar
 * action -- that action lives in the dedicated error banner instead (a later plan), since it
 * needs the type-the-name confirm dialog, not a bare click (05-UI-SPEC.md SS2.5's own table).
 *
 * `DISCONNECTED` is not named in 05-UI-SPEC.md SS2.5's per-status table at all, but this map is
 * declared `satisfies Record<ServerStatus, ...>` so a new/omitted domain status is a compile
 * error, not a silent gap -- `DISCONNECTED`'s only domain transition is `DISCONNECTED ->
 * CONNECTING` (packages/domain/src/server/server-state.ts's TRANSITIONS), the identical single
 * edge `PENDING` has, so it gets `PENDING`'s own un-disabled "Connect" action.
 */
export function derivePrimaryAction(server: PrimaryActionServer): PrimaryAction | null {
  const { status, lastErrorCode } = server;

  const ACTIONS = {
    PENDING: connectAction(false),
    CONNECTING: connectAction(true),
    CONNECTED: { label: 'Re-run discovery', endpoint: '/discover', disabled: false },
    DISCONNECTED: connectAction(false),
    UNREACHABLE: retryAction(),
    ERROR: lastErrorCode === 'HOST_KEY_CHANGED' ? null : retryAction(),
  } satisfies Record<ServerStatus, PrimaryAction | null>;

  return ACTIONS[status];
}
