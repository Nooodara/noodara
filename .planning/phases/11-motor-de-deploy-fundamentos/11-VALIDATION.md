---
phase: 11
slug: motor-de-deploy-fundamentos
status: draft
nyquist_compliant: false
wave_0_complete: false
created: 2026-09-29
---

# Phase 11 — Validation Strategy

> Per-phase validation contract for feedback sampling during execution.

---

## Test Infrastructure

| Property | Value |
|----------|-------|
| **Framework** | Vitest (unit) + Testcontainers (integration), already configured |
| **Config file** | `vitest.config.ts` (root); `tests/integration` runs via `pnpm test:integration` |
| **Quick run command** | `pnpm test` |
| **Full suite command** | `pnpm test && pnpm test:integration` |
| **Estimated runtime** | ~30 s unit / several minutes integration (Docker image build + sshd+dockerd fixture) |

---

## Sampling Rate

- **After every task commit:** Run `pnpm test`
- **After every plan wave:** Run `pnpm test:integration`
- **Before `/gsd:verify-work`:** Full suite must be green and ADR 0008 must be `Accepted`
- **Max feedback latency:** 60 s (unit); integration accepted as slower gate per wave

---

## Per-Task Verification Map

| Task ID | Plan | Wave | Requirement | Threat Ref | Secure Behavior | Test Type | Automated Command | File Exists | Status |
|---------|------|------|-------------|------------|-----------------|-----------|-------------------|-------------|--------|
| TBD (filled from PLAN.md files) | — | — | DEP-01 | — | 7-state FSM, exhaustive transition table | unit | `pnpm test -- deployment-state` | ❌ W0 | ⬜ pending |
| TBD | — | — | DEP-08 / SVC-08 | T-11-01 | validators reject shell metachars, `..`, bad schemes before touching server; LFS/submodules → `UNSUPPORTED_REPOSITORY_FEATURE` | unit | `pnpm test -- validators` | ❌ W0 | ⬜ pending |
| TBD | — | — | PROJ-04 | T-11-04 | cross-project service insert fails at DB (composite FK); partial unique index on non-terminal deployments | integration | `pnpm test:integration -- schema-ownership` | ❌ W0 | ⬜ pending |
| TBD | — | — | QA-07 | — | fixtures with `.dockerignore`, build context < 1 MiB, real pull + registry auth | integration | `pnpm test:integration -- fixtures` | ❌ W0 | ⬜ pending |
| TBD | — | — | QA-10 | T-11-02 / T-11-03 | G1 no secret in argv; G2 kill confirmed absent in `ps`; G3 BuildKit detected; G4 `docker ps` parser vs real captures | integration (contract) | `pnpm test:integration -- deploy-engine/contracts` | ❌ W0 | ⬜ pending |

*Status: ⬜ pending · ✅ green · ❌ red · ⚠️ flaky*

---

## Wave 0 Requirements

- [ ] `packages/domain/src/deployment/deployment-state.test.ts` — stubs for DEP-01
- [ ] `packages/domain/src/validators/git.test.ts`, `docker-naming.test.ts` — DEP-08, SVC-08
- [ ] `tests/integration/deploy-engine/contracts.test.ts` — QA-10 (pattern: `tests/integration/ssh/contracts.test.ts`)
- [ ] Testcontainers image `sshd-dockerd-ubuntu-{22.04,24.04}` + helper analogous to `installer-dind.ts`/`ssh.ts` — QA-07, QA-10
- [ ] Migration 0005 test (clean + from snapshot 0004) — PROJ-04
- Framework already installed; no test-framework install needed.

---

## Manual-Only Verifications

| Behavior | Requirement | Why Manual | Test Instructions |
|----------|-------------|------------|-------------------|
| ADR 0008 measured numbers reviewed for plausibility | QA-10 | Judgment on evidence quality, not automatable | Read `docs/adr/0008-deploy-engine-empirical-contracts.md`; confirm each G1–G4 section has decision, measurement on 22.04 and 24.04, rejected-alternatives table, date, status Accepted |

---

## Validation Sign-Off

- [ ] All tasks have `<automated>` verify or Wave 0 dependencies
- [ ] Sampling continuity: no 3 consecutive tasks without automated verify
- [ ] Wave 0 covers all MISSING references
- [ ] No watch-mode flags
- [ ] Feedback latency < 60s (unit)
- [ ] `nyquist_compliant: true` set in frontmatter

**Approval:** pending
