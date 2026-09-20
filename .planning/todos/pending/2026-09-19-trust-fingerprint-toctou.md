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
