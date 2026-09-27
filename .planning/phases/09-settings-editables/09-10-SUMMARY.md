---
phase: 09-settings-editables
plan: 10
subsystem: auth
tags: [react, useSyncExternalStore, nextjs, error-handling, a11y]

requires:
  - phase: 09-settings-editables
    provides: "09-06/09-08/09-09's backend error codes and endpoint shapes (EMAIL_DOMAIN_UNRESOLVABLE, EMAIL_DOMAIN_CHECK_UNAVAILABLE, REAUTH_LOCKED, SESSION_REVOKED_PASSWORD_CHANGED; GET/PATCH /api/account/preferences; POST /api/account/password's 401 marker)"
  - phase: 09-settings-editables
    provides: "09-07's applyPreferences/readPreferencesMirror single browser write path (packages/ui/src/ThemeToggle.tsx)"
provides:
  - "api-client.ts recognises the four new account/session error codes end to end"
  - "error-copy.ts's accountFieldErrors(failure) -- the one field-error router the Name/Email/Password Sheets (09-11) will call"
  - "require-session.ts redirects a password-revoked tab to /login?reason=password-changed&redirect=..."
  - "session-user.ts is a shared useSyncExternalStore-backed store: useSessionUser/useAccountPreferences/refreshSessionUser/setStoredPreferences"
  - "/login shows the password-changed Notice and a single, correct generic-failure banner for every non-2xx/network outcome"
  - "Notice.tsx carries role=\"status\" for every caller"
affects: [09-11, 09-12]

tech-stack:
  added: []
  patterns:
    - "Shared client store via useSyncExternalStore with a module-level snapshot, a Set of listeners and a self-clearing loadPromise for concurrent-load dedup, rather than a per-mount useEffect fetch"
    - "accountFieldErrors: code-based routing (email-domain codes) takes priority over issue-path routing, both backed by fixed copy only -- never failure.message"

key-files:
  created: []
  modified:
    - apps/web/src/lib/api-client.ts
    - apps/web/src/lib/error-copy.ts
    - apps/web/src/lib/require-session.ts
    - apps/web/src/lib/session-user.ts
    - apps/web/src/app/login/page.tsx
    - packages/ui/src/Notice.tsx
    - tests/e2e/auth.spec.ts

key-decisions:
  - "genericFailureMessage on /login now returns the fixed ACCOUNT_GENERIC_ERROR ('Something went wrong. Try again.') for every code except NETWORK_ERROR, instead of routing through copyForErrorCode -- the banner was never actually unset (contrary to the deferred item's literal wording), it rendered INTERNAL_ERROR's own longer copy instead of the UI-SPEC's exact generic string"
  - "session-user.ts's ensureLoaded() clears its own loadPromise once settled, so a fresh mount after every previous subscriber has unmounted starts a genuinely new load, while concurrent subscribers mounting together still share one in-flight fetch"

patterns-established:
  - "accountFieldErrors(failure: ApiFailure) as the one Sheet-facing field-error router for account forms, parallel to fieldErrorsFromIssues for server forms"

requirements-completed: [SET-02, SET-03, SET-04]

duration: 10min
completed: 2026-09-27
---

# Phase 9 Plan 10: Web client wiring for account/session contracts Summary

**Web client now understands the four new account/session error codes, session-user.ts is a shared useSyncExternalStore store with server-wins preference reconciliation, and /login shows a password-changed Notice plus a correctly-worded, always-visible failure banner.**

## Performance

- **Duration:** ~10 min
- **Started:** 2026-09-27T03:19:53-06:00
- **Completed:** 2026-09-27T03:28:53-06:00
- **Tasks:** 3
- **Files modified:** 8

## Accomplishments
- `ApiErrorCode`/`API_ERROR_CODE_MARKER` recognise `EMAIL_DOMAIN_UNRESOLVABLE`, `EMAIL_DOMAIN_CHECK_UNAVAILABLE`, `REAUTH_LOCKED` and `SESSION_REVOKED_PASSWORD_CHANGED` end to end, never degrading to `INTERNAL_ERROR`
- `error-copy.ts` gained the four codes' UI-SPEC copy, `ACCOUNT_GENERIC_ERROR`, and `accountFieldErrors(failure)` -- the fixed-copy-only router the 09-11 Sheets will call for Name/Email/Password field errors
- `require-session.ts` redirects a session revoked by a password change to `/login?reason=password-changed&redirect=...`; a plain 401 keeps the existing redirect unchanged
- `session-user.ts` is now a shared, module-level store (`useSyncExternalStore`) instead of a per-mount fetch: `refreshSessionUser()` re-fetches identity for every subscriber (D-04), and preferences load alongside get-session with the server overwriting the `noodara-prefs` mirror when they differ (D-10)
- `/login?reason=password-changed` shows the `login-password-changed-notice` Notice; every non-2xx/network sign-in failure now renders the exact "Something went wrong. Try again." banner (root cause below)
- `Notice.tsx` carries `role="status"` for every caller (09-UI-SPEC.md SS5.3)

## Task Commits

Each task was committed atomically (TDD: test -> feat/fix):

1. **Task 1: Error codes, account copy, and the reason-aware heartbeat redirect**
   - `287d474` (test) - failing tests for the four codes, `accountFieldErrors`, and the reason redirect
   - `4f6d8a3` (feat) - implementation
