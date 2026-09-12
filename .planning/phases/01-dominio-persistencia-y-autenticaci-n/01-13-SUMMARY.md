---
phase: 01-dominio-persistencia-y-autenticacion
plan: 13
subsystem: auth
tags: [rate-limiting, brute-force, better-auth, drizzle, postgres, fastify, progressive-backoff]

# Dependency graph
requires:
  - phase: 01-dominio-persistencia-y-autenticacion
    provides: "apps/control-plane's auth/login-guard.ts stub, hooks.ts's composedBefore/composedAfter composition point (Plan 01-10)"
  - phase: 01-dominio-persistencia-y-autenticacion
    provides: "bootstrap-context.ts and the /api/setup-based createAdmin test helpers used across every auth integration suite (Plan 01-12)"
  - phase: 01-dominio-persistencia-y-autenticacion
    provides: "the login_attempts table and its unique (scope, scope_key) index (Plan 01-07)"
  - phase: 01-dominio-persistencia-y-autenticacion
    provides: "writeActivityEvent as the single activity-log writer, and the auth.login_failed/login_blocked/login_succeeded actions already reserved in AUTH_ACTIONS (Plan 01-09)"
  - phase: 01-dominio-persistencia-y-autenticacion
    provides: "packages/domain/src/security/login-backoff.ts stub already re-exported from the security barrel (Plans 01-02/01-06)"
provides:
  - "packages/domain/src/security/login-backoff.ts: lockoutDurationSeconds/evaluateFailure/clearOnSuccess/isLockedOut — pure D-07 backoff arithmetic (900/1800/3600/7200..., capped at 86400, never permanent)"
  - "apps/control-plane/src/services/login-attempt-repository.ts: loadAttempt/recordFailure/clearAttempts — independent per-IP and per-account counter persistence"
  - "apps/control-plane/src/auth/login-guard.ts: the live loginGuard/loginGuardAfter enforcing and recording the lockout around Better Auth's sign-in handler"
  - "NOODARA_TRUST_PROXY (env.ts) + Fastify trustProxy wiring (app.ts) + the x-noodara-client-ip bridge (routes/auth.ts): the real client IP resolution the login guard depends on"
  - "login_attempts.lockout_count column (migration 0001) persisting the doubling schedule across lockouts"
affects: ["01-14"]

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "Before-hook rejection via throw new APIError(status, body, headers), not a returned object: better-call's dispatch pipeline only reads .headers/.response off a before-hook's return value when returnHeaders is set — it never reads a status code off it. A thrown APIError is the same idiom better-auth's own originCheckMiddleware uses, and is required to get a genuine 429 with a Retry-After header out of a before-hook."
    - "A thrown APIError from hooks.before short-circuits hooks.after entirely (confirmed by reading better-auth's dispatch.mjs) — so a blocked (429) request's auth.login_blocked event is written inside loginGuard itself, never in loginGuardAfter, which is simply never invoked for a blocked request."
    - "The reconstructed Fetch API Request better-call's Node adapter hands to a Better Auth hook has headers only, never the raw socket — a hook cannot resolve the real client IP by itself. The fix is a narrow bridge: Fastify's own request.ip (already trustProxy-aware) is written onto request.raw.headers['x-noodara-client-ip'] in routes/auth.ts immediately before the toNodeHandler call, overwriting any client-supplied value under the same name."
    - "activity_events.entity_id is a uuid column — a submitted email with no matching user is not a valid entityId. resolveUserEntityId falls back to a nil UUID sentinel ('00000000-...-000000000000') for login_failed/login_blocked events against an unknown account, since a real UUIDv7 row id never collides with it."
    - "A from-snapshot migration test (PITFALLS.md #10) that seeds/reads a table through the current Drizzle schema module breaks the moment that module gains a column the previous snapshot doesn't have yet — the fixture and the snapshot-comparison helper must fall back to raw SQL restricted to the older column set for that one table."

