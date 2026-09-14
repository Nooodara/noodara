---
phase: 02-adaptador-ssh-aislado-y-probado-con-testcontainers
plan: 02
subsystem: testing
tags: [testcontainers, sshd, docker, fixtures, qa-03, serv-08]

# Dependency graph
requires:
  - phase: 02-adaptador-ssh-aislado-y-probado-con-testcontainers
    provides: "02-01's packages/ssh scaffold, SshPort/ConnectOutcome contracts and the frozen command allowlist — this plan builds the real infrastructure those contracts will be tested against, but does not itself import packages/ssh"
provides:
  - "tests/integration/images/sshd-ubuntu-22.04/Dockerfile and sshd-ubuntu-24.04/Dockerfile — project-owned sshd fixture images (no prebuilt third-party image) with the full SERV-08 user matrix (root key-only, deployer sudo+docker, restricted neither, pwuser password-only), a default-off WITH_DOCKER_CLI variant (CLI present, no daemon), and a default-off WITH_SLOW_DF variant for the mid-exec CONNECTION_LOST primitive"
  - "tests/integration/helpers/ssh.ts — startSshd/readTestKey/hostKeyFingerprint/startBlackholeListener/waitForSlowCommandStart/assertNoStrayTestContainers, the one Testcontainers entrypoint every QA-03 scenario in plans 02-04..02-10 will use"
  - "tests/integration/ssh/images.test.ts — 16 passing tests proving the fixture matrix independently of packages/ssh, across both Ubuntu versions"
affects: ["02-04..02-10 (every remaining QA-03 scenario plan starts sshd fixtures through startSshd() and stages CONNECT_TIMEOUT/HOST_KEY_CHANGED/CONNECTION_LOST through the primitives built here)"]

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "Project-owned Testcontainers fixture images built via GenericContainer.fromDockerfile(context, dockerfileName) with withBuildArgs, mirroring postgres.ts's .withLabels({'noodara.test':'true'})/idempotent-stop() shape exactly"
    - "Host-key regeneration on every container start (rm -f + ssh-keygen -A in entrypoint.sh) as the deterministic basis for HOST_KEY_CHANGED, instead of an in-place sshd restart"
    - "Observable-marker-file gating (touch a file, then block, then exec the real binary) as the pattern for staging a mid-exec channel-death scenario without any fixed sleep in the test code — waitForSlowCommandStart polls container.exec back-to-back with no timer, each round trip itself providing the pacing"
    - "Accept-then-silent TCP listener (busybox nc -l in a while-loop) as the CONNECT_TIMEOUT primitive, chosen over an unroutable IP for CI-network determinism (02-RESEARCH.md Assumption A4)"

key-files:
  created:
    - tests/integration/images/sshd-common/entrypoint.sh
    - tests/integration/images/sshd-common/setup-users.sh
    - tests/integration/images/sshd-common/slow-df.sh
    - tests/integration/images/sshd-common/sshd_config.d/noodara-test.conf
    - tests/integration/images/sshd-ubuntu-22.04/Dockerfile
    - tests/integration/images/sshd-ubuntu-24.04/Dockerfile
    - tests/integration/helpers/ssh.ts
    - tests/integration/ssh/images.test.ts
  modified: []

key-decisions:
  - "WITH_DOCKER_CLI installs docker-ce-cli + docker-compose-plugin from Docker's own apt repository (with a per-build GPG key + apt source added only inside that conditional RUN layer), not Ubuntu's docker.io package — docker-ce-cli genuinely ships no daemon binary, which the plan's acceptance criterion (pgrep dockerd reports nothing) requires; docker.io bundles dockerd in the same package and could not guarantee that."
  - "The slow-df shim is always COPY'd into the image at a non-PATH location (/opt/noodara/slow-df.sh) and only ever copied onto /usr/local/bin/df inside the WITH_SLOW_DF conditional — Dockerfile COPY has no conditional form, so this two-step copy-then-conditionally-install is what keeps the default image's df byte-identical to an unmodified Ubuntu image."
  - "startSshd always supplies a fresh SSH_TEST_KEY_PASSPHRASE, so entrypoint.sh always generates ed25519_locked and appends it to root's and deployer's authorized_keys on every container start, regardless of scenario. images.test.ts's root-authorized_keys assertion checks the three build-time public keys are present as substrings rather than asserting an exact line count of 3, since a real fixture always has this fourth key too."
  - "assertNoStrayTestContainers reuses vitest's `expect` (imported directly, not via globals) so a failure renders the same assertion diff the original inlined migrations.test.ts version did; testcontainers' NetworkClient exposes no list() method (only getById/create/remove), so there is no equivalent network-level stray check to add — every network this phase creates is owned and torn down by Testcontainers' own container lifecycle."

