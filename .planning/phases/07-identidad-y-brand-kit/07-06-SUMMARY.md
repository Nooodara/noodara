---
phase: 07-identidad-y-brand-kit
plan: 06
subsystem: ui
tags: [brand, svg, sharp, png-to-ico, exports, vitest, tdd, static-assets]

# Dependency graph
requires:
  - phase: 07-identidad-y-brand-kit
    provides: "07-05's DEFAULT_CONCEPT = 'c' (Viewfinder) and docs/brand/APPROVAL.md -- the gate that unblocks any BRAND-02 surface, including this plan's exports"
  - phase: 07-identidad-y-brand-kit
    provides: "07-03's renderStaticSvg/tileSvg (packages/ui/src/brand/static-svg.ts) -- the only render path this plan's manifest calls, never a second drawing"
  - phase: 07-identidad-y-brand-kit
    provides: "07-02's svgToPng/pngsToIco/pngMetadata/writeIfChanged (scripts/brand/raster.ts, write-if-changed.ts), proven against the real ring() construct with RASTER_BACKEND='sharp'"
provides:
  - "scripts/brand/asset-manifest.ts: pure functions (readBrandTokens, buildTextAssets, rasterSpecs, ogSvg) describing all 13 static brand assets from tokens.css + the approved geometry, callable by both the generator and the exactness test with no I/O of its own"
  - "scripts/brand/generate-brand-assets.ts: pnpm brand:generate (writes) / pnpm brand:check (read-only, exit 1 on drift, what CI runs in 07-10)"
  - "packages/ui/brand/ (13 committed files): monogram/wordmark/lockup in light+dark, favicon.svg+.ico, apple-touch-icon.png (180), icon-192/512.png, og-image.png (1200x630 with the tagline), brand-colors.json"
  - "packages/ui package.json exports \"./brand/*\": \"./brand/*\" -- proven resolvable from apps/web's own package location through the real workspace symlink, not a Vitest alias"
  - "tests/unit/brand/{asset-manifest,brand-assets-accuracy,package-exports-resolvable}.test.ts (59 new tests) locking every committed byte/shape to the manifest's own output"
affects: [07-07, 07-08, 07-09, 07-10]

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "The manifest is pure and the generator is the only writer: asset-manifest.ts takes tokens/concept in, returns strings/specs out, with zero filesystem access of its own -- both generate-brand-assets.ts and the Task 3 exactness test call the exact same functions, so a committed file can never silently diverge from what the generator would produce today"
    - "PNG/ICO are locked by decoded shape (dimensions + alpha + ICO header/entry-count), never raw bytes -- sharp/libvips output is not byte-portable across versions, so only the deterministic .svg/.json text assets are diffed byte-for-byte"
    - "A wildcard subpath export ('./brand/*') is proven resolvable from OUTSIDE the package via Node's own exports resolution (createRequire from apps/web's package.json location), not a Vitest source alias -- vitest.shared.ts's uiSourceAliases deliberately does not cover this subpath, so the test exercises the real runtime path Phase 10 will use"
    - "A forbidden literal a test must assert the absence of (a raw SVG path element) is named descriptively in a header comment when it would otherwise match its own grep gate, following 07-02/07-03/07-04's established pattern for this exact failure mode"

key-files:
  created:
    - scripts/brand/asset-manifest.ts
    - scripts/brand/generate-brand-assets.ts
    - tests/unit/brand/asset-manifest.test.ts
    - tests/unit/brand/brand-assets-accuracy.test.ts
    - tests/unit/brand/package-exports-resolvable.test.ts
    - packages/ui/brand/monogram-light.svg
    - packages/ui/brand/monogram-dark.svg
    - packages/ui/brand/wordmark-light.svg
    - packages/ui/brand/wordmark-dark.svg
    - packages/ui/brand/lockup-light.svg
    - packages/ui/brand/lockup-dark.svg
    - packages/ui/brand/favicon.svg
    - packages/ui/brand/favicon.ico
    - packages/ui/brand/apple-touch-icon.png
    - packages/ui/brand/icon-192.png
    - packages/ui/brand/icon-512.png
    - packages/ui/brand/og-image.png
    - packages/ui/brand/brand-colors.json
  modified:
    - packages/ui/package.json
    - package.json

