import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  followServiceLogs,
  FrameSplitter,
  getServiceLogs,
  LOG_SEARCH_MAX_LENGTH,
  logsQueryString,
  parseFollowFrame,
  type LogEntryView,
} from './logs-api';

const PROJECT_ID = '22222222-2222-4222-8222-222222222222';
const SERVICE_ID = '33333333-3333-4333-8333-333333333333';
const BASE = `/api/projects/${PROJECT_ID}/services/${SERVICE_ID}/logs/entries`;

const ENTRY: LogEntryView = {
  source: 'runtime',
  timestamp: '2026-11-05T10:00:00.000Z',
  level: 'info',
  stream: 'stdout',
  text: 'hello',
  truncated: false,
};

function streamBody(chunks: readonly string[], close = true): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      if (close) controller.close();
    },
  });
}

describe('logs-api', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('builds the query: sources joined, empty search left out, search capped', () => {
    expect(logsQueryString({ sources: ['build', 'runtime'], level: null, search: '' })).toBe('sources=build%2Cruntime');
    const long = logsQueryString({ sources: ['build'], level: 'warn', search: 'x'.repeat(500), limit: 10 });
    const params = new URLSearchParams(long);
    expect(params.get('level')).toBe('warn');
    expect(params.get('limit')).toBe('10');
    expect(params.get('search')).toHaveLength(LOG_SEARCH_MAX_LENGTH);
    const follow = new URLSearchParams(logsQueryString({ sources: ['build'], until: 'u', limit: 3 }, true));
    expect(follow.has('until')).toBe(false);
    expect(follow.has('limit')).toBe(false);
  });

  it('reads one page from the entries route', async () => {
    const fetchMock = vi.fn(() =>
      Promise.resolve(
        new Response(
          JSON.stringify({ entries: [ENTRY], since: 's', until: 'u', nextUntil: null, unavailableSources: [], nextCursor: null, truncated: false }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        ),
      ),
    );
    vi.stubGlobal('fetch', fetchMock);
    const result = await getServiceLogs(PROJECT_ID, SERVICE_ID, { sources: ['runtime'] });
    expect(result.ok).toBe(true);
    const call = fetchMock.mock.calls[0] as unknown as [string];
    expect(call[0]).toBe(`${BASE}?sources=runtime`);
  });

  it('keeps LOG_SOURCE_UNAVAILABLE typed and never fetches a malformed id', async () => {
    const fetchMock = vi.fn(() =>
      Promise.resolve(
        new Response(JSON.stringify({ error: 'LOG_SOURCE_UNAVAILABLE', message: 'x' }), {
          status: 502,
          headers: { 'content-type': 'application/json' },
        }),
      ),
    );
    vi.stubGlobal('fetch', fetchMock);
    const failed = await getServiceLogs(PROJECT_ID, SERVICE_ID, { sources: ['runtime'] });
    expect(failed.ok ? null : failed.code).toBe('LOG_SOURCE_UNAVAILABLE');
    const bad = await getServiceLogs('../x', SERVICE_ID, { sources: ['runtime'] });
    expect(bad.ok ? null : bad.code).toBe('NOT_FOUND');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('parses frames defensively', () => {
    expect(parseFollowFrame('{"type":"entry","entry":' + JSON.stringify(ENTRY) + '}')).toEqual({ kind: 'entry', entry: ENTRY });
    expect(parseFollowFrame('{"type":"entry","entry":{"source":"nope"}}').kind).toBe('skip');
    expect(parseFollowFrame('{"type":"entry","entry":{"source":"build","timestamp":"t","text":"x","level":"loud"}}').kind).toBe('skip');
    expect(parseFollowFrame('{"type":"unavailable","source":"runtime"}')).toEqual({ kind: 'unavailable', source: 'runtime' });
    expect(parseFollowFrame('{"type":"unavailable","source":"x"}').kind).toBe('skip');
    expect(parseFollowFrame('{"type":"end","reason":"idle"}')).toEqual({ kind: 'end', reason: 'idle' });
    expect(parseFollowFrame('{"type":"end","reason":"weird"}')).toEqual({ kind: 'end', reason: 'unknown' });
    expect(parseFollowFrame('not json').kind).toBe('skip');
    expect(parseFollowFrame('7').kind).toBe('skip');
    expect(parseFollowFrame('{"type":"other"}').kind).toBe('skip');
  });

  it('reassembles split frames and drops oversized ones', () => {
    const splitter = new FrameSplitter(10);
    expect(splitter.push('{"a":')).toEqual([]);
    expect(splitter.push('1}\n{"b":2}\n')).toEqual(['{"a":1}', '{"b":2}']);
    expect(splitter.push('x'.repeat(20))).toEqual([]);
    expect(splitter.push('yyy\nok\n')).toEqual(['ok']);
    expect(splitter.push('tail')).toEqual([]);
    expect(splitter.flush()).toEqual(['tail']);
  });

  it('follows: hands out entries, reports unavailable sources and ends on the end frame', async () => {
    const body = streamBody([
      `{"type":"unavailable","source":"runtime","error":"LOG_SOURCE_UNAVAILABLE"}\n{"type":"entry","entry":${JSON.stringify(ENTRY)}}\n`,
      'garbage\n{"type":"end","reason":"idle"}\n',
    ]);
    const fetchMock = vi.fn((_url: string, _init: RequestInit) => Promise.resolve(new Response(body, { status: 200 })));
    vi.stubGlobal('fetch', fetchMock);
    const entries: LogEntryView[] = [];
    const unavailable: string[] = [];
    const result = await followServiceLogs({
      projectId: PROJECT_ID,
      serviceId: SERVICE_ID,
      query: { sources: ['runtime', 'build'] },
      signal: new AbortController().signal,
      onEntries: (batch) => entries.push(...batch),
      onUnavailable: (source) => unavailable.push(source),
    });
    expect(result).toEqual({ ok: true, reason: 'server_end', serverReason: 'idle' });
    expect(entries).toEqual([ENTRY]);
    expect(unavailable).toEqual(['runtime']);
    expect(fetchMock.mock.calls[0]?.[0]).toBe(`${BASE}/follow?sources=runtime%2Cbuild`);
  });

  it('follows: aborting cancels the open stream', async () => {
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>({
      cancel() {
        cancelled = true;
      },
    });
    let seenSignal: AbortSignal | undefined;
    vi.stubGlobal(
      'fetch',
      vi.fn((_url: string, init: RequestInit) => {
        seenSignal = init.signal ?? undefined;
        return Promise.resolve(new Response(body, { status: 200 }));
      }),
    );
    const controller = new AbortController();
    const done = followServiceLogs({
      projectId: PROJECT_ID,
      serviceId: SERVICE_ID,
      query: { sources: ['runtime'] },
      signal: controller.signal,
      onEntries: () => undefined,
    });
    await new Promise((resolve) => setTimeout(resolve, 10));
    controller.abort();
    expect(await done).toEqual({ ok: true, reason: 'aborted' });
    expect(cancelled).toBe(true);
    expect(seenSignal?.aborted).toBe(true);
  });

  it('follows: a body that closes without an end frame is a dropped connection', async () => {
    vi.stubGlobal('fetch', vi.fn(() => Promise.resolve(new Response(streamBody(['']), { status: 200 }))));
    const result = await followServiceLogs({
      projectId: PROJECT_ID,
      serviceId: SERVICE_ID,
      query: { sources: ['runtime'] },
      signal: new AbortController().signal,
      onEntries: () => undefined,
    });
    expect(result.ok ? null : result.code).toBe('NETWORK_ERROR');
  });

  it('follows: maps an HTTP failure, a rejected fetch, an already aborted signal and a bad id', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() =>
        Promise.resolve(
          new Response(JSON.stringify({ error: 'RUNTIME_LOG_FOLLOW_LIMIT_REACHED', message: 'm' }), {
            status: 429,
            headers: { 'content-type': 'application/json' },
          }),
        ),
      ),
    );
    const base = { projectId: PROJECT_ID, serviceId: SERVICE_ID, query: { sources: ['runtime'] as const }, onEntries: () => undefined };
    const limited = await followServiceLogs({ ...base, signal: new AbortController().signal });
    expect(limited.ok ? null : limited.code).toBe('RUNTIME_LOG_FOLLOW_LIMIT_REACHED');

    vi.stubGlobal('fetch', vi.fn(() => Promise.reject(new Error('offline'))));
    const offline = await followServiceLogs({ ...base, signal: new AbortController().signal });
    expect(offline.ok ? null : offline.code).toBe('NETWORK_ERROR');

    expect(await followServiceLogs({ ...base, signal: AbortSignal.abort() })).toEqual({ ok: true, reason: 'aborted' });
    const bad = await followServiceLogs({ ...base, serviceId: 'x', signal: new AbortController().signal });
    expect(bad.ok ? null : bad.code).toBe('NOT_FOUND');
  });
});
