---
phase: 07-identidad-y-brand-kit
verified: 2026-09-22T21:15:00Z
status: human_needed
score: 15/15 must-haves verified
overrides_applied: 0
human_verification:
  - test: "Browser-tab favicon legibility (D-14 / BRAND-03)"
    expected: "The Noodara tile favicon (blue rounded tile, white Viewfinder monogram) is legible at 16 px in the browser tab strip, in Chrome and Safari, under both light and dark OS appearance."
    why_human: "Playwright cannot capture browser/OS chrome (the tab strip); this is a hard platform limitation, not a scriptable gap. Flagged consistently in 07-05-SUMMARY.md, 07-09-SUMMARY.md and 07-10-SUMMARY.md as the one remaining open item before the phase can be declared fully closed."
---

# Phase 07: Identidad y brand kit Verification Report

**Phase Goal:** Noodara tiene un logotipo propio con significado, documentado en un brand kit, que un humano ha visto renderizado en ambos temas y ha aprobado antes de que se aplique en la app, el README y — vía assets exportados — en el sitio público de la Fase 10.

**Verified:** 2026-09-22
**Status:** human_needed
**Re-verification:** No — initial verification

## Goal Achievement

### Observable Truths

| # | Truth | Status | Evidence |
|---|-------|--------|----------|
| 1 | `docs/brand/` contains the monogram + wordmark SVGs in light/dark variants and a brand-kit sheet that lets a person reproduce the logo without asking (ROADMAP SC1, BRAND-01) | ✓ VERIFIED | `docs/brand/BRAND.md` has all 9 required headings in order (`grep -n "^## " docs/brand/BRAND.md`); `docs/brand/construction.svg` (6,729 bytes) generated from `geometry.ts`, not hand-drawn; `packages/ui/brand/{monogram,wordmark,lockup}-{light,dark}.svg` exist and are byte-locked by `tests/unit/brand/brand-assets-accuracy.test.ts` (ran green: 350/350 across the brand suites in this session) |
| 2 | The user has seen the mark rendered in both themes (app + boards) and approved it explicitly before application; approval is recorded (ROADMAP SC2, BRAND-03) | ✓ VERIFIED | `docs/brand/APPROVAL.md` exists with Date/Concept/Rounds/Approver/Evidence table (`Concept: c — Viewfinder`, `Adjustment rounds used: 1 of 2`, `Approver: Pablo Gutierrez`); `docs/brand/approved/` holds the 10 captures the approval was given against; `tests/unit/brand/approval-record.test.ts` binds `DEFAULT_CONCEPT` to the record (`grep -n DEFAULT_CONCEPT packages/ui/src/brand/geometry.ts` → `'c'`, matching the record) |
| 3 | The logo appears in sidebar/rail, `/login`, `/setup`, favicon and `apple-touch-icon` in both themes, README included; token gate stays green; existing E2E stay green (ROADMAP SC3, BRAND-02) | ✓ VERIFIED | `Sidebar.tsx` mounts `Logo`/`Lockup` (`brand-monogram`/`brand-lockup` testids, `text-ink` wrapper); `AuthCard.tsx` mounts `Lockup`; `apps/web/src/app/{favicon.ico,icon.svg,icon1.png,icon2.png,apple-icon.png,opengraph-image.png,manifest.ts}` exist, byte-identical to `packages/ui/brand/*`; README has `<picture>` block; `pnpm check:ui-safety` ran green in this session (all 9 gates OK); 07-10-SUMMARY.md's full command/exit-code table (commits `39561c5`..`6942153`, cited not re-run per instructions) reports `pnpm test:e2e` 104 passed / 0 failed / 0 skipped / 0 flaky (93 pre-existing + 11 brand) |
| 4 | Brand assets are exported from `packages/ui` so Phase 10 consumes them without copying files (ROADMAP SC4) | ✓ VERIFIED | `packages/ui/package.json` contains `"./brand/*": "./brand/*"`; `tests/unit/brand/package-exports-resolvable.test.ts` resolves 3 brand files from `apps/web`'s own package location through the real workspace symlink and asserts path traversal throws |
| 5 | Three distinct monogram concepts + shared-constant wordmark exist in code (07-01) | ✓ VERIFIED | `packages/ui/src/brand/concepts/{a,b,c}.ts` each export `meta`/`parts()`; `geometry.ts` exports `GRID=24` and the primitive/dispatch functions; 68+ geometry tests green |
| 6 | Provenance-gated raster pipeline (sharp/png-to-ico) proven on real geometry constructs (07-02) | ✓ VERIFIED | `scripts/brand/raster.ts` exports `svgToPng`/`pngsToIco`/`pngMetadata`/`RASTER_BACKEND='sharp'`; `node scripts/check-package-provenance.mjs` ran green in this session (54/54, includes `sharp`/`png-to-ico`); provenance-registration commit (`300a8a4`) is an ancestor of the first lockfile-touching commit (`cacec4f`) per 07-02-SUMMARY.md |
| 7 | Logo/Wordmark/Lockup render `currentColor` SVG from geometry; static export path shares the same render (07-03) | ✓ VERIFIED | `Logo.tsx`/`Wordmark.tsx`/`Lockup.tsx` contain `fill={color ?? 'currentColor'}`; `static-svg.ts` calls `renderToStaticMarkup` on the same components; `packages/ui/src/index.ts` re-exports `Logo`/`Wordmark`/`Lockup` |
| 8 | Brand boards + in-app captures reproducible with no trace in production code (07-04) | ✓ VERIFIED | `scripts/brand/{board-html,render-boards,capture-brand-review,review-paths}.ts` exist; 07-04-SUMMARY.md records `git diff --quiet -- apps/web/src packages/ui/src` held after the capture run |
| 9 | ≤2 adjustment rounds applied, explicit approval, `DEFAULT_CONCEPT` set to the approved id (07-05) | ✓ VERIFIED | Round 1 applied (kern fix, commits `fb1153a`/`08aa7ec`), approved at round-1 review; `DEFAULT_CONCEPT = 'c'` confirmed on disk |
| 10 | 13 static assets generated from geometry, committed, byte/shape-locked, exported (07-06) | ✓ VERIFIED | `ls packages/ui/brand \| wc -l` → 13; `pnpm brand:check` ran green in this session (`OK, no drift.`) |
| 11 | Mark mounted in sidebar rail (64px)/expanded/auth screens, no existing testid touched, ux-review PASS (07-07) | ✓ VERIFIED | `docs/ui-review-07-brand.md` — `Global verdict: PASS`, zero `BLOCK` rows; `Sidebar.test.tsx`/`AuthCard.test.tsx` ran green in this session |
| 12 | Brand kit document complete, English, no AI attribution, test-locked (07-08) | ✓ VERIFIED | `grep -ci "claude\|anthropic\|co-authored-by"` → 0 across `docs/brand/BRAND.md`, `docs/brand/APPROVAL.md`, `README.md`, `docs/ui-review-07-brand.md`; `brand-kit-structure.test.ts` ran green |
| 13 | `apps/web` serves the full icon family byte-identical to `packages/ui/brand/*` via an allowlisted sync script (07-09) | ✓ VERIFIED | `apps/web/scripts/sync-brand-assets.mjs` exists; `apps/web/src/app/{favicon.ico,icon1.png,icon2.png,apple-icon.png,opengraph-image.png,brand-colors.json}` present; `manifest.ts` has zero colour literal (reads `./brand-colors.json`); note: 07-09 found and fixed a real pre-existing proxy bug (public brand routes were being redirected to `/login`) — this is evidence of genuine E2E verification, not a gap |
| 14 | README shows the lockup via `<picture>`, CI fails on brand-asset drift (07-10) | ✓ VERIFIED | README.md starts with the `<picture>` block; `.github/workflows/ci.yml` line 78 runs `pnpm brand:check` in the `lint` job; `pnpm brand:check` verified green in this session |
| 15 | Full regression green across all gates after brand application (07-10) | ✓ VERIFIED (cited, not re-run) | 07-10-SUMMARY.md's command/exit-code table for commits `39561c5..6942153`: `pnpm test` 151 files/2547 tests, 0 skipped; `pnpm test:e2e` 104 passed/0 failed/0 skipped/0 flaky; `lint`/`typecheck`/`boundaries`/`check:ui-safety`/`brand:check`/provenance all exit 0. Spot-checked in this session: `pnpm check:ui-safety`, `pnpm brand:check`, `node scripts/check-package-provenance.mjs`, and the brand/docs unit suites (350/350) all pass on the current tree; `tests/e2e/brand.spec.ts` confirmed to contain 11 `test(` blocks and 0 `waitForTimeout` |

