---
phase: 08-redise-o-de-la-app
plan: 02
subsystem: ui
tags: [playwright, testcontainers, vitest, screenshot-capture, approval-gate]

# Dependency graph
requires:
  - phase: 08-redise-o-de-la-app
    provides: "08-01: scripts/ui/{review-paths,capture-ui-review}.ts pipeline, docs/ui/APPROVAL.md pending shape, tests/unit/ui/approval-record.test.ts"
provides:
  - "docs/ui/APPROVAL.md's G1 block filled in: 2026-09-25, 0 adjustment rounds, Pablo Gutierrez, evidence pointing at docs/ui/approved/"
  - "docs/ui/approved/ populated with the 12 committed 1280px screen captures (6 screens x 2 themes) the G1 approval was given against"
  - ".planning/phases/08-redise-o-de-la-app/08-BASELINE-NOTES.md, the baseline record the surface plans (08-05, 08-07, 08-08) read"
affects: ["08-05", "08-07", "08-08", "08-11", "08-19"]

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "Gate-fill plans copy the approved gate's 1280px screen captures from docs/ui/review/ into docs/ui/approved/ (never captured there directly), mirroring docs/brand/approved/'s own board-then-copy precedent from Phase 7"

key-files:
  created:
    - .planning/phases/08-redise-o-de-la-app/08-BASELINE-NOTES.md
    - docs/ui/approved/setup-light.png
    - docs/ui/approved/setup-dark.png
    - docs/ui/approved/login-light.png
    - docs/ui/approved/login-dark.png
    - docs/ui/approved/servers-light.png
    - docs/ui/approved/servers-dark.png
    - docs/ui/approved/server-detail-light.png
    - docs/ui/approved/server-detail-dark.png
    - docs/ui/approved/activity-light.png
    - docs/ui/approved/activity-dark.png
    - docs/ui/approved/settings-light.png
    - docs/ui/approved/settings-dark.png
  modified:
    - docs/ui/APPROVAL.md

key-decisions:
  - "G1's Evidence row points at docs/ui/approved/, not docs/ui/review/ as the plan's own Task 3 action text literally says -- the actual test (approval-record.test.ts) asserts every gate's Evidence row contains 'docs/ui/approved/', and review-paths.ts's own header comment states plainly that the gate plans' job is to copy the approved 1280px screen set from review/ into approved/. Followed the test and the established Phase-7 pattern (docs/brand/approved/) over the plan prose, since the two disagreed and the test is what actually gates CI."
  - "The 12 files copied into docs/ui/approved/ are the six screens only, at 1280px, both themes -- the three overlay captures (sheet/dialog/row-menu) are excluded, matching approvedPngPath's own signature (Screen, Theme) and approval-record.test.ts's exact 13-file pin (12 screens + README.md)."
  - "The user approved G1 globally, in one sentence, with no per-screen notes and nothing raised outside D-01..D-11. 08-BASELINE-NOTES.md records the verbatim verdict once and states plainly, once per screen, that no per-screen note was given -- it does not invent notes the user did not make, per the plan's own explicit instruction not to paraphrase the user's words into implementation instructions."

patterns-established:
  - "A gate's Evidence row content is validated against the test file, not against the plan's own prose, whenever the two disagree -- the test is the actual CI gate."

requirements-completed: [UI-12]

# Metrics
duration: ~20min
completed: 2026-09-25
---

# Phase 8 Plan 2: G1 baseline gate Summary

**G1 (baseline) approved on the first pass with zero adjustment rounds; `docs/ui/APPROVAL.md`'s G1 block and `docs/ui/approved/`'s 12 committed 1280px screen captures now form the real, machine-checked evidence trail, and `08-BASELINE-NOTES.md` records the user's verbatim global approval for the surface plans to read.**

## Performance

- **Duration:** ~20 min (this continuation session; Task 1/2 ran in the prior session, see below)
- **Started:** 2026-09-25 (continuation, after G1 human checkpoint resolution)
- **Completed:** 2026-09-25
- **Tasks:** 3 (1 auto, 1 checkpoint:human-verify, 1 auto)
- **Files modified:** 14 (1 approval doc, 1 baseline-notes doc, 12 approved PNGs)

## Accomplishments
- G1 gate recorded as approved: 2026-09-25, 0 rounds used, approver Pablo Gutierrez
- `docs/ui/approved/` populated with the 12-file pinned set (6 screens x 2 themes at 1280px) `approval-record.test.ts` requires, copied from the 54-capture `docs/ui/review/` baseline round
- `08-BASELINE-NOTES.md` written with the user's verdict recorded verbatim and honest about the absence of per-screen notes, rather than inventing any
- Full credential-and-baseline pipeline validated end to end: 54 captures -> user review -> G1 approval -> committed evidence -> passing pin/attribution/credential tests

## Task Commits

Each task was committed atomically:

1. **Task 1: Run the baseline capture and verify no capture leaks a credential** - `7a64a33` (test), `8db582b` (fix) — prior session
2. **Task 2: G1 — the user reviews the baseline** - no commit (checkpoint, no files modified) — prior session, resolved via `<user_response>` in this session
3. **Task 3: Record G1 and the baseline notes** - `7d3569b` (docs) — this session

