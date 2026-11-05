// 28-04 A1-A5, H1: the agent loop against the real registry and Redactor, driven by a scripted
// provider. No network, no control plane.
import type { AiStructuredAnswer } from '@noodara/domain/api-contract';
import { createRedactor, type Redactor } from '@noodara/domain/security';
import { describe, expect, it, vi } from 'vitest';
import { AIProviderError } from '../errors.js';
import { createToolRegistry } from '../tools/registry.js';
import type { ReadToolBackend, ToolOutcome } from '../tools/types.js';
import type { AIMessage, AIToolCall, AIToolMessage } from '../types.js';
import { MALFORMED_ARGUMENTS_NOTE, REPAIR_NOTE, runAgent, UNKNOWN_TOOL_NOTE, type AgentEvent, type RunAgentOptions } from './loop.js';
import { createScriptedProvider, type ScriptedStep } from './scripted-provider.js';

const SERVICE = '7d1f3c2a-4b5e-4f60-8a71-92b3c4d5e6f7';
const SERVER = '0a1b2c3d-4e5f-4a6b-9c7d-8e9f0a1b2c3d';
const INVENTED = '11111111-2222-4333-8444-555555555555';
const CANARY = 'canary-Zx81-supersecret-value';

function backend(overrides: Partial<ReadToolBackend> = {}): ReadToolBackend {
  const ok = (data: unknown) => vi.fn((): Promise<ToolOutcome> => Promise.resolve({ ok: true, data }));
  return {
    get_server: ok({ id: SERVER, name: 'web-1' }),
    list_servers: ok({ items: [] }),
    get_service: ok({ id: SERVICE, name: 'api', serverId: SERVER }),
    list_services: ok({ items: [] }),
    get_deployment: ok({ id: SERVICE }),
    list_deployments: ok({ items: [] }),
    get_health: ok({ status: 'crash_loop' }),
    get_metrics: ok({ series: [] }),
    get_logs: ok({ entries: [] }),
    get_infrastructure_graph: ok({ nodes: [], edges: [] }),
    ...overrides,
  };
}

function answer(over: Partial<AiStructuredAnswer> = {}): string {
  return JSON.stringify({
    answer: 'The api service is crash looping.',
    diagnosis: 'crash_loop',
    confidence: 0.8,
    entities: [{ kind: 'Service', id: SERVICE, label: 'api' }],
    evidence: [{ ref: 'call-1', note: 'health reports a crash loop' }],
    missingEvidence: [],
    ...over,
  });
}

const call = (id: string, name: string, input: unknown = {}): AIToolCall =>
  ({ id, name, input }) as unknown as AIToolCall;

function setup(steps: readonly ScriptedStep[], options: Partial<RunAgentOptions> = {}, tools: ReadToolBackend = backend()) {
  const redactor: Redactor = options.redactor ?? createRedactor();
  const provider = createScriptedProvider(steps);
  const events: AgentEvent[] = [];
  const run = () =>
    runAgent({
      provider,
      registry: createToolRegistry(tools),
      redactor,
      scope: { kind: 'global' },
      question: 'Why is the api down?',
      onEvent: (event) => events.push(event),
      ...options,
    });
  return { provider, run, events, tools, redactor };
}

function toolMessages(messages: readonly AIMessage[]): AIToolMessage[] {
  return messages.filter((message): message is AIToolMessage => message.role === 'tool');
}

