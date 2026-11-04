import { describe, expect, it } from 'vitest';
import {
  CRASH_LOOP_MIN_RESTARTS,
  CRASH_LOOP_WINDOW_MS,
  OOM_NEAR_LIMIT_PERCENT,
  containerStateFromSample,
  healthcheckOutcome,
  observeContainer,
  type ContainerState,
  type ContainerStatePoint,
} from './container-observation.js';
import type { ContainerSample } from './container-sample.js';

const MIN = 60_000;
const T0 = Date.parse('2026-11-03T12:00:00Z');

function state(overrides: Partial<ContainerState> = {}): ContainerState {
  return {
    status: 'running',
    running: true,
    restarting: false,
    restartCount: 0,
    oomKilled: false,
    exitCode: 0,
    health: null,
    healthExitCodes: [],
    memoryLimitBytes: 1000,
    memoryUsedBytes: 100,
    ...overrides,
  };
}

const point = (minutes: number, overrides: Partial<ContainerState> = {}): ContainerStatePoint => ({
  observedAtMs: T0 + minutes * MIN,
  state: state(overrides),
});

const counts = (...pairs: [number, number][]): ContainerStatePoint[] =>
  pairs.map(([minute, restartCount]) => point(minute, { restartCount }));

describe('constants', () => {
  it('are the documented values', () => {
    expect(CRASH_LOOP_MIN_RESTARTS).toBe(3);
    expect(CRASH_LOOP_WINDOW_MS).toBe(10 * MIN);
    expect(OOM_NEAR_LIMIT_PERCENT).toBe(90);
  });
});

describe('crash loop: RestartCount increase >= 3 within the window (A3)', () => {
  it.each<[string, ContainerStatePoint[], number, boolean]>([
    ['3 restarts within the window', counts([0, 4], [1, 5], [2, 7]), 3, true],
    ['2 restarts (near miss)', counts([0, 4], [1, 5], [2, 6]), 2, false],
    ['restarts accumulated slowly across many samples', counts([0, 0], [3, 1], [6, 2], [9, 3]), 3, true],
    ['old restarts fall outside the window', counts([0, 0], [1, 5], [12, 5], [13, 6]), 1, false],
    ['the oldest point exactly at the window edge counts', counts([0, 0], [10, 3]), 3, true],
    ['a point just outside the edge does not', [point(0, { restartCount: 0 }), { observedAtMs: T0 + 10 * MIN + 1, state: state({ restartCount: 3 }) }], 0, false],
    ['a recreated container (count reset) only counts growth', counts([0, 9], [1, 0], [2, 1], [3, 2]), 2, false],
    ['a single sample proves nothing', counts([0, 7]), 0, false],
    ['out-of-order history is sorted first', counts([2, 7], [0, 4], [1, 5]), 3, true],
  ])('%s', (_name, history, restarts, crashLoop) => {
    const observation = observeContainer(history);
    expect(observation?.restartsInWindow).toBe(restarts);
    expect(observation?.crashLoop).toBe(crashLoop);
  });

  it('honours a custom window and threshold', () => {
    const history = counts([0, 0], [1, 1]);
    expect(observeContainer(history, { minRestarts: 1 })?.crashLoop).toBe(true);
    expect(observeContainer(counts([0, 0], [2, 5]), { windowMs: MIN })?.crashLoop).toBe(false);
  });

  it('returns null for an empty history', () => {
    expect(observeContainer([])).toBeNull();
  });
});

