// Deployment state machine (DEP-01, ROADMAP D4). The single, exhaustively tested authority for
// Deployment status changes: every one of the 49 ordered pairs is asserted in
// deployment-state.test.ts. Deployments are append-only attempts (a redeploy is a new row), so
// the graph has no cycles and no reason-gated edges, and the three terminal states have no
// outgoing edges. v0.3 adds HEALTHCHECK/ROLLING_BACK/ROLLED_BACK additively via
// `ALTER TYPE ... ADD VALUE` (D4); they are deliberately absent here.

/** The seven states a Deployment can be in. The DB enum is derived from this tuple. */
export const DEPLOYMENT_STATUSES = Object.freeze([
  'QUEUED',
  'PREPARING',
  'BUILDING',
  'DEPLOYING',
  'SUCCESS',
  'FAILED',
  'CANCELLED',
] as const);

export type DeploymentStatus = (typeof DEPLOYMENT_STATUSES)[number];

/** States of an in-flight deployment; the partial unique index (one active per service) uses this. */
export const NON_TERMINAL_DEPLOYMENT_STATUSES = Object.freeze([
  'QUEUED',
  'PREPARING',
  'BUILDING',
  'DEPLOYING',
] as const satisfies readonly DeploymentStatus[]);

export const TERMINAL_DEPLOYMENT_STATUSES = Object.freeze([
  'SUCCESS',
  'FAILED',
  'CANCELLED',
] as const satisfies readonly DeploymentStatus[]);

/** v0.3 adds `webhook` and `rollback` additively. */
export const DEPLOYMENT_TRIGGERS = Object.freeze(['manual', 'redeploy'] as const);

export type DeploymentTrigger = (typeof DEPLOYMENT_TRIGGERS)[number];

export const DEPLOYMENT_LOG_PHASES = Object.freeze(['prepare', 'build', 'deploy'] as const);

export type DeploymentLogPhase = (typeof DEPLOYMENT_LOG_PHASES)[number];

const TRANSITIONS: Readonly<Record<DeploymentStatus, readonly DeploymentStatus[]>> = Object.freeze({
  // 14-08: QUEUED -> FAILED only for ENQUEUE_FAILED (the job never reached the queue).
  QUEUED: ['PREPARING', 'FAILED', 'CANCELLED'],
  PREPARING: ['BUILDING', 'FAILED', 'CANCELLED'],
  BUILDING: ['DEPLOYING', 'FAILED', 'CANCELLED'],
  DEPLOYING: ['SUCCESS', 'FAILED', 'CANCELLED'],
  SUCCESS: [],
  FAILED: [],
  CANCELLED: [],
} satisfies Record<DeploymentStatus, readonly DeploymentStatus[]>);

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

/** True for exactly the edges listed in `TRANSITIONS`; false for every other ordered pair. */
export function canTransitionDeployment(from: DeploymentStatus, to: DeploymentStatus): boolean {
  return TRANSITIONS[from].includes(to);
}

/** The only function allowed to produce a new Deployment status. */
export function transitionDeployment(
  from: DeploymentStatus,
  to: DeploymentStatus,
): DeploymentStatus {
  if (!canTransitionDeployment(from, to)) {
    throw new InvalidDeploymentTransitionError(from, to);
  }
  return to;
}

export function isTerminalDeploymentStatus(status: DeploymentStatus): boolean {
  return TRANSITIONS[status].length === 0;
}
