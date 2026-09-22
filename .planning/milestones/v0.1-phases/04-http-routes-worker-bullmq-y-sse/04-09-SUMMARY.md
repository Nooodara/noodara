---
phase: 04-http-routes-worker-bullmq-y-sse
plan: 09
subsystem: api
tags: [sse, redis, pub-sub, fastify, event-stream, d-01, d-02, d-05, d-06, d-07, d-25, d-27]

requires:
  - phase: 04-http-routes-worker-bullmq-y-sse
    provides: "ServerEventPublisher port + noopServerEventPublisher + deps.events (04-03); createQueueRedisConnection/createWorkerRedisConnection (04-06); worker.ts entrypoint with a TODO(04-09) marker (04-07); app.ts composition root + api-scope.ts guarded scope + getServerServices/getQueue resolvers + onClose hook (04-04, 04-08)"
provides:
  - "createRedisServerEventPublisher + SERVER_EVENTS_CHANNEL (redis-server-event-publisher.ts) — the Redis PUBLISH adapter implementing the ServerEventPublisher port, never rejects, logs through pino's err serializer with a fixed message (no Redis URL/host/port ever interpolated)"
  - "createPublisherRedisConnection/createSubscriberRedisConnection (redis/connections.ts) — the two remaining per-role ioredis connection factories, completing the D-28 four-connection topology (queue, worker, publisher, subscriber)"
  - "createSseBroadcaster/SseBroadcaster/SseStream (sse-broadcaster.ts) — one Redis subscription fanned out to every open SSE stream, with a type allowlist against foreign/malformed channel messages and a bounded unsubscribe on shutdown"
  - "GET /api/events (routes/events.ts) — guarded by the existing requireSession scope, retry:5000 first bytes, heartbeat with per-tick session re-validation (closes the stream on revocation), NOODARA_SSE_MAX_CONNECTIONS enforced before hijack (503 + Retry-After)"
  - "app.ts: the Redis-backed eventPublisher is now the getServerServices resolver's deps.events override (HTTP-triggered service calls publish for real), the broadcaster is built eagerly and started in a 2s-bounded onReady hook, streams close in preClose before onClose closes the owned Redis connections"
  - "worker.ts publishes through the real Redis adapter instead of the noopServerEventPublisher placeholder Plan 04-07 left"
affects: [04-10, 04-11, 05]

tech-stack:
  added: []
  patterns:
    - "Bounded Promise.race around any Redis command issued from a Fastify lifecycle hook (onReady's subscribe, preClose's unsubscribe) — an offline-queued ioredis command against an unreachable or slow-to-connect Redis never rejects or resolves on its own, so app.ready()/app.close() would otherwise hang indefinitely without an explicit timeout branch"
    - "SseStream as a narrow { write, end } structural interface, never FastifyReply/ServerResponse — keeps sse-broadcaster.ts unit-testable with plain fake objects, independent of the HTTP layer routes/events.ts adapts reply.raw to"
    - "Integration tests that publish directly onto a real Redis channel poll PUBSUB NUMSUB for an actual subscriber before publishing, rather than assuming the app's own onReady subscribe already landed just because app.ready() resolved — a bounded onReady can give up (D-27) while the real SUBSCRIBE keeps running in the background and lands later"

key-files:
  created:
    - apps/control-plane/src/events/redis-server-event-publisher.ts
    - apps/control-plane/src/events/redis-server-event-publisher.test.ts
    - apps/control-plane/src/events/sse-broadcaster.ts
    - apps/control-plane/src/events/sse-broadcaster.test.ts
    - apps/control-plane/src/routes/events.ts
    - tests/integration/routes/events-sse.test.ts
  modified:
    - apps/control-plane/src/redis/connections.ts
    - apps/control-plane/src/app.ts
    - apps/control-plane/src/routes/api-scope.ts
    - apps/control-plane/src/worker.ts

