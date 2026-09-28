---
phase: 10
slug: sitio-de-docs-y-landing-p-blica
status: draft
nyquist_compliant: false
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
| **Quick run command** | `pnpm test -- tests/unit/docs tests/unit/site` |
| **Full suite command** | `pnpm test --coverage && pnpm --filter @noodara/site build && pnpm boundaries` |
| **Estimated runtime** | ~90 seconds |

---

## Sampling Rate

- **After every task commit:** Run `pnpm test -- tests/unit/docs tests/unit/site`
- **After every plan wave:** Run `pnpm test --coverage && pnpm --filter @noodara/site build && pnpm boundaries`
- **Before `/gsd:verify-work`:** Full suite must be green, plus `pnpm lint`, `pnpm typecheck`, and a `pnpm ui:review` human approval round
- **Max feedback latency:** 90 seconds

---

## Per-Task Verification Map

| Task ID | Plan | Wave | Requirement | Threat Ref | Secure Behavior | Test Type | Automated Command | File Exists | Status |
|---------|------|------|-------------|------------|-----------------|-----------|-------------------|-------------|--------|
| 10-XX-XX | XX | X | DOCS-01 | — | N/A | build smoke | `pnpm --filter @noodara/site build` | ❌ W0 | ⬜ pending |
| 10-XX-XX | XX | X | DOCS-02 | — | N/A | unit | `pnpm test -- tests/unit/docs/install-docs-accuracy.test.ts` | ✅ (re-point) | ⬜ pending |
| 10-XX-XX | XX | X | DOCS-02 | — | N/A | unit | `pnpm test -- tests/unit/docs/error-codes-accuracy.test.ts` | ❌ W0 | ⬜ pending |
| 10-XX-XX | XX | X | SITE-01 | — | N/A | unit | `pnpm test -- tests/unit/site/landing-claims.test.ts` | ❌ W0 | ⬜ pending |
| 10-XX-XX | XX | X | SITE-01 | — | N/A | unit | `pnpm test -- tests/unit/site/forbidden-words.test.ts` | ❌ W0 | ⬜ pending |
| 10-XX-XX | XX | X | SITE-02 | — | Site cannot import control-plane or domain | static | `pnpm boundaries` | ❌ W0 | ⬜ pending |
| 10-XX-XX | XX | X | SITE-02 | T-10-XX | Workflow actions pinned to commit SHAs | unit | `pnpm test -- tests/unit/scripts/check-workflow-pins.test.ts` | ✅ (extend) | ⬜ pending |
| 10-XX-XX | XX | X | SITE-03 | — | N/A | manual + capture | `pnpm ui:review` (extended for site) | ❌ W0 | ⬜ pending |

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

- [ ] All tasks have `<automated>` verify or Wave 0 dependencies
- [ ] Sampling continuity: no 3 consecutive tasks without automated verify
- [ ] Wave 0 covers all MISSING references
- [ ] No watch-mode flags
- [ ] Feedback latency < 90s
- [ ] `nyquist_compliant: true` set in frontmatter

**Approval:** pending
