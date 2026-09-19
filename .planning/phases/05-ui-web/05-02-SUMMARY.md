---
phase: 05-ui-web
plan: 02
subsystem: infra
tags: [pino, logging, bullmq, redis, shutdown, security-remediation]

# Dependency graph
requires:
  - phase: 04-http-routes-worker-bullmq-y-sse
    provides: worker.ts entrypoint, BullMQ worker/queue, Redis connection factories, pino logger
provides:
  - Central pino `serializers.err` reducing every logged error to `{ name }` only, closing T-4-10 and T-4-38 for all three known raw-`err` call sites without editing them
  - Extracted, unit-tested `runWorkerShutdown` worker shutdown sequence with per-step failure isolation, closing T-4-32
  - `worker.ts` wired to `runWorkerShutdown`
affects: [05-ui-web remaining plans (D-17 required all four open Phase 4 threats closed before UI work), any future plan adding a new `logger.error({ err })`/`logger.warn({ err })` call site]

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "Central pino err serializer: any `{ err }` logged through createLogger() reduces to `{ name }`, never message/stack/cause/code — new call sites inherit the control by default"
    - "Identity-keyed re-entry guard (WeakSet<deps>) for an extracted shutdown sequence, letting concurrent invocations with the same deps object dedupe while keeping separate test-invocations isolated"
    - "Per-cleanup-step try/catch isolation in a teardown sequence, mirroring sse-broadcaster.ts's closeAll() precedent: one step's failure never skips a later step"

key-files:
  created:
    - apps/control-plane/src/queue/worker-shutdown.ts
    - apps/control-plane/src/queue/worker-shutdown.test.ts
  modified:
    - apps/control-plane/src/logger.ts
    - apps/control-plane/src/logger.test.ts
    - apps/control-plane/src/worker.ts

key-decisions:
  - "runWorkerShutdown's re-entry guard is a WeakSet keyed by the deps object identity (not a single module-level boolean), so worker.ts's own local shuttingDown flag is kept as the primary guard and the helper's guard is intentionally redundant defense-in-depth"
  - "Pino serializers.err returns only { name }: e instanceof Error ? e.name : 'UnknownError' — no message, stack, cause or code, matching 05-PATTERNS.md's preferred Fix option A"

patterns-established:
  - "Pattern: any future logger.error/logger.warn call passing { err } is automatically safe — no call-site review needed for T-4-10/T-4-38-class leaks"
  - "Pattern: extracting a process-teardown sequence into a pure, dependency-injected function (no process.exit inside) is how shutdown logic becomes unit-testable with fake timers"

requirements-completed: [QA-05]

# Metrics
duration: 18min
completed: 2026-09-19
---

# Phase 05 Plan 02: Close Remaining Phase 4 Threats Summary

**Central pino `err` serializer collapsing every logged error to its name, plus an extracted and unit-tested `runWorkerShutdown` sequence that survives a rejecting `close`/`queue.close` and still disconnects Redis and exits.**

## Performance

- **Duration:** 18 min
- **Started:** 2026-09-19T07:30:00Z (approx, first RED commit 2026-09-19T07:30:22Z)
- **Completed:** 2026-09-19T07:35:34Z
- **Tasks:** 3
- **Files modified:** 5 (2 created, 3 modified)

## Accomplishments

- Closed T-4-10 and T-4-38 with a single central `serializers.err` option in `logger.ts`: `queue/connect-server-worker.ts`'s `worker.on('failed', ...)` and `events/redis-server-event-publisher.ts`/`events/sse-broadcaster.ts`'s warn logs are now safe with zero call-site edits, verified against real captured pino output.
- Closed T-4-32 by extracting `worker.ts`'s inline shutdown closure into `apps/control-plane/src/queue/worker-shutdown.ts`'s `runWorkerShutdown(deps)`, unit-tested for 5 distinct failure/ordering behaviors (resolving close, rejecting close, never-settling close under fake timers, rejecting `closeQueue`, double-invocation dedup).
- Wired the real `worker.ts` entrypoint to `runWorkerShutdown`, confirmed with `pnpm build && pnpm test:boot` (6/6 passing, including the real SIGTERM clean-shutdown scenarios).
- Confirmed the fix against a real captured log line in `pnpm security:scan-leaks`'s own run: `{"err":{"name":"AggregateError"}...}` — the new serializer is active and leaking no message/stack in the existing canary suites.

