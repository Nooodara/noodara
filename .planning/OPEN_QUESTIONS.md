# Open Questions

ADR 0008 acceptance (blocks Phase 12 planning; agent-flow task 11-09 stays `blocked` until answered):

1. Confirm the G7 base-image path: pull-through mirror of mirror.gcr.io (chosen by the orchestrator during an autonomous run).
2. Accept `kill -s TERM -- "-$pgid"` launched with `setsid -w` as the wording fix for D-04.
3. Keep or drop the `docker kill` branch for builds (it never found a target during BuildKit builds).
4. HTTPS token clone: measure it in Phase 12, or ship v0.2 with deploy keys only.
5. Track `.claude/skills/noodara-domain-model/SKILL.md` in git (edited by 11-09; `.claude/` is gitignored)?
