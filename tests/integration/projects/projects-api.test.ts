import { randomUUID } from 'node:crypto';
import { eq, inArray } from 'drizzle-orm';
import parseSetCookie from 'set-cookie-parser';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { revealSecret } from '@noodara/domain/security';
import { activityEvents } from '../../../apps/control-plane/src/db/schema/activity-events.js';
import { credentials } from '../../../apps/control-plane/src/db/schema/credentials.js';
import { deploymentLogChunks } from '../../../apps/control-plane/src/db/schema/deployment-log-chunks.js';
import { deployments } from '../../../apps/control-plane/src/db/schema/deployments.js';
import { environments } from '../../../apps/control-plane/src/db/schema/environments.js';
import { servers } from '../../../apps/control-plane/src/db/schema/servers.js';
import { services } from '../../../apps/control-plane/src/db/schema/services.js';
import { issueToken } from '../../../apps/control-plane/src/services/setup-token-repository.js';
import { startTestApp, type TestAppFixture } from '../helpers/app.js';

// 12-07: `/api/projects` and its environments against the real HTTP surface, a migrated Postgres
// and an authenticated admin. One app per file; every test uses its own unique names.

const ADMIN_EMAIL = 'admin@noodara.test';
const ADMIN_PASSWORD = 'correct horse battery staple';
const FOREIGN_ORIGIN = 'https://evil.example';

let fixture: TestAppFixture;
let cookie: string;

type App = TestAppFixture['app'];
type Json = Record<string, unknown>;

function unique(prefix: string): string {
  return `${prefix} ${randomUUID().replace(/-/g, '').slice(0, 10)}`;
}

function cookieHeaderFrom(response: { headers: Record<string, unknown> }): string {
  const raw = response.headers['set-cookie'];
  const rawCookies = Array.isArray(raw) ? raw : raw !== undefined ? [String(raw)] : [];
  const parsed = parseSetCookie.parse(rawCookies, { map: false });
  return parsed.map((entry) => `${entry.name}=${entry.value}`).join('; ');
}

async function createAdminAndSignIn(app: App, db: TestAppFixture['db']): Promise<string> {
  const issued = await issueToken(db, 'setup', new Date());
  const setup = await app.inject({
    method: 'POST',
    url: '/api/setup',
    payload: { token: revealSecret(issued.token), email: ADMIN_EMAIL, password: ADMIN_PASSWORD, name: 'Admin' },
  });
  if (setup.statusCode !== 200) throw new Error(`setup failed: ${setup.statusCode.toString()}`);
  const signIn = await app.inject({
    method: 'POST',
    url: '/api/auth/sign-in/email',
    payload: { email: ADMIN_EMAIL, password: ADMIN_PASSWORD },
  });
  if (signIn.statusCode !== 200) throw new Error(`sign-in failed: ${signIn.statusCode.toString()}`);
  return cookieHeaderFrom(signIn);
}

async function call(
  method: 'GET' | 'POST' | 'PATCH' | 'DELETE',
  url: string,
  payload?: Json,
): Promise<{ statusCode: number; body: Json }> {
  const response = await fixture.app.inject({
    method,
    url,
    headers: { cookie },
    ...(payload !== undefined ? { payload } : {}),
  });
  return { statusCode: response.statusCode, body: response.json() as Json };
}

async function createProject(name: string, description?: string): Promise<Json> {
  const { statusCode, body } = await call('POST', '/api/projects', {
    name,
    ...(description !== undefined ? { description } : {}),
  });
  expect(statusCode, JSON.stringify(body)).toBe(201);
  return body;
}

async function createEnvironment(projectId: string, name: string, kind?: string): Promise<Json> {
  const { statusCode, body } = await call('POST', `/api/projects/${projectId}/environments`, {
    name,
    ...(kind !== undefined ? { kind } : {}),
  });
  expect(statusCode, JSON.stringify(body)).toBe(201);
  return body;
}

async function actionsFor(entityId: string): Promise<{ action: string; actorType: string; actorId: string | null }[]> {
  return fixture.db
    .select({ action: activityEvents.action, actorType: activityEvents.actorType, actorId: activityEvents.actorId })
    .from(activityEvents)
    .where(eq(activityEvents.entityId, entityId))
    .orderBy(activityEvents.occurredAt, activityEvents.id);
}

beforeAll(async () => {
  fixture = await startTestApp();
  cookie = await createAdminAndSignIn(fixture.app, fixture.db);
});

afterAll(async () => {
  await fixture.stop();
});

