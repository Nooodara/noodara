---
phase: 04-http-routes-worker-bullmq-y-sse
plan: 06
subsystem: infra
tags: [bullmq, ioredis, zod, redis, queue, testcontainers]

requires:
  - phase: 04-http-routes-worker-bullmq-y-sse
    provides: "bullmq@6.3.6/ioredis@5.11.1 installed and provenance-verified, computeJobLockDurationMs, startRedis() Testcontainers fixture (04-01); ServiceActor (04-01/services)"
provides:
  - "ConnectServerJobPayloadSchema/parseConnectServerJobPayload (job-payload.ts) — the strict, never-throwing D-11 job contract both the future route (04-08) and worker (04-07) validate against"
  - "createQueueRedisConnection/createWorkerRedisConnection (redis/connections.ts) — the two distinct, easily-swapped-by-mistake ioredis settings D-27/D-28 require, injected by URL, no env import"
  - "createConnectServerQueue/ConnectServerQueue/QUEUE_NAME/CONNECT_SERVER_JOB_NAME/BULLMQ_PREFIX/jobIdForServer (connect-server-queue.ts) — the bounded, deduplicating, never-throwing queue producer port"
affects: [04-07, 04-08]

tech-stack:
  added: []
  patterns:
    - "Deterministic per-server jobId (D-09) uses a hyphen separator (connect-<serverId>), not the colon literally named in 04-CONTEXT.md — BullMQ 6.3.6's own Job.validateOptions rejects any custom jobId containing exactly one ':'"
    - "enqueue() wraps queue.add in a Promise.race against an explicit 2000ms timer on top of ioredis's own commandTimeout, converting every failure path into a fixed { ok: false, code: 'QUEUE_UNAVAILABLE' } result, never a thrown exception"
    - "Both Redis connection factories take an explicit url parameter and never import env.js, so tests point them at a Testcontainers Redis without booting the app's environment validation"

key-files:
  created:
    - apps/control-plane/src/queue/job-payload.ts
    - apps/control-plane/src/queue/job-payload.test.ts
    - apps/control-plane/src/redis/connections.ts
    - apps/control-plane/src/queue/connect-server-queue.ts
    - tests/integration/queue/connect-server-queue.test.ts
  modified:
    - package.json
    - pnpm-lock.yaml

key-decisions:
  - "jobIdForServer returns connect-<serverId> (hyphen), not connect:<serverId> (colon) as 04-CONTEXT.md's D-09 literally names — BullMQ 6.3.6's Job.validateOptions throws 'Custom Id cannot contain :' for any custom jobId with exactly one colon (a TODO-marked compatibility carve-out reserved for its own internal repeatable-job ids, split(':').length === 3). Verified against real bullmq@6.3.6 runtime behavior, not just its types. The deterministic-per-server dedupe contract (D-09's actual requirement) is unaffected by the separator character."
  - "bullmq promoted to a root devDependency at the same already-provenance-verified 6.3.6 pin, mirroring the identical ioredis/zod/drizzle-orm/@noodara-domain fix from 04-01/04-04 — pnpm's isolated node_modules never hoists a workspace package's own dependency to the root, and the new root-level integration test needs a raw bullmq.Queue to inspect job internals (opts, state) the port itself doesn't expose"
  - "ioredis's Redis class is imported as a named import (import { Redis } from 'ioredis'), not the default import used elsewhere in the codebase — under this project's verbatimModuleSyntax + nodenext ESM config, `import Redis from 'ioredis'` type-checks the value position as the whole CJS module namespace (no construct signature) even though it works at runtime; the named export is both the real class value and its own type from one import"
  - "console.warn (not the full pino-based createLogger) used for the two connection-error listeners, and only err.name is logged, never err.message — importing logger.ts would transitively import env.ts, and an ioredis connection error's message can echo back the REDIS_URL it failed against"

