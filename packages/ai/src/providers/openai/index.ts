import OpenAI from 'openai';
import { revealSecret } from '@noodara/domain/security';
import { z } from 'zod';
import { CallScope } from '../../call.js';
import { unavailable } from '../../errors.js';
import {
  assertDeclared,
  assertTools,
  DEFAULT_MAX_TOKENS,
  parseToolArguments,
  type ProviderConfig,
} from '../../provider-kit.js';
import type {
  AIChatRequest,
  AIChatResponse,
  AIMessage,
  AIProvider,
  AIStopReason,
  AIStreamChunk,
  AIStreamRequest,
  AIToolCall,
  AIToolCallRequest,
  AIToolDefinition,
} from '../../types.js';

// OpenAI Chat Completions (ADR 0012): strict function tools, tool_choice auto, usage on the
// last stream chunk. Every response and chunk is parsed through the schemas below.

const Usage = z.object({
  prompt_tokens: z.number().int().nonnegative(),
  completion_tokens: z.number().int().nonnegative(),
});

const CompletionSchema = z.object({
  choices: z
    .array(
      z.object({
        message: z.object({
          content: z.string().nullable(),
          tool_calls: z
            .array(
              z.object({
                id: z.string().min(1),
                type: z.literal('function'),
                function: z.object({ name: z.string().min(1), arguments: z.string() }),
              }),
            )
            .nullish(),
        }),
        finish_reason: z.string(),
      }),
    )
    .min(1),
  usage: Usage.nullish(),
});

const ChunkSchema = z.object({
  choices: z.array(
    z.object({
      index: z.number().int().nonnegative(),
      delta: z.object({
        content: z.string().nullish(),
        tool_calls: z
          .array(
            z.object({
              index: z.number().int().nonnegative(),
              id: z.string().nullish(),
              function: z.object({ name: z.string().nullish(), arguments: z.string().nullish() }).nullish(),
            }),
          )
          .nullish(),
      }),
      finish_reason: z.string().nullish(),
    }),
  ),
  usage: Usage.nullish(),
});

function stopReason(raw: string): AIStopReason {
  switch (raw) {
    case 'stop':
      return 'end_turn';
    case 'tool_calls':
      return 'tool_use';
    case 'length':
      return 'max_tokens';
    case 'content_filter':
      return 'refusal';
    default:
      return 'other';
  }
}

function toWireMessages(message: AIMessage): OpenAI.ChatCompletionMessageParam[] {
  if (message.role === 'user') return [{ role: 'user', content: message.content }];
  if (message.role === 'tool') {
    return message.results.map((result) => ({
      role: 'tool' as const,
      tool_call_id: result.toolCallId,
      content: result.isError ? JSON.stringify({ error: result.content }) : result.content,
    }));
  }
  return [
    {
      role: 'assistant',
      content: message.content === '' ? null : message.content,
      ...(message.toolCalls.length === 0
        ? {}
        : {
            tool_calls: message.toolCalls.map((call) => ({
              id: call.id,
              type: 'function' as const,
              function: { name: call.name, arguments: JSON.stringify(call.input) },
            })),
          }),
    },
  ];
}

function toWireTool(tool: AIToolDefinition): OpenAI.ChatCompletionTool {
  return {
    type: 'function',
    function: { name: tool.name, description: tool.description, parameters: { ...tool.inputSchema }, strict: true },
  };
}

function body(request: AIChatRequest, model: string, tools: readonly AIToolDefinition[] | undefined) {
  const messages: OpenAI.ChatCompletionMessageParam[] = [];
  if (request.system !== undefined) messages.push({ role: 'developer', content: request.system });
  for (const message of request.messages) messages.push(...toWireMessages(message));
  return {
    model,
    max_completion_tokens: request.maxTokens ?? DEFAULT_MAX_TOKENS,
    messages,
    ...(tools === undefined || tools.length === 0
      ? {}
      : { tools: tools.map(toWireTool), tool_choice: 'auto' as const }),
  };
}

function toResponse(text: string, toolCalls: AIToolCall[], rawStop: string, input: number, output: number): AIChatResponse {
  return {
    text,
    toolCalls,
    stopReason: stopReason(rawStop),
    usage: { inputTokens: input, outputTokens: output },
    message: { role: 'assistant', content: text, toolCalls },
  };
}

