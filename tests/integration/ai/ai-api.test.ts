import { randomBytes, randomUUID } from 'node:crypto';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { eq, inArray } from 'drizzle-orm';
import parseSetCookie from 'set-cookie-parser';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  AiConversationDetailSchema,
  AiConversationViewSchema,
  ListAiConversationsResponseSchema,
} from '@noodara/domain/api-contract';
import { revealSecret, type Redactor } from '@noodara/domain/security';
import type { ReadToolBackend } from '../../../packages/ai/src/index.js';
import type { buildApp as BuildApp } from '../../../apps/control-plane/src/app.js';
import type { AiAskRuntime } from '../../../apps/control-plane/src/ai/conversations/ask-runtime.js';
import { activityEvents } from '../../../apps/control-plane/src/db/schema/activity-events.js';
import { users } from '../../../apps/control-plane/src/db/schema/auth.js';
import { aiConversations, aiMessages, aiToolCalls } from '../../../apps/control-plane/src/db/schema/v05-ai.js';
import type { ServerEventPublisher } from '../../../apps/control-plane/src/events/server-event-publisher.js';
import { issueToken } from '../../../apps/control-plane/src/services/setup-token-repository.js';
import { startPostgres, type PostgresFixture } from '../helpers/postgres.js';

// 28-05 (A1-A4, H1, H2): the AI conversation API over real HTTP and a migrated Postgres. The
// provider is the real Anthropic client against a stubbed global fetch, so error mapping and abort
// propagation run through the production path; the read-tool backend is a fake whose output
// carries a canary that must never reach the stream, the activity log or a stored row.

const ADMIN_EMAIL = 'admin@noodara.dev';
const ADMIN_PASSWORD = 'correct horse battery staple';
const PUBLIC_HOST = 'panel.noodara.dev';
const ORIGIN = `https://${PUBLIC_HOST}`;
const ANTHROPIC_URL = 'https://api.anthropic.com/v1/messages';
const ANTHROPIC_MODEL = 'claude-opus-5-5';
const MAX_STREAM_MS = 2_000;
const HEARTBEAT_MS = 100;
const UUID_V7 = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const TOOL_CANARY = `TOOLOUT${randomBytes(12).toString('hex')}`;
const API_KEY = `CANARYAI${randomBytes(18).toString('hex')}`;

type Json = Record<string, unknown>;
type ProviderStep = 'tool' | 'answer' | 'hang' | 'unauthorized' | 'garbage';
interface SseEvent {
  readonly event: string;
  readonly data: Json;
}

let postgres: PostgresFixture;
let app: ReturnType<typeof BuildApp>;
let baseUrl: URL;
let cookie: string;
let userId: string;
let logs: () => unknown[];
let redactor: Redactor;
let runtime: AiAskRuntime;

const events: ServerEventPublisher = { publish: () => Promise.resolve() };
let script: ProviderStep[] = [];
const providerBodies: string[] = [];
let hanging = 0;
let abortedCalls = 0;
let rateLimitOn = false;

function setTestEnv(connectionString: string): void {
  process.env.NOODARA_MASTER_KEY = randomBytes(32).toString('base64');
  process.env.BETTER_AUTH_SECRET = `test-fixture-${randomUUID()}-${randomUUID()}`;
  process.env.DATABASE_URL = connectionString;
  process.env.REDIS_URL = 'redis://localhost:6379';
  process.env.NOODARA_PUBLIC_URL = ORIGIN;
}

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

