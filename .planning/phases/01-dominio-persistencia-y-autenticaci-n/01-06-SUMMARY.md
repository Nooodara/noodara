---
phase: 01-dominio-persistencia-y-autenticacion
plan: 06
subsystem: domain
tags: [validators, regex, password-policy, activity-log, vitest, coverage]

# Dependency graph
requires:
  - phase: 01-dominio-persistencia-y-autenticacion
    provides: "packages/domain skeleton with validators/network.ts, validators/identity.ts, validators/password.ts, activity/activity-event.ts stubs and their barrels, 95%/95% coverage gate scoped to packages/domain/** (Plan 01-02)"
  - phase: 01-dominio-persistencia-y-autenticacion
    provides: "packages/domain/src/security/secret-value.ts's SecretValue class, used by buildActivityEvent's forbidden-metadata guard (Plan 01-05)"
provides:
  - "packages/domain/src/validators/network.ts: ValidationResult<T>/ok()/fail()/assertDefined() shared shape, validateHost() (IPv4/IPv6/hostname branching, shell-metacharacter/scheme/port/whitespace rejection, lowercasing + trailing-dot normalisation), validateSshPort() (integer-and-range check)"
  - "packages/domain/src/validators/identity.ts: validateServerName() (lowercase slug), validateSshUser() (32-char cap, no leading digit), validateEmail() (length cap, lowercasing)"
  - "packages/domain/src/validators/password.ts + common-passwords.ts: validatePassword() (12-128 char bound, no composition rule, identifier-equality check, 270-entry common-password denylist), PASSWORD_MIN_LENGTH/PASSWORD_MAX_LENGTH"
  - "packages/domain/src/activity/activity-event.ts: ActivityEvent type, AUTH_ACTIONS (8-entry auth action union), buildActivityEvent() with a recursive SensitiveMetadataError guard (forbidden keys + SecretValue instances, through nested objects/arrays)"
affects: ["01-07", "01-09", "01-10", "01-11", "phase-2-ssh", "phase-3-application-services", "phase-4-http-routes-worker"]

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "ValidationResult<T> ({ ok: true, value } | { ok: false, code, message }) defined once in network.ts and re-exported/reused by identity.ts and password.ts, so every validator across packages/domain/src/validators returns the same discriminated shape instead of throwing — phase 4's HTTP handlers can map `code` to a field error without try/catch or string matching"
    - "validateHost branches explicitly on shell-metacharacter/empty/whitespace/scheme checks (raw-string, checked first, most dangerous class), then IPv6-literal, then IPv4-literal (with per-octet range check), then a residual ':' as a host:port rejection, then RFC 1123 per-label hostname validation with a single trailing-dot-aware total-length check — no single catch-all regex, so every failure code is unambiguous and each branch is independently coverable"
    - "node:net is banned in packages/domain (purity.test.ts's BANNED_SPECIFIERS), so IPv4/IPv6 literal detection is implemented with plain regexes instead of net.isIP"
    - "assertDefined<T>(value: T | undefined): T duplicated locally in network.ts (same generic-cast-helper shape as security/envelope.ts's Plan 01-05 precedent) to narrow regex capture groups and email-local-part destructuring under noUncheckedIndexedAccess without a dead branch or a banned cast/non-null-assertion"
    - "buildActivityEvent's assertNoSensitiveMetadata walks metadata recursively: SecretValue-instance check first (regardless of key name), then array elements, then plain-object entries checked against a lowercased forbidden-key Set (password/secret/token/credential/privatekey/sshpassword/masterkey) before recursing into each value — catches a secret nested at any depth or wrapped in an array"
    - "COMMON_PASSWORDS kept in its own data-only file (common-passwords.ts) so its 270-entry literal doesn't distort branch-coverage measurement of password.ts's policy logic; validatePassword lowercases input once and compares against the frozen Set for a case-insensitive check"

key-files:
  created:
    - packages/domain/src/validators/network.test.ts
    - packages/domain/src/validators/identity.test.ts
    - packages/domain/src/validators/password.test.ts
    - packages/domain/src/validators/common-passwords.ts
    - packages/domain/src/activity/activity-event.test.ts
  modified:
    - packages/domain/src/validators/network.ts
    - packages/domain/src/validators/identity.ts
    - packages/domain/src/validators/password.ts
    - packages/domain/src/activity/activity-event.ts

