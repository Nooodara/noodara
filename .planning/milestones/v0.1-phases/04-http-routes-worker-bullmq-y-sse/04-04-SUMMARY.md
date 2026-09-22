---
phase: 04-http-routes-worker-bullmq-y-sse
plan: 04
subsystem: api
tags: [fastify, zod, error-handler, session-guard, csrf, d-16, d-17, d-18, d-21, d-22, d-29]

requires:
  - phase: 04-http-routes-worker-bullmq-y-sse
    provides: "mapServiceCodeToStatus/toErrorBody/toValidationErrorBody/ErrorBodySchema (04-02), createRequireSession/createOriginGuard (04-02)"
provides:
  - "CONTROL_PLANE_VERSION (config-version.ts) — one version source for /health and (later) /api/config"
  - "app.ts's single global setErrorHandler: Zod validation -> 400 VALIDATION_FAILED, response serialization mismatch -> 500 INTERNAL_ERROR, everything else -> redacted opaque 500"
  - "routes/api-scope.ts: the real, wired guarded scope (origin guard + requireSession bound to auth.api.getSession) hosting sessionsRoutes today and every future /api/servers|/api/activity|/api/config|/api/events route"
  - "setup.ts/sessions.ts migrated to the shared { error: 'UPPER_SNAKE', message } body shape (D-18) with zero change to any status code or auth semantics"
  - "startTestApp({ buildLogger }) — lets an integration test capture real emitted log output without importing an env-sensitive module before the test environment is valid"
affects: [04-05, 04-06, 04-07, 04-08, 04-09, 04-10, 04-11]

tech-stack:
  added: []
  patterns:
    - "createRequireSession(deps) invoked directly against api-scope.ts's own fastify instance, never via fastify.register(...) — confirms and reuses Plan 04-02's own discovered composition rule"
    - "Origin guard hook registered before requireSession's onRequest hook in the guarded scope, so a cross-origin mutation is rejected before an auth lookup is spent on it"
    - "config-version.ts stays at depth 1 directly under src/ so a single ../package.json relative specifier resolves identically under tsx, node dist/ and Vitest (ADR 0003)"

key-files:
  created:
    - apps/control-plane/src/config-version.ts
    - apps/control-plane/src/config-version.test.ts
    - apps/control-plane/src/routes/api-scope.ts
    - tests/integration/routes/error-handler.test.ts
    - tests/integration/routes/api-scope.test.ts
  modified:
    - apps/control-plane/src/routes/health.ts
    - apps/control-plane/src/routes/setup.ts
    - apps/control-plane/src/routes/sessions.ts
    - apps/control-plane/src/app.ts
    - tests/integration/helpers/app.ts
    - tests/integration/auth/setup.test.ts
    - tests/integration/auth/session-management.test.ts
    - package.json
    - pnpm-lock.yaml

key-decisions:
  - "zod promoted to a root devDependency (same 4.6.1 pin already installed and used by apps/control-plane) so tests/integration/routes/*.test.ts can register Zod-schema probe routes directly — same pnpm workspace-symlink fix Phase 1/04-01 applied to drizzle-orm/@noodara/domain/ioredis"
  - "startTestApp() gained a buildLogger callback (not a plain logger instance) invoked after setTestEnv but before buildApp() — importing logger.ts (which imports env.ts) before the test environment is valid crashes with process.exit(1); a plain instance option would have forced that import too early"
  - "Origin guard registered before requireSession in api-scope.ts's hook chain — a cross-origin mutating request is rejected before spending a session lookup on it, and the new api-scope.test.ts proves FORBIDDEN_ORIGIN fires even for an authenticated caller"
  - "setup.ts's 404 message is a fixed 'Not found' string (not echoing anything from the request) since D-02's whole point is that the route's existence is never confirmed to a caller"

patterns-established:
  - "Every future guarded route (serversRoutes 04-08, eventsRoutes 04-09, activityRoutes/configRoutes 04-10) joins routes/api-scope.ts's existing fastify.register(...) list inside the same requireSession callback — api-scope.ts's own comment documents the exact ordered extension point"

