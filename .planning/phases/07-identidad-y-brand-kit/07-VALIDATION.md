---
phase: 07
slug: identidad-y-brand-kit
status: draft
nyquist_compliant: false
wave_0_complete: false
created: 2026-09-22
---

# Phase 07 — Validation Strategy

> Per-phase validation contract for feedback sampling during execution.

---

## Test Infrastructure

| Property | Value |
|----------|-------|
| **Framework** | Vitest 5.0.0 (unit: `packages` / `dom` / `root` projects), Playwright `@playwright/test` 1.63.0 (E2E) |
| **Config file** | `vitest.config.ts` (unit), `playwright.config.ts` (E2E) |
| **Quick run command** | `pnpm test -- brand` (brand-scoped unit tests) + `pnpm check:ui-safety` |
| **Full suite command** | `pnpm test && pnpm test:e2e && pnpm check:ui-safety` |
| **Estimated runtime** | ~20 s quick · ~8 min full (E2E boots the stack) |

---

## Sampling Rate

- **After every task commit:** Run `pnpm test -- brand && pnpm check:ui-safety`
- **After every plan wave:** Run `pnpm test && pnpm test:e2e`
- **Before `/gsd:verify-work`:** Full suite green (`pnpm test`, `pnpm test:e2e`, `pnpm check:ui-safety`, `pnpm lint`, `pnpm typecheck`, `pnpm boundaries`) **and** the BRAND-03 approval record exists in `docs/brand/APPROVAL.md` before any BRAND-02 application task runs
- **Max feedback latency:** 30 s (quick command)

---

## Per-Task Verification Map

| Task ID | Plan | Wave | Requirement | Threat Ref | Secure Behavior | Test Type | Automated Command | File Exists | Status |
|---------|------|------|-------------|------------|-----------------|-----------|-------------------|-------------|--------|
| 07-W0-01 | TBD | 0 | BRAND-01 | — | N/A | unit | `pnpm test -- packages/ui/src/brand/geometry.test.ts` | ❌ W0 | ⬜ pending |
| 07-W0-02 | TBD | 0 | BRAND-01 | — | N/A | unit | `pnpm test -- tests/unit/brand/brand-assets-accuracy.test.ts` | ❌ W0 | ⬜ pending |
| 07-W0-03 | TBD | 0 | BRAND-01 | — | N/A | unit | `pnpm test -- tests/unit/docs/brand-kit-structure.test.ts` | ❌ W0 | ⬜ pending |
| 07-W0-04 | TBD | 0 | BRAND-02 | — | Zero hex/rgb literals outside `tokens.css`; favicon blue only in generated `.svg`/`.png`/`.ico` | static gate | `pnpm check:ui-safety` | ✅ | ⬜ pending |
| 07-W0-05 | TBD | 0 | BRAND-02 | — | N/A | component | `pnpm test -- apps/web/src/components/Sidebar.test.tsx` (`brand-lockup` / `brand-monogram` per breakpoint) | ❌ W0 | ⬜ pending |
| 07-W0-06 | TBD | 0 | BRAND-02 | — | N/A | component + E2E | `pnpm test -- apps/web/src/components/AuthCard.test.tsx`; `pnpm test:e2e -- auth setup` | ❌ W0 / ✅ specs to extend | ⬜ pending |
| 07-W0-07 | TBD | 0 | BRAND-02 | — | N/A | unit | `pnpm test -- tests/unit/brand/favicon-files-present.test.ts` | ❌ W0 | ⬜ pending |
| 07-W0-08 | TBD | 0 | BRAND-02 | — | N/A | E2E (full) | `pnpm test:e2e` (93 existing stay green) | ✅ | ⬜ pending |
| 07-W0-09 | TBD | 0 | BRAND-02 | — | N/A | unit | `pnpm test -- tests/unit/brand/package-exports-resolvable.test.ts` | ❌ W0 | ⬜ pending |
| 07-W0-10 | TBD | 0 | BRAND-03 | — | N/A | manual | `checkpoint:human-verify` — screenshots (rail, sidebar, `/login`, `/setup`) both themes + browser-tab favicon check; approval recorded in `docs/brand/APPROVAL.md` | N/A | ⬜ pending |
| 07-W0-11 | TBD | 0 | supply chain | T-07-01 | New deps (`sharp`, `png-to-ico`) registered in `scripts/check-package-provenance.mjs` before install; no `postinstall` scripts | static gate | `pnpm check:package-provenance` (verify exact script name in `package.json`) | ✅ | ⬜ pending |

*Status: ⬜ pending · ✅ green · ❌ red · ⚠️ flaky*
*Task IDs are provisional (`07-W0-NN`); the planner rewrites them to real `07-PP-TT` ids once plans exist.*

---

## Wave 0 Requirements

- [ ] `packages/ui/src/brand/geometry.test.ts` — path-builder correctness for BRAND-01
- [ ] `tests/unit/brand/brand-assets-accuracy.test.ts` — committed `packages/ui/brand/*.svg` match `renderToStaticMarkup` of the live components (BRAND-01)
- [ ] `tests/unit/docs/brand-kit-structure.test.ts` — `docs/brand/BRAND.md` section presence (BRAND-01)
- [ ] `apps/web/src/components/Sidebar.test.tsx`, `AuthCard.test.tsx` — mount-point presence, both themes (BRAND-02)
- [ ] `tests/unit/brand/favicon-files-present.test.ts` — Next.js file-convention icons present and non-empty (BRAND-02)
- [ ] `tests/unit/brand/package-exports-resolvable.test.ts` — `@noodara/ui/brand/*` resolvable from outside the package (BRAND-02)
- [ ] No new test framework install — Vitest/Playwright already configured

---

## Manual-Only Verifications

| Behavior | Requirement | Why Manual | Test Instructions |
|----------|-------------|------------|-------------------|
| Logo seen rendered in real context, both themes | BRAND-03 | Aesthetic judgement is the user's; explicit approval is the requirement | Run `scripts/capture-brand-review.mjs` (rail 64 px, sidebar ≥1280 px, `/login`, `/setup`, light + dark) per concept; review brand boards; pick concept; up to 2 adjustment rounds |
| Favicon legible in the browser tab at 16 px, light and dark tab strips | BRAND-03 | Playwright cannot capture browser chrome | Open `http://localhost:3000` in Chrome and Safari, light and dark OS appearance; check the tab icon |
| Approval recorded before application | BRAND-03 | Gate is a human decision | `docs/brand/APPROVAL.md` contains date, chosen concept, rounds used, approver; no BRAND-02 application task starts before it |

---

## Validation Sign-Off

- [ ] All tasks have `<automated>` verify or Wave 0 dependencies
- [ ] Sampling continuity: no 3 consecutive tasks without automated verify
- [ ] Wave 0 covers all MISSING references
- [ ] No watch-mode flags
- [ ] Feedback latency < 30s
- [ ] `nyquist_compliant: true` set in frontmatter

**Approval:** pending
