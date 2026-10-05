import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { parseContainerState, type ContainerStateResult } from './container-state.js';
import {
  DEFAULT_POST_START_POLL_POLICY,
  createPostStartPollPolicy,
  decidePostStartPoll,
  postStartPollDelays,
  startPostStartPolls,
  type PostStartObservation,
  type PostStartPollPolicy,
  type PostStartPollStep,
} from './post-start-polls.js';

const STARTED = '2026-09-30T04:16:26.1Z';
const RESTARTED = '2026-09-30T04:16:29.9Z';

function state(
  overrides: Partial<Extract<ContainerStateResult, { kind: 'ok' }>> = {},
): ContainerStateResult {
  return {
    kind: 'ok',
    status: 'running',
    running: true,
    exitCode: 0,
    oomKilled: false,
    startedAt: STARTED,
    finishedAt: '0001-01-01T00:00:00Z',
    ...overrides,
  };
}

const exited = (exitCode: number, oomKilled = false) =>
  state({ status: 'exited', running: false, exitCode, oomKilled });

/** Feeds observations one by one, as the deploy job would after each delay. */
function run(
  observations: PostStartObservation[],
  policy: PostStartPollPolicy = DEFAULT_POST_START_POLL_POLICY,
) {
  const steps: PostStartPollStep[] = [];
  let current = startPostStartPolls(policy).state;
  for (const observation of observations) {
    const step = decidePostStartPoll(policy, current, observation);
    steps.push(step);
    current = step.state;
    if (step.decision.kind !== 'keep_polling') break;
  }
  return steps;
}

function policy(input: Partial<PostStartPollPolicy>): PostStartPollPolicy {
  const result = createPostStartPollPolicy({ ...DEFAULT_POST_START_POLL_POLICY, ...input });
  if (!result.ok) throw new Error(result.code);
  return result.value;
}

describe('post-start poll schedule', () => {
  it('defaults to 5 polls with 1 s to 8 s backoff, two stable polls to succeed', () => {
    expect(DEFAULT_POST_START_POLL_POLICY).toEqual({
      maxPolls: 5,
      initialDelayMs: 1000,
      maxDelayMs: 8000,
      stablePolls: 2,
    });
    expect(postStartPollDelays(DEFAULT_POST_START_POLL_POLICY)).toEqual([
      1000, 2000, 4000, 8000, 8000,
    ]);
  });

  it('is parameterised: doubles from the initial delay and caps at the max', () => {
    expect(
      postStartPollDelays(policy({ maxPolls: 4, initialDelayMs: 500, maxDelayMs: 1500 })),
    ).toEqual([500, 1000, 1500, 1500]);
  });

  it('waits the first delay before the first poll', () => {
    expect(startPostStartPolls(DEFAULT_POST_START_POLL_POLICY)).toEqual({
      delayMs: 1000,
      state: { pollsDone: 0, consecutiveRunning: 0, runningSince: null },
    });
  });
});

describe('createPostStartPollPolicy', () => {
  it('accepts the defaults', () => {
    expect(createPostStartPollPolicy(DEFAULT_POST_START_POLL_POLICY)).toEqual({
      ok: true,
      value: DEFAULT_POST_START_POLL_POLICY,
    });
  });

  it.each<[string, Partial<PostStartPollPolicy>]>([
    ['zero polls', { maxPolls: 0 }],
    ['too many polls', { maxPolls: 21 }],
    ['fractional polls', { maxPolls: 2.5 }],
    ['a too-short initial delay', { initialDelayMs: 99 }],
    ['a max delay under the initial delay', { initialDelayMs: 2000, maxDelayMs: 1000 }],
    ['a too-long max delay', { maxDelayMs: 60_001 }],
    ['zero stable polls', { stablePolls: 0 }],
    ['more stable polls than polls', { maxPolls: 2, stablePolls: 3 }],
  ])('rejects %s', (_label, override) => {
    const result = createPostStartPollPolicy({ ...DEFAULT_POST_START_POLL_POLICY, ...override });

    expect(result).toMatchObject({ ok: false, code: 'POST_START_POLL_POLICY_INVALID' });
  });
});

