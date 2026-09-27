---
phase: 09-settings-editables
plan: 14
subsystem: ui
tags: [ux-review, playwright, radix-dialog, sheet, navtree, accessibility]

requires:
  - phase: 09-settings-editables plan 13
    provides: "tests/e2e/settings.spec.ts's nine @settings E2E tests proving all five ROADMAP Phase 9 success criteria"
  - phase: 08-redise-o-de-la-app
    provides: "InsetGroup, Sheet, RowMenu, NavTree, the floating-elevation shell this plan's mobile fixes build on"
provides:
  - "docs/ui-reviews/settings-editables-2026-09.md -- nine-dimension noodara-ux-review audit, PASS verdict, one FLAG found and fixed pre-verdict"
  - "docs/ui/APPROVAL.md's 'Phase 9 -- Settings editables' block -- human visual approval recorded after one adjustment round"
  - "RowMenu.tsx rendering its open content through a DialogPrimitive.Portal at a fixed, viewport-measured position instead of an absolute child clipped by InsetGroup's overflow-hidden"
  - "Sheet.tsx's panel as w-full max-w-[480px] (was a fixed w-[480px]) with drag-dismiss thresholds reading the panel's own measured width"
  - "NavTree.tsx showing labels in the <900px hamburger drawer again (previously hidden below 1280px)"
affects: [10-sitio-de-docs-y-landing-p-blica]

tech-stack:
  added: []
  patterns:
    - "Mobile-viewport human review (real iPhone 16 Pro Max, CSS 440x956) as a distinct verification pass from the desktop/375px synthetic captures pnpm ui:review produces -- caught three defects the synthetic matrix missed"
    - "RowMenu/AccountMenu overlay content now shares one convention: DialogPrimitive.Portal + position: fixed measured from the trigger's getBoundingClientRect(), flipping upward when there is no room below"

key-files:
  created:
    - .planning/phases/09-settings-editables/09-14-SUMMARY.md
  modified:
    - docs/ui-reviews/settings-editables-2026-09.md
    - docs/ui/APPROVAL.md
    - apps/web/src/components/SettingsGroups.tsx
    - apps/web/src/components/SettingsGroups.test.tsx
    - packages/ui/src/RowMenu.tsx
    - packages/ui/src/RowMenu.test.tsx
    - packages/ui/src/Sheet.tsx
    - packages/ui/src/Sheet.test.tsx
    - packages/ui/src/NavTree.tsx
    - packages/ui/src/NavTree.test.tsx
    - tests/e2e/servers-list.spec.ts
    - tests/e2e/server-sheet.spec.ts
    - tests/e2e/shell.spec.ts

key-decisions:
  - "Task 1's one FLAG (Dimension 4, layout/spacing): SettingsGroups.tsx's Account rows never adopted ListRow.tsx's own min-w-0/flex-1/truncate/shrink-0 convention, causing the Email row's label to truncate to 'Em...' and its value to wrap at 375px. Fixed in the owning file, TDD (RED 7acb2a7, GREEN 2de4c83), before the report's verdict was finalized."
  - "Round 1's three mobile defects were found by the human reviewer on real hardware (iPhone 16 Pro Max, CSS 440x956) after the initial approval request -- not by the pnpm ui:review synthetic capture matrix, which stops at 375px. All three trace to shell/servers components from Phase 8, not to this plan's own Account/Appearance settings work, but were in scope to fix per the checkpoint's up-to-two-rounds allowance."
  - "RowMenu's fix reuses the same DialogPrimitive.Portal + measured-position pattern AccountMenu.tsx already established, rather than introducing a new primitive or a CSS-only fix -- keeps the two overlay components on one convention."
  - "Sheet's PANEL_WIDTH_PX=480 constant is kept as the jsdom/unmeasurable fallback; the real drag-dismiss threshold and closing-animation target now read the panel's own getBoundingClientRect().width so a phone-width panel's threshold tracks its own actual width."

patterns-established:
  - "Overlay content (RowMenu, AccountMenu) always portals to document.body with position: fixed measured from the trigger, never an absolute descendant of a card with overflow-hidden."
  - "Sheet panel width is w-full max-w-[480px], not a fixed px value -- any future full-height panel must follow the same responsive-cap pattern."

requirements-completed: [SET-02, SET-03, SET-04, SET-05, SET-06]

duration: ~90min (Task 1 audit/fix + gate) + human checkpoint + round-1 adjustment + this closing session
completed: 2026-09-27
---

# Phase 9 Plan 14: UX review, full gate and human visual approval Summary

**Nine-dimension noodara-ux-review audit of /settings and /login (one FLAG found and fixed pre-verdict), a full green quality gate, and human visual approval after one adjustment round that fixed three mobile-only defects in RowMenu, Sheet and NavTree found on a real iPhone 16 Pro Max.**

## Performance

