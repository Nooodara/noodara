---
phase: 10-sitio-de-docs-y-landing-p-blica
plan: 01
subsystem: infra
tags: [nextjs, static-export, turborepo, fumadocs, github-pages, supply-chain]

requires: []
provides:
  - "@noodara/site workspace package (Next 16 App Router, output: 'export'), excluded from the product build/dev"
  - "apps/site/site-config.mjs: pure, tested basePath/version/license resolution functions (D-06/D-11/D-12)"
  - "turbo public-site boundary tag + tests/unit/site/site-boundary.test.ts import/manifest scan (SITE-02)"
  - "fumadocs-core/fumadocs-ui/fumadocs-mdx/flexsearch/@types/mdx pinned, provenance-verified, ADR-recorded"
affects: [10-02, 10-03, 10-04, 10-05, 10-06, 10-07, 10-08, 10-09, 10-10, 10-11, 10-12]

tech-stack:
  added: ["fumadocs-core@16.15.15", "fumadocs-ui@16.15.15", "fumadocs-mdx@15.4.5", "flexsearch@0.8.212", "@types/mdx@2.0.14"]
  patterns:
    - "Build-time-only config module (site-config.mjs): no I/O in next.config.mjs itself, all fs/git reads funneled through pure, independently-testable functions"
    - "Turbo boundary enforcement split across two mechanisms (turbo tag deny + vitest manifest/import scan) when transitive-tag denial would also block an explicitly-allowed dependency, or when a legitimate root-level devDependency makes turbo's graph see a package as reachable from everywhere"

key-files:
  created:
    - apps/site/site-config.mjs
    - apps/site/package.json
    - apps/site/turbo.json
    - apps/site/tsconfig.json
    - apps/site/postcss.config.mjs
    - apps/site/next.config.mjs
    - apps/site/public/CNAME
    - tests/unit/site/site-config.test.ts
    - tests/unit/site/site-boundary.test.ts
    - .planning/phases/10-sitio-de-docs-y-landing-p-blica/deferred-items.md
  modified:
    - turbo.json
    - package.json
    - .gitignore
    - vitest.config.ts
    - pnpm-lock.yaml
    - scripts/check-package-provenance.mjs
    - docs/adr/0000-package-legitimacy-approvals.md
    - tests/unit/scripts/check-package-provenance.test.ts

key-decisions:
  - "ssh-adapter is deliberately absent from the public-site turbo boundary tag's deny list; the root package.json's own (unrelated, pre-existing) @noodara/ssh devDependency makes turbo boundaries treat @noodara/ssh as reachable from every workspace package, so ssh-adapter is enforced solely by site-boundary.test.ts's manifest/import scan, same treatment as @noodara/domain"
  - "normaliseRepoUrl() in check-package-provenance.mjs gained a github: shorthand-stripping branch, a real pre-existing bug this plan's own provenance run uncovered against fumadocs-core/fumadocs-ui/fumadocs-mdx's registry metadata"

requirements-completed: [DOCS-01, SITE-02]

duration: 12min
completed: 2026-09-27
---

# Phase 10 Plan 01: apps/site scaffold, build-time config, import boundary Summary

**Stood up the `@noodara/site` static-export workspace with pure, tested basePath/version/license resolution and a two-layer (turbo tag + vitest scan) import boundary, fixing a real supply-chain-check bug along the way.**

## Performance

- **Duration:** 12 min
- **Started:** 2026-09-27T22:39:23-06:00
- **Completed:** 2026-09-27T22:51:07-06:00
- **Tasks:** 3 completed
- **Files modified:** 16 (10 created, 8 modified across `feat`/`test`/`fix` commits, one file created twice-touched)

## Accomplishments

- `@noodara/site` exists as a real pnpm/turbo workspace member, installs from the lockfile, typechecks clean, and is excluded from `pnpm build`/`pnpm dev` (both now `--filter=!@noodara/site`) via two new `site:dev`/`site:build` scripts.
- The three build-time decisions that are easy to get wrong later — CNAME-gated `basePath` (D-12), git-tag-or-package.json version (D-06), and LICENSE-parsed license name (D-06) — are pure functions in `apps/site/site-config.mjs`, covered by 14 unit tests, and wired into `next.config.mjs` with zero hand-typed literals.
- SITE-02's import boundary is enforced end-to-end: a turbo `public-site` tag denies `@noodara/control-plane`/`@noodara/web`, and `tests/unit/site/site-boundary.test.ts` (13 tests) independently scans `apps/site`'s real files and `package.json` for any import of `@noodara/domain` or `@noodara/ssh`, both of which a turbo tag rule could not deny without collateral damage.
- Five new dependencies (fumadocs-core/ui/mdx, flexsearch, @types/mdx) are exact-pinned, pass `node scripts/check-package-provenance.mjs`, and are recorded in `docs/adr/0000-package-legitimacy-approvals.md`'s new "Phase 10 additions" section.
- Fixed a real, previously-latent bug in `scripts/check-package-provenance.mjs`'s `normaliseRepoUrl()`: it had no branch for npm's `github:owner/repo` registry shorthand, so it silently failed closed for three legitimate, slopcheck-approved packages the moment this plan tried to install them.

