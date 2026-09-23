---
phase: 08
slug: redise-o-de-la-app
status: draft
nyquist_compliant: false
wave_0_complete: false
created: 2026-09-23
---

# Phase 08 — Validation Strategy

> Per-phase validation contract for feedback sampling during execution.
> Derived from `08-RESEARCH.md` §Validation Architecture. The planner fills the Task ID / Plan / Wave columns when PLAN.md files exist.

---

## Test Infrastructure

| Property | Value |
|----------|-------|
| **Framework** | Vitest (jsdom `dom` project for `packages/ui` component tests, ADR-0005) + Playwright (`tests/e2e/*.spec.ts`, 15 specs / 104 tests) + static gates in `scripts/` |
| **Config file** | `vitest.config.ts` (root, `dom` project), `playwright.config.ts` |
| **Quick run command** | `pnpm exec vitest run <changed-test-file>` |
| **Full suite command** | `pnpm test` + `pnpm test:e2e` (+ `pnpm lint && pnpm typecheck`, `pnpm check:ui-safety`) |
| **Estimated runtime** | ~20 s unit · ~6–8 min E2E (Testcontainers sshd fixture) · nightly `pnpm test:e2e:repeat` 20× |

---

## Sampling Rate

- **After every task commit:** Run `pnpm exec vitest run <changed test file>` (component-level RED→GREEN cycle) and `pnpm check:ui-safety` when CSS/tokens change.
- **After every plan wave:** Run `pnpm test` + `pnpm test:e2e` (full Playwright — mandatory after any plan that touches `packages/ui`, Pitfall P16).
- **Before each human gate (G1/G2/G3):** `pnpm test:e2e` green + `noodara-ux-review` audit on every redesigned screen.
- **Before `/gsd:verify-work`:** Full suite green **and** `pnpm test:e2e:repeat` (20×) green (success criterion 5).
- **Max feedback latency:** 30 s for unit / static gates; E2E only at wave boundaries.

---

## Per-Task Verification Map

