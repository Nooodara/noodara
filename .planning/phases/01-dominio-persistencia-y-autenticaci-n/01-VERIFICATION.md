---
phase: 01-dominio-persistencia-y-autenticacion
verified: 2026-09-11T22:15:00Z
status: gaps_found
score: 5/6 must-haves verified
overrides_applied: 0
gaps:
  - truth: "El control plane arranca (roadmap goal / SC1) — not just fails fast, but actually starts once required env vars are present, via the project's own documented commands"
    status: failed
    reason: >
      `pnpm dev` (`node --watch --experimental-strip-types src/server.ts`, apps/control-plane/package.json)
      and `node apps/control-plane/dist/server.js` (after `pnpm build`) both crash with
      `ERR_MODULE_NOT_FOUND` before `env.ts`'s fail-fast validation ever runs. Plain Node's
      `--experimental-strip-types` type stripping does not remap a `.js` relative-import specifier
      to a sibling `.ts` file, so `server.ts`'s own `./env.js` import (the NodeNext/tsc convention
      used throughout this codebase) is unresolvable when run directly with plain `node`, on both
      the pinned Node 22.23.2 LTS and the ambient Node 24.13.0. `node dist/server.js` fails one
      layer further in: `packages/domain`'s `package.json` `exports` map points directly at `.ts`
      sources (no build step for that package), so even the *compiled* apps/control-plane output
      cannot resolve `@noodara/domain`'s exports under plain `node`. Only `tsx` (used already for
      `db:migrate` and the CLI, but never wired into `dev`/a `start` script) or Vitest's own
      transform (used by every unit/integration test) can run this code today. No task's Per-Task
      Verification Map in 01-VALIDATION.md exercises `pnpm dev` or `node dist/server.js` — every
      "boot" proof in this phase goes through Vitest's `startApp()`/`startTestApp()` helpers, which
      sidestep this defect entirely. The underlying fail-fast *logic* is correct and separately
      provable (see artifacts below), but the actual runnable entrypoint the roadmap goal
      ("el control plane arranca") depends on is broken as committed.
    artifacts:
      - path: "apps/control-plane/package.json"
        issue: "\"dev\": \"node --watch --experimental-strip-types src/server.ts\" cannot resolve its own relative .js-specifier imports under plain node; no \"start\" script exists for the built dist/ output either"
      - path: "apps/control-plane/src/server.ts"
        issue: "First real-world invocation (plain node, dev or dist) throws ERR_MODULE_NOT_FOUND on './env.js' / on packages/domain's exports before bootstrapAdmin or env validation ever runs"
      - path: "packages/domain/package.json"
        issue: "exports map points at .ts sources with no build step, so apps/control-plane's compiled dist/ output cannot resolve @noodara/domain under plain node either"
    missing:
      - "Wire dev (and a new start script for the built artifact) through tsx, or rewrite this codebase's relative-import convention to full .ts specifiers Node's native stripping can resolve directly, or give packages/domain its own build step — whichever is chosen, add one automated check (even a smoke test spawning the real script) that actually exercises pnpm dev / the production boot command, since every existing test bypasses it via Vitest's transform."
human_verification:
  - test: "Push noodara/code as the root of its own git repository and let the real GitHub Actions workflow (.github/workflows/ci.yml) run all six jobs against a PR."
    expected: "lint, typecheck, boundaries, unit (coverage), integration (Testcontainers on the hosted runner), and security (audit + security:scan-leaks + gitleaks diff scan) all pass; a deliberately broken PR is blocked."
    why_human: "The workflow file is only statically reviewable pre-push; a live Actions run (hosted-runner Docker behavior, gitleaks-action's own PR-diff resolution, artifact upload) cannot be executed from this sandbox."
  - test: "Re-run `gitleaks detect --config .gitleaks.toml` once noodara/code is its own repository root (matching ci.yml's own documented assumption), and confirm 0 findings."
    expected: "0 leaks — the three path-scoped allowlist entries (vitest.config.ts, tests/integration/cli/admin-reset.test.ts, packages/domain/src/security/redactor.test.ts) match exactly, since paths will then be relative to the repo root instead of nested under `noodara/code/`."
    why_human: "In the current sandbox, `code/` lives nested inside a personal multi-project monorepo (git root is one level up at `.../noodara/myself`), so gitleaks' path-scoped allowlist regexes (anchored to repo-root-relative paths) don't match and 5 findings surface — all of them exactly the three already-allowlisted fixture files (fake NOODARA_MASTER_KEY / fake AWS key), confirmed by manual inspection, not real secrets. This is a workspace-layout artifact the CI workflow's own comments already anticipate (\"the monorepo currently lives nested under a personal workspace... when it is pushed, this directory becomes the root of its own git repository\"), not a code defect — but it can only be conclusively confirmed once the repo is actually extracted."
