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
- 2026-10-06: User approved the Phase 13 UI screenshots (13-17 A4) with the FLAGs recorded as Phase 14 debt, and chose that creating a project or a service navigates to the new resource (task 13-21).
- 2026-10-07: `@axe-core/playwright` is a root devDependency; the UI DoD spec (`tests/e2e/projects-dod.spec.ts`) fails on serious/critical axe violations. Sheet: releasing a closing sheet past the midpoint closes it (13-22).
- 2026-10-07: Phase 14 planned in `.agent-flow/plan.json` (17 tasks, 14-01..14-17). It also takes the debt in OPEN_QUESTIONS #2, #3, #7 and #11. User decisions: (1) git host keys over SSH are pinned with bundled published keys for github.com/gitlab.com/bitbucket.org plus TOFU persisted per service, `StrictHostKeyChecking=yes`, a mismatch fails as `GIT_HOST_KEY_MISMATCH`, and a CLI command resets the pin; (2) D12 build-cache policy: `docker builder prune -f --filter until=168h` after a successful deploy, at most once per server per 24 h, can be turned off, ADR 0009; (3) release order: tag `v0.2.0-rc.1` as a prerelease, run the real VPS gate and the v0.1.0 → rc.1 upgrade/rollback on it, then tag `v0.2.0` from the same commit.
