---
phase: 3
slug: servicios-de-aplicaci-n-activity-log-y-redacci-n
status: approved
nyquist_compliant: true
wave_0_complete: true
created: 2026-09-15
updated: 2026-09-15
---

# Phase 3 — Validation Strategy

> Per-phase validation contract for feedback sampling during execution.

---

## Test Infrastructure

| Property | Value |
|----------|-------|
| **Framework** | Vitest 5.0.0 (unit: `vitest.config.ts` with projects `root`/`packages`/`apps`; integration: `vitest.integration.config.ts`, `testTimeout: 120_000`, `fileParallelism: false`) |
| **Config file** | `vitest.config.ts`, `vitest.integration.config.ts` (both exist) |
| **Quick run command** | `pnpm test` (unit only, no Docker) |
| **Full suite command** | `pnpm test && pnpm test:integration` (Docker required) |
| **Security gate command** | `pnpm security:scan-leaks` (widened to two files by plan 03-10) |
| **Estimated runtime** | unit ~15s · integration ~10-15 min warm (Testcontainers Postgres + up to four sshd image variants) |

Test placement decision for this phase (resolves the gap 03-PATTERNS.md flagged):

| Module kind | Test kind | Location |
|---|---|---|
| Pure domain functions (`merge-facts`, `classify-edit`, activity union) | unit | colocated `packages/domain/src/**/*.test.ts` |
| Pure app modules (`credential-store`, `server-view`, `server-service-deps`) | unit | colocated `apps/control-plane/src/services/*.test.ts` |
| Static enforcement (activity boundary) | unit | colocated `apps/control-plane/src/activity/boundary.test.ts` |
| Application services (open `db.transaction`) | integration | `tests/integration/services/*.test.ts` + Testcontainers Postgres + fake `SshPort` |
| Full credential/SSH flow (SEC-02) | integration | `tests/integration/activity/canary-full-flow.test.ts` + real sshd container |
| Migration 0003 | integration | `tests/integration/db/migrations.test.ts`, `schema.test.ts`, `migration-hygiene.test.ts` |

No service gets a colocated `*.test.ts`: per `noodara-tdd` SKILL §2, logic that crosses a real
PostgreSQL process is an integration test.

---

## Sampling Rate

- **After every task commit:** `pnpm test` (unit, < 20s) plus the task's own `<automated>` command
- **After every plan:** `pnpm typecheck && pnpm lint && pnpm exec turbo boundaries`
- **After every wave:** `pnpm test:integration`
- **Before `/gsd:verify-work`:** `pnpm test && pnpm test:integration && pnpm security:scan-leaks && pnpm typecheck && pnpm lint && pnpm exec turbo boundaries` all green
- **Max feedback latency:** < 20s for the unit loop; integration is a per-wave gate, not a per-edit one

---

## Per-Task Verification Map

