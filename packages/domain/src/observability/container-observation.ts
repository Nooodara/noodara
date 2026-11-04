// Container runtime observation from a history of docker inspect states (A3, ADR 0012 "OOM and
// crash loop"). Pure: the caller passes the samples it kept for one container. Crash looping
// compares RestartCount between samples, not intervals, because Docker's restart backoff doubles;
// a count that drops means the container was recreated and only later growth counts. OOM is
// OOMKilled, or exit 137 with memory near the limit (137 alone is any SIGKILL).

import type { ContainerSample } from './container-sample.js';
import { memoryPercent } from './thresholds.js';

export const CRASH_LOOP_MIN_RESTARTS = 3;
/** Ten 60 s samples. */
export const CRASH_LOOP_WINDOW_MS = 10 * 60_000;
export const OOM_EXIT_CODE = 137;
export const OOM_NEAR_LIMIT_PERCENT = 90;
/** Docker records a health probe that exceeded its timeout with exit code -1. */
export const HEALTHCHECK_TIMEOUT_EXIT_CODE = -1;

export const HEALTHCHECK_OUTCOMES = Object.freeze(['none', 'starting', 'healthy', 'failing', 'timeout'] as const);
export type HealthcheckOutcome = (typeof HEALTHCHECK_OUTCOMES)[number];

export type ContainerState = Pick<
  ContainerSample,
  | 'status'
  | 'running'
  | 'restarting'
  | 'restartCount'
  | 'oomKilled'
  | 'exitCode'
  | 'health'
  | 'healthExitCodes'
  | 'memoryLimitBytes'
> & { readonly memoryUsedBytes: number | null };

export interface ContainerStatePoint {
  readonly observedAtMs: number;
  readonly state: ContainerState;
}

/** What the diagnosis classifier reads about one container (named apart from deployment's). */
export interface ContainerRuntimeObservation {
  readonly stopped: boolean;
  readonly restarting: boolean;
  readonly restartsInWindow: number;
  readonly crashLoop: boolean;
  readonly outOfMemory: boolean;
  readonly healthcheck: HealthcheckOutcome;
  /** The last exit code while not running; null while running. */
  readonly exitCode: number | null;
}

export interface ObserveOptions {
  readonly windowMs?: number;
  readonly minRestarts?: number;
  /** Host MemTotal, the limit of a container without one. */
  readonly hostTotalBytes?: number | null;
}

export function containerStateFromSample(sample: ContainerSample): ContainerState {
  return {
    status: sample.status,
    running: sample.running,
    restarting: sample.restarting,
    restartCount: sample.restartCount,
    oomKilled: sample.oomKilled,
    exitCode: sample.exitCode,
    health: sample.health,
    healthExitCodes: sample.healthExitCodes,
    memoryLimitBytes: sample.memoryLimitBytes,
    memoryUsedBytes: sample.stats?.memoryBytes ?? null,
  };
}

/** `failing` vs `timeout` is decided by the last probe's exit code. */
export function healthcheckOutcome(state: Pick<ContainerState, 'health' | 'healthExitCodes'>): HealthcheckOutcome {
  switch (state.health) {
    case null:
      return 'none';
    case 'starting':
    case 'healthy':
      return state.health;
    case 'unhealthy':
      return state.healthExitCodes.at(-1) === HEALTHCHECK_TIMEOUT_EXIT_CODE ? 'timeout' : 'failing';
  }
}

function restartsIn(points: readonly ContainerStatePoint[]): number {
  let restarts = 0;
  for (let i = 1; i < points.length; i += 1) {
    const growth = (points[i]?.state.restartCount ?? 0) - (points[i - 1]?.state.restartCount ?? 0);
    if (growth > 0) restarts += growth;
  }
  return restarts;
}

function nearMemoryLimit(points: readonly ContainerStatePoint[], hostTotalBytes: number | null): boolean {
  const last = points.findLast((point) => point.state.memoryUsedBytes !== null);
  if (last === undefined) return false;
  const percent = memoryPercent(
    { usedBytes: last.state.memoryUsedBytes ?? 0, limitBytes: last.state.memoryLimitBytes },
    hostTotalBytes,
  );
  return percent !== null && percent >= OOM_NEAR_LIMIT_PERCENT;
}

/** null for an empty history. */
export function observeContainer(
  history: readonly ContainerStatePoint[],
  options: ObserveOptions = {},
): ContainerRuntimeObservation | null {
  const sorted = [...history].sort((a, b) => a.observedAtMs - b.observedAtMs);
  const latest = sorted.at(-1);
  if (latest === undefined) return null;

  const windowStart = latest.observedAtMs - (options.windowMs ?? CRASH_LOOP_WINDOW_MS);
  const inWindow = sorted.filter((point) => point.observedAtMs >= windowStart);
  const restartsInWindow = restartsIn(inWindow);
  const { state } = latest;
  const exited = !state.running;

  return {
    stopped: state.status === 'exited' || state.status === 'dead',
    restarting: state.restarting,
    restartsInWindow,
    crashLoop: restartsInWindow >= (options.minRestarts ?? CRASH_LOOP_MIN_RESTARTS),
    outOfMemory:
      state.oomKilled ||
      (exited && state.exitCode === OOM_EXIT_CODE && nearMemoryLimit(inWindow, options.hostTotalBytes ?? null)),
    healthcheck: healthcheckOutcome(state),
    exitCode: exited || state.restarting ? state.exitCode : null,
  };
}
