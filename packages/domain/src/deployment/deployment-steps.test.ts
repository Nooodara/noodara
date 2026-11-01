import { describe, expect, it } from 'vitest';
import { DEPLOYMENT_ERROR_CODES, type DeploymentErrorCode } from './deployment-error.js';
import { DEPLOYMENT_STATUSES, isTerminalDeploymentStatus } from './deployment-state.js';
import {
  DEPLOYMENT_STEP_STATES,
  deriveDeploymentSteps,
  stepBoundaryOfTransition,
  type DeploymentSourceType,
  type DeploymentStepsInput,
} from './deployment-steps.js';

const T0 = new Date('2026-10-06T10:00:00.000Z');
const at = (seconds: number): Date => new Date(T0.getTime() + seconds * 1000);

function input(overrides: Partial<DeploymentStepsInput> = {}): DeploymentStepsInput {
  return {
    status: 'QUEUED',
    sourceType: 'git',
    errorCode: null,
    startedAt: null,
    buildingStartedAt: null,
    deployingStartedAt: null,
    verifyingStartedAt: null,
    completedAt: null,
    ...overrides,
  };
}

// The core timeline (clone|pull, build, start, verify) without the 23-04 configure step, which
// has its own describe below: its state never changes how the other four are derived.
const coreSteps = (value: DeploymentStepsInput) => deriveDeploymentSteps(value).filter((s) => s.name !== 'configure');
const states = (value: DeploymentStepsInput): string[] => coreSteps(value).map((s) => s.state);
const names = (value: DeploymentStepsInput): string[] => deriveDeploymentSteps(value).map((s) => s.name);
const configureOf = (value: DeploymentStepsInput) => deriveDeploymentSteps(value)[1];

const FULL = {
  startedAt: at(0),
  buildingStartedAt: at(5),
  deployingStartedAt: at(20),
  verifyingStartedAt: at(22),
  completedAt: at(30),
};