## Task Commits

Each task was committed atomically (TDD RED/GREEN pairs):

1. **Task 1: Central pino err serializer (T-4-10, T-4-38)**
   - `c0483b5` test(05-02): add failing test for pino err serializer (T-4-10, T-4-38)
   - `24eda92` feat(05-02): add central pino err serializer (T-4-10, T-4-38)
2. **Task 2: Extract and harden the worker shutdown sequence (T-4-32)**
   - `f2e2850` test(05-02): add failing test for worker shutdown sequence (T-4-32)
   - `a1585fc` feat(05-02): extract and harden worker shutdown sequence (T-4-32)
3. **Task 3: Wire worker.ts to the hardened shutdown**
   - `3bc1edd` feat(05-02): wire worker.ts to hardened shutdown sequence

_TDD RED/GREEN commits kept separate per project CLAUDE.md; no REFACTOR commit was needed — both GREEN implementations matched the target shape on first pass._

## Files Created/Modified

- `apps/control-plane/src/logger.ts` - added `serializers.err` reducing any logged error to `{ name }`, alongside the existing `redact` option
- `apps/control-plane/src/logger.test.ts` - 4 new cases proving no message/stack leaks, correct `name` for `Error`/`TypeError`, `UnknownError` for non-Error values, and unchanged redaction behavior
- `apps/control-plane/src/queue/worker-shutdown.ts` (new) - `runWorkerShutdown(deps)`: bounded race against `close()`, then `stopHeartbeat`/`closeQueue`/every `disconnect` entry each individually try/catch-isolated, then `exit(0)`; identity-keyed re-entry guard
- `apps/control-plane/src/queue/worker-shutdown.test.ts` (new) - 5 cases covering resolving/rejecting/never-settling `close`, rejecting `closeQueue`, and double-invocation dedup (fake timers for the never-settling case)
- `apps/control-plane/src/worker.ts` - `shutdown()`'s body replaced with a single `runWorkerShutdown(...)` call carrying the same cleanup steps in the same order; local `shuttingDown` guard kept as the primary re-entry guard, `'Worker ready'` log line and `SIGTERM`/`SIGINT` registrations untouched

## Decisions Made

- `runWorkerShutdown`'s re-entry guard is a `WeakSet<WorkerShutdownDeps>` keyed by object identity rather than a single module-level boolean. This lets `worker.ts` keep its existing local `shuttingDown` flag as the effective guard (since each call site can pass a fresh object literal) while the helper's own guard still correctly dedupes when the *same* deps object is passed twice — the shape the plan's Task 2 behavior list explicitly tests.
- No REFACTOR commits: both `serializers.err` and `runWorkerShutdown`'s first implementation matched the target design from 05-PATTERNS.md and the plan's own action text; no cleanup pass was needed after GREEN.

## Deviations from Plan

None - plan executed exactly as written. `worker.ts`'s local `shuttingDown` flag was kept per the plan's own explicit alternative ("otherwise keep the local guard and let the helper's be redundant").

## Issues Encountered

None. All three tasks' acceptance criteria greps and automated verifications passed on first GREEN implementation (one minor comment wording adjustment in `worker-shutdown.ts` was needed so `grep -c "process.exit"` — which matches `.` as any character — returned 0, since the file's own prose originally used the phrase "process exit").

## User Setup Required

None - no external service configuration required.

## Next Phase Readiness

- All four Phase 4 threats flagged as open in `04-SECURITY.md` are now closed with code-level fixes and automated proof (T-4-02/UF-03 in Plan 05-01; T-4-10, T-4-38, T-4-32 in this plan). D-17's precondition for starting Phase 05 UI work is satisfied.
- Full plan verification block green: targeted unit tests (11/11), `pnpm build && pnpm test:boot` (6/6), `pnpm typecheck`, `pnpm lint`, and `pnpm security:scan-leaks` (3/3, with the new serializer visibly active in captured output).
- No blockers for the next 05-ui-web plan.

---
*Phase: 05-ui-web*
*Completed: 2026-09-19*
