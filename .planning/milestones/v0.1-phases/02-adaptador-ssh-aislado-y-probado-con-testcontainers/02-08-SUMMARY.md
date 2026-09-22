---
phase: 02-adaptador-ssh-aislado-y-probado-con-testcontainers
plan: 08
subsystem: ssh-adapter
tags: [ssh2, connect, retry, mutex, tdd, serv-07, sec-03]

# Dependency graph
requires:
  - phase: 02-adaptador-ssh-aislado-y-probado-con-testcontainers
    provides: "02-01's SshPort/SshCredential/ConnectOutcome contracts and command allowlist; 02-06's loadPrivateKey/createHostVerifier/formatFingerprint; 02-07's classifySshError/execWithTimeout/errors.ts markers; ADR 0004's measured ssh2 error/hostVerifier/mid-exec-death shapes"
provides:
  - "packages/ssh/src/ssh2-adapter.ts — createSsh2Adapter: the single ssh2.Client owner implementing SshPort.connect (never rejects/throws), SshSession.exec/close"
  - "packages/ssh/src/retry.ts — RETRYABLE_ERROR_CODES/withRetry: D-10's single-retry-after-2s policy with an injected clock"
  - "packages/ssh/src/connection-mutex.ts — createConnectionMutex: one active connection per user@host:port"
affects: ["02-09 (runDiscovery reuses the SshSession this adapter's successful connect() returns)", "02-10 (Testcontainers suite drives createSsh2Adapter() with a real ssh2.Client against real sshd fixtures for every scenario this plan's unit tests only simulate)"]

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "Injectable ssh2.Client seam (deps.createClient, defaulting to a real ssh2.Client) is what makes every ssh2 event/callback branch reachable from a unit test without pretending to test connection outcomes against a fake — connection outcomes stay plan 02-10's job against real containers"
    - "A single persistent 'error'/'close' listener pair, attached once before connect() and never removed, is shared mutable state (SessionState) read by both the connect-phase promise and the post-ready session — the one place SERV-07's 'no unhandled error event' guarantee lives"
    - "Mutex on the outside, retry on the inside: createConnectionMutex().runExclusive wraps withRetry(attemptConnect), so both attempts of a retried connect share the one per-target slot instead of a second connect racing a still-settling first one"
    - "withRetry's generic constraint (T extends { ok: boolean; errorCode?: ServerErrorCode }) lets it retry any discriminated-union outcome shape, not just ConnectOutcome, decided purely on the outcome's own errorCode — never on a caught exception"

key-files:
  created:
    - packages/ssh/src/ssh2-adapter.ts
    - packages/ssh/src/ssh2-adapter.test.ts
    - packages/ssh/src/retry.ts
    - packages/ssh/src/retry.test.ts
    - packages/ssh/src/connection-mutex.ts
    - packages/ssh/src/connection-mutex.test.ts
  modified: []

key-decisions:
  - "A private-key credential's validation failure (both loadPrivateKey's 'validation' and 'auth' kinds) is reported as ConnectOutcome's AUTH_FAILED — the plan's own contract only has seven ServerErrorCodes and none of them is a generic 'invalid credential' code; AUTH_FAILED is the closest fit (D-10 never retries it, statusForErrorCode lands it on ERROR, matching a permanently-broken credential) and the loader's own message is preserved verbatim."
  - "SessionState (inFlightCommand/onTransportLost/closed) is a single mutable object shared between the connect-phase promise executor and the session created after 'ready', so the one 'error'/'close' listener pair attached before connect() can route a post-ready event to whichever exec() call is currently in flight, rather than registering a second listener pair per session (which would leave the connect-phase listener orphaned but still attached, violating the plan's 'kept for the lifetime' instruction)."
  - "SshExecFailure (new, exported) wraps every session.exec() rejection in a classified SshFailure (errorCode + redacted message) — covers both execWithTimeout's own CommandTimeoutError path and the client-level mid-exec transport-death path (constructed via a TransportClosedError fed through classifySshError), so 02-09's runDiscovery only ever sees one rejection shape."
  - "createSsh2Adapter accepts an optional deps.sleep (defaulting to retry.ts's real setTimeout-backed sleep) purely so ssh2-adapter.test.ts's retry-wiring tests never wait the real 2s D-10 gap — a buildAdapter() test helper defaults every other test's sleep to a fast no-op too, since several failure-path tests (a synchronously-throwing client, an unclassified generic Error) land on the classifier's CONNECTION_LOST fallback and are therefore retryable by D-10's own policy."
  - "connection-mutex.ts's runExclusive chains a per-key tail promise that always settles (via .then(()=>undefined,()=>undefined)) regardless of the guarded function's own outcome, so the next acquisition for that key is never blocked by this run's rejection — the guarded function's real rejection still propagates to its own caller through the separate 'result' promise."

