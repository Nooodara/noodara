# Quick 260928-m8j: fix clean-checkout CI failures — Summary

The first push of public main (50473ae) exposed two defects that only show on a clean checkout
(no pre-built `dist/`): CI's `unit` job failed 27 files with `Cannot find package
'@noodara/domain/preferences'`, and both CI's `site` job and `Publish site` failed `next build`
with `Can't resolve '@noodara/ui'`. Both are now fixed and structurally guarded against
recurrence.

## Root causes

1. **vitest.shared.ts alias drift.** `packages/domain/package.json` grew a `./preferences`
   subpath export (`exports` map resolves to `dist/`), but nobody added the matching Vitest
   source alias in `vitest.shared.ts`. Every in-process Vitest run therefore fell through to the
   real `exports` map, which points at a `dist/` a clean checkout never built.
2. **Site build bypassed Turbo's task graph.** Both `.github/workflows/ci.yml`'s `site` job and
   `.github/workflows/public-site.yml`'s `deploy` job (and the root `site:build` script they both
   call) ran `pnpm --filter @noodara/site build` directly — invoking `apps/site`'s own `build`
   script without going through Turbo's `dependsOn: ["^build"]` edge, so `@noodara/domain` and
   `@noodara/ui` were never built first on a checkout with no pre-existing `dist/`.

## Changes

### Task 1 — Alias every `@noodara/domain` subpath export to source in Vitest

- Added `tests/unit/scripts/vitest-aliases.test.ts`: reads the real `exports` maps of
  `packages/domain`, `packages/ssh`, and `packages/ui` package.json files, and asserts every
  JS/TS subpath export (object-shaped `{ types, default }` entries; string-shaped asset exports
  like `tokens.css`/`brand/*` are skipped) has a matching `find` entry in the corresponding
  `vitest.shared.ts` alias array whose `replacement` resolves to a real file on disk. This makes
  a forgotten alias for any future subpath export structurally impossible, not just a review
  habit.
- Added the missing `@noodara/domain/preferences` alias to `vitest.shared.ts`, pointing at
  `packages/domain/src/preferences/index.ts`, before the bare `/^@noodara\/domain$/` regex entry
  (same load-bearing ordering rule already documented for the other subpath aliases).

### Task 2 — Build the site through Turbo so workspace deps build first

- Changed the root `package.json` `site:build` script from `pnpm --filter @noodara/site build`
  to `turbo run build --filter=@noodara/site` (Turbo's `^build` edge in `turbo.json` then builds
  `@noodara/domain` and `@noodara/ui` first).
- Changed both `.github/workflows/ci.yml`'s `site` job and `.github/workflows/public-site.yml`'s
  `deploy` job to run `pnpm site:build` instead of `pnpm --filter @noodara/site build` directly.
- Extended `tests/unit/scripts/check-workflow-pins.test.ts` (structural, offline, no GitHub
  Actions run required) to assert both workflow steps use `pnpm site:build`, and that the root
  `package.json`'s `site:build` script is exactly `turbo run build --filter=@noodara/site`.
- `apps/site/README.md` already referenced `pnpm site:build` (not the direct filter form) — no
  change was needed there.

## TDD gates (git log)

| Gate | Task 1 | Task 2 |
|---|---|---|
| RED (`test(...)`) | `b8e83ea` | `da91386` |
| GREEN (`fix(...)`) | `d5e865b` | `e64f61c` |

Both RED commits fail for the documented reason (see clean-checkout evidence below); both GREEN
commits make the same tests pass without a pre-built `dist/`.

## Clean-checkout evidence

Reproduced against a real standalone clone of public main `50473ae`
(`pnpm install --frozen-lockfile`, no `dist/`, no `.next/`), never committed or pushed from.

### Task 1 — RED

