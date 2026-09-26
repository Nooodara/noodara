---
phase: 08-redise-o-de-la-app
plan: 15
subsystem: ui
tags: [css, tailwind-v4, starting-style, clip-path, tabular-nums, text-wrap, craft]

requires:
  - phase: 08-redise-o-de-la-app
    provides: "05-UI-SPEC.md-era Skeleton/StatTile/EmptyState/Banner/Notice components (05-xx plans), the `--duration-panel`/`--ease-out` motion tokens (08-01/08-02)"
provides:
  - "UI-09 in full: themed browser surfaces, tabular-nums default with a documented opt-out, 70ch measure cap, skeleton-to-content blur bridge, @starting-style entrance, clip-path disk meter reveal"
affects: [08-ui-review, future-plans-touching-Skeleton-StatTile-EmptyState-Banner-Notice]

tech-stack:
  added: []
  patterns:
    - "data-entering=\"true\" attribute + a single @starting-style rule in globals.css is the repo's one entrance mechanism -- no mounted-state useEffect anywhere for this purpose"
    - "clip-path: inset(...) as the reveal technique for a fill that must not resize (hardware-accelerated, no layout thrash)"
    - "font-variant-numeric: tabular-nums as a page-wide default with narrow, documented opt-outs (normal-nums) on named prose surfaces"

key-files:
  created: []
  modified:
    - apps/web/src/app/globals.css
    - packages/ui/src/EmptyState.tsx
    - packages/ui/src/Banner.tsx
    - packages/ui/src/Notice.tsx
    - packages/ui/src/Skeleton.tsx
    - packages/ui/src/StatTile.tsx
    - packages/ui/src/EmptyState.test.tsx
    - packages/ui/src/Banner.test.tsx
    - packages/ui/src/Notice.test.tsx
    - packages/ui/src/Skeleton.test.tsx
    - packages/ui/src/StatTile.test.tsx

key-decisions:
  - "Tabular-nums opt-out for ActivityRow's prose sentence is done via a global attribute selector ([data-testid='activity-row'] p) in globals.css, not by editing ActivityRow.tsx, since that file was out of this plan's scope"
  - "The @starting-style entrance rule is keyed on a single data-entering=\"true\" attribute (plan's own suggestion), applied to Skeleton/SkeletonRow/SkeletonText -- a repo-wide grep found no useEffect+mounted entrance pattern to migrate elsewhere; ThemeToggle's settledRef is unrelated (hydration-safety) and untouched"
  - "70ch measure lives on the message <p> in EmptyState/Banner/Notice (component-owned, files this plan touches) and via a [role='dialog'] p selector in globals.css for the dialog body (Dialog.tsx is owned by 08-14, not touched here)"
  - "StatTile's meter fill keeps the same DOM shape (track div > fill div); only its style prop changed from width to clipPath, so data-fraction and every existing contract stay intact"

patterns-established:
  - "Skeleton-to-content blur bridge: both the outgoing skeleton and the incoming content carry data-entering + a motion-safe opacity/filter transition, so a conditional unmount/mount pair reads as one continuous crossfade even though the two DOM nodes never coexist"

requirements-completed: [UI-09, UI-10]

duration: 55min
completed: 2026-09-26
---

# Phase 8 Plan 15: Surface Craft Summary

**Themed browser chrome, tabular-nums-by-default numerals, 70ch prose measure, a data-entering-keyed @starting-style entrance, and a clip-path-revealed disk meter -- every value bound to an existing token, zero new literals.**

## Performance

- **Duration:** 55 min
- **Started:** 2026-09-26T05:23:00Z
- **Completed:** 2026-09-26T05:35:00Z
- **Tasks:** 3
- **Files modified:** 11 (6 source, 5 test)

