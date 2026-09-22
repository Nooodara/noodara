---
phase: 07-identidad-y-brand-kit
plan: 01
subsystem: ui
tags: [brand, svg, geometry, monogram, wordmark, vitest, tdd]

# Dependency graph
requires:
  - phase: 05-ui-web
    provides: packages/ui with the tokens gate (check:ui-safety), the pure-module pattern of contrast.ts and the packages vitest project
provides:
  - "packages/ui/src/brand/geometry.ts: the single geometric definition of the Noodara mark (24-unit grid constants, filled-outline primitives, concept dispatch, wordmark layout, lockup layout)"
  - "Three distinct monogram constructions (a Aperture, b Focus, c Viewfinder), each an uppercase N with a stable `aperture` part"
  - "The lowercase wordmark 'noodara' drawn from the same constants (glyphs.ts)"
  - "68 unit tests pinning grid, command set, bounds, part order, distinctness, determinism and the D-05/D-08 constant sharing"
affects: [07-02, 07-03, 07-04, 07-05, 07-06, 07-08, 07-10, phase-08-redesign, phase-10-site]

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "Pure geometry module with zero I/O, imported identically by React components, a Node generator script and its own tests"
    - "Filled outlines with the stroke baked into the path; the SVG default (nonzero) fill rule, with ring counters cut by opposite winding"
    - "fmt(): three-decimal, no-negative-zero number formatting so rendered SVG is byte-stable across machines"
    - "Safe import cycle: geometry.ts and concepts/*.ts + glyphs.ts import each other, but only function bindings cross the cycle and only from inside function bodies"

key-files:
  created:
    - packages/ui/src/brand/geometry.ts
    - packages/ui/src/brand/geometry.test.ts
    - packages/ui/src/brand/glyphs.ts
    - packages/ui/src/brand/concepts/a.ts
    - packages/ui/src/brand/concepts/b.ts
    - packages/ui/src/brand/concepts/c.ts
  modified: []

key-decisions:
  - "STROKE 3 and APERTURE_RADIUS 6 (the plan's starting values were 4 and 5): 6 makes X_HEIGHT = 2 * APERTURE_RADIUS = 12 exactly, which is the plan's own pinned x-height, so every round letter fills the x-height band and sits on the baseline; at STROKE 4 the aperture counter was 1 unit wide and invisible below ~48px, and the wordmark's stem/x-height ratio was 0.40 (ultra-black) against D-07's 'medium'"
  - "Paths assume the SVG default (nonzero) fill rule, never evenodd: parts overlap on purpose (diagonal into stem, disc onto stem) and evenodd would punch a hole at every overlap; ring counters are cut by winding the inner circle against the outer one"
  - "Stems that meet a curve (the wordmark n and r) start at the springline, not the x-height line, so the curve owns the outline instead of being covered by a flat-topped rectangle"
  - "Concept C's bracket returns sit on the two corners the diagonal does NOT touch: on the diagonal's own corners they read as arrowheads and the mark stops reading as an N (verified by rasterising both at 16/24/32px)"
  - "The wordmark is concept-independent (D-05 ties it to the shared constants, not to one concept's construction); wordmarkParts/Path/Width keep the ConceptId parameter for 07-05's approved concept"

patterns-established:
  - "Part names are Phase 8 animation hooks: every concept exposes an `aperture` part and a fixed part order (stems or frame, then diagonal, then aperture), so 07-03 can emit stable data-part attributes"
  - "Test-side arc-aware path parser: bounds are measured from real ink (arc extremes included), never from raw numeric tokens, which for an arc include radii and flags"

# Metrics
duration: 70min
completed: 2026-09-22
---

# Phase 7 Plan 01: Brand geometry module Summary

**One pure TypeScript module on a 24-unit grid that draws three distinct N monograms and the lowercase "noodara" wordmark as filled outlines from named constants, with 68 tests pinning the construction.**

## Performance

- **Duration:** ~70 min
- **Started:** 2026-09-22T16:35Z
- **Completed:** 2026-09-22T17:45Z
- **Tasks:** 3 (plus one post-verification concept fix)
- **Files created:** 6

## Accomplishments

