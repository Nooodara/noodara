---
phase: 10-sitio-de-docs-y-landing-p-blica
plan: 11
subsystem: landing
tags: [landing, honesty-test, nextjs, next-client-boundary, static-export]

requires:
  - phase: 10-09
    provides: "InstallCommand, ScreenshotFrame, PillarCard, HowItWorksDiagram, site-facts.ts (INSTALL_COMMAND/GITHUB_URL/APPROVED_SCREENS)"
  - phase: 10-06
    provides: "scope.ts (DELIVERED_CAPABILITIES/SCOPE_EXCLUSIONS/findExcludedTerms), content-rules.ts forbidden-wording scan"
  - phase: 10-02
    provides: "SiteThemeToggle, readBuildInfo()/assetPath(), global.css site-shot/token classes"
  - phase: 10-07
    provides: "check-export.mjs's REQUIRED_EXPORT_FILES gate"
provides:
  - "apps/site/src/components/landing/Landing.tsx: the composed / page (SiteHeader, Hero, positioning line, three PillarCards, How it works, ScopeBlock, SiteFooter)"
  - "apps/site/src/app/page.tsx: the real / route (replaces 10-02's placeholder)"
  - "apps/site/src/components/landing/Landing.test.tsx: 13-case honesty/structure render test"
  - "check-export.mjs REQUIRED_EXPORT_FILES now includes index.html"
affects: [10-12]

tech-stack:
  added: []
  patterns:
    - "Any Server Component that imports a `@noodara/ui` barrel export (Lockup, Logo, CopyButton) must cross a 'use client' boundary itself, or one of its ancestors must -- the barrel re-exports several hook-using components with no directive of their own, matching DocsNavTitle.tsx's/not-found.tsx's established precedent (10-05/10-07). This only became visible once Landing.tsx (a Server Component, since app/page.tsx has no 'use client') actually composed SiteHeader/Hero/HowItWorksDiagram into the real route tree -- 10-09's own components built these files without needing the directive because nothing imported them into a route yet."
    - "The hero's responsive lockup height (32px mobile -> 40px at >=900px, UI-SPEC layout contract) is done by overriding the rendered <svg>'s CSS height via a wrapper's `[&>svg]:h-8 min-[900px]:[&>svg]:h-10` Tailwind arbitrary-descendant classes, since Lockup itself only accepts a single fixed `height` number prop with no responsive variant."

key-files:
  created:
    - apps/site/src/components/landing/Landing.test.tsx
    - apps/site/src/components/landing/SiteHeader.tsx
    - apps/site/src/components/landing/SiteFooter.tsx
    - apps/site/src/components/landing/Hero.tsx
    - apps/site/src/components/landing/ScopeBlock.tsx
    - apps/site/src/components/landing/Landing.tsx
  modified:
    - apps/site/src/app/page.tsx
    - apps/site/src/components/landing/HowItWorksDiagram.tsx
    - apps/site/scripts/check-export.mjs
    - tests/unit/site/check-export.test.ts

key-decisions:
  - "SiteHeader, Hero and HowItWorksDiagram each gained their own 'use client' directive rather than lifting a single boundary onto Landing.tsx as a whole: Landing.tsx itself stays a Server Component (no hooks, no interactivity of its own), and each child crosses the boundary only where it genuinely needs @noodara/ui's barrel -- matching the repo's existing narrowest-boundary precedent (DocsNavTitle.tsx, not-found.tsx) instead of introducing one wide client island for the entire page."
  - "The GitHub link in both SiteHeader and Hero opens in the same tab with rel=\"noopener noreferrer\" (no target=\"_blank\"), per D-06's/the plan's explicit instruction -- Landing.test.tsx's reverse-tabnabbing assertion (T-10-07) only requires the noopener/noreferrer pair when target=\"_blank\" is actually present, which it never is here."

requirements-completed: [SITE-01, SITE-03]

duration: 45min
completed: 2026-09-28
---

# Phase 10 Plan 11: Landing composition -- header, footer, hero, scope block, and the / route Summary

**The public landing now lives at `/`, composed entirely from 10-09's tested building blocks plus four new components (SiteHeader, SiteFooter, Hero, ScopeBlock), with a 13-case render test proving it claims only what `DELIVERED_CAPABILITIES`/`scope.ts` already assert -- no excluded term outside the scope block, no competitor name, every image an approved screenshot, every external link reverse-tabnabbing-safe, and the hero's aperture focus matching `AuthCard.tsx`'s own declarative attributes exactly.**

