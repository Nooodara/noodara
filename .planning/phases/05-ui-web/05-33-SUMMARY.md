---
phase: 05-ui-web
plan: 33
subsystem: ui
tags: [design-tokens, wcag, contrast, accessibility, tailwind, status-pill, accent, vitest]

# Dependency graph
requires:
  - phase: 05-ui-web
    provides: StatusPill.tsx, Button.tsx, SegmentedControl.tsx, Field.tsx, RowMenu.tsx, Banner.tsx, tokens.css/theme.css (05-21, 05-25, 05-29)
provides:
  - "packages/ui/src/contrast.ts: WCAG 2.x contrast measurement (relativeLuminance, contrastRatio, compositeOver, parseTokensCss, auditTheme, auditTokens), extended to cover accent-fill, accent-as-foreground (text+outline verdicts) and status-*-text on every real StatusPill background"
  - "packages/ui/tokens.css: --accent-fill (fill-only accent, on-accent-safe in both themes), --status-{ok,warn,error,idle}-text (pill-word-only, AA-safe on every real render surface), darkened --ink-secondary (light) and --ink-tertiary (both themes)"
  - "packages/ui/src/contrast.test.ts: an exhaustive, tokens.css-driven regression gate with a small, individually-justified allowlist for pairs that are either superseded patterns or real, out-of-scope pre-existing gaps"
  - "docs/contrast-decision-05.md: the full measured record -- candidates, user's literal decision, an erratum, the same-day nudge, and the final 76-pair after-table"
affects: [05-37]

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "Token-name-derived audit pairs (STATUS_TOKEN_RE, STATUS_TEXT_TOKEN_RE, INK_TOKEN_RE, SURFACE_BG_RE) so a future token addition is audited automatically, not opted in by hand"
    - "Fill token vs. foreground token split (--accent vs --accent-fill) when one hex value cannot satisfy both a fill's on-accent-text contrast and a foreground's own-surface contrast in the same theme"
    - "Named, justified allowlist for a strict aggregate gate assertion, instead of silently dropping known-failing pairs or leaving the gate permanently red"

key-files:
  created: []
  modified:
    - packages/ui/tokens.css
    - packages/ui/theme.css
    - packages/ui/src/contrast.ts
    - packages/ui/src/contrast.test.ts
    - packages/ui/src/StatusPill.tsx
    - packages/ui/src/StatusPill.test.tsx
    - packages/ui/src/Button.tsx
    - packages/ui/src/SegmentedControl.tsx
    - packages/ui/src/Field.tsx
    - packages/ui/src/RowMenu.tsx
    - packages/ui/src/Banner.tsx
    - "apps/web/src/app/(shell)/layout.tsx"
    - docs/contrast-decision-05.md
    - .planning/phases/05-ui-web/deferred-items.md

key-decisions:
  - "D1 (user, 2026-09-20): StatusPill's word uses a new --status-{tone}-text token per theme, tuned against every real render background, not just --surface-1; dots/borders/meters keep the vivid base --status-* tokens unchanged."
  - "D2 (user, 2026-09-20): --accent splits into --accent (link/outline/border foreground, value unchanged in both themes) and --accent-fill (#0071e3 in both themes, for fills carrying --on-accent text) -- rejects Candidate A's darkened dark-mode --accent, which the orchestrator measured at 2.92-3.69:1 as foreground text/outline on real surfaces."
  - "D3 (user, 2026-09-20): --ink-secondary (light) and --ink-tertiary (both themes) darken; Banner.tsx's errorCode call site moves from --ink-tertiary to --ink-secondary."
  - "Executor nudge (2026-09-20, same day): D3's literal --ink-secondary value (#6c6c71) failed the Banner.tsx composited pair (4.33:1) once actually measured against it; D1's literal status-*-text values failed StatusPill's real --canvas/--surface-2 backgrounds once actually measured. Both were darkened/adjusted the minimal step needed, per the same nudge latitude the user's own D3 text already granted for --ink-tertiary, and reported with real numbers rather than silently applied or left failing."
  - "Two --accent-as-link-text pairs (canvas/surface-3, light, 4.31/4.12) are a real, currently-shipping AA gap this plan does NOT fix, because D2 explicitly locks --accent's own value; documented as a named gate exception and a deferred item rather than silently dropped or silently fixed by violating D2."