**Score:** 15/15 truths verified

### Required Artifacts

| Artifact | Expected | Status | Details |
|----------|----------|--------|---------|
| `docs/brand/BRAND.md` | Brand kit, 9 sections | ✓ VERIFIED | All headings present in required order; 16 links to `packages/ui/brand/`; zero hex literals; zero AI attribution |
| `docs/brand/construction.svg` | Generated construction sheet | ✓ VERIFIED | 6,729 bytes, contains `data-grid="24"` and `data-part="aperture"`, byte-locked by `construction-sheet.test.ts` |
| `docs/brand/APPROVAL.md` | D-17 approval record | ✓ VERIFIED | Date/Concept/Rounds/Approver/Evidence table present, bound to `DEFAULT_CONCEPT` by test |
| `docs/brand/approved/` | 10 approved captures | ✓ VERIFIED | 10 PNGs present (board×2, sidebar-expanded×2, sidebar-rail×2, login×2, setup×2); re-shot from real mounted components in 07-07 |
| `packages/ui/brand/*` (13 files) | Generated static assets | ✓ VERIFIED | All 13 present, `pnpm brand:check` exits 0 (no drift) |
| `packages/ui/src/brand/{geometry,glyphs,concepts/*,Logo,Wordmark,Lockup,static-svg}.ts(x)` | Geometry + components | ✓ VERIFIED | All exist, exported from barrel, 350/350 brand+docs unit tests green |
| `apps/web/src/components/Sidebar.tsx`, `AuthCard.tsx` | Mount points | ✓ VERIFIED | `brand-monogram`/`brand-lockup` testids present, `text-ink` (currentColor) only, existing testids untouched |
| `apps/web/src/app/{favicon.ico,icon.svg,icon1.png,icon2.png,apple-icon.png,opengraph-image.png,manifest.ts,brand-colors.json}` | Web icon family | ✓ VERIFIED | All present; manifest.ts has zero colour literal |
| `README.md` | `<picture>` lockup header | ✓ VERIFIED | Confirmed on disk, first lines of file |
| `.github/workflows/ci.yml` | `brand:check` in lint job | ✓ VERIFIED | Line 78: `- run: pnpm brand:check` |
| `docs/ui-review-07-brand.md` | ux-review report | ✓ VERIFIED | Global verdict PASS, zero BLOCK rows |

