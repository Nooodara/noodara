---
status: issues_found
phase: 05-ui-web
depth: standard
depth_note: "Area A (backend) reviewed at deep; areas B and C at standard. Split across three parallel reviewers because 203 files changed."
files_reviewed: 117
files_changed_in_phase: 203
scope_note: "Production sources, scripts, CI workflows and harness config. 69 unit-test files and 27 of 28 tests/ files were NOT reviewed."
diff_base: a7d7ab8
reviewed: 2026-09-20
findings:
  critical: 0
  warning: 37
  info: 23
  total: 60
---

# Code Review — Phase 05 (ui-web)

Advisory. Three reviewers (A backend, B apps/web, C packages/ui + scripts + CI), read-only, run in
parallel and merged by the orchestrator. Finding ids keep their area letter (`WR-A-01`, `WR-B-07`…).

**No critical findings**: nothing exploitable, no data-loss path, no realistic crash of the API
process. No route was found for a credential, connection URL, cookie or key material into an SSE
frame, activity row, error body, log line or the discovery endpoint.

## Orchestrator spot-checks

Four findings were re-verified against the code by the orchestrator before merging, because
twice in this phase a confident agent diagnosis turned out to be false. All four hold:

| Finding | Check | Result |
|---|---|---|
| WR-B-11 | `grep -i "AbortSignal\|AbortController\|timeout\|signal" apps/web/src/lib/api-client.ts` | No match outside error-code names. **api-client has no request timeout.** This contradicts 05-07-SUMMARY and the orchestrator's own wave-4 report to the user, both of which said it had them. Violates CLAUDE.md §2.3. |
| WR-B-07 | `http-errors.ts` emits `instancePath` (`"/name"`); `fieldErrorsFromIssues` tests `KNOWN_FORM_FIELD_PATHS.has(issue.path)` against bare names | Confirmed: server-side field errors never render. |
| WR-C-11 | The `security` job in `ci.yml` runs `pnpm security:scan-leaks` with no `playwright install` step | Confirmed: certain failure on first CI run; it is a merge gate. |
| WR-C-05 (correction) | `@radix-ui/react-dialog@1.1.23/dist/index.js:128-129` sets `aria-expanded` and `aria-controls` on the trigger | Confirmed: `docs/ui-review-05.md` FLAG 3 ("RowMenu lacks `aria-expanded`") is **false**. RowMenu's real defects are in WR-C-05. |

The other 56 findings are as reported by the reviewers and have not been independently verified.
Reviewers marked which of theirs were reproduced by running code versus found by reading.

## Highest priority

1. **WR-A-02 + known TOCTOU** — UF-01's fix rests on a false invariant (`pendingFingerprint` is
   non-null only in `ERROR`); a fingerprint captured against the old identity survives an identity
   edit from `CONNECTED`/`UNREACHABLE`. Fix together with the open trust-fingerprint
   display/action binding (`.planning/todos/pending/2026-09-19-trust-fingerprint-toctou.md`) and
   WR-B-12 (the dialog compares against the live prop, not the value shown on open). Host-key
   trust is non-negotiable per CLAUDE.md §2.3.
2. **WR-A-01** — any throw after the first transaction leaves a server stuck in `CONNECTING`
   until the worker restarts; the UI shows an endless "Connecting…". Predates the phase, now
   user-visible.
3. **WR-B-01 / WR-B-02 / WR-B-03** — server detail has the stale-snapshot race the list had, and
   the discovery checklist can show a previous run's checks or invented progress.
4. **WR-B-11** — no timeouts in `api-client.ts`.
5. **WR-B-07** — field errors never render.
6. **WR-C-11 / WR-C-12 / WR-C-13** — CI would fail on first run; no `permissions`, missing
   `timeout-minutes`, no SHA-pinned actions, unchecked `curl | tar`.
7. **WR-C-14** — the "non-bypassable" provenance gate covers 27 of 52 dependencies from a
   hardcoded list (misses `ssh2`, `argon2`, `better-auth`, `pg`, `fastify`, `pino`, `zod`), checks
   `latest` not the lockfile version, and trusts a publisher-asserted URL.
8. **WR-C-07 / WR-C-08** — more AA contrast failures beyond the status pills already routed to gap
   closure: primary button text in dark mode 3.02:1, filled destructive in both themes,
   `--ink-tertiary` content text down to 1.83:1.
9. **WR-C-01 / WR-C-02 / WR-B-13** — hydration mismatch for every user with a stored theme;
   `CopyButton` and the detail page throw when `navigator.clipboard` / `localStorage` are
   unavailable (plain-HTTP self-hosted origin, blocked storage).

---

# Area A — Backend (control plane + ssh), deep

**Depth:** deep (call chains followed into `app.ts`, `routes/api-scope.ts`, `redis/connections.ts`,
`events/redis-server-event-publisher.ts`, `services/trust-fingerprint.ts`,
`services/fail-in-flight-connection.ts`, `services/credential-store.ts`, `queue/connect-server-worker.ts`,
`db/client.ts`, `packages/domain/src/server/{connection-result,classify-edit,server-state}.ts`,
`packages/ssh/src/exec-with-timeout.ts`, BullMQ 6.3.6 and drizzle-orm sources).

**Method note.** Three claims below were verified empirically with throwaway scripts in the session
scratchpad (Node v24.13.0, the repo's own `pino`/`fastify` from `apps/control-plane/node_modules`);
nothing in the repository was executed or modified. Where a claim is reasoning-only it says so.

## Summary

No finding meets the "exploitable / data loss / crash in a realistic scenario" bar, so there are no
criticals. There are five real bugs. The two that matter most:

1. **WR-A-01** — any throw after `connectAndDiscover`'s TX1 commits (`decodeCredential`, `parseFingerprint`,
   `session.close()`, the whole of TX2) leaves the server wedged in `CONNECTING`. Nothing compensates; edit,
   delete, connect and trust all answer "busy" until the worker process is restarted.
