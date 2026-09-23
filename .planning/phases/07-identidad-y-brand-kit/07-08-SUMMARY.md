---
phase: 07-identidad-y-brand-kit
plan: 08
subsystem: docs
tags: [brand, brand-kit, docs, svg, construction-sheet, vitest, tdd, BRAND-01]

# Dependency graph
requires:
  - phase: 07-identidad-y-brand-kit
    provides: "07-01's geometry.ts -- GRID/MARGIN/STROKE/APERTURE_RADIUS/LOCKUP_GAP, monogramParts, CONCEPT_META, and the header comments that are the Construction section's source"
  - phase: 07-identidad-y-brand-kit
    provides: "07-03's renderStaticSvg (packages/ui/src/brand/static-svg.ts) -- the only render path the construction sheet places on its grid"
  - phase: 07-identidad-y-brand-kit
    provides: "07-04's board-html.ts construction section (refactored away into the shared builder) and write-if-changed.ts"
  - phase: 07-identidad-y-brand-kit
    provides: "07-05's DEFAULT_CONCEPT = 'c' + docs/brand/APPROVAL.md, and 07-06's ASSET_FILES/readBrandTokens"
provides:
  - "docs/brand/BRAND.md: the brand kit -- meaning, construction on the 24 grid with the real constants, the three lockups and their surfaces, clear space and minimum sizes, colour by token, typography, twelve misuse rules, the thirteen exports and the approval record (BRAND-01)"
  - "docs/brand/construction.svg: the construction sheet, generated from the geometry, byte-locked by its own test"
  - "scripts/brand/construction-sheet.ts: constructionSvg (pure) + constructionSheetOptions (tokens in, colours out) + an isMainModule-guarded CLI"
  - "package.json: pnpm brand:construction"
  - "tests/unit/brand/construction-sheet.test.ts (23 tests) and tests/unit/docs/brand-kit-structure.test.ts (24 tests)"
affects: [07-09, 07-10, phase-08-redesign]

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "One construction builder, not two: the brand board's ruler was deleted and board-html.ts now calls the same constructionSvg the committed sheet is written from, with var(--token) colours instead of literals -- a test asserts the board imports it, so a second drawing cannot reappear"
    - "A documentation test reads its numbers from the module the document describes (constants from geometry.ts, the file list from ASSET_FILES, the commands from package.json), so an adjustment round fails the suite instead of silently making the prose lie -- install-docs-accuracy.test.ts's discipline applied to the brand kit"
    - "The construction sheet is the one place in the brand pipeline where a stroke attribute is legitimate: the grid lines and guides are annotations ABOUT the mark, and the module header says so, while the mark itself stays filled outlines under the nonzero rule"

key-files:
  created:
    - docs/brand/BRAND.md
    - docs/brand/construction.svg
    - scripts/brand/construction-sheet.ts
    - tests/unit/brand/construction-sheet.test.ts
    - tests/unit/docs/brand-kit-structure.test.ts
  modified:
    - scripts/brand/board-html.ts
    - package.json

key-decisions:
  - "constructionSvg takes four colours (ink, hairline, annotation, font) rather than reading tokens itself; constructionSheetOptions maps tokens.css contents onto them. That split is what lets the board pass var(--hairline-strong) and the committed file carry a literal ink, from one builder with no theme branch"
  - "The sheet's canvas is 480x480 with the grid scaled onto it by a transform and the labels in px space below, rather than labels inside the 24-unit viewBox: the Viewfinder frame fills the margin box edge to edge, so any label drawn in grid units would sit on top of the mark"
  - "The minimum-size table states 16 px for the monogram AND 24 px inside the product, because both are true for different reasons (16 px is the reviewed favicon; 24 px is what 07-07 measured against the 20 px icon set). Stating only one of them would have made the kit disagree with the shipped rail"
  - "BRAND.md refers to decisions in prose and never by id, and the structure test enforces that with install-docs-accuracy.test.ts's own three regexes -- docs/brand/ is the folder whose contents get copied outward into the public site"

