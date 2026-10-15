import { describe, expect, it, vi } from 'vitest';
import type { PostStartPollPolicy } from '@noodara/domain/deployment';
import { createRedactor } from '@noodara/domain/security';
import type { SshDeploySession } from '@noodara/ssh';
import type { DeploymentRow } from '../services/deployment-services.js';
import {
  createDeployJobHandler,
  DEPLOY_JOB_MESSAGES,
  deployWorkerOptions,
  type DeployJobDeps,
  type DeployTarget,
} from './deploy-worker.js';
import type { FinishDeploymentInput } from './deployment-store.js';
import type { DeploymentLogSink } from './log-sink.js';
import { DEPLOY_MESSAGES, type DeploymentOutcome, type RunDeploymentInput } from './run-deployment.js';

const SERVICE_ID = '0192f1a4-7b3c-7d2e-8f00-00000000bbbb';
const SERVER_ID = '0192f1a4-7b3c-7d2e-8f00-00000000dddd';
const DEPLOYMENT_ID = '0192f1a4-7b3c-7d2e-8f00-00000000cccc';
const PAYLOAD = {
  deploymentId: DEPLOYMENT_ID,
  serviceId: SERVICE_ID,
  actor: { type: 'system' },
  requestedAt: '2026-10-05T10:00:00.000Z',
} as const;
const RAW_REMOTE = 'ssh: handshake failed: postgres://noodara:pw@db:5432 stderr dump';

const claimedRow = (): DeploymentRow =>
  ({ id: DEPLOYMENT_ID, serviceId: SERVICE_ID, status: 'PREPARING' }) as unknown as DeploymentRow;

const TARGET = { serviceId: SERVICE_ID, deploymentId: DEPLOYMENT_ID } as unknown as DeployTarget;

const SUCCESS: DeploymentOutcome = {
  status: 'SUCCESS',
  errorCode: null,
  errorMessage: null,
  commitSha: null,
  container: { kind: 'running' },
  cleanup: [],
};

function harness(overrides: Partial<DeployJobDeps> = {}) {
  const claims: (DeploymentRow | null)[] = [claimedRow(), null];
  const finished: FinishDeploymentInput[] = [];
  const logs: { level: string; fields: Record<string, unknown>; message: string }[] = [];
  const sessionClose = vi.fn(() => Promise.resolve());
  const sinkClose = vi.fn(() => Promise.resolve());
  const session = { stream: vi.fn() } as unknown as SshDeploySession;
  const sink: DeploymentLogSink = { write: vi.fn(), close: sinkClose };
  const runInputs: RunDeploymentInput[] = [];
  const deps: DeployJobDeps = {
    store: {
      claim: vi.fn(() => Promise.resolve(claims.shift() ?? null)),
      progress: () => ({ advance: () => Promise.resolve(), recordCommitSha: () => Promise.resolve() }),
      finish: vi.fn((_id: string, input: FinishDeploymentInput) => {
        finished.push(input);
        return Promise.resolve(null);
      }),
    },
    loadTarget: vi.fn(() => Promise.resolve({ ok: true as const, target: TARGET, serverId: SERVER_ID })),
    connect: vi.fn(() => Promise.resolve({ ok: true as const, session, close: sessionClose })),
    run: vi.fn((input: RunDeploymentInput) => {
      runInputs.push(input);
      return Promise.resolve(SUCCESS);
    }),
    createRedactor,
    sinkFor: () => sink,
    limits: {} as RunDeploymentInput['limits'],
    pollPolicy: {} as PostStartPollPolicy,
    clock: { now: () => 0, sleep: () => Promise.resolve() },
    logger: {
      info: (fields, message) => void logs.push({ level: 'info', fields, message }),
      warn: (fields, message) => void logs.push({ level: 'warn', fields, message }),
      error: (fields, message) => void logs.push({ level: 'error', fields, message }),
    },
    ...overrides,
  };
  return { deps, handle: createDeployJobHandler(deps), finished, logs, sessionClose, sinkClose, runInputs, session, sink };
}

