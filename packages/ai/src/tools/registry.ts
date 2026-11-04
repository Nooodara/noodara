// 28-03 (A1-A3, H1): the registry runs one tool call at a time for a session. A call to a name
// outside the closed set is refused (AI_TOOL_NOT_ALLOWED) and never reaches the backend; malformed
// arguments are a tool error, never a throw; every call, valid or not, counts toward the session's
// cap. Results and errors go back as the fixed JSON envelope.
import type { Redactor } from '@noodara/domain/security';
import type { AIToolDefinition } from '../types.js';
import { READ_ONLY_TOOLS } from './definitions.js';
import { AI_TOOL_RESULT_MAX_BYTES, buildToolEnvelope, serializeToolEnvelope, type ToolEnvelope } from './envelope.js';
import {
  AI_TOOL_NAMES,
  isAIToolName,
  type AITool,
  type AIToolErrorCode,
  type AIToolName,
  type AuthorizationScope,
  type ReadToolBackend,
  type ToolArgIssue,
  type ToolOutcome,
  type ToolTarget,
} from './types.js';

export const AI_TOOL_CALLS_DEFAULT_MAX = 16;

export type ToolCallStatus = 'ok' | 'error' | 'refused';

export interface ToolExecution {
  readonly tool: string;
  readonly status: ToolCallStatus;
  readonly errorCode: AIToolErrorCode | null;
  readonly target: ToolTarget | null;
  readonly truncated: boolean;
  readonly envelope: ToolEnvelope;
  /** `JSON.stringify(envelope)`: the only text the model receives for this call. */
  readonly content: string;
  readonly durationMs: number;
}

export interface ToolCallRequest {
  readonly name: string;
  readonly input: unknown;
}

export interface ToolSessionOptions {
  readonly scope: AuthorizationScope;
  readonly redactor: Redactor;
  /** Every call counts, including refused and malformed ones. */
  readonly maxCalls?: number;
  readonly maxResultBytes?: number;
  readonly now?: () => number;
}

export interface ToolSession {
  execute(call: ToolCallRequest): Promise<ToolExecution>;
  readonly callsUsed: number;
}

export interface ToolRegistry {
  readonly names: readonly AIToolName[];
  readonly tools: readonly AITool[];
  /** What the provider is offered: name, description and the JSON Schema of the arguments. */
  readonly definitions: readonly [AIToolDefinition, ...AIToolDefinition[]];
  has(name: string): name is AIToolName;
  openSession(options: ToolSessionOptions): ToolSession;
}

const MESSAGES: Readonly<Record<AIToolErrorCode, string>> = Object.freeze({
  NOT_FOUND: 'Nothing with that id is visible in this conversation.',
  INVALID_ARGUMENTS: 'The arguments do not match the tool schema.',
  TOOL_UNAVAILABLE: 'The tool could not read this right now.',
  LOG_SOURCE_UNAVAILABLE: 'Logs from this source could not be read.',
  METRICS_UNAVAILABLE: 'Metrics are not available yet.',
  AI_TOOL_NOT_ALLOWED: 'This tool does not exist. Only the offered read-only tools can be called.',
  AI_BUDGET_EXCEEDED: 'The tool call limit for this question was reached.',
});

interface Failure {
  readonly code: AIToolErrorCode;
  readonly issues?: readonly ToolArgIssue[];
}

type Run = { readonly ok: true; readonly data: unknown; readonly target: ToolTarget | null } | (Failure & { readonly ok: false; readonly target: ToolTarget | null });

async function runTool<N extends AIToolName>(
  tool: AITool<N>,
  backend: ReadToolBackend,
  raw: unknown,
  scope: AuthorizationScope,
  nowMs: number,
): Promise<Run> {
  const parsed = tool.parse(raw, nowMs);
  if (!parsed.ok) return { ok: false, code: 'INVALID_ARGUMENTS', issues: parsed.issues, target: null };
  const target = tool.target(parsed.input, scope);
  const read = backend[tool.name] as (input: typeof parsed.input, scope: AuthorizationScope) => Promise<ToolOutcome>;
  let outcome: ToolOutcome;
  try {
    outcome = await read(parsed.input, scope);
  } catch {
    // A backend failure is reported to the model with a fixed message, never its text.
    return { ok: false, code: 'TOOL_UNAVAILABLE', target };
  }
  return outcome.ok ? { ok: true, data: outcome.data, target } : { ok: false, code: outcome.code, target };
}

/** Builds the closed registry over one backend. */
export function createToolRegistry(backend: ReadToolBackend): ToolRegistry {
  const tools: readonly AITool[] = Object.freeze(AI_TOOL_NAMES.map((name) => READ_ONLY_TOOLS[name] as AITool));
  const definitions = tools.map((tool) => ({
    name: tool.name,
    description: tool.description,
    inputSchema: tool.inputSchema,
  })) as unknown as readonly [AIToolDefinition, ...AIToolDefinition[]];

  function openSession(options: ToolSessionOptions): ToolSession {
    const maxCalls = options.maxCalls ?? AI_TOOL_CALLS_DEFAULT_MAX;
    const maxBytes = options.maxResultBytes ?? AI_TOOL_RESULT_MAX_BYTES;
    const now = options.now ?? Date.now;
    let used = 0;

    function finish(name: string, started: number, run: Run, truncatedHint = false): ToolExecution {
      const status: ToolCallStatus = run.ok ? 'ok' : run.code === 'AI_TOOL_NOT_ALLOWED' ? 'refused' : 'error';
      const data = run.ok
        ? run.data
        : { error: run.code, message: MESSAGES[run.code], ...(run.issues !== undefined ? { issues: run.issues } : {}) };
      const envelope = buildToolEnvelope({ tool: name, scope: run.target, data, truncated: truncatedHint }, options.redactor, maxBytes);
      return {
        tool: envelope.tool,
        status,
        errorCode: run.ok ? null : run.code,
        target: run.target,
        truncated: envelope.truncated,
        envelope,
        content: serializeToolEnvelope(envelope),
        durationMs: Math.max(0, now() - started),
      };
    }

    return {
      get callsUsed() {
        return used;
      },
      async execute(call: ToolCallRequest): Promise<ToolExecution> {
        const started = now();
        used += 1;
        if (used > maxCalls) return finish(call.name, started, { ok: false, code: 'AI_BUDGET_EXCEEDED', target: null });
        if (!isAIToolName(call.name)) return finish(call.name, started, { ok: false, code: 'AI_TOOL_NOT_ALLOWED', target: null });
        const run = await runTool(READ_ONLY_TOOLS[call.name] as AITool, backend, call.input, options.scope, started);
        const truncatedHint = run.ok && hasTruncatedFlag(run.data);
        return finish(call.name, started, run, truncatedHint);
      },
    };
  }

  return Object.freeze({
    names: AI_TOOL_NAMES,
    tools,
    definitions,
    has: isAIToolName,
    openSession,
  });
}

/** A backend page that says it was cut (e.g. a capped log page) marks the envelope truncated too. */
function hasTruncatedFlag(data: unknown): boolean {
  return typeof data === 'object' && data !== null && (data as { truncated?: unknown }).truncated === true;
}
