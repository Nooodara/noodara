---
phase: 05-ui-web
plan: 29
subsystem: ui
tags: [nextjs, react, sse, playwright, vitest, discovery, detail-page, race-condition]

# Dependency graph
requires:
  - phase: 05-ui-web
    provides: "05-26 (backend CONNECTING-wedge recovery, the other half of gap 2), 05-28 (safeLocalStorage + the dod-hardening.spec.ts localStorage fixme handover), (shell)/servers/page.tsx's reconcileSnapshot precedent"
provides:
  - "apps/web/src/lib/discovery-progress.ts: lastReceivedIndex + per-step hasUnresolvedEarlierCheck replace firstUnresolvedIndex, so a page that joins mid-run never renders an unreceived earlier check as running/pass, and never lets a step resolve on partial evidence"
  - "apps/web/src/lib/detail-sync.ts: reconcileDetailSnapshot(held, incoming, source, isDeleted, requestSequence, latestRequestSequence) -- the pure snapshot-vs-event reconciliation decision"
  - "apps/web/src/app/(shell)/servers/[id]/page.tsx: applyServer(next, source, requestSequence) as the one write path onto state:{kind:'ready'}, guarded by latestRequestRef/deletedRef/heldServerRef; liveChecks now clears on every transition into or out of CONNECTING from either a snapshot or an event; both localStorage call sites use safeLocalStorage()"
  - "tests/e2e/server-detail.spec.ts: real-backend, timing-controlled E2E proof for the late-GET-after-event and deleted-then-late-GET races"
  - "tests/e2e/discovery.spec.ts: E2E proof for mid-run-mount exclusion and run-to-run liveChecks clearing"
  - "tests/e2e/dod-hardening.spec.ts: the 05-28 localStorage handover closed and un-fixme'd"
affects: [05-37 (cross-suite gate, re-verifies these truths), any future plan touching servers/[id]/page.tsx, discovery-progress.ts or detail-sync.ts]

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "reconcileDetailSnapshot mirrors (shell)/servers/page.tsx's reconcileSnapshot precedent but as a single-entity accept/reject decision (held/incoming/source/isDeleted/requestSequence/latestRequestSequence) rather than a list fold -- pure, no refs, no setState, no clock"
    - "applyServer is the one setState({kind:'ready'}) call site; every writer (fetchServer success, the resync path it shares, server.updated) routes through it, and a shared enteringConnecting/leavingConnecting check inside it (not duplicated per source) clears liveChecks"
    - "lastReceivedIndex (max DISCOVERY_CHECK_IDS index among ids actually received) + a per-step hasUnresolvedEarlierCheck boolean, fed into aggregateLiveStepState as a second parameter, replaces firstUnresolvedIndex -- no new public CheckState was added, the exclusion is purely an aggregation-input concern"
    - "E2E races against a stubbed-timing-but-real GET use route.fetch() to read the real response now and hold it behind a promise gate before route.fulfill -- same technique as tests/e2e/servers-list.spec.ts's own 'midflight' test (.planning/debug/sse-lost-event-race.md); the mutation that races it is always a real page.request call, never page.route-stubbed"
    - "E2E proof for the discovery reducer uses a subclassed EventSource (extends the @ssh-live test's own InstrumentedEventSource idea) that additionally dispatches byte-shaped synthetic server.discovery_progress/server.updated frames on the app's real listening instance -- documented as a stub, not the real backend, since pinning exact real-sshd timing deterministically is impractical (this file's own pre-existing rationale for every other @discovery test's GET/discovery-read stub)"

key-files:
  created:
    - apps/web/src/lib/detail-sync.ts
    - apps/web/src/lib/detail-sync.test.ts
  modified:
    - apps/web/src/lib/discovery-progress.ts
    - apps/web/src/lib/discovery-progress.test.ts
    - "apps/web/src/app/(shell)/servers/[id]/page.tsx"
    - tests/e2e/server-detail.spec.ts
    - tests/e2e/discovery.spec.ts
    - tests/e2e/dod-hardening.spec.ts

