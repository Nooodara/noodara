// The shared EventSource's reconnect behaviour, against the two ways a browser reports a failure.
//
// A NETWORK failure leaves the EventSource in CONNECTING: the browser retries on its own. An
// HTTP-level rejection -- a non-200 answer such as the control plane's `503 SSE_LIMIT_REACHED`, or
// the proxy's own 503 while the API is down -- makes the browser FAIL the connection for good
// (HTML spec): readyState goes CLOSED, exactly one `error` fires and nothing is ever retried.
// Observed in real Chromium (debug session sse-lost-event-race, round 2): one request, one 503,
// and the page still showed "Reconnecting…" 40s after capacity had returned.
import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useServerEvents } from './use-server-events';

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

  /** The connection dropped at network level: the browser is already retrying on its own. */
  dropAtNetworkLevel(): void {
    this.readyState = FakeEventSource.CONNECTING;
    this.dispatchEvent(new Event('error'));
  }
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
    renderHook(() => useServerEvents());

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
    const { result } = renderHook(() => useServerEvents());

    const fresh = rejectThenTakeFreshStream();
    act(() => {
      fresh.open();
    });

    expect(result.current.connected).toBe(true);
  });

  it('runs every registered resync when the fresh stream opens', () => {
    const resync = vi.fn();
    const { result } = renderHook(() => useServerEvents());
    result.current.registerResync(resync);

    const fresh = rejectThenTakeFreshStream();
    act(() => {
      fresh.open();
    });

    expect(resync).toHaveBeenCalledTimes(1);
  });

  it('doubles the wait after each consecutive HTTP rejection, capped at 60 seconds', () => {
    renderHook(() => useServerEvents());
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
    renderHook(() => useServerEvents());
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
    renderHook(() => useServerEvents());
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
    renderHook(() => useServerEvents());
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
    const { result } = renderHook(() => useServerEvents());

    act(() => {
      result.current.close();
      latest().rejectOverHttp();
      vi.advanceTimersByTime(120_000);
    });

    expect(FakeEventSource.instances).toHaveLength(1);
  });

  it('never reconnects after unmount', () => {
    const { unmount } = renderHook(() => useServerEvents());
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
