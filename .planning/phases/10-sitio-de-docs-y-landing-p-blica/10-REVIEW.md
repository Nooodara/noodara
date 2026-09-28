---
phase: 10-sitio-de-docs-y-landing-p-blica
reviewed: 2026-09-28T15:35:08Z
depth: standard
files_reviewed: 47
files_reviewed_list:
  - .github/workflows/ci.yml
  - .github/workflows/public-site.yml
  - .gitignore
  - apps/site/next.config.mjs
  - apps/site/package.json
  - apps/site/postcss.config.mjs
  - apps/site/scripts/check-export.mjs
  - apps/site/scripts/sync-site-assets.mjs
  - apps/site/site-config.mjs
  - apps/site/source.config.ts
  - apps/site/src/app/api/search/route.ts
  - apps/site/src/app/docs/[[...slug]]/page.tsx
  - apps/site/src/app/docs/layout.tsx
  - apps/site/src/app/global.css
  - apps/site/src/app/layout.tsx
  - apps/site/src/app/not-found.tsx
  - apps/site/src/app/page.tsx
  - apps/site/src/app/robots.ts
  - apps/site/src/app/sitemap.ts
  - apps/site/src/components/DocsNavTitle.tsx
  - apps/site/src/components/SiteSearchDialog.tsx
  - apps/site/src/components/SiteThemeToggle.tsx
  - apps/site/src/components/SiteThemeToggle.test.tsx
  - apps/site/src/components/landing/CapabilityGlyph.tsx
  - apps/site/src/components/landing/ClosingCta.tsx
  - apps/site/src/components/landing/FAQSection.tsx
  - apps/site/src/components/landing/FeatureGrid.tsx
  - apps/site/src/components/landing/Hero.tsx
  - apps/site/src/components/landing/HowItWorksDiagram.tsx
  - apps/site/src/components/landing/InstallCommand.tsx
  - apps/site/src/components/landing/Landing.tsx
  - apps/site/src/components/landing/Landing.test.tsx
  - apps/site/src/components/landing/landing-parts.test.tsx
  - apps/site/src/components/landing/ProductTour.tsx
  - apps/site/src/components/landing/RevealSection.tsx
  - apps/site/src/components/landing/ScopeBlock.tsx
  - apps/site/src/components/landing/ScreenshotFrame.tsx
  - apps/site/src/components/landing/SiteFooter.tsx
  - apps/site/src/components/landing/SiteHeader.tsx
  - apps/site/src/components/mdx/ScopeNote.tsx
  - apps/site/src/components/mdx/ScopeTable.tsx
  - apps/site/src/components/mdx/ScopeTable.test.tsx
  - apps/site/src/content/feature-grid.ts
  - apps/site/src/content/feature-grid.test.ts
  - apps/site/src/content/scope.ts
  - apps/site/src/lib/build-info.ts
  - apps/site/src/lib/build-info.test.ts
  - apps/site/src/lib/content-rules.ts
  - apps/site/src/lib/content-rules.test.ts
  - apps/site/src/lib/docs-nav.ts
  - apps/site/src/lib/docs-nav.test.ts
  - apps/site/src/lib/docs-tree.test.ts
  - apps/site/src/lib/seo.ts
  - apps/site/src/lib/seo.test.ts
  - apps/site/src/lib/site-facts.ts
  - apps/site/src/lib/site-theme.ts
  - apps/site/src/lib/site-theme.test.ts
  - apps/site/src/lib/source.ts
  - apps/site/src/lib/theme-script.ts
  - apps/site/src/lib/theme-script.test.ts
  - apps/site/src/lib/use-scroll-reveal.ts
  - apps/site/src/lib/use-scroll-reveal.test.tsx
  - apps/site/src/mdx-components.tsx
  - apps/site/src/vitest-matchers.d.ts
  - apps/site/tsconfig.json
  - apps/site/turbo.json
  - package.json
  - scripts/check-package-provenance.mjs
  - scripts/check-ui-safety.mjs
  - scripts/ui/capture-site-review.ts
  - scripts/ui/review-paths.ts
  - scripts/ui/static-site-server.ts
  - tests/unit/docs/concepts-accuracy.test.ts
  - tests/unit/docs/error-codes-accuracy.test.ts
  - tests/unit/docs/install-docs-accuracy.test.ts
  - tests/unit/scripts/check-package-provenance.test.ts
  - tests/unit/scripts/check-ui-safety.test.ts
  - tests/unit/scripts/check-workflow-pins.test.ts
  - tests/unit/site/check-export.test.ts
  - tests/unit/site/forbidden-words.test.ts
  - tests/unit/site/fumadocs-token-map.test.ts
  - tests/unit/site/landing-claims.test.ts
  - tests/unit/site/site-approval-record.test.ts
  - tests/unit/site/site-boundary.test.ts
  - tests/unit/site/site-config.test.ts
  - tests/unit/site/site-facts.test.ts
  - tests/unit/site/sync-site-assets.test.ts
  - tests/unit/ui/approval-record.test.ts
  - tests/unit/ui/site-review.test.ts
  - turbo.json
  - vitest.config.ts
