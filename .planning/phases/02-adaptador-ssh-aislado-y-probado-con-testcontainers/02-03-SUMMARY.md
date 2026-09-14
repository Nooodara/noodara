---
phase: 02-adaptador-ssh-aislado-y-probado-con-testcontainers
plan: 03
subsystem: persistence-and-config
tags: [drizzle, postgres, migrations, env-validation, ssh-timeouts, tofu]

# Dependency graph
requires:
  - phase: 01-dominio-persistencia-y-autenticacion
    provides: "servers table with hostFingerprint/pendingFingerprint columns and the migration 0001 hand-hardened ADD COLUMN precedent (Plan 01-13)"
  - phase: 01-dominio-persistencia-y-autenticacion
    provides: "env.ts's parseTuningInt/EnvIssue/loadEnv fail-fast contract (Plan 01-02/01-13)"
  - phase: 02-adaptador-ssh-aislado-y-probado-con-testcontainers
    provides: "packages/ssh's SshTimeouts shape (connectMs/commandMs/discoveryMs) declared in ssh-port.ts (Plan 02-01)"
provides:
  - "servers.host_fingerprint_captured_at / servers.pending_fingerprint_seen_at (migration 0002) — D-06's two fingerprint dates"
  - "NOODARA_SSH_CONNECT_TIMEOUT_MS / NOODARA_SSH_COMMAND_TIMEOUT_MS / NOODARA_SSH_DISCOVERY_TIMEOUT_MS in env.ts, range-validated with a discovery>=command coherence rule"
  - "parseTuningInt's optional range parameter, reusable by any future tuning knob needing bounds"
  - "the from-snapshot migration test's proof pattern for a table whose current schema module has columns the previous snapshot lacks (servers, mirroring login_attempts/lockout_count from 01-13)"
affects: ["02-05", "02-04", "02-06", "02-07", "02-08", "02-09", "02-10"]

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "parseTuningInt gained an optional inclusive range object instead of a second parser function, keeping all six pre-existing tuning-knob call sites behaviourally unchanged while the three new SSH knobs get real bounds stated once in their own requirement string."
    - "A cross-field coherence rule (validateSshTimeoutCoherence) follows validateAdminPair's established shape: parse every field first, then push an EnvIssue against the more specific variable (NOODARA_SSH_DISCOVERY_TIMEOUT_MS) when the combination is incoherent, rather than failing each field independently."
    - "For a table whose current Drizzle schema module includes columns absent from the migration snapshot under test, both the fixture's insert and the migration test's own select move to raw SQL restricted to the older column set — the same fix 01-13 established for login_attempts/lockout_count, now applied to servers/host_fingerprint_captured_at+pending_fingerprint_seen_at."

key-files:
  created:
    - apps/control-plane/src/db/migrations/0002_phase2_fingerprint_timestamps.sql
    - apps/control-plane/src/db/migrations/meta/0002_snapshot.json
  modified:
    - apps/control-plane/src/db/schema/servers.ts (hostFingerprintCapturedAt / pendingFingerprintSeenAt columns; corrected stale "every column already exists" comment)
    - apps/control-plane/src/db/migrations/meta/_journal.json (tag renamed to 0002_phase2_fingerprint_timestamps)
    - tests/integration/db/migrations.test.ts (three-tag readJournal expectation, servers raw-SQL snapshot, NULL-backfill + timestamptz round-trip assertions)
    - tests/integration/fixtures/representative-data.ts (servers row seeded via raw SQL restricted to the 0001 column set, with a realistic ssh-ed25519 SHA256 host_fingerprint)
    - apps/control-plane/src/env.ts (parseTuningInt range support, three SSH timeout knobs, validateSshTimeoutCoherence)
    - apps/control-plane/src/env.test.ts (16 new cases: defaults, overrides, boundaries, out-of-range, non-integer, coherence, no received-value leak)
    - .env.example (NOODARA_SSH_*_TIMEOUT_MS documented as optional with defaults/ranges)

