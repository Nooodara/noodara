---
phase: 08-redise-o-de-la-app
plan: 11
subsystem: ui
tags: [tailwind, playwright, vitest, ui-review, gate, accessibility]

# Dependency graph
requires:
  - phase: 08-09
    provides: "the inspector slot, sidebar fusion, NavTree"
  - phase: 08-10
    provides: "Toolbar's scroll-edge effect and accessibility fallbacks"
provides:
  - "G2 gate recorded in docs/ui/APPROVAL.md — direction approved, one adjustment round, delegated by the user"
  - "12 approved 1280px captures refreshed in docs/ui/approved/ from the post-round-1 review round"
  - "Three display defects fixed: Toolbar theme-flicker band, ServerDetailToolbar min-w-0, ServerFacts stat-tile stacking below 480px"
  - "P1/P2 motion work (wave 9+) unblocked"
affects: ["08-13", "08-14", "08-15", "08-16", "08-17", "08-18", "08-19"]

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "transition-[border-color] (single-property arbitrary form) instead of transition-colors when only one color channel should animate, matching Input.tsx/Textarea.tsx's own precedent"
    - "min-w-0 on a truncating flex item as an explicit, documented convention even where overflow:hidden already yields the same automatic-minimum-size result per the CSS Flexbox spec"
    - "min-[480px]:grid-cols-2 as an intermediate stacking breakpoint between a fixed two-column grid and the sm: four-column layout"

