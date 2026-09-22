---
phase: 06-instalador-y-docker-compose
plan: 02
subsystem: testing
tags: [posix-sh, dash, vitest, installer, preflight]

# Dependency graph
requires:
  - phase: 06-instalador-y-docker-compose
    plan: 01
    provides: install.sh skeleton (exit-code table, noodara_step/warn/note/fail, source-only guard), tests/unit/installer/sh-harness.ts, pnpm check:posix-sh
provides:
  - "install.sh: eight preflight predicates (noodara_check_root, noodara_check_base_commands, noodara_detect_os_version, noodara_check_os, noodara_detect_arch, noodara_check_arch, noodara_total_ram_mb, noodara_check_resources, noodara_resolve_port, noodara_check_port, noodara_check_docker_snap) plus noodara_preflight, which composes seven of them (root -> base commands -> OS -> arch -> resources -> Docker-via-snap -> panel port) in one documented order, stopping at the first failure"
  - "tests/unit/installer/preflight.test.ts: 78 cases (39 per interpreter x 2 interpreters) proving every exit code/message pair under real /bin/sh and /bin/dash, including the two D-17 multi-failure ordering cases and the 30000-vs-3000 port anchoring case"
affects: [06-09-main-flow, 06-10-dind-harness, 06-12-preflight-scenarios]

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "Preflight predicate shape: one noodara_check_<thing>() per D-17 failure cause, each calling noodara_fail <reason> \"<message>\" exactly once and exiting immediately -- no predicate ever accumulates or reports more than one cause"
    - "System-state injection via env-var-overridable readonly constants (NOODARA_OS_RELEASE_FILE, NOODARA_MEMINFO_FILE) for files, and shell-function shadowing (id, uname, command, ss, df, snap) for commands -- both proven deterministic on macOS/dash regardless of host state (hard_rule #9)"
    - "Division for RAM/disk MB conversion happens entirely inside awk, never via a $(( )) arithmetic expansion -- scripts/check-posix-sh.mjs's arith-command rule flags any literal '((' as a bashism finding, a false positive for POSIX arithmetic expansion it cannot distinguish from bash's ((...)) compound command"
    - "Busy-port match is grep -q \":${port} \" (colon + port + literal space), never a [[:space:]] character class -- the latter's own text contains a literal '[[' substring that check-posix-sh's bracket-test rule would flag as a false-positive bashism"

key-files:
  created: []
  modified:
    - install.sh
    - tests/unit/installer/preflight.test.ts

key-decisions:
  - "noodara_check_docker_snap calls `snap list docker >/dev/null 2>&1` directly, with no `command -v snap` existence pre-check -- correct and injectable in all three states (snap absent, snap present without docker, snap present with docker) without depending on whether `command -v` reliably reports a shadowing shell function under dash (the plan's own <action> text names this as the safer fallback)"
  - "noodara_check_resources resolves its disk-check target to NOODARA_INSTALL_DIR's nearest existing ancestor (via ${VAR%/*} parameter expansion, not the external `dirname` utility) when the install directory itself does not exist yet -- a fresh install's /opt/noodara does not exist before installation, so `df -Pk` must target /opt instead"
  - "noodara_preflight checks OS/architecture before resources/snap/port (matches D-17's exact stated order) -- an unsupported OS or architecture makes every later check meaningless, so the cheapest and most fundamental gates run first"

requirements-completed: []  # INST-03 intentionally NOT marked complete -- see Deviations.

# Metrics
duration: ~5min
completed: 2026-09-21
---

# Phase 06 Plan 02: Preflight predicates and noodara_preflight orchestrator Summary

**Eight injectable `sh` preflight predicates (root, base commands, OS, architecture, RAM/disk, panel port, Docker-via-snap) plus `noodara_preflight`, which runs seven of them in one documented order and stops at the first failure, unit-tested with 78 passing cases under real `/bin/sh` and `/bin/dash` with zero system mutation.**

## Performance

- **Duration:** ~5 min (first RED commit to last GREEN commit)
- **Tasks:** 3
- **Files modified:** 2 (`install.sh`, `tests/unit/installer/preflight.test.ts`)

## Accomplishments

