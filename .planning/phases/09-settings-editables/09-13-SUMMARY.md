---
phase: 09-settings-editables
plan: 13
subsystem: testing
tags: [playwright, e2e, react, sync-external-store, security]

requires:
  - phase: 09-settings-editables plan 11
    provides: "AccountProfileSheet, AccountPasswordSheet"
  - phase: 09-settings-editables plan 12
    provides: "SettingsGroups' Account + Appearance composition (settings-theme-control, settings-reduce-motion-control, settings-density-control, account-password-notice)"
  - phase: 09-settings-editables plan 10
    provides: "require-session.ts's /login?reason=password-changed redirect, session-user.ts's shared store"
  - phase: 09-settings-editables plan 09
    provides: "POST /api/account/password's session-revocation contract"
provides:
  - "tests/e2e/settings.spec.ts -- one named Playwright test per ROADMAP Phase 9 success criterion (1-5)"
  - "session-user.ts's ensureLoaded() no longer races its own GET /api/account/preferences' Set-Cookie side effect"
affects: []

tech-stack:
  added: []
  patterns:
    - "Appearance E2E tests drive every SegmentedControl selection through a shared setSegment() helper that checks data-state first and only waits on a PATCH response when the segment actually changes -- clicking an already-selected radio never fires onValueChange, so an unconditional wait would hang"
    - "Two-browser-context E2E pattern (browser.newContext()) for both the password-revocation and cross-browser-theme-sync criteria, matching shell.spec.ts's own no-reload SSE-heartbeat assertion style rather than a manual page.reload()"

key-files:
  created:
    - .planning/phases/09-settings-editables/09-13-SUMMARY.md
  modified:
    - tests/e2e/settings.spec.ts
    - apps/web/src/lib/session-user.ts
    - apps/web/src/lib/session-user.test.ts

key-decisions:
  - "Task 2's own RED run against the real, integrated stack surfaced a genuine product bug (not a test-authoring gap): session-user.ts's D-10 reconciliation read the noodara-prefs mirror cookie *after* GET /api/account/preferences resolved, but that same GET re-issues the mirror Set-Cookie header (account.ts's buildPreferencesSetCookie runs on GET too, not just PATCH) -- a browser applies a fetch response's Set-Cookie before the promise settles, so the post-fetch mirror read always already agreed with the server value it had just received, silently skipping applyPreferences on a brand-new session. Fixed by capturing the mirror snapshot before firing the request (Rule 1)."
  - "The @settings Instance/Advanced read-only test is a new, additional assertion (title contains 'read-only', per the plan's own acceptance criteria) alongside 09-12's existing 'zero form controls' test -- it strengthens the same SET-06 guarantee with a stricter total-button-count check (exactly one CopyButton in Instance, exactly one Disclosure trigger in Advanced) rather than replacing the existing test."

requirements-completed: [SET-02, SET-03, SET-04, SET-05, SET-06]

duration: ~75min
completed: 2026-09-27
---

# Phase 9 Plan 13: End-to-end proof of the five success criteria Summary

**`tests/e2e/settings.spec.ts` gained nine new `@settings` Playwright tests -- one or more per ROADMAP Phase 9 success criterion, run against the real stack -- and, along the way, exposed and fixed a real cross-browser theme-sync bug in `session-user.ts` where the preferences GET's own Set-Cookie side effect defeated the D-10 "server wins" reconciliation check.**

## Performance

- **Duration:** ~75 min
- **Started:** 2026-09-27T04:50:00-06:00
- **Completed:** 2026-09-27T06:05:00-06:00
- **Tasks:** 2
- **Files modified:** 3 (0 created, 3 modified — excluding this SUMMARY)

