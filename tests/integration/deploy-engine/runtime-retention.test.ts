// 17-04 / A1, A3, H1: image retention on real infrastructure (sshd + dockerd), through the real job
// handler, deploy target and deployment store wired by createDeployJobDeps.
// - Five healthy deploys with retention 3: the running image and the three previous known-good
//   images remain; the oldest goes.
// - A ROLLED_BACK redeploy also runs retention (lowered to 1 for the proof): the restored running
//   image and one previous known-good image remain.
// - H1: an image outside noodara/<serviceId>, or without the managed labels, is never touched.
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
const CASE_TIMEOUT_MS = 900_000;
const KEY_VERSION = 1;
const DEPLOY_MAX_MS = 300_000;
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

describe.each(DEPLOY_ENGINE_UBUNTU_VERSIONS)('17-04: image retention on real infrastructure, Ubuntu %s', (ubuntu) => {
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
  const containerField = (name: string, format: string) =>
    rootOut(['docker', 'container', 'inspect', '--format', format, name]);
  /** Every image of the service still on the host, sorted. */
  const serviceImages = async (serviceId: string): Promise<string[]> =>
    (await rootOut(['docker', 'image', 'ls', '--format', '{{.Repository}}:{{.Tag}}', `noodara/${serviceId}`]))
      .split('\n')
      .filter((line) => line !== '')
      .sort();
  const deploymentRow = async (deploymentId: string) => {
    const [row] = await db().select().from(deployments).where(eq(deployments.id, deploymentId));
    if (!row) throw new Error(`deployment ${deploymentId} missing`);
    return row;
  };
  const insertService = async (
    repo: string,
    healthcheck: HealthcheckConfig | null,
    imageRetention: number,
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
        name: `ret-${randomUUID().slice(0, 8)}`,
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
        autoRollback: true,
        imageRetention,
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
    process.env.BETTER_AUTH_SECRET = `runtime-retention-${randomUUID()}-${randomUUID()}`;
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
        name: `retention-host-${ubuntu}`,
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
      .values({ name: 'Runtime retention', slug: `ret-${randomUUID().slice(0, 8)}`, createdAt: now, updatedAt: now })
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
      `runtime retention (Ubuntu ${ubuntu})`,
      [
        { name: 'redis.stop', run: () => rd?.stop(), timeoutMs: FIXTURE_STOP_TIMEOUT_MS },
        { name: 'postgres.stop', run: () => pg?.stop(), timeoutMs: FIXTURE_STOP_TIMEOUT_MS },
        { name: 'stack.stop', run: () => stk?.stop(), timeoutMs: STACK_STOP_TIMEOUT_MS },
      ],
      { stepTimeoutMs: TEARDOWN_STEP_TIMEOUT_MS },
    );
  }, STACK_TIMEOUT_MS);

  const imageOf = (serviceId: string, deploymentId: string) => `noodara/${serviceId}:${deploymentId}`;
  const setRetention = async (serviceId: string, imageRetention: number): Promise<void> => {
    await db().update(services).set({ imageRetention }).where(eq(services.id, serviceId));
  };
  const deployHealthy = async (serviceId: string) => {
    const row = await deploy(serviceId);
    expect({ status: row.status, errorCode: row.errorCode }).toEqual({ status: 'SUCCESS', errorCode: null });
    return row;
  };

  it('A1/A3/H1: after five deploys with retention 3 the running image and three previous known-good ones remain', async () => {
    const serviceId = await insertService(REPOS.healthy, httpCheck('/health'), 3);
    // H1: a labelled copy outside noodara/<serviceId> and an unlabelled own-repository image.
    const foreign = `noodara-foreign/${serviceId}:keep`;
    const unlabelled = imageOf(serviceId, randomUUID());
    try {
      const ids: string[] = [];
      for (let n = 1; n <= 5; n += 1) {
        ids.push((await deployHealthy(serviceId)).id);
        if (n === 1) {
          const first = ids[0] ?? '';
          expect((await root(['docker', 'image', 'tag', imageOf(serviceId, first), foreign])).exitCode).toBe(0);
          const imported = await root(['sh', '-c', `tar -cf - --files-from /dev/null | docker image import - ${unlabelled}`]);
          expect(imported.exitCode).toBe(0);
        }
        if (n === 4) {
          // Four deploys: the running image plus three previous, nothing removed yet.
          expect(await serviceImages(serviceId)).toEqual(ids.map((id) => imageOf(serviceId, id)).concat(unlabelled).sort());
        }
      }

      const [, ...kept] = ids;
      expect(await serviceImages(serviceId)).toEqual(kept.map((id) => imageOf(serviceId, id)).concat(unlabelled).sort());
      expect(await imageExists(imageOf(serviceId, ids[0] ?? ''))).toBe(false);
      expect(await containerField(`noodara-${serviceId}`, '{{.State.Status}} {{.Config.Image}}')).toBe(
        `running ${imageOf(serviceId, ids[4] ?? '')}`,
      );
      // H1: only noodara/<serviceId> images with the managed labels are ever candidates.
      expect(await imageExists(foreign)).toBe(true);
      expect(await imageExists(unlabelled)).toBe(true);
    } finally {
      await removeServiceContainers(serviceId);
      await root(['docker', 'image', 'rm', foreign, unlabelled]);
    }
  }, CASE_TIMEOUT_MS);

  it('A1: retention also runs after ROLLED_BACK and never removes the restored running image', async () => {
    const serviceId = await insertService(REPOS.healthy, httpCheck('/health'), 3);
    try {
      const first = await deployHealthy(serviceId);
      const second = await deployHealthy(serviceId);
      const third = await deployHealthy(serviceId);
      expect(await serviceImages(serviceId)).toEqual([first.id, second.id, third.id].map((id) => imageOf(serviceId, id)).sort());

      // Lowered to 1 so the ROLLED_BACK run has something to remove.
      await setRetention(serviceId, 1);
      await updateService(serviceId, REPOS.unhealthy, httpCheck('/healthz'));
      const failed = await deploy(serviceId);

      expect({ status: failed.status, errorCode: failed.errorCode }).toEqual({
        status: 'ROLLED_BACK',
        errorCode: 'HEALTHCHECK_FAILED',
      });
      expect(await containerField(`noodara-${serviceId}`, '{{.State.Status}} {{.Config.Image}}')).toBe(
        `running ${imageOf(serviceId, third.id)}`,
      );
      // The restored running image plus one previous known-good; the failed image is gone too.
      expect(await serviceImages(serviceId)).toEqual([second.id, third.id].map((id) => imageOf(serviceId, id)).sort());
    } finally {
      await removeServiceContainers(serviceId);
    }
  }, CASE_TIMEOUT_MS);
});
