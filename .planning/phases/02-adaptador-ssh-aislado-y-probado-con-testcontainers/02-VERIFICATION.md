---
phase: 02-adaptador-ssh-aislado-y-probado-con-testcontainers
verified: 2026-09-15T19:49:32Z
status: passed
score: 13/13 must-haves verified
overrides_applied: 0
---

# Phase 2: Adaptador SSH aislado y probado con Testcontainers Verification Report

**Phase Goal:** Noodara se conecta a un servidor Ubuntu real por SSH, verifica su host fingerprint (TOFU), ejecuta únicamente comandos de una allowlist con timeouts explícitos, y clasifica cada fallo con un `error_code` específico — probado contra infraestructura SSH efímera real antes de integrarse al resto del sistema.
**Verified:** 2026-09-15T19:49:32Z
**Status:** passed
**Re-verification:** No — initial verification

## Method

This verification re-ran every automated command claimed by 02-VALIDATION.md's "Full-Phase Green Run" from scratch in this session (not trusted from the SUMMARY narrative), read the actual implementation of every load-bearing module (host-verifier, fingerprint, error-classifier, allowlist, run-discovery, ssh2-adapter, retry, connection-mutex, key-loader, exec-with-timeout), and read the full text of three integration test files (`host-key-changed.test.ts`, `timeouts.test.ts`, `connection-loss.test.ts`, `discovery.test.ts`) end to end rather than sampling.

## Goal Achievement

### Observable Truths (Roadmap Success Criteria 1–5)

| # | Truth | Status | Evidence |
|---|-------|--------|----------|
| 1 | TOFU: first connect captures fingerprint; a changed host key on reconnect fails `HOST_KEY_CHANGED` until explicit re-pin, never auto-accepted | ✓ VERIFIED | `packages/ssh/src/host-verifier.ts` has no bypass/insecure option (only `trusted: HostFingerprint \| null`); `tests/integration/ssh/host-key-changed.test.ts` runs the full lifecycle against two real, sequential sshd containers on both Ubuntu 22.04/24.04: capture → reject with both fingerprints in the message → succeeds only once the new key is pinned → a repeated mismatch (old pin) rejects again identically (D-07). Integration run: green. |
| 2 | Every connection failure produces one of the 7 `error_code`s, connect/command timeouts are explicit and independent, and no uncontrolled exception ever escapes | ✓ VERIFIED | `packages/ssh/src/error-classifier.ts`: `ERROR_CLASSIFICATION_RULES` has a named rule for all 7 codes (`AUTH_FAILED`, `HOST_UNRESOLVED`, `CONNECT_TIMEOUT` ×2, `HOST_KEY_CHANGED`, `CONNECTION_LOST` ×2, `COMMAND_TIMEOUT`, `UNSUPPORTED_OS`) plus a documented terminal fallback; `classifySshError` wraps every step in `try/catch` and never throws. `exec-with-timeout.ts` races each command against an independent timer; `ssh2-adapter.ts`'s `readyTimeout` is bound to `connectMs` separately. `tests/integration/ssh/timeouts.test.ts` proves both independently against a real blackhole listener (`CONNECT_TIMEOUT`, `attempts: 2`) and a real sshd with a 1ms command budget (`COMMAND_TIMEOUT` without killing the underlying connection), with an `unhandledRejection` listener asserting nothing escaped. |
| 3 | Non-root SSH user: `sudo -n` and `docker` group membership checked and reported per-check | ✓ VERIFIED | `packages/ssh/src/commands/access.ts` uses exactly `sudo -n true` (never bare `sudo`) and `id -nG`; `run-discovery.ts`'s `sudo`/`docker_group` steps report `not_applicable` for `root`, real pass/fail otherwise. `tests/integration/ssh/discovery.test.ts`'s "SERV-08 access-check matrix" proves `root→not_applicable`, `deployer→pass`, `restricted→fail` against real containers on both Ubuntu versions, with the other nine checks unaffected. |
| 4 | `runDiscovery` collects hostname/distro/OS version/arch/CPU/RAM/disk/uptime/Docker+version over one reused connection via fixed templates; unsupported OS is flagged without blocking the rest | ✓ VERIFIED | `packages/ssh/src/commands/allowlist.ts` + `allowlist.test.ts`: exactly 11 fixed templates, no `${`/backtick/`$(` in any of them, `commandFor` arity 1. `run-discovery.ts` runs all 11 sequentially over the one injected `SshSession`, never calls `session.close()`. D-11 confirmed in `packages/domain/src/server/connection-result.ts`: `UNSUPPORTED_OS: 'CONNECTED'` mapping present. `discovery.test.ts`'s "full discovery" test cross-checks all facts against an independent `container.exec` oracle (not the 02-04 fixtures) on both Ubuntu versions. |
| 5 | Testcontainers integration suite covers, for both Ubuntu versions: success, invalid credentials, invalid host, network timeout, command timeout, connection loss, reconnect, safe command execution, with cleanup and redaction | ✓ VERIFIED | 8 integration test files under `tests/integration/ssh/` (1,887 lines) implement all 8 §6.5 scenarios; re-ran `pnpm test:integration` from scratch in this session: **208/208 tests passed + 1 intentionally skipped, exit 0**; `docker ps -aq --filter label=noodara.test=true \| wc -l` → **0** after the run. `discovery.test.ts`'s SEC-05 canary test proves a real per-run password never appears in stdout/stderr/check details/serialised snapshot/failure messages, for both a successful and a failed auth attempt. |