describe('deploy job handler: happy path', () => {
  it('claims, loads, connects, runs with the store progress and the sink, finishes and closes everything', async () => {
    const h = harness();

    const result = await h.handle(PAYLOAD);

    expect(result).toEqual({ outcome: 'SUCCESS' });
    expect(h.deps.connect).toHaveBeenCalledWith(SERVER_ID, expect.anything(), undefined);
    expect(h.runInputs[0]).toMatchObject({ ...TARGET, session: h.session, sink: h.sink });
    expect(h.finished).toEqual([
      { status: 'SUCCESS', errorCode: null, errorMessage: null, commitSha: null, container: { kind: 'running' } },
    ]);
    expect(h.sessionClose).toHaveBeenCalledOnce();
    expect(h.sinkClose).toHaveBeenCalledOnce();
  });

  it('passes the same per-run redactor to the connector and the pipeline', async () => {
    const h = harness();
    await h.handle(PAYLOAD);
    const [, redactor] = vi.mocked(h.deps.connect).mock.calls[0] ?? [];
    expect(h.runInputs[0]?.redactor).toBe(redactor);
  });

  it('reports the pipeline outcome as the job outcome', async () => {
    const h = harness({
      run: () =>
        Promise.resolve({ ...SUCCESS, status: 'FAILED', errorCode: 'BUILD_FAILED', errorMessage: 'The build failed.', container: null }),
    });
    expect(await h.handle(PAYLOAD)).toEqual({ outcome: 'FAILED' });
    expect(h.finished[0]).toMatchObject({ status: 'FAILED', errorCode: 'BUILD_FAILED', container: null });
  });
});

describe('deploy job handler: ROLLED_BACK is terminal (17-03 P3)', () => {
  const ROLLED_BACK = {
    ...SUCCESS,
    status: 'ROLLED_BACK',
    errorCode: 'HEALTHCHECK_FAILED',
    errorMessage: 'The healthcheck failed, so the previous version was restored.',
  } as const;

  it('records ROLLED_BACK once with its error code and message and reports it as the job outcome', async () => {
    const h = harness({ run: vi.fn(() => Promise.resolve(ROLLED_BACK)) });

    expect(await h.handle(PAYLOAD)).toEqual({ outcome: 'ROLLED_BACK' });

    expect(h.finished).toEqual([
      {
        status: 'ROLLED_BACK',
        errorCode: 'HEALTHCHECK_FAILED',
        errorMessage: ROLLED_BACK.errorMessage,
        commitSha: null,
        container: { kind: 'running' },
      },
    ]);
    expect(h.sessionClose).toHaveBeenCalledOnce();
    expect(h.sinkClose).toHaveBeenCalledOnce();
    expect(JSON.stringify(h.logs)).not.toContain(ROLLED_BACK.errorMessage);
  });

  it('never retries a ROLLED_BACK job: a re-delivery runs nothing and records nothing', async () => {
    const run = vi.fn(() => Promise.resolve(ROLLED_BACK));
    const h = harness({ run });

    const first = await h.handle(PAYLOAD);
    const second = await h.handle(PAYLOAD);

    expect(first).toEqual({ outcome: 'ROLLED_BACK' });
    expect(second).toEqual({ outcome: 'ALREADY_CLAIMED' });
    expect(run).toHaveBeenCalledOnce();
    expect(h.deps.connect).toHaveBeenCalledOnce();
    expect(h.finished).toHaveLength(1);
  });

  it('resolves instead of throwing when ROLLED_BACK cannot be recorded, so BullMQ never retries it', async () => {
    const h = harness({
      run: () => Promise.resolve(ROLLED_BACK),
      store: {
        claim: () => Promise.resolve(claimedRow()),
        progress: () => ({ advance: () => Promise.resolve(), recordCommitSha: () => Promise.resolve() }),
        finish: () => Promise.reject(new Error(RAW_REMOTE)),
      },
    });
    await expect(h.handle(PAYLOAD)).resolves.toEqual({ outcome: 'WORKER_CRASHED' });
    expect(JSON.stringify(h.logs)).not.toContain('postgres://');
  });
});

