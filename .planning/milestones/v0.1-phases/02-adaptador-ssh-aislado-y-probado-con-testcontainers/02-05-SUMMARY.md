---
phase: 02-adaptador-ssh-aislado-y-probado-con-testcontainers
plan: 05
subsystem: domain
tags: [parsers, discovery, os-release, docker-detection, state-machine, tdd]

# Dependency graph
requires:
  - phase: 02-adaptador-ssh-aislado-y-probado-con-testcontainers
    provides: "02-01's discovery/types.ts contracts (DiscoveryFacts, SUPPORTED_UBUNTU_VERSIONS) and 02-04's 42 real captured Ubuntu 22.04/24.04 fixtures plus ADR 0004's measured Docker JSON shapes and exit codes"
provides:
  - "packages/domain/src/discovery/{os-release,system,access,resources,docker-version}.ts — seven pure parsers (parseOsRelease, parseHostname, parseArch, parseCpuCores, parseUptimeSeconds, parseSudoCheck, parseDockerGroupMembership, parseMeminfo, parseDiskUsage, parseDockerVersion, parseComposeVersion), each tested against the real 22.04/24.04 captures plus explicitly-labelled synthetic edge cases"
  - "D-11: packages/domain/src/server/connection-result.ts's statusForErrorCode('UNSUPPORTED_OS') now returns CONNECTED (was ERROR), with docs/domain/server-state-transitions.md's mapping table and note updated to match"
affects: ["02-09 (runDiscovery orchestrator will call every parser in this plan and derive DiscoveryFacts/warnings from their results)", "02-06..02-08 (unaffected by this plan's changes)"]

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "Parsers that read command stdout/exit-code return the existing packages/domain/src/validators/network.ts ValidationResult<T> ({ok:true,value} | {ok:false,code,message}) shape for anything that can genuinely fail to parse; access.ts's two checks (sudo, docker group) instead return direct discriminated values because their input is always a fixed-shape exit code or id -nG line that cannot fail to parse"
    - "Docker CLI/daemon detection as a four-kind discriminated union ({kind:'not_installed'|'daemon_unreachable'|'installed'|'unparseable'}) keyed on the ADR-0004-measured exit code, never on JSON.parse success alone — a parse failure is always 'unparseable', never silently 'not_installed' (D-12, T-2-17)"
    - "Fixture-driven parser tests read real captures via readFileSync(new URL('./fixtures/...', import.meta.url)); every input a fixture cannot supply (a non-Ubuntu distro, an unsupported Ubuntu version, a responding Docker daemon, malformed text) is hand-written with an inline comment marking it synthetic and explaining why no fixture covers it"
key-files:
  created:
    - packages/domain/src/discovery/os-release.ts
    - packages/domain/src/discovery/os-release.test.ts
    - packages/domain/src/discovery/system.ts
    - packages/domain/src/discovery/system.test.ts
    - packages/domain/src/discovery/access.ts
    - packages/domain/src/discovery/access.test.ts
    - packages/domain/src/discovery/resources.ts
    - packages/domain/src/discovery/resources.test.ts
    - packages/domain/src/discovery/docker-version.ts
    - packages/domain/src/discovery/docker-version.test.ts
  modified:
    - packages/domain/src/discovery/index.ts
    - packages/domain/src/server/connection-result.ts
    - packages/domain/src/server/connection-result.test.ts
    - docs/domain/server-state-transitions.md

key-decisions:
  - "parseOsRelease derives `distribution` from NAME (falling back to raw ID) and `supported` from a case-insensitive ID==='ubuntu' check against SUPPORTED_UBUNTU_VERSIONS imported from types.ts — never restating the version list, and never throwing for an unrecognised distro/version (DISC-04): the caller always gets distribution+version back, just with supported:false."
  - "parseDockerGroupMembership and the not_installed/daemon_unreachable branch in parseDockerVersion/parseComposeVersion key on Array.prototype.some(token === 'docker') and the ADR-0004 exit code respectively — deliberately avoiding the literal substring `includes('docker')` in access.ts's source (the plan's own acceptance-criteria grep bans that exact text, even though whole-token .includes() would have been semantically equivalent)."
  - "resources.ts documents and pins one rounding rule for both RAM and disk conversion: Math.round(kilobytes / 1024) — exact expected values (7836 MB RAM, 932594/88404 MB disk) are pinned from the real 24.04 capture in resources.test.ts."
  - "The Docker 'daemon present and responding' shape (a populated, non-null Server key) is not capturable from the sshd fixture matrix (ADR 0004) — docker-version.test.ts uses one derived, explicitly-commented, hand-written JSON sample for that branch, never saved under fixtures/ as if it were measured."
  - "D-11: UNSUPPORTED_OS is reclassified from ERROR to CONNECTED in ERROR_CODE_STATUS. No change to server-state.ts's transition table was needed — CONNECTING -> CONNECTED was already an allowed, non-reason-gated edge — verified by asserting `git diff --stat packages/domain/src/server/server-state.ts` is empty."

