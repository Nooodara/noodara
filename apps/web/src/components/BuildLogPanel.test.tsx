import { act, Profiler } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TooltipProvider } from '@noodara/ui';
import { renderUi, screen } from '@noodara/ui/testing';
import type { DeploymentView } from '../lib/deploy-api';
import type { DeployEntityEvent, DeploymentLogChunkEvent } from '../lib/server-events';
import {
  BUILD_LOG_FLUSH_MS,
  BUILD_LOG_NOT_FOUND_COPY,
  BuildLogPanel,
  MAX_RENDERED_BUILD_LINES,
  type BuildLogStream,
} from './BuildLogPanel';

const SERVICE_ID = '44444444-4444-4444-8444-444444444444';
const DEPLOYMENT_ID = '00000000-0000-4000-8000-000000000001';
const OTHER_DEPLOYMENT_ID = '00000000-0000-4000-8000-000000000002';

const deployApi = vi.hoisted(() => ({
  getServiceDeployment: vi.fn(),
  getDeploymentLogs: vi.fn(),
}));
vi.mock('../lib/deploy-api', () => ({
  getServiceDeployment: (serviceId: string, id: string) =>
    deployApi.getServiceDeployment(serviceId, id) as unknown,
  getDeploymentLogs: (id: string, query: unknown) =>
    deployApi.getDeploymentLogs(id, query) as unknown,
}));
vi.mock('../lib/require-session', () => ({ requireSession: () => undefined }));

function deployment(id: string, overrides: Partial<DeploymentView> = {}): DeploymentView {
  return {
    id,
    serviceId: SERVICE_ID,
    status: 'BUILDING',
    trigger: 'manual',
    triggeredBy: null,
    source: {
      sourceType: 'git',
      repositoryUrl: 'https://example.com/acme/api.git',
      branch: 'main',
      buildContext: '.',
      dockerfilePath: 'Dockerfile',
      buildTarget: null,
      imageRef: null,
      internalPort: 3000,
      publishedPort: null,
    },
    commitSha: null,
    previousDeploymentId: null,
    startedAt: null,
    completedAt: null,
    durationMs: null,
    errorCode: null,
    errorMessage: null,
    createdAt: '2026-10-06T12:00:00.000Z',
    updatedAt: '2026-10-06T12:00:00.000Z',
    ...overrides,
  };
}

const ok = <T,>(data: T) => Promise.resolve({ ok: true, data });
const fail = (code: string) =>
  Promise.resolve({ ok: false, code, message: 'raw', unauthorized: false });

function item(seq: number, text: string) {
  return {
    phase: 'prepare',
    seq,
    text,
    byteLength: text.length,
    createdAt: '2026-10-06T12:00:00.000Z',
  };
}

function chunk(deploymentId: string, seq: number, text: string): DeploymentLogChunkEvent {
  return {
    type: 'deployment.log_chunk',
    deploymentId,
    phase: 'prepare',
    seq,
    text,
    truncated: false,
  };
}

/** A fake shell stream that counts what is still subscribed. */
function fakeStream() {
  const logHandlers = new Map<string, Set<(chunk: DeploymentLogChunkEvent) => void>>();
  const deployListeners = new Set<(event: DeployEntityEvent) => void>();
  const resyncs = new Set<() => void>();
  const stream: BuildLogStream = {
    subscribeDeploymentLog: (id, handler) => {
      const set = logHandlers.get(id) ?? new Set();
      const wrapped = (c: DeploymentLogChunkEvent) => {
        handler(c);
      };
      set.add(wrapped);
      logHandlers.set(id, set);
      return () => set.delete(wrapped);
    },
    subscribeDeploy: (listener) => {
      deployListeners.add(listener);
      return () => deployListeners.delete(listener);
    },
    registerResync: (fn) => {
      resyncs.add(fn);
      return () => resyncs.delete(fn);
    },
  };
  return {
    stream,
    emit(c: DeploymentLogChunkEvent) {
      for (const handler of logHandlers.get(c.deploymentId) ?? []) handler(c);
    },
    emitDeploy(event: DeployEntityEvent) {
      for (const listener of deployListeners) listener(event);
    },
    resync() {
      for (const fn of resyncs) fn();
    },
    active() {
      let count = 0;
      for (const set of logHandlers.values()) count += set.size;
      return {
        logs: count,
        deploy: deployListeners.size,
        resyncs: resyncs.size,
      };
    },
  };
}

