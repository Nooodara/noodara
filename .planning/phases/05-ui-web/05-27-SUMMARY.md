---
phase: 05-ui-web
plan: 27
subsystem: api
tags: [security, trust-on-first-use, ssh, fastify, drizzle, domain-state-machine, tdd]

# Dependency graph
requires:
  - phase: 05-ui-web (plan 19)
    provides: TrustFingerprintDialog client-side re-GET mitigation and HostKeyChangedBanner UI
  - phase: 05-ui-web (plan 01)
    provides: UF-01's original (incomplete) ERROR-only pendingFingerprint clear on edit
provides:
  - "canTrustFingerprint(status) domain predicate, derived directly from transition()'s own table"
  - "POST /api/servers/:id/trust-fingerprint requires { fingerprint } and promotes only via an atomic conditional UPDATE keyed on the row's live pending_fingerprint"
  - "409 FINGERPRINT_MISMATCH (mismatch, nothing promoted) and 409 SERVER_NOT_TRUSTABLE (illegal source status, never a 500) service/HTTP error codes"
  - "editServer clears pendingFingerprint/pendingFingerprintSeenAt on any identity-changing edit (host/sshPort/sshUser) regardless of the row's status, not only ERROR"
affects: [05-31 (TrustFingerprintDialog UI half), 05-VERIFICATION gap 6, trust-fingerprint-toctou.md todo]

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "Atomic conditional UPDATE (WHERE id = ... AND pending_fingerprint = $submitted) as the enforcement mechanism for a display/promote TOCTOU, not just a row lock"
    - "A pure domain predicate implemented by calling the real transition() inside a try/catch, rather than re-deriving a second hardcoded table"

key-files:
  created:
    - tests/integration/servers/trust-fingerprint-binding.test.ts
    - tests/integration/servers/edit-clears-pending-fingerprint.test.ts
  modified:
    - packages/domain/src/server/server-state.ts
    - packages/domain/src/server/server-state.test.ts
    - apps/control-plane/src/services/trust-fingerprint.ts
    - apps/control-plane/src/services/edit-server.ts
    - apps/control-plane/src/routes/servers.ts
    - apps/control-plane/src/routes/server-schemas.ts
    - apps/control-plane/src/routes/http-errors.ts
    - tests/integration/services/trust-fingerprint.test.ts
    - tests/integration/services/event-publishing.test.ts
    - tests/integration/services/edit-server.test.ts
    - tests/integration/activity/canary-full-flow.test.ts

key-decisions:
  - "canTrustFingerprint(status) is implemented by calling transition(status, 'PENDING', { reason: 'fingerprint_trusted' }) inside a try/catch, not a second hardcoded status list -- so it can never drift from transition()'s own table"
  - "Existing trustFingerprint() call sites (service-level integration tests, canary-full-flow.test.ts) updated to pass the now-required fingerprint field, reading the row's real pending value rather than hardcoding a format assumption"
  - "identityChanged for the pendingFingerprint clear stays a local host/sshPort/sshUser comparison, not classifyServerEdit's 'identity' category (which deliberately excludes sshUser) -- the two answer different questions and conflating them would be a silent behavior change to D-14's CONNECTED transition"

requirements-completed: [DETL-02]

duration: ~50min
completed: 2026-09-20
---

# Phase 05 Plan 27: Fingerprint-bound trust-fingerprint route Summary

**POST /api/servers/:id/trust-fingerprint now requires `{ fingerprint }` and promotes only via an atomic `WHERE pending_fingerprint = $submitted` conditional UPDATE (409 FINGERPRINT_MISMATCH otherwise), closing the backend half of the host-key trust-binding TOCTOU (gap 6 / WR-A-02).**

## Performance

- **Duration:** ~50 min (includes one ~6 min Testcontainers-backed integration run)
- **Started:** 2026-09-20T09:56Z (approx, first file read)
- **Completed:** 2026-09-20T10:14Z (last task commit)
- **Tasks:** 3
- **Files modified:** 13 (2 created, 11 modified)

## Accomplishments

