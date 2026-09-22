---
phase: 03-servicios-de-aplicaci-n-activity-log-y-redacci-n
plan: 03
subsystem: database
tags: [drizzle, postgresql, migrations, testcontainers, vitest, discovery]

# Dependency graph
requires:
  - phase: 02-adaptador-ssh-aislado-y-probado-con-testcontainers
    provides: "packages/domain/src/discovery/types.ts (DiscoverySnapshot, DiscoveryFacts shape)"
  - phase: 03-servicios-de-aplicaci-n-activity-log-y-redacci-n
    provides: "03-02's SnapshotOutcome ('ok' | 'partial' | 'failed') used as the discovery_outcome enum's value set"
provides:
  - "discovery_snapshots table: append-only, server_id FK ON DELETE CASCADE, outcome enum, nullable error_code (reuses server_error_code), jsonb payload, (server_id, collected_at desc) index"
  - "servers.docker_compose_version: nullable text column"
  - "servers_name_lower_unique_idx and servers_host_port_unique_idx: database-level D-10 uniqueness"
  - "migration 0003_phase3_discovery_snapshots, journaled and defensively guarded"
  - "seedDiscoverySnapshot(db, serverId) fixture helper for post-upgrade discovery_snapshots seeding"
affects: [03-05-registerServer, 03-06-editServer, 03-07-deleteServer, 03-08-connectAndDiscover, 03-09-trustFingerprint]

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "New pgTable third-argument index arrays follow the existing uniqueIndex(...).on(sql`lower(${table.col})`) precedent from auth.ts for case-insensitive uniqueness"
    - "Enums that mirror an existing packages/domain string union (SnapshotOutcome) are declared once in the owning schema module and reused by FK-adjacent tables via serverErrorCodeEnum import, never redeclared"
    - "Drizzle-generated migration SQL is always hand-reviewed and wrapped in the repo's defensive guards (IF NOT EXISTS / DO $$ ... EXCEPTION WHEN duplicate_object) before being committed, per migration-hygiene.test.ts"

key-files:
  created:
    - apps/control-plane/src/db/schema/discovery-snapshots.ts
    - apps/control-plane/src/db/migrations/0003_phase3_discovery_snapshots.sql
    - apps/control-plane/src/db/migrations/meta/0003_snapshot.json
  modified:
    - apps/control-plane/src/db/schema/servers.ts
    - apps/control-plane/src/db/schema/index.ts
    - apps/control-plane/src/db/migrations/meta/_journal.json
    - tests/integration/db/migrations.test.ts
    - tests/integration/db/schema.test.ts
    - tests/integration/fixtures/representative-data.ts

key-decisions:
  - "Test assertions for the D-10 uniqueness violations check err.cause.code (not err.code): drizzle-orm 0.45's node-postgres driver wraps the raw pg error in a DrizzleQueryError, exposing the pg driver's own `code`/`constraint`/`detail` fields under `.cause`, not on the wrapper itself"
  - "discoveryOutcomeEnum ('ok' | 'partial' | 'failed') is declared fresh in discovery-snapshots.ts rather than imported from packages/domain, since Drizzle enums are a database-schema concern and packages/domain's SnapshotOutcome type has no runtime representation to import — the two are kept in sync by convention, not by a shared import"

requirements-completed: [DISC-03, SERV-01]

# Metrics
duration: 31min
completed: 2026-09-15
---

# Phase 3 Plan 3: Discovery Snapshots Schema and Migration 0003 Summary

**discovery_snapshots table (append-only, cascade delete, jsonb payload) plus servers.docker_compose_version and two database-level uniqueness indexes, shipped as versioned migration 0003 and proven from-scratch and from-snapshot.**

## Performance

- **Duration:** 31 min
- **Started:** 2026-09-15T19:35:50-06:00
- **Completed:** 2026-09-15T20:06:38-06:00
- **Tasks:** 2
- **Files modified:** 9

