---
phase: 04-http-routes-worker-bullmq-y-sse
plan: 03
subsystem: api
tags: [events, pub-sub, sse, d-04, testcontainers, drizzle]

requires:
  - phase: 03-servicios-de-aplicaci-n-activity-log-y-redacci-n
    provides: ServerServicesDeps, createServerServices, the five services' non-throwing { ok, code, message } result unions, ServerView/SERVER_VIEW_KEYS
provides:
  - "ServerEvent union, ServerEventPublisher port, noopServerEventPublisher and publishServerEvent (apps/control-plane/src/events/server-event-publisher.ts) — the producer half of the SSE bridge Plan 04-09's Redis adapter and stream implement against"
  - "ServerServicesDeps.events with a noop default — no service import opens a Redis connection"
  - "Six post-commit publication sites: one each in registerServer/editServer/deleteServer/trustFingerprint, two in connectAndDiscover (TX1 CONNECTING, TX2 outcome)"
  - "tests/integration/services/helpers/service-fixture.ts now records every published ServerEvent and exposes setEventPublisher() for a test-specific fake"
affects: [04-09, 04-04, 04-05, 04-06]

tech-stack:
  added: []
  patterns:
    - "Post-commit publish: capture db.transaction(...)'s resolved result in a const, publish only after it resolves, then return it — never inside the transaction callback"
    - "publishServerEvent(deps.events, event) wraps every publish call so a rejecting or throwing publisher can never fail or roll back the calling service"
    - "Recording ServerEventPublisher fixture (events: ServerEvent[] + setEventPublisher swap) mirrors the existing setSshPort() swap pattern in service-fixture.ts"

key-files:
  created:
    - apps/control-plane/src/events/server-event-publisher.ts
    - apps/control-plane/src/events/server-event-publisher.test.ts
    - tests/integration/services/event-publishing.test.ts
  modified:
    - apps/control-plane/src/services/server-service-deps.ts
    - apps/control-plane/src/services/server-service-deps.test.ts
    - apps/control-plane/src/services/register-server.ts
    - apps/control-plane/src/services/edit-server.ts
    - apps/control-plane/src/services/delete-server.ts
    - apps/control-plane/src/services/trust-fingerprint.ts
    - apps/control-plane/src/services/connect-and-discover.ts
    - tests/integration/services/helpers/service-fixture.ts

key-decisions:
  - "connectAndDiscover has 2 publish call sites in the file (1 after TX1, 1 shared after TX2), not 3 as the plan's own acceptance criteria literally counted — the two TX2 success branches are unified into one `const result = await deps.db.transaction(...)` before publishing once, since publishing separately inside each of the two TX2 return arms would require calling publish from inside the transaction callback, which the plan itself forbids. Runtime behavior (exactly 2 events per full run, exactly 0 for ALREADY_CONNECTING/NOT_FOUND) matches the plan's must_haves exactly; only the static grep-count proxy differs."
  - "const result: XxxResult = await deps.db.transaction(...) needed an explicit type annotation in register/edit/delete/trust-fingerprint to stop TypeScript from widening the discriminated union's `ok` field to `boolean` once the transaction call was extracted out of a bare `return` statement (which previously supplied contextual typing from the function's own return-type annotation)"
  - "connectAndDiscover's shared post-TX2 result deliberately has no explicit type annotation (unlike the other four services) — annotating it as ConnectAndDiscoverResult made `@typescript-eslint/no-unnecessary-condition` fail on an `if (result.ok)` guard, since both TX2 branches always return `ok: true as const`; the inferred narrower type let the guard be dropped entirely and the publish call became unconditional"
  - "The 'no event before commit' truth is proven with a genuine unique-violation race (two concurrent registerServer calls for the same name) rather than a synthetic forced-throw: the loser's transaction actually rolls back via a real Postgres 23505, and the test asserts exactly one event was recorded across both calls"
  - "ALREADY_CONNECTING's zero-events test uses a direct row patch to CONNECTING (mirroring trust-fingerprint.test.ts's own SERVER_BUSY arrangement) instead of a two-concurrent-connect race — the race is non-deterministic in which caller wins TX1's lock, so a raw SQL patch is the only way to assert a single, guaranteed ALREADY_CONNECTING outcome deterministically"

patterns-established:
  - "Every state-changing Phase 3 service now follows: `const result: XResult = await deps.db.transaction(...)` then `if (result.ok) { await publishServerEvent(deps.events, {...}) }` then `return result` — this is the shape Plan 04-09's Redis-backed ServerEventPublisher and any future service slot into with zero further changes to registerServer/editServer/deleteServer/trustFingerprint/connectAndDiscover"

requirements-completed: []

duration: ~50min
completed: 2026-09-17
---

