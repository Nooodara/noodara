---
phase: 08-redise-o-de-la-app
plan: 16
subsystem: ui
tags: [css, starting-style, tailwind-v4, motion, servers-list, activity-list]

# Dependency graph
requires:
  - phase: 08-redise-o-de-la-app
    provides: "08-15's data-entering=\"true\"/@starting-style entrance mechanism (globals.css), 08-18's identical index-capped 40ms-per-check stagger technique on DiscoveryStep.tsx, and 08-05's ServerList InsetGroup wrapper"
provides:
  - "ServerRow: a per-row translateY(4px)+opacity entrance staggered 40ms per index (capped at 8 rows/320ms), gated to the single render that first has data, never replayed on a later re-render"
  - "ActivityRow: a per-arrival translateY(4px)+opacity entrance confined to rows genuinely new since the previous render, excluding both the initial load and any \"Load older\" append, with no stagger"
  - "computeEnteringIds (ActivityList.tsx): diffs a refresh's prepended new ids from an append's trailing new ids by locating the previous render's own first-known id inside the new array"
affects: [08-19, 08-20, 08-human-uat, future-plans-touching-ServerList-ServerRow-ActivityList-ActivityRow]

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "First-load-only entrance gating: a useRef<boolean> flipped inside a deps-less useEffect (never during render) so the render that first has data reads the pre-flip value and every later render reads the post-flip one -- ServerList's own take on the same 'flip after commit, never during render' idiom DiscoverySection.tsx already established with its own previousStatusRef/previousReceivedCountRef"
    - "Position-based arrival diffing: 'refresh' prepends genuinely-new ids before existing content, 'Load older' appends them after -- computeEnteringIds locates the previous render's own first-known id inside the new array and only treats ids strictly before it as arrivals, which correctly excludes an append without needing the caller to pass an explicit 'this batch is an arrival' flag"
    - "The single source of truth for a stagger's 40ms-per-index math lives in the list component (ServerList), never duplicated on the purely presentational row (ServerRow only renders an already-computed delayMs) -- mirrors DiscoveryStep.tsx/08-18's own step-vs-row split"

key-files:
  created: []
  modified:
    - apps/web/src/components/ServerList.tsx
    - apps/web/src/components/ServerList.test.tsx
    - apps/web/src/components/ServerRow.tsx
    - apps/web/src/components/ActivityList.tsx
    - apps/web/src/components/ActivityList.test.tsx
    - apps/web/src/components/ActivityRow.tsx
    - tests/e2e/servers-list.spec.ts
    - tests/e2e/activity.spec.ts

key-decisions:
  - "The 40ms-per-index stagger math (ROW_STAGGER_STEP_MS/ROW_STAGGER_MAX_ROWS/rowStaggerDelayMs) lives in ServerList.tsx, not ServerRow.tsx, so the plan's own acceptance grep (`grep -c \"40\" ServerList.tsx`) targets the file that actually owns the constant -- ServerRow receives the already-computed, already-capped delayMs as a prop and stays purely presentational, a minor refinement on the plan's literal 'index passed via the index pattern' key_link (index is still passed conceptually, just pre-multiplied by the list before crossing the component boundary)"
  - "Discovered mid-Task-3 that ServersPage's own registerResync fires a second, superseding GET /api/servers the instant the shared SSE stream's `open` event fires (use-server-events.ts) -- correctly clearing `entering` per this plan's own 'never on a later re-render' contract, but too fast for Playwright to ever observe the first-load stagger in a settled DOM. The @stagger E2E tests intercept `**/api/events` and never fulfill it, keeping the stream in CONNECTING so no resync fires -- this changes nothing in the production entrance code, only removes an unrelated race from the test's own observation window"
  - "computeEnteringIds diffs by locating the previous render's own first-known item id inside the new items array rather than a naive 'not-previously-seen id' set-difference: a naive diff cannot distinguish a 'refresh' prepend (an arrival) from a 'Load older' append (a page load) since both add ids the previous render never had -- locating the boundary correctly excludes an append, which never moves that first-known id, while a prepend does"
  - "The very first ready render of ActivityList marks nothing entering (previousItemsRef starts null) -- the initial population is a load, not an arrival, matching the servers list's own precedent of a first render carrying no 'arrived from nothing' semantics on the activity screen specifically (D-11 assigns the servers list its own first-load stagger; the activity screen's one authored moment is the arrival itself, not its own initial population)"