patterns-established:
  - "Every later plan importing connect-server-queue.ts's constants (QUEUE_NAME/CONNECT_SERVER_JOB_NAME/BULLMQ_PREFIX/jobIdForServer) gets the single source of truth for the servers queue's shape — no literal string should be repeated"

requirements-completed: []

duration: ~90min
completed: 2026-09-17
---

# Phase 4 Plan 6: Connect-server job payload contract and bounded queue producer Summary

**A strict, never-throwing D-11 job payload contract and a BullMQ queue producer whose `enqueue` dedupes by deterministic jobId, never blocks past ~2s and never throws — even with Redis stopped mid-test — proven against a real Testcontainers Redis.**

## Performance

- **Duration:** ~90 min
- **Started:** 2026-09-17T19:55:00Z (approx.)
- **Completed:** 2026-09-17T21:20:00Z (approx.)
- **Tasks:** 2
- **Files modified:** 7 (5 created, 2 modified)

## Accomplishments
- `apps/control-plane/src/queue/job-payload.ts`: `ConnectServerJobPayloadSchema` is a fully `.strict()` Zod object (`serverId: z.uuid()`, a `.strict()` discriminated-union `actor` matching every service's `ServiceActor` exactly — proven at compile time by a never-called type-check function, not just a comment, `requestedAt: z.iso.datetime()`, `trigger: z.enum(['connect', 'discover'])`), so an extra `privateKey`/`host`/`password` key on the payload fails to parse. `parseConnectServerJobPayload` never throws and names only failing field paths in its message, never the received value.
- `apps/control-plane/src/redis/connections.ts`: `createQueueRedisConnection` (`commandTimeout: 2000, maxRetriesPerRequest: 1`) and `createWorkerRedisConnection` (`maxRetriesPerRequest: null`, no `commandTimeout`) each take an explicit `url` and attach an `error` listener that logs only `err.name` at warn level and never rethrows.
- `apps/control-plane/src/queue/connect-server-queue.ts`: `createConnectServerQueue` wraps `queue.add` in a `Promise.race` against an explicit 2000ms timer, converting any rejection or timeout into a fixed `{ ok: false, code: 'QUEUE_UNAVAILABLE', message: 'Job queue is unavailable' }` — the message never carries the underlying ioredis/BullMQ error text. `isJobPending` returns `false` (never rejects) on any error, including a genuinely stopped Redis. Every job is created with `attempts: 1`, `removeOnComplete: { count: 100 }`, `removeOnFail: { count: 500 }`, `prefix: 'noodara'`.
- 9 new integration tests in `tests/integration/queue/connect-server-queue.test.ts` against real `redis:7-alpine` (Testcontainers) cover: fresh enqueue, dedupe of two concurrent enqueues for one server, re-enqueue after the prior job is removed, the exact job options, the `noodara:` key prefix on every key the queue creates, `isJobPending`'s true/false matrix, both Redis-stopped behaviors (`enqueue` and `isJobPending` resolving cleanly under 3s with no host/port leak), and a round-trip of the stored `job.data` through `parseConnectServerJobPayload`.

## Task Commits

Each task was committed atomically:

1. **Task 1: The connect-server job payload contract** - `28c823a` (feat, TDD RED verified before implementation)
2. **Task 2: Per-role Redis connections and the bounded, deduplicating queue producer** - `46d24ce` (feat, TDD RED verified before implementation)

_Note: RED was run and confirmed failing for the stated reason (missing module) before implementing GREEN for both tasks. For Task 2, the implementation files were briefly moved aside after an initial draft so the integration test's RED state could be verified honestly against the "module not found" reason, then restored for GREEN — see Deviations for the real bug RED verification surfaced._

## Files Created/Modified
- `apps/control-plane/src/queue/job-payload.ts` - `ConnectServerJobPayloadSchema`, `ConnectServerJobPayload`, `parseConnectServerJobPayload`
- `apps/control-plane/src/queue/job-payload.test.ts` - 15 unit tests covering the full behavior list including the strict-extra-key and never-throws requirements
- `apps/control-plane/src/redis/connections.ts` - `createQueueRedisConnection`, `createWorkerRedisConnection`
- `apps/control-plane/src/queue/connect-server-queue.ts` - `createConnectServerQueue`, `ConnectServerQueue`, `QUEUE_NAME`, `CONNECT_SERVER_JOB_NAME`, `BULLMQ_PREFIX`, `jobIdForServer`, `EnqueueResult`
- `tests/integration/queue/connect-server-queue.test.ts` - the 9-test producer proof against real Redis
- `package.json` / `pnpm-lock.yaml` - `bullmq@6.3.6` promoted to a root devDependency

## Decisions Made
- `jobIdForServer` uses `connect-<serverId>` instead of the `connect:<serverId>` literal named in 04-CONTEXT.md's D-09 — see Deviations below, this was a real bug the RED/GREEN cycle caught, not a stylistic choice.
- `ioredis`'s `Redis` class is imported by name (`import { Redis } from 'ioredis'`), not as the default export, because the project's `verbatimModuleSyntax` + `nodenext` ESM configuration makes the default-import binding type-check as the whole CJS module namespace (no construct signature) in `apps/control-plane`'s own `tsc` build, even though it works at runtime — this only surfaced because `connections.ts` is under `apps/control-plane/src` and therefore covered by its `tsc -p tsconfig.build.json`/`tsc --noEmit`, unlike the pre-existing `tests/integration/helpers/redis-fixture.test.ts` (04-01), which uses the default import but is never passed through a `tsc` project, only Vitest's esbuild transform.
- Connection-error logging uses a bare `console.warn` with only `err.name`, not the shared `createLogger`/pino setup — importing `logger.ts` would transitively import `env.ts` (INST-06 fail-fast) purely to log a warning, and an ioredis connection error's message can itself echo back the `REDIS_URL` it failed against (which may carry a password).

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] `jobIdForServer` cannot use `:` as the deterministic-jobId separator**
- **Found during:** Task 2, first GREEN run against real Testcontainers Redis
- **Issue:** 04-CONTEXT.md's D-09 and the plan's own interface block both name `connect:${serverId}` as the literal deterministic jobId. BullMQ 6.3.6's `Job.validateOptions` throws `Error: Custom Id cannot contain :` for any custom `jobId` containing exactly one `:` (its own source reserves that shape, `split(':').length === 3`, for internal repeatable-job ids, with a `// TODO: replace this check ... with include(':')` comment marking it for removal). Every single `enqueue` call was silently failing closed as `{ ok: false, code: 'QUEUE_UNAVAILABLE' }` — the queue's own never-throw contract (D-27) masked the real cause until traced with a standalone repro script calling `queue.add` directly.
- **Fix:** Changed `jobIdForServer` to return `connect-${serverId}` (hyphen). D-09's actual requirement — a deterministic id per server so BullMQ dedupes a second `add` while the first job is live — holds identically; only the separator character changed, and relying on BullMQ's undocumented, TODO-marked colon carve-out would have been fragile across a future BullMQ upgrade regardless.
- **Files modified:** `apps/control-plane/src/queue/connect-server-queue.ts`, `tests/integration/queue/connect-server-queue.test.ts`
- **Verification:** All 9 integration tests pass against real Redis; a standalone repro script confirmed the exact BullMQ error before the fix and its absence after.
- **Committed in:** `46d24ce` (Task 2 commit)

