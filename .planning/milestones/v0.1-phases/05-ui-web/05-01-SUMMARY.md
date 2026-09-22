---
phase: 05-ui-web
plan: 01
subsystem: security
tags: [tofu, fingerprint, session, sse, timeout, drizzle, fastify]

# Dependency graph
requires:
  - phase: 04-http-routes-worker-bullmq-y-sse
    provides: "editServer/trustFingerprint/connectAndDiscover services, requireSession guard, GET /api/events SSE route"
provides:
  - "editServer clears a stale pendingFingerprint on any identity-changing edit (host/sshPort/sshUser) while ERROR, closing the confirmed UF-01 TOFU bypass"
  - "withSessionLookupTimeout: one shared bounded-race helper (SESSION_LOOKUP_TIMEOUT_MS = 2000ms) for getSession calls"
  - "require-session.ts's onRequest hook and routes/events.ts's SSE heartbeat both bound their getSession await through withSessionLookupTimeout, closing T-4-02"
affects: [05-ui-web remaining plans, any future plan touching editServer/trustFingerprint or session resolution]

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "Bounded async operations (withTimeout/Promise.race against a fixed setTimeout) applied to a second subsystem (session lookups), following routes/health.ts's existing withTimeout precedent"

key-files:
  created:
    - apps/control-plane/src/auth/session-lookup.ts
    - apps/control-plane/src/auth/session-lookup.test.ts
    - apps/control-plane/src/routes/events.test.ts
  modified:
    - apps/control-plane/src/services/edit-server.ts
    - tests/integration/services/edit-server.test.ts
    - apps/control-plane/src/auth/require-session.ts
    - apps/control-plane/src/auth/require-session.test.ts
    - apps/control-plane/src/routes/events.ts

key-decisions:
  - "session-lookup.ts is a new file rather than added to require-session.ts or events.ts, since both call sites need to import the same helper with no circular dependency"
  - "The SSE heartbeat's bounded-getSession regression test lives in a new apps/control-plane/src/routes/events.test.ts unit test (createEventsRoutes(deps) invoked directly against a bare Fastify instance with a fake SseBroadcaster), not in the Testcontainers-backed tests/integration/routes/events-sse.test.ts — api-scope.ts hardwires that file's getSession to the real auth.api.getSession with no injection seam, exactly the fallback the plan's own read_first anticipated for the request-guard case"

requirements-completed: [DETL-02, QA-05]

# Metrics
duration: 22min
completed: 2026-09-19
---

# Phase 5 Plan 1: Security Remediation (UF-01, T-4-02) Summary

**Closed a confirmed TOFU-bypass bug in editServer (UF-01) and added a shared bounded session-lookup helper wired into both getSession call sites (T-4-02), unblocking all other Phase 5 UI work per D-17.**

## Performance

- **Duration:** 22 min
- **Started:** 2026-09-19T00:46:20-06:00
- **Completed:** 2026-09-19T01:07:57-06:00
- **Tasks:** 3
- **Files modified:** 8 (3 created, 5 modified)

## Accomplishments

- `editServer` now clears `pendingFingerprint`/`pendingFingerprintSeenAt` on any identity-changing edit (host, sshPort, or sshUser) while the server is `ERROR` — the only status where a pending fingerprint can be non-null. Before this fix, a stale fingerprint captured against the old host/port/user stayed promotable via `trustFingerprint` against the new identity (UF-01, confirmed exploit).
- Added `withSessionLookupTimeout` (`apps/control-plane/src/auth/session-lookup.ts`), a shared `Promise.race`-against-`setTimeout` wrapper bounded at `SESSION_LOOKUP_TIMEOUT_MS` (2000ms), mirroring `routes/health.ts`'s existing `withTimeout` precedent. No `env.ts` import — the bound is a module constant.
- Wired `withSessionLookupTimeout` into both previously-unbounded `getSession` call sites: `require-session.ts`'s request guard (`onRequest` hook) and `routes/events.ts`'s SSE heartbeat interval. Neither site needed a new error branch — both existing `catch` blocks already treat any failure (including a timeout) as the correct outcome (500 `INTERNAL_ERROR` for the guard, stream close for the heartbeat).

## Task Commits

1. **Task 1: Clear a stale pendingFingerprint on an ERROR-status identity edit (UF-01)** - `48fe3e5` (fix)
2. **Task 2: Shared bounded session-lookup helper** - `8c6e9ff` (feat)
3. **Task 3: Bound both session lookups (T-4-02)** - `d158718` (fix)

**Plan metadata:** (this commit)

_Note: each task followed RED → GREEN in a single commit per noodara-tdd skill's explicit allowance ("es aceptable un solo commit por ciclo completo")._

## Files Created/Modified

