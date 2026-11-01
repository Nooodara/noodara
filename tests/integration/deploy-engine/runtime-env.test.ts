// 23-04 / A1-A5, H1, H2: runtime env injection on real infrastructure (sshd + dockerd), through the
// real deployment services, job handler, deploy target and store, with fixtures/env-api.
// - A plain variable and a secret reference reach the container (sha256 via /env-digest); the
//   snapshot is v2 (plain values and {secretRef, secretVersion}, never a value); the configure step
//   carries the counts; the deployment log never contains the secret value (H1 canary).
// - H2: <workspace>/secrets/env is gone while the new container is running and the attempt has not
//   ended (the workspace still exists), and nothing is left once it ends.
// - A change applies only on the next deploy.
// - A2/H3: the env file write fails on the host -> FAILED/ENV_INJECTION_FAILED, -prev restored.
// - A1: the referenced secret is deleted -> FAILED/SECRET_UNRESOLVED in PREPARING, nothing built,
//   the running container untouched.
import { createHash, randomBytes, randomUUID } from 'node:crypto';
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
  environmentVariables,
  environments,
  projects,
  secrets,
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
type CredentialStoreModule = typeof import('../../../apps/control-plane/src/services/credential-store.js');
type SecretStoreModule = typeof import('../../../apps/control-plane/src/secrets/secret-store.js');
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
const REPO = 'env-api';
const JOB_ACTOR = { type: 'system' } as const;
const USER = { type: 'user', id: randomUUID() } as const;
const PLAIN_KEY = 'GREETING';
const SECRET_KEY = 'API_TOKEN';
const SECRET_NAME = 'api_token';

const HEALTHCHECK: HealthcheckConfig = {
  type: 'http',
  path: '/health',
  port: 3000,
  expectedStatuses: [200],
  probeTimeoutS: 2,
  intervalS: 1,
  retries: 3,
  startPeriodS: 10,
};

const sha256 = (value: string): string => createHash('sha256').update(value, 'utf8').digest('hex');

/** Prints `<status> <body>` of GET /env-digest?name=<argv[1]> from inside the container. */
const DIGEST_SCRIPT =
  "fetch('http://127.0.0.1:3000/env-digest?name='+process.argv[1]).then(async(r)=>{process.stdout.write(r.status+' '+(await r.text()))}).catch(()=>process.exit(3))";

