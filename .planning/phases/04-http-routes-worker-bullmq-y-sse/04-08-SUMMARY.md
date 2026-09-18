---
phase: 04-http-routes-worker-bullmq-y-sse
plan: 08
subsystem: api
tags: [fastify, zod, bullmq, server-crud, connect, discover, d-08, d-09, d-10, d-19]

requires:
  - phase: 04-http-routes-worker-bullmq-y-sse
    provides: "mapServiceCodeToStatus/toErrorBody/ErrorBodySchema/ValidationErrorBodySchema (04-02), the guarded routes/api-scope.ts + BuildAppDeps/app.ts (04-04), failInFlightConnection/listConnectingServerIds on the ServerServices facade (04-05), ConnectServerQueue/jobIdForServer/createQueueRedisConnection (04-06)"
provides:
  - "getServerView/listServerViews (services/read-servers.ts) — the read side of the server resource, growing ServerServices to nine members (getServer, listServers)"
  - "The eight /api/servers routes: POST/GET/GET-by-id/PATCH/DELETE (CRUD), POST .../trust-fingerprint, POST .../connect, POST .../discover — all Zod-validated, all guarded, all mapping codes through the one D-16 table"
  - "routes/server-schemas.ts — WireCredentialSchema/toCredentialInput (the wire type/kind vocabulary translation), CreateServerBodySchema/UpdateServerBodySchema, ServerViewSchema with a key-set drift guard against SERVER_VIEW_KEYS"
  - "app.ts gained two per-instance memoised resolvers (getServerServices, getQueue) and their BuildAppDeps override fields, plus an onClose hook that only closes a queue app.ts built itself"
  - "tests/integration/helpers/app.ts's startTestApp({ redisUrl }) — lets a route-level integration test point the app's queue at a real Testcontainers Redis"
affects: [04-09, 04-10, 04-11]

tech-stack:
  added: []
  patterns:
    - "sendServiceError(reply: FastifyReply, code, message) as the one non-route-generic-typed function every service-result failure branch calls — works around Fastify's own .code()<Code> generic being narrowed to a specific route's declared response-status literals, which a runtime-computed mapServiceCodeToStatus() number can never satisfy without this indirection"
    - "enqueueConnect(services, queue, fastify, { serverId, actor, trigger }) as the one enqueue code path both /connect and /discover call — the only branch difference is the discover-requires-CONNECTED precondition"
    - "A 400 response schema unioning ValidationErrorBodySchema (has issues) with the plain ErrorBodySchema (no issues) — declaring only the plain shape would make the Zod response serializer silently strip issues off a schema-validation failure's wire body"

key-files:
  created:
    - apps/control-plane/src/services/read-servers.ts
    - apps/control-plane/src/routes/server-schemas.ts
    - apps/control-plane/src/routes/server-schemas.test.ts
    - apps/control-plane/src/routes/servers.ts
    - tests/integration/services/read-servers.test.ts
    - tests/integration/routes/servers-crud.test.ts
    - tests/integration/routes/servers-connect.test.ts
    - tests/integration/routes/servers-discover.test.ts
  modified:
    - apps/control-plane/src/services/server-services.ts
    - apps/control-plane/src/routes/api-scope.ts
    - apps/control-plane/src/app.ts
    - tests/integration/helpers/app.ts
    - tests/integration/services/trust-fingerprint.test.ts
    - tests/integration/services/fail-in-flight-connection.test.ts

key-decisions:
  - "reply.code(mapServiceCodeToStatus(code)) does not type-check inside a route handler typed via ZodTypeProvider — Fastify's own .code<Code> generic narrows Code to exactly the numeric literals declared in that route's response schema, which a runtime-computed number can never satisfy. Solved by extracting the one send-error call into sendServiceError(reply: FastifyReply, ...) — a function whose reply parameter is the bare, non-route-generic FastifyReply type — rather than any unsafe cast; the concrete route-typed reply each handler holds is still structurally assignable to it."
  - "jobId is 'connect-<serverId>' (hyphen), matching Plan 04-06's own already-recorded BullMQ-jobId-cannot-contain-':' deviation — not the 'connect:<id>' literal 04-CONTEXT.md's D-09 names. No new deviation; this plan's tests assert the real, already-corrected format."
  - "GET /api/servers/:id's NOT_FOUND branch (a plain services.getServer() null check, not a { ok: false } service result) now routes through the same sendServiceError helper as every other failure branch, rather than a bespoke reply.code(404) call, keeping exactly one status-mapping code path in the file."
  - "tests/integration/helpers/app.ts's startTestApp() gained an optional redisUrl field (defaulting to the existing unreachable placeholder) instead of a new helper — mirrors the identical redisUrl-parameter pattern boot-process.ts (04-07) and worker-fixture.ts (04-07) already established for the same env-before-import constraint."
  - "app.ts's queue resolver only closes the ioredis connection and BullMQ Queue it built itself (deps.queue undefined) in its onClose hook — a caller-injected queue's lifecycle stays owned by the caller, matching connect-server-queue.ts's own 'the caller owns the connection' contract."

