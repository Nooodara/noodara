---
status: awaiting_human_verify
trigger: "Investigate and fix the root cause of intermittently LOST live server events (SSE) in Noodara (events-sse.test.ts flake, canary-http SSE assertion flake, E2E servers-list.spec.ts:191 row never appears via live SSE)"
created: 2026-09-19T23:17:15Z
updated: 2026-09-20T02:35:00Z
---

## Current Focus
<!-- OVERWRITE on each update - reflects NOW -->

hypothesis: both root causes (A: SUBSCRIBE before ioredis `ready`; B: servers list drops/overwrites events around in-flight snapshots) confirmed and fixed.
test: orchestrator runs `node scripts/e2e-repeat.mjs 20`.
expecting: 20/20 clean. A `row never appears` or `row.hover()` timeout recurring would reopen B (run once with --trace on and check whether the row is detached).
next_action: await human verification; on confirmation run archive_session (move to resolved/, append knowledge-base entry).

## Symptoms
<!-- Written during gathering, then IMMUTABLE -->

expected: every server event published while a client is on a live screen ends up reflected in that screen; SSE integration tests pass deterministically.
actual: (1) tests/integration/routes/events-sse.test.ts intermittent failures ("2 of 10, different pair each run"); (2) tests/integration/activity/canary-http.test.ts SSE assertion intermittently fails; (3) E2E iteration 6/20 failed at tests/e2e/servers-list.spec.ts:191 -- a server created via the real API never appeared as a row via live SSE. Related unreproduced flake at :208 (row.hover() 60s timeout late in a full run).
errors: row locator never visible (E2E); SSE frame never received within test timeout (integration).
reproduction: node scripts/e2e-repeat.mjs 20 (1 in ~6); repeated runs of the integration suites.
started: long-standing for (1); observed throughout phase 05.

## Eliminated
<!-- APPEND only - prevents re-investigating -->

## Evidence
<!-- APPEND only - facts discovered -->

- timestamp: 2026-09-19T23:20:00Z
  checked: apps/control-plane/src/routes/events.ts
  found: `reply.raw.writeHead(200)`, `write(RETRY_FIELD)` and `deps.broadcaster.add(stream)` all run synchronously in the same tick of the route handler. No await between headers and registration.
  implication: orchestrator sub-question (a) -- headers cannot be observed by any client before the stream is in the broadcaster's set (the socket flush happens after the tick). `open` => registered holds at the control plane.

- timestamp: 2026-09-19T23:21:00Z
  checked: apps/control-plane/src/app.ts onReady hook
  found: `broadcaster.start()` (Redis SUBSCRIBE) is awaited inside `onReady`, bounded by BROADCASTER_STARTUP_TIMEOUT_MS=2000; on timeout the app becomes ready WITHOUT a live subscription (by design D-27, autoResubscribe finishes later).
  implication: sub-question (b) -- normally SUBSCRIBE is acked before listen. Only the 2s-timeout path leaves a window; need to check whether tests inject their own broadcaster / call start() themselves.

- timestamp: 2026-09-19T23:23:00Z
  checked: apps/web/src/app/(shell)/servers/page.tsx + lib/use-server-events.ts
  found: the SSE listener returns early when `stateKindRef.current !== 'ready'`; `fetchServers()` always does `setState({kind:'loading'})` first and is invoked (1) on mount and (2) again on every stream `open` via registerResync. Two GETs are typically in flight around page load, with no ordering guard between their responses.
  implication: two candidate product-side loss mechanisms independent of the server: H1 (event dropped during loading, snapshot predates it) and H2 (older GET response lands after a newer one and overwrites it).

- timestamp: 2026-09-19T23:28:00Z
  checked: tests/e2e/servers-list.spec.ts:191 and :208
  found: both tests do `login()` (resolves as soon as URL is /servers) and IMMEDIATELY `page.request.post('/api/servers')`, then wait for the row with no reload. The POST therefore lands exactly while the page's mount GET and the resync-on-open GET are in flight (state `loading`).
  implication: the E2E timing is the exact shape H1/H2 need. Real users hit the same shape whenever another actor (worker, second tab, second admin) changes a server while the list is (re)loading.

- timestamp: 2026-09-19T23:29:00Z
  checked: tests/integration/routes/events-sse.test.ts
  found: the publish tests already gate on a real readiness signal (`waitForActiveSubscriber` polling PUBSUB NUMSUB) before publishing. They then assume the NEXT frame read is the event frame.
  implication: orchestrator sub-question (d) is already addressed for this file; the STATE.md "subscription-timing" label may be stale. Remaining integration flake must be measured, not assumed.

