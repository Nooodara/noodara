---
phase: 03-servicios-de-aplicaci-n-activity-log-y-redacci-n
plan: 08
subsystem: api
tags: [ssh, discovery, postgres, drizzle, transactions, activity-log, tdd, security]

# Dependency graph
requires:
  - phase: 03-servicios-de-aplicaci-n-activity-log-y-redacci-n
    provides: "03-02's mergeDiscoveryFacts/classifySnapshotOutcome, 03-04's ServerServicesDeps/credential-store/server-view, 03-05's service-fixture.ts integration harness, 03-01's loadPrivateKey/InvalidCredentialError additive export"
provides:
  - "connectAndDiscover(deps, { actor, serverId, discover? }): the single connect+discovery orchestration service phase 4's connect-server job and DISC-05's re-run will call"
  - "ConnectAndDiscoverInput/ConnectAndDiscoverResult/ConnectionReport/DiscoveryReport types"
  - "The discover?: typeof runDiscovery injection seam, reusable by any later plan needing a scriptable discovery outcome in a service-level test"
affects: [03-09-trustFingerprint, 03-10-e2e-canary, phase-4-connect-server-job]

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "Two-transaction shape for any service driving both a DB row lock and a slow external I/O call: TX1 locks+transitions, the I/O runs with no transaction open, TX2 applies the result — SSH work is never held inside a Postgres transaction"
    - "A discriminated union (not a flat {status,lastErrorCode} shape) for a derived status+errorCode pair lets a narrowing check (status !== 'CONNECTED') give the compiler a provably non-null errorCode, avoiding an `as` assertion at the exactOptionalPropertyTypes write-site"
    - "Optional `discover?: typeof realFn` constructor-injection seam on a service's own input type, defaulting to the real implementation, when the real function's internals are impractical to script through its own dependencies' fakes"

key-files:
  created:
    - apps/control-plane/src/services/connect-and-discover.ts
    - tests/integration/services/connect-and-discover.test.ts
  modified: []

key-decisions:
  - "connectAndDiscover accepts an optional discover?: typeof runDiscovery on its own input (not on ServerServicesDeps), defaulting to the real runDiscovery — scripting runDiscovery's internals through the fake SshSession's exec map was impractical for the D-02 warnings/checks matrix this plan's tests needed"
  - "classifyDiscoveryOutcome's return type is a 3-arm discriminated union keyed on status, not a flat interface, so the write-site's conditional errorCode spread needs no `as` cast under exactOptionalPropertyTypes"
  - "transition('CONNECTED', 'ERROR'/'UNREACHABLE') is still called (and its result discarded) in the two status-changing branches purely for its validation side-effect, matching the plan's own 'both status-changing branches use transition() directly' instruction, while the discriminated union supplies the literal return value"
  - "patchServerRow (a direct drizzle UPDATE, not a service call) stands in for the plan's own 'set specific starting statuses with raw SQL' instruction in the test file — it bypasses transition()/applyConnectionResult exactly as intended without needing a raw SQL string"
  - "The TX2 atomicity test forces buildActivityEvent's SensitiveMetadataError by injecting a discover fake whose warnings array contains a poisoned {password:'leaked'} object (type-widened past ServerErrorCode[]) rather than mocking write-activity-event.js — no module mocking needed, and the failure fires naturally through the real metadata-building code path"

requirements-completed: [DISC-03, ACT-01]

# Metrics
duration: 50min
completed: 2026-09-16
---

# Phase 3 Plan 8: connectAndDiscover Summary

**Single connect+discovery orchestration service — one SSH session, one two-transaction shape (TX1 lock/CONNECTING, TX2 connection-result+snapshot+denormalization+two activity events), an injectable `discover` seam for deterministic D-02 outcome testing, and 27 integration tests covering D-01 through D-08/D-16/D-17.**

## Performance

- **Duration:** ~50 min (git commit timestamps span a sandbox clock jump mid-session; this reflects estimated active execution time, not the raw commit-to-commit wall-clock delta)
- **Started:** 2026-09-15T23:19:05-06:00
- **Completed:** 2026-09-16T08:36:20-06:00
- **Tasks:** 3 completed (TDD RED → GREEN → GREEN)
- **Files modified:** 2 (both new)

## Accomplishments

