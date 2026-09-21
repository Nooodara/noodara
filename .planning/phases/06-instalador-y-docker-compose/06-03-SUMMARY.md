---
phase: 06-instalador-y-docker-compose
plan: 03
subsystem: docker
tags: [dockerfile, turbo-prune, testcontainers, non-root, migrations, health]

# Dependency graph
requires:
  - phase: 06-instalador-y-docker-compose
    plan: 01
    provides: vitest.installer.config.ts / pnpm test:installer / tests/integration/installer/tsconfig.json
  - phase: 04-http-routes-worker-bullmq-y-sse
    provides: GET /health contract (checks.postgres/redis/worker), NOODARA_SETUP_TOKEN stdout contract
provides:
  - "apps/control-plane/Dockerfile: pruner/installer/builder/runner multi-stage image, node:22-slim, turbo prune --docker, non-root noodara system user, four compiled entrypoints (dist/server.js, dist/worker.js, dist/db/migrate.js, dist/cli/index.js)"
  - ".dockerignore: repo-root build-context exclusions (.env*, node_modules, dist, coverage, .planning/.claude/docs/tests), keeps pnpm-lock.yaml/pnpm-workspace.yaml/turbo.json/package.json in context"
  - "ARG NOODARA_IMAGE_VERSION build-time version stamp reaching CONTROL_PLANE_VERSION (src/config-version.ts) and GET /health's version field"
  - "tests/integration/installer/control-plane-image.test.ts: GenericContainer.fromDockerfile + host.docker.internal/host-gateway pattern for reaching Postgres/Redis Testcontainers fixtures from a built image under test -- reusable by Plan 06-07"
affects: [06-04-env-generation, 06-07-compose-production, 06-09-main-flow, 06-13-ci-release]

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "One image, four entrypoints: CMD node dist/server.js, Compose command: overrides pick dist/worker.js / dist/db/migrate.js / dist/cli/index.js (phase 4 D-23, ADR 0003)"
    - "turbo prune --docker (pnpm install --frozen-lockfile then pnpm exec turbo, never a bare npx) resolves the workspace subset one app needs; runner stage copies the WHOLE pruned workspace (not just apps/control-plane/dist) because pnpm's isolated node_modules is a symlink tree rooted at node_modules/.pnpm"
    - "Testcontainers GenericContainer under test reaches sibling Postgres/Redis Testcontainers fixtures via --add-host host.docker.internal:host-gateway plus each fixture's own host-mapped port, since postgres.ts/redis.ts expose no shared Docker network"
    - "ARG NOODARA_IMAGE_VERSION + pnpm pkg set version=... in the builder stage, read at runtime via config-version.ts's createRequire('../package.json')"

key-files:
  created:
    - .dockerignore
    - apps/control-plane/Dockerfile
    - tests/integration/installer/control-plane-image.test.ts
  modified: []

key-decisions:
  - "pnpm pkg set version=\"$NOODARA_IMAGE_VERSION\" (run from apps/control-plane/) chosen over a node -e JSON rewrite for the version-stamp step -- fewer escaping hazards inside a Dockerfile RUN line, same effect"
  - "Task 1's turbo prune --docker spike (turbo 2.10.12) found out/json/ already contains pnpm-workspace.yaml automatically for both @noodara/control-plane and @noodara/web filters -- no extra COPY line needed in the installer stage, contrary to the plan's conditional instruction to add one only if missing"
  - "Container-under-test reaches the Postgres/Redis Testcontainers fixtures via --add-host host.docker.internal:host-gateway plus the fixture's own getPort()/getUsername()/getPassword()/getDatabase() accessors (constructing a fresh URL, never postgres.connectionString's localhost-scoped one) -- chosen over adding a shared testcontainers Network to postgres.ts/redis.ts, since that would touch two widely-shared helpers other suites depend on; Plan 06-07 can reuse this same mechanism unchanged"
  - "CLI --help test uses the exact fake-secret stand-in shapes vitest.config.ts's apps project already uses (NOODARA_MASTER_KEY/BETTER_AUTH_SECRET/DATABASE_URL/REDIS_URL/NOODARA_PUBLIC_URL), with no real Postgres/Redis containers -- apps/control-plane/src/cli/index.ts imports env.js unconditionally at module top level even for --help, so env.ts's shape/strength validation must pass, but --help never issues a real DB/Redis connection"

requirements-completed: []  # INST-01 spans all 15 plans of this phase; this plan delivers only the image, not the installer flow that uses it -- see Deviations.

# Metrics
duration: ~2h10min
completed: 2026-09-21
---

# Phase 06 Plan 03: Control-plane Dockerfile — four entrypoints, one non-root image Summary

**First production Docker image this repo has ever built: `apps/control-plane/Dockerfile` (pruner/installer/builder/runner, `node:22-slim`, non-root `noodara` user) packages `api`/`worker`/`migrate`/the `noodara` CLI into one 1.22GB image, proven for real against Testcontainers Postgres/Redis fixtures rather than trusted from RESEARCH.md.**

## Performance