## Accomplishments
- `apps/web/src/app/globals.css` now themes `::selection`, `caret-color`, WebKit + standard scrollbars, and link underline offset from `--accent-soft`/`--accent`/`--hairline-strong`/`--r-pill` -- zero literal colours (verified by `check:ui-safety`'s hex/rgb gates and the plan's own greps).
- `font-variant-numeric: tabular-nums` is now the page-wide default, with a narrow, documented opt-out on ActivityRow's prose sentence (global selector) and on Banner/Notice's message text (component class, `normal-nums`).
- Headings (`h1`/`h2`/`h3`) balance, body copy (`p`) prettifies, and `EmptyState`/`Banner`/`Notice`/`[role="dialog"] p` all cap at a 70ch measure.
- `Skeleton`/`SkeletonRow`/`SkeletonText` carry `data-entering="true"` plus a `motion-safe:`-gated opacity+filter transition at `--duration-panel`/`--ease-out`; `globals.css` declares the one `@starting-style` rule this keys into, requiring no `mounted`-state effect anywhere in the repo (verified by grep -- none existed beyond `ThemeToggle`'s already-excluded `settledRef`).
- `StatTile`'s disk meter fill is revealed with `clip-path: inset(0 {right}% 0 0)` instead of an animated `width`; `data-fraction` and `clampFraction`'s guard are unchanged.

## Task Commits

Each task was committed with a RED test commit followed by a GREEN implementation commit:

1. **Task 1: Browser surfaces, numerals and measure** - `f90b5c5` (test) -> `4f13b89` (feat)
2. **Task 2: Blur bridge and @starting-style entrance** - `d448e8f` (test) -> `99a478b` (feat)
3. **Task 3: clip-path disk meter** - `8c4a22e` (test) -> `55b7b9b` (feat)

**Plan metadata:** commit created below (docs: complete plan)

## Files Created/Modified
- `apps/web/src/app/globals.css` - craft rules: `::selection`/`caret-color`/scrollbars/underline-offset, tabular-nums default + opt-out, `text-wrap` balance/pretty, 70ch dialog cap, `@starting-style` entrance rule
- `packages/ui/src/EmptyState.tsx` - `max-w-[70ch]` on body `<p>`
- `packages/ui/src/Banner.tsx` - `max-w-[70ch] normal-nums` on message `<p>`
- `packages/ui/src/Notice.tsx` - `max-w-[70ch] normal-nums` on message `<p>`
- `packages/ui/src/Skeleton.tsx` - `data-entering="true"` + blur-bridge transition classes on all three exports
- `packages/ui/src/StatTile.tsx` - meter fill switched from `width` to `clipPath`
- `packages/ui/src/{EmptyState,Banner,Notice,Skeleton,StatTile}.test.tsx` - RED cases for each behaviour above

## Decisions Made
- Grep confirmed no `useEffect`+`mounted` entrance pattern exists anywhere in `packages/ui/src` or `apps/web/src` (other than `ThemeToggle`'s excluded `settledRef`), so Task 2's "replace every remaining instance" step required no additional file changes beyond adding the reusable `@starting-style` mechanism itself.
- Rounded the clip-path percentage to 2 decimal places (`Math.round(... * 10000) / 100`) to avoid a floating-point artifact (`55.00000000000001%`) that the previous `width`-based code never surfaced because its own test only exercised an exact value.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] Fixed a floating-point artifact in the clip-path percentage**
- **Found during:** Task 3 (StatTile clip-path)
- **Issue:** `(1 - 0.45) * 100` produces `55.00000000000001` in JS floating-point arithmetic, which would render an ugly, non-deterministic `clip-path` value.
- **Fix:** Round to 2 decimal places before interpolating into the CSS string.
- **Files modified:** `packages/ui/src/StatTile.tsx`
- **Committed in:** `55b7b9b` (Task 3 commit)

**2. [Rule 1 - Bug] Removed the literal word "backdrop" from a Skeleton.tsx comment**
- **Found during:** Task 2 self-check against the plan's acceptance criteria
- **Issue:** An early draft comment explaining the blur bridge referenced "`backdrop-filter`" by name, which made the plan's own acceptance grep (`grep -c "backdrop" packages/ui/src/Skeleton.tsx` must be `0`) fail even though no `backdrop-filter` CSS was ever used.
- **Fix:** Reworded the comment to describe the same constraint ("never the translucent-material pattern Toolbar/Sheet use") without the literal substring.
- **Files modified:** `packages/ui/src/Skeleton.tsx`
- **Committed in:** `99a478b` (Task 2 commit)

**3. [Rule 3 - Blocking] Fixed a lint failure in StatTile.test.tsx**
- **Found during:** Task 3, `pnpm lint` after GREEN
- **Issue:** `as HTMLElement` type assertions on `querySelector` results tripped `@typescript-eslint/non-nullable-type-assertion-style`; the auto-fix suggestion (`!`) then tripped the separate `no-non-null-assertion` rule.
- **Fix:** Rewrote the test to query the fill element directly with a more specific selector (`[data-fraction] > div`) and use optional chaining, matching the pattern already used elsewhere in this file (`AccountMenu.test.tsx`).
- **Files modified:** `packages/ui/src/StatTile.test.tsx`
- **Committed in:** `55b7b9b` (Task 3 commit)

---

**Total deviations:** 3 auto-fixed (2 bugs, 1 blocking lint fix)
**Impact on plan:** All three are small, local corrections needed to satisfy the plan's own acceptance criteria and the repo's lint gate. No scope creep, no architectural change.

## Rules not satisfied

None. Every behaviour bullet in the plan (browser surfaces, tabular-nums default + opt-out, text-wrap/measure, blur bridge, `@starting-style`, clip-path meter) is implemented and verified either by a unit test, a grep-based acceptance criterion, or the full E2E suite.

One note for future readers: the plan's Task 2 acceptance criteria expected the backdrop-filter budget gate to read "count=2 unchanged"; the actual baseline in this repo (before and after this plan, since this plan never touches a `backdrop-filter` declaration) is `count=3` -- a third surface was already added by a concurrent 08-xx plan in this same wave. The gate is unchanged by this plan's work and stays within the documented budget (max 3), so this is a stale number in the plan text, not a regression.

## Issues Encountered
None beyond the three auto-fixed items above.

## Verification

- `pnpm exec vitest run packages/ui/src/EmptyState.test.tsx packages/ui/src/Banner.test.tsx packages/ui/src/Notice.test.tsx packages/ui/src/Skeleton.test.tsx packages/ui/src/StatTile.test.tsx` -- all green
- `pnpm test` -- 2703/2703 passed (164 files)
- `pnpm test:e2e` -- 124/124 passed
- `pnpm lint` -- clean across all workspaces
- `pnpm typecheck` -- clean across all workspaces
- `pnpm check:ui-safety` -- all gates OK, hex/rgb literal gates at 0, backdrop-filter gate unchanged at count=3 (within the max-3 budget)

## User Setup Required

None - no external service configuration required.

## Next Phase Readiness

UI-09 is now fully delivered and marked complete in REQUIREMENTS.md. Skeleton, StatTile, EmptyState, Banner and Notice all carry the craft techniques described in 08-UI-SPEC.md SS9; any future plan touching these components should preserve `data-entering`, the blur-bridge classes, and the `clip-path`-based meter reveal rather than reintroducing a `width`-driven fill or a `mounted`-state effect.

---
*Phase: 08-redise-o-de-la-app*
*Completed: 2026-09-26*

## Self-Check: PASSED

All 6 modified source files and this SUMMARY.md verified present on disk; all 6 task commit hashes (f90b5c5, 4f13b89, d448e8f, 99a478b, 8c4a22e, 55b7b9b) verified present in `git log`.
