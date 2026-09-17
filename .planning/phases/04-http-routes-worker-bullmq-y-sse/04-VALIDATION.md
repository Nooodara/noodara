---
phase: 4
slug: http-routes-worker-bullmq-y-sse
status: planned
nyquist_compliant: true
wave_0_complete: false
created: 2026-09-16
updated: 2026-09-16
---

# Phase 4 — Validation Strategy

> Per-phase validation contract for feedback sampling during execution.

---

## Test Infrastructure

| Property | Value |
|----------|-------|
| **Framework** | Vitest 5.x (root `package.json`) |
| **Config file** | `vitest.config.ts` (unit), `vitest.integration.config.ts` (integration, Testcontainers) |
| **Quick run command** | `pnpm test` |
| **Filtered run command** | `pnpm exec vitest run <path>` / `pnpm exec vitest run --config vitest.integration.config.ts <path>` (never `pnpm test -- <filter>`, which pnpm forwards as a literal `--` positional) |
| **Full suite command** | `pnpm test:integration` |
| **Estimated runtime** | ~25 s unit · ~240 s integration (Postgres + Redis + sshd containers) |

---

## Sampling Rate

- **After every task commit:** Run `pnpm test` plus the task's own `<automated>` command
- **After every plan wave:** Run `pnpm test:integration`
- **Before `/gsd:verify-work`:** Full suite green, plus `pnpm security:scan-leaks` (extended to HTTP routes and SSE frames per D-22) and `pnpm build && pnpm test:boot` (api + worker + Redis, `/health` with `worker: pass`)
- **Max feedback latency:** 30 seconds (unit) — no task relies solely on integration for its verify

---

## Per-Task Verification Map

