import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  askQuestion,
  deleteAiSettings,
  parseSseBlock,
  putAiSettings,
  sanitizeAnswer,
  sanitizeToolCall,
  type AskEvent,
} from './ai-api';

const CONV = '0190a000-0000-7000-8000-000000000001';
const SVC = '44444444-4444-4444-8444-444444444444';
const KEY = 'sk-ant-test-0000000000000000000000000000';

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

function sseResponse(blocks: readonly string[], status = 200): Response {
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const block of blocks) controller.enqueue(encoder.encode(block));
      controller.close();
    },
  });
  return new Response(stream, { status, headers: { 'content-type': 'text/event-stream' } });
}

const frame = (event: string, data: unknown): string => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;

describe('sanitizeAnswer', () => {
  const base = { answer: 'api is crash looping', diagnosis: 'crash_loop', confidence: 0.8, entities: [], evidence: [], missingEvidence: [] };

  it('keeps a well-formed answer', () => {
    expect(sanitizeAnswer({ ...base, entities: [{ kind: 'Service', id: SVC, label: 'api' }] })).toEqual({
      ...base,
      entities: [{ kind: 'Service', id: SVC, label: 'api' }],
    });
  });

  it('drops entities with a non-UUID id, an unknown kind or no label, and duplicates', () => {
    const answer = sanitizeAnswer({
      ...base,
      entities: [
        { kind: 'Service', id: '../../admin', label: 'evil' },
        { kind: 'Secret', id: SVC, label: 'db' },
        { kind: 'Service', id: SVC, label: '' },
        { kind: 'Service', id: SVC, label: 'api' },
        { kind: 'Service', id: SVC.toUpperCase(), label: 'api again' },
        'javascript:alert(1)',
      ],
    });
    expect(answer?.entities).toEqual([{ kind: 'Service', id: SVC, label: 'api' }]);
  });

  it('falls back to unknown for an unknown diagnosis and clamps confidence', () => {
    expect(sanitizeAnswer({ ...base, diagnosis: 'pwned', confidence: 7 })).toMatchObject({ diagnosis: 'unknown', confidence: 1 });
    expect(sanitizeAnswer({ ...base, confidence: Number.NaN })?.confidence).toBe(0);
    expect(sanitizeAnswer({ ...base, confidence: -1 })?.confidence).toBe(0);
  });

  it('returns null without answer text and keeps only string missing evidence', () => {
    expect(sanitizeAnswer({ ...base, answer: '' })).toBeNull();
    expect(sanitizeAnswer(null)).toBeNull();
    expect(sanitizeAnswer({ ...base, missingEvidence: ['no metrics', 3, ''] })?.missingEvidence).toEqual(['no metrics']);
    expect(sanitizeAnswer({ ...base, evidence: [{ ref: 'call-1', note: 'oom' }, { note: 'x' }] })?.evidence).toEqual([
      { ref: 'call-1', note: 'oom' },
    ]);
  });
});

describe('sanitizeToolCall', () => {
  it('keeps a valid name and a UUID scope only', () => {
    expect(sanitizeToolCall({ name: 'get_service', scope: { kind: 'Service', id: SVC } })).toEqual({
      name: 'get_service',
      scope: { kind: 'Service', id: SVC },
    });
    expect(sanitizeToolCall({ name: 'get_service', scope: { kind: 'Service', id: 'x' } })?.scope).toBeNull();
    expect(sanitizeToolCall({ name: '<b>x</b>', scope: null })).toBeNull();
  });
});

describe('parseSseBlock', () => {
  it('parses each event type', () => {
    expect(parseSseBlock('event: start\ndata: {"messageId":"m1"}')).toEqual({ type: 'start', messageId: 'm1' });
    expect(parseSseBlock('event: text\ndata: {"text":"hi"}')).toEqual({ type: 'text', text: 'hi' });
    expect(parseSseBlock('event: error\ndata: {"error":"AI_PROVIDER_AUTH_FAILED","message":"x"}')).toEqual({
      type: 'error',
      code: 'AI_PROVIDER_AUTH_FAILED',
    });
    expect(parseSseBlock('event: error\ndata: {"error":"WHATEVER"}')).toEqual({ type: 'error', code: 'INTERNAL_ERROR' });
    expect(parseSseBlock('event: done\ndata: {"status":"complete"}')).toEqual({ type: 'done', status: 'complete' });
  });

  it('skips comments, malformed data and unknown events', () => {
    expect(parseSseBlock(': ping')).toBeNull();
    expect(parseSseBlock('event: text\ndata: {nope')).toBeNull();
    expect(parseSseBlock('event: html\ndata: {"x":1}')).toBeNull();
    expect(parseSseBlock(`event: text\ndata: ${'x'.repeat(70_000)}`)).toBeNull();
  });
});

