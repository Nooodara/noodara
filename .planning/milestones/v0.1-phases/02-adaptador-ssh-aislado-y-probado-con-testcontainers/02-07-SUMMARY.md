---
phase: 02-adaptador-ssh-aislado-y-probado-con-testcontainers
plan: 07
subsystem: ssh-adapter
tags: [ssh2, error-classification, timeout, redactor, truncation, tdd]

# Dependency graph
requires:
  - phase: 02-adaptador-ssh-aislado-y-probado-con-testcontainers
    provides: "02-01's packages/ssh scaffold, SshPort/ExecResult/CommandName contracts and the frozen command allowlist; 02-04's ADR 0004 measured ssh2 error-shape table and mid-exec-transport-death finding; 02-06's key-loader/fingerprint/host-verifier this classifier's HOST_KEY_CHANGED path assumes"
provides:
  - "packages/ssh/src/errors.ts — SshFailure/CommandTimeoutError/TransportClosedError/UnsupportedOsError: the adapter's own error vocabulary, free of any ssh2 import"
  - "packages/ssh/src/error-classifier.ts — ERROR_CLASSIFICATION_RULES/classifySshError: the single, exhaustive, never-throwing ssh2 -> ServerErrorCode classification table (SERV-07)"
  - "packages/ssh/src/exec-with-timeout.ts — execWithTimeout/MAX_OUTPUT_BYTES: per-command Promise.race timeout, redaction and 64 KB truncation wrapper (SEC-04, SEC-05, D-08)"
affects: ["02-08 (SshPort.connect wires classifySshError onto real ssh2.Client 'error' events and uses execWithTimeout for SshSession.exec)", "02-09 (runDiscovery uses execWithTimeout per command and can classify UnsupportedOsError via the same table)", "02-10 (connection-loss.test.ts proves the mid-exec-transport-death rule end to end against a live container by constructing TransportClosedError from the same channel-close signal ADR 0004 measured)"]

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "Synthetic error markers (TransportClosedError, UnsupportedOsError) let a single classification table stay the one place that turns any signal — a real ssh2 Error, an internal timeout, or a condition ssh2 never raises an event for — into a uniform SshFailure, instead of each caller hand-assembling error codes"
    - "Ordered, named, frozen rule table with a visible terminal fallback rule (not an implicit else): every rule name is independently assertable in tests, and an exhaustiveness test over SERVER_ERROR_CODES fails if a rule is ever removed"
    - "Byte-exact, multi-byte-safe truncation: accumulate Buffer chunks with a running remaining-budget counter, slice (not decode) at the boundary, trim any incomplete trailing UTF-8 sequence, then decode once at the end — never concatenate-then-slice strings"
    - "Structural (not concrete-library) types for exec-with-timeout's client/channel parameters, making the fake-channel/fake-timer unit tests honest doubles of real timer/stream mechanics rather than mocks of ssh2 itself"

key-files:
  created:
    - packages/ssh/src/errors.ts
    - packages/ssh/src/error-classifier.ts
    - packages/ssh/src/error-classifier.test.ts
    - packages/ssh/src/exec-with-timeout.ts
    - packages/ssh/src/exec-with-timeout.test.ts
  modified: []

key-decisions:
  - "Added TransportClosedError and UnsupportedOsError to errors.ts (beyond the plan's own named exports SshFailure/CommandTimeoutError) so ADR 0004 row 8's mid-exec transport death (which ssh2 never raises an 'error' event for) and D-11's UNSUPPORTED_OS warning both have a named, testable rule in the same table, rather than requiring the exhaustiveness test to accept an unreachable code or a caller to hand-assemble those two SshFailure shapes ad hoc"
  - "The 'unclassified-fallback' rule is the one rule permitted to include part of an upstream message (wrapped in an actionable sentence), and classifySshError still redacts the final message unconditionally regardless of which rule matched — the redaction-invariance test registers a credential and asserts every representative case's message is unaffected"
  - "context.phase only changes the outcome for the 'socket-reset' rule (ECONNRESET/EPIPE): CONNECTION_LOST during exec, CONNECT_TIMEOUT-equivalent reasoning does not apply since a reset socket, unlike a refused port, always means a session existed and was lost — no other rule branches on phase, per the plan's instruction not to invent a distinction ADR 0004's measurements do not support"
  - "execWithTimeout's client/channel parameters are narrow structural interfaces (only exec/on/destroy), not ssh2's concrete Client/ClientChannel types, so the fake-channel unit tests exercise real timer/stream mechanics honestly instead of mocking ssh2 itself — matches 02-RESEARCH.md's 'no mocked Client for connection-outcome scenarios' rule, which is about connection *outcomes* (covered by 02-08/02-10 against real containers), not this module's timer/stream behaviour"

