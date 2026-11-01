import { randomBytes, randomUUID } from 'node:crypto';
import { and, eq, inArray } from 'drizzle-orm';
import parseSetCookie from 'set-cookie-parser';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { revealSecret, secretValue } from '@noodara/domain/security';
import type { buildApp as BuildApp } from '../../../apps/control-plane/src/app.js';
import { activityEvents } from '../../../apps/control-plane/src/db/schema/activity-events.js';
import { deployments } from '../../../apps/control-plane/src/db/schema/deployments.js';
import { environmentVariables } from '../../../apps/control-plane/src/db/schema/environment-variables.js';
import { servers } from '../../../apps/control-plane/src/db/schema/servers.js';
import type { ServerEventPublisher } from '../../../apps/control-plane/src/events/server-event-publisher.js';
import { createSecret, type SecretOwner } from '../../../apps/control-plane/src/secrets/secret-store.js';
import { issueToken } from '../../../apps/control-plane/src/services/setup-token-repository.js';
import { startPostgres, type PostgresFixture } from '../helpers/postgres.js';

// 23-02 (A1-A4, H1, H2): the variables API against the real HTTP surface and a migrated Postgres.
// Secret values and canaries are generated per run; none of them may appear in a response or an
// activity row.

const ADMIN_EMAIL = 'admin@noodara.dev';
const ADMIN_PASSWORD = 'correct horse battery staple';
const PUBLIC_HOST = 'panel.noodara.dev';
const SECRET_KEY = randomBytes(32);
let serverOctet = 10;

type Json = Record<string, unknown>;

let postgres: PostgresFixture;
let app: ReturnType<typeof BuildApp>;
let cookie: string;

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

async function call(
  method: 'GET' | 'POST' | 'PATCH' | 'DELETE',
  url: string,
  payload?: unknown,
): Promise<{ statusCode: number; body: Json; raw: string }> {
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
  readonly serviceId: string | null;
  readonly projectUrl: string;
  readonly environmentUrl: string;
  readonly serviceUrl: string;
}

async function newFixture(withService = true): Promise<Fixture> {
  const projectName = `Env ${short()}`;
  const project = await call('POST', '/api/projects', { name: projectName });
  expect(project.statusCode, project.raw).toBe(201);
  const projectId = String(project.body.id);
  const environmentName = `env-${short()}`;
  const environment = await call('POST', `/api/projects/${projectId}/environments`, { name: environmentName });
  expect(environment.statusCode, environment.raw).toBe(201);
  const environmentId = String(environment.body.id);
  let serviceId: string | null = null;
  if (withService) {
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
    const service = await call('POST', `/api/projects/${projectId}/services`, {
      environmentId,
      serverId,
      name: `api-${short()}`,
      source: { kind: 'image', imageRef: 'nginx:1.27' },
      internalPort: 80,
    });
    expect(service.statusCode, service.raw).toBe(201);
    serviceId = String(service.body.id);
  }
  return {
    projectId,
    projectName,
    environmentId,
    environmentName,
    serviceId,
    projectUrl: `/api/projects/${projectId}/env`,
    environmentUrl: `/api/projects/${projectId}/environments/${environmentId}/env`,
    serviceUrl: `/api/projects/${projectId}/services/${serviceId ?? randomUUID()}/env`,
  };
}

function owners(fx: Fixture): { project: SecretOwner; environment: SecretOwner; service: SecretOwner } {
  if (fx.serviceId === null) throw new Error('fixture has no service');
  return {
    project: { scope: 'project', projectId: fx.projectId },
    environment: { scope: 'environment', projectId: fx.projectId, environmentId: fx.environmentId },
    service: { scope: 'service', projectId: fx.projectId, serviceId: fx.serviceId },
  };
}

async function addSecret(owner: SecretOwner, name: string, raw: string): Promise<void> {
  await createSecret(postgres.db, { owner, name, value: secretValue(raw, 'app_secret') }, { current: SECRET_KEY });
}

