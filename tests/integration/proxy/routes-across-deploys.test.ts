// 22-05 routes across deploys on the real sshd + dockerd fixture (gate it-routes-deploys, Ubuntu 24.04).
// A routed service is deployed through the real job handler, deploy target and store; the proxy is
// installed by the real install job against Pebble and the routes applied by the real applier.
// Traffic is probed with curl on the host as root through Traefik (Host header).
//   A1: the first deploy of a service with a domain joins the proxy to noodara-net-<serviceId>.
//   A2: replace answers the new version (swap window sampled, ADR 0011 bound), automatic rollback
//       and manual rollback answer the restored version; the dynamic file is never rewritten.
//   H1: a cancel during HEALTHCHECK answers the restored -prev; a FAILED proxy does not fail the
//       deploy (one system line, the domain stays PENDING).
//   H2: a deploy whose internal port differs from the live file re-applies the routes.
// App modules are imported dynamically after a valid test env is written (env.ts fail-fasts).
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { proxyContainerName, proxyDynamicPathFor } from '@noodara/domain';
import type { HealthcheckConfig } from '@noodara/domain/deployment';
import { createRedactor, secretValue } from '@noodara/domain/security';
import { createSsh2Adapter, formatFingerprint, type SshTimeouts } from '@noodara/ssh';
import {
  credentials,
  deployments,
  domains,
  environments,
  projects,
  servers,
  services,
  users,
} from '../../../apps/control-plane/src/db/schema/index.js';
import type { DeploymentLogEntry } from '../../../apps/control-plane/src/deploy/log-sink.js';
import type { DomainApplier } from '../../../apps/control-plane/src/domains/domain-services.js';
import { DEPLOY_ENGINE_UBUNTU_VERSIONS, resolveBaseImages, startDeployEngineStack, type DeployEngineStack } from '../helpers/deploy-engine.js';
import { PEBBLE_ACME_DIRECTORY_URL, PEBBLE_HOSTNAME, TRAEFIK_IMAGE, startPebble, type StartedPebble } from '../helpers/pebble.js';
import { startPostgres, type PostgresFixture } from '../helpers/postgres.js';
import { assertNoStrayTestContainers } from '../helpers/ssh.js';

type DeployRuntimeModule = typeof import('../../../apps/control-plane/src/deploy/deploy-runtime.js');
type DeployWorkerModule = typeof import('../../../apps/control-plane/src/deploy/deploy-worker.js');
type DeploymentServicesModule = typeof import('../../../apps/control-plane/src/services/deployment-services.js');
type DeploymentServices = ReturnType<DeploymentServicesModule['createDeploymentServices']>;
type JobHandler = ReturnType<DeployWorkerModule['createDeployJobHandler']>;
type RouteLogs = typeof import('../../../apps/control-plane/src/deploy/run-deployment.js')['ROUTE_LOGS'];

const STACK_TIMEOUT_MS = 900_000;
const INSTALL_CASE_TIMEOUT_MS = 720_000;
const CASE_TIMEOUT_MS = 600_000;
const TIMEOUTS: SshTimeouts = { connectMs: 20_000, commandMs: 60_000, discoveryMs: 120_000 };
const MAX_LINE_BYTES = 16_384;
const CERT_VALIDITY_SECONDS = 3600;
const KEY_VERSION = 1;
const DEPLOY_MAX_MS = 300_000;
const ACTOR = { type: 'system' } as const;
const ROUTE_WAIT_MS = 20_000;
/** ADR 0011: the stop-then-start window of a replace; Traefik answers 502 inside it. */
const SWAP_WINDOW_BOUND_MS = 10_000;
const SWAP_ERROR_CODES = new Set(['502', '503', '000']);
const SAMPLER_MAX_S = 420;
const REPOS = { v1: 'routes-v1', v2: 'routes-v2', broken: 'routes-broken', v3: 'routes-v3' } as const;
const PORT = 3000;
const CHANGED_PORT = 4000;

