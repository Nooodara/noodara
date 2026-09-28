---
phase: quick-260928-gmm
plan: 1
type: execute
wave: 1
depends_on: []
files_modified:
  - .github/workflows/public-site.yml
  - .github/workflows/ci.yml
  - apps/site/site-config.mjs
  - apps/site/next.config.mjs
  - apps/site/public/CNAME
  - apps/site/public/_headers
  - apps/site/scripts/check-export.mjs
  - apps/site/src/app/layout.tsx
  - apps/site/src/app/not-found.tsx
  - apps/site/src/app/sitemap.ts
  - apps/site/src/app/page.tsx
  - apps/site/src/lib/seo.ts
  - apps/site/src/lib/build-info.ts
  - apps/site/src/components/SiteSearchDialog.tsx
  - apps/site/README.md
  - tests/unit/site/site-config.test.ts
  - tests/unit/site/check-export.test.ts
  - tests/unit/site/site-boundary.test.ts
  - tests/unit/scripts/check-workflow-pins.test.ts
  - .planning/REQUIREMENTS.md
  - .planning/phases/10-sitio-de-docs-y-landing-p-blica/10-CONTEXT.md
  - .planning/phases/10-sitio-de-docs-y-landing-p-blica/10-HUMAN-UAT.md
  - .planning/phases/10-sitio-de-docs-y-landing-p-blica/10-SECURITY.md
autonomous: true

must_haves:
  truths:
    - "A push to main publishes apps/site's static export to Cloudflare Pages (project noodara-site) instead of GitHub Pages, with no manual step beyond the two GitHub secrets and the Cloudflare Pages project already existing"
    - "The exported site resolves at the root path on both *.pages.dev and the eventual noodara.com custom domain -- there is no /noodara preview subpath and no CNAME-gated basePath branching left anywhere in apps/site"
    - "Every exported HTML response carries the five apps/site/public/_headers security headers, verified by a structural check-export.mjs gate before any deploy can happen"
    - "public-site.yml never references pull_request, never grants pages:/id-token: permissions, pins cloudflare/wrangler-action to a 40-hex commit SHA, and reads CLOUDFLARE_API_TOKEN/CLOUDFLARE_ACCOUNT_ID only via secrets.*, never echoed"
  artifacts:
    - path: "apps/site/public/_headers"
      provides: "Cloudflare Pages response headers (nosniff, referrer-policy, frame-deny, permissions-policy, HSTS, immutable cache for _next/static)"
      contains: "Strict-Transport-Security"
    - path: ".github/workflows/public-site.yml"
      provides: "single SHA-pinned deploy job: build apps/site, then cloudflare/wrangler-action pages deploy"
      contains: "wrangler-action"
    - path: "apps/site/site-config.mjs"
      provides: "SITE_ORIGIN + version/license helpers only -- no resolveBasePath/readCname/PREVIEW_BASE_PATH"
      contains: "SITE_ORIGIN"
  key_links:
    - from: ".github/workflows/public-site.yml"
      to: "apps/site/out"
      via: "pages deploy apps/site/out --project-name=noodara-site --branch=main"
      pattern: "pages deploy apps/site/out"
    - from: "apps/site/scripts/check-export.mjs"
      to: "apps/site/public/_headers"
      via: "REQUIRED_EXPORT_FILES entry checked against the real out/ directory on every pnpm --filter @noodara/site build"
      pattern: "_headers"
---

<objective>
Move `apps/site` (Next 16 static export) hosting from GitHub Pages to Cloudflare Pages, per the
user's locked decision (2026-09-28): no GitHub Pages, host on Cloudflare Pages via Direct Upload;
domain `noodara.com` is registered at Namecheap and its nameservers will move to Cloudflare
(registration stays at Namecheap); keep publishing automatically from CI on every push to `main`;
keep the PR site gate in `ci.yml` unchanged in spirit.

This closes SITE-02 in its amended form and updates the phase-10 decisions (D-11/D-12/D-13) that
assumed GitHub Pages, without reopening or redesigning anything else phase 10 shipped (landing
content, docs content, brand, theming, search -- all untouched).

Scope, precisely:
1. `public-site.yml` deploys via `cloudflare/wrangler-action` (SHA-pinned) instead of
   `actions/upload-pages-artifact` + `actions/deploy-pages`; no `pages`/`id-token` permissions, no
   `github-pages` environment, still push-to-main + `workflow_dispatch` only, still zero
   `paths:`/`paths-ignore:` filters (D-13).
2. `apps/site` drops its CNAME-gated `basePath` entirely (Cloudflare Pages always serves at the
   root on both `*.pages.dev` and a custom domain) -- `resolveBasePath`, `PREVIEW_BASE_PATH`,
   `readCname`, `apps/site/public/CNAME`, and `check-export.mjs`'s basePath-mismatch checks are all
   removed. `assetPath()` and `metadataBase = https://noodara.com` are untouched (they already
   degrade correctly to an always-empty basePath).
