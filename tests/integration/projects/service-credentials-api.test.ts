import { randomBytes, randomUUID } from 'node:crypto';
import { eq, inArray, sql } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import parseSetCookie from 'set-cookie-parser';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { revealSecret } from '@noodara/domain/security';
import { activityEvents } from '../../../apps/control-plane/src/db/schema/activity-events.js';
import { credentials } from '../../../apps/control-plane/src/db/schema/credentials.js';
import { servers } from '../../../apps/control-plane/src/db/schema/servers.js';
import { services } from '../../../apps/control-plane/src/db/schema/services.js';
import type { ServerEvent, ServerEventPublisher } from '../../../apps/control-plane/src/events/server-event-publisher.js';
import { issueToken } from '../../../apps/control-plane/src/services/setup-token-repository.js';
import { startPostgres, type PostgresFixture } from '../helpers/postgres.js';

// 12-09: service credentials (deploy key, HTTPS token, registry password) and the delete-server
// guard against the real HTTP surface and a migrated Postgres. Every secret submitted here is a
// per-run canary; the last case sweeps every response, event, activity row and stored envelope
// for it (SEC).

const ADMIN_EMAIL = 'admin@noodara.test';
const ADMIN_PASSWORD = 'correct horse battery staple';
const RUN = randomBytes(6).toString('hex');
const TOKEN_CANARY = `ghp_CANARYTOKEN${RUN}`;
const PASSWORD_CANARY = `CANARYPASSWORD${RUN}`;

type Json = Record<string, unknown>;

let postgres: PostgresFixture;
let app: FastifyInstance;
let cookie: string;
const published: ServerEvent[] = [];
/** Every raw response body this suite received, for the final canary sweep. */
const responses: string[] = [];

const recorder: ServerEventPublisher = {
  publish(event) {
    published.push(event);
    return Promise.resolve();
  },
};

function setTestEnv(connectionString: string): void {
  process.env.NOODARA_MASTER_KEY = randomBytes(32).toString('base64');
  process.env.BETTER_AUTH_SECRET = `test-fixture-${randomUUID()}-${randomUUID()}`;
  process.env.DATABASE_URL = connectionString;
  process.env.REDIS_URL = 'redis://localhost:6379';
  process.env.NOODARA_PUBLIC_URL = 'http://localhost:3000';
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
  method: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE',
  url: string,
  payload?: unknown,
): Promise<{ statusCode: number; body: Json; raw: string }> {
  const response = await app.inject({
    method,
    url,
    headers: { cookie },
    ...(payload !== undefined ? { payload: payload as Json } : {}),
  });
  responses.push(response.body);
  return { statusCode: response.statusCode, body: response.json() as Json, raw: response.body };
}

/** A raw body (malformed or oversized), sent as JSON. */
async function callRaw(method: 'PUT', url: string, payload: string): Promise<{ statusCode: number; raw: string }> {
  const response = await app.inject({
    method,
    url,
    headers: { cookie, 'content-type': 'application/json' },
    payload,
  });
  responses.push(response.body);
  return { statusCode: response.statusCode, raw: response.body };
}

function short(): string {
  return randomUUID().replace(/-/g, '').slice(0, 10);
}

const SSH_REPO = 'git@github.com:acme/api.git';
const HTTPS_REPO = 'https://github.com/acme/api.git';
const PRIVATE_IMAGE = 'ghcr.io/acme/api:1.0';

interface Fixture {
  readonly projectId: string;
  readonly environmentId: string;
  readonly serverId: string;
}

