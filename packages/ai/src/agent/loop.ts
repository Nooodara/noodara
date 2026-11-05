// 28-04: the read-only agent loop. One question runs provider turns against the closed tool
// registry under hard caps (iterations, tool calls, tokens, wall clock), and ends in exactly one of:
// a grounded structured answer, a named failure, or an abort. Every message, tool result and the
// system prompt go through the Redactor before the provider sees them, and the model's output goes
// through it before anything else does (A5). A tool name outside the registry is refused by the
// registry, never executed, and counted as an unauthorized attempt (A2).
import type { Evidence } from '@noodara/domain';
import { AI_MAX_TOOL_CALLS_PER_MESSAGE, AI_TOOL_NAME_PATTERN, type AiStructuredAnswer } from '@noodara/domain/api-contract';
import type { Redactor } from '@noodara/domain/security';
import { AIProviderError, type AIProviderErrorCode } from '../errors.js';
import { buildSystemPrompt } from '../prompts/system-prompt.js';
import type { ToolCallStatus, ToolRegistry } from '../tools/registry.js';
import type { AIToolErrorCode, AuthorizationScope, ToolTarget } from '../tools/types.js';
import type { AIAssistantMessage, AIChatResponse, AIMessage, AIProvider, AIToolResult, AIUsage } from '../types.js';
import { fallbackAnswer, groundAnswer, GroundingIndex, parseStructuredAnswer, type GroundingReport } from './grounding.js';
import { boundHistory, DEFAULT_HISTORY_LIMITS, estimateTokens, type HistoryLimits } from './history.js';

export interface AgentBudget {
  /** Provider turns, including a repair or correction turn. */
  readonly maxIterations: number;
  /** Tool calls, including refused and malformed ones. */
  readonly maxToolCalls: number;
  /** Input plus output tokens across every turn of this question. */
  readonly maxTokens: number;
  readonly maxWallClockMs: number;
  readonly maxOutputTokensPerTurn: number;
}

export const DEFAULT_AGENT_BUDGET: AgentBudget = Object.freeze({
  maxIterations: 8,
  maxToolCalls: AI_MAX_TOOL_CALLS_PER_MESSAGE,
  maxTokens: 120_000,
  maxWallClockMs: 90_000,
  maxOutputTokensPerTurn: 2_048,
});

export type AgentBudgetKind = 'iterations' | 'tool_calls' | 'tokens' | 'wall_clock';

export type AgentErrorCode = 'AI_BUDGET_EXCEEDED' | 'AI_TOOL_NOT_ALLOWED' | AIProviderErrorCode;

/** What the stream and the stored tool-call record may show: name and scope, never input or output. */
export interface AgentToolCallRecord {
  readonly callId: string;
  /** The requested name when it is a well-formed tool name (refused ones included), else 'invalid'. */
  readonly name: string;
  readonly status: ToolCallStatus;
  readonly errorCode: AIToolErrorCode | null;
  readonly target: ToolTarget | null;
  readonly truncated: boolean;
  readonly durationMs: number;
}

export type AgentEvent =
  | { readonly type: 'text'; readonly text: string }
  | { readonly type: 'tool_call'; readonly call: AgentToolCallRecord };

export type AnswerFormat = 'structured' | 'repaired' | 'fallback';

interface AgentRunCommon {
  readonly iterations: number;
  readonly toolCalls: readonly AgentToolCallRecord[];
  readonly unauthorizedAttempts: number;
  readonly usage: AIUsage;
  /** Most history messages dropped from one request to fit the history bounds. */
  readonly historyDropped: number;
  readonly durationMs: number;
}

export type AgentRunResult =
  | (AgentRunCommon & {
      readonly status: 'answered';
      readonly answer: AiStructuredAnswer;
      readonly grounding: GroundingReport;
      readonly format: AnswerFormat;
    })
  | (AgentRunCommon & { readonly status: 'failed'; readonly errorCode: AgentErrorCode; readonly budget: AgentBudgetKind | null })
  | (AgentRunCommon & { readonly status: 'aborted' });

