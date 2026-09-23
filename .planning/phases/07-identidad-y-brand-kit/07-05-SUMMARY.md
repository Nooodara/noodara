---
phase: 07-identidad-y-brand-kit
plan: 05
subsystem: brand
tags: [brand, approval, human-gate, kerning, geometry, vitest, tdd, BRAND-03]

# Dependency graph
requires:
  - phase: 07-identidad-y-brand-kit
    provides: "07-04's six brand boards and 36 in-app captures under docs/brand/review/{a,b,c}/ -- the review package this gate judged"
  - phase: 07-identidad-y-brand-kit
    provides: "07-01's geometry.ts/glyphs.ts constants (the round-1 adjustment is an edit to one advance there, nowhere else)"
  - phase: 07-identidad-y-brand-kit
    provides: "07-04's scripts/brand/review-paths.ts (REVIEW_SURFACES/THEMES -- the approved-file list is derived from it, not retyped)"
provides:
  - "docs/brand/APPROVAL.md: the D-17 record -- Date, Concept, Adjustment rounds used, Approver, Evidence, plus an adjustment log naming the exact constants that moved"
  - "docs/brand/approved/: the ten captures the approval was given against (board + 4 in-app surfaces x 2 themes), the only brand PNGs in git"
  - "DEFAULT_CONCEPT = 'c' in packages/ui/src/brand/geometry.ts -- every Logo/Wordmark/Lockup with no explicit concept prop now draws Viewfinder"
  - "tests/unit/brand/approval-record.test.ts (12 tests): parses the record off disk and binds it to the export, pins the approved-capture set, and forbids any AI-attribution string anywhere under docs/brand/"
  - "glyphR's optical advance (from 07-05 round 1): wordmarkWidth 89.196, lockupLayout 119.196 x 24"
affects: [07-06, 07-07, 07-08, 07-09, 07-10]

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "A human decision recorded as a document AND bound to the code by a test: the approval's Concept row is parsed at test time and compared to the exported DEFAULT_CONCEPT, so retuning the default without re-recording the approval fails CI (D-17's 'queda registrada' made structural rather than trusted)"
    - "An advance is a measure of ink, not of a bounding box: the one letter whose widest point occurs at a single height ('r') carries a closed-form optical kern derived from the aperture circle's own half-chord, so the pair's narrowest white equals LETTER_GAP like every other pair"
    - "The approved-file list is derived from scripts/brand/review-paths.ts's own REVIEW_SURFACES x THEMES rather than retyped, so adding a review surface later cannot leave docs/brand/approved/ silently incomplete"

key-files:
  created:
    - docs/brand/APPROVAL.md
    - docs/brand/approved/README.md
    - docs/brand/approved/board-{light,dark}.png
    - docs/brand/approved/sidebar-expanded-{light,dark}.png
    - docs/brand/approved/sidebar-rail-{light,dark}.png
    - docs/brand/approved/login-{light,dark}.png
    - docs/brand/approved/setup-{light,dark}.png
    - tests/unit/brand/approval-record.test.ts
  modified:
    - packages/ui/src/brand/glyphs.ts
    - packages/ui/src/brand/geometry.ts
    - packages/ui/src/brand/geometry.test.ts

key-decisions:
  - "Concept c (Viewfinder) approved out of three, after exactly one adjustment round; the second D-16 round was available and deliberately left unused"
  - "Round 1 was resolved as a kern, not as a constant retune: the reported 'noodar a' gap came from spacing the 'r' by its bounding box, so the fix is a per-glyph optical advance; GRID, MARGIN, STROKE, APERTURE_RADIUS, LETTER_GAP and all three concept constructions are byte-identical to what the user saw on the boards"
  - "The approval was given at Task 3 (the round-1 review), so Tasks 4 and 5 were skipped rather than executed with empty content -- the plan's own branch for that case"
  - "docs/brand/approved/ holds the ten full captures only, not the six -crop close-ups: the crops are a reading aid for a review round, and the rail crop would be the eleventh file in a set the test pins at exactly ten"
  - "The attribution gate scans every file under docs/brand/ (including the gitignored review PNGs when present) rather than only the tracked ones -- a leaked string in an untracked capture is one `git add -f` away from history, and the brand kit is the folder whose contents get copied outward to a public site"

patterns-established:
  - "A human approval gate ends in an artifact a test can read, not in a commit message: the record names the date, the concept, the rounds used and the approver, and the test refuses to let the code default drift away from it"

requirements-completed: [BRAND-03]

# Metrics
duration: ~15min of execution (Task 6 + tracking); Tasks 1-5 spanned two review sessions across 2026-09-22/23
completed: 2026-09-23
---

# Phase 7 Plan 05: Brand approval gate Summary

**Concept c "Viewfinder" is the Noodara mark: chosen from three seen in the real running app, tightened in exactly one adjustment round (the "r" is now spaced by its ink instead of its bounding box, so the wordmark no longer reads "noodar a"), approved explicitly, and recorded in `docs/brand/APPROVAL.md` with the ten captures it was approved against — with a test that refuses to let `DEFAULT_CONCEPT` drift away from that record.**

