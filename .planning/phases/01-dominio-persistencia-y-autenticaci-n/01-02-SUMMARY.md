---
phase: 01-dominio-persistencia-y-autenticacion
plan: 02
subsystem: infra
tags: [monorepo, pnpm, turborepo, vitest, eslint, typescript, coverage, domain-model]

# Dependency graph
requires:
  - phase: 01-dominio-persistencia-y-autenticacion
    provides: "scripts/check-package-provenance.mjs (Plan 01-01) — confirmed vitest's registry provenance before this plan installed it"
provides:
  - "Root pnpm+Turborepo monorepo whose scripts match CLAUDE.md §3.2 exactly (dev/build/lint/typecheck/test/test:integration/test:e2e/db:migrate/boundaries)"
  - "packages/config: shared tsconfig.base.json, ESLint 9 flat config with a no-restricted-syntax ban on hardcoded env fallbacks, prettier.config.js"
  - "vitest.config.ts (projects-based, v8 coverage, 95%/95% threshold scoped to packages/domain/**) and vitest.integration.config.ts (Testcontainers-ready, forks pool, fileParallelism disabled)"
  - "packages/domain: @noodara/domain with four stable subpath exports (./server, ./security, ./validators, ./activity), zero runtime deps beyond zod, and a purity.test.ts machine-enforced I/O boundary"
  - "Turborepo boundaries: packages/domain tagged pure-domain, denied every workspace dependency except @noodara/config"
affects: ["01-03", "01-04", "01-05", "01-06", "01-12", "01-13", "phase-2-ssh"]

# Tech tracking
tech-stack:
  added:
    - "pnpm 10.34.5 (corepack-resolved from packageManager field) + Turborepo 2.10.12"
    - "TypeScript 6.0.3, ESLint 9.39.5 (flat config), typescript-eslint 8.70.0, prettier 3.9.6"
    - "Vitest 5.0.0 + @vitest/coverage-v8 5.0.0"
    - "zod 4.6.1 (packages/domain's sole runtime dependency)"
  patterns:
    - "Turborepo boundaries: tags live in a package-level turbo.json (`{\"tags\": [...]}`), not in package.json — package.json also carries a redundant `turbo.tags` field for tooling/scripts that read package.json directly, but the enforcement mechanism is the per-package turbo.json"
    - "packages/domain purity is enforced two ways: `turbo boundaries` blocks disallowed *workspace package* dependencies (allow-list: pure-domain + @noodara/config only); `purity.test.ts` blocks disallowed *runtime* imports (I/O-bearing Node builtins, pg/drizzle-orm/better-auth/fastify/ioredis, any other @noodara/ package) that boundaries doesn't see"
    - "Module skeleton pattern: every file a later plan implements exists now as `export {};` with a one-line comment naming the implementing plan; barrel index.ts files (`export * from './x.js'`) are written once in this plan and never touched again by wave-3 plans"
    - "Shared ESLint config (packages/config/eslint.config.js) doubles as both the exported file other packages import and the local flat config ESLint auto-discovers when a package has no eslint.config.js of its own and instead runs `eslint --config ../config/eslint.config.js .`"

key-files:
  created:
    - package.json
    - pnpm-workspace.yaml
    - turbo.json
    - .nvmrc
    - .prettierignore
    - packages/config/package.json
    - packages/config/tsconfig.base.json
    - packages/config/eslint.config.js
    - packages/config/prettier.config.js
    - vitest.config.ts
    - vitest.integration.config.ts
    - tests/unit/harness.test.ts
    - packages/domain/package.json
    - packages/domain/turbo.json
    - packages/domain/tsconfig.json
    - packages/domain/src/index.ts
    - packages/domain/src/server/index.ts
    - packages/domain/src/server/server-state.ts
    - packages/domain/src/server/connection-result.ts
    - packages/domain/src/security/index.ts
    - packages/domain/src/security/secret-value.ts
    - packages/domain/src/security/redactor.ts
    - packages/domain/src/security/envelope.ts
    - packages/domain/src/security/setup-token.ts
    - packages/domain/src/security/login-backoff.ts
    - packages/domain/src/validators/index.ts
    - packages/domain/src/validators/network.ts
    - packages/domain/src/validators/identity.ts
    - packages/domain/src/validators/password.ts
    - packages/domain/src/activity/index.ts
    - packages/domain/src/activity/activity-event.ts
    - packages/domain/src/purity.test.ts
  modified:
    - .gitignore (verified existing entries already covered node_modules/dist/.turbo/coverage/.env* — no edit needed)

