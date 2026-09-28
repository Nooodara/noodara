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

## From 10-12 (Task 1, full gate)

- `pnpm test:e2e`'s `tests/e2e/servers-list.spec.ts:277` (`@rowmenu at a 440x956 mobile viewport,
  opening the row menu never clips it and never hides the row's own content`) fails when run as
  part of the full 175-spec suite (`y: 1120` expected vs `y: 654` received — a resource-contention
  timing issue, same class of failure the Phase 9 approval record already noted: "an initial
  concurrent test:integration + security:scan-leaks run produced one false stray-container
  failure ... not a product defect"), but passes in isolation
  (`pnpm exec playwright test tests/e2e/servers-list.spec.ts -g "opening the row menu never
  clips it"` → 1/1 pass). Reproduced twice (174/175 both full runs). The spec and the component
  it exercises (`RowMenu.tsx`, `apps/web`) are untouched by any Phase 10 plan (`git log` shows the
  spec's last touch at `461245d`, phase 09-14, before Phase 10 started). Out of scope per the
  scope-boundary rule (only auto-fix issues directly caused by the current task's own changes);
  not fixed here.

## From 10-06 (Task 1)

- `scripts/check-ui-safety.mjs` imports `statSync` from `node:fs` but never uses it (pre-existing
  since `26504dd`, phase 10-02, before this plan touched the file). `npx eslint
  scripts/check-ui-safety.mjs` fails with `no-unused-vars` on a clean tree at HEAD before this
  plan started. Not caused by 10-06's edit (which only added the
  `DANGEROUSLY_SET_INNER_HTML_SCAN_EXCLUDE` set and its one `continue` check). `scripts/` is not
  covered by any workspace package's `pnpm lint` target (`turbo run lint` only runs each
  package's own `eslint`), so this does not fail `pnpm lint` or CI's lint gate today -- only a
  direct `npx eslint scripts/check-ui-safety.mjs` invocation surfaces it.
