---
phase: 11-motor-de-deploy-fundamentos
plan: 05
subsystem: database
tags: [drizzle, postgres, migration, proj-04, dep-01, dep-08, d16, d-15, d-16, d-17, d-18]
requires: ["11-01", "11-02"]
provides:
  - "projects, environments, services, deployments, deployment_log_chunks tables + 6 pg enums spread from domain tuples"
  - "composite FK services_environment_project_fk (PROJ-04) and partial unique index deployments_service_active_unique_idx (D16)"
  - "credential_type += git_deploy_key/git_https_token/registry_password, credentials.public_key, services RESTRICT credential FKs (D-15..D-18)"
  - "servers.docker_buildkit_available (D-03 fact, NULL until discovery)"
  - "migration 0005_phase11_deploy_engine (hand-guarded) + snapshot + journal"
  - "toServerCredentialType(): narrows the widened stored credential_type to SSH types for server views"
affects: [11-06, 11-12, 12]
tech-stack:
  added: []
  patterns:
    - "partial index predicate built with sql.raw from a compile-time domain tuple"
    - "hygiene guard: no migration may reference an enum value added by ADD VALUE (one-transaction migrator)"
key-files:
  created:
    - apps/control-plane/src/db/schema/projects.ts
    - apps/control-plane/src/db/schema/environments.ts
    - apps/control-plane/src/db/schema/services.ts
    - apps/control-plane/src/db/schema/deployments.ts
    - apps/control-plane/src/db/schema/deployment-log-chunks.ts
    - apps/control-plane/src/db/migrations/0005_phase11_deploy_engine.sql
    - apps/control-plane/src/db/migrations/meta/0005_snapshot.json
    - tests/integration/db/schema-ownership.test.ts
  modified:
    - apps/control-plane/src/db/schema/credentials.ts
    - apps/control-plane/src/db/schema/servers.ts
    - apps/control-plane/src/db/schema/index.ts
    - apps/control-plane/src/db/migrations/meta/_journal.json
    - apps/control-plane/src/services/server-view.ts
    - apps/control-plane/src/services/server-view.test.ts
    - apps/control-plane/src/services/connect-and-discover.ts
    - apps/control-plane/src/services/edit-server.ts
    - apps/control-plane/src/services/read-servers.ts
    - apps/control-plane/src/services/trust-fingerprint.ts
    - apps/control-plane/src/services/fail-in-flight-connection.ts
    - tests/integration/db/migrations.test.ts
    - tests/integration/db/schema.test.ts
    - tests/integration/db/migration-hygiene.test.ts
    - tests/integration/fixtures/representative-data.ts
decisions:
  - "A stored credential_type that is not SSH on a server's credential is corrupt data: toServerCredentialType throws rather than projecting it onto a ServerView"
  - "DEP-08 column check excludes environment_id explicitly (it matches /env/ but is the ownership FK, not an env-vars column)"
  - "Environments' UNIQUE (id, project_id) is inline in CREATE TABLE, so it always precedes the composite FK statement"
metrics:
  duration: "~25 min"
  completed: 2026-09-29
  tasks: 3
  files: 23
---

# Phase 11 Plan 05: Deploy-engine schema and migration 0005 Summary

The deploy-engine schema is in migration 0005. The database now enforces the rules itself: a service cannot point at another project's environment (composite FK, 23503), a service can have only one non-terminal deployment (partial unique index, 23505), and a server or credential cannot be deleted while a service references it (RESTRICT, 23503). Every rule is tested against real PostgreSQL.

## What was built

- Five new schema modules. Every enum spreads its tuple from `@noodara/domain` (`DEPLOYMENT_STATUSES`, `SERVICE_STATUSES`, `SERVICE_SOURCE_TYPES`, ...). The partial index predicate is built from `NON_TERMINAL_DEPLOYMENT_STATUSES`.
- CHECK constraints `services_source_shape_check` (git and image shapes) and `services_ports_range_check`.
- Migration 0005 was generated with `drizzle-kit generate` and then hand-guarded:
  - `DO $$ ... duplicate_object` around every CREATE TYPE and ADD CONSTRAINT
  - `IF NOT EXISTS` on every table, index, ADD COLUMN and ADD VALUE
  - No `drizzle-kit push`.
