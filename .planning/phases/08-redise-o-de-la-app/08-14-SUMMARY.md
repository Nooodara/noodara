---
phase: 08-redise-o-de-la-app
plan: 14
subsystem: ui
tags: [motion, transform-origin, grid-template-rows, tooltip, easing-tokens, ui-05, ui-07]

# Dependency graph
requires:
  - phase: 08-redise-o-de-la-app
    provides: "08-13's PRESS_CLASSES (the one shared press-feedback definition), 08-20's closeSource-gated INSTANT_CLOSE_CLASS mechanism in Dialog/RowMenu/AccountMenu (this plan's new entry/exit transitions sit inside that same override, never replacing it)"
provides:
  - "RowMenu/AccountMenu content grows from its own trigger corner (a --transform-origin custom property set inline on the content element itself); Tooltip grows from Radix's own Popper-provided --radix-tooltip-content-transform-origin; Dialog grows from centre -- all at the §7.2-table values (150ms/200ms/125ms var(--ease-out))"
  - "Disclosure.tsx's grid-template-rows technique now has real 0fr/1fr tracks to interpolate (DISCLOSURE_CONTENT_CLASSES/DISCLOSURE_INNER_CLASSES, both exported), with NavTree.tsx's identical parent-item disclosure reusing the same exported constants instead of a near-copy"
  - "Tooltip.tsx's provider now sets an explicit, documented default skipDelayDuration (300ms, Radix's own built-in default made an owned decision) instead of leaving it an unstated library default; still overridable by any caller"
  - "StatusPill's tone change transitions color and background-color explicitly, 150ms var(--ease-out), never a catch-all transition"
  - "scripts/check-ui-safety.mjs gained a machine-checked gate (scanBuiltinEasingUsage, its own RED-then-GREEN unit suite in tests/unit/scripts/check-ui-safety.test.ts) that fails the build if any bare CSS built-in easing keyword (ease-in/ease-out/ease-in-out/linear) survives in packages/ui outside a var(--ease-*) token reference -- scoped to packages/ui (including its own test files), tokens.css excluded by exact path since it is where the tokens themselves are declared"
affects: ["08-16", "08-18"]

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "Origin anchoring splits on whether the primitive is Popper-based: Tooltip reads Radix's own --radix-tooltip-content-transform-origin (Popper computes and exposes it); RowMenu/AccountMenu (built on non-modal Dialog, no Popper underneath) instead set a plain --transform-origin custom property inline on the content element from inside the component, derived from the fixed structural fact of each menu's own absolute positioning (RowMenu's `right-0 top-full` always anchors its top-right corner to the trigger; AccountMenu's `bottom-full left-0` anchors its bottom-left corner) -- never guessed at a call site"
    - "Entry/exit transitions on RowMenu/AccountMenu/Dialog reuse the exact data-[state=open]/data-[state=closed] idiom Sheet.tsx (08-12) already established, composed alongside (never replacing) the existing closeSource-gated INSTANT_CLOSE_CLASS override from 08-20 -- Tailwind's !duration-0 important-modifier still wins the keyboard-close path regardless of the new un-flagged duration utility"
    - "Disclosure/NavTree share one exported class-string pair (DISCLOSURE_CONTENT_CLASSES, DISCLOSURE_INNER_CLASSES) instead of each keeping its own near-identical copy of the grid-template-rows technique"
    - "check-ui-safety.mjs's scan functions stay disk-free and individually unit-testable (scanBuiltinEasingUsage joins scanShadowUsage/scanBackdropFilterUsage in that shape), wired into the real gate list via a thin readFileContents bridge"

