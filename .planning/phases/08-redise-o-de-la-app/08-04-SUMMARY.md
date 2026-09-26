---
phase: 08-redise-o-de-la-app
plan: 04
subsystem: ui
tags: [radix-ui, floating-menu, accessibility, rowmenu, e2e, playwright]

# Dependency graph
requires:
  - phase: 08-redise-o-de-la-app
    provides: "08-02: G1 baseline gate approved, docs/ui/APPROVAL.md's G1 block filled in, D-13's blocking condition satisfied"
provides:
  - "packages/ui/src/use-close-source.ts: standalone keyboard/pointer/programmatic close-source primitive, takes open as an argument (controlled or uncontrolled consumers), exports useCloseSource"
  - "packages/ui/src/use-floating-menu.ts: shared floating-menu hook (open state, arrow-key roving focus, close-on-select, delegated close-source), exports useFloatingMenu"
  - "packages/ui/src/RowMenu.tsx: built on useFloatingMenu, closes on select with focus return to the trigger, aria-expanded on the trigger, stable id-based keys, touch-visible trigger via (hover: hover) and (pointer: fine)"
  - "tests/e2e/servers-list.spec.ts: three @rowmenu real-browser tests for keyboard roving focus, aria-expanded, and touch visibility"
affects: ["08-08", "08-12", "08-20"]

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "Close-source tracking is a separate primitive (useCloseSource) from the menu hook (useFloatingMenu) that consumes it, so Sheet/Dialog (externally controlled via open/onOpenChange) and RowMenu/AccountMenu (internally stateful) all read the same keyboard-vs-pointer distinction without a second capture-phase listener anywhere in the codebase"
    - "Capture-phase native document listeners that only record which kind of dismissal happened, never call preventDefault/stopPropagation -- keeps Radix's own Esc-close/outside-click-close/focus-return semantics completely untouched and never trips the pre-existing onEscapeKeyDown/onInteractOutside zero-occurrence gate"
    - "Touch-visibility fix expressed as a Tailwind arbitrary media-query variant ([@media(hover:hover)_and_(pointer:fine)]:opacity-0...) rather than a new stylesheet -- the opacity-0 default and its hover/focus-within reveals only apply where the device genuinely supports hover; focus-visible stays unconditional since keyboard focus is never gated behind a pointer capability"
    - "E2E tests that select a real RowMenu item and the item's onSelect opens a follow-up overlay (Sheet/confirm dialog) assert the hand-off to that overlay, not a return-to-trigger focus assertion -- the trigger becomes aria-hidden once a modal Dialog/Sheet opens over it, so 'focus returns to the trigger' is only the true production end state for a close path with no follow-up action (Escape), and that is what actually gets asserted"

key-files:
  created:
    - packages/ui/src/use-close-source.ts
    - packages/ui/src/use-close-source.test.tsx
    - packages/ui/src/use-floating-menu.ts
    - packages/ui/src/use-floating-menu.test.tsx
  modified:
    - packages/ui/src/RowMenu.tsx
    - packages/ui/src/RowMenu.test.tsx
    - tests/e2e/servers-list.spec.ts

key-decisions:
  - "The E2E keyboard test does not assert 'focus returns to the trigger' after activating a real menu item (Edit or Delete) -- both real ServerRow handlers open a follow-up overlay (the edit Sheet or the destructive delete confirmation dialog) in the same commit as the RowMenu close, and Radix's modal Dialog/Sheet applies aria-hidden to the rest of the page while open, making the trigger unreachable by role/name for the remainder of the test. The close+focus-return contract in isolation (no follow-up action) is already proven at the component level in RowMenu.test.tsx (a no-op mock onSelect); the E2E keyboard test instead proves the full real-browser chain -- real Tab-focus, real ArrowDown/ArrowUp roving focus, real Enter activation -- ends with the RowMenu closed and the real edit sheet visible, which is the actual, correct, observable production behaviour. The aria-expanded E2E test separately proves real focus genuinely returns to the trigger after Escape, the one close path with nowhere else for focus to go."
  - "use-floating-menu.ts's own preventDefault/stopPropagation count is 2 (handleContentKeyDown's single, consolidated arrow-key preventDefault plus handleOpenAutoFocus's preventDefault, both real, both necessary), not the 1 the plan's own acceptance criteria stated. handleOpenAutoFocus must call preventDefault to override Radix's default autofocus target and deterministically focus the first menu item -- there is no way to drop it without either weakening that guarantee or resorting to an obfuscated helper name purely to game a grep count, which was rejected as dishonest. Every other acceptance criterion in Task 1 (useState=0, addEventListener=0, useCloseSource>=1, no onEscapeKeyDown/onInteractOutside, no barrel export) is satisfied exactly."
  - "UI-04 and UI-05 (this plan's frontmatter requirements) are NOT marked complete in REQUIREMENTS.md. UI-04's screen-reader-announces-open/closed clause is explicitly a G2 human-verification item per 08-UI-SPEC.md SS6.3, not yet performed. UI-05's press-feedback/easing-table/no-keyboard-animation clauses are a separate motion-contract plan's scope -- this plan only delivers the keyboard-vs-pointer close-source primitive P14 needs as groundwork, with no exit-animation or press-feedback code added anywhere yet."

