// D-01/D-05/D-06/D-07/T-4-01/T-4-02/T-4-06: `GET /api/events` — the one global SSE stream. No
// `withTypeProvider<ZodTypeProvider>()` here (no analog in this codebase, RESEARCH.md Pattern 3):
// the 200 path hijacks the reply and writes raw `reply.raw` frames for the rest of the
// connection's life, so a declared Zod `response` schema would never apply past the first write.
// Session authentication at *open* time is already done by `requireSession`'s `onRequest` hook on
// this same guarded scope (`routes/api-scope.ts`) — this file only adds the D-06 *periodic*
// re-validation a one-shot guard hook cannot provide for a connection that outlives its own
// request.
import type { FastifyPluginCallback } from 'fastify';
import { toFetchHeaders } from '../auth/fetch-headers.js';
import type { SessionResolver } from '../auth/require-session.js';
import { withSessionLookupTimeout } from '../auth/session-lookup.js';
import type { SseBroadcaster, SseStream } from '../events/sse-broadcaster.js';
import { toErrorBody } from './http-errors.js';

export interface EventsRoutesDeps {
  readonly broadcaster: SseBroadcaster;
  readonly getSession: SessionResolver;
  /** Defaults to 15s in production (D-05); overridden in tests so the keepalive/revocation
   *  assertions do not wait 15 seconds. */
  readonly heartbeatMs?: number;
  readonly maxConnections: number;
}

const DEFAULT_HEARTBEAT_MS = 15_000;
const RETRY_FIELD = 'retry: 5000\n\n';

// T-5G-34-01/WR-A-03: a peer that stops reading (half-open, TCP zero-window, or simply a client
// that never drains) must not hold one of the D-07 capped slots until Linux's own TCP
// retransmission gives up (`tcp_retries2`, ~15 minutes by default) or forever. 1 MiB is a
// deliberately generous per-connection ceiling: a single `ServerView` SSE frame is a few hundred
// bytes and even a `server.discovery_progress` burst is a handful of frames in quick succession,
// so no draining-but-briefly-slow client is ever evicted for ordinary jitter -- but a genuinely
// stuck peer's buffer is now bounded, and the worst case across the whole D-07 connection cap
// stays a bounded, single-digit number of MiB instead of growing without limit.
export const SSE_MAX_BUFFERED_BYTES = 1_048_576;

/** The pure decision the backpressure guard makes, exported so it is unit-testable without a real
 *  socket -- a genuinely half-open/never-reading peer is proven at the integration level in
 *  `tests/integration/events/sse-backpressure.test.ts` (`app.inject()` cannot reproduce real
 *  backpressure: its mocked response writes into a null sink that always drains immediately). */
export function exceedsBackpressureBudget(bufferedBytes: number): boolean {
  return bufferedBytes > SSE_MAX_BUFFERED_BYTES;
}

/**
 * Builds the `GET /api/events` plugin. A factory (not a bare plugin) because the route needs the
 * broadcaster, the session resolver, the configured heartbeat interval and the SSE connection
 * cap injected — exactly the shape `routes/api-scope.ts` (Plan 04-04's guarded scope) already
 * uses for `createRequireSession`.
 */
export default function createEventsRoutes(deps: EventsRoutesDeps): FastifyPluginCallback {
  const heartbeatMs = deps.heartbeatMs ?? DEFAULT_HEARTBEAT_MS;

  const eventsRoutes: FastifyPluginCallback = (fastify, _opts, done) => {
    fastify.get('/api/events', (request, reply) => {
      // The guarded scope authorises the request (an async session lookup) before this handler
      // runs. A peer that disconnected in the meantime has ALREADY emitted `close`, so the
      // listener registered at the bottom of this handler would never fire and the stream would
      // hold one of the capped slots below until the process restarts. Nothing between this check
      // and that listener awaits, so there is no window left between them.
      if (request.raw.destroyed || request.raw.socket.destroyed) {
        return;
      }

      // D-07: checked *before* hijacking, so exceeding the limit is an ordinary JSON response,
      // never a half-opened stream.
      if (deps.broadcaster.size >= deps.maxConnections) {
        void reply
          .code(503)
          .header('Retry-After', '5')
          .send(toErrorBody('SSE_LIMIT_REACHED', 'Too many event streams open'));
        return;
      }

      reply.hijack();
      reply.raw.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
        // Nginx (and any similar reverse proxy) buffers a proxied response by default, which
        // would hold every SSE frame — including the keepalive comment — until its own buffer
        // fills or the connection closes. This header is the standard opt-out.
        'X-Accel-Buffering': 'no',
      });
      reply.raw.write(RETRY_FIELD); // D-05 — must be the very first bytes written.

      let cleanedUp = false;
      function cleanup(): void {
        if (cleanedUp) return;
        cleanedUp = true;
        clearInterval(heartbeat);
        deps.broadcaster.remove(stream);
      }

      // T-5G-34-01: the exact same teardown a clean disconnect (`request.raw.on('close', ...)`
      // below) uses -- a half-open peer, a backpressure-budget breach or a write-time error all
      // release the slot the same way, never a second, divergent teardown path.
      function evict(): void {
        cleanup();
        if (!reply.raw.destroyed) {
          reply.raw.destroy();
        }
      }
      reply.raw.on('error', evict);

      function safeWrite(chunk: string): void {
        if (reply.raw.writableEnded || reply.raw.destroyed) return;
        if (exceedsBackpressureBudget(reply.raw.writableLength)) {
          evict();
          return;
        }
        try {
          reply.raw.write(chunk);
        } catch {
          // A write that throws (e.g. `ERR_STREAM_WRITE_AFTER_END`, reachable during shutdown --
          // WR-A-03 point 4) must never propagate out of the publish path and must not leave this
          // subscriber registered.
          evict();
        }
      }

      const stream: SseStream = {
        write: safeWrite,
        end: () => {
          reply.raw.end();
        },
      };
      deps.broadcaster.add(stream);

      const heartbeat = setInterval(() => {
        void (async (): Promise<void> => {
          let session: Awaited<ReturnType<SessionResolver>>;
          try {
            // T-5-02: bounded so a hung session lookup closes this stream within
            // SESSION_LOOKUP_TIMEOUT_MS of this heartbeat tick instead of keeping a possibly
            // revoked session's connection open indefinitely — a timeout rejection falls into
            // the same catch as any other resolution failure below.
            session = await withSessionLookupTimeout(() =>
              deps.getSession(toFetchHeaders(request.headers)),
            );
          } catch {
            // D-06: a session-resolution failure is treated the same as "no session" for a
            // heartbeat — the connection has no reliable proof of an active session anymore, so
            // it is closed rather than kept open on an unknown auth state.
            session = null;
          }
          if (!session?.session) {
            cleanup();
            reply.raw.end();
            return;
          }
          safeWrite(': keepalive\n\n');
        })();
      }, heartbeatMs);
      // A live SSE connection's heartbeat timer must never itself keep the Node process alive —
      // shutdown (`preClose`/`process.exit`) must not wait on this interval.
      heartbeat.unref();

      request.raw.on('close', cleanup);
    });

    done();
  };

  return eventsRoutes;
}
