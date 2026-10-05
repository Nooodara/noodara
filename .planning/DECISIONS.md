# Decisions

Record durable decisions here. Mirror structured decision entries in `.memory/decisions.jsonl` when useful.

Architecture decisions live in `docs/adr/`; GSD per-phase decisions in `.planning/phases/*/NN-CONTEXT.md`.

- 2026-10-01: Phase 11 execution continues under agent-flow (`.agent-flow/plan.json`) from 11-13 onward. GSD phase artifacts (PLAN, SUMMARY, CONTEXT, RESEARCH) stay as the reference and each task still writes its SUMMARY.
- 2026-09-30: ADR 0008 wins over pre-spike plan text (kill -s TERM, setsid -w, docker ps --size=false, git errors classified by text).
- 2026-10-04: ADR 0008 accepted. G7 mirror.gcr.io pull-through confirmed; D-04 is `kill -s TERM -- "-$pgid"` under `setsid -w`; `docker kill` kept as a safety net (it does not cancel BuildKit builds); HTTPS-token clone gets a contract test in Phase 12.
- 2026-10-04: agent-flow replaces GSD as the project workflow from Phase 12 on (plan, execute, verify, close). `.planning/phases/` 1–11 stays as read-only history. Phase review is tier 1 (independent `flow-reviewer`).
