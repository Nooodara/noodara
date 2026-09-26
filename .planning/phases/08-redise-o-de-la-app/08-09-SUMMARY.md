---
phase: 08-redise-o-de-la-app
plan: 09
subsystem: ui
tags: [nextjs, parallel-routes, react, playwright, shell, css]

# Dependency graph
requires:
  - phase: 08-redise-o-de-la-app
    provides: "08-07: NavTree/Sidebar's canvas-fused chrome, reused untouched by this plan's aside sibling"
  - phase: 08-redise-o-de-la-app
    provides: "08-08: AccountMenu mounted at the sidebar foot; this plan's shell.spec.ts additions sit alongside its own"
provides:
  - "apps/web/src/app/(shell)/@inspector/default.tsx: the empty default for the parallel-route slot, returns null"
  - "apps/web/src/app/(shell)/layout.tsx: the fourth panel (aside, data-testid=shell-inspector-slot), zero width/border while empty via the has-[>*] CSS variant, 384px column at >=1280px and a solid fixed right panel below 1280px once populated"
  - "tests/e2e/shell.spec.ts: three @shell cases locking the empty-slot cost contract (zero width/border at 1920/1280/1024/375px, main not narrowed, no Sheet/scrim rendered)"
affects: ["08-11", "08-13", "08-14", "08-19", "13"]

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "Content-presence detection via the has-[>*] CSS variant instead of a JS-computed boolean or a React-prop identity check: Next.js's parallel-route slot prop is never the literal value null even when its default.tsx renders null (confirmed empirically -- an inspector !== null check always evaluated true), so only the actually-rendered DOM can answer 'is this slot populated', and :has() answers it without any client-side state at all."
    - "Solid-material fallback when the backdrop-filter budget is exhausted: the below-1280px inspector panel uses bg-surface-elevated (no blur) rather than a fourth translucent surface, since check-ui-safety.mjs's three-surface ceiling was already met by Toolbar/ServerDetailToolbar/Sheet."

key-files:
  created:
    - apps/web/src/app/(shell)/@inspector/default.tsx
  modified:
    - apps/web/src/app/(shell)/layout.tsx
    - tests/e2e/shell.spec.ts

key-decisions:
  - "UI-11 is NOT marked complete. Its full text requires three structural pieces: the inspector slot (this plan), hierarchical Project -> Environment -> Service navigation, and the account menu. NavTree (08-07) is generic-capable but still receives exactly three flat leaves -- Phase 13 is the plan that wires real Project/Environment/Service data, per D-07's own explicit deferral (\"Fase 13 solo pasa datos\"). This plan closes only the inspector-slot piece; requirements-completed is [] below, matching 08-07/08-08's own established precedent for the same requirement."
  - "The plan's own sketched implementation (inspector !== null driving a conditional Tailwind class plus a matchMedia-based useIsDesktopInspector hook) was built, typechecked, and passed pnpm build -- but failed its own new E2E test with a real bug: the aside reserved 384px unconditionally at every viewport, because Next's parallel-route prop is never strictly-equal to the literal value null, even when default.tsx renders it. This was caught by Task 2's RED test (committed as such) and fixed as a separate GREEN commit, replacing the JS identity check with the has-[>*] CSS variant, which inspects the actual rendered DOM instead of the React prop's identity."
  - "The below-1280px presentation is a solid, non-blocking fixed panel, not the shared Sheet component. Two independent constraints ruled out reusing Sheet as originally planned: (1) Sheet.tsx's OVERLAY_CLASSES unconditionally renders a scrim, directly contradicting the brief's own §7.7 rule for exactly this kind of panel (\"un panel paralelo no bloqueante usa translucidez y desplazamiento sin scrim\"); (2) pnpm check:ui-safety's backdrop-filter budget was already at its documented \"at most three\" ceiling (Toolbar, ServerDetailToolbar, Sheet) before this plan touched anything -- adding a fourth translucent surface (Sheet's own blur, reused or not, still counts once per file, but a hand-rolled translucent panel in layout.tsx would count as a new fourth file) would fail that gate outright. The panel is therefore solid surface-elevated with a hairline border, matching the InsetGroup/D-01 house style (elevation by surface step, never a shadow -- the shadow allowlist is Sheet/Dialog/RowMenu/AccountMenu only, and layout.tsx is not on it)."
  - "Since default.tsx always returns null in this phase, the below-1280px branch and the >=1280px 384px-column branch are both currently inert (has-[>*] never matches) -- fully consistent with the plan's own instruction not to build any inspector content. Phase 13 populating the slot is what will first exercise these CSS rules for real; this plan could not visually verify them against real content and documents that gap here rather than silently asserting they are correct."

