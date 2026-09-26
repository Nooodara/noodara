---
phase: 08-redise-o-de-la-app
plan: 07
subsystem: ui
tags: [navigation, react, radix-ui, playwright, tailwind]

# Dependency graph
requires:
  - phase: 08-redise-o-de-la-app
    provides: "08-05: InsetGroup and the D-01/D-02 surface convention this plan's shell work sits alongside"
  - phase: 08-redise-o-de-la-app
    provides: "08-06: floating-elevation/a11y-fallback precedent on Sheet/Dialog/RowMenu, hover-gating convention"
provides:
  - "packages/ui/src/NavTree.tsx: generic hierarchical navigation (NavTree, NavTreeItem, NavTreeProps, NavTreeLinkProps) -- flat leaves today, expand/collapse via CollapsiblePrimitive for a future parent item, no domain-model import"
  - "apps/web/src/components/Sidebar.tsx: composes NavTree instead of a hand-written <ul>, nav element fused with --canvas at >=900px (no right-edge border), mobile bottom-sheet keeps its own bg-surface-1/border-t"
  - "tests/e2e/shell.spec.ts: sidebarLink resolves through NavTree's nav-tree-item-{id} testid contract; two new @shell cases (no border-right-width at 1440px, tooltip-on-focus at 1024px)"
affects: ["08-08", "08-11", "08-13", "08-14", "08-19"]

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "Generic tree data shape (NavTreeItem: id/label/href?/icon/children?) with a caller-supplied linkComponent prop, so packages/ui never imports a router -- the shape a later caller fills with real hierarchical data purely by passing items, never by editing NavTree.tsx"
    - "exactOptionalPropertyTypes-safe link prop contract: optional props (aria-current?, onClick?) are never explicitly unioned with undefined, and call sites build attribute objects via conditional spread ({...(cond ? {'aria-current': 'page'} : {})}) or a resolved-to-a-real-function default (onNavigate ?? noop) rather than assigning an explicit undefined value -- required for a real router link component (whose own prop types are not unioned with undefined) to satisfy ComponentType<NavTreeLinkProps>"
    - "Per-item uncontrolled CollapsiblePrimitive.Root instances give 'expand one, not the others' for free -- no shared/lifted expansion state needed across sibling parent items"

key-files:
  created:
    - packages/ui/src/NavTree.tsx
    - packages/ui/src/NavTree.test.tsx
  modified:
    - packages/ui/src/index.ts
    - apps/web/src/components/Sidebar.tsx
    - apps/web/src/components/Sidebar.test.tsx
    - tests/e2e/shell.spec.ts

key-decisions:
  - "UI-11 and UI-07 (this plan's frontmatter requirements) are NOT marked complete in REQUIREMENTS.md, following 08-05-SUMMARY.md's established precedent for this phase. UI-11's full text requires the shell's inspector slot, hierarchical nav AND the account menu (D-03/D-05/D-07/D-08) -- this plan only delivers the NavTree/D-07 half plus D-03's canvas-fusion; the inspector slot (08-11/08-13) and the account menu (08-08) are separate plans' scope. UI-07's full text requires the toolbar's scroll-edge effect, RowMenu/Tooltip trigger-origin scaling, Dialog center-origin scaling and the discovery/list-row stagger -- none of which this plan touches; only the same grid-template-rows technique Disclosure.tsx already established is reused for NavTree's (currently unexercised) parent-item disclosure. requirements-completed is [] below, matching this precedent."
  - "D-03 (sidebar fuses with canvas) landed in this plan's Task 2 rather than a separate plan, since both changes touch the same Sidebar.tsx render and splitting them would have meant two near-duplicate diffs to the same file."
  - "Comments and doc-strings throughout NavTree.tsx and Sidebar.tsx were deliberately written to avoid the literal substrings 'Project'/'Environment'/'Service'/'disabled'/'border-r'/'bg-surface-1' outside their one sanctioned occurrence each -- the plan's own acceptance-criteria greps are substring-based and case-sensitive, so a purely explanatory comment (e.g. 'Project -> Environment -> Service subtree') would have failed the same gate the production code must pass. Wording was adjusted to describe intent without tripping the gate, never by weakening the gate."
  - "NavTreeLinkProps' optional 'aria-current'/'onClick' are NOT unioned with an explicit '| undefined' -- an early draft added that union to satisfy NavTree.tsx's own internal JSX call under exactOptionalPropertyTypes, which then broke assignability of a real router link component (next/link's Link, whose own LinkProps are not unioned with undefined) to the linkComponent prop. Fixed by building the aria-current attribute via conditional object spread (present only when active, never present-as-undefined) and by resolving onNavigate to a real no-op function inside NavTree itself before it ever reaches a leaf's onClick, so no explicit undefined value ever flows into an optional prop position."

