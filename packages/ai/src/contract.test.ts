import { inspect } from 'node:util';
import { secretValue } from '@noodara/domain/security';
import { http, HttpResponse } from 'msw';
import { setupServer } from 'msw/node';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import {
  AI_PROVIDER_IDS,
  AIProviderConfigError,
  AIProviderError,
  createAIProvider,
  IMPLEMENTED_AI_PROVIDER_IDS,
  type AICallLimits,
  type AIProvider,
  type AIStreamChunk,
  type AIToolCallRequest,
  type ImplementedAIProviderId,
} from './index.js';

// Shared contract (A1, A2, A4, H1): the same scenarios run against both providers through MSW
// at the real vendor URLs. The canary key must never appear anywhere but the auth header.

const CANARY = 'sk-CANARY-7f3c9a1e5b2d4c6e8f0a1b2c3d4e5f60';
const encoder = new TextEncoder();

interface Fixture {
  readonly id: ImplementedAIProviderId;
  readonly url: string;
  authOk(request: Request): boolean;
  text(text: string): unknown;
  toolUse(id: string, name: string, input: Record<string, unknown>): unknown;
  sseText(parts: readonly string[]): string;
  sseTool(id: string, name: string, jsonParts: readonly string[]): string;
  /** First SSE event only: the stream never finishes. */
  sseHead(): string;
  hasToolResult(body: unknown, toolCallId: string): boolean;
}

function sse(events: readonly [string | null, unknown][]): string {
  return events
    .map(([event, data]) => `${event === null ? '' : `event: ${event}\n`}data: ${typeof data === 'string' ? data : JSON.stringify(data)}\n\n`)
    .join('');
}

const anthropicStart = { type: 'message_start', message: { id: 'msg_1', type: 'message', role: 'assistant', model: 'claude-opus-5-5', content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 12, output_tokens: 1 } } };

