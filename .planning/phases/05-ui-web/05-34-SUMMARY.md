---
phase: 05-ui-web
plan: 34
subsystem: api
tags: [fastify, sse, pino, ioredis, bullmq, backpressure, logging]

# Dependency graph
requires:
  - phase: 05-ui-web (plan 05-20)
    provides: the SSE cap/session-lookup/backpressure teardown path (routes/events.ts) this plan extends, and the abandoned-stream leak debug history (.planning/debug/sse-lost-event-race.md)
provides:
  - A bounded per-connection backpressure budget on GET /api/events (SSE_MAX_BUFFERED_BYTES, exceedsBackpressureBudget), with a real-socket integration proof that a never-reading peer's slot is freed
  - A reply.raw 'error' listener and a write-time-throw guard, both routed through the same teardown a clean disconnect already uses
  - server.ts's app.listen() failure now logged through the { err } merging-object form, closing the pino err-serializer bypass at its one live call site
  - worker.ts's entrypoint guarded with main().catch(...), replacing a bare, uncaught call and its raw Node crash dump on boot failure
affects: [05-ui-web (05-37 human-verification triage batch, which lists WR-A-03/WR-A-04/UF-02 among the items to confirm closed)]

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "SSE write-path backpressure guard: a safeWrite() wrapper checks reply.raw.writableLength against a named, exported budget constant before every write, evicting through the same cleanup()/broadcaster.remove() path a clean disconnect uses -- never a second teardown path"
    - "Logging: always the { err } merging-object form for logger.error/logger.fatal, never a bare Error as the first argument -- pino's own first-argument special-case copies err.message into the record's msg field independently of the configured err serializer"
    - "Entrypoint guard: main().catch((err) => { logger.error({ err }, '<fixed message>'); process.exit(1); }) instead of a bare void main(); -- a boot-time rejection must produce a structured pino line and a non-zero exit, never rely on Node's default unhandled-rejection behavior"

key-files:
  created:
    - tests/integration/events/sse-backpressure.test.ts
    - apps/control-plane/src/server.test.ts
  modified:
    - apps/control-plane/src/routes/events.ts
    - apps/control-plane/src/routes/events.test.ts
    - apps/control-plane/src/server.ts
    - apps/control-plane/src/worker.ts
    - tests/integration/boot/boot-command.test.ts

key-decisions:
  - "SSE_MAX_BUFFERED_BYTES set to 1 MiB (matching 05-REVIEW.md's own suggested fix), exported alongside a pure exceedsBackpressureBudget(bufferedBytes) predicate so the decision is unit-testable without a real socket"
  - "server.test.ts and the sse-backpressure.test.ts integration test were added even though the plan's files_modified list didn't name them -- TDD requires a place to put the RED/GREEN test, and no substitute existed"
  - "worker.ts's guard uses the plan's own documented fallback shape (main().catch(...) with a fixed message) because server.ts has no guard on its own equivalent bottom-level call either -- there was no existing guard to match, exactly the case 05-34-PLAN.md's Task 3 action anticipated"

patterns-established:
  - "A half-open or non-draining SSE peer is evicted via the connection's own writableLength crossing a named budget, not via a fixed event count or a timer"

requirements-completed: [UI-01, DETL-02]

# Metrics
duration: 42min
completed: 2026-09-20
---

# Phase 05 Plan 34: SSE Backpressure, Err-Serializer Bypass, Worker Entrypoint Guard Summary

**Bounded per-connection backpressure eviction on the SSE route (1 MiB, real-socket-proven), closed the pino err-serializer bypass in server.ts's listen-failure log, and guarded worker.ts's entrypoint so a boot-time rejection exits non-zero with a structured line instead of a raw crash dump.**

## Performance

- **Duration:** 42 min
- **Started:** 2026-09-20T11:22:00-06:00 (approx, first file read)
- **Completed:** 2026-09-20T11:44:03-06:00 (last task commit)
- **Tasks:** 3
- **Files modified:** 7 (5 modified, 2 created)

## Accomplishments