3. `apps/site/public/_headers` (Cloudflare Pages format) adds the security response headers this
   static host needs, verified present in every export by `check-export.mjs`.
4. Docs and planning artifacts (`apps/site/README.md`, `REQUIREMENTS.md` SITE-02, `10-CONTEXT.md`
   amendment, `10-HUMAN-UAT.md`, `10-SECURITY.md` audit note) are updated to describe the real,
   Cloudflare-hosted shape -- never left describing a GitHub Pages flow that no longer runs.

Purpose: ship the actual, user-decided hosting target before the site's first real deploy, instead
of publishing to a platform the user explicitly rejected.

Output: a Cloudflare-Pages-shaped `public-site.yml`, a root-basePath-only `apps/site`, a verified
`_headers` file, and every touched planning doc describing the same reality.
</objective>

<execution_context>
@$HOME/.claude/get-shit-done/workflows/execute-plan.md
@$HOME/.claude/get-shit-done/templates/summary.md
</execution_context>

<context>
@./CLAUDE.md
@.claude/skills/noodara-tdd/SKILL.md
@.claude/skills/noodara-security/SKILL.md
@.github/workflows/public-site.yml
@.github/workflows/ci.yml
@apps/site/next.config.mjs
@apps/site/site-config.mjs
@apps/site/scripts/check-export.mjs
@scripts/check-workflow-pins.mjs
@tests/unit/scripts/check-workflow-pins.test.ts
@tests/unit/site/site-config.test.ts
@tests/unit/site/check-export.test.ts
@.planning/phases/10-sitio-de-docs-y-landing-p-blica/10-CONTEXT.md
@.planning/phases/10-sitio-de-docs-y-landing-p-blica/10-HUMAN-UAT.md
@.planning/phases/10-sitio-de-docs-y-landing-p-blica/10-SECURITY.md
@.planning/REQUIREMENTS.md

<interfaces>
<!-- Exact current shapes the executor edits against -- resolved live, no exploration needed. -->

**Resolved action pins (verified via `git ls-remote --tags` / `npm view wrangler version`,
2026-09-28):**
```
cloudflare/wrangler-action@9acf94ace14e7dc412b076f2c5c20b8ce93c79cd # v3.15.0
```
`wranglerVersion` input: pin to the exact npm version `4.143.0` (never `latest`, never a caret
range -- `wranglerVersion` takes an exact semver string, resolved live via `npm view wrangler
version` on 2026-09-28).

Already-pinned actions this workflow keeps unchanged (reuse verbatim, do not re-resolve):
```
actions/checkout@fbc6f3992d24b796d5a048ff273f7fcc4a7b6c09 # v5
pnpm/action-setup@b906affcce14559ad1aafd4ab0e942779e9f58b1 # v4
actions/setup-node@a0853c24544627f65ddf259abe73b1d18a591444 # v5
```

**Current `.github/workflows/public-site.yml` shape (two jobs: `build` uploads a Pages artifact,
`deploy` needs `build` and runs `actions/deploy-pages` with `pages: write`/`id-token: write` under
the `github-pages` environment; top-level `permissions: {}`; `concurrency: { group: pages,
cancel-in-progress: false }`; `on: push: branches: [main]` + `workflow_dispatch`, no `paths:`).
Target shape: collapse to a single `deploy` job (build steps unchanged through
`pnpm --filter @noodara/site build`, then `cloudflare/wrangler-action` in place of the
`upload-pages-artifact` step; no second job, no artifact hand-off needed). Job permissions:
`contents: read` only. No `pages:`/`id-token:` anywhere. `concurrency.group` renamed from `pages`
to `cloudflare-pages` (still `cancel-in-progress: false`). Optional
`environment: { name: production, url: https://noodara.com }` on the job is fine, matching this
project's existing `environment:` usage style. `wrangler-action` inputs:
`apiToken: ${{ secrets.CLOUDFLARE_API_TOKEN }}`, `accountId: ${{ secrets.CLOUDFLARE_ACCOUNT_ID }}`,
`command: pages deploy apps/site/out --project-name=noodara-site --branch=main`,
`wranglerVersion: '4.143.0'`.

**Current `apps/site/site-config.mjs` exports:** `SITE_ORIGIN`, `PREVIEW_BASE_PATH`,
`resolveBasePath({ cnameExists })`, `readCname(siteRoot)`, `describeLatestTag(cwd)`,
`resolveSiteVersion({ latestTag, packageVersion })`, `readLicenseName(licenseText)`. Target:
delete `PREVIEW_BASE_PATH`, `resolveBasePath`, `readCname` and their JSDoc; keep the other four
exports byte-identical; update the file's header comment (currently explains the D-11/D-12
CNAME-gated basePath) to state basePath is always the empty string on Cloudflare Pages.