key-files:
  created:
    - packages/domain/src/security/login-backoff.ts
    - packages/domain/src/security/login-backoff.test.ts
    - apps/control-plane/src/services/login-attempt-repository.ts
    - apps/control-plane/src/db/migrations/0001_silky_lethal_legion.sql
    - tests/integration/auth/rate-limit.test.ts
  modified:
    - apps/control-plane/src/auth/login-guard.ts (stub replaced with the live guard)
    - apps/control-plane/src/env.ts / env.test.ts (NOODARA_TRUST_PROXY)
    - apps/control-plane/src/app.ts (Fastify trustProxy option)
    - apps/control-plane/src/routes/auth.ts (x-noodara-client-ip bridge)
    - apps/control-plane/src/db/schema/login-attempts.ts (lockout_count column)
    - apps/control-plane/src/db/migrations/meta/_journal.json / 0001_snapshot.json
    - tests/integration/db/migrations.test.ts, tests/integration/fixtures/representative-data.ts (raw-SQL fix for the new column, see Deviations)
    - .env.example, package.json, pnpm-lock.yaml (uuidv7 root devDependency)

key-decisions:
  - "Reject with throw new APIError('TOO_MANY_REQUESTS', body, headers) from loginGuard rather than returning ctx.json(...): the latter cannot carry a non-200 status out of a before-hook through better-call's dispatch pipeline (traced directly in its installed source, not assumed from docs)."
  - "The IP scope key is bridged through a dedicated x-noodara-client-ip request header set server-side in routes/auth.ts from Fastify's own request.ip, rather than re-implementing X-Forwarded-For parsing inside login-guard.ts — this keeps proxy-trust logic in exactly one place (Fastify's trustProxy option, fed by NOODARA_TRUST_PROXY) and the header can never be spoofed since it is set after Fastify's own resolution, overwriting any client-supplied value under the same name."
  - "clearAttempts deletes the login_attempts rows on a successful login rather than loading each one to apply clearOnSuccess and writing the zeroed state back — loadAttempt's own 'no row = fresh counter' contract makes an absent row behaviorally identical to a cleared one, at the cost of clearOnSuccess itself being unused outside its own unit tests."

requirements-completed: [AUTH-04]

# Metrics
duration: 60min
completed: 2026-09-11
---

# Phase 1 Plan 13: Per-IP and Per-Account Progressive Login Lockout Summary

**Postgres-backed brute-force containment — independent per-IP and per-account counters with a 15/30/60-minute-doubling, 24-hour-capped, never-permanent lockout — replacing Better Auth's IP+path-only `rateLimit` as AUTH-04's actual mechanism, proven by the exact two scenarios RESEARCH names as the giveaway for a wrong (IP-only) implementation.**

## Performance

- **Duration:** ~60 min
- **Started:** 2026-09-11T18:05:00-06:00 (approx.)
- **Completed:** 2026-09-11T19:05:00-06:00
- **Tasks:** 2 (both TDD)
- **Files modified:** 5 created, 10 modified