describe('askQuestion', () => {
  it('streams parsed events split across chunks and ends', async () => {
    const body = [
      frame('start', { conversationId: CONV, questionId: 'q', messageId: 'm' }),
      ': ping\n\n',
      frame('tool_call', { name: 'list_services', scope: null }),
    ].join('');
    const answer = frame('answer', {
      answer: { answer: 'ok', diagnosis: 'unknown', confidence: 0.2, entities: [], evidence: [], missingEvidence: ['logs'] },
    });
    const fetchMock = vi.fn(() => Promise.resolve(sseResponse([body.slice(0, 30), body.slice(30), answer, frame('done', { status: 'complete' })])));
    vi.stubGlobal('fetch', fetchMock);
    const events: AskEvent[] = [];
    const result = await askQuestion({ conversationId: CONV, question: 'why?', signal: new AbortController().signal, onEvent: (e) => events.push(e) });
    expect(result).toEqual({ ok: true, reason: 'ended' });
    expect(events.map((e) => e.type)).toEqual(['start', 'tool_call', 'answer', 'done']);
    expect(fetchMock).toHaveBeenCalledWith(`/api/ai/conversations/${CONV}/messages`, expect.objectContaining({ method: 'POST' }));
  });

  it('maps a non-2xx response to a failure', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() =>
        Promise.resolve(
          new Response(JSON.stringify({ error: 'AI_PROVIDER_NOT_CONFIGURED', message: 'No AI provider is configured.' }), {
            status: 409,
            headers: { 'content-type': 'application/json' },
          }),
        ),
      ),
    );
    const result = await askQuestion({ conversationId: CONV, question: 'q', signal: new AbortController().signal, onEvent: () => undefined });
    expect(result).toMatchObject({ ok: false, code: 'AI_PROVIDER_NOT_CONFIGURED' });
  });

  it('refuses a non-UUID conversation id without a request', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const result = await askQuestion({ conversationId: '../x', question: 'q', signal: new AbortController().signal, onEvent: () => undefined });
    expect(result).toMatchObject({ ok: false, code: 'NOT_FOUND' });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('reports an abort by the caller as aborted, not a failure', async () => {
    const controller = new AbortController();
    vi.stubGlobal(
      'fetch',
      vi.fn((_url: string, init: RequestInit) => {
        return new Promise<Response>((_resolve, reject) => {
          init.signal?.addEventListener('abort', () => {
            reject(new DOMException('aborted', 'AbortError'));
          });
        });
      }),
    );
    const pending = askQuestion({ conversationId: CONV, question: 'q', signal: controller.signal, onEvent: () => undefined });
    controller.abort();
    expect(await pending).toEqual({ ok: true, reason: 'aborted' });
  });

  it('times out an unopened stream as a network failure', async () => {
    vi.useFakeTimers();
    vi.stubGlobal(
      'fetch',
      vi.fn((_url: string, init: RequestInit) => {
        return new Promise<Response>((_resolve, reject) => {
          init.signal?.addEventListener('abort', () => {
            reject(new DOMException('aborted', 'AbortError'));
          });
        });
      }),
    );
    const pending = askQuestion({ conversationId: CONV, question: 'q', signal: new AbortController().signal, onEvent: () => undefined, openTimeoutMs: 100 });
    await vi.advanceTimersByTimeAsync(150);
    expect(await pending).toMatchObject({ ok: false, code: 'NETWORK_ERROR' });
  });
});

describe('settings', () => {
  it('sends the key once and never echoes it in a failure message', async () => {
    const fetchMock = vi.fn(() =>
      Promise.resolve(
        new Response(JSON.stringify({ error: 'AI_PROVIDER_AUTH_FAILED', message: `bad key ${KEY}` }), {
          status: 422,
          headers: { 'content-type': 'application/json' },
        }),
      ),
    );
    vi.stubGlobal('fetch', fetchMock);
    const result = await putAiSettings({ provider: 'anthropic', model: 'claude-opus-5-5', apiKey: KEY });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(result.ok).toBe(false);
    expect(JSON.stringify(result)).not.toContain(KEY);
    if (!result.ok) expect(result.code).toBe('AI_PROVIDER_AUTH_FAILED');
  });

  it('deletes the settings', async () => {
    const fetchMock = vi.fn(() => Promise.resolve(new Response(null, { status: 204 })));
    vi.stubGlobal('fetch', fetchMock);
    expect((await deleteAiSettings()).ok).toBe(true);
    expect(fetchMock).toHaveBeenCalledWith('/api/settings/ai', expect.objectContaining({ method: 'DELETE' }));
  });
});
