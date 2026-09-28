---
phase: 10-sitio-de-docs-y-landing-p-blica
verified: 2026-09-28T00:00:00Z
status: human_needed
score: 5/5 must-haves verified
overrides_applied: 0
human_verification:
  - test: "Confirm the real GitHub Pages deploy of noodara.com (Settings -> Pages source = GitHub Actions, custom domain + Enforce HTTPS, first `public-site.yml` run green on a push to main)"
    expected: "The site is reachable at https://noodara.com over HTTPS and matches the local `apps/site/out` build"
    why_human: "Requires repo settings and DNS state outside the codebase; cannot be verified by static analysis"
  - test: "Confirm DNS records (apex A/AAAA + www CNAME) at the real registrar for noodara.com"
    expected: "Apex resolves to GitHub Pages IPs, www redirects, matching apps/site/README.md"
    why_human: "External DNS provider state, not observable in the repo"
---

# Phase 10: Sitio de docs y landing pública Verification Report

**Phase Goal:** Cualquier persona que llega a Noodara desde fuera encuentra una landing honesta con la identidad y una documentación pública (instalación, conceptos, primer deploy, límites de v0.2, upgrade/rollback) que se publica sola desde CI, que nunca miente sobre comandos, variables ni códigos de error, y que cumple el mismo piso de calidad que la app.
**Verified:** 2026-09-28
**Status:** human_needed
**Re-verification:** No — initial verification

## Goal Achievement

### Observable Truths

| # | Truth | Status | Evidence |
|---|-------|--------|----------|
| 1 | `apps/site` exports statically, landing at `/`, docs at `/docs`, install text/exit-code table match `install.sh`/`docs/install.md` history | VERIFIED | `pnpm --filter @noodara/site build` succeeds (Next 16 static export, 27 pages, `check-export.mjs`: "21 files, zero third-party assets"); `apps/site/content/docs/getting-started/install.mdx` contains the exact `curl -fsSL https://raw.githubusercontent.com/nooodara/noodara/main/install.sh \| sh` command; `docs/install.md` is now a short stub linking to `https://noodara.com/docs/getting-started/install` |
| 2 | DOCS-01 "primer deploy" — the roadmap-declared scope narrowing (D-09) is honored and recorded | VERIFIED (scoped per D-09) | ROADMAP.md §Phase 10 carries the literal note "esta fase entrega 'Your first server'; la página 'Your first deploy' la añade la Fase 13, que reabre DOCS-01 al cerrar"; `apps/site/content/docs/getting-started/first-server.mdx` exists and covers install → first login → add server → trust fingerprint → discovery → detail. REQUIREMENTS.md's DOCS-01 row also carries the same note in its description text. Judged against the recorded D-09 decision, not against the full unscoped DOCS-01 wording. |
| 3 | An accuracy test fails the build if a command/variable/exit-code/error-code drifts from `install.sh` or the real error vocabulary; a boundary test blocks `apps/control-plane`/`@noodara/domain` imports from the site | VERIFIED | `tests/unit/docs/install-docs-accuracy.test.ts` and `tests/unit/docs/error-codes-accuracy.test.ts` (imports `SERVICE_ERROR_STATUS` directly from `apps/control-plane/src/routes/http-errors.ts`) both pass in the 275-test `pnpm exec vitest run tests/unit/docs tests/unit/site apps/site` run; `pnpm boundaries` — "Checked 840 files in 7 packages, no issues found" |
| 4 | The landing only claims delivered capabilities (screenshots, install command, docs/GitHub links, SEO/OG present, no third-party assets/fonts) | VERIFIED | `apps/site/src/content/scope.ts` defines `DELIVERED_CAPABILITIES`/`SCOPE_EXCLUSIONS` with on-disk `evidence` paths — all 11 evidence paths verified to exist (`install.sh`, 6 e2e specs, `tests/integration/installer`, `credential-store.ts`, `exec-with-timeout.ts`); `tests/unit/site/landing-claims.test.ts` passes; `apps/site/out/sitemap.xml`, `robots.txt`, `opengraph-image.png`, `404.html` all present in the export; `check-export.mjs` confirms zero third-party assets and no `@font-face` |
| 5 | Every push to `main` publishes via `public-site.yml`; PR build is a gate; site never enters `release.yml`/`docker-compose*.yml`; domain changes via CNAME only | VERIFIED | `.github/workflows/public-site.yml` triggers on `push: branches: [main]` + `workflow_dispatch`, no path filter, uses `upload-pages-artifact`+`deploy-pages`, no `gh-pages` branch; `node scripts/check-workflow-pins.mjs .github/workflows/public-site.yml .github/workflows/ci.yml` → both "clean" (every `uses:` SHA-pinned); `ci.yml`'s `site` job runs `pnpm --filter @noodara/site build` + the docs/site Vitest suites; `grep -n "apps/site" .github/workflows/release.yml docker-compose*.yml` → no matches; `apps/site/public/CNAME` / `out/CNAME` = `noodara.com` |
| 6 | Same UI quality floor as the app (contrast, typography, both themes, reduced-motion), human-reviewed with screenshots | VERIFIED (codebase) / see human_verification | `pnpm check:ui-safety` → all 12 gates OK; `docs/ui/APPROVAL.md` has a filled "Phase 10 — Public site" block (date 2026-09-28, approver Pablo Gutierrez, evidence = `docs/ui/review/site/` + `docs/ui-reviews/public-site-2026-09.md`), including a Round 1 adjustment log for the "muy simplona" redesign and the orchestrator's later 6-defect fix batch. The human sign-off text is honest about scope ("está en pañales") — and it was given after the fix commits `d8f2aaf`/`72f3ad0` (see correction below). |