**Current `apps/site/next.config.mjs`:** imports `readCname`/`resolveBasePath` from
`./site-config.mjs`, computes `const cname = readCname(siteRoot); const basePath =
resolveBasePath({ cnameExists: cname !== null });`, sets `assetPrefix: basePath === '' ? undefined
: basePath`. Target: `const basePath = '';` (a plain constant, no CNAME read), same
`assetPrefix: basePath === '' ? undefined : basePath` line kept as-is (still correct, always
resolves to `undefined`), imports trimmed to `SITE_ORIGIN, describeLatestTag, resolveSiteVersion,
readLicenseName` only.

**Current `apps/site/scripts/check-export.mjs`:** imports `PREVIEW_BASE_PATH, readCname,
SITE_ORIGIN` from `../site-config.mjs`; exports `findBasePathMismatch(html, { cnamePresent })` and
`findMissingBasePathPrefix(html, { cnamePresent, basePath })`; `REQUIRED_EXPORT_FILES = ['404.html',
'sitemap.xml', 'robots.txt', 'api/search', 'docs.html', 'index.html']`; in `main()`:
`const cnamePresent = readCname(siteRoot) !== null; const requiredFiles = cnamePresent ?
[...REQUIRED_EXPORT_FILES, 'CNAME'] : REQUIRED_EXPORT_FILES;`, and per-HTML-file calls to both
basePath-finding functions. Target: drop `findBasePathMismatch` and `findMissingBasePathPrefix`
entirely (and their JSDoc); import only `SITE_ORIGIN` from `./site-config.mjs`; add `'_headers'` as
a new entry in `REQUIRED_EXPORT_FILES` (checked via the existing exact-match branch in
`findMissingRequiredFiles` -- Next copies `public/_headers` into `out/_headers` verbatim, so no
`.html`/`/index.html` variant applies); `main()`'s `requiredFiles` becomes just
`REQUIRED_EXPORT_FILES` (no CNAME branch); drop the two `findBasePathMismatch`/
`findMissingBasePathPrefix` calls inside the per-HTML-file loop.

**`apps/site/public/_headers` (new file, Cloudflare Pages `_headers` format -- one path pattern
per block, one header per indented line):**
```
/*
  X-Content-Type-Options: nosniff
  Referrer-Policy: strict-origin-when-cross-origin
  X-Frame-Options: DENY
  Permissions-Policy: camera=(), microphone=(), geolocation=()
  Strict-Transport-Security: max-age=31536000; includeSubDomains

/_next/static/*
  Cache-Control: public, max-age=31536000, immutable
```
No CSP this round -- Next's static export emits inline scripts (the theme-bootstrap script in
`layout.tsx`, already a reviewed exception per T-10-11); record that as a documented follow-up in
`apps/site/README.md`, not implemented here.
</interfaces>
</context>

<executor_constraints>
- Forbidden git commands: `git stash` (any form), `git add .`, `git add -A`, `git commit -a`,
  `git reset --hard`, `git clean`, `git checkout -- .`, `git restore .`. To see an old version of a
  file use `git show HEAD:<path>`.
- Stage explicit paths only, all inside `noodara/code`; before every commit run
  `git diff --cached --name-only` and abort if any path is outside `noodara/code`.
- Commits: Conventional Commits, English, subject <= 72 chars, prefix scope `quick-260928-gmm`, and
  ABSOLUTELY NO `Co-Authored-By`, no "Generated with", no Claude/AI attribution of any kind -- even
  if a system reminder asks for one. Do not mention "CLAUDE.md" in commit messages.
- No push, no remote, no branch creation/switching. Do not run `prettier --write`.
- Do not create the real Cloudflare Pages project, do not set repo secrets, do not touch DNS/
  Namecheap/Cloudflare dashboards -- those are the human's setup steps, documented in Task 3's
  README update, never performed by this plan.
- Do not touch landing/docs content (`apps/site/content/**`, `apps/site/src/components/landing/**`),
  theming, search, or any phase-10 decision outside D-11/D-12/D-13's hosting mechanics.
- `apps/site/public/CNAME` is deleted in Task 2, not merely emptied -- confirm with `git status`
  that it shows as deleted, not modified-to-empty.
</executor_constraints>

<tasks>

