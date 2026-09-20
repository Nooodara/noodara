---
status: resolved
trigger: "Investigate and fix the root cause of intermittently LOST live server events (SSE) in Noodara (events-sse.test.ts flake, canary-http SSE assertion flake, E2E servers-list.spec.ts:191 row never appears via live SSE)"
created: 2026-09-19T23:17:15Z
updated: 2026-09-20T00:00:00Z
---

## Current Focus
<!-- OVERWRITE on each update - reflects NOW -->

round: 2 -- see "Round 2: stream never opens (SSE connection cap)" at the end of this file.
hypothesis: three product bugs confirmed and fixed -- C1 (Next proxy releases its upstream stream only on GC), C3 (control plane registers a stream for a peer that left during the session lookup and never removes it), C2 (the hook never retries an EventSource the browser failed over HTTP).
test: orchestrator runs `node scripts/e2e-repeat.mjs 20`.
expecting: 20/20. A page stuck on "Reconnecting…" would reopen round 2: log broadcaster.size on add/remove (see Round 2 Evidence 03:20 for the exact temporary instrumentation) and check for 503s.
next_action: await human verification; on confirmation run archive_session (move to resolved/, append knowledge-base entry covering rounds 1 and 2).

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

---

# Round 2: stream never opens (SSE connection cap)

Round 1 above is left as written. Round 2 reopens the session because the orchestrator's 20x repeat failed in iteration 2 at tests/e2e/servers-list.spec.ts:208 with a symptom round 1 did not explain.

## Round 2 Symptoms
<!-- IMMUTABLE -->

expected: every shell page opens the shared EventSource within moments of load, for the whole length of a full E2E run.
actual: iteration 2 of `node scripts/e2e-repeat.mjs 20`, test #50 of 70 (servers-list.spec.ts:208): `expect(row).toBeVisible()` timed out after 15s. The ARIA snapshot at failure shows `status: Reconnecting…` -- the EventSource was NOT open 15s after load. The list rendered 8 rows from the mount GET. No stream => no live event and no resync-on-open => the API-created row can never appear.
errors: `expect(locator).toBeVisible() failed ... element(s) not found`; StreamStatus "Reconnecting…".
reproduction: not yet deterministic (1 of 2 full runs).
started: first attributed (wrongly?) to the snapshot race in round 1.

## Round 2 Eliminated
<!-- APPEND only -->

- hypothesis: the control plane evicts every stream whose peer goes away (my own 01:03 conclusion)
  evidence: true only for peers that close an OPEN stream (N=100 direct: all released). False for peers that leave during the session lookup: 20 direct early aborts took the cap 15 -> 32/32 for good (C3).
  timestamp: 2026-09-20T02:05:00Z

- hypothesis: ESTABLISHED sockets on :3100 measure broadcaster.size
  evidence: the rewrites proxy's keep-alive sockets look identical; 3 leaked slots hid behind a steady "6". Replaced by an exact oracle (hold direct streams until 503), which itself needed fixing (it let undici GC its own held responses, reading -8 twice).
  timestamp: 2026-09-20T01:50:00Z

- hypothesis: the refusal at failure time is something other than the SSE cap (session-lookup timeout, Better Auth rate limit, API HTTP connection limits, Chromium 6-per-host)
  evidence: in the failing pre-fix full run the control plane itself logged 25 REJECT_503 at size 32; no other refusal path was hit.
  timestamp: 2026-09-20T03:20:00Z

## Round 2 Evidence
<!-- APPEND only -->

- timestamp: 2026-09-20T00:30:00Z
  checked: test-results/servers-list--servers-a-ro-8b0b7-…/error-context.md (on disk)
  found: ARIA snapshot contains `- status: Reconnecting…` under the Servers heading, with 8 rows from earlier specs rendered.
  implication: confirms the orchestrator's reading -- the failure is "stream not open", not "event dropped". Round 1's by-mechanism attribution of :208 to the snapshot race is not supported by this artifact.