describe('runAgent: bounded tool loop and structured answer (A1)', () => {
  it('runs tool calls against the registry and returns a validated, grounded answer', async () => {
    const { provider, run, tools, events } = setup([
      { text: 'Checking the service.', toolCalls: [call('call-1', 'get_health', { serviceId: SERVICE })] },
      { text: answer() },
    ]);
    const result = await run();

    expect(result.status).toBe('answered');
    if (result.status !== 'answered') return;
    expect(result.format).toBe('structured');
    expect(result.answer.diagnosis).toBe('crash_loop');
    expect(result.answer.entities).toEqual([{ kind: 'Service', id: SERVICE, label: 'api' }]);
    expect(result.iterations).toBe(2);
    expect(result.usage).toEqual({ inputTokens: 20, outputTokens: 20 });
    expect(tools.get_health).toHaveBeenCalledTimes(1);
    expect(result.toolCalls).toEqual([
      expect.objectContaining({ callId: 'call-1', name: 'get_health', status: 'ok', errorCode: null, target: { kind: 'Service', id: SERVICE } }),
    ]);
    const [results] = toolMessages(provider.requests[1]?.messages ?? []);
    expect(results?.results[0]).toEqual(expect.objectContaining({ toolCallId: 'call-1', isError: false }));
    expect(JSON.parse(results?.results[0]?.content ?? '{}')).toEqual(expect.objectContaining({ tool: 'get_health', data: { status: 'crash_loop' } }));
    expect(events.map((event) => event.type)).toEqual(['text', 'tool_call']);
    expect(provider.requests.every((request) => request.tools?.length === 10)).toBe(true);
  });

  it('stops with AI_BUDGET_EXCEEDED when the iteration cap is reached', async () => {
    const loop = (n: number) => ({ toolCalls: [call(`call-${String(n)}`, 'list_servers')] });
    const { provider, run } = setup([loop(1), loop(2), loop(3)], { budget: { maxIterations: 2 } });
    const result = await run();
    expect(result).toEqual(expect.objectContaining({ status: 'failed', errorCode: 'AI_BUDGET_EXCEEDED', budget: 'iterations' }));
    expect(provider.requests).toHaveLength(2);
  });

  it('stops with AI_BUDGET_EXCEEDED before running a turn that would pass the tool call cap', async () => {
    const tools = backend();
    const { run } = setup(
      [
        { toolCalls: [call('a', 'list_servers'), call('b', 'list_servers')] },
        { toolCalls: [call('c', 'list_servers')] },
      ],
      { budget: { maxToolCalls: 2 } },
      tools,
    );
    const result = await run();
    expect(result).toEqual(expect.objectContaining({ status: 'failed', errorCode: 'AI_BUDGET_EXCEEDED', budget: 'tool_calls' }));
    expect(tools.list_servers).toHaveBeenCalledTimes(2);
    expect(result.toolCalls).toHaveLength(2);
  });

  it('stops with AI_BUDGET_EXCEEDED when reported usage passes the token cap', async () => {
    const { run } = setup(
      [{ toolCalls: [call('a', 'list_servers')], usage: { inputTokens: 9_000, outputTokens: 2_000 } }, { text: answer() }],
      { budget: { maxTokens: 10_000 } },
    );
    expect(await run()).toEqual(expect.objectContaining({ status: 'failed', errorCode: 'AI_BUDGET_EXCEEDED', budget: 'tokens' }));
  });

  it('never calls the provider when the estimated request alone passes the token cap', async () => {
    const { provider, run } = setup([{ text: answer() }], { budget: { maxTokens: 50 } });
    expect(await run()).toEqual(expect.objectContaining({ status: 'failed', budget: 'tokens' }));
    expect(provider.requests).toHaveLength(0);
  });

  it('stops with AI_BUDGET_EXCEEDED when the wall clock passes during a tool call', async () => {
    let clock = 1_000;
    const tools = backend({
      list_servers: vi.fn((): Promise<ToolOutcome> => {
        clock += 5_000;
        return Promise.resolve({ ok: true, data: { items: [] } });
      }),
    });
    const { run } = setup(
      [{ toolCalls: [call('a', 'list_servers'), call('b', 'list_servers')] }, { text: answer() }],
      { budget: { maxWallClockMs: 4_000 }, now: () => clock },
      tools,
    );
    expect(await run()).toEqual(expect.objectContaining({ status: 'failed', errorCode: 'AI_BUDGET_EXCEEDED', budget: 'wall_clock' }));
    expect(tools.list_servers).toHaveBeenCalledTimes(1);
  });

  it('aborts an in-flight provider call at the wall clock deadline', async () => {
    let signal: AbortSignal | undefined;
    const hang: ScriptedStep = (request) =>
      new Promise((resolve) => {
        signal = request.signal;
        request.signal?.addEventListener('abort', () => {
          resolve(new AIProviderError('AI_PROVIDER_UNAVAILABLE', 'aborted'));
        });
      });
    const { run } = setup([hang], { budget: { maxWallClockMs: 20 } });
    expect(await run()).toEqual(expect.objectContaining({ status: 'failed', errorCode: 'AI_BUDGET_EXCEEDED', budget: 'wall_clock' }));
    expect(signal?.aborted).toBe(true);
  });

  it('returns aborted when the caller aborts, and before any call when already aborted', async () => {
    const controller = new AbortController();
    const hang: ScriptedStep = (request) =>
      new Promise((resolve) => {
        request.signal?.addEventListener('abort', () => {
          resolve(new AIProviderError('AI_PROVIDER_UNAVAILABLE', 'aborted'));
        });
        controller.abort();
      });
    expect((await setup([hang], { signal: controller.signal }).run()).status).toBe('aborted');

    const already = setup([{ text: answer() }], { signal: AbortSignal.abort() });
    expect((await already.run()).status).toBe('aborted');
    expect(already.provider.requests).toHaveLength(0);
  });

  it('maps a provider error to a failed result with its code', async () => {
    const { run } = setup([new AIProviderError('AI_PROVIDER_RATE_LIMITED', 'rate_limited')]);
    expect(await run()).toEqual(expect.objectContaining({ status: 'failed', errorCode: 'AI_PROVIDER_RATE_LIMITED', budget: null }));
  });

  it('asks once for a valid answer object, then falls back to unknown', async () => {
    const repairedRun = setup([{ toolCalls: [call('call-1', 'get_health', { serviceId: SERVICE })] }, { text: 'It is crash looping.' }, { text: `\`\`\`json\n${answer()}\n\`\`\`` }]);
    const repaired = await repairedRun.run();
    expect(repaired).toEqual(expect.objectContaining({ status: 'answered', format: 'repaired' }));
    expect(repairedRun.provider.requests[2]?.messages.at(-1)).toEqual({ role: 'user', content: REPAIR_NOTE });

    const fallback = await setup([{ text: 'nope' }, { text: '{"answer": 1}' }, { text: answer() }]).run();
    expect(fallback.status).toBe('answered');
    if (fallback.status !== 'answered') return;
    expect(fallback.format).toBe('fallback');
    expect(fallback.answer).toEqual(expect.objectContaining({ diagnosis: 'unknown', confidence: 0, entities: [], evidence: [] }));
    expect(fallback.iterations).toBe(2);
  });
});

