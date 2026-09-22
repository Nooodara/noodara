---
phase: 06-instalador-y-docker-compose
plan: 10
subsystem: infra
tags: [docker-in-docker, testcontainers, privileged-container, dash, install-sh]

# Dependency graph
requires:
  - phase: 06-instalador-y-docker-compose
    plan: 01
    provides: "vitest.installer.config.ts / tests/integration/installer/tsconfig.json (already listed ../helpers/installer-dind.ts in its include array, anticipating this plan)"
  - phase: 06-instalador-y-docker-compose
    plan: 09
    provides: "install.sh's fully wired noodara_main -- the real entrypoint this plan's harness proves it can copy in and execute under genuine dash"
  - phase: 02-conexion-ssh-segura
    provides: "tests/integration/helpers/ssh.ts's fixture triad shape (labels, log-based wait strategy, idempotent stop, assertNoStrayTestContainers) and the sshd-ubuntu-22.04/24.04 Dockerfile pair's shared-build-context/ARG-guard/apt-repo-Docker-install conventions this plan's images mirror"
provides:
  - "tests/integration/images/installer-dind-common/entrypoint.sh + installer-dind-ubuntu-22.04/24.04/Dockerfile: privileged Ubuntu fixture images, byte-identical except FROM, each able to host a real nested dockerd (or none, for WITH_DOCKER=false) and a snap stub (WITH_SNAP_DOCKER=true)"
  - "tests/integration/helpers/installer-dind.ts: startInstallerDind({ ubuntu, withDocker?, withSnapDocker? }) returning { container, exec, runInstallSh, loadLocalImages, stop } -- a project-owned /var/lib/docker volume per fixture, D-19's docker save/copy/load mechanism with no registry, install.sh executed as a real file under /bin/sh"
  - "tests/integration/installer/dind-harness.test.ts: 16 passing cases (8 per Ubuntu version) proving nested dockerd readiness, host-daemon isolation, dash (not bash), image loading, real install.sh execution (source-only + real-preflight-exit-10), WITH_DOCKER=false and WITH_SNAP_DOCKER=true variants -- zero noodara.test=true leakage"
affects: [06-11-fresh-install-scenarios, 06-12-preflight-scenarios, 06-13-ci-release]

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "A privileged Testcontainers fixture's own /var/lib/docker lives on a dedicated, explicitly pre-created, noodara.test=true-labelled Docker VOLUME (docker volume create, then GenericContainer.withBindMounts([{ source: volumeName, target: '/var/lib/docker' }])) -- never the host's own Docker storage, never a host bind mount. stop() always removes both the container and this volume, and a failed .build()/.start() also removes the volume in its own catch block so a crashed run cannot leak a multi-GB volume silently."
    - "testcontainers@12.1.0's GenericContainer.withPrivilegedMode() takes NO arguments (returns this) -- differs from the plan's own literal '.withPrivilegedMode(true)' text, confirmed by reading node_modules/testcontainers/build/test-container.d.ts before writing the helper."
    - "testcontainers@12.1.0's exec() and GenericContainerBuilder.build() accept no timeout option at all -- installer-dind.ts wraps every exec/build/load in its own withTimeout() (Promise.race against a setTimeout), an explicit, honestly-documented bound on OUR OWN wait, not a cancellation of the underlying dockerd-side command."
    - "installer-dind-common/entrypoint.sh conditionally starts dockerd only when `command -v dockerd` succeeds -- a WITH_DOCKER=false fixture has no daemon to wait for and is ready for exec()-driven tests the instant the script reaches the readiness line, matching install.sh's own real 'Docker missing' starting condition rather than looping until a 120s timeout."
    - "A deterministic, side-effect-free proof that install.sh's real (non-source-only) code path genuinely runs under dash: exec runInstallSh({}, { user: 'nobody' }) -- noodara_check_root is noodara_main's first call, so this fails instantly with the well-known exit 10 (not-root), with zero network/filesystem/docker activity, staying inside this plan's own harness-proof scope (hard_rule #11) rather than reaching into a real scenario."

