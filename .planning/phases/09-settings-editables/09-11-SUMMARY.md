---
phase: 09-settings-editables
plan: 11
subsystem: web
tags: [react, sheet, forms, a11y, security]

requires:
  - phase: 09-settings-editables plan 06
    provides: "PATCH /api/account/profile contract (name/email + currentPassword)"
  - phase: 09-settings-editables plan 09
    provides: "POST /api/account/password contract ({ sessionsRevoked })"
  - phase: 09-settings-editables plan 10
    provides: "accountFieldErrors, ACCOUNT_GENERIC_ERROR, refreshSessionUser (session-user.ts)"
provides:
  - "apps/web/src/lib/account-form.ts — canSubmitProfile, buildProfileRequest, passwordsMatch, confirmError, canSubmitPassword, passwordNoticeMessage, retryMessage"
  - "apps/web/src/components/AccountProfileSheet.tsx — Sheet for field='name'|'email'"
  - "apps/web/src/components/AccountPasswordSheet.tsx — Change password Sheet"
affects: [09-12]

tech-stack:
  added: []
  patterns:
    - "AccountProfileSheet's FIELD_COPY table is the one place the name/email variance lives -- component logic, testids and copy for both fields share one implementation, following the same per-field-table shape 09-UI-SPEC.md's own worked example used"
    - "handleFailure order in both sheets: unauthorized -> accountFieldErrors mapping -> retryAfterSeconds (REAUTH_LOCKED) -> ACCOUNT_GENERIC_ERROR banner, matching 09-UI-SPEC.md's Copywriting Contract error rows in priority order"

key-files:
  created:
    - apps/web/src/lib/account-form.ts
    - apps/web/src/lib/account-form.test.ts
    - apps/web/src/components/AccountProfileSheet.tsx
    - apps/web/src/components/AccountProfileSheet.test.tsx
    - apps/web/src/components/AccountPasswordSheet.tsx
    - apps/web/src/components/AccountPasswordSheet.test.tsx
  modified: []

key-decisions:
  - "passwordNoticeMessage refines 09-UI-SPEC.md's Notice copy with two extra cases the spec's table did not spell out: sessionsRevoked=0 renders the bare 'Password updated.' (no 'other sessions' clause when there genuinely were none) and sessionsRevoked=1 uses singular 'session was' instead of the spec's always-plural 'were' -- both a grammatical refinement of D-06's rule, not a contradiction (documented in the plan's own Task 1 action as an expected discretion call)"
  - "Both Sheets clear every password-bearing field state on close (Cancel, Esc, outside click, success) in the same effect that returns focus to returnFocusRef.current, rather than as two separate effects -- one close moment, one place password state can be discarded"
  - "AccountPasswordSheet narrows POST /api/account/password's response body with a local isPasswordChangeResponse type guard rather than trusting apiSend<T>'s generic T -- a malformed/unexpected success body degrades to sessionsRevoked=0 (the D-06 'count unknown... wait, count present but zero' safe default) instead of throwing or rendering undefined"

requirements-completed: [SET-02, SET-03]

duration: ~35min
completed: 2026-09-27
---

# Phase 9 Plan 11: Account edit Sheets (Name, Email, Password) Summary

**Three account-edit Sheets — Name, Email, Password — built against 09-10's client contracts, sharing one pure, unit-tested form-logic module (`account-form.ts`) for every submit-gating, request-body-building and copy rule the UI-SPEC requires; no secret ever survives a close, and every error routes to a fixed, product-voice string, never a raw server message.**

## Performance

- **Duration:** ~35 min
- **Started:** 2026-09-27T10:14:00Z
- **Completed:** 2026-09-27T10:20:18Z
- **Tasks:** 2
- **Files modified:** 6 (6 created, 0 modified — excluding this SUMMARY)

