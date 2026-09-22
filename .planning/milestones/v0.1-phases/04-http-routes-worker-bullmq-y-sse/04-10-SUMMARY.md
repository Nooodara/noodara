---
phase: 04-http-routes-worker-bullmq-y-sse
plan: 10
subsystem: api
tags: [fastify, zod, keyset-pagination, drizzle, ioredis, health-check, d-20, d-21, d-26]

requires:
  - phase: 04-http-routes-worker-bullmq-y-sse
    provides: "routes/api-scope.ts guarded scope + app.ts's getServerServices/getQueue memoised resolvers (04-04, 04-08); ServerServices facade (04-08); WORKER_HEARTBEAT_KEY_PREFIX/startWorkerHeartbeat (04-07); masterKeyFingerprint/decodeMasterKey (Phase 1); the four-connection Redis topology (04-06, 04-09)"
provides:
  - "encodeActivityCursor/decodeActivityCursor (routes/activity-cursor.ts) — the opaque, never-throwing base64url keyset cursor D-20 requires"
  - "listActivityEvents/ActivityItem (services/read-activity.ts) — the D-20 reverse-chronological keyset-paginated read, explicit ten-column select, (occurred_at desc, id desc) tiebreak"
  - "ServerServices grown to ten members: listActivity(input) joins getServer/listServers"
  - "GET /api/activity (routes/activity.ts) — strict querystring (bounded limit, opaque cursor, no filters), decode failures map to 400 VALIDATION_FAILED"
  - "GET /api/config (routes/config.ts) — read-only, guarded, exposes version/publicUrl/masterKeyFingerprint/sshTimeouts/workerConcurrency, no PUT/PATCH"
  - "GET /health extended (routes/health.ts) — individually time-bounded postgres/redis/worker checks; dead Postgres is 503, degraded Redis/worker is 200"
  - "createHealthRedisConnection (redis/connections.ts) + app.ts's getHealthRedis memoised resolver, closed on shutdown alongside the other owned Redis connections"
affects: [04-11, 05]

tech-stack:
  added: []
  patterns:
    - "withTimeout(fn, ms) — a Promise.race against a fixed timer, the same bounded-check shape app.ts's onReady/preClose hooks already established, reused here per-check in health.ts so a wedged dependency degrades a check to 'fail' rather than hanging the response"
    - "SCAN with a bounded COUNT, never KEYS, for the worker-heartbeat presence check — passes the instant one matching key turns up, never enumerates the whole keyspace"
    - "listActivity joins the ServerServices facade the same way Plan 04-08 added getServer/listServers — one composition-root deps object, no second decorator"

key-files:
  created:
    - apps/control-plane/src/routes/activity-cursor.ts
    - apps/control-plane/src/routes/activity-cursor.test.ts
    - apps/control-plane/src/services/read-activity.ts
    - apps/control-plane/src/routes/activity.ts
    - apps/control-plane/src/routes/config.ts
    - tests/integration/services/read-activity.test.ts
    - tests/integration/routes/activity.test.ts
    - tests/integration/routes/config.test.ts
    - tests/integration/routes/health.test.ts
  modified:
    - apps/control-plane/src/services/server-services.ts
    - apps/control-plane/src/routes/api-scope.ts
    - apps/control-plane/src/routes/health.ts
    - apps/control-plane/src/app.ts
    - apps/control-plane/src/redis/connections.ts
    - tests/integration/services/read-servers.test.ts
    - tests/integration/services/trust-fingerprint.test.ts
    - tests/integration/services/fail-in-flight-connection.test.ts

key-decisions:
  - "encodeActivityCursor uses base64url of '<occurredAt.toISOString()>|<id>' with no encryption — the cursor carries no secret (both fields are already visible on the response items themselves), so opacity-by-convention plus timestamp/uuid validation on decode is sufficient for T-4-39's fail-closed requirement"
  - "listActivity joins the existing ServerServices facade (ten members) rather than a second decorator, mirroring Plan 04-08's own getServer/listServers precedent exactly — servers.ts's route-to-service reach pattern stays singular across the whole guarded scope"
  - "activity.ts's querystring schema is .strict(): an unrecognised key like ?action= is a 400 VALIDATION_FAILED, never a silently-ignored no-op filter, per D-20/REQUIREMENTS' explicit 'no filters, no search' scope line"
  - "/health gained its own dedicated, lazily-built, per-app-instance-memoised Redis connection (getHealthRedis) rather than reusing the queue/subscriber/publisher connections — none of the existing three are structurally reusable for a PING+SCAN health probe (the subscriber connection is in Redis's restricted pub/sub command mode; the queue connection is never created except when a route actually enqueues)"
  - "Each health check (postgres/redis/worker) is independently wrapped in the same Promise.race-against-a-fixed-timer shape app.ts's onReady/preClose hooks already use — a hung dependency degrades that one check to 'fail' within ~2s rather than blocking the whole response"

