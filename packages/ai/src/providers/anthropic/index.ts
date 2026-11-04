import Anthropic from '@anthropic-ai/sdk';
import { revealSecret } from '@noodara/domain/security';
import { z } from 'zod';
import { CallScope } from '../../call.js';
import type { CallState } from '../../guarded-fetch.js';
import { unavailable } from '../../errors.js';
import {
  assertDeclared,
  assertTools,
  DEFAULT_MAX_TOKENS,
  parseToolArguments,
  type ProviderConfig,
} from '../../provider-kit.js';
import type {
  AIAssistantMessage,
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

// Anthropic Messages API (ADR 0012): adaptive thinking, effort medium, strict tools, tool_choice
// auto. Every response and stream event is parsed through the schemas below.

const TextBlock = z.object({ type: z.literal('text'), text: z.string() });
const ToolUseBlock = z.object({
  type: z.literal('tool_use'),
  id: z.string().min(1),
  name: z.string().min(1),
  input: z.record(z.string(), z.unknown()),
});
const ThinkingBlock = z.object({ type: z.literal('thinking'), thinking: z.string(), signature: z.string() });
const RedactedThinkingBlock = z.object({ type: z.literal('redacted_thinking'), data: z.string() });
const ContentBlock = z.discriminatedUnion('type', [TextBlock, ToolUseBlock, ThinkingBlock, RedactedThinkingBlock]);
const ReasoningBlock = z.discriminatedUnion('type', [ThinkingBlock, RedactedThinkingBlock]);
const Usage = z.object({ input_tokens: z.number().int().nonnegative(), output_tokens: z.number().int().nonnegative() });

const MessageSchema = z.object({
  type: z.literal('message'),
  role: z.literal('assistant'),
  content: z.array(ContentBlock),
  stop_reason: z.string().nullable(),
  usage: Usage,
});

const StreamEvent = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('message_start'),
    message: z.object({
      usage: z.object({ input_tokens: z.number().int().nonnegative(), output_tokens: z.number().int().nonnegative().optional() }),
    }),
  }),
  z.object({ type: z.literal('content_block_start'), index: z.number().int().nonnegative(), content_block: ContentBlock }),
  z.object({
    type: z.literal('content_block_delta'),
    index: z.number().int().nonnegative(),
    delta: z.discriminatedUnion('type', [
      z.object({ type: z.literal('text_delta'), text: z.string() }),
      z.object({ type: z.literal('input_json_delta'), partial_json: z.string() }),
      z.object({ type: z.literal('thinking_delta'), thinking: z.string() }),
      z.object({ type: z.literal('signature_delta'), signature: z.string() }),
    ]),
  }),
  z.object({ type: z.literal('content_block_stop'), index: z.number().int().nonnegative() }),
  z.object({
    type: z.literal('message_delta'),
    delta: z.object({ stop_reason: z.string().nullable() }),
    usage: z.object({ output_tokens: z.number().int().nonnegative() }),
  }),
  z.object({ type: z.literal('message_stop') }),
  z.object({ type: z.literal('ping') }),
]);

type Block = z.infer<typeof ContentBlock>;

function stopReason(raw: string | null): AIStopReason {
  switch (raw) {
    case 'end_turn':
    case 'stop_sequence':
      return 'end_turn';
    case 'tool_use':
      return 'tool_use';
    case 'max_tokens':
    case 'model_context_window_exceeded':
      return 'max_tokens';
    case 'refusal':
      return 'refusal';
    case 'pause_turn':
      return 'pause';
    default:
      return 'other';
  }
}

function toWireMessage(message: AIMessage): Anthropic.MessageParam {
  if (message.role === 'user') return { role: 'user', content: message.content };
  if (message.role === 'tool') {
    return {
      role: 'user',
      content: message.results.map((result) => ({
        type: 'tool_result' as const,
        tool_use_id: result.toolCallId,
        content: result.content,
        is_error: result.isError,
      })),
    };
  }
  const content: Anthropic.ContentBlockParam[] = [];
  if (message.reasoning?.provider === 'anthropic') {
    for (const block of message.reasoning.blocks) {
      const parsed = ReasoningBlock.safeParse(block);
      if (parsed.success) content.push(parsed.data);
    }
  }
  if (message.content !== '') content.push({ type: 'text', text: message.content });
  for (const call of message.toolCalls) {
    content.push({ type: 'tool_use', id: call.id, name: call.name, input: call.input });
  }
  return { role: 'assistant', content };
}

function toWireTool(tool: AIToolDefinition): Anthropic.Tool {
  return {
    name: tool.name,
    description: tool.description,
    input_schema: { type: 'object', ...tool.inputSchema },
    strict: true,
  };
}

