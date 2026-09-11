---
phase: 01-dominio-persistencia-y-autenticacion
plan: 11
subsystem: auth
tags: [better-auth, session, drizzle, fastify, zod, activity-log]

# Dependency graph
requires:
  - phase: 01-dominio-persistencia-y-autenticacion
    provides: "apps/control-plane's auth.ts/hooks.ts and session-policy.ts's owned stub (Plan 01-10)"
  - phase: 01-dominio-persistencia-y-autenticacion
    provides: "sessions table's absolute_expires_at/last_seen_at columns and Testcontainers harness (Plan 01-07)"
  - phase: 01-dominio-persistencia-y-autenticacion
    provides: "writeActivityEvent() as the single activity-log writer, AUTH_ACTIONS' auth.session_revoked (Plan 01-09)"
provides:
  - "apps/control-plane/src/auth/session-policy.ts: the live D-05 sliding-7-day/hard-30-day-ceiling session config plus databaseHooks.session create/update clamp, closing RESEARCH Open Question 1"
  - "apps/control-plane/src/services/session-service.ts: listSessions()/revokeSession()/revokeOtherSessions() — the D-06 application service, the only writer of auth.session_revoked besides its own callers"
  - "apps/control-plane/src/routes/sessions.ts: GET /api/sessions, DELETE /api/sessions/:id, DELETE /api/sessions with explicit Zod output schemas"
  - "tests/integration/auth/{session-lifetime,session-management}.test.ts: real-PostgreSQL proof of D-05/D-06/AUTH-03/AUTH-05"
affects: ["01-12", "01-13", "01-14", "phase-5-settings-ui"]

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "session-policy.ts's additionalFields.absoluteExpiresAt keeps its default returned visibility (no returned:false): Better Auth's own findSession() runs every fetched row through parseSessionOutput, which strips any returned:false field, before ctx.context.session is set — the exact object session.update.before reads the stored ceiling back from. Hiding the field would make the update hook's own clamp blind to it. lastSeenAt keeps returned:false since nothing needs to read it back through that path; the session-listing endpoint reads it via a direct Drizzle query instead."
    - "session.update.before only ever receives the fields being written (typically just {expiresAt, updatedAt}), never the session row's other columns — the currently-stored absolute_expires_at has to come from context.context.session.session (the row Better Auth already fetched earlier in the same request), not from the hook's own session parameter. Confirmed by reading the installed better-auth/@better-auth/core db/with-hooks.mjs and api/routes/session.mjs source, not assumed from docs prose."
    - "sessionPolicy.clock is a plain mutable () => Date property (not a vitest mock) so create/update hook unit tests can override it deterministically without vi.setSystemTime; integration tests instead manipulate the database's own stored timestamps directly, since it's the DB row (not the Node process clock) that Better Auth's own refresh calculation and the update hook both read."
    - "session-service.ts's listSessions/revokeSession/revokeOtherSessions query the sessions table directly via this app's own getDb() Drizzle handle rather than through auth.api.listSessions/revokeSession/revokeOtherSessions: (1) Better Auth's own revokeSession is keyed by token (not this app's sessions.id) and silently no-ops for a token the caller doesn't own, never surfacing the not-my-session 404 T-1-32 requires; (2) Better Auth's own db pool (opened inside auth.ts) is a separate Postgres connection from getDb(), so a call through auth.api.* could never share one transaction with writeActivityEvent anyway; (3) auth.api.listSessions' parsed output strips lastSeenAt (returned:false), which D-06 requires in the listing. auth.api.getSession is still used, for authentication only (resolving the caller's user id and session id from their cookie)."
    - "Every revocation (single or bulk) runs inside one db.transaction() alongside its own writeActivityEvent call — real atomicity between the sessions-row delete and the auth.session_revoked insert, achievable only because both go through the same Drizzle handle."

key-files:
  created:
    - apps/control-plane/src/auth/session-policy.test.ts
    - apps/control-plane/src/services/session-service.ts
    - tests/integration/auth/session-lifetime.test.ts
    - tests/integration/auth/session-management.test.ts
  modified:
    - apps/control-plane/src/auth/session-policy.ts
    - apps/control-plane/src/routes/sessions.ts

