// The shared EventSource's reconnect behaviour, against the two ways a browser reports a failure.
//
// A NETWORK failure leaves the EventSource in CONNECTING: the browser retries on its own. An
// HTTP-level rejection -- a non-200 answer such as the control plane's `503 SSE_LIMIT_REACHED`, or
// the proxy's own 503 while the API is down -- makes the browser FAIL the connection for good
// (HTML spec): readyState goes CLOSED, exactly one `error` fires and nothing is ever retried.
// Observed in real Chromium (debug session sse-lost-event-race, round 2): one request, one 503,
// and the page still showed "Reconnecting…" 40s after capacity had returned.
import { act } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { renderUi } from '@noodara/ui/testing';
import type { ServiceView } from './deploy-api';
import { insertServiceByName, serviceWriteFromEvent } from './deploy-store';
import type { DeployEntityEvent, DeploymentLogChunkEvent, ServerEvent } from './server-events';
import {
  useServerEvents,
  useSyncedCollection,
  type SyncedCollectionSource,
  type SyncedCollectionState,
  type SyncStream,
  type UseServerEventsResult,
} from './use-server-events';

class FakeEventSource extends EventTarget {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSED = 2;
  static instances: FakeEventSource[] = [];

  readyState: number = FakeEventSource.CONNECTING;
  closeCalls = 0;

  constructor(readonly url: string) {
    super();
    FakeEventSource.instances.push(this);
  }

  close(): void {
    this.closeCalls += 1;
    this.readyState = FakeEventSource.CLOSED;
  }

  /** The browser opened the stream. */
  open(): void {
    this.readyState = FakeEventSource.OPEN;
    this.dispatchEvent(new Event('open'));
  }

  /** The server answered with a non-200 status: the browser gives up for good. */
  rejectOverHttp(): void {
    this.readyState = FakeEventSource.CLOSED;
    this.dispatchEvent(new Event('error'));
  }

  /** One named SSE frame, as the browser delivers it to `addEventListener(type, ...)`. */
  emit(type: string, payload: unknown): void {
    const data = typeof payload === 'string' ? payload : JSON.stringify(payload);
    this.dispatchEvent(new MessageEvent(type, { data }));
  }

  /** The connection dropped at network level: the browser is already retrying on its own. */
  dropAtNetworkLevel(): void {
    this.readyState = FakeEventSource.CONNECTING;
    this.dispatchEvent(new Event('error'));
  }
}

/** Mounts the hook in a throwaway component (component tests in this app go through
 *  `@noodara/ui/testing`, never `@testing-library/react` directly). `result.current` always holds
 *  the latest render's value. */
function renderHook(): { readonly result: { current: UseServerEventsResult }; readonly unmount: () => void } {
  const result = {} as { current: UseServerEventsResult };
  function Probe(): null {
    result.current = useServerEvents();
    return null;
  }
  const { unmount } = renderUi(<Probe />);
  return { result, unmount };
}

function latest(): FakeEventSource {
  const source = FakeEventSource.instances.at(-1);
  if (source === undefined) throw new Error('no EventSource was constructed');
  return source;
}

/** Rejects the current stream over HTTP, waits out the first backoff step and returns the stream
 *  the hook opened in its place -- throwing if it never opened one. */
function rejectThenTakeFreshStream(): FakeEventSource {
  const rejected = latest();
  act(() => {
    rejected.rejectOverHttp();
    vi.advanceTimersByTime(5000);
  });
  const fresh = latest();
  if (fresh === rejected) throw new Error('the hook never opened a fresh stream');
  return fresh;
}