2. **WR-A-02** — the UF-01 fix rests on an invariant the domain code does not hold ("`pendingFingerprint` is
   only ever non-null while `ERROR`"). A fingerprint captured against one identity still survives an identity
   change on three other paths, and a reachable state makes `trust-fingerprint` answer 500.

The known-open heartbeat item is **confirmed** (WR-A-03). The `err` serializer is **bypassable**, proven
(WR-A-04). Secrets: I found no path by which a credential, `DATABASE_URL`/`REDIS_URL`, cookie or key material
reaches an SSE frame, an activity row, an error body or the new discovery endpoint.

---

## Warnings

### WR-A-01: A throw anywhere after TX1 leaves the server permanently `CONNECTING`

**File:** `apps/control-plane/src/services/connect-and-discover.ts:286-345` (with `queue/connect-server-worker.ts:98-100`)

**Issue:** TX1 commits `status = CONNECTING` (line 113-118), then four things run with no compensation:
`decodeCredential` (302), `parseFingerprint` (304), `outcome.session.close()` inside `finally` (341) and TX2
(345). `decodeCredential` documents that it throws (`credential-store.ts:118-133`: `UnknownKeyVersionError`, or
`SecretTamperError` with no `previous` key). TX2 throws on any transient Postgres failure. When any of them
throws, the BullMQ job fails and the `failed` listener only logs. `stalled` never fires for a failed job, so
`failInFlightConnection` is never called. The row stays `CONNECTING` and every mutation is refused:
`editServer` -> `SERVER_BUSY`, `deleteServer` -> `SERVER_BUSY` (`delete-server.ts:52`), `trustFingerprint` ->
`SERVER_BUSY`, `/connect` -> `ALREADY_CONNECTING`. The only recovery is restarting the worker (startup sweep).
With a wrong/rotated `NOODARA_MASTER_KEY` the server re-wedges on the next attempt. This contradicts D-12's own
guarantee ("a server never stays in CONNECTING forever") and the file header's "without ever ... throwing out of
a remote-operation failure". Predates this phase, but this phase's UI renders exactly this state as a spinner
that never ends. Reasoning-only (not executed), every step is cited.

**Evidence:**
```ts
const credential = decodeCredential(credentialRow, deps.masterKeys);   // 302 — throws, after TX1 committed
...
worker.on('failed', (job, err) => {                                    // connect-server-worker.ts:98
  options.logger.error({ jobId: job?.id, err }, 'connect-server job failed');
});
```

**Fix:** Wrap everything after TX1 in `try/catch`; in the catch call
`failInFlightConnection(deps, { serverId, actor, reason })` (add a `'worker_job_failed'` reason; it already
no-ops unless the row is still `CONNECTING`) and rethrow. Belt and braces: do the same in the worker's `failed`
listener using the parsed payload's `serverId`. Add an integration test that makes TX2 fail and asserts the row
ends in `ERROR`/`CONNECTION_LOST`.

### WR-A-02: UF-01 is incomplete — its invariant is false, stale `pendingFingerprint` survives identity changes on other paths

**File:** `apps/control-plane/src/services/edit-server.ts:211-242` (root cause `packages/domain/src/server/connection-result.ts:77,86-92`; consequence `services/trust-fingerprint.ts:60-74`)

**Issue:** The UF-01 branch fires only for `row.status === 'ERROR'`, justified by the comment
"`pendingFingerprint` is only ever non-null while `ERROR`". `applyConnectionResult` disproves that: the success
branch spreads `...state` (pending kept -> `CONNECTED` + pending), and the failure branch keeps
`state.pendingFingerprint` for every code other than `HOST_KEY_CHANGED` (-> `UNREACHABLE` + pending).
`connect-and-discover.ts:372,423` persists exactly that value. Consequences:

- **(a) CONNECTED path.** `ERROR`/HKC with pending `FX` -> retry succeeds against the original key ->
  `CONNECTED` + pending `FX` -> identity edit: the `CONNECTED` branch nulls `hostFingerprint` but never touches
  `pendingFingerprint` (line 220-224) -> `PENDING`, `hostFingerprint = null`, pending `FX` captured against the
  *old* host -> connect to the new host fails `AUTH_FAILED` -> `ERROR` + stale `FX` ->
  `POST /trust-fingerprint` promotes `FX` as the new host's trusted key. Same class as UF-01.
- **(b) UNREACHABLE path.** `ERROR`+pending -> `CONNECT_TIMEOUT` -> `UNREACHABLE`+pending -> identity edit is
  not covered by either branch.
- **(c) Reachable 500.** With pending non-null in `CONNECTED`/`UNREACHABLE`, `trustFingerprint` passes its two
  guards and calls `transition(row.status, 'PENDING', { reason: 'fingerprint_trusted' })`, which throws
  `MissingTransitionReasonError` / `InvalidTransitionError` -> 500. Its doc comment calls that state "a bug";
  it is the normal result of one failed retry.
- **(d) Inconsistency.** Only the `CONNECTED` branch resets `hostFingerprint` on an identity change. In every
  other status the old host's trusted key is kept, so the first connect to a brand-new host is guaranteed to
  report a spurious `HOST_KEY_CHANGED`. It fails closed, but it teaches the admin that the warning is routine.

Mitigation that exists today: the web UI only offers "Trust" when `lastErrorCode === 'HOST_KEY_CHANGED'`, so
(a)/(b) need a direct API call. CLAUDE.md §2.3 requires the restriction in the backend, and the backend does not
check `lastErrorCode`.

**Evidence:**
```ts
// connection-result.ts
if (result.ok) { return { ...state, status: nextStatus, lastErrorCode: null, ... }; }   // pending kept
pendingFingerprint: result.errorCode === 'HOST_KEY_CHANGED' && ... ? result.observedFingerprint
                                                                  : state.pendingFingerprint,  // pending kept
// edit-server.ts
} else if (row.status === 'ERROR' && row.pendingFingerprint !== null) {   // 231 — status-keyed
```

**Fix:** Key the clear on the data, not the status. (1) In `editServer`, on any host/port change in any status,
set `pendingFingerprint: null, pendingFingerprintSeenAt: null` and `hostFingerprint: null,
hostFingerprintCapturedAt: null`. (2) In `applyConnectionResult`'s success branch set `pendingFingerprint: null`
and clear `pendingFingerprintSeenAt` in `connectAndDiscover`. (3) In `trustFingerprint`, refuse unless
`row.status === 'ERROR' && row.lastErrorCode === 'HOST_KEY_CHANGED'` with a result code (409), not a thrown
transition error. (4) Land together with the known-open TOCTOU fix (`{ fingerprint }` body + conditional UPDATE).

### WR-A-03: SSE writes are never checked — half-open peers hold a capped slot until TCP gives up (known item CONFIRMED), no backpressure bound, no `error` listener

**File:** `apps/control-plane/src/routes/events.ts:70-77,110,117`; `apps/control-plane/src/events/sse-broadcaster.ts:94-101`

**Issue:** Confirmed with code evidence. The heartbeat's `reply.raw.write(': keepalive\n\n')` (110) and the
broadcaster's `stream.write(frame)` discard the boolean return and pass no callback. There is no
`reply.raw.on('error')`, no `socket.setKeepAlive`, no `socket.setTimeout`, and `server.ts` sets no server
timeouts. The only eviction trigger is `request.raw.on('close')`.

1. **Half-open peer.** Writes succeed into the kernel buffer; `close` fires only when TCP retransmission gives
   up (Linux default `tcp_retries2=15`, roughly 15 minutes). The stream holds one of the 32 slots that whole
   time, and each `EventSource` reconnect (`retry: 5000`) takes a new one.
2. **Alive but not reading.** A zero-window peer never errors at all; every event is buffered in
   `reply.raw`'s writable buffer without limit, and the slot is never freed.
3. **The broadcaster's `try/catch` is effectively dead code.** `ServerResponse.write()` on a destroyed or ended
   response returns `false` and reports through the callback; it does not throw. If it ever did fire, it deletes
   the stream from the registry without ending the reply or clearing its heartbeat, so `size` under-counts real
   open connections.
4. **Unhandled `error`.** Verified experimentally: a `write()` after `end()` but before `close` emits
   `ERR_STREAM_WRITE_AFTER_END` on the `ServerResponse`; with no listener that is an `uncaughtException`, and
   the API has no process-level handler. Reachability is narrow and shutdown-only: `closeAll()` ends the stream
   while a heartbeat's `await getSession()` continuation settles in the same microtask drain (`closeAll` does
   not clear the route's interval).

Exit paths I checked and found correct: client close, session revoked (`cleanup()` before `end()`), lookup
timeout (treated as no session), cap reached (answered before hijack), the new destroyed-socket early return
(verified: `req.destroyed` is `false` for a live bodyless GET and `req` `close` does fire after `res.end()` on
Node 24), `heartbeat.unref()`, `cleanup()` idempotent.

**Fix:**
```ts
function evict(): void { cleanup(); reply.raw.destroy(); }
reply.raw.on('error', evict);
const MAX_BUFFERED_BYTES = 1_048_576;
const safeWrite = (chunk: string): void => {
  if (reply.raw.writableEnded || reply.raw.destroyed) return;
  if (reply.raw.writableLength > MAX_BUFFERED_BYTES) { evict(); return; }
  reply.raw.write(chunk, (err) => { if (err) evict(); });
};
request.raw.socket.setKeepAlive(true, heartbeatMs);
```
Use `safeWrite` for both the heartbeat and `SseStream.write`; evict a stream whose buffer has not drained across
two consecutive heartbeats. Remove the broadcaster's dead `catch`, or make it call a per-stream `evict`.

### WR-A-04: The central `err` serializer is bypassable — `logger.error(err)` writes the raw message into `msg`

**File:** `apps/control-plane/src/logger.ts:40-44` (live call site: `apps/control-plane/src/server.ts:29`)

**Issue:** The comment calls the serializer "the single control that makes every `{ err }` call site safe by
default". Verified experimentally with the repo's own pino: when an `Error` is the *first argument*, pino wraps
it as `{ err }` and sets `msg = err.message`. The serializer runs on `err`, and the raw message leaves anyway:

```
logger.error(new Error('boom postgres://u:CANARY_PW@db:5432/x'))
-> {"level":50,"err":{"name":"Error"},"msg":"boom postgres://u:CANARY_PW@db:5432/x"}
```

One call site already has this shape: `app.log.error(err)` in `server.ts:29`. Today that message is a
`listen EADDRINUSE ...` string, so nothing secret leaks now, but the control has a hole and nothing (lint,
test, canary) stops the next call site. Other bypass shapes I tested: an `Error` under a key other than `err`
serializes as `{}` (safe only because `Error` has no enumerable props; a `DrizzleQueryError` has enumerable
`query`/`params`); `cause` chains are dropped (safe); an explicit message string is safe. A grep of
`apps/control-plane/src` found no non-`err` key or string-interpolated `Error` in a log call.

**Fix:** Close it in `createLogger`, where the control lives:
```ts
hooks: {
  logMethod(args, method) {
    if (args[0] instanceof Error) {
      const [err, msg, ...rest] = args as [Error, unknown, ...unknown[]];
      method.apply(this, [{ err }, typeof msg === 'string' ? msg : 'error', ...rest]);
      return;
    }
    method.apply(this, args);
  },
},
```
Add a `logger.test.ts` case for the bare-`Error` shape, and change `server.ts:29` to
`app.log.error({ err }, 'listen failed')`.

### WR-A-05: `readLatestDiscovery`'s "never throws" projection lets through values the response schema rejects -> 500

**File:** `apps/control-plane/src/services/read-discovery.ts:54-63` vs `apps/control-plane/src/routes/server-schemas.ts:143-150`

**Issue:** `projectChecks` validates each check against the domain tuples. `projectWarnings` deliberately
validates only `typeof warning === 'string'` and then asserts the result as `ServerErrorCode[]`. The route's
response schema is `z.array(z.enum(SERVER_ERROR_CODES))`. Any stored string outside the current tuple (a code
renamed or removed in a later version, a hand-edited row) passes the projection, fails serialization, and
`GET /api/servers/:id/discovery` answers 500 for that server on every call until a newer snapshot is written.
The module's own header promises the opposite, and the type predicate is a lie to the compiler. Bounded, since
only this codebase writes the payload today.

**Evidence:**
```ts
return warnings.filter((warning): warning is ServerErrorCode => typeof warning === 'string');
```

**Fix:** Filter against the tuple, exactly as `projectChecks` does:
```ts
const SERVER_ERROR_CODE_SET: ReadonlySet<string> = new Set(SERVER_ERROR_CODES);
return warnings.filter((w): w is ServerErrorCode => typeof w === 'string' && SERVER_ERROR_CODE_SET.has(w));
```
Add a unit test with an unknown warning string asserting it is dropped.

---

## Info

### IN-A-01: `withSessionLookupTimeout` never clears its timer, and a timeout is indistinguishable in logs

**File:** `apps/control-plane/src/auth/session-lookup.ts:13-22`

**Issue:** Answers to the questions asked. No unhandled rejection: `Promise.race` attaches handlers to both
promises, so the losing rejection is handled, and a synchronous throw from `fn()` happens before the timer
exists. It fails closed: `require-session` answers 500 `INTERNAL_ERROR` and the hook halts; the heartbeat treats
a timeout as "no session" and ends the stream. Defects: the `setTimeout` is never cleared or `unref()`'d, so
every request and every heartbeat tick leaves a live 2 s timer that later allocates an `Error` for nothing and
can hold the process open 2 s at exit. The rejection is a plain `Error`, and the serializer keeps only `name`,
so a timeout logs as `{"err":{"name":"Error"},"msg":"session resolution failed"}`, identical to every other
failure. The race bounds the response, not the work: the abandoned lookup keeps its `pg` pool client, and
`createDb` sets no `connectionTimeoutMillis`/`statement_timeout`, so a hung Postgres still drains the pool.

**Fix:** `const timer = setTimeout(...); return Promise.race([...]).finally(() => clearTimeout(timer));` and
throw `class SessionLookupTimeoutError extends Error { name = 'SessionLookupTimeoutError' }`.

### IN-A-02: The "tuple drift guard" is a tautology; the real hand-typed enum has no guard

**File:** `apps/control-plane/src/routes/server-schemas.ts:128-135,146`

**Issue:** `DiscoveryCheckSchema.shape.id` *is* `z.enum(DISCOVERY_CHECK_IDS)`, so
`assertDiscoveryCheckSchemaLiteralsMatch()` compares the tuple with itself and cannot return `false`. Its
comment claims it catches drift; it gives false assurance (unlike `assertServerViewSchemaKeysMatch`, which
compares two independent lists). The literal that *is* hand-typed — `outcome: z.enum(['ok','partial','failed'])`
— is duplicated in the domain `SnapshotOutcome` type and the `discovery_outcome` pg enum with no guard.

**Fix:** Delete the vacuous guard and its test. Export a `SNAPSHOT_OUTCOMES` tuple from
`@noodara/domain/discovery` and build the domain type, the Zod enum and the pg enum from it.

### IN-A-03: Broadcaster allowlist checks only `type`, forwards the raw Redis string, and is not tied to `ServerEvent`

**File:** `apps/control-plane/src/events/sse-broadcaster.ts:41-45,87-94,143-145`

**Issue:** T-4-36's comment overstates the control. Any writer on a shared Redis can publish
`{"type":"server.updated","server":{...arbitrary...}}` and it reaches every admin browser unvalidated. The frame
embeds the raw `message`; JSON permits insignificant newlines, so a foreign message can split the `data:` line.
I could not construct a meaningful SSE field injection this way (continuation lines must start with a JSON
token); the effect is a truncated frame that fails to parse client-side. `KNOWN_EVENT_TYPES` is a hand-typed
`Set<string>`: a new `ServerEvent` member is silently dropped with no compile error. `closeAll()` has no
per-stream isolation around `stream.end()`, although `worker-shutdown.ts`'s header cites it as the model for
step isolation.

**Fix:** Build the frame from `JSON.stringify(parsed)`; declare the allowlist as
`const KNOWN: Record<ServerEvent['type'], true>`; wrap `stream.end()` in `try/catch`.

### IN-A-04: `onCheck` is safe; `detail` can carry up to 64 KB of remote stderr into SSE, the snapshot row and the read endpoint

**File:** `packages/ssh/src/run-discovery.ts:113-115,388-392,404-408,427-431,469-473`

**Issue:** Assessment of item 6. A throwing listener cannot break discovery (four `try/catch`, test at
`run-discovery.test.ts:536`). The callback is synchronous and the only production listener is
`void publishServerEvent(...)`, which never rejects, so it cannot stall SSH work. Publish order is preserved:
one ioredis connection, FIFO, and the final `server.updated` is queued after all progress events. `detail` is
redacted before `onCheck` sees it and stdout/stderr are redacted and truncated in `exec-with-timeout.ts`
(`MAX_OUTPUT_BYTES = 65_536`). I found nothing secret-shaped in any `detail` template. Defects:
`nonZeroExitDetail` interpolates the *whole* stderr, so one check's `detail` can be ~64 KB of remote-controlled
text, fanned out to every SSE stream, stored in `payload`, and returned by `GET /discovery`
(`DiscoveryCheckSchema.detail` has no `.max()`). The same five-line `try { onCheck } catch {}` block is pasted
four times.

**Fix:** Cap `detail` (for example 2 KB with an ellipsis) inside one `record(check)` helper that also owns the
single guarded `onCheck` call; mirror the cap as `.max()` in the schema.

### IN-A-05: `runWorkerShutdown` does not isolate `stopHeartbeat()`; the heartbeat key is never deleted; the BullMQ worker has no `error` listener

**File:** `apps/control-plane/src/queue/worker-shutdown.ts:48` (cross-file: `queue/worker-heartbeat.ts`, `queue/connect-server-worker.ts`)

**Issue:** The header says every step is individually isolated, but `deps.stopHeartbeat()` is the one bare
call. If it throws, `closeQueue`, every `disconnect` and `exit` are skipped, and because `worker.ts` calls
`void shutdown()` the result is an unhandled rejection. It cannot throw today (`clearInterval`), so this is a
contract gap. The header also names "the heartbeat key dangling" as the problem being solved, yet
`stopWorkerHeartbeat` only clears the interval, so `/health` reports a live worker for up to 30 s after a clean
stop. Cross-file: `createWorker` registers no `worker.on('error')`. BullMQ 6.3.6's `emit` override catches the
resulting throw and falls back to `console.error(err)` (`queue-base.js:87-99`), so worker/Redis errors print raw
to stderr with message and stack, outside pino and its serializer. No crash.

**Fix:** Wrap `stopHeartbeat()` in the same `try/catch` as the other steps; `DEL` the heartbeat key on stop;
add `worker.on('error', (err) => options.logger.warn({ err }, 'connect-server worker error'))`.

---

## Known open items — severity assessment (not counted above)

**(a) `POST /api/servers/:id/trust-fingerprint` takes no body (display/action TOCTOU).** Confirmed in code:
the route declares only `params` (`servers.ts:263-285`) and the service promotes whatever
`row.pendingFingerprint` holds when the lock is taken (`trust-fingerprint.ts:68-69`). An attacker cannot flip
the pending value alone: it changes only when a second admin-triggered connect runs, and `CONNECTING` blocks
trust meanwhile. The harmful sequence is: dialog shows `X1`, a second connect observes `X2`, the admin clicks on
a stale dialog. Impact is full host-identity compromise, and password credentials are then sent to the
interceptor. Likelihood is low and the client-side re-GET narrows the window. Assessment: **warning, high
priority — v0.1 release-gate blocker**, not an independently exploitable critical. Fix it together with WR-A-02.

**(b) UF-02 — `worker.ts` `main()` has no top-level catch.** This phase did not change it:
`git diff a7d7ab8..HEAD -- worker.ts` touches only the `shutdown()` body; line 113 is still `void main();`.
Boot rejections can come from `queueConnection.ping()`, `resolveServerServicesDeps` (`decodeMasterKey`) and
`sweepAbandonedConnections`. Node prints those through `util.inspect` with stack, own properties and `cause`.
From the library sources: `pg` and `ioredis` errors carry host/port/user but not the connection string or
password; a `DrizzleQueryError` prints `query` and `params` (for the sweep, a status literal and server ids).
I found no path that prints `DATABASE_URL`/`REDIS_URL` verbatim. Unverified for `decodeMasterKey`'s error text
(`boot/master-key.ts` not read). Assessment: **warning (low)** — a log-hygiene/DoD violation (raw stack outside
pino), not a demonstrated secret leak. Two related facts: `await getDb()` never touches the network (`pg.Pool`
is lazy), so the D-25 comment about Postgres fail-fast is false — the first real Postgres contact is the sweep.
Signal handlers are registered only at the end of `main()`. `server.ts` has the same `void main()` shape.
Fix: `main().catch((err) => { logger.fatal({ err }, 'worker boot failed'); process.exit(1); })`.

**(c) Heartbeat ignores its own write result.** Confirmed — see WR-A-03.

## Checked and found sound (brief, for the orchestrator's merge)

- SSE frames, activity rows and the discovery endpoint carry only `ServerView` (27-key allowlist),
  `DiscoveryCheck` (redacted `detail`) and error codes. `readLatestDiscovery` drops `facts`; the route builds
  its four-field response explicitly and the schema is `.strict()`.
- Fastify's `req` serializer still applies with `loggerInstance` (verified): cookie and authorization headers
  are not logged. The URL is logged with its query string; no route carries a secret there.
- `whenReady()` cannot hang boot (`app.ts` races `start()` against 2 s, late rejection handled). `closeAll()`
  before `ready` is guarded by `closed`, and `unsubscribe` is bounded to 2 s.
- The 32-slot check and `add` are synchronous with no await between them, and the destroyed-socket early
  return precedes both.
- Statuses are produced only through `transition()`/`applyConnectionResult` in the files reviewed. UF-01's
  patch writes no status literal.

## Out-of-scope observation

`apps/control-plane/src/server.ts` registers no `SIGTERM`/`SIGINT` handler (`grep process.on(` finds only
`worker.ts`). `app.close()` is therefore never called in production, and `preClose -> broadcaster.closeAll()`
runs only in tests.

---

_Reviewer: Claude (gsd-code-reviewer), area A — backend_
_Depth: deep_

---

# Area B — apps/web, standard

**Depth:** standard (plus targeted cross-seam checks into `apps/control-plane` and `packages/ui` where a web claim depended on them)
**Files reviewed:** all 52 in `scope-B.txt`
**Status:** issues_found

## Summary

No exploitable security flaw was found in apps/web: no raw server text reaches the DOM, no `dangerouslySetInnerHTML` beyond the constant theme script, all ids in API paths are `encodeURIComponent`'d, the SSE proxy forwards only `cookie` and reflects only `content-type`/`retry-after`/status, `proxy.ts` fails closed, there is no open redirect (the `redirect` param is never consumed), clickjacking is covered (`X-Frame-Options: DENY` + `frame-ancestors 'none'`), and credentials stay in component state and are cleared on close.

The defects are correctness bugs at cross-agent seams. The most valuable ones:

- **WR-B-07** — the control plane emits validation issue paths as `"/name"` (AJV `instancePath`), the web allowlist expects `"name"`. Every server-side field error is silently dropped; verified against `@fastify/type-provider-zod`'s `errors.js` and `http-errors.test.ts`.
- **WR-B-01 / WR-B-02** — the detail page's known-open stale-snapshot hazard is **confirmed**, and it has a second, unreported consequence: a `CONNECTING` status learned from a snapshot (not an event) never clears `liveChecks`, so a re-run renders the previous run's results as live and drops the new run's progress events.
- **WR-B-10** — `require-session.ts`'s header comment claims it handles a session going bad after mount. It does not: nothing calls it when the stream is rejected, so a revoked tab sits on "Reconnecting…" forever.
- **WR-B-13** — `first-trust.ts` claims a throwing storage can never crash the detail page; the throw actually happens at the `window.localStorage` getter in `page.tsx`, outside the `try`.

Items the brief listed as KNOWN OPEN (setup token in URL / Referrer-Policy, backend trust TOCTOU, RowMenu aria-expanded) are not re-reported.

Checked and found sound (not listed below): `use-server-events.ts` single-source / StrictMode / timer cleanup; `api/events/route.ts` abort wiring (request.signal, body cancel, headers timeout, fixed 503); `servers/page.tsx` buffer + latest-request + `reconcileSnapshot`; `activity-copy.ts` metadata allowlist; `error-copy.ts` exhaustiveness and unknown-code degradation; Trust/Delete dialogs not submittable via Enter (no `<form>`), fingerprints untruncated; `FileButton` 64 KiB cap honoured; edit mode never sends a credential unless Replace was activated.

---

## Warnings

### WR-B-01: Server detail — stale GET snapshot overwrites a newer SSE event (KNOWN OPEN: confirmed)

**File:** `apps/web/src/app/(shell)/servers/[id]/page.tsx:107-132, 145-165`
**Issue:** `fetchServer` publishes whatever its GET returns, unconditionally. There is no request sequencing (`latestRequestRef`), no event buffering, and no `updatedAt` guard — every protection `servers/page.tsx` got is absent here. `fetchServer` runs on mount, on every stream `open` (these two routinely overlap), after every toolbar action (`onActionSettled`) and after the trust dialog settles.

Note the CONNECTING transition happens in the **worker** (`connect-and-discover.ts` TX1), not in `POST /connect`, so the post-action GET is always racing the worker's writes.

Interleaving that leaves the page permanently wrong (fast failure, e.g. connection refused):
1. User clicks Retry. `POST /connect` → 202. `onActionSettled` → `GET /api/servers/:id` sent.
2. Worker TX1 commits `CONNECTING`. The GET's DB read happens here → snapshot says `CONNECTING`.
3. SSH fails in milliseconds; TX2 commits `UNREACHABLE`; `server.updated(UNREACHABLE)` reaches the browser → `setState(UNREACHABLE)`.
4. The GET response lands → `setState(CONNECTING)`, `previousStatusRef = 'CONNECTING'`.
5. No further event will ever come. The page shows "Connecting…" with the primary action disabled until a manual reload.

Same shape: (a) two overlapping GETs resolving out of order; (b) `server.deleted` sets `not-found`, then an in-flight GET that read before the delete resurrects a ghost server in `ready`.
**Evidence:**
```ts
void apiGet<ServerView>(`/api/servers/${encodeURIComponent(id)}`).then((result) => {
  ...
  previousStatusRef.current = result.data.status;
  setState({ kind: 'ready', server: result.data });   // no guard of any kind
});
```
**Fix:** Route both paths through one `applyServer(next, source)` function: keep a `latestRequestRef`; drop a snapshot whose `updatedAt` is older than the currently held server's (`Date.parse(prev.updatedAt) > Date.parse(next.updatedAt)`); remember a `deletedRef` so a snapshot can never resurrect a server a `server.deleted` event already removed.

### WR-B-02: Server detail — `liveChecks` is not cleared when `CONNECTING` is learned from a snapshot; previous run's results render as the live run and new progress is dropped

**File:** `apps/web/src/app/(shell)/servers/[id]/page.tsx:128-130, 148-162`
**Issue:** The "new run started → clear `liveChecks`" rule exists only in the SSE branch. The fetch branch writes `previousStatusRef.current = result.data.status` without it. `liveChecks` is never cleared when a run *ends* either, so after run 1 it still holds all 11 checks.

Interleaving:
1. Run 1 finished; `liveChecks` = 11 checks; status `CONNECTED`.
2. User clicks "Re-run discovery". Worker TX1 commits `CONNECTING`.
3. The `onActionSettled` GET (or a resync GET after a stream reconnect — there is no replay, so a `CONNECTING` event missed during a reconnect always takes this path) returns `CONNECTING` → `previousStatusRef = 'CONNECTING'`, nothing cleared.
4. `server.updated(CONNECTING)` arrives: `previousStatusRef.current !== 'CONNECTING'` is false → not cleared.
5. `buildChecklist` (status `CONNECTING`) renders run 1's 11 checks as this run's resolved progress, and every run-2 `discovery_progress` event is discarded by the dedupe `prev.some((check) => check.id === event.check.id)`.

This directly violates D-05 ("never render a previous run's results as if they belonged to the run currently happening").
**Fix:** Do the transition check in the shared `applyServer` from WR-B-01 (both sources), and additionally clear `liveChecks` on any transition *out of* `CONNECTING` so a finished run's checks cannot leak into the next one.

### WR-B-03: Discovery checklist invents progress when the page joins mid-run

**File:** `apps/web/src/lib/discovery-progress.ts:161-172, 118-136`
**Issue:** `firstUnresolvedIndex` is "first id not in `receivedChecks`", assuming the page saw the run from its first check. A page mounted mid-run (the D-01 "Save and connect" path navigates to the detail page *after* `POST /connect` returned; also any reconnect mid-run) misses earlier events. With `receivedChecks = [disk, uptime]`: `hostname` renders **Running** (it finished already), the OS step shows "Running", and Resources aggregates to **Pass** through `aggregateSettledStepState` although `cpu`/`memory` are unknown. Self-heals when the run settles, but it is exactly the invented progress D-05 forbids.
**Fix:** Compute `lastReceivedIndex = max(index of received ids)`; ids before it that were not received are "unknown" (render `pending`/an explicit "missed" state and exclude from aggregation → step stays `running`/`pending`, never `pass`); only `lastReceivedIndex + 1` may be `running`.

### WR-B-04: Activity — a failed *background* refresh replaces the loaded log with an error banner and discards loaded older pages

**File:** `apps/web/src/app/(shell)/activity/page.tsx:120-132`
**Issue:** `fetchPage1`'s failure branch does an unconditional `setState({ kind: 'error', ... })`, even when the state was `ready`. Background refreshes fire on `visibilitychange`, on every `server.updated/deleted` and on stream reconnect. Laptop wake → tab visible → fetch fails with `NETWORK_ERROR` → the whole list (including every "Load older" page and scroll position) is replaced by the banner; Retry then reloads only page 1. Contradicts the file's own header ("merging, never resetting scroll or already-loaded older pages").
**Fix:**
```ts
setState((prev) => (prev.kind === 'ready' ? prev : { kind: 'error', error: {...}, onRetry: fetchPage1 }));
```

### WR-B-05: Activity — page-1 refresh silently leaves a gap when more than 50 events arrived since the last refresh

**File:** `apps/web/src/app/(shell)/activity/page.tsx:134-146`, `apps/web/src/lib/activity-groups.ts:112-119`
**Issue:** A refresh fetches the newest 50 and prepends the unseen ones; `nextCursor` stays at the old bottom boundary. If >50 events were written since the previous refresh, the rows between the 50th-newest and the previously loaded top are never fetched and nothing indicates it. Realistic trigger: tab left in the background while a burst of `auth.login_failed` events is written (they emit no SSE event, so refresh only happens on focus) — the exact moment an admin opens the audit log, part of the burst is invisible.
**Fix:** On refresh, if none of the returned ids is already known and `result.data.nextCursor !== null`, there is a gap: replace the list with the fresh page and adopt its `nextCursor` (or page forward until an overlap is found).

### WR-B-06: Activity day headers are computed in UTC, not the viewer's time zone

**File:** `apps/web/src/components/ActivityList.tsx:68` (default in `apps/web/src/lib/activity-groups.ts:17,69`)
**Issue:** `groupByDay(state.items, now)` omits `timeZone`, which defaults to `'UTC'`. For a UTC-6 user at 19:00 local, an event from 17:00 the same local day is filed under **YESTERDAY** while its own `RelativeTime` says "2 hours ago". Secondary: `key={group.label}` ("SEP 17", no year) collides across years.
**Fix:** Pass `Intl.DateTimeFormat().resolvedOptions().timeZone` (client-only screen, state starts `loading`, so no hydration risk) and key groups by the day key, not the label.

### WR-B-07: Server-side validation field errors never render — issue path format mismatch (`"/name"` vs `"name"`)

**File:** `apps/web/src/lib/error-copy.ts:69-95`; consumers `apps/web/src/components/ServerSheet.tsx:118-124`, `apps/web/src/app/setup/page.tsx:63-71`
**Issue:** The control plane normalises issues from AJV-shaped `instancePath` (`apps/control-plane/src/routes/http-errors.ts:72-76`), which `@fastify/type-provider-zod` builds as `` `/${issue.path.join("/")}` `` — the wire value is `"/name"`, `"/credential/privateKey"` (asserted by `http-errors.test.ts:102`). `KNOWN_FORM_FIELD_PATHS` holds bare names, and `error-copy.test.ts` only ever feeds bare names, so the unit tests pass while no real response can match. Result:
- ServerSheet: every schema failure falls to the toast "Check the highlighted fields and try again." with **no field highlighted**. Service-level `VALIDATION_FAILED` (no `issues[]`, e.g. invalid host from `register-server.ts`) ends the same way, its specific message discarded.
- Setup: a schema failure renders "This setup link is no longer valid…", which is false.
- Latent second bug behind it: even with matching paths, `sshUser`/`privateKey`/`passphrase`/`password` would be put in `fieldErrors` and `return` early, but ServerSheet only renders `name|host|sshPort|credential` — the user would see nothing at all.
**Fix:** Normalise in one place: strip the leading `/`, take the last segment (`/credential/privateKey` → `privateKey`), map `privateKey|passphrase|password` → `credential` for the sheet, add an `error` prop to the "SSH user" `Field`, and add a contract test that feeds a real `toValidationErrorBody` output through `fieldErrorsFromIssues`.

### WR-B-08: Edit sheet — clearing SSH port is silently ignored; clearing SSH user sends `""` and fails opaquely

**File:** `apps/web/src/lib/server-form.ts:122-131`
**Issue:** `portChanged = current.sshPort !== initial.sshPort && trimmedPort !== ''` — a user editing a server on port 2222 who blanks the field (placeholder shows "22") and saves gets a successful PATCH with no `sshPort`; the server stays on 2222 while the UI implied 22. `sshUser` is sent untrimmed as `''` when cleared (create trims and omits it), which `UpdateServerBodySchema`'s `.min(1)` rejects → `VALIDATION_FAILED` at `/sshUser` → dropped by WR-B-07 → generic toast, nothing highlighted.
**Fix:** In edit mode treat blank as the documented default explicitly (`sshPort: 22`, `sshUser: 'root'`) or reject blank client-side with a field error; trim `sshUser` like `buildCreateBody` does.

### WR-B-09: Sign-out ignores a failed sign-out request and still shows the login screen

**File:** `apps/web/src/components/SignOutButton.tsx:20-25`
**Issue:** The `apiSend` result is discarded. On `NETWORK_ERROR`, a 5xx, or `FORBIDDEN_ORIGIN`, the session cookie remains valid server-side, but the user is navigated to `/login` and believes they are signed out; on a shared machine, opening `/servers` re-enters the admin panel. Also, `close()` has already permanently disabled the stream (`closedByCallerRef`), so staying on the page after a failure would need a reconnect path.
**Fix:** `if (!result.ok && !result.unauthorized) { setSigningOut(false); show an error; reopen the stream; return; }` — navigate only on success or 401.

### WR-B-10: A tab whose session ended never redirects; the stream retries forever (KNOWN item: assessed)

**File:** `apps/web/src/lib/use-server-events.ts:97-107`, `apps/web/src/lib/require-session.ts:7-13`, `apps/web/src/app/(shell)/layout.tsx:27-29`
**Issue:** `require-session.ts` claims to be "the client-side counterpart for a session that goes bad *after* the shell has already mounted — the SSE heartbeat closing the stream server-side, a sign-out from another tab…". Verified false: `requireSession()` runs once on shell mount and otherwise only when a screen's own fetch returns 401. When the heartbeat closes the stream, the native retry gets 401 → `CLOSED` → `scheduleReconnect` with `rejections` growing → one 401 per 60 s indefinitely. `open` never fires, so no resync GET (the only thing that would surface the 401) ever runs. The tab shows stale data plus "Reconnecting…" forever. Load is bounded (1 req/min/tab), so the defect is the missing redirect, not the traffic.
**Fix:** On a `CLOSED` rejection, invoke an injected `onRejected` callback (layout passes `() => void requireSession()`); a 401 there redirects, anything else keeps backing off. Stop retrying once the redirect was triggered.

### WR-B-11: api-client has no timeout on any request, and the success-path `response.json()` is unguarded

**File:** `apps/web/src/lib/api-client.ts:205-228`
**Issue:** (1) CLAUDE.md §2.3 requires explicit timeouts on every remote HTTP operation; `performRequest` passes no `signal`. A hung request pins `submitting` in ServerSheet (Cancel is disabled while submitting), the Trust dialog, sign-out and every loading skeleton; the only bound is Next's rewrite proxy default. `require-session.ts` works around this locally with a `Promise.race` that leaves the fetch running and never clears its timer. (2) `const data = (await response.json()) as T` is outside any `try`: a 2xx with an empty/non-JSON body (captive portal, intermediary) rejects the promise; every caller uses `void apiGet(...).then(...)` with no `catch` → unhandled rejection and a screen stuck in `loading`.
**Fix:**
```ts
const signal = AbortSignal.timeout(REQUEST_TIMEOUT_MS);            // e.g. 15_000
response = await fetch(path, { ...init, credentials: 'same-origin', signal });
...
try { return { ok: true, data: (await response.json()) as T }; }
catch { return { ok: false, code: 'INTERNAL_ERROR', message: GENERIC_FAILURE_MESSAGE, unauthorized: false }; }
```
Map the abort to a dedicated client code (or `NETWORK_ERROR`), then delete `withTimeout` from `require-session.ts`.

### WR-B-12: Trust dialog compares the re-GET against the *live* prop, not the fingerprint shown when the dialog opened

**File:** `apps/web/src/components/TrustFingerprintDialog.tsx:85-113, 169-171`; caller `apps/web/src/app/(shell)/servers/[id]/page.tsx:280-286`
**Issue:** `server` is `state.server`, which SSE events replace while the dialog is open. If `pendingFingerprint` changes from X to Y mid-review (second failed connect from another tab/retry), the "Observed:" line silently becomes Y, and the pre-POST check `latest.data.pendingFingerprint !== server.pendingFingerprint` compares Y to Y and passes. The admin verified X out-of-band, typed the name, and trusts Y. The file comment's guarantee ("identical to the one this dialog displayed") holds only in the trivial sense. Fail-closed behaviour on re-GET failure and on mismatch is otherwise correct (no POST is sent). On the mismatch path the typed name stays filled in, so a second click immediately trusts the new value. This is a UI-side weakness independent of the known backend TOCTOU.
**Fix:** Snapshot on open (`const [shownPending, setShownPending] = useState(...)` set in the `open` effect); render and compare against the snapshot; if `server.pendingFingerprint !== shownPending` while open, show `STALE_PENDING_MESSAGE`, disable confirm, and require closing/reopening (which resets the typed name). When the backend accepts an expected fingerprint, send the snapshot.

### WR-B-13: `window.localStorage` is dereferenced during render outside any `try` — detail page crashes when storage is blocked

**File:** `apps/web/src/app/(shell)/servers/[id]/page.tsx:217, 222`
**Issue:** `first-trust.ts` promises "a storage backend that throws … degrades to showing the notice — never to a crash on the detail page". But with site data blocked (Chrome "block all cookies", hardened profiles) the **getter** `window.localStorage` itself throws `SecurityError`, and that expression is evaluated in the page's render, before `shouldShowFirstTrustNotice`'s `try`. There is no `error.tsx` anywhere under `app/`, so every server detail page is a hard crash for those users. The unit tests inject a storage object and cannot see this.
**Fix:** Add `safeLocalStorage(): StorageLike | null` in `first-trust.ts` that wraps the getter in `try/catch`; let both functions accept `null` (show notice / no-op). Consider an `app/(shell)/error.tsx` boundary.

### WR-B-14: Setup reports every non-validation failure as "This setup link is no longer valid"

**File:** `apps/web/src/app/setup/page.tsx:63-71`
**Issue:** Collapsing the token-related codes into one banner is intended. But `NETWORK_ERROR`, `INTERNAL_ERROR`/5xx, `FORBIDDEN_ORIGIN` and rate limiting fall into the same branch, telling a first-run user to go and obtain a new token because of a transient outage. None of those outcomes reveal anything about token or account state, so distinguishing them costs nothing.
**Fix:** `if (result.code === 'NETWORK_ERROR') banner = result.message; else if (result.code === 'INTERNAL_ERROR' && status >= 500 …)` — i.e. render `copyForErrorCode` for `NETWORK_ERROR`/`INTERNAL_ERROR`/`FORBIDDEN_ORIGIN`/`retryAfterSeconds`, and keep the opaque banner for everything else (unknown codes already decode to `INTERNAL_ERROR`, so expose `status` on `ApiFailure` or treat only 5xx as internal).

### WR-B-15: No route for `/` — an authenticated visit to the bare origin is a 404

**File:** `apps/web/src/app/` (no `page.tsx`), `apps/web/src/proxy.ts:59-61`
**Issue:** The matcher covers `/`, so an unauthenticated visit is redirected to `/login`; an authenticated one passes the proxy and hits Next's default 404, because no root page or redirect exists. The bare public URL is what an installer prints and what users bookmark.
**Fix:** Add `app/page.tsx` with `redirect('/servers')` (or a `redirects()` entry in `next.config.ts`).

---

## Info

### IN-B-01: Security headers — what is present and what is absent

**File:** `apps/web/next.config.ts:41-51`
**Issue:** Present: `X-Frame-Options: DENY`, `Content-Security-Policy: frame-ancestors 'none'` on `/:path*` — clickjacking of the destructive dialogs is covered. Absent: `X-Content-Type-Options: nosniff`; `Referrer-Policy` (already tracked in the setup-token todo); any `script-src`/`default-src`/`base-uri`/`form-action`/`object-src` CSP as an XSS backstop for an admin UI that renders remote-host-derived strings; `Permissions-Policy`; `poweredByHeader: false`.
**Fix:** Add `nosniff`, `Referrer-Policy: no-referrer`, `poweredByHeader: false` now; plan a nonce-based CSP (the inline theme script needs a nonce or hash).

### IN-B-02: `proxy.ts` matcher excludes by prefix, not by path segment

**File:** `apps/web/src/proxy.ts:60`
**Issue:** `(?!api|…|login|setup)` also exempts `/apikeys`, `/api-keys`, `/setup-anything`, `/loginx`. Nothing exists there today and the backend is the real boundary, but a v0.5 "API keys" screen would silently skip the redirect.
**Fix:** `'/((?!api/|_next/static|_next/image|favicon\\.ico$|login(?:/|$)|setup(?:/|$)).*)'`.

### IN-B-03: `?redirect=` is written but never read; `requireSession` treats a slow response as a 401

**File:** `apps/web/src/lib/require-session.ts:18-31`, `apps/web/src/app/login/page.tsx:59-63`
**Issue:** Login always pushes `/servers`, so the doc comment "carrying the current path so login can send the user back" is false (and there is, correctly, no open-redirect surface — keep it that way if this is ever implemented: accept only same-origin paths starting with a single `/`). Separately, a >5 s `/api/config` is reported as `unauthorized: true` and hard-navigates a validly signed-in user to `/login`; since this guard is explicitly not a security boundary, failing "closed" buys nothing. The timer is never cleared.
**Fix:** Drop the param or implement it with strict validation; treat a timeout as a non-401 failure.

### IN-B-04: `server.updated` payload is not shape-validated; listener dispatch is not isolated

**File:** `apps/web/src/lib/server-events.ts:94-97`, `apps/web/src/lib/use-server-events.ts:124-126`
**Issue:** The file advertises a "second allowlist", but `parsed.server as unknown as ServerView` accepts any object; a partial payload reaches `setState` and throws at render (e.g. `copyForServerErrorCode` on an unknown `lastErrorCode` calls `.replaceAll` on `undefined`). Resync callbacks are wrapped in `try/catch`; event listeners are not, so one throwing listener starves the rest.
**Fix:** Validate at least `id`, `name`, `host`, `status ∈ union`, `updatedAt`, `lastErrorCode ∈ union|null`; wrap each `listener(...)` call in `try/catch`.

### IN-B-05: `String.prototype.replace` with a user-controlled replacement string

**File:** `apps/web/src/components/ServerSheet.tsx:131-134`, `DeleteServerDialog.tsx:47`, `TrustFingerprintDialog.tsx:126`
**Issue:** `message.replace('{name}', formState.name)` interprets `$&`, `` $` ``, `$'`, `$$` in the name/host. Text-only, so cosmetic, but the message is garbled for such names.
**Fix:** `message.replace('{name}', () => formState.name)`.

### IN-B-06: In-flight guards missing on Delete; sheet can be dismissed mid-submit

**File:** `apps/web/src/components/DeleteServerDialog.tsx:38-56`, `apps/web/src/components/ServerSheet.tsx:144-181`
**Issue:** Delete has no `submitting` state (Trust has one): a double click sends two DELETEs and there is no progress feedback; it also never calls `requireSession()` on 401 unlike every sibling. In ServerSheet, Cancel is disabled while submitting but Esc/outside-click still close it; the pending request then closes a *re-opened* sheet, writes its errors into the new form, or navigates to `/servers/:id` seconds after the user dismissed it.
**Fix:** Add the guard to Delete; in ServerSheet ignore `onOpenChange(false)` while `submitting`, or tag each submit with a token and ignore stale completions.

### IN-B-07: Servers list drops to the skeleton on every resync and after every save/delete

**File:** `apps/web/src/app/(shell)/servers/page.tsx:70`
**Issue:** `fetchServers` always sets `{ kind: 'loading' }`, so each stream reconnect and each `onSaved`/`onDeleted` unmounts all rows (closing an open row menu, losing focus) — contrary to SS6's "no rebuild-from-scratch". The detail page already uses a `hasLoadedRef` first-load-only skeleton.
**Fix:** `setState((prev) => (prev.kind === 'ready' ? prev : { kind: 'loading' }))`.

### IN-B-08: `autoComplete="off"` on SSH password/passphrase inputs

**File:** `apps/web/src/components/CredentialFields.tsx:139-146, 158-166`
**Issue:** Browsers ignore `off` on `type="password"`; password managers may offer to save the SSH password against the Noodara origin — a copy of the secret that outlives the sheet.
**Fix:** `autoComplete="new-password"` plus `data-1p-ignore` / `data-lpignore="true"` / `data-bwignore`.

### IN-B-09: Activity — server lookup fetched once; server links are plain anchors

**File:** `apps/web/src/app/(shell)/activity/page.tsx:55-69`, `apps/web/src/components/ActivityRow.tsx:35`
**Issue:** `servers` is never refreshed although the page already subscribes to `server.updated/deleted`, so the header's claim "a row's server name only links when that server still exists" goes stale. `<a href>` instead of `next/link` forces a full document load, tearing down and reopening the shared stream.
**Fix:** Fold events into `servers` with `applyServerEvent`; pass a `Link`-rendering segment (the href is built from a server-issued id only — keep it that way and `encodeURIComponent` it).

---

_Reviewed: 2026-09-20_
_Reviewer: Claude (gsd-code-reviewer), area B — apps/web_
_Depth: standard_

---

# Area C — packages/ui + scripts + CI, standard

**Reviewed:** 2026-09-20T07:26:07Z
**Depth:** standard
**Files Reviewed:** 50
**Status:** issues_found

## Summary

No finding met the bar for critical (exploitable flaw, data loss, realistic crash). Seventeen warnings are
real, most of them verified by execution or by reading the installed dependency source rather than by
inference:

- Three component bugs were **reproduced** with throwaway scripts against `packages/ui/dist` (nothing in
  the repo was touched): the `ThemeToggle` hydration mismatch, `Input`/`Textarea` silently dropping
  `Field`'s `aria-invalid`, and the inert focus-ring utilities (confirmed in the compiled CSS under
  `apps/web/.next`).
