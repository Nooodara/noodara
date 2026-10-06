# Decisions

Record durable decisions here. Mirror structured decision entries in `.memory/decisions.jsonl` when useful.

Architecture decisions live in `docs/adr/`; GSD per-phase decisions in `.planning/phases/*/NN-CONTEXT.md`.

- 2026-10-01: Phase 11 execution continues under agent-flow (`.agent-flow/plan.json`) from 11-13 onward. GSD phase artifacts (PLAN, SUMMARY, CONTEXT, RESEARCH) stay as the reference and each task still writes its SUMMARY.
- 2026-09-30: ADR 0008 wins over pre-spike plan text (kill -s TERM, setsid -w, docker ps --size=false, git errors classified by text).
- 2026-10-04: ADR 0008 accepted. G7 mirror.gcr.io pull-through confirmed; D-04 is `kill -s TERM -- "-$pgid"` under `setsid -w`; `docker kill` kept as a safety net (it does not cancel BuildKit builds); HTTPS-token clone gets a contract test in Phase 12.
- 2026-10-04: agent-flow replaces GSD as the project workflow from Phase 12 on (plan, execute, verify, close). `.planning/phases/` 1–11 stays as read-only history. Phase review is tier 1 (independent `flow-reviewer`).
- 2026-10-05: Cancel cleanup (12-13 A3) compares `docker system df` Images/Containers/Local Volumes only. A cancelled BuildKit build leaves an unused cache record (~8 kB); build cache is BuildKit-owned and its retention/pruning belongs to Phase 14 (D11/D12). Recorded in ADR 0008.
- 2026-10-05: CI `integration` excludes `tests/integration/deploy-engine/**` (no longer fits 50 min); those suites run only in nightly, split per Ubuntu version (`deploy-engine (22.04|24.04)`) plus `soak`.
- 2026-10-05: Publishing Noodara = subtree split + filter-branch + rebase onto `gh/main` + tree-equality and fast-forward checks + `gitleaks detect` on the publish clone before any push.
- 2026-10-06: Phase 13 planned in `.agent-flow/plan.json` (19 tasks, 13-01..13-19). It closes four backend gaps the UI needs: `DELETE` environment (PROJ-03 listed it but the route was missing), `updatedAt` on `service.updated`/`deployment.updated` (REC-02 needs it to reconcile), a per-step deploy timeline (LOG-04 needs per-step durations) and Activity copy for deploy-engine actions. The e2e `@rowmenu` / `a11y-fallbacks` debt moves from Phase 14 to 13-07, because QA-09 must run green in CI.