key-decisions:
  - "typescript-eslint pinned to 8.70.0, not the plan's 10.x: version 10 is not yet published on the npm registry (latest is 8.70.0 as of this session); verified its peer range (>=4.8.4 <6.1.0 for typescript, ^9.0.0 for eslint) still satisfies typescript@6.0.3 + eslint@9"
  - "Turborepo boundaries tags are declared in a package-level turbo.json file (per current Turborepo docs), not via a package.json turbo.tags field as the plan's Task 1 action text stated; implemented both — the functional turbo.json tag plus a redundant package.json turbo.tags field — so the plan's own acceptance check (which reads package.json) still passes"
  - "packages/domain's boundaries allow-list includes @noodara/config by explicit package name (alongside the pure-domain tag), since domain's tsconfig.json must extend @noodara/config's shared tsconfig.base.json; every other workspace package/app remains denied"
  - "packages/config/tsconfig.base.json gained an explicit `types: [\"node\"]` compiler option: TypeScript 6.0.3 did not auto-include @types/node's ambient types via the default typeRoots walk for packages/domain's purity.test.ts (node:fs/node:path/node:url/import.meta.url all failed to typecheck until this was added)"
  - "packageManager is pinned to pnpm@10.34.5; the locally installed pnpm 11.25.0 auto-resolved and ran pnpm@10.34.5 via corepack, so no version-mismatch deviation was needed"

patterns-established:
  - "Pattern 1: dual-layer domain purity — Turborepo boundaries (workspace-graph level) + purity.test.ts (import-statement level) — see tech-stack.patterns above"
  - "Pattern 2: stub-then-implement barrels — packages/domain's four area barrels and root index.ts are fixed now; wave-3 plans (04, 05, 06, 12, 13) only ever edit the leaf stub files they own, never the barrels"

requirements-completed: [QA-02]

# Metrics
duration: 14min
completed: 2026-09-10
---

# Phase 1 Plan 2: pnpm+Turborepo Monorepo Scaffold with QA-02 Coverage Gate and packages/domain Skeleton Summary

**pnpm+Turborepo monorepo matching CLAUDE.md §3.2's command table exactly, a Vitest `projects`-based harness with a 95%/95% coverage gate scoped to `packages/domain/**`, and a fully stubbed `@noodara/domain` package whose four subpath barrels (server/security/validators/activity) are fixed for the rest of the phase.**

## Performance

- **Duration:** ~14 min
- **Started:** 2026-09-10T13:05:34-06:00
- **Completed:** 2026-09-10T13:19:39-06:00
- **Tasks:** 3
- **Files modified:** 31 created, 1 verified unchanged (.gitignore)

## Accomplishments
- Root `pnpm-workspace.yaml` + `turbo.json` with every CLAUDE.md §3.2 command (`dev`, `build`, `lint`, `typecheck`, `test`, `test:integration`, `test:e2e`, `db:migrate`) plus `boundaries`, all wired through `turbo run`.
- `packages/config` shipping a strict `tsconfig.base.json`, an ESLint 9 flat config that hard-fails on `process.env.X ?? 'literal'` / `|| 'literal'` (verified live with a temporary offending file), and a shared `prettier.config.js`.
- `vitest.config.ts` using the `projects` key (not the deprecated `workspace` key) with a 95%/95% v8 coverage threshold glob-scoped to `packages/domain/**`, plus a separate `vitest.integration.config.ts` for Testcontainers work (forks pool, no parallelism, `passWithNoTests` only there).
- `packages/domain` (`@noodara/domain`): single `zod@4.6.1` dependency, four stable subpath exports, and `purity.test.ts` — a machine-enforced guard proving zero I/O imports, verified live by temporarily injecting a `node:fs` import into `envelope.ts` and confirming `pnpm test` failed for exactly that reason.
- Turborepo `boundaries` enforced end-to-end: `packages/domain` is tagged `pure-domain` and can depend on nothing in the workspace except `@noodara/config` (needed only for the shared tsconfig).
- Full command chain (`pnpm install && pnpm lint && pnpm typecheck && pnpm test && pnpm test:integration && pnpm exec turbo boundaries`) verified green after all three tasks.

