// 28-03: the read-only tool contract. A tool is a closed, named read over Postgres and the 27-xx
// observability reads; it never takes a free string that reaches SSH or a shell. `kind` admits only
// 'read' at the type level (A2), and the registry is a closed set (A1).
import type { LogFilter } from '@noodara/domain';

/** The only kind a tool can have. A write kind does not type-check (tool-types.test.ts). */
export type AIToolKind = 'read';

/** The closed tool set, in the order the model sees them. */
export const AI_TOOL_NAMES = Object.freeze([
  'get_server',
  'list_servers',
  'get_service',
  'list_services',
  'get_deployment',
  'list_deployments',
  'get_health',
  'get_metrics',
  'get_logs',
  'get_infrastructure_graph',
] as const);
export type AIToolName = (typeof AI_TOOL_NAMES)[number];

export function isAIToolName(name: string): name is AIToolName {
  return (AI_TOOL_NAMES as readonly string[]).includes(name);
}

/**
 * What a conversation may read, enforced in the backend on every call. `global` sees every
 * project; `project` sees one project, its environments, services and deployments, and only the
 * servers that host one of its services. An id outside the scope is NOT_FOUND, never FORBIDDEN.
 */
export type AuthorizationScope =
  | { readonly kind: 'global' }
  | { readonly kind: 'project'; readonly projectId: string };

export const TOOL_TARGET_KINDS = Object.freeze(['Server', 'Project', 'Environment', 'Service', 'Deployment'] as const);
export type ToolTargetKind = (typeof TOOL_TARGET_KINDS)[number];

/** The entity one call targets; the envelope's `scope` and the stored tool-call record use it. */
export interface ToolTarget {
  readonly kind: ToolTargetKind;
  readonly id: string;
}

/** Errors a backend may answer with. Anything else it throws becomes TOOL_UNAVAILABLE. */
export type ToolBackendErrorCode = 'NOT_FOUND' | 'INVALID_ARGUMENTS' | 'TOOL_UNAVAILABLE' | 'LOG_SOURCE_UNAVAILABLE' | 'METRICS_UNAVAILABLE';

/** Every error a tool call can report to the model. */
export type AIToolErrorCode = ToolBackendErrorCode | 'AI_TOOL_NOT_ALLOWED' | 'AI_BUDGET_EXCEEDED';

export type ToolOutcome =
  | { readonly ok: true; readonly data: unknown }
  | { readonly ok: false; readonly code: ToolBackendErrorCode };

// ---- per-tool input, after validation ---------------------------------------------------------

export interface GetServerInput {
  readonly serverId: string;
}
export type ListServersInput = Readonly<Record<string, never>>;
export interface GetServiceInput {
  readonly serviceId: string;
}
export interface ListServicesInput {
  readonly projectId?: string | undefined;
  readonly environmentId?: string | undefined;
}
export interface GetDeploymentInput {
  readonly deploymentId: string;
}
export interface ListDeploymentsInput {
  readonly serviceId: string;
  readonly limit: number;
}
export interface GetHealthInput {
  readonly serviceId: string;
}
export interface GetMetricsInput {
  readonly target: 'server' | 'service';
  readonly id: string;
  readonly from?: string | undefined;
  readonly to?: string | undefined;
  readonly points: number;
}
/** The filter went through parseLogFilter (substring search only); caps are lower than the API's. */
export interface GetLogsInput {
  readonly serviceId: string;
  readonly filter: LogFilter;
  readonly limit: number;
  readonly maxBytes: number;
}
export interface GetGraphInput {
  readonly projectId?: string | undefined;
  readonly environmentId?: string | undefined;
  readonly maxNodes: number;
}

export interface ToolInputs {
  readonly get_server: GetServerInput;
  readonly list_servers: ListServersInput;
  readonly get_service: GetServiceInput;
  readonly list_services: ListServicesInput;
  readonly get_deployment: GetDeploymentInput;
  readonly list_deployments: ListDeploymentsInput;
  readonly get_health: GetHealthInput;
  readonly get_metrics: GetMetricsInput;
  readonly get_logs: GetLogsInput;
  readonly get_infrastructure_graph: GetGraphInput;
}

/** One read per tool. Implemented by the control plane over Postgres and the 27-xx reads. */
export type ReadToolBackend = {
  readonly [N in AIToolName]: (input: ToolInputs[N], scope: AuthorizationScope) => Promise<ToolOutcome>;
};

export interface ToolArgIssue {
  /** Dotted field path; never the value the model sent. */
  readonly path: string;
  readonly code: string;
}

export type ToolArgsResult<I> =
  | { readonly ok: true; readonly input: I }
  | { readonly ok: false; readonly issues: readonly ToolArgIssue[] };

/** A read-only tool. `parse` validates the model's raw arguments; it never throws. */
export interface AITool<N extends AIToolName = AIToolName> {
  readonly name: N;
  readonly kind: AIToolKind;
  readonly description: string;
  /** JSON Schema of the arguments, derived from the tool's Zod schema. */
  readonly inputSchema: Readonly<Record<string, unknown>>;
  parse(raw: unknown, nowMs: number): ToolArgsResult<ToolInputs[N]>;
  target(input: ToolInputs[N], scope: AuthorizationScope): ToolTarget | null;
}
