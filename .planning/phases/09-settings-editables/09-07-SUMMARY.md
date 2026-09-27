---
phase: 09-settings-editables
plan: 07
subsystem: ui
tags: [nextjs, ssr, cookies, theme, playwright, vitest, accessibility]

# Dependency graph
requires:
  - phase: 09-settings-editables
    provides: "Preferences schema, DEFAULT_PREFERENCES, serializePreferencesCookieValue/parsePreferencesCookieValue, preferencesToRootAttributes (09-01)"
  - phase: 09-settings-editables
    provides: "data-motion CSS override with no first-paint dependency on theme-script.ts (09-04)"
provides:
  - "applyPreferences(prefs) -- the single browser write path (P17, D-12) for data-theme/data-motion/data-density, the noodara-theme localStorage cache and the noodara-prefs mirror cookie"
  - "readPreferencesMirror() -- reads the noodara-prefs cookie through the domain codec, exported from @noodara/ui"
  - "Async RootLayout reading noodara-prefs via await cookies() and rendering preferencesToRootAttributes(...) on <html> before first paint (D-09)"
  - "Narrowed THEME_BOOTSTRAP_SCRIPT: no-ops when SSR already set data-theme, uses matchMedia (not stale localStorage) when the cookie exists and said auto, falls back to legacy localStorage only when there is no cookie at all"
  - "tests/e2e/theme-first-paint.spec.ts -- 8 cases proving zero flash with and without JS, and that a tampered cookie never yields a data-theme attribute or is echoed raw"
affects: [09-12-settings-appearance-controls, 09-08-account-preferences-endpoint]

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "Single-writer DOM/cookie/localStorage function (applyPreferences) that every UI write site (ThemeToggle's click handler and mount-settle effect) routes through, instead of writing document.documentElement/localStorage/document.cookie directly"
    - "SSR-first, script-second theme resolution: layout.tsx sets data-theme/data-motion/data-density from the cookie for an explicit preference; THEME_BOOTSTRAP_SCRIPT only ever resolves the two remaining cases (no cookie, or cookie says auto)"

key-files:
  created:
    - tests/e2e/theme-first-paint.spec.ts
  modified:
    - packages/ui/src/ThemeToggle.tsx
    - packages/ui/src/ThemeToggle.test.tsx
    - packages/ui/src/index.ts
    - apps/web/src/app/layout.tsx
    - apps/web/src/lib/theme-script.ts
    - apps/web/src/lib/theme-script.test.tsx

key-decisions:
  - "ThemeToggle's own mount-settle effect (adopting the cached localStorage theme after mount) now also routes through applyPreferences instead of calling setAttribute directly, so P17's 'single write path' claim holds for every write site in the component, not just the click handler"
  - "The frame-sampling E2E instrument observes `document` (not `document.documentElement`) with `subtree: true`, and skips a sample tick when `document.body` is still null -- both `addInitScript` callbacks were observed firing while the parser had not yet created `<html>`/`<body>` on a real navigation (readyState 'loading', documentElement null), which a naive `document.documentElement`/`document.body` reference throws against"
  - "The 'no flash on /servers after login' case forces a real `page.reload()` after the UI login redirect, since Next's client-side `router.push` never re-triggers `addInitScript` (only real navigations do) -- without the reload the sampler would just keep sampling the /login page's own already-full 10 frames"

requirements-completed: [SET-04, SET-05]

# Metrics
duration: ~90min
completed: 2026-09-27
---

# Phase 9 Plan 07: Theme/preferences cookie and SSR no-flash Summary

**Moved first paint from a localStorage-only bootstrap script to a server-authoritative `noodara-prefs` cookie read in an async root layout, and consolidated every browser write (data-theme/data-motion/data-density, the localStorage cache, the cookie) into one `applyPreferences` function.**

## Performance

- **Duration:** ~90 min
- **Tasks:** 2
- **Files modified:** 6 (1 created)

