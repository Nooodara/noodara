---
phase: 01-dominio-persistencia-y-autenticacion
verified: 2026-09-12T06:27:27Z
status: human_needed
score: 6/6 must-haves verified
overrides_applied: 0
re_verification:
  previous_status: gaps_found
  previous_score: 5/6
  gaps_closed:
    - "El control plane arranca (roadmap goal / SC1) — pnpm dev and pnpm build && pnpm start now boot the process for real under plain Node, via the project's own documented commands"
  gaps_remaining: []
  regressions: []
human_verification:
  - test: "Push noodara/code as the root of its own git repository and let the real GitHub Actions workflow (.github/workflows/ci.yml, now 7 jobs incl. boot-smoke) run against a PR."
    expected: "lint, typecheck, boundaries, unit (coverage), integration (Testcontainers on the hosted runner), security (audit + security:scan-leaks + gitleaks diff scan), and boot-smoke (pnpm build + pnpm test:boot) all pass; a deliberately broken PR is blocked."
    why_human: "The workflow file is only statically reviewable and locally re-runnable pre-push (confirmed: actionlint clean, pnpm build && pnpm test:boot green locally); a live Actions run (hosted-runner Docker behavior, gitleaks-action's own PR-diff resolution, artifact upload, hosted-runner performance for the new boot-smoke job) cannot be executed from this sandbox."
  - test: "Re-run `gitleaks detect --config .gitleaks.toml` once noodara/code is its own repository root (matching ci.yml's own documented assumption), and confirm 0 findings."
    expected: "0 leaks — the three path-scoped allowlist entries match exactly once paths are relative to the repo root instead of nested under `noodara/code/`."
    why_human: "Unchanged from the previous verification. In the current sandbox, `code/` lives nested inside a personal multi-project monorepo (git root is one level up), so gitleaks' path-scoped allowlist regexes don't match and findings surface that are all confirmed-safe already-allowlisted fixture files. This can only be conclusively confirmed once the repo is extracted to its own root."
---

# Phase 1: Dominio, persistencia y autenticación Verification Report

**Phase Goal:** El control plane arranca sobre una base de datos migrada, con el dominio central (entidad Server, state machine de conexión, validadores, cifrado) completamente probado, y un único admin que puede crearse una sola vez, iniciar sesión y cerrarla de forma segura.
**Verified:** 2026-09-12T06:27:27Z
**Status:** human_needed
**Re-verification:** Yes — after gap closure (Plans 01-16, 01-17)

## Goal Achievement

### Observable Truths (ROADMAP Success Criteria 1–5)

