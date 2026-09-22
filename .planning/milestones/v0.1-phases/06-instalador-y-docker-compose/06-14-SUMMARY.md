---
phase: 06-instalador-y-docker-compose
plan: 14
subsystem: docs
tags: [documentation, adr, install-md, readme, operator-docs]

# Dependency graph
requires:
  - phase: 06-instalador-y-docker-compose
    plan: 09
    provides: "install.sh's fully wired noodara_main, including all Findings A-F post-execution fixes (re-run/no-op/repair semantics, D-12 diagnostics, exit codes 10..53)"
  - phase: 06-instalador-y-docker-compose
    plan: 12
    provides: "install.sh's real, DinD-proven idempotent-rerun/preflight/no-Docker-apt-install behavior this doc describes"
  - phase: 06-instalador-y-docker-compose
    plan: 13
    provides: ".github/workflows/release.yml (image naming, multi-arch, never :latest) and the measured pnpm test:installer runtime this ADR references"
provides:
  - "docs/install.md: the complete operator-facing install/upgrade/rollback/troubleshooting reference, written against install.sh's real, post-audit behavior rather than any single plan's original text"
  - "README.md: the repository's first README (Status, Install, Development, links)"
  - "docs/adr/0007-production-topology-and-installer.md: Accepted ADR recording the Compose topology, image strategy, install.sh's POSIX-sh discipline and the three testing layers"
  - "tests/unit/docs/install-docs-accuracy.test.ts: 12 tests asserting docs/install.md's exit-code table, ufw wording, variable inventory and install URL are all extracted from and cross-checked against install.sh/package.json, not hand-copied"
affects: [06-15-real-vps-validation]

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "Docs-accuracy-as-a-test: the exit-code table, the ufw advisory wording and the install script URL are all extracted from install.sh's own source inside the test (regex over the real function bodies), then compared against docs/install.md -- a doc/code drift becomes a failing test, not a stale sentence nobody notices."

key-files:
  created:
    - docs/install.md
    - README.md
    - docs/adr/0007-production-topology-and-installer.md
    - tests/unit/docs/install-docs-accuracy.test.ts
  modified: []

key-decisions:
  - "CLAUDE.md's own command table (pnpm check:posix-sh / pnpm test:installer) was updated locally per this plan's own <context> instruction, but CLAUDE.md is gitignored -- the edit is intentionally uncommitted and untracked, exactly as the plan specifies."
  - "The CLI-invocation acceptance criterion ('verify the exact invocation against the built image before writing it down') was satisfied by reading apps/control-plane/src/cli/index.ts directly (admin reset / secrets rotate subcommands, confirmed exact) plus citing 06-03-SUMMARY.md's own real Testcontainers proof that `node dist/cli/index.js --help` exits 0 and lists both commands -- not by running a new Docker command myself. Running Docker is explicitly forbidden by this executor's own hard_rule #9 (a heavy suite may be running in parallel); the hard rule overrides the plan's literal instruction. Documented as a deviation below."
  - "NOODARA_API_ORIGIN is deliberately never mentioned in docs/install.md: it does not occur anywhere in install.sh (it is a release-time Docker build argument, not an installer-time concern), and this plan's own docs-accuracy test enforces that every NOODARA_ variable named in docs/install.md must occur in install.sh -- mentioning it would have both been operator-irrelevant and broken that test."
  - "The Development section in README.md lists `pnpm install` only inside a fenced shell block, never as an inline-backtick command -- `install` is a pnpm builtin, not a package.json script, so wrapping it in backticks like the other commands would fail the docs-accuracy test's 'every backtick pnpm command must be a real script' check for no operator benefit."

requirements-completed: [INST-01, INST-02, INST-03, INST-04, INST-05]

# Metrics
duration: task commits span ~4min (13:43:37-13:47:52 local); total session (reading all 13 prior plan SUMMARYs including every Post-execution fix section, install.sh in full, docker-compose.yml, release.yml, .env.example, two existing ADRs, CLAUDE.md, and writing three documents plus the accuracy test) considerably longer, not separately timestamped
completed: 2026-09-21
---

# Phase 06 Plan 14: Operator documentation and ADR 0007 Summary

