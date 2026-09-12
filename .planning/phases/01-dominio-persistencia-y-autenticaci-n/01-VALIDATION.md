---
phase: 1
slug: dominio-persistencia-y-autenticaci-n
status: complete
nyquist_compliant: true
wave_0_complete: true
created: 2026-09-10
completed: 2026-09-12
---

# Phase 1 — Validation Strategy

> Per-phase validation contract for feedback sampling during execution.

---

## Test Infrastructure

| Property | Value |
|----------|-------|
| **Framework** | Vitest 5.0.0 |
| **Config file** | `vitest.config.ts` (unit — `root`/`packages`/`apps` projects, `packages/domain/**` coverage threshold 95% statements/branches) and `vitest.integration.config.ts` (Testcontainers, `fileParallelism: false`, `testTimeout: 120_000`) |
| **Quick run command** | `pnpm test` (358 tests, unit only, no Docker) |
| **Full suite command** | `pnpm test:integration` (109 tests, Testcontainers PostgreSQL) |
| **Estimated runtime** | ~0.5s unit (`pnpm test`), ~137s integration (`pnpm test:integration`) |

---

## Sampling Rate

- **After every task commit:** `pnpm test` (0.5s — fast feedback, no Docker needed)
- **After every plan wave:** `pnpm test:integration` (~137s — full suite including Testcontainers)
- **Before `/gsd:verify-work`:** `pnpm lint && pnpm typecheck && pnpm exec turbo boundaries && pnpm test --coverage && pnpm test:integration && pnpm audit --audit-level=high` must all exit 0
- **Max feedback latency:** ~0.5s (unit, per-task) / ~137s (integration, per-wave)

---

## Per-Task Verification Map

