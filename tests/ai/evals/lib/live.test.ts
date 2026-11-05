// 29-02 (A3): mode selection, the pinned model and the temperature-0 transport, with no network.
import { describe, expect, it } from 'vitest';
import { EvalConfigError, createLiveProvider, createTemperatureFetch, pinnedModel, resolveEvalConfig, type TemperatureState } from './live.js';

const KEY = `sk-ant-api03-${'c3'.repeat(24)}`;

describe('resolveEvalConfig', () => {
  it('replays by default on the pinned anthropic model without a key', () => {
    expect(resolveEvalConfig({})).toEqual({ mode: 'replay', provider: 'anthropic', model: pinnedModel('anthropic'), apiKey: null, concurrency: 4 });
  });

  it('ignores provider keys in replay mode', () => {
    expect(resolveEvalConfig({ ANTHROPIC_API_KEY: KEY }).apiKey).toBeNull();
  });

  it('needs a key in live mode', () => {
    expect(() => resolveEvalConfig({ NOODARA_AI_EVAL_LIVE: '1' })).toThrow(EvalConfigError);
    expect(() => resolveEvalConfig({ NOODARA_AI_EVAL_LIVE: '1', ANTHROPIC_API_KEY: '  ' })).toThrow(/ANTHROPIC_API_KEY/);
  });

  it('takes the provider key, or NOODARA_AI_EVAL_API_KEY first, and never exposes it as a string', () => {
    const config = resolveEvalConfig({ NOODARA_AI_EVAL_LIVE: '1', ANTHROPIC_API_KEY: KEY });
    expect(config.mode).toBe('live');
    expect(config.apiKey).not.toBeNull();
    expect(JSON.stringify(config)).not.toContain(KEY);
    expect(String(config.apiKey)).not.toContain(KEY);
    const openai = resolveEvalConfig({ NOODARA_AI_EVAL_LIVE: '1', NOODARA_AI_EVAL_PROVIDER: 'openai', NOODARA_AI_EVAL_API_KEY: KEY });
    expect(openai).toMatchObject({ provider: 'openai', model: pinnedModel('openai') });
    expect(() => resolveEvalConfig({ NOODARA_AI_EVAL_LIVE: '1', NOODARA_AI_EVAL_PROVIDER: 'openai', ANTHROPIC_API_KEY: KEY })).toThrow(/OPENAI_API_KEY/);
  });

  it.each(['gemini', ''])('rejects provider %j', (provider) => {
    expect(() => resolveEvalConfig({ NOODARA_AI_EVAL_PROVIDER: provider })).toThrow(EvalConfigError);
  });

  it.each(['0', '17', 'x'])('rejects concurrency %s', (value) => {
    expect(() => resolveEvalConfig({ NOODARA_AI_EVAL_CONCURRENCY: value })).toThrow(/CONCURRENCY/);
  });

  it('accepts concurrency within 1..16', () => {
    expect(resolveEvalConfig({ NOODARA_AI_EVAL_CONCURRENCY: '16' }).concurrency).toBe(16);
  });

  it('refuses a live provider without a key', () => {
    expect(() => createLiveProvider(resolveEvalConfig({}), { temperature: 0 })).toThrow(EvalConfigError);
  });
});

describe('createTemperatureFetch', () => {
  type Call = { body: string | undefined };

  function base(calls: Call[], answer: (body: Record<string, unknown>) => Response): typeof fetch {
    return (_input, init) => {
      const body = typeof init?.body === 'string' ? init.body : undefined;
      calls.push({ body });
      let parsed: Record<string, unknown> = {};
      try {
        parsed = JSON.parse(body ?? '{}') as Record<string, unknown>;
      } catch {
        // a non-JSON body is answered like an empty one
      }
      return Promise.resolve(answer(parsed));
    };
  }

  it('adds temperature 0 to JSON bodies', async () => {
    const calls: Call[] = [];
    const state: TemperatureState = { temperature: 0 };
    const response = await createTemperatureFetch(base(calls, () => new Response('{}')), state)('https://x', { method: 'POST', body: '{"model":"m"}' });
    expect(response.status).toBe(200);
    expect(JSON.parse(calls[0]?.body ?? '')).toEqual({ model: 'm', temperature: 0 });
    expect(state.temperature).toBe(0);
  });

  it('drops temperature after a 400 naming it, retries once, and records null', async () => {
    const calls: Call[] = [];
    const state: TemperatureState = { temperature: 0 };
    const transport = createTemperatureFetch(
      base(calls, (body) =>
        'temperature' in body ? new Response('{"error":{"message":"temperature is not supported with thinking"}}', { status: 400 }) : new Response('{}'),
      ),
      state,
    );
    expect((await transport('https://x', { method: 'POST', body: '{"model":"m"}' })).status).toBe(200);
    expect(state.temperature).toBeNull();
    await transport('https://x', { method: 'POST', body: '{"model":"m"}' });
    expect(calls.map((call) => JSON.parse(call.body ?? '{}') as Record<string, unknown>)).toEqual([
      { model: 'm', temperature: 0 },
      { model: 'm' },
      { model: 'm' },
    ]);
  });

  it('returns other 400s untouched and keeps temperature 0', async () => {
    const calls: Call[] = [];
    const state: TemperatureState = { temperature: 0 };
    const transport = createTemperatureFetch(base(calls, () => new Response('{"error":"max_tokens too large"}', { status: 400 })), state);
    expect((await transport('https://x', { method: 'POST', body: '{"model":"m"}' })).status).toBe(400);
    expect(calls).toHaveLength(1);
    expect(state.temperature).toBe(0);
  });

  it.each([
    ['no body', undefined],
    ['a non-JSON body', 'not json'],
    ['a JSON array', '[1]'],
  ])('passes %s through unchanged', async (_name, body) => {
    const calls: Call[] = [];
    await createTemperatureFetch(base(calls, () => new Response('{}')), { temperature: 0 })('https://x', body === undefined ? {} : { body });
    expect(calls[0]?.body).toBe(body);
  });
});

