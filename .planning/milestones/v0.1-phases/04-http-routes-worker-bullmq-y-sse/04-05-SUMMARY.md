---
phase: 04-http-routes-worker-bullmq-y-sse
plan: 05
subsystem: api
tags: [server-state, activity-log, d-12, testcontainers, drizzle]

requires:
  - phase: 04-http-routes-worker-bullmq-y-sse
    provides: "ServerEventPublisher/publishServerEvent/noopServerEventPublisher and deps.events (04-03)"
provides:
  - "failInFlightConnection(deps, input) — resolves a server abandoned in CONNECTING to ERROR/CONNECTION_LOST under a row lock, idempotently, without ever touching deps.ssh"
  - "listConnectingServerIds(deps) — read-only ids of every CONNECTING server, for the worker's startup sweep"
  - "createServerServices(deps) grown to seven members: the five phase-3 services plus failInFlightConnection and listConnectingServerIds"
affects: [04-07]

tech-stack:
  added: []
  patterns:
    - "Recovery service mirrors trust-fingerprint.ts's skeleton exactly: SELECT ... FOR UPDATE, transition() (never a status literal), writeActivityEvent inside the same tx, publishServerEvent after commit"
    - "A no-op branch (status !== 'CONNECTING') returns { ok: true, skipped: true } rather than a failure code — clobbering a result that already landed would itself be a false state (T-4-23)"

key-files:
  created:
    - apps/control-plane/src/services/fail-in-flight-connection.ts
    - tests/integration/services/fail-in-flight-connection.test.ts
  modified:
    - apps/control-plane/src/services/server-services.ts
    - tests/integration/services/trust-fingerprint.test.ts

key-decisions:
  - "trust-fingerprint.test.ts's pre-existing 'returns exactly the five service keys' assertion updated to the new seven-member shape (Rule 1 fix) — the facade legitimately grows in this plan, so the stale five-key literal was the bug, not the new members"
  - "The recovery service's own activity-row count assertions filter by action = 'server.connection_attempted', not just entityId — registerFixtureServer's own registerServer call already writes a server.created row for the same server, which would otherwise be miscounted as part of the recovery's own event count"

patterns-established:
  - "listConnectingServerIds takes no lock and opens no transaction — it is a plain read for the worker's startup sweep; the per-row lock is taken by failInFlightConnection itself the moment it acts on a given id"

requirements-completed: []

duration: ~35min
completed: 2026-09-17
---

# Phase 4 Plan 5: failInFlightConnection recovery service Summary

**`failInFlightConnection` guarantees a server never stays in CONNECTING forever: under a row lock it transitions an abandoned CONNECTING row to ERROR/CONNECTION_LOST, writes one `server.connection_attempted` failure event and publishes `server.updated` after commit — idempotently, and without ever calling SSH — with `listConnectingServerIds` giving the worker's startup sweep its input, both now exposed on the seven-member `ServerServices` facade.**

## Performance

- **Duration:** ~35 min
- **Started:** 2026-09-17T12:20:00-06:00 (approx.)
- **Completed:** 2026-09-17T12:55:00-06:00
- **Tasks:** 2
- **Files modified:** 4 (2 created, 2 modified)