async function newFixture(): Promise<Fixture> {
  const project = await call('POST', '/api/projects', { name: `Cred ${short()}` });
  expect(project.statusCode, project.raw).toBe(201);
  const projectId = String(project.body.id);
  const environment = await call('POST', `/api/projects/${projectId}/environments`, { name: 'production' });
  expect(environment.statusCode, environment.raw).toBe(201);
  const server = await call('POST', '/api/servers', {
    name: `srv-${short()}`,
    host: `${short()}.example.test`,
    credential: { type: 'ssh_password', password: 'not-used-by-this-test' },
  });
  expect(server.statusCode, server.raw).toBe(201);
  const serverId = String(server.body.id);
  await postgres.db
    .update(servers)
    .set({ status: 'CONNECTED', dockerInstalled: true, dockerBuildkitAvailable: true })
    .where(eq(servers.id, serverId));
  return { projectId, environmentId: String(environment.body.id), serverId };
}

function gitSource(repositoryUrl: string): Json {
  return { kind: 'git', repositoryUrl, branch: 'main' };
}

function imageSource(imageRef: string): Json {
  return { kind: 'image', imageRef };
}

async function newService(fx: Fixture, source: Json): Promise<string> {
  const response = await call('POST', `/api/projects/${fx.projectId}/services`, {
    environmentId: fx.environmentId,
    serverId: fx.serverId,
    name: `svc-${short()}`,
    source,
    internalPort: 8080,
  });
  expect(response.statusCode, response.raw).toBe(201);
  return String(response.body.id);
}

function credentialsUrl(fx: Fixture, serviceId: string, slot?: 'repository' | 'registry'): string {
  const base = `/api/projects/${fx.projectId}/services/${serviceId}/credentials`;
  return slot === undefined ? base : `${base}/${slot}`;
}

async function credentialIdsOf(serviceId: string): Promise<{ repository: string | null; registry: string | null }> {
  const [row] = await postgres.db
    .select({ repository: services.repositoryCredentialId, registry: services.registryCredentialId })
    .from(services)
    .where(eq(services.id, serviceId));
  if (!row) throw new Error(`service ${serviceId} not found`);
  return row;
}

async function credentialRowsExist(ids: readonly string[]): Promise<number> {
  if (ids.length === 0) return 0;
  const rows = await postgres.db.select({ id: credentials.id }).from(credentials).where(inArray(credentials.id, ids));
  return rows.length;
}

/** Service credential rows that no service points at (A3: must always be zero). */
async function orphanServiceCredentials(): Promise<number> {
  const result = await postgres.db.execute<{ count: number }>(sql`
    SELECT count(*)::int AS count FROM credentials c
    WHERE c.type IN ('git_deploy_key', 'git_https_token', 'registry_password')
      AND NOT EXISTS (
        SELECT 1 FROM services s WHERE s.repository_credential_id = c.id OR s.registry_credential_id = c.id
      )`);
  return Number(result.rows[0]?.count ?? -1);
}

beforeAll(async () => {
  postgres = await startPostgres();
  setTestEnv(postgres.connectionString);
  const { buildApp } = await import('../../../apps/control-plane/src/app.js');
  app = buildApp({ eventPublisher: recorder });
  cookie = await signIn();
});

afterAll(async () => {
  await app.close();
  await postgres.stop();
});

