---
task: 260928-gmm
title: Move public site hosting from GitHub Pages to Cloudflare Pages
subsystem: apps/site, .github/workflows
tags: [hosting, cloudflare-pages, ci, security-headers]
requires: []
provides: [cloudflare-pages-deploy, root-only-basepath, site-security-headers]
affects: [SITE-02]
tech-stack:
  added: [cloudflare/wrangler-action@9acf94ace14e7dc412b076f2c5c20b8ce93c79cd (v3.15.0), wrangler 4.143.0]
  patterns: [SHA-pinned third-party GitHub Action, Cloudflare Pages _headers response-header config]
key-files:
  created:
    - apps/site/public/_headers
  modified:
    - .github/workflows/public-site.yml
    - .github/workflows/ci.yml
    - apps/site/site-config.mjs
    - apps/site/next.config.mjs
    - apps/site/scripts/check-export.mjs
    - apps/site/src/app/layout.tsx
    - apps/site/src/app/not-found.tsx
    - apps/site/src/app/sitemap.ts
    - apps/site/src/app/page.tsx
    - apps/site/src/lib/seo.ts
    - apps/site/src/lib/build-info.ts
    - apps/site/src/components/SiteSearchDialog.tsx
    - apps/site/README.md
    - .planning/REQUIREMENTS.md
    - .planning/phases/10-sitio-de-docs-y-landing-p-blica/10-CONTEXT.md
    - .planning/phases/10-sitio-de-docs-y-landing-p-blica/10-HUMAN-UAT.md
    - .planning/phases/10-sitio-de-docs-y-landing-p-blica/10-SECURITY.md
    - tests/unit/site/site-config.test.ts
    - tests/unit/site/check-export.test.ts
    - tests/unit/site/site-boundary.test.ts
    - tests/unit/scripts/check-workflow-pins.test.ts
  deleted:
    - apps/site/public/CNAME
decisions:
  - "Cloudflare Pages via Direct Upload (wrangler-action), not git-integration deploy -- keeps the SHA-pinned, least-privilege CI discipline this repo already applies everywhere else"
  - "basePath is now a plain '' constant, not a computed value -- Cloudflare Pages has no subpath-preview case GitHub Pages project-sites had, so resolveBasePath/readCname/PREVIEW_BASE_PATH are deleted outright rather than kept conditional"
metrics:
  duration: ~40 min
  completed: 2026-09-28
---

# Quick Task 260928-gmm: Move public site hosting from GitHub Pages to Cloudflare Pages Summary

Moved `apps/site`'s static-export hosting from GitHub Pages (Actions-artifact deploy) to
Cloudflare Pages (SHA-pinned `wrangler-action` Direct Upload), per the user's locked 2026-09-28
decision, and removed the CNAME-gated `basePath` branching that GitHub Pages project-sites needed
but Cloudflare Pages does not.

## What shipped

**`.github/workflows/public-site.yml`** collapsed from two jobs (`build` + `deploy` with
`pages: write`/`id-token: write` under a `github-pages` environment) to a single `deploy` job:
checkout → pnpm install → `pnpm --filter @noodara/site build` → `cloudflare/wrangler-action@9acf94ace14e7dc412b076f2c5c20b8ce93c79cd`
(`v3.15.0`, `wranglerVersion: '4.143.0'`) running
`pages deploy apps/site/out --project-name=noodara-site --branch=main`. Job permissions are
`contents: read` only; no `pages:`/`id-token:` anywhere; `concurrency.group` renamed
`pages` → `cloudflare-pages`; trigger unchanged (`push: branches: [main]` + `workflow_dispatch`,
no `paths:` filter). The two secrets read are `CLOUDFLARE_API_TOKEN`/`CLOUDFLARE_ACCOUNT_ID`, both
via `secrets.*`, never echoed.

**`apps/site`'s basePath is now always the empty string.** `site-config.mjs` no longer exports
`PREVIEW_BASE_PATH`/`resolveBasePath`/`readCname`; `next.config.mjs` sets `const basePath = ''`
directly; `apps/site/public/CNAME` is deleted (`git rm`, confirmed as `deleted` not `modified` via
`git status`); `check-export.mjs` dropped `findBasePathMismatch`/`findMissingBasePathPrefix` and
the CNAME-conditional `requiredFiles` branch. Stale GitHub-Pages/CNAME comments were updated
(comment-only, no behavior change) in `layout.tsx`, `not-found.tsx`, `sitemap.ts`, `page.tsx`,
`seo.ts`, `build-info.ts`, `SiteSearchDialog.tsx`.

**`apps/site/public/_headers`** (new, Cloudflare Pages format) sets `X-Content-Type-Options:
nosniff`, `Referrer-Policy: strict-origin-when-cross-origin`, `X-Frame-Options: DENY`,
`Permissions-Policy: camera=(), microphone=(), geolocation=()`, `Strict-Transport-Security:
max-age=31536000; includeSubDomains` on `/*`, plus `Cache-Control: public, max-age=31536000,
immutable` on `/_next/static/*`. Presence is enforced every build via `check-export.mjs`'s
`REQUIRED_EXPORT_FILES` (now including `'_headers'`). No CSP this round -- documented as a
follow-up in `apps/site/README.md` (the theme-bootstrap inline script is a reviewed exception,
T-10-11).

