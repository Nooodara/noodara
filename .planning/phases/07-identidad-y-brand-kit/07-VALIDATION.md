---
phase: 07
slug: identidad-y-brand-kit
status: complete
nyquist_compliant: true
wave_0_complete: true
created: 2026-09-22
closed: 2026-09-23
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
| 07-01 | 07-01 | 1 | BRAND-01 | — | N/A | unit | `pnpm exec vitest run packages/ui/src/brand/geometry.test.ts` | ✅ | ✅ green |
| 07-06 T3 | 07-06 | 5 | BRAND-01 | — | N/A | unit | `pnpm exec vitest run tests/unit/brand/brand-assets-accuracy.test.ts` | ✅ | ✅ green |
| 07-08 T2 | 07-08 | 6 | BRAND-01 | — | N/A | unit | `pnpm exec vitest run tests/unit/docs/brand-kit-structure.test.ts` | ✅ | ✅ green |
| 07-03 / 07-09 | 07-03, 07-09 | 2, 6 | BRAND-02 | — | Zero hex/rgb literals outside `tokens.css`; favicon blue only in generated `.svg`/`.png`/`.ico` | static gate | `pnpm check:ui-safety` | ✅ | ✅ green |
| 07-07 | 07-07 | 3 | BRAND-02 | — | N/A | component | `pnpm exec vitest run apps/web/src/components/Sidebar.test.tsx` (`brand-lockup` / `brand-monogram` per breakpoint) | ✅ | ✅ green |
| 07-07 | 07-07 | 3 | BRAND-02 | — | N/A | component + E2E | `pnpm exec vitest run apps/web/src/components/AuthCard.test.tsx`; `pnpm test:e2e tests/e2e/brand.spec.ts` | ✅ | ✅ green |
| 07-09 T2 | 07-09 | 6 | BRAND-02 | — | N/A | unit | `pnpm exec vitest run tests/unit/brand/favicon-files-present.test.ts` | ✅ | ✅ green |
| 07-10 T3 | 07-10 | 7 | BRAND-02 | — | N/A | E2E (full) | `pnpm test:e2e` (93 existing + 11 brand stay green) | ✅ | ✅ green |
| 07-06 T3 | 07-06 | 5 | BRAND-02 | — | N/A | unit | `pnpm exec vitest run tests/unit/brand/package-exports-resolvable.test.ts` | ✅ | ✅ green |
| 07-05 | 07-05 | 4 | BRAND-03 | — | N/A | manual | Human approval gate — screenshots (rail, sidebar, `/login`, `/setup`) both themes + browser-tab favicon check; approval recorded in `docs/brand/APPROVAL.md` | ✅ | ✅ green |
| 07-02 T2 | 07-02 | 1 | supply chain | T-07-01 | New deps (`sharp`, `png-to-ico`) registered in `scripts/check-package-provenance.mjs` before install; no `postinstall` scripts | static gate | `node scripts/check-package-provenance.mjs` | ✅ | ✅ green |

*Status: ⬜ pending · ✅ green · ❌ red · ⚠️ flaky*
*Closed 07-10: every provisional `07-W0-NN` id above has been rewritten to the real plan/task id that delivered it (see 07-10-SUMMARY.md's full command/exit-code table for the run this table reports).*

---

## Wave 0 Requirements

- [x] `packages/ui/src/brand/geometry.test.ts` — path-builder correctness for BRAND-01 (07-01)
- [x] `tests/unit/brand/brand-assets-accuracy.test.ts` — committed `packages/ui/brand/*.svg` match `renderToStaticMarkup` of the live components (BRAND-01) (07-06)
- [x] `tests/unit/docs/brand-kit-structure.test.ts` — `docs/brand/BRAND.md` section presence (BRAND-01) (07-08)
- [x] `apps/web/src/components/Sidebar.test.tsx`, `AuthCard.test.tsx` — mount-point presence, both themes (BRAND-02) (07-07)
- [x] `tests/unit/brand/favicon-files-present.test.ts` — Next.js file-convention icons present and non-empty (BRAND-02) (07-09)
- [x] `tests/unit/brand/package-exports-resolvable.test.ts` — `@noodara/ui/brand/*` resolvable from outside the package (BRAND-02) (07-06)
- [x] No new test framework install — Vitest/Playwright already configured

---

## Manual-Only Verifications

| Behavior | Requirement | Why Manual | Test Instructions |
|----------|-------------|------------|-------------------|
| Logo seen rendered in real context, both themes | BRAND-03 | Aesthetic judgement is the user's; explicit approval is the requirement | Run `scripts/capture-brand-review.mjs` (rail 64 px, sidebar ≥1280 px, `/login`, `/setup`, light + dark) per concept; review brand boards; pick concept; up to 2 adjustment rounds |
| Favicon legible in the browser tab at 16 px, light and dark tab strips | BRAND-03 | Playwright cannot capture browser chrome | Open `http://localhost:3000` in Chrome and Safari, light and dark OS appearance; check the tab icon |
| Approval recorded before application | BRAND-03 | Gate is a human decision | `docs/brand/APPROVAL.md` contains date, chosen concept, rounds used, approver; no BRAND-02 application task starts before it |

---

## Validation Sign-Off

- [x] All tasks have `<automated>` verify or Wave 0 dependencies
- [x] Sampling continuity: no 3 consecutive tasks without automated verify
- [x] Wave 0 covers all MISSING references
- [x] No watch-mode flags
- [x] Feedback latency < 30s
- [x] `nyquist_compliant: true` set in frontmatter

**Approval:** closed 2026-09-23 (07-10) — every command in the Per-Task Verification Map re-run green
against the finished phase; full command/exit-code table in 07-10-SUMMARY.md.