- Two "non-bypassable gates" are bypassable by construction: `check-package-provenance.mjs` covers
  27 of 52 external dependencies (it never reads a `package.json`) and trusts a self-asserted registry
  field; `check-ui-safety.mjs` is evaded by one class name already present in the repo.
- The never-executed workflows have one certain first-run failure: `pnpm security:scan-leaks` now runs
  Playwright, but neither job that calls it installs a browser.

**Correction to a "known" item:** `RowMenu`'s trigger is NOT missing `aria-expanded`. Radix
`DialogTrigger` 1.1.23 sets `aria-expanded={context.open}` and `aria-controls` (when open) before spreading
caller props (`@radix-ui/react-dialog/dist/index.js:76-78`); only `aria-haspopup` is overridden to `"menu"`.
Likewise overriding `role` does not break Radix's wiring in this version: `aria-labelledby`/`aria-describedby`
are only emitted when a Title/Description is present, and 1.1.23 ships no Title/Description dev warning
(`WarningProvider` is a pass-through). The real RowMenu defects are in WR-C-05.

**Checked and found sound (not listed below):** `confirm-match.ts` exact-equality policy (server names are
constrained to the ASCII slug `[a-z0-9-]` by `validateServerName`, so Unicode normalisation/homoglyph/zero-width
concerns are moot, and the API compares identically); Enter cannot bypass the destructive confirm (no `<form>`);
`FileButton` enforces the 64 KB cap before `readAsText`, resets the input on every path and never logs;
`CopyButton` timer cleanup; `tone.ts` `satisfies Record<ServerStatus, Tone>` exhaustiveness; `format.ts`
NaN/Infinity/negative guards and pinned `en` locale; `retries: 0`; `.gitignore` covers `playwright-report/`,
`test-results/`, `blob-report/`; `turbo.json` declares `NOODARA_API_ORIGIN` in `build.env`;
`security:scan-leaks` runs all four canaries; `stack.ts` children get a minimal env (PATH/HOME only, no
developer environment), secrets are per-run random, the committed E2E admin password is obviously fixture-only
and only ever seeded into a throwaway container; `pnpm --filter @noodara/ui typecheck` and `lint` are clean;
no `pull_request_target`; index barrel does not export `src/testing`.