## Performance

- **Duration:** ~45 min
- **Completed:** 2026-09-28
- **Tasks:** 2/2 completed
- **Files modified:** 10 (6 created, 4 modified)

## Accomplishments

- `Landing.test.tsx` (13 `it` cases) proves: the exact h1 text; `INSTALL_COMMAND` rendered exactly once in a `<code>` with a "Copy install command" button; "Read the docs" (`/docs`) and "View on GitHub" (`GITHUB_URL`) links; Connect/Discover/Understand headings each carrying the right `DELIVERED_CAPABILITIES` claim; the scope block's heading, every `showOnLanding` exclusion statement, and its "See full scope" link to `/docs/reference/scope`; the "How it works" heading plus the diagram's accessible title; zero excluded terms anywhere outside the scope block; zero competitor names; every `<img>` src an approved screenshot; every external `<a>` reverse-tabnabbing-safe; the hero's `data-entering`/`data-aperture-focus`/`data-aperture-focused` attributes; the footer's Docs/GitHub links plus the stubbed license/version text; and a source scan of every non-test landing file for `fetch(`, `IntersectionObserver`, `onScroll`, a hardcoded version literal, or `stargazers`.
- `SiteHeader` (sticky, `--canvas`, hairline bottom border, no `backdrop-filter`, no shadow) carries the wordmark link home, Docs/GitHub nav links (44px hit areas) and `SiteThemeToggle`.
- `Hero` reproduces `AuthCard.tsx`'s exact aperture-focus wrapper around the lockup (`data-entering`/`data-aperture-focus`/`data-aperture-focused` + `--aperture-progress: 1`), the h1, one factual subline, `InstallCommand`, the two CTAs (primary accent-filled "Read the docs", secondary hairline-bordered "View on GitHub"), and the real Servers `ScreenshotFrame` -- the lockup's CSS height is overridden 32px -> 40px at >=900px since `Lockup` itself has no responsive height prop.
- `ScopeBlock` renders "What it does not do yet" and every `showOnLanding` exclusion's statement straight from `scope.ts`, plus the link to the Scope of this release doc page.
- `SiteFooter` shows Docs/GitHub links and `readBuildInfo().license`/`.version` as plain text -- no star count, no fetch (T-10-05).
- `Landing.tsx` composes all of the above plus the D-04 positioning line, the three `PillarCard`s (Connect/login/connect-ssh, Discover/server-detail/discovery, Understand/activity/activity-log) and `HowItWorksDiagram` in a 1120px content column with the UI-SPEC's `--space-8`/`--site-section-gap-lg` rhythm.
- `apps/site/src/app/page.tsx` now renders `<Landing />` with `alternates.canonical: '/'`, replacing 10-02's placeholder. `check-export.mjs`'s `REQUIRED_EXPORT_FILES` now includes `'index.html'`.

## Task Commits

1. **Task 1: Landing render test (RED)** -- `9427d3e` (test)
2. **Task 2: SiteHeader, SiteFooter, Hero, ScopeBlock, Landing and the / route (GREEN)** -- `42a1556` (feat)

_TDD: RED (failing test committed first, confirmed failing because `Landing` did not exist) -> GREEN (all six components plus the route, committed second)._

## Files Created/Modified

