---
phase: 09-settings-editables
plan: 09
subsystem: auth
tags: [better-auth, fastify, drizzle, argon2, session-revocation, activity-log]

# Dependency graph
requires:
  - phase: 09-settings-editables plan 05
    provides: "createReauthGuard/ReauthGuard (per-user current-password lockout)"
  - phase: 09-settings-editables plan 06
    provides: "routes/account.ts's thin-route/requireActor pattern, http-errors.ts's REAUTH_LOCKED/SESSION_REVOKED_PASSWORD_CHANGED codes, account-schemas.ts's ChangePasswordBodySchema/ChangePasswordResponseSchema"
  - phase: 09-settings-editables plan 10
    provides: "the web client contract this plan's 401 marker fulfils (require-session.ts's /login?reason=password-changed redirect, error-copy.ts's accountFieldErrors)"
provides:
  - "recordPasswordChangeRevocations/findRevocationReason (apps/control-plane/src/auth/session-revocation-markers.ts) — sha256-hashed session-token markers in Better Auth's own verifications table"
  - "requireSession's optional resolveRevocationReason dep and request.sessionId decoration (apps/control-plane/src/auth/require-session.ts)"
  - "changeAccountPassword service (apps/control-plane/src/services/change-account-password.ts)"
  - "POST /api/account/password (apps/control-plane/src/routes/account.ts)"
  - "tests/integration/activity/canary-account.test.ts wired into pnpm security:scan-leaks"
affects: [09-11, 09-12, 09-13, 09-14]

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "ChangePasswordDelegate: a narrow (args) => Promise<{ headers: Headers }> injection seam over auth.api.changePassword — the service never even receives Better Auth's own { token, user } response body, only the rotated Set-Cookie headers, closing T-09-05 at the type boundary rather than by discipline alone"
    - "Session-revocation markers reuse Better Auth's own verifications table (identifier = 'session-revoked:' + sha256hex(token), value = 'password_changed', expiresAt = the revoked session's own expiresAt) instead of a new migration — no raw token ever stored"
    - "requireSession's resolveRevocationReason runs only on the already-401 branch, bounded by the same withSessionLookupTimeout as getSession, and any rejection/hang/absence degrades to the unchanged plain UNAUTHORIZED body — a revoked-session lookup can only add information, never fail open or hang"

key-files:
  created:
    - apps/control-plane/src/auth/session-revocation-markers.ts
    - apps/control-plane/src/services/change-account-password.ts
    - tests/integration/account/password.test.ts
    - tests/integration/activity/canary-account.test.ts
  modified:
    - apps/control-plane/src/auth/require-session.ts
    - apps/control-plane/src/auth/require-session.test.ts
    - apps/control-plane/src/routes/api-scope.ts
    - apps/control-plane/src/routes/account.ts
    - apps/control-plane/src/logger.ts
    - package.json

key-decisions:
  - "Confirmed Better Auth 1.7.4's changePassword contract by reading update-user.mjs directly (not just testing it): revokeOtherSessions:true deletes every other session row, creates and cookie-sets a fresh one, and resolves { token, user } with no count — sessionsRevoked is therefore computed by this plan's own pre-change SELECT of the admin's other sessions.session, never derived from Better Auth's response"
  - "A wrong currentPassword throws Better Auth's own APIError with status 'BAD_REQUEST' and body.code 'INVALID_PASSWORD' (pinned by password.test.ts's own contract describe) — change-account-password.ts catches specifically that code via isAPIError and rethrows anything else for the global handler to redact (D-22)"
  - "getSessionCookie (better-auth/cookies) + the part before the cookie's first '.' is exactly the raw value Better Auth stores in sessions.token — confirmed against session-management.test.ts's own pre-existing sessionTokenFromCookie helper before wiring api-scope.ts's resolveRevocationReason"
  - "isAPIError/'better-auth/api' cannot be imported directly from tests/ (only apps/control-plane declares it as a dependency; pnpm does not hoist it to the workspace root) — password.test.ts's own contract test asserts the APIError shape structurally (name/status/statusCode/body.code) instead, while the production service still imports the real isAPIError, exactly like login-guard.ts already does"
  - "Better Auth's own auth.api.signUpEmail (setup-service.ts, out of this plan's scope) auto-creates a session row nobody ever captures a cookie for during POST /api/setup — password.test.ts's POST /api/account/password describe deletes all session rows right after createAdmin() so each test's 'how many other sessions exist' precondition is genuinely known, rather than silently off-by-one against this pre-existing setup quirk"
  - "Added req.body.currentPassword/req.body.newPassword to logger.ts's pino redact.paths as defense-in-depth (Rule 2) — Fastify's default request serializer never logs req.body today (confirmed: no custom serializer is configured), so this is not what currently prevents a leak, but a future serializer change must not silently start leaking these two new fields"