describe('runAgent: unauthorized tool attempts (A2)', () => {
  it('refuses a tool outside the registry, never runs it, and reports AI_TOOL_NOT_ALLOWED to the model', async () => {
    const tools = backend();
    const { provider, run } = setup(
      [
        { toolCalls: [call('w1', 'restart_service', { serviceId: SERVICE }), call('w2', 'shell', { cmd: 'rm -rf /' }), call('r1', 'list_servers')] },
        { text: answer({ diagnosis: 'unknown', evidence: [], entities: [], missingEvidence: ['nothing'] }) },
      ],
      {},
      tools,
    );
    const result = await run();

    expect(result.status).toBe('answered');
    expect(result.unauthorizedAttempts).toBe(2);
    expect(result.toolCalls.map((record) => [record.name, record.status, record.errorCode])).toEqual([
      ['restart_service', 'refused', 'AI_TOOL_NOT_ALLOWED'],
      ['shell', 'refused', 'AI_TOOL_NOT_ALLOWED'],
      ['list_servers', 'ok', null],
    ]);
    for (const fn of Object.values(tools)) expect(fn).toHaveBeenCalledTimes(fn === tools.list_servers ? 1 : 0);
    const [results] = toolMessages(provider.requests[1]?.messages ?? []);
    expect(results?.results[0]?.isError).toBe(true);
    expect(JSON.parse(results?.results[0]?.content ?? '{}')).toMatchObject({ data: { error: 'AI_TOOL_NOT_ALLOWED' } });
  });

  it('cannot cite a refused call as evidence', async () => {
    const result = await setup([
      { toolCalls: [call('w1', 'restart_service')] },
      { text: answer({ diagnosis: 'crash_loop', evidence: [{ ref: 'w1', note: 'restarted' }], entities: [] }) },
    ]).run();
    expect(result.status === 'answered' && result.grounding.hallucinatedEvidence).toEqual(['w1']);
  });

  it('counts a provider-side unknown tool rejection, reports it once, and fails on the second', async () => {
    const reject = new AIProviderError('AI_PROVIDER_UNAVAILABLE', 'unexpected_tool');
    const { provider, run } = setup([reject, reject, { text: answer() }]);
    const result = await run();
    expect(result).toEqual(expect.objectContaining({ status: 'failed', errorCode: 'AI_TOOL_NOT_ALLOWED', unauthorizedAttempts: 2 }));
    expect(provider.requests[1]?.messages.at(-1)).toEqual({ role: 'user', content: UNKNOWN_TOOL_NOTE });
  });

  it('counts unknown tools in a turn that is stopped by a cap', async () => {
    const result = await setup([{ toolCalls: [call('a', 'deploy'), call('b', 'list_servers')] }], { budget: { maxToolCalls: 1 } }).run();
    expect(result).toEqual(expect.objectContaining({ status: 'failed', budget: 'tool_calls', unauthorizedAttempts: 1 }));
  });
});