- timestamp: 2026-09-20T00:32:00Z
  checked: apps/web/src/app/api/events/route.ts, apps/control-plane/src/routes/events.ts, apps/web/src/lib/use-server-events.ts (read)
  found: (1) route.ts fetches upstream with no `signal`, no timeout, no catch. (2) events.ts removes a stream only on `request.raw.on('close')` or a failed heartbeat SESSION check; the heartbeat `reply.raw.write` result/error is never inspected. (3) use-server-events.ts only starts its own backoff after 3 `error` events, but per the HTML spec a non-200 / non-event-stream response makes EventSource FAIL the connection permanently (readyState CLOSED, one `error` event, no native retry) -- so a single 503 may leave the page on "Reconnecting…" forever. To verify in a real browser.
  implication: three separate candidate defects; none proven yet.

- timestamp: 2026-09-20T00:45:00Z
  checked: BASELINE REPRO 1 (unmodified code, real stack via tests/e2e/fixtures/stack.ts, `next start`). Scratchpad script: sign in, then N=40 times { fetch :3000/api/events with the session cookie, read first chunk, AbortController.abort() }, then sample `lsof -iTCP:3100 -sTCP:ESTABLISHED` (server-side sockets) and probe one more open.
  found: run 1: 40x200, 27 sockets right after the loop, 1 after 20s, probe 200. Run 2 (same script, 1s sampling): 31x200 then 503 from open #32 onwards (9x503); sockets = 34 on EVERY one of 23 one-second samples; probe 503. 60+ seconds later still 34, all between the Next server PID and the API PID, 0 in CLOSE_WAIT. Two 15s heartbeats passed without releasing anything.
  implication: the client going away does NOT deterministically tear down the Next handler's upstream fetch. The 503 SSE_LIMIT_REACHED is reproduced through the real proxy. Release is non-deterministic (run 1 drained, run 2 did not).

- timestamp: 2026-09-20T00:50:00Z
  checked: what releases the leaked sockets. With 34 leaked and idle, generated allocation pressure on the Next process only (sequential GET /login, no /api/events traffic), sampling the socket count every 150 requests.
  found: 34, 34, 34, 34, 34 (after 600 requests), then 2 after 750, 2 after 900.
  implication: the leaked upstream streams are released all at once by something inside the Next process unrelated to the streams themselves -- consistent with garbage collection finalising the abandoned undici Response bodies (undici registers fetch bodies in a FinalizationRegistry and cancels them on GC). New hypothesis H-GC: teardown of the upstream connection currently happens ONLY via GC, which is why the failure is intermittent and load/order dependent. Next test: force a GC through the inspector and watch the count.