## Accomplishments
- `apps/control-plane/src/services/fail-in-flight-connection.ts`: `failInFlightConnection` locks the `servers` row, and only when it is still `CONNECTING` transitions it to `ERROR` via `transition(row.status, 'ERROR')` (never a status literal), sets `lastErrorCode: 'CONNECTION_LOST'`, writes exactly one `server.connection_attempted` failure activity row with `metadata: { reason }` and publishes `server.updated` strictly after the transaction commits. Any other starting status returns `{ ok: true, skipped: true }` — a genuine no-op, not a failure, since the real job already resolved and clobbering it would be a false state. An unknown server id returns `{ ok: false, code: 'NOT_FOUND' }`. `listConnectingServerIds` is a plain, lock-free `select({ id })` filtered to `status = 'CONNECTING'`.
- `apps/control-plane/src/services/server-services.ts`: `ServerServices` grew from five to seven members — `failInFlightConnection` and `listConnectingServerIds` bound in the same one-line closure style as the existing five, with `FailInFlightConnectionInput`/`FailInFlightConnectionResult` re-exported from the facade's single type block.
- 15 new integration tests in `tests/integration/services/fail-in-flight-connection.test.ts` cover: `NOT_FOUND`, the real `CONNECTING -> ERROR/CONNECTION_LOST` transition, never touching `deps.ssh` (proven via the fixture's default unconfigured `SshPort`, whose `connect` rejects loudly), the exact activity-row shape (`action`, `outcome: 'failure'`, `errorCode: 'CONNECTION_LOST'`, `metadata.reason`), exactly one published `server.updated` event, `user`/`system` actor attribution, idempotency across two consecutive calls, a no-op matrix across all five non-`CONNECTING` statuses (`it.each`, asserting `skipped: true`, zero new activity rows, zero new publishes, byte-identical row), `listConnectingServerIds`'s empty-array and CONNECTING-only filtering behavior, and the facade's direct-call parity plus its now-seven-member `Object.keys` assertion.

## Task Commits

Each task was committed atomically:

1. **Task 1: failInFlightConnection and listConnectingServerIds** - `9b28ded` (feat, TDD RED verified before implementation)
2. **Task 2: Expose recovery on the ServerServices facade** - `4f97593` (feat, TDD RED verified before implementation)

_Note: RED was run and confirmed failing for the stated reason (missing module; `services.failInFlightConnection is not a function`; stale five-key membership assertion) before implementing GREEN for each task._

## Files Created/Modified
- `apps/control-plane/src/services/fail-in-flight-connection.ts` - `failInFlightConnection`, `listConnectingServerIds`, `FailInFlightConnectionInput`, `FailInFlightConnectionResult`
- `tests/integration/services/fail-in-flight-connection.test.ts` - the 15-test recovery + facade-exposure proof
- `apps/control-plane/src/services/server-services.ts` - `ServerServices` interface and `createServerServices` grown to seven members; new type re-exports
- `tests/integration/services/trust-fingerprint.test.ts` - the pre-existing five-key membership assertion updated to the new seven-member shape

## Decisions Made
- `trust-fingerprint.test.ts`'s pre-existing "returns exactly the five service keys" assertion was updated in place (not left to drift or duplicated) since this plan's own acceptance criteria requires the facade to genuinely grow to seven members — the stale five-key literal, not the new members, was the bug once Task 2 landed.
- The new test file's activity-row-count helper filters explicitly on `action = 'server.connection_attempted'` rather than just `entityId`, since `registerFixtureServer`'s own `registerServer` call already writes an unrelated `server.created` row for the same server id that would otherwise inflate every "exactly one activity row" assertion.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] Updated trust-fingerprint.test.ts's stale five-key facade assertion**
- **Found during:** Task 2, first GREEN run of the full `tests/integration/services/` suite
- **Issue:** `trust-fingerprint.test.ts`'s own `createServerServices factory` suite asserted `Object.keys(services).sort()` equals exactly five service names. Growing the facade to seven members in Task 2 (this plan's own stated goal) made that pre-existing assertion fail — not because of a regression, but because the assertion's own literal was now stale.
- **Fix:** Updated the test's expected array to the seven-member list, keeping the test's own intent (the facade's exact membership) while renaming it to reflect the new count. No production behavior changed by this fix.
- **Files modified:** `tests/integration/services/trust-fingerprint.test.ts`
- **Verification:** `pnpm exec vitest run --config vitest.integration.config.ts tests/integration/services/` — 7 files, 121 tests, all pass.
- **Committed in:** `4f97593` (Task 2 commit)

---

**Total deviations:** 1 auto-fixed (1 bug in a pre-existing test's stale literal)
**Impact on plan:** No scope creep — the fix was required for the plan's own acceptance criteria ("All pre-existing `tests/integration/services/*.test.ts` suites still pass") to hold once the facade legitimately grew to seven members.

## Issues Encountered
None beyond the deviation above.

## User Setup Required

None - no external service configuration required.

## Next Phase Readiness
- `failInFlightConnection` and `listConnectingServerIds` are ready for Plan 04-07's worker to call from its `stalled` listener and its startup sweep, through either the bare functions or `createServerServices(deps)`.
- `ServerServices` now has all seven members Plan 04-07 needs from a single facade import.
- Verification run: `pnpm exec vitest run --config vitest.integration.config.ts tests/integration/services/fail-in-flight-connection.test.ts` (12 tests) and the full `tests/integration/services/` suite (7 files, 121 tests) both green; `pnpm exec vitest run apps/control-plane/src/activity/boundary.test.ts` green with `PRE_ACT01_EXCEPTIONS` unchanged; `pnpm lint`, `pnpm typecheck`, `pnpm test` (48 files, 801 tests) all green; `docker ps -aq --filter "label=noodara.test=true"` printed nothing after the run.
- Per STATE.md's existing note (from 04-01..04-04), SERV-06/DISC-05 are not marked complete from this plan alone — they land across the full 04-02..04-11 span and are re-verified at phase close.
- No blockers for the next plan in the wave.

---
*Phase: 04-http-routes-worker-bullmq-y-sse*
*Completed: 2026-09-17*

## Self-Check: PASSED

All created/modified files verified present on disk; both task commit hashes (`9b28ded`, `4f97593`) verified present in `git log`.
