---
phase: 09
slug: settings-editables
status: draft
nyquist_compliant: false
wave_0_complete: false
created: 2026-09-27
---

# Phase 09 — Validation Strategy

> Per-phase validation contract for feedback sampling during execution.
> Derived from `09-RESEARCH.md` §Validation Architecture. The Task ID / Plan / Wave columns are back-filled once the PLAN.md files exist.

---

## Test Infrastructure

| Property | Value |
|----------|-------|
| **Framework** | Vitest (unit; jsdom `dom` project for `packages/ui`; Testcontainers + Supertest for integration) + Playwright (`tests/e2e/*.spec.ts`) + static gates in `scripts/` |
| **Config file** | `vitest.config.ts` (root + apps/packages), `playwright.config.ts` |
| **Quick run command** | `pnpm exec vitest run <changed-test-file>` |
| **Full suite command** | `pnpm test && pnpm test:integration && pnpm test:e2e` (+ `pnpm lint && pnpm typecheck`, `pnpm boundaries`, `pnpm security:scan-leaks`, `pnpm check:ui-safety`) |
| **Estimated runtime** | ~20 s unit · ~2 min integration (Testcontainers Postgres) · ~6–8 min E2E |

---

## Sampling Rate

- **After every task commit:** Run `pnpm exec vitest run <changed test file>`; `pnpm check:ui-safety` when CSS/tokens change.
- **After every plan wave:** Run `pnpm test && pnpm test:integration && pnpm lint && pnpm typecheck`; `pnpm test:e2e` after any wave touching `packages/ui`, root layout or `/login`.
- **Before `/gsd:verify-work`:** Full suite green, plus `pnpm boundaries` (domain purity — no `node:dns` in `packages/domain`) and `pnpm security:scan-leaks` (password confirmation + preference cookie paths).
- **Max feedback latency:** 30 s for unit / static gates; integration and E2E only at wave boundaries.

---

## Per-Task Verification Map

| Task ID | Plan | Wave | Requirement | Threat Ref | Secure Behavior | Test Type | Automated Command | File Exists | Status |
|---------|------|------|-------------|------------|-----------------|-----------|-------------------|-------------|--------|
| TBD | TBD | TBD | SET-02 | T-09-01 | Name/email edit rejects wrong current password; password verified before any other check | unit | `pnpm exec vitest run apps/control-plane/src/services/update-account-profile.test.ts` | ❌ W0 | ⬜ pending |
| TBD | TBD | TBD | SET-02 | T-09-02 | Email domain with no MX/A rejected; DNS check has explicit timeout; resolver injected (never machine DNS) | unit | `pnpm exec vitest run apps/control-plane/src/auth/dns-checker.test.ts` | ❌ W0 | ⬜ pending |
| TBD | TBD | TBD | SET-02 | T-09-03 | Profile update persists; `account.name_changed` / `account.email_changed` carry only the new value | integration | `pnpm exec vitest run tests/integration/account/profile.test.ts` | ❌ W0 | ⬜ pending |
| TBD | TBD | TBD | SET-02 | — | Shell (`AccountMenu`) reflects new name/email without reload | E2E | `pnpm exec playwright test tests/e2e/settings.spec.ts -g "profile edit"` | ❌ W0 | ⬜ pending |
| TBD | TBD | TBD | SET-03 | T-09-04 | Password change under v0.1 policy revokes other sessions, keeps current one | integration | `pnpm exec vitest run tests/integration/account/password.test.ts` | ❌ W0 | ⬜ pending |
| TBD | TBD | TBD | SET-03 | T-09-05 | `account.password_changed` metadata carries only `sessions_revoked`, never hash/token | unit | `pnpm exec vitest run packages/domain/src/activity/activity-event.test.ts` | ✅ extend | ⬜ pending |
| TBD | TBD | TBD | SET-03 | — | Second browser context redirected to `/login?reason=password-changed` with Notice | E2E | `pnpm exec playwright test tests/e2e/settings.spec.ts -g "password change revokes"` | ❌ W0 | ⬜ pending |
| TBD | TBD | TBD | SET-04 | T-09-06 | `noodara-prefs` cookie value re-validated by Zod; invalid → defaults | unit | `pnpm exec vitest run packages/domain/src/validators/preferences.test.ts` | ❌ W0 | ⬜ pending |
| TBD | TBD | TBD | SET-04 | — | SSR HTML carries correct `data-theme`; no background-color change in first frames | E2E | `pnpm exec playwright test tests/e2e/settings.spec.ts -g "no theme flash"` | ❌ W0 | ⬜ pending |
| TBD | TBD | TBD | SET-04 | — | Manual override wins over OS; server wins over local mirror in a second context | E2E | `pnpm exec playwright test tests/e2e/settings.spec.ts -g "theme"` | ❌ W0 | ⬜ pending |
| TBD | TBD | TBD | SET-05 | — | Reduce-motion System/On/Off gates `motion-safe:`/`motion-reduce:` via `data-motion` | E2E | `pnpm exec playwright test tests/e2e/a11y-fallbacks.spec.ts -g "forced reduce motion preference"` | ✅ extend | ⬜ pending |
| TBD | TBD | TBD | SET-05 | — | Density compact changes `--row-height` only (44→36 px); typography/spacing unchanged | unit + E2E | `pnpm exec vitest run packages/ui/src/ListRow.test.tsx`; `pnpm exec playwright test tests/e2e/settings.spec.ts -g "density"` | ✅ extend / ❌ W0 | ⬜ pending |
| TBD | TBD | TBD | SET-06 | — | `SettingsRow` type rejects an `onEdit` prop (`@ts-expect-error`) | unit (type test) | `pnpm exec vitest run apps/web/src/lib/settings-rows.test.ts` + `pnpm typecheck` | ❌ W0 | ⬜ pending |

