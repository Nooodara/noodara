# Deferred items

Out-of-scope discoveries logged per the executor's scope-boundary rule -- not fixed here.

## 05-19: `@servers a row's actions menu is absent until opened, then exposes Edit and Delete` is order-dependent flaky

- **Found during:** 05-19's full `pnpm test:e2e` verification run (`tests/e2e/servers-list.spec.ts:208`).
- **Symptom:** `row.hover()` times out after 60s when this spec runs late in a full suite (after
  `auth`/`discovery`/`host-key`/`server-detail`/`server-sheet` have already created many real
  servers via the real API against the same shared stack). Re-running this single test in
  isolation (`pnpm test:e2e --grep "row's actions menu"`, a fresh stack) passes in under a second.
- **Why not fixed here:** it is not caused by any 05-19 change -- 05-19 never touches
  `apps/web/src/app/(shell)/servers/page.tsx`, `ServerList.tsx` or `ServerRow.tsx`. It reproduces
  identically before and after 05-19's diff and is purely a function of accumulated server-list
  size across a long, shared-stack E2E run, out of this plan's own scope boundary.
- **Suggested follow-up:** whichever plan next touches `servers-list.spec.ts` or the servers list
  screen should investigate list-size-dependent slowness (e.g. `row.hover()`'s scroll-into-view
  cost against a long unvirtualized list) and consider trimming or isolating real-API-seeded rows
  between specs.
