// 12-12 (A1-A5, H1): the build-log pipeline end to end on the real sshd + dockerd fixture.
// triggerDeploy -> BullMQ deploy worker -> runDeployment -> per-run redactor -> chunked sink
// (createDeploymentLogSinkFactory, the same wiring src/worker.ts uses) -> deployment_log_chunks +
// Redis -> the API's SSE broadcaster -> a real HTTP SSE client, plus GET /api/deployments/:id/logs.
// The API and the worker share this process, so the RSS numbers of A5 cover both.
// App modules are imported dynamically after a valid test env is written (env.ts fail-fasts, INST-06).
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import http, { type IncomingMessage, type ServerResponse } from 'node:http';
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
  credentials,
  deploymentLogChunks,
  deployments,
  environments,
  projects,
  servers,
  services,
} from '../../../apps/control-plane/src/db/schema/index.js';
import type { ServerEvent } from '../../../apps/control-plane/src/events/server-event-publisher.js';
import type { ChunkedDeploymentLogSink } from '../../../apps/control-plane/src/deploy/log-sink.js';
import {
  DEPLOY_ENGINE_UBUNTU_VERSIONS,
  resolveBaseImages,
  startDeployEngineStack,
  type DeployEngineStack,
} from '../helpers/deploy-engine.js';
import { startPostgres, type PostgresFixture } from '../helpers/postgres.js';
import { startRedis, type RedisFixture } from '../helpers/redis.js';

type DeployRuntimeModule = typeof import('../../../apps/control-plane/src/deploy/deploy-runtime.js');
type DeployWorkerModule = typeof import('../../../apps/control-plane/src/deploy/deploy-worker.js');
type LogSinkModule = typeof import('../../../apps/control-plane/src/deploy/log-sink.js');
type ApiApp = ReturnType<(typeof import('../../../apps/control-plane/src/app.js'))['buildApp']>;
type LogRetentionModule = typeof import('../../../apps/control-plane/src/deploy/log-retention.js');

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES_DIR = path.resolve(HERE, '../../../fixtures');
const STACK_TIMEOUT_MS = 900_000;
const CASE_TIMEOUT_MS = 600_000;
const TERMINAL_WAIT_MS = 400_000;
const POLL_MS = 500;
const KEY_VERSION = 1;
const DEPLOY_MAX_MS = 400_000;
const TERMINAL = new Set(['SUCCESS', 'FAILED', 'CANCELLED']);
const LINE_CAP = 16_384;
/** A1/A2: the canary run gets a small per-phase cap so the truncation notice is reached. */
const CANARY_PHASE_CAP = 65_536;
/** A5: how long the chatty build keeps logging. */
const CHATTY_MS = 150_000;
const RETENTION_DAYS = 30;
const SSE_MAX_BUFFERED_BYTES = 1_048_576;
const ADMIN_EMAIL = 'admin@noodara.test';
const ADMIN_PASSWORD = 'correct horse battery staple';

// A1: a per-run canary, registered with every run's redactor; the canary build prints it in two
// halves 1.5 s apart (across sink flushes and SSH data events) and straddling the line cap.
const HALF_A = `cnryA${randomBytes(12).toString('hex')}`;
const HALF_B = `cnryB${randomBytes(12).toString('hex')}`;
const CANARY = `${HALF_A}${HALF_B}`;

const REPOS = { nodeApi: 'node-api', canary: 'log-canary', chatty: 'log-chatty' } as const;

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function nodeBaseOf(baseImages: readonly string[]): string {
  const base = baseImages.find((ref) => ref.startsWith('node:'));
  if (base === undefined) throw new Error('harness preloaded no node base image');
  return base;
}

const KEEP_ALIVE_CMD = 'CMD ["node","-e","setInterval(() => {}, 1000)"]';