| Task ID | Plan | Wave | Requirement | Threat Ref | Secure Behavior | Test Type | Automated Command | File Exists | Status |
|---------|------|------|-------------|------------|-----------------|-----------|-------------------|-------------|--------|
| 1-01-01 | 01 | 1 | QA-01 | T-1-01 / T-1-02 | Every pinned npm package flagged `[SUS]`/`[ASSUMED]` by slopcheck resolves its registry `repository.url` to the expected owner/repo before install (exact match, never substring) | unit/script | `node scripts/check-package-provenance.mjs && test -f docs/adr/0000-package-legitimacy-approvals.md && grep -c "@fastify/type-provider-zod" docs/adr/0000-package-legitimacy-approvals.md && test ! -f package.json && test ! -f pnpm-lock.yaml` | ✅ | ✅ green (historical — asserted no `package.json`/lockfile existed yet, true at execution time; superseded by 01-02) |
| 1-02-01 | 02 | 2 | QA-02 | T-1-02 / T-1-03 | Root pnpm workspace + Turborepo boundaries enforce `packages/domain` purity from the first commit | build/lint/typecheck | `pnpm install --frozen-lockfile=false && pnpm lint && pnpm typecheck && pnpm exec turbo boundaries` | ✅ | ✅ green |
| 1-02-02 | 02 | 2 | QA-02 | T-1-02 / T-1-03 | Vitest coverage gate reports `packages/domain` separately from other packages/apps | unit | `pnpm test && pnpm exec vitest run --coverage 2>&1 \| grep -q "packages/domain"` | ✅ | ✅ green |
| 1-02-03 | 02 | 2 | QA-02 | T-1-02 / T-1-03 | `packages/domain` module skeleton stays pure (zero I/O) per the Turborepo boundary rule | unit | `pnpm test && pnpm typecheck && pnpm exec turbo boundaries` | ✅ | ✅ green |
| 1-03-01 | 03 | 3 | INST-06 | T-1-04 / T-1-06 | `apps/control-plane` scaffold typechecks and lints against the shared config package | typecheck/lint | `pnpm --filter @noodara/control-plane typecheck && pnpm --filter @noodara/control-plane lint` | ✅ | ✅ green |
| 1-03-02 | 03 | 3 | INST-06 | T-1-04 / T-1-05 | Boot exits non-zero when `NOODARA_MASTER_KEY`/session secret/DB password is missing, weak, or a known placeholder — no `.default()` anywhere in the env schema | unit | `pnpm exec vitest run apps/control-plane/src/env.test.ts` | ✅ | ✅ green |
| 1-03-03 | 03 | 3 | INST-06 | T-1-05 / T-1-06 | pino `redact` covers `req.body.password`/`req.headers.cookie`; D-12 boot-time key-fingerprint backup warning never logs the key itself | unit | `pnpm exec vitest run apps/control-plane/src/logger.test.ts apps/control-plane/src/boot/master-key.test.ts` | ✅ | ✅ green |
| 1-04-01 | 04 | 3 | SERV-05, QA-02 | T-1-07 / T-1-08 | Exhaustive cross-product of the 6-state Server machine: every valid transition succeeds, every invalid one throws | unit | `pnpm exec vitest run packages/domain/src/server/server-state.test.ts --coverage` | ✅ | ✅ green |
| 1-04-02 | 04 | 3 | SERV-05, QA-02 | T-1-07 / T-1-08 | Connection-result → status mapping never silently drops a pending/fingerprint-mismatch case | unit | `pnpm exec vitest run packages/domain/src/server/connection-result.test.ts --coverage` | ✅ | ✅ green |
| 1-05-01 | 05 | 3 | SEC-01, QA-02 | T-1-09 / T-1-12 | `SecretValue` never serializes its raw value via `toJSON`/`toString`/`util.inspect`; `Redactor` catches AWS/generic key shapes | unit | `pnpm exec vitest run packages/domain/src/security/secret-value.test.ts packages/domain/src/security/redactor.test.ts --coverage` | ✅ | ✅ green |
| 1-05-02 | 05 | 3 | SEC-01, QA-02 | T-1-09 / T-1-12 | AES-256-GCM envelope: correct roundtrip, tamper detection on ciphertext/tag, wrong-key rejection, unique nonces per encryption, `key_version` recorded per row | unit | `pnpm exec vitest run packages/domain/src/security/envelope.test.ts --coverage` | ✅ | ✅ green |
| 1-06-01 | 06 | 3 | SERV-05, AUTH-02, QA-02 | T-1-13 / T-1-15 | Host/port/identity validators reject malformed input before it reaches storage or a shell | unit | `pnpm exec vitest run packages/domain/src/validators/network.test.ts packages/domain/src/validators/identity.test.ts --coverage` | ✅ | ✅ green |
| 1-06-02 | 06 | 3 | AUTH-02, AUTH-04, QA-02 | T-1-13 / T-1-15 | Admin password policy rejects common/weak passwords; `ActivityEvent` domain type has no field that can carry a raw password | unit | `pnpm exec vitest run packages/domain/src/validators/password.test.ts packages/domain/src/activity/activity-event.test.ts --coverage` | ✅ | ✅ green |
| 1-07-01 | 07 | 4 | QA-06, SERV-05, SEC-01, AUTH-01, AUTH-04, AUTH-05 | T-1-16 / T-1-19 | Drizzle schema for the full phase-1 data model typechecks and lints | typecheck/lint | `pnpm --filter @noodara/control-plane typecheck && pnpm --filter @noodara/control-plane lint` | ✅ | ✅ green |
| 1-07-02 | 07 | 4 | QA-06 | T-1-16 / T-1-19 | [BLOCKING] Initial migration applies from scratch against a real PostgreSQL and is idempotent on immediate re-run | integration | `docker compose -f docker-compose.dev.yml up -d postgres && pnpm db:migrate && pnpm db:migrate && docker compose -f docker-compose.dev.yml exec -T postgres psql -U noodara -d noodara -c "\dt" \| grep -c "servers"` | ✅ | ✅ green (re-verified live in 01-15 Task 2 against a fresh Compose Postgres: fresh run applied 2/2 migrations, immediate re-run applied 0/2, both exit 0) |
| 1-07-03 | 07 | 4 | QA-06 | T-1-16 / T-1-19 | Testcontainers integration harness boots a real ephemeral PostgreSQL, not a mock | integration | `pnpm test:integration` | ✅ | ✅ green |
| 1-08-01 | 08 | 5 | QA-06 | T-1-20 / T-1-21 | Journal-driven migration helper applies every migration from an empty database | integration | `pnpm exec vitest run --config vitest.integration.config.ts tests/integration/db/migrations.test.ts` | ✅ | ✅ green |
| 1-08-02 | 08 | 5 | QA-06 | T-1-20 / T-1-21 | Migrations apply cleanly from the previous snapshot against representative data; `IF EXISTS`/`IF NOT EXISTS` defensiveness guard enforced | integration | `pnpm test:integration` | ✅ | ✅ green |
| 1-09-01 | 09 | 5 | AUTH-04 | T-1-22 / T-1-24 | `writeActivityEvent`'s `toLogSafe` mapper strips password/secret fields before persistence | unit | `pnpm exec vitest run apps/control-plane/src/activity/write-activity-event.test.ts` | ✅ | ✅ green |
| 1-09-02 | 09 | 5 | AUTH-04 | T-1-22 / T-1-24 | Canary proof: a runtime secret leaks through none of the logger, an HTTP error body, or the activity log (phase-1 subset of the noodara-security §9 flow-driven scan) | integration | `pnpm exec vitest run --config vitest.integration.config.ts tests/integration/activity` | ✅ | ✅ green |
| 1-10-01 | 10 | 5 | AUTH-02 | T-1-25 / T-1-29 | Argon2id login succeeds, session persists across a new request with the same cookie; logout invalidates the session server-side | unit + integration | `pnpm exec vitest run apps/control-plane/src/auth/password-hasher.test.ts && pnpm exec vitest run --config vitest.integration.config.ts tests/integration/auth/login.test.ts tests/integration/auth/logout.test.ts` | ✅ | ✅ green |
| 1-10-02 | 10 | 5 | AUTH-05 | T-1-25 / T-1-29 | Cookie flags `HttpOnly`/`Secure`/`SameSite=Lax`; session id rotates on every login | integration | `pnpm exec vitest run --config vitest.integration.config.ts tests/integration/auth/cookies.test.ts` | ✅ | ✅ green |
| 1-11-01 | 11 | 6 | AUTH-05 | T-1-30 / T-1-33 | Sliding 7-day session with a hard 30-day ceiling; `updateAge` never extends past the cap | unit + integration | `pnpm exec vitest run apps/control-plane/src/auth/session-policy.test.ts && pnpm exec vitest run --config vitest.integration.config.ts tests/integration/auth/session-lifetime.test.ts` | ✅ | ✅ green |
| 1-11-02 | 11 | 6 | AUTH-03 | T-1-30 / T-1-33 | Session listing/revocation endpoints let the admin invalidate any listed session server-side | integration | `pnpm exec vitest run --config vitest.integration.config.ts tests/integration/auth/session-management.test.ts` | ✅ | ✅ green |
| 1-12-01 | 12 | 6 | AUTH-01 | T-1-34 / T-1-38 | Setup token: single-use, 24h expiry, pure hash/expiry logic has no I/O | unit | `pnpm exec vitest run packages/domain/src/security/setup-token.test.ts --coverage` | ✅ | ✅ green |
| 1-12-02 | 12 | 6 | AUTH-01 | T-1-34 / T-1-38 | Transactional token redemption via `POST /api/setup`; the sign-up route 404s once an admin exists, even under a redemption race | integration | `pnpm exec vitest run --config vitest.integration.config.ts tests/integration/auth/setup.test.ts tests/integration/auth/setup-race.test.ts` | ✅ | ✅ green |
| 1-13-01 | 13 | 6 | AUTH-04 | T-1-39 / T-1-43 | Progressive-backoff arithmetic (5 fails/15min, doubling up to 24h) is pure and independently testable | unit | `pnpm exec vitest run packages/domain/src/security/login-backoff.test.ts --coverage` | ✅ | ✅ green |
| 1-13-02 | 13 | 6 | AUTH-04 | T-1-39 / T-1-43 | Independent per-IP and per-account lockout counters enforced around Better Auth's sign-in; failures logged to the activity log without the password | integration | `pnpm exec vitest run --config vitest.integration.config.ts tests/integration/auth/rate-limit.test.ts` | ✅ | ✅ green |
| 1-14-01 | 14 | 7 | AUTH-01, INST-06 | T-1-44 / T-1-49 | First-boot admin bootstrap (env pre-seed or setup token) runs before `app.listen`, never both paths silently | unit + integration | `pnpm exec vitest run apps/control-plane/src/boot/bootstrap-admin.test.ts && pnpm exec vitest run --config vitest.integration.config.ts tests/integration/boot/bootstrap.test.ts` | ✅ | ✅ green |
| 1-14-02 | 14 | 7 | AUTH-01 | T-1-44 / T-1-49 | `noodara admin reset` CLI issues a recovery path without ever printing/logging the new credential in plaintext | integration | `pnpm exec vitest run --config vitest.integration.config.ts tests/integration/cli/admin-reset.test.ts` | ✅ | ✅ green |
| 1-14-03 | 14 | 7 | SEC-01 | T-1-44 / T-1-49 | `noodara secrets rotate` re-encrypts every credential under a new `key_version` inside one transaction; no row left half-migrated on failure | integration | `pnpm exec vitest run --config vitest.integration.config.ts tests/integration/cli/secrets-rotate.test.ts` | ✅ | ✅ green |
| 1-15-01 | 15 | 8 | QA-01 | T-1-50 / T-1-53 | Six required CI jobs (lint, typecheck, unit, integration, security, boundaries) run the same pnpm scripts as local dev; no `continue-on-error`, no placeholder `e2e` job | static/CI | `actionlint .github/workflows/ci.yml && pnpm security:scan-leaks` | ✅ | ✅ green |
| 1-15-02 | 15 | 8 | QA-01, QA-02 | T-1-50 / T-1-53 | Whole phase green in one pass; validation contract records real commands and coverage | full suite | `pnpm lint && pnpm typecheck && pnpm exec turbo boundaries && pnpm test --coverage && pnpm test:integration && pnpm audit --audit-level=high` | ✅ | ✅ green |

