---
phase: 08-redise-o-de-la-app
plan: 10
subsystem: ui
tags: [scroll-edge, accessibility, react, playwright, css]

# Dependency graph
requires:
  - phase: 08-redise-o-de-la-app
    provides: "08-06: the exact arbitrary-variant form for prefers-reduced-transparency/prefers-contrast: more this plan reuses verbatim on the toolbar"
provides:
  - "apps/web/src/components/Toolbar.tsx: window-scroll-driven border-transparent/border-hairline toggle replacing the permanent border-b border-hairline, motion-safe-gated transition-colors, prefers-reduced-transparency (solid bg-surface-1 + backdrop-filter:none) and contrast-more (opaque bg-surface-1 + border-hairline-strong once scrolled) fallbacks"
  - "apps/web/src/components/Toolbar.test.tsx: the toolbar's first component test file -- prop contract (unchanged), scroll-driven class toggle, both accessibility fallbacks"
  - "tests/e2e/servers-list.spec.ts: a new @scroll-edge test proving both edge states via the real computed border-bottom-color"
affects: ["08-11", "08-14"]

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "Scroll-driven chrome state read from window.scrollY via a plain passive `scroll` listener, not an IntersectionObserver sentinel -- (shell)/layout.tsx's `main` carries no overflow-y-auto of its own, so window/document is what actually scrolls here; the listener is synced once on mount (covers a page loading already scrolled, e.g. back-forward cache) and removed on unmount, with the scroll boolean staying entirely local to Toolbar.tsx rather than pushed into ShellContext (T-08-29)."
    - "The same arbitrary-variant forms Sheet.tsx established in 08-06 (`[@media(prefers-reduced-transparency:reduce)]:...`, `contrast-more:...`) reused verbatim on a fourth surface -- one consistent expression across the repo, not a second style."
    - "jsdom scroll-state component tests drive the real listener through `fireEvent.scroll(window)` after stubbing `window.scrollY` with `Object.defineProperty` (jsdom's own scrollY is always 0 and read-only) -- `fireEvent` wraps the dispatch in `act()`, unlike a raw `window.dispatchEvent` call, which left the state update unobserved by the test's synchronous assertion."

key-files:
  created: []
  modified:
    - apps/web/src/components/Toolbar.tsx
    - apps/web/src/components/Toolbar.test.tsx
    - tests/e2e/servers-list.spec.ts

key-decisions:
  - "UI-07 is NOT marked complete. Its full REQUIREMENTS.md text bundles five things (toolbar scroll-edge, RowMenu/Tooltip origin-anchored scale, Dialog center scale, Disclosure grid-template-rows, discovery/list 40ms stagger) -- this plan closes only the toolbar piece; the other four are separate later plans' scope (08-14's motion-contract sweep, 08-16's stagger work). requirements-completed is [] below, matching 08-06/08-07/08-08/08-09's own established precedent of not marking a bundled requirement complete until every sub-clause is."
  - "UI-10 is NOT marked complete, and this is a real gap, not a formality. Its full text bundles four sub-criteria: (1) three intentional fallbacks on toolbar/sheet/dialog/menu, (2) hover gated behind (hover: hover) and (pointer: fine) app-wide, (3) at most three simultaneous backdrop-filter surfaces. This plan satisfies (1) for the toolbar (its two remaining `hover:` utilities notwithstanding -- see below) and (3) stays true. But Toolbar.tsx's own two ungated `hover:` utilities (`hover:text-ink` on the backLink, `hover:bg-surface-2` on the mobile menu button) were left untouched: neither this plan's own task text nor its files_modified list named hover-gating as in scope (unlike 08-06's Task 2, whose action text explicitly named ListRow's hover treatment as Rule 2 in-scope work), and the Scope Boundary rule (\"only auto-fix issues directly caused by the current task's changes\") means a pre-existing, untouched hover declaration is not this plan's to silently fix. Left as an honest gap for the next plan/G2 review, not silently marked done."
  - "The plan's own Task 1 acceptance criteria and must_haves state the backdrop-filter budget gate should report count=2 once this plan lands. The real, already-corrected count is 3 (Toolbar + ServerDetailToolbar + Sheet), documented by 08-03-SUMMARY.md and re-confirmed unchanged by 08-06-SUMMARY.md before this plan touched anything -- the gate's own comparator is `total <= 3`, not an exact-2 check. This plan adds zero new backdrop-filter declarations (Toolbar keeps its one, pre-existing backdrop-blur), so the count is unchanged at 3 after this plan too. Carried forward as the same Rule 1 stated-fact correction 08-06 already made, not re-litigated as a new finding."
  - "ServerDetailToolbar.tsx (the server-detail screen's own toolbar) was deliberately left untouched, exactly as the plan's files_modified list (which names only Toolbar.tsx) instructs. It still carries a permanent border-b border-hairline and its own backdrop-blur, with zero prefers-reduced-transparency/contrast-more/reduced-motion fallbacks -- a real, visible inconsistency against Toolbar.tsx's new scroll-edge behaviour (05-UI-SPEC.md SS2.5 explains why this component is deliberately not built on the shared Toolbar in the first place: it overrides the title role/size for the server's own name + StatusPill). Flagged here, as the project rules ask, so 08-11's G2 visual review can judge whether ServerDetailToolbar should get the same treatment in a later plan or whether its permanent border is an intentional exception."
  - "Task 1's TDD RED commit and Task 2's TDD RED assertions share one test file commit rather than two separate RED commits -- Toolbar.test.tsx was written once, covering both tasks' behaviours together, then verified RED (8 prop-contract tests already passing against the untouched contract, 6 new-behaviour tests failing for the right reason), then two incremental GREEN commits (Task 1's scroll-edge, Task 2's fallbacks) each independently re-verified against the same file. This is a variation on -- not a violation of -- fail-fast TDD: every behaviour assertion was written and confirmed failing before any implementation existed for it, and each GREEN commit only turned exactly its own task's subset of assertions green (Task 1's GREEN commit still left the two Task-2 fallback assertions failing, confirmed by re-running the suite before committing Task 2)."

