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
| 09-01-T1 | 01 | 1 | SET-04/05 | T-09-06 | Cookie codec yields only enum members/defaults | unit | `pnpm exec vitest run packages/domain/src/preferences/preferences.test.ts` | ❌ W0 | ⬜ pending |
| 09-01-T2 | 01 | 1 | SET-02/03 | T-09-03 | account.* metadata allowlist (name / email / sessions_revoked only) | unit | `pnpm exec vitest run packages/domain/src/activity/activity-event.test.ts packages/domain/src/validators/identity.test.ts` | ✅ extend | ⬜ pending |
| 09-02-T1/T2 | 02 | 1 | SET-04/05 | T-09-16 | users.preferences jsonb default '{}' + upgrade backfill; `pnpm db:migrate` applied | integration | `pnpm exec vitest run --config vitest.integration.config.ts tests/integration/db/migrations.test.ts` | ✅ extend | ⬜ pending |
| 09-03-T1 | 03 | 1 | SET-05 | T-09-17 | --row-height token; comfortable unchanged | unit | `pnpm exec vitest run packages/ui/src/ListRow.test.tsx packages/ui/src/Skeleton.test.tsx packages/ui/src/NavTree.test.tsx packages/ui/src/LabelValue.test.tsx` | ✅ extend | ⬜ pending |
| 09-03-T2 | 03 | 1 | SET-05 | — | Compact rows 36px, typography unchanged | E2E | `pnpm test:e2e -- --grep "@density"` | ✅ extend | ⬜ pending |
| 09-04-T1 | 04 | 1 | SET-05 | T-09-19 | data-motion override for motion-safe/motion-reduce (spike + variants) | E2E | `pnpm test:e2e -- --grep "@a11y-fallbacks"` | ✅ extend | ⬜ pending |
| 09-04-T2 | 04 | 1 | SET-05 | — | Sheet gesture follows data-motion | unit + E2E | `pnpm exec vitest run packages/ui/src/use-reduced-motion-preference.test.tsx packages/ui/src/Sheet.test.tsx` | ❌ W0 | ⬜ pending |
| 09-05-T1 | 05 | 1 | SET-02 | T-09-02, T-09-21 | DNS MX/A with 3000 ms timeout, injected resolver, no machine DNS in unit | unit + integration | `pnpm exec vitest run apps/control-plane/src/auth/dns-checker.test.ts` | ❌ W0 | ⬜ pending |
| 09-05-T2 | 05 | 1 | SET-02/03 | T-09-01, T-09-20 | Reauth progressive lockout under reauth:<userId> | integration | `pnpm exec vitest run --config vitest.integration.config.ts tests/integration/account/reauth-guard.test.ts` | ❌ W0 | ⬜ pending |
| 09-06-T1 | 06 | 2 | SET-02 | T-09-13 | Strict schemas; new error codes mapped | unit | `pnpm exec vitest run apps/control-plane/src/routes/account-schemas.test.ts apps/control-plane/src/routes/http-errors.test.ts` | ❌ W0 | ⬜ pending |
| 09-06-T2 | 06 | 2 | SET-02 | T-09-01, T-09-03, T-09-07, T-09-08 | Password verified first; DNS gate; activity has new value only; CSRF 403 | integration | `pnpm exec vitest run --config vitest.integration.config.ts tests/integration/account/profile.test.ts` | ❌ W0 | ⬜ pending |
| 09-07-T1 | 07 | 2 | SET-04/05 | T-09-25 | applyPreferences is the single browser writer | unit | `pnpm exec vitest run packages/ui/src/ThemeToggle.test.tsx` | ✅ extend | ⬜ pending |
| 09-07-T2 | 07 | 2 | SET-04 | T-09-06, T-09-24 | SSR data-theme from cookie; no flash with and without JS | unit + E2E | `pnpm test:e2e -- --grep "@theme-first-paint"` | ❌ W0 | ⬜ pending |
| 09-08-T1/T2 | 08 | 3 | SET-04/05 | T-09-07, T-09-13, T-09-26 | Preferences persisted server-side; mirror cookie on every response; no activity | unit + integration | `pnpm exec vitest run --config vitest.integration.config.ts tests/integration/account/preferences.test.ts` | ❌ W0 | ⬜ pending |
| 09-09-T1 | 09 | 4 | SET-03 | T-09-10, T-09-27 | Better Auth contract pinned; revoked session → 401 SESSION_REVOKED_PASSWORD_CHANGED | unit + integration | `pnpm exec vitest run apps/control-plane/src/auth/require-session.test.ts` | ✅ extend | ⬜ pending |
| 09-09-T2 | 09 | 4 | SET-03 | T-09-01, T-09-04, T-09-05 | v0.1 policy; other sessions revoked, current kept; no token in body | integration | `pnpm exec vitest run --config vitest.integration.config.ts tests/integration/account/password.test.ts` | ❌ W0 | ⬜ pending |
| 09-09-T3 | 09 | 4 | SET-02/03/04 | T-09-03, T-09-05 | Canary: no password/hash/token in bodies, headers, logs, activity | integration | `pnpm security:scan-leaks` | ❌ W0 | ⬜ pending |
| 09-10-T1 | 10 | 3 | SET-02/03 | T-09-28, T-09-30 | Fixed copy only; reason-aware redirect | unit | `pnpm exec vitest run apps/web/src/lib/error-copy.test.ts apps/web/src/lib/require-session.test.ts` | ✅ extend | ⬜ pending |
| 09-10-T2 | 10 | 3 | SET-02/04 | T-09-29 | Shared store: refresh on demand (D-04), server wins (D-10) | unit | `pnpm exec vitest run apps/web/src/lib/session-user.test.ts` | ✅ extend | ⬜ pending |
| 09-10-T3 | 10 | 3 | SET-03 | T-09-12 | /login password-changed Notice; banner never silent | E2E | `pnpm test:e2e -- --grep "@auth"` | ✅ extend | ⬜ pending |
| 09-11-T1/T2 | 11 | 4 | SET-02/03 | T-09-14, T-09-28 | Sheets confirm current password; passwords cleared on close | unit | `pnpm exec vitest run apps/web/src/lib/account-form.test.ts apps/web/src/components/AccountProfileSheet.test.tsx apps/web/src/components/AccountPasswordSheet.test.tsx` | ❌ W0 | ⬜ pending |
| 09-12-T1 | 12 | 5 | SET-06 | T-09-32 | `SettingsRow` rejects `onEdit` (`@ts-expect-error`) | unit (type) | `pnpm exec vitest run apps/web/src/lib/settings-rows.test.ts && pnpm typecheck` | ✅ extend | ⬜ pending |
| 09-12-T2/T3 | 12 | 5 | SET-04/05 | T-09-25, T-09-33 | Appearance on single write path; revert on failure | unit + E2E | `pnpm exec vitest run apps/web/src/lib/appearance.test.ts apps/web/src/components/SettingsGroups.test.tsx && pnpm test:e2e -- --grep "@shell"` | ❌ W0 / ✅ extend | ⬜ pending |
| 09-13-T1 | 13 | 6 | SET-02/03/06 | T-09-04, T-09-35 | Profile edit reflected; second context revoked → /login?reason=password-changed | E2E | `pnpm exec playwright test tests/e2e/settings.spec.ts -g "profile edit|password change revokes|read-only"` | ✅ extend | ⬜ pending |
| 09-13-T2 | 13 | 6 | SET-04/05 | — | No theme flash; override wins over OS; second browser; motion; density | E2E | `pnpm exec playwright test tests/e2e/settings.spec.ts -g "theme|reduce motion|density"` | ✅ extend | ⬜ pending |
| 09-14-T1 | 14 | 7 | all | T-09-03, T-09-36 | UX review + full gate + security review | gate | `pnpm lint && pnpm typecheck && pnpm test && pnpm test:integration && pnpm test:e2e && pnpm boundaries && pnpm security:scan-leaks && pnpm check:ui-safety` | — | ⬜ pending |
| 09-14-T2 | 14 | 7 | SET-02..06 | — | Human visual approval, both themes | manual | checkpoint:human-verify | — | ⬜ pending |