const httpCheck = (port: number, startPeriodS = 10): HealthcheckConfig => ({
  type: 'http',
  path: '/health',
  port,
  expectedStatuses: [200],
  probeTimeoutS: 2,
  intervalS: 1,
  retries: 3,
  startPeriodS,
});

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function nodeBaseOf(baseImages: readonly string[]): string {
  const base = baseImages.find((ref) => ref.startsWith('node:'));
  if (base === undefined) throw new Error('harness preloaded no node base image');
  return base;
}

/** A one-file app answering `version <v>` on `/` (no newline: one sample per line) and /health. */
function writeVersionRepo(root: string, name: string, nodeBase: string, version: string, port: number, healthStatus: number): string {
  const dir = path.join(root, name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    path.join(dir, 'Dockerfile'),
    [`FROM ${nodeBase}`, 'WORKDIR /app', 'COPY server.js ./', 'USER node', 'CMD ["node","server.js"]', ''].join('\n'),
  );
  writeFileSync(
    path.join(dir, 'server.js'),
    [
      "const http = require('http');",
      'const server = http.createServer((req, res) => {',
      `  if (req.url === '/health') { res.writeHead(${String(healthStatus)}); res.end('health'); return; }`,
      `  res.writeHead(200, { 'content-type': 'text/plain' }); res.end('version ${version}');`,
      '});',
      `server.listen(${String(port)}, '0.0.0.0');`,
      "process.on('SIGTERM', () => server.close(() => process.exit(0)));",
      '',
    ].join('\n'),
  );
  return dir;
}

interface Sample {
  readonly at: number;
  readonly code: string;
  readonly body: string;
}

/** `<ms> <body...> <code>` per line, as the host-side sampler prints it. */
function parseSamples(raw: string): Sample[] {
  const out: Sample[] = [];
  for (const line of raw.split('\n')) {
    const parts = line.trim().split(' ');
    if (parts.length < 2) continue;
    const at = Number(parts[0]);
    const code = parts[parts.length - 1] ?? '';
    if (!Number.isFinite(at) || !/^\d{3}$/.test(code)) continue;
    out.push({ at, code, body: parts.slice(1, -1).join(' ') });
  }
  return out;
}

const SAMPLER_SCRIPT = [
  'end=$(( $(date +%s) + $3 ))',
  'while [ ! -e "$2" ] && [ "$(date +%s)" -lt "$end" ]; do',
  '  r=$(curl -s --max-time 2 -H "Host: $1" -w " %{http_code}" http://127.0.0.1/ 2>/dev/null)',
  '  printf "%s %s\\n" "$(date +%s%3N)" "$r"',
  '  sleep 0.05',
  'done',
].join('\n');

