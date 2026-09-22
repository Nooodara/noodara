---
phase: 02-adaptador-ssh-aislado-y-probado-con-testcontainers
plan: 10
subsystem: testing
tags: [ssh, testcontainers, vitest, ssh2, tofu, discovery, ci]

requires:
  - phase: 02-adaptador-ssh-aislado-y-probado-con-testcontainers (plans 02-02, 02-03, 02-09)
    provides: startSshd/readTestKey/waitForSlowCommandStart fixture helpers, the servers fingerprint-timestamp migration, and runDiscovery's public surface
provides:
  - The eight roadmap §6.5 QA-03 scenarios, each proven on both Ubuntu 22.04 and 24.04 against real sshd containers through @noodara/ssh's public surface only
  - The SERV-08 sudo/docker-group access-check matrix (root/deployer/restricted) proven against real users
  - The SEC-05 canary proof that a real SSH password never survives any exec output, discovery check detail, serialised snapshot or failure message
  - A tsc project (tests/integration/ssh/tsconfig.json) wired into `pnpm typecheck`, giving the phase's first-ever static check of anything under tests/integration/**
  - Phase 2's 02-VALIDATION.md closed as a measured record (status: approved, nyquist_compliant: true, wave_0_complete: true)
affects: [phase-3-application-services, phase-4-http-worker-sse]

tech-stack:
  added: []
  patterns:
    - "SshTimeouts.connectMs/commandMs are bound once per connect() call and apply to the whole session — there is no per-exec override, which shapes how command-timeout scenarios must be written (a second connection, not a second budget, proves recovery)"
    - "session.exec() rejects on failure (unlike connect(), which never rejects) — every rejection assertion in these files attaches its handler in the same synchronous tick the promise is created, via a settle() helper, to avoid a real Node unhandledRejection window"
    - "A pure type-level check function, defined but never invoked, is how a @ts-expect-error assertion is proven without ever running an unclassified command string against a real shell"

key-files:
  created:
    - tests/integration/ssh/connect.test.ts
    - tests/integration/ssh/host-key-changed.test.ts
    - tests/integration/ssh/timeouts.test.ts
    - tests/integration/ssh/connection-loss.test.ts
    - tests/integration/ssh/discovery.test.ts
    - tests/integration/ssh/stress-connections.test.ts
    - tests/integration/ssh/tsconfig.json
  modified:
    - .github/workflows/ci.yml
    - .planning/phases/02-adaptador-ssh-aislado-y-probado-con-testcontainers/02-VALIDATION.md
    - package.json
    - pnpm-lock.yaml
    - tests/integration/ssh/contracts.test.ts

key-decisions:
  - "tests/integration/ssh/tsconfig.json (+ @types/node promoted to a root devDependency, + pnpm typecheck extended with a tsc -p invocation) added because no tsc project anywhere in the repo covered tests/integration/** — the SEC-04 @ts-expect-error assertion in connect.test.ts needed a real static check behind it, not just a comment"
  - "The SERV-08 access-check matrix test connects to a dockerCli:true fixture, not the plain image, so the 'other nine checks still pass' assertion is genuinely about sudo/docker_group and not incidentally about Docker being absent"
  - "The command-timeout scenario proves 'the timeout destroyed the channel, not the connection' via a second exec on the same session (still bound by the same fixed budget) plus a separate fresh connection with a normal budget, since SshTimeouts.commandMs cannot be varied per exec call on one session"
  - "The canary password in discovery.test.ts's SEC-05 test is fixture.password itself (already a fresh per-run randomUUID()), not a separately generated value — a separately generated string cannot authenticate as the account's real password, so 'canary' and 'credential' must be the same value here"

requirements-completed: [QA-03, SERV-07, SERV-08, SEC-03, SEC-04, SEC-05, DISC-01, DISC-04]

duration: 150min
completed: 2026-09-15
---

# Phase 2 Plan 10: QA-03 real-infrastructure scenarios and phase close Summary

**All eight roadmap §6.5 SSH scenarios, the SERV-08 access matrix and the SEC-05 canary proven against real Ubuntu 22.04/24.04 sshd containers through `@noodara/ssh`'s public surface, closing phase 2's validation contract into a measured green record.**

## Performance

- **Duration:** ~150 min
- **Completed:** 2026-09-15
- **Tasks:** 3 completed
- **Files modified:** 11 (7 created, 4 modified — excluding the SUMMARY/STATE/ROADMAP/REQUIREMENTS closing commit)

## Accomplishments

