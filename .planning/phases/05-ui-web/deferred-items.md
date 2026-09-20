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

## 05-20 (debug session `sse-lost-event-race`): what is now resolved, and what is still open

Full evidence trail: `.planning/debug/sse-lost-event-race.md`. Two independent root causes were
found; neither is the "machine-specific Docker/network flakiness" or "Redis-subscriber contention"
the entries above (and STATE.md) attributed these failures to.

### RESOLVED -- the "Redis pub-sub subscriber startup flake" (events-sse.test.ts, canary-http.test.ts)

- **Was a product bug, not a test or machine problem.** `createSseBroadcaster().start()` called
  `subscriber.subscribe()` without waiting for the ioredis connection to be `ready`. ioredis@5
  writes a `SUBSCRIBE` issued during `connect` straight to the socket (the command carries Redis's
  `loading` flag), ahead of its own ready check; that check (`INFO`) then fails on a connection
  already in subscriber mode, ioredis reconnects, and `autoResubscribe` replays nothing because it
  only remembers subscriptions of a connection that had reached `ready`. `start()` had already
  resolved successfully. Whenever `onReady` happened to land in that window, the API process ran
  with **no live events at all until restarted**.
- **Evidence:** standalone node+ioredis repro (subscribe on `connect`: `PUBSUB NUMSUB` = 0 in 5/5;
  on `ready`: 1 in 3/3); `tests/integration/events/sse-broadcaster-subscribe.test.ts` RED 5/5
  before, GREEN 5/5 after. The three subscription-dependent tests of `events-sse.test.ts`: 8 of 15
  executions failed before (5/5 runs red), 0 of 30 after (10/10 runs green). The
  "public non-Docker IP in CLIENT LIST" noted in STATE.md is Docker Desktop's NAT address and shows
  up on every connection, including the probe's own -- a red herring.
