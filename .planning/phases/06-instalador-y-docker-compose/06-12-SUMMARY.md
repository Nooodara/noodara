---
phase: 06-instalador-y-docker-compose
plan: 12
subsystem: infra
tags: [docker-in-docker, testcontainers, install-sh, idempotency, preflight, dpkg, apt, dash]

# Dependency graph
requires:
  - phase: 06-instalador-y-docker-compose
    plan: 09
    provides: "install.sh's fully wired noodara_main, including 06-09's own post-execution Findings A-E (re-run port/URL sourcing, the D-09 true no-op, the Finding E repair path) -- this plan is the first real-daemon proof of that logic"
  - phase: 06-instalador-y-docker-compose
    plan: 10
    provides: "tests/integration/helpers/installer-dind.ts's startInstallerDind/runInstallSh/loadLocalImages, and the installer-dind-ubuntu-22.04/24.04 fixture images + shared entrypoint.sh"
  - phase: 06-instalador-y-docker-compose
    plan: 11
    provides: "tests/integration/installer/installer-scenario-helpers.ts (image build/load, .env parsing, compose-ps parsing, curl-through-the-panel, the T-06-02 canary), and install.sh's brace-depth-aware noodara_compose_json_field_for_service fix this plan's own health reads depend on"
provides:
  - "tests/integration/installer/idempotent-rerun.test.ts: 8 real scenarios against one live DinD stack (Ubuntu 22.04) -- true no-op (byte-identical .env, no backup, no pull/up), a genuine upgrade to a second locally-loaded tag (one backup mode 600, NOODARA_PREVIOUS_VERSION set, migrate re-applies 0 migrations), a repair after `docker compose down` (no .env change, volumes intact), a failed upgrade to a deliberately broken image (exit 53, names api, redacted log tail, real rollback hint, secrets/volumes untouched), and a manual rollback that restores health with a marker admin's data intact (INST-02)"
  - "tests/integration/installer/preflight-scenarios.test.ts: 9 real scenarios -- snap-Docker (17), busy panel port (16, a real netcat listener), unsupported OS (12), insufficient RAM (14), 1536MB warn-and-proceed, NOODARA_SKIP_RESOURCE_CHECK=1 proceed, combined snap+busy-port ordering (17, port never named), non-root (10) -- every failing case also asserts /opt/noodara does not exist afterward -- plus the phase's one network-dependent test: a withDocker:false fixture installs Docker Engine + Compose from Docker's own apt repo for real and completes with a healthy six-service stack (INST-01/INST-03)"
  - "install.sh: noodara_wait_for_docker_ready (a bounded, unit-tested retry for 'docker version' to start answering right after apt installs docker-ce -- apt's own postinst starts docker.service asynchronously on every host, not just this fixture) and a fixed noodara_compose_up that no longer masks D-12's own diagnostics (service name, redacted log tail, rollback hint) behind a generic message when `docker compose up -d` itself fails on its own dependency-wait"
  - "tests/integration/helpers/installer-dind.ts: startInstallerDind() gains an optional reuseDockerVolume, letting a 'donor' fixture's already-populated /var/lib/docker be shared with a second fixture -- the mechanism that lets the no-Docker scenario reach a healthy stack with zero image-load race against install.sh's own bounded docker-ready wait"
  - "tests/integration/images/installer-dind-common/entrypoint.sh: a background watcher that polls docker-ce's own dpkg Status field (not merely the dockerd binary's presence, which raced the package's own postinst in this plan's first real run) and starts the nested dockerd once install.sh's real apt-get genuinely finishes configuring it"
affects: [06-13-ci-release, 06-14-docs, 06-15-real-vps-validation]

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "'Donor volume' pattern: pre-populate a withDocker:false fixture's OWN /var/lib/docker (via startInstallerDind's new reuseDockerVolume, from a withDocker:true 'donor' fixture that already ran loadLocalImages and was then stopped) BEFORE the no-Docker fixture's own daemon ever starts -- removes the image-load race against install.sh's real, bounded noodara_wait_for_docker_ready entirely, rather than racing a live docker load against install.sh's own timing."
    - "A background watcher that starts a service once apt installs it must poll the PACKAGE MANAGER's own completion signal (dpkg-query -W -f '${Status}' <pkg>, watching for \"install ok installed\"), never the mere presence of a binary on disk -- dpkg unpacks files (including binaries) before running postinst, so binary-presence polling starts a competing daemon while the package's own configuration script is still running."
    - "docker compose up -d can fail on ITS OWN dependency-wait (a service with a `depends_on: condition: service_healthy` dependent never becomes healthy) before an installer's own post-up health-wait loop ever runs -- this must route through the SAME diagnostic path as a genuine health-wait timeout (name the service, show its log tail, state the rollback hint), never a separate generic failure message, or D-12-class requirements silently stop being met for exactly the services other services depend on."

