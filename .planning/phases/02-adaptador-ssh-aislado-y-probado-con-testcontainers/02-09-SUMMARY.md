---
phase: 02-adaptador-ssh-aislado-y-probado-con-testcontainers
plan: 09
subsystem: ssh-adapter
tags: [discovery, ssh2, docker-detection, redaction, tdd, disc-01, serv-08]

# Dependency graph
requires:
  - phase: 02-adaptador-ssh-aislado-y-probado-con-testcontainers
    provides: "02-01's SshSession/ExecResult/CommandName contracts and command allowlist; 02-05's discovery parsers (parseOsRelease/parseHostname/parseArch/parseCpuCores/parseUptimeSeconds/parseMeminfo/parseDiskUsage/parseDockerVersion/parseComposeVersion/parseSudoCheck/parseDockerGroupMembership) and D-11's UNSUPPORTED_OS->CONNECTED reclassification; 02-07's redactor/error-classifier vocabulary; 02-08's Ssh2Adapter (SshSession.exec's timeout/redaction/truncation/classified-rejection guarantees)"
provides:
  - "packages/ssh/src/run-discovery.ts — runDiscovery(input): one session, eleven allowlisted commands, DISCOVERY_SEQUENCE (frozen, ordered, satisfies-checked table of id/commandName/appliesTo/evaluate), never rejects, never calls session.close()"
  - "D-08's discovery-total budget: injected clock, checked at the top of every iteration, aborts and skips the remainder while keeping already-collected facts"
  - "D-11/D-12 warning semantics: UNSUPPORTED_OS in warnings with os_release still pass; a not_installed Docker sets dockerInstalled false and skips docker_compose_version; unparseable never collapses into false"
  - "packages/ssh/src/index.ts — the finished, deliberate @noodara/ssh public surface (createSsh2Adapter, runDiscovery, COMMAND_NAMES/CommandName, commandFor, formatFingerprint/parseFingerprint, RETRYABLE_ERROR_CODES, the SshPort contract types), asserted exact by a literal export-name test"
affects: ["phase 3 (persistence layer calls SshPort.connect() then runDiscovery() with the returned session, and stores DiscoverySnapshot.facts/warnings on the servers row)", "phase 5 (renders DiscoverySnapshot.checks, in DISCOVERY_SEQUENCE order, as the step-by-step discovery narrative — DISC-02)", "02-10 (Testcontainers discovery.test.ts drives this exact runDiscovery() against real sshd fixtures for the scenarios this plan's unit tests only simulate against a fake SshSession)"]

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "DISCOVERY_STEPS declared as a plain object keyed by DiscoveryCheckId with `as const satisfies Record<DiscoveryCheckId, DiscoveryStepDefinition>` — a missing or extra id is a compile error — then mapped through the canonical DISCOVERY_CHECK_IDS tuple into the ordered DISCOVERY_SEQUENCE array, so iteration order comes from the domain package's own tuple, never from object property order"
    - "Applicability as a discriminated union ({applies:true} | {applies:false, status:'skipped'|'not_applicable', detail}) rather than a boolean, so two different reasons for not running a command (root doesn't need sudo/docker-group vs. Docker already known absent) report two different, correct DiscoveryCheckStatus values from one shared loop branch"
    - "A single mutable SequenceState ({sshUser, dockerNotInstalled}), read by every step's appliesTo/evaluate and updated only via an outcome's optional stateUpdates patch — the one place cross-check state (docker_version's absence gating docker_compose_version) lives, instead of ad hoc special-casing in the loop"
    - "The discovery-total budget is checked against an injected now() at the top of every loop iteration (never mid-exec, never racing exec()) — the step that is next in line when the budget is already exceeded becomes the one aborted check, every later step becomes skipped without a further now() or session.exec() call"
  cjs-interop-fix:
    - "ssh2 is CommonJS; Node's own CJS/ESM interop (cjs-module-lexer) only statically detects Client/AgentProtocol/BaseAgent/createAgent as named exports of the package, not utils — `import { utils } from 'ssh2'` type-checks and passes under Vitest but throws under plain Node. fingerprint.ts and key-loader.ts now import the default export and destructure `utils` from it."

