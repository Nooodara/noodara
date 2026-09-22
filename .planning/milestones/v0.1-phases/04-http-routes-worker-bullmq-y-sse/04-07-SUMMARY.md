---
phase: 04-http-routes-worker-bullmq-y-sse
plan: 07
subsystem: worker
tags: [bullmq, ioredis, worker-process, stalled-recovery, graceful-shutdown, heartbeat, testcontainers]

requires:
  - phase: 04-http-routes-worker-bullmq-y-sse
    provides: "computeJobLockDurationMs, startRedis() Testcontainers fixture, NOODARA_WORKER_CONCURRENCY (04-01); failInFlightConnection/listConnectingServerIds on ServerServices (04-05); createConnectServerQueue/jobIdForServer/createQueueRedisConnection/createWorkerRedisConnection/parseConnectServerJobPayload (04-06)"
provides:
  - "createWorker(deps, options) — the real BullMQ Worker for the servers queue: one handler for both connect/discover triggers (D-10), D-15's outcome policy (expected failure codes complete the job, only exceptions fail it), maxStalledCount: 0 plus a stalled listener that recovers via failInFlightConnection and never reconnects (D-12)"
  - "sweepAbandonedConnections(services, queue, logger) — the worker-startup half of D-12, callable independently of a running worker"
  - "startWorkerHeartbeat/workerHeartbeatKey/WORKER_HEARTBEAT_KEY_PREFIX (worker-heartbeat.ts) — the noodara:worker:<id> liveness key /health (04-10) will read"
  - "apps/control-plane/src/worker.ts — the second process entrypoint: env-first import, Postgres+Redis fail-fast, startup sweep, heartbeat, createWorker, graceful SIGTERM/SIGINT within the D-14 budget"
  - "pnpm dev now starts api+worker (turbo run dev dev:worker); pnpm start:worker runs the built worker; tests/integration/helpers/worker-fixture.ts for every later plan's worker-level integration tests"
affects: [04-08, 04-09, 04-10, 04-11]

tech-stack:
  added: []
  patterns:
    - "Job handler policy: parse payload -> INVALID_PAYLOAD (completed) on failure; connectAndDiscover's { ok:false, code } -> completed with { outcome: code }, logged at warn; only a genuine throw reaches BullMQ's failed event, logged with jobId+err only, never job.data"
    - "stalled listener uses BullMQ's own Job.fromId(worker, jobId) to re-read the job, never the narrow ConnectServerQueue port (which deliberately has no getJob) — parses the payload again and calls failInFlightConnection, wrapped end-to-end in try/catch"
    - "worker-fixture.ts starts one real in-process worker via the exact createWorker(deps, options) worker.ts uses, plus spawnWorker()/killPrimaryWorker() for the multi-worker stalled-recovery scenario, and setDbFailing() (a Proxy over deps.db swapping only .transaction) for the throwing-service test double"
    - "Root pnpm dev fans out to two Turborepo tasks (dev, dev:worker) with byte-identical passThroughEnv arrays, zero new devDependency — the concurrently alternative flagged in 04-01/RESEARCH was not needed"

key-files:
  created:
    - apps/control-plane/src/queue/worker-heartbeat.ts
    - apps/control-plane/src/queue/worker-heartbeat.test.ts
    - apps/control-plane/src/queue/connect-server-worker.ts
    - apps/control-plane/src/worker.ts
    - tests/integration/helpers/worker-fixture.ts
    - tests/integration/queue/connect-server-worker.test.ts
    - tests/integration/queue/stalled-recovery.test.ts
    - tests/integration/queue/startup-recovery.test.ts
  modified:
    - apps/control-plane/package.json
    - package.json
    - turbo.json
    - CLAUDE.md (gitignored — not tracked in git, updated locally only)
    - tests/integration/helpers/boot-process.ts
    - tests/integration/boot/boot-command.test.ts
    - tests/integration/services/helpers/service-fixture.ts