- **Task 1 — identity, base commands, OS, architecture:** `noodara_check_root` (exit 10, `id -u`, never `$EUID`), `noodara_check_base_commands` (exit 11, first missing of `curl`/`openssl`/`ss`/`ip`/`awk`/`grep`), `noodara_detect_os_version`/`noodara_check_os` (exit 12, only `ubuntu 22.04`/`ubuntu 24.04` accepted, `/etc/os-release` sourced in a subshell so `ID`/`VERSION_ID` never leak), `noodara_detect_arch`/`noodara_check_arch` (exit 13, `x86_64`->`amd64`, `aarch64`/`arm64`->`arm64`, anything else rejected). `NOODARA_OS_RELEASE_FILE` added as an overridable readonly constant.
- **Task 2 — resources, port, snap Docker:** `noodara_total_ram_mb`/`noodara_check_resources` (exit 14 below 1024MB, stderr warning 1024-2047MB, silent at 2048MB+, exit 15 below 5120MB free disk, `NOODARA_SKIP_RESOURCE_CHECK=1` skips both and never evaluates either input), `noodara_resolve_port`/`noodara_check_port` (exit 16, default 3000, `NOODARA_PORT` override validated digits-only 1-65535, busy-port match anchored on `:<port> ` so port 30000 is never mistaken for port 3000), `noodara_check_docker_snap` (exit 17, naming `sudo snap remove docker`). `NOODARA_MEMINFO_FILE` added as an overridable readonly constant.
- **Task 3 — `noodara_preflight`:** composes all seven checks (root -> base commands -> OS -> architecture -> resources -> Docker-via-snap -> panel port) via direct sequential calls, each predicate's own `noodara_fail` exiting immediately -- no collector, no multi-cause dump. Proven: (a) the combined Docker-via-snap + busy-port scenario exits 17 and names snap, never the port; (b) the combined unsupported-OS + insufficient-RAM scenario exits 12 and names the OS; (c) a fully-passing environment returns 0 with at least one `noodara_step` line on stdout; (d) `noodara_preflight` writes nothing under an empty `NOODARA_INSTALL_DIR` and never invokes a shadowed `apt_get`/`docker` sentinel function, even on the fully-passing path.
- 78 tests pass (39 cases x `/bin/sh` + real `/bin/dash`), `pnpm check:posix-sh` clean (301 lines, zero findings), `pnpm typecheck`/`pnpm lint` clean, full `pnpm test` suite green (122 files, 1641 tests).

## Task Commits

Each task was TDD'd with RED and GREEN as separate commits:

1. **Task 1: Identity, base commands, OS and architecture predicates**
   - `153ad4e` test(06-02): add failing tests for identity, base-command, OS and arch preflight predicates
   - `4870637` feat(06-02): add identity, base-command, OS and arch preflight predicates
2. **Task 2: Resource, port and snap-Docker predicates**
   - `5b2fe80` test(06-02): add failing tests for resource, port and snap-Docker preflight predicates
   - `0b686c8` feat(06-02): add resource, port and snap-Docker preflight predicates
3. **Task 3: `noodara_preflight` — one documented order, first failure wins**
   - `e63e842` test(06-02): add failing tests for noodara_preflight ordering and first-failure semantics
   - `4192c48` feat(06-02): add noodara_preflight orchestrator, one documented order, first failure wins

_Every RED commit was confirmed failing for the expected reason (`exit 127`, function not yet defined) before its paired GREEN commit landed, and every GREEN run passed on the first attempt with no fix-up cycle._

## Files Created/Modified

- `install.sh` - Adds `NOODARA_OS_RELEASE_FILE`/`NOODARA_MEMINFO_FILE` readonly constants and eight preflight predicates plus `noodara_preflight` (196 -> 301 lines)
- `tests/unit/installer/preflight.test.ts` - New file, 78 test cases (39 per interpreter) under `describe.each(posixInterpreters())`, plus fixture helpers (`writeOsReleaseFixture`, `writeMeminfoFixture`, `dfFunctionSnippet`, `buildPassingEnv`) mirroring `skeleton.test.ts`'s conventions

## Decisions Made

