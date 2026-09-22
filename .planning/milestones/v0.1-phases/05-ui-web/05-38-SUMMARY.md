---
phase: 05-ui-web
plan: 38
subsystem: server-connection-domain
tags: [domain, tdd, security, fingerprint, gap-closure]
dependency-graph:
  requires: []
  provides:
    - "applyConnectionResult clears a parked pendingFingerprint on success and on every non-HOST_KEY_CHANGED failure"
    - "connectAndDiscover nulls pending_fingerprint_seen_at in lockstep with pending_fingerprint"
  affects:
    - "packages/domain/src/server/connection-result.ts"
    - "apps/control-plane/src/services/connect-and-discover.ts"
tech-stack:
  added: []
  patterns:
    - "Domain function invariant documented in its own JSDoc, referencing the gap ID that motivated it (GR-01/gap 6)"
    - "Service-layer timestamp derived from the domain's own decision about the value it describes, not from the raw SSH outcome alone"
key-files:
  created: []
  modified:
    - packages/domain/src/server/connection-result.ts
    - packages/domain/src/server/connection-result.test.ts
    - apps/control-plane/src/services/connect-and-discover.ts
    - tests/integration/services/connect-and-discover.test.ts
decisions:
  - "applyConnectionResult's failure branch collapses to a three-way rule: HOST_KEY_CHANGED with a fresh observedFingerprint promotes it, HOST_KEY_CHANGED with no observedFingerprint keeps the existing parked value (else-branch, now covered by a dedicated test), every other error code clears it to null"
  - "pendingFingerprintSeenAt in connect-and-discover.ts is now null whenever nextState.pendingFingerprint is null, regardless of what the raw outcome was — closing the row-consistency gap between the two columns"
metrics:
  duration: "~50min"
  completed: "2026-09-20"
---

# Phase 05 Plan 38: Domain-layer host-key trust gap closure Summary

Closed the domain-layer root cause of `05-VERIFICATION.md` gap 6 (GR-01): `applyConnectionResult` no longer carries a parked `pendingFingerprint` forward through a later successful connect or through any later failure whose code is not `HOST_KEY_CHANGED`, and the persistence layer nulls `pending_fingerprint_seen_at` in the same write whenever the value it describes is cleared.

## What Was Built

### Task 1 — `applyConnectionResult` clears a parked fingerprint (RED then GREEN)

**RED (commit `ab92f34`):** Added/renamed tests in `connection-result.test.ts` that start from a non-null `pendingFingerprint: 'SHA256:parked'` instead of the old suite's `null` default (which is precisely why this gap had no coverage before). Ran `pnpm vitest run packages/domain/src/server/connection-result.test.ts` and observed 8 failures, all for the same, correct reason:

```
FAIL  packages/domain/src/server/connection-result.test.ts > applyConnectionResult (success) > clears a previously parked pendingFingerprint on a successful reconnect
AssertionError: expected 'SHA256:parked' to be null
- Expected: null
+ Received: "SHA256:parked"

FAIL  ... > clears a parked pendingFingerprint on a successful first-capture (TOFU) connect too
AssertionError: expected 'SHA256:parked' to be null

FAIL  ... AUTH_FAILED / HOST_UNRESOLVED / CONNECT_TIMEOUT / COMMAND_TIMEOUT / CONNECTION_LOST / UNSUPPORTED_OS
clears a parked pendingFingerprint (only a HOST_KEY_CHANGED outcome may keep one parked)
AssertionError: expected 'SHA256:parked' to be null

Test Files  1 failed (1)
     Tests  8 failed | 21 passed (29)
```

**GREEN (commit `53d7799`):**
- `ok:true` branch: added `pendingFingerprint: null` to the returned object.
- `ok:false` branch: the ternary changed from `errorCode === 'HOST_KEY_CHANGED' && observedFingerprint !== undefined ? observedFingerprint : state.pendingFingerprint` to `errorCode === 'HOST_KEY_CHANGED' ? (observedFingerprint ?? state.pendingFingerprint) : null` — the `else` arm now nulls the value for every other error code instead of leaving it unchanged.
- Updated the function's JSDoc to state the new invariant explicitly (a `pendingFingerprint` only ever survives a `HOST_KEY_CHANGED` outcome), referencing GR-01/gap 6.

