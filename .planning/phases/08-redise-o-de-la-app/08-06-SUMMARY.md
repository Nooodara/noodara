---
phase: 08-redise-o-de-la-app
plan: 06
subsystem: ui
tags: [design-tokens, tailwind-v4, accessibility, radix-ui, playwright]

# Dependency graph
requires:
  - phase: 08-redise-o-de-la-app
    provides: "08-03: --shadow-floating/--surface-elevated tokens and the shadow-outside-allowlist + backdrop-filter-budget gates in scripts/check-ui-safety.mjs"
  - phase: 08-redise-o-de-la-app
    provides: "08-04: RowMenu rebuilt on useFloatingMenu/useCloseSource, its own touch-visibility hover-gating precedent"
provides:
  - "packages/ui/src/Sheet.tsx: shadow-[var(--shadow-floating)], bg-surface-elevated/72, prefers-reduced-transparency (solid bg + backdrop-filter:none) and contrast-more (border-hairline-strong + opaque bg) fallbacks, motion-safe-gated translate-x pair with a motion-reduce opacity crossfade at --duration-panel"
  - "packages/ui/src/Dialog.tsx: shadow-[var(--shadow-floating)], bg-surface-elevated (solid), contrast-more:border-hairline-strong on the shared DialogShell (both ConfirmDialog and DestructiveConfirmDialog inherit it)"
  - "packages/ui/src/RowMenu.tsx: shadow-[var(--shadow-floating)] on the content (bg-surface-3 unchanged), contrast-more:border-hairline-strong, every hover: utility on the trigger and items now gated behind (hover: hover) and (pointer: fine)"
  - "packages/ui/src/ListRow.tsx: its own hover:bg-surface-2 gated behind (hover: hover) and (pointer: fine) (Rule 2 scope extension, see Deviations)"
  - "tests/e2e/a11y-fallbacks.spec.ts: four @a11y-fallbacks real-browser tests (page.emulateMedia) proving the reduced-motion alternative and its positive control"
affects: ["08-07", "08-08", "08-11", "08-14", "08-19"]

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "Tailwind v4's built-in contrast-more: variant (compiles to @media (prefers-contrast: more)) used directly instead of a hand-rolled arbitrary variant -- no equivalent built-in exists for prefers-reduced-transparency, so that one fallback stays an explicit [@media(prefers-reduced-transparency:reduce)]: arbitrary variant, including the arbitrary-property form [backdrop-filter:none] since Tailwind composes backdrop-blur/backdrop-saturate into one shorthand and zeroing only the blur half would leave the saturate half still filtering"
    - "Hover-gating convention (established by 08-04's RowMenu trigger) extended to every remaining ungated hover: utility this plan touches -- RowMenu's ITEM_CLASSES/TRIGGER_CLASSES and ListRow's ROW_CLASSES all now wrap hover: inside [@media(hover:hover)_and_(pointer:fine)]:, leaving focus-visible: ungated since keyboard focus is never pointer-dependent"
    - "Reduced-motion proven by CSS mechanism (getComputedStyle(...).transitionProperty), not a caught mid-animation frame -- a frame-sampling spike (MutationObserver + requestAnimationFrame) proved Radix's DialogPrimitive.Content mounts directly at its final data-state (no earlier value to transition from) and unmounts synchronously on close (no Presence-based exit delay), so no direction of the Sheet's open/close today ever exposes an observable mid-flight transform frame; the deterministic, honest proof available is that the transform-based transition is entirely replaced by an opacity-only one when prefers-reduced-motion is on, and is genuinely still declared when it is off (the positive control)"

key-files:
  created:
    - tests/e2e/a11y-fallbacks.spec.ts
  modified:
    - packages/ui/src/Sheet.tsx
    - packages/ui/src/Sheet.test.tsx
    - packages/ui/src/Dialog.tsx
    - packages/ui/src/Dialog.test.tsx
    - packages/ui/src/RowMenu.tsx
    - packages/ui/src/RowMenu.test.tsx
    - packages/ui/src/ListRow.tsx
    - packages/ui/src/ListRow.test.tsx

