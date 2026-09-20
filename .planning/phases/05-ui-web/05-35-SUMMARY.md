---
phase: 05-ui-web
plan: 35
subsystem: ui
tags: [nextjs, react, hydration, session, sse, playwright, gap-closure]

# Dependency graph
requires:
  - phase: 05-ui-web
    provides: "api-client.ts's AbortSignal.timeout/AbortSignal.any wiring (05-28) -- require-session.ts's own timeout race is retired in favour of it"
provides:
  - "apps/web/src/app/page.tsx: a real root route (Server Component, redirect('/servers'))"
  - "packages/ui/src/ThemeToggle.tsx: a hydration-safe initial render (fixed 'system' first paint, storage adopted in a mount effect, settledRef guard against clobbering THEME_BOOTSTRAP_SCRIPT's pre-hydration value)"
  - "apps/web/src/lib/require-session.ts: at-most-once redirect guard, no second client-side timeout race"
  - "apps/web/src/app/(shell)/layout.tsx: re-runs requireSession() when the shared SSE stream transitions from open to closed"
  - "tests/e2e/shell.spec.ts: sidebar nav locators scoped to shell-sidebar (regression fix for the wave-1 gate)"
affects: [05-37 (final human-verification/full-suite plan), 05-VERIFICATION.md gap 8]

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "Server Component root route: redirect() from next/navigation, no client bundle, no duplicated auth decision (proxy.ts already covers '/')"
    - "Deterministic first render + settle-in-a-mount-effect, guarded by a ref, to make a component hydration-safe without ever writing a wrong intermediate value to a DOM attribute another script already set correctly pre-hydration"
    - "React's hydrateRoot({ onRecoverableError }) as the deterministic, synchronous test signal for a hydration mismatch -- console.error/uncaught-exception spying are both unreliable in this React 19 build (mismatches throw internally inside the scheduler and are recovered from before any console.error call)"
    - "A shared SSE 'connected' boolean already computed by an existing hook is a legitimate post-mount signal to re-run a session check on -- no new polling interval, no modification to the hook itself"

key-files:
  created:
    - apps/web/src/app/page.tsx
    - apps/web/src/lib/require-session.test.ts
  modified:
    - packages/ui/src/ThemeToggle.tsx
    - packages/ui/src/ThemeToggle.test.tsx
    - apps/web/src/lib/require-session.ts
    - "apps/web/src/app/(shell)/layout.tsx"
    - tests/e2e/shell.spec.ts

key-decisions:
  - "require-session.ts's old 5s Promise.race timeout is removed, not kept. It predated plan 05-28's real AbortSignal.timeout(15000) inside api-client.ts and used to fail closed (force a logout) on a slow request. Once this function is also invoked from a background SSE-drop signal (not only once on mount), that trade-off actively contradicts T-5G-35-04's own requirement that a transient network blip must not look like a revoked session. A hang now surfaces, after api-client's own 15s budget, as NETWORK_ERROR, which never redirects -- consistent with the mount-time check, the SSE-drop check, and every screen's own existing 401 handler."
  - "The post-mount revocation trigger is the shared useServerEvents() hook's own 'connected' boolean transitioning true->false inside apps/web/src/app/(shell)/layout.tsx (which already owns that hook instance), not a change to use-server-events.ts or shell-context.tsx (both out of this plan's files_modified). The SSE heartbeat closing the stream server-side on a revoked session is exactly one cause of that transition; an ordinary reconnect blip is another, and is safely absorbed because requireSession() itself only ever redirects on a real 401."
  - "ThemeToggle's hydration fix is a fixed 'system' initial value adopted from a mount effect, not the alternative of reading storage during render behind a typeof window guard -- Next.js Server Components already never execute browser-only code, so the guard would be dead code; the real fix is making the *value* deterministic, not gating where it's read."
  - "The hydration-parity test uses hydrateRoot's onRecoverableError callback, not console.error spying or catching an uncaught exception -- verified empirically that this React 19/react-dom 19.3.0 build throws the mismatch internally inside its own scheduler (recovered from before any console.error call), so onRecoverableError is the only synchronous, deterministic signal available inside a single act() call."