describe('deploy keys (A1, H1)', () => {
  it('generates a distinct ed25519 key per service and returns only the public half', async () => {
    const fx = await newFixture();
    const first = await newService(fx, gitSource(SSH_REPO));
    const second = await newService(fx, gitSource(SSH_REPO));

    const none = await call('GET', credentialsUrl(fx, first));
    expect(none.statusCode).toBe(200);
    expect(none.body).toStrictEqual({ repository: null, registry: null });

    const a = await call('PUT', credentialsUrl(fx, first, 'repository'), { kind: 'deploy_key' });
    const b = await call('PUT', credentialsUrl(fx, second, 'repository'), { kind: 'deploy_key' });
    expect(a.statusCode, a.raw).toBe(200);
    expect(b.statusCode, b.raw).toBe(200);
    const keyA = (a.body.repository as Json).publicKey;
    expect(a.body).toStrictEqual({ repository: { type: 'git_deploy_key', publicKey: expect.stringMatching(/^ssh-ed25519 \S+/) }, registry: null });
    expect((b.body.repository as Json).publicKey).not.toBe(keyA);
    expect(a.raw).not.toMatch(/PRIVATE KEY|encryptedValue|keyVersion/);

    const read = await call('GET', credentialsUrl(fx, first));
    expect(read.body).toStrictEqual(a.body);

    const ids = await credentialIdsOf(first);
    expect(ids.repository).not.toBeNull();
    const [row] = await postgres.db.select().from(credentials).where(eq(credentials.id, String(ids.repository)));
    expect(row?.type).toBe('git_deploy_key');
    expect(row?.publicKey).toBe(keyA);
    expect(row?.encryptedValue).not.toMatch(/PRIVATE KEY|OPENSSH/);

    // Generating again rotates: a new key, and the previous row is gone.
    const rotated = await call('PUT', credentialsUrl(fx, first, 'repository'), { kind: 'deploy_key' });
    expect((rotated.body.repository as Json).publicKey).not.toBe(keyA);
    expect(await credentialRowsExist([String(ids.repository)])).toBe(0);
    expect(await orphanServiceCredentials()).toBe(0);
  });

  it('refuses a credential that does not fit the source with CREDENTIAL_SOURCE_MISMATCH', async () => {
    const fx = await newFixture();
    const https = await newService(fx, gitSource(HTTPS_REPO));
    const ssh = await newService(fx, gitSource(SSH_REPO));
    const image = await newService(fx, imageSource(PRIVATE_IMAGE));

    const keyOnHttps = await call('PUT', credentialsUrl(fx, https, 'repository'), { kind: 'deploy_key' });
    expect(keyOnHttps.statusCode).toBe(409);
    expect(keyOnHttps.body.error).toBe('CREDENTIAL_SOURCE_MISMATCH');

    const tokenOnSsh = await call('PUT', credentialsUrl(fx, ssh, 'repository'), { kind: 'https_token', token: TOKEN_CANARY });
    expect(tokenOnSsh.statusCode).toBe(409);
    expect(tokenOnSsh.raw).not.toContain(TOKEN_CANARY);

    const registryOnGit = await call('PUT', credentialsUrl(fx, ssh, 'registry'), { username: 'acme', password: PASSWORD_CANARY });
    expect(registryOnGit.statusCode).toBe(409);
    const repoOnImage = await call('PUT', credentialsUrl(fx, image, 'repository'), { kind: 'deploy_key' });
    expect(repoOnImage.statusCode).toBe(409);

    const missing = await call('GET', credentialsUrl(fx, randomUUID()));
    expect(missing.statusCode).toBe(404);
    expect(await orphanServiceCredentials()).toBe(0);
  });
});

describe('write-only secrets (A2)', () => {
  it('stores an HTTPS token and a registry password encrypted and exposes only presence and type', async () => {
    const fx = await newFixture();
    const git = await newService(fx, gitSource(HTTPS_REPO));
    const image = await newService(fx, imageSource(PRIVATE_IMAGE));

    const token = await call('PUT', credentialsUrl(fx, git, 'repository'), { kind: 'https_token', token: TOKEN_CANARY });
    expect(token.statusCode, token.raw).toBe(200);
    expect(token.body).toStrictEqual({ repository: { type: 'git_https_token', publicKey: null }, registry: null });

    const registry = await call('PUT', credentialsUrl(fx, image, 'registry'), { username: 'acme-bot', password: PASSWORD_CANARY });
    expect(registry.statusCode, registry.raw).toBe(200);
    expect(registry.body).toStrictEqual({ repository: null, registry: { type: 'registry_password', publicKey: null } });

    const explicitHost = await call('PUT', credentialsUrl(fx, image, 'registry'), {
      host: 'ghcr.io',
      username: 'acme-bot',
      password: PASSWORD_CANARY,
    });
    expect(explicitHost.statusCode, explicitHost.raw).toBe(200);

    for (const serviceId of [git, image]) {
      const read = await call('GET', credentialsUrl(fx, serviceId));
      expect(read.raw).not.toContain(TOKEN_CANARY);
      expect(read.raw).not.toContain(PASSWORD_CANARY);
      const service = await call('GET', `/api/projects/${fx.projectId}/services/${serviceId}`);
      expect(service.raw).not.toMatch(/credential/i);
    }

    const ids = [(await credentialIdsOf(git)).repository, (await credentialIdsOf(image)).registry].map(String);
    const rows = await postgres.db.select().from(credentials).where(inArray(credentials.id, ids));
    expect(rows).toHaveLength(2);
    for (const row of rows) {
      expect(row.encryptedValue).not.toContain(TOKEN_CANARY);
      expect(row.encryptedValue).not.toContain(PASSWORD_CANARY);
      expect(row.publicKey).toBeNull();
    }
    expect(await orphanServiceCredentials()).toBe(0);
  });
});

