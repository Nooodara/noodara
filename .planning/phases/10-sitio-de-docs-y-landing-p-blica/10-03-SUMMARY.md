---
phase: 10-sitio-de-docs-y-landing-p-blica
plan: 03
subsystem: infra
tags: [github-actions, github-pages, ci, workflow-pins, static-export]

requires:
  - phase: 10-01
    provides: "@noodara/site workspace with output: 'export', apps/site/site-config.mjs's CNAME-gated basePath, apps/site/public/CNAME committed"
provides:
  - ".github/workflows/public-site.yml: SHA-pinned, least-privilege GitHub Pages publish workflow (push to main + workflow_dispatch, build+deploy jobs, no configure-pages step)"
  - "ci.yml site job: builds apps/site and runs tests/unit/docs + tests/unit/site on every pull request"
  - "tests/unit/scripts/check-workflow-pins.test.ts: 20 new structural assertions proving the pins/permissions/triggers/isolation shape holds against the real files on disk"
  - "apps/site/README.md: develop/domain-basePath/publishing/DNS/analytics/content-rules notes for the operator"
  - "ROADMAP.md + REQUIREMENTS.md record D-09: Phase 13 adds 'Your first deploy' and reopens DOCS-01"
affects: [10-04, 10-05, 10-06, 10-07, 10-08, 10-09, 10-10, 10-11, 10-12, 13]

tech-stack:
  added: []
  patterns:
    - "Pages publish workflow kept fully separate from release.yml: own token scopes (pages:write/id-token:write vs. packages:write), own trigger (push to main vs. version tag), no shared job, asserted by a dedicated 'never mention the site' test against release.yml and both docker-compose files"
    - "check-workflow-pins.test.ts job-block regex reused, not reinvented, for the new public-site.yml/ci.yml assertions -- same extractJobsSection/extractJobBlock shape as the existing release.yml describe block, with a leading-\\n fix so the very first job in a jobs: section also matches"

key-files:
  created:
    - .github/workflows/public-site.yml
    - apps/site/README.md
  modified:
    - .github/workflows/ci.yml
    - tests/unit/scripts/check-workflow-pins.test.ts
    - .planning/ROADMAP.md
    - .planning/REQUIREMENTS.md

key-decisions:
  - "No actions/configure-pages step, per the plan's own <interfaces> block: apps/site/site-config.mjs already computes basePath from public/CNAME at build time (10-01), so a separate Pages-configuration action has nothing left to resolve -- confirmed against 10-RESEARCH.md's Pattern 5, which the plan explicitly overrides on this one point"
  - "public-site.yml's build job checks out with fetch-depth: 0 for the same reason ci.yml's site job does: apps/site/site-config.mjs's describeLatestTag() reads the latest v* git tag for the footer version (D-06), and both the PR-gate build and the real publish must exercise the same code path"

requirements-completed: [SITE-02, DOCS-01]

duration: 9min
completed: 2026-09-27
---

# Phase 10 Plan 03: CI wiring for the public site (Pages publish + PR gate) Summary

**SHA-pinned, least-privilege `public-site.yml` publishes `apps/site/out` to GitHub Pages on every push to main via upload-pages-artifact/deploy-pages (no configure-pages, no gh-pages branch), and a new `site` job in `ci.yml` builds the site and runs its docs/site tests on every pull request -- both proven isolated from `release.yml`/`docker-compose*.yml` by 20 new structural tests written RED-first.**

## Performance

- **Duration:** 9 min
- **Started:** 2026-09-27T23:14:00-06:00
- **Completed:** 2026-09-27T23:23:00-06:00
- **Tasks:** 2 completed
- **Files modified:** 6 (2 created, 4 modified)

## Accomplishments

- `.github/workflows/public-site.yml` publishes on every push to `main` (plus manual `workflow_dispatch`), with a top-level `permissions: {}`, `build` scoped to `contents: read` only, `deploy` scoped to `pages: write`/`id-token: write` only inside the `github-pages` environment, `concurrency: group: pages` with `cancel-in-progress: false`, no `pull_request` trigger and no path filter (D-13: captures/tokens/copy outside `apps/site` also affect the published site).
- `ci.yml` gained a `site` job (after `boundaries`) that builds `apps/site` with the real, CNAME-present production shape and runs `pnpm exec vitest run tests/unit/docs tests/unit/site` on every PR -- the site's own merge gate, distinct from the publish workflow.
- 20 new assertions in `tests/unit/scripts/check-workflow-pins.test.ts` (a `describe('public site workflows (D-12/D-13, structural)')` block reusing the existing job-block regex helpers) prove the pin/permission/trigger/concurrency/isolation shape against the real files on disk -- written and run RED (both target files missing/incomplete) before either workflow file existed.
- `apps/site/README.md` (48 lines) documents Develop, Domain and base path, Publishing (including the one-time Settings -> Pages -> Source: GitHub Actions step), DNS (the four apex A records plus optional AAAA, `www` CNAME), Analytics (text-only note on where a future self-hosted script would go), and the forbidden-words/screenshot-source content rules.
- `.planning/ROADMAP.md` and `.planning/REQUIREMENTS.md` record D-09: Phase 10 ships "Your first server"; Phase 13 adds `first-deploy.mdx` and reopens DOCS-01 on close.