| Task ID | Plan | Wave | Requirement | Threat Ref | Secure Behavior | Test Type | Automated Command | File Exists | Status |
|---------|------|------|-------------|------------|-----------------|-----------|-------------------|-------------|--------|
| 3-01-01 | 01 | 1 | SERV-01 | — | control-plane resolves `@noodara/ssh` from its own scope | resolution | `pnpm install && pnpm build && pnpm --filter @noodara/control-plane exec node -e "import('@noodara/ssh')..."` | ✅ | ⬜ pending |
| 3-01-02 | 01 | 1 | SERV-02 | T-3-10 / T-3-15 | key rules reachable, not duplicated | unit | `pnpm exec vitest run packages/ssh/src/run-discovery.test.ts packages/ssh/src/boundary.test.ts` | ✅ | ⬜ pending |
| 3-01-03 | 01 | 1 | SERV-01 | T-3-16 | D-03 semantics recorded | docs/CLI | `grep -q 'CONNECTED means the last operation succeeded, not that a session is open\.' docs/domain/server-state-transitions.md` | ✅ | ⬜ pending |
| 3-02-01 | 02 | 1 | DISC-03 | T-3-17 | null facts never overwrite known values | unit | `pnpm exec vitest run packages/domain/src/discovery/merge-facts.test.ts packages/domain/src/purity.test.ts` | ❌ W0 | ⬜ pending |
| 3-02-02 | 02 | 1 | SERV-02 | T-3-12 | edit classification feeds reason-gated transitions | unit | `pnpm exec vitest run packages/domain/src/server/classify-edit.test.ts packages/domain/src/server/server-state.test.ts` | ❌ W0 | ⬜ pending |
| 3-02-03 | 02 | 1 | ACT-01 | T-3-02 / T-3-18 | only the six typed server actions are accepted; sensitive metadata still throws | unit | `pnpm exec vitest run packages/domain/src/activity/activity-event.test.ts && pnpm test && pnpm typecheck` | ✅ extended | ⬜ pending |
| 3-03-01 | 03 | 1 | DISC-03 | T-3-13 / T-3-11 | database-level uniqueness and cascade expectations exist | integration (RED gate) | `if pnpm exec vitest run --config vitest.integration.config.ts tests/integration/db/migrations.test.ts; then exit 1; else exit 0; fi` | ✅ extended | ⬜ pending |
| 3-03-02 | 03 | 1 | DISC-03, SERV-01 | T-3-13 / T-3-19 / T-3-20 | migration 0003 applies from scratch and from 0002 | integration | `pnpm typecheck && pnpm exec vitest run --config vitest.integration.config.ts tests/integration/db/migrations.test.ts tests/integration/db/schema.test.ts tests/integration/db/migration-hygiene.test.ts` | ❌ W0 (migration) | ⬜ pending |
| 3-04-01 | 04 | 2 | SERV-01 | — | actor + deps declared once | unit | `pnpm exec vitest run apps/control-plane/src/services/server-service-deps.test.ts` | ❌ W0 | ⬜ pending |
| 3-04-02 | 04 | 2 | SERV-01, SEC-02 | T-3-03 / T-3-10 / T-3-21 | invalid keys rejected before persistence; plaintext never escapes | unit | `pnpm exec vitest run apps/control-plane/src/services/credential-store.test.ts` | ❌ W0 | ⬜ pending |
| 3-04-03 | 04 | 2 | SEC-02, SERV-02 | T-3-01 | ServerView carries no credential-shaped key | unit | `pnpm exec vitest run apps/control-plane/src/services/server-view.test.ts && pnpm typecheck` | ❌ W0 | ⬜ pending |
| 3-05-01 | 05 | 3 | SERV-01, ACT-01 | T-3-01 / T-3-13 | registration expectations exist | integration (RED gate) | `if pnpm exec vitest run --config vitest.integration.config.ts tests/integration/services/register-server.test.ts; then exit 1; else exit 0; fi` | ❌ W0 | ⬜ pending |
| 3-05-02 | 05 | 3 | SERV-01, ACT-01 | T-3-01 / T-3-23 / T-3-24 / T-3-25 | credential encrypted, no orphan rows, one typed event | integration | `pnpm exec vitest run --config vitest.integration.config.ts tests/integration/services/register-server.test.ts && pnpm typecheck` | ❌ W0 | ⬜ pending |
| 3-06-01 | 06 | 4 | SERV-02, ACT-01 | T-3-06 / T-3-26 | edit expectations exist | integration (RED gate) | `if pnpm exec vitest run --config vitest.integration.config.ts tests/integration/services/edit-server.test.ts; then exit 1; else exit 0; fi` | ❌ W0 | ⬜ pending |
| 3-06-02 | 06 | 4 | SERV-02, ACT-01 | T-3-06 / T-3-26 / T-3-27 / T-3-12 | in-place credential replacement, busy guard, identity fingerprint clear | integration | `pnpm exec vitest run --config vitest.integration.config.ts tests/integration/services/edit-server.test.ts && pnpm typecheck` | ❌ W0 | ⬜ pending |
| 3-07-01 | 07 | 4 | SERV-03, ACT-01 | T-3-09 / T-3-28 | delete expectations exist | integration (RED gate) | `if pnpm exec vitest run --config vitest.integration.config.ts tests/integration/services/delete-server.test.ts; then exit 1; else exit 0; fi` | ❌ W0 | ⬜ pending |
| 3-07-02 | 07 | 4 | SERV-03, ACT-01 | T-3-09 / T-3-11 / T-3-28 / T-3-29 | confirmation-gated atomic delete, event before delete, cascade | integration | `pnpm exec vitest run --config vitest.integration.config.ts tests/integration/services/delete-server.test.ts && pnpm typecheck` | ❌ W0 | ⬜ pending |
| 3-08-01 | 08 | 4 | DISC-03, ACT-01 | T-3-05 / T-3-30 | connect+discovery expectations exist | integration (RED gate) | `if pnpm exec vitest run --config vitest.integration.config.ts tests/integration/services/connect-and-discover.test.ts; then exit 1; else exit 0; fi` | ❌ W0 | ⬜ pending |
| 3-08-02 | 08 | 4 | DISC-03, ACT-01 | T-3-05 / T-3-07 / T-3-31 / T-3-12 | locked conflict, domain-applied status, fingerprint timestamps | integration | `pnpm exec vitest run --config vitest.integration.config.ts tests/integration/services/connect-and-discover.test.ts -t "connect phase" && pnpm typecheck` | ❌ W0 | ⬜ pending |
| 3-08-03 | 08 | 4 | DISC-03, ACT-01 | T-3-04 / T-3-14 / T-3-30 | snapshot + denormalization atomic, session always closed | integration | `pnpm exec vitest run --config vitest.integration.config.ts tests/integration/services/connect-and-discover.test.ts && pnpm typecheck && pnpm lint` | ❌ W0 | ⬜ pending |
| 3-09-01 | 09 | 5 | ACT-01 | T-3-07 / T-3-09 | trust expectations exist | integration (RED gate) | `if pnpm exec vitest run --config vitest.integration.config.ts tests/integration/services/trust-fingerprint.test.ts; then exit 1; else exit 0; fi` | ❌ W0 | ⬜ pending |
| 3-09-02 | 09 | 5 | ACT-01 | T-3-07 / T-3-06 | explicit, audited fingerprint promotion | integration | `pnpm exec vitest run --config vitest.integration.config.ts tests/integration/services/trust-fingerprint.test.ts && pnpm typecheck` | ❌ W0 | ⬜ pending |
| 3-09-03 | 09 | 5 | ACT-01 | T-3-08 / T-3-32 | only services write activity events (non-vacuous scan) | unit | `pnpm exec vitest run apps/control-plane/src/activity/boundary.test.ts packages/ssh/src/boundary.test.ts packages/domain/src/purity.test.ts` | ❌ W0 | ⬜ pending |
| 3-10-01 | 10 | 6 | SEC-02, DISC-03 | T-3-01..T-3-04 / T-3-33 | no canary secret in any of the five outputs, real sshd flow | integration | `pnpm exec vitest run --config vitest.integration.config.ts tests/integration/activity/canary-full-flow.test.ts` | ❌ W0 | ⬜ pending |
| 3-10-02 | 10 | 6 | SEC-02 | T-3-34 / T-3-35 | the leak scan is the CI gate and cleans up its containers | script/CI | `node -e "...scripts['security:scan-leaks']..." && pnpm security:scan-leaks` | ✅ extended | ⬜ pending |

