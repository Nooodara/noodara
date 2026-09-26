---
phase: 08-redise-o-de-la-app
plan: 20
subsystem: ui
tags: [press-feedback, motion, radix, keyboard-accessibility, ui-05, e2e]

# Dependency graph
requires:
  - phase: 08-redise-o-de-la-app
    provides: "08-04's useCloseSource/useFloatingMenu (keyboard-vs-pointer close-source tracker), 08-12's Sheet drag-to-dismiss with its own instant-close class precedent, 08-13's PRESS_CLASSES (the one shared press-feedback definition)"
provides:
  - "PRESS_CLASSES composed into RowMenu items, AccountMenu's Settings item row, and NavTree leaves/parent triggers -- no second active:scale-* definition anywhere in packages/ui/src"
  - "A keyboard-close instant-unmount branch (INSTANT_CLOSE_CLASS = '!duration-0') inside DialogShell (Dialog.tsx), RowMenu and AccountMenu, each reading closeSource directly at render time -- Dialog calls useCloseSource itself; RowMenu/AccountMenu read the same value through useFloatingMenu, never a second useCloseSource call"
  - "tests/e2e/keyboard-motion.spec.ts: an 8-test @keyboard-no-animation suite measuring wall-clock close time (not class names) across all four overlays -- Sheet's real genuine positive/negative control, plus Dialog/RowMenu/AccountMenu's current (pre-08-14) honest near-instant-both-paths truth"
affects: ["08-14"]

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "closeSource() read directly at render time (no effect+state indirection) for the keyboard-instant-close branch -- by the time a component re-renders after Radix's own Escape handling calls onOpenChange(false), the shared primitive's capture-phase keydown listener has already updated its ref for that same event, so the render-time read is already correct with no extra render pass needed. This differs from Sheet.tsx's own effect+state version (08-12) but is functionally equivalent and avoids a real effect-ordering race between this branch and Radix's Presence unmount decision."
    - "Mocking only the returned closeSource reading (vi.mock + importOriginal, overriding just that one field) to get a genuine, synchronous, jsdom-observable RED/GREEN signal for a mechanism that Radix's own Presence otherwise unmounts too fast to observe post-close -- the menu/dialog stays open throughout the assertion, sidestepping the unmount race entirely."

key-files:
  created:
    - tests/e2e/keyboard-motion.spec.ts
  modified:
    - packages/ui/src/RowMenu.tsx
    - packages/ui/src/RowMenu.test.tsx
    - packages/ui/src/AccountMenu.tsx
    - packages/ui/src/AccountMenu.test.tsx
    - packages/ui/src/NavTree.tsx
    - packages/ui/src/Dialog.tsx
    - packages/ui/src/Dialog.test.tsx