Approved concept: c
Rounds used: 1
Approval date: 2026-09-23
Approver: Pablo Gutierrez

## Performance

- **Duration:** ~15 min of execution this session (Task 6 + tracking); the plan itself spans two review sessions, since three of its six tasks are human checkpoints
- **Tasks:** 6 planned — 4 executed (Tasks 1, 2, 3, 6), 2 skipped (Tasks 4 and 5, per the plan's own "approved at Task 3" branch)
- **Files created:** 13 (APPROVAL.md, approved/README.md, 10 PNGs, the record test); modified: 3
- **Tests:** 12 new; the full unit suite is 142 files / 2405 tests, all green

## The approval act, verbatim

### Round 0

> pick c — Viewfinder

### Round 1 request

Option label:

> round 1: tighten r→a gap (Recommended)

Selected description:

> Only change: the r glyph's advance in glyphs.ts so the gap before the final "a" equals LETTER_GAP like every other pair. Re-captured, then you review once more (round 2 still available).

### Round 1 review

> approved (Recommended)

Given at Task 3, after reviewing the regenerated concept-c captures on the review page. Tasks 4 and 5 were therefore skipped.

### Final approval

> approved (Recommended)

The same act: the approval was given at Task 3, which is the plan's explicit branch for approving before round 2. No approver name was supplied with it, so the record carries the git author name — `Pablo Gutierrez` — exactly as the plan's resume signal states.

## Adjustments applied (round 1)

Every change is one named expression in one file. `constant: old → new`:

- `glyphR().advance`: `APERTURE_RADIUS + STROKE / 2` (7.5) → `advanceBeforeBowl()` = `sqrt(APERTURE_RADIUS² − counterRadius²)` (5.196)
- `wordmarkWidth(concept)` (derived): 91.5 → 89.196
- `lockupLayout(concept).width × height` (derived): 121.5 × 24 → 119.196 × 24

Nothing else moved: `GRID` 24, `MARGIN` 1, `STROKE` 3, `APERTURE_RADIUS` 6, `X_HEIGHT` 12, `ASCENDER` 18, `LETTER_GAP` 2, `LOCKUP_GAP` 6 and all three concept constructions are byte-identical to what the user judged on the boards, so the approval is an approval of what was shown.

**Why a kern and not a tracking change.** 07-04 reported the final "a" sitting a visible notch further from the "r" than any other pair, at every size, on all six boards. Widening or narrowing `LETTER_GAP` would have moved all seven pairs to fix one. The "r" is the only letter here whose ink reaches its widest at a single height (the shoulder's terminal, on the x-height line); below that it falls back to its stem, so its bounding box over-reports its spacing while the six round/straight letters' boxes report theirs correctly. Spacing it by the narrowest run of white between the two inks — which for every other pair already *is* one `LETTER_GAP` — gives the aperture circle's own half-chord at the terminal's inner corner, a real negative kern that tucks the "a" under the shoulder. Equalising the white *area* between pairs instead lands on the same number to two decimals, so the two ways of reading the gap agree.

**Round 2: none.** The concept was approved after round 1 with the second round still available.

## What is now recorded

`docs/brand/APPROVAL.md` carries the D-17 table (Date `2026-09-23`, Concept `c — Viewfinder`, Adjustment rounds used `1 of 2`, Approver `Pablo Gutierrez`, Evidence `docs/brand/approved/`), the approved construction's own `CONCEPT_META.c.meaning` quoted verbatim, the adjustment log above with both round-1 commit hashes and an explicit `Round 2: none`, and a closing note that this file is what unblocks BRAND-02 surfaces.

`docs/brand/approved/` holds the ten captures the approval was given against — `board-{light,dark}`, `sidebar-expanded-{light,dark}`, `sidebar-rail-{light,dark}`, `login-{light,dark}`, `setup-{light,dark}` — plus a README naming the regeneration command. These are the first and only brand PNGs in git; `docs/brand/review/` stays gitignored scratch. `git check-ignore -v docs/brand/approved/board-light.png` prints nothing, so nothing here is committed against a rule.

`DEFAULT_CONCEPT` is `'c'` and its comment points at the record instead of calling itself a placeholder. Every `Logo`, `Wordmark` and `Lockup` rendered without an explicit `concept` prop now draws Viewfinder — including the ones 07-06's exports and 07-07's mount will use.

## Why the record is testable, not just written

`tests/unit/brand/approval-record.test.ts` (12 tests) reads the real document off disk, the same discipline `tests/unit/docs/install-docs-accuracy.test.ts` applies to `docs/install.md` against `install.sh`:

- the table has all five D-17 rows; Date is ISO; the rounds cell matches `/^[0-2] of 2$/` (D-16's ceiling); the Concept cell is `<id> — <name>` where the name is read from `CONCEPT_META[id].name`, never typed in the test
- **`DEFAULT_CONCEPT` equals the id parsed from the record** — the key link. Retuning the default without re-recording the approval turns CI red
- `geometry.ts` names `docs/brand/APPROVAL.md` and no longer matches a placeholder shape
- `docs/brand/approved/` contains exactly the board plus `REVIEW_SURFACES × THEMES` (derived from `review-paths.ts`, not retyped) plus its README; ten PNGs, each > 1 KB, so an empty or truncated copy cannot pass
- no file under `docs/brand/` contains "Claude", "Anthropic" or "Co-Authored-By", case-insensitively (CLAUDE.md §7)

## Security check before committing the captures

T-07-13 (screenshots become permanent repo content) was checked by looking at the images, not by trusting the capture script: `login-light.png` shows empty Email and Password fields, `setup-light.png` shows an empty **Token** field along with empty Email/Password, and `sidebar-expanded-light.png` shows the "No servers yet" empty state with no hostname and no account email anywhere in the shell. All three come from 07-04's Docker fixture stack, captured before sign-in on a fresh context. No real hostname, token or credential appears in any of the ten files.

## Task Commits

| Task | What | Commit | Type |
|------|------|--------|------|
| 2 | RED: pin the r→a optical gap in the wordmark | `fb1153a` | test |
| 2 | GREEN: `advanceBeforeBowl()` kern + the two pinned expectations it legitimately moved | `08aa7ec` | feat |
| 6 | RED: the failing approval-record test | `b85cd3d` | test |
| 6 | GREEN: APPROVAL.md, the ten approved captures, `DEFAULT_CONCEPT = 'c'` | `b6fc8d1` | docs |
| — | This summary and the tracking update | (below) | docs |

Tasks 1, 3 and 5 are human checkpoints and change no file by design; Tasks 4 and 5 were skipped because the approval arrived at Task 3.

## Deviations from Plan

**None.** The plan was executed as written, including its own conditional branch: "If the user approved at Task 3, skip to Task 6 with rounds = 1". No expectation outside the two the round-1 kern legitimately moved (`08aa7ec`, committed in round 1) needed adjusting — in particular, no `DEFAULT_CONCEPT`-dependent assertion anywhere in the tree had to change when the default moved from `'a'` to `'c'`, because every one of them (`static-svg.test.ts`, `Logo.test.tsx`, `Lockup.test.tsx`, `Wordmark.test.tsx`, `geometry.test.ts`) already reads the constant instead of hardcoding a concept. That is 07-01/07-03 discipline paying off exactly where it was meant to.

## Verification

- `pnpm exec vitest run tests/unit/brand/approval-record.test.ts` — 12/12 green (and genuinely red before `b6fc8d1`: 10 failed / 2 passed)
- `pnpm exec vitest run packages/ui/src/brand tests/unit/brand` — 9 files / 191 tests green
- `pnpm test` — 142 files / 2405 tests green
- `pnpm check:ui-safety` — all nine repo-wide gates hold
- `pnpm typecheck` — 8/8 tasks successful; `pnpm lint` — 9/9 successful
- `ls docs/brand/approved/*.png | wc -l` → 10; `grep -ril "claude\|anthropic\|co-authored-by" docs/brand/ | wc -l` → 0
- `grep -E "^export const DEFAULT_CONCEPT: ConceptId = 'c';" packages/ui/src/brand/geometry.ts` matches
- Nothing under `apps/web` changed in this plan — BRAND-02 surfaces stay untouched until 07-07, which is exactly what this gate exists to guarantee

## Next Phase Readiness

- **BRAND-03 is satisfied and 07-06..07-10 are unblocked.** The D-17 record exists, so the mark may now be applied to product surfaces.
- **07-06 (static asset exports)** inherits `DEFAULT_CONCEPT = 'c'` — the SVG/PNG/ICO/OG exports will be Viewfinder without passing a concept anywhere, and the approved board in `docs/brand/approved/` is the reference to diff them against by eye.
- **07-07 (mount)** should re-run `pnpm brand:review --mounted --concept c` and compare against `docs/brand/approved/` — the ten committed files are now a genuine before/after baseline for proving the real mount is faithful to the injected preview.
- **The favicon in a real browser tab is still the one unverifiable surface.** Playwright cannot capture it; the boards' tab strips are a simulation and say so. It becomes a real check in 07-09.
- **Concepts a and b stay in the tree.** `CONCEPT_IDS`, `CONCEPT_META` and both constructions are untouched and still tested; nothing about this approval deletes the alternatives, and `--concept a|b` still renders them.

## Self-Check: PASSED

- `docs/brand/APPROVAL.md`, `docs/brand/approved/README.md` and all ten PNGs exist on disk and are tracked (`git ls-files --error-unmatch` succeeds for each); `tests/unit/brand/approval-record.test.ts` exists.
- Commits `fb1153a`, `08aa7ec`, `b85cd3d`, `b6fc8d1` are all in `git log`, with each RED committed before its GREEN.
- `git show --stat b6fc8d1` lists 13 files, zero deletions, all under `noodara/code/`; neither Task 6 commit carries an attribution trailer.
- `git stash list` is empty and no path outside `noodara/code` was staged at any point.

---
*Phase: 07-identidad-y-brand-kit*
*Completed: 2026-09-23*