## Warnings

### WR-C-01: ThemeToggle causes a hydration mismatch for every user with a persisted theme

**File:** `packages/ui/src/ThemeToggle.tsx:71`
**Issue:** `useState(() => readStoredTheme() ?? 'system')` reads `localStorage` in the state initializer.
On the server `localStorage` is a ReferenceError, swallowed by the try/catch, so SSR always renders
`mode = 'system'` (Monitor icon, `aria-label="Theme: System"`). On the client the same initializer returns
`'dark'`/`'light'`, so the first client render differs. `ThemeToggle` is rendered unconditionally inside
`Sidebar` inside the `'use client'` `(shell)/layout.tsx`, which Next still server-renders;
`suppressHydrationWarning` exists only on `<html>` and does not cover this subtree. Result: on every full page
load for any user who ever clicked the toggle to light or dark, React throws away the server HTML for the whole
shell and regenerates it on the client.
**Evidence:** Reproduced with `renderToString` (no `localStorage`) followed by `hydrateRoot` in jsdom with
`noodara-theme=dark`:
```
SERVER HTML: <button aria-label="Theme: System" ...
RECOVERABLE: Hydration failed because the server rendered HTML didn't match the client.
             As a result this tree will be regenerated on the client.
```
`ThemeToggle.test.tsx` never server-renders, so the suite cannot see this.
**Fix:** Initialise to a server-stable value and read storage after mount:
```tsx
const [mode, setMode] = useState<Mode>('system');
const [ready, setReady] = useState(false);
useEffect(() => { setMode(readStoredTheme() ?? 'system'); setReady(true); }, []);
useEffect(() => { if (!ready) return; /* set data-theme */ }, [mode, ready]);
```
(the `ready` gate stops the first effect from overwriting the bootstrap script's `data-theme` with the
system value for one frame). Add a test that hydrates server markup with a stored theme and asserts no
recoverable error.