patterns-established:
  - "buildHostKeyChangedMessage renders both the trusted and observed fingerprint (with key types) via the existing formatFingerprint helper and states the required out-of-band verification step with no hint the change might be benign (D-06) — built and redacted by the adapter itself, since classifySshError's own host-key-changed rule has no access to either HostFingerprint value."

requirements-completed: [SERV-07, SEC-03, SEC-04]

# Metrics
duration: ~95min
completed: 2026-09-14
---

# Phase 2 Plan 8: Ssh2Adapter — connect, session, retry and the per-target mutex Summary

**`createSsh2Adapter` is the single `ssh2.Client` owner implementing `SshPort`: TOFU-verified connect with key/password/keyboard-interactive auth, allowlist-only `exec` through `execWithTimeout`, D-10's single retry after a 2s injected wait, and a per-`user@host:port` mutex — all unit-tested via an injectable client seam, with connection outcomes against real sshd deferred to plan 02-10.**

## Performance

- **Duration:** ~95 min
- **Started:** 2026-09-14T16:29:00Z (approx.)
- **Completed:** 2026-09-14T18:05:00Z
- **Tasks:** 2 completed (each via RED → GREEN TDD), plus one wiring commit joining Task 2's retry/mutex modules into the Task 1 adapter
- **Files modified:** 6 created (0 modified)

## Accomplishments

- **Task 1 (`Ssh2Adapter` core, SERV-07/SEC-03):** `createSsh2Adapter(deps?)` takes an injectable `createClient` (defaulting to a real `ssh2.Client`) so every branch — a synchronously-throwing `connect()`, a synchronously-throwing `createClient`, each ADR-0004-measured `error` shape, a mismatching `hostVerifier` blob — is driven by a fake without pretending to test connection *outcomes*. Every `client.connect()` call is built by one named function (`buildConnectOptions`) that always supplies `hostVerifier`, never `hostHash`, `readyTimeout === timeouts.connectMs`, `keepaliveInterval === 10000`, and the exact D-05 ordered `algorithms.serverHostKey` list (ed25519, then ECDSA 256/384/521, then RSA SHA-2 512/256). A private-key credential is validated via `loadPrivateKey` *before* `createClient()` is ever called (a validation or wrong-passphrase failure reports `AUTH_FAILED` with the loader's own message, and no socket opens); a password credential sets `tryKeyboard` and answers an all-password `keyboard-interactive` challenge with the same revealed password for every prompt, aborting (`finish([])`) on any non-password prompt so ssh2 exhausts auth and the classifier reports `AUTH_FAILED` (D-03). A single `error`/`close` listener pair is attached *before* `client.connect()` and kept registered for the connection's entire lifetime (never removed) — the direct guard against SERV-07's most likely real-world violation, an unhandled `'error'` event after `ready` crashing the process. `HOST_KEY_CHANGED` carries `observedFingerprint` and a message rendering both the trusted and observed fingerprint (with key types) via `formatFingerprint`, with an explicit out-of-band-verification instruction and no hint the change might be benign (D-06). `session.exec` delegates to `execWithTimeout` and additionally races a "transport lost" signal fed by the shared listener pair: a client-level `close` with no prior `error` while a command is outstanding constructs a `TransportClosedError` (ADR 0004 row 8's exact no-error-event mid-exec-death signal) and rejects with a classified `CONNECTION_LOST` `SshExecFailure`. `session.close()` calls `client.end()` exactly once even across repeated calls and always resolves.
- **Task 2 (D-10 retry + per-target mutex, then wired into the adapter):** `retry.ts` exports `RETRYABLE_ERROR_CODES` (`['CONNECT_TIMEOUT', 'CONNECTION_LOST']`, frozen) and `withRetry`, which runs an attempt once, and — only for a retryable `errorCode` — awaits an injected `sleep(2000)` before running it exactly one more time, reporting `attempts: 1` or `attempts: 2` on both the success and failure branch; a table-driven test iterates all seven `ServerErrorCode`s and asserts exactly the two retryable ones trigger a second attempt. `connection-mutex.ts` exports `createConnectionMutex().runExclusive(key, fn)`, implemented as a per-key chain of tail promises that always settles regardless of `fn`'s own outcome (so a rejecting `fn` can never wedge the key — verified by re-acquiring the same key immediately afterward) while two different keys run fully concurrently. Both are wired into `Ssh2Adapter.connect`: the mutex on the outside (keyed `user@host:port`), `withRetry` on the inside, so a retried connect's two attempts share the one slot instead of racing a second connect against a still-settling first one. `createSsh2Adapter` also accepts an optional `deps.sleep` purely so no adapter test waits the real 2s gap.
- Full regression stayed green throughout: `pnpm build`, `pnpm lint`, `pnpm typecheck`, `pnpm exec turbo boundaries` (268 files), `pnpm exec vitest run --project packages packages/ssh/src/boundary.test.ts` (`ssh2` still imported only inside `packages/ssh`), 582/582 unit tests (was 546 before this plan, +36: 19 in `ssh2-adapter.test.ts`, 13 in `retry.test.ts`, 4 in `connection-mutex.test.ts`), and 155/156 integration tests — the one pre-existing, environment-dependent failure in `tests/integration/ssh/contracts.test.ts` (a plan-02-04 file, untouched by this plan) is documented below and in `deferred-items.md`, not caused by this plan's changes.