- `connectAndDiscover` (`apps/control-plane/src/services/connect-and-discover.ts`) is the single entry point that decrypts a server's credential, transitions it to `CONNECTING` under a `SELECT ... FOR UPDATE` row lock (D-05's conflict check happens before any SSH work and before any event is written), connects over SSH, and — on a successful connect — runs discovery on the same session inside a `try`/`finally` that guarantees `session.close()` runs exactly once even if discovery rejects (Pitfall 3).
- The two-transaction shape is load-bearing and exactly as specified: TX1 (lock + D-05 conflict check + `CONNECTING` transition + credential read) commits before any SSH I/O; SSH connect + discovery + session close happen with no open transaction; TX2 (connection-result application, the two service-owned fingerprint timestamps, D-02's second `transition()` when discovery warrants it, the append-only `discovery_snapshots` insert, the denormalized `servers` UPDATE with D-07's null-never-overwrites merge, and both activity events) commits atomically or not at all.
- D-02's exact status/error-code mapping is implemented as a pure `classifyDiscoveryOutcome` helper checked in order (`COMMAND_TIMEOUT` warning → `ERROR`, all-checks-failed → `UNREACHABLE`, `UNSUPPORTED_OS`-only → stays `CONNECTED` with a warning code, otherwise stays `CONNECTED` clean) — `applyConnectionResult` is called exactly once per run (verified by a call-site grep), never a second time for the discovery half.
- Every run writes exactly one `server.connection_attempted` event (D-16 metadata: `{ attempts, durationMs, fingerprintCaptured }`, no host, no credential) and, when discovery ran, exactly one `server.discovery_completed` event (`{ snapshotId, warnings, checksFailed }`), both attributed to the caller's `ServiceActor` (D-17) and both written inside TX2 so they are atomic with the state change they describe.
- An SSH-level failure (`AUTH_FAILED`, `CONNECT_TIMEOUT`, `HOST_KEY_CHANGED` with its observed fingerprint parked in `pending_fingerprint`) is never thrown — SERV-07 holds: every outcome is a successful service call whose `connection.ok` is `false` and whose status was already applied.
- 27 integration tests (`tests/integration/services/connect-and-discover.test.ts`), split into a `connect phase` describe (14 tests: D-01/D-05/fingerprints) and a `discovery phase` describe (13 tests: DISC-03/D-02/D-06/D-07, including a real TX2-atomicity proof that forces `buildActivityEvent`'s `SensitiveMetadataError` mid-transaction via a poisoned `discover` fake and asserts the snapshot, the connection-result and both events all failed to land together).
- Full suite green: `pnpm test` (735 unit), `pnpm test:integration` (298 passed, 1 pre-existing skip, no stray `noodara.test=true` containers), `pnpm typecheck`, `pnpm lint`, `pnpm exec turbo boundaries` all pass; the plan's own grep-style acceptance criteria (`for('update')` present, no status literal assigned outside the discovery-outcome discriminated union, `revealSecret` absent, `applyConnectionResult(` called exactly once, `clean_close` absent) all hold.

## Task Commits

Each task was committed atomically (TDD: test → feat → feat):

1. **Task 1 (RED): the full connect + discovery expectation suite** — `633be00` (test)
2. **Task 2 (GREEN): connect phase — lock, transition, fingerprints, connection event** — `5fa5f6b` (feat)
3. **Task 3 (GREEN): discovery phase — snapshot, denormalization, D-02 second transition, discovery event** — `bf895b9` (feat)

**Plan metadata:** committed alongside this SUMMARY (see final commit below).

## Files Created/Modified

- `apps/control-plane/src/services/connect-and-discover.ts` — `connectAndDiscover`, `ConnectAndDiscoverInput`, `ConnectAndDiscoverResult`, `ConnectionReport`, `DiscoveryReport`, plus the internal `lockAndBeginConnecting`/`classifyDiscoveryOutcome`/`currentFactsOf`/`writeConnectionAttemptedEvent`/`writeDiscoveryCompletedEvent` helpers
- `tests/integration/services/connect-and-discover.test.ts` — 27 integration tests across `connect phase` and `discovery phase` describes, plus local `buildFacts`/`buildCheck`/`buildSnapshot`/`patchServerRow` test fixtures

## Decisions Made

- The `discover?: typeof runDiscovery` seam lives on `ConnectAndDiscoverInput` (not on `ServerServicesDeps`), matching the plan's own instruction — it keeps the injection scoped to the one call under test rather than widening every service's shared dependency shape.
- `classifyDiscoveryOutcome` returns a 3-arm discriminated union keyed on `status` rather than a flat `{ status; lastErrorCode }` interface, so the activity-event write-site's conditional `errorCode` spread type-checks under `exactOptionalPropertyTypes` with no `as` assertion.
- The TX2 atomicity test proves rollback by injecting a `discover` fake whose `warnings` array smuggles a `{ password: 'leaked' }` object (type-widened past `ServerErrorCode[]`) so the real `server.discovery_completed` metadata-building code path hits `buildActivityEvent`'s `SensitiveMetadataError` naturally — no module mocking of `write-activity-event.js` was needed.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] Two discovery-phase tests undercounted the server's own registration event**
- **Found during:** Task 3 GREEN, first full-suite run (`is atomic across the connection result, the snapshot and both events` and `attributes both events to a user actor (D-17)` both failed)
- **Issue:** Both tests queried every `activity_events` row for the server and compared against `0`/exact actor assertions, forgetting that `registerFixtureServer` (used to arrange the server) already writes one `server.created` event via `registerServer`. The atomicity test's "no events survived" assertion and the actor-attribution tests' "every event has this actor" loop both incorrectly included that pre-existing, differently-attributed event.
- **Fix:** The atomicity test now captures the event count *before* calling `connectAndDiscover` and asserts the count is unchanged after the forced rollback, instead of asserting zero. The two actor-attribution tests now query only `server.connection_attempted`/`server.discovery_completed` rows (via the existing `connectionAttemptedEvents`/`discoveryCompletedEvents` helpers) instead of every event for the server.
- **Files modified:** `tests/integration/services/connect-and-discover.test.ts`
- **Verification:** All 27 tests pass; re-ran the full suite twice to confirm no flakiness.
- **Committed in:** `bf895b9` (Task 3 commit)

**2. [Rule 3 - Blocking] `tsc`'s production build caught two typecheck errors `vitest` (esbuild) did not**
- **Found during:** Task 3 GREEN, first `pnpm test:integration` run (global setup's real `pnpm build` failed)
- **Issue:** (a) `transition('CONNECTED', 'ERROR')`'s return type is the full `ServerStatus` union, not narrowable to the flat `DiscoveryStatusPatch.status: 'CONNECTED' | 'ERROR' | 'UNREACHABLE'` field I had written; (b) the discovery-completed event's conditional `errorCode: statusPatch.lastErrorCode ?? undefined` produced an explicit `string | undefined` that `exactOptionalPropertyTypes` rejects against `BuildActivityEventInput`'s optional `errorCode?: string`.
- **Fix:** Replaced the flat interface with a 3-arm discriminated union (see Decisions above) so both the status assignment and the error-code narrowing type-check without any assertion.
- **Files modified:** `apps/control-plane/src/services/connect-and-discover.ts`
- **Verification:** `pnpm build` (real `tsc -p tsconfig.build.json`) succeeds; `pnpm typecheck` and `pnpm lint` both clean.
- **Committed in:** `bf895b9` (Task 3 commit)

---

**Total deviations:** 1 auto-fixed test bug (Rule 1, test-only, no production behavior change), 1 auto-fixed typecheck/build blocker (Rule 3, design refinement with no behavior change).
**Impact on plan:** Neither changes DISC-03/ACT-01 scope or behavior — both are corrections that keep the test suite honest and the production build green.

## Issues Encountered

None beyond the two auto-fixed items above.

## User Setup Required

None — no external service configuration required.

## Next Phase Readiness

- `connectAndDiscover` is ready for plan 03-09 (`trustFingerprint`, which will read `pending_fingerprint` this plan parks) and plan 03-10 (the real-sshd end-to-end canary run of this same service).
- Phase 4's `connect-server` job and DISC-05's re-run flow both have their one entry point; no further wiring is needed at the service layer for those to call in.
- `pnpm test` (735 unit), `pnpm test:integration` (298 passed, 1 pre-existing skip), `pnpm typecheck`, `pnpm lint`, `pnpm exec turbo boundaries` all green; no stray `noodara.test=true` container survived the run.
- No blockers for plan 03-09.

---
*Phase: 03-servicios-de-aplicaci-n-activity-log-y-redacci-n*
*Completed: 2026-09-16*

## Self-Check: PASSED

All created source/test files and this SUMMARY are present on disk; all three task commits
(633be00, 5fa5f6b, bf895b9) are present in git history.