requirements-completed: []

duration: 125min
completed: 2026-09-17
---

# Phase 4 Plan 4: Global error handler, guarded /api scope, D-18 error-shape migration Summary

**One `app.setErrorHandler` that turns every unhandled exception into an opaque redacted 500 and normalizes Zod validation failures, one real guarded `/api` scope wired to Better Auth, and `setup.ts`/`sessions.ts`/`health.ts` migrated to the shared `{ error, message }` vocabulary with zero change to any status code.**

## Performance

- **Duration:** ~125 min
- **Started:** 2026-09-17T09:51:00-06:00 (approx.)
- **Completed:** 2026-09-17T11:53:36-06:00
- **Tasks:** 3
- **Files modified:** 14 (5 created, 9 modified)

## Accomplishments
- `config-version.ts` reads `CONTROL_PLANE_VERSION` from `apps/control-plane/package.json` via `createRequire(import.meta.url)`, resolving identically under `tsx watch`, `node dist/*.js` and Vitest (verified against the built `dist/config-version.js` directly); `/health` no longer returns the hardcoded `'0.0.0'`.
- `app.ts` now has a single `setErrorHandler` with exactly three branches in order: Zod schema validation failures normalize to `400 VALIDATION_FAILED` with `{ path, message }`-only issues; a response-serialization mismatch is always a server bug (`500 INTERNAL_ERROR`, logged at error level, never a 4xx); everything else logs `appRedactor.redact(error.message)` with the request id and replies an opaque `500 { error: 'INTERNAL_ERROR', message: 'Internal error' }` that leaks neither the original message nor a stack. A canary integration test proves the process stays alive (`/health` still 200 after the throw) and the raw secret appears in neither the response body nor the captured log output.
- `routes/api-scope.ts` is the real, wired guarded scope: a CSRF-lite `Origin` check runs first, then `createRequireSession` (bound to the real `auth.api.getSession`) is invoked *directly* against the scope's own Fastify instance — not via `.register(...)` — reusing the exact composition Plan 04-02's own test file discovered is required for a plain plugin's hook to reach sibling routes. `sessionsRoutes` is the first route plugin registered inside it; the file's own comment names the ordered extension point (`serversRoutes`, `eventsRoutes`, `activityRoutes`, `configRoutes`) for the rest of the phase.
- `setup.ts` and `sessions.ts` migrated to `{ error: 'UPPER_SNAKE', message }` everywhere (`not_found` → `NOT_FOUND`, `unauthorized` → `UNAUTHORIZED`, and the setup service's own already-UPPER_SNAKE codes passed through `toErrorBody` unchanged) — every pre-existing status code, the `adminExists()` 404-gate ordering, and every Phase 1 auth rule stayed byte-identical, proven by extending `setup.test.ts`/`session-management.test.ts` with body-shape assertions alongside their existing status-code assertions (none of which changed).
- A new `tests/integration/routes/api-scope.test.ts` proves the full D-17/D-29 guarded/unguarded matrix: `/api/sessions` 401s anonymously with the new shape, `/health`/`/api/setup`/`/api/recovery` stay reachable with no session, `/api/setup` still 404s (never 403) once an admin exists, a foreign `Origin` on a `DELETE` gets `403 FORBIDDEN_ORIGIN` even for an authenticated caller, and a mismatched `Origin` on a `GET` is unaffected (the guard is mutation-only).

## Task Commits

Each task was committed atomically:

1. **Task 1: Real package version shared by /health and (later) /api/config** - `035f377` (feat, TDD RED verified before implementation)
2. **Task 2: Global error handler — opaque 500s, normalised Zod errors, live process** - `c21dfeb` (feat, TDD RED verified before implementation)
3. **Task 3: The guarded /api scope and the D-18 error-shape migration** - `4e62469` (feat, TDD RED verified before implementation)

_Note: each task's RED was run and confirmed failing for the stated reason (missing module; Fastify's own default error-handler shape; lowercase literal bodies / no session guard) before implementing GREEN; each task landed as one commit per the noodara-tdd skill's "one commit per full cycle is acceptable" allowance._

