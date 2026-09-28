---
phase: 10-sitio-de-docs-y-landing-p-blica
plan: 05
subsystem: docs-engine
tags: [fumadocs, nextjs, static-export, flexsearch, d-08]

requires:
  - phase: 10-02
    provides: "Site theme system (SiteThemeToggle), build-info (readBuildInfo/assetPath), full Fumadocs --color-fd-* token re-skin in global.css, root layout with RootProvider"
provides:
  - "apps/site/src/lib/source.ts: Fumadocs loader (source.pageTree, source.getPage, source.generateParams) over content/docs"
  - "apps/site/content/docs: five meta.json files fixing the D-08 four-group sidebar order (Getting started / Concepts / Operate / Reference) plus the docs home MDX"
  - "apps/site/src/app/docs/[[...slug]]/page.tsx: fully static (dynamicParams=false) Fumadocs docs page route"
  - "apps/site/src/app/api/search/route.ts: static flexsearch index (staticGET), consumed by apps/site/src/components/SiteSearchDialog.tsx"
  - "apps/site/src/app/docs/layout.tsx: DocsLayout with the Noodara lockup nav title and the site's own theme toggle"
affects: [10-06, 10-07, 10-08, 10-09, 10-10, 10-11, 10-12]

tech-stack:
  added: []
  patterns:
    - "fumadocs-mdx macro.include patterns are matched against ONLY the file's basename (picomatch basename:true / matchBase), never the full relative path -- a directory-scoped glob (e.g. 'src/lib/**/*.ts') can never match anything under this bundler integration; use a filename-only pattern ('source.ts') instead"
    - "A dedicated 'use client' wrapper (DocsNavTitle.tsx) isolates the one @noodara/ui import a Server Component (docs/layout.tsx) needs: @noodara/ui's barrel re-exports several hook-using components with no 'use client' directive of their own, which crashes a Server Component's module graph if imported directly -- every existing apps/web consumer of @noodara/ui is itself already a 'use client' file for the same reason"
  key-links:
    - from: "apps/site/src/app/docs/[[...slug]]/page.tsx"
      to: "apps/site/src/lib/source.ts"
      via: "source.generateParams() in generateStaticParams, source.getPage(slug) in the page body"
    - from: "apps/site/src/components/SiteSearchDialog.tsx"
      to: "/api/search"
      via: "flexsearchStaticClient({ from: assetPath('/api/search') })"

key-files:
  created:
    - apps/site/source.config.ts
    - apps/site/src/lib/source.ts
    - apps/site/src/lib/docs-tree.test.ts
    - apps/site/content/docs/meta.json
    - apps/site/content/docs/index.mdx
    - apps/site/content/docs/getting-started/meta.json
    - apps/site/content/docs/concepts/meta.json
    - apps/site/content/docs/operate/meta.json
    - apps/site/content/docs/reference/meta.json
    - apps/site/src/mdx-components.tsx
    - apps/site/src/app/docs/layout.tsx
    - apps/site/src/app/docs/[[...slug]]/page.tsx
    - apps/site/src/app/api/search/route.ts
    - apps/site/src/components/SiteSearchDialog.tsx
    - apps/site/src/components/DocsNavTitle.tsx
  modified:
    - apps/site/next.config.mjs
    - apps/site/src/app/layout.tsx

key-decisions:
  - "macro.include: ['source.ts'] instead of the plan's ['src/lib/**/*.ts'] -- confirmed against the installed fumadocs-mdx@15.4.5's createMacroMatcher (options-BNnYUjkM.js), which calls picomatch with basename:true unconditionally; that mode always tests a pattern's compiled regex against picomatch.matchBase's bare basename string, so any pattern containing a directory segment can never match. Reproduced and confirmed with both 'next build' (Turbopack) and 'next build --webpack': both compiled cleanly but failed identically at 'Collecting page data' with '[MDX] this macro was not compiled by the bundler plugin' until the pattern was changed to a basename-only glob."
  - "DocsNavTitle.tsx ('use client' wrapper around the single Lockup import) instead of importing Lockup directly in docs/layout.tsx: @noodara/ui's barrel (index.ts) re-exports RowMenu/Sheet/CopyButton/etc, none of which carry their own 'use client' directive (they rely on the importing app already being inside a client boundary, exactly like every apps/web page that imports from @noodara/ui). docs/layout.tsx has no reason to be a Server Component beyond convention -- isolating the one client-requiring import keeps it one, matching the plan's own read_first note about fumadocs-ui/layouts/docs.d.ts's shipped shape."
  - "Full D-08 meta.json page lists (including slugs plans 10-08/10-10 haven't created MDX files for yet) verified NOT to break the build: a real 'pnpm --filter @noodara/site build' with content/docs/getting-started/meta.json listing install/first-login/first-server (none existing yet) still produces a clean static export with no console/build error -- Fumadocs silently drops meta.json page entries that have no matching file. No deviation from the plan's own 'keep the full list, confirm the behavior' instruction was needed."

