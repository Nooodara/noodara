---
phase: 01-dominio-persistencia-y-autenticacion
plan: 12
subsystem: auth
tags: [setup-token, better-auth, postgres-advisory-lock, async-local-storage, drizzle, fastify]

# Dependency graph
requires:
  - phase: 01-dominio-persistencia-y-autenticacion
    provides: "setup_tokens table with the partial unique index on unused rows and the purpose column (Plan 01-07); writeActivityEvent()/AUTH_ACTIONS' auth.setup_completed (Plan 01-09); validateEmail()/validatePassword() (Plan 01-06)"
  - phase: 01-dominio-persistencia-y-autenticacion
    provides: "auth.ts's hooks.before composedBefore already awaiting signup-gate.ts first, and the inert signup-gate.ts/routes/setup.ts stubs this plan owns (Plan 01-10)"
provides:
  - "packages/domain/src/security/setup-token.ts: generateSetupToken/hashSetupToken/verifyTokenHash/isTokenUsable/SETUP_TOKEN_TTL_SECONDS/SETUP_TOKEN_PURPOSES — pure, shared verbatim by the setup route and the future `noodara admin reset` CLI (D-03)"
  - "apps/control-plane/src/auth/bootstrap-context.ts: runInBootstrap()/isBootstrapInProgress() — the AsyncLocalStorage window that is the only way /sign-up/email is ever allowed to run"
  - "apps/control-plane/src/auth/signup-gate.ts: the live gate, 404-ing /sign-up/email outside that window"
  - "apps/control-plane/src/services/setup-token-repository.ts + setup-service.ts: issueToken/findUsableByHash/markUsed and adminExists()/redeemSetupToken() — the pg_advisory_xact_lock-serialized, in-lock-re-checked redemption transaction (T-1-34)"
  - "apps/control-plane/src/routes/setup.ts: the real POST /api/setup, 404 once an admin exists, before the token is ever evaluated (D-02)"
affects: ["01-13", "01-14"]

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "AsyncLocalStorage bootstrap window (bootstrap-context.ts) rather than a module-level boolean: scopes the 'sign-up is allowed right now' flag to the single in-flight redemption's own async call chain, so it can never leak true across concurrent requests sharing the process — the exact race T-1-34 exists to close."
    - "pg_advisory_xact_lock as a database-wide (not connection-pool-wide) serialization point: confirmed by reading better-auth's dispatch.mjs that auth.api.signUpEmail runs through the same hooks.before pipeline as an HTTP request (so the bootstrap window gates it correctly), and that Better Auth's own sign-up commits via its own dedicated pg.Pool (auth.ts, Plan 01-10) — a different connection from this service's db.transaction(). True single-transaction atomicity across both is therefore not achievable without editing auth.ts (forbidden since Plan 01-10). What Postgres does guarantee, because the lock is keyed server-side by database rather than by client connection: no second redemption can pass its own lock acquisition until the winning request's outer transaction — which holds the lock for its entire duration — commits or rolls back. The exactly-one-admin guarantee holds regardless of which pool created the user row; proven by the 10-way concurrent race test."
    - "D-02's blanket 'admin exists → 404' check runs before token evaluation, so a genuinely already-used token can only ever be observed with no admin existing yet by directly marking a token used at the repository layer (as setup.test.ts does) — replaying the *exact* token that successfully created the admin instead returns 404, not the ALREADY_USED 400, since the door-closing rule takes precedence once an admin exists."
    - "AUTH-01's single-admin invariant makes a second real sign-up structurally unreachable through any public path once the first admin exists — session-management.test.ts's pre-existing 'not-my-session 404' test (Plan 01-11) needed its second admin replaced with a user row inserted directly via Drizzle (bypassing every HTTP path), since Better Auth's own sign-in endpoint isn't gated by signup-gate.ts and still authenticates that directly-inserted row normally."

key-files:
  created:
    - packages/domain/src/security/setup-token.ts
    - packages/domain/src/security/setup-token.test.ts
    - apps/control-plane/src/auth/bootstrap-context.ts
    - apps/control-plane/src/services/setup-service.ts
    - apps/control-plane/src/services/setup-token-repository.ts
    - tests/integration/auth/setup.test.ts
    - tests/integration/auth/setup-race.test.ts
  modified:
    - apps/control-plane/src/auth/signup-gate.ts (stub replaced with the live 404 gate)
    - apps/control-plane/src/routes/setup.ts (stub replaced with the real POST /api/setup)
    - tests/integration/auth/login.test.ts (createAdmin now redeems a setup token via /api/setup)
    - tests/integration/auth/logout.test.ts (same)
    - tests/integration/auth/cookies.test.ts (same, plus exposing `db` on ConfigurableFixture)
    - tests/integration/auth/session-lifetime.test.ts (same)
    - tests/integration/auth/session-management.test.ts (same, plus a direct-insert `createOtherUserDirectly` replacing the now-impossible second real sign-up)

