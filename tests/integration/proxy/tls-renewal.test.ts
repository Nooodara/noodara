// 22-06 TLS renewal contract on the real sshd + dockerd fixture with Pebble (gate it-tls-renewal).
// Pebble issues 300 s certificates and the proxy is installed with Traefik's
// certificatesDuration: 1 (ADR 0011 renewal measurement: 26-57 s). The setup mirrors
// tls-issuance.test.ts: domain services and the cert reconciler on a migrated Postgres, the real
// install job handler, the SSH adapter.
//   A1: issued at T -> renewed without intervention; the reconciler shows ISSUED -> RENEWING ->
//       ISSUED with a later notAfter; every HTTPS request made during the renewal answers 200.
//   H1: acme.json stays 0600 (root) on the server before and after the renewal; no table of the
//       control plane database holds certificate or key material (PEM markers or acme.json data).
// App modules are imported dynamically after a valid test env is written (env.ts fail-fasts).
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PROXY_LAYOUT } from '@noodara/domain';
import { createRedactor, secretValue } from '@noodara/domain/security';
import { createSsh2Adapter, formatFingerprint, type SshTimeouts } from '@noodara/ssh';
import {
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
import type { ProxyServiceDeps } from '../../../apps/control-plane/src/proxy/proxy-service.js';
import type { ProxyInstallJobPayload } from '../../../apps/control-plane/src/queue/proxy-job-payload.js';
import { DEPLOY_ENGINE_UBUNTU_VERSIONS, startDeployEngineStack, type DeployEngineStack } from '../helpers/deploy-engine.js';
import { PEBBLE_ACME_DIRECTORY_URL, PEBBLE_HOSTNAME, TRAEFIK_IMAGE, startPebble, type StartedPebble } from '../helpers/pebble.js';
import { startPostgres, type PostgresFixture } from '../helpers/postgres.js';
import { assertNoStrayTestContainers } from '../helpers/ssh.js';

const STACK_TIMEOUT_MS = 900_000;
const CASE_TIMEOUT_MS = 720_000;
const TIMEOUTS: SshTimeouts = { connectMs: 20_000, commandMs: 60_000, discoveryMs: 120_000 };
const MAX_LINE_BYTES = 16_384;
/** Short validity so Traefik (certificatesDuration: 1 h) renews within about a minute. */
const CERT_VALIDITY_SECONDS = 300;
const CERTIFICATES_DURATION_HOURS = 1;
const KEY_VERSION = 1;
const ACTOR = { type: 'system' } as const;
const BACKEND_PORT = 3000;
const TEST_CHECK_DELAY_MS = 1000;
const ISSUE_WAIT_MS = 180_000;
/** Measured 26-57 s; a full validity period bounds it (an expired certificate fails A1 anyway). */
const RENEW_WAIT_MS = CERT_VALIDITY_SECONDS * 1000;
const ROUTE_WAIT_MS = 30_000;
const HTTPS_PROBE_GAP_MS = 1000;
const ACME_FILE_MODE = '600';

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

interface Hit {
  readonly status: number;
  readonly body: string;
}

interface AcmeMaterial {
  readonly certificates: number;
  /** Base64 blobs from acme.json (certificates, keys, account key); never logged. */
  readonly blobs: readonly string[];
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function parseHit(raw: string): Hit {
  const normalised = raw.replace(/\r\n/g, '\n');
  const split = normalised.indexOf('\n\n');
  const head = split === -1 ? normalised : normalised.slice(0, split);
  const body = split === -1 ? '' : normalised.slice(split + 2);
  const status = Number(/^HTTP\/\S+\s+(\d{3})/.exec(head)?.[1] ?? '0');
  return { status, body };
}

/** Every string value under a key named certificate/key/privatekey, at any depth. */
function acmeBlobs(value: unknown, into: string[]): void {
  if (Array.isArray(value)) {
    for (const item of value) acmeBlobs(item, into);
    return;
  }
  if (value === null || typeof value !== 'object') return;
  for (const [key, inner] of Object.entries(value)) {
    if (typeof inner === 'string' && /^(certificate|key|privatekey)$/i.test(key) && inner.length > 0) {
      into.push(inner);
    } else {
      acmeBlobs(inner, into);
    }
  }
}

describe.each(DEPLOY_ENGINE_UBUNTU_VERSIONS)('22-06 TLS renewal on Ubuntu %s', (ubuntu) => {
  let stack: DeployEngineStack | undefined;
  let postgres: PostgresFixture | undefined;
  let pebble: StartedPebble | undefined;
  let tempRoot: string | undefined;
  let mods: ModulesOf | undefined;
  let handler: ((data: unknown) => Promise<string>) | undefined;
  let domainDeps: DomainServiceDeps | undefined;
  let reconciler: CertReconciler | undefined;
  let hostIp = '';
  let serverId = '';
  let projectId = '';
  let serviceId = '';
  let domainId = '';

  const masterKey = randomBytes(32);
  const enqueued: ProxyInstallJobPayload[] = [];
  /** Install job log lines (redacted by the job), shown only when the install fails. */
  const installLog: Record<string, unknown>[] = [];
  const installLogger = {
    info: (fields: Record<string, unknown>) => installLog.push(fields),
    warn: (fields: Record<string, unknown>) => installLog.push(fields),
    error: (fields: Record<string, unknown>) => installLog.push(fields),
  };
  const label = (): string => randomUUID().slice(0, 8);
  const hostname = `r${label()}.renew.noodara.test`;

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
  const root = (argv: readonly string[]) => s().exec(argv, { user: 'root' });
  const rootOut = async (argv: readonly string[]): Promise<string> => {
    const result = await root(argv);
    if (result.exitCode !== 0) throw new Error(`root exec failed (${String(result.exitCode)}): ${argv.join(' ')}`);
    return result.stdout;
  };
  const routed = (h: Hit): boolean => h.status === 200 && h.body.includes(`ok ${hostname}`);
  const waitHttp = async (): Promise<Hit> => {
    const startedAt = Date.now();
    for (;;) {
      const result = await root(['curl', '-s', '-i', '--max-time', '3', '-H', `Host: ${hostname}`, 'http://127.0.0.1/']);
      const current = parseHit(result.stdout);
      if (routed(current) || Date.now() - startedAt >= ROUTE_WAIT_MS) return current;
      await delay(250);
    }
  };
  /** HTTPS through the proxy on the host, verified against the Pebble issuance root only. */
  const httpsHit = async (): Promise<Hit> => {
    const script = [
      'set -e',
      'curl -sk --max-time 5 "https://$1:15000/roots/0" -o /tmp/noodara-pebble-root.pem',
      'curl -s -i --max-time 5 --cacert /tmp/noodara-pebble-root.pem --resolve "$2:443:127.0.0.1" "https://$2/"',
    ].join('\n');
    const result = await root(['sh', '-c', script, 'sh', peb().ip, hostname]);
    return result.exitCode === 0 ? parseHit(result.stdout) : { status: 0, body: `exit ${String(result.exitCode)}` };
  };
  const domainRow = async () => {
    const [row] = await db().select().from(domains).where(eq(domains.id, domainId)).limit(1);
    if (!row) throw new Error('domain row missing');
    return row;
  };
  const serverRow = async () => {
    const [row] = await db().select().from(servers).where(eq(servers.id, serverId)).limit(1);
    if (!row) throw new Error('server row missing');
    return row;
  };
  /** Runs cycles (one per TEST_CHECK_DELAY_MS) until `done`; returns the cycles run. */
  const cycleUntil = async (done: () => Promise<boolean>, timeoutMs: number): Promise<number> => {
    const deadline = Date.now() + timeoutMs;
    for (let cycles = 1; ; cycles += 1) {
      await rec().runDue();
      if (await done()) return cycles;
      if (Date.now() > deadline) throw new Error(`condition not met after ${String(cycles)} cycles`);
      await delay(TEST_CHECK_DELAY_MS);
    }
  };
  const acmeMode = async (): Promise<string> =>
    (await rootOut(['stat', '-c', '%a %U', '--', PROXY_LAYOUT.acmeStorageFile])).trim();
  /** Test-side read of Traefik's store, as root on the server; the control plane never reads it. */
  const acmeMaterial = async (): Promise<AcmeMaterial> => {
    const parsed: unknown = JSON.parse(await rootOut(['cat', '--', PROXY_LAYOUT.acmeStorageFile]));
    const blobs: string[] = [];
    acmeBlobs(parsed, blobs);
    const certificates = JSON.stringify(parsed).match(/"certificate"\s*:/gi)?.length ?? 0;
    return { certificates, blobs };
  };
  /** Every row of every table in the public schema, as text. */
  const databaseDump = async (): Promise<string> => {
    const tables = await db().execute<{ table_name: string }>(
      sql`SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' AND table_type = 'BASE TABLE'`,
    );
    const parts: string[] = [];
    for (const { table_name: table } of tables.rows) {
      if (!/^[a-z_][a-z0-9_]*$/.test(table)) throw new Error(`unexpected table name ${table}`);
      const dump = await db().execute<{ dump: string | null }>(
        sql.raw(`SELECT string_agg(t::text, E'\\n') AS dump FROM "${table}" t`),
      );
      parts.push(dump.rows[0]?.dump ?? '');
    }
    expect(tables.rows.length).toBeGreaterThan(0);
    return parts.join('\n');
  };

  beforeAll(async () => {
    const starts = await Promise.allSettled([startDeployEngineStack({ ubuntu }), startPostgres()]);
    const [stackResult, pgResult] = starts;
    if (stackResult.status === 'fulfilled') stack = stackResult.value;
    if (pgResult.status === 'fulfilled') postgres = pgResult.value;
    const failed = starts.find((result) => result.status === 'rejected');
    if (failed !== undefined) throw failed.reason;
    process.env.NOODARA_MASTER_KEY = masterKey.toString('base64');
    process.env.BETTER_AUTH_SECRET = `tls-renewal-${randomUUID()}-${randomUUID()}`;
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
    tempRoot = mkdtempSync(path.join(tmpdir(), 'noodara-tls-renewal-'));
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
    const serverHost = s().ssh.host === 'localhost' ? '127.0.0.1' : s().ssh.host;
    const [serverInserted] = await db()
      .insert(servers)
      .values({
        name: `renew-host-${ubuntu}`,
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
      .values({ name: 'tls-renewal', slug: `renew-${label()}`, createdAt: now, updatedAt: now })
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
        logger: installLogger,
        extraHosts: [{ name: PEBBLE_HOSTNAME, ip: pebble.ip }],
        certificatesDurationHours: CERTIFICATES_DURATION_HOURS,
      }),
    );
    const connect = deployConnect.createDeployConnect({
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
    domainDeps = {
      db: db(),
      now: () => new Date(),
      publicUrlHost: 'localhost',
      getProxyService: () => Promise.resolve(proxyDeps),
      resolver: {
        resolve4: () => Promise.reject(Object.assign(new Error('ENOTFOUND'), { code: 'ENOTFOUND' })),
        resolve6: () => Promise.reject(Object.assign(new Error('ENODATA'), { code: 'ENODATA' })),
      },
      dnsLimiter: domainDns.createDnsCheckLimiter(),
      apply,
    };
    reconciler = certReconciler.createCertReconciler({
      store: certReconciler.createCertStore(db()),
      connect,
      createRedactor,
      apply,
      events: noEvents,
      logger: silent,
      intervalMs: 600_000,
      commandMs: TIMEOUTS.commandMs,
      checkDelayMs: () => TEST_CHECK_DELAY_MS,
      issueTimeoutMs: 600_000,
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
    'A1/H1: a certificate issued at T renews unattended (ISSUED -> RENEWING -> ISSUED, later notAfter); HTTPS never fails; acme.json stays 0600 and the database holds no certificate material',
    async () => {
      await peb().setARecord(hostname, hostIp);
      const created = await m().domainServices.createDomain(deps(), {
        actor: ACTOR,
        scope: { projectId, serviceId },
        body: { hostname, httpsRedirect: false },
      });
      expect(created).toMatchObject({ ok: true, domain: { hostname, certStatus: 'PENDING' } });
      const [inserted] = await db().select().from(domains).where(eq(domains.hostname, hostname)).limit(1);
      if (!inserted) throw new Error('domain row missing');
      domainId = inserted.id;
      const payload = enqueued[0];
      if (handler === undefined || payload === undefined) throw new Error('install not enqueued');
      const installed = await handler(payload);
      const server = await serverRow();
      expect(installed, JSON.stringify({ proxyErrorCode: server.proxyErrorCode, installLog })).not.toBe('failed');
      expect(server.proxyStatus).toBe('RUNNING');

      // Issued at T.
      await cycleUntil(async () => (await domainRow()).applyStatus === 'APPLIED', ROUTE_WAIT_MS);
      expect(routed(await waitHttp())).toBe(true);
      await cycleUntil(async () => (await domainRow()).certStatus !== 'PENDING', ISSUE_WAIT_MS);
      const issued = await domainRow();
      expect(issued.certStatus).toBe('ISSUED');
      const firstNotAfter = issued.certNotAfter;
      if (firstNotAfter === null) throw new Error('notAfter not stored');
      expect(firstNotAfter.getTime() - Date.now()).toBeLessThanOrEqual((CERT_VALIDITY_SECONDS + 60) * 1000);
      const firstHttps = await httpsHit();
      expect(firstHttps.status).toBe(200);
      expect(await acmeMode()).toBe(`${ACME_FILE_MODE} root`);

      // HTTPS probes run back to back for the whole renewal.
      const hits: Hit[] = [];
      let probing = true;
      const prober = (async () => {
        while (probing) {
          hits.push(await httpsHit());
          await delay(HTTPS_PROBE_GAP_MS);
        }
      })();

      const statuses: string[] = ['ISSUED'];
      const renewStartedAt = Date.now();
      let cycles = 0;
      try {
        cycles = await cycleUntil(async () => {
          const row = await domainRow();
          if (statuses.at(-1) !== row.certStatus) statuses.push(row.certStatus);
          return (
            statuses.includes('RENEWING') &&
            row.certStatus === 'ISSUED' &&
            row.certNotAfter !== null &&
            row.certNotAfter.getTime() > firstNotAfter.getTime()
          );
        }, RENEW_WAIT_MS);
      } finally {
        probing = false;
        await prober;
      }
      const renewed = await domainRow();
      console.log(
        `[22-06-RENEW] ${JSON.stringify({ ubuntu, cycles, renewMs: Date.now() - renewStartedAt, statuses, httpsRequests: hits.length })}`,
      );

      // A1: ISSUED -> RENEWING -> ISSUED with a later notAfter, no FAILED/EXPIRED on the way.
      expect(statuses.slice(0, 3)).toEqual(['ISSUED', 'RENEWING', 'ISSUED']);
      expect(statuses.every((status) => status === 'ISSUED' || status === 'RENEWING')).toBe(true);
      expect(renewed.certStatus).toBe('ISSUED');
      expect(renewed.certErrorCode).toBeNull();
      expect(renewed.certNotAfter?.getTime() ?? 0).toBeGreaterThan(firstNotAfter.getTime());
      // A1: every HTTPS request made during the renewal succeeded.
      expect(hits.length).toBeGreaterThan(0);
      expect(hits.filter((h) => h.status !== 200 || !h.body.includes(`ok ${hostname}`))).toEqual([]);
      expect((await httpsHit()).status).toBe(200);

      // H1: acme.json stays root 0600 and holds the certificates; the database holds none of it.
      expect(await acmeMode()).toBe(`${ACME_FILE_MODE} root`);
      const material = await acmeMaterial();
      expect(material.certificates).toBeGreaterThan(0);
      expect(material.blobs.length).toBeGreaterThan(0);
      const dump = await databaseDump();
      expect(dump).not.toMatch(/BEGIN CERTIFICATE|PRIVATE KEY|BEGIN EC|LS0tLS1CRUdJTi/);
      const leaked = material.blobs.filter((blob) => dump.includes(blob.slice(0, 64)));
      expect(leaked).toHaveLength(0);
    },
    CASE_TIMEOUT_MS,
  );
});
