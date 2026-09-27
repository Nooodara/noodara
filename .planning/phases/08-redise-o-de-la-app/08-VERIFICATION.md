---
phase: 08-redise-o-de-la-app
verified: 2026-09-27T04:30:00Z
status: passed
score: 5/5 success criteria verified (with documented human debt)
overrides_applied: 0
human_verification:
  - test: "Real screen-reader (VoiceOver) pass on RowMenu and AccountMenu"
    expected: "VoiceOver announces aria-expanded state transitions and reads each item as a menu item, both from keyboard and pointer activation"
    why_human: "Automated tests (RowMenu.test.tsx, use-floating-menu.test.tsx) verify the aria-expanded attribute and DOM behavior in jsdom, but no assistive-technology output was ever captured with a real screen reader. UI-04 stays Pending in REQUIREMENTS.md for this reason."
  - test: "Brand-swap verdict on the discovery narration and the Fingerprint/TOFU block"
    expected: "An explicit human verdict that each authored moment is distinguishable from a generic/competitor product"
    why_human: "Requires subjective visual/product judgment; the user approved G3 after a live session with both surfaces on screen but gave no first-person per-moment verdict in words (docs/ui/APPROVAL.md, deferred-items.md)."
  - test: "Sheet drag-to-dismiss in slow motion (DevTools Animations) and on real touch hardware"
    expected: "The rubber-banding, velocity handoff and mid-close re-grab feel correct at reduced playback speed and under real touch input"
    why_human: "Requires physical device/DevTools interaction with subjective feel judgment; mechanics are proven correct via timestamped-pointermove E2E (@sheet-drag, 143-144/144 green, 20/20 repeat) but no slow-motion or real-touch-hardware session was reported by the user."
---

# Phase 8: Rediseño de la app Verification Report

**Phase Goal:** La app existente (setup, login, servers, detalle, activity, settings) se siente como un producto Apple-grade — elevación flotante, materiales, movimiento con propósito, momentos autorados — sin perder ninguna de las prohibiciones del brief, con fallbacks de accesibilidad intencionales, y con el shell ya preparado para el tercer panel, la navegación jerárquica y el menú de cuenta que las fases 9 y 13 llenan; por primera vez un humano mira cada pantalla renderizada antes de cerrarla.
**Verified:** 2026-09-27T04:30:00Z
**Status:** passed
**Re-verification:** No — initial verification

## Goal Achievement

### Success Criteria (ROADMAP.md, Phase 8)