- `migration-hygiene.test.ts` has two new rules: every ADD VALUE must use `IF NOT EXISTS`, and no statement in any migration may use a value added by ADD VALUE.

## Evidence: `pnpm db:migrate` against real PostgreSQL 16

Throwaway `postgres:16-alpine` container (`noodara-migrate-check`, port 55432, label `noodara.test=true`), fake env stand-ins, never the developer `.env`:

```
--- run 1
db:migrate completed in 104ms: 6 migration(s) applied, 6 total
--- run 2
db:migrate completed in 5ms: 0 migration(s) applied, 6 total
```

Run 1 applied 0000..0005 in the migrator's single transaction and did not hit `unsafe use of new value`. Afterwards `enum_range(null::credential_type)` = `{ssh_private_key,ssh_password,git_deploy_key,git_https_token,registry_password}`. The container was stopped, and `docker ps -aq --filter label=noodara.test=true` came back empty.

## Tests

- `vitest.integration.config.ts tests/integration/db`: 4 files, 118/118 passed (after GREEN). A new 0005 re-run idempotency test was added in Task 3; `migrations.test.ts` has 17/17 passing.
- `pnpm test` (unit): 209 files, 3821/3821 passed.
- `pnpm typecheck` 9/9, `pnpm lint` 10/10 successful.
- RED run before implementation: 32 failed for the right reasons: missing tables (42P01), missing column (42703), journal without 0005, and no ADD VALUE literals yet.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 3 - Blocking] Widened credential_type broke the SSH server services' types**
- **Found during:** Task 2
- **Issue:** `credentials.type` now infers five values. `server-view.ts`/`credential-store.ts` type server credentials as the 2-value SSH union, which caused 10 TS errors across connect-and-discover, edit-server, read-servers, trust-fingerprint and fail-in-flight-connection.
- **Fix:** Added `toServerCredentialType()` in `server-view.ts`. It narrows the type and throws on non-SSH types. I applied it at every DB read site, and `connect-and-discover` now builds a narrowed `CredentialRow` from credential-store. TDD: RED commit `4358a76`, GREEN in `aef2fae`. `server-view.test.ts` fixture gained `dockerBuildkitAvailable: null`.
- **Commits:** 4358a76, aef2fae

**2. [Rule 3 - Blocking] From-snapshot seed/fetch used the ORM for credentials**
- **Found during:** Task 1
- **Issue:** `seedRepresentativeData` and `fetchSeededSnapshot` read and wrote `credentials` through the ORM. The ORM would emit the new `public_key` column, which does not exist at snapshot 0004.
- **Fix:** Switched both to raw SQL limited to the 0004 columns. This follows the existing pattern for login_attempts and servers. The file is outside the plan's `files_modified`.
- **Commit:** 15cf70c

**3. Task 3 had no failing test to fix**
- The db suite passed on the first GREEN run. To give Task 3 a real proof, I added "re-executing every 0005 statement on a fully migrated database is a no-op". It shows the hand guards work, and it is a characterization test, not RED/GREEN.
- **Commit:** cc5fe33

**4. Plan wording vs. fixture:** the plan says the pre-existing credential row is `ssh_private_key`. The representative fixture actually seeds `ssh_password`. The assertion checks it is unchanged (`before.credential.type`, `'ssh_password'`).

## Threat Flags

None. No new network, auth or file surface. The T-11-12..T-11-15 mitigations are implemented and tested as planned.

## Known Stubs

None.

## Commits

- 15cf70c test(11-05): add failing deploy-engine schema ownership and migration tests
- 4358a76 test(11-05): add failing server credential type narrowing test
- aef2fae feat(11-05): add deploy-engine schema and migration 0005
- cc5fe33 test(11-05): prove migration 0005 from scratch and from snapshot 0004

## Self-Check: PASSED
