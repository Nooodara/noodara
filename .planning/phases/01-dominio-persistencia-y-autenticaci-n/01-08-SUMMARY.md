---
phase: 01-dominio-persistencia-y-autenticacion
plan: 08
subsystem: database
tags: [drizzle, postgresql, migrations, testcontainers, vitest, testing]

# Dependency graph
requires:
  - phase: 01-dominio-persistencia-y-autenticacion
    provides: "tests/integration/helpers/postgres.ts (startPostgres) and tests/integration/helpers/app.ts (Plan 01-07); runMigrations(db)/MIGRATIONS_FOLDER from apps/control-plane/src/db/migrate.ts; the nine-table Drizzle schema and the 0000_shiny_franklin_storm.sql migration"
provides:
  - "tests/integration/helpers/migrations.ts: readJournal()/applyMigrationsUpTo(db, tag) — a journal-driven partial-migration-application helper that writes the same drizzle.__drizzle_migrations bookkeeping rows the real migrator writes"
  - "startPostgres({ migrate: false }) option letting a test start a genuinely empty, unmigrated database"
  - "tests/integration/fixtures/representative-data.ts: seedRepresentativeData(db) — a real-encrypted-credential seed fixture every future migration test can reuse"
  - "tests/integration/db/migrations.test.ts: from-scratch and from-previous-snapshot QA-06 coverage, generic over journal length so it never needs editing as migrations accumulate"
  - "tests/integration/db/migration-hygiene.test.ts: a static CI guard failing the build on any unguarded CREATE/DROP or journal/file drift (T-1-21)"
affects: ["01-09", "01-10", "01-11", "01-12", "01-13", "01-14", "every future phase-1+ migration inherits this guard"]

# Tech tracking
tech-stack:
  added:
    - "drizzle-orm 0.45.2 promoted to a root devDependency (previously only declared inside apps/control-plane) so root-level tests/integration files can import `sql`/`eq` directly"
  patterns:
    - "Journal-driven partial migration application: applyMigrationsUpTo splits each migration file on drizzle's own `--> statement-breakpoint` marker and hand-writes the same drizzle.__drizzle_migrations bookkeeping row (sha256 hash of the file + the journal entry's `when` as created_at) the production migrator writes internally — so a later call to the real runMigrations() sees a partially-migrated database as 'already applied up to here' and only runs whatever comes after, instead of re-running (and failing on) statements that already ran. This is the mechanism that makes the from-snapshot test possible without a second, divergent migration-application code path."
    - "From-snapshot test computed generically as `journal[journal.length - 2] ?? journal[0]`, so it needs zero edits once migration 3, 4, 5 exist (01-CONTEXT.md: 'en esta fase el snapshot anterior es la migracion inicial')"
    - "Static hygiene guard lives in the integration project (not unit) so it runs in the same CI job as the rest of the migration coverage, per the plan's own instruction, despite touching no database at all"

key-files:
  created:
    - tests/integration/helpers/migrations.ts
    - tests/integration/fixtures/representative-data.ts
    - tests/integration/db/migrations.test.ts
    - tests/integration/db/migration-hygiene.test.ts
  modified:
    - tests/integration/helpers/postgres.ts (added the `{ migrate: false }` option)
    - package.json (root: drizzle-orm devDependency)
    - pnpm-lock.yaml

key-decisions:
  - "applyMigrationsUpTo manually writes the drizzle.__drizzle_migrations bookkeeping row (matching drizzle-orm's own pg-core dialect.migrate() hash/created_at shape exactly), not just the raw SQL: drizzle's real migrate() decides what remains to apply solely by comparing each migration's journal `when` timestamp against the single most recent bookkeeping row's created_at, so without a matching row the production runMigrations() called after a partial manual apply would try to re-run (and fail on) migrations that already executed."
  - "drizzle-orm added as a root devDependency, not just imported transitively: tests/integration/db files need to import `sql`/`eq` directly, and pnpm's isolated node_modules only symlinks a workspace package into the packages that actually declare it in their own package.json — never up to the workspace root — so the bare specifier was unresolvable from tests/ until declared at the root."
  - "representative-data.ts seeds all nine previous-snapshot tables, including `verifications`, even though Task 2's behavior text names only eight tables by example: the same sentence's normative clause is 'every table that exists at the previous-snapshot point', and seeding all nine (not eight) is what actually proves no-data-loss across the upgrade for the complete schema, not a subset of it."