key-decisions:
  - "RasterSpec gained an optional `packInto` field beyond the plan's own <interfaces> block, additive only: the three favicon tile sizes (16/32/48) need to be marked 'pack into favicon.ico, never write to BRAND_DIR directly' somehow, and every other field in the interface stayed exactly as specified"
  - "apple-touch-icon.png and og-image.png pass their own tile/canvas colour as the raster background so sharp's flatten() strips the alpha channel entirely (hasAlpha === false) -- without it the rounded tile's corners and the canvas rect's own edges would leave the PNG format carrying an (unused) alpha channel"
  - "OG tagline letter-spacing is computed from the display type role's own -0.02em tracking ratio at the OG's 40px font size, rather than a second hand-picked number, so the OG's typography stays derived from the same system scale the rest of the UI uses"
  - "generate-brand-assets.ts's --check compares raster assets by decoded pngMetadata (width/height/hasAlpha) and the ICO's header+entry-count, never raw bytes -- sharp/libvips point releases can change PNG compression output without changing a single rendered pixel"

patterns-established:
  - "A generator/exactness-test pair share one pure manifest module instead of the test re-implementing the generator's logic -- the same discipline 07-04's board/review scripts and 07-02's raster pipeline already established, applied here to the actual shipped assets"

requirements-completed: []

# Metrics
duration: ~25min
completed: 2026-09-23
---

# Phase 7 Plan 06: Static brand asset generation and package export Summary

**One pure manifest (`scripts/brand/asset-manifest.ts`) turns `packages/ui/tokens.css` + the approved Viewfinder geometry into all 13 static brand files -- two SVGs per lockup, a favicon family, an OG image with the tagline -- written by `pnpm brand:generate`, verified byte/shape-exact by `pnpm brand:check` and a dedicated exactness test, and exposed from `packages/ui` as `./brand/*` so Phase 10 can consume them with zero copying.**

## Performance

- **Duration:** ~25 min
- **Tasks:** 3 (Tasks 1 and 3 TDD cycles; Task 2 mechanical generation + export wiring)
- **Files created:** 17 (2 scripts, 3 test files, 13 committed assets, 1 SUMMARY); modified: 2 (both `package.json` files)
- **Tests:** 59 new (22 asset-manifest + 25 brand-assets-accuracy + 4 package-exports-resolvable, plus 8 more it() blocks split across accuracy's describe groups than the plan's own minimum); full unit suite is 145 files / 2456 tests, all green (was 142/2405 after 07-05)

## Accomplishments

