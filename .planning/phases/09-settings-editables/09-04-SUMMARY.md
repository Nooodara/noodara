---
phase: 09-settings-editables
plan: 04
subsystem: ui
tags: [tailwind, css-custom-properties, motion, playwright, vitest, accessibility]

# Dependency graph
requires:
  - phase: 08-redise-o-de-la-app
    provides: PRESS_CLASSES, Sheet, Dialog, RowMenu, Disclosure and their existing motion-safe:/motion-reduce: call sites, plus the one raw aperture.css reduced-motion block
provides:
  - "@custom-variant motion-reduce / motion-safe redefinitions in packages/ui/theme.css that read html[data-motion=\"reduce\"|\"allow\"] in addition to prefers-reduced-motion, with zero call-site class changes across press.ts/Sheet.tsx/Disclosure.tsx/RowMenu.tsx/Dialog.tsx"
  - aperture.css's reduced-motion block honoring the same data-motion override (both the media-query branch gated by :not([data-motion=\"allow\"]) and a standalone [data-motion=\"reduce\"] branch)
  - "useReducedMotionPreference() (packages/ui/src/use-reduced-motion-preference.ts) -- a useSyncExternalStore-based hook reading data-motion first, falling back to matchMedia, internal to Sheet"
  - Sheet's drag gesture wired to useReducedMotionPreference instead of motion/react's own useReducedMotion
  - Five new @a11y-fallbacks E2E cases proving the override in a real browser (Sheet/Dialog forced reduce, allow-overrides-OS, Sheet drag surface immobile under forced reduce)
affects: [09-07-theme-preferences-cookie-and-ssr, 09-12-settings-appearance-controls]

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "Tailwind v4 @custom-variant block form with two @slot rules per variant (attribute branch + media-query branch) -- confirmed working in this repo's Tailwind 4.3.3, no fallback needed"
    - "useSyncExternalStore + MutationObserver(attributeFilter) + MediaQueryList 'change' listener as the standard shape for an attribute-with-media-fallback React hook, getServerSnapshot fixed to false to avoid hydration mismatch"

key-files:
  created:
    - packages/ui/src/use-reduced-motion-preference.ts
    - packages/ui/src/use-reduced-motion-preference.test.tsx
  modified:
    - packages/ui/theme.css
    - packages/ui/aperture.css
    - packages/ui/src/Sheet.tsx
    - packages/ui/src/Sheet.test.tsx
    - tests/e2e/a11y-fallbacks.spec.ts

key-decisions:
  - "The block-form @custom-variant with two @slot rules (attribute selector + nested @media) compiles cleanly in this repo's Tailwind 4.3.3 -- no fallback to a single-rule variant or apps/web matchMedia resolution was needed, so plan 09-07's theme-script.ts has no new dependency from this plan"
  - "aperture.css's override uses two separate rule pairs (media-query branch gated by :not([data-motion=\"allow\"]), plus a standalone html[data-motion=\"reduce\"] branch) rather than one combined selector, keeping each branch's condition independently readable"
  - "Sheet.test.tsx mocks only motion/react's m.div (the one m.* export Sheet.tsx uses), forwarding the real drag prop to the real underlying component while mirroring it onto a data-drag attribute for jsdom assertions -- jsdom cannot observe Motion's drag-enabled/disabled behavior any other way (confirmed via a throwaway spike before writing the mock)"

patterns-established:
  - "D-13 data-motion override: html[data-motion=\"reduce\"|\"allow\"] wins over prefers-reduced-motion for every motion-safe:/motion-reduce: call site and the one raw aperture.css media block, via a single redefinition point in theme.css"

requirements-completed: [SET-05]

# Metrics
duration: 55min
completed: 2026-09-27
---

# Phase 9 Plan 4: Forced reduce-motion preference override (D-13) Summary

**Redefined Tailwind's `motion-safe`/`motion-reduce` variants and the Sheet's JS gesture check so a forced `data-motion="reduce"|"allow"` attribute on `<html>` wins over the OS `prefers-reduced-motion` setting everywhere, with zero changes to any of the ~15 existing call sites.**

