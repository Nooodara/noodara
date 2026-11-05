// 28-04 (A5): a scripted AIProvider for unit tests, evals and canaries. It records every request it
// receives and answers each `toolCall` turn with the next scripted step; it never touches a network.
import { AIProviderError } from '../errors.js';
import type {
  AIAssistantMessage,
  AIChatRequest,
  AIChatResponse,
  AIProvider,
  AIStreamChunk,
  AIStreamRequest,
  AIToolCall,
  AIToolCallRequest,
  AIUsage,
} from '../types.js';

export interface ScriptedTurn {
  readonly text?: string;
  readonly toolCalls?: readonly AIToolCall[];
  readonly usage?: Partial<AIUsage>;
}

/** A turn, an error to throw, or a function computing either from the request. */
export type ScriptedStep =
  | ScriptedTurn
  | AIProviderError
  | ((request: AIStreamRequest) => ScriptedTurn | AIProviderError | Promise<ScriptedTurn | AIProviderError>);

export interface ScriptedProvider extends AIProvider {
  /** Every request, in order, exactly as the agent sent it. */
  readonly requests: readonly AIStreamRequest[];
}

export function respond(turn: ScriptedTurn): AIChatResponse {
  const toolCalls = turn.toolCalls ?? [];
  const text = turn.text ?? '';
  const message: AIAssistantMessage = { role: 'assistant', content: text, toolCalls };
  return {
    text,
    toolCalls,
    stopReason: toolCalls.length > 0 ? 'tool_use' : 'end_turn',
    usage: { inputTokens: turn.usage?.inputTokens ?? 10, outputTokens: turn.usage?.outputTokens ?? 10 },
    message,
  };
}

export function createScriptedProvider(steps: readonly ScriptedStep[]): ScriptedProvider {
  const requests: AIStreamRequest[] = [];
  let next = 0;

  async function turn(request: AIStreamRequest): Promise<AIChatResponse> {
    requests.push(request);
    const step = steps[next];
    next += 1;
    if (step === undefined) throw new AIProviderError('AI_PROVIDER_UNAVAILABLE', 'unexpected_response');
    const resolved = typeof step === 'function' ? await step(request) : step;
    if (resolved instanceof AIProviderError) throw resolved;
    return respond(resolved);
  }

  return {
    id: 'anthropic',
    model: 'scripted',
    requests,
    chat: (request: AIChatRequest) => turn(request),
    // eslint-disable-next-line @typescript-eslint/require-await -- the async generator mirrors the provider contract
    async *stream(): AsyncIterable<AIStreamChunk> {
      throw new AIProviderError('AI_PROVIDER_UNAVAILABLE', 'unexpected_response');
    },
    toolCall: (request: AIToolCallRequest) => turn(request),
  };
}
