---
phase: 01-dominio-persistencia-y-autenticacion
plan: 09
subsystem: security
tags: [redaction, activity-log, drizzle, fastify, pino, testcontainers, vitest]

# Dependency graph
requires:
  - phase: 01-dominio-persistencia-y-autenticacion
    provides: "packages/domain's createRedactor()/Redactor and SecretValue (Plan 01-05)"
  - phase: 01-dominio-persistencia-y-autenticacion
    provides: "packages/domain's AUTH_ACTIONS/buildActivityEvent/SensitiveMetadataError (Plan 01-06)"
  - phase: 01-dominio-persistencia-y-autenticacion
    provides: "apps/control-plane's activity_events table, createDb, and the Testcontainers startTestApp()/startPostgres() harness (Plan 01-07)"
  - phase: 01-dominio-persistencia-y-autenticacion
    provides: "apps/control-plane/src/logger.ts's pino redact.paths and writableForTests() capture hook (Plan 01-03)"
provides:
  - "apps/control-plane/src/activity/write-activity-event.ts: writeActivityEvent(handle, input, now?) — the single insert into activity_events anywhere in the codebase; builds via buildActivityEvent then redacts metadata through appRedactor, accepts either the default db handle or a caller-supplied transaction handle, returns the inserted row id"
  - "apps/control-plane/src/activity/redaction.ts: appRedactor (a process-level Redactor with the master key(s) and Better Auth secret registered at module load) and toLogSafe(entity) — allowlists a credentials row to {id, type, keyVersion}, denylists credentialId/forbidden-named fields and SecretValue instances from any other entity"
  - "tests/integration/activity/auth-events.test.ts + canary.test.ts: real-PostgreSQL coverage of all eight AUTH_ACTIONS, transaction rollback, occurred_at-desc read order, and a randomBytes-generated canary proof across the pino logger, an HTTP error body, and activity_events.metadata"
affects: ["01-10", "01-11", "01-12", "01-13", "phase-2-ssh", "phase-3-application-services"]

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "ActivityWriteHandle = PgDatabase<NodePgQueryResultHKT, typeof schema> — the common Drizzle base class both NodePgDatabase (the default db) and the transaction handle inside db.transaction(async (tx) => ...) extend, used as the writer's single parameter type instead of a union or an overload, so the function transparently composes into a caller's transaction"
    - "Build-then-redact ordering in writeActivityEvent: buildActivityEvent's SensitiveMetadataError/InvalidActivityActionError guard runs before appRedactor.redact(), so a forbidden metadata key is always a hard failure at the call site — never silently laundered into '[REDACTED:...]' and persisted as if the call had succeeded"
    - "toLogSafe recognises a credentials row structurally (presence of encryptedValue + keyVersion + type) rather than importing the Drizzle table type, so it works identically for a row fetched via raw SQL; every other entity goes through a denylist (credentialId + the same forbidden-key-name set as buildActivityEvent, plus SecretValue-instance exclusion) since an allowlist can't be generic across arbitrary future entities"
    - "Integration test files dynamically import anything that transitively touches apps/control-plane/src/env.ts (writeActivityEvent, appRedactor, createLogger, env itself) only after startTestApp() has written a valid environment to process.env — a static top-level import would crash the vitest worker via env.ts's fail-fast process.exit(1), the same class of bug Plan 01-07 already fixed for app.ts"
    - "The canary test's HTTP-error channel wires app.setErrorHandler((error, _req, reply) => reply.send({ message: appRedactor.redact(error.message) })) onto the running test app instance rather than modifying apps/control-plane/src/app.ts (fixed since Plan 01-03) — proves the pattern phase 3/4's real routes must follow, since no production route touches a credential yet"

key-files:
  created:
    - apps/control-plane/src/activity/index.ts
    - apps/control-plane/src/activity/write-activity-event.ts
    - apps/control-plane/src/activity/write-activity-event.test.ts
    - apps/control-plane/src/activity/redaction.ts
    - tests/integration/activity/auth-events.test.ts
    - tests/integration/activity/canary.test.ts
  modified:
    - package.json (root: @noodara/domain promoted to a root devDependency)
    - pnpm-lock.yaml