key-files:
  created:
    - apps/web/src/components/ServerDetailToolbar.test.tsx
  modified:
    - apps/web/src/components/Toolbar.tsx
    - apps/web/src/components/Toolbar.test.tsx
    - apps/web/src/components/ServerDetailToolbar.tsx
    - apps/web/src/components/ServerFacts.tsx
    - apps/web/src/components/ServerFacts.test.tsx
    - docs/ui/APPROVAL.md
    - docs/ui/approved/*.png (8 of 12 refreshed; 4 unchanged from G1)
    - .planning/phases/08-redise-o-de-la-app/08-HUMAN-UAT.md
    - .planning/phases/08-redise-o-de-la-app/deferred-items.md

key-decisions:
  - "G2 resolved by delegated approval, not a live user walkthrough: the user replied 'bueno cualquier cosa continua' to the orchestrator's presented three-defect adjustment recommendation, authorizing exactly one round (the recommended one) then approval."
  - "The screen-reader pass (UI-04) was NOT performed at this gate. It remains explicitly open in 08-HUMAN-UAT.md and docs/ui/APPROVAL.md, deferred to G3. UI-04 is NOT marked complete in REQUIREMENTS.md."
  - "08-HUMAN-UAT.md's G2 checklist ticks only items verified by automation (E2E emulateMedia tests, unit-test class assertions) or by pnpm ui:review captures — every genuinely live/manual item (screen reader, DevTools media-feature toggles) stays unticked with an explicit note, rather than being marked done on the strength of a delegated 'go ahead'."
  - "ServerDetailToolbar's min-w-0 fix was applied exactly as specified, but the re-capture shows the same truncation depth as before the fix — investigated and documented honestly in deferred-items.md: both the wrapper and h1 already had overflow:hidden via truncate before the fix, so per the CSS Flexbox spec their automatic minimum size was already 0; the real constraint is the space already claimed by the back link, StatusPill and primary action button at 375px, not a min-width computation bug. The fix is kept (correct, harmless, matches codebase convention) and the residual gap is flagged for whichever plan next touches this file."

requirements-completed: [UI-12, UI-10]

# Metrics
duration: 55min
completed: 2026-09-26
---

# Phase 8 Plan 11: G2 gate — direction approved after one adjustment round Summary

**G2 direction gate recorded via delegated approval: one adjustment round (Toolbar theme-flicker fix, ServerDetailToolbar min-w-0, ServerFacts stat-tile stacking), 118/118 E2E and 2686/2686 unit green, screen-reader pass explicitly deferred to G3.**

## Performance

- **Duration:** 55 min (this continuation, from Task 3 start to completion)
- **Started:** 2026-09-26T04:00:00Z
- **Completed:** 2026-09-26T04:55:00Z
- **Tasks:** 1 (Task 3, continuing after Tasks 1-2 from the prior session)
- **Files modified:** 13 (4 component/test source files, 1 new test file, APPROVAL.md, 8 approved PNGs, 2 planning docs)

## Accomplishments
- Fixed the P17 theme-flicker band on `Toolbar.tsx` by scoping its motion-safe transition to `border-color` only
- Fixed `ServerDetailToolbar.tsx`'s missing `min-w-0` (the documented minimal fix), and honestly investigated + reported why it didn't visually change the truncation depth
- Fixed `ServerFacts.tsx`'s stat-tile grid to stack to a single column below 480px, so the widest mono value fits on one line at 375px
- Recorded G2 in `docs/ui/APPROVAL.md`: delegated approval, one round, screen-reader pass explicitly open
- Refreshed all 12 approved 1280px captures from the post-fix review round
- Full battery green: lint, typecheck, check:ui-safety (backdrop 3/3), 2686/2686 unit tests, 118/118 E2E

## Task Commits

1. **Task 1: Pre-gate verification and fresh captures** (prior session) - `d81564e` (docs)
2. **Task 2: G2 checkpoint** (prior session, resolved by delegated approval — no commit, checkpoint-only)
3. **Task 3, round 1 RED: three failing tests proving the missing fixes** - `f4c06fc` (test)
4. **Task 3, round 1 GREEN: the three fixes** - `b5c26f6` (fix)
5. **Task 3: G2 record, HUMAN-UAT, deferred-items** - `fba326f` (docs)

**Plan metadata:** (this commit, following this SUMMARY)

_Note: this was a TDD round (RED → GREEN) covering three independent display defects in one commit pair, rather than three separate RED/GREEN cycles — each defect had its own dedicated test(s) within the same two commits, and each test was confirmed failing (RED) before any fix existed for it, then all three confirmed passing together (GREEN)._

## Files Created/Modified
- `apps/web/src/components/Toolbar.tsx` - `motion-safe:transition-[border-color]` instead of `transition-colors`
- `apps/web/src/components/Toolbar.test.tsx` - updated assertion for the new class, added a negative assertion against bundling `background-color`
- `apps/web/src/components/ServerDetailToolbar.tsx` - `min-w-0` on the title wrapper and the `h1`
- `apps/web/src/components/ServerDetailToolbar.test.tsx` - new file, asserts `min-w-0`/`truncate` on both elements
- `apps/web/src/components/ServerFacts.tsx` - stat-tile grid: `grid-cols-1 min-[480px]:grid-cols-2 sm:grid-cols-4`
- `apps/web/src/components/ServerFacts.test.tsx` - new assertion for the grid's breakpoint classes
- `docs/ui/APPROVAL.md` - G2 block filled: date, 1 round, approver, evidence, adjustment log, screen-reader status
- `docs/ui/approved/*.png` - 8 of 12 refreshed (activity, server-detail, servers, settings ×2 themes); `login-*`, `setup-*` unchanged (not touched by this round's fixes)
- `.planning/phases/08-redise-o-de-la-app/08-HUMAN-UAT.md` - G2 section: items ticked only where automation/captures verified them; screen-reader and live-toggle items left open with notes
- `.planning/phases/08-redise-o-de-la-app/deferred-items.md` - two round-1 fixes moved into their own section (one fully resolved, one partially resolved with the residual finding); four still-open gaps (ServerDetailToolbar parity, hover-gate sweep, inspector panel, Sheet exit animation) organized under "Still open"

## Decisions Made
See `key-decisions` in frontmatter. In short: G2 was delegated rather than walked live by the user, the screen-reader requirement (UI-04) stays explicitly open rather than being marked done, and the `min-w-0` fix's lack of visual effect was investigated and reported honestly rather than glossed over.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] `h1` itself also needed `min-w-0`, not only the wrapper div**
- **Found during:** Task 3, writing the RED test for `ServerDetailToolbar`
- **Issue:** The plan's description named only "the flex title item" (the wrapper); the `h1` is itself a nested flex item (sibling of `StatusPill` inside the wrapper's own flex row) and needed the same treatment for defensive consistency.
- **Fix:** Added `min-w-0` to both the wrapper `div` and the `h1`.
- **Files modified:** `apps/web/src/components/ServerDetailToolbar.tsx`
- **Verification:** `ServerDetailToolbar.test.tsx` asserts both.
- **Committed in:** `b5c26f6`

---

**Total deviations:** 1 auto-fixed (Rule 1, minor scope widening within the same file/line the plan already named)
**Impact on plan:** No scope creep — same file, same defect, more complete application of the documented fix.

## Issues Encountered

**The `ServerDetailToolbar` title truncation fix did not visibly change the rendered result.** Investigated rather than declared done on faith (per this round's explicit instruction not to declare a defect fixed without looking): re-capturing `server-detail-light-375.png` after applying `min-w-0` shows the same "u." truncation as before. Root-caused to the CSS Flexbox spec's automatic-minimum-size rule (an item with non-`visible` overflow already has an automatic minimum size of `0`, and both the wrapper and the `h1` already carried `truncate` — hence `overflow: hidden` — before this fix), combined with the real, non-bug constraint that the back link, `StatusPill` and primary action button already consume nearly all of the available 375px row width. The fix was kept (it is correct and matches this codebase's own established `min-w-0` convention for truncating flex items) and the residual gap is documented in `deferred-items.md` with a concrete follow-up suggestion (an icon-only back link below ~480px) for whichever plan next touches this file. This was reported to the user's delegated-approval context rather than treated as a silent gap — see `docs/ui/APPROVAL.md`'s adjustment log for item 2.

## User Setup Required

None - no external service configuration required.

## Next Phase Readiness

G2 is recorded and P1/P2 motion work (wave 9 and later: 08-13 through 08-19) is unblocked per D-13. Two things carry forward as explicit, tracked open items rather than silent gaps:

- **UI-04's screen-reader requirement** is still open (not performed at this delegated G2). It must be genuinely exercised — VoiceOver on `RowMenu` and `AccountMenu` — before G3 is recorded, per `08-19-PLAN.md`'s own G3 gate (not yet read in this session, but implied by the phase's three-gate structure in `docs/ui/APPROVAL.md`).
- **`ServerDetailToolbar`'s residual 375px title-truncation gap and its missing scroll-edge/fallback parity with `Toolbar.tsx`** are both logged in `deferred-items.md` under "Still open" for a later plan to pick up.

No blockers for wave 9's motion-contract work.

---
*Phase: 08-redise-o-de-la-app*
*Completed: 2026-09-26*
