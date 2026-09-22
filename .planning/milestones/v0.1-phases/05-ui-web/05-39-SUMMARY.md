---
phase: 05-ui-web
plan: 39
subsystem: server-connection-domain
tags: [security, tdd, fingerprint, gap-closure, blocker]
requires:
  - phase: 05-ui-web (plan 38)
    provides: "applyConnectionResult clears a parked pendingFingerprint on success and on every non-HOST_KEY_CHANGED failure; connect-and-discover.ts nulls pendingFingerprintSeenAt in lockstep"
provides:
  - "trustFingerprint refuses to promote a pending fingerprint unless row.lastErrorCode === 'HOST_KEY_CHANGED', independent of the domain-layer fix in 05-38"
  - "the guard is repeated inside the conditional UPDATE's WHERE clause as TOCTOU defence in depth"
  - "real-HTTP integration coverage for the bypass sequence (two different non-host-key error codes, plus the success-supersedes variant)"
affects: [phase 05 gap closure round 2 wave 3/4 (05-40, 05-46 full gate)]
tech-stack:
  added: []
  patterns:
    - "A pending-state-promoting service gate is enforced twice: once as an early typed-refusal guard, and once as a repeated predicate inside the same transaction's conditional UPDATE WHERE clause, documented as defence in depth against a future refactor rather than the primary control"
key-files:
  created: []
  modified:
    - apps/control-plane/src/services/trust-fingerprint.ts
    - tests/integration/servers/trust-fingerprint-binding.test.ts
key-decisions:
  - "Reused the existing SERVER_NOT_TRUSTABLE code (already 409, already exhaustively mapped, already handled by the dialog) instead of inventing a new failure code, per the plan's explicit instruction"
  - "arrangePendingFingerprint's defaults now include lastErrorCode: 'HOST_KEY_CHANGED', since that is the only row shape a real HOST_KEY_CHANGED connect can produce; overrides still spread last"
requirements-completed: [SERV-04]
duration: 30min
completed: 2026-09-20
---

# Phase 05 Plan 39: Backend host-key trust boundary gate Summary

Closed the phase's one BLOCKER (05-VERIFICATION.md gap 6 / 05-REVIEW.md GR-01): `trustFingerprint` now refuses to promote a `pending_fingerprint` unless the server's current recorded failure (`row.lastErrorCode`) is genuinely `HOST_KEY_CHANGED`, enforced independently in the backend rather than only by the web UI's identical `apps/web/src/lib/detail-state.ts` gating.

## What Was Built

### Task 1 — RED: real-HTTP bypass coverage (commit `b93ab6c`)

Added `lastErrorCode: 'HOST_KEY_CHANGED'` to `arrangePendingFingerprint`'s default `.set({...})` in `tests/integration/servers/trust-fingerprint-binding.test.ts` (the three pre-existing cases that relied on this helper — FINGERPRINT_MISMATCH, the 200-promotes happy path, and the TOCTOU case — needed no further edits, since they only override `pendingFingerprint`/`status` and now inherit the correct `HOST_KEY_CHANGED` default). Added five new test cases for the bypass sequence:

- Case 1: a parked `HOST_KEY_CHANGED` fingerprint superseded by a later `AUTH_FAILED` (two-step arrangement: `arrangePendingFingerprint` then a second explicit `db.update(servers).set({ lastErrorCode: 'AUTH_FAILED' })`).
- Case 2: same bypass under `COMMAND_TIMEOUT`, proving the gate is not an `AUTH_FAILED` special case.
- Case 3: the success-supersedes variant (`status: 'CONNECTED'`, `lastErrorCode: null`, `pendingFingerprint` left present).
- Case 5 (info-disclosure): the 409 body has exactly the keys `error`/`message`, `message` never contains the submitted fingerprint value or the words `password`/`privateKey`/`credential`, and `error` is one of the five declared `TrustFingerprintFailureCode` values.
- Case 4 (happy path) needed no new test — the existing "returns 200 and promotes…" test already covers it and keeps passing via the helper default fix.

