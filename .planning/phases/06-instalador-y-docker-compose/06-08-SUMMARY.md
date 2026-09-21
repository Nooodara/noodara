---
phase: 06-instalador-y-docker-compose
plan: 08
subsystem: infra
tags: [posix-sh, dash, apt, docker, gpg, vitest]

# Dependency graph
requires:
  - phase: 06-instalador-y-docker-compose
    plan: 01
    provides: install.sh skeleton (exit-code table incl. docker-install-failed=20/compose-plugin-missing=21, noodara_step/warn/note/fail, source-only guard), tests/unit/installer/sh-harness.ts, pnpm check:posix-sh
  - phase: 06-instalador-y-docker-compose
    plan: 02
    provides: install.sh noodara_check_docker_snap (already rejects a snap-installed Docker before any function in this plan runs), NOODARA_OS_RELEASE_FILE
  - phase: 06-instalador-y-docker-compose
    plan: 06
    provides: install.sh noodara_fetch_url (the single injectable curl seam this plan's GPG-key download reuses, never a second direct curl call site)
provides:
  - "install.sh: noodara_docker_present/noodara_compose_present (exit-code-based detection, never command -v), noodara_ensure_docker (the D-14 orchestrator: zero apt calls when both already present, compose-plugin-only install when Docker is present but the plugin is missing, the full apt-repo sequence when Docker is absent), noodara_install_docker + nine individually-attributable named step functions (remove conflicting packages, apt-get update x2, install prerequisites, create the keyring directory, download + chmod the GPG key, write the sources list, install the Docker packages), noodara_ensure_compose_plugin, NOODARA_DOCKER_KEYRING_DIR/NOODARA_DOCKER_SOURCES_FILE overridable constants"
  - "tests/unit/installer/docker-install.test.ts: 49 cases (proportioned across /bin/sh + real /bin/dash) proving presence detection, the three noodara_ensure_docker branches, the exact literal step order, sources-list content (arch + codename pinned to signed-by=/etc/apt/keyrings/docker.asc), per-step failure attribution for four distinct steps, and the non-interactive apt flags -- zero real apt-get/dpkg/gpg/install/chmod invocation, zero real network call, zero write outside a mkdtemp directory"
affects: [06-09-main-flow, 06-10-dind-harness, 06-12-preflight-scenarios]

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "Hyphenated command shadowing: apt-get cannot be shadowed as a POSIX shell function (dash rejects `apt-get() { ... }` with \"Syntax error: Bad function name\" -- confirmed empirically) -- tests/unit/installer/docker-install.test.ts's writeCommandStub instead writes a real executable file named apt-get into a mkdtemp dir and prepends that dir onto PATH, the only portable way to override a hyphenated external command name. dpkg/install/chmod/docker/noodara_fetch_url remain plain shell-function shadows (no hyphen, valid POSIX function names)."
    - "Sentinel-file simulation of a real install taking effect: the apt-get PATH stub touches a sentinel file when its own recorded argv contains the package name it was asked to 'install' (docker-ce or docker-compose-plugin); the shadowed docker() function checks that sentinel to flip from absent/broken to present, letting a single test snippet exercise 'install ran, then presence-check succeeds' without ever running a real apt-get."
    - "_noodara_did_run_apt captures apt-get's combined stdout+stderr via `if out=$(cmd 2>&1); then ...` (the if-condition exemption from `set -e`, already established by noodara_resolve_version/noodara_get_public_ip's own `var=$(...) || fallback` idiom) and only ever prints that captured output (tail -n 40) on failure -- a successful run is silent beyond this file's own noodara_step notices, satisfying hard_rule #9's 'no raw multi-megabyte apt output on success, but enough for diagnosis on failure' without needing a persistent log file at all."
    - "Architecture and OS codename are both validated against an explicit allow-list (amd64/arm64; jammy/noble) inside noodara_docker_write_sources_list itself, before either string is ever interpolated into the apt source line this installer goes on to trust -- deliberately not relying on noodara_check_arch/noodara_check_os having already run, since this function is independently callable and independently tested."
    - "Every apt-get invocation is funneled through the one _noodara_did_run_apt helper (DEBIAN_FRONTEND=noninteractive, -y, --force-confdef/--force-confold, Acquire::http::Timeout/Retries, DPkg::Lock::Timeout) so the non-interactive/timeout contract can never be forgotten on a future call site."
    - "Task 1 shipped a coarse, single-function noodara_install_docker sufficient to pass Task 1's own behavioral tests (zero-apt-when-present, compose-only install + exit 21, full-sequence + exit 20/0); Task 2's RED then added the granular step-order/content/per-step-failure tests, which genuinely failed (exit 127 for five not-yet-existing named functions, or wrong exit/content) against that coarse version, before Task 2's GREEN refactored noodara_install_docker into nine named step functions. This mirrors the plan's own two-task split rather than implementing the final granular design inside Task 1's own GREEN commit, which would have made Task 2's RED phase dishonest (nothing left to genuinely fail)."

key-files:
  created:
    - tests/unit/installer/docker-install.test.ts
  modified:
    - install.sh

key-decisions:
  - "apt-get is shadowed via a real executable file on PATH, not a shell function, because POSIX shell function names cannot contain a hyphen under dash (empirically confirmed: `dash -c 'apt-get() { :; }'` -> \"Syntax error: Bad function name\", exit 2) -- a real portability gap in the existing test-shadowing convention (preflight.test.ts/resolution.test.ts only ever shadow non-hyphenated commands) that this plan's tests are the first to hit and had to solve fresh."
  - "The GPG key is downloaded through noodara_fetch_url's existing body mode (captured via command substitution, then written to a temp file + mv), not a second direct `curl -fsSL -o` call, keeping the locked curl-invocation count at exactly 2 (both inside noodara_fetch_url) and satisfying the objective's own hard rule that no other function may call curl directly."
  - "noodara_ensure_compose_plugin re-runs the full trusted-repository setup (apt-get update, create keyring dir, download+chmod the GPG key, write the sources list, apt-get update) before installing only docker-compose-plugin, rather than assuming a prior noodara_install_docker run already configured Docker's apt repository -- Docker Engine may be present on the host through a route this installer never controlled (e.g. pre-baked into a base image), so the compose-only path cannot assume trust is already established. Every step is idempotent (overwriting an existing keyring/sources file with identical content is a safe no-op)."
  - "Removed conflicting packages via one apt-get remove call naming all seven packages (docker.io, docker-compose, docker-compose-v2, docker-doc, podman-docker, containerd, runc) rather than a per-package loop, with the whole step's exit status discarded (`|| true`) -- Docker's own documented per-package loop tolerates any single removal's failure the same way; a combined call is simpler to argv-pin in tests and produces the identical net effect (an absent package never fails the step)."

requirements-completed: []  # INST-01 intentionally NOT marked complete -- see Deviations (same precedent as every prior plan in this phase: noodara_main still only prints its banner, Plan 06-09 wires everything together).

# Metrics
duration: ~35min (first RED commit to last GREEN commit)
completed: 2026-09-21
---

# Phase 06 Plan 08: Docker Engine and Compose plugin installation Summary

**`install.sh` gains D-14's step-by-step Docker Engine + Compose v2 plugin installer from Docker's official apt repository (GPG key pinned via `signed-by=`, never `get.docker.com`, never Ubuntu's `docker.io`), with `noodara_ensure_docker` leaving an already-provisioned host completely untouched and nine individually-attributable named steps each carrying their own `docker-install-failed` message -- proven by 49 stub-driven unit tests under real `/bin/sh` and `/bin/dash`, zero real apt-get/network calls anywhere.**

## Performance

- **Duration:** ~35 min (first RED commit `3532b6b` to last GREEN commit `faa279f`)
- **Tasks:** 2 (each TDD'd with a genuine RED-then-GREEN pair, four commits total)
- **Files modified:** 2 (1 created, 1 modified)

## Accomplishments

- **Task 1 -- presence detection and the already-installed no-op:** `noodara_docker_present`/`noodara_compose_present` key on `docker version`/`docker compose version`'s real exit code (never `command -v`), matching phase-2 ADR 0004's own detection precedent. `noodara_ensure_docker` composes three branches: both present -> a single `noodara_note`, zero apt-get invocations (proven by an invocation-log-file-never-created assertion); Docker present but the Compose plugin missing -> installs only the plugin, exits 21 if it is still missing afterward; Docker absent -> runs `noodara_install_docker`'s full sequence, exits 20 if `docker version` still fails afterward. Task 1 shipped a working but coarse (single-function, unlabelled-steps) `noodara_install_docker` -- sufficient for Task 1's own acceptance criteria, deliberately not yet the granular design, so Task 2's RED phase would have real new behavior to prove.
- **Task 2 -- the named apt-repo sequence:** `noodara_install_docker` now calls nine separate functions in the exact order Docker's own docs and this repo's own `tests/integration/images/sshd-ubuntu-22.04/Dockerfile` (already CI-verified) establish: remove conflicting packages (best effort) -> `apt-get update` -> install `ca-certificates`/`curl`/`gnupg` -> create the keyring directory (`install -m 0755 -d`) -> download the GPG key through `noodara_fetch_url` (atomic temp-file-then-`mv` write, empty response fails outright) -> `chmod a+r` it -> write the sources list (architecture from `dpkg --print-architecture`, codename from `NOODARA_OS_RELEASE_FILE`'s `VERSION_CODENAME`, both validated against an explicit allow-list before ever reaching the file) -> `apt-get update` -> install the five Docker packages. Every `apt-get` call goes through one `_noodara_did_run_apt` helper adding `DEBIAN_FRONTEND=noninteractive`, `-y`, dpkg conffile auto-answers, and `Acquire`/`DPkg::Lock` timeouts; a failing call prints its own captured output (tail 40 lines) to stderr, a successful call prints nothing beyond this file's own `noodara_step` notices. Each step's own failure exits 20 naming that exact step.
- 49 new tests pass (proportioned across `/bin/sh` + real `/bin/dash`); full `pnpm test` 125 files / 1931 tests green; `pnpm check:posix-sh` clean (1192 lines); `pnpm typecheck`/`pnpm lint` clean.

## Task Commits

Each task was TDD'd with RED and GREEN as separate commits:

1. **Task 1: Presence detection and the already-installed no-op**
   - `3532b6b` test(06-08): add failing tests for Docker presence and ensure_docker no-op
   - `ca9926c` feat(06-08): add Docker presence detection and ensure_docker no-op
2. **Task 2: The apt-repo installation sequence, one named step at a time**
   - `8988e1e` test(06-08): add failing tests for the named apt-repo install steps
   - `faa279f` feat(06-08): decompose Docker install into individually-attributable steps

_Task 1's RED (21/29 cases) failed with exit 127 (functions not yet defined) before its GREEN landed. Task 2's RED (17/49 cases) failed either with exit 127 (five not-yet-existing named functions: `noodara_docker_remove_conflicting_packages`, `noodara_docker_write_sources_list`, `noodara_docker_apt_update`, `noodara_docker_apt_install_prereqs`, `noodara_docker_apt_install_engine`, `noodara_docker_download_gpg_key`) or a wrong exit code/content (the coarse version's `apt-get` calls lacked `DEBIAN_FRONTEND`; its sources line lacked a codename) before its GREEN landed -- confirmed by running the suite and reading each failure reason, not assumed. The remaining Task 2 tests (the exact-order sequence, the "absent package doesn't fail removal" case, the `get.docker.com` absence check) already passed against Task 1's coarse implementation, which had anticipated the correct order and never referenced that domain; this is expected incremental-TDD behavior, not a process gap -- Task 2's genuinely new requirements (named functions, non-interactive flags, arch/codename validation) did fail honestly._

## Files Created/Modified

- `install.sh` - Adds `NOODARA_DOCKER_KEYRING_DIR`/`NOODARA_DOCKER_SOURCES_FILE` overridable constants and `noodara_docker_present`, `noodara_compose_present`, `_noodara_did_run_apt`, `_noodara_did_fail_step`, `noodara_docker_remove_conflicting_packages`, `noodara_docker_apt_update`, `_noodara_did_install_packages`, `noodara_docker_apt_install_prereqs`, `noodara_docker_create_keyring_dir`, `noodara_docker_download_gpg_key`, `noodara_docker_chmod_gpg_key`, `noodara_docker_write_sources_list`, `noodara_docker_apt_install_engine`, `noodara_docker_apt_install_compose_plugin`, `noodara_install_docker`, `noodara_ensure_compose_plugin`, `noodara_ensure_docker` (970 -> 1192 lines)
- `tests/unit/installer/docker-install.test.ts` - New file, 49 test cases under `describe.each(posixInterpreters())` (plus a few interpreter-agnostic structural tests reading `install.sh`'s own source), covering presence detection, `noodara_ensure_docker`'s three branches, the exact literal external-command step order, sources-list content and its two allow-list rejections, four distinct per-step failure messages, and the non-interactive-apt structural checks. Introduces `writeCommandStub` (a real executable-file PATH shadow, needed because `apt-get` cannot be a POSIX shell function name) as a new, reusable test-shadowing pattern.

## Decisions Made

See `key-decisions` in the frontmatter above. In short: `apt-get` is shadowed via a real executable PATH stub (a hyphen makes it an invalid POSIX function name under dash); the GPG key download reuses `noodara_fetch_url`'s existing `body` mode rather than a second direct `curl` call; `noodara_ensure_compose_plugin` re-establishes the full trusted-repo setup rather than assuming a prior full install already configured it; conflicting-package removal is one combined `apt-get remove` call with its exit status discarded.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 2 - Missing Critical] `_noodara_did_run_apt` adds `Acquire::http::Timeout`/`Acquire::Retries`/`DPkg::Lock::Timeout` beyond the plan's own `<action>` text**
- **Found during:** Task 2 planning (before implementation, while reading hard_rule #9)
- **Issue:** 06-08-PLAN.md's Task 2 `<action>` text does not mention apt timeout/retry/lock-wait options at all; hard_rule #9 explicitly requires them ("bounded by apt's own timeouts/retries options where available... a lock wait via `-o DPkg::Lock::Timeout=…` so a running unattended-upgrades does not make the install fail instantly or hang forever").
- **Fix:** Added `-o Acquire::http::Timeout=10 -o Acquire::Retries=3 -o DPkg::Lock::Timeout=60` to every apt-get invocation via the shared `_noodara_did_run_apt` helper.
- **Files modified:** `install.sh`
- **Verification:** `grep -c 'DPkg::Lock::Timeout' install.sh` returns 1 (present exactly once, in the shared helper every call site reuses); full test suite green.
- **Committed in:** `faa279f` (Task 2 GREEN commit)

**2. [Rule 2 - Missing Critical] Architecture allow-list validation added to `noodara_docker_write_sources_list`**
- **Found during:** Task 2 implementation, while reading hard_rule #9's "Validate the codename/arch strings against an allow-list before writing them anywhere"
- **Issue:** 06-08-PLAN.md's own `<behavior>` text only names codename validation implicitly via "only Ubuntu 22.04/24.04"; it does not separately call out architecture validation, but hard_rule #9 requires both.
- **Fix:** `noodara_docker_write_sources_list` now rejects any `dpkg --print-architecture` output other than `amd64`/`arm64` with its own named-step failure, before the codename check, before either string is interpolated into the sources file.
- **Files modified:** `install.sh`
- **Verification:** New test "fails with exit code 20 when the architecture is not amd64 or arm64" (both interpreters) passes; the sources file is confirmed absent on that failure path.
- **Committed in:** `faa279f` (Task 2 GREEN commit)

**3. [hard_rule #11 -- reality over invented results] Two of the plan's own literal grep acceptance criteria are unsatisfiable given a genuinely required removal-list entry.** 06-08-PLAN.md Task 1's acceptance criteria state `grep -c 'docker-compose ' install.sh` must return 0 ("the standalone v1 binary is never referenced"), and Task 2's `<behavior>` text separately requires the conflicting-package removal step to cover, verbatim, "docker.io, docker-compose, docker-compose-v2, docker-doc, podman-docker, containerd, and runc" (also matching Docker's own official documented removal list and 06-RESEARCH.md Pattern 5's own note). These two requirements directly conflict: the single removal-step code line `apt-get remove ... docker.io docker-compose docker-compose-v2 docker-doc podman-docker containerd runc` necessarily contains the literal substrings `docker.io ` and `docker-compose ` (a space-separated list, "docker-compose" immediately followed by a space before "docker-compose-v2"). Implementing the required removal list correctly (matching Docker's own docs and this plan's own explicit behavior spec) was preferred over contorting the code's formatting (e.g. a backslash-continuation trick placing "docker-compose" alone on its own physical line) purely to dodge a blunt-instrument grep -- that would have been gaming the checker rather than honestly reporting a real conflict, which hard_rule #11 explicitly forbids ("do not invent results"). This mirrors 06-06-SUMMARY.md's own precedent (Real test bug 2) for an analogous literal-acceptance-criterion/actual-behavior conflict.
  - **Actual measured results (not invented):** `grep -c 'docker-compose ' install.sh` returns **1** (not 0), and `grep -v '^[[:space:]]*#' install.sh | grep -c 'docker\.io'` returns **1** (not 0) -- both matches are the single removal-step line, line 339 (`_noodara_did_run_apt remove docker.io docker-compose docker-compose-v2 docker-doc podman-docker containerd runc || true`).
  - **What IS satisfied:** `grep -c 'get\.docker\.com' install.sh` returns 0 (never a third-party curl-pipe-sh installer), and `noodara_compose_present` genuinely never checks for or invokes a standalone `docker-compose` v1 binary (a dedicated test proves its function body contains `docker compose version` and not `docker-compose`) -- the actual security-relevant intent behind both criteria (never trust/invoke the deprecated v1 binary, never install from an unauthenticated source) is fully met; only the blunt literal-substring grep is defeated by the legitimate package-name text.

**4. [hard_rule #12/#11 precedent -- requirements tracking] INST-01 intentionally NOT marked complete.** 06-08-PLAN.md's frontmatter lists `requirements: [INST-01]`, and the standard state-update step calls `requirements.mark-complete` on every listed ID. INST-01 describes end-to-end installer behavior reachable only through the real `curl | sh` entrypoint. This plan built and proved Docker installation in isolation at the shell-unit layer (D-18 layer 1) -- `noodara_main` still only prints its banner and calls none of the functions this plan adds (Plan 06-09 wires everything together). This mirrors every prior plan in this phase's identical precedent for the same requirement family (06-01/06-02/06-04/06-06). `REQUIREMENTS.md`'s INST-01 checkbox remains as it was; `requirements.mark-complete` was deliberately not run for this plan.

---

**Total deviations:** 2 auto-fixed (both Rule 2 -- missing critical security/robustness behavior named by hard_rule #9 but not spelled out in the plan's own `<action>` text), plus 1 documented literal-acceptance-criterion conflict (not a code defect -- a real, necessary removal-list entry unavoidably matches two blunt substring greps) and 1 requirements-tracking deviation (also not a code defect). No scope creep -- everything stays inside this plan's two files.

## Issues Encountered

- **`apt-get` cannot be shadowed as a POSIX shell function.** Discovered while designing the first Task 2 test: `dash -c 'apt-get() { :; }; apt-get'` fails with `dash: 1: Syntax error: Bad function name` (POSIX function names cannot contain a hyphen; bash is more permissive but dash, the real interpreter `curl | sh` runs under on Ubuntu, is not). Every prior plan's tests only ever needed to shadow non-hyphenated commands (`snap`, `ss`, `df`, `ip`, `docker`), so this gap had never surfaced before. Resolved by writing a real executable stub file named `apt-get` into a `mkdtemp` directory and prepending that directory onto `PATH` for the test process -- confirmed working empirically before writing any test against it, and documented at the top of `docker-install.test.ts` for future plans (06-10/06-11's Docker-in-Docker harness) that may need the same technique for other hyphenated commands.
- **A naive "compose-only install" test initially expected exit 0 but got exit 21.** The first draft of "installs only the Compose plugin when Docker is present but the plugin is missing" had `docker()` always report the compose subcommand as failing, which is indistinguishable from "the plugin never actually gets installed" -- correctly producing exit 21 (the same scenario as the adjacent "still missing after installation" test). Fixed by introducing a sentinel-file simulation: the `apt-get` stub touches a sentinel when its own recorded argv shows the plugin package being installed, and `docker()` checks that sentinel to flip from failing to succeeding, genuinely distinguishing "the plugin got installed and now works" from "the plugin never came up" without ever running real apt-get.

## Known Stubs

None -- no UI or data-flow stubs; this plan is shell logic and tests only.

## Threat Flags

None -- every new surface this plan introduces (the third-party apt repository trust boundary, the GPG key fetch, the sources-list write) was already named and mitigated in this plan's own `<threat_model>` (T-06-06 [pre-existing], T-06-37, T-06-38, T-06-39, T-06-40, T-06-SC). No new, un-modeled surface was introduced. The two Rule-2 additions (apt timeout/lock options, architecture allow-list) strengthen already-modeled mitigations (T-06-38, the "unsupported codename must fail, not be interpolated" requirement) rather than opening new ones.

## User Setup Required

None -- no external service configuration required.

## Next Phase Readiness

- `noodara_ensure_docker` is ready for Plan 06-09 to wire into `noodara_main`'s real install flow (preflight -> Docker install -> `.env` -> compose up -> migrate -> health-check), which is what will finally satisfy INST-01 end-to-end and let it be marked complete.
- Plan 06-10/06-11's Docker-in-Docker layer-2 suite can exercise the real apt-repo sequence against genuine Ubuntu 22.04/24.04 containers -- the exact command sequence this plan translates from `tests/integration/images/sshd-ubuntu-22.04/Dockerfile` is already proven to build successfully in this repo's own CI, so no rework is expected there.
- The `writeCommandStub` PATH-shadowing pattern introduced here is directly reusable by any future plan that needs to shadow another hyphenated command (e.g. `docker-compose` itself, `iptables-legacy`, or any other external tool with a hyphen in its name).
- No blockers for Plan 06-09 (next plan in this phase's wave sequence).

---
*Phase: 06-instalador-y-docker-compose*
*Completed: 2026-09-21*

## Self-Check: PASSED

Both files verified present on disk with the expected new content (`install.sh` 1192 lines, `tests/unit/installer/docker-install.test.ts` 456 lines); all 4 task commit hashes (`3532b6b`, `ca9926c`, `8988e1e`, `faa279f`) verified present in `git log --oneline --all`.