key-decisions:
  - "validateServerName rejects uppercase outright rather than lowercasing it — the slug pattern [a-z0-9]([a-z0-9-]{0,61}[a-z0-9])? only ever matches already-lowercase input, so 'the success result carries the lowercased name' holds trivially and a case-only variant is rejected rather than silently folded"
  - "validateSshUser and validateEmail each use a single anchored regex covering every listed rejection reason (whitespace, /, :, shell metacharacters for the user; no-@/no-domain-dot/whitespace/length for the email) rather than one check per reason — the plan's acceptance criteria require rejection and a stable code, not a distinct code per violation type, and a single regex keeps both files' branch count minimal and fully exercised"
  - "buildActivityEvent's action-union check is enforced at runtime (not just via the AuthAction static type) via InvalidActivityActionError, since callers loading persisted rows or crossing an untyped boundary can bypass the compile-time union the same way validateSshPort's runtime integer check protects against a numeric string arriving from JSON"
  - "ActivityEvent's occurredAt is always the caller-supplied `now: Date` parameter, never a platform wall-clock read, matching Plan 01-04's applyConnectionResult precedent for keeping packages/domain pure and deterministic in tests"

patterns-established:
  - "Pattern: raw-string safety checks (shell metacharacters, scheme, whitespace) run before any structural parsing (IP-literal branching, label splitting) in any future packages/domain validator that accepts untrusted string input destined for a remote command template"

requirements-completed: [SERV-05, AUTH-02, AUTH-04, QA-02]

# Metrics
duration: 40min
completed: 2026-09-10
---

# Phase 1 Plan 6: Domain Validators, Password Policy, and ActivityEvent Summary

**Pure host/port/slug/SSH-user/email validators with explicit boundary cases, a 12-128 character admin password policy backed by a 270-entry common-password denylist, and an ActivityEvent shape whose `buildActivityEvent` constructor structurally refuses any metadata carrying a password, token, or `SecretValue` instance.**

## Performance

- **Duration:** ~40 min
- **Started:** 2026-09-10T16:38:00-06:00
- **Completed:** 2026-09-10T17:21:00-06:00
- **Tasks:** 2 (both TDD)
- **Files modified:** 5 created (4 test files + common-passwords.ts data file), 4 modified (implementation files, from `export {};` stubs)