### WR-C-02: CopyButton throws a synchronous TypeError when `navigator.clipboard` is undefined; the doc comment claims the opposite

**File:** `packages/ui/src/CopyButton.tsx:37-52` (claim at lines 20-23)
**Issue:** `navigator.clipboard` is `undefined` in any non-secure context. Noodara is self-hosted and
explicitly supports plain-HTTP deployments before v0.4 HTTPS (`NOODARA_COOKIE_INSECURE` exists for exactly
that), so `http://203.0.113.4:3000` is a realistic origin. There `navigator.clipboard.writeText(...)` throws
`TypeError: Cannot read properties of undefined` *synchronously*, before any promise exists, so the `.catch`
never runs: every Copy button (fingerprint, public URL, `ssh-keygen` command) is an uncaught exception and
gives the user no feedback at all. The component comment asserts "the API missing entirely is swallowed without
throwing" — false. `CopyButton.test.tsx` only tests a *rejecting* `writeText`; the API-absent case is never
exercised (the `afterEach` deletes the stub but no test clicks in that state).
**Evidence:**
```tsx
const handleClick = () => {
  navigator.clipboard          // undefined on http://<ip>
    .writeText(value)          // TypeError thrown here, outside the promise chain
    .then(...).catch(() => {});
```
**Fix:**
```tsx
const handleClick = async () => {
  try {
    if (!navigator.clipboard) throw new Error('unavailable');
    await navigator.clipboard.writeText(value);
    /* setCopied(true) ... */
  } catch {
    setFailed(true); // tooltip: "Copy unavailable — select the text instead"
  }
};
```
A silent no-op is not an "honest failure path"; surface it through the existing Tooltip. Add the API-absent test.

### WR-C-03: Input and Textarea silently discard the `aria-invalid` that Field hands them

