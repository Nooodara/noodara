---
phase: 03-servicios-de-aplicaci-n-activity-log-y-redacci-n
plan: 06
subsystem: api
tags: [postgres, drizzle, transactions, credentials, state-machine, activity-log, tdd, security]

# Dependency graph
requires:
  - phase: 03-servicios-de-aplicaci-n-activity-log-y-redacci-n
    provides: "03-04's resolveServerServicesDeps/ServiceActor/credential-store.ts/server-view.ts; 03-05's registerServer and the shared service-fixture.ts integration harness; 03-02's classifyServerEdit and server-state.ts's transition()"
provides:
  - "editServer: the transactional SERV-02 edit service — field edits, in-place credential replacement (D-13), and D-14's two reason-gated transitions (identity_changed / clean_close), gated by a SELECT ... FOR UPDATE row lock (D-11)"
affects: [03-07-deleteServer, 03-08-connectAndDiscover, 03-09-trustFingerprint]

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "editServer follows registerServer's transactional-service shape (validate -> encode/prepare -> db.transaction with pre-checks -> writeActivityEvent(tx, ...) -> toServerView) but adds a SELECT ... FOR UPDATE row lock as its very first statement, since editing (unlike registering) must contend with a concurrently in-flight connectAndDiscover on the same row"
    - "A status patch is accumulated into a typed Partial<Pick<...>> object (defaulting to {}) rather than a conditional literal, so the final servers UPDATE never assigns a status column at all for any non-CONNECTED starting status — the column is simply absent from .set(), not overwritten with its own current value"
    - "The only read this service performs against the credentials table is `select type`, for the returned ServerView's credentialType — verified by a grep acceptance criterion that treats any mention of the encrypted-value column or a decrypt call as a SERV-02 regression, including inside comments"

key-files:
  created:
    - apps/control-plane/src/services/edit-server.ts
    - tests/integration/services/edit-server.test.ts
  modified: []

key-decisions:
  - "The doc-comment describing SERV-02's own prohibition was worded to avoid literally containing the strings `credentials.encryptedValue` / `decodeCredential` — the plan's own grep-based acceptance criterion (`grep -c \"decodeCredential\\|encryptedValue:.*select\\|credentials.encryptedValue\"` == 0) is a blunt substring match with no comment-awareness, so a purely explanatory comment about the prohibition tripped the same check meant to catch a violation of it"
  - "currentKeyVersion(tx) and encodeCredential(...) both run inside the transaction (against tx, not deps.db), unlike registerServer's precedent of computing the key version against deps.db before opening its transaction — the plan's task 2 explicitly places credential encoding as step 5 of the single all-inside-one-transaction sequence, and ActivityWriteHandle (the type currentKeyVersion/writeActivityEvent both accept) is the common PgDatabase base both a pool handle and a transaction handle satisfy"
  - "The uniqueness pre-check test for NAME_TAKEN uses an exact-duplicate name rather than a case-differing one: validateServerName rejects uppercase input outright (03-CONTEXT/identity.ts's own established rule, matching register-server.test.ts's own equivalent test, which also cannot literally construct a case-differing valid name) — the lower() unique index still guards the exact-duplicate collision path, which is what the test now asserts"

requirements-completed: [SERV-02, ACT-01]

# Metrics
duration: 40min
completed: 2026-09-15
---

# Phase 3 Plan 6: editServer Summary

**Transactional SERV-02 edit service — field edits, in-place credential replacement that never reads back the previous credential (D-13), and D-14's two reason-gated transitions (identity_changed / clean_close) fired only from CONNECTED, all behind a row lock that closes the D-11 concurrent-connect race.**

## Performance

- **Duration:** ~40 min
- **Started:** 2026-09-15T22:15:00Z (approx)
- **Completed:** 2026-09-15T22:30:00Z (approx)
- **Tasks:** 2 completed (TDD RED -> GREEN)
- **Files modified:** 2 (both new)

## Accomplishments

