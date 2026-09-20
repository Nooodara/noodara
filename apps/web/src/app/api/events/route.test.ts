// The streaming proxy owns the lifetime of its upstream control-plane connection. Every open
// upstream stream holds one of the control plane's capped SSE slots (D-07), so a stream whose
// browser has gone away must be torn down explicitly -- never left for the garbage collector to
// release whenever it next happens to run.
import type { NextRequest } from 'next/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { GET } from './route';

const API_ORIGIN = 'http://control-plane.test:3100';

interface UpstreamCall {
  readonly url: string;
  readonly init: RequestInit | undefined;
}

function neverEndingSseBody(): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode('retry: 5000\n\n'));
    },
  });
}

function sseResponse(): Response {
  return new Response(neverEndingSseBody(), {
    status: 200,
    headers: { 'content-type': 'text/event-stream' },
  });
}

function buildRequest(signal?: AbortSignal): NextRequest {
  const init: RequestInit = { headers: { cookie: 'session=fixture-cookie' } };
  if (signal !== undefined) init.signal = signal;
  return new Request('http://localhost:3000/api/events', init) as NextRequest;
}

function stubUpstream(respond: (init: RequestInit | undefined) => Promise<Response>): UpstreamCall[] {
  const calls: UpstreamCall[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn((url: string, init?: RequestInit) => {
      calls.push({ url, init });
      return respond(init);
    }),
  );
  return calls;
}

/** A fetch that never answers, and rejects the way the platform does once its signal aborts. */
function hangingUntilAborted(init: RequestInit | undefined): Promise<Response> {
  return new Promise((_resolve, reject) => {
    init?.signal?.addEventListener('abort', () => {
      reject(new DOMException('This operation was aborted', 'AbortError'));
    });
  });
}

describe('GET /api/events streaming proxy', () => {
  beforeEach(() => {
    vi.stubEnv('NOODARA_API_ORIGIN', API_ORIGIN);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  it('aborts the upstream stream when the browser request is aborted', async () => {
    const calls = stubUpstream(() => Promise.resolve(sseResponse()));
    const client = new AbortController();

    await GET(buildRequest(client.signal));
    client.abort();

    expect(calls[0]?.init?.signal?.aborted).toBe(true);
  });

  it('aborts the upstream stream when the returned body is cancelled', async () => {
    const calls = stubUpstream(() => Promise.resolve(sseResponse()));

    const response = await GET(buildRequest());
    await response.body?.cancel();

    expect(calls[0]?.init?.signal?.aborted).toBe(true);
  });

  it('never opens an upstream stream for a request that is already aborted', async () => {
    const calls = stubUpstream(hangingUntilAborted);
    const client = new AbortController();
    client.abort();

    await GET(buildRequest(client.signal));

    expect(calls).toHaveLength(0);
  });

  it('keeps streaming upstream bytes through to the browser unbuffered', async () => {
    stubUpstream(() => Promise.resolve(sseResponse()));

    const response = await GET(buildRequest());
    const first = await response.body?.getReader().read();

    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('text/event-stream');
    expect(new TextDecoder().decode(first?.value)).toBe('retry: 5000\n\n');
  });

  it('forwards only the cookie header to the control plane', async () => {
    const calls = stubUpstream(() => Promise.resolve(sseResponse()));

    await GET(buildRequest());

    expect(calls[0]?.url).toBe(`${API_ORIGIN}/api/events`);
    expect(new Headers(calls[0]?.init?.headers).get('cookie')).toBe('session=fixture-cookie');
    expect([...new Headers(calls[0]?.init?.headers).keys()]).toEqual(['cookie']);
  });

  it('forwards the upstream status and Retry-After when the connection cap is reached', async () => {
    stubUpstream(() =>
      Promise.resolve(
        new Response(JSON.stringify({ error: 'SSE_LIMIT_REACHED', message: 'Too many event streams open' }), {
          status: 503,
          headers: { 'content-type': 'application/json', 'retry-after': '5' },
        }),
      ),
    );

    const response = await GET(buildRequest());

    expect(response.status).toBe(503);
    expect(response.headers.get('retry-after')).toBe('5');
  });

  it('answers a fixed 503 with no error details when the control plane is unreachable', async () => {
    stubUpstream(() => Promise.reject(new TypeError('fetch failed: connect ECONNREFUSED 10.1.2.3:3100')));

    const response = await GET(buildRequest());
    const text = await response.text();

    expect(response.status).toBe(503);
    expect(response.headers.get('retry-after')).toBe('5');
    expect(JSON.parse(text)).toEqual({
      error: 'EVENTS_UPSTREAM_UNAVAILABLE',
      message: 'Live updates are temporarily unavailable',
    });
    expect(text).not.toContain('ECONNREFUSED');
    expect(text).not.toContain('10.1.2.3');
  });

  it('gives up with a 503 when the control plane sends no response headers within 10 seconds', async () => {
    vi.useFakeTimers();
    const calls = stubUpstream(hangingUntilAborted);

    const pending = GET(buildRequest());
    await vi.advanceTimersByTimeAsync(10_000);
    const response = await pending;

    expect(calls[0]?.init?.signal?.aborted).toBe(true);
    expect(response.status).toBe(503);
  });

  it('never times out a stream whose response headers already arrived', async () => {
    vi.useFakeTimers();
    const calls = stubUpstream(() => Promise.resolve(sseResponse()));

    await GET(buildRequest());
    await vi.advanceTimersByTimeAsync(60 * 60 * 1000);

    expect(calls[0]?.init?.signal?.aborted).toBe(false);
  });
});