describe('deploy job handler: idempotent against stall and retry (H1)', () => {
  it('a re-delivered (stalled) job for a deployment already past QUEUED runs no remote command', async () => {
    const h = harness();

    await h.handle(PAYLOAD);
    const second = await h.handle(PAYLOAD);

    expect(second).toEqual({ outcome: 'ALREADY_CLAIMED' });
    expect(h.deps.connect).toHaveBeenCalledOnce();
    expect(h.deps.run).toHaveBeenCalledOnce();
    expect(h.deps.loadTarget).toHaveBeenCalledOnce();
    expect(h.finished).toHaveLength(1);
  });

  it('the worker never re-delivers a stalled job: maxStalledCount 0, lock from the deploy budget', () => {
    expect(deployWorkerOptions({ deployMaxMs: 3_600_000, concurrency: 2 })).toEqual({
      concurrency: 2,
      lockDuration: 3_600_000 + 300_000 + 30_000,
      maxStalledCount: 0,
    });
  });

  it('a malformed payload completes without claiming anything and logs no value', async () => {
    const h = harness();
    expect(await h.handle({ ...PAYLOAD, deploymentId: '$(touch pwned)' })).toEqual({ outcome: 'INVALID_PAYLOAD' });
    expect(h.deps.store.claim).not.toHaveBeenCalled();
    expect(JSON.stringify(h.logs)).not.toContain('pwned');
  });

  it('a claim that cannot reach the database completes without remote work or a crash', async () => {
    const h = harness({
      store: {
        claim: () => Promise.reject(new Error(RAW_REMOTE)),
        progress: () => ({ advance: () => Promise.resolve(), recordCommitSha: () => Promise.resolve() }),
        finish: () => Promise.resolve(null),
      },
    });
    expect(await h.handle(PAYLOAD)).toEqual({ outcome: 'CLAIM_FAILED' });
    expect(h.deps.connect).not.toHaveBeenCalled();
    expect(JSON.stringify(h.logs)).not.toContain('pw@db');
  });

  it('a job whose serviceId does not match the claimed row fails closed without remote work', async () => {
    const h = harness();
    expect(await h.handle({ ...PAYLOAD, serviceId: SERVER_ID })).toEqual({ outcome: 'FAILED' });
    expect(h.deps.connect).not.toHaveBeenCalled();
    expect(h.finished[0]).toMatchObject({ status: 'FAILED', errorCode: 'WORKER_CRASHED' });
  });
});