requirements-completed: [SET-03]

# Metrics
duration: ~90min
completed: 2026-09-27
---

# Phase 9 Plan 09: POST /api/account/password — v0.1 policy, full session revocation, reason-aware 401 Summary

**`POST /api/account/password` delegates to Better Auth's `changePassword` with `revokeOtherSessions: true`, forwards the rotated session cookie so the calling tab survives, reports the exact revoked-session count computed before the call (Better Auth's own response carries none), and marks each revoked token in Better Auth's own `verifications` table so `requireSession` can answer a stale cookie with `SESSION_REVOKED_PASSWORD_CHANGED` instead of a generic 401 — closing the D-07 loop the 09-10 client already built against.**

## Performance

- **Duration:** ~90 min
- **Tasks:** 3
- **Files modified:** 10 (4 created, 6 modified — excluding this SUMMARY)
- **Completed:** 2026-09-27

## Accomplishments
- `apps/control-plane/src/auth/session-revocation-markers.ts`: `recordPasswordChangeRevocations`/`findRevocationReason` — sha256-hashed session-token markers stored in Better Auth's own `verifications` table (no migration needed), expiring alongside the revoked session's own `expiresAt`
- `apps/control-plane/src/auth/require-session.ts`: an optional `resolveRevocationReason` dep, bounded by the same `withSessionLookupTimeout` as `getSession`, turning a revoked cookie's 401 into `SESSION_REVOKED_PASSWORD_CHANGED` (D-07) without ever risking a hang or a 500; `request.sessionId` decoration for the password route to know "which session is this request's own"
- `apps/control-plane/src/routes/api-scope.ts`: wires the real `resolveRevocationReason` — `getSessionCookie` (better-auth/cookies) extracts the raw token, `findRevocationReason` looks it up
- `apps/control-plane/src/services/change-account-password.ts`: `changeAccountPassword` — ReauthGuard throttle → v0.1 `validatePassword` → pre-change snapshot of the admin's other sessions → delegated Better Auth call → on `INVALID_PASSWORD` a field-tagged 400 and a recorded lockout failure, on success a cleared throttle, recorded revocation markers, one `account.password_changed` activity event with `{ sessions_revoked }`, and only the rotated `Set-Cookie` values returned — Better Auth's own response body never leaves the service
- `apps/control-plane/src/routes/account.ts`: `POST /api/account/password`, forwarding each `Set-Cookie` individually and replying `{ sessionsRevoked }` only
- `tests/integration/account/password.test.ts`: a "Better Auth 1.7.4 changePassword contract" describe pinning the third-party behavior directly, a "session revocation markers" describe, and 10 integration tests against the real route covering every plan behavior bullet
- `tests/integration/activity/canary-account.test.ts`: a per-run random password canary driven through profile/password/preferences endpoints, scanning response bodies, headers, logs and activity metadata — now part of `pnpm security:scan-leaks`

## Task Commits

Each task followed RED → GREEN:

1. **Task 1: Better Auth contract pin, revocation markers, and the reason-bearing 401**
   - `ad62691` test(09-09): add failing tests for revocation markers and reason-aware 401
   - `af1e877` feat(09-09): add session-revocation markers and reason-aware 401
2. **Task 2: changeAccountPassword service and POST /api/account/password**
   - `3912d09` test(09-09): add failing tests for POST /api/account/password
   - `ebcf7f7` feat(09-09): add changeAccountPassword service and POST /api/account/password
