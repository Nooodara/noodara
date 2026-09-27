---
phase: 09-settings-editables
plan: 12
subsystem: ui
tags: [react, radix, settings, appearance, preferences, typescript]

requires:
  - phase: 09-settings-editables plan 03
    provides: "--row-height/--row-height-padding-y density tokens"
  - phase: 09-settings-editables plan 04
    provides: "data-motion @custom-variant override"
  - phase: 09-settings-editables plan 07
    provides: "applyPreferences/readPreferencesMirror, SSR cookie mirror (D-09)"
  - phase: 09-settings-editables plan 08
    provides: "PATCH /api/account/preferences contract"
  - phase: 09-settings-editables plan 09
    provides: "POST /api/account/password contract ({ sessionsRevoked })"
  - phase: 09-settings-editables plan 10
    provides: "useSessionUser/useAccountPreferences/setStoredPreferences shared store"
  - phase: 09-settings-editables plan 11
    provides: "AccountProfileSheet, AccountPasswordSheet, passwordNoticeMessage"
provides:
  - "apps/web/src/lib/account-rows.ts -- EditableAccountRow type and accountRows(user)"
  - "apps/web/src/lib/appearance.ts -- updateAppearancePreference, the single Appearance write path"
  - "apps/web/src/components/SettingsGroups.tsx -- Account + Appearance + Instance + Advanced composition"
  - "SET-06/D-17's @ts-expect-error type-level proof that SettingsRow can never carry a handler"
affects: []

tech-stack:
  added: []
  patterns:
    - "SET-06/D-17 type separation: editable rows live in their own module/type (account-rows.ts's EditableAccountRow), never as an optional field bolted onto the read-only SettingsRow -- proven at compile time with three @ts-expect-error cases, not just a runtime assertion"
    - "Appearance controller (appearance.ts): optimistic apply+setStored before the PATCH, revert both on failure, re-sync setStored from the server response on success -- one small controller function every SegmentedControl calls into, injectable deps for pure unit testing"
    - "Trigger capture via event.currentTarget instead of a forwarded React ref: Button has no ref prop, so each Account row's onClick captures its own native button element into a RefObject<HTMLElement | null> before opening its Sheet, satisfying 09-UI-SPEC.md §5.2's focus-return contract without changing Button's API"

key-files:
  created:
    - apps/web/src/lib/account-rows.ts
    - apps/web/src/lib/appearance.ts
    - apps/web/src/lib/appearance.test.ts
  modified:
    - apps/web/src/lib/settings-rows.ts
    - apps/web/src/lib/settings-rows.test.ts
    - packages/ui/src/ThemeToggle.tsx
    - packages/ui/src/ThemeToggle.test.tsx
    - packages/ui/src/index.ts
    - apps/web/src/components/SettingsGroups.tsx
    - apps/web/src/components/SettingsGroups.test.tsx
    - apps/web/src/app/(shell)/settings/page.tsx
    - tests/e2e/shell.spec.ts
    - tests/e2e/settings.spec.ts

key-decisions:
  - "Button forwards no ref (ButtonProps deliberately excludes it) -- each Account row's Edit/Change button captures event.currentTarget into its own trigger ref inside the onClick handler itself, before setOpenField/setPasswordOpen runs, rather than adding ref-forwarding to Button just for this plan"
  - "appearance.ts's zero-deps default getCurrent reads readPreferencesMirror() then DEFAULT_PREFERENCES only -- it does not reach into session-user.ts's private store snapshot (that module exports no snapshot getter and is outside this plan's files_modified); SettingsGroups.tsx itself always calls updateAppearancePreference with no deps override, so the mirror-cookie fallback is the real behavior in production, matching the plan's own literal wording"
  - "shell.spec.ts's rewritten theme-control test now performs a real PATCH /api/account/preferences round trip (unlike the old ThemeToggle's localStorage-only click) against the shared, long-lived E2E admin account -- the test explicitly restores the Auto segment (and waits for that PATCH's response) before finishing, so it leaves no persisted state for sibling e2e spec files"
  - "settings.spec.ts's whole-screen 'zero form controls' test is rescoped to Instance/Advanced only (plus a radio-role ban) -- SET-01/SET-06's read-only guarantee was always specific to those two groups, and Account/Appearance are now deliberately interactive by design (SET-02/03/04/05)"

