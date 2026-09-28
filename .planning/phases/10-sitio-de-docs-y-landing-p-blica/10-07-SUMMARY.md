---
phase: 10-sitio-de-docs-y-landing-p-blica
plan: 07
subsystem: infra
tags: [nextjs, static-export, seo, supply-chain, sitemap, 404]

requires:
  - phase: 10-01
    provides: "apps/site/site-config.mjs: SITE_ORIGIN, PREVIEW_BASE_PATH, readCname(siteRoot)"
  - phase: 10-02
    provides: "apps/site/src/lib/build-info.ts (readBuildInfo/assetPath), root layout with metadataBase"
  - phase: 10-05
    provides: "apps/site/src/lib/source.ts (source.getPages() over content/docs)"
provides:
  - "apps/site/scripts/check-export.mjs: post-build gate (findThirdPartyAssetUrls, findFontFaces, findLeakedEnvNames, findBasePathMismatch, REQUIRED_EXPORT_FILES) wired into `pnpm --filter @noodara/site build` -- every build now fails on any third-party asset, @font-face, preview-prefixed asset in a CNAME-present build, or leaked control-plane secret value"
  - "apps/site/src/lib/seo.ts: pure buildSitemapEntries/buildRobots, always on the canonical origin, never dated"
  - "apps/site/src/app/sitemap.ts and robots.ts: force-static routes producing out/sitemap.xml and out/robots.txt"
  - "apps/site/src/app/not-found.tsx: on-brand 404 (Lockup, 'Page not found', links to /docs and /)"
affects: [10-08, 10-09, 10-10, 10-11, 10-12]

tech-stack:
  added: []
  patterns:
    - "check-export.mjs mirrors sync-site-assets.mjs's module/CLI-main split (10-02): every detection function is pure and disk-free, exported for tests/unit/site/check-export.test.ts's fixture-only suite; only the CLI main branch (isMainModule guard) touches the real apps/site/out directory"
    - "findThirdPartyAssetUrls scans only script/link/img/source/iframe tag attributes plus CSS url(...) -- <a href> (navigation) and <meta> (og:image) are structurally excluded, never scanned as assets, matching the plan's own behavior spec rather than an origin-only filter"
    - "not-found.tsx is a 'use client' file for the same reason apps/site/src/components/DocsNavTitle.tsx isolates its Lockup import: @noodara/ui's barrel re-exports hook-using components with no own 'use client' directive"

key-files:
  created:
    - apps/site/scripts/check-export.mjs
    - tests/unit/site/check-export.test.ts
    - apps/site/src/lib/seo.ts
    - apps/site/src/lib/seo.test.ts
    - apps/site/src/app/sitemap.ts
    - apps/site/src/app/robots.ts
    - apps/site/src/app/not-found.tsx
  modified:
    - apps/site/package.json

key-decisions:
  - "text-ink-muted does not exist as a token; the 404 body uses text-ink-secondary (packages/ui/tokens.css's actual secondary-ink role), verified against tokens.css before writing the component rather than guessing a class name"
  - "check-export's REQUIRED_EXPORT_FILES presence check treats an entry as found if an exact match, a `<entry>.html` file, or a `<entry>/` directory exists in the export -- accommodates Next's own 'docs.html' vs 'api/search' (a directory, not a file) output shapes without a special case per entry"

requirements-completed: [SITE-01, SITE-02]

duration: 26min
completed: 2026-09-28
---

# Phase 10 Plan 07: Sitemap, robots, on-brand 404, and the post-build export checker Summary

**A post-build `check-export.mjs` gate that fails any site build carrying a third-party asset, a downloaded font, a wrong-base-path asset, or a leaked secret value, plus the sitemap/robots/404 pieces D-14 requires.**

## Performance

- **Duration:** 26 min
- **Started:** 2026-09-28T00:00:00Z
- **Completed:** 2026-09-28T06:03:42Z
- **Tasks:** 2 completed
- **Files modified:** 8 (7 created, 1 modified)

## Accomplishments

