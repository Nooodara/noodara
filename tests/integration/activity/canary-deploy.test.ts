// 12-17 (A1, A2, SEC): per-run leak canaries for the deploy engine on the real sshd + dockerd fixture.
// Canaries: an HTTPS git token (askpass clone over the fixture's HTTPS remote, 12-06), a deploy key
// Noodara itself generates through the API, a registry password, and a fixture build that prints a
// per-run canary (tests/integration/deploy-engine/fixtures/canary-build). Real deploys run through
// the API -> BullMQ -> deploy worker -> chunked log sink -> Redis -> SSE, with the production wiring
// of src/worker.ts. Every canary must be absent from: build logs (worker logger, log chunks, the logs
// API), deployment_log_chunks, the SSE stream and the raw Redis events, activity_events.metadata,
// every API response the flow touches, `docker inspect` / `docker history` of the built image and
// the container, and the remote .git/config (read live while the build runs).
// The build canary stands in for a user secret: it is registered with every run's redactor, so it
// must arrive redacted. Assertion messages name canaries by label, never by value.
// App modules are imported dynamically after a valid test env is written (env.ts fail-fasts, INST-06).
import { randomBytes, randomUUID } from 'node:crypto';
import { cpSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { eq } from 'drizzle-orm';
import { Redis } from 'ioredis';
import parseSetCookie from 'set-cookie-parser';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createRedactor, revealSecret, secretValue } from '@noodara/domain/security';
import { createSsh2Adapter, formatFingerprint } from '@noodara/ssh';
import {
  activityEvents,
  credentials,
  deploymentLogChunks,
  deployments,
  servers,
  services,
} from '../../../apps/control-plane/src/db/schema/index.js';
import {
  DEPLOY_ENGINE_UBUNTU_VERSIONS,
  GIT_HTTPS_USERNAME,
  preloadedRefFor,
  startDeployEngineStack,
  type DeployEngineStack,
} from '../helpers/deploy-engine.js';
import { startPostgres, type PostgresFixture } from '../helpers/postgres.js';
import { startRedis, type RedisFixture } from '../helpers/redis.js';

type ApiApp = ReturnType<(typeof import('../../../apps/control-plane/src/app.js'))['buildApp']>;
type ServiceCredentialsModule = typeof import('../../../apps/control-plane/src/services/service-credentials.js');
type Json = Record<string, unknown>;

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CANARY_FIXTURE = path.resolve(HERE, '../deploy-engine/fixtures/canary-build');
const STACK_TIMEOUT_MS = 900_000;
const CASE_TIMEOUT_MS = 900_000;
const TERMINAL_WAIT_MS = 400_000;
const POLL_MS = 500;
const GIT_CONFIG_POLL_MS = 250;
const KEY_VERSION = 1;
const DEPLOY_MAX_MS = 400_000;
const WORKSPACE_ROOT = '/opt/noodara-deploy';
const IMAGE_PORT = 13_270;
const TERMINAL = new Set(['SUCCESS', 'FAILED', 'CANCELLED']);
const ADMIN_EMAIL = 'admin@noodara.test';
const ADMIN_PASSWORD = 'correct horse battery staple';

const REPOS = { https: 'canary-https', ssh: 'canary-ssh' } as const;

/** One per git service so BuildKit never serves the printing RUN step from cache. */
const BUILD_CANARIES = {
  https: `cnryBuildH${randomBytes(16).toString('hex')}`,
  ssh: `cnryBuildS${randomBytes(16).toString('hex')}`,
} as const;

interface Canary {
  readonly label: string;
  readonly value: string;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** A temp copy of the committed fixture with this run's canary file, seeded as its own repo. */
function writeCanaryRepo(root: string, name: string, canary: string): string {
  const dir = path.join(root, name);
  cpSync(CANARY_FIXTURE, dir, { recursive: true });
  writeFileSync(path.join(dir, 'canary.txt'), `${canary}\n`);
  return dir;
}

/** The OpenSSH PEM body lines: a partial key leak still matches one of them. */
function privateKeyCanaries(label: string, pem: string): Canary[] {
  const lines = pem
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length >= 24 && !line.startsWith('-----'));
  return [{ label, value: pem.trim() }, ...lines.map((value, index) => ({ label: `${label} line ${String(index + 1)}`, value }))];
}

