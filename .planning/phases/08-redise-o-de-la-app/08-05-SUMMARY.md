---
phase: 08-redise-o-de-la-app
plan: 05
subsystem: ui
tags: [design-system, inset-group, react, vitest, playwright]

# Dependency graph
requires:
  - phase: 08-redise-o-de-la-app
    provides: "08-03: --shadow-floating, --surface-elevated tokens and the shadow-outside-allowlist gate in scripts/check-ui-safety.mjs that InsetGroup must stay green against"
provides:
  - "packages/ui/src/InsetGroup.tsx: the macOS System Settings grouped-inset surface wrapper (title outside the block, surface-1/hairline/rounded-lg block, per-row hairline separators, no shadow, no runtime nesting guard by design), exported InsetGroup/InsetGroupProps from packages/ui/src/index.ts"
  - "apps/web/src/components/ServerFacts.tsx: System/Docker/Connection each rendered as one InsetGroup block, literal <h3> headings deleted (InsetGroup renders its own)"
  - "apps/web/src/components/SettingsGroups.tsx: Instance rendered as one InsetGroup block, Advanced's Disclosure-collapsed content wrapped in an untitled InsetGroup (the Disclosure trigger itself untouched)"
  - "apps/web/src/components/ServerList.tsx: the whole servers list (rows or the empty state) rendered as a single InsetGroup block"
affects: ["08-07", "08-08", "08-11", "08-19"]

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "InsetGroup uses Children.toArray(children) to wrap each row in its own hairline-separator div (border-b border-hairline last:border-b-0), following DiscoveryStep.tsx's existing row-separator convention rather than pushing the border onto each child directly -- callers pass rows as plain children with no per-row wrapper markup of their own"
    - "data-inset-group=\"true\" on the block element is the structural marker this plan's own tests use to assert 'testid resolves to the InsetGroup block, not a bare div' -- no other file reads this attribute yet"
    - "InsetGroup's no-nesting rule (§9 #5) is documented, not runtime-guarded: a nested composition renders without error (proven by InsetGroup.test.tsx's own documentation test), and staying out of that shape is a review-time discipline, matching how the codebase already treats several other 'never do X' rules that a static gate cannot practically express as a DOM-shape check"

key-files:
  created:
    - packages/ui/src/InsetGroup.tsx
    - packages/ui/src/InsetGroup.test.tsx
  modified:
    - packages/ui/src/index.ts
    - apps/web/src/components/ServerFacts.tsx
    - apps/web/src/components/ServerFacts.test.tsx
    - apps/web/src/components/SettingsGroups.tsx
    - apps/web/src/components/SettingsGroups.test.tsx
    - apps/web/src/components/ServerList.tsx
    - apps/web/src/components/ServerList.test.tsx

key-decisions:
  - "SettingsGroups.tsx's outer gap changed from gap-12 (48px) to gap-6 (24px), matching 08-UI-SPEC.md §1's explicit rule ('Between two consecutive InsetGroup blocks on the same screen: --space-6 (24px) vertical gap, D-04') and Task 2's own top-level behaviour bullet ('Consecutive blocks are separated by a 24px gap'), even though the plan's per-component action text only spelled out the gap-6 change for ServerFacts.tsx by name. Interpreted as in-scope for both components since 08-UI-SPEC.md §1 states the 24px rule generally, not per-screen, and Task 2's behaviour list appears before the per-component breakdown."
  - "InsetGroup's no-nesting invariant (§9 #5) has no runtime guard (no thrown error). A hard throw would only ever be reachable through a programming error, not user input, and the plan's own Task 1 action text explicitly frames this as 'a documented invariant, not a runtime throw' -- InsetGroup.test.tsx's dedicated test proves the shape is technically renderable (one data-inset-group descendant found under the outer's own testid) specifically so the prohibition stays a reviewable, test-visible discipline rather than a silent assumption."
  - "UI-11 and UI-12 (this plan's frontmatter requirements) are NOT marked complete in REQUIREMENTS.md, following 08-01/08-03/08-04-SUMMARY.md's established precedent for this phase. UI-11's full text requires the shell's inspector slot, hierarchical nav and account menu (D-03/D-05/D-07/D-08) -- none of which this plan touches, it only delivers the InsetGroup piece of D-01/D-02. UI-12 requires human-reviewed screenshots at G2/G3, which have not happened yet."