## Files Created/Modified
- `apps/control-plane/src/config-version.ts` - `CONTROL_PLANE_VERSION` read from `../package.json`
- `apps/control-plane/src/config-version.test.ts` - asserts equality against an independently-read `package.json`, never a hardcoded literal
- `apps/control-plane/src/routes/health.ts` - imports the shared constant, drops the local `'0.0.0'`
- `apps/control-plane/src/app.ts` - `setErrorHandler` (3 branches), registers `apiScope` instead of `sessionsRoutes` directly
- `apps/control-plane/src/routes/api-scope.ts` - the guarded scope: origin guard + `createRequireSession` bound to real Better Auth, hosts `sessionsRoutes`
- `apps/control-plane/src/routes/setup.ts` / `sessions.ts` - migrated error bodies/schemas to `ErrorBodySchema`/`toErrorBody`
- `tests/integration/helpers/app.ts` - `StartTestAppOptions.buildLogger` callback
- `tests/integration/routes/error-handler.test.ts` - global error handler proof (throw, Zod validation, response serialization, explicit 4xx pass-through)
- `tests/integration/routes/api-scope.test.ts` - guarded/unguarded matrix + Origin guard proof
- `tests/integration/auth/setup.test.ts` / `session-management.test.ts` - added body-shape assertions alongside unchanged status-code assertions
- `package.json` / `pnpm-lock.yaml` - `zod` promoted to a root devDependency

## Decisions Made
- `zod` promoted to a root devDependency (same `4.6.1` pin already provenance-approved and installed under `apps/control-plane`) so `tests/integration/routes/*.test.ts` can build Zod-schema probe routes directly — pnpm's isolated `node_modules` never hoists a workspace package's own dependency to the root, the same recurring fix Phase 1 and Plan 04-01 applied to `drizzle-orm`/`@noodara/domain`/`ioredis`.
- `startTestApp()`'s new option is a `buildLogger` *callback* invoked after `setTestEnv()` has already run, not a plain pre-built logger instance — `logger.ts` imports `env.ts`, which fail-fasts against `process.env` at *import time*; a test that imported `logger.ts` at the top of its own `it()` body (before `startTestApp()` set a valid environment) crashed with `process.exit(1)`. The callback shape keeps that import inside the safe window.
- Origin guard registered before `requireSession` in `api-scope.ts`'s hook chain: a cross-origin mutating request is rejected before spending a session lookup on it, and this ordering is what lets `api-scope.test.ts` assert `403 FORBIDDEN_ORIGIN` for an *authenticated* caller with a foreign `Origin` header without depending on hook-registration internals.
- `setup.ts`'s 404 body uses a fixed `'Not found'` message with no request-derived content, preserving D-02's "never confirm this route exists" guarantee at the message level too, not just the status code.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 3 - Blocking] Promoted `zod` to a root devDependency**
- **Found during:** Task 2 (writing `tests/integration/routes/error-handler.test.ts`)
- **Issue:** The new root-level test file needs `import { z } from 'zod'` to build Zod-schema probe routes, but `zod` was only installed under `apps/control-plane`'s `dependencies` — pnpm's isolated `node_modules` never symlinks a workspace package's own dependency up to the workspace root, so the import failed with `Cannot find package 'zod'`.
- **Fix:** Ran `pnpm add -D zod@4.6.1 -w` — the identical, already-installed exact pin, not a new or unverified install.
- **Files modified:** `package.json`, `pnpm-lock.yaml`
- **Verification:** `error-handler.test.ts` and `api-scope.test.ts` both import `zod`/`@fastify/type-provider-zod` cleanly; `pnpm install --frozen-lockfile` still succeeds.
- **Committed in:** `c21dfeb` (Task 2 commit)

