// 25-02: 50 domain create/update/delete cycles on the real sshd + dockerd fixture, Traefik
// installed by the real install job (Pebble as the ACME CA), three services on one server. The
// domain services run with the production applier (createDomainApplier, Postgres advisory route
// lock); the deploy re-apply is the worker's path (applyRoutes over sessionRoutePorts with its own
// route lock). planCycle (helpers/domain-cycles.ts) mixes per cycle:
//   sequential  add, httpsRedirect toggle or delete, rotated across the services
//   concurrent  every 3rd cycle (H2): POST+DELETE, PATCH+PATCH (opposite values, one row) or
//               POST+deploy re-apply fired at once on one service
//   forced      every 10th cycle (A2): a create rendered with every router pointing at a missing
//               upstream; the live file must be restored (sha unchanged) and the row deleted again
// After every cycle (A1, H2): every row APPLIED and no 500; dynamic/ holds noodara-api.yml plus one
// valid `<id>.yml` per routed service with exactly its rows (a `.prev` only beside its live file,
// ADR 0011), no temp file; every `@file` router in the Traefik API is a domain row and every row
// has both routers enabled; the proxy is on exactly the routed services' networks; every host
// answers through the proxy (200, or 302 to https when redirected) and every removed host is 404.
// At the end the server equals the database (25-01 probe), then every domain is deleted and
// dynamic/ is back to noodara-api.yml alone. H1: sshd sessions on the fixture and this process's
// SSH sockets and handles return to the baseline taken after the warm-up.
// Apply latency per cycle goes to a JSON artifact rewritten after every cycle, in
// NOODARA_DOMAIN_CYCLES_ARTIFACT_DIR (default <os tmpdir>/noodara-domain-cycles-artifacts).
//
// Opt-in: without NOODARA_STRESS=1 the suite reports as skipped. Run it with:
//   NOODARA_STRESS=1 NOODARA_TEST_UBUNTU=24.04 pnpm exec vitest run --config vitest.integration.config.ts tests/integration/proxy/domain-cycles.test.ts
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { inArray } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PROXY_LAYOUT, proxyContainerName, proxyDynamicPathFor } from '@noodara/domain';
import { createRedactor, secretValue } from '@noodara/domain/security';
import { createSsh2Adapter, formatFingerprint, type SshTimeouts } from '@noodara/ssh';
import { credentials, domains, environments, projects, servers, services, users } from '../../../apps/control-plane/src/db/schema/index.js';
import type { DomainServiceDeps } from '../../../apps/control-plane/src/domains/domain-services.js';
import type { ProxyServiceDeps } from '../../../apps/control-plane/src/proxy/proxy-service.js';
import type { ProxyInstallJobPayload } from '../../../apps/control-plane/src/queue/proxy-job-payload.js';
import { DEPLOY_ENGINE_UBUNTU_VERSIONS, startDeployEngineStack, type DeployEngineStack } from '../helpers/deploy-engine.js';
import {
  checkApplyStatuses,
  checkDynamicEntries,
  checkProxyNetworks,
  checkRouteFile,
  checkTraefikRouters,
  countHandles,
  handleGrowth,
  planCycle,
  routedServiceIds,
  summarizeLatency,
  type CycleOp,
  type CyclePlan,
  type DbDomain,
  type HandleCounts,
  type HandleInfo,
  type LatencySummary,
  type ModelDomain,
} from '../helpers/domain-cycles.js';
import { PEBBLE_ACME_DIRECTORY_URL, PEBBLE_HOSTNAME, TRAEFIK_IMAGE, startPebble, type StartedPebble } from '../helpers/pebble.js';
import { startPostgres, type PostgresFixture } from '../helpers/postgres.js';
import { assertNoStrayTestContainers } from '../helpers/ssh.js';
import { expectRemoteMatchesDatabase } from './remote-state-probe.js';

function envFlag(name: string): boolean {
  const value = process.env[name];
  return value === '1' || value === 'true';
}

const STRESS_ENABLED = envFlag('NOODARA_STRESS');
const CYCLES = 50;
const ARTIFACT_DIR = process.env['NOODARA_DOMAIN_CYCLES_ARTIFACT_DIR'] ?? path.join(tmpdir(), 'noodara-domain-cycles-artifacts');

