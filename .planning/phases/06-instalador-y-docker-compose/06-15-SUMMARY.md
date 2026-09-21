---
phase: 06-instalador-y-docker-compose
plan: 15
subsystem: testing
tags: [release-gate, human-uat, installer, ci, checkpoint]

# Dependency graph
requires:
  - phase: 06-instalador-y-docker-compose
    plan: 14
    provides: "docs/install.md, README.md and ADR 0007, the operator-facing documents this plan's gate report and prerequisite checklist assume are already accurate"
provides:
  - "06-HUMAN-UAT.md: the full raw-evidence gate run (eleven commands, all green) plus the eleven human-only prerequisites D-02/D-18 layer 3 reserve for the operator, all left unfilled, plus the recorded Task 3 checkpoint decision"
  - "docs/releases/v0.1-gate.md: the v0.1 release gate report (Dashboard, 17-criterion table, Bloqueantes, Notas), overall verdict NOT READY"
  - "an explicit, recorded user decision closing Plan 06-15 with the ten unperformed prerequisites tracked as verification debt, not silently dropped"
affects: [phase-06-instalador-y-docker-compose-closure, v0.1-release-readiness]

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "Release gate as a document, not a checkbox: docs/releases/v0.1-gate.md separates what a local, executable test proves from what only a real GitHub/GHCR/VPS run can prove, per-criterion, with UNVERIFIED as a first-class verdict distinct from NOT READY or READY."

key-files:
  created:
    - docs/releases/v0.1-gate.md
  modified:
    - .planning/phases/06-instalador-y-docker-compose/06-HUMAN-UAT.md

key-decisions:
  - "Task 1's eleven gate commands were run once by the phase orchestrator in a single session against HEAD ad951b5, not by this plan's own executor — this executor's hard_rule #4 forbade re-running any test suite or Docker command, to avoid mixing a fresh partial run with the orchestrator's single consistent single-HEAD record. 06-HUMAN-UAT.md's Gate run section documents this explicitly and reconstructs every row from the raw committed logs."
  - "Two ephemeral NOODARA_SETUP_TOKEN values were masked in gate-logs/08-test-integration.log before commit; no other secret-shaped string was found across all eleven raw logs (documented in 06-HUMAN-UAT.md's Observations)."
  - "The v0.1 gate report holds a stricter bar than REQUIREMENTS.md for INST-01/INST-02: REQUIREMENTS.md marks them Complete as delivered, tested implementation; the gate report keeps them UNVERIFIED because the real docker pull-from-GHCR production path has never been exercised (only locally-built images inside DinD). Both documents are correct in their own terms; this SUMMARY does not flip either checkbox."
  - "At the Task 3 blocking checkpoint, the user chose 'Aceptar con deuda' (accept with debt) — recorded verbatim in 06-HUMAN-UAT.md's new 'Checkpoint decision' section. None of the ten human prerequisites was marked done or reviewed by this decision; every result field in the Human prerequisites table stays [pending]."

requirements-completed: []

# Metrics
duration: continuation session — Tasks 1-2 committed in a prior session (80dd67c, b328246, plus the f436d84 footer fix); this session covers only Task 3's checkpoint resolution and closing documentation
completed: 2026-09-21
---

# Phase 06 Plan 15: v0.1 Release Gate and Human Prerequisites — Checkpoint Resolved Summary

**The v0.1 release gate report (`docs/releases/v0.1-gate.md`, verdict NOT READY) and the eleven-item human-prerequisite checklist are both produced and reviewed; the user accepted closing this plan with the ten unperformed prerequisites tracked as verification debt, exactly as phase 5 was closed — nothing was pushed, released or installed on a real VPS as a result.**

## Performance

