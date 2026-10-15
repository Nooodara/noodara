// 17-07 / A1, A2, A3, A5: the automatic rollback on real infrastructure (sshd + dockerd), through the
// real job handler, deploy target and deployment store.
// - Rolled back: a redeploy to unhealthy-api fails its healthcheck; the failed container is removed,
//   `-prev` renamed back, started and checked with the previous deployment's snapshot -> ROLLED_BACK
//   with the original code, a message naming the restored deployment and a rollback_started event.
// - Restore check fails: the previous snapshot's health path is edited to answer 404 -> ROLLBACK_FAILED.
// - auto_rollback off / first deploy: FAILED, the new container stopped, the previous image kept.
// Every case: no `-prev` orphan, no failed image left unpinned, no workspace.
import { randomBytes, randomUUID } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { HealthcheckConfig } from '@noodara/domain/deployment';
import { createRedactor, secretValue } from '@noodara/domain/security';
import { createSsh2Adapter, formatFingerprint } from '@noodara/ssh';
import {
  activityEvents,
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
const WORKSPACE_ROOT = '/home/deployer/.noodara/deploy';
const REPOS = { healthy: 'node-api', unhealthy: 'unhealthy-api' } as const;
const ACTOR = { type: 'system' } as const;

const TIMING = { probeTimeoutS: 2, intervalS: 1, retries: 3, startPeriodS: 10 };
const httpCheck = (checkPath: string): HealthcheckConfig => ({
  type: 'http',
  path: checkPath,
  port: 3000,
  expectedStatuses: [200],
  ...TIMING,
});

describe.each(DEPLOY_ENGINE_UBUNTU_VERSIONS)('17-07: automatic rollback on real infrastructure, Ubuntu %s', (ubuntu) => {
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
  const pathGone = async (target: string): Promise<boolean> => !(await exists(['test', '-e', target]));
  /** Every image of the service still on the host, sorted. */
  const serviceImages = async (serviceId: string): Promise<string[]> =>
    (await rootOut(['docker', 'image', 'ls', '--format', '{{.Repository}}:{{.Tag}}', `noodara/${serviceId}`]))
      .split('\n')
      .filter((line) => line !== '')
      .sort();
  /** A5: no workspace left behind (the base exists, so the check is not vacuous). */
  const expectWorkspaceGone = async (deploymentId: string): Promise<void> => {
    expect(await exists(['test', '-d', WORKSPACE_ROOT]), 'workspace base missing').toBe(true);
    expect(await pathGone(`${WORKSPACE_ROOT}/${deploymentId}`)).toBe(true);
  };
  const activityFor = async (deploymentId: string) =>
    db().select().from(activityEvents).where(eq(activityEvents.entityId, deploymentId));

  const deploymentRow = async (deploymentId: string) => {
    const [row] = await db().select().from(deployments).where(eq(deployments.id, deploymentId));
    if (!row) throw new Error(`deployment ${deploymentId} missing`);
    return row;
  };
  const phaseLog = (deploymentId: string, phase: string): string =>
    (entries.get(deploymentId) ?? [])
      .filter((entry) => entry.phase === phase)
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
        name: `rb-${randomUUID().slice(0, 8)}`,
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
    process.env.BETTER_AUTH_SECRET = `runtime-rollback-${randomUUID()}-${randomUUID()}`;
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
        name: `rollback-host-${ubuntu}`,
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
      .values({ name: 'Runtime rollback', slug: `rb-${randomUUID().slice(0, 8)}`, createdAt: now, updatedAt: now })
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
      `runtime rollback (Ubuntu ${ubuntu})`,
      [
        { name: 'redis.stop', run: () => rd?.stop(), timeoutMs: FIXTURE_STOP_TIMEOUT_MS },
        { name: 'postgres.stop', run: () => pg?.stop(), timeoutMs: FIXTURE_STOP_TIMEOUT_MS },
        { name: 'stack.stop', run: () => stk?.stop(), timeoutMs: STACK_STOP_TIMEOUT_MS },
      ],
      { stepTimeoutMs: TEARDOWN_STEP_TIMEOUT_MS },
    );
  }, STACK_TIMEOUT_MS);

  /** A redeploy that fails its healthcheck: a healthy first deploy, then unhealthy-api on /healthz. */
  const deployThenBreak = async (serviceId: string) => {
    const first = await deploy(serviceId);
    expect({ status: first.status, errorCode: first.errorCode }).toEqual({ status: 'SUCCESS', errorCode: null });
    await updateService(serviceId, REPOS.unhealthy, httpCheck('/healthz'));
    return first;
  };

  it('rolled back: the failed container is removed and -prev restored, checked and named in the message', async () => {
    const serviceId = await insertService(REPOS.healthy, httpCheck('/health'));
    try {
      const first = await deployThenBreak(serviceId);

      const second = await deploy(serviceId);

      // A2: ROLLED_BACK keeps the original code; the message names the restored version.
      expect({ status: second.status, errorCode: second.errorCode }).toEqual({
        status: 'ROLLED_BACK',
        errorCode: 'HEALTHCHECK_FAILED',
      });
      expect(second.errorMessage).toMatch(/did not pass its healthcheck/);
      expect(second.errorMessage).toContain(`The previous version (deployment ${first.id}) was restored automatically.`);
      expect(second.rollbackStartedAt).toBeInstanceOf(Date);
      // A1: checked with the previous deployment's snapshot (its /health path answers 200).
      const rollbackLog = phaseLog(second.id, 'rollback');
      expect(rollbackLog).toContain('Rolling back: restoring the previous version.');
      expect(rollbackLog).toMatch(/Healthcheck attempt \d+: HTTP 200/);
      expect(rollbackLog).toContain('The previous version was restored and passed its healthcheck.');
      expect(await containerField(`noodara-${serviceId}`, '{{.State.Status}} {{.Config.Image}}')).toBe(
        `running noodara/${serviceId}:${first.id}`,
      );
      // A5: no -prev orphan, the failed image is gone, only the restored image remains, no workspace.
      expect(await containerExists(`noodara-${serviceId}-prev`)).toBe(false);
      expect(await serviceImages(serviceId)).toEqual([`noodara/${serviceId}:${first.id}`]);
      const networks = JSON.parse(
        await containerField(`noodara-${serviceId}`, '{{json .NetworkSettings.Networks}}'),
      ) as Record<string, unknown>;
      expect(Object.keys(networks)).toContain(`noodara-net-${serviceId}`);
      await expectWorkspaceGone(second.id);
      // A4: the rollback start is an activity event with ids only; the result is deployment.finished.
      const activity = await activityFor(second.id);
      const started = activity.filter((row) => row.action === 'deployment.rollback_started');
      expect(started).toHaveLength(1);
      expect(started[0]).toMatchObject({
        actorType: 'system',
        entityType: 'deployment',
        metadata: { deploymentId: second.id, serviceId, targetDeploymentId: first.id },
      });
      expect(JSON.stringify(started[0]?.metadata)).not.toContain('noodara/');
      expect(activity.some((row) => row.action === 'deployment.finished')).toBe(true);
    } finally {
      await removeServiceContainers(serviceId);
    }
  }, CASE_TIMEOUT_MS);

  it('restore check fails: the previous snapshot no longer passes, the attempt ends FAILED/ROLLBACK_FAILED', async () => {
    const serviceId = await insertService(REPOS.healthy, httpCheck('/health'));
    try {
      const first = await deployThenBreak(serviceId);
      // The restore is checked with the previous deployment's snapshot: point it at a 404 path.
      const snapshot = first.runtimeConfig;
      if (snapshot === null) throw new Error('first deployment has no runtime_config');
      await db()
        .update(deployments)
        .set({ runtimeConfig: { ...snapshot, healthcheck: httpCheck('/missing') } })
        .where(eq(deployments.id, first.id));

      const second = await deploy(serviceId);

      expect({ status: second.status, errorCode: second.errorCode }).toEqual({
        status: 'FAILED',
        errorCode: 'ROLLBACK_FAILED',
      });
      expect(second.rollbackStartedAt).toBeInstanceOf(Date);
      const rollbackLog = phaseLog(second.id, 'rollback');
      expect(rollbackLog).toMatch(/Healthcheck attempt \d+: HTTP 404/);
      expect(rollbackLog).toContain('The previous version could not be restored.');
      // A5: the restored container holds the service name; no -prev, no failed image, no workspace.
      expect(await containerField(`noodara-${serviceId}`, '{{.Config.Image}}')).toBe(`noodara/${serviceId}:${first.id}`);
      expect(await containerExists(`noodara-${serviceId}-prev`)).toBe(false);
      expect(await serviceImages(serviceId)).toEqual([`noodara/${serviceId}:${first.id}`]);
      await expectWorkspaceGone(second.id);
      expect((await activityFor(second.id)).filter((row) => row.action === 'deployment.rollback_started')).toHaveLength(1);
    } finally {
      await removeServiceContainers(serviceId);
    }
  }, CASE_TIMEOUT_MS);

  it('auto_rollback off: FAILED, the new container stopped and -prev kept with the previous image', async () => {
    const serviceId = await insertService(REPOS.healthy, httpCheck('/health'), { autoRollback: false });
    try {
      const first = await deployThenBreak(serviceId);

      const second = await deploy(serviceId);

      expect({ status: second.status, errorCode: second.errorCode }).toEqual({
        status: 'FAILED',
        errorCode: 'HEALTHCHECK_FAILED',
      });
      expect(second.rollbackStartedAt).toBeNull();
      expect(phaseLog(second.id, 'rollback')).toBe('');
      // A3: the new container is stopped; the previous one and its image stay for a manual rollback.
      expect(await containerField(`noodara-${serviceId}`, '{{.State.Status}} {{.Config.Image}}')).toBe(
        `exited noodara/${serviceId}:${second.id}`,
      );
      expect(await containerField(`noodara-${serviceId}-prev`, '{{.State.Status}} {{.Config.Image}}')).toBe(
        `exited noodara/${serviceId}:${first.id}`,
      );
      expect(await imageExists(`noodara/${serviceId}:${first.id}`)).toBe(true);
      await expectWorkspaceGone(second.id);
      expect((await activityFor(second.id)).some((row) => row.action === 'deployment.rollback_started')).toBe(false);
    } finally {
      await removeServiceContainers(serviceId);
    }
  }, CASE_TIMEOUT_MS);

  it('first deploy: no -prev to restore, FAILED with the new container stopped and no rollback', async () => {
    const serviceId = await insertService(REPOS.unhealthy, httpCheck('/healthz'));
    try {
      const row = await deploy(serviceId);

      expect({ status: row.status, errorCode: row.errorCode }).toEqual({ status: 'FAILED', errorCode: 'HEALTHCHECK_FAILED' });
      expect(row.rollbackStartedAt).toBeNull();
      expect(phaseLog(row.id, 'rollback')).toBe('');
      expect(await containerField(`noodara-${serviceId}`, '{{.State.Status}}')).toBe('exited');
      expect(await containerExists(`noodara-${serviceId}-prev`)).toBe(false);
      await expectWorkspaceGone(row.id);
      expect((await activityFor(row.id)).some((event) => event.action === 'deployment.rollback_started')).toBe(false);
    } finally {
      await removeServiceContainers(serviceId);
    }
  }, CASE_TIMEOUT_MS);
});