- `apps/site/scripts/check-export.mjs` implements `findThirdPartyAssetUrls`, `findFontFaces`, `findLeakedEnvNames`, `findBasePathMismatch` and `REQUIRED_EXPORT_FILES` as pure, disk-free functions (20 passing fixture tests in `tests/unit/site/check-export.test.ts`), plus a CLI main that walks the real `apps/site/out`, checks every `.html`/`.css` file, verifies every required export file exists, and exits 1 with a full finding list on any violation.
- `apps/site/package.json`'s `build` script now runs `node scripts/sync-site-assets.mjs && next build && node scripts/check-export.mjs` -- every build (local, the 10-03 PR gate, and the Pages publish step) self-verifies its own export.
- Ran a real `pnpm --filter @noodara/site build`: `check-export: 5 files, zero third-party assets`. `out/sitemap.xml`, `out/robots.txt` and `out/404.html` all produced correctly; `pnpm --filter @noodara/site typecheck`, `lint`, `pnpm check:ui-safety` and `pnpm boundaries` all pass; the full `pnpm vitest run` is 191 files / 3175 tests green.
- `apps/site/src/lib/seo.ts`'s `buildSitemapEntries`/`buildRobots` back `app/sitemap.ts` and `app/robots.ts` (both `force-static`, always on `readBuildInfo().origin`, never a `lastModified` date). `app/not-found.tsx` renders the Lockup, "Page not found", and links to `/docs` and `/` styled per `AuthCard.tsx`'s own precedent (`text-ink`, `text-title font-semibold`, `text-accent-text hover:underline`).

## Task Commits

Each task was committed atomically (RED then GREEN, per CLAUDE.md §2.1):

1. **Task 1 RED: failing check-export.mjs tests** - `d812c0f` (test)
2. **Task 1 GREEN: check-export.mjs + build wiring** - `28638ac` (feat)
3. **Task 2 RED: failing seo.ts tests** - `0b7467f` (test)
4. **Task 2 GREEN: seo.ts, sitemap.ts, robots.ts, not-found.tsx** - `922dabf` (feat)

## Files Created/Modified

- `apps/site/scripts/check-export.mjs` - third-party/font/base-path/secret detection + CLI walk of `apps/site/out`
- `tests/unit/site/check-export.test.ts` - 20 fixture tests for every detection function
- `apps/site/src/lib/seo.ts` - `buildSitemapEntries`, `buildRobots`
- `apps/site/src/lib/seo.test.ts` - 5 tests
- `apps/site/src/app/sitemap.ts` - `force-static` sitemap route
- `apps/site/src/app/robots.ts` - `force-static` robots route
- `apps/site/src/app/not-found.tsx` - on-brand 404 page
- `apps/site/package.json` - `build` script now chains `check-export.mjs`

## Decisions Made

- `text-ink-secondary` (not `text-ink-muted`, which does not exist) for the 404 body text -- confirmed against `packages/ui/tokens.css` before writing the component.
- `REQUIRED_EXPORT_FILES` presence check accepts an exact match, a `.html` file, or a directory for each entry, since Next's static export produces `docs.html` for the docs index route but a real `api/search` directory for the search route.

## Deviations from Plan

None - plan executed exactly as written (TDD RED→GREEN for both tasks, both `<action>` blocks followed, both `<verify>` steps run for real).

## Issues Encountered

- The plan's Task 2 `<verify>` automated command includes `grep -c "https://noodara.com/docs/" apps/site/out/sitemap.xml`, which currently returns 0 (exit 1) because `apps/site/content/docs` only has `index.mdx` today -- the nested docs pages (`getting-started/install`, etc.) ship in plans 10-08/10-09/10-10, not this one. This is the same expected gap `10-04-SUMMARY.md` already documented for its own site-review capture run ("an honest, expected result for a build that has no docs content yet, not a defect in this plan's tooling"). `buildSitemapEntries`/`source.getPages()` are proven correct by `seo.test.ts`'s own fixtures (three distinct paths including a nested one) and will automatically pick up the real nested URLs once 10-08+ add content -- no code change needed here. Every other part of the verify chain (vitest, the build itself, check-export, and `grep -c "Page not found" out/404.html`) passes for real.

## Next Phase Readiness

- `check-export.mjs` is now a hard gate on every future `@noodara/site` build; plans 10-08/10-09/10-10 adding docs content will automatically be checked by it (and their new sitemap URLs will start appearing once those MDX files exist).
- Sitemap/robots/404 are in place; no blockers for the remaining phase-10 plans.

---
*Phase: 10-sitio-de-docs-y-landing-p-blica*
*Completed: 2026-09-28*
