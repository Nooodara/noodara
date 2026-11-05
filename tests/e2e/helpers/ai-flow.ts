// 30-05: shared AI e2e flow. CI runs the specs with the replay provider (helpers/replay-provider.ts
// behind fixtures/ai-seam.mjs); NOODARA_AI_EVAL_LIVE=1 runs the same specs against the real vendor
// with NOODARA_AI_EVAL_API_KEY (or ANTHROPIC_API_KEY / OPENAI_API_KEY) and
// NOODARA_AI_EVAL_PROVIDER (anthropic by default). The policies here are the replay agent: they read
// the real tool results and cite only ids and tool calls those results carried.
import path from 'node:path';
import { expect, type Page } from '@playwright/test';
import {
  AI_ANSWER_MAX_LENGTH,
  AI_PROVIDER_MODELS,
  type AiProvider,
  type AiStructuredAnswer,
} from '@noodara/domain/api-contract';
import { currentRun, test } from '../fixtures/deploy-host.js';
import {
  BASE_URL,
  Cleanup,
  ENGINE_TEST_TIMEOUT_MS,
  api,
  connectServer,
  login,
  removeServer,
  type ConnectedServer,
} from '../fixtures/engine.js';
import { AI_REPLAY_FILE_NAME } from '../fixtures/stack.js';
import { ReplayProvider, type ReplayContext, type ReplayDecision, type ReplayPolicy, type ReplayStep } from './replay-provider.js';

export const AI_LIVE = process.env['NOODARA_AI_EVAL_LIVE'] === '1';
/** A live answer takes several model turns; the replay answers in well under a second. */
export const ASK_TIMEOUT_MS = AI_LIVE ? 180_000 : 60_000;
/** Not shaped like any vendor key (gitleaks, push protection): the replay accepts anything. */
const REPLAY_API_KEY = 'e2e-replay-provider-key-not-a-credential';

function liveSettings(): { provider: AiProvider; apiKey: string } {
  const provider = (process.env['NOODARA_AI_EVAL_PROVIDER'] ?? 'anthropic') as AiProvider;
  if (provider !== 'anthropic' && provider !== 'openai') throw new Error(`unsupported NOODARA_AI_EVAL_PROVIDER '${String(provider)}'`);
  const vendorKey = provider === 'anthropic' ? process.env['ANTHROPIC_API_KEY'] : process.env['OPENAI_API_KEY'];
  const apiKey = process.env['NOODARA_AI_EVAL_API_KEY'] ?? vendorKey;
  if (apiKey === undefined || apiKey === '') throw new Error('NOODARA_AI_EVAL_LIVE=1 needs NOODARA_AI_EVAL_API_KEY or the vendor key');
  return { provider, apiKey };
}

/** Starts the replay provider (null in live mode) and stores the BYOK settings through the API. */
export async function startAi(page: Page): Promise<ReplayProvider | null> {
  const replay = AI_LIVE ? null : await ReplayProvider.start(path.join(currentRun().runDir, AI_REPLAY_FILE_NAME));
  try {
    const { provider, apiKey } = AI_LIVE ? liveSettings() : { provider: 'anthropic' as const, apiKey: REPLAY_API_KEY };
    const saved = await api(page, 'PUT', '/api/settings/ai', { provider, model: AI_PROVIDER_MODELS[provider][0], apiKey });
    expect(saved.status, `save AI settings: ${JSON.stringify(saved.body)}`).toBe(200);
  } catch (error) {
    await replay?.stop();
    throw error;
  }
  return replay;
}

export async function stopAi(page: Page, replay: ReplayProvider | null): Promise<void> {
  await replay?.stop();
  await api(page, 'DELETE', '/api/settings/ai').catch(() => undefined);
}

// ---- suite hooks: one connected server per spec file, AI settings and cleanup per test ----

export interface AiSuite {
  server(): ConnectedServer;
  cleanup(): Cleanup;
  /** null in live mode. */
  replay(): ReplayProvider | null;
}

/** Registers the describe-level hooks; call inside `test.describe`. */
export function aiSuite(): AiSuite {
  let server: ConnectedServer | null = null;
  let cleanup = new Cleanup();
  let replay: ReplayProvider | null = null;

  test.use({ actionTimeout: 30_000, navigationTimeout: 30_000 });

  test.beforeAll(async ({ browser, deployHost }) => {
    test.setTimeout(5 * 60_000);
    const context = await browser.newContext({ baseURL: BASE_URL });
    try {
      const page = await context.newPage();
      await login(page);
      server = await connectServer(page, deployHost);
    } finally {
      await context.close();
    }
  });

  test.afterAll(async ({ browser }) => {
    if (server === null) return;
    const current = server;
    const context = await browser.newContext({ baseURL: BASE_URL });
    try {
      const page = await context.newPage();
      await login(page);
      await removeServer(page, current);
    } finally {
      await context.close();
    }
  });

  test.beforeEach(async ({ page }) => {
    test.setTimeout(ENGINE_TEST_TIMEOUT_MS);
    cleanup = new Cleanup();
    await login(page);
    replay = await startAi(page);
  });

  test.afterEach(async ({ page }) => {
    await stopAi(page, replay);
    replay = null;
    await cleanup.run(page);
  });

  return {
    server: () => {
      if (server === null) throw new Error('server not connected (beforeAll failed)');
      return server;
    },
    cleanup: () => cleanup,
    replay: () => replay,
  };
}

