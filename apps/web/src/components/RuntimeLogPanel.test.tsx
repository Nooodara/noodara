import { act } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, renderUi, screen } from '@noodara/ui/testing';
import type {
  FollowRuntimeLogsOptions,
  RuntimeLogFollowResult,
  StreamedLogLine,
} from '../lib/runtime-log-stream';
import {
  FOLLOW_LIMIT_COPY,
  followEndCopy,
  RUNTIME_LOG_FLUSH_MS,
  RUNTIME_LOG_NOT_FOUND_COPY,
  RuntimeLogPanel,
} from './RuntimeLogPanel';

const PROJECT_ID = '11111111-1111-4111-8111-111111111111';
const SERVICE_ID = '44444444-4444-4444-8444-444444444444';

const deployApi = vi.hoisted(() => ({ getRuntimeLogs: vi.fn() }));
vi.mock('../lib/deploy-api', () => ({
  getRuntimeLogs: (projectId: string, serviceId: string, query: unknown) =>
    deployApi.getRuntimeLogs(projectId, serviceId, query) as unknown,
}));
vi.mock('../lib/require-session', () => ({ requireSession: () => undefined }));

interface FakeFollow {
  readonly options: FollowRuntimeLogsOptions;
  lines: StreamedLogLine[];
  finish: (result: RuntimeLogFollowResult) => void;
}

const follows: FakeFollow[] = [];
vi.mock('../lib/runtime-log-stream', () => ({
  followRuntimeLogs: (options: FollowRuntimeLogsOptions) => {
    let finish: (result: RuntimeLogFollowResult) => void = () => undefined;
    const done = new Promise<RuntimeLogFollowResult>((resolve) => {
      finish = resolve;
    });
    const follow: FakeFollow = {
      options,
      lines: [],
      finish: (result) => {
        finish(result);
      },
    };
    // Like the real reader, an abort settles the follow.
    options.signal?.addEventListener('abort', () => {
      finish({ ok: true, reason: 'aborted' });
    });
    follows.push(follow);
    return {
      done,
      snapshot: () => ({
        lines: [...follow.lines],
        droppedLines: 0,
        skippedFrames: 0,
      }),
    };
  },
}));

function line(text: string, stream: 'stdout' | 'stderr' = 'stdout'): StreamedLogLine {
  return {
    stream,
    timestamp: '2026-10-06T12:00:00.000Z',
    text,
    truncated: false,
  };
}

const ok = <T,>(data: T) => Promise.resolve({ ok: true, data });
const fail = (code: string) =>
  Promise.resolve({ ok: false, code, message: 'raw', unauthorized: false });

async function settle(): Promise<void> {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(RUNTIME_LOG_FLUSH_MS + 1);
  });
}

function followToggle(): HTMLElement {
  return screen.getByRole('button', { name: 'Follow' });
}

function latest(): FakeFollow {
  const follow = follows.at(-1);
  if (follow === undefined) throw new Error('no follow started');
  return follow;
}

beforeEach(() => {
  vi.useFakeTimers();
  follows.length = 0;
  deployApi.getRuntimeLogs.mockReset();
  deployApi.getRuntimeLogs.mockImplementation(() =>
    ok({ lines: [line('ready')], truncated: false }),
  );
});

afterEach(() => {
  vi.useRealTimers();
});

describe('followEndCopy', () => {
  it('says why a follow stopped, for every server reason and typed failure', () => {
    expect(
      followEndCopy({
        ok: true,
        reason: 'server_end',
        serverReason: 'container_exited',
      }),
    ).toMatch(/container exited/);
    expect(
      followEndCopy({
        ok: true,
        reason: 'server_end',
        serverReason: 'max_duration',
      }),
    ).toMatch(/10 minutes/);
    expect(followEndCopy({ ok: true, reason: 'max_duration' })).toMatch(/10 minutes/);
    expect(
      followEndCopy({
        ok: true,
        reason: 'server_end',
        serverReason: 'output_limit',
      }),
    ).toMatch(/output limit/);
    expect(
      followEndCopy({
        ok: true,
        reason: 'server_end',
        serverReason: 'connection_lost',
      }),
    ).toMatch(/connection/);
    expect(
      followEndCopy({
        ok: true,
        reason: 'server_end',
        serverReason: 'shutdown',
      }),
    ).toMatch(/restarting/);
    expect(
      followEndCopy({
        ok: false,
        code: 'RUNTIME_LOG_FOLLOW_LIMIT_REACHED',
        message: 'raw',
        unauthorized: false,
      }),
    ).toBe(FOLLOW_LIMIT_COPY);
    expect(
      followEndCopy({
        ok: false,
        code: 'NETWORK_ERROR',
        message: 'raw',
        unauthorized: false,
      }),
    ).toMatch(/connection/);
    expect(
      followEndCopy({
        ok: false,
        code: 'INTERNAL_ERROR',
        message: 'raw server text',
        unauthorized: false,
      }),
    ).not.toContain('raw server text');
  });
});