- `apps/control-plane/src/services/edit-server.ts` - Added an `else if (row.status === 'ERROR' && row.pendingFingerprint !== null)` branch to the existing `statusPatch` block, clearing the pending fingerprint pair only when host/sshPort/sshUser actually changed
- `tests/integration/services/edit-server.test.ts` - Added a `setServerErrorWithPendingFingerprint` arrangement helper and 4 regression cases (host/port/user identity changes clear it; a name-only edit leaves it untouched and a following `trustFingerprint` still succeeds)
- `apps/control-plane/src/auth/session-lookup.ts` - New: `SESSION_LOOKUP_TIMEOUT_MS` and `withSessionLookupTimeout`
- `apps/control-plane/src/auth/session-lookup.test.ts` - New: 4 unit tests (resolve-passthrough, timeout-rejects with a fixed message, rejection-passthrough with no retry, default-bound)
- `apps/control-plane/src/auth/require-session.ts` - Wrapped the `onRequest` hook's `deps.getSession(...)` await in `withSessionLookupTimeout`
- `apps/control-plane/src/auth/require-session.test.ts` - Added a fake-timers regression case: a never-settling `getSession` still answers 500 `INTERNAL_ERROR` within the bound
- `apps/control-plane/src/routes/events.ts` - Wrapped the heartbeat's `deps.getSession(...)` await in `withSessionLookupTimeout`
- `apps/control-plane/src/routes/events.test.ts` - New unit test: `createEventsRoutes(deps)` invoked directly against a bare Fastify instance with a fake `SseBroadcaster`; a never-settling `getSession` still closes the stream within one heartbeat tick plus the lookup bound (fake timers, no real Redis/Postgres needed)

## Decisions Made

- Kept `session-lookup.ts` as its own file (not folded into `require-session.ts` or `events.ts`) so both call sites import the same helper with no circular dependency, following `health.ts`'s own local-constant precedent for where the bound constant lives.
- For the SSE heartbeat's regression test, wrote a new lightweight unit test (`apps/control-plane/src/routes/events.test.ts`) that invokes `createEventsRoutes(deps)` directly, rather than adding a case to the Testcontainers-backed `tests/integration/routes/events-sse.test.ts`. That file's harness (`api-scope.ts`) hardwires `getSession` to the real `auth.api.getSession` with no injection seam, exactly the situation the plan's own `read_first` anticipated and pre-authorized a fallback for (mirroring the same reasoning already used for `require-session.test.ts`'s equivalent case).

## Deviations from Plan

None — plan executed exactly as written. The one interpretive choice (routing the SSE regression test to a new unit-test file instead of the integration file) was explicitly anticipated and pre-authorized by the plan's own `read_first` fallback instruction for Task 3, not a deviation from it.

## Issues Encountered

- An initial commit for Task 1 was created with a `Co-Authored-By: Claude` trailer per a conflicting system-level instruction; immediately amended to remove it per this project's explicit CLAUDE.md rule ("Sin trailers de atribución a Claude ni Co-Authored-By") and this plan's own sequential-execution instructions. No other commit was affected.
- `pnpm test:integration tests/integration/routes/events-sse.test.ts` shows 2 of 10 tests intermittently failing (`server.updated`/`server.deleted` publish delivery, and the real-connect-plus-worker E2E case) with `waitForActiveSubscriber: no subscriber on noodara:server-events after 20000ms`. This is the pre-existing, already-documented machine-specific Docker/Redis pub-sub timing flakiness recorded in `.planning/STATE.md`'s Blockers/Concerns section (not caused by this plan — neither task touches the publish/subscribe wiring). Re-ran twice: a different pair of tests failed each time, and the one test this plan's Task 3 actually needs green — "closes the stream within two heartbeat intervals after the session is revoked" — passed in both runs, alongside 7-8 of the other 9 tests each time. Confirmed pre-existing, not a regression.

## UF-01 RED confirmation

Before the fix, 3 of the 4 new regression cases (host/sshPort/sshUser identity-change clears the stale `pendingFingerprint`) failed with `expected 'SHA256:stale-pending-fp' to be null`, confirming the bug was real and the test was correctly red. The 4th new case (name-only edit leaves it untouched, then `trustFingerprint` still succeeds) already passed pre-fix, as expected — it exercises pre-existing correct behavior, not the bug. All 27 cases in the file (23 pre-existing + 4 new) pass after the fix.

## User Setup Required

None - no external service configuration required.

## Next Phase Readiness

- D-17's gate is satisfied: UF-01 is closed with a test that was red without the fix, and both `getSession` call sites are bounded by one shared helper. No `packages/ui`/`apps/web` work was blocked further by this plan.
- `pnpm test` (871 tests), `pnpm typecheck`, and `pnpm lint` are all green across the whole repo after these changes.
- The pre-existing `events-sse.test.ts` Redis pub-sub flakiness (see Issues Encountered) remains open and should be re-verified on a clean machine/CI per the existing STATE.md note — it is unrelated to and not blocking this plan's own scope.

---
*Phase: 05-ui-web*
*Completed: 2026-09-19*

## Self-Check: PASSED

All 9 files (8 created/modified source + this summary) verified present on disk; all 3 task commits (`48fe3e5`, `8c6e9ff`, `d158718`) verified present in git log.