**2. [Rule 1 - Bug] `ioredis`'s default import is not constructable under this project's tsc config**
- **Found during:** Task 2, first `pnpm build` after writing `redis/connections.ts`
- **Issue:** `import Redis from 'ioredis'; new Redis(...)` — the pattern already used by `tests/integration/helpers/redis-fixture.test.ts` (04-01) — fails `apps/control-plane`'s own `tsc -p tsconfig.build.json` with `TS2351: This expression is not constructable`, because under `verbatimModuleSyntax` + `module`/`moduleResolution: nodenext` in an ESM package, the default-import binding for this CJS package resolves at the type level to the whole module namespace, not the class. Reproduced in isolation with a minimal `tsconfig.json` to confirm this is a real interaction of this exact compiler-option combination with `ioredis`'s type declarations, not a local typo.
- **Fix:** Imported the named `Redis` export instead (`import { Redis } from 'ioredis'`), which is both the class value and its own type from a single import, and used it for both the `new Redis(...)` constructions and the two functions' return-type annotations.
- **Files modified:** `apps/control-plane/src/redis/connections.ts`
- **Verification:** `pnpm --filter @noodara/control-plane build`/`typecheck`/`lint` all exit 0.
- **Committed in:** `46d24ce` (Task 2 commit)

**3. [Rule 3 - Blocking] Promoted `bullmq` to a root devDependency**
- **Found during:** Task 2 (writing `tests/integration/queue/connect-server-queue.test.ts`)
- **Issue:** The root-level integration test needs a raw `bullmq.Queue` (dynamically imported) to inspect job internals — `opts`, `getJobs`, `getState` — that `ConnectServerQueue`'s own port deliberately doesn't expose, but `bullmq` was only installed under `apps/control-plane`'s `dependencies`; pnpm's isolated `node_modules` never symlinks a workspace package's own dependency up to the root.
- **Fix:** Ran `pnpm add -D bullmq@6.3.6 -w` — the identical, already-provenance-verified exact pin from 04-01, not a new or unverified install.
- **Files modified:** `package.json`, `pnpm-lock.yaml`
- **Verification:** The integration test's `await import('bullmq')` resolves cleanly; `pnpm install --frozen-lockfile` still succeeds.
- **Committed in:** `46d24ce` (Task 2 commit)

