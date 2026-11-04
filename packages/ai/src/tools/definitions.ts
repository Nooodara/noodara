// 28-03 (A1, A2, H1): the closed set of read-only tools. Each one validates its arguments with its
// own strict Zod schema; get_logs also runs parseLogFilter (plain substring search, bounded window)
// and caps lines and bytes below the logs API. Ids are UUIDs and every other field is an enum, a
// bounded number, a timestamp or the log search substring: nothing can reach SSH or a shell.
import { LOG_LEVELS, LOG_SEARCH_MAX_LENGTH, LOG_SOURCES, parseLogFilter } from '@noodara/domain';
import { z } from 'zod';
import {
  AI_TOOL_NAMES,
  type AITool,
  type AIToolName,
  type AuthorizationScope,
  type ToolArgIssue,
  type ToolArgsResult,
  type ToolInputs,
  type ToolTarget,
} from './types.js';

/** get_logs: the API answers up to 200 entries / 2 MiB per page; a tool answers far less. */
export const AI_TOOL_LOG_DEFAULT_LINES = 50;
export const AI_TOOL_LOG_MAX_LINES = 100;
export const AI_TOOL_LOG_MAX_BYTES = 16 * 1024;
export const AI_TOOL_DEPLOYMENTS_DEFAULT = 10;
export const AI_TOOL_DEPLOYMENTS_MAX = 20;
export const AI_TOOL_METRIC_POINTS_DEFAULT = 30;
export const AI_TOOL_METRIC_POINTS_MAX = 60;
export const AI_TOOL_GRAPH_MAX_NODES = 100;
const MAX_ISSUES = 5;

const Id = z.uuid();
const Timestamp = z.iso.datetime({ offset: true });

const SCHEMAS = {
  get_server: z.strictObject({ serverId: Id }),
  list_servers: z.strictObject({}),
  get_service: z.strictObject({ serviceId: Id }),
  list_services: z.strictObject({ projectId: Id.optional(), environmentId: Id.optional() }),
  get_deployment: z.strictObject({ deploymentId: Id }),
  list_deployments: z.strictObject({
    serviceId: Id,
    limit: z.int().min(1).max(AI_TOOL_DEPLOYMENTS_MAX).optional(),
  }),
  get_health: z.strictObject({ serviceId: Id }),
  get_metrics: z.strictObject({
    target: z.enum(['server', 'service']),
    id: Id,
    from: Timestamp.optional(),
    to: Timestamp.optional(),
    points: z.int().min(1).max(AI_TOOL_METRIC_POINTS_MAX).optional(),
  }),
  get_logs: z.strictObject({
    serviceId: Id,
    sources: z.array(z.enum(LOG_SOURCES)).min(1).max(LOG_SOURCES.length).optional(),
    since: Timestamp.optional(),
    until: Timestamp.optional(),
    level: z.enum(LOG_LEVELS).optional(),
    search: z.string().max(LOG_SEARCH_MAX_LENGTH).optional(),
    limit: z.int().min(1).max(AI_TOOL_LOG_MAX_LINES).optional(),
  }),
  get_infrastructure_graph: z.strictObject({ projectId: Id.optional(), environmentId: Id.optional() }),
} as const satisfies Record<AIToolName, z.ZodType>;

const DESCRIPTIONS: Readonly<Record<AIToolName, string>> = Object.freeze({
  get_server: 'Read one server: connection status, OS, resources, Docker and proxy state.',
  list_servers: 'List the servers visible in this conversation.',
  get_service: 'Read one service: source, ports, healthcheck and cached runtime status.',
  list_services: 'List services, optionally of one project or environment.',
  get_deployment: 'Read one deployment: status, trigger, commit, timing and error code.',
  list_deployments: 'List the newest deployments of one service.',
  get_health: 'Read the health summary of one service: container state, restarts, healthcheck, last deployment and threshold flags.',
  get_metrics: 'Read CPU, memory and disk series of one server or service over a time range.',
  get_logs: 'Read recent log entries of one service (build, deploy, runtime, activity). search is a plain substring.',
  get_infrastructure_graph: 'Read the infrastructure graph (servers, projects, environments, services, domains and their relations).',
});

type Parsed<N extends AIToolName> = z.output<(typeof SCHEMAS)[N]>;

function issuesOf(error: z.ZodError): ToolArgIssue[] {
  return error.issues.slice(0, MAX_ISSUES).map((issue) => ({
    path: issue.path.map((part) => (typeof part === 'symbol' ? '' : String(part))).join('.'),
    code: issue.code,
  }));
}