## Performance

- **Duration:** 55 min
- **Started:** 2026-09-27T01:28:00Z
- **Completed:** 2026-09-27T02:23:00Z
- **Tasks:** 2
- **Files modified:** 7 (2 created)

## Accomplishments
- `@custom-variant motion-reduce`/`motion-safe` redefined once in `packages/ui/theme.css`, each with an attribute branch (`[data-motion="reduce"|"allow"]`) and a media-query branch, so `html[data-motion]` wins when present and the OS setting still applies when absent -- confirmed by a real Next.js build's emitted CSS carrying both `data-motion` and `prefers-reduced-motion` selectors next to existing utility classes
- `aperture.css`'s one raw `@media (prefers-reduced-motion: reduce)` block now honors the same override, with a `:not([data-motion="allow"])` guard on the media branch and a standalone `html[data-motion="reduce"]` branch for the forced case
- New `useReducedMotionPreference()` hook (`useSyncExternalStore` + `MutationObserver` + `MediaQueryList` change listener) gives `Sheet.tsx`'s drag gesture the identical effective preference as the CSS variants, replacing `motion/react`'s own `useReducedMotion` (which does not react to `data-motion` at all)
- Five new `@a11y-fallbacks` Playwright cases prove the override end to end in a real browser: forced-reduce Sheet (opacity-only) and Dialog (no scale) with no OS emulation, a forced `data-motion="allow"` overriding an OS-emulated reduce, and a forced-reduce Sheet whose drag surface does not move under a real mouse drag gesture
- Zero call-site changes: `git diff --stat` on `press.ts`/`Disclosure.tsx`/`RowMenu.tsx`/`Dialog.tsx` is empty, and `check:ui-safety` stays green throughout

## Task Commits

Each task was committed atomically (TDD: test -> feat):

1. **Task 1: Spike and redefine motion-safe / motion-reduce with the data-motion override**
   - `067369e` (test) -- three failing `@a11y-fallbacks` E2E cases for the forced/allow override, confirmed RED by temporarily reverting `theme.css`'s spiked variant
   - `b9cb196` (feat) -- `theme.css`'s two-rule-per-variant redefinition kept, `aperture.css` rewritten with the `data-motion` override; full `pnpm --filter @noodara/web build` + `check:ui-safety` + `@a11y-fallbacks` (147/147) green
2. **Task 2: Attribute-aware reduced-motion hook for the Sheet's JS gesture**
   - `820ad55` (test) -- failing `use-reduced-motion-preference.test.tsx`, three new `Sheet.test.tsx` drag-wiring cases (via a `motion/react` `m.div` mock), and one new E2E drag-surface case, confirmed RED
   - `e11a758` (feat) -- `useReducedMotionPreference` implemented, `Sheet.tsx` wired to it; `Sheet.tsx`'s `drag={prefersReducedMotion ? false : 'x'}` boolean literal comparison also simplified per lint

## Files Created/Modified
- `packages/ui/theme.css` -- `@custom-variant motion-reduce`/`motion-safe` block-form redefinitions reading `data-motion` ahead of `prefers-reduced-motion`
- `packages/ui/aperture.css` -- reduced-motion block gains a `data-motion="allow"` escape hatch on its media branch and a standalone `data-motion="reduce"` branch
- `packages/ui/src/use-reduced-motion-preference.ts` (new) -- `useReducedMotionPreference()`, internal to Sheet, not exported from `index.ts`
- `packages/ui/src/use-reduced-motion-preference.test.tsx` (new) -- attribute precedence, media fallback, MutationObserver/media-change reactivity, throwing-matchMedia fallback, server-snapshot hydration-safety
- `packages/ui/src/Sheet.tsx` -- `useReducedMotion` import replaced with `useReducedMotionPreference`; comment updated to name the D-13 override
- `packages/ui/src/Sheet.test.tsx` -- `motion/react` `m.div` mock mirroring the real `drag` prop onto `data-drag`, plus three drag-wiring assertions
- `tests/e2e/a11y-fallbacks.spec.ts` -- four forced/allow-override cases plus the drag-surface-immobile case, with an `expect.poll` wait for the drag surface's own entry-settle spring before measuring the drag gesture's effect

