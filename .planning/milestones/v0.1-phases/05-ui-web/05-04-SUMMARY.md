---
phase: 05-ui-web
plan: 04
subsystem: api
tags: [sse, discovery, event-publisher, ssh, redis]

# Dependency graph
requires:
  - phase: 05-ui-web
    provides: bounded session lookups and pino err serializer (05-01, 05-02) this plan's SSE/logging call sites already build on
provides:
  - "runDiscovery's onCheck callback: fires once per DiscoveryCheck, in DISCOVERY_SEQUENCE order, including skipped/not_applicable entries, best-effort (never throws out of runDiscovery)"
  - "server.discovery_progress as a third ServerEvent union member, carrying { serverId, check: DiscoveryCheck }"
  - "sse-broadcaster's KNOWN_EVENT_TYPES allowlist extended with the literal string server.discovery_progress"
  - "connectAndDiscover wired to publish one server.discovery_progress event per check, before the final server.updated"
affects: [05-05, 05-18]

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "Best-effort synchronous listener callback (onCheck) wrapped in try/catch at every emission site, mirroring publishServerEvent's own swallow-everything contract"
    - "SSE event-type allowlist extended by literal string only, never wildcard/prefix/regex (T-4-36/T-5-14 discipline)"

key-files:
  created: []
  modified:
    - packages/ssh/src/run-discovery.ts
    - packages/ssh/src/run-discovery.test.ts
    - apps/control-plane/src/events/server-event-publisher.ts
    - apps/control-plane/src/events/sse-broadcaster.ts
    - apps/control-plane/src/events/sse-broadcaster.test.ts
    - apps/control-plane/src/services/connect-and-discover.ts
    - tests/integration/services/connect-and-discover.test.ts

key-decisions:
  - "onCheck invocation is inlined at each of the four checks.push sites (not extracted to a shared helper), capturing the pushed DiscoveryCheck in a local const passed to both checks.push and onCheck — avoids a non-null array-read assertion the project's lint config forbids (@typescript-eslint/no-non-null-assertion), while still keeping the field literal onCheck at 5+ locations for the plan's own acceptance-criteria grep"
  - "connect-and-discover.test.ts's fake discover functions call discoverInput.onCheck synchronously for each scripted check, mirroring the real runDiscovery contract, since the suite's injection seam (03-CONTEXT.md D-01) bypasses runDiscovery entirely"

requirements-completed: [DISC-02]

# Metrics
duration: 9min
completed: 2026-09-19
---

# Phase 05 Plan 04: Discovery progress SSE wiring Summary

**Check-by-check discovery progress is now a real server-side signal: runDiscovery reports each check via an optional onCheck callback, and connectAndDiscover publishes it as a new, explicitly allowlisted server.discovery_progress SSE event.**

## Performance

- **Duration:** ~9 min (commit span; excludes file-reading/context-gathering time)
- **Started:** 2026-09-19T01:44:14-06:00
- **Completed:** 2026-09-19T01:52:32-06:00
- **Tasks:** 3
- **Files modified:** 7

## Accomplishments
- `runDiscovery` gained an additive `onCheck?: (check: DiscoveryCheck) => void` field that fires once per recorded check (pass/fail/skipped/not_applicable), in `DISCOVERY_SEQUENCE` order, wrapped in a swallowing try/catch so a throwing listener can never change the returned `DiscoverySnapshot` or abort the run
- `ServerEvent` gained a third union member, `server.discovery_progress`, carrying only `{ serverId, check: DiscoveryCheck }` — the same already-redacted `detail` `runDiscovery` produces, never raw command output, facts, or a `ServerView`
- `sse-broadcaster.ts`'s `KNOWN_EVENT_TYPES` allowlist grew by exactly one literal string; a near-miss-type test proves no prefix/wildcard match was introduced (T-4-36/T-5-14)
- `connectAndDiscover` wires `runDiscovery`'s `onCheck` to `publishServerEvent`, fire-and-forget (`void`, never awaited) so Redis latency cannot serialize SSH work; publishes strictly before the post-commit final `server.updated`, and never inside either of TX1/TX2

## Task Commits

Each task was committed atomically (TDD RED → GREEN, plus one lint-driven refactor):

1. **Task 1: onCheck callback in runDiscovery**
   - `634a32a` test(05-04): add failing tests for runDiscovery onCheck callback
   - `aa7c2c6` feat(05-04): add onCheck callback to runDiscovery
   - `f786f7b` refactor(05-04): avoid non-null assertions in runDiscovery onCheck sites
2. **Task 2: New event type on the publisher union and the broadcaster allowlist**
   - `52c34dd` test(05-04): add failing test for discovery_progress SSE forwarding
   - `48497f6` feat(05-04): add server.discovery_progress event type and allowlist entry
