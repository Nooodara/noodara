---
phase: 4
slug: http-routes-worker-bullmq-y-sse
status: verified
threats_open: 0
asvs_level: 2
created: 2026-09-18
---

# Phase 4 — Security

> Per-phase security contract: threat register, accepted risks, and audit trail.

---

## Trust Boundaries

| Boundary | Description | Data Crossing |
|----------|-------------|----------------|
| browser/any HTTP client → API | Unauthenticated, attacker-controlled requests and headers reach Fastify | request bodies, headers, Origin, cookies |
| service result → HTTP response | Internal failure codes/messages become client-visible bodies | error codes, Zod issues, exceptions |
| database row → event payload | A `servers` row (adjacent to an encrypted credential) becomes an SSE payload | `ServerView` (27-field allowlist) |
| API process ↔ Redis ↔ worker process | Job data, pub/sub events and heartbeats cross a process boundary outside Postgres' guarantees | job payload, event envelope, heartbeat key |
| Redis channel → API process | Any writer to a shared Redis can publish on the channel the API fans out verbatim | SSE frame content |
| unauthenticated network → `/health` | The one route that answers without a session | pass/fail literals, version |
| admin browser → `/api/servers*` | Attacker-shaped bodies/params/credential material cross into the control plane | server CRUD, connect/discover/trust-fingerprint |

---

## Threat Register