describe('useServerEvents reconnection', () => {
  beforeEach(() => {
    FakeEventSource.instances = [];
    vi.useFakeTimers();
    vi.stubGlobal('EventSource', FakeEventSource);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('opens a fresh stream 5 seconds after the browser gave up on an HTTP rejection', () => {
    renderHook();

    act(() => {
      latest().rejectOverHttp();
    });
    expect(FakeEventSource.instances).toHaveLength(1);
    act(() => {
      vi.advanceTimersByTime(5000);
    });

    expect(FakeEventSource.instances).toHaveLength(2);
  });

  it('reports connected once the fresh stream opens after an HTTP rejection', () => {
    const { result } = renderHook();

    const fresh = rejectThenTakeFreshStream();
    act(() => {
      fresh.open();
    });

    expect(result.current.connected).toBe(true);
  });

  it('runs every registered resync when the fresh stream opens', () => {
    const resync = vi.fn();
    const { result } = renderHook();
    result.current.registerResync(resync);

    const fresh = rejectThenTakeFreshStream();
    act(() => {
      fresh.open();
    });

    expect(resync).toHaveBeenCalledTimes(1);
  });

  it('doubles the wait after each consecutive HTTP rejection, capped at 60 seconds', () => {
    renderHook();
    const waits: number[] = [];

    for (let attempt = 0; attempt < 6; attempt += 1) {
      const before = FakeEventSource.instances.length;
      act(() => {
        latest().rejectOverHttp();
      });
      let waited = 0;
      while (FakeEventSource.instances.length === before && waited < 120_000) {
        act(() => {
          vi.advanceTimersByTime(1000);
        });
        waited += 1000;
      }
      waits.push(waited);
    }

    expect(waits).toEqual([5000, 10_000, 20_000, 40_000, 60_000, 60_000]);
  });

  it('starts the wait over at 5 seconds once a stream has opened', () => {
    renderHook();
    act(() => {
      latest().rejectOverHttp();
      vi.advanceTimersByTime(5000);
    });
    act(() => {
      latest().rejectOverHttp();
      vi.advanceTimersByTime(10_000);
    });
    act(() => {
      latest().open();
    });
    const before = FakeEventSource.instances.length;

    act(() => {
      latest().rejectOverHttp();
      vi.advanceTimersByTime(5000);
    });

    expect(FakeEventSource.instances).toHaveLength(before + 1);
  });

  it('reconnects itself when an open stream drops and the browser retry is rejected over HTTP', () => {
    renderHook();
    act(() => {
      latest().open();
    });

    act(() => {
      latest().rejectOverHttp();
      vi.advanceTimersByTime(5000);
    });

    expect(FakeEventSource.instances).toHaveLength(2);
  });

  it('leaves a network-level drop of an open stream to the browser own retry', () => {
    renderHook();
    act(() => {
      latest().open();
    });

    act(() => {
      latest().dropAtNetworkLevel();
      vi.advanceTimersByTime(120_000);
    });

    expect(FakeEventSource.instances).toHaveLength(1);
    expect(latest().closeCalls).toBe(0);
  });

  it('never reconnects after the caller closed the stream', () => {
    const { result } = renderHook();

    act(() => {
      result.current.close();
      latest().rejectOverHttp();
      vi.advanceTimersByTime(120_000);
    });

    expect(FakeEventSource.instances).toHaveLength(1);
  });

  // A drop the caller asked for (SignOutButton closing the stream before it posts sign-out) must be
  // distinguishable from a drop the server caused: the shell layout re-runs the session guard on
  // the latter only. On a slow machine the guard's own 401 redirect (`/login?redirect=/servers`)
  // otherwise overtakes the sign-out's `router.push('/login')` -- observed on GitHub's runners.
  it('reports a caller-initiated close as intentional, and a server-side drop as not', () => {
    const { result } = renderHook();
    act(() => {
      latest().open();
    });
    expect(result.current.connected).toBe(true);
    expect(result.current.closedByCaller).toBe(false);

    act(() => {
      latest().dropAtNetworkLevel();
    });
    expect(result.current.connected).toBe(false);
    expect(result.current.closedByCaller).toBe(false);

    act(() => {
      result.current.close();
    });
    expect(result.current.connected).toBe(false);
    expect(result.current.closedByCaller).toBe(true);
  });

  it('never reconnects after unmount', () => {
    const { unmount } = renderHook();
    act(() => {
      latest().rejectOverHttp();
    });

    unmount();
    act(() => {
      vi.advanceTimersByTime(120_000);
    });

    expect(FakeEventSource.instances).toHaveLength(1);
  });
});

const T1 = '2026-10-06T10:00:01.000Z';
const T2 = '2026-10-06T10:00:02.000Z';
const SVC = '7a1d5a2e-2a49-4d0e-9f0e-6f3c3d1f2a10';
const DEP_A = '2b7c1e44-6a0f-4a52-8d43-2f8e6a1c9b07';
const DEP_B = '9c0d2f55-7b1a-4b63-9e54-3a9f7b2d0c18';

function serviceView(id: string, name: string, updatedAt: string): ServiceView {
  return {
    id,
    projectId: 'p1',
    environmentId: 'e1',
    serverId: 's1',
    name,
    sourceType: 'image',
    repositoryUrl: null,
    branch: null,
    buildContext: null,
    dockerfilePath: null,
    buildTarget: null,
    imageRef: 'nginx:1.27',
    internalPort: 80,
    publishedPort: null,
    status: 'RUNNING',
    createdAt: T1,
    updatedAt,
  };
}

function logChunk(deploymentId: string, seq: number): Omit<DeploymentLogChunkEvent, 'type'> & { type: string } {
  return { type: 'deployment.log_chunk', deploymentId, phase: 'build', seq, text: `line ${String(seq)}\n`, truncated: false };
}

describe('useServerEvents deploy-engine routing (13-08)', () => {
  beforeEach(() => {
    FakeEventSource.instances = [];
    vi.useFakeTimers();
    vi.stubGlobal('EventSource', FakeEventSource);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('keeps exactly one EventSource however many lists and log panels subscribe', () => {
    const { result } = renderHook();
    act(() => {
      latest().open();
    });
    for (let i = 0; i < 20; i += 1) {
      result.current.subscribeDeploy(() => undefined);
      result.current.subscribeDeploymentLog(i % 2 === 0 ? DEP_A : DEP_B, () => undefined);
      result.current.subscribe(() => undefined);
    }
    expect(FakeEventSource.instances).toHaveLength(1);
  });

  it('hands service and deployment events to deploy listeners only, and server events to server listeners only', () => {
    const { result } = renderHook();
    const deploy: DeployEntityEvent[] = [];
    const server: ServerEvent[] = [];
    result.current.subscribeDeploy((event) => deploy.push(event));
    result.current.subscribe((event) => server.push(event));

    act(() => {
      latest().emit('service.updated', { type: 'service.updated', service: serviceView(SVC, 'api', T1) });
      latest().emit('service.deleted', { type: 'service.deleted', id: SVC });
      latest().emit('deployment.updated', {
        type: 'deployment.updated',
        deployment: { id: DEP_A, serviceId: SVC, status: 'BUILDING', errorCode: null, updatedAt: T1 },
      });
      latest().emit('server.deleted', { type: 'server.deleted', id: 'srv-1' });
      latest().emit('deployment.log_chunk', logChunk(DEP_A, 0));
    });

    expect(deploy.map((event) => event.type)).toEqual(['service.updated', 'service.deleted', 'deployment.updated']);
    expect(server.map((event) => event.type)).toEqual(['server.deleted']);
  });

  it('routes log chunks by deploymentId and delivers nothing after unsubscribe', () => {
    const { result } = renderHook();
    const a = vi.fn();
    const b = vi.fn();
    const offA = result.current.subscribeDeploymentLog(DEP_A, a);
    result.current.subscribeDeploymentLog(DEP_B, b);

    act(() => {
      latest().emit('deployment.log_chunk', logChunk(DEP_A, 0));
    });
    expect(a).toHaveBeenCalledTimes(1);
    expect(a.mock.calls[0]?.[0]).toMatchObject({ deploymentId: DEP_A, seq: 0 });
    expect(b).not.toHaveBeenCalled();

    offA();
    act(() => {
      latest().emit('deployment.log_chunk', logChunk(DEP_A, 1));
    });
    expect(a).toHaveBeenCalledTimes(1);
  });

  it('drops a log chunk nobody subscribed to without throwing or reaching any listener', () => {
    const { result } = renderHook();
    const deploy = vi.fn();
    const server = vi.fn();
    result.current.subscribeDeploy(deploy);
    result.current.subscribe(server);
    expect(() => {
      act(() => {
        latest().emit('deployment.log_chunk', logChunk(DEP_B, 0));
      });
    }).not.toThrow();
    expect(deploy).not.toHaveBeenCalled();
    expect(server).not.toHaveBeenCalled();
  });

  it('1000 log subscribe/unsubscribe cycles leave no handler that receives a chunk (leak test)', () => {
    const { result } = renderHook();
    const handler = vi.fn();
    for (let i = 0; i < 1000; i += 1) {
      result.current.subscribeDeploymentLog(i % 2 === 0 ? DEP_A : DEP_B, handler)();
    }
    act(() => {
      latest().emit('deployment.log_chunk', logChunk(DEP_A, 0));
      latest().emit('deployment.log_chunk', logChunk(DEP_B, 0));
    });
    expect(handler).not.toHaveBeenCalled();
  });

  it('ignores malformed deploy-engine frames and an invalid updatedAt without crashing the stream', () => {
    const { result } = renderHook();
    const deploy = vi.fn();
    result.current.subscribeDeploy(deploy);
    act(() => {
      latest().emit('service.updated', '{not json');
      latest().emit('service.updated', { type: 'service.updated', service: { ...serviceView(SVC, 'api', T1), updatedAt: 'later' } });
      latest().emit('deployment.updated', {
        type: 'deployment.updated',
        deployment: { id: DEP_A, serviceId: SVC, status: 'BUILDING', errorCode: null },
      });
      latest().emit('service.deleted', { type: 'service.updated', id: SVC });
    });
    expect(deploy).not.toHaveBeenCalled();

    act(() => {
      latest().emit('service.deleted', { type: 'service.deleted', id: SVC });
    });
    expect(deploy).toHaveBeenCalledTimes(1);
  });
});

/** Mounts the real shell hook and a synced service list on top of it. */
function renderServiceList(load: () => Promise<readonly ServiceView[] | null>): {
  readonly list: { current: SyncedCollectionState<ServiceView> };
  readonly unmount: () => void;
} {
  const list = {} as { current: SyncedCollectionState<ServiceView> };
  const source: SyncedCollectionSource<ServiceView> = {
    key: 'env-1',
    load,
    toWrite: (event) => serviceWriteFromEvent(event),
    reconcile: { insert: insertServiceByName },
  };
  function Probe(): null {
    const shell = useServerEvents();
    list.current = useSyncedCollection(shell, source);
    return null;
  }
  const { unmount } = renderUi(<Probe />);
  return { list, unmount };
}

describe('useSyncedCollection (13-08 H1)', () => {
  beforeEach(() => {
    FakeEventSource.instances = [];
    vi.stubGlobal('EventSource', FakeEventSource);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('loads on mount, refetches on every reconnect and reconciles the stale snapshot with the event', async () => {
    let resolveStale: ((value: readonly ServiceView[]) => void) | undefined;
    const load = vi
      .fn<() => Promise<readonly ServiceView[] | null>>()
      .mockResolvedValueOnce([serviceView(SVC, 'api', T1)])
      .mockResolvedValueOnce([serviceView(SVC, 'api', T1)])
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            resolveStale = resolve;
          }),
      );
    const { list } = renderServiceList(load);
    await act(async () => {
      await Promise.resolve();
    });
    expect(list.current.loaded).toBe(true);
    expect(load).toHaveBeenCalledTimes(1);

    await act(async () => {
      latest().open();
      await Promise.resolve();
    });
    expect(load).toHaveBeenCalledTimes(2);

    // The stream drops and the browser reconnects: a full refetch starts...
    await act(async () => {
      latest().dropAtNetworkLevel();
      latest().open();
      await Promise.resolve();
    });
    expect(load).toHaveBeenCalledTimes(3);

    // ...an update lands while it is in flight, then the snapshot (read earlier) arrives.
    await act(async () => {
      latest().emit('service.updated', { type: 'service.updated', service: serviceView(SVC, 'api-renamed', T2) });
      await Promise.resolve();
    });
    await act(async () => {
      resolveStale?.([serviceView(SVC, 'api', T1)]);
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(list.current.entities).toEqual([serviceView(SVC, 'api-renamed', T2)]);
    expect(FakeEventSource.instances).toHaveLength(1);
  });

  it('a service.deleted is never resurrected by the reconnect snapshot', async () => {
    let resolveStale: ((value: readonly ServiceView[]) => void) | undefined;
    const load = vi
      .fn<() => Promise<readonly ServiceView[] | null>>()
      .mockResolvedValueOnce([serviceView(SVC, 'api', T1)])
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            resolveStale = resolve;
          }),
      );
    const { list } = renderServiceList(load);
    await act(async () => {
      await Promise.resolve();
    });
    await act(async () => {
      latest().open();
      latest().emit('service.deleted', { type: 'service.deleted', id: SVC });
      resolveStale?.([serviceView(SVC, 'api', T1)]);
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(list.current.entities).toEqual([]);
  });

  it('unmounting removes its event listener and its resync registration', () => {
    const listeners = new Set<(event: DeployEntityEvent) => void>();
    const resyncs = new Set<() => void>();
    const stream: SyncStream = {
      subscribeDeploy: (listener) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
      registerResync: (fn) => {
        resyncs.add(fn);
        return () => resyncs.delete(fn);
      },
    };
    const source: SyncedCollectionSource<ServiceView> = {
      key: 'env-1',
      load: () => Promise.resolve([]),
      toWrite: (event) => serviceWriteFromEvent(event),
    };
    function Probe(): null {
      useSyncedCollection(stream, source);
      return null;
    }
    const { unmount } = renderUi(<Probe />);
    expect(listeners.size).toBe(1);
    expect(resyncs.size).toBe(1);
    unmount();
    expect(listeners.size).toBe(0);
    expect(resyncs.size).toBe(0);
  });
});
