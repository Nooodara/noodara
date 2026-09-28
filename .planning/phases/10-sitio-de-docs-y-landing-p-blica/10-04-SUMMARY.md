---
phase: 10-sitio-de-docs-y-landing-p-blica
plan: 04
subsystem: tooling
tags: [playwright, static-server, ui-review, site-03, d-16]

requires:
  - phase: 10-01
    provides: "@noodara/site workspace, output: 'export', apps/site/out static build"
provides:
  - "scripts/ui/static-site-server.ts: local 127.0.0.1/ephemeral-port static server over apps/site/out, with GitHub-Pages-equivalent extensionless-route resolution and path-traversal rejection"
  - "scripts/ui/review-paths.ts: SITE_REVIEW_ROOT, SITE_PAGES, SiteSurface, siteReviewPngPath (site-review-round path helpers, appended alongside the existing app-review exports)"
  - "scripts/ui/capture-site-review.ts + pnpm ui:review:site: one-command Playwright capture of the built site (landing, 4 representative docs pages, 404) in both themes at 375/900/1280/1920, plus a reduced-motion landing capture, that fails the run on any third-party request or unexpected console error"
affects: [10-11, 10-12]

tech-stack:
  added: []
  patterns:
    - "Hand-rolled node:http static server mirroring GitHub Pages' own extensionless-route resolution (exact file -> <p>.html -> <p>/index.html), rather than a generic static-file-server dependency, so local captures match production resolution exactly"
    - "Runtime third-party-request proof (D-16) lives in the capture script itself (page.on('request') + isThirdPartyRequest), not only in a static/source-only assertion -- catches third-party requests a dependency might introduce indirectly"

key-files:
  created:
    - scripts/ui/static-site-server.ts
    - scripts/ui/capture-site-review.ts
    - tests/unit/ui/site-review.test.ts
  modified:
    - scripts/ui/review-paths.ts
    - package.json

key-decisions:
  - "The 'not-found' surface's own Chromium-generated console message ('Failed to load resource: ... 404') is exempted from the D-16 console-error check, since SITE_PAGES deliberately navigates that surface to a nonexistent path -- the exemption is scoped to that exact message pattern and only on that surface, so a real JS error on the 404 page (or any 404'd subresource on another page) still fails the run"

requirements-completed: []

duration: 18min
completed: 2026-09-27
---

# Phase 10 Plan 04: Site review capture tooling (static server + Playwright matrix) Summary

**A local static server that reproduces GitHub Pages' own route resolution over `apps/site/out`, plus `pnpm ui:review:site` -- a Playwright capture matrix (landing, 4 docs pages, 404, both themes, four widths, one reduced-motion pass) that doubles as a runtime proof of zero third-party requests (D-16).**

## Performance

- **Duration:** 18 min
- **Started:** 2026-09-27T23:22:00-06:00
- **Completed:** 2026-09-27T23:40:00-06:00
- **Tasks:** 2 completed
- **Files modified:** 5 (3 created, 2 modified)

## Accomplishments

- `scripts/ui/static-site-server.ts` serves `apps/site/out` on `127.0.0.1`/an OS-assigned ephemeral port, resolving extensionless routes the same way GitHub Pages resolves a Next.js `output: 'export'` build (`<p>` exact file -> `<p>.html` -> `<p>/index.html`), rejecting any path-traversal attempt before ever touching the filesystem (T-10-18), and setting `server.requestTimeout = 10_000` as an explicit timeout.
- `scripts/ui/review-paths.ts` gained `SITE_REVIEW_ROOT` (`docs/ui/review/site`), `SITE_PAGES` (the six capture surfaces: landing, four representative docs pages spanning all four sidebar groups, and 404), `SiteSurface`, and `siteReviewPngPath` -- appended without touching any existing export (pinned by `tests/unit/ui/review-paths.test.ts`, still green).
- `pnpm ui:review:site` (`scripts/ui/capture-site-review.ts`) boots the static server, launches Chromium, captures the full SITE_PAGES x THEMES x WIDTHS matrix plus a `reducedMotion: 'reduce'` landing capture per theme at 1280px, and records every third-party request and console error it observes across the whole run -- failing with a detailed listing if any exist.
- Ran the script for real against a fresh `pnpm --filter @noodara/site build`: zero third-party requests across all 50 captures (D-16 proof holds), all 50 PNGs written under the gitignored `docs/ui/review/site/`. The run does currently exit 1 because `docs/getting-started/install`, `docs/getting-started/first-server`, `docs/concepts/server` and `docs/reference/scope` don't exist yet (their content ships in later phase-10 plans, 10-05+) -- an honest, expected result for a build that has no docs content yet, not a defect in this plan's tooling. `landing` and `not-found` both captured cleanly with zero violations.