requirements-completed: [SET-02, SET-03, SET-04, SET-05, SET-06]

duration: ~20min
completed: 2026-09-27
---

# Phase 9 Plan 12: Settings composition (Account + Appearance) Summary

**`/settings` rewritten into four groups -- Account (Name/Email/Password Sheets + password Notice), Appearance (three SegmentedControls on one optimistic write path), Instance and Advanced -- with a compile-time proof that environment rows can never become editable, and the cyclic ThemeToggle button retired.**

## Performance

- **Duration:** ~20 min
- **Started:** 2026-09-27T04:25:50-06:00
- **Completed:** 2026-09-27T04:45:46-06:00
- **Tasks:** 3
- **Files modified:** 14 (3 created, 11 modified, excluding this SUMMARY)

## Accomplishments
- `apps/web/src/lib/account-rows.ts`: `EditableAccountRow`/`accountRows(user)`, a structurally distinct type from `SettingsRow` -- three `@ts-expect-error` cases in `settings-rows.test.ts` prove `onEdit`/`onChange` can never be added to `SettingsRow` and that `EditableAccountRow` itself is not assignable to it (SET-06/D-17), plus a manual RED check (removing one directive made `pnpm --filter @noodara/web typecheck` fail, confirming the directives are load-bearing, not decorative)
- `apps/web/src/lib/appearance.ts`: `updateAppearancePreference(key, value, deps?)` -- applies optimistically (`apply` then `setStored`) before the single-field `PATCH /api/account/preferences`, reverts both on failure with a fixed message, re-syncs `setStored` from the server's own response on success; injectable deps make every branch unit-testable without a real fetch
- `packages/ui/src/ThemeToggle.tsx`: the cyclic icon-button component, its `nextMode`/`MODE_LABEL`/`MODE_ICON` helpers and `ThemeToggleProps` are gone; `applyPreferences`/`readPreferencesMirror`/`STORAGE_KEY` remain the module's sole exports and the single write/read path every caller (now `appearance.ts`) routes through -- `index.ts` no longer exports `ThemeToggle`
- `apps/web/src/components/SettingsGroups.tsx`: rewritten to compose `Account` (three rows, per-row Sheet, password `Notice`), `Appearance` (Theme/Reduce motion/Density `SegmentedControl`s, a `Banner` on a failed save), and the unchanged `Instance`/`Advanced` groups, in that exact DOM order
- `tests/e2e/shell.spec.ts`'s theme test rewritten against `settings-theme-control`, and cleaned up to leave the shared E2E admin's preferences reset to `auto` afterward; `tests/e2e/settings.spec.ts`'s read-only assertion rescoped to Instance/Advanced now that Account/Appearance are intentionally interactive

## Task Commits

Each task followed RED -> GREEN:

1. **Task 1: SET-06 type separation**
   - `6d3e402` test(09-12): add failing tests for EditableAccountRow and SettingsRow type guard
   - `ee493d6` feat(09-12): add EditableAccountRow and accountRows for the Account group
2. **Task 2: Appearance controller, retire ThemeToggle**
   - `4521b50` test(09-12): add failing appearance controller tests, drop ThemeToggle cycle tests
   - `a09a305` feat(09-12): add appearance controller, retire the cyclic ThemeToggle button
3. **Task 3: SettingsGroups composition**
   - `aa485e5` test(09-12): add failing tests for the rewritten SettingsGroups and theme control e2e
   - `a2e72be` feat(09-12): compose Account and Appearance groups into SettingsGroups