patterns-established:
  - "Grouped-inset surface pattern (InsetGroup): any future screen needing the macOS System Settings block treatment composes InsetGroup with plain-child rows; no caller writes its own border-b/rounded-lg/bg-surface-1 markup for this shape again."

requirements-completed: []

# Metrics
duration: ~35min
completed: 2026-09-26
---

# Phase 8 Plan 5: InsetGroup grouped-list surface and its three D-01/D-02 applications Summary

**`InsetGroup` now exists as the one macOS System Settings grouped-inset block in `packages/ui`, and the three places D-01/D-02 name -- server detail's System/Docker/Connection groups, Settings' Instance/Advanced, and the whole servers list -- are wrapped in it, with no other change to any of those screens.**

## Performance

- **Duration:** ~35 min
- **Completed:** 2026-09-26
- **Tasks:** 3
- **Files modified:** 8 (2 created, 6 modified)

## Accomplishments

- `packages/ui/src/InsetGroup.tsx`: new component -- an optional `<h3 className="text-label uppercase text-ink-secondary">` title outside the block (unchanged markup/role from today's `ServerFacts.tsx`), and a block (`overflow-hidden rounded-lg border border-hairline bg-surface-1`, `data-testid` on this element, `data-inset-group="true"` marker) whose children are each wrapped in `border-b border-hairline last:border-b-0` via `Children.toArray`, mirroring `DiscoveryStep.tsx`'s own row-separator convention. Never carries a shadow class; the no-nesting rule is documented (module header + a dedicated test), not runtime-thrown, per the plan's own instruction. Exported alphabetically from `packages/ui/src/index.ts` between `Input` and `isConfirmationMatch`.
- `apps/web/src/components/ServerFacts.tsx`: the three `<div data-testid="server-facts-*" className="flex flex-col gap-1">` wrappers with literal `<h3>` headings became three `<InsetGroup title="..." data-testid="server-facts-*">` blocks; the three literal `<h3>` elements were deleted (`InsetGroup` renders its own). The outer container's gap changed from `gap-8` to `gap-6` (D-04's 24px between-group rule) -- see key-decisions.
- `apps/web/src/components/SettingsGroups.tsx`: the `Instance` `<section>` with its literal `<h2>` became `<InsetGroup title="Instance" data-testid="settings-instance-group">`; the `Advanced` `Disclosure`'s disclosed content is now wrapped in an untitled `InsetGroup` (the `Disclosure`'s own trigger, `aria-expanded` toggle and collapse/expand behaviour are completely untouched -- the group block sits inside the disclosed content, it does not replace or swallow the trigger).
- `apps/web/src/components/ServerList.tsx`: the previously-separate empty-state branch (`EmptyState` replacing the whole screen) and populated-list branch (`<div data-testid="servers-list">`) were merged into one `<InsetGroup data-testid="servers-list">` whose children are either the single `EmptyState` (unchanged copy/testid) or the mapped `ServerRow`s -- the loading and error branches are entirely unchanged.

## Task Commits

Each task was committed atomically (RED then GREEN):

1. **Task 1: InsetGroup component**
   - `0c9dc1c` (test) -- failing InsetGroup component tests
   - `1a34daf` (feat) -- InsetGroup implemented, exported from the barrel
2. **Task 2: Wrap server detail and settings groups**
   - `458bd61` (test) -- failing InsetGroup wrapper tests for ServerFacts/SettingsGroups
   - `a784755` (feat) -- ServerFacts/SettingsGroups wrapped in InsetGroup
3. **Task 3: The servers list becomes one inset group**
   - `1094b18` (test) -- failing InsetGroup wrapper test for ServerList
   - `fe3faf7` (feat) -- ServerList merged into a single InsetGroup block