## Task Commits

1. **Task 1: Site review paths and the static-server helpers (tested)** — `b35f270` (test, RED) → `74655de` (feat, GREEN)
2. **Task 2: Capture script and the ui:review:site command** — `35b0f12` (feat)

## Files Created/Modified

- `scripts/ui/static-site-server.ts` — `resolveStaticPath`, `isThirdPartyRequest`, `startStaticSiteServer`
- `scripts/ui/review-paths.ts` — appended `SITE_REVIEW_ROOT`, `SITE_PAGES`, `SiteSurface`, `siteReviewPngPath`
- `scripts/ui/capture-site-review.ts` — the capture matrix, third-party/console-error violation tracking, exit-1-on-violation
- `tests/unit/ui/site-review.test.ts` — 19 tests (SITE_PAGES order, SITE_REVIEW_ROOT/siteReviewPngPath, resolveStaticPath incl. traversal rejection, isThirdPartyRequest incl. data:/blob:)
- `package.json` — `"ui:review:site": "tsx --tsconfig scripts/ui/tsconfig.json scripts/ui/capture-site-review.ts"`

## Decisions Made

See `key-decisions` in frontmatter: the `not-found` surface's own expected Chromium console message is exempted from the D-16 console-error check by exact message pattern, scoped to that one surface only.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] Chromium's own "Failed to load resource: 404" console message would have always failed the run's designed 404 capture**
- **Found during:** Task 2, first real run of `pnpm ui:review:site` against a fresh build
- **Issue:** `SITE_PAGES` deliberately includes `not-found` (`/this-page-does-not-exist`), a path meant to return the site's 404 page. Chromium logs a generic `Failed to load resource: the server responded with a status of 404 (Not Found)` console message whenever any resource -- including the top-level document itself -- resolves with a non-2xx status. The script's `page.on('console')` listener as first written would treat this as a console-error violation on literally every run, making the intentionally-404 surface permanently fail the capture it exists to produce.
- **Fix:** Added `RESOURCE_LOAD_FAILURE_PATTERN` and exempted exactly that message, and only on the `not-found` surface, from the violation list. Every other surface (including the docs pages, which currently also 404 because their content doesn't exist yet) still records and fails on the identical message -- a real 404 anywhere else is still a real finding.
- **Files modified:** `scripts/ui/capture-site-review.ts`
- **Commit:** `35b0f12` (folded into Task 2's single commit; caught before that commit, not a separate fix commit)

## Issues Encountered

- Running the full capture matrix against the current `apps/site/out` build (10-01's landing-only scaffold; docs content not yet built) reports 32 console-error violations, all `docs-*` surfaces at 404, because `apps/site/content`'s docs pages don't exist until later phase-10 plans (10-05 onward per `10-CONTEXT.md`'s D-08 sidebar groups). This is expected given plan sequencing and is not something this plan's tooling should paper over -- `pnpm ui:review:site` will pass cleanly once those pages exist. Not logged as a deviation (no plan or acceptance criterion of 10-04 required the full matrix to pass today; the plan's own verification is `pnpm vitest run tests/unit/ui` + `pnpm typecheck`, both green).

## Next Phase Readiness

- `pnpm ui:review:site` is ready for 10-11/10-12 to run once the site's landing content and all four representative docs pages exist -- no further tooling changes expected from those plans.
- Confirmed zero third-party requests across all 50 real captures this run produced (D-16's own runtime proof mechanism verified working, not just unit-tested).
- Full repo `pnpm vitest run` (3113/3113, +14 from this plan), `pnpm lint`, `pnpm typecheck`, `pnpm boundaries` all green after this plan -- no regressions.

## Self-Check: PASSED

- `scripts/ui/static-site-server.ts` — FOUND
- `scripts/ui/capture-site-review.ts` — FOUND
- `tests/unit/ui/site-review.test.ts` — FOUND
- Commit `b35f270` — FOUND
- Commit `74655de` — FOUND
- Commit `35b0f12` — FOUND
- `pnpm vitest run tests/unit/ui` — 46/46 pass
- `pnpm typecheck` — exit 0 (includes `tsc -p scripts/ui/tsconfig.json`)
- `pnpm vitest run` (full repo) — 3113/3113 pass
- `pnpm lint` / `pnpm boundaries` — exit 0
- `pnpm ui:review:site` run against a real `pnpm --filter @noodara/site build` — 50 captures written, zero third-party requests, 0 violations on `landing`/`not-found`; 32 expected violations on not-yet-built docs pages (see Issues Encountered)

---
*Phase: 10-sitio-de-docs-y-landing-pública*
*Completed: 2026-09-27*
