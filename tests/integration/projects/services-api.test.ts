import { randomBytes, randomUUID } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import parseSetCookie from 'set-cookie-parser';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createRedactor, revealSecret } from '@noodara/domain/security';
import type { RemoteCommand, SshDeploySession, StreamOptions, StreamResult } from '@noodara/ssh';
import { activityEvents } from '../../../apps/control-plane/src/db/schema/activity-events.js';
import { deployments } from '../../../apps/control-plane/src/db/schema/deployments.js';
import { domains } from '../../../apps/control-plane/src/db/schema/domains.js';
import { servers } from '../../../apps/control-plane/src/db/schema/servers.js';
import { services } from '../../../apps/control-plane/src/db/schema/services.js';
import type { ServerEvent, ServerEventPublisher } from '../../../apps/control-plane/src/events/server-event-publisher.js';
import { SERVICE_VIEW_FIELDS } from '../../../apps/control-plane/src/services/service-view.js';
import { issueToken } from '../../../apps/control-plane/src/services/setup-token-repository.js';
import { startPostgres, type PostgresFixture } from '../helpers/postgres.js';

// 12-08: `/api/projects/:projectId/services` against the real HTTP surface, a migrated Postgres
// and an authenticated admin. The app gets a recording event publisher so `service.updated` is
// observable (A5). Servers are registered through the API and then marked CONNECTED in the
// database, since no SSH host is involved: these routes only read the stored discovery facts.

const ADMIN_EMAIL = 'admin@noodara.test';
const ADMIN_PASSWORD = 'correct horse battery staple';
/** `NOODARA_PUBLIC_URL` below; with the default API port this is the panel's one port. */
const PANEL_PORT = 3000;

type Json = Record<string, unknown>;

let postgres: PostgresFixture;
let app: FastifyInstance;
let cookie: string;
const published: ServerEvent[] = [];

const recorder: ServerEventPublisher = {
  publish(event) {
    published.push(event);
    return Promise.resolve();
  },
};

/** Same environment as helpers/app.ts writes before `app.ts` is first imported (INST-06). */
function setTestEnv(connectionString: string): void {
  process.env.NOODARA_MASTER_KEY = randomBytes(32).toString('base64');
  process.env.BETTER_AUTH_SECRET = `test-fixture-${randomUUID()}-${randomUUID()}`;
  process.env.DATABASE_URL = connectionString;
  process.env.REDIS_URL = 'redis://localhost:6379';
  process.env.NOODARA_PUBLIC_URL = `http://localhost:${PANEL_PORT.toString()}`;
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
): Promise<{ statusCode: number; body: Json }> {
  const response = await app.inject({
    method,
    url,
    headers: { cookie },
    ...(payload !== undefined ? { payload: payload as Json } : {}),
  });
  return { statusCode: response.statusCode, body: response.json() as Json };
}

function short(): string {
  return randomUUID().replace(/-/g, '').slice(0, 10);
}

async function newProject(): Promise<{ projectId: string; environmentId: string }> {
  const project = await call('POST', '/api/projects', { name: `Svc ${short()}` });
  expect(project.statusCode, JSON.stringify(project.body)).toBe(201);
  const projectId = String(project.body.id);
  const environment = await call('POST', `/api/projects/${projectId}/environments`, { name: 'production' });
  expect(environment.statusCode, JSON.stringify(environment.body)).toBe(201);
  return { projectId, environmentId: String(environment.body.id) };
}

interface ServerFacts {
  status?: 'PENDING' | 'CONNECTED';
  dockerInstalled?: boolean | null;
  dockerBuildkitAvailable?: boolean | null;
}

async function newServer(facts: ServerFacts = {}): Promise<string> {
  const response = await call('POST', '/api/servers', {
    name: `srv-${short()}`,
    host: `${short()}.example.test`,
    credential: { type: 'ssh_password', password: 'not-used-by-this-test' },
  });
  expect(response.statusCode, JSON.stringify(response.body)).toBe(201);
  const serverId = String(response.body.id);
  await postgres.db
    .update(servers)
    .set({
      status: facts.status ?? 'CONNECTED',
      dockerInstalled: facts.dockerInstalled === undefined ? true : facts.dockerInstalled,
      dockerBuildkitAvailable: facts.dockerBuildkitAvailable === undefined ? true : facts.dockerBuildkitAvailable,
    })
    .where(eq(servers.id, serverId));
  return serverId;
}