key-decisions:
  - "buildUnconfiguredSshPort exported from service-fixture.ts (was module-private) so worker-fixture.ts reuses the identical fail-loudly-by-default SshPort double instead of duplicating it, per this plan's own instruction"
  - "The stalled-recovery test simulates a worker crash with a hard Redis .disconnect() (never worker.close()), and recovery is driven by a second, independently spawned Worker sharing the same deps/queue — matching how a real second worker process would detect and act on the abandoned lock"
  - "createWorker's options.queue field (part of the plan's own produced interface) is accepted but not read internally — the stalled listener fetches the job via BullMQ's Job.fromId(worker, jobId) instead, since ConnectServerQueue's deliberately narrow port never exposes getJob"
  - "worker.ts pings the queue connection (bounded commandTimeout/maxRetriesPerRequest), never the worker connection (maxRetriesPerRequest: null, would hang indefinitely against a dead Redis) — the fail-fast check needs a connection that can actually fail fast"

patterns-established:
  - "Second Turborepo task (dev:worker) with a byte-for-byte copy of dev's passThroughEnv array is this project's answer to running two long-lived dev processes with zero new tooling dependency, matching 04-01's deferred concurrently decision"

requirements-completed: []

duration: ~55min
completed: 2026-09-17
---

# Phase 4 Plan 7: BullMQ worker — job handler, stalled recovery, startup sweep, worker entrypoint Summary

**A real BullMQ `Worker` runs `connectAndDiscover` off the API thread with a strict outcome policy (`failed` means bug-or-infrastructure only), a `maxStalledCount: 0` + `stalled`-listener pair proven empirically against real Redis to never reconnect over SSH, a startup sweep resolving abandoned `CONNECTING` rows, a 30s-TTL Redis heartbeat, and a second process entrypoint (`worker.ts`) wired into `pnpm dev`/`pnpm start:worker` and the boot smoke test.**

## Performance

- **Duration:** ~55 min
- **Started:** 2026-09-17T15:35:00-06:00 (approx.)
- **Completed:** 2026-09-17T16:27:56-06:00
- **Tasks:** 3
- **Files modified:** 15 (8 created, 7 modified)

