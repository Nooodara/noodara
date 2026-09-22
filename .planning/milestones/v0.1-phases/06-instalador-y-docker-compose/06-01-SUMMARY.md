---
phase: 06-instalador-y-docker-compose
plan: 01
subsystem: testing
tags: [posix-sh, dash, vitest, testcontainers, installer, static-analysis]

# Dependency graph
requires:
  - phase: 04-http-routes-worker-bullmq-y-sse
    provides: NOODARA_SETUP_TOKEN stdout contract, /health endpoint (consumed by later installer plans, not this one)
provides:
  - "scripts/check-posix-sh.mjs: zero-dependency scanner catching 15 named bashisms plus toplevel-side-effect/missing-guard structural violations in install.sh"
  - "install.sh skeleton: strict-POSIX sh, exit-code table (17 named reasons -> numbered codes), printf-only output helpers, NOODARA_INSTALL_SH_SOURCE_ONLY=1 library mode, truncation-safe final guard dispatch"
  - "tests/unit/installer/sh-harness.ts: spawns real /bin/sh and dash (never bash) to exercise install.sh functions"
  - "vitest.installer.config.ts + tests/integration/installer/tsconfig.json + pnpm test:installer / pnpm check:posix-sh: the DinD installer suite's own config, isolated from pnpm test:integration"
affects: [06-02-preflight, 06-09-main-flow, 06-10-dind-harness, 06-13-ci-release]

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "POSIX-sh-only install.sh: every function opened as `name() {` at column 0 / closed with `}` at column 0, no local/[[ ]]/arrays/pipefail, printf never echo -e"
    - "Source-only library mode via NOODARA_INSTALL_SH_SOURCE_ONLY=1 guard, so a test shell can `. install.sh` without triggering a real install"
    - "Zero-dependency `.mjs` static gate with a CLI-entrypoint guard (pathToFileURL(process.argv[1]).href), mirroring scripts/check-package-provenance.mjs"

key-files:
  created:
    - install.sh
    - scripts/check-posix-sh.mjs
    - tests/unit/scripts/check-posix-sh.test.ts
    - tests/unit/installer/sh-harness.ts
    - tests/unit/installer/skeleton.test.ts
    - vitest.installer.config.ts
    - tests/integration/installer/tsconfig.json
  modified:
    - package.json
    - vitest.integration.config.ts

key-decisions:
  - "Structural rules (toplevel-side-effect, missing-guard) track brace depth only via function-open/close lines matching ^[a-z_][a-z0-9_]*\\(\\) \\{$ / ^\\}$ (per plan's own <action> text), not a general POSIX-sh parser -- deliberate simplification that only works because install.sh's own functions are written in exactly that shape"
  - "missing-guard exemption is index-based (only the literal last three lines of the file), not text-based -- a stray 'fi' closing an unrelated top-level if is still flagged, only the genuine trailing guard block is exempt"
  - "install.sh's exit-code table function prints the numbered code to stdout (for `code=$(noodara_exit_code_for reason)` capture) and only exits directly (code 99) for its own unknown-reason internal-error branch"

patterns-established:
  - "Every install.sh function: `noodara_<name>() {` at column 0, closed with a bare `}` at column 0 -- required both by scanPosixSh's depth tracker and by readability"
  - "install.sh output only ever goes through noodara_step/noodara_warn/noodara_note/noodara_fail -- no other printf/echo call site, so no helper can ever interpolate a secret (T-06-02)"

requirements-completed: []  # INST-01/INST-03 span all 15 plans of this phase; deliberately NOT marked complete by this foundational plan -- see Deviations.

# Metrics
duration: ~20min
completed: 2026-09-21
---

# Phase 06 Plan 01: POSIX-sh gate, install.sh skeleton, installer test wiring Summary

**Zero-dependency `scripts/check-posix-sh.mjs` bashism/structural scanner plus a strict-POSIX `install.sh` skeleton (exit-code table, printf-only output helpers, source-only library mode, truncation-safe dispatch) verified under real `/bin/sh` and `dash`, with the Docker-in-Docker installer suite wired into its own `vitest.installer.config.ts`.**