export function createOpenAIProvider(config: ProviderConfig): AIProvider {
  const transport = { baseUrl: config.baseUrl, fetchImpl: config.fetchImpl };

  // The SDK client keeps the raw key on `.apiKey`, so it is built per attempt and never stored.
  function client(scope: CallScope, fetch: typeof globalThis.fetch): OpenAI {
    return new OpenAI({
      apiKey: revealSecret(config.apiKey),
      organization: null,
      project: null,
      adminAPIKey: null,
      webhookSecret: null,
      baseURL: config.baseUrl,
      maxRetries: 0,
      timeout: scope.limits.timeoutMs,
      logLevel: 'off',
      fetch,
    });
  }

  async function complete(request: AIChatRequest, tools: readonly AIToolDefinition[] | undefined): Promise<AIChatResponse> {
    const scope = new CallScope(config.limits, transport, request.signal);
    const raw: unknown = await scope.retry(({ fetch }) =>
      client(scope, fetch).chat.completions.create(
        { ...body(request, config.model, tools), stream: false },
        { signal: scope.signal },
      ),
    );
    const parsed = CompletionSchema.safeParse(raw);
    const choice = parsed.data?.choices[0];
    if (!parsed.success || choice === undefined) throw unavailable('unexpected_response');
    const toolCalls = (choice.message.tool_calls ?? []).map((call) => ({
      id: call.id,
      name: call.function.name,
      input: parseToolArguments(call.function.arguments),
    }));
    assertDeclared(toolCalls, tools);
    const usage = parsed.data.usage;
    return toResponse(
      choice.message.content ?? '',
      toolCalls,
      choice.finish_reason,
      usage?.prompt_tokens ?? 0,
      usage?.completion_tokens ?? 0,
    );
  }

  async function* stream(request: AIStreamRequest): AsyncGenerator<AIStreamChunk> {
    const tools = request.tools;
    const scope = new CallScope(config.limits, transport, request.signal);
    const opened = await scope.retry(({ fetch, state }) =>
      client(scope, fetch)
        .chat.completions.create(
          { ...body(request, config.model, tools), stream: true, stream_options: { include_usage: true } },
          { signal: scope.signal },
        )
        .then((chunks) => ({ chunks, state })),
    );
    const pending = new Map<number, { id: string; name: string; args: string }>();
    let text = '';
    let rawStop: string | undefined;
    let inputTokens = 0;
    let outputTokens = 0;
    try {
      for await (const rawChunk of opened.chunks as AsyncIterable<unknown>) {
        const parsed = ChunkSchema.safeParse(rawChunk);
        if (!parsed.success) throw unavailable('unexpected_response');
        if (parsed.data.usage) {
          inputTokens = parsed.data.usage.prompt_tokens;
          outputTokens = parsed.data.usage.completion_tokens;
        }
        for (const choice of parsed.data.choices) {
          if (choice.index !== 0) continue;
          if (choice.delta.content) {
            text += choice.delta.content;
            yield { type: 'text_delta', text: choice.delta.content };
          }
          for (const fragment of choice.delta.tool_calls ?? []) {
            const entry = pending.get(fragment.index) ?? { id: '', name: '', args: '' };
            entry.id += fragment.id ?? '';
            entry.name += fragment.function?.name ?? '';
            entry.args += fragment.function?.arguments ?? '';
            pending.set(fragment.index, entry);
          }
          if (choice.finish_reason) rawStop = choice.finish_reason;
        }
      }
    } catch (error) {
      throw scope.classify(error, opened.state);
    }
    if (rawStop === undefined) throw scope.classify(new Error('stream ended early'), opened.state);
    const toolCalls: AIToolCall[] = [];
    for (const [, entry] of [...pending.entries()].sort(([a], [b]) => a - b)) {
      if (entry.id === '' || entry.name === '') throw unavailable('unexpected_response');
      toolCalls.push({ id: entry.id, name: entry.name, input: parseToolArguments(entry.args) });
    }
    assertDeclared(toolCalls, tools);
    for (const call of toolCalls) yield { type: 'tool_call', call };
    yield { type: 'done', response: toResponse(text, toolCalls, rawStop, inputTokens, outputTokens) };
  }

  return {
    id: 'openai',
    model: config.model,
    chat: (request) => complete(request, undefined),
    toolCall: (request: AIToolCallRequest) => {
      assertTools(request.tools);
      return complete(request, request.tools);
    },
    stream: (request) => {
      if (request.tools !== undefined && request.tools.length > 0) assertTools(request.tools);
      return stream(request);
    },
  };
}