key-files:
  created:
    - tests/integration/images/installer-dind-common/entrypoint.sh
    - tests/integration/images/installer-dind-ubuntu-22.04/Dockerfile
    - tests/integration/images/installer-dind-ubuntu-24.04/Dockerfile
    - tests/integration/helpers/installer-dind.ts
    - tests/integration/installer/dind-harness.test.ts
  modified: []

key-decisions:
  - "withPrivilegedMode() called with no argument (not '(true)' as the plan's own action text literally says) -- the real installed testcontainers@12.1.0 API takes zero parameters; confirmed against the .d.ts before writing any code, not assumed from the plan text."
  - "entrypoint.sh's header comment and both Dockerfiles' header comments are phrased WITHOUT naming a specific Ubuntu version or the sibling file's literal name (unlike the sshd-ubuntu-22.04/24.04 pair's own headers, which DO cross-reference each other's version number) -- this makes 'diff <(grep -v FROM 22.04) <(grep -v FROM 24.04)' genuinely empty, satisfying this plan's own literal acceptance criterion. Verified the sshd pair's real files do NOT actually pass that same diff command (two lines differ: the version-naming header line and the sibling-file cross-reference) -- a precedent gap, not a defect in this plan's own files."
  - "loadLocalImages's harness self-test uses a re-tagged host-local alpine:3.21 (already present from other suites' own fixtures, ~4.1MB tar) rather than building the full apps/control-plane (1.22GB)/apps/web (402MB) production images -- this plan proves the save/copy/load MECHANISM, not a specific image's content; Plans 06-11/06-12 exercise the same loadLocalImages method against the real production tags for real."
  - "check-posix-sh.mjs's CLI does accept multiple file arguments, but its structural rules (toplevel-side-effect, missing-guard, the arith-command false positive on '$(( ))') are install.sh-specific (a functions-only file ending in a fixed guard block) and fire on every line of entrypoint.sh's ordinary linear script shape for reasons unrelated to genuine POSIX compliance -- verified empirically (20 false-positive findings). Per hard_rule #7's own instruction, entrypoint.sh was NOT added to package.json's check:posix-sh script; POSIX correctness is instead proven by this plan's own dind-harness.test.ts running the real file under real dash on both Ubuntu versions."

requirements-completed: []  # INST-01/02/03 intentionally NOT marked complete, matching 06-03/06-05/06-07/06-09-SUMMARY.md's identical precedent: this plan's own PLAN.md frontmatter names them, but this plan only builds and proves the D-18 layer-2 HARNESS (nested dockerd, D-19 no-registry image loading, genuine dash execution) -- it runs no fresh-install/idempotent-rerun/preflight-matrix scenario (hard_rule #11 forbids it here). The actual end-to-end scenario proofs INST-01/02/03 require are Plans 06-11/06-12's job.