2. **Task 2: Shared session store with on-demand refresh and server-wins preference reconciliation**
   - `dc21cfd` (test) - failing tests for the shared store (rewritten `session-user.test.ts`)
   - `bb44602` (feat) - implementation, plus a lint fix folded into the same commit
3. **Task 3: /login password-changed Notice and the always-visible failure banner**
   - `efa14a7` (test) - failing Notice.tsx role assertion and 6 new `@auth` E2E cases
   - `23043cd` (fix) - Notice.tsx `role="status"`, `/login`'s Notice and generic-banner fix

**Plan metadata:** committed at close of this plan (see final commit).

## Files Created/Modified
- `apps/web/src/lib/api-client.ts` - four new `ApiErrorCode` members and marker entries
- `apps/web/src/lib/error-copy.ts` - four new copy entries, `currentPassword`/`newPassword` form fields, `ACCOUNT_GENERIC_ERROR`, `accountFieldErrors`
- `apps/web/src/lib/require-session.ts` - `redirectToLogin(reason?)`, reason routing on `SESSION_REVOKED_PASSWORD_CHANGED`
- `apps/web/src/lib/session-user.ts` - rewritten as a shared `useSyncExternalStore` store: `useSessionUser`, `useAccountPreferences`, `refreshSessionUser`, `setStoredPreferences`; `loadSessionUser` kept exported unchanged
- `apps/web/src/app/login/page.tsx` - password-changed Notice, corrected `genericFailureMessage`
- `packages/ui/src/Notice.tsx` - `role="status"`
- `tests/e2e/auth.spec.ts` - 6 new `@auth` cases (Notice, 403/500 generic banner, 401/429 regression fence)
- `apps/web/src/lib/api-client.test.ts`, `error-copy.test.ts`, `require-session.test.ts`, `session-user.test.ts`, `packages/ui/src/Notice.test.tsx` - RED/GREEN coverage for the above

## Decisions Made
- Kept `Sidebar.tsx`/`Sidebar.test.tsx` untouched: the new store's `ensureLoaded()` re-triggers a fresh load on every 0->1 listener transition (each `useSyncExternalStore` `subscribe` call), so a fresh Sidebar mount in a later test still observes that test's own mocked `apiGet` response rather than a permanently cached value from an earlier test in the same file -- verified by re-running `Sidebar.test.tsx` unmodified against the new store (19/19 pass).
- `session-user.test.ts` opts into the `jsdom` environment via a per-file `// @vitest-environment jsdom` pragma (its `apps` Vitest project otherwise runs `node`) so `@testing-library/react`'s `renderHook` can exercise `useSessionUser`/`useAccountPreferences` directly; the pre-existing `loadSessionUser` describe block is unaffected by the switch.

## Deviations from Plan

None beyond what Task 3 itself asked for (root cause investigation).

### Root cause: /login's "silent" generic-failure banner (Task 3, Pitfall 6 / deferred-items.md)

- **Found during:** Task 3, writing the RED E2E case for a 403 `INVALID_ORIGIN` sign-in failure.
- **Actual behavior before this plan:** the banner was **not** literally unset/invisible. `genericFailureMessage` fell through to `copyForErrorCode(code)`, and any unrecognized backend code (Better Auth's own `INVALID_ORIGIN`, which uses a `{ code, message }` shape api-client.ts's `raw.error` lookup never matches) already degraded to `INTERNAL_ERROR` per Gap 6's existing drift guard. `copyForErrorCode('INTERNAL_ERROR')` returns "Something went wrong on our end. Try again, and check the server logs if it continues." -- a real, visible banner, just not the exact string 09-UI-SPEC.md §4.2 requires ("Something went wrong. Try again.").
- **Fix:** `genericFailureMessage` now returns the fixed `ACCOUNT_GENERIC_ERROR` string for every code except `NETWORK_ERROR` (which keeps its own crafted, non-raw message from api-client.ts), rather than routing through `copyForErrorCode`. This matches 09-UI-SPEC.md's exact requirement that the banner is unconditional for every non-2xx/network outcome.
- **Files modified:** `apps/web/src/app/login/page.tsx`
- **Verification:** new `@auth` E2E cases for a 403 `INVALID_ORIGIN` response and a 500 with a non-JSON body, both asserting the exact banner text and that the raw server text never appears; existing 401/429 cases re-asserted unchanged.
- **Committed in:** `efa14a7` (test), `23043cd` (fix)

## Issues Encountered
None beyond the root-cause investigation above.

## User Setup Required

None - no external service configuration required.

## Next Phase Readiness
- 09-11/09-12 can now build the Account/Appearance Sheets and controls against `accountFieldErrors`, `useSessionUser`/`useAccountPreferences`, `refreshSessionUser`, and `setStoredPreferences` directly.
- D-07's client half is complete against the 09-09-PLAN.md contract as written; the actual `SESSION_REVOKED_PASSWORD_CHANGED` 401 marker ships in 09-09 (wave 4) -- no backend change was made or assumed here.

---
*Phase: 09-settings-editables*
*Completed: 2026-09-27*

## Self-Check: PASSED

All created/modified files and all task commit hashes verified present.
