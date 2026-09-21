---
phase: 06-instalador-y-docker-compose
verified: 2026-09-21T21:30:00Z
status: human_needed
score: 17/17 must-haves verified (code-provable truths); 10 items require a human with a GitHub account and a VPS
overrides_applied: 0
human_verification:
  - test: "Extract noodara/code into its own Git repository and push main to it."
    expected: "The repository exists on GitHub; push/schedule/tag triggers can be evaluated for the first time."
    why_human: "D-02 — no plan in this phase created a repository, a remote, a tag or a push; this is a human-only action outside any agent's permission."
  - test: "Replace REPLACE_WITH_GITHUB_OWNER (install.sh:41, docs/install.md, README.md) with the real GitHub owner, then re-run pnpm test."
    expected: "tests/unit/docs/install-docs-accuracy.test.ts stays green with the real owner pinned in all three files."
    why_human: "The real GitHub owner identity is not knowable or settable by an agent."
  - test: "Push a vX.Y.Z tag and let release.yml build and publish both images as a real GitHub Actions run (or exercise workflow_dispatch as a manual dry run first)."
    expected: "Both ghcr.io/<owner>/noodara-control-plane and ghcr.io/<owner>/noodara-web are published as multi-arch (amd64+arm64) manifests at the tag."
    why_human: "Requires a real GitHub Actions execution against a real repository; unverifiable locally (docker/build-push-action on a real ubuntu-24.04-arm runner, docker buildx imagetools create against two real pushed images, DOCKER_CLI_EXPERIMENTAL behavior on GitHub's runner image)."
  - test: "Make both GHCR packages public."
    expected: "install.sh's anonymous docker pull succeeds instead of failing with image-pull-failed (exit 50)."
    why_human: "GitHub package visibility settings are a human, one-time action; a fresh GHCR package is private by default."
  - test: "Publish a real, non-prerelease GitHub Release for the pushed tag."
    expected: "install.sh's default noodara_resolve_version (redirect from /releases/latest) resolves successfully instead of failing with version-resolution-failed (exit 40)."
    why_human: "Requires a real GitHub Release, which only a human with repo admin rights can publish."
  - test: "Confirm the raw script URL (https://raw.githubusercontent.com/<owner>/noodara/main/install.sh) actually serves the pushed install.sh."
    expected: "curl -fsSL <url> returns the real script."
    why_human: "Depends on items 1 and 2 above having actually happened on GitHub."
  - test: "Run the real curl | sh end to end on a clean Ubuntu 22.04 VPS, a clean 24.04 VPS, and once on arm64, with ufw active on at least one."
    expected: "Panel comes up, setup token redeems, TLS-via-reverse-proxy procedure works and cookies become Secure, a same-version re-run is a true no-op, a version-bump re-run is a real upgrade with .env.bak-<timestamp> written, ufw advisory appears and the real bypass behavior is confirmed, arm64 argon2/ssh2 native bindings load."
    why_human: "Requires a real, internet-reachable VPS; the DinD suite proves the same install.sh logic inside privileged local containers with locally built images, not a real docker pull from GHCR on real hardware."
  - test: "Watch real memory behaviour (docker stats, dmesg | grep -i oom) on a small (1-2 GB) production-sized VPS under ordinary use."
    expected: "No container gets OOM-killed at the shipped docker-compose.yml memory limits."
    why_human: "Memory limits were derived from measurements on the development machine only; real VPS behavior under real load is unverifiable without one."
  - test: "The first real ci.yml push-to-main run and the first real nightly.yml scheduled run, plus gitleaks on the extracted repository."
    expected: "installer/e2e-repeat/stress-connections/canary jobs all pass as real GitHub Actions executions; QA-04 and QA-05 clear."
    why_human: "on: schedule and on: push triggers are inert until the workflow file lives on a pushed repository's default branch; QA-04/QA-05 explicitly require a real run, not a local equivalent."
  - test: "The six carried-forward items from 05-HUMAN-UAT.md (real-display contrast in both themes, theme-toggle no-flicker, live SSE walkthrough without a buffering tunnel, revoked-session second-tab redirect plus a human look at the CR-01/WR-01 fix, Sheet/Dialog/RowMenu elevation, RowMenu screen-reader/touch/reduced-motion)."
    expected: "Each item observed and confirmed (or a defect filed) by a human on real hardware/displays."
    why_human: "Visual quality, screen-reader behavior and real-time SSE delivery over a non-buffering connection cannot be verified by static analysis."