function imageBody(environmentId: string, serverId: string, extra: Json = {}): Json {
  return {
    environmentId,
    name: `web-${short()}`,
    serverId,
    source: { kind: 'image', imageRef: 'nginx:1.27' },
    internalPort: 80,
    ...extra,
  };
}

function gitSource(extra: Json = {}): Json {
  return { kind: 'git', repositoryUrl: 'https://github.com/acme/api.git', branch: 'main', ...extra };
}

async function createService(projectId: string, body: Json): Promise<Json> {
  const response = await call('POST', `/api/projects/${projectId}/services`, body);
  expect(response.statusCode, JSON.stringify(response.body)).toBe(201);
  return response.body;
}

async function activityFor(entityId: string): Promise<{ action: string; actorType: string; metadata: unknown }[]> {
  return postgres.db
    .select({ action: activityEvents.action, actorType: activityEvents.actorType, metadata: activityEvents.metadata })
    .from(activityEvents)
    .where(eq(activityEvents.entityId, entityId))
    .orderBy(activityEvents.occurredAt, activityEvents.id);
}

/**
 * 22-05 A3: a stateful stand-in for the service's server. Like the Docker daemon, `docker network
 * rm` fails with "has active endpoints" while the proxy or the container is still attached, so a
 * delete that removes the network before detaching the proxy leaves `network` true.
 */
class ProxyHost implements SshDeploySession {
  readonly calls: string[] = [];
  routeFile = true;
  routePrev = true;
  proxyAttached = true;
  network = true;
  images = 0;
  workspaces = 0;

  constructor(
    private readonly serviceId: string,
    public container: boolean,
    deployed: number,
  ) {
    this.images = deployed;
    this.workspaces = deployed;
  }

  exec(): Promise<never> {
    return Promise.reject(new Error('unused'));
  }

  close(): Promise<void> {
    return Promise.resolve();
  }

  private psLine(): string {
    return JSON.stringify({
      ID: 'b'.repeat(64),
      Image: `noodara/${this.serviceId}:latest`,
      Names: `noodara-${this.serviceId}`,
      State: 'running',
      Status: 'Up 2 hours',
      Labels: `noodara.managed=true,noodara.service_id=${this.serviceId}`,
      Ports: '',
    });
  }

  private answer(command: RemoteCommand): { exitCode: number; stdout?: string; stderr?: string } {
    switch (command.name) {
      case 'docker.ps':
        return { exitCode: 0, stdout: this.container ? `${this.psLine()}\n` : '' };
      case 'proxy.remove_dynamic':
        this.routeFile = false;
        this.routePrev = false;
        return { exitCode: 0, stdout: 'NOODARA_PROXY_REMOVE ok\n' };
      case 'docker.network_disconnect':
        if (!this.proxyAttached) {
          return { exitCode: 1, stderr: 'Error response from daemon: container noodara-traefik is not connected to network' };
        }
        this.proxyAttached = false;
        return { exitCode: 0 };
      case 'docker.stop':
        return { exitCode: 0 };
      case 'docker.remove':
        this.container = false;
        return { exitCode: 0 };
      case 'docker.network_remove':
        if (this.proxyAttached || this.container) {
          return {
            exitCode: 1,
            stderr: `Error response from daemon: error while removing network: network noodara-net-${this.serviceId} has active endpoints`,
          };
        }
        this.network = false;
        return { exitCode: 0 };
      case 'docker.image_remove':
        this.images = Math.max(0, this.images - 1);
        return { exitCode: 0 };
      case 'fs.remove_deploy_dir':
        this.workspaces = Math.max(0, this.workspaces - 1);
        return { exitCode: 0 };
      default:
        return { exitCode: 127, stderr: `unexpected ${command.name}` };
    }
  }