## Accomplishments
- `apps/web/src/lib/account-form.ts`: `canSubmitProfile`, `buildProfileRequest` (trims name, trims+lowercases email, never leaks the other field's key), `passwordsMatch`, `confirmError`, `canSubmitPassword`, `passwordNoticeMessage` (with the n=0/n=1 discretion refinement), `retryMessage` (reuses `error-copy.ts`'s `formatRetryAfterDuration`) — every rule the two Sheets apply is a tested pure function, zero React/apiSend/fetch imports
- `apps/web/src/components/AccountProfileSheet.tsx`: one component for both `field='name'` and `field='email'`, driven by a per-field copy table (testids, title, input type/autoComplete, save label); Save disabled until `canSubmitProfile`; on success calls `refreshSessionUser()` (D-04) then closes; `INVALID_CREDENTIAL`/`EMAIL_DOMAIN_UNRESOLVABLE`/`EMAIL_DOMAIN_CHECK_UNAVAILABLE` route to field errors via `accountFieldErrors`, a 429 renders `retryMessage` in a `Banner`, anything else renders `ACCOUNT_GENERIC_ERROR`
- `apps/web/src/components/AccountPasswordSheet.tsx`: current + new + confirm fields; a client-side mismatch (`confirmError`) blocks submit before any round trip; on success reports `sessionsRevoked` to `onSaved` (the Settings page, plan 09-12, owns rendering the D-06 Notice) and closes
- Both Sheets: password-bearing state is cleared and focus returns to `returnFocusRef.current` in the same close effect (Cancel, Esc, outside click or a successful save all funnel through the same `open === false` transition); both inputs disable and the primary button shows `aria-busy` while submitting, preventing a double-submit race (T-09-31)
- 38 new tests total (20 in `account-form.test.ts`, 18 across the two Sheet test files) covering every behavior bullet in the plan

## Task Commits

Each task followed RED → GREEN:

1. **Task 1: Pure account form logic**
   - `5a993be` test(09-11): add failing test for account form logic
   - `f240473` feat(09-11): add pure account form logic module
2. **Task 2: AccountProfileSheet and AccountPasswordSheet**
   - `04d3fad` test(09-11): add failing tests for AccountProfileSheet and AccountPasswordSheet
   - `f311e6e` feat(09-11): add AccountProfileSheet and AccountPasswordSheet

## Files Created/Modified
- `apps/web/src/lib/account-form.ts` - pure form-logic module (Task 1)
- `apps/web/src/lib/account-form.test.ts` - 20 unit tests
- `apps/web/src/components/AccountProfileSheet.tsx` - Name/Email Sheet
- `apps/web/src/components/AccountProfileSheet.test.tsx` - 12 component tests
- `apps/web/src/components/AccountPasswordSheet.tsx` - Password Sheet
- `apps/web/src/components/AccountPasswordSheet.test.tsx` - 6 component tests (kept small; the shared behaviors already proven by AccountProfileSheet's suite — disabled-while-submitting, close-clears-state, focus-return — are each asserted once per Sheet, not duplicated per field)

## Decisions Made
See `key-decisions` in the frontmatter above (the passwordNoticeMessage discretion refinement, the shared close/focus-return effect, and the response-body type guard on the password Sheet).

## Deviations from Plan

None. Both tasks followed the plan's `<action>` sections directly; the only adjustments were two ESLint `no-unnecessary-type-assertion`/`no-confusing-void-expression` fixes made inline during each task's own GREEN pass, before that task's single feat commit (not a separate deviation, no behavior change).

## Issues Encountered
None.

## User Setup Required
None - no external service configuration required.

## Verification
- `pnpm exec vitest run apps/web/src/lib/account-form.test.ts apps/web/src/components/Account*.test.tsx` — 38/38 pass
- `pnpm --filter @noodara/web typecheck` / `lint` — clean
- `pnpm test` — 174 files, 2982/2982 pass
- `pnpm lint` / `pnpm typecheck` (whole monorepo) — clean
- `pnpm boundaries` — no issues (the 09-10 `@testing-library/react` gap was already fixed upstream in `879cf7d`, ahead of this plan)
- `pnpm check:ui-safety` — all repo-wide UI safety gates hold
- `git diff --stat -- packages/ui/src/Sheet.tsx` — no change, confirmed empty

## Next Phase Readiness
- `AccountProfileSheet`/`AccountPasswordSheet` and `account-form.ts` are ready to mount — plan 09-12 wires all three into the `Account` `InsetGroup` (Name/Email/Password rows with `Edit`/`Change` buttons, each owning its own `open` state and trigger ref) and renders the D-06 password-change `Notice` on `/settings` using `AccountPasswordSheet`'s `onSaved(sessionsRevoked)` callback.
- No blockers identified for the next plan in the wave.

---
*Phase: 09-settings-editables*
*Completed: 2026-09-27*

## Self-Check: PASSED

All created files and commit hashes verified present.
