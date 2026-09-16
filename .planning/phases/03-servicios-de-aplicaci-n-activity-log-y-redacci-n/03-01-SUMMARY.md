---
phase: 03-servicios-de-aplicaci-n-activity-log-y-redacci-n
plan: 01
subsystem: infra
tags: [pnpm-workspaces, turborepo, ssh2, vitest, tdd, domain-model]

# Dependency graph
requires:
  - phase: 02-adaptador-ssh-aislado-y-probado-con-testcontainers
    provides: "@noodara/ssh package (SshPort, runDiscovery, key-loader) built and tested"
provides:
  - "apps/control-plane depends on @noodara/ssh and can import it from its own scope"
  - "@noodara/ssh's public surface additionally exports loadPrivateKey, InvalidCredentialError, LoadPrivateKeyResult, PrivateKeyCredential"
  - "docs/domain/server-state-transitions.md documents D-03 CONNECTED semantics and D-02's second-transition rule"
affects: [03-04-service-server-crud-and-credentials, activity-log-plans, redaction-plans]

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "Services reuse @noodara/ssh's key-validation rules through its public entrypoint rather than duplicating ACCEPTED_KEY_TYPES/RSA_MIN_MODULUS_BITS"

key-files:
  created: []
  modified:
    - apps/control-plane/package.json
    - pnpm-lock.yaml
    - packages/ssh/src/index.ts
    - packages/ssh/src/run-discovery.test.ts
    - docs/domain/server-state-transitions.md

key-decisions:
  - "loadPrivateKey/InvalidCredentialError exported additively from @noodara/ssh's index.ts with zero changes to key-loader.ts itself, keeping the additive-only contract change the plan required"
  - "D-03 CONNECTED semantics recorded as a new doc section rather than altering the existing Allowed-transitions/Reason-gated-edges tables, since no edge changed"

requirements-completed: [SERV-01, SERV-02]

# Metrics
duration: 24min
completed: 2026-09-15
---

# Phase 3 Plan 1: SSH workspace wiring and public key-loader export Summary

**apps/control-plane can now import @noodara/ssh directly, loadPrivateKey/InvalidCredentialError are part of the package's public surface (D-15), and the committed transition doc records D-03's CONNECTED session semantics.**

## Performance

- **Duration:** 24 min
- **Started:** 2026-09-15T18:14:00-06:00 (approx)
- **Completed:** 2026-09-15T18:38:14-06:00
- **Tasks:** 3 completed
- **Files modified:** 5

## Accomplishments
- `apps/control-plane` resolves `@noodara/ssh` from its own dependency graph, verified by an in-scope Node module-resolution check (not just typecheck), unblocking every later plan in this phase.
- `loadPrivateKey` and `InvalidCredentialError` are reachable from `@noodara/ssh`'s single `.` entrypoint via TDD (RED → GREEN), so future services validate SSH credentials with the adapter's own rules instead of duplicating them (D-15, T-3-10, T-3-15).
- `docs/domain/server-state-transitions.md` now states explicitly that CONNECTED means the last operation succeeded (not an open session), that `connectAndDiscover` never uses the `clean_close` edge, and names D-02's two post-connect second-transition edges (D-03, T-3-16) — with the transition table itself untouched.

## Task Commits

Each task was committed atomically:

1. **Task 1: Declare @noodara/ssh as a runtime dependency of apps/control-plane** - `decc774` (feat)
2. **Task 2: Export loadPrivateKey from @noodara/ssh (D-15)** - `884cb60` (test, RED), `8051238` (feat, GREEN)
3. **Task 3: Record D-03 CONNECTED semantics in the committed transition doc** - `7042679` (docs)

**Plan metadata:** pending (this SUMMARY + STATE/ROADMAP update)

_Note: Task 2 followed the plan-mandated RED/GREEN TDD cycle (no separate REFACTOR commit needed — the GREEN change was already minimal and additive)._

## Files Created/Modified
- `apps/control-plane/package.json` - Added `"@noodara/ssh": "workspace:*"` to `dependencies`, alphabetically after `@noodara/domain`
- `pnpm-lock.yaml` - Recorded the new `apps/control-plane` -> `packages/ssh` workspace link
- `packages/ssh/src/index.ts` - Added `export { InvalidCredentialError, loadPrivateKey } from './key-loader.js'` and `export type { LoadPrivateKeyResult, PrivateKeyCredential } from './key-loader.js'`, with a comment tying the addition to D-15/T-3-10/T-3-15
- `packages/ssh/src/run-discovery.test.ts` - Extended `EXPECTED_RUNTIME_EXPORTS` to the new 9-name sorted list and added a `public key-loader surface (D-15)` describe block covering a validation failure and `InvalidCredentialError`'s constructibility
- `docs/domain/server-state-transitions.md` - Added the `## Session lifecycle and CONNECTED semantics (D-03, phase 3)` section

## Decisions Made
- Additive-only export change: `packages/ssh/src/key-loader.ts` was read but never edited (`git diff --stat` shows no change for that file across the whole plan), preserving the plan's "no behaviour change" constraint.
- The new doc section was inserted between "Reason-gated edges" and "Connection-result mapping" rather than rewriting either existing table, since D-03 clarifies semantics without adding or removing any transition edge.
- Mirrored the same paragraph (translated to the skill's Spanish prose style) into `.claude/skills/noodara-domain-model/SKILL.md` §2.1 since that gitignored file was present in the working tree; the committed record of D-03 remains `docs/domain/server-state-transitions.md` per the plan.

## Deviations from Plan

None - plan executed exactly as written. One correction was made within Task 3 before committing: the first draft of the D-03 paragraph wrapped "CONNECTED" in backticks, which broke the plan's verbatim-sentence acceptance check (`grep -q 'CONNECTED means the last operation succeeded, not that a session is open\.'`); this was caught by running the verify command before committing and fixed to match the required sentence exactly, so no deviation reached the commit.

## Issues Encountered

None.

## User Setup Required

None - no external service configuration required.

## Next Phase Readiness

- Plan 03-04 (service Server CRUD and credentials) can now import both `@noodara/ssh`'s adapter surface and `loadPrivateKey` from `apps/control-plane` without any further wiring.
- `pnpm install`, `pnpm build`, `pnpm typecheck`, `pnpm lint`, `pnpm test` (622 tests passing), and `pnpm exec turbo boundaries` are all green after this plan.
- No blockers for the remaining Phase 3 plans identified.

---
*Phase: 03-servicios-de-aplicaci-n-activity-log-y-redacci-n*
*Completed: 2026-09-15*

## Self-Check: PASSED

All claimed files exist (apps/control-plane/package.json, packages/ssh/src/index.ts,
docs/domain/server-state-transitions.md) and all four task commits (decc774, 884cb60, 8051238,
7042679) are present in git history.
