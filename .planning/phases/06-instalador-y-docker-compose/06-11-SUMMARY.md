---
phase: 06-instalador-y-docker-compose
plan: 11
subsystem: infra
tags: [docker-in-docker, testcontainers, install-sh, cgroup-v2, docker-compose, awk, setup-token]

# Dependency graph
requires:
  - phase: 06-instalador-y-docker-compose
    plan: 09
    provides: "install.sh's fully wired noodara_main -- the real entrypoint this plan runs for the first time against a real daemon"
  - phase: 06-instalador-y-docker-compose
    plan: 10
    provides: "tests/integration/helpers/installer-dind.ts's startInstallerDind/runInstallSh/loadLocalImages -- the harness this plan drives with real production images instead of a stand-in alpine tag"
provides:
  - "tests/integration/installer/fresh-install.test.ts: real install.sh run on both Ubuntu 22.04 and 24.04 against real, locally built production images -- six-service stack healthy, the printed setup token proven byte-identical to the api container's own emitted token AND redeemed through the real panel proxy, sign-in proven with an HttpOnly cookie, .env mode 600, only web publishes a port, T-06-02 canary clean over real stdout/stderr/install.log (INST-01, INST-04)"
  - "tests/integration/installer/preseed-admin.test.ts: NOODARA_ADMIN_EMAIL/PASSWORD proven to create the admin directly with no token ever printed or logged, the pre-seeded admin proven to authenticate through the real panel proxy, the admin credentials proven absent from every stream/log, and the only-one-of-the-pair warning proven (INST-05)"
  - "tests/integration/installer/installer-scenario-helpers.ts: shared image-build/image-load/env-parsing/compose-ps-parsing/curl-through-panel/T-06-02-canary plumbing reused by both scenario files"
  - "install.sh: noodara_compose_json_field_for_service rewritten to track curly-brace depth instead of splitting on every literal \"}\" -- fixes a real bug that made health-checking silently fail against the genuine Compose v5.5.1 JSON shape"
  - "tests/integration/images/installer-dind-common/entrypoint.sh: cgroup v2 nesting fix (moby/moby's own hack/dind workaround) -- without it every real `docker compose up` inside the fixture failed at the runc layer, unrelated to install.sh itself"
affects: [06-12-preflight-scenarios, 06-13-ci-release, 06-14-docs, 06-15-real-vps-validation]

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "docker compose ps --format json parsing MUST track curly-brace depth, not split on every literal \"}\" -- the real Compose CLI's own Publishers array contributes a nested \"}\" for every service that exposes a container port (even one that publishes no HOST port), which alphabetically separates \"Service\" from \"Health\"/\"ExitCode\" under a naive RS=\"}\" split. A hand-crafted unit-test JSON fixture that omits Publishers entirely will never catch this -- fixtures must include it."
    - "A privileged Docker-in-Docker fixture on a cgroup v2 host needs an explicit nesting fix in its own entrypoint (move every process out of the root cgroup into a leaf subcgroup, then enable every controller on the root's own cgroup.subtree_control) BEFORE starting the nested dockerd -- without it, every real container start inside the fixture fails at the runc layer with \"cannot enter cgroupv2 ... with domain controllers -- it is in an invalid state\", regardless of anything install.sh does."
    - "A Next.js panel's own client-side UX redirect (GET / -> /login for an unauthenticated visitor) is not a proxy failure -- an installer-scenario HTTP proof of \"the panel serves the real app\" must hit an unredirected route (here, /login) rather than asserting a bare 200 on /."
    - "docker compose ps's Publishers array carries one entry PER BOUND ADDRESS FAMILY (0.0.0.0 and ::) for a single ports: mapping on a genuine Linux daemon -- \"exactly one Publishers entry\" is the wrong invariant for \"web publishes its one port\"; \"every entry targets the resolved port, and only web has any\" is the right one."

key-files:
  created:
    - tests/integration/installer/fresh-install.test.ts
    - tests/integration/installer/preseed-admin.test.ts
    - tests/integration/installer/installer-scenario-helpers.ts
  modified:
    - install.sh
    - tests/integration/images/installer-dind-common/entrypoint.sh
    - tests/unit/installer/main-flow.test.ts