patterns-established:
  - "Content-presence for a Next.js parallel-route slot is answered by :has(>*) on the slot's own DOM container, never by comparing the slot prop to null -- any future slot (a second parallel route, a nested @inspector under Phase 13's own routes) should reuse this technique rather than reintroducing the same false-positive bug."

requirements-completed: []

# Metrics
duration: ~40min
completed: 2026-09-26
---

# Phase 8 Plan 9: Inspector slot — the shell's empty third panel Summary

**The `@inspector` parallel-route slot now exists on every shell route (`default.tsx` returns `null`), reserving genuinely zero width and no border while empty at every viewport — proven by three new `@shell` Playwright cases — after a real bug (Next's slot prop is never strictly `null`) was caught by the plan's own TDD test and fixed with a `has-[>*]` CSS check instead of a JS prop-identity comparison.**

## Performance

- **Duration:** ~40 min
- **Completed:** 2026-09-26
- **Tasks:** 2
- **Files modified:** 3 (1 created, 2 modified)

## Accomplishments

- `apps/web/src/app/(shell)/@inspector/default.tsx` (new): returns `null`, per D-08.
- `apps/web/src/app/(shell)/layout.tsx`: gained the `inspector` slot prop and a fourth composition sibling, `<aside data-testid="shell-inspector-slot">`. Base classes are `w-0 border-0`, unconditionally. Two `has-[>*]`-gated rule sets (only active once the slot's DOM actually has a child) add: at `>=1280px`, an in-flow `384px` column narrowing `main`; below `1280px`, a fixed right-edge `384px` panel (`bg-surface-elevated`, hairline left border, no blur, no shadow, no overlay element at all). Every existing shell behaviour (session guard, SSE reconnect guard, skip link, `ShellContext`/`TooltipProvider` nesting) is byte-identical to before this plan — verified by diff review and by the full E2E suite passing unchanged.
- `tests/e2e/shell.spec.ts`: three new `@shell` cases. One loops `1920/1280/1024/375px` asserting `shell-inspector-slot` resolves exactly once with `boundingBox().width === 0` and `border-left-width`/`border-right-width === '0px'`. One asserts `main`'s width at `1920px` equals the viewport width minus the sidebar's width (proving the empty slot never narrows content). One asserts no `shell-inspector-sheet` or `shell-sidebar-scrim` element exists when the mobile nav was never opened (no overlay artifact from the empty slot).

## Task Commits

Each task was committed atomically (TDD RED then GREEN where applicable):

1. **Task 1: The parallel slot and the four-part layout** — `3603bb5` (feat) — added `@inspector/default.tsx` and the initial four-part layout (later found to have a real bug, fixed in Task 2's GREEN commit below)
2. **Task 2: Prove the empty slot costs nothing**
   - `cbcc8b1` (test) — failing `@shell` spec proving the empty-slot cost contract; RED for a real reason: the aside reserved 384px unconditionally
   - `00a441a` (fix) — replaced the `inspector !== null` prop-identity check with the `has-[>*]` CSS variant, and moved the below-1280px presentation to a solid, non-Sheet, non-scrim fixed panel

**Plan metadata:** (this commit) — docs: complete plan

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] `inspector !== null` always evaluated `true`, reserving the 384px column unconditionally**
- **Found during:** Task 2's RED test run (the E2E assertion measured `boundingBox().width === 384`, not `0`, at every viewport)
- **Issue:** Next.js's App Router parallel-route slot prop is not the literal JS value `null`, even when the slot's `default.tsx` explicitly `return`s `null` — it is some internal wrapper element that itself renders to nothing. Comparing the prop with `!== null` therefore always evaluates `true`, and the layout's original conditional Tailwind class (`hasInspectorContent ? 'min-[1280px]:w-[384px]' : null`) always applied the 384px width, even though the rendered `<aside>` had zero DOM children.
- **Fix:** Replaced the JS boolean entirely with the `has-[>*]:min-[1280px]:w-[384px]` / `has-[>*]:max-[1279px]:...` Tailwind variants, which use the browser's native `:has()` selector to inspect the aside's actual rendered children — correct regardless of what the framework's internal representation of an "empty" slot is.
- **Files modified:** `apps/web/src/app/(shell)/layout.tsx`
- **Commit:** `00a441a`

**2. [Rule 1 - Bug] The originally planned `<Sheet>` reuse for the below-1280px presentation would have violated D-08's own "no scrim" rule and the repo's backdrop-filter budget**
- **Found during:** Implementing the fix for deviation 1, before committing
- **Issue:** `packages/ui/src/Sheet.tsx`'s `OVERLAY_CLASSES` unconditionally renders a scrim (`fixed inset-0 z-40 bg-canvas/72`) as part of Radix's modal `Dialog` pattern — directly contradicting `docs/ui-build-prompt.md` §7.7's explicit rule for a non-blocking parallel panel ("sin scrim"). Separately, `pnpm check:ui-safety`'s backdrop-filter budget (`expected: 3`) was already met by `Toolbar.tsx`, `ServerDetailToolbar.tsx` and `Sheet.tsx` before this plan touched anything; any new translucent surface in `layout.tsx` would have pushed the count to 4 and failed CI.
- **Fix:** Implemented the below-1280px presentation as a plain, solid (`bg-surface-elevated`, no blur), non-modal fixed panel directly on the `<aside>` element — no Radix `Dialog`, no overlay, no shadow (outside the shadow gate's `Sheet`/`Dialog`/`RowMenu`/`AccountMenu` allowlist) — gated by the same `has-[>*]` variant.
- **Files modified:** `apps/web/src/app/(shell)/layout.tsx`
- **Commit:** `00a441a`

## Rules Not Satisfied

- None. All hard project rules (TDD RED-then-fix, D-08's zero-width/no-border/no-scrim contract, the untouched-shell-logic diff constraint, the `pnpm check:ui-safety` gates staying green without weakening, `@inspector/default.tsx` returning `null`) are satisfied and verified above.

## Known Stubs

- The `>=1280px` 384px column and the below-1280px fixed panel are both structurally present but currently unreachable: `default.tsx` always returns `null`, so `has-[>*]` never matches on any shell route today. This is the explicit, intended scope of this plan (D-08: "esta fase entrega el slot ... no el contenido") — Phase 13 is the plan that populates the slot and will be the first to exercise these CSS rules against real content. Documented here rather than silently assumed correct, since this plan had no real content to verify them against visually.

## Requirements Impact

- UI-11 stays **Pending**. This plan delivers only the inspector-slot piece of UI-11's three-part text (inspector slot, hierarchical Project → Environment → Service nav, account menu). The hierarchical-nav piece is explicitly deferred to Phase 13 (D-07), and the account menu was already shipped in 08-08. `requirements-completed` is `[]`, matching 08-07/08-08's own precedent for this same requirement.

## Verification

- `pnpm typecheck` — 0 errors (all 8 workspace packages)
- `pnpm lint` — 0 errors (all 9 workspace packages)
- `NOODARA_API_ORIGIN=... pnpm --filter @noodara/web build` — succeeds; the `@inspector` parallel route resolves at build time (Next.js 16.3.5, Turbopack)
- `node scripts/check-ui-safety.mjs` — all gates OK, including the backdrop-filter budget at exactly `3` (unchanged) and the shadow allowlist at `0`
- `pnpm test:e2e -- --grep @shell` — 117 passed (full suite grep-filtered to the tag, since `@shell` cases share the suite with `@sse-*` tests in the same file)
- `pnpm test:e2e` (full suite) — **117 passed**, 0 failed
- `pnpm test` (unit, Vitest) — 161 files, 2668 tests passed

## Self-Check: PASSED

- FOUND: `apps/web/src/app/(shell)/@inspector/default.tsx`
- FOUND: `apps/web/src/app/(shell)/layout.tsx`
- FOUND: `tests/e2e/shell.spec.ts`
- FOUND commit: `3603bb5`
- FOUND commit: `cbcc8b1`
- FOUND commit: `00a441a`