patterns-established:
  - "Pattern: any future migration test needing a mid-journal database state should use applyMigrationsUpTo(db, tag) rather than hand-rolling a second migration runner — it is now the one partial-apply path, mirroring runMigrations() as the one full-apply path."
  - "Pattern: migration-hygiene.test.ts's journal/file consistency check and its per-statement defensiveness check will automatically extend to migrations 2, 3, 4... with zero code changes, since both iterate `readdirSync(MIGRATIONS_FOLDER)` and `readJournal()` rather than a hardcoded list."

requirements-completed: [QA-06]

# Metrics
duration: ~21min
completed: 2026-09-11
---

# Phase 1 Plan 8: Migration Tests From Scratch and From the Previous Snapshot, Plus a Hygiene Guard Summary

**A journal-driven partial-migration helper (`applyMigrationsUpTo`) that reuses the exact production `runMigrations` bookkeeping shape, backing a from-scratch suite, a from-snapshot suite generic over journal length, and a static hygiene guard that fails CI on any unguarded `CREATE`/`DROP` or journal/file drift.**

## Performance

- **Duration:** ~21 min
- **Started:** 2026-09-11T01:20:00Z (approx.)
- **Completed:** 2026-09-11T01:41:47Z
- **Tasks:** 2
- **Files modified:** 4 created, 3 modified

## Accomplishments
- `tests/integration/helpers/migrations.ts` exports `readJournal()` (the ordered list of migration tags) and `applyMigrationsUpTo(db, tag)`, which applies every migration up to and including `tag` (or nothing when `tag` is `null`) by splitting each file on drizzle's own `--> statement-breakpoint` marker and writing the same `drizzle.__drizzle_migrations` bookkeeping row the production migrator writes — so a later call to the real `runMigrations` treats a partially-applied database correctly and only runs what remains.
- `tests/integration/helpers/postgres.ts` gained a `{ migrate: false }` option (backward compatible; every existing caller keeps its default fully-migrated behavior) so tests can start a genuinely empty container.
- `tests/integration/db/migrations.test.ts`: a from-scratch describe block (full apply creates all 9 tables/7 enums, `applyMigrationsUpTo(db, null)` applies nothing, exactly one bookkeeping row per journal entry after a full apply, and two consecutive `runMigrations()` calls are a no-op the second time) plus a from-snapshot describe block that applies up to `journal[journal.length - 2] ?? journal[0]`, seeds representative data, upgrades via the production `runMigrations` path, and asserts every seeded row survives field-identical with the `servers.credential_id` foreign key still resolving and `status` unchanged.
- `tests/integration/fixtures/representative-data.ts`'s `seedRepresentativeData(db)` inserts one row into all nine previous-snapshot tables — including a real AES-256-GCM encrypted credential via `encryptSecret` from `packages/domain/src/security/envelope.ts` under key version 1 — and returns only the inserted ids, so the migration test looks rows up by id rather than by scanning.
- `tests/integration/db/migration-hygiene.test.ts` statically parses every `.sql` file under the migrations folder (no container needed) and fails the build on: an unguarded `CREATE TABLE`/`CREATE INDEX` (missing `IF NOT EXISTS`), an unguarded `DROP` (missing `IF EXISTS`), a `CREATE TYPE` not wrapped in the `EXCEPTION WHEN duplicate_object` pattern, or any drift between the journal and the files on disk (T-1-21). Both deliberate failure injections from the plan's acceptance criteria were verified live and reverted before committing (see Deviations/verification notes below).
- Full command chain green after both tasks: `pnpm typecheck`, `pnpm lint`, `pnpm build`, `pnpm test` (284 tests), `pnpm test:integration` (3 files / 33 tests), zero `noodara.test=true` containers left running.

## Task Commits

Each task was committed atomically:

1. **Task 1: Journal-driven migration helper and the from-scratch test** - `9161859` (test)
2. **Task 2: From-previous-snapshot test with representative data, plus the defensiveness guard** - `6a67119` (test)

**Plan metadata:** _(final metadata commit follows this summary)_

## Files Created/Modified
- `tests/integration/helpers/migrations.ts` - `readJournal()` / `applyMigrationsUpTo(db, tag)`: journal-driven partial migration application with matching bookkeeping-row writes
- `tests/integration/helpers/postgres.ts` - `startPostgres({ migrate: false })` option added; existing callers unaffected
- `tests/integration/fixtures/representative-data.ts` - `seedRepresentativeData(db)`: one row per previous-snapshot table, real encrypted credential, returns ids only
- `tests/integration/db/migrations.test.ts` - from-scratch suite + from-snapshot suite (generic over journal length)
- `tests/integration/db/migration-hygiene.test.ts` - static defensiveness + journal/file-consistency guard
- `package.json` / `pnpm-lock.yaml` - `drizzle-orm` added as a root devDependency

