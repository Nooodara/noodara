import { randomBytes, randomUUID } from 'node:crypto';
import { eq, inArray } from 'drizzle-orm';
import parseSetCookie from 'set-cookie-parser';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { revealSecret, secretValue } from '@noodara/domain/security';
import type { buildApp as BuildApp } from '../../../apps/control-plane/src/app.js';
import { activityEvents } from '../../../apps/control-plane/src/db/schema/activity-events.js';
import { environmentVariables } from '../../../apps/control-plane/src/db/schema/environment-variables.js';
import { secrets } from '../../../apps/control-plane/src/db/schema/secrets.js';
import { servers } from '../../../apps/control-plane/src/db/schema/servers.js';
import { services } from '../../../apps/control-plane/src/db/schema/services.js';
import type { ServerEventPublisher } from '../../../apps/control-plane/src/events/server-event-publisher.js';
import { createSecret, type SecretOwner } from '../../../apps/control-plane/src/secrets/secret-store.js';
import { issueToken } from '../../../apps/control-plane/src/services/setup-token-repository.js';
import { startPostgres, type PostgresFixture } from '../helpers/postgres.js';

// 23-03 (A1, A2, A3, H1): the secrets API against the real HTTP surface and a migrated Postgres.
// Values are per-run canaries; none may appear in a response, an activity row or a log line.

const ADMIN_EMAIL = 'admin@noodara.dev';
const ADMIN_PASSWORD = 'correct horse battery staple';
const PUBLIC_HOST = 'panel.noodara.dev';
const SEED_KEY = randomBytes(32);
let serverOctet = 10;

type Json = Record<string, unknown>;
type Method = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';

let postgres: PostgresFixture;
let app: ReturnType<typeof BuildApp>;
let cookie: string;
let logs: () => unknown[];

const events: ServerEventPublisher = { publish: () => Promise.resolve() };

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

async function call(method: Method, url: string, payload?: unknown): Promise<{ statusCode: number; body: Json; raw: string }> {
  const response = await app.inject({
    method,
    url,
    headers: { cookie, origin: `https://${PUBLIC_HOST}` },
    ...(payload !== undefined ? { payload: payload as Json } : {}),
  });
  const body = response.body === '' ? {} : (response.json() as Json);
  return { statusCode: response.statusCode, body, raw: response.body };
}

function short(): string {
  return randomUUID().replace(/-/g, '').slice(0, 10);
}

function canary(): string {
  return `CANARY${randomBytes(18).toString('hex')}`;
}

interface Fixture {
  readonly projectId: string;
  readonly projectName: string;
  readonly environmentId: string;
  readonly environmentName: string;
  readonly serviceId: string;
  readonly serviceName: string;
  readonly secretUrls: { project: string; environment: string; service: string };
  readonly envUrls: { project: string; environment: string; service: string };
}

async function newFixture(): Promise<Fixture> {
  const projectName = `Sec ${short()}`;
  const project = await call('POST', '/api/projects', { name: projectName });
  expect(project.statusCode, project.raw).toBe(201);
  const projectId = String(project.body.id);
  const environmentName = `env-${short()}`;
  const environment = await call('POST', `/api/projects/${projectId}/environments`, { name: environmentName });
  expect(environment.statusCode, environment.raw).toBe(201);
  const environmentId = String(environment.body.id);
  serverOctet += 1;
  const server = await call('POST', '/api/servers', {
    name: `srv-${short()}`,
    host: `203.0.113.${serverOctet.toString()}`,
    credential: { type: 'ssh_password', password: 'server-password-never-returned' },
  });
  expect(server.statusCode, server.raw).toBe(201);
  const serverId = String(server.body.id);
  await postgres.db
    .update(servers)
    .set({ status: 'CONNECTED', dockerInstalled: true, dockerBuildkitAvailable: true })
    .where(eq(servers.id, serverId));
  const serviceName = `api-${short()}`;
  const service = await call('POST', `/api/projects/${projectId}/services`, {
    environmentId,
    serverId,
    name: serviceName,
    source: { kind: 'image', imageRef: 'nginx:1.27' },
    internalPort: 80,
  });
  expect(service.statusCode, service.raw).toBe(201);
  const serviceId = String(service.body.id);
  const base = `/api/projects/${projectId}`;
  const scoped = (leaf: string) => ({
    project: `${base}/${leaf}`,
    environment: `${base}/environments/${environmentId}/${leaf}`,
    service: `${base}/services/${serviceId}/${leaf}`,
  });
  return {
    projectId,
    projectName,
    environmentId,
    environmentName,
    serviceId,
    serviceName,
    secretUrls: scoped('secrets'),
    envUrls: scoped('env'),
  };
}