- **Duration:** continuation session; Tasks 1 and 2 were completed and committed in a prior session (`80dd67c` gate-run evidence, `b328246` human prerequisites + gate report, `f436d84` a one-line footer fix). This session resolves Task 3 (the blocking human-verify checkpoint) and writes this closing SUMMARY.
- **Completed:** 2026-09-21
- **Tasks:** 3/3 (Task 3's checkpoint answer processed and recorded in this session)
- **Files modified:** 1 (`06-HUMAN-UAT.md`, this session) plus this SUMMARY

## Accomplishments

- Confirmed the three prior-session commits (`80dd67c`, `b328246`, `f436d84`) exist and both governing documents (`06-HUMAN-UAT.md`, `docs/releases/v0.1-gate.md`) are present and unmodified from what the checkpoint presented to the user.
- Recorded the user's verbatim Task 3 checkpoint answer ("Aceptar con deuda (Recomendado)") in a new "Checkpoint decision" section of `06-HUMAN-UAT.md`, stating explicitly that this decision closes the plan without confirming any individual prerequisite — all ten `[pending]` result fields are left exactly as Task 2 wrote them.
- Re-confirmed `git remote -v` prints nothing for this project at the time of this decision — no repository, remote, tag or push exists.
- Carried the verification debt into `.planning/STATE.md` (see below) following the same pattern phase 5 used at its own closing checkpoint (`05-46-GATE.md` / the `f0af32f` phase-5-closure commit).

## Task Commits

Tasks 1 and 2 were completed and committed in a prior session:

1. **Task 1: Run every gate once and record the raw output** — `80dd67c` (docs)
2. **Task 2: Human prerequisites checklist and the v0.1 release gate report** — `b328246` (docs), footer correction `f436d84` (docs)
3. **Task 3: User review of the v0.1 gate and the human prerequisite list** — this session records the resolved checkpoint: `2a168c0` (docs, the "Checkpoint decision" section)

_Note: `f436d84` ("drop an internal tooling path from the v0.1 gate report") was an orchestrator-driven wording fix to `docs/releases/v0.1-gate.md`'s footer between Task 2's commit and this session — not part of this plan's own task sequence, but it did not change any verdict, evidence reference or number in the report._

## Files Created/Modified

- `docs/releases/v0.1-gate.md` — created in the prior session (Task 2): the v0.1 release gate report, Dashboard + 17-criterion table + Bloqueantes + Notas, overall verdict NOT READY
- `.planning/phases/06-instalador-y-docker-compose/06-HUMAN-UAT.md` — Gate run + Human prerequisites sections written in the prior session (Tasks 1-2); this session added the "Checkpoint decision" section recording Task 3's resolution

## Decisions Made

See `key-decisions` in the frontmatter above: the gate run was executed by the orchestrator, not this plan's executor, per hard_rule #4; two ephemeral setup-token values were masked in the committed logs; INST-01/INST-02 deliberately stay `UNVERIFIED` in the gate report despite being `Complete` in `REQUIREMENTS.md` (a documented, intentional discrepancy between a delivered-and-tested-locally bar and a real-production-path bar); the user's checkpoint decision was "accept with debt" and changed no individual prerequisite's result field.

## Deviations from Plan

### Auto-fixed / process notes (not Rule 1-4 code fixes — this plan writes only Markdown)

**1. Task 1's gate run was performed by the phase orchestrator, not this plan's executor.**
- **Found during:** Task 1 (continuation agent resuming after the checkpoint).
- **Issue:** The plan's own Task 1 acceptance criteria describe the executor running all eleven gate commands itself. This executor's governing hard_rule #4 explicitly forbids running any test suite or Docker command in this session.
- **Fix:** The phase orchestrator ran all eleven commands once, in one uninterrupted session, against `HEAD ad951b5`, and committed the raw logs (`gate-logs/`) plus a `HEAD.txt`/`summary.tsv` record. `06-HUMAN-UAT.md`'s Gate run section states this explicitly and reconstructs every row directly from the raw log files, not from memory.
- **Files affected:** `.planning/phases/06-instalador-y-docker-compose/06-HUMAN-UAT.md`, `gate-logs/*`.
- **Verification:** All eleven raw logs exist and are committed (`80dd67c`); every count cited in the Gate run table traces to a specific line in a specific log file.

**2. Two ephemeral test setup tokens were masked before committing a raw log.**
- **Found during:** Task 1, staging `gate-logs/08-test-integration.log` for commit.
- **Issue:** The raw log printed two real (but throwaway, per-test-run) `NOODARA_SETUP_TOKEN=...` values that a public repository should not carry verbatim.
- **Fix:** Both lines replaced with `NOODARA_SETUP_TOKEN=<redacted-ephemeral-test-token>` before commit; no test's pass/fail result changed. A secret-shaped-string scan of all eleven logs found no other unmasked secret.
- **Files affected:** `gate-logs/08-test-integration.log`.
- **Verification:** Documented in `06-HUMAN-UAT.md`'s Observations; `pnpm security:scan-leaks` (a separate, independent canary suite) also reported clean.

**3. The orchestrator edited one footer line of `docs/releases/v0.1-gate.md`.**
- **Found during:** Between Task 2's commit and this session.
- **Issue:** An internal tooling path had leaked into the gate report's footer prose.
- **Fix:** Removed via `f436d84`, a one-line edit with no change to any verdict, evidence reference or number.
- **Files affected:** `docs/releases/v0.1-gate.md`.
- **Verification:** `git show f436d84` — single-line diff, footer only.

---

**Total deviations:** 3, all process/documentation notes rather than code fixes (this plan produces only Markdown). No scope creep.

## Issues Encountered

None beyond the process notes above. The checkpoint resolved cleanly: the user's answer matched one of the plan's own three offered resume-signal options exactly.

## User Setup Required

None from this plan directly — but see `docs/releases/v0.1-gate.md`'s "Bloqueantes" section and `06-HUMAN-UAT.md`'s "Human prerequisites" table for the ten items a human must still perform before v0.1 can be called READY: creating the GitHub repository and pushing `main`; replacing the `REPLACE_WITH_GITHUB_OWNER` placeholder; pushing a real version tag and letting `release.yml` publish both images; making both GHCR packages public; publishing a real non-prerelease GitHub Release; confirming the raw install-script URL resolves; a real `curl | sh` end to end on clean Ubuntu 22.04/24.04 VPS (and once on arm64, with `ufw` active on at least one); watching real memory behaviour on a small production-sized VPS; the first real `ci.yml`/`nightly.yml`/`gitleaks` runs (needed to clear QA-04/QA-05); and the six still-unconfirmed items carried forward from `05-HUMAN-UAT.md`. None of these was performed as part of this plan, by design (D-02).

## Next Phase Readiness

- This is the last plan of the last phase of v0.1. All 15 plans of Phase 6 now have a SUMMARY.
- The v0.1 gate report's verdict is `NOT READY`, honestly, and stays that way in this SUMMARY — nothing here claims v0.1 is released or ready to release.
- `INST-01`..`INST-05` are unchanged by this plan (their `REQUIREMENTS.md` state predates Plan 06-15 and reflects delivered-and-locally-tested implementation, per Plans 06-01 through 06-14; the gate report's own `UNVERIFIED` verdict for criteria 13/14 is a stricter, real-production-path bar, not a contradiction — see `docs/releases/v0.1-gate.md`'s "Discrepancia intencional con REQUIREMENTS.md" note).
- `QA-04`/`QA-05` stay `Pending` in `REQUIREMENTS.md`, unchanged — they need a real GitHub Actions `nightly.yml` run, which cannot happen without the human prerequisites above.
- Phase 6 is executed (15/15 plans have a SUMMARY) but is **not** verified — this SUMMARY does not call `phase.complete`, and `.planning/ROADMAP.md`/`.planning/STATE.md` are updated to reflect "executed, awaiting code review and verification," not "complete," matching how phase 5 was left between its own 46/46 execution and its final user-approved closure.
- Next step: run this phase's code review and verifier against the full 15-plan tree; only after that passes (or the user explicitly accepts remaining findings) should the phase and the v0.1 milestone be marked complete.

---
*Phase: 06-instalador-y-docker-compose*
*Completed: 2026-09-21*
