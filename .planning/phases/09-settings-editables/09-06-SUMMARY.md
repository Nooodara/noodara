---
phase: 09-settings-editables
plan: 06
subsystem: auth
tags: [fastify, drizzle, argon2, dns, activity-log, zod]

requires:
  - phase: 09-settings-editables plan 01
    provides: validateName/validateAccountEmail, account.* activity actions with a metadata allowlist
  - phase: 09-settings-editables plan 05
    provides: createDnsChecker/DnsChecker, createReauthGuard/ReauthGuard
provides:
  - "PATCH /api/account/profile (apps/control-plane/src/routes/account.ts) — name/email edit behind current-password confirmation"
  - "updateAccountProfile service (apps/control-plane/src/services/update-account-profile.ts)"
  - "Four new ServiceErrorCode entries and FieldErrorBodySchema (apps/control-plane/src/routes/http-errors.ts) — the phase's single owner of EMAIL_DOMAIN_UNRESOLVABLE/EMAIL_DOMAIN_CHECK_UNAVAILABLE/REAUTH_LOCKED/SESSION_REVOKED_PASSWORD_CHANGED"
  - "account-schemas.ts — UpdateProfileBodySchema, ChangePasswordBodySchema, UpdatePreferencesBodySchema, AccountProfileResponseSchema, ChangePasswordResponseSchema, PreferencesResponseSchema"
  - "BuildAppDeps.dnsChecker / ApiScopeOptions.dnsChecker DI seam"
affects: [09-08, 09-09, 09-10]

tech-stack:
  added: []
  patterns:
    - "toValidationErrorBody(issues, code?) — a field-tagged service failure reuses the { error, message, issues } shape with its own service code instead of the fixed VALIDATION_FAILED literal, via an optional generic code parameter (default unchanged, every existing caller unaffected)"
    - "Read-then-lock: the DNS check and the current-email comparison run before the transaction opens; the actual update re-reads the users row FOR UPDATE inside deps.db.transaction, so a 3-second-bounded DNS lookup never holds a row lock"
    - "sendFieldError(reply, code, field, message) mirrors servers.ts's own sendServiceError — plain FastifyReply parameter so a runtime-computed status can be passed to reply.code() without fighting the route's Zod-narrowed literal status union"

key-files:
  created:
    - apps/control-plane/src/routes/account-schemas.ts
    - apps/control-plane/src/routes/account-schemas.test.ts
    - apps/control-plane/src/services/update-account-profile.ts
    - apps/control-plane/src/routes/account.ts
    - tests/integration/account/profile.test.ts
  modified:
    - apps/control-plane/src/routes/http-errors.ts
    - apps/control-plane/src/routes/http-errors.test.ts
    - apps/control-plane/src/routes/api-scope.ts
    - apps/control-plane/src/app.ts
    - tests/integration/helpers/app.ts

key-decisions:
  - "toValidationErrorBody gained an optional generic `code` parameter (defaulting to 'VALIDATION_FAILED') instead of a new hand-built body shape, per the plan's own suggestion — keeps every existing caller (app.ts's global schema-validation handler, activity.ts's cursor check) byte-for-byte unchanged"
  - "Added FieldErrorBodySchema (error: z.string() instead of ValidationErrorBodySchema's z.literal('VALIDATION_FAILED')) so a field-tagged service failure's `issues` array survives Zod response serialization instead of being silently stripped by a non-strict ErrorBodySchema"
  - "fetchCredentialHash filters accounts by providerId = 'credential' (Better Auth's own fixed constant for email/password accounts) and folds a missing row and a null password into the same undefined outcome, so an attacker can never distinguish 'no credential account' from 'wrong password' via timing or branching (T-09-09)"
  - "The current-email comparison and the DNS check both run against a plain (non-locked) SELECT before the transaction opens; the actual mutation re-selects users FOR UPDATE inside the transaction and only re-applies whichever fields still differ from the freshly locked row — this keeps DnsChecker's up-to-3000ms bound from ever holding a row lock (T-09-02)"

requirements-completed: [SET-02]

duration: ~80min
completed: 2026-09-27
---

# Phase 9 Plan 06: PATCH /api/account/profile — name/email edit behind current-password confirmation Summary

**`PATCH /api/account/profile` verifies the current password via argon2 against `accounts.password` (never `signInEmail`), throttles wrong attempts through the phase's ReauthGuard, checks a changed email's domain via the injected DnsChecker before writing, and records one allowlisted `account.name_changed`/`account.email_changed` activity row per changed field — this plan also adds the phase's error-code vocabulary (`EMAIL_DOMAIN_UNRESOLVABLE`/`EMAIL_DOMAIN_CHECK_UNAVAILABLE`/`REAUTH_LOCKED`/`SESSION_REVOKED_PASSWORD_CHANGED`) and the `routes/account.ts` module later phase-9 plans extend.**

