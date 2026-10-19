// 20-03 (H1): webhook receiver abuse cases over a real socket (not inject) and a migrated Postgres.
// Oversized bodies (declared or chunked) end 413 and slow bodies are cut by the request timeout,
// in both cases before the ingest runs: no delivery row is recorded. The signature check never
// exits early on a matching prefix: every wrong digest, whatever prefix it shares with the right
// one, goes through exactly one full-length timingSafeEqual, and the measured verify time does
// not grow with the prefix. The replayed-push case (new delivery id, already deployed SHA) needs a
// real deploy and lives in canary-deploy.test.ts. The deploy queue is a recording fake.
import { createHmac, randomBytes, randomUUID } from 'node:crypto';
import net from 'node:net';
import type { AddressInfo } from 'node:net';
import { eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import parseSetCookie from 'set-cookie-parser';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { webhookDeliveries } from '../../../apps/control-plane/src/db/schema/webhook-deliveries.js';
import { noopServerEventPublisher } from '../../../apps/control-plane/src/events/server-event-publisher.js';
import type { DeployQueue } from '../../../apps/control-plane/src/queue/deploy-queue.js';
import { startPostgres, type PostgresFixture } from '../helpers/postgres.js';

// Wraps node:crypto's timingSafeEqual so the test sees every comparison the receiver makes.
const compareSpy = vi.hoisted(() => ({ calls: [] as [number, number][] }));
vi.mock('node:crypto', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:crypto')>();
  const timingSafeEqual = (a: NodeJS.ArrayBufferView, b: NodeJS.ArrayBufferView): boolean => {
    compareSpy.calls.push([a.byteLength, b.byteLength]);
    return actual.timingSafeEqual(a, b);
  };
  return { ...actual, default: { ...actual, timingSafeEqual }, timingSafeEqual };
});

type Json = Record<string, unknown>;
type IngestModule = typeof import('../../../apps/control-plane/src/services/webhook-ingest.js');

const ADMIN_EMAIL = 'admin@noodara.test';
const ADMIN_PASSWORD = 'correct horse battery staple';
const PUBLIC_URL = 'http://noodara.example.test:3000';
const REPO = 'https://github.com/acme/api.git';
/** The receiver must cut a request body still incomplete after this long (fixed request timeout). */
const SLOW_BODY_CUT_MS = 30_000;
/** Slack over SLOW_BODY_CUT_MS before the test calls the body accepted. */
const SLOW_BODY_DEADLINE_MS = SLOW_BODY_CUT_MS + 15_000;
const DRIP_INTERVAL_MS = 1_000;

let postgres: PostgresFixture;
let app: FastifyInstance;
let port = 0;
let cookie = '';
let ingestModule: IngestModule;
let ingestCalls = 0;

const queue: DeployQueue = {
  enqueue: (payload) => Promise.resolve({ ok: true, jobId: payload.deploymentId }),
  removeJob: () => Promise.resolve(false),
  isJobPending: () => Promise.resolve(false),
  close: () => Promise.resolve(),
};
const stubBroadcaster = { start: () => Promise.resolve(), stop: () => Promise.resolve(), closeAll: () => Promise.resolve() };

function cookieHeaderFrom(response: { headers: Record<string, unknown> }): string {
  const raw = response.headers['set-cookie'];
  const rawCookies = Array.isArray(raw) ? (raw as string[]) : raw !== undefined ? [String(raw)] : [];
  return parseSetCookie
    .parse(rawCookies, { map: false })
    .map((entry) => `${entry.name}=${entry.value}`)
    .join('; ');
}

async function api(method: 'POST', url: string, payload?: Json): Promise<{ statusCode: number; body: Json }> {
  const response = await app.inject({ method, url, headers: { cookie }, ...(payload !== undefined ? { payload } : {}) });
  return { statusCode: response.statusCode, body: (response.body.length > 0 ? response.json() : {}) as Json };
}

function short(): string {
  return randomUUID().replace(/-/g, '').slice(0, 10);
}

