---
phase: 09-settings-editables
plan: 05
subsystem: auth
tags: [dns, node-dns, lockout, backoff, testcontainers, vitest]

requires:
  - phase: 09-settings-editables plan 01
    provides: Preferences schema, validateName/validateAccountEmail, account.* activity actions
provides:
  - "createDnsChecker/DnsChecker (apps/control-plane/src/auth/dns-checker.ts) — injectable MX/A resolver check with a 3000ms bound"
  - "createReauthGuard/ReauthGuard (apps/control-plane/src/auth/reauth-guard.ts) — per-user current-password lockout under a reauth:<userId> key"
affects: [09-06, 09-09]

tech-stack:
  added: []
  patterns:
    - "DnsResolverLike narrow structural interface (mirrors require-session.ts's SessionResolver) so tests inject a hand-built fake instead of vi.mock('node:dns')"
    - "Promise.race timeout with a fixed-literal timer, always cleared in finally, mirroring session-lookup.ts's withSessionLookupTimeout shape"
    - "ReauthGuard composes login-attempt-repository.ts's existing loadAttempt/evaluateFailure/recordFailure/isLockedOut/clearAttempts under a distinct scope key, rather than duplicating persistence"

key-files:
  created:
    - apps/control-plane/src/auth/dns-checker.ts
    - apps/control-plane/src/auth/dns-checker.test.ts
    - apps/control-plane/src/auth/reauth-guard.ts
    - tests/integration/account/dns-checker.test.ts
    - tests/integration/account/reauth-guard.test.ts
  modified: []

key-decisions:
  - "ReauthGuardDeps.db is typed as Database (db/client.ts), not ActivityWriteHandle (activity/write-activity-event.ts) — the boundary.test.ts ACT-01 gate reserves that type's module for services/ and activity/ importers, and reauth-guard.ts is neither; Database is the identical NodePgDatabase<typeof schema> shape login-attempt-repository.ts's functions actually accept"
  - "ReauthGuard's default backoff config is DEFAULT_LOGIN_BACKOFF_CONFIG, not login-guard.ts's env-derived backoffConfig() — that function is a private, unexported helper in that module, so there was nothing to reuse by reference; documented in the module's own header comment"

patterns-established:
  - "DnsResolverLike/DnsChecker: the first node:dns injection point in this codebase, following require-session.ts's narrow-interface DI precedent"

requirements-completed: [SET-02, SET-03]

duration: ~55min
completed: 2026-09-27
---

# Phase 9 Plan 05: DnsChecker and ReauthGuard — the two injectable auth adapters Summary

**Injectable MX/A email-domain checker (bounded at 3000ms, classifies resolvable/unresolvable/unavailable) and a per-user ReauthGuard that reuses v0.1's tested progressive-backoff lockout under a `reauth:<userId>` key, separate from the email-keyed sign-in lockout.**

## Performance

- **Duration:** ~55 min
- **Started:** 2026-09-27T01:50:00Z
- **Completed:** 2026-09-27T01:54:30Z
- **Tasks:** 2
- **Files modified:** 5

## Accomplishments
- `createDnsChecker` (`apps/control-plane/src/auth/dns-checker.ts`): validates hostname shape before any query, races `resolveMx`/`resolve4` against a 3000ms timeout (`EMAIL_DOMAIN_LOOKUP_TIMEOUT_MS`), classifies the outcome into `'resolvable' | 'unresolvable' | 'unavailable'`, never throws, always clears its timer, and calls `resolver.cancel()` on timeout when the injected resolver exposes one
- `createReauthGuard` (`apps/control-plane/src/auth/reauth-guard.ts`): `check`/`recordFailure`/`clear` for a per-user throttle on wrong current-password attempts, delegating entirely to `login-attempt-repository.ts`'s existing `loadAttempt`/`recordFailure`/`clearAttempts` and `packages/domain`'s `evaluateFailure`/`isLockedOut`, under scope `'account'` and key `reauth:<userId>` — never touching the email-keyed login-lockout row
- 20 unit tests for `DnsChecker` (hand-built fake resolver, no `vi.mock`) and 1 integration test against the real `node:dns/promises` `Resolver` for a `.invalid` domain
- 6 integration tests for `ReauthGuard` against a real Testcontainers Postgres, including per-user isolation and injected-time lockout expiry

## Task Commits

Each task followed RED → GREEN, plus two small blocking fixes surfaced by the full verification pass:

1. **Task 1: DnsChecker with injected resolver and explicit timeout**
   - `2094c2c` test(09-05): add failing tests for DnsChecker MX/A resolution
   - `32538c0` feat(09-05): implement DnsChecker with injected resolver and timeout
   - `b14a888` fix(09-05): satisfy exactOptionalPropertyTypes in dns-checker test fake