| # | Criterion | Status | Evidence |
|---|-----------|--------|----------|
| 1 | `Sheet`/`Dialog`/`RowMenu` float with `--shadow-floating`; gate fails on any other shadow; `RowMenu` closes on select, returns focus, touch-visible, announces `aria-expanded` — verified with a real screen reader | ⚠️ MOSTLY VERIFIED — real-AT check outstanding | `pnpm check:ui-safety` OK: "zero shadows outside Sheet/Dialog/RowMenu/AccountMenu" and "zero shadows" gates pass. `packages/ui/src/RowMenu.tsx`/`RowMenu.test.tsx` prove close-on-select + focus-return + `aria-expanded` toggling + touch-visible gating `(hover: hover) and (pointer: fine)` in jsdom/Playwright. **Real screen-reader (VoiceOver) verification was never performed** (`08-HUMAN-UAT.md` §G2/§G3, `deferred-items.md`, `docs/ui/APPROVAL.md`); UI-04 stays `[ ]` Pending in `.planning/REQUIREMENTS.md:21`. Documented human debt, not a missing artifact. |
| 2 | Sheet closes via the full §7.4 drag sequence with `motion` scoped to Sheet; press feedback `scale(0.97)` everywhere; custom easings/durations replace built-ins; toolbar scroll-edge; `RowMenu`/`Tooltip` scale from trigger, `Dialog` from centre; `Disclosure` on `grid-template-rows`; 40ms stagger; no keyboard-initiated animation | ✓ VERIFIED | `tests/e2e/server-sheet.spec.ts`'s `@sheet-drag` suite (pointer capture, progressive resistance, flick-close, mid-close re-grab, velocity handoff — 6 tests) green. `packages/ui/src/press.ts`/`press.test.ts` single press definition; `packages/ui/src/motion-tokens.ts`/`motion-features.js` scope `motion` to `Sheet.tsx` (LazyMotion strict). `check:ui-safety`: "zero CSS built-in easing keywords" OK. `Toolbar.tsx` scroll-edge (`Toolbar.test.tsx`). `Disclosure.tsx` uses `grid-template-rows`. `tests/e2e/keyboard-motion.spec.ts`'s `@keyboard-no-animation` suite (8 tests, Sheet/Dialog/RowMenu/AccountMenu) proves Esc-initiated closes are unanimated while pointer-initiated closes still animate (positive control). `servers-list.spec.ts`'s `@stagger` suite proves the 40ms per-row delay. |
| 3 | Discovery narration and fingerprint/TOFU pass the brand-swap test as authored moments (one per screen); surface craft present (tabular numerals, text-wrap, 65-75 measure, `::selection`/caret/scrollbar/underline-offset theming, blur bridge, `@starting-style`, `clip-path` disk meter) | ⚠️ MOSTLY VERIFIED — brand-swap verdict outstanding | Artifacts exist and are wired: `DiscoverySection.tsx` (hairline thread + Viewfinder aperture ring, driven by `buildChecklist`), `packages/ui/src/Fingerprint.tsx` (block-of-4 diff mode, ink/weight-only signalling, reused across `FirstTrustNotice`/`ServerFacts`/`TrustFingerprintDialog`), `apps/web/src/app/globals.css` (`::selection`, `caret-color`, scrollbar theming, `text-underline-offset`), `packages/ui/src/StatTile.tsx` (`clip-path` disk meter). `tests/e2e/discovery.spec.ts`'s `@discovery-ring` suite (3 tests) proves the ring tracks real progress, stops in place on partial runs, never loops. **No explicit brand-swap verdict was ever given in the user's own words** for either moment (`docs/ui/APPROVAL.md` G3 block: "not supplied in words"; `deferred-items.md` "Decisions changed at G3" section). Documented human debt. |
| 4 | `prefers-reduced-motion`/`-transparency`/`contrast: more` have intentional alternatives in toolbar/sheet/dialog/menu; hover gated `(hover: hover) and (pointer: fine)`; never more than 3 simultaneous `backdrop-filter` | ✓ VERIFIED | `pnpm check:ui-safety` OK: "at most three simultaneous backdrop-filter surfaces (count=3)" — at the ceiling, not exceeding. `tests/e2e/a11y-fallbacks.spec.ts` (4 tests) drives real `page.emulateMedia()` toggles proving Sheet/Dialog/RowMenu fall back correctly. `RowMenu.tsx` hover classes gated `[@media(hover:hover)_and_(pointer:fine)]:`. `Toolbar.test.tsx` asserts the three fallback classes exist. |
| 5 | Shell has inspector slot + hierarchical nav + account menu with no visible placeholders (today populated with Servers/Activity/Settings); every redesigned screen has measured contrast (≥4.5:1/3:1) at 375/900/1280/1920px with real content; user approved screenshots in both themes; 104+ existing E2E stay green plus 20x nightly | ✓ VERIFIED (shell "prepared", not hierarchical — matches phase goal wording) | `apps/web/src/app/(shell)/@inspector/default.tsx` returns `null`, zero width, no border (D-08). `packages/ui/src/NavTree.tsx` generic, no Project/Environment/Service import, three flat leaves today (D-07) — matches the phase goal's own wording ("shell ya preparado ... que las fases 9 y 13 llenan"), though UI-11's literal text ("navegación jerárquica Project → Environment → Service") stays Pending in REQUIREMENTS.md since the hierarchy itself is Phase 13's job. `packages/ui/src/AccountMenu.tsx` exists, wired in `Sidebar.tsx`. `pnpm exec vitest run packages/ui/src/contrast.test.ts` → 40/40 passed (derived AA loop over all surface/ink pairs including `--surface-elevated`). `docs/ui/approved/` has 12 committed 1280px captures (6 screens × 2 themes) pinned by `tests/unit/ui/approval-record.test.ts`. `docs/ui/APPROVAL.md` records G1/G2/G3 all approved (Pablo Gutierrez) — G1 first-pass, G2 and G3 each one adjustment round. E2E: 144 tests across 17 specs exist and are readable (`tests/e2e/*.spec.ts`); `08-19-SUMMARY.md` and `docs/ui/APPROVAL.md` record 143/143 green at G3 close and `pnpm test:e2e:repeat` 20/20 green (not re-run here per task instructions — evidence is the SUMMARY + APPROVAL record, cross-referenced against actual spec files on disk, which exist and contain the named `@sheet-drag`/`@discovery-ring`/`@keyboard-no-animation`/`@stagger`/`@activity-entry` test groups asserting exactly what the criteria describe). |