describe('RuntimeLogPanel', () => {
  it('loads a tail on demand and reloads it when the tail changes', async () => {
    renderUi(<RuntimeLogPanel projectId={PROJECT_ID} serviceId={SERVICE_ID} />);
    await settle();
    expect(deployApi.getRuntimeLogs).toHaveBeenCalledWith(PROJECT_ID, SERVICE_ID, { tail: 100 });
    expect(screen.getByRole('log', { name: 'Runtime logs' }).textContent).toContain('ready');

    fireEvent.click(screen.getByRole('radio', { name: '500' }));
    await settle();
    expect(deployApi.getRuntimeLogs).toHaveBeenLastCalledWith(PROJECT_ID, SERVICE_ID, {
      tail: 500,
    });
  });

  it('renders a not-found state when the service is gone', async () => {
    deployApi.getRuntimeLogs.mockImplementation(() => fail('NOT_FOUND'));
    renderUi(<RuntimeLogPanel projectId={PROJECT_ID} serviceId={SERVICE_ID} />);
    await settle();
    expect(screen.getByTestId('runtime-log-not-found').textContent).toBe(
      RUNTIME_LOG_NOT_FOUND_COPY,
    );
  });

  it('follows with the selected tail and shows streamed lines', async () => {
    renderUi(<RuntimeLogPanel projectId={PROJECT_ID} serviceId={SERVICE_ID} />);
    await settle();
    fireEvent.click(followToggle());
    expect(followToggle().getAttribute('aria-pressed')).toBe('true');
    expect(latest().options).toMatchObject({
      projectId: PROJECT_ID,
      serviceId: SERVICE_ID,
      tail: 100,
    });

    latest().lines.push(line('hello'), line('oops', 'stderr'));
    act(() => {
      latest().options.onLines?.([]);
    });
    await settle();
    const log = screen.getByRole('log', { name: 'Runtime logs' });
    expect(log.textContent).toContain('hello');
    expect(screen.getByText('oops').closest('[data-stream]')?.getAttribute('data-stream')).toBe(
      'stderr',
    );
  });

  it('aborts the follow when Follow is turned off, and says so', async () => {
    renderUi(<RuntimeLogPanel projectId={PROJECT_ID} serviceId={SERVICE_ID} />);
    await settle();
    fireEvent.click(followToggle());
    const signal = latest().options.signal;
    fireEvent.click(followToggle());
    await settle();
    expect(signal?.aborted).toBe(true);
    expect(followToggle().getAttribute('aria-pressed')).toBe('false');
    expect(screen.getByTestId('runtime-log-notice').textContent).toMatch(/stopped/i);
  });

  it('restarts the follow with the new tail, aborting the old one', async () => {
    renderUi(<RuntimeLogPanel projectId={PROJECT_ID} serviceId={SERVICE_ID} />);
    await settle();
    fireEvent.click(followToggle());
    const first = latest();
    fireEvent.click(screen.getByRole('radio', { name: '1,000' }));
    await settle();
    expect(first.options.signal?.aborted).toBe(true);
    expect(latest()).not.toBe(first);
    expect(latest().options.tail).toBe(1000);
    expect(latest().options.signal?.aborted).toBe(false);
  });

  it('turns Follow off and states the server reason once when the server ends the stream', async () => {
    renderUi(<RuntimeLogPanel projectId={PROJECT_ID} serviceId={SERVICE_ID} />);
    await settle();
    fireEvent.click(followToggle());
    act(() => {
      latest().finish({
        ok: true,
        reason: 'server_end',
        serverReason: 'output_limit',
      });
    });
    await settle();
    expect(followToggle().getAttribute('aria-pressed')).toBe('false');
    expect(screen.getAllByTestId('runtime-log-notice')).toHaveLength(1);
    expect(screen.getByTestId('runtime-log-notice').textContent).toMatch(/output limit/);
  });

  it('shows the typed recovery copy for the concurrent follow limit and returns Follow to off', async () => {
    renderUi(<RuntimeLogPanel projectId={PROJECT_ID} serviceId={SERVICE_ID} />);
    await settle();
    fireEvent.click(followToggle());
    act(() => {
      latest().finish({
        ok: false,
        code: 'RUNTIME_LOG_FOLLOW_LIMIT_REACHED',
        message: 'raw',
        unauthorized: false,
      });
    });
    await settle();
    expect(followToggle().getAttribute('aria-pressed')).toBe('false');
    expect(screen.getByTestId('runtime-log-notice').textContent).toBe(FOLLOW_LIMIT_COPY);
  });

  it('aborts on unmount, and 50 open/close cycles leave no live follow or timer', async () => {
    for (let round = 0; round < 50; round += 1) {
      const { unmount } = renderUi(
        <RuntimeLogPanel projectId={PROJECT_ID} serviceId={SERVICE_ID} />,
      );
      await act(async () => {
        await Promise.resolve();
      });
      fireEvent.click(followToggle());
      act(() => {
        latest().options.onLines?.([]);
      });
      unmount();
    }
    expect(follows).toHaveLength(50);
    expect(follows.every((follow) => follow.options.signal?.aborted === true)).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });
});
