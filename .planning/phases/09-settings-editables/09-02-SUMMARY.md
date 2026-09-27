---
phase: 09-settings-editables
plan: 02
subsystem: database
tags: [drizzle, postgresql, jsonb, migrations, testcontainers]

requires:
  - phase: 09-settings-editables (plan 01)
    provides: "Preferences zod schema and resolveStoredPreferences (consumed by readers, not by this migration itself)"
provides:
  - "users.preferences jsonb NOT NULL DEFAULT '{}'::jsonb column, live on schema, migration 0004 and the dev database"
  - "Migration 0004_phase9_user_preferences.sql + its meta/snapshot + journal entry"
  - "Upgrade-path test proving a pre-0004 user row backfills to {}"
affects: [09-03, 09-04, 09-05, 09-06, 09-07, 09-08, 09-09, 09-10, 09-11, 09-12, 09-13, 09-14]

tech-stack:
  added: []
  patterns:
    - "Fixture seeding for the from-snapshot upgrade test must use raw SQL restricted to columns present at the previous journal tag whenever the newest migration adds a NOT NULL DEFAULT column to a table the fixture already seeds (drizzle always emits every schema column, including a literal `default`, so the column must exist even to receive its own default) — applied here to seedRepresentativeData's users insert and fetchSeededSnapshot's 'before' user read, following the pattern login_attempts/lockout_count and servers/host_fingerprint_captured_at already established"

key-files:
  created:
    - apps/control-plane/src/db/migrations/0004_phase9_user_preferences.sql
    - apps/control-plane/src/db/migrations/meta/0004_snapshot.json
  modified:
    - apps/control-plane/src/db/schema/auth.ts
    - apps/control-plane/src/db/migrations/meta/_journal.json
    - tests/integration/db/migrations.test.ts
    - tests/integration/fixtures/representative-data.ts

key-decisions:
  - "schema.test.ts left unchanged: it does not enumerate users columns, so no phase-9 assertion was needed there (per Task 1's own conditional instruction)"
  - "seedRepresentativeData's users insert and fetchSeededSnapshot's pre-upgrade user read were switched from ORM select/insert to raw SQL restricted to pre-0004 columns, because the ORM's schema.users module reflects the newest migration and would otherwise reference the not-yet-created preferences column during the 'before' phase of the upgrade test"

requirements-completed: [SET-04, SET-05]

duration: ~20min
completed: 2026-09-27
---

# Phase 9 Plan 02: users.preferences column via migration 0004 Summary

**Added `users.preferences` jsonb NOT NULL DEFAULT '{}' via a generated, defensively-guarded migration 0004, applied to the live dev database and proven by Testcontainers migration tests including the upgrade path.**

## Performance

- **Duration:** ~20 min
- **Started:** 2026-09-27T06:52:26Z
- **Completed:** 2026-09-27T07:00:10Z
- **Tasks:** 2
- **Files modified:** 6

## Accomplishments
- `users.preferences` Drizzle column (`jsonb('preferences').$type<Record<string, unknown>>().notNull().default(sql\`'{}'::jsonb\`)`) added to `apps/control-plane/src/db/schema/auth.ts`, with a comment directing all readers through `resolveStoredPreferences` (09-01) rather than trusting the raw jsonb
- Migration `0004_phase9_user_preferences.sql` generated via `drizzle-kit generate`, renamed from the tool's random name, journal tag updated to match, with the SQL edited to the defensive `ADD COLUMN IF NOT EXISTS ... jsonb DEFAULT '{}'::jsonb NOT NULL` shape (matching 0003's precedent)
- Migration applied to the live dev database (`noodara-dev-postgres-1`, port 5434) and verified with `\d users`
- Testcontainers migration suite covers: journal tag order, column metadata (jsonb/NOT NULL/'{}'::jsonb default), insert-without-preferences reads back `{}`, jsonb round-trip, and the upgrade path (a user row seeded before 0004 backfills to `{}` after `runMigrations`)

## Task Commits

Each task was committed atomically (RED -> GREEN, no REFACTOR needed):

1. **Task 1: Failing migration tests for users.preferences** - `a720ad2` (test)
2. **Task 2: Schema column, generated migration 0004, applied to the dev database** - `643177d` (feat)

_Note: Task 2's commit also includes the required fixture fix (raw-SQL seed) discovered while making the upgrade test green — see Deviations below._