2. **Task 2: ReauthGuard reusing the progressive lockout under a per-user key**
   - `c7fb732` test(09-05): add failing tests for ReauthGuard per-user lockout
   - `f635e60` feat(09-05): implement ReauthGuard for per-user current-password lockout
   - `f88fdb1` fix(09-05): use Database type instead of ActivityWriteHandle in ReauthGuard

## Files Created/Modified
- `apps/control-plane/src/auth/dns-checker.ts` - `DnsChecker`, `DnsResolverLike`, `DnsCheckOutcome`, `EMAIL_DOMAIN_LOOKUP_TIMEOUT_MS`, `createDnsChecker`
- `apps/control-plane/src/auth/dns-checker.test.ts` - 20 unit tests, hand-built fake resolver
- `tests/integration/account/dns-checker.test.ts` - real-resolver `.invalid` domain test
- `apps/control-plane/src/auth/reauth-guard.ts` - `REAUTH_SCOPE_KEY_PREFIX`, `ReauthGuard`, `createReauthGuard`
- `tests/integration/account/reauth-guard.test.ts` - 6 Testcontainers-backed tests

## Decisions Made
- Used `Database` (not `ActivityWriteHandle`) as `ReauthGuardDeps.db`'s type — see key-decisions above; both are structurally identical `NodePgDatabase<typeof schema>`, so no runtime behavior changed, only which module's exported type is referenced
- Documented in `reauth-guard.ts`'s own header comment that `DEFAULT_LOGIN_BACKOFF_CONFIG` is used as the default (not `login-guard.ts`'s private `backoffConfig()`), per the plan's own "note which in the SUMMARY" instruction

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 3 - Blocking] Fixed exactOptionalPropertyTypes violation in dns-checker.test.ts's fake resolver builder**
- **Found during:** Task 2's full verification pass (`pnpm --filter @noodara/control-plane typecheck`)
- **Issue:** `cancel: overrides.cancel` assigned `(() => void) | undefined` to `DnsResolverLike['cancel']`, which under `exactOptionalPropertyTypes: true` cannot accept an explicit `undefined`
- **Fix:** Spread `cancel` into the returned object only when `overrides.cancel !== undefined`
- **Files modified:** apps/control-plane/src/auth/dns-checker.test.ts
- **Verification:** `pnpm --filter @noodara/control-plane typecheck` exits 0; all 20 dns-checker unit tests still pass
- **Committed in:** b14a888

**2. [Rule 3 - Blocking] Fixed an ACT-01 boundary violation in reauth-guard.ts**
- **Found during:** Task 2's full verification pass (`pnpm test`, `apps/control-plane/src/activity/boundary.test.ts`)
- **Issue:** The plan's own interface spec used `ActivityWriteHandle` (from `activity/write-activity-event.ts`) as `ReauthGuardDeps.db`'s type, but that module's boundary test (ACT-01) restricts its importers to `src/services/` and `src/activity/` — `src/auth/` is neither, and `reauth-guard.ts` is not in the file's named pre-ACT01 exception list
- **Fix:** Retyped `ReauthGuardDeps.db` as `Database` (from `db/client.ts`), the identical `NodePgDatabase<typeof schema>` shape `loadAttempt`/`recordFailure`/`clearAttempts` actually accept — no behavior change, only which module's type alias is referenced
- **Files modified:** apps/control-plane/src/auth/reauth-guard.ts
- **Verification:** `pnpm test` (2871 tests, including boundary.test.ts) passes; `pnpm boundaries` clean; reauth-guard integration tests still pass
- **Committed in:** f88fdb1

---

**Total deviations:** 2 auto-fixed (both Rule 3 - blocking type/boundary violations surfaced by the plan's own required verification commands)
**Impact on plan:** Both fixes were required for the plan's own acceptance criteria (`pnpm --filter @noodara/control-plane typecheck` exits 0) and for the codebase's pre-existing ACT-01 gate. No scope creep — no new files, no behavior change.

## Issues Encountered
None beyond the two auto-fixed deviations above.

## User Setup Required
None - no external service configuration required.

## Next Phase Readiness
- `createDnsChecker` and `createReauthGuard` are importable and fully tested; 09-06 (profile edit: name/email/password endpoints) and 09-09 can now wire both adapters into the account services without redefining them.
- `login-guard.ts`'s `backoffConfig()` builder remains unexported — if a future plan wants `ReauthGuard` to share the exact same env-derived config as sign-in lockout, that builder should be exported first.
- No blockers identified for the next plan in the wave.

---
*Phase: 09-settings-editables*
*Completed: 2026-09-27*