_No plan-metadata commit yet -- this SUMMARY.md and the STATE/ROADMAP updates are committed separately, per the executor's final-commit step._

## Files Created/Modified

- `packages/ui/src/InsetGroup.tsx` - the grouped-inset surface wrapper (new)
- `packages/ui/src/InsetGroup.test.tsx` - 6 tests: title/no-title, block classes, row separators, testid-on-block, documented no-nesting invariant (new)
- `packages/ui/src/index.ts` - `InsetGroup`/`InsetGroupProps` export added alphabetically
- `apps/web/src/components/ServerFacts.tsx` - three groups now `InsetGroup`, outer gap `gap-8` -> `gap-6`
- `apps/web/src/components/ServerFacts.test.tsx` - 2 new tests: InsetGroup wrapper/heading assertions, 24px-gap class assertion
- `apps/web/src/components/SettingsGroups.tsx` - `Instance` now `InsetGroup`, `Advanced` disclosed content wrapped in an untitled `InsetGroup`, outer gap `gap-12` -> `gap-6`
- `apps/web/src/components/SettingsGroups.test.tsx` - 1 new test: InsetGroup wrapper/heading assertions, Disclosure trigger still functions
- `apps/web/src/components/ServerList.tsx` - empty and populated branches merged into one `InsetGroup`
- `apps/web/src/components/ServerList.test.tsx` - 2 new tests: empty state inside the block, populated rows inside the block

## Decisions Made