patterns-established:
  - "Any later phase-2 plan needing a real sshd container imports only tests/integration/helpers/ssh.ts, never testcontainers directly — the six exported functions are the complete surface area."
  - "Blocking-command shims for connection-loss testing follow the touch-marker-then-block-then-exec-real-binary shape: observable via a file the test polls, and safe-by-default (degrades to a slow real success) if a scenario never triggers on it."

requirements-completed: [QA-03, SERV-08]

# Metrics
duration: ~65min
completed: 2026-09-14
---

# Phase 2 Plan 2: Project-owned sshd fixture images and startSshd Testcontainers helper Summary

**Two project-owned Ubuntu 22.04/24.04 sshd Dockerfiles (full SERV-08 user matrix, opt-in Docker-CLI-without-daemon and blocking-`df` variants) plus a six-function Testcontainers helper (`startSshd`, `readTestKey`, `hostKeyFingerprint`, `startBlackholeListener`, `waitForSlowCommandStart`, `assertNoStrayTestContainers`) and a 16-test smoke suite proving the whole matrix, independent of `packages/ssh`.**

## Performance

- **Duration:** ~65 min active work
- **Tasks:** 3 completed
- **Files modified:** 8 (all created, none modified)

## Accomplishments
- Both Ubuntu sshd fixture images build cleanly in four variants (plain, docker-CLI, slow-df, and their 22.04/24.04 pairing) with no prebuilt third-party image, no key material or password ever committed, and a `.gitleaks.toml` that needs no new exception for any of these paths
- `deployer`/`restricted`/`root`/`pwuser` exactly match the SERV-08 matrix: verified manually (`id -nG`, `sudo -n -u root true` as each user) and again in the automated smoke suite for both Ubuntu versions
- The two scenario-simulation problems 02-RESEARCH.md flagged as open questions are resolved with concrete, working primitives: an accept-then-silent TCP listener (`startBlackholeListener`) instead of an unroutable IP for `CONNECT_TIMEOUT`, and an observable marker-file shim (`slow-df.sh` + `waitForSlowCommandStart`) instead of a raced sleep for the mid-exec `CONNECTION_LOST` scenario
- `tests/integration/ssh/images.test.ts` passes 16/16 across both Ubuntu versions, proving host-key regeneration produces different fingerprints per start, the Docker-CLI variant has no running daemon, and the slow-df shim degrades to a real, successful `df` when nothing kills the connection
- Full regression run stayed green: `pnpm build`, `pnpm lint`, `pnpm typecheck`, `pnpm boundaries`, 386/386 unit tests, and 129/129 integration tests (113 pre-existing + 16 new), with zero `noodara.test=true` containers left running afterward

## Task Commits

1. **Task 1: Project-owned sshd images for Ubuntu 22.04 and 24.04** - `b775457` (feat)
2. **Task 2: startSshd Testcontainers helper, blackhole listener and cleanup assertion** - `cdc7679` (feat)
3. **Task 3: Smoke test proving the fixture matrix** - `aafaad9` (test)

**Plan metadata:** (this commit) `docs: complete plan`