key-decisions:
  - "redeemSetupToken's 'one transaction' does not achieve literal cross-pool atomicity between the user row (Better Auth's own pool) and the token/activity-event rows (this service's pool) — accepted as an existing, previously-documented architectural constraint (session-service.ts, Plan 01-11) rather than edited around, since fixing it fully would require touching auth.ts, which every plan since 01-10 is required not to do. The race guarantee itself (exactly one admin) still holds because pg_advisory_xact_lock is a server-side, database-scoped lock, not a connection-pool-scoped one."
  - "signup-gate.ts returns 404 (not 403) unconditionally for /sign-up/email outside the bootstrap window, matching D-02's stance that the endpoint's existence itself is never confirmed to an unauthenticated caller — mirrors routes/setup.ts's own 404-before-403 rule."
  - "setup-token-repository.ts's findUsableByHash filters by (tokenHash, purpose) together at the query level rather than fetching by hash alone and checking purpose in application code afterward, so a recovery-purpose token can never be redeemed through the setup route via a single, identical-shaped lookup."

requirements-completed: [AUTH-01]

# Metrics
duration: 68min
completed: 2026-09-11
---

# Phase 1 Plan 12: Setup-Token Bootstrap, POST /api/setup, and the Sign-Up Gate Summary

**Pure setup/recovery token module (32-byte entropy, SHA-256-hashed-at-rest, constant-time verified, 24h/single-use) plus a `pg_advisory_xact_lock`-serialized `/api/setup` that is the only way a Noodara instance ever gets its first admin — proven against a real PostgreSQL with a 10-way concurrent redemption race producing exactly one user.**

## Performance

- **Duration:** ~68 min
- **Started:** 2026-09-11T16:46:00-06:00 (approx.)
- **Completed:** 2026-09-11T17:55:00-06:00
- **Tasks:** 2 (both TDD)
- **Files modified:** 7 created, 7 modified