| # | Truth | Status | Evidence |
|---|-------|--------|----------|
| 1a | Env fail-fast **logic** rejects missing/weak `NOODARA_MASTER_KEY`, `BETTER_AUTH_SECRET`, `DATABASE_URL`, `REDIS_URL` with an actionable, per-variable message and no embedded defaults | ✓ VERIFIED (regression-checked) | Independently re-ran `env -i "$(command -v node)" apps/control-plane/dist/server.js`: exit 1, five `NOODARA_CONFIG_ERROR` lines (one per required var) on stderr, through the **production-shaped entrypoint** this time, not just `tsx`. |
| 1b | **The control plane actually starts** once required env vars are present, via its own documented commands (`pnpm dev`, or `pnpm build` + running the built artifact) | ✓ VERIFIED — previously FAILED, now closed | Independently re-ran, this session: `pnpm build` (turbo cache hit, both `packages/domain/dist` and `apps/control-plane/dist` regenerated from a genuinely deleted state via `fs.rmSync`); `pnpm test:boot` → **4/4 passed** in 11.7s, including the clean-tree, turbo-driven root `pnpm dev` case (Test 4, which itself deletes both `dist` dirs mid-run and proves `turbo.json`'s `dev` → `^build` edge by execution, then restores `dist` in its own `afterAll` — confirmed restored: `apps/control-plane/dist/server.js` and `packages/domain/dist/index.js` both present afterward). Root cause fixed per `docs/adr/0003-runtime-entrypoints-and-module-resolution.md`: `packages/domain` now builds via `tsc` to `dist/` with an `exports` map pointing at `dist/*.js`+`.d.ts` (verified: `node --input-type=module -e "import('@noodara/domain/security')..."` resolves `hashSetupToken` and `import('@noodara/domain/server')` resolves `SERVER_STATUSES`, zero `tsx`/Vitest involvement); `apps/control-plane`'s `dev` now runs `tsx watch src/server.ts`; a new `start` script runs `node dist/server.js` with no loader. |
| 2 | First admin only creatable via a valid setup token; single-use; 24h expiry; replay of used/expired token fails; setup route 404s (not 403) once admin exists; 10 concurrent redemptions of one token yield exactly one admin | ✓ VERIFIED (regression-checked) | Unchanged from prior verification; re-confirmed passing as part of `pnpm test:integration` (113/113, this session) — log evidence shows the 10-concurrent-POST-`/api/setup` race (one 200, nine 400) still present. |
| 3 | Admin logs in with argon2id email/password; cookie is `HttpOnly`/`Secure`/`SameSite=Lax` with rotated session id; session persists across cookie-only requests; logout invalidates server-side (replayed cookie rejected, row gone) | ✓ VERIFIED (regression-checked) | Unchanged; `tests/integration/auth/{login,logout,cookies}.test.ts` pass as part of the same 113/113 run. |
| 4 | Failed logins rate-limited by IP and by account independently; recorded in activity log without the password | ✓ VERIFIED (regression-checked) | Unchanged; `rate-limit.test.ts` passes as part of the same 113/113 run. |
| 5 | AES-256-GCM credential encryption with unique nonce + `key_version`, tamper test fails loudly; `packages/domain` ≥95%/95% coverage; migrations apply clean from-scratch and from-previous-snapshot; CI blocks merge on lint/typecheck/unit/integration/gitleaks/audit (+ now boot-smoke) | ✓ VERIFIED (regression-checked, coverage gate re-proven build-free) | Independently re-ran with `packages/domain/dist` deleted first (so the coverage measurement cannot be silently reading compiled output): `pnpm test --coverage` → 358/358 unit tests pass; `coverage/coverage-summary.json` shows **100%/100% statements/branches** across all 12 `packages/domain/src` files, against `vitest.config.ts`'s explicit `thresholds: { 'packages/domain/**': { statements: 95, branches: 95 } }` gate (exit 0 proves the gate is live, not descriptive). `.github/workflows/ci.yml` now runs **7** jobs (`lint`, `typecheck`, `boundaries`, `unit`, `integration`, `security`, `boot-smoke`), confirmed by name via `grep -n "^  [a-z-]*:$"`; `grep -c "continue-on-error"` → 0; `actionlint .github/workflows/ci.yml` → exit 0. |

**Score:** 6/6 truths verified — the BLOCKER from the previous verification (1b) is closed.

### Required Artifacts

| Artifact | Expected | Status | Details |
|----------|----------|--------|---------|
| `apps/control-plane/src/server.ts` (runtime entrypoint) | The actual bootable process | ✓ VERIFIED — previously STUB-equivalent for real invocation | Re-tested via `pnpm dev`, `pnpm build && pnpm start`-equivalent (`env -i node apps/control-plane/dist/server.js` with a valid env exercised inside the boot smoke test), and the clean-tree root `pnpm dev`. All reach the fail-fast/boot path for real. |
| `packages/domain/package.json` | exports map resolves under plain Node from `dist` | ✓ VERIFIED | `exports` rewritten to conditional `{types, default}` pointing at `dist/*.js`+`.d.ts`; exactly 5 entrypoints preserved (`.`, `./server`, `./security`, `./validators`, `./activity`); confirmed resolvable via plain-Node `import()`. |
| `tests/integration/boot/boot-command.test.ts` | Child-process smoke test of real `dev`/`start`/clean-tree-root-`dev` | ✓ VERIFIED | File exists, 4/4 tests pass (`pnpm test:boot`, 11.7s), zero stray `noodara.test=true` containers before/after. |
| `apps/control-plane/scripts/copy-migration-assets.mjs` | Self-contained `dist` (migrations copied) | ✓ VERIFIED | `apps/control-plane/dist/db/migrations/{0000_*.sql,0001_*.sql,meta/_journal.json}` present after `pnpm build`. |
| `.github/workflows/ci.yml` `boot-smoke` job | PR-blocking gate for the real boot path | ✓ VERIFIED | Present as job #7, reuses the established 6-job step shape, `pnpm build` then `pnpm test:boot`, `if: always()` stray-container guard; `actionlint` clean; zero `continue-on-error`. |
| `docs/adr/0003-runtime-entrypoints-and-module-resolution.md` | Accepted ADR recording the runtime contract | ✓ VERIFIED | `## Status` → `Accepted — 2026-09-12`; three-part Decision (domain `tsc` build, plain-node `start`, `tsx watch` `dev`); Rejected alternatives section present; matches what was actually shipped (cross-checked against `package.json`/`turbo.json` contents, not just prose). |
| `CLAUDE.md` §3.2 command table | Lists `pnpm build`/`pnpm start`, links ADR 0003 | ✓ VERIFIED | Both lines present; ADR reference present. (Note: `CLAUDE.md` is gitignored per this repo's convention — a local-only, uncommitted edit, consistent with 01-17-SUMMARY's own disclosure.) |
| `.planning/phases/.../01-VALIDATION.md` | Verification-map rows exercising the real boot commands | ✓ VERIFIED | Rows `1-16-01`..`1-16-03`, `1-17-01`..`1-17-02` present, each with a real spawned-command `Automated Command`, plus a note explaining why the original 33-row map missed this. |

All artifacts from the previous verification's fully-passing set (`env.ts`, `master-key.ts`, `server-state.ts`, security primitives, validators, schema/migrations, `write-activity-event.ts`, auth stack, routes, `bootstrap-admin.ts`/CLI) were spot-checked for regression via the full re-run of `pnpm test`/`pnpm test:integration` and remain green; no new anti-patterns found in them.

### Key Link Verification

| From | To | Via | Status | Details |
|------|-----|-----|--------|---------|
| `apps/control-plane/src/server.ts` | `env.ts` | top-of-file import forcing validation before listen | ✓ WIRED (now proven under plain-node invocation too) | Previously "WIRED in-process/NOT_WIRED under plain-node" — now closed both ways: `env -i node dist/server.js` fails fast correctly, and a valid env reaches `Server listening` (proven inside `boot-command.test.ts`'s Test 2). |
| `apps/control-plane/dist/server.js` | `packages/domain/dist/*/index.js` | plain-Node resolution through the `@noodara/domain` exports map | ✓ WIRED | Confirmed via direct plain-Node `import()` of `@noodara/domain/security` and `@noodara/domain/server`, and via the built `dist/server.js` no longer throwing `ERR_MODULE_NOT_FOUND`. |
| `turbo.json` `dev` task | `^build` | `dependsOn: ["^build"]` + `passThroughEnv` allowlist | ✓ WIRED | Test 4 of `boot-command.test.ts` deletes both `dist` dirs and spawns the literal root `pnpm dev`; it reaches `Server listening` — proof by execution, not just JSON shape. `passThroughEnv` (an empirical addition beyond the plan's original interface contract) is present in `turbo.json` and lists every `env.ts` variable. |
| `.github/workflows/ci.yml` `boot-smoke` | `tests/integration/boot/boot-command.test.ts` | `pnpm build` then `pnpm test:boot` | ✓ WIRED | Job present, `test:boot` script exists at root and is the exact command CI runs; locally reproduced with the same commands, 4/4 green. |
| All key links verified in the previous report (`routes/auth.ts` ↔ `auth.ts`, IP header bridge, `login-guard.ts` ↔ `login-backoff.ts`, `setup-service.ts` ↔ `setup-token.ts`, `bootstrap-admin.ts` HMAC-derived reprint, `secrets-rotate.ts` ↔ `envelope.ts`) | — | — | ✓ WIRED (regression-checked) | All pass within the same 113/113 integration re-run; no source files in these paths were touched by Plans 01-16/01-17 (confirmed by `files_modified` in both plans' frontmatter). |

### Data-Flow Trace (Level 4)

Not applicable in the strict UI-rendering sense (no frontend in this phase). Re-confirmed the equivalent check from the prior verification: `GET /health` returns a real `200 {status:'ok'}` from the actually-booted process (not a mock) as part of `boot-command.test.ts`'s Tests 2 and 3; `GET /api/sessions` and activity-event metadata behavior unchanged and still exercised by the passing integration suite.

### Behavioral Spot-Checks

| Behavior | Command | Result | Status |
|----------|---------|--------|--------|
| Env fail-fast names every var, through the **production-shaped** entrypoint | `env -i "$(command -v node)" apps/control-plane/dist/server.js` | Exit 1; 5 `NOODARA_CONFIG_ERROR` lines | ✓ PASS (previously ✗ FAIL) |
| `@noodara/domain` resolves under plain Node from `dist` | `node --input-type=module -e "import('@noodara/domain/security')...import('@noodara/domain/server')..."` | `OK` printed, exit 0 | ✓ PASS (previously ✗ FAIL) |
| Real-world boot via `pnpm dev`/`start`, incl. clean-tree turbo root `dev` | `pnpm test:boot` | 4/4 passed, 11.7s | ✓ PASS (previously ✗ FAIL) |
| `dist` restored after Test 4's deliberate deletion | `test -f apps/control-plane/dist/server.js && test -f packages/domain/dist/index.js` | both present | ✓ PASS |
| `packages/domain` coverage gate still measures **source**, not `dist` | `rm -rf packages/domain/dist` (via `fs.rmSync`) then `pnpm test --coverage` | 358/358 unit tests pass; `coverage-summary.json` shows 100%/100% across all 12 domain files | ✓ PASS |
| CI has exactly 7 named jobs, `boot-smoke` among them, zero `continue-on-error` | `grep -n "^  [a-z-]*:$" .github/workflows/ci.yml` / `grep -c continue-on-error` | 7 jobs by name; 0 matches | ✓ PASS |
| `actionlint` on the updated workflow | `actionlint .github/workflows/ci.yml` | exit 0 | ✓ PASS |
| Full integration suite + no stray containers | `pnpm test:integration` | 17 files, 113/113 passed, 153.5s | ✓ PASS |
| `pnpm audit` | `pnpm audit --audit-level=high` | 1 moderate, 0 high/critical, exit 0 | ✓ PASS |
| No debt markers in phase files | `grep -rn -E "TBD|FIXME|XXX" apps/control-plane/src packages/domain/src tests scripts docs/adr .github package.json turbo.json` | 0 matches | ✓ PASS |
| Working tree clean (no uncommitted drift from what SUMMARYs claim) | `git status --short .` | clean | ✓ PASS |

### Probe Execution

No `scripts/*/tests/probe-*.sh` convention is used by this project; `tests/integration/boot/boot-command.test.ts` is this phase's equivalent gap-closure probe and was executed directly above (`pnpm test:boot`, 4/4, exit 0) — not merely read from SUMMARY.md.

### Requirements Coverage

| Requirement | Description | Status | Evidence |
|-------------|-------------|--------|----------|
| INST-06 | Fail-fast on missing/weak secrets, no defaults | ✓ SATISFIED — previously PARTIAL | Validation logic and the real boot path now both proven: fail-fast reachable through `dist/server.js` under plain Node, and a valid env reaches `Server listening` via `pnpm dev`/`pnpm start`. |
| AUTH-01 | Setup-token-gated first admin, single-use, 24h, route disappears | ✓ SATISFIED (regression-checked) | Unchanged; integration-tested. |
| AUTH-02 | argon2id login, session persists | ✓ SATISFIED (regression-checked) | Unchanged. |
| AUTH-03 | Server-side logout invalidation | ✓ SATISFIED (regression-checked) | Unchanged. |
| AUTH-04 | Rate limit by IP+account, no password in log | ✓ SATISFIED (regression-checked) | Unchanged. |
| AUTH-05 | Hardened cookies, rotation, configurable expiry | ✓ SATISFIED (regression-checked) | Unchanged. |
| SERV-05 | Centralized, validated Server state machine | ✓ SATISFIED (regression-checked) | Unchanged. |
| SEC-01 | AES-256-GCM, nonce+key_version, tamper detection | ✓ SATISFIED (regression-checked) | Unchanged. |
| QA-01 | 7-job PR-blocking CI (now incl. `boot-smoke`) | ✓ SATISFIED — live-Actions run still needs a human | `.github/workflows/ci.yml` statically and locally re-verified (actionlint, `pnpm build && pnpm test:boot`); live-Actions run remains a human_verification item, unchanged from before. |
| QA-02 | `packages/domain` ≥95%/95% | ✓ SATISFIED | Re-measured build-free (dist deleted first) at 100%/100%, gate enforced by `vitest.config.ts` thresholds (exit-code proven, not just descriptive). |
| QA-06 | Migrations from-scratch and from-snapshot | ✓ SATISFIED (regression-checked) | Unchanged; part of the 113/113 integration re-run. |

No orphaned requirements.

### Anti-Patterns Found

None blocking. No `TBD`/`FIXME`/`XXX`, no `TODO`/`HACK`/`PLACEHOLDER`, no `.skip`/`.todo` in any phase-1 file, re-scanned this session across `apps/control-plane/src`, `packages/domain/src`, `tests`, `scripts`, `docs/adr`, `.github`, and the touched root config files (`package.json`, `turbo.json`).

### Deviations Reviewed for Security/Scope Impact

- **01-16's `turbo.json` `passThroughEnv` allowlist** (not anticipated in the plan's own `<interfaces>` section, discovered empirically when the turbo-driven root `pnpm dev` stripped all env vars under Turborepo 2's strict-env-mode default): assessed safe. It is an explicit allowlist of exactly the variables `env.ts`'s `Env` interface already requires/accepts — it does not widen what a task can read beyond what the application itself already declares as configuration.
- **01-16's `vitest.shared.ts` alias ordering** (subpath aliases before the bare-package regex alias): correctly prevents the bare `@noodara/domain` alias from swallowing `@noodara/domain/security` etc. — verified by the fact that `pnpm test --coverage` still measures all 12 domain source files individually.
- All deviations previously reviewed and accepted in the initial verification (HMAC-derived reprintable setup token, `x-noodara-client-ip` header bridge, `validateSchema: false`) are unchanged — no plan in this gap-closure round touched `auth.ts`, `hooks.ts`, `setup.ts`, or `bootstrap-admin.ts`'s security logic (confirmed via both plans' `files_modified` frontmatter).

## Gaps Summary

**No gaps.** The previous BLOCKER — the control plane's actual runnable entrypoint (`pnpm dev`, or the built `dist/server.js`) crashing with `ERR_MODULE_NOT_FOUND` before env validation ever ran — is closed and independently re-verified in this session, not merely asserted by SUMMARY.md: `packages/domain` now builds via `tsc` to `dist/` with its exports map pointing there; `apps/control-plane`'s `dev` runs through `tsx watch`; a new `start` script runs the built artifact under plain Node; the fix is locked behind a 7th CI job (`boot-smoke`) that a regression cannot bypass; and the decision is recorded in `docs/adr/0003-runtime-entrypoints-and-module-resolution.md`. `01-VALIDATION.md`'s verification map now contains rows that actually spawn the real boot commands, closing the second half of the original finding (no automated check exercised the documented commands).

Two non-blocking items remain in `human_verification`, unchanged from the previous verification and not re-attempted by the gap-closure plans (as those plans themselves scoped): a live GitHub Actions run of the (now 7-job) CI pipeline, and a gitleaks re-run once the repo is extracted to its own root. Per the status decision tree, the presence of these human-verification items — even with all 6/6 truths now VERIFIED — routes the phase to `human_needed` rather than `passed`.

---

*Verified: 2026-09-12T06:27:27Z*
*Verifier: Claude (gsd-verifier)*