describe('deriveDeploymentSteps', () => {
  it('names a git timeline clone, configure, build, start, verify and an image one pull, configure, build, start, verify', () => {
    expect(names(input())).toEqual(['clone', 'configure', 'build', 'start', 'verify']);
    expect(names(input({ sourceType: 'image' }))).toEqual(['pull', 'configure', 'build', 'start', 'verify']);
  });

  it('QUEUED: every step pending with no times', () => {
    const steps = coreSteps(input());
    expect(steps.map((s) => s.state)).toEqual(['pending', 'pending', 'pending', 'pending']);
    expect(steps.every((s) => s.startedAt === null && s.completedAt === null && s.durationMs === null)).toBe(true);
  });

  it('follows a git deployment through every in-flight status', () => {
    expect(states(input({ status: 'PREPARING', startedAt: at(0) }))).toEqual(['running', 'pending', 'pending', 'pending']);
    expect(states(input({ status: 'BUILDING', startedAt: at(0), buildingStartedAt: at(5) }))).toEqual([
      'success',
      'running',
      'pending',
      'pending',
    ]);
    const deploying = input({ status: 'DEPLOYING', ...FULL, verifyingStartedAt: null, completedAt: null });
    expect(states(deploying)).toEqual(['success', 'success', 'running', 'pending']);
    const verifying = input({ status: 'DEPLOYING', ...FULL, completedAt: null });
    expect(states(verifying)).toEqual(['success', 'success', 'success', 'running']);
    const running = coreSteps(verifying)[3];
    expect(running).toEqual({ name: 'verify', state: 'running', startedAt: at(22), completedAt: null, durationMs: null });
  });

  it('SUCCESS: four successful steps whose times chain and whose durations are set', () => {
    const steps = coreSteps(input({ status: 'SUCCESS', ...FULL }));
    expect(steps).toEqual([
      { name: 'clone', state: 'success', startedAt: at(0), completedAt: at(5), durationMs: 5000 },
      { name: 'build', state: 'success', startedAt: at(5), completedAt: at(20), durationMs: 15000 },
      { name: 'start', state: 'success', startedAt: at(20), completedAt: at(22), durationMs: 2000 },
      { name: 'verify', state: 'success', startedAt: at(22), completedAt: at(30), durationMs: 8000 },
    ]);
  });

  it('image source: pull runs through PREPARING and BUILDING, build is skipped', () => {
    expect(states(input({ sourceType: 'image', status: 'PREPARING', startedAt: at(0) }))).toEqual([
      'running',
      'skipped',
      'pending',
      'pending',
    ]);
    expect(
      states(input({ sourceType: 'image', status: 'BUILDING', startedAt: at(0), buildingStartedAt: at(0) })),
    ).toEqual(['running', 'skipped', 'pending', 'pending']);
    const steps = coreSteps(input({ sourceType: 'image', status: 'SUCCESS', ...FULL }));
    expect(steps[0]).toEqual({ name: 'pull', state: 'success', startedAt: at(0), completedAt: at(20), durationMs: 20000 });
    expect(steps[1]).toEqual({ name: 'build', state: 'skipped', startedAt: null, completedAt: null, durationMs: null });
  });

  it('FAILED in build: build failed, clone succeeded, later steps pending', () => {
    const steps = coreSteps(
      input({ status: 'FAILED', errorCode: 'BUILD_FAILED', startedAt: at(0), buildingStartedAt: at(5), completedAt: at(9) }),
    );
    expect(steps.map((s) => s.state)).toEqual(['success', 'failed', 'pending', 'pending']);
    expect(steps[1]).toEqual({ name: 'build', state: 'failed', startedAt: at(5), completedAt: at(9), durationMs: 4000 });
    expect(steps[2]?.startedAt).toBeNull();
  });

  it('FAILED in verify and in start, from the boundaries', () => {
    expect(states(input({ status: 'FAILED', errorCode: 'START_FAILED', ...FULL }))).toEqual([
      'success',
      'success',
      'success',
      'failed',
    ]);
    expect(
      states(input({ status: 'FAILED', errorCode: 'PORT_IN_USE', ...FULL, verifyingStartedAt: null })),
    ).toEqual(['success', 'success', 'failed', 'pending']);
  });

  it('CANCELLED marks the running step cancelled', () => {
    expect(
      states(input({ status: 'CANCELLED', startedAt: at(0), buildingStartedAt: at(5), completedAt: at(7) })),
    ).toEqual(['success', 'cancelled', 'pending', 'pending']);
    expect(states(input({ status: 'CANCELLED', startedAt: at(0), completedAt: at(1) }))).toEqual([
      'cancelled',
      'pending',
      'pending',
      'pending',
    ]);
    expect(
      states(input({ sourceType: 'image', status: 'CANCELLED', startedAt: at(0), buildingStartedAt: at(0), completedAt: at(3) })),
    ).toEqual(['cancelled', 'skipped', 'pending', 'pending']);
  });

  it('a deployment cancelled while QUEUED has no step that ran', () => {
    expect(states(input({ status: 'CANCELLED', completedAt: at(1) }))).toEqual(['pending', 'pending', 'pending', 'pending']);
  });

  describe('rows without step boundaries (pre-13-03 or failed before the first boundary)', () => {
    it('locates the failing step from the error code', () => {
      const legacy = (errorCode: DeploymentErrorCode, sourceType: DeploymentSourceType = 'git'): string[] =>
        states(input({ status: 'FAILED', sourceType, errorCode, startedAt: at(0), completedAt: at(9) }));
      expect(legacy('CLONE_FAILED')).toEqual(['failed', 'pending', 'pending', 'pending']);
      expect(legacy('GIT_HOST_KEY_MISMATCH')).toEqual(['failed', 'pending', 'pending', 'pending']);
      expect(legacy('GIT_HOST_KEY_UNAVAILABLE')).toEqual(['failed', 'pending', 'pending', 'pending']);
      expect(legacy('BUILD_TIMEOUT')).toEqual(['success', 'failed', 'pending', 'pending']);
      expect(legacy('PORT_IN_USE')).toEqual(['success', 'success', 'failed', 'pending']);
      expect(legacy('START_FAILED')).toEqual(['success', 'success', 'success', 'failed']);
      expect(legacy('WORKER_CRASHED')).toEqual(['failed', 'pending', 'pending', 'pending']);
      expect(legacy('IMAGE_PULL_FAILED', 'image')).toEqual(['failed', 'skipped', 'pending', 'pending']);
      expect(legacy('BUILD_FAILED', 'image')).toEqual(['failed', 'skipped', 'pending', 'pending']);
    });

    it('a never-claimed failure has no step that ran', () => {
      expect(states(input({ status: 'FAILED', errorCode: 'WORKER_CRASHED', completedAt: at(1) }))).toEqual([
        'pending',
        'pending',
        'pending',
        'pending',
      ]);
    });

    it('derives in-flight states from the status alone', () => {
      expect(states(input({ status: 'BUILDING', startedAt: at(0) }))).toEqual(['success', 'running', 'pending', 'pending']);
      expect(states(input({ status: 'DEPLOYING', startedAt: at(0) }))).toEqual(['success', 'success', 'running', 'pending']);
      const success = coreSteps(input({ status: 'SUCCESS', startedAt: at(0), completedAt: at(30) }));
      expect(success.map((s) => s.state)).toEqual(['success', 'success', 'success', 'success']);
      expect(success[0]).toMatchObject({ startedAt: at(0), completedAt: null, durationMs: null });
      expect(success[3]).toMatchObject({ startedAt: null, completedAt: at(30), durationMs: null });
    });
  });

  it('clamps durations to 0 when completedAt precedes startedAt (clock skew)', () => {
    const steps = coreSteps(
      input({ status: 'FAILED', startedAt: at(10), buildingStartedAt: at(4), completedAt: at(1), errorCode: 'BUILD_FAILED' }),
    );
    expect(steps[0]?.durationMs).toBe(0);
    expect(steps[1]?.durationMs).toBe(0);
  });

  it('treats invalid dates as unknown', () => {
    const invalid = new Date(Number.NaN);
    const steps = coreSteps(input({ status: 'SUCCESS', ...FULL, buildingStartedAt: invalid }));
    expect(steps[1]).toMatchObject({ state: 'success', startedAt: null, durationMs: null });
    expect(steps[0]).toMatchObject({ completedAt: null, durationMs: null });
  });

  // H2: total over statuses x sources x error codes x boundary patterns x clock skew.
  it('is total: never throws, always five steps in fixed order, durations never negative', () => {
    const codes: (DeploymentErrorCode | null)[] = [null, ...DEPLOYMENT_ERROR_CODES];
    const clocks: readonly ((i: number) => Date)[] = [(i) => at(i * 10), (i) => at(100 - i * 10), () => at(0)];
    let cases = 0;
    const violations: string[] = [];
    for (const status of DEPLOYMENT_STATUSES) {
      for (const sourceType of ['git', 'image'] as const) {
        for (const errorCode of codes) {
          for (let mask = 0; mask < 32; mask += 1) {
            for (const configured of [false, true]) {
            for (const clock of clocks) {
              const pick = (bit: number): Date | null => ((mask >> bit) & 1 ? clock(bit) : null);
              const value = input({
                status,
                sourceType,
                errorCode,
                startedAt: pick(0),
                buildingStartedAt: pick(1),
                deployingStartedAt: pick(2),
                verifyingStartedAt: pick(3),
                completedAt: pick(4),
                ...(configured ? { configureStartedAt: clock(0), configureCompletedAt: clock(1), configureVariables: 2, configureSecrets: 1 } : {}),
              });
              const steps = deriveDeploymentSteps(value);
              cases += 1;
              // Plain checks, one assertion at the end: ~50k cases x expect() is too slow for CI.
              const label = `${status}/${sourceType}/${String(errorCode)}/${String(mask)}/${String(configured)}`;
              const names = steps.map((s) => s.name).join(',');
              if (names !== `${sourceType === 'git' ? 'clone' : 'pull'},configure,build,start,verify`) violations.push(`${label}: order ${names}`);
              for (const s of steps) {
                if (!DEPLOYMENT_STEP_STATES.includes(s.state)) violations.push(`${label}: state ${s.state}`);
                if (s.durationMs !== null && s.durationMs < 0) violations.push(`${label}: negative ${s.name}`);
                if ((s.state === 'pending' || s.state === 'skipped') && s.startedAt !== null) violations.push(`${label}: ${s.name} started`);
                if (s.state === 'running' && s.completedAt !== null) violations.push(`${label}: ${s.name} completed`);
              }
              // ROLLING_BACK restores the previous container: the attempt's own steps are over.
              const ended = status === 'ROLLING_BACK' || isTerminalDeploymentStatus(status);
              const running = steps.filter((s) => s.state === 'running').length;
              if (running !== (ended || status === 'QUEUED' ? 0 : 1)) violations.push(`${label}: ${String(running)} running`);
              const stopped = steps.filter((s) => s.state === 'failed' || s.state === 'cancelled').length;
              if (stopped > 1) violations.push(`${label}: ${String(stopped)} ended`);
              if (status === 'SUCCESS' && !steps.every((s) => s.state === 'success' || s.state === 'skipped')) {
                violations.push(`${label}: success with unfinished step`);
              }
              if (sourceType === 'image' && steps[2]?.state !== 'skipped') violations.push(`${label}: image build not skipped`);
              if (configured && steps[1]?.state !== 'success') violations.push(`${label}: recorded configure not success`);
              if ((steps[1]?.counts !== undefined) !== configured) violations.push(`${label}: configure counts`);
            }
            }
          }
        }
      }
    }
    expect(violations).toEqual([]);
    expect(cases).toBe(DEPLOYMENT_STATUSES.length * 2 * codes.length * 32 * 2 * clocks.length);
  });
});