key-decisions:
  - "writeActivityEvent's handle parameter is typed as the shared drizzle-orm/pg-core PgDatabase<NodePgQueryResultHKT, typeof schema> base class (not the app's own Database alias), the exact type both NodePgDatabase and the db.transaction() tx parameter instantiate identically to — an upcast, not a structural duck-type, so a future drizzle-orm minor version cannot silently break the 'accepts either handle' guarantee"
  - "toLogSafe's credentials-row detection is structural (encryptedValue + keyVersion + type keys present) rather than a Drizzle table-type import, keeping redaction.ts decoupled from the schema module and correct even for a row fetched by raw SQL"
  - "The canary test's HTTP-error-body channel registers its own app.setErrorHandler on the test's Fastify instance rather than adding one to apps/control-plane/src/app.ts, since app.ts is fixed per Plan 01-03 and no production route touches a credential until phase 3/4 — this proves the required pattern (redact the message through appRedactor before it reaches the client) without inventing a global error handler ahead of the routes that will need it"
  - "@noodara/domain promoted to a root devDependency (same fix Plan 01-08 applied for drizzle-orm): pnpm's isolated node_modules only symlinks a workspace package into packages that declare it in their own package.json, never up to the workspace root, so tests/integration/activity's direct imports of @noodara/domain/activity were unresolvable without this"

patterns-established:
  - "Pattern: any future activity-log write (phase 3's application services) must call writeActivityEvent from a service, never insert into activityEvents directly — enforced today by writeActivityEvent.ts being the sole file referencing activityEvents for an insert (grepped in this plan's own acceptance criteria), not by a runtime guard"
  - "Pattern: any object logged via apps/control-plane's logger that contains a Server or credentials entity should go through toLogSafe() first, backstopping pino's path-based redact.paths per STACK.md's 'a forgotten path in redact.paths isn't the only line of defense' rationale"

requirements-completed: [AUTH-04]

# Metrics
duration: 41min
completed: 2026-09-10
---

# Phase 1 Plan 9: Single Activity-Log Writer and the Redaction Canary Proof Summary

**`writeActivityEvent` as the sole insert path into `activity_events` (build-then-redact, transaction-composable), a `toLogSafe`/`appRedactor` pair backstopping pino's path-based redaction, and a runtime-generated canary proof across the logger, an HTTP error body, and activity metadata.**

## Performance

- **Duration:** ~41 min
- **Started:** 2026-09-10T20:40:00-06:00
- **Completed:** 2026-09-10T21:21:18-06:00
- **Tasks:** 2 (both TDD)
- **Files modified:** 6 created, 2 modified

## Accomplishments
- `write-activity-event.ts`: `writeActivityEvent(handle, input, now?)` is now the only function in the codebase that inserts into `activity_events` (verified by a repository-wide grep in the acceptance criteria). It builds the event via `buildActivityEvent` (rejecting forbidden metadata keys and `SecretValue` instances before anything touches the database), redacts `metadata` through `appRedactor`, and inserts one row, returning its id. `handle` accepts either the default `db` or a transaction handle with zero special-casing, since both instantiate the exact same Drizzle `PgDatabase<NodePgQueryResultHKT, typeof schema>` base type — confirmed with a real rollback test in `auth-events.test.ts`.
- `redaction.ts`: a process-level `appRedactor` (built once via `createRedactor()`) with the master key(s) and the Better Auth secret registered at module load, and `toLogSafe(entity)` — allowlists a `credentials` row down to `{ id, type, keyVersion }` (never `encryptedValue`) and denylists `credentialId` plus the same forbidden-key-name set `buildActivityEvent` uses, plus any `SecretValue` instance, from any other entity.
- `tests/integration/activity/auth-events.test.ts`: all eight `AUTH_ACTIONS` land as rows with correct `action`/`outcome`/`actor_type` (queried by raw SQL, not the ORM, so a column-name mismatch would be caught); a failed login's `{ email, ip }` metadata persists while a `password` key throws before any insert; a rolled-back transaction leaves zero rows; `occurred_at desc` reads come back newest-first.
- `tests/integration/activity/canary.test.ts`: a `randomBytes`-generated SSH-password canary, a private-key canary, and the test environment's real master key are driven through (a) `logger.error` nested under the exact paths `logger.ts`'s pino `redact.paths` already covers, (b) a thrown error through a Fastify error handler that redacts via `appRedactor` before responding, and (c) `writeActivityEvent` metadata under ordinary (non-forbidden) key names — proving the Redactor's value-based pass, not just the key-name guard. Manually confirmed (and reverted) that removing the `appRedactor.redact()` call from `write-activity-event.ts` makes this test fail.
- Full command chain green after both tasks: `pnpm lint`, `pnpm typecheck`, `pnpm test` (292/292, up from 284), `pnpm test:integration` (38/38, up from 33), `pnpm build`, `pnpm exec turbo boundaries` (105 files, no issues); zero `noodara.test=true` containers left running.