key-decisions:
  - "UI-03 is marked complete in REQUIREMENTS.md by this plan: its full text (Sheet/Dialog/RowMenu carry --shadow-floating with a lighter dark-mode surface step; no other component ever gets a shadow, gate automated) is now fully satisfied end to end -- 08-03 built the tokens/gate, this plan is the one that actually applies them to the three named components. UI-10 is NOT marked complete: its full REQUIREMENTS.md text names the toolbar as a fourth surface needing prefers-reduced-motion/prefers-reduced-transparency/prefers-contrast alternatives (\"...alternativas intencionales en toolbar, sheet, dialog y menú...\"), and apps/web/src/components/Toolbar.tsx/ServerDetailToolbar.tsx carry none today -- that is a later plan's scope (the shell work), not this one's."
  - "08-03-SUMMARY.md's own backdrop-filter-budget correction stands unchanged by this plan: the real count is 3 (Sheet, Toolbar, ServerDetailToolbar), not the 2 08-UI-SPEC.md's SS5.3 narrative states, and this plan's own task 1 acceptance criteria literally asked for count=2 -- carried forward as a Rule 1 stated-fact correction (see Deviations) since this plan adds zero new backdrop-filter surfaces and the gate's own comparator (total <= 3) was already passing at the real ceiling before this plan started."
  - "ListRow.tsx (and its test file) were modified even though the plan's own files_modified frontmatter list does not name them -- the plan's Task 2 action text explicitly instructs gating 'each hover: utility in RowMenu's ITEM_CLASSES and TRIGGER_CLASSES and in ListRow's hover treatment', and ListRow.tsx is named in Task 2's own read_first list. Treated as Rule 2 (auto-add missing critical functionality: UI-10's hover-gating requirement, explicitly named in the task's own action text) rather than out-of-scope creep."
  - "Dialog and RowMenu receive no motion-safe/motion-reduce changes in Task 3: both components declare zero transform/scale motion today (confirmed by direct source read and by this plan's own e2e tests, which pass unmodified against the pre-existing code) -- the scale-based open/close animation 08-UI-SPEC.md SS6.2 describes for RowMenu is explicitly deferred to a later motion-contract plan (08-04-SUMMARY.md already documented the same deferral for press-feedback/easing). Their @a11y-fallbacks tests assert the true current state (no scale, ever) as a regression guard against 08-14 accidentally shipping an ungated scale-in-reduced-motion later, not as evidence this plan added new motion to either component."

patterns-established: []

requirements-completed: ["UI-03"]

# Metrics
duration: ~35min
completed: 2026-09-26
---

# Phase 8 Plan 6: Floating elevation and the three accessibility fallbacks Summary

**`--shadow-floating`/`bg-surface-elevated` now actually apply to `Sheet`/`Dialog`/`RowMenu` (not just declared as unused tokens), all three overlays gained `prefers-contrast: more` and (Sheet only) `prefers-reduced-transparency` fallbacks plus fully hover-gated touch behaviour, and a real-browser Playwright spec proves the Sheet's reduced-motion alternative genuinely swaps its transform transition for an opacity-only one.**

## Performance

- **Duration:** ~35 min
- **Completed:** 2026-09-26
- **Tasks:** 3
- **Files modified:** 9 (1 created, 8 modified)

## Accomplishments

- `Sheet.tsx`'s `PANEL_CLASSES` swapped `bg-surface-1/72` for `bg-surface-elevated/72` and gained `shadow-[var(--shadow-floating)]`; `Dialog.tsx`'s shared `DialogShell` `PANEL_CLASSES` swapped `bg-surface-1` for the solid `bg-surface-elevated` and gained the same shadow (both `ConfirmDialog` and `DestructiveConfirmDialog` inherit it with no second edit); `RowMenu.tsx`'s `CONTENT_CLASSES` gained the shadow while `bg-surface-3` stayed untouched, exactly per 08-UI-SPEC.md SS5.1/5.2. `pnpm check:ui-safety`'s shadow-outside-allowlist gate stayed green at `count=0` (the shadow lives inside the allowlisted files) and the backdrop-filter budget gate stayed at its real, pre-existing `count=3` (this plan adds zero new `backdrop-filter` surfaces -- see Deviations for the acceptance-criteria correction).
- `Sheet.tsx` gained two more fallbacks on the same `PANEL_CLASSES` constant: `prefers-reduced-transparency: reduce` drops to a fully opaque `bg-surface-elevated` with `backdrop-filter: none` (the arbitrary-property form, since Tailwind's blur/saturate utilities compose into one shorthand); `prefers-contrast: more` (Tailwind's built-in `contrast-more:` variant) swaps to `border-hairline-strong` and pushes the background fully opaque too. `Dialog.tsx` and `RowMenu.tsx` each gained only `contrast-more:border-hairline-strong` -- both are already solid, so 08-UI-SPEC.md SS10 correctly calls for no reduced-transparency override on either.
- Every `hover:` utility this plan touches now sits behind `[@media(hover:hover)_and_(pointer:fine)]:` -- `RowMenu.tsx`'s `TRIGGER_CLASSES` and `ITEM_CLASSES`, and (Rule 2 scope extension, explicitly named in the plan's own Task 2 action text) `ListRow.tsx`'s `ROW_CLASSES` -- so a tap on a touch device never leaves a row or menu item stuck in its hover-highlighted state. `focus-visible:` stays ungated everywhere, since keyboard focus is never pointer-dependent.
- `Sheet.tsx`'s `data-[state=open]:translate-x-0 data-[state=closed]:translate-x-full` pair moved inside `motion-safe:` alongside the existing transition, and a new `motion-reduce:transition-opacity motion-reduce:duration-[var(--duration-panel)] motion-reduce:data-[state=closed]:opacity-0` pairing replaces the slide with a short opacity-only crossfade under `prefers-reduced-motion: reduce`.
- `tests/e2e/a11y-fallbacks.spec.ts` (new, 4 tests, tag `@a11y-fallbacks`): proves via `page.emulateMedia({ reducedMotion: 'reduce' })` that the Sheet panel's `transitionProperty` drops `transform` entirely and gains `opacity` under reduced motion (with `translateX` staying `0`); that the delete `Dialog` and the `RowMenu` open with no scale (`scaleX`/`scaleY` both `1`) under reduced motion; and the positive control -- without emulation, the Sheet panel's `transitionProperty` genuinely still contains `transform` with a non-zero `transitionDuration`, proving the reduced-motion test measures a real, distinct mechanism rather than an already-inert component.