**Plan metadata:** committed together with this SUMMARY (see below)

## Files Created/Modified
- `docs/ui/APPROVAL.md` - G1 block filled in: Date 2026-09-25, Rounds used 0, Approver Pablo Gutierrez, Evidence pointing at `docs/ui/approved/`; adjustment log states both rounds explicitly ("none — approved on the first pass" / "none")
- `docs/ui/approved/{setup,login,servers,server-detail,activity,settings}-{light,dark}.png` - the 12 committed 1280px screen captures the G1 approval was given against, copied from `docs/ui/review/`
- `.planning/phases/08-redise-o-de-la-app/08-BASELINE-NOTES.md` - one `##` section per screen plus overlays, the verbatim user verdict, an honest "no per-screen note supplied" line per section, an empty "items not covered" section, and an orchestrator note explaining the gap between the plan's per-screen expectation and what the user actually gave

## Decisions Made
- Filled G1's Evidence row against `docs/ui/approved/` (per the test and `review-paths.ts`'s documented contract) rather than `docs/ui/review/` (per the plan's own Task 3 prose) — see key-decisions above. Also copied the 12 required files into `docs/ui/approved/`, which the plan's Task 3 action text does not explicitly instruct but which `approval-record.test.ts`'s unconditional `docs/ui/approved/` pin test requires to pass, and which 08-01-SUMMARY.md's own key-decisions section names as this plan's job ("until 08-02 (G1) fills it in").
- Recorded the user's one-sentence global approval verbatim rather than manufacturing six synthetic per-screen notes; the plan explicitly forbids paraphrasing the user's words into notes they did not give.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 3 - Blocking] Populated `docs/ui/approved/` with the 12 pinned 1280px screen captures**
- **Found during:** Task 3 (Record G1 and the baseline notes)
- **Issue:** `tests/unit/ui/approval-record.test.ts`'s `docs/ui/approved/` describe block runs unconditionally and requires the directory to hold exactly the 12-file SCREENS x THEMES set plus `README.md` (13 total); the directory held only `README.md` going into this task, and the plan's Task 3 action text never mentions this copy step even though `docs/ui/approved/README.md` and `scripts/ui/review-paths.ts`'s own header comment both describe it as the gate plan's responsibility. Without it, `approval-record.test.ts` would fail and the G1 Evidence row (which must contain `docs/ui/approved/`) would point at an empty directory.
- **Fix:** Copied the 1280px screen capture for each of the six screens, both themes, from `docs/ui/review/{screen}-{theme}-1280.png` to `docs/ui/approved/{screen}-{theme}.png` (the three overlay captures are excluded — `approvedPngPath` only takes a `Screen`, never an `Overlay`).
- **Files modified:** `docs/ui/approved/{activity,login,server-detail,servers,settings,setup}-{light,dark}.png` (12 new files)
- **Verification:** `pnpm exec vitest run tests/unit/ui/approval-record.test.ts` — 17/17 passing, including the `docs/ui/approved/` pin test and the README-mentions-`pnpm ui:review` test
- **Committed in:** `7d3569b` (Task 3 commit)

---

**Total deviations:** 1 auto-fixed (1 blocking)
**Impact on plan:** Necessary for the plan's own automated verification to pass and for the G1 Evidence row to point at something real. No scope creep — the copy step is exactly what 08-01-SUMMARY.md already named as this plan's job.

## Rules not satisfied

None. All three tasks (capture, human checkpoint, record) completed; the automated verify (`approval-record.test.ts`) is green; the attribution and fixture-credential scans over `docs/ui/` both return zero.

## Issues Encountered
- The plan's own Task 3 prose ("Evidence = `docs/ui/review/` plus the count of captures reviewed") conflicts with the actual `approval-record.test.ts` assertion (`Evidence` must contain `docs/ui/approved/`) and with the already-committed template text in `docs/ui/APPROVAL.md` (which said `docs/ui/approved/` even in its `pending` state). Resolved by following the test and the committed template — the test is what actually gates CI, and diverging from stale plan prose to match a pinned, already-shipped test is squarely a Rule 3 (blocking) auto-fix, not an architectural decision.

## User Setup Required

None - no external service configuration required.

## Next Phase Readiness
- G1 is fully recorded and machine-checked; D-13's blocking condition on wave 3 is satisfied — no plan declaring `depends_on: ["08-02"]` was blocked by a missing or malformed gate record.
- 08-05, 08-07 and 08-08 (the surface plans) have `08-BASELINE-NOTES.md` to read, but it carries no per-screen critique beyond the locked decisions D-01…D-11 and the brief itself — those plans should treat D-01…D-11 plus `docs/ui-build-prompt.md` as their whole brief for this wave, not assume unstated per-screen intent from a note that was never given.
- No blockers for wave 3.

---
*Phase: 08-redise-o-de-la-app*
*Completed: 2026-09-25*

## Self-Check: PASSED

All claimed files found on disk (`docs/ui/APPROVAL.md`, `08-BASELINE-NOTES.md`, and the 12 `docs/ui/approved/` PNGs, spot-checked two by name). All claimed commit hashes found in `git log --oneline --all` (`7a64a33`, `8db582b`, `7d3569b`).