/** A project, environment, connected server and git service with its webhook enabled. */
async function hookedService(): Promise<{ serviceId: string; hookId: string; secret: string }> {
  const project = await api('POST', '/api/projects', { name: `Abuse ${short()}` });
  expect(project.statusCode).toBe(201);
  const projectId = String(project.body.id);
  const environment = await api('POST', `/api/projects/${projectId}/environments`, { name: 'production' });
  const server = await api('POST', '/api/servers', {
    name: `srv-${short()}`,
    host: `${short()}.example.test`,
    credential: { type: 'ssh_password', password: 'not-used-by-this-test' },
  });
  expect(server.statusCode).toBe(201);
  const { servers } = await import('../../../apps/control-plane/src/db/schema/servers.js');
  await postgres.db
    .update(servers)
    .set({ status: 'CONNECTED', dockerInstalled: true, dockerBuildkitAvailable: true })
    .where(eq(servers.id, String(server.body.id)));
  const service = await api('POST', `/api/projects/${projectId}/services`, {
    environmentId: String(environment.body.id),
    serverId: String(server.body.id),
    name: `svc-${short()}`,
    source: { kind: 'git', repositoryUrl: REPO, branch: 'main' },
    internalPort: 8080,
  });
  expect(service.statusCode).toBe(201);
  const serviceId = String(service.body.id);
  const enabled = await api('POST', `/api/projects/${projectId}/services/${serviceId}/webhook`);
  expect(enabled.statusCode).toBe(200);
  const hookId = String(enabled.body.payloadUrl).slice(`${PUBLIC_URL}/webhooks/github/`.length);
  return { serviceId, hookId, secret: String(enabled.body.secret) };
}

function pushBody(sha: string): string {
  return JSON.stringify({
    ref: 'refs/heads/main',
    after: sha,
    deleted: false,
    repository: { clone_url: REPO, ssh_url: 'git@github.com:acme/api.git' },
    head_commit: { id: sha },
  });
}

function sign(body: string | Buffer, secret: string): string {
  return `sha256=${createHmac('sha256', secret).update(body).digest('hex')}`;
}

interface RawExchange {
  /** The first response line, or null when the server closed without answering. */
  readonly statusLine: string | null;
  /** True when the server ended the connection before the deadline. */
  readonly closedByServer: boolean;
  readonly elapsedMs: number;
}

/**
 * Speaks HTTP/1.1 on a raw socket: `head` goes out at once, then `drip` is called every
 * DRIP_INTERVAL_MS with the socket until it returns false. Resolves when the server answers or
 * closes, or at `deadlineMs` (then the client closes and `closedByServer` is false).
 */
function rawExchange(head: string, drip: (socket: net.Socket, tick: number) => boolean, deadlineMs: number): Promise<RawExchange> {
  return new Promise((resolve) => {
    const started = Date.now();
    const socket = net.connect(port, '127.0.0.1');
    let response = '';
    let settled = false;
    let tick = 0;
    const finish = (closedByServer: boolean): void => {
      if (settled) return;
      settled = true;
      clearInterval(timer);
      clearTimeout(deadline);
      socket.destroy();
      const line = response.split('\r\n')[0] ?? '';
      resolve({ statusLine: line === '' ? null : line, closedByServer, elapsedMs: Date.now() - started });
    };
    const timer = setInterval(() => {
      if (socket.destroyed || !drip(socket, tick)) clearInterval(timer);
      tick += 1;
    }, DRIP_INTERVAL_MS);
    const deadline = setTimeout(() => {
      finish(false);
    }, deadlineMs);
    socket.setEncoding('utf8');
    socket.on('data', (chunk: string) => {
      response += chunk;
      if (response.includes('\r\n\r\n')) finish(true);
    });
    socket.on('end', () => {
      finish(true);
    });
    socket.on('close', () => {
      finish(true);
    });
    socket.on('error', () => {
      finish(true);
    });
    socket.write(head);
  });
}

function requestHead(hookId: string, extra: Record<string, string>): string {
  const headers = {
    host: '127.0.0.1',
    'content-type': 'application/json',
    'x-github-event': 'push',
    'x-github-delivery': randomUUID(),
    'user-agent': 'GitHub-Hookshot/abc123',
    ...extra,
  };
  return `POST /webhooks/github/${hookId} HTTP/1.1\r\n${Object.entries(headers)
    .map(([name, value]) => `${name}: ${value}\r\n`)
    .join('')}\r\n`;
}

async function deliveriesOf(serviceId: string) {
  return postgres.db.select().from(webhookDeliveries).where(eq(webhookDeliveries.serviceId, serviceId));
}