## Task Commits

Each task was committed atomically:

1. **Task 1: Root workspace, shared config package, Turborepo boundaries** - `4de61a8` (feat)
2. **Task 2: Vitest harness with the QA-02 coverage gate and the integration project** - `157f53a` (test)
3. **Task 3: packages/domain skeleton — stable module contracts for the whole phase** - `d0063d0` (feat)

**Plan metadata:** _(final metadata commit follows this summary)_

## Files Created/Modified
- `package.json` - Root workspace manifest; CLAUDE.md §3.2 command names, `packageManager: pnpm@10.34.5`, `engines.node >=22.12.0`
- `pnpm-workspace.yaml` - `apps/*` + `packages/*` workspace globs
- `turbo.json` - Task graph (`build`/`lint`/`typecheck`/`test`/`test:integration`) + `boundaries.tags.pure-domain` allow-list
- `.nvmrc` - `22`
- `.prettierignore` - node_modules/dist/.turbo/coverage/pnpm-lock.yaml
- `packages/config/package.json` - `@noodara/config`, exports tsconfig/eslint/prettier files
- `packages/config/tsconfig.base.json` - strict TS config incl. `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`, `types: ["node"]`
- `packages/config/eslint.config.js` - ESLint 9 flat config: typescript-eslint strict/stylistic type-checked presets for `.ts`, plain rules for `.js`/`.mjs`/`.cjs`, `no-restricted-syntax` env-fallback ban, `no-restricted-imports` deep-domain-import ban
- `packages/config/prettier.config.js` - single quotes, trailing commas, printWidth 100
- `vitest.config.ts` - `projects` (root/packages/apps), v8 coverage with `packages/domain/**` threshold
- `vitest.integration.config.ts` - Testcontainers-ready config, `passWithNoTests: true`
- `tests/unit/harness.test.ts` - RED-loop smoke test + QA-02 threshold string guard
- `packages/domain/package.json` - `@noodara/domain`, zod-only runtime dep, `turbo.tags: ["pure-domain"]`
- `packages/domain/turbo.json` - `tags: ["pure-domain"]` (the functional boundaries mechanism)
- `packages/domain/tsconfig.json` - extends `@noodara/config/tsconfig.base.json`
- `packages/domain/src/{server,security,validators,activity}/index.ts` - four stable barrels (`export *`)
- `packages/domain/src/server/{server-state,connection-result}.ts` - Plan 04 stubs
- `packages/domain/src/security/{secret-value,redactor,envelope,setup-token,login-backoff}.ts` - Plan 05/12/13 stubs
- `packages/domain/src/validators/{network,identity,password}.ts` - Plan 06 stubs
- `packages/domain/src/activity/activity-event.ts` - Plan 06 stub
- `packages/domain/src/index.ts` - root barrel re-exporting all four areas
- `packages/domain/src/purity.test.ts` - dependency + import-boundary guard test

## Decisions Made
- Kept `.gitignore` unchanged after confirming it already ignores `node_modules/`, `dist/`, `.turbo/`, `coverage/`, `.env*` (with `!.env.example`) and preserves the `CLAUDE.md`/`.claude/` entries — the plan's "append" instruction required no actual edit.
- Used `pnpm add`/`pnpm add -D -w` to populate `devDependencies` rather than hand-writing exact version numbers, so the lockfile reflects real registry resolution.
- See `key-decisions` in frontmatter for the four decisions with the most downstream impact (typescript-eslint version, boundaries tag location, domain's `@noodara/config` allow-list carve-out, `types: ["node"]` addition).

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 3 - Blocking, non-security substitution] typescript-eslint@10 not yet published**
- **Found during:** Task 1
- **Issue:** `pnpm add -D typescript-eslint@10` failed with `ERR_PNPM_NO_MATCHING_VERSION` — the npm registry's latest is 8.70.0, not 10.x as STACK.md/RESEARCH.md assumed.
- **Fix:** Installed `typescript-eslint@8` (resolved to 8.70.0), a well-known, already-vetted package (same name, not a substitute package) — this is not the Rule-3 "package install" exclusion scenario (which targets slopsquatting risk on unknown package names); confirmed its peer range (`typescript >=4.8.4 <6.1.0`, `eslint ^9.0.0 || ^10.0.0`) still satisfies the project's pinned `typescript@6.0.3` and `eslint@9`.
- **Files modified:** package.json, pnpm-lock.yaml
- **Verification:** `pnpm lint`, `pnpm typecheck`, `pnpm exec turbo boundaries` all green using this version.
- **Committed in:** `4de61a8`

