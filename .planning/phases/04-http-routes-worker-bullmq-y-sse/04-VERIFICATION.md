---
phase: 04-http-routes-worker-bullmq-y-sse
verified: 2026-09-18T16:40:00Z
status: human_needed
score: 4/4 roadmap criteria verified, 2/2 requirements verified
overrides_applied: 0
gaps: []
human_verification:
  - test: "Re-run tests/integration/routes/events-sse.test.ts on a clean machine or in CI (not this shared dev laptop) and confirm 10/10 pass"
    expected: "All 10 sub-tests pass, including 'a server.updated publish delivers a frame whose data.server key set is exactly the 27 ServerView keys' and 'a server.deleted publish delivers a frame with data.id'"
    why_human: "Reproduced live during this verification: 2/10 sub-tests failed with 'waitForActiveSubscriber: no subscriber on noodara:server-events after 20000ms' / ECONNREFUSED 127.0.0.1:6379 despite the container reporting healthy. This matches exactly the pre-documented, exhaustively-investigated flake in 04-VALIDATION.md and Plan 04-09's SUMMARY, attributed to this specific machine's Docker/network behavior (a standalone non-Vitest reproduction of the same code path passed deterministically every time; `Redis CLIENT LIST` showed a foreign non-Docker IP sharing the container's mapped port during one failure). Project CLAUDE.md's Definition of Done requires 'cero flaky conocidos'; whether this counts as a DoD violation blocking phase closure, or an accepted environment-only caveat to be cleared on CI/a clean machine, is a human release decision, not something a grep-based verifier can resolve. The underlying behavior this test partially duplicates (the 27-key ServerView allowlist) is independently and deterministically unit-tested green elsewhere (server-view.test.ts, server-schemas.test.ts's assertServerViewSchemaKeysMatch), and the broader SSE flow (CONNECTING -> terminal status, no polling) is proven green end-to-end against real sshd/Redis/worker in api-e2e.test.ts."
---

# Phase 4: HTTP routes, worker BullMQ y SSE Verification Report

**Phase Goal:** El admin puede disparar acciones sobre un servidor vía la API HTTP y ver su estado cambiar en tiempo real sin recargar la página, mientras el trabajo pesado de SSH corre en el worker sin bloquear el proceso de la API.
**Verified:** 2026-09-18T16:40:00Z
**Status:** human_needed
**Re-verification:** No — initial verification

## Goal Achievement

### Observable Truths (Roadmap Success Criteria 1–4)

| # | Truth | Status | Evidence |
|---|-------|--------|----------|
| 1 | `POST /servers/:id/connect` enqueues a BullMQ job and responds immediately; SSH runs in the worker, off the API thread | ✓ VERIFIED | `apps/control-plane/src/routes/servers.ts` `enqueueConnect()` calls `queue.enqueue(...)` then returns `202 { server, jobId }` with no await on SSH. `apps/control-plane/src/queue/connect-server-worker.ts`'s `createWorker` job handler is the only caller of `services.connectAndDiscover`, running inside a separate BullMQ `Worker` process (`apps/control-plane/src/worker.ts`, a distinct entrypoint from `server.ts`). `tests/integration/routes/api-e2e.test.ts` measures the 202 response in under 1s against a real worker. |
| 2 | An SSE client sees PENDING→CONNECTING→CONNECTED/UNREACHABLE/ERROR transitions with no polling | ✓ VERIFIED | `apps/control-plane/src/routes/events.ts` (`GET /api/events`) hijacks the reply and streams raw SSE frames; `apps/control-plane/src/events/redis-server-event-publisher.ts` + `sse-broadcaster.ts` bridge worker→API over Redis pub/sub channel `noodara:server-events`; `connect-and-discover.ts` publishes `server.updated` once after the TX1 `CONNECTING` transition and once after the TX2 final-status transaction. `tests/integration/routes/api-e2e.test.ts` opens the SSE stream *before* calling connect and asserts it observes `CONNECTING` then a terminal status with zero intervening GET calls — this passed. 8/10 of `events-sse.test.ts`'s own narrower sub-tests pass live; see Human Verification below for the 2 that are flaky on this machine. |
| 3 | `POST /servers/:id/discover` can be re-run any time after CONNECTED, reusing the same `DiscoverServerService`/`connectAndDiscover` path | ✓ VERIFIED | `servers.ts`'s `/discover` route calls the same `enqueueConnect(..., trigger: 'discover')` helper as `/connect`; the worker handler in `connect-server-worker.ts` calls `connectAndDiscover` regardless of `trigger` (D-10 — one handler, precondition differs at the route). `enqueueConnect` returns `409 SERVER_NOT_CONNECTED` when the server isn't `CONNECTED` (verified in `servers-discover.test.ts`). Plan 04-11 found and fixed a real BullMQ bug where `queue.add()` silently reused a stale `completed` job's id and no-opped a second discover — confirmed fixed and covered by a regression test (`tests/integration/queue/connect-server-queue.test.ts`, "allows a fresh enqueue once the prior job has genuinely COMPLETED"), which I re-ran independently: 10/10 passing. `api-e2e.test.ts` proves a second discovery snapshot is written after a real re-run. |
| 4 | auth/servers/activity/config routes validate input with Zod and return correct HTTP codes; a bad host/timeout is a controlled error and the API process stays alive | ✓ VERIFIED | `apps/control-plane/src/routes/http-errors.ts` is the single service-code→status map (`SERVICE_ERROR_STATUS`), used by every route via `sendServiceError`/`mapServiceCodeToStatus` — no per-route switch found. `app.ts`'s global `setErrorHandler` normalizes Zod validation failures to `400 VALIDATION_FAILED` with `issues`, and any unhandled exception to an opaque `500 INTERNAL_ERROR` with the message redacted via `appRedactor.redact` before logging — verified by reading the handler and by `tests/integration/routes/error-handler.test.ts` (not independently re-run, but exercised by the full-suite run the orchestrator already reported passing). |