findings:
  critical: 1
  warning: 4
  info: 3
  total: 8
status: issues_found
fixed_at: 2026-09-28T15:52:00Z
fixes:
  - id: CR-01
    status: fixed
    commit: a5f8473
  - id: WR-01
    status: fixed
    commit: bb4b962
  - id: WR-02
    status: fixed
    commit: 0ed861e
  - id: WR-03
    status: fixed
    commit: 7a84416
  - id: WR-04
    status: fixed
    commit: 48a8cf3
  - id: IN-01
    status: skipped
    reason: "out of --fix scope (info-tier, not requested)"
  - id: IN-02
    status: skipped
    reason: "out of --fix scope (info-tier, not requested)"
  - id: IN-03
    status: skipped
    reason: "out of --fix scope (info-tier, not requested)"
fix_status: critical_warning_fixed
---

# Phase 10: Code Review Report

**Reviewed:** 2026-09-28T15:35:08Z
**Depth:** standard
**Files Reviewed:** 47 read directly (of 84 listed in scope)
**Fixed:** 2026-09-28 -- all 1 Critical + 4 Warning findings fixed (CR-01, WR-01..WR-04); 3 Info
findings left unfixed (out of requested scope). See commits a5f8473, bb4b962, 0ed861e, 7a84416,
48a8cf3. `pnpm vitest run` (3269 tests), `pnpm typecheck`, `pnpm lint`, `pnpm check:ui-safety`,
`pnpm boundaries`, and `pnpm --filter @noodara/site build` (both CNAME-present and CNAME-absent
shapes) all pass after the fixes.
**Status:** issues_found

## Summary

Reviewed `apps/site` (the Fumadocs/Next 16 static-export public site), its build/publish
pipeline (`.github/workflows/{ci,public-site}.yml`), the build-time safety scripts
(`check-export.mjs`, `sync-site-assets.mjs`), the static capture server
(`scripts/ui/static-site-server.ts`), the theme bootstrap script, the scroll-reveal hook, the
`ProductTour` tab widget, `docs-nav.ts`, and a representative slice of the unit test suite for
vacuous assertions.

Overall the pipeline is unusually disciplined: `resolveStaticPath` in
`static-site-server.ts` defends path traversal twice (regex strip + `path.relative` re-check),
`sync-site-assets.mjs` is a strict, non-glob allowlist that fails closed on a missing source,
`check-export.mjs` fails the build on third-party assets/`@font-face`/leaked secret env
assignments, the CI workflows pin every third-party action to a commit SHA and scope
`permissions:` per job, and `useScrollReveal`/`ProductTour` correctly implement a
reduced-motion-safe, roving-tabindex tab pattern with no hydration mismatch. Most of the unit
tests read real fixtures and assert on real regex/output boundaries rather than tautologies.