- `apps/site/src/components/landing/Landing.test.tsx` -- 13 render/honesty test cases
- `apps/site/src/components/landing/SiteHeader.tsx` -- sticky header, wordmark, nav, theme toggle
- `apps/site/src/components/landing/SiteFooter.tsx` -- Docs/GitHub links, license/version
- `apps/site/src/components/landing/Hero.tsx` -- aperture-focused lockup, headline, subline, install command, CTAs, Servers capture
- `apps/site/src/components/landing/ScopeBlock.tsx` -- "What it does not do yet" list + scope link
- `apps/site/src/components/landing/Landing.tsx` -- section composition
- `apps/site/src/app/page.tsx` -- real `/` route
- `apps/site/src/components/landing/HowItWorksDiagram.tsx` -- gained `'use client'` (see Deviations)
- `apps/site/scripts/check-export.mjs` / `tests/unit/site/check-export.test.ts` -- `REQUIRED_EXPORT_FILES` gains `'index.html'`

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 3 -- Blocking issue] `@noodara/ui` barrel-import client/server boundary broke the real build**
- **Found during:** Task 2's first `pnpm --filter @noodara/site build` run
- **Issue:** `SiteHeader.tsx` and `Hero.tsx` (new) and `HowItWorksDiagram.tsx` (10-09, unmodified until now) import `Lockup`/`Logo` from `@noodara/ui`'s barrel. That barrel re-exports several hook-using components (`CopyButton`, `Sheet`, `RowMenu`, etc.) with no `'use client'` directive of their own. As long as nothing composed these three files into an actual route, Next never traversed that part of the module graph from a Server Component. `Landing.tsx` (itself a Server Component, since `app/page.tsx` has no directive) composing all three for the first time made Next fail the build with "You're importing a module that depends on `useSyncExternalStore` into a React Server Component module" for two separate barrel-reachable hooks.
- **Fix:** Added `'use client'` to `SiteHeader.tsx`, `Hero.tsx` and `HowItWorksDiagram.tsx` -- the same narrow-boundary pattern `apps/site/src/components/DocsNavTitle.tsx` and `apps/site/src/app/not-found.tsx` already established (10-05/10-07). `Landing.tsx` itself stays a Server Component; only the three files that actually touch the barrel cross the boundary.
- **Files modified:** `apps/site/src/components/landing/SiteHeader.tsx`, `apps/site/src/components/landing/Hero.tsx`, `apps/site/src/components/landing/HowItWorksDiagram.tsx`
- **Verification:** `pnpm --filter @noodara/site build` succeeds; `check-export: 21 files, zero third-party assets`.
- **Committed in:** `42a1556` (Task 2 commit)

### Auto-fixed Bugs

**2. [Rule 1 -- Bug] Self-defeating "backdrop-filter"/"shadow" wording in `SiteHeader.tsx`'s own header comment**
- **Found during:** Task 2's acceptance-criteria grep (`grep -rnE "backdrop-|shadow|gradient" apps/site/src/components/landing/*.tsx | grep -v test`)
- **Issue:** The comment explaining the header has *no* `backdrop-filter` and *no* shadow literally contained the words "backdrop-filter" and "shadow" -- the same self-defeating-comment class 10-02/10-06/10-09's own SUMMARYs already logged.
- **Fix:** Reworded to "no blurred-behind effect" / "no drop elevation" -- identical meaning, no longer self-matching.
- **Files modified:** `apps/site/src/components/landing/SiteHeader.tsx`
- **Verification:** the same grep now returns 0.
- **Committed in:** `42a1556` (Task 2 commit)

**3. [Rule 1 -- Bug] `Landing.test.tsx`'s own `?? ''` fallbacks were unnecessary conditionals**
- **Found during:** `pnpm --filter @noodara/site lint`
- **Issue:** `clone.textContent ?? ''` and `container.textContent ?? ''` -- under this repo's tsconfig/lib, `Node.textContent` resolves to a non-nullable `string` (same resolution `content-rules.test.ts` hit in 10-06), so `@typescript-eslint/no-unnecessary-condition` flagged both fallbacks.
- **Fix:** Removed both `?? ''` fallbacks; the surrounding assertions are unaffected (`findExcludedTerms(clone.textContent)`, `expect(container.textContent).not.toMatch(...)`).
- **Files modified:** `apps/site/src/components/landing/Landing.test.tsx`
- **Verification:** `pnpm --filter @noodara/site lint` exits 0; `pnpm vitest run apps/site/src/components/landing/Landing.test.tsx` still 13/13.
- **Committed in:** `42a1556` (Task 2 commit)

---

**Total deviations:** 3 auto-fixed (1 blocking, 2 bugs). All three necessary for the plan's own stated goal (a buildable, lint-clean composed landing) and none touched anything outside this plan's own file list.

## Known Stubs

None -- every section renders real, sourced content: the real `INSTALL_COMMAND`/`GITHUB_URL` (site-facts.ts), the real `DELIVERED_CAPABILITIES` claims, the real approved screenshots, the real `SCOPE_EXCLUSIONS` list, and `readBuildInfo()`'s real build-time license/version.