---

# Phase 6: Instalador y Docker Compose — Verification Report

**Phase Goal:** "Cualquiera instala Noodara en un VPS Ubuntu 22.04/24.04 limpio con un solo comando, al nivel de simplicidad de Coolify y Dokploy, y volver a ejecutar el instalador sobre una instalación existente no destruye nada."
**Verified:** 2026-09-21T21:30:00Z, against HEAD `970a0b3619b245267d836dd1f53fc56f92809f0e`
**Status:** human_needed
**Re-verification:** No — initial verification

## Method

This report distinguishes what I personally re-executed on this machine (marked "verified live" below)
from what I took from the recorded evidence in `gate-logs/` (raw tool output, HEAD `ad951b5`,
predates the final code-review-fix commits) and `06-REVIEW-FIX.md` (its own recorded real-Docker run,
17/17, after the fixes). Per this task's explicit instructions I did **not** run
`pnpm test:installer`, `pnpm test:integration`, `pnpm test:e2e`, `pnpm test:boot`,
`pnpm security:scan-leaks`, or any Docker command myself (a closing full gate run on HEAD is being
executed by the orchestrator in parallel). I did run, myself, on this machine: `pnpm test` (2206/2206
passed), `pnpm lint` (9/9 cached, clean), `pnpm check:posix-sh` (`install.sh clean, 2344 lines`),
`sh -n install.sh` / `dash -n install.sh` (both clean), `node scripts/check-workflow-pins.mjs` against
all three workflow files (all clean), `npx vitest run tests/unit/docs/install-docs-accuracy.test.ts`
(18/18 passed), and a read-only source of `install.sh` under `NOODARA_INSTALL_SH_SOURCE_ONLY=1` into a
`mktemp -d` directory calling `noodara_place_compose_file` directly, then `diff`ed the result against
the real `docker-compose.yml` — **byte-identical**, confirming the comment in `install.sh:1493-1494`
for real rather than trusting it.

## Goal Achievement

### Observable Truths (ROADMAP Success Criteria + PLAN must_haves, code-provable subset)