- Closed the display/promote TOCTOU the todo describes: the trust route can no longer promote a `pending_fingerprint` the admin never actually saw. A submitted value that no longer matches the row's live pending fingerprint at promote time returns `409 FINGERPRINT_MISMATCH` and changes nothing (no status change, no activity event, no published event).
- Closed WR-A-02: an identity-changing edit (host/sshPort/sshUser) now clears a stale `pendingFingerprint`/`pendingFingerprintSeenAt` from **any** status, not only `ERROR` — the false premise (`pendingFingerprint` is only ever non-null while `ERROR`) is gone from both the code and its comments.
- Closed the `InvalidTransitionError`-as-500 path: trusting from a status the `fingerprint_trusted` edge cannot legally reach (e.g. `UNREACHABLE`) now returns a typed `409 SERVER_NOT_TRUSTABLE`, proven by an integration test that previously observed a real `500`.
- Added `canTrustFingerprint(status)` to `packages/domain`, a pure predicate that calls `transition()` itself (inside a try/catch) rather than re-deriving a second status table — proven exhaustively equal to "does `transition(status, 'PENDING', { reason: 'fingerprint_trusted' })` throw" across all six statuses.

## Task Commits

Each task was committed atomically:

1. **Task 1: Domain predicate + the two RED integration tests** — `af60933` (test)
2. **Task 2: GREEN — fingerprint-bound atomic promote and the new 409 codes** — `9edd34b` (fix)
3. **Task 3: GREEN — clear pendingFingerprint on every identity-changing edit, then full gate** — `48b2275` (fix)

_TDD note: this plan's three tasks map onto RED (Task 1) → GREEN (Tasks 2 and 3), each task's own commit containing the relevant test+implementation delta for that step, per the plan's own task boundaries rather than a single test-commit/feat-commit pair._

## Files Created/Modified

- `packages/domain/src/server/server-state.ts` — adds `canTrustFingerprint(status): boolean`
- `packages/domain/src/server/server-state.test.ts` — unit tests including the exhaustive iff-property test across all six statuses
- `tests/integration/servers/trust-fingerprint-binding.test.ts` (new) — 7 HTTP-level tests: mismatch, success, missing/empty body, TOCTOU flip, non-ERROR status, no-cookie
- `tests/integration/servers/edit-clears-pending-fingerprint.test.ts` (new) — 5 HTTP-level tests: UNREACHABLE host/port clear, CONNECTED host clear (composed with D-14), non-identity edit untouched, CONNECTING still SERVER_BUSY
- `apps/control-plane/src/services/trust-fingerprint.ts` — `fingerprint` required on `TrustFingerprintInput`; `canTrustFingerprint` guard before `transition()`; atomic conditional promote (`and(eq(servers.id, ...), eq(servers.pendingFingerprint, ...))`); `FINGERPRINT_MISMATCH`/`SERVER_NOT_TRUSTABLE` failure codes
- `apps/control-plane/src/services/edit-server.ts` — `identityChanged` hoisted out of any single status branch; applied unconditionally alongside (not replacing) the existing CONNECTED-branch status patch
- `apps/control-plane/src/routes/servers.ts` — trust route gains `body: TrustFingerprintBodySchema` and a `400` response entry; threads `request.body.fingerprint` into the service call
- `apps/control-plane/src/routes/server-schemas.ts` — adds `TrustFingerprintBodySchema = z.object({ fingerprint: z.string().min(1) }).strict()`
- `apps/control-plane/src/routes/http-errors.ts` — adds `FINGERPRINT_MISMATCH` and `SERVER_NOT_TRUSTABLE` to `ServiceErrorCode`/`SERVICE_ERROR_STATUS`, both `409`
- `tests/integration/services/trust-fingerprint.test.ts`, `tests/integration/services/event-publishing.test.ts`, `tests/integration/activity/canary-full-flow.test.ts` — existing `trustFingerprint()` call sites updated to pass the now-required `fingerprint` field (see Deviations)

## Decisions Made