## Accomplishments
- `apps/control-plane/src/queue/connect-server-worker.ts`: `createWorker(deps, options)` builds `createServerServices(deps)` once and a `Worker('servers', handler, { maxStalledCount: 0, ... })` whose handler treats an expected `{ ok: false, code }` result as a **completed** job (`{ outcome: code }`, logged at warn) and only a genuine exception as **failed** (logged with `jobId`+`err`, never `job.data`) — D-10's single handler serves both `connect` and `discover` triggers identically. The `stalled` listener re-reads the job via BullMQ's own `Job.fromId(worker, jobId)`, parses its payload, and calls `services.failInFlightConnection(...)` — never `connectAndDiscover` — wrapped end-to-end in try/catch. `sweepAbandonedConnections(services, queue, logger)` resolves every `CONNECTING` row with no live job at startup, independent of any running `Worker`.
- `apps/control-plane/src/queue/worker-heartbeat.ts`: `startWorkerHeartbeat` writes `noodara:worker:<id>` with `EX 30` immediately and every 10s (both defaults, both overridable), swallowing a Redis write failure into a `console.warn(err.name)` (never `err.message`, which could echo `REDIS_URL`) and returning a `stop()` that halts further writes.
- `apps/control-plane/src/worker.ts`: the second entrypoint — `import './env.js'` first, `getDb()`, a bounded `queueConnection.ping()` (never the worker connection, whose `maxRetriesPerRequest: null` would hang against a dead Redis), `resolveServerServicesDeps({ db, events: noopServerEventPublisher })` with a `TODO(04-09)` marking the real publisher's future arrival, one startup `sweepAbandonedConnections` call, `startWorkerHeartbeat`, `createWorker`, a `"Worker ready"` boot marker, and `SIGTERM`/`SIGINT` handlers racing `worker.close()` against the D-14 `lockDurationMs` budget before `process.exit(0)`.
- `pnpm dev` now runs `turbo run dev dev:worker` (api + worker together, zero new dependency — `turbo.json`'s `dev:worker` task is a byte-for-byte copy of `dev` except its command); `pnpm start:worker` / `apps/control-plane`'s `start:worker` run the built worker; `tests/integration/helpers/boot-process.ts`'s `buildValidBootEnv` now takes a real `redisUrl` instead of a hardcoded, mostly-unreachable placeholder, and `boot-command.test.ts` gained a `start:worker` boot+SIGTERM case plus a `Worker ready` wait in the turbo-driven regression test.
- `tests/integration/helpers/worker-fixture.ts`: composes `startPostgres()`+`startRedis()` with a resolved `ServerServicesDeps` and starts one real, in-process worker via the exact `createWorker(deps, options)` `worker.ts` uses; exposes `setSshPort`/`setEventPublisher`/`setDbFailing` (a `Proxy` swapping only `deps.db.transaction`) plus `killPrimaryWorker()`/`spawnWorker()` for the multi-worker stalled-recovery scenario.
- 25 new integration/unit tests across `worker-heartbeat.test.ts` (6), `connect-server-worker.test.ts` (6), `stalled-recovery.test.ts` (1), `startup-recovery.test.ts` (3), and the extended `boot-command.test.ts` (+1 case, 5 total) prove: a full connect job reaches `CONNECTED` with exactly 2 published `server.updated` events; `NOT_FOUND`/`ALREADY_CONNECTING` complete (never fail) the job; a throwing `deps.db` fails the job with a payload-free log record; a malformed `job.data` written directly into Redis completes as `INVALID_PAYLOAD` without crashing the worker or blocking later jobs; `trigger: 'connect'`/`'discover'` are provably identical code paths; a hard-crashed worker's in-flight job is recovered by a second worker to `ERROR`/`CONNECTION_LOST` with exactly one SSH `connect` call total; the startup sweep resolves/skips/no-ops correctly; and a real `node dist/worker.js` reaches `Worker ready` and exits cleanly on `SIGTERM`.

## Task Commits

Each task was committed atomically:

1. **Task 1: The job handler, its outcome policy and the liveness heartbeat** - `602ae1b` (feat)
2. **Task 2: Stalled recovery and the startup sweep, proven against a real killed worker** - `4397ac4` (test)
3. **Task 3: The worker entrypoint, its commands and the boot contract** - `7a9dec7` (feat)

_Note: For Task 1 and Task 2, each test file was authored and run against the not-yet-existing (or not-yet-correct) production module first, confirming a failure for the stated reason (missing export / job never resolving) before implementing GREEN; both tasks landed as one commit per the noodara-tdd skill's "one commit per full cycle is acceptable" allowance. Task 3 is a wiring/entrypoint task (`type="auto"`, no `tdd="true"`), verified end-to-end against real Postgres+Redis via the extended boot smoke suite instead._

## Measured, not assumed (RESEARCH Assumption A3 / Open Question 2)

**BullMQ version:** `bullmq@6.3.6` (the exact pin already installed in Plan 04-01), against `ioredis@5.11.1`.

**Configuration used:** `maxStalledCount: 0` on the `Worker` options, plus a `worker.on('stalled', ...)` listener calling `failInFlightConnection` — the "safer combination" RESEARCH recommended implementing, rather than relying on either mechanism alone.

**Test conditions:** `lockDurationMs: 1500`, `stalledIntervalMs: 500` (both worker instances configured identically); an `SshPort.connect` that never resolves nor rejects (simulating a worker stuck mid-SSH-session); the "crash" simulated by hard-disconnecting the primary worker's Redis connection (`.disconnect()`, never a graceful `worker.close()`).

**Observed sequence:** the primary worker's job reached `active` and called `connect` exactly once; after the hard disconnect, the *second* worker's own periodic stalled-check (driven by its `stalledIntervalMs`) detected the abandoned lock, fired its `stalled` listener, and that listener's `failInFlightConnection` call transitioned the row to `ERROR`/`CONNECTION_LOST` — with **no second `connect` call ever recorded** (`hangingSsh.callCount()` stayed at `1` for the whole sequence) and **no `failed` event** ever fired for that job. The suite passed on the first implementation attempt and was re-run three consecutive times with no flake.

**Conclusion:** RESEARCH's Assumption A3 holds as stated for this exact version pair and configuration: `maxStalledCount: 0` plus a `stalled` listener is sufficient on its own — BullMQ never moved the job back to `waiting` for a second worker to (re-)process through the normal job handler; the `stalled` event was the only signal the second worker needed. Open Question 2's alternative (deriving recovery from the `failed` event) was not needed and was not implemented.

## Files Created/Modified
- `apps/control-plane/src/queue/worker-heartbeat.ts` - `startWorkerHeartbeat`, `workerHeartbeatKey`, `WORKER_HEARTBEAT_KEY_PREFIX`
- `apps/control-plane/src/queue/worker-heartbeat.test.ts` - 6 unit tests (immediate write, interval refresh, custom TTL, stop halts writes, rejecting Redis logs a warning without leaking the message)
- `apps/control-plane/src/queue/connect-server-worker.ts` - `createWorker`, `sweepAbandonedConnections`, `ConnectServerWorkerHandle`
- `apps/control-plane/src/worker.ts` - the second process entrypoint
- `tests/integration/helpers/worker-fixture.ts` - `startWorkerFixture` (composes Postgres+Redis+deps+one real worker; `spawnWorker`/`killPrimaryWorker`/`setDbFailing`)
- `tests/integration/queue/connect-server-worker.test.ts` - 6 integration tests for the job handler's outcome policy
- `tests/integration/queue/stalled-recovery.test.ts` - the empirical stalled-recovery proof
- `tests/integration/queue/startup-recovery.test.ts` - 3 integration tests for `sweepAbandonedConnections`
- `apps/control-plane/package.json` / `package.json` / `turbo.json` - `dev:worker`/`start:worker` scripts and task
- `tests/integration/helpers/boot-process.ts` - `buildValidBootEnv(connectionString, redisUrl)`
- `tests/integration/boot/boot-command.test.ts` - new `start:worker` case; real Redis fixture in every case touching root `pnpm dev`
- `tests/integration/services/helpers/service-fixture.ts` - exported `buildUnconfiguredSshPort` (was private)
- `CLAUDE.md` - `pnpm start:worker` documented in §3.2 (gitignored; edited on disk only, never committed)

## Decisions Made
- See `key-decisions` in the frontmatter above — none required Rule 4 (no architectural change was needed; the plan's own design worked as specified once the empirical BullMQ gate was checked).

## Deviations from Plan

None - plan executed exactly as written. The one open empirical question the plan itself flagged (RESEARCH Assumption A3 / Open Question 2) was resolved by the stalled-recovery test passing on the first implementation attempt with the exact `maxStalledCount: 0` + `stalled`-listener design already specified in the plan's own Task 1/Task 2 instructions — no fallback mechanism was needed.

## Issues Encountered
None.

## User Setup Required

None - no external service configuration required.

## Next Phase Readiness
- `createWorker`/`sweepAbandonedConnections`/`ConnectServerWorkerHandle` are ready for `worker.ts` (already wired) and for Plan 04-09's Redis-backed `ServerEventPublisher` to slot into `resolveServerServicesDeps({ db, events: <redis publisher> })` in place of the `TODO(04-09)`-marked `noopServerEventPublisher` — no other change to `worker.ts` is needed.
- `startWorkerHeartbeat`/`WORKER_HEARTBEAT_KEY_PREFIX`/`workerHeartbeatKey` are ready for Plan 04-10's `/health` route to scan and report `checks.worker`.
- `tests/integration/helpers/worker-fixture.ts` is ready for any later plan needing a real, in-process worker in an integration test.
- Per STATE.md's existing note (from 04-01..04-06), SERV-06/DISC-05 are not marked complete from this plan alone — they land across the full 04-02..04-11 span and are re-verified at phase close (per this plan's own orchestrator instruction).
- No blockers for the next plan in the wave.

---
*Phase: 04-http-routes-worker-bullmq-y-sse*
*Completed: 2026-09-17*

## Self-Check: PASSED

All 8 created files verified present on disk; all three task commit hashes (`602ae1b`, `4397ac4`, `7a9dec7`) verified present in `git log`.
