---
phase: 01-dominio-persistencia-y-autenticacion
plan: 17
subsystem: infra
tags: [ci, github-actions, adr, module-resolution, validation]

# Dependency graph
requires:
  - phase: 01-dominio-persistencia-y-autenticacion
    provides: "packages/domain built to dist/ with dist-pointing exports, apps/control-plane's dev/start scripts, tests/integration/boot/boot-command.test.ts's 4-case boot suite, and the six-job CI pipeline (Plan 01-16, Plan 01-15)"
provides:
  - "boot-smoke: a seventh, PR-blocking CI job that runs pnpm build then pnpm test:boot, gating the real dev/start boot path on every pull request"
  - "pnpm test:boot: a root script a developer can run verbatim, identical to what CI runs"
  - "docs/adr/0003-runtime-entrypoints-and-module-resolution.md: Accepted ADR recording the tsc-build/tsx-dev/plain-node-start contract, its rejected alternatives, and its consequences for future phases"
  - "01-VALIDATION.md's Per-Task Verification Map closed with rows 1-16-01..1-16-03 and 1-17-01..1-17-02, each exercising a real spawned boot command, plus a note recording why the phase's original map missed this"
  - "CLAUDE.md §3.2's command table lists pnpm build/pnpm start and points at ADR 0003 (local-only edit, CLAUDE.md is gitignored)"
affects: ["phase-6-installer (ADR 0003 is what its Docker image build is measured against)", "any future phase adding a new process entrypoint (the validation-map note asks for a real boot-path row before declaring one done)"]

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "A CI job that gates a real child-process boot smoke test keeps its own explicit build step even when the test suite's globalSetup also builds — a build failure must surface as its own named red step, not an opaque test-harness crash"
    - "ADR numbering/section order (Status/Context/Decision/Rejected alternatives/Consequences) followed exactly from 0002 for 0003, keeping the docs/adr/ series internally consistent"

key-files:
  created:
    - docs/adr/0003-runtime-entrypoints-and-module-resolution.md
  modified:
    - package.json
    - .github/workflows/ci.yml
    - .planning/phases/01-dominio-persistencia-y-autenticaci-n/01-VALIDATION.md
    - CLAUDE.md (local-only, gitignored — not committed)

key-decisions:
  - "boot-smoke keeps an explicit pnpm build step even though tests/integration/global-setup.ts already builds the workspace: a build failure must be its own red CI step, and the gate must never silently pass against a stale dist"
  - "The plan's own suggested acceptance-criteria check `grep -cE '^  [a-z-]+:$' ci.yml -eq 7` over-counts because the regex also matches the `push:` trigger key one level up (2-space indent) — the workflow has 7 real jobs (6 original + boot-smoke) as the comment's own prose states; verified by name (grep -nE) rather than treating the miscounted literal as the pass/fail bar"

patterns-established:
  - "Any future CI job wrapping a child-process test that spawns real commands must reuse the exact checkout/pnpm/setup-node/install step shape already established by the other seven jobs — no ad-hoc variation"

requirements-completed: [INST-06, QA-01]

# Metrics
duration: 22min
completed: 2026-09-12
---

# Phase 1 Plan 17: Boot-Smoke CI Gate, ADR 0003, and the Closed Validation Contract Summary

**Seventh PR-blocking `boot-smoke` CI job running `pnpm build` then `pnpm test:boot` (4/4 real-boot tests), ADR 0003 recording the tsc-build/tsx-dev/plain-node-start runtime contract as Accepted, and 01-VALIDATION.md closed with the rows the verifier flagged as missing.**

## Performance

- **Duration:** 22 min
- **Started:** 2026-09-11T23:44:00-06:00 (approx, first edit after context load)
- **Completed:** 2026-09-12T00:05:00-06:00
- **Tasks:** 2
- **Files modified:** 5 (1 created, 4 modified — 1 of the 4 gitignored/local-only)

## Accomplishments