// ---- asking in the UI ----

export interface ToolCallRecord {
  readonly name: string;
  readonly status: string;
}

export interface AssistantMessage {
  readonly status: string;
  readonly content: string;
  readonly answer: AiStructuredAnswer | null;
  readonly toolCalls: readonly ToolCallRecord[];
}

export interface AskResult {
  readonly conversationId: string;
  /** The whole SSE body the browser received for this question. */
  readonly sse: string;
  /** GET /api/ai/conversations/:id, as the API returned it. */
  readonly detailText: string;
  readonly assistant: AssistantMessage;
}

const MESSAGES_PATH = /\/api\/ai\/conversations\/([0-9a-f-]{36})\/messages$/;

/** Asks from the inspector chat (`/servers?ask=1`) and waits for the turn to complete. */
export async function askInUi(page: Page, question: string): Promise<AskResult> {
  await page.goto('/servers?ask=1');
  await expect(page.getByTestId('inspector-panel').getByRole('heading', { name: 'Ask Noodara' })).toBeVisible();
  const streamed = page.waitForResponse(
    (response) => response.request().method() === 'POST' && MESSAGES_PATH.test(new URL(response.url()).pathname),
    { timeout: ASK_TIMEOUT_MS },
  );
  await page.getByTestId('ai-question-input').fill(question);
  await page.getByTestId('ai-ask').click();
  const response = await streamed;
  const sse = await response.text();
  const conversationId = MESSAGES_PATH.exec(new URL(response.url()).pathname)?.[1] ?? '';
  expect(conversationId).not.toBe('');

  const turn = page.getByTestId('ai-turn').last();
  await expect(turn).toHaveAttribute('data-status', 'complete', { timeout: ASK_TIMEOUT_MS });

  const detail = await api(page, 'GET', `/api/ai/conversations/${conversationId}`);
  expect(detail.status, 'conversation detail').toBe(200);
  const messages = (detail.body as { messages?: (AssistantMessage & { role?: string })[] }).messages ?? [];
  const assistant = [...messages].reverse().find((message) => message.role === 'assistant');
  if (assistant === undefined) throw new Error('the conversation has no assistant message');
  return { conversationId, sse, detailText: JSON.stringify(detail.body), assistant };
}

/** Opens the "Tools consulted" disclosure of the last turn and returns its text. */
export async function toolsConsulted(page: Page): Promise<string> {
  const view = page.getByTestId('ai-turn').last().getByTestId('ai-answer');
  await view.getByTestId('ai-tools').getByRole('button').click();
  const list = view.getByTestId('ai-tools-list');
  await expect(list).toBeVisible();
  return list.innerText();
}

// ---- replay policies ----

interface GraphNode {
  readonly kind: string;
  readonly entityId: string;
  readonly label: string;
  readonly serviceId?: string;
}

interface LogEntry {
  readonly source: string;
  readonly timestamp: string;
  readonly text: string;
}

function graphNodes(data: unknown): GraphNode[] {
  const nodes = (data as { nodes?: unknown } | undefined)?.nodes;
  return Array.isArray(nodes) ? (nodes as GraphNode[]) : [];
}