patterns-established:
  - "Shared floating-menu primitive pattern: any future overlay needing open state + roving focus + close-on-select + close-source tracking composes useFloatingMenu; any future overlay that owns its open state externally (controlled) composes useCloseSource directly, as Sheet/Dialog will in 08-12/08-20"

requirements-completed: []

# Metrics
duration: ~40min
completed: 2026-09-26
---

# Phase 8 Plan 4: RowMenu fixes and the shared floating-menu/close-source primitives Summary

**`use-close-source.ts` and `use-floating-menu.ts` now exist as the one keyboard-vs-pointer close-source tracker and the one floating-menu shell in the codebase; `RowMenu` is rebuilt on both, fixing close-on-select, `aria-expanded`, duplicate-label key collisions and touch visibility, with three new real-browser Playwright tests proving what jsdom could not.**

## Performance

- **Duration:** ~40 min
- **Completed:** 2026-09-26
- **Tasks:** 3
- **Files modified:** 7 (4 created, 3 modified)

## Accomplishments

- `packages/ui/src/use-close-source.ts`: the single keyboard/pointer/programmatic close-source primitive in the codebase, taking `open` as a plain argument so both an internally-stateful menu (`useFloatingMenu`) and a future externally-controlled overlay (`Sheet`/`Dialog`) can consume it unchanged. Two capture-phase `document` listeners record the dismissal kind without ever calling `preventDefault`/`stopPropagation`, keeping Radix's own Esc-close/outside-click-close/focus-return semantics untouched and the pre-existing `onEscapeKeyDown`/`onInteractOutside` zero-occurrence gate at `count=0`.
- `packages/ui/src/use-floating-menu.ts`: the shared floating-menu hook `RowMenu` now builds on and `AccountMenu` (08-08) will build on too -- owns open state, arrow-key roving focus (lifted from `RowMenu`'s prior implementation) and close-on-select, delegating close-source tracking to `useCloseSource` rather than duplicating it.
- `packages/ui/src/RowMenu.tsx`: three targeted fixes plus the hover-gate. Selecting an item now closes the menu and returns focus to the trigger (previously it never closed); `aria-expanded={open}` sits alongside `aria-haspopup="menu"` on the trigger; items are keyed by `item.id ?? index` instead of `item.label`, so two identically-labelled items ("Restart", "Restart") render as distinct elements and each fires only its own handler; the trigger's hover-only reveal is now gated behind `[@media(hover:hover)_and_(pointer:fine)]:`, so it stays fully opaque (and therefore reachable) on touch devices, which can never trigger `:hover` in the first place.
- `tests/e2e/servers-list.spec.ts` gained three `@rowmenu` tests against the real stack: a keyboard-only open/roving-focus/activate flow that ends with the RowMenu closed and the real edit sheet open; `aria-expanded` flipping `true`/`false` across open/Escape-close with real focus returning to the trigger; and a dedicated touch-emulated browser context (`hasTouch`/`isMobile`, no hover performed) asserting the trigger resolves `opacity: 1` -- deliberately using `toHaveCSS`, not `toBeVisible`, since Playwright's own actionability model considers an `opacity: 0` element visible and would never have caught the original bug.

## Task Commits

Each task was committed atomically (TDD tasks got separate RED/GREEN commits); one additional lint-fix commit was needed between Task 1 and Task 2 (see Issues Encountered).

1. **Task 1: The close-source primitive and the shared floating-menu hook**
   - `6b54f5b` (test) -- failing tests for both new hooks
   - `2f07401` (feat) -- `use-close-source.ts` and `use-floating-menu.ts` implemented
   - `dce14ec` (test, lint-fix) -- satisfy `no-confusing-void-expression` in both hook test harnesses
2. **Task 2: Fix RowMenu on the shared hook**
   - `d9d0097` (test) -- failing RowMenu cases: close-on-select+focus-return, `aria-expanded`, duplicate labels
   - `d0de542` (fix) -- RowMenu rebuilt on `useFloatingMenu`, `aria-expanded`, id-based keys, touch-visibility gate
3. **Task 3: E2E coverage for the real focus and touch behaviour**
   - `77c5ad8` (test) -- three `@rowmenu` Playwright tests against the real stack

_No plan-metadata commit yet -- this SUMMARY.md and the STATE/ROADMAP updates are committed separately, per the executor's final-commit step._

## Files Created/Modified

- `packages/ui/src/use-close-source.ts` - `CloseSource` union + `useCloseSource(open, contentRef)`, capture-phase keydown/pointerdown tracking
- `packages/ui/src/use-close-source.test.tsx` - controlled/uncontrolled parity, keyboard/pointer/programmatic readings, reset-on-reopen, listener lifecycle
- `packages/ui/src/use-floating-menu.ts` - `useFloatingMenu()`: open state, roving focus, `selectItem`, delegated `closeSource`
- `packages/ui/src/use-floating-menu.test.tsx` - roving focus (ArrowDown/Up wrap, Home/End), `selectItem`, delegated close-source integration cases
- `packages/ui/src/RowMenu.tsx` - rebuilt on `useFloatingMenu`; `aria-expanded`; `id`-based keys; touch-visibility media-query gate
- `packages/ui/src/RowMenu.test.tsx` - three new cases: close-on-select+focus-return, `aria-expanded`, duplicate labels
- `tests/e2e/servers-list.spec.ts` - three `@rowmenu` real-browser tests

## Decisions Made

See `key-decisions` in the frontmatter above for the full rationale on: (1) why the E2E keyboard test asserts a hand-off to the real edit sheet rather than a return-to-trigger focus check, (2) the `preventDefault`/`stopPropagation` count discrepancy in `use-floating-menu.ts`, and (3) why UI-04/UI-05 are not marked complete.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 3 - Blocking] `no-confusing-void-expression` ESLint errors in both new hook test harnesses**
- **Found during:** running `pnpm lint` after Task 1's GREEN commit
- **Issue:** Four `onClick={() => someSetter(value)}` arrow-function shorthands in `use-close-source.test.tsx`/`use-floating-menu.test.tsx` implicitly return a void expression, which this repo's `@typescript-eslint/no-confusing-void-expression` rule forbids.
- **Fix:** Wrapped each handler body in braces (`onClick={() => { someSetter(value); }}`).
- **Files modified:** `packages/ui/src/use-close-source.test.tsx`, `packages/ui/src/use-floating-menu.test.tsx`
- **Verification:** `pnpm --filter @noodara/ui lint` exits 0; both test files still pass (17/17).
- **Committed in:** `dce14ec`