*Status: ⬜ pending · ✅ green · ❌ red · ⚠️ flaky*

*33/33 tasks green. Zero `.skip`/`.todo` in `tests/`, `packages/`, `apps/` (`grep -rc "\.skip\|\.todo" tests/ packages/ apps/ \| grep -v ':0' \| wc -l` → `0`).*

---

## Wave 0 Requirements

Wave 0 (no pre-existing test infrastructure — this was Wave 0 for the entire project) is complete:

- [x] Root `package.json`, `pnpm-workspace.yaml`, `turbo.json` — created in Plan 01-02
- [x] `vitest.config.ts` at root using the `projects` key (not the deprecated `workspace` key), with `coverage.thresholds` glob-scoped to `packages/domain/**` (statements/branches ≥95%) — created in Plan 01-02, extended in 01-03 with the `apps` project's fail-fast env fixture block
- [x] `vitest.integration.config.ts` wiring Testcontainers (`fileParallelism: false`, 120s timeouts) — created in Plan 01-02, exercised first in Plan 01-07
- [x] `packages/config` (shared tsconfig/eslint/prettier) — created in Plan 01-02
- [x] Testcontainers PostgreSQL harness (`tests/integration/helpers/postgres.ts`, `postgres:17-alpine`) — created in Plan 01-07, extended in 01-08 with the `{ migrate: false }` from-snapshot option
- [x] `.github/workflows/ci.yml` (lint, typecheck, unit, integration, security, boundaries) — created in this plan (01-15)