key-decisions:
  - "parseTuningInt takes an optional {min,max} range object rather than a parallel parseTuningIntInRange helper — the plan allowed either shape; extending the existing function keeps exactly one integer parser in the module and every pre-existing call site's behaviour was re-verified unchanged by running the full env.test.ts suite, not by inspection."
  - "The discovery>=command coherence check is asserted after both values are already parsed (falling back to their defaults on individual failure first), so a config that is simultaneously out-of-range AND incoherent reports the range issue, and an otherwise-valid-but-incoherent config reports exactly the coherence issue against NOODARA_SSH_DISCOVERY_TIMEOUT_MS."

requirements-completed: [SEC-03, SEC-04]

# Metrics
duration: 55min
completed: 2026-09-13
---

# Phase 2 Plan 3: Fingerprint Capture Timestamps and SSH Timeout Env Knobs Summary

**Migration 0002 adds D-06's two nullable timestamptz fingerprint-capture columns to `servers`, proven upgrade-safe against a populated database via an extended from-snapshot test, plus three range-validated `NOODARA_SSH_*_TIMEOUT_MS` env knobs with a discovery>=command coherence rule — the only persistence change phase 2 is allowed to make, landed in wave 1 so no later adapter plan is blocked on it.**

## Performance

- **Duration:** ~55 min
- **Started:** 2026-09-13T22:30:00-06:00 (approx.)
- **Completed:** 2026-09-13T23:25:00-06:00
- **Tasks:** 3 (all `tdd="true"`; `tdd_mode` is `false` at the project-config level, so Task 1 and Task 2 ran as single verified commits against already-generic pre-existing tests, while Task 3 — the one task introducing genuinely new parsing/validation logic — followed an explicit RED/GREEN split)
- **Files modified:** 2 created, 7 modified

## Accomplishments