- Six new `tests/integration/ssh/*.test.ts` files prove every one of the eight §6.5 scenarios — successful connection, invalid credentials, invalid host, safe command execution, host key changed, network timeout, command timeout, connection loss (both directions) and reconnect — on both Ubuntu 22.04 and 24.04, through `createSsh2Adapter`/`runDiscovery` only, never a mocked `ssh2.Client`
- The TOFU lifecycle (SEC-03) is proven end to end: capture on first connect, rejection of a changed key with both fingerprints in the message, the negative case that the new key works only when pinned, and that a repeated mismatching attempt never auto-accepts
- The SERV-08 sudo/docker-group matrix is proven against the real `root`/`deployer`/`restricted` users, and the SEC-05 canary proves a real SSH password never survives any exec output, discovery check detail, serialised snapshot or failure message
- Every DISC-01 fact is cross-checked against an independent `container.exec` oracle (never the 02-04 fixtures the parsers were written from), including the docker-CLI client-version match
- `tests/integration/ssh/tsconfig.json` gives the repo's first-ever static check over anything under `tests/integration/**`, wired into `pnpm typecheck`, so the SEC-04 `@ts-expect-error` on an arbitrary command string is genuinely enforced
- `.planning/phases/02-adaptador-ssh-aislado-y-probado-con-testcontainers/02-VALIDATION.md` is closed as a measured record: all 27 rows green, `status: approved`, `nyquist_compliant: true`, `wave_0_complete: true`

## Task Commits

1. **Task 1: Connection scenarios and TOFU** — `4f4f798` (test)
2. **Task 2: Timeout, connection-loss and reconnect scenarios** — `eb3e957` (test)
3. **Task 3: Discovery, SERV-08 matrix, SEC-05 canary, CI record** — `2dd9ec1` (test)
4. **02-VALIDATION.md close-out** — `41ee76b` (docs)

**Plan metadata:** _(this commit)_

## Files Created/Modified

- `tests/integration/ssh/connect.test.ts` — successful connection (all credential shapes), invalid credentials, invalid host, safe command execution, the SEC-04 `@ts-expect-error` type-level check
- `tests/integration/ssh/host-key-changed.test.ts` — the full TOFU capture/reject/pin lifecycle on a fixed host port
- `tests/integration/ssh/timeouts.test.ts` — network timeout (D-10 `attempts: 2`), the inverted `AUTH_FAILED` `attempts: 1` case, command timeout
- `tests/integration/ssh/connection-loss.test.ts` — connection loss after the fact and mid-exec, reconnect, recovery after a transient failure
- `tests/integration/ssh/discovery.test.ts` — full discovery against an independent oracle, the SERV-08 matrix, D-12 docker variants, the SEC-05 canary
- `tests/integration/ssh/stress-connections.test.ts` — the opt-in roadmap §6.7 100-consecutive-connections criterion, flag-gated
- `tests/integration/ssh/tsconfig.json` — the tsc project that gives `connect.test.ts`'s `@ts-expect-error` real teeth
- `.github/workflows/ci.yml` — records the four-image-variant build cost on the `integration` job
- `.planning/phases/02-adaptador-ssh-aislado-y-probado-con-testcontainers/02-VALIDATION.md` — closed as a measured record
- `package.json` / `pnpm-lock.yaml` — `@types/node` promoted to a root devDependency; `typecheck` script extended
- `tests/integration/ssh/contracts.test.ts` — two small fixes surfaced by the new typecheck coverage and by the full-suite run (see Deviations)

## Decisions Made