describe('decidePostStartPoll', () => {
  it('succeeds once the container is running on two consecutive polls with the same start', () => {
    const steps = run([state(), state()]);

    expect(steps.map((s) => s.decision)).toEqual([
      { kind: 'keep_polling', delayMs: 2000 },
      { kind: 'success' },
    ]);
  });

  it('succeeds on the first running poll when one stable poll is enough', () => {
    const steps = run([state()], policy({ stablePolls: 1 }));

    expect(steps.map((s) => s.decision)).toEqual([{ kind: 'success' }]);
  });

  it('keeps polling while the container is still created, then succeeds', () => {
    const steps = run([
      state({ status: 'created', running: false, startedAt: '0001-01-01T00:00:00Z' }),
      state(),
      state(),
    ]);

    expect(steps.map((s) => s.decision.kind)).toEqual(['keep_polling', 'keep_polling', 'success']);
  });

  it('does not count a restart between polls as stable', () => {
    const steps = run([state(), state({ startedAt: RESTARTED }), state({ startedAt: RESTARTED })]);

    expect(steps.map((s) => s.decision.kind)).toEqual(['keep_polling', 'keep_polling', 'success']);
  });

  it('resets stability when a restarting poll interrupts two running polls', () => {
    const steps = run([state(), state({ status: 'restarting', running: true }), state(), state()]);

    expect(steps.map((s) => s.decision.kind)).toEqual([
      'keep_polling',
      'keep_polling',
      'keep_polling',
      'success',
    ]);
  });

  it('fails START_FAILED with the exit code as soon as the container exited', () => {
    const steps = run([exited(3)]);

    expect(steps.map((s) => s.decision)).toEqual([
      {
        kind: 'start_failed',
        code: 'START_FAILED',
        reason: 'exited',
        exitCode: 3,
        oomKilled: false,
      },
    ]);
  });

  it('fails START_FAILED on an exit after the container was briefly running', () => {
    const steps = run([state(), exited(0)]);

    expect(steps.at(-1)?.decision).toMatchObject({
      kind: 'start_failed',
      reason: 'exited',
      exitCode: 0,
    });
  });

  it('reports an OOM kill', () => {
    expect(run([exited(137, true)])[0]?.decision).toMatchObject({
      reason: 'exited',
      exitCode: 137,
      oomKilled: true,
    });
  });

  it.each<[string, PostStartObservation, string]>([
    ['dead', state({ status: 'dead', running: false, exitCode: 1 }), 'dead'],
    ['being removed', state({ status: 'removing', running: false }), 'removing'],
    ['missing', { kind: 'missing' }, 'missing'],
  ])('fails START_FAILED when the container is %s', (_label, observation, reason) => {
    expect(run([observation])[0]?.decision).toMatchObject({
      kind: 'start_failed',
      code: 'START_FAILED',
      reason,
    });
  });

  it('reports no exit code for a missing container', () => {
    expect(run([{ kind: 'missing' }])[0]?.decision).toMatchObject({
      exitCode: null,
      oomKilled: false,
    });
  });

  it('keeps polling through an unparseable inspect, a paused or a restarting container', () => {
    const steps = run([
      { kind: 'unparseable', reason: 'State was not valid JSON' },
      state({ status: 'paused', running: true }),
      state({ status: 'restarting', running: true }),
    ]);

    expect(steps.map((s) => s.decision)).toEqual([
      { kind: 'keep_polling', delayMs: 2000 },
      { kind: 'keep_polling', delayMs: 4000 },
      { kind: 'keep_polling', delayMs: 8000 },
    ]);
  });

  it('fails START_FAILED as not stable when the polls run out (crash loop)', () => {
    const loop = [
      state(),
      state({ status: 'restarting', running: true }),
      state({ startedAt: RESTARTED }),
      state({ status: 'restarting', running: true }),
      state({ startedAt: '2026-09-30T04:16:40.0Z' }),
    ];

    const steps = run(loop);

    expect(steps).toHaveLength(5);
    expect(steps.at(-1)?.decision).toEqual({
      kind: 'start_failed',
      code: 'START_FAILED',
      reason: 'not_stable',
      exitCode: null,
      oomKilled: false,
    });
  });

  it('honours a custom poll budget', () => {
    const steps = run(
      [state({ status: 'created', running: false }), state({ status: 'created', running: false })],
      policy({ maxPolls: 2, stablePolls: 1 }),
    );

    expect(steps.map((s) => s.decision.kind)).toEqual(['keep_polling', 'start_failed']);
  });

  it('throws when asked to poll past the budget', () => {
    const p = policy({ maxPolls: 1, stablePolls: 1 });

    expect(() =>
      decidePostStartPoll(p, { pollsDone: 1, consecutiveRunning: 0, runningSince: null }, state()),
    ).toThrow(/budget/);
  });

  it.each(['22.04', '24.04'])('decides from the real Ubuntu %s inspect captures', (version) => {
    const read = (name: string) =>
      parseContainerState(
        readFileSync(
          new URL(
            `./fixtures/ubuntu-${version}/docker_inspect_state_${name}.json`,
            import.meta.url,
          ),
          'utf8',
        ),
      );

    expect(run([read('running'), read('running')]).at(-1)?.decision.kind).toBe('success');
    expect(run([read('exited')])[0]?.decision).toMatchObject({
      kind: 'start_failed',
      reason: 'exited',
      exitCode: 3,
    });
  });
});