  stream(command: RemoteCommand, options: StreamOptions): Promise<StreamResult> {
    this.calls.push(command.name);
    const { exitCode, stdout = '', stderr = '' } = this.answer(command);
    let seq = 0;
    if (stdout.length > 0) options.onChunk({ stream: 'stdout', text: stdout, seq: seq++, truncatedLine: false });
    if (stderr.length > 0) options.onChunk({ stream: 'stderr', text: stderr, seq: seq++, truncatedLine: false });
    return Promise.resolve({
      commandName: command.name,
      outcome: 'completed',
      exitCode,
      exitSignal: null,
      durationMs: 1,
      totalBytes: stdout.length + stderr.length,
      truncated: false,
      stdoutTail: stdout,
      stderrTail: stderr,
    });
  }

  remote(): { routeFile: boolean; routePrev: boolean; proxyAttached: boolean; container: boolean; network: boolean } {
    return {
      routeFile: this.routeFile,
      routePrev: this.routePrev,
      proxyAttached: this.proxyAttached,
      container: this.container,
      network: this.network,
    };
  }
}

/** The server the remote cleanup reaches; null answers like an unreachable server. */
let host: ProxyHost | null = null;

function serviceEvents(serviceId: string): ServerEvent[] {
  return published.filter((event) => event.type === 'service.updated' && event.service.id === serviceId);
}

beforeAll(async () => {
  postgres = await startPostgres();
  setTestEnv(postgres.connectionString);
  const { buildApp } = await import('../../../apps/control-plane/src/app.js');
  const serviceOps = await import('../../../apps/control-plane/src/deploy/service-ops.js');
  app = buildApp({
    eventPublisher: recorder,
    serviceRemoteCleanup: serviceOps.createServiceRemoteCleanup({
      connect: () =>
        Promise.resolve(
          host === null
            ? { ok: false as const, code: 'SERVER_UNREACHABLE' as const }
            : { ok: true as const, session: host, close: () => Promise.resolve() },
        ),
      createRedactor,
      limits: serviceOps.DEFAULT_SERVICE_OPS_LIMITS,
    }),
  });
  cookie = await signIn();
});

afterAll(async () => {
  await app.close();
  await postgres.stop();
});

beforeEach(() => {
  published.length = 0;
  host = null;
});