patterns-established:
  - "computeEnteringIds' boundary-index diffing is the general technique for any future list that both prepends live arrivals and appends historical pages onto the same array without an explicit per-batch origin tag"

requirements-completed: [UI-07, UI-08]

# Metrics
duration: 45min
completed: 2026-09-26
---

# Phase 8 Plan 16: List Entrances Summary

**A 40ms-per-index first-load stagger on the servers list (capped at 8 rows) and a per-arrival translateY+opacity entry on the activity list that diffs a refresh's prepended rows from a "Load older" append's trailing rows, so the merge-not-reset scroll/content contract stays intact.**

## Performance

- **Duration:** ~45 min
- **Started:** 2026-09-26T07:05:00Z
- **Completed:** 2026-09-26T07:35:00Z
- **Tasks:** 3
- **Files modified:** 8 (0 created, 8 modified)

## Accomplishments

- `ServerList.tsx` now gates a `hasEnteredRef`-backed `isFirstLoad` flag (flipped inside a deps-less `useEffect`, never during render) and computes each row's `rowStaggerDelayMs(index)` -- 40ms per row, capped at 8 rows' worth (320ms) -- so a list of 40 servers never leaves its last row waiting nearly a third of a second longer than an 8-row list would.
- `ServerRow.tsx` renders that already-computed `delayMs` as an inline `transitionDelay` alongside the shared `data-entering="true"` + `motion-safe:starting:translate-y-1 motion-safe:starting:opacity-0` technique 08-18's `DiscoveryStep.tsx` already established -- never `pointer-events-none`, so every row stays clickable through the stagger.
- `ActivityList.tsx` gained `computeEnteringIds`, which locates the previous render's own first-known item id inside the new array and marks only the ids strictly before it as arrivals -- correctly distinguishing a page-1 refresh's prepend (an arrival) from a "Load older" append (a page load, never animated) without the caller needing to pass an explicit per-batch flag.
- `ActivityRow.tsx` renders the identical entrance technique with no stagger (per D-11/§8.4, the activity screen's own moment is the arrival itself, deliberately different from the servers list's stagger).
- Three new `@stagger`-tagged and two new `@activity-entry`-tagged E2E tests (`tests/e2e/servers-list.spec.ts`/`tests/e2e/activity.spec.ts`) prove the rendered `transitionDelay`/`transitionDuration` values, the cap, the reduced-motion fallback, a real SSE-driven arrival marking only the new row, and an unchanged `window.scrollY` across that arrival.

## Task Commits

Each task was committed with a RED test commit followed by a GREEN implementation commit; Task 3 (browser-level proof of already-implemented behavior) is a single test commit, matching 08-18's own precedent for its equivalent task:

1. **Task 1: 40ms staggered first load on the servers list** - `e8b21ae` (test) -> `c5b6e0a` (feat)
2. **Task 2: Arrival entry on the activity list without breaking the merge contract** - `e7f3ae9` (test) -> `8e7af43` (feat)
3. **Task 3: Browser-level proof of both entrances** - `eb0d864` (test)

**Plan metadata:** commit created below (docs: complete plan)

## Files Created/Modified

- `apps/web/src/components/ServerList.tsx` - `ROW_STAGGER_STEP_MS`/`ROW_STAGGER_MAX_ROWS`/`ROW_STAGGER_MAX_DELAY_MS`, `rowStaggerDelayMs`, `hasEnteredRef`/`isFirstLoad` gating
- `apps/web/src/components/ServerList.test.tsx` - stagger delay/cap/no-replay-on-rerender cases
- `apps/web/src/components/ServerRow.tsx` - `delayMs`/`entering` props, `data-entering` + entrance classes on the row wrapper
- `apps/web/src/components/ActivityList.tsx` - `computeEnteringIds`, `previousItemsRef`, `enteringIds` threaded into each `ActivityRow`
- `apps/web/src/components/ActivityList.test.tsx` - initial-load/refresh-prepend/load-older/no-stagger cases
- `apps/web/src/components/ActivityRow.tsx` - `entering` prop, `data-entering` + entrance classes (no stagger)
- `tests/e2e/servers-list.spec.ts` - three `@stagger` cases (delay values, cap, reduced motion)
- `tests/e2e/activity.spec.ts` - two `@activity-entry` cases (real SSE arrival + scroll offset, reduced motion)

