# 33-01 executor handoff

Implementation is ready for authoritative gates/review; no commit or advance performed.

## RED before production edits

Command: `node node_modules/vitest/vitest.mjs run apps/control-plane/src/services/container-logs.test.ts`

Observed before changing `container-logs.ts`: **47 passed, 1 failed**.
Failure: `scoped app-secret regression > opens the scoped lease before reading ordinary secret output`.
The old empty-redactor result contained the synthetic ordinary application secret in a tail line; the new scoped opener was never called. Assertion output is summarized here without copying the synthetic value. The test now verifies redaction and one release.

## Implementation

- `container-logs.ts` requires an asynchronous `openRedactor(request)` lease, with no bare-redactor fallback. Tail releases after session close. Follow releases after teardown, including reconnect and final close. Unpumped client abort now also tears down.
- The secret-opening stage races `stepMs`, client abort and shutdown. Follow openings remain tracked until their resource cleanup settles. Late leases release once; late rejections are consumed and never start SSH.
- `legacy-log-redactor.ts` re-reads the authoritative service using project and service IDs, checks the authorized environment/server snapshot, and delegates to `openServiceRedactor`. Missing or changed scope fails before secret/key access.
- Default app wiring stays lazy. Routes pass the already-authorized scope snapshot. The existing database-free SSH integration fixture explicitly supplies the required lease contract and scope fields.
- `secret-store.ts` leases each multiline component at least 8 characters long alongside the complete value, retaining exact/base64/URL forms, reference accounting, and minimum-length policy. Components shorter than 8 remain outside that policy.

## Focused verification

- Three focused files: **114 passed**, including default-app laziness/wiring; stale scope; fail-closed lease errors; deadline/abort/shutdown with late success and rejection; invalid/cap rejection; close/flush, timeout, abort, dropped output, callback, reconnect and unpumped cleanup; concurrent independent leases; multiline reference accounting.
- `tsc -p apps/control-plane/tsconfig.json --noEmit`: PASS.
- `tsc -p tests/integration/deploy-engine/tsconfig.json --noEmit`: PASS.
- Scoped ESLint with `packages/config/eslint.config.js`: PASS.
- `git diff --check`: PASS.
- A broad sandbox Vitest attempt encountered existing socket/environment-sensitive failures (`app.test.ts`, `routes/events.test.ts`) and was stopped; no full-suite success is claimed. Orchestrator owns authoritative gates.
- The stalled pnpm bootstrap and broad Vitest processes were stopped. Removed only the three generated `.pnpm-store/v11/index.db*` files and emptied directories authorized by the orchestrator. Pre-existing unrelated untracked artifacts were preserved.

## Next

Run authoritative 33-01 gates/review, then task 33-02 real HTTP/PostgreSQL/SSH proof. Do not close M2 or SEC requirements until the phase-level evidence and independent review pass. Existing snapshot limits (deleted/rotated historical secrets, changes after opening, plaintext env, unrelated scope) remain unchanged.