## Decisions Made
See `key-decisions` in frontmatter for the three decisions with the most downstream impact (bookkeeping-row parity in `applyMigrationsUpTo`, `drizzle-orm` promoted to a root devDependency, seeding all nine tables instead of the eight named by example in the plan text).

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 3 - Blocking] `drizzle-orm` bare specifier unresolvable from root-level test files**
- **Found during:** Task 1
- **Issue:** `tests/integration/db/migrations.test.ts` needs `sql`/`sql.identifier`/`sql.raw` from `drizzle-orm` directly (not just via an already-constructed `db` object, unlike the existing `schema.test.ts`). Running the test failed with `Cannot find package 'drizzle-orm' imported from tests/integration/db/migrations.test.ts` — pnpm's isolated `node_modules` only symlinks a workspace dependency into the packages that declare it (`apps/control-plane`), never up to the workspace root, so a root-level file has no resolution path to it.
- **Fix:** `pnpm add -D -w drizzle-orm@0.45.2` — the exact same version already pinned and vetted in `apps/control-plane/package.json` (not a new/unfamiliar package name; this is the "already-vetted dependency, declare at another workspace level" case, not the Rule-3 slopsquatting-risk exclusion for genuinely new package installs).
- **Files modified:** package.json, pnpm-lock.yaml
- **Verification:** `pnpm exec vitest run --config vitest.integration.config.ts tests/integration/db/migrations.test.ts` passes; `pnpm typecheck`/`pnpm lint`/`pnpm build`/`pnpm test` all still exit 0 (tests/ is outside every package's own lint/typecheck scope, confirmed by inspecting `turbo run lint`/`typecheck` output — only `@noodara/config`, `@noodara/control-plane`, `@noodara/domain` run).
- **Committed in:** `9161859`

**2. [Rule 2 - Missing completeness] `seedRepresentativeData` also seeds `verifications`, not just the eight tables named by example**
- **Found during:** Task 2
- **Issue:** Task 2's behavior text names eight specific rows ("a user, a session, an account, a setup token, a login attempt, a credential, a server ..., and an activity event") but its own governing clause says "inserts at least one row into every table that exists at the previous-snapshot point" — and the previous-snapshot point (migration 0000) creates nine tables, including `verifications`.
- **Fix:** Added a `verifications` row to the fixture so the from-snapshot test's no-data-loss claim actually covers the complete schema rather than 8 of 9 tables.
- **Files modified:** tests/integration/fixtures/representative-data.ts
- **Verification:** `pnpm test:integration` — the from-snapshot test fetches and compares the `verifications` row before/after the upgrade step alongside the other eight.
- **Committed in:** `6a67119`

---

**Total deviations:** 2 (1 blocking dependency-resolution fix, 1 completeness addition following the plan's own governing clause). No scope creep beyond Task 1–2's declared `<files>` lists; the `drizzle-orm` devDependency is the only addition not explicitly named in the plan, and it was strictly required for the plan's own literal test files to run at all.

## Issues Encountered

None beyond the two deviations above. Both acceptance-criteria failure injections (an unguarded `CREATE TABLE foo (id uuid);` file, and a defensive-but-journal-unreferenced `.sql` file) were created, confirmed to fail `migration-hygiene.test.ts` for the expected reason, and removed before the final commit — no leftover fixture files remain in the migrations folder.

## User Setup Required

None — no external service configuration required. `pnpm test:integration` needs a reachable Docker daemon, same as every prior phase-1 integration plan.

## Next Phase Readiness
- Every later phase-1 plan that adds a new migration (none currently planned to touch `apps/control-plane/src/db/migrations` before phase 2+) will automatically be covered by both `migrations.test.ts`'s from-snapshot suite (via `journal[journal.length - 2]`) and `migration-hygiene.test.ts`'s per-file defensiveness/journal-consistency guard — no test file needs editing.
- `applyMigrationsUpTo(db, tag)` and `seedRepresentativeData(db)` are exported specifically so any future integration test needing a mid-journal database state can reuse them instead of writing a second migration runner.
- Note for future migrations: the hygiene guard's `CREATE TYPE` check requires the exact `DO $$ BEGIN ... EXCEPTION WHEN duplicate_object THEN null; END $$` pattern (or an equivalent containing both `EXCEPTION` and `duplicate_object` in the same statement-breakpoint chunk) — any future hand-hardening pass on a generated migration must keep using this shape or the guard will correctly reject it.

---
*Phase: 01-dominio-persistencia-y-autenticacion*
*Completed: 2026-09-11*
