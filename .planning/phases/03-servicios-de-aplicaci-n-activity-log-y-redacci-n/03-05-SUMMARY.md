---
phase: 03-servicios-de-aplicaci-n-activity-log-y-redacci-n
plan: 05
subsystem: api
tags: [postgres, drizzle, testcontainers, transactions, credentials, activity-log, tdd, security]

# Dependency graph
requires:
  - phase: 03-servicios-de-aplicaci-n-activity-log-y-redacci-n
    provides: "03-04's resolveServerServicesDeps/ServiceActor, credential-store.ts's encodeCredential/currentKeyVersion, and server-view.ts's toServerView"
provides:
  - "registerServer: the transactional SERV-01 registration service (encrypted credential + PENDING server + one server.created event, all-or-nothing)"
  - "tests/integration/services/helpers/service-fixture.ts: the shared Postgres+deps+fake-SshPort integration harness plans 03-06..03-10 reuse"
affects: [03-06-editServer, 03-07-deleteServer, 03-08-connectAndDiscover, 03-09-trustFingerprint, 03-10]

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "Service integration tests live in tests/integration/services/*.test.ts against real Postgres (not colocated unit tests), per this plan's own test-placement decision: every service in this phase opens db.transaction"
    - "register-server.ts and its test file both load each other's env-sensitive dependency graph via a dynamic `await import(...)`, never a static top-level import, mirroring app.ts's startTestApp() env-before-import discipline (env.ts's top-level `export const env = loadEnv(process.env)` would otherwise process.exit(1) before a test's own env is written)"
    - "service-fixture.ts's deps.ssh is a fixed forwarding object whose connect() delegates to a mutable currentSsh variable, so setSshPort() can swap the underlying SshPort mid-suite without re-resolving ServerServicesDeps"
    - "A Postgres 23505 unique-violation is caught only as a safety net behind explicit in-transaction pre-checks, translated to NAME_TAKEN/HOST_TAKEN by reading err.cause.constraint (drizzle-orm 0.45 wraps the raw pg error under .cause, not directly on the thrown error)"

key-files:
  created:
    - apps/control-plane/src/services/register-server.ts
    - tests/integration/services/helpers/service-fixture.ts
    - tests/integration/services/register-server.test.ts
  modified: []

key-decisions:
  - "RSA-2048/RSA-1024 PKCS#1 PEM (node:crypto.generateKeyPairSync, never a committed literal) used as the test suite's valid/too-small private-key fixtures instead of an ed25519 OpenSSH container — registerServer's own tests don't need to exercise every accepted key type (credential-store.test.ts, plan 03-04, already covers that matrix exhaustively), only the accept/reject boundary loadPrivateKey enforces"
  - "service-fixture.ts's buildUnconfiguredSshPort() rejects loudly by default (never silently resolves) so a later service suite (connectAndDiscover, 03-08) that forgets to call setSshPort() fails immediately with a clear message instead of hanging or returning a bogus outcome"
  - "The activity-event payload passed to writeActivityEvent is built as a single `as const` object bound to a local variable, then passed as `writeActivityEvent(tx, activityInput, deps.now())` on one line — kept this shape (rather than an inline multi-line object literal) specifically so the call site greps as `writeActivityEvent(tx` on a single line, matching the plan's own boundary-enforcement acceptance criterion"

requirements-completed: [SERV-01, ACT-01]

# Metrics
duration: 35min
completed: 2026-09-15
---

# Phase 3 Plan 5: registerServer + Shared Service Integration Harness Summary

**Transactional SERV-01 registration service (encrypted credential + PENDING server + one server.created event, all-or-nothing) plus the shared Postgres/SshPort integration harness every later service plan in this phase reuses.**

## Performance

- **Duration:** ~35 min
- **Started:** 2026-09-15T21:10:00Z (approx)
- **Completed:** 2026-09-15T21:30:00Z (approx)
- **Tasks:** 2 completed (TDD RED -> GREEN)
- **Files modified:** 3 (all new)

## Accomplishments

- `tests/integration/services/helpers/service-fixture.ts` is now the one entrypoint every service suite in this phase (03-06..03-10) starts from: a migrated Testcontainers Postgres, a resolved `ServerServicesDeps` with a swappable fake `SshPort` (`setSshPort`), and a fixed clock (`FIXED_NOW`) — mirroring `tests/integration/helpers/app.ts`'s env-before-import discipline exactly, including a dynamic `await import(...)` of `server-service-deps.js` so `env.ts`'s top-level fail-fast `process.exit(1)` never fires against an unset test env.
- `registerServer` (`apps/control-plane/src/services/register-server.ts`) validates name/host/port/user with `packages/domain`'s existing validators (no new regexes), encrypts the credential via `encodeCredential` (D-15), then opens exactly one `db.transaction` that pre-checks both D-10 uniqueness rules, inserts the `credentials` and `servers` rows, and writes exactly one `server.created` activity event (D-16) attributed to the caller's `ServiceActor` (D-17) — or persists nothing at all on any failure.
- 17 integration tests (`tests/integration/services/register-server.test.ts`) prove: PENDING status with defaulted `sshPort`/`sshUser`; `ssh_password`/`ssh_private_key` `credentialType` round-trips; the stored `encrypted_value` never contains the raw secret and its `key_version` equals `currentKeyVersion()`; the JSON result never leaks a raw password, `BEGIN OPENSSH PRIVATE KEY` text or a `credentialId`/`encryptedValue` field; exactly one `server.created` event with D-16's exact metadata shape; both `user` and `system` actor attribution; `NAME_TAKEN`/`HOST_TAKEN`/`INVALID_CREDENTIAL`/`VALIDATION_FAILED` all returned as results; and zero orphan `servers`/`credentials`/`activity_events` rows after any failure.
- `pnpm test` (735 unit tests), `pnpm typecheck`, `pnpm lint` and `pnpm boundaries` are all green; the new integration suite runs clean with no stray `noodara.test=true` container left behind.

