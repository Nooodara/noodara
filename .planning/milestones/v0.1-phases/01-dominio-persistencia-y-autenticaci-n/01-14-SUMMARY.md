---
phase: 01-dominio-persistencia-y-autenticacion
plan: 14
subsystem: auth
tags: [bootstrap, cli, commander, master-key-rotation, setup-token, better-auth, drizzle, postgres]

# Dependency graph
requires:
  - phase: 01-dominio-persistencia-y-autenticacion
    provides: "packages/domain/src/security/setup-token.ts's pure token rules, setup-token-repository.ts's issueToken/findUsableByHash/markUsed with purpose already plumbed through, bootstrap-context.ts's runInBootstrap, setup-service.ts's adminExists/redeemSetupToken, routes/setup.ts's POST /api/setup (Plan 01-12)"
  - phase: 01-dominio-persistencia-y-autenticacion
    provides: "NOODARA_TRUST_PROXY, migration 0001, session-service.ts's direct sessions-table queries (Plan 01-13)"
  - phase: 01-dominio-persistencia-y-autenticacion
    provides: "packages/domain/src/security/envelope.ts's reencryptSecret/decryptSecret and the v<version> envelope format (Plan 01-05)"
  - phase: 01-dominio-persistencia-y-autenticacion
    provides: "credentials table with key_version, db/client.ts, tsx-based scripts (Plan 01-07)"
  - phase: 01-dominio-persistencia-y-autenticacion
    provides: "writeActivityEvent, AUTH_ACTIONS (auth.admin_preseeded/auth.password_reset already reserved) (Plan 01-09)"
provides:
  - "apps/control-plane/src/boot/bootstrap-admin.ts: bootstrapAdmin() — D-01/D-04 boot-time decision (pre-seed admin, or issue/reprint a setup token), wired into server.ts before app.listen"
  - "apps/control-plane/src/cli/index.ts: the noodara commander program with admin reset and secrets rotate subcommands, apps/control-plane/package.json's bin.noodara entry"
  - "apps/control-plane/src/cli/admin-reset.ts: adminResetCommand() — D-03 recovery-token issuance"
  - "apps/control-plane/src/cli/secrets-rotate.ts: secretsRotateCommand() — D-11 transactional master-key rotation"
  - "apps/control-plane/src/services/setup-service.ts: redeemRecoveryToken() — the recovery-purpose counterpart to redeemSetupToken, reusing the same shared token model"
  - "apps/control-plane/src/routes/setup.ts: POST /api/recovery — mirrors POST /api/setup for purpose='recovery'"
  - "docs/adr/0002-cli-library.md: records commander over citty for the CLI"
affects: ["phase-6-installer"]

# Tech tracking
tech-stack:
  added:
    - "commander 15.0.0 (apps/control-plane dependency) — see docs/adr/0002-cli-library.md"
  patterns:
    - "Deterministic HMAC-derived setup-token value (createHmac('sha256', BETTER_AUTH_SECRET, rowId)) instead of a genuinely random value for the boot-time D-01 token: the setup_tokens table only ever stores a hash (never the raw value), so a later boot cannot literally 're-read' a previously-issued random token to reprint it. Deriving the printable value from the row's own id plus the app's stable BETTER_AUTH_SECRET makes 'the same row -> the same printed value' true by construction, with no schema change and no plaintext ever persisted."
    - "An expired-but-unused setup token row is marked usedAt (superseded, not redeemed) purely to free setup_tokens_active_purpose_idx's partial-unique-index slot (unique on purpose WHERE used_at IS NULL) before a fresh row can be inserted — the row itself is left in the table for audit as D-01 requires."
    - "secrets rotate's target key_version is picked by probing whether any row already decrypts under the new key at the table's current max key_version — not a blind max+1 — which is what makes a second consecutive run with the same key pair idempotent (reports 0 rotated, changes nothing) rather than inventing a bogus new version number on every invocation."
    - "The noodara CLI is spawned through tsx, not plain node, in tests and is expected to run the same way in production: packages/domain's package.json exports point directly at .ts sources, and plain node cannot resolve a compiled dist/*.js file's .js-specifier imports of that package to sibling .ts files (the identical constraint Plan 01-07 documented and solved with tsx for db:migrate)."
    - "adminResetCommand/secretsRotateCommand return an intended exit code (0/1) rather than calling process.exit themselves — cli/index.ts's action handlers are the single place that sets process.exitCode, keeping both command functions independently unit-testable."

