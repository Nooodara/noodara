---
phase: 04-http-routes-worker-bullmq-y-sse
plan: 11
subsystem: api
tags: [e2e, sse, bullmq, security-canary, boot-smoke, validation, d-09, d-22, d-26]

requires:
  - phase: 04-http-routes-worker-bullmq-y-sse
    provides: "Every plan in this phase (04-01..04-10): worker entrypoint + createWorker (04-07), the eight /api/servers routes + enqueueConnect (04-08), the SSE bridge (04-09), activity/config/health (04-10)"
provides:
  - "tests/integration/routes/api-e2e.test.ts — the phase's single, literal proof of roadmap criteria 1-3 and DISC-05 together: real sshd, real Redis, a real in-process BullMQ worker, and a real HTTP socket for the SSE stream"
  - "tests/integration/activity/canary-http.test.ts — D-22's HTTP/SSE extension of security:scan-leaks, verified able to fail via a deliberate local break"
  - "A real, previously-latent DISC-05 defect fixed: connect-server-queue.ts's enqueue() now clears a genuinely terminal (completed/failed) job before re-adding under the same deterministic jobId, so a second /connect or /discover after the first job ever finished actually re-enqueues instead of silently no-opping"
  - "The closed .planning/phases/04-http-routes-worker-bullmq-y-sse/04-VALIDATION.md — every row's Status measured from a real command run at phase close, nyquist_compliant/wave_0_complete/status all true"
  - "A two-process boot-smoke case (boot-command.test.ts) proving /health's checks.worker transitions pass -> degraded/fail as the real worker process lives then dies"
affects: [05, 06]

tech-stack:
  added: []
  patterns:
    - "api-e2e.test.ts drives every request through a real app.listen({ port: 0 }) socket with a real fetch() client (not app.inject()) for the whole flow, not just the SSE stream — once a real listener exists there is no reason to mix injection and real HTTP in the same proof"
    - "canary-http.test.ts produces a genuine discovery_snapshots row without a real sshd container by calling connectAndDiscover directly (service layer) with buildFakeSshPort/buildFakeSshSession({}) over the same Postgres row and a real Redis-backed event publisher on the app's own channel — the discoverySnapshots.payload leak-check is a real scan, not a vacuously-empty one"
    - "A canary-registering route in tests must be registered before the fixture's first app.inject()/app.ready() call — Fastify refuses new route registration once an instance has started listening/become ready; a route whose handler closes over not-yet-assigned let bindings is the correct shape when the canary values themselves aren't known until after admin setup/sign-in"

key-files:
  created:
    - tests/integration/routes/api-e2e.test.ts
    - tests/integration/activity/canary-http.test.ts
  modified:
    - apps/control-plane/src/queue/connect-server-queue.ts
    - tests/integration/queue/connect-server-queue.test.ts
    - tests/integration/boot/boot-command.test.ts
    - package.json
    - .github/workflows/ci.yml
    - CLAUDE.md (gitignored — not tracked in git, updated locally only)
    - .planning/phases/04-http-routes-worker-bullmq-y-sse/04-VALIDATION.md