## Accomplishments
- `packages/domain/src/security/setup-token.ts`: `generateSetupToken`/`hashSetupToken`/`verifyTokenHash`/`isTokenUsable`, 19 unit tests including the exact-boundary `EXPIRED` case, `ALREADY_USED`-wins-over-`EXPIRED` precedence, and a malformed/wrong-length stored hash returning `false` without throwing. 100% statement/branch coverage on the file; `packages/domain`'s own 95% threshold still holds across the whole package.
- `apps/control-plane/src/auth/bootstrap-context.ts` + the live `signup-gate.ts`: an `AsyncLocalStorage`-scoped window that is the only condition under which `/sign-up/email` is let through; every other request to that path, before or after an admin exists, gets a 404.
- `apps/control-plane/src/services/setup-token-repository.ts` (`issueToken`/`findUsableByHash`/`markUsed`) and `setup-service.ts` (`adminExists`/`redeemSetupToken`): the redemption transaction takes a fixed-key `pg_advisory_xact_lock`, re-checks `adminExists` inside the lock, evaluates `isTokenUsable`, validates email/password through the domain validators, calls Better Auth's own sign-up inside the bootstrap window, marks the token used, and writes a redaction-clean `auth.setup_completed` activity event.
- `apps/control-plane/src/routes/setup.ts`: the real `POST /api/setup` — checks `adminExists` before ever looking at the submitted token (404, not 403, per D-02) and maps every service failure code to 400.
- Two new integration suites (12 tests): `setup.test.ts` covers the door-closing 404s, single-use/expiry rejection (including the boundary case where a token already-used-without-an-admin is distinguished from the same token replayed *after* the admin it created exists — the latter is 404, not 400, since D-02's door-closing rule wins), weak-password rejection leaving the token unconsumed, and activity-event/response-body metadata containing neither the token nor the password. `setup-race.test.ts` fires 10 concurrent redemptions of the same token and asserts exactly one 200 and exactly one `users` row.
- Fixed fallout in five pre-existing auth integration suites (`login`, `logout`, `cookies`, `session-lifetime`, `session-management`) whose `createAdmin` helpers depended on the `/sign-up/email` route this plan permanently closes; `session-management.test.ts`'s "not-my-session 404" test additionally needed its second admin replaced with a directly-inserted user row, since AUTH-01 makes a second real admin unreachable through any public path once the first exists.
- Full command chain green: `pnpm lint`, `pnpm typecheck`, `pnpm build`, `pnpm test` (325/325, up from 306), `pnpm test:integration` (75/75, up from 63), `pnpm exec turbo boundaries`; zero `noodara.test=true` containers left running; `app.ts`, `auth.ts` and `hooks.ts` untouched by this plan (verified via `git diff --name-only`).

## Task Commits

Each task was committed atomically (TDD tasks have separate RED/GREEN commits):

1. **Task 1 (RED): failing setup-token.test.ts** - `f3e613d` (test)
   **Task 1 (GREEN): setup-token.ts's pure generation/hashing/usability rules** - `5a43ee4` (feat)
2. **Task 2 (RED): failing setup.test.ts and setup-race.test.ts** - `2edd6a1` (test)
   **Task 2 (GREEN): bootstrap-context.ts, signup-gate.ts, setup-service.ts, setup-token-repository.ts, routes/setup.ts, plus the five pre-existing test files' createAdmin fixes required for the full suite to stay green** - `c253231` (feat)

**Plan metadata:** _(final metadata commit follows this summary)_

## Files Created/Modified
- `packages/domain/src/security/setup-token.ts` / `.test.ts` - Pure token generation, hashing, constant-time verification, usability rules
- `apps/control-plane/src/auth/bootstrap-context.ts` - `runInBootstrap`/`isBootstrapInProgress`
- `apps/control-plane/src/auth/signup-gate.ts` - The live 404 gate for `/sign-up/email`
- `apps/control-plane/src/services/setup-token-repository.ts` - `issueToken`/`findUsableByHash`/`markUsed`
- `apps/control-plane/src/services/setup-service.ts` - `adminExists`/`redeemSetupToken`
- `apps/control-plane/src/routes/setup.ts` - `POST /api/setup`
- `tests/integration/auth/setup.test.ts`, `setup-race.test.ts` - AUTH-01 proof, including the 10-way race
- `tests/integration/auth/{login,logout,cookies,session-lifetime,session-management}.test.ts` - `createAdmin` helpers updated to use `/api/setup`; `session-management.test.ts` also gained `createOtherUserDirectly`

## Decisions Made
See `key-decisions` in the frontmatter for the three decisions with the most downstream impact (accepting the two-pool non-atomicity constraint rather than editing `auth.ts`, the unconditional 404-not-403 gate, and filtering `findUsableByHash` by purpose at the query level).

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] Closing `/sign-up/email` broke every pre-existing auth integration test's `createAdmin` helper**
- **Found during:** Task 2, first `pnpm test:integration` run after the route closure
- **Issue:** `login.test.ts`, `logout.test.ts`, `cookies.test.ts`, `session-lifetime.test.ts` and `session-management.test.ts` (Plans 01-10/01-11) all created their test admin via a direct `POST /api/auth/sign-up/email` call, with an inline comment noting the route was "currently open, ungated — Plan 01-12 owns the gate." Once `signup-gate.ts` went live, every one of those calls started returning 404, failing 9 tests across 4 files with `sign-up failed: 404`.
- **Fix:** Updated each file's `createAdmin` helper to issue a fresh one-shot setup token via `issueToken(db, 'setup', new Date())` and redeem it through `POST /api/setup` instead. `cookies.test.ts`'s `ConfigurableFixture` also gained a `db` field so its helper could reach the repository.
- **Files modified:** tests/integration/auth/{login,logout,cookies,session-lifetime,session-management}.test.ts
- **Verification:** `pnpm test:integration` — all 5 files pass; 75/75 overall.
- **Committed in:** `c253231`

**2. [Rule 1 - Bug] `session-management.test.ts`'s "not-my-session 404" test relied on creating a second real admin, now structurally impossible**
- **Found during:** Task 2, same test run as deviation 1
- **Issue:** The test called `createAdmin` twice (a second time for `OTHER_ADMIN_EMAIL`) to get two distinct users for the cross-user session-ownership check. AUTH-01/D-02 make a second admin unreachable through any public path once the first exists (`/sign-up/email` is gated shut, and `/api/setup` 404s once `adminExists()` is true) — the second `createAdmin` call itself failed with 404, unrelated to the first deviation's fix.
- **Fix:** Added `createOtherUserDirectly(db, email, password)`, which inserts the second user and its argon2id-hashed `accounts` row directly via Drizzle, bypassing every HTTP path. Signing in as that row afterward still goes through the real, ungated `/sign-in/email` endpoint, so the test still exercises genuine session-service ownership logic against a real second `userId` — only the *creation* of that row is no longer a public-API concern, which matches AUTH-01's actual scope (it governs account creation, not authentication of an existing row).
- **Files modified:** tests/integration/auth/session-management.test.ts
- **Verification:** `pnpm exec vitest run --config vitest.integration.config.ts tests/integration/auth/session-management.test.ts` — 8/8 pass, including the not-my-session 404 test.
- **Committed in:** `c253231`

