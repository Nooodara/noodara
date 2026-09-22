---
phase: 07-identidad-y-brand-kit
plan: 02
subsystem: infra
tags: [sharp, png-to-ico, raster, svg, ico, supply-chain, vitest, tdd]

# Dependency graph
requires:
  - phase: 07-identidad-y-brand-kit
    provides: "07-01's packages/ui/src/brand/geometry.ts (ring(), circle(), GRID=24, nonzero fill-rule discipline) -- the fidelity probe rasterizes the real ring() construct, not a stand-in"
provides:
  - "scripts/brand/raster.ts: svgToPng/pngsToIco/pngMetadata via sharp + png-to-ico, guarded dynamic imports with a clear remediation message, RASTER_BACKEND='sharp' decided by an executed fidelity probe against the real nonzero-winding ring() construct"
  - "scripts/brand/write-if-changed.ts: writeIfChanged (string/Buffer via Buffer.equals) + changedFiles ledger + resetChangedFiles, mirroring scripts/capture-discovery-fixtures.mjs's idempotent-write discipline"
  - "scripts/brand/tsconfig.json wired into pnpm typecheck"
  - "sharp@0.35.4 and png-to-ico@3.0.2 provenance-registered (scripts/check-package-provenance.mjs) and human-approved (ADR-0000 Phase 7 additions), installed at exact pins in BOTH packages/ui and the repo root"
affects: [07-04, 07-06, 07-08, 07-10]

# Tech tracking
tech-stack:
  added: ["sharp@0.35.4", "png-to-ico@3.0.2", "tsx@4.23.13 (root, mirrors apps/control-plane's existing pin)"]
  patterns:
    - "Guarded dynamic import (`await import('sharp')` inside try/catch, rethrowing a one-line remediation message) so a missing native dependency fails loud and actionable, never with a raw stack trace"
    - "A build-time-only Node script directory (scripts/brand/) gets its own tsconfig.json (extends @noodara/config/tsconfig.base.json, jsx: react-jsx) chained into the root typecheck script, same shape as tests/e2e/tsconfig.json"
    - "Backend-decision constant (RASTER_BACKEND) recorded as a plain exported const, decided once by an executed fidelity test against the real geometry construct, not re-probed at runtime"

key-files:
  created:
    - scripts/brand/raster.ts
    - scripts/brand/write-if-changed.ts
    - scripts/brand/tsconfig.json
    - tests/unit/brand/raster.test.ts
    - docs/adr/0000-package-legitimacy-approvals.md (Phase 7 additions section appended)
  modified:
    - scripts/check-package-provenance.mjs
    - packages/ui/package.json
    - package.json

key-decisions:
  - "RASTER_BACKEND = 'sharp': the fidelity probe rasterizes ring(12,12,9,5) imported directly from 07-01's geometry.ts (viewBox 0 0 24 24, plain fill, no fill-rule, no stroke) and confirms librsvg opens the counter, paints the band and leaves the corner transparent -- the Playwright fallback branch is documented in raster.ts's header but was not needed"
  - "sharp and png-to-ico are ALSO pinned as root devDependencies (identical exact versions to packages/ui's own pins), not only in packages/ui: scripts/brand/raster.ts lives at repo-root scope, and pnpm's per-package node_modules resolution means a bare `import('sharp')` from scripts/ only resolves if the ROOT workspace itself declares the dependency -- packages/ui's copy is invisible from there. Same reasoning the plan itself already applied to tsx."
  - "Kept the plan's original evenodd two-arc ring probe as a SECOND, explicitly non-gating test (RESEARCH.md open question 1's original framing), built from geometry.ts's own circle() primitive rather than a hand-rolled arc string, so both probes share one source of truth for arc math"

patterns-established:
  - "scripts/brand/ is a typechecked-but-not-linted Node script directory (matches the existing scripts/ convention -- no root eslint config covers scripts/ or tests/ today; not a gap introduced by this plan)"

requirements-completed: []

# Metrics
duration: ~35min
completed: 2026-09-22
---