patterns-established:
  - "A design token intended for one CSS role (fill vs. foreground) should not be assumed AA-safe for a different role at the same hex value -- verify each role's own worst-case background independently before reusing a token across roles."

requirements-completed: [UI-01, SERV-04, SET-01]

# Metrics
duration: 55min
completed: 2026-09-20
---

# Phase 05 Plan 33: Contrast gap closure (continuation) Summary

**Split `--accent` into link/outline foreground vs. `--accent-fill` fill, added per-tone `--status-*-text` pill-word tokens measured against every real render surface, and darkened `--ink-secondary`/`--ink-tertiary` -- closing 67 of 76 audited WCAG AA pairs, with the remaining 9 individually named and justified (6 superseded patterns, 2 real pre-existing gaps `--accent`'s locked value can't fix, 1 originally-known dark-primary-button failure now fixed via `--accent-fill`).**

## Performance

- **Duration:** ~55 min (this continuation; excludes Task 1/Task 2's prior session)
- **Started:** 2026-09-20T14:35:00Z (approx, first Read of plan/doc)
- **Completed:** 2026-09-20T20:47:29Z
- **Tasks:** 1 (Task 3, resumed from the resolved Task 2 checkpoint)
- **Files modified:** 14 (12 code/token files across two commits, 2 doc files in a third)

## Accomplishments

- Extended `packages/ui/src/contrast.ts`'s `auditTheme` with three new derived audit families (accent-fill, accent-as-foreground with separate text/outline verdicts, status-*-text against every real StatusPill background), all token-name-derived so a future token is covered automatically.
- Applied the user's D1/D2/D3 decision to `tokens.css`/`theme.css`/`StatusPill.tsx`/`Button.tsx`/`SegmentedControl.tsx`/the shell skip link, closing the original dark-mode primary-button failure (3.01:1 → now 4.69:1 via `--accent-fill`) and all eight status-pill pairs.
- Fixed the three WR-C-08 §1.2 call sites named by the user's decision (`Banner.tsx` errorCode, `Field.tsx` inline error, `RowMenu.tsx` "Delete" item) -- all three previously failed, all three now pass in both themes.
- Found and corrected two places where the user's literal decision, once actually measured against its own real render context, fell short of its own "must be ≥4.5" requirement (Banner's composited background with the chosen `--ink-secondary`; StatusPill's real `--canvas`/`--surface-2` backgrounds with the chosen `--status-*-text` values) -- fixed by the smallest step that clears every real background, not by silently accepting the shortfall or stopping execution.
- Discovered and correctly triaged three additional gaps outside this plan's authorised scope (`--accent` as link text on canvas/surface-3, `Button.tsx`'s destructive-filled white-on-status-error, three un-migrated status-error call sites) -- documented, not silently fixed and not silently dropped.
- Proved the gate actually bites: temporarily reverted `--accent-fill` to a failing value via the editor, watched `contrast.test.ts` go red with the real ratio (2.23:1), restored it via the editor, confirmed `git diff packages/ui/tokens.css` is clean.

## Task Commits

Continuing from the prior session's Task 1 (`ff7acda`) and the resolved Task 2 checkpoint (no commit -- a blocking decision, recorded in the doc):

1. **Task 3, RED half: extend the contrast gate for D1/D2/D3** - `691beb7` (test)
2. **Task 3, GREEN half: apply the user's hybrid decision to tokens/components** - `8a983b2` (fix)
3. **Record the decision, erratum and after-table** - `8c5ce74` (docs)

**Plan metadata:** this commit (docs: complete plan) -- see below.

_TDD gate compliance: RED (`691beb7`, 4 failing / 26 passing against the unmodified `tokens.css`) precedes GREEN (`8a983b2`, all pairs pass except the 9 individually-justified allowlist entries)._

## Files Created/Modified