**`docs/install.md` (requirements, install, no-pipe alternative, what gets installed, first login, plain-HTTP warning, firewall, supported variables, upgrade, rollback, an 18-row troubleshooting table, backups), the repository's first `README.md`, and `docs/adr/0007-production-topology-and-installer.md` (Accepted) — all written against `install.sh`'s real, post-audit behavior across plans 06-04 through 06-13, with a dedicated accuracy test that extracts the exit-code table, the ufw wording and the install URL straight from `install.sh`'s own source rather than trusting a hand-copied string.**

## Performance

- **Duration:** task commits span ~4min (13:43:37–13:47:52 local); total session (reading every SUMMARY in this phase including all Post-execution-fix sections, `install.sh` in full — 2224 lines — `docker-compose.yml`, `release.yml`, `.env.example`, `docs/ci-readiness.md`, two existing ADRs, `CLAUDE.md`, `apps/control-plane/src/cli/index.ts`, `packages/domain/src/validators/password.ts`, and writing four files) considerably longer, not separately timestamped
- **Tasks:** 2 (plan) + 1 TDD gate (docs-accuracy test, RED then GREEN)
- **Files created:** 4 (`docs/install.md`, `README.md`, `docs/adr/0007-production-topology-and-installer.md`, `tests/unit/docs/install-docs-accuracy.test.ts`)

## Accomplishments