patterns-established:
  - "A settledRef-guarded second effect is the pattern for 'adopt async state in a mount effect without ever writing a transiently-wrong value to something another script already set correctly before hydration' -- reusable anywhere else a component's own effect could otherwise race a pre-hydration bootstrap script."

requirements-completed: [UI-01, UI-02]

# Metrics
duration: 55min
completed: 2026-09-20
---

# Phase 05 Plan 35: Root Route, Hydration-Safe Theme, Revoked-Session Redirect Summary

**Closes three triaged gap-8 findings on the v0.1 happy path: a real `/` route, a ThemeToggle that no longer hydration-mismatches for every user with a stored theme, and a shell that redirects an open tab within one SSE heartbeat of its session being revoked server-side -- plus an orchestrator-assigned regression fix scoping shell.spec.ts's sidebar locators.**

## Performance

- **Duration:** ~55 min
- **Started:** 2026-09-20 (following 05-31's completion)
- **Completed:** 2026-09-20
- **Tasks:** 3 plan tasks + 1 orchestrator-assigned deviation task
- **Files modified:** 7 (2 created, 5 modified)

## Accomplishments

- **WR-B-15 (Task 1).** `apps/web/src/app/page.tsx` is a Server Component that `redirect('/servers')`s -- the bare origin an installer prints, or an admin bookmarks, no longer 404s for an authenticated visitor. No new auth logic: unauthenticated visitors were already redirected to `/login` by `proxy.ts`'s existing matcher (it already covers `/`), one hop before this file would ever run.
- **WR-C-01 (Task 2).** `ThemeToggle`'s `useState` initialiser no longer reads `localStorage` during render -- it starts at a fixed `'system'` (identical on the server and the first client render), then adopts the real stored preference in a mount effect. A `settledRef` guard on the existing `data-theme`-writing effect stops that adoption from momentarily overwriting `THEME_BOOTSTRAP_SCRIPT`'s already-correct pre-hydration value with a wrong system-default one for one frame.
- **WR-B-10 (Task 3).** `require-session.ts` gained an at-most-once redirect guard and dropped its own 5s timeout race (superseded by plan 05-28's `AbortSignal.timeout` inside `api-client.ts` -- see Decisions). The shell layout (`(shell)/layout.tsx`) now re-runs `requireSession()` whenever the shared SSE stream's `connected` state transitions from `true` to `false` -- the heartbeat closing the stream server-side on a revoked session is exactly that transition, verified end to end against the real backend's `DELETE /api/sessions/:id`.
- **Orchestrator-assigned deviation.** `tests/e2e/shell.spec.ts`'s sidebar nav locators (Tab-activation test, responsive-collapse test) are now scoped to `page.getByTestId('shell-sidebar')` via a `sidebarLink()` helper, fixing a real Playwright strict-mode collision the wave-1 full E2E gate found: plan 05-32's activity specs create servers named `activity-refresh-fail-*`/`activity-refresh-gap-*` on the shared stack, whose list-row links match `getByRole('link', { name: 'Activity' })`'s default substring match at the page level.

_TDD note: each of the three plan tasks followed a real RED -> GREEN cycle in its own commit (task-per-commit, matching this project's established convention for these gap-closure plans) -- see "RED Evidence" below for each._

## Task Commits

1. **Task 1: A real root route (WR-B-15)** -- `6a04f3c` (feat)
2. **Task 2: Hydration-safe ThemeToggle (WR-C-01)** -- `be9a2d0` (fix)
3. **Task 3: A revoked session redirects the open tab (WR-B-10)** -- `da592a4` (feat)
4. **Orchestrator-assigned: scope shell sidebar locators** -- `1ab12c4` (test)

## RED Evidence

- **Task 1:** Before the fix, `pnpm exec playwright test tests/e2e/shell.spec.ts --grep "bare origin"` failed the authenticated case:
  ```
  Error: expect(page).toHaveURL(expected) failed
  Expected pattern: /\/servers$/
  Received string:  "http://localhost:3000/"
  ```
  Confirming the authenticated visit stayed on `/` (Next's default 404) instead of redirecting. The unauthenticated case already passed (`proxy.ts`'s existing matcher), confirming no second auth path was needed.

- **Task 2:** Before the fix, `pnpm exec vitest run packages/ui/src/ThemeToggle.test.tsx` failed the new hydration-parity test with a real React hydration-mismatch error captured via `onRecoverableError`:
  ```
  Error: Hydration failed because the server rendered HTML didn't match the client...
    <button
  +   aria-label="Theme: Dark"
  -   aria-label="Theme: System"
  ...
  ```
  The test forces a genuine server/client split (the only way to reproduce this bug in jsdom, which has no real concept of "no window"): `Storage.prototype.getItem` is made to throw only during the `renderToString` pass (simulating a real server render, which never has `localStorage` at all), then `hydrateRoot` runs against a real stored `'dark'` value. Verified the no-flash claim by reading `theme-script.ts`: `THEME_BOOTSTRAP_SCRIPT` already sets `data-theme` on `<html>` synchronously, as the first child of `<head>`, before any JS bundle (including `ThemeToggle`) parses -- so this fix only ever affects the toggle's own label/icon settling one frame later, never the page's actual visible theme.

- **Task 3:** Before the fix, `pnpm exec vitest run apps/web/src/lib/require-session.test.ts` failed the new at-most-once test:
  ```
  AssertionError: expected "vi.fn()" to be called 1 times, but got 3 times
  ```
  The other four new unit tests (mount-time redirect, success no-op, `NETWORK_ERROR` no-op, SSR no-op) already passed against the pre-fix code -- confirming those specific behaviours were already correct and only the at-most-once guard and the post-mount SSE-drop trigger were missing. The E2E case (`@shell a session revoked server-side redirects the open tab...`) has no meaningful RED to capture separately: it exercises the layout wiring, which did not exist at all before this task (no unit test covers `(shell)/layout.tsx` per this plan's own `files_modified`).

## Files Created/Modified

- `apps/web/src/app/page.tsx` (new) -- root route, `redirect('/servers')`.
- `packages/ui/src/ThemeToggle.tsx` -- deterministic `'system'` initial state, mount-effect storage adoption, `settledRef`-guarded data-theme write.
- `packages/ui/src/ThemeToggle.test.tsx` -- new hydration-parity test (`renderToString` + `hydrateRoot` + `onRecoverableError`).
- `apps/web/src/lib/require-session.ts` -- at-most-once `hasRedirected` guard; `withTimeout`/`timedOutFailure` removed.
- `apps/web/src/lib/require-session.test.ts` (new) -- 5 unit tests (mount redirect, success, `NETWORK_ERROR`, at-most-once, SSR no-op).
- `apps/web/src/app/(shell)/layout.tsx` -- new `wasConnectedRef`-gated effect on `serverEvents.connected` that re-runs `requireSession()`.
- `tests/e2e/shell.spec.ts` -- two new `@shell` root-route tests, one new `@shell` revoked-session test, `sidebarLink()` helper scoping every sidebar nav locator to `shell-sidebar`.

## Decisions Made

See frontmatter `key-decisions` for the full rationale on each. Summary:
1. `require-session.ts`'s old 5s timeout race is **removed**, not kept -- superseded by `api-client.ts`'s own 15s `AbortSignal.timeout` (plan 05-28), and its old fail-closed-to-logout behaviour on a hang is now actively wrong given this function is also invoked from a background signal.
2. The post-mount revocation trigger reads `useServerEvents()`'s existing `connected` boolean inside the layout that already owns the hook instance -- no changes to `use-server-events.ts` or `shell-context.tsx` (both outside this plan's `files_modified`), no polling interval.
3. ThemeToggle's fix makes the *initial value* deterministic rather than gating storage reads behind a `typeof window` check (which would be dead code in a Client Component that never runs server-side to begin with).
4. The hydration test uses `hydrateRoot`'s `onRecoverableError` callback -- verified empirically that this React 19.3.0/react-dom 19.3.0 build throws hydration mismatches internally inside its scheduler and recovers before any `console.error` call, making `onRecoverableError` the only deterministic, synchronous signal available.

## Deviations from Plan

### Auto-fixed Issues

**1. [Orchestrator-assigned, treated as Rule 1 -- Bug] Scope shell.spec.ts's sidebar locators to shell-sidebar**
- **Found during:** assigned by the orchestrator at plan start (a regression the wave-1 full E2E gate found in a file this plan already owns).
- **Issue:** `tests/e2e/shell.spec.ts:87`'s keyboard-navigation test used unscoped `page.getByRole('link', { name: 'Activity' })` (and similarly for `Settings`/`Servers`), which fails Playwright's strict-mode check once plan 05-32's activity specs create servers named `activity-refresh-fail-*`/`activity-refresh-gap-*` on the shared E2E stack -- their list-row links have an accessible name that contains "activity" as a case-insensitive substring, which Playwright's default (non-exact) `name` matching also matches.
- **Fix:** Added a `sidebarLink(page, name)` helper that scopes every sidebar nav locator in the file to `page.getByTestId('shell-sidebar')`, and replaced every such locator (Tab-activation test lines 90/95/100, responsive-collapse test lines 124/127/128 in the pre-change file) with it.
- **Files modified:** `tests/e2e/shell.spec.ts`
- **Verification:** Ran `tests/e2e/activity.spec.ts` and `tests/e2e/shell.spec.ts` together in one Playwright invocation (so the colliding servers exist), twice -- 22/22 passed both times, no strict-mode violation.
- **Committed in:** `1ab12c4` (separate commit, as instructed)

---

**Total deviations:** 1 (orchestrator-assigned, not discovered independently).
**Impact on plan:** No scope creep -- the fix stayed entirely inside `tests/e2e/shell.spec.ts`, a file this plan already owns per its own `files_modified` list, and did not touch `activity.spec.ts` as instructed.

## Issues Encountered

- The first hydration-mismatch test design (spying on `console.error`) did not work: this React 19.3.0/react-dom 19.3.0 build throws the mismatch as an internal exception inside `flushActQueue`'s scheduler pass, which surfaced in Vitest as an "Unhandled Errors / Uncaught Exception" rather than a synchronous assertion failure inside the test -- a real signal, but not a reliable one to assert against directly. Redesigned around `hydrateRoot`'s own documented `onRecoverableError` option, which fires synchronously inside the same `act()` call and gave a clean, deterministic RED/GREEN.
- No other issues -- all three tasks' behaviour matched what direct code reading (per each task's `read_first` list) predicted; no surprises in `proxy.ts`, `theme-script.ts`, `use-server-events.ts`, or `api-client.ts`'s existing timeout wiring.

## User Setup Required

None -- no external service configuration required.

## Next Phase Readiness

- All three `must_haves.truths` from the plan frontmatter hold, verified: (1) an authenticated visit to `/` lands on `/servers`; (2) a stored theme preference produces zero recoverable hydration errors; (3) a tab whose session is revoked server-side redirects to `/login` on its own, within one SSE heartbeat interval, with no manual reload.
- Full `pnpm test:e2e` run once at the end (hard rule 10's session-revocation exception): **92/92 passed**, ~1.4 min, zero unexpected failures, zero flake across two additional targeted re-runs of the affected files.
- `pnpm lint`, `pnpm typecheck` (including `tests/e2e/tsconfig.json` and `tests/integration/ssh/tsconfig.json`), `pnpm boundaries`, `pnpm test` (unit: **1454/1454** across 114 files) and `pnpm check:ui-safety` all exit 0.
- No blockers for 05-37 (the plan's own final human-verification/full-suite wave).

---
*Phase: 05-ui-web*
*Completed: 2026-09-20*

## Self-Check: PASSED

All 7 created/modified files confirmed present on disk; all 4 commits (`6a04f3c`, `be9a2d0`, `da592a4`, `1ab12c4`) confirmed present in `git log`.