## Accomplishments
- `applyPreferences`/`readPreferencesMirror` (packages/ui/src/ThemeToggle.tsx, exported from `@noodara/ui`) are now the only functions in the codebase that write `data-theme`/`data-motion`/`data-density`, the `noodara-theme` localStorage key or the `noodara-prefs` cookie from the browser
- `apps/web/src/app/layout.tsx`'s `RootLayout` is now `async`, reads the `noodara-prefs` cookie via `await cookies()`, and spreads `preferencesToRootAttributes(...)` onto `<html>` -- a tampered cookie value can only ever resolve to enum attributes or none (T-09-06)
- `THEME_BOOTSTRAP_SCRIPT` narrowed to the two cases the SSR layout cannot resolve itself (no cookie at all, or an explicit `auto` cookie), and no longer trusts a stale `localStorage` value once a `noodara-prefs` cookie exists
- `/login` and `/setup` are confirmed dynamic (`ƒ`) in `next build` output, the accepted tradeoff from RESEARCH Pitfall 3
- `tests/e2e/theme-first-paint.spec.ts`: 8 new `@theme-first-paint` cases -- explicit dark/light SSR attributes, no-cookie/auto omission, tamper resistance, JS-disabled rendering, and two frame-sampling "no theme flash" proofs (zero `data-theme` mutations, one stable `getComputedStyle` background across 10 frames) on `/login` and `/servers`

## Task Commits

Each task was committed atomically (TDD RED -> GREEN):

1. **Task 1: applyPreferences, the single browser write path**
   - `ce03228` (test) -- 9 failing ThemeToggle.test.tsx cases for `applyPreferences`/`readPreferencesMirror`
   - `ebe1bf4` (feat) -- implementation; full `packages/ui/src` suite (571/571) and typecheck/lint green
2. **Task 2: async root layout + narrowed bootstrap script + no-flash E2E**
   - `9075bba` (test) -- 2 failing `theme-script.test.tsx` cases + 8 new `@theme-first-paint` E2E cases (5 failed for the expected SSR reason, 3 passed trivially since the old layout never set `data-theme` at all)
   - `d84369f` (feat) -- implementation; unit (6/6), full E2E slice (`@theme-first-paint`/`@a11y-fallbacks`/`@shell`, 32/32), full repo unit suite (2913/2913), lint, typecheck, `check:ui-safety` and `pnpm build` all green

**Plan metadata:** committed separately (this SUMMARY + STATE/ROADMAP update)

## Files Created/Modified
- `packages/ui/src/ThemeToggle.tsx` - `applyPreferences`/`readPreferencesMirror`; click handler and mount-settle effect both route through `applyPreferences`
- `packages/ui/src/ThemeToggle.test.tsx` - 10 new tests for the two exported functions plus the mirror-preserving cycle behavior
- `packages/ui/src/index.ts` - exports `applyPreferences`/`readPreferencesMirror`
- `apps/web/src/app/layout.tsx` - `async RootLayout`, `await cookies()`, `preferencesToRootAttributes` spread onto `<html>`
- `apps/web/src/lib/theme-script.ts` - narrowed `THEME_BOOTSTRAP_SCRIPT` (no-op when SSR already resolved, cookie-presence gates the localStorage fallback)
- `apps/web/src/lib/theme-script.test.tsx` - new, 6 jsdom cases evaluating the script via `new Function`
- `tests/e2e/theme-first-paint.spec.ts` - new, 8 cases

