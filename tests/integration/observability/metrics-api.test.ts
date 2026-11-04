import { randomBytes, randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import parseSetCookie from 'set-cookie-parser';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { revealSecret } from '@noodara/domain/security';
import type { buildApp as BuildApp } from '../../../apps/control-plane/src/app.js';
import {
  containerMetricSamples,
  containerObservations,
  deployments,
  hostMetricSamples,
  servers,
  services,
} from '../../../apps/control-plane/src/db/schema/index.js';
import type { ServerEventPublisher } from '../../../apps/control-plane/src/events/server-event-publisher.js';
import { issueToken } from '../../../apps/control-plane/src/services/setup-token-repository.js';
import { startPostgres, type PostgresFixture } from '../helpers/postgres.js';

// 27-03 (A1-A3, H1): the metrics and service status API on the real HTTP surface and a migrated
// Postgres. Samples are seeded straight into the 0019 tables at fixed offsets from an aligned
// minute two hours ago, so every bucket's expected value is known. Default env knobs: 60 s
// collector interval, 168 h retention.

const ADMIN_EMAIL = 'admin@noodara.dev';
const ADMIN_PASSWORD = 'correct horse battery staple';
const PUBLIC_HOST = 'panel.noodara.dev';
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const GIB = 1024 ** 3;
let serverOctet = 10;

type Json = Record<string, unknown>;
interface Point {
  t: string;
  v: number | null;
}
interface Series {
  scope: string;
  entityId: string;
  metric: string;
  from: string;
  to: string;
  intervalSeconds: number;
  points: Point[];
}

let postgres: PostgresFixture;
let app: ReturnType<typeof BuildApp>;
let cookie: string;

const events: ServerEventPublisher = { publish: () => Promise.resolve() };

function setTestEnv(connectionString: string): void {
  process.env.NOODARA_MASTER_KEY = randomBytes(32).toString('base64');
  process.env.BETTER_AUTH_SECRET = `test-fixture-${randomUUID()}-${randomUUID()}`;
  process.env.DATABASE_URL = connectionString;
  process.env.REDIS_URL = 'redis://localhost:6379';
  process.env.NOODARA_PUBLIC_URL = `https://${PUBLIC_HOST}`;
}

function cookieHeaderFrom(response: { headers: Record<string, unknown> }): string {
  const raw = response.headers['set-cookie'];
  const rawCookies = Array.isArray(raw) ? raw : raw !== undefined ? [String(raw)] : [];
  return parseSetCookie
    .parse(rawCookies, { map: false })
    .map((entry) => `${entry.name}=${entry.value}`)
    .join('; ');
}

async function signIn(): Promise<string> {
  const issued = await issueToken(postgres.db, 'setup', new Date());
  const setup = await app.inject({
    method: 'POST',
    url: '/api/setup',
    payload: { token: revealSecret(issued.token), email: ADMIN_EMAIL, password: ADMIN_PASSWORD, name: 'Admin' },
  });
  if (setup.statusCode !== 200) throw new Error(`setup failed: ${setup.statusCode.toString()}`);
  const response = await app.inject({
    method: 'POST',
    url: '/api/auth/sign-in/email',
    payload: { email: ADMIN_EMAIL, password: ADMIN_PASSWORD },
  });
  if (response.statusCode !== 200) throw new Error(`sign-in failed: ${response.statusCode.toString()}`);
  return cookieHeaderFrom(response);
}

async function call(method: 'GET' | 'POST', url: string, payload?: unknown): Promise<{ statusCode: number; body: Json; raw: string }> {
  const response = await app.inject({
    method,
    url,
    headers: { cookie, origin: `https://${PUBLIC_HOST}` },
    ...(payload !== undefined ? { payload: payload as Json } : {}),
  });
  const body = response.body === '' ? {} : (response.json() as Json);
  return { statusCode: response.statusCode, body, raw: response.body };
}

function short(): string {
  return randomUUID().replace(/-/g, '').slice(0, 10);
}

function containerId(): string {
  return randomBytes(32).toString('hex');
}

interface Fixture {
  readonly projectId: string;
  readonly serverId: string;
  readonly serviceId: string;
}

async function newFixture(): Promise<Fixture> {
  const project = await call('POST', '/api/projects', { name: `Metrics ${short()}` });
  expect(project.statusCode, project.raw).toBe(201);
  const projectId = String(project.body.id);
  const environment = await call('POST', `/api/projects/${projectId}/environments`, { name: `env-${short()}` });
  expect(environment.statusCode, environment.raw).toBe(201);
  serverOctet += 1;
  const server = await call('POST', '/api/servers', {
    name: `srv-${short()}`,
    host: `203.0.113.${serverOctet.toString()}`,
    credential: { type: 'ssh_password', password: 'server-password-never-returned' },
  });
  expect(server.statusCode, server.raw).toBe(201);
  const serverId = String(server.body.id);
  await postgres.db
    .update(servers)
    .set({ status: 'CONNECTED', dockerInstalled: true, dockerBuildkitAvailable: true })
    .where(eq(servers.id, serverId));
  const service = await call('POST', `/api/projects/${projectId}/services`, {
    environmentId: String(environment.body.id),
    serverId,
    name: `api-${short()}`,
    source: { kind: 'image', imageRef: 'nginx:1.27' },
    internalPort: 80,
  });
  expect(service.statusCode, service.raw).toBe(201);
  return { projectId, serverId, serviceId: String(service.body.id) };
}

interface HostRow {
  at: number;
  cpu?: number | null;
  used?: number;
  total?: number;
  disk?: number | null;
  uptime?: number;
  filesystems?: { target: string; sizeBytes: number; usedBytes: number; availBytes: number }[];
}

async function addHost(serverId: string, rows: readonly HostRow[]): Promise<void> {
  await postgres.db.insert(hostMetricSamples).values(
    rows.map((row) => ({
      serverId,
      sampledAt: new Date(row.at),
      cpuPercent: row.cpu ?? null,
      memoryTotalBytes: row.total ?? 1000,
      memoryUsedBytes: row.used ?? 500,
      diskUsedPercent: row.disk ?? null,
      filesystems: row.filesystems ?? [],
      uptimeSeconds: row.uptime ?? 3600,
    })),
  );
}

interface ContainerRow {
  at: number;
  cpu?: number | null;
  used?: number | null;
  limit?: number | null;
  restarts?: number;
}

async function addContainer(serviceId: string, rows: readonly ContainerRow[], id = containerId()): Promise<void> {
  await postgres.db.insert(containerMetricSamples).values(
    rows.map((row) => ({
      serviceId,
      containerId: id,
      sampledAt: new Date(row.at),
      running: row.cpu !== null,
      cpuPercent: row.cpu ?? null,
      memoryUsedBytes: row.used === undefined ? 100 : row.used,
      memoryLimitBytes: row.limit ?? null,
      restartCount: row.restarts ?? 0,
    })),
  );
}

function seriesOf(body: Json): Series[] {
  return body.series as Series[];
}

function metric(body: Json, name: string): Series {
  const found = seriesOf(body).find((series) => series.metric === name);
  if (!found) throw new Error(`no ${name} series`);
  return found;
}

function values(body: Json, name: string): (number | null)[] {
  return metric(body, name).points.map((point) => point.v);
}

/** An aligned minute two hours ago; a 10-minute window from it is ten 60 s buckets. */
function window(): { base: number; query: string } {
  const base = Math.floor((Date.now() - 2 * HOUR) / MINUTE) * MINUTE;
  const query = `from=${new Date(base).toISOString()}&to=${new Date(base + 10 * MINUTE).toISOString()}`;
  return { base, query };
}

beforeAll(async () => {
  postgres = await startPostgres();
  setTestEnv(postgres.connectionString);
  const { buildApp } = await import('../../../apps/control-plane/src/app.js');
  app = buildApp({ eventPublisher: events });
  cookie = await signIn();
});

afterAll(async () => {
  await app.close();
  await postgres.stop();
});

describe('server metrics (A1, H1)', () => {
  it('returns CPU, RAM and disk series per aligned bucket plus uptime and connection state', async () => {
    const fx = await newFixture();
    const { base, query } = window();
    const lastSeen = new Date(base + 3 * MINUTE);
    await postgres.db.update(servers).set({ lastSeenAt: lastSeen }).where(eq(servers.id, fx.serverId));
    await addHost(fx.serverId, [
      { at: base + 5_000, cpu: 10, used: 400, disk: 40, uptime: 100 },
      { at: base + 35_000, cpu: 30, used: 600, disk: 42, uptime: 130 },
      { at: base + 2 * MINUTE + 10_000, cpu: null, used: 900, disk: 50, uptime: 230 },
      // Outside the window: never counted.
      { at: base + 10 * MINUTE, cpu: 99, used: 999, disk: 99, uptime: 700 },
      { at: base - 1, cpu: 99, used: 999, disk: 99, uptime: 99 },
    ]);

    const response = await call('GET', `/api/servers/${fx.serverId}/metrics?${query}`);
    expect(response.statusCode, response.raw).toBe(200);
    expect(Object.keys(response.body).sort()).toEqual(['series', 'server']);
    expect(seriesOf(response.body).map((series) => series.metric)).toEqual([
      'cpu_percent',
      'memory_used_bytes',
      'memory_percent',
      'disk_used_percent',
    ]);
    for (const series of seriesOf(response.body)) {
      expect(series).toMatchObject({
        scope: 'server',
        entityId: fx.serverId,
        intervalSeconds: 60,
        from: new Date(base).toISOString(),
        to: new Date(base + 10 * MINUTE).toISOString(),
      });
      expect(series.points).toHaveLength(10);
      expect(series.points.map((point) => point.t)).toEqual(
        Array.from({ length: 10 }, (_, i) => new Date(base + i * MINUTE).toISOString()),
      );
    }
    const nulls = (count: number): null[] => Array.from({ length: count }, () => null);
    // Gaps (bucket 1, buckets 3-9) are null; a bucket of only null CPU readings is null.
    expect(values(response.body, 'cpu_percent')).toEqual([20, null, null, ...nulls(7)]);
    expect(values(response.body, 'memory_used_bytes')).toEqual([500, null, 900, ...nulls(7)]);
    expect(values(response.body, 'memory_percent')).toEqual([50, null, 90, ...nulls(7)]);
    expect(values(response.body, 'disk_used_percent')).toEqual([41, null, 50, ...nulls(7)]);
    // Uptime and connection state come from the latest sample and the server row.
    expect(response.body.server).toEqual({
      serverId: fx.serverId,
      connectionState: 'CONNECTED',
      lastSeenAt: lastSeen.toISOString(),
      uptimeSeconds: 700,
      sampledAt: new Date(base + 10 * MINUTE).toISOString(),
    });

    // Deterministic: the same query returns the same series.
    const again = await call('GET', `/api/servers/${fx.serverId}/metrics?${query}`);
    expect(again.body.series).toEqual(response.body.series);
  });

  it('downsamples a long range to at most the requested points, default and max caps included', async () => {
    const fx = await newFixture();
    const now = Date.now();
    const rows: HostRow[] = [];
    for (let at = now - 24 * HOUR + MINUTE; at < now; at += 5 * MINUTE) rows.push({ at, cpu: 25, disk: 30 });
    await addHost(fx.serverId, rows);
    const from = new Date(now - 24 * HOUR).toISOString();
    const to = new Date(now).toISOString();

    const capped = await call('GET', `/api/servers/${fx.serverId}/metrics?from=${from}&to=${to}&points=50`);
    expect(capped.statusCode, capped.raw).toBe(200);
    for (const series of seriesOf(capped.body)) {
      expect(series.points.length).toBeLessThanOrEqual(50);
      expect(series.points.length).toBeGreaterThan(10);
      expect(Date.parse(series.from) % (series.intervalSeconds * 1000)).toBe(0);
    }
    expect(values(capped.body, 'cpu_percent').filter((v) => v !== null).every((v) => v === 25)).toBe(true);

    const byDefault = await call('GET', `/api/servers/${fx.serverId}/metrics?from=${from}&to=${to}`);
    expect(metric(byDefault.body, 'cpu_percent').points.length).toBeLessThanOrEqual(120);
    const max = await call('GET', `/api/servers/${fx.serverId}/metrics?from=${from}&to=${to}&points=500`);
    expect(metric(max.body, 'cpu_percent').points.length).toBeLessThanOrEqual(500);

    // No range: the last hour.
    const lastHour = await call('GET', `/api/servers/${fx.serverId}/metrics`);
    expect(lastHour.statusCode, lastHour.raw).toBe(200);
    // 60 aligned buckets, 61 unless `now - 1h` falls exactly on a minute.
    expect(metric(lastHour.body, 'cpu_percent').points.length).toBeGreaterThanOrEqual(60);
    expect(metric(lastHour.body, 'cpu_percent').points.length).toBeLessThanOrEqual(61);
  });

  it('an empty series is all nulls and a single sample is a single point', async () => {
    const fx = await newFixture();
    const { base, query } = window();
    const empty = await call('GET', `/api/servers/${fx.serverId}/metrics?${query}`);
    expect(empty.statusCode, empty.raw).toBe(200);
    for (const series of seriesOf(empty.body)) expect(series.points.every((point) => point.v === null)).toBe(true);
    expect(empty.body.server).toMatchObject({ uptimeSeconds: null, sampledAt: null, lastSeenAt: null });

    await addHost(fx.serverId, [{ at: base + 4 * MINUTE + 1, cpu: 7, disk: 12 }]);
    const single = await call('GET', `/api/servers/${fx.serverId}/metrics?${query}`);
    expect(values(single.body, 'cpu_percent')).toEqual([null, null, null, null, 7, null, null, null, null, null]);
  });
});

describe('service metrics (A1)', () => {
  it('returns CPU, memory and restarts; memory percent uses the limit, else the host total', async () => {
    const fx = await newFixture();
    const { base, query } = window();
    await addHost(fx.serverId, [{ at: Date.now() - MINUTE, total: 4000, used: 1000 }]);
    await addContainer(fx.serviceId, [
      { at: base + 1_000, cpu: 150, used: 200, limit: 1000, restarts: 1 },
      { at: base + 31_000, cpu: 50, used: 400, limit: 1000, restarts: 2 },
      { at: base + MINUTE + 1_000, cpu: null, used: null, restarts: 2 },
      { at: base + 3 * MINUTE, cpu: 10, used: 1000, limit: null, restarts: 4 },
    ]);
    const response = await call('GET', `/api/projects/${fx.projectId}/services/${fx.serviceId}/metrics?${query}`);
    expect(response.statusCode, response.raw).toBe(200);
    expect(Object.keys(response.body)).toEqual(['series']);
    expect(seriesOf(response.body).map((series) => series.metric)).toEqual([
      'cpu_percent',
      'memory_used_bytes',
      'memory_percent',
      'restart_count',
    ]);
    for (const series of seriesOf(response.body)) {
      expect(series).toMatchObject({ scope: 'service', entityId: fx.serviceId, intervalSeconds: 60 });
      expect(series.points).toHaveLength(10);
    }
    expect(values(response.body, 'cpu_percent').slice(0, 4)).toEqual([100, null, null, 10]);
    expect(values(response.body, 'memory_used_bytes').slice(0, 4)).toEqual([300, null, null, 1000]);
    expect(values(response.body, 'memory_percent').slice(0, 4)).toEqual([30, null, null, 25]);
    expect(values(response.body, 'restart_count').slice(0, 5)).toEqual([2, 2, null, 4, null]);
  });
});

describe('service status summary (A2)', () => {
  it('returns container state, restarts, healthcheck, last deployment, runtime status and threshold flags', async () => {
    const fx = await newFixture();
    const now = Date.now();
    await postgres.db.update(services).set({ status: 'RUNNING' }).where(eq(services.id, fx.serviceId));
    const id = containerId();
    await postgres.db.insert(containerObservations).values([
      { serviceId: fx.serviceId, containerId: id, observedAt: new Date(now - 10 * MINUTE), status: 'running', running: true },
      {
        serviceId: fx.serviceId,
        containerId: id,
        observedAt: new Date(now - 2 * MINUTE),
        status: 'running',
        running: true,
        restartCount: 3,
        health: 'unhealthy',
        healthExitCodes: [1, -1],
      },
      { serviceId: fx.serviceId, containerId: id, observedAt: new Date(now - MINUTE), parseError: 'CONTAINER_SAMPLE_MALFORMED' },
    ]);
    const finished = new Date(now - 30 * MINUTE);
    await postgres.db.insert(deployments).values([
      { serviceId: fx.serviceId, status: 'FAILED', source: { kind: 'image', imageRef: 'nginx:1.27' }, createdAt: new Date(now - 2 * HOUR) },
      {
        serviceId: fx.serviceId,
        status: 'SUCCESS',
        source: { kind: 'image', imageRef: 'nginx:1.27' },
        commitSha: 'abcdef1234567',
        createdAt: new Date(now - HOUR),
        completedAt: finished,
      },
    ]);
    // Three fresh readings at >= 90 % of the limit; a fresh host sample with a 95 % full disk.
    await addContainer(fx.serviceId, [
      { at: now - 3 * MINUTE, used: 950, limit: 1000 },
      { at: now - 2 * MINUTE, used: 900, limit: 1000 },
      { at: now - MINUTE, used: 990, limit: 1000 },
    ]);
    await addHost(fx.serverId, [
      { at: now - MINUTE, filesystems: [{ target: '/', sizeBytes: 100 * GIB, usedBytes: 95 * GIB, availBytes: 5 * GIB }] },
    ]);

    const response = await call('GET', `/api/projects/${fx.projectId}/services/${fx.serviceId}/status`);
    expect(response.statusCode, response.raw).toBe(200);
    const deployment = await postgres.db.select().from(deployments).where(eq(deployments.serviceId, fx.serviceId));
    const success = deployment.find((row) => row.status === 'SUCCESS');
    expect(success?.id).toBeDefined();
    expect(response.body).toEqual({
      serviceId: fx.serviceId,
      runtimeStatus: 'RUNNING',
      container: {
        state: 'running',
        restartCount: 3,
        healthcheck: 'timeout',
        observedAt: new Date(now - 2 * MINUTE).toISOString(),
      },
      lastDeployment: { id: success?.id, status: 'SUCCESS', commitSha: 'abcdef1234567', finishedAt: finished.toISOString() },
      flags: { highMemory: true, highDisk: true },
    });
  });

  it('a service with nothing observed has null container and deployment and no flags', async () => {
    const fx = await newFixture();
    const response = await call('GET', `/api/projects/${fx.projectId}/services/${fx.serviceId}/status`);
    expect(response.statusCode, response.raw).toBe(200);
    expect(response.body).toEqual({
      serviceId: fx.serviceId,
      runtimeStatus: 'NEVER_DEPLOYED',
      container: null,
      lastDeployment: null,
      flags: { highMemory: false, highDisk: false },
    });
  });

  it('flags need sustained, fresh readings: one spike or stale samples never flag', async () => {
    const fx = await newFixture();
    const now = Date.now();
    const full = [{ target: '/', sizeBytes: 100 * GIB, usedBytes: 99 * GIB, availBytes: 1 * GIB }];
    await addContainer(fx.serviceId, [
      { at: now - 3 * MINUTE, used: 100, limit: 1000 },
      { at: now - 2 * MINUTE, used: 100, limit: 1000 },
      { at: now - MINUTE, used: 999, limit: 1000 },
    ]);
    await addHost(fx.serverId, [{ at: now - HOUR, filesystems: full }]);
    const spike = await call('GET', `/api/projects/${fx.projectId}/services/${fx.serviceId}/status`);
    expect(spike.body.flags).toEqual({ highMemory: false, highDisk: false });

    const other = await newFixture();
    await addContainer(other.serviceId, [
      { at: now - 3 * HOUR, used: 999, limit: 1000 },
      { at: now - 2 * HOUR, used: 999, limit: 1000 },
      { at: now - HOUR, used: 999, limit: 1000 },
    ]);
    const stale = await call('GET', `/api/projects/${other.projectId}/services/${other.serviceId}/status`);
    expect(stale.body.flags).toEqual({ highMemory: false, highDisk: false });

    // An unlimited container is measured against the host total.
    const unlimited = await newFixture();
    await addHost(unlimited.serverId, [{ at: now - MINUTE, total: 1000, used: 950 }]);
    await addContainer(unlimited.serviceId, [
      { at: now - 3 * MINUTE, used: 920, limit: null },
      { at: now - 2 * MINUTE, used: 930, limit: null },
      { at: now - MINUTE, used: 940, limit: null },
    ]);
    const host = await call('GET', `/api/projects/${unlimited.projectId}/services/${unlimited.serviceId}/status`);
    expect(host.body.flags).toEqual({ highMemory: true, highDisk: false });
  });
});

describe('ownership and query validation (A3)', () => {
  it('a service is never read through another project id, and unknown ids are 404', async () => {
    const fx = await newFixture();
    const other = await newFixture();
    for (const path of ['metrics', 'status']) {
      const crossed = await call('GET', `/api/projects/${other.projectId}/services/${fx.serviceId}/${path}`);
      expect(crossed.statusCode, crossed.raw).toBe(404);
      expect(crossed.body.error).toBe('NOT_FOUND');
      const unknown = await call('GET', `/api/projects/${fx.projectId}/services/${randomUUID()}/${path}`);
      expect(unknown.statusCode).toBe(404);
    }
    const server = await call('GET', `/api/servers/${randomUUID()}/metrics`);
    expect(server.statusCode, server.raw).toBe(404);
    expect(server.body.error).toBe('NOT_FOUND');
  });

  it('malformed or out-of-retention ranges are named 400s with field issues', async () => {
    const fx = await newFixture();
    const now = Date.now();
    const iso = (ms: number): string => encodeURIComponent(new Date(ms).toISOString());
    const cases: [string, string][] = [
      ['from=yesterday', 'from'],
      ['to=2026-11-04', 'to'],
      ['points=0', 'points'],
      ['points=501', 'points'],
      ['points=abc', 'points'],
      [`from=${iso(now - HOUR)}&to=${iso(now - 2 * HOUR)}`, 'from'],
      [`from=${iso(now - 200 * HOUR)}&to=${iso(now - 199 * HOUR)}`, 'from'],
      [`from=${iso(now - 169 * HOUR)}&to=${iso(now)}`, 'to'],
      [`to=${iso(now + 2 * HOUR)}`, 'to'],
    ];
    for (const url of [`/api/servers/${fx.serverId}/metrics`, `/api/projects/${fx.projectId}/services/${fx.serviceId}/metrics`]) {
      for (const [query, path] of cases) {
        const response = await call('GET', `${url}?${query}`);
        expect(response.statusCode, `${query}: ${response.raw}`).toBe(400);
        expect(response.body.error).toBe('METRICS_QUERY_INVALID');
        expect((response.body.issues as { path: string }[]).map((issue) => issue.path)).toContain(path);
        // The submitted value is never echoed back.
        expect(response.raw).not.toContain('yesterday');
      }
      const unknownKey = await call('GET', `${url}?step=60`);
      expect(unknownKey.statusCode).toBe(400);
      expect(unknownKey.body.error).toBe('VALIDATION_FAILED');
    }
  });

  it('requires a session', async () => {
    const fx = await newFixture();
    const response = await app.inject({ method: 'GET', url: `/api/projects/${fx.projectId}/services/${fx.serviceId}/status` });
    expect(response.statusCode).toBe(401);
  });
});