Also added a fifth test (the ternary's else-branch, HOST_KEY_CHANGED with no `observedFingerprint`) proving the older parked value is kept, not accidentally cleared — this was the one behaviour the plan explicitly called out as needing to be pinned rather than left as an accident.

Result: `pnpm vitest run packages/domain/src/server/connection-result.test.ts` → 29/29 passed.

### Task 2 — persistence layer nulls `pending_fingerprint_seen_at` with the value (RED then GREEN)

**RED (commit `5671dc0`):** Added two integration tests to `tests/integration/services/connect-and-discover.test.ts`:
- Test A: park a fingerprint via a real scripted `HOST_KEY_CHANGED` connect, then run a real successful connect (with a `discover` override, so it reaches the **post-discovery** `.set(...)` branch) — asserts `pendingFingerprint === null` and `pendingFingerprintSeenAt === null` afterward.
- Test B: same arrangement, then a real `AUTH_FAILED` connect (no discovery, so it stays in the **no-discovery** `.set(...)` branch) — asserts the same two nulls, plus `lastErrorCode === 'AUTH_FAILED'` and `status === 'ERROR'`.

Ran `NOODARA_API_ORIGIN=http://localhost:3100 pnpm test:integration tests/integration/services/connect-and-discover.test.ts` and observed exactly the internally-inconsistent row state the task description predicted (pendingFingerprint already null thanks to Task 1's fix, timestamp still stale):

```
FAIL  ... > a successful reconnect clears both pending_fingerprint and pending_fingerprint_seen_at after an earlier parked HOST_KEY_CHANGED (GR-01/gap 6)
AssertionError: expected 2026-01-01T00:00:00.000Z to be null
- Expected: null
+ Received: 2026-01-01T00:00:00.000Z

FAIL  ... > an AUTH_FAILED failure after a parked HOST_KEY_CHANGED also clears both columns (GR-01/gap 6)
AssertionError: expected 2026-01-01T00:00:00.000Z to be null
- Expected: null
+ Received: 2026-01-01T00:00:00.000Z

Test Files  1 failed (1)
     Tests  2 failed | 31 passed (33)
```

**GREEN (commit `c252f46`):** In `connect-and-discover.ts`, `pendingFingerprintSeenAt` is now derived from `nextState.pendingFingerprint` (the domain's own decision) instead of the raw `outcome` alone: `null` when `nextState.pendingFingerprint === null`; otherwise `deps.now()` when this run is the `HOST_KEY_CHANGED` observation that set it; otherwise `row.pendingFingerprintSeenAt` (an untouched still-parked value from an earlier run). The single local is still used by both `.set({...})` calls unchanged. `hostFingerprintCapturedAt` and the "Pitfall 4" comment were left in place, only extended to describe the new rule.

Result: `NOODARA_API_ORIGIN=http://localhost:3100 pnpm test:integration tests/integration/services/connect-and-discover.test.ts` → 33/33 passed (31 pre-existing + 2 new). The pre-existing HOST_KEY_CHANGED assertion at line ~413-437 (`pendingFingerprintSeenAt` equals `FIXED_NOW`) passed unmodified.

**Which `.set(...)` branch each new case hit:** Test A's arrangement call (the parking `HOST_KEY_CHANGED` connect) hits the no-discovery branch; its assertion call (a successful connect with a `discover` override) hits the post-discovery branch — the second write site the task's acceptance criteria required proven. Test B's arrangement call also hits the no-discovery branch; its assertion call (`AUTH_FAILED`, no session, no discovery) hits the no-discovery branch again.

## Commands run and pass counts

| Command | Result |
|---|---|
| `pnpm vitest run packages/domain/src/server/connection-result.test.ts` (RED) | 8 failed, 21 passed (29) |
| `pnpm vitest run packages/domain/src/server/connection-result.test.ts` (GREEN) | 29/29 passed |
| `NOODARA_API_ORIGIN=http://localhost:3100 pnpm test:integration tests/integration/services/connect-and-discover.test.ts` (RED) | 2 failed, 31 passed (33) |
| `NOODARA_API_ORIGIN=http://localhost:3100 pnpm test:integration tests/integration/services/connect-and-discover.test.ts` (GREEN) | 33/33 passed |
| `pnpm test` (full unit suite, run twice: after Task 1 and again after Task 2) | 1500/1500 passed both times |
| `pnpm lint` | 9/9 packages clean |
| `pnpm typecheck` | 8/8 packages clean |
| `pnpm boundaries` | 613 files checked in 6 packages, no issues |

`git diff --name-only` across the whole plan's commits lists exactly the four `files_modified` paths and no others. No file under `apps/control-plane/src/db/` was touched and no migration was generated.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 3 - blocking, tooling] Reverted an unintended `prettier --write` reformat**
- **Found during:** Task 1's GREEN step
- **Issue:** After implementing the `applyConnectionResult` fix, a sanity-check run of `pnpm exec prettier --check` reported both touched files as unformatted. Running `pnpm exec prettier --write` on them reformatted the **entire** file to double-quoted strings (this repo has no `.prettierrc`, so Prettier fell back to its own default style, which conflicts with the single-quote convention every other file in the codebase already uses and that `eslint` — the actual formatting gate — does not flag).
- **Fix:** Reverted `connection-result.test.ts` to its RED-commit state via `git checkout -- <file>` (an explicitly sanctioned single-file revert), and rewrote `connection-result.ts` from `git show HEAD:...` plus the minimal GREEN diff, preserving single-quote style. `pnpm lint` (the project's real formatting/style gate) was green both before and after this correction.
- **Files touched:** `packages/domain/src/server/connection-result.ts`, `packages/domain/src/server/connection-result.test.ts` (net effect: no formatting-only diff survived; only the intended behavioural GREEN diff is in the final commit).
- **Commit:** folded into `53d7799` (no separate commit was needed — the revert happened before staging).

No other deviations. The plan's task order, file list, and acceptance criteria were followed exactly.

## Threat Model Coverage

All six threats in `05-38-PLAN.md`'s STRIDE register were addressed:
- T-5G-38-01 (spoofing, success branch): `pendingFingerprint: null` on `ok:true` — verified by Task 1's tests.
- T-5G-38-02 (spoofing, failure branch): every non-`HOST_KEY_CHANGED` outcome clears the parked value — verified by Task 1's `it.each`.
- T-5G-38-03 (tampering, row consistency): the timestamp is derived from `nextState.pendingFingerprint` — verified by Task 2's integration tests.
- T-5G-38-04 (information disclosure, accepted): no credential or secret material was touched by this plan; fingerprints remain public identifiers.
- T-5G-38-05 (repudiation, RED-before-GREEN): both RED failure outputs are quoted verbatim above.
- T-5-38-SC (supply chain): no `package.json` or `pnpm-lock.yaml` change was made; nothing was installed.

## Known Stubs

None. No hardcoded empty values, placeholder text, or unwired data sources were introduced.

## Threat Flags

None — this plan only tightens an existing trust boundary already covered by `05-38-PLAN.md`'s own threat model; no new network endpoint, auth path, file access pattern, or schema change was introduced.

## Self-Check: PASSED

- `packages/domain/src/server/connection-result.ts` — FOUND
- `packages/domain/src/server/connection-result.test.ts` — FOUND
- `apps/control-plane/src/services/connect-and-discover.ts` — FOUND
- `tests/integration/services/connect-and-discover.test.ts` — FOUND
- Commit `ab92f34` (test RED, Task 1) — FOUND in `git log --oneline --all`
- Commit `53d7799` (fix GREEN, Task 1) — FOUND in `git log --oneline --all`
- Commit `5671dc0` (test RED, Task 2) — FOUND in `git log --oneline --all`
- Commit `c252f46` (fix GREEN, Task 2) — FOUND in `git log --oneline --all`