describe('runAgent: grounding and hallucination guard (A3)', () => {
  it('strips entities and evidence no tool returned and flags them as hallucinated', async () => {
    const result = await setup([
      { toolCalls: [call('call-1', 'get_service', { serviceId: SERVICE })] },
      {
        text: answer({
          entities: [
            { kind: 'Service', id: SERVICE, label: 'api' },
            { kind: 'Server', id: SERVER, label: 'web-1' },
            { kind: 'Server', id: INVENTED, label: 'ghost' },
          ],
          evidence: [
            { ref: 'call-1', note: 'service read' },
            { ref: SERVER, note: 'host from the service' },
            { ref: 'call-99', note: 'never happened' },
          ],
        }),
      },
    ]).run();

    expect(result.status).toBe('answered');
    if (result.status !== 'answered') return;
    expect(result.answer.entities.map((entity) => entity.id)).toEqual([SERVICE, SERVER]);
    expect(result.answer.evidence.map((item) => item.ref)).toEqual(['call-1', SERVER]);
    expect(result.grounding).toEqual({ hallucinatedEntities: [INVENTED], hallucinatedEvidence: ['call-99'], downgraded: false });
    expect(result.answer.diagnosis).toBe('crash_loop');
  });

  it('downgrades a diagnosis with no supporting evidence to unknown', async () => {
    const result = await setup([{ text: answer({ evidence: [{ ref: 'call-1', note: 'made up' }] }) }]).run();
    expect(result.status).toBe('answered');
    if (result.status !== 'answered') return;
    expect(result.answer).toEqual(expect.objectContaining({ diagnosis: 'unknown', confidence: 0, entities: [], evidence: [] }));
    expect(result.answer.missingEvidence.length).toBeGreaterThan(0);
    expect(result.grounding.downgraded).toBe(true);
  });

  it('does not accept ids the model only asked about (NOT_FOUND)', async () => {
    const tools = backend({ get_server: vi.fn((): Promise<ToolOutcome> => Promise.resolve({ ok: false, code: 'NOT_FOUND' })) });
    const result = await setup(
      [
        { toolCalls: [call('call-1', 'get_server', { serverId: INVENTED })] },
        { text: answer({ entities: [{ kind: 'Server', id: INVENTED, label: 'x' }], evidence: [{ ref: INVENTED, note: 'x' }] }) },
      ],
      {},
      tools,
    ).run();
    expect(result.status === 'answered' && result.grounding.hallucinatedEntities).toEqual([INVENTED]);
    expect(result.status === 'answered' && result.answer.diagnosis).toBe('unknown');
  });
});

describe('runAgent: system prompt and redaction (A4, A5)', () => {
  it('offers classifyEvidence hints with their refs and keeps secret values out of the system prompt', async () => {
    const redactor = createRedactor();
    redactor.register(CANARY, 'secret');
    const { provider, run } = setup([{ text: answer() }], {
      redactor,
      evidence: [
        { kind: 'deployment', ref: 'dep-ref-1', status: 'FAILED' },
        { kind: 'server', ref: `srv-${CANARY}`, reachable: false },
      ],
    });
    await run();
    const system = provider.requests[0]?.system ?? '';
    expect(system).toContain('1. server_unreachable (evidence: srv-[REDACTED:secret])');
    expect(system).toContain('2. failed_deployment (evidence: dep-ref-1)');
    expect(system).not.toContain(CANARY);
  });

  it('redacts every message, tool result and the model output', async () => {
    const redactor = createRedactor();
    redactor.register(CANARY, 'secret');
    const tools = backend({
      get_logs: vi.fn((): Promise<ToolOutcome> => Promise.resolve({ ok: true, data: { entries: [{ message: `DATABASE_URL=${CANARY}` }] } })),
    });
    const history: AIMessage[] = [
      { role: 'user', content: `earlier question ${CANARY}` },
      { role: 'assistant', content: `earlier answer ${CANARY}`, toolCalls: [] },
    ];
    const { provider, run, events } = setup(
      [
        { text: `thinking about ${CANARY}`, toolCalls: [call('call-1', 'get_logs', { serviceId: SERVICE, search: CANARY })] },
        { text: answer({ answer: `The value is ${CANARY}`, evidence: [{ ref: 'call-1', note: CANARY }] }) },
      ],
      { redactor, history, question: `Is ${CANARY} leaking?` },
      tools,
    );
    const result = await run();

    expect(JSON.stringify(provider.requests.map(({ signal: _signal, ...request }) => request))).not.toContain(CANARY);
    expect(JSON.stringify(result)).not.toContain(CANARY);
    expect(JSON.stringify(events)).not.toContain(CANARY);
    expect(result.status === 'answered' && result.answer.answer).toBe('The value is [REDACTED:secret]');
    expect(tools.get_logs).toHaveBeenCalledTimes(1);
  });
});