---

## Manual-Only Verifications

None. The plan anticipated a manual human-verify step for npm package-legitimacy confirmation (Plan 01-01), but 01-01 automated it entirely: `scripts/check-package-provenance.mjs` resolves each flagged package's registry `repository.url` and exact-matches it against a hardcoded expected `owner/repo` table, exiting 1 on any mismatch. The script's self-test (temporarily corrupting the expected `vitest` org and confirming a non-zero exit, then reverting) is part of Plan 01-01's own commit history, not a manual step repeated per run.

All phase behaviors have automated verification.

---

## Requirement → Proof Index

| Requirement | Proven By |
|-------------|-----------|
| INST-06 | `pnpm exec vitest run apps/control-plane/src/env.test.ts` (Plan 01-03 Task 2); reinforced by `tests/integration/boot/bootstrap.test.ts` (Plan 01-14 Task 1) |
| AUTH-01 | `pnpm exec vitest run --config vitest.integration.config.ts tests/integration/auth/setup.test.ts tests/integration/auth/setup-race.test.ts` (Plan 01-12 Task 2); bootstrap path in `tests/integration/boot/bootstrap.test.ts` (Plan 01-14 Task 1) |
| AUTH-02 | `pnpm exec vitest run --config vitest.integration.config.ts tests/integration/auth/login.test.ts` (Plan 01-10 Task 1) |
| AUTH-03 | `pnpm exec vitest run --config vitest.integration.config.ts tests/integration/auth/logout.test.ts` (Plan 01-10 Task 1); `tests/integration/auth/session-management.test.ts` (Plan 01-11 Task 2) |
| AUTH-04 | `pnpm exec vitest run packages/domain/src/security/login-backoff.test.ts --coverage` (Plan 01-13 Task 1) + `tests/integration/auth/rate-limit.test.ts` (Plan 01-13 Task 2) |
| AUTH-05 | `pnpm exec vitest run --config vitest.integration.config.ts tests/integration/auth/cookies.test.ts` (Plan 01-10 Task 2); `tests/integration/auth/session-lifetime.test.ts` (Plan 01-11 Task 1) |
| SERV-05 | `pnpm exec vitest run packages/domain/src/server/server-state.test.ts --coverage` (Plan 01-04 Task 1) |
| SEC-01 | `pnpm exec vitest run packages/domain/src/security/envelope.test.ts --coverage` (Plan 01-05 Task 2); `tests/integration/cli/secrets-rotate.test.ts` (Plan 01-14 Task 3) |
| QA-01 | `.github/workflows/ci.yml` (Plan 01-15 Task 1) — six required jobs run `pnpm lint`/`pnpm typecheck`/`pnpm test --coverage`/`pnpm test:integration`/`pnpm audit --audit-level=high` + gitleaks/`pnpm boundaries`, no `continue-on-error` |
| QA-02 | `pnpm test --coverage` against the `packages/domain/**` glob threshold in `vitest.config.ts` (Plan 01-02 Task 2); measured green at 100% statements/branches across every `packages/domain/src/**` file as of Plan 01-15 Task 2 |
| QA-06 | `pnpm exec vitest run --config vitest.integration.config.ts tests/integration/db/migrations.test.ts tests/integration/db/migration-hygiene.test.ts` (Plan 01-08); `pnpm db:migrate` run twice against a fresh Compose PostgreSQL in Plan 01-15 Task 2 (2/2 applied, then 0/2 on immediate re-run, both exit 0) |