# Phase 4 Plan 3: ServerEventPublisher port and six post-commit publication sites Summary

**Every Phase 3 service now announces its own committed state change via `deps.events` — a noop-by-default `ServerEventPublisher` port that `connectAndDiscover` calls twice (CONNECTING right after TX1, the outcome after TX2) and the other four services call once each, all strictly after their transaction resolves.**

## Performance

- **Duration:** ~50 min
- **Started:** 2026-09-17T07:15:00-06:00 (approx.)
- **Completed:** 2026-09-17T08:07:15-06:00
- **Tasks:** 3
- **Files modified:** 10 (3 created, 7 modified)

## Accomplishments
- `apps/control-plane/src/events/server-event-publisher.ts`: the `ServerEvent` discriminated union (`server.updated` carrying the full `ServerView`, `server.deleted` carrying only `{ id }`), the `ServerEventPublisher` port with a documented never-reject contract, `noopServerEventPublisher` (the default everywhere no Redis exists) and `publishServerEvent` — a try/catch wrapper that swallows any rejection or synchronous throw so a broken publisher can never turn a committed database change into a failed service call.
- `ServerServicesDeps` gained `events: ServerEventPublisher`, defaulting to `noopServerEventPublisher` in `resolveServerServicesDeps` — no service import opens a Redis connection just by existing.
- `registerServer`, `editServer`, `deleteServer` and `trustFingerprint` each publish exactly one event immediately after their own `db.transaction(...)` resolves and before returning, never inside the transaction callback; every `{ ok: false }` path publishes nothing.
- `connectAndDiscover` publishes `server.updated` with `status: 'CONNECTING'` right after TX1 commits (using TX1's own `.returning()` row, no extra read) and again after TX2 commits with the final outcome — proven by a test whose fake `SshPort.connect` reads the fixture's recorded-events array at call time and finds exactly one entry, confirming the CONNECTING announcement is visible before the (potentially multi-second) SSH phase starts.
- `tests/integration/services/helpers/service-fixture.ts` now records every published `ServerEvent` in call order (`fixture.events`) and exposes `setEventPublisher()` to swap in a rejecting fake for the D-04 resilience test, without changing its existing `setSshPort`/dynamic-import discipline.
- 16 new integration tests in `tests/integration/services/event-publishing.test.ts` cover all six publication sites, the null-payload shape of `server.deleted`, the 27-key `SERVER_VIEW_KEYS` allowlist on both `connectAndDiscover` events, a genuine unique-violation race proving a rolled-back transaction never publishes, and a rejecting injected publisher that still lets `registerServer` commit and return `ok: true`.

## Task Commits

Each task was committed atomically:

1. **Task 1: ServerEventPublisher port, noop default and deps.events** - `65abe81` (feat)
2. **Task 2: Post-commit publication in register, edit, delete and trustFingerprint** - `154c7f9` (feat)
3. **Task 3: connectAndDiscover publishes CONNECTING and the final result** - `7e4cf05` (feat)

_Note: RED was verified in-session for Task 1's two test files (confirmed failing on the missing module) before implementing. Tasks 2 and 3 authored their RED integration tests and GREEN implementation together within the session before the first successful Testcontainers run (each landed as one commit per the noodara-tdd skill's "one commit per full cycle is acceptable" allowance) — RED was not separately re-verified as a distinct failing run for the combined event-publishing.test.ts file before implementing, since both are new files with no pre-existing pass path._

## Files Created/Modified
- `apps/control-plane/src/events/server-event-publisher.ts` - `ServerEvent`, `ServerEventPublisher`, `noopServerEventPublisher`, `publishServerEvent`
- `apps/control-plane/src/events/server-event-publisher.test.ts` - unit tests for the noop default and the never-throw publish helper
- `apps/control-plane/src/services/server-service-deps.ts` - `events: ServerEventPublisher` field, noop default in `resolveServerServicesDeps`
- `apps/control-plane/src/services/server-service-deps.test.ts` - default/override tests for `deps.events`
- `apps/control-plane/src/services/register-server.ts` / `edit-server.ts` / `delete-server.ts` / `trust-fingerprint.ts` - one post-commit `publishServerEvent` call each
- `apps/control-plane/src/services/connect-and-discover.ts` - two post-commit `publishServerEvent` calls (TX1 CONNECTING, TX2 outcome)
- `tests/integration/services/helpers/service-fixture.ts` - recording `events` array, `setEventPublisher()`
- `tests/integration/services/event-publishing.test.ts` - the 16-test publication proof for all five services