describe('runAgent: bounded history and malformed arguments (H1)', () => {
  it('drops the oldest turns first and always sends the system prompt, tools and question', async () => {
    const history: AIMessage[] = Array.from({ length: 30 }, (_, i): AIMessage =>
      i % 2 === 0 ? { role: 'user', content: `question ${String(i)} ${'x'.repeat(400)}` } : { role: 'assistant', content: `answer ${String(i)}`, toolCalls: [] },
    );
    const { provider, run } = setup([{ toolCalls: [call('call-1', 'list_servers')] }, { text: answer() }], {
      history,
      historyLimits: { maxMessages: 6, maxTokens: 100_000 },
      question: 'Current question',
    });
    const result = await run();

    for (const request of provider.requests) {
      expect(request.messages.length).toBeLessThanOrEqual(6);
      expect(request.messages[0]?.role).toBe('user');
      expect(request.system).toContain('untrusted data');
      expect(request.tools).toHaveLength(10);
      expect(request.messages.some((message) => message.role === 'user' && message.content === 'Current question')).toBe(true);
    }
    expect(provider.requests[0]?.messages.at(-1)).toEqual({ role: 'user', content: 'Current question' });
    expect(JSON.stringify(provider.requests[0]?.messages)).toContain('answer 29');
    expect(JSON.stringify(provider.requests[0]?.messages)).not.toContain('question 0 ');
    expect(result.historyDropped).toBeGreaterThan(0);
  });

  it('bounds history by estimated tokens too', async () => {
    const history: AIMessage[] = [
      { role: 'user', content: 'a'.repeat(8_000) },
      { role: 'assistant', content: 'b'.repeat(8_000), toolCalls: [] },
    ];
    const { provider, run } = setup([{ text: answer() }], { history, historyLimits: { maxMessages: 50, maxTokens: 3_000 } });
    await run();
    expect(provider.requests[0]?.messages).toEqual([{ role: 'user', content: 'Why is the api down?' }]);
  });

  it('reports unparseable tool arguments from the provider once and does not retry again', async () => {
    const malformed = new AIProviderError('AI_PROVIDER_UNAVAILABLE', 'malformed');
    const { provider, run } = setup([malformed, malformed, { text: answer() }]);
    const result = await run();
    expect(result).toEqual(expect.objectContaining({ status: 'failed', errorCode: 'AI_PROVIDER_UNAVAILABLE' }));
    expect(provider.requests).toHaveLength(2);
    expect(provider.requests[1]?.messages.at(-1)).toEqual({ role: 'user', content: MALFORMED_ARGUMENTS_NOTE });
  });

  it('reports a non-object tool input once as INVALID_ARGUMENTS and ends on the second', async () => {
    const tools = backend();
    const { provider, run } = setup(
      [{ toolCalls: [call('call-1', 'get_service', '{"serviceId": ')] }, { toolCalls: [call('call-2', 'get_service', 'still broken')] }, { text: answer() }],
      {},
      tools,
    );
    const result = await run();
    expect(result).toEqual(expect.objectContaining({ status: 'failed', errorCode: 'AI_PROVIDER_UNAVAILABLE' }));
    expect(result.toolCalls).toEqual([expect.objectContaining({ status: 'error', errorCode: 'INVALID_ARGUMENTS' })]);
    expect(tools.get_service).not.toHaveBeenCalled();
    expect(provider.requests).toHaveLength(2);
  });
});