## Files Created/Modified
- `tests/integration/images/sshd-common/entrypoint.sh` - container-start regeneration of host keys, pwuser password/lock from `SSH_TEST_PASSWORD`, D-02's `ed25519_locked` generation from `SSH_TEST_KEY_PASSPHRASE`, then `exec sshd -D -e`
- `tests/integration/images/sshd-common/setup-users.sh` - build-time creation of root/deployer/restricted/pwuser with the exact SERV-08 sudo/docker-group matrix
- `tests/integration/images/sshd-common/slow-df.sh` - default-off `df` shim: touch marker, sleep 20s, exec real `df`
- `tests/integration/images/sshd-common/sshd_config.d/noodara-test.conf` - PubkeyAuthentication + PasswordAuthentication + KbdInteractiveAuthentication (D-03), PermitRootLogin prohibit-password
- `tests/integration/images/sshd-ubuntu-22.04/Dockerfile` / `sshd-ubuntu-24.04/Dockerfile` - identical except `FROM`; `ARG WITH_DOCKER_CLI`/`WITH_SLOW_DF`, build-time keypair generation, conditional Docker-CLI-only install from Docker's apt repo
- `tests/integration/helpers/ssh.ts` - `startSshd`, `readTestKey`, `hostKeyFingerprint`, `startBlackholeListener`, `waitForSlowCommandStart`, `assertNoStrayTestContainers`
- `tests/integration/ssh/images.test.ts` - 16-test smoke suite (`describe.each(['22.04','24.04'])`) proving the whole matrix via `container.exec`, never SSH