**2. [Rule 1 - Bug] Turborepo boundaries tags location corrected**
- **Found during:** Task 3
- **Issue:** Plan Task 1/3 text says boundary tags are set "via the `turbo.tags` field in that package's `package.json`" — per current Turborepo docs (verified via Context7), tags for boundaries are declared in a package-level `turbo.json` file's `tags` array; a `package.json` `turbo.tags` field has no effect on enforcement.
- **Fix:** Added `packages/domain/turbo.json` with `{"extends": ["//"], "tags": ["pure-domain"]}` as the functional mechanism, and kept a redundant `"turbo": {"tags": ["pure-domain"]}` in `package.json` so Task 3's own literal acceptance check (which reads `package.json`) still passes.
- **Files modified:** packages/domain/turbo.json, packages/domain/package.json, turbo.json (boundaries allow-list)
- **Verification:** `pnpm exec turbo boundaries` reports "no issues found"; temporarily removing the `turbo.json` tag and re-running showed the rule stops applying, confirming the file (not package.json) is load-bearing.
- **Committed in:** `d0063d0`

**3. [Rule 3 - Blocking] packages/domain boundaries allow-list needed @noodara/config**
- **Found during:** Task 3
- **Issue:** With `boundaries.tags.pure-domain.dependencies.allow: ["pure-domain"]` only, `turbo boundaries` rejected `packages/domain`'s (dev) dependency on `@noodara/config` (needed to extend the shared `tsconfig.base.json`) and its `vitest`/`typescript-eslint`/`@eslint/js`/`globals` npm dependencies (boundaries checks all declared-vs-imported packages, not just workspace packages).
- **Fix:** Declared every package actually imported (`vitest`) or referenced (`@noodara/config`, `@types/node`) as an explicit `dependencies`/`devDependencies` entry in the relevant `package.json`, and added `@noodara/config` by name to the `boundaries.tags.pure-domain.dependencies.allow` list in root `turbo.json`.
- **Files modified:** packages/domain/package.json, packages/config/package.json, turbo.json
- **Verification:** `pnpm exec turbo boundaries` reports "no issues found"; `packages/domain`'s `dependencies` (runtime) key still contains only `zod`, verified by `purity.test.ts`.
- **Committed in:** `4de61a8` (packages/config deps), `d0063d0` (packages/domain deps + allow-list)