describe('source changes and deletion (A3)', () => {
  it('rotates a deploy key when the ssh repository moves and removes a token when the repository changes', async () => {
    const fx = await newFixture();
    const ssh = await newService(fx, gitSource(SSH_REPO));
    const https = await newService(fx, gitSource(HTTPS_REPO));
    const key = await call('PUT', credentialsUrl(fx, ssh, 'repository'), { kind: 'deploy_key' });
    await call('PUT', credentialsUrl(fx, https, 'repository'), { kind: 'https_token', token: TOKEN_CANARY });
    const before = { ssh: await credentialIdsOf(ssh), https: await credentialIdsOf(https) };

    const moved = await call('PATCH', `/api/projects/${fx.projectId}/services/${ssh}`, {
      source: gitSource('git@github.com:acme/other.git'),
    });
    expect(moved.statusCode, moved.raw).toBe(200);
    const after = await call('GET', credentialsUrl(fx, ssh));
    expect((after.body.repository as Json).type).toBe('git_deploy_key');
    expect((after.body.repository as Json).publicKey).not.toBe((key.body.repository as Json).publicKey);
    expect(await credentialRowsExist([String(before.ssh.repository)])).toBe(0);
    const activity = await postgres.db
      .select({ metadata: activityEvents.metadata })
      .from(activityEvents)
      .where(eq(activityEvents.entityId, ssh));
    expect(activity.some((event) => (event.metadata as Json).credentialReplaced === true)).toBe(true);

    const retargeted = await call('PATCH', `/api/projects/${fx.projectId}/services/${https}`, {
      source: gitSource('https://gitlab.com/acme/api.git'),
    });
    expect(retargeted.statusCode, retargeted.raw).toBe(200);
    expect((await call('GET', credentialsUrl(fx, https))).body.repository).toBeNull();
    expect(await credentialRowsExist([String(before.https.repository)])).toBe(0);

    // A branch-only edit keeps the credential.
    const ssh2 = await credentialIdsOf(ssh);
    const branch = await call('PATCH', `/api/projects/${fx.projectId}/services/${ssh}`, {
      source: { ...gitSource('git@github.com:acme/other.git'), branch: 'release' },
    });
    expect(branch.statusCode, branch.raw).toBe(200);
    expect((await credentialIdsOf(ssh)).repository).toBe(ssh2.repository);
    expect(await orphanServiceCredentials()).toBe(0);
  });

  it('keeps a registry password within the same registry and removes it when the registry or source kind changes', async () => {
    const fx = await newFixture();
    const image = await newService(fx, imageSource(PRIVATE_IMAGE));
    await call('PUT', credentialsUrl(fx, image, 'registry'), { username: 'acme-bot', password: PASSWORD_CANARY });
    const first = await credentialIdsOf(image);

    const bump = await call('PATCH', `/api/projects/${fx.projectId}/services/${image}`, { source: imageSource('ghcr.io/acme/api:2.0') });
    expect(bump.statusCode, bump.raw).toBe(200);
    expect((await credentialIdsOf(image)).registry).toBe(first.registry);

    const moved = await call('PATCH', `/api/projects/${fx.projectId}/services/${image}`, {
      source: imageSource('registry.example.com/acme/api:2.0'),
    });
    expect(moved.statusCode, moved.raw).toBe(200);
    expect((await credentialIdsOf(image)).registry).toBeNull();
    expect(await credentialRowsExist([String(first.registry)])).toBe(0);

    await call('PUT', credentialsUrl(fx, image, 'registry'), { username: 'acme-bot', password: PASSWORD_CANARY });
    const second = await credentialIdsOf(image);
    const toGit = await call('PATCH', `/api/projects/${fx.projectId}/services/${image}`, { source: gitSource(SSH_REPO) });
    expect(toGit.statusCode, toGit.raw).toBe(200);
    expect(await credentialRowsExist([String(second.registry)])).toBe(0);
    expect(await orphanServiceCredentials()).toBe(0);
  });

  it('removes a credential on DELETE and deletes every credential with the project', async () => {
    const fx = await newFixture();
    const ssh = await newService(fx, gitSource(SSH_REPO));
    const image = await newService(fx, imageSource(PRIVATE_IMAGE));
    await call('PUT', credentialsUrl(fx, ssh, 'repository'), { kind: 'deploy_key' });
    await call('PUT', credentialsUrl(fx, image, 'registry'), { username: 'acme-bot', password: PASSWORD_CANARY });
    const sshIds = await credentialIdsOf(ssh);

    const removed = await call('DELETE', credentialsUrl(fx, ssh, 'repository'));
    expect(removed.statusCode, removed.raw).toBe(200);
    expect(removed.body).toStrictEqual({ repository: null, registry: null });
    expect(await credentialRowsExist([String(sshIds.repository)])).toBe(0);
    const again = await call('DELETE', credentialsUrl(fx, ssh, 'repository'));
    expect(again.statusCode).toBe(200);

    await call('PUT', credentialsUrl(fx, ssh, 'repository'), { kind: 'deploy_key' });
    const remaining = [(await credentialIdsOf(ssh)).repository, (await credentialIdsOf(image)).registry].map(String);
    expect(await credentialRowsExist(remaining)).toBe(2);

    const project = await call('GET', `/api/projects/${fx.projectId}`);
    expect((await call('POST', `/api/projects/${fx.projectId}/archive`)).statusCode).toBe(200);
    const deleted = await call('DELETE', `/api/projects/${fx.projectId}`, { confirmName: String(project.body.name) });
    expect(deleted.statusCode, deleted.raw).toBe(200);
    expect(await credentialRowsExist(remaining)).toBe(0);
    expect(await orphanServiceCredentials()).toBe(0);
  });
});

