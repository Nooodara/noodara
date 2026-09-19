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

## 05-20: root-cause investigation of the above flake -- inconclusive, still open

05-20-PLAN.md's own instructions required investigating this flake's root cause (rather than
masking it) before adding a nightly that repeats the whole suite ×20, since unbounded row-count
growth across repetitions was the leading hypothesis. Two hypotheses were tested empirically
against this real stack (`tests/e2e/fixtures/stack.ts`), neither reproduced it:

1. **Row-count/DOM-size degradation.** Seeded 250, then 1200, real servers via the live
   `POST /api/servers` + SSE-insert path (matching the real spec's own structural pattern, not a
   bulk reload) and immediately created and hovered the target row. `row.hover()` succeeded in
   27ms and 68ms respectively -- no perceptible degradation even at 1200 concurrent rows, an order
   of magnitude past anything a single ordinary suite run produces. `sortServers`/`insertSorted`
   (`apps/web/src/lib/server-store.ts`) place a live-inserted row by case-insensitive name, a
   one-time sort-position computation, not a per-render cost.
2. **Spec-order contention from the heavy real-SSH specs immediately preceding it.** Ran
   `activity.spec.ts`, `discovery.spec.ts` (including its real `@ssh-live` sshd-container test),
   `host-key.spec.ts` (including its own sequential-pair-of-sshd-containers UF-01 regression),
   `server-detail.spec.ts`, `server-sheet.spec.ts` and `servers-list.spec.ts` in that exact
   alphabetical order in one Playwright invocation (matching this flake's own original "after
   auth/discovery/host-key/server-detail/server-sheet" description) -- all 43 tests passed,
   including the previously-flaky one, in 33.4s.

Neither repro attempt could reproduce the original 60s `row.hover()` timeout. Given 05-19-SUMMARY.md
already recorded the same flake as non-deterministic within a single run (failed once, then passed
68/68 on an immediate re-run), and this plan's own repro budget could not force a third failure,
the most likely remaining explanation is a genuinely rare, machine/Docker-timing-dependent race
(plausibly related to the separately-documented pre-existing Redis pub-sub subscriber startup
flake noted in 05-19-SUMMARY.md's own Issues Encountered) rather than anything reachable through
`tests/e2e/fixtures/stack.ts`'s own data model -- so nothing in this plan's own files (its only
sanctioned fix surface) was identified as an actual root cause, and nothing was changed there.

**Mitigation applied instead, for the nightly ×20 case specifically:** `.github/workflows/
nightly.yml`'s `e2e-repeat` job runs `pnpm test:e2e` as 20 independent process invocations
(`scripts/e2e-repeat.mjs`), each with its own fresh Postgres/Redis Testcontainers pair, rather than
Playwright's own `--repeat-each=20` against one shared, `globalSetup`-started stack. This
structurally prevents the one growth vector that repro attempt 1 above could conclusively rule
out at single-run scale (up to 1200 rows) but not at 20-repetitions-compounded scale in a shared
database -- without masking anything: it changes what "repeat" means (20 hermetic runs, not 20
passes through one growing database), it does not add a retry, a skip, or a longer timeout to the
flaky test itself.

- **Still open:** if this flake reproduces again, the next investigator should check for the
  Redis pub-sub subscriber startup flake correlating with it (same machine class of issue), and
  consider whether Playwright's own actionability trace (`trace: 'on-first-retry'` is currently a
  no-op since `retries: 0`) would need a one-off manual `--trace on` run to catch it live, since
  neither hypothesis tested here reproduced it on demand.

## 05-20: a second, related `servers-list.spec.ts` flake reproduced during the real local 20× run

The actual `node scripts/e2e-repeat.mjs 20` run this plan's own checkpoint requires (20 independent
`pnpm test:e2e` process invocations, each with a genuinely fresh Postgres/Redis Testcontainers
pair -- see the commit above) reproduced a real failure at **iteration 6/20**, stopping there by
design (the script fails fast rather than running all 20 and summarizing). The failing test was
**not** the one investigated above:

- **Test:** `tests/e2e/servers-list.spec.ts:191` -- `@servers activating a row with the keyboard
  navigates to that server's detail URL`.
- **Symptom:** `page.request.post('/api/servers', ...)` succeeds, but the row this test then
  expects (`getByTestId('servers-row').filter({ hasText: name })`) never becomes visible within
  the default 15s `expect` timeout -- `Error: element(s) not found`. This test has no reload/retry
  path of its own: it relies entirely on the live `server.created`/`server.updated` SSE event
  reaching the already-mounted `/servers` page (opened by `login()`) to insert the row via
  `applyServerEvent` (`apps/web/src/lib/server-store.ts`); if that one event never arrives, the row
  never appears, since the test's own assertion has no fallback poll/reload.
- **Not caused by this plan:** `tests/e2e/servers-list.spec.ts`, `apps/web/src/lib/
  use-server-events.ts` and the control-plane SSE broadcaster are all outside 05-20-PLAN.md's own
  `files_modified` (`tests/e2e/fixtures/stack.ts`, `tests/e2e/critical-path.spec.ts`,
  `.github/workflows/ci.yml`, `.github/workflows/nightly.yml`, `package.json`) -- this plan never
  touches any of them. `tests/e2e/critical-path.spec.ts` itself (this plan's own deliverable, which
  drives the identical live-SSE-delivery pipeline end to end, including a real sshd container)
  passed cleanly in **all 6** iterations up to and including the one that failed elsewhere, with
  live discovery-progress evidence captured every single run -- strong evidence the SSE pipeline
  itself is not systemically broken, and that this is the same class of rare, intermittent delivery
  race as the already-documented pre-existing "Redis pub-sub subscriber" timing flake
  (05-01-SUMMARY.md, 05-19-SUMMARY.md's own Issues Encountered) rather than a regression.
- **Why not fixed here:** per the same scope-boundary rule as the entry above -- the fix surface
  (either `servers-list.spec.ts` gaining a reload/poll fallback, or the SSE broadcaster's own
  Redis-subscriber startup reliability) lies entirely outside this plan's own files. Not masked
  with a retry, a longer timeout, or `test.fixme`.
- **Operational note:** the failing run still tore down cleanly -- `docker ps -aq --filter
  "label=noodara.test=true"` and `lsof -i :3000 -i :3100` were both empty immediately after the
  script exited with code 1, confirming `stopStack`'s own guarded teardown sequence holds even on
  a genuine mid-suite test failure.
- **Suggested follow-up:** whichever plan next touches `servers-list.spec.ts` or
  `use-server-events.ts`/the SSE broadcaster should add the same kind of resilience
  `discovery.spec.ts`'s own `@ssh-live` test and this plan's `critical-path.spec.ts` already lean
  on implicitly (staying on one long-lived, already-subscribed page) or give this specific test a
  bounded resync (e.g. `registerResync`-driven refetch) rather than depending on exactly one SSE
  frame arriving with no fallback.
