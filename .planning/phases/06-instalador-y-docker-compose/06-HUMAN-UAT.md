---
status: partial
phase: 06-instalador-y-docker-compose
source: [gate-logs/HEAD.txt, gate-logs/summary.tsv, gate-logs/01-lint.log..11-security-scan-leaks.log]
started: 2026-09-21T14:07:00Z
updated: 2026-09-21T19:50:00Z
---

# Phase 6 — Human UAT

This is the closing human-verification file for v0.1. It has two parts: the **Gate run**
(Task 1 — every automated gate this repository has, run once, raw output recorded) and the
**Human prerequisites** (Task 2 — the actions D-02 and D-18 layer 3 reserve for a human, which
no agent in this phase performed or could perform).

## Gate run

**Who ran this and when:** the phase orchestrator, in a single uninterrupted session on
2026-09-21, against `HEAD ad951b58027c2b37d8af69a2689b191435514662` (recorded verbatim in
`gate-logs/HEAD.txt`), with `NOODARA_API_ORIGIN=http://localhost:3100` exported for the whole
session, matching the CI workflows' own convention. **This executor agent (Plan 06-15) did not
run any of the eleven commands below** — hard_rule #4 of this plan's own execution explicitly
forbids re-running them, to avoid mixing a fresh partial run with the orchestrator's single
consistent single-HEAD record. Every row below was reconstructed by reading the raw log file for
that command in `.planning/phases/06-instalador-y-docker-compose/gate-logs/` and reading the
counts directly out of each tool's own summary line — not copied from `summary.tsv`'s
already-rounded durations, which are cited only for wall-clock time.

| # | Command | Exit | Counts (as printed by the tool) | Duration | Stray `noodara.test=true` containers |
|---|---|---|---|---|---|
| 1 | `pnpm lint` | 0 | 9 tasks successful, 9 total (turbo, 6 packages) | 4.579s (log) / 5s (summary.tsv) | 0 |
| 2 | `pnpm typecheck` | 0 | 8 tasks successful, 8 total (turbo + 3 extra `tsc -p` invocations for `tests/integration/ssh`, `tests/e2e`, `tests/integration/installer`) | 1.965s (log) / 5s (summary.tsv) | 0 |
| 3 | `pnpm boundaries` | 0 | "Checked 617 files in 6 packages, no issues found" | 0s (summary.tsv; no separate timing in the log) | 0 |
| 4 | `pnpm check:ui-safety` | 0 | 8/8 OK checks (dangerouslySetInnerHTML, JSON.stringify, hex/rgb literals, `outline: none`, Radix overrides, animate-spin, `credentials: 'include'`, `@noodara/ui/testing` import scope) | 0s (summary.tsv) | 0 |
| 5 | `pnpm check:posix-sh` | 0 | "install.sh clean (2224 lines)" | 0s (summary.tsv) | 0 |
| 6 | `pnpm test` (unit) | 0 | **Test Files 128 passed (128)** / **Tests 2161 passed (2161)** | 11.71s (log) / 12s (summary.tsv) | 0 |
| 7 | `pnpm test:boot` | 0 | **Test Files 1 passed (1)** / **Tests 7 passed (7)** | 60.36s (log) / 61s (summary.tsv) | 0 |
| 8 | `pnpm test:integration` | 0 | **Test Files 59 passed \| 1 skipped (60)** / **Tests 523 passed \| 1 skipped (524)** | 2614.83s (log) / 2616s (summary.tsv) | 0 |
| 9 | `pnpm test:installer` | 0 | **Test Files 10 passed (10)** / **Tests 51 passed (51)** | 2058.44s (log) / 2060s (summary.tsv) | 0 |
| 10 | `pnpm test:e2e` | 0 | **93 passed** (Playwright, single worker) | ~1.6min in-log / 95s (summary.tsv) | 0 |
| 11 | `pnpm security:scan-leaks` | 0 | vitest: **Test Files 3 passed (3)** / **Tests 3 passed (3)**; Playwright `--grep @canary`: **1 passed** | 24.43s (vitest) + separate Playwright run / 36s total (summary.tsv) | 0 |

Every one of the eleven commands above exited 0, every printed count is greater than zero, and
`docker ps -aq --filter "label=noodara.test=true"` printed nothing after every Docker-using suite
(recorded as `strays=0` for all eleven rows in `gate-logs/summary.tsv`). **The gate is green.**

### The one skipped test

`pnpm test:integration` reports 1 skipped test file and 1 skipped test. It is
`tests/integration/ssh/stress-connections.test.ts`'s `describe.skipIf(!STRESS_ENABLED)('§6.7
stress: 100 consecutive successful connections', …)` — the roadmap §6.7 "100 conexiones exitosas
consecutivas" suite, deliberately excluded from the PR-blocking path since Phase 2
(`02-adaptador-ssh-aislado-y-probado-con-testcontainers/02-VALIDATION.md`'s "Manual-Only
Verifications" table, and the file's own header comment) and gated behind
`NOODARA_STRESS=1|true`. **This gate run did not set `NOODARA_STRESS`, so the suite reported
skipped, not executed** — its 100-cycle result is not part of this evidence. It is the same
pre-existing, documented skip Phase 2's own `02-VERIFICATION.md` recorded ("208/208 passed + 1
intentionally skipped"); no new skip was introduced by this phase. See "Human prerequisites"
item 9 below for where the real 100-cycle run belongs.

### Observations (not failures)

- **132 `"sse broadcaster subscriber redis error"` / `"sse broadcaster failed to start within the
  boot window"` WARN-level (`"level":40`) log lines appear across `08-test-integration.log` and
  `11-security-scan-leaks.log`** (grep count: 132 total across both files; 15 of those in
  `11-security-scan-leaks.log`, including exactly 1 `"sse broadcaster failed to start within the
  boot window"` line). These are pino WARN entries emitted by boot-timing races in
  ephemeral-per-test Fastify instances connecting to a fresh, just-started Testcontainers Redis —
  expected under this workload, not an application crash. **No test failed because of them**: both
  `08-test-integration.log` and `11-security-scan-leaks.log` end in a clean, all-green summary
  (see the Gate run table above). Recorded here as observed, per this plan's own instruction,
  neither dismissed as ambient noise nor treated as a red result.
- **One disclosed edit to the evidence:** `08-test-integration.log` contains two lines reading
  `NOODARA_SETUP_TOKEN=<redacted-ephemeral-test-token>` (lines 2322 and 2339) where the
  orchestrator manually masked two real, ephemeral setup-token values a test boot printed to
  stdout, before committing this log to a repository that will eventually go public. These were
  throwaway per-test-run tokens with no standing validity beyond that single test process; masking
  them changes no test's pass/fail result. No other secret-shaped value was found (see next
  section).
- **Secret-shaped-string scan performed before staging the logs:** grepped all eleven raw logs for
  `://user:pass@`-style credentialed URLs (zero matches), for 64-hex strings not immediately
  preceded by a `sha256:` prefix (zero genuine matches — the apparent matches in
  `09-test-installer.log` lines 94-95, 153-156, 174-175, 232-235 are all Docker image/manifest
  digests correctly prefixed `sha256:`; a naive regex without the prefix check flagged them, but
  reading each line in context confirms every one is `docker.io/library/node:22-slim@sha256:…` or
  a `buildx` `exporting manifest/config/attestation` line — ordinary, non-secret build output), and
  for generic `token`/`password`/`secret` assignment lines with a real-looking value (only the two
  `NOODARA_SETUP_TOKEN` lines above, already masked). No unmasked secret was found in any of the
  eleven logs.