describe.each(DEPLOY_ENGINE_UBUNTU_VERSIONS)('23-04: runtime env injection on real infrastructure, Ubuntu %s', (ubuntu) => {
  let stack: DeployEngineStack | undefined;
  let stackStart: Promise<DeployEngineStack> | undefined;
  let pgStart: Promise<PostgresFixture> | undefined;
  let redisStart: Promise<RedisFixture> | undefined;
  let postgres: PostgresFixture | undefined;
  let redis: RedisFixture | undefined;
  let handler: JobHandler | undefined;
  let api: DeploymentServices | undefined;
  let secretStore: SecretStoreModule | undefined;
  let stepsView: StepsViewModule | undefined;
  let projectId = '';
  let environmentId = '';
  let serverId = '';

  // Shared by the cases, in order: one service, its variables and its secret.
  let serviceId = '';
  let plainVariableId = '';
  let secretId = '';
  const secretRaw = `tok-${randomBytes(24).toString('hex')}`;

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
  const imageOf = (deploymentId: string) => `noodara/${serviceId}:${deploymentId}`;
  const running = () => `noodara-${serviceId}`;
  const logOf = (deploymentId: string): DeploymentLogEntry[] => entries.get(deploymentId) ?? [];
  const phaseLog = (deploymentId: string, phase: string): string =>
    logOf(deploymentId)
      .filter((entry) => entry.phase === phase)
      .map((entry) => entry.text)
      .join('\n');
  /** The deploy user's workspace of one attempt (DEPLOY_WORKSPACE_BASE under its home). */
  const workspaceOf = (deploymentId: string) => `$h/.noodara/deploy/${deploymentId}`;
  const asDeployer = (script: string) => s().exec(['sh', '-c', `h=~deployer; ${script}`], { user: 'deployer' });

  const digestOf = async (key: string): Promise<string> =>
    rootOut(['docker', 'exec', running(), 'node', '-e', DIGEST_SCRIPT, key]);

  const deploymentRow = async (deploymentId: string) => {
    const [row] = await db().select().from(deployments).where(eq(deployments.id, deploymentId));
    if (!row) throw new Error(`deployment ${deploymentId} missing`);
    return row;
  };

  const insertService = async (): Promise<string> => {
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
        name: `env-${randomUUID().slice(0, 8)}`,
        sourceType: 'git',
        repositoryUrl: s().gitRepoUrl(REPO),
        branch: 'main',
        buildContext: '.',
        dockerfilePath: 'Dockerfile',
        buildTarget: null,
        internalPort: 3000,
        publishedPort: null,
        repositoryCredentialId: credentialId,
        healthcheck: HEALTHCHECK,
        // 17-02 H2: a failed attempt restores -prev itself and ends FAILED (no ROLLING_BACK step).
        autoRollback: false,
      })
      .returning({ id: services.id });
    if (!row) throw new Error('service insert returned no row');
    return row.id;
  };

  const queueDeploy = async (): Promise<string> => {
    const result = await services$().triggerDeploy({ actor: USER, serviceId });
    if (!result.ok) throw new Error(`triggerDeploy failed: ${result.code}`);
    return result.deployment.id;
  };

  const runJob = async (deploymentId: string) => {
    if (handler === undefined) throw new Error('runtime not started');
    await handler({ deploymentId, serviceId, actor: JOB_ACTOR, requestedAt: new Date().toISOString() });
    return deploymentRow(deploymentId);
  };

  const expectSuccess = (row: { status: string; errorCode: string | null }) => {
    expect({ status: row.status, errorCode: row.errorCode }).toEqual({ status: 'SUCCESS', errorCode: null });
  };

  /** Everything recorded about an attempt that could carry a value: log, row and activity. */
  const recordedText = async (deploymentId: string): Promise<string> => {
    const activity = await db().select().from(activityEvents).where(eq(activityEvents.entityId, deploymentId));
    return JSON.stringify([logOf(deploymentId), await deploymentRow(deploymentId), activity]);
  };

  const configureStepOf = async (deploymentId: string) => {
    if (stepsView === undefined) throw new Error('steps view not loaded');
    const view = await services$().getDeployment(deploymentId);
    if (view === null) throw new Error(`deployment view ${deploymentId} missing`);
    const stamps = (await stepsView.readDeploymentStepStamps(db(), [deploymentId])).get(deploymentId);
    const withSteps = stepsView.withDeploymentSteps(view, stamps);
    return { names: withSteps.steps.map((step) => step.name), configure: withSteps.steps.find((step) => step.name === 'configure') };
  };

  beforeAll(async () => {
    stackStart = startDeployEngineStack({
      ubuntu,
      seedRepositories: [{ name: REPO, sourceDir: path.join(FIXTURES_DIR, 'env-api') }],
    });
    pgStart = startPostgres();
    redisStart = startRedis();
    const [stackStarted, pgStarted, redisStarted] = await Promise.all([stackStart, pgStart, redisStart]);
    stack = stackStarted;
    postgres = pgStarted;
    redis = redisStarted;

    process.env.NOODARA_MASTER_KEY = masterKey.toString('base64');
    process.env.BETTER_AUTH_SECRET = `runtime-env-${randomUUID()}-${randomUUID()}`;
    process.env.DATABASE_URL = postgres.connectionString;
    process.env.REDIS_URL = redis.connectionUrl;
    process.env.NOODARA_PUBLIC_URL = 'http://localhost:3000';

    const runtime: DeployRuntimeModule = await import('../../../apps/control-plane/src/deploy/deploy-runtime.js');
    const workerModule: DeployWorkerModule = await import('../../../apps/control-plane/src/deploy/deploy-worker.js');
    const deploymentServices: DeploymentServicesModule = await import(
      '../../../apps/control-plane/src/services/deployment-services.js'
    );
    const credentialStore: CredentialStoreModule = await import('../../../apps/control-plane/src/services/credential-store.js');
    secretStore = await import('../../../apps/control-plane/src/secrets/secret-store.js');
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
        name: `runtime-env-host-${ubuntu}`,
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
      .values({ name: 'Runtime env', slug: `env-${randomUUID().slice(0, 8)}`, createdAt: now, updatedAt: now })
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

    // Three scopes: the plain variable at environment scope, the secret at project scope and the
    // reference to it at service scope.
    serviceId = await insertService();
    const [plainRow] = await db()
      .insert(environmentVariables)
      .values({ scope: 'environment', projectId, environmentId, key: PLAIN_KEY, value: 'hello' })
      .returning({ id: environmentVariables.id });
    if (!plainRow) throw new Error('variable insert returned no row');
    plainVariableId = plainRow.id;
    await db()
      .insert(environmentVariables)
      .values({ scope: 'service', projectId, serviceId, key: SECRET_KEY, value: `<secret:${SECRET_NAME}>` });
    const secret = await secretStore.createSecret(
      db(),
      { owner: { scope: 'project', projectId }, name: SECRET_NAME, value: secretValue(secretRaw, 'app_secret') },
      { current: masterKey },
    );
    secretId = secret.id;
  }, STACK_TIMEOUT_MS);

  afterAll(async () => {
    const [stk, pg, rd] = await Promise.all([
      stack ?? settleWithin(stackStart, PENDING_START_WAIT_MS),
      postgres ?? settleWithin(pgStart, PENDING_START_WAIT_MS),
      redis ?? settleWithin(redisStart, PENDING_START_WAIT_MS),
    ]);
    await runTeardown(
      `runtime env (Ubuntu ${ubuntu})`,
      [
        {
          name: 'service.containers',
          run: async () => {
            if (stk !== undefined && serviceId !== '') {
              await stk.exec(['docker', 'rm', '-f', `noodara-${serviceId}`, `noodara-${serviceId}-prev`], { user: 'root' });
            }
          },
          timeoutMs: TEARDOWN_STEP_TIMEOUT_MS,
        },
        { name: 'redis.stop', run: () => rd?.stop(), timeoutMs: FIXTURE_STOP_TIMEOUT_MS },
        { name: 'postgres.stop', run: () => pg?.stop(), timeoutMs: FIXTURE_STOP_TIMEOUT_MS },
        { name: 'stack.stop', run: () => stk?.stop(), timeoutMs: STACK_STOP_TIMEOUT_MS },
      ],
      { stepTimeoutMs: TEARDOWN_STEP_TIMEOUT_MS },
    );
  }, STACK_TIMEOUT_MS);

  it('injects a plain variable and a secret reference, removes the env file before the healthcheck, and applies a change only on the next deploy', async () => {
    const firstId = await queueDeploy();

    // H2: observe the host while the attempt runs. The container is read first: once it runs,
    // docker create has returned and the env file must already be gone.
    let done = false;
    const observations: { workspace: boolean; envFile: boolean }[] = [];
    const poller = (async () => {
      while (!done) {
        const state = await root(['docker', 'container', 'inspect', '--format', '{{.State.Status}} {{.Config.Image}}', running()]);
        if (state.exitCode === 0 && state.stdout.trim() === `running ${imageOf(firstId)}`) {
          const ws = workspaceOf(firstId);
          const probe = await asDeployer(`if [ -d "${ws}/secrets" ]; then w=1; else w=0; fi; if [ -e "${ws}/secrets/env" ]; then e=1; else e=0; fi; echo "$w$e"`);
          const flags = probe.stdout.trim();
          observations.push({ workspace: flags.startsWith('1'), envFile: flags.endsWith('1') });
        }
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
    })();
    const first = await runJob(firstId).finally(async () => {
      done = true;
      await poller;
    });
    expectSuccess(first);

    // H2: seen while the attempt still held its workspace (not ended), with no env file.
    const midAttempt = observations.filter((o) => o.workspace);
    expect(midAttempt.length).toBeGreaterThan(0);
    expect(midAttempt.every((o) => !o.envFile)).toBe(true);
    // Nothing of the attempt is left on the host once it ended.
    expect((await asDeployer(`[ -e "${workspaceOf(firstId)}" ]`)).exitCode).not.toBe(0);

    // A5: both values reach the container.
    expect(await digestOf(PLAIN_KEY)).toBe(`200 ${sha256('hello')}`);
    expect(await digestOf(SECRET_KEY)).toBe(`200 ${sha256(secretRaw)}`);

    // A3: snapshot v2, plain values and a pinned reference, never the value.
    expect(first.runtimeConfig).toMatchObject({
      version: 2,
      env: expect.arrayContaining([
        { key: PLAIN_KEY, value: 'hello' },
        { key: SECRET_KEY, secretRef: SECRET_NAME, secretVersion: 1 },
      ]) as unknown,
    });

    // A4: configure between prepare and build, with the counts; keys and reference names only.
    const steps = await configureStepOf(firstId);
    expect(steps.names.indexOf('configure')).toBe(1);
    expect(steps.names.indexOf('build')).toBeGreaterThan(1);
    expect(steps.configure).toMatchObject({ state: 'success', counts: { variables: 1, secrets: 1 } });
    const prepare = phaseLog(firstId, 'prepare');
    expect(prepare).toContain(PLAIN_KEY);
    expect(prepare).toContain(`${SECRET_KEY} = <secret:${SECRET_NAME}>`);
    expect(prepare).not.toContain('hello');

    // H1: the log canary, and nothing else recorded about the attempt, carries the value.
    expect(await recordedText(firstId)).not.toContain(secretRaw);

    // A5: a change applies only on the next deploy.
    await db().update(environmentVariables).set({ value: 'bye', updatedAt: new Date() }).where(eq(environmentVariables.id, plainVariableId));
    expect(await digestOf(PLAIN_KEY)).toBe(`200 ${sha256('hello')}`);
    const second = await runJob(await queueDeploy());
    expectSuccess(second);
    expect(await containerField(running(), '{{.Config.Image}}')).toBe(imageOf(second.id));
    expect(await digestOf(PLAIN_KEY)).toBe(`200 ${sha256('bye')}`);
    expect(await digestOf(SECRET_KEY)).toBe(`200 ${sha256(secretRaw)}`);
    expect(await recordedText(second.id)).not.toContain(secretRaw);
  }, CASE_TIMEOUT_MS);

  it('ends FAILED/ENV_INJECTION_FAILED when the env file cannot be written, with -prev restored', async () => {
    const before = await containerField(running(), '{{.Id}} {{.Config.Image}}');
    const deploymentId = await queueDeploy();
    // Fault: a directory where the writer's temp file goes, so `rm -f` and the write fail on the host.
    const fault = await root([
      'sh',
      '-c',
      'h=~deployer; ws="$h/.noodara/deploy/$0"; install -d -o deployer -m 700 "$h/.noodara" "$h/.noodara/deploy" "$ws" "$ws/secrets" && mkdir "$ws/secrets/env.tmp"',
      deploymentId,
    ]);
    expect(fault.exitCode).toBe(0);

    const row = await runJob(deploymentId);

    expect({ status: row.status, errorCode: row.errorCode }).toEqual({ status: 'FAILED', errorCode: 'ENV_INJECTION_FAILED' });
    expect(await containerField(running(), '{{.Id}} {{.Config.Image}}')).toBe(before);
    expect(await containerField(running(), '{{.State.Status}}')).toBe('running');
    expect(await containerExists(`${running()}-prev`)).toBe(false);
    expect(await digestOf(SECRET_KEY)).toBe(`200 ${sha256(secretRaw)}`);
    expect((await asDeployer(`[ -e "${workspaceOf(deploymentId)}" ]`)).exitCode).not.toBe(0);
    expect(await recordedText(deploymentId)).not.toContain(secretRaw);
  }, CASE_TIMEOUT_MS);

  it('ends FAILED/SECRET_UNRESOLVED in PREPARING when the referenced secret is gone, the running container untouched', async () => {
    const before = await containerField(running(), '{{.Id}} {{.State.StartedAt}} {{.Config.Image}}');
    await db().delete(secrets).where(eq(secrets.id, secretId));

    const row = await runJob(await queueDeploy());

    expect({ status: row.status, errorCode: row.errorCode }).toEqual({ status: 'FAILED', errorCode: 'SECRET_UNRESOLVED' });
    expect(phaseLog(row.id, 'build')).toBe('');
    expect(phaseLog(row.id, 'deploy')).toBe('');
    if (stepsView === undefined) throw new Error('steps view not loaded');
    const stamps = (await stepsView.readDeploymentStepStamps(db(), [row.id])).get(row.id);
    expect(stamps?.buildingStartedAt ?? null).toBeNull();
    expect(stamps?.deployingStartedAt ?? null).toBeNull();
    expect((await configureStepOf(row.id)).configure).toMatchObject({ state: 'failed' });
    expect(await containerField(running(), '{{.Id}} {{.State.StartedAt}} {{.Config.Image}}')).toBe(before);
    expect(await containerField(running(), '{{.State.Status}}')).toBe('running');
    expect(await containerExists(`${running()}-prev`)).toBe(false);
    expect(await recordedText(row.id)).not.toContain(secretRaw);
  }, CASE_TIMEOUT_MS);
});