describe.each(DEPLOY_ENGINE_UBUNTU_VERSIONS)('22-05 routes across deploys on Ubuntu %s', (ubuntu) => {
  let stack: DeployEngineStack | undefined;
  let postgres: PostgresFixture | undefined;
  let pebble: StartedPebble | undefined;
  let tempRoot: string | undefined;
  let handler: JobHandler | undefined;
  let api: DeploymentServices | undefined;
  let apply: DomainApplier | undefined;
  let reapplyPending: (() => Promise<{ applied: number; failed: number }>) | undefined;
  let routeLogs: RouteLogs | undefined;
  let installProxy: (() => Promise<string>) | undefined;
  let serverId = '';
  let projectId = '';
  let environmentId = '';
  let serviceId = '';

  const masterKey = randomBytes(32);
  const entries = new Map<string, DeploymentLogEntry[]>();
  const label = (): string => randomUUID().slice(0, 8);
  const hosts = { main: `m${label()}.routes.noodara.test`, other: `o${label()}.routes.noodara.test` };
  const firstOf: { v1?: string } = {};

  const s = (): DeployEngineStack => {
    if (stack === undefined) throw new Error('stack not started');
    return stack;
  };
  const db = (): PostgresFixture['db'] => {
    if (postgres === undefined) throw new Error('postgres not started');
    return postgres.db;
  };
  const logs = (): RouteLogs => {
    if (routeLogs === undefined) throw new Error('modules not loaded');
    return routeLogs;
  };
  const root = (argv: readonly string[], timeoutMs?: number) =>
    s().exec(argv, { user: 'root', ...(timeoutMs === undefined ? {} : { timeoutMs }) });
  const rootOut = async (argv: readonly string[]): Promise<string> => {
    const result = await root(argv);
    if (result.exitCode !== 0) throw new Error(`root exec failed (${String(result.exitCode)}): ${argv.join(' ')}`);
    return result.stdout;
  };
  const dynamicPath = (id: string): string => {
    const built = proxyDynamicPathFor(id);
    if (!built.ok) throw new Error('invalid service id');
    return built.value;
  };
  const fileSha = async (): Promise<string> => (await rootOut(['sha256sum', '--', dynamicPath(serviceId)])).trim().split(' ')[0] ?? '';
  const networkMembers = async (id: string): Promise<string[]> =>
    (await rootOut(['docker', 'network', 'inspect', '--format', '{{range .Containers}}{{.Name}} {{end}}', `noodara-net-${id}`]))
      .trim()
      .split(/\s+/)
      .filter((name) => name !== '');
  const hit = async (host: string): Promise<{ code: string; body: string }> => {
    const result = await root(['curl', '-s', '--max-time', '3', '-H', `Host: ${host}`, '-w', ' %{http_code}', 'http://127.0.0.1/']);
    const at = result.stdout.lastIndexOf(' ');
    return { code: result.stdout.slice(at + 1).trim(), body: result.stdout.slice(0, Math.max(at, 0)) };
  };
  const waitVersion = async (host: string, version: string, timeoutMs = ROUTE_WAIT_MS): Promise<{ code: string; body: string }> => {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const current = await hit(host);
      if ((current.code === '200' && current.body === `version ${version}`) || Date.now() >= deadline) return current;
      await delay(250);
    }
  };
  const deploymentRow = async (deploymentId: string) => {
    const [row] = await db().select().from(deployments).where(eq(deployments.id, deploymentId));
    if (!row) throw new Error(`deployment ${deploymentId} missing`);
    return row;
  };
  const deployLog = (deploymentId: string): string[] =>
    (entries.get(deploymentId) ?? []).filter((entry) => entry.stream === 'system').map((entry) => entry.text.trimEnd());
  const runJob = async (deploymentId: string, id: string, signal?: AbortSignal) => {
    if (handler === undefined) throw new Error('runtime not started');
    await handler({ deploymentId, serviceId: id, actor: ACTOR, requestedAt: new Date().toISOString() }, signal);
    return deploymentRow(deploymentId);
  };
  const createDeployRow = async (id: string): Promise<string> => {
    if (api === undefined) throw new Error('runtime not started');
    const result = await api.triggerDeploy({ actor: ACTOR, serviceId: id });
    if (!result.ok) throw new Error(`triggerDeploy failed: ${result.code}`);
    return result.deployment.id;
  };
  const deploy = async (id: string) => runJob(await createDeployRow(id), id);
  const updateService = async (id: string, set: Partial<typeof services.$inferInsert>) => {
    await db().update(services).set(set).where(eq(services.id, id));
  };
  const setProxyStatus = async (status: 'INSTALLING' | 'RUNNING' | 'FAILED') => {
    await db().update(servers).set({ proxyStatus: status }).where(eq(servers.id, serverId));
  };
  const insertDomain = async (id: string, hostname: string) => {
    const [row] = await db()
      .insert(domains)
      .values({ projectId, serviceId: id, hostname, httpsRedirect: false, applyStatus: 'PENDING' })
      .returning({ id: domains.id });
    if (!row) throw new Error('domain insert returned no row');
    return row.id;
  };
  const domainStatus = async (domainId: string) => {
    const [row] = await db().select({ applyStatus: domains.applyStatus }).from(domains).where(eq(domains.id, domainId));
    return row?.applyStatus;
  };
  const insertService = async (repo: string): Promise<string> => {
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
        name: `routes-${label()}`,
        sourceType: 'git',
        repositoryUrl: s().gitRepoUrl(repo),
        branch: 'main',
        buildContext: '.',
        dockerfilePath: 'Dockerfile',
        buildTarget: null,
        internalPort: PORT,
        publishedPort: null,
        repositoryCredentialId: credentialId,
        healthcheck: httpCheck(PORT),
        autoRollback: true,
      })
      .returning({ id: services.id });
    if (!row) throw new Error('service insert returned no row');
    return row.id;
  };

  beforeAll(async () => {
    tempRoot = mkdtempSync(path.join(tmpdir(), 'noodara-routes-deploys-'));
    const nodeBase = nodeBaseOf(resolveBaseImages());
    const seeds = [
      { name: REPOS.v1, version: 'v1', port: PORT, health: 200 },
      { name: REPOS.v2, version: 'v2', port: PORT, health: 200 },
      { name: REPOS.broken, version: 'broken', port: PORT, health: 500 },
      { name: REPOS.v3, version: 'v3', port: CHANGED_PORT, health: 200 },
    ].map((seed) => ({
      name: seed.name,
      sourceDir: writeVersionRepo(tempRoot as string, seed.name, nodeBase, seed.version, seed.port, seed.health),
    }));
    const starts = await Promise.allSettled([startDeployEngineStack({ ubuntu, seedRepositories: seeds }), startPostgres()]);
    const [stackResult, pgResult] = starts;
    if (stackResult.status === 'fulfilled') stack = stackResult.value;
    if (pgResult.status === 'fulfilled') postgres = pgResult.value;
    const failed = starts.find((result) => result.status === 'rejected');
    if (failed !== undefined) throw failed.reason;
    process.env.NOODARA_MASTER_KEY = masterKey.toString('base64');
    process.env.BETTER_AUTH_SECRET = `routes-deploys-${randomUUID()}-${randomUUID()}`;
    process.env.DATABASE_URL = postgres?.connectionString ?? '';
    // Parsed only: the queue is a fake and the cache prune is off, nothing opens a Redis connection.
    process.env.REDIS_URL = 'redis://127.0.0.1:6379';
    process.env.NOODARA_PUBLIC_URL = 'http://localhost:3000';

    const runtime: DeployRuntimeModule = await import('../../../apps/control-plane/src/deploy/deploy-runtime.js');
    const workerModule: DeployWorkerModule = await import('../../../apps/control-plane/src/deploy/deploy-worker.js');
    const deploymentServices: DeploymentServicesModule = await import('../../../apps/control-plane/src/services/deployment-services.js');
    const runDeploymentModule = await import('../../../apps/control-plane/src/deploy/run-deployment.js');
    const deployConnect = await import('../../../apps/control-plane/src/deploy/deploy-connect.js');
    const proxyJob = await import('../../../apps/control-plane/src/proxy/proxy-job.js');
    const proxyWiring = await import('../../../apps/control-plane/src/proxy/proxy-wiring.js');
    const credentialStore = await import('../../../apps/control-plane/src/services/credential-store.js');
    const domainServices = await import('../../../apps/control-plane/src/domains/domain-services.js');
    const domainApply = await import('../../../apps/control-plane/src/domains/domain-apply.js');
    routeLogs = runDeploymentModule.ROUTE_LOGS;

    pebble = await startPebble({ networkName: s().networkName, validitySeconds: CERT_VALIDITY_SECONDS });
    const caRootFile = path.join(tempRoot, 'ca-root.pem');
    writeFileSync(caRootFile, pebble.listenerRootPem, { mode: 0o600 });

    const probe = await createSsh2Adapter().connect({
      target: { host: s().ssh.host, port: s().ssh.port, user: s().ssh.user },
      credential: { kind: 'private_key', privateKey: secretValue(s().ssh.privateKey, 'ssh_private_key') },
      timeouts: TIMEOUTS,
      trustedFingerprint: null,
      redactor: createRedactor(),
    });
    if (!probe.ok) throw new Error(`fingerprint probe failed: ${probe.errorCode}`);
    const fingerprint = formatFingerprint(probe.fingerprint);
    await probe.session.close();
    const encoded = credentialStore.encodeCredential(
      { kind: 'private_key', privateKey: s().ssh.privateKey },
      { key: masterKey, version: KEY_VERSION },
      createRedactor(),
    );
    if (!encoded.ok) throw new Error(`server credential rejected: ${encoded.code}`);
    const [credentialRow] = await db()
      .insert(credentials)
      .values({ type: encoded.type, encryptedValue: encoded.encryptedValue, keyVersion: encoded.keyVersion })
      .returning({ id: credentials.id });
    if (!credentialRow) throw new Error('credential insert returned no row');
    const [serverInserted] = await db()
      .insert(servers)
      .values({
        name: `routes-host-${ubuntu}`,
        host: s().ssh.host,
        sshPort: s().ssh.port,
        sshUser: s().ssh.user,
        credentialId: credentialRow.id,
        status: 'CONNECTED',
        hostFingerprint: fingerprint,
        dockerInstalled: true,
      })
      .returning({ id: servers.id });
    if (!serverInserted) throw new Error('server insert returned no row');
    serverId = serverInserted.id;
    await db().insert(users).values({ name: 'Admin', email: 'admin@noodara.dev' });

    const now = new Date();
    const [project] = await db()
      .insert(projects)
      .values({ name: 'routes-deploys', slug: `routes-${label()}`, createdAt: now, updatedAt: now })
      .returning({ id: projects.id });
    if (!project) throw new Error('project insert returned no row');
    projectId = project.id;
    const [environment] = await db()
      .insert(environments)
      .values({ projectId, name: 'production', createdAt: now, updatedAt: now })
      .returning({ id: environments.id });
    if (!environment) throw new Error('environment insert returned no row');
    environmentId = environment.id;

    const events = { publish: () => Promise.resolve() };
    const logger = { info: () => undefined, warn: () => undefined, error: () => undefined };
    const ssh = createSsh2Adapter();
    const masterKeys = () => Promise.resolve({ current: masterKey });
    const install = proxyJob.createProxyInstallJobHandler(
      proxyWiring.createProxyInstallJobDeps({
        db: db(),
        events,
        ssh,
        timeouts: TIMEOUTS,
        masterKeys,
        image: TRAEFIK_IMAGE,
        acmeCaUrl: PEBBLE_ACME_DIRECTORY_URL,
        acmeCaRootFile: caRootFile,
        maxLineBytes: MAX_LINE_BYTES,
        logger,
        extraHosts: [{ name: PEBBLE_HOSTNAME, ip: pebble.ip }],
      }),
    );
    installProxy = () => install({ serverId, acmeEmail: 'admin@noodara.dev', jobId: `proxy-install-${serverId}` });

    const connect = deployConnect.createDeployConnect({
      loadServer: deployConnect.loadDeployServerFromDb(db()),
      ssh,
      timeouts: TIMEOUTS,
      masterKeys,
    });
    // Default lock: the per-service route lock over the database, the same one the deploy takes (H3).
    apply = domainServices.createDomainApplier({ db: db(), connect, createRedactor, limits: domainApply.domainApplyLimits(TIMEOUTS.commandMs) });
    const applier = apply;
    reapplyPending = () => domainServices.reapplyPendingDomains({ db: db(), apply: applier, logger: { warn: () => undefined } });

    const deps = runtime.createDeployJobDeps({
      db: db(),
      events,
      ssh,
      timeouts: TIMEOUTS,
      masterKeys,
      panelPorts: [],
      config: { deployMaxMs: DEPLOY_MAX_MS, idleMs: 120_000, logMaxBytes: 1_048_576, logLineMaxBytes: MAX_LINE_BYTES },
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
    api = deploymentServices.createDeploymentServices({
      db: db(),
      now: () => new Date(),
      events,
      queue: { enqueue: () => Promise.resolve({ ok: true, jobId: 'unused' } as const) },
      logger,
    });
  }, STACK_TIMEOUT_MS);

  afterAll(async () => {
    await pebble?.stop();
    await postgres?.stop();
    await stack?.stop();
    if (tempRoot !== undefined) rmSync(tempRoot, { recursive: true, force: true });
    await assertNoStrayTestContainers();
  }, STACK_TIMEOUT_MS);

  it(
    'A1: the first deploy of a routed service joins the proxy to its network; the re-apply routes v1',
    async () => {
      if (installProxy === undefined || reapplyPending === undefined) throw new Error('runtime not started');
      await setProxyStatus('INSTALLING');
      expect(await installProxy()).not.toBe('failed');
      const [server] = await db().select({ proxyStatus: servers.proxyStatus }).from(servers).where(eq(servers.id, serverId));
      expect(server?.proxyStatus).toBe('RUNNING');

      serviceId = await insertService(REPOS.v1);
      const domainId = await insertDomain(serviceId, hosts.main);
      const first = await deploy(serviceId);
      expect({ status: first.status, errorCode: first.errorCode }).toEqual({ status: 'SUCCESS', errorCode: null });
      firstOf.v1 = first.id;
      expect(await networkMembers(serviceId)).toContain(proxyContainerName());
      // No live file yet: nothing to compare, no re-apply, no proxy line.
      const routeLines: readonly string[] = Object.values(logs());
      expect(deployLog(first.id).filter((text) => routeLines.includes(text))).toEqual([]);

      expect(await reapplyPending()).toEqual({ applied: 1, failed: 0 });
      expect(await domainStatus(domainId)).toBe('APPLIED');
      expect(await waitVersion(hosts.main, 'v1')).toEqual({ code: '200', body: 'version v1' });
    },
    INSTALL_CASE_TIMEOUT_MS,
  );

  it(
    'A2: replace answers v2; the swap window is sampled within the ADR 0011 bound and the file is untouched',
    async () => {
      const before = await fileSha();
      await updateService(serviceId, { repositoryUrl: s().gitRepoUrl(REPOS.v2) });
      const stopFile = `/tmp/noodara-swap-stop-${label()}`;
      const sampler = root(['sh', '-c', SAMPLER_SCRIPT, 'sampler', hosts.main, stopFile, String(SAMPLER_MAX_S)], (SAMPLER_MAX_S + 30) * 1000);
      let samples: Sample[];
      try {
        const second = await deploy(serviceId);
        expect({ status: second.status, errorCode: second.errorCode }).toEqual({ status: 'SUCCESS', errorCode: null });
        expect(await waitVersion(hosts.main, 'v2')).toEqual({ code: '200', body: 'version v2' });
        await delay(500);
      } finally {
        await root(['touch', stopFile]);
        samples = parseSamples((await sampler).stdout);
        await root(['rm', '-f', stopFile]);
      }
      const isV1 = (sample: Sample) => sample.code === '200' && sample.body === 'version v1';
      const isV2 = (sample: Sample) => sample.code === '200' && sample.body === 'version v2';
      const errors = samples.filter((sample) => !isV1(sample) && !isV2(sample));
      const firstV2 = samples.find(isV2);
      const lastV1 = [...samples].reverse().find(isV1);
      if (firstV2 === undefined || lastV1 === undefined) throw new Error(`sampler saw no swap (${String(samples.length)} samples)`);
      const windowMs = firstV2.at - lastV1.at;
      console.log(
        `[22-05-SWAP] ${JSON.stringify({ ubuntu, samples: samples.length, errorCount: errors.length, windowMs, codes: [...new Set(errors.map((e) => e.code))] })}`,
      );
      expect(errors.every((sample) => SWAP_ERROR_CODES.has(sample.code))).toBe(true);
      expect(lastV1.at).toBeLessThan(firstV2.at);
      expect(windowMs).toBeLessThan(SWAP_WINDOW_BOUND_MS);
      // Once v2 answers, v1 never comes back.
      expect(samples.filter((sample) => sample.at > firstV2.at && isV1(sample))).toEqual([]);
      expect(await fileSha()).toBe(before);
    },
    CASE_TIMEOUT_MS,
  );

  it(
    'A2: an automatic rollback answers the restored v2 and leaves the file untouched',
    async () => {
      const before = await fileSha();
      await updateService(serviceId, { repositoryUrl: s().gitRepoUrl(REPOS.broken) });
      const rolled = await deploy(serviceId);
      expect({ status: rolled.status, errorCode: rolled.errorCode }).toEqual({ status: 'ROLLED_BACK', errorCode: 'HEALTHCHECK_FAILED' });
      expect(await waitVersion(hosts.main, 'v2')).toEqual({ code: '200', body: 'version v2' });
      expect(await fileSha()).toBe(before);
    },
    CASE_TIMEOUT_MS,
  );

  it(
    'A2: a manual rollback to the first deployment answers v1 and leaves the file untouched',
    async () => {
      if (api === undefined || firstOf.v1 === undefined) throw new Error('first deploy missing');
      const before = await fileSha();
      const result = await api.triggerRollback({ actor: ACTOR, serviceId, targetDeploymentId: firstOf.v1 });
      if (!result.ok) throw new Error(`triggerRollback failed: ${result.code}`);
      const row = await runJob(result.deployment.id, serviceId);
      expect({ status: row.status, errorCode: row.errorCode }).toEqual({ status: 'SUCCESS', errorCode: null });
      expect(await waitVersion(hosts.main, 'v1')).toEqual({ code: '200', body: 'version v1' });
      expect(await fileSha()).toBe(before);
    },
    CASE_TIMEOUT_MS,
  );

  it(
    'H1: a cancel during HEALTHCHECK restores -prev and Traefik answers v1 again',
    async () => {
      const before = await fileSha();
      await updateService(serviceId, { repositoryUrl: s().gitRepoUrl(REPOS.broken), healthcheck: httpCheck(PORT, 120) });
      const deploymentId = await createDeployRow(serviceId);
      const controller = new AbortController();
      const running = runJob(deploymentId, serviceId, controller.signal);
      try {
        const deadline = Date.now() + DEPLOY_MAX_MS;
        let reached = false;
        while (!reached && Date.now() < deadline) {
          reached = (await deploymentRow(deploymentId)).status === 'HEALTHCHECK';
          if (!reached) await delay(250);
        }
        expect(reached, 'the deploy never reached HEALTHCHECK').toBe(true);
        // The new version answers through the proxy until the cancel lands.
        expect(await waitVersion(hosts.main, 'broken')).toEqual({ code: '200', body: 'version broken' });
      } finally {
        controller.abort();
      }
      const row = await running;
      expect({ status: row.status, errorCode: row.errorCode }).toEqual({ status: 'CANCELLED', errorCode: null });
      expect(await waitVersion(hosts.main, 'v1')).toEqual({ code: '200', body: 'version v1' });
      expect(await fileSha()).toBe(before);
    },
    CASE_TIMEOUT_MS,
  );

  it(
    'H2: a deploy on a changed internal port re-applies the routes and Traefik answers v3 on it',
    async () => {
      await updateService(serviceId, {
        repositoryUrl: s().gitRepoUrl(REPOS.v3),
        internalPort: CHANGED_PORT,
        healthcheck: httpCheck(CHANGED_PORT),
      });
      const row = await deploy(serviceId);
      expect({ status: row.status, errorCode: row.errorCode }).toEqual({ status: 'SUCCESS', errorCode: null });
      expect(deployLog(row.id), JSON.stringify(deployLog(row.id))).toContain(logs().REAPPLIED);
      expect(await waitVersion(hosts.main, 'v3')).toEqual({ code: '200', body: 'version v3' });
      expect(await rootOut(['cat', '--', dynamicPath(serviceId)])).toContain(`noodara-${serviceId}:${String(CHANGED_PORT)}`);
    },
    CASE_TIMEOUT_MS,
  );

  it(
    'H1: a FAILED proxy does not fail the deploy of a routed service: one system line, the domain stays PENDING',
    async () => {
      const otherId = await insertService(REPOS.v1);
      const domainId = await insertDomain(otherId, hosts.other);
      await setProxyStatus('FAILED');
      try {
        const row = await deploy(otherId);
        expect({ status: row.status, errorCode: row.errorCode }).toEqual({ status: 'SUCCESS', errorCode: null });
        expect(
          deployLog(row.id).filter((text) => text === logs().PROXY_NOT_RUNNING),
          JSON.stringify(deployLog(row.id)),
        ).toHaveLength(1);
        expect(await domainStatus(domainId)).toBe('PENDING');
        expect(await networkMembers(otherId)).not.toContain(proxyContainerName());
      } finally {
        await setProxyStatus('RUNNING');
        await root(['docker', 'rm', '-f', `noodara-${otherId}`, `noodara-${otherId}-prev`]);
      }
    },
    CASE_TIMEOUT_MS,
  );
});
