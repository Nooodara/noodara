---
phase: 07-identidad-y-brand-kit
plan: 10
subsystem: docs-ci
tags: [brand, readme, ci, drift-gate, e2e, vitest, tdd, BRAND-01, BRAND-02, regression]

# Dependency graph
requires:
  - phase: 07-identidad-y-brand-kit
    provides: "07-06's packages/ui/brand/lockup-{light,dark}.svg -- the exact two files the README's <picture> block points at"
  - phase: 07-identidad-y-brand-kit
    provides: "07-06's pnpm brand:check (generate-brand-assets.ts --check) -- the read-only drift gate this plan wires into CI, unmodified"
  - phase: 07-identidad-y-brand-kit
    provides: "07-08's docs/brand/BRAND.md Assets section, which already documented the <picture> shape this plan's README now carries"
  - phase: 07-identidad-y-brand-kit
    provides: "07-07/07-09's mounted mark and the 11-test tests/e2e/brand.spec.ts, the surface this plan's full regression re-proves alongside the other 93 existing E2E"
provides:
  - "README.md: <picture> lockup header (dark/light SVG sources, repo-relative, no remote URL) before the existing H1 and tagline"
  - "tests/unit/docs/install-docs-accuracy.test.ts: a new 'README.md brand header' describe (4 tests) locking the header's shape, sources-exist-on-disk and heading placement"
  - ".github/workflows/ci.yml: pnpm brand:check added to the lint job right after check:ui-safety -- the single source of truth for packages/ui/brand/* can no longer drift silently past CI"
  - "tests/unit/scripts/vitest-gate-config.test.ts: a new describe asserting the lint job runs pnpm brand:check after check:ui-safety"
  - "A full, real regression run across every phase-7 gate (install, lint, typecheck, boundaries, check:ui-safety, brand:check, provenance, unit, build, e2e) with the exact exit codes and pass counts recorded below"
  - ".planning/phases/07-identidad-y-brand-kit/07-VALIDATION.md closed: every provisional 07-W0-NN id rewritten to its real plan/task id, every row green, wave_0_complete/nyquist_compliant/status all true/complete"
affects: []

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "The README's brand-header test lives beside the file's other accuracy assertions in the same describe-per-document file (install-docs-accuracy.test.ts) rather than a new file, since it is one more fact about the same document the rest of that suite already governs"
    - "The CI-drift-gate assertion was added to vitest-gate-config.test.ts (per the plan's own files_modified list) rather than to check-workflow-pins.test.ts, even though the latter already carries the identical job-block-regex pattern for a sibling lint-job step (check:posix-sh) -- the pattern was copied verbatim from there to keep the two files' CI-structural assertions written the same way"

key-files:
  created:
    - .planning/phases/07-identidad-y-brand-kit/07-10-SUMMARY.md
  modified:
    - README.md
    - tests/unit/docs/install-docs-accuracy.test.ts
    - .github/workflows/ci.yml
    - tests/unit/scripts/vitest-gate-config.test.ts
    - .planning/phases/07-identidad-y-brand-kit/07-VALIDATION.md

key-decisions:
  - "README width=240 vs BRAND.md's own documented width=220: the plan's <acceptance_criteria> pins the literal string `width=\"240\"` and its own upstream-facts note says to follow the plan's exact markup when the two disagree, noting the discrepancy rather than silently reconciling it. The README now ships width=240; docs/brand/BRAND.md's Assets section (07-08, unmodified by this plan) still shows its own worked example at width=220. Both are valid <picture> markup: only the width attribute differs, and the plan's own acceptance grep already proves whichever value the README carries at any width is what the docs-accuracy test locks. Recommendation for phase 8 or a follow-up: reconcile BRAND.md's worked example to 240, or accept 220 as the closer-to-BRAND.md value and re-run the RED/GREEN cycle -- outside this plan's own scope to decide unilaterally."
  - "The CI-drift-gate test was added to tests/unit/scripts/vitest-gate-config.test.ts (per the plan frontmatter's files_modified), not to tests/unit/scripts/check-workflow-pins.test.ts, even though the latter already has the identical job-block-regex pattern for check:posix-sh in the very same lint job. Both files now assert facts about ci.yml's lint job; a future consolidation could merge them, but the plan named this file explicitly and both suites pass."

