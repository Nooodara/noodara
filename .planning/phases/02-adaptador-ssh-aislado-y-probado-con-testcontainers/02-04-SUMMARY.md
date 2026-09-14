---
phase: 02-adaptador-ssh-aislado-y-probado-con-testcontainers
plan: 04
subsystem: testing
tags: [ssh2, testcontainers, tofu, docker-detection, error-classification, empirical-spike]

# Dependency graph
requires:
  - phase: 02-adaptador-ssh-aislado-y-probado-con-testcontainers
    provides: "02-01's packages/ssh scaffold (SshPort contracts, frozen COMMAND_TEMPLATES) and 02-02's real sshd fixture images plus tests/integration/helpers/ssh.ts (startSshd, startBlackholeListener, waitForSlowCommandStart, hostKeyFingerprint, readTestKey)"
provides:
  - "docs/adr/0004-ssh-adapter-empirical-contracts.md — measured answers to 02-RESEARCH.md's three open questions: hostVerifier's raw-key contract + TOFU fingerprint derivation, Docker version detection shapes, and the CONNECT_TIMEOUT strategy + full ssh2 error-shape table"
  - "tests/integration/ssh/contracts.test.ts — 25 standing integration assertions that fail if a future ssh2/Docker CLI upgrade changes any recorded shape"
  - "packages/domain/src/discovery/fixtures/ubuntu-{22.04,24.04}/ — 42 real captured command-output files (plus a README documenting captured-vs-derived) every parser in plan 02-05 is tested against"
  - "scripts/capture-discovery-fixtures.mjs — reproducible, idempotent capture script"
  - "A fixed tests/integration/helpers/ssh.ts:startBlackholeListener — the CONNECT_TIMEOUT primitive plans 02-05..02-10 all depend on now actually blackholes"
  - "packages/ssh/src/testing/raw-ssh2.ts — a build-excluded, test-only re-export of ssh2's Client/utils, importable as @noodara/ssh/testing, so integration tests can drive raw ssh2 without violating packages/ssh's ssh2-containment boundary"
affects: ["02-05 (discovery parsers — Docker detection branch and fixture set)", "02-06 (TOFU/key-loading implementation)", "02-07 (error classifier)", "02-08..02-10 (every remaining QA-03 scenario plan reuses the fixed startBlackholeListener)"]

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "packages/*/src/testing/ as the established location for a build-excluded, Vitest-alias-only module that lets an integration test drive a package's normally-contained third-party dependency without violating that package's own containment boundary test"
    - "attemptConnect(config) => Promise<{ok,elapsedMs,...}> as the one raw-ssh2.Client connect helper every empirical spike test reuses, with a permanent no-op 'error' listener attached after settling to prevent an abandoned Client's later socket error from becoming an uncaught exception"
    - "writeIfChanged(path, content) in a fixture-capture script: compare-before-write plus a printed changed-file list is the idempotency proof a plan's own acceptance criteria can grep for"