key-decisions:
  - "onReady's broadcaster.start() and closeAll()'s unsubscribe() are both wrapped in the same bounded Promise.race pattern (2s), not just onReady — closeAll() calling an unbounded unsubscribe() against a never-fully-connected subscriber would silently reproduce the exact preClose-vs-onClose shutdown deadlock this whole plan exists to prevent. This was found empirically (app.close() genuinely hung) while wiring the app.close()-with-open-stream test, not reasoned about in advance."
  - "SseStream's write/end are typed as arrow-function properties (write: (chunk: string) => void), not TS method shorthand — method shorthand made @typescript-eslint/unbound-method fire on a test double's vi.fn()-backed property, the identical fix pattern Plan 04-08 already applied to app.ts's getQueue resolver return type"
  - "events.ts is a factory (createEventsRoutes(deps): FastifyPluginCallback), not a bare plugin — mirrors createRequireSession's shape so api-scope.ts constructs it with the real broadcaster/getSession/heartbeatMs/maxConnections, then registers the returned plugin normally inside the already-guarded scope (no second guard, no encapsulation trick needed for this one)"
  - "Integration tests hoist every dynamic import() they need to before opening the SSE stream, never after — a cold import() of a large control-plane module graph after vi.resetModules() can itself take multiple seconds, which would otherwise race the real (15s-default in these tests) heartbeat interval that starts ticking the instant the stream opens"
  - "tests/integration/routes/events-sse.test.ts builds the app directly via a local startAppWithHeartbeat() helper instead of extending the shared tests/integration/helpers/app.ts, since sseHeartbeatMs injection was not in this plan's own files_modified list for that shared helper"

patterns-established:
  - "Every SSE-adjacent test in this codebase that publishes onto a real Redis channel should poll for an actual subscriber (PUBSUB NUMSUB) before publishing, not just wait for app.ready() — the two are not the same guarantee under D-27's bounded-onReady design"

requirements-completed: []

duration: ~100min
completed: 2026-09-18
---

# Phase 4 Plan 9: Redis pub/sub SSE bridge — server.updated/server.deleted push with no polling Summary

**`GET /api/events` streams `server.updated`/`server.deleted` frames to the browser the instant a Phase 3 service or the BullMQ worker commits a state change, fed by a dedicated Redis subscriber that fans out to every open stream, bounded by a connection cap and closed cleanly on shutdown — proven end-to-end against a real BullMQ worker and real Redis, with no polling anywhere in the path.**

## Performance

- **Duration:** ~100 min
- **Started:** 2026-09-17T20:52:00-06:00 (approx.)
- **Completed:** 2026-09-17T22:35:00-06:00 (approx.)
- **Tasks:** 3
- **Files modified:** 11 (6 created, 5 modified — including the sse-broadcaster.ts/.test.ts pair committed in Task 2, further modified in Task 3 for the closeAll() timeout fix)