describe('projects (A1)', () => {
  it('creates, reads, lists and edits a project with a derived slug', async () => {
    const name = unique('My Shop');
    const created = await createProject(name, 'Storefront');
    expect(created).toStrictEqual({
      id: expect.any(String),
      name,
      slug: name.toLowerCase().replace(/ /g, '-'),
      description: 'Storefront',
      archivedAt: null,
      createdAt: expect.any(String),
      updatedAt: expect.any(String),
    });
    const id = String(created.id);

    const read = await call('GET', `/api/projects/${id}`);
    expect(read.statusCode).toBe(200);
    expect(read.body).toStrictEqual(created);

    const list = await call('GET', '/api/projects');
    expect(list.statusCode).toBe(200);
    expect((list.body.items as Json[]).map((item) => item.id)).toContain(id);

    const renamed = unique('Renamed');
    const edited = await call('PATCH', `/api/projects/${id}`, { name: renamed, description: null });
    expect(edited.statusCode).toBe(200);
    expect(edited.body).toMatchObject({ id, name: renamed, description: null, slug: created.slug });
  });

  it('gives a second name with the same slug a numbered slug', async () => {
    const base = unique('Slug Twin');
    const first = await createProject(base);
    const second = await createProject(base.replace(' ', '-'));
    expect(second.slug).toBe(`${String(first.slug)}-2`);
  });

  it('rejects a case-insensitive duplicate name on create and on edit with a named 409', async () => {
    const name = unique('Dupe');
    await createProject(name);

    const duplicate = await call('POST', '/api/projects', { name: name.toUpperCase() });
    expect(duplicate.statusCode).toBe(409);
    expect(duplicate.body).toStrictEqual({ error: 'PROJECT_NAME_TAKEN', message: expect.any(String) });

    const other = await createProject(unique('Other'));
    const rename = await call('PATCH', `/api/projects/${String(other.id)}`, { name: name.toLowerCase() });
    expect(rename.statusCode).toBe(409);
    expect(rename.body.error).toBe('PROJECT_NAME_TAKEN');
  });

  it('returns 404 for an unknown project id and 400 for a malformed one', async () => {
    const missing = await call('GET', `/api/projects/${randomUUID()}`);
    expect(missing.statusCode).toBe(404);
    expect(missing.body.error).toBe('NOT_FOUND');

    const malformed = await call('GET', '/api/projects/not-a-uuid');
    expect(malformed.statusCode).toBe(400);
    expect(malformed.body.error).toBe('VALIDATION_FAILED');
  });
});

describe('environments (A1, A3)', () => {
  it('creates, lists, reads and edits environments, unique per project', async () => {
    const project = await createProject(unique('Env Host'));
    const projectId = String(project.id);

    const production = await createEnvironment(projectId, 'production');
    expect(production).toStrictEqual({
      id: expect.any(String),
      projectId,
      name: 'production',
      kind: 'production',
      createdAt: expect.any(String),
      updatedAt: expect.any(String),
    });
    const preview = await createEnvironment(projectId, 'pr-42', 'preview');
    expect(preview.kind).toBe('preview');

    const duplicate = await call('POST', `/api/projects/${projectId}/environments`, { name: 'production' });
    expect(duplicate.statusCode).toBe(409);
    expect(duplicate.body).toStrictEqual({ error: 'ENVIRONMENT_NAME_TAKEN', message: expect.any(String) });

    const otherProject = await createProject(unique('Env Other'));
    await createEnvironment(String(otherProject.id), 'production');

    const list = await call('GET', `/api/projects/${projectId}/environments`);
    expect(list.statusCode).toBe(200);
    expect((list.body.items as Json[]).map((item) => item.name).sort()).toStrictEqual(['pr-42', 'production']);

    const read = await call('GET', `/api/projects/${projectId}/environments/${String(production.id)}`);
    expect(read.body).toStrictEqual(production);

    const renamed = await call('PATCH', `/api/projects/${projectId}/environments/${String(preview.id)}`, {
      name: 'pr-43',
    });
    expect(renamed.statusCode).toBe(200);
    expect(renamed.body).toMatchObject({ name: 'pr-43', kind: 'preview' });

    const clash = await call('PATCH', `/api/projects/${projectId}/environments/${String(preview.id)}`, {
      name: 'production',
    });
    expect(clash.statusCode).toBe(409);
    expect(clash.body.error).toBe('ENVIRONMENT_NAME_TAKEN');

    const invalid = await call('POST', `/api/projects/${projectId}/environments`, { name: 'Not A Slug' });
    expect(invalid.statusCode).toBe(400);
    expect(invalid.body.error).toBe('VALIDATION_FAILED');
  });

  it('returns 404 for environments of an unknown project', async () => {
    const list = await call('GET', `/api/projects/${randomUUID()}/environments`);
    expect(list.statusCode).toBe(404);
    const create = await call('POST', `/api/projects/${randomUUID()}/environments`, { name: 'production' });
    expect(create.statusCode).toBe(404);
  });

  it("answers another project's environment id exactly like a missing one (A3)", async () => {
    const owner = await createProject(unique('Env Owner'));
    const stranger = await createProject(unique('Env Stranger'));
    const foreign = await createEnvironment(String(owner.id), 'production');
    const strangerPath = `/api/projects/${String(stranger.id)}/environments`;

    const crossRead = await call('GET', `${strangerPath}/${String(foreign.id)}`);
    const missingRead = await call('GET', `${strangerPath}/${randomUUID()}`);
    expect(crossRead.statusCode).toBe(404);
    expect(missingRead.statusCode).toBe(404);
    expect(Object.keys(crossRead.body)).toStrictEqual(Object.keys(missingRead.body));
    expect(crossRead.body.error).toBe('NOT_FOUND');
    expect(JSON.stringify(crossRead.body)).not.toContain(String(owner.id));

    const crossEdit = await call('PATCH', `${strangerPath}/${String(foreign.id)}`, { name: 'hijacked' });
    expect(crossEdit.statusCode).toBe(404);

    const untouched = await call('GET', `/api/projects/${String(owner.id)}/environments/${String(foreign.id)}`);
    expect(untouched.body.name).toBe('production');
  });
});

