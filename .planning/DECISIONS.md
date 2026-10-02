# Decisions

Record durable decisions here. Mirror structured decision entries in `.memory/decisions.jsonl` when useful.

Architecture decisions live in `docs/adr/`; GSD per-phase decisions in `.planning/phases/*/NN-CONTEXT.md`.

- 2026-10-01: Phase 11 execution continues under agent-flow (`.agent-flow/plan.json`) from 11-13 onward. GSD phase artifacts (PLAN, SUMMARY, CONTEXT, RESEARCH) stay as the reference and each task still writes its SUMMARY.
- 2026-09-30: ADR 0008 wins over pre-spike plan text (kill -s TERM, setsid -w, docker ps --size=false, git errors classified by text).
