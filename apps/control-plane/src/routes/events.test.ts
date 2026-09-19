// T-4-02/T-5-02: RED for the SSE heartbeat's bounded `getSession` lookup. `api-scope.ts` wires
// `createEventsRoutes`'s `getSession` directly to the real Better Auth binding
// (`auth.api.getSession`), so — mirroring `require-session.test.ts`'s own precedent for the
// request-guard call site — this suite builds a bare Fastify instance and invokes
// `createEventsRoutes(deps)` directly, with a fake `SseBroadcaster` and a controllable
// `SessionResolver`, independent of the database/Redis/Better Auth stack.
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