**Score:** 5/5 must-haves verified (goal-level); one item routed to human_verification for the parts a repo cannot certify (real Pages/DNS deploy,)

### Required Artifacts

| Artifact | Expected | Status | Details |
|----------|----------|--------|---------|
| `apps/site/site-config.mjs` | basePath/version/license resolution | VERIFIED | exports present, used by `next.config.mjs` |
| `apps/site/next.config.mjs` | `output: 'export'`, CNAME-gated basePath | VERIFIED | build succeeds with root basePath (CNAME present) |
| `apps/site/public/CNAME` / `out/CNAME` | `noodara.com` | VERIFIED | content confirmed |
| `tests/unit/site/site-boundary.test.ts` | forbids control-plane/domain/web/ssh imports | VERIFIED | part of green 275-test run; `pnpm boundaries` also green |
| `.github/workflows/public-site.yml` | Pages publish workflow | VERIFIED | SHA-pinned, `permissions: {}` root + least-privilege per job |
| `.github/workflows/ci.yml` `site` job | PR gate | VERIFIED | `pnpm --filter @noodara/site build` + vitest |
| `apps/site/README.md` | Pages/DNS/analytics notes | VERIFIED | contains the four Pages IPs |
| `apps/site/src/content/scope.ts` | DELIVERED_CAPABILITIES/SCOPE_EXCLUSIONS | VERIFIED | 11 capabilities, all evidence files exist on disk |
| `apps/site/content/docs/reference/error-codes.mdx` | HTTP API error table | VERIFIED | test imports and diffs against real `SERVICE_ERROR_STATUS` |
| `apps/site/content/docs/reference/scope.mdx` | Scope of this release | VERIFIED | renders `<ScopeTable>` |
| `apps/site/content/docs/getting-started/first-server.mdx` | Your first server guide | VERIFIED | present |
| `apps/site/src/components/landing/Landing.tsx` | composed landing | VERIFIED | 1667 lines total across landing components; composes Hero, FeatureGrid, ProductTour, HowItWorksDiagram, FAQSection, ScopeBlock, ClosingCta, SiteFooter |
| `docs/ui-reviews/public-site-2026-09.md` | UX review report | VERIFIED (existence) | present; per-dimension verdicts cited in APPROVAL.md |
| `docs/ui/APPROVAL.md` | Phase 10 block | VERIFIED | filled, dated, approver named |
| `docs/install.md` | stub linking to site | VERIFIED | confirmed stub content |

### Key Link Verification

| From | To | Via | Status | Details |
|------|----|----|--------|---------|
| `apps/site/next.config.mjs` | `apps/site/site-config.mjs` | import | WIRED | build succeeds using resolved basePath |
| `.github/workflows/public-site.yml` | `apps/site/out` | `upload-pages-artifact path` | WIRED | workflow YAML references the export dir |
| `tests/unit/docs/error-codes-accuracy.test.ts` | `apps/control-plane/src/routes/http-errors.ts` | direct import of `SERVICE_ERROR_STATUS` | WIRED | grep-confirmed import; test passes |
| `tests/unit/site/landing-claims.test.ts` | `.planning/PROJECT.md` | Out of Scope anchor check | WIRED | part of passing suite |
| `apps/site/src/app/sitemap.ts` | `apps/site/src/lib/source.ts` | `getPages()` | WIRED | `out/sitemap.xml` lists every docs route |
| `ci.yml` `site` job | `apps/site` | `pnpm --filter @noodara/site build` | WIRED | ran directly, succeeded |

### Requirements Coverage

