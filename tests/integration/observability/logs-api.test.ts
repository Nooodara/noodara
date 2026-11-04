// 27-04 (A1-A4, H1, H2): the unified logs API over real HTTP, a migrated Postgres and the real
// sshd + dockerd fixture. Build and deploy chunks and activity rows are seeded straight into
// Postgres at fixed offsets; runtime lines come from a container that prints a canary secret on
// every line. The routes are createLogsRoutes on a minimal Fastify (actor from `x-test-user`),
// connected over a pinned SSH session through a wrapper that counts open sessions. Two extra
// servers model failure: one unreachable (port 1), one whose connect never answers.
// App modules are imported dynamically after a valid test env is written: some import env.ts,
// which fail-fasts at import time (INST-06).
import { randomBytes, randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createRedactor, secretValue, type Redactor } from '@noodara/domain/security';
import { createSsh2Adapter, type HostFingerprint } from '@noodara/ssh';
import {
  activityEvents,
  credentials,
  deploymentLogChunks,
  deployments,
  environments,
  projects,
  servers,
  services,
} from '../../../apps/control-plane/src/db/schema/index.js';
import type { ConnectResult } from '../../../apps/control-plane/src/deploy/deploy-worker.js';
import { DEPLOY_ENGINE_UBUNTU_VERSIONS, startDeployEngineStack, type DeployEngineStack } from '../helpers/deploy-engine.js';
import { startPostgres, type PostgresFixture } from '../helpers/postgres.js';
import { runTeardown, settleWithin } from '../helpers/teardown.js';

type LogsRoutesModule = typeof import('../../../apps/control-plane/src/routes/logs.js');
type LogCursorModule = typeof import('../../../apps/control-plane/src/observability/logs/log-cursor.js');
type SecretStoreModule = typeof import('../../../apps/control-plane/src/secrets/secret-store.js');

/** The slice of a Fastify instance this test drives (fastify is not a root dependency). */
interface TestRequest {
  actor: unknown;
  readonly headers: Record<string, string | string[] | undefined>;
}
interface TestServer {
  setValidatorCompiler(compiler: unknown): void;
  setSerializerCompiler(compiler: unknown): void;
  decorateRequest(name: string, value: unknown): void;
  addHook(name: 'onRequest', hook: (request: TestRequest) => Promise<void>): void;
  register(plugin: unknown): Promise<unknown>;
  listen(options: { host: string; port: number }): Promise<string>;
  close(): Promise<void>;
  readonly server: { address(): AddressInfo | string | null };
}
type FastifyFactory = (options?: { forceCloseConnections?: boolean }) => TestServer;
interface ZodProviderModule {
  readonly validatorCompiler: unknown;
  readonly serializerCompiler: unknown;
}

const HERE = path.dirname(fileURLToPath(import.meta.url));
const controlPlaneRequire = createRequire(path.resolve(HERE, '../../../apps/control-plane/package.json'));
async function importFromControlPlane<T>(specifier: string): Promise<T> {
  return (await import(pathToFileURL(controlPlaneRequire.resolve(specifier)).href)) as T;
}

const STACK_TIMEOUT_MS = 900_000;
const CASE_TIMEOUT_MS = 120_000;
const PENDING_START_WAIT_MS = 240_000;
const TEARDOWN_STEP_TIMEOUT_MS = 60_000;
const STACK_STOP_TIMEOUT_MS = 300_000;
const SECOND = 1000;
const MINUTE = 60 * SECOND;
const RUNTIME_TIMEOUT_MS = 8_000;
const PAGE_MAX_BYTES = 64 * 1024;
const FOLLOW = { pollMs: 300, idleMs: 3_000, maxLifetimeMs: 6_000, maxPerUser: 2, maxPerService: 2, runtimeTimeoutMs: RUNTIME_TIMEOUT_MS };
const BULK_LINES = 300;
const BULK_LINE_LENGTH = 300;
const USER_A = 'logs-user-a';
const USER_B = 'logs-user-b';
const TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;
// No hex digit is in this prefix, so it can only match the canary itself.
const CANARY_PREFIX = 'zq9k';
const CANARY = `${CANARY_PREFIX}${randomBytes(12).toString('hex')}`;
/** A boot line and a tick every second, each carrying the canary. */
const RUNTIME_SCRIPT = [
  `const c = ${JSON.stringify(CANARY)};`,
  'process.stdout.write("boot auth=" + c + "\\n");',
  'let i = 0;',
  'setInterval(() => { process.stdout.write("tick " + String(i++) + " auth=" + c + "\\n"); }, 1000);',
].join(' ');

