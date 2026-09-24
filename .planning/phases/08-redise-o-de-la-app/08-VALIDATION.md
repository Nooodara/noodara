---
phase: 08
slug: redise-o-de-la-app
status: draft
nyquist_compliant: true
wave_0_complete: true
created: 2026-09-23
---

# Phase 08 — Validation Strategy

> Per-phase validation contract for feedback sampling during execution.
> Derived from `08-RESEARCH.md` §Validation Architecture. The Task ID / Plan / Wave columns were back-filled once the 20 PLAN.md files existed.

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
- **Accepted long-running verifies:** four tasks use the full `pnpm test:e2e` (08-08 T3, 08-11 T1) or `pnpm test:e2e:repeat` (08-19 T1) as their `<automated>` command. These are deliberate wave/gate-boundary samples — testid rewrites across three specs and the two blocking human gates have no faster honest signal, and the 20× repeat run *is* success criterion 5's acceptance evidence. Each carries a rationale comment in its `<verify>` block.

---

## Per-Task Verification Map

| Task ID | Plan | Wave | Requirement | Threat Ref | Secure Behavior | Test Type | Automated Command | File Exists | Status |
|---------|------|------|-------------|------------|-----------------|-----------|-------------------|-------------|--------|
| 08-01 T1 | 08-01 | 1 | UI-12 | — | N/A | unit | `pnpm exec vitest run tests/unit/ui/review-paths.test.ts` | ❌ W0 (created here) | ⬜ pending |
| 08-01 T2 | 08-01 | 1 | UI-12 | — | Capture script writes only to gitignored `docs/ui/review/` | static | `pnpm typecheck` | ❌ W0 (created here) | ⬜ pending |
| 08-01 T3 | 08-01 | 1 | UI-12 | T-08-02 | Pin test fails on any AI-attribution string or fixture credential under `docs/ui/` | unit | `pnpm exec vitest run tests/unit/ui/approval-record.test.ts` | ❌ W0 (created here) | ⬜ pending |
| 08-02 T1 | 08-02 | 2 | UI-12 | T-08-02 | Baseline captures contain no fixture credential, hostname or email | unit | `pnpm exec vitest run tests/unit/ui/approval-record.test.ts` | ✅ | ⬜ pending |
| 08-02 T2 | 08-02 | 2 | UI-12 | — | N/A | **human gate G1** | `<human-check>` — blocking checkpoint | ✅ | ⬜ pending |
| 08-02 T3 | 08-02 | 2 | UI-12 | — | N/A | unit | `pnpm exec vitest run tests/unit/ui/approval-record.test.ts` | ✅ | ⬜ pending |
| 08-03 T1 | 08-03 | 3 | UI-03, UI-12 | — | N/A | unit | `pnpm exec vitest run packages/ui/src/contrast.test.ts` (dark floating surface step still AA, derived loop not a hand-written pair) | ✅ extend | ⬜ pending |
| 08-03 T2 | 08-03 | 3 | UI-03 | — | N/A | static gate | `pnpm exec vitest run tests/unit/scripts/check-ui-safety.test.ts` (shadow allowlist: Sheet/Dialog/RowMenu/AccountMenu only) then `pnpm check:ui-safety` | ❌ W0 (gate added here) | ⬜ pending |
| 08-03 T3 | 08-03 | 3 | UI-10 | — | N/A | static gate | `pnpm exec vitest run tests/unit/scripts/check-ui-safety.test.ts` (worst-case simultaneous `backdrop-filter` count ≤ 3) | ❌ W0 (gate added here) | ⬜ pending |
| 08-04 T1 | 08-04 | 3 | UI-05 | T-08-12, T-08-13 | Close-source listeners are capture-phase read-only, removed on cleanup; Radix escape hatches stay at `count=0` | unit | `pnpm exec vitest run packages/ui/src/use-close-source.test.tsx packages/ui/src/use-floating-menu.test.tsx` | ❌ W0 (created here) | ⬜ pending |
| 08-04 T2 | 08-04 | 3 | UI-04 | T-08-14 | Destructive item still routes to the typed-name confirmation; no authorization path changes | unit | `pnpm exec vitest run packages/ui/src/RowMenu.test.tsx` (close-on-select, `aria-expanded`, stable keys) | ✅ extend | ⬜ pending |
| 08-04 T3 | 08-04 | 3 | UI-04 | — | N/A | E2E | `pnpm test:e2e -- --grep @rowmenu` (focus return, touch-visible trigger) | ✅ extend `servers-list.spec.ts` | ⬜ pending |
| 08-05 T1 | 08-05 | 4 | UI-11 | — | N/A | unit | `pnpm exec vitest run packages/ui/src/InsetGroup.test.tsx` | ❌ W0 (created here) | ⬜ pending |
| 08-05 T2 | 08-05 | 4 | UI-11, UI-12 | — | N/A | unit | `pnpm exec vitest run apps/web/src/components/ServerFacts.test.tsx apps/web/src/components/SettingsGroups.test.tsx` | ✅ extend | ⬜ pending |
| 08-05 T3 | 08-05 | 4 | UI-11 | — | N/A | unit | `pnpm exec vitest run apps/web/src/components/ServerList.test.tsx` | ✅ extend | ⬜ pending |
| 08-06 T1 | 08-06 | 4 | UI-03 | — | N/A | unit | `pnpm exec vitest run packages/ui/src/Sheet.test.tsx packages/ui/src/Dialog.test.tsx packages/ui/src/RowMenu.test.tsx` | ✅ extend | ⬜ pending |
| 08-06 T2 | 08-06 | 4 | UI-10 | — | N/A | unit (`matchMedia` mocked) | `pnpm exec vitest run packages/ui/src/Sheet.test.tsx packages/ui/src/Dialog.test.tsx packages/ui/src/RowMenu.test.tsx` (reduced-transparency / contrast-more / hover gating) | ⚠ partial, add cases | ⬜ pending |
| 08-06 T3 | 08-06 | 4 | UI-10 | — | N/A | E2E | `pnpm test:e2e -- --grep @a11y-fallbacks` | ❌ W0 (created here) | ⬜ pending |
| 08-07 T1 | 08-07 | 5 | UI-11, UI-07 | — | N/A | unit | `pnpm exec vitest run packages/ui/src/NavTree.test.tsx` | ❌ W0 (created here) | ⬜ pending |
| 08-07 T2 | 08-07 | 5 | UI-11 | — | N/A | unit | `pnpm exec vitest run apps/web/src/components/Sidebar.test.tsx` | ✅ extend | ⬜ pending |
| 08-07 T3 | 08-07 | 5 | UI-11, UI-07 | — | N/A | E2E | `pnpm test:e2e -- --grep @shell` | ✅ extend | ⬜ pending |
| 08-08 T1 | 08-08 | 6 | UI-11, UI-04 | — | `AccountMenu` theme control writes only via `ThemeToggle`'s single `noodara-theme` write path | unit | `pnpm exec vitest run packages/ui/src/AccountMenu.test.tsx` | ❌ W0 (created here) | ⬜ pending |
| 08-08 T2 | 08-08 | 6 | UI-11 | — | Session identity read server-side; no credential reaches the menu | unit | `pnpm exec vitest run apps/web/src/lib/session-user.test.ts apps/web/src/components/Sidebar.test.tsx` | ✅ extend | ⬜ pending |
| 08-08 T3 | 08-08 | 6 | UI-11 | — | N/A | E2E (**wave-boundary sample, multi-minute — rationale in `<verify>`**) | `pnpm test:e2e` (testids updated in `shell`/`canary-ui`/`brand` specs; fast loop `--grep @shell`) | ✅ extend (Pitfall 4) | ⬜ pending |
| 08-09 T1 | 08-09 | 7 | UI-11 | — | Session guard, SSE reconnect guard and skip link untouched | static | `pnpm typecheck` | ✅ | ⬜ pending |
| 08-09 T2 | 08-09 | 7 | UI-11 | — | N/A | E2E | `pnpm test:e2e -- --grep @shell` (`@inspector` slot empty = no width/border) | ✅ extend | ⬜ pending |
| 08-10 T1 | 08-10 | 7 | UI-07 | — | N/A | unit | `pnpm exec vitest run apps/web/src/components/Toolbar.test.tsx` | ❌ W0 (created here) | ⬜ pending |
| 08-10 T2 | 08-10 | 7 | UI-10 | — | N/A | unit (`matchMedia` mocked) | `pnpm exec vitest run apps/web/src/components/Toolbar.test.tsx` | ❌ W0 (created here) | ⬜ pending |
| 08-10 T3 | 08-10 | 7 | UI-07 | — | N/A | E2E (computed style) | `pnpm test:e2e -- --grep @scroll-edge` | ❌ W0 (created here) | ⬜ pending |
| 08-11 T1 | 08-11 | 8 | UI-12 | — | N/A | E2E (**gate-boundary sample, multi-minute — rationale in `<verify>`**) | `pnpm test:e2e` (≥117 passing before the gate opens) | ✅ | ⬜ pending |
| 08-11 T2 | 08-11 | 8 | UI-12, UI-04, UI-10 | — | N/A | **human gate G2** | `<human-check>` — blocking checkpoint incl. real screen-reader verification | ✅ | ⬜ pending |
| 08-11 T3 | 08-11 | 8 | UI-12 | — | N/A | unit | `pnpm exec vitest run tests/unit/ui/approval-record.test.ts` | ✅ | ⬜ pending |
| 08-12 T1 | 08-12 | 9 | UI-06 | T-08-03 | `motion` passes `scripts/check-package-provenance.mjs`, no postinstall, ADR-0000 updated, exact pin, `packages/ui` only | static | `node scripts/check-package-provenance.mjs` | ✅ | ⬜ pending |
| 08-12 T2 | 08-12 | 9 | UI-06, UI-05 | T-08-31, T-08-34, T-08-37 | `LazyMotion strict` throws on leaked usage; `use-close-source.ts` imported, never edited; Radix escape hatches stay at `count=0` | unit | `pnpm exec vitest run packages/ui/src/Sheet.test.tsx` | ✅ extend | ⬜ pending |
| 08-12 T3 | 08-12 | 9 | UI-06 | T-08-33 | N/A | E2E (pointer simulation) | `pnpm test:e2e -- --grep @sheet-drag` (§7.4: rubber-band, momentum, handoff, interrupt) | ❌ W0 extend `server-sheet.spec.ts` | ⬜ pending |
| 08-13 T1 | 08-13 | 9 | UI-05, UI-10 | T-08-38 | Disabled controls receive neither the press transform nor the dim | unit | `pnpm exec vitest run packages/ui/src/press.test.ts` | ❌ W0 (created here) | ⬜ pending |
| 08-13 T2 | 08-13 | 9 | UI-05 | T-08-35 | Compositor-only `transform`, `motion-safe:` gated, no layout property animated | unit | `pnpm exec vitest run packages/ui/src/Button.test.tsx packages/ui/src/ListRow.test.tsx` (+ CopyButton/FileButton/SegmentedControl by grep) | ✅ extend | ⬜ pending |
| 08-20 T1 | 08-20 | 10 | UI-05 | T-08-37 | `press.ts` imported, never edited (`git diff --name-only` criterion) | unit | `pnpm exec vitest run packages/ui/src/RowMenu.test.tsx packages/ui/src/AccountMenu.test.tsx` | ✅ extend | ⬜ pending |
| 08-20 T2 | 08-20 | 10 | UI-05 | T-08-34, T-08-36, T-08-37 | Keyboard branch reads the shared `closeSource`; `onEscapeKeyDown`/`onInteractOutside` stay at `count=0`; typed-name destructive gate untouched | unit | `pnpm exec vitest run packages/ui/src/Dialog.test.tsx packages/ui/src/RowMenu.test.tsx packages/ui/src/AccountMenu.test.tsx` | ✅ extend | ⬜ pending |
| 08-20 T3 | 08-20 | 10 | UI-05 | — | N/A | E2E | `pnpm test:e2e -- --grep @keyboard-no-animation` (all four overlays, Esc vs pointer positive control) | ❌ W0 (created here) | ⬜ pending |
| 08-15 T1 | 08-15 | 10 | UI-09 | — | N/A | unit | `pnpm exec vitest run packages/ui/src/EmptyState.test.tsx` (tabular numerals, `text-wrap`, 70ch measure) | ✅ extend | ⬜ pending |
| 08-15 T2 | 08-15 | 10 | UI-09 | — | N/A | unit | `pnpm exec vitest run packages/ui/src/Skeleton.test.tsx` (blur bridge, `@starting-style`) | ✅ extend | ⬜ pending |
| 08-15 T3 | 08-15 | 10 | UI-09 | — | N/A | unit | `pnpm exec vitest run packages/ui/src/StatTile.test.tsx` (`clip-path` disk meter, tabular-nums) | ✅ extend | ⬜ pending |
| 08-14 T1 | 08-14 | 11 | UI-07 | — | N/A | unit | `pnpm exec vitest run packages/ui/src/Tooltip.test.tsx packages/ui/src/RowMenu.test.tsx packages/ui/src/AccountMenu.test.tsx packages/ui/src/Dialog.test.tsx` | ✅ extend | ⬜ pending |
| 08-14 T2 | 08-14 | 11 | UI-07 | — | N/A | unit | `pnpm exec vitest run packages/ui/src/Disclosure.test.tsx packages/ui/src/Tooltip.test.tsx` (`grid-template-rows` animation) | ✅ extend | ⬜ pending |
| 08-14 T3 | 08-14 | 11 | UI-05, UI-07 | — | N/A | unit + static count | `pnpm exec vitest run packages/ui/src/StatusPill.test.tsx` (+ built-in easing sweep: no `ease-in`, no `transition: all`) | ✅ extend | ⬜ pending |
| 08-18 T1 | 08-18 | 11 | UI-08, UI-07 | — | N/A | unit | `pnpm exec vitest run apps/web/src/components/AuthCard.test.tsx` (one-shot aperture focus) | ✅ extend | ⬜ pending |
| 08-18 T2 | 08-18 | 11 | UI-08, UI-09 | — | N/A | unit | `pnpm exec vitest run apps/web/src/lib/discovery-progress.test.ts apps/web/src/components/DiscoveryStep.test.tsx` (ring state derives only from `buildChecklist`) | ✅ extend | ⬜ pending |
| 08-18 T3 | 08-18 | 11 | UI-08 | — | N/A | E2E | `pnpm test:e2e -- --grep discovery` (timeline + ring tied to run state) | ✅ extend | ⬜ pending |
| 08-16 T1 | 08-16 | 12 | UI-07 | — | N/A | unit | `pnpm exec vitest run apps/web/src/components/ServerList.test.tsx` (40 ms stagger, first load only) | ✅ extend | ⬜ pending |
| 08-16 T2 | 08-16 | 12 | UI-07 | — | §7.8 merge-not-reset contract of the activity list unchanged | unit | `pnpm exec vitest run apps/web/src/components/ActivityList.test.tsx` | ✅ extend | ⬜ pending |
| 08-16 T3 | 08-16 | 12 | UI-07, UI-08 | — | N/A | E2E (DOM order / computed style) | `pnpm test:e2e -- --grep "@stagger\|@activity-entry"` | ✅ extend | ⬜ pending |
| 08-17 T1 | 08-17 | 12 | UI-08 | T-08-01 | `Fingerprint` renders hashes only, never credentials; diff marked by weight, never colour | unit | `pnpm exec vitest run packages/ui/src/Fingerprint.test.tsx` | ❌ W0 (created here) | ⬜ pending |
| 08-17 T2 | 08-17 | 12 | UI-08, UI-09 | T-08-01 | Same component on all three TOFU surfaces — one redaction rule, not three | unit | `pnpm exec vitest run apps/web/src/components/FirstTrustNotice.test.tsx apps/web/src/components/ServerFacts.test.tsx` | ✅ extend | ⬜ pending |
| 08-17 T3 | 08-17 | 12 | UI-08 | — | §9 #18: host-key-changed dialog still requires typing the exact server name | E2E | `pnpm test:e2e -- --grep host-key` (old/new diff, exact-name confirm intact) | ✅ extend | ⬜ pending |
| 08-19 T1 | 08-19 | 13 | UI-12 | T-08-02, T-08-03 | Full gate battery incl. `check-package-provenance`, `check-ui-safety`, `boundaries`, contrast audit | E2E (**gate-boundary sample, 20× repeat — rationale in `<verify>`**) | `pnpm test:e2e:repeat` (preceded by `pnpm test:e2e` ≥135) | ✅ | ⬜ pending |
| 08-19 T2 | 08-19 | 13 | UI-12, UI-08, UI-06, UI-10 | — | N/A | **human gate G3** | `<human-check>` — blocking checkpoint incl. brand-swap test and live drag review | ✅ | ⬜ pending |
| 08-19 T3 | 08-19 | 13 | UI-12 | T-08-02 | Approved captures pinned; no AI-attribution string and no fixture credential under `docs/ui/` | unit | `pnpm exec vitest run tests/unit/ui/approval-record.test.ts` | ✅ | ⬜ pending |

