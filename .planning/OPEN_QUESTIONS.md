# Open Questions

1. Track `.claude/skills/noodara-domain-model/SKILL.md` in git (edited by 11-09; `.claude/` is gitignored)?
2. Follow-up from Phase 11: switch the 11-16 test to `workspace:*` devDeps instead of relative source imports (the askpass slot was done in 12-06).
3. boot-command test: free port 3000 before integration runs, or add a clear port-in-use precheck?
4. Phase 12 assumption (implemented, not yet confirmed by the user): servers stay global (no `project_id`); "server of the same project" is enforced through the environment→project composite FK, not a server→project link.
5. Phase 12 assumption (implemented, not yet confirmed by the user): v0.2 replaces the container stop-then-start under the fixed name `noodara-<serviceId>` (short downtime). If the new container fails to start the service ends `FAILED`; automatic restore of the previous image is v0.3 rollback.
6. Phase 12 assumption (implemented, not yet confirmed by the user): runtime-log follow is a dedicated bounded HTTP stream, not a fifth global SSE type (D22 stays at four types).
7. Phase 14 debt from the Phase 12 reviews (the e2e `@rowmenu` / `a11y-fallbacks` part moved to Phase 13, task 13-07): git clone over SSH trusts the repo host on first use (`accept-new`), pin it; a deploy whose enqueue fails with Postgres and Redis both down stays QUEUED until cancelled; `execStreaming` registers stdin secrets without releasing them (per-job redactor, documented).
8. Human: rotate the local dev `NOODARA_MASTER_KEY` in `.env` — it equals the public Vitest fixture key in `vitest.config.ts` (`noodara secrets rotate` with `NOODARA_MASTER_KEY_PREVIOUS`).
9. Phase 13 assumption (planned in 13-01, not yet confirmed by the user): deleting an environment that still has services is rejected with `ENVIRONMENT_NOT_EMPTY` (409) instead of cascading; the user removes the services first.
10. Phase 13 assumption (planned in 13-03, not yet confirmed by the user): deploy narration steps map to clone (or pull for image sources), build, start, verify, using step timestamps stored on `deployments` (new migration), not derived client-side from log chunks.