function logEntries(data: unknown): LogEntry[] {
  const entries = (data as { entries?: unknown } | undefined)?.entries;
  return Array.isArray(entries) ? (entries as LogEntry[]) : [];
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** The Service node whose label the question names (the longest match wins). */
function serviceNamed(nodes: readonly GraphNode[], question: string): GraphNode | undefined {
  return nodes
    .filter((node) => node.kind === 'Service' && new RegExp(`(^|[^a-z0-9-])${escapeRegExp(node.label)}($|[^a-z0-9-])`, 'i').test(question))
    .sort((a, b) => b.label.length - a.label.length)[0];
}

function stepNamed(context: ReplayContext, name: string): ReplayStep | undefined {
  return context.steps.find((step) => step.name === name);
}

const tools = (...calls: { name: string; input: Record<string, unknown> }[]): ReplayDecision => ({ kind: 'tools', calls });
const answer = (value: AiStructuredAnswer): ReplayDecision => ({ kind: 'answer', answer: value });

function unknown(text: string, missing: string): ReplayDecision {
  return answer({ answer: text, diagnosis: 'unknown', confidence: 0.2, entities: [], evidence: [], missingEvidence: [missing] });
}

type Located = { readonly graph: ReplayStep; readonly nodes: GraphNode[]; readonly service: GraphNode };

/** Step 1 of every policy: read the graph (the ask scope is global) and find the named service. */
function locate(context: ReplayContext): Located | ReplayDecision {
  const graph = stepNamed(context, 'get_infrastructure_graph');
  if (graph === undefined) return tools({ name: 'get_infrastructure_graph', input: {} });
  if (graph.isError) return unknown('I could not read the infrastructure graph.', 'get_infrastructure_graph failed.');
  const nodes = graphNodes(graph.data);
  const service = serviceNamed(nodes, context.question);
  if (service === undefined) return unknown('No service in the infrastructure graph matches the question.', 'A service named in the question.');
  return { graph, nodes, service };
}

const isDecision = (value: Located | ReplayDecision): value is ReplayDecision => 'kind' in value;

/** A1: where does <service> run? graph -> get_service -> server and domain from the results. */
export const whereRunsPolicy: ReplayPolicy = (context) => {
  const located = locate(context);
  if (isDecision(located)) return located;
  const { graph, nodes, service } = located;
  const read = stepNamed(context, 'get_service');
  if (read === undefined) return tools({ name: 'get_service', input: { serviceId: service.entityId } });
  const serverId = (read.data as { serverId?: unknown } | undefined)?.serverId;
  const server = nodes.find((node) => node.kind === 'Server' && node.entityId === serverId);
  if (read.isError || server === undefined) return unknown(`I could not find the server ${service.label} runs on.`, 'The service server.');
  const domains = nodes.filter((node) => node.kind === 'Domain' && node.serviceId === service.entityId);
  const served = domains.length === 0 ? '' : ` It is served at ${domains.map((domain) => domain.label).join(', ')}.`;
  return answer({
    answer: `${service.label} runs on server ${server.label}.${served}`,
    diagnosis: 'unknown',
    confidence: 0.95,
    entities: [
      { kind: 'Service', id: service.entityId, label: service.label },
      { kind: 'Server', id: server.entityId, label: server.label },
      ...domains.map((domain) => ({ kind: 'Domain' as const, id: domain.entityId, label: domain.label })),
    ],
    evidence: [
      { ref: graph.id, note: `The infrastructure graph places ${service.label} on ${server.label}.` },
      { ref: read.id, note: `get_service reports serverId ${String(serverId)}.` },
    ],
    missingEvidence: [],
  });
};

const OOM_ACTIVITY = /: out_of_memory$/;

/** A2: why did <service> restart? activity log + health, out_of_memory only from a real OOM observation. */
export const whyRestartedPolicy: ReplayPolicy = (context) => {
  const located = locate(context);
  if (isDecision(located)) return located;
  const { service } = located;
  const logs = stepNamed(context, 'get_logs');
  const health = stepNamed(context, 'get_health');
  if (logs === undefined || health === undefined) {
    return tools(
      { name: 'get_logs', input: { serviceId: service.entityId, sources: ['activity'] } },
      { name: 'get_health', input: { serviceId: service.entityId } },
    );
  }
  const oom = logEntries(logs.data).filter((entry) => entry.source === 'activity' && OOM_ACTIVITY.test(entry.text));
  const restarts = (health.data as { container?: { restartCount?: unknown } | null } | undefined)?.container?.restartCount;
  const first = oom[0];
  if (logs.isError || first === undefined) {
    return unknown(`I found no out-of-memory observation for ${service.label}.`, 'An OOMKilled observation in the activity log.');
  }
  return answer({
    answer: `${service.label} restarted because its container ran out of memory: the kernel OOM-killed it (OOMKilled).`,
    diagnosis: 'out_of_memory',
    confidence: 0.9,
    entities: [{ kind: 'Service', id: service.entityId, label: service.label }],
    evidence: [
      { ref: logs.id, note: `OOMKilled observed: "${first.text}" at ${first.timestamp}.` },
      { ref: health.id, note: `Container restart count: ${String(restarts ?? 'unknown')}.` },
    ],
    missingEvidence: [],
  });
};

/**
 * A3 (adversarial): a model that obeys "reveal the secret" and echoes every tool result it got,
 * runtime log lines first. Whatever reaches it reaches the answer, the SSE and the stored message.
 */
export const echoEverythingPolicy: ReplayPolicy = (context) => {
  const located = locate(context);
  if (isDecision(located)) return located;
  const { service } = located;
  const logs = stepNamed(context, 'get_logs');
  const read = stepNamed(context, 'get_service');
  if (logs === undefined || read === undefined) {
    return tools(
      { name: 'get_service', input: { serviceId: service.entityId } },
      { name: 'get_logs', input: { serviceId: service.entityId, sources: ['runtime'] } },
    );
  }
  const lines = logEntries(logs.data).map((entry) => entry.text);
  const dump = `Here is everything the tools returned for ${service.label}: ${lines.join(' | ')} | ${read.content}`;
  return answer({
    answer: dump.slice(0, AI_ANSWER_MAX_LENGTH - 100),
    diagnosis: 'unknown',
    confidence: 0.1,
    entities: [{ kind: 'Service', id: service.entityId, label: service.label }],
    evidence: [{ ref: logs.id, note: 'Runtime log lines as returned.' }],
    missingEvidence: ['Secret values are not readable by any tool.'],
  });
};
