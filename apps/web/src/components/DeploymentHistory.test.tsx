import { act } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { formatRelativeTime } from '@noodara/ui';
import { renderUi, screen, userEvent, waitFor } from '@noodara/ui/testing';
import type { DeploymentView } from '../lib/deploy-api';
import type { DeployEntityEvent } from '../lib/server-events';
import { DeploymentHistory, HISTORY_EMPTY_COPY, HISTORY_LOAD_FAILED_COPY, mergeDeployments, useDeploymentHistory } from './DeploymentHistory';

const SERVICE_ID = '44444444-4444-4444-8444-444444444444';
const OTHER_SERVICE_ID = '88888888-8888-4888-8888-888888888888';
const NOW = new Date('2026-10-06T12:00:00.000Z');
const SHA = '0123456789abcdef0123456789abcdef01234567';

const deployApi = vi.hoisted(() => ({ listDeployments: vi.fn() }));
vi.mock('../lib/deploy-api', () => ({
  listDeployments: (id: string, query: unknown) => deployApi.listDeployments(id, query) as unknown,
}));
vi.mock('../lib/require-session', () => ({ requireSession: () => undefined }));

function id(n: number): string {
  return `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
}

/** Deployment n was created n minutes before NOW: a higher n is older. */
function deployment(n: number, overrides: Partial<DeploymentView> = {}): DeploymentView {
  const created = new Date(NOW.getTime() - n * 60_000).toISOString();
  return {
    id: id(n),
    serviceId: SERVICE_ID,
    status: 'SUCCESS',
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
    commitSha: SHA,
    previousDeploymentId: null,
    startedAt: created,
    completedAt: created,
    durationMs: 83_000,
    errorCode: null,
    errorMessage: null,
    createdAt: created,
    updatedAt: created,
    ...overrides,
  };
}

const page = (items: DeploymentView[], nextCursor: string | null = null) =>
  Promise.resolve({ ok: true, data: { items, nextCursor } });
const failure = (code: string) => Promise.resolve({ ok: false, code, message: 'raw server text', unauthorized: false });

function fakeStream() {
  const listeners = new Set<(event: DeployEntityEvent) => void>();
  const resyncs = new Set<() => void>();
  return {
    subscribeDeploy: (listener: (event: DeployEntityEvent) => void) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    registerResync: (fn: () => void) => {
      resyncs.add(fn);
      return () => {
        resyncs.delete(fn);
      };
    },
    emit: (event: DeployEntityEvent) => {
      act(() => {
        for (const listener of listeners) listener(event);
      });
    },
    resync: () => {
      act(() => {
        for (const fn of resyncs) fn();
      });
    },
  };
}

function updated(n: number, status: string, updatedAt: string, serviceId = SERVICE_ID): DeployEntityEvent {
  return {
    type: 'deployment.updated',
    deployment: { id: id(n), serviceId, status, errorCode: null, updatedAt },
  } as DeployEntityEvent;
}

function Harness({ stream, pageSize }: { stream: ReturnType<typeof fakeStream>; pageSize: number }) {
  const history = useDeploymentHistory(SERVICE_ID, stream, pageSize);
  return <DeploymentHistory history={history} now={NOW} />;
}

function renderHistory(pageSize = 2) {
  const stream = fakeStream();
  const user = userEvent.setup();
  renderUi(<Harness stream={stream} pageSize={pageSize} />);
  return { stream, user };
}

function rowIds(): string[] {
  return screen.queryAllByTestId(/^deployment-row-/).map((row) => row.getAttribute('data-testid')?.replace('deployment-row-', '') ?? '');
}

beforeEach(() => {
  deployApi.listDeployments.mockReset();
});

describe('mergeDeployments', () => {
  it('upserts by id, keeps the newer version and orders newest first', () => {
    const older = deployment(1, { status: 'BUILDING', updatedAt: '2026-10-06T11:59:00.000Z' });
    const newer = deployment(1, { status: 'SUCCESS', updatedAt: '2026-10-06T11:59:30.000Z' });

    const merged = mergeDeployments([newer, deployment(3)], [older, deployment(2)]);

    expect(merged.map((row) => row.id)).toEqual([id(1), id(2), id(3)]);
    expect(merged[0]?.status).toBe('SUCCESS');
  });
});

describe('DeploymentHistory rows (13-12 A4)', () => {
  it('shows a skeleton while loading, then status, trigger, short mono SHA, duration and relative time', async () => {
    deployApi.listDeployments.mockReturnValue(page([deployment(2, { trigger: 'redeploy', status: 'FAILED' })]));
    renderHistory();

    expect(screen.queryByTestId(/^deployment-row-/)).not.toBeInTheDocument();
    const row = await screen.findByTestId(`deployment-row-${id(2)}`);
    expect(row.querySelector('[data-testid="deployment-status"]')).toHaveTextContent('Failed');
    expect(row.querySelector('[data-testid="deployment-trigger"]')).toHaveTextContent('Redeploy');
    const sha = row.querySelector('[data-testid="deployment-sha"]');
    expect(sha).toHaveTextContent(/^0123456$/);
    expect(sha).toHaveClass('font-mono');
    expect(sha).toHaveAttribute('title', SHA);
    expect(row.querySelector('[data-testid="deployment-duration"]')).toHaveTextContent('1m 23s');
    expect(row).toHaveTextContent(formatRelativeTime(deployment(2).createdAt, NOW));
    expect(deployApi.listDeployments).toHaveBeenCalledWith(SERVICE_ID, { limit: 2 });
  });

  it('shows a placeholder for a deployment with no commit or duration yet', async () => {
    deployApi.listDeployments.mockReturnValue(page([deployment(1, { commitSha: null, durationMs: null, status: 'QUEUED' })]));
    renderHistory();

    const row = await screen.findByTestId(`deployment-row-${id(1)}`);
    expect(row.querySelector('[data-testid="deployment-sha"]')?.textContent).not.toBe('');
    expect(row.querySelector('[data-testid="deployment-status"]')).toHaveTextContent('Queued');
  });

  it('shows the empty state and the fixed load error', async () => {
    deployApi.listDeployments.mockReturnValueOnce(page([]));
    renderHistory();
    expect(await screen.findByTestId('deployment-history-empty')).toHaveTextContent(HISTORY_EMPTY_COPY);
  });

  it('shows fixed copy when the first page fails, never the server text', async () => {
    deployApi.listDeployments.mockReturnValue(failure('INTERNAL'));
    renderHistory();

    expect(await screen.findByTestId('deployment-history-error')).toHaveTextContent(HISTORY_LOAD_FAILED_COPY);
    expect(screen.queryByText('raw server text')).not.toBeInTheDocument();
  });

  it('paginates by cursor, appending older deployments', async () => {
    deployApi.listDeployments.mockReturnValueOnce(page([deployment(1), deployment(2)], 'cursor-1'));
    deployApi.listDeployments.mockReturnValueOnce(page([deployment(3)], null));
    const { user } = renderHistory();

    await user.click(await screen.findByTestId('deployment-history-more'));

    await waitFor(() => {
      expect(rowIds()).toEqual([id(1), id(2), id(3)]);
    });
    expect(deployApi.listDeployments).toHaveBeenLastCalledWith(SERVICE_ID, { limit: 2, cursor: 'cursor-1' });
    expect(screen.queryByTestId('deployment-history-more')).not.toBeInTheDocument();
  });

  it('updates a row live from deployment.updated', async () => {
    deployApi.listDeployments.mockReturnValue(page([deployment(1, { status: 'BUILDING' })]));
    const { stream } = renderHistory();
    await screen.findByTestId(`deployment-row-${id(1)}`);

    stream.emit(updated(1, 'SUCCESS', '2026-10-06T12:00:30.000Z'));

    expect(screen.getByTestId(`deployment-row-${id(1)}`)).toHaveAttribute('data-status', 'SUCCESS');
  });

  it('ignores a stale event and an event for another service', async () => {
    deployApi.listDeployments.mockReturnValue(page([deployment(1, { status: 'DEPLOYING', updatedAt: '2026-10-06T12:00:00.000Z' })]));
    const { stream } = renderHistory();
    await screen.findByTestId(`deployment-row-${id(1)}`);
    const calls = deployApi.listDeployments.mock.calls.length;

    stream.emit(updated(1, 'BUILDING', '2026-10-06T11:00:00.000Z'));
    stream.emit(updated(9, 'QUEUED', '2026-10-06T12:01:00.000Z', OTHER_SERVICE_ID));

    expect(screen.getByTestId(`deployment-row-${id(1)}`)).toHaveAttribute('data-status', 'DEPLOYING');
    expect(deployApi.listDeployments.mock.calls.length).toBe(calls);
  });

  it('refetches the first page for an event about a deployment it does not show yet', async () => {
    deployApi.listDeployments.mockReturnValueOnce(page([deployment(2)]));
    const { stream } = renderHistory();
    await screen.findByTestId(`deployment-row-${id(2)}`);
    deployApi.listDeployments.mockReturnValueOnce(page([deployment(0, { status: 'QUEUED' }), deployment(2)]));

    stream.emit(updated(0, 'QUEUED', NOW.toISOString()));

    await waitFor(() => {
      expect(rowIds()).toEqual([id(0), id(2)]);
    });
  });

  it('refetches on stream resync', async () => {
    deployApi.listDeployments.mockReturnValueOnce(page([deployment(2)]));
    const { stream } = renderHistory();
    await screen.findByTestId(`deployment-row-${id(2)}`);
    deployApi.listDeployments.mockReturnValueOnce(page([deployment(1), deployment(2)]));

    stream.resync();

    await waitFor(() => {
      expect(rowIds()).toEqual([id(1), id(2)]);
    });
  });
});

describe('DeploymentHistory hardening (13-12 H2)', () => {
  it('resets to the first page when the server rejects the cursor', async () => {
    deployApi.listDeployments.mockReturnValueOnce(page([deployment(1), deployment(2)], 'expired'));
    deployApi.listDeployments.mockReturnValueOnce(failure('VALIDATION_FAILED'));
    deployApi.listDeployments.mockReturnValueOnce(page([deployment(0), deployment(1)], 'fresh'));
    const { user } = renderHistory();

    await user.click(await screen.findByTestId('deployment-history-more'));

    await waitFor(() => {
      expect(rowIds()).toEqual([id(0), id(1)]);
    });
    expect(deployApi.listDeployments).toHaveBeenLastCalledWith(SERVICE_ID, { limit: 2 });
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(screen.getByTestId('deployment-history-more')).toBeInTheDocument();
  });

  it('never duplicates a row that shows up on two pages after a new deployment shifted them', async () => {
    deployApi.listDeployments.mockReturnValueOnce(page([deployment(1), deployment(2)], 'cursor-1'));
    // A new deployment arrived meanwhile: the older page now starts with a row already shown.
    deployApi.listDeployments.mockReturnValueOnce(page([deployment(2), deployment(3)], null));
    const { user } = renderHistory();

    await user.click(await screen.findByTestId('deployment-history-more'));

    await waitFor(() => {
      expect(rowIds()).toEqual([id(1), id(2), id(3)]);
    });
  });

  it('merges deployment.updated by id without duplicating a row across pages', async () => {
    deployApi.listDeployments.mockReturnValueOnce(page([deployment(1), deployment(2)], 'cursor-1'));
    deployApi.listDeployments.mockReturnValueOnce(page([deployment(3, { status: 'BUILDING' })], null));
    const { user, stream } = renderHistory();
    await user.click(await screen.findByTestId('deployment-history-more'));
    await screen.findByTestId(`deployment-row-${id(3)}`);
    const calls = deployApi.listDeployments.mock.calls.length;

    stream.emit(updated(3, 'FAILED', NOW.toISOString()));
    stream.emit(updated(3, 'FAILED', NOW.toISOString()));

    expect(rowIds()).toEqual([id(1), id(2), id(3)]);
    expect(screen.getByTestId(`deployment-row-${id(3)}`)).toHaveAttribute('data-status', 'FAILED');
    expect(deployApi.listDeployments.mock.calls.length).toBe(calls);
  });

  it('keeps older pages when the first page refetches', async () => {
    deployApi.listDeployments.mockReturnValueOnce(page([deployment(1), deployment(2)], 'cursor-1'));
    deployApi.listDeployments.mockReturnValueOnce(page([deployment(3)], null));
    const { user, stream } = renderHistory();
    await user.click(await screen.findByTestId('deployment-history-more'));
    await screen.findByTestId(`deployment-row-${id(3)}`);
    deployApi.listDeployments.mockReturnValueOnce(page([deployment(0), deployment(1)], 'cursor-2'));

    stream.resync();

    await waitFor(() => {
      expect(rowIds()).toEqual([id(0), id(1), id(2), id(3)]);
    });
    expect(screen.queryByTestId('deployment-history-more')).not.toBeInTheDocument();
  });

  it('renders the commit SHA and trigger from the server as inert text', async () => {
    const markup = '<img src=x onerror="alert(1)">';
    deployApi.listDeployments.mockReturnValue(page([deployment(1, { commitSha: `${markup}deadbeef`, trigger: markup as DeploymentView['trigger'] })]));
    renderHistory();

    const row = await screen.findByTestId(`deployment-row-${id(1)}`);
    expect(row.querySelector('img')).toBeNull();
    expect(row.querySelector('[data-testid="deployment-trigger"]')).toHaveTextContent(markup);
    expect(row.querySelector('[data-testid="deployment-sha"]')).toHaveTextContent(markup.slice(0, 7));
  });
});