describe('stepBoundaryOfTransition', () => {
  it('writes the build, deploy and verify boundaries with their status edges only', () => {
    const table: Record<string, string | null> = {};
    for (const from of DEPLOYMENT_STATUSES) {
      for (const to of DEPLOYMENT_STATUSES) {
        const boundary = stepBoundaryOfTransition(from, to);
        if (boundary !== null) table[`${from}->${to}`] = boundary;
      }
    }
    expect(table).toEqual({
      'PREPARING->BUILDING': 'buildingStartedAt',
      'BUILDING->DEPLOYING': 'deployingStartedAt',
      'DEPLOYING->HEALTHCHECK': 'verifyingStartedAt',
    });
  });

  it('the rollback-only PREPARING -> DEPLOYING edge writes the deploy boundary for trigger rollback only', () => {
    expect(stepBoundaryOfTransition('PREPARING', 'DEPLOYING', 'rollback')).toBe('deployingStartedAt');
    expect(stepBoundaryOfTransition('PREPARING', 'DEPLOYING', 'manual')).toBeNull();
  });

  it('an invalid edge has no boundary', () => {
    expect(stepBoundaryOfTransition('QUEUED', 'BUILDING')).toBeNull();
    expect(stepBoundaryOfTransition('SUCCESS', 'DEPLOYING')).toBeNull();
  });
});

