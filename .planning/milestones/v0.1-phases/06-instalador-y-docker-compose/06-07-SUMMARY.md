---
phase: 06-instalador-y-docker-compose
plan: 07
subsystem: infra
tags: [docker-compose, healthcheck, drizzle-migrate, redis, postgres, memory-limits]

# Dependency graph
requires:
  - phase: 06-instalador-y-docker-compose
    plan: 03
    provides: "apps/control-plane/Dockerfile -- one non-root image, four entrypoints (server.js/worker.js/db/migrate.js/cli/index.js)"
  - phase: 06-instalador-y-docker-compose
    plan: 05
    provides: "apps/web/Dockerfile -- Next standalone, NOODARA_API_ORIGIN baked as both a build arg and a runtime ENV"
  - phase: 06-instalador-y-docker-compose
    plan: 04
    provides: "install.sh's noodara_generate_env -- the real .env writer this plan's test drives instead of hand-writing one"
provides:
  - "docker-compose.yml: the production six-service topology (postgres, redis, migrate, api, worker, web) the installer writes to /opt/noodara"
  - "docker-compose.dev.yml: one-line fix -- redis service now has an environment: REDIS_PASSWORD entry so its own healthcheck can actually authenticate"
  - "tests/integration/installer/compose-stack.test.ts: real docker compose up of the whole production stack, proving health, port exposure, migration idempotency, second-up safety, admin-password passthrough and measured memory limits"
affects: [06-09-main-flow, 06-10-dind-harness, 06-12-preflight-scenarios, 06-13-ci-release, 06-15-real-vps-validation]

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "docker compose config --format json resolves deploy.resources.limits.memory and ports: to their final, interpolated values -- used instead of a hand-rolled YAML parse, so the test can never silently drift from what Compose itself actually does with the file"
    - "${VAR:?message} on every credential/version/prefix/port interpolation in docker-compose.yml -- a missing or corrupted .env now fails docker compose config/up loudly instead of starting a service with an empty password or an unversioned image tag"
    - "REDISCLI_AUTH=\"$$REDIS_PASSWORD\" redis-cli ping, not redis-cli -a \"$$REDIS_PASSWORD\" ping -- keeps the password out of the healthcheck's own argv (a ps/docker top-visible exposure distinct from --requirepass's own accepted argv exposure, T-06-36)"
    - "docker compose up <service> only brings up that service's own transitive dependencies, never its dependents -- used to bring up just postgres/redis/migrate/api (skipping worker/web) for the admin-password-passthrough proof"
    - "docker compose ps -a --format json prints NDJSON (one JSON object per line), and its Publishers[].PublishedPort is 0 for an EXPOSEd-but-unpublished port -- both required to write the port-exposure assertion correctly (a plain 'Ports' string is not enough)"

key-files:
  created:
    - docker-compose.yml
    - tests/integration/installer/compose-stack.test.ts
  modified:
    - docker-compose.dev.yml

key-decisions:
  - "NOODARA_PORT is passed to noodara_generate_env as the literal string '127.0.0.1:<port>' for this suite's own compose run -- Compose's ${VAR}:3000 interpolation accepts an embedded host:port, so the loopback-only bind hard_rule #7 requires is achieved without touching docker-compose.yml's own unmodified ${NOODARA_PORT}:3000 mapping (a real install still gets every-interface publishing from a bare port number)"
  - "migrate's deploy.resources.limits.memory (192M) is NOT directly measured: the migration job completes in well under a second (67ms in one observed run), too fast for docker stats --no-stream to reliably sample mid-run. Bounded instead by analogy to postgres's own measured ceiling -- same order of magnitude, comfortably above what a Node process running a handful of DB statements needs. Documented in docker-compose.yml's own header comment and asserted only for >0, never against a 2x-of-zero comparison"
  - "The admin-password-passthrough proof (hard_rule requirement, not explicit in the original PLAN.md task text) runs as its own, second compose project/lifecycle inside the same test file, rather than folding into the main stack's one 'up' -- setting NOODARA_ADMIN_EMAIL/PASSWORD makes bootstrap-admin pre-seed the admin and skip emitting NOODARA_SETUP_TOKEN entirely (fase 1 D-04), which is mutually exclusive with the main test's own setup-token proof inside one .env"
  - "Container-ID stability (not just health status) is asserted across the second up -- 'nothing recreated unexpectedly' is a distinct claim from 'still healthy after a restart', and only an ID comparison actually proves a container was not torn down and rebuilt"

