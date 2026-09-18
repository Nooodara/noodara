---
phase: 04-http-routes-worker-bullmq-y-sse
reviewed: 2026-09-18T16:16:46Z
depth: standard
files_reviewed: 85
files_reviewed_list:
  - .github/workflows/ci.yml
  - apps/control-plane/package.json
  - apps/control-plane/src/app.ts
  - apps/control-plane/src/auth/fetch-headers.ts
  - apps/control-plane/src/auth/origin-guard.test.ts
  - apps/control-plane/src/auth/origin-guard.ts
  - apps/control-plane/src/auth/require-session.test.ts
  - apps/control-plane/src/auth/require-session.ts
  - apps/control-plane/src/config-version.test.ts
  - apps/control-plane/src/config-version.ts
  - apps/control-plane/src/env.test.ts
  - apps/control-plane/src/env.ts
  - apps/control-plane/src/events/redis-server-event-publisher.test.ts
  - apps/control-plane/src/events/redis-server-event-publisher.ts
  - apps/control-plane/src/events/server-event-publisher.test.ts
  - apps/control-plane/src/events/server-event-publisher.ts
  - apps/control-plane/src/events/sse-broadcaster.test.ts
  - apps/control-plane/src/events/sse-broadcaster.ts
  - apps/control-plane/src/queue/connect-server-queue.ts
  - apps/control-plane/src/queue/connect-server-worker.ts
  - apps/control-plane/src/queue/job-budget.test.ts
  - apps/control-plane/src/queue/job-budget.ts
  - apps/control-plane/src/queue/job-payload.test.ts
  - apps/control-plane/src/queue/job-payload.ts
  - apps/control-plane/src/queue/worker-heartbeat.test.ts
  - apps/control-plane/src/queue/worker-heartbeat.ts
  - apps/control-plane/src/redis/connections.ts
  - apps/control-plane/src/routes/activity-cursor.test.ts
  - apps/control-plane/src/routes/activity-cursor.ts
  - apps/control-plane/src/routes/activity.ts
  - apps/control-plane/src/routes/api-scope.ts
  - apps/control-plane/src/routes/config.ts
  - apps/control-plane/src/routes/events.ts
  - apps/control-plane/src/routes/health.ts
  - apps/control-plane/src/routes/http-errors.test.ts
  - apps/control-plane/src/routes/http-errors.ts
  - apps/control-plane/src/routes/server-schemas.test.ts
  - apps/control-plane/src/routes/server-schemas.ts
  - apps/control-plane/src/routes/servers.ts
  - apps/control-plane/src/routes/sessions.ts
  - apps/control-plane/src/routes/setup.ts
  - apps/control-plane/src/services/connect-and-discover.ts
  - apps/control-plane/src/services/delete-server.ts
  - apps/control-plane/src/services/edit-server.ts
  - apps/control-plane/src/services/fail-in-flight-connection.ts
  - apps/control-plane/src/services/read-activity.ts
  - apps/control-plane/src/services/read-servers.ts
  - apps/control-plane/src/services/register-server.ts
  - apps/control-plane/src/services/server-service-deps.test.ts
  - apps/control-plane/src/services/server-service-deps.ts
  - apps/control-plane/src/services/server-services.ts
  - apps/control-plane/src/services/session-service.ts
  - apps/control-plane/src/services/trust-fingerprint.ts
  - apps/control-plane/src/worker.ts
  - docs/adr/0000-package-legitimacy-approvals.md
  - scripts/check-package-provenance.mjs
  - tests/integration/activity/canary-http.test.ts
  - tests/integration/auth/session-management.test.ts
  - tests/integration/auth/setup.test.ts
  - tests/integration/boot/boot-command.test.ts
  - tests/integration/helpers/app.ts
  - tests/integration/helpers/boot-process.ts
  - tests/integration/helpers/redis-fixture.test.ts
  - tests/integration/helpers/redis.ts
  - tests/integration/helpers/worker-fixture.ts
  - tests/integration/queue/connect-server-queue.test.ts
  - tests/integration/queue/connect-server-worker.test.ts
  - tests/integration/queue/stalled-recovery.test.ts
  - tests/integration/queue/startup-recovery.test.ts
  - tests/integration/routes/activity.test.ts
  - tests/integration/routes/api-e2e.test.ts
  - tests/integration/routes/api-scope.test.ts
  - tests/integration/routes/config.test.ts
  - tests/integration/routes/error-handler.test.ts
  - tests/integration/routes/events-sse.test.ts
  - tests/integration/routes/health.test.ts
  - tests/integration/routes/servers-connect.test.ts
  - tests/integration/routes/servers-crud.test.ts
  - tests/integration/routes/servers-discover.test.ts
  - tests/integration/services/event-publishing.test.ts
  - tests/integration/services/fail-in-flight-connection.test.ts
  - tests/integration/services/helpers/service-fixture.ts
  - tests/integration/services/read-activity.test.ts
  - tests/integration/services/read-servers.test.ts
  - tests/integration/services/trust-fingerprint.test.ts