const STACK_TIMEOUT_MS = 900_000;
const INSTALL_CASE_TIMEOUT_MS = 720_000;
/** A healthy cycle takes 5-20 s (forced: + its verify window); this only bounds a wedged run. */
const CYCLES_CASE_TIMEOUT_MS = CYCLES * 90_000 + 300_000;
const TIMEOUTS: SshTimeouts = { connectMs: 20_000, commandMs: 60_000, discoveryMs: 120_000 };
const MAX_LINE_BYTES = 16_384;
const CERT_VALIDITY_SECONDS = 3600;
const KEY_VERSION = 1;
const ACTOR = { type: 'system' } as const;
const BACKEND_PORT = 3000;
const SERVICE_NAMES = ['api', 'web', 'worker'] as const;
/** Domains kept per service at most (MAX_DOMAINS_PER_SERVICE is 10). */
const DOMAINS_PER_SERVICE_CAP = 3;
/**
 * ADR 0011 (22-03 verify): a written file is routed within 10 s (Traefik's 2 s provider throttle
 * plus margin). One apply, from the service call to its result, stays under it.
 */
const ADR_0011_APPLY_BOUND_MS = 10_000;
/** Forced-invalid applier: a shorter verify window keeps the forced cycles quick. */
const FORCED_VERIFY_MS = 10_000;
/** A routed answer (or a 404 after a removal) after an applied result, Traefik's reload included. */
const ROUTE_WAIT_MS = 15_000;
/** The Traefik API drops the routers of a removed file on its next reload (not verified by the apply). */
const API_WAIT_MS = 15_000;
/** H1: sessions and sockets close asynchronously after the last apply. */
const SETTLE_WAIT_MS = 30_000;
/** pg.Pool default `max` (apps/control-plane/src/db/client.ts). */
const PG_POOL_MAX = 10;
const FIXED_DYNAMIC_ENTRIES = [path.posix.basename(PROXY_LAYOUT.apiRouterFile)];
const FIXED_FILE_ROUTERS = ['noodara-api@file'];
const TRAEFIK_ROUTERS_URL = 'http://127.0.0.1:9180/api/http/routers?per_page=1000';

const BACKEND_JS = `
const http = require('http');
process.on('SIGTERM', () => process.exit(0));
http.createServer((req, res) => {
  res.writeHead(200, { 'content-type': 'text/plain' });
  res.end('ok ' + req.headers.host + '\\n');
}).listen(${String(BACKEND_PORT)}, '0.0.0.0');
`;

type ModulesOf = {
  deployConnect: typeof import('../../../apps/control-plane/src/deploy/deploy-connect.js');
  proxyJob: typeof import('../../../apps/control-plane/src/proxy/proxy-job.js');
  proxyWiring: typeof import('../../../apps/control-plane/src/proxy/proxy-wiring.js');
  credentialStore: typeof import('../../../apps/control-plane/src/services/credential-store.js');
  domainServices: typeof import('../../../apps/control-plane/src/domains/domain-services.js');
  domainApply: typeof import('../../../apps/control-plane/src/domains/domain-apply.js');
  applyRoutes: typeof import('../../../apps/control-plane/src/domains/apply-routes.js');
  domainDns: typeof import('../../../apps/control-plane/src/domains/domain-dns.js');
  httpErrors: typeof import('../../../apps/control-plane/src/routes/http-errors.js');
};

interface Hit {
  readonly status: number;
  readonly headers: Record<string, string>;
  readonly body: string;
}

interface OpResult {
  readonly kind: CycleOp['kind'] | 'forced';
  readonly ok: boolean;
  readonly code: string | null;
  readonly httpStatus: number;
  readonly ms: number;
}

interface CycleRecord {
  readonly cycle: number;
  readonly mode: CyclePlan['mode'];
  readonly pair: string | null;
  /** Wall time of the cycle's measured applies (the pair together when concurrent). */
  readonly applyMs: number;
  readonly ops: readonly OpResult[];
  readonly checkMs: number;
}

