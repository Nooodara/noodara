// 25-04 (A2, H1): leak canary for application secrets on the real sshd + dockerd fixture.
// Per-run canaries are stored as application secrets through the API and referenced by a service
// variable (`<secret:name>`); fixtures/env-api is deployed through API -> BullMQ -> deploy worker
// with the production wiring. The flow is create -> deploy -> error paths (HTTP errors, a rotated
// value, a deploy that fails with SECRET_UNRESOLVED) -> delete. Every canary must be absent from:
// API responses (successes and errors), the API and worker loggers, process exceptions, the logs
// API and deployment_log_chunks, the runtime container logs, activity_events, SSE and the Redis
// events channel, the runtime config snapshots (deployments rows), and every SSH output Noodara
// captured (each exec stdout/stderr and stream chunk: every `docker inspect` / `docker ps` it ran).
// The container's own `docker inspect` holds Config.Env by Docker design; Noodara never reads it,
// which the SSH recording proves. The image (inspect, history) must not carry a value either.
// AI prompt and response surfaces: not applicable until v0.5 (no AI code exists in v0.4).
// Assertion messages name canaries by label, never by value.
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { eq } from 'drizzle-orm';
import { Redis } from 'ioredis';
import parseSetCookie from 'set-cookie-parser';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { SshPort, SshSession } from '@noodara/ssh';
import {
  activityEvents,
  credentials,
  deploymentLogChunks,
  deployments,
  environmentVariables,
  secrets,
  servers,
  services,
} from '../../../apps/control-plane/src/db/schema/index.js';
import { DEPLOY_ENGINE_UBUNTU_VERSIONS, startDeployEngineStack, type DeployEngineStack } from '../helpers/deploy-engine.js';
import { startPostgres, type PostgresFixture } from '../helpers/postgres.js';
import { startRedis, type RedisFixture } from '../helpers/redis.js';
import { runTeardown, settleWithin } from '../helpers/teardown.js';

type ApiApp = ReturnType<(typeof import('../../../apps/control-plane/src/app.js'))['buildApp']>;
type Json = Record<string, unknown>;

interface Canary {
  readonly label: string;
  readonly value: string;
}

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES_DIR = path.resolve(HERE, '../../../fixtures');
const STACK_TIMEOUT_MS = 900_000;
const PENDING_START_WAIT_MS = 180_000;
const TEARDOWN_STEP_TIMEOUT_MS = 30_000;
const FIXTURE_STOP_TIMEOUT_MS = 60_000;
const STACK_STOP_TIMEOUT_MS = 300_000;
const CASE_TIMEOUT_MS = 900_000;
const TERMINAL_WAIT_MS = 400_000;
const POLL_MS = 500;
const KEY_VERSION = 1;
const DEPLOY_MAX_MS = 400_000;
const REPO = 'env-api';
const TERMINAL = new Set(['SUCCESS', 'FAILED', 'CANCELLED']);
const ADMIN_EMAIL = 'admin@noodara.test';
const ADMIN_PASSWORD = 'correct horse battery staple';
const SECRET_NAME = 'api_token';
const SECRET_KEY = 'API_TOKEN';
const DOOMED_NAME = 'doomed_token';
const DOOMED_KEY = 'DOOMED_TOKEN';
/** Secret values longer than MAX_SECRET_VALUE_LENGTH (64 KiB) are rejected. */
const OVERSIZED_SECRET_CHARS = 65_537;

/** Prints `<status> <body>` of GET /env-digest?name=<argv[1]> from inside the container. */
const DIGEST_SCRIPT =
  "fetch('http://127.0.0.1:3000/env-digest?name='+process.argv[1]).then(async(r)=>{process.stdout.write(r.status+' '+(await r.text()))}).catch(()=>process.exit(3))";

const sha256 = (value: string): string => createHash('sha256').update(value, 'utf8').digest('hex');

/** The SSH outputs Noodara captured, in order (exec stdout/stderr, stream chunks and tails). */
const sshCaptures: string[] = [];

