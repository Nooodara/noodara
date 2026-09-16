---
phase: 03-servicios-de-aplicaci-n-activity-log-y-redacci-n
plan: 07
subsystem: api
tags: [postgres, drizzle, transactions, credentials, activity-log, tdd, security]

# Dependency graph
requires:
  - phase: 03-servicios-de-aplicaci-n-activity-log-y-redacci-n
    provides: "03-04's resolveServerServicesDeps/ServiceActor; 03-05's registerServer and the shared service-fixture.ts integration harness; 03-03's discovery_snapshots ON DELETE CASCADE FK; 03-06's row-lock-first transactional-service shape"
provides:
  - "deleteServer: the transactional SERV-03 delete service — exact-name confirmation (D-12), a same-transaction credential removal, a discovery_snapshots cascade, and a server.deleted event written before the rows disappear (D-14) so it outlives them"
affects: [03-08-connectAndDiscover, 03-09-trustFingerprint, 03-10]

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "deleteServer follows editServer's row-lock-first shape (SELECT ... FOR UPDATE as the first statement) but never re-validates or re-encodes anything — the only inputs are the id and a string to compare against the live row's name, so the whole service is guard -> write-event -> delete -> delete, no encode/validate step at all"
    - "Delete order inside the transaction is fixed by the FK graph, not by convenience: servers first (cascades discovery_snapshots via migration 0003's ON DELETE cascade), then credentials (servers.credential_id references it with ON DELETE no action) — deleting credentials first would violate that still-present reference while the servers row still exists"
    - "The activity event is written against the still-live row before either delete statement runs, so its { name, host } metadata is read off real data and the row's disappearance afterward has no way to invalidate it"

key-files:
  created:
    - apps/control-plane/src/services/delete-server.ts
    - tests/integration/services/delete-server.test.ts
  modified: []

key-decisions:
  - "deleteServer's success result carries only { ok: true, serverId } instead of a ServerView, per the plan's own D-19 scope note — the row no longer exists once the transaction commits, so there is nothing left to project into a view"
  - "No Postgres-error catch/translation block (unlike registerServer/editServer): delete has no uniqueness constraint that could produce a 23505 safety-net path, so the try/catch wrapper those two services need is simply absent here"

requirements-completed: [SERV-03, ACT-01]

# Metrics
duration: 25min
completed: 2026-09-15
---

# Phase 3 Plan 7: deleteServer Summary

**Transactional SERV-03 delete service — exact, case-sensitive, untrimmed name confirmation (D-12), a busy guard against an in-flight connect (D-11), and a same-transaction removal of the server, its credential and its discovery-snapshot history, gated by a `server.deleted` event written to the still-live row before any of it disappears (D-14).**

## Performance

- **Duration:** ~25 min
- **Started:** 2026-09-15T22:45:00Z (approx)
- **Completed:** 2026-09-15T22:55:00Z (approx)
- **Tasks:** 2 completed (TDD RED -> GREEN)
- **Files modified:** 2 (both new)

## Accomplishments