patterns-established:
  - "Discovery parser test files import fixtures by relative URL, never inline fixture text as string literals, keeping tests honest against the real 02-04 captures rather than hand-typed approximations of them."

requirements-completed: [DISC-01, DISC-04]

# Metrics
duration: ~55min
completed: 2026-09-14
---

# Phase 2 Plan 5: Discovery Parsers and D-11 Summary

**Seven pure, fixture-tested parsers turning every DISC-01 command output into structured facts, plus D-11's UNSUPPORTED_OS reclassification from ERROR to CONNECTED so an unsupported OS is a warning, not a failure.**

## Performance

- **Duration:** ~55 min
- **Started:** 2026-09-14T12:02:00-06:00 (approx.)
- **Completed:** 2026-09-14T12:40:06-06:00
- **Tasks:** 3 completed
- **Files modified:** 10 created, 4 modified

## Accomplishments

- **Task 1 (os-release, system, access):** `parseOsRelease` correctly reads both real Ubuntu 22.04 and 24.04 `/etc/os-release` captures (`supported: true` for both), and never throws for a Debian or Ubuntu 20.04 input — it still returns distribution/version with `supported: false` (DISC-04). `system.ts` covers hostname/arch/CPU-cores/uptime against the real captures with explicit malformed-input branches (0 cores, negative, float, single-field uptime). `access.ts`'s `parseDockerGroupMembership` uses a whole-token comparison (`Array.some(token === 'docker')`), proven against real `deployer`/`restricted` `id -nG` captures plus synthetic `dockerx`/`docker-compose` decoy tokens (T-2-18).
- **Task 2 (resources, docker-version):** `parseMeminfo`/`parseDiskUsage` convert kB/1K-blocks to whole MB with one documented, pinned rounding rule, exact-value-tested against the real 24.04 capture. `parseDockerVersion`/`parseComposeVersion` return a four-kind discriminated union keyed on the ADR-0004-measured exit code (127+empty-stdout = not_installed; non-zero+valid-JSON-with-null-Server = daemon_unreachable) — a dedicated test asserts invalid JSON at a plausible exit code is `unparseable`, explicitly never `not_installed` (D-12, T-2-17, Pitfall 6). The unreachable "responding daemon" shape is covered by one clearly-labelled derived fixture, since ADR 0004 could not build a working Docker-in-Docker daemon inside the sshd test image.
- **Task 3 (D-11):** `statusForErrorCode('UNSUPPORTED_OS')` now returns `CONNECTED` instead of `ERROR`. The doc comment above `ERROR_CODE_STATUS` was rewritten to state the warning semantics explicitly. Dedicated tests assert the failure branch still leaves `lastSeenAt`/`hostFingerprint` untouched (only the `ok:true` branch may set them) and that `applyConnectionResult` still throws `InvalidTransitionError` for `UNSUPPORTED_OS` arriving from any non-`CONNECTING` status. `server-state.ts`'s transition table required no change (confirmed via an empty `git diff --stat`). `docs/domain/server-state-transitions.md`'s mapping table and a new note under it were updated to match.
- Full regression stayed green throughout: `pnpm build`, `pnpm lint`, `pnpm typecheck`, `pnpm boundaries` (232 files, no issues), `pnpm test --coverage` (469/469 unit tests, `packages/domain/**` at/above the 95%/95% gate — new discovery files report 100% statement/100% branch, confirmed by the coverage tool's `skipFull` omitting them from the printed table), and `pnpm test:integration` (156/156, unaffected by this plan's changes).

## Task Commits

Each task followed RED (`test:`) then GREEN (`feat:`):

1. **Task 1: OS, system and access parsers** — `6e51760` (test), `5268025` (feat)
2. **Task 2: Resource and Docker parsers** — `f3f6ad8` (test), `931cf7b` (feat)
3. **Task 3: D-11 — UNSUPPORTED_OS becomes CONNECTED** — `64bca58` (test), `2b1f2be` (feat)

**Housekeeping commit (not a plan task):** `c4d1d03` (chore) — see Deviations.

**Plan metadata:** (this commit) `docs: complete plan`

## Files Created/Modified

- `packages/domain/src/discovery/os-release.ts` / `.test.ts` - `parseOsRelease`: distribution/version/supported from `/etc/os-release`, never throwing on an unsupported distro or version
- `packages/domain/src/discovery/system.ts` / `.test.ts` - `parseHostname`, `parseArch`, `parseCpuCores`, `parseUptimeSeconds`
- `packages/domain/src/discovery/access.ts` / `.test.ts` - `parseSudoCheck`, `parseDockerGroupMembership` (whole-token match)
- `packages/domain/src/discovery/resources.ts` / `.test.ts` - `parseMeminfo`, `parseDiskUsage` (kB/1K-blocks to whole MB, one pinned rounding rule)
- `packages/domain/src/discovery/docker-version.ts` / `.test.ts` - `parseDockerVersion`, `parseComposeVersion`, four-kind discriminated union keyed on exit code
- `packages/domain/src/discovery/index.ts` - re-exports the five new modules
- `packages/domain/src/server/connection-result.ts` / `.test.ts` - D-11: `UNSUPPORTED_OS: 'ERROR'` -> `'CONNECTED'`, doc comment rewritten, new dedicated tests
- `docs/domain/server-state-transitions.md` - mapping table row and D-11 note updated