*Status: ⬜ pending · ✅ green · ❌ red · ⚠️ flaky*

Sampling continuity check: no three consecutive tasks lack an automated verify — every task in every
plan carries one.

---

## Wave 0 Requirements

Every MISSING reference from 03-RESEARCH.md "### Wave 0 Gaps" is assigned to a task:

- [ ] `apps/control-plane/package.json` `@noodara/ssh` dependency — plan **03-01** task 1 (blocks everything else)
- [ ] `@noodara/ssh` public `loadPrivateKey` export — plan **03-01** task 2
- [ ] `packages/domain/src/discovery/merge-facts.ts` + test — plan **03-02** task 1
- [ ] `packages/domain/src/server/classify-edit.ts` + test — plan **03-02** task 2
- [ ] `apps/control-plane/src/db/schema/discovery-snapshots.ts` — plan **03-03** task 2
- [ ] `apps/control-plane/src/db/migrations/0003_phase3_discovery_snapshots.sql` — plan **03-03** task 2 (BLOCKING)
- [ ] `apps/control-plane/src/services/server-service-deps.ts` + test — plan **03-04** task 1
- [ ] `apps/control-plane/src/services/credential-store.ts` + test — plan **03-04** task 2
- [ ] `apps/control-plane/src/services/server-view.ts` + test — plan **03-04** task 3
- [ ] `tests/integration/services/helpers/service-fixture.ts` (shared harness, incl. fake `SshPort`) — plan **03-05** task 1
- [ ] `apps/control-plane/src/services/register-server.ts` + suite — plan **03-05**
- [ ] `apps/control-plane/src/services/edit-server.ts` + suite — plan **03-06**
- [ ] `apps/control-plane/src/services/delete-server.ts` + suite — plan **03-07**
- [ ] `apps/control-plane/src/services/connect-and-discover.ts` + suite — plan **03-08**
- [ ] `apps/control-plane/src/services/trust-fingerprint.ts` + `server-services.ts` + suite — plan **03-09**
- [ ] `apps/control-plane/src/activity/boundary.test.ts` — plan **03-09** task 3
- [ ] `tests/integration/activity/canary-full-flow.test.ts` — plan **03-10** task 1

---

## Manual-Only Verifications

All phase behaviours have automated verification. No manual step is required: this phase produces no
UI and no HTTP surface (routes land in phase 4), so every deliverable is exercised by Vitest, either
in-process or against Testcontainers.

---

## Validation Sign-Off

- [x] All tasks have `<automated>` verify or Wave 0 dependencies
- [x] Sampling continuity: no 3 consecutive tasks without automated verify
- [x] Wave 0 covers all MISSING references
- [x] No watch-mode flags
- [x] Feedback latency < 20s for the unit loop (integration is a per-wave gate)
- [x] `nyquist_compliant: true` set in frontmatter

**Approval:** approved 2026-09-15 (planning-time)
