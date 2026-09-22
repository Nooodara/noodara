---
phase: 01-dominio-persistencia-y-autenticacion
plan: 03
subsystem: api
tags: [fastify, zod, pino, env-validation, encryption, control-plane]

# Dependency graph
requires:
  - phase: 01-dominio-persistencia-y-autenticacion
    provides: "packages/domain skeleton, root pnpm+Turborepo scaffold, shared tsconfig/eslint (Plan 01-02)"
provides:
  - "apps/control-plane (@noodara/control-plane): buildApp()/server.ts skeleton, GET /health proving Zod 4 route inference through @fastify/type-provider-zod"
  - "docs/adr/0001-fastify-zod-type-provider.md: pinned @fastify/type-provider-zod over the unscoped fastify-type-provider-zod, with evidence"
  - "apps/control-plane/src/env.ts: pure parseEnv()/loadEnv() fail-fast env validation covering every INST-06/D-04/D-05/D-07/D-08/D-09/D-11 rule, with a branded MasterKeyBase64 type"
  - "apps/control-plane/src/logger.ts: createLogger() with pino redact.paths (cookie/authorization/password/sshPassword/sshPrivateKey/*.credential/*.encryptedCredential/*.masterKey) and a writableForTests() capture hook"
  - "apps/control-plane/src/boot/master-key.ts: decodeMasterKey()/masterKeyFingerprint()/logMasterKeyWarning() implementing the D-12 boot warning"
  - "Stub route plugins (auth.ts, setup.ts, sessions.ts) registered in app.ts, owned exclusively by Plans 01-10/01-12/01-11"
affects: ["01-04", "01-07", "01-10", "01-11", "01-12", "01-13"]

# Tech tracking
tech-stack:
  added:
    - "@fastify/type-provider-zod 1.0.0 (pinned over fastify-type-provider-zod 7.0.0, see ADR 0001)"
    - "fastify 5.12.3, pino 10.3.1 in apps/control-plane"
  patterns:
    - "Fastify v5 requires `loggerInstance` (not `logger`) to accept a pre-built pino instance — `logger` only takes a plain options object or boolean"
    - "env.ts is a pure parseEnv(source)/loadEnv(source) pair: parseEnv never touches process.env (fully unit-testable), loadEnv is the only place that calls process.exit(1), and `export const env = loadEnv(process.env)` is the single process.env read site in the whole file"
    - "Vitest's 'apps' project seeds fixture env values via vitest.config.ts's per-project `env` option, since apps/control-plane/src/env.ts fail-fasts as a module-level side effect at import time — any test importing it (even indirectly) needs valid-shaped env vars already present in process.env before the import runs"
    - "Route plugin stubs use FastifyPluginCallback (not FastifyPluginAsync) to avoid a no-op async function tripping @typescript-eslint/require-await"

key-files:
  created:
    - docs/adr/0001-fastify-zod-type-provider.md
    - apps/control-plane/package.json
    - apps/control-plane/tsconfig.json
    - apps/control-plane/src/app.ts
    - apps/control-plane/src/server.ts
    - apps/control-plane/src/env.ts
    - apps/control-plane/src/env.test.ts
    - apps/control-plane/src/logger.ts
    - apps/control-plane/src/logger.test.ts
    - apps/control-plane/src/boot/master-key.ts
    - apps/control-plane/src/boot/master-key.test.ts
    - apps/control-plane/src/routes/health.ts
    - apps/control-plane/src/routes/auth.ts
    - apps/control-plane/src/routes/setup.ts
    - apps/control-plane/src/routes/sessions.ts
    - .planning/phases/01-dominio-persistencia-y-autenticaci-n/deferred-items.md
  modified:
    - vitest.config.ts (added fixture `env` block to the "apps" Vitest project)