async function seedSecret(owner: SecretOwner, name: string): Promise<void> {
  await createSecret(postgres.db, { owner, name, value: secretValue(canary(), 'app_secret') }, { current: SEED_KEY });
}

async function secretRows(projectId: string): Promise<(typeof secrets.$inferSelect)[]> {
  return postgres.db.select().from(secrets).where(eq(secrets.projectId, projectId));
}

async function variableRows(projectId: string): Promise<(typeof environmentVariables.$inferSelect)[]> {
  return postgres.db.select().from(environmentVariables).where(eq(environmentVariables.projectId, projectId));
}

async function activityFor(ids: readonly string[]): Promise<(typeof activityEvents.$inferSelect)[]> {
  if (ids.length === 0) return [];
  return postgres.db.select().from(activityEvents).where(inArray(activityEvents.entityId, [...ids]));
}

const VIEW_KEYS = ['createdAt', 'hint', 'id', 'name', 'scope', 'updatedAt', 'version'];

beforeAll(async () => {
  postgres = await startPostgres();
  setTestEnv(postgres.connectionString);
  const { buildApp } = await import('../../../apps/control-plane/src/app.js');
  const { createLogger, writableForTests } = await import('../../../apps/control-plane/src/logger.js');
  const capture = writableForTests();
  logs = capture.records;
  app = buildApp({ eventPublisher: events, logger: createLogger({ level: 'debug', destination: capture.stream }) });
  cookie = await signIn();
});

afterAll(async () => {
  await app.close();
  await postgres.stop();
});

describe('create, replace and read at three scopes (A1)', () => {
  it('creates value-free views, bumps the version on replace, and never returns the value', async () => {
    const fx = await newFixture();
    const values: string[] = [];
    for (const scope of ['project', 'environment', 'service'] as const) {
      const url = fx.secretUrls[scope];
      const value = canary();
      values.push(value);
      const created = await call('POST', url, { name: 'api_key', value });
      expect(created.statusCode, created.raw).toBe(201);
      expect(Object.keys(created.body).sort()).toEqual(VIEW_KEYS);
      expect(created.body).toMatchObject({ name: 'api_key', scope, version: 1, hint: value.slice(-4) });
      expect(created.raw).not.toContain(value);
      const id = String(created.body.id);

      const duplicate = await call('POST', url, { name: 'api_key', value: canary() });
      expect(duplicate.statusCode, duplicate.raw).toBe(409);
      expect(duplicate.body.error).toBe('SECRET_NAME_DUPLICATE');

      const next = canary();
      values.push(next);
      const replaced = await call('PUT', `${url}/${id}`, { value: next });
      expect(replaced.statusCode, replaced.raw).toBe(200);
      expect(replaced.body).toMatchObject({ id, name: 'api_key', scope, version: 2, hint: next.slice(-4) });
      expect(replaced.raw).not.toContain(next);

      const shortValue = await call('PUT', `${url}/${id}`, { value: 'tiny' });
      expect(shortValue.body).toMatchObject({ version: 3, hint: '' });

      const read = await call('GET', `${url}/${id}`);
      expect(read.statusCode, read.raw).toBe(200);
      expect(Object.keys(read.body).sort()).toEqual(VIEW_KEYS);
      expect(read.body).toMatchObject({ id, version: 3 });

      const list = await call('GET', url);
      expect(list.statusCode, list.raw).toBe(200);
      const items = list.body.items as Json[];
      expect(items.map((item) => item.id)).toEqual([id]);
      expect(Object.keys(items[0] ?? {}).sort()).toEqual(VIEW_KEYS);

      for (const leaf of ['value', 'reveal', 'plaintext']) {
        expect((await call('GET', `${url}/${id}/${leaf}`)).statusCode).toBe(404);
        expect((await call('POST', `${url}/${id}/${leaf}`, {})).statusCode).toBe(404);
      }
      for (const response of [read, list]) for (const v of values) expect(response.raw).not.toContain(v);
    }

    const rows = await secretRows(fx.projectId);
    expect(rows).toHaveLength(3);
    for (const row of rows) for (const v of values) expect(JSON.stringify(row)).not.toContain(v);
  });

  it('rejects multi-line, empty, non-string, over-long and over-the-limit values', async () => {
    const fx = await newFixture();
    const url = fx.secretUrls.project;
    const multiline = await call('POST', url, { name: 'multi', value: 'a\nb' });
    expect(multiline.statusCode, multiline.raw).toBe(422);
    expect(multiline.body.error).toBe('ENV_VALUE_MULTILINE');
    const empty = await call('POST', url, { name: 'empty', value: '' });
    expect(empty.statusCode, empty.raw).toBe(422);
    expect(empty.body.error).toBe('ENV_INPUT_INVALID');
    expect((await call('POST', url, { name: 'num', value: 42 })).statusCode).toBe(400);
    expect((await call('POST', url, { name: 'obj', value: { nested: 'x' } })).statusCode).toBe(400);
    expect((await call('POST', url, { name: 'extra', value: 'x', scope: 'service' })).statusCode).toBe(400);
    const bytes = await call('POST', url, { name: 'wide', value: 'é'.repeat(40_000) });
    expect(bytes.statusCode, bytes.raw).toBe(422);
    expect((await call('POST', url, { name: 'long', value: 'x'.repeat(64 * 1024 + 1) })).statusCode).toBe(400);
    expect((await call('POST', url, { name: 'max', value: 'x'.repeat(64 * 1024) })).statusCode).toBe(201);
    expect(await secretRows(fx.projectId)).toHaveLength(1);

    const owner: SecretOwner = { scope: 'environment', projectId: fx.projectId, environmentId: fx.environmentId };
    for (let i = 1; i < 100; i += 1) await seedSecret(owner, `fill_${i.toString()}`);
    expect((await call('POST', fx.secretUrls.environment, { name: 'last', value: 'x' })).statusCode).toBe(201);
    const limit = await call('POST', fx.secretUrls.environment, { name: 'over', value: 'x' });
    expect(limit.statusCode, limit.raw).toBe(422);
    expect(limit.body.error).toBe('SECRET_LIMIT_REACHED');
    // the limit is per owner: the project scope still accepts
    expect((await call('POST', url, { name: 'other', value: 'x' })).statusCode).toBe(201);
  });

  it('answers 404 for a secret of another owner or project', async () => {
    const a = await newFixture();
    const b = await newFixture();
    const created = await call('POST', a.secretUrls.service, { name: 'token', value: canary() });
    const id = String(created.body.id);
    expect((await call('GET', `${b.secretUrls.service}/${id}`)).statusCode).toBe(404);
    expect((await call('GET', `${a.secretUrls.project}/${id}`)).statusCode).toBe(404);
    expect((await call('PUT', `${a.secretUrls.environment}/${id}`, { value: 'x' })).statusCode).toBe(404);
    expect((await call('DELETE', `${b.secretUrls.service}/${id}`)).statusCode).toBe(404);
    expect((await call('GET', `/api/projects/${randomUUID()}/secrets`)).statusCode).toBe(404);
    expect(await secretRows(a.projectId)).toHaveLength(1);
  });
});