## Accomplishments
- `@settings profile edit updates the account menu without reload`: edits the Name via `AccountProfileSheet`, asserts the `AccountMenu` header updates with no page navigation (a `window`-scoped marker survives the whole assertion), an `account.name_changed` Activity entry appears, and restores the original name in `finally` (Success Criterion 1)
- `@settings wrong current password shows the field error`: a wrong current-password on the Email sheet renders "Current password is incorrect." under the field and leaves the email row unchanged — no mutation, no restore needed
- `@settings password change revokes other sessions and keeps this one`: a second real browser context is signed in before the password change; after A changes the password, the `account-password-notice` matches the singular/plural pattern, A keeps navigating the app with no reload, and B — with no `page.reload()` of its own, only the real SSE-heartbeat-driven redirect — lands on `/login?reason=password-changed` with the Notice visible; the password is restored to the shared E2E admin's original value in `finally` (Success Criterion 2)
- `@settings Instance and Advanced stay read-only`: a stricter SET-06 proof than 09-12's own test — exactly one button in each group (the Instance CopyButton, the Advanced Disclosure trigger), zero `input`/`select`/`textarea` tags, and all five Advanced rows captioned "Set by an environment variable" (Success Criterion 5)
- `@settings theme choice persists with no theme flash on reload`, `@settings manual theme override wins over the OS`, `@settings theme preference follows the account to a second browser`: reuse `theme-first-paint.spec.ts`'s frame-sampler/SSR-HTML technique (copied under a distinct `window.__settingsFramePaint` global to avoid cross-file collision) to prove Dark persists through a real SSR reload with zero `data-theme` mutations mid-paint, a manual Light choice survives an OS-dark emulation, and a completely fresh, cookie-less second browser context ends up on the account's real Dark preference after login, both client-side and in its own SSR HTML (Success Criterion 3)
- `@settings reduce motion On forces the Sheet fallback`, `@settings density Compact shrinks rows app-wide`: drive the real `settings-reduce-motion-control`/`settings-density-control` `SegmentedControl`s (not a synthetic `data-motion`/`data-density` attribute write, unlike the existing `a11y-fallbacks.spec.ts` cases) to prove the add-server Sheet opens opacity-only with an inert drag surface, and a server row measures 36px with unchanged font size (Success Criterion 4)
- **Real bug found and fixed:** `session-user.ts`'s `ensureLoaded()` captured `readPreferencesMirror()` *after* `GET /api/account/preferences` resolved. That endpoint's own handler (`apps/control-plane/src/routes/account.ts`) re-issues the `noodara-prefs` Set-Cookie header on every GET, and a real browser applies a fetch response's Set-Cookie before the promise settles — so the post-fetch mirror read always already matched the just-fetched server value, silently skipping `applyPreferences` on any session that had never independently painted the account's real theme (e.g. a brand-new second browser). Fixed by snapshotting the mirror *before* the request fires.

## Task Commits

1. **Task 1: Account flows**
   - `4bdc7d4` test(09-13): add E2E proof for account edit and password revocation flows
2. **Task 2: Appearance flows**
   - `afa0b11` test(09-13): add E2E and RED unit proof for appearance flows
   - `4d4c6d6` fix(09-13): read the preferences mirror before the GET that re-sets it

## Files Created/Modified
- `tests/e2e/settings.spec.ts` - 9 new `@settings` tests across both tasks, plus shared helpers (`setSegment`, `resetAppearance`, a local frame sampler, `decomposeTransform`)
- `apps/web/src/lib/session-user.ts` - `ensureLoaded()` now reads the mirror before firing the preferences request (Rule 1 fix)
- `apps/web/src/lib/session-user.test.ts` - one new unit test pinning the race directly (mocks `readPreferencesMirror` changing mid-fetch, the way a real Set-Cookie would)