async function call(
  method: 'GET' | 'POST' | 'DELETE',
  url: string,
  payload?: unknown,
  auth = true,
): Promise<{ statusCode: number; body: Json; raw: string; headers: Record<string, unknown> }> {
  const response = await app.inject({
    method,
    url,
    headers: { ...(auth ? { cookie } : {}), origin: ORIGIN },
    ...(payload !== undefined ? { payload: payload as Json } : {}),
  });
  const body = response.body === '' ? {} : (response.json() as Json);
  return { statusCode: response.statusCode, body, raw: response.body, headers: response.headers };
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

function providerReply(step: ProviderStep, signal: AbortSignal | null): Promise<Response> {
  switch (step) {
    case 'tool':
      return Promise.resolve(
        anthropicMessage(
          [
            { type: 'text', text: 'Checking the servers.' },
            { type: 'tool_use', id: `toolu_${randomBytes(6).toString('hex')}`, name: 'list_servers', input: {} },
          ],
          'tool_use',
        ),
      );
    case 'answer':
      return Promise.resolve(anthropicMessage([{ type: 'text', text: JSON.stringify(ANSWER) }], 'end_turn'));
    case 'unauthorized':
      return Promise.resolve(jsonResponse(401, { type: 'error', error: { type: 'authentication_error', message: 'bad key' } }));
    case 'garbage':
      return Promise.resolve(jsonResponse(200, { unexpected: true }));
    case 'hang':
      hanging += 1;
      return new Promise((_resolve, reject) => {
        const onAbort = (): void => {
          hanging -= 1;
          abortedCalls += 1;
          reject(new DOMException('The operation was aborted.', 'AbortError'));
        };
        if (signal === null) return;
        if (signal.aborted) onAbort();
        else signal.addEventListener('abort', onAbort, { once: true });
      });
  }
}

function installProviderStub(): void {
  const original = globalThis.fetch;
  vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const request = new Request(input, init);
    if (request.url !== ANTHROPIC_URL) return original(input, init);
    providerBodies.push(await request.clone().text());
    const step = script.shift() ?? 'garbage';
    return providerReply(step, init?.signal ?? request.signal);
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
    () =>
      Promise.resolve(
        name === 'list_servers'
          ? { ok: true, data: { items: [{ name: 'web-1', note: TOOL_CANARY }] } }
          : { ok: false, code: 'NOT_FOUND' },
      ),
  ]),
) as unknown as ReadToolBackend;

function parseSse(raw: string): SseEvent[] {
  const out: SseEvent[] = [];
  for (const frame of raw.split('\n\n')) {
    const event = /^event: (.+)$/m.exec(frame)?.[1];
    const data = /^data: (.+)$/m.exec(frame)?.[1];
    if (event !== undefined && data !== undefined) out.push({ event, data: JSON.parse(data) as Json });
  }
  return out;
}

interface AskReply {
  readonly status: number;
  readonly headers: http.IncomingHttpHeaders;
  readonly raw: string;
  readonly events: SseEvent[];
}

