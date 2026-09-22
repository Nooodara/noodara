---
phase: 01-dominio-persistencia-y-autenticacion
plan: 16
subsystem: infra
tags: [tsc-build, tsx, turborepo, exports-map, boot, vitest, testcontainers]

# Dependency graph
requires:
  - phase: 01-dominio-persistencia-y-autenticacion
    provides: "packages/domain's five stable subpath exports (Plan 01-02), apps/control-plane's env.ts fail-fast (Plan 01-03/01-07), the noodara CLI and db:migrate tsx precedent (Plan 01-07/01-14), CI's six-job pipeline (Plan 01-15)"
provides:
  - "packages/domain built to dist/ with declarations; exports map resolves under plain Node with zero tsx involvement, through exactly the same five entrypoints"
  - "apps/control-plane's dev script runs through tsx watch; a new start script runs the built dist/server.js under plain Node with no loader"
  - "apps/control-plane's dist is self-contained: migrations (.sql + meta/_journal.json) copied in, test files excluded"
  - "vitest.shared.ts: single source of the @noodara/domain source aliases both Vitest configs use, keeping in-process unit/integration tests resolving against source, not dist"
  - "turbo.json dev task (dependsOn ^build, cache:false, persistent:true) with an explicit passThroughEnv allowlist, required because Turborepo 2's default strict env mode strips undeclared environment variables before spawning a task"
  - "tests/integration/boot/boot-command.test.ts: a 4-case child-process smoke test that spawns the real dev/start commands (including the literal, turbo-driven root pnpm dev on a tree with no dist) and would fail on a resolution or task-graph regression"
  - "tests/integration/global-setup.ts: builds the workspace once before the integration suite runs, so every spawned-process test (including the pre-existing admin-reset.test.ts CLI spawn) always exercises current sources"
affects: ["phase-6-installer (Docker image can now run node dist/server.js with no TypeScript loader)", "any future phase spawning a real control-plane process"]

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "packages/domain builds via tsc -p tsconfig.build.json (excludes *.test.ts) and its package.json exports map points at dist/*.js + .d.ts; every in-process Vitest run instead resolves the same five specifiers to packages/domain/src via a shared resolve.alias (vitest.shared.ts), so unit tests and QA-02's coverage gate stay build-free"
    - "apps/control-plane's build script chains tsc -p tsconfig.build.json with a plain scripts/*.mjs asset-copy step (migrations), the same pattern any future package needing non-.ts build output should follow"
    - "Turborepo 2 strict env mode: any task that spawns a process needing real environment variables (not just build/lint/typecheck) must declare an explicit passThroughEnv (or env) allowlist in turbo.json, or the variables are silently stripped before the child process starts"
    - "Child-process boot tests use a detached process group (spawn detached:true, kill via process.kill(-pid, ...)) with Node setTimeout-based bounds instead of a shell timeout binary, since GNU timeout is unavailable on macOS"

key-files:
  created:
    - tests/integration/helpers/boot-process.ts
    - tests/integration/global-setup.ts
    - tests/integration/boot/boot-command.test.ts
    - packages/domain/tsconfig.build.json
    - vitest.shared.ts
    - apps/control-plane/scripts/copy-migration-assets.mjs
  modified:
    - packages/domain/package.json
    - vitest.config.ts
    - vitest.integration.config.ts
    - turbo.json
    - apps/control-plane/package.json
    - apps/control-plane/tsconfig.build.json
    - package.json

