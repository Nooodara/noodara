// 29-02 (H1): the cassette key covers only the canonicalized, redacted request; replay answers
// only from entries recorded with the pinned model; written cassettes never carry a credential.
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AIProviderError, createScriptedProvider, type AIProvider, type AIStreamRequest, type AIToolCallRequest } from '@noodara/ai';
import { createRedactor, type Redactor } from '@noodara/domain';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  CassetteMissError,
  canonicalJson,
  cassetteDigest,
  cassetteKey,
  cassettePath,
  cassetteProblems,
  createRecordingProvider,
  createReplayProvider,
  listCassetteIds,
  readCassette,
  writeCassette,
  type CassetteFile,
  type CassetteInteraction,
} from './cassette.js';
import { createLiveProvider, pinnedModel, resolveEvalConfig } from './live.js';

const MODEL = pinnedModel('anthropic');
const CANARY = 'NOODARA_CANARY_0123456789abcdef0123456789abcdef';
const KEY_A = `sk-ant-api03-${'a1'.repeat(24)}`;
const KEY_B = `sk-ant-api03-${'b2'.repeat(24)}`;

const tool = { name: 'list_servers', description: 'List servers', inputSchema: { type: 'object', properties: {} } };
const baseRequest: AIToolCallRequest = {
  system: 'You are Noodara.',
  maxTokens: 1024,
  tools: [tool],
  messages: [{ role: 'user', content: 'Where does payments-api run?' }],
};

function redactorWithCanary(): Redactor {
  const redactor = createRedactor();
  redactor.register(CANARY, 'secret');
  return redactor;
}

interface SeenRequest {
  readonly apiKey: string | null;
  readonly body: Record<string, unknown>;
}

/** An Anthropic Messages endpoint that answers every call with `text`, with noisy headers. */
function anthropicTransport(text: string, seen: SeenRequest[]): typeof fetch {
  let n = 0;
  return (_input, init) => {
    n += 1;
    const headers = new Headers(init?.headers);
    seen.push({ apiKey: headers.get('x-api-key'), body: JSON.parse(String(init?.body)) as Record<string, unknown> });
    const body = JSON.stringify({
      id: `msg_${n}_${Date.now()}`,
      type: 'message',
      role: 'assistant',
      model: MODEL,
      content: [{ type: 'text', text }],
      stop_reason: 'end_turn',
      stop_sequence: null,
      usage: { input_tokens: 12, output_tokens: 5 },
    });
    return Promise.resolve(
      new Response(body, { headers: { 'content-type': 'application/json', 'request-id': `req_${n}_${Date.now()}`, date: new Date().toUTCString() } }),
    );
  };
}

function liveProvider(apiKey: string, transport: typeof fetch): AIProvider {
  return createLiveProvider(resolveEvalConfig({ NOODARA_AI_EVAL_LIVE: '1', ANTHROPIC_API_KEY: apiKey }), { temperature: 0 }, transport);
}

function cassetteOf(interactions: readonly CassetteInteraction[], model = MODEL): CassetteFile {
  return {
    schemaVersion: 1,
    source: 'live',
    provider: 'anthropic',
    model,
    scenarioId: 'syn-1',
    datasetVersion: '1.0.0',
    recordedOn: '2026-11-04',
    temperature: 0,
    interactions: [...interactions],
  };
}

describe('canonicalJson', () => {
  it('sorts keys at every depth and drops undefined and functions', () => {
    expect(canonicalJson({ b: 1, a: { d: [{ z: 1, y: undefined }], c: () => 1 } })).toBe('{"a":{"d":[{"z":1}]},"b":1}');
    expect(canonicalJson([undefined, 1])).toBe('[null,1]');
  });
});

describe('cassetteKey (H1)', () => {
  const redactor = redactorWithCanary();
  const key = (request: AIStreamRequest, model = MODEL): string => cassetteKey(model, request, redactor);

  it('is a sha-256 hex digest', () => {
    expect(key(baseRequest)).toMatch(/^[0-9a-f]{64}$/);
  });

  it('ignores headers, API key, timestamps, request ids and the abort signal', () => {
    const noisy = {
      ...baseRequest,
      signal: AbortSignal.timeout(10_000),
      headers: { 'x-api-key': KEY_A, authorization: `Bearer ${KEY_A}` },
      apiKey: KEY_A,
      date: new Date().toISOString(),
      requestId: 'req_0123456789',
    } as AIStreamRequest;
    expect(key(noisy)).toBe(key(baseRequest));
  });

  it('does not depend on key order', () => {
    const reordered: AIToolCallRequest = {
      messages: [{ content: 'Where does payments-api run?', role: 'user' }],
      tools: [{ inputSchema: { properties: {}, type: 'object' }, description: 'List servers', name: 'list_servers' }],
      maxTokens: 1024,
      system: 'You are Noodara.',
    };
    expect(key(reordered)).toBe(key(baseRequest));
  });

  it('changes with the system prompt, model, messages, tools or output cap', () => {
    const base = key(baseRequest);
    expect(key({ ...baseRequest, system: 'You are Noodara!' })).not.toBe(base);
    expect(key(baseRequest, 'gpt-5-2025-08-07')).not.toBe(base);
    expect(key({ ...baseRequest, messages: [{ role: 'user', content: 'Where does postgres run?' }] })).not.toBe(base);
    expect(key({ ...baseRequest, tools: [{ ...tool, name: 'list_services' }] })).not.toBe(base);
    expect(key({ ...baseRequest, maxTokens: 2048 })).not.toBe(base);
  });

  it('hashes the redacted request: a canary and its redaction give the same key', () => {
    const withCanary = { ...baseRequest, messages: [{ role: 'user' as const, content: `token is ${CANARY}` }] };
    const redacted = { ...baseRequest, messages: [{ role: 'user' as const, content: redactor.redact(`token is ${CANARY}`) }] };
    expect(redacted.messages[0]?.content).not.toContain(CANARY);
    expect(key(withCanary)).toBe(key(redacted));
  });
});

