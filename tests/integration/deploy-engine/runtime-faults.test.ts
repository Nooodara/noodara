// 17-06 A2/A3: runtime faults on real infrastructure (sshd + dockerd), through the real job handler,
// deployment store and boot sweep. Each fault is injected deterministically right before the
// worker's next remote command once the store records the step:
// - container crash during HEALTHCHECK: the new container is killed -> ROLLED_BACK, -prev restored.
// - SSH interruption during HEALTHCHECK / ROLLING_BACK: every sshd process is SIGSTOPped (the TCP
//   connection stays up, nothing answers) for a while, then resumed -> one terminal state.
// - worker kill in HEALTHCHECK: the worker freezes and drops its connection; the sweep first finds
//   the server unreachable (sshd paused) and leaves the row, then restores -prev -> FAILED/
//   WORKER_CRASHED; with no -prev the only version is left exactly as it is.
// Every case: one terminal state, only `noodara-<svc>` left among the service's containers.
import { randomBytes, randomUUID } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  canTransitionDeployment,
  DEPLOYMENT_TRIGGERS,
  type DeploymentStatus,
  type HealthcheckConfig,
} from '@noodara/domain/deployment';
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
import type { ServerEvent } from '../../../apps/control-plane/src/events/server-event-publisher.js';
import type { DeployJobDeps } from '../../../apps/control-plane/src/deploy/deploy-worker.js';
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
type RunDeploymentModule = typeof import('../../../apps/control-plane/src/deploy/run-deployment.js');
type JobHandler = ReturnType<DeployWorkerModule['createDeployJobHandler']>;

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES_DIR = path.resolve(HERE, '../../../fixtures');
const STACK_TIMEOUT_MS = 900_000;
const PENDING_START_WAIT_MS = 180_000;
const TEARDOWN_STEP_TIMEOUT_MS = 30_000;
const FIXTURE_STOP_TIMEOUT_MS = 60_000;
const STACK_STOP_TIMEOUT_MS = 300_000;
const CASE_TIMEOUT_MS = 600_000;
const WAIT_MS = 300_000;
const POLL_MS = 500;
const KEY_VERSION = 1;
const DEPLOY_MAX_MS = 300_000;
const CONNECT_MS = 10_000;
const WORKSPACE_ROOT = '/home/deployer/.noodara/deploy';
const REPOS = { healthy: 'node-api', unhealthy: 'unhealthy-api' } as const;
const ACTOR = { type: 'system' } as const;
const TERMINAL = new Set(['SUCCESS', 'FAILED', 'CANCELLED', 'ROLLED_BACK']);
/** Below the SSH keepalive budget (3 x 10 s): the connection survives, every command stalls. */
const SSHD_PAUSE_MS = 12_000;

const httpCheck = (checkPath: string, startPeriodS = 5): HealthcheckConfig => ({
  type: 'http',
  path: checkPath,
  port: 3000,
  expectedStatuses: [200],
  probeTimeoutS: 2,
  intervalS: 1,
  retries: 3,
  startPeriodS,
});

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** A promise that settles only while `isCrashed()` is false; after the crash it never settles. */
function gate<T>(work: Promise<T>, isCrashed: () => boolean): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    work.then(
      (value) => {
        if (!isCrashed()) resolve(value);
      },
      (error: unknown) => {
        if (!isCrashed()) reject(error instanceof Error ? error : new Error(String(error)));
      },
    );
  });
}

/** Every async method of `target` freezes once `isCrashed()` turns true: a dead process takes no further step. */
function freezeOnCrash<T extends object>(target: T, isCrashed: () => boolean): T {
  return new Proxy(target, {
    get(object, property, receiver) {
      const value: unknown = Reflect.get(object, property, receiver);
      if (typeof value !== 'function') return value;
      return (...args: unknown[]): unknown => {
        if (isCrashed()) return new Promise(() => undefined);
        const result: unknown = (value as (...a: unknown[]) => unknown).apply(object, args);
        return result instanceof Promise ? gate(result, isCrashed) : result;
      };
    },
  });
}

interface LoggedLine {
  readonly level: string;
  readonly fields: Record<string, unknown>;
  readonly message: string;
}