## Accomplishments
- `network.ts`: shared `ValidationResult<T>`/`ok()`/`fail()`/`assertDefined()` exported for reuse by `identity.ts` and `password.ts`; `validateHost()` branches explicitly on shell-metacharacter/empty/whitespace/scheme rejection (checked first, per the threat model), then IPv6 literal, then IPv4 literal with per-octet range validation, then a residual-colon host:port rejection, then RFC 1123 per-label hostname validation with total-length and per-label checks — normalises hostnames (lowercase, trailing dot stripped) while returning IP literals unchanged; `validateSshPort()` rejects non-integers (including `NaN` and numeric strings) and out-of-range values (0, negative, >65535) with distinct codes.
- `identity.ts`: `validateServerName()` (lowercase slug, rejects uppercase/leading-trailing-hyphen/64-char/empty), `validateSshUser()` (32-char cap, no leading digit, rejects whitespace/`/`/`:`/shell metacharacters via one anchored character class), `validateEmail()` (254-char cap, `@`+domain-dot shape, lowercases on success).
- `password.ts` + `common-passwords.ts`: `PASSWORD_MIN_LENGTH` (12) / `PASSWORD_MAX_LENGTH` (128); `validatePassword()` checks length-lower, length-upper, identifier-equality (email or its local part, case-insensitive), then common-password membership, in that order; no composition rule; failure messages never echo the submitted password. `common-passwords.ts` ships a frozen `Set` of 270 unique lowercase entries (including `password1234`) with a provenance comment, kept in its own file to keep the policy logic's branch coverage measurement clean.
- `activity-event.ts`: `AUTH_ACTIONS` (exactly 8 entries), `ActivityEvent`/`BuildActivityEventInput` types (`actorType`, `actorId`, `entityType`, `entityId`, `action`, `outcome`, optional `errorCode`, `metadata`, `occurredAt`), `buildActivityEvent(input, now)` — runtime-rejects an action outside `AUTH_ACTIONS` via `InvalidActivityActionError`, and recursively rejects a `metadata` object containing a forbidden key (`password`/`secret`/`token`/`credential`/`privateKey`/`sshPassword`/`masterKey`, case-insensitive, at any depth through nested objects/arrays) or any `SecretValue` instance via `SensitiveMetadataError`. Never reads a platform wall-clock API — `occurredAt` always comes from the caller-supplied `now: Date`.
- Full command chain green after both tasks: `pnpm lint`, `pnpm typecheck`, `pnpm test` (284/284, up from 195), `pnpm exec turbo boundaries` (65 files, no issues), `pnpm exec vitest run --coverage` shows `packages/domain/**` fully covered (100% — new files no longer appear in the coverage table), satisfying the 95%/95% QA-02 gate. `pnpm exec vitest run packages/domain --coverage` (the plan's own scoped `<verification>` command) exits 0 with no threshold errors, matching the same scoped-run coverage-reporting caveat already documented in Plan 01-05's Summary.

## Task Commits

Each task was committed atomically (TDD tasks have separate RED/GREEN commits):

1. **Task 1 (RED): failing network.test.ts / identity.test.ts** - `11fc717` (test)
   **Task 1 (GREEN): implement network.ts / identity.ts** - `8b2a638` (feat)
2. **Task 2 (RED): failing password.test.ts / activity-event.test.ts** - `b46bf37` (test)
   **Task 2 (GREEN): implement password.ts / common-passwords.ts / activity-event.ts** - `a673e28` (feat)

**Plan metadata:** _(final metadata commit follows this summary)_

## Files Created/Modified
- `packages/domain/src/validators/network.ts` - `ValidationResult`, `ok`, `fail`, `assertDefined`, `validateHost`, `validateSshPort`
- `packages/domain/src/validators/network.test.ts` - Port boundary tests (0/1/22/65535/65536/22.5/NaN/'22'), host accept/reject tests (IPv4, IPv6, hostname, metacharacters, scheme, port suffix, whitespace, octet range, label/length rules, normalisation)
- `packages/domain/src/validators/identity.ts` - `validateServerName`, `validateSshUser`, `validateEmail`
- `packages/domain/src/validators/identity.test.ts` - Slug/user/email accept-reject boundary tests
- `packages/domain/src/validators/password.ts` - `PASSWORD_MIN_LENGTH`, `PASSWORD_MAX_LENGTH`, `PasswordValidationContext`, `validatePassword`
- `packages/domain/src/validators/password.test.ts` - Length/composition/identifier/common-password/message-leak tests
- `packages/domain/src/validators/common-passwords.ts` - `COMMON_PASSWORDS` frozen `Set` (270 lowercase entries)
- `packages/domain/src/activity/activity-event.ts` - `AUTH_ACTIONS`, `AuthAction`, `ActivityEvent`, `BuildActivityEventInput`, `InvalidActivityActionError`, `SensitiveMetadataError`, `buildActivityEvent`
- `packages/domain/src/activity/activity-event.test.ts` - Action-union, metadata-guard (top-level/nested-object/nested-array/case-insensitive/`SecretValue`) and safe-array-passthrough tests

## Decisions Made
See `key-decisions` in the frontmatter for the four decisions with the most downstream impact (uppercase server-name rejection instead of folding, single-regex identity validators, runtime action-union enforcement, and `occurredAt` always being caller-supplied).

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] Two branch-coverage gaps found after Task 2's first GREEN run**
- **Found during:** Task 2, `pnpm exec vitest run --coverage` after GREEN
- **Issue:** `password.ts` line 46's `||` short-circuit (`lowerPassword === lowerEmail || lowerPassword === localPart`) had no test exercising the "email context given, neither operand true" path; `activity-event.ts`'s `assertNoSensitiveMetadata`'s array branch had no test where the loop completes without throwing (every existing array test contained a forbidden key), leaving the `return;` after the loop uncovered. Both dropped `packages/domain/**` just below the aggregate needed to keep every file in the coverage table at 100%.
- **Fix:** Added one test per gap — `validatePassword('a-safe-passphrase', { email: 'admin@example.com' })` succeeds, and `buildActivityEvent` with `metadata: { tags: ['first-login', 'trusted-device'] }` succeeds without throwing.
- **Files modified:** packages/domain/src/validators/password.test.ts, packages/domain/src/activity/activity-event.test.ts
- **Verification:** `pnpm exec vitest run --coverage` — `packages/domain/**` no longer appears in the coverage table (fully covered).
- **Committed in:** `a673e28`

**2. [Rule 1 - Bug] Own file comment self-flagged the plan's `grep -c "Date.now()"` acceptance check**
- **Found during:** Task 2, running the plan's own acceptance-criteria grep after GREEN
- **Issue:** `buildActivityEvent`'s doc comment explaining "this module never reads `Date.now()`" contained the literal substring `Date.now()`, so `grep -c "Date.now()" packages/domain/src/activity/activity-event.ts` returned 1, not the required 0 — the same class of false positive as Plan 01-02's Summary "workspace" string issue.
- **Fix:** Reworded the comment to "never reads the platform's wall-clock API directly" without changing its meaning.
- **Files modified:** packages/domain/src/activity/activity-event.ts
- **Verification:** `grep -c "Date.now()" packages/domain/src/activity/activity-event.ts` returns 0; tests still pass.
- **Committed in:** `a673e28`