key-decisions:
  - "Pinned @fastify/type-provider-zod (official fastify-org scope, v1.0.0) over the unscoped fastify-type-provider-zod (v7.0.0, turkerdev): identical exported surface (ZodTypeProvider/validatorCompiler/serializerCompiler), identical npm description string on both packages, both require Zod >=4.2 (project pins zod@4.6.1) — see docs/adr/0001-fastify-zod-type-provider.md"
  - "server.ts's env.js import and env.PORT usage were deferred from Task 1 to Task 2 (env.ts didn't exist yet in Task 1's file set); Task 1 shipped server.ts with a literal PORT=3000 placeholder so its own typecheck/lint gate could pass standalone, then Task 2 rewired it to `import './env.js'` first and `env.PORT`, matching the plan's INST-06 acceptance criterion (env -i node dist/server.js exits non-zero naming NOODARA_MASTER_KEY)"
  - "env.ts is hand-rolled validation (no Zod) rather than the Zod-schema sketch in RESEARCH.md's code example: the cross-field D-04 admin-pair rule, the 'never echo the received value' requirement, and per-variable custom requirement strings were simpler to guarantee correctly with plain functions than with Zod's per-field error-customization API"
  - "Fastify v5's `logger` constructor option does not accept a pre-built pino instance (only a plain options object or boolean) — discovered via a runtime FST_ERR_LOG_INVALID_LOGGER_CONFIG error when boot-testing app.ts; fixed by using the `loggerInstance` option per Fastify v5's migration guide"
  - "apps/control-plane's package.json `test` script needed `--root ../..` added to `vitest run --project apps`, because Vitest's cwd inside the package has no local vitest.config.ts and cannot resolve the `apps` project filter otherwise; the identical pre-existing bug in packages/domain's test script (from Plan 01-02) was left unfixed and logged in deferred-items.md since it is outside this plan's file scope"

patterns-established:
  - "Pattern: env.ts fail-fast module-level side effect + Vitest per-project env fixtures — any future apps/* package that reads a validated `env` singleton at import time must seed the same kind of fixture values in vitest.config.ts's per-project `env` block, or its test file's mere import will call process.exit(1) inside the test worker"

requirements-completed: [INST-06]

# Metrics
duration: 38min
completed: 2026-09-10
---

# Phase 1 Plan 3: Control-Plane Scaffold, Fail-Fast Env, Redacting Logger Summary

**Fastify 5 control-plane skeleton with `@fastify/type-provider-zod`-typed `GET /health`, a hand-rolled zero-default `parseEnv`/`loadEnv` covering the full INST-06/D-04/D-05/D-07/D-08/D-09/D-11 matrix, and a pino logger that redacts cookies/passwords/credentials and prints the D-12 master-key backup warning with only a SHA-256 fingerprint on every boot.**

## Performance

