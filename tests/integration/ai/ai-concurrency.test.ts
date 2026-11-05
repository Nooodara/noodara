// 31-02 (A2, H1): concurrent AI conversations over real HTTP, a migrated Postgres and a real Redis.
// The provider is the real Anthropic client against a stubbed global fetch whose behaviour is picked
// per question by a `[mode=<mode>#<key>]` marker (the last one in the request body: history repeats
// older markers). Checked:
// - Wave 1: a burst past the per-user question limit gets exactly `max` answers, the rest 429.
// - Wave 2: a storm of mixed asks (answers, tool turns, budget loops, hangs, mid-stream client
//   disconnects, timeouts, duplicate asks) plus three log follows destroyed mid-stream, while
//   /health and the conversation list keep answering fast.
// - H1: afterwards open SSE connections, in-flight provider requests and follow slots are all back
//   to zero, no message is left pending and every conversation takes a fresh question.
import { randomBytes, randomUUID } from 'node:crypto';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { performance } from 'node:perf_hooks';
import { inArray } from 'drizzle-orm';
import parseSetCookie from 'set-cookie-parser';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { AiConversationViewSchema } from '@noodara/domain/api-contract';
import { revealSecret } from '@noodara/domain/security';
import type { ReadToolBackend } from '../../../packages/ai/src/index.js';
import type { buildApp as BuildApp } from '../../../apps/control-plane/src/app.js';
import type { AiAskRuntime } from '../../../apps/control-plane/src/ai/conversations/ask-runtime.js';
import { users } from '../../../apps/control-plane/src/db/schema/auth.js';
import { credentials, environments, projects, servers, services } from '../../../apps/control-plane/src/db/schema/index.js';
import { aiMessages, aiToolCalls } from '../../../apps/control-plane/src/db/schema/v05-ai.js';
import type { ServerEventPublisher } from '../../../apps/control-plane/src/events/server-event-publisher.js';
import { issueToken } from '../../../apps/control-plane/src/services/setup-token-repository.js';
import { startPostgres, type PostgresFixture } from '../helpers/postgres.js';
import { startRedis, type RedisFixture } from '../helpers/redis.js';

const STRESS_ENABLED = process.env['NOODARA_STRESS'] === '1' || process.env['NOODARA_STRESS'] === 'true';

const ADMIN_EMAIL = 'admin@noodara.dev';
const ADMIN_PASSWORD = 'correct horse battery staple';
const ORIGIN = 'https://panel.noodara.dev';
const ANTHROPIC_URL = 'https://api.anthropic.com/v1/messages';
const ANTHROPIC_MODEL = 'claude-opus-5-5';
const API_KEY = `CANARYAI${randomBytes(18).toString('hex')}`;
const MAX_STREAM_MS = 4_000;
const HEARTBEAT_MS = 100;
const MAX_ITERATIONS = 3;
const MAX_TOOL_CALLS = 2;
const BURST_LIMIT = 6;
const BURST_SIZE = 14;
/** A fast route answered later than this while the storm runs counts as starved. */
const MAX_FAST_ROUTE_MS = 1_500;
const FOLLOWS_PER_USER = 3;
/** Last stub safety net: a hang whose signal never fires still settles. */
const STUB_HANG_CAP_MS = 30_000;

type Json = Record<string, unknown>;
type Mode = 'answer' | 'tool' | 'loop' | 'hang' | 'slowtool';
interface SseEvent {
  readonly event: string;
  readonly data: Json;
}
interface Reply {
  readonly status: number;
  readonly headers: http.IncomingHttpHeaders;
  readonly raw: string;
  readonly events: SseEvent[];
  readonly ms: number;
}
interface OpenRequest {
  readonly done: Promise<Reply>;
  readonly raw: () => string;
  readonly status: () => number;
  destroy(): void;
}