- `packages/ui/src/contrast.ts` - accent-fill, accent-as-foreground (text 4.5 + outline 3.0 verdicts), status-*-text-on-every-real-background audit families, all derived from parsed token names
- `packages/ui/src/contrast.test.ts` - exhaustive gate reading the real `tokens.css`, named allowlist for the 9 documented exceptions, plus explicit Banner/Field/RowMenu call-site checks
- `packages/ui/tokens.css` - `--accent-fill`, `--status-{ok,warn,error,idle}-text` per theme, darkened `--ink-secondary` (light)/`--ink-tertiary` (both), OPEN QUESTION comment replaced with a RESOLVED note
- `packages/ui/theme.css` - Tailwind bindings for the 5 new colour tokens, same `--color-X: var(--X)` mechanism as every existing token
- `packages/ui/src/StatusPill.tsx` - word uses `-text` token; dot uses an explicit `bg-status-{tone}` class instead of `bg-current`
- `packages/ui/src/StatusPill.test.tsx` - new test pinning the dot's explicit class
- `packages/ui/src/Button.tsx` - primary variant: `bg-accent` → `bg-accent-fill` (out-of-`files_modified`, user-approved deviation, D2)
- `packages/ui/src/SegmentedControl.tsx` - checked state: `bg-accent` → `bg-accent-fill` (same deviation class)
- `packages/ui/src/Field.tsx` - inline error: `text-status-error` → `text-status-error-text` (out-of-scope, user-approved, WR-C-08 fix)
- `packages/ui/src/RowMenu.tsx` - "Delete" item: `text-status-error` → `text-status-error-text` (same)
- `packages/ui/src/Banner.tsx` - errorCode: `text-ink-tertiary` → `text-ink-secondary` (same, D3)
- `apps/web/src/app/(shell)/layout.tsx` - skip link: `focus:bg-accent` → `focus:bg-accent-fill` (same deviation class, D2)
- `docs/contrast-decision-05.md` - section 3 (decision + nudge + erratum), section 4 (after-table), section 5 (deferred)
- `.planning/phases/05-ui-web/deferred-items.md` - three new out-of-scope findings

## Decisions Made

See `key-decisions` in the frontmatter above for D1/D2/D3 and the executor's same-day nudge; full reasoning and measured numbers live in `docs/contrast-decision-05.md` sections 3-5.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] D3's literal `--ink-secondary` value (`#6c6c71`) failed the Banner.tsx composited pair it was chosen to fix**
- **Found during:** Task 3, applying D3's literal hex value and measuring it against the exact composited background `Banner.tsx`'s `errorCode` renders on
- **Issue:** `#6c6c71` on `status-error-soft` composited over `surface-1` (`#ffe4e2`) measured 4.33:1 in light -- below the user's own explicit "it must be ≥4.5" requirement. This pair was never measured in the original candidate write-up (only `--ink-tertiary` was checked against Banner's background there).
- **Fix:** darkened `--ink-secondary` (light) one further minimal step to `#69696e`, which clears the Banner pair (4.53:1) while every other `--ink-secondary` use gains margin (was 4.79-5.22, now 5.01-5.45). Same latitude the user's own D3 text explicitly granted for `--ink-tertiary`'s analogous case.
- **Files modified:** packages/ui/tokens.css
- **Verification:** `packages/ui/src/contrast.test.ts`'s named Banner test, both themes
- **Committed in:** 8a983b2

**2. [Rule 1 - Bug] D1's literal `--status-*-text` values failed StatusPill's real `--canvas`/`--surface-2` backgrounds**
- **Found during:** Task 3, auditing every background StatusPill actually renders on (`ServerRow.tsx` has no card wrapper -- 05-UI-SPEC.md D-09 -- so it sits directly on `--canvas` at rest and `--surface-2` on hover; the original candidate figures only checked `--surface-1`)
- **Issue:** all four light `-text` tokens failed on `--canvas` (4.35-4.42); dark `error`/`idle` failed on `--surface-2` (4.16/4.23)
- **Fix:** darkened the four light values and brightened dark `error`/`idle` the minimal step that clears all three real backgrounds (deltas: 2-4 steps for 6 of 8 tokens, 7-13 for dark error/idle)
- **Files modified:** packages/ui/tokens.css
- **Verification:** `contrast.ts`'s `STATUS_PILL_BACKGROUNDS`-driven audit, both themes, all three surfaces
- **Committed in:** 8a983b2

