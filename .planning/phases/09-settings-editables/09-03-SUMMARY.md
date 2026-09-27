---
phase: 09-settings-editables
plan: 03
subsystem: ui
tags: [tailwind, css-custom-properties, design-tokens, playwright, vitest]

# Dependency graph
requires:
  - phase: 08-redise-o-de-la-app
    provides: ListRow, SkeletonRow, NavTree, LabelValue, InsetGroup and packages/ui/tokens.css itself
provides:
  - "--row-height / --row-height-padding-y token pair in packages/ui/tokens.css, remapped only under html[data-density=\"compact\"]"
  - ListRow, SkeletonRow, NavTree items and LabelValue rows all reading row geometry from those two tokens instead of a hardcoded 44/py-2/h-11
  - an honest data-row=\"true\" test hook replacing the old data-height=\"44\" hook everywhere it was used (unit and E2E)
  - an E2E proof (@density) that flipping html[data-density] to \"compact\" actually changes rendered row height in a real browser while typography stays fixed
affects: [09-12-settings-appearance-controls, any future plan touching ListRow/SkeletonRow/NavTree/LabelValue geometry]

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "Single-writer density attribute: only packages/ui/tokens.css's html[data-density=\"compact\"] block reads [data-density]; every consumer only ever reads the two CSS variables"
    - "data-row=\"true\" as the generic row test hook (replacing data-height=\"44\"), shared by ListRow and SkeletonRow so a Playwright/RTL selector never needs to distinguish real vs. skeleton row geometry"

key-files:
  created: []
  modified:
    - packages/ui/tokens.css
    - packages/ui/src/ListRow.tsx
    - packages/ui/src/ListRow.test.tsx
    - packages/ui/src/Skeleton.tsx
    - packages/ui/src/Skeleton.test.tsx
    - packages/ui/src/NavTree.tsx
    - packages/ui/src/NavTree.test.tsx
    - packages/ui/src/LabelValue.tsx
    - packages/ui/src/LabelValue.test.tsx
    - packages/ui/src/InsetGroup.tsx
    - apps/web/src/components/ServerList.test.tsx
    - tests/e2e/servers-list.spec.ts
    - tests/e2e/settings.spec.ts
    - tests/e2e/activity.spec.ts

key-decisions:
  - "InsetGroup itself gets no min-height / geometry change (only its header comment) -- LabelValue rows own their own vertical rhythm through --row-height-padding-y, so InsetGroup composing a compact-density LabelValue row needs no change of its own"
  - "activity.spec.ts's data-height=\"44\" selector was also migrated to data-row=\"true\", even though it wasn't listed in the plan's files_modified -- required for the plan's own acceptance criteria (repo-wide zero data-height=\"44\" occurrences) to hold"

patterns-established:
  - "D-14 density tokens: --row-height / --row-height-padding-y, comfortable at :root, compact only under html[data-density=\"compact\"]"

requirements-completed: [SET-05]

# Metrics
duration: 35min
completed: 2026-09-27
---

# Phase 9 Plan 3: Density tokens and token-driven row components Summary

**Introduced the `--row-height`/`--row-height-padding-y` token pair (D-14) and migrated ListRow, SkeletonRow, NavTree and LabelValue off hardcoded 44px/h-11/py-2 geometry, with an E2E proof that `html[data-density="compact"]` shrinks real rendered rows to 36px while typography stays fixed.**

## Performance

- **Duration:** 35 min
- **Started:** 2026-09-27T01:04:00Z
- **Completed:** 2026-09-27T01:20:00Z
- **Tasks:** 2
- **Files modified:** 14

## Accomplishments
- Single density token pair (`--row-height`, `--row-height-padding-y`) added to `packages/ui/tokens.css`, comfortable value at `:root`, compact remap only under `html[data-density="compact"]` -- the one writer of that attribute in the whole repo
- `ListRow`, `SkeletonRow`, `NavTree` items and `LabelValue` rows all read geometry from those two tokens; comfortable density renders byte-identical to before this plan
- Replaced the dishonest `data-height="44"` hook (a hardcoded number baked into a test attribute) with `data-row="true"` everywhere it appeared, across unit tests (`ListRow`, `SkeletonRow`, `ServerList`) and E2E specs (`servers-list`, `settings`, `activity`)
- New `@density` E2E test proves real rendered geometry in a browser: a seeded server row measures 44px in comfortable, 36px after setting `data-density="compact"`, with the row title's computed `font-size` unchanged across both

## Task Commits

Each task was committed atomically (TDD: test -> feat):

1. **Task 1: Density tokens and token-driven row components**
   - `e102d69` (test) -- failing tests asserting `data-row`/`h-[var(--row-height)]` on ListRow/SkeletonRow, plus new NavTree/LabelValue token-class assertions
   - `8c9d2c9` (feat) -- tokens.css density pair, ListRow/SkeletonRow/NavTree/LabelValue/InsetGroup migrated, `ROW_HEIGHT_PX` deleted repo-wide