- **Duration:** ~90 min for Task 1 (audit, fix, full gate) plus the human checkpoint round trip (round 1 adjustment: RowMenu portal, Sheet responsive width, NavTree label visibility) and this closing session (APPROVAL.md block, this summary, state updates)
- **Started:** 2026-09-27 (Task 1)
- **Completed:** 2026-09-27
- **Tasks:** 2 (Task 1 auto; Task 2 checkpoint:human-verify, approved after round 1)
- **Files modified:** 13 (1 created — this summary)

## Accomplishments
- `docs/ui-reviews/settings-editables-2026-09.md`: all nine noodara-ux-review dimensions verdicted, global **PASS**, zero BLOCK; the one FLAG (Dimension 4, Account row label truncation at 375px) fixed in `SettingsGroups.tsx` before the verdict was finalized (TDD: RED `7acb2a7`, GREEN `2de4c83`)
- Full automated gate green on the Task 1 tree: lint (9/9), typecheck (all packages), unit 2989/2989 (175 files), integration 578/578 (1 skipped), full Playwright 171/171 (twice: pre-fix and post-fix), boundaries 744 files/0 issues, `security:scan-leaks` 4/4 vitest + 1/1 Playwright canary, `check:ui-safety` 12/12 static gates
- Security review (noodara-security checklist): no password/hash/token in logs, `ActivityEvent`, or responses; explicit 3s DNS-lookup timeout; backend-enforced actor-scoped mutations (`.strict()` Zod schemas with no client-supplied `userId`); `noodara-prefs` cookie carries only three enums — recorded in the report, no new threat surface beyond T-09-03/T-09-36
- Human reviewer walked all 8 verification steps on a real iPhone 16 Pro Max and found three mobile-only defects, unrelated to this plan's own Account/Appearance work but in shared shell/servers components: RowMenu clipped by an `overflow-hidden` ancestor at 440px, `Sheet`'s fixed 480px panel overflowing a 440px viewport, and `NavTree` hiding labels in the <900px hamburger drawer
- All three fixed with TDD in their owning files (round 1, commits `48e2d35`..`5faf1b2`, report updated `3cbb884`, one spec assertion corrected `461245d`) and re-verified against the running dev stack; reviewer's final reply: "Listo, todo bien ahora. De lujo" (approved)
- `docs/ui/APPROVAL.md` gained the "Phase 9 — Settings editables" block (date 2026-09-27, 1 round used, approver Pablo Gutierrez, evidence path, full adjustment log including the open backlog note on truncated server rows at 440px)

## Task Commits

1. **Task 1: UX review audit, captures, fixes and the full phase gate**
   - `7acb2a7` test — failing test for Account row label truncation at 375px
   - `2de4c83` fix — `SettingsGroups.tsx` adopts `ListRow`'s min-w-0/flex-1/truncate/shrink-0 convention
   - `034a91c` docs — `docs/ui-reviews/settings-editables-2026-09.md` (audit report, PASS verdict, gate summary)
2. **Task 2: Human visual approval (checkpoint, approved after round 1)**
   - `48e2d35` test / `6f522c8` fix — NavTree label visibility in the <900px drawer
   - `93ef31b` test / `1c339bb` fix — Sheet responsive width (`w-full max-w-[480px]`) and measured drag threshold
   - `451be64` test / `a186e66` fix — RowMenu portal + fixed, viewport-measured positioning
   - `5faf1b2` test — three unrun E2E specs proving the three round-1 fixes
   - `3cbb884` docs — report gained the "Adjustment round 1" section
   - `461245d` test — corrected one spec's row-menu assertion to match the row's exact primary text
   - `39ff610` docs — this closing session's `docs/ui/APPROVAL.md` "Phase 9" block

**Plan metadata:** this commit (docs: plan 14 summary, part of this closing session)

## Files Created/Modified
- `docs/ui-reviews/settings-editables-2026-09.md` - the nine-dimension audit report, PASS verdict, security review, gate summary, adjustment round 1 log
- `docs/ui/APPROVAL.md` - new "Phase 9 — Settings editables" block
- `apps/web/src/components/SettingsGroups.tsx` / `.test.tsx` - Account row label/value now truncate defensively instead of wrapping at 375px
- `packages/ui/src/RowMenu.tsx` / `.test.tsx` - open content renders through a `DialogPrimitive.Portal` at a fixed, trigger-measured position
- `packages/ui/src/Sheet.tsx` / `.test.tsx` - panel is `w-full max-w-[480px]`, drag threshold reads the panel's real measured width
- `packages/ui/src/NavTree.tsx` / `.test.tsx` - label visible by default, hidden only in the 900-1279px icon rail
- `tests/e2e/servers-list.spec.ts`, `tests/e2e/server-sheet.spec.ts`, `tests/e2e/shell.spec.ts` - new/updated `@rowmenu`/`@sheet`/`@shell` specs for the three round-1 fixes at a 440x956 mobile viewport