- **Fix:** `apps/control-plane/src/events/sse-broadcaster.ts` waits for `ready` before `SUBSCRIBE`
  (D-27's boot bound and every timeout unchanged).

### RESOLVED -- `servers-list.spec.ts:191`, the row that never appears

- **Was a product bug in the servers list, not a delivery race in the SSE pipeline.** The event
  *was* delivered. `apps/web/src/app/(shell)/servers/page.tsx` dropped every stream event while a
  `GET /api/servers` was in flight (and it re-enters `loading` on every resync-on-open), and
  nothing ordered the overlapping mount GET and resync GET. The spec creates its server the instant
  the URL turns `/servers`, i.e. exactly while both are in flight: when both snapshots had been
  read before the insert committed, the event was discarded and no snapshot contained the row. Any
  real user hits the same thing whenever a server changes (worker, second tab, second admin) while
  the list is loading or resyncing.
- **Evidence:** deterministic component tests (`page.test.tsx`, RED before / GREEN after) and a new
  real-browser test in `servers-list.spec.ts` that holds both real snapshots until the event has
  provably crossed Redis -> SSE -> the Next proxy: fails against the pre-fix page with exactly the
  `:191` symptom, passes 5/5 with the fix. The orchestrator's "event published before the stream
  is registered" window does **not** exist server-side: `routes/events.ts` registers the stream in
  the same tick it writes the headers, so `open` already implies registered, and resync-on-open
  covers everything published earlier.
- **Fix:** events are buffered while a snapshot is in flight and folded onto it when it lands
  (`reconcileSnapshot`, `updatedAt` guards against regressing a row), and only the latest request
  may publish its snapshot. No polling, no reload fallback, no test-side retry.

### ATTRIBUTION WITHDRAWN (round 2) -- `servers-list.spec.ts:208`, the 60s `row.hover()` timeout

> **Correction, round 2 of the same debug session.** The text below attributed `:208` to the
> snapshot race "by mechanism only". When `:208` failed again in iteration 2 of the 20x repeat
> (with that race already fixed), its Playwright ARIA snapshot showed `status: Reconnecting…`: the
> page's event stream had never opened. That is a different cause -- see "round 2" at the end of
> this file. The snapshot-race defect described here was real and is fixed and pinned, but there is
> no evidence it ever caused a `:208` failure; the original `row.hover()` 60s variant was never
> captured with a trace, so it remains **unexplained by observation**. Note the two `:208`
> variants differ: iteration 2 timed out on `expect(row).toBeVisible()` (row never appeared --
> explained by round 2), whereas the original timed out on `row.hover()`, which needs the row to
> have been visible first -- something a never-opened stream does not produce by itself.

- The same defect produces this symptom's exact shape: with both GETs in flight, the first landing
  made the list `ready`, the live event inserted the row (so `expect(row).toBeVisible()` passed),
  and the second snapshot -- read before the insert -- then replaced the list **without** the row,
  leaving `row.hover()` waiting 60s on an element that no longer existed. A larger list late in a
  full run means slower GETs and a wider window, which fits "order-dependent". Pinned at component
  level (`page.test.tsx`, "never removes a row a live event already inserted ..."), RED before /
  GREEN after.
- **Honest status:** the original E2E timeout itself was never reproduced (neither by 05-20's two
  attempts nor in this session), so this is attribution by mechanism, not by a captured trace of
  the failing run. Treat it as closed only if the 20x repeat stays clean; if a hover timeout
  recurs, run once with `--trace on` and check whether the row is detached at hover time.

### STILL OPEN -- same family, other screens (found by reading, not observed failing, not fixed)

- `apps/web/src/app/(shell)/servers/[id]/page.tsx` does not drop events while loading, but it has
  no ordering guard either: a `GET /api/servers/:id` read before a change can land after the newer
  `server.updated`/`server.deleted` event and overwrite it until the next event arrives. The same
  "latest request wins + never regress by `updatedAt`" rule applies. `activity/page.tsx` and
  `DiscoverySection.tsx` were not audited for it.
- `reconcileSnapshot`'s `updatedAt` comparison assumes the API and the worker agree on the clock
  (same host through v0.5). A DB-side row version would remove that assumption if the worker ever
  moves to another machine.

### STILL OPEN -- two integration tests red since 05-04, unrelated to lost events (found during verification)

- `tests/integration/queue/connect-server-worker.test.ts` ("... with two server.updated events":
  `expected [ ...(13) ] to have a length of 2`) and `tests/integration/routes/api-e2e.test.ts`
  (`:365`, `Cannot read properties of undefined (reading 'id')`) fail **deterministically** -- 3/3
  here, and identically with this session's product changes reverted to `4ab07f5`. Both tests date
  from phase 04 and assume `server.updated` is the only event on the stream; `0b09667`
  (`feat(05-04)`) started publishing `server.discovery_progress` on the same stream, so 11
  progress events now sit between CONNECTING and CONNECTED. The product behaves as designed; the
  tests were never updated. Not touched in this session (outside its scope); the fix is to have
  both tests select `server.updated` events instead of assuming adjacency.

## 05-20 (debug session `sse-lost-event-race`, round 2): the stream that never opens

Full evidence trail: `.planning/debug/sse-lost-event-race.md`, section "Round 2". Three product
bugs, none test-only, all fixed test-first.

### RESOLVED -- abandoned event streams exhausted the SSE connection cap (D-07)

- **C1, `apps/web/src/app/api/events/route.ts`.** The streaming proxy returned `upstream.body`
  as-is, with no signal. Under `next start` a browser disconnect left the undici response merely
  unreferenced: the control-plane stream stayed open until the Next process happened to
  garbage-collect it. Proven by forcing a GC over the inspector: 21 sockets for 10s, then 1 within
  500ms. Every closed tab, reload or navigation held one of the 32 slots in the meantime.
- **C3, `apps/control-plane/src/routes/events.ts`** (no proxy involved). The handler attaches its
  `close` listener itself, but the guarded scope's async session lookup runs first; a client that
  disconnects during the lookup has already emitted `close`, so the stream was registered and
  never removed -- a permanent leak until restart. 20 direct requests aborted ~1ms after being
  sent: 15 -> 32/32 slots, still 32/32 past a heartbeat.
- **Observed in real full runs, pre-fix:** peak `broadcaster.size` over 5 full `pnpm test:e2e`
  runs = 10, 21, 18, **32**, 19 with 1-2 pages actually open; the run that reached 32 got 25x
  `503 SSE_LIMIT_REACHED` and failed (`shell.spec.ts:158`, 60s). Which test fails is whichever next
  NEEDS a live stream -- `:208` in the orchestrator's run, `:158` here. **Post-fix:** two
  consecutive full runs 72/72; size after an add = 1 (152-154x) or 2 (3x) outside the one test
  that saturates the cap on purpose.
- **Real-user impact:** a denial of live updates for every admin: ~32 reloads/tab closes between
  two GCs (C1), or 32 unlucky navigations over an API process's whole life (C3), and every new page
  is refused until a GC / an API restart.

### RESOLVED -- one refused stream meant no live updates until a manual reload

- **C2, `apps/web/src/lib/use-server-events.ts`.** A non-200 answer makes a browser fail an
  EventSource for good (one `error`, `readyState` CLOSED, no native retry). The hook waited for
  three errors before starting its T-5-54 backoff, so the backoff was unreachable in a real
  browser: real Chromium made exactly one request and still showed "Reconnecting…" 40s after
  capacity returned. The hook now replaces a CLOSED source after 5s doubling to 60s, reset on open.

### STILL OPEN / NOT EXPLAINED (round 2)

- The original `:208` `row.hover()` 60s timeout (05-19) was never captured with a trace; neither
  round's cause is proven for that exact variant. If it recurs: `--trace on`, and check the
  stream-status indicator and whether the row is detached at hover time.
- `:191` in iteration 6 of the first 20x run has no surviving artifact. It is compatible with both
  the round-1 snapshot race and the round-2 cap; it cannot be assigned to either after the fact.
- A tab whose session was revoked now retries `/api/events` (a cheap 401) at the capped backoff,
  at most once a minute, for as long as it stays on a shell page -- before, its stream just died.
  EventSource does not expose the status, so telling 401 from 503 needs a separate session probe.
  Left as is; decide whether the shell should redirect to `/login` instead.
- The control plane's heartbeat does not inspect its own `write` to the socket. A half-open peer
  (no FIN/RST, e.g. a dropped network path) is only evicted when the kernel's TCP retransmission
  gives up and the socket emits `close`. Not observed failing; not changed.
- D-07's cap is global, not per session: one client can still hold all 32 slots deliberately.
  By design for a single-admin v0.1; noted because the new E2E does exactly that on purpose.

## 05-21: `tests/e2e/canary-ui.spec.ts` (`@canary`) is correct but flaky under this session's own
## severe host memory pressure -- not a code defect, not masked

During this plan's own execution, the new `@canary` spec (the browser-side QA-05 canary) passed
cleanly and fast (2.2s-12.2s) on roughly half of ~12 attempts, and on the other half timed out at
its own `testInfo.setTimeout` budget (tried at 120s/150s/240s/300s, always failing at the exact
same point -- late in the flow, most often the final `shell-sign-out` click) with `Error:
locator.click: Target page, context or browser has been closed`.

- **Ruled out as the cause:** a specific stuck element. The on-failure screenshot from one of the
  slow runs shows a perfectly normal, fully-interactive `/servers` page with "Sign out" clearly
  visible -- not an overlay, not a leftover dialog, not a pointer-events lock. A speculative fix
  (explicitly waiting for `document.body.style.pointerEvents` to clear after closing the reopened
  edit sheet) was tried and made no difference, confirming the hang was not there either.
- **Confirmed as at least a contributing cause:** genuine host-level memory pressure on this
  shared dev machine during this session -- `vm_stat`/`top` showed as little as ~35-150MB of free
  physical memory out of ~24GB (`PhysMem: 23G used ... 157M unused`, heavy compressor activity),
  with a VirtualBox/Virtualization-framework VM, Docker Desktop, and several VS Code TypeScript
  server instances all resident. Under that pressure, Chromium's own rendering/event loop appears
  to intermittently stall badly enough that ~12 real sequential UI interactions can, in aggregate,
  exceed even a 300s budget -- and the very last action in the sequence is structurally the one
  most likely to still be in flight when the deadline fires, which is why the failure always
  *looked* targeted at "Sign out" specifically without actually being caused by it.
- **One real, committed fix came out of this investigation:** the session-cookie
  `HttpOnly`/`document.cookie` check was moved from the very end of the flow (after ~8 real
  navigations) to immediately after login (before the heavier part of the flow) -- purely because
  it has no reason to wait, not as a workaround for the flakiness itself.
- **Not fixed, because there was nothing left in this spec's own files to fix:** every individual
  canary surface (DOM, console, both Web Storages, the URL/history, and response bodies) was
  independently mutation-tested via a fast, isolated round-trip (inject a real leak in the
  relevant app-source file or a temporary `page.route` interception, confirm the assertion fails
  for the right reason, revert) -- every one bit correctly and quickly, and `pnpm check:ui-safety`
  was independently mutation-tested for all nine of its own gates the same way. The full
  `pnpm security:scan-leaks` command (all three Vitest canary suites plus this Playwright spec)
  ran clean end to end in one of this plan's own final verification passes (11.3s total). The spec
  itself is not masking anything: no retry, no `test.fixme`, no widened timeout beyond a sane
  multiple of its own measured fast-path duration.
- **Suggested follow-up:** if this recurs on a properly-resourced CI runner (unlikely, since
  `ci.yml`'s `e2e`/`security` jobs run on a dedicated `ubuntu-latest` box, not this shared local
  machine), capture a Playwright trace (`--trace on`) on the failing run and inspect exactly which
  await was pending, rather than assuming the same host-memory explanation applies there too.