- `editServer` (`apps/control-plane/src/services/edit-server.ts`) opens exactly one `db.transaction` whose first statement is `SELECT ... FOR UPDATE` on the target `servers` row — the row lock that stops a concurrently in-flight `connectAndDiscover` from writing status or fingerprint data onto a row being edited (D-11/T-3-06). A `CONNECTING` row returns `SERVER_BUSY` immediately, before any other check runs, leaving the row byte-identical and writing no activity event.
- Every supplied field (`name`, `host`, `sshPort`, `sshUser`) is validated with the same `packages/domain` validators `registerServer` uses; a credential replacement is validated by `encodeCredential` — never by reading or decrypting the row's existing credential. The only column this service ever reads off the `credentials` table is `type`, used solely to populate the returned `ServerView.credentialType`.
- A credential replacement is an in-place `UPDATE` of the same `credentials.id` (D-13): `encrypted_value`, `key_version` and `type` are overwritten and `updated_at` is stamped with `deps.now()`; `servers.credential_id` never changes and no new `credentials` row is ever inserted.
- `classifyServerEdit` + `transition()` fire only when the row was `CONNECTED` at edit time: an identity change (host or port) moves it to `PENDING` with reason `identity_changed` and clears both fingerprint columns; an access change (ssh user or credential) moves it to `DISCONNECTED` with reason `clean_close`, fingerprint preserved; a plain rename or any edit while `CONNECTED` and unrelated to identity/access leaves the status untouched. For every other starting status, `transition()` is never called and the `status` column is never included in the update at all.
- Exactly one `server.updated` activity event is written per real edit, with metadata `{ changedFields, credentialReplaced }` — `changedFields` is a sorted array drawn only from `['host','name','sshPort','sshUser']`, never an old or new value (D-16). An edit that changes nothing writes no event at all (documented discretionary decision).
- 23 integration tests (`tests/integration/services/edit-server.test.ts`) cover every `must_haves.truths` rule: `NOT_FOUND`, `SERVER_BUSY` with byte-identical row, `NAME_TAKEN`/`HOST_TAKEN` self-excluding collisions, `VALIDATION_FAILED`, `INVALID_CREDENTIAL` with the stored envelope left untouched, the in-place credential swap (same `credentials.id`, different `encrypted_value`, `key_version` set, `updated_at` changed), a credential-kind switch, no-leak assertions on the result JSON, all four `CONNECTED` classification outcomes (identity/access/none, both identity sub-cases for host and port), every non-`CONNECTED` status left alone on a host edit, the no-op-edit-writes-nothing case, `changedFields` shape/sort/no-value assertions, and both actor kinds.
- `pnpm test` (735 unit tests), `pnpm typecheck`, `pnpm lint` and `pnpm exec turbo boundaries` are all green; the new integration suite runs clean with no stray `noodara.test=true` container.

## Task Commits

Each task was committed atomically (TDD: test -> feat per task):

1. **Task 1 (RED): SERV-02 expectations** - `068ebdf` (test)
2. **Task 2 (GREEN): editServer** - `49783bd` (feat)

**Plan metadata:** committed alongside this SUMMARY (see final commit below).

## Files Created/Modified

- `apps/control-plane/src/services/edit-server.ts` - `EditServerInput`, `EditServerFailureCode`, `EditServerResult`, `editServer`
- `tests/integration/services/edit-server.test.ts` - 23 tests covering NOT_FOUND/SERVER_BUSY/VALIDATION_FAILED/NAME_TAKEN/HOST_TAKEN/INVALID_CREDENTIAL results, D-13 in-place credential replacement, D-14's two reason-gated transitions and their non-CONNECTED no-op counterpart, D-16 metadata shape, D-17 actor attribution, and no-op-edit/no-leak guarantees

## Decisions Made