---

# Phase 1: Dominio, persistencia y autenticación — Verification Report

**Phase Goal:** El control plane arranca sobre una base de datos migrada, con el dominio central (entidad Server, state machine de conexión, validadores, cifrado) completamente probado, y un único admin que puede crearse una sola vez, iniciar sesión y cerrarla de forma segura.
**Verified:** 2026-09-11T22:15:00Z
**Status:** gaps_found
**Re-verification:** No — initial verification

## Goal Achievement

### Observable Truths (ROADMAP Success Criteria 1–5)

| # | Truth | Status | Evidence |
|---|-------|--------|----------|
| 1a | Env fail-fast **logic** rejects missing/weak `NOODARA_MASTER_KEY`, `BETTER_AUTH_SECRET`, `DATABASE_URL`, `REDIS_URL` with an actionable, per-variable message and no embedded defaults | ✓ VERIFIED | `apps/control-plane/src/env.ts` has zero `.default(`/`??`/`\|\|` on any of these vars (grep confirmed). `env -i tsx src/server.ts` (Node 22.23.2, all env vars stripped) exits 1 and prints `NOODARA_CONFIG_ERROR` for all 5 required vars by name. `env.test.ts` unit-tests every failure mode. |
| 1b | **The control plane actually starts** once required env vars are present, via its own documented commands (`pnpm dev`, or `pnpm build` + running the built artifact) | ✗ FAILED | See Gaps below — both `pnpm dev` and `node apps/control-plane/dist/server.js` crash with `ERR_MODULE_NOT_FOUND` before env validation ever runs, on both Node 22.23.2 (pinned LTS) and Node 24.13.0. |
| 2 | First admin only creatable via a valid setup token; single-use; 24h expiry; replay of used/expired token fails; setup route 404s (not 403) once admin exists; 10 concurrent redemptions of one token yield exactly one admin | ✓ VERIFIED | `packages/domain/src/security/setup-token.ts` (pure, 100% covered) + `apps/control-plane/src/services/setup-service.ts` (`pg_advisory_xact_lock` serializes redemption) + `apps/control-plane/src/routes/setup.ts` (404, not 403, once `adminExists()`). `tests/integration/auth/setup.test.ts` + `setup-race.test.ts` pass (part of 109/109 integration); race log observed live: 10 concurrent `POST /api/setup` → one 200, nine 400. |
| 3 | Admin logs in with argon2id email/password; cookie is `HttpOnly`/`Secure`/`SameSite=Lax` with rotated session id; session persists across cookie-only requests; logout invalidates server-side (replayed cookie rejected, row gone) | ✓ VERIFIED | `apps/control-plane/src/auth/auth.ts` (argon2id via `password-hasher.ts`, `useSecureCookies: !env.NOODARA_COOKIE_INSECURE` — never derived from `NODE_ENV`, `sameSite: 'lax'`). `tests/integration/auth/{login,logout,cookies}.test.ts` pass; `cookies.test.ts` asserts HttpOnly/Secure/SameSite via `set-cookie-parser`, including the two `NOODARA_COOKIE_INSECURE` variants and rotation across sequential sign-ins. |
| 4 | Failed logins rate-limited by IP and by account independently; recorded in activity log without the password | ✓ VERIFIED | `packages/domain/src/security/login-backoff.ts` (pure, 100% covered, 900/1800/3600/7200s doubling capped at 86400s) + `apps/control-plane/src/auth/login-guard.ts` (independent `loadAttempt('ip', ...)` / `loadAttempt('account', ...)`, throws `APIError('TOO_MANY_REQUESTS', ...)` with `Retry-After` before Better Auth's handler runs). `tests/integration/auth/rate-limit.test.ts` passes (part of 109/109); `writeActivityEvent` metadata only ever carries `{ email, ip }`, never a password field (confirmed by reading `login-guard.ts` in full). |
| 5 | AES-256-GCM credential encryption with unique nonce + `key_version`, tamper test fails loudly; `packages/domain` ≥95%/95% coverage; migrations apply clean from-scratch and from-previous-snapshot; CI blocks merge on lint/typecheck/unit/integration/gitleaks/audit | ✓ VERIFIED | `packages/domain/src/security/envelope.ts` (100%/100% covered) stores `v<version>:<nonce_b64>:<ciphertext_b64>:<tag_b64>` (D-10). `packages/domain` measured at **100% statements / 100% branches** (`coverage/coverage-summary.json`, all 12 files), well above the 95%/95% `vitest.config.ts` threshold; `pnpm exec vitest run --coverage` exits 0. `tests/integration/db/migrations.test.ts` (from-scratch + from-snapshot) and `migration-hygiene.test.ts` (defensive-SQL static guard) both pass. `.github/workflows/ci.yml` runs 6 jobs (lint, typecheck, boundaries, unit, integration, security) with zero `continue-on-error`; security job runs `pnpm audit --audit-level=high`, `pnpm security:scan-leaks`, and gitleaks on the PR diff plus a full-tree scan on push-to-main. |

**Score:** 5/6 truths verified (Truth 1 split into 1a/1b; 1a verified, 1b failed)

### Required Artifacts

| Artifact | Expected | Status | Details |
|----------|----------|--------|---------|
| `apps/control-plane/src/env.ts` | Fail-fast Zod env validation, no defaults | ✓ VERIFIED | 0 matches for `.default(`, `??`, `\|\|` on any var; unit-tested |
| `apps/control-plane/src/boot/master-key.ts` | D-12 fingerprint + fixed backup warning, never the key | ✓ VERIFIED | `masterKeyFingerprint` = truncated SHA-256 hex; called from `app.ts:30` on every boot |
| `packages/domain/src/server/server-state.ts` + `connection-result.ts` | 6-state machine, centralized transitions | ✓ VERIFIED | 100%/100% coverage; `InvalidTransitionError` on any non-listed pair |
| `packages/domain/src/security/{secret-value,redactor,envelope,setup-token,login-backoff}.ts` | SecretValue, Redactor, AES-256-GCM envelope, setup-token rules, backoff arithmetic | ✓ VERIFIED | All 100%/100% covered; `envelope.ts` tamper/wrong-key tests present |
| `packages/domain/src/validators/{network,identity,password}.ts` + `activity/activity-event.ts` | Pure validators, password policy, closed ActivityEvent action union | ✓ VERIFIED | 100%/100% covered |
| `apps/control-plane/src/db/schema/*.ts` + `db/migrations/` | Full phase-1 schema incl. `pending_fingerprint`, `key_version`, UUIDv7 PKs, `login_attempts` | ✓ VERIFIED | Schema files present; migrations apply from-scratch and from-snapshot (tested) |
| `apps/control-plane/src/activity/write-activity-event.ts` | Single activity_events writer, applies Redactor | ✓ VERIFIED | `grep -rn "insert(.*activityEvents"` outside this file → 0 matches |
| `apps/control-plane/src/auth/{auth,password-hasher,hooks,session-policy,signup-gate,login-guard}.ts` | Better Auth core + all four extension points | ✓ VERIFIED | All present, wired, `auth.ts`/`hooks.ts` untouched by later plans (per each SUMMARY's own `git diff --name-only` check) |
| `apps/control-plane/src/routes/{auth,setup,sessions}.ts` | HTTP surface | ✓ VERIFIED | Present; setup.ts 404s (not 403) once admin exists; sessions.ts uses explicit Zod output schemas |
| `apps/control-plane/src/boot/bootstrap-admin.ts` + `cli/{admin-reset,secrets-rotate}.ts` | D-01/D-04 boot decision, CLI recovery/rotation | ✓ VERIFIED | Present, unit+integration tested (358+109 tests green) |
| `.github/workflows/ci.yml` + `.gitleaks.toml` | 6 PR-blocking jobs | ✓ VERIFIED | No `continue-on-error`; gitleaks + audit + scan-leaks wired |
| `apps/control-plane/src/server.ts` (runtime entrypoint) | The actual bootable process | ✗ **STUB-equivalent for real invocation** | Logic is correct (see Truth 1a) but cannot be executed via `pnpm dev` or the built `dist/` output under plain Node — see Gaps |

### Key Link Verification

| From | To | Via | Status | Details |
|------|-----|-----|--------|---------|
| `apps/control-plane/src/server.ts` | `env.ts` | top-of-file import forcing validation before listen | ✓ WIRED (in-process/test) / ✗ NOT_WIRED (plain-node invocation) | Import present and correctly ordered; only fails to *resolve* under plain `node`, not a logic gap |
| `apps/control-plane/src/routes/auth.ts` | `auth.ts` | `toNodeHandler(auth.handler)` + `Object.assign(request.raw, { body: request.body })` | ✓ WIRED | Confirmed by reading the file; 12/12 login/logout/cookies integration tests pass through this path |
| `apps/control-plane/src/routes/auth.ts` | `login-guard.ts` (via header bridge) | `request.raw.headers['x-noodara-client-ip'] = request.ip` set **after** Fastify's own `trustProxy`-aware resolution, unconditionally overwriting any client-supplied value under the same header name | ✓ WIRED, not spoofable | Read both files: the assignment is a plain object-property overwrite (not an append), so a client-sent `x-noodara-client-ip` header can never survive it — confirmed safe |
| `apps/control-plane/src/auth/login-guard.ts` | `packages/domain/src/security/login-backoff.ts` | `isLockedOut` / `evaluateFailure` | ✓ WIRED | `rate-limit.test.ts` passes with both per-IP and per-account scenarios |
| `apps/control-plane/src/services/setup-service.ts` | `packages/domain/src/security/setup-token.ts` | `isTokenUsable`, hash comparison via indexed lookup | ✓ WIRED | `redeemSetupToken`/`redeemRecoveryToken` both verified by hash *and* purpose |
| `apps/control-plane/src/boot/bootstrap-admin.ts` (HMAC-derived reprintable token) | `packages/domain/src/security/setup-token.ts` | `hashSetupToken`/`isTokenUsable` reused; `deriveSetupTokenValue` (new, HMAC-SHA256 of row id keyed by `BETTER_AUTH_SECRET`) replaces `generateSetupToken()` only for the boot-reprint path | ✓ WIRED, assessed safe | Read `bootstrap-admin.ts` in full: only the SHA-256 hash of the derived value is ever persisted (same `hashSetupToken` used elsewhere); the derivation requires `BETTER_AUTH_SECRET`, which is already the crown-jewel secret protecting every session — this does not introduce a materially new attack surface, and correctly satisfies D-01's "reprint the same token on every boot" requirement without ever storing the raw value |
| `apps/control-plane/src/cli/secrets-rotate.ts` | `packages/domain/src/security/envelope.ts` | `reencryptSecret` inside `db.transaction` | ✓ WIRED | `tests/integration/cli/secrets-rotate.test.ts` passes; a seeded tampered row causes rollback, verified by asserting other rows still decrypt under the old key afterward |

### Data-Flow Trace (Level 4)

Not applicable in the strict UI-rendering sense (no frontend in this phase). The equivalent check — that session/activity data reaching an HTTP response is not hardcoded/empty — was exercised via the passing integration suite: `GET /api/sessions` returns real DB rows (`session-management.test.ts`), and `auth.login_failed`/`auth.login_blocked` activity events carry real `{ email, ip }` metadata resolved from the request, not static placeholders (confirmed by reading `login-guard.ts`).

### Behavioral Spot-Checks

| Behavior | Command | Result | Status |
|----------|---------|--------|--------|
| Env fail-fast names every missing var | `env -i tsx apps/control-plane/src/server.ts` (Node 22.23.2, cwd=apps/control-plane) | Exit 1; `NOODARA_CONFIG_ERROR` lines for `NOODARA_MASTER_KEY`, `BETTER_AUTH_SECRET`, `DATABASE_URL`, `REDIS_URL`, `NOODARA_PUBLIC_URL` | ✓ PASS |
| Real-world boot via `pnpm dev` | `node --watch --experimental-strip-types src/server.ts` (both Node 22.23.2 and 24.13.0) | `ERR_MODULE_NOT_FOUND` on `./env.js`, before any env validation | ✗ FAIL |
| Real-world boot via built artifact | `pnpm build && env -i node apps/control-plane/dist/server.js` | `ERR_MODULE_NOT_FOUND` resolving `@noodara/domain`'s `.ts`-only exports | ✗ FAIL |
| No stray `.default(`/`\|\|`/`??` on security-critical env vars | `grep -rn "\.default(" apps/control-plane/src packages/domain/src` | Only non-secret DB schema column defaults (`ssh_port` default 22, `status` default `'PENDING'`, etc.) | ✓ PASS |
| No debt markers in phase-1 files | `grep -rn -E "TBD\|FIXME\|XXX" apps/control-plane/src packages/domain/src tests scripts docs/adr .github` | 0 matches | ✓ PASS |
| No `.skip`/`.todo` in test tree | `grep -rc "\.skip\|\.todo" tests/ packages/ apps/ \| grep -v ':0' \| wc -l` | `0` | ✓ PASS |
| Stray Testcontainers left running | `docker ps -a --filter "label=noodara.test=true"` (before/after `pnpm test:integration`) | 0 before and after | ✓ PASS |

### CI / Full-Command-Chain Re-run (independent, this session)

| Command | Result |
|---------|--------|
| `pnpm install --frozen-lockfile` | exit 0 |
| `pnpm lint` | exit 0 (cache hit, 3/3 packages) |
| `pnpm typecheck` | exit 0 (cache hit, 2/2 packages) |
| `pnpm exec turbo boundaries` | exit 0 — 161 files, no issues |
| `pnpm build` | exit 0 |
| `pnpm exec vitest run --coverage` | exit 0 — 358/358 unit tests; `packages/domain` **100%/100%** statements/branches (threshold 95%/95%) |
| `pnpm test:integration` | exit 0 — 16 files, **109/109** integration tests, ~150s, 0 stray containers |
| `pnpm audit --audit-level=high` | exit 0 — 1 moderate advisory, 0 high/critical |
| `gitleaks detect --config .gitleaks.toml` (local, from this nested checkout) | **exit 1**, 5 findings — all 5 are the 3 already-allowlisted fixture files, misdetected only because this checkout's actual git root is one level above `noodara/code/` (a personal multi-project monorepo); see human_verification |
| `env -i tsx apps/control-plane/src/server.ts` | exit 1, all 5 required vars named |
| `pnpm dev`-equivalent (`node --experimental-strip-types src/server.ts`) | **crashes**, `ERR_MODULE_NOT_FOUND` |
| `node apps/control-plane/dist/server.js` (post-build) | **crashes**, `ERR_MODULE_NOT_FOUND` |

### Requirements Coverage

| Requirement | Description | Status | Evidence |
|-------------|-------------|--------|----------|
| INST-06 | Fail-fast on missing/weak secrets, no defaults | ⚠️ PARTIAL | Validation logic fully satisfied and tested; the *process itself* does not currently boot via any documented command outside the test harness (see gap) |
| AUTH-01 | Setup-token-gated first admin, single-use, 24h, route disappears | ✓ SATISFIED | `setup-token.ts`, `setup-service.ts`, `setup.ts`, `bootstrap-admin.ts`; integration-tested incl. 10-way race |
| AUTH-02 | argon2id login, session persists | ✓ SATISFIED | `auth.ts`, `password-hasher.ts`; `login.test.ts` |
| AUTH-03 | Server-side logout invalidation | ✓ SATISFIED | `logout.test.ts`, `session-management.test.ts` |
| AUTH-04 | Rate limit by IP+account, no password in log | ✓ SATISFIED | `login-backoff.ts`, `login-guard.ts`, `rate-limit.test.ts` |
| AUTH-05 | Hardened cookies, rotation, configurable expiry | ✓ SATISFIED | `cookies.test.ts`, `session-lifetime.test.ts` |
| SERV-05 | Centralized, validated Server state machine | ✓ SATISFIED | `server-state.test.ts`, 100% coverage, all 36 pairs asserted |
| SEC-01 | AES-256-GCM, nonce+key_version, tamper detection | ✓ SATISFIED | `envelope.ts`, `envelope.test.ts`, `secrets-rotate.test.ts` |
| QA-01 | 6-job PR-blocking CI | ✓ SATISFIED | `.github/workflows/ci.yml`; static review confirms no `continue-on-error`; **live-Actions run still needs a human** (see human_verification) |
| QA-02 | `packages/domain` ≥95%/95% | ✓ SATISFIED | Measured 100%/100%, threshold-gated exit code confirmed |
| QA-06 | Migrations from-scratch and from-snapshot | ✓ SATISFIED | `migrations.test.ts`, `migration-hygiene.test.ts`, both green |

No orphaned requirements: all 11 IDs in the phase's `REQUIREMENTS: INST-06, AUTH-01..05, SERV-05, SEC-01, QA-01, QA-02, QA-06` line appear in at least one plan's frontmatter `requirements:` field (cross-checked against every `01-*-PLAN.md`).

### Anti-Patterns Found

None blocking. No `TBD`/`FIXME`/`XXX`, no `TODO`/`HACK`/`PLACEHOLDER`, no `.skip`/`.todo`, no empty-return stubs found in any phase-1 source file reviewed.

### Deviations Reviewed for Security/Scope Impact

- **01-14's HMAC-derived reprintable setup token** (`deriveSetupTokenValue(rowId, secret) = HMAC-SHA256(BETTER_AUTH_SECRET, rowId)`): assessed safe. Only the SHA-256 hash of the derived value is ever persisted (same `hashSetupToken` function used by the genuinely-random `generateSetupToken()` path elsewhere); the derivation depends on `BETTER_AUTH_SECRET`, which already gates every session in the system — this does not create new attack surface beyond what a `BETTER_AUTH_SECRET` compromise already implies, and correctly satisfies D-01's "same token reprinted on every boot" requirement without persisting the raw value anywhere.
- **01-13's `x-noodara-client-ip` header bridge**: assessed safe. `routes/auth.ts` sets `request.raw.headers['x-noodara-client-ip'] = request.ip` (a plain property overwrite, not an append) immediately before delegating to Better Auth, using Fastify's own `trustProxy`-aware `request.ip`. Any client-supplied header under the same name is unconditionally replaced, so it cannot be spoofed. `NOODARA_TRUST_PROXY` (default `false`) gates whether `X-Forwarded-For` is honored at all.
- **01-10's `validateSchema: false`**: assessed safe. Disables only a startup schema-shape *consistency check* (Better Auth expects unused OAuth columns this project's schema intentionally omits per v0.1 scope); it is not a runtime security control and does not weaken any registered threat.

## Gaps Summary

One BLOCKER: the control plane's actual runnable entrypoint (`pnpm dev`, or the built `dist/server.js`) cannot start under plain Node due to a `.js`-vs-`.ts` module-resolution mismatch — a real, reproducible defect distinct from (and not covered by) any of this phase's 33 automated tasks, all of which prove the underlying logic through Vitest's own module transform or through `tsx`, never through the actual committed `dev`/build-and-run path. The fail-fast validation logic itself (INST-06's actual acceptance criterion) is correct and well-tested; what's missing is a working way to run the process at all outside of a test runner. This directly undercuts the phase goal's literal claim that "el control plane arranca."

Two non-blocking items are routed to human_verification: a live GitHub Actions run of the six-job CI pipeline (only testable after a real push), and a gitleaks re-run once the repo is extracted to its own root (the local re-run in this nested-monorepo checkout surfaces 5 findings that are all confirmed-safe test fixtures already covered by the path-scoped allowlist, misdetected only because of the current nested checkout's git root).

---

*Verified: 2026-09-11T22:15:00Z*
*Verifier: Claude (gsd-verifier)*
