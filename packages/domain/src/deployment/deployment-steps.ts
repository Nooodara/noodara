// 13-03: the deployment step timeline (clone|pull, build, start, verify). Pure and total: every
// status x source x error code x timestamp combination yields exactly four steps in fixed order.
// Step *states* come from the status (plus, once terminal, which boundary the attempt reached);
// timestamps only add times. So a terminal deployment never shows a running step, and a row from
// before the step columns existed (all boundaries null) still gets a valid timeline.
import { canTransitionDeployment, type DeploymentStatus } from './deployment-state.js';
import type { DeploymentErrorCode } from './deployment-error.js';

export const DEPLOYMENT_STEP_NAMES = Object.freeze(['clone', 'pull', 'build', 'start', 'verify'] as const);
export type DeploymentStepName = (typeof DEPLOYMENT_STEP_NAMES)[number];

export const DEPLOYMENT_STEP_STATES = Object.freeze([
  'pending',
  'running',
  'success',
  'failed',
  'cancelled',
  'skipped',
] as const);
export type DeploymentStepState = (typeof DEPLOYMENT_STEP_STATES)[number];

export type DeploymentSourceType = 'git' | 'image';

/** The step boundaries stored on a deployment row besides startedAt/completedAt. */
export const DEPLOYMENT_STEP_BOUNDARIES = Object.freeze([
  'buildingStartedAt',
  'deployingStartedAt',
  'verifyingStartedAt',
] as const);
export type DeploymentStepBoundary = (typeof DEPLOYMENT_STEP_BOUNDARIES)[number];

export interface DeploymentStepsInput {
  readonly status: DeploymentStatus;
  readonly sourceType: DeploymentSourceType;
  readonly errorCode: DeploymentErrorCode | null;
  readonly startedAt: Date | null;
  readonly buildingStartedAt: Date | null;
  readonly deployingStartedAt: Date | null;
  readonly verifyingStartedAt: Date | null;
  readonly completedAt: Date | null;
}

export interface DeploymentStep {
  readonly name: DeploymentStepName;
  readonly state: DeploymentStepState;
  readonly startedAt: Date | null;
  readonly completedAt: Date | null;
  /** Null unless both ends are known; never negative (a skewed clock reads as 0). */
  readonly durationMs: number | null;
}

/**
 * The boundary column a status edge writes in the same UPDATE as the status. QUEUED -> PREPARING
 * writes `startedAt` and terminal edges write `completedAt`, as before 13-03; other edges none.
 */
export function stepBoundaryOfTransition(from: DeploymentStatus, to: DeploymentStatus): DeploymentStepBoundary | null {
  if (!canTransitionDeployment(from, to)) return null;
  if (to === 'BUILDING') return 'buildingStartedAt';
  if (to === 'DEPLOYING') return 'deployingStartedAt';
  return null;
}

/** The start -> verify boundary is not a status edge; it may be written only while DEPLOYING. */
export function canEnterVerifyStep(status: DeploymentStatus): boolean {
  return status === 'DEPLOYING';
}

const STEP_COUNT = 4;
const DONE = STEP_COUNT;
const NONE = -1;

// Where a failure with this code happened, for rows without step boundaries (pre-13-03 rows, or
// an attempt that failed before its first boundary). Codes not listed fall back to the first step.
const GIT_FAILURE_STEP: Partial<Record<DeploymentErrorCode, number>> = {
  REPOSITORY_AUTH_FAILED: 0,
  REPOSITORY_NOT_FOUND: 0,
  BRANCH_NOT_FOUND: 0,
  REPOSITORY_HOST_UNREACHABLE: 0,
  GIT_HOST_KEY_MISMATCH: 0,
  GIT_HOST_KEY_UNAVAILABLE: 0,
  UNSUPPORTED_REPOSITORY_FEATURE: 0,
  CLONE_FAILED: 0,
  DOCKERFILE_NOT_FOUND: 1,
  BUILDKIT_UNAVAILABLE: 1,
  BUILD_FAILED: 1,
  BUILD_TIMEOUT: 1,
  BUILD_STALLED: 1,
  PORT_IN_USE: 2,
  START_FAILED: 3,
};