export interface RunAgentOptions {
  readonly provider: AIProvider;
  readonly registry: ToolRegistry;
  readonly redactor: Redactor;
  readonly scope: AuthorizationScope;
  readonly question: string;
  /** Earlier user and assistant turns of the conversation, oldest first. */
  readonly history?: readonly AIMessage[];
  /** Observations for classifyEvidence; offered to the model as ranked hints. */
  readonly evidence?: readonly Evidence[];
  readonly budget?: Partial<AgentBudget>;
  readonly historyLimits?: Partial<HistoryLimits>;
  readonly signal?: AbortSignal;
  readonly now?: () => number;
  readonly onEvent?: (event: AgentEvent) => void;
}

export const REPAIR_NOTE =
  'Your last reply was not a valid answer object. Reply with only the JSON answer object described in the instructions, and nothing else.';
export const MALFORMED_ARGUMENTS_NOTE =
  'Your last tool call had arguments that were not valid JSON. Send tool arguments as one JSON object that matches the tool schema.';
export const UNKNOWN_TOOL_NOTE =
  'AI_TOOL_NOT_ALLOWED: your last reply called a tool that does not exist. Only the offered read-only tools can be called.';

function isPlainRecord(value: unknown): boolean {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const proto: unknown = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

class Stop {
  constructor(
    readonly status: 'failed' | 'aborted',
    readonly errorCode: AgentErrorCode | null = null,
    readonly budget: AgentBudgetKind | null = null,
  ) {}
}

const budgetExceeded = (kind: AgentBudgetKind): Stop => new Stop('failed', 'AI_BUDGET_EXCEEDED', kind);

export async function runAgent(options: RunAgentOptions): Promise<AgentRunResult> {
  const { provider, registry, redactor } = options;
  const budget: AgentBudget = { ...DEFAULT_AGENT_BUDGET, ...options.budget };
  const limits: HistoryLimits = { ...DEFAULT_HISTORY_LIMITS, ...options.historyLimits };
  const now = options.now ?? Date.now;
  const started = now();
  const deadline = started + budget.maxWallClockMs;

  const records: AgentToolCallRecord[] = [];
  const usage = { inputTokens: 0, outputTokens: 0 };
  let iterations = 0;
  let unauthorizedAttempts = 0;
  let historyDropped = 0;

  const common = (): AgentRunCommon => ({
    iterations,
    toolCalls: records,
    unauthorizedAttempts,
    usage: { ...usage },
    historyDropped,
    durationMs: Math.max(0, now() - started),
  });
  const stopped = (stop: Stop): AgentRunResult =>
    stop.status === 'aborted' || stop.errorCode === null
      ? { ...common(), status: 'aborted' }
      : { ...common(), status: 'failed', errorCode: stop.errorCode, budget: stop.budget };
  const emit = (event: AgentEvent): void => {
    try {
      options.onEvent?.(event);
    } catch {
      // A listener failure never breaks the loop.
    }
  };

  if (options.signal?.aborted === true) return stopped(new Stop('aborted'));

  const controller = new AbortController();
  let deadlineHit = false;
  const onCallerAbort = (): void => {
    controller.abort();
  };
  options.signal?.addEventListener('abort', onCallerAbort, { once: true });
  const timer = setTimeout(() => {
    deadlineHit = true;
    controller.abort();
  }, budget.maxWallClockMs);

  const interrupted = (): Stop | null => {
    if (deadlineHit || now() >= deadline) return budgetExceeded('wall_clock');
    if (controller.signal.aborted) return new Stop('aborted');
    return null;
  };

  const system = redactor.redact(buildSystemPrompt({ scope: options.scope, evidence: options.evidence }));
  const tools = registry.definitions;
  const overheadTokens = estimateTokens(system) + estimateTokens(tools);
  const history = options.history ?? [];
  const messages: AIMessage[] = [...history, { role: 'user', content: options.question }];
  const questionIndex = history.length;
  const session = registry.openSession({ scope: options.scope, redactor, maxCalls: budget.maxToolCalls, now });
  const index = new GroundingIndex();
  let malformedReported = false;
  let unknownToolReported = false;
  let repaired = false;

  async function turn(): Promise<AIChatResponse | Stop | 'retry'> {
    const bounded = boundHistory(messages, questionIndex, limits, overheadTokens);
    historyDropped = Math.max(historyDropped, bounded.dropped);
    if (usage.inputTokens + usage.outputTokens + bounded.estimatedTokens > budget.maxTokens) return budgetExceeded('tokens');
    iterations += 1;
    try {
      return await provider.toolCall({
        system,
        tools,
        messages: redactor.redact(bounded.messages),
        maxTokens: budget.maxOutputTokensPerTurn,
        signal: controller.signal,
      });
    } catch (error) {
      const stop = interrupted();
      if (stop !== null) return stop;
      if (!(error instanceof AIProviderError)) throw error;
      // H1: arguments that were not JSON are reported back once; a second time ends the run.
      if (error.reason === 'malformed' && !malformedReported) {
        malformedReported = true;
        messages.push({ role: 'user', content: MALFORMED_ARGUMENTS_NOTE });
        return 'retry';
      }
      // A provider that rejects an undeclared tool itself: still an unauthorized attempt (A2).
      if (error.reason === 'unexpected_tool') {
        unauthorizedAttempts += 1;
        if (unknownToolReported) return new Stop('failed', 'AI_TOOL_NOT_ALLOWED');
        unknownToolReported = true;
        messages.push({ role: 'user', content: UNKNOWN_TOOL_NOTE });
        return 'retry';
      }
      return new Stop('failed', error.code);
    }
  }

  async function runTools(message: AIAssistantMessage): Promise<AIToolResult[] | Stop> {
    if (session.callsUsed + message.toolCalls.length > budget.maxToolCalls) {
      unauthorizedAttempts += message.toolCalls.filter((call) => !registry.has(call.name)).length;
      return budgetExceeded('tool_calls');
    }
    const results: AIToolResult[] = [];
    for (const call of message.toolCalls) {
      const stop = interrupted();
      if (stop !== null) return stop;
      if (!isPlainRecord(call.input)) {
        if (malformedReported) return new Stop('failed', 'AI_PROVIDER_UNAVAILABLE');
        malformedReported = true;
      }
      if (!registry.has(call.name)) unauthorizedAttempts += 1;
      const execution = await session.execute({ name: call.name, input: call.input });
      if (execution.status === 'ok') {
        index.addCall(call.id);
        index.addResult(execution.envelope.data);
        if (execution.target !== null) index.addResult(execution.target.id);
      } else if (execution.status === 'error' && execution.errorCode !== 'INVALID_ARGUMENTS') {
        index.addCall(call.id);
      }
      const record: AgentToolCallRecord = {
        callId: call.id,
        name: AI_TOOL_NAME_PATTERN.test(call.name) ? call.name : 'invalid',
        status: execution.status,
        errorCode: execution.errorCode,
        target: execution.target,
        truncated: execution.truncated,
        durationMs: execution.durationMs,
      };
      records.push(record);
      emit({ type: 'tool_call', call: record });
      results.push({ toolCallId: call.id, content: execution.content, isError: execution.status !== 'ok' });
    }
    return results;
  }

  try {
    for (;;) {
      const before = interrupted();
      if (before !== null) return stopped(before);
      if (iterations >= budget.maxIterations) return stopped(budgetExceeded('iterations'));

      const response = await turn();
      if (response === 'retry') continue;
      if (response instanceof Stop) return stopped(response);
      usage.inputTokens += response.usage.inputTokens;
      usage.outputTokens += response.usage.outputTokens;
      if (usage.inputTokens + usage.outputTokens > budget.maxTokens) return stopped(budgetExceeded('tokens'));

      // Model output is redacted before it is stored, shown, parsed or replayed.
      const message = redactor.redact(response.message);
      messages.push(message);

      if (message.toolCalls.length === 0) {
        const parsed = parseStructuredAnswer(message.content);
        if (parsed === null && !repaired && iterations < budget.maxIterations) {
          repaired = true;
          messages.push({ role: 'user', content: REPAIR_NOTE });
          continue;
        }
        const grounded = groundAnswer(redactor.redact(parsed ?? fallbackAnswer()), index);
        const format: AnswerFormat = parsed === null ? 'fallback' : repaired ? 'repaired' : 'structured';
        return { ...common(), status: 'answered', answer: grounded.answer, grounding: grounded.report, format };
      }

      if (message.content !== '') emit({ type: 'text', text: message.content });
      if (iterations >= budget.maxIterations) {
        unauthorizedAttempts += message.toolCalls.filter((call) => !registry.has(call.name)).length;
        return stopped(budgetExceeded('iterations'));
      }
      const results = await runTools(message);
      if (results instanceof Stop) return stopped(results);
      messages.push({ role: 'tool', results });
    }
  } finally {
    clearTimeout(timer);
    options.signal?.removeEventListener('abort', onCallerAbort);
  }
}
