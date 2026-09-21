---
phase: 05-ui-web
plan: 41
subsystem: api
tags: [pino, logging, observability, drizzle, connect-and-discover, gap-closure]

# Dependency graph
requires:
  - phase: 05-ui-web
    provides: "05-38's connect-and-discover.ts catch-block precedent and the trust-fingerprint gating this plan does not touch"
provides:
  - "an optional, structural ServiceLogger on ServerServicesDeps"
  - "logRecoveryFailure: the one unit-tested helper that logs a swallowed connect-and-discover recovery failure without leaking error text"
  - "connect-and-discover.ts's post-TX1 catch block now logs a failing failInFlightConnection recovery attempt instead of discarding it silently"
  - "both apps/control-plane/src/app.ts (via app.log) and apps/control-plane/src/worker.ts (via its existing module-level logger) supply a real logger to services"
affects: [05-ui-web gap closure round 2, 05-46 final gate]

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "ServiceLogger: a minimal structural logging interface (warn/error) declared in server-service-deps.ts so a service module never has to import pino just to type its optional logger dependency"
    - "logRecoveryFailure: fixed-literal log message, Error passed only under the `err` key (never interpolated), own try/catch so a throwing logger can never escalate into a second failure on a recovery path"

key-files:
  created:
    - apps/control-plane/src/services/log-recovery-failure.ts
    - apps/control-plane/src/services/log-recovery-failure.test.ts
  modified:
    - apps/control-plane/src/services/server-service-deps.ts
    - apps/control-plane/src/services/connect-and-discover.ts
    - apps/control-plane/src/app.ts
    - apps/control-plane/src/worker.ts
    - tests/integration/servers/connect-wedge.test.ts

key-decisions:
  - "Added a new integration test (tests/integration/servers/connect-wedge.test.ts) for the Task 2 catch-block wiring itself, beyond what 05-41-PLAN.md's own Task 2 specified, per this execution's explicit hard-rule instruction requiring RED/GREEN coverage for any further behaviour change — a real pino logger via createLogger()+writableForTests() forces the recovery transaction to fail (a Proxy that rejects the 2nd deps.db.transaction() call) and asserts the captured record shape and that a canary secret never leaks"
  - "Used a Proxy around the fixture's real Postgres db, rejecting only the 2nd deps.db.transaction() call, to simulate a transient recovery-transaction failure without corrupting real Postgres state or touching FK-constrained rows"

requirements-completed: [QA-05]

duration: ~55min (continuation agent only; total across both agents unknown)
completed: 2026-09-20
---

# Phase 05 Plan 41: Log connect-and-discover's swallowed recovery failure (GR-03) Summary

**Added `logRecoveryFailure` + an optional `ServiceLogger` on `ServerServicesDeps`, wired into `connect-and-discover.ts`'s catch block so a failing `failInFlightConnection` recovery attempt is logged at `warn` with no error text or secret ever reaching the log, while the original error still always propagates.**

## Continuation note

This plan was resumed by a fresh continuation agent after a prior executor stalled mid-Task-1, having staged (but not committed) the GREEN for `logRecoveryFailure`/`ServiceLogger`/`server-service-deps.ts` changes, with the RED commit (`add88f0`) already on `main`. This agent verified the staged diff against the plan's Task 1 spec and hard rules, ran the full verification suite, committed the GREEN, then executed Task 2 (including an additional RED/GREEN test cycle for the wiring itself, per this execution's own hard rules) to completion.

## Performance

- **Started (continuation):** 2026-09-20 (session start)
- **Tasks:** 2/2 complete
- **Commits this session:** 3 (`fa2ed4f` GREEN Task 1, `238ad4e` RED Task 2 wiring test, `06da279` GREEN Task 2 wiring)
- **Files modified this session:** 7 (3 staged-by-prior-agent + committed, 3 wiring files, 1 new test coverage in an existing file)

## Accomplishments