One real, unguarded correctness defect was found: the CNAME-absent (GitHub Pages `/noodara`
preview subpath) build path — which the project's own `public-site.yml` and `site-config.mjs`
comments explicitly claim is supported ("the site still works from `<owner>.github.io/noodara`
before DNS/CNAME is configured") — is silently broken for every internal navigation link built
with a raw `<a href="/...">` instead of `next/link` or `assetPath()`. No test in the reviewed
suite builds or asserts against the non-CNAME shape, so this would ship silently.

## Critical Issues

### CR-01: Internal navigation links break on the `/noodara` preview basePath

**File:** `apps/site/src/components/landing/Hero.tsx:65`, `apps/site/src/components/landing/SiteHeader.tsx:28,34`, `apps/site/src/components/landing/SiteFooter.tsx:30,38`, `apps/site/src/components/landing/ScopeBlock.tsx:25`, `apps/site/src/components/landing/InstallCommand.tsx:27`

**Issue:** `apps/site/next.config.mjs` computes `basePath = '/noodara'` whenever
`apps/site/public/CNAME` is absent at build time (`site-config.mjs`'s `resolveBasePath`), and
both `public-site.yml` (line 63-64) and `site-config.mjs`'s own header comment state this
preview shape must resolve correctly from `<owner>.github.io/noodara` before DNS is configured.
Next.js only rewrites `basePath` onto `next/link`, `next/image`/`<Image>` and router
navigations — never onto a plain `<a href="...">`. `ScreenshotFrame.tsx` and
`SiteSearchDialog.tsx` correctly call `assetPath()` to prefix `basePath` onto `<img src>`/the
search fetch URL, proving the team is aware of the constraint — but every internal navigation
link uses a raw, un-prefixed `<a href="/docs">` / `<a href="/docs/reference/scope">` /
`<a href="/">` instead of `next/link` (which the codebase does use correctly elsewhere, e.g.
`apps/site/src/app/not-found.tsx:12` and `apps/site/src/components/mdx/ScopeNote.tsx:8,19`).

In a non-CNAME build (the exact scenario the workflow comment calls out — first deploy, before
Pages/DNS is configured, or any GitHub Pages default `<owner>.github.io/<repo>` URL), clicking
"Docs", the wordmark, "See full scope", "Read the docs", "Download, read, run", or any of the
`SiteFooter` docs-nav links navigates the browser to `https://<owner>.github.io/docs` (404)
instead of `https://<owner>.github.io/noodara/docs`. This is a dead site under the one
deployment shape the project explicitly documents as supported, and it is not caught by
`check-export.mjs`'s `findBasePathMismatch` (which only checks the *opposite* direction — a
`/noodara/`-prefixed href leaking into a CNAME-*present* build) nor by any CI job, since both
`ci.yml`'s `site` job and `public-site.yml`'s `build` job build with the committed `CNAME`
present (root basePath) and never exercise the non-CNAME preview shape.

**Fix:** Replace every internal `<a href="/...">` with `next/link`'s `<Link>` (as already done
in `not-found.tsx`/`ScopeNote.tsx`), or route the href through `assetPath()` for non-Link cases:
```tsx
// Hero.tsx / SiteHeader.tsx / SiteFooter.tsx / ScopeBlock.tsx / InstallCommand.tsx
import Link from 'next/link';
// ...
<Link href="/docs" className={PRIMARY_CTA_CLASSES}>Read the docs</Link>
```
Also extend `check-export.mjs`'s basePath check (or add a dedicated one) to fail the build when
a `cnamePresent === false` export contains a root-relative internal `href` that is *not*
prefixed with the preview basePath, so a regression here fails CI instead of shipping silently.

## Warnings

### WR-01: `check-export.mjs` required-file check accepts any subpath match, not just the real export shape

**File:** `apps/site/scripts/check-export.mjs:238-246`

