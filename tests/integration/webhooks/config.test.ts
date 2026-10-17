import { randomBytes, randomUUID } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import parseSetCookie from 'set-cookie-parser';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { revealSecret } from '@noodara/domain/security';
import { activityEvents } from '../../../apps/control-plane/src/db/schema/activity-events.js';
import { credentials } from '../../../apps/control-plane/src/db/schema/credentials.js';
import { servers } from '../../../apps/control-plane/src/db/schema/servers.js';
import { services } from '../../../apps/control-plane/src/db/schema/services.js';
import type { ServerEvent, ServerEventPublisher } from '../../../apps/control-plane/src/events/server-event-publisher.js';
import type { MasterKeys } from '../../../apps/control-plane/src/services/server-service-deps.js';
import { issueToken } from '../../../apps/control-plane/src/services/setup-token-repository.js';
import type { ResolvedWebhook } from '../../../apps/control-plane/src/services/webhook-config.js';
import { startPostgres, type PostgresFixture } from '../helpers/postgres.js';

// 18-01: webhook enable / rotate / disable over the real HTTP surface and a migrated Postgres.
// Every secret the API hands out is collected and swept for in logs, activity rows, events, the
// stored envelopes and every later response (A3).

const ADMIN_EMAIL = 'admin@noodara.test';
const ADMIN_PASSWORD = 'correct horse battery staple';
const PUBLIC_URL = 'http://noodara.example.test:3000';

type Json = Record<string, unknown>;
interface Recorded {
  readonly statusCode: number;
  readonly body: Json;
  readonly raw: string;
  readonly headers: Record<string, unknown>;
}

let postgres: PostgresFixture;
let app: FastifyInstance;
let cookie: string;
let logRecords: () => unknown[];
let masterKeys: MasterKeys;
let resolve: (hookId: string) => Promise<ResolvedWebhook | null>;
const published: ServerEvent[] = [];
/** Raw bodies of every response except the enable/rotate successes that legitimately carry a secret. */
const laterResponses: string[] = [];
/** Every secret the API returned. */
const issuedSecrets: string[] = [];

const recorder: ServerEventPublisher = {
  publish(event) {
    published.push(event);
    return Promise.resolve();
  },
};

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
  options: { payload?: unknown; headers?: Record<string, string>; raw?: string; anonymous?: boolean } = {},
): Promise<Recorded> {
  const headers: Record<string, string> = { ...(options.anonymous ? {} : { cookie }), ...options.headers };
  const response = await app.inject({
    method,
    url,
    headers: options.raw !== undefined ? { ...headers, 'content-type': 'application/json' } : headers,
    ...(options.raw !== undefined ? { payload: options.raw } : {}),
    ...(options.payload !== undefined ? { payload: options.payload as Json } : {}),
  });
  const raw = response.body;
  const body = (raw.length > 0 ? response.json() : {}) as Json;
  if (response.statusCode === 200 && typeof body.secret === 'string') {
    issuedSecrets.push(body.secret);
  } else {
    laterResponses.push(raw);
  }
  return { statusCode: response.statusCode, body, raw, headers: response.headers };
}

function short(): string {
  return randomUUID().replace(/-/g, '').slice(0, 10);
}

interface Fixture {
  readonly projectId: string;
  readonly environmentId: string;
  readonly serverId: string;
}

async function newFixture(): Promise<Fixture> {
  const project = await call('POST', '/api/projects', { payload: { name: `Hook ${short()}` } });
  expect(project.statusCode, project.raw).toBe(201);
  const projectId = String(project.body.id);
  const environment = await call('POST', `/api/projects/${projectId}/environments`, { payload: { name: 'production' } });
  expect(environment.statusCode, environment.raw).toBe(201);
  const server = await call('POST', '/api/servers', {
    payload: {
      name: `srv-${short()}`,
      host: `${short()}.example.test`,
      credential: { type: 'ssh_password', password: 'not-used-by-this-test' },
    },
  });
  expect(server.statusCode, server.raw).toBe(201);
  const serverId = String(server.body.id);
  await postgres.db
    .update(servers)
    .set({ status: 'CONNECTED', dockerInstalled: true, dockerBuildkitAvailable: true })
    .where(eq(servers.id, serverId));
  return { projectId, environmentId: String(environment.body.id), serverId };
}

