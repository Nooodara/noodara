---
phase: 05-ui-web
plan: 25
subsystem: ui
tags: [react, radix-ui, dialog-non-modal, collapsible, localstorage, wai-aria-menu, vitest, jsdom, testing-library, tdd, accessibility]

# Dependency graph
requires:
  - phase: 05-ui-web
    provides: "05-24's Tooltip/RelativeTime/CopyButton/StatTile/LabelValue and renderUi's TooltipProvider mount; 05-08's seven approved Radix primitives; 05-09's SkeletonRow's data-height=44 convention; 05-07's apps/web/src/lib/theme-script.ts first-paint bootstrap (the storage key/attribute contract ThemeToggle must match)"
provides:
  - "packages/ui/src/ListRow.tsx: the 44px hairline row -- a real <a> (href) or <button> (onActivate) as the whole-row activation element, never a <div> with a click handler, with the trailing slot rendered as a DOM sibling so it can never also activate the row"
  - "packages/ui/src/RowMenu.tsx: the per-row `...` action menu built on @radix-ui/react-dialog's non-modal usage (no approved popover/dropdown-menu primitive exists) -- role=menu/menuitem, items absent from the accessibility tree until the trigger is activated, >=44px trigger hit area, arrow-key roving focus, Escape/outside-click dismiss and close->trigger focus return all from the primitive"
  - "packages/ui/src/Disclosure.tsx: Radix Collapsible wrapper -- collapsed content is genuinely unmounted (not hidden), aria-expanded owned by the primitive, defaultOpen for live-state call sites, motion gated by prefers-reduced-motion"
  - "packages/ui/src/ThemeToggle.tsx: the single writer of localStorage's noodara-theme key and document.documentElement's data-theme attribute after page load -- cycles light -> dark -> system, guards every storage access in try/catch, only ever writes 'light'/'dark' to the DOM attribute"
