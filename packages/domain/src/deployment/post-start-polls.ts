// Post-start `docker inspect` polls (ROADMAP D3; SUMMARY default: 5 polls, 1 s -> 8 s backoff).
// Right after `docker start` the deploy job polls the container state to end the deployment
// SUCCESS or START_FAILED without waiting for the reconcile tick. SUCCESS needs `stablePolls`
// consecutive `running` observations with the same StartedAt (a restart in between resets it),
// so a crash loop under a restart policy is not mistaken for a healthy start. Exited, dead,
// removing or missing fail at once; created, paused, restarting and an unparseable inspect keep
// polling until the budget runs out (`not_stable`). Pure: the caller owns the timers.

import { fail, ok, type ValidationResult } from '../validators/network.js';
import type { ContainerStateResult } from './container-state.js';

export interface PostStartPollPolicy {
  readonly maxPolls: number;
  readonly initialDelayMs: number;
  readonly maxDelayMs: number;
  readonly stablePolls: number;
}

export const DEFAULT_POST_START_POLL_POLICY: PostStartPollPolicy = Object.freeze({
  maxPolls: 5,
  initialDelayMs: 1000,
  maxDelayMs: 8000,
  stablePolls: 2,
});

const MAX_POLLS = 20;
const MIN_DELAY_MS = 100;
const MAX_DELAY_MS = 60_000;

/** `docker inspect` State, or `missing` when inspect reported no such container. */
export type PostStartObservation = ContainerStateResult | { readonly kind: 'missing' };

export interface PostStartPollState {
  readonly pollsDone: number;
  readonly consecutiveRunning: number;
  readonly runningSince: string | null;
}

export type StartFailedReason = 'exited' | 'dead' | 'removing' | 'missing' | 'not_stable';

export type PostStartDecision =
  | { readonly kind: 'success' }
  | { readonly kind: 'keep_polling'; readonly delayMs: number }
  | {
      readonly kind: 'start_failed';
      readonly code: 'START_FAILED';
      readonly reason: StartFailedReason;
      readonly exitCode: number | null;
      readonly oomKilled: boolean;
    };

export interface PostStartPollStep {
  readonly decision: PostStartDecision;
  readonly state: PostStartPollState;
}

function isInt(value: number, min: number, max: number): boolean {
  return Number.isInteger(value) && value >= min && value <= max;
}

export function createPostStartPollPolicy(
  input: PostStartPollPolicy,
): ValidationResult<PostStartPollPolicy> {
  const { maxPolls, initialDelayMs, maxDelayMs, stablePolls } = input;
  if (
    !isInt(maxPolls, 1, MAX_POLLS) ||
    !isInt(initialDelayMs, MIN_DELAY_MS, MAX_DELAY_MS) ||
    !isInt(maxDelayMs, initialDelayMs, MAX_DELAY_MS) ||
    !isInt(stablePolls, 1, maxPolls)
  ) {
    return fail(
      'POST_START_POLL_POLICY_INVALID',
      `Post-start polls need 1-${String(MAX_POLLS)} polls, delays of ${String(MIN_DELAY_MS)}-${String(MAX_DELAY_MS)} ms with max >= initial, and 1 to maxPolls stable polls`,
    );
  }
  return ok({ maxPolls, initialDelayMs, maxDelayMs, stablePolls });
}

/** Wait before each poll: doubling from `initialDelayMs`, capped at `maxDelayMs`. */
export function postStartPollDelays(policy: PostStartPollPolicy): readonly number[] {
  return Array.from({ length: policy.maxPolls }, (_, i) =>
    Math.min(policy.initialDelayMs * 2 ** i, policy.maxDelayMs),
  );
}

export function startPostStartPolls(policy: PostStartPollPolicy): {
  readonly delayMs: number;
  readonly state: PostStartPollState;
} {
  return {
    delayMs: policy.initialDelayMs,
    state: { pollsDone: 0, consecutiveRunning: 0, runningSince: null },
  };
}

function failed(
  reason: StartFailedReason,
  exitCode: number | null,
  oomKilled: boolean,
): PostStartDecision {
  return { kind: 'start_failed', code: 'START_FAILED', reason, exitCode, oomKilled };
}

/** Immediate failure for a terminal container state, or null when polling may continue. */
function terminalFailure(observation: PostStartObservation): PostStartDecision | null {
  if (observation.kind === 'missing') {
    return failed('missing', null, false);
  }
  if (observation.kind !== 'ok') {
    return null;
  }
  switch (observation.status) {
    case 'exited':
    case 'dead':
    case 'removing':
      return failed(observation.status, observation.exitCode, observation.oomKilled);
    default:
      return null;
  }
}

export function decidePostStartPoll(
  policy: PostStartPollPolicy,
  state: PostStartPollState,
  observation: PostStartObservation,
): PostStartPollStep {
  if (state.pollsDone >= policy.maxPolls) {
    throw new Error('Post-start poll budget already spent');
  }
  const pollsDone = state.pollsDone + 1;

  const failure = terminalFailure(observation);
  if (failure !== null) {
    return { decision: failure, state: { pollsDone, consecutiveRunning: 0, runningSince: null } };
  }

  const running = observation.kind === 'ok' && observation.status === 'running';
  const startedAt = running ? observation.startedAt : null;
  const consecutiveRunning =
    startedAt === null ? 0 : startedAt === state.runningSince ? state.consecutiveRunning + 1 : 1;
  const next: PostStartPollState = { pollsDone, consecutiveRunning, runningSince: startedAt };

  if (consecutiveRunning >= policy.stablePolls) {
    return { decision: { kind: 'success' }, state: next };
  }
  if (pollsDone >= policy.maxPolls) {
    return { decision: failed('not_stable', null, false), state: next };
  }
  const delayMs = Math.min(policy.initialDelayMs * 2 ** pollsDone, policy.maxDelayMs);
  return { decision: { kind: 'keep_polling', delayMs }, state: next };
}