- `canTrustFingerprint` calls `transition()` itself instead of re-deriving a second status table — guarantees it can never drift from the real transition rules, and the exhaustive property test in `server-state.test.ts` proves the equivalence rather than assuming it.
- `identityChanged` (the pendingFingerprint-clearing check) stays its own local `host !== row.host || sshPort !== row.sshPort || sshUser !== row.sshUser` comparison rather than reusing `classifyServerEdit`'s `'identity'` category, because that domain function deliberately excludes `sshUser` (it answers a narrower question: D-14's `CONNECTED -> PENDING` transition). Conflating the two would have silently changed which edits trigger D-14's transition.
- Error messages for `FINGERPRINT_MISMATCH` and `NO_PENDING_FINGERPRINT` are both generic strings that never echo either the submitted or stored fingerprint value, so the two codes cannot be used as an oracle for the current pending value's shape (the value itself is already public via `GET`, per D-16, but the response *shape* stays symmetric).

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 3 - Blocking] Updated existing `trustFingerprint()` call sites for the now-required `fingerprint` field**
- **Found during:** Task 2, `pnpm typecheck`
- **Issue:** Making `fingerprint` a required field on `TrustFingerprintInput` (per the plan's own Task 2 action) is a compile-breaking change for every pre-existing caller of the service function directly (not through the HTTP route): `tests/integration/services/trust-fingerprint.test.ts` (10 call sites), `tests/integration/services/event-publishing.test.ts` (2 call sites), `tests/integration/services/edit-server.test.ts` (2 call sites, its own UF-01 suite), and `tests/integration/activity/canary-full-flow.test.ts` (1 call site). None of these four files are in this plan's `files_modified` list.
- **Fix:** Updated every call site to pass `fingerprint`, reading the row's real live `pending_fingerprint` value where the test's own success path depends on a match (via a new `pendingFingerprintOf`/`rawServerRow` helper reused across the file, or the arrangement helper's own already-known return value), and passing an inert placeholder string where an earlier guard (`NOT_FOUND`/`SERVER_BUSY`/`NO_PENDING_FINGERPRINT`) returns before any fingerprint comparison is reached. `event-publishing.test.ts`'s `arrangeServerWithPendingFingerprint` helper now returns `{ serverId, fingerprint }` instead of just `serverId`.
- **Files modified:** `tests/integration/services/trust-fingerprint.test.ts`, `tests/integration/services/event-publishing.test.ts`, `tests/integration/services/edit-server.test.ts`, `tests/integration/activity/canary-full-flow.test.ts`
- **Verification:** `pnpm typecheck` exits 0; all four files run green as part of the 8-file, 90-test integration run below (no new tests added to these files — only call-site signatures changed).
- **Committed in:** `9edd34b` (Task 2 commit)

---

**Total deviations:** 1 auto-fixed (Rule 3 — blocking compile/test breakage from a deliberate, plan-specified type change)
**Impact on plan:** Necessary consequence of Task 2's own required action (making `fingerprint` non-optional). No scope creep — no new behavior was added to any of the four touched test files, only call-site signatures.

## Issues Encountered

- `pnpm test:integration`'s `global-setup.ts` runs a real `pnpm build` across the whole workspace, which fails locally without `NOODARA_API_ORIGIN` set (apps/web's `next.config.ts` fail-fasts on it). CI sets this env var at the workflow level (`ci.yml`/`nightly.yml`); it had to be exported manually in this shell (`export NOODARA_API_ORIGIN='http://localhost:3100'`) before any integration run. Not a regression from this plan — pre-existing local-environment gap, not touched here.
- Per hard rule 13, the full `pnpm test:integration` suite (~32 min) was **not** run. Instead, the scoped set of files this plan created or that exercise the services/routes it modified was run explicitly:
  `tests/integration/servers/trust-fingerprint-binding.test.ts`, `tests/integration/servers/edit-clears-pending-fingerprint.test.ts`, `tests/integration/services/trust-fingerprint.test.ts`, `tests/integration/services/event-publishing.test.ts`, `tests/integration/services/edit-server.test.ts`, `tests/integration/activity/canary-full-flow.test.ts`, `tests/integration/activity/canary-http.test.ts`, `tests/integration/routes/servers-crud.test.ts`.
  Result: **8 files passed, 90/90 tests passed, 0 failed, 0 skipped**, 349.96s. The orchestrator is expected to run the full suite at the wave boundary per the same hard rule.

## RED Evidence (Task 1)

Both integration files, run against the pre-fix code, failed on real assertions (never a harness error):

```
tests/integration/servers/edit-clears-pending-fingerprint.test.ts (5 tests | 3 failed)
  × clears pendingFingerprint/pendingFingerprintSeenAt on a host change from UNREACHABLE
  × clears pendingFingerprint/pendingFingerprintSeenAt on an sshPort change from UNREACHABLE
  × clears pendingFingerprint/pendingFingerprintSeenAt on a host change from CONNECTED, alongside the existing D-14 identity_changed transition
    AssertionError: expected 'ssh-ed25519 SHA256:STALEEEEEEEEEEEEEE…' to be null

tests/integration/servers/trust-fingerprint-binding.test.ts
  × returns 409 FINGERPRINT_MISMATCH and promotes nothing when the submitted fingerprint does not match pending
    AssertionError: expected 200 to be 409
  × returns 400 VALIDATION_FAILED and promotes nothing when the body has no fingerprint
    AssertionError: expected 200 to be 400
  × returns 400 VALIDATION_FAILED and promotes nothing for an empty-string fingerprint
    AssertionError: expected 200 to be 400
  × never promotes a fingerprint that changed after the admin last saw it (TOCTOU)
    AssertionError: expected 200 to be 409
  × returns a typed 409 SERVER_NOT_TRUSTABLE, never a 500, when trusting from a non-ERROR status
    AssertionError: expected 500 to be 409   <-- confirms the InvalidTransitionError-as-500 bug directly

Test Files  2 failed (2)
     Tests  8 failed | 4 passed (12)
```

The 4 pre-existing passes (200-success path, 401-no-cookie, still-SERVER_BUSY-on-CONNECTING, name-only-edit-untouched) confirm the RED failures are scoped to exactly the new behavior, not harness breakage.

## Full Gate Results (Task 3)

- `pnpm lint` — 9/9 packages, exit 0
- `pnpm typecheck` — 8/8 packages, exit 0
- `pnpm boundaries` — 598 files across 6 packages, no issues
- `pnpm test` (unit) — **107 files, 1393 tests, all passed**, 5.60s
- Scoped integration run (see Issues Encountered) — **8 files, 90 tests, all passed**, 349.96s
- `git diff --stat` shows no file under `apps/control-plane/drizzle/` or any migration directory (verification item 3) — confirmed, no schema change

## Todo Disposition: `.planning/todos/pending/2026-09-19-trust-fingerprint-toctou.md`

Per the todo's own 4-item test plan:

1. **Item 1 (route body + atomic promote):** Closed by this plan. Backend now requires `{ fingerprint }` and promotes via an atomic conditional UPDATE; mismatch is `409 FINGERPRINT_MISMATCH`.
2. **Item 2 (mismatch/promote/concurrency integration tests):** Closed by this plan's `trust-fingerprint-binding.test.ts` — including a TOCTOU-flip test standing in for the "pending value changes between display and click" scenario the todo describes (arranged via a direct, sequenced row write, not genuine thread-level concurrency — the transaction's own `SELECT ... FOR UPDATE` row lock already serializes any truly concurrent write against the same transaction, so the vulnerability class this plan closes is specifically the display-time-vs-promote-time gap, which the flip test reproduces exactly).
3. **Item 3 (UI sends the exact fingerprint it displayed; drop the client-side re-GET):** **NOT closed by this plan** — out of scope by the plan's own objective ("Close ... on the backend, where it is actually closable"). `apps/web/src/components/TrustFingerprintDialog.tsx` still POSTs with no body at all (confirmed by reading; its own header comment cites the pre-this-plan route contract). **As of this plan, that UI call will receive `400 VALIDATION_FAILED` on every trust attempt** until Plan 05-31 updates it to send `{ fingerprint }` and handle `FINGERPRINT_MISMATCH`. This is a real, currently-broken user-facing flow, not merely a documentation gap — flagged here explicitly for whoever runs 05-31 next.
4. **Item 4 (activity event records the promoted fingerprint):** Already satisfied before this plan — confirmed by reading `trust-fingerprint.ts`: `metadata: { previousFingerprint, newFingerprint }` was already present and is unchanged. No duplicate work done.