patterns-established:
  - "A generated documentation artifact (the sheet) and the document that embeds it are locked by one test file each, in the same RED-then-GREEN pair: the sheet's test diffs committed bytes against a fresh builder call, the document's test diffs its prose against the code it describes"

requirements-completed: [BRAND-01]

# Metrics
duration: ~12min
completed: 2026-09-22
---

# Phase 7 Plan 08: The brand kit Summary

**`docs/brand/BRAND.md` now lets a person reproduce the Viewfinder mark without asking — the 24-unit grid with every real constant, the three lockups and their surfaces, clear space derived from `STROKE`, colour by token name, twelve misuse rules and the thirteen exports — with its construction sheet generated from `geometry.ts` rather than drawn, and both held to the code by 47 new tests.**

## Performance

- **Duration:** ~12 min
- **Tasks:** 2, both full TDD cycles with the RED committed before the GREEN
- **Files created:** 5 (the kit, the sheet, one script, two test files); modified: 2 (`board-html.ts`, root `package.json`)
- **Tests:** 47 new (23 construction-sheet + 24 brand-kit-structure); full unit suite is 149 files / 2520 tests, all green (was 147/2473 after 07-07)

## Accomplishments

- **The construction sheet is computed, never drawn.** `constructionSvg` builds a 480×480 sheet from `geometry.ts` alone: 50 grid lines (one per unit on each axis), the margin box and the baseline as named guides, the real `data-part="monogram"` group lifted out of a `renderStaticSvg` render, six dimension labels rendered from the constants themselves, and the concept's name from `CONCEPT_META`. Nothing in the module is a coordinate of the mark; the only shapes it assembles are the ruler and the two guides.
- **One builder, not two.** `board-html.ts` had grown its own grid drawing and constants list in 07-04. Both were deleted; the board now calls `constructionSvg` with `var(--hairline-strong)` / `var(--ink-secondary)` / `var(--font-mono)` / `currentColor`, so the sheet a reviewer sees on a board and the sheet the brand kit publishes are the same function. `construction-sheet.test.ts` asserts the import, so a second drawing cannot quietly come back.
- **The sheet was read with the image viewer, and two real defects were fixed before it was committed.** Rasterized at 960 px: the first render ran the subtitle off the right edge of the canvas and collided `TERMINAL_RADIUS = 1.5` into `BASELINE = 23`. The subtitle was shortened and the label block went from three columns to two, with a comment in the source recording that the column count was measured rather than assumed. The second render is clean: title, subtitle, the Viewfinder over its grid with the baseline visible, six constants in two columns and the parts line.
- **`pnpm brand:construction` is idempotent.** First run wrote one file; the immediate second run printed `construction-sheet: no files changed (fully idempotent run).` The CLI is guarded by the `isMainModule` check `check-package-provenance.mjs` established, so importing the module from the test writes nothing.
- **The brand kit answers the question BRAND-01 asks.** Nine sections in reading order. Construction states all ten constants with the values the module exports, embeds the sheet, explains why the mark is filled outlines under the nonzero fill rule (the reason it stays crisp at 16 px), and describes the wordmark's rules including the optical kern on the "r" — the advance is the aperture circle's half-chord, 5.196 units against the bounding box's 7.5. Clear space is `STROKE` grid units on every side, one eighth of the height at any size. Colour is `currentColor`/`--ink` in the product, with the tile as the only blue surface.
- **The kit cannot drift.** `brand-kit-structure.test.ts` reads the constants from `geometry.ts`, the thirteen filenames from `ASSET_FILES`, and every `pnpm <command>` it names from the real `package.json`. It also enforces zero colour literals, zero planning ids (the same three regexes `install-docs-accuracy.test.ts` uses) and zero attribution strings.
- **Nothing upstream regressed.** `board-html.test.ts` (its construction-sheet assertions unchanged) and `review-paths.test.ts` pass against the refactor; `install-docs-accuracy.test.ts` and `approval-record.test.ts` — the latter scans every file under `docs/brand/` for attribution strings, so both new files are in its scope — pass unchanged.