const IMAGE_FAILURE_STEP: Partial<Record<DeploymentErrorCode, number>> = {
  REGISTRY_AUTH_FAILED: 0,
  IMAGE_NOT_FOUND: 0,
  IMAGE_PULL_FAILED: 0,
  PORT_IN_USE: 2,
  START_FAILED: 3,
};

function validDate(value: Date | null): Date | null {
  return value !== null && Number.isFinite(value.getTime()) ? value : null;
}

/** Start boundary of each step; an image source has no build step. */
function stepStarts(input: DeploymentStepsInput): readonly (Date | null)[] {
  return [
    validDate(input.startedAt),
    input.sourceType === 'git' ? validDate(input.buildingStartedAt) : null,
    validDate(input.deployingStartedAt),
    validDate(input.verifyingStartedAt),
  ];
}

/** Index of the step the attempt was in: NONE before the claim, DONE once everything succeeded. */
function reachedStep(input: DeploymentStepsInput): number {
  const git = input.sourceType === 'git';
  switch (input.status) {
    case 'QUEUED':
      return NONE;
    case 'PREPARING':
      return 0;
    case 'BUILDING':
      // An image source pulls while BUILDING.
      return git ? 1 : 0;
    case 'DEPLOYING':
      return validDate(input.verifyingStartedAt) !== null ? 3 : 2;
    case 'SUCCESS':
      return DONE;
    case 'FAILED':
    case 'CANCELLED':
      return terminalReachedStep(input);
  }
}

function terminalReachedStep(input: DeploymentStepsInput): number {
  const git = input.sourceType === 'git';
  if (validDate(input.verifyingStartedAt) !== null) return 3;
  if (validDate(input.deployingStartedAt) !== null) return 2;
  if (validDate(input.buildingStartedAt) !== null) return git ? 1 : 0;
  if (input.errorCode !== null) {
    const mapped = (git ? GIT_FAILURE_STEP : IMAGE_FAILURE_STEP)[input.errorCode];
    if (mapped !== undefined) return mapped;
  }
  return validDate(input.startedAt) !== null ? 0 : NONE;
}

function durationOf(startedAt: Date | null, completedAt: Date | null): number | null {
  if (startedAt === null || completedAt === null) return null;
  return Math.max(0, completedAt.getTime() - startedAt.getTime());
}

function step(name: DeploymentStepName, state: DeploymentStepState, startedAt: Date | null, completedAt: Date | null): DeploymentStep {
  return { name, state, startedAt, completedAt, durationMs: durationOf(startedAt, completedAt) };
}

/** The four-step timeline of a deployment. Never throws. */
export function deriveDeploymentSteps(input: DeploymentStepsInput): DeploymentStep[] {
  const git = input.sourceType === 'git';
  const names: readonly DeploymentStepName[] = [git ? 'clone' : 'pull', 'build', 'start', 'verify'];
  const starts = stepStarts(input);
  const completedAt = validDate(input.completedAt);
  const reached = reachedStep(input);
  const terminalState: DeploymentStepState =
    input.status === 'FAILED' ? 'failed' : input.status === 'CANCELLED' ? 'cancelled' : 'running';

  // A step ends where the next step that runs begins; the last one ends with the deployment.
  const endOf = (index: number): Date | null => {
    for (let next = index + 1; next < STEP_COUNT; next += 1) {
      if (git || next !== 1) return starts[next] ?? null;
    }
    return completedAt;
  };

  return names.map((name, index) => {
    if (!git && index === 1) return step(name, 'skipped', null, null);
    const startedAt = starts[index] ?? null;
    if (index < reached) return step(name, 'success', startedAt, endOf(index));
    if (index > reached) return step(name, 'pending', null, null);
    return terminalState === 'running'
      ? step(name, 'running', startedAt, null)
      : step(name, terminalState, startedAt, completedAt);
  });
}