describe('deploy job handler: failures never crash the worker and never carry raw text (ERR)', () => {
  it('a server that cannot be reached ends FAILED SERVER_UNREACHABLE with the fixed message', async () => {
    const h = harness({ connect: () => Promise.resolve({ ok: false as const, code: 'SERVER_UNREACHABLE' as const }) });

    expect(await h.handle(PAYLOAD)).toEqual({ outcome: 'FAILED' });

    expect(h.deps.run).not.toHaveBeenCalled();
    expect(h.finished).toEqual([
      {
        status: 'FAILED',
        errorCode: 'SERVER_UNREACHABLE',
        errorMessage: DEPLOY_JOB_MESSAGES.SERVER_UNREACHABLE,
        commitSha: null,
        container: null,
      },
    ]);
    expect(h.sinkClose).toHaveBeenCalledOnce();
  });

  it('a target that cannot be loaded ends FAILED with its closed code and never connects', async () => {
    const h = harness({ loadTarget: () => Promise.resolve({ ok: false as const, code: 'REPOSITORY_AUTH_FAILED' as const }) });
    await h.handle(PAYLOAD);
    expect(h.deps.connect).not.toHaveBeenCalled();
    expect(h.finished[0]).toMatchObject({ errorCode: 'REPOSITORY_AUTH_FAILED', errorMessage: DEPLOY_JOB_MESSAGES.REPOSITORY_AUTH_FAILED });
  });

  it.each([
    ['loadTarget', { loadTarget: () => Promise.reject(new Error(RAW_REMOTE)) }],
    ['connect', { connect: () => Promise.reject(new Error(RAW_REMOTE)) }],
    ['run', { run: () => Promise.reject(new Error(RAW_REMOTE)) }],
  ] as const)('a thrown %s error ends FAILED WORKER_CRASHED; the raw text reaches neither the row nor the logs', async (_step, override) => {
    const h = harness(override);

    expect(await h.handle(PAYLOAD)).toEqual({ outcome: 'WORKER_CRASHED' });

    expect(h.finished).toEqual([
      { status: 'FAILED', errorCode: 'WORKER_CRASHED', errorMessage: DEPLOY_MESSAGES.WORKER_CRASHED, commitSha: null, container: null },
    ]);
    expect(JSON.stringify(h.logs)).not.toContain('pw@db');
    expect(h.sinkClose).toHaveBeenCalledOnce();
  });

  it('a finish that throws is logged without its text and the handler still resolves', async () => {
    const h = harness();
    h.deps.store.finish = () => Promise.reject(new Error(RAW_REMOTE));
    expect(await h.handle(PAYLOAD)).toEqual({ outcome: 'WORKER_CRASHED' });
    expect(h.logs.some((l) => l.level === 'error')).toBe(true);
    expect(JSON.stringify(h.logs)).not.toContain('pw@db');
    expect(h.sessionClose).toHaveBeenCalledOnce();
  });

  it('a session or sink that fails to close does not fail the job', async () => {
    const h = harness({
      connect: () => Promise.resolve({ ok: true as const, session: {} as SshDeploySession, close: () => Promise.reject(new Error(RAW_REMOTE)) }),
      sinkFor: () => ({ write: () => undefined, close: () => Promise.reject(new Error(RAW_REMOTE)) }),
    });
    expect(await h.handle(PAYLOAD)).toEqual({ outcome: 'SUCCESS' });
    expect(JSON.stringify(h.logs)).not.toContain('pw@db');
  });

  it('every connect and load failure code has a fixed, actionable message', () => {
    for (const message of Object.values(DEPLOY_JOB_MESSAGES)) {
      expect(message).toMatch(/\.$/);
      expect(message.length).toBeGreaterThan(30);
    }
  });
});

