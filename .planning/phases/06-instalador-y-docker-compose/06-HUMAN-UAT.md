---
status: partial
phase: 06-instalador-y-docker-compose
source: [gate-logs/HEAD.txt, gate-logs/summary.tsv, gate-logs/01-lint.log..11-security-scan-leaks.log, 06-13-SUMMARY.md, 06-14-SUMMARY.md, 05-HUMAN-UAT.md]
started: 2026-09-21T14:07:00Z
updated: 2026-09-21T20:30:00Z
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

## Human prerequisites

These are the actions D-02 ("no plan creates a repository, a remote, a tag or a push — the first
real release is a human action") and D-18 layer 3 ("manual VPS validation as the phase's closing
gate") reserve for the human operator. No agent in this phase performed, or could perform, any of
them. Every result field below is left **empty** for the operator to fill in.

`QA-04` and `QA-05` (`.planning/REQUIREMENTS.md`, both `Pending` since Phase 5 for lack of a
remote) are cleared only once item 9 below actually happens: QA-04 needs a real, scheduled or
`workflow_dispatch` `nightly.yml` run whose `e2e-repeat`/`stress-connections` jobs report a real
20/20 and a real 100/100; QA-05 needs a real `nightly.yml`/`ci.yml` run whose `canary`/`security`
jobs pass the secret-leakage scan as an actual GitHub Actions execution, not a local one. Nothing
below substitutes for that.

| # | Item | Result |
|---|---|---|
| 1 | **Extract `noodara/code` into its own Git repository.** Today it is a nested subdirectory of a personal monorepo (`~/work/myself`) — no workflow under `noodara/code/.github/` can evaluate any trigger (`push`, `schedule`, tag) until the code lives at the root of its own repository. Create the GitHub repository and push `main` to it. | done 2026-09-22 — `noodara/code` extracted with `git subtree split` (795 commits, one author, the 26 `Co-Authored-By` trailers of phases 4–5 stripped in the extracted branch only), pushed to `git@github.com:Nooodara/noodara.git`; repository made public by the user on 2026-09-22. |
| 2 | **Replace the placeholder `REPLACE_WITH_GITHUB_OWNER` everywhere it appears, in one search-and-replace, with the real GitHub owner.** Confirmed present in exactly three files: `install.sh` (`NOODARA_REPO_OWNER` default, line 41), `docs/install.md`, and `README.md` (`grep -rl REPLACE_WITH_GITHUB_OWNER . --include='*.md' --include='*.sh'`, excluding `.planning/` and `node_modules/`, found only these three). The repository name does **not** need a placeholder replacement — `install.sh`'s `NOODARA_REPO_NAME` already defaults to the literal `noodara` (line 42), so this step is owner-only. Re-run `pnpm test` afterward: `tests/unit/docs/install-docs-accuracy.test.ts` pins the script and the docs to the same owner string and will fail if they disagree. | done 2026-09-22 — `nooodara` (the real organization slug has three o's) set in `install.sh`, `docs/install.md`, `README.md` (commit `e9e227b`); the docs-accuracy test now derives the rollback command's owner from `install.sh` rather than repeating a placeholder. |
| 3 | **Push a `vX.Y.Z` tag and let `release.yml` build and publish both images.** Every third-party action in `release.yml`/`ci.yml`/`nightly.yml` is already pinned to a real commit SHA (`scripts/check-workflow-pins.mjs` reports all three files clean; no `TODO(06-15)` placeholder remains anywhere in `.github/workflows/`) — there is no leftover SHA to resolve before this step. What genuinely cannot be known until a real run happens (verbatim from `06-13-SUMMARY.md`'s own "What Cannot Be Verified Without a Real GitHub Run" list): whether the tag-push trigger fires at all; whether `docker/build-push-action` actually succeeds building `apps/control-plane`'s and `apps/web`'s native addons (argon2, ssh2's optional `cpu-features`) on a real `ubuntu-24.04-arm` GitHub-hosted runner (only ever built locally on this machine's own Docker Desktop VM); whether `docker buildx imagetools create` combining two real per-arch GHCR pushes actually produces a manifest `docker manifest inspect` reports both architectures for; whether the `installer` jobs' 60-minute timeout is enough on a real (likely slower, fewer-core) `ubuntu-latest` runner versus this session's 14-core dev machine measurement; whether `DOCKER_CLI_EXPERIMENTAL=enabled` is actually needed on GitHub's runner image for `docker manifest inspect` to work. Consider exercising the `workflow_dispatch` manual dry run first, as `06-RESEARCH.md`'s own Open Question 1 recommends. | done 2026-09-22 — tag `v0.1.0` pushed; `release.yml` run 35692383407 green end to end in ~2 min: four native builds (the arm64 control-plane build with argon2/ssh2 included), both multi-arch manifests, both `verify` jobs. |
| 4 | **Make both GHCR packages public.** A newly published GHCR package is **private by default**; `install.sh` pulls anonymously (`docker pull`, no login step anywhere in the script). Until both `ghcr.io/<owner>/noodara-control-plane` and `ghcr.io/<owner>/noodara-web` are switched to public in GitHub's package settings, every real install fails on `docker pull` with `noodara: image-pull-failed` (exit code **50**). | done 2026-09-22 — both packages public (the org's Packages policy had public creation disabled; the user enabled it, then flipped each package). Verified from outside: anonymous manifest GET → HTTP 200 for both `:0.1.0`, each listing linux/amd64 + linux/arm64; a real anonymous `docker pull ghcr.io/nooodara/noodara-web:0.1.0` succeeded. |
| 5 | **Publish a real, non-prerelease GitHub Release for that tag.** `install.sh`'s `noodara_resolve_version` (when `NOODARA_VERSION` is not set) resolves the default version through a redirect from `https://github.com/<owner>/<repo>/releases/latest`, and only accepts a redirect landing on `/releases/tag/<tag>` — a tag with no published Release, or a Release marked "pre-release," does not satisfy this and the default install path fails with `noodara: version-resolution-failed` (exit code **40**). The operator can still work around this by passing `NOODARA_VERSION=<tag>` explicitly, but the documented default `curl \| sh` command depends on a real, non-prerelease Release existing. | done 2026-09-22 — GitHub Release `v0.1.0` published (not a prerelease, marked latest). Verified with the real `noodara_fetch_url redirect` → `…/releases/tag/v0.1.0` and `noodara_resolve_version` → `0.1.0`. |
| 6 | **Confirm the raw URL the docs advertise serves the script from the default branch.** `docs/install.md`/`README.md` publish `curl -fsSL https://raw.githubusercontent.com/<owner>/noodara/main/install.sh \| sh`; confirm that URL actually resolves to the pushed `install.sh` on `main` once the repository exists (item 1) and the placeholder (item 2) is replaced. | done 2026-09-22 — `https://raw.githubusercontent.com/nooodara/noodara/main/install.sh` → HTTP 200. |
| 7 | **Real `curl \| sh` end to end, on a clean Ubuntu 22.04 VPS, a clean Ubuntu 24.04 VPS (both amd64), and once on an arm64 host — with `ufw` active on at least one of them.** For each: run the published command; record the printed panel URL and setup token; open the panel and redeem the token to create the admin over plain HTTP; then follow the documented TLS procedure (put a reverse proxy in front, set `NOODARA_PUBLIC_URL=https://…`, remove `NOODARA_COOKIE_INSECURE`, apply with `docker compose … up -d`) and confirm cookies become `Secure`. Then, on the same VPS: re-run the installer with nothing changed and confirm it is a true no-op (D-09); bump to a newer tag if one exists and confirm a real upgrade (`.env`/volumes preserved, `.env.bak-<timestamp>` written); with `ufw` active, confirm the advisory appears, the suggested `ufw allow <port>/tcp` command is correct, **and check for real whether the published Docker port is in fact reachable from outside despite `ufw`** — `docs/install.md`'s "typically bypass" wording must be confirmed or corrected against what you actually observe, not left as inherited research. On the arm64 host specifically, confirm `argon2` and `ssh2`'s native bindings actually load (D-16's named risk) — this is the one item item 3's build-time check cannot itself confirm at runtime. | partially done 2026-09-22 — the user ran the published `curl -fsSL https://raw.githubusercontent.com/nooodara/noodara/main/install.sh \| sh` on a clean real Ubuntu **24.04** VPS (architecture not reported): the install completed with no failure, the panel URL and the setup token were shown and the panel worked (reported verbatim: "se instaló exitosamente, no falló nada y todo se mostró bien"). A second run of the same command printed `Already on version 0.1.0` (the same-version no-op). Still pending from this item: a clean 22.04 VPS, an arm64 host, a host with `ufw` active, a real upgrade to a later release and its rollback, and the documented TLS procedure. |
| 8 | **Watch real memory behaviour on a small (1–2 GB) production-sized VPS.** `docker-compose.yml`'s `postgres` memory cap was raised to 512M after a load measurement showed a 192M cap OOM-killing a backend on a single bulk write; a later stress of 10 concurrent heavy sorts with no swap still killed a backend at 512M on the dev machine used for that measurement. On the real target VPS, run `docker stats` and `dmesg \| grep -i oom` under ordinary use (not synthetic stress) and record whether any container gets OOM-killed at the shipped memory limits. | [pending] |
| 9 | **The first real `ci.yml` run and the first real `nightly.yml` run, and `gitleaks` on the extracted repository.** `ci.yml`'s `installer` job (push-to-main only) and every job in `nightly.yml` (`e2e-repeat` ×20, `stress-connections` — the real §6.7 100-cycle suite this gate's Task 1 skipped by design, `canary`, `installer`) have never executed as real GitHub Actions runs — `on: schedule` and `push` triggers are inert for a workflow file that has never lived on a pushed repository's default branch (this is `nightly.yml`'s own header-comment caveat, carried since Phase 5). **QA-04 and QA-05 are re-evaluated against whatever these real runs actually produce** — not assumed green because the local equivalents were green. Note for the human: the gate logs this phase committed (`gate-logs/08-test-integration.log`, two lines) already had ephemeral test setup tokens masked before commit for exactly this reason (see "Gate run" above); Phase 5's own committed gate logs (`.planning/phases/05-ui-web/gate-logs/test-integration*.log`) were **not** similarly masked and may still contain ephemeral test setup tokens that a secret scanner could flag as false positives — decide whether to mask those too before `gitleaks`/the repository goes public. | partially done 2026-09-22 — `ci.yml` green 9/9 on run 35679687131 (installer 51/51 in 32 min, integration 523 + 1 skip, e2e 93, security incl. gitleaks range + full tree). It took five runs and eight fixes to get there, all recorded in the repository history (docker-absent tests, DSA on OpenSSL 3.5, SSE backpressure ceiling, gitleaks binary + allowlist, a real sign-out race in the web app, an unroutable TEST-NET host for the late-GET e2e, runner disk reclaim 13→47 GB, harness self-test pulling its base image). `nightly.yml`: first scheduled run (35703058235) had `stress-connections`, `canary` and `installer` green and `e2e-repeat` stopped at iteration 10/20 on a Docker fixed-port race (fixed in the sshd fixture); the manual re-run on the fix (35762472061) gave `e2e-repeat` 20/20 with 93/93 each — QA-04 and QA-05 both closed for real. |
| 10 | **The six items unconfirmed from `05-HUMAN-UAT.md`**, carried forward unresolved: (1) real visual quality of the new contrast tokens on an actual display, both themes; (2) theme-toggle persistence/no-flicker on reload in a real browser; (3) a full live walkthrough over a real reverse proxy (not a buffering Cloudflare Quick Tunnel) with SSE genuinely visible; (4) the revoked-session-redirects-a-second-open-tab half of test 4 (the trust-new-fingerprint half was partially verified by the user with screenshots; the CR-01 UI dead end it surfaced was fixed by quick task `260921-13a` but the *fix itself* has still never been seen live by a human — repeat the same steps and confirm a Retry button now appears and reaches Connected); (5) Sheet/Dialog/RowMenu flat-hairline elevation judged against the design skill on a real display; (6) RowMenu with a real screen reader, responsive layout on real touch hardware below 1280px, and `prefers-reduced-motion`'s felt effect. | [pending] |