describe.each(DEPLOY_ENGINE_UBUNTU_VERSIONS)('17-06: runtime faults on real infrastructure, Ubuntu %s', (ubuntu) => {
  let stack: DeployEngineStack | undefined;
  let stackStart: Promise<DeployEngineStack> | undefined;
  let pgStart: Promise<PostgresFixture> | undefined;
  let redisStart: Promise<RedisFixture> | undefined;
  let postgres: PostgresFixture | undefined;
  let redis: RedisFixture | undefined;
  let handler: JobHandler | undefined;
  let workerModule: DeployWorkerModule | undefined;
  let runModule: RunDeploymentModule | undefined;
  let jobDeps: DeployJobDeps | undefined;
  let createRow: ((serviceId: string) => Promise<string>) | undefined;
  let projectId = '';
  let environmentId = '';
  let serverId = '';

  const masterKey = randomBytes(32);
  const events: ServerEvent[] = [];
  const logged: LoggedLine[] = [];
  /** Called on every published event, before the worker's next remote command. */
  let onEvent: ((event: ServerEvent) => void) | null = null;
  /** One-shot: awaited right before the worker's next remote command is sent. */
  let beforeStream: (() => Promise<void>) | null = null;

  const s = (): DeployEngineStack => {
    if (stack === undefined) throw new Error('stack not started');
    return stack;
  };
  const db = (): PostgresFixture['db'] => {
    if (postgres === undefined) throw new Error('postgres not started');
    return postgres.db;
  };
  const deps = (): DeployJobDeps => {
    if (jobDeps === undefined) throw new Error('runtime not started');
    return jobDeps;
  };
  const root = (argv: readonly string[]) => s().exec(argv, { user: 'root' });
  const rootOut = async (argv: readonly string[]): Promise<string> => (await root(argv)).stdout.trim();
  const exists = async (argv: readonly string[]): Promise<boolean> => (await root(argv)).exitCode === 0;
  const imageExists = (ref: string) => exists(['docker', 'image', 'inspect', ref]);
  const containerExists = (name: string) => exists(['docker', 'container', 'inspect', name]);
  const containerField = (name: string, format: string) =>
    rootOut(['docker', 'container', 'inspect', '--format', format, name]);
  /** No orphan: every managed container of the service, sorted. */
  const serviceContainers = async (serviceId: string): Promise<string[]> =>
    (await rootOut(['docker', 'ps', '-a', '--filter', 'label=noodara.managed=true', '--format', '{{.Names}}']))
      .split('\n')
      .filter((name) => name.startsWith(`noodara-${serviceId}`))
      .sort();
  const expectWorkspaceGone = async (deploymentId: string): Promise<void> => {
    expect(await exists(['test', '-d', WORKSPACE_ROOT]), 'workspace base missing').toBe(true);
    expect(await exists(['test', '-e', `${WORKSPACE_ROOT}/${deploymentId}`])).toBe(false);
  };

  /** SSH interruption: every sshd process stops answering; docker exec into the host still works. */
  const sshd = async (signal: 'STOP' | 'CONT'): Promise<void> => {
    const signalled = await root(['pkill', `-${signal}`, '-x', 'sshd']);
    // Ubuntu 22.04/24.04 ship OpenSSH < 9.8: every sshd process (listener and sessions) is `sshd`.
    expect(signalled.exitCode, 'no sshd process was signalled').toBe(0);
  };

  const deploymentRow = async (deploymentId: string) => {
    const [row] = await db().select().from(deployments).where(eq(deployments.id, deploymentId));
    if (!row) throw new Error(`deployment ${deploymentId} missing`);
    return row;
  };
  const waitFor = async (what: string, check: () => Promise<boolean>, timeoutMs = WAIT_MS): Promise<void> => {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      if (await check()) return;
      if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
      await delay(POLL_MS);
    }
  };
  const deploymentStatuses = (deploymentId: string): string[] =>
    events.flatMap((event) =>
      event.type === 'deployment.updated' && event.deployment.id === deploymentId ? [event.deployment.status] : [],
    );
  /** A4: one terminal state, reached only along edges the domain state machine allows. */
  const terminalStatuses = (deploymentId: string): string[] => {
    // Updates that keep the status (commit SHA, rollback start) are not edges.
    const seen = (deploymentStatuses(deploymentId) as DeploymentStatus[]).filter(
      (status, index, all) => index === 0 || all[index - 1] !== status,
    );
    seen.slice(1).forEach((to, index) => {
      const from = seen[index] as DeploymentStatus;
      const allowed = DEPLOYMENT_TRIGGERS.some((trigger) => canTransitionDeployment(from, to, trigger));
      expect(allowed, `${from} -> ${to} in ${seen.join(' -> ')}`).toBe(true);
    });
    return seen.filter((status) => TERMINAL.has(status));
  };

  /** Arms `fault` for the next remote command once `deploymentId` reaches `status`. */
  const injectAt = (deploymentId: string, status: string, fault: () => Promise<void>): { fired: () => boolean } => {
    let fired = false;
    onEvent = (event) => {
      if (event.type !== 'deployment.updated' || event.deployment.id !== deploymentId) return;
      if (event.deployment.status !== status || fired) return;
      fired = true;
      beforeStream = fault;
    };
    return { fired: () => fired };
  };

  const insertService = async (repo: string, healthcheck: HealthcheckConfig): Promise<string> => {
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
        name: `fault-${randomUUID().slice(0, 8)}`,
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
      })
      .returning({ id: services.id });
    if (!row) throw new Error('service insert returned no row');
    return row.id;
  };
  const updateService = async (serviceId: string, repo: string, healthcheck: HealthcheckConfig): Promise<void> => {
    await db()
      .update(services)
      .set({ repositoryUrl: s().gitRepoUrl(repo), healthcheck })
      .where(eq(services.id, serviceId));
  };

  const deploy = async (serviceId: string, deploymentId?: string) => {
    if (handler === undefined || createRow === undefined) throw new Error('runtime not started');
    const id = deploymentId ?? (await createRow(serviceId));
    await handler({ deploymentId: id, serviceId, actor: ACTOR, requestedAt: new Date().toISOString() });
    return deploymentRow(id);
  };
  const newRow = (serviceId: string): Promise<string> => {
    if (createRow === undefined) throw new Error('runtime not started');
    return createRow(serviceId);
  };
  const healthyFirst = async (serviceId: string) => {
    const first = await deploy(serviceId);
    expect({ status: first.status, errorCode: first.errorCode }).toEqual({ status: 'SUCCESS', errorCode: null });
    return first;
  };
  /** The service ends with only the given version, running under its name. */
  const expectOnlyRunning = async (serviceId: string, deploymentId: string): Promise<void> => {
    expect(await containerField(`noodara-${serviceId}`, '{{.State.Status}} {{.Config.Image}}')).toBe(
      `running noodara/${serviceId}:${deploymentId}`,
    );
    expect(await serviceContainers(serviceId)).toEqual([`noodara-${serviceId}`]);
  };
  const removeServiceContainers = async (serviceId: string): Promise<void> => {
    onEvent = null;
    beforeStream = null;
    await sshd('CONT');
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
    process.env.BETTER_AUTH_SECRET = `runtime-faults-${randomUUID()}-${randomUUID()}`;
    process.env.DATABASE_URL = postgres.connectionString;
    process.env.REDIS_URL = redis.connectionUrl;
    process.env.NOODARA_PUBLIC_URL = 'http://localhost:3000';

    const runtime: DeployRuntimeModule = await import('../../../apps/control-plane/src/deploy/deploy-runtime.js');
    workerModule = await import('../../../apps/control-plane/src/deploy/deploy-worker.js');
    runModule = await import('../../../apps/control-plane/src/deploy/run-deployment.js');
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
        name: `faults-host-${ubuntu}`,
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
      .values({ name: 'Runtime faults', slug: `faults-${randomUUID().slice(0, 8)}`, createdAt: now, updatedAt: now })
      .returning({ id: projects.id });
    if (!projectRow) throw new Error('project insert returned no row');
    projectId = projectRow.id;
    const [environmentRow] = await db()
      .insert(environments)
      .values({ projectId, name: 'production', createdAt: now, updatedAt: now })
      .returning({ id: environments.id });
    if (!environmentRow) throw new Error('environment insert returned no row');
    environmentId = environmentRow.id;

    const recordingEvents = {
      publish(event: ServerEvent): Promise<void> {
        events.push(event);
        onEvent?.(event);
        return Promise.resolve();
      },
    };
    const logger = {
      info: (fields: Record<string, unknown>, message: string) => logged.push({ level: 'info', fields, message }),
      warn: (fields: Record<string, unknown>, message: string) => logged.push({ level: 'warn', fields, message }),
      error: (fields: Record<string, unknown>, message: string) => logged.push({ level: 'error', fields, message }),
    };
    const created = runtime.createDeployJobDeps({
      db: db(),
      events: recordingEvents,
      ssh: createSsh2Adapter(),
      timeouts: { connectMs: CONNECT_MS, commandMs: 60_000, discoveryMs: 120_000 },
      masterKeys: () => Promise.resolve({ current: masterKey }),
      panelPorts: [],
      config: { deployMaxMs: DEPLOY_MAX_MS, idleMs: 120_000, logMaxBytes: 1_048_576, logLineMaxBytes: 16_384 },
      logger,
    });
    // Every remote command of the worker first runs the armed fault, if any.
    jobDeps = {
      ...created,
      connect: async (id, runRedactor, signal) => {
        const connected = await created.connect(id, runRedactor, signal);
        if (!connected.ok) return connected;
        const session = new Proxy(connected.session, {
          get(object, property, receiver) {
            const value: unknown = Reflect.get(object, property, receiver);
            if (property !== 'stream' || typeof value !== 'function') return value;
            return async (...args: unknown[]): Promise<unknown> => {
              const fault = beforeStream;
              beforeStream = null;
              if (fault !== null) await fault();
              return (value as (...a: unknown[]) => Promise<unknown>).apply(object, args);
            };
          },
        });
        return { ...connected, session };
      },
    };
    handler = workerModule.createDeployJobHandler(jobDeps);
    const api = deploymentServices.createDeploymentServices({
      db: db(),
      now: () => new Date(),
      events: recordingEvents,
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
      `runtime faults (Ubuntu ${ubuntu})`,
      [
        { name: 'redis.stop', run: () => rd?.stop(), timeoutMs: FIXTURE_STOP_TIMEOUT_MS },
        { name: 'postgres.stop', run: () => pg?.stop(), timeoutMs: FIXTURE_STOP_TIMEOUT_MS },
        { name: 'stack.stop', run: () => stk?.stop(), timeoutMs: STACK_STOP_TIMEOUT_MS },
      ],
      { stepTimeoutMs: TEARDOWN_STEP_TIMEOUT_MS },
    );
  }, STACK_TIMEOUT_MS);

  it('container crash during HEALTHCHECK: the attempt rolls back to -prev and ends ROLLED_BACK', async () => {
    const serviceId = await insertService(REPOS.healthy, httpCheck('/health'));
    try {
      const first = await healthyFirst(serviceId);
      const deploymentId = await newRow(serviceId);
      const fault = injectAt(deploymentId, 'HEALTHCHECK', async () => {
        const killed = await root(['docker', 'kill', `noodara-${serviceId}`]);
        expect(killed.exitCode, killed.stderr).toBe(0);
      });

      const row = await deploy(serviceId, deploymentId);

      expect(fault.fired()).toBe(true);
      expect(row.status).toBe('ROLLED_BACK');
      expect(row.errorMessage).toContain(`(deployment ${first.id}) was restored automatically.`);
      expect(terminalStatuses(deploymentId)).toEqual(['ROLLED_BACK']);
      await expectOnlyRunning(serviceId, first.id);
      expect(await imageExists(`noodara/${serviceId}:${deploymentId}`)).toBe(false);
      await expectWorkspaceGone(deploymentId);
    } finally {
      await removeServiceContainers(serviceId);
    }
  }, CASE_TIMEOUT_MS);

  it('SSH interruption during HEALTHCHECK (sshd paused): the stalled check resumes and the attempt ends SUCCESS', async () => {
    const serviceId = await insertService(REPOS.healthy, httpCheck('/health'));
    try {
      await healthyFirst(serviceId);
      const deploymentId = await newRow(serviceId);
      let pausedIn = '';
      let pausedAt = 0;
      let resumed: Promise<void> = Promise.resolve();
      const fault = injectAt(deploymentId, 'HEALTHCHECK', async () => {
        await sshd('STOP');
        pausedAt = Date.now();
        pausedIn = (await deploymentRow(deploymentId)).status;
        resumed = delay(SSHD_PAUSE_MS).then(() => sshd('CONT'));
      });

      const row = await deploy(serviceId, deploymentId);
      const doneAt = Date.now();
      await resumed;
      // The worker's command really stalled until sshd answered again.
      expect(doneAt - pausedAt).toBeGreaterThanOrEqual(SSHD_PAUSE_MS);

      expect(fault.fired()).toBe(true);
      expect(pausedIn).toBe('HEALTHCHECK');
      expect({ status: row.status, errorCode: row.errorCode }).toEqual({ status: 'SUCCESS', errorCode: null });
      expect(terminalStatuses(deploymentId)).toEqual(['SUCCESS']);
      // The superseded version is gone only after the check passed: no -prev orphan.
      await expectOnlyRunning(serviceId, deploymentId);
      await expectWorkspaceGone(deploymentId);
    } finally {
      await removeServiceContainers(serviceId);
    }
  }, CASE_TIMEOUT_MS);

  it('SSH interruption during ROLLING_BACK (sshd paused): the restore resumes and the attempt ends ROLLED_BACK', async () => {
    const serviceId = await insertService(REPOS.healthy, httpCheck('/health'));
    try {
      const first = await healthyFirst(serviceId);
      await updateService(serviceId, REPOS.unhealthy, httpCheck('/healthz', 3));
      const deploymentId = await newRow(serviceId);
      let pausedIn = '';
      let pausedAt = 0;
      let resumed: Promise<void> = Promise.resolve();
      const fault = injectAt(deploymentId, 'ROLLING_BACK', async () => {
        await sshd('STOP');
        pausedAt = Date.now();
        pausedIn = (await deploymentRow(deploymentId)).status;
        resumed = delay(SSHD_PAUSE_MS).then(() => sshd('CONT'));
      });

      const row = await deploy(serviceId, deploymentId);
      const doneAt = Date.now();
      await resumed;
      // The worker's command really stalled until sshd answered again.
      expect(doneAt - pausedAt).toBeGreaterThanOrEqual(SSHD_PAUSE_MS);

      expect(fault.fired()).toBe(true);
      expect(pausedIn).toBe('ROLLING_BACK');
      expect({ status: row.status, errorCode: row.errorCode }).toEqual({ status: 'ROLLED_BACK', errorCode: 'HEALTHCHECK_FAILED' });
      expect(terminalStatuses(deploymentId)).toEqual(['ROLLED_BACK']);
      await expectOnlyRunning(serviceId, first.id);
      expect(await imageExists(`noodara/${serviceId}:${deploymentId}`)).toBe(false);
      await expectWorkspaceGone(deploymentId);
    } finally {
      await removeServiceContainers(serviceId);
    }
  }, CASE_TIMEOUT_MS);

  /** A worker that dies the moment the store records HEALTHCHECK: it never sends another command. */
  const crashInHealthcheck = async (serviceId: string): Promise<string> => {
    if (workerModule === undefined || createRow === undefined) throw new Error('runtime not started');
    const deploymentId = await createRow(serviceId);
    let crashed = false;
    const isCrashed = (): boolean => crashed;
    const closes: (() => Promise<void>)[] = [];
    onEvent = (event) => {
      if (event.type === 'deployment.updated' && event.deployment.id === deploymentId && event.deployment.status === 'HEALTHCHECK') {
        crashed = true;
      }
    };
    const doomed = workerModule.createDeployJobHandler({
      ...deps(),
      store: freezeOnCrash(deps().store, isCrashed),
      connect: async (id, runRedactor, signal) => {
        const connected = await deps().connect(id, runRedactor, signal);
        if (!connected.ok) return connected;
        closes.push(connected.close);
        return { ...connected, session: freezeOnCrash(connected.session, isCrashed), close: () => gate(connected.close(), isCrashed) };
      },
    });
    void doomed({ deploymentId, serviceId, actor: ACTOR, requestedAt: new Date().toISOString() });
    await waitFor('the worker to die in HEALTHCHECK', () => Promise.resolve(crashed));
    onEvent = null;
    await Promise.all(closes.map((close) => close().catch(() => undefined)));
    expect((await deploymentRow(deploymentId)).status).toBe('HEALTHCHECK');
    return deploymentId;
  };

  const sweep = async () => {
    const sweepModule = await import('../../../apps/control-plane/src/deploy/deploy-sweep.js');
    const storeModule = await import('../../../apps/control-plane/src/deploy/deployment-store.js');
    const result = await sweepModule.sweepCrashedDeployments({
      store: storeModule.createDeploymentStore({ db: db(), now: () => new Date(), events: { publish: () => Promise.resolve() } }),
      connect: deps().connect,
      createRedactor: deps().createRedactor,
      limits: deps().limits,
      logger: deps().logger,
    });
    await result.cleanup;
    return result;
  };

  it('worker kill in HEALTHCHECK: an unreachable server leaves the row; the next sweep restores -prev and ends FAILED/WORKER_CRASHED', async () => {
    if (runModule === undefined) throw new Error('runtime not started');
    const serviceId = await insertService(REPOS.healthy, httpCheck('/health'));
    try {
      const first = await healthyFirst(serviceId);
      const deploymentId = await crashInHealthcheck(serviceId);
      // The dead worker left the new version running and the previous one kept.
      expect(await containerField(`noodara-${serviceId}`, '{{.Config.Image}}')).toBe(`noodara/${serviceId}:${deploymentId}`);
      expect(await containerField(`noodara-${serviceId}-prev`, '{{.Config.Image}}')).toBe(`noodara/${serviceId}:${first.id}`);

      // H2: while the server cannot be reached the remote state is unknown: never terminal.
      await sshd('STOP');
      try {
        const unreachable = await sweep();
        expect(unreachable.swept).toEqual([]);
      } finally {
        await sshd('CONT');
      }
      expect((await deploymentRow(deploymentId)).status).toBe('HEALTHCHECK');
      expect(logged.some((line) => line.fields.deploymentId === deploymentId && /left for the next sweep/.test(line.message))).toBe(true);
      expect(await containerExists(`noodara-${serviceId}-prev`)).toBe(true);

      await sweep();
      const row = await deploymentRow(deploymentId);
      expect({ status: row.status, errorCode: row.errorCode, errorMessage: row.errorMessage }).toEqual({
        status: 'FAILED',
        errorCode: 'WORKER_CRASHED',
        errorMessage: runModule.DEPLOY_MESSAGES.WORKER_CRASHED_RESTORED,
      });
      expect(terminalStatuses(deploymentId)).toEqual([]);
      await expectOnlyRunning(serviceId, first.id);
      await expectWorkspaceGone(deploymentId);
      // H2: a second sweep finds nothing left to do.
      await sweep();
      expect((await deploymentRow(deploymentId)).status).toBe('FAILED');
      await expectOnlyRunning(serviceId, first.id);
    } finally {
      await removeServiceContainers(serviceId);
    }
  }, CASE_TIMEOUT_MS);

  it('worker kill in HEALTHCHECK on a first deploy: the only version is never removed', async () => {
    if (runModule === undefined) throw new Error('runtime not started');
    const serviceId = await insertService(REPOS.healthy, httpCheck('/health'));
    try {
      const deploymentId = await crashInHealthcheck(serviceId);
      const containerId = await containerField(`noodara-${serviceId}`, '{{.Id}}');

      await sweep();

      const row = await deploymentRow(deploymentId);
      expect({ status: row.status, errorCode: row.errorCode, errorMessage: row.errorMessage }).toEqual({
        status: 'FAILED',
        errorCode: 'WORKER_CRASHED',
        errorMessage: runModule.DEPLOY_MESSAGES.WORKER_CRASHED_NO_PREVIOUS,
      });
      // The per-service container is the only version: left exactly as it was.
      expect(await containerField(`noodara-${serviceId}`, '{{.Id}}')).toBe(containerId);
      await expectOnlyRunning(serviceId, deploymentId);
      await expectWorkspaceGone(deploymentId);
    } finally {
      await removeServiceContainers(serviceId);
    }
  }, CASE_TIMEOUT_MS);

  it('noodara-security: no credential reaches events, logs or deployment rows', async () => {
    const rows = await db().select().from(deployments);
    const surface = JSON.stringify({ events, logged, rows });
    expect(surface).not.toContain(s().deployKey.privateKey.split('\n')[1] ?? s().deployKey.privateKey);
    expect(surface).not.toContain(s().ssh.privateKey.split('\n')[1] ?? s().ssh.privateKey);
    expect(surface).not.toContain(masterKey.toString('base64'));
  });
});