describe('archive and delete (A2)', () => {
  it('archives, unarchives and only deletes an archived project by its exact name', async () => {
    const name = unique('Doomed');
    const project = await createProject(name);
    const id = String(project.id);

    const notArchived = await call('DELETE', `/api/projects/${id}`, { confirmName: name });
    expect(notArchived.statusCode).toBe(422);
    expect(notArchived.body).toStrictEqual({ error: 'PROJECT_NOT_ARCHIVED', message: expect.any(String) });

    const archived = await call('POST', `/api/projects/${id}/archive`);
    expect(archived.statusCode).toBe(200);
    expect(archived.body.archivedAt).toEqual(expect.any(String));

    const unarchived = await call('POST', `/api/projects/${id}/unarchive`);
    expect(unarchived.statusCode).toBe(200);
    expect(unarchived.body.archivedAt).toBeNull();

    await call('POST', `/api/projects/${id}/archive`);
    for (const wrong of [name.toUpperCase(), ` ${name}`, '']) {
      const mismatch = await call('DELETE', `/api/projects/${id}`, { confirmName: wrong });
      expect(mismatch.statusCode).toBe(422);
      expect(mismatch.body).toStrictEqual({ error: 'DELETE_CONFIRMATION_MISMATCH', message: expect.any(String) });
    }

    const deleted = await call('DELETE', `/api/projects/${id}`, { confirmName: name });
    expect(deleted.statusCode).toBe(200);
    expect(deleted.body).toStrictEqual({ ok: true, projectId: id });
    expect((await call('GET', `/api/projects/${id}`)).statusCode).toBe(404);
    expect((await call('DELETE', `/api/projects/${id}`, { confirmName: name })).statusCode).toBe(404);
  });

  it('cascades environments, services, deployments, log chunks and service credentials', async () => {
    const name = unique('Cascade');
    const project = await createProject(name);
    const projectId = String(project.id);
    const environment = await createEnvironment(projectId, 'production');
    const environmentId = String(environment.id);

    const serverResponse = await call('POST', '/api/servers', {
      name: `srv-${randomUUID().slice(0, 8)}`,
      host: `${randomUUID().slice(0, 8)}.example.test`,
      credential: { type: 'ssh_password', password: 'not-used-by-this-test' },
    });
    expect(serverResponse.statusCode).toBe(201);
    const serverId = String(serverResponse.body.id);

    const [repoCredential, registryCredential] = await fixture.db
      .insert(credentials)
      .values([
        { type: 'git_https_token', encryptedValue: 'opaque-test-ciphertext', keyVersion: 1 },
        { type: 'registry_password', encryptedValue: 'opaque-test-ciphertext', keyVersion: 1 },
      ])
      .returning({ id: credentials.id });
    if (!repoCredential || !registryCredential) throw new Error('credential insert failed');

    const serviceRows = await fixture.db
      .insert(services)
      .values([
        {
          projectId,
          environmentId,
          serverId,
          name: 'web',
          sourceType: 'git',
          repositoryUrl: 'https://git.example.test/app.git',
          branch: 'main',
          buildContext: '.',
          dockerfilePath: 'Dockerfile',
          internalPort: 3000,
          repositoryCredentialId: repoCredential.id,
        },
        {
          projectId,
          environmentId,
          serverId,
          name: 'cache',
          sourceType: 'image',
          imageRef: 'registry.example.test/cache:1',
          internalPort: 6379,
          registryCredentialId: registryCredential.id,
        },
      ])
      .returning({ id: services.id });
    const serviceIds = serviceRows.map((row) => row.id);
    const [deployment] = await fixture.db
      .insert(deployments)
      .values({ serviceId: serviceIds[0] ?? '', source: { type: 'git' } })
      .returning({ id: deployments.id });
    if (!deployment) throw new Error('deployment insert failed');
    await fixture.db
      .insert(deploymentLogChunks)
      .values({ deploymentId: deployment.id, phase: 'build', seq: 0, content: 'step 1', byteLength: 6 });

    await call('POST', `/api/projects/${projectId}/archive`);
    const deleted = await call('DELETE', `/api/projects/${projectId}`, { confirmName: name });
    expect(deleted.statusCode, JSON.stringify(deleted.body)).toBe(200);

    const credentialIds = [repoCredential.id, registryCredential.id];
    expect(await fixture.db.select().from(environments).where(eq(environments.id, environmentId))).toHaveLength(0);
    expect(await fixture.db.select().from(services).where(inArray(services.id, serviceIds))).toHaveLength(0);
    expect(await fixture.db.select().from(deployments).where(eq(deployments.id, deployment.id))).toHaveLength(0);
    expect(
      await fixture.db.select().from(deploymentLogChunks).where(eq(deploymentLogChunks.deploymentId, deployment.id)),
    ).toHaveLength(0);
    expect(await fixture.db.select().from(credentials).where(inArray(credentials.id, credentialIds))).toHaveLength(0);
    // The server is not the project's to delete.
    expect(await fixture.db.select().from(servers).where(eq(servers.id, serverId))).toHaveLength(1);
  });
});