key-decisions:
  - "packages/domain gets a real tsc build with exports pointing at dist/*.js+.d.ts (production-path-weighted fix), while dev moves to tsx watch (already a control-plane devDependency and already the loader behind db:migrate/the CLI) — matching the plan's stated mechanism"
  - "vitest.shared.ts centralizes the @noodara/domain source-aliasing rule (subpath aliases before the bare-package regex alias, so the bare alias can never swallow a subpath specifier) so both Vitest configs can never drift apart"
  - "turbo.json's dev task needs an explicit passThroughEnv allowlist naming every apps/control-plane/src/env.ts variable — discovered empirically: Turborepo 2's default strict env mode silently strips undeclared env vars before spawning a task, so the literal root pnpm dev crashed INST-06's fail-fast even with a fully valid environment, while pnpm --filter <pkg> dev (which bypasses turbo) worked. This was not anticipated in the plan's <interfaces> section and is documented here as the deviation it is."
  - "boot-command.test.ts's LISTENING_PATTERN matches any host, not the literal 0.0.0.0 the plan's <interfaces> section stated Fastify would log — empirically, Fastify resolves host 0.0.0.0 to each of the machine's real network interfaces (loopback plus any LAN address) when logging its listen line, never the literal string"
  - "Dropped the post-kill exit-code assertions in the dev/start boot tests: a process terminated by SIGTERM reports a null exit code by Node design (the numeric code is only set for a process that exited on its own); waitForExit resolving without throwing its own timeout is already the correct proof of a clean shutdown"

patterns-established:
  - "Any future workspace package with a runtime consumer outside Vitest must ship a tsc build + dist-pointing exports map, plus a resolve.alias entry in vitest.shared.ts so in-process tests keep measuring/exercising source"
  - "Any turbo.json task that spawns a process needing real secrets/config must declare passThroughEnv explicitly — do not assume turbo forwards the parent shell's environment"

requirements-completed: [INST-06]

# Metrics
duration: 38min
completed: 2026-09-11
---

# Phase 1 Plan 16: Real Boot Path (tsx dev, plain-Node start, domain build) Summary

**Closed 01-VERIFICATION.md's BLOCKER: `packages/domain` now builds to `dist` with its exports map pointing there, `apps/control-plane`'s `dev` runs through `tsx watch` and a new `start` script runs the built artifact under plain Node, and a 4-case child-process integration test (including a clean-tree, turbo-driven root `pnpm dev` proof) locks the fix in.**

## Performance

- **Duration:** 38 min
- **Started:** 2026-09-11T22:56:00-06:00 (approx, first RED run)
- **Completed:** 2026-09-11T23:33:42-06:00
- **Tasks:** 3
- **Files modified:** 13 (6 created, 7 modified)

## Accomplishments
- `packages/domain` builds to `dist/` with `.d.ts` declarations; its `exports` map resolves under plain Node with zero `tsx` involvement, through exactly the same five entrypoints as before (`.`, `./server`, `./security`, `./validators`, `./activity`)
- `apps/control-plane`'s `dev` script now runs through `tsx watch` (no more `ERR_MODULE_NOT_FOUND` on `./env.js`); a new `start` script runs `node dist/server.js` directly with zero loader
- `apps/control-plane/dist` is self-contained: migrations (`.sql` + `meta/_journal.json`) are copied in by a new `copy-migration-assets.mjs`, compiled test files are excluded
- `turbo.json` gained a `dev` task (`dependsOn: ["^build"]`, `cache: false`, `persistent: true`) with an explicit `passThroughEnv` allowlist, so a clean checkout's literal root `pnpm dev` both builds `packages/domain` first and actually receives its required config
- `tests/integration/boot/boot-command.test.ts` spawns the real `start`, package-scoped `dev`, and literal root `pnpm dev` (on a tree with both `dist` directories deleted) as child processes — 4/4 passing, would fail on a resolution or task-graph regression
- `pnpm test` (unit) stays build-free and Docker-free via `vitest.shared.ts`'s source aliases; `packages/domain` coverage stays at 100%/100% (well above the 95%/95% QA-02 threshold)
- Full integration suite: 17 files, 113/113 passing (109 pre-existing + 4 new boot tests), zero stray `noodara.test=true` containers
- Manually verified by hand (not just via Testcontainers): a genuinely clean tree (`rm -rf packages/domain/dist apps/control-plane/dist`) running the literal root `pnpm dev` against a live `docker-compose.dev.yml` Postgres reaches `Server listening` with no manual `pnpm build` first; `pnpm build && pnpm start` reaches the same state under plain Node