## Performance

- **Duration:** ~20 min
- **Started:** 2026-09-21T09:30:00Z (approximate; first commit at 09:30:09Z)
- **Completed:** 2026-09-21T09:33:01Z (last task commit; wall-clock for this write-up slightly later)
- **Tasks:** 3
- **Files modified:** 9 (7 created, 2 modified)

## Accomplishments

- `scripts/check-posix-sh.mjs`: catches all 15 named bashisms (`bracket-test`, `euid`, `pipefail`, `local`, `source`, `function-keyword`, `echo-flags`, `append-assign`, `herestring`, `ampersand-redirect`, `case-modifier`, `ansi-c-quote`, `declare`, `arith-command`, `array-literal`) plus `toplevel-side-effect` and `missing-guard`, unit-tested with 21 passing cases, wired as `pnpm check:posix-sh`.
- `install.sh` skeleton: strict POSIX `sh`, `set -eu` only, 17-reason exit-code table (`not-root`→10 ... `health-check-failed`→53), `noodara_step`/`noodara_warn`/`noodara_note`/`noodara_fail` output helpers, sourceable as a pure library via `NOODARA_INSTALL_SH_SOURCE_ONLY=1`, and a three-line truncation-safe final guard dispatch. Passes `pnpm check:posix-sh` clean.
- `tests/unit/installer/sh-harness.ts` + `skeleton.test.ts`: 15 tests run `describe.each(posixInterpreters())`, exercising every skeleton behavior under both `/bin/sh` (bash-flavoured on this macOS dev machine) and real `dash` (confirmed present at `/bin/dash`) -- proving the Pitfall 1 gap (macOS `sh` masking real dash failures) is closed for this file.
- `vitest.installer.config.ts` + `tests/integration/installer/tsconfig.json` + `pnpm test:installer`: the installer's Docker-in-Docker suite now has its own config/tsc project, excluded from `vitest.integration.config.ts`'s `include` via a new `exclude` entry, and `pnpm typecheck` covers `tests/unit/installer/**` transitively through the new tsconfig's `include` list.

## Task Commits

Each task was committed atomically, with TDD tasks split into RED/GREEN commits:

1. **Task 1: Zero-dependency POSIX-sh gate**
   - `1c257a5` test(06-01): add failing tests for scanPosixSh
   - `bd12e1b` feat(06-01): add zero-dependency POSIX-sh static gate
2. **Task 2: install.sh skeleton**
   - `6f38fab` test(06-01): add failing tests for install.sh skeleton
   - `0af9f0b` feat(06-01): add install.sh skeleton
3. **Task 3: Test and typecheck wiring for the installer suite** (config-only, no `tdd="true"`)
   - `b5940d3` chore(06-01): wire installer test/typecheck configs

_Note: Tasks 1 and 2 are `tdd="true"`; each has a separate `test:` (RED, confirmed failing for the right reason -- `ERR_MODULE_NOT_FOUND` and `sh: No such file or directory` respectively) commit before its `feat:` (GREEN) commit. Task 3 has no `<behavior>` block and touches only config files, so it is a single `chore:` commit._

## Files Created/Modified

- `install.sh` - Strict-POSIX sh installer skeleton: constants, exit-code table, output helpers, `noodara_main` stub, source-only guard
- `scripts/check-posix-sh.mjs` - Zero-dependency bashism + structural-violation scanner, exports `scanPosixSh(source)`
- `tests/unit/scripts/check-posix-sh.test.ts` - 21 tests pinning all 15 bashism rules plus the two structural rules
- `tests/unit/installer/sh-harness.ts` - `INSTALL_SH`, `posixInterpreters()`, `runInstallerShell()`, `isDashFamily()` -- spawns real `/bin/sh`/`dash`, never `bash`
- `tests/unit/installer/skeleton.test.ts` - 15 tests exercising install.sh's skeleton behavior under every available POSIX interpreter, plus a CI-only dash-family guard
- `vitest.installer.config.ts` - Own Vitest config for the DinD installer suite (900s timeouts, `pool: forks`, `passWithNoTests: true`)
- `tests/integration/installer/tsconfig.json` - tsc project covering `tests/integration/installer/**` and `tests/unit/installer/**`, plus a forward-reference to Plan 06-10's not-yet-created `installer-dind.ts` helper
- `package.json` - Adds `check:posix-sh`, `test:installer` scripts and an extra `tsc -p` invocation in `typecheck`
- `vitest.integration.config.ts` - Adds `exclude: ['tests/integration/installer/**']` with a comment pointing at the new config