requirements-completed: [DOCS-01]

duration: 27min
completed: 2026-09-27
---

# Phase 10 Plan 05: Fumadocs wiring -- source, four-group sidebar, static search Summary

**Fumadocs is now the docs engine at `/docs`: a macro-API `loader()` source over `content/docs`, the D-08 four-group sidebar fixed by five `meta.json` files (proven by a disk-reading, Fumadocs-free unit test), a fully static `[[...slug]]` route (`○`/`●`, zero `ƒ`), and a flexsearch static index served from `/api/search` and queried client-side through a re-skinned `SearchDialog`.**

## Performance

- **Duration:** 27 min
- **Started:** 2026-09-27T23:33:00-06:00
- **Completed:** 2026-09-27T23:41:00-06:00 (source of "duration" includes the build/API/lint investigation, not just file authoring)
- **Tasks:** 2 completed
- **Files modified:** 17 (15 created, 2 modified)

## Accomplishments

- `apps/site/src/lib/source.ts` wires `fumadocs-mdx`'s macro API (`defineDocs({ dir: 'content/docs' })` + `loader({ baseUrl: '/docs', ... })`) into a typed Fumadocs source exposing `pageTree`, `getPage`, and `generateParams` -- the first Fumadocs integration anywhere in this repo.
- Five `meta.json` files fix D-08's exact sidebar order and titles (root: index/getting-started/concepts/operate/reference; the four groups with their own title + page order), pinned by `apps/site/src/lib/docs-tree.test.ts` -- a plain `node:fs` test with zero Fumadocs import, so the sidebar contract is verified independently of the loader's own behavior.
- `apps/site/content/docs/index.mdx` is the docs home page: four-group orientation copy, present-tense, zero forbidden words (D-10, proven by the acceptance-criteria grep), linking to each group's first page.
- `apps/site/src/app/docs/[[...slug]]/page.tsx` is a fully static route (`dynamicParams = false`, `source.generateParams()`, no request-scoped API anywhere) rendering `DocsPage`/`DocsTitle`/`DocsDescription`/`DocsBody` from `source.getPage()`; `generateMetadata` resolves `alternates.canonical` against the page's own URL.
- `apps/site/src/app/api/search/route.ts` exports `staticGET` from `flexsearchFromSource(source)` with `revalidate = false`, baked into the export as a real JSON file (`apps/site/out/api/search`, confirmed parseable).
- `apps/site/src/components/SiteSearchDialog.tsx` wires `useDocsSearch({ client: flexsearchStaticClient({ from: assetPath('/api/search') }) })` (the `from` option -- confirmed against the installed `.d.ts`, not an "index URL"-named option as the plan's `<interfaces>` block anticipated needing verification for) into Fumadocs' own `SearchDialog` primitives, and is now `RootProvider`'s `search.SearchDialog` in `apps/site/src/app/layout.tsx`.
- `apps/site/src/app/docs/layout.tsx` renders `DocsLayout` with the real page tree, the Noodara `Lockup` as the nav title (via a dedicated `'use client'` wrapper, see Deviations), and `slots.themeSwitch` set to this site's own `SiteThemeToggle` (D-15).
- Real `pnpm --filter @noodara/site build` route summary: `/docs/[[...slug]]` is `●` (SSG via `generateStaticParams`, prerendering `/docs`), `/api/search` is `○` (static), zero `ƒ` anywhere -- RESEARCH.md Pitfall 3's exact check, done for real, not asserted.
- `pnpm --filter @noodara/site typecheck`, `lint`, `pnpm check:ui-safety`, `pnpm boundaries`, and the full repo `pnpm vitest run` (3120/3120) all pass after this plan; no regressions.

## Task Commits

1. **Task 1: Fumadocs source, sidebar meta and docs home (tree test first)** -- `0d718e9` (test, RED) -> `8a49599` (feat, GREEN)
2. **Task 2: Docs layout and page route, static search, header toggle and lockup** -- `7fbc957` (feat, includes the RSC-safety fix, the macro.include fix, and lint fixes to Task 1's own test file discovered while running this task's verify command)

## Files Created/Modified

- `apps/site/source.config.ts` -- global `defineConfig({})`
- `apps/site/src/lib/source.ts` -- `defineDocs`/`loader`, exports `source`
- `apps/site/src/lib/docs-tree.test.ts` -- 7 tests: five meta.json shapes, cross-group slug uniqueness, every MDX file has non-empty title+description
- `apps/site/content/docs/{meta.json,index.mdx,getting-started/meta.json,concepts/meta.json,operate/meta.json,reference/meta.json}` -- the D-08 tree
- `apps/site/next.config.mjs` -- wrapped with `createMDX({ macro: { include: ['source.ts'] } })`, every prior key untouched
- `apps/site/src/mdx-components.tsx` -- `getMDXComponents(components?)` merging Fumadocs' default MDX components
- `apps/site/src/app/docs/layout.tsx` -- `DocsLayout` with page tree, nav title, theme-switch slot
- `apps/site/src/app/docs/[[...slug]]/page.tsx` -- the static docs page route
- `apps/site/src/app/api/search/route.ts` -- static flexsearch index route
- `apps/site/src/components/SiteSearchDialog.tsx` -- client search dialog wired to the static index
- `apps/site/src/components/DocsNavTitle.tsx` -- `'use client'` wrapper around `Lockup` (see Deviations)
- `apps/site/src/app/layout.tsx` -- `search={{ enabled: false }}` -> `search={{ SearchDialog: SiteSearchDialog }}`

## Decisions Made

See `key-decisions` in frontmatter: the `macro.include` basename-matching fix, the `DocsNavTitle` RSC-boundary fix, and the confirmation that partial meta.json page lists (content not yet authored) don't break the static export.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 3 - Blocking issue] `macro.include: ['src/lib/**/*.ts']` (as written in the plan's own `<interfaces>` block) never matches anything under the installed fumadocs-mdx@15.4.5, breaking the entire `/docs` route**
- **Found during:** Task 2's verify step, first `pnpm --filter @noodara/site build` run
- **Issue:** Build failed at "Collecting page data" with `[MDX] this macro was not compiled by the bundler plugin of fumadocs-mdx` for `/docs/[[...slug]]`. Traced to `fumadocs-mdx/dist/options-BNnYUjkM.js`'s `createMacroMatcher`, which always calls `picomatch(include, { basename: true, ... })` -- `basename: true` routes every match through `picomatch.matchBase`, which tests the pattern's regex against ONLY `path.basename(input)`, regardless of whether the pattern itself contains a slash. A directory-scoped pattern like `src/lib/**/*.ts` compiles to a regex requiring a literal `src/lib/` prefix that a bare basename string (`source.ts`) never has, so it can never match anything. Reproduced identically with both Turbopack (default) and `next build --webpack`, confirming this is fumadocs-mdx's own matching behavior, not a Turbopack-specific bug.
- **Fix:** Changed `next.config.mjs`'s `macro.include` to `['source.ts']` -- a basename-only pattern that matches the macro-calling file regardless of directory, which is both correct under this matching mode and as narrowly scoped as the mode allows.
- **Files modified:** `apps/site/next.config.mjs`
- **Verification:** `pnpm --filter @noodara/site build` (both Turbopack and `--webpack`) produces the correct static/SSG route summary with zero `ƒ` routes; `apps/site/out/docs.html` and `apps/site/out/api/search` both exist and are valid.
- **Committed in:** `7fbc957` (Task 2 commit)