| Threat ID | Category | Component | Disposition | Mitigation | Status |
|-----------|----------|-----------|-------------|------------|--------|
| T-4-SC | Tampering | `pnpm add bullmq/ioredis/@testcontainers/redis` | mitigate | `scripts/check-package-provenance.mjs` extended with exact owner/repo for all three; ADR 0000 records `[OK]` verdicts | closed |
| T-4-01 | Spoofing | guarded `/api` scope (sessions, servers×8, activity, config, events) | mitigate | `createRequireSession` `onRequest` hook 401s before handler; `api-scope.ts` registers every guarded route inside it | closed (see caveat under Unregistered Flags — CR-03) |
| T-4-02 | Elevation of Privilege | live SSE stream after logout/revocation | mitigate | heartbeat re-resolves session every interval, ends stream when gone; remediated in Plan 05-01 (`auth/session-lookup.ts`'s `withSessionLookupTimeout` wraps `routes/events.ts`'s heartbeat `getSession` call, bounded at 2000ms) | closed |
| T-4-03 | Tampering | `job.data` in Redis | mitigate | `.strict()` discriminated-union schema; `parseConnectServerJobPayload` on consume → `INVALID_PAYLOAD` | closed |
| T-4-04 | Information Disclosure | error bodies / `app.setErrorHandler` | mitigate | opaque 500 `{error:'INTERNAL_ERROR'}`, `appRedactor.redact(error.message)` in log only; canary test | closed |
| T-4-05 | Information Disclosure | `server.updated`/SSE frame payload, `/api/servers` responses | mitigate | `toServerView` 27-field allowlist; key-set assertion test; canary-http scan | closed |
| T-4-06 | Denial of Service | SSE connection cap | mitigate | `NOODARA_SSE_MAX_CONNECTIONS` env range 1–1000; `events.ts` checks `size >= maxConnections` → 503 before hijack | closed |
| T-4-07 | Spoofing/CSRF | Origin guard on mutating routes | mitigate | `createOriginGuard` strict `===` on parsed origin, absent-Origin allowed; wired ahead of session check in `api-scope.ts` | closed |
| T-4-08 | Denial of Service | Redis outage (enqueue, SSE broadcaster start) | mitigate | `enqueue` bounded (`commandTimeout`+`Promise.race`) → `QUEUE_UNAVAILABLE` 503; `onReady` catches broadcaster start failure | closed |
| T-4-09 | Repudiation | abandoned CONNECTING row / stalled jobs | mitigate | `failInFlightConnection`; `maxStalledCount:0` + `stalled` listener + `sweepAbandonedConnections` at startup | closed |
| T-4-10 | Information Disclosure | worker `failed`/`warn` logs | mitigate | remediated in Plan 05-02 (`logger.ts`'s `serializers.err` reduces every logged error to `{ name }` only, applied centrally so `queue/connect-server-worker.ts`'s `worker.on('failed', ...)` needed no call-site edit) | closed |
| T-4-11 | Information Disclosure | activity items | mitigate | explicit 10-column select in `listActivityEvents`, no `.select()` | closed |
| T-4-12 | Information Disclosure | `/api/config` | mitigate | only truncated SHA-256 master-key fingerprint returned | closed |
| T-4-13 | Denial of Service | worker concurrency | mitigate | `NOODARA_WORKER_CONCURRENCY` env range 1–20 | closed |
| T-4-14 | Information Disclosure | env validation failure output | accept-by-existing-control | `EnvIssue{variable,requirement}` never carries a `value`/`received` field (verified: no call site populates one) | closed |
| T-4-15 | Elevation of Privilege | `request.actor` | mitigate | decorated `null`, assigned only from resolved session in `require-session.ts`; `requireActor()` throws on null | closed |
| T-4-16 | Tampering | status-mapping drift | mitigate | `SERVICE_ERROR_STATUS` frozen + `satisfies`; `http-errors.test.ts` static exhaustiveness scan present and non-vacuous | closed |
| T-4-17 | Repudiation | publish-before-commit | mitigate | every `publishServerEvent` call sits after `deps.db.transaction(...)` resolves (verified in connect-and-discover, edit-server, delete-server, trust-fingerprint, fail-in-flight-connection) | closed |
| T-4-18 | Denial of Service | failing publisher aborting real work | mitigate | `publishServerEvent` try/catch swallows publisher rejection/throw | closed |
| T-4-19 | Information Disclosure | `server.deleted` payload | mitigate | carries only `{ id }` (type-level + `delete-server.ts` call site) | closed |
| T-4-20 | Information Disclosure | Zod validation errors | mitigate | `toValidationErrorBody` copies only `path`/`message`; test proves `received`/`expected` dropped | closed |
| T-4-21 | Denial of Service | unhandled exception | mitigate | global `setErrorHandler` converts every throw to a response | closed |
| T-4-22 | Information Disclosure | response serialization failure | mitigate | `isResponseSerializationError` branch → opaque 500, never the payload | closed |
| T-4-23 | Tampering | recovery clobbering a finished attempt | mitigate | `SELECT ... FOR UPDATE` + `status !== 'CONNECTING'` skip in `failInFlightConnection` | closed |
| T-4-24 | Spoofing | actor attribution on recovery | mitigate | actor carried from job payload (Zod-validated), same `actorId` expression as other services | closed |
| T-4-25 | Information Disclosure | recovery activity metadata | mitigate | `metadata: { reason }` from fixed 2-member union only | closed |
| T-4-26 | Information Disclosure | job payload contents | mitigate | payload carries only `serverId`,`actor`,`requestedAt`,`trigger`; worker re-reads/decrypts | closed |
| T-4-27 | Information Disclosure | queue error messages | mitigate | fixed `'Job queue is unavailable'` string, ioredis error text discarded (`catch { return ... }`) | closed |
| T-4-28 | Tampering | Redis key namespace collisions | mitigate | `BULLMQ_PREFIX='noodara'`, `WORKER_HEARTBEAT_KEY_PREFIX='noodara:worker:'`, `SERVER_EVENTS_CHANNEL='noodara:server-events'` | closed |
| T-4-29 | Tampering | double SSH execution on stall | mitigate | `stalled` listener calls only `failInFlightConnection`, never `connectAndDiscover` | closed |
| T-4-30 | Denial of Service | Redis flapping in live worker | mitigate | all `redis/connections.ts` factories log `err.name` only via `console.warn`, never `process.exit`; heartbeat write wrapped in `.catch` | closed |
| T-4-31 | Denial of Service | unbounded parallel SSH | mitigate | `concurrency: env.NOODARA_WORKER_CONCURRENCY` (1–20) passed into `createWorker` | closed |
| T-4-32 | Denial of Service | shutdown hanging on active job | mitigate | remediated in Plan 05-02 (`queue/worker-shutdown.ts`'s `runWorkerShutdown` wraps the `Promise.race` in per-step try/catch isolation — `stopHeartbeat`/`closeQueue`/each `disconnect()` runs even if `close()` rejects — wired into `worker.ts`) | closed |
| T-4-33 | Tampering | request bodies | mitigate | `.strict()` on Create/Update/Delete server schemas, `z.uuid()` on id param | closed |
| T-4-34 | Denial of Service | duplicate connect storms | mitigate | deterministic `jobId`; `addFreshJob` only removes a *terminal* job, leaves waiting/active/delayed untouched; row lock → `ALREADY_CONNECTING` | closed |
| T-4-35 | Information Disclosure | enqueue logs | mitigate | `fastify.log.info({ serverId, jobId, trigger }, ...)` — no body, no credential, no host | closed |
| T-4-36 | Tampering/Injection | foreign message on pub/sub channel | mitigate | `KNOWN_EVENT_TYPES` allowlist + JSON-parse guard in `sse-broadcaster.ts` | closed |
| T-4-37 | Denial of Service | shutdown deadlock | mitigate | streams ended in `preClose` (not `onClose`); `closeAll()` bounded `unsubscribe` race | closed |
| T-4-38 | Information Disclosure | publish-failure logs | mitigate | remediated in Plan 05-02 (`logger.ts`'s `serializers.err` reduces every logged error to `{ name }` only, closing both `events/redis-server-event-publisher.ts` and `events/sse-broadcaster.ts`'s warn sites with no call-site edit) | closed |
| T-4-39 | Tampering | activity cursor input | mitigate | `decodeActivityCursor` validates timestamp+uuid, returns result; route → 400 on failure | closed |
| T-4-40 | Denial of Service | activity `limit` abuse | mitigate | Zod `.min(1).max(200)`, query always `limit + 1` | closed |
| T-4-41 | Information Disclosure | `/health` unauthenticated body | mitigate | body carries only version + 3 `pass`/`fail` literals; degraded-worker case asserted in boot-command.test.ts | closed |
| T-4-42 | Denial of Service | `/health` under a hanging dependency | mitigate | each check `withTimeout` (2s); worker check uses `SCAN`+bounded `COUNT`, never `KEYS` | closed |
| T-4-43 | Repudiation | validation map honesty | mitigate | `04-VALIDATION.md` populated (46 rows) with real task ids/statuses, cross-checked by 04-VERIFICATION.md | closed |
| T-4-44 | Denial of Service | operational blind spot (`/health` worker liveness) | mitigate | `boot-command.test.ts` "two-process boot" proves `checks.worker` flips pass→fail on real worker death | closed |

*Status: open · closed*
*Disposition: mitigate (implementation required) · accept (documented risk) · transfer (third-party) · accept-by-existing-control (relies on a prior phase's verified control)*

### Remediated — detail (historical findings, kept for audit trail)

The four findings below were confirmed open by this audit (2026-09-18) and are now closed.
Each entry's original vulnerability description is preserved verbatim below its heading;
the **Remediated** line at the end of each entry records the actual fix, evidence and date —
the original **Fix:** sentence describes what was *recommended*, not necessarily the exact
shape of what was *implemented* (see 05-01-SUMMARY.md / 05-02-SUMMARY.md for the literal diff).

**T-4-02 (Elevation of Privilege — live SSE stream after logout, `apps/control-plane/src/routes/events.ts:78-96`, `apps/control-plane/src/auth/require-session.ts:38-49`).**
The plan's mitigation claims the heartbeat "bound[s] the exposure window to one interval (~15s in production)". Confirmed by reading the code: `deps.getSession(...)` inside the `setInterval` callback is awaited with **no timeout** — matches code-review finding CR-03 exactly. If Better Auth's session lookup hangs or is merely slow, (a) the current tick never resolves, so the "one interval" bound does not hold — a revoked session can stay open past 15s indefinitely; (b) because the same `setInterval` fires again at the next tick regardless of whether the previous call settled, overlapping `getSession` calls can pile up per open connection (up to `NOODARA_SSE_MAX_CONNECTIONS`) with no backpressure, which is itself a secondary DoS vector on top of the elevation-of-privilege window. The existing revocation test (`events-sse.test.ts`, "closes the stream within two heartbeat intervals after the session is revoked") only exercises the fast-resolving-session path and does not cover a hung/slow lookup, so it cannot have caught this. **Fix:** wrap `deps.getSession(...)` in both `require-session.ts` and `events.ts` in a bounded `Promise.race` (mirrors `health.ts`'s existing `withTimeout` pattern), per CR-03's suggested fix.
**Remediated (2026-09-19, Plan 05-01):** `apps/control-plane/src/auth/session-lookup.ts` adds `withSessionLookupTimeout` (`SESSION_LOOKUP_TIMEOUT_MS = 2000ms`, `Promise.race`-against-`setTimeout`, mirroring `health.ts`'s `withTimeout`). Wired into both previously-unbounded call sites: `require-session.ts`'s `onRequest` hook and `routes/events.ts`'s heartbeat interval. Evidence: `apps/control-plane/src/auth/session-lookup.test.ts` (4 unit tests: resolve-passthrough, timeout-rejects, rejection-passthrough, default-bound), `apps/control-plane/src/auth/require-session.test.ts`'s fake-timers regression case (a never-settling `getSession` still answers 500 within the bound), and the new `apps/control-plane/src/routes/events.test.ts` (a never-settling `getSession` still closes the SSE stream within one heartbeat tick plus the lookup bound). Also closes the related UF-03 finding (same unbounded-`getSession` root cause on the request guard).

**T-4-10 (Information Disclosure — worker `failed`/`warn` logs, `apps/control-plane/src/queue/connect-server-worker.ts:99-101`, `apps/control-plane/src/logger.ts:10-19`).**
The mitigation plan asserts "the `err` serializer is pino's, already redaction-configured in `logger.ts`." Read `logger.ts`: `REDACT_PATHS` contains only structural key-paths (`req.headers.*`, `req.body.password`, `*.credential`, `*.encryptedCredential`, `*.masterKey`) — there is no `err.message`/`err.stack` redaction, and no `serializers` option is configured at all. Verified directly (`node -e "pino({}).warn({err: new Error('secret-redis://user:pass@host:6379')}, 'test')"` under `apps/control-plane`) that pino's **default** behavior serializes an `Error`'s `message` and `stack` **verbatim** into the JSON log line with no redaction applied — the "already redaction-configured" premise in the plan is factually false. `worker.on('failed', (job, err) => { options.logger.error({ jobId: job?.id, err }, ...) })` passes the raw `Error` object through this same unconfigured path. Today's actual throw sites in the services this handler wraps (`connect-and-discover.ts`, `edit-server.ts`, etc.) only throw fixed-text invariant-violation messages, so no live secret leak was demonstrated — but the structural control the mitigation plan claims to exist does not, so a future exception with a driver/connection-string message (exactly the class of error `redis/connections.ts`'s own comments warn about) would leak through this exact path with nothing in the code to stop it. **Fix:** either configure `serializers: { err: (e) => ({ name: e.name }) }` in `logger.ts`, or have this call site log `err.name` only, consistent with the discipline already used in `redis/connections.ts` and `worker-heartbeat.ts`.
**Remediated (2026-09-19, Plan 05-02):** `apps/control-plane/src/logger.ts` gains a central `serializers.err` option reducing any logged error to `{ name }` only (never message/stack/cause/code), applied to every `createLogger()` caller including `queue/connect-server-worker.ts`'s `worker.on('failed', ...)` site — no call-site edit was needed. Evidence: `apps/control-plane/src/logger.test.ts` (4 new cases: no message/stack leak, correct `name` for `Error`/`TypeError`, `UnknownError` for non-Error values, redaction behavior unchanged) and a real captured `pnpm security:scan-leaks` log line (`{"err":{"name":"AggregateError"}...}`).

**T-4-32 (Denial of Service — shutdown hanging on an active job, `apps/control-plane/src/worker.ts:74-93`).**
Matches code-review finding WR-02 exactly, confirmed by reading the file: `shutdown()` has no `try`/`catch` around `Promise.race([handle.close(), ...])`. If `handle.close()` rejects (e.g. Redis already down while the BullMQ `Worker` tries to close cleanly), the `Promise.race` rejects, and every subsequent cleanup step (`stopHeartbeat()`, `queue.close()`, the three `disconnect()` calls, `process.exit(0)`) is skipped — the function's rejection is never caught (`process.on('SIGTERM', () => void shutdown())` discards it), so the declared "Promise.race against the D-14 budget guarantees termination" does not hold in this branch: the orchestrator's shutdown signal produces no clean bounded exit, only an unhandled-rejection code path outside this file's control. **Fix:** wrap the race in `try { ... } catch { ... } finally { <cleanup>; process.exit(0); }` per WR-02's suggested fix.
**Remediated (2026-09-19, Plan 05-02):** `worker.ts`'s inline shutdown closure was extracted into `apps/control-plane/src/queue/worker-shutdown.ts`'s `runWorkerShutdown(deps)`: the `Promise.race` against the close budget is followed by `stopHeartbeat`/`closeQueue`/every `disconnect()` entry, each individually try/catch-isolated so one step's rejection never skips a later step; an identity-keyed re-entry guard (`WeakSet<deps>`) prevents double-invocation. `worker.ts` is wired to this helper. Evidence: `apps/control-plane/src/queue/worker-shutdown.test.ts` (5 cases: resolving close, rejecting close, never-settling close under fake timers, rejecting `closeQueue`, double-invocation dedup) and `pnpm build && pnpm test:boot` (6/6, including real SIGTERM clean-shutdown scenarios against the real entrypoint).

**T-4-38 (Information Disclosure — publish-failure logs, `apps/control-plane/src/events/redis-server-event-publisher.ts:32-34`).**
The mitigation plan claims "no Redis URL, host or port ever gets string-interpolated into a log line." Read the code: `logger.warn({ err }, 'failed to publish server event')` passes the raw `Error` object. This is **self-evidenced by the project's own test**: `redis-server-event-publisher.test.ts`'s own passing test "never includes a Redis URL, host or port in the warn record" injects `new Error('connect ECONNREFUSED 10.0.0.5:6379')` and asserts only that the fixed *message string* doesn't contain `'ECONNREFUSED'`/`'10.0.0.5'` — while separately asserting `payload.err` **is** the raw failure object (`expect(payload.err).toBe(failure)`), i.e. the test itself proves the connection-shaped string is passed through to the logger untouched. Combined with the confirmed absence of any `err`-serializer redaction in `logger.ts` (see T-4-10 above) and the direct pino reproduction showing `err.message`/`err.stack` are serialized verbatim by default, a real ioredis publish failure (which the project's own `redis/connections.ts` comments say "sometimes echo[es] back the [connection] options they failed with") would place that content straight into the structured log — exactly the leak this threat is declared to prevent. The identical pattern also appears in `sse-broadcaster.ts:106-108`'s subscriber error handler (`options.logger.warn({ err }, 'sse broadcaster subscriber redis error')`), an additional, unregistered instance of the same gap. **Fix:** same as T-4-10 — log `err.name` only (or a configured serializer that strips `message`/`stack`) at both sites.
**Remediated (2026-09-19, Plan 05-02):** the same central `serializers.err` fix as T-4-10 closes this threat too — it applies to every `createLogger()`-produced logger regardless of call site, so both `events/redis-server-event-publisher.ts` and the previously-unregistered `events/sse-broadcaster.ts:106-108` instance are covered with no call-site edit. Evidence: same as T-4-10 above.

---

## Unregistered Flags

New attack surface / gaps discovered during this audit that do not map to any threat ID above (WARNING, not a blocker on their own — but escalated given severity).

| ID | Source | Description | Escalation |
|----|--------|-------------|------------|
| UF-01 | CR-01 (code review) | **Confirmed by direct code read.** `editServer` (`apps/control-plane/src/services/edit-server.ts:205-231`) only clears `pendingFingerprint`/`pendingFingerprintSeenAt` `if (row.status === 'CONNECTED')`. But a `pendingFingerprint` is set precisely when a `HOST_KEY_CHANGED` outcome lands the row on **`ERROR`** (`connect-and-discover.ts`, `trust-fingerprint.ts`'s own doc comment). So the one status where a stale `pendingFingerprint` is actually present is exactly the status this edit branch never runs for. `trustFingerprint` (`trust-fingerprint.ts:60-66`) only checks `pendingFingerprint !== null` — it has no notion of which host/user identity that fingerprint was captured against. Exploit: connect to host A (pins `FP_A`) → a later connect observes a different key, row goes `ERROR` with `pendingFingerprint = FP_B` (captured against host A) → admin edits `host` to point at host C while status is `ERROR` (allowed; `pendingFingerprint` untouched) → admin calls the now-HTTP-exposed `POST /api/servers/:id/trust-fingerprint` (`routes/servers.ts:262-284`, exposed for the first time this phase) → `FP_B` (never presented by host C) is promoted into `hostFingerprint` for host C. This defeats TOFU (CLAUDE.md §2.3, noodara-security skill, non-negotiable). Not part of the phase-4 threat register (the fingerprint logic predates this phase) but **first became remotely reachable over HTTP in this phase**. | **REMEDIATED (2026-09-19, Plan 05-01)** — `edit-server.ts`'s `statusPatch` block gained an `else if (row.status === 'ERROR' && row.pendingFingerprint !== null)` branch, clearing the stale `pendingFingerprint`/`pendingFingerprintSeenAt` pair whenever an identity-changing edit (host/sshPort/sshUser) is made while `ERROR`. Evidence: `tests/integration/services/edit-server.test.ts`'s 4 new regression cases (host/port/user identity changes clear it; a name-only edit leaves it untouched and a following `trustFingerprint` still succeeds), confirmed red before the fix (3 of 4 failed with `expected 'SHA256:stale-pending-fp' to be null`). |
| UF-02 | CR-02 (code review) | **Confirmed by direct code read.** `apps/control-plane/src/worker.ts` `main()` (lines 27-97) has no top-level `try`/`catch`, and its only call site (`void main();`, line 99) has no `.catch()`. If `getDb()` or `queueConnection.ping()` rejects (the exact D-25 fail-fast scenario the file's own comments describe), the rejection becomes an unhandled promise rejection and Node's default handler prints the full `Error` (message + stack) to stderr — a different mechanism than pino (no `logger.ts`/redaction involved at all), so it is not covered by T-4-10/T-4-38's declared controls even though it can carry the same class of leak (`DATABASE_URL`/`REDIS_URL` embedded in a driver error message). Not mapped to any threat ID in the register (no threat addresses `worker.ts`'s own boot sequence specifically). | WARNING — recommend the CR-02 fix (wrap `main()`, exit 1 on `err.name` only) before this path is exercised in production. **Not remediated by Plan 05-01/05-02** (neither touched `worker.ts`'s `main()` — only its `shutdown()` sequence); remains open, out of scope for D-17 which only required T-4-02/T-4-10/T-4-32/T-4-38/UF-01. Tracked as a future hardening item, not a blocker. |
| UF-03 | Own finding, prompted by CR-03 | `require-session.ts`'s `onRequest` hook (the sole guard for `/api/servers`, `/api/activity`, `/api/config`, `/api/events`) calls `deps.getSession(...)` with no timeout. Unlike T-4-02 (where the missing bound undermines a *specific* exposure-window claim), this is a general DoS surface on the guard itself: a slow/hung Better Auth/DB-backed session lookup hangs every guarded request indefinitely rather than failing closed with a bounded error, and no DoS threat in the register (T-4-06/08/13/21/30/31/32/40/42/44) covers this specific vector. T-4-01's own declared mitigation (401-before-handler) still functions correctly when `getSession` resolves, so T-4-01 itself is not marked open — but this is new, unregistered DoS surface. | **REMEDIATED (2026-09-19, Plan 05-01)** — same fix as T-4-02: `require-session.ts`'s `onRequest` hook now awaits `deps.getSession(...)` through `withSessionLookupTimeout` (bounded at 2000ms). Evidence: `apps/control-plane/src/auth/require-session.test.ts`'s fake-timers regression case (a never-settling `getSession` still answers 500 `INTERNAL_ERROR` within the bound). |

---

## Accepted Risks Log

| Risk ID | Threat Ref | Rationale | Accepted By | Date |
|---------|------------|-----------|-------------|------|

No accepted risks recorded. T-4-14 is closed via `accept-by-existing-control` (relies on Phase 1's T-1-06 control, verified still true in this phase's code — see register row above), which is distinct from an accepted-risk log entry.

*If none: "No accepted risks."*

---

## Security Audit Trail

| Audit Date | Threats Total | Closed | Open | Run By |
|------------|---------------|--------|------|--------|
| 2026-09-18 | 45 | 41 | 4 | gsd-security-auditor |
| 2026-09-19 | 45 | 45 | 0 | Phase 5 Plans 05-01 (T-4-02/UF-03, UF-01) and 05-02 (T-4-10, T-4-38, T-4-32) remediated the four open register threats plus the UF-01 TOFU-bypass finding, closed here per Plan 05-03 Task 3 |

---

## Sign-Off

- [x] All threats have a disposition (mitigate / accept / transfer / accept-by-existing-control)
- [x] Accepted risks documented in Accepted Risks Log (none recorded)
- [x] `threats_open: 0` confirmed — all 45 threats closed (T-4-02, T-4-10, T-4-32, T-4-38 remediated per the Remediated — detail section above)
- [x] `status: verified` set in frontmatter

**Approval:** evidence-based automated closure, executed per `05-03-PLAN.md` Task 3 (2026-09-19). T-4-02, T-4-10, T-4-32, T-4-38 and the UF-01 TOFU-bypass finding are remediated with code-level fixes and passing regression tests, traced above to `05-01-SUMMARY.md`/`05-02-SUMMARY.md`. This closure records that the evidentiary bar for D-17 is met, not a separate human security review or product-owner sign-off — no such review was requested or performed as part of this task.
