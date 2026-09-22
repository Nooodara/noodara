---
phase: 06-instalador-y-docker-compose
plan: 05
subsystem: docker
tags: [dockerfile, nextjs-standalone, turbo-prune, testcontainers, non-root, same-origin-proxy]

# Dependency graph
requires:
  - phase: 06-instalador-y-docker-compose
    plan: 03
    provides: ".dockerignore, the pruner/installer/builder/runner Dockerfile shape and non-root user pattern, the tests/integration/installer/*.test.ts conventions (test-only tags, afterAll cleanup)"
  - phase: 05-ui-web
    provides: "apps/web/next.config.ts's readApiOrigin()/rewrites()/headers() contract (ADR 0006), apps/web/src/proxy.ts's session-check redirect, apps/web/src/app/api/events/route.ts's SSE proxy"
provides:
  - "apps/web/next.config.ts: output: 'standalone' + explicit outputFileTracingRoot (resolved from import.meta.dirname, never process.cwd())"
  - "apps/web/Dockerfile: pruner/installer/builder/runner multi-stage image, node:22-slim, non-root nodejs system user, NOODARA_API_ORIGIN baked as BOTH a builder-stage build arg (consumed by next.config.ts's rewrites() at build time) and a runner-stage runtime ENV (consumed by proxy.ts and the SSE route handler at request time)"
  - "tests/integration/installer/web-image.test.ts: Testcontainers Network + withNetworkAliases('api') pattern for giving a container-under-test a literal DNS-resolvable service name -- reusable by Plan 06-07's own compose-shaped proof"
affects: [06-07-compose-production, 06-09-main-flow, 06-13-ci-release]

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "Next.js standalone monorepo layout: apps/web/.next/standalone/apps/web/server.js + apps/web/.next/standalone/apps/web/.next/static (nested, matching the source tree's own apps/web/ prefix, not the non-monorepo example's flat layout)"
    - "NOODARA_API_ORIGIN is baked TWICE in apps/web/Dockerfile: once as a builder-stage ARG/ENV (next.config.ts's rewrites(), evaluated once at next build) and once as a runner-stage ARG/ENV (apps/web/src/proxy.ts and apps/web/src/app/api/events/route.ts, both read process.env at request time) -- both come from the same single --build-arg flag, never two independently-settable values"
    - "Testcontainers Network().start() + .withNetwork(network).withNetworkAliases('api') on the api container gives the web container a real DNS-resolvable 'api' hostname matching the production docker-compose.yml service name, distinct from control-plane-image.test.ts's host.docker.internal/host-gateway pattern (which only reaches a host port, not a container-to-container alias)"
    - "Shared beforeAll/afterAll Testcontainers fixtures (api/postgres/redis/network) across multiple it() blocks in one describe must NOT call the stray-container assertion in afterEach -- only once in afterAll after every shared fixture has stopped, otherwise it misreports still-running shared fixtures as stray mid-suite"

key-files:
  created:
    - apps/web/Dockerfile
    - tests/integration/installer/web-image.test.ts
  modified:
    - apps/web/next.config.ts

key-decisions:
  - "apps/web/Dockerfile's runner stage re-declares ARG/ENV NOODARA_API_ORIGIN (not just the builder stage) -- discovered by reading apps/web/src/proxy.ts and apps/web/src/app/api/events/route.ts before authoring the Dockerfile, and confirmed empirically by web-image.test.ts's own RED run (an unauthenticated GET / 500'd with the builder-only version, because proxy.ts's synchronous NOODARA_API_ORIGIN-undefined check has no runtime value to read); this is additive to 06-RESEARCH.md's Pattern 8/10 guidance, which only documents the build-time rewrites() dependency"
  - "Negative-origin control uses a .invalid TLD (RFC 2606) baked at build time, not a wrong-port-same-host address, for a deterministic DNS-failure proof independent of any container being reachable"
  - "GET /api/config (guarded, requires session) chosen as the proxy-proof path over GET /health (unguarded but NOT under /api/*, so never reaches Next's rewrite) -- the real Fastify 401 body ({error: 'UNAUTHORIZED', message: ...}) is the evidence a Next 404 (HTML, no error field) cannot produce"
  - "assertNoStrayTestContainers() moved to run once in afterAll, after api/postgres/redis/network are all stopped, instead of per-test afterEach -- the shared fixtures are intentionally long-lived across all three it() blocks, so an afterEach check flags them as false-positive strays (found during this plan's own RED run)"