beforeAll(async () => {
  postgres = await startPostgres();
  process.env.NOODARA_MASTER_KEY = randomBytes(32).toString('base64');
  process.env.BETTER_AUTH_SECRET = `webhook-abuse-${randomUUID()}-${randomUUID()}`;
  process.env.DATABASE_URL = postgres.connectionString;
  process.env.REDIS_URL = 'redis://localhost:6379';
  process.env.NOODARA_PUBLIC_URL = PUBLIC_URL;
  ingestModule = await import('../../../apps/control-plane/src/services/webhook-ingest.js');
  const { createLogger, writableForTests } = await import('../../../apps/control-plane/src/logger.js');
  const { buildApp } = await import('../../../apps/control-plane/src/app.js');
  const realIngest = ingestModule.createWebhookIngest({
    db: postgres.db,
    now: () => new Date(),
    events: noopServerEventPublisher,
    queue,
    masterKeys: () => Promise.resolve({ current: Buffer.from(process.env.NOODARA_MASTER_KEY ?? '', 'base64') }),
    failUnqueued: () => Promise.resolve(),
    logger: { info: () => undefined, warn: () => undefined, error: () => undefined },
  });
  app = buildApp({
    eventPublisher: noopServerEventPublisher,
    broadcaster: stubBroadcaster as never,
    deployQueue: queue,
    webhookIngest: {
      ingest: (input) => {
        ingestCalls += 1;
        return realIngest.ingest(input);
      },
    },
    webhookRateLimits: { perHook: { limit: 1000, windowMs: 60_000 }, perIp: { limit: 10_000, windowMs: 60_000 }, maxKeys: 1000 },
    logger: createLogger({ level: 'info', destination: writableForTests().stream }) as unknown as FastifyInstance['log'],
  });
  await app.listen({ port: 0, host: '127.0.0.1' });
  port = (app.server.address() as AddressInfo).port;

  const { issueToken } = await import('../../../apps/control-plane/src/services/setup-token-repository.js');
  const { revealSecret } = await import('@noodara/domain/security');
  const issued = await issueToken(postgres.db, 'setup', new Date());
  const setup = await app.inject({
    method: 'POST',
    url: '/api/setup',
    payload: { token: revealSecret(issued.token), email: ADMIN_EMAIL, password: ADMIN_PASSWORD, name: 'Admin' },
  });
  if (setup.statusCode !== 200) throw new Error(`setup failed: ${String(setup.statusCode)}`);
  const signIn = await app.inject({
    method: 'POST',
    url: '/api/auth/sign-in/email',
    payload: { email: ADMIN_EMAIL, password: ADMIN_PASSWORD },
  });
  if (signIn.statusCode !== 200) throw new Error(`sign-in failed: ${String(signIn.statusCode)}`);
  cookie = cookieHeaderFrom(signIn);
}, 180_000);

afterAll(async () => {
  await app.close();
  await postgres.stop();
});