key-decisions:
  - "reconcileDetailSnapshot rejects on isDeleted regardless of source (event or snapshot), stricter than the plan's literal bullets (which only named a GET resurrecting a deleted server) -- defense in depth against any path resurrecting a server this mount already learned is gone; unit-tested explicitly (both an event and a snapshot are rejected once isDeleted is true)"
  - "The detail page's use(params) mount genuinely issues two GETs for the same id (confirmed empirically -- a React 19 Suspense-driven re-render, not a test artifact). The E2E gate helper (gateGets) holds every GET it sees and the two gap-2 tests wait for the actual capture count before racing a mutation and before asserting the post-race state, rather than assuming exactly one GET fires"
  - "aggregateLiveStepState's exclusion of an unreceived-earlier check is a second function parameter (hasUnresolvedEarlierCheck: boolean), not an eighth CheckState -- CHECK_STATES stays the same seven words; the internal-only distinction never crosses into rendered output"

patterns-established:
  - "gateGets/waitForGetResponses (tests/e2e/server-detail.spec.ts): hold every matching real GET behind route.fetch()+a released gate, and explicitly wait for N real responses to land before asserting a post-release state, rather than trusting an auto-retrying expect() not to pass on stale-but-coincidentally-correct state"

requirements-completed: [DETL-01, DETL-02, DISC-02, UI-02]

# Metrics
duration: ~30min
completed: 2026-09-20
---

# Phase 05 Plan 29: Detail-Page Snapshot/Event Race + Discovery Progress Invention Summary

**A pure `reconcileDetailSnapshot` guard plus a single `applyServer` write path stop the detail screen from showing stale or resurrected server state under an ordinary GET/event race, and a `lastReceivedIndex`-based rewrite of `discovery-progress.ts` stops the discovery checklist from rendering a check it never received as running or passed.**

## Performance

- **Duration:** ~30 min
- **Started:** 2026-09-20T18:56:00Z (approx)
- **Completed:** 2026-09-20T19:20:00Z
- **Tasks:** 3
- **Files modified:** 8 (2 created, 6 modified)

## Real backend event inventory (hard rule 7)

Before writing any code, the control plane's actual event/progress surface was read directly (not assumed):

