---
phase: 5
slug: ui-web
status: draft
nyquist_compliant: false
wave_0_complete: false
created: 2026-09-18
---

# Phase 5 — Validation Strategy

> Per-phase validation contract for feedback sampling during execution.
> Source: `05-RESEARCH.md` § Validation Architecture.

---

## Test Infrastructure

| Property | Value |
|----------|-------|
| **Framework** | Vitest 5.0.0 (unit/integration, already configured) + Playwright 1.63.0 (E2E, net-new this phase) |
| **Config file** | `vitest.config.ts` / `vitest.integration.config.ts` (existing); `playwright.config.ts` — none, Wave 0 installs |
| **Quick run command** | `pnpm test` |
| **Full suite command** | `pnpm test:integration && pnpm test:e2e` (`test:e2e` is currently a placeholder — Wave 0 replaces it with a real Playwright invocation) |
| **Estimated runtime** | ~60 seconds quick / several minutes full (Testcontainers + Playwright) |

---

## Sampling Rate

- **After every task commit:** Run `pnpm test` plus `pnpm lint` / `pnpm typecheck` for any touched package
- **After every plan wave:** Run `pnpm test:integration` + `pnpm test:e2e` (once it exists); `pnpm security:scan-leaks` after any change touching credentials, SSE, or logging
- **Before `/gsd:verify-work`:** Full suite must be green — `pnpm test`, `pnpm test:integration`, `pnpm test:boot`, `pnpm test:e2e`, `pnpm security:scan-leaks`, `pnpm typecheck`, `pnpm lint`, `pnpm boundaries`
- **Max feedback latency:** 60 seconds (quick run)

---

## Per-Task Verification Map

> Task IDs are filled in by the planner / executor once PLAN.md files exist. Rows below are the requirement-level contract each task must map onto.

| Task ID | Plan | Wave | Requirement | Threat Ref | Secure Behavior | Test Type | Automated Command | File Exists | Status |
|---------|------|------|-------------|------------|-----------------|-----------|-------------------|-------------|--------|
| TBD | TBD | 0 | D-17 (security remediation) | UF-01 | Editing host while `ERROR` clears `pendingFingerprint`; trust-fingerprint fails safely afterwards | integration | `pnpm test:integration` | ❌ W0 | ⬜ pending |
| TBD | TBD | 0 | D-17 (security remediation) | T-4-02 / T-4-10 / T-4-32 / T-4-38 | Bounded `getSession`; `err.name`-only logging; worker shutdown try/catch | unit + integration | `pnpm test && pnpm test:integration` | ❌ W0 | ⬜ pending |
| TBD | TBD | TBD | SERV-04 | — | N/A | component (Vitest) + E2E | `pnpm test` / QA-04 flow | ❌ W0 | ⬜ pending |
| TBD | TBD | TBD | DETL-01, DETL-02 | — | Host fingerprint shown, never credentials | component + E2E | `pnpm test` / QA-04 `detail` step | ❌ W0 | ⬜ pending |
| TBD | TBD | TBD | ACT-02 | — | Curated metadata only, no raw JSON / sensitive fields | component | `pnpm test` | ❌ W0 | ⬜ pending |
| TBD | TBD | TBD | SET-01 | — | Read-only version / publicUrl | component | `pnpm test` | ❌ W0 | ⬜ pending |
| TBD | TBD | TBD | UI-01 | — | N/A | E2E (keyboard / a11y, dark + light) | `pnpm test:e2e -- --grep shell` | ❌ W0 | ⬜ pending |
| TBD | TBD | TBD | UI-02 | — | Error states never render secrets or raw exceptions | component (one test per state per screen) | `pnpm test` | ❌ W0 | ⬜ pending |
| TBD | TBD | TBD | DISC-02 | — | Never shows progress that was not received | unit (fake `EventSource`) + E2E | `pnpm test` / QA-04 `discovery` step | ❌ W0 | ⬜ pending |
| TBD | TBD | TBD | QA-04 | — | N/A | E2E + nightly workflow (20x, 100 consecutive connections) | `pnpm test:e2e`, `.github/workflows/nightly.yml` | ❌ W0 | ⬜ pending |
| TBD | TBD | TBD | QA-05 | canary | No canary secret in rendered HTML, console, storage, HTTP, SSE, logs, activity | integration | `pnpm security:scan-leaks` | Partial — UI-output scan missing | ⬜ pending |

*Status: ⬜ pending · ✅ green · ❌ red · ⚠️ flaky*

---

## Wave 0 Requirements

- [ ] `edit-server.ts` UF-01 fix + integration test ("edit host in ERROR, then trust-fingerprint fails safely") — **security-blocking, precedes all other Wave 0 items**
- [ ] Fixes for T-4-02 (bounded `getSession` in `events.ts` / `require-session.ts`), T-4-10 / T-4-38 (pino `err` serializer or `err.name`-only logging), T-4-32 (`worker.ts` shutdown try/catch)
- [ ] `apps/web` scaffold + turbo task-graph wiring (`dependsOn: ["^build"]`, `passThroughEnv` for new env vars)
- [ ] `packages/ui` scaffold + Vitest config for component-level tests
- [ ] `playwright.config.ts` + first E2E spec replacing the `test:e2e` placeholder
- [ ] Discovery `onCheck` callback in `packages/ssh/src/run-discovery.ts` + new SSE event type in `sse-broadcaster.ts` `KNOWN_EVENT_TYPES` + new read endpoint in `routes/servers.ts`
- [ ] `.github/workflows/nightly.yml` — 20x E2E repetition + 100 consecutive connections + canary job
- [ ] `scripts/check-package-provenance.mjs` `EXPECTED_PACKAGES` extended + ADR-0000 "Phase 5 additions" section

---

## Manual-Only Verifications

| Behavior | Requirement | Why Manual | Test Instructions |
|----------|-------------|------------|-------------------|
| Visual fidelity to the Apple-inspired design system (surfaces, hairlines, spacing, single action color) in dark and light | UI-01, UI-02 | Subjective design-system conformance is not assertable | Run skill `noodara-ux-review` against each implemented screen in both themes; record PASS / FLAG / BLOCK per dimension |
| Nightly 20/20 run on real CI | QA-04 | Repo has no remote yet; workflow can only be validated locally | Run the nightly job's script locally in a loop; confirm 20/20 green and attach output |

---

## Validation Sign-Off

- [ ] All tasks have `<automated>` verify or Wave 0 dependencies
- [ ] Sampling continuity: no 3 consecutive tasks without automated verify
- [ ] Wave 0 covers all MISSING references
- [ ] No watch-mode flags
- [ ] Feedback latency < 60s
- [ ] `nyquist_compliant: true` set in frontmatter

**Approval:** pending