function body(request: AIChatRequest, model: string, tools: readonly AIToolDefinition[] | undefined) {
  return {
    model,
    max_tokens: request.maxTokens ?? DEFAULT_MAX_TOKENS,
    messages: request.messages.map(toWireMessage),
    thinking: { type: 'adaptive' as const },
    output_config: { effort: 'medium' as const },
    ...(request.system === undefined ? {} : { system: request.system }),
    ...(tools === undefined || tools.length === 0
      ? {}
      : { tools: tools.map(toWireTool), tool_choice: { type: 'auto' as const } }),
  };
}

function toResponse(blocks: readonly Block[], rawStop: string | null, input: number, output: number): AIChatResponse {
  let text = '';
  const toolCalls: AIToolCall[] = [];
  const reasoning: unknown[] = [];
  for (const block of blocks) {
    if (block.type === 'text') text += block.text;
    else if (block.type === 'tool_use') toolCalls.push({ id: block.id, name: block.name, input: block.input });
    else reasoning.push(block);
  }
  const message: AIAssistantMessage = {
    role: 'assistant',
    content: text,
    toolCalls,
    ...(reasoning.length > 0 ? { reasoning: { provider: 'anthropic' as const, blocks: reasoning } } : {}),
  };
  return { text, toolCalls, stopReason: stopReason(rawStop), usage: { inputTokens: input, outputTokens: output }, message };
}

export function createAnthropicProvider(config: ProviderConfig): AIProvider {
  const transport = { baseUrl: config.baseUrl, fetchImpl: config.fetchImpl };

  // The SDK client keeps the raw key on `.apiKey`, so it is built per attempt and never stored.
  function client(scope: CallScope, fetch: typeof globalThis.fetch): Anthropic {
    return new Anthropic({
      apiKey: revealSecret(config.apiKey),
      authToken: null,
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
      client(scope, fetch).messages.create(
        { ...body(request, config.model, tools), stream: false },
        { signal: scope.signal },
      ),
    );
    const parsed = MessageSchema.safeParse(raw);
    if (!parsed.success) throw unavailable('unexpected_response');
    const response = toResponse(parsed.data.content, parsed.data.stop_reason, parsed.data.usage.input_tokens, parsed.data.usage.output_tokens);
    assertDeclared(response.toolCalls, tools);
    return response;
  }

  async function* stream(request: AIStreamRequest): AsyncGenerator<AIStreamChunk> {
    const tools = request.tools;
    const scope = new CallScope(config.limits, transport, request.signal);
    const opened = await scope.retry(({ fetch, state }) =>
      client(scope, fetch)
        .messages.create({ ...body(request, config.model, tools), stream: true }, { signal: scope.signal })
        .then((events) => ({ events, state })),
    );
    const state: CallState = opened.state;
    const blocks = new Map<number, Block>();
    const partialJson = new Map<number, string>();
    let inputTokens = 0;
    let outputTokens = 0;
    let rawStop: string | null = null;
    let finished = false;
    try {
      for await (const rawEvent of opened.events as AsyncIterable<unknown>) {
        const parsed = StreamEvent.safeParse(rawEvent);
        if (!parsed.success) throw unavailable('unexpected_response');
        const event = parsed.data;
        if (event.type === 'message_start') {
          inputTokens = event.message.usage.input_tokens;
          outputTokens = event.message.usage.output_tokens ?? 0;
        } else if (event.type === 'content_block_start') {
          blocks.set(event.index, event.content_block);
        } else if (event.type === 'content_block_delta') {
          const block = blocks.get(event.index);
          const delta = event.delta;
          if (block === undefined) throw unavailable('unexpected_response');
          if (delta.type === 'text_delta' && block.type === 'text') {
            block.text += delta.text;
            yield { type: 'text_delta', text: delta.text };
          } else if (delta.type === 'input_json_delta' && block.type === 'tool_use') {
            partialJson.set(event.index, (partialJson.get(event.index) ?? '') + delta.partial_json);
          } else if (delta.type === 'thinking_delta' && block.type === 'thinking') {
            block.thinking += delta.thinking;
          } else if (delta.type === 'signature_delta' && block.type === 'thinking') {
            block.signature += delta.signature;
          } else {
            throw unavailable('unexpected_response');
          }
        } else if (event.type === 'content_block_stop') {
          const block = blocks.get(event.index);
          if (block?.type === 'tool_use') {
            const json = partialJson.get(event.index);
            if (json !== undefined) block.input = parseToolArguments(json);
            const call: AIToolCall = { id: block.id, name: block.name, input: block.input };
            assertDeclared([call], tools);
            yield { type: 'tool_call', call };
          }
        } else if (event.type === 'message_delta') {
          rawStop = event.delta.stop_reason;
          outputTokens = event.usage.output_tokens;
        } else if (event.type === 'message_stop') {
          finished = true;
        }
      }
    } catch (error) {
      throw scope.classify(error, state);
    }
    if (!finished) throw scope.classify(new Error('stream ended early'), state);
    const ordered = [...blocks.entries()].sort(([a], [b]) => a - b).map(([, block]) => block);
    yield { type: 'done', response: toResponse(ordered, rawStop, inputTokens, outputTokens) };
  }

  return {
    id: 'anthropic',
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