**Score:** 5/5 roadmap success criteria verified

### Required Artifacts

| Artifact | Expected | Status | Details |
|----------|----------|--------|---------|
| `packages/ssh/src/host-verifier.ts` + `fingerprint.ts` | TOFU verifier, no bypass, `SHA256:` fingerprint format | ✓ VERIFIED | Read in full; no `insecure`/`allowMismatch`/`strict:false` option exists; `computeFingerprint` produces exact `ssh-keygen -lf` format, cross-checked in `contracts.test.ts`. |
| `packages/ssh/src/error-classifier.ts` | Exhaustive 7-code classification, never throws | ✓ VERIFIED | All 7 codes reachable by name; wrapped in nested try/catch; unit-tested with hostile inputs (throwing `message` getter per SUMMARY). |
| `packages/ssh/src/commands/allowlist.ts` | 11 fixed templates, no interpolation | ✓ VERIFIED | Read in full; `escapeShellArg` quotes only, rejects nothing (documented Dokploy-CVE-avoidance rationale). |
| `packages/ssh/src/run-discovery.ts` | Single-connection, 11-step sequence, partial-failure tolerant | ✓ VERIFIED | Read in full; D-08 budget check, D-12 Docker warning handling, D-13 not_applicable-for-root logic all present and match 02-CONTEXT.md decisions. |
| `packages/ssh/src/ssh2-adapter.ts` | `SshPort` implementation, D-10 retry, mutex, no unhandled events | ✓ VERIFIED | Read in full; persistent `error`/`close` listener attached before `connect()`; `withRetry`/`createConnectionMutex` wired correctly (mutex outside, retry inside). |
| `apps/control-plane/src/db/migrations/0002_phase2_fingerprint_timestamps.sql` | D-06 fingerprint timestamp columns | ✓ VERIFIED | `ALTER TABLE servers ADD COLUMN IF NOT EXISTS host_fingerprint_captured_at` / `pending_fingerprint_seen_at`, both nullable, no default. |
| `docs/adr/0004-ssh-adapter-empirical-contracts.md` | Measured ssh2 error/hostVerifier/mid-exec-death shapes | ✓ VERIFIED | Read; documents real measurements (hostVerifier raw-blob contract, RSA `ssh-rsa`/`rsa-sha2-512` wrinkle, passphrase-error message text) with a standing test in `contracts.test.ts`. |
| `tests/integration/ssh/*.test.ts` (8 files) | All 8 §6.5 scenarios × 2 Ubuntu versions | ✓ VERIFIED | Read `host-key-changed.test.ts`, `timeouts.test.ts`, `connection-loss.test.ts`, `discovery.test.ts` in full; all pass in a from-scratch run this session. |

### Data-Flow Trace (Level 4)