key-files:
  created:
    - docs/adr/0004-ssh-adapter-empirical-contracts.md
    - tests/integration/ssh/contracts.test.ts
    - scripts/capture-discovery-fixtures.mjs
    - packages/domain/src/discovery/fixtures/README.md
    - packages/domain/src/discovery/fixtures/ubuntu-22.04/*.{txt,json} (21 files)
    - packages/domain/src/discovery/fixtures/ubuntu-24.04/*.{txt,json} (21 files)
    - packages/ssh/src/testing/raw-ssh2.ts
  modified:
    - tests/integration/helpers/ssh.ts (startBlackholeListener bugfix)
    - vitest.shared.ts (@noodara/ssh/testing source alias)
    - packages/ssh/package.json (@types/ssh2 devDependency)
    - pnpm-lock.yaml

key-decisions:
  - "TOFU: utils.parseKey(rawHostVerifierArgument).type is the technique plan 02-06 must use to extract the host key algorithm name — measured to work directly against the raw wire-format Buffer via ssh2's own binary-fallback parse branch, no manual byte-offset decode needed in production code."
  - "CONNECT_TIMEOUT: candidate (a), the accept-then-silent TCP listener, remains the chosen strategy — but its nc invocation was broken (see Deviations) and had to be fixed before it produced the readyTimeout shape it always claimed to."
  - "Docker detection: branch on exit code (127 = not installed, non-zero-with-valid-JSON = installed/daemon-unreachable), never on JSON.parse success alone — captured real shapes for both, never fabricated."
  - "Mid-exec transport death maps to CONNECTION_LOST via the channel closing with no exit code while a command was outstanding — ssh2 raises no 'error' event for this path at all, measured directly, contradicting the ECONNRESET originally sketched in 02-CONTEXT.md."
  - "A .invalid-TLD hostname is not a reliable HOST_UNRESOLVED trigger on this resolver — it stalls for the full readyTimeout instead of failing fast with ENOTFOUND. Plan 02-07's classifier must handle both possible shapes for a bad hostname."

patterns-established:
  - "Wave-0 empirical spike discipline: measure against the real fixture, write the finding into a standing test plus an ADR, and correct any code (even from an already-completed prior plan) the measurement proves wrong, rather than shipping downstream code against an assumption."

requirements-completed: [SEC-03, DISC-01, QA-03]

# Metrics
duration: ~2h50min
completed: 2026-09-14
---

# Phase 2 Plan 4: SSH Adapter Empirical Contracts (Wave 0 Spikes) Summary

**Measured, not guessed, the three load-bearing unknowns blocking plans 02-05..02-07 — hostVerifier's raw-key/TOFU contract, Docker version detection shapes, and the CONNECT_TIMEOUT/error-classifier input table — against real Ubuntu 22.04/24.04 sshd containers, catching and fixing a real bug in plan 02-02's CONNECT_TIMEOUT primitive along the way.**

## Performance

- **Duration:** ~2h50m
- **Started:** 2026-09-14T08:50:00-06:00 (approx.)
- **Completed:** 2026-09-14T11:40:00-06:00
- **Tasks:** 3 completed
- **Files modified:** 7 created (plus 42 fixture files), 4 modified

## Accomplishments

- **Open question 1 (hostVerifier/TOFU) answered by direct measurement:** `hostVerifier` receives the raw RFC 4253 host key blob as a `Buffer`; `utils.parseKey(rawArgument).type` accepts it directly (technique (a) wins, exactly as 02-RESEARCH.md's own recommendation predicted); the computed `SHA256:<base64>` fingerprint matches `ssh-keygen -lf` byte-for-byte for ed25519, RSA (forcing `rsa-sha2-512`) and ECDSA host keys; ssh2's own default negotiation already picks ed25519 first (no override needed); a wrong passphrase and a malformed key both fail `parseKey` as a plain `Error` but with distinguishable verbatim messages.
- **Open question 2 (Docker detection) answered with 42 real captured fixture files** across both Ubuntu versions: `docker version --format json` exits 127 with empty stdout when the CLI is absent, and exits non-zero with valid JSON (`Client` populated, `Server: null`) when the CLI is present but the daemon is unreachable — stderr never contaminates stdout in either case. `scripts/capture-discovery-fixtures.mjs` is reproducible and idempotent (a second run only touches genuinely variable fields: hostname, memory, disk, uptime).
- **Open question 3 (CONNECT_TIMEOUT + error classifier) answered, and a real bug from plan 02-02 was found and fixed:** the original `startBlackholeListener` (`while true; do nc -l -p 9000; done`) failed in 2ms with `Connection lost before handshake` instead of a `readyTimeout` — plain BusyBox `nc -l`'s stdout write breaks the instant `ssh2` sends its identification banner. Fixed to `nc -lk -p 9000 -e /bin/sleep infinity`, re-measured to produce a clean, deterministic `readyTimeout` every time. The two rejected candidates (a Docker-internal unpublished IP, and `10.255.255.1`) were also measured and both happened to time out on this machine, but are flagged as not portable to every CI network configuration. A full eight-row `ssh2` error-shape table was captured (wrong password, unauthorized key, wrong username, `.invalid` hostname, refused port, blackhole, fingerprint mismatch, mid-exec death), including two genuine surprises: a `.invalid` hostname stalls for the full `readyTimeout` instead of failing fast with `ENOTFOUND` on this resolver, and a transport that dies mid-exec raises **no `'error'` event at all** on either the client or the channel — just a graceful `end`/`close` sequence with no exit code.
- Full regression stayed green throughout: `pnpm build`, `pnpm lint`, `pnpm typecheck`, `pnpm exec turbo boundaries` (212 files), 402/402 unit tests, and 156/156 integration tests (131 pre-existing + 25 new), with zero `noodara.test=true` containers left running after any run.

## Task Commits

1. **Task 1: Measure ssh2's hostVerifier contract and prove the fingerprint matches ssh-keygen** - `6d8978d` (feat)
2. **Task 2: Capture real discovery output for both Ubuntu versions** - `ef6397c` (feat)
3. **Task 3: Choose the CONNECT_TIMEOUT strategy and record the real ssh2 error shapes** - `8c0f2b6` (feat)

**Plan metadata:** (this commit) `docs: complete plan`

## Files Created/Modified

- `docs/adr/0004-ssh-adapter-empirical-contracts.md` - Status/Context/three Open Question sections/Rejected alternatives/Consequences, matching ADR 0003's format
- `tests/integration/ssh/contracts.test.ts` - 25 standing tests: hostVerifier raw-key contract (6), Docker detection shapes (8, `describe.each` over both Ubuntu versions), CONNECT_TIMEOUT candidates (3), ssh2 error-shape table (6), mid-exec transport death (2, one per Ubuntu version)
- `scripts/capture-discovery-fixtures.mjs` - Reproducible, idempotent capture of all 11 discovery/docker/access commands from both plain and `dockerCli:true` image variants, for both Ubuntu versions, as `deployer` and `restricted`
- `packages/domain/src/discovery/fixtures/README.md` + 42 fixture files - real captured command output, with a table stating which command/user/exit-code each file represents and an explicit captured-vs-derived statement
- `packages/ssh/src/testing/raw-ssh2.ts` - test-only re-export of `ssh2`'s `Client`/`utils`, excluded from the production build, resolvable only via the new `@noodara/ssh/testing` Vitest source alias
- `tests/integration/helpers/ssh.ts` - `startBlackholeListener`'s container command fixed from `while true; do nc -l -p 9000; done` to `nc -lk -p 9000 -e /bin/sleep infinity`
- `vitest.shared.ts`, `packages/ssh/package.json`, `pnpm-lock.yaml` - plumbing for the new testing module (`@types/ssh2` devDependency, source alias)

## Decisions Made

See `key-decisions` in the frontmatter. In short: `utils.parseKey(...).type` for TOFU's algorithm-name extraction; branch Docker detection on exit code, never on `JSON.parse` alone; keep the accept-then-silent blackhole listener as the CONNECT_TIMEOUT primitive (once its real `nc` bug is fixed) instead of switching to a host-network-dependent candidate; map mid-exec transport death to `CONNECTION_LOST` via a channel closing with no exit code, since `ssh2` never raises an `'error'` event for that path.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] `startBlackholeListener` (plan 02-02) did not actually blackhole**
- **Found during:** Task 3, measuring candidate (a)
- **Issue:** `while true; do nc -l -p 9000; done` failed the connection in ~2ms with `Connection lost before handshake` (`level: 'protocol'`) instead of a `readyTimeout` — plain BusyBox `nc -l`'s stdout write fails the instant `ssh2` sends its identification banner, and `nc` exits, resetting the connection.
- **Fix:** Changed the container command to `nc -lk -p 9000 -e /bin/sleep infinity` — `-e` hands the socket to a process that never reads or writes it, and `-k` keeps one listener alive across connections with no shell-loop respawn race. Re-measured: two sequential attempts both failed with the correct `readyTimeout`/`client-timeout` shape at the configured timeout ±1-2ms.
- **Files modified:** `tests/integration/helpers/ssh.ts`
- **Verification:** `pnpm exec vitest run --config vitest.integration.config.ts tests/integration/ssh/` (41/41 pass, including the fixed candidate-(a) assertion); full `pnpm test:integration` re-run afterward (156/156).
- **Committed in:** `8c0f2b6` (Task 3 commit)

**2. [Rule 3 - Blocking issue] `packages/ssh/src/boundary.test.ts` forbids importing `ssh2` from any file outside `packages/ssh`, blocking Task 1's own instruction to drive a raw `ssh2.Client`**
- **Found during:** Task 1, before writing the first assertion
- **Issue:** The plan explicitly requires `tests/integration/ssh/contracts.test.ts` (which lives outside `packages/ssh`) to use a raw `ssh2.Client`, but the existing boundary test scans `tests/**` and fails any file there that imports `ssh2` directly.
- **Fix:** Added `packages/ssh/src/testing/raw-ssh2.ts` — a thin, permanent, build-excluded (`tsconfig.build.json` already excluded `src/testing/**` since plan 02-01, unused until now) re-export of `ssh2`'s `Client`/`utils`, reachable only via a new Vitest-only source alias `@noodara/ssh/testing` (never a real package `exports` subpath, so plain Node can never reach it). `packages/ssh`'s own `boundary.test.ts` exempts this file since it lives under `packages/ssh`.
- **Files modified:** `packages/ssh/src/testing/raw-ssh2.ts` (new), `vitest.shared.ts`, `packages/ssh/package.json` (`@types/ssh2` devDependency needed for `tsc --noEmit` to pass), `pnpm-lock.yaml`
- **Verification:** `pnpm --filter @noodara/ssh lint` and `typecheck` both clean; `packages/ssh/src/boundary.test.ts` still passes (28/28 in that file's suite).
- **Committed in:** `6d8978d` (Task 1 commit)

**3. [Rule 1 - Bug] `attemptConnect`'s one-shot `'error'` listener let an abandoned `Client`'s later socket error become an uncaught exception**
- **Found during:** Task 3, running the full `tests/integration/ssh/` suite
- **Issue:** Several failure-mode fixtures (blackhole listener, stopped container) are torn down in `afterEach` after their connection attempt already failed via a `.once('error', ...)` listener; the abandoned `Client`'s socket can emit a second, later `'error'` during that teardown, which — with no listener left — crashed the test run as an uncaught exception.
- **Fix:** `attemptConnect`'s `settle()` now calls `client.removeAllListeners('error')` followed by a permanent no-op `'error'` listener once the promise has resolved.
- **Files modified:** `tests/integration/ssh/contracts.test.ts`
- **Verification:** Re-ran the full `tests/integration/ssh/` suite twice with no unhandled-error report.
- **Committed in:** `8c0f2b6` (Task 3 commit)

---

**Total deviations:** 3 auto-fixed (2 bugs found by measurement, 1 blocking-infrastructure addition required by the plan's own instructions)
**Impact on plan:** All three were necessary to make the plan's own verification commands pass against real, correct behavior. No scope creep — each fix is scoped to exactly the file(s) the discovered problem lived in.

## Issues Encountered

- The mid-exec transport-death test initially timed out waiting for the channel's `'close'` event, even though the client's own `'end'`/`'close'` fired reliably every time. Root cause, itself a genuine measured finding: a `ClientChannel` is a paused-mode `Duplex` — `ssh2`'s internal `push(null)` on transport death is silently buffered and never surfaces as `'end'`/`'close'` unless something drains the stream (`'data'` listener or `.resume()`). Fixed by calling `channel.resume()`/`channel.stderr.resume()` right after opening the channel; documented in the ADR since it is not a production gap (the real adapter's `exec()` always attaches a `'data'` listener) but is a real trap for spike/debugging code.
- `packages/ssh/package.json` needed `@types/ssh2` added as a devDependency for `tsc --noEmit` to resolve `packages/ssh/src/testing/raw-ssh2.ts`'s `ssh2` import; the type package was already present transitively (via `testcontainers`'s own `dockerode`/`docker-modem` dependency chain) but never declared directly. Added at the exact version (`1.15.6`) already resolved in `pnpm-lock.yaml`, requiring no new network fetch.

## User Setup Required

None - no external service configuration required.

### Note on REQUIREMENTS.md tracking granularity

Running `requirements.mark-complete SEC-03 DISC-01 QA-03` (per this plan's
own `requirements:` frontmatter) marked `DISC-01` as `[x] Complete` in
`.planning/REQUIREMENTS.md` (SEC-03 and QA-03 were already marked
complete by earlier plans). That tool has no notion of partial/
contributing completion — it is a first-write-wins checkbox. `DISC-01`
("Noodara descubre ... usando salidas estructuradas y parsers testeados")
is **not actually fully satisfied yet**: this plan captures the real
fixtures those parsers will be tested against, but the parsers themselves
(`packages/domain`'s discovery output parsers) are plan 02-05's job, not
this plan's. Flagging here so `noodara-release-gate`/a future verifier
checks the phase's actual acceptance criteria rather than trusting this
checkbox alone before plan 02-05 lands.

## Next Phase Readiness

- Plan 02-05 (discovery parsers) can now be written directly against `packages/domain/src/discovery/fixtures/ubuntu-{22.04,24.04}/**` — real captured output for every command, including both Docker-detection branches with exit codes preserved in `.meta.json` siblings.
- Plan 02-06 (TOFU/key loading) can implement `utils.parseKey(rawArgument).type` directly, per the ADR's measured recommendation, with no further experimentation needed.
- Plan 02-07 (error classifier) has a complete, measured eight-row input table (`docs/adr/0004`'s Open Question 3 section) including the two shapes that would otherwise have been guessed wrong: a `.invalid` hostname's `client-timeout` shape (not `ENOTFOUND`), and mid-exec death's complete absence of an `'error'` event.
- Plans 02-05..02-10 all inherit the now-fixed `startBlackholeListener` for free — no further action needed in those plans.
- No blockers identified for 02-05.

---
*Phase: 02-adaptador-ssh-aislado-y-probado-con-testcontainers*
*Completed: 2026-09-14*

## Self-Check: PASSED

- All 8 key created/modified files verified present on disk (`docs/adr/0004-ssh-adapter-empirical-contracts.md`, `tests/integration/ssh/contracts.test.ts`, `scripts/capture-discovery-fixtures.mjs`, `packages/domain/src/discovery/fixtures/README.md`, `packages/ssh/src/testing/raw-ssh2.ts`, `tests/integration/helpers/ssh.ts`, `vitest.shared.ts`, `packages/ssh/package.json`).
- All 3 task commit hashes (`6d8978d`, `ef6397c`, `8c0f2b6`) verified present in `git log`.
