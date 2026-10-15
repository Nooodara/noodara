// 17-05 / A1-A4, H1, H2: manual rollback on real infrastructure (sshd + dockerd), through the real
// deployment services (triggerRollback, listDeployments), job handler, deploy target and store.
// - Rolled back to a retained image: PREPARING -> DEPLOYING with no clone or build, the target's
//   runtime config restored and checked -> SUCCESS running the target's image; the row carries
//   trigger rollback, rollback_of, previous, commit and image; the history pages carry them all.
// - A2: the running version is 422 ROLLBACK_TARGET_UNAVAILABLE; a foreign or unknown target is the
//   same NOT_FOUND; H1: two parallel requests, with and without an Idempotency-Key, give one queued
//   rollback and one DEPLOYMENT_IN_PROGRESS or the replayed original.
// - The target fails its healthcheck: the version running before the manual rollback is restored.
// - H1: the target image was removed from the host after the API accepted it: the worker re-checks,
//   ends FAILED/ROLLBACK_TARGET_UNAVAILABLE and never touches the running container.
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
type DeploymentServices = ReturnType<DeploymentServicesModule['createDeploymentServices']>;
type TriggerRollbackResult = Awaited<ReturnType<DeploymentServices['triggerRollback']>>;
type DeploymentView = NonNullable<Awaited<ReturnType<DeploymentServices['getDeployment']>>>;
type CredentialStoreModule = typeof import('../../../apps/control-plane/src/services/credential-store.js');
type CursorModule = typeof import('../../../apps/control-plane/src/routes/activity-cursor.js');
type StepsViewModule = typeof import('../../../apps/control-plane/src/deploy/deployment-steps-view.js');
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
const REPO = 'node-api';
const JOB_ACTOR = { type: 'system' } as const;
const USER = { type: 'user', id: randomUUID() } as const;

const httpCheck = (checkPath: string): HealthcheckConfig => ({
  type: 'http',
  path: checkPath,
  port: 3000,
  expectedStatuses: [200],
  probeTimeoutS: 2,
  intervalS: 1,
  retries: 3,
  startPeriodS: 10,
});

/** A4: every history row carries these keys, null or not. */
const HISTORY_KEYS = [
  'trigger',
  'triggeredBy',
  'webhookDeliveryId',
  'commitSha',
  'imageRef',
  'previousDeploymentId',
  'rollbackOfDeploymentId',
] as const;