# Phase 7 Plan 02: Raster pipeline (sharp/png-to-ico, fidelity-probed) Summary

**Provenance-gated sharp/png-to-ico raster pipeline (svgToPng, pngsToIco, pngMetadata) proven against 07-01's real nonzero-winding ring() construct, plus an idempotent writeIfChanged helper — RASTER_BACKEND is 'sharp', decided by an executed test, not an assumption.**

## Performance

- **Duration:** ~35 min
- **Started:** 2026-09-22T22:56Z (immediately after 07-01's completion)
- **Completed:** 2026-09-22T23:14Z
- **Tasks:** 3 (Task 1 pre-resolved by the orchestrator before this agent started; Tasks 2-3 executed here)
- **Files modified:** 9 (5 created, 4 modified/appended)

## Package legitimacy gate

Task 1 (`checkpoint:human-verify`, `gate="blocking-human"`) was resolved by the orchestrator with the user **before** this agent was spawned. Recorded verbatim per the orchestrator's handoff:

- **User's reply:** "approved (Recommended)" — both `sharp` and `png-to-ico` approved for install at their exact pinned versions.
- **Registry evidence the orchestrator verified via `npm view` on 2026-09-22, before any install:**
  - `sharp@0.35.4` → `repository.url = git+https://github.com/lovell/sharp.git`; `latest = 0.35.4`; `scripts` contains no `preinstall`/`install`/`postinstall` key.
  - `png-to-ico@3.0.2` → `repository.url = git+https://github.com/steambap/png-to-ico.git`; `latest = 3.0.2`; `scripts = { test, lint }` only.
- **Correction to the plan's Task 2 acceptance criterion** ("`npm view sharp@0.35.4 scripts` output does not contain the substring `install`"): `sharp@0.35.4`'s `scripts` object legitimately contains `"build": "node install/build.js"` — a manually-invoked maintainer script whose target lives in a directory literally named `install/`, not a lifecycle hook (npm only ever auto-runs `preinstall`/`install`/`postinstall`/`prepare` by exact key name). This agent verified the KEYS of the scripts object programmatically (`npm view sharp@0.35.4 scripts --json | node -e '...'`, asserting none of `preinstall`/`install`/`postinstall` are present) rather than grepping the raw output for the substring `install`, exactly as instructed, and did **not** treat `install/build.js` as a hook or "fix" anything because of it.

This agent started execution at Task 2 (registered provenance first, committed that alone, then installed), per the checkpoint-already-resolved instruction.

## Accomplishments

- `sharp`/`png-to-ico` registered in `EXPECTED_PACKAGES` (`scripts/check-package-provenance.mjs`) in a commit (`300a8a4`) that is a git ancestor of the commit that first touches `pnpm-lock.yaml` (`cacec4f`) — the supply-chain gate's ordering invariant is provable from git history, not just asserted.
- ADR-0000 gained a "Phase 7 additions" section recording the human verdict, the `npm view` evidence, and the `install/build.js`-is-not-a-hook correction, so a future reader never re-litigates that question.
- `scripts/brand/raster.ts` exports `svgToPng`, `pngsToIco`, `pngMetadata`, `RASTER_BACKEND` — proven end-to-end: PNG signature bytes, requested dimensions, alpha-channel presence/absence with and without a composited background, a real multi-resolution ICO header (`00 00 01 00`, 3-entry directory), and — the plan's actual point — a fidelity probe that rasterizes `ring(12, 12, 9, 5)` **imported directly from 07-01's `packages/ui/src/brand/geometry.ts`**, at `viewBox="0 0 24 24"`, with a plain `fill="black"` and no `fill-rule`/`stroke` attribute (exactly what a real consumer of `geometry.ts` is allowed to paint). Sampled pixels (64×64 raster, scale 64/24):
  - centre `(32, 32)` → alpha `0` (the counter is a real hole)
  - band `(32, 13)` → alpha `> 200` (the ring itself is painted; svg-space point `(12, 4.875)`, radius 7.125 from centre, strictly between `rInner=5` and `rOuter=9`)
  - corner `(2, 2)` → alpha `0` (well outside `rOuter`, svg-space distance ≈15.9 units from centre)
- `scripts/brand/write-if-changed.ts` exports `writeIfChanged`, `changedFiles`, `resetChangedFiles` — string content compared by value, Buffer content compared via `Buffer.equals`, ledger entries are repo-relative paths (`path.relative` from `scripts/brand/../..`), matching `scripts/capture-discovery-fixtures.mjs`'s own convention.
- `scripts/brand/tsconfig.json` (extends `@noodara/config/tsconfig.base.json`, `jsx: "react-jsx"`, `noEmit`, `lib: ["es2023", "dom"]`) is chained into the root `pnpm typecheck` script.

## Lockfile diff summary

Only the following entered `pnpm-lock.yaml` across both installs (Task 2's `packages/ui`-scoped install and Task 3's root-scoped fix): `sharp@0.35.4` (+ its existing `@img/sharp-*` optional binary packages, which were already present in the lockfile from a prior optional-dependency edge and simply lost their `optional: true` annotation now that `sharp` is a real direct dependency in two importers), `png-to-ico@3.0.2` and its two runtime dependencies (`pngjs@7.0.0`, `minimist@1.2.8`), a nested `@types/node@25.9.8`/`undici-types@7.24.6` pin that `png-to-ico`'s own `package.json` pulls in (independent of the root's `@types/node@22.12.0` pin), and `tsx@4.23.13` at the root importer. No unrelated package version moved. Verified by reading the full `git diff pnpm-lock.yaml` for both commits, not just `git diff --stat`.

