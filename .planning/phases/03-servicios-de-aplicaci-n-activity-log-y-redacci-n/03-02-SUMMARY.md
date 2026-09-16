---
phase: 03-servicios-de-aplicaci-n-activity-log-y-redacci-n
plan: 02
subsystem: database
tags: [packages/domain, discovery, server-state, activity-log, pure-functions, vitest]

# Dependency graph
requires:
  - phase: 01-dominio-persistencia-y-autenticaci-n
    provides: server-state.ts (transition/canTransition/TransitionReason), activity-event.ts (AUTH_ACTIONS, SensitiveMetadataError guard)
  - phase: 02-adaptador-ssh-aislado-y-probado-con-testcontainers
    provides: discovery/types.ts (DiscoveryFacts, DiscoveryCheck, DiscoveryCheckStatus)
provides:
  - "mergeDiscoveryFacts(current, incoming): DiscoveryFacts — null-never-overwrites merge (D-07)"
  - "classifySnapshotOutcome(checks): 'ok' | 'partial' | 'failed' — pure snapshot classification (D-06)"
  - "classifyServerEdit(before, after): 'none' | 'identity' | 'access' — pure edit classification (SERV-02, D-14)"
  - "SERVER_ACTIONS (6-entry tuple) and ActivityAction = AuthAction | ServerAction (ACT-01, D-16)"
affects: [03-05-registerServer, 03-06-editServer, 03-07-deleteServer, 03-08-connectAndDiscover, 03-09-trustFingerprint]

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "Pure classification functions return a discriminated string union, never perform side effects or transitions themselves — callers map the returned classification to transition() explicitly"
    - "Nullish coalescing (??) for null-never-overwrites merges, since false/0 must be treated as real values, not absences"

key-files:
  created:
    - packages/domain/src/discovery/merge-facts.ts
    - packages/domain/src/discovery/merge-facts.test.ts
    - packages/domain/src/server/classify-edit.ts
    - packages/domain/src/server/classify-edit.test.ts
  modified:
    - packages/domain/src/discovery/index.ts
    - packages/domain/src/server/index.ts
    - packages/domain/src/activity/activity-event.ts
    - packages/domain/src/activity/activity-event.test.ts

key-decisions:
  - "InvalidActivityActionError's message wording changed from 'Unknown auth action' to 'Unknown activity action' since the guard now covers both auth.* and server.* namespaces; the one caller (writeActivityEvent) does not depend on the message text"
  - "classifyServerEdit's two input interfaces (ServerIdentityFields, ServerAccessFields) deliberately omit `name` — renaming a server is neither an identity nor an access change per plan spec"

patterns-established:
  - "Pattern: exhaustive boolean-combination truth tables (it.each over 2^n rows) for pure classification functions, to mechanically satisfy the >=95% branch-coverage gate on packages/domain"

requirements-completed: [DISC-03, SERV-02, ACT-01]

# Metrics
duration: 28min
completed: 2026-09-16
---

# Phase 3 Plan 2: Domain Pure Functions for Services Summary

**Three pure `packages/domain` additions — null-safe discovery fact merging, edit classification, and a widened six-action `server.*` activity union — all at 100% statement/branch coverage.**

## Performance

- **Duration:** 28 min
- **Started:** 2026-09-16T00:55:00Z
- **Completed:** 2026-09-16T01:23:08Z
- **Tasks:** 3
- **Files modified:** 8

## Accomplishments
- `mergeDiscoveryFacts` + `classifySnapshotOutcome`: a null incoming fact never overwrites a known current value (D-07), `false`/`0` are real values, and snapshot outcome (`ok`/`partial`/`failed`) is derived purely from checks (D-06), verified by a per-key exhaustive table over all 12 `DiscoveryFacts` fields.
- `classifyServerEdit`: a pure `none | identity | access` classification from before/after host/port/user/credentialReplaced (SERV-02, D-14 of phase 1), proven by an exhaustive 16-row truth table; identity wins over access when both change together; `name` is deliberately excluded.
- Activity action union widened with `SERVER_ACTIONS` (6 entries: `server.created`, `server.updated`, `server.deleted`, `server.connection_attempted`, `server.discovery_completed`, `server.fingerprint_trusted`) and `ActivityAction = AuthAction | ServerAction` (ACT-01, D-16); `buildActivityEvent`'s runtime guard now checks membership in the combined set, `SensitiveMetadataError` continues to fire for a `server.created` event with a `credential` key, and all 8 existing `AUTH_ACTIONS` plus every existing auth caller still typecheck and pass unchanged.