## Accomplishments
- `discovery_snapshots` table exists with `server_id` FK `ON DELETE CASCADE` (D-08), an `outcome` enum (`ok`/`partial`/`failed`, matching 03-02's `SnapshotOutcome`), a nullable `error_code` reusing `server_error_code` (no new enum), a `jsonb` `payload` that round-trips a `DiscoverySnapshot`-shaped object unchanged, and a `(server_id, collected_at desc)` index for phase-5's history reads.
- `servers.docker_compose_version` (D-09) added as nullable text, backfilling NULL for the one pre-existing row proven by the from-snapshot upgrade test.
- `servers_name_lower_unique_idx` (`lower(name)`) and `servers_host_port_unique_idx` (`host, ssh_port`) enforce D-10 at the database: a case-variant duplicate name or a duplicate host:port pair is rejected with Postgres code `23505` even if a service-layer check is bypassed; two servers on the same host with different ports are still accepted.
- Migration `0003_phase3_discovery_snapshots` generated via `drizzle-kit generate`, then hand-guarded (`CREATE TABLE IF NOT EXISTS`, `ADD COLUMN IF NOT EXISTS`, `CREATE UNIQUE INDEX IF NOT EXISTS` ×2, FK and `CREATE TYPE` both wrapped in `DO $$ ... EXCEPTION WHEN duplicate_object THEN null; END $$`), journaled as `idx: 3`, and proven to apply from an empty database and from the `0002` snapshot without losing representative data (QA-06).

## Task Commits

Each task was committed atomically (TDD: test → feat):

1. **Task 1 (RED): Phase-3 expectations in migration, schema and fixture suites**
   - RED: `52dc819` (test)
2. **Task 2 (GREEN) [BLOCKING]: schema modules and versioned migration 0003**
   - GREEN: `a66ca1a` (feat, includes a test-assertion fix for drizzle-orm's wrapped pg error shape and an unused-import lint fix)

**Plan metadata:** committed alongside this SUMMARY (see final commit below).

## Files Created/Modified
- `apps/control-plane/src/db/schema/discovery-snapshots.ts` - `discoverySnapshots` table, `discoveryOutcomeEnum`
- `apps/control-plane/src/db/schema/servers.ts` - `dockerComposeVersion` column, `servers_name_lower_unique_idx`, `servers_host_port_unique_idx`
- `apps/control-plane/src/db/schema/index.ts` - barrel export for `discovery-snapshots.js`
- `apps/control-plane/src/db/migrations/0003_phase3_discovery_snapshots.sql` - versioned, defensively-guarded migration
- `apps/control-plane/src/db/migrations/meta/0003_snapshot.json`, `meta/_journal.json` - drizzle-kit bookkeeping
- `tests/integration/db/migrations.test.ts` - journal tag, `EXPECTED_TABLES` entry, `phase-3 schema objects` describe block (column/index/uniqueness/cascade/jsonb-roundtrip cases), from-snapshot `docker_compose_version IS NULL` assertion
- `tests/integration/db/schema.test.ts` - `EXPECTED_TABLES` entry
- `tests/integration/fixtures/representative-data.ts` - `seedDiscoverySnapshot(db, serverId)` helper

## Decisions Made
- D-10 uniqueness-violation assertions target `err.cause.code`, since drizzle-orm 0.45's `DrizzleQueryError` wraps the raw `pg` driver error rather than re-exposing `code` on itself — discovered when the RED-written assertions (matching the plan's literal wording) still failed after the real unique indexes were created and working correctly.
- `discoveryOutcomeEnum` is declared directly in the schema module rather than derived from packages/domain's `SnapshotOutcome` type, since a TypeScript union has no runtime array to spread into `pgEnum(...)` the way `SERVER_STATUSES`/`SERVER_ERROR_CODES` do.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] Fixed unique-violation test assertions to match drizzle-orm's actual error shape**
- **Found during:** Task 2 (GREEN verification run)
- **Issue:** The Task 1 RED tests asserted `toMatchObject({ code: '23505' })` directly on the rejected promise, per the plan's literal instruction. Once the real unique indexes existed and Postgres genuinely rejected the duplicate inserts, the assertion still failed — `code: '23505'` and `constraint: 'servers_name_lower_unique_idx'`/`'servers_host_port_unique_idx'` are present on `err.cause`, not on the `DrizzleQueryError` wrapper drizzle-orm 0.45's node-postgres driver throws.
- **Fix:** Changed both assertions to `toMatchObject({ cause: { code: '23505' } })`.
- **Files modified:** tests/integration/db/migrations.test.ts
- **Verification:** Both tests pass; the underlying Postgres error detail (`Key (lower(name))=(srv-1) already exists.` / `Key (host, ssh_port)=(10.0.0.5, 22) already exists.`) confirms the real constraint fired, not a mis-written test that happened to pass.
- **Committed in:** a66ca1a (Task 2 commit)

**2. [Rule 3 - Blocking] Removed unused `text` import from discovery-snapshots.ts**
- **Found during:** Task 2 (`pnpm lint`)
- **Issue:** The schema module imported `text` from `drizzle-orm/pg-core` but never used it (no text columns in the final table shape), tripping `@typescript-eslint/no-unused-vars`.
- **Fix:** Removed the unused import.
- **Files modified:** apps/control-plane/src/db/schema/discovery-snapshots.ts
- **Verification:** `pnpm lint` exits 0 across all four packages.
- **Committed in:** a66ca1a (Task 2 commit)

---

**Total deviations:** 2 auto-fixed (1 bug in test assertion, 1 blocking lint fix)
**Impact on plan:** Both fixes are corrections to the plan's own literal instructions/generated code, not scope changes. No new behavior introduced beyond what the plan specified.

## Issues Encountered
None beyond the two auto-fixed items above.

## User Setup Required
None - no external service configuration required.

## Next Phase Readiness
- `discovery_snapshots`, `docker_compose_version`, and both D-10 unique indexes exist and are proven correct at the database level; every subsequent plan in this phase (registerServer, editServer, deleteServer, connectAndDiscover, trustFingerprint) can now read/write these columns without a schema gap.
- `pnpm test:integration` is green end-to-end (222 passed, 1 pre-existing conditional stress test skipped, no stray Testcontainers containers) — this plan's migration introduced no regression in any earlier phase's suite.
- No service code was added by this plan; `apps/control-plane/src/services/` remains untouched, exactly as the plan's verification required.

---
*Phase: 03-servicios-de-aplicaci-n-activity-log-y-redacci-n*
*Completed: 2026-09-15*

## Self-Check: PASSED

- FOUND: apps/control-plane/src/db/schema/discovery-snapshots.ts
- FOUND: apps/control-plane/src/db/migrations/0003_phase3_discovery_snapshots.sql
- FOUND: apps/control-plane/src/db/migrations/meta/0003_snapshot.json
- FOUND commit: 52dc819 (test)
- FOUND commit: a66ca1a (feat)
- FOUND commit: 3e4e03c (docs: summary)