describe('recording through the live provider (H1)', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'noodara-cassette-'));
  });
  afterEach(() => {
    vi.useRealTimers();
    rmSync(dir, { recursive: true, force: true });
  });

  async function record(apiKey: string, date: string, seen: SeenRequest[]): Promise<CassetteInteraction[]> {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date(date));
    const recorder = createRecordingProvider(liveProvider(apiKey, anthropicTransport('payments-api runs on web-1', seen)), redactorWithCanary());
    const response = await recorder.toolCall(baseRequest);
    expect(response.text).toBe('payments-api runs on web-1');
    vi.useRealTimers();
    return [...recorder.interactions];
  }

  it('gives the same key for the same request with a different API key or date', async () => {
    const seen: SeenRequest[] = [];
    const first = await record(KEY_A, '2026-01-01T00:00:00Z', seen);
    const second = await record(KEY_B, '2026-06-30T12:34:56Z', seen);
    expect(seen.map((entry) => entry.apiKey)).toEqual([KEY_A, KEY_B]);
    expect(seen[0]?.body.temperature).toBe(0);
    expect(first[0]?.key).toMatch(/^[0-9a-f]{64}$/);
    expect(second[0]?.key).toBe(first[0]?.key);
    expect(first[0]?.model).toBe(MODEL);
  });

  it('writes a cassette without the key, a canary, an auth header or a request id', async () => {
    const seen: SeenRequest[] = [];
    const recorder = createRecordingProvider(liveProvider(KEY_A, anthropicTransport(`leaked ${CANARY}`, seen)), redactorWithCanary());
    const response = await recorder.toolCall({ ...baseRequest, messages: [{ role: 'user', content: `token is ${CANARY}` }] });
    expect(response.text).not.toContain(CANARY);

    const file = cassettePath(dir, 'anthropic', 'syn-1');
    writeCassette(file, cassetteOf(recorder.interactions), [KEY_A, CANARY]);
    const text = readFileSync(file, 'utf8');
    for (const forbidden of [KEY_A, CANARY, 'sk-ant-', 'req_', 'msg_']) expect(text).not.toContain(forbidden);
    expect(text.toLowerCase()).not.toMatch(/authorization|x-api-key|bearer/);
    expect(readCassette(file)?.interactions).toHaveLength(1);
    expect(listCassetteIds(dir, 'anthropic')).toEqual(['syn-1']);
  });

  it('records a provider error and replays it', async () => {
    const recorder = createRecordingProvider(
      { ...createScriptedProvider([new AIProviderError('AI_PROVIDER_RATE_LIMITED', 'rate_limited')]), model: MODEL },
      redactorWithCanary(),
    );
    await expect(recorder.toolCall(baseRequest)).rejects.toMatchObject({ code: 'AI_PROVIDER_RATE_LIMITED' });
    const replay = createReplayProvider({ provider: 'anthropic', model: MODEL, scenarioId: 'syn-1', cassette: cassetteOf(recorder.interactions), redactor: redactorWithCanary() });
    await expect(replay.toolCall(baseRequest)).rejects.toMatchObject({ code: 'AI_PROVIDER_RATE_LIMITED', reason: 'rate_limited' });
  });
});

