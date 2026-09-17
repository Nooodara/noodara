---
phase: 04-http-routes-worker-bullmq-y-sse
plan: 02
subsystem: api
tags: [fastify, zod, http-errors, session-guard, csrf, d-16, d-17, d-29]

requires:
  - phase: 03-servicios-de-aplicaci-n-activity-log-y-redacci-n
    provides: ServiceActor, the five services' non-throwing { ok, code, message } result unions
provides:
  - "SERVICE_ERROR_STATUS / mapServiceCodeToStatus / toErrorBody / toValidationErrorBody (D-16), the single code-to-HTTP-status map every route in this phase and later phases must use"
  - "createRequireSession (D-17): a scoped Fastify session guard that 401s anonymous callers and decorates request.actor"
  - "createOriginGuard (D-29): a CSRF-lite Origin check for mutating requests, no CORS"
  - "auth/fetch-headers.ts: zero-dependency toFetchHeaders, re-exported from services/session-service.ts"
affects: [04-03, 04-04, 04-05, 04-06, 04-07, 04-08, 04-09, 04-10, 04-11]

tech-stack:
  added: []
  patterns:
    - "Frozen error-status table declared with `satisfies Record<ServiceErrorCode, number>`, mirroring packages/domain/server-state.ts's TRANSITIONS idiom, backed by a static exhaustiveness test scanning services/*.ts FailureCode unions"
    - "Guard plugins as plain FastifyPluginCallback/onRequestHookHandler functions, never fastify-plugin-wrapped, so registering them anywhere never breaks Fastify's encapsulation by accident"
    - "Direct invocation of a plugin function against a scope's own `instance` (instead of `instance.register(...)`) as the composition Plan 04-04's api-scope.ts will use so a guard's hook reaches sibling route registrations in the same scope"

key-files:
  created:
    - apps/control-plane/src/routes/http-errors.ts
    - apps/control-plane/src/routes/http-errors.test.ts
    - apps/control-plane/src/auth/fetch-headers.ts
    - apps/control-plane/src/auth/require-session.ts
    - apps/control-plane/src/auth/require-session.test.ts
    - apps/control-plane/src/auth/origin-guard.ts
    - apps/control-plane/src/auth/origin-guard.test.ts
  modified:
    - apps/control-plane/src/services/session-service.ts

key-decisions:
  - "toValidationErrorBody normalizes both AJV-style instancePath (the real shape @fastify/type-provider-zod's createValidationError produces) and a raw Zod path array, preferring instancePath, defaulting to '' — the plan's own signature allows either shape"
  - "requireSession's onRequest hook wraps getSession in try/catch and replies 500 INTERNAL_ERROR itself on rejection, rather than relying on app.ts's not-yet-wired global error handler (Fastify's own default error handler otherwise echoes the raw exception message onto the wire)"
  - "The guard's own test harness invokes createRequireSession(deps) directly against a scope's instance (not via instance.register(...)), since a plain, non-fastify-plugin-wrapped plugin creates its own child encapsulation context when registered normally — sibling routes registered on the outer instance would never see its hook otherwise; this is the composition routes/api-scope.ts (Plan 04-04) will need to use for real"
  - "createOriginGuard implements Fastify's synchronous onRequestHookHandler (done-callback) signature exactly as named in the plan, short-circuiting via reply.send() + return without calling done(), per Fastify's own documented pattern for that hook shape"

patterns-established:
  - "Every new route file in this phase reuses ErrorBodySchema/ValidationErrorBodySchema from routes/http-errors.ts instead of redeclaring z.object({ error, message }) per route"

requirements-completed: []

duration: 30min
completed: 2026-09-17
---

# Phase 4 Plan 2: HTTP error vocabulary, session guard, Origin guard Summary

**Single frozen D-16 error-status map with a drift-detecting static test, a scoped requireSession guard decorating request.actor, and a strict-origin CSRF-lite guard for mutating requests — no Fastify app wiring yet.**

## Performance

- **Duration:** ~30 min
- **Started:** 2026-09-17T06:35:00-06:00 (approx.)
- **Completed:** 2026-09-17T07:01:36-06:00
- **Tasks:** 3
- **Files modified:** 8 (7 created, 1 modified)

