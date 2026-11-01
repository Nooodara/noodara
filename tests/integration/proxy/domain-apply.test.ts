// 22-03 domain apply on the real sshd + dockerd fixture (gate it-domains-apply, Ubuntu 24.04).
// The domain services (create/update/remove) run against a migrated Postgres with the real applier
// (createDomainApplier over createDeployConnect and the SSH adapter); the proxy is installed by the
// real install job handler against Pebble. Traffic is probed with curl on the host as root.
//   A1: create on NOT_INSTALLED enqueues the install, the row waits PENDING; once RUNNING the
//       reconcile re-apply routes it (proxy joined noodara-net-<serviceId>); create on RUNNING routes.
//   A4/R1: PATCH httpsRedirect re-applies; the 302 carries `Cache-Control: no-store`.
//   A5: a forced invalid write is restored from `.prev` and reported PROXY_ROUTE_FAILED; a stopped
//       proxy is 503 PROXY_UNAVAILABLE with the row kept PENDING; delete ends in Traefik's 404.
//   H3: sshd stopped -> SERVER_UNREACHABLE (502, never 500), row PENDING; the next reconcile
//       re-apply, with sshd back, routes it.
//   22-08 A1: the last delete with sshd stopped is surfaced (SERVER_UNREACHABLE, 502) and marks the
//       file; the reconcile cleanup removes the orphan file once sshd is back, then has nothing left.
// App modules are imported dynamically after a valid test env is written (env.ts fail-fasts).
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { proxyContainerName, proxyDynamicPathFor } from '@noodara/domain';
import { createRedactor, secretValue } from '@noodara/domain/security';
import { createSsh2Adapter, formatFingerprint, type SshTimeouts } from '@noodara/ssh';
import { credentials, domains, environments, projects, servers, services, users } from '../../../apps/control-plane/src/db/schema/index.js';
import type { DomainApplier, DomainServiceDeps } from '../../../apps/control-plane/src/domains/domain-services.js';
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
/** Forced-invalid applier: a shorter verify window keeps the case quick. */
const FORCED_VERIFY_MS = 10_000;
/** A routed answer right after an applied result, Traefik's own reload included. */
const ROUTE_WAIT_MS = 15_000;

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
  httpErrors: typeof import('../../../apps/control-plane/src/routes/http-errors.js');
};