- `logRecoveryFailure(deps, serverId, err)` — logs once at `warn` with `{ err, serverId }` and a fixed literal message, never throws (absent logger, throwing logger, non-Error rejection all handled), never puts error text (including a secret-shaped one) into the log text. 6/6 behaviours unit-tested, all green.
- `ServiceLogger` (structural `warn`/`error`) and `ServerServicesDeps.logger?: ServiceLogger` added; `resolveServerServicesDeps` propagates `overrides.logger` only when defined (`exactOptionalPropertyTypes`-safe, mirrors `defaultMasterKeys()`'s `previous` precedent).
- `connect-and-discover.ts`'s post-TX1 catch block: `failInFlightConnection(...).catch(() => undefined)` became `.catch((recoveryErr) => { logRecoveryFailure(deps, row.id, recoveryErr); })` — the `await` and the immediately-following `throw err` are both unchanged.
- `app.ts`: `createServerServicesResolver` takes a third `logger: ServiceLogger` parameter; the call site passes `app.log` (the Fastify pino instance already created at that point). No second `createLogger()` call added.
- `worker.ts`: `resolveServerServicesDeps({ db, events: eventPublisher, logger })` now passes the existing module-level `logger`. No second `createLogger()` call added.
- New integration test proves the wiring end-to-end with a **real** pino logger (`createLogger` + `writableForTests`), a real Postgres-backed `connectAndDiscover` run, and a `Proxy`-based simulated transient failure of the recovery transaction — confirming the captured log record's shape, that a canary secret placed on the recovery error never leaks into the output, and that the row is left in `CONNECTING` (not `ERROR`) because the recovery attempt itself failed.

## Task Commits

Task 1 was split across two agents; this agent completed and committed the GREEN, then added its own RED/GREEN cycle for Task 2's wiring:

1. **Task 1 RED (prior agent, verified by this agent):** `add88f0` `test(05-41): add failing test for logRecoveryFailure`
2. **Task 1 GREEN (this agent, verified prior agent's staged work then committed):** `fa2ed4f` `feat(05-41): add logRecoveryFailure and optional deps logger`
3. **Task 2 RED (this agent, added — see Deviations):** `238ad4e` `test(05-41): add failing recovery-failure logging coverage`
4. **Task 2 GREEN (this agent):** `06da279` `feat(05-41): log recovery-attempt failures in connect-and-discover`

**Plan metadata:** this commit (`docs(05-41): ...`, added after this SUMMARY)

## Files Created/Modified

- `apps/control-plane/src/services/log-recovery-failure.ts` (created) — the one place a swallowed `failInFlightConnection` recovery failure is logged
- `apps/control-plane/src/services/log-recovery-failure.test.ts` (created) — 6 unit tests: logs once with `{ err, serverId }`; message never contains error text; a secret-shaped error message never reaches the log text; never throws when logger absent; never throws when logger itself throws; handles a non-Error rejection value
- `apps/control-plane/src/services/server-service-deps.ts` (modified) — exports `ServiceLogger`; `ServerServicesDeps.logger?: ServiceLogger`; `resolveServerServicesDeps` omits (never assigns `undefined` to) `logger` when absent
- `apps/control-plane/src/services/connect-and-discover.ts` (modified) — the post-TX1 catch's `.catch(() => undefined)` now calls `logRecoveryFailure(deps, row.id, recoveryErr)`; `throw err` unchanged
- `apps/control-plane/src/app.ts` (modified) — `createServerServicesResolver` takes `logger: ServiceLogger`; call site passes `app.log`
- `apps/control-plane/src/worker.ts` (modified) — `resolveServerServicesDeps({ db, events: eventPublisher, logger })` reuses the existing module-level logger
- `tests/integration/servers/connect-wedge.test.ts` (modified, beyond plan scope — see Deviations) — a new `describe('recovery-failure logging ...')` block: a `buildNthTransactionFailingDb` helper (a `Proxy` that rejects the Nth `db.transaction()` call) and one test proving the wiring end-to-end with a real captured pino stream

## Decisions Made

- Kept the prior agent's staged Task 1 diff as-is after verifying it matches the plan's spec exactly (test-file diff was a pure lint/style normalization — bracket to dot notation, arrow-body braces — with identical assertions; not a weakened RED).
- Added RED/GREEN test coverage for the Task 2 catch-block wiring itself (see Deviations below), since this execution's own hard rules required it even though `05-41-PLAN.md`'s own Task 2 (`type="auto"`) only asked for the pre-existing `connect-wedge.test.ts` suite to stay green.
- Used a `Proxy` around the real fixture `db` rejecting only the 2nd `.transaction()` call (a stand-in for a transient Postgres failure) rather than corrupting real Postgres rows or FK-constrained data — `lockAndBeginConnecting` (TX1) is always transaction-call #1 in the corrupted-credential scenario this suite already uses, so `failInFlightConnection`'s own transaction is always call #2.

## Deviations from Plan

### Auto-added test coverage

**1. [Rule 2 / explicit hard-rule instruction] Added RED/GREEN integration test coverage for Task 2's catch-block wiring**
- **Found during:** Task 2 (wiring `logRecoveryFailure` into `connect-and-discover.ts`'s catch block)
- **Issue:** `05-41-PLAN.md`'s own Task 2 is `type="auto"` and its only automated verification is that the pre-existing `connect-wedge.test.ts` suite (which never exercises a *failing* recovery attempt) stays green. This execution's own hard rules require "TDD with separate RED/GREEN commits for any further behaviour change (e.g. the catch-block wiring)" with tests that "exercise real behaviour: a real pino logger from `createLogger` writing to a captured stream, asserting the record shape and that a canary secret placed in the error message appears NOWHERE in the output" — a requirement the plan's own Task 2 verification did not satisfy.
- **Fix:** Added a `describe('recovery-failure logging (05-41-PLAN.md, 05-REVIEW.md GR-03)')` block to `tests/integration/servers/connect-wedge.test.ts`. RED (`238ad4e`) failed with `expected [] to have a length of 1 but got +0` (no log record captured, since the wiring did not exist yet) while the file's two pre-existing tests stayed green. GREEN (`06da279`) — same test — now passes: 1 captured record, `msg` equal to the fixed literal, `serverId` matching, `err` reduced to `{ name: 'Error' }` by `logger.ts`'s global serializer, and the canary secret (`sk-live-RECOVERY-CANARY`) absent from the raw JSON-stringified output. The test also independently confirms the row is left in `CONNECTING` (not `ERROR`) when the recovery attempt itself fails — a real behavioural fact this plan's objective implies but the pre-existing suite never asserted.
- **Files modified:** `tests/integration/servers/connect-wedge.test.ts`
- **Committed in:** `238ad4e` (RED), `06da279` (GREEN, alongside the wiring itself)

**Impact on plan:** `git diff --name-only` from before this session's work to `HEAD` therefore lists **seven** files, not the six `05-41-PLAN.md` frontmatter's `files_modified` declares — the extra file is `tests/integration/servers/connect-wedge.test.ts`. This is a deliberate, test-only addition to close a real coverage gap the plan's own Task 2 left open; no production code beyond what the plan specified was touched.

**Total deviations:** 1 (test-coverage addition, driven by this execution's own hard rules rather than by a bug found in the plan's design)

## Issues Encountered

- `tests/integration/servers/**` and `tests/integration/services/**` are not covered by either `pnpm typecheck` (which only typechecks `apps/control-plane/src` plus `tests/integration/ssh` and `tests/e2e`) or `pnpm lint` (turbo's `lint` task only runs inside each package, none of which include the top-level `tests/` directory) — this is a pre-existing gap, not something this plan introduced or is in scope to fix. I manually reviewed the new test code for style/type correctness and it runs correctly under `vitest` (which transpiles but does not typecheck), but it received no automated lint/typecheck pass. Logged here rather than silently worked around.

## Verification Results

- `pnpm vitest run apps/control-plane/src/services/log-recovery-failure.test.ts apps/control-plane/src/services/server-service-deps.test.ts` — **21 passed (21)**, 2 files.
- `pnpm typecheck` — green (8/8 turbo tasks + the two extra `tsc -p` invocations).
- `pnpm lint` — green (9/9 turbo tasks; does not cover `tests/integration/**`, see Issues Encountered).
- `NOODARA_API_ORIGIN=http://localhost:3100 pnpm test:integration tests/integration/servers/connect-wedge.test.ts` — **3 passed (3)** (the two pre-existing wedge-recovery tests plus the new recovery-failure-logging test).
- `NOODARA_API_ORIGIN=http://localhost:3100 pnpm test:integration tests/integration/services/fail-in-flight-connection.test.ts tests/integration/services/connect-and-discover.test.ts` — **51 passed (51)**.
- `pnpm test` (unit) — **1525 passed (1525)**, 119 files.
- `NOODARA_API_ORIGIN=http://localhost:3100 pnpm test:boot` — **7 passed (7)** (proves `app.ts`/`worker.ts` boot correctly from `dist` with the new `logger` wiring).
- `NOODARA_API_ORIGIN=http://localhost:3100 pnpm security:scan-leaks` — **1 passed (1)** (`canary-ui.spec.ts`).

Acceptance-criteria greps:
- `grep -c '\${' apps/control-plane/src/services/log-recovery-failure.ts` → `0`
- `grep -c "logger: undefined" apps/control-plane/src/services/server-service-deps.ts` → `0`
- `grep -c "logRecoveryFailure" apps/control-plane/src/services/connect-and-discover.ts` → `3` (import + call + one comment reference)
- `grep -c "catch(() => undefined)" apps/control-plane/src/services/connect-and-discover.ts` → `0`
- `grep -c "createLogger()" apps/control-plane/src/worker.ts` → `1`
- `grep -c "createLogger()" apps/control-plane/src/app.ts` → `1`

## RED output (Task 1, reported by the prior agent — not independently re-captured)

The RED commit (`add88f0`) landed before this continuation agent started; this agent verified the resulting GREEN implementation satisfies every behaviour the RED test file asserts (see `log-recovery-failure.test.ts`'s 6 `it(...)` blocks), but did not re-run the tree at the RED commit to capture verbatim console output, since doing so would have required checking out an older commit mid-session. The failure mode at that commit is inferable from the diff: `log-recovery-failure.ts` did not exist, so every test in `log-recovery-failure.test.ts` would have failed at import time with a module-resolution error (`Cannot find module '../../.../log-recovery-failure.js'` or equivalent), and `server-service-deps.test.ts` would have failed on any assertion referencing `ServiceLogger`/`deps.logger`.

## RED output (Task 2 wiring test, captured directly by this agent)

```
 ❯ tests/integration/servers/connect-wedge.test.ts (3 tests | 1 failed) 7213ms
   ❯ recovery-failure logging (05-41-PLAN.md, 05-REVIEW.md GR-03) (1)
     × a failing recovery attempt is logged through a real pino logger with no error text or secret leaked, ...

AssertionError: expected [] to have a length of 1 but got +0

- Expected
+ Received

- 1
+ 0

 ❯ tests/integration/servers/connect-wedge.test.ts:248:26
      246|
      247|       const logRecords = records();
      248|       expect(logRecords).toHaveLength(1);
       |                          ^
```

The other two tests in the file (the pre-existing wedge-recovery suite) passed, confirming the RED failure was isolated to the new test and not a regression.

## Final catch block (verbatim, `apps/control-plane/src/services/connect-and-discover.ts`)

```ts
  } catch (err) {
    // T-5G-26-01: a throw anywhere in the block above (credential decode, fingerprint parse, the
    // SSH phase, session.close(), TX2) must never leave the row wedged in CONNECTING — recover it
    // before rethrowing so the caller (and BullMQ, whose own 'failed' listener is the second line
    // of defense) still observes the original failure. The recovery call is deliberately
    // defensive: if it also throws, the ORIGINAL error is still the one rethrown below. GR-03: a
    // recovery failure is now logged (via `logRecoveryFailure`) instead of discarded silently, but
    // it still never masks the original error — `err` below remains the value rethrown.
    await failInFlightConnection(deps, {
      actor: input.actor,
      serverId: row.id,
      reason: 'connect_service_threw',
    }).catch((recoveryErr: unknown) => {
      logRecoveryFailure(deps, row.id, recoveryErr);
    });
    throw err;
  }
```

## `ServiceLogger` declaration (verbatim, `apps/control-plane/src/services/server-service-deps.ts`)

```ts
/**
 * The minimal, structural logging surface a service needs (currently only
 * `log-recovery-failure.ts`, GR-03). Declared here — not imported from `pino` — so this module
 * (and anything that only needs the *type*) never depends on pino; a real pino `Logger` already
 * satisfies this shape structurally, since it has both methods with a compatible signature.
 */
export interface ServiceLogger {
  warn(metadata: object, message: string): void;
  error(metadata: object, message: string): void;
}
```

## User Setup Required

None - no external service configuration required.

## Next Phase Readiness

- GR-03 is closed: a swallowed `connectAndDiscover` recovery failure is now visible to an operator, with no leaked error text or secret, and the original error still always propagates.
- No blockers for the remaining gap-closure round 2 plans (05-42 onward) or the final gate plan (05-46).

---
*Phase: 05-ui-web*
*Completed: 2026-09-20*