## Performance

- **Duration:** ~80 min
- **Started:** 2026-09-27T02:00:00Z
- **Completed:** 2026-09-27T08:19:21Z
- **Tasks:** 2
- **Files modified:** 10 (5 created, 5 modified — excluding this SUMMARY)

## Accomplishments
- `apps/control-plane/src/routes/http-errors.ts`: four new `ServiceErrorCode` entries (`EMAIL_DOMAIN_UNRESOLVABLE` 400, `EMAIL_DOMAIN_CHECK_UNAVAILABLE` 503, `REAUTH_LOCKED` 429, `SESSION_REVOKED_PASSWORD_CHANGED` 401), an optional `code` parameter on `toValidationErrorBody`, and a new `FieldErrorBodySchema` for a field-tagged service failure's response shape
- `apps/control-plane/src/routes/account-schemas.ts`: `UpdateProfileBodySchema`, `ChangePasswordBodySchema`, `UpdatePreferencesBodySchema` (reusing `@noodara/domain/preferences`'s `PreferencesPatchSchema`), and the three response schemas — every request schema `.strict()`, rejecting a `userId`/`revokeOtherSessions` mass-assignment attempt
- `apps/control-plane/src/services/update-account-profile.ts`: `updateAccountProfile` — ReauthGuard check → argon2 `verifyPassword` against `accounts.password` (`providerId = 'credential'`) → field validation (`validateName`/`validateAccountEmail`) → DNS check only when the email actually changes → a locked, transactional update writing one `account.*` activity event per changed field
- `apps/control-plane/src/routes/account.ts`: `PATCH /api/account/profile`, registered inside `api-scope.ts`'s `requireSession` scope right after `configRoutes`; a `DnsChecker` DI seam threads from `BuildAppDeps.dnsChecker` (defaulting to a real `createDnsChecker()`) through `apiScope`'s options into the route
- `tests/integration/account/profile.test.ts`: 14 Supertest-via-`app.inject()` integration tests against a real migrated Postgres, covering every behavior bullet in the plan (wrong password, lockout, name/email success, DNS outcomes, validation failures, same-email-different-case, mass-assignment, unauthenticated, cross-origin, session-reflects-change, and a leak canary against the response/logs/activity)

## Task Commits

Each task followed RED → GREEN:

1. **Task 1: Error codes and strict account request schemas**
   - `28b034a` test(09-06): add failing tests for account error codes and request schemas
   - `7161b82` feat(09-06): add account error codes and strict request schemas
2. **Task 2: updateAccountProfile service and PATCH /api/account/profile wired into the guarded scope**
   - `269422c` test(09-06): add failing integration tests for PATCH /api/account/profile
   - `28fdbd5` feat(09-06): implement PATCH /api/account/profile with DnsChecker and ReauthGuard

## Files Created/Modified
- `apps/control-plane/src/routes/http-errors.ts` - four new error codes, `toValidationErrorBody`'s optional `code` param, `FieldErrorBodySchema`
- `apps/control-plane/src/routes/http-errors.test.ts` - mapping tests for the four new codes, the `code`-param behavior, `FieldErrorBodySchema` validation
- `apps/control-plane/src/routes/account-schemas.ts` - the phase's request/response Zod contracts
- `apps/control-plane/src/routes/account-schemas.test.ts` - schema acceptance/rejection tests
- `apps/control-plane/src/services/update-account-profile.ts` - `updateAccountProfile`, `UpdateAccountProfileFailureCode`, `UpdateAccountProfileDeps`
- `apps/control-plane/src/routes/account.ts` - `PATCH /api/account/profile`, `AccountRoutesOptions`
- `apps/control-plane/src/routes/api-scope.ts` - `dnsChecker` option, `accountRoutes` registration
- `apps/control-plane/src/app.ts` - `BuildAppDeps.dnsChecker`, default `createDnsChecker()` wiring into `apiScope`
- `tests/integration/helpers/app.ts` - `StartTestAppOptions.dnsChecker` passthrough
- `tests/integration/account/profile.test.ts` - the 14 integration tests

## Decisions Made
- Extended `toValidationErrorBody` with an optional generic `code` parameter rather than adding a parallel body-building function — every pre-existing call site keeps its exact prior behavior (default `'VALIDATION_FAILED'`)
- Added `FieldErrorBodySchema` as a sibling of `ValidationErrorBodySchema` (non-literal `error`) so a field-tagged `INVALID_CREDENTIAL`/`EMAIL_DOMAIN_UNRESOLVABLE`/`EMAIL_DOMAIN_CHECK_UNAVAILABLE` response's `issues` array is not silently stripped by Zod response serialization against a non-strict `ErrorBodySchema`
- `fetchCredentialHash` filters on `providerId = 'credential'` and folds "no row" and "null password" into the same `undefined`, closing the timing/branching side-channel T-09-09 flags
- The email-domain DNS check and the "did the email actually change" comparison run against a plain, non-locked read before the transaction opens; the transaction itself re-selects `FOR UPDATE` and only reapplies whichever fields still differ — keeps a bounded-but-real network call from ever holding a row lock (T-09-02)

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] Fixed an issue-path bug in the route's field-error responses**
- **Found during:** Task 2's GREEN run (`pnpm exec vitest run --config vitest.integration.config.ts tests/integration/account/profile.test.ts`)
- **Issue:** `toValidationErrorBody`'s `normalizeIssuePath` reads `instancePath` (or an array `path`) to produce the wire `issues[].path`; the route's first draft passed `{ path: field }` (a bare string), which `normalizeIssuePath` does not recognize, so every field-tagged 400/503 response came back with `issues[0].path === ''` instead of `'currentPassword'`/`'name'`/`'email'`
- **Fix:** `sendFieldError` now passes `{ instancePath: field, message }`, and its own comment documents why
- **Files modified:** apps/control-plane/src/routes/account.ts
- **Verification:** all 14 integration tests pass, including the four that assert an exact `issues[0].path`
- **Committed in:** 28fdbd5 (Task 2 GREEN commit)