describe('create and read (A1, A3)', () => {
  it('creates an image service with no published port and reads every SVC-05 field back', async () => {
    const { projectId, environmentId } = await newProject();
    const serverId = await newServer();
    const body = imageBody(environmentId, serverId);
    const created = await createService(projectId, body);

    expect(Object.keys(created)).toEqual([...SERVICE_VIEW_FIELDS]);
    expect(created).toMatchObject({
      projectId,
      environmentId,
      serverId,
      name: body.name,
      sourceType: 'image',
      imageRef: 'nginx:1.27',
      repositoryUrl: null,
      internalPort: 80,
      publishedPort: null,
      status: 'NEVER_DEPLOYED',
    });

    const read = await call('GET', `/api/projects/${projectId}/services/${String(created.id)}`);
    expect(read.statusCode).toBe(200);
    expect(read.body).toStrictEqual(created);

    const list = await call('GET', `/api/projects/${projectId}/services`);
    expect(list.statusCode).toBe(200);
    expect(list.body.items).toStrictEqual([created]);
  });

  it('creates a git service with the domain defaults on a server with BuildKit', async () => {
    const { projectId, environmentId } = await newProject();
    const serverId = await newServer({ dockerBuildkitAvailable: true });
    const created = await createService(projectId, { ...imageBody(environmentId, serverId), source: gitSource() });
    expect(created).toMatchObject({
      sourceType: 'git',
      repositoryUrl: 'https://github.com/acme/api.git',
      branch: 'main',
      buildContext: '.',
      dockerfilePath: 'Dockerfile',
      buildTarget: null,
      imageRef: null,
    });
  });

  it.each([
    ['a server that is not connected', { status: 'PENDING' }, 'SERVER_NOT_CONNECTED'],
    ['a server without Docker', { dockerInstalled: false }, 'SERVER_DOCKER_UNAVAILABLE'],
    ['a server whose Docker was never detected', { dockerInstalled: null }, 'SERVER_DOCKER_UNAVAILABLE'],
  ] as const)('refuses an image service on %s', async (_label, facts, code) => {
    const { projectId, environmentId } = await newProject();
    const serverId = await newServer(facts);
    const response = await call('POST', `/api/projects/${projectId}/services`, imageBody(environmentId, serverId));
    expect(response.statusCode).toBe(409);
    expect(response.body.error).toBe(code);
  });

  it.each([
    ['disabled', false, 'SERVER_BUILDKIT_UNAVAILABLE'],
    // 14-31: NULL means discovery predates BuildKit detection, so the API asks to re-run it.
    ['unknown', null, 'SERVER_BUILDKIT_UNKNOWN'],
  ] as const)('refuses a Dockerfile service when BuildKit is %s, but takes an image service (G3)', async (_label, buildkit, code) => {
    const { projectId, environmentId } = await newProject();
    const serverId = await newServer({ dockerBuildkitAvailable: buildkit });
    const git = await call('POST', `/api/projects/${projectId}/services`, {
      ...imageBody(environmentId, serverId),
      source: gitSource(),
    });
    expect(git.statusCode).toBe(409);
    expect(git.body.error).toBe(code);
    await createService(projectId, imageBody(environmentId, serverId));
  });

  it('answers 404 for an unknown server, project or service and refuses a duplicate name', async () => {
    const { projectId, environmentId } = await newProject();
    const serverId = await newServer();
    const unknownServer = await call('POST', `/api/projects/${projectId}/services`, imageBody(environmentId, randomUUID()));
    expect(unknownServer.statusCode).toBe(404);
    const unknownProject = await call('POST', `/api/projects/${randomUUID()}/services`, imageBody(environmentId, serverId));
    expect(unknownProject.statusCode).toBe(404);
    expect((await call('GET', `/api/projects/${randomUUID()}/services`)).statusCode).toBe(404);
    expect((await call('GET', `/api/projects/${projectId}/services/${randomUUID()}`)).statusCode).toBe(404);

    const first = await createService(projectId, imageBody(environmentId, serverId));
    const duplicate = await call('POST', `/api/projects/${projectId}/services`, {
      ...imageBody(environmentId, serverId),
      name: first.name,
    });
    expect(duplicate.statusCode).toBe(409);
    expect(duplicate.body.error).toBe('SERVICE_NAME_TAKEN');
  });

  it('derives status from the latest deployment, never from the cached column alone (A3)', async () => {
    const { projectId, environmentId } = await newProject();
    const serverId = await newServer();
    const created = await createService(projectId, imageBody(environmentId, serverId));
    const serviceId = String(created.id);
    const url = `/api/projects/${projectId}/services/${serviceId}`;

    // The cache still says NEVER_DEPLOYED; an in-flight deployment makes the service DEPLOYING.
    const [deployment] = await postgres.db
      .insert(deployments)
      .values({ serviceId, status: 'BUILDING', source: { kind: 'image', imageRef: 'nginx:1.27' } })
      .returning({ id: deployments.id });
    if (!deployment) throw new Error('deployment insert failed');
    expect((await call('GET', url)).body.status).toBe('DEPLOYING');

    // A cache claiming RUNNING while a deployment is still in flight is not trusted either.
    await postgres.db.update(services).set({ status: 'RUNNING' }).where(eq(services.id, serviceId));
    expect((await call('GET', url)).body.status).toBe('DEPLOYING');

    await postgres.db.update(deployments).set({ status: 'SUCCESS' }).where(eq(deployments.id, deployment.id));
    expect((await call('GET', url)).body.status).toBe('RUNNING');
    const list = await call('GET', `/api/projects/${projectId}/services`);
    expect((list.body.items as Json[])[0]?.status).toBe('RUNNING');
  });
});

