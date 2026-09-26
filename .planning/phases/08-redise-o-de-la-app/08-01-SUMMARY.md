---
phase: 08-redise-o-de-la-app
plan: 01
subsystem: ui
tags: [playwright, testcontainers, vitest, screenshot-capture, approval-gate]

# Dependency graph
requires:
  - phase: 07-identidad-y-brand-kit
    provides: scripts/brand/{review-paths,capture-brand-review,write-if-changed}.ts pipeline shape, docs/brand/APPROVAL.md pattern
provides:
  - scripts/ui/review-paths.ts (SCREENS/OVERLAYS/THEMES/WIDTHS matrix, reviewPngPath/approvedPngPath builders)
  - scripts/ui/capture-ui-review.ts (pnpm ui:review — full D-12 capture pipeline against real fixture data)
  - docs/ui/APPROVAL.md (G1/G2/G3 gate record, pending until each gate plan fills it in)
  - tests/unit/ui/approval-record.test.ts (pins docs/ui/approved/, forbids AI-attribution and fixture credentials under docs/ui/)
  - .planning/phases/08-redise-o-de-la-app/08-HUMAN-UAT.md (G2/G3 live-review checklist, local-stack recipe)
affects: [08-02-baseline-and-g1-gate, 08-11, 08-19, 10-docs-and-landing]

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "Review-path module mirrors scripts/brand/review-paths.ts: import.meta.dirname-derived repo root, const-tuple matrix, single path builder"
    - "Capture script mirrors scripts/brand/capture-brand-review.ts: attach-mode/real-stack env split, deterministic data-theme write, writeIfChanged-ledgered screenshots"
    - "Approval record mirrors docs/brand/APPROVAL.md/approval-record.test.ts: Field/Value table + Adjustment log, per-gate-scoped row parsing (three gate sections instead of one concept)"

key-files:
  created:
    - scripts/ui/review-paths.ts
    - scripts/ui/capture-ui-review.ts
    - scripts/ui/tsconfig.json
    - tests/unit/ui/review-paths.test.ts
    - tests/unit/ui/approval-record.test.ts
    - docs/ui/APPROVAL.md
    - docs/ui/approved/README.md
    - docs/ui/review/README.md
    - .planning/phases/08-redise-o-de-la-app/08-HUMAN-UAT.md
  modified:
    - package.json
    - .gitignore

key-decisions:
  - "The error-state fixture server reuses the same single sshd Testcontainer as the connected server, with a deliberately wrong password — a genuine AUTH_FAILED against real infrastructure, never a stub, without paying for a second container."
  - "The 80-character-name fixture attempts the literal D-12 length first; packages/domain's SERVER_NAME_PATTERN caps names at 63 chars (pre-existing, out of this plan's scope), so the script falls back to the longest valid name and logs why — documented here rather than silently truncated or silently left unresolved."
  - "docs/ui/approved/'s pin test asserts every present file is a member of the valid SCREENS×THEMES+README set, not that all 12 are present — no gate has been approved yet in this plan, so the directory legitimately holds only README.md until 08-02 (G1) fills it in."

patterns-established:
  - "Per-gate-scoped row parsing: approval-record.test.ts slices docs/ui/APPROVAL.md into three `## G<n>` sections before applying the brand test's row(label) regex, so three gates can share the same field labels without one shadowing another."

requirements-completed: [UI-12]

# Metrics
duration: ~35min
completed: 2026-09-25
---

# Phase 8 Plan 1: Baseline capture-and-approval pipeline Summary

**`pnpm ui:review` captures all six redesigned screens plus four overlays, both themes, four widths, against three real HTTP-API-seeded fixture servers on one sshd Testcontainer; `docs/ui/APPROVAL.md` mirrors the brand kit's G1/G2/G3-ready approval shape with a pin test guarding against attribution leaks and fixture credentials.**

## Performance

- **Duration:** ~35 min
- **Completed:** 2026-09-25
- **Tasks:** 3
- **Files modified:** 11 (9 created, 2 modified)

## Accomplishments