Not applicable in the traditional UI-rendering sense (this phase has no UI). Substituted with **end-to-end infrastructure evidence**: `runDiscovery`'s facts are independently cross-checked against a `container.exec` oracle in `discovery.test.ts` (not against the fixtures the parsers were unit-tested from), which is the SSH-adapter equivalent of a data-flow trace — it proves the parsers + orchestration produce real values from a real remote host, not hardcoded/fixture-echoed ones.

### Behavioral Spot-Checks / Full Suite Execution (re-run live in this session, not trusted from SUMMARY)

| Command | Result | Status |
|---------|--------|--------|
| `pnpm build` | exit 0 (3 packages, cached) | ✓ PASS |
| `pnpm lint` | exit 0 | ✓ PASS |
| `pnpm typecheck` (turbo + `tsc -p tests/integration/ssh/tsconfig.json`) | exit 0 | ✓ PASS |
| `pnpm exec turbo boundaries` | exit 0 — 272 files, no issues | ✓ PASS |
| `pnpm test --coverage` | exit 0 — 603/603 unit tests, 2 files/36 | ✓ PASS |
| `pnpm test:integration` | exit 0 — **208/208 passed + 1 skipped (24/24 + 1 files)**, re-run from scratch this session | ✓ PASS |
| `docker ps -aq --filter label=noodara.test=true \| wc -l` | `0` after the run | ✓ PASS |
| `pnpm audit --audit-level=high` | exit 0 — 1 moderate, 0 high/critical | ✓ PASS |
| `pnpm security:scan-leaks` | exit 0 — 1/1 canary test passed | ✓ PASS |
| `packages/domain` coverage (computed manually from `coverage/coverage-summary.json` since the text/lcov reporter omits the `packages/*` rows — see Anti-Patterns below) | **100% statements / 100% branches** across all 18 domain files touched by this phase | ✓ PASS |
| `packages/domain` purity re: `ssh2` | `grep -rn "ssh2" packages/domain/src` → no results | ✓ PASS |

### Requirements Coverage

| Requirement | Source Plan(s) | Description | Status | Evidence |
|-------------|----------------|--------------|--------|----------|
| SERV-07 | 01, 06, 07, 08, 10 | Error `error_code` per fallo, API nunca cae | ✓ SATISFIED | Exhaustive classifier + never-throws wrapper + real-container proof (timeouts/connection-loss tests) |
| SERV-08 | 02, 09, 10 | sudo -n / docker group check, no-root, reportado por check | ✓ SATISFIED | `access.ts` commands + `run-discovery.ts` not_applicable-for-root + real root/deployer/restricted matrix in `discovery.test.ts` |
| SEC-03 | 03, 04, 06, 08, 10 | TOFU fingerprint fijado, HOST_KEY_CHANGED hasta reconfirmación | ✓ SATISFIED | `host-verifier.ts` no-bypass + `contracts.test.ts` byte-identical fingerprint + full lifecycle in `host-key-changed.test.ts` |
| SEC-04 | 01, 03, 07, 08 | Allowlist sin interpolación, timeout explícito por comando/conexión | ✓ SATISFIED | `allowlist.ts`/`allowlist.test.ts` exactness guard + `exec-with-timeout.ts` independent timer + `@ts-expect-error` compile-time guard in `connect.test.ts` |
| SEC-05 | 07, 09, 10 | stdout/stderr redactados antes de persistir/mostrar | ✓ SATISFIED | `exec-with-timeout.ts` redacts+truncates before `ExecResult` exists; `discovery.test.ts`'s canary test proves a real password never leaks |
| DISC-01 | 04, 05, 09, 10 | hostname/distro/versión/arch/CPU/RAM/disco/uptime/Docker con parsers testeados | ✓ SATISFIED | Real captured fixtures (`scripts/capture-discovery-fixtures.mjs`) + parsers ≥95% branch + independent oracle cross-check in `discovery.test.ts` |
| DISC-04 | 05, 09, 10 | UNSUPPORTED_OS como warning, no bloquea el resto | ✓ SATISFIED | D-11 remapping in `connection-result.ts` (`UNSUPPORTED_OS: 'CONNECTED'`) + `os_release` step always reports `pass` with the warning attached |
| QA-03 | 02, 04, 10 | Testcontainers ambas versiones, 8 escenarios, limpieza | ✓ SATISFIED | 8 `tests/integration/ssh/*.test.ts` files, re-run in this session: 208/208 green, 0 stray containers after |