key-decisions:
  - "expiresIn/updateAge are set to the 7-day/1-day NOODARA_SESSION_SLIDING_SECONDS/NOODARA_SESSION_UPDATE_AGE_SECONDS values directly (Better Auth's own semantics for those two options already match D-05's 'renews at most once per day' literally); the 30-day ceiling is a separate absolute_expires_at column clamped on every refresh, not a second pair of expiresIn/updateAge values — expiresIn: 30d, updateAge: 7d (RESEARCH Pattern 2's original sketch) was explicitly rejected since that makes 30 days the sliding window itself"
  - "absoluteExpiresAt's additionalFields entry omits returned:false (unlike the Plan 01-10 stub) specifically so session.update.before's context.context.session read can see it; this is not a security loosening since a session's absolute-expiry timestamp is no more sensitive than expiresAt itself, which Better Auth already returns"
  - "session-service.ts bypasses auth.api.listSessions/revokeSession/revokeOtherSessions for all data operations and uses direct Drizzle queries against the sessions table instead, for the three reasons in patterns-established above — auth.api.getSession remains the sole Better Auth call, for authentication only"

requirements-completed: [AUTH-03, AUTH-05]

# Metrics
duration: 100min
completed: 2026-09-11
---

# Phase 1 Plan 11: Sliding Session Ceiling and Multi-Session Management Summary

**D-05's 7-day sliding session with a structural 30-day ceiling (closing RESEARCH Open Question 1 with a real `databaseHooks.session` clamp, not a reading of the docs) plus D-06's session-listing and revocation endpoints, each revocation writing an atomic `auth.session_revoked` activity event.**

## Performance

- **Duration:** ~100 min
- **Started:** 2026-09-11T14:10:00-06:00 (approx.)
- **Completed:** 2026-09-11T16:05:00-06:00
- **Tasks:** 2 (both TDD)
- **Files modified:** 4 created, 2 modified