# Metrics
duration: ~25min total session (context reads across four prior plans' SUMMARYs, ssh.ts/postgres.ts/sshd-Dockerfile conventions, manual dockerd verification before writing the TypeScript helper); task commits span 10:05:23-10:12:54 (~8min)
completed: 2026-09-21
---

# Phase 06 Plan 10: Docker-in-Docker installer harness Summary

**A privileged Ubuntu 22.04/24.04 Testcontainers fixture, each hosting its own genuinely isolated nested `dockerd` on a dedicated `noodara.test=true`-labelled volume, proves for real -- on the first run, no fixes needed -- that the repo's real `install.sh` executes under genuine dash and that locally built Noodara images reach the nested daemon via `docker save`/`load` with zero registry involvement (D-19).**

## Performance

- **Duration:** ~25min total session; task/fix commits span 10:05:23-10:12:54 (~8min)
- **Started:** 2026-09-21T~09:55:00-06:00 (approximate, after reading 06-03/06-05/06-07/06-09's own SUMMARYs)
- **Completed:** 2026-09-21T10:12:54-06:00
- **Tasks:** 2
- **Files modified:** 5 (all created)

## Accomplishments

- `tests/integration/images/installer-dind-common/entrypoint.sh` + `installer-dind-ubuntu-22.04/24.04/Dockerfile`: two fixture images, verified byte-identical except `FROM` (`diff <(grep -v '^FROM ' ...) <(grep -v '^FROM ' ...)` produces no output -- a stricter guarantee than the existing `sshd-ubuntu-22.04/24.04` pair, whose own header comments actually do differ by two lines when run through that same diff, see Decisions). `ARG WITH_DOCKER=true` pre-installs Docker Engine + `docker-compose-plugin` via the exact apt-repo sequence `sshd-ubuntu-22.04/Dockerfile` already uses (`/etc/apt/keyrings/docker.asc`, `signed-by=`, no `get.docker.com`); `false` skips it entirely. `ARG WITH_SNAP_DOCKER=false` installs a tiny non-snapd `snap` stub whose `snap list docker` exits 0. `entrypoint.sh` starts `dockerd` in the background only when it is actually installed, waits (bounded, 120x1s polling, never unbounded) for a real `docker version`, then prints the literal readiness line `NOODARA_DIND_READY` and `exec`s `sleep infinity`. Both images verified building clean (~37s each, Docker layer cache warm after the first) and, in a manual pre-implementation spike, a real container from the 22.04 image reached `NOODARA_DIND_READY` in ~3s, reported `docker version` server `29.8.1`, `docker info --format '{{.Driver}}'` = `overlayfs` (nested overlay2-on-overlay2 works natively on this Docker Desktop 29.2/aarch64 VM, no `vfs` fallback needed), an empty `docker ps` from inside (proving isolation from the outer host's own `nuestracasa-neon-proxy`/`decisionmaker-*` containers), and `nobash` from `/bin/sh`.
- `tests/integration/helpers/installer-dind.ts`: `startInstallerDind({ ubuntu, withDocker?, withSnapDocker?, startupTimeoutMs? })` modeled directly on `ssh.ts`'s shape (`.withLabels({ 'noodara.test': 'true' })`, `Wait.forLogMessage(NOODARA_DIND_READY_LINE)`, idempotent `stop()`). A dedicated `docker volume create --label noodara.test=true <random-name>` backs `/var/lib/docker` via `withBindMounts([{ source: volumeName, target: '/var/lib/docker' }])` -- removed by `stop()`, and also removed in a `catch` if `.build()`/`.start()` itself ever fails, so a crashed run cannot leak a multi-GB volume. `exec()`/`runInstallSh()`/`loadLocalImages()` are all wrapped in a `withTimeout()` helper (a `Promise.race` against an explicit `setTimeout`), since `testcontainers@12.1.0`'s own `exec()` and `.build()` accept no timeout parameter at all (confirmed by reading the installed package's `.d.ts` files before writing any code, not assumed). `runInstallSh(env, { timeoutMs?, user? })` copies the real repo-root `install.sh` (resolved from `import.meta.url`) via `copyFilesToContainer` to `/opt/noodara-install-under-test.sh` and execs it as a real file under `/bin/sh <path>` -- never piped through stdin, never `bash`. `loadLocalImages(tags)` measures and returns `tarBytes`/`saveDurationMs`/`loadDurationMs`.
- `tests/integration/installer/dind-harness.test.ts`: `describe.each(['22.04', '24.04'])`, one shared default fixture per Ubuntu version (`beforeAll`/`afterAll`, mirroring `web-image.test.ts`'s own fix of moving the stray-container check into `afterAll` rather than `afterEach` so the intentionally long-lived shared fixture is never misreported as a leak) plus two self-contained-lifecycle `it()` blocks for the `withDocker: false`/`withSnapDocker: true` build-arg variants. **16/16 tests passed on the very first run**, no fixes required: nested `dockerd` answers `docker version` (`Server:` in stdout); `docker ps -a` from inside never lists `nuestracasa-neon-proxy`/`decisionmaker-postgres` (T-06-47 isolation, asserted, not merely observed manually); `/bin/sh` prints `nobash` (T-06-49); `loadLocalImages` on a re-tagged `alpine:3.21` makes `docker image inspect` succeed inside the nested daemon with no registry (D-19); `runInstallSh({ NOODARA_INSTALL_SH_SOURCE_ONLY: '1' })` exits 0 (real file, real dash, source-only proof); `runInstallSh({}, { user: 'nobody' })` exits 10 with a `root`-mentioning stderr message (the real, non-source-only `noodara_main` code path, genuinely reached under dash, deterministically and instantly, with zero side effects -- staying inside this plan's own harness-proof scope per hard_rule #11); `withDocker: false` makes `docker version` fail from inside; `withSnapDocker: true` makes `snap list docker` succeed. `docker ps -a --filter label=noodara.test=true` and `docker volume ls --filter label=noodara.test=true` both confirmed empty after the run; the developer's own `decisionmaker-*`/`nuestracasa-neon-proxy` containers were never touched.

### Measured `docker save`/`docker load` (D-19, for Plan 06-13's CI timeout sizing)

| Ubuntu | tar size | `docker save` | `docker load` |
|---|---|---|---|
| 22.04 | 4,102,656 bytes (~3.9 MiB, `alpine:3.21` re-tagged) | 429ms | 472ms |
| 24.04 | 4,102,656 bytes (~3.9 MiB, `alpine:3.21` re-tagged) | 818ms | 422ms |

These figures are for the harness self-test's small stand-in image, not the real production images -- Plans 06-11/06-12, loading the real `apps/control-plane` (1.22GB) and `apps/web` (402MB) images, should expect proportionally larger tar sizes and save/load durations; the *mechanism*'s own per-operation overhead (container copy, `docker load` invocation) is what these numbers actually characterize.

### Fixture image build/start timings (from the real test run, `--reporter=verbose`)

- Cached-layer default-fixture (`withDocker: true`) startup (build+start+dockerd-ready): well under 1s once Docker's build cache is warm for that Ubuntu variant (the 6 shared-fixture `it()` cases per version total under 2s combined, since `beforeAll` already paid the build+start cost once).
- `withDocker: false` variant (own image build + own container lifecycle per `it()`): 22.04 35.7s, 24.04 33.0s -- dominated by the real Docker Engine apt-repo install still happening in the *default* fixture's own image build earlier in the same describe block (shared Docker build cache absorbs most of it) plus this variant's own distinct image layer.
- `withSnapDocker: true` variant (own image build + own container lifecycle): 22.04 60.3s, 24.04 69.8s -- the slowest cases, since this ARG combination's build layers are not shared with any earlier build in the same run.
- Full file: 350.66s (~5m51s) for all 16 cases across both Ubuntu versions, including image builds -- well under the `900_000ms` (`vitest.installer.config.ts`) per-test/per-hook ceiling, and comfortably below hard_rule #9's "do not run `pnpm test:integration`/`pnpm test:e2e`" prohibition (this is a distinct, smaller suite, per the objective).

## Task Commits

1. **Task 1: Fixture images -- privileged Ubuntu with its own dockerd**
   - `4540184` `feat(06-10): add privileged installer DinD fixture images`
2. **Task 2: startInstallerDind helper and the harness self-test** (`tdd="true"`)
   - `5a08194` `test(06-10): add failing DinD harness self-test` -- confirmed RED: `Cannot find module '../helpers/installer-dind.js' ... ERR_MODULE_NOT_FOUND`
   - `3163803` `feat(06-10): add startInstallerDind Testcontainers helper` -- GREEN, 16/16 passing on the very first run against this implementation

## Files Created/Modified

- `tests/integration/images/installer-dind-common/entrypoint.sh` - Starts (or skips) the nested dockerd, emits the deterministic readiness line, blocks forever
- `tests/integration/images/installer-dind-ubuntu-22.04/Dockerfile` - Privileged Ubuntu 22.04 fixture, `WITH_DOCKER`/`WITH_SNAP_DOCKER` build args
- `tests/integration/images/installer-dind-ubuntu-24.04/Dockerfile` - Identical except `FROM ubuntu:24.04`
- `tests/integration/helpers/installer-dind.ts` - `startInstallerDind()`: privileged fixture, own `/var/lib/docker` volume, `exec`/`runInstallSh`/`loadLocalImages`/idempotent `stop`
- `tests/integration/installer/dind-harness.test.ts` - 16 real-container test cases proving the harness itself on both Ubuntu versions

## Decisions Made

See `key-decisions` in the frontmatter above: `withPrivilegedMode()` takes no argument (plan text said otherwise); header comments phrased to actually satisfy the literal `diff`-empty acceptance criterion (stricter than the existing sshd pair's own real files); the `loadLocalImages` harness proof uses a small re-tagged `alpine:3.21` rather than the full production images; `entrypoint.sh` deliberately not wired into `check:posix-sh` (its structural rules are install.sh-specific and produce 20 false-positive findings on this file's ordinary linear shape, verified empirically).

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug, caught before any code was written] `.withPrivilegedMode(true)` does not match the installed library's real signature**
- **Found during:** Task 2, reading `node_modules/testcontainers/build/test-container.d.ts` before writing `installer-dind.ts` (per this task's own `<read_first>` instruction to read `ssh.ts` and the real API surface first)
- **Issue:** The plan's own `<action>` text says `.withPrivilegedMode(true)`, but `testcontainers@12.1.0`'s `withPrivilegedMode(): this` takes zero parameters -- passing an argument would have been a TypeScript compile error.
- **Fix:** Called `.withPrivilegedMode()` with no argument.
- **Files modified:** `tests/integration/helpers/installer-dind.ts`
- **Verification:** `pnpm typecheck` clean; the real fixture starts privileged (proven by the nested `dockerd` genuinely starting).
- **Committed in:** `3163803` (Task 2 GREEN commit -- caught before the first commit of this file, not a later fix)

---

**Total deviations:** 1 auto-fixed (1 Rule 1 - a plan-text-vs-real-library-signature mismatch, caught during reading before any code existed, not a runtime bug). No scope creep: no fresh-install/idempotent-rerun/preflight-matrix scenario was implemented (hard_rule #11), `install.sh` was not modified, and every rule in hard_rules #1-#12 was followed in full (see the closing report for the complete checklist).

## Issues Encountered

None. Every acceptance criterion in both tasks passed on the first real run against the finished implementation -- no RED/GREEN iteration was needed beyond Task 2's own single planned TDD cycle (module-not-found RED, then a fully passing GREEN). The one deviation above was caught while reading the real library's type declarations, before any code was written that could have failed.

## User Setup Required

None -- no external service configuration required.

## Next Phase Readiness

- `startInstallerDind` is ready for Plans 06-11 (fresh-install scenarios) and 06-12 (preflight-scenario matrix, admin pre-seed) to build real scenario tests directly on top of -- `runInstallSh`/`loadLocalImages`/`exec` are the only surface those plans need; no rework expected in this plan's own files.
- **Load-bearing fact for Plan 06-13 (CI release workflow):** the measured `docker save`/`docker load` overhead for a ~4MB test image was under 1s each way; the real `apps/control-plane` (1.22GB)/`apps/web` (402MB) images will take meaningfully longer -- size the CI job's own timeout from a real measurement against those images in Plan 06-11/06-12, not from this plan's own small-image figures.
- Known follow-up (not a blocker): the `withSnapDocker: true` variant's own image build (not sharing cache with any earlier build in the same run) was this suite's slowest case (60-70s) -- acceptable for a per-push/nightly-gated suite (Plan 06-13), not a concern for this plan's own scope.
- `entrypoint.sh` is intentionally NOT part of `pnpm check:posix-sh`'s file list -- see Decisions above. Its own genuine POSIX/dash correctness is proven by `dind-harness.test.ts` itself running the real file under real dash on both Ubuntu versions, not by the static gate.

---
*Phase: 06-instalador-y-docker-compose*
*Completed: 2026-09-21*

## Self-Check: PASSED

All 5 created files (`tests/integration/images/installer-dind-common/entrypoint.sh`,
`tests/integration/images/installer-dind-ubuntu-22.04/Dockerfile`,
`tests/integration/images/installer-dind-ubuntu-24.04/Dockerfile`,
`tests/integration/helpers/installer-dind.ts`, `tests/integration/installer/dind-harness.test.ts`)
verified present on disk; all 3 task commit hashes (`4540184`, `5a08194`, `3163803`) verified
present in `git log --oneline --all`.