- **Duration:** ~2h10min (research/file reads + turbo prune spike + Dockerfile authoring/build + full integration test authoring/run)
- **Started:** 2026-09-21T~08:05:00Z (approximate)
- **Completed:** 2026-09-21T10:17:53Z
- **Tasks:** 3
- **Files modified:** 3 (all created)

## Accomplishments

- `.dockerignore`: excludes `.env`/`.env.*` with no negation, `node_modules`, `**/dist`, `**/.next`, `**/.turbo`, `coverage`, Playwright artifacts, `.planning`, `.claude`, `docs`, `tests`, `*.tsbuildinfo`, `.DS_Store`. Keeps `pnpm-lock.yaml`, `pnpm-workspace.yaml`, `turbo.json`, `package.json`, `apps/**`, `packages/**`. Measured `turbo prune --docker` (turbo 2.10.12) for both `@noodara/control-plane` and `@noodara/web` filters: `out/json/` contains `pnpm-workspace.yaml` and `pnpm-lock.yaml` automatically (top-level, and also duplicated inside `out/json/`); `out/full/` contains exactly the expected workspace directories (`control-plane`+`domain`+`ssh`+`config` for the control-plane filter; `web`+`domain`+`ssh`+`ui`+`config` for the web filter).
- `apps/control-plane/Dockerfile`: four-stage build (`pruner` → `installer` → `builder` → `runner`), all `node:22-slim`. `pruner` runs a full `pnpm install --frozen-lockfile --ignore-scripts` then `pnpm exec turbo prune @noodara/control-plane --docker` (never a bare unpinned `npx turbo`). `installer` installs from the pruned `out/json/` + `out/pnpm-lock.yaml` with scripts enabled (argon2's native build runs via `pnpm-workspace.yaml`'s `onlyBuiltDependencies: [argon2]`). `builder` copies `out/full/`, optionally stamps `apps/control-plane/package.json`'s `version` via `ARG NOODARA_IMAGE_VERSION`, then runs `turbo run build --filter=@noodara/control-plane` (which runs `tsc` + `copy-migration-assets.mjs` for control-plane plus `^build` for `domain`/`ssh`). `runner` creates a dedicated system user (`groupadd --system noodara && useradd --system --gid noodara --home-dir /app noodara`), copies the *entire* pruned+built workspace (documented reason: pnpm's isolated `node_modules` symlink tree would otherwise dangle), runs as `USER noodara`, `CMD ["node", "dist/server.js"]`. Verified locally: build exits 0 (~91s cold, ~19s fully cached), `id -u` reports `999` (non-root), all four `dist/*` entrypoints plus `dist/db/migrations/meta/_journal.json` present on disk. Final image size: **1.22GB** (`docker images` measured) — large because `turbo prune --docker` does not prune the root `package.json`'s own (test-tooling-heavy) `devDependencies` list, and the runner stage intentionally copies the whole workspace rather than a slimmer subset (documented trade-off, deferred per RESEARCH.md's own "if image size becomes a real constraint later" framing — out of this plan's scope).
- `tests/integration/installer/control-plane-image.test.ts`: 6 real-container test cases via `GenericContainer.fromDockerfile(REPO_ROOT, 'apps/control-plane/Dockerfile')` — (1) non-root uid proof, (2) `node dist/db/migrate.js` applies N>0 migrations then reports 0 applied on a second run (idempotency, the exact property Compose's re-run-on-every-`up` behavior for one-shot services relies on), (3) `node dist/server.js` answers `GET /health` 200 with `checks.postgres: 'pass'`, (4) `node dist/worker.js` reaches `Worker ready` and stays responsive (`exec(['true'])` after), (5) `node dist/cli/index.js --help` exits 0 and lists the `admin`/`secrets` commands, (6) a build with `--build-arg NOODARA_IMAGE_VERSION=9.9.9-test` reports that exact version from `GET /health`. All 6 pass; `pnpm typecheck`, `pnpm lint`, `pnpm test` (1641 tests) all green; no `noodara.test=true` container or built test image survives the run.

## Task Commits

1. **Task 1: `.dockerignore` and a verified `turbo prune` spike**
   - `4ef90fd` feat(06-03): add .dockerignore for image build contexts
2. **Task 2: `apps/control-plane/Dockerfile` — four entrypoints, one non-root image**
   - `ec149b0` feat(06-03): add control-plane Dockerfile, four entrypoints non-root
3. **Task 3: Integration proof — all four entrypoints run from the image** (`tdd="true"`)
   - `c68596f` test(06-03): prove all four control-plane image entrypoints for real

## TDD Gate Compliance

Task 3 is `tdd="true"`, and the plan's own `<action>` text called for a RED commit ("write the test file, run it against the not-yet-final Dockerfile, commit the failing state") before a separate GREEN commit that adjusts the Dockerfile. That could not be reproduced honestly: Task 2's Dockerfile was already written, committed (`ec149b0`), and independently verified against its own acceptance criteria (build succeeds, `id -u` non-zero, all four `dist/*` files + migration assets present, `USER noodara`, `CMD`, `NOODARA_IMAGE_VERSION` present, no unpinned `npx`) *before* Task 3's test file was authored — the plan's own task ordering places the full, working Dockerfile before the test. When Task 3's test ran for the first time, all 6 cases passed immediately (`4ef90fd`/`ec149b0` already covered every runtime behavior the test proves; no Dockerfile change was needed to reach GREEN). Per hard_rule #11 ("prefer the code's reality... do not invent results"), no failing state was fabricated by temporarily breaking the already-verified, working Dockerfile — that would have meant reverting genuinely correct, already-committed work purely to manufacture a RED commit. Task 3 is therefore a single `test:` commit (`c68596f`), not a RED/GREEN pair; the test itself is the real, independent proof that Task 2's implementation is correct (it exercises four runtime behaviors — migrate idempotency, `/health` reachability, worker readiness, CLI help, version stamping — none of which Task 2's own `<verify>` block checked), so the TDD *goal* (an independent test proving the implementation, not implementation-following-test) is still met even though the literal two-commit mechanic does not apply here.

## Files Created/Modified

- `.dockerignore` - Repo-root build-context exclusions for every Docker image build (control-plane now, web in a later plan)
- `apps/control-plane/Dockerfile` - Four-stage production image: pruner, installer, builder, runner
- `tests/integration/installer/control-plane-image.test.ts` - Real Testcontainers proof of all four compiled entrypoints against Postgres/Redis fixtures

## Decisions Made

See `key-decisions` in the frontmatter above — version-stamp mechanism (`pnpm pkg set`), the Task 1 spike's finding that `pnpm-workspace.yaml` needs no extra `COPY` line, the `host.docker.internal`/`host-gateway` networking mechanism for reaching sibling Testcontainers fixtures (documented here for Plan 06-07 to reuse), and the CLI `--help` test's fake-env reuse.

## Deviations from Plan

**1. [Rule-11 reality-over-plan] TDD RED/GREEN split not reproducible for Task 3 (see "TDD Gate Compliance" above).** Task 3 landed as a single `test:` commit instead of a `test:`/`feat:` pair, because Task 2's Dockerfile already satisfied every behavior Task 3's test checks by the time the test was written — a direct consequence of the plan's own task ordering (Dockerfile fully built and verified in Task 2, before the test in Task 3). No code was reverted or artificially broken to manufacture a failing commit.

**2. [Observation, not auto-fixed] Image size (1.22GB) is larger than a typical slim Node production image**, because (a) `turbo prune --docker` does not prune the root `package.json`'s own `devDependencies` (turbo/vitest/playwright/testcontainers/eslint/etc. all install into the image, unused at runtime) and (b) the runner stage deliberately copies the *entire* pruned+built workspace rather than a narrower subset, per the Dockerfile's own documented reasoning (pnpm's isolated `node_modules` symlink tree would otherwise dangle if only `apps/control-plane/dist` were copied). This matches 06-RESEARCH.md's own framing ("Alpine remains a documented, lower-risk-than-it-looks fallback if image size becomes a real constraint later") — no action taken here; flagged for whichever later phase/plan first cares about pull time or registry storage cost.

No other deviations (Rules 1-3): no bugs found, no missing critical functionality beyond what the plan already specified, no blocking issues encountered.

## Issues Encountered

None beyond the TDD sequencing question documented above. One ESLint finding (`@typescript-eslint/prefer-regexp-exec` on the migration-count regex in the test file) was fixed inline before the single test commit landed — not counted as a "deviation" since it is ordinary lint-clean authoring, not a Rule 1-3 fix to already-committed code.

## User Setup Required

None — no external service configuration required. (D-02's GitHub repo creation remains a later, documented prerequisite for the release workflow, unaffected by this plan.)

## Next Phase Readiness

- `apps/control-plane/Dockerfile` is ready for Plan 06-07's production `docker-compose.yml` to reference directly (`build: { context: ., dockerfile: apps/control-plane/Dockerfile }` or a pre-built `image:` tag from the release workflow) with `command:` overrides for `worker`/`migrate`.
- The `host.docker.internal`/`host-gateway` networking pattern this plan's test proved is reusable as-is by Plan 06-07's own installer-vs-fixture Docker networking, and by Plan 06-10's DinD harness if it needs to reach a host-side fixture.
- `.dockerignore` is shared infrastructure: `apps/web/Dockerfile` (a later plan) needs no changes to it.
- No blockers for Plan 06-04 (`.env` generation) — that plan does not depend on this image directly, only on the same `.env.example` variable set already validated by `apps/control-plane/src/env.ts`.
- Known follow-up (not a blocker): image size (1.22GB) could be revisited later via Alpine or a leaner runner-stage copy if pull time on a fresh VPS becomes a real concern — out of scope for v0.1 per RESEARCH.md.

---
*Phase: 06-instalador-y-docker-compose*
*Completed: 2026-09-21*

## Self-Check: PASSED

All 3 created files (`.dockerignore`, `apps/control-plane/Dockerfile`, `tests/integration/installer/control-plane-image.test.ts`) verified present on disk; all 3 task commit hashes (`4ef90fd`, `ec149b0`, `c68596f`) verified present in `git log --oneline --all`.
