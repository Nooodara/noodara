// Regression tests for the servers list's snapshot/stream race (.planning/debug/
// sse-lost-event-race.md). There is no event replay, so the page's own contract is: every event
// the shared stream delivers while a `GET /api/servers` snapshot is still in flight must survive
// that snapshot landing -- never be dropped because the screen happened to be `loading`, and
// never be overwritten by an older snapshot arriving late. Both the fetch and the stream are
// driven by hand here, so the interleaving under test is exact, never timing-dependent.
import { act } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { renderUi, screen } from '@noodara/ui/testing';
import ServersPage from './page';
import type { ApiResult, ServerView } from '../../../lib/api-client';
import type { ServerEvent } from '../../../lib/server-events';
import { ShellContext, type ShellContextValue } from '../../../lib/shell-context';

interface ListServersResponse {
  readonly items: ServerView[];
}

const pendingGets: ((result: ApiResult<ListServersResponse>) => void)[] = [];

vi.mock('../../../lib/api-client', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../lib/api-client')>()),
  apiGet: vi.fn(
    () =>
      new Promise((resolve) => {
        pendingGets.push(resolve);
      }),
  ),
}));

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn() }),
}));

function buildServer(overrides: Partial<ServerView> & Pick<ServerView, 'id' | 'name'>): ServerView {
  return {
    host: 'example.test',
    sshPort: 22,
    sshUser: 'root',
    status: 'PENDING',
    hostFingerprint: null,
    hostFingerprintCapturedAt: null,
    pendingFingerprint: null,
    pendingFingerprintSeenAt: null,
    hostname: null,
    osDistribution: null,
    osVersion: null,
    arch: null,
    cpuCores: null,
    ramMb: null,
    diskTotalMb: null,
    diskUsedMb: null,
    uptimeSeconds: null,
    dockerInstalled: null,
    dockerVersion: null,
    dockerComposeVersion: null,
    lastSeenAt: null,
    lastErrorCode: null,
    createdAt: '2026-09-19T00:00:00.000Z',
    updatedAt: '2026-09-19T00:00:00.000Z',
    credentialType: 'ssh_password',
    ...overrides,
  };
}

interface Harness {
  emit(event: ServerEvent): void;
  /** What `use-server-events.ts` does on every stream `open`. */
  openStream(): void;
  /** Resolves the oldest still-pending `GET /api/servers` with `items`. */
  resolveOldestGet(items: ServerView[]): Promise<void>;
  /** Resolves the newest still-pending `GET /api/servers` with `items`. */
  resolveNewestGet(items: ServerView[]): Promise<void>;
}

function renderPage(): Harness {
  const listeners = new Set<(event: ServerEvent) => void>();
  const resyncs = new Set<() => void>();
  const shell: ShellContextValue = {
    connected: true,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    registerResync: (fn) => {
      resyncs.add(fn);
      return () => resyncs.delete(fn);
    },
    close: () => undefined,
    closedByCaller: false,
    mobileNavOpen: false,
    toggleMobileNav: () => undefined,
    closeMobileNav: () => undefined,
  };

  renderUi(
    <ShellContext.Provider value={shell}>
      <ServersPage />
    </ShellContext.Provider>,
  );

  async function settle(resolve: ((result: ApiResult<ListServersResponse>) => void) | undefined, items: ServerView[]): Promise<void> {
    if (resolve === undefined) throw new Error('no pending GET /api/servers to resolve');
    await act(async () => {
      resolve({ ok: true, data: { items } });
      await Promise.resolve();
    });
  }

  return {
    emit: (event) => {
      act(() => {
        for (const listener of listeners) listener(event);
      });
    },
    openStream: () => {
      act(() => {
        for (const resync of resyncs) resync();
      });
    },
    resolveOldestGet: (items) => settle(pendingGets.shift(), items),
    resolveNewestGet: (items) => settle(pendingGets.pop(), items),
  };
}

beforeEach(() => {
  pendingGets.length = 0;
});

describe('ServersPage snapshot/stream race', () => {
  it('keeps a server whose event arrives while the snapshot that predates it is still in flight', async () => {
    const page = renderPage();
    const created = buildServer({ id: 'a1', name: 'created-mid-flight' });

    page.emit({ type: 'server.updated', server: created });
    await page.resolveOldestGet([]); // this snapshot was read before the server existed

    expect(screen.getByText('created-mid-flight')).toBeInTheDocument();
  });

  it('keeps a deletion whose event arrives while the snapshot that still lists the server is in flight', async () => {
    const page = renderPage();
    const doomed = buildServer({ id: 'd1', name: 'deleted-mid-flight' });

    page.emit({ type: 'server.deleted', id: 'd1' });
    await page.resolveOldestGet([doomed]);

    expect(screen.queryByText('deleted-mid-flight')).not.toBeInTheDocument();
  });

  it('never lets a buffered older event regress a server the snapshot already has a newer version of', async () => {
    const page = renderPage();
    const older = buildServer({ id: 's1', name: 'srv', status: 'CONNECTING', updatedAt: '2026-09-19T10:00:00.000Z' });
    const newer = buildServer({ id: 's1', name: 'srv', status: 'CONNECTED', updatedAt: '2026-09-19T10:00:05.000Z' });

    page.emit({ type: 'server.updated', server: older });
    await page.resolveOldestGet([newer]);

    expect(screen.getByTestId('status-pill')).toHaveAttribute('data-status', 'CONNECTED');
  });

  it('never lets the mount snapshot, landing late, overwrite the fresher resync-on-open snapshot', async () => {
    const page = renderPage();
    const created = buildServer({ id: 'a2', name: 'only-in-resync-snapshot' });

    page.openStream(); // second GET, sent after the stream registered
    await page.resolveNewestGet([created]);
    await page.resolveOldestGet([]); // the mount GET, read before the server existed, lands last

    expect(screen.getByText('only-in-resync-snapshot')).toBeInTheDocument();
  });

  // The shape behind a `row.hover()` that hangs on a row the test had just seen (servers-list.
  // spec.ts's row-menu test): with both GETs in flight, the first one landing made the list
  // `ready`, the event inserted the row, and the second snapshot -- read before the insert --
  // then replaced the list without it.
  it('never removes a row a live event already inserted when a snapshot read before it lands afterwards', async () => {
    const page = renderPage();
    const created = buildServer({ id: 'a3', name: 'inserted-then-overwritten' });

    page.openStream(); // both the mount GET and the resync GET are now in flight
    await page.resolveOldestGet([]);
    page.emit({ type: 'server.updated', server: created });
    await page.resolveOldestGet([]); // the resync snapshot, also read before the insert

    expect(screen.getByText('inserted-then-overwritten')).toBeInTheDocument();
  });
});