key-decisions:
  - "Task 2 (preseed-admin.test.ts) extracted shared setup (image build/load, .env parsing, compose-ps parsing, curl-through-the-panel, T-06-02 canary) into installer-scenario-helpers.ts rather than duplicating fresh-install.test.ts's own plumbing, per the plan's own <action> instruction -- not one of the plan's declared files_modified, added as a Rule 2 addition and disclosed here."
  - "The T-06-02 canary checks the specific keys hard_rule #8 names (NOODARA_MASTER_KEY, BETTER_AUTH_SECRET, POSTGRES_PASSWORD, REDIS_PASSWORD, NOODARA_ADMIN_PASSWORD, plus DATABASE_URL/REDIS_URL's userinfo segment) rather than every .env value verbatim -- a blanket check would false-positive on NOODARA_PORT/NOODARA_VERSION/NOODARA_PUBLIC_URL, which are EXPECTED to appear in the installer's own summary output."
  - "INST-04's token-usability proof (redeem through POST /api/setup, then sign in) runs inside fresh-install.test.ts's own single it() rather than a separate test, since redeeming the token is also what proves /api/* genuinely reaches Fastify through the panel proxy -- one real HTTP round trip proves both plan behaviors at once."

requirements-completed: [INST-01, INST-04, INST-05]

# Metrics
duration: ~90min (context reads across 06-07/06-09/06-10-SUMMARY.md, install.sh, docker-compose.yml, the harness, setup/bootstrap-admin/proxy source, plus five real DinD investigation/fix cycles); task commits span 2026-09-21T10:30:19 - 2026-09-21T10:58:13 (~28min)
completed: 2026-09-21
---

# Phase 06 Plan 11: Real install.sh end-to-end against a real Docker daemon Summary

**The first genuine, non-stubbed run of `install.sh` against a real Docker-in-Docker daemon and the real production images: INST-01 (six-service stack healthy on both Ubuntu 22.04 and 24.04), INST-04 (the printed setup token proven byte-identical to what the api container emitted, then actually redeemed and signed in through the real panel proxy) and INST-05 (pre-seeded admin created with zero token ever printed, credentials proven absent from every stream and `install.log`, sign-in proven with an `HttpOnly` cookie) -- and, exactly as the objective predicted, two genuine bugs the stubbed unit-test layer could never have caught: a cgroup v2 nesting gap in the DinD fixture itself, and a real `install.sh` JSON-parsing bug that silently broke every health check against the actual Compose CLI's own output shape.**

## Performance

