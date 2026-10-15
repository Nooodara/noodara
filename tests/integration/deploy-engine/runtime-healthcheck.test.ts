// 17-02 / A1, A2, A4, A5: the HEALTHCHECK step and the kept `-prev` container on real infrastructure
// (sshd + dockerd), through the real job handler, deploy target and deployment store.
// - HTTP pass: the redeploy keeps the old container as `-prev` and removes it (and its image) only
//   after the new one passed; the row carries runtime_config, image_ref and healthcheck_started_at.
// - Wrong status: fixtures/unhealthy-api answers 500 on /healthz; the attempt ends HEALTHCHECK_FAILED
//   and `-prev` stays stopped with the previous image (the 17-03 rollback target).
// - Timeout: a probe that never gets an answer ends HEALTHCHECK_TIMEOUT.
// 17-07 / A6: the cases that expect FAILED turn auto_rollback off (the rollback itself is covered by
// runtime-rollback.test.ts); with it off the failed new container is stopped (17-07 A3).
// - TCP pass: the same unhealthy container passes a TCP check (the port is open).
import { randomBytes, randomUUID } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { HealthcheckConfig } from '@noodara/domain/deployment';
import { createRedactor, secretValue } from '@noodara/domain/security';
import { createSsh2Adapter, formatFingerprint } from '@noodara/ssh';
import {
  credentials,
  deployments,
  environments,
  projects,
  servers,
  services,
} from '../../../apps/control-plane/src/db/schema/index.js';
import type { DeploymentLogEntry } from '../../../apps/control-plane/src/deploy/log-sink.js';
import {
  DEPLOY_ENGINE_UBUNTU_VERSIONS,
  startDeployEngineStack,
  type DeployEngineStack,
} from '../helpers/deploy-engine.js';
import { startPostgres, type PostgresFixture } from '../helpers/postgres.js';
import { startRedis, type RedisFixture } from '../helpers/redis.js';
import { runTeardown, settleWithin } from '../helpers/teardown.js';

type DeployRuntimeModule = typeof import('../../../apps/control-plane/src/deploy/deploy-runtime.js');
type DeployWorkerModule = typeof import('../../../apps/control-plane/src/deploy/deploy-worker.js');
type DeploymentServicesModule = typeof import('../../../apps/control-plane/src/services/deployment-services.js');
type CredentialStoreModule = typeof import('../../../apps/control-plane/src/services/credential-store.js');
type JobHandler = ReturnType<DeployWorkerModule['createDeployJobHandler']>;

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES_DIR = path.resolve(HERE, '../../../fixtures');
const STACK_TIMEOUT_MS = 900_000;
const PENDING_START_WAIT_MS = 180_000;
const TEARDOWN_STEP_TIMEOUT_MS = 30_000;
const FIXTURE_STOP_TIMEOUT_MS = 60_000;
const STACK_STOP_TIMEOUT_MS = 300_000;
const CASE_TIMEOUT_MS = 600_000;
const KEY_VERSION = 1;
const DEPLOY_MAX_MS = 300_000;
const REPOS = { healthy: 'node-api', unhealthy: 'unhealthy-api' } as const;
const ACTOR = { type: 'system' } as const;
const IP_PATTERN = /\b\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}\b/;

const TIMING = { probeTimeoutS: 2, intervalS: 1, retries: 3, startPeriodS: 10 };
const httpCheck = (checkPath: string): HealthcheckConfig => ({
  type: 'http',
  path: checkPath,
  port: 3000,
  expectedStatuses: [200],
  ...TIMING,
});
const TCP_CHECK: HealthcheckConfig = { type: 'tcp', port: 3000, ...TIMING };
const TIMEOUT_CHECK: HealthcheckConfig = { ...httpCheck('/hang'), probeTimeoutS: 1, retries: 2, startPeriodS: 0 };