describe('deploy job handler: cancel (12-13 A1, A2, H2)', () => {
  function cancelDeps(options: { abortedAtStart?: boolean } = {}) {
    const controller = new AbortController();
    if (options.abortedAtStart === true) controller.abort();
    const stop = vi.fn();
    const clear = vi.fn(() => Promise.resolve());
    return { controller, stop, clear, cancel: { watch: vi.fn(() => ({ signal: controller.signal, stop })), clear } };
  }

  it('passes the cancel watch signal to the connector and the pipeline, then stops it and clears the flag', async () => {
    const c = cancelDeps();
    const h = harness({ cancel: c.cancel });

    expect(await h.handle(PAYLOAD)).toEqual({ outcome: 'SUCCESS' });

    expect(c.cancel.watch).toHaveBeenCalledWith(DEPLOYMENT_ID);
    const runSignal = h.runInputs[0]?.signal;
    expect(runSignal).toBeInstanceOf(AbortSignal);
    c.controller.abort();
    expect(runSignal?.aborted).toBe(true);
    expect(c.stop).toHaveBeenCalledOnce();
    expect(c.clear).toHaveBeenCalledWith(DEPLOYMENT_ID);
  });

  it('a cancel seen before the connection ends CANCELLED without connecting (A1)', async () => {
    const c = cancelDeps({ abortedAtStart: true });
    const h = harness({ cancel: c.cancel });

    expect(await h.handle(PAYLOAD)).toEqual({ outcome: 'CANCELLED' });

    expect(h.deps.connect).not.toHaveBeenCalled();
    expect(h.runInputs).toEqual([]);
    expect(h.finished).toEqual([{ status: 'CANCELLED', errorCode: null, errorMessage: null, commitSha: null, container: null }]);
    expect(c.clear).toHaveBeenCalledOnce();
  });

  it('a connect cut short by the cancel ends CANCELLED, not SERVER_UNREACHABLE', async () => {
    const c = cancelDeps();
    const h = harness({
      cancel: c.cancel,
      connect: vi.fn(() => {
        c.controller.abort();
        return Promise.resolve({ ok: false as const, code: 'SERVER_UNREACHABLE' as const });
      }),
    });

    expect(await h.handle(PAYLOAD)).toEqual({ outcome: 'CANCELLED' });
    expect(h.finished[0]).toMatchObject({ status: 'CANCELLED', errorCode: null });
  });

  it('a connection that opened as the cancel arrived is closed and nothing runs', async () => {
    const c = cancelDeps();
    const h = harness({
      cancel: c.cancel,
      connect: vi.fn(() => {
        c.controller.abort();
        return Promise.resolve({ ok: true as const, session: h.session, close: h.sessionClose });
      }),
    });

    expect(await h.handle(PAYLOAD)).toEqual({ outcome: 'CANCELLED' });
    expect(h.runInputs).toEqual([]);
    expect(h.sessionClose).toHaveBeenCalledOnce();
  });

  it('an unconfirmed cancel is finished with its named warning and logged without text (H2)', async () => {
    const c = cancelDeps();
    const h = harness({
      cancel: c.cancel,
      run: () =>
        Promise.resolve({
          ...SUCCESS,
          status: 'FAILED',
          errorCode: 'SERVER_UNREACHABLE',
          errorMessage: DEPLOY_MESSAGES.CANCEL_UNCONFIRMED,
          container: null,
          warning: 'CANCEL_UNCONFIRMED',
        }),
    });

    expect(await h.handle(PAYLOAD)).toEqual({ outcome: 'FAILED' });
    expect(h.finished[0]).toMatchObject({ status: 'FAILED', warning: 'CANCEL_UNCONFIRMED' });
    expect(h.logs.some((log) => log.level === 'warn' && log.fields.warning === 'CANCEL_UNCONFIRMED')).toBe(true);
  });

  it('a flag that cannot be cleared or watched never fails the job', async () => {
    const h = harness({
      cancel: {
        watch: () => {
          throw new Error(RAW_REMOTE);
        },
        clear: () => Promise.reject(new Error(RAW_REMOTE)),
      },
    });

    expect(await h.handle(PAYLOAD)).toEqual({ outcome: 'SUCCESS' });
    expect(JSON.stringify(h.logs)).not.toContain('pw@db');
  });
});

