---
created: 2026-09-19
title: Bind trust-fingerprint to the fingerprint the admin actually saw
area: security
priority: high
source: phase 05 execution, finding reported by plan 05-19's executor, confirmed by orchestrator
files:
  - apps/control-plane/src/routes/servers.ts
  - apps/control-plane/src/routes/server-schemas.ts
  - apps/control-plane/src/services/trust-fingerprint.ts
  - apps/web/src/components/TrustFingerprintDialog.tsx
---

## Problem

`POST /api/servers/:id/trust-fingerprint` takes no request body: it promotes whatever
`pendingFingerprint` the row holds at the moment the request lands. The dialog shows the admin
a specific fingerprint to verify out-of-band, but nothing ties the value displayed to the value
promoted. If `pendingFingerprint` changes between display and click (another connect attempt
observes yet another key — exactly what an active interception could cause), the admin trusts a
fingerprint they never saw. Same family as UF-01 (fixed in 05-01): TOFU defeated by a
display/action mismatch. CLAUDE.md §2.3 and the noodara-security skill treat host-key
verification as non-negotiable, and permission decisions must be enforced in the backend.

05-19 narrows the window client-side (re-GET and compare immediately before the POST) and
documents the residual race. It cannot close it: only the backend can.

## Solution

Test-first (RED → GREEN), backend first:

1. Route accepts `{ fingerprint: string }` (Zod, required). Service promotes only if it equals
   the row's current `pendingFingerprint`, compared in the same transaction / with a
   conditional UPDATE (`WHERE pending_fingerprint = $1`) so it is atomic. Mismatch →
   `409` with a dedicated error code (e.g. `FINGERPRINT_MISMATCH`), nothing promoted.
2. Integration test: set pending = FP_B, call with FP_A → 409, `hostFingerprint` unchanged;
   call with FP_B → promoted. Concurrency test: pending flips between read and write.
3. UI sends the exact fingerprint it displayed; on `FINGERPRINT_MISMATCH` it closes the
   confirmation, re-renders with the new value and fixed copy (add to `error-copy.ts`), and
   requires the name to be typed again. Drop the client-side re-GET once the backend enforces it.
4. Activity event for trust should record the fingerprint promoted (public value).


## Reopened 2026-09-20 (phase 5 re-verification)

Closed prematurely by plan 05-31. `05-REVIEW.md` GR-01 / GR-02, confirmed first-hand by the orchestrator and
by the phase verifier (`05-VERIFICATION.md`, status `gaps_found`):

- `apps/control-plane/src/services/trust-fingerprint.ts` never checks `lastErrorCode === 'HOST_KEY_CHANGED'`;
  the restriction exists only in the UI (`apps/web/src/lib/detail-state.ts`).
- `packages/domain/src/server/connection-result.ts` `applyConnectionResult` carries `pendingFingerprint`
  through a later success and through a later non-host-key failure, so a stale parked fingerprint stays
  promotable through the API.
- `apps/control-plane/src/services/edit-server.ts` clears `hostFingerprint` on an identity change only inside
  the `CONNECTED` branch (GR-02).
- No integration test covers "HOST_KEY_CHANGED parks F -> later AUTH_FAILED -> POST /trust-fingerprint F
  must be 409".

Next: `/gsd-plan-phase 5 --gaps`.

## Closed 2026-09-20

Verified first-hand against current source (2026-09-20, phase 5 gap closure round 2, plan 05-40) —
not cited from any `SUMMARY.md`. Each of the four re-opened bullets:

1. **`trust-fingerprint.ts` never checks `lastErrorCode === 'HOST_KEY_CHANGED'`.**
   Fixed by plan 05-39. Current source, `apps/control-plane/src/services/trust-fingerprint.ts`:
   - `grep -n "lastErrorCode" apps/control-plane/src/services/trust-fingerprint.ts` →
     ```
     51: * requires `row.lastErrorCode === 'HOST_KEY_CHANGED'`. A `pending_fingerprint` value can survive
     104:    if (row.lastErrorCode !== 'HOST_KEY_CHANGED') {
     125:    // Gap 6 / GR-01 (T-5G-39-02): `eq(servers.lastErrorCode, 'HOST_KEY_CHANGED')` is repeated here
     127:    // UPDATE`-locked inside this same transaction, so `lastErrorCode` cannot change between the
     148:          eq(servers.lastErrorCode, 'HOST_KEY_CHANGED'),
     ```
   - Guard (line 104-110): `if (row.lastErrorCode !== 'HOST_KEY_CHANGED') { return { ok: false, code: 'SERVER_NOT_TRUSTABLE', message: 'Server has no unresolved host-key change to trust' }; }`
   - Conditional UPDATE `WHERE` predicate (line 144-150), the atomic promote's `and(...)`:
     `eq(servers.id, row.id)`, `eq(servers.pendingFingerprint, input.fingerprint)`,
     `eq(servers.lastErrorCode, 'HOST_KEY_CHANGED')` (line 148) — repeated as defence in depth,
     not the primary control (the guard above is).

2. **`applyConnectionResult` carries `pendingFingerprint` through a later success or a later
   non-host-key failure.** Fixed by plan 05-38. Current source,
   `packages/domain/src/server/connection-result.ts`:
   - `grep -n "pendingFingerprint" packages/domain/src/server/connection-result.ts` →
     ```
     29:  pendingFingerprint: string | null;
     60: * Returns a new object; never mutates `state`. Invariant (GR-01/gap 6): a `pendingFingerprint`
     83:      pendingFingerprint: null,
     92:    pendingFingerprint:
     94:        ? (result.observedFingerprint ?? state.pendingFingerprint)
     ```
   - Success branch (`result.ok === true`, line 83): `pendingFingerprint: null,` — every successful
     reconnect clears a parked value unconditionally.
   - Failure branch (line 91-95): `pendingFingerprint: result.errorCode === 'HOST_KEY_CHANGED' ? (result.observedFingerprint ?? state.pendingFingerprint) : null,` —
     every non-`HOST_KEY_CHANGED` error code (`AUTH_FAILED`, `HOST_UNRESOLVED`, `CONNECT_TIMEOUT`,
     `COMMAND_TIMEOUT`, `CONNECTION_LOST`, `UNSUPPORTED_OS`) nulls the parked value; only
     `HOST_KEY_CHANGED` may keep or refresh it.

3. **`edit-server.ts` clears `hostFingerprint` on an identity change only inside the `CONNECTED`
   branch.** Fixed by plan 05-40 (this plan; GR-02). Current source,
   `apps/control-plane/src/services/edit-server.ts`:
   - `grep -n "hostIdentityChanged" apps/control-plane/src/services/edit-server.ts` →
     ```
     165:      // `hostIdentityChanged` below answers "did the machine itself change" (host or port only).
     175:      // over-broad on this point and is deliberately NOT followed verbatim; `hostIdentityChanged`
     177:      const hostIdentityChanged = host !== row.host || sshPort !== row.sshPort;
     264:      if (hostIdentityChanged) {
     265:        statusPatch = { ...statusPatch, hostFingerprint: null, hostFingerprintCapturedAt: null };
     ```
   - Declaration (line 177): `host !== row.host || sshPort !== row.sshPort` — deliberately excludes
     `sshUser`.
   - Composition (line 264-266), confirmed OUTSIDE the `if (row.status === 'CONNECTED')` block
     (which closes at line 255, above this): `if (hostIdentityChanged) { statusPatch = {
     ...statusPatch, hostFingerprint: null, hostFingerprintCapturedAt: null }; }` — status-
     independent, runs for ERROR/UNREACHABLE/DISCONNECTED/PENDING as well as CONNECTED.
   - `sshUser` is deliberately excluded so a trusted host key survives a user-only edit (D-14
     `access`); regression-tested by
     `tests/integration/services/edit-server.test.ts`'s "CONNECTED + ssh user change only
     transitions to DISCONNECTED and preserves the fingerprint (D-14 access)" and this plan's own
     "ERROR + sshUser-only change preserves hostFingerprint/hostFingerprintCapturedAt ... (T-5G-40-02)".

4. **No integration test covers "HOST_KEY_CHANGED parks F -> later AUTH_FAILED -> POST
   /trust-fingerprint F must be 409".** Fixed by plan 05-39. Test:
   - File: `tests/integration/servers/trust-fingerprint-binding.test.ts`, line 269.
   - Title: `'returns 409 SERVER_NOT_TRUSTABLE and promotes nothing when a later AUTH_FAILED
     supersedes the parked HOST_KEY_CHANGED (gap 6 / GR-01 bypass, case 1)'`.
   - Body: arranges `pendingFingerprint: FP_B, hostFingerprint: FP_A` via a real `HOST_KEY_CHANGED`-
     shaped row (`arrangePendingFingerprint`), then a second direct write sets
     `lastErrorCode: 'AUTH_FAILED'` (superseding the parking without clearing `pendingFingerprint`
     or `status` — the exact stale-row shape a pre-05-38 row could still carry), then `POST
     /api/servers/:id/trust-fingerprint` with `fingerprint: FP_B` asserts `response.statusCode ===
     409` and `response.json()` matches `{ error: 'SERVER_NOT_TRUSTABLE' }`, with
     `hostFingerprint` still `FP_A` and `pendingFingerprint` still `FP_B` unchanged.
   - Passing run (this session, 2026-09-20): `NOODARA_API_ORIGIN=http://localhost:3100 pnpm
     test:integration tests/integration/servers/trust-fingerprint-binding.test.ts` →
     `Test Files 1 passed (1)`, `Tests 11 passed (11)`.

All four bullets are satisfied by current source, each verified directly (file read + grep +
passing test run) in this session, not inferred from a prior plan's `SUMMARY.md`. Moved to
`completed/`.
