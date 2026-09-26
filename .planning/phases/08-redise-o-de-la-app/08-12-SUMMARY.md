---
phase: 08-redise-o-de-la-app
plan: 12
subsystem: ui
tags: [motion, framer-motion, drag-to-dismiss, radix, sheet, gesture, lazy-loading]

requires:
  - phase: 08-redise-o-de-la-app
    provides: "08-04's useCloseSource (keyboard-vs-pointer close-source tracker), 08-06's Sheet PANEL_CLASSES/reduced-motion fallback, 08-11's RowMenu fix that made the dropdown-menu migration unnecessary"
provides:
  - "motion@13.4.1 registered, provenance-verified and installed, scoped to packages/ui only"
  - "packages/ui/src/motion-tokens.ts: SPRING constants plus toMotionSpring(), the SwiftUI response/dampingFraction -> Motion stiffness/damping/mass conversion"
  - "packages/ui/src/motion-features.js: lazy domMax re-export for LazyMotion"
  - "Sheet.tsx: drag-to-dismiss with progressive rubber-band resistance, velocity-based flick-close, momentum handoff, mid-close re-grab interruptibility, and an instant (no-animation) keyboard close"
  - "tests/e2e/server-sheet.spec.ts's @sheet-drag suite: the full brief SS7.4 sequence exercised with real pointer events"
affects: [08-13, 08-14, 08-20]

tech-stack:
  added: ["motion@13.4.1 (dependency of packages/ui only)"]
  patterns:
    - "LazyMotion(features=lazy-import domMax, strict) scoped to exactly one component -- any motion.* usage outside it throws at runtime"
    - "Two-layer transform: outer DialogPrimitive.Content keeps its existing CSS-transition-based open/close position (untouched); an inner m.div owns only the live drag offset, avoiding a doubled transform"
    - "MotionValue driven imperatively via animate() rather than the declarative animate prop, because a persistent declarative target re-asserts itself the instant a gesture ends and fights a momentum-handoff animation"
    - "SwiftUI-style spring tokens (damping/response) converted to Motion's native stiffness/damping/mass via a small, self-checked formula, since Motion does not recognise damping-as-ratio or response by name"

key-files:
  created:
    - packages/ui/src/motion-tokens.ts
    - packages/ui/src/motion-features.js
  modified:
    - packages/ui/src/Sheet.tsx
    - packages/ui/src/Sheet.test.tsx
    - packages/ui/package.json
    - packages/ui/tsconfig.json
    - pnpm-lock.yaml
    - scripts/check-package-provenance.mjs
    - docs/adr/0000-package-legitimacy-approvals.md
    - tests/e2e/server-sheet.spec.ts
    - .planning/phases/08-redise-o-de-la-app/deferred-items.md

key-decisions:
  - "motion scoped to Sheet.tsx alone via LazyMotion(domMax, strict), not domAnimation (which excludes drag entirely)"
  - "Kept the outer DialogPrimitive.Content's existing CSS-transition-based entry/button-close treatment completely unchanged; the new inner drag surface only owns the live gesture offset, avoiding a doubled transform across two nested elements"
  - "Drag release is driven by an externally-owned MotionValue via imperative animate() calls, not the declarative animate prop, after the declarative form was found to fight the momentum-handoff animation the instant a drag ended"
  - "Converted UI-SPEC's SwiftUI-style SPRING damping/response tokens into Motion's real stiffness/damping/mass via toMotionSpring(), after the raw values silently produced an almost-undamped, non-settling spring"
  - "Esc-initiated close plays no animation via a component-owned zero-duration override class (read from useCloseSource, owned by 08-04), never via onEscapeKeyDown -- keeps check:ui-safety's Radix-untouched gate at zero"
  - "@radix-ui/react-dropdown-menu was not installed -- recorded in ADR-0000 as deliberately declined, since 08-11's in-place RowMenu fix made the migration unnecessary"

patterns-established:
  - "toMotionSpring(): the one conversion point between this codebase's SwiftUI-flavoured design-token springs and Motion's actual physics API -- any future motion-driven component should go through it rather than passing damping/response straight to Motion"