describe('published ports (A2)', () => {
  it('is off by default and refuses a port held by another service on the same server', async () => {
    const a = await newProject();
    const b = await newProject();
    const serverId = await newServer();
    const otherServerId = await newServer();

    await createService(a.projectId, imageBody(a.environmentId, serverId, { publishedPort: 8080 }));
    const clash = await call(
      'POST',
      `/api/projects/${b.projectId}/services`,
      imageBody(b.environmentId, serverId, { publishedPort: 8080 }),
    );
    expect(clash.statusCode).toBe(409);
    expect(clash.body.error).toBe('PORT_IN_USE');

    // Same port on another server, and no port at all on the same server, are both fine.
    await createService(b.projectId, imageBody(b.environmentId, otherServerId, { publishedPort: 8080 }));
    const unpublished = await createService(b.projectId, imageBody(b.environmentId, serverId));
    expect(unpublished.publishedPort).toBeNull();
  });

  it("refuses the panel's own port at create and at edit", async () => {
    const { projectId, environmentId } = await newProject();
    const serverId = await newServer();
    const create = await call(
      'POST',
      `/api/projects/${projectId}/services`,
      imageBody(environmentId, serverId, { publishedPort: PANEL_PORT }),
    );
    expect(create.statusCode).toBe(409);
    expect(create.body.error).toBe('PORT_IN_USE');
    expect(String(create.body.message)).toContain('panel');

    const service = await createService(projectId, imageBody(environmentId, serverId));
    const edit = await call('PATCH', `/api/projects/${projectId}/services/${String(service.id)}`, {
      publishedPort: PANEL_PORT,
    });
    expect(edit.statusCode).toBe(409);
    expect(edit.body.error).toBe('PORT_IN_USE');
  });

  it("refuses an edit onto another service's port and frees a port once unpublished", async () => {
    const { projectId, environmentId } = await newProject();
    const serverId = await newServer();
    const holder = await createService(projectId, imageBody(environmentId, serverId, { publishedPort: 9090 }));
    const other = await createService(projectId, imageBody(environmentId, serverId));
    const otherUrl = `/api/projects/${projectId}/services/${String(other.id)}`;

    const clash = await call('PATCH', otherUrl, { publishedPort: 9090 });
    expect(clash.statusCode).toBe(409);
    expect(clash.body.error).toBe('PORT_IN_USE');

    // Re-sending a service's own port is no collision.
    const self = await call('PATCH', `/api/projects/${projectId}/services/${String(holder.id)}`, {
      publishedPort: 9090,
    });
    expect(self.statusCode).toBe(200);

    const unpublish = await call('PATCH', `/api/projects/${projectId}/services/${String(holder.id)}`, {
      publishedPort: null,
    });
    expect(unpublish.statusCode).toBe(200);
    const take = await call('PATCH', otherUrl, { publishedPort: 9090 });
    expect(take.statusCode, JSON.stringify(take.body)).toBe(200);
    expect((take.body.service as Json).publishedPort).toBe(9090);
  });
});

describe('edit (A3, A5)', () => {
  it('flags requiresRedeploy for a source change but not for a rename, and records each edit', async () => {
    const { projectId, environmentId } = await newProject();
    const serverId = await newServer();
    const created = await createService(projectId, imageBody(environmentId, serverId));
    const serviceId = String(created.id);
    const url = `/api/projects/${projectId}/services/${serviceId}`;

    const renamed = await call('PATCH', url, { name: `renamed-${short()}` });
    expect(renamed.statusCode).toBe(200);
    expect(renamed.body).toMatchObject({ requiresRedeploy: false, changedFields: ['name'] });

    const resourced = await call('PATCH', url, { source: gitSource() });
    expect(resourced.statusCode).toBe(200);
    expect(resourced.body).toMatchObject({ requiresRedeploy: true, changedFields: ['source'] });
    expect(resourced.body.service).toMatchObject({ sourceType: 'git', imageRef: null, branch: 'main' });

    const noop = await call('PATCH', url, { source: gitSource() });
    expect(noop.statusCode).toBe(200);
    expect(noop.body).toMatchObject({ requiresRedeploy: false, changedFields: [] });

    expect(await activityFor(serviceId)).toEqual([
      {
        action: 'service.created',
        actorType: 'user',
        metadata: { projectId, environmentId, serverId, name: created.name, sourceType: 'image' },
      },
      { action: 'service.updated', actorType: 'user', metadata: { changedFields: ['name'], requiresRedeploy: false } },
      { action: 'service.updated', actorType: 'user', metadata: { changedFields: ['source'], requiresRedeploy: true } },
    ]);

    // One service.updated per committed create/edit, none for the no-op; each carries the view.
    const events = serviceEvents(serviceId);
    expect(events).toHaveLength(3);
    const last = events.at(-1);
    expect(last?.type === 'service.updated' ? Object.keys(last.service) : []).toEqual([...SERVICE_VIEW_FIELDS]);
  });

  it('refuses switching to a Dockerfile source on a server without BuildKit', async () => {
    const { projectId, environmentId } = await newProject();
    const serverId = await newServer({ dockerBuildkitAvailable: false });
    const created = await createService(projectId, imageBody(environmentId, serverId));
    const response = await call('PATCH', `/api/projects/${projectId}/services/${String(created.id)}`, {
      source: gitSource(),
    });
    expect(response.statusCode).toBe(409);
    expect(response.body.error).toBe('SERVER_BUILDKIT_UNAVAILABLE');
    expect(serviceEvents(String(created.id))).toHaveLength(1);
  });

  it('refuses a rename onto a sibling name', async () => {
    const { projectId, environmentId } = await newProject();
    const serverId = await newServer();
    const first = await createService(projectId, imageBody(environmentId, serverId));
    const second = await createService(projectId, imageBody(environmentId, serverId));
    const response = await call('PATCH', `/api/projects/${projectId}/services/${String(second.id)}`, {
      name: first.name,
    });
    expect(response.statusCode).toBe(409);
    expect(response.body.error).toBe('SERVICE_NAME_TAKEN');
  });
});