describe.each(DEPLOY_ENGINE_UBUNTU_VERSIONS)('17-02: runtime healthcheck on real infrastructure, Ubuntu %s', (ubuntu) => {
  let stack: DeployEngineStack | undefined;
  let stackStart: Promise<DeployEngineStack> | undefined;
  let pgStart: Promise<PostgresFixture> | undefined;
  let redisStart: Promise<RedisFixture> | undefined;
  let postgres: PostgresFixture | undefined;
  let redis: RedisFixture | undefined;
  let handler: JobHandler | undefined;
  let createRow: ((serviceId: string) => Promise<string>) | undefined;
  let projectId = '';
  let environmentId = '';
  let serverId = '';

  const masterKey = randomBytes(32);
  const entries = new Map<string, DeploymentLogEntry[]>();

  const s = (): DeployEngineStack => {
    if (stack === undefined) throw new Error('stack not started');
    return stack;
  };
  const db = (): PostgresFixture['db'] => {
    if (postgres === undefined) throw new Error('postgres not started');
    return postgres.db;
  };
  const root = (argv: readonly string[]) => s().exec(argv, { user: 'root' });
  const rootOut = async (argv: readonly string[]): Promise<string> => (await root(argv)).stdout.trim();
  const exists = async (argv: readonly string[]): Promise<boolean> => (await root(argv)).exitCode === 0;
  const imageExists = (ref: string) => exists(['docker', 'image', 'inspect', ref]);
  const containerExists = (name: string) => exists(['docker', 'container', 'inspect', name]);
  const containerField = (name: string, format: string) =>
    rootOut(['docker', 'container', 'inspect', '--format', format, name]);

  const deploymentRow = async (deploymentId: string) => {
    const [row] = await db().select().from(deployments).where(eq(deployments.id, deploymentId));
    if (!row) throw new Error(`deployment ${deploymentId} missing`);
    return row;
  };
  const healthcheckLog = (deploymentId: string): string =>
    (entries.get(deploymentId) ?? [])
      .filter((entry) => entry.phase === 'healthcheck')
      .map((entry) => entry.text)
      .join('\n');

  const insertService = async (
    repo: string,
    healthcheck: HealthcheckConfig | null,
    options: { autoRollback?: boolean } = {},
  ): Promise<string> => {
    const serviceCredentials = await import('../../../apps/control-plane/src/services/service-credentials.js');
    const encoded = serviceCredentials.encodeServiceCredential(
      {
        kind: 'deploy_key',
        privateKey: secretValue(s().deployKey.privateKey, 'ssh_private_key'),
        publicKey: s().deployKey.publicKey,
      },
      { key: masterKey, version: KEY_VERSION },
    );
    const credentialId = await db().transaction((tx) => serviceCredentials.insertServiceCredential(tx, encoded, new Date()));
    const [row] = await db()
      .insert(services)
      .values({
        projectId,
        environmentId,
        serverId,
        name: `hc-${randomUUID().slice(0, 8)}`,
        sourceType: 'git',
        repositoryUrl: s().gitRepoUrl(repo),
        branch: 'main',
        buildContext: '.',
        dockerfilePath: 'Dockerfile',
        buildTarget: null,
        internalPort: 3000,
        publishedPort: null,
        repositoryCredentialId: credentialId,
        healthcheck,
        autoRollback: options.autoRollback ?? true,
      })
      .returning({ id: services.id });
    if (!row) throw new Error('service insert returned no row');
    return row.id;
  };

  const updateService = async (serviceId: string, repo: string, healthcheck: HealthcheckConfig | null): Promise<void> => {
    await db()
      .update(services)
      .set({ repositoryUrl: s().gitRepoUrl(repo), healthcheck })
      .where(eq(services.id, serviceId));
  };

  const deploy = async (serviceId: string) => {
    if (handler === undefined || createRow === undefined) throw new Error('runtime not started');
    const deploymentId = await createRow(serviceId);
    await handler({ deploymentId, serviceId, actor: ACTOR, requestedAt: new Date().toISOString() });
    return deploymentRow(deploymentId);
  };

  const removeServiceContainers = async (serviceId: string): Promise<void> => {
    await root(['docker', 'rm', '-f', `noodara-${serviceId}`, `noodara-${serviceId}-prev`]);
  };

  beforeAll(async () => {
    stackStart = startDeployEngineStack({
      ubuntu,
      seedRepositories: [
        { name: REPOS.healthy, sourceDir: path.join(FIXTURES_DIR, 'node-api') },
        { name: REPOS.unhealthy, sourceDir: path.join(FIXTURES_DIR, 'unhealthy-api') },
      ],
    });
    pgStart = startPostgres();
    redisStart = startRedis();
    const [stackStarted, pgStarted, redisStarted] = await Promise.all([stackStart, pgStart, redisStart]);
    stack = stackStarted;
    postgres = pgStarted;
    redis = redisStarted;

    process.env.NOODARA_MASTER_KEY = masterKey.toString('base64');
    process.env.BETTER_AUTH_SECRET = `runtime-healthcheck-${randomUUID()}-${randomUUID()}`;
    process.env.DATABASE_URL = postgres.connectionString;
    process.env.REDIS_URL = redis.connectionUrl;
    process.env.NOODARA_PUBLIC_URL = 'http://localhost:3000';

    const runtime: DeployRuntimeModule = await import('../../../apps/control-plane/src/deploy/deploy-runtime.js');
    const workerModule: DeployWorkerModule = await import('../../../apps/control-plane/src/deploy/deploy-worker.js');
    const deploymentServices: DeploymentServicesModule = await import(
      '../../../apps/control-plane/src/services/deployment-services.js'
    );
    const credentialStore: CredentialStoreModule = await import('../../../apps/control-plane/src/services/credential-store.js');

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
        name: `healthcheck-host-${ubuntu}`,
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
      .values({ name: 'Runtime healthcheck', slug: `hc-${randomUUID().slice(0, 8)}`, createdAt: now, updatedAt: now })
      .returning({ id: projects.id });
    if (!projectRow) throw new Error('project insert returned no row');
    projectId = projectRow.id;
    const [environmentRow] = await db()
      .insert(environments)
      .values({ projectId, name: 'production', createdAt: now, updatedAt: now })
      .returning({ id: environments.id });
    if (!environmentRow) throw new Error('environment insert returned no row');
    environmentId = environmentRow.id;

    const events = { publish: () => Promise.resolve() };
    const logger = { info: () => undefined, warn: () => undefined, error: () => undefined };
    const deps = runtime.createDeployJobDeps({
      db: db(),
      events,
      ssh: createSsh2Adapter(),
      timeouts: { connectMs: 20_000, commandMs: 60_000, discoveryMs: 120_000 },
      masterKeys: () => Promise.resolve({ current: masterKey }),
      panelPorts: [],
      config: { deployMaxMs: DEPLOY_MAX_MS, idleMs: 120_000, logMaxBytes: 1_048_576, logLineMaxBytes: 16_384 },
      logger,
    });
    handler = workerModule.createDeployJobHandler({
      ...deps,
      // A2: the healthcheck lines, as the runtime emits them through its redactor.
      sinkFor: (deploymentId) => {
        const list: DeploymentLogEntry[] = [];
        entries.set(deploymentId, list);
        return { write: (entry) => list.push(entry), close: () => Promise.resolve() };
      },
    });
    // Rows only: the handler is invoked directly, no queue or BullMQ worker is involved.
    const api = deploymentServices.createDeploymentServices({
      db: db(),
      now: () => new Date(),
      events,
      queue: { enqueue: () => Promise.resolve({ ok: true, jobId: 'unused' } as const) },
      logger,
    });
    createRow = async (serviceId) => {
      const result = await api.triggerDeploy({ actor: ACTOR, serviceId });
      if (!result.ok) throw new Error(`triggerDeploy failed: ${result.code}`);
      return result.deployment.id;
    };
  }, STACK_TIMEOUT_MS);

  afterAll(async () => {
    const [stk, pg, rd] = await Promise.all([
      stack ?? settleWithin(stackStart, PENDING_START_WAIT_MS),
      postgres ?? settleWithin(pgStart, PENDING_START_WAIT_MS),
      redis ?? settleWithin(redisStart, PENDING_START_WAIT_MS),
    ]);
    await runTeardown(
      `runtime healthcheck (Ubuntu ${ubuntu})`,
      [
        { name: 'redis.stop', run: () => rd?.stop(), timeoutMs: FIXTURE_STOP_TIMEOUT_MS },
        { name: 'postgres.stop', run: () => pg?.stop(), timeoutMs: FIXTURE_STOP_TIMEOUT_MS },
        { name: 'stack.stop', run: () => stk?.stop(), timeoutMs: STACK_STOP_TIMEOUT_MS },
      ],
      { stepTimeoutMs: TEARDOWN_STEP_TIMEOUT_MS },
    );
  }, STACK_TIMEOUT_MS);

  it('HTTP pass: the redeploy keeps -prev until the check passed, then removes it; its image is kept by image retention', async () => {
    const serviceId = await insertService(REPOS.healthy, httpCheck('/health'));
    try {
      const first = await deploy(serviceId);
      expect({ status: first.status, errorCode: first.errorCode }).toEqual({ status: 'SUCCESS', errorCode: null });

      const second = await deploy(serviceId);

      expect({ status: second.status, errorCode: second.errorCode }).toEqual({ status: 'SUCCESS', errorCode: null });
      // A3: the snapshot, image ref and the HEALTHCHECK edge timestamp are on the row.
      expect(second.imageRef).toBe(`noodara/${serviceId}:${second.id}`);
      expect(second.runtimeConfig).toMatchObject({ imageRef: second.imageRef, healthcheck: httpCheck('/health') });
      expect(second.healthcheckStartedAt).toBeInstanceOf(Date);
      // A2: fixed lines in the healthcheck phase, never the probe target.
      const log = healthcheckLog(second.id);
      expect(log).toMatch(/Healthcheck attempt \d+: HTTP 200/);
      expect(log).toContain('Healthcheck passed.');
      expect(log).not.toMatch(IP_PATTERN);
      // A1: the previous container is gone only because the check passed.
      expect(await containerExists(`noodara-${serviceId}-prev`)).toBe(false);
      expect(await containerField(`noodara-${serviceId}`, '{{.State.Status}} {{.Config.Image}}')).toBe(
        `running noodara/${serviceId}:${second.id}`,
      );
      // 17-04: the replaced image is a known-good rollback target kept by image retention.
      expect(await imageExists(`noodara/${serviceId}:${first.id}`)).toBe(true);
    } finally {
      await removeServiceContainers(serviceId);
    }
  }, CASE_TIMEOUT_MS);

  it('wrong status: unhealthy-api ends HEALTHCHECK_FAILED and -prev stays stopped with the previous image', async () => {
    const serviceId = await insertService(REPOS.healthy, httpCheck('/health'), { autoRollback: false });
    try {
      const first = await deploy(serviceId);
      expect(first.status).toBe('SUCCESS');
      await updateService(serviceId, REPOS.unhealthy, httpCheck('/healthz'));

      const second = await deploy(serviceId);

      expect({ status: second.status, errorCode: second.errorCode }).toEqual({
        status: 'FAILED',
        errorCode: 'HEALTHCHECK_FAILED',
      });
      expect(second.errorMessage).toMatch(/did not pass its healthcheck/);
      expect(second.healthcheckStartedAt).toBeInstanceOf(Date);
      expect(healthcheckLog(second.id)).toMatch(/Healthcheck attempt \d+: HTTP 500/);
      // A1: kept as -prev (stopped, never removed) with the previous deployment's image.
      expect(await containerField(`noodara-${serviceId}-prev`, '{{.State.Status}} {{.Config.Image}}')).toBe(
        `exited noodara/${serviceId}:${first.id}`,
      );
      expect(await imageExists(`noodara/${serviceId}:${first.id}`)).toBe(true);
      // 17-07 A3: with auto_rollback off the failed new container is stopped, not removed.
      expect(await containerField(`noodara-${serviceId}`, '{{.State.Status}} {{.Config.Image}}')).toBe(
        `exited noodara/${serviceId}:${second.id}`,
      );
    } finally {
      await removeServiceContainers(serviceId);
    }
  }, CASE_TIMEOUT_MS);

  it('timeout: a health path that never answers ends HEALTHCHECK_TIMEOUT', async () => {
    const serviceId = await insertService(REPOS.unhealthy, TIMEOUT_CHECK, { autoRollback: false });
    try {
      const row = await deploy(serviceId);

      expect({ status: row.status, errorCode: row.errorCode }).toEqual({ status: 'FAILED', errorCode: 'HEALTHCHECK_TIMEOUT' });
      expect(row.errorMessage).toMatch(/did not become healthy in time/);
      expect(healthcheckLog(row.id)).toContain('no answer before the probe timeout');
    } finally {
      await removeServiceContainers(serviceId);
    }
  }, CASE_TIMEOUT_MS);

  it('TCP pass: the open port passes even though the HTTP health path answers 500', async () => {
    const serviceId = await insertService(REPOS.unhealthy, TCP_CHECK);
    try {
      const row = await deploy(serviceId);

      expect({ status: row.status, errorCode: row.errorCode }).toEqual({ status: 'SUCCESS', errorCode: null });
      expect(healthcheckLog(row.id)).toMatch(/Healthcheck attempt \d+: port open/);
      expect(row.runtimeConfig).toMatchObject({ healthcheck: TCP_CHECK });
    } finally {
      await removeServiceContainers(serviceId);
    }
  }, CASE_TIMEOUT_MS);
});
