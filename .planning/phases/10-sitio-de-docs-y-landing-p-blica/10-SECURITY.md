---
phase: 10
slug: sitio-de-docs-y-landing-p-blica
status: verified
threats_open: 0
threats_total: 41
threats_closed: 41
asvs_level: 1
created: 2026-09-28
---

# Phase 10 — Security

> Per-phase security contract: threat register, accepted risks, and audit trail.

---

## Trust Boundaries

| Boundary | Description | Data Crossing |
|----------|-------------|---------------|
| npm registry → workspace | Five new third-party packages enter the lockfile | package tarballs |
| site package → rest of monorepo | Public static artifact must never pull in control-plane or domain code | source imports |
| build machine → static HTML | Build-time values baked into public HTML | four public strings only |
| repo files → public static HTML | Brand files and captures copied into a public artifact | image/brand bytes |
| inline script → every page | Bootstrap script runs before hydration on every page | theme preference literal |
| browser localStorage → theme | Untrusted stored value decides a DOM attribute | `'light'`/`'dark'` string |
| GitHub Actions marketplace → CI runner | Third-party actions execute with a job token | workflow token |
| CI → GitHub Pages | Deploy job holds an OIDC token and `pages:write` | deployment artifact |
| PR author → CI | PR code runs the site build in the `site` job | build output |
| local HTTP server → filesystem | URL paths map to files under `apps/site/out` | request path |
| built site → network | Any outbound request from the site is a D-16 violation | HTTP requests |
| repo MDX → static HTML | Authored content compiled to public pages | content markup |
| static search index → browser | JSON index fetched and evaluated client-side | search index |
| product capability → public claim | What the site asserts must match what ships | copy text |
| build output → public CDN | Whatever lands in `apps/site/out` is published verbatim | static export |
| visitor browser → third parties | Third-party assets leak visitor IP/referrer | outbound requests |
| public docs → operator shell (as root) | Operators paste documented commands into root shells | shell commands |
| site → visitor clipboard → root shell | Copied command runs as root on the visitor's server | install command |
| public docs → operator decisions | Operators act on documented error codes/flows | reference tables |
| landing → visitor | Public marketing claims and outbound links | claim text, links |
| phase diff → public internet | Final gate before the site is published | full artifact |

---

## Threat Register