See `key-decisions` in the frontmatter above for the full rationale on: (1) the `gap-12` -> `gap-6` change in `SettingsGroups.tsx` (not explicitly named per-component in the plan's action text, but required by 08-UI-SPEC.md §1's general 24px rule and Task 2's own behaviour bullet), (2) why `InsetGroup`'s no-nesting rule is documented rather than runtime-thrown, and (3) why UI-11/UI-12 are not marked complete.

## Deviations from Plan

### Auto-fixed Issues

None — no bugs, missing critical functionality, or blocking issues were found. The `gap-12`/`gap-6` interpretation above is a scope judgment call (documented in key-decisions), not a bug fix, so it is not logged as a Rule 1/2/3 auto-fix.

## Issues Encountered

- **Stated-fact discrepancy in the plan's own acceptance criteria (not a code bug):** Task 3's acceptance criteria states `grep -c "servers-list" apps/web/src/components/ServerList.tsx` should return `1`. The real count is `2`: the block's own `data-testid="servers-list"` (the intended match) plus this file's own pre-existing header comment ("The servers-list screen's own list body ..."), which already existed, unchanged, before this plan touched the file (verified against the pre-plan commit `aa19e83`). This is the same category of stated-fact error 08-03-SUMMARY.md documented for the backdrop-filter budget narrative (Rule 1: fixing an incorrect stated fact discovered during execution) -- the header comment is legitimate prose unrelated to the InsetGroup wrapper change, so it was left as-is rather than reworded solely to satisfy a literal grep count. The actual intent of the acceptance criterion (the block-level testid is not duplicated) holds: `grep -n "servers-list"` shows exactly one match at the JSX attribute, one at line 1's prose.

## Rules not satisfied

None. TDD RED->GREEN was followed for all three tasks. `pnpm typecheck`, `pnpm lint`, `pnpm test` (2623/2623) and `pnpm check:ui-safety` (eleven `OK` lines, shadow gate still `count=0`) are all green. Docker Desktop was running; `pnpm test:e2e -- --grep "server-detail|settings"` and the full `pnpm test:e2e` were both run for real against the genuine stack -- 107/107 passed in both runs (the `--grep` invocation matched the full suite rather than a subset, but the result satisfies and exceeds Task 2's acceptance criterion either way).

## Hard Git Rules Compliance

- No `git stash` was run at any point (`git stash list` is empty, verified before and after this plan's work).
- No `git add .`/`-A`/`-u`, `git commit -a`, `git reset --hard`, `git clean`, or blanket `git checkout --`/`git restore` was run on paths not created by this plan.
- Every commit staged explicit paths inside `noodara/code/` only; `git status --porcelain` was checked before every commit to confirm only intended files were staged. The parent monorepo's unrelated `cv-executor`/`intervuee` changes, `.DS_Store`, `docs/ui-build-prompt.md`, `docs/ui/review/` and every other untracked path outside this plan's scope were never staged or touched.
- All six commits use Conventional Commits, English, `(08-05)` scope, no `Co-Authored-By` or AI-attribution trailer -- verified after each commit with `git log -1 --format='%(trailers)'` printing nothing.
- No push, no branch created; all work is on `main` in the local monorepo.

## User Setup Required

None - no external service configuration required.

## Verification

- `pnpm exec vitest run packages/ui/src/InsetGroup.test.tsx` -- 6/6 passing.
- `pnpm exec vitest run apps/web/src/components/ServerFacts.test.tsx apps/web/src/components/SettingsGroups.test.tsx` -- 17/17 passing.
- `pnpm exec vitest run apps/web/src/components/ServerList.test.tsx` -- 8/8 passing.
- `pnpm test` -- 2623/2623 passing (158 test files), no regression.
- `pnpm test:e2e -- --grep "server-detail|settings"` -- 107/107 passing (grep matched the full suite; still a genuine, real-stack run).
- `pnpm test:e2e` (full suite) -- 107/107 passing.
- `pnpm check:ui-safety` -- exits 0, eleven `OK` lines, shadow-outside-allowlist gate still `count=0`.
- `pnpm lint` -- all 9 turbo tasks green.
- `pnpm typecheck` -- all 8 turbo tasks green.
- Acceptance-criteria greps (Task 1): shadow pattern `count=0`, `rounded-lg` `count=1`, `bg-surface-1` `count=1`, `InsetGroup` in `index.ts` `count=1`.
- Acceptance-criteria greps (Task 2): `InsetGroup` in `ServerFacts.tsx` `count=7` (>=3), `<h3` `count=0`, the three `server-facts-*` testids `count=3`, `Disclosure` in `SettingsGroups.tsx` `count=4` (>=1).
- Acceptance-criteria greps (Task 3): `InsetGroup` in `ServerList.tsx` `count=3` (>=1), `servers-empty` `count=1`, `servers-list` `count=2` (plan expected 1 -- see Issues Encountered for why this is a pre-existing stated-fact discrepancy, not a defect introduced here).

## Next Phase Readiness

- `InsetGroup` is ready for any later plan in this phase that needs the grouped-inset treatment; no other screen is touched by this plan (Activity, stat tile row and Sheet/Dialog bodies remain explicitly out of scope per 08-UI-SPEC.md §1's "Not applied to").
- Server detail, Settings and the servers list now read as grouped inset lists with the row contract (44px rows, `LabelValue` padding, testids, typographic roles) completely unchanged -- G2 (08-CONTEXT.md D-13) is the next point a human reviews this direction alongside the rest of P0's surface work.
- No blockers for the next plan in this wave.

---
*Phase: 08-redise-o-de-la-app*
*Completed: 2026-09-26*

## Self-Check: PASSED

All 10 claimed files verified present on disk (`packages/ui/src/InsetGroup.tsx`,
`packages/ui/src/InsetGroup.test.tsx`, `packages/ui/src/index.ts`,
`apps/web/src/components/ServerFacts.tsx`, `apps/web/src/components/ServerFacts.test.tsx`,
`apps/web/src/components/SettingsGroups.tsx`, `apps/web/src/components/SettingsGroups.test.tsx`,
`apps/web/src/components/ServerList.tsx`, `apps/web/src/components/ServerList.test.tsx`, this
SUMMARY.md). All 6 commit hashes (`0c9dc1c`, `1a34daf`, `458bd61`, `a784755`, `1094b18`, `fe3faf7`)
verified present in `git log --oneline --all`. No missing items.