interface Hit {
  readonly status: number;
  readonly headers: Record<string, string>;
  readonly body: string;
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

describe.each(DEPLOY_ENGINE_UBUNTU_VERSIONS)('22-03 domain apply on Ubuntu %s', (ubuntu) => {
  let stack: DeployEngineStack | undefined;
  let postgres: PostgresFixture | undefined;
  let pebble: StartedPebble | undefined;
  let tempRoot: string | undefined;
  let mods: ModulesOf | undefined;
  let handler: ((data: unknown) => Promise<string>) | undefined;
  let proxyDeps: ProxyServiceDeps | undefined;
  let domainDeps: DomainServiceDeps | undefined;
  let forcedDeps: DomainServiceDeps | undefined;
  let apply: DomainApplier | undefined;
  let serverId = '';
  let projectId = '';
  let serviceId = '';

  const masterKey = randomBytes(32);
  const enqueued: ProxyInstallJobPayload[] = [];
  const warned: Record<string, unknown>[] = [];
  const label = (): string => randomUUID().slice(0, 8);
  const hosts = {
    a: `a${label()}.apply.noodara.test`,
    b: `b${label()}.apply.noodara.test`,
    c: `c${label()}.apply.noodara.test`,
    d: `d${label()}.apply.noodara.test`,
    e: `e${label()}.apply.noodara.test`,
    f: `f${label()}.apply.noodara.test`,
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
  const applier = (): DomainApplier => {
    if (apply === undefined) throw new Error('applier not built');
    return apply;
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
  const waitHit = async (host: string, done: (h: Hit) => boolean, timeoutMs = ROUTE_WAIT_MS): Promise<{ hit: Hit; ms: number }> => {
    const startedAt = Date.now();
    for (;;) {
      const current = await hit(host);
      if (done(current) || Date.now() - startedAt >= timeoutMs) return { hit: current, ms: Date.now() - startedAt };
      await delay(250);
    }
  };
  const routed = (host: string) => (h: Hit) => h.status === 200 && h.body.includes(`ok ${host}`);
  const notFound = (h: Hit) => h.status === 404;
  const networkMembers = async (): Promise<string[]> =>
    (await rootOut(['docker', 'network', 'inspect', '--format', '{{range .Containers}}{{.Name}} {{end}}', `noodara-net-${serviceId}`]))
      .trim()
      .split(/\s+/)
      .filter((name) => name !== '');
  const fileSha = async (): Promise<string> => (await rootOut(['sha256sum', '--', dynamicPath()])).trim().split(' ')[0] ?? '';
  const domainRow = async (key: keyof typeof hosts) => {
    const id = ids[key];
    if (id === undefined) throw new Error(`domain ${key} not created`);
    const [row] = await db().select().from(domains).where(eq(domains.id, id)).limit(1);
    return row ?? null;
  };
  const serverRow = async () => {
    const [row] = await db().select().from(servers).where(eq(servers.id, serverId)).limit(1);
    if (!row) throw new Error('server row missing');
    return row;
  };
  const create = async (key: keyof typeof hosts, target: DomainServiceDeps = deps()) => {
    const result = await m().domainServices.createDomain(target, {
      actor: ACTOR,
      scope: scope(),
      body: { hostname: hosts[key].toUpperCase(), httpsRedirect: false },
    });
    const [row] = await db().select().from(domains).where(eq(domains.hostname, hosts[key])).limit(1);
    if (row) ids[key] = row.id;
    return result;
  };
  const remove = async (key: keyof typeof hosts) => {
    const domainId = ids[key];
    if (domainId === undefined) throw new Error(`domain ${key} not created`);
    return m().domainServices.removeDomain(deps(), { actor: ACTOR, scope: scope(), domainId });
  };
  const reapply = () =>
    m().domainServices.reapplyPendingDomains({
      db: db(),
      apply: applier(),
      logger: { warn: (fields) => warned.push(fields) },
    });
  const sshd = async (action: 'stop' | 'start'): Promise<void> => {
    if (action === 'stop') {
      expect((await root(['pkill', '-x', 'sshd'])).exitCode, 'no sshd process was signalled').toBe(0);
    } else {
      await rootOut(['sh', '-c', 'pgrep -x sshd >/dev/null || { mkdir -p /run/sshd && /usr/sbin/sshd; }']);
    }
    const deadline = Date.now() + 20_000;
    for (;;) {
      const listening = (await root(['sh', '-c', "ss -ltnH 'sport = :22' | grep -q ."])).exitCode === 0;
      if (listening === (action === 'start')) return;
      if (Date.now() > deadline) throw new Error(`sshd did not ${action}`);
      await delay(250);
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
    process.env.BETTER_AUTH_SECRET = `domain-apply-${randomUUID()}-${randomUUID()}`;
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
      httpErrors: await import('../../../apps/control-plane/src/routes/http-errors.js'),
    };
    const { deployConnect, proxyJob, proxyWiring, credentialStore, domainServices, domainApply, domainDns } = mods;

    pebble = await startPebble({ networkName: s().networkName, validitySeconds: CERT_VALIDITY_SECONDS });
    const node = s().baseImages.find((ref) => ref.startsWith('node:'));
    if (node === undefined) throw new Error('no node base image preloaded');
    tempRoot = mkdtempSync(path.join(tmpdir(), 'noodara-domain-apply-'));
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
        name: `domain-host-${ubuntu}`,
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
      .values({ name: 'domain-apply', slug: `apply-${label()}`, createdAt: now, updatedAt: now })
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
    const lock = domainApply.createServiceLock();
    const limits = domainApply.domainApplyLimits(TIMEOUTS.commandMs);
    apply = domainServices.createDomainApplier({ db: db(), connect, createRedactor, limits, lock });
    // A5: a write that lands but cannot route (every router points at a missing service).
    const forcedApply = domainServices.createDomainApplier({
      db: db(),
      connect,
      createRedactor,
      lock,
      limits: { ...limits, verifyMs: FORCED_VERIFY_MS },
      render: (svc, list) => {
        const rendered = domainApply.renderServiceRoutes(svc, list);
        if (!rendered.ok) return rendered;
        const parsed = JSON.parse(rendered.value) as { http: { routers: Record<string, { service: string }> } };
        for (const router of Object.values(parsed.http.routers)) router.service = 'noodara-missing-upstream';
        return { ok: true, value: JSON.stringify(parsed) };
      },
    });
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
    domainDeps = { ...base, apply };
    forcedDeps = { ...base, apply: forcedApply };
  }, STACK_TIMEOUT_MS);

  afterAll(async () => {
    if (stack !== undefined) await sshd('start').catch(() => undefined);
    await pebble?.stop();
    await postgres?.stop();
    await stack?.stop();
    if (tempRoot !== undefined) rmSync(tempRoot, { recursive: true, force: true });
    await assertNoStrayTestContainers();
  }, STACK_TIMEOUT_MS);

  it(
    'A1: on NOT_INSTALLED the row (lowercased) waits PENDING and the install is enqueued; once RUNNING the reconcile re-apply routes it',
    async () => {
      const created = await create('a');
      expect(created).toMatchObject({ ok: true, domain: { hostname: hosts.a, applyStatus: 'PENDING' } });
      expect(enqueued).toHaveLength(1);
      expect(enqueued[0]).toMatchObject({ serverId });
      if (handler === undefined) throw new Error('handler not built');
      const payload = enqueued[0];
      if (payload === undefined) throw new Error('no payload');
      expect(await handler(payload)).not.toBe('failed');
      expect((await serverRow()).proxyStatus).toBe('RUNNING');

      const startedAt = Date.now();
      expect(await reapply()).toEqual({ applied: 1, failed: 0 });
      const { hit: answered, ms } = await waitHit(hosts.a, routed(hosts.a));
      console.log(`[22-03-RELOAD] ${JSON.stringify({ ubuntu, applyMs: Date.now() - startedAt - ms, routeAfterApplyMs: ms })}`);
      expect(answered.status).toBe(200);
      expect((await domainRow('a'))?.applyStatus).toBe('APPLIED');
      expect(await networkMembers()).toContain(proxyContainerName());
    },
    INSTALL_CASE_TIMEOUT_MS,
  );

  it(
    'A1/A5: on a RUNNING proxy the create applies and both hosts route; the reload delay is measured',
    async () => {
      const startedAt = Date.now();
      const created = await create('b');
      const applyMs = Date.now() - startedAt;
      expect(created).toMatchObject({ ok: true, domain: { hostname: hosts.b, applyStatus: 'APPLIED' } });
      const { hit: answered, ms } = await waitHit(hosts.b, routed(hosts.b));
      console.log(`[22-03-RELOAD] ${JSON.stringify({ ubuntu, applyMs, routeAfterApplyMs: ms })}`);
      expect(answered.status).toBe(200);
      expect(applyMs).toBeLessThan(m().domainApply.DOMAIN_APPLY_VERIFY_MS + TIMEOUTS.commandMs);
      expect((await hit(hosts.a)).status).toBe(200);
    },
    CASE_TIMEOUT_MS,
  );

  it(
    'A4/R1: PATCH httpsRedirect true re-applies a 302 with Cache-Control no-store; false routes HTTP again',
    async () => {
      const domainId = ids.b;
      if (domainId === undefined) throw new Error('domain b missing');
      const on = await m().domainServices.updateDomain(deps(), { actor: ACTOR, scope: scope(), domainId, body: { httpsRedirect: true } });
      expect(on).toMatchObject({ ok: true, domain: { httpsRedirect: true, applyStatus: 'APPLIED' } });
      const { hit: redirected } = await waitHit(hosts.b, (h) => h.status === 302);
      expect(redirected.status).toBe(302);
      expect(redirected.headers['location']).toBe(`https://${hosts.b}/`);
      expect(redirected.headers['cache-control']).toBe('no-store');

      const off = await m().domainServices.updateDomain(deps(), { actor: ACTOR, scope: scope(), domainId, body: { httpsRedirect: false } });
      expect(off).toMatchObject({ ok: true, domain: { httpsRedirect: false, applyStatus: 'APPLIED' } });
      const { hit: plain } = await waitHit(hosts.b, routed(hosts.b));
      expect(plain.status).toBe(200);
      expect(plain.headers['cache-control']).toBeUndefined();
    },
    CASE_TIMEOUT_MS,
  );

  it(
    'A5: a forced invalid write is restored from .prev and reported PROXY_ROUTE_FAILED; the old routes keep answering',
    async () => {
      if (forcedDeps === undefined) throw new Error('forced deps not built');
      const before = await fileSha();
      const failed = await create('c', forcedDeps);
      expect(failed).toMatchObject({ ok: false, code: 'PROXY_ROUTE_FAILED' });
      if (failed.ok) throw new Error('unreachable');
      expect(m().httpErrors.mapServiceCodeToStatus(failed.code)).toBe(502);
      expect((await domainRow('c'))?.applyStatus).toBe('FAILED');
      expect(await fileSha()).toBe(before);
      expect((await waitHit(hosts.a, routed(hosts.a))).hit.status).toBe(200);
      expect((await waitHit(hosts.b, routed(hosts.b))).hit.status).toBe(200);
      expect((await hit(hosts.c)).status).toBe(404);

      // Removing the failed domain re-renders the survivors through the normal path.
      expect(await remove('c')).toEqual({ ok: true });
      expect((await domainRow('a'))?.applyStatus).toBe('APPLIED');
      expect((await domainRow('b'))?.applyStatus).toBe('APPLIED');
    },
    CASE_TIMEOUT_MS,
  );

  it(
    'A5: a stopped proxy answers 503 PROXY_UNAVAILABLE, keeps the row PENDING, and the re-apply routes it once it is back',
    async () => {
      await rootOut(['docker', 'stop', proxyContainerName()]);
      try {
        const result = await create('d');
        expect(result).toMatchObject({ ok: false, code: 'PROXY_UNAVAILABLE' });
        if (result.ok) throw new Error('unreachable');
        expect(m().httpErrors.mapServiceCodeToStatus(result.code)).toBe(503);
        expect((await domainRow('d'))?.applyStatus).toBe('PENDING');
      } finally {
        await rootOut(['docker', 'start', proxyContainerName()]);
      }
      const deadline = Date.now() + 60_000;
      let outcome = await reapply();
      while (outcome.applied === 0 && Date.now() < deadline) {
        await delay(1000);
        outcome = await reapply();
      }
      expect(outcome).toEqual({ applied: 1, failed: 0 });
      expect((await domainRow('d'))?.applyStatus).toBe('APPLIED');
      expect((await waitHit(hosts.d, routed(hosts.d))).hit.status).toBe(200);
    },
    CASE_TIMEOUT_MS,
  );

  it(
    'H3: with sshd stopped the create is SERVER_UNREACHABLE (502, never 500), the row stays PENDING; the next re-apply routes it',
    async () => {
      await sshd('stop');
      try {
        const result = await create('e');
        expect(result).toMatchObject({ ok: false, code: 'SERVER_UNREACHABLE' });
        if (result.ok) throw new Error('unreachable');
        expect(m().httpErrors.mapServiceCodeToStatus(result.code)).toBe(502);
        expect((await domainRow('e'))?.applyStatus).toBe('PENDING');
        warned.length = 0;
        expect(await reapply()).toEqual({ applied: 0, failed: 1 });
        expect(warned).toEqual([{ serviceId, code: 'SERVER_UNREACHABLE' }]);
        expect((await domainRow('e'))?.applyStatus).toBe('PENDING');
      } finally {
        await sshd('start');
      }
      expect(await reapply()).toEqual({ applied: 1, failed: 0 });
      expect((await domainRow('e'))?.applyStatus).toBe('APPLIED');
      expect((await waitHit(hosts.e, routed(hosts.e))).hit.status).toBe(200);
    },
    CASE_TIMEOUT_MS,
  );

  it(
    'A2/A5: delete re-renders without the host (Traefik 404); the last delete removes the file and leaves the network',
    async () => {
      expect(await remove('e')).toEqual({ ok: true });
      expect((await waitHit(hosts.e, notFound)).hit.status).toBe(404);
      expect((await hit(hosts.a)).status).toBe(200);
      expect(await networkMembers()).toContain(proxyContainerName());

      for (const key of ['d', 'b', 'a'] as const) expect(await remove(key)).toEqual({ ok: true });
      for (const host of [hosts.a, hosts.b, hosts.d]) expect((await waitHit(host, notFound)).hit.status).toBe(404);
      expect((await root(['test', '-e', dynamicPath()])).exitCode).not.toBe(0);
      expect(await networkMembers()).not.toContain(proxyContainerName());
      expect(await db().select().from(domains).where(eq(domains.serviceId, serviceId))).toEqual([]);
    },
    CASE_TIMEOUT_MS,
  );

  it(
    '22-08 A1: a last delete the applier cannot carry out is surfaced, and the reconcile cleanup removes the orphan file',
    async () => {
      expect(await create('f')).toMatchObject({ ok: true });
      expect((await waitHit(hosts.f, routed(hosts.f))).hit.status).toBe(200);
      const cleanup = () =>
        m().domainServices.cleanupOrphanRoutes({ db: db(), apply: applier(), logger: { warn: (fields) => warned.push(fields) } });

      await sshd('stop');
      try {
        const result = await remove('f');
        expect(result).toEqual({
          ok: false,
          code: 'SERVER_UNREACHABLE',
          message: m().domainServices.DOMAIN_REMOVED_ROUTE_PENDING_MESSAGE,
        });
        if (result.ok) throw new Error('unreachable');
        expect(m().httpErrors.mapServiceCodeToStatus(result.code)).toBe(502);
        expect(await db().select().from(domains).where(eq(domains.serviceId, serviceId))).toEqual([]);
        // Still unreachable: the cleanup fails and the mark stays for the next tick.
        warned.length = 0;
        expect(await cleanup()).toEqual({ removed: 0, failed: 1 });
        expect(warned).toEqual([{ serviceId, code: 'SERVER_UNREACHABLE' }]);
      } finally {
        await sshd('start');
      }
      // The orphan file still routes the removed host until the cleanup runs.
      expect((await root(['test', '-e', dynamicPath()])).exitCode).toBe(0);

      expect(await cleanup()).toEqual({ removed: 1, failed: 0 });
      expect((await root(['test', '-e', dynamicPath()])).exitCode).not.toBe(0);
      expect(await networkMembers()).not.toContain(proxyContainerName());
      expect((await waitHit(hosts.f, notFound)).hit.status).toBe(404);
      expect(await cleanup()).toEqual({ removed: 0, failed: 0 });
    },
    CASE_TIMEOUT_MS,
  );
});