- **`tests/unit/docs/install-docs-accuracy.test.ts`** (written first, confirmed RED — 12/12 failing with `ENOENT` since none of the three documents existed yet): 12 tests, several of which extract ground truth directly from `install.sh`'s own source at test time rather than hard-coding a copy — the exit-code table (extracted from `noodara_exit_code_for`'s own case arms, compared set-for-set against every `| <code> |` row under `docs/install.md`'s `## Troubleshooting` heading), the ufw advisory's two load-bearing sentences (extracted from `noodara_check_ufw`'s own `noodara_note` calls, asserted present verbatim in the docs), and the install script's raw URL (built from `install.sh`'s own `NOODARA_REPO_OWNER`/`NOODARA_REPO_NAME` placeholder defaults, asserted to appear identically at least twice in the docs). Plus: no D-19 test-only variable name anywhere in either doc; every `NOODARA_` variable named in the docs actually occurs in `install.sh`; no literal `:latest`; no internal planning id (plan number, threat id, decision id) in either operator-facing file; every `pnpm <cmd>` in README's Development section is a real `package.json` script; ADR 0007 is `Accepted` and names every decision id it must.
- **`docs/install.md`**: Requirements, Install (one-liner using the literal placeholder `REPLACE_WITH_GITHUB_OWNER`), Install without piping to a shell (download-read-run, mirroring `get.docker.com`'s own guidance), What gets installed (the six services, two volumes, image references, `/opt/noodara` layout), First login (setup token, the admin pre-seed both-or-neither rule, the single-quote-in-password rejection), Plain HTTP warning (its own section, not a footnote), Firewall (the "typically bypass" wording quoted verbatim), Supported variables (a table of exactly `NOODARA_VERSION`/`NOODARA_PORT`/`NOODARA_PUBLIC_URL`/`NOODARA_ADMIN_EMAIL`/`NOODARA_ADMIN_PASSWORD`/`NOODARA_SKIP_RESOURCE_CHECK`, plus the `.env`-wins-on-re-run rule), Upgrade (the three real re-run outcomes — true no-op / repair / genuine upgrade — read from `install.sh`'s own post-execution-fixed `noodara_main`, not the plan's original pre-fix description), Rollback (no automatic rollback, the exact remedy command), Troubleshooting (the full 18-code table, log/health/CLI commands), Backups (`NOODARA_MASTER_KEY` unrecoverable, volume backup guidance, `install.log`/`.env.bak-*` secret-content facts).
- **`README.md`**: tagline, one-paragraph description, a Status line naming v0.1 and explicitly deferring deployments/domains/TLS/AI, an Install section linking to `docs/install.md`, a Development section (real `package.json` scripts only), links to the roadmap/ADRs/LICENSE.
- **`docs/adr/0007-production-topology-and-installer.md`**: follows ADR 0006's exact section shape (Status/Context/Decision/Rejected alternatives/Consequences), records the six-service topology, the one-image/four-entrypoint contract, migration idempotency, the `NOODARA_API_ORIGIN` build-time/runtime duality, the never-`:latest`/multi-arch image strategy, `install.sh`'s strict-POSIX-sh discipline, `/opt/noodara`'s additive-merge/no-rollback contract, the HTTP-by-default/advisory-firewall posture, and the three testing layers — Accepted, dated, naming D-01 through D-19 where each decision was actually made.

## Task Commits

1. **RED — docs-accuracy test** (`tdd="true"` in spirit, per hard_rule #7's own TDD-first requirement for this plan): `667b4ec` `test(06-14): add failing docs-accuracy tests for install.md/README/ADR 0007` — confirmed RED, 12/12 failing (`ENOENT` for all three target files).
2. **GREEN — the three documents**: `56fe6f1` `docs(06-14): add install.md, README.md and ADR 0007 for the installer` — 12/12 passing.

Every commit's message verified free of attribution trailers via `git log -1 --format=%B` after each commit.

## Files Created/Modified

- `docs/install.md` — the complete operator install/upgrade/rollback/troubleshooting reference
- `README.md` — the repository's first README
- `docs/adr/0007-production-topology-and-installer.md` — Accepted ADR recording the production topology and installer decisions
- `tests/unit/docs/install-docs-accuracy.test.ts` — 12 tests cross-checking the docs against `install.sh`/`package.json` at test time

## Decisions Made

See `key-decisions` in the frontmatter above: `CLAUDE.md`'s edit is intentionally uncommitted (gitignored); the CLI-invocation verification was done by reading source, not by running Docker (hard_rule #9 overrides the plan's literal instruction — see Deviations); `NOODARA_API_ORIGIN` is deliberately absent from `docs/install.md`; `pnpm install` appears only inside a fenced code block in README's Development section, never as an inline-backtick command.

## Deviations from Plan

### Auto-fixed / hard-rule-driven

**1. [hard_rule #9 overriding the plan's literal acceptance criterion] The `admin reset`/`secrets rotate` CLI invocation was verified by reading source, not by running it against the built image.**
- **Found during:** Task 1, writing the Troubleshooting section's CLI commands.
- **Issue:** 06-14-PLAN.md's own acceptance criteria say "The CLI invocation documented for `admin reset` was actually run against the built image and its output recorded in the SUMMARY." This executor's governing hard_rule #9 explicitly forbids running any Docker command in this session (a heavy Docker suite may still be running in parallel) — a direct conflict between the plan's literal text and a hard rule that takes precedence.
- **Fix:** Read `apps/control-plane/src/cli/index.ts` directly: it defines exactly `program.command('admin').command('reset')` and `program.command('secrets').command('rotate')`, confirming `docker compose exec api node dist/cli/index.js admin reset` and `... secrets rotate` are the real, exact invocations. `06-03-SUMMARY.md` already records a real Testcontainers proof (Plan 06-03, not this plan) that `node dist/cli/index.js --help` exits 0 and lists both commands from inside the built image — cited as existing, real evidence rather than re-run here.
- **Files affected:** `docs/install.md`'s Troubleshooting section.
- **Verification:** Source read directly; command names match exactly.

No other deviations (Rules 1-3): no bugs found, no missing critical functionality, no blocking issues.

## Concerns Found While Documenting Real Behaviour

None beyond what earlier plans in this phase already surfaced and fixed (Findings A-F, the redirect-mode `-L` bug, the JSON-parsing brace-depth bug, etc. — all already fixed in `install.sh` before this plan started, per the objective's own instruction to read every Post-execution-fix section first). This plan found no new bug, trap or undocumented promise while writing the docs — every behavior described here was already real and already tested by a prior plan in this phase.

## Before Publishing

`install.sh` still carries the placeholder owner `REPLACE_WITH_GITHUB_OWNER` (its own `NOODARA_REPO_OWNER` default), and `docs/install.md`/`README.md` use the identical placeholder spelled identically everywhere it appears — a single search-and-replace across `install.sh`, `docs/install.md` and `README.md` for `REPLACE_WITH_GITHUB_OWNER` is what a human does once the real GitHub repository exists (D-02, carried forward from 06-06/06-13's own identical handoff note). Nothing in this plan invents or guesses a real owner/URL.

## Known Stubs

None — this plan writes only Markdown and one test file; no UI or data-flow stub is introduced.

## Threat Flags

None — the only surface this plan introduces is documentation prose; the one trust boundary named in this plan's own `<threat_model>` ("documentation → operator behaviour") is exactly what the docs-accuracy test and the verbatim-quoted ufw/exit-code content exist to mitigate.

## Issues Encountered

One authoring mistake caught by the test itself before commit: the two verbatim ufw sentences were initially hand-wrapped across two Markdown lines each (for readability), which broke the docs-accuracy test's exact-substring match against `install.sh`'s own single-line strings. Fixed by keeping each quoted sentence on one continuous line in the Markdown source (long lines are fine in prose Markdown; no forced wrap needed) — caught by the RED-then-GREEN cycle exactly as intended, not by manual proofreading.

## User Setup Required

None — no external service configuration required. See "Before Publishing" above for the one deferred, purely mechanical step (replacing the placeholder owner) that already has a human-prerequisite home in Plan 06-15.

## Self-Check

- `docs/install.md`: FOUND
- `README.md`: FOUND
- `docs/adr/0007-production-topology-and-installer.md`: FOUND
- `tests/unit/docs/install-docs-accuracy.test.ts`: FOUND
- `667b4ec`: FOUND in `git log --oneline --all`
- `56fe6f1`: FOUND in `git log --oneline --all`
- `pnpm test`: 128 files / 2155 tests green
- `pnpm lint`: clean (full Turbo cache hit, no source package touched by this plan)
- `pnpm typecheck`: clean (full Turbo cache hit, including the extra `tsc -p tests/integration/{ssh,installer}` / `tests/e2e` invocations)

## Next Phase Readiness

- `docs/install.md` and `README.md` are ready for a real operator to follow end to end once Plan 06-15's human prerequisites (repository creation, GHCR package visibility, replacing `REPLACE_WITH_GITHUB_OWNER`) are complete.
- `docs/adr/0007-production-topology-and-installer.md` is the standing record Plan 06-15 and v0.4's Traefik work should extend, not renegotiate.
- `tests/unit/docs/install-docs-accuracy.test.ts` runs as part of `pnpm test` on every future change to `install.sh` or the docs — a future exit-code addition, a reworded ufw message, or a newly-documented variable that does not exist in the script will fail this test immediately.
- No blockers for Plan 06-15.

## Post-execution fix

An orchestrator audit of `docs/install.md` against the real `install.sh`/`docker-compose.yml`/`apps/web` code found three confirmed inaccuracies after this plan's original commits. All three are fixed here, RED-then-GREEN, with no change to ROADMAP.md/REQUIREMENTS.md.

**Finding 1 — the documented rollback command did not roll back.** `NOODARA_VERSION=<previous-version> curl -fsSL <url> | sh` applies the assignment to `curl` only (proven: `FOO=bar true | sh -c 'echo ${FOO:-unset}'` prints `unset`); an operator following it during a failed upgrade would silently reinstall the latest (broken) version instead of the previous one. Fixed the Rollback section to place the assignment on the `sh` side of the pipe, both as root (`curl ... | NOODARA_VERSION=<previous-version> sh`) and with `sudo` (`curl ... | sudo NOODARA_VERSION=<previous-version> sh`), and added one explanatory paragraph in "Install" (the first place any `NOODARA_*` variable is combined with the piped command) stating the rule generally: put the variable after `sh`, and after `sudo` too when `sudo` is used, since `sudo sh` alone already drops the caller's environment. `install.sh`'s own printed rollback hint ("re-run this installer with NOODARA_VERSION=...") was already generic prose with no broken command shape, confirmed unchanged.
- **Files:** `docs/install.md` (Install, Rollback sections).
- **Tests:** `tests/unit/docs/install-docs-accuracy.test.ts` — "never places a NOODARA_*= assignment before curl in a piped-install command", "the rollback command places NOODARA_VERSION on the sh side of the pipe, both as root and with sudo".
- **Commits:** `4d45006` (RED), `74ca219` (GREEN).

**Finding 2 — `curl http://127.0.0.1:<port>/health` never reaches the control plane.** Only `web` publishes a port; `apps/web/next.config.ts`'s `rewrites()` forwards only `/api/:path*` to the API (verified by reading the file directly, plus `apps/web/src/proxy.ts`'s matcher). `/health` is registered directly on the control-plane app (`apps/control-plane/src/routes/health.ts`), never proxied — a curl to it on the published panel port is answered by Next.js, not the API. Replaced the "Checking health" block with `docker compose ps` (the HEALTH column), an in-container re-run of the exact `api` healthcheck command from `docker-compose.yml` (`docker compose exec -T api node -e "fetch('http://127.0.0.1:3000/health')..."`), and `curl -I http://127.0.0.1:<port>/login` for confirming the panel itself answers on the published port.
- **Files:** `docs/install.md` (Troubleshooting → Checking health).
- **Tests:** `tests/unit/docs/install-docs-accuracy.test.ts` — "never documents /health (or any non-/api/ route) reachable on the published panel port".
- **Commits:** `4d45006` (RED), `74ca219` (GREEN).

**Finding 3 — "edit `.env` and re-run the installer" is a no-op.** Since the 06-09 fixes, a same-version re-run against an already-healthy stack never runs `docker compose up` (D-09's own no-op path) — so both docs sections ("Supported variables", the TLS procedure in "Plain HTTP warning") and three `install.sh`-printed messages (`noodara_check_port`'s port-mismatch warning, `noodara_resolve_public_url`'s resolved-URL note, `noodara_resolve_installed_public_url`'s URL-mismatch warning) told the operator to do something that changes nothing. **Decision (recorded in STATE.md): keep the no-op (D-09) and make the advice true instead** — apply an edited `.env` with `docker compose -f <install dir>/docker-compose.yml up -d`, which Compose resolves by recreating only the services whose configuration actually changed. Rewrote "Supported variables" (states plainly that a same-version healthy re-run is a true no-op and gives the apply command) and the TLS procedure in "Plain HTTP warning" (put proxy in front → edit `NOODARA_PUBLIC_URL` and remove `NOODARA_COOKIE_INSECURE` in `.env` → apply with `docker compose ... up -d` → confirm via `docker compose exec api env | grep NOODARA_PUBLIC_URL` and the cookie's `Secure` attribute). Changed all three `install.sh` messages from "... and re-run this installer" to "..., then run: docker compose -f ${NOODARA_INSTALL_DIR}/${NOODARA_COMPOSE_FILE} up -d" — built from the existing `NOODARA_INSTALL_DIR`/`NOODARA_COMPOSE_FILE` readonly variables, never a hard-coded `/opt/noodara`, and still single-line/calm/naming-the-key. The alternative — the installer detecting configuration drift itself via `docker compose config --hash` vs. the containers' `com.docker.compose.config-hash` label and applying it automatically — is deliberately out of scope here; noted as a follow-up idea, not implemented.
- **Files:** `docs/install.md` (Supported variables, Plain HTTP warning), `install.sh` (`noodara_check_port`, `noodara_resolve_public_url`, `noodara_resolve_installed_public_url`).
- **Tests:** `tests/unit/docs/install-docs-accuracy.test.ts` — "never tells the operator to re-run the installer to apply an .env edit, and documents the docker compose apply command"; `tests/unit/installer/preflight.test.ts`, `tests/unit/installer/resolution.test.ts`, `tests/unit/installer/main-flow.test.ts` — extended existing/new cases asserting each message contains `docker compose -f <install dir>/docker-compose.yml up -d` and never `re-run this installer`.
- **Commits:** `4d45006`/`c74abf2` (RED), `74ca219`/`eb4a23a` (GREEN).

**ADR 0007 reviewed, no change needed.** `docs/adr/0007-production-topology-and-installer.md`'s own "no automatic rollback" and "re-running the installer is the only upgrade path" language never shows the broken piped-command shape and never claims a re-run applies an `.env` edit outside a genuine version change — it was already consistent with the fixed docs and needed no edit.

**Verification:** touched test files green (423/423 across the 4 modified/extended files); full `pnpm test` 128 files / 2161 tests green (2155 baseline + 6 new: 4 in `install-docs-accuracy.test.ts`, 2 interpreter-parameterized new cases in `resolution.test.ts`; the port/URL-mismatch assertions added to `preflight.test.ts`/`main-flow.test.ts` extend existing `it` blocks rather than adding new ones); `pnpm lint` and `pnpm typecheck` clean (full Turbo cache hit — no source package touched); `pnpm check:posix-sh` clean (`install.sh` 2224 lines).

**Not fully implemented / deferred:** the configuration-drift auto-apply idea named above (installer-driven `docker compose config --hash` comparison) — explicitly out of scope per the fix's own instructions, left as a follow-up idea only.

---
*Phase: 06-instalador-y-docker-compose*
*Completed: 2026-09-21*
