---
phase: 05-ui-web
plan: 40
subsystem: server-connection-domain
tags: [security, tdd, fingerprint, gap-closure, host-identity]
requires:
  - phase: 05-ui-web (plan 38)
    provides: "applyConnectionResult clears a parked pendingFingerprint on success and on every non-HOST_KEY_CHANGED failure"
  - phase: 05-ui-web (plan 39)
    provides: "trustFingerprint refuses to promote a pending fingerprint unless row.lastErrorCode === 'HOST_KEY_CHANGED'"
provides:
  - "editServer clears hostFingerprint/hostFingerprintCapturedAt whenever host or sshPort changes, from any status (not only CONNECTED)"
  - "an sshUser-only change deliberately never clears the trusted host key (T-5G-40-02)"
  - "integration proof that the next connect after a re-point is a clean TOFU first capture, with a control test proving mismatch detection is still intact"
  - "the re-opened trust-fingerprint TOCTOU todo closed with first-hand, per-bullet evidence"
affects: [phase 05 gap closure round 2 wave 4 (05-46 full gate)]
tech-stack:
  added: []
  patterns:
    - "A host-identity predicate (host/sshPort only) kept deliberately separate from a broader pending-verification-target predicate (host/sshPort/sshUser) that already existed in the same function, so two different security invariants don't collapse into one comparison"
    - "A TOFU-vs-mismatch fake SshPort that branches on input.trustedFingerprint (not a fixed scripted outcome), so a test can prove a service-layer fix actually changes production behavior at the SSH boundary"
key-files:
  created: []
  modified:
    - apps/control-plane/src/services/edit-server.ts
    - tests/integration/services/edit-server.test.ts
    - tests/integration/servers/edit-clears-pending-fingerprint.test.ts
    - .planning/todos/completed/2026-09-19-trust-fingerprint-toctou.md
key-decisions:
  - "Did NOT follow 05-REVIEW.md's literal GR-02 fix text ('clear hostFingerprint in the identityChanged block') verbatim — identityChanged includes sshUser, and clearing the trusted host key on a user-only change would reopen TOFU for an already-trusted host, a regression that would also break the existing D-14 'preserves the fingerprint' test. Introduced a narrower hostIdentityChanged predicate (host/sshPort only) instead."
  - "Task 2's Tests A/B were moved from the real-HTTP file to tests/integration/services/edit-server.test.ts, per the plan's own fallback instruction, because the HTTP harness's /connect route enqueues through BullMQ and cannot script an SSH outcome."
  - "Test A/B arrange the server via a real connectAndDiscover call, then explicitly move status off CONNECTED (to UNREACHABLE) before editing/reconnecting — otherwise D-14's pre-existing CONNECTED-branch fingerprint clear would mask whether the new hostIdentityChanged predicate is what's doing the work."
requirements-completed: [SERV-04]
duration: 45min
completed: 2026-09-20
---

# Phase 05 Plan 40: Host-identity-scoped trusted-fingerprint clear (GR-02) Summary

Closed the last code item of `05-VERIFICATION.md` gap 6 (`05-REVIEW.md` GR-02): `editServer` now clears `hostFingerprint`/`hostFingerprintCapturedAt` whenever `host` or `sshPort` changes, from **any** status — not only when the row was `CONNECTED` — while an `sshUser`-only change deliberately still preserves the trusted key, matching D-14's existing `access` classification.

## What Was Built

### Task 1 — RED then GREEN: host-identity-scoped clear (commits `2a5c98a`, `89beb7f`)

**RED (`2a5c98a`):** Added eight new cases to `tests/integration/services/edit-server.test.ts` under a new `GR-02` describe block: `ERROR`/`UNREACHABLE`/`DISCONNECTED`/`PENDING` + host or port change must clear both host-fingerprint columns and leave status untouched; an `sshUser`-only change from `ERROR` must preserve the fingerprint while still clearing `pendingFingerprint` (the pre-existing WR-A-02 behavior); a name-only edit must leave the fingerprint untouched. Ran `pnpm test:integration tests/integration/services/edit-server.test.ts` and observed the 4 expected failures, all for the same reason:

```
FAIL  ... > ERROR + host change clears hostFingerprint/hostFingerprintCapturedAt and leaves status untouched
AssertionError: expected 'SHA256:old-host' to be null
FAIL  ... > UNREACHABLE + sshPort change clears hostFingerprint/hostFingerprintCapturedAt and leaves status untouched
AssertionError: expected 'SHA256:old-host' to be null
FAIL  ... > DISCONNECTED + host change clears hostFingerprint/hostFingerprintCapturedAt and leaves status untouched
FAIL  ... > PENDING + host change clears hostFingerprint/hostFingerprintCapturedAt and leaves status untouched
AssertionError: expected 'SHA256:old-host' to be null

Test Files  1 failed (1)
     Tests  4 failed | 29 passed (33)
```