## Task Commits

1. **Task 1: Build-time site configuration module** — `b03fc6a` (test, RED) → `ef033fc` (feat, GREEN)
2. **Task 2: Scaffold @noodara/site, install pinned deps, wire the workspace** — `c80c77a` (test, RED, provenance bug) → `5f7e659` (fix, GREEN, provenance bug) → `a265439` (feat, scaffold + deps + ADR)
3. **Task 3: Site import boundary (turbo tag + manifest/import scan test)** — `ba5e0d9` (test, RED) → `237c39b` (feat, GREEN — turbo tag + test adjustment)

_Note: Task 2 surfaced an unplanned RED/GREEN cycle for the provenance-script bug, committed separately from the scaffold itself so the bugfix has its own atomic history._

## Files Created/Modified

- `apps/site/site-config.mjs` — pure `SITE_ORIGIN`/`PREVIEW_BASE_PATH`/`resolveBasePath`/`readCname`/`describeLatestTag`/`resolveSiteVersion`/`readLicenseName` exports
- `apps/site/package.json` — `@noodara/site`, `public-site` turbo tag, exact-pinned deps, no `start` script (static export has no server)
- `apps/site/next.config.mjs` — `output: 'export'`, CNAME-gated `basePath`/`assetPrefix`, four public `env` strings, no rewrites/headers/standalone
- `apps/site/turbo.json`, `apps/site/tsconfig.json`, `apps/site/postcss.config.mjs`, `apps/site/public/CNAME` — workspace scaffold mirroring `apps/web`'s shape
- `turbo.json` — `out/**` build output; new `boundaries.tags.public-site` (`deny`: `@noodara/control-plane`, `@noodara/web`)
- `package.json` — `build`/`dev` now `--filter=!@noodara/site`; added `site:dev`/`site:build`
- `.gitignore` — `apps/site/out/`, `apps/site/.source/`
- `vitest.config.ts` — `apps/site/src/**/*.test.tsx` added to the `dom` project
- `scripts/check-package-provenance.mjs` — five new `EXPECTED_PACKAGES` entries; `normaliseRepoUrl()` github: shorthand fix
- `docs/adr/0000-package-legitimacy-approvals.md` — "Phase 10 additions" section
- `tests/unit/site/site-config.test.ts` (14 tests), `tests/unit/site/site-boundary.test.ts` (13 tests) — new
- `tests/unit/scripts/check-package-provenance.test.ts` — 4 new `normaliseRepoUrl` tests

## Decisions Made

- **ssh-adapter excluded from the turbo `public-site` deny list, enforced by the vitest scan instead.** Adding `"ssh-adapter"` to `turbo.json`'s `public-site` deny list made `pnpm boundaries` fail for `@noodara/site` even though neither `apps/site/package.json` nor any file under `apps/site` references `@noodara/ssh` at all. Root cause: the monorepo root's own `package.json` has a legitimate, pre-existing `"@noodara/ssh": "workspace:*"` devDependency (needed so `tests/integration/ssh/tsconfig.json` — files outside any workspace package — can typecheck), and `turbo boundaries` treats that root-level dependency as reachable from every workspace package's own graph. Removing root's dependency to work around this was out of scope (would break an unrelated, pre-existing typecheck path). `site-boundary.test.ts` now has a dedicated test asserting no `apps/site` file ever references `@noodara/ssh`, giving the same guarantee without the turbo-level false positive; the reasoning is documented in the test file's own header comment.
- **fixed `normaliseRepoUrl()`'s `github:` shorthand gap rather than working around it per-package.** `npm view fumadocs-core@16.15.15 repository.url` (and the two other fumadocs packages) returns `github:fuma-nama/fumadocs`, a form `normaliseRepoUrl()` had never handled — it only stripped `git+`/`git://`/`https://`/`ssh://` prefixes. Rather than special-casing these three packages, the underlying function was fixed (RED test added first) so any future package with this registry metadata shape passes correctly too.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] `normaliseRepoUrl()` didn't strip npm's `github:` shorthand prefix**
- **Found during:** Task 2's verification step (`node scripts/check-package-provenance.mjs`)
- **Issue:** `fumadocs-core@16.15.15`, `fumadocs-ui@16.15.15` and `fumadocs-mdx@15.4.5` all resolve `repository.url` as `github:fuma-nama/fumadocs` on the npm registry — a shorthand form `normaliseRepoUrl()` had no branch for, so the gate failed closed for three legitimate, slopcheck-`[OK]` packages.
- **Fix:** Added a `url.replace(/^github:/, '')` branch to `normaliseRepoUrl()`, following the existing pattern of the other prefix-stripping branches.
- **Files modified:** `scripts/check-package-provenance.mjs`, `tests/unit/scripts/check-package-provenance.test.ts` (4 new tests, RED-first)
- **Verification:** `pnpm vitest run tests/unit/scripts/check-package-provenance.test.ts` (7/7 pass); `node scripts/check-package-provenance.mjs` now reports `Coverage: 60/60 locked direct dependencies verified.` and exits 0.
- **Commits:** `c80c77a` (RED) → `5f7e659` (GREEN)