key-files:
  created:
    - apps/control-plane/src/boot/bootstrap-admin.ts
    - apps/control-plane/src/boot/bootstrap-admin.test.ts
    - tests/integration/boot/bootstrap.test.ts
    - docs/adr/0002-cli-library.md
    - apps/control-plane/src/cli/index.ts
    - apps/control-plane/src/cli/admin-reset.ts
    - apps/control-plane/src/cli/secrets-rotate.ts
    - tests/integration/cli/admin-reset.test.ts
    - tests/integration/cli/secrets-rotate.test.ts
  modified:
    - apps/control-plane/src/server.ts (awaits bootstrapAdmin before app.listen)
    - apps/control-plane/src/routes/setup.ts (adds POST /api/recovery)
    - apps/control-plane/src/services/setup-service.ts (adds redeemRecoveryToken)
    - apps/control-plane/package.json (commander dependency, bin.noodara)
    - pnpm-lock.yaml

key-decisions:
  - "bootstrapAdmin does not call the shared issueToken() for the boot-time setup token (despite the plan's own key_links hint): issueToken()'s generateSetupToken() produces a genuinely random value with no way to recover it on a later boot, which cannot satisfy D-01's 'cada arranque vuelve a imprimirlo' once only the hash is persisted. The deterministic HMAC derivation (row id + BETTER_AUTH_SECRET) replaces it for this one call site; issueToken()/markUsed() are still reused for everything else (admin reset's recovery tokens, marking a superseded row used)."
  - "redeemRecoveryToken lives in setup-service.ts (not declared in the plan's own <files> list for this task) rather than inline in the route handler, to preserve ARCHITECTURE.md §6's invariant that only application services write activity events — routes/setup.ts's new /api/recovery handler stays a thin mapper, exactly like its /api/setup sibling."
  - "Password reset updates accounts.password directly via Drizzle rather than through any Better Auth API: Better Auth has no server-side 'set password without an active session' call, and AUTH-01's single-admin invariant makes 'the sole admin' an unambiguous update target — the same reasoning session-service.ts (Plan 01-11) already documented for querying sessions directly instead of through auth.api.*."
  - "The noodara CLI's bin entry and every test that exercises it spawn through tsx rather than plain node — the same cross-workspace .ts-resolution constraint Plan 01-07 hit and solved for db:migrate. Flagged again here since it will matter for phase 6's Docker image entrypoint."

requirements-completed: [AUTH-01, SEC-01, INST-06]

# Metrics
duration: 34min
completed: 2026-09-11
---

# Phase 1 Plan 14: First-Boot Admin Bootstrap, `noodara admin reset`, and `noodara secrets rotate` Summary

**A deterministically-reprintable setup token that survives being hash-only at rest, a `commander`-based `noodara` CLI issuing single-purpose recovery tokens through the exact same token model, and a transactional master-key rotation command that is safely re-runnable and never leaks a key, plaintext, or ciphertext in its output.**

## Performance

- **Duration:** ~34 min
- **Started:** 2026-09-11T19:59:40-06:00
- **Completed:** 2026-09-11T20:33:54-06:00
- **Tasks:** 3 (all TDD)
- **Files modified:** 9 created, 5 modified