## Task Commits

| Task | What | Commit | Type |
|------|------|--------|------|
| 1 | RED: failing construction-sheet tests (module absent) | `9a17c38` | test |
| 1 | GREEN: the generated sheet, the shared builder, `brand:construction` | `5d810fe` | feat |
| 2 | RED: failing brand-kit structure tests (24 failing, document absent) | `44ac28d` | test |
| 2 | GREEN: `docs/brand/BRAND.md` | `e6508ce` | docs |
| — | This summary and the tracking update | (below) | docs |

## RED evidence

- **Task 1:** the suite could not even load — `Cannot find module '../../../scripts/brand/construction-sheet.js'`. After the GREEN: 23/23.
- **Task 2:** 24 of 24 failed on `ENOENT: docs/brand/BRAND.md`. After the GREEN: 24/24.

## Verification

- `pnpm exec vitest run tests/unit/brand/construction-sheet.test.ts tests/unit/brand/board-html.test.ts tests/unit/brand/review-paths.test.ts` — 54/54 green (the board's own construction assertions still hold after the refactor)
- `pnpm exec vitest run tests/unit/docs/brand-kit-structure.test.ts tests/unit/docs/install-docs-accuracy.test.ts tests/unit/brand/approval-record.test.ts` — 54/54 green
- `pnpm test` — 149 files / 2520 tests green; `pnpm typecheck`, `pnpm lint`, `pnpm check:ui-safety` all exit 0
- `pnpm brand:construction` run twice — one file changed, then "no files changed"
- `grep -c "^## " docs/brand/BRAND.md` → 9, listed in the required order; `grep -c "packages/ui/brand/"` → 16; `grep -cE "#[0-9a-fA-F]{6}\b"` → 0; `grep -ci "claude\|anthropic"` → 0; `grep -cE "#[0-9a-fA-F]{6}\b" scripts/brand/construction-sheet.ts` → 0
- `docs/brand/construction.svg` is 6,729 bytes and contains `data-grid="24"` and `data-part="aperture"`

## Decisions Made

Recorded in frontmatter `key-decisions`. The two worth repeating: **the builder takes its four colours from the caller** (a token value for the committed file, a `var(--token)` reference for the board), which is the whole reason one function can serve a themed HTML page and a standalone file; and **the minimum-size table states both 16 px and 24 px for the monogram**, because 16 px is the reviewed browser tab and 24 px is what 07-07 measured for the rail against the 20 px icon set — stating one number would have made the kit disagree with what actually ships.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] The first generated sheet overflowed its own canvas**
- **Found during:** Task 1 GREEN, visual verification of the rasterized sheet
- **Issue:** At the caption size, the subtitle ran past the right edge of the 480 canvas and the three-column constant layout ran `TERMINAL_RADIUS = 1.5` into `BASELINE = 23`. Every test passed — the strings were all present — so only reading the image caught it.
- **Fix:** Shortened the subtitle and moved the label block to two columns of 192 px over three rows, with a source comment recording that the column count was measured on the rendered sheet rather than assumed.
- **Verification:** re-rasterized at 960 px and read again; everything sits inside the canvas with no collision.
- **Files modified:** `scripts/brand/construction-sheet.ts`, `docs/brand/construction.svg`
- **Committed in:** `5d810fe` (Task 1 GREEN)

**2. [Rule 3 - Blocking] The plan's own throw-by-name test fixture was not a parseable tokens file**
- **Found during:** Task 1 GREEN
- **Issue:** The test proving `constructionSheetOptions` throws by token name passed a `:root`-only fixture; `parseTokensCss` (07-01/05-33) requires a `[data-theme="dark"]` block to exist at all, so it threw its own unrelated error first and the assertion tested nothing.
- **Fix:** The fixture became a well-formed stylesheet with both blocks that simply omits the token under test, so the assertion proves what it claims.
- **Verification:** the test fails with `hairline-strong` in the message, as intended.
- **Files modified:** `tests/unit/brand/construction-sheet.test.ts`
- **Committed in:** `5d810fe`