## Files Created/Modified
- `apps/web/src/lib/account-rows.ts` - `EditableAccountRow`, `accountRows(user)`
- `apps/web/src/lib/settings-rows.ts` - header comment only, cites SET-06/D-17 and the sibling module
- `apps/web/src/lib/settings-rows.test.ts` - 3 `@ts-expect-error` type cases + `accountRows` unit tests
- `apps/web/src/lib/appearance.ts` - `updateAppearancePreference`, the single Appearance write path
- `apps/web/src/lib/appearance.test.ts` - 4 unit tests against injected fakes
- `packages/ui/src/ThemeToggle.tsx` - cyclic component removed; `applyPreferences`/`readPreferencesMirror` unchanged
- `packages/ui/src/ThemeToggle.test.tsx` - component-cycle tests dropped, `applyPreferences`/`readPreferencesMirror` coverage kept
- `packages/ui/src/index.ts` - `ThemeToggle`/`ThemeToggleProps` no longer exported
- `apps/web/src/components/SettingsGroups.tsx` - Account + Appearance + Instance + Advanced composition
- `apps/web/src/components/SettingsGroups.test.tsx` - 13 tests covering group order, Sheets, Notice, SegmentedControls, Banner-on-failure
- `apps/web/src/app/(shell)/settings/page.tsx` - header comment only
- `tests/e2e/shell.spec.ts` - theme test migrated to `settings-theme-control`, resets to Auto at the end
- `tests/e2e/settings.spec.ts` - read-only assertion rescoped to Instance/Advanced
- `.planning/phases/09-settings-editables/deferred-items.md` - logged a pre-existing, unrelated e2e failure (see Issues Encountered)

## Decisions Made
See `key-decisions` in the frontmatter above (trigger-ref-via-`event.currentTarget`, `appearance.ts`'s zero-deps fallback scope, the e2e theme test's own state cleanup, and `settings.spec.ts`'s rescoped assertion).

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] Rescoped `settings.spec.ts`'s whole-screen "zero form controls" e2e assertion to Instance/Advanced**
- **Found during:** Task 3 verification (`npx playwright test`)
- **Issue:** This Phase-5-era test asserted zero edit/save/apply buttons and zero form-control roles anywhere on `/settings`. SET-02/03/04/05 deliberately add `Edit`/`Change` buttons (Account) and `SegmentedControl`s (`radio` role, Appearance) to the same screen, so the test failed against this plan's own intended behavior.
- **Fix:** Rescoped the assertion to `settings-instance-group`/`settings-advanced-disclosure` only (plus a `radio` role ban on those two groups), preserving SET-01/SET-06's actual read-only guarantee without asserting something the phase's own requirements now contradict.
- **Files modified:** `tests/e2e/settings.spec.ts`
- **Verification:** `npx playwright test tests/e2e/settings.spec.ts` -- all 6 tests pass
- **Committed in:** `a2e72be` (Task 3 commit)

**2. [Rule 1 - Bug] Cleaned up the shared E2E admin's preferences after the rewritten shell.spec.ts theme test**
- **Found during:** Task 3 verification -- the rewritten theme test now performs a real `PATCH /api/account/preferences` (unlike the old localStorage-only `ThemeToggle` click), which persists on the shared, long-lived e2e stack's admin account across spec files in the same run
- **Issue:** Without a reset, the test's final "Light" selection would leak into any later spec that assumes the admin's preferences are still their original value
- **Fix:** Added a final "select Auto" step, waiting for that `PATCH`'s response before the test ends, restoring the account to `DEFAULT_PREFERENCES`
- **Files modified:** `tests/e2e/shell.spec.ts`
- **Verification:** Ran `shell.spec.ts` immediately followed by `theme-first-paint.spec.ts` in the same invocation -- no more cross-file pollution from this test
- **Committed in:** `a2e72be` (Task 3 commit)

---