## Checkpoint decision (Task 3)

**Date:** 2026-09-21
**Checkpoint:** Plan 06-15, Task 3 — "User review of the v0.1 gate and the human prerequisite list" (`type="checkpoint:human-verify"`, `gate="blocking"`).
**User's verbatim choice:** "Aceptar con deuda (Recomendado)" — the plan's own resume-signal option to accept the phase as complete with the remaining human prerequisites tracked as verification debt, the same path phase 5 took at its own closing checkpoint (`05-46-GATE.md`).

The user gave no statement about having personally performed or reviewed any individual item in the "Human prerequisites" table above. Per this plan's own Task 3 acceptance criteria ("If the decision is to accept with debt, the remaining unperformed prerequisites are recorded verbatim in the plan SUMMARY and carried into `.planning/STATE.md` exactly as phase 5's debt was"), **none of the ten `[pending]` result fields above is changed by this decision** — every one of the ten human prerequisites remains exactly as unperformed as it was when Task 2 wrote it. "Accept with debt" is a decision about how to close the *plan* (and, pending the verifier, the phase), not a claim that any prerequisite was done.

`docs/releases/v0.1-gate.md`'s overall verdict stays `NOT READY`. Nothing in this repository was pushed, tagged, released or installed on a real VPS as a result of this decision — `git remote -v` still prints nothing for this project (confirmed again at this checkpoint).