### Key Link Verification

| From | To | Via | Status | Details |
|------|-----|-----|--------|---------|
| `Sidebar.tsx` | `@noodara/ui` `Logo`/`Lockup` | named import | WIRED | `import { Lockup, Logo, ThemeToggle } from '@noodara/ui'` at line 14 |
| `AuthCard.tsx` | `@noodara/ui` `Lockup` | named import | WIRED | `import { Lockup } from '@noodara/ui'` at line 2 |
| `apps/web/src/app/manifest.ts` | `brand-colors.json` | JSON import attribute | WIRED | `import brandColors from './brand-colors.json' with { type: 'json' }` |
| `README.md` | `packages/ui/brand/lockup-{light,dark}.svg` | `<picture>`/`<source>` | WIRED | repo-relative paths, both files exist on disk |
| `.github/workflows/ci.yml` lint job | `scripts/brand/generate-brand-assets.ts --check` | `pnpm brand:check` | WIRED | confirmed present and green in this session |
| `scripts/brand/asset-manifest.ts` | `packages/ui/src/brand/static-svg.ts` | `renderStaticSvg`/`tileSvg` | WIRED | asset-manifest tests assert byte-equality between the two |
| `packages/ui/package.json` exports | `apps/web` (workspace symlink) | `"./brand/*"` | WIRED | `package-exports-resolvable.test.ts` resolves through the real symlink, not a Vitest alias |