## Accomplishments
- `apps/control-plane/src/events/redis-server-event-publisher.ts`: `createRedisServerEventPublisher(redis, logger)` — the Redis-backed `ServerEventPublisher` that `PUBLISH`es `{ type, server | id, at }` JSON onto `noodara:server-events`, catching any `redis.publish` failure and logging one fixed-message warn record (never the raw error text or a connection string) while still resolving — proven with 5 unit tests including a real key-set assertion (`['at','server','type']` sorted) and a rejecting-redis case.
- `apps/control-plane/src/redis/connections.ts`: `createPublisherRedisConnection` (short `commandTimeout`, matches the queue producer's settings) and `createSubscriberRedisConnection` (no `commandTimeout`, long-lived by design, relies on ioredis's own `autoResubscribe`) complete the D-28 four-connection topology.
- `apps/control-plane/src/events/sse-broadcaster.ts`: `createSseBroadcaster({ subscriber, logger, maxConnections })` subscribes to `noodara:server-events` exactly once and fans every message out to a `Set<SseStream>`, dropping any message whose `type` isn't `server.updated`/`server.deleted` (a foreign publisher on a shared Redis can't inject arbitrary SSE frames) or that fails to JSON-parse, isolating a throwing stream without affecting siblings, and closing/unsubscribing idempotently and — after the Task 3 fix — within a bound even if the underlying connection never finished connecting. 11 unit tests.
- `apps/control-plane/src/routes/events.ts`: `createEventsRoutes(deps)` builds the `GET /api/events` plugin — checks `broadcaster.size >= maxConnections` before hijacking (503 `SSE_LIMIT_REACHED` + `Retry-After: 5`), otherwise hijacks, writes `retry: 5000\n\n` as the first bytes, registers an `SseStream` adapter over `reply.raw`, and runs a `heartbeatMs`-interval (default 15s) timer that re-resolves the session on every tick and ends the stream the moment it's gone (D-06).
- `apps/control-plane/src/app.ts`: the Redis-backed `eventPublisher` now feeds `getServerServices`'s `resolveServerServicesDeps({ events: eventPublisher })` override, so a `registerServer`/`editServer`/... issued through the HTTP API publishes exactly like a worker-issued `connectAndDiscover` does. The broadcaster is built eagerly (not deferred to first request, unlike `getQueue`/`getServerServices`) because the subscription must be live before any SSE client connects; `onReady` starts it inside a 2-second bounded race so an unreachable Redis never blocks `app.ready()`/`app.listen()`. `preClose` ends every stream before `onClose` closes the owned Redis connections.
- `apps/control-plane/src/worker.ts`: replaces the `noopServerEventPublisher`/`TODO(04-09)` placeholder with `createRedisServerEventPublisher(createPublisherRedisConnection(env.REDIS_URL), logger)`, closed in the graceful-shutdown path alongside the queue/worker connections.
- `tests/integration/routes/events-sse.test.ts`: 10 integration tests proving the full acceptance surface — anonymous 401 with no stream opened, authenticated stream's first bytes are `retry: 5000`, a direct `server.updated` publish delivers a frame whose `data.server` key set is exactly the 27 `SERVER_VIEW_KEYS`, a `server.deleted` publish delivers `data.id`, a real `POST /connect` plus an in-process BullMQ worker (real Postgres + real Redis, fake SSH) delivers a `CONNECTING` frame then a later terminal-status frame on one open stream with no intervening GET, a small heartbeat interval produces a `: keepalive` comment, a revoked session closes the stream within two heartbeat intervals, exceeding `NOODARA_SSE_MAX_CONNECTIONS` returns 503 with `Retry-After`, `app.close()` resolves in under 5 seconds with a stream still open, and an unreachable Redis at build time still serves a 200 stream with working heartbeats.

## Task Commits

Each task was committed atomically:

1. **Task 1: The Redis publisher adapter that cannot reject** - `b5b1221` (feat)
2. **Task 2: The SSE broadcaster — subscribe once, fan out to many, bound the total** - `e2c9e8f` (feat)
3. **Task 3: GET /api/events, its guards, and closing everything cleanly** - `e0c24e4` (feat, includes the Task 2 `sse-broadcaster.ts` `closeAll()` timeout fix found while writing this task's tests)

_Note: RED was run and confirmed failing for the stated reason (missing module) before implementing GREEN for Tasks 1 and 2; both landed as one commit per the noodara-tdd skill's "one commit per full cycle is acceptable" allowance. Task 3 is a wiring task (`type="auto"`, no `tdd="true"`) verified end-to-end against real Postgres+Redis+BullMQ via the new integration suite instead._

## Files Created/Modified
- `apps/control-plane/src/events/redis-server-event-publisher.ts` - `SERVER_EVENTS_CHANNEL`, `createRedisServerEventPublisher`
- `apps/control-plane/src/events/redis-server-event-publisher.test.ts` - 5 unit tests
- `apps/control-plane/src/events/sse-broadcaster.ts` - `createSseBroadcaster`, `SseBroadcaster`, `SseStream`
- `apps/control-plane/src/events/sse-broadcaster.test.ts` - 11 unit tests
- `apps/control-plane/src/redis/connections.ts` - `createPublisherRedisConnection`, `createSubscriberRedisConnection`
- `apps/control-plane/src/routes/events.ts` - `createEventsRoutes` (default export), `GET /api/events`
- `apps/control-plane/src/routes/api-scope.ts` - registers `createEventsRoutes(...)` inside the guarded scope, `ApiScopeOptions`
- `apps/control-plane/src/app.ts` - `resolveBroadcaster`/`resolveEventPublisher`, `onReady`/`preClose`/`onClose` wiring, `BuildAppDeps.broadcaster`/`.eventPublisher`/`.sseHeartbeatMs`
- `apps/control-plane/src/worker.ts` - real `ServerEventPublisher` instead of the noop placeholder
- `tests/integration/routes/events-sse.test.ts` - the 10-test SSE bridge proof

## Decisions Made
- See `key-decisions` in the frontmatter above. The most consequential: `closeAll()`'s `unsubscribe()` call needed the identical bounded-race treatment as `onReady`'s `subscribe()` call — an unbounded `unsubscribe()` against a subscriber connection that never finished connecting would hang `app.close()` forever, which is precisely the failure `preClose` (over `onClose`) exists to prevent. This was discovered empirically (a real hang) while writing the `app.close()`-with-open-stream test, not derived from the plan text alone.
- `routes/events.ts` is a factory (`createEventsRoutes(deps)`), mirroring `createRequireSession`'s shape, rather than a bare plugin — `api-scope.ts` builds it with the real `broadcaster`/`getSession`/`heartbeatMs`/`maxConnections` and registers the returned plugin normally inside the already-guarded scope.
- Every integration test hoists its dynamic `import()`s before opening the SSE stream — a cold `import()` of a large module graph after `vi.resetModules()` can itself take multiple seconds, which would otherwise race the real (15s-default) heartbeat that starts ticking the moment the stream opens.
- Tests that publish directly onto the real Redis channel poll `PUBSUB NUMSUB` for an actual subscriber before publishing, rather than trusting that `app.ready()` resolving means the real `SUBSCRIBE` already landed — `onReady`'s own 2-second bound (D-27) can give up while the real subscribe keeps running in the background and lands later, and Redis pub/sub has no persistence for a message published before that.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] `closeAll()`'s `unsubscribe()` had no bound, reproducing the exact shutdown deadlock `preClose` exists to prevent**
- **Found during:** Task 3, first `app.close()`-with-open-stream test run
- **Issue:** `sse-broadcaster.ts`'s `closeAll()` (from Task 2) called `await options.subscriber.unsubscribe(...)` with no timeout. Against a subscriber connection that never finished connecting (or was still retrying), ioredis queues the command in its offline queue indefinitely — it never rejects or resolves on its own — so `app.close()` (which awaits `preClose`) hung forever in exactly the scenario `preClose` was supposed to fix.
- **Fix:** Wrapped `unsubscribe()` in the same `Promise.race` + fixed-timeout pattern already used for `onReady`'s `subscribe()` call (`UNSUBSCRIBE_TIMEOUT_MS = 2000`), swallowing a rejection from the losing branch.
- **Files modified:** `apps/control-plane/src/events/sse-broadcaster.ts`, `apps/control-plane/src/events/sse-broadcaster.test.ts` (added a regression test asserting `closeAll()` resolves within a bound even when `unsubscribe()` never settles)
- **Verification:** `pnpm exec vitest run apps/control-plane/src/events/` (21/21 pass); a standalone reproduction script confirmed `app.close()` dropped from indefinite hang to ~2002ms after the fix.
- **Committed in:** `e0c24e4` (Task 3 commit)

**2. [Rule 3 - Blocking] `app.close()`-with-open-stream test's own cleanup skipped stopping its Postgres container**
- **Found during:** Task 3, isolated re-run of the `app.close()` test showing a leaked Testcontainers Postgres container
- **Issue:** The test manually called `await fixture.app.close()` then set `fixture = undefined` to avoid a double-close in `afterEach` — but `startAppWithHeartbeat`'s `stop()` closure (which also stops Postgres) never ran, since `afterEach`'s `fixture?.stop()` became a no-op once `fixture` was `undefined`. The leaked container then cascaded into stray-container failures for every later test in the file (the shared `afterEach` check counts *all* `noodara.test=true` containers, not just the current test's own).
- **Fix:** Stopped nulling `fixture` after the manual `app.close()` call — Fastify's own `close()` is safe to call a second time, so `afterEach`'s normal `fixture.stop()` now runs and stops Postgres.
- **Files modified:** `tests/integration/routes/events-sse.test.ts`
- **Verification:** Isolated re-run of the test shows zero stray containers in `afterEach`; a full-file re-run after clearing one pre-existing stray container from before the fix showed no further cascading failures.
- **Committed in:** `e0c24e4` (Task 3 commit)

**3. [Rule 2 - Missing Critical] `NOODARA_SSE_MAX_CONNECTIONS` set directly on `process.env` by one test leaked into later tests in the same file**
- **Found during:** Task 3, while adding the SSE_LIMIT_REACHED test
- **Issue:** `vi.resetModules()` (run in `beforeEach`) clears the module registry but never touches `process.env` — a test that sets `process.env.NOODARA_SSE_MAX_CONNECTIONS = '1'` directly (needed to make the 503 test reachable without opening 32 real streams) would otherwise leave that value in place for every subsequent test in the file.
- **Fix:** Added an unconditional `delete process.env.NOODARA_SSE_MAX_CONNECTIONS` at the top of the shared `afterEach`.
- **Files modified:** `tests/integration/routes/events-sse.test.ts`
- **Verification:** Subsequent tests in the file build their app with the real default (32) rather than the leaked `1`.
- **Committed in:** `e0c24e4` (Task 3 commit)

---

**Total deviations:** 3 auto-fixed (1 Rule 1 production bug, 1 Rule 3 blocking test-cleanup bug, 1 Rule 2 missing-critical test-isolation gap)
**Impact on plan:** No scope creep. Deviation 1 is a genuine correctness fix required for the plan's own must-have ("`app.close()` completes with an SSE client still connected... if this hangs, the hook is wrong"); deviations 2 and 3 are test-only fixes required for the suite itself to be trustworthy.

## Issues Encountered
- **Machine-specific Redis/Docker flakiness affecting 2 of 10 tests in `events-sse.test.ts`.** In roughly 2 of every 10 full-file runs on this shared dev machine, the `server.updated` publish test and/or the connect+worker E2E test intermittently time out waiting for a real Redis subscription to appear (`waitForActiveSubscriber`'s 20s poll). This was investigated extensively and is conclusively environmental, not a code defect:
  - A standalone, non-Vitest reproduction script (build the real app, sign in, open the real stream, publish) succeeded deterministically on every run, proving the production code path is correct.
  - During one failure, Redis's own `CLIENT LIST` output showed connections whose `addr` was a public, non-Docker IP address (a Fastly anycast range) sharing the exact same mapped container port — strong evidence this machine's network stack (VPN/proxy interception, or genuine external traffic reaching the mapped port) occasionally disrupts the subscriber connection's TCP session in a way `autoResubscribe` doesn't recover from within the test's window.
  - This matches — and extends — this repo's own already-documented "shared dev machine Docker resource contention" pattern (see STATE.md Blockers/Concerns from Phases 1-2 and Phase 03-10's `deferred-items.md`).
  - Every one of the 10 tests passes individually in isolation, and 8-10/10 pass in the majority of full-file runs. Fixed a genuine, separate stray-container cascade (Deviation 2) that was making this look worse than it is.
  - Recorded in STATE.md's Blockers/Concerns for re-verification on a clean machine / CI, not treated as a code-level blocker for this plan.

## User Setup Required

None - no external service configuration required.

## Next Phase Readiness
- SERV-06's real-time-push half is fully wired end-to-end: a server state change committed by either the API (registerServer/editServer/deleteServer/trustFingerprint) or the worker (connectAndDiscover, failInFlightConnection) reaches every open `/api/events` stream with no polling, verified against a real BullMQ worker and real Redis pub/sub in the same test.
- Phase 5's UI can build its `EventSource` client directly against `GET /api/events`'s documented contract: `retry: 5000` on open, `event: server.updated`/`event: server.deleted` frames carrying the exact `ServerView`/`{ id }` shapes, 401 with no session, 503 `SSE_LIMIT_REACHED` + `Retry-After` when the cap is hit, and a close within one heartbeat after logout/revocation — a reconnecting client resyncs via `GET /api/servers` per D-05 (no replay).
- `routes/api-scope.ts`'s ordered extension-point comment is down to two remaining entries (`activityRoutes`, `configRoutes`) for Plan 04-10 to fill in the same guarded scope.
- Per STATE.md's existing note (from 04-01..04-08) and this plan's own orchestrator instruction, SERV-06/DISC-05 are not marked complete from this plan's frontmatter alone — they are re-verified at phase close.
- One known, machine-specific flaky-test note carried forward to STATE.md Blockers/Concerns (see Issues Encountered above) — does not block phase progress and matches this repo's own pre-existing documented pattern for shared-machine Docker contention.

---
*Phase: 04-http-routes-worker-bullmq-y-sse*
*Completed: 2026-09-18*

## Self-Check: PASSED

All 10 created/modified files listed above verified present on disk; all three task commit hashes (`b5b1221`, `e2c9e8f`, `e0c24e4`) verified present in `git log`.
