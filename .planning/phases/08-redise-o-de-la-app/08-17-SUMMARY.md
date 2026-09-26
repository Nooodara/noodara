---
phase: 08-redise-o-de-la-app
plan: 17
subsystem: ui
tags: [react, tailwind, radix, playwright, vitest, design-system, tofu, fingerprint]

# Dependency graph
requires:
  - phase: 08-redise-o-de-la-app (plan 05)
    provides: ServerFacts' Connection group and its "Host fingerprint" row
  - phase: 08-redise-o-de-la-app (plan 14)
    provides: DestructiveConfirmDialog's shadow/motion baseline this plan renders inside unchanged
  - phase: 08-redise-o-de-la-app (plan 18)
    provides: the discovery-narration authored moment (D-09's Viewfinder ring) -- UI-08's other half
provides:
  - "packages/ui/src/Fingerprint.tsx: the shared TOFU block (prefix + 4-char blocks + one-tap copy), single mode and pairwise diff mode"
  - "FirstTrustNotice, ServerFacts' Connection row and TrustFingerprintDialog all render the same Fingerprint component"
  - "TrustFingerprintDialog's Trusted/New diff, block-aligned, marked by ink weight only, never colour"
affects: [08-19, 08-20, phase-09-settings]

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "Fingerprint parses 'SHA256:<hex>' into a dimmed caption-mono prefix + text-body/15px mono blocks of 4, reusing CopyButton as-is for the one-tap copy (never a second clipboard implementation)"
    - "Diff mode compares two Fingerprint instances' own chunked blocks pairwise by index; a differing block (including one with no counterpart on the shorter side) renders text-ink font-semibold, a matching block renders text-ink-secondary font-normal -- zero colour utilities in the file"
    - "Dimmed-row colour inheritance via a locally-scoped --color-ink CSS custom property override (inline style on a wrapper) instead of a new Fingerprint prop -- Tailwind's text-ink utility resolves through var(--color-ink), which cascades to descendants unless redefined, so only Fingerprint's own single-mode ink blocks pick up the override"

key-files:
  created:
    - packages/ui/src/Fingerprint.tsx
    - packages/ui/src/Fingerprint.test.tsx
  modified:
    - packages/ui/src/index.ts
    - apps/web/src/components/FirstTrustNotice.tsx
    - apps/web/src/components/FirstTrustNotice.test.tsx
    - apps/web/src/components/ServerFacts.tsx
    - apps/web/src/components/ServerFacts.test.tsx
    - apps/web/src/components/TrustFingerprintDialog.tsx
    - apps/web/src/components/TrustFingerprintDialog.test.tsx
    - tests/e2e/host-key.spec.ts

key-decisions:
  - "userEvent.setup() must run BEFORE any manual navigator.clipboard stub in a test -- reversing the order lets userEvent's own internal clipboard-stub install silently clobber a manually-defined one, which showed up as a real, reliably-reproducing flaky failure (not a one-off) while writing Fingerprint.test.tsx; fixed by matching CopyButton.test.tsx's already-established order and documented inline so no future test file reintroduces it"
  - "ServerFacts' Host fingerprint row hand-rolls LabelValue's own row layout instead of extending LabelValue with a custom value-renderer slot, since Fingerprint's prop contract (value/compareTo/label/copyLabel/data-testid) is fixed by 08-17-PLAN.md Task 1 and LabelValue has no such slot; every other row keeps using LabelValue unchanged"
  - "TrustFingerprintDialog's two Fingerprint instances each pass the other's value as compareTo, so both the Trusted and the New block sets independently mark their own differing blocks -- neither side is treated as the 'reference' copy"
  - "UI-08 stays Pending (not claimed complete) -- see Requirements note below"

requirements-completed: []

# Metrics
duration: ~55min
completed: 2026-09-26
---

# Phase 08 Plan 17: Fingerprint TOFU Component Summary

**Shared `Fingerprint` component (blocks-of-4, one-tap copy, weight-only diff) now renders the host key on all three TOFU surfaces -- first-trust notice, the Connection row and the host-key-changed dialog's Trusted/New diff.**

## Performance

- **Duration:** ~55 min
- **Started:** 2026-09-26T13:40:00Z (approx, per orchestrator handoff)
- **Completed:** 2026-09-26T14:35:00Z (approx)
- **Tasks:** 3 (all `type="auto" tdd="true"`)
- **Files modified:** 10 (2 created, 8 modified)

## Accomplishments

- Built `packages/ui/src/Fingerprint.tsx`: parses `SHA256:<hex>` into a dimmed caption-mono prefix and 4-character mono-grande (15px) blocks, reuses `CopyButton` verbatim for the one-tap copy of the full unblocked string, and supports a `compareTo` diff mode where a differing block renders `text-ink font-semibold` and a matching block renders `text-ink-secondary font-normal` -- zero colour utilities anywhere in the file (`check:ui-safety` and a dedicated grep both confirm).
- Adopted `Fingerprint` on `FirstTrustNotice` (replacing the ad hoc mono span + `CopyButton` pair; the verify-command block keeps its own separate copy control unchanged) and on `ServerFacts`' Connection group "Host fingerprint" row (replacing `LabelValue mono copyable`; every other row in the three groups still uses `LabelValue`; the null-fingerprint case still renders the shared `PLACEHOLDER`).
- Rebuilt `TrustFingerprintDialog`'s old/new confirmation as two `Fingerprint` instances in diff mode labelled "Trusted"/"New" (never "old"/"Observed"), each comparing against the other so both sides mark their own differing blocks; `handleConfirm`, the `FINGERPRINT_MISMATCH` branch, the typed-exact-name gate and the disabled-until-match confirm button are all byte-for-byte unchanged (confirmed by `git diff` inspection and a new regression test/E2E case).
- Added a `@host-key`-tagged E2E case exercising the live diff rendering, the weight-only marking and the typed-name gate together against the real running app; fixed two pre-existing E2E assertions in the same file that still expected the old single-text-node `Observed: <value>` shape.

## Task Commits

Each task was committed atomically, RED before GREEN:

1. **Task 1: The Fingerprint component**
   - `89075f2` test(08-17): add failing spec for the shared Fingerprint component
   - `4bc708f` feat(08-17): add the shared Fingerprint TOFU component
2. **Task 2: Adopt it on the notice and the Connection row**
   - `84acd9d` test(08-17): add failing specs for Fingerprint adoption on notice/row
   - `bd36729` feat(08-17): adopt Fingerprint on the notice and Connection row
3. **Task 3: The old/new diff in the host-key-changed dialog**
   - `39b134f` test(08-17): add failing diff-mode specs for TrustFingerprintDialog
   - `b49b7da` feat(08-17): render the Trusted/New fingerprint diff in the host-key dialog
   - `016e1cf` test(08-17): fix strict-mode locators and stale Observed text in host-key e2e (post-GREEN E2E hardening, not a new behaviour -- see Issues Encountered)

_TDD gate sequence per task: a `test(08-17)` commit precedes every `feat(08-17)` commit above; `pnpm exec vitest run` was re-run after each GREEN to confirm RED->GREEN before committing._

## Files Created/Modified

- `packages/ui/src/Fingerprint.tsx` - the shared TOFU block, single and diff modes
- `packages/ui/src/Fingerprint.test.tsx` - 11 cases covering parsing, blocking, copy, diff marking, unequal-length alignment, non-SHA256 fallback
- `packages/ui/src/index.ts` - alphabetical `Fingerprint`/`FingerprintProps` export
- `apps/web/src/components/FirstTrustNotice.tsx` - fingerprint span + CopyButton pair replaced by one `Fingerprint`
- `apps/web/src/components/FirstTrustNotice.test.tsx` - updated to assert prefix/blocks instead of one text node; new two-copy-control case
- `apps/web/src/components/ServerFacts.tsx` - "Host fingerprint" row hand-rolled with `Fingerprint`, dimmed via a scoped `--color-ink` override
- `apps/web/src/components/ServerFacts.test.tsx` - new cases for the Fingerprint row and the null-fingerprint placeholder
- `apps/web/src/components/TrustFingerprintDialog.tsx` - two `Fingerprint` instances in diff mode replace the two mono spans
- `apps/web/src/components/TrustFingerprintDialog.test.tsx` - updated existing cases off the old `Observed: <value>` text shape; four new cases (labels, weight marking, colour-free, typed-name regression)
- `tests/e2e/host-key.spec.ts` - new `@host-key` case; two pre-existing dialog assertions updated off the old text shape

## Decisions Made

- **userEvent.setup()-before-clipboard-stub ordering.** While writing `Fingerprint.test.tsx`'s copy test, a manually-stubbed `navigator.clipboard` was reliably (not flakily -- 5/5 reproductions) overwritten by `userEvent.setup()`'s own internal clipboard-stub installation when `setup()` ran *after* the manual stub. Fixed by matching `CopyButton.test.tsx`'s already-established `setup()`-then-stub order and documenting it inline in the test so the next new test file doesn't reintroduce the bug.
- **Dimmed-row colour via scoped CSS custom-property override, not a new Fingerprint prop.** `ServerFacts`' "Host fingerprint" row needed to preserve `LabelValue`'s existing `dimmed` treatment (value text swapping to `--ink-tertiary`), but Task 1's `FingerprintProps` contract is fixed to `value`/`compareTo`/`label`/`copyLabel`/`data-testid`. Since Tailwind's `text-ink` utility compiles to `color: var(--color-ink)` and CSS custom properties inherit down the DOM tree, wrapping `Fingerprint` in a `<div style={{ '--color-ink': 'var(--ink-tertiary)' }}>` when `dimmed` is true reproduces the exact same dim without touching `Fingerprint`'s prop surface or its own single-mode `text-ink` block styling. No test in this plan measures the resulting computed colour for this specific row (only `data-dimmed` attribute parity, which is preserved) -- the existing `server-detail.spec.ts` dimmed-colour E2E check is scoped to `StatTile`'s own `[data-mono]`, untouched by this plan.
- **Symmetric diff comparison in `TrustFingerprintDialog`.** Both the "Trusted" and "New" `Fingerprint` instances pass the other's raw value as `compareTo`, so each side independently marks its own differing blocks rather than one side being treated as a fixed reference render.
- **UI-08 stays Pending.** See Requirements section below.

## Deviations from Plan

None — plan executed exactly as written. Two things worth flagging as "not deviations but discoveries":

1. The `packages/ui` build (`dist/`) needed a fresh `pnpm --filter @noodara/ui build` after adding `Fingerprint.tsx` for `apps/web`'s own `tsc --noEmit` to resolve the new export (the package's `exports` map points at `dist/`, not `src/`). `dist/` is gitignored, so nothing extra was committed — this is a normal local build step, not a plan change.
2. Two **pre-existing** `TrustFingerprintDialog`/`host-key.spec.ts` assertions (the mid-review-swap unit test's "Observed row" title/assertions, and two `dialog.toContainText('Observed: ...')` lines in the E2E file) still expected the old single-text-node `Observed: <value>` shape and needed updating to match the new block-rendered shape as a direct, mechanical consequence of Task 3's own GREEN step — not a scope expansion, since Task 3's own action explicitly said to extend `TrustFingerprintDialog.test.tsx`, and these were pre-existing assertions in the same file that the diff-mode change necessarily broke. Fixed and re-verified green in the same task's commit sequence (see `016e1cf`).

## Issues Encountered

- The first full `pnpm test:e2e -- --grep host-key` run surfaced two real E2E failures: (a) the new `@host-key` test's `getByText('Trusted')`/`getByText('New')` locators were ambiguous under Playwright's default case-insensitive substring matching (the fingerprint-blocks container's own concatenated text, e.g. `"trusted0000..."`, also satisfies a loose `"Trusted"` query) -- fixed with `{ exact: true }` throughout that test; (b) the pre-existing mid-review-swap test's `toContainText('Observed: ...')` assertions no longer matched now that the label and the hash are separate DOM nodes -- fixed by asserting the label and the hash text (which, since `Fingerprint`'s blocks are joined with no extra characters, still reconstructs the exact original string via `textContent`) as two separate expectations. Both fixes are in `016e1cf`; the full `--grep host-key` and full `pnpm test:e2e` runs are green after them (see Verification below).

## Requirements

`requirements-completed: []` — **UI-08 is intentionally left Pending**, per this plan's own instructions. UI-08's text names two authored moments (discovery narration + fingerprint/TOFU block) **and** a brand-swap distinguishability test. This plan closes the fingerprint/TOFU half (08-18 already closed the discovery-narration half, per its own SUMMARY). The brand-swap judgement is explicitly the human's call at G3 (07-03-PLAN.md's brand-kit gate) — this executor does not have standing to declare it satisfied, so `UI-08` stays `[ ]` in `.planning/REQUIREMENTS.md` until a human confirms the brand-swap test at G3.

The plan's own frontmatter lists `requirements: [UI-08, UI-09]`; `UI-09` was already `[x]` in `.planning/REQUIREMENTS.md` before this plan (completed by 08-15/08-16's own work), so no new requirement ID is marked complete by this plan — `UI-08` is withheld as explained above.

### Rules not satisfied

None of D-10's rules, §9 #14, or §9 #18 are unsatisfied by this plan's own scope. The one rule this plan cannot itself satisfy is UI-08's brand-swap distinguishability clause, which is out of scope for an executor by design (human judgement at G3) — not a gap in this plan's implementation.

## Next Phase Readiness

- `Fingerprint` is now the single source of truth for every host-key rendering in the app; any future surface that needs to show a fingerprint (e.g. a future audit/history view) should reuse it rather than re-deriving the block/prefix treatment.
- UI-08 remains open pending the human brand-swap judgement at G3 — nothing in this plan blocks that; both authored moments it describes are now technically complete.
- No blockers for 08-19/08-20.

---
*Phase: 08-redise-o-de-la-app*
*Completed: 2026-09-26*

## Self-Check: PASSED

All 6 listed files found on disk; all 7 listed commit hashes found in `git log --oneline --all`.
