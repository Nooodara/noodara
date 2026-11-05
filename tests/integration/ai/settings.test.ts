import { randomBytes, randomUUID } from 'node:crypto';
import { eq, inArray } from 'drizzle-orm';
import parseSetCookie from 'set-cookie-parser';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  AI_KEY_HINT_PATTERN,
  AiProviderSettingsResponseSchema,
  AiProviderSettingsViewSchema,
} from '@noodara/domain/api-contract';
import { revealSecret, type Redactor } from '@noodara/domain/security';
import type { buildApp as BuildApp } from '../../../apps/control-plane/src/app.js';
import type * as SettingsService from '../../../apps/control-plane/src/ai/settings/ai-settings-service.js';
import type * as KeyValidator from '../../../apps/control-plane/src/ai/settings/provider-key-validator.js';
import { activityEvents } from '../../../apps/control-plane/src/db/schema/activity-events.js';
import { credentials } from '../../../apps/control-plane/src/db/schema/credentials.js';
import { aiProviderSettings } from '../../../apps/control-plane/src/db/schema/v05-ai.js';
import type { ServerEventPublisher } from '../../../apps/control-plane/src/events/server-event-publisher.js';
import type { MasterKeys } from '../../../apps/control-plane/src/services/server-service-deps.js';
import { issueToken } from '../../../apps/control-plane/src/services/setup-token-repository.js';
import { startPostgres, type PostgresFixture } from '../helpers/postgres.js';

// 28-02 (A1, A2, A3, H1, H2): BYOK AI provider settings against the real HTTP surface and a
// migrated Postgres. Provider endpoints are a stubbed global fetch; every key is a per-run canary
// that must not appear in a response, an activity row or a log line.

const ADMIN_EMAIL = 'admin@noodara.dev';
const ADMIN_PASSWORD = 'correct horse battery staple';
const PUBLIC_HOST = 'panel.noodara.dev';
const URL_PATH = '/api/settings/ai';
const ANTHROPIC_URL = 'https://api.anthropic.com/v1/messages';
const OPENAI_URL = 'https://api.openai.com/v1/chat/completions';
const ANTHROPIC_MODEL = 'claude-opus-5-5';
const OPENAI_MODEL = 'gpt-5-2025-08-07';

type Json = Record<string, unknown>;
type Method = 'GET' | 'PUT' | 'DELETE';
type ProviderMode = 'ok' | 'unauthorized' | 'rate_limited' | 'server_error';

let postgres: PostgresFixture;
let app: ReturnType<typeof BuildApp>;
let cookie: string;
let logs: () => unknown[];
let redactor: Redactor;
let service: typeof SettingsService;
let validator: typeof KeyValidator;
let masterKeys: MasterKeys;

const canaries: string[] = [];
let providerMode: ProviderMode = 'ok';
const providerCalls: { url: string; key: string | null; redactedDuringCall: boolean }[] = [];

const events: ServerEventPublisher = { publish: () => Promise.resolve() };

function canary(): string {
  const value = `CANARYAI${randomBytes(18).toString('hex')}`;
  canaries.push(value);
  return value;
}