interface DomainCyclesArtifact {
  ubuntu: string;
  boundMs: { readonly sequential: number; readonly concurrent: number; readonly forced: number };
  cycles: CycleRecord[];
  forced: { attempted: number; restored: number };
  concurrentCycles: number;
  summary: { sequential: LatencySummary; concurrent: LatencySummary; forced: LatencySummary } | null;
  baseline: { sshdSessions: number; handles: HandleCounts } | null;
  final: { sshdSessions: number; handles: HandleCounts } | null;
  problems: string[];
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function parseHit(raw: string): Hit {
  const normalised = raw.replace(/\r\n/g, '\n');
  const split = normalised.indexOf('\n\n');
  const head = split === -1 ? normalised : normalised.slice(0, split);
  const body = split === -1 ? '' : normalised.slice(split + 2);
  const [statusLine = '', ...lines] = head.split('\n');
  const status = Number(/^HTTP\/\S+\s+(\d{3})/.exec(statusLine)?.[1] ?? '0');
  const headers: Record<string, string> = {};
  for (const line of lines) {
    const at = line.indexOf(':');
    if (at > 0) headers[line.slice(0, at).trim().toLowerCase()] = line.slice(at + 1).trim();
  }
  return { status, headers, body };
}

/** This process's libuv handles, reduced to type and peer port (H1). */
function activeHandles(): HandleInfo[] {
  const getter = (process as unknown as { _getActiveHandles?: () => unknown[] })._getActiveHandles;
  if (getter === undefined) throw new Error('process._getActiveHandles is not available');
  return getter.call(process).map((handle) => {
    const named = handle as { constructor?: { name?: string }; remotePort?: unknown };
    return {
      type: named.constructor?.name ?? 'unknown',
      remotePort: typeof named.remotePort === 'number' ? named.remotePort : undefined,
    };
  });
}

describe.skipIf(!STRESS_ENABLED)(`25-02 stress: ${String(CYCLES)} domain create/update/delete cycles`, () => {
  describe.each(DEPLOY_ENGINE_UBUNTU_VERSIONS)('Ubuntu %s', (ubuntu) => {
    let stack: DeployEngineStack | undefined;
    let postgres: PostgresFixture | undefined;
    let pebble: StartedPebble | undefined;
    let tempRoot: string | undefined;
    let mods: ModulesOf | undefined;
    let handler: ((data: unknown) => Promise<string>) | undefined;
    let proxyDeps: ProxyServiceDeps | undefined;
    let apiDeps: DomainServiceDeps | undefined;
    let forcedDeps: DomainServiceDeps | undefined;
    let reapplyFor: ((serviceId: string) => Promise<{ ok: boolean; code: string | null }>) | undefined;
    let serverId = '';
    let projectId = '';
    /** Service key (its name) -> service id. */
    const serviceIds = new Map<string, string>();

    const masterKey = randomBytes(32);
    const enqueued: ProxyInstallJobPayload[] = [];
    const runLabel = randomUUID().slice(0, 8);
    const hostFor = (cycle: number, n: number): string => `c${String(cycle)}n${String(n)}-${runLabel}.cycles.noodara.test`;
    const artifactPath = path.join(ARTIFACT_DIR, `domain-cycles-ubuntu-${ubuntu}.json`);
    const artifact: DomainCyclesArtifact = {
      ubuntu,
      boundMs: { sequential: ADR_0011_APPLY_BOUND_MS, concurrent: 2 * ADR_0011_APPLY_BOUND_MS, forced: FORCED_VERIFY_MS + ADR_0011_APPLY_BOUND_MS },
      cycles: [],
      forced: { attempted: 0, restored: 0 },
      concurrentCycles: 0,
      summary: null,
      baseline: null,
      final: null,
      problems: [],
    };
    const writeArtifact = (): void => {
      const of = (mode: CyclePlan['mode']) => summarizeLatency(artifact.cycles.filter((c) => c.mode === mode).map((c) => c.applyMs));
      artifact.summary = { sequential: of('sequential'), concurrent: of('concurrent'), forced: of('forced') };
      mkdirSync(ARTIFACT_DIR, { recursive: true });
      writeFileSync(artifactPath, `${JSON.stringify(artifact, null, 2)}\n`);
    };

    const s = (): DeployEngineStack => {
      if (stack === undefined) throw new Error('stack not started');
      return stack;
    };
    const db = (): PostgresFixture['db'] => {
      if (postgres === undefined) throw new Error('postgres not started');
      return postgres.db;
    };
    const m = (): ModulesOf => {
      if (mods === undefined) throw new Error('modules not loaded');
      return mods;
    };
    const deps = (): DomainServiceDeps => {
      if (apiDeps === undefined) throw new Error('domain deps not built');
      return apiDeps;
    };
    const idOf = (key: string): string => {
      const id = serviceIds.get(key);
      if (id === undefined) throw new Error(`service ${key} not created`);
      return id;
    };
    const keyOf = (id: string): string => [...serviceIds].find(([, value]) => value === id)?.[0] ?? id;
    const root = (argv: readonly string[]) => s().exec(argv, { user: 'root' });
    const rootOut = async (argv: readonly string[]): Promise<string> => {
      const result = await root(argv);
      if (result.exitCode !== 0) throw new Error(`root exec failed (${String(result.exitCode)}): ${argv.join(' ')}`);
      return result.stdout;
    };
    const dynamicPath = (serviceId: string): string => {
      const built = proxyDynamicPathFor(serviceId);
      if (!built.ok) throw new Error('invalid service id');
      return built.value;
    };
    const hit = async (host: string): Promise<Hit> => {
      const result = await root(['curl', '-s', '-i', '--max-time', '3', '-H', `Host: ${host}`, 'http://127.0.0.1/']);
      return parseHit(result.stdout);
    };
    const waitHit = async (host: string, done: (h: Hit) => boolean, timeoutMs = ROUTE_WAIT_MS): Promise<Hit> => {
      const startedAt = Date.now();
      for (;;) {
        const current = await hit(host);
        if (done(current) || Date.now() - startedAt >= timeoutMs) return current;
        await delay(250);
      }
    };
    const routed = (host: string) => (h: Hit) => h.status === 200 && h.body.includes(`ok ${host}`);
    const redirected = (host: string) => (h: Hit) => h.status === 302 && h.headers['location'] === `https://${host}/`;
    const notFound = (h: Hit) => h.status === 404;
    const fileSha = async (serviceId: string): Promise<string> =>
      (await rootOut(['sha256sum', '--', dynamicPath(serviceId)])).trim().split(' ')[0] ?? '';
    const domainRows = async (): Promise<DbDomain[]> =>
      db()
        .select({
          id: domains.id,
          serviceId: domains.serviceId,
          hostname: domains.hostname,
          httpsRedirect: domains.httpsRedirect,
          applyStatus: domains.applyStatus,
        })
        .from(domains)
        .where(inArray(domains.serviceId, [...serviceIds.values()]));
    const domainIdFor = async (hostname: string): Promise<string> => {
      const row = (await domainRows()).find((candidate) => candidate.hostname === hostname);
      if (row === undefined) throw new Error(`no domain row for ${hostname}`);
      return row.id;
    };
    const model = async (): Promise<Map<string, ModelDomain[]>> => {
      const byKey = new Map<string, ModelDomain[]>([...serviceIds.keys()].map((key) => [key, []]));
      const rows = (await domainRows()).sort((a, b) => (a.hostname < b.hostname ? -1 : 1));
      for (const row of rows) byKey.get(keyOf(row.serviceId))?.push({ hostname: row.hostname, httpsRedirect: row.httpsRedirect });
      return byKey;
    };
    const statusOf = (result: { ok: boolean; code?: string }): number =>
      result.ok || result.code === undefined ? 200 : m().httpErrors.mapServiceCodeToStatus(result.code as never);
    const scopeOf = (key: string) => ({ projectId, serviceId: idOf(key) });

    /** Resolves ids now, so the returned thunks of a concurrent pair fire at the same moment. */
    const prepareOp = async (op: CycleOp, target: DomainServiceDeps = deps()): Promise<() => Promise<OpResult>> => {
      const timed = async (kind: OpResult['kind'], run: () => Promise<{ ok: boolean; code?: string }>): Promise<OpResult> => {
        const startedAt = Date.now();
        const result = await run();
        return { kind, ok: result.ok, code: result.ok ? null : (result.code ?? null), httpStatus: statusOf(result), ms: Date.now() - startedAt };
      };
      if (op.kind === 'add') {
        return () =>
          timed('add', () =>
            m().domainServices.createDomain(target, { actor: ACTOR, scope: scopeOf(op.service), body: { hostname: op.hostname, httpsRedirect: false } }),
          );
      }
      if (op.kind === 'reapply') {
        const reapply = reapplyFor;
        if (reapply === undefined) throw new Error('deploy re-apply not built');
        return () => timed('reapply', async () => {
          const outcome = await reapply(idOf(op.service));
          return outcome.ok ? { ok: true } : { ok: false, code: outcome.code ?? 'SERVER_UNREACHABLE' };
        });
      }
      const domainId = await domainIdFor(op.hostname);
      if (op.kind === 'redirect') {
        return () =>
          timed('redirect', () =>
            m().domainServices.updateDomain(target, { actor: ACTOR, scope: scopeOf(op.service), domainId, body: { httpsRedirect: op.httpsRedirect } }),
          );
      }
      return () => timed('delete', () => m().domainServices.removeDomain(target, { actor: ACTOR, scope: scopeOf(op.service), domainId }));
    };
    const runSequential = async (ops: readonly CycleOp[]): Promise<OpResult[]> => {
      const results: OpResult[] = [];
      for (const op of ops) results.push(await (await prepareOp(op))());
      return results;
    };

    const proxyNetworks = async (): Promise<string[]> =>
      (await rootOut(['docker', 'inspect', '--format', '{{range $name, $_ := .NetworkSettings.Networks}}{{$name}} {{end}}', proxyContainerName()]))
        .trim()
        .split(/\s+/)
        .filter((name) => name !== '');
    const routerProblems = async (rows: readonly DbDomain[]): Promise<string[]> => {
      const startedAt = Date.now();
      for (;;) {
        const result = await root(['curl', '-s', '--max-time', '5', TRAEFIK_ROUTERS_URL]);
        const problems = result.exitCode === 0 ? checkTraefikRouters(result.stdout, rows, FIXED_FILE_ROUTERS) : [`Traefik API: curl exit ${String(result.exitCode)}`];
        if (problems.length === 0 || Date.now() - startedAt >= API_WAIT_MS) return problems;
        await delay(500);
      }
    };
    /** A1/H2: everything the server holds for the proxy equals the domain rows. */
    const invariantProblems = async (removedHosts: readonly string[]): Promise<string[]> => {
      const rows = await domainRows();
      const problems = [...checkApplyStatuses(rows)];
      const routedIds = routedServiceIds(rows);
      const listing = await rootOut(['ls', '-A1', PROXY_LAYOUT.dynamicDir]);
      const entries = listing.split('\n').map((line) => line.trim()).filter((line) => line !== '');
      problems.push(...checkDynamicEntries(entries, routedIds, FIXED_DYNAMIC_ENTRIES));
      for (const id of routedIds) {
        const content = await root(['cat', '--', dynamicPath(id)]);
        if (content.exitCode === 0) problems.push(...checkRouteFile(id, content.stdout, rows));
      }
      problems.push(...checkProxyNetworks(await proxyNetworks(), routedIds));
      problems.push(...(await routerProblems(rows)));
      for (const row of rows) {
        const expected = row.httpsRedirect ? redirected(row.hostname) : routed(row.hostname);
        const answer = await waitHit(row.hostname, expected);
        if (!expected(answer)) problems.push(`${row.hostname} answered ${String(answer.status)} (redirect ${String(row.httpsRedirect)})`);
      }
      for (const host of removedHosts.filter((candidate) => !rows.some((row) => row.hostname === candidate))) {
        const answer = await waitHit(host, notFound);
        if (answer.status !== 404) problems.push(`removed ${host} answered ${String(answer.status)}`);
      }
      return problems;
    };

    const sshdSessions = async (): Promise<number> =>
      (await rootOut(['sh', '-c', "ss -tnH state established '( sport = :22 )' | wc -l"])).trim() === ''
        ? 0
        : Number((await rootOut(['sh', '-c', "ss -tnH state established '( sport = :22 )' | wc -l"])).trim());
    const handleCounts = (): HandleCounts => {
      const pgPort = Number(new URL(postgres?.connectionString ?? 'postgres://x:1/').port);
      return countHandles(activeHandles(), { ssh: s().ssh.port, postgres: pgPort });
    };

    beforeAll(async () => {
      const starts = await Promise.allSettled([startDeployEngineStack({ ubuntu }), startPostgres()]);
      const [stackResult, pgResult] = starts;
      if (stackResult.status === 'fulfilled') stack = stackResult.value;
      if (pgResult.status === 'fulfilled') postgres = pgResult.value;
      const failed = starts.find((result) => result.status === 'rejected');
      if (failed !== undefined) throw failed.reason;
      process.env.NOODARA_MASTER_KEY = masterKey.toString('base64');
      process.env.BETTER_AUTH_SECRET = `domain-cycles-${randomUUID()}-${randomUUID()}`;
      process.env.DATABASE_URL = postgres?.connectionString ?? '';
      // Parsed only: the queue is a fake, nothing opens a Redis connection.
      process.env.REDIS_URL = 'redis://127.0.0.1:6379';
      process.env.NOODARA_PUBLIC_URL = 'http://localhost:3000';
      mods = {
        deployConnect: await import('../../../apps/control-plane/src/deploy/deploy-connect.js'),
        proxyJob: await import('../../../apps/control-plane/src/proxy/proxy-job.js'),
        proxyWiring: await import('../../../apps/control-plane/src/proxy/proxy-wiring.js'),
        credentialStore: await import('../../../apps/control-plane/src/services/credential-store.js'),
        domainServices: await import('../../../apps/control-plane/src/domains/domain-services.js'),
        domainApply: await import('../../../apps/control-plane/src/domains/domain-apply.js'),
        applyRoutes: await import('../../../apps/control-plane/src/domains/apply-routes.js'),
        domainDns: await import('../../../apps/control-plane/src/domains/domain-dns.js'),
        httpErrors: await import('../../../apps/control-plane/src/routes/http-errors.js'),
      };
      const { deployConnect, proxyJob, proxyWiring, credentialStore, domainServices, domainApply, applyRoutes, domainDns } = mods;

      pebble = await startPebble({ networkName: s().networkName, validitySeconds: CERT_VALIDITY_SECONDS });
      const node = s().baseImages.find((ref) => ref.startsWith('node:'));
      if (node === undefined) throw new Error('no node base image preloaded');
      tempRoot = mkdtempSync(path.join(tmpdir(), 'noodara-domain-cycles-'));
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
          name: `domain-cycles-${ubuntu}`,
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
        .values({ name: 'domain-cycles', slug: `cycles-${runLabel}`, createdAt: now, updatedAt: now })
        .returning({ id: projects.id });
      if (!project) throw new Error('project insert returned no row');
      projectId = project.id;
      const [environment] = await db()
        .insert(environments)
        .values({ projectId, name: 'production', createdAt: now, updatedAt: now })
        .returning({ id: environments.id });
      if (!environment) throw new Error('environment insert returned no row');
      for (const name of SERVICE_NAMES) {
        const [service] = await db()
          .insert(services)
          .values({ projectId, environmentId: environment.id, serverId, name, sourceType: 'image', imageRef: node, internalPort: BACKEND_PORT })
          .returning({ id: services.id });
        if (!service) throw new Error('service insert returned no row');
        serviceIds.set(name, service.id);
        // The service's container as the deploy leaves it: `noodara-<id>` on `noodara-net-<id>`.
        await rootOut(['docker', 'network', 'create', '--label', 'noodara.managed=true', '--', `noodara-net-${service.id}`]);
        await rootOut([
          'docker', 'run', '--detach', '--pull', 'never', '--name', `noodara-${service.id}`,
          '--network', `noodara-net-${service.id}`, '--label', 'noodara.managed=true',
          '--label', `noodara.service_id=${service.id}`, '--', node, 'node', '-e', BACKEND_JS,
        ]);
      }

      const events = { publish: () => Promise.resolve() };
      const logger = { info: () => undefined, warn: () => undefined, error: () => undefined };
      const ssh = createSsh2Adapter();
      const masterKeys = () => Promise.resolve({ current: masterKey });
      handler = proxyJob.createProxyInstallJobHandler(
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
      const connect = deployConnect.createDeployConnect({
        loadServer: deployConnect.loadDeployServerFromDb(db()),
        ssh,
        timeouts: TIMEOUTS,
        masterKeys,
      });
      proxyDeps = {
        db: db(),
        now: () => new Date(),
        events,
        enqueue: (payload) => {
          enqueued.push(payload);
          return Promise.resolve({ ok: true, jobId: payload.jobId, collapsed: false });
        },
        acmeCaUrl: PEBBLE_ACME_DIRECTORY_URL,
        remove: proxyWiring.createProxyRemover({
          loadServer: deployConnect.loadDeployServerFromDb(db()),
          ssh,
          timeouts: TIMEOUTS,
          masterKeys,
          limits: { stepMs: TIMEOUTS.commandMs, maxLineBytes: MAX_LINE_BYTES },
        }),
        removeTimeoutMs: proxyWiring.proxyRemoveTimeoutMs(TIMEOUTS),
      };
      const limits = domainApply.domainApplyLimits(TIMEOUTS.commandMs);
      // The production default lock (in-process queue + Postgres advisory lock), one per "process".
      const apply = domainServices.createDomainApplier({ db: db(), connect, createRedactor, limits });
      const forcedApply = domainServices.createDomainApplier({
        db: db(),
        connect,
        createRedactor,
        limits: { ...limits, verifyMs: FORCED_VERIFY_MS },
        render: (svc, list) => {
          const rendered = domainApply.renderServiceRoutes(svc, list);
          if (!rendered.ok) return rendered;
          const parsed = JSON.parse(rendered.value) as { http: { routers: Record<string, { service: string }> } };
          for (const router of Object.values(parsed.http.routers)) router.service = 'noodara-missing-upstream';
          return { ok: true, value: JSON.stringify(parsed) };
        },
      });
      // The deploy worker's re-apply (deploy-target `routes.reapply`): its own route lock, a
      // session the deploy owns (opened and closed here), the deployed port.
      const workerLock = applyRoutes.createRouteLock(db());
      const deployLimits = domainApply.domainApplyLimits(TIMEOUTS.commandMs);
      reapplyFor = async (serviceId) => {
        const opened = await connect(serverId, createRedactor(), undefined);
        if (!opened.ok) return { ok: false, code: 'SERVER_UNREACHABLE' };
        try {
          const outcome = await applyRoutes.applyRoutes(serviceId, applyRoutes.sessionRoutePorts(db(), opened.session), {
            lock: workerLock,
            limits: deployLimits,
            internalPort: BACKEND_PORT,
          });
          return outcome.ok ? { ok: true, code: null } : { ok: false, code: outcome.code };
        } finally {
          await opened.close();
        }
      };
      const resolver = {
        resolve4: () => Promise.reject(Object.assign(new Error('ENOTFOUND'), { code: 'ENOTFOUND' })),
        resolve6: () => Promise.reject(Object.assign(new Error('ENODATA'), { code: 'ENODATA' })),
      };
      const base = {
        db: db(),
        now: () => new Date(),
        publicUrlHost: 'localhost',
        getProxyService: () => Promise.resolve(proxyDeps as ProxyServiceDeps),
        resolver,
        dnsLimiter: domainDns.createDnsCheckLimiter(),
      };
      apiDeps = { ...base, apply };
      forcedDeps = { ...base, apply: forcedApply };
    }, STACK_TIMEOUT_MS);

    afterAll(async () => {
      if (artifact.cycles.length > 0 || artifact.problems.length > 0) writeArtifact();
      await pebble?.stop();
      await postgres?.stop();
      await stack?.stop();
      if (tempRoot !== undefined) rmSync(tempRoot, { recursive: true, force: true });
      await assertNoStrayTestContainers();
    }, STACK_TIMEOUT_MS);

    it(
      'warm-up: the first domain installs the proxy, routes, and is deleted again (baseline)',
      async () => {
        const warmHost = hostFor(0, 0);
        const created = await m().domainServices.createDomain(deps(), {
          actor: ACTOR,
          scope: scopeOf('api'),
          body: { hostname: warmHost, httpsRedirect: false },
        });
        expect(created).toMatchObject({ ok: true, domain: { applyStatus: 'PENDING' } });
        const payload = enqueued[0];
        if (handler === undefined || payload === undefined) throw new Error('proxy install not enqueued');
        expect(await handler(payload)).not.toBe('failed');
        const reapplied = await m().domainServices.reapplyPendingDomains({ db: db(), apply: deps().apply, logger: { warn: () => undefined } });
        expect(reapplied).toEqual({ applied: 1, failed: 0 });
        expect((await waitHit(warmHost, routed(warmHost))).status).toBe(200);
        expect(await m().domainServices.removeDomain(deps(), { actor: ACTOR, scope: scopeOf('api'), domainId: await domainIdFor(warmHost) })).toEqual({ ok: true });
        expect(await invariantProblems([warmHost])).toEqual([]);

        await delay(2000);
        artifact.baseline = { sshdSessions: await sshdSessions(), handles: handleCounts() };
        expect(artifact.baseline.handles.ssh).toBe(0);
      },
      INSTALL_CASE_TIMEOUT_MS,
    );

    it(
      `A1/A2/H2: ${String(CYCLES)} cycles keep dynamic/, the Traefik API and the proxy networks equal to the database`,
      async () => {
        if (artifact.baseline === null) throw new Error('warm-up did not record a baseline');
        if (forcedDeps === undefined) throw new Error('forced deps not built');
        const forced = forcedDeps;
        for (let cycle = 1; cycle <= CYCLES; cycle += 1) {
          const plan = planCycle(cycle, await model(), { services: [...serviceIds.keys()], hostFor, cap: DOMAINS_PER_SERVICE_CAP });
          const removed: string[] = [];
          const ops: OpResult[] = [];
          const problems: string[] = [];
          let applyMs = 0;

          if (plan.mode !== 'sequential') ops.push(...(await runSequential(plan.prepare)));
          if (plan.mode === 'sequential') {
            const startedAt = Date.now();
            ops.push(...(await runSequential(plan.ops)));
            applyMs = Date.now() - startedAt;
            for (const op of plan.ops) if (op.kind === 'delete') removed.push(op.hostname);
          } else if (plan.mode === 'concurrent') {
            artifact.concurrentCycles += 1;
            const thunks = await Promise.all(plan.ops.map((op) => prepareOp(op)));
            const startedAt = Date.now();
            ops.push(...(await Promise.all(thunks.map((run) => run()))));
            applyMs = Date.now() - startedAt;
            for (const op of plan.ops) if (op.kind === 'delete') removed.push(op.hostname);
          } else {
            artifact.forced.attempted += 1;
            const serviceId = idOf(plan.service);
            const before = await fileSha(serviceId);
            const startedAt = Date.now();
            const failure = await (await prepareOp({ kind: 'add', service: plan.service, hostname: plan.hostname }, forced))();
            applyMs = Date.now() - startedAt;
            ops.push({ ...failure, kind: 'forced' });
            if (failure.code !== 'PROXY_ROUTE_FAILED' || failure.httpStatus !== 502) {
              problems.push(`forced write answered ${failure.code ?? 'ok'} (${String(failure.httpStatus)}), expected PROXY_ROUTE_FAILED (502)`);
            }
            if ((await fileSha(serviceId)) === before) artifact.forced.restored += 1;
            else problems.push('forced write: the live file was not restored');
            // Deleting the failed row re-renders the survivors through the normal path.
            ops.push(...(await runSequential([{ kind: 'delete', service: plan.service, hostname: plan.hostname }])));
            removed.push(plan.hostname);
          }

          const expectedFailures = plan.mode === 'forced' ? 1 : 0;
          for (const op of ops) if (op.httpStatus === 500) problems.push(`${op.kind} answered 500`);
          const failures = ops.filter((op) => !op.ok);
          if (failures.length !== expectedFailures) {
            problems.push(`failed operations: ${failures.map((op) => `${op.kind} ${op.code ?? ''}`).join(', ') || 'none'}`);
          }
          const bound =
            plan.mode === 'sequential' ? artifact.boundMs.sequential : plan.mode === 'concurrent' ? artifact.boundMs.concurrent : artifact.boundMs.forced;
          if (applyMs > bound) problems.push(`apply took ${String(applyMs)} ms, bound ${String(bound)} ms`);

          const checkStartedAt = Date.now();
          problems.push(...(await invariantProblems(removed)));
          artifact.cycles.push({
            cycle,
            mode: plan.mode,
            pair: plan.mode === 'concurrent' ? plan.pair : null,
            applyMs,
            ops,
            checkMs: Date.now() - checkStartedAt,
          });
          artifact.problems.push(...problems.map((problem) => `cycle ${String(cycle)}: ${problem}`));
          writeArtifact();
          expect(problems, `cycle ${String(cycle)} (${plan.mode})`).toEqual([]);
        }
        expect(artifact.concurrentCycles).toBeGreaterThanOrEqual(10);
        expect(artifact.forced).toEqual({ attempted: CYCLES / 10, restored: CYCLES / 10 });
        // At the end the database equals the server (25-01 probe: proxy, files, networks, containers).
        await expectRemoteMatchesDatabase({ exec: root, db: db(), serverId });
      },
      CYCLES_CASE_TIMEOUT_MS,
    );

    it(
      'A1/H1: deleting every domain leaves dynamic/ without route, .prev or temp files; SSH sessions and handles back at baseline',
      async () => {
        const baseline = artifact.baseline;
        if (baseline === null) throw new Error('warm-up did not record a baseline');
        const rows = await domainRows();
        for (const row of rows) {
          const result = await m().domainServices.removeDomain(deps(), { actor: ACTOR, scope: scopeOf(keyOf(row.serviceId)), domainId: row.id });
          expect(result, row.hostname).toEqual({ ok: true });
        }
        expect(await invariantProblems(rows.map((row) => row.hostname))).toEqual([]);
        expect((await rootOut(['ls', '-A1', PROXY_LAYOUT.dynamicDir])).trim().split('\n')).toEqual(FIXED_DYNAMIC_ENTRIES);
        await expectRemoteMatchesDatabase({ exec: root, db: db(), serverId });

        const deadline = Date.now() + SETTLE_WAIT_MS;
        let sessions = await sshdSessions();
        let handles = handleCounts();
        while ((sessions !== baseline.sshdSessions || handleGrowth(baseline.handles, handles, PG_POOL_MAX).length > 0) && Date.now() < deadline) {
          await delay(1000);
          sessions = await sshdSessions();
          handles = handleCounts();
        }
        artifact.final = { sshdSessions: sessions, handles };
        writeArtifact();
        expect(sessions, 'sshd sessions on the fixture').toBe(baseline.sshdSessions);
        expect(handles.ssh, 'open SSH connections in the control plane').toBe(baseline.handles.ssh);
        expect(handleGrowth(baseline.handles, handles, PG_POOL_MAX)).toEqual([]);
      },
      INSTALL_CASE_TIMEOUT_MS,
    );
  });
});
