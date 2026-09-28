---
phase: 10-sitio-de-docs-y-landing-p-blica
plan: 02
subsystem: ui
tags: [nextjs, fumadocs, tailwind-v4, design-tokens, static-export, accessibility]

requires:
  - phase: 10-01
    provides: "@noodara/site workspace (Next 16 App Router, output: 'export'), build-time env (NOODARA_SITE_*), fumadocs-core/ui/mdx pinned and provenance-verified"
provides:
  - "apps/site/src/lib/site-theme.ts + theme-script.ts: no-flash, localStorage-only theme system (own storage key, own bootstrap script) writing both [data-theme] and .dark in one place"
  - "apps/site/src/lib/build-info.ts: readBuildInfo()/assetPath() over NOODARA_SITE_* env, fail-fast, no ??/|| literal fallback"
  - "apps/site/src/components/SiteThemeToggle.tsx: icon-only theme toggle, no icon library"
  - "apps/site/scripts/sync-site-assets.mjs: 14-file allowlisted sync (4 brand icons + 5 screens x 2 themes) wired into dev/build"
  - "apps/site/src/app/global.css: full --color-fd-* -> packages/ui token mapping (26 vars incl. Callout/diff tones), measured >=4.5:1"
  - "apps/site/src/app/layout.tsx: root layout with metadataBase, single reviewed bootstrap script, Fumadocs RootProvider (theme/search disabled)"
  - "scripts/check-ui-safety.mjs: apps/site/src added to TSX_GLOBS; dangerouslySetInnerHTML gate is now a per-file allowlist (2 apps, 1 each)"
affects: [10-03, 10-04, 10-05, 10-06, 10-07, 10-08, 10-09, 10-10, 10-11, 10-12]

tech-stack:
  added: []
  patterns:
    - "Site-local theme write path (site-theme.ts/theme-script.ts): independent of apps/web's cookie-mirror ThemeToggle -- own storage key (noodara-site-theme), own bootstrap script literal (repeated deliberately, not imported, since the script must run before any bundle parses), no cookie branch at all (D-15: the site has no server)"
    - "Fumadocs re-skin via CSS variable mapping, never component replacement: every --color-fd-* neutral.css declares (26, including the @theme static Callout/diff tones) is assigned var(--noodara-token) in a single :root, html.dark block after the Fumadocs @imports, measured by a dedicated token-map test (tests/unit/site/fumadocs-token-map.test.ts) rather than trusted by inspection"
    - "check:ui-safety per-file allowlist gates (scanDangerouslySetInnerHtmlAllowlist) as the pattern for a repo-wide count gate that needs to grow past 1 legitimate occurrence: total + explicit allowlist + missing-detection, not just a wider 'expected' number"

key-files:
  created:
    - apps/site/src/lib/site-theme.ts
    - apps/site/src/lib/site-theme.test.ts
    - apps/site/src/lib/theme-script.ts
    - apps/site/src/lib/theme-script.test.ts
    - apps/site/src/lib/build-info.ts
    - apps/site/src/lib/build-info.test.ts
    - apps/site/src/components/SiteThemeToggle.tsx
    - apps/site/src/components/SiteThemeToggle.test.tsx
    - apps/site/src/vitest-matchers.d.ts
    - apps/site/scripts/sync-site-assets.mjs
    - tests/unit/site/sync-site-assets.test.ts
    - apps/site/src/app/global.css
    - apps/site/src/app/layout.tsx
    - apps/site/src/app/page.tsx
    - tests/unit/site/fumadocs-token-map.test.ts
  modified:
    - apps/site/package.json
    - .gitignore
    - scripts/check-ui-safety.mjs
    - tests/unit/scripts/check-ui-safety.test.ts
    - pnpm-lock.yaml

