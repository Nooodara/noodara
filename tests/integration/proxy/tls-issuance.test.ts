// 22-04 certificate reconciler on the real sshd + dockerd fixture with Pebble (gate it-tls, 24.04).
// The domain services and the cert reconciler run against a migrated Postgres with the real applier
// and the SSH adapter; the proxy is installed by the real install job handler against Pebble.
//   A1/A2/A3/A4: add domain -> PENDING; the reconciler cycle re-applies the PENDING route, then
//       moves it to ISSUED with notAfter inside Pebble's validity; service.updated is published and
//       domain.certificate_issued recorded; an HTTPS GET verified with the Pebble root succeeds.
//   A4: httpsRedirect on -> HTTP 302 to https, off -> 200.
//   A1/A4: DNS pointed elsewhere -> FAILED/CERT_DNS_MISMATCH after a test-shortened issue timeout.
//   H4: a deleted dynamic file is re-applied within one cycle and domain.route_restored recorded.
//   A1/H2: a stopped proxy -> CERT_PROXY_UNAVAILABLE, server FAILED/PROXY_UNAVAILABLE, one
//       server.proxy_failed across cycles.
// App modules are imported dynamically after a valid test env is written (env.ts fail-fasts).
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { proxyContainerName, proxyDynamicPathFor, proxyRouterNamesFor } from '@noodara/domain';
import { createRedactor, secretValue } from '@noodara/domain/security';
import {
  PROXY_STATUS_MAX_BYTES,
  createSsh2Adapter,
  formatFingerprint,
  parseProxyRouterStatus,
  proxyRouterStatus,
  type SshTimeouts,
} from '@noodara/ssh';
import {
  activityEvents,
  credentials,
  domains,
  environments,
  projects,
  servers,
  services,
  users,
} from '../../../apps/control-plane/src/db/schema/index.js';
import type { CertReconciler } from '../../../apps/control-plane/src/domains/cert-reconciler.js';
import type { DomainApplier, DomainServiceDeps } from '../../../apps/control-plane/src/domains/domain-services.js';
import type { ServerEvent } from '../../../apps/control-plane/src/events/server-event-publisher.js';
import type { ProxyServiceDeps } from '../../../apps/control-plane/src/proxy/proxy-service.js';
import type { ProxyInstallJobPayload } from '../../../apps/control-plane/src/queue/proxy-job-payload.js';
import { DEPLOY_ENGINE_UBUNTU_VERSIONS, startDeployEngineStack, type DeployEngineStack } from '../helpers/deploy-engine.js';
import { PEBBLE_ACME_DIRECTORY_URL, PEBBLE_HOSTNAME, TRAEFIK_IMAGE, startPebble, type StartedPebble } from '../helpers/pebble.js';
import { startPostgres, type PostgresFixture } from '../helpers/postgres.js';
import { assertNoStrayTestContainers } from '../helpers/ssh.js';

const STACK_TIMEOUT_MS = 900_000;
const INSTALL_CASE_TIMEOUT_MS = 720_000;
const CASE_TIMEOUT_MS = 240_000;
const TIMEOUTS: SshTimeouts = { connectMs: 20_000, commandMs: 60_000, discoveryMs: 120_000 };
const MAX_LINE_BYTES = 16_384;
const CERT_VALIDITY_SECONDS = 3600;
const KEY_VERSION = 1;
const ACTOR = { type: 'system' } as const;
const BACKEND_PORT = 3000;
/** Every check 1 s after the last one: the test drives the cycles itself. */
const TEST_CHECK_DELAY_MS = 1000;
/** Issuance through Pebble, Traefik's ACME client included. */
const ISSUE_WAIT_MS = 180_000;
/** The test-shortened NOODARA_CERT_ISSUE_TIMEOUT_MS of the DNS mismatch case. */
const SHORT_ISSUE_TIMEOUT_MS = 20_000;
const ROUTE_WAIT_MS = 30_000;
const MISMATCH_IP = '203.0.113.10';

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
  domainDns: typeof import('../../../apps/control-plane/src/domains/domain-dns.js');
  certReconciler: typeof import('../../../apps/control-plane/src/domains/cert-reconciler.js');
};