requirements-completed: []  # INST-01 spans all 15 plans of this phase; this plan delivers only the web image, not the installer flow that consumes it -- see 06-03-SUMMARY.md's identical framing.

# Metrics
duration: ~65min
completed: 2026-09-21
---

# Phase 06 Plan 05: Web Dockerfile — Next.js standalone with a baked API origin Summary

**Second published image: `apps/web/Dockerfile` ships a Next.js 16 standalone server (402MB, non-root) with `NOODARA_API_ORIGIN` baked as both a build-time constant (rewrites()) and a runtime env var (proxy.ts/SSE route) — the runtime half was undocumented in RESEARCH.md and only surfaced by running the real proxy test through two live containers.**

## Performance

- **Duration:** ~65min
- **Started:** ~2026-09-21T11:15:00Z (approximate)
- **Completed:** 2026-09-21T12:19:00Z
- **Tasks:** 3
- **Files modified:** 3 (2 created, 1 modified)

## Accomplishments

- `apps/web/next.config.ts`: added `output: 'standalone'` and an explicit `outputFileTracingRoot: path.join(import.meta.dirname, '../../')` (never `process.cwd()`). Verified the real emitted layout: `apps/web/.next/standalone/apps/web/server.js` plus `apps/web/.next/standalone/apps/web/.next/{BUILD_ID,server,...}` — static assets are NOT included by tracing and must be copied separately. `readApiOrigin()`, `rewrites()` and the phase-5 `headers()` security block are byte-identical apart from the two new keys and their explanatory comments.
- `apps/web/Dockerfile`: four-stage build (`pruner`/`installer`/`builder`/`runner`, all `node:22-slim`) mirroring `apps/control-plane/Dockerfile`'s shape exactly (`pnpm install --frozen-lockfile --ignore-scripts` before `turbo prune`, cache-friendly installer stage, non-root system user in the runner). `builder` stage bakes `NOODARA_API_ORIGIN` (no default — empty makes `readApiOrigin()` throw and the build fail loudly) into `next build`'s `rewrites()` manifest. **Runner stage also re-declares the same `ARG`/`ENV NOODARA_API_ORIGIN`** — a real runtime dependency this plan discovered by reading `apps/web/src/proxy.ts` and `apps/web/src/app/api/events/route.ts` (both call `process.env.NOODARA_API_ORIGIN` at request time, not build time), and confirmed empirically: the first version of this Dockerfile (builder-only, matching RESEARCH.md Pattern 10's literal snippet) made an unauthenticated `GET /` 500 in the real test. `apps/web/public/` correctly omitted (does not exist in this repo). Verified locally: build succeeds with `--build-arg NOODARA_API_ORIGIN=http://api:3000` (exit 0), fails loudly without it (exit 1, error names `NOODARA_API_ORIGIN`), `id -u` reports `999` (non-root), `apps/web/server.js` present at the documented path. **Final image size: 402MB.**
- `tests/integration/installer/web-image.test.ts`: 3 real-container test cases via `GenericContainer.fromDockerfile` + a Testcontainers `Network` with `.withNetworkAliases('api')` on a real `apps/control-plane` image container, proving: (1) `GET /api/config` on the web container is answered by the real Fastify app (401 `{error: 'UNAUTHORIZED', ...}`, not a Next.js 404), (2) `GET /` returns 200 (via `proxy.ts`'s real unauthenticated-session redirect to `/login`) with `X-Frame-Options: DENY` / `Referrer-Policy: no-referrer` intact, plus a real static asset (found by `docker exec find` inside the running container, not assumed from a host build) at 200, (3) a web image built with a deliberately unreachable (`.invalid` TLD) `NOODARA_API_ORIGIN` never answers `/api/config` with a 2xx. All 3 pass; `pnpm typecheck`, `pnpm lint`, `pnpm test` (1719 tests), `pnpm check:ui-safety` all green; `pnpm --filter @noodara/web build` still succeeds; no `noodara.test=true` container, image, or network survives the run.

## Task Commits

1. **Task 3 test file (RED, committed first per hard_rule 5's TDD ordering)** — `3325339` `test(06-05): add failing web image proxy test` (tdd="true", confirmed RED: `ENOENT: apps/web/Dockerfile`)
2. **Task 1: Standalone output and monorepo tracing root** — `add1fb3` `feat(06-05): emit standalone output for apps/web` (tdd="true" per frontmatter; see TDD Gate Compliance below)
3. **Task 2: apps/web/Dockerfile — standalone runner with a baked API origin** — `3919a32` `feat(06-05): add web Dockerfile with baked API origin`
4. **Fix: propagate NOODARA_API_ORIGIN to the web runtime + own test-suite bug** — `d83811f` `fix(06-05): propagate NOODARA_API_ORIGIN to the web runtime` (GREEN — full 3/3 suite passes after this commit)

## TDD Gate Compliance

Task 3's test file (`tests/integration/installer/web-image.test.ts`) was written and committed **before** Task 1 and Task 2's implementation, reordering the plan's own task sequence per hard_rule 5's explicit instruction ("if the plan's task order puts the Dockerfile first, reorder: write the test first"). Confirmed genuine RED: the test's `beforeAll` failed with `ENOENT: no such file or directory, open '.../apps/web/Dockerfile'` (`3325339`), since neither `apps/web/next.config.ts`'s standalone output nor `apps/web/Dockerfile` existed yet. Task 1 and Task 2 then landed as two `feat` commits (`add1fb3`, `3919a32`) implementing the config change and the Dockerfile. Running the full suite against that first Dockerfile version (matching RESEARCH.md Pattern 10's literal builder-only snippet) produced a genuine second RED signal — `GET /` 500'd — which is documented as a real auto-fix (Rule 1) in Deviations below, closed by `d83811f`. This differs from 06-03's plan, where the Dockerfile was already fully correct by the time its test was written (no RED reachable there); this plan's own task ordering plus the runtime-vs-build-time env distinction produced a real, reproducible RED→GREEN cycle for both the "Dockerfile doesn't exist" failure and the "proxy.ts crashes without a runtime env var" failure.

## Files Created/Modified

- `apps/web/next.config.ts` - Added `output: 'standalone'` + explicit `outputFileTracingRoot`; `readApiOrigin()`/`rewrites()`/`headers()` unchanged
- `apps/web/Dockerfile` - Four-stage production image: pruner, installer, builder (build-time `NOODARA_API_ORIGIN`), runner (non-root, standalone server + static assets + runtime `NOODARA_API_ORIGIN`)
- `tests/integration/installer/web-image.test.ts` - Real Testcontainers proof: proxy correctness, security headers, static assets, wrong-origin negative control

## Decisions Made

See `key-decisions` in the frontmatter above — the runtime-ENV discovery (the plan's single most significant deviation), the `.invalid`-TLD negative control, the `/api/config`-over-`/health` proxy-proof path choice, and the `afterEach`→`afterAll` stray-container-check fix.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 2 - Missing Critical] `apps/web/Dockerfile`'s runner stage must also set `NOODARA_API_ORIGIN` as a runtime `ENV`, not only a builder-stage build arg**
- **Found during:** Task 3 (full test-suite run after Tasks 1/2 landed)
- **Issue:** `apps/web/src/proxy.ts` (the Next.js 16 middleware convention, replacing `middleware.ts`) and `apps/web/src/app/api/events/route.ts` both call `process.env.NOODARA_API_ORIGIN` at request time, inside the running standalone server process — distinct from `next.config.ts`'s `rewrites()`, which is evaluated once at `next build` and baked into a manifest. 06-RESEARCH.md's Pattern 8/10 only documents the build-time dependency; the runtime one was discovered by reading both files before writing the Dockerfile, then confirmed for real: the first Dockerfile version (matching Pattern 10's literal builder-only snippet) made an unauthenticated `GET /` request 500 (`proxy.ts`'s synchronous `NOODARA_API_ORIGIN === undefined` check threw, since the runner stage's process env never had it).
- **Fix:** Re-declared `ARG NOODARA_API_ORIGIN` + `ENV NOODARA_API_ORIGIN=$NOODARA_API_ORIGIN` in the runner stage, sourced from the same single `--build-arg` flag the builder stage already consumes — not a second, independently-settable value.
- **Files modified:** `apps/web/Dockerfile`
- **Verification:** Re-ran `tests/integration/installer/web-image.test.ts` — `GET /` now returns 200 with the phase-5 security headers intact; all 3 tests pass.
- **Committed in:** `d83811f`

**2. [Rule 1 - Bug, in this plan's own test file] `assertNoStrayTestContainers()` misreported shared fixtures as stray**
- **Found during:** Task 3 (first full test-suite run)
- **Issue:** The test file called `assertNoStrayTestContainers()` in `afterEach`, copying `control-plane-image.test.ts`'s pattern — but that file starts/stops every container inside a single `it()`, while this suite deliberately shares the `api`/`postgres`/`redis`/`network` fixtures across all three `it()` blocks via `beforeAll`/`afterAll`. The `afterEach` check therefore found those still-running shared fixtures and failed every test on a false-positive "3 stray containers" assertion, even though the test's own real assertions had already passed.
- **Fix:** Moved the check into `afterAll`, after every shared fixture is explicitly stopped.
- **Files modified:** `tests/integration/installer/web-image.test.ts`
- **Verification:** Full suite reruns 3/3 green with zero `noodara.test=true` containers left after the run.
- **Committed in:** `d83811f`

---

**Total deviations:** 2 auto-fixed (1 missing critical functionality, 1 bug in this plan's own test file)
**Impact on plan:** Both fixes are necessary for correctness — deviation 1 closes a real runtime crash the plan's own RESEARCH.md did not anticipate; deviation 2 fixes a self-inflicted test bug, not production code. No scope creep beyond what Task 3's own `<action>` text anticipated ("fix whatever it exposes in the Dockerfile or next.config.ts").

## Issues Encountered

None beyond the two deviations documented above. Docker hygiene held throughout: `docker ps -a --filter label=noodara.test=true`, `docker network ls --filter label=noodara.test=true`, and `docker images` all confirmed empty after every run, including the failed RED runs.

## User Setup Required

None — no external service configuration required.

## Next Phase Readiness

- `apps/web/Dockerfile` is ready for Plan 06-07's production `docker-compose.yml` to reference directly, matching `apps/control-plane/Dockerfile`'s existing readiness from Plan 06-03.
- The Testcontainers `Network` + `.withNetworkAliases('api')` pattern this plan's test introduced is the mechanism Plan 06-07's own compose-shaped proof should reuse whenever it needs a container to resolve a literal Compose service name (`api`) rather than reaching a host-mapped port.
- **Load-bearing fact for Plan 06-07 and Plan 06-13 (the release workflow):** the production `docker-compose.yml`'s `web` service build/image step must set `NOODARA_API_ORIGIN` build-arg to the fixed literal `http://api:3000` — this single value is consumed by both `next.config.ts`'s `rewrites()` (build time) and `apps/web/src/proxy.ts`/`apps/web/src/app/api/events/route.ts` (runtime), so there is exactly one place to get this right, not two.
- Known follow-up (not a blocker): 402MB image size, smaller than `apps/control-plane`'s 1.22GB (06-03) since the standalone output excludes `devDependencies` and most of the monorepo's own tooling by construction — no action needed.

---
*Phase: 06-instalador-y-docker-compose*
*Completed: 2026-09-21*

## Self-Check: PASSED

All 3 files (`apps/web/next.config.ts`, `apps/web/Dockerfile`, `tests/integration/installer/web-image.test.ts`) verified present on disk with the described content; all 4 commit hashes (`3325339`, `add1fb3`, `3919a32`, `d83811f`) verified present in `git log --oneline --all`.