3. **Task 3: Canary leak proof for the account endpoints, wired into security:scan-leaks**
   - `5f76cd2` fix(09-09): redact account password body fields defensively in logs (Rule 2 auto-fix, ahead of the canary test)
   - `27e6538` test(09-09): add account canary and wire into security:scan-leaks

## Files Created/Modified
- `apps/control-plane/src/auth/session-revocation-markers.ts` - `recordPasswordChangeRevocations`, `findRevocationReason`, `REVOCATION_IDENTIFIER_PREFIX`, `RevocationReason`
- `apps/control-plane/src/auth/require-session.ts` - `resolveRevocationReason` dep, `ResolveRevocationReason` type, `request.sessionId` decoration, the `SESSION_REVOKED_PASSWORD_CHANGED` 401 branch
- `apps/control-plane/src/auth/require-session.test.ts` - reason/sessionId unit coverage (resolves, rejects, hangs, absent)
- `apps/control-plane/src/routes/api-scope.ts` - the real `resolveRevocationReason` wiring via `getSessionCookie`/`findRevocationReason`
- `apps/control-plane/src/services/change-account-password.ts` - `changeAccountPassword`, `ChangeAccountPasswordFailureCode`, `ChangePasswordDelegate`
- `apps/control-plane/src/routes/account.ts` - `POST /api/account/password`, `requireSessionId`, `realChangePassword`, `ChangePasswordErrorSchema`
- `apps/control-plane/src/logger.ts` - two new `redact.paths` entries (defense-in-depth)
- `tests/integration/account/password.test.ts` - contract + markers + 10 route integration tests
- `tests/integration/activity/canary-account.test.ts` - the account-endpoints canary
- `package.json` - `security:scan-leaks` now includes `canary-account.test.ts`

## Decisions Made
See `key-decisions` in the frontmatter above (Better Auth contract shapes, the setup-flow orphan-session test fix, the `isAPIError`/tests-workspace resolution constraint, the defense-in-depth logger redaction).

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 2 - Missing Critical] Added `req.body.currentPassword`/`req.body.newPassword` to `logger.ts`'s pino redact paths**
- **Found during:** Task 3, before writing the canary test
- **Issue:** `logger.ts`'s `REDACT_PATHS` already redacts `req.body.password`/`sshPassword`/`sshPrivateKey` but had no entry for this plan's two new body field names
- **Fix:** Added `req.body.currentPassword` and `req.body.newPassword`, documented as defense-in-depth since Fastify's default request serializer never logs `req.body` today
- **Files modified:** apps/control-plane/src/logger.ts
- **Verification:** `apps/control-plane/src/logger.test.ts` (12/12) still passes; `pnpm --filter @noodara/control-plane typecheck`/`lint` clean
- **Committed in:** `5f76cd2`

**2. [Process] `isAPIError` from `better-auth/api` cannot be imported directly from a test file under `tests/`**
- **Found during:** Task 1's RED run of the contract describe
- **Issue:** `better-auth` is only a declared dependency of `apps/control-plane`, not of the workspace root; pnpm does not hoist it, so `await import('better-auth/api')` from `tests/integration/account/password.test.ts` throws `Cannot find package`
- **Fix:** The contract test asserts the caught error's shape structurally (`name === 'APIError'`, `status === 'BAD_REQUEST'`, `statusCode === 400`, `body.code === 'INVALID_PASSWORD'`) instead of importing `isAPIError`. Production code (`change-account-password.ts`) is unaffected — it still imports the real `isAPIError`, exactly like `login-guard.ts` already does, since it lives inside `apps/control-plane`.
- **Files modified:** tests/integration/account/password.test.ts (test-only)
- **Committed in:** `ad62691` (RED, already reflects the fix), `af1e877` (GREEN)