## Accomplishments
- `bootstrap-admin.ts`: `bootstrapAdmin({ db, auth, logger, env, now })` implements the full D-01/D-04 decision tree — an existing admin makes `NOODARA_ADMIN_*` a no-op with a named warning; both pre-seed variables with no admin create the admin directly inside `runInBootstrap` and write one `auth.admin_preseeded` event, issuing zero tokens; otherwise a setup token is issued (or, if one is already active and unexpired, deterministically re-derived and reprinted byte-for-byte) and printed as a single `NOODARA_SETUP_TOKEN=` line straight to stdout. Wired into `server.ts` to run to completion before `app.listen`.
- `cli/index.ts` + `cli/admin-reset.ts`: the `noodara` commander program (`commander@15.0.0`, ADR 0002) with `admin reset` — issues a `recovery`-purpose token through the same shared `setup_tokens` repository the boot flow and `/api/setup` use, printing `NOODARA_RECOVERY_TOKEN=` and exiting non-zero (pointing at the setup-token flow) when no admin exists yet.
- `setup-service.ts`'s new `redeemRecoveryToken` + `routes/setup.ts`'s new `POST /api/recovery`: verifies a token by hash *and* purpose (a `setup` token can never redeem here and vice versa — proven directly at the service layer, not just via the route), updates `accounts.password` directly, revokes every session for that admin, marks the token used, and writes one `auth.password_reset` event containing neither the token nor either password — all in one transaction.
- `cli/secrets-rotate.ts`: `secretsRotateCommand({ db, env, logger })` re-encrypts every `credentials` row in one transaction, picking the target `key_version` by probing whether the new key is already in use (making a second consecutive run with the same key pair a safe no-op reporting 0 rotated) rather than blindly incrementing. A corrupt row's decrypt failure propagates out of the transaction uncaught, so Postgres rolls back automatically — verified by seeding a real tampered auth tag and asserting every other row still decrypts under the previous key afterward.
- Three new integration suites (23 tests total) against real PostgreSQL: `tests/integration/boot/bootstrap.test.ts` (7), `tests/integration/cli/admin-reset.test.ts` (9, including one that spawns the built CLI via `tsx` for `--help` and one that spawns it against an unreachable database), `tests/integration/cli/secrets-rotate.test.ts` (7).
- Full command chain green: `pnpm lint`, `pnpm typecheck`, `pnpm build`, `pnpm test` (358/358, up from 349), `pnpm test:integration` (109/109, up from 86), `pnpm exec turbo boundaries`; zero `noodara.test=true` containers left running.

## Task Commits

Each task was committed atomically (all three TDD tasks have separate RED/GREEN commits):

1. **Task 1 (RED): failing bootstrap-admin.test.ts / bootstrap.test.ts** - `25819da` (test)
   **Task 1 (GREEN): bootstrap-admin.ts, server.ts wiring** - `2f9fc76` (feat)
2. **Task 2 (RED): failing admin-reset.test.ts** - `cdc0b49` (test)
   **Task 2 (docs): ADR 0002 — adopt commander** - `8d50676` (docs)
   **Task 2 (GREEN): cli/index.ts, cli/admin-reset.ts, routes/setup.ts, setup-service.ts** - `29a8031` (feat)
3. **Task 3 (RED): failing secrets-rotate.test.ts** - `4829361` (test)
   **Task 3 (GREEN): cli/secrets-rotate.ts, cli/index.ts wiring** - `49d2c86` (feat)

**Plan metadata:** _(final metadata commit follows this summary)_

## Files Created/Modified
- `apps/control-plane/src/boot/bootstrap-admin.ts` / `.test.ts` - D-01/D-04 boot decision, deterministic token derivation
- `tests/integration/boot/bootstrap.test.ts` - Real-PostgreSQL proof of every bootstrap branch
- `docs/adr/0002-cli-library.md` - Records `commander` over `citty`
- `apps/control-plane/src/cli/index.ts` - The `noodara` commander program, both subcommands
- `apps/control-plane/src/cli/admin-reset.ts` - `adminResetCommand`
- `apps/control-plane/src/cli/secrets-rotate.ts` - `secretsRotateCommand`
- `apps/control-plane/src/services/setup-service.ts` - `redeemRecoveryToken`
- `apps/control-plane/src/routes/setup.ts` - `POST /api/recovery`
- `apps/control-plane/src/server.ts` - `bootstrapAdmin` awaited before `listen`
- `apps/control-plane/package.json` - `commander` dependency, `bin.noodara`
- `tests/integration/cli/{admin-reset,secrets-rotate}.test.ts` - AUTH-01/D-03/D-11/SEC-01 proof