describe('v0.3 states (16-02 A7)', () => {
  it('HEALTHCHECK is the verify step: three successful steps, verify running', () => {
    const healthcheck = input({ status: 'HEALTHCHECK', ...FULL, completedAt: null });
    expect(states(healthcheck)).toEqual(['success', 'success', 'success', 'running']);
    expect(coreSteps(healthcheck)[3]).toEqual({
      name: 'verify',
      state: 'running',
      startedAt: at(22),
      completedAt: null,
      durationMs: null,
    });
    expect(states(input({ status: 'HEALTHCHECK', startedAt: at(0) }))).toEqual(['success', 'success', 'success', 'running']);
  });

  it('ROLLING_BACK and ROLLED_BACK mark the step that failed, with none running', () => {
    for (const status of ['ROLLING_BACK', 'ROLLED_BACK'] as const) {
      expect(states(input({ status, errorCode: 'HEALTHCHECK_FAILED', ...FULL }))).toEqual(['success', 'success', 'success', 'failed']);
      expect(states(input({ status, errorCode: 'START_FAILED', ...FULL, verifyingStartedAt: null }))).toEqual([
        'success',
        'success',
        'failed',
        'pending',
      ]);
    }
  });

  it('maps the v0.3 error codes of rows without boundaries to their step', () => {
    expect(states(input({ status: 'FAILED', errorCode: 'COMMIT_NOT_FOUND', startedAt: at(0) }))).toEqual([
      'failed',
      'pending',
      'pending',
      'pending',
    ]);
    for (const errorCode of ['HEALTHCHECK_FAILED', 'HEALTHCHECK_TIMEOUT'] as const) {
      expect(states(input({ status: 'FAILED', errorCode, startedAt: at(0) }))).toEqual(['success', 'success', 'success', 'failed']);
      expect(states(input({ sourceType: 'image', status: 'FAILED', errorCode, startedAt: at(0) }))).toEqual([
        'success',
        'skipped',
        'success',
        'failed',
      ]);
    }
  });
});