*Status: ⬜ pending · ✅ green · ❌ red · ⚠️ flaky*

**Sampling continuity check:** no three consecutive tasks in any plan lack an automated verify. The only tasks without `<automated>` are the three blocking human gates (08-02 T2, 08-11 T2, 08-19 T2), each of which is immediately preceded and followed by a task carrying one.

---

## Wave 0 Requirements

All items below are created by the plan and task named beside them; none is a dangling MISSING reference.

- [x] `scripts/check-ui-safety.mjs` — shadow-outside-allowlist gate (UI-03) and `backdrop-filter` worst-case count (UI-10) → **08-03 T2 / T3**
- [x] `packages/ui/src/use-close-source.test.tsx` + `use-floating-menu.test.tsx` — the shared close-source primitive UI-05 / P14 depends on → **08-04 T1**
- [x] `packages/ui/src/InsetGroup.test.tsx` — stubs for D-01 / D-02 → **08-05 T1**
- [x] `tests/e2e/a11y-fallbacks.spec.ts` — `@a11y-fallbacks` reduced-motion / transparency / contrast cases (UI-10) → **08-06 T3**
- [x] `packages/ui/src/NavTree.test.tsx` — stubs for UI-11 / D-07 → **08-07 T1**
- [x] `packages/ui/src/AccountMenu.test.tsx` — stubs for UI-11 / D-05 → **08-08 T1**
- [x] `tests/e2e/shell.spec.ts`, `canary-ui.spec.ts`, `brand.spec.ts` — `shell-theme-toggle` / `shell-sign-out` assertions updated for the `AccountMenu` DOM shape, in the same plan as `AccountMenu` → **08-08 T3**
- [x] `apps/web/src/components/Toolbar.test.tsx` + `@scroll-edge` E2E — first toolbar tests (UI-07 / UI-10) → **08-10 T1 / T2 / T3**
- [x] `tests/e2e/server-sheet.spec.ts` — `@sheet-drag` cases for the full §7.4 sequence (UI-06) → **08-12 T3**
- [x] `packages/ui/src/press.test.ts` — the one press definition's contract test (UI-05 / UI-10) → **08-13 T1**
- [x] `tests/e2e/keyboard-motion.spec.ts` — `@keyboard-no-animation` spec across all four overlays (UI-05 / P14) → **08-20 T3**
- [x] `packages/ui/src/Fingerprint.test.tsx` — stubs for UI-08 / D-10 → **08-17 T1**
- [x] `docs/ui/APPROVAL.md`, `docs/ui/approved/`, `docs/ui/review/` (gitignored), `tests/unit/ui/approval-record.test.ts` — D-12 / D-13 / D-15 scaffold, mirrors `docs/brand/` → **08-01 T3**
- [x] `scripts/ui/capture-ui-review.ts` + `scripts/ui/review-paths.ts` — 6 screens × 2 themes × 4 widths + overlays with the D-12 fixture states → **08-01 T1 / T2**