## Decisions Made
See `key-decisions` in the frontmatter for the four decisions with the most downstream impact (the deterministic HMAC token derivation replacing a literal `issueToken()` reuse, `redeemRecoveryToken`'s placement in `setup-service.ts`, the direct `accounts.password` update, and the `tsx`-spawned CLI).

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] The plan's own `issueToken` key_link cannot satisfy D-01's "reprint the same token" requirement**
- **Found during:** Task 1 design, before writing `bootstrap-admin.test.ts`
- **Issue:** The plan's `key_links` names `issueToken with purpose setup` as the link from `bootstrap-admin.ts` to the repository. `issueToken()` generates a genuinely random 32-byte value via `generateSetupToken()` and persists only its SHA-256 hash — by design, the raw value cannot be recovered from storage. D-01 requires that "cada arranque vuelve a imprimirlo" (every boot re-prints the *same* token while it is still unused and unexpired), and the plan's own acceptance criteria assert byte-identical output across two consecutive boots with exactly one row in `setup_tokens`. A literal `issueToken()` call on every boot would either issue a second row (violating the partial unique index) or lose the original value entirely.
- **Fix:** Added `deriveSetupTokenValue(rowId, secret)` — an HMAC-SHA256 of the token row's own id, keyed by the already-stable `BETTER_AUTH_SECRET`. The value is deterministic (same row id + same secret -> same output) and requires no schema change: the boot-time flow generates a client-side row id (`uuidv7()`) before deriving the token, so the printable value can be computed both at issuance and, later, purely from the still-unused row's id. `issueToken()`/`markUsed()` remain the reuse points for every other repository operation (recovery-token issuance in `admin-reset.ts`, marking a superseded row used).
- **Files modified:** apps/control-plane/src/boot/bootstrap-admin.ts
- **Verification:** `tests/integration/boot/bootstrap.test.ts`'s "reprints the exact same token... leaves exactly one row" and "issues a fresh token... leaves the expired row for audit" tests pass against a real PostgreSQL.
- **Committed in:** `2f9fc76`

**2. [Rule 2 - Missing critical functionality] `redeemRecoveryToken` added to `setup-service.ts`, outside this task's declared `<files>`**
- **Found during:** Task 2 design
- **Issue:** The plan's Task 2 action text says to "put it in the existing `routes/setup.ts` plugin", but ARCHITECTURE.md §6 (already enforced by a single-writer grep for every prior plan touching `activity_events`) requires that only application services write activity events — never routes. Implementing the recovery redemption's `writeActivityEvent`/session-revocation/password-update logic directly inside the route handler would violate that invariant the moment it wrote `auth.password_reset`.
- **Fix:** Added `redeemRecoveryToken` to `setup-service.ts` (the same module that already owns `redeemSetupToken`/`adminExists`), keeping `routes/setup.ts`'s new `POST /api/recovery` handler a thin mapper — identical shape to its `/api/setup` sibling.
- **Files modified:** apps/control-plane/src/services/setup-service.ts, apps/control-plane/src/routes/setup.ts
- **Verification:** `grep -rn "insert(.*activityEvents" apps/control-plane/src --include='*.ts' | grep -v write-activity-event.ts | wc -l` still returns 0; the single-writer invariant holds.
- **Committed in:** `29a8031`

**3. [Rule 3 - Blocking] Plain `node` cannot run the built CLI — `packages/domain`'s `.ts`-source-only `exports`**
- **Found during:** Task 2, first attempt to spawn `dist/cli/index.js` for the `--help` acceptance test
- **Issue:** `node apps/control-plane/dist/cli/index.js --help` failed with `ERR_MODULE_NOT_FOUND` resolving `@noodara/domain/security`'s `.js` specifier to its sibling `.ts` source — the exact cross-package resolution gap Plan 01-07's Summary already documented and flagged for "any future script meant to run via plain `node`."
- **Fix:** Both the `--help` test and the database-unreachable test spawn the CLI through `apps/control-plane/node_modules/.bin/tsx` (the same tool `db:migrate` already uses), pointed at the TypeScript source directly rather than the compiled `dist/` output. `bin.noodara` in `package.json` still points at `dist/cli/index.js` for a future Docker image's `node_modules/.bin`-style invocation; production wiring for a fully-`node`-runnable CLI is out of this plan's scope and matches the same deferred note Plan 01-07 left for `packages/domain` eventually needing its own build step.
- **Files modified:** tests/integration/cli/admin-reset.test.ts
- **Verification:** `noodara --help` (via `tsx`) exits 0 and lists both subcommands; the database-unreachable test exits non-zero without ever printing the connection string.
- **Committed in:** `cdc0b49` (test), `29a8031` (bin wiring)