key-decisions:
  - "BullMQ's own add() treats any existing job hash under a jobId — including one already completed/failed and only still present because removeOnComplete/removeOnFail's count-based retention hasn't swept it — as a duplicate, silently returning the stale job reference without creating a new 'waiting' entry (bullmq's addStandardJob Lua script, handleDuplicatedJob). This directly broke DISC-05: every /connect or /discover issued after a server's very first job ever completed would 202 with a jobId the worker never touched again. Fixed by clearing a genuinely terminal job before add() only when its state is outside PENDING_JOB_STATES, leaving true in-flight dedupe (a real double-click) untouched."
  - "canary-http.test.ts registers its own throwaway /__canary/http-throw route immediately after startTestApp(), before createAdmin()/signIn()'s first app.inject() calls — Fastify's ready-once route-registration lock would otherwise reject a route added after the SSE stream (or even the setup call) already forced app.ready()"
  - "The pre-existing 'start: real boot against a migrated database' boot-command.test.ts case asserted /health status: 'ok' with no worker process ever running — stale since Plan 04-10 made a missing worker heartbeat legitimately report 'degraded'/checks.worker: 'fail' (D-26, still 200). Updated the assertion to the correct, honest expectation rather than treating it as unrelated noise, since it now fails every real pnpm test:boot run."
  - "The 27-row Per-Task Verification Map's Status column is filled from an actual, single full-suite run at phase close (pnpm test, pnpm test:integration, pnpm lint, pnpm typecheck, pnpm boundaries, pnpm audit --audit-level=high, pnpm security:scan-leaks, pnpm build && pnpm test:boot) rather than inferred from each plan's own SUMMARY self-check — one file (tests/integration/routes/events-sse.test.ts, Plan 04-09's own pre-documented flake) is marked flaky, not green, because it measurably failed 1-3 of 10 sub-tests across three separate runs during this close."

patterns-established:
  - "A phase-closing plan that adds a real, multi-process E2E test should expect to find integration bugs no single earlier plan's narrower test surface could catch (here: jobId reuse after natural completion) — fix them in the file that owns the defect, not in the new test, and record the fix as a plan deviation."

requirements-completed: [DISC-05]

duration: ~170min
completed: 2026-09-18
---

# Phase 4 Plan 11: End-to-end proof, HTTP/SSE leak canary, two-process boot smoke, and the closed validation contract Summary

**One real-sshd/real-Redis/real-worker/real-socket flow proves roadmap criteria 1-4 and DISC-05 together — and in doing so found and fixed a genuine BullMQ jobId-reuse bug that silently broke every re-discover after a server's first connect ever completed; the leak canary now covers HTTP bodies and SSE frames with a verified-fallible non-vacuity proof; `/health` is proven to distinguish a live worker from a dead one across two real processes; and `04-VALIDATION.md` closes with every status measured from a real command run.**

## Performance

- **Duration:** ~170 min
- **Started:** 2026-09-18T00:35:00-06:00 (approx.)
- **Completed:** 2026-09-18T03:25:00-06:00 (approx.)
- **Tasks:** 3
- **Files modified:** 9 (2 created, 7 modified, 1 of which — CLAUDE.md — is gitignored)

## Accomplishments