- `GET /api/events` no longer lets a peer that opens a stream and then never reads hold one of the 32 capped slots until TCP retransmission gives up (or forever): once a stream's buffered-but-unflushed bytes exceed `SSE_MAX_BUFFERED_BYTES` (1 MiB), it is evicted through the exact same `cleanup()`/`broadcaster.remove()` path a clean disconnect already uses. A write-time `error` on `reply.raw` and a write that throws both route through the same `evict()`.
- Proved this with a real TCP socket, not `app.inject()` — light-my-request's mocked response writes into a null sink that always drains instantly, so it can never reproduce genuine backpressure. `tests/integration/events/sse-backpressure.test.ts` fills a 3-connection test cap with peers that stop reading right after the response headers, then publishes real `server.deleted` events through the real Redis-backed broadcaster until the budget is crossed, and asserts a fresh client can connect again.
- `server.ts`'s `app.listen()` failure callback no longer logs a bare `Error` (`app.log.error(err)`), which bypasses `logger.ts`'s custom `err` serializer for the record's own `msg` field even though the serializer still strips `message`/`stack` from the `err` key itself. It now uses `app.log.error({ err }, 'listen failed')`, the same shape already used correctly elsewhere (`connect-server-worker.ts`'s `{ jobId, err }`).
- `worker.ts`'s `main()` is no longer invoked with a bare, uncaught call. A rejection (unreachable Postgres/Redis, a bad master key, a failed startup sweep) now produces a structured pino error line and `process.exit(1)`, instead of depending entirely on Node's own default unhandled-rejection behavior and printing a raw stack-trace crash dump.

## Task Commits

1. **Task 1: SSE writes that release the slot instead of leaking it** - `b4d9d3b` (fix)
2. **Task 2: Error-handler logging through pino's err serializer** - `318dd8f` (fix)
3. **Task 3: Guarded worker entrypoint (UF-02), then the full integration gate** - `0276790` (fix)

_No plan-metadata commit yet — STATE.md/ROADMAP.md/this SUMMARY are committed together after this file is written (see below)._

## Files Created/Modified

- `apps/control-plane/src/routes/events.ts` - Adds `SSE_MAX_BUFFERED_BYTES` (1 MiB, exported with its rationale in a comment) and `exceedsBackpressureBudget()`; a `safeWrite()` wrapper checks `reply.raw.writableLength` on every publish and heartbeat write; `reply.raw.on('error', evict)` and a write-time try/catch both route through the same `cleanup()`
- `apps/control-plane/src/routes/events.test.ts` - Unit tests for the exported budget predicate, a RETRY_FIELD-first-byte regression guard, and the `'error'`-listener releasing the slot via `light-my-request`'s `response.raw.res.emit('error', ...)` (no real socket needed for this one)
- `tests/integration/events/sse-backpressure.test.ts` (new) - Real-TCP-socket proof: a peer that stops reading fills the test's 3-connection cap, a burst of published events crosses the budget, and a fresh client connects again. Shrinks both the client's receive buffer and the server's accepted-socket send buffer (test-harness-only, via `net.Socket.setRecvBufferSize`/`setSendBufferSize`) so the test converges on genuine publish volume rather than this machine's own TCP autotuning (measured up to 4 MiB autotune ceiling on this dev machine)
- `apps/control-plane/src/server.ts` - `app.listen()`'s error callback: `app.log.error(err)` → `app.log.error({ err }, 'listen failed')`
- `apps/control-plane/src/server.test.ts` (new) - Characterizes the vulnerability class (a bare `Error` leaks its message into `msg`) and the fixed shape's safety (the `{ err }` form does not), against the real, unmodified `createLogger()` — `server.ts` itself is a self-executing entrypoint and cannot be safely unit-imported
- `apps/control-plane/src/worker.ts` - Replaces the bare entrypoint call with `main().catch((err) => { logger.error({ err }, 'worker boot failed'); process.exit(1); })`
- `tests/integration/boot/boot-command.test.ts` - New `describe` block: spawns the real `dist/worker.js` with a fake (never-connected, since `pg.Pool` is lazy) `DATABASE_URL` and a genuinely unreachable `REDIS_URL`, and asserts a non-zero exit plus a structured pino line on stdout

## Decisions Made