See `key-decisions` in the frontmatter above.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 3 - Blocking] Added a tsc project for `tests/integration/ssh/**` so `pnpm typecheck` actually checks it**
- **Found during:** Task 1 (the `@ts-expect-error` acceptance criterion)
- **Issue:** No tsc project anywhere in the repo (root `package.json`'s `typecheck` script only runs `turbo run typecheck` across `packages/*`/`apps/*`) covered anything under `tests/integration/**`. Without one, `connect.test.ts`'s `@ts-expect-error` on an arbitrary command string would be inert — `pnpm typecheck` would exit 0 regardless of whether the suppression was actually needed, which is the opposite of what the acceptance criterion asks for.
- **Fix:** Added `tests/integration/ssh/tsconfig.json` (extends `packages/config/tsconfig.base.json`, includes this directory plus `../helpers/ssh.ts`, with a `paths` alias for `@noodara/ssh/testing` mirroring `vitest.shared.ts`'s Vitest-only alias) and extended the root `typecheck` script to `turbo run typecheck && tsc -p tests/integration/ssh/tsconfig.json --noEmit`. Promoted `@types/node` to a root devDependency (needed for `node:`-prefixed imports to resolve under a bare `tsc` invocation, since no root-level `@types/node` existed before).
- **Files modified:** `tests/integration/ssh/tsconfig.json` (new), `package.json`, `pnpm-lock.yaml`
- **Verification:** `pnpm exec tsc -p tests/integration/ssh/tsconfig.json --noEmit` exits 0; reverting the `@ts-expect-error` line locally (as a manual check) makes it fail as expected
- **Committed in:** `4f4f798` (Task 1 commit)

**2. [Rule 1 - Bug] Fixed a pre-existing type error in `contracts.test.ts` surfaced by the new tsc coverage**
- **Found during:** Task 1, first run of the new tsc project
- **Issue:** `contracts.test.ts`'s `forcedAlgorithm` (an object-literal lookup) inferred as `string`, not assignable to ssh2's `ServerHostKeyAlgorithm[]` for `algorithms.serverHostKey` — a latent error nothing had ever type-checked before this plan.
- **Fix:** Wrapped the lookup object in `as const` so the indexed access narrows to the literal union.
- **Files modified:** `tests/integration/ssh/contracts.test.ts`
- **Verification:** `pnpm exec tsc -p tests/integration/ssh/tsconfig.json --noEmit` exits 0
- **Committed in:** `4f4f798` (Task 1 commit)

**3. [Rule 1 - Bug] Widened a 1ms-flaky timer assertion in `contracts.test.ts`**
- **Found during:** the full `pnpm test:integration` run at Task 3 close-out
- **Issue:** `expect(attempt.elapsedMs).toBeGreaterThanOrEqual(configuredTimeout)` failed once with `1999 < 2000` — real `setTimeout`/libuv timer jitter, not a logic defect, but a flaky assertion the project's own DoD forbids ("cero flaky conocidos").
- **Fix:** Widened the lower bound by 5ms (`configuredTimeout - 5`), documented as absorbing real timer-firing jitter without weakening what the assertion proves (still a real ~2s wait, not a near-instant failure).
- **Files modified:** `tests/integration/ssh/contracts.test.ts`
- **Verification:** Re-ran the full `pnpm test:integration` suite after the fix — 208/208 tests green
- **Committed in:** `4f4f798` (bundled into the Task 1 commit, since both `contracts.test.ts` edits were made before any task was committed)

**4. [Rule 1 - Bug] Fixed two authoring bugs discovered while running the new scenario files themselves**
- **Found during:** Tasks 1 and 3, first runs of `connect.test.ts` and `discovery.test.ts`
- **Issue (a):** `connect.test.ts`'s "successful connection" test asserted the captured host fingerprint against `hostKeyFingerprint(fixture, <the client auth key's type>)`, but the negotiated *host* key type is always ed25519 (ssh2-adapter.ts always orders `algorithms.serverHostKey` with ed25519 first per D-05/ADR 0004) regardless of which client key authenticates — the RSA/ECDSA subtests compared against the wrong host key type's fingerprint.
- **Issue (b):** `discovery.test.ts`'s SEC-05 canary test generated its own random password value as the credential instead of using `fixture.password` (the account's real, per-run password) — a different value cannot authenticate, so the connection legitimately failed `AUTH_FAILED` before the canary assertions could even run. Separately, the "full discovery" test asserted `uptimeSeconds < 3600`, which is false on any host that has been up for a while (`/proc/uptime` in a container reflects the shared host kernel's uptime, not the container's own age).
- **Fix:** (a) always assert against the ed25519 host key fingerprint, with a comment explaining why; (b) use `fixture.password` as the canary value, and relax the uptime assertion to non-negative-integer only, with a comment on why an upper bound would be host-dependent and false.
- **Files modified:** `tests/integration/ssh/connect.test.ts`, `tests/integration/ssh/discovery.test.ts`
- **Verification:** Both files' full test runs green after the fix
- **Committed in:** `4f4f798` (connect.test.ts) and `2dd9ec1` (discovery.test.ts)

**5. [Rule 1 - Bug] Fixed the SERV-08 matrix test's fixture choice**
- **Found during:** Task 3, first full run of `discovery.test.ts`
- **Issue:** The matrix test asserted "the other nine checks still pass" using the plain (no Docker CLI) image, but `docker_version`/`docker_compose_version` legitimately report `fail` on that image regardless of which user connects (D-12) — a correct behaviour, but one that made the "nine other checks pass" assertion false for a reason unrelated to SERV-08.
- **Fix:** Use a `dockerCli: true` fixture for this test so the Docker checks report `pass` (CLI present, daemon unreachable is still a pass per D-12), isolating the assertion to what it's actually meant to prove.
- **Files modified:** `tests/integration/ssh/discovery.test.ts`
- **Verification:** SERV-08 matrix test green for all three users on both Ubuntu versions
- **Committed in:** `2dd9ec1` (Task 3 commit)

**6. [Rule 1 - Bug] Fixed a real Node `unhandledRejection` timing bug in `connection-loss.test.ts`**
- **Found during:** Task 2, first full run of `connection-loss.test.ts`
- **Issue:** The mid-exec scenario created the `session.exec()` promise, then `await`-ed `waitForSlowCommandStart`/`fixture.stop()` before ever attaching a `.rejects` handler — a real window in which the promise could reject with nothing listening, which Node correctly reports as `unhandledRejection` even though the test "gets to it" a moment later. Also, `recordedUnhandledRejections` was never reset between tests, so one genuine hit contaminated every subsequent test's assertion in the same file.
- **Fix:** Added a `settle()` helper that attaches `.then(onFulfilled, onRejected)` in the same synchronous tick a promise is created, converting it into an always-resolving `{ ok, value | error }` wrapper before any `await` can create a window; added a `beforeEach` reset of the recorder array.
- **Files modified:** `tests/integration/ssh/connection-loss.test.ts`
- **Verification:** Full file green, `recordedUnhandledRejections` empty on every test
- **Committed in:** `eb3e957` (Task 2 commit)

---

**Total deviations:** 6 auto-fixed (1 blocking-infra, 5 bugs — 2 in pre-existing code the new coverage surfaced, 4 in this plan's own new test authoring)
**Impact on plan:** All fixes were necessary to make the plan's own acceptance criteria meaningful (the tsc project) or to make the new scenarios test what they claim to test, rather than pass or fail for an unrelated reason. No scope creep — nothing outside `tests/integration/ssh/**`, the new tsconfig, and the two small `contracts.test.ts` fixes it required was touched.

## Issues Encountered

- **Transient Docker-load flakiness on this dev machine.** Two isolated re-runs (once in `connect.test.ts`, once briefly suspected elsewhere) failed a passing-looking test (`safe command execution`) only when run as part of a long, container-churning file, and passed cleanly in isolation and on every subsequent full-file re-run once `connectMs` was raised from 10s to 20s across all six new files. This machine shares its Docker host with many unrelated projects (`docker stats` showed multi-GB-memory, tens-of-GB-I/O containers from sibling repos running concurrently during this session), which plausibly explains occasional container-start/handshake latency beyond the SSH adapter's own D-08 default. The 20s budget is a test-only mitigation (it does not change any assertion's meaning — `attempts: 1` still means "the first attempt succeeded," regardless of how much budget was available) and does not affect the production default of 10s (`NOODARA_SSH_CONNECT_TIMEOUT_MS`), which is untouched.
- **Cold integration-suite runtime was not measured.** The plan asked for a cold-vs-warm `pnpm test:integration` comparison; only the warm number (555.87s) was actually measured. Producing a genuine cold run would require evicting this phase's four sshd image variants from this shared dev machine's Docker build cache, and there is no way to do that selectively without risking unrelated concurrent work on the same host (2000+ images total, several actively in use by other projects). Recorded as "not measured" in `02-VALIDATION.md` rather than invented.
- **A local `gitleaks detect` run reports the three already-known fake-credential fixture files as findings.** This is a local-machine artifact (this dev machine's actual git root is the parent monorepo directory one level above `noodara/code`, shifting `.gitleaks.toml`'s anchored relative-path allowlist by one path segment) rather than a real leak or a config defect — documented in `02-VALIDATION.md`'s Full-Phase Green Run notes rather than silently claimed clean.

## User Setup Required

None — no external service configuration required.

## Next Phase Readiness

- Phase 2 is fully closed: `packages/ssh` is a proven adapter against real Ubuntu 22.04/24.04 infrastructure, covering every QA-03 §6.5 scenario, the SERV-08 access matrix, and the SEC-05 no-credential-leak guarantee.
- Phase 3 (application services / persistence of discovery + connection state) can build directly on `createSsh2Adapter`/`runDiscovery`'s public surface with confidence that every failure mode it will need to persist (`ServerErrorCode`, `attempts`, `observedFingerprint`, `DiscoverySnapshot`) has been measured against real servers, not mocked.
- No blockers. The stress-connections opt-in suite and a genuine cold-build measurement remain for the v0.1 release gate / a future nightly run (phase 6 scope), as already recorded in `02-VALIDATION.md`'s "Manual-Only Verifications" table.

---
*Phase: 02-adaptador-ssh-aislado-y-probado-con-testcontainers*
*Completed: 2026-09-15*

## Self-Check: PASSED

- All 10 claimed files/paths verified present on disk (`tests/integration/ssh/{connect,host-key-changed,timeouts,connection-loss,discovery,stress-connections}.test.ts`, `tests/integration/ssh/tsconfig.json`, `.github/workflows/ci.yml`, `02-VALIDATION.md`, `package.json`)
- All 4 claimed commit hashes (`4f4f798`, `eb3e957`, `2dd9ec1`, `41ee76b`) verified present in `git log --oneline --all`