## Task Commits

Each task was committed atomically (TDD tasks have separate RED/GREEN commits):

1. **Task 1 (RED): failing write-activity-event.test.ts** - `1316b25` (test)
   **Task 1 (GREEN): implement write-activity-event.ts / redaction.ts / activity/index.ts** - `19aaa12` (feat)
2. **Task 2: auth-event integration coverage and the canary proof** - `09d7ab8` (test)

**Plan metadata:** _(final metadata commit follows this summary)_

## Files Created/Modified
- `apps/control-plane/src/activity/write-activity-event.ts` - `writeActivityEvent`, `ActivityWriteHandle`, `WriteActivityEventInput`
- `apps/control-plane/src/activity/write-activity-event.test.ts` - Boundary-mocked-db unit coverage for the writer and for `toLogSafe`
- `apps/control-plane/src/activity/redaction.ts` - `appRedactor`, `toLogSafe`
- `apps/control-plane/src/activity/index.ts` - Barrel re-exporting `writeActivityEvent`, `appRedactor`, `toLogSafe`
- `tests/integration/activity/auth-events.test.ts` - Real-PostgreSQL AUTH_ACTIONS/rollback/ordering coverage
- `tests/integration/activity/canary.test.ts` - The three-channel canary proof
- `package.json` / `pnpm-lock.yaml` - `@noodara/domain` promoted to a root devDependency