key-files:
  created:
    - tests/integration/installer/idempotent-rerun.test.ts
    - tests/integration/installer/preflight-scenarios.test.ts
  modified:
    - install.sh
    - tests/integration/images/installer-dind-common/entrypoint.sh
    - tests/integration/images/installer-dind-ubuntu-22.04/Dockerfile
    - tests/integration/images/installer-dind-ubuntu-24.04/Dockerfile
    - tests/integration/helpers/installer-dind.ts
    - tests/unit/installer/docker-install.test.ts
    - tests/unit/installer/main-flow.test.ts

key-decisions:
  - "The plan's own <behavior> text (written before 06-09's Finding C/E fixes landed) described run 2's migrate re-applying '0 migrations' -- the FIXED true-no-op path skips docker compose up -d entirely, so migrate is never touched on that run. Read the fixed install.sh, not the plan text, as the truth (per this plan's own governing instructions): the migrate-re-applies-cleanly proof runs on run 3 (the genuine upgrade, where up -d really does execute again), not run 2."
  - "Chose the real POST /api/setup path (redeeming the printed token to create a marker admin, then signing in again after each later run) over a direct `docker compose exec postgres psql` insert for the 'operator's own data survives' proof -- reuses the identical real-API-write mechanism Plan 06-11's own fresh-install.test.ts already validated, and a full server-registration flow would additionally require SSH fixtures wholly outside this plan's scope."
  - "The broken-upgrade image is built as a tiny FROM-derived layer on top of the already-built, real control-plane image (overwriting only dist/server.js with a script that stays running but never listens on port 3000), never a from-scratch build of a second fake image -- keeps dist/db/migrate.js and dist/worker.js genuinely untouched, so migrations still succeed and only api's own healthcheck fails, driving exactly the D-12 path under test."
  - "The no-Docker scenario proves a SINGLE real install.sh run reaching a healthy stack (not two chained runs) via the donor-volume mechanism, because a withDocker:false fixture's daemon does not exist until install.sh's own apt-get creates it -- there is no running daemon to `docker load` into beforehand, and racing a live load against install.sh's own bounded readiness wait is exactly the kind of race this plan was warned to avoid solving with a test-only branch inside install.sh."

requirements-completed: [INST-01, INST-02, INST-03]