## Threat Flags

None -- all three threat register entries are mitigated exactly as planned: T-10-04 (false capability claims) by the render test's exhaustive claim/exclusion checks; T-10-07 (reverse tabnabbing) by the external-link assertion (both external links in this plan open in the same tab with `rel="noopener noreferrer"`, never `target="_blank"`); T-10-05 (footer/star-counter disclosure) by the source scan proving no `fetch(`/`stargazers` anywhere in the landing sources and the footer's build-time-only license/version.

## Verification

- `pnpm vitest run apps/site/src/components/landing/Landing.test.tsx` -- 13/13 passed
- `pnpm vitest run apps/site tests/unit/site` -- 178/178 passed
- `pnpm vitest run` (full repo) -- 196 files / 3223 tests passed
- `pnpm --filter @noodara/site build` -- succeeded; route table shows `○ /` static; `check-export: 21 files, zero third-party assets`
- `pnpm --filter @noodara/site typecheck` / `lint` -- clean
- `pnpm typecheck` / `pnpm lint` (full repo, via turbo) -- clean, 9/9 and 10/10 tasks successful
- `pnpm check:ui-safety` -- all 12 gates OK
- `pnpm boundaries` -- 829 files checked, no issues
- `grep -c "Your infrastructure, understood." apps/site/out/index.html` -- 2 (h1 + og:title/meta occurrence)
- `grep -c "curl -fsSL https://raw.githubusercontent.com/nooodara/noodara/main/install.sh | sh" apps/site/out/index.html` -- 1
- `grep -ciE "coolify|dokploy" apps/site/out/index.html` -- 0
- `grep -rnE "backdrop-|shadow|gradient" apps/site/src/components/landing/*.tsx | grep -v test | wc -l` -- 0
- `grep -c "data-aperture-focus" apps/site/out/index.html` -- 1
- `pnpm ui:review:site` -- 50 captures generated (landing x light/dark x 375/900/1280/1920 + 2 reduced-motion), "zero third-party requests". Captures land in the gitignored `docs/ui/review/site/`; not committed.

### What the captures show

Looked at `landing-light-1280.png`, `landing-dark-1280.png`, `landing-light-375.png` and `landing-dark-375.png` with the Read tool. In both themes: the sticky header sits flush with a single hairline border, the lockup/wordmark and headline render correctly, the install command block is a flat `--surface-2` panel with a visible copy icon, the primary/secondary CTAs use the one accent blue and a hairline border respectively, the real Servers screenshot follows the visitor's theme (light capture in light mode, dark capture in dark mode). The three pillar cards are flat with hairline borders (no shadow), stacking to a single column at 375px and staying a 3-column grid at 1280px as required. The "How it works" SVG diagram renders in `currentColor` (black in light, white in dark) with no third-party icon. The scope block lists all five landing exclusions and the "See full scope" link in the one accent color. The footer shows Docs/GitHub links plus the stubbed `Apache License 2.0 · v9.9.9`/`v0.1.0` text (the real build's own version, not a placeholder). No horizontal overflow at 375px in either theme; no shadows, gradients or third-party icon glyphs anywhere. One cosmetic-only note, not a defect: the Servers screenshot itself (the real, approved capture, not something this plan renders) has a large empty area below its three sample rows -- that whitespace is inherent to the source PNG, not something this plan's markup introduces or can change.

## Self-Check: PASSED

- FOUND: apps/site/src/components/landing/Landing.test.tsx
- FOUND: apps/site/src/components/landing/SiteHeader.tsx
- FOUND: apps/site/src/components/landing/SiteFooter.tsx
- FOUND: apps/site/src/components/landing/Hero.tsx
- FOUND: apps/site/src/components/landing/ScopeBlock.tsx
- FOUND: apps/site/src/components/landing/Landing.tsx
- FOUND: apps/site/src/app/page.tsx (modified)
- FOUND: apps/site/src/components/landing/HowItWorksDiagram.tsx (modified)
- FOUND: apps/site/scripts/check-export.mjs (modified)
- FOUND: tests/unit/site/check-export.test.ts (modified)
- FOUND commit 9427d3e in `git log --oneline`
- FOUND commit 42a1556 in `git log --oneline`

---
*Phase: 10-sitio-de-docs-y-landing-pública*
*Completed: 2026-09-28*