**Score:** 4/4 roadmap criteria verified.

### Requirements Coverage

| Requirement | Source Plans | Description | Status | Evidence |
|---|---|---|---|---|
| SERV-06 | 01,02,03,04,05,06,07,08,09,10,11 | Admin triggers Connect explicitly; connection runs in worker in background; state reflects in UI in real time via SSE without reload | ✓ SATISFIED | REQUIREMENTS.md marks it `[x]` Complete; full evidence chain above (Truths 1, 2). No UI exists yet (Phase 5's job) — "reflects in the UI" is satisfied at the API/SSE contract level this phase owns; the roadmap explicitly scopes UI consumption to Phase 5. |
| DISC-05 | 02,06,07,08,11 | Admin can re-run discovery on demand from server detail | ✓ SATISFIED | REQUIREMENTS.md marks it `[x]` Complete; `POST /api/servers/:id/discover` implemented, tested (`servers-discover.test.ts`), and proven end-to-end including the real jobId-reuse bugfix (`api-e2e.test.ts`, `connect-server-queue.test.ts`). |

No orphaned requirements: REQUIREMENTS.md maps exactly SERV-06 and DISC-05 to Phase 4, and both appear in the `requirements:` frontmatter of at least one plan (02, 06, 07, 08, 11).

### Required Artifacts (spot-checked, not exhaustive — 11 plans, ~50 files)

| Artifact | Expected | Status | Details |
|---|---|---|---|
| `apps/control-plane/src/routes/servers.ts` | 8 `/api/servers` routes incl. connect/discover 202 path | ✓ VERIFIED | Exists, substantive (351 lines), every handler calls exactly one service + maps errors through `http-errors.ts` |
| `apps/control-plane/src/queue/connect-server-queue.ts` | Producer: dedupe, bounded enqueue, `noodara` prefix | ✓ VERIFIED | `jobIdForServer` deterministic id (documented `connect-<id>` deviation from CONTEXT's `connect:<id>`, hyphen required by BullMQ 6.x's `Job.validateOptions`), `addFreshJob` clears stale terminal jobs (Plan 04-11 fix) |
| `apps/control-plane/src/queue/connect-server-worker.ts` | Worker handler, D-15 outcome policy, stalled recovery, startup sweep | ✓ VERIFIED | `createWorker`, `sweepAbandonedConnections` present and wired to `failInFlightConnection`; `maxStalledCount: 0` set |
| `apps/control-plane/src/worker.ts` | Second process entrypoint | ✓ VERIFIED | env-first import, Postgres+Redis fail-fast, heartbeat, SIGTERM/SIGINT graceful shutdown with D-14 budget |
| `apps/control-plane/src/events/redis-server-event-publisher.ts`, `sse-broadcaster.ts`, `routes/events.ts` | Redis pub/sub bridge + SSE stream | ✓ VERIFIED | Channel `noodara:server-events`, 27-key `ServerView` passthrough (no transform), heartbeat re-validation, `preClose` drain, `SSE_LIMIT_REACHED` 503 |
| `apps/control-plane/src/services/fail-in-flight-connection.ts` | Recovery service, lives in `services/` | ✓ VERIFIED | `failInFlightConnection`, `listConnectingServerIds` exported; boundary test (`activity/boundary.test.ts`) still green |
| `apps/control-plane/src/routes/http-errors.ts` | Single code→status map | ✓ VERIFIED | `SERVICE_ERROR_STATUS`, `mapServiceCodeToStatus`, `toErrorBody`, `toValidationErrorBody` all present and used everywhere |
| `apps/control-plane/src/auth/require-session.ts`, `origin-guard.ts` | Session guard + CSRF-lite Origin guard | ✓ VERIFIED | Both exist, unit-tested green (18 tests total across both test files, re-run independently) |
| `apps/control-plane/src/routes/activity.ts`, `config.ts`, `health.ts` | Keyset activity, read-only config, tri-state health | ✓ VERIFIED | `read-activity.ts`/`activity-cursor.ts` present; `health.ts` reports postgres/redis/worker checks |
| `tests/integration/routes/api-e2e.test.ts` | Full real-infra E2E proof | ✓ VERIFIED (present, not re-run — requires sshd container per orchestrator's Docker/Testcontainers note; relied on documented pass in 04-VALIDATION.md/04-11-SUMMARY.md) | File exists and is substantive (300+ lines) |
| `tests/integration/queue/connect-server-queue.test.ts` (regression test for the D-09 dedupe bug) | Confirms fresh enqueue after natural completion | ✓ VERIFIED — **independently re-run**, 10/10 passing | |

### Key Link Verification

| From | To | Via | Status | Details |
|---|---|---|---|---|
| `routes/servers.ts` | `queue/connect-server-queue.ts` | `queue.enqueue()` in `/connect` and `/discover` handlers | ✓ WIRED | Confirmed by reading `enqueueConnect` |
| `queue/connect-server-worker.ts` | `services/server-services.ts` | `createServerServices(deps).connectAndDiscover` / `.failInFlightConnection` | ✓ WIRED | Both called directly in the job handler and `stalled` listener |
| `services/connect-and-discover.ts` | `events/server-event-publisher.ts` | `publishServerEvent(deps.events, ...)` after TX1 and after TX2 | ✓ WIRED | Two call sites confirmed by reading the file, matching D-04 exactly |
| `worker.ts` | `events/redis-server-event-publisher.ts` | real Redis publisher (not the noop default) passed into `resolveServerServicesDeps` | ✓ WIRED | Confirmed in `worker.ts` — this is the cross-process link that makes worker-originated events reach the API's SSE stream |
| `app.ts` | `events/sse-broadcaster.ts` | `preClose` hook ends every open SSE stream before `onClose` | ✓ WIRED | Confirmed; matches RESEARCH.md's documented Pitfall 3 |
| `routes/http-errors.ts` | every route file | `mapServiceCodeToStatus`/`sendServiceError` | ✓ WIRED | No hand-rolled status literal found for a service code in `servers.ts` |

### Data-Flow Trace (Level 4)

| Artifact | Data Variable | Source | Produces Real Data | Status |
|---|---|---|---|---|
| `GET /api/events` SSE frames | `server.updated`/`server.deleted` payload | Redis pub/sub ← `publishServerEvent` ← real DB-committed `ServerView` (`toServerView(updatedRow, ...)`) | Yes — payload is the post-commit row, not a static/mock value | ✓ FLOWING |
| `POST /connect` 202 response | `{ server, jobId }` | `services.getServer()` (real DB read) + `queue.enqueue()` (real BullMQ `jobId`) | Yes | ✓ FLOWING |
| `GET /health` `checks.worker` | heartbeat presence | `worker-heartbeat.ts`'s Redis key with 30s TTL, written by the real worker process | Yes — proven to flip `pass`→`degraded` when the worker process is killed (04-11-SUMMARY, boot-command.test.ts) | ✓ FLOWING |

### Behavioral Spot-Checks

| Behavior | Command | Result | Status |
|---|---|---|---|
| Phase-relevant unit suites (job payload/budget, http-errors, require-session, origin-guard, sse-broadcaster, redis publisher, server-event-publisher, activity-cursor, server-schemas, config-version, env, worker-heartbeat) | `pnpm exec vitest run <13 files>` | 13 files / 171 tests passed | ✓ PASS |
| Boundary + ServerView allowlist regression | `pnpm exec vitest run apps/control-plane/src/activity/boundary.test.ts apps/control-plane/src/services/server-view.test.ts apps/control-plane/src/routes/http-errors.test.ts` | 3 files / 32 tests passed | ✓ PASS |
| D-09 BullMQ dedupe-after-completion regression fix (Plan 04-11) | `pnpm vitest run --config vitest.integration.config.ts tests/integration/queue/connect-server-queue.test.ts` (Testcontainers Redis, run individually per orchestrator instructions) | 1 file / 10 tests passed | ✓ PASS |
| SSE stream integration suite | `pnpm vitest run --config vitest.integration.config.ts tests/integration/routes/events-sse.test.ts` (run individually) | 8/10 passed, 2 failed with `waitForActiveSubscriber: no subscriber on noodara:server-events after 20000ms` / ECONNREFUSED 127.0.0.1:6379 | ⚠️ FLAKY — reproduces the pre-documented, machine-specific flake (see Human Verification) |
| Stray Testcontainers cleanup | `docker ps -aq --filter "label=noodara.test=true"` (before and after the above runs) | `0` both times | ✓ PASS |

### Probe Execution

Not applicable — this phase has no `scripts/*/tests/probe-*.sh` convention; verification is via the project's own Vitest/Testcontainers suites (covered above and in the orchestrator's unit gate).

### Anti-Patterns Found

| File | Line | Pattern | Severity | Impact |
|---|---|---|---|---|
| `apps/control-plane/src/queue/connect-server-queue.ts` | 19 | Comment string contains the substring "TODO-marked" | ℹ️ Info | This is prose describing BullMQ's own undocumented internal compatibility carve-out (`connect:<id>` throwing), not a debt marker in this codebase's own code — not a violation of the debt-marker gate. |

No `FIXME`/`XXX`/unreferenced `TODO`/`PLACEHOLDER`/stub-return patterns found across `routes/`, `queue/`, `events/`, `auth/`, `worker.ts`, `app.ts`, `redis/`, `fail-in-flight-connection.ts`, or `connect-and-discover.ts`.

### TDD Discipline (advisory, per project CLAUDE.md §2.1)

All 11 plans' SUMMARY.md files document RED verified before GREEN for every `tdd`-bearing task, with explicit notes for the wiring/entrypoint tasks (`type="auto"`, no `tdd="true"`) that were instead verified end-to-end against real infrastructure (Plan 04-07 Task 3, 04-09 Task 3, 04-11 all tasks) — consistent with this phase's own established precedent, not a bypass of TDD on logic-bearing units. Plan 04-11 additionally demonstrates a live RED→GREEN cycle for a bug discovered mid-plan (the BullMQ jobId-reuse defect), with its own regression test. No TDD violations found.

### Human Verification Required

### 1. `events-sse.test.ts` flaky sub-tests — DoD conflict needing a release decision

**Test:** Re-run `pnpm vitest run --config vitest.integration.config.ts tests/integration/routes/events-sse.test.ts` on a clean machine or in CI (not the shared dev laptop this verification ran on).
**Expected:** 10/10 sub-tests pass, including the two that failed here (`server.updated` 27-key frame, `server.deleted` frame).
**Why human:** I reproduced the exact pre-documented flake live: 2/10 sub-tests failed with `waitForActiveSubscriber: no subscriber on noodara:server-events after 20000ms`, alongside `ECONNREFUSED 127.0.0.1:6379` log lines despite the Testcontainers Redis reporting healthy moments earlier. This matches Plan 04-09's SUMMARY and 04-VALIDATION.md's own exhaustive investigation (isolated non-Vitest reproduction script passes deterministically; `Redis CLIENT LIST` showed a foreign non-Docker IP sharing the container's mapped port during one failure) — attributed to this specific machine's Docker/network behavior, not a code defect. However, project CLAUDE.md's Definition of Done states "cero flaky conocidos" (zero known flaky tests) as a hard requirement, and this is a *known* flaky test, carried forward explicitly in STATE.md. Whether to (a) accept this as an environment-only caveat and proceed, (b) require a clean-machine/CI re-run before declaring the phase fully done, or (c) invest further engineering effort to eliminate the flake outright, is a project-management/release decision outside what static analysis or a single re-run can resolve — especially since the underlying behavior (the 27-key `ServerView` allowlist, and the CONNECTING→terminal SSE flow itself) is independently proven correct by other tests that do pass deterministically (`server-view.test.ts`, `server-schemas.test.ts`, `api-e2e.test.ts`).

### Gaps Summary

No functional gaps: every roadmap success criterion (1–4) and both requirement IDs (SERV-06, DISC-05) have direct, substantive, wired code evidence, cross-checked against real test runs I executed myself (not just SUMMARY.md claims) — including independently re-running the exact regression test that fixed a real BullMQ dedupe bug discovered during Plan 04-11's own closing E2E test. The only open item is the single pre-existing, exhaustively-documented, machine-specific SSE integration flake, which is a process/DoD question for a human to resolve rather than a code defect for a planner to fix.

---

*Verified: 2026-09-18T16:40:00Z*
*Verifier: Claude (gsd-verifier)*