**File:** `packages/ui/src/Input.tsx:31-33`, `packages/ui/src/Textarea.tsx:28-30`; affected caller `packages/ui/src/Dialog.tsx:135-146`
**Issue:** `Field` passes `'aria-invalid': true` inside `controlProps`. `Input` spreads `{...rest}` first and
then sets `aria-invalid={invalid ? true : undefined}`; when the caller did not also pass the separate
`invalid` prop, the explicit `undefined` overwrites Field's `true`. The Field+Input contract therefore only
works if every caller remembers to duplicate the error state in two props. `DestructiveConfirmDialog` does not:
when the API answers `CONFIRMATION_MISMATCH` the input has neither `aria-invalid` nor the error border.
`Field.test.tsx` uses a bare `<input>`, so the combination is never tested.
**Evidence:** Rendered `Field(error) > Input {...controlProps}` from `dist`:
```
<input id="_R_0_" aria-describedby="_R_0H2_" readOnly="" data-mono="false" class="... border-hairline ...">
```
No `aria-invalid`, no `border-status-error`. Same output for `Textarea`.
**Fix:** Derive one flag from both sources:
```tsx
export function Input({ mono = false, invalid, 'aria-invalid': ariaInvalid, ...rest }: InputProps) {
  const isInvalid = invalid ?? (ariaInvalid === true || ariaInvalid === 'true');
  return <input {...rest} aria-invalid={isInvalid ? true : undefined} className={cn(BASE, isInvalid && INVALID_CLASSES, ...)} />;
}
```
Apply to `Textarea`, and add a Field+Input test.

### WR-C-04: Focus is never returned after Sheet, ConfirmDialog or DestructiveConfirmDialog closes

**File:** `packages/ui/src/Sheet.tsx:50-53`, `packages/ui/src/Dialog.tsx:32-35`
**Issue:** Both components are controlled-only (`open`/`onOpenChange`) and never render a
`DialogPrimitive.Trigger`. Radix's modal content always intercepts the unmount auto-focus:
`onCloseAutoFocus: (event) => { event.preventDefault(); context.triggerRef.current?.focus(); }`
(`@radix-ui/react-dialog/dist/index.js:154-157`). With no Trigger, `triggerRef.current` is `null`, and because
the event was `preventDefault()`ed, `FocusScope` skips its own `focus(previouslyFocusedElement)`
(`react-focus-scope/dist/index.js:133-134`). Focus lands on `<body>`. After closing Add/Edit server, Delete or
Trust-fingerprint, a keyboard user restarts from the skip link. Sheet.tsx's comment ("Radix owns focus...
entirely on its own") is wrong for trigger-less usage; neither component exposes `onCloseAutoFocus`, so callers
cannot fix it either. No E2E spec asserts focus after close (`grep toBeFocused tests/e2e` → only the
open-focus assertion at `server-sheet.spec.ts:65`). Violates skill §7 (full keyboard navigation).
**Fix:** Capture the opener inside the component and restore it:
```tsx
const openerRef = useRef<HTMLElement | null>(null);
useEffect(() => { if (open) openerRef.current = document.activeElement as HTMLElement | null; }, [open]);
<DialogPrimitive.Content onCloseAutoFocus={(e) => { e.preventDefault(); openerRef.current?.focus(); }} ...>
```
(`useLayoutEffect`, or capture in the render where `open` flips, so it runs before FocusScope moves focus.)
Add a Playwright assertion that the opener is focused after Esc. Combine with WR-C-05: RowMenu must return
focus to its trigger *before* `onSelect` opens the modal, otherwise the captured opener is an unmounted menuitem.

### WR-C-05: RowMenu — activation never closes the menu, the trigger is invisible on touch devices, duplicate-label keys

**File:** `packages/ui/src/RowMenu.tsx:104-114` (activation), `:22` (opacity), `:105` (key)
**Issue:** Audited against the WAI-ARIA Menu Button pattern. Present and correct: `aria-expanded` and
`aria-controls` (from the primitive — see Summary), `aria-haspopup="menu"`, focus to first item on open,
ArrowUp/Down wrap, Home/End, Escape returns focus to the trigger, outside pointer-down dismisses, Tab dismisses
via `onFocusOutside`, native Enter/Space activation. Defects:
1. **Selecting an item does not close the menu or return focus.** `onClick` only calls `item.onSelect()`;
   nothing calls `onOpenChange(false)` and items are not wrapped in `DialogPrimitive.Close`. Today it *appears*
   to work only because both existing items open a modal whose FocusScope steals focus, which the non-modal
   layer interprets as "focus outside" and dismisses — with `hasInteractedOutside = true`, so focus is *not*
   returned to the trigger (feeds WR-C-04). Any future item that does not open a modal (e.g. "Reconnect")
   leaves the menu open over the list. `RowMenu.test.tsx` asserts the handler fired, never that the menu closed.
2. **Trigger is `opacity-0` unless the row is hovered or contains focus** (`:22`). On `hover: none` devices —
   the spec supports <900px with a bottom-sheet nav — the "⋯" button is permanently invisible; row actions are
   discoverable only by tapping blind.
3. `key={item.label}` — two items with the same label produce duplicate React keys. No disabled-item support
   (`RowMenuItem` has no `disabled`), acceptable today but the pattern requires `aria-disabled` when added.
4. Shift+Tab from the first item lands on the trigger, which Radix treats as "inside" (`targetIsTrigger` →
   `preventDefault`), so the menu stays open with focus outside it. Minor.
**Fix:**
```tsx
<DialogPrimitive.Close asChild key={`${index}-${item.label}`}>
  <button type="button" role="menuitem" onClick={() => { item.onSelect(); }}>…</button>
</DialogPrimitive.Close>
```
`Close` runs `onOpenChange(false)`; because no outside interaction occurred, Radix's own
`onCloseAutoFocus` then focuses the trigger. If `onSelect` opens a modal, defer it one tick
(`queueMicrotask`/`requestAnimationFrame`) so the trigger is the recorded opener. For touch:
add `[@media(hover:none)]:opacity-100` to `TRIGGER_CLASSES`. Add tests: menu closed + trigger focused after
selection.

### WR-C-06: RelativeTime's absolute timestamp is unreachable by keyboard