## Decisions Made

See `key-decisions` in frontmatter: the stagger math's ownership (`ServerList.tsx`, not `ServerRow.tsx`), the `**/api/events`-hang technique used only inside the two new E2E tests to observe the transient first-load state before the shell's own SSE-driven resync supersedes it, `computeEnteringIds`' boundary-index diffing, and the initial-load-never-animates rule for `ActivityList`.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] Task 3's first `@stagger` test raced ServersPage's own SSE resync**
- **Found during:** Task 3 (browser-level proof)
- **Issue:** `ServersPage`'s `registerResync(fetchServers)` fires a second, superseding `GET /api/servers` the instant the shared SSE stream's `open` event fires. That second fetch's own `ready` commit correctly clears `entering` (a resync is explicitly excluded from the stagger by this same plan's own "never on a later re-render" rule) -- but it fires within milliseconds of the first, so a naive E2E test asserting on the settled DOM only ever observed the post-resync, non-entering state, never the intended first-load stagger.
- **Fix:** The two `@stagger` E2E tests intercept `**/api/events` and never call `route.fulfill`, leaving the shared `EventSource` in `CONNECTING` for the test's duration -- `open` never fires, `registerResync`'s callback never runs, and the first fetch's own `ready` render is the only one. No production code changed; the fix is confined to the test's own network stubbing.
- **Files modified:** `tests/e2e/servers-list.spec.ts`
- **Verification:** All three `@stagger` tests pass; the full 140-test E2E suite (up from 135) passes unchanged.
- **Committed in:** `eb0d864` (Task 3 commit)

---

**Total deviations:** 1 auto-fixed (1 bug, confined to test infrastructure)
**Impact on plan:** No production code was affected; the fix only changes how the E2E test observes an already-correct production behavior. No scope creep.

## Issues Encountered

None beyond the deviation documented above.

## User Setup Required

None - no external service configuration required.

## Requirements Assessment

**UI-07** (`El toolbar usa scroll edge effect ... los checks de discovery y las filas de la lista entran con stagger de 40 ms sin bloquear la interacción.`) -- marked complete. Verified every clause against the current tree, not only this plan's own scope:
- Toolbar scroll-edge effect: `apps/web/src/components/Toolbar.tsx` (08-10), covered by `@scroll-edge` in `tests/e2e/servers-list.spec.ts`.
- `RowMenu`/`Tooltip` scale from the trigger's own origin: `packages/ui/src/RowMenu.tsx`/`Tooltip.tsx`'s `--transform-origin`/Radix Popper origin (08-14).
- `Dialog` scales from center (08-14, unchanged from the brief's stated exception).
- `Disclosure` animates with `grid-template-rows: 0fr -> 1fr`, never `height` (08-14).
- Discovery checks stagger 40ms per index, capped (08-18's `DiscoveryStep.tsx`).
- List rows (servers list) stagger 40ms per index, capped, never blocking interaction (this plan).
All five clauses hold. Marked complete via `requirements mark-complete UI-07`.

**UI-08** (`Los momentos de firma del producto ... están tratados como momentos autorados (uno por pantalla), distinguibles de cualquier otro producto`) -- already carried `requirements-completed: [UI-08, ...]` in 08-18-SUMMARY.md (the discovery narration + Viewfinder ring and the TOFU fingerprint block are the two "signature moments" this requirement names). This plan adds the servers-list stagger and activity-list arrival as each screen's own distinct moment (D-11/§8.3), reinforcing rather than newly satisfying UI-08 -- re-marked complete here idempotently since this plan's own frontmatter lists it as a target requirement.

### Rules not satisfied

None identified for UI-07 or UI-08 within this plan's scope.

## Next Phase Readiness

- Every list screen this phase touches (`servers`, `activity`) now has its own D-11-mandated authored moment, distinct from the other (§8.4).
- `computeEnteringIds`' boundary-index diffing technique is available for any future list combining live prepends with historical-page appends.
- No blockers for 08-19/08-20.

---
*Phase: 08-redise-o-de-la-app*
*Completed: 2026-09-26*

## Self-Check: PASSED

All 8 claimed files and all 5 claimed commit hashes verified present in the working tree/git log.