patterns-established:
  - "Every later route needing a service call plus a mapped failure reuses servers.ts's sendServiceError shape rather than reply.code(<dynamic>) directly, sidestepping the same Fastify+Zod generic-narrowing issue this plan discovered."

requirements-completed: []

duration: ~195min
completed: 2026-09-17
---

# Phase 4 Plan 8: Server read services and the eight /api/servers HTTP routes Summary

**The full server resource over HTTP — five CRUD routes, trust-fingerprint, and connect/discover answering 202 with a deterministic jobId in milliseconds with no worker running — all Zod-validated, all guarded, all mapping codes through the one D-16 status table, with zero credential material ever reaching a response body.**

## Performance

- **Duration:** ~195 min
- **Started:** 2026-09-17T16:45:00-06:00 (approx.)
- **Completed:** 2026-09-17T20:03:00-06:00 (approx.)
- **Tasks:** 3
- **Files modified:** 14 (8 created, 6 modified)

## Accomplishments
- `apps/control-plane/src/services/read-servers.ts`: `getServerView`/`listServerViews` project every row through the existing `toServerView` allowlist with no transaction and no activity write — absence is the answer for an unknown id (`null`, never a result union), and `listServerViews` orders by `name` ascending consistent with the `lower(name)` unique index. `ServerServices` grew to nine members (`getServer`, `listServers`).
- `apps/control-plane/src/routes/server-schemas.ts`: `WireCredentialSchema`/`toCredentialInput` translate the wire's `type: 'ssh_private_key' | 'ssh_password'` vocabulary into Phase 3's `kind: 'private_key' | 'password'` `CredentialInput` without ever touching that internal type; `CreateServerBodySchema`/`UpdateServerBodySchema` are `.strict()`; `ServerViewSchema` lists all 27 `ServerView` fields explicitly with a unit-tested drift guard against `SERVER_VIEW_KEYS`.
- `apps/control-plane/src/routes/servers.ts`: all eight routes. `POST`/`GET`/`GET :id`/`PATCH`/`DELETE` map every `{ ok: false }` result and a plain "not found" read outcome through one `sendServiceError` helper; `POST .../connect` and `POST .../discover` share one `enqueueConnect` helper differing only in the discover-requires-`CONNECTED` precondition, answer `202 { server, jobId }` without ever calling `connectAndDiscover`, log one `info` record (`serverId`, `jobId`, `trigger`) and write no activity event.
- `app.ts` gained two per-`buildApp()`-instance memoised resolvers — `getServerServices` (Task 2) and `getQueue` (Task 3) — each resolved lazily on first request so building the app never opens a Postgres pool or a Redis connection just by existing; `getQueue`'s `onClose` hook only tears down a queue/connection `app.ts` built itself, never a caller-injected one.
- `routes/api-scope.ts` registers `serversRoutes` immediately after `sessionsRoutes` inside the existing guarded scope — no second guarded scope, no new hook ordering.
- 22 + 9 + 7 = 38 new integration tests across `servers-crud.test.ts`, `servers-connect.test.ts` and `servers-discover.test.ts` prove: the 27-key `ServerView` allowlist on every CRUD response; `NAME_TAKEN`/`HOST_TAKEN`/`VALIDATION_FAILED`/`INVALID_CREDENTIAL` all map correctly; a missing `credential` fails with a schema-level `issues` array; no response body at any status contains a submitted private-key or password canary; every route 401s with no cookie; `connect` answers 202 with no SSH work performed and the row's status untouched; two consecutive connects dedupe to one queued job; `discover` off `CONNECTED` is 409 `SERVER_NOT_CONNECTED` and reuses the exact same job as a prior `connect`; a stopped Redis yields 503 `QUEUE_UNAVAILABLE` in well under 3s while `GET /api/servers` keeps working; and the `activity_events` row count is unchanged across a connect call.

## Task Commits

Each task was committed atomically:

1. **Task 1: The server read services** - `f9e4a7d` (feat, TDD RED verified before implementation)
2. **Task 2: The five CRUD routes and their wiring into the guarded scope** - `516d7ea` (feat, TDD RED verified before implementation)
3. **Task 3: trust-fingerprint, connect and discover — the 202 enqueue path** - `59a2e66` (feat, TDD RED verified before implementation)

