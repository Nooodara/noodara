---
phase: 04-http-routes-worker-bullmq-y-sse
plan: 01
subsystem: infra
tags: [bullmq, ioredis, testcontainers, redis, env-validation, provenance]

requires:
  - phase: 03-servicios-de-aplicacion-activity-log-y-redaccion
    provides: ServerServicesDeps, connectAndDiscover, ServerView, activity-write boundary
provides:
  - bullmq@6.3.6, ioredis@5.11.1, @testcontainers/redis@12.1.0 installed and provenance-verified
  - NOODARA_WORKER_CONCURRENCY (default 5, 1-20) and NOODARA_SSE_MAX_CONNECTIONS (default 32, 1-1000) env knobs
  - computeJobLockDurationMs pure function implementing D-14's lock-budget formula
  - tests/integration/helpers/redis.ts (startRedis) for every later plan's integration tests
affects: [04-02, 04-03, 04-04, 04-05, 04-06, 04-07, 04-08, 04-09, 04-10, 04-11]

tech-stack:
  added: [bullmq@6.3.6, ioredis@5.11.1, "@testcontainers/redis@12.1.0"]
  patterns:
    - "Package provenance gate extended per-phase in scripts/check-package-provenance.mjs + ADR 0000, never bypassed"
    - "Pure lock-budget function with no env import, callable from both the worker and a future read-only API route"
    - "Testcontainers fixture shape mirrored 1:1 from postgres.ts (noodara.test=true label, idempotent stop())"

key-files:
  created:
    - apps/control-plane/src/queue/job-budget.ts
    - apps/control-plane/src/queue/job-budget.test.ts
    - tests/integration/helpers/redis.ts
    - tests/integration/helpers/redis-fixture.test.ts
  modified:
    - scripts/check-package-provenance.mjs
    - docs/adr/0000-package-legitimacy-approvals.md
    - apps/control-plane/package.json
    - package.json
    - pnpm-lock.yaml
    - apps/control-plane/src/env.ts
    - apps/control-plane/src/env.test.ts
    - .env.example
    - turbo.json
    - .github/workflows/ci.yml

key-decisions:
  - "ioredis pinned to 5.11.1, not the newly-released 6.0.0, per RESEARCH Pitfall 2/Open Question 1 (RESP3-by-default not validated against BullMQ's Lua reply parsing)"
  - "concurrently deliberately not installed; a second Turborepo dev:worker task will wire pnpm dev in Plan 04-07 instead"
  - "ioredis promoted to a root devDependency at the same 5.11.1 pin (same pnpm workspace-symlink fix already applied to drizzle-orm/@noodara/domain in Phase 1) so root-level tests/integration files can import it directly"

patterns-established:
  - "computeJobLockDurationMs(timeouts) never imports env.js — callers pass already-validated numbers, keeping it unit-testable and reusable by both worker.ts and a future GET /api/config"

requirements-completed: [SERV-06]

duration: 110min
completed: 2026-09-17
---

# Phase 4 Plan 1: BullMQ/Redis dependencies, tuning env knobs, job-lock budget, Redis fixture Summary

**Installed and provenance-verified bullmq/ioredis/@testcontainers-redis, added two fail-fast tuning env vars, a pure D-14 job-lock-budget function, and a Testcontainers Redis fixture every later Phase 4 plan can use.**

## Performance

- **Duration:** ~110 min
- **Started:** 2026-09-16T21:00:00-06:00 (approx.)
- **Completed:** 2026-09-16T22:51:09-06:00
- **Tasks:** 3
- **Files modified:** 15 (4 created, 11 modified)

## Accomplishments
- `bullmq@6.3.6`, `ioredis@5.11.1` and `@testcontainers/redis@12.1.0` installed at exact pins, each machine-verified against its registry `repository.url` via the extended `scripts/check-package-provenance.mjs`, with the verdict recorded in ADR 0000 (including the explicit `ioredis@6.0.0`-rejected and `concurrently`-not-installed notes).
- `NOODARA_WORKER_CONCURRENCY` (default 5, range 1-20, D-24) and `NOODARA_SSE_MAX_CONNECTIONS` (default 32, range 1-1000, D-07) validate fail-fast in `env.ts` using the existing `parseTuningInt` helper, wired into `turbo.json`'s `dev` `passThroughEnv` allowlist and documented in `.env.example`.
- `computeJobLockDurationMs` implements D-14's formula (`connectMs*2 + 2000 + discoveryMs + 30000`) as a pure, exhaustively unit-tested function with zero I/O and no `env.js` import.
- `tests/integration/helpers/redis.ts` gives every later plan a real, labelled, self-cleaning `redis:7-alpine` Testcontainers fixture, mirroring `postgres.ts`'s shape exactly.

## Task Commits

Each task was committed atomically:

1. **Task 1: Approve and install bullmq, ioredis and @testcontainers/redis through the provenance gate** - `eee202f` (feat)
2. **Task 2: NOODARA_WORKER_CONCURRENCY, NOODARA_SSE_MAX_CONNECTIONS and the pure job-lock budget** - `6557325` (feat, TDD RED verified before implementation)
3. **Task 3: Redis Testcontainers fixture and the CI note that covers it** - `f4249bb` (feat, TDD RED verified before implementation)

_Note: RED was verified in-session for Tasks 2 and 3 (tests run and confirmed failing for the right reason) before implementing; each task landed as a single commit per the noodara-tdd skill's "one commit per full cycle is acceptable" allowance._

## Files Created/Modified
- `scripts/check-package-provenance.mjs` - Added bullmq/ioredis/@testcontainers/redis to `EXPECTED_PACKAGES`
- `docs/adr/0000-package-legitimacy-approvals.md` - Recorded the Phase 4 provenance verdict, ioredis@6.0.0 rejection, concurrently non-install
- `apps/control-plane/package.json` / `package.json` / `pnpm-lock.yaml` - Exact-pinned bullmq/ioredis (control-plane) and @testcontainers/redis + ioredis (root dev)
- `apps/control-plane/src/env.ts` - Added `NOODARA_WORKER_CONCURRENCY` and `NOODARA_SSE_MAX_CONNECTIONS`
- `apps/control-plane/src/env.test.ts` - Table-driven default/boundary/out-of-range/non-integer cases for both new knobs
- `apps/control-plane/src/queue/job-budget.ts` - `computeJobLockDurationMs` pure function
- `apps/control-plane/src/queue/job-budget.test.ts` - Unit tests including the 112000 fixed-point and purity assertions
- `.env.example` / `turbo.json` - New knobs documented and pass-through allowlisted
- `tests/integration/helpers/redis.ts` - `startRedis()` Testcontainers fixture
- `tests/integration/helpers/redis-fixture.test.ts` - PING roundtrip, label presence (via container id), idempotent `stop()`, post-stop connection failure
- `.github/workflows/ci.yml` - Comments on `integration` and `boot-smoke` jobs noting Redis coverage via the fixture, no `services:` block

## Decisions Made
- `ioredis@5.11.1` pinned over the newly-released `6.0.0` (RESP3-by-default not yet validated against BullMQ 6.3.6's Lua reply parsing) — matches RESEARCH's own recommendation.
- `concurrently` not installed; deferred to Plan 04-07's two-Turborepo-task approach for `pnpm dev`.
- `ioredis` additionally promoted to a root devDependency (same exact 5.11.1 pin) so `tests/integration/helpers/redis-fixture.test.ts` can `import Redis from 'ioredis'` directly — pnpm's isolated `node_modules` does not hoist a workspace-scoped dependency (`apps/control-plane`'s) up to the root, the same issue Phase 1 solved for `drizzle-orm` and `@noodara/domain`.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 3 - Blocking] Promoted `ioredis` to a root devDependency**
- **Found during:** Task 3 (Redis Testcontainers fixture)
- **Issue:** `tests/integration/helpers/redis-fixture.test.ts` (a root-level test file) needs to `import Redis from 'ioredis'` to PING the fixture, but `ioredis` was only installed under `apps/control-plane`'s `dependencies` — pnpm's isolated `node_modules` never symlinks a workspace package's own dependency up to the workspace root, so the import failed with `Cannot find package 'ioredis'`.
- **Fix:** Ran `pnpm add -D ioredis@5.11.1 -w` — the same already-provenance-verified package and exact pin already approved in Task 1, not a new, unverified install. This is the identical fix Phase 1 applied to `drizzle-orm` and `@noodara/domain` for the same root-cause.
- **Files modified:** `package.json`, `pnpm-lock.yaml`
- **Verification:** `redis-fixture.test.ts`'s 4 tests pass; `pnpm install --frozen-lockfile` still succeeds.
- **Committed in:** `f4249bb` (Task 3 commit)

---

**Total deviations:** 1 auto-fixed (1 blocking)
**Impact on plan:** No scope creep — the promoted package was already installed and provenance-verified in the same plan's Task 1; only its resolution scope changed.

## Issues Encountered
None beyond the deviation above.

## User Setup Required

None - no external service configuration required.

## Next Phase Readiness
- `computeJobLockDurationMs`, `startRedis()`, and both new env knobs are ready for Plans 04-02 through 04-11 (queue producer/worker, SSE bridge, routes, worker entrypoint) to build on.
- `bullmq`/`ioredis` versions are locked; any future bump to `ioredis@6.x` should be its own isolated task once BullMQ's RESP3 compatibility has more soak time (RESEARCH Pitfall 2).
- No blockers for the next plan in the wave.

---
*Phase: 04-http-routes-worker-bullmq-y-sse*
*Completed: 2026-09-17*

## Self-Check: PASSED

All created files verified present on disk; all three task commit hashes (`eee202f`, `6557325`, `f4249bb`) verified present in `git log`.