async function settle(): Promise<void> {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(BUILD_LOG_FLUSH_MS + 1);
  });
}

function logText(): string {
  return screen.getByRole('log', { name: 'Build log' }).textContent;
}

beforeEach(() => {
  vi.useFakeTimers();
  deployApi.getServiceDeployment.mockReset();
  deployApi.getDeploymentLogs.mockReset();
  deployApi.getServiceDeployment.mockImplementation((_s: string, id: string) => ok(deployment(id)));
  deployApi.getDeploymentLogs.mockImplementation(() => ok({ items: [], hasMore: false }));
});

afterEach(() => {
  vi.useRealTimers();
});

describe('BuildLogPanel', () => {
  it('loads the snapshot first, then folds live chunks without replaying what the snapshot had', async () => {
    deployApi.getDeploymentLogs.mockImplementation(() =>
      ok({ items: [item(1, 'clone\n'), item(2, 'cloned\n')], hasMore: false }),
    );
    const s = fakeStream();
    renderUi(
      <BuildLogPanel serviceId={SERVICE_ID} deploymentId={DEPLOYMENT_ID} stream={s.stream} />,
    );
    await settle();
    expect(deployApi.getDeploymentLogs).toHaveBeenCalledWith(DEPLOYMENT_ID, {
      phase: 'prepare',
      since: 0,
    });
    expect(logText()).toBe('clonecloned');

    // A reload mid-build: the stream redelivers a chunk the snapshot already had, then new output.
    act(() => {
      s.emit(chunk(DEPLOYMENT_ID, 2, 'cloned\n'));
      s.emit(chunk(DEPLOYMENT_ID, 3, 'building\n'));
      s.emit(chunk(OTHER_DEPLOYMENT_ID, 4, 'not mine\n'));
    });
    await settle();
    expect(screen.getAllByText(/^(clone|cloned|building)$/).map((el) => el.textContent)).toEqual([
      'clone',
      'cloned',
      'building',
    ]);
    expect(logText()).not.toContain('not mine');
  });

  it('asks for the missing range when a live chunk arrives ahead of the cursor', async () => {
    const s = fakeStream();
    renderUi(
      <BuildLogPanel serviceId={SERVICE_ID} deploymentId={DEPLOYMENT_ID} stream={s.stream} />,
    );
    await settle();
    deployApi.getDeploymentLogs.mockImplementation(() =>
      ok({
        items: [item(1, 'one\n'), item(2, 'two\n'), item(3, 'three\n')],
        hasMore: false,
      }),
    );
    act(() => {
      s.emit(chunk(DEPLOYMENT_ID, 3, 'three\n'));
    });
    await settle();
    expect(deployApi.getDeploymentLogs).toHaveBeenLastCalledWith(DEPLOYMENT_ID, {
      phase: 'prepare',
      since: 0,
    });
    expect(logText()).toBe('onetwothree');
  });

  it('refetches from its cursor when the stream reconnects', async () => {
    deployApi.getDeploymentLogs.mockImplementationOnce(() =>
      ok({ items: [item(1, 'one\n')], hasMore: false }),
    );
    const s = fakeStream();
    renderUi(
      <BuildLogPanel serviceId={SERVICE_ID} deploymentId={DEPLOYMENT_ID} stream={s.stream} />,
    );
    await settle();
    deployApi.getDeploymentLogs.mockImplementation(() =>
      ok({ items: [item(2, 'two\n')], hasMore: false }),
    );
    act(() => {
      s.resync();
    });
    await settle();
    expect(deployApi.getDeploymentLogs).toHaveBeenLastCalledWith(DEPLOYMENT_ID, {
      phase: 'prepare',
      since: 1,
    });
    expect(logText()).toBe('onetwo');
  });

  it('renders a not-found state for a deployment outside this service, without fetching its logs', async () => {
    deployApi.getServiceDeployment.mockImplementation(() => fail('NOT_FOUND'));
    const s = fakeStream();
    renderUi(
      <BuildLogPanel serviceId={SERVICE_ID} deploymentId={DEPLOYMENT_ID} stream={s.stream} />,
    );
    await settle();
    expect(screen.getByTestId('build-log-not-found').textContent).toBe(BUILD_LOG_NOT_FOUND_COPY);
    expect(deployApi.getDeploymentLogs).not.toHaveBeenCalled();
    expect(s.active().logs).toBe(0);
  });

  it('renders not-found when the logs themselves are gone', async () => {
    deployApi.getDeploymentLogs.mockImplementation(() => fail('NOT_FOUND'));
    const s = fakeStream();
    renderUi(
      <BuildLogPanel serviceId={SERVICE_ID} deploymentId={DEPLOYMENT_ID} stream={s.stream} />,
    );
    await settle();
    expect(screen.getByTestId('build-log-not-found')).toBeTruthy();
  });

  it('shows the deployment status and keeps it current from deployment.updated', async () => {
    const s = fakeStream();
    renderUi(
      <BuildLogPanel serviceId={SERVICE_ID} deploymentId={DEPLOYMENT_ID} stream={s.stream} />,
    );
    await settle();
    expect(screen.getByTestId('build-log-status').getAttribute('data-tone')).toBe('warn');
    act(() => {
      s.emitDeploy({
        type: 'deployment.updated',
        deployment: {
          ...deployment(DEPLOYMENT_ID),
          status: 'FAILED',
          updatedAt: '2026-10-06T12:05:00.000Z',
        },
      });
    });
    expect(screen.getByTestId('build-log-status').getAttribute('data-tone')).toBe('error');
  });

  it('never shows the previous deployment text after the selection changes', async () => {
    deployApi.getDeploymentLogs.mockImplementation((id: string) =>
      id === DEPLOYMENT_ID
        ? ok({ items: [item(1, 'first deploy\n')], hasMore: false })
        : new Promise(() => undefined),
    );
    const s = fakeStream();
    const view = (id: string) => (
      <TooltipProvider delayDuration={0}>
        <BuildLogPanel serviceId={SERVICE_ID} deploymentId={id} stream={s.stream} />
      </TooltipProvider>
    );
    const { rerender } = renderUi(
      <BuildLogPanel serviceId={SERVICE_ID} deploymentId={DEPLOYMENT_ID} stream={s.stream} />,
    );
    await settle();
    expect(screen.getByText('first deploy')).toBeTruthy();
    rerender(view(OTHER_DEPLOYMENT_ID));
    expect(screen.queryByText('first deploy')).toBeNull();
    await settle();
    expect(screen.queryByText('first deploy')).toBeNull();
  });

  it('caps the rendered lines with a notice and batches a flood instead of rendering per chunk', async () => {
    const s = fakeStream();
    let commits = 0;
    renderUi(
      <Profiler
        id="build-log"
        onRender={() => {
          commits += 1;
        }}
      >
        <BuildLogPanel serviceId={SERVICE_ID} deploymentId={DEPLOYMENT_ID} stream={s.stream} />
      </Profiler>,
    );
    await settle();
    const before = commits;
    // 100k lines in 1,000 chunks of 100 lines, all within one flush window.
    act(() => {
      for (let seq = 1; seq <= 1000; seq += 1) {
        const lines = Array.from({ length: 100 }, (_, n) => `c${String(seq)}l${String(n)}`).join(
          '\n',
        );
        s.emit(chunk(DEPLOYMENT_ID, seq, `${lines}\n`));
      }
    });
    await settle();
    expect(commits - before).toBeLessThanOrEqual(3);
    const log = screen.getByRole('log', { name: 'Build log' });
    expect(log.children.length).toBe(MAX_RENDERED_BUILD_LINES);
    expect(log.lastElementChild?.textContent).toBe('c1000l99');
    expect(screen.getByTestId('log-hidden-notice').textContent).toContain(
      MAX_RENDERED_BUILD_LINES.toLocaleString('en-US'),
    );
  });

  it('leaves no subscription, resync hook or timer behind after opening and closing 50 times', async () => {
    const s = fakeStream();
    for (let round = 0; round < 50; round += 1) {
      const { unmount } = renderUi(
        <BuildLogPanel serviceId={SERVICE_ID} deploymentId={DEPLOYMENT_ID} stream={s.stream} />,
      );
      await act(async () => {
        await Promise.resolve();
      });
      act(() => {
        s.emit(chunk(DEPLOYMENT_ID, round + 1, `round ${String(round)}\n`));
      });
      unmount();
    }
    expect(s.active()).toEqual({ logs: 0, deploy: 0, resyncs: 0 });
    expect(vi.getTimerCount()).toBe(0);
  });
});