async function activityFor(ids: readonly string[]): Promise<(typeof activityEvents.$inferSelect)[]> {
  if (ids.length === 0) return [];
  return postgres.db.select().from(activityEvents).where(inArray(activityEvents.entityId, [...ids]));
}

const HC = { type: 'container', probeTimeoutS: 5, intervalS: 1, retries: 5, startPeriodS: 0 };

beforeAll(async () => {
  postgres = await startPostgres();
  setTestEnv(postgres.connectionString);
  const { buildApp } = await import('../../../apps/control-plane/src/app.js');
  app = buildApp({ eventPublisher: events });
  cookie = await signIn();
});

afterAll(async () => {
  await app.close();
  await postgres.stop();
});

describe('variables CRUD at three scopes (A1)', () => {
  it('lists, creates, updates and deletes at project, environment and service scope with scope+key activity', async () => {
    const fx = await newFixture();
    const ids: string[] = [];
    for (const [scope, url] of [
      ['project', fx.projectUrl],
      ['environment', fx.environmentUrl],
      ['service', fx.serviceUrl],
    ] as const) {
      const value = canary();
      const created = await call('POST', url, { key: 'API_URL', value });
      expect(created.statusCode, created.raw).toBe(201);
      expect(created.body).toMatchObject({ scope, key: 'API_URL', value });
      const id = String(created.body.id);
      ids.push(id);

      const listed = await call('GET', url);
      expect(listed.statusCode, listed.raw).toBe(200);
      expect((listed.body.items as Json[]).map((item) => item.id)).toEqual([id]);

      const patched = await call('PATCH', `${url}/${id}`, { value: 'https://example.com' });
      expect(patched.statusCode, patched.raw).toBe(200);
      expect(patched.body).toMatchObject({ id, key: 'API_URL', value: 'https://example.com' });
      const sameKey = await call('PATCH', `${url}/${id}`, { key: 'API_URL', value: 'v2' });
      expect(sameKey.statusCode, sameKey.raw).toBe(200);

      const removed = await call('DELETE', `${url}/${id}`);
      expect(removed.statusCode, removed.raw).toBe(204);
      expect((await call('GET', url)).body.items).toEqual([]);
      expect((await call('DELETE', `${url}/${id}`)).statusCode).toBe(404);

      const rows = await activityFor([id]);
      expect(rows.map((row) => row.action).sort()).toEqual(
        ['env.variable_created', 'env.variable_deleted', 'env.variable_updated', 'env.variable_updated'].sort(),
      );
      for (const row of rows) {
        expect(row.entityType).toBe('environment_variable');
        expect(row.metadata).toEqual({ scope, key: 'API_URL' });
        expect(JSON.stringify(row)).not.toContain(value);
      }
    }
  });

  it('409 ENV_KEY_DUPLICATE per owner and exact key; the same key at another scope is fine', async () => {
    const fx = await newFixture();
    expect((await call('POST', fx.projectUrl, { key: 'PORT', value: '1' })).statusCode).toBe(201);
    const dup = await call('POST', fx.projectUrl, { key: 'PORT', value: '2' });
    expect(dup.statusCode, dup.raw).toBe(409);
    expect(dup.body.error).toBe('ENV_KEY_DUPLICATE');
    expect((await call('POST', fx.projectUrl, { key: 'PORT_2', value: '2' })).statusCode).toBe(201);
    expect((await call('POST', fx.environmentUrl, { key: 'PORT', value: '3' })).statusCode).toBe(201);
    expect((await call('POST', fx.serviceUrl, { key: 'PORT', value: '4' })).statusCode).toBe(201);
    const other = await newFixture(false);
    expect((await call('POST', other.projectUrl, { key: 'PORT', value: '1' })).statusCode).toBe(201);
  });

  it('422 ENV_VALUE_MULTILINE, ENV_INPUT_INVALID with a reason, and ENV_LIMIT_REACHED at 200 per scope', async () => {
    const fx = await newFixture();
    const multiline = await call('POST', fx.serviceUrl, { key: 'CERT', value: 'line1\nline2' });
    expect(multiline.statusCode, multiline.raw).toBe(422);
    expect(multiline.body.error).toBe('ENV_VALUE_MULTILINE');
    const badKey = await call('POST', fx.serviceUrl, { key: 'lower_case', value: 'x' });
    expect(badKey.statusCode, badKey.raw).toBe(422);
    expect(badKey.body).toMatchObject({ error: 'ENV_INPUT_INVALID' });
    expect(typeof badKey.body.reason).toBe('string');

    await postgres.db.insert(environmentVariables).values(
      Array.from({ length: 200 }, (_, i) => ({
        scope: 'environment' as const,
        projectId: fx.projectId,
        environmentId: fx.environmentId,
        key: `K_${i.toString()}`,
        value: 'v',
      })),
    );
    const limit = await call('POST', fx.environmentUrl, { key: 'ONE_MORE', value: 'v' });
    expect(limit.statusCode, limit.raw).toBe(422);
    expect(limit.body.error).toBe('ENV_LIMIT_REACHED');
    expect((await call('POST', fx.projectUrl, { key: 'ONE_MORE', value: 'v' })).statusCode).toBe(201);
  });

  it('a foreign or unknown project id is a 404 that looks the same, at every scope', async () => {
    const fx = await newFixture();
    const other = await newFixture(false);
    const created = await call('POST', fx.serviceUrl, { key: 'A', value: '1' });
    const id = String(created.body.id);
    const envCreated = await call('POST', fx.environmentUrl, { key: 'A', value: '1' });
    const envId = String(envCreated.body.id);

    const foreignService = `/api/projects/${other.projectId}/services/${String(fx.serviceId)}/env`;
    const foreignEnvironment = `/api/projects/${other.projectId}/environments/${fx.environmentId}/env`;
    const unknown = `/api/projects/${randomUUID()}/env`;
    const responses = [
      await call('GET', foreignService),
      await call('POST', foreignService, { key: 'B', value: '1' }),
      await call('PATCH', `${foreignService}/${id}`, { value: '2' }),
      await call('DELETE', `${foreignService}/${id}`),
      await call('GET', `${foreignService}/effective`),
      await call('GET', foreignEnvironment),
      await call('PATCH', `${foreignEnvironment}/${envId}`, { value: '2' }),
      await call('GET', unknown),
      await call('POST', unknown, { key: 'B', value: '1' }),
      // a variable id of another owner under the right owner is a 404 too
      await call('PATCH', `${fx.projectUrl}/${id}`, { value: '2' }),
      await call('DELETE', `${fx.environmentUrl}/${id}`),
    ];
    for (const response of responses) expect(response.statusCode, response.raw).toBe(404);
    expect(new Set(responses.map((r) => r.body.error)).size).toBe(1);
    const [row] = await postgres.db.select().from(environmentVariables).where(eq(environmentVariables.id, id));
    expect(row?.value).toBe('1');
  });
});