key-decisions:
  - "UI-05 is NOT marked complete. Its text has three clauses: (1) every pressable control gets scale(0.97)/160ms/--ease-out press feedback -- now true, including this plan's own RowMenu/AccountMenu/NavTree additions; (2) the brief §6 custom easing-curve/duration table replaces every built-in CSS easing 'en todo el inventario' -- NOT yet true, that replacement is 08-14's explicit scope (its own must_haves: 'no built-in easing keyword survives in packages/ui'), which has not run; (3) no keyboard-initiated action animates -- true today, but only because Dialog/RowMenu/AccountMenu have no exit animation of any kind yet (08-14 adds it) and Sheet's real animation is correctly gated. Since clause 2 does not hold repo-wide, the requirement stays Pending, exactly as the plan instructed unless every clause holds."
  - "DESTRUCTIVE_ITEM_CLASSES (RowMenu.tsx) was left untouched rather than also composing PRESS_CLASSES into it directly -- it is only ever combined with ITEM_CLASSES at the render call site (cn(ITEM_CLASSES, item.destructive && DESTRUCTIVE_ITEM_CLASSES)), so every destructive item already inherits PRESS_CLASSES through ITEM_CLASSES. Composing it a second time into DESTRUCTIVE_ITEM_CLASSES would have duplicated the same class tokens in the final className string for no behavioural difference."
  - "closeSource() is read directly at JSX render time in Dialog/RowMenu/AccountMenu (a plain synchronous function call), not behind Sheet.tsx's own useEffect+useState pair. Reasoned through explicitly: since sourceRef inside use-close-source.ts is a plain ref (not React state), and Radix's own document keydown listener plus this primitive's own capture-phase listener both fire as native, synchronous, plain-JS handlers strictly before React ever processes the batched onOpenChange(false) state update, closeSource() already returns the correct value on the very same render pass that open flips to false. Reading it directly avoids a real risk with the effect+state alternative: Radix's own Presence-driven unmount decision (a descendant, effects run child-first) could commit before an ancestor's own effect gets a chance to set instantClose, silently losing the override for a component whose real transition is added later (08-14). Direct-render reads have no such ordering dependency."
  - "Genuine jsdom RED/GREEN for the keyboard-no-animation branch was only reachable by mocking the returned closeSource function (vi.mock('./use-floating-menu.js'|'./use-close-source.js', ...), overriding only that one field, real implementation otherwise) and asserting the override class while the overlay is STILL OPEN. A DOM-query-after-close approach (matching Sheet.test.tsx's own 08-12 precedent) was tried first and abandoned: this jsdom test environment loads no compiled stylesheet, so Radix's Presence component always finds no real CSS transition to wait for and unmounts synchronously the instant `open` goes false, regardless of which class was applied -- there is no intermediate, queryable DOM state to assert against post-close in this environment, for any of the four overlays. The mock-based, still-open approach sidesteps the race entirely and is what actually produced a real, failing-then-passing RED/GREEN cycle for Task 2 (confirmed empirically: all three new mock-based assertions failed before the corresponding feat commit and passed after)."

patterns-established:
  - "The four overlays' 'no animation on keyboard close' mechanism is now uniform: a local INSTANT_CLOSE_CLASS ('!duration-0') composed conditionally via cn(...), gated on a closeSource() read that resolves to 'keyboard' at the exact render where the close is committed -- Sheet.tsx (08-12) does this behind an effect, Dialog/RowMenu/AccountMenu (this plan) do it directly at render time. 08-14, which adds Dialog/RowMenu/AccountMenu's first real exit transition, inherits this exact override mechanism unchanged -- it only needs to add a real duration-bearing utility for '!duration-0' to start visibly overriding."

requirements-completed: []

# Metrics
duration: ~27min
completed: 2026-09-26
---

# Phase 8 Plan 20: One press definition and the keyboard-no-animation branch, for the overlay and nav layer Summary

**Extended `PRESS_CLASSES` to `RowMenu`/`AccountMenu`/`NavTree`, wired a shared `closeSource`-driven keyboard-instant-close branch into `Dialog`/`RowMenu`/`AccountMenu` (mirroring `Sheet.tsx`'s own 08-12 mechanism), and added an 8-test real-browser Playwright suite (`tests/e2e/keyboard-motion.spec.ts`) measuring wall-clock close time across all four overlays.**

## Performance

- **Duration:** ~27 min
- **Started:** 2026-09-26T05:41:56-06:00 (first task commit)
- **Completed:** 2026-09-26T06:06:22-06:00
- **Tasks:** 3
- **Files modified:** 8 (1 created, 7 modified)

## Accomplishments

- `RowMenu` items, `AccountMenu`'s Settings row and `NavTree`'s leaf/parent-trigger classes all now compose the one shared `PRESS_CLASSES` constant (08-13) -- `grep -rl "active:scale" packages/ui/src` still lists only `press.ts`.
- `Dialog.tsx`'s `DialogShell` calls `useCloseSource` directly (mirroring `Sheet.tsx`'s controlled-overlay shape); `RowMenu`/`AccountMenu` read the same `closeSource` value already returned by `useFloatingMenu`, with zero direct `useCloseSource` calls of their own. No file composes `onEscapeKeyDown`/`onInteractOutside` -- `check:ui-safety`'s Radix-untouched gate stays at `count=0`.
- `tests/e2e/keyboard-motion.spec.ts`: 8 real-browser tests (`@keyboard-no-animation`) measuring wall-clock time from a close action to the overlay leaving the accessibility tree, across Sheet (real genuine positive/negative control -- 320ms `--duration-sheet` vs. near-instant Escape), Dialog, RowMenu and AccountMenu.
- Full suite health: `pnpm test` 2715/2715 (+19 over the 2696 baseline), `pnpm test:e2e` 132/132 (+8 over the 124 baseline), `pnpm lint`/`pnpm typecheck`/`pnpm check:ui-safety` all exit 0.