## Accomplishments
- `apps/control-plane/src/routes/http-errors.ts`: one frozen `SERVICE_ERROR_STATUS` table (`satisfies Record<ServiceErrorCode, number>`) mapping all 15 D-16 codes to their status, plus `mapServiceCodeToStatus` (500 fallback, never throws), `toErrorBody`, `toValidationErrorBody`, and shared `ErrorBodySchema`/`ValidationErrorBodySchema` Zod schemas. A static exhaustiveness test walks every `.ts` file in `services/` and asserts every quoted code in a `...FailureCode = ...` union has a matching key — manually verified to fail when a key is removed, then restored.
- `apps/control-plane/src/auth/fetch-headers.ts` + `require-session.ts`: `toFetchHeaders` relocated to a zero-dependency file (no `auth`/`db`/`env` imports), and `createRequireSession` returns a plain `FastifyPluginCallback` that decorates `request.actor` as `null` then assigns `{ type: 'user', id }` inside its `onRequest` hook, 401ing with the D-16 body shape when no session resolves, and 500ing (without leaking the rejection message) if `getSession` throws.
- `apps/control-plane/src/auth/origin-guard.ts`: `createOriginGuard({ publicUrl })` returns a synchronous `onRequestHookHandler` that allows `GET`/`HEAD`/`OPTIONS` and an absent `Origin` unconditionally, and rejects a present, parse-mismatched `Origin` on any other method with 403 `FORBIDDEN_ORIGIN`, using strict `===` on the parsed `.origin` (never a prefix/substring check).
- `apps/control-plane/src/services/session-service.ts` now re-exports `toFetchHeaders` from its new home; `routes/sessions.ts`'s existing import keeps compiling unchanged.

## Task Commits

Each task was committed atomically:

1. **Task 1: The single service-code to HTTP-status map** - `fc9ff54` (feat, TDD RED verified before implementation)
2. **Task 2: requireSession plugin decorating request.actor** - `2213153` (feat, TDD RED verified before implementation)
3. **Task 3: CSRF-lite Origin guard for mutating requests** - `472d7cd` (feat, TDD RED verified before implementation)

## Files Created/Modified
- `apps/control-plane/src/routes/http-errors.ts` - `SERVICE_ERROR_STATUS`, `mapServiceCodeToStatus`, `toErrorBody`, `toValidationErrorBody`, `ErrorBodySchema`, `ValidationErrorBodySchema`
- `apps/control-plane/src/routes/http-errors.test.ts` - table-driven status tests, error-body shape tests, static exhaustiveness scan + non-vacuity guard
- `apps/control-plane/src/auth/fetch-headers.ts` - relocated `toFetchHeaders`, zero-dependency
- `apps/control-plane/src/auth/require-session.ts` - `createRequireSession`, `SessionResolver`, `request.actor` module augmentation
- `apps/control-plane/src/auth/require-session.test.ts` - 401/actor-decoration/scope-encapsulation/headers/rejection tests plus `toFetchHeaders` unit tests
- `apps/control-plane/src/auth/origin-guard.ts` - `createOriginGuard`
- `apps/control-plane/src/auth/origin-guard.test.ts` - allow/reject matrix across methods, trailing-slash/scheme/subdomain-spoof/invalid-header edge cases
- `apps/control-plane/src/services/session-service.ts` - `toFetchHeaders` re-export, local definition removed