describe('secret references (A2)', () => {
  it('accepts <secret:name> only when visible from the owner by precedence', async () => {
    const fx = await newFixture();
    const o = owners(fx);
    await addSecret(o.project, 'p_token', canary());
    await addSecret(o.environment, 'e_token', canary());
    await addSecret(o.service, 's_token', canary());

    expect((await call('POST', fx.serviceUrl, { key: 'P', value: '<secret:p_token>' })).statusCode).toBe(201);
    expect((await call('POST', fx.serviceUrl, { key: 'E', value: '<secret:e_token>' })).statusCode).toBe(201);
    expect((await call('POST', fx.serviceUrl, { key: 'S', value: '<secret:s_token>' })).statusCode).toBe(201);
    expect((await call('POST', fx.environmentUrl, { key: 'P', value: '<secret:p_token>' })).statusCode).toBe(201);
    expect((await call('POST', fx.environmentUrl, { key: 'E', value: '<secret:e_token>' })).statusCode).toBe(201);
    expect((await call('POST', fx.projectUrl, { key: 'P', value: '<secret:p_token>' })).statusCode).toBe(201);

    for (const [url, name] of [
      [fx.projectUrl, 'e_token'],
      [fx.projectUrl, 's_token'],
      [fx.environmentUrl, 's_token'],
      [fx.serviceUrl, 'missing_token'],
    ] as const) {
      const refused = await call('POST', url, { key: 'X', value: `<secret:${name}>` });
      expect(refused.statusCode, refused.raw).toBe(422);
      expect(refused.body).toMatchObject({ error: 'SECRET_NOT_FOUND', reference: name });
      expect(String(refused.body.message)).toContain(name);
    }

    // another project's secret of the same name is not visible
    const other = await newFixture();
    await addSecret(owners(other).project, 'other_token', canary());
    const foreign = await call('POST', fx.serviceUrl, { key: 'O', value: '<secret:other_token>' });
    expect(foreign.statusCode, foreign.raw).toBe(422);
    expect(foreign.body.error).toBe('SECRET_NOT_FOUND');
  });
});