describe('cross-project ownership (A4)', () => {
  it("answers another project's service and environment exactly like missing ones", async () => {
    const a = await newProject();
    const b = await newProject();
    const serverId = await newServer();
    const foreign = await createService(b.projectId, imageBody(b.environmentId, serverId));
    const foreignId = String(foreign.id);

    const read = await call('GET', `/api/projects/${a.projectId}/services/${foreignId}`);
    const missing = await call('GET', `/api/projects/${a.projectId}/services/${randomUUID()}`);
    expect(read.statusCode).toBe(404);
    expect(missing.statusCode).toBe(404);

    const edit = await call('PATCH', `/api/projects/${a.projectId}/services/${foreignId}`, { name: 'stolen' });
    expect(edit.statusCode).toBe(404);

    const viaForeignEnvironment = await call(
      'POST',
      `/api/projects/${a.projectId}/services`,
      imageBody(b.environmentId, serverId),
    );
    expect(viaForeignEnvironment.statusCode).toBe(404);

    expect((await call('GET', `/api/projects/${a.projectId}/services`)).body.items).toEqual([]);
    const [row] = await postgres.db.select().from(services).where(eq(services.id, foreignId));
    expect(row?.name).toBe(foreign.name);
    expect(row?.projectId).toBe(b.projectId);
    expect(serviceEvents(foreignId)).toHaveLength(1);
  });
});

