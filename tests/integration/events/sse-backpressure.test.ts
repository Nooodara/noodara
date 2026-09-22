// WR-A-03 / T-5G-34-01 (05-34): a peer that opens `GET /api/events` and then never reads holds
// one of the D-07 capped slots forever today -- writes into `reply.raw` succeed into the kernel
// buffer and the only eviction trigger is `request.raw.on('close')`, which a half-open/non-
// reading peer never fires. This drives the real route over a genuine TCP socket (never
// `app.inject()`, which pipes every write straight into a null sink that always drains
// immediately -- see `node_modules/light-my-request`'s `Response.prototype.write` -- and so can
// never reproduce backpressure) with a client that stops reading right after the headers, then
// publishes real `server.deleted` events through the real Redis-backed broadcaster until the
// budget is exceeded, and proves the freed slot lets a fresh client connect.
import { randomBytes, randomUUID } from 'node:crypto';
import net from 'node:net';
import { Redis } from 'ioredis';
import { afterEach, describe, expect, it } from 'vitest';
import { SERVER_EVENTS_CHANNEL } from '../../../apps/control-plane/src/events/redis-server-event-publisher.js';
import { issueToken } from '../../../apps/control-plane/src/services/setup-token-repository.js';
import { revealSecret } from '@noodara/domain/security';
import { startPostgres, type PostgresFixture } from '../helpers/postgres.js';
import { startRedis, type RedisFixture } from '../helpers/redis.js';

const ADMIN_EMAIL = 'admin@noodara.test';
const ADMIN_PASSWORD = 'correct horse battery staple';
// Cap deliberately small (env.ts's own floor is 1) so a handful of concurrently leaked peers can
// genuinely fill it in a bounded test, without waiting on the real production default (32).
const MAX_CONNECTIONS = 3;

interface AppFixture {
  readonly app: import('fastify').FastifyInstance;
  readonly port: number;
  stop(): Promise<void>;
}

let postgres: PostgresFixture | undefined;
let redis: RedisFixture | undefined;
let fixture: AppFixture | undefined;
const rawClients: net.Socket[] = [];
const redisConnections: Redis[] = [];

afterEach(async () => {
  for (const socket of rawClients.splice(0)) socket.destroy();
  for (const connection of redisConnections.splice(0)) connection.disconnect();
  await fixture?.stop();
  fixture = undefined;
  await postgres?.stop();
  postgres = undefined;
  await redis?.stop();
  redis = undefined;

  const { getContainerRuntimeClient } = await import('testcontainers');
  const client = await getContainerRuntimeClient();
  const runtimeClient = await client.container.list();
  const stray = runtimeClient.filter((c) => c.Labels['noodara.test'] === 'true');
  expect(stray).toHaveLength(0);
});

/** Boots the real app on a real TCP port (never `app.inject()` -- see file header) with a small,
 *  deterministic connection cap. Mirrors `tests/integration/routes/events-sse.test.ts`'s own
 *  `startAppWithHeartbeat`, plus an actual `listen()` this plan's tests need. */
async function startAppOnRealSocket(): Promise<AppFixture> {
  postgres = await startPostgres();
  process.env.NOODARA_MASTER_KEY = randomBytes(32).toString('base64');
  process.env.BETTER_AUTH_SECRET = `test-fixture-${randomUUID()}-${randomUUID()}`;
  process.env.DATABASE_URL = postgres.connectionString;
  process.env.REDIS_URL = redis?.connectionUrl ?? 'redis://localhost:6379';
  process.env.NOODARA_PUBLIC_URL = 'http://localhost:3000';
  process.env.NOODARA_SSE_MAX_CONNECTIONS = String(MAX_CONNECTIONS);

  const { buildApp } = await import('../../../apps/control-plane/src/app.js');
  const app = buildApp();
  await app.listen({ port: 0, host: '127.0.0.1' });
  const address = app.server.address();
  if (address === null || typeof address === 'string') throw new Error('no TCP address');

  // Test-harness-only: shrinks every accepted server-side socket's kernel send buffer so this
  // machine's own TCP autotuning (macOS defaults up to several MiB, `net.inet.tcp.autosndbufmax`)
  // cannot silently absorb megabytes of published data before the application-level budget under
  // test is ever exercised. Product code is untouched -- this only affects how quickly *this
  // test* converges, never affects `events.ts`'s own behaviour.
  app.server.on('connection', (socket) => {
    try {
      socket.setSendBufferSize(16 * 1024);
    } catch {
      // Not supported on this platform/socket type -- the test still converges, just slower.
    }
  });

  return {
    app,
    port: address.port,
    stop: async () => {
      delete process.env.NOODARA_SSE_MAX_CONNECTIONS;
      await app.close();
    },
  };
}

