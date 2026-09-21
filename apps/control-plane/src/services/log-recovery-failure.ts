// 05-REVIEW.md GR-03: `connectAndDiscover`'s catch block deliberately swallows a failure of its
// own post-failure recovery call (`failInFlightConnection(...).catch(() => undefined)`) so the
// ORIGINAL error is always the one rethrown — but before this helper existed, a recovery failure
// left zero trace. CLAUDE.md §2.2 requires an explicit, adequate log for every infrastructure
// failure path; a silent recovery failure hides a real signal (e.g. a flaky database) behind an
// apparently clean recovery, since the worker's own `'failed'` listener provides a second, logged
// recovery attempt.
//
// Why a separate module: `connect-and-discover.ts` pulls in the db schema, the SSH port and the
// discovery runner, so a unit test of only the logging behaviour should not have to import all of
// that. This module imports `ServerServicesDeps` type-only (erased at runtime), so it stays
// testable with a fake logger and no environment at all.
//
// Two things this helper must never do (T-5G-41-02, T-5G-41-03):
//   1. Put any part of the recovery error's own message into the log text — an error on this path
//      can carry a Postgres connection string. The message is a fixed literal, never derived from
//      the error in any way (never read off its own message property, never a template literal,
//      never coerced to a string). The Error itself goes under the `err` key, where logger.ts's
//      global `serializers.err` strips it down to `{ name }` before it is ever written.
//   2. Let a failure of the logging call itself escalate into a second failure on a recovery
//      path — the whole call is wrapped in its own try/catch, and that catch discards the
//      logging failure (there is nowhere further to report it, and re-throwing here would defeat
//      the entire point of a defensive `.catch(...)` recovery handler).
import type { ServerServicesDeps } from './server-service-deps.js';

const RECOVERY_FAILURE_MESSAGE =
  'connect-and-discover post-failure recovery failed; the worker failed-job listener will retry';

/**
 * Logs (at `warn`) that `connectAndDiscover`'s own `failInFlightConnection` recovery attempt
 * failed. Never throws — a throwing `deps.logger` (or an absent one) both resolve to a no-op.
 */
export function logRecoveryFailure(
  deps: Pick<ServerServicesDeps, 'logger'>,
  serverId: string,
  err: unknown,
): void {
  try {
    deps.logger?.warn({ err, serverId }, RECOVERY_FAILURE_MESSAGE);
  } catch {
    // Deliberately discarded — see module header, point 2.
  }
}