## Decisions Made

See `key-decisions` in the frontmatter. In short: reuse the existing `ValidationResult<T>` shape from `validators/network.ts` for every parser that can genuinely fail to parse; give Docker detection a real four-kind union rather than a boolean or nullable string; pin one documented rounding rule for MB conversion; avoid the literal `includes('docker')` substring in `access.ts` per the plan's own acceptance-criteria grep, using `Array.some` instead.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 3 - Blocking issue] `noUncheckedIndexedAccess` rejected the initial missing-field narrowing in `parseOsRelease`**
- **Found during:** Task 1, first `pnpm lint`/build run
- **Issue:** Building `missing: string[]` from two separate `if (id === undefined)` / `if (versionId === undefined)` checks and then gating on `missing.length > 0` does not narrow `id`/`versionId` from `string | undefined` to `string` for TypeScript — `pnpm lint`'s build step failed with three `TS18048`/`TS2345`/`TS2322` errors.
- **Fix:** Changed the guard to the equivalent `if (id === undefined || versionId === undefined)`, which TypeScript does narrow on the fall-through path, while still building the `missing` array beforehand so the failure message names exactly which field(s) were absent.
- **Files modified:** `packages/domain/src/discovery/os-release.ts`
- **Verification:** `pnpm lint`, `pnpm typecheck`, and the existing `os-release.test.ts` missing-field tests all pass.
- **Committed in:** `5268025` (Task 1 feat commit)

**2. [Housekeeping, not a deviation rule] Removed an accidentally-committed `.DS_Store`**
- **Found during:** immediately after the Task 1 RED commit
- **Issue:** The Task 1 RED commit (`6e51760`) unexpectedly included a macOS `.DS_Store` file at the outer git repository's root (this repo's git root is the parent `/Users/xch4rt/work/myself` directory, shared with several unrelated sibling projects per the repo-layout warning), despite `.DS_Store` already being listed in that root `.gitignore`. `git show HEAD~1:.DS_Store` confirmed the file did not exist before that commit.
- **Fix:** `git rm --cached .DS_Store` from the repo root, committed as a standalone `chore(02-05)` commit. No plan files were affected.
- **Files modified:** `.DS_Store` (removed from tracking, none of this plan's files)
- **Verification:** `git log --oneline` shows the file untracked again; `git status --short` no longer reports it as staged.
- **Committed in:** `c4d1d03`

---

**Total deviations:** 1 auto-fixed (1 blocking TypeScript narrowing issue) + 1 housekeeping fix (accidental unrelated file in a shared outer repo, unrelated to plan scope).
**Impact on plan:** Both were necessary for the plan's own verification commands (`pnpm lint`, clean git history) to pass. No scope creep — neither touched any file outside what Task 1's `<files>` list already declared, except the `.DS_Store` housekeeping commit which touches nothing this plan owns.

## Issues Encountered

None beyond the two items above.

## User Setup Required

None - no external service configuration required.

## Next Phase Readiness

- Plan 02-09 (the `runDiscovery` orchestrator) can now call all seven parsers directly: `parseOsRelease`, `parseHostname`, `parseArch`, `parseCpuCores`, `parseUptimeSeconds`, `parseSudoCheck`, `parseDockerGroupMembership`, `parseMeminfo`, `parseDiskUsage`, `parseDockerVersion`, `parseComposeVersion` are all exported from `packages/domain/src/discovery/index.ts`. Per the plan's own note, `dockerInstalled` for `DiscoveryFacts` is derived from `DockerVersionResult`'s `kind` by the orchestrator (plan 02-09), not by this plan's parser.
- D-11 is fully in place for any future plan that calls `applyConnectionResult`/`statusForErrorCode` with an `UNSUPPORTED_OS` result — it will land the server on `CONNECTED` with the code recorded in `lastErrorCode`.
- No blockers identified for 02-06 through 02-10.

---
*Phase: 02-adaptador-ssh-aislado-y-probado-con-testcontainers*
*Completed: 2026-09-14*

## Self-Check: PASSED

- All 14 key created/modified files verified present on disk (the five discovery parser
  modules with their `.test.ts` files, `discovery/index.ts`, `server/connection-result.ts` and
  `.test.ts`, `docs/domain/server-state-transitions.md`).
- All 7 commit hashes (`6e51760`, `5268025`, `f3f6ad8`, `931cf7b`, `64bca58`, `2b1f2be`,
  `c4d1d03`) verified present in `git log`.
