---
phase: 05-ui-web
plan: 10
subsystem: testing
tags: [playwright, e2e, testcontainers, nextjs, boot-process]

# Dependency graph
requires:
  - phase: 05-ui-web
    provides: "05-07's apps/web scaffold (same-origin proxy, ADR-0006 port/origin contract, NOODARA_API_ORIGIN fail-fast) and the pre-existing tests/integration/helpers/{postgres,redis,boot-process,ssh}.ts Testcontainers/boot-process fixtures this plan composes rather than reimplements"
provides:
  - "playwright.config.ts + tests/e2e/fixtures/stack.ts: a real Playwright harness that boots Postgres, Redis, the control-plane API, the worker and the built Next.js web app together, replacing the `echo ... && exit 0` test:e2e placeholder (QA-04)"
  - "tests/e2e/smoke.spec.ts: the first real E2E spec — unauthenticated /servers -> /login redirect and unauthenticated GET /api/servers -> 401 pass now; three login/sign-in behaviours are test.fixme, handed to Plan 05-11"
  - "apps/web/src/proxy.ts: the minimal unauthenticated-to-/login redirect (Next.js 16's proxy.ts convention), checked against the control plane's real GET /api/auth/get-session — a UX convenience only, never the actual authorization boundary"
affects: [05-11 (removes the three test.fixme markers and builds /login), 05-12 (authenticated shell, servers landmark), 05-13..05-19 (every later E2E spec tags onto this same harness/fixture), 05-20 (the full critical-path E2E and nightly 20x repetition build on this same stack.ts)]

# Tech tracking
tech-stack:
  added: ["@playwright/test@1.63.0", "@noodara/config (promoted to a root devDependency, workspace:*)"]
  patterns:
    - "tests/e2e/fixtures/stack.ts composes the exact same Testcontainers/boot-process helpers tests/integration/** already established (startPostgres, startRedis, buildValidBootEnv, spawnBootProcess, assertNoStrayTestContainers) — no parallel E2E-only implementation of any of that"
    - "startStack()/stopStack() keep the live process/container handles in a module-level singleton inside stack.ts itself, since Playwright's globalSetup/globalTeardown are both loaded via plain require/import in the same runner process, never a forked child (confirmed against Playwright's own runner source); global-setup.ts additionally persists the serializable {baseUrl, adminEmail, adminPassword} to a JSON file under test-results/ so a crashed run still leaves a debuggable record"
    - "Fixed ports throughout (API 3100, web 3000) per ADR-0006 — no OS-assigned port negotiation needed since nothing else on this stack shares those ports during a test run"
    - "apps/web/src/proxy.ts, not middleware.ts: Next.js 16.3.5 deprecated the middleware.ts file convention in favor of proxy.ts (same export shape, function renamed from middleware to proxy) — confirmed via a real `next build` warning and Next.js 16's own upgrade docs"

key-files:
  created:
    - playwright.config.ts
    - tests/e2e/tsconfig.json
    - tests/e2e/fixtures/stack.ts
    - tests/e2e/global-setup.ts
    - tests/e2e/global-teardown.ts
    - tests/e2e/smoke.spec.ts
    - apps/web/src/proxy.ts
  modified:
    - package.json
    - pnpm-lock.yaml
    - .gitignore

key-decisions:
  - "e2e:install runs `playwright install chromium` with no --with-deps flag, deviating from the plan's own literal Task 1 text ('playwright install --with-deps chromium') — the orchestrator's harness-hygiene instructions explicitly forbid --with-deps/sudo on this dev machine; --with-deps shells out to apt-get with elevated privileges to install OS-level libraries, which this session's explicit safety directive overrides the plan text to avoid"
  - "tests/e2e/tsconfig.json extends @noodara/config/tsconfig.base.json by package name (matching packages/domain/ssh/ui's own tsconfig.json precedent), not the relative-path style tests/integration/ssh/tsconfig.json uses — this required promoting @noodara/config to a root devDependency (workspace:*) so pnpm symlinks it into root node_modules, since only apps/web and the packages/* workspaces already depended on it directly"
  - "apps/web/src/proxy.ts (not middleware.ts): a real `next build` printed 'The middleware file convention is deprecated. Please use proxy instead' for Next.js 16.3.5; renamed the file and its exported function per Next.js's own migration guide before committing, rather than shipping a file the framework itself flags as deprecated on day one"
  - "The redirect proxy checks session by calling GET /api/auth/get-session (forwarding the incoming cookie header) rather than checking for a cookie's mere presence — Better Auth's cookie name/secure-prefix behavior is an internal detail this file should not need to track, and CLAUDE.md SS2.3 requires the real authorization decision to live in the backend; requireSession's 401 is the actual enforcement, this file is UX-only"