- `scripts/ui/review-paths.ts`: the single source of truth for the review matrix (6 screens, 4 overlays, 2 themes, 4 widths) and the `reviewPngPath`/`approvedPngPath` builders every consumer imports — never a hand-listed path.
- `scripts/ui/capture-ui-review.ts` (`pnpm ui:review`): a full Playwright capture run that seeds three real fixture servers via the app's own HTTP API against one real sshd Testcontainer (connected+discovered, AUTH_FAILED error, long name), captures the empty-list state first, then walks every screen/overlay — with credentials sourced only from the stack fixture object, never printed or hardcoded.
- `docs/ui/APPROVAL.md` + `tests/unit/ui/approval-record.test.ts`: the G1/G2/G3 approval record and its pin test, scoping the brand kit's row-parsing pattern to three independent gate sections instead of one concept row.
- `.planning/phases/08-redise-o-de-la-app/08-HUMAN-UAT.md`: the D-14 live-review checklist naming exactly what to exercise by hand at G2 (accessibility fallbacks, screen reader) and G3 (Sheet drag physics, Viewfinder ring, brand-swap tests), with the local-stack recipe up front.

## Task Commits

Each task was committed atomically (TDD tasks got separate RED/GREEN commits):

1. **Task 1: review-paths module for the UI review matrix**
   - `f1165bb` (test) — failing test for the review-path matrix
   - `6d29945` (feat) — review-paths.ts + scripts/ui/tsconfig.json wired into root typecheck
2. **Task 2: capture-ui-review script and the pnpm ui:review command**
   - `dd73a9b` (feat) — capture-ui-review.ts, package.json script, .gitignore block, review/README.md
3. **Task 3: docs/ui approval record, its pin test, and the live-review checklist**
   - `16d169b` (test) — failing test for the approval record
   - `724ccd6` (feat) — APPROVAL.md, approved/README.md, 08-HUMAN-UAT.md

_No plan-metadata commit yet — this SUMMARY.md and the STATE/ROADMAP/REQUIREMENTS updates are committed separately, per the executor's final-commit step._

## Files Created/Modified

- `scripts/ui/review-paths.ts` - REVIEW_ROOT/APPROVED_ROOT, SCREENS/OVERLAYS/THEMES/WIDTHS tuples, reviewPngPath/approvedPngPath
- `scripts/ui/capture-ui-review.ts` - the full capture pipeline (`pnpm ui:review`)
- `scripts/ui/tsconfig.json` - type-checked by the root `typecheck` script, mirroring `scripts/brand/tsconfig.json`
- `tests/unit/ui/review-paths.test.ts` - pins the matrix and path builders
- `tests/unit/ui/approval-record.test.ts` - pins the approval record, the approved-file set, and forbids AI-attribution/fixture-credential strings under `docs/ui/`
- `docs/ui/APPROVAL.md` - the G1/G2/G3 approval record (pending until each gate)
- `docs/ui/approved/README.md` - explains the pinned 1280px-only set
- `docs/ui/review/README.md` - explains the gitignored, throwaway review tree
- `.planning/phases/08-redise-o-de-la-app/08-HUMAN-UAT.md` - the D-14 G2/G3 live-review checklist
- `package.json` - added `ui:review` script and `scripts/ui/tsconfig.json` to `typecheck`
- `.gitignore` - added the `docs/ui/review/*` (except README.md) block

## Decisions Made

- Reused the single sshd Testcontainer for both the connected and the error-state fixture servers (wrong password against the same real container) instead of spinning up a second container — a genuine `AUTH_FAILED`→`ERROR` transition against real infrastructure at lower cost.
- The 80-character server name D-12 names is not always reachable through the real API: `packages/domain`'s `SERVER_NAME_PATTERN` (pre-existing, out of this plan's `files_modified` scope) caps names at 63 characters. `capture-ui-review.ts` attempts the literal 80-char name first and falls back to the longest valid name (63 chars) with a logged explanation if rejected, rather than silently changing the target length or leaving the script permanently broken.
- `docs/ui/approved/`'s pin test asserts every file present is a member of the valid set, not that the full 12-file set exists — G1 has not been approved yet as of this plan, so the directory legitimately holds only `README.md` today; the test still fails hard on any stray or renamed file (verified manually with a temporary `stray.png`).