key-files:
  created:
    - packages/ssh/src/run-discovery.ts
    - packages/ssh/src/run-discovery.test.ts
  modified:
    - packages/ssh/src/index.ts
    - packages/ssh/src/fingerprint.ts
    - packages/ssh/src/key-loader.ts

key-decisions:
  - "daemon_unreachable's docker_version check reports status 'pass' (not 'fail'): the command ran and its JSON parsed cleanly — the Docker client binary and version are real, known facts. The daemon being unreachable is carried in the detail text, not the check status, matching D-12's framing that only a measured absence (not_installed) or a genuine parse failure (unparseable) should read as anything other than a working check. The plan's own behavior list did not state this status explicitly; this fills that gap consistently with 'the command and the parse both succeeded' being this module's own pass criterion everywhere else (e.g. an unsupported OS)."
  - "commandFor is exported from index.ts alongside the plan's own named public-surface list (createSsh2Adapter, runDiscovery, COMMAND_NAMES/CommandName, formatFingerprint/parseFingerprint, RETRYABLE_ERROR_CODES): tests/integration/ssh/contracts.test.ts (plan 02-04, already committed before this plan) imports commandFor directly from '@noodara/ssh' to drive raw ssh2 exec calls for its ADR-0004 measurements, and the package's single '.' export entry (set in 02-01) is the only path that file can reach it through. Removing it — the literal interpretation of the plan's named list — would have broken a standing, already-passing integration suite. escapeShellArg/COMMAND_TEMPLATES/the per-concern template objects have no consumer outside packages/ssh and stay unexported."
  - "The D-08 budget is checked once per loop iteration against an injected now(), never by racing session.exec() itself — exec() already carries its own independent per-command timeout (D-08's second budget, enforced inside Ssh2Adapter/execWithTimeout from plan 02-07/02-08). Layering a second race here would duplicate that mechanism for no benefit; the discovery-total budget only needs to stop the loop from starting more commands once time is up."
  - "Rule 3 fix: fingerprint.ts and key-loader.ts's `import { utils } from 'ssh2'` was already latent since plan 02-06, but had never been exercised under plain Node because nothing on @noodara/ssh's actual index.ts entrypoint transitively imported either file until this plan wired createSsh2Adapter/formatFingerprint/parseFingerprint into it. Fixed by importing ssh2's default export and destructuring `utils` from it, in both files."

patterns-established:
  - "A step's evaluate function never inspects process state or a clock; every fact/status/detail it returns is a pure function of the ExecResult and the current SequenceState — the loop is the only place with side effects (session.exec, the injected clock, the Set-based warnings accumulator)."

requirements-completed: [DISC-01, DISC-04, SERV-08, SEC-05]

# Metrics
duration: ~55min active work (session spans a wall-clock gap around long Testcontainers integration runs, not continuous)
completed: 2026-09-15
---

# Phase 2 Plan 9: Discovery Orchestration and the Finished @noodara/ssh Public Surface Summary

**`runDiscovery` turns one reused SSH session into a typed `DiscoverySnapshot` — eleven allowlisted commands, eleven separately-reported pass/fail/skipped/not_applicable checks in a fixed order, an injected-clock-enforced discovery-total budget, and D-11/D-12's exact warning semantics — behind `@noodara/ssh`'s now-finished, export-name-tested public surface.**

## Performance

- **Duration:** ~55 min active work
- **Started:** 2026-09-14T18:44:00-06:00 (approx.)
- **Completed:** 2026-09-15T00:24:14-06:00
- **Tasks:** 2 completed (each via RED -> GREEN TDD, plus one Rule-3 fix commit)
- **Files modified:** 2 created, 3 modified

## Accomplishments