key-files:
  created: []
  modified:
    - packages/ui/src/RowMenu.tsx
    - packages/ui/src/RowMenu.test.tsx
    - packages/ui/src/AccountMenu.tsx
    - packages/ui/src/AccountMenu.test.tsx
    - packages/ui/src/Dialog.tsx
    - packages/ui/src/Dialog.test.tsx
    - packages/ui/src/Tooltip.tsx
    - packages/ui/src/Tooltip.test.tsx
    - packages/ui/src/Disclosure.tsx
    - packages/ui/src/Disclosure.test.tsx
    - packages/ui/src/NavTree.tsx
    - packages/ui/src/StatusPill.tsx
    - packages/ui/src/StatusPill.test.tsx
    - packages/ui/src/press.test.ts
    - scripts/check-ui-safety.mjs
    - tests/unit/scripts/check-ui-safety.test.ts

key-decisions:
  - "UI-05 is now marked complete: all three of its clauses hold repo-wide -- (1) press feedback, already true since 08-13/08-20; (2) the §6/§7.2 duration/easing table replaces every CSS built-in easing keyword in packages/ui, now true and machine-enforced by the new check:ui-safety gate (0 violations, verified by full-repo grep and the real gate run); (3) no keyboard-initiated action animates, preserved unchanged since this plan's new transitions all sit alongside, never inside, 08-20's closeSource-gated INSTANT_CLOSE_CLASS override."
  - "UI-07 stays Pending. Four of its five clauses now hold (toolbar scroll-edge -- pre-existing from 08-09; RowMenu/Tooltip/AccountMenu origin-anchored to trigger; Dialog centred; Disclosure on grid-template-rows), but its fifth clause (\"discovery checks and list rows enter with 40ms stagger\") is explicitly out of this plan's scope -- 08-16/08-18 own it per this plan's own project rules. Marking UI-07 complete now would misrepresent a requirement whose text is only 80% true."
  - "The built-in-easing sweep surfaced a pre-existing false-positive risk in the plan's own acceptance grep: six test files (this plan's own new prose plus one pre-existing line in press.test.ts) described transitions using literal prose like \"150ms --ease-out\", which itself matches a bare `ease-out` keyword under a naive `\\bease-out\\b` scan (the `--` prefix is a non-word boundary). Reworded every such mention to `var(--ease-out)` form (matching how the code itself actually references the token), which both reads correctly and is excluded by the gate's own token-stripping step. This is the same class of self-inflicted-grep issue 08-20 already documented for `active:scale`/`useCloseSource` prose."
  - "Radix's own CollapsibleContentImpl (verified directly from @radix-ui/react-collapsible's source) deliberately suppresses the CSS transition on the very render where content first mounts (isMountAnimationPreventedRef), restoring it only on the following close -- meaning Disclosure/NavTree's new grid-template-rows technique reliably animates the CLOSE (content stays mounted, data-state genuinely flips while present) but the very first OPEN of a given mount cycle paints directly at the final 1fr state with no interpolation. This is a real, verified limitation of the primitive itself, not a bug in this plan's classes; working around it would require `forceMount` (keeping content permanently in the DOM), which breaks the phase's own existing, tested \"absent from the document until opened\" contract (05-16/05-21) -- out of scope to trade away here. Documented for whichever future plan next revisits Disclosure's own mount lifecycle."
  - "RowMenu/AccountMenu/Dialog's new data-state-based entry+exit transitions follow Sheet.tsx's own established idiom exactly, but Radix Dialog Content -- like Collapsible -- mounts fresh each time `open` flips from false to true (Presence unmounts entirely while closed), so the same first-open, no-interpolation-frame caveat that applies to Collapsible plausibly also applies to these three primitives' very first open of a given mount. The genuine exit transition (content stays mounted through the close, data-state flips while present) is unaffected. This is an inherited property of Radix's own Presence-based mount/unmount model, shared with Sheet.tsx's identical existing technique (08-12) -- not something this plan introduces or can fix without adopting a different primitive shape (Rule 4 territory, not exercised here); flagged for G3's live visual review to judge in a real browser rather than asserted by a jsdom test, which cannot observe rendered CSS transitions at all."