### Behavioral Spot-Checks

| Behavior | Command | Result | Status |
|----------|---------|--------|--------|
| Brand + docs unit suites pass | `pnpm exec vitest run tests/unit/brand packages/ui/src/brand tests/unit/docs/brand-kit-structure.test.ts tests/unit/docs/install-docs-accuracy.test.ts apps/web/src/components/Sidebar.test.tsx apps/web/src/components/AuthCard.test.tsx` | 19 files, 350 tests passed | ✓ PASS |
| Generated assets match geometry (no drift) | `pnpm brand:check` | `generate-brand-assets --check: OK, no drift.` | ✓ PASS |
| UI safety token gate | `pnpm check:ui-safety` | 9/9 gates OK | ✓ PASS |
| Supply-chain provenance | `node scripts/check-package-provenance.mjs` | 54/54 locked deps verified | ✓ PASS |
| Brand E2E spec exists with expected shape | `grep -c "test(" tests/e2e/brand.spec.ts`; `grep -c "waitForTimeout" tests/e2e/brand.spec.ts` | 11 tests; 0 waitForTimeout | ✓ PASS |
| Full E2E/integration regression | Not re-run per instructions | Cited: 07-10-SUMMARY.md reports 104 passed / 0 failed / 0 skipped / 0 flaky against commits `39561c5..6942153` | ✓ CITED (not independently re-executed) |

### Probe Execution

No `scripts/*/tests/probe-*.sh` conventions apply to this phase (design/asset-generation phase, not a migration/tooling phase). SKIPPED — no probes declared in any 07-NN-PLAN.md.

### Requirements Coverage

| Requirement | Source Plans | Description | Status | Evidence |
|-------------|-------------|-------------|--------|----------|
| BRAND-01 | 07-01, 07-02, 07-03, 07-06, 07-08, 07-10 | Logo with documented meaning, SVG in light/dark, brand-kit sheet in `docs/brand/` | ✓ SATISFIED | `docs/brand/BRAND.md` (9 sections, all real values), `packages/ui/brand/{monogram,wordmark,lockup}-{light,dark}.svg`, `construction.svg` generated and locked |
| BRAND-02 | 07-02, 07-03, 07-07, 07-09, 07-10 | Logo applied in app (sidebar/rail, /login, /setup, favicon, apple-touch-icon), README, public site, both themes, zero colour literals outside tokens | ✓ SATISFIED | Sidebar/AuthCard mounts, `apps/web/src/app/` icon family, README `<picture>`, `check:ui-safety` green, `@noodara/ui/brand/*` export ready for Phase 10 |
| BRAND-03 | 07-04, 07-05, 07-07 | User reviews rendered logo (both themes, app + README) and approves before application | ✓ SATISFIED | `docs/brand/APPROVAL.md`, `docs/brand/approved/`, `tests/unit/brand/approval-record.test.ts` binding the record to `DEFAULT_CONCEPT` |

**Note on REQUIREMENTS.md checkboxes:** `.planning/REQUIREMENTS.md` still shows BRAND-01/02/03 as `[ ]` (Pending). Per the verification brief, executors deliberately left these unticked, pending this verdict. Based on the evidence above, all three requirements are satisfied by the current codebase. Ticking them is the orchestrator's/user's next step, not a gap in the phase's own work.