## Decisions Made
See `key-decisions` in the frontmatter above: the Task 1 FLAG fix (Rule 1, defensive truncation missing), and the three round-1 mobile fixes (RowMenu portal reusing AccountMenu's existing convention, Sheet's responsive-cap width, NavTree's drawer-label visibility range).

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] Account row label/value wrapped and truncated incorrectly at 375px**
- **Found during:** Task 1's 375px capture pass
- **Issue:** `SettingsGroups.tsx`'s Account rows lacked `ListRow.tsx`'s `min-w-0`/`flex-1`/`truncate`/`shrink-0` convention, so the Email row's label truncated to "Em…" and its value wrapped onto two lines, violating 09-UI-SPEC.md §5.6.
- **Fix:** Adopted the existing `ListRow` layout convention in `SettingsGroups.tsx`'s Account rows.
- **Files modified:** `apps/web/src/components/SettingsGroups.tsx`, `apps/web/src/components/SettingsGroups.test.tsx`
- **Verification:** Failing test first (`7acb2a7`), then the fix (`2de4c83`); re-captured at 375px in both themes, "Email" fully visible, value ellipsis-truncating on one line.
- **Committed in:** `7acb2a7` (test), `2de4c83` (fix)

**2. [Checkpoint adjustment round 1 — not a Rule 1-3 deviation, the plan's own sanctioned mechanism] Three mobile-only defects found by the human reviewer on real hardware, fixed in their owning shell/servers files**
- **Found during:** Task 2's human-verify checkpoint, step-by-step walkthrough on a real iPhone 16 Pro Max (440x956)
- **Issue:** (1) `RowMenu.tsx`'s absolute-positioned content was clipped by `InsetGroup`'s `overflow-hidden` ancestor at 440px, appearing to hide the row. (2) `Sheet.tsx`'s fixed `w-[480px]` panel overflowed a 440px viewport, cutting off labels and the close button. (3) `NavTree.tsx` hid labels everywhere below 1280px, including the <900px hamburger drawer where they were meant to remain visible.
- **Fix:** RowMenu content now renders through a `DialogPrimitive.Portal` at a fixed, trigger-measured position (viewport-aware, flips upward when needed). Sheet's panel is `w-full max-w-[480px]`, with the drag-dismiss threshold and closing-animation target reading the panel's real measured width. NavTree's label visibility range is `inline min-[900px]:hidden min-[1280px]:inline`.
- **Files modified:** `packages/ui/src/RowMenu.tsx`/`.test.tsx`, `packages/ui/src/Sheet.tsx`/`.test.tsx`, `packages/ui/src/NavTree.tsx`/`.test.tsx`, three E2E spec files
- **Verification:** TDD in each owning file (RED before GREEN for all three); re-verified visually against the running dev stack (before/after captures per fix, no regression at 900px/1280px); full unit suite 2993/2993 (175 files) green on the round-1 tree; lint/typecheck/boundaries/check:ui-safety all clean. `pnpm test:integration` and `pnpm test:e2e` were not re-run during the checkpoint itself (the reviewer's dev stack was live on the same ports); the orchestrator must run `pnpm test:e2e` on the final tree before closing the plan.
- **Committed in:** `451be64`/`a186e66` (RowMenu), `93ef31b`/`1c339bb` (Sheet), `48e2d35`/`6f522c8` (NavTree), `5faf1b2` (E2E specs), `3cbb884` (report update), `461245d` (spec assertion fix)

---

**Total deviations:** 1 Rule-1 auto-fix (Task 1) + 1 sanctioned checkpoint adjustment round (Task 2, three fixes, within the plan's own "up to two adjustment rounds" allowance — not a Rule 1-4 deviation)
**Impact on plan:** No scope creep. Both the Task 1 fix and the three round-1 fixes are corrections to existing Phase 8 components surfaced by this plan's own review/checkpoint process, not new features.

## Issues Encountered
None beyond the items documented above. The report's own gate-summary section notes that `pnpm test:integration` and `security:scan-leaks` were run once on the pre-fix Task 1 tree and reasoned to remain valid post-fix (the fix touches only a presentational file with no import path into integration-tested code); this reasoning is unchanged by round 1, whose three fixes are confined to `packages/ui` presentational components with the same property.

## User Setup Required
None - no external service configuration required.

## Next Phase Readiness
- Phase 9 (Settings editables) execution is complete: 14/14 plans, human visual approval recorded in `docs/ui/APPROVAL.md`, full automated gate green on the round-1 tree (unit 2993/2993, lint/typecheck/boundaries/check:ui-safety clean).
- Outstanding before phase close is declared by the orchestrator: `pnpm test:e2e` (full Playwright, including the three new round-1 specs) has not been re-run since the checkpoint's port-conflict constraint was lifted — the specs typecheck clean and are believed passing based on their pre-commit verification, but a fresh full E2E run on the final tree is the honest remaining gap.
- `.planning/phases/09-settings-editables/09-REVIEW.md` is being produced by a separate reviewer agent in parallel with this summary and is intentionally not read or modified here.
- One open, deferred, non-blocking backlog note carried into any future phase touching the servers list: at 440px the server row truncates the name to "t…" and the status pill to "Unreac" (Phase 8 row layout, not this phase's scope).

---
*Phase: 09-settings-editables*
*Completed: 2026-09-27*

## Self-Check: PASSED

All key files exist and all referenced commit hashes resolve in `git log` (verified via `git cat-file -e` against each hash below).