requirements-completed: [UI-06, UI-05]

duration: 50min
completed: 2026-09-26
---

# Phase 08 Plan 12: Sheet drag-to-dismiss with Motion Summary

**Sheet gains real drag-to-dismiss physics via `motion@13.4.1`, scoped to exactly one file by `LazyMotion(domMax, strict)`, with a from-scratch fix to a genuine Motion spring-parameter mismatch discovered by the plan's own Playwright suite.**

## Performance

- **Duration:** ~50 min
- **Started:** 2026-09-26T04:15:42-06:00 (previous plan's completion commit)
- **Completed:** 2026-09-26T05:05:20-06:00
- **Tasks:** 3
- **Files modified:** 11 (2 created, 9 modified)

## Accomplishments

- `motion@13.4.1` registered in `EXPECTED_PACKAGES`/ADR-0000 before install, verified before and after, pinned exactly, scoped to `packages/ui` only
- `Sheet` drags to dismiss with progressive rubber-band resistance, a short fast flick closing regardless of distance, a slow drag snapping back, momentum handoff on release, and interruptible re-grab mid-close
- Keyboard-initiated (`Esc`) close plays no animation at all, via `useCloseSource` (owned by 08-04, imported not modified) -- no `onEscapeKeyDown`, `check:ui-safety`'s Radix-untouched gate stays at zero
- Found and fixed a real bug in this same plan's own `SPRING` tokens: Motion does not understand the SwiftUI `damping`/`response` convention 08-UI-SPEC.md's own token table is written in, and was silently producing an almost-undamped spring that oscillated for seconds instead of settling
- A 6-test `@sheet-drag` Playwright suite exercises the full brief SS7.4 sequence with real pointer events, including the `[ASSUMED]`-tagged interruptibility claim (research Assumption A2) that required a dedicated test before being relied on

## Task Commits

1. **Task 1: Register and install motion@13.4.1** - `4b87b44` (chore)
2. **Task 2: Drag-to-dismiss inside the Sheet (RED)** - `6b74ecf` (test)
2. **Task 2: Drag-to-dismiss inside the Sheet (GREEN)** - `42802c6` (feat)
3. **Task 3: The SS7.4 sequence measured with real pointer events (RED)** - `81daece` (test)
3. **Task 3: The SS7.4 sequence measured with real pointer events (GREEN/fix)** - `9aee417` (fix)

## Files Created/Modified

- `packages/ui/src/motion-tokens.ts` - `SPRING` constants (SwiftUI-style damping/response, matching 08-UI-SPEC's token table verbatim) plus `toMotionSpring()`, the conversion into Motion's real `stiffness`/`damping`/`mass` API
- `packages/ui/src/motion-features.js` - lazy `domMax` re-export for `LazyMotion`'s features loader
- `packages/ui/src/Sheet.tsx` - drag surface (`m.div` inside the unchanged `DialogPrimitive.Content`), release-decision logic, momentum-handoff and snap-back animations, entry settle-in, keyboard-close instant-unmount class
- `packages/ui/src/Sheet.test.tsx` - jsdom-honest RED cases: real Motion element present, lazy features loader, keyboard-close override class, all prior focus/ARIA/shadow assertions kept as a regression guard
- `packages/ui/tsconfig.json` - `allowJs` added so the deliberately plain-JS `motion-features.js` is emitted into `dist`, fixing a `pnpm build` `Module not found` in `apps/web` found while verifying Task 2
- `tests/e2e/server-sheet.spec.ts` - `@sheet-drag` Playwright suite: rubber-banding, flick-close, snap-back, velocity handoff, re-grab interruptibility, Esc-still-closes
- `scripts/check-package-provenance.mjs` / `docs/adr/0000-package-legitimacy-approvals.md` - `motion` registered and recorded; `@radix-ui/react-dropdown-menu` recorded as deliberately declined
- `.planning/phases/08-redise-o-de-la-app/deferred-items.md` - logs a pre-existing, out-of-scope gap found during Task 3 (see Deviations)

## Decisions Made

- Kept the outer `DialogPrimitive.Content`'s existing CSS-transition-based position entirely untouched (entry, button-close) and layered the new drag physics on a distinct inner `m.div`, so the two transforms never fight on the same element and every pre-existing Sheet test keeps passing byte-for-byte unmodified in behavior.
- Drove the drag `MotionValue` with imperative `animate()` calls rather than the declarative `animate` prop -- the declarative form re-asserts its static target the instant a drag gesture ends, directly fighting the momentum-handoff animation `handleDragEnd` starts. Found via Task 3's own "handoff" Playwright test, not by inspection.
- `@radix-ui/react-dropdown-menu` (evaluated in 08-RESEARCH.md as an alternative `RowMenu` foundation) was not installed; recorded in ADR-0000 as a deliberate, documented non-decision so a future reader doesn't re-litigate it.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 3 - Blocking] `pnpm build` failed with `Module not found: Can't resolve './motion-features.js'`**
- **Found during:** Task 2, running the plan's own `pnpm build` acceptance criterion
- **Issue:** `motion-features.js` is a deliberate plain-JS file (D19's own literal file name), but `tsc -p tsconfig.build.json` without `allowJs` only type-checks such a file via an ambient declaration -- it never emits/copies it into `dist`, so `apps/web`'s bundler failed to resolve the import at build time.
- **Fix:** Added `allowJs: true` to `packages/ui/tsconfig.json` (inherited by the build config too), so `tsc` treats the plain-JS file as a first-class compiled input.
- **Files modified:** `packages/ui/tsconfig.json`
- **Verification:** `NOODARA_API_ORIGIN=... pnpm build` exits 0 including `apps/web`
- **Committed in:** `42802c6` (Task 2 commit)

**2. [Rule 1 - Bug] Motion's spring transition silently ignored the `SPRING` tokens' `damping`/`response` keys**
- **Found during:** Task 3, the flick-close Playwright test hanging past its 5s timeout instead of the sheet closing
- **Issue:** 08-UI-SPEC.md's own `SPRING` token table is written in the SwiftUI `.spring(response:dampingFraction:)` convention. Motion's real `type: 'spring'` transition does not recognise `response` or a 0-1 `damping` ratio by those names at all -- its actual keys are `stiffness`/`damping`/`mass`, where `damping: 0.8` is interpreted as an almost-zero raw damping coefficient in Motion's own units, producing a spring that oscillates for seconds rather than settling. `handleDragEnd`'s `animate(x, ...).then(() => onOpenChange(false))` never resolved as a result.
- **Fix:** Added `toMotionSpring()` to `motion-tokens.ts` -- the standard response/dampingFraction -> stiffness/damping conversion (mass fixed at 1), self-checked by the fact that `SPRING.default`'s `damping: 1.0` (critically damped) converts to a `damping` value that exactly equals the textbook `2·√stiffness` critical-damping point. Also clamped the release velocity handed to the closing spring to a finite, sane range (`MAX_HANDOFF_VELOCITY_PX_PER_S`), since a near-zero elapsed time between the last two pointer samples in a very fast flick could otherwise produce an effectively-infinite velocity that broke the same settle-detection math.
- **Files modified:** `packages/ui/src/motion-tokens.ts`, `packages/ui/src/Sheet.tsx`
- **Verification:** All 6 `@sheet-drag` Playwright tests pass; full `pnpm test:e2e` (124 tests) passes
- **Committed in:** `9aee417` (Task 3 fix commit)

**3. [Rule 4-adjacent, out-of-scope discovery -- logged, not fixed] Esc-close of `Sheet` never returns focus to its trigger button**
- **Found during:** Task 3, while writing the Esc-close E2E test
- **Issue:** `Sheet` never renders a `DialogPrimitive.Trigger` (it is opened via an externally-controlled `open`/`onOpenChange` prop pair by design), so Radix's `FocusScope` has no `Trigger` of its own to restore focus to on unmount. Reproduced identically against the pristine, pre-08-12 `Sheet.tsx` (checked out from 08-11's tip), confirming this is a pre-existing gap, not a regression introduced by this plan's drag changes.
- **Why not fixed:** Out of this plan's scope per the SCOPE BOUNDARY rule -- not caused by 08-12's own changes, and 08-12's own Esc-related requirement (no animation, still dismisses) is fully met and tested.
- **Logged to:** `.planning/phases/08-redise-o-de-la-app/deferred-items.md`

---

**Total deviations:** 3 (2 auto-fixed under Rules 1/3, 1 logged as out-of-scope)
**Impact on plan:** Both auto-fixes were necessary for the plan's own acceptance criteria (`pnpm build` exit 0; the flick-close/handoff behaviors actually working) and are load-bearing corrections to Task 2's own SPRING-token/build-emission assumptions, not scope creep. The logged gap does not block this plan's own success criteria.

## Issues Encountered

- Extensive design-space exploration was needed to avoid a doubled-transform bug between the outer Radix `Content` (CSS-transition-driven open/close position) and the new Motion-driven drag surface -- resolved by giving the drag surface its own, additive-only transform layer rather than letting Motion own the whole panel's position.
- The declarative `animate` prop actively fought the imperative momentum-handoff animation the instant a drag ended -- resolved by driving the `x` `MotionValue` exclusively through the drag gesture itself and two explicit `animate()` calls, never a persistent declarative target.
- The brief's `damping`/`response` spring vocabulary does not exist in Motion's real API -- resolved with a small, self-checked conversion function (`toMotionSpring`) rather than silently reinterpreting the tokens' meaning.

## Rules Not Satisfied

None -- every rule in `<project_rules>` was satisfied:
- `motion` package-provenance gate followed exactly (registered before install, verified before/after, exact pin, scoped to `packages/ui`, lockfile diff confirmed to touch only the new package subtree)
- `motion` imported in exactly one source file (`Sheet.tsx`), enforced by `LazyMotion` `strict`
- `onEscapeKeyDown`/`onInteractOutside` gate stays at `count=0`; the keyboard/pointer distinction goes through `use-close-source.ts` (08-04's primitive), imported not modified (`git diff --name-only` on that file and `use-floating-menu.ts` is empty)
- Shadow allowlist (`count=0` outside the four allowlisted components) and the backdrop-filter budget (`count=3`, within budget) both stay green
- Reduced-motion fallback from 08-06 preserved: `drag` is disabled under `prefers-reduced-motion` via Motion's own `useReducedMotion`, and the existing `motion-reduce:` opacity crossfade classes are untouched
- Docker Desktop was running; `tests/e2e/server-sheet.spec.ts`'s new suite ran for real (6/6), the full `pnpm test:e2e` suite ran for real (124/124, up from 118 baseline), `pnpm lint`, `pnpm typecheck`, `pnpm test` (2689, up from 2686 baseline) and `pnpm check:ui-safety` all exit 0

## User Setup Required

None - no external service configuration required.

## Next Phase Readiness

- The only JS animation library in this codebase now exists in exactly one file, scoped and enforced at runtime by `LazyMotion` `strict`.
- `toMotionSpring()` is available in `motion-tokens.ts` for any future motion-driven component that needs to consume the same SwiftUI-style `SPRING` design tokens correctly.
- The drag physics constants (`DRAG_CLOSE_VELOCITY_PX_PER_S`, `dragElastic={0.15}`) are explicitly named as calibration starting points, per the plan's own framing -- G2/G3 live review (D-14) is where they get tuned against real, felt interaction, not this plan's job.
- The pre-existing Esc-close focus-return gap is logged in `deferred-items.md` for whichever future plan next revisits `Sheet`'s open/close plumbing.

---

*Phase: 08-redise-o-de-la-app*
*Completed: 2026-09-26*

## Self-Check: PASSED

All claimed files exist on disk and all claimed commit hashes exist in `git log`.