## Accomplishments
- `session-policy.ts`: `expiresIn`/`updateAge` wired to `NOODARA_SESSION_SLIDING_SECONDS`/`NOODARA_SESSION_UPDATE_AGE_SECONDS`; `databaseHooks.session.create.before` sets `absoluteExpiresAt` from `createdAt + NOODARA_SESSION_ABSOLUTE_SECONDS` and `lastSeenAt` to `createdAt`; `session.update.before` sets `lastSeenAt` to now and clamps any proposed `expiresAt` to the stored ceiling via `clampExpiry`. `clampExpiry` and the two hook functions are unit-tested directly (10 tests); five database-backed integration tests prove: fresh-session timestamps land within 60s of the expected 7-day/30-day marks, a same-day second request leaves `expires_at` byte-identical, a refresh past `updateAge` extends `expires_at` without exceeding `absolute_expires_at`, a backdated `absolute_expires_at` clamps a refresh's `expires_at` into the past and the cookie is rejected on the next request, and a session simply left idle past `expires_at` is rejected.
- `session-service.ts` + `routes/sessions.ts`: `GET /api/sessions` (401 without a cookie, otherwise every active session with `id`/`userAgent`/`ipAddress`/`createdAt`/`lastSeenAt`/`expiresAt`/`isCurrent`, exactly one `isCurrent: true`, no token anywhere in the response body), `DELETE /api/sessions/:id` (revokes an owned session — including the caller's own, which behaves like a sign-out — 404 for a missing or not-owned id, never 403), `DELETE /api/sessions` (revokes every other session, current cookie still works). Every revocation runs inside one `db.transaction()` with its own `writeActivityEvent` call, so the delete and the `auth.session_revoked` row are atomic; metadata carries the session id and never a token.
- Full command chain green: `pnpm lint`, `pnpm typecheck`, `pnpm build`, `pnpm test` (306/306, up from 296), `pnpm test:integration` (63/63, up from 50), `pnpm exec turbo boundaries`; zero `noodara.test=true` containers left running; neither `auth.ts` nor `app.ts` was touched.

## Task Commits

Each task was committed atomically (TDD tasks have separate RED/GREEN commits):

1. **Task 1 (RED): failing session-policy.test.ts and session-lifetime.test.ts** - `40dcf2a` (test)
   **Task 1 (GREEN): session-policy.ts's D-05 config and create/update hooks** - `f43ea11` (feat)
2. **Task 2 (RED): failing session-management.test.ts** - `6f3ac07` (test)
   **Task 2 (GREEN): session-service.ts and routes/sessions.ts** - `70d5c5f` (feat)

**Plan metadata:** _(final metadata commit follows this summary)_

## Files Created/Modified
- `apps/control-plane/src/auth/session-policy.ts` - D-05 config (`expiresIn`/`updateAge`/`additionalFields`) plus `create`/`update` database hooks and `clampExpiry`
- `apps/control-plane/src/auth/session-policy.test.ts` - Unit coverage for `clampExpiry`, config values, and both hooks called directly
- `apps/control-plane/src/services/session-service.ts` - `listSessions`/`revokeSession`/`revokeOtherSessions`, `toFetchHeaders`, `UnauthorizedError`/`SessionNotFoundError`
- `apps/control-plane/src/routes/sessions.ts` - The three D-06 routes with explicit Zod response schemas
- `tests/integration/auth/session-lifetime.test.ts` - D-05 real-PostgreSQL proof (5 tests)
- `tests/integration/auth/session-management.test.ts` - D-06 real-PostgreSQL proof (8 tests)

## Decisions Made
See `key-decisions` in the frontmatter for the three decisions with the most downstream impact (the `expiresIn`/`updateAge`-plus-separate-ceiling mechanism, dropping `absoluteExpiresAt`'s `returned:false`, and bypassing `auth.api.listSessions`/`revokeSession`/`revokeOtherSessions` for direct Drizzle queries).

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] `absoluteExpiresAt`'s `returned: false` made `session.update.before`'s own clamp blind to the stored ceiling**
- **Found during:** Task 1, first integration-test run against the real GREEN implementation
- **Issue:** The initial implementation kept the Plan 01-10 stub's `returned: false` on `additionalFields.absoluteExpiresAt`. Reading the installed `better-auth` internal-adapter source showed `findSession()` runs every fetched row through `parseSessionOutput` — which strips any `returned: false` field — *before* `ctx.context.session` is set. Since `session.update.before` can only read the row's other columns back through `context.context.session.session` (the update itself only ever receives the fields being written, e.g. `{expiresAt, updatedAt}`), the hook's clamp was reading `undefined` for the ceiling and silently skipping it — the "clamps expires_at into the past" integration test failed with the un-clamped, still-future `expires_at`.
- **Fix:** Removed `returned: false` from `absoluteExpiresAt`'s field definition (kept on `lastSeenAt`, which nothing needs to read back through this path). Not a security loosening: a session's absolute-expiry timestamp is no more sensitive than `expiresAt` itself, which Better Auth already returns from every session endpoint.
- **Files modified:** apps/control-plane/src/auth/session-policy.ts
- **Verification:** All 5 `session-lifetime.test.ts` tests pass, including the previously-failing ceiling-clamp case.
- **Committed in:** `f43ea11`

**2. [Rule 1 - Bug] `createAdmin`'s sign-up call also creates a session, so the session-listing test's expected count was off by one**
- **Found during:** Task 2, first run of the "lists every session" integration test
- **Issue:** `createAdmin` signs up via `/sign-up/email`; Better Auth auto-signs-in on sign-up, which itself creates one session in addition to the three explicit `signIn` calls the test makes — the test asserted 3 sessions and got 4.
- **Fix:** Corrected the expected count to 4 with an explanatory comment; the `isCurrent`/no-token assertions were unaffected.
- **Files modified:** tests/integration/auth/session-management.test.ts
- **Verification:** `session-management.test.ts` (8/8) passes.
- **Committed in:** `6f3ac07` → `70d5c5f`

**3. [Rule 1 - Bug] `db.execute()`'s raw driver result returned timestamp columns as strings, not parsed `Date` instances**
- **Found during:** Task 1, first integration-test run (before the GREEN implementation even ran)
- **Issue:** `readSession()`'s raw `select ... from sessions` query returned `created_at`/`expires_at`/`absolute_expires_at` in a shape that failed `.getTime()` calls — Drizzle's `db.execute()` path does not apply the same automatic Date-parsing its own query builder does.
- **Fix:** `readSession()` now explicitly wraps every returned timestamp field in `new Date(...)` before use.
- **Files modified:** tests/integration/auth/session-lifetime.test.ts
- **Verification:** All timestamp comparisons in the suite behave correctly against a real container.
- **Committed in:** `40dcf2a` → `f43ea11`

**4. [Wording-only] Reworded a comment that tripped its own literal-grep acceptance check**
- **Found during:** Task 1, running the plan's own acceptance checks after GREEN
- **Issue:** `grep -c "vi.setSystemTime" tests/integration/auth/session-lifetime.test.ts` is meant to prove the suite never uses fake timers, but an explanatory file-header comment used the literal substring `vi.setSystemTime` to state that it deliberately doesn't, pushing the count to 1 instead of 0 — the same class of false positive documented in several prior plans' summaries (e.g. Plan 01-02's "workspace", Plan 01-09's "db.transaction").
- **Fix:** Reworded the comment to "a fake-timers API" without the literal identifier.
- **Files modified:** tests/integration/auth/session-lifetime.test.ts
- **Verification:** `grep -c "vi.setSystemTime" tests/integration/auth/session-lifetime.test.ts` returns 0.
- **Committed in:** `f43ea11`

---

**Total deviations:** 4 (3 blocking/correctness fixes required for the plan's own acceptance criteria and tests to pass at all, 1 wording-only fix for literal-grep compliance). No scope creep beyond Task 1/2's declared `<files>` lists.

## Issues Encountered

- A full `pnpm exec vitest run --config vitest.integration.config.ts tests/integration/auth` run immediately following a separate `pnpm test:integration` run failed all 25 tests with the "no stray `noodara.test=true` container" assertion tripping on the very first test — re-running the exact same command in isolation passed cleanly (25/25), and `docker ps` afterward showed zero stray containers either way. This reads as a transient Docker-timing flake from launching a second Testcontainers-heavy suite back-to-back with the first, not a defect in this plan's code; flagging in case a future CI run hits the same back-to-back-suite contention.

## User Setup Required

None — no external service configuration required. `pnpm test:integration` needs a reachable Docker daemon, same as every prior phase-1 integration plan.

## Next Phase Readiness
- Plan 01-12 (setup-token bootstrap / signup gate) and Plan 01-13 (login lockout) can both build on `session-policy.ts`/`session-service.ts` unchanged; neither touches `auth.ts` or `app.ts`, preserving both files' "never touched again" invariants (Plan 01-03/01-10).
- Phase 5's Settings UI has real `GET /api/sessions`/`DELETE /api/sessions/:id`/`DELETE /api/sessions` endpoints to build against today — only the UI itself is deferred (01-CONTEXT.md Deferred Ideas).
- `session-policy.ts`'s `sessionPolicy.clock` injection point and `session-service.ts`'s direct-Drizzle-query pattern (not `auth.api.*` for data operations) are documented in `patterns-established` for any later phase-1/phase-3 code that needs to read or mutate `sessions` rows.
- Full command chain (`pnpm lint && pnpm typecheck && pnpm build && pnpm test && pnpm test:integration && pnpm exec turbo boundaries`) verified green after every commit in this plan; 0 stray `noodara.test=true` containers.

## Threat Flags

None beyond what the plan's own `<threat_model>` already covers (T-1-30 through T-1-33) — no new network endpoint, auth path, or schema change was introduced outside that register.

---
*Phase: 01-dominio-persistencia-y-autenticacion*
*Completed: 2026-09-11*

## Self-Check: PASSED

- FOUND: apps/control-plane/src/auth/session-policy.ts
- FOUND: apps/control-plane/src/auth/session-policy.test.ts
- FOUND: apps/control-plane/src/services/session-service.ts
- FOUND: apps/control-plane/src/routes/sessions.ts
- FOUND: tests/integration/auth/session-lifetime.test.ts
- FOUND: tests/integration/auth/session-management.test.ts
- FOUND commit: `40dcf2a` (Task 1 RED)
- FOUND commit: `f43ea11` (Task 1 GREEN)
- FOUND commit: `6f3ac07` (Task 2 RED)
- FOUND commit: `70d5c5f` (Task 2 GREEN)

Re-verified independently: `pnpm lint`, `pnpm typecheck`, `pnpm build`, `pnpm test` (306/306), `pnpm test:integration` (63/63), `pnpm exec turbo boundaries` all exit 0. Every acceptance-criteria grep from the plan passes literally: `grep -c "vi.setSystemTime" tests/integration/auth/session-lifetime.test.ts` → 0; `grep -c "Open Question 1\|D-05" apps/control-plane/src/auth/session-policy.ts` → 3; `grep -c "z.object" apps/control-plane/src/routes/sessions.ts` → 6; `grep -c "writeActivityEvent" apps/control-plane/src/routes/sessions.ts` → 0; `git diff --name-only` for this plan does not include `apps/control-plane/src/auth/auth.ts` or `apps/control-plane/src/app.ts`. `docker ps --filter label=noodara.test=true --format '{{.ID}}' | wc -l` → 0.