describe.each(DEPLOY_ENGINE_UBUNTU_VERSIONS)('17-05: manual rollback on real infrastructure, Ubuntu %s', (ubuntu) => {
  let stack: DeployEngineStack | undefined;
  let stackStart: Promise<DeployEngineStack> | undefined;
  let pgStart: Promise<PostgresFixture> | undefined;
  let redisStart: Promise<RedisFixture> | undefined;
  let postgres: PostgresFixture | undefined;
  let redis: RedisFixture | undefined;
  let handler: JobHandler | undefined;
  let api: DeploymentServices | undefined;
  let cursors: CursorModule | undefined;
  let stepsView: StepsViewModule | undefined;
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
  const services$ = (): DeploymentServices => {
    if (api === undefined) throw new Error('deployment services not started');
    return api;
  };
  const root = (argv: readonly string[]) => s().exec(argv, { user: 'root' });
  const rootOut = async (argv: readonly string[]): Promise<string> => (await root(argv)).stdout.trim();
  const containerExists = async (name: string): Promise<boolean> =>
    (await root(['docker', 'container', 'inspect', name])).exitCode === 0;
  const containerField = (name: string, format: string) =>
    rootOut(['docker', 'container', 'inspect', '--format', format, name]);
  const imageOf = (serviceId: string, deploymentId: string) => `noodara/${serviceId}:${deploymentId}`;
  const activityFor = async (deploymentId: string) =>
    db().select().from(activityEvents).where(eq(activityEvents.entityId, deploymentId));
  const phaseLog = (deploymentId: string, phase: string): string =>
    (entries.get(deploymentId) ?? [])
      .filter((entry) => entry.phase === phase)
      .map((entry) => entry.text)
      .join('\n');

  const deploymentRow = async (deploymentId: string) => {
    const [row] = await db().select().from(deployments).where(eq(deployments.id, deploymentId));
    if (!row) throw new Error(`deployment ${deploymentId} missing`);
    return row;
  };

  const insertService = async (healthcheck: HealthcheckConfig): Promise<string> => {
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
        name: `mr-${randomUUID().slice(0, 8)}`,
        sourceType: 'git',
        repositoryUrl: s().gitRepoUrl(REPO),
        branch: 'main',
        buildContext: '.',
        dockerfilePath: 'Dockerfile',
        buildTarget: null,
        internalPort: 3000,
        publishedPort: null,
        repositoryCredentialId: credentialId,
        healthcheck,
        autoRollback: true,
      })
      .returning({ id: services.id });
    if (!row) throw new Error('service insert returned no row');
    return row.id;
  };

  const runJob = async (deploymentId: string, serviceId: string) => {
    if (handler === undefined) throw new Error('runtime not started');
    await handler({ deploymentId, serviceId, actor: JOB_ACTOR, requestedAt: new Date().toISOString() });
    return deploymentRow(deploymentId);
  };

  const deploy = async (serviceId: string) => {
    const result = await services$().triggerDeploy({ actor: USER, serviceId });
    if (!result.ok) throw new Error(`triggerDeploy failed: ${result.code}`);
    const row = await runJob(result.deployment.id, serviceId);
    expect({ status: row.status, errorCode: row.errorCode }).toEqual({ status: 'SUCCESS', errorCode: null });
    return row;
  };

  /** Two healthy deploys: A then B, B running and A's image retained. */
  const deployTwice = async (serviceId: string) => {
    const first = await deploy(serviceId);
    const second = await deploy(serviceId);
    expect(await containerField(`noodara-${serviceId}`, '{{.Config.Image}}')).toBe(imageOf(serviceId, second.id));
    expect((await root(['docker', 'image', 'inspect', imageOf(serviceId, first.id)])).exitCode).toBe(0);
    return { first, second };
  };

  const accepted = (result: TriggerRollbackResult): DeploymentView => {
    if (!result.ok) throw new Error(`triggerRollback failed: ${result.code} ${result.message}`);
    return result.deployment;
  };

  /** A4/H2: every page of the service's history, newest first, through the encoded cursor. */
  const readHistory = async (serviceId: string, limit: number): Promise<DeploymentView[]> => {
    if (cursors === undefined) throw new Error('cursor module not loaded');
    const items: DeploymentView[] = [];
    let cursor: { occurredAt: Date; id: string } | undefined;
    for (let page = 0; page < 20; page += 1) {
      const result = await services$().listDeployments(serviceId, { limit, ...(cursor === undefined ? {} : { cursor }) });
      if (result === null) throw new Error(`history of ${serviceId} not found`);
      expect(result.items.length).toBeLessThanOrEqual(limit);
      items.push(...result.items);
      if (result.nextCursor === null) return items;
      const decoded = cursors.decodeActivityCursor(result.nextCursor);
      if (!decoded.ok) throw new Error('history returned an undecodable cursor');
      cursor = decoded.cursor;
    }
    throw new Error('history did not end');
  };

  const removeServiceContainers = async (serviceId: string): Promise<void> => {
    await root(['docker', 'rm', '-f', `noodara-${serviceId}`, `noodara-${serviceId}-prev`]);
  };

  beforeAll(async () => {
    stackStart = startDeployEngineStack({
      ubuntu,
      seedRepositories: [{ name: REPO, sourceDir: path.join(FIXTURES_DIR, 'node-api') }],
    });
    pgStart = startPostgres();
    redisStart = startRedis();
    const [stackStarted, pgStarted, redisStarted] = await Promise.all([stackStart, pgStart, redisStart]);
    stack = stackStarted;
    postgres = pgStarted;
    redis = redisStarted;

    process.env.NOODARA_MASTER_KEY = masterKey.toString('base64');
    process.env.BETTER_AUTH_SECRET = `runtime-manual-rollback-${randomUUID()}-${randomUUID()}`;
    process.env.DATABASE_URL = postgres.connectionString;
    process.env.REDIS_URL = redis.connectionUrl;
    process.env.NOODARA_PUBLIC_URL = 'http://localhost:3000';

    const runtime: DeployRuntimeModule = await import('../../../apps/control-plane/src/deploy/deploy-runtime.js');
    const workerModule: DeployWorkerModule = await import('../../../apps/control-plane/src/deploy/deploy-worker.js');
    const deploymentServices: DeploymentServicesModule = await import(
      '../../../apps/control-plane/src/services/deployment-services.js'
    );
    const credentialStore: CredentialStoreModule = await import('../../../apps/control-plane/src/services/credential-store.js');
    cursors = await import('../../../apps/control-plane/src/routes/activity-cursor.js');
    stepsView = await import('../../../apps/control-plane/src/deploy/deployment-steps-view.js');

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
        name: `manual-rollback-host-${ubuntu}`,
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
      .values({ name: 'Manual rollback', slug: `mr-${randomUUID().slice(0, 8)}`, createdAt: now, updatedAt: now })
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
    api = deploymentServices.createDeploymentServices({
      db: db(),
      now: () => new Date(),
      events,
      queue: { enqueue: () => Promise.resolve({ ok: true, jobId: 'unused' } as const) },
      logger,
    });
  }, STACK_TIMEOUT_MS);

  afterAll(async () => {
    const [stk, pg, rd] = await Promise.all([
      stack ?? settleWithin(stackStart, PENDING_START_WAIT_MS),
      postgres ?? settleWithin(pgStart, PENDING_START_WAIT_MS),
      redis ?? settleWithin(redisStart, PENDING_START_WAIT_MS),
    ]);
    await runTeardown(
      `runtime manual rollback (Ubuntu ${ubuntu})`,
      [
        { name: 'redis.stop', run: () => rd?.stop(), timeoutMs: FIXTURE_STOP_TIMEOUT_MS },
        { name: 'postgres.stop', run: () => pg?.stop(), timeoutMs: FIXTURE_STOP_TIMEOUT_MS },
        { name: 'stack.stop', run: () => stk?.stop(), timeoutMs: STACK_STOP_TIMEOUT_MS },
      ],
      { stepTimeoutMs: TEARDOWN_STEP_TIMEOUT_MS },
    );
  }, STACK_TIMEOUT_MS);

  it('rolls back to the retained image without a build, refuses bad targets and races, and records the history', async () => {
    const serviceId = await insertService(httpCheck('/health'));
    const otherServiceId = await insertService(httpCheck('/health'));
    try {
      const { first, second } = await deployTwice(serviceId);
      const foreign = await deploy(otherServiceId);

      // A2: the running version is not a target; a foreign target reads exactly like an unknown one.
      const same = await services$().triggerRollback({ actor: USER, serviceId, targetDeploymentId: second.id });
      expect(same).toMatchObject({ ok: false, code: 'ROLLBACK_TARGET_UNAVAILABLE' });
      expect(same.ok ? '' : same.message).toContain('same_as_current');
      const unknownId = randomUUID();
      const unknown = await services$().triggerRollback({ actor: USER, serviceId, targetDeploymentId: unknownId });
      const other = await services$().triggerRollback({ actor: USER, serviceId, targetDeploymentId: foreign.id });
      expect(unknown).toMatchObject({ ok: false, code: 'NOT_FOUND' });
      expect(other).toMatchObject({ ok: false, code: 'NOT_FOUND' });
      expect(other.ok ? '' : other.message.replace(foreign.id, '<id>')).toBe(
        unknown.ok ? '' : unknown.message.replace(unknownId, '<id>'),
      );

      // A1: the default target is the previous retained image (A).
      const view = accepted(await services$().triggerRollback({ actor: USER, serviceId }));
      expect(view).toMatchObject({
        status: 'QUEUED',
        trigger: 'rollback',
        triggeredBy: USER.id,
        rollbackOfDeploymentId: first.id,
        previousDeploymentId: second.id,
        imageRef: imageOf(serviceId, first.id),
        commitSha: first.commitSha,
      });

      // A3: PREPARING -> DEPLOYING -> HEALTHCHECK -> SUCCESS, with no clone and no build.
      const rolled = await runJob(view.id, serviceId);
      expect({ status: rolled.status, errorCode: rolled.errorCode }).toEqual({ status: 'SUCCESS', errorCode: null });
      expect(await containerField(`noodara-${serviceId}`, '{{.State.Status}} {{.Config.Image}}')).toBe(
        `running ${imageOf(serviceId, first.id)}`,
      );
      expect(await containerExists(`noodara-${serviceId}-prev`)).toBe(false);
      expect(phaseLog(rolled.id, 'build')).toBe('');
      if (stepsView === undefined) throw new Error('steps view not loaded');
      const stamps = (await stepsView.readDeploymentStepStamps(db(), [rolled.id])).get(rolled.id);
      expect(stamps?.buildingStartedAt ?? null).toBeNull();
      expect(stamps?.deployingStartedAt).toBeInstanceOf(Date);
      expect(stamps?.verifyingStartedAt).toBeInstanceOf(Date);
      expect((await activityFor(rolled.id)).some((row) => row.action === 'deployment.finished')).toBe(true);

      // H1: two parallel requests without a key: exactly one queued rollback, one in progress.
      const unkeyed = await Promise.all([
        services$().triggerRollback({ actor: USER, serviceId, targetDeploymentId: second.id }),
        services$().triggerRollback({ actor: USER, serviceId, targetDeploymentId: second.id }),
      ]);
      const unkeyedWinners = unkeyed.filter((result) => result.ok);
      expect(unkeyedWinners).toHaveLength(1);
      expect(unkeyed.filter((result) => !result.ok)).toEqual([expect.objectContaining({ code: 'DEPLOYMENT_IN_PROGRESS' })]);
      const back = await runJob(accepted(unkeyedWinners[0] as TriggerRollbackResult).id, serviceId);
      expect(back.status).toBe('SUCCESS');
      expect(await containerField(`noodara-${serviceId}`, '{{.Config.Image}}')).toBe(imageOf(serviceId, second.id));

      // H1: two parallel requests with the same key: one queued, the other replayed or in progress.
      const key = randomUUID();
      const keyed = await Promise.all([
        services$().triggerRollback({ actor: USER, serviceId, targetDeploymentId: first.id, idempotencyKey: key }),
        services$().triggerRollback({ actor: USER, serviceId, targetDeploymentId: first.id, idempotencyKey: key }),
      ]);
      const fresh = keyed.filter((result) => result.ok && !result.replayed);
      expect(fresh).toHaveLength(1);
      const original = accepted(fresh[0] as TriggerRollbackResult);
      const [loser] = keyed.filter((result) => !(result.ok && !result.replayed));
      if (loser?.ok === true) {
        expect(loser.deployment.id).toBe(original.id);
      } else {
        expect(loser).toMatchObject({ ok: false, code: 'DEPLOYMENT_IN_PROGRESS' });
      }
      // A replay after the race returns the same deployment.
      const replay = await services$().triggerRollback({
        actor: USER,
        serviceId,
        targetDeploymentId: first.id,
        idempotencyKey: key,
      });
      expect(replay).toMatchObject({ ok: true, replayed: true, deployment: { id: original.id } });
      expect((await runJob(original.id, serviceId)).status).toBe('SUCCESS');
      const rollbackRows = (await db().select().from(deployments).where(eq(deployments.serviceId, serviceId))).filter(
        (row) => row.trigger === 'rollback',
      );
      expect(rollbackRows).toHaveLength(3);

      // A4/H2: the history pages carry every traceability field and only this service's rows.
      const history = await readHistory(serviceId, 2);
      expect(history.map((item) => item.id)).toEqual(
        [...new Set(history.map((item) => item.id))],
      );
      expect(new Set(history.map((item) => item.id))).toEqual(
        new Set([first.id, second.id, rolled.id, back.id, original.id]),
      );
      for (const item of history) {
        for (const field of HISTORY_KEYS) expect(item).toHaveProperty(field);
        expect(item.serviceId).toBe(serviceId);
      }
      const created = history.map((item) => item.createdAt);
      expect(created).toEqual([...created].sort().reverse());
      expect(history.find((item) => item.id === rolled.id)).toMatchObject({
        trigger: 'rollback',
        triggeredBy: USER.id,
        webhookDeliveryId: null,
        commitSha: first.commitSha,
        imageRef: imageOf(serviceId, first.id),
        previousDeploymentId: second.id,
        rollbackOfDeploymentId: first.id,
      });
      expect(history.find((item) => item.id === second.id)).toMatchObject({
        trigger: 'manual',
        triggeredBy: USER.id,
        rollbackOfDeploymentId: null,
        imageRef: imageOf(serviceId, second.id),
      });
      // No field of the history carries a credential or the runtime snapshot.
      const wire = JSON.stringify(history);
      expect(wire).not.toContain('PRIVATE KEY');
      expect(wire).not.toContain('runtimeConfig');
      expect(wire).not.toContain(key);
      expect(await services$().listDeployments(randomUUID(), { limit: 5 })).toBeNull();
    } finally {
      await removeServiceContainers(serviceId);
      await removeServiceContainers(otherServiceId);
    }
  }, CASE_TIMEOUT_MS);

  it('restores the version running before the manual rollback when the target fails its healthcheck', async () => {
    const serviceId = await insertService(httpCheck('/health'));
    try {
      const { first, second } = await deployTwice(serviceId);
      // The rollback restores the target's runtime config: point its healthcheck at a 404 path.
      const snapshot = first.runtimeConfig;
      if (snapshot === null) throw new Error('first deployment has no runtime_config');
      await db()
        .update(deployments)
        .set({ runtimeConfig: { ...snapshot, healthcheck: httpCheck('/missing') } })
        .where(eq(deployments.id, first.id));

      const view = accepted(await services$().triggerRollback({ actor: USER, serviceId, targetDeploymentId: first.id }));
      const row = await runJob(view.id, serviceId);

      expect({ status: row.status, errorCode: row.errorCode }).toEqual({
        status: 'ROLLED_BACK',
        errorCode: 'HEALTHCHECK_FAILED',
      });
      expect(row.errorMessage).toContain(`deployment ${second.id}`);
      expect(phaseLog(row.id, 'build')).toBe('');
      expect(await containerField(`noodara-${serviceId}`, '{{.State.Status}} {{.Config.Image}}')).toBe(
        `running ${imageOf(serviceId, second.id)}`,
      );
      expect(await containerExists(`noodara-${serviceId}-prev`)).toBe(false);
      const started = (await activityFor(row.id)).filter((event) => event.action === 'deployment.rollback_started');
      expect(started).toHaveLength(1);
      expect(started[0]?.metadata).toMatchObject({ deploymentId: row.id, serviceId, targetDeploymentId: second.id });
    } finally {
      await removeServiceContainers(serviceId);
    }
  }, CASE_TIMEOUT_MS);

  it('re-checks the target image in the worker: gone from the host -> FAILED, the running container untouched', async () => {
    const serviceId = await insertService(httpCheck('/health'));
    try {
      const { first, second } = await deployTwice(serviceId);
      const runningName = `noodara-${serviceId}`;
      const before = await containerField(runningName, '{{.Id}} {{.State.StartedAt}} {{.Config.Image}}');
      // Accepted by the API (the row still names the image), then removed on the host.
      const view = accepted(await services$().triggerRollback({ actor: USER, serviceId, targetDeploymentId: first.id }));
      expect((await root(['docker', 'image', 'rm', imageOf(serviceId, first.id)])).exitCode).toBe(0);

      const row = await runJob(view.id, serviceId);

      expect({ status: row.status, errorCode: row.errorCode }).toEqual({
        status: 'FAILED',
        errorCode: 'ROLLBACK_TARGET_UNAVAILABLE',
      });
      expect(row.rollbackStartedAt).toBeNull();
      expect(await containerField(runningName, '{{.Id}} {{.State.StartedAt}} {{.Config.Image}}')).toBe(before);
      expect(await containerField(runningName, '{{.State.Status}}')).toBe('running');
      expect(before).toContain(imageOf(serviceId, second.id));
      expect(await containerExists(`${runningName}-prev`)).toBe(false);
      expect((await activityFor(row.id)).some((event) => event.action === 'deployment.rollback_started')).toBe(false);
    } finally {
      await removeServiceContainers(serviceId);
    }
  }, CASE_TIMEOUT_MS);
});