interface Entry {
  readonly source: string;
  readonly timestamp: string;
  readonly level: string;
  readonly stream: string | null;
  readonly text: string;
  readonly truncated: boolean;
}
interface Page {
  readonly entries: Entry[];
  readonly since: string;
  readonly until: string;
  readonly nextUntil: string | null;
  readonly unavailableSources: string[];
  readonly nextCursor: string | null;
  readonly truncated: boolean;
}
type Frame =
  | { readonly type: 'entry'; readonly entry: Entry }
  | { readonly type: 'unavailable'; readonly source: string; readonly error: string }
  | { readonly type: 'end'; readonly reason: string };

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitFor(condition: () => boolean, timeoutMs: number, what: string): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await delay(100);
  }
}

/** Epoch ms of an RFC 3339 timestamp, sub-millisecond digits dropped. */
function ms(timestamp: string): number {
  return Date.parse(timestamp.replace(/(\.\d{3})\d+/, '$1'));
}

function key(entry: Entry): string {
  return `${entry.source}|${entry.timestamp}|${entry.text}`;
}

interface FollowStream {
  readonly status: number;
  readonly frames: Frame[];
  readonly text: () => string;
  readonly done: Promise<void>;
  abort(): void;
}

describe.each(DEPLOY_ENGINE_UBUNTU_VERSIONS)('unified logs API on Ubuntu %s (27-04)', (ubuntu) => {
  let stackStart: Promise<DeployEngineStack> | undefined;
  let stack: DeployEngineStack | undefined;
  let postgres: PostgresFixture | undefined;
  let app: TestServer | undefined;
  let baseUrl = '';
  let cursorKey: Buffer = Buffer.alloc(0);
  let cursorModule: LogCursorModule | undefined;
  let openSessions = 0;
  let hangingConnects = 0;
  const containers: string[] = [];
  const follows: FollowStream[] = [];
  /** Every body any response carried, for the canary sweep. */
  const bodies: string[] = [];
  const t0 = Date.now() - 10 * MINUTE;
  const ids = {
    projectId: '',
    mainServiceId: '',
    unreachableServiceId: '',
    hangingServiceId: '',
    bulkServiceId: '',
    otherServiceId: '',
  };

  const s = (): DeployEngineStack => {
    if (!stack) throw new Error('stack not started');
    return stack;
  };
  const db = (): PostgresFixture['db'] => {
    if (!postgres) throw new Error('postgres not started');
    return postgres.db;
  };
  const root = (argv: readonly string[]) => s().exec(argv, { user: 'root' });
  const entriesUrl = (serviceId: string, query = '', suffix = ''): string =>
    `${baseUrl}/api/projects/${ids.projectId}/services/${serviceId}/logs/entries${suffix}${query === '' ? '' : `?${query}`}`;

  async function get(serviceId: string, query = '', user = USER_A): Promise<{ status: number; body: Record<string, unknown> }> {
    const response = await fetch(entriesUrl(serviceId, query), { headers: { 'x-test-user': user } });
    const raw = await response.text();
    bodies.push(raw);
    return { status: response.status, body: JSON.parse(raw) as Record<string, unknown> };
  }

  async function page(serviceId: string, query = ''): Promise<Page> {
    const response = await get(serviceId, query);
    expect(response.status, JSON.stringify(response.body)).toBe(200);
    return response.body as unknown as Page;
  }

  async function expectInvalid(serviceId: string, query: string): Promise<void> {
    const response = await get(serviceId, query);
    expect(response.status, query).toBe(422);
    expect(response.body.error).toBe('LOG_QUERY_INVALID');
  }

  /** Opens a follow and pumps its NDJSON frames in the background. */
  async function follow(serviceId: string, query = '', user = USER_A): Promise<FollowStream> {
    const controller = new AbortController();
    const response = await fetch(entriesUrl(serviceId, query, '/follow'), {
      headers: { 'x-test-user': user },
      signal: controller.signal,
    });
    const frames: Frame[] = [];
    let all = '';
    const decoder = new TextDecoder();
    const body = response.body;
    const done = (async () => {
      if (body === null) return;
      const reader = body.getReader();
      let buffer = '';
      try {
        for (;;) {
          const chunk = await reader.read();
          if (chunk.done) break;
          const text = decoder.decode(chunk.value, { stream: true });
          all += text;
          buffer += text;
          let newline = buffer.indexOf('\n');
          while (newline >= 0) {
            const line = buffer.slice(0, newline);
            buffer = buffer.slice(newline + 1);
            if (line.length > 0 && response.status === 200) frames.push(JSON.parse(line) as Frame);
            newline = buffer.indexOf('\n');
          }
        }
      } catch {
        // Aborted by the test.
      } finally {
        bodies.push(all);
      }
    })();
    const stream: FollowStream = {
      status: response.status,
      frames,
      text: () => all,
      done,
      abort: () => {
        controller.abort();
      },
    };
    follows.push(stream);
    return stream;
  }

  const entriesOf = (frames: readonly Frame[]): Entry[] =>
    frames.flatMap((frame) => (frame.type === 'entry' ? [frame.entry] : []));

  async function insertChunk(deploymentId: string, phase: 'prepare' | 'build' | 'deploy' | 'healthcheck', seq: number, content: string, at: number): Promise<void> {
    await db()
      .insert(deploymentLogChunks)
      .values({ deploymentId, phase, seq, content, byteLength: Buffer.byteLength(content), createdAt: new Date(at) });
  }

  async function insertActivity(entityType: 'service' | 'deployment', entityId: string, action: string, at: number, errorCode: string | null = null): Promise<void> {
    await db()
      .insert(activityEvents)
      .values({
        occurredAt: new Date(at),
        actorType: 'system',
        entityType,
        entityId,
        action,
        outcome: errorCode === null ? 'success' : 'failure',
        errorCode,
      });
  }

  beforeAll(async () => {
    stackStart = startDeployEngineStack({ ubuntu });
    const [startedStack, startedPostgres] = await Promise.all([stackStart, startPostgres()]);
    stack = startedStack;
    postgres = startedPostgres;

    const masterKey = randomBytes(32);
    process.env.NOODARA_MASTER_KEY = masterKey.toString('base64');
    process.env.BETTER_AUTH_SECRET = `logs-api-${randomUUID()}-${randomUUID()}`;
    process.env.DATABASE_URL = postgres.connectionString;
    process.env.REDIS_URL ??= 'redis://127.0.0.1:1';
    process.env.NOODARA_PUBLIC_URL = 'http://localhost:3000';
    const routes: LogsRoutesModule = await import('../../../apps/control-plane/src/routes/logs.js');
    cursorModule = await import('../../../apps/control-plane/src/observability/logs/log-cursor.js');
    const secretStore: SecretStoreModule = await import('../../../apps/control-plane/src/secrets/secret-store.js');
    cursorKey = cursorModule.deriveLogCursorKey(process.env.BETTER_AUTH_SECRET);

    // Pin the host key from a first trusted connect, as a CONNECTED server row would.
    const ssh = createSsh2Adapter();
    const sshInput = {
      target: { host: s().ssh.host, port: s().ssh.port, user: s().ssh.user },
      credential: { kind: 'private_key' as const, privateKey: secretValue(s().ssh.privateKey, 'ssh_private_key') },
      timeouts: { connectMs: 20_000, commandMs: 60_000, discoveryMs: 120_000 },
    };
    const probe = await ssh.connect({ ...sshInput, trustedFingerprint: null, redactor: createRedactor() });
    if (!probe.ok) throw new Error(`fingerprint probe failed: ${probe.errorCode}`);
    const fingerprint: HostFingerprint = probe.fingerprint;
    await probe.session.close();

    // ---- seed ---------------------------------------------------------------------------------
    const [credential] = await db()
      .insert(credentials)
      .values({ type: 'ssh_password', encryptedValue: 'unused-by-this-test', keyVersion: 1 })
      .returning({ id: credentials.id });
    if (!credential) throw new Error('credential insert returned no row');
    const insertServer = async (name: string, host: string): Promise<string> => {
      const [row] = await db()
        .insert(servers)
        .values({ name, host, sshPort: 22, sshUser: 'deployer', credentialId: credential.id, status: 'CONNECTED', dockerInstalled: true })
        .returning({ id: servers.id });
      if (!row) throw new Error('server insert returned no row');
      return row.id;
    };
    const mainServerId = await insertServer('logs-main', '198.51.100.10');
    const unreachableServerId = await insertServer('logs-unreachable', '198.51.100.11');
    const hangingServerId = await insertServer('logs-hanging', '198.51.100.12');

    const [project] = await db()
      .insert(projects)
      .values({ name: 'logs', slug: `logs-${randomUUID().slice(0, 8)}` })
      .returning({ id: projects.id });
    if (!project) throw new Error('project insert returned no row');
    ids.projectId = project.id;
    const [environment] = await db()
      .insert(environments)
      .values({ projectId: project.id, name: 'production' })
      .returning({ id: environments.id });
    if (!environment) throw new Error('environment insert returned no row');

    const insertService = async (serverId: string): Promise<{ serviceId: string; deploymentId: string }> => {
      const [row] = await db()
        .insert(services)
        .values({
          projectId: project.id,
          environmentId: environment.id,
          serverId,
          name: `svc-${randomUUID().slice(0, 8)}`,
          sourceType: 'git',
          repositoryUrl: 'https://example.invalid/logs.git',
          branch: 'main',
          buildContext: '.',
          dockerfilePath: 'Dockerfile',
          internalPort: 3000,
          publishedPort: null,
          status: 'RUNNING',
        })
        .returning({ id: services.id });
      if (!row) throw new Error('service insert returned no row');
      const [deployment] = await db()
        .insert(deployments)
        .values({ serviceId: row.id, status: 'SUCCESS', source: { type: 'git', repositoryUrl: 'https://example.invalid/logs.git', branch: 'main' } })
        .returning({ id: deployments.id });
      if (!deployment) throw new Error('deployment insert returned no row');
      return { serviceId: row.id, deploymentId: deployment.id };
    };

    const main = await insertService(mainServerId);
    ids.mainServiceId = main.serviceId;
    await insertChunk(main.deploymentId, 'build', 0, `Step 1/2 : FROM node\nStep 2/2 : RUN npm ci\nleaked ${CANARY}\n`, t0);
    await insertChunk(main.deploymentId, 'deploy', 0, 'starting container\ncontainer started\n', t0 + MINUTE);
    await insertChunk(main.deploymentId, 'healthcheck', 0, 'healthcheck passed\n', t0 + 90 * SECOND);
    await insertActivity('deployment', main.deploymentId, 'deployment.created', t0 - 30 * SECOND);
    await insertActivity('deployment', main.deploymentId, 'deployment.finished', t0 + 100 * SECOND, 'HEALTHCHECK_FAILED');
    await insertActivity('service', main.serviceId, 'service.updated', t0 + 120 * SECOND);

    const other = await insertService(mainServerId);
    ids.otherServiceId = other.serviceId;
    await insertChunk(other.deploymentId, 'build', 0, 'other service build\n', t0 + 10 * SECOND);
    await insertActivity('service', other.serviceId, 'service.restarted', t0 + 50 * SECOND);

    const unreachable = await insertService(unreachableServerId);
    ids.unreachableServiceId = unreachable.serviceId;
    await insertChunk(unreachable.deploymentId, 'build', 0, 'unreachable build ok\n', t0);
    await insertActivity('service', unreachable.serviceId, 'service.created', t0 + 5 * SECOND);

    const hanging = await insertService(hangingServerId);
    ids.hangingServiceId = hanging.serviceId;
    await insertChunk(hanging.deploymentId, 'build', 0, 'hanging build ok\n', t0);
    await insertActivity('service', hanging.serviceId, 'service.created', t0 + 5 * SECOND);

    const bulk = await insertService(mainServerId);
    ids.bulkServiceId = bulk.serviceId;
    const bulkLines = Array.from({ length: BULK_LINES }, (_, i) => `${String(i).padStart(4, '0')} ${'x'.repeat(BULK_LINE_LENGTH - 5)}`);
    await insertChunk(bulk.deploymentId, 'build', 0, `${bulkLines.join('\n')}\n`, t0);

    await secretStore.createSecret(
      db(),
      { owner: { scope: 'service', projectId: project.id, serviceId: main.serviceId }, name: 'API_TOKEN', value: secretValue(CANARY, 'app_secret') },
      { current: masterKey },
    );

    // ---- runtime container ----------------------------------------------------------------------
    const name = `noodara-${main.serviceId}`;
    const nodeBase = s().baseImages.find((ref) => ref.startsWith('node:'));
    if (nodeBase === undefined) throw new Error('harness preloaded no node base image');
    const run = await root([
      'docker', 'run', '-d', '--name', name,
      '--label', 'noodara.managed=true',
      '--label', `noodara.service_id=${main.serviceId}`,
      '--label', 'noodara.test=true',
      nodeBase, 'node', '-e', RUNTIME_SCRIPT,
    ]);
    if (run.exitCode !== 0) throw new Error(`docker run ${name} failed: ${run.stderr}`);
    containers.push(name);

    // ---- routes -------------------------------------------------------------------------------
    const unreachableTarget = { host: '127.0.0.1', port: 1, user: s().ssh.user };
    const connect = async (serverId: string, redactor: Redactor, signal: AbortSignal | undefined): Promise<ConnectResult> => {
      if (serverId === hangingServerId) {
        hangingConnects += 1;
        // Never answers on its own: only the caller's deadline ends it.
        return new Promise<ConnectResult>((resolve) => {
          const fail = (): void => {
            resolve({ ok: false, code: 'SERVER_UNREACHABLE' });
          };
          if (signal?.aborted === true) fail();
          else signal?.addEventListener('abort', fail, { once: true });
        });
      }
      const target = serverId === unreachableServerId ? unreachableTarget : sshInput.target;
      const outcome = await ssh.connect({ ...sshInput, target, trustedFingerprint: fingerprint, redactor });
      if (!outcome.ok) return { ok: false, code: 'SERVER_UNREACHABLE' };
      const { session } = outcome;
      openSessions += 1;
      let closed = false;
      return {
        ok: true,
        session,
        close: async () => {
          if (closed) return;
          closed = true;
          openSessions -= 1;
          await session.close();
        },
      };
    };

    const fastify = await importFromControlPlane<{ default: FastifyFactory }>('fastify');
    const zodProvider = await importFromControlPlane<ZodProviderModule>('@fastify/type-provider-zod');
    const instance = fastify.default({ forceCloseConnections: true });
    instance.setValidatorCompiler(zodProvider.validatorCompiler);
    instance.setSerializerCompiler(zodProvider.serializerCompiler);
    instance.decorateRequest('actor', null);
    instance.addHook('onRequest', async (request) => {
      const user = request.headers['x-test-user'];
      request.actor = { type: 'user', id: typeof user === 'string' ? user : USER_A };
    });
    const store = postgres;
    await instance.register(
      routes.createLogsRoutes({
        connect,
        masterKeys: () => Promise.resolve({ current: masterKey }),
        cursorKey,
        getDb: () => Promise.resolve(store.db),
        limits: { runtimeTimeoutMs: RUNTIME_TIMEOUT_MS, pageMaxBytes: PAGE_MAX_BYTES, follow: FOLLOW },
      }),
    );
    await instance.listen({ host: '127.0.0.1', port: 0 });
    app = instance;
    baseUrl = `http://127.0.0.1:${String((instance.server.address() as AddressInfo).port)}`;

    // Wait for a few ticks so the runtime window has lines.
    const deadline = Date.now() + 30_000;
    while (Date.now() < deadline) {
      const out = await root(['docker', 'logs', name]);
      if ((out.stdout.match(/tick /g) ?? []).length >= 3) break;
      await delay(250);
    }
  }, STACK_TIMEOUT_MS);

  afterAll(async () => {
    const started = stack ?? (await settleWithin(stackStart, PENDING_START_WAIT_MS));
    await runTeardown(
      `unified logs API (Ubuntu ${ubuntu})`,
      [
        {
          name: 'abort follows',
          run: async () => {
            for (const stream of follows) stream.abort();
            await Promise.all(follows.map((stream) => stream.done));
          },
        },
        { name: 'app.close', run: () => app?.close() },
        {
          name: 'remove containers',
          run: async () => {
            if (started === undefined) return;
            for (const name of containers) {
              await started.exec(['docker', 'rm', '-f', name], { user: 'root' }).catch(() => undefined);
            }
          },
        },
        { name: 'stack.stop', run: () => started?.stop(), timeoutMs: STACK_STOP_TIMEOUT_MS },
        { name: 'postgres.stop', run: () => postgres?.stop() },
      ],
      { stepTimeoutMs: TEARDOWN_STEP_TIMEOUT_MS },
    );
  }, STACK_TIMEOUT_MS);

  it('A1: one page merges build, deploy, runtime and activity, each with source, timestamp and stream', async () => {
    const result = await page(ids.mainServiceId, 'limit=1000');
    expect(result.unavailableSources).toEqual([]);
    const sources = new Set(result.entries.map((entry) => entry.source));
    expect([...sources].sort()).toEqual(['activity', 'build', 'deploy', 'runtime']);
    for (const entry of result.entries) {
      expect(entry.timestamp).toMatch(TIMESTAMP);
      expect(entry.stream).toBe(entry.source === 'runtime' ? 'stdout' : null);
    }
    // Ascending by time across sources.
    const times = result.entries.map((entry) => ms(entry.timestamp));
    expect(times).toEqual([...times].sort((a, b) => a - b));

    const texts = result.entries.map((entry) => entry.text);
    expect(texts).toContain('Step 2/2 : RUN npm ci');
    expect(result.entries.find((entry) => entry.text === 'healthcheck passed')?.source).toBe('deploy');
    const failed = result.entries.find((entry) => entry.text === 'deployment.finished failed (HEALTHCHECK_FAILED)');
    expect(failed).toMatchObject({ source: 'activity', level: 'error' });
    expect(texts.some((text) => /^tick \d+ auth=/.test(text))).toBe(true);
    // Another service's rows never leak in.
    expect(texts).not.toContain('other service build');
    expect(texts).not.toContain('service.restarted');
    expect(openSessions).toBe(0);
  }, CASE_TIMEOUT_MS);

  it('A2: filters by source set, window, level and substring search server-side', async () => {
    const picked = await page(ids.mainServiceId, 'sources=build,activity&limit=1000');
    expect(new Set(picked.entries.map((entry) => entry.source))).toEqual(new Set(['build', 'activity']));
    const repeated = await page(ids.mainServiceId, 'sources=build&sources=deploy&limit=1000');
    expect(new Set(repeated.entries.map((entry) => entry.source))).toEqual(new Set(['build', 'deploy']));

    const since = new Date(t0 + 30 * SECOND).toISOString();
    const until = new Date(t0 + 95 * SECOND).toISOString();
    const windowed = await page(ids.mainServiceId, `since=${since}&until=${until}`);
    expect(windowed.entries.map((entry) => [entry.source, entry.text])).toEqual([
      ['deploy', 'starting container'],
      ['deploy', 'container started'],
      ['deploy', 'healthcheck passed'],
    ]);
    expect(windowed.since).toBe(since);
    expect(windowed.until).toBe(until);

    const errors = await page(ids.mainServiceId, 'level=error&limit=1000');
    expect(errors.entries.length).toBeGreaterThan(0);
    expect(errors.entries.every((entry) => entry.level === 'error')).toBe(true);
    expect(errors.entries.map((entry) => entry.text)).toContain('deployment.finished failed (HEALTHCHECK_FAILED)');

    const searched = await page(ids.mainServiceId, 'search=HEALTHCHECK&limit=1000');
    expect(searched.entries.map((entry) => entry.text).sort()).toEqual(
      ['deployment.finished failed (HEALTHCHECK_FAILED)', 'healthcheck passed'].sort(),
    );
    expect(openSessions).toBe(0);
  }, CASE_TIMEOUT_MS);

  it('A2: cursor pagination walks back without gaps or duplicates', async () => {
    const query = 'sources=build,deploy,activity';
    const whole = await page(ids.mainServiceId, `${query}&limit=1000`);
    expect(whole.nextCursor).toBeNull();
    expect(whole.entries.length).toBeGreaterThan(4);

    const collected: Entry[][] = [];
    let cursor: string | null = null;
    for (let i = 0; i < 20; i += 1) {
      const suffix: string = cursor === null ? '' : `&cursor=${encodeURIComponent(cursor)}`;
      const next = await page(ids.mainServiceId, `${query}&limit=2${suffix}`);
      expect(next.entries.length).toBeLessThanOrEqual(2);
      collected.unshift(next.entries);
      cursor = next.nextCursor;
      if (cursor === null) break;
    }
    expect(cursor).toBeNull();
    const walked = collected.flat();
    expect(walked.map(key)).toEqual(whole.entries.map(key));
    expect(new Set(walked.map(key)).size).toBe(walked.length);
  }, CASE_TIMEOUT_MS);

  it('A2: byte and window caps return a truncated flag instead of failing', async () => {
    const first = await page(ids.bulkServiceId, 'sources=build&limit=1000');
    expect(first.truncated).toBe(true);
    expect(first.nextCursor).not.toBeNull();
    const bytes = first.entries.reduce((sum, entry) => sum + Buffer.byteLength(entry.text), 0);
    expect(bytes).toBeLessThanOrEqual(PAGE_MAX_BYTES);
    expect(first.entries.length).toBeLessThan(BULK_LINES);

    const seen = new Set(first.entries.map((entry) => entry.text));
    let cursor = first.nextCursor;
    for (let i = 0; i < 10 && cursor !== null; i += 1) {
      const next = await page(ids.bulkServiceId, `sources=build&limit=1000&cursor=${encodeURIComponent(cursor)}`);
      for (const entry of next.entries) {
        expect(seen.has(entry.text)).toBe(false);
        seen.add(entry.text);
      }
      cursor = next.nextCursor;
    }
    expect(seen.size).toBe(BULK_LINES);

    const wide = await page(ids.mainServiceId, `sources=build&since=${new Date(Date.now() - 48 * 60 * MINUTE).toISOString()}`);
    expect(wide.truncated).toBe(true);
    expect(ms(wide.until) - ms(wide.since)).toBe(24 * 60 * MINUTE);

    const lines = await page(ids.mainServiceId, 'sources=build,deploy&limit=1');
    expect(lines.entries).toHaveLength(1);
    expect(lines.nextCursor).not.toBeNull();
  }, CASE_TIMEOUT_MS);

  it('A2: a malformed query is LOG_QUERY_INVALID', async () => {
    for (const query of ['limit=0', 'limit=1001', 'limit=ten', 'level=debug', 'sources=kernel', 'since=yesterday', 'level=info&level=warn', `search=${'a'.repeat(201)}`]) {
      await expectInvalid(ids.mainServiceId, query);
    }
  }, CASE_TIMEOUT_MS);

  it('A3: follow streams new entries and closes the SSH session when the client disconnects', async () => {
    const stream = await follow(ids.mainServiceId, 'sources=runtime,activity');
    expect(stream.status).toBe(200);
    await waitFor(() => entriesOf(stream.frames).filter((entry) => entry.source === 'runtime').length >= 2, 20_000, 'runtime frames');
    expect(openSessions).toBe(1);

    await insertActivity('service', ids.mainServiceId, 'service.followed', Date.now());
    await waitFor(() => entriesOf(stream.frames).some((entry) => entry.text === 'service.followed'), 10_000, 'activity frame');
    for (const entry of entriesOf(stream.frames)) {
      expect(['runtime', 'activity']).toContain(entry.source);
      expect(entry.timestamp).toMatch(TIMESTAMP);
    }
    // No old tick is replayed: the stream starts at "now".
    const runtimeTexts = entriesOf(stream.frames).filter((entry) => entry.source === 'runtime').map((entry) => entry.text);
    expect(runtimeTexts.some((text) => text.startsWith('boot '))).toBe(false);
    expect(new Set(runtimeTexts).size).toBe(runtimeTexts.length);

    stream.abort();
    await stream.done;
    await waitFor(() => openSessions === 0, 15_000, 'the follow SSH session to close');
  }, CASE_TIMEOUT_MS);

  it('A3/H2: a busy follow ends at its hard max lifetime, an idle one at the idle timeout', async () => {
    const started = Date.now();
    const busy = await follow(ids.mainServiceId, 'sources=runtime');
    expect(busy.status).toBe(200);
    await busy.done;
    const elapsed = Date.now() - started;
    expect(busy.frames.at(-1)).toEqual({ type: 'end', reason: 'max_duration' });
    expect(elapsed).toBeGreaterThanOrEqual(FOLLOW.maxLifetimeMs);
    expect(elapsed).toBeLessThan(FOLLOW.maxLifetimeMs + RUNTIME_TIMEOUT_MS + 5_000);
    await waitFor(() => openSessions === 0, 15_000, 'the follow SSH session to close');

    const quiet = await follow(ids.mainServiceId, 'sources=build');
    await quiet.done;
    expect(quiet.frames.at(-1)).toEqual({ type: 'end', reason: 'idle' });
  }, CASE_TIMEOUT_MS);

  it('H2: follow streams are capped per user and per service', async () => {
    const first = await follow(ids.mainServiceId, 'sources=build', USER_A);
    const second = await follow(ids.mainServiceId, 'sources=build', USER_A);
    expect([first.status, second.status]).toEqual([200, 200]);

    const perUser = await follow(ids.bulkServiceId, 'sources=build', USER_A);
    const perService = await follow(ids.mainServiceId, 'sources=build', USER_B);
    expect([perUser.status, perService.status]).toEqual([429, 429]);
    await Promise.all([perUser.done, perService.done]);
    for (const refused of [perUser, perService]) {
      expect(JSON.parse(refused.text())).toMatchObject({ error: 'RUNTIME_LOG_FOLLOW_LIMIT_REACHED' });
    }
    const allowed = await follow(ids.bulkServiceId, 'sources=build', USER_B);
    expect(allowed.status).toBe(200);

    for (const stream of [first, second, allowed]) stream.abort();
    await Promise.all([first.done, second.done, allowed.done]);
    // Slots come back once the streams have ended.
    let again: FollowStream | undefined;
    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline) {
      again = await follow(ids.mainServiceId, 'sources=build', USER_A);
      if (again.status === 200) break;
      await again.done;
      await delay(200);
    }
    expect(again?.status).toBe(200);
    again?.abort();
    await again?.done;
  }, CASE_TIMEOUT_MS);

  it('A4: an unreachable server makes only runtime unavailable', async () => {
    const result = await page(ids.unreachableServiceId, 'limit=1000');
    expect(result.unavailableSources).toEqual(['runtime']);
    expect(result.entries.map((entry) => [entry.source, entry.text])).toEqual([
      ['build', 'unreachable build ok'],
      ['activity', 'service.created'],
    ]);

    const runtimeOnly = await get(ids.unreachableServiceId, 'sources=runtime');
    expect(runtimeOnly.status).toBe(502);
    expect(runtimeOnly.body.error).toBe('LOG_SOURCE_UNAVAILABLE');

    const followed = await follow(ids.unreachableServiceId, 'sources=runtime,build');
    expect(followed.status).toBe(200);
    await waitFor(() => followed.frames.length > 0, 10_000, 'the first follow frame');
    expect(followed.frames[0]).toEqual({ type: 'unavailable', source: 'runtime', error: 'LOG_SOURCE_UNAVAILABLE' });
    followed.abort();
    await followed.done;
    const followedRuntime = await follow(ids.unreachableServiceId, 'sources=runtime');
    expect(followedRuntime.status).toBe(502);
    await followedRuntime.done;
    expect(openSessions).toBe(0);
  }, CASE_TIMEOUT_MS);

  it('H2: a runtime read that never answers times out to unavailable while the other sources answer', async () => {
    const before = hangingConnects;
    const started = Date.now();
    const result = await page(ids.hangingServiceId, 'limit=1000');
    const elapsed = Date.now() - started;
    expect(hangingConnects).toBeGreaterThan(before);
    expect(result.unavailableSources).toEqual(['runtime']);
    expect(result.entries.map((entry) => entry.text)).toEqual(['hanging build ok', 'service.created']);
    expect(elapsed).toBeGreaterThanOrEqual(RUNTIME_TIMEOUT_MS - 500);
    expect(elapsed).toBeLessThan(RUNTIME_TIMEOUT_MS + 10_000);

    const runtimeOnly = await get(ids.hangingServiceId, 'sources=runtime');
    expect(runtimeOnly.status).toBe(502);
    expect(runtimeOnly.body.error).toBe('LOG_SOURCE_UNAVAILABLE');
  }, CASE_TIMEOUT_MS);

  it('H1: a tampered, truncated, foreign or malformed cursor is LOG_QUERY_INVALID', async () => {
    const first = await page(ids.mainServiceId, 'sources=build,deploy,activity&limit=1');
    const cursor = first.nextCursor;
    if (cursor === null) throw new Error('expected a cursor');
    const flip = (value: string, at: number): string => {
      const char = value[at] === 'A' ? 'B' : 'A';
      return `${value.slice(0, at)}${char}${value.slice(at + 1)}`;
    };
    const bad = [
      flip(cursor, Math.floor(cursor.length / 2)),
      flip(cursor, 0),
      flip(cursor, cursor.length - 1),
      cursor.slice(0, -4),
      cursor.slice(0, 8),
      `${cursor}x`,
      '',
      'not-a-cursor',
      '%00%01',
    ];
    for (const value of bad) await expectInvalid(ids.mainServiceId, `cursor=${encodeURIComponent(value)}`);
    await expectInvalid(ids.mainServiceId, `cursor=${encodeURIComponent(cursor)}&cursor=${encodeURIComponent(cursor)}`);
    // A cursor is bound to the service it was issued for, even with a valid signature.
    await expectInvalid(ids.bulkServiceId, `cursor=${encodeURIComponent(cursor)}`);
    await expectInvalid(ids.otherServiceId, `cursor=${encodeURIComponent(cursor)}`);
    // A cursor for another service signed with another key is just as invalid.
    if (cursorModule === undefined) throw new Error('modules not loaded');
    const position = { timestamp: new Date(t0).toISOString(), source: 'build' as const, seq: 0 };
    const foreignKey = cursorModule.deriveLogCursorKey('another-installation-secret-value');
    await expectInvalid(ids.mainServiceId, `cursor=${encodeURIComponent(cursorModule.encodeLogCursor(position, ids.mainServiceId, foreignKey))}`);
    // The same position signed with our key is accepted.
    const own = await get(ids.mainServiceId, `cursor=${encodeURIComponent(cursorModule.encodeLogCursor(position, ids.mainServiceId, cursorKey))}`);
    expect(own.status).toBe(200);
  }, CASE_TIMEOUT_MS);

  it('A4/H2: search runs over redacted text only, and the canary never reaches a response', async () => {
    const prefix = await page(ids.mainServiceId, `search=${CANARY_PREFIX}&limit=1000`);
    expect(prefix.entries).toEqual([]);
    const full = await page(ids.mainServiceId, `search=${CANARY}&limit=1000`);
    expect(full.entries).toEqual([]);

    const redacted = await page(ids.mainServiceId, 'search=auth%3D&limit=1000');
    expect(redacted.entries.length).toBeGreaterThan(0);
    for (const entry of redacted.entries) {
      expect(entry.source).toBe('runtime');
      expect(entry.text).toContain('[REDACTED:');
    }
    const leaked = await page(ids.mainServiceId, 'search=leaked&sources=build');
    expect(leaked.entries.map((entry) => entry.text)).toEqual([expect.stringMatching(/^leaked \[REDACTED:/)]);

    expect(bodies.length).toBeGreaterThan(20);
    for (const body of bodies) {
      expect(body).not.toContain(CANARY);
      expect(body).not.toContain(CANARY_PREFIX);
    }
    expect(openSessions).toBe(0);
  }, CASE_TIMEOUT_MS);
});