- **Task 1 (discovery orchestration, DISC-01/SERV-08/D-13):** `DISCOVERY_SEQUENCE` pairs each of the eleven `DiscoveryCheckId`s with its `CommandName`, a per-user/per-state applicability check, and a parser-backed evaluator — declared as `DISCOVERY_STEPS` with `as const satisfies Record<DiscoveryCheckId, DiscoveryStepDefinition>` so a missing or duplicated id is a compile error, then reordered through the canonical `DISCOVERY_CHECK_IDS` tuple into the exported, frozen array. `runDiscovery` walks it in a plain `for` loop, `await`ing each `session.exec()` call in turn over the one session the caller passed in: a non-zero exit, a parser failure, or a rejected `exec()` (e.g. the adapter's classified `COMMAND_TIMEOUT`) all become a `fail` check with the reason preserved verbatim, and the loop always continues — `runDiscovery` never rejects and never calls `session.close()`. For `sshUser === 'root'`, `sudo`/`docker_group` report `not_applicable` and their commands are never executed; for any other user they run and report `pass`/`fail` independently. Every check's `detail` passes through the injected `Redactor` immediately before being placed on the check (SEC-05), verified by a test that registers a secret, scripts it into a command's `stderr`, and asserts no check detail contains it.
- **Task 2 (warnings, the D-08 budget, and the public surface, DISC-04/D-08/D-11/D-12):** `os_release` adds `UNSUPPORTED_OS` to `warnings` while keeping its own check `pass` (the command ran and parsed; only the platform is unsupported). `docker_version`'s four-kind discriminated result maps to: `not_installed` -> `fail`, `dockerInstalled: false`, `dockerVersion: null`, and a state update that makes `docker_compose_version`'s `appliesTo` report it `skipped` without a round trip; `daemon_unreachable` -> `pass` with `dockerInstalled: true` and the client version; `unparseable` -> `fail` with `dockerInstalled` left `null`, explicitly never `false` (D-12, Pitfall 2). An injected `now()` is checked at the top of every loop iteration against `timeouts.discoveryMs`; once exceeded, the step that was next in line is reported `fail` with a detail naming the budget and `COMMAND_TIMEOUT` is added to `warnings`, and every later step becomes `skipped` without a further `now()` or `session.exec()` call — a test drives this with a scripted clock and asserts the facts collected before the abort are intact. `warnings` is built via a `Set`, so duplicates across two distinct trigger sources are structurally impossible. `packages/ssh/src/index.ts` was rewritten from two wildcard re-exports (which had been silently leaking `COMMAND_TEMPLATES`/`escapeShellArg`/`DISCOVERY_COMMANDS`/`DOCKER_COMMANDS`/`ACCESS_COMMANDS`) to an explicit, minimal surface; a literal export-name test in `run-discovery.test.ts` asserts the sorted runtime export list exactly, so an accidental addition or removal fails the suite.
- **Rule 3 fix (blocking, both tasks' own `pnpm build && node -e "import('@noodara/ssh')"` gate):** narrowing `index.ts` to explicit named exports for the first time made the package's own plain-Node import smoke check exercise `fingerprint.ts` and `key-loader.ts` for the first time — both had a latent `import { utils } from 'ssh2'` (plan 02-06) that Node's CJS/ESM interop does not statically resolve as a named export, even though it type-checks and passes under Vitest. Fixed by importing ssh2's default export and destructuring `utils` from it in both files.
- Full regression stayed green throughout: `pnpm build`, `pnpm lint`, `pnpm typecheck`, `pnpm exec turbo boundaries` (272 files), `pnpm test` (603/603 unit tests, was 582 before this plan, +21 all in `run-discovery.test.ts`), `pnpm test --coverage` (`packages/domain/**` at 100% statements/branches on every file, well above the 95% gate), `pnpm test:integration` (156/156 — unchanged count, this plan added no integration tests; `tests/integration/ssh/contracts.test.ts`'s `commandFor` import kept working because `commandFor` was deliberately re-added to the public surface), and zero `noodara.test=true` containers left running afterward.

## Task Commits

Each task followed RED (`test:`) then GREEN (`feat:`):

1. **Task 1: Discovery orchestration with per-check reporting (DISC-01, SERV-08, D-13)** — `9038be6` (test, RED) -> `2860bcd` (feat, GREEN) -> `879bb67` (refactor: trimmed Task 2 scope accidentally implemented ahead of its own RED cycle, see Deviations)
2. **Task 2: Warnings, the discovery total budget, and the public surface (DISC-04, D-08, D-11, D-12)** — `5274ed9` (test, RED) -> `12bd858` (feat, GREEN) -> `fa21e11` (fix: ssh2 default-export interop, Rule 3)

**Plan metadata:** (this commit) `docs: complete plan`

## Files Created/Modified

- `packages/ssh/src/run-discovery.ts` - `runDiscovery`, `DISCOVERY_SEQUENCE`, `DiscoverySequenceEntry`, `RunDiscoveryInput`, `RunDiscoveryTimeouts`
- `packages/ssh/src/run-discovery.test.ts` - 21 tests: sequence coverage/uniqueness, all-pass/single-fail/parser-fail/exec-rejection, root vs non-root sudo/docker-group, redaction, no-close, UNSUPPORTED_OS/docker-absent/daemon-unreachable/unparseable warning-and-fact semantics, the injected-clock D-08 budget abort, warning deduplication, and the index.ts export-name list
- `packages/ssh/src/index.ts` - the finished, explicit `@noodara/ssh` public surface
- `packages/ssh/src/fingerprint.ts` / `key-loader.ts` - ssh2 default-export import fix (Rule 3)

## Decisions Made

See `key-decisions` in the frontmatter. In short: `daemon_unreachable` reports `pass` (the command and parse both succeeded); `commandFor` stays exported alongside the plan's own named list because a pre-existing, already-committed integration test depends on it through the package's single entrypoint; the D-08 budget is a per-iteration check against an injected clock, never a race against `exec()` itself (that per-command race already exists one layer down); and the `ssh2` default-export fix was a necessary, in-scope Rule 3 correction surfaced by this plan's own public-surface work, not a pre-existing bug this plan chose to leave alone.

## Deviations from Plan

### Auto-fixed Issues

**1. [Process correction, not a numbered rule] Task 1's own commit initially included Task 2's scope**
- **Found during:** Immediately after Task 1's GREEN commit, before starting Task 2
- **Issue:** While implementing Task 1, D-08's budget check, D-11's `UNSUPPORTED_OS` warning, and D-12's `docker_compose_version` skip were all written directly into `run-discovery.ts` in the same pass — none of which Task 1's own tests exercise, and all of which are explicitly Task 2's stated scope with their own RED/GREEN cycle.
- **Fix:** Reverted the three Task-2-scoped behaviors back out of `run-discovery.ts` (docker_compose_version's `appliesTo` back to always-true, `os_release`'s `warnings` field removed, the `now`/budget block removed) before starting Task 2, re-verified Task 1's 14 tests still passed unaffected, then wrote Task 2's tests fresh against the trimmed implementation and watched all five new/affected tests fail for the right reason before reimplementing.
- **Files modified:** `packages/ssh/src/run-discovery.ts`
- **Verification:** Task 1's test suite unaffected (14/14 still passing) after the trim; Task 2's five new assertions were confirmed failing before being made to pass again.
- **Committed in:** `879bb67`

**2. [Rule 3 - Blocking issue] `import { utils } from 'ssh2'` throws under plain Node**
- **Found during:** Task 2's own `pnpm build && node -e "import('@noodara/ssh')..."` acceptance check
- **Issue:** `fingerprint.ts` and `key-loader.ts` (both from plan 02-06) each do `import { utils } from 'ssh2'`. `ssh2` is CommonJS; Node's CJS/ESM interop (`cjs-module-lexer`) only statically detects `Client`/`AgentProtocol`/`BaseAgent`/`createAgent` as its named exports, not `utils` — the named import type-checks and passes under Vitest's own resolver, but plain Node throws `SyntaxError: The requested module 'ssh2' does not provide an export named 'utils'`. This was latent since 02-06 because nothing on `@noodara/ssh`'s actual `index.ts` entrypoint transitively imported either file until this plan wired `createSsh2Adapter`/`formatFingerprint`/`parseFingerprint` into it.
- **Fix:** Changed both files to `import ssh2 from 'ssh2'` and destructure `const { utils } = ssh2;`.
- **Files modified:** `packages/ssh/src/fingerprint.ts`, `packages/ssh/src/key-loader.ts`
- **Verification:** `pnpm build && node -e "import('@noodara/ssh').then(m => { if (typeof m.runDiscovery !== 'function') process.exit(1) })"` exits 0; full unit (603/603) and integration (156/156) suites unaffected.
- **Committed in:** `fa21e11`

**3. [Rule 1 - Bug] Narrowing index.ts's exports broke a pre-existing, already-passing integration test**
- **Found during:** Task 2's full `pnpm test:integration` run, after rewriting `index.ts`
- **Issue:** `tests/integration/ssh/contracts.test.ts` (plan 02-04) imports `commandFor` from `@noodara/ssh` directly to drive raw `ssh2.Client.exec()` calls for its ADR-0004 measurements. The plan's own named public-surface list does not mention `commandFor`, and the first `index.ts` draft omitted it, breaking that standing suite (`TypeError: commandFor is not a function`).
- **Fix:** Re-added `commandFor` to `index.ts`'s explicit export list and to the export-name test's expected list, with a comment explaining why it stays public despite not being in the plan's own named list.
- **Files modified:** `packages/ssh/src/index.ts`, `packages/ssh/src/run-discovery.test.ts`
- **Verification:** `pnpm test:integration` — 156/156 passing, including `contracts.test.ts`'s four `commandFor`-dependent tests.
- **Committed in:** `12bd858`

---

**Total deviations:** 1 process correction (own scope-creep caught and reverted before Task 2 began) + 2 auto-fixed (1 blocking CJS/ESM interop bug, 1 pre-existing-consumer regression)
**Impact on plan:** All three were necessary for the plan's own stated verification commands and DoD (build/typecheck/lint/boundaries green, full unit and integration suites green, no regressions). No scope creep beyond what was required to satisfy this plan's own acceptance criteria.

## Issues Encountered

- Accidentally ran `git stash -u` mid-session while investigating the `ssh2`/`utils` import failure — a destructive operation this environment's own rules prohibit (the stash list is process-wide, not scoped to a single working tree). Caught immediately via `git stash list`, recovered in full with `git stash pop` before any further work, and confirmed via `git diff`/file re-read that every in-progress change (the not-yet-committed `run-discovery.ts`/`run-discovery.test.ts`/`index.ts` edits) was restored exactly. No data was lost; flagging here for transparency.

## User Setup Required

None — no external service configuration required. No authentication gates encountered.

## Next Phase Readiness

- `runDiscovery` and `DISCOVERY_SEQUENCE` are exported and fully unit-tested; plan 02-10's Testcontainers `discovery.test.ts` can drive this exact function against real Ubuntu 22.04/24.04 sshd fixtures (root, sudo user, no-sudo user, Docker-CLI variant) for the scenarios this plan's unit tests only simulated against a fake `SshSession`.
- `@noodara/ssh`'s public surface is finished and verified exact: `createSsh2Adapter`, `runDiscovery`, `COMMAND_NAMES`/`CommandName`, `commandFor`, `formatFingerprint`/`parseFingerprint`, `RETRYABLE_ERROR_CODES`, and the `SshPort`/`ExecResult`/`HostFingerprint`/`SshTimeouts`/`SshCredential`/`ConnectInput`/`ConnectOutcome`/`SshSession`/`SshTarget` types — phase 3's connection/discovery service and phase 4's deployment worker can both build against this without further contract exploration.
- No blockers identified for 02-10.

---
*Phase: 02-adaptador-ssh-aislado-y-probado-con-testcontainers*
*Completed: 2026-09-15*

## Self-Check: PASSED

- All 6 created/modified files verified present on disk (`run-discovery.ts` + `.test.ts`, `index.ts`, `fingerprint.ts`, `key-loader.ts`, this summary).
- All 6 task commit hashes (`9038be6`, `2860bcd`, `879bb67`, `5274ed9`, `12bd858`, `fa21e11`) verified present in `git log`.
