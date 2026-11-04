// Provider-neutral AI types (ADR 0012, A5). Nothing here knows a vendor wire format: providers
// under src/providers translate to and from these shapes.

/** Every provider id the product knows about. Only IMPLEMENTED_AI_PROVIDER_IDS can be built. */
export const AI_PROVIDER_IDS = Object.freeze([
  'anthropic',
  'openai',
  'openai-compatible',
  'openrouter',
  'azure-openai',
  'bedrock',
] as const);
export type AIProviderId = (typeof AI_PROVIDER_IDS)[number];

export const IMPLEMENTED_AI_PROVIDER_IDS = Object.freeze(['anthropic', 'openai'] as const);
export type ImplementedAIProviderId = (typeof IMPLEMENTED_AI_PROVIDER_IDS)[number];

export function isImplementedAIProviderId(id: string): id is ImplementedAIProviderId {
  return (IMPLEMENTED_AI_PROVIDER_IDS as readonly string[]).includes(id);
}

export interface AIToolDefinition {
  readonly name: string;
  readonly description: string;
  /** JSON Schema object for the tool input. */
  readonly inputSchema: Readonly<Record<string, unknown>>;
}

export interface AIToolCall {
  readonly id: string;
  readonly name: string;
  readonly input: Readonly<Record<string, unknown>>;
}

export interface AIToolResult {
  readonly toolCallId: string;
  readonly content: string;
  readonly isError: boolean;
}

/** Opaque provider reasoning (e.g. Anthropic thinking blocks) replayed verbatim on the next turn. */
export interface AIReasoning {
  readonly provider: ImplementedAIProviderId;
  readonly blocks: readonly unknown[];
}

export interface AIUserMessage {
  readonly role: 'user';
  readonly content: string;
}

export interface AIAssistantMessage {
  readonly role: 'assistant';
  readonly content: string;
  readonly toolCalls: readonly AIToolCall[];
  readonly reasoning?: AIReasoning;
}

export interface AIToolMessage {
  readonly role: 'tool';
  readonly results: readonly AIToolResult[];
}

export type AIMessage = AIUserMessage | AIAssistantMessage | AIToolMessage;

export type AIStopReason = 'end_turn' | 'tool_use' | 'max_tokens' | 'refusal' | 'pause' | 'other';

export interface AIUsage {
  readonly inputTokens: number;
  readonly outputTokens: number;
}

export interface AIChatResponse {
  readonly text: string;
  readonly toolCalls: readonly AIToolCall[];
  readonly stopReason: AIStopReason;
  readonly usage: AIUsage;
  /** The assistant turn to append to the conversation (carries reasoning for replay). */
  readonly message: AIAssistantMessage;
}

export type AIStreamChunk =
  | { readonly type: 'text_delta'; readonly text: string }
  | { readonly type: 'tool_call'; readonly call: AIToolCall }
  | { readonly type: 'done'; readonly response: AIChatResponse };

export interface AIChatRequest {
  readonly system?: string;
  readonly messages: readonly AIMessage[];
  readonly maxTokens?: number;
  readonly signal?: AbortSignal;
}

export interface AIStreamRequest extends AIChatRequest {
  readonly tools?: readonly AIToolDefinition[];
}

export interface AIToolCallRequest extends AIChatRequest {
  readonly tools: readonly [AIToolDefinition, ...AIToolDefinition[]];
}

export interface AIProvider {
  readonly id: ImplementedAIProviderId;
  readonly model: string;
  /** One plain turn, no tools offered. */
  chat(request: AIChatRequest): Promise<AIChatResponse>;
  /** One streamed turn; ends with exactly one `done` chunk or throws an AIProviderError. */
  stream(request: AIStreamRequest): AsyncIterable<AIStreamChunk>;
  /** One turn with tools offered; calls to undeclared tools are rejected. */
  toolCall(request: AIToolCallRequest): Promise<AIChatResponse>;
}