| # | Truth | Status | Evidence |
|---|---|---|---|
| 1 | SC1: `curl \| sh` on a clean VPS installs Docker+Compose if missing, generates `.env` with random secrets, brings up api/worker/web/postgres/redis with Compose and applies migrations, no manual SSH step | ✓ VERIFIED (logic) | `install.sh:noodara_main` composes preflight → `noodara_ensure_docker` → env generate/merge → `noodara_place_compose_file` → pull → `docker compose up -d` → health wait → summary, matching D-09/D-10 exactly (read at `install.sh:2221-2339`). Proven end-to-end against real privileged Ubuntu 22.04/24.04 DinD containers with locally-built images in `tests/integration/installer/fresh-install.test.ts`/`preseed-admin.test.ts` (`gate-logs/09-test-installer.log`: 10 files, 51 tests, all passed, read myself — genuine raw tool output, not summarized). **Never proven against a real `docker pull` from GHCR on a real VPS** — that gap is human prerequisite item 7 below, and `docs/releases/v0.1-gate.md` itself keeps INST-01 `UNVERIFIED` for exactly this reason. |
| 2 | SC2: preflight fails with an actionable message before touching the system for unsupported OS, busy port, snap Docker, unsupported arch, insufficient RAM | ✓ VERIFIED | `noodara_preflight` (`install.sh:1432-1442`) runs root → base-commands → os → arch → resources → docker-snap → port in a fixed, documented order, each with its own numbered exit code (`noodara_exit_code_for`, `install.sh:61`), matching D-17's "only the first cause is reported" contract. Exercised against real containers in `tests/integration/installer/preflight-scenarios.test.ts` (part of the same 51/51 passing run) including the multi-cause-ordering case and the no-Docker-at-all install path. `docs/install.md`'s Troubleshooting table is pinned 1:1 against `noodara_exit_code_for`'s own codes by `tests/unit/docs/install-docs-accuracy.test.ts` (18/18, run myself). |
| 3 | SC3: re-running the installer over an existing installation detects it and updates or no-ops, without destroying data or secrets | ✓ VERIFIED | `noodara_is_installed` (`.env` existence only, D-10) gates the fresh-vs-repair/upgrade branch; a same-version healthy re-run takes the `_noodara_main_is_noop=1` path with **no** `noodara_merge_env`/`noodara_backup_env` call (confirmed by direct read, `install.sh:2265-2270`) — a true no-op, matching the documented post-fix behavior (06-09 Findings C/E) rather than the plan's original always-backup wording. A version-changing or key-missing re-run does call `noodara_merge_env` → `noodara_backup_env` (`install.sh:1017-1022`), producing the mode-600 `.env.bak-<timestamp>`. Proven with real double-runs, byte-identical-secret assertions and upgrade/failed-upgrade diagnostics in `tests/integration/installer/idempotent-rerun.test.ts` (same 51/51 passing run). |
| 4 | SC4: on completion the installer prints the panel URL and a one-time setup token; alternatively `NOODARA_ADMIN_EMAIL`/`NOODARA_ADMIN_PASSWORD` create the admin directly | ✓ VERIFIED | `noodara_print_summary` / setup-token read path exercised in `fresh-install.test.ts` (token read from the real `api` container's logs, matches `bootstrap-admin.ts`'s emitted line) and `preseed-admin.test.ts` (no token printed, admin created, neither credential appears in stdout/stderr/install.log) — same 51/51 run. `docs/install.md`'s "First login" section matches this behavior and the admin-password pre-validation (WR-04 fix) verbatim, confirmed by the docs-accuracy test suite. |
| 5 | D-03: `install.sh` is strict POSIX sh, zero bashisms, truncation-safe (function-bodies-only, single guarded dispatch at EOF) | ✓ VERIFIED (live) | `sh -n install.sh` and `dash -n install.sh` both clean (run myself). `pnpm check:posix-sh` → `install.sh clean (2344 lines)` (run myself). `install.sh:2341-2342` — the only top-level side-effecting statement is `if [ "${NOODARA_INSTALL_SH_SOURCE_ONLY:-0}" != "1" ]; then noodara_main "$@"; fi`. |
| 6 | D-01: one control-plane image runs all four production entrypoints (server/worker/migrate/CLI), non-root user | ✓ VERIFIED | `apps/control-plane/Dockerfile:69` (`USER noodara`), `CMD ["node", "dist/server.js"]`, `docker-compose.yml`'s `migrate`/`api`/`worker` services all reference the same image with different `command:`. Four-entrypoint proof in `tests/integration/installer/control-plane-image.test.ts` (part of `gate-logs/09-test-installer.log`'s 51/51). |
| 7 | D-01: web image is a Next.js standalone server, non-root, `NOODARA_API_ORIGIN` baked at build time and also carried as a runtime ENV (post-fix — obsoletes the plan's original "never a runtime variable" wording) | ✓ VERIFIED | `apps/web/Dockerfile:63-64,72` (`ARG`/`ENV NOODARA_API_ORIGIN` in the runner stage, `USER nodejs`), with the Dockerfile's own comment tracing the RED proof (proxy.ts/route.ts read it at request time). Real proxy proof in `tests/integration/installer/web-image.test.ts` (same 51/51 run). |
| 8 | D-10: production topology is six services (postgres, redis, migrate, api, worker, web), only `web` publishes a host port, data in two named volumes, no `:latest` tag anywhere | ✓ VERIFIED (live) | Read `docker-compose.yml` directly: `services:` has exactly six entries; `ports:` appears only under `web`; `volumes: noodara_postgres_data / noodara_redis_data`; every image reference is `${NOODARA_IMAGE_PREFIX}/<name>:${NOODARA_VERSION}` with a hard `:?` guard, no bare `:latest` anywhere in the file. |
| 9 | The compose file `install.sh` writes to a fresh VPS is byte-identical to the repo's own `docker-compose.yml` | ✓ VERIFIED (live, reproduced myself) | Sourced `install.sh` with `NOODARA_INSTALL_SH_SOURCE_ONLY=1`, called `noodara_place_compose_file` against a `mktemp -d` target, `diff`'d the output against the real `docker-compose.yml` — zero diff lines. |
| 10 | The dev compose file's redis healthcheck bug (Pitfall 4, `$${REDIS_PASSWORD}` with no `environment:` block) is not copied into the production file | ✓ VERIFIED (live) | Read both files: `docker-compose.dev.yml:33-34` now has `environment: REDIS_PASSWORD: ${REDIS_PASSWORD}`; `docker-compose.yml:66-67` has the same. |
| 11 | D-11 / WR-01..03: `.env` writers are atomic (temp file + checked `mv`), no writer appends directly to the live file, every failure gets its own named `env-write-failed` exit | ✓ VERIFIED | `06-REVIEW-FIX.md` WR-01/02/03 fixes read directly in `install.sh` (`noodara_env_append_if_missing`, `noodara_set_env_value`, `noodara_generate_env`'s `mkdir`), each now checked with `if ! ...; then rm -f "$tmp"; noodara_fail env-write-failed ...; fi`. Own unit suite `tests/unit/installer/env-file.test.ts` (863 lines) covers byte-identical preservation and unwritable-directory failure cases. |
| 12 | WR-05: the disk-space preflight check really walks up to the nearest existing ancestor directory, not one hard-coded level | ✓ VERIFIED | Fix + test (`tests/unit/installer/preflight.test.ts`) read directly: `disk_target="${disk_target%/*}"` loop with `/` as the floor. |
| 13 | WR-04: `install.sh` pre-validates the admin password (length ≥12, not-equal-identifier) before writing anything, on both the fresh-install and repair-revalidation paths, before the control plane's later common-password check | ✓ VERIFIED | `noodara_validate_admin_password_policy` called from `noodara_generate_env` (fresh install) and from `noodara_main`'s repair branch (`install.sh:2284-2286`, reading `.env`'s own recorded email/password, never the shell env, matching D-11). `PASSWORD_MIN_LENGTH` guard-tested against the real TS constant per `06-REVIEW-FIX.md`. |
| 14 | WR-08: `vitest.installer.config.ts` / `vitest.integration.config.ts` fail loudly (never silently pass) on a filter/glob typo | ✓ VERIFIED (live) | Read both files directly: `passWithNoTests: false` present in both, `grep` confirms no `passWithNoTests: true` remains. |
| 15 | Release pipeline publishes both images as a genuine multi-arch (amd64+arm64) manifest, built on native runners, with least-privilege permissions and every third-party action SHA-pinned | ✓ VERIFIED (structural, live) | `.github/workflows/release.yml` read directly: matrix covers `ubuntu-latest`/`ubuntu-24.04-arm` per image, a `manifest` job runs `docker buildx imagetools create`, a `verify` job asserts both architectures via `docker manifest inspect`. `node scripts/check-workflow-pins.mjs .github/workflows/release.yml .github/workflows/ci.yml .github/workflows/nightly.yml` → all three "clean" (run myself). **Never executed as a real GitHub Actions run** — D-02, tracked as human prerequisite item 3. |
| 16 | Installer suite (`pnpm test:installer`) is wired into `ci.yml` (push-to-main only) and `nightly.yml` (unconditional), not into every PR | ✓ VERIFIED (live) | `.github/workflows/ci.yml:415-416` (`if: github.event_name == 'push' && github.ref == 'refs/heads/main'`), `.github/workflows/nightly.yml:145-146` (unconditional `installer` job) both read directly. |
| 17 | Documentation (`docs/install.md`, `README.md`, ADR 0007) matches what `install.sh` actually does — exit codes, ufw wording, env var placement in piped commands, `.env` edit requires `docker compose ... up -d` not a re-run, `NOODARA_API_ORIGIN` correctly left undocumented as a test-only/fixed build value | ✓ VERIFIED (live) | `npx vitest run tests/unit/docs/install-docs-accuracy.test.ts` → 18/18 passed, run myself; this suite reads `install.sh`'s own exit-code table, ufw wording, and `docs/install.md`'s password-policy section directly from the live files, not from memory. Read `docs/install.md` in full myself: the "Supported variables" section correctly omits `NOODARA_API_ORIGIN` (D-19), the "Plain HTTP warning" section correctly documents applying a `.env` edit via `docker compose -f ... up -d` rather than a re-run (06-14 post-fix), and `/login` (referenced in the Troubleshooting `curl -I` example) exists at `apps/web/src/app/login`. |

**Score:** 17/17 code-provable must-haves VERIFIED.

### Human-Dependent Reality (not a code gap)

The literal phase goal — a real `curl | sh` on a real clean VPS, pulling real images from a real,
public GHCR registry — has never been executed. By decision D-02, no plan in this phase pushed,
created a remote, tagged, or published an image. `install.sh` still contains the placeholder owner
`REPLACE_WITH_GITHUB_OWNER` (confirmed present in exactly `install.sh:41`, `docs/install.md` (5
occurrences), `README.md` (1 occurrence) — matches `06-HUMAN-UAT.md` item 2's own count exactly).
`06-HUMAN-UAT.md` lists ten human prerequisites, all `[pending]`; the user chose "Aceptar con deuda"
at the 06-15 checkpoint (2026-09-21), which records the debt but performs none of it.
`docs/releases/v0.1-gate.md`'s verdict stays `NOT READY`, and its own dashboard is 100% green
**locally** — its blockers are entirely human infrastructure (no repository, no release, no public
GHCR packages, no real VPS run), never broken code or a failing test. This matches
`.planning/STATE.md`'s own closing note verbatim.

This is why phase status is `human_needed`, not `gaps_found`: every truth that code and local/DinD
testing can prove is proven, cross-checked against the actual files myself where practical (not
taken on SUMMARY.md's word), and the remainder is genuinely un-provable without a human performing
GitHub/VPS actions no agent has permission to perform.

### Required Artifacts

| Artifact | Expected | Status | Details |
|---|---|---|---|
| `install.sh` | POSIX-sh installer: preflight, Docker install, env gen/merge, compose placement, main flow | ✓ VERIFIED | 2344 lines, clean under `check:posix-sh`, `sh -n`, `dash -n` (all run live). All functions named in every plan's `must_haves.artifacts` present (`noodara_preflight`, `noodara_install_docker`, `noodara_generate_env`, `noodara_resolve_version`/`noodara_resolve_public_url`, `noodara_place_compose_file`, `noodara_main`, `noodara_wait_for_health`, `noodara_validate_admin_password_policy`), confirmed by direct `grep`. |
| `scripts/check-posix-sh.mjs` | Zero-dep bashism/side-effect scanner | ✓ VERIFIED | Runs clean against `install.sh` (live). |
| `apps/control-plane/Dockerfile` | Multi-stage production image, 4 entrypoints, non-root | ✓ VERIFIED | Read in full; `USER noodara`, four-entrypoint comment matches `docker-compose.yml`'s actual `command:` lines. |
| `apps/web/Dockerfile` | Next.js standalone image, non-root, build-arg + runtime ENV `NOODARA_API_ORIGIN` | ✓ VERIFIED | Read in full; matches the documented post-fix behavior in the context notes. |
| `.dockerignore` | Excludes `.env`/`.env.*`, keeps lockfiles/workspace source | ✓ VERIFIED | Read in full; `.env` and `.env.*` excluded with no negation. |
| `docker-compose.yml` | Six-service production topology | ✓ VERIFIED (live) | Read in full, byte-identical to `install.sh`'s embedded copy (reproduced myself). |
| `docker-compose.dev.yml` | Local dev dependencies, redis healthcheck fixed | ✓ VERIFIED (live) | Read in full. |
| `.github/workflows/release.yml` | Tag-triggered multi-arch GHCR publish | ✓ VERIFIED (structural, live) — never executed for real | Read in full; SHA-pins clean. |
| `.github/workflows/ci.yml` / `nightly.yml` | Installer suite wiring | ✓ VERIFIED (live) | Grep-confirmed job gating. |
| `docs/install.md`, `README.md`, `docs/adr/0007-*.md` | Operator docs + ADR | ✓ VERIFIED (live) | Read in full; docs-accuracy test suite passes (run myself, 18/18). |
| `.planning/phases/06-instalador-y-docker-compose/06-HUMAN-UAT.md` | Human-only checklist | ✓ VERIFIED | Present, ten `[pending]` items, matches the phase's actual state. |
| `docs/releases/v0.1-gate.md` | v0.1 release gate report | ✓ VERIFIED | Present, per-criterion verdicts with real evidence citations, verdict `NOT READY` for infra reasons only. |

### Key Link Verification

| From | To | Via | Status | Details |
|---|---|---|---|---|
| `package.json` | `scripts/check-posix-sh.mjs` | `check:posix-sh` script | ✓ WIRED (live) | Confirmed in `package.json`. |
| `package.json` | `vitest.installer.config.ts` | `test:installer` script | ✓ WIRED (live) | Confirmed in `package.json`. |
| `install.sh` | `docker-compose.yml` | embedded heredoc, byte-identical | ✓ WIRED (live, reproduced) | Diffed myself — zero differences. |
| `docker-compose.yml` | `apps/control-plane/dist/db/migrate.js` | `migrate` one-shot `command:` | ✓ WIRED (live) | Confirmed by direct read. |
| `docker-compose.yml` | `/opt/noodara/.env` | `env_file:` + `${VAR}` interpolation | ✓ WIRED (live) | Confirmed by direct read. |
| `.github/workflows/release.yml` | `apps/web/Dockerfile` | `NOODARA_API_ORIGIN=http://api:3000` build-arg | ✓ WIRED (live) | Confirmed by direct read of `release.yml:212`. |
| `.github/workflows/ci.yml` | `package.json` | `pnpm test:installer` / `pnpm check:posix-sh` | ✓ WIRED (live) | Confirmed by direct read. |
| `docs/install.md` | `install.sh` | documented variables match the script's actual overridable constants | ✓ WIRED (live, test-proven) | `tests/unit/docs/install-docs-accuracy.test.ts` passes (18/18, run myself). |
| `README.md` | `docs/install.md` | install section link | ✓ WIRED (live) | Confirmed by direct read (`README.md:20`). |

### Requirements Coverage

| Requirement | Source Plans | Description | Status | Evidence |
|---|---|---|---|---|
| INST-01 | 06-01..06-13 (13 plans declare it) | One-command install on a clean VPS | ✓ SATISFIED (code); ⚠ never proven on a real VPS/GHCR pull | See Truth #1 above. `REQUIREMENTS.md` marks `Complete` (implementation delivered/tested); `docs/releases/v0.1-gate.md` keeps it `UNVERIFIED` for the real-pull reason, an intentional documented disagreement (its own "Notas" section), not an error. |
| INST-02 | 06-04, 06-07, 06-09, 06-12, 06-14 | Non-destructive re-run | ✓ SATISFIED (code); same real-VPS caveat as INST-01 | See Truth #3. |
| INST-03 | 06-01, 06-02, 06-10, 06-12, 06-14 | Preflight, actionable failures | ✓ SATISFIED | See Truth #2; also `docs/releases/v0.1-gate.md` criterion 15 = READY (does not depend on a real registry). |
| INST-04 | 06-09, 06-11, 06-14 | Print URL + one-time setup token | ✓ SATISFIED | See Truth #4; `docs/releases/v0.1-gate.md` criterion 16 = READY. |
| INST-05 | 06-04, 06-09, 06-11, 06-14 | Optional admin pre-seed vars | ✓ SATISFIED | See Truth #4; `docs/releases/v0.1-gate.md` criterion 17 = READY. |

No orphaned requirements: `grep -A2 "^requirements:" 06-*-PLAN.md` confirms all five INST-* IDs appear across the 15 plans' frontmatter (run myself).

### Anti-Patterns Found

None. `grep -n -E "TBD|FIXME|XXX|TODO|HACK|PLACEHOLDER"` across `install.sh`, both `docker-compose*.yml`, both Dockerfiles, all three workflow files, `docs/install.md`, `README.md` and `docs/adr/0007-*.md` returned zero matches (run myself). The only "placeholder" hits are the documented, intentional `REPLACE_WITH_GITHUB_OWNER` occurrences already covered above as a human prerequisite, not a debt marker.

### Behavioral Spot-Checks

| Behavior | Command | Result | Status |
|---|---|---|---|
| `install.sh` parses under a real POSIX shell | `sh -n install.sh` / `dash -n install.sh` | both exit 0 | ✓ PASS |
| `install.sh` passes the project's own static gate | `pnpm check:posix-sh` | `install.sh clean (2344 lines)` | ✓ PASS |
| `noodara_place_compose_file`'s output matches the repo's own compose file | sourced `install.sh` under `NOODARA_INSTALL_SH_SOURCE_ONLY=1`, called the function against a `mktemp -d` target, `diff`'d the result | zero-line diff | ✓ PASS |
| Full unit suite | `pnpm test` | 2206/2206 passed, 132 files | ✓ PASS |
| `pnpm lint` | `pnpm lint` | 9/9 tasks, cache hit, clean | ✓ PASS |
| Workflow SHA-pin gate | `node scripts/check-workflow-pins.mjs .github/workflows/{release,ci,nightly}.yml` | all three "clean" | ✓ PASS |
| Docs-accuracy suite | `npx vitest run tests/unit/docs/install-docs-accuracy.test.ts` | 18/18 passed | ✓ PASS |
| DinD installer suite, ci/gate wiring, e2e, security-scan-leaks, boot | not run by me (forbidden — collides with the orchestrator's parallel closing gate run on a shared 8GB Docker VM) | — | ? SKIP — see recorded `gate-logs/` (11/11 commands exit 0, HEAD `ad951b5`) and `06-REVIEW-FIX.md`'s own real-Docker re-run (17/17, after the fix commits) as the evidence of record for this class of check |

### Probe Execution

No `scripts/*/tests/probe-*.sh` convention exists in this repository; the phase's own equivalent
("layer 1/2/3" testing) is `pnpm check:posix-sh` (probed live above), the DinD integration suite
(`tests/integration/installer/**`, evidenced via `gate-logs/09-test-installer.log`, not re-run per
explicit instruction), and the human-only layer 3 already covered under Human-Dependent Reality.

### Human Verification Required

See the `human_verification` list in this report's YAML frontmatter — ten items, reused directly
from `06-HUMAN-UAT.md`'s own "Human prerequisites" table (same wording/order), all still `[pending]`.

### Gaps Summary

No code-level gaps were found. Every must-have truth in every one of the 15 plans' frontmatter that
can be proven without a real GitHub repository and a real VPS is proven — by direct source reading,
by re-running the safe subset of gates myself, and by cross-checking the recorded raw evidence in
`gate-logs/` and `06-REVIEW-FIX.md` against the current `install.sh`/`docker-compose.yml`/Dockerfiles
rather than trusting SUMMARY narrative. The eight code-review WARNING findings (WR-01..WR-08) from
`06-REVIEW.md` are all confirmed fixed in the current `install.sh`/test files, re-verified myself for
the subset that is safely checkable without Docker (WR-04's admin-password validation, WR-05's disk
ancestor walk, WR-08's `passWithNoTests: false`) and taken from `06-REVIEW-FIX.md`'s own recorded
real-Docker run for the two that need one (WR-06, WR-07). The remaining work is entirely the ten
human prerequisites already known, named and tracked in `06-HUMAN-UAT.md` — extracting the repo,
pushing, replacing the placeholder owner, cutting a real release, making GHCR packages public, and
running the real `curl | sh` on real VPS hardware. `docs/releases/v0.1-gate.md`'s own verdict
(`NOT READY`, entirely for these human-infrastructure reasons) already reflects this precisely, and
this verification agrees with it.

---

*Verified: 2026-09-21T21:30:00Z*
*Verifier: Claude (gsd-verifier)*