describe('effective view (A3)', () => {
  it('returns the resolved env with origins and shadowed definitions, never a secret value', async () => {
    const fx = await newFixture();
    const o = owners(fx);
    const dbValue = canary();
    await addSecret(o.environment, 'db_password', dbValue);
    await call('POST', fx.projectUrl, { key: 'LOG_LEVEL', value: 'info' });
    await call('POST', fx.environmentUrl, { key: 'LOG_LEVEL', value: 'debug' });
    await call('POST', fx.projectUrl, { key: 'REGION', value: 'eu' });
    await call('POST', fx.serviceUrl, { key: 'DB', value: '<secret:db_password>' });

    const effective = await call('GET', `${fx.serviceUrl}/effective`);
    expect(effective.statusCode, effective.raw).toBe(200);
    expect(effective.raw).not.toContain(dbValue);
    const items = effective.body.items as Json[];
    const byKey = new Map(items.map((item) => [item.key, item]));
    expect(byKey.get('LOG_LEVEL')).toEqual({
      key: 'LOG_LEVEL',
      origin: 'environment',
      value: { kind: 'plain', value: 'debug' },
      shadowed: [{ origin: 'project', value: { kind: 'plain', value: 'info' } }],
    });
    expect(byKey.get('REGION')).toMatchObject({ origin: 'project', shadowed: [] });
    expect(byKey.get('DB')).toEqual({
      key: 'DB',
      origin: 'service',
      value: { kind: 'secret_ref', name: 'db_password' },
      shadowed: [],
    });
    // nothing has run yet
    expect(effective.body.differsFromRunning).toBe(false);
  });

  it('differsFromRunning compares with the latest SUCCESS or ROLLED_BACK snapshot', async () => {
    const fx = await newFixture();
    const serviceId = String(fx.serviceId);
    const o = owners(fx);
    await addSecret(o.service, 'api_key', canary());
    await call('POST', fx.serviceUrl, { key: 'A', value: '1' });
    await call('POST', fx.serviceUrl, { key: 'K', value: '<secret:api_key>' });
    const effectiveUrl = `${fx.serviceUrl}/effective`;
    const snapshot = (env: Json[]) => ({
      version: 2,
      imageRef: 'nginx:1.27',
      internalPort: 80,
      publishedPort: null,
      healthcheck: HC,
      env,
    });
    const insertDeployment = async (status: 'SUCCESS' | 'ROLLED_BACK' | 'FAILED', env: Json[], at: Date) => {
      await postgres.db.insert(deployments).values({
        serviceId,
        status,
        source: { kind: 'image', imageRef: 'nginx:1.27' },
        runtimeConfig: snapshot(env) as never,
        createdAt: at,
        startedAt: at,
        completedAt: at,
      });
    };

    const matching = [
      { key: 'A', value: '1' },
      { key: 'K', secretRef: 'api_key', secretVersion: 1 },
    ];
    await insertDeployment('SUCCESS', matching, new Date(Date.now() - 60_000));
    expect((await call('GET', effectiveUrl)).body.differsFromRunning).toBe(false);

    // a newer FAILED deployment is not the running release
    await insertDeployment('FAILED', [], new Date(Date.now() - 30_000));
    expect((await call('GET', effectiveUrl)).body.differsFromRunning).toBe(false);

    // a newer ROLLED_BACK one with an older secret version is
    await insertDeployment(
      'ROLLED_BACK',
      [
        { key: 'A', value: '1' },
        { key: 'K', secretRef: 'api_key', secretVersion: 2 },
      ],
      new Date(Date.now() - 10_000),
    );
    expect((await call('GET', effectiveUrl)).body.differsFromRunning).toBe(true);
    await postgres.db
      .delete(deployments)
      .where(and(eq(deployments.serviceId, serviceId), eq(deployments.status, 'ROLLED_BACK')));
    expect((await call('GET', effectiveUrl)).body.differsFromRunning).toBe(false);

    const variables = (await call('GET', fx.serviceUrl)).body.items as Json[];
    const a = variables.find((v) => v.key === 'A');
    await call('PATCH', `${fx.serviceUrl}/${String(a?.id)}`, { value: '2' });
    expect((await call('GET', effectiveUrl)).body.differsFromRunning).toBe(true);
  });
});