key-decisions:
  - "PRESS_CLASSES duplicated (not imported) into SiteThemeToggle.tsx: @noodara/ui's package.json exports map has no ./press subpath (only the barrel and /testing), so a cross-package import of that internal module is unresolvable from apps/site; the exact same class string is reproduced with a comment pointing back to the source of truth"
  - "9 additional --color-fd-* Callout/diff tones (info/warning/error/success/idea/diff-remove(-symbol)/diff-add(-symbol)) discovered in fumadocs-ui's own @theme static block (not called out in UI-SPEC's mapping table) are mapped to the nearest existing status token per tone: --idea and --warning both reuse --status-warn-text (no dedicated idea/tip tone exists), --info reuses --accent-text (the only blue in the system)"
  - "--color-fd-overlay (the Fumadocs dialog/search scrim, not in UI-SPEC's table either) maps to var(--ink) as the nearest ink token per the plan's own fallback instruction; not contrast-measured since it is never rendered as text, only as a backdrop"

requirements-completed: [SITE-03, SITE-01]

duration: 12min
completed: 2026-09-27
---

# Phase 10 Plan 02: Site theme system, shared tokens, brand/capture assets, root layout Summary

**No-flash localStorage-only theme system with its own bootstrap script, a 14-file allowlisted brand/screenshot sync, and a full Fumadocs `--color-fd-*` re-skin (26 variables, both themes measured >=4.5:1) wired into a static-export root layout that now passes the repo-wide `check:ui-safety` gate.**

## Performance

- **Duration:** 12 min
- **Started:** 2026-09-27T23:00:35-06:00
- **Completed:** 2026-09-27T23:12:02-06:00
- **Tasks:** 3 completed
- **Files modified:** 20 (15 created, 5 modified)

## Accomplishments

- `apps/site` has its own theme write path (`site-theme.ts`/`theme-script.ts`/`SiteThemeToggle.tsx`) that follows `prefers-color-scheme` by default, persists an override to a site-only `localStorage` key, and never flashes the wrong theme -- verified by evaluating the real bootstrap-script constant with `new Function` against jsdom, not just asserting on its source text.
- Build-time truth (`readBuildInfo()`/`assetPath()`) reads `NOODARA_SITE_*` fail-fast, with a named error and no `??`/`||` literal fallback (the repo's eslint config bans that pattern outright).
- `sync-site-assets.mjs` copies a frozen 14-file allowlist (4 `packages/ui/brand` icons + 5 approved screens x 2 themes, deliberately excluding "setup") into `apps/site` on every dev/build, never deletes a foreign file, and fails the build by name if an approved capture or brand asset is ever renamed or removed.
- Every one of the 26 `--color-fd-*` custom properties `fumadocs-ui`'s `neutral.css` declares (17 base + 9 `@theme static` Callout/diff tones neither this plan's own UI-SPEC nor its interfaces enumerated) is mapped to a `var(--noodara-token)` in `apps/site/src/app/global.css`, with the five text/background pairs SITE-03 names measured `>=4.5:1` in both themes by `tests/unit/site/fumadocs-token-map.test.ts` against the real, installed `fumadocs-ui` package and the real `tokens.css` -- not a fixture.
- `apps/site/src/app/layout.tsx` exports a static shell (`metadataBase`, title template, OpenGraph, canonical `/`) with exactly one reviewed `dangerouslySetInnerHTML` occurrence, and `scripts/check-ui-safety.mjs`'s gate for that pattern is now a per-file allowlist (`apps/web` + `apps/site` root layouts, one each) instead of a single repo-wide count that a second legitimate app would have broken.
- `pnpm --filter @noodara/site build` exports a real static site (`apps/site/out/404.html` present, every route `○` static, zero `ƒ` dynamic routes).

## Task Commits

1. **Task 1: Theme library, bootstrap script, toggle and build-info helpers** — `1e3357f` (test, RED) → `de0cd99` (feat, GREEN)
2. **Task 2: Allowlisted asset sync for brand files and approved captures** — `0e8d28f` (test, RED) → `421f2ec` (feat, GREEN)
3. **Task 3: Global CSS with Fumadocs re-skin, root layout, and the ui-safety gate extended to the site** — `0c24e8c` (test, RED) → `26504dd` (feat, GREEN)

## Files Created/Modified

