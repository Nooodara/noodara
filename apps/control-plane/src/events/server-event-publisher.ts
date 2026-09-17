// D-02/D-04: the producer half of the SSE bridge. `ServerServicesDeps` gains a `deps.events` port
// so a Phase 3 service announces its own committed state change wherever it was called from — an
// HTTP route, the connect-server worker (Plan 04-09+), or a future CLI — without the caller having
// to remember to publish anything.
//
// Exactly two event types this phase (D-02): `server.updated` carries the whole `ServerView` (the
// same 27-field allowlist `GET /api/servers/:id` returns, never transformed) and `server.deleted`
// carries only `{ id }`. There is deliberately no per-transition event type — the UI discriminates
// on `server.status`.
import type { ServerView } from '../services/server-view.js';

export type ServerEvent =
  | { readonly type: 'server.updated'; readonly server: ServerView }
  | { readonly type: 'server.deleted'; readonly id: string };

/**
 * The publication port every Phase 3 service depends on through `ServerServicesDeps.events`.
 *
 * Contract: an implementation must never reject. SSE is best-effort and Postgres remains the
 * source of truth (D-04) — a real implementation (the Redis adapter lands in Plan 04-09) is
 * responsible for catching its own failure and logging a warning internally; it must still
 * resolve so a broken publisher can never turn a committed database change into a failed service
 * call.
 */
export interface ServerEventPublisher {
  publish(event: ServerEvent): Promise<void>;
}

/**
 * The default `deps.events` implementation everywhere no Redis connection exists — unit tests,
 * service integration tests, the CLI. Resolves immediately and does nothing observable.
 */
export const noopServerEventPublisher: ServerEventPublisher = {
  publish(): Promise<void> {
    return Promise.resolve();
  },
};

/**
 * The belt-and-braces guarantee every service call site uses instead of calling
 * `publisher.publish(...)` directly: a buggy or misbehaving publisher (rejecting or throwing
 * synchronously) can never turn a committed state change into a failed service call. Deliberately
 * silent and dependency-free — the real Redis adapter (Plan 04-09) is the layer responsible for
 * logging its own failure, not this helper.
 */
export async function publishServerEvent(
  publisher: ServerEventPublisher,
  event: ServerEvent,
): Promise<void> {
  try {
    await publisher.publish(event);
  } catch {
    // Intentionally swallowed — see the ServerEventPublisher contract doc comment above.
  }
}