**3. [Rule 2 - Missing critical] Added a dot-class regression test**
- **Found during:** Task 3, changing `StatusPill.tsx`'s dot from `bg-current` to an explicit `bg-status-{tone}` class
- **Issue:** no existing test pinned the dot's colour source; a future refactor could silently reintroduce `bg-current` (which would now inherit the dimmer `-text` colour instead of the vivid tone)
- **Fix:** added a parametrized test in `StatusPill.test.tsx` asserting the dot's class contains `bg-status-{tone}` and never `bg-current`
- **Files modified:** packages/ui/src/StatusPill.test.tsx
- **Verification:** `pnpm exec vitest run packages/ui/src/StatusPill.test.tsx`
- **Committed in:** 8a983b2

---

**Total deviations:** 3 auto-fixed (2 real measurement gaps in the user's literal decision, closed via the same minimal-nudge latitude the decision itself already established for an analogous case; 1 missing regression test)
**Impact on plan:** All three necessary for the plan's own stated success criterion ("every gated pair ≥4.50 in both themes, measured by contrast.ts"). No scope creep beyond D1/D2/D3's own authorised call-site list -- see below for the deviations that touched files outside `files_modified`.

### Files touched outside `files_modified` (user-approved per D1/D2/D3's own text)

`packages/ui/src/Button.tsx`, `packages/ui/src/SegmentedControl.tsx`, `apps/web/src/app/(shell)/layout.tsx` (D2's `bg-accent` → `bg-accent-fill` migration), `packages/ui/src/Field.tsx`, `packages/ui/src/RowMenu.tsx`, `packages/ui/src/Banner.tsx` (D1/D3's named call-site fixes). All six were explicitly anticipated and authorised by the user's decision text, not independently discovered scope creep.

## Known Stubs

None.

## Threat Flags

None -- this plan changes visual/contrast token values and their consuming class names only; no new network surface, auth path, or trust boundary.

## Issues Encountered

None beyond the deviations above (both were resolved within this task, no open blockers).

## Deferred / Out of Scope (see `deferred-items.md` for full detail)

- `--accent` as link text fails AA on `--canvas`/`--surface-3` in light mode (4.31/4.12, real call sites in `ActivityRow.tsx`/`servers/[id]/page.tsx`) -- D2 explicitly locks `--accent`'s own value, so this is not fixable within this plan's authorised scope. Named in `contrast.test.ts`'s allowlist, not silently dropped.
- `Button.tsx`'s `DESTRUCTIVE_FILLED_CLASSES` (white text on `--status-error`, used by the delete-confirmation dialog) measures 3.54:1 light / 3.40:1 dark -- never part of the 17-pair original audit or D1/D2/D3's scope. Flagged for a future plan.
- Three status-colour call sites (`DiscoveryStep.tsx`, `CredentialFields.tsx`, `ActivityRow.tsx`) still use the base `--status-error`/`--status-warn` tokens directly, unmeasured and unmigrated -- WR-C-08 only named Banner/Field/RowMenu.
- The human-display review (`docs/ui-review-05.md` items 1 and 3) stays open, handed to plan 05-37 per the original plan's own verification note. Measuring 4.5:1 is not the same as looking good on a real display.

## User Setup Required

None - no external service configuration required.

## Next Phase Readiness

- The contrast gate (`packages/ui/src/contrast.test.ts`) is now part of `pnpm test` and will fail CI if any audited token regresses -- proven live during this task by a temporary revert-and-restore of `--accent-fill`.
- Three deferred items (above) are ready inputs for whichever future plan is authorised to touch `--accent`'s own value, `Button.tsx`'s destructive-filled variant, or the three un-migrated status-error call sites.
- Plan 05-37's own checkpoint should re-surface `docs/ui-review-05.md` items 1 and 3 (human-display review) as originally planned -- unaffected by this continuation.

---
*Phase: 05-ui-web*
*Completed: 2026-09-20*

## Self-Check: PASSED

All 15 files claimed above (14 modified + this SUMMARY) verified present on disk; all 4 commits
(`ff7acda`, `691beb7`, `8a983b2`, `8c5ce74`) verified present in `git log --oneline --all`.