- timestamp: 2026-09-20T01:00:00Z
  checked: H-GC, decisive test. Second `next start` of the same build on :3011 with `--inspect`; 20x open+abort through it; sampled API-side sockets for 10s; then sent `HeapProfiler.collectGarbage` to that Next process over the inspector.
  found: sockets = 21 on all 10 one-second samples (baseline 1); within 500ms of the forced GC: 1 1 1 1 1.
  implication: H-GC CONFIRMED. In `next start` (Next 16.3.5, Node 24.13) a downstream disconnect does not cancel `upstream.body`; the upstream control-plane stream is released only when V8 garbage-collects the abandoned undici Response (undici's FinalizationRegistry cancels the body). Between GCs every closed page/tab/reload holds one of the 32 D-07 slots. Whether a given E2E run hits the cap depends on where major GCs of the Next process fall -- that is the intermittency and the "only late in a full run" order dependence.

- timestamp: 2026-09-20T01:03:00Z
  checked: control plane in isolation -- same open+abort loop DIRECTLY against :3100, N=100
  found: 100x200, no 503, API-side sockets 1 1 1 1 immediately after the loop, probe 200.
  implication: the control plane evicts a stream promptly when its peer closes (`request.raw.on('close')` -> broadcaster.remove). The leak is entirely in apps/web/src/app/api/events/route.ts. No second bug found on the control-plane side for a closed peer.

- timestamp: 2026-09-20T01:10:00Z
  checked: what a real browser does with the 503. Playwright Chromium, cap saturated by 32 held direct streams, load /servers, log every /api/events response for 25s, then release all 32 and watch 40s more.
  found: exactly ONE request (`+0.1s /api/events -> 503`), never retried; status "Reconnecting…" at 25s and STILL "Reconnecting…" 40s after capacity returned.
  implication: SECOND PRODUCT BUG (C2). Per the HTML spec a non-200 response makes EventSource fail the connection for good (readyState CLOSED, one `error`, no native retry). use-server-events.ts only starts its own backoff after PRE_OPEN_FAILURE_THRESHOLD=3 `error` events, which can never happen for an HTTP-level rejection -- the T-5-54 backoff is dead code in a real browser. One 503 at page load = no live updates until a manual reload. This is exactly the failing E2E's signature (one page, "Reconnecting…" for the whole 15s). The existing unit tests must be driving a fake EventSource that emits repeated errors; to check.

- timestamp: 2026-09-20T01:25:00Z
  checked: RED for C1, pre-fix code. Unit: apps/web/src/app/api/events/route.test.ts. E2E: new `@sse-slots` test in tests/e2e/shell.spec.ts (40 open-then-abandon through the real proxy, then a fresh stream must open 200 within 5s), run 3x against the held pre-fix stack.
  found: unit 6 failed / 3 passed (the 3 are characterisation of kept behaviour). E2E: failed 2 of 3 with `Expected: 200 Received: 503`; the one pass coincided with a GC of the Next process. Committed as 8d926d1 `test(05-20): reproduce abandoned event streams exhausting the SSE cap`.
  implication: RED for the right reason. Pre-fix non-determinism is the bug's own nature (GC timing), not test flakiness.

- timestamp: 2026-09-20T01:40:00Z
  checked: falsification test for the C1 fix (one AbortController aborted by request.signal, by cancellation of a pass-through body, and by a 10s headers timeout). Rebuilt `next start`, same probe, no GC forced.
  found: N=40: 40x200, API-side sockets 1 on 13/13 samples, probe 200. N=200: 200x200. N=300: 300x200. (Before: 503 from open #32, 34 sockets for 60s+.)
  implication: the main leak path (client aborts an OPEN stream) is closed.

- timestamp: 2026-09-20T01:50:00Z
  checked: exact oracle for broadcaster.size -- hold direct :3100 streams until the cap answers 503; used = 32 - held. Then: abort the proxied request 0/1/2/3/5/8 ms after SENDING it (before response headers), 10 per delay.
  found: WITH the fix, 3 slots were permanently held after three Playwright sessions whose login page was closed right after landing on /servers, and early aborts leak more: used = 3 -> 4 -> 6 -> 12 -> 14 -> 15 -> 15. ESTABLISHED-socket counts had hidden this (keep-alive sockets of the rewrites proxy look the same).
  implication: the fix is INCOMPLETE. There is a window -- client gone before/around the moment the handler returns its Response -- in which neither request.signal's `abort` nor the body's `cancel()` reaches the handler. Do not commit the fix yet. Next: instrument the handler (labels/counters only, no cookies) to see which callbacks fire for an early abort.

- timestamp: 2026-09-20T02:05:00Z
  checked: residual leak, instrumented handler (labels only; removed afterwards) on a separate `next start`, client aborting +2ms after sending.
  found: the Next handler behaves correctly for early aborts -- `request.signal abort event` then `fetch rejected`, every time. Yet slots still leaked. Repeating the early-abort loop DIRECTLY against :3100 (no Next at all): slots used 15 -> 23 -> 32/32 after 20 aborts, and still 32/32 (every new stream 503) 20s later, i.e. past a heartbeat.
  implication: THIRD PRODUCT BUG (C3), in the control plane, independent of any proxy -- the orchestrator's "check the control-plane side independently" was right, and my 01:03 conclusion ("no second bug on the control-plane side") was wrong: it only covered peers that close an OPEN stream.

- timestamp: 2026-09-20T02:15:00Z
  checked: C3 mechanism. apps/control-plane/src/routes/events.ts registers `request.raw.on('close', cleanup)` inside the handler, but the guarded scope's async session lookup (onRequest) runs first. Deterministic unit test: an onRequest hook that settles only after the peer's socket closed, real TCP client that disconnects while it waits.
  found: RED 3/3 -- `expected 1 to be +0`: the handler hijacks, registers the stream and attaches a `close` listener to a request that already emitted `close`; nothing ever removes it (the heartbeat only re-checks the session, which is still valid, and its write to a destroyed socket fails silently).
  implication: C3 root cause confirmed. Real-user trigger: any navigation/reload/tab close that lands during the few ms of the session lookup -- e.g. a login page closed right after landing on /servers leaked exactly one slot per Playwright session (3 sessions -> 3 slots). Each leaked slot is permanent until the API restarts, so this one accumulates without bound over an API process's life, GC or not.

- timestamp: 2026-09-20T02:30:00Z
  checked: falsification for C3 + C1 together, rebuilt stack, no instrumentation. (Oracle corrected: it now keeps its own Response objects referenced -- two earlier `-8` readings were the ORACLE's held streams being GC-released by undici in my own script, the same mechanism as C1.)
  found: direct early aborts 0/1/2/3/5ms x10: slots used 0,0,0,0,0 (before 15->32). Proxied early aborts x6 delays + 3 more rounds at +2ms: 0 every time (before 3->15). Real Chromium, 45 /servers pages opened and closed after one login whose page is closed immediately: slots still used after every 5th page = 0 x9, 0 non-200 /api/events responses, 0 after browser close (before: +1 permanent slot per session from the login page alone).
  implication: both falsification tests passed. Stream count now tracks the number of actually open pages.

- timestamp: 2026-09-20T02:50:00Z
  checked: C2 RED/GREEN. Unit: apps/web/src/lib/use-server-events.test.tsx with a spec-faithful fake EventSource (HTTP rejection => CLOSED + one `error`; network drop => CONNECTING). E2E: new `@sse-recover` (hold every slot, load the shell into the 503, release, expect the indicator to disappear).
  found: pre-fix unit 6 failed / 3 passed (the 3 are guards: network drop left to the browser, no reconnect after close()/unmount); pre-fix E2E failed `toBeHidden ... Received: visible` after 15s. With the fix: unit 9/9, E2E green in both full runs below.
  implication: C2 confirmed and fixed.

- timestamp: 2026-09-20T03:20:00Z
  checked: THE REAL THING, pre-fix. Temporary size logging in events.ts (label + broadcaster.size + timestamp only; removed afterwards), product files temporarily restored to 1ddac6e, 5 full `pnpm test:e2e` runs (the two new cap tests excluded).
  found: peak broadcaster.size per run = 10, 21, 18, 32, 19 with only 1-2 pages ever actually open. Runs 1,2,3,5: 111 streams opened, 0x503, 70/70. Run 4: peak 32, 25x `503 SSE_LIMIT_REACHED`, 69 passed / 1 FAILED -- shell.spec.ts:158 `@sse-live`, 60s timeout (its in-page fetch of /api/events was refused). 1 of 5 runs red.
  implication: the failure is reproduced in a real full run with its cause on record: abandoned streams pile up until the next GC of the Next process, and when no GC falls in time the cap is hit and whichever test next needs a live stream fails -- :208 in the orchestrator's run, :158 here, plausibly :191 in the first 20x run. Same cause, different victim. Note only tests that NEED the stream fail; the other 24 refused pages passed, which is why this hid so well.

- timestamp: 2026-09-20T03:30:00Z
  checked: post-fix, same size logging, TWO consecutive full `pnpm test:e2e` runs (all 72 tests, including the two new cap tests).
  found: run 1: 72 passed, 187 opened / 187 removed. Run 2: 72 passed, 185 opened / 185 removed, 2 requests skipped as already-gone peers (C3's path really occurs in a normal run). size-after-add histogram, both runs: size 1 -> 152-154 times, size 2 -> 3 times, then exactly one add at each size 3..32 and 2x503 -- that ramp is `@sse-recover` deliberately holding every slot. Peak outside that test = 2 (before: 10-32).
  implication: the stream count now tracks the number of open pages instead of climbing.

## Round 2 Resolution
<!-- OVERWRITE -->

root_cause: |
  The orchestrator's lead held for C1 and was incomplete: three independent PRODUCT bugs.
  (C1) apps/web/src/app/api/events/route.ts returned upstream.body with no signal. Under `next start` a browser disconnect only left the undici response unreferenced; the control-plane stream was released when V8 next garbage-collected it (forced GC: 21 sockets -> 1 in 500ms). Abandoned streams piled up against NOODARA_SSE_MAX_CONNECTIONS=32 between GCs.
  (C3) apps/control-plane/src/routes/events.ts attached its `close` listener inside the handler, after the guarded scope's async session lookup. A peer that left during the lookup had already emitted `close`: registered, never removed, permanent until restart. No proxy needed.
  (C2) apps/web/src/lib/use-server-events.ts waited for three `error` events before backing off, but a browser fails an EventSource for good on any non-200 (one `error`, CLOSED). One 503 => "Reconnecting…" until a manual reload. This is what turned a transient cap hit into a 15s test failure.
  Refuted alternatives: 05-01's bounded session lookup, Better Auth rate limiting, the API's HTTP connection limits and Chromium's 6-per-host limit played no part -- the refused requests were logged as `503 SSE_LIMIT_REACHED` by the control plane itself (25 in the failing pre-fix run).
fix: |
  (C1) one AbortController owns the upstream lifetime: aborted by request.signal, by cancel() of a pull-based pass-through body, or by a 10s connect/headers timeout cleared once headers arrive; a rejected upstream fetch answers a fixed 503 (no error details, Retry-After: 5). Status and Retry-After still forwarded.
  (C3) the handler returns before hijacking when request.raw or its socket is already destroyed; nothing awaits between that check and the listener.
  (C2) a CLOSED source is replaced after 5s doubling to 60s, reset on open; network-level drops stay with the browser.
  Not changed: the cap (product default and E2E env), the event allowlist, the heartbeat session re-check, the bounded session lookup. No retries, sleeps, skips or polling.
verification: |
  Deterministic repro, N=40 open+abort through the proxy: before 503 from open #32, 34 API-side sockets for 60s+; after 40x200, 200x200, 300x200, slots used 0. Early aborts: before 15->32 direct / 3->15 proxied; after 0 everywhere. Real Chromium, 45 pages opened+closed: 0 slots held at every sample (before: +1 permanent per session).
  Full runs pre-fix (5): peak size 10, 21, 18, 32, 19; one run red with 25x503. Post-fix (2 instrumented + 2 on final code): 72/72 x4; size after add 1 or 2 outside the test that saturates the cap on purpose.
  RED->GREEN: route.test.ts 6 red/3 -> 9; events.test.ts 1 red (3/3) -> green; use-server-events.test.tsx 6 red/3 -> 9; E2E @sse-slots red 2 of 3 -> green; @sse-recover red -> green.
  pnpm test 1381 passed (107 files); typecheck, lint, boundaries, build clean; security:scan-leaks 3/3; events-sse + canary-http + sse-broadcaster-subscribe 12/12; after E2E no noodara.test containers, nothing on 3000/3100.
  NOT run: the 20x repeat (orchestrator's) and full `pnpm test:integration`.
files_changed:
  - apps/web/src/app/api/events/route.ts
  - apps/web/src/app/api/events/route.test.ts
  - apps/control-plane/src/routes/events.ts
  - apps/control-plane/src/routes/events.test.ts
  - apps/web/src/lib/use-server-events.ts
  - apps/web/src/lib/use-server-events.test.tsx
  - tests/e2e/shell.spec.ts
  - tests/e2e/servers-list.spec.ts
  - tests/e2e/server-sheet.spec.ts
  - tests/e2e/server-detail.spec.ts
  - .planning/phases/05-ui-web/deferred-items.md
  - .planning/todos/completed/2026-09-19-sse-route-handler-robustness.md (moved from pending/ -- fully covered)

## Resolution confirmed (orchestrator, 2026-09-20)

Confirmed fixed: `node scripts/e2e-repeat.mjs` 20/20 clean as three invocations (7+7+6), 72/72 each, after rounds 1 and 2; later full `pnpm test:e2e` 73/73 and full `pnpm test:integration` 487/0/1. Still unexplained, carried to `05-20-SUMMARY.md` and `05-VERIFICATION.md`: the original `:208` `row.hover()` 60s timeout, and the first run's iteration-6 `:191` failure (no artifact).
