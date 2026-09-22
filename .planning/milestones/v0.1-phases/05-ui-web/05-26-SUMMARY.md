---
phase: 05-ui-web
plan: 26
subsystem: control-plane
tags: [connect-and-discover, bullmq-worker, fail-in-flight-connection, wedge-recovery, tdd, testcontainers]

# Dependency graph
requires:
  - phase: 05-ui-web
    provides: "05-VERIFICATION.md gap 2 (backend half) and 05-REVIEW.md WR-A-01: the CONNECTING wedge finding this plan closes; Phase 4's connectAndDiscover/failInFlightConnection/connect-server-worker.ts (Plan 04-07/04-08/04-09)"
provides:
  - "apps/control-plane/src/services/connect-and-discover.ts: a try/catch around the whole post-TX1 region (decode, SSH phase, session close, TX2) that recovers via failInFlightConnection(reason: connect_service_threw) before rethrowing -- a throw anywhere in that region no longer wedges the row in CONNECTING"
  - "apps/control-plane/src/services/fail-in-flight-connection.ts: FailInFlightConnectionInput.reason grows two literals, connect_service_threw and worker_job_failed"
  - "apps/control-plane/src/queue/connect-server-worker.ts: worker.on('failed') now also calls failInFlightConnection(reason: worker_job_failed) as a second line of defense, wrapped in try/catch exactly like the existing 'stalled' listener, never logging job.data"
affects: [05-27..05-37 (later gap-closure plans in this wave); any future plan touching connectAndDiscover, failInFlightConnection or connect-server-worker.ts]

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "connectAndDiscover's post-TX1 region (decode -> SSH phase -> session.close -> TX2) is now a single try block whose catch calls failInFlightConnection defensively (its own failure is swallowed via .catch(() => undefined)) so the ORIGINAL error is always what's rethrown to the caller/BullMQ, never masked by a secondary recovery failure"
    - "the worker's 'failed' listener is now a second, independent line of defense sharing the exact reason literal shape ('worker_job_failed') and try/catch-wrapped async-IIFE structure the pre-existing 'stalled' listener already used -- in the ordinary case it is a no-op (skipped: true) because connectAndDiscover's own catch already recovered the row; it only does real work when that first recovery attempt itself failed (proven with a call-counted db.transaction patch, not asserted from reading the code)"
    - "corrupting a real, persisted credential's AES-256-GCM auth-tag segment (one flipped base64 character) is this suite's RED-trigger technique for 'a credential that no longer decodes' -- deterministic, no NOODARA_MASTER_KEY manipulation needed, and produces the exact SecretTamperError decodeCredential already throws uncaught for a genuinely undecryptable row (e.g. after a master-key rotation)"

key-files:
  created:
    - tests/integration/servers/connect-wedge.test.ts
    - tests/integration/queue/worker-failed-recovery.test.ts
  modified:
    - apps/control-plane/src/services/connect-and-discover.ts
    - apps/control-plane/src/services/fail-in-flight-connection.ts
    - apps/control-plane/src/queue/connect-server-worker.ts
    - tests/integration/services/connect-and-discover.test.ts

key-decisions:
  - "connect-and-discover.test.ts's pre-existing 'is atomic across the connection result, the snapshot and both events' test asserted row.status stays CONNECTING after a poisoned-metadata throw inside TX2 -- that assertion encoded the exact wedge bug this plan fixes. Updated it to assert ERROR/CONNECTION_LOST plus exactly one recovery activity event (before.length + 1), since the row is no longer left wedged; TX2's own rollback (zero snapshot rows, hostFingerprint stays null) is unchanged and still asserted."
  - "Task 3's worker-level regression test needed a second scenario beyond 'a genuinely failing job resolves through the worker path' to actually exercise the worker's own 'failed' listener rather than being trivially satisfied by connectAndDiscover's own post-TX1 catch alone (which normally recovers first). Verified empirically: the first scenario alone still passed even with the listener's recovery call reverted to a stub. Added a second test that forces connectAndDiscover's own recovery attempt to fail (a call-counted db.transaction patch on the worker fixture's real db instance, failing exactly the 2nd db.transaction call) so only the worker's listener can resolve the row -- confirmed this second test goes RED (times out, row stays wedged) when the listener's recovery is reverted, and GREEN against the real implementation."

