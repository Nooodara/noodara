# Phase 10 - Deferred Items

Pre-existing failures/out-of-scope discoveries found during plan execution that were NOT fixed
(scope boundary: only auto-fix issues directly caused by the current task's own changes).

## From 10-01 (Task 3)

- `tests/unit/ui/approval-record.test.ts > docs/ui/APPROVAL.md > has exactly one "| Gate |" row
  per gate (three total)` fails on a clean `pnpm test` run at HEAD before this plan started: the
  test hardcodes an expectation of exactly 3 `| Gate |` rows, but `docs/ui/APPROVAL.md` already
  has 4 (git history shows Phase 8 G2, Phase 8 G3, and Phase 9 approval entries committed prior to
  this plan -- `39ff610`, `c3fa5ca`, `fba326f`). Not touched by 10-01; not caused by any file this
  plan modifies. Needs a follow-up fix (likely bumping the hardcoded `3` to a dynamic count, or to
  4, in a future plan that also adds the Phase 10 approval entry) before this test can be trusted
  again.