*Status: ⬜ pending · ✅ green · ❌ red · ⚠️ flaky*

---

## Wave 0 Requirements

- [ ] `apps/control-plane/src/services/update-account-profile.test.ts` — stubs for SET-02
- [ ] `apps/control-plane/src/auth/dns-checker.test.ts` — SET-02 DNS check with injected fake resolver
- [ ] `packages/domain/src/validators/preferences.test.ts` — SET-04/05 preferences schema and defaults
- [ ] `tests/integration/account/profile.test.ts` — SET-02 against Testcontainers Postgres
- [ ] `tests/integration/account/password.test.ts` — SET-03 session revocation via real Better Auth
- [ ] `tests/e2e/settings.spec.ts` — profile edit, password change + second-context revocation, no-flash theme, density
- [ ] `apps/web/src/lib/settings-rows.test.ts` — `@ts-expect-error` proof for SET-06
- [ ] Spike (scratch integration test) answering RESEARCH Open Questions #1/#2: real `changePassword` response and wrong-password error shape on better-auth 1.7.4, before Notice copy / error mapping is written
- [ ] Spike verifying Tailwind v4 `@custom-variant` grammar for `motion-safe`/`motion-reduce` OR-combined with `[data-motion]`

---

## Manual-Only Verifications

| Behavior | Requirement | Why Manual | Test Instructions |
|----------|-------------|------------|-------------------|
| Screenshots of `/settings` in light and dark themes at desktop and 375 px (human UI gate, `docs/ui/APPROVAL.md`) | SET-02..SET-05 | Visual quality floor is a human judgment | Load `/settings` in both themes; confirm Account and Appearance groups, segmented controls, Sheet forms; attach captures to HUMAN-UAT |
| Reduce motion on a real OS setting vs forced preference | SET-05 | OS-level `prefers-reduced-motion` toggling is not scriptable in all runners | Toggle OS setting with preference at System; then force On/Off and confirm Sheet falls back to no-gesture |

---

## Validation Sign-Off

- [ ] All tasks have `<automated>` verify or Wave 0 dependencies
- [ ] Sampling continuity: no 3 consecutive tasks without automated verify
- [ ] Wave 0 covers all MISSING references
- [ ] No watch-mode flags
- [ ] Feedback latency < 30s
- [ ] `nyquist_compliant: true` set in frontmatter

**Approval:** pending