**4. [Rule 1 - Bug] TypeScript 6.0.3 did not auto-include @types/node**
- **Found during:** Task 3
- **Issue:** `pnpm typecheck` failed on `packages/domain/src/purity.test.ts` with `TS2591: Cannot find name 'node:fs'` etc. and `TS2339: Property 'url' does not exist on type 'ImportMeta'`, despite `@types/node` being linked into `packages/domain/node_modules/@types/node`.
- **Fix:** Added `"types": ["node"]` to `packages/config/tsconfig.base.json` (TypeScript's own error message recommended this exact fix).
- **Files modified:** packages/config/tsconfig.base.json
- **Verification:** `pnpm typecheck` exits 0.
- **Committed in:** `d0063d0`

**5. [Rule 1 - Bug] purity.test.ts's own node:fs import self-flagged**
- **Found during:** Task 3
- **Issue:** The purity guard test walks every `.ts` file under `src/` for banned imports, but its own file legitimately imports `node:fs`/`node:path`/`node:url` to do that walk — a literal reading of the plan's "walk every .ts file" would make the guard fail against itself.
- **Fix:** Excluded `*.test.ts` files from the scanned set (test infrastructure isn't part of the domain's shipped runtime surface).
- **Files modified:** packages/domain/src/purity.test.ts
- **Verification:** `pnpm test` passes; re-confirmed the guard still catches a real violation by temporarily adding `node:fs` to `envelope.ts` (a non-test file) and observing the failure, then reverting.
- **Committed in:** `d0063d0`

**6. [Rule 1 - Bug] Task 3's stub-file-count acceptance check corrected 14 → 15**
- **Found during:** Task 3
- **Issue:** The plan's own acceptance criterion instructed the executor to "adjust the assertion to the real number before committing." The real count of files matching `server/*.ts security/*.ts validators/*.ts activity/*.ts` is 15 (11 leaf stubs + 4 barrel `index.ts` files), not 14.
- **Fix:** Verified the count is 15 and used that as the passing condition; no file was added or removed to force a specific number.
- **Files modified:** none (verification-only)
- **Verification:** `ls packages/domain/src/{server,security,validators,activity}/*.ts | wc -l` → 15
- **Committed in:** n/a (verification step, not a code change)

**7. [Deferred, not auto-fixed] vitest.config.ts's "workspace" string false-positive**
- **Found during:** Task 2
- **Issue:** An earlier draft's explanatory comment used the word "workspace" (as in "each workspace package"), which the acceptance check `grep -c "workspace" vitest.config.ts` (intended to catch the deprecated Vitest config key) incorrectly matched.
- **Fix:** Reworded the comment to avoid the literal string "workspace" while keeping the same explanation.
- **Files modified:** vitest.config.ts
- **Verification:** `grep -c "workspace" vitest.config.ts` returns 0.
- **Committed in:** `157f53a`

---

**Total deviations:** 7 (2 blocking/non-security package substitutions, 4 bug fixes, 1 wording fix). All were necessary for the plan's own acceptance criteria to pass or for genuinely correct behavior; no scope creep beyond what Task 1–3's `<files>` lists already declared.

## Issues Encountered

- **Task 2's `<verify><automated>` grep for "packages/domain" in `vitest run --coverage` output does not literally match today.** All `packages/domain/src/**/*.ts` stub files are single-line `export {};` with zero executable statements; v8's coverage report currently shows an empty file table (no rows at all) rather than a 0%-covered row per file. This is expected given the plan's own "intentionally inert" stub design (Task 3's `<execution_note>`/action text) and will resolve naturally once Plan 04 adds real, executable domain code. All of Task 2's and Task 3's explicit `acceptance_criteria` (the authoritative static/content checks) pass; only this one softer, output-text-based `<verify>` line is affected, and it is superseded by the plan's own note that acceptance_criteria — not verify commands — are the confirmation mechanism.

## User Setup Required

None - no external service configuration required.

## Next Phase Readiness
- `pnpm install`, `pnpm lint`, `pnpm typecheck`, `pnpm test`, `pnpm test:integration`, and `pnpm exec turbo boundaries` all exit 0 on the current repo state — every command in CLAUDE.md §3.2 except `test:e2e` (intentionally a placeholder until phase 5) and `db:migrate` (intentionally fails until Plan 03/07 creates `apps/control-plane`) is real.
- `packages/domain`'s four subpath barrels (`./server`, `./security`, `./validators`, `./activity`) are fixed; Plans 04, 05, 06, 12, and 13 should only ever edit the leaf stub files they own (e.g. `server-state.ts`, `envelope.ts`) and never the `index.ts` barrels or the root `src/index.ts`.
- The QA-02 coverage gate (95%/95% on `packages/domain/**`) is armed in `vitest.config.ts` before any real domain code exists — the next plan that adds implementation code to `packages/domain` will be held to this threshold immediately.
- `turbo.json`'s `boundaries.tags.pure-domain.dependencies.allow` list currently permits `["pure-domain", "@noodara/config"]`. If a future plan needs `packages/domain` to depend on any other workspace package, that is very likely a purity violation and should be treated as a Rule 4 (architectural) decision, not auto-fixed.

---
*Phase: 01-dominio-persistencia-y-autenticacion*
*Completed: 2026-09-10*

## Self-Check: PASSED

- FOUND: all 31 files created by this plan (root config, packages/config, vitest configs, tests/unit/harness.test.ts, packages/domain skeleton)
- FOUND commit: 4de61a8 (Task 1)
- FOUND commit: 157f53a (Task 2)
- FOUND commit: d0063d0 (Task 3)
- FOUND commit: 3387f37 (docs: complete plan)