```
$ pnpm vitest run apps/web/src/lib/appearance.test.ts packages/ui/src/ThemeToggle.test.tsx
FAIL |apps| apps/web/src/lib/appearance.test.ts
  Error: Cannot find package '@noodara/domain/preferences' imported from
  .../apps/web/src/lib/appearance.test.ts

FAIL |dom| packages/ui/src/ThemeToggle.test.tsx
  Error: Failed to resolve import "@noodara/domain/preferences" from
  "packages/ui/src/ThemeToggle.test.tsx". Does the file exist?

Test Files  2 failed (2)
```

### Task 1 — GREEN

Copied the fixed `vitest.shared.ts` (and the new `vitest-aliases.test.ts`) into the clone's
working tree, reran the same command:

```
$ pnpm vitest run apps/web/src/lib/appearance.test.ts packages/ui/src/ThemeToggle.test.tsx tests/unit/scripts/vitest-aliases.test.ts
Test Files  3 passed (3)
     Tests  15 passed (15)
```

### Task 2 — RED

```
$ pnpm --filter @noodara/site build
Module not found: Can't resolve '@noodara/ui'
Import trace:
  Server Component:
    ./apps/site/src/components/landing/SiteHeader.tsx
    ./apps/site/src/components/landing/Landing.tsx
    ./apps/site/src/app/page.tsx
 ERR_PNPM_RECURSIVE_RUN_FIRST_FAIL  @noodara/site@0.1.0 build: ...
Exit status 1
```

### Task 2 — GREEN

Copied the fixed `package.json`, both workflow files, and the updated test file into the clone's
working tree, then:

```
$ pnpm site:build
@noodara/site:build: check-export: 21 files, zero third-party assets
Tasks: 3 successful, 3 total
```

`$ pnpm vitest run tests/unit/scripts/check-workflow-pins.test.ts` — 35 passed, 0 failed, inside
the clean-checkout clone.

After each GREEN capture the clone's working tree was restored via `git -C $S checkout -- . &&
git -C $S clean -fdq -e node_modules` (scoped to the standalone clone only, never the monorepo).

## Final gate (monorepo, real numbers)

| Gate | Command | Result |
|---|---|---|
| Unit tests | `pnpm vitest run` | 201 test files, 3260 tests passed |
| Typecheck | `pnpm typecheck` | 9 tasks successful |
| Lint | `pnpm lint` | 10 tasks successful |
| Boundaries | `pnpm boundaries` | 840 files checked in 7 packages, no issues |
| Workflow pins | `node scripts/check-workflow-pins.mjs` (all 4 workflow files) | all clean |
| Site build | `pnpm site:build` | succeeded, `check-export: 21 files, zero third-party assets` |

## Deviations from Plan

None — plan executed exactly as written. The `apps/site/README.md` file listed in the plan's
`files_modified` needed no edit: it already referenced `pnpm site:build`, never the direct
`pnpm --filter @noodara/site build` form.

## Commits

- `b8e83ea` test(260928-m8j): assert vitest.shared.ts covers every domain/ui/ssh subpath export
- `d5e865b` fix(260928-m8j): alias @noodara/domain/preferences to source in Vitest
- `da91386` test(260928-m8j): require site build to run through pnpm site:build
- `e64f61c` fix(260928-m8j): build the site through Turbo so workspace deps build first

## Self-Check

- FOUND: `tests/unit/scripts/vitest-aliases.test.ts`
- FOUND: `vitest.shared.ts` (preferences alias present)
- FOUND: `tests/unit/scripts/check-workflow-pins.test.ts` (site:build assertions present)
- FOUND: `package.json` `site:build` = `turbo run build --filter=@noodara/site`
- FOUND: `.github/workflows/ci.yml` site job runs `pnpm site:build`
- FOUND: `.github/workflows/public-site.yml` deploy job runs `pnpm site:build`
- FOUND commit `b8e83ea`, `d5e865b`, `da91386`, `e64f61c` in `git log --oneline --all`

## Self-Check: PASSED