---

**Total deviations:** 3 auto-fixed (2 bugs surfaced by RED/GREEN against a real dependency and this project's own strict tsc config, 1 blocking dependency-resolution fix mirroring an established precedent)
**Impact on plan:** No scope creep. Deviation 1 changes a literal character in an internal id format with zero effect on any documented behavior or external contract; deviations 2 and 3 are mechanical fixes required to make the plan's own instructed shape compile and test against a real dependency.

## Issues Encountered
None beyond the deviations above.

## User Setup Required

None - no external service configuration required.

## Next Phase Readiness
- `ConnectServerJobPayloadSchema`/`parseConnectServerJobPayload` are ready for Plan 04-07's worker to validate an incoming job's `job.data` and for Plan 04-08's route to build the payload it hands to `enqueue`.
- `createConnectServerQueue`/`ConnectServerQueue` are ready for Plan 04-08's route (a single `enqueue` call, `202` response) and Plan 04-07's worker startup sweep (`isJobPending` alongside `listConnectingServerIds` from 04-05).
- `createWorkerRedisConnection` is ready for Plan 04-07 to build its `Worker` instance; `createQueueRedisConnection`'s producer connection is ready for whichever composition root (app.ts) wires the real route.
- `jobIdForServer`'s hyphen separator (`connect-<serverId>`) is the actual, verified format every later plan referencing "the deterministic jobId" must use — 04-CONTEXT.md's colon literal does not hold against the real BullMQ dependency.
- Per STATE.md's existing note (from 04-01..04-05), SERV-06/DISC-05 are not marked complete from this plan alone — they land across the full 04-02..04-11 span and are re-verified at phase close.
- No blockers for the next plan in the wave.

---
*Phase: 04-http-routes-worker-bullmq-y-sse*
*Completed: 2026-09-17*

## Self-Check: PASSED

All 5 created files verified present on disk; both task commit hashes (`28c823a`, `46d24ce`) verified present in `git log`.