- `geometry.ts` is the single definition every later artifact derives from (D-10): constants, primitives (`fmt`, `bar`, `circle`, `ring`, `taperedBar`, `diagonalBar`, `arcTo`), concept dispatch, wordmark layout and lockup layout — no React, no I/O, no colour.
- Three genuinely different constructions of "seeing clearly" (D-13), each an uppercase N that stays legible at 16px, each with a stable `aperture` part for Phase 8's deferred animation.
- The wordmark's two "o" are literally the monogram's aperture ring — same radius, same counter (D-08) — and its "n" stem is the monogram's stem (D-05); the test asserts the shared radii against concept A's own aperture part, so the two can never drift.
- Everything is arcs and straight lines only (D-15) and every path is a filled outline, never a live stroke (07-RESEARCH pitfall 4).

## Final constant values

| Constant | Value | Meaning |
|---|---|---|
| `GRID` | 24 | the design grid; every coordinate is in these units |
| `MARGIN` | 1 | breathing room inside the box — no ink touches the viewBox edge |
| `STROKE` | 3 | stem, diagonal and wordmark weight, baked into every outline |
| `APERTURE_RADIUS` | 6 | outer radius of the monogram's aperture **and** of the wordmark's "o" |
| `TERMINAL_RADIUS` | 1.5 | `STROKE / 2` — a terminal cap ends flush with its own stem |
| `X_HEIGHT` | 12 | `2 * APERTURE_RADIUS` — the x-height IS the aperture's diameter |
| `ASCENDER` | 18 | the "d"; sits just under the monogram's cap height in the lockup |
| `LETTER_GAP` | 2 | tight tracking between glyph advances (D-07) |
| `LOCKUP_GAP` | 6 | monogram-to-wordmark gap |
| `BASELINE` | 23 | `GRID - MARGIN` — the wordmark baseline and the monogram's bottom edge |

Derived: `wordmarkWidth` = 91.5 units, `lockupLayout` = 121.5 x 24 units (monogram at x 0, wordmark at x 30, no vertical translation).

## The three concepts

| Id | Name | Meaning (one sentence, quoted verbatim by 07-04 / 07-08) |
|---|---|---|
| a | Aperture | "The diagonal opens into an aperture -- the mark is a lens, and infrastructure is what it brings into view." |
| b | Focus | "Two strokes converge on a single point: the moment a scattered signal resolves into something clear." |
| c | Viewfinder | "The letter becomes a viewfinder -- brackets frame the subject and the centre ring is where it sharpens." |

- **A** — two full-height stems; the diagonal is cut into two segments that stop exactly on the ring's outer edge, so the ring is the opening the letter makes rather than an overlay.
- **B** — the diagonal tapers from a full `STROKE` at the top-left down to `TERMINAL_RADIUS` at a focal point; the right stem ends on that same point and a filled disc marks it. The cleanest N of the three.
- **C** — the two stems plus inward returns at the top-right and bottom-left corners (viewfinder brackets); the diagonal breaks open over a gap of `APERTURE_RADIUS` at the centre, filled by a small ring.

## Task Commits

1. **Task 1: geometry module and primitives** — `f9ca0d6` (test, RED) then `94bbd46` (feat, GREEN)
2. **Task 2: three monogram concepts** — `c96ff86` (test, RED) then `8829108` (feat, GREEN)
3. **Task 3: the "noodara" wordmark** — `e9990e8` (test, RED) then `2eefb9b` (feat, GREEN)
4. **Post-verification fix: concept C bracket corners** — `07a270b` (test, RED) then `5a00413` (fix, GREEN)

## Files Created

- `packages/ui/src/brand/geometry.ts` — grid constants, path primitives, concept dispatch, wordmark/lockup layout. The only file a D-16 adjustment round needs to touch.
- `packages/ui/src/brand/glyphs.ts` — the n, o, d, a, r builders and the letter order of "noodara".
- `packages/ui/src/brand/concepts/{a,b,c}.ts` — one construction each, `meta` + `parts()`, no magic numbers.
- `packages/ui/src/brand/geometry.test.ts` — 68 tests, including an arc-aware path parser so bounds measure real ink.

## Decisions Made