function leaksIn(text: string, canaries: readonly Canary[]): string[] {
  return canaries.filter((canary) => text.includes(canary.value)).map((canary) => canary.label);
}

interface SseFrame {
  readonly type: string;
  readonly data: Json;
  readonly raw: string;
}

interface SseClient {
  readonly frames: SseFrame[];
  readonly raw: string[];
  close(): void;
}

function openSse(port: number, cookie: string): Promise<SseClient> {
  return new Promise((resolve, reject) => {
    const request = http.get({ host: '127.0.0.1', port, path: '/api/events', headers: { cookie } }, (response) => {
      const frames: SseFrame[] = [];
      const raw: string[] = [];
      let buffer = '';
      response.setEncoding('utf8');
      response.on('data', (chunk: string) => {
        raw.push(chunk);
        buffer += chunk;
        for (let index = buffer.indexOf('\n\n'); index !== -1; index = buffer.indexOf('\n\n')) {
          const frame = buffer.slice(0, index);
          buffer = buffer.slice(index + 2);
          const type = /^event: (.+)$/m.exec(frame)?.[1];
          const data = /^data: (.+)$/m.exec(frame)?.[1];
          if (type !== undefined && data !== undefined) frames.push({ type, data: JSON.parse(data) as Json, raw: frame });
        }
      });
      if (response.statusCode !== 200) reject(new Error(`SSE status ${String(response.statusCode)}`));
      resolve({
        frames,
        raw,
        close: () => {
          request.destroy();
        },
      });
    });
    request.on('error', reject);
  });
}

function cookieHeaderFrom(response: { headers: Record<string, unknown> }): string {
  const raw = response.headers['set-cookie'];
  const rawCookies = Array.isArray(raw) ? (raw as string[]) : raw !== undefined ? [String(raw)] : [];
  return parseSetCookie
    .parse(rawCookies, { map: false })
    .map((cookie) => `${cookie.name}=${cookie.value}`)
    .join('; ');
}

interface DeployedService {
  readonly label: string;
  readonly serviceId: string;
  readonly deploymentId: string;
  readonly gitConfigs: string[];
  readonly repoUrl: string | null;
}