patterns-established:
  - "A component built on Radix's non-modal Dialog (no Popper) sets its own --transform-origin custom property inline, derived from its own fixed positioning classes, rather than guessing a static Tailwind origin-* utility -- keeps the actual value and its justification co-located in one place per component."

requirements-completed: [UI-05]

# Metrics
duration: ~70min
completed: 2026-09-26
---

# Phase 8 Plan 14: Origin anchoring, grid-template-rows Disclosure, and the built-in-easing sweep Summary

**RowMenu/AccountMenu/Tooltip now grow visibly from their own trigger corner (Dialog from centre) at the brief's §7.2 timing values, Disclosure's grid-template-rows technique gained real 0fr/1fr tracks to interpolate, Tooltip's repeat-hover skip-delay is now an explicit owned default, StatusPill's state change transitions colour/background explicitly, and a new machine-checked `check:ui-safety` gate now fails the build if any bare CSS built-in easing keyword ever reappears in `packages/ui` outside a `var(--ease-*)` token reference.**

## Performance

- **Duration:** ~70 min
- **Tasks:** 3
- **Files modified:** 16 (0 created, 16 modified)

## Accomplishments

- Task 1: RowMenu/AccountMenu content carries a `--transform-origin` custom property set inline from inside each component (never a call site), at `scale(0.97)`+opacity, 150ms `var(--ease-out)`; Tooltip reads Radix's own `--radix-tooltip-content-transform-origin` Popper variable at 125ms; Dialog opens from `scale(0.95)`+opacity at 200ms, origin centre (the stated exception, never trigger-anchored).
- Task 2: `Disclosure.tsx`'s `CollapsiblePrimitive.Content` now declares real `grid-rows-[0fr]`/`grid-rows-[1fr]` tracks (exported as `DISCLOSURE_CONTENT_CLASSES`/`DISCLOSURE_INNER_CLASSES`) with an inner `min-h-0 overflow-hidden` wrapper that actually clips the fractional track; `NavTree.tsx`'s identical parent-item disclosure now imports and reuses those same two constants instead of keeping its own near-copy. `Tooltip.tsx`'s provider wrapper now defaults `skipDelayDuration` to an explicit, documented 300ms (Radix's own built-in default, made an owned decision rather than an implicit one) while still letting any caller override it.
- Task 3: `StatusPill`'s tone-driven background/text classes now transition `color`/`background-color` explicitly at 150ms `var(--ease-out)`, never a catch-all transition. The built-in-easing sweep found zero remaining violations in `packages/ui/src` (full-repo grep confirmed), but surfaced and fixed a self-inflicted false-positive class across six test files whose own descriptive prose (`"150ms --ease-out"`) tripped the very pattern it was describing -- reworded to the `var(--ease-out)` form everywhere. A new `scanBuiltinEasingUsage` gate (RED-then-GREEN, its own unit suite) was added to `scripts/check-ui-safety.mjs` so this class of regression is now caught mechanically, not just by convention.
- Full verification: `pnpm test` 2731/2731 (+16 over the 2715 baseline), `pnpm test:e2e` 132/132 (unchanged baseline, all passing for real against Docker, including `keyboard-motion.spec.ts`'s 8 tests and `a11y-fallbacks.spec.ts`'s 4 tests), `pnpm lint`/`pnpm typecheck`/`pnpm check:ui-safety` all exit 0 (12 gates now, up from 11).

## Task Commits

1. **Task 1: Origin anchoring and the open/close transitions**
   - `05b3d9b` (test) -- failing origin-anchoring/transition cases for RowMenu, AccountMenu, Dialog, Tooltip
   - `991559d` (feat) -- anchor RowMenu/AccountMenu/Tooltip origin to trigger, Dialog to centre
2. **Task 2: Disclosure on grid-template-rows and the instant repeat tooltip**
   - `d047ced` (test) -- failing grid-template-rows and skipDelayDuration cases
   - `cd14031` (feat) -- grid-template-rows Disclosure and default Tooltip skipDelayDuration