**2. [Rule 1 - Bug] `docs/layout.tsx` importing `Lockup` directly from `@noodara/ui`'s barrel crashed the Server Component build**
- **Found during:** Task 2's first build attempt, before the macro.include issue was found
- **Issue:** `@noodara/ui`'s barrel (`index.ts`) re-exports `RowMenu`, `Sheet`, `CopyButton`, and other hook-using components with no `'use client'` directive of their own -- every existing `apps/web` consumer of `@noodara/ui` is itself already inside a `'use client'` file, which is what makes this safe there. `apps/site/src/app/docs/layout.tsx` has no `'use client'` directive (nor any reason to need one beyond this import), so importing the barrel pulled the whole client-only subgraph into a Server Component's module graph, failing with `useState`/`useSyncExternalStore` errors from `RowMenu.js`/`Sheet.js`/`use-reduced-motion-preference.js`.
- **Fix:** Added `apps/site/src/components/DocsNavTitle.tsx`, a one-component `'use client'` wrapper around `Lockup`, and imported that from `docs/layout.tsx` instead of `Lockup` directly.
- **Files modified:** `apps/site/src/components/DocsNavTitle.tsx` (new), `apps/site/src/app/docs/layout.tsx`
- **Verification:** `pnpm --filter @noodara/site build` compiles and collects page data successfully past this point.
- **Committed in:** `7fbc957` (Task 2 commit)