- **Duration:** ~90min total session (context reads across four prior plans' SUMMARYs, `install.sh`, `docker-compose.yml`, the DinD harness, `setup.ts`/`bootstrap-admin.ts`/`proxy.ts`; five real-DinD investigation/fix cycles including two full-fixture scenario runs and one standalone diagnostic script); the five task/fix/test commits span `2026-09-21T10:30:19` - `2026-09-21T10:58:13` (~28min)
- **Tasks:** 2 (plan) + 2 real, in-scope bugs discovered and fixed (hard_rule #11)
- **Files modified:** 6 (3 created, 3 modified)

## Accomplishments

- **Task 1 -- `fresh-install.test.ts` (INST-01/INST-04):** `describe.each(['22.04','24.04'])`, one real `install.sh` run per Ubuntu version against real, locally built `apps/control-plane`/`apps/web` images loaded into the fixture's own nested daemon with no registry (D-19), driven with `NOODARA_INTERNAL_IMAGE_PREFIX`/`NOODARA_VERSION`/`NOODARA_PUBLIC_URL`/`NOODARA_PORT` so the run needs no network access for Noodara's own artifacts. Proves: exit 0; `postgres`/`redis`/`api`/`web` all `Health: healthy` and `migrate` exited 0 via a real `docker compose ps -a --format json`; only `web` publishes a host port; `/opt/noodara/.env` mode `600`; the installer's printed token equals the LAST `NOODARA_SETUP_TOKEN=` line in the api container's own log history (byte equality, not merely both non-empty); the panel's `/login` route answers `200` with real HTML; the printed token is genuinely usable -- redeemed through a real `POST /api/setup` hitting the panel's `/api/*` proxy (proving both INST-04's usability requirement and that the proxy reaches Fastify at all in one round trip), followed by a real sign-in returning an `HttpOnly` session cookie; a T-06-02 canary confirms none of `NOODARA_MASTER_KEY`/`BETTER_AUTH_SECRET`/`POSTGRES_PASSWORD`/`REDIS_PASSWORD`/the `DATABASE_URL`/`REDIS_URL` userinfo ever reaches stdout, stderr or `install.log`, and the setup token occurs exactly once in stdout and never in `install.log`.
- **Task 2 -- `preseed-admin.test.ts` (INST-05, Ubuntu 22.04 only per the plan's own `<action>` text):** `NOODARA_ADMIN_EMAIL`/`NOODARA_ADMIN_PASSWORD` (a synthetic, policy-valid password containing a literal `$`, a space and `#1` -- the exact character classes 06-04's Finding B fix had to handle) proven written into `.env`, the summary states the admin was created from supplied credentials with NO token line and NO `NOODARA_SETUP_TOKEN=` anywhere in stdout OR in the api container's own log history (confirming `bootstrap-admin.ts` genuinely took the pre-seed branch, not merely that install.sh chose not to print one), the credentials proven absent from stderr and `install.log`, and a real sign-in through the panel proxy returns `200` with an `HttpOnly` cookie -- the lighter of the two login proofs the plan's own `<action>` text offers. A second `it()`, reusing the same already-built images in a fresh, independent fixture (since `noodara_is_installed` keys on `.env` existing), proves supplying only `NOODARA_ADMIN_EMAIL` produces the both-or-neither warning (naming both variable names, never a value) and still prints a normal setup token.
- **Shared helper (`installer-scenario-helpers.ts`, Rule 2 addition):** image build/load, `.env` parsing, `docker compose ps` NDJSON parsing (brace-aware, matching install.sh's own fixed logic independently), a curl-through-the-panel-proxy JSON request helper with header/body capture, `HttpOnly`-cookie detection, and the T-06-02 canary/setup-token-uniqueness assertions -- reused verbatim by both scenario files rather than duplicated.
- **Two real bugs found and fixed (hard_rule #11), both pinned by a test BEFORE the fix landed:**
  1. **DinD fixture cgroup v2 nesting gap** (`tests/integration/images/installer-dind-common/entrypoint.sh`) -- a genuine harness limitation (hard_rule #11c), not an `install.sh` defect.
  2. **`install.sh`'s `noodara_compose_json_field_for_service` silently returned nothing for every service with an exposed port** against the real Compose CLI's own JSON shape -- a genuine `install.sh` bug, fixed with a matching unit test in `tests/unit/installer/main-flow.test.ts` (hard_rule #11a).
- Full `pnpm test`: 126 files / 2091 tests green. `pnpm check:posix-sh`: clean (2100 lines). `pnpm typecheck`/`pnpm lint`: clean (includes `tests/integration/installer/tsconfig.json`).

## Task Commits

1. **Test-first (hard_rule #5):**
   - `a1fcbc5` `test(06-11): add failing fresh-install and preseed-admin scenario tests` -- confirmed RED: real `docker compose up` inside the fixture failed with runc's own `"cannot enter cgroupv2 ... with domain controllers -- it is in an invalid state"` (exit 51)
2. **Fixture fix (hard_rule #11c -- harness-only, not install.sh):**
   - `614d7d3` `fix(06-11): enable cgroup v2 nesting in the installer DinD fixture`
3. **install.sh bug found and pinned (hard_rule #11a):**
   - `244f024` `test(06-11): pin the real Compose Publishers-array JSON parsing bug` -- confirmed RED against the real Compose v5.5.1 JSON shape (recorded from an actual fixture run, not invented)
   - `939233b` `fix(06-11): track brace depth when parsing docker compose ps JSON` -- GREEN, full `pnpm test` re-verified
4. **Test-assertion corrections (Rule 1/11 -- the test's own two remaining wrong assumptions, not install.sh):**
   - `486110c` `test(06-11): correct two fresh-install assertions against real behavior`

_Every commit's message verified free of attribution trailers via `git log -1 --format=%B` after each commit._

## Files Created/Modified

- `tests/integration/installer/fresh-install.test.ts` -- INST-01/INST-04 real end-to-end scenario, both Ubuntu versions
- `tests/integration/installer/preseed-admin.test.ts` -- INST-05 real end-to-end scenario, Ubuntu 22.04
- `tests/integration/installer/installer-scenario-helpers.ts` -- shared plumbing both scenario files use
- `install.sh` -- `noodara_compose_json_field_for_service` rewritten with brace-depth tracking
- `tests/integration/images/installer-dind-common/entrypoint.sh` -- cgroup v2 nesting fix before starting the nested `dockerd`
- `tests/unit/installer/main-flow.test.ts` -- new case pinning the real Compose Publishers-array JSON shape

## Decisions Made

See `key-decisions` in the frontmatter above.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 11c -- fixture/harness bug, not install.sh] DinD fixture failed every real container start on a cgroup v2 host**
- **Found during:** Task 1's own RED confirmation run -- the very first real `docker compose up` inside the fixture
- **Issue:** `runc create failed: unable to start container process: unable to apply cgroup configuration: cannot enter cgroupv2 "/sys/fs/cgroup/docker" with domain controllers -- it is in an invalid state`. Every process in the privileged fixture container (including its own entrypoint shell) starts directly in the cgroup v2 root cgroup, which violates cgroup v2's "no internal process" constraint the instant the nested `dockerd`/`runc` tries to enable domain controllers for the per-container cgroups it creates. A genuine nested-cgroup limitation of the privileged-container harness itself (confirmed via a real, reproducible failure, not theorized), not a defect in `install.sh` or `docker-compose.yml`.
- **Fix:** Applied the standard, widely-documented Docker-in-Docker workaround (moby/moby's own `hack/dind` script): before starting `dockerd`, move every process out of the root cgroup into a leaf `init` subcgroup, then enable every available controller on the root's own `cgroup.subtree_control`.
- **Files modified:** `tests/integration/images/installer-dind-common/entrypoint.sh`
- **Verification:** Re-ran the identical scenario -- `docker compose up -d` succeeded and the stack reached a healthy state within ~19s (previously failed at container creation every time).
- **Committed in:** `614d7d3`

**2. [Rule 11a -- genuine install.sh bug, unit-tested] `noodara_compose_json_field_for_service` silently returned nothing for every service with an exposed port**
- **Found during:** Task 1, the second real run (after the cgroup fix) -- `install.sh` exited 53 (`health-check-failed`) even though `docker inspect` and `docker compose ps` both independently confirmed `api` was genuinely healthy
- **Issue:** The real Compose CLI (v5.5.1) emits a non-empty `Publishers` ARRAY OF OBJECTS for every service that exposes a container port -- true for every service in `docker-compose.yml` except the port-less `migrate` one-shot, including a service that publishes no HOST port at all (its one `Publishers` element still carries `"PublishedPort":0`). That nested object contributes its OWN `}` strictly before the record's own outer `}`. The OLD `RS = "}"` record splitter therefore cut every such record in two: alphabetically, `"Health"`/`"ExitCode"` sort before `"Publishers"` (landing in the FIRST fragment) and `"Service"` sorts after it (landing in the SECOND fragment) -- no single fragment ever matched both the `"Service"` pattern and the queried field, so the function silently returned nothing for `api`, `postgres`, `redis`, `worker` and `web` on every real run. This is exactly why `noodara_wait_for_health` polled for its full 300s timeout against a stack that was, per `docker inspect`, already healthy. The pre-existing unit-test fixtures for this function (`tests/unit/installer/main-flow.test.ts`) never included a `Publishers` array at all, so this gap was invisible at the unit layer -- exactly the class of bug this plan's own objective predicted ("everything before was proven against stubs").
- **Fix:** Rewrote `noodara_compose_json_field_for_service` to track curly-brace DEPTH character by character rather than splitting on every literal `}` -- a genuine record boundary is only the `}` that returns depth to 0. Still handles both JSON shapes Compose has shipped (NDJSON and a single array), since it operates on the whole byte stream rather than assuming one record per physical line.
- **Files modified:** `install.sh`, `tests/unit/installer/main-flow.test.ts`
- **Verification:** New unit test reproduces the REAL recorded JSON shape (captured from an actual fixture run, not hand-simplified) and confirmed RED against the old implementation before the fix; GREEN after. Full `pnpm test` (126 files / 2091 tests) and `pnpm check:posix-sh` re-verified green. Re-ran the real DinD scenario end to end: the stack now reaches healthy in ~19s and the installer exits 0.
- **Committed in:** `244f024` (RED), `939233b` (GREEN)

**3. [Rule 1 -- test-file correction, not install.sh] Two of `fresh-install.test.ts`'s own assertions were wrong**
- **Found during:** Task 1's third real run, after both bugs above were fixed
- **Issue:** (a) The real Compose CLI (inside this fixture's own genuine Linux daemon, unlike Docker Desktop's host-side proxy) emits ONE `Publishers` entry per bound address family (`0.0.0.0` and `::`) for `web`'s single `ports:` mapping -- the original assertion (`toBe(1)`, mirroring 06-07's own `compose-stack.test.ts` precedent) is the wrong invariant in a real Linux-daemon environment. (b) `GET /` correctly 307-redirects an unauthenticated visitor to `/login` (`apps/web/src/proxy.ts`'s own documented UX redirect, Plan 05-10) -- genuine app behavior, not a proxy failure; the original assertion expected a bare `200` on `/`.
- **Fix:** (a) Assert every `web` `Publishers` entry targets the resolved panel port, and every other service has zero, rather than counting entries. (b) Request `/login` (excluded from the redirect's own matcher) instead of `/`.
- **Files modified:** `tests/integration/installer/fresh-install.test.ts`
- **Verification:** Full scenario re-run, both Ubuntu versions, green.
- **Committed in:** `486110c`

---

**Total deviations:** 3 auto-fixed (1 Rule 11c fixture-only fix, 1 Rule 11a genuine `install.sh` bug with a pinning unit test, 1 Rule 1 test-file correction). No scope creep: no idempotency/re-run, preflight-matrix or no-Docker apt-install scenario was implemented (hard_rule #10 -- that is Plan 06-12's job); `install.sh` was touched ONLY for the one genuine, unit-pinned JSON-parsing bug, never to special-case the test environment and never weakening any security control.

## Issues Encountered

Both real bugs above ARE the "issues encountered" for this plan -- see Deviations. No other RED/GREEN iteration was needed beyond the two described cycles; the third and final full-scenario run (after all three fixes) passed both scenario files on the very first attempt.

## User Setup Required

None -- no external service configuration required.

## Next Phase Readiness

- `install.sh`'s health-checking is now proven correct against the REAL Compose CLI's JSON shape, not merely a hand-crafted fixture -- Plan 06-12's own preflight/idempotency/no-Docker scenarios inherit this fix for free (it lives in `install.sh` itself, not in a test file).
- `tests/integration/installer/installer-scenario-helpers.ts` is ready for Plan 06-12 to reuse for its own re-run/idempotency and preflight-matrix scenarios -- image build/load, `.env` parsing, `docker compose ps` parsing, the curl-through-the-panel helper and the T-06-02 canary are all already shared-module-ready.
- **Load-bearing fact for Plan 06-13 (CI release workflow) and any future DinD-based suite:** the cgroup v2 nesting fix in `tests/integration/images/installer-dind-common/entrypoint.sh` is required infrastructure for ANY real `docker compose up`/`docker run` inside this fixture, on any cgroup v2 host (confirmed: this development machine's own Docker Desktop 29.2 VM) -- CI runners on a cgroup v1 or hybrid host may not need it, but it is a no-op there (the `[ -f /sys/fs/cgroup/cgroup.controllers ]` guard only fires on a genuine unified-hierarchy host).
- Known follow-up (not a blocker, explicitly out of this plan's scope per hard_rule #10): the idempotent re-run, preflight-matrix and no-Docker apt-install scenarios are Plan 06-12's job; this plan's own fresh-install scenario always ran against a fixture with Docker pre-installed (`withDocker: true`, the default), so `install.sh`'s own real apt-repo Docker installation path was NOT exercised end-to-end here (it was already unit-tested at the shell layer in Plan 06-08, and 06-10's own harness proof used the `withDocker: false` variant for the plumbing only).
- No blockers for Plan 06-12.

---
*Phase: 06-instalador-y-docker-compose*
*Completed: 2026-09-21*