## Files Created/Modified
- `apps/control-plane/src/db/schema/auth.ts` - adds `preferences` jsonb column to `users`
- `apps/control-plane/src/db/migrations/0004_phase9_user_preferences.sql` - `ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "preferences" jsonb DEFAULT '{}'::jsonb NOT NULL;`
- `apps/control-plane/src/db/migrations/meta/0004_snapshot.json` - drizzle-kit generated snapshot
- `apps/control-plane/src/db/migrations/meta/_journal.json` - appends the `0004_phase9_user_preferences` tag
- `tests/integration/db/migrations.test.ts` - journal tag assertion, new `phase-9 schema objects (D-16)` describe block (column metadata, default-value read-back, jsonb round-trip), upgrade-path assertion, and the raw-SQL fix to `fetchSeededSnapshot`'s pre-upgrade user read
- `tests/integration/fixtures/representative-data.ts` - `seedRepresentativeData`'s users insert switched to raw SQL restricted to pre-0004 columns

## Decisions Made
- No new decisions beyond D-16 (already locked in 09-CONTEXT.md); the raw-SQL fixture fix is a direct application of the pattern the codebase already established for `login_attempts.lockout_count` and `servers.host_fingerprint_captured_at`/`pending_fingerprint_seen_at`, not a new architectural choice.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 3 - Blocking] Fixed the from-snapshot upgrade test's seed and pre-upgrade read to avoid referencing the not-yet-created preferences column**
- **Found during:** Task 2, running the integration suite to reach GREEN
- **Issue:** `seedRepresentativeData`'s `db.insert(schema.users)` and `fetchSeededSnapshot`'s `db.select().from(schema.users)` both use the current code's ORM schema module, which now includes `preferences`. Drizzle always emits every schema column in its generated SQL (including a literal `default` for omitted values), so both statements referenced a column that does not exist yet at the point in the test where migrations are only applied up to the previous tag (0003) — failing with `column "preferences" does not exist`. This is the exact scenario the file's own comments already document for `lockout_count` (migration 0001) and `host_fingerprint_captured_at`/`pending_fingerprint_seen_at` (migration 0002).
- **Fix:** Switched `seedRepresentativeData`'s users insert to raw SQL restricted to the pre-0004 column set (id, name, email), and `fetchSeededSnapshot`'s pre-upgrade user read to the same restricted raw SQL, following the file's own established pattern verbatim.
- **Files modified:** tests/integration/fixtures/representative-data.ts, tests/integration/db/migrations.test.ts
- **Verification:** `pnpm exec vitest run --config vitest.integration.config.ts tests/integration/db/migrations.test.ts tests/integration/db/migration-hygiene.test.ts tests/integration/db/schema.test.ts` — 54/54 passed
- **Committed in:** 643177d (Task 2 GREEN commit)

---

**Total deviations:** 1 auto-fixed (blocking test-fixture fix required to reach GREEN)
**Impact on plan:** Required to satisfy Task 2's own acceptance criteria (integration suite exits 0). No scope creep — the plan's `read_first` for Task 1 explicitly flagged `representative-data.ts` as a file to review for this exact issue.

## Issues Encountered
None beyond the auto-fixed deviation above.

## User Setup Required
None - no external service configuration required. The live dev database migration was applied by this plan itself (see Migration Output below).

### Migration Output (dev DB, port 5434)

```
$ DATABASE_URL=postgresql://noodara:<dev-db-password>@localhost:5434/noodara pnpm db:migrate
db:migrate completed in 18ms: 1 migration(s) applied, 5 total
```

Verified with:
```
$ docker exec noodara-dev-postgres-1 psql -U noodara -d noodara -c '\d users'
                              Table "public.users"
     Column     |           Type           | Collation | Nullable |   Default
----------------+--------------------------+-----------+----------+-------------
 id             | uuid                     |           | not null |
 name           | text                     |           | not null |
 email          | text                     |           | not null |
 email_verified | boolean                  |           | not null | false
 image          | text                     |           |          |
 created_at     | timestamp with time zone |           | not null | now()
 updated_at     | timestamp with time zone |           | not null | now()
 preferences    | jsonb                    |           | not null | '{}'::jsonb
```

## Next Phase Readiness
- `users.preferences` exists in schema, migration, journal, and the live dev database — every later plan's integration or E2E verification in this phase can now rely on it being present.
- `pnpm lint`, `pnpm typecheck`, and `pnpm test` (2838 tests) all pass at the repo root; `pnpm --filter @noodara/control-plane typecheck` passes.
- No blockers identified for the next plan in the wave.

---
*Phase: 09-settings-editables*
*Completed: 2026-09-27*
