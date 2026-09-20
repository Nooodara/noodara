// T-4-02/T-5-02: RED for the SSE heartbeat's bounded `getSession` lookup. `api-scope.ts` wires
// `createEventsRoutes`'s `getSession` directly to the real Better Auth binding
// (`auth.api.getSession`), so — mirroring `require-session.test.ts`'s own precedent for the
// request-guard call site — this suite builds a bare Fastify instance and invokes
// `createEventsRoutes(deps)` directly, with a fake `SseBroadcaster` and a controllable
// `SessionResolver`, independent of the database/Redis/Better Auth stack.
import net from 'node:net';
import type { FastifyBaseLogger } from 'fastify';
import Fastify from 'fastify';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { SessionResolver } from '../auth/require-session.js';
import type { SseBroadcaster, SseStream } from '../events/sse-broadcaster.js';
import createEventsRoutes from './events.js';

function buildFakeBroadcaster(): SseBroadcaster & { readonly streams: Set<SseStream> } {
  const streams = new Set<SseStream>();
  return {
    get size() {
      return streams.size;
    },
    streams,
    add: (stream) => {
      streams.add(stream);
    },
    remove: (stream) => {
      streams.delete(stream);
    },
    start: () => Promise.resolve(),
    closeAll: () => Promise.resolve(),
  };
}

async function buildTestApp(getSession: SessionResolver, heartbeatMs: number) {
  const app = Fastify({ logger: false as unknown as FastifyBaseLogger });
  const broadcaster = buildFakeBroadcaster();
  await app.register(
    createEventsRoutes({ broadcaster, getSession, heartbeatMs, maxConnections: 10 }),
  );
  return { app, broadcaster };
}

let apps: { close(): Promise<void> }[] = [];

afterEach(async () => {
  await Promise.all(apps.map((app) => app.close()));
  apps = [];
  vi.useRealTimers();
});

describe('GET /api/events heartbeat session lookup (T-4-02)', () => {
  it('closes the SSE stream within roughly one heartbeat interval plus the lookup bound when getSession never settles', async () => {
    vi.useFakeTimers();
    const getSession: SessionResolver = () => new Promise(() => undefined);
    const { app } = await buildTestApp(getSession, 50);
    apps.push(app);

    const response = await app.inject({ method: 'GET', url: '/api/events', payloadAsStream: true });
    expect(response.statusCode).toBe(200);
    const stream = response.stream();

    let ended = false;
    stream.once('end', () => {
      ended = true;
    });
    stream.once('close', () => {
      ended = true;
    });
    stream.resume();

    // One heartbeat tick (50ms) triggers the bounded getSession call; the lookup itself never
    // settles, so the timeout bound (2000ms, SESSION_LOOKUP_TIMEOUT_MS) must fire before the
    // stream closes.
    await vi.advanceTimersByTimeAsync(50 + 2000 + 50);

    expect(ended).toBe(true);
  });
});

// Debug session sse-lost-event-race, round 2: every registered stream holds one of the capped SSE
// slots (D-07). The route learns that a peer left from a `close` listener it registers inside the
// handler -- but the guarded scope authorises the request first (an async session lookup), and a
// client that disconnects DURING that lookup has already emitted `close` by the time the handler
// runs. The listener then never fires and the slot is held until the process restarts. Observed
// against the real stack: 20 requests aborted ~1ms after being sent took the cap from 15 to 32/32
// and it never recovered.
describe('GET /api/events when the client disconnects before the handler runs', () => {
  it('never registers a stream for a peer that is already gone', async () => {
    const app = Fastify({ logger: false as unknown as FastifyBaseLogger });
    apps.push(app);
    const streams = new Set<SseStream>();
    let signalHandlerEntered: () => void = () => undefined;
    const handlerEntered = new Promise<void>((resolve) => {
      signalHandlerEntered = resolve;
    });
    const broadcaster: SseBroadcaster = {
      get size() {
        return streams.size;
      },
      add: (stream) => {
        streams.add(stream);
      },
      remove: (stream) => {
        streams.delete(stream);
      },
      start: () => Promise.resolve(),
      closeAll: () => Promise.resolve(),
    };
    let signalRequestArrived: () => void = () => undefined;
    const requestArrived = new Promise<void>((resolve) => {
      signalRequestArrived = resolve;
    });
    // Stands in for the guarded scope's session lookup: it settles only once the peer has gone.
    app.addHook('onRequest', async (request) => {
      const peerGone = new Promise<void>((resolve) => {
        request.raw.socket.once('close', () => {
          resolve();
        });
      });
      signalRequestArrived();
      await peerGone;
    });
    // The last hook before the handler. Callback-style, so Fastify calls the (synchronous)
    // handler from inside `done()` -- anything awaiting `handlerEntered` only resumes once the
    // handler has run to completion, whatever the handler itself does.
    app.addHook('preHandler', (_request, _reply, done) => {
      signalHandlerEntered();
      done();
    });
    await app.register(
      createEventsRoutes({
        broadcaster,
        getSession: () => Promise.resolve(null),
        heartbeatMs: 60_000,
        maxConnections: 10,
      }),
    );
    await app.listen({ port: 0, host: '127.0.0.1' });
    const address = app.server.address();
    if (address === null || typeof address === 'string') throw new Error('no TCP address');

    const client = net.connect(address.port, '127.0.0.1');
    client.on('error', () => undefined);
    client.write('GET /api/events HTTP/1.1\r\nHost: 127.0.0.1\r\n\r\n');
    await requestArrived;
    client.destroy();
    await handlerEntered;

    expect(streams.size).toBe(0);
  });
});