describe('replay provider (A2, H1)', () => {
  const redactor = redactorWithCanary();

  async function recorded(model = MODEL): Promise<CassetteInteraction[]> {
    const recorder = createRecordingProvider({ ...createScriptedProvider([{ text: 'first' }, { text: 'second' }]), model }, redactor);
    await recorder.toolCall(baseRequest);
    await recorder.toolCall(baseRequest);
    return [...recorder.interactions];
  }

  it('answers recorded turns in order and misses after the recording runs out', async () => {
    const replay = createReplayProvider({ provider: 'anthropic', model: MODEL, scenarioId: 'syn-1', cassette: cassetteOf(await recorded()), redactor });
    expect((await replay.toolCall(baseRequest)).text).toBe('first');
    expect((await replay.chat(baseRequest)).text).toBe('second');
    const miss = await replay.toolCall(baseRequest).catch((error: unknown) => error);
    expect(miss).toBeInstanceOf(CassetteMissError);
    expect(miss).toMatchObject({ scenarioId: 'syn-1', turn: 3 });
  });

  it('misses a changed request', async () => {
    const replay = createReplayProvider({ provider: 'anthropic', model: MODEL, scenarioId: 'syn-1', cassette: cassetteOf(await recorded()), redactor });
    await expect(replay.toolCall({ ...baseRequest, system: 'changed' })).rejects.toBeInstanceOf(CassetteMissError);
  });

  it('misses without a cassette', async () => {
    const replay = createReplayProvider({ provider: 'anthropic', model: MODEL, scenarioId: 'syn-1', cassette: null, redactor });
    await expect(replay.toolCall(baseRequest)).rejects.toMatchObject({ name: 'CassetteMissError', turn: 1 });
  });

  it('misses a cassette recorded with a model other than the pinned one', async () => {
    const other = await recorded('claude-older-1');
    const replay = createReplayProvider({ provider: 'anthropic', model: MODEL, scenarioId: 'syn-1', cassette: cassetteOf(other, 'claude-older-1'), redactor });
    await expect(replay.toolCall(baseRequest)).rejects.toBeInstanceOf(CassetteMissError);
  });

  it('misses entries recorded with another model even inside a pinned-model cassette', async () => {
    const entries = (await recorded()).map((entry) => ({ ...entry, model: 'claude-older-1' }));
    const replay = createReplayProvider({ provider: 'anthropic', model: MODEL, scenarioId: 'syn-1', cassette: cassetteOf(entries), redactor });
    await expect(replay.toolCall(baseRequest)).rejects.toBeInstanceOf(CassetteMissError);
  });

  it('misses a cassette of another provider', async () => {
    const cassette = { ...cassetteOf(await recorded()), provider: 'openai' as const };
    const replay = createReplayProvider({ provider: 'anthropic', model: MODEL, scenarioId: 'syn-1', cassette, redactor });
    await expect(replay.toolCall(baseRequest)).rejects.toBeInstanceOf(CassetteMissError);
  });

  it('does not stream', async () => {
    const replay = createReplayProvider({ provider: 'anthropic', model: MODEL, scenarioId: 'syn-1', cassette: null, redactor });
    await expect(replay.stream(baseRequest)[Symbol.asyncIterator]().next()).rejects.toBeInstanceOf(AIProviderError);
  });
});

describe('writing cassettes (H1)', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'noodara-cassette-'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  const entry = (text: string): CassetteInteraction => ({
    key: 'a'.repeat(64),
    model: MODEL,
    turn: 1,
    response: {
      text,
      toolCalls: [],
      stopReason: 'end_turn',
      usage: { inputTokens: 1, outputTokens: 1 },
      message: { role: 'assistant', content: text, toolCalls: [] },
    },
  });

  it.each([
    ['a forbidden value', `value ${CANARY}`, 'forbidden value #0'],
    ['an anthropic key shape', `key ${KEY_A}`, 'anthropic-key'],
    ['an authorization header', '{"authorization": "x"}', 'auth header'],
    ['an x-api-key header', '{"x-api-key": "x"}', 'auth header'],
    ['a bearer token', 'Bearer abcdefghijklmnop', 'auth header'],
  ])('refuses to write %s', (_name, text, problem) => {
    const file = cassettePath(dir, 'anthropic', 'syn-1');
    expect(cassetteProblems(text, [CANARY])).toContain(problem);
    expect(() => writeCassette(file, cassetteOf([entry(text)]), [CANARY])).toThrow(/not written/);
    expect(readCassette(file)).toBeNull();
  });

  it('rejects a cassette that does not come from a live run', () => {
    const file = cassettePath(dir, 'anthropic', 'syn-1');
    writeFileSync(join(dir, 'x.json'), '{}');
    expect(() => writeCassette(file, { ...cassetteOf([]), source: 'hand' as 'live' }, [])).toThrow();
    expect(() => readCassette(join(dir, 'x.json'))).toThrow();
  });

  it('digests the cassettes so a changed recording changes the digest', () => {
    const file = cassettePath(dir, 'anthropic', 'syn-1');
    const missing = cassetteDigest(dir, 'anthropic', ['syn-1']);
    writeCassette(file, cassetteOf([entry('one')]), []);
    const first = cassetteDigest(dir, 'anthropic', ['syn-1']);
    expect(first).not.toBe(missing);
    expect(cassetteDigest(dir, 'anthropic', ['syn-1'])).toBe(first);
    writeCassette(file, cassetteOf([entry('two')]), []);
    expect(cassetteDigest(dir, 'anthropic', ['syn-1'])).not.toBe(first);
    expect(listCassetteIds(join(dir, 'none'), 'anthropic')).toEqual([]);
  });
});