**Total deviations:** 2 auto-fixed (both Rule 1, both e2e test corrections made necessary by this plan's own intended behavior change)
**Impact on plan:** Both fixes keep the phase-5-era test suite honest about what SET-02..SET-06 actually changed. No scope creep -- neither touches product code.

## Issues Encountered

**Pre-existing e2e failure, confirmed unrelated to this plan and logged to `deferred-items.md`:** `tests/e2e/theme-first-paint.spec.ts`'s `@theme-first-paint no theme flash on reload for dark and light, on /login and on /servers after login` fails deterministically (`mutations: 1`, expected `0`) with or without this plan's changes. Root cause: `session-user.ts`'s D-10 "server wins" reconciliation (introduced in `09-10`, a file outside this plan's `files_modified`) fires on every page `Sidebar` mounts on, including `/servers`; the test manufactures a `noodara-prefs` cookie (`dark.on.compact`) the E2E admin's real database row was never actually given via a real `PATCH`, so the mirror-vs-server mismatch D-10 exists specifically to catch fires for real and overwrites the cookie-driven theme. Confirmed pre-existing by running the identical test against the unmodified `9a25fdc` commit in a fresh git worktree with a brand-new e2e stack: 3/3 deterministic failures, identical symptom. Not fixed here per the scope-boundary rule (both `session-user.ts` and this spec file are outside this plan's files). See `deferred-items.md` for the full writeup and a proposed fix for a future plan.

## User Setup Required
None - no external service configuration required.

## Verification
- `pnpm exec vitest run apps/web packages/ui` -- 1023/1023 pass (80 files)
- `pnpm test` (whole monorepo) -- 2987/2987 pass (175 files)
- `pnpm --filter @noodara/web typecheck` / `pnpm typecheck` (whole monorepo) -- clean
- `pnpm lint` (whole monorepo) -- clean
- `pnpm boundaries` -- 744 files, 0 issues
- `pnpm check:ui-safety` -- all repo-wide UI safety gates hold
- `npx playwright test tests/e2e/shell.spec.ts tests/e2e/theme-first-paint.spec.ts tests/e2e/a11y-fallbacks.spec.ts tests/e2e/settings.spec.ts` -- 41/42 pass; the one failure is the pre-existing, unrelated `theme-first-paint.spec.ts` case documented above and in `deferred-items.md`
- `grep -c "@ts-expect-error" apps/web/src/lib/settings-rows.test.ts` -- 4 (>= 3 required; one is inside a test title string)
- `grep -c "onEdit" apps/web/src/lib/settings-rows.ts` -- 0
- `git diff -U0 -- apps/web/src/lib/settings-rows.ts \| grep -E "^\+\s+readonly" \| wc -l` -- 0
- `grep -c "export function ThemeToggle" packages/ui/src/ThemeToggle.tsx` -- 0
- `grep -c "ThemeToggle," packages/ui/src/index.ts` -- 0
- `grep -rn "settings-appearance-theme-toggle" apps/web/src tests/e2e` -- only the assertion string inside `SettingsGroups.test.tsx`'s own negative test, no real usage
- `grep -c "settings-theme-control\|settings-reduce-motion-control\|settings-density-control" apps/web/src/components/SettingsGroups.tsx` -- 3
- `grep -c "account-password-notice" apps/web/src/components/SettingsGroups.tsx` -- 1
- `grep -ciE "switch\|toggle" apps/web/src/components/SettingsGroups.tsx` -- 0

## Next Phase Readiness
- `/settings` now fully composes SET-02 through SET-06 in one screen: Account (editable), Appearance (editable, single write path), Instance/Advanced (structurally read-only, proven at the type level).
- No blockers identified. The one pre-existing e2e gap is documented in `deferred-items.md` for a future plan to pick up (either the test should drive a real PATCH before asserting no-flash, or D-10's reconciliation should distinguish "cookie disagrees with a server value it was never told about" from "cookie is stale after a real cross-browser change").

---
*Phase: 09-settings-editables*
*Completed: 2026-09-27*

## Self-Check: PASSED

All created files and commit hashes verified present.