async function newService(fx: Fixture, source: Json): Promise<{ id: string; name: string }> {
  const name = `svc-${short()}`;
  const response = await call('POST', `/api/projects/${fx.projectId}/services`, {
    payload: { environmentId: fx.environmentId, serverId: fx.serverId, name, source, internalPort: 8080 },
  });
  expect(response.statusCode, response.raw).toBe(201);
  return { id: String(response.body.id), name };
}

const GIT_SOURCE = { kind: 'git', repositoryUrl: 'https://github.com/acme/api.git', branch: 'main' };
const IMAGE_SOURCE = { kind: 'image', imageRef: 'nginx:1.27' };

function webhookUrl(fx: Fixture, serviceId: string): string {
  return `/api/projects/${fx.projectId}/services/${serviceId}/webhook`;
}

async function webhookRow(serviceId: string) {
  const [row] = await postgres.db
    .select({ hookId: services.webhookHookId, credentialId: services.webhookSecretCredentialId })
    .from(services)
    .where(eq(services.id, serviceId));
  return row;
}

async function credentialExists(id: string): Promise<boolean> {
  const rows = await postgres.db.select({ id: credentials.id }).from(credentials).where(eq(credentials.id, id));
  return rows.length === 1;
}

async function webhookEvents(serviceId: string) {
  return postgres.db
    .select({ action: activityEvents.action, actorType: activityEvents.actorType, metadata: activityEvents.metadata })
    .from(activityEvents)
    .where(and(eq(activityEvents.entityId, serviceId), eq(activityEvents.action, 'service.updated')));
}

beforeAll(async () => {
  postgres = await startPostgres();
  process.env.NOODARA_MASTER_KEY = randomBytes(32).toString('base64');
  process.env.BETTER_AUTH_SECRET = `test-fixture-${randomUUID()}-${randomUUID()}`;
  process.env.DATABASE_URL = postgres.connectionString;
  process.env.REDIS_URL = 'redis://localhost:6379';
  process.env.NOODARA_PUBLIC_URL = PUBLIC_URL;
  const { writableForTests, createLogger } = await import('../../../apps/control-plane/src/logger.js');
  const capture = writableForTests();
  logRecords = capture.records;
  const { buildApp } = await import('../../../apps/control-plane/src/app.js');
  app = buildApp({
    eventPublisher: recorder,
    logger: createLogger({ level: 'trace', destination: capture.stream }) as unknown as FastifyInstance['log'],
  });
  masterKeys = { current: Buffer.from(String(process.env.NOODARA_MASTER_KEY), 'base64') };
  const { resolveWebhookSecret } = await import('../../../apps/control-plane/src/services/webhook-config.js');
  resolve = (hookId) => resolveWebhookSecret({ db: postgres.db, masterKeys: () => Promise.resolve(masterKeys) }, hookId);
  cookie = await signIn();
});

afterAll(async () => {
  await app.close();
  await postgres.stop();
});