## Task Commits

1. **Task 2a: register provenance (before any install)** — `300a8a4` (chore)
2. **Task 2b: install pinned versions + scripts/brand tsconfig** — `cacec4f` (chore)
3. **Task 3 RED: failing raster pipeline tests** — `2dcbade` (test)
4. **Task 3 GREEN: raster.ts + write-if-changed.ts, root-devDependency fix** — `4fc8511` (feat)

## Files Created/Modified

- `scripts/brand/raster.ts` — `svgToPng`/`pngsToIco`/`pngMetadata`/`RASTER_BACKEND`, guarded dynamic imports, header names the fidelity-probe decision and the untaken Playwright fallback branch.
- `scripts/brand/write-if-changed.ts` — idempotent, ledgered writes; no delete API (T-07-04).
- `scripts/brand/tsconfig.json` — new, wired into `pnpm typecheck`.
- `tests/unit/brand/raster.test.ts` — 8 tests: PNG signature/metadata, background compositing, the gating fidelity probe, a secondary non-gating evenodd probe, `RASTER_BACKEND` membership, ICO header/entry-count, and two `writeIfChanged` behaviour tests.
- `scripts/check-package-provenance.mjs` — `EXPECTED_PACKAGES` gained `sharp`→`lovell/sharp` and `png-to-ico`→`steambap/png-to-ico`.
- `docs/adr/0000-package-legitimacy-approvals.md` — "Phase 7 additions" section.
- `packages/ui/package.json` — `sharp@0.35.4`, `png-to-ico@3.0.2` in `devDependencies`.
- `package.json` — `tsx@4.23.13`, `sharp@0.35.4`, `png-to-ico@3.0.2` in root `devDependencies`; `typecheck` script gained `&& tsc -p scripts/brand/tsconfig.json --noEmit`.
- `pnpm-lock.yaml` — reflects both installs.

## Decisions Made