/** Wraps a session so every output it hands back to Noodara is recorded. */
function recordingSession<S extends SshSession>(session: S): S {
  return new Proxy(session, {
    get(target, prop) {
      const value: unknown = Reflect.get(target, prop, target);
      if (typeof value !== 'function') return value;
      const fn = value as (...args: unknown[]) => unknown;
      if (prop === 'exec') {
        return async (...args: unknown[]) => {
          const result = (await fn.apply(target, args)) as { stdout: string; stderr: string };
          sshCaptures.push(`exec ${String(args[0])}\n${result.stdout}\n${result.stderr}`);
          return result;
        };
      }
      if (prop === 'stream') {
        return async (command: unknown, options: { onChunk: (chunk: { text: string }) => void }) => {
          const result = (await fn.call(target, command, {
            ...options,
            onChunk: (chunk: { text: string }) => {
              sshCaptures.push(chunk.text);
              options.onChunk(chunk);
            },
          })) as { stdoutTail: string; stderrTail: string; commandName: string };
          sshCaptures.push(`stream ${result.commandName}\n${result.stdoutTail}\n${result.stderrTail}`);
          return result;
        };
      }
      return fn.bind(target);
    },
  });
}

function recordingPort<S extends SshSession>(inner: SshPort<S>): SshPort<S> {
  return {
    connect: async (input) => {
      const outcome = await inner.connect(input);
      return outcome.ok ? { ...outcome, session: recordingSession(outcome.session) } : outcome;
    },
  };
}

vi.mock('@noodara/ssh', async (importOriginal) => {
  const original = await importOriginal<typeof import('@noodara/ssh')>();
  return { ...original, createSsh2Adapter: () => recordingPort(original.createSsh2Adapter()) };
});

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function leaksIn(text: string, canaries: readonly Canary[]): string[] {
  return canaries.filter((canary) => text.includes(canary.value)).map((canary) => canary.label);
}

/** The value, its first 20 characters (a truncated leak) and its base64 (an encoded leak). */
function canariesFor(label: string, value: string): Canary[] {
  return [
    { label, value },
    { label: `${label} (head)`, value: value.slice(0, 20) },
    { label: `${label} (base64)`, value: Buffer.from(value, 'utf8').toString('base64') },
  ];
}

interface SseClient {
  readonly raw: string[];
  close(): void;
}

