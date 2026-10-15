// Deployment state machine (DEP-01, ADR 0010 A4). The single, exhaustively tested authority for
// Deployment status changes: every one of the 100 ordered pairs, for every trigger, is asserted
// in deployment-state.test.ts (gate coverage-state-machine: 100%). Deployments are append-only
// attempts (a redeploy or a manual rollback is a new row), so the graph has no cycles and the
// four terminal states have no outgoing edges. The one trigger-gated edge is
// PREPARING -> DEPLOYING: a manual rollback row skips BUILDING and reuses the known image.
// v0.3 values reach Postgres additively via `ALTER TYPE ... ADD VALUE` (migration 0011).

/** The ten roadmap states (§8.2), in roadmap order. The DB enum is derived from this tuple. */
export const DEPLOYMENT_STATUSES = Object.freeze([
  'QUEUED',
  'PREPARING',
  'BUILDING',
  'DEPLOYING',
  'HEALTHCHECK',
  'SUCCESS',
  'FAILED',
  'ROLLING_BACK',
  'ROLLED_BACK',
  'CANCELLED',
] as const);

export type DeploymentStatus = (typeof DEPLOYMENT_STATUSES)[number];

/** States of an in-flight deployment; the partial unique index (one active per service) uses this. */
export const NON_TERMINAL_DEPLOYMENT_STATUSES = Object.freeze([
  'QUEUED',
  'PREPARING',
  'BUILDING',
  'DEPLOYING',
  'HEALTHCHECK',
  'ROLLING_BACK',
] as const satisfies readonly DeploymentStatus[]);

/** ROLLED_BACK ends the failed attempt itself after an automatic restore (decision #15). */
export const TERMINAL_DEPLOYMENT_STATUSES = Object.freeze([
  'SUCCESS',
  'FAILED',
  'ROLLED_BACK',
  'CANCELLED',
] as const satisfies readonly DeploymentStatus[]);

export const DEPLOYMENT_TRIGGERS = Object.freeze([
  'manual',
  'redeploy',
  'webhook',
  'rollback',
] as const);

export type DeploymentTrigger = (typeof DEPLOYMENT_TRIGGERS)[number];

export const DEPLOYMENT_LOG_PHASES = Object.freeze([
  'prepare',
  'build',
  'deploy',
  'healthcheck',
  'rollback',
] as const);

export type DeploymentLogPhase = (typeof DEPLOYMENT_LOG_PHASES)[number];

const TRANSITIONS: Readonly<Record<DeploymentStatus, readonly DeploymentStatus[]>> = Object.freeze({
  // 14-08: QUEUED -> FAILED only for ENQUEUE_FAILED (the job never reached the queue).
  QUEUED: ['PREPARING', 'FAILED', 'CANCELLED'],
  PREPARING: ['BUILDING', 'FAILED', 'CANCELLED'],
  BUILDING: ['DEPLOYING', 'FAILED', 'CANCELLED'],
  // No DEPLOYING -> SUCCESS: every success passes HEALTHCHECK. Cancel is honoured only after the
  // swap section; ROLLING_BACK restores `-prev` when the new container never became healthy.
  DEPLOYING: ['HEALTHCHECK', 'ROLLING_BACK', 'FAILED', 'CANCELLED'],
  HEALTHCHECK: ['SUCCESS', 'ROLLING_BACK', 'FAILED', 'CANCELLED'],
  // Not cancellable: a half restore can leave no running version (409 ROLLBACK_IN_PROGRESS).
  ROLLING_BACK: ['ROLLED_BACK', 'FAILED'],
  SUCCESS: [],
  FAILED: [],
  ROLLED_BACK: [],
  CANCELLED: [],
} satisfies Record<DeploymentStatus, readonly DeploymentStatus[]>);

/** Edges allowed only for one trigger (ADR 0010 A4). */
const TRIGGER_GATED: Readonly<
  Partial<Record<DeploymentStatus, Partial<Record<DeploymentStatus, DeploymentTrigger>>>>
> = Object.freeze({
  PREPARING: Object.freeze({ DEPLOYING: 'rollback' }),
});

export class InvalidDeploymentTransitionError extends Error {
  readonly from: DeploymentStatus;
  readonly to: DeploymentStatus;

  constructor(from: DeploymentStatus, to: DeploymentStatus) {
    super(`Invalid deployment transition: ${from} -> ${to}`);
    this.name = 'InvalidDeploymentTransitionError';
    this.from = from;
    this.to = to;
  }
}

/**
 * True for exactly the edges listed in `TRANSITIONS`, plus a trigger-gated edge when `trigger`
 * is the one it is gated on; false for every other ordered pair.
 */
export function canTransitionDeployment(
  from: DeploymentStatus,
  to: DeploymentStatus,
  trigger?: DeploymentTrigger,
): boolean {
  if (TRANSITIONS[from].includes(to)) return true;
  const gate = TRIGGER_GATED[from]?.[to];
  return gate !== undefined && gate === trigger;
}

/** The only function allowed to produce a new Deployment status. */
export function transitionDeployment(
  from: DeploymentStatus,
  to: DeploymentStatus,
  trigger?: DeploymentTrigger,
): DeploymentStatus {
  if (!canTransitionDeployment(from, to, trigger)) {
    throw new InvalidDeploymentTransitionError(from, to);
  }
  return to;
}

export type DeploymentTransitionResult =
  | { readonly kind: 'transitioned'; readonly from: DeploymentStatus; readonly to: DeploymentStatus }
  | { readonly kind: 'already-applied'; readonly status: DeploymentStatus };

/**
 * Applies `edge` to a row whose status is `current`. When the row already sits on `edge.to`
 * through that same valid edge (a retried write), the result is `already-applied`, never a new
 * transition. Anything else is an invalid transition from `current`.
 */
export function applyDeploymentTransition(
  current: DeploymentStatus,
  edge: { readonly from: DeploymentStatus; readonly to: DeploymentStatus },
  trigger?: DeploymentTrigger,
): DeploymentTransitionResult {
  if (current === edge.to && current !== edge.from) {
    transitionDeployment(edge.from, edge.to, trigger);
    return { kind: 'already-applied', status: current };
  }
  if (current !== edge.from) throw new InvalidDeploymentTransitionError(current, edge.to);
  const to = transitionDeployment(current, edge.to, trigger);
  return { kind: 'transitioned', from: current, to };
}

export function isTerminalDeploymentStatus(status: DeploymentStatus): boolean {
  return TRANSITIONS[status].length === 0;
}

export type DeploymentCancelRejection = 'ROLLBACK_IN_PROGRESS' | 'DEPLOYMENT_NOT_CANCELLABLE';

/** Why a cancel request is refused (both map to 409), or null when the row can be cancelled. */
export function deploymentCancelRejection(
  status: DeploymentStatus,
): DeploymentCancelRejection | null {
  if (canTransitionDeployment(status, 'CANCELLED')) return null;
  return status === 'ROLLING_BACK' ? 'ROLLBACK_IN_PROGRESS' : 'DEPLOYMENT_NOT_CANCELLABLE';
}
