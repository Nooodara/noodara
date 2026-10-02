# AGENTS.md

This repository is prepared for AI coding agents with agent-flow.

## Project Snapshot

- Package manager: pnpm
- Detected stack: Docker

## Common Commands

- Install: pnpm install
- Dev: pnpm dev
- Build: pnpm build
- Test: pnpm test
- Lint: pnpm lint
- Typecheck: pnpm typecheck

## Agent Workflow

1. For a fresh repo, run `agent-flow init --codex`, then `agent-flow onboard`, then `$flow-resume`.
2. Use `.planning/STATE.md` as the current project truth.
3. Use `.planning/DECISIONS.md` for durable technical decisions.
4. Use `.memory/*.jsonl` as the reviewable append-only memory log.
5. Treat `.agent-flow/memory.db` as an internal generated SQLite index. Do not manually edit it.
6. Prefer `agent-flow context <task>` for focused task context before non-trivial agent work.
7. Do not overwrite memory without explicit user instruction.
8. Prefer small scoped changes and avoid unrelated refactors.
9. Run detected verification commands before final response when possible.

## Memory Files

- `.memory/events.jsonl`: important repo events and session notes.
- `.memory/decisions.jsonl`: durable product or technical decisions.
- `.memory/errors.jsonl`: errors, causes, and fixes.
- `.memory/modules.jsonl`: notes about important files, modules, and ownership.

## Memory Index

- `.agent-flow/memory.db`: internal generated SQLite index for faster local queries and context packs.
- JSONL files remain the source of truth; rebuild the index with `agent-flow memory rebuild` if needed.
- Do not commit or manually edit `.agent-flow/memory.db`.