**Issue:** The `found` check for each `requiredFile` is:
```js
const found = [...producedFiles].some(
  (f) => f === requiredFile || f === `${requiredFile}.html` || f.startsWith(`${requiredFile}/`),
);
```
For `requiredFile === 'docs.html'`, the `f.startsWith('docs.html/')` branch can never usefully
match (no directory is ever named `docs.html`), which is harmless, but for `requiredFile ===
'api/search'` the `startsWith('api/search/')` branch will pass even if the actual generated
file is unexpectedly nested (e.g. a future Next.js version emitting `api/search/foo/bar.json`
instead of the expected static route file) — the gate would stay green without anyone verifying
what shape was actually produced. This is a low-value false-negative surface rather than a
security hole, since the whole point of this gate is presence, but it weakens the "never trusted
by review alone" guarantee the file's own header claims for this exact function.

**Fix:** Assert the exact expected leaf shape per required entry (e.g. `api/search` must resolve
to exactly `api/search.html` or `api/search/index.html` — the two shapes `next export` can
plausibly produce for a route handler — rather than any arbitrarily deep `startsWith` match).

### WR-02: `resolveStaticPath`'s traversal-prefix strip only handles a leading run of `../`, not interior escapes reintroduced by `path.normalize`

**File:** `scripts/ui/static-site-server.ts:57`