All 8 phase requirement IDs declared across the 10 plans' frontmatter match exactly the 8 IDs listed in `.planning/ROADMAP.md` Phase 2 and `.planning/REQUIREMENTS.md`'s traceability table (all marked "Complete"). No orphaned requirements found.

### Anti-Patterns Found

| File | Line | Pattern | Severity | Impact |
|------|------|---------|----------|--------|
| `vitest.config.ts` coverage text reporter | n/a | `packages/domain/**` rows never printed by the text/lcov reporter, even though the underlying `coverage-summary.json` correctly measures and gates it | ℹ️ Info | Cosmetic reporting gap only — independently confirmed in this session (`coverage/coverage-summary.json` shows 100%/100% for all 18 touched domain files, `total` key present). Documented honestly in `deferred-items.md` (02-01) as investigated-and-confirmed-pre-existing, not introduced by this phase, and out of this phase's scope. Not a blocker. |
| `tests/integration/ssh/contracts.test.ts` `.invalid`-TLD row | n/a | Resolver-dependent flake found during 02-08, already fixed by commit `3ab3aff` ("make the .invalid-TLD contract test resolver-agnostic") before phase close | ℹ️ Info | Resolved within-phase; `deferred-items.md` documents the RESOLVED status with the fixing commit hash. Verified fix is present in current `contracts.test.ts` (full suite green in this session). |
| — | — | No `TBD`/`FIXME`/`XXX`/`HACK`/`PLACEHOLDER` markers found | — | `grep -rn "TBD\|FIXME\|XXX"` across `packages/ssh/src`, `packages/domain/src/discovery`, `tests/integration/ssh`, and the migration file returned zero matches. |

No blocker-level anti-patterns found.

### Human Verification Required

None required to close this phase. Two items are explicitly deferred (by the phase's own validation contract, not by this verification) to later, non-blocking milestones and are recorded here for visibility only — they do not gate `passed` status:

1. **Cold-cache `pnpm test:integration` runtime on a clean Docker host.** Not measured in this session either (this machine's Docker cache is already warm from the phase's own recent runs). 02-VALIDATION.md and 02-10-SUMMARY.md both document this as intentionally unmeasured on a shared dev machine, with the same honest "not measured" recorded rather than invented — this belongs to the phase 6 / nightly-CI release-gate scope per the roadmap, not to Phase 2's success criteria.
2. **First real GitHub Actions run of the `integration` CI job.** Only measured locally in this environment (twice, in this verification and in 02-10's own close-out). The workflow file documents cold-runner behavior in a comment but has not yet executed on `ubuntu-latest` infrastructure. Not a Phase 2 success criterion.

### Deferred Items (from `deferred-items.md`, re-confirmed in this session)

Neither item blocks phase closure; both were independently re-investigated above.

| Item | Status at close | Re-verified here |
|------|------------------|-------------------|
| `pnpm test --coverage` text/lcov reporter omits `packages/*` rows | Confirmed pre-existing, not introduced by this phase, `packages/domain` threshold still gates the real (unprinted) numbers | Yes — `coverage-summary.json` computed manually: 100%/100% |
| `contracts.test.ts` `.invalid`-TLD resolver-dependent flake | RESOLVED (commit `3ab3aff`), ADR 0004 carries a post-spike note | Yes — full suite green in this session, no such failure occurred |

## Gaps Summary

None. All 5 roadmap success criteria are verified against live re-execution of the full test suite (unit + Testcontainers integration) in this verification session, not merely against SUMMARY.md claims. Every one of the 8 phase requirement IDs is independently traceable to real, substantive, wired code read in full during this verification (TOFU verifier, exhaustive error classifier, frozen command allowlist, discovery orchestration, ssh2 adapter with retry/mutex). The `packages/domain` purity boundary (no `ssh2` import) and the `ssh2`-containment boundary (only `packages/ssh` imports it) both hold, confirmed by a fresh `pnpm exec turbo boundaries` run and a direct grep. Zero `noodara.test=true` containers survived the full integration run. No debt markers (`TBD`/`FIXME`/`XXX`) exist in any file this phase touched.

---

*Verified: 2026-09-15T19:49:32Z*
*Verifier: Claude (gsd-verifier)*