- `apps/control-plane/src/events/server-event-publisher.ts` and `apps/web/src/lib/server-events.ts`'s `KnownEventType` confirm exactly three SSE event types ever cross the wire: `server.updated` (full `ServerView`), `server.deleted` (`{ id }`), `server.discovery_progress` (`{ serverId, check: DiscoveryCheck }` -- one frame per check, never a batch).
- `packages/domain/src/discovery/types.ts`'s `DISCOVERY_CHECK_IDS` is the fixed, real 11-check order (`hostname, os_release, arch, cpu, memory, disk, uptime, docker_version, docker_compose_version, sudo, docker_group`) -- this plan's fix reads real progress against this real order, it does not invent a synthetic one.
- No percentage, ETA, or step-count field exists anywhere on the wire; the UI never showed one and this plan adds none. The only "progress" the backend actually emits is: one `DiscoveryCheck` per completed check, in the fixed order above, plus the two connection-derived steps (`ssh_reachable`/`authenticated`) implied by the first received check (D-05's existing, unchanged rule).
- Confirmed real (2026-09-20): a genuine `connectAndDiscover` run against a real sshd Testcontainers fixture (`tests/e2e/discovery.spec.ts`'s `@ssh-live` test, unmodified by this plan) delivers exactly eleven distinct, time-separated `server.discovery_progress` frames in `DISCOVERY_CHECK_IDS` order -- re-ran as part of this plan's own verification, still green.

## Accomplishments

- **Task 1 (discovery-progress.ts):** Replaced `firstUnresolvedIndex` (which assumed a page observed a run from its first check) with `lastReceivedIndex` (the highest `DISCOVERY_CHECK_IDS` index actually received) plus a per-step `hasUnresolvedEarlierCheck` boolean fed into `aggregateLiveStepState`. A page that mounts mid-run and only ever receives late ids now renders every unreceived earlier id `pending` (never `running`/`pass`), and a step containing both a received-passing check and an unreceived earlier one reports `pending`, never `pass`. Exactly one id -- `lastReceivedIndex + 1` -- renders `running`, and only once at least one check has been received. The connection steps' existing D-05 derivation (a received check implies both connection steps `pass`) is unchanged and now pinned by a dedicated test.
- **Task 2 (detail-sync.ts + page.tsx):** New pure `reconcileDetailSnapshot` makes the accept/reject decision `(shell)/servers/page.tsx`'s `reconcileSnapshot` already established for the list screen, adapted to a single entity. `servers/[id]/page.tsx` now has exactly one `setState({ kind: 'ready', ... })` call site (`applyServer`), guarded by `latestRequestRef` (drops a superseded GET's response, success or failure), `deletedRef` (a `server.deleted` event permanently blocks every later GET from resurrecting the row for this mount), and `heldServerRef` (the value `reconcileDetailSnapshot` reconciles against). `liveChecks` now clears on every transition into **or out of** `CONNECTING`, from **either** a snapshot or an event -- previously only the SSE branch cleared it, and only on the into-`CONNECTING` direction. Both `window.localStorage` call sites (`shouldShowFirstTrustNotice`/`dismissFirstTrustNotice`) now use `safeLocalStorage()`.
- **Task 3 (E2E):** Two new `@detail` tests in `server-detail.spec.ts` prove the gap-2 races against the real backend (route-timing-gated but never payload-stubbed GETs racing real `connect()`/`delete()` calls). Two new `@discovery` tests in `discovery.spec.ts` prove the gap-3 mid-run-mount exclusion and run-to-run clearing, using a documented-as-stubbed synthetic-SSE-frame technique (the real per-check timing of a full sshd-backed run is impractical to pin deterministically, the same rationale this file's own header already gives for every other non-`@ssh-live` `@discovery` test). `dod-hardening.spec.ts`'s `localStorage` case is un-`fixme`'d and passes.

## Task Commits

1. **Task 1: Stop inventing discovery progress** - `e46c0e1` (fix)
2. **Task 2: A pure snapshot-vs-event reconciliation, then one write path on the page** - `ce68916` (fix)
3. **Task 3: E2E reproductions for both gaps, and un-fixme the storage case** - `74673ce` (test)
4. **Task 3 follow-up: fix E2E gate determinism found during RED verification** - `d61fdf9` (fix)

## RED Evidence

**Gap 3 (discovery-progress.ts), unit level -- observed before any fix:**

```
FAIL  buildChecklist -- mid-run mount ... > renders every unreceived earlier id as pending ...
AssertionError: expected 'running' to be 'pending'
Expected: "pending"
Received: "running"

FAIL  buildChecklist -- mid-run mount ... > excludes an unreceived earlier check from its step aggregation ...
AssertionError: expected 'pass' to be 'pending'
Expected: "pending"
Received: "pass"
```
(`pnpm exec vitest run apps/web/src/lib/discovery-progress.test.ts`, before Task 1's implementation; 2 of 19 failed, 17 pre-existing passed unmodified.)

**Gap 3, E2E level -- Task 1's fix temporarily reverted to the exact pre-fix `discovery-progress.ts` (`git show <fix-commit>^:.../discovery-progress.ts`), Task 2's fix left in place:**

```
✘ @discovery a page that joins mid-run never shows an unreceived earlier check as resolved, and excludes it from its step
Error: expect(locator).toHaveAttribute(expected) failed
Locator:  getByTestId('discovery-step-os')
Expected: "pending"
Received: "running"
```

**Gap 2 (detail-sync.ts / page.tsx), E2E level -- `reconcileDetailSnapshot` temporarily reverted to unconditionally `{ accept: true }`:**

```
✘ @detail a GET resolved after a live server.updated event does not roll the screen back to the older state
Error: expect(locator).toHaveAttribute(expected) failed
Locator:  getByTestId('status-pill')
Expected: "CONNECTING"
Received: "UNREACHABLE"
  (32 polls resolved to "PENDING" before a real worker event later moved it to UNREACHABLE --
   confirming the stale GET's PENDING data did overwrite the live CONNECTING state)
```

The sibling `server.deleted` test did **not** go red under that same revert alone -- `fetchServer`'s own `if (deletedRef.current) return;` early-return (a second, independent guard directly in `page.tsx`, not routed through `detail-sync.ts`) already blocks it on its own. Reverting that specific line too (in addition to `reconcileDetailSnapshot`) produced genuine red:

```
✘ @detail a server.deleted event followed by a late-resolving GET leaves the not-found state, not a resurrected server
Error: expect(locator).toBeVisible() failed
Locator: getByText('This server no longer exists.')
Expected: visible
Error: element(s) not found
  (the server was resurrected to a PENDING-ready render instead)
```

Both reverted files were restored via `git checkout -- <path>` immediately after each RED capture (confirmed by an empty `git status --short` for each), and the full three-file + `host-key.spec.ts` E2E battery was re-run green afterward (see Verification below).

**Honesty note on the run-to-run-clearing test:** reverting the historical bug's *literal* condition (clear only on an SSE-sourced, into-`CONNECTING` transition) did **not** turn `@discovery a finished run leaves no checks behind for the next run to inherit` red, because that test's own second transition (`CONNECTED` → `CONNECTING`) is event-sourced and entering -- exactly the one case the old code already handled correctly. Removing the clearing logic entirely did produce red (`discovery-step-access` stayed `pass` from the previous run). This test is a genuine regression guard for "no leak between runs" in general, but does not specifically distinguish the historical bug's narrower "fetch-branch never cleared" / "leaving-direction never cleared" sub-cases on its own -- those are covered by the code-level fact that `applyServer`'s clearing check is now a single shared block reached from both `fetchServer`'s success path and the `server.updated` handler, for both directions, not by a second, narrower E2E assertion.

## Pre-existing `discovery-progress.test.ts` assertions

**None changed.** All 14 pre-existing test cases pass with their assertions unmodified; only 5 new cases were added (mid-run-mount exclusion, step-aggregation exclusion, exactly-one-running placement, no-running-before-any-check, and the pinned connection-steps-still-pass-mid-run-with-late-ids-only case).

## Files Created/Modified

- `apps/web/src/lib/discovery-progress.ts` -- `lastReceivedIndex` + `hasUnresolvedEarlierCheck` replace `firstUnresolvedIndex`; `aggregateLiveStepState` gains a second parameter.
- `apps/web/src/lib/discovery-progress.test.ts` -- 5 new cases (mid-run mount, step-aggregation exclusion, running placement, no-running-before-first-check, connection-steps pinning).
- `apps/web/src/lib/detail-sync.ts` (new) -- `reconcileDetailSnapshot`.
- `apps/web/src/lib/detail-sync.test.ts` (new) -- 8 cases (older/newer/first snapshot, deleted snapshot, deleted event, superseded request, event precedence x2, purity).
- `apps/web/src/app/(shell)/servers/[id]/page.tsx` -- `applyServer` choke point, `latestRequestRef`/`deletedRef`/`heldServerRef`, shared into/out-of-CONNECTING clearing, `safeLocalStorage()` at both call sites.
- `tests/e2e/server-detail.spec.ts` -- `gateGets`/`waitForGetResponses` helpers + 2 new `@detail` tests.
- `tests/e2e/discovery.spec.ts` -- `installSyntheticServerEvents`/`dispatchDiscoveryCheck`/`dispatchServerUpdated` helpers + 2 new `@discovery` tests.
- `tests/e2e/dod-hardening.spec.ts` -- localStorage case un-`fixme`'d, now creates a real server and asserts the detail screen renders.

## Decisions Made

See `key-decisions` in frontmatter.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] `discovery-progress.ts`'s `resolvedIds` became dead code after the `lastReceivedIndex` rewrite**
- **Found during:** Task 1, `pnpm turbo run lint --filter=@noodara/web`.
- **Issue:** `resolvedIds` was only ever read by the old `firstUnresolvedIndex` computation; after replacing it with `Math.max(...)`, ESLint's `no-unused-vars` flagged the now-dead `const`.
- **Fix:** Removed the dead declaration.
- **Files modified:** `apps/web/src/lib/discovery-progress.ts`
- **Verification:** `pnpm turbo run lint --filter=@noodara/web` clean; `pnpm exec vitest run apps/web/src/lib/discovery-progress.test.ts` 19/19.
- **Committed in:** `e46c0e1` (Task 1 commit)

**2. [Rule 1 - Bug] The E2E gate helper only held the first of the page's two mount GETs**
- **Found during:** Task 3's own RED verification (not by an ordinary test failure -- the two gap-2 tests passed even with `reconcileDetailSnapshot` fully bypassed, which should have been impossible; investigated with request/response logging).
- **Issue:** `servers/[id]/page.tsx`'s `use(params)` mount genuinely issues **two** GETs for the same id (a React 19 Suspense-driven re-render, confirmed empirically with `page.on('request')` logging -- not a test artifact and not something this plan's own `applyServer`/`fetchServer` code caused or should "fix", since `latestRequestRef`'s supersede guard already handles it correctly). The original `gateNextGet` helper only intercepted the first of the two, so the second (uncaptured) GET resolved with fresh, already-current data and became `latestRequestRef`'s new "latest" -- the held first GET was then correctly (but for the wrong reason, from the test's point of view) dropped as superseded, masking whether the actual staleness guard under test worked at all.
- **Fix:** `gateGets` now holds every GET it sees (not just the first) and resolves `captured` with the real count once a minimum has been reached; both tests wait for that count, race the mutation, then wait for exactly that many real responses to land before asserting the post-race state.
- **Files modified:** `tests/e2e/server-detail.spec.ts`
- **Verification:** Both gap-2 E2E tests confirmed genuinely RED against the two separately-reverted guards (see RED Evidence above), then GREEN twice in a row against the real fix, plus `host-key.spec.ts` (which also renders this same detail page) green once.
- **Committed in:** `d61fdf9`

---

**Total deviations:** 2 auto-fixed (1 lint cleanup, 1 test-determinism bug found and fixed during this plan's own mandatory RED verification -- not a defect in the shipped page/lib code, only in the test harness proving it).
**Impact on plan:** No scope creep -- both fixes are inside files already in `files_modified`. The second deviation is exactly the kind of honest self-correction hard rule 7 requires: the first version of the E2E tests would have given a false sense of coverage.

## Issues Encountered

- The detail page's `use(params)` API causes two mount-time GETs, not one -- worth knowing for any future E2E test that gates this page's GETs by count (see Deviation 2). Not a bug in the page itself; `latestRequestRef` already handles it correctly.

## User Setup Required

None -- no external service configuration required.

## Next Phase Readiness

- 05-VERIFICATION.md gap 2 (SC2, frontend half) and gap 3 (SC3/DISC-02) are closed with unit- and E2E-level proof, both RED-verified honestly.
- STATE.md's Blockers/Concerns entry "servers/[id]/page.tsx has the same stale-snapshot-overwrite hazard the servers list had" (carried since 05-20) is resolved by this plan.
- The 05-28 handover (`dod-hardening.spec.ts`'s localStorage `fixme`) is closed.
- 05-31 (trust-fingerprint UI body fix) and 05-33/05-35/05-37 are unaffected -- no file outside this plan's `files_modified` list was touched.
- `pnpm test:integration` was not run (no `apps/control-plane` file changed by this plan); the cross-suite gate remains 05-37's job per the plan's own Nyquist note.

---
*Phase: 05-ui-web*
*Completed: 2026-09-20*

## Self-Check: PASSED

All 9 created/modified files confirmed present on disk; all 4 commits (`e46c0e1`, `ce68916`, `74673ce`, `d61fdf9`) confirmed present in `git log`.