- `servers` gains `host_fingerprint_captured_at` and `pending_fingerprint_seen_at`, both nullable `timestamp with time zone`, matching `lastSeenAt`'s existing column style. Migration `0002_phase2_fingerprint_timestamps.sql` was generated with `drizzle-kit generate` (never `push`), renamed from its random-name default, hand-hardened with `ADD COLUMN IF NOT EXISTS` for both statements exactly as `0001` does, and its journal tag updated to match. `meta/0002_snapshot.json` was left exactly as generated.
- The from-snapshot migration test (`tests/integration/db/migrations.test.ts`) now has a genuinely non-trivial N-1→N step to prove: `readJournal()` expects the three-tag list; `representative-data.ts` seeds a `servers` row via raw SQL restricted to the 0001 column set with a realistic `ssh-ed25519 SHA256:...` `host_fingerprint` (D-05's storage shape); the test asserts both new columns backfill to `NULL` (not a spurious default) on the pre-existing row, and round-trips a real `Date` through `pending_fingerprint_seen_at` to prove `withTimezone: true` landed as `timestamptz`. Verified this actually guards the intended failure mode by temporarily adding `DEFAULT now()` to one `ADD COLUMN` statement — the NULL-backfill assertion failed as expected — then reverted.
- `env.ts`'s `parseTuningInt` gained an optional inclusive `{min, max}` range; all six pre-existing tuning-knob call sites keep their exact prior behaviour (re-verified by running the full `env.test.ts` suite, not by inspection). Three new fields — `NOODARA_SSH_CONNECT_TIMEOUT_MS` (1000-120000, default 10000), `NOODARA_SSH_COMMAND_TIMEOUT_MS` (1000-300000, default 30000), `NOODARA_SSH_DISCOVERY_TIMEOUT_MS` (5000-600000, default 60000) — are validated with their range stated in the rejection's own requirement string. `validateSshTimeoutCoherence` (mirroring `validateAdminPair`'s cross-field shape) rejects a discovery timeout smaller than the command timeout against `NOODARA_SSH_DISCOVERY_TIMEOUT_MS`. No `EnvIssue` for these variables ever carries the received value. `packages/ssh` was not touched — D-09's "adapter receives values by parameter, never reads `process.env`" holds, confirmed by `packages/ssh/src/boundary.test.ts` still passing unchanged.
- `.env.example` documents all three knobs as optional with their defaults and ranges, values left empty, in the same phrasing `NOODARA_TRUST_PROXY` uses.
- Full command chain green: `pnpm lint`, `pnpm typecheck`, `pnpm build` (produces `apps/control-plane/dist/db/migrations/0002_phase2_fingerprint_timestamps.sql`), `pnpm test` (402/402, up from 386), `pnpm test:integration` (131/131, up from 129), `pnpm exec turbo boundaries` (211 files, no issues); zero `noodara.test=true` containers left running after any run.

## Task Commits

1. **Task 1: Fingerprint capture timestamps — schema and defensive migration 0002** - `49fcc71` (feat)
2. **Task 2: From-snapshot proof that migration 0002 is a safe in-place upgrade** - `43bf274` (test)
3. **Task 3 (RED): failing tests for the three SSH timeout knobs** - `f7ab6a7` (test)
   **Task 3 (GREEN): range-validated knobs, coherence rule, `.env.example`** - `5a5d1fc` (feat)

**Plan metadata:** _(final metadata commit follows this summary)_

## Files Created/Modified

- `apps/control-plane/src/db/migrations/0002_phase2_fingerprint_timestamps.sql` / `meta/0002_snapshot.json` - The generated, hand-hardened migration
- `apps/control-plane/src/db/schema/servers.ts` - `hostFingerprintCapturedAt` / `pendingFingerprintSeenAt`, corrected stale comment
- `apps/control-plane/src/db/migrations/meta/_journal.json` - Tag renamed to `0002_phase2_fingerprint_timestamps`
- `tests/integration/db/migrations.test.ts` - Three-tag journal expectation, servers raw-SQL snapshot, NULL-backfill + timestamptz round-trip proof
- `tests/integration/fixtures/representative-data.ts` - `servers` row seeded via raw SQL restricted to the 0001 column set with a realistic pinned fingerprint
- `apps/control-plane/src/env.ts` - `parseTuningInt` range support, the three SSH timeout knobs, `validateSshTimeoutCoherence`
- `apps/control-plane/src/env.test.ts` - 16 new cases for the three knobs
- `.env.example` - The three knobs documented as optional

## Decisions Made

See `key-decisions` in the frontmatter: extending `parseTuningInt` with an optional range object (not a second parser) to keep exactly one integer parser in the module, and asserting the discovery/command coherence rule after individual parsing so an out-of-range config reports the range issue and an otherwise-valid-but-incoherent one reports exactly the coherence issue.

## Deviations from Plan

None beyond the plan's own explicitly anticipated hand-edit steps (migration rename, `IF NOT EXISTS` insertion, journal tag update). No scope creep: only the files declared in the plan's `<files>` lists were touched.

### Auto-fixed Issues

**1. [Rule 1 - Bug] `pendingFingerprintSeenAt`/`hostFingerprintCapturedAt` grep acceptance criteria initially matched 2, not 1**
- **Found during:** Task 1 verification
- **Issue:** The corrected top-of-table comment in `servers.ts` originally named both new camelCase identifiers directly, so `grep -c 'pendingFingerprintSeenAt'` matched both the comment and the declaration.
- **Fix:** Reworded the comment to describe the change without repeating the camelCase identifiers.
- **Files modified:** apps/control-plane/src/db/schema/servers.ts
- **Committed in:** `49fcc71`

**2. [Rule 1 - Bug] `.env.example`'s `NOODARA_SSH_` grep initially matched 5, not 3**
- **Found during:** Task 3 verification
- **Issue:** The command/discovery comments cross-referenced each other's full variable name, so the count included those cross-references in addition to the three variable declarations.
- **Fix:** Reworded both comments to say "the discovery timeout below" / "the command timeout above" instead of repeating the other variable's name.
- **Files modified:** .env.example
- **Committed in:** `5a5d1fc`

**3. [Rule 1 - Bug] ESLint `@typescript-eslint/restrict-template-expressions` rejected `${range.min}`/`${range.max}` (both `number`) in template literals**
- **Found during:** Task 3, `pnpm lint`
- **Issue:** The project's strict ESLint config forbids interpolating a `number` directly into a template literal.
- **Fix:** Wrapped both in `String(...)`.
- **Files modified:** apps/control-plane/src/env.ts
- **Verification:** `pnpm lint` exits 0.
- **Committed in:** `5a5d1fc`

## Issues Encountered

`drizzle-kit generate` requires a valid parsed environment because `drizzle.config.ts` imports `env.ts`; ran it with the repo's existing local `.env` sourced into the shell for that one invocation only (no fallback value was added anywhere, preserving the `no-restricted-syntax` rule env.ts already enforces).

One pre-existing, unrelated false-positive: `grep -c 'received' apps/control-plane/src/env.ts` returns 1, matching a phase-1 JSDoc comment on `EnvIssue` ("Never carries a `received` field...") that predates this plan and describes the safety property rather than violating it — `env.test.ts`'s `never exposes a "received" field` test (unchanged, still passing) is the actual behavioural guard. Left as-is since it is outside this plan's `<files>` list and touching it would be unrelated documentation churn.

## User Setup Required

None. `pnpm test:integration` needs a reachable Docker daemon and the repo's local `.env`, both already present in this environment.

## Next Phase Readiness

- Plan 02-05 (domain-side `applyConnectionResult`/`UNSUPPORTED_OS` mapping change) can now read/write `hostFingerprintCapturedAt`/`pendingFingerprintSeenAt` through `schema.servers` without any further migration.
- Any plan assembling `SshTimeouts` for `packages/ssh`'s `connect`/`runDiscovery` should read `env.NOODARA_SSH_CONNECT_TIMEOUT_MS`/`NOODARA_SSH_COMMAND_TIMEOUT_MS`/`NOODARA_SSH_DISCOVERY_TIMEOUT_MS` and pass them by parameter — `packages/ssh` itself must never read `process.env` (enforced by `packages/ssh/src/boundary.test.ts`, unchanged and still passing).
- The from-snapshot migration test's raw-SQL-subset pattern (now demonstrated twice, for `login_attempts.lockout_count` and `servers`'s two new timestamps) is the template any future migration plan touching a table with pre-existing rows should follow.

## Threat Flags

None beyond what the plan's own `<threat_model>` already covers (T-2-09 through T-2-12) — no new network endpoint, auth path, or schema change was introduced outside that register.

---
*Phase: 02-adaptador-ssh-aislado-y-probado-con-testcontainers*
*Completed: 2026-09-13*

## Self-Check: PASSED

- FOUND: apps/control-plane/src/db/migrations/0002_phase2_fingerprint_timestamps.sql
- FOUND: apps/control-plane/src/db/migrations/meta/0002_snapshot.json
- FOUND: apps/control-plane/src/db/schema/servers.ts
- FOUND: apps/control-plane/src/db/migrations/meta/_journal.json
- FOUND: tests/integration/db/migrations.test.ts
- FOUND: tests/integration/fixtures/representative-data.ts
- FOUND: apps/control-plane/src/env.ts
- FOUND: apps/control-plane/src/env.test.ts
- FOUND: .env.example
- FOUND commit: `49fcc71` (Task 1)
- FOUND commit: `43bf274` (Task 2)
- FOUND commit: `f7ab6a7` (Task 3 RED)
- FOUND commit: `5a5d1fc` (Task 3 GREEN)

Re-verified independently: `pnpm lint`, `pnpm typecheck`, `pnpm build`, `pnpm test` (402/402), `pnpm test:integration` (131/131), `pnpm exec turbo boundaries` (211 files, no issues) all exit 0. `pnpm exec vitest run --config vitest.integration.config.ts tests/integration/db/` (36/36). `grep -c 'ADD COLUMN IF NOT EXISTS' apps/control-plane/src/db/migrations/0002_phase2_fingerprint_timestamps.sql` → 2. `grep -c 'NOT NULL\|DEFAULT'` on the same file → 0. `docker ps -aq --filter label=noodara.test=true | wc -l` → 0.