**2. [Rule 1 - Bug] Test harness contamination: reading `closeSource()` via a real `userEvent.click` corrupted the very value being read**
- **Found during:** Task 1, writing `use-close-source.test.tsx`'s "resets on re-open" case
- **Issue:** The "Read" button that surfaces `closeSource()` for assertions lives outside the content element (it must stay reachable after content unmounts on close). `userEvent.click` dispatches a real `pointerdown` as part of a realistic click gesture; while the menu was open, that `pointerdown` on an element outside content was itself indistinguishable from a genuine outside-pointer dismissal, so clicking "Read" while re-opened silently overwrote the `'programmatic'` reading with `'pointer'` before the assertion ran.
- **Fix:** Read via plain `fireEvent.click` (a synthetic `click` event only, no `pointerdown`) for every "Read" interaction, keeping `userEvent` for the actual interactions under test.
- **Files modified:** `packages/ui/src/use-close-source.test.tsx`
- **Verification:** All 4 parametrized cases (`x2` for controlled/uncontrolled) pass; the previously-failing "resets on re-open" case now correctly reads `'programmatic'`.
- **Committed in:** `2f07401` (fixed before the first commit of this test file existed)

**3. [Rule 1 - Bug] The E2E keyboard test's literal "Enter on Edit" script hit the destructive item and hid the trigger from the accessibility tree**
- **Found during:** Task 3, first real run of `pnpm test:e2e -- tests/e2e/servers-list.spec.ts --grep @rowmenu`
- **Issue:** In a real browser, Radix's own autofocus lands on the first item ("Edit") the instant the menu opens (matching `RowMenu.test.tsx`'s own component-level proof). A single `ArrowDown` from there moves to the *second* item ("Delete"), not back to "Edit" -- so the plan's literal "ArrowDown then Enter on Edit" script actually activated the destructive "Delete" item, which opens the real, separate typed-name confirmation dialog. That dialog is a modal Radix `Dialog` and applies `aria-hidden` to the rest of the page while open, so the subsequent `getByRole('button', { name: 'Actions for ...' })` lookup for the focus-return assertion failed with "element(s) not found" (not "not visible" -- genuinely removed from the accessibility tree).
- **Fix:** Added an explicit `ArrowDown` then `ArrowUp` round trip (proving real roving focus in both directions) that deterministically lands back on "Edit" before activating with `Enter`, and changed the final assertion from "focus returns to the trigger" to "the RowMenu closes and the real edit sheet becomes visible" -- the actual, correct production end state once "Edit" is selected (see key-decisions above for the full reasoning on why "returns to trigger" isn't the right assertion for an item that opens a follow-up overlay).
- **Files modified:** `tests/e2e/servers-list.spec.ts`
- **Verification:** `pnpm test:e2e -- tests/e2e/servers-list.spec.ts --grep @rowmenu` (3/3 passed) and the full `pnpm test:e2e` (107/107 passed, the prior 104 plus these 3).
- **Committed in:** `77c5ad8` (fixed before the first commit of this test file existed)

---

**Total deviations:** 3 auto-fixed (1 lint/blocking, 2 test-harness bugs found via real execution)
**Impact on plan:** None on the actual production code's correctness or the plan's stated behaviours -- all three fixes are in test code, discovered by genuinely running the tests (not assumed), and documented rather than silently smoothed over. The E2E keyboard test's final assertion is more accurate to real production behaviour than the plan's literal wording.

## Issues Encountered

- `pnpm lint` was not run immediately after Task 1's GREEN commit, so the void-expression errors it caught required a follow-up commit (`dce14ec`) rather than being folded into the GREEN commit itself. No functional impact; documented for process transparency.

## User Setup Required

None - no external service configuration required.

## Verification

- `pnpm exec vitest run packages/ui/src/RowMenu.test.tsx packages/ui/src/use-floating-menu.test.tsx packages/ui/src/use-close-source.test.tsx` -- 29/29 passing (RowMenu 12, use-floating-menu 7, use-close-source 10).
- `pnpm test` -- 2612/2612 passing, no regression.
- `pnpm test:e2e -- tests/e2e/servers-list.spec.ts --grep @rowmenu` -- 3/3 passing.
- `pnpm test:e2e` (full suite) -- 107/107 passing (104 pre-existing + 3 new `@rowmenu`).
- `pnpm check:ui-safety` -- exits 0, eleven `OK` lines, `onEscapeKeyDown|onInteractOutside` still at `count=0`.
- `pnpm lint` -- all 9 turbo tasks green.
- `pnpm typecheck` -- all 8 turbo tasks plus the four standalone `tsc --noEmit` projects (including `tests/e2e/tsconfig.json`) green.

### Acceptance-criteria greps (Task 1)

- `grep -cE "onEscapeKeyDown|onInteractOutside"` on both hook files: 0/0 (pass)
- `grep -cE "preventDefault|stopPropagation" packages/ui/src/use-close-source.ts`: 0 (pass)
- `grep -c "useState" packages/ui/src/use-close-source.ts`: 0 (pass)
- `grep -c "useCloseSource" packages/ui/src/use-floating-menu.ts`: 2 (pass, >=1)
- `grep -c "addEventListener" packages/ui/src/use-floating-menu.ts`: 0 (pass)
- `grep -cE "preventDefault|stopPropagation" packages/ui/src/use-floating-menu.ts`: 2 (plan stated 1 -- see key-decisions)
- `grep -cE "use-close-source|use-floating-menu" packages/ui/src/index.ts`: 0 (pass)

### Acceptance-criteria greps (Task 2)

- `grep -c "aria-expanded" packages/ui/src/RowMenu.tsx`: 1 (pass)
- `grep -c "key={item.label}" packages/ui/src/RowMenu.tsx`: 0 (pass)
- `grep -c "hover: hover) and (pointer: fine" packages/ui/src/RowMenu.tsx`: 1 (pass)
- `grep -cE "box-shadow|shadow-\[" packages/ui/src/RowMenu.tsx`: 0 (pass)

### Acceptance-criteria greps (Task 3)

- `grep -c "@rowmenu" tests/e2e/servers-list.spec.ts`: 4 (the doc comment plus 3 test names -- at least 3, pass)

## Rules not satisfied

None. TDD RED->GREEN was followed for Task 1 (hooks) and Task 2 (RowMenu); Task 3 is test-only coverage against already-fixed component code (no separate RED/GREEN split applies -- verified by first running the new tests, discovering and fixing the two real bugs described above, then confirming green). The pre-existing `onEscapeKeyDown`/`onInteractOutside` static gate was never touched, per the hard constraint in this plan's prompt. `pnpm typecheck`, `pnpm lint`, `pnpm test`, and `pnpm check:ui-safety` are all green. Docker Desktop was running; `pnpm test:e2e` was run for real against the genuine stack and reported honestly, including the one real failure found and fixed along the way.

## Hard Git Rules Compliance

- No `git stash` was run at any point (`git stash list` is empty).
- No `git add .`/`-A`/`-u`, `git commit -a`, `git reset --hard`, `git clean`, or blanket `git checkout --`/`git restore` was run on paths not created by this plan.
- Every commit staged explicit paths inside `noodara/code/` only; `git status --porcelain` was checked before every commit to confirm only intended files were staged. The parent monorepo's unrelated `cv-executor`/`intervuee` changes, `.DS_Store`, `docs/ui-build-prompt.md` and every other untracked path outside this plan's scope were never staged or touched.
- All six commits use Conventional Commits, English, `(08-04)` scope, no `Co-Authored-By` or AI-attribution trailer -- verified after each commit with `git log -1 --format='%(trailers)'` printing nothing.
- No push, no branch created; all work is on `main` in the local monorepo.

## Next Phase Readiness

- `useCloseSource`/`useFloatingMenu` are ready for `AccountMenu` (08-08) to build on directly, and for `Sheet`/`Dialog` (08-12/08-20) to consume `useCloseSource` alone (they own their own `open` state via props already).
- `RowMenu` needs no further changes for UI-04's structural/behavioural clauses; the screen-reader-announces clause is deferred to G2 human verification per `08-UI-SPEC.md` SS6.3, and UI-05's press-feedback/easing/no-keyboard-animation clauses belong to a later motion-contract plan.
- No blockers for the next plan in this wave.

---
*Phase: 08-redise-o-de-la-app*
*Completed: 2026-09-26*

## Self-Check: PASSED

All 8 claimed files verified present on disk (`packages/ui/src/use-close-source.ts`,
`packages/ui/src/use-close-source.test.tsx`, `packages/ui/src/use-floating-menu.ts`,
`packages/ui/src/use-floating-menu.test.tsx`, `packages/ui/src/RowMenu.tsx`,
`packages/ui/src/RowMenu.test.tsx`, `tests/e2e/servers-list.spec.ts`, this SUMMARY.md). All 6
commit hashes (`6b54f5b`, `2f07401`, `dce14ec`, `d9d0097`, `d0de542`, `77c5ad8`) verified present
in `git log --oneline --all`. No missing items.