## Task Commits

1. **Task 1: Press on menu and nav items**
   - `c1bd146` (test) -- failing press-feedback cases in RowMenu.test.tsx/AccountMenu.test.tsx
   - `6073b3e` (feat) -- PRESS_CLASSES composed into RowMenu/AccountMenu/NavTree
2. **Task 2: Keyboard-close suppression in Dialog, RowMenu and AccountMenu**
   - `dec1a62` (test) -- failing keyboard-no-animation cases (mock-based, genuinely RED) in Dialog.test.tsx/RowMenu.test.tsx/AccountMenu.test.tsx
   - `6417451` (feat) -- closeSource-driven INSTANT_CLOSE_CLASS wired into Dialog/RowMenu/AccountMenu
3. **Task 3: Measure the keyboard-no-animation rule in a browser**
   - `7cf0519` (test) -- tests/e2e/keyboard-motion.spec.ts, 8/8 passing against the real stack

## Files Created/Modified

- `packages/ui/src/RowMenu.tsx` -- `ITEM_CLASSES` composes `PRESS_CLASSES`; content carries `INSTANT_CLOSE_CLASS` when `closeSource() === 'keyboard'`
- `packages/ui/src/AccountMenu.tsx` -- Settings-row `ITEM_CLASSES` composes `PRESS_CLASSES`; content carries the same keyboard-instant-close override
- `packages/ui/src/NavTree.tsx` -- leaf/parent-trigger `ITEM_CLASSES` composes `PRESS_CLASSES`
- `packages/ui/src/Dialog.tsx` -- `DialogShell` calls `useCloseSource` once, applies `INSTANT_CLOSE_CLASS` to the panel when the recorded close source is keyboard
- `packages/ui/src/RowMenu.test.tsx`, `packages/ui/src/AccountMenu.test.tsx`, `packages/ui/src/Dialog.test.tsx` -- new press-feedback and keyboard-no-animation RED/GREEN cases
- `tests/e2e/keyboard-motion.spec.ts` -- the 8-test `@keyboard-no-animation` real-browser suite

## Decisions Made