let postgres: PostgresFixture;
let redis: RedisFixture;
let app: ReturnType<typeof BuildApp>;
let baseUrl: URL;
let cookie: string;
let runtime: AiAskRuntime;
let serviceIds: { projectId: string; serviceId: string };
const limiter: { current: AiAskRuntime } = { current: undefined as unknown as AiAskRuntime };
const events: ServerEventPublisher = { publish: () => Promise.resolve() };

// ---- provider stub -------------------------------------------------------------------------------

const stub = {
  inFlight: 0,
  maxInFlight: 0,
  aborted: 0,
  calls: new Map<string, number>(),
  inFlightByKey: new Map<string, number>(),
};

function bump(map: Map<string, number>, key: string, by: number): void {
  map.set(key, (map.get(key) ?? 0) + by);
}

const MARKER = /\[mode=(answer|tool|loop|hang|slowtool)#([A-Za-z0-9-]+)\]/g;

function markerOf(body: string): { mode: Mode; key: string } {
  const matches = [...body.matchAll(MARKER)];
  const last = matches.at(-1);
  if (last?.[1] === undefined || last[2] === undefined) return { mode: 'answer', key: 'unmarked' };
  return { mode: last[1] as Mode, key: last[2] };
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

function anthropicMessage(content: unknown[], stopReason: string): Response {
  return jsonResponse(200, {
    id: `msg_${randomUUID()}`,
    type: 'message',
    role: 'assistant',
    model: ANTHROPIC_MODEL,
    content,
    stop_reason: stopReason,
    stop_sequence: null,
    usage: { input_tokens: 5, output_tokens: 5 },
  });
}

const ANSWER = {
  answer: 'No servers report a problem right now.',
  diagnosis: 'unknown',
  confidence: 0,
  entities: [],
  evidence: [],
  missingEvidence: ['No deployment history was available.'],
};

const answerReply = (): Response => anthropicMessage([{ type: 'text', text: JSON.stringify(ANSWER) }], 'end_turn');
const toolReply = (): Response =>
  anthropicMessage(
    [
      { type: 'text', text: 'Checking the servers.' },
      { type: 'tool_use', id: `toolu_${randomBytes(6).toString('hex')}`, name: 'list_servers', input: {} },
    ],
    'tool_use',
  );

function hang(signal: AbortSignal | null): Promise<Response> {
  return new Promise((_resolve, reject) => {
    const cap = setTimeout(() => {
      reject(new Error('stub hang cap reached'));
    }, STUB_HANG_CAP_MS);
    const onAbort = (): void => {
      clearTimeout(cap);
      stub.aborted += 1;
      reject(new DOMException('The operation was aborted.', 'AbortError'));
    };
    if (signal === null) return;
    if (signal.aborted) onAbort();
    else signal.addEventListener('abort', onAbort, { once: true });
  });
}

function stubReply(mode: Mode, call: number, signal: AbortSignal | null): Promise<Response> {
  switch (mode) {
    case 'answer':
      return Promise.resolve(answerReply());
    case 'tool':
      return Promise.resolve(call === 1 ? toolReply() : answerReply());
    case 'loop':
      return Promise.resolve(toolReply());
    case 'hang':
      return hang(signal);
    case 'slowtool':
      return call === 1 ? Promise.resolve(toolReply()) : hang(signal);
  }
}

function installProviderStub(): void {
  const original = globalThis.fetch;
  vi.stubGlobal('fetch', async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const request = new Request(input, init);
    if (request.url !== ANTHROPIC_URL) return original(input, init);
    const { mode, key } = markerOf(await request.clone().text());
    bump(stub.calls, key, 1);
    bump(stub.inFlightByKey, key, 1);
    stub.inFlight += 1;
    stub.maxInFlight = Math.max(stub.maxInFlight, stub.inFlight);
    try {
      return await stubReply(mode, stub.calls.get(key) ?? 1, init?.signal ?? request.signal);
    } finally {
      stub.inFlight -= 1;
      bump(stub.inFlightByKey, key, -1);
    }
  });
}

const fakeBackend = Object.fromEntries(
  [
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
  ].map((name) => [
    name,
    () => Promise.resolve(name === 'list_servers' ? { ok: true, data: { items: [{ name: 'web-1' }] } } : { ok: false, code: 'NOT_FOUND' }),
  ]),
) as unknown as ReadToolBackend;

// ---- HTTP helpers --------------------------------------------------------------------------------

function cookieHeaderFrom(response: { headers: Record<string, unknown> }): string {
  const raw = response.headers['set-cookie'];
  const rawCookies = Array.isArray(raw) ? raw : raw !== undefined ? [String(raw)] : [];
  return parseSetCookie
    .parse(rawCookies, { map: false })
    .map((entry) => `${entry.name}=${entry.value}`)
    .join('; ');
}

async function signIn(): Promise<string> {
  const issued = await issueToken(postgres.db, 'setup', new Date());
  const setup = await app.inject({
    method: 'POST',
    url: '/api/setup',
    payload: { token: revealSecret(issued.token), email: ADMIN_EMAIL, password: ADMIN_PASSWORD, name: 'Admin' },
  });
  if (setup.statusCode !== 200) throw new Error(`setup failed: ${setup.statusCode.toString()}`);
  const response = await app.inject({
    method: 'POST',
    url: '/api/auth/sign-in/email',
    payload: { email: ADMIN_EMAIL, password: ADMIN_PASSWORD },
  });
  if (response.statusCode !== 200) throw new Error(`sign-in failed: ${response.statusCode.toString()}`);
  return cookieHeaderFrom(response);
}

function parseSse(raw: string): SseEvent[] {
  const out: SseEvent[] = [];
  for (const frame of raw.split('\n\n')) {
    const event = /^event: (.+)$/m.exec(frame)?.[1];
    const data = /^data: (.+)$/m.exec(frame)?.[1];
    if (event !== undefined && data !== undefined) out.push({ event, data: JSON.parse(data) as Json });
  }
  return out;
}

/** One real HTTP request on its own socket (no agent, `connection: close`), so sockets are countable. */
function open(method: 'GET' | 'POST', path: string, body?: unknown): OpenRequest {
  let raw = '';
  let status = 0;
  let request: http.ClientRequest | undefined;
  const started = performance.now();
  const done = new Promise<Reply>((resolve) => {
    let headers: http.IncomingHttpHeaders = {};
    let settled = false;
    const finish = (): void => {
      if (settled) return;
      settled = true;
      resolve({ status, headers, raw, events: parseSse(raw), ms: performance.now() - started });
    };
    request = http.request(
      new URL(path, baseUrl),
      {
        method,
        agent: false,
        headers: { cookie, origin: ORIGIN, connection: 'close', ...(body !== undefined ? { 'content-type': 'application/json' } : {}) },
      },
      (response) => {
        status = response.statusCode ?? 0;
        headers = response.headers;
        response.setEncoding('utf8');
        response.on('data', (chunk: string) => {
          raw += chunk;
        });
        response.on('end', finish);
        response.on('close', finish);
        response.on('error', finish);
      },
    );
    request.on('error', finish);
    request.end(body === undefined ? undefined : JSON.stringify(body));
  });
  return { done, raw: () => raw, status: () => status, destroy: () => request?.destroy() };
}

function openAsk(conversationId: string, mode: Mode, key: string): OpenRequest {
  return open('POST', `/api/ai/conversations/${conversationId}/messages`, { question: `What is wrong? [mode=${mode}#${key}]` });
}

function openFollow(): OpenRequest {
  return open('GET', `/api/projects/${serviceIds.projectId}/services/${serviceIds.serviceId}/logs/entries/follow?sources=activity,build`);
}

async function waitUntil(condition: () => boolean | Promise<boolean>, timeoutMs = 10_000, label = 'condition'): Promise<void> {
  const deadline = performance.now() + timeoutMs;
  while (!(await condition())) {
    if (performance.now() > deadline) throw new Error(`${label} not met in time`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

function openConnections(): Promise<number> {
  return new Promise((resolve, reject) => {
    app.server.getConnections((error, count) => {
      if (error) reject(error);
      else resolve(count);
    });
  });
}

async function createConversations(count: number): Promise<string[]> {
  const ids: string[] = [];
  for (let index = 0; index < count; index += 1) {
    const response = await app.inject({ method: 'POST', url: '/api/ai/conversations', headers: { cookie, origin: ORIGIN }, payload: {} });
    expect(response.statusCode, response.body).toBe(201);
    ids.push(AiConversationViewSchema.parse(response.json()).id);
  }
  return ids;
}

const lastStatus = (reply: Reply): unknown => reply.events.at(-1)?.data.status;
const errorCode = (reply: Reply): unknown => reply.events.find((event) => event.event === 'error')?.data.error;

/** Polls the fast routes every 100 ms over real HTTP until stopped; returns every latency and status. */
function startPoller(): { stop: () => Promise<{ path: string; status: number; ms: number }[]> } {
  const samples: { path: string; status: number; ms: number }[] = [];
  let running = true;
  const loop = (async () => {
    while (running) {
      const replies = await Promise.all(
        ['/health', '/api/ai/conversations'].map(async (path) => {
          const reply = await open('GET', path).done;
          return { path, status: reply.status, ms: reply.ms };
        }),
      );
      samples.push(...replies);
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  })();
  return {
    stop: async () => {
      running = false;
      await loop;
      return samples;
    },
  };
}

async function seedLogService(): Promise<{ projectId: string; serviceId: string }> {
  const db = postgres.db;
  const [credential] = await db
    .insert(credentials)
    .values({ type: 'ssh_password', encryptedValue: 'unused-by-this-test', keyVersion: 1 })
    .returning({ id: credentials.id });
  if (!credential) throw new Error('credential insert returned no row');
  const [server] = await db
    .insert(servers)
    .values({ name: 'ai-soak', host: '198.51.100.20', sshPort: 22, sshUser: 'deployer', credentialId: credential.id, status: 'CONNECTED', dockerInstalled: true })
    .returning({ id: servers.id });
  if (!server) throw new Error('server insert returned no row');
  const [project] = await db
    .insert(projects)
    .values({ name: 'ai-soak', slug: `ai-soak-${randomUUID().slice(0, 8)}` })
    .returning({ id: projects.id });
  if (!project) throw new Error('project insert returned no row');
  const [environment] = await db
    .insert(environments)
    .values({ projectId: project.id, name: 'production' })
    .returning({ id: environments.id });
  if (!environment) throw new Error('environment insert returned no row');
  const [service] = await db
    .insert(services)
    .values({
      projectId: project.id,
      environmentId: environment.id,
      serverId: server.id,
      name: `svc-${randomUUID().slice(0, 8)}`,
      sourceType: 'git',
      repositoryUrl: 'https://example.invalid/ai-soak.git',
      branch: 'main',
      buildContext: '.',
      dockerfilePath: 'Dockerfile',
      internalPort: 3000,
      publishedPort: null,
      status: 'RUNNING',
    })
    .returning({ id: services.id });
  if (!service) throw new Error('service insert returned no row');
  return { projectId: project.id, serviceId: service.id };
}

// ---- suite ---------------------------------------------------------------------------------------

describe.skipIf(!STRESS_ENABLED)('AI concurrency soak (31-02)', () => {
  const conversations: string[] = [];

  beforeAll(async () => {
    [postgres, redis] = await Promise.all([startPostgres(), startRedis()]);
    process.env.NOODARA_MASTER_KEY = randomBytes(32).toString('base64');
    process.env.BETTER_AUTH_SECRET = `test-fixture-${randomUUID()}-${randomUUID()}`;
    process.env.DATABASE_URL = postgres.connectionString;
    process.env.REDIS_URL = redis.connectionUrl;
    process.env.NOODARA_PUBLIC_URL = ORIGIN;
    const { buildApp } = await import('../../../apps/control-plane/src/app.js');
    const { createLogger, writableForTests } = await import('../../../apps/control-plane/src/logger.js');
    const { appRedactor } = await import('../../../apps/control-plane/src/activity/redaction.js');
    const { createAiAskRuntime } = await import('../../../apps/control-plane/src/ai/conversations/ask-runtime.js');
    limiter.current = createAiAskRuntime({ rateLimit: { max: BURST_LIMIT, windowMs: 60_000 } });
    runtime = { ...createAiAskRuntime(), takeQuestion: (user, nowMs) => limiter.current.takeQuestion(user, nowMs) };
    app = buildApp({
      eventPublisher: events,
      logger: createLogger({ level: 'warn', destination: writableForTests().stream }),
      ai: {
        runtime,
        backend: fakeBackend,
        limits: { maxStreamMs: MAX_STREAM_MS, budget: { maxIterations: MAX_ITERATIONS, maxToolCalls: MAX_TOOL_CALLS } },
        heartbeatMs: HEARTBEAT_MS,
      },
    });
    await app.listen({ host: '127.0.0.1', port: 0 });
    baseUrl = new URL(`http://127.0.0.1:${(app.server.address() as AddressInfo).port.toString()}`);
    cookie = await signIn();
    const [admin] = await postgres.db.select({ id: users.id }).from(users).where(inArray(users.email, [ADMIN_EMAIL]));
    if (admin === undefined) throw new Error('admin user missing');

    const settingsService = await import('../../../apps/control-plane/src/ai/settings/ai-settings-service.js');
    const { masterKeysFromEnvironment } = await import('../../../apps/control-plane/src/services/service-credentials.js');
    const stored = await settingsService.putAiProviderSettings(
      { db: postgres.db, now: () => new Date(), masterKeys: await masterKeysFromEnvironment()(), redactor: appRedactor, validateKey: () => Promise.resolve({ ok: true }) },
      { actor: { type: 'user', id: admin.id }, provider: 'anthropic', model: ANTHROPIC_MODEL, apiKey: API_KEY },
    );
    if (!stored.ok) throw new Error('provider settings were not stored');
    serviceIds = await seedLogService();
    installProviderStub();
  }, 180_000);

  afterAll(async () => {
    vi.unstubAllGlobals();
    await app?.close();
    await Promise.all([postgres?.stop(), redis?.stop()]);
  }, 60_000);

  it('A2: a burst past the per-user question limit gets exactly the limit in answers and named 429s for the rest', async () => {
    const ids = await createConversations(BURST_SIZE);
    conversations.push(...ids);
    const replies = await Promise.all(ids.map((id, index) => openAsk(id, 'answer', `burst-${index.toString()}`).done));

    const answered = replies.filter((reply) => reply.status === 200);
    const limited = replies.filter((reply) => reply.status === 429);
    expect(answered).toHaveLength(BURST_LIMIT);
    expect(limited).toHaveLength(BURST_SIZE - BURST_LIMIT);
    for (const reply of answered) expect(lastStatus(reply)).toBe('complete');
    for (const reply of limited) {
      expect(JSON.parse(reply.raw)).toMatchObject({ error: 'RATE_LIMITED' });
      expect(Number(reply.headers['retry-after'])).toBeGreaterThan(0);
    }
    const burstCalls = [...stub.calls].filter(([key]) => key.startsWith('burst-')).reduce((sum, [, calls]) => sum + calls, 0);
    expect(burstCalls).toBe(BURST_LIMIT);
    const stored = await postgres.db.select().from(aiMessages).where(inArray(aiMessages.conversationId, ids));
    expect(stored.filter((message) => message.role === 'user')).toHaveLength(BURST_LIMIT);
  }, 60_000);

  it('A2/H1: a storm of mixed asks with disconnects, timeouts and follows stays bounded and does not starve the API', async () => {
    const { createAiAskRuntime } = await import('../../../apps/control-plane/src/ai/conversations/ask-runtime.js');
    limiter.current = createAiAskRuntime({ rateLimit: { max: 1_000, windowMs: 60_000 } });
    const plan: { mode: Mode; fate: 'finish' | 'destroy' | 'timeout' }[] = [
      ...Array.from({ length: 6 }, () => ({ mode: 'answer' as const, fate: 'finish' as const })),
      ...Array.from({ length: 4 }, () => ({ mode: 'tool' as const, fate: 'finish' as const })),
      ...Array.from({ length: 3 }, () => ({ mode: 'loop' as const, fate: 'finish' as const })),
      ...Array.from({ length: 4 }, () => ({ mode: 'hang' as const, fate: 'destroy' as const })),
      ...Array.from({ length: 3 }, () => ({ mode: 'slowtool' as const, fate: 'destroy' as const })),
      ...Array.from({ length: 2 }, () => ({ mode: 'hang' as const, fate: 'timeout' as const })),
    ];
    const ids = await createConversations(plan.length);
    conversations.push(...ids);
    const poller = startPoller();

    // Three follows (the per-user cap) stay open through the storm; a fourth is refused.
    const follows = Array.from({ length: FOLLOWS_PER_USER }, () => openFollow());
    await waitUntil(() => follows.every((follow) => follow.status() === 200), 10_000, 'follows open');
    const fourth = await openFollow().done;
    expect(fourth.status).toBe(429);
    expect(JSON.parse(fourth.raw)).toMatchObject({ error: 'RUNTIME_LOG_FOLLOW_LIMIT_REACHED' });

    const started = performance.now();
    const asks = plan.map((entry, index) => {
      const key = `storm-${index.toString()}`;
      const id = ids[index] ?? '';
      return { ...entry, key, id, request: openAsk(id, entry.mode, key) };
    });
    const inFlight = (key: string): boolean => (stub.inFlightByKey.get(key) ?? 0) > 0;

    // Duplicate asks on the conversations that will time out: refused while the first one runs.
    const timeouts = asks.filter((ask) => ask.fate === 'timeout');
    await waitUntil(() => timeouts.every((ask) => inFlight(ask.key)), 10_000, 'timeout asks in flight');
    const duplicates = await Promise.all(timeouts.map((ask) => openAsk(ask.id, 'answer', `${ask.key}-dup`).done));
    for (const duplicate of duplicates) {
      expect(duplicate.status).toBe(409);
      expect(JSON.parse(duplicate.raw)).toMatchObject({ error: 'AI_CONVERSATION_BUSY' });
    }

    // Mid-stream disconnects: a hang once its stream started, a slow tool once its tool call streamed.
    await Promise.all(
      asks
        .filter((ask) => ask.fate === 'destroy')
        .map(async (ask) => {
          const marker = ask.mode === 'hang' ? 'event: start' : 'event: tool_call';
          await waitUntil(() => ask.request.raw().includes(marker) && inFlight(ask.key), 10_000, `${ask.key} mid-stream`);
          ask.request.destroy();
        }),
    );
    for (const follow of follows) follow.destroy();

    const replies = await Promise.all(asks.map(async (ask) => ({ ask, reply: await ask.request.done })));
    const elapsed = performance.now() - started;
    const samples = await poller.stop();

    for (const { ask, reply } of replies) {
      if (ask.fate === 'destroy') continue;
      expect(reply.status, ask.key).toBe(200);
      if (ask.mode === 'answer' || ask.mode === 'tool') {
        expect(lastStatus(reply), ask.key).toBe('complete');
        // Not starved: the quick asks finish while hangs hold their slots.
        expect(reply.ms, ask.key).toBeLessThan(MAX_FAST_ROUTE_MS);
      } else {
        expect(errorCode(reply), ask.key).toBe('AI_BUDGET_EXCEEDED');
        expect(lastStatus(reply), ask.key).toBe('failed');
      }
      if (ask.fate === 'timeout') {
        expect(reply.ms, ask.key).toBeGreaterThanOrEqual(MAX_STREAM_MS - 250);
        expect(reply.ms, ask.key).toBeLessThan(MAX_STREAM_MS + 2_000);
        expect(reply.raw, ask.key).toContain(': ping\n\n');
      }
    }
    expect(elapsed).toBeLessThan(MAX_STREAM_MS + 5_000);

    // Budget: a looping model stops at the iteration cap; executed tool calls never pass their cap.
    for (const ask of asks.filter((entry) => entry.mode === 'loop')) {
      expect(stub.calls.get(ask.key) ?? 0, ask.key).toBeLessThanOrEqual(MAX_ITERATIONS);
    }
    const stormMessages = await postgres.db.select().from(aiMessages).where(inArray(aiMessages.conversationId, ids));
    const toolCalls = await postgres.db
      .select()
      .from(aiToolCalls)
      .where(inArray(aiToolCalls.messageId, stormMessages.map((message) => message.id)));
    const callsPerMessage = new Map<string, number>();
    for (const call of toolCalls) bump(callsPerMessage, call.messageId, 1);
    for (const callCount of callsPerMessage.values()) expect(callCount).toBeLessThanOrEqual(MAX_TOOL_CALLS);

    // Destroyed asks are stored aborted; timeouts failed.
    const assistantOf = (id: string): string[] =>
      stormMessages.filter((message) => message.conversationId === id && message.role === 'assistant').map((message) => message.status);
    for (const ask of asks) {
      const expected = ask.fate === 'destroy' ? 'aborted' : ask.mode === 'answer' || ask.mode === 'tool' ? 'complete' : 'failed';
      expect(assistantOf(ask.id), ask.key).toEqual([expected]);
    }

    // Not starved: /health and the conversation list kept answering fast all through.
    expect(samples.length).toBeGreaterThan(10);
    for (const sample of samples) {
      expect(sample.status, sample.path).toBe(200);
      expect(sample.ms, sample.path).toBeLessThan(MAX_FAST_ROUTE_MS);
    }
  }, 120_000);

  it('H1: after the storm every connection, provider request and follow slot is released and no conversation is locked', async () => {
    await waitUntil(() => runtime.activeAsks() === 0, 10_000, 'active asks drained');
    expect(runtime.inFlightProviderRequests()).toBe(0);
    expect(stub.inFlight).toBe(0);
    expect(stub.aborted).toBeGreaterThanOrEqual(4 + 3 + 2);
    await waitUntil(async () => (await openConnections()) === 0, 10_000, 'connections closed');

    // Follow slots are back: the full per-user cap opens again, one past it is refused.
    const follows = Array.from({ length: FOLLOWS_PER_USER }, () => openFollow());
    await waitUntil(() => follows.every((follow) => follow.status() === 200), 10_000, 'follows reopen');
    expect((await openFollow().done).status).toBe(429);
    for (const follow of follows) follow.destroy();
    await Promise.all(follows.map((follow) => follow.done));

    const all = await postgres.db.select().from(aiMessages).where(inArray(aiMessages.conversationId, conversations));
    expect(all.filter((message) => message.status === 'pending')).toEqual([]);
    for (const id of conversations) expect(runtime.isBusy(id), id).toBe(false);

    const fresh = await Promise.all(conversations.map((id, index) => openAsk(id, 'answer', `fresh-${index.toString()}`).done));
    for (const reply of fresh) {
      expect(reply.status).toBe(200);
      expect(lastStatus(reply)).toBe('complete');
    }
    expect(runtime.activeAsks()).toBe(0);
    expect(runtime.inFlightProviderRequests()).toBe(0);
    expect(stub.inFlight).toBe(0);
    await waitUntil(async () => (await openConnections()) === 0, 10_000, 'connections closed after fresh asks');
  }, 60_000);
});