describe('deploy job handler: image retention (17-04)', () => {
  const PREVIOUS_ID = '0192f1a4-7b3c-7d2e-8f00-00000000aaaa';
  const TARGET_WITH_PREVIOUS = {
    ...TARGET,
    previousSuccess: { id: PREVIOUS_ID, runtimeConfig: null },
  } as unknown as DeployTarget;
  const ROLLED_BACK: DeploymentOutcome = {
    ...SUCCESS,
    status: 'ROLLED_BACK',
    errorCode: 'HEALTHCHECK_FAILED',
    errorMessage: 'rolled back',
  };
  const report = { outcome: 'done' as const, kept: [], removed: [], failed: [] };

  /** Records the order of retention, session close and the terminal write. */
  function ordered(outcome: DeploymentOutcome, retention?: DeployJobDeps['retention']) {
    const order: string[] = [];
    const retentionFn =
      retention ??
      vi.fn(() => {
        order.push('retention');
        return Promise.resolve(report);
      });
    const run = vi.fn((_input: RunDeploymentInput) => Promise.resolve(outcome));
    const h = harness({
      loadTarget: vi.fn(() => Promise.resolve({ ok: true as const, target: TARGET_WITH_PREVIOUS, serverId: SERVER_ID })),
      run,
      retention: retentionFn,
    });
    vi.mocked(h.deps.store.finish).mockImplementation((_id, input) => {
      order.push(`finish:${input.status}`);
      h.finished.push(input);
      return Promise.resolve(null);
    });
    h.sessionClose.mockImplementation(() => {
      order.push('close');
      return Promise.resolve();
    });
    return { ...h, order, run, retention: retentionFn };
  }

  it('A1/H1: after SUCCESS runs on the open session before the terminal write', async () => {
    const h = ordered(SUCCESS);

    expect(await h.handle(PAYLOAD)).toEqual({ outcome: 'SUCCESS' });

    expect(h.order).toEqual(['retention', 'close', 'finish:SUCCESS']);
    expect(h.retention).toHaveBeenCalledWith(
      expect.objectContaining({
        serviceId: SERVICE_ID,
        deploymentId: DEPLOYMENT_ID,
        outcome: 'SUCCESS',
        previousSuccessId: PREVIOUS_ID,
        session: h.session,
      }),
    );
  });

  it('A1: after ROLLED_BACK runs with the restored deployment as the running one', async () => {
    const h = ordered(ROLLED_BACK);

    expect(await h.handle(PAYLOAD)).toEqual({ outcome: 'ROLLED_BACK' });

    expect(h.order).toEqual(['retention', 'close', 'finish:ROLLED_BACK']);
    expect(h.retention).toHaveBeenCalledWith(expect.objectContaining({ outcome: 'ROLLED_BACK', previousSuccessId: PREVIOUS_ID }));
  });

  it('passes the same redactor the pipeline used', async () => {
    const h = ordered(SUCCESS);

    await h.handle(PAYLOAD);

    const [call] = vi.mocked(h.retention).mock.calls;
    const [runCall] = h.run.mock.calls;
    expect(call?.[0].redactor).toBeDefined();
    expect(call?.[0].redactor).toBe(runCall?.[0].redactor);
  });

  it.each([
    ['FAILED', { ...SUCCESS, status: 'FAILED', errorCode: 'BUILD_FAILED', errorMessage: 'x' }],
    ['CANCELLED', { ...SUCCESS, status: 'CANCELLED' }],
  ] as const)('never runs after %s', async (_name, outcome) => {
    const h = ordered(outcome);

    await h.handle(PAYLOAD);

    expect(h.retention).not.toHaveBeenCalled();
  });

  it('never runs when the run did not happen (connect failure)', async () => {
    const retention = vi.fn(() => Promise.resolve(report));
    const h = harness({ connect: () => Promise.resolve({ ok: false as const, code: 'SERVER_UNREACHABLE' as const }), retention });

    await h.handle(PAYLOAD);

    expect(retention).not.toHaveBeenCalled();
  });

  it('A2: a retention that throws is logged by class only and the outcome stands', async () => {
    const retention = vi.fn(() => Promise.reject(new TypeError('ssh: postgres://noodara:pw@db stderr')));
    const h = ordered(SUCCESS, retention);

    expect(await h.handle(PAYLOAD)).toEqual({ outcome: 'SUCCESS' });

    expect(h.finished).toEqual([expect.objectContaining({ status: 'SUCCESS', errorCode: null })]);
    expect(h.logs.some((log) => log.level === 'warn' && log.fields.errorKind === 'TypeError')).toBe(true);
    expect(JSON.stringify(h.logs)).not.toContain('pw@db');
  });

  it('A2: a report with failed removals never changes the recorded result', async () => {
    const retention = vi.fn(() =>
      Promise.resolve({ ...report, failed: [{ imageRef: `noodara/${SERVICE_ID}:x`, kind: 'in_use' }] }),
    );
    const h = ordered(ROLLED_BACK, retention);

    expect(await h.handle(PAYLOAD)).toEqual({ outcome: 'ROLLED_BACK' });

    expect(h.finished).toEqual([
      expect.objectContaining({ status: 'ROLLED_BACK', errorCode: 'HEALTHCHECK_FAILED', errorMessage: 'rolled back' }),
    ]);
  });

  it('without a retention port no image is ever touched (the outcome is unchanged)', async () => {
    const h = harness();

    expect(await h.handle(PAYLOAD)).toEqual({ outcome: 'SUCCESS' });
    expect(h.finished).toHaveLength(1);
  });
});