## Task Commits

Each task followed RED (`test:`) then GREEN (`feat:`):

1. **Task 1: Ssh2Adapter — connect, session, close, no unhandled path (SERV-07, SEC-03)** — `1369f17` (test, RED) → `26d7b08` (feat, GREEN)
2. **Task 2: D-10 single retry and the per-server connection mutex** — `5d17876` (test, RED) → `3cdcd67` (feat, GREEN) → `23ed773` (feat: wire retry/mutex into `Ssh2Adapter.connect`, plus adapter-level wiring tests)

**Plan metadata:** (this commit) `docs: complete plan`

## Files Created/Modified

- `packages/ssh/src/ssh2-adapter.ts` - `createSsh2Adapter(deps?)`: `SshPort` implementation, `SshExecFailure`, `CreateSsh2AdapterDeps`
- `packages/ssh/src/ssh2-adapter.test.ts` - 19 tests: connect-options wiring, never-rejects/throws, private-key/password credential handling, D-03 keyboard-interactive, D-06/D-07 fingerprint capture/mismatch, `session.exec`/`close`, connect-phase close-before-ready, D-10 retry and mutex wiring
- `packages/ssh/src/retry.ts` - `RETRYABLE_ERROR_CODES`, `withRetry`, `sleep` (production default)
- `packages/ssh/src/retry.test.ts` - 13 tests: exactness over all seven `ServerErrorCode`s, attempts count on every branch, exact 2000ms wait via injected clock, no third attempt
- `packages/ssh/src/connection-mutex.ts` - `createConnectionMutex`, `ConnectionMutex`
- `packages/ssh/src/connection-mutex.test.ts` - 4 tests: same-key serialisation, cross-key concurrency, release-on-rejection, sequential re-acquisition

## Decisions Made