| Task ID | Plan | Wave | Requirement | Threat Ref | Secure Behavior | Test Type | Automated Command | File Exists | Status |
|---------|------|------|-------------|------------|-----------------|-----------|-------------------|-------------|--------|
| TBD | TBD | TBD | UI-03 | — | N/A | static gate | `pnpm check:ui-safety` (shadow allowlist: Sheet/Dialog/RowMenu/AccountMenu only) | ❌ W0 | ⬜ pending |
| TBD | TBD | TBD | UI-03 | — | N/A | unit | `pnpm exec vitest run packages/ui/src/contrast.test.ts` (dark floating surface step still AA) | ✅ extend | ⬜ pending |
| TBD | TBD | TBD | UI-04 | — | N/A | unit | `pnpm exec vitest run packages/ui/src/RowMenu.test.tsx` (close-on-select, `aria-expanded`, stable keys) | ✅ extend | ⬜ pending |
| TBD | TBD | TBD | UI-04 | — | N/A | E2E | `pnpm test:e2e -- --grep @rowmenu` (focus return, touch-visible trigger) | ✅ extend `servers-list.spec.ts` | ⬜ pending |
| TBD | TBD | TBD | UI-05 | — | N/A | unit + E2E | `pnpm exec vitest run packages/ui/src/Button.test.tsx` (+ CopyButton/FileButton/SegmentedControl press state) | ✅ extend | ⬜ pending |
| TBD | TBD | TBD | UI-05 | — | N/A | E2E | `pnpm test:e2e -- --grep @keyboard-no-animation` | ❌ W0 | ⬜ pending |
| TBD | TBD | TBD | UI-06 | — | N/A | E2E (pointer simulation) | `pnpm test:e2e -- --grep @sheet-drag` (§7.4 sequence: rubber-band, momentum, handoff, interrupt) | ❌ W0 extend `server-sheet.spec.ts` | ⬜ pending |
| TBD | TBD | TBD | UI-06 | T-08-03 | `motion` passes `scripts/check-package-provenance.mjs`, no postinstall, ADR-0000 updated | static | `node scripts/check-package-provenance.mjs` | ✅ | ⬜ pending |
| TBD | TBD | TBD | UI-07 | — | N/A | unit | `pnpm exec vitest run packages/ui/src/Disclosure.test.tsx` (`grid-template-rows` animation) | ✅ extend | ⬜ pending |
| TBD | TBD | TBD | UI-07 | — | N/A | E2E (computed style / DOM order) | `pnpm test:e2e -- --grep shell` (toolbar scroll-edge, 40 ms stagger order) | ✅ extend | ⬜ pending |
| TBD | TBD | TBD | UI-08 | — | N/A | unit | `pnpm exec vitest run apps/web/src/lib/discovery-progress.test.ts` (ring state derives only from `buildChecklist`) | ✅ extend | ⬜ pending |
| TBD | TBD | TBD | UI-08 | — | N/A | E2E | `pnpm test:e2e -- --grep discovery` (timeline + ring tied to run state) | ✅ extend | ⬜ pending |
| TBD | TBD | TBD | UI-08 | T-08-01 | `Fingerprint` renders hashes only, never credentials; diff marked by weight, never color | unit | `pnpm exec vitest run packages/ui/src/Fingerprint.test.tsx` | ❌ W0 | ⬜ pending |
| TBD | TBD | TBD | UI-08 | — | N/A | E2E | `pnpm test:e2e -- --grep host-key` (`TrustFingerprintDialog` old/new diff, exact-name confirm intact) | ✅ extend | ⬜ pending |
| TBD | TBD | TBD | UI-09 | — | N/A | unit | `pnpm exec vitest run packages/ui/src/StatTile.test.tsx` (`clip-path` disk meter, tabular-nums) | ✅ extend | ⬜ pending |
| TBD | TBD | TBD | UI-09 | — | N/A | static gate | `pnpm check:ui-safety` (no hex/rgb outside tokens for `::selection`/`caret-color`/scrollbar) | ✅ | ⬜ pending |
| TBD | TBD | TBD | UI-10 | — | N/A | unit (`matchMedia` mocked) | `pnpm exec vitest run packages/ui/src/Sheet.test.tsx packages/ui/src/Dialog.test.tsx packages/ui/src/RowMenu.test.tsx` (reduced-motion / reduced-transparency / contrast-more branches) | ⚠ partial, add cases | ⬜ pending |
| TBD | TBD | TBD | UI-10 | — | N/A | static count | `grep -rn "backdrop-filter\|backdrop-blur" packages/ui/src apps/web/src` ≤ 3 permanent+overlay worst case (scripted in gate) | ❌ W0 | ⬜ pending |
| TBD | TBD | TBD | UI-11 | — | N/A | unit | `pnpm exec vitest run packages/ui/src/NavTree.test.tsx packages/ui/src/AccountMenu.test.tsx packages/ui/src/InsetGroup.test.tsx` | ❌ W0 | ⬜ pending |
| TBD | TBD | TBD | UI-11 | — | `AccountMenu` theme control writes only via `ThemeToggle` write path (`noodara-theme`) | E2E | `pnpm test:e2e -- --grep shell` (`@inspector` slot empty = no width/border; testids updated in `shell/canary-ui/brand` specs) | ✅ extend (Pitfall 4) | ⬜ pending |
| TBD | TBD | TBD | UI-12 | T-08-02 | Baseline/approved captures contain no fixture credential, hostname or email | unit | `pnpm exec vitest run tests/unit/ui/approval-record.test.ts` (pinned approved set + no-AI-attribution + no-secret strings under `docs/ui/`) | ❌ W0 | ⬜ pending |
| TBD | TBD | TBD | UI-12 | — | N/A | unit | `pnpm exec vitest run packages/ui/src/contrast.test.ts` (every redesigned surface ≥4.5:1 body, ≥3:1 large/borders, both themes) | ✅ extend | ⬜ pending |
| TBD | TBD | TBD | UI-12 | — | N/A | E2E | `pnpm test:e2e` (104 existing green) + `pnpm test:e2e:repeat` (20×) | ✅ | ⬜ pending |