## Decisions Made
- `toValidationErrorBody` prefers `instancePath` (the actual shape `@fastify/type-provider-zod`'s `createValidationError` produces) and falls back to a joined `path` array, matching the plan's own `{ instancePath?: string; path?: unknown; message?: string }` signature.
- `requireSession`'s hook catches a `getSession` rejection itself and replies opaque 500 `INTERNAL_ERROR`, since Fastify's own default error handler (no custom handler exists yet at this point in the phase) otherwise echoes the raw exception message onto the wire — this is required by the plan's own behavior list ("the rejection message is not present in the response body"), not an extra feature.
- `require-session.test.ts`'s test harness invokes `createRequireSession(deps)` directly against a scope's `instance` rather than through `instance.register(...)`, because a plain (non-`fastify-plugin`) plugin creates its own child encapsulation context when registered the normal way — a sibling route registered on the outer `instance` afterwards would never see its hook. This is documented in the test file as the exact composition `routes/api-scope.ts` (Plan 04-04) will need for the real guard to actually cover `/api/servers`, `/api/activity`, `/api/config` and `/api/events`.
- `createOriginGuard` implements Fastify's synchronous, `done`-callback `onRequestHookHandler` signature literally as named in the plan (not the 2-arg async variant), short-circuiting with `reply.send()` + `return` without calling `done()`, matching Fastify's own documented pattern for that hook shape.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 2 - Missing Critical] requireSession's onRequest hook catches a getSession rejection and replies opaque 500**
- **Found during:** Task 2 (require-session plugin)
- **Issue:** The plan's own behavior list requires "a rejected getSession results in a 500 ... and the rejection message is not present in the response body". Without a try/catch, Fastify's default error handler (no custom `app.setErrorHandler` exists at this point in the phase) echoes the raw `Error.message` into the JSON body, leaking whatever internal detail the rejection carried.
- **Fix:** Wrapped the `getSession` call in try/catch inside the `onRequest` hook; on rejection, logs `{ err }` and replies `500 { error: 'INTERNAL_ERROR', message: 'Internal error' }` via `toErrorBody`, matching D-22's eventual global shape.
- **Files modified:** `apps/control-plane/src/auth/require-session.ts`
- **Verification:** `require-session.test.ts`'s rejection test passes; `response.body` never contains the injected canary string.
- **Committed in:** `2213153` (Task 2 commit)

**2. [Rule 1 - Bug] Test harness redesigned to invoke the guard plugin directly instead of nesting it via `instance.register(...)`**
- **Found during:** Task 2 (require-session plugin) — RED verification
- **Issue:** The first test-harness draft (`instance.register(createRequireSession(...)); instance.get('/inside', ...)`) never applied the guard's hook to the probe route at all — Fastify creates a new child encapsulation context per `.register()` call, and hooks never flow to a sibling context. A repro script confirmed this empirically. All four behavior-dependent tests failed with the guard silently inert.
- **Fix:** Rewrote the harness to invoke the returned plugin function directly against the scope's own `instance` (`createRequireSession({ getSession })(instance, {}, () => { instance.get('/inside', ...); done(); })`), which attaches the decoration/hook directly to `instance`, so the sibling probe route (also on `instance`) inherits it.
- **Files modified:** `apps/control-plane/src/auth/require-session.test.ts`
- **Verification:** All 7 tests in the file pass; the "sibling route outside the scope" test still confirms true encapsulation (a truly top-level route registered on `app`, not `instance`, stays anonymous).
- **Committed in:** `2213153` (Task 2 commit)

---

**Total deviations:** 2 auto-fixed (1 missing critical, 1 bug in test design)
**Impact on plan:** Both fixes were required to satisfy the plan's own stated behaviors; no scope creep. The test-harness fix also surfaces a real composition detail Plan 04-04 must apply when wiring the real `/api` scope.

## Issues Encountered
None beyond the deviations above.

## User Setup Required

None - no external service configuration required.

## Next Phase Readiness
- `mapServiceCodeToStatus`/`toErrorBody`/`toValidationErrorBody`/`ErrorBodySchema`/`ValidationErrorBodySchema` are ready for every route Plans 04-03 through 04-11 write.
- `createRequireSession` and `createOriginGuard` are ready for `routes/api-scope.ts` (Plan 04-04) to bind to the real `auth.api.getSession` and `env.NOODARA_PUBLIC_URL` respectively, using the direct-invocation composition documented in this plan's test file so the guard's hook actually reaches the grouped routes.
- No blockers for the next plan in the wave. `requirements-completed` is empty here: SERV-06/DISC-05 (this plan's frontmatter `requirements`) land across the full 04-02..04-11 span, matching STATE.md's existing note about 04-01's own premature `requirements: [SERV-06]` marker — not re-marking complete from a single infra/vocabulary plan.

---
*Phase: 04-http-routes-worker-bullmq-y-sse*
*Completed: 2026-09-17*

## Self-Check: PASSED

All 8 created/modified files verified present on disk; all three task commit hashes (`fc9ff54`, `2213153`, `472d7cd`) verified present in `git log`.