## Decisions Made
- Kept the mount-settle effect's write inside `ThemeToggle.tsx` itself (routed through `applyPreferences`) rather than removing it, since it's still the mechanism that reconciles a stale `localStorage` cache after hydration until 09-12 replaces this component entirely
- No `data-motion` resolution was added to `THEME_BOOTSTRAP_SCRIPT` -- 09-04-SUMMARY.md already recorded that the Tailwind `data-motion` override needs no first-paint script dependency, confirmed still true here

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] MutationObserver/frame-sampler E2E instrument crashed on early `addInitScript` execution**
- **Found during:** Task 2, running the "no theme flash" E2E cases
- **Issue:** `page.addInitScript` fires before the HTML parser has created `<html>`/`<body>` on a real navigation (`document.documentElement` is `null`, `readyState` is `'loading'`) -- `observer.observe(document.documentElement, ...)` threw `Failed to execute 'observe' on 'MutationObserver': parameter 1 is not of type 'Node'`, and both new "no flash" tests timed out with 0 sampled frames as a result
- **Fix:** Observe `document` itself (always a valid `Node`) with `subtree: true` instead of `document.documentElement`, and guard the per-frame `getComputedStyle(document.body)` call behind a `document.body !== null` check, still scheduling the next `requestAnimationFrame` either way
- **Files modified:** `tests/e2e/theme-first-paint.spec.ts`
- **Verification:** Re-ran `npx playwright test --grep "@theme-first-paint"` -- 8/8 passed
- **Committed in:** `d84369f` (Task 2 GREEN commit; the fix landed before the final GREEN commit since it was found while still stabilizing the E2E RED->GREEN cycle)

**2. [Rule 1 - Bug] Client-side route push does not re-arm `addInitScript`**
- **Found during:** Task 2, designing the "no flash on /login and on /servers after login" case
- **Issue:** Next's post-login `router.push` to `/servers` is a client-side-only navigation, so `page.addInitScript` never re-runs there -- the sampler installed at `/login` would either keep sampling the wrong page or (once already full at 10 frames) report a stale, misleading "pass"
- **Fix:** Force a real `page.reload()` after the login redirect completes, before reading the `/servers` sample, so the sampler is genuinely re-armed by a real navigation and the assertion reflects `/servers`'s own SSR-driven first paint
- **Files modified:** `tests/e2e/theme-first-paint.spec.ts`
- **Verification:** Same E2E run as above

### Pre-existing exception, not a regression

`packages/ui/src/ThemeToggle.tsx`'s own header (and the original pre-plan header) has always carved out `apps/web/src/lib/theme-script.ts`'s bootstrap `setAttribute('data-theme', ...)` call as the one write that happens before `applyPreferences`/hydration exists at all. The plan's Task 1 acceptance grep (`setAttribute('data-theme'... excluding ThemeToggle.tsx`) still matches this one pre-existing line in `theme-script.ts` -- expected and unchanged by this plan, not a new second write path (P17's guarantee is about writes *after* hydration, which this bootstrap script explicitly is not).

---

**Total deviations:** 2 auto-fixed (both Rule 1, both confined to the new E2E test file's own instrumentation -- no production code changes beyond what Task 2's action text specified)
**Impact on plan:** Both fixes were required to get the plan's own no-flash E2E cases green at all; no scope creep into production code.

## Issues Encountered
- `pnpm test:e2e -- --grep "..."` (via pnpm's arg-forwarding) silently ran the entire E2E suite instead of the filtered subset, in every invocation tried (`pnpm test:e2e`, `pnpm run test:e2e`, with and without `--list`). Worked around by invoking `npx playwright test --grep "..."` directly, which respected the filter correctly and was used for every scoped verification run in this plan. Full, unfiltered runs (`pnpm test:e2e -- --grep ...`) were also let run to completion once each as an unintended but harmless full-suite regression check (151/151 and 32/32-superset passed both times).

## Next Phase Readiness
- 09-12 (Settings Appearance controls) can wire a `SegmentedControl` calling `applyPreferences` directly with the user's chosen theme plus the mirror's current reduceMotion/density, replacing `ThemeToggle` entirely
- 09-08 (account preferences endpoint) can set the identical `noodara-prefs` cookie server-side via the same domain codec on `PATCH /api/account/preferences` responses, per this plan's own header comments in both `applyPreferences` and `layout.tsx`
- No blockers

---
*Phase: 09-settings-editables*
*Completed: 2026-09-27*

## Self-Check: PASSED

All 7 files_modified paths confirmed present on disk; all 4 task commit hashes (ce03228, ebe1bf4, 9075bba, d84369f) confirmed present in `git log`.