Existing infrastructure (Vitest `dom` project, Playwright + sshd fixture, `contrast.ts`, `check-ui-safety.mjs`, `check-package-provenance.mjs`) covers everything else.

---

## Manual-Only Verifications

| Behavior | Requirement | Why Manual | Test Instructions |
|----------|-------------|------------|-------------------|
| `RowMenu` / `AccountMenu` announce `aria-expanded` and menu role with a real screen reader | UI-04 | jsdom/Playwright cannot verify real AT output (ADR-0005 c) | G2 (08-11 T2): VoiceOver on macOS — open menu from keyboard and pointer, confirm "expanded/collapsed" and item announcements; record in `docs/ui/APPROVAL.md` |
| Sheet drag feel: 1:1 tracking, rubber-band, momentum, mid-flight re-grab | UI-06 | Motion's elastic/momentum defaults vs brief constants only judgeable by hand (research open question) | G2/G3 (08-11 T2, 08-19 T2): `pnpm dev` + fixture, drag at real speed and in DevTools slow-mo; touch device on LAN if available (§7.10) |
| Viewfinder ring "focusing" reads as understanding, not a spinner; brand-swap test on discovery narration and TOFU block | UI-08 | Authored-moment judgement is human | G3 (08-19 T2): replace logo mentally with a competitor's — moment must still be recognisably Noodara; ring stops where a failed/partial run stops |
| Screenshots approved in both themes at 375/900/1280/1920 px | UI-12 | Explicit product decision by the user (D-13) | G1 (08-02 T2) baseline → G2 (08-11 T2) direction → G3 (08-19 T2) final; ≤2 adjustment rounds per gate; approved 1280 px set committed under `docs/ui/approved/` |
| Motion in live app at real speed vs reduced-motion alternative | UI-10 | Perceptual | G3 (08-19 T2): toggle `prefers-reduced-motion` in DevTools rendering panel; toolbar/sheet/dialog/menu each show an intentional fallback, not a broken one |

---

## Validation Sign-Off

- [x] All tasks have `<automated>` verify or Wave 0 dependencies — the only exceptions are the three blocking `checkpoint:human-verify` gates, which carry `<human-check>` by design
- [x] Sampling continuity: no 3 consecutive tasks without automated verify
- [x] Wave 0 covers all MISSING references — every item above names the plan and task that creates it
- [x] No watch-mode flags
- [x] Feedback latency < 30s (unit / static); E2E only at wave boundaries, with the four long-running exceptions documented under Sampling Rate and annotated in their own `<verify>` blocks
- [x] `nyquist_compliant: true` set in frontmatter

**Approval:** validation contract complete — 20 plans, 13 waves, 58 tasks mapped.