requirements-completed: []

# Metrics
duration: ~55min
completed: 2026-09-19
---

# Phase 5 Plan 10: Playwright E2E Harness and First Smoke Spec Summary

**Real Playwright harness (playwright.config.ts + tests/e2e/fixtures/stack.ts) that boots Postgres, Redis, the API, the worker and the built Next.js web app together, replacing the test:e2e placeholder — the first two smoke assertions (unauthenticated /servers -> /login redirect, unauthenticated GET /api/servers -> 401) pass for real against the real stack.**

## Performance

- **Duration:** ~55 min
- **Completed:** 2026-09-19
- **Tasks:** 3 (Task 3 split RED/GREEN into two commits per CLAUDE.md SS2.1)
- **Files modified:** 10 (7 new, 3 modified)

## Accomplishments

- `pnpm test:e2e` (`playwright test`) is a real Playwright invocation — no more `echo ... && exit 0`. `pnpm exec playwright test --list` lists all five specs; `pnpm test:e2e --grep @smoke` exits 0 (2 passed, 3 `test.fixme`d).
- `tests/e2e/fixtures/stack.ts` composed the real stack — confirmed with two full end-to-end runs (RED and GREEN) that each booted Postgres, Redis, the built control-plane API, the built worker, and the built Next.js web app (`next start --port 3000`), then tore all five down. `docker ps -aq --filter "label=noodara.test=true"` was empty after every run; `lsof -i :3000 -i :3100` showed no orphaned listeners.
- `apps/web/src/proxy.ts` adds the one piece of in-scope application code this plan's own truths require: an unauthenticated visit to any page other than `/login`/`/setup` redirects to `/login`, verified against the control plane's real `GET /api/auth/get-session` (forwarding cookies) rather than trusting a client-visible cookie's presence — the actual 401 enforcement stays entirely on `requireSession`, unchanged.
- RED/GREEN TDD cycle genuinely observed: the RED commit's real Playwright run (2.8 minutes, full stack boot) showed 4/5 failing (the unauthenticated-redirect assertion failed with `Received string: "http://localhost:3000/servers"` since no redirect existed yet; the three login-dependent tests timed out waiting for a form that doesn't exist); the GREEN commit's run showed 2 passed / 3 fixme'd, 0 failed.
- `pnpm install`, `node scripts/check-package-provenance.mjs` (22/22 OK, including `playwright`/`@playwright/test`@1.63.0), `pnpm typecheck` (now also covering `tests/e2e` via a new `tsc -p tests/e2e/tsconfig.json --noEmit` invocation), `pnpm lint`, `pnpm boundaries`, `pnpm build`, and `pnpm test` (1003 unit tests, unchanged count — `apps/web/src/proxy.ts` has no unit test of its own, covered instead by `smoke.spec.ts`'s first two E2E assertions) are all green.

## Task Commits

1. **Task 1: Install Playwright and write the stack fixture** - `a8aaed3` (feat)
2. **Task 2: Playwright config with global setup and teardown** - `1cc5a8e` (feat)
3. **Task 3 RED: failing smoke spec** - `4eb575d` (test)
4. **Task 3 GREEN: the unauthenticated-to-login redirect** - `5fe39b7` (feat)

## Files Created/Modified

- `playwright.config.ts` — `testDir: 'tests/e2e'`, `globalSetup`/`globalTeardown`, `workers: 1`, `fullyParallel: false`, `retries: 0`, `forbidOnly: !!process.env.CI`, `baseURL: 'http://localhost:3000'`, trace-on-first-retry, single chromium project
- `tests/e2e/tsconfig.json` — extends `@noodara/config/tsconfig.base.json` with `lib: ["es2023", "dom"]` added
- `tests/e2e/fixtures/stack.ts` — `startStack()`/`stopStack()`, composing `startPostgres`/`startRedis`/`buildValidBootEnv`/`spawnBootProcess`/`assertNoStrayTestContainers`; fixed ports 3100 (API) / 3000 (web) per ADR-0006; exports `E2E_ADMIN_EMAIL`/`E2E_ADMIN_PASSWORD` fixture constants
- `tests/e2e/global-setup.ts` / `tests/e2e/global-teardown.ts` — start/stop the stack once per suite run, handing off via a JSON file plus the module's own live-handle singleton
- `tests/e2e/smoke.spec.ts` — five `@smoke`-tagged behaviours; two pass, three `test.fixme`d pending Plan 05-11
- `apps/web/src/proxy.ts` — the minimal unauthenticated-to-`/login` redirect
- `package.json` — `test:e2e: "playwright test"`, `test:e2e:report`, `e2e:install` (chromium only), `@playwright/test@1.63.0` and `@noodara/config` (workspace:*) devDependencies, `typecheck` extended with the `tests/e2e` tsc invocation
- `pnpm-lock.yaml` — lockfile update for the above
- `.gitignore` — `playwright-report/`, `test-results/`, `blob-report/`

## Decisions Made

See `key-decisions` in frontmatter — summarized: `e2e:install` deliberately omits `--with-deps` per this session's explicit harness-hygiene override (never sudo/apt-get on the user's dev machine); `tests/e2e/tsconfig.json` uses the package-name `extends` style (matching `packages/*/tsconfig.json`), which required promoting `@noodara/config` to a root devDependency; the redirect file is `proxy.ts` (Next.js 16's current convention), not the deprecated `middleware.ts`; the redirect checks the real session endpoint rather than a cookie's presence.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 3 - Blocking] `stack.ts`'s `buildWorkspace()` call failed without `NOODARA_API_ORIGIN` set in the ambient shell**
- **Found during:** Task 3, first full RED run of `pnpm exec playwright test --grep @smoke`
- **Issue:** `buildWorkspace()` spawns `pnpm build` inheriting `process.env` as-is; `apps/web/next.config.ts` fails fast on a missing `NOODARA_API_ORIGIN` at build time (ADR-0006), and unlike CI (whose workflow-level env already sets it, per 05-07-PLAN.md), a plain local `pnpm test:e2e` invocation has no reason to have it exported in the shell already.
- **Fix:** `startStack()` now sets `process.env.NOODARA_API_ORIGIN` to the fixed API origin itself, immediately before calling `buildWorkspace()`.
- **Files modified:** `tests/e2e/fixtures/stack.ts`
- **Verification:** A clean-shell `pnpm exec playwright test --grep @smoke` (no `NOODARA_API_ORIGIN` pre-exported) builds and boots the whole stack successfully.
- **Committed in:** `4eb575d` (Task 3 RED commit)