**GREEN (`89beb7f`):** In `edit-server.ts`, introduced `hostIdentityChanged = host !== row.host || sshPort !== row.sshPort` — deliberately narrower than the pre-existing `identityChanged` (which also includes `sshUser`, and drives the unrelated `pendingFingerprint` clear). Composed `{ hostFingerprint: null, hostFingerprintCapturedAt: null }` into `statusPatch` whenever `hostIdentityChanged`, **outside** the `row.status === 'CONNECTED'` branch (whose own fingerprint clear on an `'identity'` classification is left untouched — now redundant for CONNECTED but harmless). The comment explicitly documents that 05-REVIEW.md's own literal fix text ("clear hostFingerprint in the identityChanged block") is over-broad and was deliberately not followed.

Result: `pnpm test:integration tests/integration/services/edit-server.test.ts` → 33/33 passed. Confirmed via grep: `hostIdentityChanged` appears 4 times in the file (declaration + comment references + the `if` guard), its declaration line contains no `sshUser`, and the composition sits after the `CONNECTED` branch's closing brace (line 255) at line 264.

### Task 2 — RED then (no separate GREEN needed) — the next connect is a clean TOFU capture

The real-HTTP harness (`tests/integration/servers/edit-clears-pending-fingerprint.test.ts`) cannot script an SSH outcome — its `/connect` route enqueues through BullMQ (confirmed via `grep -rn "connect" apps/control-plane/src/routes/servers.ts` → `ConnectServerQueue` import, "connect-server job enqueued" log line) — so, per the plan's own fallback instruction, Tests A and B were placed in `tests/integration/services/edit-server.test.ts`, driving `connectAndDiscover` directly against the service fixture's fake SSH port, exactly like `trust-fingerprint.test.ts`'s own `arrangeServerWithPendingFingerprint`.

Built `buildTofuAwareSshPort(presented)`: a fake `SshPort` whose `connect` branches on `input.trustedFingerprint` — `null` is always a first capture (`ok: true, fingerprintCaptured: true`), a non-null value that differs is `HOST_KEY_CHANGED`, a non-null value that matches is a plain reconnect. This was necessary because a *fixed* scripted outcome cannot distinguish "the fix cleared the row's fingerprint" from "the fix did nothing" — the same production `ssh2-adapter` behavior needed to be mirrored so the *row state*, not the test's own script, decides the outcome.

**RED capture (temporary, not committed):** to produce a literal RED for this task's "no separate GREEN" scenario (Task 1's fix already makes these tests pass), the `hostIdentityChanged` block in `edit-server.ts` was temporarily disabled (`if (false && hostIdentityChanged)`), the suite re-run, then the file was restored via `cp` from a pre-edit backup and confirmed byte-identical (`git diff --stat` empty) before continuing. Also discovered and fixed a test-design issue during this step: the original Test A/B arrangement left the row `CONNECTED` after the first connect, which meant D-14's own **pre-existing** CONNECTED-branch clear (unrelated to this plan's fix) also cleared the fingerprint and masked whether `hostIdentityChanged` was doing anything — Test A passed even with the fix disabled. Fixed by moving the row to `UNREACHABLE` (via the existing `setServerStatus` helper) before the edit/second-connect in both Test A and Test B, isolating the assertion to the new predicate. With that fix and the production code disabled:

```
❯ GR-02 (...) (8)
  × ERROR + host change ... (pre-existing Task 1 regression)
  × UNREACHABLE + sshPort change ...
  × DISCONNECTED + host change ...
  × PENDING + host change ...
  × Test A: after a host re-point, a connect presenting a different key is a clean TOFU first capture, not HOST_KEY_CHANGED
AssertionError: expected 'ssh-ed25519 SHA256:OLDOLDOLDOLDOLDOLD…' to be null
- Expected: null
+ Received: "ssh-ed25519 SHA256:OLDOLDOLDOLDOLDOLDOLDOLDOLDOLDOLDOLDOLDOLDOLD"

Test Files  1 failed (1)
     Tests  5 failed | 30 passed (35)
```

Test B (the control) was in the 30 passed even with the fix disabled — proving the mismatch-detection path itself was never broken, only the row's stale fingerprint was the problem.