**3. [Deferred, not auto-fixed] `common-passwords.ts` created alongside the RED test commit, not the GREEN commit**
- **Found during:** Task 2, writing `password.test.ts`
- **Issue:** `password.test.ts` imports `COMMON_PASSWORDS` directly to assert its size and lowercase invariant; had the file not existed at RED time, the whole test file would fail on module resolution instead of on meaningful assertions, and two of its own tests (size ≥200, all-lowercase) would need the real data anyway to be verified as failing for the right reason. `common-passwords.ts` is a pure data literal with no branching logic to TDD against.
- **Resolution:** Created `common-passwords.ts` in the RED commit (`b46bf37`) alongside the test files, documented as fixture data (analogous to a test builder), with `validatePassword`'s actual membership-check logic still written and verified RED→GREEN in the normal cycle. No behavior was implemented ahead of its test.
- **Files modified:** packages/domain/src/validators/common-passwords.ts (in the RED commit instead of the GREEN commit)
- **Verification:** N/A — data-only file, no logic to verify beyond the size/lowercase tests already passing.

---

**Total deviations:** 3 (2 bug/coverage fixes required for the plan's own gates to pass, 1 sequencing note with no behavioral impact). No scope creep beyond Task 1's and Task 2's declared `<files>`.

## Issues Encountered

- Same scoped-coverage-command caveat already documented in Plan 01-05's Summary: `pnpm exec vitest run packages/domain --coverage` (the plan's literal `<verification>` command) reports a low aggregate (63.49%/60.19%) because `vitest.config.ts`'s coverage is `all: true` and glob-scoped to `packages/*/src/**/*.ts` + `apps/*/src/**/*.ts` — running only `packages/domain`'s tests leaves every `apps/control-plane/**` file uninstrumented (0%) for that run, dragging the combined total down even though `packages/domain/**` itself is at 100%. The command still exits 0 with no threshold error (the QA-02 threshold is scoped to `packages/domain/**` only), which is the authoritative signal; `pnpm exec vitest run --coverage` (whole repo, matching CI) is the correct gate and was verified green after every commit.

## User Setup Required

None - no external service configuration required.

## Next Phase Readiness
- `packages/domain/src/validators/{network,identity,password}.ts` and `packages/domain/src/activity/activity-event.ts` are fully implemented and exported through their existing barrels (`validators/index.ts`, `activity/index.ts`, untouched per Plan 01-02's "barrels are fixed" convention) — phase 3's application services and phase 4's Zod route schemas should call `validateHost`/`validateSshPort`/`validateServerName`/`validateSshUser`/`validateEmail`/`validatePassword` directly rather than re-implementing any of these checks in a route handler.
- `buildActivityEvent` is the exact primitive AUTH-04's failed-login logging needs; phase 3's activity-log writer service (the only layer per ARCHITECTURE.md §6 allowed to persist `activity_events` rows) should call it with the SSH/HTTP-layer's own clock as `now` and let `SensitiveMetadataError` propagate as a hard failure rather than being caught and logged with the raw metadata.
- `COMMON_PASSWORDS`'s 270-entry list is intentionally a static, offline dataset (no network fetch) — if a future plan wants a larger authoritative list (e.g. the full SecLists top-1000), it can replace this file's contents without touching `validatePassword`'s logic, since the membership check is a plain `Set.has()`.
- `AUTH_ACTIONS`'s 8-entry union is exhaustive for phase 1 only; phase 3 will need to widen the `ActivityEvent` action type (or introduce a second discriminated union) to cover `server.*`/`project.*` events without breaking this phase's auth-only callers — the file's header comment flags this boundary explicitly.
- Full command chain (`pnpm lint && pnpm typecheck && pnpm test && pnpm exec turbo boundaries`) verified green after every commit in this plan; `packages/domain/**` remains at 100%/100% statement/branch coverage, well above the 95%/95% QA-02 gate.

---
*Phase: 01-dominio-persistencia-y-autenticacion*
*Completed: 2026-09-10*

## Self-Check: PASSED

- FOUND: packages/domain/src/validators/network.ts
- FOUND: packages/domain/src/validators/network.test.ts
- FOUND: packages/domain/src/validators/identity.ts
- FOUND: packages/domain/src/validators/identity.test.ts
- FOUND: packages/domain/src/validators/password.ts
- FOUND: packages/domain/src/validators/password.test.ts
- FOUND: packages/domain/src/validators/common-passwords.ts
- FOUND: packages/domain/src/activity/activity-event.ts
- FOUND: packages/domain/src/activity/activity-event.test.ts
- FOUND commit: `11fc717` (Task 1 RED)
- FOUND commit: `8b2a638` (Task 1 GREEN)
- FOUND commit: `b46bf37` (Task 2 RED)
- FOUND commit: `a673e28` (Task 2 GREEN)

Re-verified independently: `pnpm lint`, `pnpm typecheck`, `pnpm test` (284/284), `pnpm exec turbo boundaries` (65 files, no issues) all exit 0; `pnpm exec vitest run --coverage` shows `packages/domain/**` fully covered (no threshold errors); `grep -c "throw " packages/domain/src/validators/network.ts` returns 0; `grep -c "Date.now()" packages/domain/src/activity/activity-event.ts` returns 0.