*Status: ⬜ pending · ✅ green · ❌ red · ⚠️ flaky*

---

## Wave 0 Requirements

- [ ] `scripts/check-ui-safety.mjs` — extend with shadow-outside-allowlist gate (UI-03) and `backdrop-filter` worst-case count (UI-10)
- [ ] `packages/ui/src/Fingerprint.test.tsx` — stubs for UI-08 / D-10
- [ ] `packages/ui/src/AccountMenu.test.tsx` — stubs for UI-11 / D-05
- [ ] `packages/ui/src/NavTree.test.tsx` — stubs for UI-11 / D-07
- [ ] `packages/ui/src/InsetGroup.test.tsx` — stubs for D-01 / D-02
- [ ] `tests/e2e/server-sheet.spec.ts` — `@sheet-drag` cases for the full §7.4 sequence (UI-06)
- [ ] `tests/e2e/*.spec.ts` — `@keyboard-no-animation` tag/spec (UI-05 / P14)
- [ ] `tests/e2e/shell.spec.ts`, `canary-ui.spec.ts`, `brand.spec.ts` — update `shell-theme-toggle` / `shell-sign-out` assertions for the `AccountMenu` DOM shape (must land in the same plan as `AccountMenu`)
- [ ] `docs/ui/APPROVAL.md`, `docs/ui/approved/`, `docs/ui/review/` (gitignored), `tests/unit/ui/approval-record.test.ts` — D-12 / D-13 / D-15 scaffold, mirrors `docs/brand/`
- [ ] `scripts/ui/capture-ui-review.ts` (or extension of `scripts/brand/capture-brand-review.ts`) — 6 screens × 2 themes × 4 widths + overlays with the D-12 fixture states

Existing infrastructure (Vitest `dom` project, Playwright + sshd fixture, `contrast.ts`, `check-ui-safety.mjs`, `check-package-provenance.mjs`) covers everything else.

---

## Manual-Only Verifications

| Behavior | Requirement | Why Manual | Test Instructions |
|----------|-------------|------------|-------------------|
| `RowMenu` / `AccountMenu` announce `aria-expanded` and menu role with a real screen reader | UI-04 | jsdom/Playwright cannot verify real AT output (ADR-0005 c) | G2: VoiceOver on macOS — open menu from keyboard and pointer, confirm "expanded/collapsed" and item announcements; record in `docs/ui/APPROVAL.md` |
| Sheet drag feel: 1:1 tracking, rubber-band, momentum, mid-flight re-grab | UI-06 | Motion's elastic/momentum defaults vs brief constants only judgeable by hand (research open question) | G2/G3: `pnpm dev` + fixture, drag at real speed and in DevTools slow-mo; touch device on LAN if available (§7.10) |
| Viewfinder ring "focusing" reads as understanding, not a spinner; brand-swap test on discovery narration and TOFU block | UI-08 | Authored-moment judgement is human | G3: replace logo mentally with a competitor's — moment must still be recognisably Noodara; ring stops where a failed/partial run stops |
| Screenshots approved in both themes at 375/900/1280/1920 px | UI-12 | Explicit product decision by the user (D-13) | G1 baseline → G2 direction → G3 final; ≤2 adjustment rounds per gate; approved 1280 px set committed under `docs/ui/approved/` |
| Motion in live app at real speed vs reduced-motion alternative | UI-10 | Perceptual | G3: toggle `prefers-reduced-motion` in DevTools rendering panel; toolbar/sheet/dialog/menu each show an intentional fallback, not a broken one |

---

## Validation Sign-Off

- [ ] All tasks have `<automated>` verify or Wave 0 dependencies
- [ ] Sampling continuity: no 3 consecutive tasks without automated verify
- [ ] Wave 0 covers all MISSING references
- [ ] No watch-mode flags
- [ ] Feedback latency < 30s (unit / static); E2E only at wave boundaries
- [ ] `nyquist_compliant: true` set in frontmatter

**Approval:** pending