findings:
  critical: 3
  warning: 3
  info: 2
  total: 8
status: issues_found
---

# Phase 4: Code Review Report

**Reviewed:** 2026-09-18T16:16:46Z
**Depth:** standard
**Files Reviewed:** 85
**Status:** issues_found

## Summary

Phase 4 wires the HTTP routes, the BullMQ connect-server queue/worker, and the Redis-backed SSE
bridge on top of the phase-3 services. The security-canary discipline is genuinely strong: the
error handler, the job payload schema, the queue/publisher Redis connections, and the dedicated
`security:scan-leaks` HTTP/SSE canary all show real, tested care about not leaking credentials
into responses, logs, activity metadata or SSE frames, and every remote Redis/Postgres call in
`redis/connections.ts` and `health.ts` is explicitly time-bounded.

Three gaps break that same discipline elsewhere, though. First, `editServer` can silently strand a
stale `pendingFingerprint` captured against a server's *old* host/user identity, which
`trustFingerprint` will later promote for the *new* identity — a real TOFU/host-key-verification
bypass, not a cosmetic bug. Second, `worker.ts`'s boot sequence has no top-level error handling
around the Postgres/Redis fail-fast calls the file's own comments say must "abort the boot
loudly" — an unhandled rejection there can print a raw `Error` (potentially embedding
`DATABASE_URL`/`REDIS_URL`) to stderr, exactly what every sibling Redis connection factory in this
same file goes out of its way to avoid. Third, the one non-negotiable rule from CLAUDE.md this
phase does not uniformly honor is "explicit timeout on every remote operation" — `auth.api.
getSession()` is called with no bound both in `require-session.ts`'s `onRequest` hook (the guard
in front of every `/api/servers`, `/api/activity`, `/api/config`, `/api/events` request) and in
`events.ts`'s periodic SSE re-validation.

A handful of smaller quality issues round this out: a `transition()` call whose return value is
discarded and re-literalled by hand in `connect-and-discover.ts`, a worker shutdown path with no
error handling around `handle.close()`, a flaky-prone fixed `setTimeout` in one canary test where
sibling tests already use a polling helper, and duplicated unique-constraint-mapping code between
`register-server.ts` and `edit-server.ts`.

## Critical Issues

### CR-01: `editServer` can leave a stale `pendingFingerprint` that `trustFingerprint` later promotes for a different host identity (TOFU bypass)