describe('cascade on delete (A4)', () => {
  it('deleting an environment or a project removes its scoped variables', async () => {
    const fx = await newFixture(false);
    await call('POST', fx.projectUrl, { key: 'P', value: '1' });
    await call('POST', fx.environmentUrl, { key: 'E', value: '1' });
    const countFor = async () =>
      (await postgres.db.select().from(environmentVariables).where(eq(environmentVariables.projectId, fx.projectId)))
        .length;
    expect(await countFor()).toBe(2);

    const envDeleted = await call('DELETE', `/api/projects/${fx.projectId}/environments/${fx.environmentId}`, {
      confirmName: fx.environmentName,
    });
    expect(envDeleted.statusCode, envDeleted.raw).toBe(200);
    expect(await countFor()).toBe(1);

    expect((await call('POST', `/api/projects/${fx.projectId}/archive`)).statusCode).toBe(200);
    const projectDeleted = await call('DELETE', `/api/projects/${fx.projectId}`, { confirmName: fx.projectName });
    expect(projectDeleted.statusCode, projectDeleted.raw).toBe(200);
    expect(await countFor()).toBe(0);
  });
});

describe('hardening (H1, H2)', () => {
  it('H1: concurrent creates of one key give one 201 and one 409', async () => {
    const fx = await newFixture();
    for (const url of [fx.projectUrl, fx.environmentUrl, fx.serviceUrl]) {
      const results = await Promise.all([
        call('POST', url, { key: 'RACE', value: 'a' }),
        call('POST', url, { key: 'RACE', value: 'b' }),
      ]);
      expect(results.map((r) => r.statusCode).sort(), JSON.stringify(results.map((r) => r.raw))).toEqual([201, 409]);
      expect(results.find((r) => r.statusCode === 409)?.body.error).toBe('ENV_KEY_DUPLICATE');
    }
  });

  it('H1: a canary value pushed through every error path never reaches HTTP errors or activity', async () => {
    const fx = await newFixture();
    const value = canary();
    const created = await call('POST', fx.serviceUrl, { key: 'TOKEN', value });
    const id = String(created.body.id);
    await postgres.db.insert(environmentVariables).values(
      Array.from({ length: 200 }, (_, i) => ({
        scope: 'project' as const,
        projectId: fx.projectId,
        key: `FILL_${i.toString()}`,
        value: 'v',
      })),
    );

    const failures = [
      await call('POST', fx.serviceUrl, { key: 'TOKEN', value }),
      await call('POST', fx.serviceUrl, { key: 'MULTI', value: `${value}\n${value}` }),
      await call('POST', fx.serviceUrl, { key: `bad-${value}`, value }),
      await call('POST', fx.serviceUrl, { key: 'EXTRA', value, extra: value }),
      await call('POST', fx.projectUrl, { key: 'LIMIT', value }),
      await call('POST', `/api/projects/${randomUUID()}/env`, { key: 'GONE', value }),
      await call('PATCH', `${fx.serviceUrl}/${id}`, { key: 'OTHER', value }),
      await call('PATCH', `${fx.serviceUrl}/${id}`, { value: `${value}\r` }),
      await call('PATCH', `${fx.serviceUrl}/${randomUUID()}`, { value }),
    ];
    for (const failure of failures) {
      expect(failure.statusCode, failure.raw).toBeGreaterThanOrEqual(400);
      expect(failure.statusCode).toBeLessThan(500);
      expect(failure.raw).not.toContain(value);
    }

    const huge = await app.inject({
      method: 'POST',
      url: fx.serviceUrl,
      headers: { cookie, origin: `https://${PUBLIC_HOST}`, 'content-type': 'application/json' },
      payload: JSON.stringify({ key: 'HUGE', value: `${value}${'x'.repeat(400_000)}` }),
    });
    expect(huge.statusCode).toBe(413);
    expect(huge.body).not.toContain(value);
    const tooLong = await call('POST', fx.serviceUrl, { key: 'LONG', value: `${value}${'x'.repeat(40_000)}` });
    expect(tooLong.statusCode).toBeGreaterThanOrEqual(400);
    expect(tooLong.statusCode).toBeLessThan(500);
    expect(tooLong.raw).not.toContain(value);

    const activity = await postgres.db.select().from(activityEvents).where(eq(activityEvents.entityType, 'environment_variable'));
    for (const row of activity) expect(JSON.stringify(row)).not.toContain(value);
  });

  it('H2: update re-validates like create and the key is immutable', async () => {
    const fx = await newFixture();
    const o = owners(fx);
    await addSecret(o.service, 'svc_token', canary());
    const created = await call('POST', fx.serviceUrl, { key: 'TOKEN', value: 'plain' });
    const id = String(created.body.id);
    const url = `${fx.serviceUrl}/${id}`;
    await call('POST', fx.serviceUrl, { key: 'TAKEN', value: 'x' });

    const missing = await call('PATCH', url, { value: '<secret:nope_token>' });
    expect(missing.statusCode, missing.raw).toBe(422);
    expect(missing.body).toMatchObject({ error: 'SECRET_NOT_FOUND', reference: 'nope_token' });

    const toRef = await call('PATCH', url, { value: '<secret:svc_token>' });
    expect(toRef.statusCode, toRef.raw).toBe(200);
    expect(toRef.body.value).toBe('<secret:svc_token>');

    const multiline = await call('PATCH', url, { value: 'a\nb' });
    expect(multiline.statusCode, multiline.raw).toBe(422);
    expect(multiline.body.error).toBe('ENV_VALUE_MULTILINE');

    const back = await call('PATCH', url, { value: 'plain-again' });
    expect(back.statusCode, back.raw).toBe(200);

    for (const key of ['TAKEN', 'RENAMED']) {
      const renamed = await call('PATCH', url, { key, value: 'x' });
      expect(renamed.statusCode, renamed.raw).toBe(422);
      expect(renamed.body).toMatchObject({ error: 'ENV_INPUT_INVALID', reason: 'ENV_KEY_IMMUTABLE' });
    }
    const [row] = await postgres.db.select().from(environmentVariables).where(eq(environmentVariables.id, id));
    expect(row).toMatchObject({ key: 'TOKEN', value: 'plain-again' });
  });
});