- `noodara_check_docker_snap` calls `snap list docker` directly with no `command -v snap` gate -- injectable and correct in all three states without depending on whether `command -v` reports a shadowing shell function reliably under dash.
- Division for RAM/disk MB conversion happens entirely inside `awk`, never via `$(( ))` -- `scripts/check-posix-sh.mjs`'s `arith-command` rule matches any literal `((`, including inside a genuinely POSIX-compliant `$(( ))` arithmetic expansion, so the gate itself forces this design.
- The busy-port grep pattern is `":${port} "` (colon, port, literal space) rather than a `[[:space:]]` POSIX character class -- the character class's own text contains a literal `[[` substring, which `check-posix-sh`'s `bracket-test` rule would flag as a false-positive bashism finding (the scanner is string-based, not context-aware).
- `noodara_check_resources` resolves its disk-check target to `NOODARA_INSTALL_DIR`'s nearest existing ancestor via `${VAR%/*}` parameter expansion (not the external `dirname` utility) when the install directory does not exist yet, since a fresh install's `/opt/noodara` never exists before installation.
- The 06-02-PLAN.md acceptance criterion `grep -c 'EUID\|\[\[' install.sh` returning 0 is unsatisfiable as literally written: 06-01's own skeleton header comment (line 7, already committed and out of this plan's scope) documents "no `[[ ]]`, no `$EUID`" in prose, which the grep pattern matches regardless of any code added by this plan. This plan's own new comments were worded to avoid contributing further matches (count stays at 1, the pre-existing minimum) rather than attempting to edit 06-01's committed header.

## Deviations from Plan

**1. [hard_rule #10 — reality over invented results] `grep -c 'EUID\|\[\[' install.sh` returns 1, not 0.** 06-02-PLAN.md Task 1's acceptance criteria state this command should return 0. `install.sh` line 7 (06-01's own header comment, committed before this plan started and out of this plan's file-modification scope) already contains the literal substrings `$EUID` and `[[ ]]` as prose documenting what the file must *not* contain -- making the literal grep count non-zero regardless of anything this plan adds. This plan's own new comments were worded specifically to avoid adding further matches (verified: count is 1 both before and after this plan's Task 1 commit, i.e. this plan contributes zero additional matches). Not fixed by editing 06-01's already-committed header, since that would be out of scope and the header's own prose is legitimate, accurate documentation, not a real bashism.

**2. [hard_rule #10 — reality over invented results] INST-03 intentionally NOT marked complete.** 06-02-PLAN.md's frontmatter lists `requirements: [INST-03]`, and the standard state-update step calls `requirements.mark-complete` on every listed ID. `REQUIREMENTS.md`'s INST-03 reads "El instalador hace preflight ... y falla con un mensaje accionable **antes de tocar el sistema**" -- describing end-to-end installer behavior. This plan's own `<action>` text for Task 3 explicitly states "Leave `noodara_main` still printing only its banner -- wiring `noodara_preflight` into the real flow happens in Plan 06-09." Running `install.sh` for real today (`sh install.sh` or the published `curl | sh`) still only prints the banner and does not invoke `noodara_preflight` at all -- the predicates and orchestrator exist and are proven correct at the shell-unit layer (D-18 layer 1), but INST-03's actual behavior (the installer itself running preflight and failing before touching the system) is not yet reachable through the real entry point. This mirrors 06-01's identical precedent for the same requirement ID. `REQUIREMENTS.md`'s INST-03 checkbox remains `[ ]` (Pending); it should be marked complete once Plan 06-09 wires `noodara_preflight` into `noodara_main`.

No auto-fixed bugs, missing critical functionality, or blocking issues (Rules 1-3) were encountered -- every RED confirmed failing for the expected reason on the first run, and every GREEN passed on the first attempt.

## Issues Encountered

None beyond the two deviations above (both documentation/requirements-tracking discrepancies, not code defects).

## User Setup Required

None -- no external service configuration required.

## Next Phase Readiness

- All eight preflight predicates and `noodara_preflight` are ready for Plan 06-09 to wire into `noodara_main`'s real install flow, which is what will finally satisfy INST-03 end-to-end and let it be marked complete.
- Plan 06-10's Docker-in-Docker integration suite (D-18 layer 2) can exercise `noodara_preflight` against real Ubuntu 22.04/24.04 containers, snap-installed Docker, busy ports and low-RAM VMs, building directly on this plan's exit-code table and predicate shapes -- no rework needed.
- No blockers for Plan 06-03 (next plan in this phase's wave sequence).

---
*Phase: 06-instalador-y-docker-compose*
*Completed: 2026-09-21*

## Self-Check: PASSED

Both modified files verified present on disk with the expected new content (`install.sh` 301 lines, `tests/unit/installer/preflight.test.ts` 521 lines); all 6 task commit hashes (`153ad4e`, `4870637`, `5b2fe80`, `0b686c8`, `e63e842`, `4192c48`) verified present in `git log --oneline --all`.