Recorded in the frontmatter `key-decisions`. The one worth repeating here: **`STROKE = 3`, `APERTURE_RADIUS = 6`** rather than the plan's starting `4` / `5`. 07-CONTEXT.md assigns "la geometría exacta de la apertura, ángulos, proporciones" to Claude's discretion within D-03/D-15, and the plan itself labels both values adjustable. With `5` and `4` the ring's counter is one grid unit (invisible below roughly 48px, so both the aperture and the wordmark's "oo" render as solid discs) and `X_HEIGHT = 12` cannot be satisfied by a radius-5 circle, which left every round letter 2 units short of the x-height and floating off the baseline. At `6` and `3` the counter is 6 units wide (4px at 16px), `X_HEIGHT = 2 * APERTURE_RADIUS` holds exactly, and every one of the plan's own glyph formulas lines up. Every other pinned constant is unchanged.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] Bounds assertions parse the path instead of scanning numeric tokens**
- **Found during:** Task 1
- **Issue:** The plan's behaviour bullets are phrased as "every numeric token lies within [lo, hi]" — literally unsatisfiable for any path containing an arc, whose tokens include two radii, a rotation and two flags. `ring(12,12,5,3)` emits `5`, `3`, `0`, `1`, none of them inside the stated `[7,17]`.
- **Fix:** The test file carries a small path parser that walks M/L/H/V/A/Z and expands each arc into its endpoint plus whichever axis extremes genuinely lie on the swept portion (SVG's own endpoint-to-centre parameterisation), so bounds measure ink. The raw-token check is kept where the token set really is the subject (the T-07-01 character gate, and the monogram's 0..GRID range, where radii and flags are themselves inside the range).
- **Verification:** `pathBounds(ring(12,12,5,3))` is exactly `[7,17]` x `[7,17]`, asserted as its own test.
- **Committed in:** `f9ca0d6`

**2. [Rule 1 - Bug] Nonzero fill rule, not evenodd**
- **Found during:** Task 1
- **Issue:** The plan specified `fill-rule="evenodd"` to cut the ring's hole. Parts overlap by design (the diagonal runs into the stems, concept B's disc caps the right stem, the wordmark's shoulder runs into its stem) and under evenodd every one of those overlaps becomes a hole.
- **Fix:** All parts are wound the same way (`bar`, `taperedBar` and `circle(sweep=1)` all wind clockwise on screen); a ring's counter is cut by winding the inner circle against the outer one, which the SVG default (nonzero) rule reads as a hole. `taperedBar` orders its vertices so the winding is correct whatever direction the segment points in. The module header states this explicitly for 07-03/07-06, and a test pins the ring's sweep flags to `[1,1,0,0]`.
- **Verification:** `ring` sweep-flag test; the rendered marks (rasterised at 16/24/32/256px) show solid unions and open counters.
- **Committed in:** `94bbd46`