Recorded in frontmatter `key-decisions`. The two worth repeating: **RASTER_BACKEND = 'sharp'**, decided by an executed fidelity probe against the real `ring()` construct (not the plan's originally-suggested hand-rolled evenodd stand-in — see Deviations), and **sharp/png-to-ico are pinned in both `packages/ui` and the repo root**, because `scripts/brand/raster.ts` lives outside `packages/ui`'s own dependency resolution scope.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 3 - Blocking] `sharp`/`png-to-ico` unresolvable from `scripts/brand/raster.ts`**
- **Found during:** Task 3, first GREEN test run
- **Issue:** The plan (and 07-RESEARCH.md/07-PATTERNS.md) specified installing `sharp`/`png-to-ico` with `--filter @noodara/ui` only, reasoning that they're scoped like the Radix packages `packages/ui`'s own React components import. But `scripts/brand/raster.ts` lives at repo-root scope (`scripts/`, not `packages/ui/src/`), and pnpm's per-package node_modules resolution means a bare `import('sharp')` from there only resolves through node_modules directories that the ROOT workspace's own `package.json` actually declares as a dependency — `packages/ui/node_modules/sharp` is invisible to a module resolving from `scripts/`. `node -e "require.resolve('sharp')"` from the repo root failed with `MODULE_NOT_FOUND` before this fix.
- **Fix:** Ran `pnpm add -D sharp@0.35.4 png-to-ico@3.0.2 -w` (root-scoped, exact same pins already provenance-registered and human-approved — not a new/different package). This is the identical fix pattern the plan itself already applied to `tsx` (pinned in both `apps/control-plane` and the root, "matching the existing convention"), just discovered for two more packages during Task 3 instead of anticipated in Task 2.
- **Verification:** `node -e "require.resolve('sharp'); require.resolve('png-to-ico')"` resolves from the repo root; `pnpm exec vitest run tests/unit/brand/raster.test.ts` — all 8 tests pass; `node scripts/check-package-provenance.mjs` still reports 54/54 (no new package names, same two entries cover both locations); `pnpm install --frozen-lockfile` exits 0.
- **Files modified:** `package.json`, `pnpm-lock.yaml`
- **Committed in:** `4fc8511` (Task 3 GREEN commit)