**Issue:** `normalised = path.normalize(decoded).replace(/^(\.\.[/\\])+/, '/')` only strips a
*leading* run of `../`/`..\`. This is not exploitable today because the subsequent
`path.relative(outDir, candidate)` check (lines 66-69) is real defense-in-depth and does reject
anything that still resolves outside `outDir` — so this is not a live vulnerability. But the
regex-strip step itself does no useful work once the `path.relative` check exists (a decoded
value like `foo/../../etc/passwd` normalizes to `../etc/passwd`, gets stripped to `/etc/passwd`,
which still fails the `path.relative` check the same as if the strip step were removed
entirely), so the comment's claim that `resolveStaticPath` "rejects any path that would escape
`outDir` before ever touching the filesystem" is true only because of the second check, not the
regex — a future refactor that removes the (apparently load-bearing-looking) regex step without
understanding this would not reintroduce a vulnerability, but a refactor that removes the
`path.relative` check *while keeping* the regex would.

**Fix:** Either delete the now-redundant regex-strip step and rely solely on the
`path.relative`-based check (simpler, single source of truth), or add a code comment stating
explicitly that the `path.relative` check on lines 66-69 is the actual security boundary and the
regex above is cosmetic/best-effort only, so a future edit doesn't assume the regex alone is
sufficient.

### WR-03: `docs-nav.ts` throws at module-eval time on any content drift, with no caller-side recovery

**File:** `apps/site/src/lib/docs-nav.ts:36,78-79,54,57`

**Issue:** `DOCS_NAV_GROUPS` is computed by top-level `GROUP_SLUGS.map(readGroup)` at module
load. `readGroup`/`readFrontmatterTitle` throw plain `Error`s (not fail-soft) if any
`meta.json`/`.mdx` file is missing a `title`, `pages`, or frontmatter block. Since this module is
imported by `SiteFooter.tsx` (a Server Component), any single malformed docs page taken down the
whole `next build` at import time with a stack trace pointing into `docs-nav.ts` rather than at
the actual malformed content file's own build-time MDX validation (which Fumadocs already
performs). This is arguably intentional ("fail loud"), consistent with CLAUDE.md §2.3's error
handling requirement, but it means a single frontmatter typo in an unrelated docs page (e.g.
`reference/error-codes.mdx`) breaks the landing page build too, which is a wide blast radius for
what should be a footer nav-rendering concern.

**Fix:** Acceptable as-is if intentional (fail loud is consistent with project doctrine), but
worth a comment noting the blast radius, or scoping the try/catch so a `docs-nav` failure
surfaces as "SiteFooter: docs nav unavailable" rather than an unqualified build crash.

### WR-04: `GitHub` external links omit `target="_blank"`, leaving `rel="noopener noreferrer"` without an opening context

**File:** `apps/site/src/components/landing/SiteHeader.tsx:37`, `apps/site/src/components/landing/SiteFooter.tsx:41`, `apps/site/src/components/landing/Hero.tsx:68`

**Issue:** All three `GITHUB_URL` links carry `rel="noopener noreferrer"` (correct hardening for
an external link opened in a new tab) but no `target="_blank"`, so they navigate the current tab
away from the site entirely. This is a UX regression rather than a security bug (the `rel`
attribute is harmless without `target`), but it is inconsistent with the evident intent (the
`rel` was clearly added for the new-tab case) and means a visitor loses the whole page, including
scroll position and any theme toggle interaction, when clicking "GitHub".

**Fix:** Add `target="_blank"` to the three GitHub link sites, or drop the now-meaningless `rel`
attribute if same-tab navigation is actually intended.

## Info

### IN-01: `ProductTour`'s `onClick` handler does not call `selectIndex`, duplicating its wrap/focus logic inconsistently with keyboard navigation

**File:** `apps/site/src/components/landing/ProductTour.tsx:109-111`

**Issue:** Keyboard navigation (`onKeyDown`) goes through `selectIndex`, which both updates state
and calls `.focus()` on the newly active tab (`tabRefs.current[wrapped]?.focus()`). The mouse
`onClick` handler instead calls `setActiveIndex(index)` directly, skipping the explicit
`.focus()` call. This happens to work today because a native `<button>` click already moves
focus to the clicked element, but it means the two paths that "select a tab" don't share one
code path, which is exactly the kind of duplication `selectIndex` exists to avoid — spelled out
in the file's own reasoning.

**Fix:** `onClick={() => selectIndex(index)}` for a single source of truth.

### IN-02: `check-export.mjs`'s `findLeakedEnvNames` regex allows an unescaped-in-comment false negative pattern

**File:** `apps/site/scripts/check-export.mjs:137`

**Issue:** The pattern `` `\\b${name}\\s*=\\s*(<[^>]*>|[^\\s"'<>]+)` `` requires a literal `=`
immediately (modulo whitespace) after the secret name. A leaked value expressed as
`DATABASE_URL: "postgres://..."` (YAML/JSON-shaped, colon rather than `=`) or
`export DATABASE_URL="..."` with the value inside quotes containing a space would still match
(the alternation excludes quotes from the unquoted branch, so a quoted value with a space, e.g.
`DATABASE_URL="postgres://user:pass with spaces@host"`, is only partially captured, but the
*presence* check would still likely fire on the first token) — this is a low-risk edge case
given the site's own copy is fully controlled, but the regex's real gap is that a colon-style
assignment (common in YAML/JSON code samples the docs might legitimately quote, e.g. showing a
`docker-compose.yml` snippet) is never checked at all.

**Fix:** Low priority given current content has no such snippets; if docs pages ever show
YAML/JSON env blocks, extend `SECRET_ENV_NAMES` scanning to also match `NAME:\s*value` shaped
assignments.

### IN-03: `resolveStaticPath` and `serve` never restrict the HTTP method

**File:** `scripts/ui/static-site-server.ts:111-131`

**Issue:** `serve()` handles every request the same way regardless of `req.method` (POST, PUT,
DELETE, etc. all serve the same static file a GET would). This is a local, ephemeral,
`127.0.0.1`-only server used solely by the capture script, so the practical risk is nil, but it's
a minor deviation from HTTP semantics that a future reuse of this module (e.g. as a
dev-convenience server) could inherit unexpectedly.

**Fix:** Optional — reject non-GET/HEAD methods with 405 if this module is ever reused outside
the capture script's own controlled invocation.

---

_Reviewed: 2026-09-28T15:35:08Z_
_Reviewer: Claude (gsd-code-reviewer)_
_Depth: standard_
