---
phase: 05-ui-web
plan: 45
subsystem: ui
tags: [wcag, contrast, tailwind, design-tokens, accessibility]

# Dependency graph
requires:
  - phase: 05-ui-web
    provides: "05-33's contrast.ts/contrast.test.ts gate, --accent-fill precedent (D2), docs/contrast-decision-05.md's decision-record format"
provides:
  - "--accent-text token (D4): the AA-passing link-text role, split from --accent"
  - "--status-error-fill token (D5): the AA-passing destructive-fill role, split from --status-error"
  - "contrast.ts derivation rules generalised: FILL_TOKEN_RE (any --<tone>-fill) and ACCENT_TEXT_TOKEN_RE (--accent-text), both name-derived"
  - "docs/contrast-decision-05.md section 6/7: D4/D5 candidate tables, user decision, as-shipped measurement table"
affects: [05-46, future-ui-redesign]

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "Role-specific token split (D2/D4/D5): never darken a shared token used in multiple roles; add a new token for the role that fails, derive its audit coverage from the token NAME via a regex, never a hardcoded list"

key-files:
  created: []
  modified:
    - packages/ui/tokens.css
    - packages/ui/theme.css
    - packages/ui/src/contrast.ts
    - packages/ui/src/contrast.test.ts
    - packages/ui/src/Button.tsx
    - apps/web/src/components/ActivityRow.tsx
    - "apps/web/src/app/(shell)/servers/[id]/page.tsx"
    - docs/contrast-decision-05.md

key-decisions:
  - "D4: light-mode link-text token --accent-text = #0066cc (min ratio 4.89:1 on --surface-3); dark value stays #2997ff (already passes on every surface, no change needed)"
  - "D5: destructive-fill token --status-error-fill = #d70015 in both themes (white text 5.38:1), following --accent-fill's same-value-both-themes precedent"

requirements-completed: [UI-01]

# Metrics
duration: ~35min
completed: 2026-09-21
---

# Phase 05 Plan 45: Close the two deferred AA contrast failures (link text, destructive fill) Summary