patterns-established: []

requirements-completed: []

# Metrics
duration: ~50min
completed: 2026-09-26
---

# Phase 8 Plan 10: Toolbar scroll edge and accessibility fallbacks Summary

**The toolbar's permanent 1px border is now a window-scroll-driven toggle (transparent at the top, `border-hairline` the instant content passes under it) with `prefers-reduced-transparency`/`prefers-contrast: more` fallbacks reusing Sheet's exact arbitrary-variant form, proven both at the component level (jsdom) and in a real browser via the computed `border-bottom-color`.**

## Performance

- **Duration:** ~50 min
- **Completed:** 2026-09-26
- **Tasks:** 3
- **Files modified:** 3 (0 created, 3 modified)

## Accomplishments

- `Toolbar.tsx` gained a `useScrolled()` hook: a passive `scroll` listener on `window` (the app's real scroll container here -- `(shell)/layout.tsx`'s `main` carries no `overflow-y-auto` of its own), synced once on mount and cleaned up on unmount, driving `border-transparent` at the top of the page and `border-hairline` the instant `scrollY` exceeds 0. The colour swap transitions via `motion-safe:transition-colors` at `--duration-panel`/`--ease-out`, so it degrades to an instant swap under `prefers-reduced-motion: reduce` with no separate motion-reduce class needed. Every existing `ToolbarProps` behaviour (`title`, `backLink`-vs-menu-button branch, single `primaryAction` slot, `secondaryActions`, `StreamStatus` from `ShellContext`) is byte-for-byte unchanged, proven by 5 new prop-contract tests that already passed against the pre-plan code.
- `Toolbar.tsx` gained the same three arbitrary-variant fallback forms `packages/ui/src/Sheet.tsx` established in 08-06: `prefers-reduced-transparency: reduce` drops the translucent `bg-surface-1/90 backdrop-blur` to a fully solid `bg-surface-1` with `backdrop-filter: none` (the arbitrary-property form, since Tailwind composes the blur utility into a shorthand); `contrast-more:` pushes the background fully opaque and, once scrolled, swaps the hairline for `border-hairline-strong` (the unscrolled state stays transparent even under contrast-more -- there is deliberately no permanent line at the very top to strengthen).
- `tests/e2e/servers-list.spec.ts` gained one new `@scroll-edge` test: 20 seeded rows (route-interception fixture, same pattern the existing populated-rows test already uses) at a shrunk 1024×400 viewport, asserting the toolbar's real computed `border-bottom-color` alpha channel is `0` at scroll-top, becomes non-zero after `page.mouse.wheel`, and returns to `0` scrolling back up.

