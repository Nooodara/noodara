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

## 02-08: `tests/integration/ssh/contracts.test.ts`'s `.invalid`-TLD row now fails on this machine

**Found during:** 02-08's full-suite verification (`pnpm test:integration`), run after Task 2's
retry/mutex wiring commit — this file is untouched by 02-08 (last modified in plan 02-04,
`8c0f2b6`).

**Observation:** "a hostname under the .invalid TLD fails with the readyTimeout shape on this
resolver, not a fast ENOTFOUND (measured, ADR row 4)" now fails: `attempt.err.level` is
`'client-socket'`, not the `'client-timeout'` ADR 0004 measured and hard-coded as this test's
expectation. Reproduces in isolation (`vitest run --config vitest.integration.config.ts
tests/integration/ssh/contracts.test.ts -t "hostname under the .invalid TLD"`), no Docker
container involved, fails fast (~190ms) — consistent with the resolver on this machine now
returning a fast socket-level failure for `.invalid` instead of hanging for the configured
`readyTimeout`, the exact environment-dependence ADR 0004 documents in its own "Row 4 is a
genuine, measured surprise" section ("a real deployment's actual resolver behaviour determines
which of `HOST_UNRESOLVED` or `CONNECT_TIMEOUT` a bad hostname produces... not reachable via this
exact scenario on every environment").

**Confirmed pre-existing and unrelated to 02-08:** `git log` shows this file was last touched by
plan 02-04; none of 02-08's changes (`ssh2-adapter.ts`, `retry.ts`, `connection-mutex.ts`) are
imported by or related to this test's raw-`ssh2.Client` DNS-timeout spike. Full suite otherwise
green: 155/156 integration tests pass, 582/582 unit tests pass.

**Not fixed here:** out of scope per the scope-boundary rule (pre-existing failure in a file this
plan does not touch, caused by a local resolver/network change since 02-04 was authored, not by
02-08's code). Left for a future plan (or a dedicated re-run of 02-04's Wave-0 measurement) to
either loosen this test to accept both `'client-timeout'` and `'client-socket'` shapes, or to
re-verify against a resolver configuration matching the original measurement.