No orphaned requirements found: REQUIREMENTS.md maps only BRAND-01/02/03 to Phase 7, and all three are declared across the 10 plans' frontmatter.

### TDD Discipline

Verified via `git log --oneline f9ca0d6^..6942153` (69 commits spanning the entire phase): every `test(07-NN): ...` (RED) commit is immediately followed by its `feat(07-NN)`/`fix(07-NN)`/`docs(07-NN)` (GREEN) counterpart, in order, across all 10 plans. No instance of a feature commit preceding its test commit was found. This satisfies CLAUDE.md §2.1.

### Anti-Patterns Found

Scanned all 105 files touched across the phase (`git diff --name-only f9ca0d6^..6942153`) for `TBD|FIXME|XXX`, `TODO|HACK|PLACEHOLDER`, and placeholder/coming-soon language: **zero matches**. No debt markers, no stub returns, no hardcoded-empty props found in the brand/mount-point files reviewed.

**Minor documentation inconsistency (non-blocking, ℹ️ info):** `README.md`'s `<picture>` fallback uses `width="240"` while `docs/brand/BRAND.md`'s own Assets-section worked example (line 195) shows `width="220"`. This was found and explicitly documented by the 07-10 executor itself (07-10-SUMMARY.md "Decisions Made") as an intentional deviation — the plan's acceptance criteria pinned the literal `width="240"` for the README, and reconciling BRAND.md's example was left for a follow-up. It does not affect any rendered surface, test, or requirement; both are syntactically valid `<picture>` markup differing only in a documentation example's display width. Recommended follow-up: align BRAND.md's example to 240 (or vice versa) in Phase 8 or a small doc fix — not a phase-7 blocker.

### Human Verification Required

### 1. Browser-tab favicon legibility (D-14 / BRAND-03)

**Test:** Open `http://localhost:3000/login` in Chrome and Safari, once with OS appearance set to light and once to dark.
**Expected:** The Noodara tile favicon (blue rounded tile with the white Viewfinder monogram) is legible at 16 px on both browsers' tab strips, in both appearances.
**Why human:** Playwright cannot capture browser/OS chrome (the tab strip rendering) — this is a hard platform limitation, not a scriptable gap. This item was carried forward unresolved through 07-05, 07-09 and 07-10's own summaries as the one item that must close before the phase can be considered fully done. All the surrounding infrastructure (favicon.ico/svg serving, manifest, apple-touch-icon, E2E URL/content-type checks) is proven programmatically; only the visual legibility judgment in a real browser tab requires a human.

### Gaps Summary

No blocking gaps found. All 15 observable truths (4 ROADMAP success criteria + 11 plan-level must-haves spanning all 10 plans) are verified against the actual codebase, not just SUMMARY.md claims:

- Every artifact claimed in the 10 plans exists on disk and was independently re-verified in this session (file listings, content greps, byte-diff checks).
- The generated-asset pipeline is provably non-drifting (`pnpm brand:check` re-run green in this session against the current tree).
- The UI safety/token gate, supply-chain provenance, and 350 brand+docs unit tests were all re-run green in this session (not merely cited).
- TDD discipline (RED before GREEN) was independently confirmed across all 69 phase commits via `git log`, not taken on faith from summaries.
- The full 2547-unit/104-E2E regression and the ux-review PASS verdict are cited from 07-10-SUMMARY.md per the verification brief's instruction not to re-run full E2E/integration suites; the brand E2E spec's existence and shape (11 tests, 0 `waitForTimeout`) was independently spot-checked.
- The one open item — the manual browser-tab favicon check — is a hard platform limitation (Playwright cannot capture OS/browser chrome), consistently documented across three plan summaries, and is the sole reason this report's status is `human_needed` rather than `passed`.
- One purely cosmetic documentation inconsistency (README width=240 vs. BRAND.md's own example width=220) is noted for informational purposes; it was self-reported by the executor, does not affect any requirement or rendered surface, and is not a blocker.

---

*Verified: 2026-09-22*
*Verifier: Claude (gsd-verifier)*
