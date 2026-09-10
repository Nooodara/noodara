// Server connection state machine (SERV-05). The single, exhaustively tested authority for
// Server status changes: no caller may assign `status` directly, every transition — valid or
// invalid — is asserted in server-state.test.ts, and the three decision-gated edges (D-13, D-14,
// D-15) demand an explicit reason instead of a free-form status write.

/** The six states a Server can be in. Order is documentation-only; nothing depends on it. */
export const SERVER_STATUSES = [
  'PENDING',
  'CONNECTING',
  'CONNECTED',
  'DISCONNECTED',
  'UNREACHABLE',
  'ERROR',
] as const;

export type ServerStatus = (typeof SERVER_STATUSES)[number];

/**
 * Reasons required for the three edges the user locked in D-13/D-14/D-15. A reason is only
 * meaningful paired with its one gated edge; `transition()` rejects any other pairing.
 */
export type TransitionReason = 'identity_changed' | 'fingerprint_trusted' | 'clean_close';

export interface TransitionOptions {
  reason?: TransitionReason;
}

/**
 * Allowed edges, source of truth mirrored in docs/domain/server-state-transitions.md and in the
 * noodara-domain-model skill §2.1 (D-16). No state is terminal: every state can reach CONNECTING.
 */
const TRANSITIONS: Readonly<Record<ServerStatus, readonly ServerStatus[]>> = Object.freeze({
  PENDING: ['CONNECTING'],
  CONNECTING: ['CONNECTED', 'UNREACHABLE', 'ERROR'],
  CONNECTED: ['CONNECTING', 'DISCONNECTED', 'UNREACHABLE', 'ERROR', 'PENDING'],
  DISCONNECTED: ['CONNECTING'],
  UNREACHABLE: ['CONNECTING'],
  ERROR: ['CONNECTING', 'PENDING'],
} satisfies Record<ServerStatus, readonly ServerStatus[]>);

type TransitionEdge = `${ServerStatus}->${ServerStatus}`;

/**
 * The three edges that cannot happen silently:
 * - CONNECTED -> PENDING requires `identity_changed` (D-14: host/port edit changes identity).
 * - ERROR -> PENDING requires `fingerprint_trusted` (D-15: explicit "Trust new fingerprint").
 * - CONNECTED -> DISCONNECTED requires `clean_close` (D-13: only the system closes cleanly,
 *   there is no admin "Disconnect" action in v0.1).
 */
const REASON_REQUIRED: Readonly<Partial<Record<TransitionEdge, TransitionReason>>> = Object.freeze({
  'CONNECTED->PENDING': 'identity_changed',
  'ERROR->PENDING': 'fingerprint_trusted',
  'CONNECTED->DISCONNECTED': 'clean_close',
});

export class InvalidTransitionError extends Error {
  readonly from: ServerStatus;
  readonly to: ServerStatus;

  constructor(from: ServerStatus, to: ServerStatus) {
    super(`Invalid transition: ${from} -> ${to}`);
    this.name = 'InvalidTransitionError';
    this.from = from;
    this.to = to;
  }
}

export class MissingTransitionReasonError extends Error {
  readonly from: ServerStatus;
  readonly to: ServerStatus;
  readonly requiredReason: TransitionReason;

  constructor(from: ServerStatus, to: ServerStatus, requiredReason: TransitionReason) {
    super(`Transition ${from} -> ${to} requires reason '${requiredReason}'`);
    this.name = 'MissingTransitionReasonError';
    this.from = from;
    this.to = to;
    this.requiredReason = requiredReason;
  }
}

/** True for exactly the edges listed in `TRANSITIONS`; false for every other ordered pair, */
export function canTransition(from: ServerStatus, to: ServerStatus): boolean {
  return TRANSITIONS[from].includes(to);
}

/**
 * The only function allowed to produce a new Server status. Throws `InvalidTransitionError` for
 * any pair not in the transition table, and `MissingTransitionReasonError` when a reason-gated
 * edge is attempted without its exact required reason.
 */
export function transition(
  from: ServerStatus,
  to: ServerStatus,
  options: TransitionOptions = {},
): ServerStatus {
  if (!canTransition(from, to)) {
    throw new InvalidTransitionError(from, to);
  }

  const requiredReason = REASON_REQUIRED[`${from}->${to}`];
  if (requiredReason !== undefined && options.reason !== requiredReason) {
    throw new MissingTransitionReasonError(from, to, requiredReason);
  }

  return to;
}