describe('20-03 H1: webhook receiver abuse over a real socket', () => {
  it('the socket path works: a signed push over raw HTTP is recorded (control for the cases below)', async () => {
    const hook = await hookedService();
    const body = pushBody(randomBytes(20).toString('hex'));
    const exchange = await rawExchange(
      requestHead(hook.hookId, { 'content-length': String(Buffer.byteLength(body)), 'x-hub-signature-256': sign(body, hook.secret), connection: 'close' }) + body,
      () => false,
      20_000,
    );
    expect(exchange.statusLine).toMatch(/^HTTP\/1\.1 202 /);
    expect((await deliveriesOf(hook.serviceId)).map((row) => row.outcome)).toEqual(['deployed']);
  });

  it('a declared body over 1 MiB is 413 before a byte of it is read, and records nothing', async () => {
    const hook = await hookedService();
    const before = ingestCalls;
    const size = ingestModule.WEBHOOK_BODY_LIMIT_BYTES + 1;
    const exchange = await rawExchange(
      requestHead(hook.hookId, { 'content-length': String(size), 'x-hub-signature-256': `sha256=${'0'.repeat(64)}` }),
      () => false,
      20_000,
    );
    expect(exchange.statusLine).toMatch(/^HTTP\/1\.1 413 /);
    expect(ingestCalls).toBe(before);
    expect(await deliveriesOf(hook.serviceId)).toEqual([]);
  });

  it('a chunked body that grows past 1 MiB is cut with 413 at the cap, and records nothing', async () => {
    const hook = await hookedService();
    const before = ingestCalls;
    const chunk = Buffer.alloc(256 * 1024, 0x20).toString('latin1');
    let sentBytes = 0;
    const exchange = await rawExchange(
      requestHead(hook.hookId, { 'transfer-encoding': 'chunked', 'x-hub-signature-256': `sha256=${'0'.repeat(64)}` }),
      (socket) => {
        // Up to 8 MiB, far past the cap; the server must answer long before the end.
        if (sentBytes >= 8 * 1024 * 1024) return false;
        socket.write(`${chunk.length.toString(16)}\r\n${chunk}\r\n`);
        sentBytes += chunk.length;
        return true;
      },
      60_000,
    );
    expect(exchange.statusLine).toMatch(/^HTTP\/1\.1 413 /);
    expect(sentBytes).toBeLessThan(8 * 1024 * 1024);
    expect(ingestCalls).toBe(before);
    expect(await deliveriesOf(hook.serviceId)).toEqual([]);
  });

  it(
    'a slow body (one byte a second, never complete) is cut by the request timeout and records nothing',
    async () => {
      const hook = await hookedService();
      const before = ingestCalls;
      const body = pushBody(randomBytes(20).toString('hex'));
      const exchange = await rawExchange(
        requestHead(hook.hookId, { 'content-length': String(Buffer.byteLength(body)), 'x-hub-signature-256': sign(body, hook.secret) }),
        (socket, tick) => {
          // Stays one byte short of the declared length, so only a timeout can end the request.
          if (tick >= body.length - 1) return false;
          socket.write(body.charAt(tick));
          return true;
        },
        SLOW_BODY_DEADLINE_MS,
      );
      expect(exchange.closedByServer, 'the receiver held a slow body open past its request timeout').toBe(true);
      if (exchange.statusLine !== null) expect(exchange.statusLine).toMatch(/^HTTP\/1\.1 408 /);
      expect(exchange.elapsedMs).toBeGreaterThanOrEqual(SLOW_BODY_CUT_MS - 1_000);
      expect(ingestCalls).toBe(before);
      expect(await deliveriesOf(hook.serviceId)).toEqual([]);
    },
    SLOW_BODY_DEADLINE_MS + 30_000,
  );

  it('a wrong digest sharing any prefix with the right one goes through one full-length timingSafeEqual', () => {
    const secret = randomBytes(32).toString('hex');
    const body = Buffer.from(pushBody(randomBytes(20).toString('hex')));
    const right = createHmac('sha256', secret).update(body).digest();
    for (let prefix = 0; prefix <= right.length; prefix += 1) {
      const candidate = Buffer.from(right);
      if (prefix < right.length) candidate[prefix] = (candidate[prefix] ?? 0) ^ 0xff;
      compareSpy.calls.length = 0;
      const verified = ingestModule.verifyGithubSignature(secret, body, `sha256=${candidate.toString('hex')}`);
      expect({ prefix, verified }).toEqual({ prefix, verified: prefix === right.length });
      expect(compareSpy.calls, `prefix ${String(prefix)}`).toEqual([[32, 32]]);
    }
  });

  it('the verify time does not grow with the length of the matching prefix', () => {
    const secret = randomBytes(32).toString('hex');
    const body = Buffer.from(pushBody(randomBytes(20).toString('hex')));
    const right = createHmac('sha256', secret).update(body).digest();
    const wrongAt = (index: number): string => {
      const candidate = Buffer.from(right);
      candidate[index] = (candidate[index] ?? 0) ^ 0xff;
      return `sha256=${candidate.toString('hex')}`;
    };
    const candidates = { none: wrongAt(0), half: wrongAt(16), all: wrongAt(31) };
    const BATCH = 200;
    const ROUNDS = 60;
    const samples: Record<keyof typeof candidates, number[]> = { none: [], half: [], all: [] };
    const time = (header: string): number => {
      const start = process.hrtime.bigint();
      for (let i = 0; i < BATCH; i += 1) ingestModule.verifyGithubSignature(secret, body, header);
      return Number(process.hrtime.bigint() - start);
    };
    for (const header of Object.values(candidates)) time(header); // warm-up
    for (let round = 0; round < ROUNDS; round += 1) {
      // Interleaved, rotating order: drift and GC pauses hit every candidate alike.
      const order = (['none', 'half', 'all'] as const).map((_, i, all) => all[(i + round) % all.length] ?? 'none');
      for (const key of order) samples[key].push(time(candidates[key]));
    }
    const median = (values: number[]): number => {
      const sorted = [...values].sort((a, b) => a - b);
      return sorted[Math.floor(sorted.length / 2)] ?? 0;
    };
    const base = median(samples.none);
    expect(base).toBeGreaterThan(0);
    for (const key of ['half', 'all'] as const) {
      const ratio = median(samples[key]) / base;
      expect({ key, withinBand: ratio > 0.67 && ratio < 1.5 }, `ratio ${ratio.toFixed(3)}`).toEqual({ key, withinBand: true });
    }
  });
});