3. **Task 3: Publish progress from connectAndDiscover**
   - `316a7f6` test(05-04): add failing tests for connectAndDiscover progress publication
   - `0b09667` feat(05-04): wire runDiscovery onCheck to server.discovery_progress SSE

**Plan metadata:** (this commit, docs: complete plan)

## Files Created/Modified
- `packages/ssh/src/run-discovery.ts` - Added `onCheck?` field to `RunDiscoveryInput`; invoked at all four `checks.push` sites, each wrapped in a swallowing try/catch
- `packages/ssh/src/run-discovery.test.ts` - Five new behaviors: order/deep-equality, skipped-entry visibility, abort+skip visibility, throwing-listener isolation, omitted-callback no-op
- `apps/control-plane/src/events/server-event-publisher.ts` - Third `ServerEvent` union member `server.discovery_progress`; header comment updated to name and scope it
- `apps/control-plane/src/events/sse-broadcaster.ts` - `KNOWN_EVENT_TYPES` extended with the literal `'server.discovery_progress'`
- `apps/control-plane/src/events/sse-broadcaster.test.ts` - Forwarding test for the new type plus a near-miss-type drop test
- `apps/control-plane/src/services/connect-and-discover.ts` - `discover({...})` call site gained an `onCheck` argument publishing `server.discovery_progress` via `void publishServerEvent(...)`
- `tests/integration/services/connect-and-discover.test.ts` - Five new behaviors: per-check publication with exact payload, ordering before the final `server.updated`, zero progress events on connect-phase failure, resilience to an always-rejecting publisher, (existing suite otherwise unchanged)

## Decisions Made
- Inlined the `onCheck` invocation at each `checks.push` site using a local `const check: DiscoveryCheck = {...}` passed to both `checks.push` and `input.onCheck?.()`, instead of reading the just-pushed element back off the array with a non-null assertion — the project's ESLint config forbids `@typescript-eslint/no-non-null-assertion`, and this shape avoids it while keeping the same four-call-site structure the plan's pattern doc specifies
- `connect-and-discover.test.ts`'s new tests script `discover` as a function that synchronously calls `discoverInput.onCheck` for each fixture check, exactly mirroring `runDiscovery`'s real contract, since this suite's own injection seam (03-CONTEXT.md D-01) never calls the real `runDiscovery`

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] Non-null assertions in runDiscovery's four onCheck call sites failed `pnpm lint`**
- **Found during:** Task 1 verification (ran `pnpm lint` as part of this plan's overall `<verification>` block after Task 3 landed)
- **Issue:** The initial implementation read the just-pushed check back off the `checks` array (`checks[checks.length - 1]!`) to pass to `onCheck`, which trips `@typescript-eslint/no-non-null-assertion` (a hard-forbidden pattern in this repo's ESLint config)
- **Fix:** Captured the check object in a local `const check: DiscoveryCheck = {...}` at each of the four sites, passed to both `checks.push(check)` and `input.onCheck?.(check)` — no array read-back, no assertion needed
- **Files modified:** `packages/ssh/src/run-discovery.ts`
- **Verification:** `pnpm lint` exits 0 across all four packages; `pnpm test packages/ssh/src/run-discovery.test.ts` still 28/28 green; `pnpm typecheck` exits 0
- **Committed in:** `f786f7b` (separate refactor commit, since Task 1's feat commit `aa7c2c6` was already made before the plan-wide lint check ran)

---

**Total deviations:** 1 auto-fixed (1 bug — lint violation, no behavior change)
**Impact on plan:** Purely mechanical; no scope creep, no change to the acceptance-criteria grep counts (`onCheck` still appears 5+ times, still zero `await onCheck` occurrences).

## Issues Encountered
None beyond the lint deviation above.

## User Setup Required
None - no external service configuration required.

## Next Phase Readiness
- The server-side signal DISC-02 needed now exists: `GET /api/events` will forward `server.discovery_progress` frames the moment a UI subscriber connects — no route or UI work was in this plan's scope
- Plan 05-05 (per its own dependency, `apps/web/src/lib/use-server-events.ts` and the discovery UI) can now build directly against `server.discovery_progress`'s `{ serverId, check: DiscoveryCheck }` shape and the `sse-broadcaster.ts` frame format (`event: server.discovery_progress\ndata: <json>\n\n`)
- Full verification suite green: `pnpm test` (887/887 unit), `pnpm test:integration tests/integration/services/connect-and-discover.test.ts` (31/31), `pnpm test apps/control-plane/src/events` (23/23), `pnpm typecheck`, `pnpm lint`, `pnpm boundaries`, `pnpm security:scan-leaks` (3/3)
- No blockers for 05-05/05-18

---
*Phase: 05-ui-web*
*Completed: 2026-09-19*

## Self-Check: PASSED

All modified/created files confirmed present on disk; all 7 task commit hashes confirmed present in git history.
