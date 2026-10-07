// 14-08: a QUEUED deployment whose BullMQ job never landed (enqueue failed and the API's undo
// failed too) would hold the one-active-per-service lock forever. The worker fails it
// FAILED/ENQUEUE_FAILED once it is older than a threshold and its job is confirmed absent.
// A job lookup that failed (Redis down) is `unknown`: skip and retry on the next tick.

import type { DeploymentStatus } from './deployment-state.js';

export type StaleQueuedJob = 'live' | 'absent' | 'unknown';

export interface StaleQueuedInput {
  readonly status: DeploymentStatus;
  readonly createdAt: Date;
  readonly now: Date;
  readonly thresholdMs: number;
  readonly job: StaleQueuedJob;
}

/** Rows created at or before this instant are old enough to be considered. */
export function staleQueuedCutoff(now: Date, thresholdMs: number): Date {
  return new Date(now.getTime() - thresholdMs);
}

export function decideStaleQueued(input: StaleQueuedInput): 'fail' | 'skip' {
  if (input.status !== 'QUEUED' || input.job !== 'absent') return 'skip';
  if (!Number.isFinite(input.thresholdMs) || input.thresholdMs <= 0) return 'skip';
  const ageMs = input.now.getTime() - input.createdAt.getTime();
  return Number.isFinite(ageMs) && ageMs > input.thresholdMs ? 'fail' : 'skip';
}