*Status: ⬜ pending · ✅ green · ❌ red · ⚠️ flaky*

---

## Wave 0 Requirements

- [ ] `tests/integration/account/profile.test.ts` covers the SET-02 service and route (service tested through Testcontainers, per the edit-server precedent)
- [ ] `apps/control-plane/src/auth/dns-checker.test.ts` — SET-02 DNS check with injected fake resolver (09-05)
- [ ] `packages/domain/src/preferences/preferences.test.ts` — SET-04/05 preferences schema, defaults, cookie codec (09-01)
- [ ] `tests/integration/account/profile.test.ts` — SET-02 against Testcontainers Postgres
- [ ] `tests/integration/account/password.test.ts` — SET-03 session revocation via real Better Auth
- [ ] `tests/e2e/settings.spec.ts` (09-13) and `tests/e2e/theme-first-paint.spec.ts` (09-07): profile edit, password change + second-context revocation, no-flash theme, density
- [ ] `apps/web/src/lib/settings-rows.test.ts` — `@ts-expect-error` proof for SET-06
- [ ] Contract test pinning better-auth 1.7.4 `changePassword` (09-09 T1). Source already read: it deletes all sessions, mints a new session and cookie, returns `{ token, user }` with no count, and a wrong password throws INVALID_PASSWORD. The revoked count is computed by us before the call
- [ ] Spike verifying Tailwind v4 `@custom-variant` multi-`@slot` grammar for `motion-safe`/`motion-reduce` OR-combined with `[data-motion]` (09-04 T1 step 1, with a documented fallback)

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