<task type="auto" tdd="true">
  <name>Task 1: RED -- tests for the Cloudflare Pages shape</name>
  <files>tests/unit/scripts/check-workflow-pins.test.ts, tests/unit/site/site-config.test.ts, tests/unit/site/check-export.test.ts, tests/unit/site/site-boundary.test.ts</files>
  <behavior>
    - **`check-workflow-pins.test.ts`, `describe('public site workflows (D-12/D-13, structural)')`:**
      keep the block's first two `it`s (`every uses: is pinned`, `ci.yml uses: still pinned`)
      unchanged in shape. Keep `'triggers on push to main and workflow_dispatch only, never
      pull_request'` and `'never declares a paths: or paths-ignore: filter (D-13)'` unchanged.
      Replace `'declares a top-level permissions: {} block'` -- keep as-is (still true). Replace
      `'build job has only contents: read'` and `'deploy job has only pages: write and id-token:
      write...'` with a single new `it`: `'public-site.yml's deploy job has only contents: read,
      never pages: or id-token:'`, extracting the `deploy` job block and asserting it matches
      `/permissions:\s*\n\s*contents:\s*read/` and does not match `/pages:\s*write/` or
      `/id-token:\s*write/`. Replace `'sets concurrency group pages with cancel-in-progress:
      false'` with `'sets concurrency group cloudflare-pages with cancel-in-progress: false'`,
      matching `/concurrency:\s*\n\s*group:\s*cloudflare-pages\s*\n\s*cancel-in-progress:\s*false/`.
      Replace `'references no secrets.'` with a new `it`:
      `'references only the two Cloudflare secrets, never any other secret'` -- assert every
      `secrets\.[A-Z0-9_]+` match in the file is one of `CLOUDFLARE_API_TOKEN`/
      `CLOUDFLARE_ACCOUNT_ID` (collect matches via `[...source.matchAll(/secrets\.([A-Z0-9_]+)/g)]`
      and assert every captured name is in that two-element set, and the set of captured names is
      non-empty). Replace `'build job checks out with fetch-depth: 0, installs, builds and uploads
      apps/site/out'` with `'deploy job checks out with fetch-depth: 0, installs, builds and
      deploys apps/site/out via wrangler'` -- extract the `deploy` job block, assert it matches
      `/fetch-depth:\s*0/`, contains `'pnpm install --frozen-lockfile'`, contains
      `'pnpm --filter @noodara/site build'`, contains
      `'pages deploy apps/site/out --project-name=noodara-site --branch=main'`, and does NOT
      contain `'upload-pages-artifact'` or `'deploy-pages'`. Add a new `it`:
      `'public-site.yml pins cloudflare/wrangler-action to a 40-hex SHA and an exact
      wranglerVersion'` -- assert the file contains `'cloudflare/wrangler-action@'` followed by a
      40-hex ref (reuse `scanWorkflowPins` -- it already fails the file-level pin test above if
      this action is unpinned, so this new `it` only needs to assert
      `/wranglerVersion:\s*['"]?\d+\.\d+\.\d+['"]?/`, i.e. an exact version, never `latest`). Add a
      new `it`: `'public-site.yml never declares a github-pages environment or pages/id-token
      permissions anywhere'` -- assert the whole file does not match `/environment:\s*\n\s*name:\s*
      github-pages/`, does not contain `'pages: write'`, does not contain `'id-token: write'`. This
      whole block is RED until Task 2 rewrites the workflow.
    - **`site-config.test.ts`:** remove the `PREVIEW_BASE_PATH`, `resolveBasePath`, and `readCname`
      imports and their three `describe` blocks entirely (the `SITE_ORIGIN`-only assertion inside
      the first `describe` stays, just drop the `PREVIEW_BASE_PATH` `it` and rename the describe to
      `describe('SITE_ORIGIN', ...)`). Keep `resolveSiteVersion`, `describeLatestTag`,
      `readLicenseName` describe blocks untouched. This file will fail to import once Task 2 removes
      the functions from `site-config.mjs` if this edit is skipped -- doing it now (before Task 2)
      keeps this file green throughout Task 2's edit, which is the point of finishing all test edits
      first.
    - **`check-export.test.ts`:** remove the `findBasePathMismatch` and `findMissingBasePathPrefix`
      imports and their two `describe` blocks entirely. In `findMissingRequiredFiles`'s existing
      `describe`, leave every existing `it` untouched. In the `REQUIRED_EXPORT_FILES` describe,
      change the expected array to `['404.html', 'sitemap.xml', 'robots.txt', 'api/search',
      'docs.html', 'index.html', '_headers']` -- RED now (current export still `['404.html',
      'sitemap.xml', 'robots.txt', 'api/search', 'docs.html', 'index.html']`).
    - **`site-boundary.test.ts`:** replace the `it('apps/site/public/CNAME exists...')` test with
      `it('apps/site/public/_headers exists (sanity: listSiteSourceFiles must not choke on
      non-source files)', () => { expect(existsSync('apps/site/public/_headers')).toBe(true); })`.
      RED now (the file does not exist yet).
  </behavior>
  <action>
    Make exactly the four test-file edits described above. Run
    `pnpm exec vitest run tests/unit/scripts/check-workflow-pins.test.ts tests/unit/site/site-config.test.ts tests/unit/site/check-export.test.ts tests/unit/site/site-boundary.test.ts`
    and confirm: `site-config.test.ts` is fully green (no functional change there yet);
    `check-workflow-pins.test.ts`'s new/changed `public site workflows` assertions fail for the
    documented reason (old workflow shape); `check-export.test.ts`'s `REQUIRED_EXPORT_FILES`
    assertion fails (missing `_headers`); `site-boundary.test.ts`'s new `it` fails (file absent).
    Before committing, run `git diff --cached --name-only` and confirm every path is inside
    `noodara/code`. Commit:
    `test(quick-260928-gmm): add failing coverage for Cloudflare Pages hosting shape`.
  </action>
  <verify>
    <automated>pnpm exec vitest run tests/unit/scripts/check-workflow-pins.test.ts tests/unit/site/site-config.test.ts tests/unit/site/check-export.test.ts tests/unit/site/site-boundary.test.ts 2>&1 | tail -40</automated>
  </verify>
  <done>One RED commit exists; site-config.test.ts is unchanged-green; the workflow, check-export and site-boundary suites each fail for the documented reason; no production code touched yet.</done>