## Decisions Made

- `scanPosixSh`'s brace-depth tracker only recognizes function-open/close lines in the exact `name() {` / `}` shape the plan's own `<action>` text mandates -- not a general POSIX-sh parser. This is safe only because `install.sh` is written in exactly that shape everywhere; documented in the file's own header comment.
- `missing-guard` exemption checks the literal last-three-line index range against the guard block text, not a text-based `.includes()` search -- otherwise a stray `fi` closing an unrelated top-level `if` elsewhere in the file could be silently exempted from `toplevel-side-effect`.
- `noodara_exit_code_for` prints the resolved code to stdout for command-substitution capture (`code=$(noodara_exit_code_for "$reason")`), and only calls `exit 99` directly for its own unknown-reason branch -- matching the plan's literal "any other reason: write ... to stderr and exit 99" wording, while every named reason returns 0 so `noodara_fail` can read its code.

## Deviations from Plan

None in the "auto-fixed while implementing" sense (Rules 1-3) -- no bugs found, no missing critical functionality, no blocking issues. One deliberate scope decision, documented per hard_rule #9 (prefer reality over invented results):

**Requirements INST-01 and INST-03 intentionally NOT marked complete.** The plan's frontmatter lists `requirements: [INST-01, INST-03]`, and the standard state-update step calls `requirements.mark-complete` on every ID in that field. `REQUIREMENTS.md`'s INST-01 ("instala Noodara ... con un solo comando ... instala Docker ... genera .env ... levanta api/worker/web/postgres/redis ... aplica migraciones") and INST-03 ("hace preflight ... y falla con un mensaje accionable") describe end-to-end installer behavior that does not exist yet -- this plan only built the POSIX-sh gate, the `install.sh` skeleton (banner-only `noodara_main`), and test wiring. Checking these requirements off now would misrepresent phase state to the 14 remaining plans and to `/gsd:verify-work`. Both remain `[ ]` (Pending) in `REQUIREMENTS.md`'s traceability table; they should be marked complete only once the plans that actually implement preflight (06-02), Docker install (06-08), `.env` generation (06-04), compose orchestration (06-07/06-09) and the full end-to-end flow (06-09, 06-11) land.

## Issues Encountered

None. Every TDD RED confirmed failing for the expected reason on the first run (`ERR_MODULE_NOT_FOUND` for Task 1, `sh: <path>: No such file or directory` / exit 2 for Task 2), and every GREEN implementation passed on the first run with no fix-up cycles.

## User Setup Required

None - no external service configuration required.

## Next Phase Readiness

- The POSIX-sh gate and shell test harness are ready for every remaining installer plan (06-02 through 06-09) to build on: new `install.sh` functions can be TDD'd against real `/bin/sh`/`dash` immediately, and `pnpm check:posix-sh` will catch any bashism the moment it lands.
- `tests/integration/installer/tsconfig.json`'s forward-reference to `../helpers/installer-dind.ts` (not yet created) is intentional and load-bearing for Plan 06-10 -- do not remove it in an intermediate plan even though it currently matches zero files.
- `vitest.installer.config.ts` currently runs zero tests (`passWithNoTests: true`) -- Plan 06-10 through 06-12 populate it; `pnpm test:installer`'s real runtime is unmeasured until then.
- No blockers for Plan 06-02 (preflight functions), which can build directly on this plan's exit-code table and output helpers.

---
*Phase: 06-instalador-y-docker-compose*
*Completed: 2026-09-21*

## Self-Check: PASSED

All 7 created files verified present on disk; all 5 task commit hashes (`1c257a5`, `bd12e1b`, `6f38fab`, `0af9f0b`, `b5940d3`) verified present in `git log --oneline --all`.
