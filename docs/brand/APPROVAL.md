# Brand approval record

Per BRAND-03, the three monogram and wordmark concepts — a "Aperture", b "Focus" and c
"Viewfinder" — were reviewed in the real running application (the 64 px collapsed rail, the
expanded sidebar, `/login` and `/setup`) and on a full brand board each, in both the light and the
dark theme, before any of them was applied to a product surface. One concept was chosen, one
concrete adjustment round was requested and applied to the shared geometry, the whole set was
re-captured in the app, and the result was then approved explicitly. `DEFAULT_CONCEPT` in
`packages/ui/src/brand/geometry.ts` is that concept, and `tests/unit/brand/approval-record.test.ts`
keeps this record and that export in agreement.

| Field | Value |
| --- | --- |
| Date | 2026-09-23 |
| Concept | c — Viewfinder |
| Adjustment rounds used | 1 of 2 |
| Approver | Pablo Gutierrez |
| Evidence | docs/brand/approved/ — the board plus the four in-app surfaces, each in both themes |

The approved construction, in its own words (`CONCEPT_META.c.meaning`):

> The letter becomes a viewfinder -- brackets frame the subject and the centre ring is where it
> sharpens.

## Adjustment log

- **Round 1: the "r" of "noodara" was spaced by its ink instead of by its bounding box.** The final
  "a" stood a visible notch further from the "r" than any other pair in the word, so the wordmark
  read "noodar a" at every size. `glyphR`'s advance changed from `APERTURE_RADIUS + STROKE / 2`
  (7.5 units, the shoulder's box) to `sqrt(APERTURE_RADIUS² − counterRadius²)` (5.196 units, the
  narrowest run of white between the two letters — the measure every other pair already meets), a
  real negative kern that tucks the "a" under the shoulder. Derived values moved with it:
  `wordmarkWidth` 91.5 → 89.196 and `lockupLayout` 121.5 × 24 → 119.196 × 24. Commits `fb1153a`
  (the failing test that pinned the gap) and `08aa7ec` (the kern). Nothing else changed: `GRID`,
  `MARGIN`, `STROKE`, `APERTURE_RADIUS`, `LETTER_GAP` and every concept construction are exactly
  as they were on the boards.
- **Round 2: none.** The concept was approved after round 1, with the second round still available
  and deliberately unused.

## What this record gates

D-17: no BRAND-02 surface (sidebar, rail, `/login`, `/setup`, favicon, apple-touch-icon, README,
the exported public-site assets) may carry the mark before this file exists. It exists as of the
date above, so plans 07-06 through 07-10 may proceed. The captures in `docs/brand/approved/` are
the state the approval was given against; `docs/brand/review/` is regenerated scratch and is
gitignored.