function openAsk(conversationId: string, body: unknown): { done: Promise<AskReply>; destroy: () => void; raw: () => string } {
  let raw = '';
  let request: http.ClientRequest | undefined;
  const done = new Promise<AskReply>((resolve) => {
    let status = 0;
    let headers: http.IncomingHttpHeaders = {};
    const finish = (): void => {
      resolve({ status, headers, raw, events: parseSse(raw) });
    };
    request = http.request(
      new URL(`/api/ai/conversations/${conversationId}/messages`, baseUrl),
      { method: 'POST', headers: { cookie, origin: ORIGIN, 'content-type': 'application/json' } },
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
    request.end(JSON.stringify(body));
  });
  return { done, destroy: () => request?.destroy(), raw: () => raw };
}

async function ask(conversationId: string, question: string): Promise<AskReply> {
  return openAsk(conversationId, { question }).done;
}

async function waitUntil(condition: () => boolean | Promise<boolean>, timeoutMs = 5_000): Promise<void> {
  const deadline = performance.now() + timeoutMs;
  while (!(await condition())) {
    if (performance.now() > deadline) throw new Error('condition not met in time');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

async function createConversation(title?: string): Promise<string> {
  const response = await call('POST', '/api/ai/conversations', title === undefined ? {} : { title });
  expect(response.statusCode, response.raw).toBe(201);
  return AiConversationViewSchema.parse(response.body).id;
}

async function messagesOf(conversationId: string): Promise<(typeof aiMessages.$inferSelect)[]> {
  return postgres.db.select().from(aiMessages).where(eq(aiMessages.conversationId, conversationId));
}

async function aiActivity(conversationId: string): Promise<(typeof activityEvents.$inferSelect)[]> {
  return postgres.db.select().from(activityEvents).where(eq(activityEvents.entityId, conversationId));
}

function expectNoLeak(text: string): void {
  expect(text).not.toContain(API_KEY);
  expect(text).not.toContain(TOOL_CANARY);
}

beforeAll(async () => {
  postgres = await startPostgres();
  setTestEnv(postgres.connectionString);
  const { buildApp } = await import('../../../apps/control-plane/src/app.js');
  const { createLogger, writableForTests } = await import('../../../apps/control-plane/src/logger.js');
  ({ appRedactor: redactor } = await import('../../../apps/control-plane/src/activity/redaction.js'));
  const { createAiAskRuntime } = await import('../../../apps/control-plane/src/ai/conversations/ask-runtime.js');
  const base = createAiAskRuntime();
  const limiter = createAiAskRuntime({ rateLimit: { max: 2, windowMs: 60_000 } });
  runtime = { ...base, takeQuestion: (user, nowMs) => (rateLimitOn ? limiter.takeQuestion(user, nowMs) : { ok: true }) };
  const capture = writableForTests();
  logs = capture.records;
  app = buildApp({
    eventPublisher: events,
    logger: createLogger({ level: 'debug', destination: capture.stream }),
    ai: { runtime, backend: fakeBackend, limits: { maxStreamMs: MAX_STREAM_MS }, heartbeatMs: HEARTBEAT_MS },
  });
  await app.listen({ host: '127.0.0.1', port: 0 });
  baseUrl = new URL(`http://127.0.0.1:${(app.server.address() as AddressInfo).port.toString()}`);
  cookie = await signIn();
  const [admin] = await postgres.db.select({ id: users.id }).from(users).where(eq(users.email, ADMIN_EMAIL));
  if (admin === undefined) throw new Error('admin user missing');
  userId = admin.id;
  installProviderStub();
});

afterAll(async () => {
  vi.unstubAllGlobals();
  await app.close();
  await postgres.stop();
});

beforeEach(() => {
  script = [];
  providerBodies.length = 0;
  rateLimitOn = false;
});

describe('AI conversations API (28-05)', () => {
  it('A3: every route answers 401 without a session', async () => {
    const id = randomUUID();
    for (const [method, url] of [
      ['GET', '/api/ai/conversations'],
      ['POST', '/api/ai/conversations'],
      ['GET', `/api/ai/conversations/${id}`],
      ['DELETE', `/api/ai/conversations/${id}`],
      ['POST', `/api/ai/conversations/${id}/messages`],
    ] as const) {
      const response = await call(method, url, method === 'POST' ? { question: 'hi' } : undefined, false);
      expect(response.statusCode, `${method} ${url}`).toBe(401);
    }
  });

  it('A3: an ask before a provider is configured is a named 409 and stores nothing', async () => {
    const id = await createConversation();
    const reply = await ask(id, 'What is running?');
    expect(reply.status).toBe(409);
    expect(JSON.parse(reply.raw)).toMatchObject({ error: 'AI_PROVIDER_NOT_CONFIGURED' });
    expect(await messagesOf(id)).toHaveLength(0);

    const service = await import('../../../apps/control-plane/src/ai/settings/ai-settings-service.js');
    const { masterKeysFromEnvironment } = await import('../../../apps/control-plane/src/services/service-credentials.js');
    const stored = await service.putAiProviderSettings(
      { db: postgres.db, now: () => new Date(), masterKeys: await masterKeysFromEnvironment()(), redactor, validateKey: () => Promise.resolve({ ok: true }) },
      { actor: { type: 'user', id: userId }, provider: 'anthropic', model: ANTHROPIC_MODEL, apiKey: API_KEY },
    );
    expect(stored.ok).toBe(true);
  });

  it('A1/H1: creates, lists and reads conversations with server-minted UUID v7 ids; client ids are rejected', async () => {
    const id = await createConversation('Checking web');
    expect(id).toMatch(UUID_V7);
    expect((await call('POST', '/api/ai/conversations', { id: randomUUID() })).statusCode).toBe(400);

    const list = await call('GET', '/api/ai/conversations');
    expect(list.statusCode).toBe(200);
    expect(ListAiConversationsResponseSchema.parse(list.body).items.map((item) => item.id)).toContain(id);

    const detail = await call('GET', `/api/ai/conversations/${id}`);
    expect(detail.statusCode).toBe(200);
    expect(AiConversationDetailSchema.parse(detail.body)).toMatchObject({ conversation: { id, title: 'Checking web' }, messages: [] });
  });

  it('A1/A2/A4: an ask streams text, tool calls (name and scope only) and the structured answer, stored redacted', async () => {
    const id = await createConversation();
    script = ['tool', 'answer'];
    const reply = await ask(id, `Is anything down? my key is ${API_KEY}`);

    expect(reply.status).toBe(200);
    expect(reply.headers['content-type']).toContain('text/event-stream');
    const types = reply.events.map((event) => event.event);
    expect(types[0]).toBe('start');
    expect(types).toContain('text');
    expect(types.at(-2)).toBe('answer');
    expect(types.at(-1)).toBe('done');
    const toolCall = reply.events.find((event) => event.event === 'tool_call');
    expect(toolCall?.data).toEqual({ name: 'list_servers', scope: null });
    expect(reply.events.find((event) => event.event === 'answer')?.data).toEqual({ answer: ANSWER });
    expect(reply.events.at(-1)?.data).toMatchObject({ status: 'complete' });
    expectNoLeak(reply.raw);
    for (const body of providerBodies) expect(body).not.toContain(API_KEY);

    const start = reply.events[0]?.data ?? {};
    expect(start.questionId).toMatch(UUID_V7);
    expect(start.messageId).toMatch(UUID_V7);

    const detail = AiConversationDetailSchema.parse((await call('GET', `/api/ai/conversations/${id}`)).body);
    expect(detail.messages.map((message) => [message.role, message.status])).toEqual([
      ['user', 'complete'],
      ['assistant', 'complete'],
    ]);
    const [question, answer] = detail.messages;
    expect(question?.content).toContain('my key is');
    expect(answer?.answer).toEqual(ANSWER);
    expect(answer?.toolCalls).toHaveLength(1);
    expect(answer?.toolCalls[0]).toMatchObject({ name: 'list_servers', status: 'ok' });
    expect(answer?.toolCalls[0]?.id).toMatch(UUID_V7);
    expect(detail.conversation.title).not.toContain(API_KEY);
    const rows = JSON.stringify(await messagesOf(id));
    expectNoLeak(rows);

    const activity = await aiActivity(id);
    expect(activity).toHaveLength(1);
    expect(activity[0]).toMatchObject({
      actorType: 'ai',
      actorId: userId,
      action: 'ai.question_answered',
      metadata: { conversationId: id, tools: ['list_servers'], toolCalls: 1, unauthorizedAttempts: 0 },
    });
    const activityText = JSON.stringify(activity);
    expect(activityText).not.toContain('Is anything down');
    expect(activityText).not.toContain(ANSWER.answer);
    expectNoLeak(activityText);
    expect(runtime.inFlightProviderRequests()).toBe(0);
  });

  it('A3: provider errors map to named codes, persist a failed message and never crash the API', async () => {
    const id = await createConversation();
    for (const [step, code] of [
      ['unauthorized', 'AI_PROVIDER_AUTH_FAILED'],
      ['garbage', 'AI_PROVIDER_UNAVAILABLE'],
    ] as const) {
      script = [step];
      const reply = await ask(id, 'Why is web slow?');
      expect(reply.status).toBe(200);
      expect(reply.events.find((event) => event.event === 'error')?.data).toMatchObject({ error: code });
      expect(reply.events.at(-1)?.data).toMatchObject({ status: 'failed' });
      expect(reply.raw).not.toContain('bad key');
    }
    const assistant = (await messagesOf(id)).filter((message) => message.role === 'assistant');
    expect(assistant.map((message) => [message.status, message.errorCode, message.answer])).toEqual([
      ['failed', 'AI_PROVIDER_AUTH_FAILED', null],
      ['failed', 'AI_PROVIDER_UNAVAILABLE', null],
    ]);
    expect((await aiActivity(id)).map((event) => event.action)).toEqual(['ai.question_failed', 'ai.question_failed']);
    expect((await call('GET', '/api/ai/conversations')).statusCode).toBe(200);
    expect(runtime.inFlightProviderRequests()).toBe(0);
  });

  it('H1: the question is capped (413 / named 422) and unknown body fields are rejected', async () => {
    const id = await createConversation();
    const tooLarge = await ask(id, 'x'.repeat(40_000));
    expect(tooLarge.status).toBe(413);
    expect(JSON.parse(tooLarge.raw)).toMatchObject({ error: 'PAYLOAD_TOO_LARGE' });
    const tooLong = await ask(id, 'x'.repeat(4_001));
    expect(tooLong.status).toBe(422);
    expect(JSON.parse(tooLong.raw)).toMatchObject({ error: 'AI_QUESTION_TOO_LONG' });
    expect((await openAsk(id, { question: 'hi', id: randomUUID() }).done).status).toBe(400);
    expect(await messagesOf(id)).toHaveLength(0);
  });

  it("H1: another user's conversation is a 404 on read, delete and ask", async () => {
    const [other] = await postgres.db
      .insert(users)
      .values({ name: 'Other', email: `other-${randomUUID()}@noodara.dev` })
      .returning({ id: users.id });
    const [foreign] = await postgres.db
      .insert(aiConversations)
      .values({ id: randomUUID(), userId: other?.id ?? '', title: '' as never, createdAt: new Date(), updatedAt: new Date() })
      .returning({ id: aiConversations.id });
    const foreignId = foreign?.id ?? '';
    expect((await call('GET', `/api/ai/conversations/${foreignId}`)).body).toMatchObject({ error: 'AI_CONVERSATION_NOT_FOUND' });
    expect((await call('DELETE', `/api/ai/conversations/${foreignId}`)).statusCode).toBe(404);
    expect((await ask(foreignId, 'hello')).status).toBe(404);
    const list = ListAiConversationsResponseSchema.parse((await call('GET', '/api/ai/conversations')).body);
    expect(list.items.map((item) => item.id)).not.toContain(foreignId);
  });

  it('A3: questions are rate limited per user with Retry-After', async () => {
    const id = await createConversation();
    rateLimitOn = true;
    script = ['answer', 'answer'];
    expect((await ask(id, 'one')).status).toBe(200);
    expect((await ask(id, 'two')).status).toBe(200);
    const limited = await ask(id, 'three');
    expect(limited.status).toBe(429);
    expect(JSON.parse(limited.raw)).toMatchObject({ error: 'RATE_LIMITED' });
    expect(Number(limited.headers['retry-after'])).toBeGreaterThan(0);
  });

  it('H1/H2/A3: a concurrent ask is a 409; a disconnect aborts the provider call, stores aborted and keeps the conversation askable', async () => {
    const id = await createConversation();
    script = ['hang'];
    const first = openAsk(id, { question: 'Hang please' });
    await waitUntil(() => hanging === 1 && first.raw().includes('event: start'));

    const second = await ask(id, 'Me too');
    expect(second.status).toBe(409);
    expect(JSON.parse(second.raw)).toMatchObject({ error: 'AI_CONVERSATION_BUSY' });
    expect(runtime.inFlightProviderRequests()).toBe(1);

    const abortedBefore = abortedCalls;
    first.destroy();
    await first.done;
    await waitUntil(() => runtime.activeAsks() === 0);
    expect(abortedCalls).toBe(abortedBefore + 1);
    expect(runtime.inFlightProviderRequests()).toBe(0);
    const assistant = (await messagesOf(id)).filter((message) => message.role === 'assistant');
    expect(assistant.map((message) => [message.status, message.answer])).toEqual([['aborted', null]]);
    expect((await aiActivity(id)).map((event) => event.action)).toEqual(['ai.question_aborted']);

    script = ['answer'];
    const again = await ask(id, 'Now answer');
    expect(again.events.at(-1)?.data).toMatchObject({ status: 'complete' });
  });

  it('H2: a stream sends heartbeats and ends at its max duration as failed, never complete', async () => {
    const id = await createConversation();
    script = ['hang'];
    const started = performance.now();
    const reply = await ask(id, 'Take forever');
    expect(performance.now() - started).toBeLessThan(MAX_STREAM_MS + 2_000);
    expect(reply.raw).toContain(': ping\n\n');
    expect(reply.events.find((event) => event.event === 'error')?.data).toMatchObject({ error: 'AI_BUDGET_EXCEEDED' });
    expect(reply.events.at(-1)?.data).toMatchObject({ status: 'failed' });
    expect(runtime.inFlightProviderRequests()).toBe(0);
    const assistant = (await messagesOf(id)).filter((message) => message.role === 'assistant');
    expect(assistant.map((message) => message.status)).toEqual(['failed']);
  });

  it('A2: deleting a conversation aborts a running ask and deletes its messages and tool calls', async () => {
    const id = await createConversation();
    script = ['tool', 'answer'];
    await ask(id, 'Fill some history');
    const messageIds = (await messagesOf(id)).map((message) => message.id);
    expect(await postgres.db.select().from(aiToolCalls).where(inArray(aiToolCalls.messageId, messageIds))).toHaveLength(1);

    script = ['hang'];
    const running = openAsk(id, { question: 'Hang again' });
    await waitUntil(() => hanging === 1);
    const removed = await call('DELETE', `/api/ai/conversations/${id}`);
    expect(removed.statusCode).toBe(204);
    await running.done;
    await waitUntil(() => runtime.activeAsks() === 0);
    expect(runtime.inFlightProviderRequests()).toBe(0);

    expect(await messagesOf(id)).toHaveLength(0);
    expect(await postgres.db.select().from(aiToolCalls).where(inArray(aiToolCalls.messageId, messageIds))).toHaveLength(0);
    expect((await call('GET', `/api/ai/conversations/${id}`)).statusCode).toBe(404);
  });

  it('never writes the key or a tool output to the log', () => {
    expectNoLeak(JSON.stringify(logs()));
  });
});