## Decisions Made
See `key-decisions` in frontmatter. Summary: (1) Docker CLI variant uses `docker-ce-cli` from Docker's own apt repo, not Ubuntu's `docker.io`, because only the former guarantees no daemon binary ships; (2) the slow-df shim is always copied into the image and only conditionally promoted onto the `df` PATH entry, since `COPY` has no conditional form; (3) `startSshd` always supplies a passphrase, so the smoke test asserts root's three build-time keys are present as substrings rather than an exact `authorized_keys` line count; (4) `assertNoStrayTestContainers` has no network-level equivalent to add, since `testcontainers`'s `NetworkClient` exposes no `list()`.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] Smoke test's root-`authorized_keys` count assertion was wrong given the helper's own always-on passphrase**
- **Found during:** Task 3 (`pnpm exec vitest run` first pass — 2/16 tests failed)
- **Issue:** The test asserted `root/.ssh/authorized_keys` has exactly 3 lines, but `startSshd` always generates a fresh `SSH_TEST_KEY_PASSPHRASE` (as the plan's Task 2 action specifies), so `entrypoint.sh` always creates `ed25519_locked` and appends its public key to root's file too — every real fixture has 4 keys, not 3.
- **Fix:** Changed the assertion to check that each of the three build-time public keys (`ed25519`, `rsa3072`, `ecdsa`) appears as a substring of `authorized_keys`, rather than asserting an exact line count — accurate to the fixture's actual, intended behavior (D-02 is always active) without weakening the check.
- **Files modified:** `tests/integration/ssh/images.test.ts`
- **Verification:** Full `pnpm exec vitest run --config vitest.integration.config.ts tests/integration/ssh/images.test.ts` — 16/16 pass
- **Committed in:** `aafaad9` (Task 3 commit)

---

**Total deviations:** 1 auto-fixed (test-assertion bug found by running the plan's own verification command)
**Impact on plan:** Necessary to make the plan's stated verification command pass against the fixture's actual, correct behavior. No scope creep.

## Issues Encountered
- On the first full-suite run, one of 16 tests (`the docker-CLI variant has docker on PATH...`, Ubuntu 22.04) failed with a generic `Failed to build image` error from Testcontainers' `GenericContainerBuilder.build()` — most likely a transient network hiccup reaching Docker's apt repository during that particular build. A manual `docker build --no-cache` of the identical Dockerfile/args succeeded immediately afterward, and re-running the single failing test in isolation passed on the first try, and the full suite then passed 16/16 on a subsequent clean run. Not reproducible; not a defect in the Dockerfile or helper. Documented here rather than "fixed," since there was nothing in this repo's code to change — noting for plan 02-10, which already tracks the CI implication of building up to four image variants on first run, that network flakiness against Docker's apt repo during the `WITH_DOCKER_CLI` build is a possible (if rare, based on this session) source of CI flake to watch for.
- The first attempt at manually verifying Task 1's acceptance criteria (`docker run --rm noodara-test-sshd:24.04 sh -c '...'`) forgot that the image's `ENTRYPOINT` swallows a bare `sh -c '...'` as *arguments to* `entrypoint.sh` rather than replacing it, since Docker only replaces the container's `CMD`, not its `ENTRYPOINT`, when a command is passed to `docker run`. Every affected `docker run` in that manual session started `sshd -D -e` and hung instead of running the intended one-off command, producing three stray, unlabelled (no `noodara.test=true`, since these were plain `docker run` invocations rather than fixtures started through the helper) sshd containers that had to be found (`docker ps -a --filter ancestor=...`) and force-removed one at a time as a backgrounded shell script kept advancing to its next queued command each time the current container was killed. All were confirmed removed (`docker ps -aq --filter label=noodara.test=true` → 0, and no `noodara-test-sshd:*`-tagged image or container left) before any commit. Corrected by adding `--entrypoint sh` to every subsequent manual verification `docker run`. No project files were affected; this was a manual-verification mistake, not a defect in `entrypoint.sh` or the Dockerfiles.

## User Setup Required

None - no external service configuration required.

### Note on REQUIREMENTS.md tracking granularity
Running `requirements.mark-complete QA-03 SERV-08` (per this plan's own `requirements:` frontmatter) marked both as `[x] Complete` in `.planning/REQUIREMENTS.md`, including the traceability table. That tool has no notion of partial/contributing completion — it is a first-write-wins checkbox. Neither requirement is actually fully satisfied yet by roadmap's own definition: `02-04-PLAN.md` also lists `QA-03` (the actual eight-scenario integration coverage this plan's infrastructure enables but does not itself provide — this plan ships one smoke test proving the fixture matrix, not the SEC-03/SERV-07/timeout/reconnect scenarios) and `02-09-PLAN.md` also lists `SERV-08` (the real `sudo -n`/`id -nG` checks run from `packages/ssh`, not yet implemented — this plan only proves the container-level user matrix the checks will run against). Flagging here so `noodara-release-gate`/a future verifier checks the phase's actual acceptance criteria rather than trusting this checkbox alone before both requirements' completing plans (02-04, 02-09) land.

## Next Phase Readiness
- `startSshd`, `readTestKey`, `hostKeyFingerprint`, `startBlackholeListener`, `waitForSlowCommandStart`, and `assertNoStrayTestContainers` are all in place, typechecked (manually, via a scratch `tsc --noEmit` — see Known Gaps below), and proven against real containers for both Ubuntu versions — plan 02-04's Wave 0 spikes and every subsequent QA-03 scenario plan (02-05..02-10) can start fixtures and stage `HOST_KEY_CHANGED`/`CONNECT_TIMEOUT`/mid-exec `CONNECTION_LOST` with zero further infrastructure work.
- No blockers for 02-03 (parallel plan in this same wave) or 02-04.

### Known Gaps (pre-existing, out of scope)
- Neither `pnpm typecheck` nor `pnpm lint` actually cover anything under `tests/integration/**` — both are `turbo run` tasks scoped to `packages/*`/`apps/*`, and there is no root `tsconfig.json` or root ESLint config that includes the `tests/` tree. This predates this plan (confirmed identically for the already-committed `tests/integration/helpers/postgres.ts`) and is not introduced or worsened here. Both new files (`ssh.ts`, `images.test.ts`) were manually verified with a scratch `tsc --noEmit` configuration (strict, matching `packages/config/tsconfig.base.json`) and produced zero errors, and the real `pnpm exec vitest run` exercised them at runtime, but this is not a substitute for the repo having real static coverage of its own integration-test tree. Not fixed here — orthogonal to this plan's scope and shared by every existing `tests/integration/**` file.

---
*Phase: 02-adaptador-ssh-aislado-y-probado-con-testcontainers*
*Completed: 2026-09-14*

## Self-Check: PASSED

- All 8 created files verified present on disk (`tests/integration/images/**`, `tests/integration/helpers/ssh.ts`, `tests/integration/ssh/images.test.ts`).
- All 3 task commit hashes (`b775457`, `cdc7679`, `aafaad9`) verified present in `git log`.