**3. [Rule 1 - Bug] Stems that meet a curve start at the springline**
- **Found during:** Task 3
- **Issue:** The plan's "n" put the left stem at full x-height and the arch apex on the same line; the stem's rectangle then covers the arch across its own width and the outline shows a flat-topped left shoulder with a step where the curve reappears. Same for the "r".
- **Fix:** Both stems of the "n" and the stem of the "r" run from the springline (the arch's centre line) to the baseline, so the curve owns the outline — the standard geometric-sans construction. The "a" and "d" keep full-height straight stems, which is correct for those letters.
- **Verification:** Every glyph's bounds now sit exactly on the baseline and on its own top line (x-height, or ascender for the "d") — asserted per glyph; visually confirmed in the 6x render.
- **Committed in:** `2eefb9b`

**4. [Rule 1 - Bug] Concept C's brackets moved to the free corners**
- **Found during:** post-Task-3 visual verification (rasterised at 16/24/32px)
- **Issue:** With the returns on the top-left and bottom-right corners — the corners the diagonal itself leaves from — each return plus the diagonal reads as an arrowhead, and the mark renders as a double-headed arrow rather than an N, against D-03's "debe leerse como N ... en 16 px".
- **Fix:** The returns moved to the top-right and bottom-left corners. The brackets now read as viewfinder corner marks framing the centre ring, and the N's skeleton is unobstructed.
- **Verification:** Both variants rasterised side by side at 16/24/32px; the swapped version reads as an N at every size. Test updated first (RED), then the fix.
- **Committed in:** `07a270b` (test) + `5a00413` (fix)

**5. [Rule 3 - Blocking] Two additions to the interface block**
- **Found during:** Tasks 1 and 3
- **Issue:** Concept B needs a filled disc (the plan forbids `ring(..., 0)` for it) and concept B's diagonal needs a taper; the wordmark needs a single arc command. None of these exist in the plan's interface list.
- **Fix:** Added `circle(cx, cy, r, sweep)`, `taperedBar(...)` (which `diagonalBar` now delegates to), `arcTo(...)`, `BASELINE` and `conceptMeta(id)`. All additive — every name in the plan's `<interfaces>` block exists with its stated signature.
- **Verification:** `pnpm --filter @noodara/ui typecheck`; the plan's eight named exports are still present (`grep -cE` prints 8).
- **Committed in:** `94bbd46`, `2eefb9b`

---

**Total deviations:** 5 auto-fixed (4 bugs, 1 blocking) plus the documented constant choice.
**Impact on plan:** No scope creep — every deviation is inside this plan's own files, and each one was needed for the mark to be correct (fill rule, glyph outlines) or legible (bracket corners, aperture counter).

## Issues Encountered

- **The mandated import cycle.** `geometry.ts` must define `GRID` itself *and* statically import the concept modules, which import the constants back. The cycle is made safe rather than removed: only function bindings cross it, and only from inside function bodies, so no module can observe another half-evaluated no matter which file the graph is entered from. `conceptMeta(id)` exists for exactly this reason — a concept's `meta` cannot read a `const` from a module that may still be evaluating.
- **Floating-point tolerance in the test.** A reconstructed bar width measured 3.9994, not 4, because `fmt` quantises coordinates to three decimals. The assertion's tolerance now matches the quantisation instead of demanding more precision than the format carries.

## Notes for the D-16 adjustment rounds

The whole system moves from two numbers. Worth having on hand when the user picks a concept in 07-05:

- `STROKE` drives every weight. 3 gives a stem/x-height ratio of 0.25 (Helvetica is ~0.22, Futura Medium ~0.19). Lower it to 2.5 for a lighter, more Apple-like wordmark; the aperture counter widens with it.
- `APERTURE_RADIUS` drives the lens *and* the x-height together (`X_HEIGHT = 2 * APERTURE_RADIUS`). At 6 the aperture is assertive in concept A — deliberately, since A is the concept about the lens. Dropping it to 5 quiets the symbol but shortens the wordmark's x-height by the same amount.
- Concept A is the busiest of the three at 16px; B is the most legible; C is the most distinctive. All three were checked by rasterising at 16/24/32px.

## User Setup Required

None — no external service configuration required.

## Next Phase Readiness

- 07-02 (asset pipeline packages) and 07-03 (React components) can both import `@noodara/ui` brand geometry now. 07-03 must render `fill="currentColor"` and must **not** set `fill-rule="evenodd"` or any `stroke`; `data-part` should be the `PathPart.part` value verbatim.
- `DEFAULT_CONCEPT` stays `'a'` until 07-05 records the user's choice in `docs/brand/APPROVAL.md` (D-17). Nothing downstream should hardcode a concept id.
- BRAND-01 is **not** complete: this plan delivers the geometry only. The requirement also needs the theme variants, the exported assets and the `docs/brand/` sheet (07-06, 07-08, 07-10), so its checkbox is deliberately left unticked.
- `packages/ui/src/index.ts` does not export the brand module yet — 07-03 adds the public surface together with the components.

## Self-Check: PASSED

- All six files exist on disk.
- All eight commits (`f9ca0d6`, `94bbd46`, `c96ff86`, `8829108`, `e9990e8`, `2eefb9b`, `07a270b`, `5a00413`) are in `git log`, RED before GREEN in every pair.
- `pnpm test -- packages/ui/src/brand/geometry`, `pnpm --filter @noodara/ui typecheck`, `pnpm --filter @noodara/ui lint` and `pnpm check:ui-safety` all exit 0.

---
*Phase: 07-identidad-y-brand-kit*
*Completed: 2026-09-22*