**Verdict: the todo cannot be closed yet.** Item 3 is a genuine remaining requirement, not a formality — the trust-fingerprint feature is currently non-functional end-to-end in the shipped UI until 05-31 lands. Recommend keeping the todo open (or retitling it to track only the UI half) until 05-31 completes.

## Threat Flags

None — every new surface (the `fingerprint` body field, the conditional UPDATE, the `canTrustFingerprint` guard) was named in this plan's own `<threat_model>` and disposed there (all `mitigate` except the already-accepted D-16 fingerprint-is-public disclosure item).

## Next Phase Readiness

- Backend trust-fingerprint path is fingerprint-bound, atomic and fully typed (no 500 reachable from a legitimate request).
- **Blocker for 05-31:** `TrustFingerprintDialog.tsx` must be updated to send `{ fingerprint }` in its POST body before the "Trust new fingerprint" UI action works at all (it will 400 in its current form starting from this plan's merge).
- `docs/domain/server-state-transitions.md` needed no changes — no transition edge changed, only a new guard that rejects illegal attempts before `transition()` is reached.

---
*Phase: 05-ui-web*
*Completed: 2026-09-20*

## Self-Check: PASSED

- FOUND: .planning/phases/05-ui-web/05-27-SUMMARY.md
- FOUND commit af60933 (test)
- FOUND commit 9edd34b (fix)
- FOUND commit 48b2275 (fix)
- FOUND: packages/domain/src/server/server-state.ts
- FOUND: tests/integration/servers/trust-fingerprint-binding.test.ts
- FOUND: tests/integration/servers/edit-clears-pending-fingerprint.test.ts