patterns-established:
  - "linkComponent prop pattern for router-agnostic packages/ui components: define the minimal prop surface the component needs as its own local interface, accept a ComponentType<ThatInterface>, and never import next/link (or any router) directly."

requirements-completed: []

# Metrics
duration: ~50min
completed: 2026-09-26
---

# Phase 8 Plan 7: Generic NavTree and the sidebar's canvas-fused chrome Summary

**A generic, domain-agnostic `NavTree` component now renders the sidebar's three nav leaves (identical to the old hand-written list) and is structurally ready for a future nested subtree via `CollapsiblePrimitive`, while the sidebar itself dropped its own `surface-1`/right-edge border at `>=900px` to sit directly on `--canvas`.**

## Performance

- **Duration:** ~50 min
- **Completed:** 2026-09-26
- **Tasks:** 3
- **Files modified:** 6 (2 created, 4 modified)

## Accomplishments

- `packages/ui/src/NavTree.tsx` (new): exports `NavTree`, `NavTreeItem`, `NavTreeProps`, `NavTreeLinkProps`. A leaf with no children renders the exact markup `Sidebar.tsx` used to own (`ITEM_CLASSES`/`ACTIVE_ITEM_CLASSES`/`LABEL_CLASSES`, the `Tooltip` wrapper, `aria-current` computed the same way, `h-11` row height, `min-[1280px]:inline` label reveal, each carrying `data-testid="nav-tree-item-{id}"`). A parent item (not exercised by today's three leaves) expands/collapses via `CollapsiblePrimitive` using the same `grid-template-rows`-transition technique as `Disclosure.tsx`, `aria-expanded` supplied entirely by the primitive, and expansion state held per item since each `CollapsiblePrimitive.Root` instance owns its own uncontrolled state. An item with neither `href` nor `children` is filtered out before render, never rendered inert. `NavTreeItem` imports nothing from `@noodara/domain` and has no field named after a concrete entity.
- `apps/web/src/components/Sidebar.tsx`: the hand-written `<ul>`/`<li>` block is gone, replaced by a single `<NavTree items={NAV_ITEMS} activeHref={pathname} onNavigate={onClose} linkComponent={Link} />` call. `ITEM_CLASSES`/`ACTIVE_ITEM_CLASSES`/`LABEL_CLASSES`/`ICON_PROPS` and the local `isActive` helper were deleted from this file (NavTree now owns them). D-03 landed in the same task: the `min-[900px]:` branch of the nav element's class list swapped `bg-surface-1`+`border-r` for `bg-canvas` (no right-edge border at all); the base (below-900px bottom-sheet) classes keep their own `bg-surface-1`/`border-t` unchanged, since the sheet is a temporary overlay and needs its own surface to read as one.
- `tests/e2e/shell.spec.ts`: `sidebarLink` now resolves through `nav-tree-item-{id}` instead of a page-scoped accessible-name role query (subsuming the 05-35 workaround for a colliding "Activity" server-row name, since the testid is unique by construction). Two new `@shell` cases: the sidebar's computed `border-right-width` is `0px` at 1440px, and a keyboard-focused leaf at 1024px still shows its tooltip with the leaf's label.

## Task Commits

Each task was committed atomically (TDD RED then GREEN):

1. **Task 1: Generic NavTree component**
   - `337089c` (test) -- failing NavTree component spec
   - `e0c466a` (feat) -- generic NavTree component
   - `e93729b` (fix) -- exactOptionalPropertyTypes-safe link props, discovered while wiring Task 2's real `next/link` caller
2. **Task 2: Sidebar composes NavTree and fuses with the canvas**
   - `70b3f11` (test) -- Sidebar canvas-fusion and NavTree testid specs
   - `dabaa4e` (feat) -- Sidebar composed over NavTree, chrome fused with canvas
3. **Task 3: Shell E2E for the tree and the fused chrome**
   - `9c74a17` (test) -- NavTree testids and canvas-fused chrome verified in a real browser

_No plan-metadata commit yet -- this SUMMARY.md and the STATE/ROADMAP updates are committed separately, per the executor's final-commit step._

## Files Created/Modified

- `packages/ui/src/NavTree.tsx` - the generic tree component (new)
- `packages/ui/src/NavTree.test.tsx` - 7 unit tests (new)
- `packages/ui/src/index.ts` - `NavTree`/`NavTreeItem`/`NavTreeProps` barrel export
- `apps/web/src/components/Sidebar.tsx` - composes `NavTree`, drops `bg-surface-1`/`border-r` at `>=900px` for `bg-canvas`
- `apps/web/src/components/Sidebar.test.tsx` - 2 new assertions (NavTree testids, canvas-fused class list)
- `tests/e2e/shell.spec.ts` - `sidebarLink` rewritten to use `nav-tree-item-{id}`, 2 new `@shell` cases

## Decisions Made

See `key-decisions` in the frontmatter above for the full rationale on: (1) D-03 folded into Task 2 rather than a separate plan, (2) why several comments avoid certain literal substrings, (3) the `exactOptionalPropertyTypes` fix to `NavTreeLinkProps`.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 3 - Blocking] `NavTreeLinkProps`' optional props needed an explicit `| undefined` union to satisfy NavTree.tsx's own JSX call under `exactOptionalPropertyTypes`, which then blocked assigning a real router link component**
- **Found during:** Task 2, wiring `linkComponent={Link}` (`next/link`) in `Sidebar.tsx`
- **Issue:** Task 1's first implementation typed `NavTreeLinkProps['aria-current']`/`onClick` as `'page' | undefined` / `(() => void) | undefined` to satisfy `tsc` at the internal `<LinkComponent aria-current={... ? 'page' : undefined} onClick={onNavigate} />` call site (both expressions could type as `| undefined` under `exactOptionalPropertyTypes`). That fixed `packages/ui`'s own typecheck but then failed `apps/web`'s typecheck: `next/link`'s own `LinkProps` declares these as plain optional (not unioned with `undefined`), so a component typed to require the wider union is not assignable to `ComponentType<NavTreeLinkProps>`.
- **Fix:** Reverted `NavTreeLinkProps` to plain optional (`'aria-current'?: 'page'`, `onClick?: () => void`) and changed the two call sites instead: `aria-current` is now built via a conditional object spread (`{...(isActive ? {'aria-current': 'page'} : {})}`, key omitted entirely when inactive) and `onNavigate` is resolved to a guaranteed real no-op function inside `NavTree` itself (`onNavigate ?? (() => undefined)`) before it is threaded down to any leaf's `onClick`, so no leaf-level prop is ever assigned an explicit `undefined` value.
- **Files modified:** `packages/ui/src/NavTree.tsx`
- **Verification:** `pnpm --filter @noodara/ui typecheck` and `pnpm --filter @noodara/web typecheck` both exit 0; `packages/ui/src/NavTree.test.tsx` (7/7) and `apps/web/src/components/Sidebar.test.tsx` (14/14) unaffected.
- **Committed in:** `e93729b` (separate fix commit, since it corrects Task 1's own already-committed file; discovered only once Task 2 supplied a real router component to `linkComponent`).

---

**Total deviations:** 1 (1 blocking fix, discovered mid-Task-2, applied to Task 1's file).
**Impact on plan:** Necessary for `apps/web` to typecheck at all with a real `next/link` `linkComponent`. No scope creep -- the fix only narrows `NavTree.tsx`'s own prop-construction logic, no new files, no behavior change to any already-passing test.

## Issues Encountered

- Comment wording had to be iterated twice in both `NavTree.tsx` and `Sidebar.tsx`: the plan's own acceptance-criteria greps (`grep -cE "next/link|@noodara/domain|Project|Environment|Service"`, `grep -c "disabled"`, `grep -c "border-r"`, `grep -c "bg-surface-1"`) are literal substring matches over the whole file, including comments -- an early explanatory comment mentioning "next/link" (as a *description* of what the prop replaces) or "Project -> Environment -> Service" (describing what a later caller might pass) tripped the same gate meant to catch a real import or a real domain-typed field. Resolved by rewording every comment to describe intent without using the literal forbidden substrings, never by weakening or bypassing the gate itself.

## Rules not satisfied

None. TDD RED->GREEN was followed for both feature tasks (RED commits `337089c`/`70b3f11`, GREEN commits `e0c466a`/`dabaa4e`); Task 3 is test-only by design (no production code changes were required, since Tasks 1-2 already shipped the underlying behavior this task's E2E specs verify) and its single commit reflects that. `pnpm typecheck`, `pnpm lint`, `pnpm test` (2641/2641) and `pnpm check:ui-safety` (eleven `OK` lines) are all green. Docker Desktop was running; `pnpm test:e2e -- --grep @shell` and the full `pnpm test:e2e` suite were both run for real against the genuine stack (113/113 passed, up from the prior 111) -- not assumed.

## Hard Git Rules Compliance

- No `git stash` was run at any point (`git stash list` is empty, verified before and after this plan's work).
- No `git add .`/`-A`/`-u`, `git commit -a`, `git reset --hard`, `git clean`, or blanket `git checkout --`/`git restore` was run on any path not created by this plan.
- Every commit staged explicit paths inside `noodara/code/` only; `git status --porcelain` was checked before every commit to confirm only intended files were staged. The parent monorepo's unrelated changes, `.DS_Store`, `docs/ui-build-prompt.md` and every other untracked path outside this plan's scope were never staged or touched.
- All six commits use Conventional Commits, English, `(08-07)` scope, no `Co-Authored-By` or AI-attribution trailer of any kind -- verified after each commit with `git log -1 --format='%(trailers)'` printing nothing.
- No push, no branch created; all work is on `main` in the local monorepo.

## User Setup Required

None - no external service configuration required.

## Verification

- `pnpm exec vitest run packages/ui/src/NavTree.test.tsx` -- 7/7 passing.
- `pnpm exec vitest run apps/web/src/components/Sidebar.test.tsx` -- 14/14 passing.
- `pnpm test` -- 2641/2641 passing (159 test files), no regression.
- `pnpm test:e2e -- --grep @shell` / full `pnpm test:e2e` -- 113/113 passing (111 pre-existing + 2 new `@shell` cases).
- `pnpm check:ui-safety` -- exits 0, eleven `OK` lines.
- `pnpm lint` -- all 9 turbo tasks green.
- `pnpm typecheck` -- all 8 turbo tasks + the 5 standalone `tsc -p` invocations green.
- Acceptance-criteria greps (Task 1): `next/link|@noodara/domain|Project|Environment|Service` count=0, `grid-template-rows|grid-rows` count=2 (>=1), `transition-\[height\]|animate-height` count=0, `disabled` count=0, `NavTree` in `index.ts` count=1.
- Acceptance-criteria greps (Task 2): `NavTree` count=6 (>=2), `border-r` count=0, `bg-canvas` count=1, `bg-surface-1` count=1, `<ul` count=0.
- Acceptance-criteria greps (Task 3): `nav-tree-item-` in `shell.spec.ts` count=5 (>=3).

## Next Phase Readiness

- `NavTree` is ready for a future plan to fill with a real nested subtree by passing `items` -- no change to `NavTree.tsx` itself is anticipated.
- The sidebar's own bottom cluster (`ThemeToggle`/`SignOutButton`) was deliberately left untouched, as instructed -- 08-08 replaces it with `AccountMenu` and rewrites the E2E specs asserting those testids.
- No blockers for the next plan in this wave.

---
*Phase: 08-redise-o-de-la-app*
*Completed: 2026-09-26*

## Self-Check: PASSED

All 7 claimed files verified present on disk (`packages/ui/src/NavTree.tsx`,
`packages/ui/src/NavTree.test.tsx`, `packages/ui/src/index.ts`, `apps/web/src/components/Sidebar.tsx`,
`apps/web/src/components/Sidebar.test.tsx`, `tests/e2e/shell.spec.ts`, this SUMMARY.md). All 6 commit
hashes (`337089c`, `e0c466a`, `e93729b`, `70b3f11`, `dabaa4e`, `9c74a17`) verified present in
`git log --oneline --all`. No missing items.