- `apps/site/src/lib/site-theme.ts` — `SITE_THEME_STORAGE_KEY`, `resolveInitialTheme`, `applySiteTheme`, `persistSiteTheme`, `readStoredTheme`, `resolveSystemTheme`
- `apps/site/src/lib/theme-script.ts` — `SITE_THEME_BOOTSTRAP_SCRIPT`, a localStorage-only IIFE with no cookie branch
- `apps/site/src/lib/build-info.ts` — `readBuildInfo()`/`assetPath()`, `MissingSiteEnvError`
- `apps/site/src/components/SiteThemeToggle.tsx` — inline SVG sun/moon icon button, 44x44 hit area
- `apps/site/src/vitest-matchers.d.ts` — jest-dom `Assertion` type augmentation for `tsc` (mirrors `packages/ui/src/testing/vitest-matchers.d.ts`)
- `apps/site/scripts/sync-site-assets.mjs` — `SITE_ASSET_FILES` (14 entries), `syncSiteAssets()`
- `apps/site/src/app/global.css` — Tailwind + Fumadocs presets + Noodara tokens + full `--color-fd-*` mapping + base rules + `--site-section-gap-lg` + `.site-shot-{light,dark}`
- `apps/site/src/app/layout.tsx` — root layout, metadata, bootstrap script, `RootProvider`
- `apps/site/src/app/page.tsx` — minimal placeholder route (see Deviations)
- `scripts/check-ui-safety.mjs` — `apps/site/src` in `TSX_GLOBS`; `scanDangerouslySetInnerHtmlAllowlist` replaces the plain count gate
- `apps/site/package.json` — `dev`/`build` now run `sync-site-assets.mjs` first; added testing-library devDependencies
- `.gitignore` — the five `sync-site-assets.mjs`-generated destinations

## Decisions Made

See `key-decisions` in frontmatter: press-class duplication (no `./press` export subpath), the 9 undocumented Callout/diff `--color-fd-*` tones mapped to the nearest status token, and `--color-fd-overlay` mapped to `--ink`.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 3 - Blocking issue] Added a minimal `apps/site/src/app/page.tsx` placeholder**
- **Found during:** Task 3's verification step (`pnpm --filter @noodara/site build`)
- **Issue:** `next build --output export` requires at least one route to export; this plan's own scope (theme/tokens/layout shell) has no landing-page content task, and the file list doesn't mention `page.tsx`.
- **Fix:** Added a one-line placeholder page (`<main>Noodara</main>`) with a comment marking it as scope for a later landing-page plan.
- **Files modified:** `apps/site/src/app/page.tsx`
- **Verification:** `pnpm --filter @noodara/site build` exits 0, `apps/site/out/404.html` and `index.html` exist, all routes `○` static.
- **Committed in:** `26504dd` (Task 3 commit)

**2. [Rule 2 - Missing critical] Added a dedicated `theme-script.test.ts` for `SITE_THEME_BOOTSTRAP_SCRIPT`**
- **Found during:** Task 1 (writing site-theme.test.ts)
- **Issue:** The plan's `<behavior>` block specifies five separate, security-relevant assertions about `SITE_THEME_BOOTSTRAP_SCRIPT` (no cookie, no `${`, contains the storage key, evaluates correctly via `new Function`), but the plan's own `<files>` list for Task 1 has no test file for `theme-script.ts`.
- **Fix:** Added `apps/site/src/lib/theme-script.test.ts` covering exactly those five assertions.
- **Files modified:** `apps/site/src/lib/theme-script.test.ts`
- **Verification:** Included in Task 1's verify run (31 tests total, all pass).
- **Committed in:** `de0cd99` (Task 1 commit)

