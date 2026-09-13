# Deferred Items — Phase 02

Out-of-scope discoveries logged during plan execution, per the executor's scope-boundary rule
(pre-existing issues unrelated to the current task's changes are not auto-fixed).

## 02-01: `pnpm test --coverage`'s text/lcov report omits `packages/*` entirely

**Found during:** 02-01 Task 2/verification, while checking `pnpm test`'s coverage output still
measures `packages/domain/**` per QA-02.

**Observation:** `pnpm test --coverage`'s v8 text reporter output lists only `apps/control-plane/src`
rows; `packages/domain/src` and (now) `packages/ssh/src` never appear, despite
`coverage.include` in `vitest.config.ts` listing `packages/*/src/**/*.ts`. No threshold
pass/fail line is printed for `packages/domain/**` either — the reporter appears to treat the
`packages/*` glob as matching zero files, even though `packages/domain/src/*.test.ts` files run
and pass under the `packages` vitest project.

**Confirmed pre-existing:** reproduced identically with `vitest.config.ts` reverted to its
pre-02-01 (`de05d8f`, plan 01-16) content — same 56.75%/64.05%/56.31%/56.96% totals, same missing
`packages/*` rows. Not introduced by 02-01's alias/coverage.exclude changes (adding
`sshSourceAliases` and `'packages/ssh/src/testing/**'` to `coverage.exclude`).

**Impact:** QA-02's 95%/95% statement/branch threshold on `packages/domain/**` is not visibly
enforced by the text/lcov reporter's printed output, though `vitest.config.ts`'s
`coverage.thresholds` configuration is present and `pnpm test --coverage` still exits 0 (whether
that's because the threshold silently passes on an empty match set, or because thresholds on an
unmatched glob are a no-op, was not investigated further — out of scope for this plan).

**Not fixed here:** out of scope for 02-01 (a shared-config investigation, not something this
plan's tasks touch beyond the two additive changes already verified not to be the cause). Left for
a future plan or a dedicated QA-02 audit to investigate `@vitest/coverage-v8`'s glob-matching
behavior against the `projects` config's per-project `include` vs. the top-level `coverage.include`.