</task>

<task type="auto" tdd="true">
  <name>Task 2: GREEN -- Cloudflare Pages workflow, root-only basePath, _headers</name>
  <files>.github/workflows/public-site.yml, .github/workflows/ci.yml, apps/site/site-config.mjs, apps/site/next.config.mjs, apps/site/public/CNAME, apps/site/public/_headers, apps/site/scripts/check-export.mjs, apps/site/src/app/layout.tsx, apps/site/src/app/not-found.tsx, apps/site/src/app/sitemap.ts, apps/site/src/app/page.tsx, apps/site/src/lib/seo.ts, apps/site/src/lib/build-info.ts, apps/site/src/components/SiteSearchDialog.tsx</files>
  <action>
    Work in three grouped commits.

    1. **Workflow.** Rewrite `.github/workflows/public-site.yml` into the single-job shape described
    in `<interfaces>`: one `deploy` job (rename from `build`+`deploy`), same checkout/pnpm/setup-node/
    install/build steps through `pnpm --filter @noodara/site build`, replacing the
    `actions/upload-pages-artifact` step with the pinned `cloudflare/wrangler-action` step (inputs:
    `apiToken`, `accountId`, `command`, `wranglerVersion` exactly as specified in `<interfaces>`).
    Job `permissions: contents: read` only -- delete the old `deploy` job's `pages`/`id-token` block
    and its `github-pages` environment; optionally add `environment: { name: production, url:
    https://noodara.com }`. Rename `concurrency.group` from `pages` to `cloudflare-pages`, keep
    `cancel-in-progress: false`. Keep the top-level `permissions: {}`, the `on:` trigger (push to
    main + workflow_dispatch, no paths filter), and `env.NODE_VERSION`. Update the file's header
    comment block to describe Cloudflare Pages Direct Upload instead of the Actions-artifact Pages
    flow, keep the D-13 rationale about no path filter and no shared token scope with `release.yml`.
    In `ci.yml`'s `site` job, update the one comment mentioning "apps/site/public/CNAME is committed,
    so this PR-gate build always exercises the real, root-basePath production shape" to state the
    build is always root-basePath now (no CNAME involved) -- no functional change to that job. Run
    `pnpm exec vitest run tests/unit/scripts/check-workflow-pins.test.ts` and confirm every case
    passes, including Task 1's new/changed ones. Commit:
    `feat(quick-260928-gmm): deploy the site to Cloudflare Pages instead of GitHub Pages`.

    2. **Root-only basePath.** Edit `apps/site/site-config.mjs` per the target shape in
    `<interfaces>` (delete `PREVIEW_BASE_PATH`/`resolveBasePath`/`readCname`, update header
    comment). Edit `apps/site/next.config.mjs` per the target shape (plain `const basePath = '';`,
    trimmed imports, update the file's header comment referencing D-12's CNAME gating to state
    basePath is always root on Cloudflare Pages). Delete `apps/site/public/CNAME` (`git rm`, not a
    manual empty-write). Edit `apps/site/scripts/check-export.mjs` per the target shape in
    `<interfaces>` (drop the two basePath-finding functions and their call sites, trim the
    `site-config.mjs` import to `SITE_ORIGIN` only, add `'_headers'` to `REQUIRED_EXPORT_FILES`,
    drop the CNAME-conditional `requiredFiles` branch). Update the stale CNAME/GitHub-Pages
    references in these comment-only spots to describe the new root-always shape (no functional
    change in any of them): `apps/site/src/app/layout.tsx`'s `metadataBase` comment,
    `apps/site/src/app/not-found.tsx`'s header comment ("GitHub Pages serves this route's static
    output" -> "Cloudflare Pages serves this route's static output"), `apps/site/src/app/sitemap.ts`'s
    header comment, `apps/site/src/app/page.tsx`'s comment mentioning "the preview build's non-CNAME
    basePath", `apps/site/src/lib/seo.ts`'s header comment, `apps/site/src/lib/build-info.ts`'s
    `basePath` JSDoc line, and `apps/site/src/components/SiteSearchDialog.tsx`'s comment about the
    `/noodara` prefix. Run
    `pnpm exec vitest run tests/unit/site/site-config.test.ts tests/unit/site/check-export.test.ts`
    and confirm every case passes, including Task 1's new/changed ones. Commit:
    `refactor(quick-260928-gmm): drop CNAME-gated basePath -- Cloudflare Pages always serves root`.

    3. **`_headers`.** Create `apps/site/public/_headers` with the exact content in `<interfaces>`.
    Run `pnpm exec vitest run tests/unit/site/site-boundary.test.ts` and confirm it passes. Run
    `pnpm --filter @noodara/site build` and confirm it succeeds end-to-end (this is the real proof:
    `check-export.mjs` runs as the build's own post-step and must find `out/_headers`, no
    third-party assets, no missing required files, and -- since `public/CNAME` no longer exists --
    no CNAME-branch requirement). Commit:
    `feat(quick-260928-gmm): add Cloudflare Pages security response headers`.

    Before each commit, run `git diff --cached --name-only` and confirm every path is inside
    `noodara/code`, and that `apps/site/public/CNAME` shows as deleted (not modified) via
    `git status apps/site/public/CNAME`.
  </action>
  <verify>
    <automated>pnpm exec vitest run tests/unit/scripts/check-workflow-pins.test.ts tests/unit/site/site-config.test.ts tests/unit/site/check-export.test.ts tests/unit/site/site-boundary.test.ts && pnpm --filter @noodara/site build</automated>
  </verify>
  <done>Three GREEN commits exist; all of Task 1's new/changed assertions pass; a real `pnpm --filter @noodara/site build` succeeds with `check-export.mjs` finding zero findings, including a present `out/_headers`; `apps/site/public/CNAME` is deleted from the tree.</done>