See `key-decisions` in frontmatter above (UI-05 not marked complete; `DESTRUCTIVE_ITEM_CLASSES` left as-is since it already inherits `PRESS_CLASSES` through `ITEM_CLASSES`; direct-render `closeSource()` reads chosen over Sheet's effect+state pattern; mock-based jsdom tests were the only way to get genuine RED/GREEN given a real jsdom/Presence limitation).

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] `readFileSync(new URL(...), ...)` throws "URL must be of scheme file" inside the `dom` Vitest project**
- **Found during:** Task 2, an initial attempt at a source-contract RED test in Dialog.test.tsx/RowMenu.test.tsx/AccountMenu.test.tsx
- **Issue:** These three files run under Vitest's `dom` project (jsdom environment, `packages/ui/src/**/*.test.tsx`). Node's `fs.readFileSync` rejects the `URL` instance jsdom's environment produces even though its own `.href` correctly reports a `file://` scheme -- confirmed empirically with a throwaway debug test file (not committed) isolating the exact failure to the `dom` project only; the identical pattern works fine in `.test.ts` files (the `packages`/`node` project, e.g. `contrast.test.ts`).
- **Fix:** Abandoned the source-scanning technique entirely for these three files (it isn't viable in this environment) and replaced it with the mock-based `closeSource`-override technique described in `key-decisions` above, which is both environment-safe and produces a stronger, genuinely synchronous RED/GREEN signal.
- **Files modified:** packages/ui/src/Dialog.test.tsx, packages/ui/src/RowMenu.test.tsx, packages/ui/src/AccountMenu.test.tsx (iterated within Task 2, before the final `dec1a62` test commit -- no separate commit exists for the abandoned attempt, it was never committed)
- **Verification:** `pnpm exec vitest run packages/ui/src/Dialog.test.tsx packages/ui/src/RowMenu.test.tsx packages/ui/src/AccountMenu.test.tsx` -- all pass with the mock-based approach
- **Committed in:** `dec1a62` (the working, final version)

**2. [Rule 1 - Bug] Doc comments mentioning "useCloseSource"/"active:scale" as plain prose tripped the acceptance criteria's own literal grep**
- **Found during:** Task 1 and Task 2, running the plan's own acceptance-criteria greps after implementing
- **Issue:** Explanatory comments in RowMenu.test.tsx/AccountMenu.test.tsx (Task 1) mentioned "active:scale-* literal" in prose, and RowMenu.tsx/AccountMenu.tsx (Task 2) mentioned "useCloseSource" in a doc comment explaining why the file does NOT call it directly -- both accidentally satisfied the very grep pattern they were disclaiming, since `grep -rl`/`grep -c` match raw text, not code semantics.
- **Fix:** Reworded both sets of comments to avoid the literal substrings ("press-scale literal" instead of "active:scale-* literal"; "the shared close-source primitive" instead of naming `useCloseSource` in RowMenu.tsx/AccountMenu.tsx) while preserving the same explanation.
- **Files modified:** packages/ui/src/RowMenu.test.tsx, packages/ui/src/AccountMenu.test.tsx, packages/ui/src/RowMenu.tsx, packages/ui/src/AccountMenu.tsx
- **Verification:** `grep -rl "active:scale" packages/ui/src` lists only `press.ts`; `grep -c "useCloseSource" packages/ui/src/RowMenu.tsx packages/ui/src/AccountMenu.tsx` both return 0
- **Committed in:** `6073b3e` (Task 1) and `6417451` (Task 2) -- folded into each task's own feat commit, not separate fixup commits

None of Rules 2/3/4 applied otherwise. No architectural changes were needed, no auth gates were hit, and no package installs occurred.

---

**Total deviations:** 2 auto-fixed (both Rule 1 -- bugs found and fixed while verifying the plan's own acceptance criteria, before any commit)
**Impact on plan:** Neither changed scope. The first replaced an unworkable test technique with a stronger one before ever being committed; the second was a same-commit wording fix caught by the plan's own acceptance-criteria greps before committing.

## Issues Encountered

- Extensive analysis was required to determine what a jsdom-honest RED/GREEN test for the keyboard-no-animation branch could actually assert, given that Radix's Presence component unmounts synchronously in this test environment (no compiled stylesheet is loaded for it to detect a real CSS transition on) regardless of which class is applied -- meaning a DOM-query-after-close approach (the pattern `Sheet.test.tsx`, 08-12, already established) cannot produce a real RED test for this exact mechanism. Resolved by mocking only the returned `closeSource` value and asserting the override class while the overlay stays open throughout, sidestepping the unmount race.
- Task 3's E2E spec surfaced a structural fact worth flagging clearly (see "Rules Not Satisfied" below): only `Sheet` has a real exit transition today, so the "still animates when closed by pointer" positive-control behavior named in the plan's own Task 3 `<behavior>` section is not yet meaningfully true for `Dialog`/`RowMenu`/`AccountMenu` -- their real transition is 08-14's scope, and 08-14's own frontmatter (`depends_on: ["08-13", "08-20"]`) confirms it is scheduled to run after this plan, not before.

## Rules Not Satisfied

**Task 3's `<behavior>` bullet "Each of the four still animates when closed by pointer, which is the positive control" is only true for Sheet.** `Dialog`, `RowMenu` and `AccountMenu` have no exit transition of any kind yet (their close is instant via both the keyboard and pointer paths) -- adding one is explicitly 08-14's scope (its own `must_haves`: "every duration and easing in the §7.2 table replaces a CSS built-in"), and 08-14 depends on this very plan (08-20) landing first, per its own frontmatter `depends_on`. `tests/e2e/keyboard-motion.spec.ts`'s Dialog/RowMenu/AccountMenu tests therefore measure the current, honest truth (both paths close near-instantly, well under 150ms) rather than a genuine positive/negative control; each test's own name and the suite's header comment say so explicitly, and each `describe` block is titled "pre-08-14: no real transition to gate yet" so a future reader isn't misled. The underlying mechanism (`closeSource`-gated `INSTANT_CLOSE_CLASS`) that 08-14 needs is fully built and tested here; only the "raise this threshold once a real transition exists" follow-up remains, explicitly called out in the spec's own header comment for whoever executes 08-14.

Every other rule in `<project_rules>` was satisfied:
- TDD RED-then-GREEN for every `type="auto" tdd="true"` task (Task 1: `c1bd146` before `6073b3e`; Task 2: `dec1a62` before `6417451`, with genuine mock-based RED confirmed empirically before implementing)
- `PRESS_CLASSES` (08-13) consumed everywhere, never redeclared; `press.ts` untouched (`git diff --name-only -- packages/ui/src/press.ts` empty)
- The keyboard branch lives inside each component (`Dialog`/`RowMenu`/`AccountMenu`), reading `use-close-source.ts`'s shared primitive; no `onEscapeKeyDown`/`onInteractOutside` added anywhere; `use-close-source.ts`/`use-floating-menu.ts` both untouched (`git diff --name-only` empty for both)
- Shadow allowlist and backdrop-filter budget (3/3) stay green; only `--ease-*`/`--duration-*` tokens and Tailwind's own `!duration-0` important-modifier override are used, no literals, no built-in easing keywords introduced
- Docker Desktop was running; `tests/e2e/keyboard-motion.spec.ts` ran for real (8/8), the full `pnpm test:e2e` suite ran for real (132/132, up from 124 baseline), `pnpm lint`, `pnpm typecheck`, `pnpm test` (2715, up from 2696 baseline) and `pnpm check:ui-safety` all exit 0
- The pre-existing Sheet-Esc-focus-return gap from `deferred-items.md` was not touched -- out of this plan's own file scope (`Sheet.tsx` is read-only for this plan per its own `<files>` list) and not naturally covered by this plan's own new E2E cases

## User Setup Required

None -- no external service configuration required.

## Next Phase Readiness

- The `closeSource`-gated `INSTANT_CLOSE_CLASS` mechanism is fully built and tested in `Dialog`/`RowMenu`/`AccountMenu`; 08-14 (UI-07, wave 11) can add their real scale-from-trigger exit transitions directly on top of it with no further plumbing.
- `tests/e2e/keyboard-motion.spec.ts`'s Dialog/RowMenu/AccountMenu tests will need their `INSTANT_CLOSE_CEILING_MS` comparison strengthened into a genuine two-sided positive/negative control (matching the Sheet pair already in this file) once 08-14 lands a real, non-zero transition duration for those three overlays -- flagged explicitly in the spec's own header comment.
- UI-05 remains `Pending` in REQUIREMENTS.md, correctly, until 08-14's easing/duration-table replacement lands.

## Hard Git Rules Compliance

- No `git stash`, `git add .`/`-A`/`-u`, `git commit -a`, `git reset --hard`, `git clean`, blanket `git checkout --`/`git restore`, or `rm -rf` on tracked directories was run at any point.
- Every commit staged explicit file paths inside `noodara/code/` only; nothing under `docs/ui/review/`, `docs/ui-build-prompt.md` or `.DS_Store` was ever staged.
- All five commits use Conventional Commits format, English, scope `(08-20)`, subject <=72 chars; `git log -1 --format='%(trailers)'` printed nothing after every single commit -- no `Co-Authored-By` or any attribution trailer anywhere.
- No push was performed; branch stayed on `main` throughout.

## Self-Check

- `[ -f packages/ui/src/RowMenu.tsx ]`, `AccountMenu.tsx`, `NavTree.tsx`, `Dialog.tsx`, `tests/e2e/keyboard-motion.spec.ts` -> all FOUND
- Commit `c1bd146` -> FOUND in `git log --oneline --all`
- Commit `6073b3e` -> FOUND
- Commit `dec1a62` -> FOUND
- Commit `6417451` -> FOUND
- Commit `7cf0519` -> FOUND

## Self-Check: PASSED

---
*Phase: 08-redise-o-de-la-app*
*Completed: 2026-09-26*