# Metrics
duration: ~2h10min total session (context reading across 06-09/06-10/06-11's own SUMMARYs, install.sh, docker-compose.yml, the DinD harness/scenario-helper conventions; two real-DinD investigation/fix cycles -- the compose-up D-12 masking bug and the dpkg-race watcher bug -- plus a full pnpm test:installer run for CI-sizing); task/fix commits span 2026-09-21T11:28:26 - 2026-09-21T12:05:50 (~37min)
completed: 2026-09-21
---

# Phase 06 Plan 12: Idempotent re-run, preflight matrix and the real no-Docker install path Summary

**Seven real, chained `install.sh` runs against one live Docker-in-Docker stack prove true no-op / upgrade / repair / failed-upgrade / manual-rollback (INST-02); nine real preflight scenarios -- including the phase's one network-dependent apt-repo Docker installation, reaching a genuinely healthy six-service stack -- complete INST-03 and, at last, INST-01; and two real, previously-undetected `install.sh` bugs (a Docker-daemon-readiness race and a masked D-12 diagnostic) are found, unit-pinned and fixed along the way.**

## Performance

- **Duration:** ~2h10min total session (context reads across four prior plans' SUMMARYs, `install.sh`, `docker-compose.yml`, the DinD harness and scenario-helper conventions; two real-DinD investigation/fix cycles; one full `pnpm test:installer` run for Plan 06-13's own CI-timeout sizing); the eight task/fix/test commits span `2026-09-21T11:28:26` - `2026-09-21T12:05:50` (~37min)
- **Tasks:** 2 (plan) + 2 real, in-scope `install.sh` bugs found and fixed (hard_rule #11), plus one fixture-only bug (hard_rule #11c)
- **Files modified:** 9 (2 created, 7 modified)

## Accomplishments

- **Task 1 -- `idempotent-rerun.test.ts` (INST-02):** one Ubuntu 22.04 fixture, seven chained `install.sh` runs against the same `/opt/noodara`: (1) fresh install + a marker admin created through the real `POST /api/setup`; (2) same-version re-run over an already-healthy stack -- a TRUE no-op (`.env` byte-identical, zero `.env.bak-*`, install.sh's own "Skipping image pull and docker compose up -d" note proves neither ran); (3) upgrade to a second locally-loaded tag -- exactly one backup (mode 600), `NOODARA_PREVIOUS_VERSION` set to the real prior version, every generated secret unchanged, stack healthy on the new tag, `migrate` re-applies cleanly (exit 0); (4) same-version re-run again -- true no-op; (5) repair -- `docker compose down` (volumes kept) then a same-version re-run repairs the stack with **no** `.env` change and **no** second backup, install.sh's own "The stack is not healthy; starting it." note and `install.log`'s "repairing (D-09/Finding E)" line prove the repair branch, not the no-op branch, ran; (6) a deliberately broken upgrade -- exit 53, names `api`, shows a redacted log tail, names the real previous version (`NOODARA_VERSION=<v2>`), `.env` secrets and both named volumes untouched; (7) manual rollback to the named previous version -- healthy again, the marker admin from run 1 still signs in. 8/8 real assertions pass; zero `noodara.test=true` leftovers.
- **Task 2 -- `preflight-scenarios.test.ts` (INST-03, INST-01):** eight fast, real-container preflight scenarios (snap-Docker, a real `netcat-openbsd` listener occupying the panel port, an unsupported-OS fixture file, insufficient RAM, the 1536MB warn-and-proceed case, `NOODARA_SKIP_RESOURCE_CHECK=1`, the combined snap+busy-port ordering case, and non-root) -- every failing case also asserts `/opt/noodara` does not exist afterward (D-17's own real requirement). Plus the phase's one network-dependent test: a `withDocker:false` fixture whose own `/var/lib/docker` volume is pre-populated by a "donor" `withDocker:true` fixture (loaded with the real production images, then stopped) runs the real `install.sh`, which installs Docker Engine + the Compose plugin from Docker's own apt repository (verified: `download.docker.com` origin, `signed-by=`, a real armored GPG key mode 644, `docker-ce` genuinely installed, `docker.io` absent, no `get.docker.com` reference anywhere) and completes with a genuinely healthy six-service stack. 9/9 real assertions pass; zero leftovers.
- **Two real `install.sh` bugs found and fixed (hard_rule #11), both pinned by a failing unit test before the fix landed:**
  1. `noodara_ensure_docker` checked `docker version` exactly once, immediately after `apt-get install docker-ce ...` returned -- apt's own postinst starts `docker.service` asynchronously (via systemd on a real host; via nothing at all in the no-Docker fixture). Fixed with `noodara_wait_for_docker_ready`, a bounded (10x1s default), unit-tested retry that applies on every host, not just the fixture.
  2. `noodara_compose_up` fell through to a generic, un-actionable `compose-up-failed` (51) message with no service name and no log tail whenever `docker compose up -d` itself failed on ITS OWN dependency-wait (`web` `depends_on: api: condition: service_healthy`) -- discovered live by `idempotent-rerun.test.ts`'s own run 6. Fixed: a non-migrate `up -d` failure now defers to `noodara_wait_for_health` (the installer's very next call), reusing the already-tested D-12 diagnostic regardless of which code path first noticed the problem.
- **One fixture-only bug found and fixed (hard_rule #11c, not an `install.sh` defect):** the no-Docker fixture's background watcher started `dockerd` as soon as `command -v dockerd` succeeded -- the binary lands on disk during dpkg's *unpack* step, well before docker-ce's own postinst script finishes *configuring* it, so the watcher raced that script in the very first real run. Fixed: the watcher now polls `dpkg-query`'s own Status field for `docker-ce` (`"install ok installed"`), the same fully-configured signal a real systemd host's own trigger would wait for.
- Full `pnpm test:installer` (all 10 files under `tests/integration/installer/`, including 06-10/06-11's own suites): **51/51 tests green, 1888.95s (~31.5min) wall-clock** -- recorded here for Plan 06-13's own CI timeout sizing, per this plan's `<verification>` section. Full `pnpm test`: 126 files / 2103 tests green. `pnpm check:posix-sh`: clean (2142 lines). `pnpm lint`/`pnpm typecheck`: clean.

## Task Commits

Test-first throughout (hard_rule #5), including a standalone RED/GREEN pair for the real `noodara_compose_up` bug `idempotent-rerun.test.ts`'s own first real run surfaced:

1. **`noodara_wait_for_docker_ready` (needed before Task 2's no-Docker scenario could even be written):**
   - `ea4c0cf` `test(06-12): add failing tests for a bounded docker-ready wait after install` -- confirmed RED (function did not exist)
   - `4c3ba69` `feat(06-12): retry a bounded wait for the daemon to answer after installing Docker` -- GREEN
2. **Fixture watcher for the no-Docker scenario (harness-only, hard_rule #11c):**
   - `99210b8` `fix(06-12): start dockerd once install.sh installs it in the no-Docker fixture` (entrypoint.sh watcher v1 + `installer-dind.ts`'s `reuseDockerVolume`)
3. **Real bug found by Task 1's own first real run, fixed before Task 1 could pass (test-first, hard_rule #11a):**
   - `43aae61` `test(06-12): pin the real D-12 gap when up -d fails its own dependency wait` -- confirmed RED against the real, pre-fix `install.sh`
   - `ab80516` `fix(06-12): surface D-12 diagnostics when up -d fails its own dependency wait` -- GREEN
4. **Task 1: idempotent re-run, upgrade, no-op, repair, failed-upgrade (INST-02):**
   - `3e0e3a8` `test(06-12): add real double-run, upgrade, repair and failed-upgrade scenarios` -- 8/8 green against real DinD (first real run hit the Task-3 bug above; green after that fix)
5. **Fixture watcher race found by Task 2's own first real no-Docker run, fixed before Task 2 could pass (hard_rule #11c):**
   - `5fa8b3a` `fix(06-12): wait for docker-ce's dpkg status, not just the dockerd binary`
6. **Task 2: the real preflight matrix + no-Docker apt install (INST-03/INST-01):**
   - `62c6211` `test(06-12): add the real preflight matrix and no-Docker apt install scenarios` -- 9/9 green against real DinD (includes `netcat-openbsd` added to both Dockerfiles for the busy-port scenario's real listener)

_Every commit's message verified free of attribution trailers via `git log -1 --format=%B` after each commit; `git diff --cached --name-only` checked before every commit; every staged path lives under `noodara/code`._

## Files Created/Modified

- `tests/integration/installer/idempotent-rerun.test.ts` -- INST-02, 8 real chained-run scenarios
- `tests/integration/installer/preflight-scenarios.test.ts` -- INST-03/INST-01, 9 real scenarios including the no-Docker apt path
- `install.sh` -- `noodara_wait_for_docker_ready` (new), `noodara_compose_up` (fixed to defer D-12 diagnosis to `noodara_wait_for_health` on a non-migrate `up -d` failure)
- `tests/integration/images/installer-dind-common/entrypoint.sh` -- background watcher for the no-Docker fixture, polling `docker-ce`'s own dpkg Status
- `tests/integration/images/installer-dind-ubuntu-22.04/Dockerfile`, `tests/integration/images/installer-dind-ubuntu-24.04/Dockerfile` -- `netcat-openbsd` added (busy-port scenario's own real listener); verified still byte-identical except `FROM`
- `tests/integration/helpers/installer-dind.ts` -- `startInstallerDind()` gains `reuseDockerVolume`
- `tests/unit/installer/docker-install.test.ts` -- pins `noodara_wait_for_docker_ready`; one pre-existing test's wait constants overridden down to zero (its own default wait now sleeps for real)
- `tests/unit/installer/main-flow.test.ts` -- pins the `noodara_compose_up` D-12-masking bug and its fix

## Decisions Made

See `key-decisions` in the frontmatter above. In short: the migrate-re-applies-cleanly proof moved from run 2 (plan text, pre-Finding-C/E) to run 3 (the genuine upgrade, matching the FIXED behavior); the marker-admin data-survival proof reuses Plan 06-11's own real-API-write mechanism; the broken-upgrade image is a minimal FROM-derived layer over the real control-plane image; the no-Docker scenario reaches a healthy stack via a single real `install.sh` run by pre-populating a shared Docker volume from a "donor" fixture, never via two chained runs or a live image-load race.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 11a -- genuine `install.sh` bug, unit-tested] `docker compose up -d`'s own dependency-wait failure masked D-12's diagnostic path**
- **Found during:** Task 1's first real run of run 6 (the deliberately broken upgrade)
- **Issue:** `docker-compose.yml`'s own topology makes `web depends_on: api: condition: service_healthy` (and similarly `api`/`worker` on `redis`, `migrate` on `postgres`). When `api` never becomes healthy, Compose's own `up -d` refuses to finish -- it exits non-zero with "dependency failed to start: container ... is unhealthy" *before* `install.sh`'s own `noodara_wait_for_health` ever runs. `noodara_compose_up` treated this exactly like any other non-migrate `up -d` failure: a generic `compose-up-failed` (51) message naming no service and showing no log tail -- silently violating D-12's own "names the service, shows its log tail, states the rollback" requirement for precisely the services anything else depends on with a health condition.
- **Fix:** a non-migrate `up -d` failure no longer fails outright inside `noodara_compose_up` -- it prints a calm note and lets `noodara_main`'s very next call, `noodara_wait_for_health`, judge the already-created containers on their own real health, reusing the identical, already-tested D-12 diagnostic (service name, redacted log tail, rollback hint) regardless of which code path first noticed the underlying problem.
- **Files modified:** `install.sh`, `tests/unit/installer/main-flow.test.ts`
- **Verification:** New unit test reproduces the exact real-DinD-observed shape (a non-migrate `up -d` failure with `api` reporting unhealthy) and confirmed RED against the pre-fix `install.sh`; GREEN after. Real DinD re-run: `idempotent-rerun.test.ts` run 6 now exits 53, names `api`, shows the redacted log tail and the real rollback hint. Full `pnpm test` (2103 tests) and `pnpm check:posix-sh` re-verified green.
- **Committed in:** `43aae61` (RED), `ab80516` (GREEN)

**2. [Rule 11c -- fixture/harness bug, not `install.sh`] the no-Docker fixture's watcher raced `docker-ce`'s own postinst script**
- **Found during:** Task 2's first real run of the no-Docker apt-install scenario
- **Issue:** the watcher started `dockerd` as soon as `command -v dockerd` succeeded -- but `apt-get install docker-ce ...` downloads every package first, then unpacks and configures each in dependency order; dpkg's *unpack* step drops the `dockerd` binary on disk well before docker-ce's own *postinst* script finishes running. Starting a competing `dockerd` while that script was still executing left the daemon unreachable for the rest of `install.sh`'s own bounded retry -- a genuine, reproducible (not theorized) nested-container timing limitation of the harness itself.
- **Fix:** the watcher now polls `dpkg-query`'s own Status field for `docker-ce` ("install ok installed" -- dpkg's own definitive "fully configured, not merely unpacked" signal) instead of the binary's mere presence.
- **Files modified:** `tests/integration/images/installer-dind-common/entrypoint.sh`
- **Verification:** re-ran the identical scenario -- Docker installs, the daemon becomes reachable within `install.sh`'s own default 10-attempt/1s bound, and the stack reaches healthy.
- **Committed in:** `5fa8b3a`

**3. [Rule 2 -- missing critical functionality, harness scope] `installer-dind.ts` and both Dockerfiles extended for this plan's own scenarios**
- **Found during:** designing the no-Docker scenario (a `withDocker:false` fixture has no daemon of its own to `docker load` into until `install.sh`'s own apt-get creates one -- loading images live during install.sh's own bounded readiness wait would race it) and the busy-port scenario (the fixture images shipped no TCP listener tool)
- **Issue:** neither `startInstallerDind` nor the fixture images provided what this plan's own two new scenario files needed.
- **Fix:** `startInstallerDind()` gained an optional `reuseDockerVolume` (bind-mount an existing, caller-owned volume instead of creating one -- the "donor fixture" mechanism); both Dockerfiles gained `netcat-openbsd`.
- **Files modified:** `tests/integration/helpers/installer-dind.ts`, `tests/integration/images/installer-dind-ubuntu-22.04/Dockerfile`, `tests/integration/images/installer-dind-ubuntu-24.04/Dockerfile`
- **Verification:** both Dockerfiles still verified byte-identical except `FROM` (`diff <(grep -v '^FROM ' 22.04/Dockerfile) <(grep -v '^FROM ' 24.04/Dockerfile)` empty); `reuseDockerVolume` proven by the no-Docker scenario itself reaching a healthy stack; the busy-port listener proven up via a real `ss -tuln` poll before every use.
- **Committed in:** `99210b8` (initial watcher + `reuseDockerVolume`), `62c6211` (`netcat-openbsd`)

---

**Total deviations:** 3 auto-fixed (1 Rule 11a genuine `install.sh` bug with a pinning unit test, 1 Rule 11c fixture-only fix, 1 Rule 2 harness-infrastructure addition). No scope creep beyond what discovering and fixing each required; no security control was ever weakened to reach green.

## Issues Encountered

Both real bugs above (D-12 masking, the dpkg-status race) ARE the "issues encountered" for this plan -- see Deviations. No other RED/GREEN iteration was needed beyond the two described cycles; every other real DinD run (idempotent-rerun's runs 1-5/7, and 7 of preflight-scenarios' 9 cases) passed on the first attempt against the finished implementation.

## Requirement Proof Map

- **INST-01** (Ubuntu 22.04/24.04, installs Docker+Compose if missing, generates `.env`, brings up the stack, applies migrations): proven end to end by `preflight-scenarios.test.ts`'s `"no-Docker apt install path"` describe block (the one real, network-dependent Docker-installation-from-apt run this requirement's own text names) -- combined with Plan 06-11's own `fresh-install.test.ts` (both Ubuntu versions, Docker pre-installed path). Marked complete per hard_rule #12's own explicit instruction, now that the no-Docker apt scenario is green.
- **INST-02** (re-running the installer never destroys data/secrets: detects and updates, or no-ops): proven by `idempotent-rerun.test.ts`'s 8 real, chained scenarios (true no-op, upgrade, no-op again, repair, failed upgrade, manual rollback).
- **INST-03** (preflight fails with an actionable message before touching anything): proven by `preflight-scenarios.test.ts`'s 8 fast real-container scenarios plus the multi-failure ordering case, every one asserting `/opt/noodara` does not exist afterward.
- **INST-04/INST-05**: unaffected by this plan, already `Complete` from Plan 06-11.

## Threat Flags

None -- every new surface this plan introduces (the `reuseDockerVolume` donor mechanism, the dpkg-status watcher, the real `netcat-openbsd` listener) is test-harness-only infrastructure with no production counterpart; no new, un-modeled production surface was introduced. Every threat named in this plan's own `<threat_model>` (T-06-11, T-06-44, T-06-16, T-06-53, T-06-06, T-06-48, T-06-SC) is mitigated by the real assertions described above.

## User Setup Required

None -- no external service configuration required.

## Next Phase Readiness

- INST-01, INST-02 and INST-03 are now all `Complete` in `REQUIREMENTS.md`, alongside INST-04/INST-05 from Plan 06-11 -- every installer requirement this phase owns is proven against real Docker-in-Docker.
- **Load-bearing fact for Plan 06-13 (CI release workflow):** `pnpm test:installer` (the FULL suite: `dind-harness`, `fresh-install`, `preseed-admin`, `control-plane-image`, `web-image`, `compose-stack`, `env-compose-roundtrip`, `env-contract`, `idempotent-rerun`, `preflight-scenarios`) measured **1888.95s (~31.5min)** wall-clock, 51/51 green, on this development machine's own Docker Desktop 29.2/aarch64 VM (14 CPUs, 8GB). Size the CI job's own timeout with real headroom above this figure -- a slower/shared CI runner should be assumed to take longer, not less.
- `install.sh`'s two real fixes (bounded Docker-readiness wait, D-12 diagnosis on a Compose-own dependency-wait failure) are both general, production-applicable fixes -- not test-only branches -- so Plan 06-15's real-VPS validation inherits them for free.
- Known follow-up (not a blocker): this plan's own preflight scenarios all ran on Ubuntu 22.04 only (per the plan's own cost-discipline instruction and precedent from Plan 06-11's `preseed-admin.test.ts`) -- the underlying preflight logic itself is Ubuntu-version-agnostic and already unit-tested on both codenames (`tests/unit/installer/preflight.test.ts`), so this is a deliberate scope choice, not a gap.
- No blockers for Plan 06-13.

---
*Phase: 06-instalador-y-docker-compose*
*Completed: 2026-09-21*

## Self-Check: PASSED

All 7 created/modified files (`tests/integration/installer/idempotent-rerun.test.ts`,
`tests/integration/installer/preflight-scenarios.test.ts`, `install.sh`,
`tests/integration/images/installer-dind-common/entrypoint.sh`,
`tests/integration/helpers/installer-dind.ts`, `tests/unit/installer/docker-install.test.ts`,
`tests/unit/installer/main-flow.test.ts`) verified present on disk; all 8 task/fix commit hashes
(`ea4c0cf`, `4c3ba69`, `99210b8`, `43aae61`, `ab80516`, `3e0e3a8`, `5fa8b3a`, `62c6211`) verified
present in `git log --oneline --all`.
