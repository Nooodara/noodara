// D-02/D-04: the producer half of the SSE bridge. `ServerServicesDeps` gains a `deps.events` port
// so a Phase 3 service announces its own committed state change wherever it was called from — an
// HTTP route, the connect-server worker (Plan 04-09+), or a future CLI — without the caller having
// to remember to publish anything.
//
// Three event types (D-02, extended by D-05 in Phase 5): `server.updated` carries the whole
// `ServerView` (the same 27-field allowlist `GET /api/servers/:id` returns, never transformed) and
// `server.deleted` carries only `{ id }`. `server.discovery_progress` carries a single
// `DiscoveryCheck` — the exact value `runDiscovery`'s `onCheck` callback reported, whose `detail`
// was already `redactor.redact`-passed inside `runDiscovery` before it ever reached this publisher
// (D-05, T-5-13) — never raw command output, and deliberately never facts, a snapshot or a
// `ServerView`. There is deliberately no per-transition event type — the UI discriminates on
// `server.status`.
import type { DiscoveryCheck } from '@noodara/domain/discovery';
import type { ServerView } from '../services/server-view.js';

export type ServerEvent =
  | { readonly type: 'server.updated'; readonly server: ServerView }
  | { readonly type: 'server.deleted'; readonly id: string }
  | {
      readonly type: 'server.discovery_progress';
      readonly serverId: string;
      readonly check: DiscoveryCheck;
    };

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
