# Open Questions

1. Track `.claude/skills/noodara-domain-model/SKILL.md` in git (edited by 11-09; `.claude/` is gitignored)?
2. Follow-ups from Phase 11 summaries: add an askpass secret name to the domain (11-13 used the known_hosts slot); switch the 11-16 test to `workspace:*` devDeps instead of relative source imports.
3. boot-command test: free port 3000 before integration runs, or add a clear port-in-use precheck?
4. Phase 12 assumption: servers stay global (no `project_id`); "server of the same project" is enforced through the environment→project composite FK, not a server→project link.
5. Phase 12 assumption: v0.2 replaces the container stop-then-start under the fixed name `noodara-<serviceId>` (short downtime). If the new container fails to start the service ends `FAILED`; automatic restore of the previous image is v0.3 rollback.
6. Phase 12 assumption: runtime-log follow is a dedicated bounded HTTP stream, not a fifth global SSE type (D22 stays at four types).