**2. [Rule 3 - Blocking] Fixed an ESLint no-unused-vars error**
- **Found during:** Task 2's full verification pass (`pnpm --filter @noodara/control-plane lint`)
- **Issue:** `CREDENTIAL_PROVIDER_ID` was declared but the initial `fetchCredentialHash` draft filtered by `providerId` in JS after the query instead of in the `WHERE` clause, leaving the constant unused
- **Fix:** Moved the `providerId = 'credential'` filter into the Drizzle `WHERE` clause itself (also closing T-09-09's timing side-channel more directly — see Decisions above)
- **Files modified:** apps/control-plane/src/services/update-account-profile.ts
- **Verification:** `pnpm --filter @noodara/control-plane lint` and `typecheck` both exit 0; all 14 integration tests still pass
- **Committed in:** 28fdbd5 (Task 2 GREEN commit)

**3. [Process] The Task 1 RED commit (`28b034a`) included the `http-errors.ts` implementation alongside its failing tests**
- **Found during:** self-review after committing
- **Issue:** the four new error codes, the `toValidationErrorBody` code parameter and `FieldErrorBodySchema` were written into `http-errors.ts` before the corresponding `http-errors.test.ts` assertions were added, so the "RED" commit for that file was not actually red (it would have passed immediately). `account-schemas.ts`/`.test.ts` (the rest of Task 1) and all of Task 2 followed true RED→GREEN, confirmed by running the suite before each GREEN commit and observing real failures (404s for Task 2, a missing-module error for Task 1's schema file)
- **Fix:** none applied retroactively (no history rewrite, per this project's git safety rules) — documented here for visibility
- **Files affected:** apps/control-plane/src/routes/http-errors.ts (already committed in 28b034a)
- **Committed in:** 28b034a (acknowledged, not re-done)

---

**Total deviations:** 3 (1 bug auto-fixed, 1 blocking lint fix auto-fixed, 1 process deviation self-reported)
**Impact on plan:** Both auto-fixes were required for the plan's own acceptance criteria and threat-register mitigations (T-09-09, correctness of `issues[].path`). The process deviation did not affect the shipped code's correctness — `http-errors.test.ts`'s 29 assertions (including the four new mappings) pass — but the http-errors.ts portion of Task 1 was not proven RED before GREEN.

## Issues Encountered
None beyond the auto-fixed deviations above.

## User Setup Required
None - no external service configuration required.

## Next Phase Readiness
- `PATCH /api/account/profile`, the four new error codes, and `routes/account.ts`'s thin-route/`AccountRoutesOptions` shape are available for 09-09 (`POST /api/account/password`) and 09-10 (`PATCH /api/account/preferences`) to extend — both should register alongside `accountRoutes` in `api-scope.ts` and reuse `FieldErrorBodySchema`/`toValidationErrorBody`'s code parameter rather than inventing a new error shape.
- `ChangePasswordBodySchema`/`ChangePasswordResponseSchema`/`UpdatePreferencesBodySchema`/`PreferencesResponseSchema` already exist in `account-schemas.ts` (Task 1) but have no route yet — 09-09/09-10's job.
- `SESSION_REVOKED_PASSWORD_CHANGED` (401) is mapped in `http-errors.ts` but unused until 09-09 wires the password-change route and the client-side heartbeat redirect (D-07).
- No blockers identified for the next plan in the wave.

---
*Phase: 09-settings-editables*
*Completed: 2026-09-27*