requirements-completed: [DETL-01, DETL-02]

# Metrics
duration: ~90min
completed: 2026-09-20
---

# Phase 5 Plan 26: CONNECTING Wedge Recovery Summary

**Closes the CONNECTING wedge (05-VERIFICATION.md gap 2, backend half; WR-A-01): a post-TX1 throw in `connectAndDiscover` (credential decode, SSH phase, session close, TX2) now resolves the server row to ERROR/CONNECTION_LOST via `failInFlightConnection`, on both the service's own catch and the worker's `'failed'` listener, instead of leaving it wedged in CONNECTING until a worker restart's sweep.**

## Performance

- **Duration:** ~90 min
- **Started:** 2026-09-20
- **Completed:** 2026-09-20
- **Tasks:** 3 (RED test, GREEN implementation, worker-level regression test + full gate)
- **Files modified:** 5 (2 new test files, 3 source files) + 1 pre-existing test file updated for the new, correct behavior

## Accomplishments

- **Task 1 (RED):** `tests/integration/servers/connect-wedge.test.ts` corrupts a real, persisted credential's AES-256-GCM auth-tag segment (one flipped base64 character) so `decodeCredential` throws a genuine `SecretTamperError` immediately after TX1 commits `CONNECTING` — the same failure shape a master-key rotation leaving a row undecryptable would produce. Observed failing on the load-bearing assertion (`row?.status` stayed `'CONNECTING'`), not a harness error — see RED Observations below.
- **Task 2 (GREEN):**
  - `connect-and-discover.ts`: the entire post-TX1 region (from `decodeCredential` through the `result` transaction, inclusive) is now one `try` block. Its `catch` calls `failInFlightConnection(deps, { actor: input.actor, serverId: row.id, reason: 'connect_service_threw' })` defensively (`.catch(() => undefined)` around the recovery call itself, so a failed recovery attempt can never mask the original error) before rethrowing. The pre-existing `finally { await outcome.session.close() }` around discovery stays exactly where it was.
  - `fail-in-flight-connection.ts`: `FailInFlightConnectionInput.reason` grows two literals — `'connect_service_threw'` and `'worker_job_failed'` — alongside the existing `'worker_stalled'`/`'worker_startup_sweep'`. Metadata stays `{ reason }`, a fixed enum literal, never free text.
  - `connect-server-worker.ts`: `worker.on('failed')` keeps its existing `{ jobId, err }` log line first, then runs a try/catch-wrapped async IIFE (mirroring the pre-existing `'stalled'` listener's shape exactly) that parses the job payload and calls `services.failInFlightConnection({ ..., reason: 'worker_job_failed' })`. Never logs `job.data`; a failed recovery attempt logs only `{ jobId, err }` again, never crashes the worker process.
- **Task 3 (worker-level regression + full gate):** `tests/integration/queue/worker-failed-recovery.test.ts` drives the identical corrupted-credential scenario through the real `createWorker`/BullMQ path (not a direct service call): a job whose handler genuinely throws resolves the row to `ERROR`/`CONNECTION_LOST`, `ssh.connect` is never invoked (decode fails before it), exactly one recovery activity event survives (idempotency across both recovery call sites), and the worker keeps serving a subsequent healthy job afterward. A second test specifically isolates the worker's own `'failed'` listener by forcing `connectAndDiscover`'s own post-TX1 recovery attempt to fail (a call-counted patch on the worker fixture's real `db.transaction`, failing exactly the 2nd call) — proving the listener is a genuine second line of defense, not dead code; this test was confirmed to go RED when the listener's recovery call is reverted (see RED Observations).

## Task Commits

1. **Task 1 RED: reproduce the CONNECTING wedge** - `b125306` (test)
2. **Task 2 GREEN: recover CONNECTING wedge from both service and worker** - `129a0d9` (fix) — includes the necessary update to `connect-and-discover.test.ts`'s pre-existing atomic-rollback test (see Deviations)
3. **Task 3: worker-level regression test through the real BullMQ path** - `2557205` (test)

## RED Observations

- **Task 1** (`connect-wedge.test.ts`): first run failed with `AssertionError: expected 'CONNECTING' not to be 'CONNECTING'` at `expect(row?.status).not.toBe('CONNECTING')` — the exact wedge behavior, not a harness/import error. Corrupted-credential technique verified sound: `decodeCredential` genuinely threw `SecretTamperError` and TX1's committed `CONNECTING` row was never touched by anything downstream, reproducing the bug precisely.
- **Task 3, second test** (`worker-failed-recovery.test.ts`, "recovers via the worker's own 'failed' listener…"): to prove this test actually depends on the worker-level listener (not merely on `connectAndDiscover`'s own catch, which normally recovers first), the listener's recovery call was temporarily reverted to a stub (`return;` immediately after the existing log line) and the suite re-run. Result: `Error: waitUntil: condition not met within 10000ms` — the row stayed wedged in `CONNECTING` for the full timeout, since the service-level catch's own recovery attempt was deliberately forced to fail by the test's `db.transaction` patch and nothing else resolved the row. Restored the real implementation (verified `git diff` empty against the Task-2 commit) and re-ran: both tests green. This confirms the second test exercises the worker's `'failed'` listener specifically, not just the always-present service-level catch.

## Files Created/Modified

- `apps/control-plane/src/services/connect-and-discover.ts` — post-TX1 region wrapped in try/catch; imports `failInFlightConnection`
- `apps/control-plane/src/services/fail-in-flight-connection.ts` — `reason` union grows `connect_service_threw` / `worker_job_failed`
- `apps/control-plane/src/queue/connect-server-worker.ts` — `'failed'` listener recovers via `failInFlightConnection`, try/catch-wrapped, never logs `job.data`
- `tests/integration/servers/connect-wedge.test.ts` — new: service-level RED/regression proof (corrupted credential, idempotent second recovery call)
- `tests/integration/queue/worker-failed-recovery.test.ts` — new: worker-level regression proof (genuine job throw through BullMQ; isolates the `'failed'` listener specifically via a forced first-recovery-attempt failure)
- `tests/integration/services/connect-and-discover.test.ts` — updated one pre-existing test's assertions to match the new, correct (non-wedged) behavior (see Deviations)

## Decisions Made

See `key-decisions` in frontmatter — summarized: (1) `connect-and-discover.test.ts`'s pre-existing atomic-rollback test encoded the wedge bug itself and was updated to assert the new recovered state (`ERROR`/`CONNECTION_LOST`, one recovery event) rather than the old wedged `CONNECTING` assertion; TX2's own rollback guarantees (zero snapshot rows, `hostFingerprint` stays null) are unchanged. (2) Task 3's worker-level test suite needed a second, more targeted scenario (forcing the service-level recovery attempt itself to fail via a call-counted `db.transaction` patch) to genuinely exercise the worker's `'failed'` listener rather than being satisfied by the service-level catch alone — verified empirically both ways (stub-reverted RED, real-implementation GREEN).

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] `connect-and-discover.test.ts`'s pre-existing "is atomic…" test asserted the wedge bug's own symptom**
- **Found during:** Task 2, running the full `connect-and-discover.test.ts` suite after implementing the fix
- **Issue:** The pre-existing test "is atomic across the connection result, the snapshot and both events" forced a throw inside TX2 (a poisoned `warnings` array failing `buildActivityEvent`'s `SensitiveMetadataError` guard) and asserted `row?.status` stayed `'CONNECTING'` afterward — this was the wedge bug's own behavior, now fixed by this plan's Task 2 change. The connection result/snapshot/both-events rollback within TX2 itself is untouched by this plan and still correct.
- **Fix:** Updated the assertions to `row?.status === 'ERROR'`, `row?.lastErrorCode === 'CONNECTION_LOST'` (the `failInFlightConnection` recovery outcome), and `events` length `before.length + 1` (one recovery-written failure event, not zero) — `row?.hostFingerprint` staying `null` is unchanged and still asserted.
- **Files modified:** `tests/integration/services/connect-and-discover.test.ts`
- **Verification:** `pnpm exec vitest run --config vitest.integration.config.ts tests/integration/services/connect-and-discover.test.ts` — 31/31 green.
- **Committed in:** `129a0d9` (same commit as the GREEN implementation, since the test update is a direct, necessary consequence of the fix rather than separate scope)

---

**Total deviations:** 1 auto-fixed (Rule 1 bug — an existing test encoded the exact bug this plan fixes)
**Impact on plan:** Confined to test assertions; no change to `files_modified` beyond what the plan's own Task 2 instructions already covered in spirit (the plan's `files_modified` list did not name this file, but the change is a direct, unavoidable consequence of Task 2's fix — without it, the full `connect-and-discover.test.ts` suite would fail for a reason unrelated to a real regression).

## Issues Encountered

- **Full `pnpm test:integration` run (~32 min, 492 tests across 56 files) showed 8 failures on the first pass**, all traced to the pre-documented, machine-specific Docker resource-contention class (STATE.md's Blockers/Concerns section; established re-run protocol in 05-21-PLAN.md): a `PostgreSqlContainer` port-bind timeout in `connect-wedge.test.ts`'s first test cascaded into `assertNoStrayTestContainers` failures (stray container count 1 instead of 0) across five other files that ran afterward in the same sequential (`fileParallelism: false`) process — `connect-wedge.test.ts` (both tests), `worker-failed-recovery.test.ts` (both tests), `tests/integration/db/schema.test.ts` (both tests), `tests/integration/events/sse-broadcaster-subscribe.test.ts` (one test), and `tests/integration/activity/canary-http.test.ts` (one test). **Isolated re-runs prove this was environmental, not a regression:** re-running `connect-wedge.test.ts` + `worker-failed-recovery.test.ts` together in isolation gave 4/4 green (13.27s); re-running `schema.test.ts` + `sse-broadcaster-subscribe.test.ts` + `canary-http.test.ts` together in isolation gave 4/4 green (12.59s). No stray `noodara.test=true` containers were present on the host before or after these isolated re-runs (`docker ps -a --filter label=noodara.test=true` empty). Per hard_rules #8's honesty requirement: the one full run's raw exit code was 1 (not 0), but every failure is accounted for and proven non-regression via isolated re-run, matching the exact protocol 05-21-PLAN.md itself establishes for this known flakiness class. Skip count stayed at 1 (`tests/integration/ssh/stress-connections.test.ts`'s opt-in stress suite), matching the prior baseline — no newly-skipped tests.
- `pnpm lint`, `pnpm typecheck`, `pnpm test` (1381/1381 unit) all green on a clean, separate run.
- No new dependency in `package.json` or the lockfile.

## User Setup Required

None — no external service configuration required. No new packages installed.

## Next Phase Readiness

- The CONNECTING wedge (05-VERIFICATION.md gap 2's backend half, 05-REVIEW.md WR-A-01) is closed: `DETL-02`'s two named states (never-discovered / discovery-failed) are now always reachable from a real connect attempt, never blocked behind a permanently wedged `CONNECTING`/`SERVER_BUSY` state.
- Remaining plans in this gap-closure wave (05-27…05-37) are unaffected by this plan's scope — `connectAndDiscover`, `fail-in-flight-connection.ts` and `connect-server-worker.ts` are otherwise unchanged in shape (same exported functions, same `ServerServices` facade member count, same BullMQ listener set).

---
*Phase: 05-ui-web*
*Completed: 2026-09-20*

## Self-Check: PASSED

Verified on disk: `apps/control-plane/src/services/connect-and-discover.ts`, `apps/control-plane/src/services/fail-in-flight-connection.ts`, `apps/control-plane/src/queue/connect-server-worker.ts`, `tests/integration/servers/connect-wedge.test.ts`, `tests/integration/queue/worker-failed-recovery.test.ts`, `tests/integration/services/connect-and-discover.test.ts`. All three task commits (`b125306`, `129a0d9`, `2557205`) confirmed present in `git log --oneline --all`. Acceptance-criteria greps confirmed: `failInFlightConnection` present in `connect-and-discover.ts`; `worker_job_failed` present in `connect-server-worker.ts`; no `job.data` reference inside a logger call in `connect-server-worker.ts`. `pnpm typecheck`, `pnpm lint`, `pnpm test` (1381/1381) all green.
