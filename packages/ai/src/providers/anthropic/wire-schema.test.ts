import { secretValue } from '@noodara/domain/security';
import { http, HttpResponse } from 'msw';
import { setupServer } from 'msw/node';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { AIProviderError, createAIProvider, type AIToolDefinition, type ImplementedAIProviderId } from '../../index.js';
import {
  AI_TOOL_DEPLOYMENTS_MAX,
  AI_TOOL_LOG_MAX_LINES,
  AI_TOOL_METRIC_POINTS_MAX,
  READ_ONLY_TOOLS,
} from '../../tools/definitions.js';
import { AI_TOOL_NAMES } from '../../tools/types.js';
import { toAnthropicInputSchema } from './wire-schema.js';

// Anthropic strict tools reject numeric bounds and array size constraints with a 400, so every
// ask failed. The wire schema drops them; the backend Zod schemas still enforce the bounds.

const ANTHROPIC_URL = 'https://api.anthropic.com/v1/messages';
const OPENAI_URL = 'https://api.openai.com/v1/chat/completions';
const ID = '0b6c3f4e-2a51-4c8d-9e7f-1a2b3c4d5e6f';
const LIVE_400 = {
  type: 'error',
  error: {
    type: 'invalid_request_error',
    message: "tools.0.custom: For 'integer' type, properties maximum, minimum are not supported",
  },
};
const UNSUPPORTED = ['minimum', 'maximum', 'exclusiveMinimum', 'exclusiveMaximum', 'multipleOf', 'maxItems'] as const;

const definitions: AIToolDefinition[] = AI_TOOL_NAMES.map((name) => ({
  name,
  description: READ_ONLY_TOOLS[name].description,
  inputSchema: READ_ONLY_TOOLS[name].inputSchema,
}));

type Json = Record<string, unknown>;
const isObject = (value: unknown): value is Json => typeof value === 'object' && value !== null && !Array.isArray(value);

/** Every schema-keyword violation in a schema, walking subschemas but never property names. */
function violations(schema: unknown, path: string, found: string[]): string[] {
  if (!isObject(schema)) return found;
  for (const keyword of UNSUPPORTED) if (keyword in schema) found.push(`${path}.${keyword}`);
  if ('minItems' in schema && schema.minItems !== 0 && schema.minItems !== 1) found.push(`${path}.minItems`);
  for (const key of ['properties', '$defs', 'definitions', 'patternProperties']) {
    const map = schema[key];
    if (isObject(map)) for (const [name, sub] of Object.entries(map)) violations(sub, `${path}.${key}.${name}`, found);
  }
  for (const key of ['items', 'additionalProperties', 'not', 'contains', 'if', 'then', 'else']) {
    violations(schema[key], `${path}.${key}`, found);
  }
  for (const key of ['anyOf', 'allOf', 'oneOf', 'prefixItems']) {
    const list = schema[key];
    if (Array.isArray(list)) list.forEach((sub, index) => violations(sub, `${path}.${key}.${String(index)}`, found));
  }
  return found;
}

const server = setupServer();
beforeAll(() => {
  server.listen({ onUnhandledRequest: 'error' });
});
afterEach(() => {
  server.resetHandlers();
});
afterAll(() => {
  server.close();
});

function build(id: ImplementedAIProviderId) {
  return createAIProvider({
    id,
    apiKey: secretValue('sk-test-wire-schema-000000000000', 'ai_provider_key'),
    limits: { timeoutMs: 2_000, idleTimeoutMs: 500, sleep: () => Promise.resolve() },
  });
}

const anthropicText = {
  id: 'msg_1',
  type: 'message',
  role: 'assistant',
  model: 'claude-opus-5-5',
  content: [{ type: 'text', text: 'ok' }],
  stop_reason: 'end_turn',
  stop_sequence: null,
  usage: { input_tokens: 1, output_tokens: 1 },
};
const openaiText = {
  id: 'cmpl_1',
  object: 'chat.completion',
  created: 1,
  model: 'gpt-5-2025-08-07',
  choices: [{ index: 0, message: { role: 'assistant', content: 'ok', refusal: null }, finish_reason: 'stop' }],
  usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
};
const ask = { messages: [{ role: 'user' as const, content: 'Is web-1 healthy?' }] };
const tools = definitions as [AIToolDefinition, ...AIToolDefinition[]];

async function sentBody(id: ImplementedAIProviderId): Promise<Json> {
  let body: unknown;
  server.use(
    http.post(id === 'anthropic' ? ANTHROPIC_URL : OPENAI_URL, async ({ request }) => {
      body = await request.json();
      return HttpResponse.json(id === 'anthropic' ? anthropicText : openaiText);
    }),
  );
  await build(id).toolCall({ ...ask, tools });
  expect(isObject(body)).toBe(true);
  return body as Json;
}