describe('enable (A1, H2, H3)', () => {
  it('returns the payload URL and a 32-byte secret once, built from the public origin only', async () => {
    const fx = await newFixture();
    const service = await newService(fx, GIT_SOURCE);
    expect((await call('GET', webhookUrl(fx, service.id))).body).toStrictEqual({ enabled: false, payloadUrl: null });

    const enabled = await call('POST', webhookUrl(fx, service.id), {
      headers: { host: 'evil.example.com', 'x-forwarded-host': 'evil.example.com', 'x-forwarded-proto': 'https' },
    });
    expect(enabled.statusCode, enabled.raw).toBe(200);
    expect(enabled.headers['cache-control']).toBe('no-store');
    const row = await webhookRow(service.id);
    expect(row?.hookId).toMatch(/^[A-Za-z0-9_-]{22,64}$/);
    expect(Buffer.from(String(row?.hookId), 'base64url').length).toBeGreaterThanOrEqual(16);
    expect(row?.hookId).not.toContain(service.id);
    expect(enabled.body).toStrictEqual({
      enabled: true,
      payloadUrl: `${PUBLIC_URL}/webhooks/github/${String(row?.hookId)}`,
      secret: expect.stringMatching(/^[0-9a-f]{64}$/),
    });
    expect(enabled.raw).not.toContain('evil.example.com');

    const [stored] = await postgres.db.select().from(credentials).where(eq(credentials.id, String(row?.credentialId)));
    expect(stored?.type).toBe('webhook_secret');
    expect(stored?.encryptedValue).not.toContain(String(enabled.body.secret));
    expect(revealSecret((await resolve(String(row?.hookId)))!.secret)).toBe(enabled.body.secret);

    const read = await call('GET', webhookUrl(fx, service.id));
    expect(read.statusCode).toBe(200);
    expect(read.body).toStrictEqual({ enabled: true, payloadUrl: enabled.body.payloadUrl });

    const again = await call('POST', webhookUrl(fx, service.id), { payload: {} });
    expect(again.statusCode).toBe(409);
    expect(again.body).toStrictEqual({ error: 'WEBHOOK_ALREADY_ENABLED', message: expect.any(String) });
    expect(await webhookRow(service.id)).toStrictEqual(row);
    expect(revealSecret((await resolve(String(row?.hookId)))!.secret)).toBe(enabled.body.secret);
  });

  it('caps and validates the action body', async () => {
    const fx = await newFixture();
    const service = await newService(fx, GIT_SOURCE);
    const stray = await call('POST', webhookUrl(fx, service.id), { payload: { secret: 'chosen-by-me' } });
    expect(stray.statusCode).toBe(400);
    const oversized = await call('POST', webhookUrl(fx, service.id), { raw: JSON.stringify({ pad: 'x'.repeat(4096) }) });
    expect(oversized.statusCode).toBe(413);
    const malformed = await call('DELETE', webhookUrl(fx, service.id), { raw: '{"a":' });
    expect(malformed.statusCode).toBe(400);
    expect((await webhookRow(service.id))?.hookId).toBeNull();
  });
});

describe('rotate and disable (A2, H1, H2)', () => {
  it('rotates the secret under the same URL and rejects the old one at once', async () => {
    const fx = await newFixture();
    const service = await newService(fx, GIT_SOURCE);
    const enabled = await call('POST', webhookUrl(fx, service.id));
    const before = await webhookRow(service.id);

    const rotated = await call('POST', `${webhookUrl(fx, service.id)}/rotate`);
    expect(rotated.statusCode, rotated.raw).toBe(200);
    expect(rotated.body.payloadUrl).toBe(enabled.body.payloadUrl);
    expect(rotated.body.secret).not.toBe(enabled.body.secret);
    const after = await webhookRow(service.id);
    expect(after?.hookId).toBe(before?.hookId);
    expect(await credentialExists(String(before?.credentialId))).toBe(false);
    const resolved = await resolve(String(after?.hookId));
    expect(resolved?.serviceId).toBe(service.id);
    expect(revealSecret(resolved!.secret)).toBe(rotated.body.secret);
    expect(revealSecret(resolved!.secret)).not.toBe(enabled.body.secret);
  });

  it('a delivery resolved concurrently with rotations sees exactly the old or the new secret', async () => {
    const fx = await newFixture();
    const service = await newService(fx, GIT_SOURCE);
    let current = String((await call('POST', webhookUrl(fx, service.id))).body.secret);
    const hookId = String((await webhookRow(service.id))?.hookId);

    for (let round = 0; round < 5; round += 1) {
      const readers = Array.from({ length: 12 }, () => resolve(hookId));
      const rotation = call('POST', `${webhookUrl(fx, service.id)}/rotate`);
      const [seen, rotated] = await Promise.all([Promise.all(readers), rotation]);
      expect(rotated.statusCode).toBe(200);
      const next = String(rotated.body.secret);
      for (const result of seen) {
        expect(result).not.toBeNull();
        expect([current, next]).toContain(revealSecret(result!.secret));
      }
      current = next;
    }
    expect(revealSecret((await resolve(hookId))!.secret)).toBe(current);
  });

  it('disable removes the credential and the hook id resolves like an unknown one', async () => {
    const fx = await newFixture();
    const service = await newService(fx, GIT_SOURCE);
    await call('POST', webhookUrl(fx, service.id));
    const row = await webhookRow(service.id);

    const disabled = await call('DELETE', webhookUrl(fx, service.id));
    expect(disabled.statusCode, disabled.raw).toBe(200);
    expect(disabled.body).toStrictEqual({ enabled: false, payloadUrl: null });
    expect(await webhookRow(service.id)).toStrictEqual({ hookId: null, credentialId: null });
    expect(await credentialExists(String(row?.credentialId))).toBe(false);
    expect(await resolve(String(row?.hookId))).toBeNull();
    expect(await resolve(randomBytes(24).toString('base64url'))).toBeNull();

    expect((await call('POST', `${webhookUrl(fx, service.id)}/rotate`)).body.error).toBe('WEBHOOK_NOT_ENABLED');
    expect((await call('DELETE', webhookUrl(fx, service.id))).statusCode).toBe(200);
  });

  it('service delete removes the webhook credential row', async () => {
    const fx = await newFixture();
    const service = await newService(fx, GIT_SOURCE);
    await call('POST', webhookUrl(fx, service.id));
    const row = await webhookRow(service.id);
    const deleted = await call('DELETE', `/api/projects/${fx.projectId}/services/${service.id}`, {
      payload: { confirmName: service.name },
    });
    expect(deleted.statusCode, deleted.raw).toBe(200);
    expect(await credentialExists(String(row?.credentialId))).toBe(false);
    expect(await resolve(String(row?.hookId))).toBeNull();
  });
});