describe('delete with the in-use guard (A2)', () => {
  it('refuses while a resolving variable references the secret, then deletes and records name and scope only', async () => {
    const fx = await newFixture();
    const project = await call('POST', fx.secretUrls.project, { name: 'db_url', value: canary() });
    const projectSecretId = String(project.body.id);
    const service = await call('POST', fx.secretUrls.service, { name: 'db_url', value: canary() });
    const serviceSecretId = String(service.body.id);

    const envVar = await call('POST', fx.envUrls.environment, { key: 'DB', value: '<secret:db_url>' });
    expect(envVar.statusCode, envVar.raw).toBe(201);
    const svcVar = await call('POST', fx.envUrls.service, { key: 'DATABASE_URL', value: '<secret:db_url>' });
    expect(svcVar.statusCode, svcVar.raw).toBe(201);

    // DATABASE_URL resolves to the service secret (shadowing); DB is read both in its own
    // environment (nearest: the project secret) and by the service (nearest: the service secret)
    const refused = await call('DELETE', `${fx.secretUrls.project}/${projectSecretId}`);
    expect(refused.statusCode, refused.raw).toBe(409);
    expect(refused.body).toMatchObject({ error: 'SECRET_IN_USE', usedBy: [{ scope: 'environment', key: 'DB' }] });

    const refusedService = await call('DELETE', `${fx.secretUrls.service}/${serviceSecretId}`);
    expect(refusedService.statusCode, refusedService.raw).toBe(409);
    expect(refusedService.body.usedBy).toEqual([
      { scope: 'environment', key: 'DB' },
      { scope: 'service', key: 'DATABASE_URL' },
    ]);
    expect(await secretRows(fx.projectId)).toHaveLength(2);

    expect((await call('DELETE', `${fx.envUrls.environment}/${String(envVar.body.id)}`)).statusCode).toBe(204);
    const deleted = await call('DELETE', `${fx.secretUrls.project}/${projectSecretId}`);
    expect(deleted.statusCode, deleted.raw).toBe(204);
    expect((await call('GET', `${fx.secretUrls.project}/${projectSecretId}`)).statusCode).toBe(404);
    expect((await secretRows(fx.projectId)).map((row) => row.id)).toEqual([serviceSecretId]);

    const activity = await activityFor([projectSecretId]);
    expect(activity.map((row) => row.action).sort()).toEqual(['secret.created', 'secret.deleted']);
    for (const row of activity) {
      expect(row.entityType).toBe('secret');
      expect(row.metadata).toEqual({ scope: 'project', name: 'db_url' });
    }
  });
});