requirements-completed: []  # INST-01 spans all 15 plans of this phase; this plan delivers the production topology + its own proof suite, but does not wire docker-compose.yml into install.sh's main flow (Plan 06-09's job) -- see Deviations, matching 06-03/06-04/06-05's identical precedent.

# Metrics
duration: ~50min (07:00-07:50 approx, including context reads; task commits span 07:13:48-07:45:22)
completed: 2026-09-21
---

# Phase 06 Plan 07: Production docker-compose.yml Summary

**The six-service production topology (`postgres`/`redis`/`migrate`/`api`/`worker`/`web`) that the installer writes to `/opt/noodara`, proven end to end against the real Dockerfiles from Plans 06-03/06-05 by a real `docker compose up` -- redis reports genuinely healthy (the dev file's broken `$${REDIS_PASSWORD}` healthcheck fixed in both files), only `web` publishes a host port, a second `up` recreates nothing and re-runs the migrator to a proven no-op, a tricky admin password survives byte-for-byte into the `api` container's own environment, and every per-service memory limit is set from a real `docker stats` measurement with at least 2x headroom.**

## Performance

- **Duration:** ~50min total session (context reads + manual dry runs to derive real behavior before writing the test + implementation); the 9 task/fix commits themselves span 07:13:48-07:45:22 (~32min)
- **Started:** 2026-09-21T~07:00:00-06:00 (approximate)
- **Completed:** 2026-09-21T07:45:22-06:00
- **Tasks:** 2 (plan) + 3 post-plan hardening fixes required by the orchestrator's own hard_rules
- **Files modified:** 3 (2 created, 1 modified)

## Accomplishments

- `docker-compose.yml`: `postgres:17-alpine` and `redis:7-alpine` (no host ports, named volumes `noodara_postgres_data`/`noodara_redis_data`), `migrate` (`node dist/db/migrate.js`, `restart: "no"`, `depends_on: postgres: service_healthy`), `api`/`worker` (same `${NOODARA_IMAGE_PREFIX}/noodara-control-plane:${NOODARA_VERSION}` image, different `command:`, both gated on `migrate: service_completed_successfully` and `redis: service_healthy`), `web` (`${NOODARA_IMAGE_PREFIX}/noodara-web:${NOODARA_VERSION}`, the only `ports:` entry in the file). `api`/`web` healthchecks use Node's global `fetch` (`node -e`) since `node:22-slim` has no `curl`/`wget`; `api`'s treats any 2xx (including `GET /health`'s 200 "degraded") as healthy, matching `health.ts`'s own D-26 intent. `worker`'s `stop_grace_period: 150s` is derived in a comment from `computeJobLockDurationMs`'s real 112s default (`connectMs*2 + 2000 + discoveryMs + 30000` with `env.ts`'s own defaults), not invented. Every credential/version/prefix/port interpolation uses `${VAR:?message}` so a missing or corrupted `.env` fails `docker compose config`/`up` loudly instead of silently starting a service with an empty password or an unversioned tag. `redis`'s healthcheck authenticates via `REDISCLI_AUTH="$$REDIS_PASSWORD" redis-cli ping`, not `redis-cli -a`, keeping the password out of that specific command's own argv (`--requirepass` on `redis-server` itself remains an accepted, documented exposure -- T-06-36).
- `docker-compose.dev.yml`: one-line fix -- `redis`'s `environment: REDIS_PASSWORD: ${REDIS_PASSWORD}` entry added, so its pre-existing `redis-cli -a $${REDIS_PASSWORD} ping` healthcheck (left otherwise untouched, per hard_rule's "keep that change minimal" instruction) can finally authenticate and report truthfully instead of unhealthy-forever.
- `tests/integration/installer/compose-stack.test.ts`: drives real `docker compose` as a child process (never Testcontainers) against locally built `apps/control-plane`/`apps/web` images and a `.env` generated by the real `noodara_generate_env` through `runInstallerShell` -- 2 test cases:
  1. **Main stack proof** -- `docker compose up -d --wait` reaches `postgres`/`redis`/`api`/`web` all `healthy` and `migrate` exited 0; `docker inspect` confirms redis's `State.Health.Status` is `healthy` directly (not inferred); only `web` publishes a host port, proven both via `docker compose ps`'s `Publishers` and via `docker compose config`'s own resolved `ports:` model; the `api` container's logs contain `NOODARA_SETUP_TOKEN=`; a second `up -d` leaves the `noodara_postgres_data`/`noodara_redis_data` volumes intact (same volume name before/after), re-runs `migrate` to a `0 migration(s) applied` no-op (log output accumulates across the in-place restart, confirmed empirically before writing the assertion), keeps every long-running service's own container ID unchanged (nothing recreated), and stays healthy; every `deploy.resources.limits.memory` is verified at least 2x the real `docker stats --no-stream` figure for that service (`migrate` excluded from the ratio check -- it has already exited by the time the stack is healthy, so 2x-of-zero would be vacuous -- but its limit is still asserted `>0`).
  2. **Admin-password passthrough proof** -- a second, independent compose project (own `.env`, generated with `NOODARA_ADMIN_EMAIL`/`NOODARA_ADMIN_PASSWORD` set to a synthetic fixture value `p@ss$word #1 "q"`) brings up only `api` and its transitive dependencies (`migrate`/`postgres`/`redis` -- `worker`/`web` never start, since `docker compose up <service>` only starts dependencies, not dependents), then `docker compose exec -T api node -e 'process.stdout.write(process.env.NOODARA_ADMIN_PASSWORD ?? "")'` confirms the value reaches the container's own process environment byte-for-byte identical to the fixture.
- Full suite: `pnpm test` 124 files / 1882 tests green; `pnpm typecheck`, `pnpm lint` clean; `docker compose -f docker-compose.dev.yml config` (output discarded, never printed) still parses; `docker compose -f docker-compose.yml --env-file /dev/null config` fails loudly for a missing `NOODARA_IMAGE_PREFIX` (the intended `:?` behavior), matching the plan's own `<verify>` block's `|| true` expectation.

### Measured memory (final run, `docker stats --no-stream`, raw bytes)

```json
{"postgres":27336376.32,"redis":4886364.16,"api":71135395.84,"worker":51600424.96,"web":45833256.96}
```

In MiB: postgres 26.07, redis 4.66, api 67.85, worker 49.20, web 43.71. Across the several runs performed while iterating on this plan, the observed idle range was: postgres 26-38MiB, redis 4.6-16MiB, api 66-82MiB, worker 44-59MiB, web 41-59MiB. The committed limits (`postgres` 192M, `redis` 96M, `migrate` 192M, `api` 256M, `worker` 256M, `web` 256M -- 1248M total) carry at least 2x headroom over the HIGHEST observed sample for every measured service (in practice 3.1x-6x). These are idle-stack figures on a development machine (Docker 29.2, aarch64, 8GB VM), not a load test -- explicitly carried into Plan 06-15's real-VPS validation, not declared closed here.

## Task Commits

1. **Test-first (hard_rule #5 override of the plan's own task order):**
   - `73b7032` `test(06-07): add failing compose-stack integration test` -- confirmed RED: `ENOENT: docker-compose.yml` (the file did not exist yet)
2. **Task 1: Production `docker-compose.yml`**
   - `22758a0` `feat(06-07): add production docker-compose.yml` (Task 1 placeholder memory limits, 128M uniform; re-running the test at this point failed only at the `api` memory-limit assertion, `128M < 2x measured` -- confirmed before proceeding, the intended RED for Task 2's own inner cycle)
3. **Task 2: Stand the stack up and measure it**
   - `faad81b` `feat(06-07): set per-service memory limits from measured usage` (GREEN -- full suite passing with real, differentiated limits)
4. **Post-plan hardening (hard_rule #8, discovered while re-checking the checklist against the shipped file -- Rule 2, missing critical functionality):**
   - `6b8cfa5` `fix(06-07): fail loudly on a missing required compose variable` (`${VAR:?message}` on every credential/version/prefix/port)
   - `73c58a7` `fix(06-07): keep the redis password out of the healthcheck's own argv` (`REDISCLI_AUTH` instead of `-a`)
   - `377e0f2` `test(06-07): prove a tricky admin password reaches the api container` (the required-by-hard_rule proof the original plan text did not ask for explicitly)
   - `4b5ee83` `test(06-07): prove a second up recreates nothing unexpectedly` (container-ID stability, not just health)
   - `b8b54fc` `test(06-07): also assert port exposure via docker compose config` (hard_rule's own literal wording, in addition to the plan's `docker compose ps` check)
   - `28dd0b5` `fix(06-07): add missing explicit timeouts on cleanup docker spawns`

## Files Created/Modified

- `docker-compose.yml` - The production six-service topology
- `docker-compose.dev.yml` - One-line redis `environment: REDIS_PASSWORD` fix
- `tests/integration/installer/compose-stack.test.ts` - Real `docker compose` proof of the whole stack plus the admin-password-passthrough proof

## Decisions Made

See `key-decisions` in the frontmatter above.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 2 - Missing Critical] `${VAR:?message}` required-variable guards were absent from the initial `docker-compose.yml`**
- **Found during:** re-reading the orchestrator's own hard_rule #8 checklist against the already-committed Task 1/2 file
- **Issue:** Every credential and version/prefix/port interpolation (`POSTGRES_USER/PASSWORD/DB`, `REDIS_PASSWORD` x2, `NOODARA_IMAGE_PREFIX` x3, `NOODARA_VERSION` x3, `NOODARA_PORT`) used plain `${VAR}` with no required-value guard -- a missing or truncated `.env` would have started `postgres`/`redis` with an empty password, or resolved an image tag to a bare, unversioned string, instead of failing loudly.
- **Fix:** Every one of those interpolations now uses `${VAR:?<message>}`; verified with a real `docker compose config` run against an empty `--env-file /dev/null`, which now exits 1 naming the first missing variable, and re-verified the full stack still comes up correctly with a real `.env` present.
- **Files modified:** `docker-compose.yml`
- **Committed in:** `6b8cfa5`

**2. [Rule 2 - Missing Critical] Redis healthcheck exposed the password in its own argv**
- **Found during:** the same hard_rule re-check
- **Issue:** `redis-cli -a "$$REDIS_PASSWORD" ping` puts the password as a `redis-cli` command-line argument, visible via `ps`/`docker top` inside the container for the healthcheck's own brief execution window -- distinct from, and avoidable unlike, `redis-server --requirepass`'s own accepted argv exposure (T-06-36).
- **Fix:** `REDISCLI_AUTH="$$REDIS_PASSWORD" redis-cli ping` -- `redis-cli`'s own documented env-var convention, which never puts the password on that command's argv. Re-verified redis reports genuinely `healthy` via a real `docker inspect` with this form.
- **Files modified:** `docker-compose.yml`
- **Committed in:** `73c58a7`

**3. [Rule 2 - Missing Critical] No proof that a tricky admin password reaches the api container's real environment**
- **Found during:** the same hard_rule re-check
- **Issue:** hard_rule #8 explicitly requires proving, against a real running stack, that an admin password containing `$`, ` #`, a space and `"` -- written by the real `noodara_generate_env` -- reaches the `api` container's environment byte-for-byte. The original PLAN.md task text did not ask for this proof explicitly (it is a security-hardening requirement layered on by the orchestrator).
- **Fix:** Added a second, independent compose project/lifecycle within the same test file (own `.env`, admin creds set, only `api`+dependencies started) and a `docker compose exec -T api node -e 'process.stdout.write(process.env.NOODARA_ADMIN_PASSWORD ?? "")'` proof, byte-for-byte matched against the fixture.
- **Files modified:** `tests/integration/installer/compose-stack.test.ts`
- **Committed in:** `377e0f2`

**4. [Rule 2 - Missing Critical] Second-`up` safety was proven by health status only, not container identity**
- **Found during:** the same hard_rule re-check
- **Issue:** hard_rule #8 asks to prove "nothing recreated unexpectedly" on a second `up`, a distinct claim from "still healthy afterward" -- a service could in principle be torn down and rebuilt yet still end up healthy.
- **Fix:** Added a container-ID comparison (`docker compose ps`'s own `ID` field) for every long-running service, plus `migrate`, before and after the second `up`.
- **Files modified:** `tests/integration/installer/compose-stack.test.ts`
- **Committed in:** `4b5ee83`

**5. [Rule 2 - Missing Critical] Port-exposure was proven only via `docker compose ps`, not via `docker compose config` as hard_rule literally specifies**
- **Found during:** the same hard_rule re-check
- **Issue:** The plan's own `<behavior>` text names `docker compose ps --format json`; the orchestrator's hard_rule #8 separately specifies asserting via `docker compose config --format json`. Both are now checked and must agree.
- **Fix:** Added a `config`-model-based port assertion alongside the existing `ps`-based one.
- **Files modified:** `tests/integration/installer/compose-stack.test.ts`
- **Committed in:** `b8b54fc`

**6. [Rule 3 - Blocking/hygiene] Two cleanup `docker` spawns were missing an explicit timeout**
- **Found during:** a final scripted scan of every `execFileSync`/`spawnSync` call in the test file for a `timeout` option
- **Issue:** `docker rmi` and the final `docker ps`/`volume ls` stray-check calls in `afterAll` had no `timeout`, violating hard_rule #7's "explicit timeouts on every docker spawn" requirement (even though these are ordinarily fast, an unbounded call is still a hang risk).
- **Fix:** Added `timeout: CLI_TIMEOUT_MS` to all four call sites.
- **Files modified:** `tests/integration/installer/compose-stack.test.ts`
- **Committed in:** `28dd0b5`

**7. [Rule-11 reality-over-plan / test-file correction] A structural `ports:` indentation regex assumed 2-space service-key indentation, but this file uses 4-space nested-key indentation**
- **Found during:** the very first run of the committed test against the real `docker-compose.yml`
- **Issue:** The test's own `/^\s{2}ports:/gm` regex did not match the real file's `    ports:` (4 spaces, since `ports:` is nested one level under a 2-space service name).
- **Fix:** Corrected to `/^\s{4}ports:/gm`, confirmed against the real file (`grep -c 'ports:'` = 1, matching the plan's own literal acceptance command).
- **Files modified:** `tests/integration/installer/compose-stack.test.ts`
- **Committed in:** folded into `22758a0` (Task 1's own commit, before the first real RED/GREEN cycle)

---

**Total deviations:** 7 auto-fixed (6 Rule 2 - missing critical functionality required by the orchestrator's own hard_rules beyond the plan's literal text, 1 Rule 3/11 - test-file correction)
**Impact on plan:** All seven are necessary for correctness/security as explicitly required by the orchestrator's hard_rule #8 checklist; none change the plan's own six-service topology, healthcheck semantics, or memory-limit methodology. No scope creep beyond what hard_rule #8 itself specifies.

**Requirement:** `INST-01` intentionally NOT marked complete -- matching 06-03/06-04/06-05-SUMMARY.md's identical precedent. `INST-01` describes end-to-end installer behavior ("...con un solo comando... levanta api/worker/web/postgres/redis...") reachable only through the real `curl | sh` entrypoint; this plan built and proved the production Compose topology in isolation (D-18 layer 2: a real `docker compose up` against real images and a real generated `.env`), but `install.sh`'s `noodara_main` still does not call `docker compose up` at all -- that wiring is Plan 06-09's job. `REQUIREMENTS.md`'s `INST-01` checkbox remains `[ ]` (Pending).

## Issues Encountered

None beyond the deviations documented above. Docker hygiene held throughout every run: `docker ps -a --filter name=noodara-test-0607*`, `docker volume ls --filter name=noodara-test-0607*` and `docker images | grep noodara-test-0607` all confirmed empty after every run, including runs that failed mid-assertion (the placeholder-memory-limit RED run left zero stray resources). The developer's own `noodara-dev-postgres-1`/`noodara-dev-redis-1` containers (already stopped before this plan started) and the unrelated `nuestracasa-neon-proxy` container were never touched, started, or stopped.

## User Setup Required

None -- no external service configuration required.

## Next Phase Readiness

- `docker-compose.yml` is ready for Plan 06-09's `noodara_main` to write to `/opt/noodara/docker-compose.yml` and run `docker compose up -d` against, once preflight (06-02), Docker install (06-08), and `.env` generation (06-04) are all wired together in the real install flow.
- `tests/integration/installer/compose-stack.test.ts`'s two proof patterns (whole-stack lifecycle via child-process `docker compose`, and the `up <service>`-only-brings-up-dependencies trick for a targeted proof) are reusable by Plan 06-09's own end-to-end installer test and by Plan 06-10's DinD harness.
- Known follow-up (not a blocker): the memory limits are idle-stack figures on a development machine, explicitly not a load test -- Plan 06-15's real-VPS validation is where these numbers get a genuine production-traffic check.
- No blockers for Plan 06-08 (next plan in this phase's wave sequence, per `.planning/STATE.md`).

---
*Phase: 06-instalador-y-docker-compose*
*Completed: 2026-09-21*

## Self-Check: PASSED

All 4 created/modified files (`docker-compose.yml`, `docker-compose.dev.yml`, `tests/integration/installer/compose-stack.test.ts`, this SUMMARY) verified present on disk; all 9 task/fix commit hashes (`73b7032`, `22758a0`, `faad81b`, `6b8cfa5`, `73c58a7`, `377e0f2`, `4b5ee83`, `b8b54fc`, `28dd0b5`) verified present in `git log --oneline --all`.