**3. [Rule 1 - Bug] Six lint errors in Task 1's own `docs-tree.test.ts`, surfaced by Task 2's `pnpm --filter @noodara/site lint` verify step**
- **Found during:** Task 2's verify step
- **Issue:** `prefer-regexp-exec`, `non-nullable-type-assertion-style`, `no-unnecessary-condition`, and `restrict-template-expressions` errors in the frontmatter-reading helper and the cross-group-slug test written in Task 1.
- **Fix:** Rewrote `readFrontmatterField` to use `RegExp#exec()` and optional-chaining instead of `as`-assertions; replaced a forbidden `!` non-null assertion pattern with `?.[1]` + explicit `undefined` checks; guarded the template-literal interpolation of a possibly-`undefined` value with `?? ''`.
- **Files modified:** `apps/site/src/lib/docs-tree.test.ts`
- **Verification:** `pnpm --filter @noodara/site lint` exits 0; `pnpm vitest run apps/site/src/lib/docs-tree.test.ts` still 7/7 pass after the rewrite.
- **Committed in:** `7fbc957` (Task 2 commit, alongside the Task 2 files it was discovered while verifying)

**4. [Rule 1 - Bug] Acceptance-criteria grep for `cookies\(|headers\(` matched this plan's own explanatory comment, not real code**
- **Found during:** Task 2's acceptance-criteria check
- **Issue:** The header comment in `[[...slug]]/page.tsx` originally read "No `cookies()`/`headers()` anywhere in this file", which is itself a match for the literal grep meant to prove their absence -- the same class of self-defeating comment 10-02's SUMMARY already logged once.
- **Fix:** Reworded the comment to describe the same fact without repeating the literal substrings.
- **Files modified:** `apps/site/src/app/docs/[[...slug]]/page.tsx`
- **Verification:** `grep -rlE "cookies\(|headers\(" apps/site/src` returns nothing.
- **Committed in:** `7fbc957` (Task 2 commit)

---

**Total deviations:** 4 auto-fixed (2 blocking, 2 bugs). No deviation required a plan re-scope or touched anything outside this plan's own file list; three of the four were caught before either task's commit (no broken intermediate state ever reached `main`).

## Issues Encountered

- `pnpm ui:review:site` (10-04's capture tool) still reports the same 32 "expected" console-error violations 10-04's own SUMMARY documented -- all on the four docs pages `content/docs`'s own `meta.json` lists but that don't have MDX files yet (`getting-started/install`, `getting-started/first-server`, `concepts/server`, `reference/scope`). This is exactly the expected state per phase sequencing (those pages ship in 10-08/10-10); `landing`/`docs` (home)/`not-found` all still capture cleanly. Not a regression, not fixed here -- out of this plan's scope.

## Next Phase Readiness

- `apps/site/src/lib/source.ts`, the five `meta.json` files, `mdx-components.tsx`, and the docs page/layout/search routes are all in place; the remaining phase-10 content plans (10-06 onward) only need to add MDX files under the existing four group directories -- no further wiring plan is needed.
- `content/docs/getting-started/meta.json`, `concepts/meta.json`, `operate/meta.json`, `reference/meta.json` already carry their full, final page-order lists (D-08) even though most of the MDX files don't exist yet -- confirmed this doesn't break the build, so later content plans can add files in any order without touching these meta.json files again.
- `getMDXComponents()` in `apps/site/src/mdx-components.tsx` is the extension point 10-06 (per the plan's own `<action>` note) registers `ScopeNote`/`ScopeTable` on, without needing to touch the docs page route.
- Full repo `pnpm vitest run` (3120/3120), `pnpm typecheck`, `pnpm lint`, `pnpm boundaries`, `pnpm check:ui-safety` all green after this plan -- no regressions.

## Self-Check: PASSED

- `apps/site/src/lib/source.ts` -- FOUND
- `apps/site/source.config.ts` -- FOUND
- `apps/site/content/docs/meta.json` -- FOUND
- `apps/site/content/docs/index.mdx` -- FOUND
- `apps/site/src/mdx-components.tsx` -- FOUND
- `apps/site/src/app/docs/layout.tsx` -- FOUND
- `apps/site/src/app/docs/[[...slug]]/page.tsx` -- FOUND
- `apps/site/src/app/api/search/route.ts` -- FOUND
- `apps/site/src/components/SiteSearchDialog.tsx` -- FOUND
- `apps/site/src/components/DocsNavTitle.tsx` -- FOUND
- Commit `0d718e9` -- FOUND
- Commit `8a49599` -- FOUND
- Commit `7fbc957` -- FOUND
- `pnpm vitest run apps/site/src/lib/docs-tree.test.ts` -- 7/7 pass
- `pnpm --filter @noodara/site build` -- exits 0, `/docs/[[...slug]]` is `●`, `/api/search` is `○`, zero `ƒ` routes; `out/docs.html` and `out/api/search` present, `out/api/search` is valid JSON
- `pnpm --filter @noodara/site typecheck` / `lint` -- exit 0
- `pnpm check:ui-safety` -- exits 0
- `pnpm boundaries` -- exits 0
- `pnpm vitest run` (full repo) -- 3120/3120 pass

---
*Phase: 10-sitio-de-docs-y-landing-pública*
*Completed: 2026-09-27*