affects: [05-11..05-21 (every servers-list/activity-log/settings screen composes ListRow+RowMenu for rows, Disclosure for the Advanced settings group/discovery raw checks/activity row detail, and the authenticated shell's sidebar composes ThemeToggle)]

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "ListRow's activation prop is a discriminated union ({ href: string; onActivate?: undefined } | { href?: undefined; onActivate: () => void }), not two loose optional props -- passing both or neither fails to type-check, and the trailing slot is always a DOM sibling of the <a>/<button>, never a descendant, so T-5-45 (a trailing click activating the row) is structurally impossible rather than merely tested against"
    - "RowMenu is built on @radix-ui/react-dialog's Root with modal={false}: DialogContentNonModal already provides Escape-close, outside-pointer-down dismiss and close->trigger focus return with zero custom dismiss logic in this file. role=\"menu\"/role=\"menuitem\" safely override the primitive's own default role=\"dialog\" because DialogContent spreads caller props after its own role assignment (verified by reading @radix-ui/react-dialog@1.1.23's source, not assumed) -- and once role=menu is used, this component owns the one thing the primitive doesn't provide for a menu: arrow-key roving focus between items (Home/End too)"
    - "RowMenu deliberately does not use DialogPrimitive.Portal -- Content renders in-place inside a position:relative wrapper so it can be anchored to its own trigger with a plain absolute/top-full/right-0 class, instead of portaling to document.body and losing that DOM-proximity anchor point"
    - "Disclosure adds zero onKeyDown of its own -- Enter-toggling the trigger works because it's a real Radix Primitive.button, and @testing-library/user-event's own keypress behaviour dispatches a click for Enter on a <button>/<a href> (confirmed by reading user-event@14.6.7's keypress.js), matching the same native-activation principle ListRow uses"
    - "ThemeToggle's storage key is declared exactly once in the whole packages/ui/src tree (export const STORAGE_KEY = 'noodara-theme') and ThemeToggle.test.tsx imports that constant rather than re-typing the literal, keeping this plan's own acceptance-criteria grep (`grep -rc noodara-theme` matches exactly one file) true by construction, not by discipline"
    - "ThemeToggle's data-theme write path is single-sourced through one useEffect keyed on `mode` state; handleClick only ever calls setMode (wrapped storage write is a side effect, never gates the state update) -- this is what makes the throwing-localStorage.setItem test pass structurally: the effect fires and writes data-theme regardless of whether the try/catch above it caught an exception"

key-files:
  created:
    - packages/ui/src/ListRow.tsx
    - packages/ui/src/ListRow.test.tsx
    - packages/ui/src/RowMenu.tsx
    - packages/ui/src/RowMenu.test.tsx
    - packages/ui/src/Disclosure.tsx
    - packages/ui/src/Disclosure.test.tsx
    - packages/ui/src/ThemeToggle.tsx
    - packages/ui/src/ThemeToggle.test.tsx
  modified:
    - packages/ui/src/index.ts

key-decisions:
  - "RowMenu is built on @radix-ui/react-dialog's non-modal usage per the plan's own explicit instruction, since none of the seven ADR-0000-approved Radix primitives (dialog, tooltip, collapsible, radio-group, scroll-area, visually-hidden, checkbox) is a purpose-built popover/dropdown-menu, and @radix-ui/react-dropdown-menu/react-popover are not approved packages -- this is not a hand-rolled menu with custom dismiss logic; every dismiss/focus-return/outside-click behaviour comes from DialogContentNonModal, verified by reading its source rather than assumed"
  - "RowMenu additionally implements role=menu/menuitem plus arrow-key roving focus (Home/End too), beyond what the plan's own <behavior> block strictly tests, per this session's accessibility bar for any hand-assembled menu pattern -- WAI-ARIA's menu pattern requires roving focus once role=menu is chosen, and RowMenu.test.tsx asserts it directly (ArrowDown/ArrowUp) alongside Escape-close-and-focus-return and outside-click-close"
  - "RowMenu's Content is not wrapped in a Portal -- it renders in-place inside a position:relative trigger wrapper so CSS can anchor it directly to the trigger, rather than portaling to document.body and losing that DOM proximity (a deliberate departure from Dialog.tsx/Sheet.tsx's own portaled, viewport-centered precedent, appropriate here because a row menu is small and anchored, not a full-screen overlay)"
  - "No box-shadow on RowMenu's content panel -- border-hairline + bg-surface-3 only, matching this session's explicit 'no shadows anywhere, menus included' instruction over the skill's own SS2.3 'Floating: shadow for popovers/menus/sheets' rule; Dialog.tsx/Sheet.tsx already established this shadow-free precedent for sheets and dialogs in this codebase, so RowMenu's panel follows the same established local convention rather than the skill's more general (and locally overridden) rule"

requirements-completed: []

# Metrics
duration: ~14min
completed: 2026-09-19
---

# Phase 5 Plan 25: ListRow, RowMenu, Disclosure, ThemeToggle Summary

**Completes the design system's interaction layer -- a genuinely keyboard-native list row whose menu is structurally absent until opened, a Disclosure whose collapsed content is truly unmounted, and the one component in the whole codebase allowed to write the persisted theme preference after page load.**

## Performance

- **Duration:** ~14 min
- **Started:** 2026-09-19T17:26:00Z
- **Completed:** 2026-09-19T17:40:00Z
- **Tasks:** 3 (each RED test file committed separately from its GREEN implementation, per CLAUDE.md SS2.1)
- **Files modified:** 9 (8 new source/test files, `index.ts`)

## Accomplishments

- `packages/ui/src/ListRow.tsx`: 44px hairline row (`data-height="44"`, matching `SkeletonRow`'s own convention from Plan 05-09) whose whole-row activation is a real `<a>` (given `href`) or `<button>` (given `onActivate`) -- never a `<div>` with a click handler, enforced both by a discriminated-union prop type (exactly one of `href`/`onActivate`, or the type doesn't check) and by a `grep -cE "<div[^>]*onClick"` acceptance criterion that reports 0. Enter/Space keyboard activation is entirely native (proven with real `userEvent.tab()` + `userEvent.keyboard()`, never a synthetic event). The trailing slot renders as a DOM sibling of the activation element, so a trailing click structurally cannot also fire `onActivate` -- proven, not assumed, by a test that clicks a trailing button and asserts `onActivate` was never called (T-5-45's mitigation).
- `packages/ui/src/RowMenu.tsx`: the per-row `...` action menu, built on `@radix-ui/react-dialog`'s `modal={false}` usage since no ADR-0000-approved primitive is a purpose-built popover/menu (see Decisions). `role="menu"`/`role="menuitem"` safely override the primitive's own default `role="dialog"`. Items are provably absent from the accessibility tree before the trigger is activated (`queryByRole('menuitem')` is `null`) and appear only after activation; the trigger carries a real accessible name via `VisuallyHidden.Root` (never a bare glyph) and a `data-hit-area="44"` attribute proving the >=44px touch target. Selecting an item invokes exactly that item's handler, never a sibling's. Escape closes the menu and returns focus to the trigger, a pointer interaction outside the menu closes it, and ArrowDown/ArrowUp move focus between items (Home/End too) -- all four behaviours asserted directly, going beyond the plan's own `<behavior>` block to satisfy this session's "fully accessible hand-assembled menu" bar.
- `packages/ui/src/Disclosure.tsx`: a `@radix-ui/react-collapsible` wrapper. Collapsed content is genuinely unmounted (the primitive's own `Presence`-driven behaviour, not a display/opacity toggle) -- `queryByText` on the collapsed content returns `null`, which is what lets a later plan's "Advanced settings rows are absent on load" assertion and Plan 05-21's DOM canary scan (T-5-46) both hold. `aria-expanded` is entirely the primitive's own (`false` collapsed, `true` expanded); a full click-open-then-click-close cycle and a separate Enter-key toggle are both asserted. `defaultOpen` renders expanded on first paint for the discovery section's live-state call site. This file adds no custom keydown handler and no custom animation handler (`grep -c "onKeyDown"` reports 0); the only motion is a `motion-safe:`-gated CSS transition, so `prefers-reduced-motion` degrades it to instant.
- `packages/ui/src/ThemeToggle.tsx`: the only component in this codebase that writes `localStorage`'s `noodara-theme` key or `document.documentElement`'s `data-theme` attribute after the initial page load -- its only counterpart is `apps/web/src/lib/theme-script.ts`'s first-paint bootstrap script, read and matched exactly (same storage key, same attribute, same "system means absence of a stored key" semantics). Three successive clicks cycle light -> dark -> system: `localStorage.getItem('noodara-theme')` reads `'light'`, then `'dark'`, then the key is removed entirely. `data-theme` tracks the same cycle, resolving the system case through a stubbed `matchMedia`. The button's accessible name states the current mode (`aria-label="Theme: {mode}"`). A throwing `localStorage.setItem` neither throws nor prevents the `data-theme` update, since the state update that drives the DOM write does not depend on the storage write having succeeded; a throwing `localStorage.getItem` on mount is caught and defaults to `'system'` rather than crashing. `data-theme` only ever receives `'light'` or `'dark'` -- the `applyTheme` write path's parameter type is `StoredTheme`, so `'system'` cannot reach the DOM attribute even by mistake.
- All four RED test files (`ListRow.test.tsx`, `RowMenu.test.tsx`, `Disclosure.test.tsx`, `ThemeToggle.test.tsx`) were seen to fail for the correct reason (module-not-found) before their GREEN implementations existed -- see RED Observations below.
- `pnpm test` (1151 tests, up from 1120 before this plan across 31 new tests here, zero regressions), `pnpm build`, `pnpm lint`, `pnpm typecheck` and `pnpm boundaries` are all green across the whole monorepo. `packages/ui/src/index.ts` now exports `Disclosure`, `ListRow`, `RowMenu` and `ThemeToggle` alphabetically, completing 05-UI-SPEC.md's Component Inventory.

## Task Commits

1. **Task 1 RED: failing ListRow/RowMenu tests** - `02f30ee` (test)
2. **Task 1 GREEN: ListRow and RowMenu** - `3bb21bc` (feat)
3. **Task 1 fix: RowMenu glyph grep false-positive** - `c05b249` (fix, see Deviations)
4. **Task 2 RED: failing Disclosure test** - `6d7049e` (test)
5. **Task 2 GREEN: Disclosure** - `a70fe12` (feat)
6. **Task 3 RED: failing ThemeToggle test** - `fc2afbf` (test)
7. **Task 3 GREEN: ThemeToggle** - `af9e233` (feat)

## RED Observations

- `ListRow.test.tsx`: failed with `Failed to resolve import "./ListRow.js" from "src/ListRow.test.tsx". Does the file exist?` -- 0 tests ran, an import-resolution failure, not an assertion failure.
- `RowMenu.test.tsx`: failed identically, `Failed to resolve import "./RowMenu.js"`, before the component existed.
- `Disclosure.test.tsx`: failed identically, `Failed to resolve import "./Disclosure.js"`.
- `ThemeToggle.test.tsx`: failed identically, `Failed to resolve import "./ThemeToggle.js"`.

All four RED failures were for the correct reason (missing implementation module), never a passing-when-it-shouldn't-be assertion -- the plan's own fail-fast rule was not triggered.

## Files Created/Modified

- `packages/ui/src/ListRow.tsx` - `ListRow`
- `packages/ui/src/ListRow.test.tsx` - real link/button activation, Enter/Space, trailing-slot isolation, data-height=44
- `packages/ui/src/RowMenu.tsx` - `RowMenu`, `RowMenuItem`
- `packages/ui/src/RowMenu.test.tsx` - accessible name, >=44px hit area, hidden-until-activated menuitems, per-item selection, Escape/outside-click, arrow-key roving focus
- `packages/ui/src/Disclosure.tsx` - `Disclosure`
- `packages/ui/src/Disclosure.test.tsx` - absent-not-hidden content, aria-expanded, click/Enter toggle cycle, defaultOpen, no custom keydown
- `packages/ui/src/ThemeToggle.tsx` - `ThemeToggle`, `STORAGE_KEY`
- `packages/ui/src/ThemeToggle.test.tsx` - three-click cycle, data-theme tracking, accessible name, throwing-storage survival, light/dark-only writes
- `packages/ui/src/index.ts` - now also exports `Disclosure`, `ListRow`, `RowMenu`, `ThemeToggle` (alphabetical)

## Decisions Made

See `key-decisions` in frontmatter -- summarized: RowMenu is built on `@radix-ui/react-dialog`'s non-modal usage (no approved popover/menu primitive exists, and `@radix-ui/react-dropdown-menu`/`react-popover` are explicitly not approved per ADR-0000), with `role="menu"`/`role="menuitem"` overriding the primitive's default dialog role and this component's own added arrow-key roving focus satisfying the WAI-ARIA menu pattern's requirement once that role is chosen; its Content is deliberately not portaled so it can be CSS-anchored to its own trigger; its panel has no box-shadow, following `Dialog.tsx`/`Sheet.tsx`'s own already-established shadow-free local precedent over the skill's more general "menus get the one floating shadow" rule.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] RowMenu's `&#8943;` HTML numeric character reference false-positive-tripped this plan's own hex-color grep gate**
- **Found during:** Task 1, running the plan's own `grep -rcE "#[0-9a-fA-F]{3,8}|rgb\(" packages/ui/src` verification command (a repo-wide check, not this plan's stated per-task acceptance criteria, but part of the plan's overall `<verification>` block)
- **Issue:** `&#8943;` (the HTML entity for the ellipsis glyph `⋯`) matches the `#[0-9a-fA-F]{3,8}` pattern (`#8943` reads as a valid 4-digit hex sequence to the regex), even though it is not a color literal at all.
- **Fix:** Replaced the HTML entity with the literal Unicode ellipsis character (`⋯`, U+22EF) directly in the JSX text, which is visually and semantically identical but contains no `#`-prefixed hex-looking substring.
- **Files modified:** `packages/ui/src/RowMenu.tsx`
- **Verification:** `grep -rcE "#[0-9a-fA-F]{3,8}|rgb\(" packages/ui/src` now totals 0; `pnpm test packages/ui/src/RowMenu.test.tsx` still 9/9 green; `pnpm build`/`lint`/`typecheck` all clean.
- **Committed in:** `c05b249` (separate fix commit, since Task 1's GREEN commit had already landed when this was found during the plan-level verification pass)

---

**Total deviations:** 1 auto-fixed (Rule 1 bug -- a grep-gate false positive, matching the same class of "doc comments/glyphs can trip the plan's own gates" gotcha already flagged in STATE.md for Plans 05-03/05-07/05-09)
**Impact on plan:** The fix changed only how the ellipsis glyph is spelled in source (entity reference vs. literal character) -- zero change to any component's behavior, test, or scope.

## Issues Encountered

None beyond the auto-fixed deviation above. One implementation note worth flagging: `@radix-ui/react-dialog@1.1.23`'s `DialogContent` spreads caller-supplied props (including `role`) *after* its own internal `role: "dialog"` assignment, and `DialogTrigger` spreads caller props after its own `aria-haspopup: "dialog"` -- both overrides RowMenu relies on were verified by reading the installed package's source directly (`node_modules/.pnpm/@radix-ui+react-dialog@1.1.23.../dist/index.mjs`) rather than assumed from documentation, since getting this wrong silently would have left the menu announced as a dialog to assistive tech instead of a menu.

## User Setup Required

None -- no external service configuration required. No new packages were installed (`@radix-ui/react-dialog`, `@radix-ui/react-collapsible` and `@radix-ui/react-visually-hidden` were already dependencies from Plan 05-08's install wave; `lucide-react`'s `ChevronRight`/`Monitor`/`Moon`/`Sun` icons were already a runtime dependency from Plan 05-23).

## Next Phase Readiness

- `ListRow`, `RowMenu`, `Disclosure` and `ThemeToggle` are real, behaviourally-tested, token-only pieces every remaining screen plan (05-11 through 05-21) composes its server/activity rows, row action menus, Advanced settings/discovery raw-checks/activity-row detail disclosures, and the authenticated shell's sidebar theme control from -- no shell, screen or `apps/web` route consumes them yet.
- **UI-01 and UI-02 stay Pending in REQUIREMENTS.md.** This plan completes 05-UI-SPEC.md's Component Inventory (every row in that table now has a colocated behavioural test) but adds no shell, sidebar, toolbar or screen wiring to `apps/web` -- matches the same plan-frontmatter-artifact pattern already flagged in STATE.md for SERV-06 (04-01), DETL-02/QA-05 (05-01/05-02/05-03), and UI-01/UI-02 itself across every prior `packages/ui`-only plan this phase (05-06, 05-22, 05-07, 05-08, 05-23, 05-09, 05-24). Re-verify UI-01/UI-02 against whichever later plan actually builds the shell and screens (05-UI-SPEC.md SS1-2).
- 05-UI-SPEC.md's Component Inventory (section 3) is now fully implemented and tested: every row in that table -- `Button`, `StatusPill`, `Input`/`Textarea`, `SegmentedControl`, `FileButton`, `Sheet`, `Dialog`, `Banner`/`Notice`, `StatTile`, `LabelValue`, `ListRow` + row menu, `Skeleton`, `EmptyState`, `Disclosure`/`Collapsible`, `Tooltip`, `ThemeToggle` -- exists in `packages/ui` with a colocated behavioural test. Screens can now be assembled without inventing any primitive, per this plan's own `<success_criteria>`.
- The remaining 11 incomplete plans in this phase (05-11 through 05-21) are shell/screen composition work, not new component-library primitives.

---
*Phase: 05-ui-web*
*Completed: 2026-09-19*