- `currentKeyVersion`/`encodeCredential` run against the open transaction handle (`tx`), not `deps.db`, per this plan's own step ordering (all of task 2's steps happen inside one `db.transaction`) — a deliberate departure from `registerServer`'s precedent of computing the key version before opening its transaction, since `editServer`'s row lock makes the whole operation transaction-scoped from the start.
- The SERV-02 prohibition comment in `edit-server.ts` was worded to avoid literally containing the substrings the plan's own grep acceptance check treats as a violation (`decodeCredential`, `credentials.encryptedValue`) — the check is a blunt substring match with no awareness of comments versus code, so an explanatory comment about the prohibition originally tripped the same check meant to detect breaking it.
- The NAME_TAKEN integration test uses an exact-duplicate name rather than a genuinely case-differing one, since `validateServerName` rejects uppercase input outright — a case-differing *valid* slug cannot exist, so the meaningful assertion is that the `lower()` unique index still catches the exact-duplicate collision path (mirrors `register-server.test.ts`'s own equivalent test, which has the identical structural limitation).

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug in this plan's own test file] Two test-arrangement bugs found during GREEN**
- **Found during:** Task 2 GREEN verification (first full suite run: 6 of 23 failing)
- **Issue:** (a) `fetchActivityEventsFor` returns every activity event for the entity, but `registerFixtureServer`'s own arrangement already writes a `server.created` event for the same server before the edit under test runs — five assertions destructured `const [event] = await fetchActivityEventsFor(...)` and got the arrangement's `server.created` event instead of the `server.updated` event actually being tested. (b) The NAME_TAKEN collision test called `other.name.toUpperCase()`, which `validateServerName` rejects outright as invalid input (uppercase is never accepted, matching `identity.ts`'s documented rule and `register-server.test.ts`'s own equivalent test's structural limitation) — the edit failed with `VALIDATION_FAILED` before ever reaching the uniqueness check the test meant to exercise.
- **Fix:** (a) Added `fetchServerUpdatedEvent`, a helper that filters to `action = 'server.updated'` for the entity, and switched the five affected assertions to use it. (b) Changed the test to submit an exact-duplicate (already-lowercase) name, which still exercises the `lower()` unique-index collision path — the only case-insensitive collision reachable through valid input.
- **Files modified:** `tests/integration/services/edit-server.test.ts`
- **Verification:** Full suite re-run: 23/23 passing; `edit-server.ts` itself was not modified for this fix.
- **Committed in:** `49783bd` (Task 2 commit, alongside the GREEN implementation)

**2. [Rule 1 - Bug in this plan's own grep acceptance criterion vs. its own doc comment] Reworded `edit-server.ts`'s header comment**
- **Found during:** Task 2 GREEN, running the plan's own acceptance-criteria greps after the suite passed
- **Issue:** `grep -c "decodeCredential\|encryptedValue:.*select\|credentials.encryptedValue" apps/control-plane/src/services/edit-server.ts` returned 1, not the required 0 — the file's own top-of-file comment *explaining* the SERV-02 prohibition literally named `credentials.encryptedValue` and `decodeCredential` as the things never done, which is exactly what the substring-only grep flags.
- **Fix:** Reworded the comment to describe the same prohibition without using those literal substrings (e.g. "never selects the encrypted envelope column" instead of naming the column).
- **Files modified:** `apps/control-plane/src/services/edit-server.ts`
- **Verification:** `grep -c "decodeCredential\|encryptedValue:.*select\|credentials.encryptedValue" apps/control-plane/src/services/edit-server.ts` now returns 0; full suite, typecheck, lint and boundaries re-run green.
- **Committed in:** `49783bd` (Task 2 commit)

---

**Total deviations:** 2 auto-fixed (both Rule 1, both confined to this plan's own test file and a doc comment — no change to `editServer`'s actual runtime behavior).
**Impact on plan:** None on SERV-02/ACT-01/D-11/D-13/D-14/D-16 behavior or scope.

## Issues Encountered

None beyond the two auto-fixed items documented above.

## User Setup Required

None — no external service configuration required.

## Next Phase Readiness

- `editServer` is the second working example (after `registerServer`) of this phase's transactional-service + D-16 activity-event pattern, now additionally demonstrating the row-lock-first shape a later mutating service on an existing row (e.g. `deleteServer`, plan 03-07) should follow when contention with `connectAndDiscover` is possible.
- `pnpm test` (735 passing), `pnpm typecheck`, `pnpm lint`, `pnpm exec turbo boundaries` all green; the new integration suite leaves no stray `noodara.test=true` container.
- No blockers for plan 03-07.

---
*Phase: 03-servicios-de-aplicaci-n-activity-log-y-redacci-n*
*Completed: 2026-09-15*

## Self-Check: PASSED

Both created source/test files and this SUMMARY are present on disk; both task commits
(068ebdf, 49783bd) are present in git history.