- timestamp: 2026-09-19T23:35:00Z
  checked: BASELINE for tests/integration/routes/events-sse.test.ts, unmodified code, 5 full runs (3 tests per run depend on the subscription => 15 subscription-dependent test executions)
  found: failures per run = 2, 2, 3, 1, 2 (first two + a third instrumented run + 2 of the 3 loop runs; one loop run had 2). Every failure is `waitForActiveSubscriber: no subscriber on noodara:server-events after 20000ms`. 5/5 runs red. `PUBSUB CHANNELS` at failure time = [] and CLIENT LIST shows the app's connections all with sub=0.
  implication: not a "published a few ms early" race. The app's subscription is GONE for good, while `broadcaster.start()` reported success. (The "public non-Docker IP" 151.101.0.223 in CLIENT LIST noted in STATE.md is Docker Desktop NAT -- it appears on every connection incl. the probe; red herring.)

- timestamp: 2026-09-19T23:50:00Z
  checked: temporary ordering instrumentation (subscriber lifecycle events + status at start())
  found: failing order is always: `connect` (status=connect, ready-check INFO not yet answered) -> `broadcaster.start()` -> `SUBSCRIBE acked after ~3ms` -> subscriber `error` (ReplyError) -> `close` -> `reconnecting` -> `connect` -> `ready` -> NO re-subscribe.
  implication: SUBSCRIBE is being written to the socket before ioredis's own ready check finishes.

- timestamp: 2026-09-19T23:58:00Z
  checked: ioredis@5.11.1 source (built/Redis.js sendCommand ~L356, built/redis/event_handler.js connectHandler/closeHandler/readyHandler)
  found: (1) a command carrying Redis's `loading` flag -- SUBSCRIBE does -- is written immediately while status is `connect`, instead of going to the offline queue; (2) the ready check then issues INFO on a connection already in subscriber mode, which fails -> `recoverFromFatalError('Ready check failed')` -> disconnect + reconnect; (3) `closeHandler` only snapshots `prevCondition` (the thing autoResubscribe replays) `if (prevStatus === 'ready')` -- it was `connect`, so nothing is replayed.
  implication: full mechanism explained from source, matches the observed order exactly.

- timestamp: 2026-09-20T00:05:00Z
  checked: standalone minimal repro (plain node + ioredis + throwaway redis:7-alpine, no vitest, no app): subscribe() issued from the `connect` event vs from the `ready` event
  found: on-connect 5/5 -> `subscribe() RESOLVED OK`, then error/close/reconnecting/connect/ready, PUBSUB NUMSUB = 0. on-ready 3/3 -> NUMSUB = 1.
  implication: ROOT CAUSE A CONFIRMED, deterministic. PRODUCT bug (not test-only): apps/control-plane `createSseBroadcaster().start()` calls `subscriber.subscribe()` without first waiting for the connection to be `ready`. If `onReady` fires while the subscriber socket is TCP-connected but not yet ready, that API process silently has NO live events until it is restarted, and start() reports success. The intermittency is just where `onReady` lands relative to the connection handshake. Explains symptoms 1 and 2 (canary-http uses the same app boot). Does NOT explain symptom 3: in the failing E2E iteration other SSE-dependent specs (critical-path) passed against the same API process, so the subscription was live there.

- timestamp: 2026-09-20T00:20:00Z
  checked: CORRECTION + pristine baseline. The 23:35 entry's run list was muddled (it mixed instrumented runs in). Clean numbers, unmodified code, command `vitest run --config vitest.integration.config.ts tests/integration/routes/events-sse.test.ts -t "publish delivers|real connect POST"` (the 3 tests that depend on the subscription), 5 recorded runs
  found: failed/3 per run = 2, 1, 1, 2, 2 => 8 of 15 executions failed (53%), 5 of 5 runs red, every failure the same waitForActiveSubscriber timeout. A 6th run produced no summary because my own half-written RED test broke the global-setup `pnpm build`; excluded. Some runs overlapped with local jsdom test runs (CPU noise).
  implication: baseline for root cause A.

- timestamp: 2026-09-20T00:30:00Z
  checked: deterministic repros, before any fix
  found: tests/integration/events/sse-broadcaster-subscribe.test.ts RED 5/5 (`expected 0 to be 1`); sse-broadcaster.test.ts 2 new unit tests RED; apps/web servers page.test.tsx 3 RED (create mid-flight, delete mid-flight, stale mount snapshot landing last) + reducer tests RED.
  implication: both root causes reproduce deterministically without timing.

- timestamp: 2026-09-20T01:10:00Z
  checked: after fix A (start() waits for `ready`): pinned integration test x5, and the same baseline command x10
  found: pinned test GREEN 5/5. Baseline command: 10 of 10 runs green, 30 of 30 executions passed (before: 8/15 failed).
  implication: falsification test for A passed -- hypothesis A stands.