function openSse(port: number, cookie: string): Promise<SseClient> {
  return new Promise((resolve, reject) => {
    const request = http.get({ host: '127.0.0.1', port, path: '/api/events', headers: { cookie } }, (response) => {
      const raw: string[] = [];
      response.setEncoding('utf8');
      response.on('data', (chunk: string) => raw.push(chunk));
      if (response.statusCode !== 200) reject(new Error(`SSE status ${String(response.statusCode)}`));
      resolve({ raw, close: () => request.destroy() });
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

describe.each(DEPLOY_ENGINE_UBUNTU_VERSIONS)('25-04 / A2: application-secret leak canary, Ubuntu %s', (ubuntu) => {
  let stack: DeployEngineStack | undefined;
  let stackStart: Promise<DeployEngineStack> | undefined;
  let pgStart: Promise<PostgresFixture> | undefined;
  let redisStart: Promise<RedisFixture> | undefined;
  let postgres: PostgresFixture | undefined;
  let redis: RedisFixture | undefined;
  let app: ApiApp | undefined;
  let sse: SseClient | undefined;
  let worker: { close(): Promise<void> } | undefined;
  let cookie = '';
  let serverId = '';
  let projectId = '';
  let environmentId = '';
  let serviceId = '';
  let serviceName = '';

  const masterKey = randomBytes(32);
  const values = {
    first: `nca-first-${randomBytes(24).toString('hex')}`,
    rotated: `nca-rotated-${randomBytes(24).toString('hex')}`,
    doomed: `nca-doomed-${randomBytes(24).toString('hex')}`,
    rejected: `nca-rejected-${randomBytes(24).toString('hex')}`,
  };
  const every: Canary[] = [
    ...canariesFor('first secret', values.first),
    ...canariesFor('rotated secret', values.rotated),
    ...canariesFor('doomed secret', values.doomed),
    ...canariesFor('rejected input', values.rejected),
  ];
  const connections: Redis[] = [];
  const workerLogs: string[] = [];
  const apiLogs: string[] = [];
  const exceptions: string[] = [];
  const redisMessages: string[] = [];
  const responses: { readonly label: string; readonly body: string }[] = [];
  const deploymentIds: string[] = [];
  const onException = (error: unknown) => {
    exceptions.push(error instanceof Error ? `${error.message}\n${String(error.stack)}` : String(error));
  };

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
  const rootOut = async (argv: readonly string[], stdin?: string): Promise<string> => {
    const result = await s().exec(argv, stdin === undefined ? { user: 'root' } : { user: 'root', stdin });
    expect(result.exitCode, `${argv.join(' ')}: ${result.stderr}`).toBe(0);
    return result.stdout;
  };

  /** Every API call of the flow goes through here, so every body is checked. */
  const call = async (
    method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE',
    url: string,
    payload?: unknown,
    withCookie = true,
  ): Promise<{ statusCode: number; body: Json; raw: string }> => {
    const response = await api().inject({
      method,
      url,
      headers: withCookie ? { cookie } : {},
      ...(payload !== undefined ? { payload: payload as Json } : {}),
    });
    responses.push({ label: `${method} ${url}`, body: `${JSON.stringify(response.headers)}\n${response.body}` });
    const body = response.body === '' ? {} : (response.json() as Json);
    return { statusCode: response.statusCode, body, raw: response.body };
  };

  const base = (): string => `/api/projects/${projectId}`;
  const serviceEnv = (): string => `${base()}/services/${serviceId}/env`;

  const waitTerminal = async (deploymentId: string): Promise<{ status: string; errorCode: unknown }> => {
    const deadline = Date.now() + TERMINAL_WAIT_MS;
    for (;;) {
      const view = await call('GET', `/api/deployments/${deploymentId}`);
      expect(view.statusCode, view.raw).toBe(200);
      const status = String(view.body.status);
      if (TERMINAL.has(status)) return { status, errorCode: view.body.errorCode ?? null };
      if (Date.now() > deadline) throw new Error(`deployment ${deploymentId} stuck in ${status}`);
      await delay(POLL_MS);
    }
  };

  const deploy = async (): Promise<{ deploymentId: string; status: string; errorCode: unknown }> => {
    const triggered = await call('POST', `/api/services/${serviceId}/deploy`, {});
    expect(triggered.statusCode, triggered.raw).toBe(201);
    const deploymentId = String(triggered.body.id);
    deploymentIds.push(deploymentId);
    return { deploymentId, ...(await waitTerminal(deploymentId)) };
  };

  const digestOf = async (key: string): Promise<string> =>
    (await rootOut(['docker', 'exec', `noodara-${serviceId}`, 'node', '-e', DIGEST_SCRIPT, key])).trim();

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
    // A fresh module graph per Ubuntu block (env.ts and getDb() cache their clients).
    vi.resetModules();
    process.on('uncaughtException', onException);
    process.on('unhandledRejection', onException);
    const { createRedactor, revealSecret, secretValue } = await import('@noodara/domain/security');
    const { createSsh2Adapter, formatFingerprint } = await import('@noodara/ssh');
    stackStart = startDeployEngineStack({
      ubuntu,
      seedRepositories: [{ name: REPO, sourceDir: path.join(FIXTURES_DIR, REPO) }],
    });
    pgStart = startPostgres();
    redisStart = startRedis();
    const [stackStarted, pgStarted, redisStarted] = await Promise.all([stackStart, pgStart, redisStart]);
    stack = stackStarted;
    postgres = pgStarted;
    redis = redisStarted;

    process.env.NOODARA_MASTER_KEY = masterKey.toString('base64');
    process.env.BETTER_AUTH_SECRET = `canary-env-${randomUUID()}-${randomUUID()}`;
    process.env.DATABASE_URL = postgres.connectionString;
    process.env.REDIS_URL = redis.connectionUrl;
    process.env.NOODARA_PUBLIC_URL = 'http://localhost:3000';

    const { env, DEPLOY_LOG_LINE_MAX_BYTES } = await import('../../../apps/control-plane/src/env.js');
    const runtime = await import('../../../apps/control-plane/src/deploy/deploy-runtime.js');
    const workerModule = await import('../../../apps/control-plane/src/deploy/deploy-worker.js');
    const credentialStore = await import('../../../apps/control-plane/src/services/credential-store.js');
    const serviceCredentials = await import('../../../apps/control-plane/src/services/service-credentials.js');
    const publisherModule = await import('../../../apps/control-plane/src/events/redis-server-event-publisher.js');
    const logSink = await import('../../../apps/control-plane/src/deploy/log-sink.js');
    const { issueToken } = await import('../../../apps/control-plane/src/services/setup-token-repository.js');
    const { buildApp } = await import('../../../apps/control-plane/src/app.js');
    const { createLogger } = await import('../../../apps/control-plane/src/logger.js');

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
        name: `canary-env-host-${ubuntu}`,
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

    // API: real HTTP listener (SSE), its pino logger at debug with the production redaction config.
    const apiLogger = createLogger({ level: 'debug', destination: { write: (line: string) => apiLogs.push(line) } });
    app = buildApp({ logger: apiLogger as unknown as ApiApp['log'] });
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

    const tap = new Redis(redis.connectionUrl, { maxRetriesPerRequest: null });
    connections.push(tap);
    await tap.subscribe(publisherModule.SERVER_EVENTS_CHANNEL);
    tap.on('message', (_channel: string, message: string) => redisMessages.push(message));
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

    // Worker: the src/worker.ts wiring, with a recording logger and the production redactor.
    const record = (level: string) => (fields: Record<string, unknown>, message: string) => {
      workerLogs.push(JSON.stringify({ level, fields, message }));
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
    const handler = workerModule.createDeployJobHandler({ ...baseDeps, sinkFor: (deploymentId) => sinks(deploymentId) });
    const workerConnection = new Redis(redis.connectionUrl, { maxRetriesPerRequest: null });
    connections.push(workerConnection);
    worker = runtime.startDeployWorker({ handler, connection: workerConnection, concurrency: 1, deployMaxMs: DEPLOY_MAX_MS, logger });

    const project = await call('POST', '/api/projects', { name: `Canary env ${randomUUID().slice(0, 8)}` });
    expect(project.statusCode, project.raw).toBe(201);
    projectId = String(project.body.id);
    const environment = await call('POST', `${base()}/environments`, { name: 'production' });
    expect(environment.statusCode, environment.raw).toBe(201);
    environmentId = String(environment.body.id);

    serviceName = `env-${randomUUID().slice(0, 8)}`;
    const created = await call('POST', `${base()}/services`, {
      environmentId,
      serverId,
      name: serviceName,
      source: { kind: 'git', repositoryUrl: s().gitRepoUrl(REPO), branch: 'main' },
      internalPort: 3000,
    });
    expect(created.statusCode, created.raw).toBe(201);
    serviceId = String(created.body.id);
    // The fixture's deploy key, stored the way the credentials API stores one.
    const deployKey = serviceCredentials.encodeServiceCredential(
      { kind: 'deploy_key', privateKey: secretValue(s().deployKey.privateKey, 'ssh_private_key'), publicKey: s().deployKey.publicKey },
      { key: masterKey, version: KEY_VERSION },
    );
    const deployKeyId = await db().transaction((tx) => serviceCredentials.insertServiceCredential(tx, deployKey, new Date()));
    await db().update(services).set({ repositoryCredentialId: deployKeyId }).where(eq(services.id, serviceId));
  }, STACK_TIMEOUT_MS);

  afterAll(async () => {
    process.off('uncaughtException', onException);
    process.off('unhandledRejection', onException);
    const [stk, pg, rd] = await Promise.all([
      stack ?? settleWithin(stackStart, PENDING_START_WAIT_MS),
      postgres ?? settleWithin(pgStart, PENDING_START_WAIT_MS),
      redis ?? settleWithin(redisStart, PENDING_START_WAIT_MS),
    ]);
    await runTeardown(
      `canary env secrets (Ubuntu ${ubuntu})`,
      [
        { name: 'sse.close', run: () => sse?.close() },
        { name: 'worker.close', run: () => worker?.close() },
        { name: 'app.close', run: () => app?.close() },
        { name: 'disconnect redis connections', run: () => { for (const connection of connections) connection.disconnect(); } },
        { name: 'redis.stop', run: () => rd?.stop(), timeoutMs: FIXTURE_STOP_TIMEOUT_MS },
        { name: 'postgres.stop', run: () => pg?.stop(), timeoutMs: FIXTURE_STOP_TIMEOUT_MS },
        { name: 'stack.stop', run: () => stk?.stop(), timeoutMs: STACK_STOP_TIMEOUT_MS },
      ],
      { stepTimeoutMs: TEARDOWN_STEP_TIMEOUT_MS },
    );
  }, STACK_TIMEOUT_MS);

  it(
    'A2: create -> deploy -> error paths -> delete leaves no secret value on any surface Noodara writes or captures',
    async () => {
      // --- create: a secret and a service variable referencing it.
      const secret = await call('POST', `${base()}/secrets`, { name: SECRET_NAME, value: values.first });
      expect(secret.statusCode, secret.raw).toBe(201);
      const secretId = String(secret.body.id);
      const variable = await call('POST', serviceEnv(), { key: SECRET_KEY, value: `<secret:${SECRET_NAME}>` });
      expect(variable.statusCode, variable.raw).toBe(201);
      const variableId = String(variable.body.id);

      // --- deploy: the container sees the value (sha256 only), the snapshot holds a reference.
      const first = await deploy();
      expect({ status: first.status, errorCode: first.errorCode }).toEqual({ status: 'SUCCESS', errorCode: null });
      expect(await digestOf(SECRET_KEY)).toBe(`200 ${sha256(values.first)}`);
      const [firstRow] = await db().select().from(deployments).where(eq(deployments.id, first.deploymentId));
      expect(firstRow?.runtimeConfig).toMatchObject({
        version: 2,
        env: [{ key: SECRET_KEY, secretRef: SECRET_NAME, secretVersion: 1 }],
      });

      // --- error paths: every rejected body carries a canary; none may come back.
      const rejected: { readonly label: string; readonly response: { statusCode: number; body: Json } }[] = [
        { label: 'duplicate name', response: await call('POST', `${base()}/secrets`, { name: SECRET_NAME, value: values.rejected }) },
        { label: 'multiline value', response: await call('POST', `${base()}/secrets`, { name: 'multi', value: `a\n${values.rejected}` }) },
        { label: 'invalid name', response: await call('POST', `${base()}/secrets`, { name: 'bad name!', value: values.rejected }) },
        {
          label: 'oversized value',
          response: await call('POST', `${base()}/secrets`, {
            name: 'huge',
            value: values.rejected.repeat(Math.ceil(OVERSIZED_SECRET_CHARS / values.rejected.length)),
          }),
        },
        { label: 'unknown body key', response: await call('POST', `${base()}/secrets`, { name: 'x', value: values.rejected, extra: values.rejected }) },
        { label: 'invalid env key', response: await call('POST', serviceEnv(), { key: '1-bad', value: values.rejected }) },
        { label: 'missing secret ref', response: await call('POST', serviceEnv(), { key: 'MISSING', value: '<secret:nope>' }) },
        { label: 'secret in use', response: await call('DELETE', `${base()}/secrets/${secretId}`) },
        { label: 'unauthenticated', response: await call('POST', `${base()}/secrets`, { name: 'anon', value: values.rejected }, false) },
        {
          label: 'unknown project',
          response: await call('POST', `/api/projects/${randomUUID()}/secrets`, { name: 'gone', value: values.rejected }),
        },
      ];
      for (const { label, response } of rejected) {
        expect(response.statusCode, label).toBeGreaterThanOrEqual(400);
      }

      // --- rotate: a new value reaches the next deploy only.
      const rotated = await call('PUT', `${base()}/secrets/${secretId}`, { value: values.rotated });
      expect(rotated.statusCode, rotated.raw).toBe(200);
      const second = await deploy();
      expect({ status: second.status, errorCode: second.errorCode }).toEqual({ status: 'SUCCESS', errorCode: null });
      expect(await digestOf(SECRET_KEY)).toBe(`200 ${sha256(values.rotated)}`);

      // --- a failed deploy: the referenced secret disappears behind the API's back.
      const doomed = await call('POST', `${base()}/secrets`, { name: DOOMED_NAME, value: values.doomed });
      expect(doomed.statusCode, doomed.raw).toBe(201);
      const doomedVariable = await call('POST', serviceEnv(), { key: DOOMED_KEY, value: `<secret:${DOOMED_NAME}>` });
      expect(doomedVariable.statusCode, doomedVariable.raw).toBe(201);
      await db().delete(secrets).where(eq(secrets.id, String(doomed.body.id)));
      const failed = await deploy();
      expect({ status: failed.status, errorCode: failed.errorCode }).toEqual({ status: 'FAILED', errorCode: 'SECRET_UNRESOLVED' });
      expect(await digestOf(SECRET_KEY), 'the running container was touched').toBe(`200 ${sha256(values.rotated)}`);

      // --- the read surfaces the UI uses, captured before the delete.
      await call('GET', `${base()}/secrets`);
      await call('GET', `${base()}/secrets/${secretId}`);
      await call('GET', serviceEnv());
      await call('GET', `${serviceEnv()}/effective`);
      const appLogs = await call('GET', `${base()}/services/${serviceId}/logs`);
      const logsApi: string[] = [];
      for (const deploymentId of deploymentIds) {
        logsApi.push(await readAllLogs(deploymentId));
        await call('GET', `/api/deployments/${deploymentId}`);
      }
      await call('GET', `/api/services/${serviceId}/deployments`);
      await call('GET', `${base()}/services/${serviceId}`);

      // The built images never carry a runtime value; docker ps never shows the environment.
      const hostOutputs = new Map<string, string>();
      const images = (await rootOut(['docker', 'image', 'ls', '--quiet', '--no-trunc', `noodara/${serviceId}`])).split('\n').filter(Boolean);
      expect(images.length, 'no image of the service to inspect').toBeGreaterThan(0);
      for (const image of images) {
        hostOutputs.set(`docker image inspect ${image}`, await rootOut(['docker', 'image', 'inspect', image]));
        hostOutputs.set(`docker history ${image}`, await rootOut(['docker', 'history', '--no-trunc', '--format', '{{json .}}', image]));
      }
      hostOutputs.set('docker ps', await rootOut(['docker', 'ps', '--all', '--no-trunc', '--format', '{{json .}}']));

      // --- delete: the variables, the secret, then the service with its container.
      expect((await call('DELETE', `${serviceEnv()}/${String(doomedVariable.body.id)}`)).statusCode).toBe(204);
      expect((await call('DELETE', `${serviceEnv()}/${variableId}`)).statusCode).toBe(204);
      expect((await call('DELETE', `${base()}/secrets/${secretId}`)).statusCode).toBe(204);
      const removed = await call('DELETE', `${base()}/services/${serviceId}`, { confirmName: serviceName });
      expect(removed.statusCode, removed.raw).toBe(200);
      expect(await db().select().from(secrets).where(eq(secrets.projectId, projectId))).toEqual([]);
      await call('GET', '/api/activity');

      // --- scan.
      const surfaces = new Map<string, string>();
      surfaces.set('logs API', logsApi.join('\n'));
      surfaces.set('runtime container logs API', appLogs.raw);
      surfaces.set('deployment_log_chunks', JSON.stringify(await db().select().from(deploymentLogChunks)));
      surfaces.set('deployments rows (runtime config snapshots)', JSON.stringify(await db().select().from(deployments)));
      surfaces.set('environment_variables rows', JSON.stringify(await db().select().from(environmentVariables)));
      surfaces.set('activity_events', JSON.stringify(await db().select().from(activityEvents)));
      surfaces.set('worker logger', workerLogs.join('\n'));
      expect(apiLogs.length, 'the API logger captured nothing').toBeGreaterThan(0);
      surfaces.set('API logger', apiLogs.join(''));
      surfaces.set('process exceptions', exceptions.join('\n'));
      const client = sse;
      if (client === undefined) throw new Error('SSE client not open');
      surfaces.set('SSE stream', client.raw.join(''));
      expect(redisMessages.length, 'no event reached the Redis channel').toBeGreaterThan(0);
      surfaces.set('Redis events channel', redisMessages.join('\n'));
      expect(responses.length).toBeGreaterThan(20);
      for (const [index, response] of responses.entries()) surfaces.set(`API #${String(index)} ${response.label}`, response.body);

      // Every SSH output Noodara captured, which includes each docker inspect/ps it ran.
      const captured = sshCaptures.join('\n');
      expect(captured, 'no docker inspect output was captured').toMatch(/inspect/i);
      surfaces.set('SSH outputs captured by Noodara', captured);

      for (const [label, text] of hostOutputs) surfaces.set(label, text);
      surfaces.set('docker ps (after delete)', await rootOut(['docker', 'ps', '--all', '--no-trunc', '--format', '{{json .}}']));

      for (const [surface, text] of surfaces) {
        expect(leaksIn(text, every), `${surface} leaked a canary`).toEqual([]);
      }
      // The ciphertext rows themselves hold no plaintext either (the doomed row and the rest are gone).
      expect(leaksIn(JSON.stringify(await db().select().from(secrets)), every)).toEqual([]);

      // Nothing persisted on the host outside Docker's own state: the env file is gone.
      const sweep = await s().exec(
        ['sh', '-c', `grep -rlF --exclude='noodara-stdin-*' -f /dev/stdin /home/deployer /root /tmp 2>/dev/null || true`],
        { user: 'root', stdin: `${Object.values(values).join('\n')}\n` },
      );
      expect(sweep.stdout.trim(), 'a secret value persisted on the deploy host').toBe('');
    },
    CASE_TIMEOUT_MS,
  );
});