**2. [Rule 1 - Bug] Two of my own test assertions had incorrect expected geometry**
- **Found during:** Task 3, first GREEN test run (after fixing deviation 1 above, sharp resolved and 6/8 tests passed immediately, including the gating fidelity probe)
- **Issue:** (a) The secondary, non-gating evenodd probe's hand-rolled SVG path (`M32 8 A24 24...`) had inconsistent sweep flags and a wrong sampled band pixel, so it measured alpha 11 instead of the expected >200 — a bug in the test's own SVG string, not in `raster.ts`. (b) The `writeIfChanged` ledger test wrote three times (`'hello'`, `'hello'`, `'goodbye'`) and asserted the ledger listed the path exactly once, but a genuinely-different third write correctly pushes a *second* ledger entry — `changedFiles` is a per-write-event log, not deduplicated by path, and the original assertion contradicted the plan's own stated behaviour ("returns true the first time and false the second").
- **Fix:** (a) Rebuilt `evenoddRingSvg()` from `geometry.ts`'s own `circle()` primitive (two full circles, same sweep direction — evenodd only cares about crossing count, never winding) instead of a hand-typed arc string, and corrected the sampled band pixel to `(32, 13)` (radius 19, between `rInner=14` and `rOuter=24` on a 1:1-scale 64×64 viewBox). (b) Split the test into "one real write, one no-op write → exactly one ledger entry" followed by "a third, genuinely different write → a second, separate ledger entry", matching the plan's exact three-call behaviour description.
- **Verification:** `pnpm exec vitest run tests/unit/brand/raster.test.ts` — 8/8 pass.
- **Files modified:** `tests/unit/brand/raster.test.ts`
- **Committed in:** `4fc8511` (part of the Task 3 GREEN commit, not a separate RED/GREEN cycle since these were bugs in the test's own setup, not in the behaviour under test)

**3. [Rule 2 - Missing Critical, upstream-directed] Fidelity probe rebuilt around the real `ring()` construct, not the plan's original hand-rolled evenodd stand-in**
- **Found during:** Task execution start (directed by the orchestrator's `<upstream_facts_from_07_01>`, not discovered independently)
- **Issue:** The plan's Task 3 `<action>` literally specified building the fidelity-probe SVG as a hand-rolled two-arc path with `fill-rule="evenodd"`. 07-01 (completed just before this plan) settled on the SVG-default nonzero fill rule for every real path `geometry.ts` produces — an evenodd probe would validate a construct the concepts never actually use, leaving the real open question (does librsvg render `ring()`'s nonzero winding correctly?) untested.
- **Fix:** The gating fidelity test imports `ring` (and, for the secondary probe, `circle`) directly from `packages/ui/src/brand/geometry.ts` and builds `<svg viewBox="0 0 24 24"><path d="${ring(12,12,9,5)}" fill="black"/></svg>` — no `fill-rule`, no `stroke`. The plan's original evenodd construct is kept as a second, explicitly-labelled non-gating test documenting RESEARCH.md's original open-question framing, per the orchestrator's instruction that this was optional but allowed.
- **Verification:** Both probes pass under the real `sharp` install; `RASTER_BACKEND` stays `'sharp'`.
- **Files modified:** `tests/unit/brand/raster.test.ts`
- **Committed in:** `2dcbade` (RED), confirmed in `4fc8511` (GREEN)

---

**Total deviations:** 3 (1 blocking dependency-resolution fix, 1 test-bug fix, 1 upstream-directed probe redesign). All three keep the plan's actual intent (a real, honest fidelity probe against sharp/png-to-ico, backed by a working supply chain) intact; none expand scope beyond this plan's own files.

## Issues Encountered

None beyond the deviations above — `pnpm typecheck` and `pnpm lint` were both clean on the first run after the GREEN commit (no pre-existing lint coverage of `scripts/`/`tests/` at the repo root to accidentally break; this plan does not change that).

## User Setup Required

None — no external service configuration required. The Task 1 package-legitimacy checkpoint (the one manual step this plan required) was already resolved by the orchestrator before this agent started.

## Next Phase Readiness

- `scripts/brand/raster.ts` and `scripts/brand/write-if-changed.ts` are ready for 07-06 (asset generation) to import directly — the exported API (`svgToPng`, `pngsToIco`, `pngMetadata`, `RASTER_BACKEND`, `writeIfChanged`, `changedFiles`, `resetChangedFiles`) matches this plan's `<interfaces>` block exactly; no signature drift.
- `RASTER_BACKEND` is `'sharp'` — 07-06 does not need to branch on backend or re-run the fidelity probe; the decision is settled and covered by a regression test (`tests/unit/brand/raster.test.ts`) that will fail loudly if a future `sharp`/librsvg upgrade regresses the nonzero-winding render.
- **BRAND-01/BRAND-02 are NOT complete after this plan** (matching 07-01's own precedent — `requirements-completed: []`, `REQUIREMENTS.md` checkboxes left unticked, `roadmap update-plan-progress` still records the phase as in-progress): this plan delivers only the mechanical raster pipeline, not any actual brand asset, `docs/brand/` sheet, or app application. `requirements.mark-complete` was deliberately NOT invoked for this plan for the same reason 07-01 did not invoke it.
- A future plan that needs a Playwright-based raster fallback (if a later `sharp`/librsvg version ever regresses on a more complex concept path) can read `raster.ts`'s own header comment for the exact untaken implementation shape (`chromium.launch()` → `page.setContent()` → `page.screenshot({ omitBackground })`), without needing to re-derive it from RESEARCH.md.

## Self-Check: PASSED

- `scripts/brand/raster.ts`, `scripts/brand/write-if-changed.ts`, `scripts/brand/tsconfig.json`, `tests/unit/brand/raster.test.ts` all exist on disk.
- Commits `300a8a4`, `cacec4f`, `2dcbade`, `4fc8511` are all present in `git log --oneline`, in that order, with the RED commit (`2dcbade`) preceding the GREEN commit (`4fc8511`), and the provenance-registration commit (`300a8a4`) preceding the first lockfile-touching commit (`cacec4f`).
- `node scripts/check-package-provenance.mjs`, `pnpm install --frozen-lockfile`, `pnpm exec vitest run tests/unit/brand/raster.test.ts`, `pnpm typecheck`, `pnpm lint` all exit 0 as of the final commit.

---
*Phase: 07-identidad-y-brand-kit*
*Completed: 2026-09-22*