describe('hook-id collisions (18-05 H9)', () => {
  async function enableWithHookIds(fx: Fixture, serviceId: string, hookIds: readonly string[]) {
    const { enableWebhook, WEBHOOK_HOOK_ID_BYTES } = await import('../../../apps/control-plane/src/services/webhook-config.js');
    let draws = 0;
    const result = await enableWebhook(
      {
        db: postgres.db,
        now: () => new Date(),
        masterKeys: () => Promise.resolve(masterKeys),
        publicOrigin: new URL(PUBLIC_URL).origin,
        randomBytes: (size) => {
          if (size !== WEBHOOK_HOOK_ID_BYTES) return randomBytes(size);
          const hookId = hookIds[Math.min(draws, hookIds.length - 1)] ?? '';
          draws += 1;
          return Buffer.from(hookId, 'base64url');
        },
      },
      { actor: { type: 'system' }, projectId: fx.projectId, serviceId },
    );
    return { result, draws };
  }

  async function webhookCredentialCount(): Promise<number> {
    return (await postgres.db.select({ id: credentials.id }).from(credentials).where(eq(credentials.type, 'webhook_secret'))).length;
  }

  it('redraws a hook id that collides on the unique index instead of failing', async () => {
    const fx = await newFixture();
    const holder = await newService(fx, GIT_SOURCE);
    expect((await call('POST', webhookUrl(fx, holder.id))).statusCode).toBe(200);
    const taken = String((await webhookRow(holder.id))?.hookId);
    const fresh = randomBytes(24).toString('base64url');
    const service = await newService(fx, GIT_SOURCE);

    const { result, draws } = await enableWithHookIds(fx, service.id, [taken, fresh]);
    expect(result.ok).toBe(true);
    expect(draws).toBe(2);
    expect((await webhookRow(service.id))?.hookId).toBe(fresh);
    expect((await webhookRow(holder.id))?.hookId).toBe(taken);
    if (result.ok) issuedSecrets.push(revealSecret(result.webhook.secret));
  });

  it('answers 409 WEBHOOK_HOOK_ID_CONFLICT when every draw collides and leaves no credential behind', async () => {
    const fx = await newFixture();
    const holder = await newService(fx, GIT_SOURCE);
    await call('POST', webhookUrl(fx, holder.id));
    const taken = String((await webhookRow(holder.id))?.hookId);
    const service = await newService(fx, GIT_SOURCE);
    const before = await webhookCredentialCount();

    const { result } = await enableWithHookIds(fx, service.id, [taken]);
    expect(result).toMatchObject({ ok: false, code: 'WEBHOOK_HOOK_ID_CONFLICT' });
    if (!result.ok) {
      const { mapServiceCodeToStatus } = await import('../../../apps/control-plane/src/routes/http-errors.js');
      expect(mapServiceCodeToStatus(result.code)).toBe(409);
    }
    expect(await webhookRow(service.id)).toStrictEqual({ hookId: null, credentialId: null });
    expect(await webhookCredentialCount()).toBe(before);
    expect(await webhookEvents(service.id)).toHaveLength(0);
    // The connection is still usable: a normal enable afterwards succeeds.
    expect((await call('POST', webhookUrl(fx, service.id))).statusCode).toBe(200);
  });
});