describe('hostile input (H1)', () => {
  it('maps malformed JSON, oversized and non-object bodies to explicit 4xx', async () => {
    const { projectId } = await newProject();
    const canary = 'CANARY-BODY-NEVER-ECHOED';
    const malformed = await app.inject({
      method: 'POST',
      url: `/api/projects/${projectId}/services`,
      headers: { cookie, 'content-type': 'application/json' },
      payload: `{"name": "${canary}"`,
    });
    expect(malformed.statusCode).toBe(400);
    expect(malformed.json()).toStrictEqual({ error: 'MALFORMED_REQUEST', message: expect.any(String) });
    expect(malformed.body).not.toContain(canary);

    const oversized = await call('POST', `/api/projects/${projectId}/services`, {
      environmentId: randomUUID(),
      name: 'x'.repeat(32 * 1024),
    });
    expect(oversized.statusCode).toBe(413);
    expect(oversized.body).toStrictEqual({ error: 'PAYLOAD_TOO_LARGE', message: expect.any(String) });

    const notAnObject = await call('POST', `/api/projects/${projectId}/services`, ['api']);
    expect(notAnObject.statusCode).toBe(400);
    const noEnvironment = await call('POST', `/api/projects/${projectId}/services`, { name: 'api' });
    expect(noEnvironment.statusCode).toBe(400);
    expect(noEnvironment.body.error).toBe('VALIDATION_FAILED');
  });

  it('applies the 12-01 validators server-side and names each violation in a 422', async () => {
    const { projectId, environmentId } = await newProject();
    const serverId = await newServer();
    const cases: [Json, string][] = [
      [{ buildArgs: { TOKEN: 'x' } }, 'SERVICE_INPUT_UNSUPPORTED_FIELD'],
      [{ env: { A: 'b' } }, 'SERVICE_INPUT_UNSUPPORTED_FIELD'],
      [{ source: gitSource({ repositoryUrl: 'file:///etc/passwd' }) }, 'REPOSITORY_URL_UNSUPPORTED_SCHEME'],
      [{ source: gitSource({ repositoryUrl: 'ext::sh -c touch% /tmp/pwned' }) }, 'REPOSITORY_URL_CONTAINS_WHITESPACE'],
      [{ source: gitSource({ buildContext: '../../etc' }) }, 'BUILD_CONTEXT_PATH_INVALID'],
      [{ publishedPort: 22 }, 'PUBLISHED_PORT_RESERVED'],
      [{ publishedPort: 2375 }, 'PUBLISHED_PORT_RESERVED'],
      [{ name: 'Not A Slug' }, 'SERVICE_NAME_INVALID'],
    ];
    for (const [extra, reason] of cases) {
      const response = await call('POST', `/api/projects/${projectId}/services`, {
        ...imageBody(environmentId, serverId),
        ...extra,
      });
      expect(response.statusCode, JSON.stringify(extra)).toBe(422);
      expect(response.body).toStrictEqual({ error: 'SERVICE_INPUT_INVALID', message: expect.any(String), reason });
    }

    const service = await createService(projectId, imageBody(environmentId, serverId));
    const url = `/api/projects/${projectId}/services/${String(service.id)}`;
    const move = await call('PATCH', url, { serverId: await newServer() });
    expect(move.statusCode).toBe(422);
    expect(move.body.reason).toBe('SERVICE_INPUT_UNSUPPORTED_FIELD');
    const badBranch = await call('PATCH', url, { source: gitSource({ branch: '--upload-pack=evil' }) });
    expect(badBranch.statusCode).toBe(422);
    const empty = await call('PATCH', url, {});
    expect(empty.statusCode).toBe(422);
    expect(empty.body.reason).toBe('SERVICE_INPUT_EMPTY_EDIT');

    const [row] = await postgres.db.select().from(services).where(eq(services.id, String(service.id)));
    expect(row?.serverId).toBe(serverId);
    expect(row?.sourceType).toBe('image');
  });

  it('never echoes a credential embedded in a repository URL', async () => {
    const { projectId, environmentId } = await newProject();
    const serverId = await newServer();
    const response = await app.inject({
      method: 'POST',
      url: `/api/projects/${projectId}/services`,
      headers: { cookie },
      payload: {
        ...imageBody(environmentId, serverId),
        source: gitSource({ repositoryUrl: 'https://user:CANARY-TOKEN-1208@github.com/acme/api.git' }),
      },
    });
    expect(response.statusCode).toBe(422);
    expect(response.body).not.toContain('CANARY-TOKEN-1208');
  });

  it('answers 401 without a session before looking anything up', async () => {
    const { projectId } = await newProject();
    const response = await app.inject({ method: 'GET', url: `/api/projects/${projectId}/services` });
    expect(response.statusCode).toBe(401);
  });
});