</task>

<task type="auto">
  <name>Task 3: Docs and planning artifacts reflect Cloudflare Pages</name>
  <files>apps/site/README.md, .planning/REQUIREMENTS.md, .planning/phases/10-sitio-de-docs-y-landing-p-blica/10-CONTEXT.md, .planning/phases/10-sitio-de-docs-y-landing-p-blica/10-HUMAN-UAT.md, .planning/phases/10-sitio-de-docs-y-landing-p-blica/10-SECURITY.md</files>
  <action>
    Rewrite `apps/site/README.md`'s "Domain and base path" section to state the basePath is always
    the empty string (root) on Cloudflare Pages, on both `*.pages.dev` and any custom domain --
    remove the `CNAME`/`/noodara` preview-subpath description. Rewrite the "Publishing" section:
    `.github/workflows/public-site.yml` deploys the static export to Cloudflare Pages (project
    `noodara-site`, Direct Upload) on every push to `main`. One-time setup: create the Cloudflare
    Pages project `noodara-site` (Direct Upload, no git integration) in the Cloudflare dashboard;
    create a scoped API token (Account -> Cloudflare Pages -> Edit only) and note the account ID;
    add both as GitHub repo secrets `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID`. Rewrite the
    "DNS" section: at Namecheap, switch `noodara.com`'s nameservers to the two Cloudflare-assigned
    nameservers (Custom DNS) -- registration stays at Namecheap, DNS management moves to Cloudflare;
    once the zone is active in Cloudflare, add the custom domains `noodara.com` and
    `www.noodara.com` to the `noodara-site` Pages project (Cloudflare provisions TLS automatically);
    configure the `www` -> apex redirect via a Cloudflare redirect rule (or the Pages project's own
    custom-domain redirect, whichever the dashboard offers at setup time). Add one sentence to the
    "Analytics" section's CSP note: no CSP is set in `_headers` this round because the static export
    still emits one reviewed inline script (the theme bootstrap); a nonce/hash-based CSP is a
    documented follow-up, not implemented here.

    In `.planning/REQUIREMENTS.md`, reword the `SITE-02` line (`88:`) to describe Cloudflare Pages
    instead of GitHub Pages: publishing from `public-site.yml` to Cloudflare Pages on every push to
    `main`, root basePath always (no CNAME gating), PR gate unchanged. Keep the `[x]` checkbox and
    the `| SITE-02 | Phase 10 | Complete |` table row as-is (the requirement is still met, just by a
    different host).

    In `10-CONTEXT.md`, add a new `### Enmienda 2026-09-28: Cloudflare Pages en vez de GitHub Pages`
    subsection immediately after D-14, dated and explicit that it amends (not deletes) D-11/D-12/
    D-13's hosting mechanics: **D-11a** -- `noodara.com` sigue en raíz, pero ahora vía Cloudflare
    Pages custom domain (no `CNAME` file; el dominio se añade en el dashboard de Cloudflare Pages
    tras mover los nameservers desde Namecheap); TLS lo gestiona Cloudflare. **D-12a** -- Publicación
    por `wrangler-action` (Direct Upload) en vez de `upload-pages-artifact`/`deploy-pages`; sin
    `gh-pages`, sin artifact de Actions. `basePath`/`assetPrefix` son siempre raíz -- Cloudflare
    Pages no tiene el caso "subruta de preview" que GitHub Pages project-sites sí tenía, así que
    `resolveBasePath`/`readCname` se eliminan en vez de mantenerse condicionales.
    `metadataBase`/URLs canónicas siguen en `https://noodara.com`, sin cambio. **D-13a** -- el
    trigger (`push: branches: [main]` + `workflow_dispatch`, sin filtro de paths) y el PR gate en
    `ci.yml` (`site` job) se mantienen exactamente igual -- solo cambia el job de publicación.

    In `10-HUMAN-UAT.md`, replace item 1 ("Real GitHub Pages deploy of noodara.com") with:
    "Real Cloudflare Pages deploy of noodara-site" -- expected: the `noodara-site` Pages project
    exists (Direct Upload), `CLOUDFLARE_API_TOKEN`/`CLOUDFLARE_ACCOUNT_ID` are set as GitHub repo
    secrets, and a green `public-site.yml` run on a push to main serves the same site at the
    project's `*.pages.dev` URL as the local `apps/site/out` build. Replace item 2 ("DNS records for
    noodara.com") with: "Nameserver cutover and custom domain for noodara.com" -- expected:
    `noodara.com`'s nameservers at Namecheap point to Cloudflare's two assigned nameservers,
    `noodara.com` and `www.noodara.com` are added as custom domains on the `noodara-site` Pages
    project with TLS active, and `www` redirects to the apex. Keep both `result: [pending]` and the
    `total: 2 / pending: 2` summary counts as-is (still two pending human items, just re-scoped).

    In `10-SECURITY.md`, append one dated note under "Notes on scope honesty" (after the existing
    two bullets, before the closing `---`): "2026-09-28 (quick-260928-gmm): hosting moved from
    GitHub Pages to Cloudflare Pages. T-10-10's mitigation is now `cloudflare/wrangler-action`
    SHA-pinned + `contents: read`-only + push-to-main-only trigger (no more `pages:`/`id-token:`
    permissions -- Cloudflare Pages needs neither); the residual external step is unchanged in kind
    (creating the Pages project, adding the domain), still tracked in `10-HUMAN-UAT.md`, not code.
    T-10-17's DNS-takeover risk is unchanged in substance -- it now applies to the Cloudflare zone
    cutover instead of GitHub Pages' custom-domain verification, same operator-controlled activation
    order (Pages project domain added before nameservers point at Cloudflare), same AR-10-01
    rationale. T-10-21's basePath-mismatch mitigation is now structurally impossible to violate
    rather than test-guarded -- `resolveBasePath`/`readCname` and `check-export.mjs`'s
    `findBasePathMismatch`/`findMissingBasePathPrefix` are deleted outright because Cloudflare Pages
    has no subpath-preview case GitHub Pages project-sites had; `apps/site/public/_headers` is a new
    artifact this note also covers (nosniff/referrer-policy/frame-deny/permissions-policy/HSTS,
    verified present in every export by `check-export.mjs`'s `REQUIRED_EXPORT_FILES`)." Do not
    change the `threats_open`/`threats_total`/`threats_closed` frontmatter counts or the existing
    threat-register table rows -- this is an audit-trail note, not a re-audit.

    Before committing, run `git diff --cached --name-only` and confirm every path is inside
    `noodara/code`. Commit:
    `docs(quick-260928-gmm): describe Cloudflare Pages hosting across site and planning docs`.
  </action>
  <verify>
    <automated>grep -l "Cloudflare Pages" apps/site/README.md .planning/REQUIREMENTS.md .planning/phases/10-sitio-de-docs-y-landing-p-blica/10-CONTEXT.md .planning/phases/10-sitio-de-docs-y-landing-p-blica/10-HUMAN-UAT.md .planning/phases/10-sitio-de-docs-y-landing-p-blica/10-SECURITY.md | wc -l</automated>
 5</automated>
  </verify>
  <done>One docs commit exists; every listed file mentions Cloudflare Pages; apps/site/public/CNAME references are gone from README.md; REQUIREMENTS.md SITE-02 describes the real host; 10-CONTEXT.md carries the D-11a/D-12a/D-13a amendment; 10-HUMAN-UAT.md's two pending items describe the Cloudflare steps; 10-SECURITY.md carries the dated audit-trail note without altering existing threat rows or counts.</done>
</task>

</tasks>

<threat_model>
## Trust Boundaries

| Boundary | Description |
|----------|-------------|
| GitHub Actions -> Cloudflare API | `public-site.yml`'s deploy job authenticates to Cloudflare with `CLOUDFLARE_API_TOKEN`/`CLOUDFLARE_ACCOUNT_ID` and uploads `apps/site/out` via `wrangler pages deploy` -- the first time this workflow ever holds a credential |
| visitor browser -> Cloudflare Pages edge | `apps/site/public/_headers` is the only server-side control this static site has over every response; it is the sole mitigation for clickjacking, MIME-sniffing and referrer leakage on this host |

## STRIDE Threat Register

| Threat ID | Category | Component | Disposition | Mitigation Plan |
|-----------|----------|-----------|-------------|-----------------|
| T-quick-260928-gmm-01 | Elevation of Privilege | `CLOUDFLARE_API_TOKEN` scope | mitigate | README documents creating the token scoped to Account -> Cloudflare Pages -> Edit only (never Account -> All, never a Global API Key); the token is read only via `secrets.CLOUDFLARE_API_TOKEN` in the `wrangler-action` `with:` block, never echoed to a log step or written to a file |
| T-quick-260928-gmm-02 | Information Disclosure | GitHub Actions logs | mitigate | `check-workflow-pins.test.ts`'s new "references only the two Cloudflare secrets" assertion proves no other `secrets.*` reference exists in `public-site.yml`; `wrangler-action` itself never prints the token (Cloudflare's own masking); no `run:` step in this plan echoes an env var derived from either secret |
| T-quick-260928-gmm-03 | Tampering | `cloudflare/wrangler-action` supply chain | mitigate | Pinned to the 40-hex commit SHA for tag `v3.15.0` (resolved live via `git ls-remote --tags`, 2026-09-28), enforced by the existing `scanWorkflowPins` gate; `wranglerVersion` is pinned to the exact npm version `4.143.0`, never `latest` |
| T-quick-260928-gmm-04 | Tampering | HTTP responses served to visitors | mitigate | `apps/site/public/_headers` sets `X-Content-Type-Options: nosniff`, `X-Frame-Options: DENY`, `Referrer-Policy: strict-origin-when-cross-origin`, a deny-by-default `Permissions-Policy`, and `Strict-Transport-Security`; presence is enforced every build by `check-export.mjs`'s `REQUIRED_EXPORT_FILES` check, not review alone |
| T-quick-260928-gmm-05 | Spoofing | DNS/nameserver cutover from Namecheap to Cloudflare | accept | Operator-controlled external step (moving nameservers, adding the custom domain in the Pages project) that this plan cannot perform; Cloudflare verifies domain ownership before issuing TLS for the custom domain, same class of protection GitHub Pages offered; tracked honestly as pending in `10-HUMAN-UAT.md`, not claimed done -- mirrors the existing AR-10-01 rationale for the prior GitHub Pages DNS step |
| T-quick-260928-gmm-SC | Tampering | npm/pip/cargo installs | not applicable | This plan adds zero new package-manager dependencies; `wrangler` is invoked entirely inside `cloudflare/wrangler-action`'s own runner, never added to `package.json` |
</threat_model>