describe('hostile input (H3)', () => {
  it('validates credential fields server-side without echoing the submitted secret', async () => {
    const fx = await newFixture();
    const git = await newService(fx, gitSource(HTTPS_REPO));
    const image = await newService(fx, imageSource(PRIVATE_IMAGE));
    const repoUrl = credentialsUrl(fx, git, 'repository');
    const registryUrl = credentialsUrl(fx, image, 'registry');

    const long = `${TOKEN_CANARY}${'x'.repeat(1100)}`;
    const tooLong = await call('PUT', repoUrl, { kind: 'https_token', token: long });
    expect(tooLong.statusCode).toBe(422);
    expect(tooLong.body).toMatchObject({ error: 'SERVICE_CREDENTIAL_INVALID', reason: 'HTTPS_TOKEN_TOO_LONG' });
    expect(tooLong.raw).not.toContain(TOKEN_CANARY);

    const spaced = await call('PUT', repoUrl, { kind: 'https_token', token: `${TOKEN_CANARY} x` });
    expect(spaced.statusCode).toBe(422);
    expect(spaced.raw).not.toContain(TOKEN_CANARY);

    const longPassword = await call('PUT', registryUrl, { username: 'acme-bot', password: `${PASSWORD_CANARY}${'p'.repeat(4100)}` });
    expect(longPassword.statusCode).toBe(422);
    expect(longPassword.raw).not.toContain(PASSWORD_CANARY);

    const badUser = await call('PUT', registryUrl, { username: 'bad user;rm', password: PASSWORD_CANARY });
    expect(badUser.statusCode).toBe(422);
    expect(badUser.body.error).toBe('SERVICE_CREDENTIAL_INVALID');
    expect(badUser.raw).not.toContain(PASSWORD_CANARY);

    const wrongHost = await call('PUT', registryUrl, { host: 'evil.example.com', username: 'acme-bot', password: PASSWORD_CANARY });
    expect(wrongHost.statusCode).toBe(422);
    expect(wrongHost.body).toMatchObject({ reason: 'REGISTRY_HOST_MISMATCH' });
    expect(wrongHost.raw).not.toContain(PASSWORD_CANARY);

    const badHost = await call('PUT', registryUrl, { host: 'https://ghcr.io/x', username: 'acme-bot', password: PASSWORD_CANARY });
    expect(badHost.statusCode).toBe(422);

    const stray = await call('PUT', repoUrl, { kind: 'https_token', token: TOKEN_CANARY, extra: TOKEN_CANARY });
    expect(stray.statusCode).toBe(400);
    expect(stray.raw).not.toContain(TOKEN_CANARY);

    const wrongType = await call('PUT', registryUrl, { username: 'acme-bot', password: 12345 });
    expect(wrongType.statusCode).toBe(400);

    const malformed = await callRaw('PUT', repoUrl, `{"kind":"https_token","token":"${TOKEN_CANARY}"`);
    expect(malformed.statusCode).toBe(400);
    expect(JSON.parse(malformed.raw)).toStrictEqual({ error: 'MALFORMED_REQUEST', message: expect.any(String) });
    expect(malformed.raw).not.toContain(TOKEN_CANARY);

    const oversized = await callRaw('PUT', repoUrl, JSON.stringify({ kind: 'https_token', token: `${TOKEN_CANARY}${'y'.repeat(20 * 1024)}` }));
    expect(oversized.statusCode).toBe(413);
    expect(oversized.raw).not.toContain(TOKEN_CANARY);

    expect((await call('GET', credentialsUrl(fx, git))).body).toStrictEqual({ repository: null, registry: null });
    expect(await orphanServiceCredentials()).toBe(0);
  });
});