After restoring the real fix, `pnpm test:integration tests/integration/services/edit-server.test.ts` → 35/35 passed (Test A now asserts `second.server.status === 'CONNECTED'`, `second.server.lastErrorCode !== 'HOST_KEY_CHANGED'`, and `second.server.hostFingerprint` equals the newly-presented key; Test B asserts `second.connection.ok === false`, `second.server.lastErrorCode === 'HOST_KEY_CHANGED'`, and the *old* host's fingerprint is unchanged).

**Test C:** extended `tests/integration/servers/edit-clears-pending-fingerprint.test.ts`'s arrangement helper (`arrangeServerWithStatusAndPendingFingerprint`) to also set a trusted `hostFingerprint`/`hostFingerprintCapturedAt` for the old host (previously it set neither), then added `hostFingerprint`/`hostFingerprintCapturedAt` assertions to the existing UNREACHABLE host-change case, the UNREACHABLE sshPort-change case, the CONNECTED host-change case, and the name-only (non-identity) case (asserting the fingerprint is preserved there). `grep -c "hostFingerprint"` on the file → 10 (was 0). Result: `pnpm test:integration tests/integration/servers/edit-clears-pending-fingerprint.test.ts` → 5/5 passed.

No production code change was needed in this task — Task 1's fix already made every one of these tests pass — so this task landed as a single `test(05-40):` commit (`af0fca2`) rather than a separate RED/GREEN pair.

### Task 3 — Close the todo with per-bullet, first-hand evidence (commit `3111cff`)

Verified all four re-opened bullets against **current source**, in this session, not against any prior `SUMMARY.md`:

1. **`trust-fingerprint.ts` `lastErrorCode` guard** — `grep -n "lastErrorCode" apps/control-plane/src/services/trust-fingerprint.ts` → guard at line 104 (`if (row.lastErrorCode !== 'HOST_KEY_CHANGED') { ... return SERVER_NOT_TRUSTABLE ... }`), repeated as a defence-in-depth predicate inside the conditional `UPDATE`'s `WHERE` clause at line 148 (`eq(servers.lastErrorCode, 'HOST_KEY_CHANGED')`). **Satisfied** (fixed by 05-39).
2. **`applyConnectionResult` clearing** — `grep -n "pendingFingerprint" packages/domain/src/server/connection-result.ts`: success branch nulls it unconditionally at line 83; failure branch (lines 91-95) nulls it for every error code except `HOST_KEY_CHANGED`. **Satisfied** (fixed by 05-38).
3. **`edit-server.ts` status-independent clear** — the `hostIdentityChanged` predicate (line 177) and its composition (lines 264-266), confirmed to sit *outside* the `row.status === 'CONNECTED'` block (which closes at line 255). **Satisfied** (fixed by this plan's Task 1).
4. **Integration coverage for "HOST_KEY_CHANGED parks F → later AUTH_FAILED → `POST /trust-fingerprint F` must be 409"** — `tests/integration/servers/trust-fingerprint-binding.test.ts` line 269, `'returns 409 SERVER_NOT_TRUSTABLE and promotes nothing when a later AUTH_FAILED supersedes the parked HOST_KEY_CHANGED (gap 6 / GR-01 bypass, case 1)'`. Re-run this session: `NOODARA_API_ORIGIN=http://localhost:3100 pnpm test:integration tests/integration/servers/trust-fingerprint-binding.test.ts` → 11/11 passed. **Satisfied** (fixed by 05-39).

All four bullets satisfied. Appended a `## Closed 2026-09-20` section to the todo with the exact evidence above (file/line quotes, grep output, passing test run), then moved it: `git mv .planning/todos/pending/2026-09-19-trust-fingerprint-toctou.md .planning/todos/completed/2026-09-19-trust-fingerprint-toctou.md`.

**Note on the rename diff:** because the closing evidence added (~82 lines) is larger than the original file's content (59 lines), git's *default* 50% similarity threshold for `git diff --cached --name-status` no longer auto-detects this as a rename (it shows as add+delete at the default threshold). Verified with an explicit, lower similarity threshold instead: `git diff --cached --name-status -M30%` → `R036  .../pending/2026-09-19-trust-fingerprint-toctou.md  .../completed/2026-09-19-trust-fingerprint-toctou.md` (36% similarity, correctly identified as a rename). The move itself was performed with `git mv` (never `cp`+`rm`), as required — the content addition afterward is what pushed the similarity below git's default auto-detection threshold, not the move mechanism.

## Commands run and pass counts

| Command | Result |
|---|---|
| `pnpm test:integration tests/integration/services/edit-server.test.ts` (Task 1 RED) | 4 failed, 29 passed (33) |
| `pnpm test:integration tests/integration/services/edit-server.test.ts` (Task 1 GREEN) | 33/33 passed |
| `pnpm test:integration tests/integration/services/edit-server.test.ts` (Task 2, fix temporarily disabled, RED capture) | 5 failed, 30 passed (35) |
| `pnpm test:integration tests/integration/services/edit-server.test.ts` (Task 2, fix restored) | 35/35 passed |
| `pnpm test:integration tests/integration/servers/edit-clears-pending-fingerprint.test.ts` | 5/5 passed |
| `pnpm test:integration tests/integration/services/edit-server.test.ts tests/integration/servers/edit-clears-pending-fingerprint.test.ts` (combined, final) | 40/40 passed |
| `NOODARA_API_ORIGIN=http://localhost:3100 pnpm test:integration tests/integration/services/trust-fingerprint.test.ts` (hard rule 5 re-run) | 11/11 passed |
| `NOODARA_API_ORIGIN=http://localhost:3100 pnpm test:integration tests/integration/servers/trust-fingerprint-binding.test.ts` (hard rule 5 re-run) | 11/11 passed |
| `pnpm test` (full unit suite) | 1525/1525 passed |
| `pnpm lint` | 9/9 turbo tasks clean |
| `pnpm typecheck` | 8/8 turbo tasks clean |

`git diff --name-only 64ed05a..HEAD` lists exactly this plan's five `files_modified` paths and no others. The full ~35min integration suite was deliberately not run, per hard rule 5 and the plan's own constraint — deferred to 05-46.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - test-design bug, self-found before commit] Task 2's original Test A/B arrangement masked the fix under test**
- **Found during:** Task 2, while capturing the literal RED output by temporarily disabling the Task 1 fix.
- **Issue:** The first draft of Test A/B left the server `CONNECTED` after the arrangement connect. Editing a `CONNECTED` row already triggers D-14's own **pre-existing** CONNECTED-branch fingerprint clear (unrelated to this plan), so Test A passed even with `hostIdentityChanged` disabled — it wasn't actually testing this plan's fix.
- **Fix:** Added an explicit `setServerStatus(fixture, server.id, 'UNREACHABLE')` step before the edit (Test A) and before the second connect (Test B, for a fair comparison), isolating the assertion to the new status-independent predicate.
- **Files modified:** `tests/integration/services/edit-server.test.ts` (not yet committed at the time — folded into the single `test(05-40)` commit `af0fca2`, since this was caught before Task 2's tests were ever committed).
- **Verification:** Re-ran with the fix disabled — Test A now genuinely failed for the right reason; Test B (control) still passed. Restored the fix and re-ran — 35/35 passed.
- **Commit:** folded into `af0fca2` (caught pre-commit, no separate fix commit needed).

No other deviations. Task 3's per-bullet evidence required no code changes — all four bullets were already satisfied by 05-38, 05-39 and this plan's own Task 1.

**Total deviations:** 1 self-caught test-design issue, fixed before any commit.
**Impact on plan:** None on scope — the fix kept Task 2's tests inside this plan's stated purpose (proving the fix, not accidentally proving an unrelated pre-existing behavior).

## Issues Encountered

None beyond the deviation above.

## User Setup Required

None — no external service configuration required.

## Threat Model Coverage

All six entries in `05-40-PLAN.md`'s STRIDE register were addressed:
- T-5G-40-01 (alarm fatigue from a spurious HOST_KEY_CHANGED after a non-CONNECTED re-point): closed by Task 1's `hostIdentityChanged` clear, proven end-to-end by Task 2's Test A.
- T-5G-40-02 (clearing the trusted key on an sshUser-only change would reopen TOFU): `hostIdentityChanged` deliberately excludes `sshUser`; Task 1's dedicated test and the pre-existing D-14 CONNECTED test both assert the fingerprint survives.
- T-5G-40-03 (mismatch detection itself broken rather than state cleared): Task 2's Test B (control) proves a differing key without a prior edit still produces `HOST_KEY_CHANGED` with the observed value parked.
- T-5G-40-04 (closing the todo on a SUMMARY claim again): Task 3's evidence is four `file:line` quotes plus one passing test run, verified first-hand this session, no SUMMARY citation.
- T-5G-40-05 (credential material in logs/activity, accepted): no logging added by this plan; `editServer` still never selects or decodes the credential.
- T-5-40-SC (supply chain): nothing installed; `package.json`/`pnpm-lock.yaml` untouched (confirmed via `git diff --name-only`).

## Known Stubs

None. No hardcoded empty values, placeholder text, or unwired data sources were introduced.

## Threat Flags

None — this plan only tightens an existing trust boundary already covered by its own threat model; no new network endpoint, auth path, file access pattern, or schema change was introduced. No schema migration.

## Next Phase Readiness

Gap 6 / `05-REVIEW.md` GR-01 and GR-02 are both closed (GR-01 by 05-38/05-39, GR-02 by this plan). The re-opened `2026-09-19-trust-fingerprint-toctou.md` todo is closed with first-hand, per-bullet evidence. Round 2 wave 3 (this plan) is complete; wave 4 is 05-46 (full gate + human checkpoint, including the deferred full integration suite).

---
*Phase: 05-ui-web*
*Completed: 2026-09-20*