patterns-established:
  - "Every future health-style check in this codebase should reuse the withTimeout(fn, ms) shape rather than inventing a new bounded-race pattern"

requirements-completed: []

duration: ~140min
completed: 2026-09-18
---

# Phase 4 Plan 10: Activity log, instance config, and a health check that names failures Summary

**Reverse-chronological `GET /api/activity` paginated by an opaque, tamper-resistant keyset cursor over an explicit ten-column select; read-only `GET /api/config` exposing only the master key's truncated SHA-256 fingerprint; and `GET /health` extended to report Postgres, Redis and worker-heartbeat liveness individually, with a dead Postgres answering 503 and a degraded Redis/worker answering 200 so an orchestrator never restarts the API for the wrong reason.**

## Performance

- **Duration:** ~140 min
- **Started:** 2026-09-17T22:50:00-06:00 (approx.)
- **Completed:** 2026-09-18T00:10:00-06:00 (approx.)
- **Tasks:** 3
- **Files modified:** 16 (9 created, 7 modified)

## Accomplishments
- `apps/control-plane/src/routes/activity-cursor.ts`: `encodeActivityCursor`/`decodeActivityCursor` — a base64url `<occurredAt.toISOString()>|<id>` pair with a result union on decode (never a `throw`); rejects an unparseable timestamp, a non-uuid id, or a separator-less payload, all without touching the database.
- `apps/control-plane/src/services/read-activity.ts`: `listActivityEvents` — the D-20 keyset-paginated read. An explicit ten-column `select` (never `.select()`), `orderBy(desc(occurredAt), desc(id))`, `limit(limit + 1)` to compute `nextCursor` with no second query, and the Drizzle-verified `or(lt(occurredAt, cursor), and(eq(occurredAt, cursor), lt(id, cursor)))` compound comparison for the tiebreak. `metadata` passes through exactly as `writeActivityEvent` already redacted it on write.
- `apps/control-plane/src/services/server-services.ts`: `ServerServices` grew from nine to ten members — `listActivity` bound alongside `getServer`/`listServers`, joining the exact facade pattern Plan 04-08 established.
- `apps/control-plane/src/routes/activity.ts`: `GET /api/activity` — a `.strict()` querystring schema (`limit` coerced 1-200, default 50; optional `cursor`), rejecting an unrecognised key like `?action=` with 400 rather than silently ignoring it. A cursor-decode failure maps to the same `VALIDATION_FAILED` body shape a schema failure produces.
- `apps/control-plane/src/routes/config.ts`: `GET /api/config` — one route, one response schema, no `PUT`/`PATCH`. Returns `version` (from `CONTROL_PLANE_VERSION`), `publicUrl`, `masterKeyFingerprint` (the same 16-hex digest Phase 1 logs at boot, never the key itself), the three SSH timeout knobs, and worker concurrency.
- `apps/control-plane/src/routes/health.ts`: extended to `{ status: 'ok'|'degraded', version, checks: { postgres, redis, worker } }`. Each check (`select 1`, `PING`, a bounded-`COUNT` `SCAN` for `noodara:worker:*`) is wrapped in a `withTimeout` race against a 2-second timer, so a wedged dependency degrades that one check to `'fail'` instead of hanging the response. Postgres failing is the only path to 503; a missing worker heartbeat or unreachable Redis is 200 `degraded`.
- `apps/control-plane/src/app.ts` / `redis/connections.ts`: a new `createHealthRedisConnection` factory and a per-instance-memoised `getHealthRedis` resolver (same caller-owns-what-it-injects shape as the queue/broadcaster/publisher resolvers), closed in the `onClose` hook alongside the others.
- 30 new tests across `activity-cursor.test.ts` (8), `read-activity.test.ts` (7), `activity.test.ts` (10), `config.test.ts` (6) and `health.test.ts` (6, replacing the old single-assertion smoke test with the full D-26 matrix) prove: a cursor round-trips at millisecond precision and fails closed on tampering; pagination walks to exhaustion with no row skipped or repeated, including an identical-timestamp tie-break; every activity item exposes exactly the ten documented fields; `/api/config` never leaks the raw master key or its prefix and has no `PUT`; and `/health` distinguishes a dead Postgres (503) from a degraded Redis/worker (200), responding within a few seconds even against a genuinely wedged (not merely refused) Redis connection.