| Threat ID | Category | Component | Disposition | Mitigation | Status |
|-----------|----------|-----------|-------------|------------|--------|
| T-10-SC | Tampering | fumadocs-core/ui/mdx, flexsearch, @types/mdx installs (10-01) | mitigate | `EXPECTED_PACKAGES` owner/repo entries in `scripts/check-package-provenance.mjs` (all four present, plus `fumadocs-mdx`); `pnpm install --frozen-lockfile` in every CI job (verified `.github/workflows/{ci,public-site,nightly}.yml`) | closed |
| T-10-09 | Elevation of privilege | apps/site imports | mitigate | `turbo.json` `boundaries.tags.public-site.dependencies.deny` = `["@noodara/control-plane", "@noodara/web"]`; `tests/unit/site/site-boundary.test.ts` (13 tests pass) | closed |
| T-10-03 | Information disclosure | next.config.mjs `env` | mitigate | `apps/site/next.config.mjs` `env` block exposes exactly four public strings, no `process.env` passthrough (code read directly) | closed |
| T-10-14 | Denial of service (build hang) | describeLatestTag git call | mitigate | `apps/site/site-config.mjs:63-65` `execFileSync(..., { timeout: 5000 })`, wrapped to never throw | closed |
| T-10-11 | Tampering (XSS) | layout.tsx inline bootstrap script | mitigate | `apps/site/src/lib/theme-script.ts` module-level string constant, zero `${` interpolation, literal `'light'`/`'dark'` comparisons; `scripts/check-ui-safety.mjs` allowlists exactly `apps/web` and `apps/site` root layouts | closed |
| T-10-13 | Information disclosure | asset sync into public/ (10-02) | mitigate | `apps/site/scripts/sync-site-assets.mjs` frozen `SITE_ASSET_FILES` allowlist (16 keys: 4 brand + 12 screenshots), missing source throws instead of skipping | closed |
| T-10-05 | Information disclosure (privacy) | third-party fonts/assets (10-02) | mitigate | `apps/site/src/app/global.css` uses only `var(--font-sans)`/`var(--font-mono)` system stack; `tests/unit/site/fumadocs-token-map.test.ts` (17 tests pass) forbids `@font-face`/`url(http` | closed |
| T-10-15 | Spoofing (UI) | contrast/theme regressions | mitigate | Measured contrast pairs asserted in `tests/unit/site/fumadocs-token-map.test.ts` for both themes | closed |
| T-10-01 | Tampering | uses: lines in public-site.yml / ci.yml | mitigate | Every `uses:` in `.github/workflows/public-site.yml` is a 40-hex SHA with tag comment; `tests/unit/scripts/check-workflow-pins.test.ts` (33 tests pass) | closed |
| T-10-02 | Elevation of privilege | workflow token scopes | mitigate | `public-site.yml` top-level `permissions: {}`; build job `contents: read`; deploy job `pages: write` + `id-token: write` only; `ci.yml` `site` job `contents: read` (all read directly) | closed |
| T-10-10 | Spoofing/Tampering | Pages deployment | mitigate | `public-site.yml` triggers only on `push: branches: [main]` + `workflow_dispatch` (no `pull_request`); `environment: github-pages`; `concurrency: { group: pages, cancel-in-progress: false }` | closed |
| T-10-03 | Information disclosure | build logs / artifact (10-03) | mitigate | `public-site.yml` references no `secrets.`; site build reads no secret env (confirmed by inspection + workflow-pins test suite) | closed |
| T-10-16 | Tampering | release pipeline coupling | mitigate | `tests/unit/scripts/check-workflow-pins.test.ts:300` "release.yml, docker-compose.yml and docker-compose.dev.yml never mention the site" (passing) | closed |
| T-10-17 | Spoofing | DNS takeover of noodara.com while Pages not yet configured | accept | Accepted risk logged below; `apps/site/README.md` documents "Publishing" (custom domain in Pages settings) before "DNS" section, matching the plan's stated order; GitHub verifies domain ownership before issuing TLS; remaining activation is an operator action tracked honestly in `10-HUMAN-UAT.md` §1-2, not a code gap | closed |
| T-10-18 | Information disclosure | static-site-server path mapping | mitigate | `scripts/ui/static-site-server.ts` `resolveStaticPath` rejects any candidate whose `path.relative(outDir, candidate)` starts with `..`; binds `127.0.0.1` only, `listen(0, ...)` ephemeral port, `REQUEST_TIMEOUT_MS = 10_000` | closed |
| T-10-05 | Information disclosure (privacy) | third-party requests from the site (10-04) | mitigate | `scripts/ui/capture-site-review.ts` records every `page.on('request', ...)` and pushes a `'third-party-request'` violation for any non-local origin; asserted by `tests/unit/ui/approval-record.test.ts` + `tests/unit/brand/approval-record.test.ts` (29 tests pass) | closed |
| T-10-06 | Tampering (content injection) | MDX compilation (10-05) | mitigate | `apps/site/src/lib/content-rules.ts` `findUnsafeMarkup` detects `<script`, `<iframe`, `javascript:`, `dangerouslySetInnerHTML`; `scripts/check-ui-safety.mjs` still counts `dangerouslySetInnerHTML`; `content-rules.test.ts` + `forbidden-words.test.ts` pass (17 tests) | closed |
| T-10-05 | Information disclosure (privacy) | search backend | mitigate | `apps/site/package.json` lists only `flexsearch` (no algolia/orama); static index served same-origin | closed |
| T-10-19 | Denial of service | dynamic route in static export | mitigate | `apps/site/src/app/docs/[[...slug]]/page.tsx:10` `export const dynamicParams = false` + `generateStaticParams` | closed |
| T-10-04 | Spoofing (false capability/security claims) | landing + docs claims (10-06) | mitigate | `apps/site/src/content/scope.ts` single source; `tests/unit/site/landing-claims.test.ts` (8 tests pass) anchors limits and rejects excluded terms; `tests/unit/site/forbidden-words.test.ts` (2 tests pass, D-10) | closed |
| T-10-06 | Tampering (content injection) | MDX content (10-06) | mitigate | Same `findUnsafeMarkup` scan applied to authored content, verified in `content-rules.test.ts` | closed |
| T-10-20 | Repudiation (stale promises) | dated/roadmap wording | mitigate | `tests/unit/site/forbidden-words.test.ts` blocks "soon"/"roadmap"/date wording | closed |
| T-10-05 | Information disclosure (privacy) | exported HTML/CSS (10-07) | mitigate | `apps/site/scripts/check-export.mjs` `FONT_FACE_PATTERN` + non-local-origin scan; wired into `apps/site/package.json` `build` script (`next build && node scripts/check-export.mjs`), which both `public-site.yml` and `ci.yml`'s `site` job invoke | closed |
| T-10-03 | Information disclosure | exported artifact (10-07) | mitigate | `check-export.mjs` `findLeakedEnvNames` (line 134) scans every exported file; `tests/unit/site/check-export.test.ts` (30 tests pass) | closed |
| T-10-21 | Tampering | wrong base path in production | mitigate | `check-export.mjs` `findBasePathMismatch` + `findMissingBasePathPrefix`; CR-01 fix verified: all internal links use `next/link` (`Hero.tsx`, `SiteFooter.tsx`, `SiteHeader.tsx`, `InstallCommand.tsx`, `ScopeBlock.tsx`, `ScopeNote.tsx`, `not-found.tsx`), no raw `href="/..."` outside `<Link>` | closed |
| T-10-12 | Tampering (integrity of instructions) | documented commands/variables (10-08) | mitigate | `tests/unit/docs/install-docs-accuracy.test.ts` (part of 46 passing) derives URL/owner/exit codes/ufw wording/password length from `install.sh`; forbids `NOODARA_*=` before curl and undocumented test-only vars | closed |
| T-10-03 | Information disclosure | docs content (10-08) | mitigate | No credentials/secrets in content (inspected); `check-export.mjs` leak scan runs on every build | closed |
| T-10-22 | Denial of service (broken links in installer output) | docs/install.md | mitigate | `docs/install.md` kept as stub with `#firewall` and `#plain-http-warning` anchors, matching `install.sh:2080-2109` messages | closed |
| T-10-12 | Tampering (integrity of the install command) | INSTALL_COMMAND (10-09) | mitigate | `apps/site/src/lib/site-facts.ts:22` `INSTALL_COMMAND` constant; `tests/unit/site/site-facts.test.ts` asserts it matches `install.sh` defaults verbatim in README.md and the Install docs page | closed |
| T-10-05 | Information disclosure (privacy) | images/icons (10-09) | mitigate | Images only from the synced approved set via `assetPath`; diagram is inline SVG with no external href (asserted in test suite) | closed |
| T-10-04 | Spoofing (claims) | PillarCard text (10-09) | mitigate | Claim text read from `DELIVERED_CAPABILITIES` by id, never retyped (code read directly) | closed |
| T-10-12 | Tampering (integrity of reference docs) | error codes, statuses, UI labels (10-10) | mitigate | `tests/unit/docs/error-codes-accuracy.test.ts` + `tests/unit/docs/concepts-accuracy.test.ts` (part of 46 passing) hold exact equality against `SERVICE_ERROR_STATUS` and domain/`apps/web` sources | closed |
| T-10-04 | Spoofing (capability claims) | concepts pages (10-10) | mitigate | `ScopeNote`s from `scope.ts`; phrase ban on unbuilt-UI wording via `forbidden-words.test.ts` | closed |
| T-10-03 | Information disclosure | error body examples (10-10) | mitigate | Test forbids `stack`/`cause` in documented bodies; bodies are `{ error, message }` per `toErrorBody` | closed |
| T-10-04 | Spoofing (false capability claims) | landing copy (10-11) | mitigate | `apps/site/src/components/landing/Landing.test.tsx` (20 tests pass): no excluded term outside scope block, pillar text from `DELIVERED_CAPABILITIES` | closed |
| T-10-07 | Tampering (reverse tabnabbing / referrer leak) | external links (10-11) | mitigate | All three GitHub links (`SiteHeader.tsx:38`, `SiteFooter.tsx:42`, `Hero.tsx:69`) carry `target="_blank" rel="noopener noreferrer"` (WR-04 post-review fix); `Landing.test.tsx` exhaustively asserts `rel` contains both `noopener` and `noreferrer` for every `target="_blank"` link | closed |
| T-10-05 | Information disclosure (privacy) | footer/star counter (10-11) | mitigate | No `fetch(`/`stargazers` anywhere in landing sources (source scan, part of `Landing.test.tsx`); version/license baked at build | closed |
| T-10-03 | Information disclosure | whole phase (10-12) | mitigate | Final `check-export.mjs` leak scan; no `secrets.` references in `public-site.yml` | closed |
| T-10-13 | Information disclosure | review captures / APPROVAL.md (10-12) | mitigate | `.gitignore:35-36` — `docs/ui/review/*` ignored except `README.md`; `git ls-files docs/ui/review` confirms only `README.md` tracked; `approval-record.test.ts` suites (29 tests pass) keep docs free of attribution/fixture credentials | closed |
| T-10-05 | Information disclosure (privacy) | published site (10-12) | mitigate | `pnpm ui:review:site` (`scripts/ui/capture-site-review.ts`) fails on any third-party request at runtime, in addition to build-time `check-export.mjs` | closed |
| T-10-SC | Tampering | dependency tree (10-12) | mitigate | `scripts/check-package-provenance.mjs` + `pnpm audit --audit-level=high` in `ci.yml:270` (final gate) | closed |