## Task Commits

Each task was committed atomically (TDD: test → feat per task):

1. **Task 1: mergeDiscoveryFacts + classifySnapshotOutcome (D-06, D-07)**
   - RED: `42d778e` (test)
   - GREEN: `e5c5228` (feat)
2. **Task 2: classifyServerEdit (SERV-02, D-14 of phase 1)**
   - RED: `19981cb` (test)
   - GREEN: `05646ca` (feat, includes a lint fix to the RED test's array-type syntax)
3. **Task 3: Widen the activity action union with the six server.* actions (ACT-01, D-16)**
   - RED: `7cbbb81` (test)
   - GREEN: `519235b` (feat)

**Plan metadata:** committed alongside this SUMMARY (see final commit below).

## Files Created/Modified
- `packages/domain/src/discovery/merge-facts.ts` - `mergeDiscoveryFacts`, `classifySnapshotOutcome`, `SnapshotOutcome`
- `packages/domain/src/discovery/merge-facts.test.ts` - exhaustive per-key null-never-overwrites table + snapshot classification cases
- `packages/domain/src/discovery/index.ts` - added `export * from './merge-facts.js'`
- `packages/domain/src/server/classify-edit.ts` - `classifyServerEdit`, `EditClassification`, `ServerIdentityFields`, `ServerAccessFields`
- `packages/domain/src/server/classify-edit.test.ts` - exhaustive 16-row truth table over host/port/user/credentialReplaced
- `packages/domain/src/server/index.ts` - added `export * from './classify-edit.js'`
- `packages/domain/src/activity/activity-event.ts` - `SERVER_ACTIONS`, `ServerAction`, `ActivityAction`; widened `ActivityEvent.action`/`BuildActivityEventInput.action`; `InvalidActivityActionError` message updated
- `packages/domain/src/activity/activity-event.test.ts` - `describe('server actions (ACT-01, D-16)')` block, unknown-action wording assertion

## Decisions Made
- `InvalidActivityActionError`'s message wording changed to "Unknown activity action" (from "Unknown auth action") since the guard now spans both namespaces — no caller depended on the old text.
- `classifyServerEdit` keeps `name` out of its input interfaces entirely rather than accepting-and-ignoring it, so a caller that mistakenly passes it gets a compile error, not silent ignoring.

## Deviations from Plan

None - plan executed exactly as written. One minor in-flow fix: the RED test for Task 2 used `Array<T>` syntax, which the repo's ESLint config forbids (`@typescript-eslint/array-type`); fixed to `T[]` before the GREEN commit (Rule 3 - blocking lint error, trivial syntax-only change, folded into the GREEN commit for that task).

## Issues Encountered

None.

## User Setup Required

None - no external service configuration required.

## Next Phase Readiness

- `mergeDiscoveryFacts`, `classifySnapshotOutcome`, `classifyServerEdit`, and the widened `ActivityAction`/`SERVER_ACTIONS` are all reachable from `@noodara/domain/discovery`, `@noodara/domain/server`, and `@noodara/domain/activity` respectively, ready for plan 03-05 through 03-09's application services to consume as thin orchestration.
- `packages/domain` coverage confirmed at 100% statements/branches (full `pnpm test --coverage` run), comfortably above the 95% QA-02 gate; `pnpm typecheck`, `pnpm lint`, and `pnpm boundaries` all green across the whole monorepo.
- No blockers for the next plan (03-03, migration `0003` for `discovery_snapshots` and `docker_compose_version`).

---
*Phase: 03-servicios-de-aplicaci-n-activity-log-y-redacci-n*
*Completed: 2026-09-16*