describe('cascade on delete (A3)', () => {
  it('deleting an environment or a project removes its scoped secrets and variables', async () => {
    const fx = await newFixture();
    // a service blocks the environment delete; drop the row (the service-level cascade is
    // proven through the API in services-api.test.ts)
    await postgres.db.delete(services).where(eq(services.id, fx.serviceId));

    await call('POST', fx.secretUrls.project, { name: 'p_secret', value: canary() });
    await call('POST', fx.secretUrls.environment, { name: 'e_secret', value: canary() });
    await call('POST', fx.envUrls.project, { key: 'P', value: '1' });
    await call('POST', fx.envUrls.environment, { key: 'E', value: '<secret:e_secret>' });
    expect(await secretRows(fx.projectId)).toHaveLength(2);
    expect(await variableRows(fx.projectId)).toHaveLength(2);

    const envDeleted = await call('DELETE', `/api/projects/${fx.projectId}/environments/${fx.environmentId}`, {
      confirmName: fx.environmentName,
    });
    expect(envDeleted.statusCode, envDeleted.raw).toBe(200);
    expect((await secretRows(fx.projectId)).map((row) => row.name)).toEqual(['p_secret']);
    expect((await variableRows(fx.projectId)).map((row) => row.key)).toEqual(['P']);

    expect((await call('POST', `/api/projects/${fx.projectId}/archive`)).statusCode).toBe(200);
    const projectDeleted = await call('DELETE', `/api/projects/${fx.projectId}`, { confirmName: fx.projectName });
    expect(projectDeleted.statusCode, projectDeleted.raw).toBe(200);
    expect(await secretRows(fx.projectId)).toEqual([]);
    expect(await variableRows(fx.projectId)).toEqual([]);
  });
});

describe('hardening (H1)', () => {
  it('a canary value through create, replace and delete error paths never reaches HTTP errors, activity or logs', async () => {
    const fx = await newFixture();
    const value = canary();
    const url = fx.secretUrls.service;
    const created = await call('POST', url, { name: 'token', value });
    const id = String(created.body.id);
    await call('POST', fx.envUrls.service, { key: 'TOKEN', value: '<secret:token>' });
    const owner: SecretOwner = { scope: 'project', projectId: fx.projectId };
    for (let i = 0; i < 100; i += 1) await seedSecret(owner, `fill_${i.toString()}`);

    const failures = [
      await call('POST', url, { name: 'token', value }),
      await call('POST', url, { name: 'multi', value: `${value}\n${value}` }),
      await call('POST', url, { name: 'nul', value: `${value}\u0000` }),
      await call('POST', url, { name: 'Bad Name!', value }),
      await call('POST', url, { name: 'extra', value, extra: value }),
      await call('POST', url, { name: 'wrapped', value: [value] }),
      await call('POST', url, { name: 'wide', value: `${value}${'é'.repeat(40_000)}` }),
      await call('POST', url, { name: 'long', value: `${value}${'x'.repeat(64 * 1024)}` }),
      await call('POST', fx.secretUrls.project, { name: 'limit', value }),
      await call('POST', `/api/projects/${randomUUID()}/secrets`, { name: 'gone', value }),
      await call('PUT', `${url}/${id}`, { value: `${value}\r` }),
      await call('PUT', `${url}/${id}`, { value, name: 'other' }),
      await call('PUT', `${url}/${randomUUID()}`, { value }),
      await call('PUT', `${fx.secretUrls.project}/${id}`, { value }),
      await call('DELETE', `${url}/${id}`),
      await call('DELETE', `${url}/${randomUUID()}`),
    ];
    for (const failure of failures) {
      expect(failure.statusCode, failure.raw).toBeGreaterThanOrEqual(400);
      expect(failure.statusCode).toBeLessThan(500);
      expect(failure.raw).not.toContain(value);
    }

    const huge = await app.inject({
      method: 'POST',
      url,
      headers: { cookie, origin: `https://${PUBLIC_HOST}`, 'content-type': 'application/json' },
      payload: JSON.stringify({ name: 'huge', value: `${value}${'x'.repeat(600_000)}` }),
    });
    expect(huge.statusCode).toBe(413);
    expect(huge.body).not.toContain(value);

    const [row] = await postgres.db.select().from(secrets).where(eq(secrets.id, id));
    expect(row?.version).toBe(1);
    expect(JSON.stringify(row)).not.toContain(value);
    const activity = await postgres.db.select().from(activityEvents).where(eq(activityEvents.entityType, 'secret'));
    expect(activity.length).toBeGreaterThan(0);
    for (const entry of activity) expect(JSON.stringify(entry)).not.toContain(value);
    expect(JSON.stringify(logs())).not.toContain(value);
  });
});