async function createAdminAndCookie(app: import('fastify').FastifyInstance, db: PostgresFixture['db']): Promise<string> {
  const issued = await issueToken(db, 'setup', new Date());
  const setupResponse = await app.inject({
    method: 'POST',
    url: '/api/setup',
    payload: { token: revealSecret(issued.token), email: ADMIN_EMAIL, password: ADMIN_PASSWORD, name: 'Admin' },
  });
  if (setupResponse.statusCode !== 200) {
    throw new Error(`setup failed: ${setupResponse.statusCode.toString()} ${setupResponse.body}`);
  }
  const signInResponse = await app.inject({
    method: 'POST',
    url: '/api/auth/sign-in/email',
    payload: { email: ADMIN_EMAIL, password: ADMIN_PASSWORD },
  });
  if (signInResponse.statusCode !== 200) {
    throw new Error(`sign-in failed: ${signInResponse.statusCode.toString()} ${signInResponse.body}`);
  }
  const raw = signInResponse.headers['set-cookie'];
  const rawCookies = Array.isArray(raw) ? raw : raw !== undefined ? [String(raw)] : [];
  const { default: parseSetCookie } = await import('set-cookie-parser');
  return parseSetCookie
    .parse(rawCookies, { map: false })
    .map((cookie) => `${cookie.name}=${cookie.value}`)
    .join('; ');
}

/** Opens a raw TCP connection to `GET /api/events`, reads until the response headers are fully
 *  received (proof the handler hijacked and registered the stream), then -- unlike every other
 *  SSE test in this repo -- STOPS reading entirely. Node never drains a paused socket's kernel
 *  receive buffer, so the server's own writes eventually cannot flush either: this is exactly the
 *  "alive but not reading" peer WR-A-03 describes, produced with a real socket, no mocks. */
async function openLeakyPeer(port: number, cookie: string): Promise<net.Socket> {
  const socket = net.connect(port, '127.0.0.1');
  rawClients.push(socket);
  socket.on('error', () => undefined); // an eventual reset is expected once the server evicts it
  try {
    // Same test-harness-only rationale as the server-side `setSendBufferSize` above: caps this
    // machine's own TCP autotuning on the receiving end too, so the test converges on genuine
    // publish volume, not on how large this host happens to autotune its kernel buffers.
    socket.setRecvBufferSize(16 * 1024);
  } catch {
    // Not supported on this platform/socket type -- the test still converges, just slower.
  }
  socket.write(
    `GET /api/events HTTP/1.1\r\nHost: 127.0.0.1\r\nCookie: ${cookie}\r\nConnection: keep-alive\r\n\r\n`,
  );

  await new Promise<void>((resolve, reject) => {
    let buffered = '';
    const onData = (chunk: Buffer): void => {
      buffered += chunk.toString('utf8');
      if (buffered.includes('\r\n\r\n')) {
        socket.off('data', onData);
        // Deliberately never resumed, never read again from this point on -- the peer under test.
        socket.pause();
        resolve();
      }
    };
    socket.on('data', onData);
    socket.once('error', reject);
    setTimeout(() => {
      reject(new Error('timed out waiting for /api/events response headers'));
    }, 5000);
  });

  return socket;
}

/** A well-behaved probe: opens, reads the first frame (proving 200, not 503), then disconnects
 *  cleanly. Used both to assert the cap is genuinely full and, after recovery, that it is not. */