describe('activity (A4)', () => {
  it('writes one user-attributed event per mutation and none for a no-op archive', async () => {
    const name = unique('Audited');
    const project = await createProject(name);
    const projectId = String(project.id);
    await call('PATCH', `/api/projects/${projectId}`, { description: 'changed' });
    const environment = await createEnvironment(projectId, 'staging');
    await call('PATCH', `/api/projects/${projectId}/environments/${String(environment.id)}`, { kind: 'preview' });
    await call('POST', `/api/projects/${projectId}/archive`);
    await call('POST', `/api/projects/${projectId}/archive`);
    await call('POST', `/api/projects/${projectId}/unarchive`);
    await call('POST', `/api/projects/${projectId}/archive`);
    await call('DELETE', `/api/projects/${projectId}`, { confirmName: name });

    const projectEvents = await actionsFor(projectId);
    expect(projectEvents.map((event) => event.action)).toStrictEqual([
      'project.created',
      'project.updated',
      'project.archived',
      'project.unarchived',
      'project.archived',
      'project.deleted',
    ]);
    const environmentEvents = await actionsFor(String(environment.id));
    expect(environmentEvents.map((event) => event.action)).toStrictEqual([
      'environment.created',
      'environment.updated',
    ]);
    for (const event of [...projectEvents, ...environmentEvents]) {
      expect(event.actorType).toBe('user');
      expect(event.actorId).toEqual(expect.any(String));
    }
  });
});