function writeTempRepos(root: string, nodeBase: string): Record<'canary' | 'chatty', string> {
  const write = (name: string, files: Record<string, string>): string => {
    const dir = path.join(root, name);
    mkdirSync(dir, { recursive: true });
    for (const [file, content] of Object.entries(files)) writeFileSync(path.join(dir, file), content);
    return dir;
  };
  const canaryScript = [
    `const a = ${JSON.stringify(HALF_A)};`,
    `const b = ${JSON.stringify(HALF_B)};`,
    'const out = (s) => process.stdout.write(s);',
    "out('noodara-canary-begin ' + a);",
    'setTimeout(() => {',
    "  out(b + ' noodara-canary-end\\n');",
    "  out('L'.repeat(16384 - 40) + a + b + 'L'.repeat(4000) + '\\n');",
    "  out('x'.repeat(40000) + '\\n');",
    "  for (let i = 0; i < 1500; i++) out('noodara-filler ' + i + ' ' + 'f'.repeat(100) + '\\n');",
    "  out('after-cap ' + a + b + '\\n');",
    '}, 1500);',
    '',
  ].join('\n');
  const chattyScript = [
    `const end = Date.now() + ${String(CHATTY_MS)};`,
    'let i = 0;',
    'const timer = setInterval(() => {',
    "  for (let k = 0; k < 5; k++) process.stdout.write('noodara-tick ' + i++ + ' ' + 'c'.repeat(120) + '\\n');",
    '  if (Date.now() > end) clearInterval(timer);',
    '}, 100);',
    '',
  ].join('\n');
  return {
    canary: write(REPOS.canary, {
      'emit.js': canaryScript,
      Dockerfile: [`FROM ${nodeBase}`, 'COPY emit.js /emit.js', 'RUN node /emit.js', KEEP_ALIVE_CMD, ''].join('\n'),
    }),
    chatty: write(REPOS.chatty, {
      'chatty.js': chattyScript,
      Dockerfile: [`FROM ${nodeBase}`, 'COPY chatty.js /chatty.js', 'RUN node /chatty.js', KEEP_ALIVE_CMD, ''].join('\n'),
    }),
  };
}

interface SseFrame {
  readonly type: string;
  readonly data: Record<string, unknown>;
  readonly raw: string;
}

interface SseClient {
  readonly statusCode: number;
  readonly frames: SseFrame[];
  isClosed(): boolean;
  close(): void;
}