async function probeConnects(port: number, cookie: string): Promise<boolean> {
  const socket = net.connect(port, '127.0.0.1');
  socket.on('error', () => undefined);
  socket.write(
    `GET /api/events HTTP/1.1\r\nHost: 127.0.0.1\r\nCookie: ${cookie}\r\nConnection: keep-alive\r\n\r\n`,
  );
  try {
    const statusLine = await new Promise<string>((resolve, reject) => {
      let buffered = '';
      const onData = (chunk: Buffer): void => {
        buffered += chunk.toString('utf8');
        const headerEnd = buffered.indexOf('\r\n');
        if (headerEnd !== -1) {
          socket.off('data', onData);
          resolve(buffered.slice(0, headerEnd));
        }
      };
      socket.on('data', onData);
      socket.once('error', reject);
      setTimeout(() => {
        reject(new Error('timed out waiting for probe response status line'));
      }, 5000);
    });
    return statusLine.includes(' 200 ');
  } finally {
    socket.destroy();
  }
}

/** Publishes a batch of small, real `server.deleted` events through the real Redis-backed
 *  broadcaster -- the same fan-out path a real worker uses -- so every registered leaky peer's
 *  `reply.raw` buffer grows by the same amount on every call. */
async function publishBatch(publisher: Redis, count: number): Promise<void> {
  const pipeline = publisher.pipeline();
  for (let i = 0; i < count; i += 1) {
    const payload = JSON.stringify({ type: 'server.deleted', id: `backpressure-probe-${randomUUID()}` });
    pipeline.publish(SERVER_EVENTS_CHANNEL, payload);
  }
  await pipeline.exec();
}

describe('GET /api/events backpressure budget (WR-A-03, T-5G-34-01)', () => {
  it(
    'evicts a peer that stops reading once its buffered writes exceed the budget, freeing its slot for a fresh client',
    async () => {
      redis = await startRedis();
      fixture = await startAppOnRealSocket();
      if (!postgres) throw new Error('postgres fixture not set');
      const cookie = await createAdminAndCookie(fixture.app, postgres.db);

      // Fill the (small, test-only) cap entirely with leaky peers -- proves the cap is enforced
      // before any eviction happens, and gives the eviction step real slots to recover.
      for (let i = 0; i < MAX_CONNECTIONS; i += 1) {
        await openLeakyPeer(fixture.port, cookie);
      }
      const rejectedAtCap = await probeConnects(fixture.port, cookie);
      expect(rejectedAtCap).toBe(false);

      const publisher = new Redis(redis.connectionUrl, { commandTimeout: 5000 });
      redisConnections.push(publisher);

      // Bounded by data volume, never by a fixed sleep (hard_rules #8): publish in batches and
      // re-probe after each one, up to a generous ceiling that comfortably exceeds both the 1 MiB
      // application-level budget and the shrunk-but-nonzero socket buffers on top of it. Measured
      // on macOS: ~124 buffered bytes land per published event, so >8500 events cross the 1 MiB
      // budget and 24000 was a wide margin there. The first real CI run (Linux, ubuntu-latest)
      // did NOT converge within 24000 events: Linux's kernel buffers absorb more before Node's own
      // writableLength grows (SO_SNDBUF/SO_RCVBUF are doubled and floored by the kernel, and the
      // caps above are best-effort). The ceiling is therefore raised to 120000 events (~14 MiB
      // per peer); 80 batches took ~5 s on that runner, so 400 stay well inside the 60 s timeout.
      const BATCH_SIZE = 300;
      const MAX_BATCHES = 400; // up to 120000 events, ~124 buffered bytes each => ~14 MiB
      let recovered = false;
      for (let batch = 0; batch < MAX_BATCHES && !recovered; batch += 1) {
        await publishBatch(publisher, BATCH_SIZE);
        recovered = await probeConnects(fixture.port, cookie);
      }

      expect(recovered).toBe(true);
    },
    60_000,
  );
});