describe('out of memory (A3)', () => {
  const exited = { status: 'exited', running: false } as const;

  it.each<[string, ContainerStatePoint[], boolean]>([
    ['OOMKilled', [point(0, { ...exited, oomKilled: true, exitCode: 137, memoryUsedBytes: null })], true],
    ['exit 137 with memory near the limit', [point(0, { memoryUsedBytes: 950 }), point(1, { ...exited, exitCode: 137, memoryUsedBytes: null })], true],
    ['exit 137 with memory at exactly the near-limit share', [point(0, { memoryUsedBytes: 900 }), point(1, { ...exited, exitCode: 137, memoryUsedBytes: null })], true],
    ['exit 137 with memory well below the limit (SIGKILL, near miss)', [point(0, { memoryUsedBytes: 899 }), point(1, { ...exited, exitCode: 137, memoryUsedBytes: null })], false],
    ['exit 137 with no memory reading', [point(0, { ...exited, exitCode: 137, memoryUsedBytes: null })], false],
    ['exit 1 with memory near the limit', [point(0, { memoryUsedBytes: 990 }), point(1, { ...exited, exitCode: 1, memoryUsedBytes: null })], false],
    ['running container that reports exit 137 from a previous run', [point(0, { exitCode: 137, memoryUsedBytes: 990 })], false],
  ])('%s', (_name, history, expected) => {
    expect(observeContainer(history)?.outOfMemory).toBe(expected);
  });

  it('uses the host total for an unlimited container and never divides by zero (H1)', () => {
    const history = [
      point(0, { memoryUsedBytes: 950, memoryLimitBytes: null }),
      point(1, { ...exited, exitCode: 137, memoryUsedBytes: null, memoryLimitBytes: null }),
    ];
    expect(observeContainer(history, { hostTotalBytes: 1000 })?.outOfMemory).toBe(true);
    expect(observeContainer(history)?.outOfMemory).toBe(false);
    expect(observeContainer(history, { hostTotalBytes: 0 })?.outOfMemory).toBe(false);
  });
});

describe('healthcheck outcome (A3: timeout vs failing exit)', () => {
  it.each<[string, Partial<ContainerState>, string]>([
    ['no HEALTHCHECK', { health: null }, 'none'],
    ['starting', { health: 'starting', healthExitCodes: [-1] }, 'starting'],
    ['healthy', { health: 'healthy', healthExitCodes: [0] }, 'healthy'],
    ['unhealthy, last probe timed out (exit -1)', { health: 'unhealthy', healthExitCodes: [1, -1] }, 'timeout'],
    ['unhealthy, last probe exited non-zero', { health: 'unhealthy', healthExitCodes: [-1, 1] }, 'failing'],
    ['unhealthy with an empty log', { health: 'unhealthy', healthExitCodes: [] }, 'failing'],
  ])('%s', (_name, overrides, expected) => {
    expect(healthcheckOutcome(state(overrides))).toBe(expected);
    expect(observeContainer([point(0, overrides)])?.healthcheck).toBe(expected);
  });
});

describe('stopped, restarting and exit code', () => {
  it.each<[string, Partial<ContainerState>, boolean, number | null]>([
    ['running', {}, false, null],
    ['exited', { status: 'exited', running: false, exitCode: 3 }, true, 3],
    ['dead', { status: 'dead', running: false, exitCode: 0 }, true, 0],
    ['restarting (running=true, restarting=true)', { status: 'restarting', restarting: true, exitCode: 3 }, false, 3],
    ['created, never started', { status: 'created', running: false, exitCode: 0 }, false, 0],
  ])('%s', (_name, overrides, stopped, exitCode) => {
    const observation = observeContainer([point(0, overrides)]);
    expect(observation?.stopped).toBe(stopped);
    expect(observation?.restarting).toBe(overrides.restarting ?? false);
    expect(observation?.exitCode).toBe(exitCode);
  });
});

describe('containerStateFromSample', () => {
  const sample: ContainerSample = {
    id: 'a'.repeat(64),
    name: 'noodara-svc_a',
    status: 'running',
    running: true,
    restarting: false,
    restartCount: 2,
    oomKilled: false,
    exitCode: 0,
    startedAt: null,
    finishedAt: null,
    health: 'healthy',
    healthExitCodes: [0],
    memoryLimitBytes: null,
    stats: { cpuPercent: 1, memoryBytes: 42, memoryLimitBytes: 1000 },
  };

  it('keeps the state fields and the memory used from stats', () => {
    expect(containerStateFromSample(sample)).toEqual({
      status: 'running',
      running: true,
      restarting: false,
      restartCount: 2,
      oomKilled: false,
      exitCode: 0,
      health: 'healthy',
      healthExitCodes: [0],
      memoryLimitBytes: null,
      memoryUsedBytes: 42,
    });
  });

  it('has no memory reading without stats', () => {
    expect(containerStateFromSample({ ...sample, stats: null }).memoryUsedBytes).toBeNull();
    expect(
      containerStateFromSample({ ...sample, stats: { cpuPercent: null, memoryBytes: null, memoryLimitBytes: null } })
        .memoryUsedBytes,
    ).toBeNull();
  });
});