- `tests/integration/routes/api-e2e.test.ts`: a single ordered flow against a real Ubuntu 24.04 sshd container, a real Redis, a real in-process BullMQ worker (mirroring `worker.ts`'s exact production wiring), and a real `app.listen({ port: 0 })` socket read with `fetch()` — never `app.inject()`. Proves: `POST /connect` answers `202` in under 1 second (measured, roadmap criterion 1); the SSE client — already open before the connect — observes `CONNECTING` then a terminal status with zero intervening `GET` (criterion 2); `GET /api/servers/:id` shows real discovered `hostname`/`osDistribution`/`arch`; `POST /discover` on the now-`CONNECTED` server re-runs the same worker path and a second `discovery_snapshots` row exists (criterion 3, DISC-05); a pre-`CONNECTED` `/discover` is `409 SERVER_NOT_CONNECTED`; `GET /api/activity` lists `server.created`/`server.connection_attempted`/`server.discovery_completed` newest-first; `DELETE` streams `server.deleted`; and a final `GET /health` is `200` (criterion 4, the API never crashed).
- **A real, previously-undiscovered DISC-05 defect, found and fixed**: `connect-server-queue.ts`'s `enqueue()` now looks up any existing job under the deterministic `jobId` and removes it first if its state is outside `waiting`/`active`/`delayed` before calling `queue.add(...)`. Without this, BullMQ's own duplicate-jobId handling silently returned the stale, already-`completed` job reference instead of creating a new one — meaning every `/connect` or `/discover` issued after a server's very first job ever finished would answer `202` with a `jobId` the worker would never touch again. Caught only because `api-e2e.test.ts` is the first test in this phase to trigger `/discover` *after* letting a real worker actually complete the prior job (every earlier route test dedupes against a still-`waiting` job, never a `completed` one).
- `tests/integration/activity/canary-http.test.ts`: extends `security:scan-leaks` to this phase's new surfaces — a per-run password canary (`POST /api/servers`) and private-key-passphrase canary (`PATCH /api/servers/:id`, a genuinely `ssh-keygen`-locked ed25519 key) scanned across success bodies, a 4xx (duplicate name) and a forced 500 on a live route (through the real, production `app.setErrorHandler` — no test-local handler), `GET /api/events` SSE frames, captured logs, `activity_events.metadata`, and a genuine `discovery_snapshots.payload` row produced by calling `connectAndDiscover` directly with a fake `SshPort` over the same Postgres row and a real Redis-backed publisher. Verified fallible: a deliberate local removal of the redactor-registration calls made the password canary appear unredacted in the captured log output; reverted immediately after confirming the failure.
- `package.json`'s `security:scan-leaks` now runs all three canary suites; `.github/workflows/ci.yml`'s `security` job comment documents the three-suite scope.
- `tests/integration/boot/boot-command.test.ts` gains a two-process case: `node dist/server.js` and `node dist/worker.js` spawned together against one Postgres and one Redis, `/health` answering `200 { status: 'ok', checks: { worker: 'pass' } }` while the worker lives, then `200 { status: 'degraded', checks: { worker: 'fail' } }` once it is killed and its real, undoctored 30-second heartbeat TTL genuinely expires — no production env knob was added purely for this test. The API is proven to keep answering the whole time (T-4-41/T-4-44). A pre-existing case in the same file (`start: real boot against a migrated database`) had a stale assertion — it expected `/health` `status: 'ok'` with no worker ever running, which Plan 04-10's real worker-heartbeat check correctly reports as `degraded`/`checks.worker: 'fail'` — fixed to the honest expectation.
- `.planning/phases/04-http-routes-worker-bullmq-y-sse/04-VALIDATION.md`: every row of the 33-row Per-Task Verification Map now carries a real status measured during this close (a single `pnpm test` + `pnpm test:integration` + `pnpm lint`/`typecheck`/`boundaries`/`audit`/`security:scan-leaks`/`build && test:boot` pass, not an inference from each plan's own SUMMARY), Wave 0 Requirements and Validation Sign-Off boxes are ticked only where genuinely true, and the frontmatter's `status: complete`/`wave_0_complete: true`/`nyquist_compliant: true` reflect that. One row (`04-09-03`, `events-sse.test.ts`) is marked `⚠️ flaky`, not green — see Deviations below.

## Task Commits

Each task was committed atomically:

1. **Task 1: The full API flow against a real sshd, watched over SSE** — `bc76db4` (test, includes the `connect-server-queue.ts` production fix the E2E test's own RED run surfaced)
2. **Task 2: Extend the leak canary to HTTP responses and SSE frames** — `6922d2b` (test)
3. **Task 3: Two-process boot smoke, CI coverage and the closed validation contract** — `be89d2d` (test)

_Note: type="auto" tasks (no `tdd="true"` in this plan's own frontmatter), verified end-to-end against real infrastructure per task rather than a RED/GREEN unit cycle — matching this phase's own precedent for wiring/proof tasks (e.g. Plan 04-07 Task 3, Plan 04-09 Task 3). Task 1's own RED-equivalent (first honest run against unmodified production code) genuinely failed for a real reason (the BullMQ jobId-reuse bug), was diagnosed to its root cause in `bullmq`'s own Lua source, fixed with its own RED/GREEN regression test in `connect-server-queue.test.ts`, then the full E2E flow was re-run green — the closest this plan's wiring/proof tasks come to the TDD cycle the rest of this phase followed for logic-bearing units._

## Files Created/Modified
- `tests/integration/routes/api-e2e.test.ts` - the phase's headline end-to-end proof
- `apps/control-plane/src/queue/connect-server-queue.ts` - `addFreshJob` clears a terminal job before re-adding under the same jobId
- `tests/integration/queue/connect-server-queue.test.ts` - regression test for the completed-job-reuse fix
- `tests/integration/activity/canary-http.test.ts` - the D-22 HTTP/SSE leak canary
- `package.json` - `security:scan-leaks` runs three files
- `.github/workflows/ci.yml` - `security` and `boot-smoke` job comments updated
- `tests/integration/boot/boot-command.test.ts` - two-process case; fixed the stale single-process `/health` assertion
- `CLAUDE.md` - `pnpm boundaries`/`pnpm security:scan-leaks` documented in §3.2 (gitignored; edited on disk only, never committed)
- `.planning/phases/04-http-routes-worker-bullmq-y-sse/04-VALIDATION.md` - closed with measured statuses

## Decisions Made
See `key-decisions` in the frontmatter above. The most consequential: BullMQ's `add()` silently treats a completed job's still-present hash as a duplicate and returns it without creating a new `waiting` entry — this is a real, load-bearing production bug fix (Rule 1), not a test artifact, and it is the reason DISC-05 could not have been honestly marked complete before this plan.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] `connect-server-queue.ts`'s `enqueue()` silently no-ops after the previous job for a server has completed**
- **Found during:** Task 1, first honest run of `api-e2e.test.ts` against unmodified production code
- **Issue:** `api-e2e.test.ts`'s second `POST .../discover` call (issued after the worker had already completed the first `/connect` job) hung waiting for SSE frames that never arrived. Traced to `bullmq@6.3.6`'s `addStandardJob-9.lua`: `if rcall("EXISTS", jobIdKey) == 1 then return handleDuplicatedJob(...)` — any existing job hash under a `jobId`, including a `completed` one kept around by `removeOnComplete: { count: 100 }`, is treated as a duplicate. `queue.add()` resolved successfully with the stale job's id, but no new `waiting` entry was ever created, so the worker never ran anything.
- **Fix:** `enqueue()` now checks the existing job's state via `queue.getJob(jobId)`/`.getState()` and calls `.remove()` on it first, but only when that state is outside `PENDING_JOB_STATES` (`waiting`/`active`/`delayed`) — a genuine in-flight duplicate (a real double-click) is left untouched, preserving D-09's existing dedupe behavior exactly.
- **Files modified:** `apps/control-plane/src/queue/connect-server-queue.ts`, `tests/integration/queue/connect-server-queue.test.ts` (new regression test proving a fresh enqueue succeeds after a real worker-driven completion, not just a manual `job.remove()`)
- **Verification:** `pnpm exec vitest run --config vitest.integration.config.ts tests/integration/queue/connect-server-queue.test.ts` (10/10, including the new test, confirmed RED against the un-fixed code first); `api-e2e.test.ts`'s full flow then passed end to end.
- **Committed in:** `bc76db4` (Task 1 commit)

**2. [Rule 1 - Bug] `boot-command.test.ts`'s single-process `/health` assertion was stale against Plan 04-10's real worker-heartbeat check**
- **Found during:** Task 3, first `pnpm build && pnpm test:boot` run of the full file
- **Issue:** `start: real boot against a migrated database` boots only the API (no worker process), so `/health`'s `checks.worker` genuinely has no heartbeat key to find — Plan 04-10 correctly made this `degraded`/`checks.worker: 'fail'` (still `200`), but this pre-existing test still asserted the pre-04-10 literal `status: 'ok'`.
- **Fix:** Updated the assertion to `status: 'degraded'`, `checks.postgres: 'pass'`, `checks.worker: 'fail'` — the honest, D-26-correct expectation for an API-only boot, not a workaround.
- **Files modified:** `tests/integration/boot/boot-command.test.ts`
- **Verification:** `pnpm build && pnpm test:boot` (6/6 green, including this fixed case and the new two-process case).
- **Committed in:** `be89d2d` (Task 3 commit)

---

**Total deviations:** 2 auto-fixed (both Rule 1 bugs; the first is the plan's own headline finding, the second is a stale-assertion drift from an earlier plan's legitimate behavior change)
**Impact on plan:** No scope creep. Both fixes were required for the plan's own instructed verification commands (`api-e2e.test.ts`'s full flow; `pnpm build && pnpm test:boot`) to actually pass, and both are documented here per the plan's own "fix it there and record it in this plan's SUMMARY rather than patching around it in the test" instruction.

## Known Stubs

None — this plan adds no production UI or placeholder data paths; every assertion is against real, measured behavior.

## Issues Encountered

- **`tests/integration/routes/events-sse.test.ts` (Plan 04-09) — pre-existing, already-documented machine-specific flake, reconfirmed during this close's full-suite run and two isolated re-runs (1/10, then 2/10, then 3/10 sub-tests failing on `waitForActiveSubscriber`'s 20s poll across three separate runs).** This is the exact issue Plan 04-09's own SUMMARY already investigated exhaustively and attributed to this shared dev machine's Docker/network behavior (a standalone, non-Vitest reproduction script succeeded deterministically every time; `Redis CLIENT LIST` showed a foreign, non-Docker IP sharing the container's mapped port during one failure). Not touched by this plan's changes, not a regression, and not a code defect — recorded in `04-VALIDATION.md`'s `04-09-03` row as `⚠️ flaky` (not `✅ green`) rather than glossed over, and carried forward in STATE.md's Blockers/Concerns for re-verification on a clean machine or CI.
- No other issues. `pnpm test` (865/865), the rest of `pnpm test:integration` (467/469 excluding the flaky file), `pnpm lint`/`pnpm typecheck`/`pnpm boundaries` (clean), `pnpm audit --audit-level=high` (exits 0; 1 moderate advisory, below the `--audit-level=high` threshold), `pnpm security:scan-leaks` (3/3), and `pnpm build && pnpm test:boot` (6/6) all passed during this close.

## User Setup Required

None - no external service configuration required.

## Next Phase Readiness

- Phase 4's own success criteria (roadmap criteria 1-4) and both of its requirements (SERV-06, DISC-05) are now proven end to end by a single real-infrastructure test, not assembled from narrower per-plan proofs alone. `requirements.mark-complete` was run for `SERV-06` (already complete, confirmed) and `DISC-05` (newly marked complete) — both backed by `api-e2e.test.ts`'s passing assertions, not a frontmatter artifact.
- Phase 5's UI can build against every contract this phase's plans already documented as ready (routes, `ServerView`, `/api/events`, `/api/activity`, `/api/config`) with the added confidence that the connect -> SSE -> re-discover round trip has been proven against real sshd, real Redis and a real worker at least once, and that a real BullMQ dedupe pitfall (jobId reuse after completion) is now closed rather than latent.
- Phase 6's Compose healthchecks/restart policy can key on `GET /health`'s `checks.worker` exactly as proven here: `pass` while the worker container is alive, `degraded`/`fail` (still `200`, never restarting the API) once it dies and its heartbeat TTL expires.
- One known, machine-specific flake (`events-sse.test.ts`, pre-existing from Plan 04-09) is carried forward in `04-VALIDATION.md` and STATE.md's Blockers/Concerns, explicitly not marked green — does not block phase closure per the phase's own `noodara-tdd`/`noodara-release-gate` skills, which distinguish a genuinely investigated, reproducible-elsewhere environmental flake from an unverified claim.
- No blockers for Phase 5.

---
*Phase: 04-http-routes-worker-bullmq-y-sse*
*Completed: 2026-09-18*

## Self-Check: PASSED

Both created files (`tests/integration/routes/api-e2e.test.ts`, `tests/integration/activity/canary-http.test.ts`) verified present on disk; all three task commit hashes (`bc76db4`, `6922d2b`, `be89d2d`) verified present in `git log`.