**2. [Rule 1 - Bug] `apps/web/src/middleware.ts` used a file convention Next.js 16.3.5 already deprecates**
- **Found during:** Task 3 GREEN, the first `next build` after adding the redirect
- **Issue:** The build printed `The "middleware" file convention is deprecated. Please use "proxy" instead` — Next.js 16 renamed this network-boundary hook to `proxy.ts`/`export function proxy`, with `middleware.ts` kept only for edge-runtime-dependent use cases this project has no reason to opt into.
- **Fix:** Renamed the file to `apps/web/src/proxy.ts` and its exported function to `proxy`, per Next.js's own migration guide (confirmed via Context7 docs for `/vercel/next.js/v16.2.9`), before ever committing a file the framework itself flags as deprecated.
- **Files modified:** `apps/web/src/middleware.ts` (deleted) -> `apps/web/src/proxy.ts` (created)
- **Verification:** `next build` produces zero warnings; `pnpm --filter @noodara/web typecheck`/`lint` both exit 0; the redirect behaviour is unchanged (verified by the same two passing E2E assertions).
- **Committed in:** `5fe39b7` (Task 3 GREEN commit)

**3. [Rule 3 - Blocking] `@noodara/config/tsconfig.base.json` did not resolve from `tests/e2e/tsconfig.json`**
- **Found during:** Task 1's own verify command, `pnpm typecheck`
- **Issue:** `packages/domain`/`ssh`/`ui`/`apps/web`/`apps/control-plane` all extend `@noodara/config/tsconfig.base.json` by package name because each already depends on `@noodara/config` directly, so pnpm symlinks it into that workspace's own `node_modules`. The root `tests/` directory resolves through root `node_modules`, which had no such symlink (no root-level dependency on `@noodara/config` existed before this plan) — `tsc` failed with `File '@noodara/config/tsconfig.base.json' not found`.
- **Fix:** Added `@noodara/config: workspace:*` as a root devDependency, mirroring the exact same promotion pattern already used for `drizzle-orm`, `ioredis`, `zod`, `bullmq`, `@noodara/domain` (STATE.md's own recorded precedent).
- **Files modified:** `package.json`, `pnpm-lock.yaml`
- **Verification:** `pnpm exec tsc -p tests/e2e/tsconfig.json --noEmit` exits 0; `pnpm typecheck` (full pipeline) exits 0.
- **Committed in:** `a8aaed3` (Task 1 commit)

---

**Total deviations:** 3 auto-fixed (1 Rule 1 deprecated-convention bug, 2 Rule 3 blocking gaps)
**Impact on plan:** All three were necessary to make the plan's own verification commands actually pass; none changed the plan's scope, architecture, or intent. The `NOODARA_API_ORIGIN` gap is the same class of "the previous placeholder only worked because nothing connected to it" issue already recorded twice in STATE.md for `apps/web` joining the shared build/dev task graph (05-07); this plan is simply the next caller of `buildWorkspace()` to hit it.

## Issues Encountered

`pnpm test:boot`/`pnpm test:integration` also require `NOODARA_API_ORIGIN` set in the ambient shell when run locally outside CI (their own `tests/integration/global-setup.ts` calls the same `buildWorkspace()`) — this is pre-existing since Plan 05-07 wired `apps/web` into the shared `build` task graph, not caused by this plan's diff, and out of this plan's scope per the deviation rules' scope boundary. Verified `NOODARA_API_ORIGIN=http://localhost:3100 pnpm test:boot` passes (6/6) and `NOODARA_API_ORIGIN=http://localhost:3100 pnpm build` is clean.

## User Setup Required

None — no external service configuration required. `@playwright/test@1.63.0` was already provenance-approved in `docs/adr/0000-package-legitimacy-approvals.md`'s Phase 5 additions table; this plan only performed the actual install. Chromium's browser binary was already cached on this machine (`~/Library/Caches/ms-playwright/chromium-1243`); `pnpm e2e:install` (no `--with-deps`) is the documented one-time-per-machine step for a fresh environment or CI.

## Next Phase Readiness

- `pnpm test:e2e` now genuinely drives a browser against a real stack — every later phase-5 screen plan (05-11 onward) adds specs to `tests/e2e/`, never harness infrastructure.
- **QA-04 stays Pending in REQUIREMENTS.md.** This plan builds the harness and proves its first two behaviours (auth redirect, 401 guard) — the full critical-path E2E (connect -> discover -> detail against a real sshd container) and the nightly 20x repetition are Plan 05-20's job, per this plan's own frontmatter/must_haves. Matches the same plan-frontmatter-artifact pattern already flagged in STATE.md for SERV-06 (04-01), DETL-02/QA-05 (05-01/05-02/05-03), UI-01/UI-02 (05-06 through 05-08). Re-verify QA-04 against Plan 05-20, not this checkbox.
- Plan 05-11's first task must remove the three `test.fixme` markers in `tests/e2e/smoke.spec.ts` once `/login` exists, per this plan's own instruction and 05-VALIDATION.md's T2/T3 rows for Plan 05-11.
- `E2E_ADMIN_EMAIL`/`E2E_ADMIN_PASSWORD` (exported from `tests/e2e/fixtures/stack.ts`) are the fixed fixture credentials every later E2E spec that needs an authenticated session should import, rather than re-deriving its own.
- The `stopStack`-owns-teardown discipline (web -> worker -> API -> Redis -> Postgres, each step individually guarded, ending in `assertNoStrayTestContainers()`) is the pattern later plans' specs inherit for free — they never manage stack lifecycle themselves.

---
*Phase: 05-ui-web*
*Completed: 2026-09-19*

## Self-Check: PASSED

Verified on disk: `playwright.config.ts`, `tests/e2e/tsconfig.json`, `tests/e2e/fixtures/stack.ts`,
`tests/e2e/global-setup.ts`, `tests/e2e/global-teardown.ts`, `tests/e2e/smoke.spec.ts`,
`apps/web/src/proxy.ts`. All four task commits (`a8aaed3`, `1cc5a8e`, `4eb575d`, `5fe39b7`)
confirmed present in `git log --oneline`. `pnpm install`, `node scripts/check-package-provenance.mjs`,
`pnpm typecheck`, `pnpm lint`, `pnpm boundaries`, `NOODARA_API_ORIGIN=http://localhost:3100 pnpm build`,
`pnpm test` (1003 tests) and `NOODARA_API_ORIGIN=http://localhost:3100 pnpm test:boot` (6/6) all green.
`pnpm test:e2e --grep @smoke` exits 0 (2 passed, 3 fixme), leaving no `noodara.test=true` container
and no orphaned listener on ports 3000/3100.
