---
phase: 10
slug: sitio-de-docs-y-landing-p-blica
status: planned
nyquist_compliant: true
wave_0_complete: false
created: 2026-09-27
---

# Phase 10 — Validation Strategy

> Per-phase validation contract for feedback sampling during execution.

---

## Test Infrastructure

| Property | Value |
|----------|-------|
| **Framework** | Vitest 5 (root `vitest.config.ts` projects) |
| **Config file** | `vitest.config.ts` (root) — add `apps/site/**/*.test.ts` and/or `tests/unit/site/**` |
| **Quick run command** | `pnpm vitest run tests/unit/docs tests/unit/site apps/site` |
| **Full suite command** | `pnpm test --coverage && pnpm --filter @noodara/site build && pnpm boundaries` |
| **Estimated runtime** | ~90 seconds |

---

## Sampling Rate

- **After every task commit:** Run `pnpm vitest run tests/unit/docs tests/unit/site apps/site`
- **After every plan wave:** Run `pnpm test --coverage && pnpm --filter @noodara/site build && pnpm boundaries`
- **Before `/gsd:verify-work`:** Full suite must be green, plus `pnpm lint`, `pnpm typecheck`, and a `pnpm ui:review` human approval round
- **Max feedback latency:** 90 seconds

---

## Per-Task Verification Map

| Task ID | Plan | Wave | Requirement | Threat Ref | Secure Behavior | Test Type | Automated Command | File Exists | Status |
|---------|------|------|-------------|------------|-----------------|-----------|-------------------|-------------|--------|
| 10-01-01 | 01 | 1 | SITE-02 / D-06, D-12 | T-10-14 | git describe bounded by timeout | unit | `pnpm vitest run tests/unit/site/site-config.test.ts` | ❌ W0 (created in task) | ⬜ pending |
| 10-01-02 | 01 | 1 | DOCS-01 | T-10-SC | new deps pinned + provenance | static | `pnpm --filter @noodara/site typecheck && node scripts/check-package-provenance.mjs` | ❌ W0 | ⬜ pending |
| 10-01-03 | 01 | 1 | SITE-02 | T-10-09 | site cannot import control-plane/domain | unit + static | `pnpm vitest run tests/unit/site/site-boundary.test.ts && pnpm boundaries` | ❌ W0 | ⬜ pending |
| 10-02-01 | 02 | 2 | SITE-03 / D-15 | T-10-11 | constant bootstrap script | unit (jsdom) | `pnpm vitest run apps/site/src/lib apps/site/src/components/SiteThemeToggle.test.tsx` | ❌ W0 | ⬜ pending |
| 10-02-02 | 02 | 2 | SITE-01 / D-17 | T-10-13 | allowlisted asset copy | unit | `pnpm vitest run tests/unit/site/sync-site-assets.test.ts` | ❌ W0 | ⬜ pending |
| 10-02-03 | 02 | 2 | SITE-03 | T-10-05 | no third-party fonts | unit + build | `pnpm vitest run tests/unit/site/fumadocs-token-map.test.ts && pnpm check:ui-safety && pnpm --filter @noodara/site build` | ❌ W0 | ⬜ pending |
| 10-03-01 | 03 | 2 | SITE-02 | T-10-01, T-10-02, T-10-10 | SHA pins, least privilege, push-only publish | unit (structural) | `pnpm vitest run tests/unit/scripts/check-workflow-pins.test.ts` | ✅ (extend) | ⬜ pending |
| 10-03-02 | 03 | 2 | SITE-02 / DOCS-01 | — | N/A | grep | `grep -c "185.199.108.153" apps/site/README.md` | ❌ W0 | ⬜ pending |
| 10-04-01 | 04 | 2 | SITE-03 | T-10-18 | path traversal rejected | unit | `pnpm vitest run tests/unit/ui/site-review.test.ts` | ❌ W0 | ⬜ pending |
| 10-04-02 | 04 | 2 | SITE-03 / D-16 | T-10-05 | runtime third-party request check | static | `pnpm typecheck` | ❌ W0 | ⬜ pending |
| 10-05-01 | 05 | 3 | DOCS-01 / D-08 | — | N/A | unit | `pnpm vitest run apps/site/src/lib/docs-tree.test.ts` | ❌ W0 | ⬜ pending |
| 10-05-02 | 05 | 3 | DOCS-01 | T-10-19 | no dynamic route in export | build smoke | `pnpm --filter @noodara/site build` | ❌ W0 | ⬜ pending |
| 10-06-01 | 06 | 4 | SITE-01 / D-10 | T-10-06 | unsafe markup rejected | unit | `pnpm vitest run apps/site/src/lib/content-rules.test.ts tests/unit/site/forbidden-words.test.ts` | ❌ W0 | ⬜ pending |
| 10-06-02 | 06 | 4 | SITE-01 | T-10-04 | claims anchored to PROJECT.md | unit | `pnpm vitest run tests/unit/site/landing-claims.test.ts` | ❌ W0 | ⬜ pending |
| 10-06-03 | 06 | 4 | SITE-01 / D-10 | — | N/A | unit (jsdom) + build | `pnpm vitest run apps/site/src/components/mdx && pnpm --filter @noodara/site build` | ❌ W0 | ⬜ pending |
| 10-07-01 | 07 | 5 | SITE-01 / D-14, D-16 | T-10-03, T-10-05 | export has no third-party assets or leaked secrets | unit | `pnpm vitest run tests/unit/site/check-export.test.ts` | ❌ W0 | ⬜ pending |
| 10-07-02 | 07 | 5 | SITE-01 / D-14 | T-10-21 | canonical-origin sitemap | unit + build | `pnpm vitest run apps/site/src/lib/seo.test.ts && pnpm --filter @noodara/site build` | ❌ W0 | ⬜ pending |
| 10-08-01 | 08 | 6 | DOCS-02 | T-10-12 | — | unit (RED) | `pnpm vitest run tests/unit/docs/install-docs-accuracy.test.ts` (expected to fail) | ✅ (re-point) | ⬜ pending |
| 10-08-02 | 08 | 6 | DOCS-01 / DOCS-02 / D-07 | T-10-12 | commands match install.sh | unit + build | `pnpm vitest run tests/unit/docs/install-docs-accuracy.test.ts && pnpm --filter @noodara/site build` | ✅ | ⬜ pending |
| 10-09-01 | 09 | 7 | SITE-01 / D-01 | T-10-12 | install command equals install.sh/README | unit | `pnpm vitest run tests/unit/site/site-facts.test.ts` | ❌ W0 | ⬜ pending |
| 10-09-02 | 09 | 7 | SITE-01 / SITE-03 | T-10-05 | no external image/icon | unit (jsdom) | `pnpm vitest run apps/site/src/components/landing/landing-parts.test.tsx` | ❌ W0 | ⬜ pending |
| 10-10-01 | 10 | 8 | DOCS-02 | T-10-12 | error codes equal SERVICE_ERROR_STATUS | unit | `pnpm vitest run tests/unit/docs/error-codes-accuracy.test.ts` | ❌ W0 | ⬜ pending |
| 10-10-02 | 10 | 8 | DOCS-01 / D-09 | T-10-04 | statuses/labels from real sources | unit | `pnpm vitest run tests/unit/docs/concepts-accuracy.test.ts` | ❌ W0 | ⬜ pending |
| 10-10-03 | 10 | 8 | DOCS-01 / D-08 | — | N/A | unit + build | `pnpm vitest run apps/site/src/lib/docs-tree.test.ts && pnpm --filter @noodara/site build` | ✅ | ⬜ pending |
| 10-11-01 | 11 | 9 | SITE-01 | T-10-04 | — | unit (RED) | `pnpm vitest run apps/site/src/components/landing/Landing.test.tsx` (expected to fail) | ❌ W0 | ⬜ pending |
| 10-11-02 | 11 | 9 | SITE-01 / SITE-03 | T-10-04, T-10-07 | only delivered claims; safe external links | unit + build | `pnpm vitest run apps/site tests/unit/site && pnpm --filter @noodara/site build` | ✅ | ⬜ pending |
| 10-12-01 | 12 | 10 | SITE-03 | T-10-03, T-10-05 | zero third-party requests at runtime | capture + full gate | `pnpm site:build && pnpm ui:review:site && pnpm lint && pnpm typecheck && pnpm test --coverage && pnpm boundaries && pnpm check:ui-safety` | ✅ | ⬜ pending |
| 10-12-02 | 12 | 10 | SITE-03 | — | N/A | manual | human approval recorded in `docs/ui/APPROVAL.md` | — | ⬜ pending |