## Task Commits

Each task was committed atomically:

1. **Task 1: Opaque keyset cursor and the activity read service** - `777bcc9` (feat, TDD RED verified before implementation)
2. **Task 2: GET /api/activity** - `30cbadb` (feat, TDD RED verified before implementation)
3. **Task 3: GET /api/config and a /health that names what is broken** - `d0d376d` (feat, TDD RED verified before implementation)

_Note: each task's RED was run and confirmed failing for the stated reason (missing module for Task 1; 404s for Task 2's not-yet-registered route; the old health.ts's fixed `{status:'ok'}` shape and the 404 config route for Task 3) before implementing GREEN; each task landed as one commit per the noodara-tdd skill's "one commit per full cycle is acceptable" allowance._

## Files Created/Modified
- `apps/control-plane/src/routes/activity-cursor.ts` / `.test.ts` - opaque cursor encode/decode
- `apps/control-plane/src/services/read-activity.ts` - `listActivityEvents`, `ActivityItem`
- `apps/control-plane/src/routes/activity.ts` - `GET /api/activity`
- `apps/control-plane/src/services/server-services.ts` - `listActivity` bound onto the ten-member facade
- `apps/control-plane/src/routes/api-scope.ts` - registers `activityRoutes`/`configRoutes`
- `apps/control-plane/src/routes/config.ts` - `GET /api/config`
- `apps/control-plane/src/routes/health.ts` - full D-26 postgres/redis/worker check matrix
- `apps/control-plane/src/app.ts` / `redis/connections.ts` - `getHealthRedis` resolver + `createHealthRedisConnection`
- `tests/integration/services/read-activity.test.ts` - 7 tests for the keyset read
- `tests/integration/routes/activity.test.ts` - 10 tests for the HTTP surface
- `tests/integration/routes/config.test.ts` - 6 tests
- `tests/integration/routes/health.test.ts` - 6 tests (fully replaces the prior single-assertion smoke test)
- `tests/integration/services/read-servers.test.ts` / `trust-fingerprint.test.ts` / `fail-in-flight-connection.test.ts` - facade-membership assertions updated to the new ten-member shape

## Decisions Made
See `key-decisions` in the frontmatter above. The most consequential: `/health`'s own Redis connection could not reuse any of the three existing connections (subscriber is in Redis's restricted pub/sub command mode; the queue connection is never built except when a route actually enqueues), so it gets a fourth, dedicated, lazily-built connection following the exact same per-instance-memoised, caller-owns-what-it-injects shape `app.ts` already established for the others.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] Stale five/nine-member facade assertions in three pre-existing test files needed updating to ten**
- **Found during:** Task 2, before writing `listActivity`
- **Issue:** `read-servers.test.ts`, `trust-fingerprint.test.ts` and `fail-in-flight-connection.test.ts` each assert the exact `Object.keys(services)` set from `createServerServices` — a literal array that predates this plan's own `listActivity` addition. Growing the facade legitimately makes those literals stale, matching the exact same situation Plan 04-08 already handled once for `getServer`/`listServers`.
- **Fix:** Added `listActivity` to each of the three literal key-set arrays and updated their describing comments (five → seven → nine → ten member history), mirroring 04-08's own precedent exactly.
- **Files modified:** `tests/integration/services/read-servers.test.ts`, `tests/integration/services/trust-fingerprint.test.ts`, `tests/integration/services/fail-in-flight-connection.test.ts`
- **Verification:** All three files pass; `tests/integration/services/read-servers.test.ts`'s own facade-membership test is the exhaustive one, the other two just assert the count/shape stays consistent.
- **Committed in:** `30cbadb` (Task 2 commit)

