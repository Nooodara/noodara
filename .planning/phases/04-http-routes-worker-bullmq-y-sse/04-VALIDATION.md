---
phase: 4
slug: http-routes-worker-bullmq-y-sse
status: draft
nyquist_compliant: false
wave_0_complete: false
created: 2026-09-16
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
| **Full suite command** | `pnpm test:integration` |
| **Estimated runtime** | ~20 s unit · ~180 s integration (Postgres + Redis + sshd containers) |

---

## Sampling Rate

- **After every task commit:** Run `pnpm test`
- **After every plan wave:** Run `pnpm test:integration`
- **Before `/gsd:verify-work`:** Full suite must be green, plus `pnpm security:scan-leaks` (extended to HTTP routes/SSE per D-22) and `pnpm test:boot` (api + worker + Redis, `/health` with `worker: pass`)
- **Max feedback latency:** 30 seconds (unit) — never rely solely on integration for a task's verify

---

## Per-Task Verification Map

| Task ID | Plan | Wave | Requirement | Threat Ref | Secure Behavior | Test Type | Automated Command | File Exists | Status |
|---------|------|------|-------------|------------|-----------------|-----------|-------------------|-------------|--------|
| 04-XX-XX | — | — | SERV-06 | T-4-XX | `POST /api/servers/:id/connect` enqueues and responds 202 without waiting on SSH | integration | `pnpm test:integration -- tests/integration/routes/servers-connect.test.ts` | ❌ W0 | ⬜ pending |
| 04-XX-XX | — | — | SERV-06 | T-4-XX | SSE client receives `server.updated` for CONNECTING → CONNECTED/ERROR without polling | integration | `pnpm test:integration -- tests/integration/routes/events-sse.test.ts` | ❌ W0 | ⬜ pending |
| 04-XX-XX | — | — | SERV-06 | T-4-XX | Stalled job never re-runs SSH; row ends `ERROR`/`CONNECTION_LOST` | integration | `pnpm test:integration -- tests/integration/queue/stalled-recovery.test.ts` | ❌ W0 | ⬜ pending |
| 04-XX-XX | — | — | SERV-06 | T-4-XX | Worker startup sweep clears `CONNECTING` rows with no active job | integration | `pnpm test:integration -- tests/integration/queue/startup-recovery.test.ts` | ❌ W0 | ⬜ pending |
| 04-XX-XX | — | — | DISC-05 | — | `POST /discover` on non-`CONNECTED` → 409 `SERVER_NOT_CONNECTED` | unit | `pnpm test -- routes/servers` | ❌ W0 | ⬜ pending |
| 04-XX-XX | — | — | DISC-05 | — | `POST /discover` on `CONNECTED` enqueues the same `connect-server` job | integration | `pnpm test:integration -- tests/integration/routes/servers-discover.test.ts` | ❌ W0 | ⬜ pending |
| 04-XX-XX | — | — | D-16 | T-4-XX | Every service code maps to the documented HTTP status; error body never carries raw messages | unit | `pnpm test -- routes/http-errors` | ❌ W0 | ⬜ pending |
| 04-XX-XX | — | — | D-17 | T-4-XX | `requireSession` 401s anonymous callers and decorates `request.actor` | unit | `pnpm test -- auth/require-session` | ❌ W0 | ⬜ pending |
| 04-XX-XX | — | — | D-27 | T-4-XX | Redis down: `POST /connect` → 503 `QUEUE_UNAVAILABLE` within ~2 s; CRUD/activity/config keep working | integration | `pnpm test:integration -- tests/integration/routes/redis-down.test.ts` | ❌ W0 | ⬜ pending |

*The planner replaces `04-XX-XX` rows with real task IDs, plan numbers, waves and threat refs.*
*Status: ⬜ pending · ✅ green · ❌ red · ⚠️ flaky*

---

## Wave 0 Requirements

- [ ] `tests/integration/helpers/redis.ts` — Testcontainers `redis:7-alpine` fixture, label `noodara.test=true`, mirrors `postgres.ts`
- [ ] `tests/integration/helpers/app.ts` — Redis-backed variant of `startTestApp()` (queue + subscriber injected)
- [ ] Dependencies approved via `scripts/check-package-provenance.mjs` and ADR 0000: `bullmq@6.3.6`, `ioredis@5.11.1`, `@testcontainers/redis@12.1.0`
- [ ] CI: `integration` and `boot-smoke` jobs gain a Redis service

---

## Manual-Only Verifications

| Behavior | Requirement | Why Manual | Test Instructions |
|----------|-------------|------------|-------------------|
| Browser `EventSource` reconnects after API restart and UI resyncs | SERV-06 | No UI client until Phase 5 | Deferred to Phase 5 E2E |

---

## Validation Sign-Off

- [ ] All tasks have `<automated>` verify or Wave 0 dependencies
- [ ] Sampling continuity: no 3 consecutive tasks without automated verify
- [ ] Wave 0 covers all MISSING references
- [ ] No watch-mode flags
- [ ] Feedback latency < 30s
- [ ] `nyquist_compliant: true` set in frontmatter

**Approval:** pending