| Task ID | Plan | Wave | Requirement | Threat Ref | Secure Behavior | Test Type | Automated Command | File Exists | Status |
|---------|------|------|-------------|------------|-----------------|-----------|-------------------|-------------|--------|
| 04-01-01 | 01 | 1 | SERV-06 | T-4-SC | bullmq/ioredis/@testcontainers/redis provenance verified before install; ioredis pinned 5.11.1 | script | `node scripts/check-package-provenance.mjs` | ✅ exists | ⬜ pending |
| 04-01-02 | 01 | 1 | SERV-06 | T-4-06, T-4-13 | Out-of-range SSE/worker tuning values fail fast at boot; job lock budget is pure | unit | `pnpm exec vitest run apps/control-plane/src/env.test.ts apps/control-plane/src/queue/job-budget.test.ts` | ❌ W0 | ⬜ pending |
| 04-01-03 | 01 | 1 | SERV-06 | — | Labelled, self-cleaning Redis fixture for every later suite | integration | `pnpm exec vitest run --config vitest.integration.config.ts tests/integration/helpers/redis-fixture.test.ts` | ❌ W0 | ⬜ pending |
| 04-02-01 | 02 | 1 | D-16 | T-4-16, T-4-04 | Every service code maps to one documented status; error bodies never echo input | unit | `pnpm exec vitest run apps/control-plane/src/routes/http-errors.test.ts` | ❌ W0 | ⬜ pending |
| 04-02-02 | 02 | 1 | D-17 | T-4-01, T-4-15 | `requireSession` 401s anonymous callers, decorates `request.actor`, inert outside its scope | unit | `pnpm exec vitest run apps/control-plane/src/auth/require-session.test.ts` | ❌ W0 | ⬜ pending |
| 04-02-03 | 02 | 1 | D-29 | T-4-07 | Mismatched browser `Origin` on a mutation → 403 `FORBIDDEN_ORIGIN`; GET unaffected | unit | `pnpm exec vitest run apps/control-plane/src/auth/origin-guard.test.ts` | ❌ W0 | ⬜ pending |
| 04-03-01 | 03 | 1 | SERV-06 | T-4-18 | A rejecting publisher never fails or reverts a committed service call | unit | `pnpm exec vitest run apps/control-plane/src/events/server-event-publisher.test.ts` | ❌ W0 | ⬜ pending |
| 04-03-02 | 03 | 1 | SERV-06 | T-4-17, T-4-19 | Register/edit/delete/trust publish exactly once, after commit only | integration | `pnpm exec vitest run --config vitest.integration.config.ts tests/integration/services/event-publishing.test.ts` | ❌ W0 | ⬜ pending |
| 04-03-03 | 03 | 1 | SERV-06 | T-4-05 | `connectAndDiscover` publishes CONNECTING before SSH and the result after; payload is the 27-key allowlist | integration | `pnpm exec vitest run --config vitest.integration.config.ts tests/integration/services/event-publishing.test.ts` | ❌ W0 | ⬜ pending |
| 04-04-01 | 04 | 2 | D-21 | — | `/health` reports the real package version in dev and dist alike | unit | `pnpm exec vitest run apps/control-plane/src/config-version.test.ts` | ❌ W0 | ⬜ pending |
| 04-04-02 | 04 | 2 | D-22 | T-4-04, T-4-20, T-4-21 | Unhandled throw → opaque redacted 500, process survives; Zod errors normalised without echoing input | integration | `pnpm exec vitest run --config vitest.integration.config.ts tests/integration/routes/error-handler.test.ts` | ❌ W0 | ⬜ pending |
| 04-04-03 | 04 | 2 | D-17, D-18 | T-4-01, T-4-07 | Guarded/unguarded route matrix holds; every error body is `{ error: UPPER_SNAKE, message }` with Phase 1 statuses unchanged | integration | `pnpm exec vitest run --config vitest.integration.config.ts tests/integration/routes/api-scope.test.ts tests/integration/auth/` | ❌ W0 | ⬜ pending |
| 04-05-01 | 05 | 2 | SERV-06 | T-4-09, T-4-23 | Abandoned CONNECTING → ERROR/CONNECTION_LOST with one activity event, idempotent, no SSH | integration | `pnpm exec vitest run --config vitest.integration.config.ts tests/integration/services/fail-in-flight-connection.test.ts` | ❌ W0 | ⬜ pending |
| 04-05-02 | 05 | 2 | SERV-06 | — | Recovery reachable through the single `ServerServices` facade (no direct Drizzle in the worker) | integration | `pnpm exec vitest run --config vitest.integration.config.ts tests/integration/services/fail-in-flight-connection.test.ts` | ❌ W0 | ⬜ pending |
| 04-06-01 | 06 | 2 | SERV-06 | T-4-03, T-4-26 | Strict job payload; malformed data is a handled result, never a throw; no credential in Redis | unit | `pnpm exec vitest run apps/control-plane/src/queue/job-payload.test.ts` | ❌ W0 | ⬜ pending |
| 04-06-02 | 06 | 2 | D-09, D-27 | T-4-08, T-4-27, T-4-28 | Deterministic jobId dedupes; Redis down → `QUEUE_UNAVAILABLE` in <3s with no host/port in the message; all keys under `noodara:` | integration | `pnpm exec vitest run --config vitest.integration.config.ts tests/integration/queue/connect-server-queue.test.ts` | ❌ W0 | ⬜ pending |
| 04-07-01 | 07 | 3 | SERV-06 | T-4-03, T-4-10, T-4-31 | Expected codes complete the job, only real exceptions fail it; malformed payload never crashes the worker; heartbeat TTL 30s | integration | `pnpm exec vitest run --config vitest.integration.config.ts tests/integration/queue/connect-server-worker.test.ts` | ❌ W0 | ⬜ pending |
| 04-07-02 | 07 | 3 | SERV-06 | T-4-09, T-4-29 | Stalled job never re-runs SSH (exactly one connect attempt); startup sweep clears CONNECTING rows with no live job | integration | `pnpm exec vitest run --config vitest.integration.config.ts tests/integration/queue/stalled-recovery.test.ts tests/integration/queue/startup-recovery.test.ts` | ❌ W0 | ⬜ pending |
| 04-07-03 | 07 | 3 | D-23, D-25 | T-4-32 | Real `node dist/worker.js` boots against Postgres+Redis and exits cleanly on SIGTERM | integration | `pnpm build && pnpm exec vitest run --config vitest.integration.config.ts tests/integration/boot/boot-command.test.ts` | ❌ W0 | ⬜ pending |
| 04-08-01 | 08 | 3 | SERV-06 | T-4-05 | Server reads project through the 27-key allowlist, no transaction, no activity write | integration | `pnpm exec vitest run --config vitest.integration.config.ts tests/integration/services/read-servers.test.ts` | ❌ W0 | ⬜ pending |
| 04-08-02 | 08 | 3 | SERV-06 | T-4-05, T-4-33 | CRUD routes Zod-validated, status-mapped, and no credential in any response body | integration | `pnpm exec vitest run --config vitest.integration.config.ts tests/integration/routes/servers-crud.test.ts` | ❌ W0 | ⬜ pending |
| 04-08-03 | 08 | 3 | SERV-06 | T-4-34, T-4-35 | `POST /connect` → 202 `{ server, jobId }` with no worker running and no activity event; duplicate POST is idempotent | integration | `pnpm exec vitest run --config vitest.integration.config.ts tests/integration/routes/servers-connect.test.ts` | ❌ W0 | ⬜ pending |
| 04-08-03 | 08 | 3 | DISC-05 | — | `POST /discover` → 409 `SERVER_NOT_CONNECTED` off CONNECTED, 202 on it, same `connect-server` job | integration | `pnpm exec vitest run --config vitest.integration.config.ts tests/integration/routes/servers-discover.test.ts` | ❌ W0 | ⬜ pending |
| 04-08-03 | 08 | 3 | D-27 | T-4-08 | Redis down: enqueue routes 503 `QUEUE_UNAVAILABLE` while reads and CRUD keep working | integration | `pnpm exec vitest run --config vitest.integration.config.ts tests/integration/routes/servers-connect.test.ts` | ❌ W0 | ⬜ pending |
| 04-09-01 | 09 | 4 | SERV-06 | T-4-38 | Publish failure logs warn and resolves; no Redis host/port in a log line | unit | `pnpm exec vitest run apps/control-plane/src/events/redis-server-event-publisher.test.ts` | ❌ W0 | ⬜ pending |
| 04-09-02 | 09 | 4 | SERV-06 | T-4-36 | Foreign or unparseable channel messages are dropped; one dead stream cannot starve the others | unit | `pnpm exec vitest run apps/control-plane/src/events/sse-broadcaster.test.ts` | ❌ W0 | ⬜ pending |
| 04-09-03 | 09 | 4 | SERV-06 | T-4-01, T-4-02, T-4-05, T-4-06, T-4-37 | SSE client sees CONNECTING→terminal without polling; anonymous 401; revoked session closes within a heartbeat; over-limit 503 with Retry-After; `app.close()` never hangs | integration | `pnpm exec vitest run --config vitest.integration.config.ts tests/integration/routes/events-sse.test.ts` | ❌ W0 | ⬜ pending |
| 04-10-01 | 10 | 5 | D-20 | T-4-39, T-4-40 | Keyset pagination never repeats or skips, including timestamp ties; tampered cursor fails closed | unit + integration | `pnpm exec vitest run apps/control-plane/src/routes/activity-cursor.test.ts && pnpm exec vitest run --config vitest.integration.config.ts tests/integration/services/read-activity.test.ts` | ❌ W0 | ⬜ pending |
| 04-10-02 | 10 | 5 | D-20 | T-4-11 | `GET /api/activity` guarded, bounded limit, ten-field items, 400 on a bad cursor | integration | `pnpm exec vitest run --config vitest.integration.config.ts tests/integration/routes/activity.test.ts` | ❌ W0 | ⬜ pending |
| 04-10-03 | 10 | 5 | D-21, D-26 | T-4-12, T-4-41, T-4-42 | `/api/config` exposes only the 16-hex master-key fingerprint; `/health` is 503 for Postgres and 200-degraded for Redis/worker | integration | `pnpm exec vitest run --config vitest.integration.config.ts tests/integration/routes/config.test.ts tests/integration/routes/health.test.ts` | ❌ W0 | ⬜ pending |
| 04-11-01 | 11 | 6 | SERV-06, DISC-05 | T-4-05 | Full flow against real sshd: 202 in <1s, CONNECTING→CONNECTED over SSE with no polling, re-discovery writes a second snapshot | integration | `pnpm exec vitest run --config vitest.integration.config.ts tests/integration/routes/api-e2e.test.ts` | ❌ W0 | ⬜ pending |
| 04-11-02 | 11 | 6 | D-22 | T-4-04, T-4-05 | Canary absent from success bodies, error bodies, SSE frames, logs, activity metadata and snapshot payloads | integration | `pnpm security:scan-leaks` | ❌ W0 | ⬜ pending |
| 04-11-03 | 11 | 6 | D-26, D-32 | T-4-43, T-4-44 | Both entrypoints boot for real; `/health` reports `worker: pass`, then `degraded` when the worker dies | integration | `pnpm build && pnpm test:boot` | ❌ W0 | ⬜ pending |