---

## Validation Sign-Off

- [x] All tasks have `<automated>` verify or Wave 0 dependencies — 33/33 tasks
- [x] Sampling continuity: no 3 consecutive tasks without automated verify — every task has one
- [x] Wave 0 covers all MISSING references — see Wave 0 Requirements above, all checked
- [x] No watch-mode flags in any test config (`vitest.config.ts`, `vitest.integration.config.ts` — neither sets `watch: true`; the only `--watch` flag in the repo is `apps/control-plane`'s `dev` script, a Node dev-server convenience unrelated to test execution)
- [x] Feedback latency < 1s for the per-task quick command (`pnpm test` measured at ~0.5s for 358 tests)
- [x] `nyquist_compliant: true` set in frontmatter

**Approval:** approved 2026-09-12

### Full-Phase Green Run (2026-09-12)

| Command | Result |
|---------|--------|
| `pnpm install --frozen-lockfile` | exit 0 |
| `pnpm lint` | exit 0 |
| `pnpm typecheck` | exit 0 |
| `pnpm exec turbo boundaries` (`pnpm boundaries`) | exit 0 — 161 files checked, no issues |
| `pnpm test --coverage` | exit 0 — 358/358 tests, `packages/domain` at 100% statements/100% branches (threshold: ≥95%/≥95%) |
| `pnpm test:integration` | exit 0 — 109/109 tests, ~137s, zero `noodara.test=true` containers left running afterward |
| `pnpm audit --audit-level=high` | exit 0 — 1 moderate advisory found, 0 high/critical (does not trip `--audit-level=high`) |
| `pnpm db:migrate` (fresh Compose PostgreSQL, then immediate re-run) | exit 0 both times — 2/2 migrations applied fresh, 0/2 applied on re-run |
| `pnpm security:scan-leaks` | exit 0 |
| `gitleaks detect --config .gitleaks.toml` (local binary, path-scoped allowlist) | 0 findings against tracked files |