- **A pure manifest describes every asset before any file exists.** `readBrandTokens` pulls the five colours + the font-sans stack out of `tokens.css` via `parseTokensCss` (keys with no `--` prefix, per 07-04's own correction), throwing by name on anything missing or non-hex. `buildTextAssets` and `rasterSpecs` never draw: every mark is `renderStaticSvg`/`tileSvg` output from 07-03, and `ogSvg` composes the OG image by lifting the lockup's own `data-part="monogram"`/`data-part="wordmark"` groups out of a real render rather than re-emitting a path.
- **All 13 files generated, committed and idempotent.** `pnpm brand:generate` wrote 13 files on the first run and reported "no files changed" on the second. `pnpm brand:check` (the read-only mode 07-10's CI will run) exits 0 right after generation.
- **Read back with the image viewer, honestly reported:** `og-image.png` shows the Viewfinder lockup in light ink on the `#161618` dark canvas with "Your infrastructure, understood." rendered as real, legible text in the system sans stack -- no tofu boxes, no fallback glyphs, so the OG raster backend stayed `sharp`/librsvg with no Playwright fallback needed. `apple-touch-icon.png` shows the rounded `#0071e3` tile with the white monogram centred and the corner radius visibly rounded, matching D-11.
- **Blue exists in exactly one committed SVG.** `grep -c "#0071e3" packages/ui/brand/favicon.svg` is 1; every other committed `.svg` is checked (by a dedicated test, not just the favicon) to contain zero occurrences.
- **`@noodara/ui/brand/*` resolves from outside the package.** `package-exports-resolvable.test.ts` resolves `lockup-dark.svg`, `favicon.ico` and `brand-colors.json` via `createRequire` rooted at `apps/web/package.json` -- exercising Node's real `exports` map through the workspace symlink, not `vitest.shared.ts`'s alias (which deliberately does not cover `/brand/*`) -- and asserts a `../src/index.ts` traversal attempt throws.
- **Every committed SVG is markup-safe and byte-locked.** All seven `.svg` files are asserted free of `<script`, `href=`, `<foreignObject`, inline event handlers, `<linearGradient` and `<filter`; all eight text assets (7 svg + `brand-colors.json`) are diffed byte-for-byte against a fresh `buildTextAssets()` call.
- **The RED proof for Task 3 was demonstrated live, per the plan's own branch for this case:** `lockup-light.svg` was corrupted with a trailing space, the exactness suite failed naming exactly that file, then it was restored with the single sanctioned `git checkout -- <path>` and the suite re-ran green.

## Task Commits

1. **Task 1 RED: failing asset-manifest tests** — `c990803` (test)
2. **Task 1 GREEN: the pure asset manifest** — `3bfc821` (feat)
3. **Task 2: generate the 13 assets, wire exports/scripts** — `2ed403c` (feat)
4. **Task 3: exactness + export-resolution tests** — `37744f7` (test) -- no GREEN commit needed; both suites pass against Task 2's already-correct output, exactly as the plan anticipates ("GREEN needs no production change if Task 2 was done right")

## Files Created/Modified

- `scripts/brand/asset-manifest.ts` — `BRAND_DIR`, `ASSET_FILES`, `BrandTokens`, `readBrandTokens`, `buildTextAssets`, `RasterSpec` (+ additive `packInto`), `rasterSpecs`, `ogSvg`. No colour literal, no hand-drawn path, no I/O.
- `scripts/brand/generate-brand-assets.ts` — `pnpm brand:generate` (write) / `--check` (read-only drift report, exit 1). Rasterizes via 07-02's `svgToPng`/`pngsToIco`, writes via `writeIfChanged`.
- `packages/ui/brand/*` — the 13 committed assets.
- `packages/ui/package.json` — `"./brand/*": "./brand/*"` added to `exports`.
- `package.json` — `brand:generate`/`brand:check` scripts, both `tsx --tsconfig packages/ui/tsconfig.json ...` (the JSX-transform fix 07-04 already found for `brand:boards`/`brand:review`, applied here since this script also imports `packages/ui/src/brand/*.tsx` components transitively).
- `tests/unit/brand/asset-manifest.test.ts` (22 tests), `brand-assets-accuracy.test.ts` (25 tests), `package-exports-resolvable.test.ts` (4 tests).

## Decisions Made

Recorded in frontmatter `key-decisions`. The two worth repeating: **`RasterSpec` gained an optional `packInto` field** beyond the plan's literal `<interfaces>` block (additive only, matching 07-03's `tileSvg` xmlns precedent and 07-04's `reviewPngPath` variant param) so the three favicon tile sizes can be marked "never write directly, only pack into favicon.ico"; and **the OG's opaque assets pass their own fill colour as the raster background** so `sharp`'s `flatten()` genuinely strips the alpha channel, which is what makes `hasAlpha === false` an unconditional pass rather than the raster pipeline's own hedged ("if hasAlpha, check full opacity") test.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 3 - Blocking] A header comment's own prose matched its own forbidden-literal grep gate**
- **Found during:** Task 1 acceptance verification (`grep -c "<path" scripts/brand/asset-manifest.ts` printed 1, not the required 0)
- **Issue:** The module header explained "never emit an SVG `<path d=\"...\">`" -- the literal string `<path` inside that explanatory comment satisfied the grep meant to prove the module hand-draws nothing, the identical failure mode 07-02 (`process.cwd`), 07-03 (`dangerouslySetInnerHTML`) and 07-04 (`process.cwd` again) already hit and fixed the same way.
- **Fix:** Reworded the comment to name the construct descriptively ("never emit an SVG path element of their own") instead of typing the literal tag.
- **Verification:** `grep -c "<path" scripts/brand/asset-manifest.ts` now prints 0; the module's actual behaviour (and its test coverage) is unchanged.
- **Files modified:** `scripts/brand/asset-manifest.ts`
- **Committed in:** `3bfc821` (Task 1 GREEN)

---

**Total deviations:** 1 (blocking, comment-wording only). No behaviour, scope or test coverage changed.

## Issues Encountered

None beyond the deviation above. `pnpm test -- tests/unit/brand/...` was not used for iteration (STATE.md already records that pnpm does not forward the positional filter); `pnpm exec vitest run tests/unit/brand/<file>.test.ts` was used throughout, matching 07-02/07-03/07-04's own precedent.

## User Setup Required

None — no external service configuration required, no new dependency (sharp/png-to-ico were already installed and provenance-approved in 07-02).

## Next Phase Readiness

- **07-07 (mount the mark in the app)** can import `Logo`/`Lockup` from `@noodara/ui` directly (already exported since 07-03) for the live, `currentColor` in-app surfaces, and can link `packages/ui/brand/favicon.ico`/`apple-touch-icon.png`/`icon-192.png`/`icon-512.png` from `apps/web/src/app/layout.tsx`'s `metadata.icons` — every one of those files now exists, is committed, and is proven byte/shape-locked to the approved geometry.
- **07-08 (the brand kit sheet in `docs/brand/`)** can embed `packages/ui/brand/lockup-light.svg`/`lockup-dark.svg` directly (or via `@noodara/ui/brand/*` once the site exists) rather than regenerating anything — BRAND-01's "SVG en variantes claro/oscuro" half is satisfied by this plan; the brand-kit document itself (construction, protection area, prohibited uses, palette, typography) is still 07-08's own deliverable, so `requirements-completed` stays `[]` here, matching every prior plan in this phase.
- **07-10 (the public site)** consumes `@noodara/ui/brand/*` with no copy step — proven from `apps/web`'s own package location in this plan, which is the same resolution mechanism a future `apps/site` package will use.
- **07-10's CI** runs `pnpm brand:check` as its drift gate (the script's own header names this) — no wiring needed beyond what already exists in `package.json`.
- **BRAND-01/BRAND-02 are NOT complete after this plan** (`requirements-completed: []`, matching every prior 07-0x plan's own precedent): the exported SVGs exist, but the brand-kit document (BRAND-01) and the actual application to app surfaces/README/site (BRAND-02) are still 07-08/07-07/07-10's own work.

## Self-Check: PASSED

- All 17 created files and both modified files exist on disk; `git ls-files --error-unmatch` succeeds for every one of the 13 committed assets, both scripts and all three test files.
- Commits `c990803`, `3bfc821`, `2ed403c`, `37744f7` are all in `git log --oneline`, in that order, with the Task 1 RED commit preceding its GREEN.
- `pnpm exec vitest run tests/unit/brand` (7 files / 102 tests), `pnpm test` (145 files / 2456 tests), `pnpm brand:check`, `pnpm check:ui-safety`, `pnpm typecheck`, `pnpm lint` all exit 0.
- `git stash list` is empty; `git status --short` shows no path outside `noodara/code` staged or modified by this plan's commits.

---
*Phase: 07-identidad-y-brand-kit*
*Completed: 2026-09-23*