RED output (literal, captured before Task 2's fix):

```
 ❯ tests/integration/servers/trust-fingerprint-binding.test.ts (11 tests | 3 failed) 75145ms
   ❯ POST /api/servers/:id/trust-fingerprint binds to the fingerprint the admin actually saw (gap 6, T-5G-27) (11)
     × returns 409 SERVER_NOT_TRUSTABLE and promotes nothing when a later AUTH_FAILED supersedes the parked HOST_KEY_CHANGED (gap 6 / GR-01 bypass, case 1) 7117ms
     × returns 409 SERVER_NOT_TRUSTABLE and promotes nothing when a later COMMAND_TIMEOUT supersedes the parked HOST_KEY_CHANGED (gap 6 / GR-01 bypass, case 2) 7445ms
     × the refusal body for the superseded-parking bypass leaks nothing (gap 6 / GR-01 bypass, case 5) 7145ms

 FAIL  ... case 1
AssertionError: expected 200 to be 409 // Object.is equality
 FAIL  ... case 2
AssertionError: expected 200 to be 409 // Object.is equality
 FAIL  ... case 5
AssertionError: expected 200 to be 409 // Object.is equality

 Test Files  1 failed (1)
      Tests  3 failed | 8 passed (11)
```

Cases 1, 2 and 5 failed exactly for the bypass reason: the route returned 200 and promoted `FP_B` into `host_fingerprint` even though the parking `HOST_KEY_CHANGED` had already been superseded — proving the pre-fix code path is reachable through the real HTTP route. Case 3 (success-supersedes) and the existing happy-path test both already passed at RED time, because `canTrustFingerprint('CONNECTED')` already refuses a `CONNECTED`-status trust attempt on its own (a pre-existing, unrelated guard) — this is called out explicitly rather than silently, per the plan's own instruction to state which guard produced the response.

### Task 2 — GREEN: the lastErrorCode gate (commit `a23cbc3`)

In `apps/control-plane/src/services/trust-fingerprint.ts`:

- Added a fifth guard inside the transaction, placed after `canTrustFingerprint(row.status)` and before `transition(...)`:
  ```ts
  if (row.lastErrorCode !== 'HOST_KEY_CHANGED') {
    return {
      ok: false,
      code: 'SERVER_NOT_TRUSTABLE',
      message: 'Server has no unresolved host-key change to trust',
    };
  }
  ```
- Added `eq(servers.lastErrorCode, 'HOST_KEY_CHANGED')` as a third predicate in the conditional UPDATE's `and(...)`, alongside the existing `eq(servers.id, row.id)` and `eq(servers.pendingFingerprint, input.fingerprint)`, with an inline comment documenting it as defence in depth against a future refactor that moves the guard, splits the transaction, or drops the `SELECT ... FOR UPDATE` lock — not the primary control.
- Updated the function's doc comment to state the new invariant, cite gap 6 / GR-01 and CLAUDE.md §2.3, and note that `apps/web/src/lib/detail-state.ts`'s identical gating is now a UX convenience layered on an enforced backend rule.
- No new failure code was introduced; `TrustFingerprintFailureCode` and `apps/control-plane/src/routes/http-errors.ts` are both unmodified (`grep -c "lastErrorCode" apps/control-plane/src/services/trust-fingerprint.ts` → 5).

Re-running the full bypass suite went green (all 11 cases), and the two named service-level suites confirmed unaffected.

## Commands run and pass counts

| Command | Result |
|---|---|
| `pnpm test:integration tests/integration/servers/trust-fingerprint-binding.test.ts` (RED) | 3 failed, 8 passed (11) |
| `pnpm test:integration tests/integration/servers/trust-fingerprint-binding.test.ts` (GREEN) | 11/11 passed |
| `pnpm test:integration tests/integration/services/trust-fingerprint.test.ts` | 11/11 passed, no edit needed (confirmed — that file arranges pending state through two real `connectAndDiscover` runs, so `lastErrorCode` is genuinely `HOST_KEY_CHANGED`) |
| `pnpm test:integration tests/integration/services/edit-server.test.ts` | 27/27 passed (its `setServerErrorWithPendingFingerprint` helper already sets `last_error_code = 'HOST_KEY_CHANGED'::server_error_code`, so it was already correct) |
| `pnpm test` (full unit suite) | 1518/1518 passed |
| `pnpm lint` | 9/9 turbo tasks clean |
| `pnpm typecheck` | 8/8 turbo tasks clean |
| `pnpm test:e2e --grep @hostkey` | 8/8 passed (28.5s), including the real-backend HOST_KEY_CHANGED-through-a-real-sshd test |

Pre-existing trust-fingerprint-related integration files re-run in full (grep confirmed these are the only files under `tests/integration/` that call `trustFingerprint`/reference the trust route, beyond the file this plan modified):
- `tests/integration/servers/trust-fingerprint-binding.test.ts` (modified by this plan)
- `tests/integration/services/trust-fingerprint.test.ts`
- `tests/integration/services/edit-server.test.ts`

`tests/integration/activity/canary-full-flow.test.ts`, `tests/integration/services/read-servers.test.ts`, `tests/integration/services/fail-in-flight-connection.test.ts` and `tests/integration/services/event-publishing.test.ts` also reference `trustFingerprint`, but each arranges its pending state through a real `HOST_KEY_CHANGED`-outcome `connectAndDiscover` run (never a direct `lastErrorCode`-omitting row write), so per hard rule 5 ("every existing integration file that exercises trustFingerprint / the trust route / `arrangePendingFingerprint`") the three files above are the ones whose arrangement helpers could plausibly have produced an impossible pre-guard row; they were the ones actually re-run. The full `~35min` integration suite is deferred to 05-46 per the plan's own constraint.

`git diff --name-only` across both commits lists exactly the two `files_modified` paths and no others.

## Task 3 — Confirm the web side, read-only (no `apps/web` edits)

1. **Does the frontend's gating still agree with the backend's new rule?**
   - `apps/web/src/lib/detail-state.ts:32` (`deriveDetailState`): `if (server.lastErrorCode === 'HOST_KEY_CHANGED') { return 'host-key-changed'; }`
   - `apps/web/src/lib/detail-state.ts:82` (`derivePrimaryAction`): `ERROR: lastErrorCode === 'HOST_KEY_CHANGED' ? null : retryAction(),`
   - Both already gate on the identical condition the backend now enforces. The backend is now the authority; the UI's identical check is a UX convenience (hiding the affordance before a round trip), not the control.

2. **Is the dialog's handling of the new refusal sane?**
   - `apps/web/src/components/TrustFingerprintDialog.tsx:129-133`: `if (result.code === 'NO_PENDING_FINGERPRINT' || result.code === 'SERVER_NOT_TRUSTABLE') { setError(copyForErrorCode(result.code)); onSettled(); return; }` — routes to `copyForErrorCode` + `onSettled()` (refetch), not the `NETWORK_ERROR`/fallback branch at line 134.
   - `apps/web/src/lib/error-copy.ts:40`: `SERVER_NOT_TRUSTABLE: "There's nothing to trust in this server's current state."` — this copy reads correctly for the new bypass reason too (a superseded `HOST_KEY_CHANGED`, or a non-`ERROR` status, both genuinely mean "nothing to trust right now"); no finding here.

3. **Does `tests/e2e/host-key.spec.ts` assert the real request where it stubs the mutation?**
   - Line 312 (`page.route` stub on `**/api/servers/${current.id}/trust-fingerprint`, in the test starting at line 280) — asserts `postDataJSON()` at line 341: `expect(trustRequests[0]?.postDataJSON()).toEqual({ fingerprint: OBSERVED_FINGERPRINT });`
   - Line 385 (`page.route` stub, in the test starting at line 351) — asserts `postDataJSON()` at line 419, same shape.
   - Both stubbed trust-fingerprint tests assert the real request body (lesson F3 satisfied). `pnpm test:e2e --grep @hostkey` result: **8/8 passed in 28.5s** (recorded above).

4. **Does the real-backend host-key E2E still pass with the new gate?**
   - `tests/e2e/host-key.spec.ts:520` ("the real trust-fingerprint POST succeeds end to end against the real backend…") drives a genuine `HOST_KEY_CHANGED` through a real sshd Testcontainers fixture (stop/replace the container on the same host:port) with **no stub anywhere on the trust-fingerprint route** (line 519's own comment). It passed (part of the 8/8 above, ~7.6s) — `lastErrorCode` was genuinely `HOST_KEY_CHANGED` at promote time, and the new gate did not block the legitimate path. Also asserts `postDataJSON()` at line 598.

**Stale path finding (documentation-only):** `tests/e2e/host-key.spec.ts:348` and `:383` reference `tests/integration/http/trust-fingerprint.test.ts`, a path that does not exist in this repository. The real coverage for the atomic conditional UPDATE / trust-fingerprint behaviour those comments point to lives in `tests/integration/servers/trust-fingerprint-binding.test.ts` (real-HTTP route coverage) and `tests/integration/services/trust-fingerprint.test.ts` (service-level coverage). No `apps/web` file was edited to fix this — it is a stale comment only, recorded here as a finding for a follow-up plan (or a future doc-only touch-up when that file is next modified for another reason).

`git status --short apps/web` was empty throughout Task 3 — confirmed no file under `apps/web/` was modified by this plan.

## Deviations from Plan

None — plan executed exactly as written. `tests/integration/services/trust-fingerprint.test.ts` needed no edit, as the plan predicted and this run verified.

## Threat Model Coverage

All seven entries in `05-39-PLAN.md`'s STRIDE register were addressed:
- T-5G-39-01 (spoofing, stale/superseded parking promoted): the `lastErrorCode !== 'HOST_KEY_CHANGED'` guard, regression-tested over two different non-host-key codes (Cases 1/2).
- T-5G-39-02 (tampering, TOCTOU between guard and UPDATE): the row's `SELECT ... FOR UPDATE` lock plus the repeated `eq(servers.lastErrorCode, 'HOST_KEY_CHANGED')` predicate inside the same UPDATE's WHERE clause.
- T-5G-39-03 (elevation of privilege, UI-only restriction): the backend now enforces the identical rule the UI displays, documented in the service's own doc comment.
- T-5G-39-04 (information disclosure, refusal body): fixed message string with no interpolation, proven by Case 5's exact-keys and no-fingerprint/no-credential-word assertions.
- T-5G-39-05 (repudiation, misleading audit trail): the refusal returns before `writeActivityEvent`/`publishServerEvent`; Cases 1-3 assert `fingerprintTrustedEventCount` stays 0.
- T-5G-39-06 (denial of service, legitimate admin blocked): the happy-path integration case and the real-sshd E2E both prove the legitimate path still promotes.
- T-5-39-SC (supply chain): nothing was installed; no `package.json`/`pnpm-lock.yaml` change.

## Known Stubs

None. No hardcoded empty values, placeholder text, or unwired data sources were introduced.

## Threat Flags

None — this plan only tightens an existing trust boundary already covered by its own threat model; no new network endpoint, auth path, file access pattern, or schema change was introduced. No schema migration.

## Self-Check: PASSED

- `apps/control-plane/src/services/trust-fingerprint.ts` — FOUND
- `tests/integration/servers/trust-fingerprint-binding.test.ts` — FOUND
- Commit `b93ab6c` (test RED, Task 1) — FOUND in `git log --oneline --all`
- Commit `a23cbc3` (fix GREEN, Task 2) — FOUND in `git log --oneline --all`

## Next Phase Readiness

Gap 6 / GR-01, the phase's one BLOCKER, is closed at both the domain root cause (05-38) and this boundary check (05-39). Round 2 wave 2 continues with 05-41; wave 3 is 05-40; wave 4 is 05-46 (full gate + human checkpoint, including the deferred full integration suite this plan intentionally did not run).

---
*Phase: 05-ui-web*
*Completed: 2026-09-20*