## Task Commits

Each task was committed atomically (TDD RED then GREEN):

1. **Task 1: Floating elevation on Sheet, Dialog and RowMenu**
   - `6959dc6` (test) -- failing floating-elevation class assertions
   - `8a04747` (feat) -- shadow + surface-elevated applied to the three components
2. **Task 2: reduced-transparency, contrast-more and hover gating**
   - `7662570` (test) -- failing a11y-fallback and hover-gating assertions
   - `b167859` (feat) -- reduced-transparency/contrast-more variants, hover gating on RowMenu + ListRow
3. **Task 3: reduced-motion alternatives and their browser-level test**
   - `b4be660` (test) -- failing real-browser `@a11y-fallbacks` spec
   - `cb51af7` (feat) -- Sheet's motion-safe/motion-reduce gating and opacity crossfade

_No plan-metadata commit yet -- this SUMMARY.md and the STATE/ROADMAP updates are committed separately, per the executor's final-commit step._

## Files Created/Modified

- `packages/ui/src/Sheet.tsx` - shadow, surface-elevated, reduced-transparency, contrast-more, motion-safe/motion-reduce gating on `PANEL_CLASSES`
- `packages/ui/src/Sheet.test.tsx` - 4 new class-presence assertions
- `packages/ui/src/Dialog.tsx` - shadow, surface-elevated, contrast-more on the shared `DialogShell`'s `PANEL_CLASSES`
- `packages/ui/src/Dialog.test.tsx` - 2 new class-presence assertions
- `packages/ui/src/RowMenu.tsx` - shadow, contrast-more on `CONTENT_CLASSES`; hover gating on `TRIGGER_CLASSES`/`ITEM_CLASSES`
- `packages/ui/src/RowMenu.test.tsx` - 3 new assertions (shadow/bg-surface-3, contrast-more, hover gating)
- `packages/ui/src/ListRow.tsx` - hover gating on `ROW_CLASSES`
- `packages/ui/src/ListRow.test.tsx` - 1 new assertion
- `tests/e2e/a11y-fallbacks.spec.ts` - new file, 4 `@a11y-fallbacks` real-browser tests

## Decisions Made