## Task Commits

Each task was committed atomically:

1. **Task 1: RED — child-process smoke test for the real boot commands** - `71eb438` (test)
2. **Task 2: GREEN part 1 — give packages/domain a real build and point its exports at dist** - `de05d8f` (feat)
3. **Task 3: GREEN part 2 — real dev and start entrypoints, self-contained dist** - `9439744` (feat)

**Plan metadata:** (this commit)

## Files Created/Modified
- `tests/integration/helpers/boot-process.ts` - Detached-process-group spawn helper (buildValidBootEnv, spawnBootProcess/BootProcess, parseListeningPort, removeBuildOutputs, buildWorkspace); every wait is Node-`setTimeout`-bounded, no shell `timeout`
- `tests/integration/global-setup.ts` - Builds the workspace once before the integration suite runs
- `tests/integration/boot/boot-command.test.ts` - The 4-case boot smoke test (start fail-fast, start real boot, package-scoped dev, clean-tree turbo-driven root dev)
- `packages/domain/tsconfig.build.json` - Emit-only build config, excludes `*.test.ts`
- `packages/domain/package.json` - Adds `build` script; `exports` map rewritten to conditional `{types, default}` pointing at `dist`
- `vitest.shared.ts` - `domainSourceAliases`: single source of the `@noodara/domain` source aliases (subpath entries before the bare-package regex entry)
- `vitest.config.ts` / `vitest.integration.config.ts` - Wire in `domainSourceAliases`; integration config also gains `globalSetup`
- `turbo.json` - `lint` gains `dependsOn: ["^build"]`; new `dev` task with `passThroughEnv`
- `apps/control-plane/package.json` - `dev` → `tsx watch src/server.ts`; new `start` → `node dist/server.js`; `build` chains the migration-asset copy
- `apps/control-plane/tsconfig.build.json` - Excludes `*.test.ts` from `dist`
- `apps/control-plane/scripts/copy-migration-assets.mjs` - Copies `src/db/migrations` into `dist/db/migrations`
- `package.json` (root) - New `start` script (`pnpm --filter @noodara/control-plane start`)

## Decisions Made
See `key-decisions` in frontmatter. Most significant: the `turbo.json` `passThroughEnv` requirement and the `LISTENING_PATTERN` host-matching fix were both empirical discoveries not anticipated by the plan's `<interfaces>` section — documented as deviations below, not silent scope creep.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] `turbo.json`'s `dev` task needs an explicit `passThroughEnv` allowlist**
- **Found during:** Task 3 (first full run of the boot-command test, Test 4)
- **Issue:** The literal root `pnpm dev` (turbo-driven) crashed with all five `NOODARA_CONFIG_ERROR` lines even when given a fully valid environment. Turborepo 2's default strict env mode strips any environment variable not explicitly declared (`env`/`passThroughEnv`/`globalEnv`/`globalPassThroughEnv`) before spawning a task — this is not mentioned anywhere in the plan. `pnpm --filter @noodara/control-plane dev` (Test 3, which bypasses turbo) received the same environment correctly, proving the stripping was turbo-specific.
- **Fix:** Added a `passThroughEnv` array to the `dev` task in `turbo.json` naming every variable in `apps/control-plane/src/env.ts`'s `Env` interface.
- **Files modified:** `turbo.json`
- **Verification:** `tests/integration/boot/boot-command.test.ts` Test 4 passes; confirmed by hand with a genuinely clean tree and a live `docker-compose.dev.yml` Postgres.
- **Committed in:** `9439744` (Task 3 commit)