patterns-established: []

requirements-completed: [BRAND-01, BRAND-02]

# Metrics
duration: ~35min
completed: 2026-09-23
---

# Phase 7 Plan 10: README lockup, CI drift gate, full regression Summary

**The README now opens with the Noodara lockup in both colour schemes via a repo-relative `<picture>` block, `pnpm brand:check` runs inside CI's `lint` job so `packages/ui/brand/*` can never drift past a merge, and every gate in the phase -- 151 unit files / 2547 tests, 104 E2E (93 existing + 11 brand), lint, typecheck, boundaries, `check:ui-safety`, `brand:check`, provenance, and a real production build -- was re-run clean in one sitting, closing `07-VALIDATION.md` with real ids and green rows.**

## Performance

- **Duration:** ~35 min
- **Tasks:** 3 (Tasks 1 and 2 both full TDD cycles, RED committed before GREEN; Task 3 mechanical regression + validation-contract closure)
- **Files created:** 1 (this SUMMARY); modified: 5 (`README.md`, 2 test files, `ci.yml`, `07-VALIDATION.md`)
- **Tests:** 5 new unit (4 README brand-header + 1 CI drift-gate assertion); full unit suite is 151 files / 2547 tests, all green (was 151/2542 after 07-09)

## Accomplishments

- **The lockup is the first thing anyone sees on the README.** A `<picture>` block with a `(prefers-color-scheme: dark)` source pointing at `packages/ui/brand/lockup-dark.svg` and an `<img alt="Noodara" src="packages/ui/brand/lockup-light.svg" width="240">` fallback sits above the existing `# Noodara` H1 and the `> Your infrastructure, understood.` tagline, both of which are untouched. No `http`/`https` appears anywhere inside the block -- both sources are repo-relative, closing T-07-29 (a remote image can never be swapped in).
- **The docs-accuracy suite now locks the header's shape, not just its presence.** Four new tests in `install-docs-accuracy.test.ts`'s `README.md brand header` describe assert: the exact `<source>`/`<img>` strings; zero `http`/`https` inside the `<picture>` block; both referenced SVGs exist on disk; and the block appears before the first `## ` heading while the H1 and tagline survive. All 19 pre-existing README/install-docs assertions in the same file still pass unchanged.
- **CI can no longer let a generated brand asset drift silently.** `pnpm brand:check` now runs in the `lint` job immediately after `pnpm check:ui-safety` -- no new GitHub Action, no new pin (`check-workflow-pins.test.ts` stays green, still zero unpinned `uses:`). A dedicated assertion in `vitest-gate-config.test.ts` reads the real `ci.yml` and fails if that ordering ever regresses.
- **The drift gate was proven live, not assumed.** `printf ' ' >> packages/ui/brand/monogram-light.svg` followed by `pnpm brand:check` printed exactly:
  ```
  generate-brand-assets --check: drift detected:
    monogram-light.svg: content differs from asset-manifest.ts
  ```
  and exited 1. The file was restored with the single sanctioned `git checkout -- packages/ui/brand/monogram-light.svg`; `git status --porcelain packages/ui/brand` was empty immediately after, and a follow-up `pnpm brand:check` printed `OK, no drift.` again.