**Added `--accent-text` (#0066cc light / #2997ff dark) and `--status-error-fill` (#d70015 both themes), re-pointed the three real render sites, and generalised `contrast.ts`'s fill-audit rule from a single hardcoded `--accent-fill` block to a name-derived `FILL_TOKEN_RE` loop.**

## Performance

- **Duration:** ~35 min
- **Started:** 2026-09-20 (Task 1 checkpoint already answered by the user before this agent was spawned)
- **Completed:** 2026-09-21T02:01:39Z
- **Tasks:** 3 (1 blocking decision, 1 TDD, 1 auto)
- **Files modified:** 8

## Accomplishments

- Re-derived every candidate ratio in the plan's table with the real `contrast.ts` against the real `tokens.css`; all figures reproduced exactly, with one flagged ±0.01 informational discrepancy (see Deviations).
- Recorded the user's verbatim D4 (`link-B #0066cc`) and D5 (`fill-A #d70015`) decisions in `docs/contrast-decision-05.md` before any token file was touched.
- Added `--accent-text` and `--status-error-fill` tokens, both measured in every role they can render in (text-only for `--accent-text`; fill-only for `--status-error-fill`) across both themes, via two new name-derived `contrast.ts` rules.
- Re-pointed the three real call sites (`ActivityRow.tsx`, `servers/[id]/page.tsx`, `Button.tsx`'s `DESTRUCTIVE_FILLED_CLASSES`) and rewrote the two now-superseded `--accent`-as-text allowlist justifications.
- Light-mode link text now clears 4.5:1 on every surface (previously failing at 4.31/4.12 on canvas/surface-3); the destructive-filled confirm button's white label now clears 4.5:1 in both themes (previously 3.54/3.40).

## Task Commits

1. **Task 1: [BLOCKING] The user picks both colour values from measured candidates** - `5ee1859` (docs)
2. **Task 2: RED then GREEN — the two role tokens, their name-derived audit coverage, and the gate**
   - RED: `0e3190b` (test)
   - GREEN: `2f82ce0` (feat)
3. **Task 3: Re-point the three call sites, re-justify the allowlist, and record every number** - `cd90c23` (fix)

_No plan-metadata commit was made by this agent — STATE.md/ROADMAP.md/REQUIREMENTS.md updates are owned by the orchestrator per this plan's execution instructions._

## Files Created/Modified

- `docs/contrast-decision-05.md` - Section 6 (D4/D5 candidate tables + user decision) and section 7 (as-shipped role × theme × surface table) added
- `packages/ui/tokens.css` - `--accent-text` (light `#0066cc` / dark `#2997ff`) and `--status-error-fill` (`#d70015` both themes) added, with comments citing D4/D5
- `packages/ui/theme.css` - `--color-accent-text` and `--color-status-error-fill` Tailwind mappings added
- `packages/ui/src/contrast.ts` - `ACCENT_TEXT_TOKEN_RE` and `FILL_TOKEN_RE` added; the single hardcoded `--on-accent`-on-`--accent-fill` block generalised into a loop over every name matching `FILL_TOKEN_RE`; a new link-text-only loop added for `ACCENT_TEXT_TOKEN_RE` matches
- `packages/ui/src/contrast.test.ts` - 5 new tests (3 fixture-based `auditTheme` cases, 2 real-gate named assertions); the two `--accent as text` allowlist entries' justification rewritten from "real, deferred" to "superseded pattern"
- `packages/ui/src/Button.tsx` - `DESTRUCTIVE_FILLED_CLASSES`: `bg-status-error` → `bg-status-error-fill`
- `apps/web/src/components/ActivityRow.tsx` - `SERVER_LINK_CLASSES`/`SERVER_LINK_MONO_CLASSES`: `text-accent` → `text-accent-text`
- `apps/web/src/app/(shell)/servers/[id]/page.tsx` - the "Servers" not-found link: `text-accent` → `text-accent-text`

## Decisions Made

- **D4** (user, via the Task 1 checkpoint presented before this agent ran): light-mode link-text token = `#0066cc` ("link-B", min ratio 4.89:1 on `--surface-3`). Dark value stays `#2997ff` (already passes 4.5:1 on all four dark surfaces, 4.75 minimum — no darkening needed).
- **D5** (user, same checkpoint): destructive-fill token = `#d70015` ("fill-A", white text 5.38:1), same value in both themes, following `--accent-fill`'s own same-value-both-themes precedent (D2, 05-33).
- `FILL_TOKEN_RE` generalisation (this executor, within Task 2's `<action>` spec): rather than add a second hardcoded `--on-accent`-on-`--status-error-fill` block alongside the existing `--accent-fill` block, replaced both with a single loop over every token name matching `/^(accent|status-[a-z0-9]+)-fill$/`. This was the literal instruction in the plan's Task 2 action, not a deviation — recorded here because it changes previously-committed code (05-33's original explicit block), not just adds new code, and the existing unit test asserting `--on-accent on --accent-fill`'s exact label was verified to still pass unmodified.

## Deviations from Plan

**1. [Informational, not auto-fixed] ±0.01 rounding discrepancy on one hover-state figure**

- **Found during:** Task 1's re-derivation.
- **Issue:** The orchestrator's stated hover-state figure (`hover:opacity-90` composite of white label + `#d70015` fill over light `--surface-1`) was `5.01`; my own re-derivation with the exact same formula (fg×0.9 + bg×0.1 per channel, then round to nearest int, then `contrastRatio`) gave `5.00`. Traced to a genuine JS floating-point artifact: computing the blend weight as `(1 - 0.9)` yields `0.09999999999999998` (not exactly `0.1`), which for this specific channel value (`0*0.9 + 255*(1-0.9)` vs `0*0.9 + 255*0.1`) lands on opposite sides of the `x.5` round-half-up boundary (`25.499999999999993` rounds to 25 vs. `25.5` rounds to 26) — a 1/255 channel difference that moves the ratio by 0.01.
- **Fix:** None needed — this is not part of the gate's exhaustive measurement (`contrast.ts` has no reusable opacity-composite function; both the orchestrator's and my figure are one-off manual calculations for an informational, non-gated note). Documented the discrepancy explicitly in `docs/contrast-decision-05.md` section 6.1, following the exact precedent 05-33's own section 1.3 already established for this class of rounding-convention difference. Does not change any PASS/FAIL verdict and does not affect D4 or D5. All seven other extra-role figures (the two dark hover states, the three edge-contrast figures, and both "today's #ff453a edge" figures) reproduced exactly with zero discrepancy.
- **Files modified:** `docs/contrast-decision-05.md` only (documentation, no token or code change).
- **Verification:** Re-ran the exact formula three ways (a standalone Node script, a `tsx`-executed script importing the real `contrast.ts` functions, and the scratch Vitest file) — all three independently reproduce `5.00`, confirming it is not a one-off calculation error on my part.
- **Committed in:** `5ee1859`.

---

**Total deviations:** 1 (informational only, no code/token change)
**Impact on plan:** None on scope or correctness. All core candidate figures (the eight link-text ratios and the five fill ratios that the Task 1 decision was actually based on) reproduced with zero discrepancy.

## Issues Encountered

None.

## User Setup Required

None - no external service configuration required.

## Next Phase Readiness

- Both AA failures named in this plan's objective are closed and gated: `pnpm vitest run packages/ui/src/contrast.test.ts` (36/36), `pnpm vitest run packages/ui/src` (296/296), `pnpm test` (1518/1518), `pnpm check:ui-safety` (9/9), `pnpm lint` and `pnpm typecheck` all green.
- `docs/contrast-decision-05.md` section 5's two "fuera de alcance" items for this exact scope are now resolved and superseded by section 6/7; the document's remaining section-5 items (`--ink-tertiary` hierarchy compression, unmigrated `text-status-error`/`text-status-warn` call sites in `DiscoveryStep.tsx`/`CredentialFields.tsx`) are untouched, out of this plan's scope, and still open for a future plan.
- No blockers for 05-46 (the closing gate plan).

## Self-Check: PASSED

Verified all claimed artifacts exist and all claimed commits are in history:

- `packages/ui/tokens.css` contains `--accent-text` (2 occurrences) and `--status-error-fill:` (2 occurrences) — FOUND
- `packages/ui/theme.css` contains `--color-accent-text` and `--color-status-error-fill` — FOUND
- `git log --oneline --all | grep 5ee1859` — FOUND
- `git log --oneline --all | grep 0e3190b` — FOUND
- `git log --oneline --all | grep 2f82ce0` — FOUND
- `git log --oneline --all | grep cd90c23` — FOUND
- No stray scratch test file: `git status --short packages/ui` — clean (the scratch re-derivation file was deleted before the first commit)
- `git diff --stat 641eaf9 HEAD -- packages/ui apps/web docs` lists exactly the 8 files named in this plan's `files_modified` frontmatter — confirmed

---
*Phase: 05-ui-web*
*Completed: 2026-09-21*