- Added root script `test:boot` (`vitest run --config vitest.integration.config.ts tests/integration/boot/boot-command.test.ts`) so CI calls the exact command a developer runs locally.
- Added `boot-smoke` as `.github/workflows/ci.yml`'s seventh job: reuses the identical checkout/pnpm/setup-node/install step shape as the other six, runs `pnpm build` then `pnpm test:boot`, and carries the same `if: always()` stray-`noodara.test=true`-container guard the `integration` job already has. Zero `continue-on-error` anywhere in the file (still true after the addition); `actionlint` passes clean.
- Ran the real gate: `pnpm build && pnpm test:boot` → 4/4 boot tests passed (including the clean-tree, turbo-driven root `pnpm dev` case), both `dist` directories present afterward, zero stray `noodara.test=true` containers.
- Wrote `docs/adr/0003-runtime-entrypoints-and-module-resolution.md` (Accepted), following `0002`'s exact section order: Context (the `.js`-vs-`.ts` NodeNext mismatch that caused `ERR_MODULE_NOT_FOUND`), Decision in three parts (packages/domain's real `tsc` build with dist-pointing exports; production `node dist/server.js` with zero loader; development `tsx watch`, reusing the loader already behind `db:migrate`/the CLI, plus the empirically-discovered `turbo.json` `passThroughEnv` requirement), Rejected alternatives (rewriting to `.ts` specifiers; shipping `tsx` in production; leaving `exports` on `.ts`), and Consequences (turbo `dependsOn: ["^build"]` on `lint`/`typecheck`/`dev`, `dist` self-containment, `boot-smoke` as the standing regression gate).
- Appended `1-16-01`..`1-16-03` and `1-17-01`..`1-17-02` to `01-VALIDATION.md`'s Per-Task Verification Map (38/38 tasks green now), each row's Automated Command spawning a real boot command rather than a Vitest-transform helper, and added a note recording exactly why the phase's original 33-row map missed this — a boot-path row is now the standing expectation for any future entrypoint task. `nyquist_compliant: true` preserved.
- Updated `CLAUDE.md` §3.2's command table with `pnpm build`, `pnpm start`, and a pointer to ADR 0003. This is a local-only edit (`CLAUDE.md` is gitignored per the repo layout) — not part of any commit, per this repo's own convention.
- Re-ran the full phase gate chain end to end: `pnpm lint` (exit 0), `pnpm typecheck` (exit 0), `pnpm exec turbo boundaries` (182 files, no issues), `pnpm test --coverage` (358/358, unit stays build-free), `pnpm test:integration` (113/113, ~150s, zero stray containers), `pnpm audit --audit-level=high` (1 moderate, 0 high/critical — same as 01-15's baseline, exit 0), `actionlint .github/workflows/ci.yml` (exit 0).

## Task Commits

Each task was committed atomically:

1. **Task 1: boot-smoke CI job** - `744ea6e` (feat)
2. **Task 2: ADR 0003, CLAUDE.md command table, and the closed validation contract** - `299da4f` (docs)

**Plan metadata:** *(this commit)*

## Files Created/Modified

- `package.json` - New root `test:boot` script
- `.github/workflows/ci.yml` - New `boot-smoke` job (seventh job), with an explanatory comment block covering why it's separate from `integration` and why its `pnpm build` step isn't redundant with `global-setup.ts`'s build
- `docs/adr/0003-runtime-entrypoints-and-module-resolution.md` - New Accepted ADR recording the runtime/module-resolution contract as shipped in Plan 01-16
- `.planning/phases/01-dominio-persistencia-y-autenticaci-n/01-VALIDATION.md` - Five new Per-Task Verification Map rows (`1-16-01`..`1-16-03`, `1-17-01`..`1-17-02`) plus a note on the gap they close
- `CLAUDE.md` - §3.2 command table gains `pnpm build`/`pnpm start` and a link to ADR 0003 (local-only — gitignored, not committed)

## Decisions Made

See `key-decisions` in frontmatter. Most notable: the plan's own suggested acceptance-criteria grep for counting jobs (`grep -cE '^  [a-z-]+:$'`) accidentally also matches the `push:` key under the `on:` trigger block (same 2-space indent), so it reports 8 rather than the intended "6 original + boot-smoke = 7." This is a bug in the plan's own verification-check text, not in the shipped workflow — confirmed by listing the matched lines by name (`grep -nE`) and counting actual job entries under `jobs:` by eye: `lint`, `typecheck`, `boundaries`, `unit`, `integration`, `security`, `boot-smoke` = 7, matching every other criterion (`boot-smoke` present, zero `continue-on-error`, `actionlint` clean, 4/4 boot tests). No file was changed to chase the literal miscounted grep.

## Deviations from Plan

### Auto-fixed Issues

None — Rules 1–3 did not trigger. The one discrepancy found (the job-count grep pattern matching `push:`) is a bug in the plan's own suggested verification command text, not in any deliverable file, and required no code change; documented above under Decisions Made instead of as a deviation, since nothing was "fixed," only correctly interpreted.

---

**Total deviations:** 0 auto-fixed. No architectural changes; no scope beyond `files_modified`.
**Impact on plan:** Plan executed as written. The workflow has the intended 7 jobs (verified by name), independent of the plan's own miscounting verification snippet.

## Issues Encountered

None beyond the acceptance-criteria grep discrepancy noted above, which was resolved by re-deriving the correct check rather than modifying working code.

## User Setup Required

None - no external service configuration required.

## Next Phase Readiness

- `01-VERIFICATION.md`'s BLOCKER is now fully closed on both halves: Plan 01-16 fixed the actual boot defect, and this plan (01-17) made a regression of it impossible to merge (`boot-smoke`) and wrote the decision down (ADR 0003) so phase 6 does not have to re-derive it.
- `01-VALIDATION.md` is closed with 38/38 tasks green and an explicit note telling future phases to add a real boot-path row before declaring a new entrypoint task done — directly addressing the verifier's finding.
- Phase 1's two remaining `human_verification` items (a live GitHub Actions run once the repo is pushed, and a gitleaks re-run once the repo is extracted to its own root) are unchanged and still open for a human, as originally scoped; this plan does not attempt either.
- This was the last plan in Phase 1's gap-closure work (17 of 17) — phase 1 is ready for `/gsd:verify-work` to re-confirm the BLOCKER's closure.

---
*Phase: 01-dominio-persistencia-y-autenticacion*
*Completed: 2026-09-12*

## Self-Check: PASSED

- FOUND: package.json (test:boot script present)
- FOUND: .github/workflows/ci.yml (boot-smoke job present)
- FOUND: docs/adr/0003-runtime-entrypoints-and-module-resolution.md
- FOUND: .planning/phases/01-dominio-persistencia-y-autenticaci-n/01-VALIDATION.md (rows 1-16-01..1-16-03, 1-17-01..1-17-02 present)
- FOUND commit: 744ea6e
- FOUND commit: 299da4f