**2. [Rule 3 - Blocking issue] turbo `public-site` deny list's `ssh-adapter` entry broke `pnpm boundaries`**
- **Found during:** Task 3's verification step (`pnpm boundaries`)
- **Issue:** Per the plan's exact spec, `"public-site": { "dependencies": { "deny": ["@noodara/control-plane", "@noodara/web", "ssh-adapter"] } }` made `turbo boundaries` report `Package @noodara/ssh found with tag listed in denylist for @noodara/site: ssh-adapter` — even though `apps/site` has no actual dependency edge (direct or transitive) to `@noodara/ssh` (confirmed via `pnpm --filter @noodara/site why @noodara/ssh` returning nothing, and via a clean node_modules symlink check). Root cause traced (see "Decisions Made" above) to the monorepo root's own `@noodara/ssh` devDependency being treated as reachable from every package by turbo's boundaries graph.
- **Fix:** Removed `"ssh-adapter"` from the turbo `public-site` deny list; added a dedicated `site-boundary.test.ts` assertion (`no file under apps/site imports @noodara/ssh`) plus a detailed header-comment explanation so a future reader doesn't re-add the turbo entry and reintroduce the false positive.
- **Files modified:** `turbo.json`, `tests/unit/site/site-boundary.test.ts`
- **Verification:** `pnpm boundaries` exits 0 (`Checked 747 files in 7 packages, no issues found`); `pnpm vitest run tests/unit/site/site-boundary.test.ts` (13/13 pass).
- **Commit:** `237c39b`

## Known Stubs

None — this plan ships no UI, only build-time config, workspace scaffolding, and tests.

## Threat Flags

None — every new dependency (fumadocs-core/ui/mdx, flexsearch, @types/mdx) is in the plan's own threat model (T-10-SC) and provenance-verified; the boundary work directly implements T-10-09's mitigation; no new network endpoint, auth path, or schema change was introduced.

## Deferred / Out of Scope

- `tests/unit/ui/approval-record.test.ts`'s "exactly 3 `| Gate |` rows" assertion fails on a clean `pnpm test` run at the start of this plan (`docs/ui/APPROVAL.md` already has 4 rows from Phase 8/9 approvals, pre-dating this plan). Not touched by 10-01; logged to `.planning/phases/10-sitio-de-docs-y-landing-p-blica/deferred-items.md` per the scope-boundary rule rather than fixed here.

## Self-Check: PASSED

- `apps/site/site-config.mjs` — FOUND
- `apps/site/package.json` — FOUND
- `apps/site/next.config.mjs` — FOUND
- `apps/site/public/CNAME` — FOUND (`noodara.com`)
- `tests/unit/site/site-config.test.ts` — FOUND
- `tests/unit/site/site-boundary.test.ts` — FOUND
- `docs/adr/0000-package-legitimacy-approvals.md` "Phase 10 additions" — FOUND
- Commit `b03fc6a` — FOUND
- Commit `ef033fc` — FOUND
- Commit `c80c77a` — FOUND
- Commit `5f7e659` — FOUND
- Commit `a265439` — FOUND
- Commit `ba5e0d9` — FOUND
- Commit `237c39b` — FOUND
- `pnpm vitest run tests/unit/site` — 27/27 pass
- `pnpm boundaries` — exits 0
- `pnpm --filter @noodara/site typecheck` — exits 0
- `pnpm lint` (all 7 packages incl. `@noodara/site`) — exits 0
- `node scripts/check-package-provenance.mjs` — 60/60 verified, exits 0