See `key-decisions` in the frontmatter above for the full rationale on: (1) UI-03 marked complete, UI-10 left pending (toolbar not in this plan's scope), (2) the backdrop-filter-budget acceptance-criteria correction, (3) the `ListRow.tsx` scope extension, (4) why Dialog/RowMenu get no motion-safe/motion-reduce changes.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Stated fact] Task 1's acceptance criteria states the backdrop-filter gate should report `count=2`; the real, already-corrected count is 3**
- **Found during:** Task 1 verification
- **Issue:** The plan's own Task 1 acceptance criteria says `pnpm check:ui-safety exits 0 and its backdrop-filter gate still reports count=2`. 08-03-SUMMARY.md already documented (before this plan started) that the real repo-wide count is 3 (`Sheet.tsx`, `Toolbar.tsx`, `ServerDetailToolbar.tsx`), not the 2 `08-UI-SPEC.md`'s SS5.3 narrative states, and wired the gate's own comparator to `total <= 3` accordingly. This plan adds zero new `backdrop-filter` declarations, so the count is unchanged at 3.
- **Fix:** Verified `pnpm check:ui-safety` reports `count=3` (not 2) and exits 0 -- the plan's literal wording was carried forward from the same pre-existing, already-documented discrepancy 08-03 found; no gate code changed.
- **Files modified:** None (verification-only; the gate's mechanism and comparator were already correct from 08-03).
- **Verification:** `pnpm check:ui-safety` output: `OK at most three simultaneous backdrop-filter surfaces ... (count=3)`.
- **Committed in:** N/A (no code change needed).

**2. [Rule 2 - Missing critical] `ListRow.tsx`'s hover reveal was left ungated by the plan's own `files_modified` frontmatter, but its Task 2 action text explicitly requires it**
- **Found during:** Task 2
- **Issue:** The plan's frontmatter `files_modified` list omits `packages/ui/src/ListRow.tsx`, but Task 2's own `read_first` names it directly ("packages/ui/src/ListRow.tsx (its own hover: styles, for the same gating treatment)") and its action text says "wrap each hover: utility in RowMenu's ITEM_CLASSES and TRIGGER_CLASSES **and in ListRow's hover treatment**". Leaving `ListRow.tsx`'s `hover:bg-surface-2` ungated would leave a real UI-10 touch-accessibility gap (a tap on touch getting stuck in a hover-highlighted row) directly contradicted by the task's own explicit instruction.
- **Fix:** Gated `ROW_CLASSES`'s `hover:bg-surface-2` behind `[@media(hover:hover)_and_(pointer:fine)]:`, with a RED test first (`ListRow.test.tsx`).
- **Files modified:** `packages/ui/src/ListRow.tsx`, `packages/ui/src/ListRow.test.tsx`
- **Verification:** `packages/ui/src/ListRow.test.tsx` (9/9 passing, including the new hover-gating assertion); full `pnpm test` (2632/2632) and `pnpm test:e2e` (111/111) show no regression on any screen that renders `ListRow` (servers list, activity).
- **Committed in:** `7662570` (test), `b167859` (feat) -- same commits as Task 2's own RowMenu hover-gating work, since both are the identical fix applied to two components.

---

**Total deviations:** 2 (1 stated-fact correction carried forward from 08-03, 1 auto-added critical functionality explicitly named in the plan's own task text). No scope creep beyond what Task 2's action text itself already specified.

## Issues Encountered

- **Frame-sampling spike for Task 3, discarded in favour of a CSS-mechanism proof:** an initial `MutationObserver` + `requestAnimationFrame` sampler (built to literally catch a non-zero `translateX` mid-animation, as the plan's Task 3 action text suggests: "Assert on the computed transform of the panel/content element mid-open") was run against the real stack in both directions (open and close) and found that Radix's `DialogPrimitive.Content` mounts directly at its final `data-state="open"`/`translate-x-0` value (no earlier value to transition away from) and unmounts synchronously on close with no `Presence`-based exit delay (`CredentialFields.tsx`'s own header comment already documents this: "the parent ServerSheet's Sheet unmounts this block's whole subtree on close"). Neither direction of the Sheet's open/close today exposes an observable mid-flight transform frame to catch, in the pre-fix code or the post-fix code -- this is a pre-existing characteristic of the current Radix wiring, not something introduced or fixable within this plan's scope (wiring `forceMount`/`Presence`-based exit-animation completion is real, separate work that plan 08-14's motion-contract sweep owns, per this task's own explicit "do not implement a scale-from-trigger origin... this task's scope is only the reduced-motion alternative and its gate" instruction). The final spec instead proves the fallback via the deterministic CSS mechanism (`getComputedStyle(...).transitionProperty`/`transitionDuration`), which is honest, non-flaky, and still catches a real regression (an accidentally-ungated `motion-safe:` class would immediately fail the reduced-motion test).

## Rules not satisfied

None. TDD RED->GREEN was followed for all three tasks (RED commits `6959dc6`/`7662570`/`b4be660`, GREEN commits `8a04747`/`b167859`/`cb51af7`). `pnpm typecheck`, `pnpm lint`, `pnpm test` (2632/2632) and `pnpm check:ui-safety` (eleven `OK` lines) are all green. Docker Desktop was running; `pnpm test:e2e -- --grep @a11y-fallbacks` (4/4) and the full `pnpm test:e2e` (111/111, the prior 107 plus these 4) were both run for real against the genuine stack, not assumed.

## Hard Git Rules Compliance

- No `git stash` was run at any point (`git stash list` is empty, verified before and after this plan's work).
- No `git add .`/`-A`/`-u`, `git commit -a`, `git reset --hard`, `git clean`, or blanket `git checkout --`/`git restore` was run on any path not created by this plan.
- Every commit staged explicit paths inside `noodara/code/` only; `git status --porcelain` was checked before every commit to confirm only intended files were staged. The parent monorepo's unrelated `cv-executor`/`intervuee` changes, `.DS_Store`, `docs/ui-build-prompt.md` and every other untracked path outside this plan's scope were never staged or touched.
- All six commits use Conventional Commits, English, `(08-06)` scope, no `Co-Authored-By` or AI-attribution trailer of any kind -- verified after each commit with `git log -1 --format='%(trailers)'` printing nothing.
- No push, no branch created; all work is on `main` in the local monorepo.

## User Setup Required

None - no external service configuration required.

## Verification

- `pnpm exec vitest run packages/ui/src/Sheet.test.tsx packages/ui/src/Dialog.test.tsx packages/ui/src/RowMenu.test.tsx packages/ui/src/ListRow.test.tsx` -- 46/46 passing.
- `pnpm exec vitest run packages/ui/src/contrast.test.ts` -- 40/40 passing (still green against `--surface-elevated`, unchanged by this plan).
- `pnpm test` -- 2632/2632 passing (158 test files), no regression.
- `pnpm test:e2e -- --grep @a11y-fallbacks` -- 4/4 passing.
- `pnpm test:e2e` (full suite) -- 111/111 passing (107 pre-existing + 4 new `@a11y-fallbacks`).
- `pnpm check:ui-safety` -- exits 0, eleven `OK` lines: shadow-outside-allowlist gate still `count=0` (shadow lives inside the allowlist), backdrop-filter budget gate `count=3` (unchanged, see Deviations).
- `pnpm lint` -- all 9 turbo tasks green.
- `pnpm typecheck` -- all 8 turbo tasks green.
- Acceptance-criteria greps (Task 1): `shadow-\[var(--shadow-floating)\]` `count=1` in each of `Sheet.tsx`/`Dialog.tsx`/`RowMenu.tsx`; `bg-surface-elevated` `count=1` in `Sheet.tsx` and in `Dialog.tsx`; `shadow|backdrop` `count=0` in `Tooltip.tsx` (untouched, as instructed).
- Acceptance-criteria greps (Task 2): `prefers-reduced-transparency` `count=3` in `Sheet.tsx` (comment + two arbitrary-variant classes); `contrast-more`/`prefers-contrast` present in all three of `Sheet.tsx`/`Dialog.tsx`/`RowMenu.tsx`; every `hover:` occurrence in `RowMenu.tsx`/`ListRow.tsx` manually inspected and confirmed either inside a `[@media(hover:hover)_and_(pointer:fine)]:` variant or inside a header comment.
- Acceptance-criteria greps (Task 3): `motion-reduce:` `count=3` and `motion-safe:` `count=3` in `Sheet.tsx` (both `>= 1`/`>= 2` respectively).

## Next Phase Readiness

- `Sheet`/`Dialog`/`RowMenu` now genuinely float with the correct dark-mode surface step, and carry the two/one accessibility fallbacks 08-UI-SPEC.md SS10 assigns each -- ready for 08-07/08-08 (shell, `AccountMenu`) to follow the identical pattern (shadow + `contrast-more:border-hairline-strong` + hover-gating), and for 08-14's motion-contract sweep to build the real `forceMount`/`Presence`-based exit animation and RowMenu/AccountMenu scale-from-trigger motion this plan deliberately left untouched.
- UI-10 stays open until a later plan gives the toolbar (`Toolbar.tsx`/`ServerDetailToolbar.tsx`) its own reduced-motion/reduced-transparency/contrast-more alternatives -- flagged explicitly in key-decisions above so it is not silently dropped.
- No blockers for the next plan in this wave.

---
*Phase: 08-redise-o-de-la-app*
*Completed: 2026-09-26*

## Self-Check: PASSED

All 10 claimed files verified present on disk (`packages/ui/src/Sheet.tsx`,
`packages/ui/src/Sheet.test.tsx`, `packages/ui/src/Dialog.tsx`, `packages/ui/src/Dialog.test.tsx`,
`packages/ui/src/RowMenu.tsx`, `packages/ui/src/RowMenu.test.tsx`, `packages/ui/src/ListRow.tsx`,
`packages/ui/src/ListRow.test.tsx`, `tests/e2e/a11y-fallbacks.spec.ts`, this SUMMARY.md). All 6
commit hashes (`6959dc6`, `8a04747`, `7662570`, `b167859`, `b4be660`, `cb51af7`) verified present
in `git log --oneline --all`. No missing items.