describe('hostile input (H1)', () => {
  it('maps malformed JSON, a wrong content type, unknown fields and oversized bodies to 4xx', async () => {
    const canary = 'CANARY-BODY-NEVER-ECHOED';
    const malformed = await fixture.app.inject({
      method: 'POST',
      url: '/api/projects',
      headers: { cookie, 'content-type': 'application/json' },
      payload: `{"name": "${canary}"`,
    });
    expect(malformed.statusCode).toBe(400);
    expect(malformed.json()).toStrictEqual({ error: 'MALFORMED_REQUEST', message: expect.any(String) });
    expect(malformed.body).not.toContain(canary);

    const wrongType = await fixture.app.inject({
      method: 'POST',
      url: '/api/projects',
      headers: { cookie, 'content-type': 'text/xml' },
      payload: `<name>${canary}</name>`,
    });
    expect(wrongType.statusCode).toBe(415);
    expect(wrongType.json()).toStrictEqual({ error: 'UNSUPPORTED_MEDIA_TYPE', message: expect.any(String) });

    const unknownField = await call('POST', '/api/projects', { name: unique('Extra'), owner: 'someone' });
    expect(unknownField.statusCode).toBe(400);
    expect(unknownField.body.error).toBe('VALIDATION_FAILED');

    const unknownEnvField = await call('POST', `/api/projects/${randomUUID()}/environments`, {
      name: 'production',
      replicas: 3,
    });
    expect(unknownEnvField.statusCode).toBe(400);

    const oversized = await call('POST', '/api/projects', { name: unique('Big'), description: 'x'.repeat(32 * 1024) });
    expect(oversized.statusCode).toBe(413);
    expect(oversized.body).toStrictEqual({ error: 'PAYLOAD_TOO_LARGE', message: expect.any(String) });

    const tooLongName = await call('POST', '/api/projects', { name: 'n'.repeat(65) });
    expect(tooLongName.statusCode).toBe(400);

    const stillServing = await call('GET', '/api/projects');
    expect(stillServing.statusCode).toBe(200);
  });

  it('settles a create race on names differing only in case as one 201 and one named 409', async () => {
    const name = unique('Race');
    const results = await Promise.all([
      call('POST', '/api/projects', { name: name.toLowerCase() }),
      call('POST', '/api/projects', { name: name.toUpperCase() }),
    ]);
    const statuses = results.map((result) => result.statusCode).sort();
    expect(statuses).toStrictEqual([201, 409]);
    const loser = results.find((result) => result.statusCode === 409);
    expect(loser?.body).toStrictEqual({ error: 'PROJECT_NAME_TAKEN', message: expect.any(String) });
  });
});

describe('session and origin guards (H2)', () => {
  it('returns the same 401 for an existing and an unknown id without a session', async () => {
    const project = await createProject(unique('Guarded'));
    const environment = await createEnvironment(String(project.id), 'production');
    const existing = `/api/projects/${String(project.id)}`;
    const unknown = `/api/projects/${randomUUID()}`;

    const requests: { method: 'GET' | 'POST' | 'PATCH' | 'DELETE'; url: string; payload?: Json }[] = [
      { method: 'GET', url: '/api/projects' },
      { method: 'POST', url: '/api/projects', payload: { name: unique('Anon') } },
      { method: 'GET', url: existing },
      { method: 'GET', url: unknown },
      { method: 'PATCH', url: existing, payload: { name: 'anon' } },
      { method: 'DELETE', url: existing, payload: { confirmName: 'x' } },
      { method: 'POST', url: `${existing}/archive` },
      { method: 'GET', url: `${existing}/environments` },
      { method: 'GET', url: `${existing}/environments/${String(environment.id)}` },
      { method: 'GET', url: `${unknown}/environments/${randomUUID()}` },
    ];
    const bodies = new Set<string>();
    for (const request of requests) {
      const response = await fixture.app.inject({
        method: request.method,
        url: request.url,
        ...(request.payload !== undefined ? { payload: request.payload } : {}),
      });
      expect(response.statusCode, `${request.method} ${request.url}`).toBe(401);
      bodies.add(response.body);
    }
    expect(bodies.size).toBe(1);
    expect((await call('GET', existing)).body.archivedAt).toBeNull();
  });

  it('rejects a cross-origin mutation with 403 before it touches anything', async () => {
    const name = unique('Origin');
    const project = await createProject(name);
    const id = String(project.id);

    const create = await fixture.app.inject({
      method: 'POST',
      url: '/api/projects',
      headers: { cookie, origin: FOREIGN_ORIGIN },
      payload: { name: unique('Forged') },
    });
    expect(create.statusCode).toBe(403);
    expect(create.json()).toMatchObject({ error: 'FORBIDDEN_ORIGIN' });

    const archive = await fixture.app.inject({
      method: 'POST',
      url: `/api/projects/${id}/archive`,
      headers: { cookie, origin: FOREIGN_ORIGIN },
    });
    expect(archive.statusCode).toBe(403);

    const environment = await fixture.app.inject({
      method: 'POST',
      url: `/api/projects/${id}/environments`,
      headers: { cookie, origin: FOREIGN_ORIGIN },
      payload: { name: 'production' },
    });
    expect(environment.statusCode).toBe(403);

    const after = await call('GET', `/api/projects/${id}`);
    expect(after.body.archivedAt).toBeNull();
    expect((await call('GET', `/api/projects/${id}/environments`)).body.items).toStrictEqual([]);
  });
});