## Decisions Made
- Kept the two-`@slot`-rule block form for both variants after the Task 1 spike proved Tailwind 4.3.3 accepts it cleanly in this repo's real build output -- no fallback selector shape, no new dependency on 09-07's `theme-script.ts` for first-paint `data-motion` resolution
- `aperture.css`'s override is two independent rule pairs rather than one combined selector, so each of the four end states (OS-reduce/no-attr, OS-reduce/allow, OS-no-pref/no-attr, OS-no-pref/reduce) traces to exactly one readable rule
- Sheet.test.tsx's `motion/react` mock only replaces `m.div` (the sole `m.*` export Sheet.tsx uses) and forwards the real `drag` prop to the real underlying Motion component -- confirmed via a throwaway spike that jsdom has no other way to observe Motion's drag-enabled/disabled distinction (no static style/attribute difference), so this mirror-attribute approach is the only honest jsdom-level proof; the real end-to-end proof is the new Playwright drag-surface case

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] Added an `expect.poll` wait before the E2E drag-surface assertion**
- **Found during:** Task 2 (`@a11y-fallbacks forced reduce motion preference: Sheet drag surface does not move`)
- **Issue:** The first run of the new drag test measured a residual `translateX(0.494283px)` instead of exactly `0` after the drag gesture -- not a drag-disabled bug, but a race with Sheet.tsx's own entry-settle spring (`ENTRY_SETTLE_OFFSET_PX`, unrelated to reduced motion, runs on every open) still finishing when the mouse gesture started
- **Fix:** Added `expect.poll(...).toBe(0)` on the drag surface's `translateX` before starting the mouse gesture, so the settle spring is guaranteed finished first
- **Files modified:** `tests/e2e/a11y-fallbacks.spec.ts`
- **Verification:** Re-ran `pnpm test:e2e -- --grep "@a11y-fallbacks"` -- full 148/148 passed (147 suite tests + this one), including the fixed drag-surface case at 838ms
- **Committed in:** `e11a758` (Task 2 commit)

---

**Total deviations:** 1 auto-fixed (1 bug, in a test's own timing assumption)
**Impact on plan:** No scope creep -- the fix only corrected the new test's own race condition; Sheet.tsx's implementation needed no change.

## Issues Encountered
- `pnpm --filter @noodara/web build` initially failed with a missing `NOODARA_API_ORIGIN` env var -- the repo's own `.env` only sets `NOODARA_PUBLIC_URL`; ran the build with `NOODARA_API_ORIGIN=http://localhost:3100` exported inline for this plan's verification builds (not a code change, no fix needed beyond that).
- A stray `apps/control-plane/dist/server.js` process from an earlier session's E2E stack was still listening on port 3100 before the first E2E run in this session; verified it belonged to this repo (correct binary path) and killed it before proceeding, per the plan's port-check instruction.
- `pnpm test:e2e -- --grep "..."` does not actually filter in this repo (same behavior noted in 09-03-SUMMARY.md) -- both grep invocations ran the full suite; the full-suite pass (148/148, then 147/147 excluding one unrelated pre-existing `@discovery-ring` SSE-timing flake seen once and not reproduced on the next full run) is a strictly stronger result than a filtered subset.

## User Setup Required
None - no external service configuration required.

## Next Phase Readiness
- `data-motion="reduce"|"allow"` on `<html>` is now the one attribute every motion fallback (CSS variants, aperture crossfade, Sheet drag) reads with identical precedence; plan 09-07 (theme/preferences cookie + SSR) can write this attribute at first paint with zero further CSS/JS changes needed here
- Plan 09-12 (Settings Appearance controls) can wire a `SegmentedControl` writing `data-motion` directly -- this plan's own E2E cases already prove the effect end to end via `page.evaluate` setting the same attribute

---
*Phase: 09-settings-editables*
*Completed: 2026-09-27*