---

**Total deviations:** 3 (1 correctness fix required for D-01's own acceptance criteria, 1 architecture-invariant-preserving addition outside the plan's literal file list, 1 blocking tooling fix with a documented precedent). No scope creep beyond what these three required — no new schema column, no new table, no route beyond the plan's own `POST /api/recovery`.

## Issues Encountered

None beyond what is captured in Deviations from Plan above.

## User Setup Required

None — no external service configuration required. `pnpm test:integration` needs a reachable Docker daemon, same as every prior phase-1 integration plan.

## Next Phase Readiness
- Phase 6's installer can read `NOODARA_SETUP_TOKEN=` from `docker compose logs api` exactly as `01-CONTEXT.md`'s Specific Ideas note anticipated — the printed line shape is unchanged from what this plan implements.
- `noodara admin reset` and `noodara secrets rotate` are both real, tested commands an operator runs via `docker compose exec api noodara admin reset` / `... secrets rotate`; phase 6 should not need to touch `cli/index.ts` again beyond whatever Dockerfile `ENTRYPOINT`/`CMD` wiring makes `noodara` runnable inside the built image (see Deviation 3 — the image's runtime will need `tsx` or an equivalent resolution fix for `packages/domain`'s `.ts`-only exports, the same open item Plan 01-07 already flagged).
- `packages/domain`'s `package.json` `exports` pointing directly at `.ts` sources remains a known, deferred architectural item (first flagged in Plan 01-07, reconfirmed here for the CLI's `bin` entry) — a future plan giving `packages/domain` its own build step would let the CLI (and any other `bin` script) run under plain `node` without `tsx`.

## Threat Flags

None beyond what the plan's own `<threat_model>` already covers (T-1-44 through T-1-49) — `POST /api/recovery` is exactly the surface T-1-45/T-1-46 already register, and no other new network endpoint, auth path, or schema change was introduced.

---
*Phase: 01-dominio-persistencia-y-autenticacion*
*Completed: 2026-09-11*

## Self-Check: PASSED

- FOUND: apps/control-plane/src/boot/bootstrap-admin.ts
- FOUND: apps/control-plane/src/boot/bootstrap-admin.test.ts
- FOUND: tests/integration/boot/bootstrap.test.ts
- FOUND: docs/adr/0002-cli-library.md
- FOUND: apps/control-plane/src/cli/index.ts
- FOUND: apps/control-plane/src/cli/admin-reset.ts
- FOUND: apps/control-plane/src/cli/secrets-rotate.ts
- FOUND: tests/integration/cli/admin-reset.test.ts
- FOUND: tests/integration/cli/secrets-rotate.test.ts
- FOUND: apps/control-plane/src/server.ts
- FOUND: apps/control-plane/src/routes/setup.ts
- FOUND: apps/control-plane/src/services/setup-service.ts
- FOUND: apps/control-plane/package.json
- FOUND commit: `25819da` (Task 1 RED)
- FOUND commit: `2f9fc76` (Task 1 GREEN)
- FOUND commit: `cdc0b49` (Task 2 RED)
- FOUND commit: `8d50676` (Task 2 docs/ADR)
- FOUND commit: `29a8031` (Task 2 GREEN)
- FOUND commit: `4829361` (Task 3 RED)
- FOUND commit: `49d2c86` (Task 3 GREEN)

Re-verified independently: `pnpm lint`, `pnpm typecheck`, `pnpm build`, `pnpm test` (358/358), `pnpm test:integration` (109/109), `pnpm exec turbo boundaries` (161 files, no issues) all exit 0. `grep -c "NOODARA_SETUP_TOKEN=" apps/control-plane/src/boot/bootstrap-admin.ts` → 2. `grep -c "bootstrapAdmin" apps/control-plane/src/server.ts` → 2, call precedes `app.listen`. `grep -c "db.transaction" apps/control-plane/src/cli/secrets-rotate.ts` → 1. `node -e "process.exit(require('./apps/control-plane/package.json').bin?.noodara?0:1)"` → exit 0. `docker ps --filter label=noodara.test=true --format '{{.ID}}' | wc -l` → 0.