## Task Commits

Each task was committed atomically:

1. **Task 1: Scroll edge effect replaces the permanent border**
   - `974cabb` (test) -- failing spec covering both this task's scroll-toggle behaviour and Task 2's fallback assertions (written together in one file, see key-decisions)
   - `469e39b` (feat) -- `useScrolled()` hook, `border-transparent`/`border-hairline` toggle, `motion-safe:transition-colors`
2. **Task 2: Toolbar accessibility alternatives**
   - `5fc4c73` (feat) -- `prefers-reduced-transparency` and `contrast-more` fallbacks on `BASE_CLASSES`, turning the two Task-2 assertions left over from `974cabb` green
3. **Task 3: Browser-level proof of both edge states**
   - `6556b40` (test) -- `@scroll-edge` Playwright case in `tests/e2e/servers-list.spec.ts`, passing immediately since the underlying behaviour already existed from Tasks 1/2 (a verification-only commit, matching 08-09's Task 1/2 split where a test-only task can be pure confirmation rather than a RED-then-fix cycle)

**Plan metadata:** (this commit) -- docs: complete plan

## Files Created/Modified

- `apps/web/src/components/Toolbar.tsx` - `useScrolled()` hook, scroll-driven border toggle, `motion-safe:` transition, `prefers-reduced-transparency`/`contrast-more` fallbacks on `BASE_CLASSES`
- `apps/web/src/components/Toolbar.test.tsx` - new file: prop contract (5 tests), scroll edge (6 tests), accessibility alternatives (3 tests)
- `tests/e2e/servers-list.spec.ts` - one new `@scroll-edge` test, existing tests untouched

## Decisions Made

See `key-decisions` in the frontmatter above for the full rationale on: (1) UI-07 left pending (bundled requirement, only the toolbar sub-clause done here), (2) UI-10 left pending -- a real, named gap (Toolbar's own two `hover:` utilities are still ungated), not a formality, (3) the backdrop-filter-budget count-2-vs-3 discrepancy carried forward from 08-03/08-06, (4) `ServerDetailToolbar.tsx` deliberately untouched and flagged for 08-11's G2, (5) the combined-test-file TDD variation for Tasks 1/2.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] Task 1's own acceptance criteria/must_haves state the backdrop-filter gate should report `count=2`; the real, already-corrected count is 3**
- **Found during:** Task 1 verification
- **Issue:** Same discrepancy 08-06-SUMMARY.md already documented before this plan started: the real repo-wide count is 3 (`Toolbar.tsx`, `ServerDetailToolbar.tsx`, `Sheet.tsx`), not the 2 this plan's own frontmatter states, and the gate's comparator (`total <= 3`) was already calibrated to that real ceiling.
- **Fix:** Verified `pnpm check:ui-safety` reports `count=3` (not 2) and exits 0 -- no gate code changed, this plan adds zero new `backdrop-filter` declarations.
- **Files modified:** None (verification-only).
- **Verification:** `pnpm check:ui-safety` output: `OK at most three simultaneous backdrop-filter surfaces ... (count=3)`.
- **Committed in:** N/A (no code change needed).

**2. [Rule 1 - Bug] A raw `window.dispatchEvent(new Event('scroll'))` in the test file left the component's `setScrolled` update unobserved by the following synchronous assertion**
- **Found during:** Implementing Task 1's GREEN commit, verifying against the RED test
- **Issue:** React Testing Library only auto-wraps its own `fireEvent`/`userEvent` helpers in `act()`; a plain native `window.dispatchEvent` call bypasses that, so the state update scheduled inside the native `scroll` listener was not guaranteed to have flushed before the test's `expect` ran.
- **Fix:** Replaced the manual `window.dispatchEvent` helper with `fireEvent.scroll(window)` (re-exported from `@noodara/ui/testing`), which wraps the dispatch in `act()`.
- **Files modified:** `apps/web/src/components/Toolbar.test.tsx`
- **Committed in:** `469e39b` (same commit as Task 1's GREEN implementation, since the test file needed this fix to correctly exercise the real behaviour it was already asserting)

---

**Total deviations:** 2 (1 stated-fact correction carried forward from 08-03/08-06, 1 test-infrastructure bug found and fixed while making the RED test honestly exercise the real listener).

## Rules Not Satisfied

- **UI-10 is not fully satisfied.** Its full text requires hover gated behind `(hover: hover) and (pointer: fine)` app-wide. `Toolbar.tsx` still has two ungated `hover:` utilities (`hover:text-ink` on the backLink, `hover:bg-surface-2` on the mobile menu button) that predate this plan and were not named in this plan's task text as in-scope work (unlike 08-06's Task 2, which explicitly named `ListRow`'s hover treatment). Per the Scope Boundary rule, an untouched pre-existing declaration outside this plan's own task text is not auto-fixed here -- logged as a real gap, not silently marked done. `requirements-completed` is `[]` for both UI-07 and UI-10, matching the honest-assessment instruction.
- **`ServerDetailToolbar.tsx` still has no scroll-edge effect or any of the three fallbacks.** Left untouched per the plan's own `files_modified` scope; flagged for 08-11's G2 review to decide whether it needs the same treatment or is an intentional exception (05-UI-SPEC.md SS2.5 already documents why it is not built on the shared `Toolbar` component).

## Hard Git Rules Compliance

- No `git stash` was run at any point (`git stash list` is empty, verified before and after this plan's work).
- No `git add .`/`-A`/`-u`, `git commit -a`, `git reset --hard`, `git clean`, or blanket `git checkout --`/`git restore` was run on any path.
- Every commit staged explicit paths inside `noodara/code/` only; `git status --porcelain` was checked before every commit. The parent monorepo's unrelated `cv-executor`/`intervuee` changes, `.DS_Store`, `docs/ui-build-prompt.md` and every other untracked/modified path outside this plan's scope were never staged or touched.
- All four commits use Conventional Commits, English, `(08-10)` scope, no `Co-Authored-By` or AI-attribution trailer of any kind -- verified after each commit with `git log -1 --format='%(trailers)'` printing nothing.
- No push, no branch created; all work is on `main` in the local monorepo.

## User Setup Required

None - no external service configuration required.

## Verification

- `pnpm exec vitest run apps/web/src/components/Toolbar.test.tsx` -- 14/14 passing.
- `pnpm test` (full suite) -- 2682/2682 passing (162 test files), no regression.
- `pnpm test:e2e -- --grep @scroll-edge` (via `pnpm run test:e2e --grep @scroll-edge`, since `pnpm <script> -- <args>` inserts a spurious extra `--` in this pnpm version -- `pnpm run <script> <args>` is the working form) -- 1/1 passing.
- `pnpm test:e2e` (full suite, real stack, Docker Desktop running) -- 118/118 passing (117 pre-existing + 1 new `@scroll-edge`).
- `pnpm check:ui-safety` -- exits 0, eleven `OK` lines, backdrop-filter budget gate `count=3` (unchanged, see Deviations).
- `pnpm lint` -- all 9 turbo tasks green.
- `pnpm typecheck` (full, including `tests/e2e/tsconfig.json`) -- all tasks green, exit 0.
- Acceptance-criteria greps (Task 1): `border-transparent` count=1, `transition-all`/`transition: all` count=0, `backdrop-blur` count=1, `primaryAction?: ReactNode` count=1 in `Toolbar.tsx`.
- Acceptance-criteria greps (Task 2): `prefers-reduced-transparency` count=3, `prefers-contrast` count=1, `motion-safe:` count=1, `border-hairline-strong` count=1 in `Toolbar.tsx`.

## Next Phase Readiness

- The toolbar now genuinely matches the doctrine's scroll-edge contract and carries the same three accessibility fallbacks Sheet/Dialog/RowMenu/AccountMenu already have -- ready for 08-11's G2 visual gate to review it live (in both themes, at real scroll speed).
- Two honest gaps carried forward for 08-11/later plans to see and decide on: (1) `Toolbar.tsx`'s own two ungated `hover:` utilities, (2) `ServerDetailToolbar.tsx`'s untouched permanent border and zero fallbacks.
- No blockers for the next plan in this wave.

---
*Phase: 08-redise-o-de-la-app*
*Completed: 2026-09-26*

## Self-Check: PASSED

All 4 claimed files verified present on disk (`apps/web/src/components/Toolbar.tsx`,
`apps/web/src/components/Toolbar.test.tsx`, `tests/e2e/servers-list.spec.ts`, this SUMMARY.md).
All 4 commit hashes (`974cabb`, `469e39b`, `5fc4c73`, `6556b40`) verified present in
`git log --oneline --all`. No missing items.