- `SSE_MAX_BUFFERED_BYTES = 1_048_576` (1 MiB): matches 05-REVIEW.md's own suggested fix value. A single `ServerView` SSE frame is a few hundred bytes and even a `server.discovery_progress` burst is a handful of frames, so no briefly-slow-but-draining client is evicted for ordinary jitter; a genuinely stuck peer's buffer is bounded, and worst case across the whole 32-connection cap stays a bounded, single-digit number of MiB.
- Added `apps/control-plane/src/server.test.ts` and `tests/integration/events/sse-backpressure.test.ts`, neither named in the plan's `files_modified`/task `<files>` lists — TDD is mandatory per CLAUDE.md §2.1 and the plan's own `tdd="true"` tasks, and there was no existing test file to extend for either. Documented here rather than silently expanding scope.
- Task 3's `main().catch(...)` shape matches the plan's own documented fallback ("if server.ts has no guard either, use `main().catch((err) => {...})`") — confirmed `server.ts`'s own bottom-level call also has no guard, so there was nothing to mirror; `server.ts`'s equivalent gap stays out of this plan's scope per 05-REVIEW.md's own out-of-scope note.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 3 - Blocking] Added `apps/control-plane/src/server.test.ts`, not listed in Task 2's `<files>`**
- **Found during:** Task 2
- **Issue:** The task's own action requires a RED test ("Observe RED against the current `app.log.error(err)` call") but names only `server.ts` in `<files>`, and no `server.test.ts` existed. `server.ts` is a self-executing entrypoint (`void main()` ran at import time even before this fix, now `main().catch(...)` still runs at import time), so it cannot be unit-imported to exercise the bug directly without a live Postgres and a fully valid environment.
- **Fix:** Added `server.test.ts` that pins the exact call shape `server.ts`'s callback uses (bare `Error` vs. the `{ err }` merging-object form) against the real, unmodified `createLogger()` — the same standalone-reproduction technique 05-REVIEW.md itself used to confirm WR-A-04. The static grep acceptance criteria (`app.log.error(err)` absent, `app.log.error({ err` present) are the direct proof the real file changed; this test grounds the fix's safety in an executable assertion rather than documentation alone.
- **Files modified:** `apps/control-plane/src/server.test.ts` (new)
- **Verification:** Ran RED (against the pre-fix bare-`Error` call, characterized inline, not by importing `server.ts`) then GREEN; 8/8 tests pass across `server.test.ts` + `logger.test.ts`
- **Committed in:** `318dd8f` (Task 2 commit)

**2. [Rule 1 - Bug/self-caught] Reworded a worker.ts comment that tripped Task 3's own acceptance-criteria grep**
- **Found during:** Task 3
- **Issue:** The explanatory comment above the new `main().catch(...)` guard used the literal substring `void main();` in prose (describing what was removed), which made `grep -n "void main();" apps/control-plane/src/worker.ts` — Task 3's own acceptance criterion — return a false-positive match against the comment, even though the actual code no longer contains that call. Same class of self-inflicted grep trip STATE.md already records for Phase 05-03's `check-package-provenance.mjs` docstring.
- **Fix:** Reworded the comment to describe the removed call without using the literal semicolon-terminated substring (e.g. "a bare, uncaught `void` call" instead of quoting `void main();`).
- **Files modified:** `apps/control-plane/src/worker.ts`
- **Verification:** `grep -n "void main();" apps/control-plane/src/worker.ts` now returns no match; lint/typecheck and the RED-then-fixed boot test re-run clean after the wording change
- **Committed in:** `0276790` (Task 3 commit)

**3. [Rule 1 - Bug, in my own test] Corrected the new boot test's stream assumption from stderr to stdout**
- **Found during:** Task 3
- **Issue:** The plan's Task 3 action describes asserting "a structured error line on stderr", but pino's default destination is stdout — confirmed by running the pre-fix and post-fix worker binary directly: the structured `{"level":50,...}` line landed on stdout both times, never stderr (stderr only ever carried the `[redis] ... connection error: <name>` warnings from `redis/connections.ts`'s own `'error'` listeners, and, pre-fix, Node's raw crash-dump stack trace).
- **Fix:** Asserted the structured line on `activeProcess.stdout` instead, and added a negative assertion that `stderr` never contains a raw stack-trace line (`/^\s+at .+\(.+:\d+:\d+\)/m`), which is what the pre-fix crash dump looked like and the post-fix run does not produce.
- **Files modified:** `tests/integration/boot/boot-command.test.ts`
- **Verification:** RED observed with the plan's original stderr-based assertion failing for the right reason (no `{`-prefixed line on stderr, even post-fix); corrected assertion then RED (pre-fix, no `main().catch` yet) → GREEN (post-fix)
- **Committed in:** `0276790` (Task 3 commit)

---