**2. [Rule 1 - Bug] `error: FastifyError` type annotation needed on the error handler's first parameter**
- **Found during:** Task 2, first `pnpm build` after writing `app.ts`'s `setErrorHandler`
- **Issue:** Fastify's `setErrorHandler<TError = unknown>` defaults its error parameter to `unknown` when no generic is supplied; `error.message` on the fallback branch failed `tsc` with `'error' is of type 'unknown'`.
- **Fix:** Annotated the handler's first parameter as `(error: FastifyError, request, reply)`, importing `FastifyError` as a type from `fastify`. `FastifyError extends Error`, so it still satisfies `hasZodFastifySchemaValidationErrors`/`isResponseSerializationError`'s own `unknown`-typed parameters.
- **Files modified:** `apps/control-plane/src/app.ts`
- **Verification:** `pnpm --filter @noodara/control-plane typecheck` exits 0; `pnpm build` succeeds.
- **Committed in:** `c21dfeb` (Task 2 commit)

**3. [Rule 1 - Bug] Test canary must be registered with `appRedactor` before asserting it is redacted**
- **Found during:** Task 2, first GREEN run of `error-handler.test.ts`
- **Issue:** The first draft of the "unhandled throw" test asserted the captured log never contains an unregistered random canary string. `appRedactor.redact()` only scrubs values it has been told about via `.register(...)` (matching `tests/integration/activity/canary.test.ts`'s own established pattern) — an arbitrary unregistered string legitimately passes through unredacted, so the assertion failed for the wrong reason (proving nothing about the error handler).
- **Fix:** Registered the canary with `appRedactor.register(canary, 'test_canary')` before triggering the throw and released it in a `finally` block, mirroring the canary test's own lifecycle.
- **Files modified:** `tests/integration/routes/error-handler.test.ts`
- **Verification:** The test now correctly proves the error handler routes `error.message` through `appRedactor.redact` before logging.
- **Committed in:** `c21dfeb` (Task 2 commit)

---

**Total deviations:** 3 auto-fixed (1 blocking, 2 bugs — one in production code, one in test design)
**Impact on plan:** No scope creep. All three were required to make the plan's own instructed behavior compile/pass; the zod promotion mirrors an already-established, repeatedly-applied precedent from Phase 1 and Plan 04-01.

## Issues Encountered
- Running two `vitest run --config vitest.integration.config.ts` invocations concurrently against different file sets on this shared dev machine produced a cascading `assertNoStrayTestContainers` failure across 60/65 tests (both processes' Postgres/Testcontainers fixtures raced on the same Docker host). Re-running the exact same file set sequentially (no concurrent second invocation) passed cleanly at 65/65 with zero stray containers — a self-inflicted execution-environment artifact, not a defect in this plan's code, consistent with this repo's existing documented pattern of shared-machine Docker/Testcontainers resource contention (see STATE.md's Blockers/Concerns and Phase 3's `deferred-items.md`).

## User Setup Required

None - no external service configuration required.

## Next Phase Readiness
- `routes/api-scope.ts` is ready for Plan 04-08 (`serversRoutes`), Plan 04-09 (`eventsRoutes`) and Plan 04-10 (`activityRoutes`/`configRoutes`) to each add their own `fastify.register(...)` call inside the same guarded scope, per the file's own ordered-extension-point comment — no further restructuring needed.
- `app.ts`'s global error handler and `CONTROL_PLANE_VERSION` are ready for every later route in this phase; no route should ever call its own `setErrorHandler` again.
- Per STATE.md's existing note (from 04-01/04-02/04-03), SERV-06/DISC-05 are not marked complete from this plan alone — they land across the full 04-02..04-11 span and are re-verified at phase close. This plan's own frontmatter `requirements: [SERV-06]` is intentionally not re-marked complete here, matching the orchestrator's instruction for this plan.
- No blockers for the next plan in the wave.

---
*Phase: 04-http-routes-worker-bullmq-y-sse*
*Completed: 2026-09-17*

## Self-Check: PASSED

All created/modified files verified present on disk; all four commit hashes (`035f377`, `c21dfeb`, `4e62469`, `720da47`) verified present in `git log`.