type Connect = ReturnType<ModulesOf['deployConnect']['createDeployConnect']>;

interface Hit {
  readonly status: number;
  readonly headers: Record<string, string>;
  readonly body: string;
}

interface Logged {
  readonly level: 'info' | 'warn' | 'error';
  readonly fields: Record<string, unknown>;
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

describe.each(DEPLOY_ENGINE_UBUNTU_VERSIONS)('22-04 certificate reconciler on Ubuntu %s', (ubuntu) => {
  let stack: DeployEngineStack | undefined;
  let postgres: PostgresFixture | undefined;
  let pebble: StartedPebble | undefined;
  let tempRoot: string | undefined;
  let mods: ModulesOf | undefined;
  let handler: ((data: unknown) => Promise<string>) | undefined;
  let domainDeps: DomainServiceDeps | undefined;
  let connect: Connect | undefined;
  let reconciler: CertReconciler | undefined;
  let shortReconciler: CertReconciler | undefined;
  let hostIp = '';
  let serverId = '';
  let projectId = '';
  let serviceId = '';

  const masterKey = randomBytes(32);
  const enqueued: ProxyInstallJobPayload[] = [];
  const published: ServerEvent[] = [];
  const logged: Logged[] = [];
  const label = (): string => randomUUID().slice(0, 8);
  const hosts = {
    a: `a${label()}.tls.noodara.test`,
    b: `b${label()}.tls.noodara.test`,
  };
  const ids: Partial<Record<keyof typeof hosts, string>> = {};

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
    if (domainDeps === undefined) throw new Error('domain deps not built');
    return domainDeps;
  };
  const rec = (): CertReconciler => {
    if (reconciler === undefined) throw new Error('reconciler not built');
    return reconciler;
  };
  const peb = (): StartedPebble => {
    if (pebble === undefined) throw new Error('pebble not started');
    return pebble;
  };
  const scope = () => ({ projectId, serviceId });
  const root = (argv: readonly string[]) => s().exec(argv, { user: 'root' });
  const rootOut = async (argv: readonly string[]): Promise<string> => {
    const result = await root(argv);
    if (result.exitCode !== 0) throw new Error(`root exec failed (${String(result.exitCode)}): ${argv.join(' ')}`);
    return result.stdout;
  };
  const dynamicPath = (): string => {
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
  /** HTTPS through the proxy on the host, verified against the Pebble issuance root only. */
  const httpsHit = async (host: string): Promise<Hit> => {
    const script = [
      'set -e',
      'curl -sk --max-time 5 "https://$1:15000/roots/0" -o /tmp/noodara-pebble-root.pem',
      'curl -s -i --max-time 5 --cacert /tmp/noodara-pebble-root.pem --resolve "$2:443:127.0.0.1" "https://$2/"',
    ].join('\n');
    return parseHit(await rootOut(['sh', '-c', script, 'sh', peb().ip, host]));
  };
  const domainRow = async (key: keyof typeof hosts) => {
    const id = ids[key];
    if (id === undefined) throw new Error(`domain ${key} not created`);
    const [row] = await db().select().from(domains).where(eq(domains.id, id)).limit(1);
    if (!row) throw new Error(`domain ${key} row missing`);
    return row;
  };
  const serverRow = async () => {
    const [row] = await db().select().from(servers).where(eq(servers.id, serverId)).limit(1);
    if (!row) throw new Error('server row missing');
    return row;
  };
  const activities = (action: string, entityId: string) =>
    db()
      .select()
      .from(activityEvents)
      .where(and(eq(activityEvents.action, action), eq(activityEvents.entityId, entityId)));
  const create = async (key: keyof typeof hosts) => {
    const result = await m().domainServices.createDomain(deps(), {
      actor: ACTOR,
      scope: scope(),
      body: { hostname: hosts[key], httpsRedirect: false },
    });
    const [row] = await db().select().from(domains).where(eq(domains.hostname, hosts[key])).limit(1);
    if (row) ids[key] = row.id;
    return result;
  };
  /** Runs cycles (one per TEST_CHECK_DELAY_MS) until `done`; returns the cycles run. */
  const cycleUntil = async (target: CertReconciler, done: () => Promise<boolean>, timeoutMs: number): Promise<number> => {
    const deadline = Date.now() + timeoutMs;
    for (let cycles = 1; ; cycles += 1) {
      await target.runDue();
      if (await done()) return cycles;
      if (Date.now() > deadline) throw new Error(`condition not met after ${String(cycles)} cycles`);
      await delay(TEST_CHECK_DELAY_MS);
    }
  };
  const routerKind = async (router: string): Promise<string> => {
    if (connect === undefined) throw new Error('connect not built');
    const connected = await connect(serverId, createRedactor(), undefined);
    if (!connected.ok) throw new Error(`connect failed: ${connected.code}`);
    try {
      const result = await connected.session.stream(proxyRouterStatus(router), {
        maxDurationMs: TIMEOUTS.commandMs,
        idleTimeoutMs: TIMEOUTS.commandMs,
        maxTotalBytes: PROXY_STATUS_MAX_BYTES,
        maxLineBytes: 4096,
        onChunk: () => undefined,
      });
      return parseProxyRouterStatus(result.stdoutTail).kind;
    } finally {
      await connected.close();
    }
  };
  const waitRouter = async (router: string, kind: string, timeoutMs = ROUTE_WAIT_MS): Promise<string> => {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const current = await routerKind(router);
      if (current === kind || Date.now() > deadline) return current;
      await delay(500);
    }
  };

  beforeAll(async () => {
    const starts = await Promise.allSettled([startDeployEngineStack({ ubuntu }), startPostgres()]);
    const [stackResult, pgResult] = starts;
    if (stackResult.status === 'fulfilled') stack = stackResult.value;
    if (pgResult.status === 'fulfilled') postgres = pgResult.value;
    const failed = starts.find((result) => result.status === 'rejected');
    if (failed !== undefined) throw failed.reason;
    process.env.NOODARA_MASTER_KEY = masterKey.toString('base64');
    process.env.BETTER_AUTH_SECRET = `tls-issuance-${randomUUID()}-${randomUUID()}`;
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
      domainDns: await import('../../../apps/control-plane/src/domains/domain-dns.js'),
      certReconciler: await import('../../../apps/control-plane/src/domains/cert-reconciler.js'),
    };
    const { deployConnect, proxyJob, proxyWiring, credentialStore, domainServices, domainApply, domainDns, certReconciler } = mods;

    pebble = await startPebble({ networkName: s().networkName, validitySeconds: CERT_VALIDITY_SECONDS });
    const node = s().baseImages.find((ref) => ref.startsWith('node:'));
    if (node === undefined) throw new Error('no node base image preloaded');
    tempRoot = mkdtempSync(path.join(tmpdir(), 'noodara-tls-issuance-'));
    const caRootFile = path.join(tempRoot, 'ca-root.pem');
    writeFileSync(caRootFile, pebble.listenerRootPem, { mode: 0o600 });
    hostIp = (await rootOut(['sh', '-c', String.raw`ip -4 -o addr show dev eth0 | sed -n 's/.* inet \([0-9.]*\)\/.*/\1/p'`])).trim();
    if (!/^\d+\.\d+\.\d+\.\d+$/.test(hostIp)) throw new Error(`no host IP: ${hostIp}`);

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
    // An IP literal, so the DNS check compares against it (a single-label `localhost` is UNAVAILABLE).
    const serverHost = s().ssh.host === 'localhost' ? '127.0.0.1' : s().ssh.host;
    const [serverInserted] = await db()
      .insert(servers)
      .values({
        name: `tls-host-${ubuntu}`,
        host: serverHost,
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
      .values({ name: 'tls-issuance', slug: `tls-${label()}`, createdAt: now, updatedAt: now })
      .returning({ id: projects.id });
    if (!project) throw new Error('project insert returned no row');
    projectId = project.id;
    const [environment] = await db()
      .insert(environments)
      .values({ projectId, name: 'production', createdAt: now, updatedAt: now })
      .returning({ id: environments.id });
    if (!environment) throw new Error('environment insert returned no row');
    const [service] = await db()
      .insert(services)
      .values({
        projectId,
        environmentId: environment.id,
        serverId,
        name: 'api',
        sourceType: 'image',
        imageRef: node,
        internalPort: BACKEND_PORT,
      })
      .returning({ id: services.id });
    if (!service) throw new Error('service insert returned no row');
    serviceId = service.id;

    // The service's container as the deploy leaves it: `noodara-<id>` on `noodara-net-<id>`.
    await rootOut(['docker', 'network', 'create', '--label', 'noodara.managed=true', '--', `noodara-net-${serviceId}`]);
    await rootOut([
      'docker', 'run', '--detach', '--pull', 'never', '--name', `noodara-${serviceId}`,
      '--network', `noodara-net-${serviceId}`, '--label', 'noodara.managed=true',
      '--label', `noodara.service_id=${serviceId}`, '--', node, 'node', '-e', BACKEND_JS,
    ]);

    const noEvents = { publish: () => Promise.resolve() };
    const silent = { info: () => undefined, warn: () => undefined, error: () => undefined };
    const ssh = createSsh2Adapter();
    const masterKeys = () => Promise.resolve({ current: masterKey });
    handler = proxyJob.createProxyInstallJobHandler(
      proxyWiring.createProxyInstallJobDeps({
        db: db(),
        events: noEvents,
        ssh,
        timeouts: TIMEOUTS,
        masterKeys,
        image: TRAEFIK_IMAGE,
        acmeCaUrl: PEBBLE_ACME_DIRECTORY_URL,
        acmeCaRootFile: caRootFile,
        maxLineBytes: MAX_LINE_BYTES,
        logger: silent,
        extraHosts: [{ name: PEBBLE_HOSTNAME, ip: pebble.ip }],
      }),
    );
    connect = deployConnect.createDeployConnect({
      loadServer: deployConnect.loadDeployServerFromDb(db()),
      ssh,
      timeouts: TIMEOUTS,
      masterKeys,
    });
    const proxyDeps: ProxyServiceDeps = {
      db: db(),
      now: () => new Date(),
      events: noEvents,
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
    const lock = domainApply.createServiceLock();
    const limits = domainApply.domainApplyLimits(TIMEOUTS.commandMs);
    const apply: DomainApplier = domainServices.createDomainApplier({ db: db(), connect, createRedactor, limits, lock });
    // hosts.b points elsewhere (the server row's host is an IP literal).
    const resolver = {
      resolve4: (name: string) => {
        if (name === hosts.b) return Promise.resolve([MISMATCH_IP]);
        return Promise.reject(Object.assign(new Error('ENOTFOUND'), { code: 'ENOTFOUND' }));
      },
      resolve6: () => Promise.reject(Object.assign(new Error('ENODATA'), { code: 'ENODATA' })),
    };
    domainDeps = {
      db: db(),
      now: () => new Date(),
      publicUrlHost: 'localhost',
      getProxyService: () => Promise.resolve(proxyDeps),
      resolver,
      dnsLimiter: domainDns.createDnsCheckLimiter(),
      apply,
    };
    const logger = {
      info: (fields: Record<string, unknown>) => logged.push({ level: 'info', fields }),
      warn: (fields: Record<string, unknown>) => logged.push({ level: 'warn', fields }),
      error: (fields: Record<string, unknown>) => logged.push({ level: 'error', fields }),
    };
    const base = {
      store: certReconciler.createCertStore(db()),
      connect,
      createRedactor,
      apply,
      events: {
        publish: (event: ServerEvent) => {
          published.push(event);
          return Promise.resolve();
        },
      },
      logger,
      intervalMs: 600_000,
      commandMs: TIMEOUTS.commandMs,
      checkDelayMs: () => TEST_CHECK_DELAY_MS,
    };
    reconciler = certReconciler.createCertReconciler({ ...base, issueTimeoutMs: 600_000 });
    shortReconciler = certReconciler.createCertReconciler({ ...base, issueTimeoutMs: SHORT_ISSUE_TIMEOUT_MS });
  }, STACK_TIMEOUT_MS);

  afterAll(async () => {
    if (stack !== undefined) await root(['docker', 'start', proxyContainerName()]).catch(() => undefined);
    await pebble?.stop();
    await postgres?.stop();
    await stack?.stop();
    if (tempRoot !== undefined) rmSync(tempRoot, { recursive: true, force: true });
    await assertNoStrayTestContainers();
  }, STACK_TIMEOUT_MS);

  it(
    'A1/A2/A3/A4: add domain -> PENDING; the cycle re-applies the route and moves it to ISSUED; HTTPS verifies with the Pebble root',
    async () => {
      await peb().setARecord(hosts.a, hostIp);
      const created = await create('a');
      expect(created).toMatchObject({ ok: true, domain: { hostname: hosts.a, applyStatus: 'PENDING', certStatus: 'PENDING' } });
      const payload = enqueued[0];
      if (handler === undefined || payload === undefined) throw new Error('install not enqueued');
      expect(await handler(payload)).not.toBe('failed');
      expect((await serverRow()).proxyStatus).toBe('RUNNING');

      published.length = 0;
      const startedAt = Date.now();
      // A2: the PENDING apply is re-applied by the certificate cycle itself.
      await cycleUntil(rec(), async () => (await domainRow('a')).applyStatus === 'APPLIED', ROUTE_WAIT_MS);
      expect((await waitHit(hosts.a, routed(hosts.a))).status).toBe(200);
      const cycles = await cycleUntil(rec(), async () => (await domainRow('a')).certStatus !== 'PENDING', ISSUE_WAIT_MS);
      const row = await domainRow('a');
      console.log(`[22-04-ISSUE] ${JSON.stringify({ ubuntu, cycles, issueMs: Date.now() - startedAt })}`);
      expect(row.certStatus).toBe('ISSUED');
      expect(row.certErrorCode).toBeNull();
      if (row.certNotAfter === null) throw new Error('notAfter not stored');
      const remainingMs = row.certNotAfter.getTime() - Date.now();
      expect(remainingMs).toBeGreaterThan(0);
      expect(remainingMs).toBeLessThanOrEqual((CERT_VALIDITY_SECONDS + 60) * 1000);

      // A3: service.updated with the serviceId; the activity carries ids and the previous status only.
      expect(published.some((event) => event.type === 'service.updated' && (event as { service: { id: string } }).service.id === serviceId)).toBe(true);
      const issued = await activities('domain.certificate_issued', row.id);
      expect(issued).toHaveLength(1);
      expect(issued[0]?.metadata).toEqual({ serviceId, previousStatus: 'PENDING' });
      expect(JSON.stringify(issued)).not.toMatch(/BEGIN CERTIFICATE|PRIVATE KEY|Pebble/);

      const secure = await httpsHit(hosts.a);
      expect(secure.status).toBe(200);
      expect(secure.body).toContain(`ok ${hosts.a}`);
    },
    INSTALL_CASE_TIMEOUT_MS,
  );

  it(
    'A4: httpsRedirect on answers HTTP with a redirect to https; off answers 200',
    async () => {
      const domainId = ids.a;
      if (domainId === undefined) throw new Error('domain a missing');
      const on = await m().domainServices.updateDomain(deps(), { actor: ACTOR, scope: scope(), domainId, body: { httpsRedirect: true } });
      expect(on).toMatchObject({ ok: true, domain: { httpsRedirect: true, applyStatus: 'APPLIED' } });
      const redirected = await waitHit(hosts.a, (h) => h.status === 302);
      expect(redirected.status).toBe(302);
      expect(redirected.headers['location']).toBe(`https://${hosts.a}/`);
      expect((await httpsHit(hosts.a)).status).toBe(200);

      const off = await m().domainServices.updateDomain(deps(), { actor: ACTOR, scope: scope(), domainId, body: { httpsRedirect: false } });
      expect(off).toMatchObject({ ok: true, domain: { httpsRedirect: false, applyStatus: 'APPLIED' } });
      expect((await waitHit(hosts.a, routed(hosts.a))).status).toBe(200);
      // The PATCH keeps a valid certificate (only FAILED returns to PENDING).
      expect(['ISSUED', 'RENEWING']).toContain((await domainRow('a')).certStatus);
    },
    CASE_TIMEOUT_MS,
  );

  it(
    'A1/A4: DNS pointed elsewhere -> FAILED with CERT_DNS_MISMATCH after the shortened issue timeout',
    async () => {
      if (shortReconciler === undefined) throw new Error('short reconciler not built');
      // Pebble validates against an address with nothing on :80, so issuance never completes.
      await peb().setARecord(hosts.b, peb().ip);
      const created = await create('b');
      expect(created).toMatchObject({ ok: true, domain: { hostname: hosts.b, applyStatus: 'APPLIED', certStatus: 'PENDING' } });
      const domainId = ids.b;
      if (domainId === undefined) throw new Error('domain b missing');
      const checked = await m().domainServices.recheckDomainDns(deps(), { scope: scope(), domainId });
      expect(checked).toMatchObject({ ok: true, domain: { dnsStatus: 'MISMATCH' } });

      const startedAt = Date.now();
      await cycleUntil(shortReconciler, async () => (await domainRow('b')).certStatus !== 'PENDING', SHORT_ISSUE_TIMEOUT_MS + 60_000);
      const row = await domainRow('b');
      expect(row.certStatus).toBe('FAILED');
      expect(row.certErrorCode).toBe('CERT_DNS_MISMATCH');
      expect(row.certNotAfter).toBeNull();
      expect(Date.now() - startedAt).toBeGreaterThanOrEqual(SHORT_ISSUE_TIMEOUT_MS - 5_000);
      const failedEvents = await activities('domain.certificate_failed', domainId);
      expect(failedEvents).toHaveLength(1);
      expect(failedEvents[0]).toMatchObject({ errorCode: 'CERT_DNS_MISMATCH', metadata: { serviceId, previousStatus: 'PENDING' } });
    },
    CASE_TIMEOUT_MS,
  );

  it(
    'H4: a deleted dynamic file is re-applied within one cycle and domain.route_restored recorded',
    async () => {
      const domainId = ids.a;
      if (domainId === undefined) throw new Error('domain a missing');
      const [router] = proxyRouterNamesFor(serviceId, [{ id: domainId }]);
      if (router === undefined) throw new Error('no router name');
      expect(await waitRouter(router, 'present')).toBe('present');

      await rootOut(['rm', '-f', '--', dynamicPath()]);
      expect(await waitRouter(router, 'missing')).toBe('missing');

      await delay(TEST_CHECK_DELAY_MS + 100);
      const summary = await rec().runDue();
      expect(summary).toMatchObject({ sshFailed: 0, restored: 1 });
      expect((await root(['test', '-f', dynamicPath()])).exitCode).toBe(0);
      expect(await waitRouter(router, 'present', 5_000)).toBe('present');
      expect((await waitHit(hosts.a, routed(hosts.a))).status).toBe(200);
      const restored = await activities('domain.route_restored', serviceId);
      expect(restored).toHaveLength(1);
      expect(restored[0]?.metadata).toMatchObject({ serviceId });
      expect(logged.some((entry) => entry.fields['outcome'] === 'route_restored')).toBe(true);
    },
    CASE_TIMEOUT_MS,
  );

  it(
    'A1/H2: a stopped proxy -> CERT_PROXY_UNAVAILABLE and server FAILED/PROXY_UNAVAILABLE, server.proxy_failed once',
    async () => {
      const before = await domainRow('a');
      await rootOut(['docker', 'stop', proxyContainerName()]);
      try {
        await delay(TEST_CHECK_DELAY_MS + 100);
        const first = await rec().runDue();
        expect(first).toMatchObject({ sshFailed: 0 });
        const row = await domainRow('a');
        expect(row.certErrorCode).toBe('CERT_PROXY_UNAVAILABLE');
        // A down proxy keeps the certificate status (no FAILED flip for a valid certificate).
        expect(row.certStatus).toBe(before.certStatus);
        const server = await serverRow();
        expect(server.proxyStatus).toBe('FAILED');
        expect(server.proxyErrorCode).toBe('PROXY_UNAVAILABLE');
        expect(logged.some((entry) => entry.fields['outcome'] === 'proxy_unavailable')).toBe(true);

        await delay(TEST_CHECK_DELAY_MS + 100);
        await rec().runDue();
        expect(await activities('server.proxy_failed', serverId)).toHaveLength(1);
        expect((await serverRow()).proxyStatus).toBe('FAILED');
      } finally {
        await rootOut(['docker', 'start', proxyContainerName()]);
      }
    },
    CASE_TIMEOUT_MS,
  );
});