## Task Commits

1. **Task 1: Structural workflow tests (RED), then public-site.yml and the ci.yml site job (GREEN)** — `ed83058` (test, RED) → `eea74bf` (feat, GREEN)
2. **Task 2: Publishing notes (DNS, Pages settings, analytics placement) and the D-09 roadmap note** — `5385b95` (docs)

## Files Created/Modified

- `.github/workflows/public-site.yml` — `Publish site` workflow: `build` job (checkout fetch-depth 0, pnpm install, `pnpm --filter @noodara/site build`, upload-pages-artifact `path: apps/site/out`) → `deploy` job (deploy-pages, `environment: github-pages`)
- `.github/workflows/ci.yml` — new `site` job (build + `vitest run tests/unit/docs tests/unit/site`); header comment now names the site gate
- `tests/unit/scripts/check-workflow-pins.test.ts` — new `describe` block, 20 assertions, plus a leading-`\n` fix to `extractJobsSection` so the first job in a `jobs:` section is matched by `extractJobBlock`
- `apps/site/README.md` — Develop, Domain and base path, Publishing, DNS, Analytics, Rules
- `.planning/ROADMAP.md` — Phase 10 D-09 note under the goal; Phase 13 "Docs (D-09 de la Fase 10)" note before its `Plans: TBD` line
- `.planning/REQUIREMENTS.md` — DOCS-01 line appended with the D-09 reopening note

## Decisions Made

See `key-decisions` in frontmatter: no `configure-pages` step (site computes its own basePath already), and `fetch-depth: 0` on both the publish workflow's build job and ci.yml's site job (footer version reads the latest git tag).

## Deviations from Plan

None - plan executed exactly as written. (While writing the new test block, an off-by-one in the job-block regex helper — the extracted `jobsSection` lacked the leading `\n` the `extractJobBlock` pattern needs to match a section's first job — and a header comment that accidentally repeated the literal string an acceptance-criteria grep proves absent were both caught and fixed during this same task's own RED/GREEN cycle, before any commit; neither reached a commit in a broken state, so neither is logged as a deviation.)

## Issues Encountered

None.

## User Setup Required

**External service requires manual, one-time configuration** (documented in `apps/site/README.md`, per the plan's `user_setup` frontmatter — GitHub Pages source and custom domain, plus the operator's own DNS provider). No code or CI step can perform these:

- GitHub repo -> Settings -> Pages -> Build and deployment -> Source: **GitHub Actions**
- GitHub repo -> Settings -> Pages -> Custom domain: `noodara.com`, then **Enforce HTTPS** once DNS resolves
- DNS provider for `noodara.com`: apex A records `185.199.108.153`/`.109.153`/`.110.153`/`.111.153` (optional AAAA `2606:50c0:8000::153`…`8003::153`), `www` CNAME to `nooodara.github.io.` (verify these IPs are still current at docs.github.com/pages first)

## Next Phase Readiness

- `public-site.yml` and the `ci.yml` site job are both structurally verified and can run for real once this repository is pushed to GitHub (same "cannot execute until a remote exists" limitation `release.yml`'s own header already documents) and the Pages/DNS setup above is done.
- `pnpm --filter @noodara/site build` was run directly as a smoke test: exits 0, all routes static (`○`), confirming the workflow's own build step is exercising a real, working command.
- `apps/site/README.md` gives the next capture/content plans (10-04+) a stable place to point an operator at for publishing questions; no README changes expected from those plans.
- Full repo `pnpm test` (3099/3099), `pnpm lint`, `pnpm typecheck`, `pnpm boundaries` all green after this plan -- no regressions.

## Self-Check: PASSED

- `.github/workflows/public-site.yml` — FOUND
- `apps/site/README.md` — FOUND
- Commit `ed83058` — FOUND
- Commit `eea74bf` — FOUND
- Commit `5385b95` — FOUND
- `pnpm vitest run tests/unit/scripts/check-workflow-pins.test.ts` — 33/33 pass
- `pnpm --filter @noodara/site build` — exits 0, all routes static
- `node scripts/check-workflow-pins.mjs` (all 4 workflow files) — clean
- `pnpm test` (full repo) — 3099/3099 pass
- `pnpm lint` / `pnpm typecheck` / `pnpm boundaries` — all exit 0
- Commit `72ffce4` (this SUMMARY.md itself) — FOUND, verified post-commit

---
*Phase: 10-sitio-de-docs-y-landing-pública*
*Completed: 2026-09-27*