**2. [Rule 1 - Bug] Boot test's `LISTENING_PATTERN` didn't match Fastify's real output**
- **Found during:** Task 3 (first full run of the boot-command test, Tests 2 and 3)
- **Issue:** The plan's `<interfaces>` section states Fastify's listen log's `msg` is `Server listening at http://0.0.0.0:<port>`. Empirically, this Fastify version resolves `host: '0.0.0.0'` to each of the machine's real network interfaces (loopback plus any LAN address) and logs one line per address — never the literal string `0.0.0.0`.
- **Fix:** Changed `LISTENING_PATTERN` from `/Server listening at http:\/\/0\.0\.0\.0:(\d+)/` to `/Server listening at http:\/\/[^:]+:(\d+)/`, matching any resolved host.
- **Files modified:** `tests/integration/boot/boot-command.test.ts`
- **Verification:** Tests 2 and 3 pass; the app's actual behavior (correct, unmodified) is now correctly asserted against.
- **Committed in:** `9439744` (Task 3 commit)

**3. [Rule 1 - Bug] Post-kill exit-code assertions were backwards**
- **Found during:** Task 3 (second full run of the boot-command test, Test 2)
- **Issue:** `expect(exitCode).not.toBeNull()` after a `SIGTERM` kill failed, because Node reports `code: null` for a process terminated by a signal (the numeric exit code is only set for a process that exited on its own) — the assertion penalized the correct, clean-shutdown case.
- **Fix:** Removed the assertion; `waitForExit` resolving without throwing its own timeout error is already sufficient proof the process exited cleanly within the bound.
- **Files modified:** `tests/integration/boot/boot-command.test.ts`
- **Verification:** Tests 2 and 3 pass.
- **Committed in:** `9439744` (Task 3 commit)

**4. [Rule 3 - Blocking] Stale `dist` output leftover from a mid-session edit was cached by turbo and had to be force-rebuilt**
- **Found during:** Task 3, before the acceptance-criteria checks
- **Issue:** `apps/control-plane/dist` still contained 7 compiled `*.test.js` files after `tsconfig.build.json`'s `exclude` was added, because `tsc` does not delete stale output files not in the current compilation set, and turbo had already cached that stale output under the (unchanged) input hash.
- **Fix:** Deleted `apps/control-plane/dist` and `packages/domain/dist` and ran `turbo run build --force` once to overwrite the cache entry with the correct, test-file-free output; subsequent plain `pnpm build` runs confirmed 0 `*.test.js` files.
- **Files modified:** none (build-output-only; `dist/` is gitignored)
- **Verification:** `find apps/control-plane/dist -name '*.test.js' | wc -l` → `0` after a plain `pnpm build`.

---

**Total deviations:** 4 auto-fixed (3 bugs in the plan's own new test code, 1 blocking local-cache artifact). No architectural changes; no scope beyond `files_modified`.
**Impact on plan:** All four were necessary for the boot smoke test to correctly prove (rather than incorrectly refute) the fix's correctness. No scope creep — every file touched was already in the plan's `files_modified` list.

## Issues Encountered
- Vitest's coverage text-reporter console table did not print the `packages/domain/src` rows for the full 20-file unit run (they *were* present, at 100%/100%, in `coverage/coverage-summary.json`, and did print when running a single domain test file in isolation). This looked alarming at first — exactly the "coverage silently zeroed" failure mode the plan warns about — but was confirmed to be a reporter display quirk, not a real gate gap, by reading the JSON summary directly. No code change was needed.

## User Setup Required
None - no external service configuration required.

## Next Phase Readiness
- The roadmap's phase-1 goal ("el control plane arranca") is now proven true through the project's own documented commands (`pnpm dev`, `pnpm build && pnpm start`), not just inside Vitest's module transform.
- Phase 6's installer can run `node dist/server.js` in its Docker image with zero TypeScript loader, and `dist/cli/index.js` (already declared in `bin`) has its migration assets available.
- 01-VERIFICATION.md's one BLOCKER is closed; the two non-blocking `human_verification` items (live GitHub Actions run, gitleaks re-run once the repo is its own root) remain open for a human, as originally scoped — this plan does not attempt either.

---
*Phase: 01-dominio-persistencia-y-autenticacion*
*Completed: 2026-09-11*

## Self-Check: PASSED

All created files confirmed present on disk; all three task commit hashes (`71eb438`, `de05d8f`, `9439744`) confirmed in `git log`.