## Task Commits

Each task was committed atomically (TDD: test -> feat per task):

1. **Task 1 (RED): service integration harness and the SERV-01 expectations** - `13431c9` (test)
2. **Task 2 (GREEN): registerServer** - `84c2629` (feat)

**Plan metadata:** committed alongside this SUMMARY (see final commit below).

## Files Created/Modified

- `apps/control-plane/src/services/register-server.ts` - `RegisterServerInput`, `RegisterServerFailureCode`, `RegisterServerResult`, `registerServer`
- `tests/integration/services/helpers/service-fixture.ts` - `startServiceFixture`, `buildFakeSshPort`, `buildFakeSshSession`, `FIXED_NOW`
- `tests/integration/services/register-server.test.ts` - 17 tests covering defaults, both credential kinds, no-leak assertions, D-16 metadata, D-17 actor attribution, D-10 conflict codes and no-orphan-row guarantees

## Decisions Made

- Test placement: every service in this phase opens `db.transaction`, so per `noodara-tdd` skill §2 its tests live in `tests/integration/services/*.test.ts` against real Postgres, never as colocated unit tests (this was 03-05-PLAN.md's own stated gap resolution, carried through unchanged).
- `registerServer` and `register-server.test.ts` both load each other's dependency graph via `await import(...)` rather than a static top-level import, since `apps/control-plane/src/activity/redaction.ts` (transitively imported by `writeActivityEvent`) reads `env.NOODARA_MASTER_KEY` at module load time — a static import before the fixture writes a valid test env would crash the whole Vitest worker process via `env.ts`'s `process.exit(1)`.
- RSA-2048/RSA-1024 PEM keys (generated fresh per test run) stand in for "valid"/"too-small" private-key fixtures rather than reconstructing an OpenSSH ed25519 container — `loadPrivateKey`'s RSA path is a first-class accepted key type, and the exhaustive key-type/size matrix is already covered by `credential-store.test.ts` (plan 03-04); this suite only needs the accept/reject boundary at the `registerServer` level.
- The `activity_events` write is assembled as a single `as const`-typed local (`activityInput`) so the call site is `writeActivityEvent(tx, activityInput, deps.now())` on one line, satisfying the plan's own boundary-enforcement grep (`writeActivityEvent(tx`) without breaking Prettier's 100-column limit.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 3 - Blocking] Prettier reformatting run without the project's config initially used the wrong quote style**
- **Found during:** Task 2 GREEN, post-implementation formatting pass
- **Issue:** Running `pnpm exec prettier --write` with no `--config` flag silently fell back to Prettier's own defaults (double quotes) instead of `packages/config/prettier.config.js` (`singleQuote: true`), rewriting all three files with double quotes and reflowing `writeActivityEvent(tx, {...})` across multiple lines, which broke the plan's own `grep -c "writeActivityEvent(tx"` acceptance check.
- **Fix:** Re-ran Prettier with `--config packages/config/prettier.config.js` to restore the project's single-quote style, then refactored the activity-event construction into a named `activityInput` local so the `writeActivityEvent(tx, activityInput, deps.now())` call fits on one line under the 100-column limit regardless of how Prettier wraps it.
- **Files modified:** `apps/control-plane/src/services/register-server.ts`, `tests/integration/services/register-server.test.ts`, `tests/integration/services/helpers/service-fixture.ts`
- **Verification:** `pnpm exec prettier --config packages/config/prettier.config.js --check` passes on all three files; `grep -c "writeActivityEvent(tx" apps/control-plane/src/services/register-server.ts` returns 1; full suite re-run green.
- **Committed in:** `84c2629` (Task 2 commit)

---

**Total deviations:** 1 auto-fixed (Rule 3, tooling/formatting only, no behavior change).
**Impact on plan:** None on SERV-01/ACT-01 behavior or scope — the fix only restored the project's own established code style and the plan's own boundary-check grep.

## Issues Encountered

None beyond the formatting deviation documented above.

## User Setup Required

None — no external service configuration required.

## Next Phase Readiness

- `tests/integration/services/helpers/service-fixture.ts` (`startServiceFixture`, `buildFakeSshPort`, `buildFakeSshSession`) is ready for plans 03-06 (`editServer`), 03-07 (`deleteServer`), 03-08 (`connectAndDiscover`) and 03-09 (`trustFingerprint`) to import directly with zero modification.
- `registerServer` is the first working example of this phase's transactional-service + D-16 activity-event + D-10 conflict-code pattern; later services in this phase should follow its shape (validate -> encode/prepare -> `db.transaction` with pre-checks -> `writeActivityEvent(tx, ...)` -> `toServerView`) rather than inventing a new one.
- `pnpm test` (735 passing), `pnpm typecheck`, `pnpm lint`, `pnpm boundaries` all green; no stray `noodara.test=true` container survived the new suite.
- No blockers for plan 03-06.

---
*Phase: 03-servicios-de-aplicaci-n-activity-log-y-redacci-n*
*Completed: 2026-09-15*

## Self-Check: PASSED

All three created source/test files and this SUMMARY are present on disk; both task commits
(13431c9, 84c2629) are present in git history.