| Requirement | Source Plan(s) | Description | Status | Evidence |
|-------------|-----------------|-------------|--------|----------|
| DOCS-01 | 10-01, 10-03, 10-05, 10-06, 10-08, 10-10, 10-12 | Public docs incl. install/concepts/first-deploy/limits/upgrade-rollback | SATISFIED, scoped by D-09 | ROADMAP.md and REQUIREMENTS.md both record the D-09 narrowing to "Your first server"; full "Your first deploy" reopens with Phase 13. Everything in the narrowed scope (install, concepts, first-server, limits, upgrade/rollback) exists and is tested. |
| DOCS-02 | 10-08, 10-10 | Accuracy test vs install.sh + error vocabulary | SATISFIED | `install-docs-accuracy.test.ts` + `error-codes-accuracy.test.ts` both pass, both import real sources |
| SITE-01 | 10-06, 10-07, 10-09, 10-10, 10-11 | Honest landing, real screenshots, install command, docs/GitHub links, no 3rd-party assets, SEO/OG | SATISFIED | `scope.ts`-anchored claims test passes; `check-export.mjs` confirms zero third-party assets; OG image + sitemap present |
| SITE-02 | 10-01, 10-03, 10-07 | Auto-publish via `public-site.yml`, CNAME-configurable domain, PR build gate | SATISFIED | workflow confirmed, pins clean, ci.yml `site` job confirmed, site absent from `release.yml`/`docker-compose*.yml` |
| SITE-03 | 10-02, 10-04, 10-09, 10-12 | Same UI quality floor, human review | SATISFIED (codebase) / real-deploy + fresh-look items routed to human_verification | `check:ui-safety` green; `docs/ui/APPROVAL.md` Phase 10 block filled and dated |

No orphaned requirement IDs found — DOCS-01, DOCS-02, SITE-01, SITE-02, SITE-03 are each declared in at least one plan's `requirements:` frontmatter and match REQUIREMENTS.md.

**Note (bookkeeping gap, not a goal blocker):** `.planning/REQUIREMENTS.md`'s checkbox list (lines ~85-89) and its status table (lines ~173-177) still show DOCS-01/DOCS-02/SITE-01/SITE-02/SITE-03 as unchecked `[ ]` / "Pending", unlike every other completed phase's requirements (e.g. Phase 8/9 rows read "Complete"). ROADMAP.md's own Phase 10 entry is already marked `[x]` and dated "(completed 2026-09-28)". This is a documentation-sync gap in REQUIREMENTS.md, not evidence the underlying work is incomplete — all five requirements' functional evidence is verified above.

### Anti-Patterns Found

None blocking. `grep` for `TBD|FIXME|XXX` across `apps/site/src`, `apps/site/content`, `apps/site/scripts`, `docs/install.md`, `.github/workflows/public-site.yml` returned zero hits. The three "placeholder" string hits are historical code comments (referring to a prior placeholder route now replaced, and to `install.sh`'s own literal `nooodara/noodara` default pair) — not unresolved stub markers.

### Human Verification Required

### 1. Real GitHub Pages deployment

**Test:** After merging, confirm repo Settings → Pages → Source = "GitHub Actions", custom domain `noodara.com` set, "Enforce HTTPS" enabled once DNS resolves, and that `public-site.yml` actually ran green on a push to `main`.
**Expected:** `https://noodara.com` serves the same content as the local `apps/site/out` build.
**Why human:** Repo/DNS settings and a live Actions run are outside static repo analysis.

### 2. DNS records

**Test:** Verify the real registrar has apex A records `185.199.108.153/109.153/110.153/111.153` and a `www` CNAME to `<owner>.github.io`, per `apps/site/README.md`.
**Expected:** `noodara.com` and `www.noodara.com` resolve to GitHub Pages.
**Why human:** External DNS provider state.

> **Orchestrator correction (2026-09-28):** a third human item ("fresh look after the fix batch") was removed. `git log` shows the fix commits `d8f2aaf`/`72f3ad0` (09:18–09:19) precede the approval commit `f3e307d` (09:28), and the captures shown to the approver were taken after the fix batch, so the recorded approval covers them.

### Gaps Summary

No BLOCKER-level gaps found. The phase goal is achieved: `apps/site` is a real, tested, honestly-scoped public site and docs deployment pipeline, with every must-have from all 12 plans and all 5 roadmap Success Criteria backed by passing tests, a clean static export, clean lint/typecheck/boundaries/ui-safety/provenance, and a recorded (if candid) human approval. The only open items are things no codebase check can certify — the real Pages/DNS publish — routed to human_verification rather than claimed as passed. A minor, non-blocking documentation-sync gap exists in `.planning/REQUIREMENTS.md`'s checkbox/status table (still "Pending" for all five Phase 10 requirement IDs, inconsistent with ROADMAP.md and with how other completed phases are recorded there).

---

_Verified: 2026-09-28_
_Verifier: Claude (gsd-verifier)_