**3. [Wording-only] Reworded a test scenario to match D-02's actual precedence rather than an incorrect assumption**
- **Found during:** Task 2, first run of `setup.test.ts`'s originally-written "replayed token returns 400" test
- **Issue:** The first draft of this test called `/api/setup` twice with the same token (success, then replay), expecting the second call to surface `ALREADY_USED` (400). It instead returned 404: since a token can only become "used" by successfully creating the one admin, by the time it is used an admin necessarily exists, and D-02's route-level `adminExists()` check runs before any token is evaluated — so the door-closing 404 always wins over the token-specific 400 in that exact sequence.
- **Fix:** Split the original test into two: one that marks a token used directly at the repository layer (no admin created) to exercise `isTokenUsable`'s `ALREADY_USED` branch in isolation, and one that keeps the original double-`POST` sequence but asserts the correct 404 outcome, with a comment explaining the precedence.
- **Files modified:** tests/integration/auth/setup.test.ts
- **Verification:** Both tests pass; `setup.test.ts` is 10/10.
- **Committed in:** `2edd6a1` (test) / verified in `c253231`'s run

---

**Total deviations:** 3 (2 blocking/correctness fixes required for the full test suite to stay green, 1 wording/design correction to the test's own premise). No scope creep beyond the plan's declared `<files>` list plus the five pre-existing test files this plan's own change necessarily broke.

## Issues Encountered

None beyond what is captured in Deviations from Plan above.

## User Setup Required

None — no external service configuration required. `pnpm test:integration` needs a reachable Docker daemon, same as every prior phase-1 integration plan.

## Next Phase Readiness
- Plan 01-13 (login lockout, AUTH-04) builds on `login-guard.ts` unchanged; `signup-gate.ts` and `hooks.ts`'s composition order are untouched by anything 01-13 needs.
- Plan 01-14 (D-01 boot-time token printing, `noodara admin reset` CLI) has exactly the functions it needs already built and tested: `packages/domain/src/security/setup-token.ts`'s pure rules, and `setup-token-repository.ts`'s `issueToken`/`findUsableByHash`/`markUsed` with the `purpose` parameter already plumbed through for the `'recovery'` case. `setup-service.ts`'s `redeemSetupToken` is setup-route-specific (creates a user); the CLI's password-reset flow will need its own service function reusing the same repository and domain module, not `redeemSetupToken` itself.
- Full command chain (`pnpm lint && pnpm typecheck && pnpm build && pnpm test && pnpm test:integration && pnpm exec turbo boundaries`) verified green after every commit in this plan; 0 stray `noodara.test=true` containers.

## Threat Flags

None beyond what the plan's own `<threat_model>` already covers (T-1-34 through T-1-38) — no new network endpoint, auth path, or schema change was introduced outside that register.

---
*Phase: 01-dominio-persistencia-y-autenticacion*
*Completed: 2026-09-11*

## Self-Check: PASSED

- FOUND: packages/domain/src/security/setup-token.ts
- FOUND: packages/domain/src/security/setup-token.test.ts
- FOUND: apps/control-plane/src/auth/bootstrap-context.ts
- FOUND: apps/control-plane/src/auth/signup-gate.ts
- FOUND: apps/control-plane/src/services/setup-service.ts
- FOUND: apps/control-plane/src/services/setup-token-repository.ts
- FOUND: apps/control-plane/src/routes/setup.ts
- FOUND: tests/integration/auth/setup.test.ts
- FOUND: tests/integration/auth/setup-race.test.ts
- FOUND commit: `f3e613d` (Task 1 RED)
- FOUND commit: `5a43ee4` (Task 1 GREEN)
- FOUND commit: `2edd6a1` (Task 2 RED)
- FOUND commit: `c253231` (Task 2 GREEN)

Re-verified independently: `pnpm lint`, `pnpm typecheck`, `pnpm build`, `pnpm test` (325/325), `pnpm test:integration` (75/75, 37/37 within `tests/integration/auth`), `pnpm exec turbo boundaries` all exit 0. `pnpm exec vitest run --project packages --coverage` reports no threshold failures (packages/domain stays at/above 95% statements/branches). `grep -c "pg_advisory_xact_lock" apps/control-plane/src/services/setup-service.ts` → 4. `grep -c "Date.now()" packages/domain/src/security/setup-token.ts` → 0. `git diff --name-only` across every commit in this plan does not include `apps/control-plane/src/app.ts`, `auth.ts` or `hooks.ts`. `docker ps --filter label=noodara.test=true --format '{{.ID}}' | wc -l` → 0.