patterns-established:
  - "A hostile-input-safe field reader (safeStringField) wraps every property access — including the access itself, not just further use of the value — in try/catch, since a getter can throw on read; this is the shape any future classifier or redaction-adjacent code touching untyped external error objects should reuse"

requirements-completed: [SERV-07, SEC-04, SEC-05]

# Metrics
duration: ~25min
completed: 2026-09-14
---

# Phase 2 Plan 7: Exhaustive SSH Error Classification and Command Timeout Summary

**One frozen, ordered, never-throwing classification table maps every ADR-0004-measured ssh2 failure shape (plus a synthetic mid-exec-transport-death and unsupported-OS marker) to one of the seven `ServerErrorCode`s, and a `Promise.race` wrapper gives every command an independent timeout, 64 KB byte-exact truncation, and mandatory redaction.**

## Performance

- **Duration:** ~25 min
- **Started:** 2026-09-14T14:25:00-06:00 (approx.)
- **Completed:** 2026-09-14T14:48:31-06:00
- **Tasks:** 2 completed (each via RED -> GREEN TDD)
- **Files modified:** 5 created (0 modified)

## Accomplishments

- **Task 1 (error classifier, SERV-07):** `ERROR_CLASSIFICATION_RULES` is a frozen, ordered, ten-entry table checking structured fields (`level`/`code`) before any message-string match, ending in a named, visible `unclassified-fallback` rule rather than an implicit `else`. It classifies all seven rows of ADR 0004's measured ssh2 error-shape table that come from real `Error` objects (wrong password/unauthorized key/wrong username -> `AUTH_FAILED`; `.invalid`-TLD handshake stall and blackhole listener -> `CONNECT_TIMEOUT` via `connect-timeout`; refused port -> `CONNECT_TIMEOUT` via `connect-refused`; pinned fingerprint mismatch -> `HOST_KEY_CHANGED`), plus the required-but-not-directly-observed fast `ENOTFOUND`/`EAI_AGAIN` path -> `HOST_UNRESOLVED`, a generic reset/closed socket -> `CONNECTION_LOST`, `CommandTimeoutError` -> `COMMAND_TIMEOUT`, and a new `UnsupportedOsError` marker -> `UNSUPPORTED_OS`. ADR 0004 row 8 (mid-exec transport death, where ssh2 raises no `'error'` event at all) is represented by a new `TransportClosedError` marker and matched by its own named `mid-exec-transport-death` rule — a dedicated test asserts this rule matches by name, not the terminal fallback. `classifySshError` never throws for any input (asserted over `undefined`, `null`, a string, `{}`, and an object whose `message` getter throws) because every candidate field is read behind a `safeStringField` accessor that wraps the property access itself in `try`/`catch`, every rule's own `matches`/`message` call is individually guarded, and the whole function has an outer `try`/`catch` as a last-resort safety net. Every value in `SERVER_ERROR_CODES` is proven reachable by an exhaustiveness test; deleting the `unsupported-os` rule was manually verified to fail that test (then restored) per the plan's own acceptance gate. Every message is redacted before being returned, and a dedicated test registers a credential and asserts every representative case's message (including the fallback's, fed a message containing a registered secret) is unaffected or has the secret stripped.
- **Task 2 (exec-with-timeout, SEC-04/SEC-05/D-08):** `execWithTimeout` races `client.exec` against an independent `setTimeout`: on timeout it destroys only the channel (never the client — asserted via a fake client whose `end`/`destroy` spies are never called) and rejects with `CommandTimeoutError`. A single `settle()` helper guards a `settled` flag and clears the timer on every exit path (success, timeout, and the `client.exec` callback-error path), so data arriving after a timeout has fired is discarded and cannot resolve the already-settled promise (asserted directly). stdout/stderr are accumulated as `Buffer` chunks against a running per-stream byte budget (`MAX_OUTPUT_BYTES = 65_536`), sliced — never string-concatenated-then-sliced — at the boundary, with any incomplete trailing multi-byte UTF-8 sequence trimmed off before the final `toString('utf8')` decode, so a 2-byte character straddling the limit never produces a U+FFFD replacement character. Output at exactly 64 KB is not marked truncated; output over it is. Both streams pass through the injected `Redactor` as the last step before the `ExecResult` is built. `client`/`channel` are narrow structural interfaces (only `exec`/`on`/`destroy`), so every test in the file uses a fake channel and Vitest's injected fake timers — no test waits real wall-clock time, confirmed by the plan's own grep gates (`setTimeout(...\d{3,})` and `await new Promise` both return 0 in the test file, `Date.now` returns 0 in the implementation).
- Full regression stayed green throughout: `pnpm build` (unaffected), `pnpm lint`, `pnpm typecheck`, `pnpm exec turbo boundaries` (250 files, no issues), 546/546 unit tests (was 512 before this plan, +34: 24 in `error-classifier.test.ts`, 10 in `exec-with-timeout.test.ts`), and `packages/domain/**` coverage confirmed at 100% statements/branches (well above the 95% gate) via `pnpm test --coverage`'s `coverage-summary.json`.

## Task Commits

Each task followed RED (`test:`) then GREEN (`feat:`):

1. **Task 1: Exhaustive ssh2 error classification (SERV-07)** — `23b3b01` (test, RED) -> `628492f` (feat, GREEN)
2. **Task 2: Per-command timeout, redaction and truncation (SEC-04, SEC-05, D-08)** — `4822ce9` (test, RED) -> `4b7aec0` (feat, GREEN)

**Plan metadata:** (this commit) `docs: complete plan`

## Files Created/Modified

- `packages/ssh/src/errors.ts` - `SshFailure` (interface), `CommandTimeoutError`, `TransportClosedError`, `UnsupportedOsError` — the adapter's own error vocabulary, zero `ssh2`-substring occurrences anywhere in the file including comments
- `packages/ssh/src/error-classifier.ts` - `ERROR_CLASSIFICATION_RULES` (10 named, ordered, frozen rules), `classifySshError(error, context)`, `ClassifyContext` type
- `packages/ssh/src/error-classifier.test.ts` - 24 tests: ADR rows 1-7 table-driven, required-but-unmeasured shapes (ENOTFOUND/EAI_AGAIN/EPIPE), mid-exec transport death (both Ubuntu variants), documented fallback, 5 hostile inputs, exhaustiveness over `SERVER_ERROR_CODES`, and redaction-invariance including a fallback-message secret-stripping test
- `packages/ssh/src/exec-with-timeout.ts` - `execWithTimeout(input)`, `MAX_OUTPUT_BYTES = 65_536`, `ExecChannel`/`ExecWithTimeoutInput` structural types
- `packages/ssh/src/exec-with-timeout.test.ts` - 10 tests: success path, command-string-from-allowlist-only, timeout destroying only the channel, late-data discarded, exec-callback-error path, redaction, exact-limit/over-limit/multi-byte-boundary truncation, independent-per-stream truncation — all via `vi.useFakeTimers()` and a fake channel, no real waiting

## Decisions Made

See `key-decisions` in the frontmatter. In short: added two synthetic error markers (`TransportClosedError`, `UnsupportedOsError`) not named in the plan's own artifact list, both required to make ADR 0004's row 8 and D-11's warning code reachable through the same single classification table rather than assembled ad hoc by a future caller; the `unclassified-fallback` rule is the sole rule permitted to echo part of an upstream message, still passed through `redact()` unconditionally; `context.phase` is consulted by exactly one rule (`socket-reset`), matching the plan's instruction not to invent distinctions the ADR did not measure; `execWithTimeout`'s client/channel types are deliberately structural rather than `ssh2`'s concrete types.

## Deviations from Plan

None beyond the two additive error markers documented above as key decisions — both were necessary to satisfy this plan's own stated `<behavior>` and acceptance criteria (exhaustiveness over all seven `ServerErrorCode`s, and a named rule for the mid-exec shape), not scope creep beyond it.

## Issues Encountered

None. Both tasks passed their fake-timer/table-driven test suites on the first implementation attempt after the RED commit; no auto-fixes were required.

## User Setup Required

None — no external service configuration required. No authentication gates encountered.

## Next Phase Readiness

- `classifySshError` and `ERROR_CLASSIFICATION_RULES` are exported, typed, and unit-tested; plan 02-08's `SshPort.connect` can wire real `ssh2.Client` `'error'` events directly through `classifySshError(err, { phase: 'connect', redactor })` with zero further contract exploration.
- `execWithTimeout` and `MAX_OUTPUT_BYTES` are exported; plan 02-08's `SshSession.exec` implementation and plan 02-09's `runDiscovery` can call `execWithTimeout({ client, commandName, timeoutMs, redactor })` directly per command.
- `TransportClosedError` is exported for 02-08/02-09 to construct the moment they observe a channel `'close'` with no exit code while a command was outstanding (ADR 0004 row 8's exact signal), and 02-10's `connection-loss.test.ts` can assert the same rule fires end to end against a real killed container.
- `UnsupportedOsError` is exported for 02-09's discovery flow (D-11) to produce a consistent `SshFailure` shape for the detail view without hand-assembling one.
- No blockers identified for 02-08/02-09/02-10.

---
*Phase: 02-adaptador-ssh-aislado-y-probado-con-testcontainers*
*Completed: 2026-09-14*

## Self-Check: PASSED

- All 5 created files verified present on disk (`packages/ssh/src/errors.ts`, `packages/ssh/src/error-classifier.ts` + `.test.ts`, `packages/ssh/src/exec-with-timeout.ts` + `.test.ts`).
- All 4 task commit hashes (`23b3b01`, `628492f`, `4822ce9`, `4b7aec0`) verified present in `git log`.