**File:** `apps/control-plane/src/services/edit-server.ts:202-231`
**Issue:**
`editServer`'s reason-gated fingerprint side effects (`classifyServerEdit` → clear
`hostFingerprint`/`hostFingerprintCapturedAt` on an `identity` change) only run `if (row.status ===
'CONNECTED')`. But the one column this logic is actually supposed to protect —
`pendingFingerprint` — is set by `connectAndDiscover` precisely when a `HOST_KEY_CHANGED` outcome
lands the row on **`ERROR`**, not `CONNECTED` (see `connect-and-discover.ts`'s
`toConnectionResult`/`applyConnectionResult` call and `trust-fingerprint.ts`'s own doc comment: "A
pending fingerprint can only have been parked by a `HOST_KEY_CHANGED` outcome, which always lands
on `ERROR`"). So the exact starting state where a `pendingFingerprint` is most likely to be
present — `ERROR` — is precisely the state this method's identity-change branch never runs for,
and `pendingFingerprint`/`pendingFingerprintSeenAt` are left untouched no matter how much
`host`/`sshPort`/`sshUser` changes.

Concrete exploit path:
1. Server connects successfully to host A, pinning `hostFingerprint = FP_A`.
2. A later connect attempt observes a different key (legitimate rotation or a MITM) →
   `connectAndDiscover` sets `status = ERROR`, `pendingFingerprint = FP_B` (observed against host
   A).
3. Admin edits the server's `host` to point at a completely different machine, host C (or the
   original host's IP legitimately changes). Since `row.status` is `ERROR`, not `CONNECTED`,
   `editServer` happily updates `host` and leaves `pendingFingerprint = FP_B` in place.
4. Admin calls `POST /api/servers/:id/trust-fingerprint` (e.g. because the UI still shows a
   pending-fingerprint banner). `trustFingerprint` only checks `pendingFingerprint !== null` and
   `status !== 'CONNECTING'` — it has no idea `FP_B` was captured against a host that is no longer
   configured — and promotes `FP_B` into `hostFingerprint` for host C.
5. The server now trusts a fingerprint that was never actually presented by host C, defeating the
   whole TOFU guarantee CLAUDE.md §2.3 and the noodara-security skill treat as non-negotiable.

**Fix:** Clear `pendingFingerprint`/`pendingFingerprintSeenAt` whenever an edit actually changes
`host`, `sshPort` or `sshUser`, regardless of the row's current status — not only when
`row.status === 'CONNECTED'`:
```ts
const identityChanged =
  changedFields.includes('host') || changedFields.includes('sshPort') || changedFields.includes('sshUser');

let statusPatch: Partial<
  Pick<typeof servers.$inferInsert, 'status' | 'hostFingerprint' | 'hostFingerprintCapturedAt' | 'pendingFingerprint' | 'pendingFingerprintSeenAt'>
> = {};

if (identityChanged) {
  // Any stale pending fingerprint was captured against the *old* identity — never valid to
  // promote for whatever host/user this edit now points at.
  statusPatch.pendingFingerprint = null;
  statusPatch.pendingFingerprintSeenAt = null;
}

if (row.status === 'CONNECTED') {
  const classification = classifyServerEdit(/* ... */);
  if (classification === 'identity') {
    statusPatch = {
      ...statusPatch,
      status: transition('CONNECTED', 'PENDING', { reason: 'identity_changed' }),
      hostFingerprint: null,
      hostFingerprintCapturedAt: null,
    };
  } else if (classification === 'access') {
    statusPatch = { ...statusPatch, status: transition('CONNECTED', 'DISCONNECTED', { reason: 'clean_close' }) };
  }
}
```
Add a regression test mirroring the exploit path above: arrange `ERROR` + `pendingFingerprint` via
a real `HOST_KEY_CHANGED` connect (as `trust-fingerprint.test.ts` already does), edit `host`, then
assert `pendingFingerprint` is `null` and a subsequent `trustFingerprint` call returns
`NO_PENDING_FINGERPRINT`.

### CR-02: `worker.ts`'s unhandled boot-time rejection can leak `DATABASE_URL`/`REDIS_URL` (with embedded credentials) to stderr

**File:** `apps/control-plane/src/worker.ts:27-38, 99`
**Issue:** `main()` has no top-level `try/catch`, and its only call site is `void main();` with no
`.catch()`. If `getDb()` (line 31) or `queueConnection.ping()` (line 38) rejects — exactly the
D-25 "fail-fast" scenario this file's own comment calls out — the rejection becomes an unhandled
promise rejection. Node's default handler prints the full `Error` object (message + stack) to
stderr and exits. Depending on the underlying driver, that message can embed the connection string
or host/port that the project itself treats as sensitive: `redis/connections.ts`'s own connection
factories in this very file deliberately log only `err.name` — never `err.message` — specifically
"because a REDIS_URL can carry a password, and ioredis connection errors sometimes echo back the
options they failed with" (see `redis/connections.ts:25-30`). `env.ts`'s `loadEnv` shows the same
discipline for config-validation failures (never echoes the received value). `worker.ts`'s boot
path is the one place in this phase's Redis/Postgres wiring that skips that discipline entirely.

**Fix:** Wrap `main()`'s body and give it a sanitized failure path, mirroring the `err.name`-only
convention already used in this same file's sibling module:
```ts
async function main(): Promise<void> {
  try {
    const db = await getDb();
    const queueConnection = createQueueRedisConnection(env.REDIS_URL);
    // ... existing body ...
  } catch (err) {
    const name = err instanceof Error ? err.name : 'UnknownError';
    logger.error({ errorName: name }, 'worker failed to boot: Postgres or Redis unreachable');
    process.exit(1);
  }
}

main().catch((err: unknown) => {
  const name = err instanceof Error ? err.name : 'UnknownError';
  console.error(`[worker] fatal boot error: ${name}`);
  process.exit(1);
});
```

### CR-03: `auth.api.getSession()` has no explicit timeout in `require-session.ts` (every guarded route) or in `events.ts`'s SSE heartbeat

**File:** `apps/control-plane/src/auth/require-session.ts:38-49`, `apps/control-plane/src/routes/events.ts:78-96`
**Issue:** CLAUDE.md §2.3 and the noodara-security skill both state "Timeouts explícitos en toda
operación remota" as non-negotiable, and every other remote call this phase adds — Redis
`ping`/`scan` in `health.ts`, the BullMQ `enqueue`/`isJobPending` calls, the SSE broadcaster's
`subscribe()`/`unsubscribe()` — is wrapped in an explicit `Promise.race` bound (2s in `health.ts`,
`ENQUEUE_TIMEOUT_MS`/`UNSUBSCRIBE_TIMEOUT_MS` elsewhere). `deps.getSession(...)` (which resolves to
`auth.api.getSession({ headers })`, a database-backed lookup through Better Auth) is the one remote
call in this phase's HTTP path with no such bound:
- `require-session.ts`'s `onRequest` hook — the single guard protecting `/api/servers`,
  `/api/activity`, `/api/config` and `/api/events` — `await`s it unconditionally. A slow or hung
  session lookup (DB pool exhaustion, a wedged Better Auth query) hangs *every* guarded request
  indefinitely instead of failing closed with a bounded error.
- `events.ts`'s heartbeat (`setInterval(() => { void (async () => { ... await deps.getSession(...)
  ...})(); }, heartbeatMs)`) is worse: if a single `getSession` call outlives one `heartbeatMs`
  tick, the next tick fires anyway and starts a second, overlapping call on the same connection.
  For a long-lived SSE stream during exactly the kind of backend degradation `health.ts` is
  designed to report as `degraded`, this accumulates unbounded concurrent session lookups per open
  connection (up to `NOODARA_SSE_MAX_CONNECTIONS`, default 32, configurable to 1000) with no
  backpressure.

**Fix:** Bound both call sites the same way `health.ts`'s `withTimeout` already does elsewhere in
this phase:
```ts
async function getSessionWithTimeout(
  resolver: SessionResolver,
  headers: Headers,
  ms = 3000,
): ReturnType<SessionResolver> {
  return Promise.race([
    resolver(headers),
    new Promise<never>((_resolve, reject) => {
      setTimeout(() => { reject(new Error('session lookup timed out')); }, ms);
    }),
  ]);
}
```
Use it in `require-session.ts`'s `onRequest` hook (a timeout should fold into the existing 500
`INTERNAL_ERROR` catch branch) and in `events.ts`'s heartbeat (a timeout should fold into the
existing "treat as no session, close the stream" branch, exactly like a `getSession` throw already
does).

## Warnings

### WR-01: `classifyDiscoveryOutcome` discards `transition()`'s return value and re-literals the status by hand

**File:** `apps/control-plane/src/services/connect-and-discover.ts:191-207`
**Issue:** Every other status-changing branch in this phase's services (`edit-server.ts:217-229`,
`trust-fingerprint.ts:72-74`, `fail-in-flight-connection.ts:58`) assigns `transition(...)`'s
return value into the variable that is actually written to the row — this is the whole point of
"state transitions only via `packages/domain` `transition()`, never loose strings" (CLAUDE.md §4).
`classifyDiscoveryOutcome` calls `transition('CONNECTED', 'ERROR')` and `transition('CONNECTED',
'UNREACHABLE')` purely for their (currently coincidental) validation side effect, then returns a
hand-written `'ERROR'`/`'UNREACHABLE'` string literal instead of `transition()`'s actual result.
Today the two happen to agree, but the pattern is a live footgun: if `packages/domain`'s
`transition()` ever changes what it returns for this edge (e.g. adds a reason requirement, or
maps to a different terminal status), this file's hardcoded literal silently stops reflecting the
domain's actual decision, and nothing here would catch the drift.
**Fix:**
```ts
if (warnings.includes('COMMAND_TIMEOUT')) {
  const status = transition('CONNECTED', 'ERROR');
  return { status, lastErrorCode: 'COMMAND_TIMEOUT' };
}
if (snapshotOutcome === 'failed') {
  const status = transition('CONNECTED', 'UNREACHABLE');
  return { status, lastErrorCode: 'CONNECTION_LOST' };
}
```
(Adjust `DiscoveryStatusPatch`'s field type from the literal union to `ServerStatus` if needed, or
add a narrowing assertion right after the call — either is preferable to never calling through the
return value at all.)

### WR-02: `worker.ts`'s `shutdown()` has no error handling around `handle.close()`

**File:** `apps/control-plane/src/worker.ts:74-93`
**Issue:** `shutdown()` is invoked from `process.on('SIGTERM', () => void shutdown())` — any
rejection inside it becomes an unhandled promise rejection. `Promise.race([handle.close(), ...])`
rejects immediately if `handle.close()` rejects (a `Promise.race` settles on whichever promise
settles first, resolution or rejection), which skips `stopHeartbeat()`, `queue.close()`, every
`disconnect()` call, and the final `process.exit(0)`. A worker that fails to close its BullMQ
`Worker` cleanly (e.g. because Redis is already down) would hang instead of exiting, defeating the
whole point of a bounded shutdown race and leaving an orchestrator waiting past its own
termination grace period before it has to `SIGKILL`.
**Fix:** Wrap the race (or the whole function body) in try/catch and always run the cleanup steps:
```ts
async function shutdown(): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  try {
    await Promise.race([
      handle.close(),
      new Promise<void>((resolve) => { setTimeout(resolve, lockDurationMs); }),
    ]);
  } catch (err) {
    logger.warn({ err: err instanceof Error ? err.name : 'UnknownError' }, 'worker.close() failed during shutdown');
  } finally {
    stopHeartbeat();
    await queue.close().catch(() => undefined);
    workerConnection.disconnect();
    queueConnection.disconnect();
    publisherConnection.disconnect();
    process.exit(0);
  }
}
```

### WR-03: `canary-http.test.ts` waits for SSE fan-out with a fixed 500ms sleep instead of the polling helper this phase already established

**File:** `tests/integration/activity/canary-http.test.ts:252-256`
**Issue:** `events-sse.test.ts` and `api-e2e.test.ts` both introduce `waitForActiveSubscriber()`
specifically because "a *reachable-but-slow* Redis can genuinely take longer than [2s] to finish
the real `SUBSCRIBE`... A test that publishes before that real subscription lands would see its
message silently dropped." `canary-http.test.ts` runs `connectAndDiscover` directly against a
real Redis-backed publisher and then only does `await new Promise((resolve) => setTimeout(resolve,
500))` before asserting the SSE stream received the frames — under CI load (this same file's own
`describe` block already spins up an sshd Testcontainer plus a fresh Postgres/Redis pair), this is
exactly the flaky pattern the sibling tests were written to avoid.
**Fix:** Reuse (or import) `waitForActiveSubscriber` from `events-sse.test.ts`/`api-e2e.test.ts`
before publishing, instead of a fixed sleep after arranging the fixture.

## Info

### IN-01: `uniqueViolationConstraint` and its two constraint-name constants are duplicated verbatim

**File:** `apps/control-plane/src/services/register-server.ts:35-53`, `apps/control-plane/src/services/edit-server.ts:35-68`
**Issue:** Both files declare identical `NAME_UNIQUE_CONSTRAINT`/`HOST_PORT_UNIQUE_CONSTRAINT`
constants and an identical `uniqueViolationConstraint(error)` helper. A future index rename would
require updating both call sites in lockstep with no compiler help if one is missed.
**Fix:** Extract both the constants and the helper into a small shared module (e.g.
`services/db-errors.ts`) and import it from both files.

### IN-02: `getSession` resolver is redefined inline in two places instead of being built once

**File:** `apps/control-plane/src/routes/api-scope.ts:37-49`
**Issue:** `(headers) => auth.api.getSession({ headers })` is written out twice in the same
function — once for `createRequireSession`, once for `createEventsRoutes`. Harmless today, but a
future change to how the session resolver is built (e.g. adding the CR-03 timeout wrapper) has two
call sites to keep in sync instead of one.
**Fix:** Extract a single `const getSession: SessionResolver = (headers) => auth.api.getSession({ headers });` and pass it to both factories.

---

_Reviewed: 2026-09-18T16:16:46Z_
_Reviewer: Claude (gsd-code-reviewer)_
_Depth: standard_