## Accomplishments
- `packages/domain/src/security/login-backoff.ts`: `lockoutDurationSeconds`/`evaluateFailure`/`clearOnSuccess`/`isLockedOut` — pure, deterministic D-07 arithmetic. 21 unit tests including the exact 900/1800/3600/7200 doubling sequence, a 1..1000 sweep proving every lockout count stays finite and ≤86400s (a bounded-exponent clamp before `Math.pow`, not a post-hoc cap, prevents overflow), the exact-`lockedUntil` boundary, and window-restart-after-elapse. 100% statement/branch coverage on the file.
- `apps/control-plane/src/services/login-attempt-repository.ts`: `loadAttempt`/`recordFailure`/`clearAttempts`, upserting on the existing unique `(scope, scope_key)` index so concurrent failures against the same key can never duplicate rows.
- `apps/control-plane/src/auth/login-guard.ts`: `loginGuard` (before-hook) checks both scopes' `isLockedOut` and throws a `TOO_MANY_REQUESTS` `APIError` carrying `Retry-After` before Better Auth's handler ever runs — verified this actually blocks credential verification by asserting the *correct* password also returns 429 during a lockout. `loginGuardAfter` applies `evaluateFailure` to both scopes on a genuine auth failure and clears both via `clearAttempts` on success, writing `auth.login_failed`/`auth.login_blocked`/`auth.login_succeeded` through `writeActivityEvent` in every case.
- `NOODARA_TRUST_PROXY` (default `false`) gates whether `X-Forwarded-For` is ever consulted at all — wired into Fastify's own `trustProxy` option in `app.ts`, with `routes/auth.ts` bridging the already-resolved `request.ip` into Better Auth's hook context via a request header, since the reconstructed Fetch API `Request` a Better Auth hook receives has no socket-level IP of its own.
- `tests/integration/auth/rate-limit.test.ts` (10 tests): the per-account-via-5-distinct-IPs and per-IP-via-5-distinct-emails scenarios RESEARCH names explicitly; the doubling `Retry-After` (900s then 1800s, forced without waiting 15 real minutes by advancing `locked_until` into the past — D-07's own escape hatch); zero leftover rows after a successful login; `auth.login_failed` metadata containing the email/IP but never the password; and both `NOODARA_TRUST_PROXY` states (ignored by default, leftmost address honoured when enabled).
- Full command chain green: `pnpm lint`, `pnpm typecheck`, `pnpm build`, `pnpm test` (349/349, up from 325), `pnpm test:integration` (86/86, up from 75), `pnpm exec turbo boundaries`; zero `noodara.test=true` containers left running; `auth.ts` and `hooks.ts` untouched (verified via `git diff --name-only`).

## Task Commits

Each task was committed atomically (both TDD tasks have separate RED/GREEN commits):

1. **Task 1 (RED): failing login-backoff.test.ts** - `622e15d` (test)
   **Task 1 (GREEN): login-backoff.ts's pure backoff arithmetic** - `3796334` (feat)
2. **Task 2 (RED): failing rate-limit.test.ts against the inert Plan 01-10 stub** - `a233abc` (test)
   **Task 2 (GREEN): login-attempt-repository.ts, the live login-guard.ts, NOODARA_TRUST_PROXY, the migration adding lockout_count, and the from-snapshot migration-test fix it required** - `25a54f6` (feat)

**Plan metadata:** _(final metadata commit follows this summary)_

## Files Created/Modified
- `packages/domain/src/security/login-backoff.ts` / `.test.ts` - Pure D-07 backoff arithmetic
- `apps/control-plane/src/services/login-attempt-repository.ts` - Independent per-scope counter persistence
- `apps/control-plane/src/auth/login-guard.ts` - The live `loginGuard`/`loginGuardAfter`
- `apps/control-plane/src/env.ts` / `env.test.ts` - `NOODARA_TRUST_PROXY`
- `apps/control-plane/src/app.ts` - Fastify `trustProxy` wiring
- `apps/control-plane/src/routes/auth.ts` - `x-noodara-client-ip` header bridge
- `apps/control-plane/src/db/schema/login-attempts.ts` - `lockout_count` column
- `apps/control-plane/src/db/migrations/0001_silky_lethal_legion.sql` + `meta/` - The generated, hand-hardened migration
- `tests/integration/auth/rate-limit.test.ts` - AUTH-04/D-07 proof
- `tests/integration/db/migrations.test.ts`, `tests/integration/fixtures/representative-data.ts` - Fixed for the new column (see Deviations)
- `.env.example`, `package.json`, `pnpm-lock.yaml` - `NOODARA_TRUST_PROXY` documentation, `uuidv7` root devDependency

## Decisions Made
See `key-decisions` in the frontmatter for the three decisions with the most downstream impact (throwing `APIError` rather than returning a JSON body from the before-hook, the `x-noodara-client-ip` header bridge keeping proxy-trust logic in exactly one place, and deleting rather than zeroing rows on success).

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 2 - Missing critical functionality] `login_attempts` had no column to persist the doubling schedule's lockout count**
- **Found during:** Task 2 design, before writing the repository
- **Issue:** D-07's doubling schedule (15→30→60 min...) requires knowing how many times a scope has already been locked out, but Plan 01-07's `login_attempts` table has no such column — only `failure_count`, `window_started_at`, `locked_until`, `last_failure_at`. Deriving it from existing columns (e.g. the span between `locked_until` and `last_failure_at`) does not work: `last_failure_at` is overwritten by every subsequent failure in the *next* counting window, not just the one that triggered the lock, so the "previous lockout's duration" is unrecoverable once a new window starts accumulating.
- **Fix:** Added `lockout_count integer not null default 0` to `login-attempts.ts` and generated a new versioned migration (`0001_silky_lethal_legion.sql`, hand-hardened with `IF NOT EXISTS` per Plan 01-07's own defensive-migration convention) rather than deriving it. A new column is Rule 1/2 territory per the deviation rules' own edge-case guidance ("Need new column → Rule 1 or 2"), not Rule 4's "new table" architectural-change bar.
- **Files modified:** apps/control-plane/src/db/schema/login-attempts.ts, apps/control-plane/src/db/migrations/0001_silky_lethal_legion.sql, meta/_journal.json, meta/0001_snapshot.json
- **Verification:** `pnpm test:integration` (migration + rate-limit suites) green; a dedicated assertion in `migrations.test.ts` confirms a pre-existing row backfills `lockout_count` to `0`, not `NULL`, after the upgrade.
- **Committed in:** `25a54f6`

**2. [Rule 3 - Blocking] `activity_events.entity_id` is a `uuid` column; a submitted email is not one**
- **Found during:** Task 2, first real HTTP request through the rate-limit test
- **Issue:** `writeActivityEvent`'s `entityId` was initially set to the account-scope key (the lowercased email) for `auth.login_failed`/`auth.login_blocked`. `activity_events.entity_id` is a Postgres `uuid` column (Plan 01-07); inserting a non-UUID string throws `invalid input syntax for type uuid`, surfacing as a 500 on every wrong-email attempt.
- **Fix:** Added `resolveUserEntityId(db, email)`, a best-effort lookup against `users` by `lower(email)`; falls back to a fixed nil-UUID sentinel (`00000000-0000-0000-0000-000000000000`, never a real UUIDv7 row id) when the email matches no user at all — exactly the case an attacker guessing wrong emails produces.
- **Files modified:** apps/control-plane/src/auth/login-guard.ts
- **Verification:** All 10 `rate-limit.test.ts` tests pass, including the per-IP scenario that fails against five nonexistent emails.
- **Committed in:** `25a54f6`

**3. [Rule 3 - Blocking] The reconstructed Fetch `Request` a Better Auth hook receives has no socket-level IP**
- **Found during:** Task 2 design, before writing `login-guard.ts`
- **Issue:** `better-call`'s Node adapter (`getRequest()`) builds a Web-standard `Request` from `request.raw`'s headers only — it never carries the raw Node socket, so `ctx.request` inside a Better Auth hook has no way to know the real client IP, only whatever headers were sent (which includes an attacker-controlled `X-Forwarded-For`).
- **Fix:** `routes/auth.ts` (not in this task's declared `<files>` list, but the only place with access to Fastify's own `request.ip`) sets `request.raw.headers['x-noodara-client-ip'] = request.ip` immediately before calling `toNodeHandler`, overwriting any client-supplied value under the same header name. `app.ts` wires `trustProxy: env.NOODARA_TRUST_PROXY` into the Fastify constructor (the plan's own suggested "single option" change) so `request.ip` already reflects the trust policy before `login-guard.ts` ever sees it.
- **Files modified:** apps/control-plane/src/routes/auth.ts, apps/control-plane/src/app.ts
- **Verification:** The `NOODARA_TRUST_PROXY` unset/enabled tests in `rate-limit.test.ts` both pass, including the "leftmost address" assertion with a varying second hop.
- **Committed in:** `25a54f6`

**4. [Rule 1 - Bug] Adding `lockout_count` broke the existing from-snapshot migration test (QA-06, PITFALLS.md #10)**
- **Found during:** `pnpm test:integration` full run after Task 2
- **Issue:** `tests/integration/fixtures/representative-data.ts` seeded `login_attempts` via `db.insert(schema.loginAttempts)` — the *current* Drizzle schema module, which now includes `lockout_count`. The from-snapshot test applies only the *previous* migration before seeding (by design, to prove old-shape data survives an upgrade), so that column does not exist in the database yet at seed time; the ORM insert referenced it anyway and failed with `column "lockout_count" does not exist`. The same issue affected `fetchSeededSnapshot`'s `SELECT`, and the test's own `bookkeepingRowsAfterUpgrade === bookkeepingRowsBeforeUpgrade` assertion (written when only one migration existed and the "upgrade" was always a no-op) no longer held now that a real second migration exists to apply.
- **Fix:** Both the fixture's `login_attempts` insert and the test's own `SELECT` now use raw SQL restricted to the columns present in migration 0000 (with an application-generated UUIDv7 id, since the table has no DB-side id default). The bookkeeping-row assertion was made generic over `journal.length` instead of asserting equality. Added a new assertion that a pre-existing row's `lockout_count` backfills to `0` after the upgrade. Also updated `readJournal()`'s hardcoded expected list to include the new migration tag, and promoted `uuidv7` to a root devDependency (same pnpm workspace-resolution fix Plans 01-08/01-09 already documented for `drizzle-orm`/`@noodara/domain`).
- **Files modified:** tests/integration/fixtures/representative-data.ts, tests/integration/db/migrations.test.ts, package.json, pnpm-lock.yaml
- **Verification:** `pnpm exec vitest run --config vitest.integration.config.ts tests/integration/db/migrations.test.ts` — 6/6 pass; full `pnpm test:integration` — 86/86.
- **Committed in:** `25a54f6`

---

**Total deviations:** 4 (1 missing-critical-functionality fix required for D-07's own correctness, 3 blocking fixes required for the plan's own acceptance criteria and the pre-existing test suite to pass). No scope creep beyond Task 2's declared `<files>` list plus the files strictly required by these four deviations (`routes/auth.ts`, `app.ts`'s single `trustProxy` option as the plan's own text anticipated, the schema/migration files for the new column, and the two pre-existing migration-test files it broke).

## Issues Encountered

None beyond what is captured in Deviations from Plan above. Understanding better-call's before-hook dispatch semantics (why a returned JSON object cannot carry a status code, but a thrown `APIError` can) required reading the installed `better-call`/`better-auth` source directly rather than relying on documentation, per this plan's own `<read_first>` precedent.

## User Setup Required

None — no external service configuration required. `pnpm test:integration` needs a reachable Docker daemon, same as every prior phase-1 integration plan.

## Next Phase Readiness
- Plan 01-14 (`noodara admin reset` CLI, D-01 boot-time token printing) is unaffected by this plan's changes — `login-guard.ts`'s lockout is orthogonal to the setup/recovery token flow, and the CLI recovery path remains the only way to bypass a lockout other than waiting.
- `apps/control-plane/src/auth/login-guard.ts` is not expected to be edited again; any future plan needing to adjust the lockout policy should do so via the `NOODARA_LOGIN_MAX_ATTEMPTS`/`NOODARA_LOGIN_WINDOW_SECONDS`/`NOODARA_LOGIN_BACKOFF_MAX_SECONDS` env knobs (already wired) or `packages/domain/src/security/login-backoff.ts`'s pure functions, never by re-deriving the doubling math elsewhere.
- The `x-noodara-client-ip` header-bridge pattern in `routes/auth.ts` is the template any future Better Auth hook needing the real client IP should follow — a hook itself can never resolve it from `ctx.request` alone.
- Full command chain (`pnpm lint && pnpm typecheck && pnpm build && pnpm test && pnpm test:integration && pnpm exec turbo boundaries`) verified green after every commit in this plan; 0 stray `noodara.test=true` containers.

## Threat Flags

None beyond what the plan's own `<threat_model>` already covers (T-1-39 through T-1-43) — no new network endpoint, auth path, or schema change was introduced outside that register. The `lockout_count` column addition is a data-model completion of an already-registered mitigation (T-1-39), not new surface.

---
*Phase: 01-dominio-persistencia-y-autenticacion*
*Completed: 2026-09-11*

## Self-Check: PASSED

- FOUND: packages/domain/src/security/login-backoff.ts
- FOUND: packages/domain/src/security/login-backoff.test.ts
- FOUND: apps/control-plane/src/services/login-attempt-repository.ts
- FOUND: apps/control-plane/src/auth/login-guard.ts
- FOUND: apps/control-plane/src/db/migrations/0001_silky_lethal_legion.sql
- FOUND: tests/integration/auth/rate-limit.test.ts
- FOUND: tests/integration/db/migrations.test.ts
- FOUND: tests/integration/fixtures/representative-data.ts
- FOUND: apps/control-plane/src/env.ts
- FOUND: apps/control-plane/src/app.ts
- FOUND: apps/control-plane/src/routes/auth.ts
- FOUND: apps/control-plane/src/db/schema/login-attempts.ts
- FOUND commit: `622e15d` (Task 1 RED)
- FOUND commit: `3796334` (Task 1 GREEN)
- FOUND commit: `a233abc` (Task 2 RED)
- FOUND commit: `25a54f6` (Task 2 GREEN)

Re-verified independently: `pnpm lint`, `pnpm typecheck`, `pnpm build`, `pnpm test` (349/349), `pnpm test:integration` (86/86), `pnpm exec turbo boundaries` (146 files, no issues) all exit 0. `pnpm exec vitest run --project packages --coverage` reports no threshold failures (packages/domain stays at/above 95% statements/branches; `login-backoff.ts` itself is 100%/100%). `grep -c "isLockedOut" apps/control-plane/src/auth/login-guard.ts` → 3. `grep -c "Date.now()" packages/domain/src/security/login-backoff.ts` → 0. `git diff --name-only` across every commit in this plan does not include `apps/control-plane/src/auth/auth.ts` or `hooks.ts`. `docker ps --filter label=noodara.test=true --format '{{.ID}}' | wc -l` → 0.
