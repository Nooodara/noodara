# Deferred Items — Phase 1

Out-of-scope discoveries logged during plan execution (not fixed, per the
executor's scope-boundary rule: only fix issues directly caused by the
current task's own files).

## packages/domain's `test` script fails when run via `pnpm --filter` — RESOLVED in 01-04

- **Found during:** 01-03 Task 1, while fixing the identical bug in
  `apps/control-plane/package.json`'s own `test` script.
- **Issue:** `packages/domain/package.json`'s `test` script is
  `vitest run --project packages`. When pnpm runs this via
  `pnpm --filter @noodara/domain test`, Vitest's cwd is
  `packages/domain/`, where there is no local `vitest.config.ts` — it fails
  with `Error: No projects matched the filter "packages"` because it never
  finds the root config that defines the `packages` project.
- **Introduced in:** Plan 01-02 (`packages/domain/package.json`).
- **Not fixed here because:** `packages/domain/package.json` is not among
  01-03's `<files_modified>`; the root cause and file predate this plan.
- **Suggested fix:** add `--root ../..` to the script, mirroring the fix
  applied to `apps/control-plane/package.json` in 01-03 Task 1:
  `"test": "vitest run --root ../.. --project packages"`.
- **Verification of the pattern:** `pnpm --filter @noodara/control-plane
  test` now exits 0 with this fix; the root-level `pnpm test` (which runs
  `vitest run` from the repo root and was always correct) is unaffected
  either way and remains the primary CI/gate command.
- **Resolved:** Plan 01-04 was authorized by the orchestrator to fix this
  directly (it touches `packages/domain/package.json`'s sibling files in
  the same plan). Applied the identical `--root ../..` fix:
  `"test": "vitest run --root ../.. --project packages"`. Verified with
  `pnpm --filter @noodara/domain test` — exits 0 (3 test files, 107 tests).