- `deleteServer` (`apps/control-plane/src/services/delete-server.ts`) opens exactly one `db.transaction`, starting with a `SELECT ... FOR UPDATE` on the target `servers` row (the same D-11/T-3-06 concurrency guard `editServer` established): a `CONNECTING` row returns `SERVER_BUSY` immediately and nothing is touched.
- Confirmation is a strict `input.confirmName !== row.name` comparison — no trimming, no case folding — against the live row's name (D-12); a mismatch returns `CONFIRMATION_MISMATCH` and deletes nothing.
- On a match, `writeActivityEvent(tx, ...)` fires `server.deleted` with metadata `{ name, host }` read off the still-live row, BEFORE either delete statement runs (D-14) — the event is provably older than the rows it describes and survives them.
- The `servers` row is deleted first (cascading `discovery_snapshots` via migration 0003's `ON DELETE cascade`), then the `credentials` row — the only order the FK graph allows, since `servers.credential_id` references `credentials.id` with `ON DELETE no action`.
- 9 integration tests (`tests/integration/services/delete-server.test.ts`) cover every `must_haves.truths` rule: `NOT_FOUND` for an unknown id, `SERVER_BUSY` on a `CONNECTING` row with the row left intact and no event, `CONFIRMATION_MISMATCH` for a case-differing name and for a whitespace-padded name (both leaving the row untouched), a full deletion proving zero `servers`/`credentials`/`discovery_snapshots` rows remain while the earlier `server.created` and new `server.deleted` events both survive with exact metadata, both actor kinds (`user` with `actorId`, `system` with a null `actorId`), isolation from an unrelated second server (its row, credential and one seeded snapshot all still present), and a no-credential-leak assertion on the result JSON.
- `pnpm test` (735 unit tests), `pnpm typecheck`, `pnpm lint` and `pnpm exec turbo boundaries` are all green; the full `tests/integration/services` suite (register-server + edit-server + delete-server, 49 tests) passes together with no stray `noodara.test=true` container left behind.

## Task Commits

Each task was committed atomically (TDD: test -> feat per task):

1. **Task 1 (RED): SERV-03 expectations** - `1b886e5` (test)
2. **Task 2 (GREEN): deleteServer** - `8b6349e` (feat)

**Plan metadata:** committed alongside this SUMMARY (see final commit below).

## Files Created/Modified

- `apps/control-plane/src/services/delete-server.ts` - `DeleteServerInput`, `DeleteServerFailureCode`, `DeleteServerResult`, `deleteServer`
- `tests/integration/services/delete-server.test.ts` - 9 tests covering `NOT_FOUND`/`SERVER_BUSY`/`CONFIRMATION_MISMATCH` (case and whitespace variants) results, the full cascade deletion with surviving audit trail, D-17 actor attribution, cross-server isolation and no-leak guarantees

## Decisions Made

- `deleteServer` returns `{ ok: true, serverId }` on success, not a `ServerView` — the plan's own D-19 scope note excludes `deleteServer` from the services that return a view, since the row is gone by the time the caller sees the result.
- No unique-violation catch/translation wrapper: unlike `registerServer`/`editServer`, delete has no uniqueness pre-check that could race a concurrent insert into a 23505, so the try/catch safety-net pattern those two services need has nothing to guard here and was correctly omitted.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug in this plan's own test file] Cross-server isolation test asserted on a stripped `ServerView` field**
- **Found during:** Task 2 GREEN verification (first full suite run: 1 of 9 failing)
- **Issue:** The "does not touch any other server" test read `other.credentialId` off the `registerServer` result — but `ServerView` deliberately omits `credentialId` (server-view.ts's own documented no-credential-leak contract) — so the value was always `undefined`, and `fetchCredentialRow(fixture, undefined)` returned nothing, making the assertion fail regardless of `deleteServer`'s actual (correct) behavior.
- **Fix:** Fetched the `other` server's row directly from `servers` via `fetchServerRow` before the delete and read `credentialId` off that raw row instead of the `ServerView`.
- **Files modified:** `tests/integration/services/delete-server.test.ts`
- **Verification:** Full suite re-run: 9/9 passing; `delete-server.ts` itself was not modified for this fix.
- **Committed in:** `8b6349e` (Task 2 commit, alongside the GREEN implementation)

---

**Total deviations:** 1 auto-fixed (Rule 1, confined to this plan's own test file — no change to `deleteServer`'s actual runtime behavior).
**Impact on plan:** None on SERV-03/ACT-01/D-11/D-12/D-14 behavior or scope.

## Issues Encountered

None beyond the one auto-fixed item documented above.

## User Setup Required

None — no external service configuration required.

## Next Phase Readiness

- `deleteServer` completes the third of this phase's transactional-service examples (after `registerServer` and `editServer`), demonstrating the "no re-validation, guard -> write-event -> delete" shape a later destructive or near-destructive operation in this phase should follow.
- `pnpm test` (735 passing), `pnpm typecheck`, `pnpm lint`, `pnpm exec turbo boundaries` all green; the combined `tests/integration/services` suite (49 tests) leaves no stray `noodara.test=true` container.
- No blockers for plan 03-08.

---
*Phase: 03-servicios-de-aplicaci-n-activity-log-y-redacci-n*
*Completed: 2026-09-15*

## Self-Check: PASSED

Both created source/test files and this SUMMARY are present on disk; both task commits
(1b886e5, 8b6349e) are present in git history.