**File:** `packages/ui/src/RelativeTime.tsx:33-38`
**Issue:** The Tooltip trigger is a bare `<time>` element with no `tabIndex`, so it can never receive focus;
Radix Tooltip opens on hover or focus only. The component comment promises the ISO instant is "one hover/focus
away" — for keyboard and screen-reader users it is zero interactions away from *unavailable*. The E2E suite
already discovered this and worked around it rather than fixing it
(`tests/e2e/servers-list.spec.ts:180-182`: "`<time>` carries no `tabIndex`, so a real browser never focuses
it"). This is the component the spec relies on to stop a stale snapshot being read as live (D-11/T-5-61), and
skill §6 requires "timestamps relativos con tooltip absoluto ISO". WCAG 2.1.1.
**Fix:** `<time tabIndex={0} dateTime={value} ...>` (the global `:focus-visible` rule gives it a ring), or, if
an extra tab stop per row is unwanted, add a visually-hidden absolute value:
`<VisuallyHidden.Root>{formatIso(value)}</VisuallyHidden.Root>` inside the `<time>`.

### WR-C-07: Primary action text fails WCAG AA in dark mode (the primary theme); filled destructive fails in both

**File:** `packages/ui/tokens.css:139-141` (`--accent` / `--on-accent` dark), `:34`, `:147`; consumers `packages/ui/src/Button.tsx:35,42`, `packages/ui/src/SegmentedControl.tsx:24`
**Issue:** New, distinct from the known status-pill item. Computed with the WCAG 2.x relative-luminance formula:

| Pair | Where | Light | Dark | AA (13px/500 → 4.5) |
|---|---|---|---|---|
| `--on-accent #fff` on `--accent` | Primary Button, selected segment, skip link | 4.70 (`#0071e3`) | **3.02** (`#2997ff`) | dark FAILS |
| same, `hover:opacity-90` over `--surface-1` | Primary Button hover | **4.02** | **3.53** | both FAIL |
| `--on-accent #fff` on `--status-error` | filled destructive confirm ("Delete server") | **3.55** (`#ff3b30`) | **3.41** (`#ff453a`) | both FAIL |

Every primary call-to-action in the default (dark) theme is 3.0:1. The automated UX review's dark-mode contrast
claim should be treated as unverified for these pairs.
**Fix:** Requires a token decision, not a component patch: e.g. dark `--on-accent: #0b0b0c` on `#2997ff`
(≈ 6.9:1), or a darker dark-mode fill (`#0a84ff` is still only 3.65 with white; `#0071e3` gives 4.70). For filled
destructive use a dedicated `--status-error-fill` (`#d70015` light / `#d70015`-class dark ≈ 5.6:1 with white).
Replace `hover:opacity-90` with a surface/colour change so hover does not lower text contrast.

### WR-C-08: `--ink-tertiary` and `--status-error` are used for real content text and fail AA

**File:** `packages/ui/src/Field.tsx:48,53`, `packages/ui/src/Banner.tsx:45`, `packages/ui/src/LabelValue.tsx:19,42`, `packages/ui/src/StatTile.tsx:23-24`, `packages/ui/src/Input.tsx:13`, `packages/ui/src/RowMenu.tsx:35`, `packages/ui/src/Button.tsx:39`
**Issue:** Computed ratios (not the known pill-on-soft case):

| Text token | Used for | Light | Dark |
|---|---|---|---|
| `--ink-tertiary` on `--surface-1` | Field help text (12px), LabelValue caption + **dimmed fact values**, StatTile "as of" caption | **2.21** | **3.32** |
| `--ink-tertiary` on `--surface-2` | Input/Textarea placeholder (the confirm dialog's placeholder is the name to type) | **2.12** | **3.02** |
| `--ink-tertiary` on `--status-error-soft` | Banner `errorCode` (mono 13px) | **1.83** | **2.84** |
| `--ink-tertiary` 28px/600 (large text, needs 3.0) | dimmed StatTile value | **2.21** | 3.32 |
| `--status-error` on `--surface-1` | Field error message (12px) | **3.55** | 4.94 |
| `--status-error` on `--surface-3` | RowMenu "Delete" item | **3.12** | **4.20** |

The skill reserves `--ink-tertiary` for "placeholders, deshabilitado"; here it carries information the operator
must read (help text, error codes, last-good discovery facts, "as of" captions). The Banner error code — the
string a user is asked to quote when reporting a failure — is 1.83:1 in light mode. Skill §7 requires AA in both
modes. For reference, `--ink-secondary` passes everywhere except light `--surface-3` (4.46). Focus-ring contrast
(`--accent` vs every surface) is ≥ 4.13 in both themes — fine. Input boundaries are hairline-only (1.19–1.28:1,
fill-vs-surface 1.04–1.10), below WCAG 1.4.11's 3:1 for component boundaries; that is inherited from the locked
skill tokens and is noted here rather than filed separately.
**Fix:** Use `text-ink-secondary` for help text, captions, error codes and dimmed values (dimming can be
expressed with `data-dimmed` + `--ink-secondary` vs `--ink`). Route `--status-error` text through the same
gap-closure decision as the pills (a darker light-mode text variant, e.g. `#d70015` = 5.0:1 on white).

### WR-C-09: The design system's own focus-ring classes are inert under Tailwind v4; every ring depends on one unlayered rule in apps/web

**File:** `packages/ui/src/Button.tsx:28-29`, `RowMenu.tsx:21-23`, `Disclosure.tsx:14-15`, `SegmentedControl.tsx:23`, `ListRow.tsx:23-24`
**Issue:** Components pair `outline-none` with `focus-visible:outline focus-visible:outline-2 …`. In Tailwind
v4 `outline-none` is no longer the v3 "transparent outline" helper; it compiles to
`--tw-outline-style:none; outline-style:none`, and `outline-2` compiles to
`outline-style: var(--tw-outline-style)`. The variable set by `outline-none` on the same element therefore
makes the focus-visible outline `none`. Confirmed in the compiled CSS
(`apps/web/.next/static/chunks/*.css`):
```
.outline-none{--tw-outline-style:none;outline-style:none}
.focus-visible\:outline-2:focus-visible{outline-style:var(--tw-outline-style);outline-width:2px}
```
Rings are visible in the app today only because `apps/web/src/app/globals.css` has an *unlayered*
`:focus-visible{outline:2px solid var(--accent);outline-offset:2px}`, which beats every layered utility. Side
effects of relying on that: (a) per-component intent is silently overridden — `ListRow`'s inset
`-outline-offset-2` never applies, and `Input`/`Textarea` (designed as border-only focus) also get the ring;
(b) moving that rule into `@layer base`, or consuming `@noodara/ui` anywhere without it, removes every focus
indicator with no test in `packages/ui` able to notice (Button's own comment concedes jsdom cannot check it);
(c) `check-ui-safety`'s `outline: none` gate explicitly exempts the `outline-none` class, which in v4 *is*
`outline-style: none`.
**Fix:** Drop `outline-none` and the dead `focus-visible:outline*` utilities from the components and make the
ring part of the design system: ship the `:focus-visible` rule from `packages/ui` (e.g. a `base.css` export
imported next to `tokens.css`), with component-level offsets expressed as unlayered rules or
`data-focus-inset`. If a utility is wanted, v4's replacement for the old behaviour is `outline-hidden`.

### WR-C-10: Sheet (480px) and dialogs (420px) have fixed widths and overflow small viewports the spec supports

**File:** `packages/ui/src/Sheet.tsx:22`, `packages/ui/src/Dialog.tsx:12`
**Issue:** `w-[480px]` on a `fixed right-0` panel and `w-[420px]` on a centred panel, with no `max-w`. The
UI spec defines a <900px single-column layout with a bottom-sheet nav, so phone widths are in scope. At 375px
the Sheet's left 105px — the title and the left edge of every label/input (padding is only 32px) — is off-screen
and unreachable (the panel is `fixed`, the page does not scroll horizontally to it). The dialog loses 22px per
side.
**Fix:** `w-full max-w-[480px]` and `w-[calc(100vw-32px)] max-w-[420px]`; drop `rounded-l-lg` below the
breakpoint if the sheet goes full-width.

### WR-C-11: `pnpm security:scan-leaks` now launches Playwright, but neither job that runs it installs a browser — certain first-run failure

**File:** `.github/workflows/ci.yml:156-193` (`security` job), `.github/workflows/nightly.yml:101-113` (`canary` job); script at `package.json:26`
**Issue:** Plan 05-21 appended `&& playwright test --grep @canary` to `security:scan-leaks`. The `e2e` and
`e2e-repeat` jobs run `pnpm exec playwright install --with-deps chromium`; `security` and `canary` do not.
`ubuntu-latest` ships Chrome, not Playwright's pinned Chromium build under `~/.cache/ms-playwright`, and the
config uses `devices['Desktop Chrome']` without `channel`. On the first real run the three Vitest canaries pass,
`globalSetup` builds the workspace and starts Postgres/Redis/API/worker/web, and then the run dies with
`browserType.launch: Executable doesn't exist`. Because `security` is a PR merge gate, every PR is blocked. It
fails closed, hence warning rather than critical. `security` also has no `timeout-minutes` (WR-C-12).
**Fix:** Add `- run: pnpm exec playwright install --with-deps chromium` before `pnpm security:scan-leaks` in both
jobs (and an explicit `pnpm build` step for the same "own red step" reason the other jobs state).

### WR-C-12: ci.yml has no `permissions` block and seven of eight jobs have no `timeout-minutes`

**File:** `.github/workflows/ci.yml:19-38` (no `permissions`), jobs `lint` :39, `typecheck` :59, `boundaries` :72, `unit` :87, `integration` :111, `security` :156, `boot-smoke` :244
**Issue:** `nightly.yml` sets `permissions: contents: read`; `ci.yml` sets nothing, so `GITHUB_TOKEN` gets the
repository default (read/write on many repos) in a workflow that runs five unpinned actions and a `curl | tar`
(WR-C-13). Only `e2e` has `timeout-minutes`; the rest inherit GitHub's 360-minute default. `integration`,
`security` and `boot-smoke` start Testcontainers and spawn detached process groups, and
`check-package-provenance.mjs` runs ~60 `npm view` subprocesses with no timeout (`execFileSync` without
`timeout`), so a hung registry call or container wait burns six runner-hours. 05-20-SUMMARY claims "explicit
`timeout-minutes` on every job" — true for nightly only.
**Fix:**
```yaml
permissions:
  contents: read
```
at the top of `ci.yml` (add `pull-requests: read` on the `security` job if gitleaks-action needs it), and
`timeout-minutes:` on every job (10 for lint/typecheck/boundaries/unit, 45 for integration — it measured 1855s
locally — 30 for security/boot-smoke). Add `timeout: 30_000` to both `execFileSync` calls.

### WR-C-13: No action is pinned to a commit SHA; gitleaks binary is downloaded and executed without a checksum; two secrets are referenced

**File:** `.github/workflows/ci.yml:43-45,105,209-212,219-220,306`; `.github/workflows/nightly.yml:45-47,74-76,106-108`
**Issue:** Every `uses:` is a mutable tag. Unpinned, each occurrence:
- `actions/checkout@v5` — ci.yml ×8, nightly.yml ×3
- `pnpm/action-setup@v4` (third-party) — ci.yml ×8, nightly.yml ×3
- `actions/setup-node@v5` — ci.yml ×8, nightly.yml ×3
- `actions/upload-artifact@v5` — ci.yml ×2
- `gitleaks/gitleaks-action@v2` (third-party) — ci.yml ×1, and it is handed `secrets.GITHUB_TOKEN` and
  `secrets.GITLEAKS_LICENSE` (ci.yml:211-212) in a workflow with no `permissions` restriction.
A retagged `pnpm/action-setup@v4` runs before `pnpm install` in every job of the pipeline that is supposed to be
the supply-chain gate. Separately, ci.yml:219-220 pipes
`https://github.com/gitleaks/gitleaks/releases/download/v8.30.1/...tar.gz` straight into
`tar -xz -C /usr/local/bin` with no SHA-256 verification (whether `/usr/local/bin` is writable without `sudo` on
the hosted image is unverified — if not, this step also fails on first push to main).
**Fix:** Pin each action to its full 40-char commit SHA with the tag in a trailing comment; add Dependabot
`github-actions` updates. For the binary: download to a temp file, `echo "<sha256>  gitleaks.tgz" | sha256sum -c -`,
then extract to `$RUNNER_TEMP` and call it by path.

### WR-C-14: The "non-bypassable" provenance gate checks a hardcoded list covering 27 of 52 dependencies and trusts a self-asserted field

**File:** `scripts/check-package-provenance.mjs:25-115` (list), `:12-15` (claim), `:153-167` (lookup)
**Issue:** Three independent weaknesses:
1. **It never reads a `package.json`.** Cross-referencing all seven workspace manifests against
   `EXPECTED_PACKAGES`: 52 external dependencies, 27 covered, **25 not checked at all**, including the
   security-critical production ones: `ssh2`, `argon2`, `better-auth`, `pg`, `fastify`, `pino`, `zod`,
   `drizzle-orm`, `uuidv7`, plus `tsx`, `turbo`, `typescript`, `eslint`, `testcontainers`,
   `@testcontainers/postgresql`, `@vitest/coverage-v8`, `set-cookie-parser`, `drizzle-kit`, `@types/*`. Adding a
   typosquatted dependency tomorrow passes CI because nothing forces it into the list. ci.yml:173-176 claims the
   opposite ("a future dependency addition that skips this check ... now fails CI"). Two listed names
   (`playwright`, `fastify-type-provider-zod`) are not dependencies anywhere — the list is already stale in both
   directions.
2. **The header's core claim is false:** "a typosquat cannot claim the real org's repository". `repository.url`
   is free-text metadata written by the publisher; the registry does not verify it. A malicious `vitets` can
   declare `git+https://github.com/vitest-dev/vitest.git`. Only npm provenance attestations bind a tarball to a
   repo.
3. It queries the registry's `latest` dist-tag, not the version pinned in `pnpm-lock.yaml`, so it says nothing
   about what is actually installed.
Exact-equality comparison is correctly implemented (no `includes`), and network failure fails closed (exit 1).
Normalisation pitfalls only cause false failures (`http://`, scp-style `git@github.com:o/r`, trailing `/`,
`www.`), with one benign hole: a non-GitHub host whose first path segment equals the owner
(`https://vitest-dev/vitest`) normalises to a match — moot given (2).
**Fix:** Derive the package set from the manifests and fail on any name missing from the allowlist:
```js
const declared = collectExternalDeps(globWorkspaceManifests());   // dependencies + dev + peer + optional
const unknown = declared.filter((n) => !EXPECTED.has(n));
if (unknown.length) fail(`not in provenance allowlist: ${unknown.join(', ')}`);
```
For real provenance, run `pnpm audit signatures` / `npm audit signatures` (registry signatures + attestations)
against the lockfile, and keep the allowlist as the human-review record it actually is. Correct the header and
the ci.yml comment.

### WR-C-15: check-ui-safety gates are string tripwires that fail open, are already evaded in-repo, and cite a self-check that does not exist

**File:** `scripts/check-ui-safety.mjs:19-26` (fail-open), `:44-59` (comment strip + false claim), `:93-157` (gates)
**Issue:** The script passes today (`count=1/0/0/...`), but as enforcement it is weak:
- **Fails open.** `listFiles` returns `[]` on any `readdirSync` error. If `packages/ui/src` or `apps/web/src`
  is moved/renamed, every "zero X" gate passes vacuously (only the `=== 1` gate would notice, and only if
  `apps/web/src` is the one that vanished).
- **False claim.** The `stripCommentLines` doc says its single-line-comment assumption is "verified by this
  script's own `--self-check` mode below". There is no such mode anywhere in the file. A line such as
  `/* eslint-disable */ fetch(u, { credentials: 'include' })` is dropped whole. (The trailing-`*` rule also
  drops any code line beginning with `*`.)
- **Gate 1** (`dangerouslySetInnerHTML === 1`) is a count, not a location: delete the reviewed one in
  `layout.tsx`, add one elsewhere, still green. `innerHTML =`, `insertAdjacentHTML`, `document.write` and
  computed keys are unscanned.
- **Gate 2** (`JSON.stringify`) scans `.tsx` only; a helper in any `.ts` file, or `const { stringify } = JSON`,
  passes.
- **Gates 3/4** (hex / `rgb(`): already evaded in the repo — `apps/web/src/components/Sidebar.tsx:41` uses
  `bg-black/40`. `theme.css` never resets Tailwind's default palette (`--color-*: initial`), so `bg-red-500`,
  `text-white`, `hsl()`, `oklch()`, `color-mix()` and named colours all compile and all pass. Conversely the hex
  regex false-positives on anchors like `href="#add"`/`#dead`.
- **Gate 5** (`outline: none`): misses `outline: 0`, `outlineWidth: 0`, and — see WR-C-09 — the `outline-none`
  class it explicitly exempts *is* `outline-style:none` in Tailwind v4.
- **Gate 6**: only `onEscapeKeyDown|onInteractOutside`; the usual way to disable outside-click,
  `onPointerDownOutside={(e) => e.preventDefault()}`, plus `onFocusOutside`, are not gated.
- **Gate 7**: `\bspinner\b` is case-sensitive; `<Spinner/>`, `LoadingSpinner`, a custom `@keyframes` rotate pass.
- **Gate 8**: only the literal `credentials: 'include'`/`"include"`; a template literal, a variable,
  `xhr.withCredentials = true` or `new EventSource(url, { withCredentials: true })` (this app uses
  `EventSource`) pass.
- **Gate 9**: only the `@noodara/ui/testing` specifier; a relative import of `packages/ui/src/testing/render`
  (or `./testing/render.js` from inside `packages/ui/src`) passes.
- There is no gate for `localStorage`/`sessionStorage`/`console.*` in UI code even though T-5-41 and the
  security skill treat those as leak channels; two production files already touch `localStorage`.
Globs do cover both `apps/web/src` and `packages/ui/src`; the `*.test.ts(x)` exclusion is reasonable.
**Fix:** Throw on unreadable roots and assert a minimum file count; remove or implement `--self-check`; move
the structural rules to ESLint where they are AST-accurate (`no-restricted-syntax` for JSX attributes
`dangerouslySetInnerHTML`/`onPointerDownOutside`/…, `no-restricted-properties` for `JSON.stringify`,
`localStorage`, `no-restricted-imports` with `patterns` for `**/testing/**`), pin gate 1 to the exact file, and
add `--color-*: initial;` at the top of the `@theme` block so non-token colour utilities do not exist at all.

### WR-C-16: Turborepo boundaries were widened so that domain→ui and ui→ssh are permitted, contradicting the plan's own threat mitigation

**File:** `turbo.json:81-95`
**Issue:** This phase added `ui-components` to `pure-domain`'s allow list and gave `ui-components` an allow
list that includes `ssh-adapter`. In Turborepo, `tags.<tag>.dependencies.allow` is directional: it lists what a
package carrying that tag may depend on. As written, `packages/domain` may depend on `@noodara/ui` and on
`@noodara/ssh`, and the browser design system may depend on the SSH adapter. 05-06-PLAN's threat T-5-24
mitigation says the `ui-components` allow list "names only `ui-components`, `@noodara/config` and
`pure-domain`"; the shipped config does not match. The recorded justification (STATE.md: allow lists "behave
undirectedly"; "hoisting artifact of pnpm's flat root node_modules") is an executor diagnosis that was accepted
without a minimal reproduction — a likelier cause is that the *root* package declares `@noodara/domain` and
`@noodara/ssh` as devDependencies and the root is evaluated too (root cause **unverified**; I did not mutate
`turbo.json` to test it). CLAUDE.md advertises `pnpm boundaries` as the "packages/domain puro" gate; for
domain the only real guard is now `purity.test.ts`, and for ui→ssh there is none beyond the dependency not being
declared in `packages/ui/package.json`.
**Fix:** Reproduce the original failure with the narrow lists and read which importer/importee pair Turborepo
actually reports; then express it precisely (e.g. give the root package its own tag, or use
`dependents.allow` on `pure-domain`) instead of widening leaf tags. At minimum remove `ui-components` and
`ssh-adapter` from `pure-domain` and `ssh-adapter` from `ui-components`, and add a `packages/ui` purity test
mirroring domain's frozen dependency list.

### WR-C-17: `trace: 'on-first-retry'` with `retries: 0` means no trace is ever recorded

**File:** `playwright.config.ts:18,30`
**Issue:** `retries: 0` is correct (CLAUDE.md forbids masking flakes), but combined with `on-first-retry` the
trace setting is dead: there is never a first retry. This has already cost the phase a diagnosis —
05-20-SUMMARY.md:148-149: "The original `:208` `row.hover()` 60s timeout ... was never captured with a trace"
and "iteration-6 `:191` failure has no surviving artifact". The nightly 20× job exists to catch rare flakes and
will, by configuration, never produce evidence for one. The CI artifact upload is only `playwright-report/`, so
even screenshots outside the HTML report are dropped.
**Fix:** `trace: 'retain-on-failure'` (still nothing on green runs). Traces include typed values and cookies;
the existing safeguards stay adequate — failure-only upload, 7-day retention, fixture-only credentials — but
also upload `test-results/` on failure and add the same failure-only upload step to `nightly.yml`'s
`e2e-repeat` job, which currently uploads nothing.

## Info

### IN-C-01: DestructiveConfirmDialog resets the typed name in a post-commit effect on open; no reopen test

**File:** `packages/ui/src/Dialog.tsx:122-128`
**Issue:** State lives in the always-mounted wrapper and is cleared by `useEffect` when `open` becomes true, so
the first commit after reopening still has the previous `typed` value and an enabled confirm button until the
effect's re-render. For discrete events React flushes this before paint; for a non-discrete open (after a fetch,
an SSE event) one armed frame can paint. The value is also never cleared on close, and a `requiredName` change
while open does not reset it. `Dialog.test.tsx` has no close-and-reopen case, so the "does not pre-arm the next
destructive action" property is untested.
**Fix:** Move `typed` state, the Field and the action row into a child component rendered inside
`DialogPrimitive.Content` (which unmounts on close) and key it by `requiredName`; delete the effect. Add the
reopen test.

### IN-C-02: stack.ts teardown gaps on rare paths

**File:** `tests/e2e/fixtures/stack.ts:114-115,158-170`
**Issue:** (a) `startRedis()` runs outside the `try`; if it throws, the already-started Postgres container is
never stopped (Ryuk reaps it eventually — it is not disabled). (b) In the catch block `await postgres.stop()`
throwing skips `redis.stop()` and masks the original error. (c) `tests/e2e/global-teardown.ts` returns *without*
calling `stopStack` when the handoff JSON is unreadable, although `stopStack` needs nothing from it; and
`global-setup.ts` writes that file *after* `startStack()` succeeds, so an `mkdir`/`write` failure leaves a fully
running stack of `detached: true` process groups holding ports 3000/3100 — every later run then fails with
EADDRINUSE until killed by hand.
**Fix:** Start Redis inside the guarded region; use `Promise.allSettled([postgres.stop(), redis.stop()])`;
make teardown call `stopStack` unconditionally and wrap the handoff write in try/catch that stops the stack
before rethrowing.

### IN-C-03: e2e-repeat.mjs — silent count fallback, opaque signal exits, QA-04's 20× never ran as one invocation

**File:** `scripts/e2e-repeat.mjs:22-23,29,35-41`
**Issue:** `node scripts/e2e-repeat.mjs 0`, `abc` or `2.5` silently runs 20 iterations instead of erroring. A
child killed by a signal has `status === null`; the message prints "exit null" and drops `result.signal`.
`spawnSync` blocks the event loop, so the parent cannot forward SIGTERM; with the stack's detached process
groups a cancelled local run can orphan the API/worker/web trio. Also for the record: the 20/20 evidence in
05-20-SUMMARY.md:138 is three invocations (7+7+6), not one continuous 20× run as the nightly performs.
**Fix:** Exit 2 on an invalid count; log `result.signal`; use async `spawn` with SIGINT/SIGTERM handlers that
forward to the child and wait.

### IN-C-04: format.ts rounding edge cases

**File:** `packages/ui/src/format.ts:52-56,89-93,164`
**Issue:** Unit selection uses the unrounded value but the magnitude is rounded, so 23h45m renders
"24 hours ago" (not "1 day ago") and 59m40s renders "60 minutes ago". `formatMb(1023.6)` renders "1024 MB"
rather than "1 GB". `formatMb(-5)` renders "-5 MB" while its siblings return the placeholder for negatives.
`formatDiskUsage` documents a "0..1 fraction" but returns > 1 when used > total (StatTile clamps, other consumers
may not). `toValidDate` accepts any `Date`-parsable string, e.g. `"1"` → year 2001.
**Fix:** Round first, then pick the unit (promote when the rounded magnitude reaches the next unit's size);
compare the rounded MB value against 1024; reject negatives in `formatMb`; clamp or document the fraction.

### IN-C-05: Sheet and Disclosure motion classes never animate

**File:** `packages/ui/src/Sheet.tsx:24-25`, `packages/ui/src/Disclosure.tsx:27`
**Issue:** Radix `Presence` mounts content already in `data-state="open"` (no starting value for a CSS
*transition*) and only defers unmount for CSS *animations* (`animationend`), so `transition-transform` +
`data-[state=closed]:translate-x-full` produces neither an enter nor an exit; the spec'd 320ms sheet motion is
not delivered. `Disclosure` transitions `grid-template-rows` on an element that is not a grid and is unmounted
when closed. Both doc comments describe motion that does not happen.
**Fix:** Define `@keyframes` enter/exit (gated by `motion-safe`) keyed on `data-state`, or delete the dead
classes and the claims.

### IN-C-06: Tracking and display-font tokens are defined but never applied in packages/ui

**File:** `packages/ui/theme.css:44-50` and every `text-title`/`text-display`/`text-label` call site (e.g. `Dialog.tsx:36`, `Sheet.tsx:55`, `EmptyState.tsx:24`, `StatTile.tsx:21-22`)
**Issue:** Tracking is bound as separate `--tracking-*` utilities, but no component in `packages/ui` uses a
`tracking-*` or `font-display` class (repo-wide only two `tracking-wide` uses, in apps/web). Skill §2.2's
-0.02em/-0.015em title tracking, 0.04em label tracking and SF Pro Display are therefore not rendered.
**Fix:** Tailwind v4 supports `--text-title--letter-spacing` and `--text-title--font-weight` paired theme keys;
bind them in `theme.css` so `text-title` carries its tracking automatically.

### IN-C-07: Dependency hygiene in packages/ui

**File:** `packages/ui/package.json:18-21,35,39`
**Issue:** `@radix-ui/react-checkbox` and `@radix-ui/react-scroll-area` are declared but imported nowhere in
`packages/ui/src` or `apps/web/src` — unused supply-chain surface. `tsconfig.build.json` excludes only
`*.test.*`, so `src/testing/render.tsx` is compiled into `dist/` and exported via `./testing`, where it imports
`@testing-library/*` — devDependencies only. Harmless while the package is private and the import is gated, but
the production build carries a module that cannot resolve its imports in a production install. `react` as a
peer + exact devDependency, Radix/lucide as dependencies, and the workspace `overrides` pin are correct. No
`'use client'` directive exists in any component, so the barrel cannot be imported from a Server Component
(today every consumer is a client file).
**Fix:** Remove the two unused Radix packages (and their provenance entries) until a component needs them;
exclude `src/testing` from `tsconfig.build.json` and point `./testing` at source for Vitest only (as
`@noodara/ssh/testing` already does via alias), or move the testing-library packages to optional peers.

### IN-C-08: Theme semantics differ slightly between ThemeToggle and the bootstrap script; "system" is not live

**File:** `packages/ui/src/ThemeToggle.tsx:73-76`; counterpart `apps/web/src/lib/theme-script.ts`
**Issue:** Storage key (`noodara-theme`), attribute (`data-theme`) and accepted values match. Differences:
the bootstrap wraps storage *and* `matchMedia` in one `try`, so when storage throws it sets no `data-theme` at
all (light until hydration, then ThemeToggle's effect flips to the OS value — a flash for dark-OS users in
private mode), whereas ThemeToggle guards them separately. In "system" mode nothing listens for
`matchMedia` `change`, and because ThemeToggle always writes a concrete `data-theme`, an OS theme switch is
ignored until reload. Neither `tokens.css` nor `globals.css` sets `color-scheme`, so native controls and
scrollbars stay light in dark mode.
**Fix:** Split the bootstrap's try blocks; subscribe to the media query while `mode === 'system'`; add
`color-scheme: light` / `dark` to the two token blocks.

### IN-C-09: Smaller component notes

**File:** `packages/ui/src/FileButton.tsx:49-59`, `packages/ui/src/SegmentedControl.tsx:9-14`, `packages/ui/src/ListRow.tsx:65`
**Issue:** `FileButton` assumes UTF-8 (`readAsText` default): a DER/binary or UTF-16 key is decoded with
replacement characters and handed to `onText` as if valid, and an in-flight read is not aborted on unmount
(callbacks fire on an unmounted caller). `SegmentedControlProps` accepts no `aria-label`/`aria-labelledby`, so
the radiogroup can never have an accessible name. `ListRow`'s `href` branch renders a plain `<a>`, i.e. a full
document navigation inside a Next app (callers needing SPA navigation must use `onActivate`).
**Fix:** Reject content containing `�`/NUL with the fixed read-error message and `reader.abort()` in an
effect cleanup; add an `aria-label` prop to `SegmentedControl`; accept a `linkComponent`/render prop in
`ListRow`.

---

_Reviewed: 2026-09-20T07:26:07Z_
_Reviewer: Claude (gsd-code-reviewer)_
_Depth: standard_