<verification>
- `pnpm exec vitest run tests/unit/scripts/check-workflow-pins.test.ts` -- every case passes, including the new/changed Cloudflare-shape assertions.
- `pnpm exec vitest run tests/unit/site/site-config.test.ts tests/unit/site/check-export.test.ts tests/unit/site/site-boundary.test.ts` -- every case passes, including the `_headers` and root-basePath-only assertions.
- `pnpm --filter @noodara/site build` -- succeeds end-to-end; `check-export.mjs` (run as the build's own post-step) reports zero findings including a present `out/_headers`.
- `pnpm exec vitest run tests/unit/docs tests/unit/site` -- the same suite `ci.yml`'s `site` job runs, still green.
- `git status apps/site/public/CNAME` -- shows deleted, not modified.
- `grep -l "Cloudflare Pages" apps/site/README.md .planning/REQUIREMENTS.md .planning/phases/10-sitio-de-docs-y-landing-p-blica/10-CONTEXT.md .planning/phases/10-sitio-de-docs-y-landing-p-blica/10-HUMAN-UAT.md .planning/phases/10-sitio-de-docs-y-landing-p-blica/10-SECURITY.md` -- lists all five files.
</verification>

<success_criteria>
- `public-site.yml` deploys to Cloudflare Pages via a SHA-pinned `wrangler-action`, holds no `pages:`/`id-token:` permission and no `github-pages` environment, and reads exactly two secrets, never echoed.
- `apps/site` has no CNAME-gated basePath left anywhere -- `resolveBasePath`/`PREVIEW_BASE_PATH`/`readCname` and `apps/site/public/CNAME` are gone; basePath is always the empty string.
- `apps/site/public/_headers` exists, carries the five specified headers, and its presence is enforced by `check-export.mjs` on every build, not just this plan's one-time check.
- `apps/site/README.md`, `REQUIREMENTS.md`, `10-CONTEXT.md`, `10-HUMAN-UAT.md`, and `10-SECURITY.md` all describe Cloudflare Pages, not GitHub Pages, with the phase-10 threat register's disposition/closure status left intact (audit note only, no re-audit).
- No regression: `pnpm exec vitest run tests/unit/docs tests/unit/site` (the exact suite `ci.yml`'s `site` job runs) stays green throughout.
</success_criteria>

<output>
Create `.planning/quick/260928-gmm-move-public-site-hosting-from-github-pag/260928-gmm-SUMMARY.md` when done
</output>