function invalid(path: string, code: string): ToolArgsResult<never> {
  return { ok: false, issues: [{ path, code }] };
}

type Finish<N extends AIToolName> = (parsed: Parsed<N>, nowMs: number) => ToolArgsResult<ToolInputs[N]>;

function same<N extends AIToolName>(): Finish<N> {
  return (parsed) => ({ ok: true, input: parsed as unknown as ToolInputs[N] });
}

const FINISH: { readonly [N in AIToolName]: Finish<N> } = {
  get_server: same(),
  list_servers: () => ({ ok: true, input: {} }),
  get_service: same(),
  list_services: same(),
  get_deployment: same(),
  list_deployments: (parsed) => ({
    ok: true,
    input: { serviceId: parsed.serviceId, limit: parsed.limit ?? AI_TOOL_DEPLOYMENTS_DEFAULT },
  }),
  get_health: same(),
  get_metrics: (parsed) => ({
    ok: true,
    input: { ...parsed, points: parsed.points ?? AI_TOOL_METRIC_POINTS_DEFAULT },
  }),
  get_logs: (parsed, nowMs) => {
    const { serviceId, limit, ...query } = parsed;
    const filter = parseLogFilter(query, nowMs);
    if (!filter.ok) return invalid('filter', filter.code);
    return {
      ok: true,
      input: {
        serviceId,
        filter: filter.value,
        limit: limit ?? AI_TOOL_LOG_DEFAULT_LINES,
        maxBytes: AI_TOOL_LOG_MAX_BYTES,
      },
    };
  },
  get_infrastructure_graph: (parsed) => ({ ok: true, input: { ...parsed, maxNodes: AI_TOOL_GRAPH_MAX_NODES } }),
};

function projectTarget(scope: AuthorizationScope): ToolTarget | null {
  return scope.kind === 'project' ? { kind: 'Project', id: scope.projectId } : null;
}

const TARGET: { readonly [N in AIToolName]: (input: ToolInputs[N], scope: AuthorizationScope) => ToolTarget | null } = {
  get_server: (input) => ({ kind: 'Server', id: input.serverId }),
  list_servers: (_input, scope) => projectTarget(scope),
  get_service: (input) => ({ kind: 'Service', id: input.serviceId }),
  list_services: (input, scope) =>
    input.environmentId !== undefined
      ? { kind: 'Environment', id: input.environmentId }
      : input.projectId !== undefined
        ? { kind: 'Project', id: input.projectId }
        : projectTarget(scope),
  get_deployment: (input) => ({ kind: 'Deployment', id: input.deploymentId }),
  list_deployments: (input) => ({ kind: 'Service', id: input.serviceId }),
  get_health: (input) => ({ kind: 'Service', id: input.serviceId }),
  get_metrics: (input) => ({ kind: input.target === 'server' ? 'Server' : 'Service', id: input.id }),
  get_logs: (input) => ({ kind: 'Service', id: input.serviceId }),
  get_infrastructure_graph: (input, scope) =>
    input.environmentId !== undefined
      ? { kind: 'Environment', id: input.environmentId }
      : input.projectId !== undefined
        ? { kind: 'Project', id: input.projectId }
        : projectTarget(scope),
};

function defineTool<N extends AIToolName>(name: N): AITool<N> {
  const schema = SCHEMAS[name];
  const finish = FINISH[name] as Finish<N>;
  const target = TARGET[name] as (input: ToolInputs[N], scope: AuthorizationScope) => ToolTarget | null;
  return Object.freeze({
    name,
    kind: 'read',
    description: DESCRIPTIONS[name],
    inputSchema: Object.freeze(z.toJSONSchema(schema) as Record<string, unknown>),
    parse(raw: unknown, nowMs: number): ToolArgsResult<ToolInputs[N]> {
      // A tool with no arguments may be called with none at all.
      const result = schema.safeParse(raw ?? {});
      if (!result.success) return { ok: false, issues: issuesOf(result.error) };
      return finish(result.data as Parsed<N>, nowMs);
    },
    target,
  } satisfies AITool<N>);
}

type ToolSet = { readonly [N in AIToolName]: AITool<N> };

function buildTools(): ToolSet {
  const entries = AI_TOOL_NAMES.map((name) => [name, defineTool(name)] as const);
  return Object.freeze(Object.fromEntries(entries)) as unknown as ToolSet;
}

/** Every read-only tool, keyed by name. Frozen: nothing can be added at runtime. */
export const READ_ONLY_TOOLS: ToolSet = buildTools();