function openSse(port: number, cookie: string): Promise<SseClient> {
  return new Promise((resolve, reject) => {
    const request = http.get({ host: '127.0.0.1', port, path: '/api/events', headers: { cookie } }, (response) => {
      const frames: SseFrame[] = [];
      let buffer = '';
      let closed = false;
      response.setEncoding('utf8');
      response.on('data', (chunk: string) => {
        buffer += chunk;
        for (let index = buffer.indexOf('\n\n'); index !== -1; index = buffer.indexOf('\n\n')) {
          const raw = buffer.slice(0, index);
          buffer = buffer.slice(index + 2);
          const type = /^event: (.+)$/m.exec(raw)?.[1];
          const data = /^data: (.+)$/m.exec(raw)?.[1];
          if (type !== undefined && data !== undefined) {
            frames.push({ type, data: JSON.parse(data) as Record<string, unknown>, raw });
          }
        }
      });
      const markClosed = (): void => {
        closed = true;
      };
      response.on('end', markClosed);
      response.on('close', markClosed);
      response.on('error', markClosed);
      resolve({
        statusCode: response.statusCode ?? 0,
        frames,
        isClosed: () => closed,
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

interface LoggedLine {
  readonly level: string;
  readonly fields: Record<string, unknown>;
  readonly message: string;
}

interface LogChunkFrame {
  readonly deploymentId: string;
  readonly phase: string;
  readonly seq: number;
  readonly text: string;
}

function asLogChunk(frame: SseFrame): LogChunkFrame | null {
  if (frame.type !== 'deployment.log_chunk') return null;
  const { deploymentId, phase, seq, text } = frame.data;
  if (typeof deploymentId !== 'string' || typeof phase !== 'string' || typeof seq !== 'number' || typeof text !== 'string') {
    return null;
  }
  return { deploymentId, phase, seq, text };
}

describe.each(DEPLOY_ENGINE_UBUNTU_VERSIONS)('12-12 / A1-A5: build logs on real infrastructure, Ubuntu %s', (ubuntu) => {
  let stack: DeployEngineStack | undefined;
  let postgres: PostgresFixture | undefined;
  let redis: RedisFixture | undefined;
  let app: ApiApp | undefined;
  let port = 0;
  let cookie = '';
  const connections: Redis[] = [];
  let worker: { close(): Promise<void> } | undefined;
  let queue: { close(): Promise<void> } | undefined;
  let tempRoot: string | undefined;
  let triggerDeploy: ((serviceId: string) => Promise<string>) | undefined;
  let logSink: LogSinkModule | undefined;
  let logRetention: LogRetentionModule | undefined;
  let retentionDays = 0;

  const masterKey = randomBytes(32);
  const logged: LoggedLine[] = [];
  const redisMessages: string[] = [];
  const sseResponses: ServerResponse[] = [];
  const sinks = new Map<string, ChunkedDeploymentLogSink>();
  const smallCapServices = new Set<string>();
  let projectId = '';
  let environmentId = '';
  let serverId = '';
  let policy = { flushIntervalMs: 0, flushBytes: 0, maxLineBytes: 0, maxPhaseBytes: 0 };

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
  const sinkModule = (): LogSinkModule => {
    if (logSink === undefined) throw new Error('modules not loaded');
    return logSink;
  };

  const insertGitService = async (repo: string, credentialId: string): Promise<string> => {
    const [row] = await db()
      .insert(services)
      .values({
        projectId,
        environmentId,
        serverId,
        name: `svc-${randomUUID().slice(0, 8)}`,
        sourceType: 'git',
        repositoryUrl: s().gitRepoUrl(repo),
        branch: 'main',
        buildContext: '.',
        dockerfilePath: 'Dockerfile',
        internalPort: 3000,
        publishedPort: null,
        repositoryCredentialId: credentialId,
      })
      .returning({ id: services.id });
    if (!row) throw new Error('service insert returned no row');
    return row.id;
  };

  const deploymentRow = async (deploymentId: string) => {
    const [row] = await db().select().from(deployments).where(eq(deployments.id, deploymentId));
    if (!row) throw new Error(`deployment ${deploymentId} missing`);
    return row;
  };

  const waitTerminal = async (deploymentId: string) => {
    const deadline = Date.now() + TERMINAL_WAIT_MS;
    for (;;) {
      const row = await deploymentRow(deploymentId);
      if (TERMINAL.has(row.status)) return row;
      if (Date.now() > deadline) throw new Error(`deployment ${deploymentId} stuck in ${row.status}`);
      await delay(POLL_MS);
    }
  };

  const trigger = async (serviceId: string): Promise<string> => {
    if (triggerDeploy === undefined) throw new Error('runtime not started');
    return triggerDeploy(serviceId);
  };

  const chunkRows = (deploymentId: string) =>
    db()
      .select()
      .from(deploymentLogChunks)
      .where(eq(deploymentLogChunks.deploymentId, deploymentId))
      .orderBy(deploymentLogChunks.phase, deploymentLogChunks.seq);

  const getLogs = (deploymentId: string, query: string, withCookie = true) =>
    api().inject({
      method: 'GET',
      url: `/api/deployments/${deploymentId}/logs${query}`,
      headers: withCookie ? { cookie } : {},
    });

  /** Pages the whole log through the API with the (phase, since) cursor. */
  const readAllLogs = async (deploymentId: string) => {
    const items: { phase: string; seq: number; text: string }[] = [];
    let cursor = { phase: 'prepare', since: 0 };
    for (let page = 0; page < 1000; page += 1) {
      const response = await getLogs(deploymentId, `?phase=${cursor.phase}&since=${String(cursor.since)}&limit=100`);
      expect(response.statusCode).toBe(200);
      const body = response.json<{ items: { phase: string; seq: number; text: string }[]; hasMore: boolean }>();
      items.push(...body.items);
      const last = body.items.at(-1);
      if (!body.hasMore || last === undefined) return items;
      cursor = { phase: last.phase, since: last.seq };
    }
    throw new Error('log paging did not end');
  };

  let serviceKeyFor: (() => Promise<string>) | undefined;
  const newService = async (repo: string): Promise<string> => {
    if (serviceKeyFor === undefined) throw new Error('runtime not started');
    return insertGitService(repo, await serviceKeyFor());
  };

  const sseChunks = (client: SseClient, deploymentId: string): LogChunkFrame[] =>
    client.frames.flatMap((frame) => {
      const chunk = asLogChunk(frame);
      return chunk !== null && chunk.deploymentId === deploymentId ? [chunk] : [];
    });

  beforeAll(async () => {
    const [stackStarted, pgStarted, redisStarted] = await Promise.all([
      (async () => {
        const base = nodeBaseOf(resolveBaseImages());
        tempRoot = mkdtempSync(path.join(tmpdir(), 'noodara-runtime-build-logs-'));
        const temp = writeTempRepos(tempRoot, base);
        return startDeployEngineStack({
          ubuntu,
          seedRepositories: [
            { name: REPOS.nodeApi, sourceDir: path.join(FIXTURES_DIR, 'node-api') },
            { name: REPOS.canary, sourceDir: temp.canary },
            { name: REPOS.chatty, sourceDir: temp.chatty },
          ],
        });
      })(),
      startPostgres(),
      startRedis(),
    ]);
    stack = stackStarted;
    postgres = pgStarted;
    redis = redisStarted;

    process.env.NOODARA_MASTER_KEY = masterKey.toString('base64');
    process.env.BETTER_AUTH_SECRET = `runtime-build-logs-${randomUUID()}-${randomUUID()}`;
    process.env.DATABASE_URL = postgres.connectionString;
    process.env.REDIS_URL = redis.connectionUrl;
    process.env.NOODARA_PUBLIC_URL = 'http://localhost:3000';
    process.env.NOODARA_DEPLOY_LOG_MAX_BYTES = String(4 * 1024 * 1024);
    process.env.NOODARA_DEPLOY_LOG_RETENTION_DAYS = String(RETENTION_DAYS);

    const { env, DEPLOY_LOG_LINE_MAX_BYTES } = await import('../../../apps/control-plane/src/env.js');
    const runtime: DeployRuntimeModule = await import('../../../apps/control-plane/src/deploy/deploy-runtime.js');
    const workerModule: DeployWorkerModule = await import('../../../apps/control-plane/src/deploy/deploy-worker.js');
    const deploymentServices = await import('../../../apps/control-plane/src/services/deployment-services.js');
    const queueModule = await import('../../../apps/control-plane/src/queue/deploy-queue.js');
    const credentialStore = await import('../../../apps/control-plane/src/services/credential-store.js');
    const serviceCredentials = await import('../../../apps/control-plane/src/services/service-credentials.js');
    const publisherModule = await import('../../../apps/control-plane/src/events/redis-server-event-publisher.js');
    const { issueToken } = await import('../../../apps/control-plane/src/services/setup-token-repository.js');
    const { buildApp } = await import('../../../apps/control-plane/src/app.js');
    logSink = await import('../../../apps/control-plane/src/deploy/log-sink.js');
    logRetention = await import('../../../apps/control-plane/src/deploy/log-retention.js');
    retentionDays = env.NOODARA_DEPLOY_LOG_RETENTION_DAYS;
    policy = {
      flushIntervalMs: env.NOODARA_DEPLOY_LOG_FLUSH_MS,
      flushBytes: env.NOODARA_DEPLOY_LOG_FLUSH_BYTES,
      maxLineBytes: DEPLOY_LOG_LINE_MAX_BYTES,
      maxPhaseBytes: env.NOODARA_DEPLOY_LOG_MAX_BYTES,
    };

    // Server row: CONNECTED, Docker present, fingerprint pinned from a first trusted connect.
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
        name: `log-host-${ubuntu}`,
        host: stack.ssh.host,
        sshPort: stack.ssh.port,
        sshUser: stack.ssh.user,
        credentialId: credentialRow.id,
        status: 'CONNECTED',
        hostFingerprint: fingerprint,
        dockerInstalled: true,
      })
      .returning({ id: servers.id });
    if (!serverRow) throw new Error('server insert returned no row');
    serverId = serverRow.id;

    const now = new Date();
    const [projectRow] = await db()
      .insert(projects)
      .values({ name: 'Build logs', slug: `logs-${randomUUID().slice(0, 8)}`, createdAt: now, updatedAt: now })
      .returning({ id: projects.id });
    if (!projectRow) throw new Error('project insert returned no row');
    projectId = projectRow.id;
    const [environmentRow] = await db()
      .insert(environments)
      .values({ projectId, name: 'production', createdAt: now, updatedAt: now })
      .returning({ id: environments.id });
    if (!environmentRow) throw new Error('environment insert returned no row');
    environmentId = environmentRow.id;

    // The repository deploy key every service clones with (one row per service, as the API does).
    const insertDeployKey = async (): Promise<string> => {
      const credential = serviceCredentials.encodeServiceCredential(
        {
          kind: 'deploy_key',
          privateKey: secretValue(s().deployKey.privateKey, 'ssh_private_key'),
          publicKey: s().deployKey.publicKey,
        },
        { key: masterKey, version: KEY_VERSION },
      );
      return db().transaction((tx) => serviceCredentials.insertServiceCredential(tx, credential, new Date()));
    };
    serviceKeyFor = insertDeployKey;

    // API: real HTTP listener, real Redis subscriber, admin session.
    app = buildApp({});
    app.server.on('request', (request: IncomingMessage, response: ServerResponse) => {
      if (request.url === '/api/events') sseResponses.push(response);
    });
    await app.listen({ port: 0, host: '127.0.0.1' });
    port = (app.server.address() as AddressInfo).port;
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

    // A1: every raw Redis payload on the events channel, as any subscriber would see it.
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
      // The tap plus the API's own subscriber.
      if (Number(counts[1]) >= 2) break;
      if (Date.now() > deadline) throw new Error('the API never subscribed to the events channel');
      await delay(100);
    }

    // Worker: the same wiring src/worker.ts uses, publishing through a real Redis publisher.
    const logger = {
      info: (fields: Record<string, unknown>, message: string) => logged.push({ level: 'info', fields, message }),
      warn: (fields: Record<string, unknown>, message: string) => logged.push({ level: 'warn', fields, message }),
      error: (fields: Record<string, unknown>, message: string) => logged.push({ level: 'error', fields, message }),
    };
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
    const writer = logSink.createDbLogChunkWriter(db());
    const productionSinks = logSink.createDeploymentLogSinkFactory({ writer, events, logger, policy });
    const smallCapSinks = logSink.createDeploymentLogSinkFactory({
      writer,
      events,
      logger,
      policy: { ...policy, maxPhaseBytes: CANARY_PHASE_CAP },
    });
    // A1: the per-run canary rides every run's redactor.
    const createCanaryRedactor = () => {
      const runRedactor = createRedactor();
      runRedactor.register(CANARY, 'token');
      return runRedactor;
    };
    const handlerWith = (factory: (deploymentId: string) => ChunkedDeploymentLogSink) =>
      workerModule.createDeployJobHandler({
        ...baseDeps,
        createRedactor: createCanaryRedactor,
        sinkFor: (deploymentId) => {
          const sink = factory(deploymentId);
          sinks.set(deploymentId, sink);
          return sink;
        },
      });
    const productionHandler = handlerWith(productionSinks);
    const smallCapHandler = handlerWith(smallCapSinks);
    const handler = (data: unknown, signal?: AbortSignal) => {
      const serviceId = (data as { serviceId?: unknown } | null)?.serviceId;
      return typeof serviceId === 'string' && smallCapServices.has(serviceId)
        ? smallCapHandler(data, signal)
        : productionHandler(data, signal);
    };
    const workerConnection = new Redis(redis.connectionUrl, { maxRetriesPerRequest: null });
    const queueConnection = new Redis(redis.connectionUrl, { maxRetriesPerRequest: null });
    connections.push(workerConnection, queueConnection);
    worker = runtime.startDeployWorker({
      handler,
      connection: workerConnection,
      concurrency: 2,
      deployMaxMs: DEPLOY_MAX_MS,
      logger,
    });
    const deployQueue = queueModule.createDeployQueue({ connection: queueConnection, enqueueTimeoutMs: 10_000 });
    queue = deployQueue;
    const deploymentApi = deploymentServices.createDeploymentServices({
      db: db(),
      now: () => new Date(),
      events,
      queue: deployQueue,
      logger,
    });
    triggerDeploy = async (serviceId) => {
      const result = await deploymentApi.triggerDeploy({ actor: { type: 'system' }, serviceId });
      if (!result.ok) throw new Error(`triggerDeploy failed: ${result.code}`);
      return result.deployment.id;
    };
  }, STACK_TIMEOUT_MS);

  afterAll(async () => {
    await worker?.close();
    await queue?.close();
    await app?.close();
    for (const connection of connections) connection.disconnect();
    await redis?.stop();
    await postgres?.stop();
    await stack?.stop();
    if (tempRoot !== undefined) rmSync(tempRoot, { recursive: true, force: true });
  }, STACK_TIMEOUT_MS);

  let nodeApiDeploymentId = '';
  let canaryDeploymentId = '';

  it(
    'A3: deployment.log_chunk reaches an SSE client live during a node-api build; logs?since returns only later chunks',
    async () => {
      const client = await openSse(port, cookie);
      expect(client.statusCode).toBe(200);
      try {
        const serviceId = await newService(REPOS.nodeApi);
        nodeApiDeploymentId = await trigger(serviceId);
        const row = await waitTerminal(nodeApiDeploymentId);
        expect({ status: row.status, errorCode: row.errorCode }).toEqual({ status: 'SUCCESS', errorCode: null });
        await delay(1000);

        // Live: the first build chunk precedes the terminal deployment.updated on the same stream.
        const indexOf = (predicate: (frame: SseFrame) => boolean): number => client.frames.findIndex(predicate);
        const firstBuildChunk = indexOf(
          (frame) => asLogChunk(frame)?.deploymentId === nodeApiDeploymentId && asLogChunk(frame)?.phase === 'build',
        );
        const terminal = indexOf(
          (frame) =>
            frame.type === 'deployment.updated' &&
            (frame.data.deployment as { id?: string; status?: string } | undefined)?.id === nodeApiDeploymentId &&
            TERMINAL.has(String((frame.data.deployment as { status?: string }).status)),
        );
        expect(firstBuildChunk).toBeGreaterThanOrEqual(0);
        expect(terminal).toBeGreaterThan(firstBuildChunk);

        // Every persisted chunk reached the client, with the same text.
        const rows = await chunkRows(nodeApiDeploymentId);
        const live = sseChunks(client, nodeApiDeploymentId);
        expect(rows.length).toBeGreaterThan(1);
        expect(live.map((chunk) => `${chunk.phase}:${String(chunk.seq)}:${chunk.text}`).sort()).toEqual(
          rows.map((r) => `${r.phase}:${String(r.seq)}:${r.content}`).sort(),
        );

        // Resync: since=<seq> returns only later chunks, never a replay.
        const buildRows = rows.filter((r) => r.phase === 'build');
        expect(buildRows.length).toBeGreaterThan(1);
        const pivot = buildRows[Math.floor(buildRows.length / 2)];
        if (pivot === undefined) throw new Error('no pivot chunk');
        const resync = await getLogs(nodeApiDeploymentId, `?phase=build&since=${String(pivot.seq)}&limit=100`);
        expect(resync.statusCode).toBe(200);
        const page = resync.json<{ items: { phase: string; seq: number; text: string }[]; hasMore: boolean }>();
        expect(page.items.length).toBeGreaterThan(0);
        for (const item of page.items) {
          expect(item.phase === 'deploy' || (item.phase === 'build' && item.seq > pivot.seq)).toBe(true);
        }
        const expected = rows.filter((r) => r.phase === 'deploy' || (r.phase === 'build' && r.seq > pivot.seq));
        expect(page.items.map((item) => `${item.phase}:${String(item.seq)}`)).toEqual(
          expected.slice(0, 100).map((r) => `${r.phase}:${String(r.seq)}`),
        );
        const all = await readAllLogs(nodeApiDeploymentId);
        expect(all.map((item) => `${item.phase}:${String(item.seq)}:${item.text}`)).toEqual(
          rows.map((r) => `${r.phase}:${String(r.seq)}:${r.content}`),
        );

        // H2 on the real stack: session required, bad cursor rejected, unknown deployment 404.
        expect((await getLogs(nodeApiDeploymentId, '', false)).statusCode).toBe(401);
        expect((await getLogs(nodeApiDeploymentId, '?since=-1')).statusCode).toBe(400);
        expect((await getLogs(nodeApiDeploymentId, '?limit=101')).statusCode).toBe(400);
        expect((await getLogs(randomUUID(), '')).statusCode).toBe(404);
      } finally {
        client.close();
      }
    },
    CASE_TIMEOUT_MS,
  );

  it(
    'A1/A2: a canary split across chunks never leaks; chunks are append-only, seq-ordered and capped per line and phase',
    async () => {
      const client = await openSse(port, cookie);
      expect(client.statusCode).toBe(200);
      try {
        const serviceId = await newService(REPOS.canary);
        smallCapServices.add(serviceId);
        canaryDeploymentId = await trigger(serviceId);
        const row = await waitTerminal(canaryDeploymentId);
        expect({ status: row.status, errorCode: row.errorCode }).toEqual({ status: 'SUCCESS', errorCode: null });
        await delay(1000);

        const rows = await chunkRows(canaryDeploymentId);
        const build = rows.filter((r) => r.phase === 'build');
        const buildText = build.map((r) => r.content).join('');

        // A1: redacted, never dropped, everywhere a chunk goes.
        expect(buildText).toContain('noodara-canary-begin [REDACTED:token] noodara-canary-end');
        const surfaces = {
          db: rows.map((r) => r.content).join('\n'),
          redis: redisMessages.join('\n'),
          sse: client.frames.map((frame) => frame.raw).join('\n'),
          api: JSON.stringify(await readAllLogs(canaryDeploymentId)),
          logs: JSON.stringify(logged),
          deployment: JSON.stringify(row),
        };
        for (const [surface, text] of Object.entries(surfaces)) {
          for (const leak of [CANARY, HALF_A, HALF_B]) {
            expect({ surface, leaked: text.includes(leak) }).toEqual({ surface, leaked: false });
          }
        }

        // A2: seq starts at 1 and increases by one per phase; the rows match what was streamed.
        for (const phase of ['prepare', 'build', 'deploy']) {
          const seqs = rows.filter((r) => r.phase === phase).map((r) => r.seq);
          expect(seqs).toEqual(seqs.map((_seq, index) => index + 1));
        }
        expect(sseChunks(client, canaryDeploymentId).length).toBe(rows.length);

        // A2: per-line cap (the 40 000-byte line is cut) and per-phase cap with its single notice.
        const lines = buildText.split('\n');
        expect(Math.max(...lines.map((line) => Buffer.byteLength(line, 'utf8')))).toBeLessThanOrEqual(LINE_CAP);
        expect(lines.some((line) => line.includes('x'.repeat(10_000)))).toBe(true);
        expect((buildText.match(/x/g) ?? []).length).toBeLessThan(40_000);
        const notices = build.filter((r) => r.content.includes('reached the') && r.content.includes('limit'));
        expect(notices).toHaveLength(1);
        expect(build.at(-1)?.content).toContain('further output was dropped');
        expect(buildText).not.toContain('after-cap');
        const outputBytes = build.filter((r) => !notices.includes(r)).reduce((sum, r) => sum + r.byteLength, 0);
        expect(outputBytes).toBeLessThanOrEqual(CANARY_PHASE_CAP);
        for (const chunk of rows) {
          expect(chunk.byteLength).toBe(Buffer.byteLength(chunk.content, 'utf8'));
          expect(chunk.byteLength).toBeLessThanOrEqual(policy.flushBytes + policy.maxLineBytes);
        }

        const stats = sinks.get(canaryDeploymentId)?.stats();
        expect(stats).toMatchObject({ persistFailures: 0, publishFailures: 0, droppedChunks: 0, pendingBytes: 0 });
      } finally {
        client.close();
      }
    },
    CASE_TIMEOUT_MS,
  );

  it(
    'A5: a build that logs continuously for minutes keeps API RSS and SSE buffers bounded; the client is never evicted',
    async () => {
      const client = await openSse(port, cookie);
      expect(client.statusCode).toBe(200);
      const stream = sseResponses.at(-1);
      if (stream === undefined) throw new Error('the SSE response was not captured');
      const baselineRss = process.memoryUsage().rss;
      let peakRss = baselineRss;
      let peakSseBuffered = 0;
      const sampler = setInterval(() => {
        peakRss = Math.max(peakRss, process.memoryUsage().rss);
        peakSseBuffered = Math.max(peakSseBuffered, stream.writableLength);
      }, 100);
      try {
        const serviceId = await newService(REPOS.chatty);
        const deploymentId = await trigger(serviceId);
        const startedAt = Date.now();
        const row = await waitTerminal(deploymentId);
        const elapsedMs = Date.now() - startedAt;
        expect({ status: row.status, errorCode: row.errorCode }).toEqual({ status: 'SUCCESS', errorCode: null });
        await delay(1000);
        clearInterval(sampler);

        const rows = await chunkRows(deploymentId);
        const build = rows.filter((r) => r.phase === 'build');
        const ticks = build.map((r) => r.content).join('').match(/noodara-tick \d+/g) ?? [];
        const live = sseChunks(client, deploymentId);
        const stats = sinks.get(deploymentId)?.stats();
        const buildBytes = build.reduce((sum, r) => sum + r.byteLength, 0);
        const numbers = {
          ubuntu,
          chattyMs: CHATTY_MS,
          deployElapsedMs: elapsedMs,
          policy,
          buildChunks: build.length,
          totalChunks: rows.length,
          sseChunks: live.length,
          buildBytes,
          tickLines: ticks.length,
          meanBuildChunkBytes: Math.round(buildBytes / Math.max(build.length, 1)),
          rssBaselineMiB: +(baselineRss / 1_048_576).toFixed(1),
          rssPeakMiB: +(peakRss / 1_048_576).toFixed(1),
          rssGrowthMiB: +((peakRss - baselineRss) / 1_048_576).toFixed(1),
          sseBufferedPeakBytes: peakSseBuffered,
          sinkPeakPendingBytes: stats?.peakPendingBytes,
          sinkDroppedChunks: stats?.droppedChunks,
        };
        console.info(`[12-12 A5 numbers] ${JSON.stringify(numbers)}`);

        // The client stayed connected and received every persisted chunk.
        expect(client.isClosed()).toBe(false);
        expect(stream.destroyed).toBe(false);
        expect(live.map((chunk) => `${chunk.phase}:${String(chunk.seq)}`).sort()).toEqual(
          rows.map((r) => `${r.phase}:${String(r.seq)}`).sort(),
        );
        // Continuous output, flushed on the cadence: about one chunk per interval, not per line.
        expect(ticks.length).toBeGreaterThan(5000);
        const buildWindowMs = CHATTY_MS;
        expect(build.length).toBeGreaterThan(buildWindowMs / policy.flushIntervalMs / 4);
        expect(build.length).toBeLessThan(ticks.length / 4);
        // Bounded: SSE buffer under the eviction budget, sink queue under its cap, RSS growth small.
        expect(peakSseBuffered).toBeLessThan(SSE_MAX_BUFFERED_BYTES);
        expect(stats).toMatchObject({ persistFailures: 0, publishFailures: 0, droppedChunks: 0, pendingBytes: 0 });
        expect(stats?.peakPendingBytes ?? Infinity).toBeLessThan(sinkModule().DEFAULT_LOG_SINK_MAX_PENDING_BYTES);
        expect(peakRss - baselineRss).toBeLessThan(256 * 1_048_576);
      } finally {
        clearInterval(sampler);
        client.close();
      }
    },
    CASE_TIMEOUT_MS,
  );

  it(
    'A4/H1: retention deletes chunks past NOODARA_DEPLOY_LOG_RETENTION_DAYS without touching deployments; duplicate seq is rejected',
    async () => {
      if (logRetention === undefined) throw new Error('modules not loaded');
      expect(retentionDays).toBe(RETENTION_DAYS);
      const before = await chunkRows(nodeApiDeploymentId);
      expect(before.length).toBeGreaterThan(0);
      expect((await chunkRows(canaryDeploymentId)).length).toBeGreaterThan(0);

      // H1: (deployment, phase, seq) is unique; a duplicate insert is rejected.
      const first = before[0];
      if (first === undefined) throw new Error('no chunk');
      await expect(
        sinkModule()
          .createDbLogChunkWriter(db())
          .insert({ deploymentId: first.deploymentId, phase: first.phase, seq: first.seq, content: 'dup', byteLength: 3 }),
      ).rejects.toThrow();

      const aged = new Date(Date.now() - (RETENTION_DAYS + 10) * 86_400_000);
      await db()
        .update(deploymentLogChunks)
        .set({ createdAt: aged })
        .where(eq(deploymentLogChunks.deploymentId, canaryDeploymentId));
      const [canaryBefore, nodeApiBefore] = await Promise.all([
        deploymentRow(canaryDeploymentId),
        deploymentRow(nodeApiDeploymentId),
      ]);

      const retentionLogged: LoggedLine[] = [];
      const record = (level: string) => (fields: Record<string, unknown>, message: string) =>
        retentionLogged.push({ level, fields, message });
      const retention = logRetention.startDeploymentLogRetention({
        purge: (cutoff) => {
          if (logRetention === undefined) throw new Error('modules not loaded');
          return logRetention.purgeDeploymentLogChunks(db(), cutoff);
        },
        retentionDays,
        logger: { info: record('info'), warn: record('warn') },
      });
      try {
        const deadline = Date.now() + 20_000;
        while ((await chunkRows(canaryDeploymentId)).length > 0) {
          if (Date.now() > deadline) throw new Error('retention never purged the aged chunks');
          await delay(200);
        }
      } finally {
        await retention.stop();
      }

      expect(retentionLogged.some((line) => line.level === 'info' && (line.fields.deletedChunks as number) > 0)).toBe(true);
      expect(await chunkRows(nodeApiDeploymentId)).toEqual(before);
      expect(await deploymentRow(canaryDeploymentId)).toEqual(canaryBefore);
      expect(await deploymentRow(nodeApiDeploymentId)).toEqual(nodeApiBefore);
      const remaining = await db()
        .select({ id: deploymentLogChunks.id })
        .from(deploymentLogChunks)
        .where(eq(deploymentLogChunks.deploymentId, canaryDeploymentId));
      expect(remaining).toHaveLength(0);
    },
    CASE_TIMEOUT_MS,
  );
});