const anthropic: Fixture = {
  id: 'anthropic',
  url: 'https://api.anthropic.com/v1/messages',
  authOk: (request) => request.headers.get('x-api-key') === CANARY && request.headers.get('authorization') === null,
  text: (text) => ({
    id: 'msg_1',
    type: 'message',
    role: 'assistant',
    model: 'claude-opus-5-5',
    content: [
      { type: 'thinking', thinking: 'considering', signature: 'sig-1' },
      { type: 'text', text },
    ],
    stop_reason: 'end_turn',
    stop_sequence: null,
    usage: { input_tokens: 12, output_tokens: 5 },
  }),
  toolUse: (id, name, input) => ({
    id: 'msg_2',
    type: 'message',
    role: 'assistant',
    model: 'claude-opus-5-5',
    content: [{ type: 'tool_use', id, name, input }],
    stop_reason: 'tool_use',
    stop_sequence: null,
    usage: { input_tokens: 12, output_tokens: 7 },
  }),
  sseText: (parts) =>
    sse([
      ['message_start', anthropicStart],
      ['content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }],
      ['ping', { type: 'ping' }],
      ...parts.map((text): [string, unknown] => ['content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } }]),
      ['content_block_stop', { type: 'content_block_stop', index: 0 }],
      ['message_delta', { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 5 } }],
      ['message_stop', { type: 'message_stop' }],
    ]),
  sseTool: (id, name, jsonParts) =>
    sse([
      ['message_start', anthropicStart],
      ['content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id, name, input: {} } }],
      ...jsonParts.map((partial_json): [string, unknown] => ['content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json } }]),
      ['content_block_stop', { type: 'content_block_stop', index: 0 }],
      ['message_delta', { type: 'message_delta', delta: { stop_reason: 'tool_use', stop_sequence: null }, usage: { output_tokens: 9 } }],
      ['message_stop', { type: 'message_stop' }],
    ]),
  sseHead: () => sse([['message_start', anthropicStart]]),
  hasToolResult: (body, toolCallId) =>
    JSON.stringify((body as { messages: unknown[] }).messages).includes(`"tool_use_id":"${toolCallId}"`),
};

const openaiChunk = (delta: unknown, finish: string | null = null) => ({
  id: 'c1',
  object: 'chat.completion.chunk',
  created: 1,
  model: 'gpt-5-2025-08-07',
  choices: [{ index: 0, delta, finish_reason: finish }],
});
const openaiUsage = { id: 'c1', object: 'chat.completion.chunk', created: 1, model: 'gpt-5-2025-08-07', choices: [], usage: { prompt_tokens: 12, completion_tokens: 5, total_tokens: 17 } };

const openai: Fixture = {
  id: 'openai',
  url: 'https://api.openai.com/v1/chat/completions',
  authOk: (request) => request.headers.get('authorization') === `Bearer ${CANARY}` && request.headers.get('x-api-key') === null,
  text: (text) => ({
    id: 'cmpl_1',
    object: 'chat.completion',
    created: 1,
    model: 'gpt-5-2025-08-07',
    choices: [{ index: 0, message: { role: 'assistant', content: text, refusal: null }, finish_reason: 'stop' }],
    usage: { prompt_tokens: 12, completion_tokens: 5, total_tokens: 17 },
  }),
  toolUse: (id, name, input) => ({
    id: 'cmpl_2',
    object: 'chat.completion',
    created: 1,
    model: 'gpt-5-2025-08-07',
    choices: [
      {
        index: 0,
        message: { role: 'assistant', content: null, tool_calls: [{ id, type: 'function', function: { name, arguments: JSON.stringify(input) } }] },
        finish_reason: 'tool_calls',
      },
    ],
    usage: { prompt_tokens: 12, completion_tokens: 7, total_tokens: 19 },
  }),
  sseText: (parts) =>
    sse([
      [null, openaiChunk({ role: 'assistant', content: '' })],
      ...parts.map((content): [null, unknown] => [null, openaiChunk({ content })]),
      [null, openaiChunk({}, 'stop')],
      [null, openaiUsage],
      [null, '[DONE]'],
    ]),
  sseTool: (id, name, jsonParts) =>
    sse([
      [null, openaiChunk({ role: 'assistant', tool_calls: [{ index: 0, id, type: 'function', function: { name, arguments: '' } }] })],
      ...jsonParts.map((args): [null, unknown] => [null, openaiChunk({ tool_calls: [{ index: 0, function: { arguments: args } }] })]),
      [null, openaiChunk({}, 'tool_calls')],
      [null, openaiUsage],
      [null, '[DONE]'],
    ]),
  sseHead: () => sse([[null, openaiChunk({ role: 'assistant', content: 'Hel' })]]),
  hasToolResult: (body, toolCallId) =>
    (body as { messages: { role: string; tool_call_id?: string }[] }).messages.some(
      (message) => message.role === 'tool' && message.tool_call_id === toolCallId,
    ),
};

const server = setupServer();
const seen: { url: string; headers: [string, string][]; authOk: boolean }[] = [];
const errors: unknown[] = [];
const sleeps: number[] = [];

const fastLimits: Partial<AICallLimits> = {
  timeoutMs: 2_000,
  idleTimeoutMs: 500,
  sleep: (ms) => {
    sleeps.push(ms);
    return Promise.resolve();
  },
};

function build(id: ImplementedAIProviderId, limits: Partial<AICallLimits> = {}, fetchImpl?: typeof fetch): AIProvider {
  return createAIProvider({
    id,
    apiKey: secretValue(CANARY, 'ai_provider_key'),
    limits: { ...fastLimits, ...limits },
    ...(fetchImpl === undefined ? {} : { fetch: fetchImpl }),
  });
}

async function capture(promise: Promise<unknown>): Promise<AIProviderError> {
  try {
    await promise;
  } catch (error) {
    errors.push(error);
    expect(error).toBeInstanceOf(AIProviderError);
    return error as AIProviderError;
  }
  throw new Error('expected an AIProviderError');
}

async function collect(stream: AsyncIterable<AIStreamChunk>): Promise<AIStreamChunk[]> {
  const chunks: AIStreamChunk[] = [];
  for await (const chunk of stream) chunks.push(chunk);
  return chunks;
}

function sseResponse(body: string, init: ResponseInit = {}): Response {
  return new Response(body, { ...init, headers: { 'content-type': 'text/event-stream' } });
}

const ask = { messages: [{ role: 'user' as const, content: 'Is web-1 healthy?' }] };
const statusTool = {
  name: 'get_service_status',
  description: 'Read the status of a service',
  inputSchema: { type: 'object', properties: { serviceId: { type: 'string' } }, required: ['serviceId'], additionalProperties: false },
};
const toolRequest: AIToolCallRequest = { ...ask, tools: [statusTool] };

beforeAll(() => {
  server.listen({ onUnhandledRequest: 'error' });
  server.events.on('request:start', ({ request }) => {
    seen.push({ url: request.url, headers: [...request.headers.entries()], authOk: anthropic.authOk(request) || openai.authOk(request) });
  });
});
afterEach(() => {
  server.resetHandlers();
});
afterAll(() => {
  server.close();
});

describe('provider registry (A1)', () => {
  it('knows six provider ids and implements only anthropic and openai', () => {
    expect([...AI_PROVIDER_IDS]).toEqual(['anthropic', 'openai', 'openai-compatible', 'openrouter', 'azure-openai', 'bedrock']);
    expect([...IMPLEMENTED_AI_PROVIDER_IDS]).toEqual(['anthropic', 'openai']);
    for (const id of ['openai-compatible', 'openrouter', 'azure-openai', 'bedrock']) {
      expect(() => createAIProvider({ id, apiKey: secretValue(CANARY, 'ai_provider_key') })).toThrow(
        expect.objectContaining({ reason: 'not_implemented' }),
      );
    }
    expect(() => createAIProvider({ id: 'gemini', apiKey: secretValue(CANARY, 'ai_provider_key') })).toThrow(AIProviderConfigError);
  });

  it('pins the model to the domain allowlist', () => {
    expect(build('anthropic').model).toBe('claude-opus-5-5');
    expect(build('openai').model).toBe('gpt-5-2025-08-07');
    expect(() => createAIProvider({ id: 'openai', model: 'gpt-0', apiKey: secretValue(CANARY, 'ai_provider_key') })).toThrow(
      expect.objectContaining({ reason: 'invalid_model' }),
    );
  });

  it('rejects an empty or duplicated tool list before any request', () => {
    const provider = build('anthropic');
    expect(() => provider.toolCall({ ...ask, tools: [statusTool, statusTool] })).toThrow(AIProviderConfigError);
  });
});

describe.each([anthropic, openai])('$id provider contract', (fixture) => {
  it('returns a plain answer with usage and the key only in the auth header', async () => {
    let body: Record<string, unknown> = {};
    server.use(
      http.post(fixture.url, async ({ request }) => {
        if (!fixture.authOk(request)) return HttpResponse.json({}, { status: 401 });
        body = (await request.json()) as Record<string, unknown>;
        return HttpResponse.json(fixture.text('web-1 is healthy.'));
      }),
    );
    const response = await build(fixture.id).chat({ ...ask, system: 'You are read-only.' });
    expect(response.text).toBe('web-1 is healthy.');
    expect(response.stopReason).toBe('end_turn');
    expect(response.toolCalls).toEqual([]);
    expect(response.usage).toEqual({ inputTokens: 12, outputTokens: 5 });
    expect(body).not.toHaveProperty('tools');
    expect(body.model).toBe(fixture.id === 'anthropic' ? 'claude-opus-5-5' : 'gpt-5-2025-08-07');
  });

  it('completes a tool use round trip', async () => {
    let calls = 0;
    server.use(
      http.post(fixture.url, async ({ request }) => {
        calls += 1;
        const body = (await request.json()) as { tools?: unknown[] };
        expect(body.tools).toHaveLength(1);
        if (calls === 1) return HttpResponse.json(fixture.toolUse('call_1', 'get_service_status', { serviceId: 'svc_1' }));
        expect(fixture.hasToolResult(body, 'call_1')).toBe(true);
        return HttpResponse.json(fixture.text('svc_1 is running.'));
      }),
    );
    const provider = build(fixture.id);
    const first = await provider.toolCall(toolRequest);
    expect(first.stopReason).toBe('tool_use');
    expect(first.toolCalls).toEqual([{ id: 'call_1', name: 'get_service_status', input: { serviceId: 'svc_1' } }]);
    const second = await provider.toolCall({
      ...toolRequest,
      messages: [...ask.messages, first.message, { role: 'tool', results: [{ toolCallId: 'call_1', content: '{"status":"running"}', isError: false }] }],
    });
    expect(second.text).toBe('svc_1 is running.');
    expect(calls).toBe(2);
  });

  it('rejects a call to a tool that was not offered', async () => {
    server.use(http.post(fixture.url, () => HttpResponse.json(fixture.toolUse('call_9', 'delete_server', { id: 'x' }))));
    const error = await capture(build(fixture.id).toolCall(toolRequest));
    expect(error.code).toBe('AI_PROVIDER_UNAVAILABLE');
    expect(error.reason).toBe('unexpected_tool');
  });

  it('streams text chunks and ends with one done chunk', async () => {
    server.use(http.post(fixture.url, () => sseResponse(fixture.sseText(['web-1 ', 'is ', 'healthy.']))));
    const chunks = await collect(build(fixture.id).stream(ask));
    expect(chunks.filter((c) => c.type === 'text_delta').map((c) => c.text)).toEqual(['web-1 ', 'is ', 'healthy.']);
    const done = chunks.at(-1);
    expect(done?.type).toBe('done');
    if (done?.type === 'done') {
      expect(done.response.text).toBe('web-1 is healthy.');
      expect(done.response.stopReason).toBe('end_turn');
    }
  });

  it('streams a tool call assembled from argument fragments', async () => {
    server.use(http.post(fixture.url, () => sseResponse(fixture.sseTool('call_2', 'get_service_status', ['{"serviceId"', ':"svc_2"}']))));
    const chunks = await collect(build(fixture.id).stream({ ...ask, tools: [statusTool] }));
    expect(chunks).toContainEqual({ type: 'tool_call', call: { id: 'call_2', name: 'get_service_status', input: { serviceId: 'svc_2' } } });
    expect(chunks.at(-1)).toMatchObject({ type: 'done', response: { stopReason: 'tool_use' } });
  });

  it.each([
    [401, 'AI_PROVIDER_AUTH_FAILED', 'auth', 1],
    [403, 'AI_PROVIDER_AUTH_FAILED', 'forbidden', 1],
    [429, 'AI_PROVIDER_RATE_LIMITED', 'rate_limited', 3],
    [500, 'AI_PROVIDER_UNAVAILABLE', 'server_error', 3],
    [503, 'AI_PROVIDER_UNAVAILABLE', 'server_error', 3],
    [529, 'AI_PROVIDER_UNAVAILABLE', 'server_error', 3],
  ] as const)('maps HTTP %i to %s (attempts: %i)', async (status, code, reason, attempts) => {
    let calls = 0;
    server.use(
      http.post(fixture.url, () => {
        calls += 1;
        // A hostile body echoing the key must not reach the error.
        return HttpResponse.json({ error: { type: 'error', message: `bad key ${CANARY}` } }, { status });
      }),
    );
    const error = await capture(build(fixture.id).chat(ask));
    expect(error.code).toBe(code);
    expect(error.reason).toBe(reason);
    expect(error.status).toBe(status);
    expect(calls).toBe(attempts);
    const streamError = await capture(collect(build(fixture.id).stream(ask)));
    expect(streamError.code).toBe(code);
  });

  it('honors Retry-After on 429 and then succeeds', async () => {
    let calls = 0;
    sleeps.length = 0;
    server.use(
      http.post(fixture.url, () => {
        calls += 1;
        if (calls === 1) return HttpResponse.json({}, { status: 429, headers: { 'retry-after': '2' } });
        return HttpResponse.json(fixture.text('ok'));
      }),
    );
    const response = await build(fixture.id).chat(ask);
    expect(response.text).toBe('ok');
    expect(sleeps).toEqual([2_000]);
  });

  it('fails fast when Retry-After exceeds the backoff cap', async () => {
    let calls = 0;
    server.use(
      http.post(fixture.url, () => {
        calls += 1;
        return HttpResponse.json({}, { status: 429, headers: { 'retry-after': '120' } });
      }),
    );
    const error = await capture(build(fixture.id, { retryMaxDelayMs: 10_000 }).chat(ask));
    expect(error.code).toBe('AI_PROVIDER_RATE_LIMITED');
    expect(error.retryAfterMs).toBe(120_000);
    expect(calls).toBe(1);
  });

  it('maps a call over its deadline to AI_PROVIDER_UNAVAILABLE', async () => {
    server.use(
      http.post(fixture.url, async () => {
        await new Promise((resolve) => setTimeout(resolve, 1_500));
        return HttpResponse.json(fixture.text('late'));
      }),
    );
    const started = Date.now();
    const error = await capture(build(fixture.id, { timeoutMs: 150 }).chat(ask));
    expect(error.code).toBe('AI_PROVIDER_UNAVAILABLE');
    expect(error.reason).toBe('timeout');
    expect(Date.now() - started).toBeLessThan(1_000);
  });

  it.each([
    ['malformed JSON', () => new Response('{"choices": [', { headers: { 'content-type': 'application/json' } })],
    ['unexpected JSON', () => HttpResponse.json({ hello: 'world' })],
    ['an oversized body', () => HttpResponse.json(fixture.text('x'.repeat(4_096)))],
  ])('maps %s to AI_PROVIDER_UNAVAILABLE', async (_label, respond) => {
    server.use(http.post(fixture.url, respond));
    const error = await capture(build(fixture.id, { maxResponseBytes: 2_048 }).chat(ask));
    expect(error.code).toBe('AI_PROVIDER_UNAVAILABLE');
  });

  it('maps an oversized stream to AI_PROVIDER_UNAVAILABLE', async () => {
    server.use(http.post(fixture.url, () => sseResponse(fixture.sseText(Array.from({ length: 64 }, () => 'y'.repeat(64))))));
    const error = await capture(collect(build(fixture.id, { maxResponseBytes: 2_048 }).stream(ask)));
    expect(error.reason).toBe('too_large');
  });

  it('maps an unexpected stream event to AI_PROVIDER_UNAVAILABLE', async () => {
    const bad = fixture.id === 'anthropic' ? sse([['message_start', { type: 'message_start' }]]) : sse([[null, { choices: 'nope' }]]);
    server.use(http.post(fixture.url, () => sseResponse(bad)));
    const error = await capture(collect(build(fixture.id).stream(ask)));
    expect(error.code).toBe('AI_PROVIDER_UNAVAILABLE');
  });

  it('ends a never-ending stream with AI_PROVIDER_UNAVAILABLE', async () => {
    server.use(
      http.post(fixture.url, () => {
        const body = new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(encoder.encode(fixture.sseHead()));
          },
        });
        return new Response(body, { headers: { 'content-type': 'text/event-stream' } });
      }),
    );
    const error = await capture(collect(build(fixture.id, { idleTimeoutMs: 100 }).stream(ask)));
    expect(error.code).toBe('AI_PROVIDER_UNAVAILABLE');
    expect(['idle_timeout', 'timeout']).toContain(error.reason);
  });

  it('maps a stream that closes before its end marker to AI_PROVIDER_UNAVAILABLE', async () => {
    server.use(http.post(fixture.url, () => sseResponse(fixture.sseHead())));
    const error = await capture(collect(build(fixture.id).stream(ask)));
    expect(error.code).toBe('AI_PROVIDER_UNAVAILABLE');
  });

  it('passes an abort signal on every request and releases the body reader on abort mid-stream', async () => {
    let cancelled = false;
    const signals: (AbortSignal | null | undefined)[] = [];
    const fetchImpl: typeof fetch = (_input, init) => {
      signals.push(init?.signal);
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          const events = fixture.sseText(['first ']).split('\n\n');
          const upToText = events.slice(0, events.findIndex((event) => event.includes('first ')) + 1);
          controller.enqueue(encoder.encode(`${upToText.join('\n\n')}\n\n`));
        },
        cancel() {
          cancelled = true;
        },
      });
      return Promise.resolve(new Response(body, { headers: { 'content-type': 'text/event-stream' } }));
    };
    const caller = new AbortController();
    const stream = build(fixture.id, { idleTimeoutMs: 5_000 }, fetchImpl).stream({ ...ask, signal: caller.signal });
    const iterator = stream[Symbol.asyncIterator]();
    const pending = (async () => {
      for (;;) {
        const next = await iterator.next();
        if (next.done === true) return;
        if (next.value.type === 'text_delta') caller.abort();
      }
    })();
    const error = await capture(pending);
    expect(error.reason).toBe('aborted');
    expect(signals).toHaveLength(1);
    expect(signals[0]).toBeInstanceOf(AbortSignal);
    expect(cancelled).toBe(true);
  });

  it('maps a caller abort before the response to AI_PROVIDER_UNAVAILABLE', async () => {
    server.use(
      http.post(fixture.url, async () => {
        await new Promise((resolve) => setTimeout(resolve, 1_000));
        return HttpResponse.json(fixture.text('late'));
      }),
    );
    const error = await capture(build(fixture.id).chat({ ...ask, signal: AbortSignal.timeout(50) }));
    expect(error.reason).toBe('aborted');
  });
});

describe('key handling (A4, H1)', () => {
  it('sent the key only as an auth header to the pinned vendor host', () => {
    expect(seen.length).toBeGreaterThan(0);
    for (const request of seen) {
      expect(request.url.includes(CANARY)).toBe(false);
      expect(['https://api.anthropic.com', 'https://api.openai.com']).toContain(new URL(request.url).origin);
      const carrying = request.headers.filter(([, value]) => value.includes(CANARY)).map(([name]) => name);
      expect(carrying.every((name) => name === 'x-api-key' || name === 'authorization')).toBe(true);
      expect(request.authOk).toBe(true);
    }
  });

  it('never leaks the key through any error or the provider object', () => {
    expect(errors.length).toBeGreaterThan(20);
    for (const error of errors) {
      const views = [JSON.stringify(error), String(error), (error as Error).stack ?? '', inspect(error, { depth: 10, showHidden: true })];
      for (const view of views) expect(view).not.toContain(CANARY);
    }
    for (const id of IMPLEMENTED_AI_PROVIDER_IDS) {
      const provider = build(id);
      expect(inspect(provider, { depth: 10, showHidden: true })).not.toContain(CANARY);
      expect(JSON.stringify(provider)).not.toContain(CANARY);
    }
  });
});