describe('port claim race (H2)', () => {
  it('settles concurrent creates claiming one port on one server as one 201 and one PORT_IN_USE', async () => {
    const serverId = await newServer();
    for (const port of [7001, 7002, 7003]) {
      const a = await newProject();
      const b = await newProject();
      const results = await Promise.all([
        call('POST', `/api/projects/${a.projectId}/services`, imageBody(a.environmentId, serverId, { publishedPort: port })),
        call('POST', `/api/projects/${b.projectId}/services`, imageBody(b.environmentId, serverId, { publishedPort: port })),
      ]);
      const statuses = results.map((r) => r.statusCode).sort();
      expect(statuses, JSON.stringify(results.map((r) => r.body))).toEqual([201, 409]);
      expect(results.find((r) => r.statusCode === 409)?.body.error).toBe('PORT_IN_USE');
      const holders = await postgres.db
        .select({ id: services.id })
        .from(services)
        .where(and(eq(services.serverId, serverId), eq(services.publishedPort, port)));
      expect(holders).toHaveLength(1);
    }
  });

  it('settles concurrent edits claiming one port the same way', async () => {
    const { projectId, environmentId } = await newProject();
    const serverId = await newServer();
    const first = await createService(projectId, imageBody(environmentId, serverId));
    const second = await createService(projectId, imageBody(environmentId, serverId));
    const results = await Promise.all(
      [first, second].map((s) =>
        call('PATCH', `/api/projects/${projectId}/services/${String(s.id)}`, { publishedPort: 7100 }),
      ),
    );
    expect(results.map((r) => r.statusCode).sort()).toEqual([200, 409]);
    expect(results.find((r) => r.statusCode === 409)?.body.error).toBe('PORT_IN_USE');
  });
});

describe('delete with a routed service (22-05 A3)', () => {
  async function routedService(): Promise<{ projectId: string; serviceId: string; name: string }> {
    const { projectId, environmentId } = await newProject();
    const serverId = await newServer();
    const created = await createService(projectId, imageBody(environmentId, serverId));
    const serviceId = String(created.id);
    await postgres.db.insert(domains).values({ projectId, serviceId, hostname: `app-${short()}.example.test` });
    return { projectId, serviceId, name: String(created.name) };
  }

  async function domainCount(serviceId: string): Promise<number> {
    return (await postgres.db.select({ id: domains.id }).from(domains).where(eq(domains.serviceId, serviceId))).length;
  }

  it('removes the route file and detaches the proxy before the container and the network; domains cascade', async () => {
    const { projectId, serviceId, name } = await routedService();
    await postgres.db.insert(deployments).values({
      serviceId,
      status: 'SUCCESS',
      source: { kind: 'image', imageRef: 'nginx:1.27' },
      startedAt: new Date(),
      completedAt: new Date(),
    });
    host = new ProxyHost(serviceId, true, 1);

    const response = await call('DELETE', `/api/projects/${projectId}/services/${serviceId}`, { confirmName: name });

    expect(response.statusCode, JSON.stringify(response.body)).toBe(200);
    expect(host.calls.slice(0, 6)).toEqual([
      'docker.ps',
      'proxy.remove_dynamic',
      'docker.network_disconnect',
      'docker.stop',
      'docker.remove',
      'docker.network_remove',
    ]);
    expect(host.calls.slice(6)).toEqual(['docker.image_remove', 'fs.remove_deploy_dir']);
    expect(host.remote()).toEqual({
      routeFile: false,
      routePrev: false,
      proxyAttached: false,
      container: false,
      network: false,
    });
    expect(host.images).toBe(0);
    expect(host.workspaces).toBe(0);
    expect(await postgres.db.select().from(services).where(eq(services.id, serviceId))).toEqual([]);
    expect(await domainCount(serviceId)).toBe(0);
  });

  it('keeps a never-deployed service with a domain when its server is unreachable, then cleans it up', async () => {
    const { projectId, serviceId, name } = await routedService();
    const url = `/api/projects/${projectId}/services/${serviceId}`;

    const refused = await call('DELETE', url, { confirmName: name });
    expect(refused.statusCode, JSON.stringify(refused.body)).toBe(502);
    expect(refused.body.error).toBe('SERVER_UNREACHABLE');
    expect(await domainCount(serviceId)).toBe(1);

    host = new ProxyHost(serviceId, false, 0);
    const deleted = await call('DELETE', url, { confirmName: name });

    expect(deleted.statusCode, JSON.stringify(deleted.body)).toBe(200);
    expect(host.calls).toEqual(['docker.ps', 'proxy.remove_dynamic', 'docker.network_disconnect', 'docker.network_remove']);
    expect(host.remote()).toEqual({
      routeFile: false,
      routePrev: false,
      proxyAttached: false,
      container: false,
      network: false,
    });
    expect(await domainCount(serviceId)).toBe(0);
  });
});