**2. [Rule 1 - Bug] `health.test.ts`'s own blackhole-Redis fixture could hang the test suite on cleanup**
- **Found during:** Task 3, first run of the "responds within a couple of seconds even when Redis is genuinely hanging" test
- **Issue:** The test's helper TCP server accepted a connection and sent nothing (to simulate a wedged Redis) but never destroyed the accepted socket on `close()`. Node's `server.close()` waits for every open connection to end before firing its callback, and a client-side `ioredis.disconnect()` against a connection stuck mid-handshake does not reliably tear down the underlying socket fast enough — so the fixture's own `close()` call hung the test's `afterEach` for the full 120s hook timeout.
- **Fix:** Tracked every accepted socket in a `Set` and explicitly `destroy()`ed each one inside `close()`, and reordered `afterEach` to close the blackhole fixture *before* `fixture.stop()`/`app.close()` run, so the app's own ioredis clients never need to gracefully tear down a connection this fixture is about to yank out from under them anyway.
- **Files modified:** `tests/integration/routes/health.test.ts`
- **Verification:** The full `health.test.ts` file (6 tests) now passes cleanly and repeatably, including run in isolation via `-t`, with no hang and zero stray containers.
- **Committed in:** `d0d376d` (Task 3 commit)

**3. [Rule 1 - Bug] The same test's own elapsed-time measurement included `app.ready()`'s boot-time bound, not just the request**
- **Found during:** Task 3, same test as above
- **Issue:** `fixture.app.inject(...)` implicitly calls `app.ready()` on first use, which itself races the SSE broadcaster's bounded subscribe (2s, D-27) against the same blackhole Redis. Starting the elapsed-time timer before `inject()` therefore measured ~4s (2s boot + 2s of concurrent health checks), not the health route's own bound.
- **Fix:** Explicitly `await fixture.app.ready()` before starting the timer, isolating the measurement to the `/health` request itself; the threshold was correspondingly set to 3500ms (the two concurrent 2s-bounded checks plus overhead), not 4000ms.
- **Files modified:** `tests/integration/routes/health.test.ts`
- **Verification:** The test passes consistently; a standalone reproduction script confirmed the route itself answers in ~2s against a genuine TCP blackhole once boot time is excluded.
- **Committed in:** `d0d376d` (Task 3 commit)

---

**Total deviations:** 3 auto-fixed (all Rule 1 — one production-code-adjacent test-suite consistency fix, two test-fixture/test-design bugs found while proving this plan's own D-26 must-haves)
**Impact on plan:** No scope creep. All three were required to make the plan's own instructed behavior verifiable; none touched production route/service logic beyond the already-planned `listActivity` facade addition.

## Issues Encountered
- A combined `tests/integration/routes/ tests/integration/services/` run (18 files, run once at the end purely as an extra-broad regression check beyond this plan's own scope) showed 137 failing assertions concentrated in `register-server.test.ts`/`trust-fingerprint.test.ts` — all of the shape `expected [...] to have a length of +0 but got N` (stray-container-count assertions). Neither file was touched by this plan's production code. Re-running `register-server.test.ts` + `trust-fingerprint.test.ts` together in isolation passed cleanly (28/28), and re-running `servers-crud.test.ts` + `servers-connect.test.ts` + `servers-discover.test.ts` together also passed cleanly (38/38) — confirming this was the same pre-existing "shared dev machine Docker resource contention" pattern already documented in STATE.md's Blockers/Concerns from Phases 1-4 (rapid sequential Testcontainers churn across many files racing container removal), not a defect introduced by this plan.

## User Setup Required

None - no external service configuration required.

## Next Phase Readiness
- `GET /api/activity`, `GET /api/config` and the extended `GET /health` complete roadmap criterion 4's "activity y config validan su input con Zod y devuelven códigos HTTP correctos" and D-26's operational visibility Phase 6's Compose healthchecks will depend on.
- `routes/api-scope.ts`'s ordered extension-point list is now fully consumed (sessions, servers, events, activity, config) — no further routes are expected to join this guarded scope within Phase 4.
- Per STATE.md's existing note (from 04-01..04-09) and this plan's own orchestrator instruction, SERV-06/DISC-05 are not marked complete from this plan's frontmatter alone — they are re-verified at phase close.
- One known, machine-specific Docker-contention flake note carried forward to STATE.md Blockers/Concerns (see Issues Encountered above) — does not block phase progress and matches this repo's own pre-existing documented pattern.
- No blockers for Plan 04-11.

---
*Phase: 04-http-routes-worker-bullmq-y-sse*
*Completed: 2026-09-18*

## Self-Check: PASSED

All 14 created/modified files verified present on disk; all three task commit hashes (`777bcc9`, `30cbadb`, `d0d376d`) verified present in `git log`.