*Status: ⬜ pending · ✅ green · ❌ red · ⚠️ flaky*

---

## Wave 0 Requirements

Owned entirely by Plan 04-01 (wave 1), which every later wave depends on:

- [ ] `tests/integration/helpers/redis.ts` — Testcontainers `redis:7-alpine` fixture, label `noodara.test=true`, mirrors `postgres.ts`
- [ ] Dependencies approved via `scripts/check-package-provenance.mjs` and recorded in ADR 0000: `bullmq@6.3.6`, `ioredis@5.11.1`, `@testcontainers/redis@12.1.0` (`concurrently` deliberately not installed — the two-turbo-tasks alternative is used instead)
- [ ] `NOODARA_WORKER_CONCURRENCY` and `NOODARA_SSE_MAX_CONNECTIONS` validated in `env.ts`, listed in `turbo.json` `passThroughEnv` and `.env.example`
- [ ] `computeJobLockDurationMs` available as a pure, unit-tested function

Follow-on fixtures created inside the waves that first need them (not blocking Wave 1):
- [ ] `tests/integration/services/helpers/service-fixture.ts` gains a recording event publisher (Plan 04-03)
- [ ] `tests/integration/helpers/worker-fixture.ts` — in-process `createWorker` harness over Postgres + Redis (Plan 04-07)
- [ ] `tests/integration/helpers/boot-process.ts` — `buildValidBootEnv` takes a real Redis URL (Plan 04-07)

CI: no new job and no `services:` block. Redis containers are Testcontainers-owned and already covered by the `noodara.test=true` stray-container check in the `integration`, `security` and `boot-smoke` jobs; only comments change (Plans 04-01, 04-11).

---

## Manual-Only Verifications

| Behavior | Requirement | Why Manual | Test Instructions |
|----------|-------------|------------|-------------------|
| Browser `EventSource` reconnects after API restart and the UI resyncs via `GET /api/servers` | SERV-06 | No UI client until Phase 5 | Deferred to Phase 5 E2E (D-05 designs around the browser's native reconnect) |

---

## Validation Sign-Off

- [ ] All tasks have `<automated>` verify or Wave 0 dependencies
- [ ] Sampling continuity: no 3 consecutive tasks without automated verify
- [ ] Wave 0 covers all MISSING references
- [ ] No watch-mode flags
- [ ] Feedback latency < 30s
- [ ] `nyquist_compliant: true` set in frontmatter

**Approval:** pending — Plan 04-11 Task 3 closes this file with measured statuses.