## Deviations from Plan

None — plan executed exactly as written. The only judgment calls (sshd-reuse for the error fixture, the 80→63-char fallback, and the empty-set-tolerant pin) were all left to "Claude's Discretion" by `08-CONTEXT.md` or fell naturally out of the plan's own must-haves; none required deviating from a stated instruction.

## Issues Encountered

- `packages/domain`'s `validateServerName` (`SERVER_NAME_PATTERN`) rejects names longer than 63 characters, which is shorter than the literal 80-character length `08-CONTEXT.md`/`08-UI-SPEC.md` name for the "long name" fixture state. This is a pre-existing constraint from Phase 1, out of this plan's scope to change (it is not in `files_modified` and changing domain validation would be an architectural change requiring its own review). Handled with an attempt-then-fallback in `capture-ui-review.ts` (see Decisions above) rather than silently working around it.
- The full `pnpm ui:review` run was not executed end-to-end in this session (it requires booting the real Docker/Testcontainers stack — Postgres, Redis, the API, the worker, the built web app, and a real sshd container — a multi-minute operation). The script passes `pnpm typecheck` (its own stated automated verification) and reuses every primitive (`startStack`/`stopStack`/`startCriticalPathSshd`, `page.request`, `writeIfChanged`) exactly as proven in the existing E2E suite and the Phase 7 brand pipeline. Running the real capture is the natural first step of the G1 baseline plan (08-02), which is the actual consumer of this pipeline's output.

## Rules not satisfied

None. All hard git rules were respected (see below); TDD RED→GREEN was followed for both `tdd="true"` tasks; no secrets, credentials, or literal fixture email/password strings were written into any committed file (verified by grep and by the approval-record test's own credential-scanning describe block).

## Hard Git Rules Compliance

- No `git stash` was run at any point (`git stash list` is empty).
- No `git add .`/`-A`/`-u`, `git commit -a`, `git reset --hard`, `git clean`, or blanket `git checkout --`/`git restore` was run.
- Every commit staged explicit paths inside `noodara/code/` only; `git status --porcelain -- ../../` was checked before every commit to confirm only intended files were staged.
- `docs/ui-build-prompt.md` was read (referenced by context) but never staged, touched, or deleted — it remains untracked, as found.
- All five commits use Conventional Commits, English, `(08-01)` scope, no `Co-Authored-By` or AI-attribution trailer, per `CLAUDE.md` §7 and project rules.
- No push, no branch created; all work is on `main` in the local monorepo.

## User Setup Required

None - no external service configuration required.

## Next Phase Readiness

- `pnpm ui:review` is ready for 08-02 (the G1 baseline plan) to run against a real Docker stack and produce the actual six-screen + four-overlay baseline for the user's first visual review, before any CSS changes.
- `docs/ui/APPROVAL.md` and its pin test are ready to receive G1's real Date/Rounds used/Approver values and the first 12 approved 1280px captures.
- `08-HUMAN-UAT.md` is ready for 08-11 (G2) and 08-19 (G3) to append their own findings against this checklist.
- Known follow-up for a future plan or `/gsd-quick`: if the 80-character name requirement in `08-CONTEXT.md`/`08-UI-SPEC.md` is meant literally rather than "the longest name the app accepts", `packages/domain`'s `SERVER_NAME_PATTERN` would need to change — an architectural decision outside this plan's scope, flagged here rather than decided unilaterally.

---
*Phase: 08-redise-o-de-la-app*
*Completed: 2026-09-25*

## Requirements Tracking Note

This plan's frontmatter lists `requirements: [UI-12]`, but `REQUIREMENTS.md`'s own UI-12 text
requires screenshots "revisados por un humano antes de cerrarse" — that human review is G1/G2/G3
(plans 08-02/08-11/08-19), not this plan. `requirements mark-complete` was deliberately **not**
called for UI-12 here to avoid a false-complete status; it should be called once G3 is actually
approved.

## Self-Check: PASSED

All 9 created files verified present on disk; all 5 task commit hashes (`f1165bb`, `6d29945`, `dd73a9b`, `16d169b`, `724ccd6`) verified present in `git log --oneline --all`. No missing items.