describe('delete-server guard over HTTP (A4)', () => {
  it('answers 409 SERVER_HAS_SERVICES naming the services on the server', async () => {
    const fx = await newFixture();
    const serviceId = await newService(fx, imageSource('nginx:1.27'));
    const [server] = await postgres.db.select({ name: servers.name }).from(servers).where(eq(servers.id, fx.serverId));
    const [service] = await postgres.db.select({ name: services.name }).from(services).where(eq(services.id, serviceId));

    const response = await call('DELETE', `/api/servers/${fx.serverId}`, { confirmName: String(server?.name) });
    expect(response.statusCode, response.raw).toBe(409);
    expect(response.body).toStrictEqual({
      error: 'SERVER_HAS_SERVICES',
      message: expect.stringContaining(String(service?.name)),
      blockingServices: [{ id: serviceId, name: service?.name, projectId: fx.projectId }],
    });
    expect((await call('GET', `/api/servers/${fx.serverId}`)).statusCode).toBe(200);
  });
});

describe('canary sweep (SEC)', () => {
  it('never lets a submitted token or password reach a response, an event, an activity row or a stored envelope', async () => {
    const haystacks = [
      ...responses,
      JSON.stringify(published),
      JSON.stringify(await postgres.db.select().from(activityEvents)),
      JSON.stringify(await postgres.db.select().from(credentials)),
      JSON.stringify(await postgres.db.select().from(services)),
    ];
    expect(responses.length).toBeGreaterThan(20);
    for (const haystack of haystacks) {
      expect(haystack).not.toContain(TOKEN_CANARY);
      expect(haystack).not.toContain(PASSWORD_CANARY);
    }
  });
});