describe('createLiveProvider temperature fallback through the real Anthropic provider', () => {
  // The exact 400 the pinned Anthropic model answers when a request carries `temperature`.
  const DEPRECATED =
    '{"type":"error","error":{"type":"invalid_request_error","message":"`temperature` is deprecated for this model."}}';

  function message(text: string): Record<string, unknown> {
    return {
      id: 'msg_1',
      type: 'message',
      role: 'assistant',
      model: pinnedModel('anthropic'),
      content: [{ type: 'text', text }],
      stop_reason: 'end_turn',
      stop_sequence: null,
      usage: { input_tokens: 3, output_tokens: 2 },
    };
  }

  function sse(text: string): string {
    const events: [string, Record<string, unknown>][] = [
      ['message_start', { type: 'message_start', message: { ...message(''), content: [], stop_reason: null, usage: { input_tokens: 3, output_tokens: 0 } } }],
      ['content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }],
      ['content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } }],
      ['content_block_stop', { type: 'content_block_stop', index: 0 }],
      ['message_delta', { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 2 } }],
      ['message_stop', { type: 'message_stop' }],
    ];
    return events.map(([event, data]) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`).join('');
  }

  /** Anthropic as observed live: any body with `temperature` gets the deprecation 400. */
  function anthropic(bodies: Record<string, unknown>[]): typeof fetch {
    return async (input, init) => {
      const raw = init?.body ?? (input instanceof Request ? await input.clone().text() : undefined);
      const text = typeof raw === 'string' ? raw : raw instanceof Uint8Array ? new TextDecoder().decode(raw) : String(raw);
      const body = JSON.parse(text) as Record<string, unknown>;
      bodies.push(body);
      if ('temperature' in body)
        return new Response(DEPRECATED, { status: 400, headers: { 'content-type': 'application/json', 'request-id': 'req_1' } });
      if (body.stream === true) return new Response(sse('ok'), { headers: { 'content-type': 'text/event-stream' } });
      return new Response(JSON.stringify(message('ok')), { headers: { 'content-type': 'application/json' } });
    };
  }

  const request = { system: 'You are Noodara.', maxTokens: 64, messages: [{ role: 'user' as const, content: 'hi' }] };
  const tools = [{ name: 'list_servers', description: 'List servers', inputSchema: { type: 'object', properties: {} } }];

  function live(bodies: Record<string, unknown>[], state: TemperatureState) {
    return createLiveProvider(resolveEvalConfig({ NOODARA_AI_EVAL_LIVE: '1', ANTHROPIC_API_KEY: KEY }), state, anthropic(bodies));
  }

  it('chat: retries without temperature after the deprecation 400 and records null', async () => {
    const bodies: Record<string, unknown>[] = [];
    const state: TemperatureState = { temperature: 0 };
    expect((await live(bodies, state).chat(request)).text).toBe('ok');
    expect(state.temperature).toBeNull();
    expect(bodies.map((body) => 'temperature' in body)).toEqual([true, false]);
  });

  it('toolCall: retries without temperature and later calls skip it', async () => {
    const bodies: Record<string, unknown>[] = [];
    const state: TemperatureState = { temperature: 0 };
    const provider = live(bodies, state);
    expect((await provider.toolCall({ ...request, tools })).text).toBe('ok');
    expect((await provider.toolCall({ ...request, tools })).text).toBe('ok');
    expect(state.temperature).toBeNull();
    expect(bodies.map((body) => 'temperature' in body)).toEqual([true, false, false]);
  });

  it('stream: retries without temperature after the deprecation 400', async () => {
    const bodies: Record<string, unknown>[] = [];
    const state: TemperatureState = { temperature: 0 };
    const chunks: unknown[] = [];
    for await (const chunk of live(bodies, state).stream({ ...request, tools })) chunks.push(chunk);
    expect(chunks.at(-1)).toMatchObject({ type: 'done' });
    expect(state.temperature).toBeNull();
    expect(bodies.map((body) => 'temperature' in body)).toEqual([true, false]);
  });
});