- **Duration:** ~38 min
- **Started:** 2026-09-10T13:41:00-06:00
- **Completed:** 2026-09-10T14:19:00-06:00
- **Tasks:** 3
- **Files modified:** 15 created (matches the plan's declared file list) + 1 deviation-tracking file created + 2 files modified (vitest.config.ts, pnpm-lock.yaml)

## Accomplishments
- Resolved RESEARCH Open Question 3 by comparing both Zod type-provider packages' current README/compatibility notes via Context7 and `npm view`; pinned `@fastify/type-provider-zod@1.0.0` with the decision recorded in `docs/adr/0001-fastify-zod-type-provider.md`.
- `apps/control-plane` scaffolded end to end: `buildApp()` (no `listen`, so `app.inject()` works for later integration tests), `server.ts` entrypoint, `GET /health` with a `z.object({ status: z.literal('ok'), version: z.string() })` response schema proving Zod 4 inference through the pinned provider, and three intentionally-empty route stubs (`auth.ts` → Plan 01-10, `setup.ts` → Plan 01-12, `sessions.ts` → Plan 01-11).
- `env.ts`: a pure `parseEnv(source)`/`loadEnv(source)` pair with zero `.default()`/`??`/`||` on any security-critical variable, covering every behavior in the plan's TDD matrix — master-key base64/32-byte shape, weak-secret and weak-DB-password rejection, the D-04 admin email/password pairing rule, the optional D-11 previous master key, and every D-05/D-07/D-08 tuning-knob default — verified with 28 unit tests and a live `env -i node dist/server.js` run that exits 1 printing `NOODARA_CONFIG_ERROR NOODARA_MASTER_KEY: ...`.
- `logger.ts` + `boot/master-key.ts`: pino `redact.paths` covering `req.headers.cookie`/`req.headers.authorization`/`req.body.password`/`sshPassword`/`sshPrivateKey` and `*.credential`/`*.encryptedCredential`/`*.masterKey` wildcards, plus `decodeMasterKey()`/`masterKeyFingerprint()`/`logMasterKeyWarning()` implementing D-12's exact sentence — verified with 10 unit tests (including a canary test with a fake credential and an OpenSSH private-key body) and a live boot that emitted exactly one `keyFingerprint` record and zero occurrences of the raw base64 key.
- Full command chain (`pnpm lint && pnpm typecheck && pnpm test && pnpm test:integration && pnpm exec turbo boundaries`) verified green after all three tasks: 44 unit tests, no boundary violations.

## Task Commits

Each task was committed atomically (TDD tasks have separate RED/GREEN commits):

1. **Task 1: Pin the Zod type provider and scaffold apps/control-plane** - `f630daf` (feat)
2. **Task 2 (RED): failing env.test.ts** - `3f5a55b` (test)
   **Task 2 (GREEN): implement env.ts** - `79be56b` (feat)
3. **Task 3 (RED): failing logger.test.ts/master-key.test.ts** - `d46712c` (test)
   **Task 3 (GREEN): implement logger.ts/boot/master-key.ts, wire app.ts** - `cfd24ef` (feat)
4. **Deviation fix: control-plane's `test` script `--root` flag** - `bcf34f2` (fix)

**Plan metadata:** _(final metadata commit follows this summary)_

## Files Created/Modified
- `docs/adr/0001-fastify-zod-type-provider.md` - Records the type-provider decision with npm/Context7 evidence
- `apps/control-plane/package.json` - `@noodara/control-plane`, fastify/pino/zod/type-provider deps, `db:migrate` placeholder for Plan 01-07
- `apps/control-plane/tsconfig.json` - Extends `@noodara/config/tsconfig.base.json`
- `apps/control-plane/src/app.ts` - `buildApp()`: registers 4 route plugins, wires `createLogger()` + `logMasterKeyWarning()`, never calls `listen`
- `apps/control-plane/src/server.ts` - `api` entrypoint: imports `./env.js` first, listens on `env.PORT`
- `apps/control-plane/src/env.ts` / `env.test.ts` - Fail-fast env validation (INST-06) and its 28-test suite
- `apps/control-plane/src/logger.ts` / `logger.test.ts` - Redacting pino logger factory + capture hook and its test suite
- `apps/control-plane/src/boot/master-key.ts` / `master-key.test.ts` - D-12 fingerprint/backup-warning module and its test suite
- `apps/control-plane/src/routes/health.ts` - Real route proving Zod 4 + type-provider inference
- `apps/control-plane/src/routes/{auth,setup,sessions}.ts` - Empty stubs for Plans 01-10/01-12/01-11
- `vitest.config.ts` - Added fixture `env` values to the "apps" Vitest project
- `.planning/phases/01-dominio-persistencia-y-autenticaci-n/deferred-items.md` - Logs the pre-existing identical `packages/domain` test-script bug, left unfixed (out of this plan's scope)

## Decisions Made
See `key-decisions` in the frontmatter for the five decisions with the most downstream impact (type-provider pin, server.ts/env.ts task-ordering split, hand-rolled env validation over Zod, Fastify v5's `loggerInstance` option, and the control-plane test-script `--root` fix).

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 3 - Blocking] server.ts's env.js import deferred from Task 1 to Task 2**
- **Found during:** Task 1
- **Issue:** The plan's Task 1 action text asks `server.ts` to `import './env.js'` as its first import, but `env.ts` is not created until Task 2 — writing that import in Task 1 would make Task 1's own `<verify>` (`typecheck && lint`) fail against a nonexistent module.
- **Fix:** Task 1 shipped `server.ts` with a literal `const PORT = 3000` placeholder and a comment pointing to Task 2; Task 2 replaced it with `import './env.js'` (first import) and `env.PORT`, matching Task 2's own acceptance criterion (`env -i node apps/control-plane/dist/server.js` exits non-zero naming `NOODARA_MASTER_KEY`).
- **Files modified:** apps/control-plane/src/server.ts
- **Verification:** `env -i node apps/control-plane/dist/server.js; echo $?` → exit 1, stderr starts with `NOODARA_CONFIG_ERROR NOODARA_MASTER_KEY: ...`
- **Committed in:** `f630daf` (Task 1 placeholder), `79be56b` (Task 2 wiring)

**2. [Rule 3 - Blocking] env.ts's module-level fail-fast side effect crashes the test worker without fixture env vars**
- **Found during:** Task 2
- **Issue:** `export const env = loadEnv(process.env)` at module scope means merely importing `env.ts` (as `env.test.ts` does, to get `parseEnv`) calls `process.exit(1)` if the real developer/CI shell doesn't have `NOODARA_MASTER_KEY` etc. set — which it doesn't, since those are boot-time secrets, not developer-machine env vars.
- **Fix:** Added a fixture `env` block (non-secret, obviously-fake values satisfying `parseEnv`'s shape checks) to the "apps" Vitest project in `vitest.config.ts`, using Vitest's documented `test.env` merge into `process.env` for that project's worker processes.
- **Files modified:** vitest.config.ts
- **Verification:** `pnpm exec vitest run apps/control-plane/src/env.test.ts` — 28/28 tests pass without the process being killed on import.
- **Committed in:** `79be56b`

**3. [Rule 1 - Bug] Acceptance-criteria regex for the `process.env.` grep check doesn't match the intended call site**
- **Found during:** Task 2
- **Issue:** The plan's literal acceptance check `grep -c "process.env\."` (escaped trailing dot) requires a literal `.` immediately after `env`, but the intended single call site is `loadEnv(process.env)` — which ends in `)`, not `.` — so the escaped-dot pattern matches 0 times, not 1, against correct code.
- **Fix:** Verified the *spirit* of the check instead: `grep -c "process\.env"` (no trailing-dot requirement) returns exactly 1, confirming there is only one `process.env` read site in the whole file (the `loadEnv(process.env)` call), matching the check's own stated intent ("only the loadEnv(process.env) call site"). No code was distorted to force a literal match against the mis-escaped pattern.
- **Files modified:** none (verification-only; follows the same precedent as Plan 01-02's Task 3 acceptance-count correction)
- **Verification:** `grep -v '^\s*//' apps/control-plane/src/env.ts | grep -c "process\.env"` → 1
- **Committed in:** n/a (verification step, not a code change)

**4. [Rule 1 - Bug] Fastify v5 rejects a pre-built pino instance via the `logger` option**
- **Found during:** Task 3
- **Issue:** `Fastify({ logger: createLogger() })` threw `FastifyError: logger options only accepts a configuration object` / `FST_ERR_LOG_INVALID_LOGGER_CONFIG` at boot — discovered by actually running the compiled entrypoint, not just typechecking (TypeScript's `FastifyInstance['log']` type didn't catch this, since the constructor option's runtime validation is stricter than its type).
- **Fix:** Switched to Fastify v5's `loggerInstance` constructor option (confirmed via Context7's Fastify docs and its v4→v5 migration guide), which is specifically for passing an already-constructed pino/logger instance.
- **Files modified:** apps/control-plane/src/app.ts
- **Verification:** Live boot with a valid environment now starts cleanly and emits exactly one `keyFingerprint` warn record plus the "Server listening" info records, with zero occurrences of the raw base64 master key in stdout.
- **Committed in:** `cfd24ef`

**5. [Rule 1 - Bug] control-plane's `test` script failed when run via `pnpm --filter`**
- **Found during:** post-Task-3 verification of the plan's own `<verification>` section
- **Issue:** `pnpm --filter @noodara/control-plane test` (script: `vitest run --project apps`) failed with `Error: No projects matched the filter "apps"` — Vitest's cwd when pnpm runs a per-package script is `apps/control-plane/`, which has no local `vitest.config.ts`, so it never finds the root config that defines the `apps` project.
- **Fix:** Changed the script to `vitest run --root ../.. --project apps`, pointing Vitest at the root config explicitly.
- **Files modified:** apps/control-plane/package.json
- **Verification:** `pnpm --filter @noodara/control-plane test` now exits 0 (3 test files, 38 tests). The identical bug in `packages/domain/package.json` (introduced by Plan 01-02, not part of this plan's files) was left unfixed and logged in `deferred-items.md` per the scope-boundary rule.
- **Committed in:** `bcf34f2`

---

**Total deviations:** 5 (2 blocking task-ordering/tooling fixes, 1 acceptance-criteria wording correction, 2 bug fixes). All were necessary for the plan's own acceptance criteria to pass or for genuinely correct runtime behavior; no scope creep beyond Tasks 1–3's declared `<files>` plus the two supporting-tooling fixes documented above.

## Issues Encountered

None beyond what is captured in Deviations from Plan above.

## User Setup Required

None - no external service configuration required. (`NOODARA_MASTER_KEY`, `BETTER_AUTH_SECRET`, `DATABASE_URL`, `REDIS_URL`, `NOODARA_PUBLIC_URL` are real deployment-time secrets; the installer that generates and writes them is Phase 6.)

## Next Phase Readiness
- `apps/control-plane` now exists with a working `buildApp()`/`server.ts` split that Plans 01-04, 01-07, 01-10, 01-11, 01-12, 01-13 build directly on top of; `routes/auth.ts`, `routes/setup.ts` and `routes/sessions.ts` are empty stubs those plans fill in without ever touching `app.ts` again.
- `env.ts`'s `Env` type is the single source of truth for every env-derived value later plans need (`NOODARA_SESSION_*`, `NOODARA_LOGIN_*`, `NOODARA_COOKIE_INSECURE`, `NOODARA_ADMIN_*`); those plans should import `{ env }` from `apps/control-plane/src/env.js`, never read `process.env` directly.
- `logger.ts`'s `createLogger()`/`writableForTests()` are ready for Plan 01-10's login-attempt logging and any future route that logs request/response bodies containing credentials.
- `boot/master-key.ts`'s `decodeMasterKey()` is the function Plan 01-05 (envelope encryption) and Plan 01-07 (migrations/CLI) should reuse rather than re-implementing base64 decoding.
- `pnpm --filter @noodara/control-plane {test,typecheck,lint,build}` and the root `pnpm {lint,typecheck,test,test:integration}` / `pnpm exec turbo boundaries` all exit 0 on the current repo state.
- Deferred: `packages/domain/package.json`'s `test` script has the same `--root` bug as control-plane's did before this plan's fix — see `deferred-items.md`. A future plan touching that file should apply the same one-line fix.

---
*Phase: 01-dominio-persistencia-y-autenticacion*
*Completed: 2026-09-10*

## Self-Check: PASSED

All 16 files declared in `key-files` were found on disk (`docs/adr/0001-fastify-zod-type-provider.md`, `apps/control-plane/{package.json,tsconfig.json,src/app.ts,src/server.ts,src/env.ts,src/env.test.ts,src/logger.ts,src/logger.test.ts,src/boot/master-key.ts,src/boot/master-key.test.ts,src/routes/{health,auth,setup,sessions}.ts}`, `.planning/phases/01-dominio-persistencia-y-autenticaci-n/deferred-items.md`, `vitest.config.ts`).

All 6 task commit hashes (`f630daf`, `3f5a55b`, `79be56b`, `d46712c`, `cfd24ef`, `bcf34f2`) resolve in `git log --oneline --all`.

Re-verified independently by the closeout executor: `pnpm lint`, `pnpm typecheck`, `pnpm test` (44/44), `pnpm test:integration`, `pnpm exec turbo boundaries` all exit 0; every acceptance-criteria grep/node check for Tasks 1-3 passes; `env -i node apps/control-plane/dist/server.js` exits 1 naming all five required variables; a live boot with a valid environment emits exactly one `keyFingerprint` warn record and zero occurrences of the raw base64 master key.