**Docs updated:** `apps/site/README.md` (Cloudflare Pages setup steps, Namecheap→Cloudflare
nameserver cutover, dropped CSP note), `REQUIREMENTS.md` SITE-02 reworded, `10-CONTEXT.md` gained
a `D-11a/D-12a/D-13a` amendment section after D-14, `10-HUMAN-UAT.md`'s two pending items re-scoped
to the Cloudflare deploy and nameserver cutover, `10-SECURITY.md` got a dated audit-trail note
(threat register counts/rows unchanged, audit-trail only).

## TDD evidence (RED → GREEN)

**RED (`a392c9c`):** edited the four test files first. Verified failure:
```
Test Files  3 failed | 1 passed (4)
     Tests  8 failed | 69 passed (77)
```
- `site-config.test.ts`: fully green already (no functional change needed there).
- `check-workflow-pins.test.ts`: 6 new/changed assertions failed against the still-GitHub-Pages-shaped `public-site.yml` (deploy-job-permissions, concurrency group, secrets scan, wrangler deploy shape, SHA+wranglerVersion pin, no github-pages env/pages/id-token).
- `check-export.test.ts`: `REQUIRED_EXPORT_FILES` assertion failed (missing `_headers`).
- `site-boundary.test.ts`: new `_headers`-existence assertion failed (file absent).

**GREEN (`3be676c`, `c54bd3f`, `f3d7220`):** workflow rewrite, basePath removal, and `_headers`
creation, each followed by the relevant suite going green; confirmed by the final full run below.

## Real gate numbers

| Gate | Result |
|---|---|
| `pnpm vitest run` | 200 test files passed, 3256 tests passed |
| `pnpm typecheck` | 9/9 workspace tasks successful, 0 errors |
| `pnpm lint` | 10/10 workspace tasks successful, 0 errors (after Task 2's unused-import fix, see Deviations) |
| `pnpm check:ui-safety` | OK -- all 12 repo-wide UI safety gates hold |
| `pnpm boundaries` | Checked 840 files in 7 packages, no issues found |
| `node scripts/check-workflow-pins.mjs` (default + all 4 workflow files explicitly) | all 4 workflow files clean |
| `pnpm --filter @noodara/site build` | succeeds; `check-export: 21 files, zero third-party assets`; `apps/site/out/_headers` present; no `/noodara`-prefixed internal links (spot-checked `index.html`/`docs.html` -- the only `/noodara` occurrences are `github.com/nooodara/noodara` and the raw install-script URL, not path prefixes) |

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] Unused `readFileSync` import left in `site-config.mjs`**
- **Found during:** running the full `pnpm lint` gate after Task 3.
- **Issue:** removing `readCname` (Task 2) left `readFileSync` imported but unused in `apps/site/site-config.mjs`, tripping ESLint's `no-unused-vars`.
- **Fix:** dropped the now-unused import.
- **Files modified:** `apps/site/site-config.mjs`.
- **Commit:** `cfbfe8c`.

No other deviations -- the plan's exact task/action sequence otherwise executed as written.

## Human setup required (documented in `apps/site/README.md`, not performed by this task)

1. In the Cloudflare dashboard: create the Pages project `noodara-site` (Direct Upload, no git
   integration).
2. Create a scoped API token (Account → Cloudflare Pages → Edit only, never Account → All, never a
   Global API Key); note the account ID.
3. Add both as GitHub repo secrets: `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID`.
4. At Namecheap: switch `noodara.com`'s nameservers to the two Cloudflare-assigned nameservers
   (Custom DNS) -- registration stays at Namecheap, DNS management moves to Cloudflare.
5. Once the zone is active in Cloudflare: add `noodara.com` and `www.noodara.com` as custom
   domains on the `noodara-site` Pages project (Cloudflare provisions TLS automatically).
6. Configure the `www` → apex redirect via a Cloudflare redirect rule (or the Pages project's own
   custom-domain redirect).

None of these were performed by this task -- no Cloudflare credentials exist in this environment,
and per the plan's constraints this task never touches DNS/Namecheap/Cloudflare dashboards. Both
items are tracked as `[pending]` in `10-HUMAN-UAT.md`.

## Threat Flags

None -- every threat surface this task adds (`CLOUDFLARE_API_TOKEN`/`CLOUDFLARE_ACCOUNT_ID` in
the GitHub Actions → Cloudflare API trust boundary, and `apps/site/public/_headers` as the site's
only server-side response control) is already covered by the plan's own `<threat_model>`
(T-quick-260928-gmm-01..05), which this execution implemented as written.

## Self-Check: PASSED

- `apps/site/public/_headers` -- FOUND
- `apps/site/public/CNAME` -- correctly absent (deleted)
- `.github/workflows/public-site.yml` contains `cloudflare/wrangler-action` -- FOUND
- Commits `a392c9c`, `3be676c`, `c54bd3f`, `f3d7220`, `83c78fc`, `cfbfe8c` -- all FOUND in `git log`