- **Every gate in the phase was re-run for real, in order, and is green.** See the full command/exit-code table below. `pnpm test:e2e` ran the whole real Playwright suite against a real Docker-backed stack (Postgres, Redis, the built API, worker and web app, plus `critical-path.spec.ts`'s own real Ubuntu sshd Testcontainer) -- 104 passed, 0 failed, 0 skipped, 0 flaky, in 1.9 minutes. No test was loosened, skipped or deleted to get there; nothing failed.
- **`07-VALIDATION.md` is closed.** Every provisional `07-W0-NN` id in the Per-Task Verification Map is now the real plan/task id that delivered it (`07-01`, `07-02` T2, `07-03`/`07-09`, `07-05`, `07-06` T3 ×2, `07-07` ×2, `07-08` T2, `07-09` T2, `07-10` T3), every row reads ✅ green, and the frontmatter carries `status: complete`, `nyquist_compliant: true`, `wave_0_complete: true`.

## Task Commits

| Task | What | Commit | Type |
|------|------|--------|------|
| 1 | RED: failing README brand-header assertions | `178e5fd` | test |
| 1 | GREEN: the `<picture>` lockup in the README header | `e08c094` | docs |
| 2 | RED: failing CI brand-drift-gate assertion | `a00bd59` | test |
| 2 | GREEN: `pnpm brand:check` added to the `lint` job | `0bff014` | ci |
| 3 | Close the phase-7 validation contract | `39561c5` | docs |

## RED evidence

- **Task 1:** 3 of 4 new cases failed (`<picture>` block absent, no dark/light sources, heading-order assertion had no `<picture>` to find); the fourth ("both lockup sources exist on disk") passed immediately since 07-06 had already committed both SVGs -- this is a fact about the filesystem, not new behavior, so it correctly never needed a RED phase of its own. After the GREEN: 22/22 in the file.
- **Task 2:** 1 of 5 failed (`ci.yml` did not yet run `pnpm brand:check` anywhere). After the GREEN: `pnpm exec vitest run tests/unit/scripts` — 7 files / 61 tests, all green.

## Full command/exit-code table (Task 3)

Run in this order, against a clean tree with no stray Docker containers and ports 3000/3100 free before and after:

| # | Command | Exit code | Result |
|---|---------|-----------|--------|
| 1 | `pnpm install --frozen-lockfile` | 0 | lockfile already up to date |
| 2 | `pnpm lint` | 0 | 9 tasks successful (turbo) |
| 3 | `pnpm typecheck` | 0 | 8 tasks successful (turbo) + the 4 standalone `tsc -p ... --noEmit` passes in the root script |
| 4 | `pnpm boundaries` | 0 | checked 653 files in 6 packages, no issues found |
| 5 | `pnpm check:ui-safety` | 0 | all 9 repo-wide UI safety gates OK (1 reviewed `dangerouslySetInnerHTML`, 0 everywhere else) |
| 6 | `pnpm brand:check` | 0 | `generate-brand-assets --check: OK, no drift.` |
| 7 | `node scripts/check-package-provenance.mjs` | 0 | 54/54 locked direct dependencies verified |
| 8 | `pnpm test` | 0 | **151 files / 2547 tests passed, 0 skipped** (was 151/2542 after 07-09; +5 from this plan's own Tasks 1-2) |
| 9 | `NOODARA_API_ORIGIN=http://localhost:3100 pnpm build` | 0 | 5/5 turbo tasks successful; `/apple-icon.png`, `/icon.svg`, `/icon1.png`, `/icon2.png`, `/manifest.webmanifest`, `/opengraph-image.png` all listed as generated routes |
| 10 | `pnpm test:e2e` | 0 | **104 passed, 0 failed, 0 skipped, 0 flaky** (1.9 min) — 93 pre-existing + 11 in `tests/e2e/brand.spec.ts` |

Docker: `docker ps -a --filter "label=noodara.test=true"` was empty before and after the run; the one `testcontainers-ryuk` reaper container spawned by `critical-path.spec.ts`'s real sshd fixture self-terminated within 15 s of the suite finishing. Ports 3000/3100 were free before the run and after.

## Manual verification required (D-14, carried from 07-09 — cannot be scripted)

This is 07-09's own recorded manual item, restated verbatim here since it remains outstanding and this plan is the phase's last one before verification:

> Open http://localhost:3000/login in **Chrome** and **Safari**, once with the OS appearance set to **light** and once to **dark**. Confirm the Noodara tile favicon (the blue rounded tile with the white monogram) is legible at 16 px on both browsers' tab strips, in both appearances.

Playwright cannot capture browser/OS chrome (tab strip rendering) -- this is a hard platform limitation, not a configuration gap. A human must perform this check; it is the one item `/gsd-verify-work` or the user must close before the phase is declared done.

## Decisions Made

Recorded in frontmatter `key-decisions`. The one worth restating: **the README's `<picture>` fallback uses `width="240"`, not the `width="220"` shown in `docs/brand/BRAND.md`'s own Assets-section worked example.** The plan's `<acceptance_criteria>` pins the literal `width="240"` string and its own upstream-facts note directs following the plan's exact markup when plan and prose disagree, flagging the discrepancy rather than silently picking one. Both are syntactically valid; only the display width differs. This is left for phase 8 or a follow-up plan to reconcile (either update BRAND.md's worked example to 240, or decide 220 is preferred and move the README to match with its own RED/GREEN cycle) -- not a call for this executor to make unilaterally mid-regression.

## Deviations from Plan

### Auto-fixed Issues

None. Every task's `<acceptance_criteria>` passed on the first implementation; no bug, missing functionality or blocking issue was found in this plan's own files.

---

**Total deviations:** 0 auto-fixed. One documented markup discrepancy (README `width=240` vs. BRAND.md's own `width=220` worked example), recorded above rather than silently resolved either way.

## Issues Encountered

- `pnpm test -- <path>` still does not filter (recorded since 07-02): `pnpm exec vitest run <paths>` was used for every scoped RED/GREEN run in this plan; the two full-regression `pnpm test`/`pnpm test:e2e` invocations in Task 3 used their plain, unfiltered form exactly as the plan specifies.
- No other issues. The full E2E run (104 tests, real Docker stack, a real sshd Testcontainer for `critical-path.spec.ts`) completed in 1.9 minutes with zero retries and zero flakes on the first attempt.

## User Setup Required

**The manual browser-tab favicon check (D-14)** — see the dedicated section above. No new external service configuration; no new dependency was added by this plan.

## Next Phase Readiness

- **BRAND-01 and BRAND-02 are both now fully satisfied.** BRAND-01 was completed in 07-08 (the brand kit document); BRAND-02's last remaining surface — the README — is done as of this plan, and the CI drift gate (criterion 4 of this phase's own success criteria) is active.
- **ROADMAP success criterion 3 is proven with real numbers**, not assumed: `pnpm test` (2547/2547, 0 skipped), `pnpm test:e2e` (104/104, 0 failed/skipped/flaky), `check:ui-safety`, `lint`, `typecheck`, `boundaries` and provenance are all green in the same sitting, against the finished phase.
- **`07-VALIDATION.md` is closed** — its own Validation Sign-Off checklist is fully checked, `nyquist_compliant: true`, `wave_0_complete: true`, `status: complete`. Phase 7 itself is NOT marked complete in `ROADMAP.md` by this plan or this executor; that is the orchestrator's own step, gated on `/gsd:verify-work`.
- **Phase 8 (rediseño de la app)** inherits a README that already carries the mark, a CI pipeline that will fail loudly if any future geometry adjustment forgets to re-run `pnpm brand:generate`, and a fully green 93+11 E2E baseline to protect through the redesign (the roadmap's own Phase 8 success criterion 5 names this exact baseline).
- **The one open item for `/gsd-verify-work` or the user**: the D-14 manual browser-tab favicon check, restated above, carried unresolved from 07-09 through this plan since it genuinely cannot be scripted.

## Self-Check: PASSED

- `README.md`, `tests/unit/docs/install-docs-accuracy.test.ts`, `.github/workflows/ci.yml`, `tests/unit/scripts/vitest-gate-config.test.ts`, `.planning/phases/07-identidad-y-brand-kit/07-VALIDATION.md` all exist on disk with the expected changes.
- Commits `178e5fd`, `e08c094`, `a00bd59`, `0bff014`, `39561c5` are all in `git log --oneline`, in that order, with each RED preceding its GREEN.
- `pnpm exec vitest run tests/unit/docs/install-docs-accuracy.test.ts` (22/22), `pnpm exec vitest run tests/unit/scripts` (61/61), `pnpm test` (151 files/2547 tests), `pnpm brand:check`, `pnpm test:e2e` (104/104) all exit 0, re-confirmed after every edit in this plan.
- `git status --porcelain packages/ui/brand` is empty (the deliberate-drift proof's file was fully restored).
- `git stash list` is empty; every commit in this plan staged only explicit paths under `noodara/code`, none outside it; no commit carries an AI-attribution trailer.
- `docker ps -a --filter "label=noodara.test=true"` is empty; ports 3000/3100 are free.

---
*Phase: 07-identidad-y-brand-kit*
*Completed: 2026-09-23*