## Decisions Made
- `const result: XxxResult = await deps.db.transaction(...)` needed an explicit type annotation in the four simpler services to stop TypeScript's discriminated-union `ok` field from widening to `boolean` once the transaction call was pulled out of a bare `return` statement.
- `connectAndDiscover`'s shared post-TX2 result deliberately carries no type annotation — annotating it tripped `@typescript-eslint/no-unnecessary-condition` on an `if (result.ok)` guard (both TX2 branches always resolve `ok: true as const`), so the inferred narrower type let the guard be dropped and the publish call became unconditional.
- The "no event before commit" truth (T-4-17) is proven with a genuine Postgres unique-violation race between two concurrent `registerServer` calls for the same name, not a synthetic forced-throw — the loser's transaction actually rolls back and the test asserts exactly one event was recorded.
- `connectAndDiscover`'s `ALREADY_CONNECTING` zero-events test uses a deterministic direct row patch to `CONNECTING` (mirroring `trust-fingerprint.test.ts`'s own `SERVER_BUSY` arrangement) rather than a race, since which of two concurrent connect calls wins TX1's lock is non-deterministic.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] Explicit result type annotations to stop discriminated-union widening**
- **Found during:** Task 2 (register/edit/delete/trust-fingerprint)
- **Issue:** Extracting `deps.db.transaction(...)` into a `const result = await ...` (needed to publish only after it resolves) made TypeScript infer `ok: boolean` instead of the discriminated literal `true`/`false`, since the function's own `Promise<XxxResult>` return-type annotation no longer contextually typed the transaction callback. This broke every `return result` at the end of each service.
- **Fix:** Added an explicit `const result: RegisterServerResult = ...` / `EditServerResult` / `DeleteServerResult` / `TrustFingerprintResult` annotation to each of the four call sites, restoring the contextual typing the callback needs.
- **Files modified:** `register-server.ts`, `edit-server.ts`, `delete-server.ts`, `trust-fingerprint.ts`
- **Verification:** `pnpm typecheck` exits 0.
- **Committed in:** `154c7f9` (Task 2 commit)

**2. [Rule 1 - Bug] Removed an always-true `if (result.ok)` guard in connectAndDiscover flagged by lint**
- **Found during:** Task 3 (connectAndDiscover)
- **Issue:** After annotating `result` as `ConnectAndDiscoverResult` and guarding the publish call with `if (result.ok)`, `@typescript-eslint/no-unnecessary-condition` failed the build: both TX2 return branches always resolve `{ ok: true as const, ... }`, so the check is genuinely always true given the file's own control flow.
- **Fix:** Removed the type annotation (letting TypeScript infer the narrower always-`ok: true` shape from the callback's actual return statements) and removed the now-redundant `if` guard, publishing unconditionally.
- **Files modified:** `connect-and-discover.ts`
- **Verification:** `pnpm lint` and `pnpm typecheck` both exit 0; all 43 tests across `event-publishing.test.ts` + `connect-and-discover.test.ts` still pass.
- **Committed in:** `7e4cf05` (Task 3 commit)

---

**Total deviations:** 2 auto-fixed (both Rule 1 bugs surfaced by the type checker/linter, not the plan's own design)
**Impact on plan:** No scope creep — both fixes were mechanical TypeScript/lint corrections required to make the plan's own instructed shape (`const result = await deps.db.transaction(...)`, publish, `return result`) compile and pass the project's strict lint config.

## Issues Encountered
- `connectAndDiscover` ends up with 2 publish call sites in the file rather than the plan's acceptance-criteria literal count of 3 (one after TX1, one per TX2 branch) — see the "connectAndDiscover has 2 publish call sites" key decision above. Runtime behavior (event counts, ordering, payload shape) matches every stated `must_haves.truths` and behavior exactly; only the static `grep -c` proxy for "one per TX2 branch" doesn't apply because the two TX2 branches share one post-transaction publish call by construction (publishing separately inside each branch would violate the "never inside the transaction callback" rule).

## User Setup Required

None - no external service configuration required.

## Next Phase Readiness
- `ServerEventPublisher`/`ServerEvent`/`publishServerEvent`/`noopServerEventPublisher` and `deps.events` are ready for Plan 04-09 to implement the real Redis-backed adapter and wire it into `resolveServerServicesDeps`'s overrides at the API/worker composition roots — no further changes to any of the five Phase 3 services are needed.
- `tests/integration/services/helpers/service-fixture.ts`'s `events`/`setEventPublisher` are ready for any later plan's service-level tests that need to assert on publication.
- Per STATE.md's existing note (from 04-01/04-02), SERV-06/DISC-05 are not marked complete from this plan alone — they land across the full 04-02..04-11 span and are re-verified at phase close.
- No blockers for the next plan in the wave.

---
*Phase: 04-http-routes-worker-bullmq-y-sse*
*Completed: 2026-09-17*

## Self-Check: PASSED

All created/modified files verified present on disk; all three task commit hashes (`65abe81`, `154c7f9`, `7e4cf05`) verified present in `git log`.