- timestamp: 2026-09-20T01:12:00Z
  checked: apps/web/src/app/(shell)/servers/[id]/page.tsx (sibling screen, read only)
  found: it does not drop events while loading, but it has no ordering guard either: a GET read before a change can land after the newer `server.updated`/`server.deleted` event and overwrite it (`setState({kind:'ready', server: result.data})`), until the next event arrives.
  implication: same family as H2, NOT observed failing, NOT fixed in this session -- recorded as open in deferred-items.md.

- timestamp: 2026-09-20T01:40:00Z
  checked: real-browser falsification for B -- new test in tests/e2e/servers-list.spec.ts holds both real GET /api/servers snapshots (read before the server exists) until an observer EventSource has received the server.updated, then releases them
  found: against the pre-fix page: FAILS, row never visible (the exact :191 symptom). Against the fix: 5/5 pass (--repeat-each 5 used as measurement only; config retries stay 0).
  implication: H1 confirmed end-to-end through the real Redis -> SSE -> Next proxy -> browser path; falsification test for B passed.

- timestamp: 2026-09-20T01:55:00Z
  checked: page.test.tsx "never removes a row a live event already inserted when a snapshot read before it lands afterwards"
  found: RED on the pre-fix page, GREEN with the fix. Pre-fix sequence: GET#1 lands -> ready -> event inserts row (visible) -> GET#2 (read before insert) lands -> row removed.
  implication: candidate explanation for the :208 `row.hover()` 60s timeout (visible assertion passes, then the row is detached). NOT re-observed in E2E -- attribution by mechanism only.

- timestamp: 2026-09-20T02:30:00Z
  checked: full `pnpm test:integration`
  found: 485 passed, 2 failed, 1 skipped. The 2 failures (queue/connect-server-worker.test.ts, routes/api-e2e.test.ts) are deterministic and identical with this session's product changes reverted: phase-04 tests assuming only `server.updated` frames, broken since 0b09667 (05-04) added `server.discovery_progress` to the stream.
  implication: pre-existing, unrelated to lost events; logged in deferred-items.md, not fixed here.

## Resolution
<!-- OVERWRITE as understanding evolves -->

root_cause: |
  Two independent PRODUCT bugs (neither test-only):
  (A) apps/control-plane/src/events/sse-broadcaster.ts start() issued SUBSCRIBE before the ioredis subscriber connection was `ready`. ioredis writes it during `connect` ahead of its ready check; the check fails on a subscriber-mode connection; the reconnect replays nothing (prevCondition is only saved from `ready`). start() had already resolved -> the API process had no live events until restart. Explains symptoms 1 and 2.
  (B) apps/web/src/app/(shell)/servers/page.tsx dropped every stream event while a GET /api/servers was in flight (re-entering `loading` on every resync-on-open) and had no ordering between the overlapping mount and resync GETs. Explains symptom 3 (:191); likely explains :208 (not re-observed).
  The orchestrator's hypothesised window (headers before registration) does not exist: routes/events.ts registers the stream in the same tick it writes the headers.
fix: |
  (A) start() awaits the subscriber's `ready` (and skips SUBSCRIBE if closeAll() ran meanwhile). No timeout, allowlist or session re-check changed.
  (B) events are buffered while any snapshot is in flight and folded onto it by reconcileSnapshot (updatedAt guard); only the latest request publishes its snapshot.
verification: |
  A: pinned integration test RED 5/5 -> GREEN 5/5; events-sse subscription-dependent tests 8/15 failed (5/5 runs red) -> 0/30 (10/10 runs green); events-sse + canary-http + subscribe suites 4/4 full runs green.
  B: page.test.tsx 4 RED -> 5 GREEN; real-browser test RED on pre-fix page -> 5/5 GREEN.
  pnpm test 1361 passed; typecheck, lint, boundaries, build clean; security:scan-leaks 3/3; pnpm test:e2e 70 passed, ports 3000/3100 free and no noodara.test containers afterwards.
  pnpm test:integration: 485 passed / 2 failed / 1 skipped -- the 2 failures are pre-existing and unrelated (see Evidence 02:30).
  Pending: orchestrator's 20x E2E repeat + human confirmation.
files_changed:
  - apps/control-plane/src/events/sse-broadcaster.ts
  - apps/control-plane/src/events/sse-broadcaster.test.ts
  - tests/integration/events/sse-broadcaster-subscribe.test.ts
  - apps/web/src/lib/server-store.ts
  - apps/web/src/lib/server-store.test.ts
  - apps/web/src/app/(shell)/servers/page.tsx
  - apps/web/src/app/(shell)/servers/page.test.tsx
  - tests/e2e/servers-list.spec.ts
  - .planning/phases/05-ui-web/deferred-items.md