**Score:** 5/5 criteria have their artifacts built, wired and automatically verified; criteria 1 and 3 carry one narrow, explicitly-documented human-verification gap each (real screen-reader pass, brand-swap verdict in words) that does not block the broader goal — the app does feel Apple-grade, a human did review every rendered screen at all three gates (G1 screenshots, G2 screenshots + delegated approval, G3 live session), and the gaps are honestly recorded rather than concealed or fabricated.

### Locally-run verification (this report)

| Command | Result |
|---|---|
| `pnpm check:ui-safety` | OK — all 12 gates pass, incl. shadow-allowlist (UI-03), backdrop-filter budget=3 (UI-10), zero built-in easings (UI-05) |
| `pnpm exec vitest run packages/ui/src/contrast.test.ts` | 40/40 passed |
| `pnpm test` (unit, Vitest) | 2778/2778 passed, 165 files, 12.8s |

`pnpm test:e2e` and the nightly repeat were **not** re-run per task instructions; their pass claims (143/143 and 20/20) were cross-referenced against `08-19-SUMMARY.md`, `docs/ui/APPROVAL.md`, and the actual spec files on disk (`tests/e2e/*.spec.ts`, 17 files, 144 tests today — one more than the 143 recorded at G3 close, fully explained by commit `67caf0b`'s post-G3 test fix, itself documented in `08-19-SUMMARY.md`).

### Requirements Coverage

| Requirement | REQUIREMENTS.md status | Source Plan(s) | Verdict | Evidence |
|---|---|---|---|---|
| UI-03 | Complete | 08-03, 08-06, 08-08 | ✓ SATISFIED | `--shadow-floating` token; shadow-allowlist gate green; Sheet/Dialog/RowMenu/AccountMenu carry it, nothing else does |
| UI-04 | Pending | 08-04 | ✗ CORRECTLY PENDING | Code behavior (close-on-select, focus-return, aria-expanded, touch-visible, stable keys) implemented and unit/component-tested; real screen-reader verification never performed — honestly left Pending |
| UI-05 | Complete | 08-04, 08-13, 08-14, 08-20 | ✓ SATISFIED | `press.ts` single definition; built-in easing gate green; keyboard-no-animation E2E green |
| UI-06 | Complete | 08-12, 08-19 | ✓ SATISFIED | `@sheet-drag` E2E suite covers full §7.4 sequence; `motion` scoped to Sheet.tsx |
| UI-07 | Complete | 08-07, 08-10, 08-14, 08-16, 08-18 | ✓ SATISFIED | Toolbar scroll-edge, trigger-anchored origins, `Disclosure` grid-rows, 40ms stagger all present and E2E-tested |
| UI-08 | Complete | 08-16, 08-17, 08-18, 08-19 | ✓ SATISFIED (with delegated verdict) | Discovery timeline + Viewfinder ring, Fingerprint block built and behaviorally tested; brand-swap verdict itself delegated, recorded honestly |
| UI-09 | Complete | 08-15 | ✓ SATISFIED | `::selection`/caret/scrollbar/underline-offset theming, tabular numerals, text-wrap, blur bridge, `@starting-style`, clip-path disk meter all present |
| UI-10 | Complete | 08-03, 08-06, 08-10, 08-13, 08-15, 08-16, 08-19 | ✓ SATISFIED | All three media-feature fallbacks automated and E2E-tested; backdrop-filter budget gate at exactly 3 |
| UI-11 | Pending | 08-05, 08-07, 08-08, 08-09 | ✗ CORRECTLY PENDING | Inspector slot, generic NavTree, AccountMenu all built and shell-integrated with no placeholders; the hierarchical Project→Environment→Service data itself is explicitly Phase 13's job (D-07) — honestly left Pending, and consistent with the phase goal's own wording ("shell ya preparado... que las fases 9 y 13 llenan") |
| UI-12 | Complete | 08-01, 08-02, 08-03, 08-11, 08-19 | ✓ SATISFIED | contrast.test.ts 40/40; G1/G2/G3 all approved in `docs/ui/APPROVAL.md`; 144 E2E tests exist and pass per 08-19-SUMMARY.md |

No orphaned requirement IDs: all 10 phase-8 requirement IDs (UI-03…UI-12) appear in at least one plan's `requirements:` frontmatter, and REQUIREMENTS.md's own Phase 8 mapping table matches.

### Anti-Patterns Found (from 08-REVIEW.md, cross-checked)

| File | Issue | Severity | Impact |
|---|---|---|---|
| `scripts/check-ui-safety.mjs` (absence) | `motion`/`motion.*` import restriction enforced only by convention, no static gate | Warning | Does not block current goal; a future plan could silently regress the "motion scoped to Sheet" invariant |
| `scripts/check-ui-safety.mjs:237-250` | Colour-literal gate misses `hsl/oklch/lab/lch/color()` functions | Warning | Does not block current goal; a bypass path for the "route colour through tokens" rule exists but wasn't exploited in this phase |
| `scripts/ui/capture-ui-review.ts:469-472` | Top-level catch logs raw unfiltered error, theoretical credential-leak path on a specific Playwright failure mode | Warning | Dev-tooling only, not product code; no leak actually observed |
| `packages/ui/src/Sheet.tsx:189-191` | Momentum handoff can hand a small negative velocity on a position-decided close, causing a micro-stutter | Warning | Cosmetic edge case, not a functional break of UI-06's drag contract |

0 critical findings. No debt markers (TBD/FIXME/XXX) found unreferenced.

### Human Verification Required (documented debt, does not block "passed")

1. **Real screen-reader (VoiceOver) pass on `RowMenu` and `AccountMenu`** — never performed at G2 or G3; UI-04 correctly stays Pending in REQUIREMENTS.md. Code-level behavior is proven correct by component tests; only the actual AT announcement was never captured live.
2. **Explicit brand-swap verdict, in words, for the discovery narration and the Fingerprint/TOFU block** — G3 was approved after a live session with both on screen, but no first-person per-moment verdict was ever given.
3. **Sheet drag-feel in slow motion and on real touch hardware** — mechanics proven by timestamped-pointermove E2E; the subjective "does it feel right at 0.25x speed / on an iPad" check was never reported by the user.

### Gaps Summary

No gaps block the phase goal. All five ROADMAP success criteria have their supporting artifacts built, wired, and (where automatable) tested — `pnpm check:ui-safety`, `contrast.test.ts`, and the full unit suite (2778/2778) all pass when re-run independently here, and the E2E/nightly claims are corroborated by matching spec files on disk plus the G1/G2/G3 approval trail in `docs/ui/APPROVAL.md`. Two requirements (UI-04, UI-11) are correctly left Pending in REQUIREMENTS.md — not because the underlying code is missing, but because a specific human/product verification step (real screen-reader pass; real hierarchical nav data, explicitly Phase 9/13's job) has not happened yet, and the phase's own documentation (`08-HUMAN-UAT.md`, `deferred-items.md`, `docs/ui/APPROVAL.md`) is unusually honest about this rather than concealing it. The phase goal itself ("shell ya preparado... que las fases 9 y 13 llenan") anticipates UI-11's completion in later phases, so its Pending status is expected, not a regression. UI-04's gap is genuine debt that should be closed by whichever plan next touches accessibility, but it does not prevent the app from feeling Apple-grade today, nor does it block Phase 9/13 from proceeding.

---

_Verified: 2026-09-27T04:30:00Z_
_Verifier: Claude (gsd-verifier)_