describe('anthropic wire tool schemas', () => {
  it('sends every read tool, strict, with no keyword Anthropic strict mode rejects', async () => {
    const body = await sentBody('anthropic');

    const wireTools = body.tools as Json[];
    expect(wireTools.map((tool) => tool.name)).toEqual([...AI_TOOL_NAMES]);
    for (const tool of wireTools) {
      expect(tool.strict).toBe(true);
      expect(violations(tool.input_schema, String(tool.name), [])).toEqual([]);
    }
  });

  it('keeps the supported constraints: enum, format, maxLength, required, additionalProperties', async () => {
    const body = await sentBody('anthropic');

    const getLogs = (body.tools as Json[]).find((tool) => tool.name === 'get_logs') as { input_schema: Json };
    const props = getLogs.input_schema.properties as Record<string, Json>;
    expect(getLogs.input_schema.additionalProperties).toBe(false);
    expect(getLogs.input_schema.required).toEqual(['serviceId']);
    expect(props.serviceId?.format).toBe('uuid');
    expect(props.search?.maxLength).toBe(200);
    expect(props.level?.enum).toEqual(['info', 'warn', 'error']);
    expect(props.sources?.minItems).toBe(1);
    expect((props.sources?.items as Json).enum).toBeDefined();
    expect(props.limit?.type).toBe('integer');
    expect(String(props.limit?.description)).toContain(String(AI_TOOL_LOG_MAX_LINES));
  });

  it('leaves the OpenAI wire schema untouched (strict mode there supports bounds)', async () => {
    const body = await sentBody('openai');

    const listDeployments = (body.tools as { function: { name: string; parameters: Json } }[]).find(
      (tool) => tool.function.name === 'list_deployments',
    );
    const limit = (listDeployments?.function.parameters.properties as Record<string, Json>).limit;
    expect(limit).toMatchObject({ minimum: 1, maximum: AI_TOOL_DEPLOYMENTS_MAX });
  });

  it('surfaces the live 400 for an unsupported schema as a non-retried bad request', async () => {
    let calls = 0;
    server.use(
      http.post(ANTHROPIC_URL, () => {
        calls += 1;
        return HttpResponse.json(LIVE_400, { status: 400 });
      }),
    );

    const error = await build('anthropic')
      .toolCall({ ...ask, tools })
      .then(
        () => null,
        (caught: unknown) => caught,
      );

    expect(error).toBeInstanceOf(AIProviderError);
    expect(error).toMatchObject({ code: 'AI_PROVIDER_UNAVAILABLE', reason: 'bad_request', status: 400 });
    expect(calls).toBe(1);
    expect(JSON.stringify(error)).not.toContain('not supported');
    expect((error as Error).message).not.toContain('tools.0');
  });
});

describe('toAnthropicInputSchema', () => {
  it('strips bounds recursively through properties, items, anyOf and $defs without mutating the input', () => {
    const input = {
      type: 'object',
      properties: {
        n: { type: 'number', minimum: 0, exclusiveMaximum: 10, multipleOf: 2 },
        list: { type: 'array', minItems: 2, maxItems: 5, items: { type: 'integer', maximum: 3 } },
        either: { anyOf: [{ type: 'integer', exclusiveMinimum: 0 }, { type: 'null' }] },
        ref: { $ref: '#/$defs/Bounded' },
      },
      $defs: { Bounded: { type: 'integer', minimum: 1, maximum: 9 } },
      required: ['n'],
      additionalProperties: false,
    };
    const snapshot = JSON.stringify(input);

    const output = toAnthropicInputSchema(input);

    expect(violations(output, 'root', [])).toEqual([]);
    expect(JSON.stringify(input)).toBe(snapshot);
    expect(output.required).toEqual(['n']);
    expect(output.additionalProperties).toBe(false);
    expect((output.properties as Record<string, Json>).ref).toEqual({ $ref: '#/$defs/Bounded' });
  });

  it('keeps minItems 0 or 1 and drops any other value', () => {
    const output = toAnthropicInputSchema({
      type: 'object',
      properties: {
        zero: { type: 'array', minItems: 0 },
        one: { type: 'array', minItems: 1 },
        two: { type: 'array', minItems: 2 },
      },
    });

    const props = output.properties as Record<string, Json>;
    expect(props.zero?.minItems).toBe(0);
    expect(props.one?.minItems).toBe(1);
    expect(props.two && 'minItems' in props.two).toBe(false);
  });

  it('treats property names as names, never as keywords', () => {
    const output = toAnthropicInputSchema({
      type: 'object',
      properties: { minimum: { type: 'string' }, maxItems: { type: 'string', enum: ['a'] } },
      required: ['minimum'],
    });

    expect(Object.keys(output.properties as Json)).toEqual(['minimum', 'maxItems']);
    expect(output.required).toEqual(['minimum']);
  });

  it('moves stripped bounds into the description so the model still sees them', () => {
    const output = toAnthropicInputSchema({ type: 'integer', description: 'Page size.', minimum: 1, maximum: 20 });

    expect(output).toEqual({ type: 'integer', description: 'Page size. (minimum: 1, maximum: 20)' });
  });
});

describe('backend validation still enforces the bounds the wire schema dropped', () => {
  it.each([
    ['list_deployments', { serviceId: ID, limit: AI_TOOL_DEPLOYMENTS_MAX + 1 }],
    ['list_deployments', { serviceId: ID, limit: 0 }],
    ['list_deployments', { serviceId: ID, limit: 1.5 }],
    ['get_logs', { serviceId: ID, limit: AI_TOOL_LOG_MAX_LINES + 1 }],
    ['get_logs', { serviceId: ID, sources: [] }],
    ['get_logs', { serviceId: ID, sources: ['build', 'deploy', 'runtime', 'activity', 'build'] }],
    ['get_metrics', { target: 'service', id: ID, points: AI_TOOL_METRIC_POINTS_MAX + 1 }],
  ] as const)('%s rejects %j', (name, raw) => {
    const result = READ_ONLY_TOOLS[name].parse(raw, Date.now());

    expect(result.ok).toBe(false);
  });

  it('accepts the in-range edge', () => {
    expect(READ_ONLY_TOOLS.list_deployments.parse({ serviceId: ID, limit: AI_TOOL_DEPLOYMENTS_MAX }, Date.now()).ok).toBe(true);
  });
});