*Status: open · closed*
*Disposition: mitigate (implementation required) · accept (documented risk) · transfer (third-party)*

---

## Accepted Risks Log

| Risk ID | Threat Ref | Rationale | Accepted By | Date |
|---------|------------|-----------|-------------|------|
| AR-10-01 | T-10-17 | DNS takeover of noodara.com while GitHub Pages custom domain is not yet configured is an operator-controlled activation step, not a code defect. `apps/site/README.md`'s "Publishing" section documents setting the Pages custom domain before the "DNS" section documents pointing DNS records at it; GitHub verifies domain ownership before issuing TLS for a custom domain. The remaining external activation (enabling Pages, configuring DNS) is tracked honestly as pending in `10-HUMAN-UAT.md` items 1-2, not hidden as done. | 10-03-PLAN.md (plan-time) | 2026-09-27 |

*Accepted risks do not resurface in future audit runs.*

---

## Security Audit Trail

| Audit Date | Threats Total | Closed | Open | Run By |
|------------|---------------|--------|------|--------|
| 2026-09-28 | 41 | 41 | 0 | gsd-security-auditor |

**Unregistered flags:** none — every `10-*-SUMMARY.md` `## Threat Flags` section reports "None", and each explicitly maps its plan's work to its own threat register rows (T-10-SC/T-10-09 in 10-01; T-10-12/T-10-05/T-10-04 in 10-09; T-10-12/T-10-04/T-10-03 in 10-10; T-10-04/T-10-07/T-10-05 in 10-11).

**Notes on scope honesty:**
- T-10-10 (Pages deployment workflow correctness) and T-10-17 (DNS) both have a residual **external, operator-performed** step (enabling GitHub Pages, pointing DNS) that this repo cannot perform itself. The workflow-side mitigations (SHA pins, least-privilege scopes, push-to-main-only trigger, `github-pages` environment, concurrency guard) are fully implemented and test-verified. The external steps are tracked as pending in `10-HUMAN-UAT.md`, not claimed as done.
- The asset-sync allowlist comment in `10-02-PLAN.md`'s threat model text says "14 files"; the implemented `SITE_ASSET_FILES` in `sync-site-assets.mjs` has grown to 16 keys (4 brand + 6 screens × 2 themes) after 10-12 Round 1 added the "setup" screen. This is a documentation-drift note, not a mitigation gap — the allowlist mechanism (frozen object, fail-loud on missing source, additive-only) is unchanged and still enforced.

---

## Sign-Off

- [x] All threats have a disposition (mitigate / accept / transfer)
- [x] Accepted risks documented in Accepted Risks Log
- [x] `threats_open: 0` confirmed
- [x] `status: verified` set in frontmatter

**Approval:** verified 2026-09-28