**3. [Rule 1 - Bug] Two prose assertions failed on line wrapping, not on content**
- **Found during:** Task 2 GREEN
- **Issue:** The verbatim concept meaning and the phrase "no font file" were each split across a wrapped line in `BRAND.md`, so the substring assertions failed on text that was in fact present and correct.
- **Fix:** Rewrapped both passages. The quoted meaning is now on one line (a quotation that must match the module verbatim should not be rewrapped by a future editor either).
- **Verification:** 24/24 green.
- **Files modified:** `docs/brand/BRAND.md`
- **Committed in:** `e6508ce`

**4. [Rule 2 - Missing critical functionality] The exclamation-mark rule had to exempt Markdown image syntax**
- **Found during:** Task 2 RED
- **Issue:** The copy-style test forbids exclamation marks (design brief, section 9), but the plan also requires the document to embed `![Construction](construction.svg)`.
- **Fix:** The assertion excludes `!` immediately followed by `[`, so Markdown's image syntax is the one legitimate occurrence and every other exclamation mark still fails.
- **Files modified:** `tests/unit/docs/brand-kit-structure.test.ts`
- **Committed in:** `44ac28d` (RED)

---

**Total deviations:** 4 — one real rendering defect, one test-fixture correction, one wrapping fix and one assertion carve-out. No scope, behaviour or coverage was reduced.

## Issues Encountered

- **`pnpm test -- <path>` still does not filter** (recorded since 07-03): every scoped run in this plan used `pnpm exec vitest run <paths>`.
- **A construction sheet cannot be verified by its test suite alone.** Every string assertion passed on a sheet whose text ran off the canvas. Rasterizing it through the existing `svgToPng` helper and reading the image was the only thing that caught it — the same lesson 07-06 recorded for the OG image's text rendering.

## User Setup Required

None — no new dependency, no external service.

## Next Phase Readiness

- **07-09 (the web app's icons) is unblocked and now has a written contract to satisfy:** the kit's assets section states that `apps/web/src/app/` carries copies refreshed from `packages/ui/brand/` by `apps/web/scripts/sync-brand-assets.mjs` before every dev run and build. That script is 07-09's deliverable; the brand kit describes the mechanism and `brand-kit-structure.test.ts` deliberately does not assert the file exists, so this plan's suite stays green either way.
- **07-10 (README and the public site)** can lift the `<picture>` snippet straight out of the kit's assets section, and the kit's own `pnpm <command>` test means any command it names is guaranteed to exist in `package.json`.
- **BRAND-01 is complete** — the brand kit exists, covers meaning, construction, lockups, clear space and minimum size, colour, typography, misuse, assets/exports and approval, and is test-locked to the code it describes. BRAND-02 remains pending (the favicon/apple-touch-icon in 07-09 and the README in 07-10).
- **Phase 8 inherits a document that fails loudly.** An adjustment round that retunes a constant now breaks `brand-kit-structure.test.ts` on the exact sentence that went stale, so the kit cannot rot silently.

## Self-Check: PASSED

- All five created files exist on disk (`docs/brand/BRAND.md`, `docs/brand/construction.svg`, `scripts/brand/construction-sheet.ts`, both test files); both modified files are tracked with the expected changes.
- Commits `9a17c38`, `5d810fe`, `44ac28d`, `e6508ce` are all in `git log --oneline`, in that order, with each RED preceding its GREEN.
- Every commit touches only paths under `noodara/code/`; none carries an attribution trailer; `git stash list` is empty.

---
*Phase: 07-identidad-y-brand-kit*
*Completed: 2026-09-22*