2. **Task 2: Migrate data-height consumers and prove real geometry in the browser**
   - `bc2c6ef` (feat) -- `ServerList.test.tsx`, `servers-list.spec.ts`, `settings.spec.ts`, `activity.spec.ts` selectors migrated to `data-row="true"`; new `@density` E2E geometry test added

_TDD RED for Task 2 was the natural byproduct of Task 1's GREEN commit: `ServerList.test.tsx`'s `[data-height="44"]` assertion started failing the instant `data-height` was removed from `ListRow`/`SkeletonRow` -- confirmed with a scoped `vitest run` before writing any Task 2 fix._

## Files Created/Modified
- `packages/ui/tokens.css` -- `--row-height`/`--row-height-padding-y` at `:root`, compact remap under `html[data-density="compact"]`
- `packages/ui/src/ListRow.tsx` -- `data-row="true"`, `h-[var(--row-height)]`, no more inline height style/`data-height`
- `packages/ui/src/Skeleton.tsx` -- `SkeletonRow` mirrors `ListRow`'s token-driven geometry and `data-row` hook
- `packages/ui/src/NavTree.tsx` -- item height from `h-[var(--row-height)]` instead of `h-11`
- `packages/ui/src/LabelValue.tsx` -- vertical padding from `py-[var(--row-height-padding-y)]` instead of `py-2`
- `packages/ui/src/InsetGroup.tsx` -- header comment only, documents that rows own their own density rhythm
- `apps/web/src/components/ServerList.test.tsx`, `tests/e2e/servers-list.spec.ts`, `tests/e2e/settings.spec.ts`, `tests/e2e/activity.spec.ts` -- `data-height="44"` selectors migrated to `data-row="true"`; new `@density` geometry test in `servers-list.spec.ts`

## Decisions Made
- InsetGroup itself carries no geometry change -- only its header comment was touched, so comfortable-density LabelValue rows inside an InsetGroup stay pixel-identical without any wrapper-level min-height that could conflict with D-14's exact 36px/4px compact values
- Migrated `activity.spec.ts`'s `data-height="44"` selector even though it wasn't in the plan's `files_modified` list -- the plan's own acceptance criteria (`grep -rn 'data-height="44"' ... | wc -l` returns 0) required it, and leaving it would have broken `@activity`'s loading-state test the moment `SkeletonRow` dropped the attribute (Rule 3 -- blocking issue caused directly by this plan's own change)

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 3 - Blocking] Migrated `tests/e2e/activity.spec.ts`'s `data-height="44"` selector**
- **Found during:** Task 2 (verifying the plan's own repo-wide acceptance grep)
- **Issue:** The plan's `files_modified` for Task 2 lists only `ServerList.test.tsx`, `servers-list.spec.ts` and `settings.spec.ts`, but `tests/e2e/activity.spec.ts` also asserted `[data-height="44"]` (10-skeleton-row loading state) -- Task 1 removing `data-height` from `SkeletonRow` broke that test too, and the plan's own acceptance criterion scans `tests/e2e` as a whole
- **Fix:** Replaced `[data-height="44"]` with `[data-row="true"]` in `tests/e2e/activity.spec.ts`, keeping the same count assertion (10)
- **Files modified:** `tests/e2e/activity.spec.ts`
- **Verification:** `pnpm test:e2e` full run, 144/144 passed, including `@activity the loading state shows ten skeleton rows...`
- **Committed in:** `bc2c6ef` (Task 2 commit)

---

**Total deviations:** 1 auto-fixed (1 blocking)
**Impact on plan:** Necessary to satisfy the plan's own stated acceptance criteria; no scope creep beyond a one-line selector swap that mirrors the other three files' identical change.

## Issues Encountered
- Two orphaned processes (`next-server` on port 3000, its parent `pnpm --filter @noodara/web start`) from an earlier interrupted E2E stack startup in this same session were occupying port 3000, causing the first `pnpm test:e2e -- --grep "@density"` attempt to fail with "listen failed" before any test ran. Killed both PIDs (verified they belonged to this repo's own `next-server`/`pnpm start` for `@noodara/web`, started minutes earlier in this session) and re-ran; the stack then started cleanly.
- The initial `@density` E2E assertion's title-font-size lookup used a `getByText(name)` locator that matched three elements (primary text, host:port mono text, and the row-menu's accessible label all contain the seeded server name as a substring) -- resolved with `{ exact: true }` so it targets only the primary-text span.
- `pnpm test:e2e -- --grep "..."` did not actually filter (both `@density` and `@settings` grep invocations ran the full 144-test suite) -- not investigated further since the full suite passing 144/144 for both invocations is a strictly stronger result than a filtered subset would have been.

## User Setup Required
None - no external service configuration required.

## Next Phase Readiness
- `--row-height`/`--row-height-padding-y` are live and consumed by every row-bearing component; plan 09-12 (Settings Appearance controls) can wire a `SegmentedControl` that writes `html[data-density]` with zero further component changes
- `data-row="true"` is now the one stable row test hook across unit and E2E suites for any future plan needing to count or select rows

---
*Phase: 09-settings-editables*
*Completed: 2026-09-27*