**3. [Rule 2 - Missing critical] Mapped 9 undocumented `--color-fd-*` Callout/diff tones**
- **Found during:** Task 3 (writing `fumadocs-token-map.test.ts`, first GREEN attempt)
- **Issue:** `fumadocs-ui/css/lib/default-colors.css`'s `@theme static` block declares `info`/`warning`/`error`/`success`/`idea`/`diff-remove(-symbol)`/`diff-add(-symbol)` -- neither this plan's own `10-UI-SPEC.md` mapping table nor its `<interfaces>` block names these. The behavior spec's "every `--color-fd-*` variable" assertion caught the gap immediately (9 missing mappings on first run).
- **Fix:** Mapped each to the nearest existing status token per tone (see key-decisions), documented inline in `global.css`'s own comment.
- **Files modified:** `apps/site/src/app/global.css`
- **Verification:** `pnpm vitest run tests/unit/site/fumadocs-token-map.test.ts` (17/17 pass, including the exhaustive-mapping assertion).
- **Committed in:** `26504dd` (Task 3 commit)

---

**Total deviations:** 3 auto-fixed (1 blocking, 2 missing-critical)
**Impact on plan:** All three necessary for the plan's own stated goal (a themed, token-governed, buildable shell) and its own behavior spec. No scope creep -- `page.tsx` is a one-line placeholder explicitly marked for replacement, not landing content.

## Issues Encountered

- `vi.spyOn(window, 'matchMedia')` failed in jsdom (`matchMedia` is undefined by default, not just unmocked) -- switched to `vi.stubGlobal('matchMedia', ...)`, matching `packages/ui/src/ThemeToggle.test.tsx`'s own established pattern for this exact jsdom gap.
- `@testing-library/jest-dom`'s Vitest matcher types (`toBeInTheDocument`) don't reach `tsc --noEmit` for a package whose tsconfig only includes `src` (the global augmentation lives in the repo-root `vitest.setup.dom.ts`, outside that `include`) -- fixed with `apps/site/src/vitest-matchers.d.ts`, a `/// <reference>`-only file mirroring `packages/ui/src/testing/vitest-matchers.d.ts`'s existing precedent.
- Two acceptance-criteria greps (`document.cookie` count in `theme-script.ts`, `noodara-site-theme` count in non-test files) initially failed because my own header comments *mentioned* the literal strings they were meant to prove absent -- reworded the comments to describe the same reasoning without repeating the literal substring.

## Next Phase Readiness

- Theme system, token mapping, brand/capture asset sync and the root layout shell are all in place and gate-verified (`pnpm vitest run apps/site tests/unit/site`, `pnpm check:ui-safety`, `pnpm --filter @noodara/site build/typecheck/lint`, `pnpm boundaries`, full `pnpm test` -- 3086/3086 passing, no regressions).
- `apps/site/src/app/page.tsx` is a placeholder only -- the next landing-page plan (10-03 per the phase's wave plan) replaces its body with the real Hero/pillars/scope content (D-01..D-06) and should delete this plan's placeholder comment along with it.
- `SiteThemeToggle` is built and tested but not yet mounted anywhere (no `SiteHeader` exists yet) -- a later plan wires it into the header.

## Self-Check: PASSED

- `apps/site/src/lib/site-theme.ts` — FOUND
- `apps/site/src/lib/theme-script.ts` — FOUND
- `apps/site/src/lib/build-info.ts` — FOUND
- `apps/site/src/components/SiteThemeToggle.tsx` — FOUND
- `apps/site/scripts/sync-site-assets.mjs` — FOUND
- `apps/site/src/app/global.css` — FOUND
- `apps/site/src/app/layout.tsx` — FOUND
- `apps/site/src/app/page.tsx` — FOUND
- `scripts/check-ui-safety.mjs` — FOUND
- Commit `1e3357f` — FOUND
- Commit `de0cd99` — FOUND
- Commit `0e8d28f` — FOUND
- Commit `421f2ec` — FOUND
- Commit `0c24e8c` — FOUND
- Commit `26504dd` — FOUND
- `pnpm vitest run apps/site tests/unit/site` — 85/85 pass
- `pnpm check:ui-safety` — exits 0
- `pnpm --filter @noodara/site build` — exits 0, `apps/site/out/404.html` present
- `pnpm --filter @noodara/site typecheck` / `lint` — exit 0
- `pnpm boundaries` — exits 0
- `pnpm test` (full repo) — 3086/3086 pass, no regressions

---
*Phase: 10-sitio-de-docs-y-landing-pública*
*Completed: 2026-09-27*