**3. [Process] Better Auth's own `signUpEmail` (used by `POST /api/setup`) leaves an orphan session row**
- **Found during:** Task 2's first GREEN run — `sessionsRevoked` came back one higher than every test expected
- **Issue:** `setup-service.ts`'s `redeemSetupToken` calls `auth.api.signUpEmail`, which auto-creates a session Better Auth itself would use for a browser-based sign-up flow. `routes/setup.ts` never forwards its cookie, so the row is real but nobody in the test (or, likely, in production) ever has its credential — yet it is a genuine "other session" as far as `changeAccountPassword`'s own count is concerned, since the count's whole point is to be exactly correct.
- **Fix:** `password.test.ts`'s `POST /api/account/password` describe deletes all session rows immediately after `createAdmin()`, giving each test a known, deliberate session count to assert against — a test-only fix; `setup-service.ts` itself is out of this plan's `files_modified` list and was not touched.
- **Files modified:** tests/integration/account/password.test.ts (test-only)
- **Committed in:** `3912d09` (RED, already reflects the fix), `ebcf7f7` (GREEN)

### Out-of-scope, logged and not fixed

**4. Pre-existing `pnpm boundaries` failure: `apps/web/src/lib/session-user.test.ts` imports `@testing-library/react` without declaring it as a dependency**
- **Found during:** this plan's own required `pnpm boundaries` verification run
- **Why out of scope:** introduced by `bb44602` (09-10, before this plan's own work began) — confirmed via `git log --oneline -1 -- apps/web/src/lib/session-user.test.ts`; none of this plan's files touch `apps/web`
- **Action:** logged to `.planning/phases/09-settings-editables/deferred-items.md`, not fixed (scope-boundary rule)

---

**Total deviations:** 2 auto-fixed (1 missing-critical defense-in-depth, 1 process/test-fix documented twice for two separate root causes), 1 out-of-scope pre-existing issue logged
**Impact on plan:** No scope creep. The setup-flow orphan-session finding is worth flagging upstream (it means a fresh admin technically always has one untracked session immediately after `/api/setup` until they explicitly sign in and change password) but does not affect this plan's own correctness — `changeAccountPassword`'s count is exactly correct given the real session rows that exist at call time.

## Issues Encountered
None beyond the auto-fixed/logged items above.

## User Setup Required
None - no external service configuration required.

## Verification

- `pnpm exec vitest run apps/control-plane/src/auth/require-session.test.ts` — 14/14 pass
- `pnpm exec vitest run --config vitest.integration.config.ts tests/integration/account/password.test.ts` — 16/16 pass
- `pnpm exec vitest run --config vitest.integration.config.ts tests/integration/activity/canary-account.test.ts` — 1/1 pass
- `pnpm exec vitest run --config vitest.integration.config.ts tests/integration/account tests/integration/auth` — 13 files, 97/97 pass
- `pnpm test` — 171 files, 2944/2944 pass
- `pnpm --filter @noodara/control-plane typecheck` / `lint` — clean
- `pnpm typecheck` / `pnpm lint` (whole monorepo) — clean
- `pnpm boundaries` — 1 pre-existing, unrelated failure (see Deviations #4); no new violations from this plan's files
- `pnpm security:scan-leaks` — all 4 Vitest canary suites + the Playwright `@canary` grep pass, including the new `canary-account.test.ts`

## Next Phase Readiness
- `ChangePasswordResponseSchema`'s `{ sessionsRevoked }` shape and the `SESSION_REVOKED_PASSWORD_CHANGED` 401 marker are now both live end to end — 09-10's client wiring (`require-session.ts`'s `/login?reason=password-changed` redirect, `error-copy.ts`'s `accountFieldErrors`) needs no further backend change.
- 09-11 (the Password Sheet UI) can call `POST /api/account/password` directly against this plan's exact contract (`{ currentPassword, newPassword }` → `{ sessionsRevoked }` or a field-tagged 400/`REAUTH_LOCKED` 429).
- The `apps/web` `pnpm boundaries` gap (Deviation #4) should be picked up by whichever future plan next touches `apps/web/package.json` or `session-user.test.ts` — flagged in `deferred-items.md`.

---
*Phase: 09-settings-editables*
*Completed: 2026-09-27*

## Self-Check: PASSED

All created files and commit hashes verified present.