*Status: ⬜ pending · ✅ green · ❌ red · ⚠️ flaky*

*The planner fills Task IDs, plan, and wave from the final PLAN.md files.*

---

## Wave 0 Requirements

- [ ] `apps/site/` scaffold (`package.json`, `next.config.ts`, `tsconfig.json`, `postcss.config.mjs`) — new workspace app, `output: 'export'`
- [ ] `apps/site/source.config.ts` + `apps/site/lib/source.ts` — Fumadocs wiring
- [ ] `tests/unit/docs/error-codes-accuracy.test.ts` — DOCS-02 error-code half
- [ ] `tests/unit/site/landing-claims.test.ts` — SITE-01
- [ ] `tests/unit/site/forbidden-words.test.ts` — D-10
- [ ] `turbo.json` boundaries tag for `apps/site` — SITE-02
- [ ] `scripts/ui/review-paths.ts` — site screens for landing + docs, both themes, 375/900/1280/1920
- [ ] Framework install: none (Vitest already the workspace default)

---

## Manual-Only Verifications

| Behavior | Requirement | Why Manual | Test Instructions |
|----------|-------------|------------|-------------------|
| Landing and docs look right in both themes at four widths | SITE-03 | Visual judgement | Run `pnpm ui:review`, inspect captures, record approval in `docs/ui/APPROVAL.md` |
| GitHub Pages source set to "GitHub Actions"; custom domain + Enforce HTTPS | SITE-02 | Repo settings, not in code | Settings → Pages → Source: GitHub Actions; add `noodara.com`; enable Enforce HTTPS after DNS resolves |
| DNS records for apex and www point at Pages | SITE-02 | External DNS provider | Create A/AAAA records for apex and CNAME `www` → `<user>.github.io` as documented in the plan |

---

## Validation Sign-Off

- [x] All tasks have `<automated>` verify or Wave 0 dependencies
- [x] Sampling continuity: no 3 consecutive tasks without automated verify
- [x] Wave 0 covers all MISSING references (each test is created RED inside its own task)
- [x] No watch-mode flags
- [ ] Feedback latency < 90s
- [x] `nyquist_compliant: true` set in frontmatter

**Approval:** pending
