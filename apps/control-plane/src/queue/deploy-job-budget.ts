// D15/D17: pure functions deriving the BullMQ `deploy-service` job's lockDuration and the Redis
// cancel-key TTL (`noodara:deploy-cancel:<deploymentId>`) from NOODARA_DEPLOY_MAX_MS. Sibling of
// job-budget.ts (connect/discovery), which is tuned for seconds-long SSH jobs and must not be
// reused for minutes-long builds. Like job-budget.ts, this module never imports env.js: callers
// pass the already-validated number in. env.ts imports the range below so both share one source.

export interface DeployMaxMsRange {
  readonly min: number;
  readonly max: number;
}

/** Research default (SUMMARY D15, Pitfall 11 "a build that takes 40 minutes"): 60 minutes. */
export const DEPLOY_MAX_MS_DEFAULT = 3_600_000;

/** 5 minutes to 4 hours. The minimum equals the NOODARA_DEPLOY_IDLE_MS default. */
export const DEPLOY_MAX_MS_RANGE: DeployMaxMsRange = { min: 300_000, max: 14_400_000 };

/**
 * After the hard max fires (BUILD_TIMEOUT) or a cancel arrives, the job still owns the deployment
 * while it kills the remote process group, confirms, destroys the channel and runs per-deployment
 * cleanup — each step bounded by its own SSH command timeout. This allowance covers that tail.
 */
export const DEPLOY_CLEANUP_ALLOWANCE_MS = 300_000;

/** Scheduling jitter and the gap between the last lock-renewal tick and the job's actual finish. */
export const DEPLOY_STALL_SAFETY_MARGIN_MS = 30_000;

export interface DeployJobBudget {
  readonly lockDurationMs: number;
  readonly cancelKeyTtlMs: number;
}

function assertDeployMaxMs(deployMaxMs: number): void {
  if (
    !Number.isInteger(deployMaxMs) ||
    deployMaxMs < DEPLOY_MAX_MS_RANGE.min ||
    deployMaxMs > DEPLOY_MAX_MS_RANGE.max
  ) {
    throw new RangeError(
      `deployMaxMs must be an integer between ${String(DEPLOY_MAX_MS_RANGE.min)} and ${String(DEPLOY_MAX_MS_RANGE.max)}`,
    );
  }
}

/**
 * The lock outlives the longest legitimate run (hard max + cleanup + margin), so BullMQ never
 * marks a live build stalled and hands it to a second worker even if a renewal tick is delayed.
 * A dead worker's job is recovered by the startup sweep (WORKER_CRASHED), not by lock expiry.
 * At the range max the result stays far below Node's 2^31-1 ms timer ceiling.
 */
export function computeDeployJobLockDurationMs(deployMaxMs: number): number {
  assertDeployMaxMs(deployMaxMs);
  return deployMaxMs + DEPLOY_CLEANUP_ALLOWANCE_MS + DEPLOY_STALL_SAFETY_MARGIN_MS;
}

/**
 * A cancel flag must survive as long as the job it targets can still be running, and must expire
 * on its own when orphaned (research: TTL = lock duration). Use with `SET ... PX <ttl>`.
 */
export function computeDeployCancelKeyTtlMs(deployMaxMs: number): number {
  return computeDeployJobLockDurationMs(deployMaxMs);
}

export function computeDeployJobBudget(deployMaxMs: number): DeployJobBudget {
  return {
    lockDurationMs: computeDeployJobLockDurationMs(deployMaxMs),
    cancelKeyTtlMs: computeDeployCancelKeyTtlMs(deployMaxMs),
  };
}