## Decisions Made
See `key-decisions` in the frontmatter for the four decisions with the most downstream impact (the shared `PgDatabase` handle type, `toLogSafe`'s structural credentials-row detection, the test-scoped `setErrorHandler` pattern for the HTTP-error canary channel, and the `@noodara/domain` root-devDependency fix).

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 3 - Blocking] Two doc comments' literal `db.transaction` text tripped the plan's own acceptance-criteria grep**
- **Found during:** Task 1, running the plan's own acceptance checks after GREEN
- **Issue:** `grep -c "db.transaction" apps/control-plane/src/activity/write-activity-event.ts` is meant to prove the writer never *opens* its own transaction, but two doc comments explaining the caller-supplied-transaction contract used the literal substring `db.transaction(async (tx) => ...)` to illustrate the pattern, making the count 2 instead of 0 — the same class of false positive documented in Plan 01-02's "workspace" and Plan 01-06's "Date.now()" precedents.
- **Fix:** Reworded both comments to describe the same contract without the literal substring (`a db`-instance `.transaction(async (tx) => ...)` call`).
- **Files modified:** apps/control-plane/src/activity/write-activity-event.ts
- **Verification:** `grep -c "db.transaction" apps/control-plane/src/activity/write-activity-event.ts` returns 0; `pnpm --filter @noodara/control-plane typecheck/lint` and the unit suite still pass.
- **Committed in:** `19aaa12`

**2. [Rule 3 - Blocking] `@noodara/domain` bare specifier unresolvable from root-level integration test files**
- **Found during:** Task 2, first run of `auth-events.test.ts`
- **Issue:** `tests/integration/activity/auth-events.test.ts` imports `AUTH_ACTIONS` from `@noodara/domain/activity` directly; running it failed with `Cannot find package '@noodara/domain'` — pnpm's isolated `node_modules` only symlinks a workspace dependency into the packages that declare it in their own `package.json` (here, only `apps/control-plane`), never up to the workspace root, the exact same resolution gap Plan 01-08's Summary documents for `drizzle-orm`.
- **Fix:** `pnpm add -D -w "@noodara/domain@workspace:*"` — an already-vetted, already-in-use workspace package, not a new/unfamiliar install (outside Rule 3's slopsquatting-risk exclusion).
- **Files modified:** package.json, pnpm-lock.yaml
- **Verification:** `pnpm exec vitest run --config vitest.integration.config.ts tests/integration/activity` passes (5/5); `pnpm lint`/`pnpm typecheck`/`pnpm test`/`pnpm build`/`pnpm exec turbo boundaries` all still exit 0.
- **Committed in:** `09d7ab8`

---

**Total deviations:** 2 (both Rule 3 blocking fixes required for the plan's own acceptance criteria/tests to pass). No scope creep beyond Task 1's and Task 2's declared `<files>` lists; the `@noodara/domain` root devDependency is the only addition not explicitly named in the plan, strictly required for Task 2's own literal test files to run.

## Issues Encountered

None beyond the two deviations above. The manual "remove the redact call, confirm `canary.test.ts` fails, restore it" verification required by this plan's own acceptance criteria was performed and reverted cleanly (confirmed via `git diff` showing no residual change) before the final commit.

## User Setup Required

None - no external service configuration required.

## Next Phase Readiness
- `apps/control-plane/src/activity/index.ts` exports `writeActivityEvent`, `appRedactor`, and `toLogSafe` — phase 3's application services (`RegisterServerService`, `ConnectServerService`, etc.) and Plans 01-10 (login/logout), 01-12 (setup), and 01-13 (lockout) should call `writeActivityEvent` directly, passing their own transaction handle when a state change and its activity event must land atomically. No route or worker should ever call it directly (ARCHITECTURE.md §6) — this is enforced today by the single-writer grep, not a runtime guard, so future plans introducing a second call site should add one to their own acceptance criteria.
- `appRedactor` is a live process-level singleton; any future code that decrypts a credential (phase 2's `packages/ssh`, phase 3's connection services) should call `revealSecret(secret, appRedactor)` (from `@noodara/domain/security`) rather than `revealSecret(secret)` alone, so the raw value is registered for redaction the moment it leaves its `SecretValue` wrapper.
- `toLogSafe`'s credentials-row allowlist (`{ id, type, keyVersion }`) and its servers-row denylist (`credentialId` + forbidden key names + `SecretValue` instances) are ready for any future route/service that logs a `servers` or `credentials` row — no route currently does, since phase 4 owns HTTP routes.
- The canary test's `app.setErrorHandler`/`appRedactor.redact(error.message)` pattern is the template phase 3/4 should follow once a real route can throw with credential-bearing context; `app.ts` itself remains untouched (Plan 01-03's "app.ts is never touched again" invariant holds).
- Full command chain (`pnpm lint && pnpm typecheck && pnpm test && pnpm test:integration && pnpm build && pnpm exec turbo boundaries`) verified green after every commit in this plan.

---
*Phase: 01-dominio-persistencia-y-autenticacion*
*Completed: 2026-09-10*

## Self-Check: PASSED

- FOUND: apps/control-plane/src/activity/index.ts
- FOUND: apps/control-plane/src/activity/write-activity-event.ts
- FOUND: apps/control-plane/src/activity/write-activity-event.test.ts
- FOUND: apps/control-plane/src/activity/redaction.ts
- FOUND: tests/integration/activity/auth-events.test.ts
- FOUND: tests/integration/activity/canary.test.ts
- FOUND commit: `1316b25` (Task 1 RED)
- FOUND commit: `19aaa12` (Task 1 GREEN)
- FOUND commit: `09d7ab8` (Task 2)

Re-verified independently: `pnpm lint`, `pnpm typecheck`, `pnpm test` (292/292), `pnpm test:integration` (38/38), `pnpm build`, `pnpm exec turbo boundaries` (105 files, no issues) all exit 0; `grep -rn "insert(.*activityEvents" apps/control-plane/src --include='*.ts' | grep -v write-activity-event.ts | wc -l` returns 0; `grep -c "db.transaction" apps/control-plane/src/activity/write-activity-event.ts` returns 0; `docker ps --filter label=noodara.test=true --format '{{.ID}}' | wc -l` returns 0.