See `key-decisions` in the frontmatter. In short: private-key validation failures land on `AUTH_FAILED` (the closest of the seven `ServerErrorCode`s to "unusable credential"); a single shared `SessionState` object lets one `error`/`close` listener pair (attached once, before `connect()`) serve both the connect-phase promise and the post-ready session; `SshExecFailure` gives every `session.exec()` rejection one classified shape; `deps.sleep` is adapter-level injectable purely for fast, deterministic tests; the connection mutex always settles its own internal chain regardless of the guarded function's outcome so a failure can never wedge a target.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] Adapter-level tests unintentionally waited real wall-clock time once retry was wired in**
- **Found during:** Task 2's wiring step, first `pnpm exec vitest run` after adding `withRetry`/mutex to `connect()`
- **Issue:** Several Task 1 tests intentionally exercise a generic, unclassified failure (a synchronously-throwing client, a plain `Error` from `createClient`, a connect-phase `close` with no error) — all of which land on `classifySshError`'s `unclassified-fallback` rule, which maps to `CONNECTION_LOST`. Once `connect()` wrapped `attemptConnect` in `withRetry`, these outcomes became retryable, and since those tests never injected a `sleep`, they started waiting the real 2000ms production default — three tests went from ~0ms to ~2000ms each.
- **Fix:** Added a `buildAdapter(deps)` test helper that defaults `sleep` to a fast no-op (`() => Promise.resolve()`) for every test, overridable by the few tests that specifically assert retry timing/count; replaced all `createSsh2Adapter(...)` call sites in the test file with `buildAdapter(...)`.
- **Files modified:** `packages/ssh/src/ssh2-adapter.test.ts`
- **Verification:** Full test file re-run at ~840ms total (previously ~6.8s with three ~2s waits); `noodara-tdd` skill's "no arbitrary sleep in tests" rule restored.
- **Committed in:** `23ed773` (Task 2's wiring commit)

**2. [Rule 1 - Bug] `unified-signatures`/`dot-notation`/`no-invalid-void-type`/`require-await`/`unbound-method`/`restrict-template-expressions` lint failures on first pass**
- **Found during:** Task 1 and Task 2's first `pnpm --filter @noodara/ssh lint` runs
- **Issue:** Six distinct `typescript-eslint` rules flagged real style/correctness issues in both the implementation and test files: two separate no-arg `on()` overloads that should be one union signature; bracket-notation property access on values with known keys; `deferred<void>()`'s `resolve(value: void)` parameter; an `async close()`/arrow test callbacks with no `await`; a detached `verifier.verify` method reference; and two numeric template-literal interpolations.
- **Fix:** Merged the `'ready' | 'close'` overloads into one signature (test file and adapter); switched bracket access to dot notation; changed `deferred<void>()` to `deferred<undefined>()` with explicit `resolve(undefined)`; removed `async` from `close()` (returns `Promise.resolve()` directly) and from test callbacks with no `await`; wrapped `verifier.verify` in an arrow function; wrapped numeric interpolations in `String(...)`.
- **Files modified:** `packages/ssh/src/ssh2-adapter.ts`, `packages/ssh/src/ssh2-adapter.test.ts`
- **Verification:** `pnpm --filter @noodara/ssh lint` exits 0; `pnpm --filter @noodara/ssh typecheck` exits 0 throughout.
- **Committed in:** `26d7b08` (Task 1 GREEN), `23ed773` (Task 2 wiring)

---

**Total deviations:** 2 auto-fixed (1 real test-suite bug — a `noodara-tdd`-violating real-time wait introduced by the plan's own two-task sequencing, 1 batch of lint/style fixes)
**Impact on plan:** Both were necessary to satisfy the plan's own stated behaviour, its "no test waits real wall-clock time" verification line, and CI gates. No scope creep.

## Issues Encountered

- `tests/integration/ssh/contracts.test.ts`'s `.invalid`-TLD row (plan 02-04, untouched by this plan) now fails on this machine — `err.level` is `'client-socket'` instead of the `'client-timeout'` ADR 0004 measured, reproducing in isolation with no Docker involvement and failing in ~190ms. This is the exact resolver-dependent instability ADR 0004 itself documents ("not reachable via this exact scenario on every environment"), confirmed pre-existing and unrelated to `ssh2-adapter.ts`/`retry.ts`/`connection-mutex.ts`. Logged to `deferred-items.md`; out of this plan's scope per the executor's scope-boundary rule.

## User Setup Required

None — no external service configuration required. No authentication gates encountered.

## Next Phase Readiness

- `createSsh2Adapter()` fully implements `SshPort`; plan 02-09's `runDiscovery` can call `.connect()` and reuse the returned `session.exec()`/`close()` directly, and can catch `SshExecFailure` for a single, already-classified rejection shape.
- D-10's retry and the per-target mutex are transparent to every caller (both live inside `connect()`); no phase-3/4 caller needs to know about them.
- Plan 02-10's Testcontainers suite can exercise this exact adapter (no test double) against real Ubuntu 22.04/24.04 sshd fixtures for every scenario this plan's unit tests only simulated: successful connect+exec, wrong password, fingerprint mismatch, blackhole `CONNECT_TIMEOUT` with `attempts: 2`, and a mid-command container kill.
- One pre-existing, environment-dependent integration test failure is documented above and in `deferred-items.md` — not a blocker for 02-09, but worth a fast follow-up before 02-10 adds more scenarios to the same file.

---
*Phase: 02-adaptador-ssh-aislado-y-probado-con-testcontainers*
*Completed: 2026-09-14*

## Self-Check: PASSED

- All 6 created files verified present on disk (`packages/ssh/src/ssh2-adapter.ts` + `.test.ts`, `packages/ssh/src/retry.ts` + `.test.ts`, `packages/ssh/src/connection-mutex.ts` + `.test.ts`).
- All 5 task commit hashes (`1369f17`, `26d7b08`, `5d17876`, `3cdcd67`, `23ed773`) verified present in `git log`.