_Note: RED was run and confirmed failing for the stated reason (missing module for Task 1; route-not-found 404s for Tasks 2/3, since the CRUD-only `servers.ts` didn't yet register `/connect`/`/discover`/`/trust-fingerprint`) before implementing GREEN for each task; each task landed as one commit per the noodara-tdd skill's "one commit per full cycle is acceptable" allowance._

## Files Created/Modified
- `apps/control-plane/src/services/read-servers.ts` - `getServerView`, `listServerViews`
- `apps/control-plane/src/services/server-services.ts` - `ServerServices` grown to nine members; `getServer`/`listServers` bound
- `apps/control-plane/src/routes/server-schemas.ts` - `WireCredentialSchema`, `toCredentialInput`, `CreateServerBodySchema`, `UpdateServerBodySchema`, `ServerIdParamSchema`, `DeleteServerBodySchema`, `ServerViewSchema`, `assertServerViewSchemaKeysMatch`
- `apps/control-plane/src/routes/server-schemas.test.ts` - 18 unit tests for the schema/mapping accept-reject table and the key-set drift guard
- `apps/control-plane/src/routes/servers.ts` - all eight `/api/servers` routes, `sendServiceError`, `enqueueConnect`
- `apps/control-plane/src/routes/api-scope.ts` - registers `serversRoutes`
- `apps/control-plane/src/app.ts` - `getServerServices`/`getQueue` resolvers, `BuildAppDeps.serverServices`/`.queue`, the queue's `onClose` hook
- `tests/integration/helpers/app.ts` - `StartTestAppOptions.redisUrl`
- `tests/integration/services/read-servers.test.ts` - 8 tests for the read services + the nine-member facade
- `tests/integration/routes/servers-crud.test.ts` - 22 tests for the five CRUD routes
- `tests/integration/routes/servers-connect.test.ts` - 9 tests for `/connect`
- `tests/integration/routes/servers-discover.test.ts` - 7 tests for `/discover`
- `tests/integration/services/trust-fingerprint.test.ts` / `fail-in-flight-connection.test.ts` - stale facade-membership assertions updated to the new nine-member shape

## Decisions Made
- See `key-decisions` in the frontmatter above. The most consequential: `reply.code(mapServiceCodeToStatus(code))` does not compile inside a `ZodTypeProvider`-typed route handler, because Fastify's own `.code<Code>` generic narrows `Code` to exactly that route's declared response-status literals. Rather than an unsafe cast, the fix extracts the one status-mapping call into `sendServiceError(reply: FastifyReply, code, message)`, whose parameter type is the bare, non-route-generic `FastifyReply` — a concrete route-typed reply is still structurally assignable to it, so every failure branch stays cast-free.
- `jobId` is `connect-<serverId>` (hyphen) throughout this plan's tests and code, matching Plan 04-06's own already-recorded deviation (BullMQ 6.x rejects a custom `jobId` containing exactly one `:`) rather than 04-CONTEXT.md's literal `connect:<id>` — no new deviation, just consistent use of the already-corrected format.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 3 - Blocking] `reply.code(mapServiceCodeToStatus(...))` does not type-check under Fastify's ZodTypeProvider**
- **Found during:** Task 2, first `pnpm typecheck` after writing `servers.ts`'s five CRUD handlers
- **Issue:** Fastify's own `FastifyReply.code<Code>` generic is narrowed by `@fastify/type-provider-zod`'s route typing to exactly the numeric status literals declared in that specific route's `response` schema (e.g. `201 | 400 | 401 | 409`). A runtime-computed `number` from `mapServiceCodeToStatus(result.code)` can never satisfy that literal-union constraint, so every service-result failure branch failed `tsc` with `TS2345`.
- **Fix:** Extracted the status-mapping call into a standalone `sendServiceError(reply: FastifyReply, code: string, message: string)` function whose `reply` parameter is typed as the bare, non-route-generic `FastifyReply` (Fastify's own generic defaults there resolve `Code` to plain `number`). Every handler's concrete, route-typed `reply` object is structurally assignable to that wider parameter type, so no `as any`/`as never` cast was needed anywhere.
- **Files modified:** `apps/control-plane/src/routes/servers.ts`
- **Verification:** `pnpm --filter @noodara/control-plane typecheck` and `lint` both exit 0; all 6 service-result failure branches route through `sendServiceError`; `grep -c "reply.code(4\|reply.code(5"` on the file is 0.
- **Committed in:** `516d7ea` (Task 2 commit)

**2. [Rule 3 - Blocking] `app.decorate('getQueue', getQueue)` destructuring tripped `@typescript-eslint/unbound-method`**
- **Found during:** Task 3, first `pnpm lint` after wiring `createQueueResolver`'s destructured return
- **Issue:** The resolver's return type declared `getQueue`/`closeOwnedResources` with TypeScript method-shorthand syntax (`getQueue(): Promise<...>`), which ESLint's `unbound-method` rule flags on destructuring — a genuine risk for interfaces mixing `this`-bound methods, though these two closures never read `this`.
- **Fix:** Changed the return type's two members to plain function-typed properties (`getQueue: () => Promise<...>`) instead of method shorthand — semantically identical, but no longer triggers the rule.
- **Files modified:** `apps/control-plane/src/app.ts`
- **Verification:** `pnpm --filter @noodara/control-plane lint` and `typecheck` both exit 0.
- **Committed in:** `59a2e66` (Task 3 commit)

**3. [Rule 3 - Blocking] `tests/integration/helpers/app.ts`'s `startTestApp()` had no way to point the app's queue at a real Redis**
- **Found during:** Task 3, before writing `servers-connect.test.ts`/`servers-discover.test.ts`
- **Issue:** The plan's own Task 3 instructions require RED tests built "on `startTestApp()` plus `startRedis()`", but `startTestApp()`'s `setTestEnv` unconditionally hardcoded `REDIS_URL = 'redis://localhost:6379'` (an intentionally-unreachable placeholder from Plan 01-07, since Redis wasn't needed until this phase) — there was no parameter to override it with a real Testcontainers Redis connection string.
- **Fix:** Added an optional `StartTestAppOptions.redisUrl` field (default: the existing placeholder), mirroring the identical `redisUrl` parameter pattern Plan 04-07 already established in `boot-process.ts`'s `buildValidBootEnv` and `worker-fixture.ts`'s own `setTestEnv`.
- **Files modified:** `tests/integration/helpers/app.ts`
- **Verification:** `servers-connect.test.ts`/`servers-discover.test.ts`'s Redis-down and dedupe assertions pass against a real Testcontainers Redis; every pre-existing `startTestApp()` call site (which never passes `redisUrl`) is unaffected.
- **Committed in:** `59a2e66` (Task 3 commit)

---

**Total deviations:** 3 auto-fixed (all Rule 3 — blocking issues required to make the plan's own instructed shape compile, lint and test as written)
**Impact on plan:** No scope creep. All three are mechanical fixes forced by this project's strict `tsc`/ESLint configuration and Fastify's own typed-reply API, or a minimal, precedented test-helper extension already established by an earlier plan in this same phase.

## Issues Encountered
- A full `tests/integration/services/` run executed concurrently with another background test invocation on this shared dev machine produced one spurious `getServer through the factory matches a direct getServerView call` timeout/stray-container failure (Docker resource contention, consistent with this repo's already-documented pattern — see STATE.md Blockers/Concerns). Re-running `tests/integration/services/read-servers.test.ts` in isolation passed cleanly (8/8, 38s), and a subsequent isolated full run of `tests/integration/services/` passed 129/129 — not a defect in this plan's code.
- One genuinely stray `noodara.test=true` Postgres container (already `Exited`, ~3h old, predating this plan's own test runs) was found and removed during final verification; every test run in this plan's own execution asserted zero stray containers via `assertNoStrayTestContainers`/its inline equivalent at the time it ran.

## User Setup Required

None - no external service configuration required.

## Next Phase Readiness
- All eight `/api/servers` routes are live behind the guarded scope, ready for Plan 04-09's SSE stream to push the same `ServerView`/`server.updated` events these routes already read and Plan 04-10's `activityRoutes`/`configRoutes` to join the same scope.
- `app.ts`'s `getQueue`/`getServerServices` resolver pattern is the template Plan 04-09 should reuse for its own SSE-subscriber decorator (with a `preClose` hook instead of `onClose`, per this plan's own note in the code).
- `sendServiceError`'s workaround for Fastify+Zod's typed-reply `.code()` generic is now the established pattern — any future route mapping a runtime status code should reuse it rather than rediscovering the same `tsc` error.
- Per STATE.md's existing note (from 04-01..04-07), SERV-06/DISC-05 are not marked complete from this plan alone — they land across the full 04-02..04-11 span and are re-verified at phase close.
- No blockers for the next plan in the wave.

---
*Phase: 04-http-routes-worker-bullmq-y-sse*
*Completed: 2026-09-17*

## Self-Check: PASSED

All 8 created files verified present on disk; all three task commit hashes (`f9e4a7d`, `516d7ea`, `59a2e66`) verified present in `git log`.