describe('guards and activity (A4)', () => {
  it('refuses an image-source service with 422 WEBHOOK_SOURCE_NOT_GIT', async () => {
    const fx = await newFixture();
    const service = await newService(fx, IMAGE_SOURCE);
    for (const url of [webhookUrl(fx, service.id), `${webhookUrl(fx, service.id)}/rotate`]) {
      const response = await call('POST', url);
      expect(response.statusCode).toBe(422);
      expect(response.body).toStrictEqual({ error: 'WEBHOOK_SOURCE_NOT_GIT', message: expect.any(String) });
    }
    expect(await webhookRow(service.id)).toStrictEqual({ hookId: null, credentialId: null });
  });

  it('requires a session for every webhook route', async () => {
    const fx = await newFixture();
    const service = await newService(fx, GIT_SOURCE);
    const url = webhookUrl(fx, service.id);
    for (const [method, path] of [
      ['GET', url],
      ['POST', url],
      ['POST', `${url}/rotate`],
      ['DELETE', url],
    ] as const) {
      expect((await call(method, path, { anonymous: true })).statusCode).toBe(401);
    }
    expect(await webhookRow(service.id)).toStrictEqual({ hookId: null, credentialId: null });
  });

  it('answers 404 for a service of another project', async () => {
    const fx = await newFixture();
    const other = await newFixture();
    const service = await newService(fx, GIT_SOURCE);
    expect((await call('POST', webhookUrl(other, service.id))).statusCode).toBe(404);
    expect((await call('GET', webhookUrl(other, service.id))).statusCode).toBe(404);
  });

  it('records enable, rotate and disable as user activity events without the secret or hook id', async () => {
    const fx = await newFixture();
    const service = await newService(fx, GIT_SOURCE);
    await call('POST', webhookUrl(fx, service.id));
    await call('POST', `${webhookUrl(fx, service.id)}/rotate`);
    await call('DELETE', webhookUrl(fx, service.id));
    const events = await webhookEvents(service.id);
    expect(events.map((event) => event.metadata)).toStrictEqual([
      { changedFields: ['webhook'], requiresRedeploy: false, credentialReplaced: false },
      { changedFields: ['webhookSecret'], requiresRedeploy: false, credentialReplaced: true },
      { changedFields: ['webhook'], requiresRedeploy: false, credentialReplaced: true },
    ]);
    expect(events.every((event) => event.actorType === 'user')).toBe(true);
  });
});

describe('canary sweep (A3)', () => {
  it('no issued secret reaches a log line, an activity row, an event, a stored envelope or a later response', async () => {
    expect(issuedSecrets.length).toBeGreaterThanOrEqual(10);
    const hookIds = (await postgres.db.select({ hookId: services.webhookHookId }).from(services))
      .map((row) => row.hookId)
      .filter((id): id is string => id !== null);
    const logs = JSON.stringify(logRecords());
    const haystacks = [
      logs,
      ...laterResponses,
      JSON.stringify(published),
      JSON.stringify(await postgres.db.select().from(activityEvents)),
      JSON.stringify(await postgres.db.select().from(credentials)),
      JSON.stringify(await postgres.db.select().from(services)),
    ];
    expect(logs.length).toBeGreaterThan(0);
    for (const haystack of haystacks) {
      for (const secret of issuedSecrets) expect(haystack).not.toContain(secret);
    }
    const activity = JSON.stringify(await postgres.db.select().from(activityEvents));
    for (const hookId of hookIds) expect(activity).not.toContain(hookId);
  });
});

describe('boot validation of the public origin (H3)', () => {
  // Non-http schemes are covered by the unit tests: Better Auth itself rejects them asynchronously,
  // so the boot check is proven here with an http URL only the webhook origin check refuses.
  it('refuses to start with a NOODARA_PUBLIC_URL the webhook origin check rejects', async () => {
    const saved = process.env.NOODARA_PUBLIC_URL;
    vi.resetModules();
    process.env.NOODARA_PUBLIC_URL = 'http://user:pass@noodara.example.test';
    try {
      const { buildApp } = await import('../../../apps/control-plane/src/app.js');
      const broken = buildApp({ eventPublisher: recorder });
      await expect(broken.ready()).rejects.toThrow(/must not carry credentials/);
      await broken.close().catch(() => undefined);
    } finally {
      process.env.NOODARA_PUBLIC_URL = saved;
      vi.resetModules();
    }
  });
});