describe.each(DEPLOY_ENGINE_UBUNTU_VERSIONS)('12-17 / A1-A2: deploy-engine leak canaries, Ubuntu %s', (ubuntu) => {
  let stack: DeployEngineStack | undefined;
  let postgres: PostgresFixture | undefined;
  let redis: RedisFixture | undefined;
  let app: ApiApp | undefined;
  let sse: SseClient | undefined;
  let serviceCredentials: ServiceCredentialsModule | undefined;
  let tempRoot: string | undefined;
  let worker: { close(): Promise<void> } | undefined;
  let cookie = '';
  let serverId = '';
  let projectId = '';
  let environmentId = '';

  const masterKey = randomBytes(32);
  const connections: Redis[] = [];
  const logged: string[] = [];
  const redisMessages: string[] = [];
  const responses: { readonly label: string; readonly body: string }[] = [];
  const deployed: DeployedService[] = [];
  const credentialCanaries: Canary[] = [];

  const s = (): DeployEngineStack => {
    if (stack === undefined) throw new Error('stack not started');
    return stack;
  };
  const db = (): PostgresFixture['db'] => {
    if (postgres === undefined) throw new Error('postgres not started');
    return postgres.db;
  };
  const api = (): ApiApp => {
    if (app === undefined) throw new Error('app not started');
    return app;
  };
  const root = (argv: readonly string[], stdin?: string) =>
    s().exec(argv, stdin === undefined ? { user: 'root' } : { user: 'root', stdin });
  const rootOut = async (argv: readonly string[]): Promise<string> => {
    const result = await root(argv);
    expect(result.exitCode, `${argv.join(' ')}: ${result.stderr}`).toBe(0);
    return result.stdout;
  };

  /** Every API call of the flow goes through here, so every body is checked. */
  const call = async (
    method: 'GET' | 'POST' | 'PUT',
    url: string,
    payload?: unknown,
  ): Promise<{ statusCode: number; body: Json; raw: string }> => {
    const response = await api().inject({
      method,
      url,
      headers: { cookie },
      ...(payload !== undefined ? { payload: payload as Json } : {}),
    });
    responses.push({ label: `${method} ${url}`, body: response.body });
    const body = response.body === '' ? {} : (response.json() as Json);
    return { statusCode: response.statusCode, body, raw: response.body };
  };

  const createService = async (source: Json, internalPort: number, publishedPort?: number): Promise<string> => {
    const created = await call('POST', `/api/projects/${projectId}/services`, {
      environmentId,
      serverId,
      name: `canary-${randomUUID().slice(0, 8)}`,
      source,
      internalPort,
      ...(publishedPort !== undefined ? { publishedPort } : {}),
    });
    expect(created.statusCode, created.raw).toBe(201);
    return String(created.body.id);
  };

  const credentialsUrl = (serviceId: string, slot: 'repository' | 'registry') =>
    `/api/projects/${projectId}/services/${serviceId}/credentials/${slot}`;

  /** Reads every .git/config under the deploy workspaces while a deploy runs (the workspace goes on exit). */
  const watchGitConfigs = (): { stop(): Promise<string[]> } => {
    const captures: string[] = [];
    let running = true;
    const loop = (async () => {
      while (running) {
        const result = await root([
          'sh',
          '-c',
          `find ${WORKSPACE_ROOT} -path '*/.git/config' -type f 2>/dev/null | while read -r f; do echo "== $f"; cat "$f"; done`,
        ]);
        if (result.stdout.trim() !== '') captures.push(result.stdout);
        await delay(GIT_CONFIG_POLL_MS);
      }
    })();
    return {
      stop: async () => {
        running = false;
        await loop;
        return captures;
      },
    };
  };

  const deployThroughApi = async (serviceId: string): Promise<{ deploymentId: string; status: string; gitConfigs: string[] }> => {
    const watcher = watchGitConfigs();
    try {
      const triggered = await call('POST', `/api/services/${serviceId}/deploy`, {});
      expect(triggered.statusCode, triggered.raw).toBe(201);
      const deploymentId = String(triggered.body.id);
      const deadline = Date.now() + TERMINAL_WAIT_MS;
      for (;;) {
        const view = await call('GET', `/api/deployments/${deploymentId}`);
        expect(view.statusCode, view.raw).toBe(200);
        const status = String(view.body.status);
        if (TERMINAL.has(status)) return { deploymentId, status, gitConfigs: await watcher.stop() };
        if (Date.now() > deadline) throw new Error(`deployment ${deploymentId} stuck in ${status}`);
        await delay(POLL_MS);
      }
    } finally {
      await watcher.stop();
    }
  };

  /** Pages the whole deployment log through the API with the (phase, since) cursor. */
  const readAllLogs = async (deploymentId: string): Promise<string> => {
    const texts: string[] = [];
    let cursor = { phase: 'prepare', since: 0 };
    for (let page = 0; page < 1000; page += 1) {
      const response = await call(
        'GET',
        `/api/deployments/${deploymentId}/logs?phase=${cursor.phase}&since=${String(cursor.since)}&limit=100`,
      );
      expect(response.statusCode, response.raw).toBe(200);
      const body = response.body as { items: { phase: string; seq: number; text: string }[]; hasMore: boolean };
      texts.push(...body.items.map((item) => item.text));
      const last = body.items.at(-1);
      if (!body.hasMore || last === undefined) return texts.join('');
      cursor = { phase: last.phase, since: last.seq };
    }
    throw new Error('log paging did not end');
  };

  beforeAll(async () => {
    tempRoot = mkdtempSync(path.join(tmpdir(), 'noodara-canary-deploy-'));
    const httpsRepo = writeCanaryRepo(tempRoot, REPOS.https, BUILD_CANARIES.https);
    const sshRepo = writeCanaryRepo(tempRoot, REPOS.ssh, BUILD_CANARIES.ssh);
    const [stackStarted, pgStarted, redisStarted] = await Promise.all([
      startDeployEngineStack({
        ubuntu,
        seedRepositories: [
          { name: REPOS.https, sourceDir: httpsRepo },
          { name: REPOS.ssh, sourceDir: sshRepo },
        ],
        httpsGit: true,
      }),
      startPostgres(),
      startRedis(),
    ]);
    stack = stackStarted;
    postgres = pgStarted;
    redis = redisStarted;

    process.env.NOODARA_MASTER_KEY = masterKey.toString('base64');
    process.env.BETTER_AUTH_SECRET = `canary-deploy-${randomUUID()}-${randomUUID()}`;
    process.env.DATABASE_URL = postgres.connectionString;
    process.env.REDIS_URL = redis.connectionUrl;
    process.env.NOODARA_PUBLIC_URL = 'http://localhost:3000';

    const { env, DEPLOY_LOG_LINE_MAX_BYTES } = await import('../../../apps/control-plane/src/env.js');
    const runtime = await import('../../../apps/control-plane/src/deploy/deploy-runtime.js');
    const workerModule = await import('../../../apps/control-plane/src/deploy/deploy-worker.js');
    const credentialStore = await import('../../../apps/control-plane/src/services/credential-store.js');
    const publisherModule = await import('../../../apps/control-plane/src/events/redis-server-event-publisher.js');
    const logSink = await import('../../../apps/control-plane/src/deploy/log-sink.js');
    const { issueToken } = await import('../../../apps/control-plane/src/services/setup-token-repository.js');
    const { buildApp } = await import('../../../apps/control-plane/src/app.js');
    serviceCredentials = await import('../../../apps/control-plane/src/services/service-credentials.js');

    // Server row: CONNECTED, Docker + BuildKit present, fingerprint pinned from a first trusted connect.
    const redactor = createRedactor();
    const probe = await createSsh2Adapter().connect({
      target: { host: stack.ssh.host, port: stack.ssh.port, user: stack.ssh.user },
      credential: { kind: 'private_key', privateKey: secretValue(stack.ssh.privateKey, 'ssh_private_key') },
      timeouts: { connectMs: 20_000, commandMs: 60_000, discoveryMs: 120_000 },
      trustedFingerprint: null,
      redactor,
    });
    if (!probe.ok) throw new Error(`fingerprint probe failed: ${probe.errorCode}`);
    const fingerprint = formatFingerprint(probe.fingerprint);
    await probe.session.close();
    const encoded = credentialStore.encodeCredential(
      { kind: 'private_key', privateKey: stack.ssh.privateKey },
      { key: masterKey, version: KEY_VERSION },
      redactor,
    );
    if (!encoded.ok) throw new Error(`server credential rejected: ${encoded.code}`);
    const [credentialRow] = await db()
      .insert(credentials)
      .values({ type: encoded.type, encryptedValue: encoded.encryptedValue, keyVersion: encoded.keyVersion })
      .returning({ id: credentials.id });
    if (!credentialRow) throw new Error('credential insert returned no row');
    const [serverRow] = await db()
      .insert(servers)
      .values({
        name: `canary-host-${ubuntu}`,
        host: stack.ssh.host,
        sshPort: stack.ssh.port,
        sshUser: stack.ssh.user,
        credentialId: credentialRow.id,
        status: 'CONNECTED',
        hostFingerprint: fingerprint,
        dockerInstalled: true,
        dockerBuildkitAvailable: true,
      })
      .returning({ id: servers.id });
    if (!serverRow) throw new Error('server insert returned no row');
    serverId = serverRow.id;

    // API: real HTTP listener (SSE), real Redis subscriber, admin session.
    app = buildApp({});
    await app.listen({ port: 0, host: '127.0.0.1' });
    const port = (app.server.address() as AddressInfo).port;
    const issued = await issueToken(db(), 'setup', new Date());
    const setup = await app.inject({
      method: 'POST',
      url: '/api/setup',
      payload: { token: revealSecret(issued.token), email: ADMIN_EMAIL, password: ADMIN_PASSWORD, name: 'Admin' },
    });
    if (setup.statusCode !== 200) throw new Error(`setup failed: ${String(setup.statusCode)}`);
    const signIn = await app.inject({
      method: 'POST',
      url: '/api/auth/sign-in/email',
      payload: { email: ADMIN_EMAIL, password: ADMIN_PASSWORD },
    });
    if (signIn.statusCode !== 200) throw new Error(`sign-in failed: ${String(signIn.statusCode)}`);
    cookie = cookieHeaderFrom(signIn);

    // Every raw Redis payload on the events channel, as any subscriber would see it.
    const tap = new Redis(redis.connectionUrl, { maxRetriesPerRequest: null });
    connections.push(tap);
    await tap.subscribe(publisherModule.SERVER_EVENTS_CHANNEL);
    tap.on('message', (_channel: string, message: string) => {
      redisMessages.push(message);
    });
    const subscriberProbe = new Redis(redis.connectionUrl, { maxRetriesPerRequest: null });
    connections.push(subscriberProbe);
    const deadline = Date.now() + 20_000;
    for (;;) {
      const counts = (await subscriberProbe.call('PUBSUB', 'NUMSUB', publisherModule.SERVER_EVENTS_CHANNEL)) as [string, number];
      if (Number(counts[1]) >= 2) break;
      if (Date.now() > deadline) throw new Error('the API never subscribed to the events channel');
      await delay(100);
    }
    sse = await openSse(port, cookie);

    // Worker: the src/worker.ts wiring, with a recording logger; the build canaries ride every run's
    // redactor, as a registered secret value would.
    const record = (level: string) => (fields: Record<string, unknown>, message: string) => {
      logged.push(JSON.stringify({ level, fields, message }));
    };
    const logger = { info: record('info'), warn: record('warn'), error: record('error') };
    const publisherConnection = new Redis(redis.connectionUrl, { maxRetriesPerRequest: null });
    connections.push(publisherConnection);
    const events = publisherModule.createRedisServerEventPublisher(publisherConnection, logger as never);
    const baseDeps = runtime.createDeployJobDeps({
      db: db(),
      events,
      ssh: createSsh2Adapter(),
      timeouts: { connectMs: 20_000, commandMs: 60_000, discoveryMs: 120_000 },
      masterKeys: () => Promise.resolve({ current: masterKey }),
      panelPorts: [],
      config: {
        deployMaxMs: DEPLOY_MAX_MS,
        idleMs: 120_000,
        logMaxBytes: env.NOODARA_DEPLOY_LOG_MAX_BYTES,
        logLineMaxBytes: DEPLOY_LOG_LINE_MAX_BYTES,
      },
      logger,
    });
    const sinks = logSink.createDeploymentLogSinkFactory({
      writer: logSink.createDbLogChunkWriter(db()),
      events,
      logger,
      policy: {
        flushIntervalMs: env.NOODARA_DEPLOY_LOG_FLUSH_MS,
        flushBytes: env.NOODARA_DEPLOY_LOG_FLUSH_BYTES,
        maxLineBytes: DEPLOY_LOG_LINE_MAX_BYTES,
        maxPhaseBytes: env.NOODARA_DEPLOY_LOG_MAX_BYTES,
      },
    });
    const handler = workerModule.createDeployJobHandler({
      ...baseDeps,
      createRedactor: () => {
        const runRedactor = createRedactor();
        runRedactor.register(BUILD_CANARIES.https, 'token');
        runRedactor.register(BUILD_CANARIES.ssh, 'token');
        return runRedactor;
      },
      sinkFor: (deploymentId) => sinks(deploymentId),
    });
    const workerConnection = new Redis(redis.connectionUrl, { maxRetriesPerRequest: null });
    connections.push(workerConnection);
    worker = runtime.startDeployWorker({
      handler,
      connection: workerConnection,
      concurrency: 1,
      deployMaxMs: DEPLOY_MAX_MS,
      logger,
    });

    const project = await call('POST', '/api/projects', { name: `Canary ${randomUUID().slice(0, 8)}` });
    expect(project.statusCode, project.raw).toBe(201);
    projectId = String(project.body.id);
    const environment = await call('POST', `/api/projects/${projectId}/environments`, { name: 'production' });
    expect(environment.statusCode, environment.raw).toBe(201);
    environmentId = String(environment.body.id);
  }, STACK_TIMEOUT_MS);

  afterAll(async () => {
    sse?.close();
    await worker?.close();
    await app?.close();
    for (const connection of connections) connection.disconnect();
    await redis?.stop();
    await postgres?.stop();
    await stack?.stop();
    if (tempRoot !== undefined) rmSync(tempRoot, { recursive: true, force: true });
  }, STACK_TIMEOUT_MS);

  it(
    'A1: an HTTPS-token clone, a Noodara-generated deploy key, a registry pull and a canary-printing build all deploy',
    async () => {
      const httpsGit = s().httpsGit;
      if (httpsGit === null) throw new Error('stack started without httpsGit');
      const registry = s().registry;
      credentialCanaries.push(
        { label: 'https token', value: httpsGit.token },
        { label: 'https basic auth', value: Buffer.from(`${GIT_HTTPS_USERNAME}:${httpsGit.token}`).toString('base64') },
        { label: 'registry password', value: registry.password },
        { label: 'registry basic auth', value: Buffer.from(`${registry.username}:${registry.password}`).toString('base64') },
      );

      // HTTPS token: askpass clone of the canary build over the fixture's HTTPS remote.
      const httpsUrl = httpsGit.repoUrl(REPOS.https);
      const httpsService = await createService({ kind: 'git', repositoryUrl: httpsUrl, branch: 'main' }, 3000);
      const httpsCredential = await call('PUT', credentialsUrl(httpsService, 'repository'), {
        kind: 'https_token',
        token: httpsGit.token,
      });
      expect(httpsCredential.statusCode, httpsCredential.raw).toBe(200);

      // Deploy key: generated by Noodara; only its public half leaves the API, and it is authorized
      // on the git host the way a user adds it to their provider.
      const sshUrl = s().gitRepoUrl(REPOS.ssh);
      const sshService = await createService({ kind: 'git', repositoryUrl: sshUrl, branch: 'main' }, 3000);
      const generated = await call('PUT', credentialsUrl(sshService, 'repository'), { kind: 'deploy_key' });
      expect(generated.statusCode, generated.raw).toBe(200);
      const publicKey = (generated.body.repository as { publicKey: string | null } | null)?.publicKey;
      expect(publicKey).toMatch(/^ssh-ed25519 /);
      const authorize = await root(
        ['sh', '-c', 'cat >> /home/git/.ssh/authorized_keys'],
        `no-port-forwarding,no-agent-forwarding,no-X11-forwarding,no-pty ${String(publicKey)}\n`,
      );
      expect(authorize.exitCode, authorize.stderr).toBe(0);
      const [sshRow] = await db()
        .select({ type: credentials.type, encryptedValue: credentials.encryptedValue, keyVersion: credentials.keyVersion })
        .from(services)
        .innerJoin(credentials, eq(credentials.id, services.repositoryCredentialId))
        .where(eq(services.id, sshService));
      if (!sshRow) throw new Error('generated deploy key row missing');
      if (serviceCredentials === undefined) throw new Error('modules not loaded');
      const decoded = serviceCredentials.decodeServiceCredential(sshRow, { current: masterKey });
      if (decoded.kind !== 'deploy_key') throw new Error(`expected a deploy key, got ${decoded.kind}`);
      credentialCanaries.push(...privateKeyCanaries('deploy key', revealSecret(decoded.privateKey)));

      // Registry password: an image source pulled from the htpasswd registry.
      const nginx = s().baseImages.find((ref) => ref.startsWith('nginx:'));
      if (nginx === undefined) throw new Error('harness preloaded no nginx base image');
      const imageService = await createService({ kind: 'image', imageRef: preloadedRefFor(registry.host, nginx) }, 80, IMAGE_PORT);
      const registryCredential = await call('PUT', credentialsUrl(imageService, 'registry'), {
        host: registry.host,
        username: registry.username,
        password: registry.password,
      });
      expect(registryCredential.statusCode, registryCredential.raw).toBe(200);

      for (const [label, serviceId, repoUrl] of [
        ['https-token', httpsService, httpsUrl],
        ['deploy-key', sshService, sshUrl],
        ['registry', imageService, null],
      ] as const) {
        const run = await deployThroughApi(serviceId);
        const [row] = await db()
          .select({ status: deployments.status, errorCode: deployments.errorCode })
          .from(deployments)
          .where(eq(deployments.id, run.deploymentId));
        expect({ label, status: row?.status, errorCode: row?.errorCode }).toEqual({ label, status: 'SUCCESS', errorCode: null });
        deployed.push({ label, serviceId, deploymentId: run.deploymentId, gitConfigs: run.gitConfigs, repoUrl });
      }
    },
    CASE_TIMEOUT_MS,
  );

  it(
    'A2/SEC: no canary reaches build logs, log chunks, SSE, activity metadata, API responses, docker inspect/history or .git/config',
    async () => {
      expect(deployed).toHaveLength(3);
      const buildCanaries: Canary[] = [
        { label: 'build canary (https repo)', value: BUILD_CANARIES.https },
        { label: 'build canary (ssh repo)', value: BUILD_CANARIES.ssh },
      ];
      const every = [...credentialCanaries, ...buildCanaries];
      const surfaces = new Map<string, string>();

      // Build logs: the logs API, deployment_log_chunks, the worker's own logger.
      for (const { label, deploymentId, serviceId } of deployed) {
        surfaces.set(`logs API (${label})`, await readAllLogs(deploymentId));
        const chunks = await db().select().from(deploymentLogChunks).where(eq(deploymentLogChunks.deploymentId, deploymentId));
        expect(chunks.length, `${label} wrote no log chunks`).toBeGreaterThan(0);
        surfaces.set(`deployment_log_chunks (${label})`, JSON.stringify(chunks));
        // The rest of the API the flow touches.
        for (const url of [
          `/api/deployments/${deploymentId}`,
          `/api/services/${serviceId}/deployments`,
          `/api/services/${serviceId}/deployments/${deploymentId}`,
          `/api/projects/${projectId}/services/${serviceId}`,
          `/api/projects/${projectId}/services/${serviceId}/credentials`,
          `/api/projects/${projectId}/services/${serviceId}/logs`,
        ]) {
          await call('GET', url);
        }
      }
      await call('GET', `/api/projects/${projectId}/services`);
      await call('GET', '/api/activity');
      surfaces.set('worker logger', logged.join('\n'));

      // The build canaries were printed and arrived redacted, not dropped: the proof is not vacuous.
      for (const { label } of deployed.filter((entry) => entry.repoUrl !== null)) {
        const text = surfaces.get(`logs API (${label})`) ?? '';
        expect(text, `${label}: the build never printed its canary line`).toMatch(/noodara-build-canary \[REDACTED:/);
        expect(text).toMatch(/noodara-build-canary-stderr \[REDACTED:/);
        expect(text).toContain('noodara-build-canary-done');
      }

      // SSE stream and the raw Redis payloads behind it.
      const client = sse;
      if (client === undefined) throw new Error('SSE client not open');
      const deploymentIds = new Set(deployed.map((entry) => entry.deploymentId));
      const streamed = client.frames.filter(
        (frame) => frame.type === 'deployment.log_chunk' && deploymentIds.has(String(frame.data.deploymentId)),
      );
      expect(streamed.length, 'the SSE client saw no log chunks of these deployments').toBeGreaterThan(0);
      surfaces.set('SSE stream', client.raw.join(''));
      surfaces.set('Redis events channel', redisMessages.join('\n'));

      // activity_events.metadata, and the deployment/service/credential rows themselves.
      const activity = await db().select({ action: activityEvents.action, metadata: activityEvents.metadata }).from(activityEvents);
      expect(activity.length).toBeGreaterThan(0);
      surfaces.set('activity_events.metadata', JSON.stringify(activity));
      surfaces.set('deployments rows', JSON.stringify(await db().select().from(deployments)));
      surfaces.set('services rows', JSON.stringify(await db().select().from(services)));
      surfaces.set('credentials rows (ciphertext)', JSON.stringify(await db().select().from(credentials)));

      // Every API response of the flow, setup to teardown.
      expect(responses.length).toBeGreaterThan(10);
      for (const [index, response] of responses.entries()) {
        surfaces.set(`API #${String(index)} ${response.label}`, response.body);
      }

      // docker inspect / history of every container and the image it runs, as root on the host.
      for (const { label, serviceId } of deployed) {
        const container = `noodara-${serviceId}`;
        const containerInspect = await rootOut(['docker', 'container', 'inspect', container]);
        surfaces.set(`docker container inspect (${label})`, containerInspect);
        const imageId = (await rootOut(['docker', 'container', 'inspect', container, '--format', '{{.Image}}'])).trim();
        surfaces.set(`docker image inspect (${label})`, await rootOut(['docker', 'image', 'inspect', imageId]));
        surfaces.set(`docker history (${label})`, await rootOut(['docker', 'history', '--no-trunc', imageId]));
        surfaces.set(
          `docker history json (${label})`,
          await rootOut(['docker', 'history', '--no-trunc', '--format', '{{json .}}', imageId]),
        );
      }

      // The remote .git/config, read while each clone existed: origin is the bare URL, no credential.
      for (const { label, gitConfigs, repoUrl } of deployed) {
        if (repoUrl === null) continue;
        const joined = gitConfigs.join('\n');
        expect(joined, `${label}: no .git/config was captured during the deploy`).toContain('[remote "origin"]');
        expect(joined).toContain(`url = ${repoUrl}`);
        expect(joined).not.toMatch(/\[credential|extraheader|helper\s*=/i);
        surfaces.set(`.git/config (${label})`, joined);
      }

      for (const [surface, text] of surfaces) {
        expect(leaksIn(text, every), `${surface} leaked a canary`).toEqual([]);
      }

      // Nothing secret persisted on the host after the runs (the seeded repos legitimately hold the
      // build canary, so only credential canaries are swept). Patterns arrive on stdin, never argv.
      const sweep = await root(
        [
          'sh',
          '-c',
          `grep -rlF --exclude='noodara-stdin-*' -f /dev/stdin ${WORKSPACE_ROOT} /home/deployer /root /tmp 2>/dev/null || true`,
        ],
        `${credentialCanaries.map((canary) => canary.value.split('\n')[0] ?? '').filter((line) => line.length >= 24 && !line.startsWith('-----')).join('\n')}\n`,
      );
      expect(sweep.stdout.trim(), 'a credential canary persisted on the deploy host').toBe('');
    },
    CASE_TIMEOUT_MS,
  );
});