**Total deviations:** 3 auto-fixed (1 blocking/Rule 3 — a required test file the plan didn't name, 2 self-caught Rule-1-class corrections in my own new code/comments)
**Impact on plan:** All three were necessary for the plan's own TDD and acceptance-criteria requirements to actually hold; none touched files outside `apps/control-plane/**` or `tests/integration/**`, and none introduced new dependencies (`git diff package.json pnpm-lock.yaml` is empty).

## RED → GREEN Evidence

**Task 1 (WR-A-03).** `tests/integration/events/sse-backpressure.test.ts`, pre-fix: 3 leaky peers correctly filled the 3-connection test cap (a 4th connection got 503), but after publishing 8000 events (~3.2 MiB) across 40 batches, a fresh client still could not connect — `AssertionError: expected false to be true` on `recovered`. Post-fix, with the same test (tuned to 24000-event ceiling once real `writableLength` growth was measured at ~124 buffered bytes/event and ~1 MiB of published data crossed the budget around event #14,800–15,000): 1 passed, run twice for stability.

**Task 2 (WR-A-04).** Standalone reproduction (not `server.ts` itself, which cannot be unit-imported — see Deviation 1): `logger.error(new Error('CANARY...'))` (the bare shape `server.ts` used) puts the canary string into the emitted record's `msg` field even though the configured `err` serializer strips it from `err.message`/`err.stack`; `logger.error({ err: new Error('CANARY...') }, 'listen failed')` (the fixed shape) does not. Both assertions run and pass against the real, unmodified `createLogger()`.

**Task 3 (UF-02).** `tests/integration/boot/boot-command.test.ts`'s new case, pre-fix: exit code was already 1 (Node's own default unhandled-rejection mode), but stdout was empty and stderr carried a raw `MaxRetriesPerRequestError: Reached the max retries per request limit...` stack-trace dump — `AssertionError: expected false to be true` on `lastLine.startsWith('{')`. Post-fix: exit code 1, stdout's last line is `{"level":50,...,"err":{"name":"MaxRetriesPerRequestError"},"msg":"worker boot failed"}`, stderr carries only the two expected `[redis] ... connection error: Error` warnings, no stack trace.

## Issues Encountered

- Local `.env` was missing `NOODARA_API_ORIGIN`, which `apps/web`'s `next.config.ts` requires at build time — this blocked `pnpm build` (and therefore every integration test run, via `global-setup.ts`) for the whole session. Pre-existing local machine config gap, unrelated to this plan's scope; worked around by exporting `NOODARA_API_ORIGIN=http://localhost:3100` inline in each shell command rather than editing the (gitignored) `.env` file. Not committed, not a code change.
- Measuring the real backpressure budget took two iterations: the first attempt (3.2 MiB published, no socket-buffer shrinking) never crossed the 1 MiB budget because this machine's TCP autotuning (`net.inet.tcp.autorcvbufmax`/`autosndbufmax` = 4 MiB) silently absorbed far more than expected before any application-level `writableLength` growth began. Fixed by shrinking both the test client's receive buffer and the server's accepted-socket send buffer to 16 KiB (test-harness-only, via Node's `setRecvBufferSize`/`setSendBufferSize`), after which growth became linear and predictable (~124 bytes/published event) and the existing 24000-event ceiling comfortably exceeds the budget.

## User Setup Required

None - no external service configuration required.

## UF-02 Todo Status

`grep -rl "UF-02" .planning/` finds no standalone file under `.planning/todos/` — the finding only ever lived as prose in `04-SECURITY.md`, `05-VERIFICATION.md`, `05-REVIEW.md`, `ROADMAP.md` and `STATE.md`. There is nothing under `.planning/todos/pending/` to move to `completed/` for this item. `05-37-PLAN.md`'s triage batch (a separate, non-autonomous human-verification plan) lists UF-02 alongside WR-A-03/WR-A-04 as items to confirm closed with grep/test evidence — this SUMMARY's "RED → GREEN Evidence" section above is that evidence.

## Next Phase Readiness

- WR-A-03, WR-A-04 and UF-02 are all closed with an observed-failing test first, per the plan's own success criteria. No regression in the SSE event format, the keepalive text, the subscriber cap value, or the boot sequence (all pre-existing SSE/boot/worker integration tests pass, run twice).
- `05-37`'s human-verification triage batch can now reference this plan's commits/tests as its evidence for these three items.
- Not run by this plan (per the orchestrator's own wave-boundary responsibility, hard_rules #13): the full `pnpm test:integration` suite and `pnpm test:e2e`. What *was* run and is green: `pnpm lint`, `pnpm typecheck`, `pnpm test` (1420/1420), `pnpm test:boot` (7/7), `pnpm security:scan-leaks` (3 Vitest canaries + the Playwright `@canary` spec), and the 9 SSE/boot/worker integration files (38 tests) run twice with no flakiness.

---
*Phase: 05-ui-web*
*Completed: 2026-09-20*