3. **Task 3: StatusPill state transition and the built-in easing sweep**
   - `aca9dc6` (test) -- failing StatusPill transition and built-in easing sweep gate cases
   - `7184d47` (feat) -- machine-checked built-in-easing gate added to check:ui-safety (bundled with the six test-file wording fixes it required, per the same rationale as 08-20's own bundled wording-fix precedent)
   - `d720bd9` (feat) -- StatusPill color/background-color transition

**Plan metadata:** committed separately below.

## Files Created/Modified

- `packages/ui/src/RowMenu.tsx` -- `CONTENT_CLASSES` gains origin-anchoring + entry/exit transition classes; a `CONTENT_TRANSFORM_ORIGIN_STYLE` inline style sets `--transform-origin: top right`
- `packages/ui/src/AccountMenu.tsx` -- same treatment, `--transform-origin: bottom left`
- `packages/ui/src/Dialog.tsx` -- `PANEL_CLASSES` gains `origin-center` + entry/exit transition classes
- `packages/ui/src/Tooltip.tsx` -- `CONTENT_CLASSES` gains Popper-origin + opacity transition; `TooltipProvider` becomes a thin wrapper defaulting `skipDelayDuration`
- `packages/ui/src/Disclosure.tsx` -- exports `DISCLOSURE_CONTENT_CLASSES`/`DISCLOSURE_INNER_CLASSES`; content wrapped in the new inner clipping div
- `packages/ui/src/NavTree.tsx` -- reuses the two exported Disclosure constants instead of a near-copy
- `packages/ui/src/StatusPill.tsx` -- pill root gains an explicit `color`/`background-color` transition
- `scripts/check-ui-safety.mjs` -- new `scanBuiltinEasingUsage` export + gate wired into the real gate list
- `tests/unit/scripts/check-ui-safety.test.ts` -- RED-then-GREEN unit suite for the new scan function
- `packages/ui/src/{RowMenu,AccountMenu,Dialog,Tooltip,StatusPill}.test.tsx`, `packages/ui/src/press.test.ts` -- new assertions plus the six wording fixes described above

## Decisions Made

See `key-decisions` in frontmatter above. In short: UI-05 marked complete (all three clauses hold, machine-enforced); UI-07 stays Pending (its stagger clause belongs to 08-16/08-18); the plan's own acceptance-grep pattern is genuinely ambiguous about literal `--ease-out` prose vs. a real bare keyword, fixed the same way 08-20 fixed its own analogous `active:scale`/`useCloseSource` prose collision; Radix's Collapsible/Dialog primitives both deliberately suppress the CSS transition on a fresh mount (verified from source), so the real, observable animation this plan adds is the CLOSE path (content stays mounted through it) -- the very first OPEN of a mount cycle paints directly at rest, a limitation of the primitives themselves that `forceMount` could work around only by breaking the phase's own existing "absent until opened" contract, which is out of this plan's scope to trade away.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] Six test files' own descriptive prose tripped the new built-in-easing gate**
- **Found during:** Task 3, running the new `scanBuiltinEasingUsage` gate against the real repo for the first time.
- **Issue:** `AccountMenu.test.tsx`, `Dialog.test.tsx`, `RowMenu.test.tsx`, `StatusPill.test.tsx`, `Tooltip.test.tsx` (this plan's own new test descriptions) and `press.test.ts` (pre-existing, from 08-13) all described a transition using the literal phrase `"...ms --ease-out"` -- a `\bease-out\b` boundary match against `--ease-out` succeeds because `-` is a non-word character, so this is indistinguishable from a real bare Tailwind `ease-out` utility to a naive scan, exactly the same self-inflicted-grep class 08-20 already documented for `active:scale`/`useCloseSource` prose.
- **Fix:** Reworded every occurrence to the `var(--ease-out)` form (e.g. `"at 150ms via var(--ease-out)"`), which both reads correctly and is excluded by the gate's own token-stripping step (`VAR_EASE_TOKEN_PATTERN`).
- **Files modified:** `packages/ui/src/AccountMenu.test.tsx`, `packages/ui/src/Dialog.test.tsx`, `packages/ui/src/RowMenu.test.tsx`, `packages/ui/src/StatusPill.test.tsx` (two occurrences), `packages/ui/src/Tooltip.test.tsx`, `packages/ui/src/press.test.ts`.
- **Verification:** `pnpm check:ui-safety` exits 0; `grep -rnE "ease-(in|out|in-out|linear)\b" packages/ui/src --include=*.tsx --include=*.ts | grep -v "var(--ease" | wc -l` returns 0.
- **Committed in:** `7184d47` (bundled with the gate's own feat commit, same rationale as 08-20's bundled wording fixes -- these are same-commit prose corrections caught by the plan's own acceptance criteria before committing, not a separate defect).

None of Rules 2/3/4 applied otherwise. No architectural changes were needed, no auth gates were hit, and no package installs occurred.

## Rules Not Satisfied

None of this plan's own stated behaviors or acceptance criteria are unsatisfied. Two honest, verified limitations are documented above as decisions rather than unmet rules, since neither is something this plan's own scope could fix: (1) Radix's Collapsible/Dialog primitives both suppress the CSS transition on a fresh mount, so the very first OPEN of a mount cycle does not visibly interpolate (only the CLOSE does) -- a property of the primitives themselves, not these classes; (2) UI-07's stagger clause is explicitly out of this plan's scope per the plan's own project rules, so UI-07 correctly stays Pending rather than being marked complete on a partial truth.

## Issues Encountered

- Investigated Radix's own `@radix-ui/react-collapsible` and `@radix-ui/react-dialog` source directly (not assumed) to understand exactly when a CSS transition can and cannot play across their Presence-driven mount/unmount cycle, since jsdom cannot observe a rendered transition at all and the plan's own component tests are necessarily class-presence assertions, not visual proof. Findings are captured in `key-decisions` above for whoever runs G3's live review.

## User Setup Required

None -- no external service configuration required.

## Next Phase Readiness

- 08-16/08-18 can build UI-07's remaining stagger clause (discovery checks, list-row first-load entry) directly on top of this plan's now-complete origin-anchoring/Disclosure/easing-token work; nothing here blocks them.
- The new `check:ui-safety` built-in-easing gate is live and will catch any future regression mechanically, including in files 08-16/08-18 touch.
- Sheet's own real exit-animation gap (`deferred-items.md`'s "Sheet's exit animation has no observable mid-flight transform frame") remains open -- `Sheet.tsx` is not in this plan's `files_modified` list and its own frontmatter never named it as this plan's scope; a future plan should pick this up explicitly.

## Hard Git Rules Compliance

- No `git stash`, `git add .`/`-A`/`-u`, `git commit -a`, `git reset --hard`, `git clean`, `git checkout -- <path>`, or `git restore` was run.
- Every commit staged explicit file paths inside `noodara/code/` only; `docs/ui-build-prompt.md` (untracked) was never staged.
- Every commit message is Conventional Commits, English, scoped `(08-14)`, with no `Co-Authored-By`/attribution trailer -- verified after each commit with `git log -1 --format='%(trailers)'` (empty every time).
- No push was made; work stayed on `main`.

## Self-Check: PASSED

All 7 task commit hashes (`05b3d9b`, `991559d`, `d047ced`, `cd14031`, `aca9dc6`, `7184d47`, `d720bd9`) found in `git log --oneline --all`. All 9 key files (`packages/ui/src/{RowMenu,AccountMenu,Dialog,Tooltip,Disclosure,NavTree,StatusPill}.tsx`, `scripts/check-ui-safety.mjs`, `tests/unit/scripts/check-ui-safety.test.ts`) confirmed present on disk.