describe('deriveDeploymentSteps configure (23-04 A4)', () => {
  const CONFIGURED = { configureStartedAt: at(0), configureCompletedAt: at(1), configureVariables: 3, configureSecrets: 2 };

  it('is success with its stored bounds, duration and counts once recorded', () => {
    expect(configureOf(input({ status: 'BUILDING', startedAt: at(0), buildingStartedAt: at(5), ...CONFIGURED }))).toEqual({
      name: 'configure',
      state: 'success',
      startedAt: at(0),
      completedAt: at(1),
      durationMs: 1000,
      counts: { variables: 3, secrets: 2 },
    });
  });

  it('reads unusable counts as zero and never a negative duration', () => {
    const step = configureOf(
      input({ status: 'SUCCESS', ...FULL, configureStartedAt: at(5), configureCompletedAt: at(1), configureVariables: -1, configureSecrets: 1.5 }),
    );
    expect(step).toMatchObject({ state: 'success', durationMs: 0, counts: { variables: 0, secrets: 0 } });
  });

  it('is pending before the attempt resolves its env and while it prepares', () => {
    expect(configureOf(input())?.state).toBe('pending');
    expect(configureOf(input({ status: 'PREPARING', startedAt: at(0) }))?.state).toBe('pending');
  });

  it('is skipped once the attempt went past it without an env (no variables, or a row before 23-04)', () => {
    expect(configureOf(input({ status: 'BUILDING', startedAt: at(0), buildingStartedAt: at(5) }))?.state).toBe('skipped');
    expect(configureOf(input({ status: 'SUCCESS', ...FULL }))?.state).toBe('skipped');
    expect(configureOf(input({ status: 'FAILED', ...FULL, errorCode: 'START_FAILED' }))?.state).toBe('skipped');
    expect(configureOf(input({ status: 'FAILED', startedAt: at(0), completedAt: at(2), errorCode: 'BUILD_FAILED' }))?.state).toBe('skipped');
  });

  it('stays pending when the attempt ended in clone without an env', () => {
    expect(configureOf(input({ status: 'FAILED', startedAt: at(0), completedAt: at(2), errorCode: 'CLONE_FAILED' }))?.state).toBe('pending');
  });

  it.each(['SECRET_UNRESOLVED', 'ENV_INJECTION_FAILED'] as const)(
    '%s before any later boundary fails configure and leaves every other step pending',
    (errorCode) => {
      const value = input({ status: 'FAILED', startedAt: at(0), completedAt: at(1), errorCode });
      expect(configureOf(value)).toEqual({ name: 'configure', state: 'failed', startedAt: at(0), completedAt: at(1), durationMs: 1000 });
      expect(states(value)).toEqual(['pending', 'pending', 'pending', 'pending']);
      expect(configureOf({ ...value, status: 'CANCELLED' })?.state).toBe('cancelled');
    },
  );

  it('an env file write failure at start fails start, not configure', () => {
    const value = input({ status: 'FAILED', ...FULL, verifyingStartedAt: null, errorCode: 'ENV_INJECTION_FAILED', ...CONFIGURED });
    expect(configureOf(value)?.state).toBe('success');
    expect(states(value)).toEqual(['success', 'success', 'failed', 'pending']);
  });
});