function setTestEnv(connectionString: string): void {
  process.env.NOODARA_MASTER_KEY = randomBytes(32).toString('base64');
  process.env.BETTER_AUTH_SECRET = `test-fixture-${randomUUID()}-${randomUUID()}`;
  process.env.DATABASE_URL = connectionString;
  process.env.REDIS_URL = 'redis://localhost:6379';
  process.env.NOODARA_PUBLIC_URL = `https://${PUBLIC_HOST}`;
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

async function call(method: Method, payload?: unknown): Promise<{ statusCode: number; body: Json; raw: string }> {
  const response = await app.inject({
    method,
    url: URL_PATH,
    headers: { cookie, origin: `https://${PUBLIC_HOST}` },
    ...(payload !== undefined ? { payload: payload as Json } : {}),
  });
  const body = response.body === '' ? {} : (response.json() as Json);
  return { statusCode: response.statusCode, body, raw: response.body };
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

function providerReply(url: string): Response {
  if (providerMode === 'unauthorized') {
    return jsonResponse(401, { type: 'error', error: { type: 'authentication_error', message: 'invalid x-api-key' } });
  }
  if (providerMode === 'rate_limited') {
    return jsonResponse(429, { type: 'error', error: { type: 'rate_limit_error', message: 'slow down' } });
  }
  if (providerMode === 'server_error') {
    return jsonResponse(500, { type: 'error', error: { type: 'api_error', message: 'boom' } });
  }
  if (url === ANTHROPIC_URL) {
    return jsonResponse(200, {
      id: 'msg_1',
      type: 'message',
      role: 'assistant',
      model: ANTHROPIC_MODEL,
      content: [{ type: 'text', text: 'OK' }],
      stop_reason: 'end_turn',
      stop_sequence: null,
      usage: { input_tokens: 5, output_tokens: 1 },
    });
  }
  return jsonResponse(200, {
    id: 'cmpl_1',
    object: 'chat.completion',
    created: 1,
    model: OPENAI_MODEL,
    choices: [{ index: 0, message: { role: 'assistant', content: 'OK', refusal: null }, finish_reason: 'stop' }],
    usage: { prompt_tokens: 5, completion_tokens: 1, total_tokens: 6 },
  });
}

function installProviderStub(): void {
  const original = globalThis.fetch;
  vi.stubGlobal('fetch', (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const request = new Request(input, init);
    if (request.url !== ANTHROPIC_URL && request.url !== OPENAI_URL) return original(input, init);
    const key =
      request.url === ANTHROPIC_URL
        ? request.headers.get('x-api-key')
        : (request.headers.get('authorization')?.replace(/^Bearer /, '') ?? null);
    const redactedDuringCall = key !== null && !String(redactor.redact(key)).includes(key);
    providerCalls.push({ url: request.url, key, redactedDuringCall });
    return Promise.resolve(providerReply(request.url));
  });
}

async function settingsRows(): Promise<(typeof aiProviderSettings.$inferSelect)[]> {
  return postgres.db.select().from(aiProviderSettings);
}

async function aiKeyCredentials(): Promise<{ id: string; encryptedValue: string }[]> {
  return postgres.db
    .select({ id: credentials.id, encryptedValue: credentials.encryptedValue })
    .from(credentials)
    .where(eq(credentials.type, 'ai_provider_key'));
}

async function insertCredential(type: 'ssh_password' | 'git_deploy_key'): Promise<string> {
  const [row] = await postgres.db
    .insert(credentials)
    .values({ type, encryptedValue: 'v1:not-a-real-envelope', keyVersion: 1 })
    .returning({ id: credentials.id });
  if (row === undefined) throw new Error('credential insert returned no row');
  return row.id;
}

function serviceDeps(validateKey: KeyValidator.ProviderKeyValidator): SettingsService.AiSettingsServiceDeps {
  return { db: postgres.db, now: () => new Date(), masterKeys, redactor, validateKey };
}

function expectNoCanary(text: string): void {
  for (const value of canaries) expect(text).not.toContain(value);
}

beforeAll(async () => {
  postgres = await startPostgres();
  setTestEnv(postgres.connectionString);
  const { buildApp } = await import('../../../apps/control-plane/src/app.js');
  const { createLogger, writableForTests } = await import('../../../apps/control-plane/src/logger.js');
  ({ appRedactor: redactor } = await import('../../../apps/control-plane/src/activity/redaction.js'));
  service = await import('../../../apps/control-plane/src/ai/settings/ai-settings-service.js');
  validator = await import('../../../apps/control-plane/src/ai/settings/provider-key-validator.js');
  const { masterKeysFromEnvironment } = await import('../../../apps/control-plane/src/services/service-credentials.js');
  masterKeys = await masterKeysFromEnvironment()();
  const capture = writableForTests();
  logs = capture.records;
  app = buildApp({ eventPublisher: events, logger: createLogger({ level: 'debug', destination: capture.stream }) });
  cookie = await signIn();
  installProviderStub();
});

afterAll(async () => {
  vi.unstubAllGlobals();
  await app.close();
  await postgres.stop();
});

beforeEach(() => {
  providerMode = 'ok';
  providerCalls.length = 0;
});

describe('AI provider settings API (28-02)', () => {
  it('GET returns null settings before anything is configured', async () => {
    const response = await call('GET');
    expect(response.statusCode, response.raw).toBe(200);
    expect(AiProviderSettingsResponseSchema.parse(response.body)).toEqual({ settings: null });
  });

  it('H1: rejects a malformed key with a 422 that never echoes it and makes no provider call', async () => {
    const marker = canary();
    const cases: [string, string][] = [
      [`${marker} with space`, 'invalid_characters'],
      [`${marker}\ttab`, 'invalid_characters'],
      [`${marker}é`, 'invalid_characters'],
      [`${marker}${'x'.repeat(600)}`, 'too_long'],
      ['short-key', 'too_short'],
    ];
    for (const [apiKey, reason] of cases) {
      const response = await call('PUT', { provider: 'anthropic', model: ANTHROPIC_MODEL, apiKey });
      expect(response.statusCode, response.raw).toBe(422);
      expect(response.body).toMatchObject({ error: 'AI_PROVIDER_INPUT_INVALID', reason });
      expect(response.raw).not.toContain(apiKey);
      expectNoCanary(response.raw);
    }
    expect(providerCalls).toHaveLength(0);
    expect(await settingsRows()).toHaveLength(0);
    expect(await aiKeyCredentials()).toHaveLength(0);
  });

  it('A2: a model outside the per-provider allowlist is refused and nothing is stored', async () => {
    const apiKey = canary();
    const crossed = await call('PUT', { provider: 'anthropic', model: OPENAI_MODEL, apiKey });
    expect(crossed.statusCode, crossed.raw).toBe(400);
    expectNoCanary(crossed.raw);
    const direct = await service.putAiProviderSettings(serviceDeps(() => Promise.resolve({ ok: true })), {
      actor: { type: 'system' },
      provider: 'openai',
      model: 'gpt-4o-not-allowed',
      apiKey,
    });
    expect(direct).toMatchObject({ ok: false, code: 'AI_PROVIDER_INPUT_INVALID', reason: 'model_not_allowed' });
    expect(providerCalls).toHaveLength(0);
    expect(await settingsRows()).toHaveLength(0);
  });

  it('A2: an invalid key returns AI_PROVIDER_AUTH_FAILED and nothing is stored', async () => {
    providerMode = 'unauthorized';
    const apiKey = canary();
    const response = await call('PUT', { provider: 'anthropic', model: ANTHROPIC_MODEL, apiKey });
    expect(response.statusCode, response.raw).toBe(422);
    expect(response.body).toMatchObject({ error: 'AI_PROVIDER_AUTH_FAILED' });
    expectNoCanary(response.raw);
    expect(providerCalls).toHaveLength(1);
    expect(await settingsRows()).toHaveLength(0);
    expect(await aiKeyCredentials()).toHaveLength(0);
  });

  it('maps a provider rate limit to 429 and an outage to 503, storing nothing', async () => {
    providerMode = 'rate_limited';
    const limited = await call('PUT', { provider: 'openai', model: OPENAI_MODEL, apiKey: canary() });
    expect(limited.statusCode, limited.raw).toBe(429);
    expect(limited.body).toMatchObject({ error: 'AI_PROVIDER_RATE_LIMITED' });
    providerMode = 'server_error';
    const down = await call('PUT', { provider: 'openai', model: OPENAI_MODEL, apiKey: canary() });
    expect(down.statusCode, down.raw).toBe(503);
    expect(down.body).toMatchObject({ error: 'AI_PROVIDER_UNAVAILABLE' });
    expect(providerCalls).toHaveLength(2);
    expect(await settingsRows()).toHaveLength(0);
    expect(await aiKeyCredentials()).toHaveLength(0);
  });

  it('A1/A3: PUT validates, stores the key encrypted and returns only provider, model and hint', async () => {
    const apiKey = canary();
    expect(String(redactor.redact(apiKey))).toBe(apiKey);
    const response = await call('PUT', { provider: 'anthropic', model: ANTHROPIC_MODEL, apiKey });
    expect(response.statusCode, response.raw).toBe(200);
    const view = AiProviderSettingsViewSchema.parse(response.body);
    expect(view).toMatchObject({ provider: 'anthropic', model: ANTHROPIC_MODEL });
    expect(view.keyHint).toMatch(AI_KEY_HINT_PATTERN);
    expect(view.keyHint.endsWith(apiKey.slice(-4))).toBe(true);
    expect(view.keyHint).not.toContain(apiKey.slice(0, 4));
    expectNoCanary(response.raw);

    // A3: the key went to the provider, was redacted for the call and released afterwards.
    expect(providerCalls).toEqual([{ url: ANTHROPIC_URL, key: apiKey, redactedDuringCall: true }]);
    expect(String(redactor.redact(apiKey))).toBe(apiKey);

    const [row] = await settingsRows();
    expect(row?.keyHint).toBe(view.keyHint);
    const stored = await aiKeyCredentials();
    expect(stored.map((c) => c.id)).toEqual([row?.credentialId]);
    expect(stored[0]?.encryptedValue).not.toContain(apiKey);

    const fetched = await call('GET');
    expect(fetched.statusCode, fetched.raw).toBe(200);
    expect(AiProviderSettingsResponseSchema.parse(fetched.body)).toEqual({ settings: view });
    expectNoCanary(fetched.raw);

    const [event] = await postgres.db
      .select()
      .from(activityEvents)
      .where(eq(activityEvents.action, 'ai_settings.configured'));
    expect(event).toMatchObject({ entityType: 'ai_provider_settings', entityId: row?.id, outcome: 'success' });
    expect(event?.metadata).toEqual({ provider: 'anthropic', model: ANTHROPIC_MODEL });
  });

  it('A3: withStoredAiProvider decrypts the key and redacts it only for the duration of the work', async () => {
    const result = await service.withStoredAiProvider({ db: postgres.db, masterKeys, redactor }, (stored) => {
      const raw = revealSecret(stored.apiKey);
      expect(String(redactor.redact(raw))).not.toContain(raw);
      return Promise.resolve({ raw, provider: stored.provider, model: stored.model });
    });
    if (!result.ok) throw new Error(result.code);
    expect(result.value).toMatchObject({ provider: 'anthropic', model: ANTHROPIC_MODEL });
    expect(canaries).toContain(result.value.raw);
    expect(String(redactor.redact(result.value.raw))).toBe(result.value.raw);
  });

  it('H1: a validation timeout maps to AI_PROVIDER_UNAVAILABLE and leaves the stored key untouched', async () => {
    const before = await settingsRows();
    const hanging = ((_input: RequestInfo | URL, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => {
          reject(new Error('aborted'));
        });
      })) as typeof fetch;
    const validateKey = validator.createProviderKeyValidator({ limits: { timeoutMs: 200, idleTimeoutMs: 200 }, fetch: hanging });
    const started = Date.now();
    const result = await service.putAiProviderSettings(serviceDeps(validateKey), {
      actor: { type: 'system' },
      provider: 'openai',
      model: OPENAI_MODEL,
      apiKey: canary(),
    });
    expect(result).toMatchObject({ ok: false, code: 'AI_PROVIDER_UNAVAILABLE' });
    expect(Date.now() - started).toBeLessThan(5_000);
    expect(await settingsRows()).toEqual(before);
    expect((await aiKeyCredentials()).map((c) => c.id)).toEqual(before.map((r) => r.credentialId));
  });

  it('H1: replacing the key deletes the previous encrypted key in the same transaction', async () => {
    const [previous] = await settingsRows();
    const apiKey = canary();
    const response = await call('PUT', { provider: 'openai', model: OPENAI_MODEL, apiKey });
    expect(response.statusCode, response.raw).toBe(200);
    expect(providerCalls).toEqual([{ url: OPENAI_URL, key: apiKey, redactedDuringCall: true }]);
    const rows = await settingsRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ id: previous?.id, provider: 'openai', model: OPENAI_MODEL });
    const stored = await aiKeyCredentials();
    expect(stored.map((c) => c.id)).toEqual([rows[0]?.credentialId]);
    expect(stored.map((c) => c.id)).not.toContain(previous?.credentialId);
    const replaced = await postgres.db.select().from(activityEvents).where(eq(activityEvents.action, 'ai_settings.replaced'));
    expect(replaced).toHaveLength(1);
    expect(replaced[0]?.metadata).toEqual({ provider: 'openai', model: OPENAI_MODEL });
  });

  it('H2: settings cannot be pointed at an SSH or Git credential, which therefore survives', async () => {
    const [existing] = await settingsRows();
    for (const type of ['ssh_password', 'git_deploy_key'] as const) {
      const foreign = await insertCredential(type);
      await expect(
        postgres.db.transaction((tx) =>
          service.writeSettingsRow(tx, existing, {
            provider: 'anthropic',
            model: ANTHROPIC_MODEL,
            credentialId: foreign,
            keyHint: '••••••••abcd',
            at: new Date(),
          }),
        ),
      ).rejects.toThrow(/ai_provider_key/);
      const survivors = await postgres.db.select({ id: credentials.id }).from(credentials).where(eq(credentials.id, foreign));
      expect(survivors).toHaveLength(1);
    }
    expect(await settingsRows()).toEqual([existing]);
  });

  it('H2: DELETE refuses a settings row that points at a non-AI credential', async () => {
    const [legit] = await settingsRows();
    const foreign = await insertCredential('ssh_password');
    // Simulate a corrupted row: swap the reference by hand (the trigger removes the legit key).
    await postgres.db.update(aiProviderSettings).set({ credentialId: foreign });
    const response = await call('DELETE');
    expect(response.statusCode).toBeGreaterThanOrEqual(500);
    const survivors = await postgres.db.select({ id: credentials.id }).from(credentials).where(eq(credentials.id, foreign));
    expect(survivors).toHaveLength(1);
    expect(await settingsRows()).toHaveLength(1);
    // A PUT cannot repair it either: the old reference is checked before the update.
    const apiKey = canary();
    const restored = await call('PUT', { provider: 'anthropic', model: ANTHROPIC_MODEL, apiKey });
    expect(restored.statusCode, restored.raw).toBe(500);
    expect((await settingsRows())[0]).toMatchObject({ id: legit?.id, credentialId: foreign });
    // Raw cleanup outside the service (the trigger drops the foreign row with it), then the
    // leftover H2 fixtures.
    await postgres.db.delete(aiProviderSettings);
    await postgres.db.delete(credentials).where(inArray(credentials.type, ['ssh_password', 'git_deploy_key']));
    expect(await settingsRows()).toHaveLength(0);
    const configured = await call('PUT', { provider: 'anthropic', model: ANTHROPIC_MODEL, apiKey: canary() });
    expect(configured.statusCode, configured.raw).toBe(200);
  });

  it('A1: DELETE removes the settings and the key in one transaction and records an event', async () => {
    const [row] = await settingsRows();
    const response = await call('DELETE');
    expect(response.statusCode, response.raw).toBe(204);
    expect(await settingsRows()).toHaveLength(0);
    expect(await aiKeyCredentials()).toHaveLength(0);
    const deleted = await postgres.db.select().from(activityEvents).where(eq(activityEvents.action, 'ai_settings.deleted'));
    expect(deleted.map((e) => e.entityId)).toEqual([row?.id]);
    expect(deleted[0]?.metadata).toEqual({ provider: 'anthropic', model: ANTHROPIC_MODEL });
    const again = await call('DELETE');
    expect(again.statusCode, again.raw).toBe(404);
    expect((await call('GET')).body).toEqual({ settings: null });
  });

  it('A3: no canary key reaches an activity row or a log line', async () => {
    const rows = await postgres.db.select().from(activityEvents);
    expectNoCanary(JSON.stringify(rows));
    expectNoCanary(JSON.stringify(logs()));
    expect(canaries.length).toBeGreaterThan(5);
  });
});