## Decisions Made
See `key-decisions` in the frontmatter above (the session-user.ts race root cause and fix, and the additional stricter read-only test).

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] `session-user.ts`'s D-10 reconciliation always skipped `applyPreferences` on a fresh session because the preferences GET itself re-sets the mirror cookie it was being compared against**
- **Found during:** Task 2, first RED run of `@settings theme preference follows the account to a second browser` against the real stack
- **Issue:** `ensureLoaded()` called `readPreferencesMirror()` inside the `.then()` callback, after `loadAccountPreferences()`'s `GET /api/account/preferences` had already resolved. `buildPreferencesSetCookie` runs on every GET (not just PATCH), and a browser applies a fetch response's own `Set-Cookie` header before the promise settles — so the mirror always already equaled the freshly-fetched server value, and the "mirror differs from server" branch that triggers `applyPreferences` never fired for a session whose `data-theme` attribute had never independently been set to that value (e.g. a second browser logging in after the account's theme changed elsewhere).
- **Fix:** Snapshot `readPreferencesMirror()` into a `mirrorBeforeLoad` local *before* `Promise.all([loadSessionUser(), loadAccountPreferences()])` fires, and compare against that snapshot in the `.then()` callback instead of re-reading the cookie after the fact.
- **Files modified:** `apps/web/src/lib/session-user.ts`, `apps/web/src/lib/session-user.test.ts`
- **Verification:** New unit test `still applies the server preferences when the mirror only starts agreeing because this same request set it (T-09-13)` — confirmed RED against the pre-fix code (`applyPreferencesMock` called 0 times, expected 1) and GREEN after the fix; the E2E case went from a 15s poll timeout to passing in under 1s. Full suites re-verified after the fix: `pnpm test` 175 files/2988 tests, `pnpm --filter @noodara/web typecheck`/`lint` clean, `pnpm typecheck`/`pnpm lint` (monorepo) clean, `pnpm boundaries` 744 files/0 issues, full `npx playwright test` 171/171 pass.
- **Committed in:** `afa0b11` (test, RED) → `4d4c6d6` (fix, GREEN)

---

**Total deviations:** 1 auto-fixed (Rule 1, a real product bug this plan's own E2E work exposed)
**Impact on plan:** No scope creep — the fix is confined to the exact function 09-10 introduced, proven by a new unit test and the E2E case it was blocking. Every other test in both tasks passed on its first RED-as-GREEN run against the already-integrated 09-06..09-12 product.

## Issues Encountered
None beyond the bug documented above.

## User Setup Required
None - no external service configuration required.

## Verification
- `npx playwright test tests/e2e/settings.spec.ts --grep "profile edit|wrong current password|password change revokes|read-only"` -- 4/4 pass
- `npx playwright test tests/e2e/settings.spec.ts --grep "theme|reduce motion|density"` -- 5/5 pass
- `npx playwright test` (full suite) -- 171/171 pass
- `pnpm exec vitest run apps/web/src/lib/session-user.test.ts` -- 15/15 pass (confirmed RED against the pre-fix code, GREEN after)
- `pnpm test` (whole monorepo) -- 175 files, 2988/2988 pass
- `pnpm --filter @noodara/web typecheck` / `lint` -- clean
- `pnpm typecheck` / `pnpm lint` (whole monorepo, including `tests/e2e/tsconfig.json`) -- clean
- `pnpm boundaries` -- 744 files, 0 issues
- `grep -c "password change revokes" tests/e2e/settings.spec.ts` -- 1
- `grep -c "profile edit" tests/e2e/settings.spec.ts` -- 1
- `grep -c "waitForTimeout" tests/e2e/settings.spec.ts` -- 0
- `grep -c "finally" tests/e2e/settings.spec.ts` -- 4 (>= 2 required)
- `grep -c "no theme flash" tests/e2e/settings.spec.ts` -- 1
- `grep -c "second browser" tests/e2e/settings.spec.ts` -- 1
- `grep -c "density Compact" tests/e2e/settings.spec.ts` -- 1
- `git stash list` -- empty; `git worktree list` -- only the main tree (sequential executor, no worktree isolation used)

## Next Phase Readiness
- Every ROADMAP Phase 9 success criterion (1-5) now has a named, passing Playwright test in `tests/e2e/settings.spec.ts`, ready for `/gsd:verify-work` or a future `-g` filtered run per `09-VALIDATION.md`.
- `session-user.ts`'s D-10 reconciliation is now correct for the exact scenario 09-12's own deferred-items.md entry flagged as a future risk (a fresh session observing a server preference it has never independently painted) — no further follow-up needed for that class of bug.
- No blockers for phase close. Plan 09-14 (the phase's final plan) can proceed.

---
*Phase: 09-settings-editables*
*Completed: 2026-09-27*

## Self-Check: PASSED

All created/modified files and all commit hashes verified present.
