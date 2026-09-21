---
phase: 05-ui-web
plan: 42
subsystem: ci-tooling-and-integration-harness
tags: [security, dx, supply-chain, integration-harness, gap-closure]
dependency-graph:
  requires: []
  provides:
    - "scripts/check-package-provenance.mjs's pnpm list and npm view execFileSync calls both fail within 30s instead of hanging until the CI security job's 40-minute backstop kills them"
    - "tests/integration/helpers/boot-process.ts's buildWorkspace() supplies a test-only NOODARA_API_ORIGIN default so pnpm test:boot / pnpm test:integration run on a clean local shell"
  affects:
    - "scripts/check-package-provenance.mjs"
    - "tests/integration/helpers/boot-process.ts"
    - "docs/adr/0003-runtime-entrypoints-and-module-resolution.md"
tech-stack:
  added: []
  patterns:
    - "execFileSync per-call timeout + explicit catch/rethrow for the no-fallback path (fail closed), vs. timeout landing in the existing catch for the has-fallback path (npm view -> registry API)"
    - "Test-harness-only env default via `process.env.X ?? 'literal'` spread into a spawned child's env, kept out of any apps/** production fail-fast path"
key-files:
  created:
    - tests/unit/scripts/check-package-provenance-timeout.test.ts
    - tests/unit/integration-helpers/boot-process-build-env.test.ts
  modified:
    - scripts/check-package-provenance.mjs
    - tests/integration/helpers/boot-process.ts
    - docs/adr/0003-runtime-entrypoints-and-module-resolution.md
decisions:
  - "enumerateLockedDependencies's pnpm list catch rethrows a new Error naming the literal command string and 'timeout' instead of letting a bare ETIMEDOUT stack propagate, with no fallback (fails closed per T-5G-42-03)"
  - "resolvePackageProvenance's npm view timeout deliberately lands in its existing catch and takes the registry-API fallback — one slow/unreachable package must not fail the whole gate"
  - "buildWorkspace() spreads process.env and backfills NOODARA_API_ORIGIN only via ??, so an already-exported value (CI, or stack.ts's real stack origin) always wins; the default lives only in this test helper, never in apps/**"
metrics:
  duration: "~35min (includes two full monorepo builds and a real pnpm test:boot run)"
  completed: "2026-09-20"
---

# Phase 05 Plan 42: Gap closure round 2 — provenance-gate timeouts and local NOODARA_API_ORIGIN DX fix Summary

Closed two independent residuals from `05-VERIFICATION.md`'s `gaps_remaining`: GR-05 (`check-package-provenance.mjs` had no per-call subprocess timeout despite the original fix naming it explicitly) and F1 (a clean local shell without `NOODARA_API_ORIGIN` exported made `pnpm build`, `pnpm test:boot` and `pnpm test:integration` all fail in about two seconds, because `buildWorkspace()` spawned `pnpm build` with no explicit `env`).

## What Was Built

### Task 1 — Per-call timeouts on both `execFileSync` calls (GR-05)

**Baseline (before any change):** `node scripts/check-package-provenance.mjs` → `Coverage: 52/52 locked direct dependencies verified.`, wall clock `30.120s total`.

**RED:** Wrote `tests/unit/scripts/check-package-provenance-timeout.test.ts`, mocking `node:child_process`'s `execFileSync` to simulate a timeout deterministically (no real 30s wait, no network dependency). Ran it against the unmodified script and observed 3 of 3 new tests fail for the right reason:

```
AssertionError: expected 'Command failed' to contain 'pnpm list -r --depth 0 --json'
AssertionError: expected "vi.fn()" to be called with arguments: [ 'npm', …(2) ]
  - ObjectContaining { "timeout": 30000 }
  + { encoding: 'utf8', stdio: [...] }   // no timeout key at all

Test Files  1 failed | 116 passed (117)
     Tests  3 failed | 1501 passed (1504)
```

**GREEN:**
- `enumerateLockedDependencies()`'s `pnpm list -r --depth 0 --json` call gained `timeout: 30_000` and is now wrapped in a `try/catch` that rethrows an `Error` naming the literal command string and the word "timeout", explicitly with **no fallback** — a gate that cannot enumerate the locked tree must fail closed (T-5G-42-02/03).
- `resolvePackageProvenance()`'s `npm view <spec> repository.url` call gained `timeout: 30_000` plus a one-line comment: a timeout here lands in the existing `catch` and takes the registry-API fallback by design (T-5G-42-01) — one slow/unreachable package must not fail the whole gate.

Re-ran the RED test file: `Test Files 117 passed (117) / Tests 1504 passed (1504)`.

**Post-change script run 1 (transient, unrelated network flakiness):** `Coverage: 50/52` — `@eslint/js` and `ioredis` failed with `<unresolvable: fetch failed>` (the registry-API **fallback fetch** itself failed to reach `registry.npmjs.org`, not a timeout from this change), total wall clock `3:09.56` (the slow run was almost entirely `npm view` calls resolving slowly under whatever network condition existed at that moment, each bounded at 30s by the new timeout rather than hanging indefinitely).

**Post-change script run 2 (clean network):** `Coverage: 52/52 locked direct dependencies verified.`, wall clock `27.153s total` — confirms the timeout does not clip a healthy run and the run-1 failures were transient/environmental, not caused by this change (same code, same script, second run clean).

Acceptance checks:
- `grep -c "timeout: 30_000" scripts/check-package-provenance.mjs` → `2`.
- `git status --short .github` → empty (CI workflow untouched).
- `pnpm lint` → green (`turbo run lint`, 9/9 tasks; see "Lint coverage note" below).

Commit: `dce7e7f` — `fix(05-42): add per-call timeouts to provenance gate subprocess calls`.

### Task 2 — `buildWorkspace` supplies a test-only `NOODARA_API_ORIGIN` default (F1)

**RED — reproduced the defect literally, unset variable, real subprocess:**

`(unset NOODARA_API_ORIGIN; pnpm build)`:
```
@noodara/web:build: > Build error occurred
@noodara/web:build: Error: NOODARA_API_ORIGIN is required (the control plane origin apps/web proxies /api/* to, e.g. http://localhost:3100 in dev) -- set it before running next dev/build.
@noodara/web:build:     at readApiOrigin (next.config.compiled.js:24:15)
...
 Failed:    @noodara/web#build
 ERROR  run failed: command  exited (1)
EXIT_CODE=1
```

`(unset NOODARA_API_ORIGIN; pnpm test:boot)`:
```
⎯⎯⎯⎯⎯⎯ Unhandled Error ⎯⎯⎯⎯⎯⎯⎯
Error: pnpm build failed with exit code 1
 ❯ buildWorkspace tests/integration/helpers/boot-process.ts:189:11
 ❯ Object.globalSetup [as setup] tests/integration/global-setup.ts:19:3
...
EXIT_CODE=1
```

**GREEN implementation:** `buildWorkspace()` in `tests/integration/helpers/boot-process.ts` now builds an explicit `env` object — `{ ...process.env, NOODARA_API_ORIGIN: process.env.NOODARA_API_ORIGIN ?? 'http://localhost:3100' }` — and passes it to `spawnSync`. `process.env` is spread first, so `PATH`/`HOME` and any already-exported `NOODARA_API_ORIGIN` (CI's `env:` block, or `tests/e2e/fixtures/stack.ts`'s own real stack-origin assignment at line 108) always win; the `??` only backfills when nothing is set. Documented in the function's own doc comment (same voice as `buildValidBootEnv`'s existing note), naming the value's provenance (same `http://localhost:3100` used by `buildValidBootEnv` and both CI workflows) and stating explicitly that `apps/web/next.config.ts`, `apps/web/src/proxy.ts` and `apps/web/src/app/api/events/route.ts` are untouched (INST-06 intact).

Added a new "Local build env defaults for test harnesses (05-42, F1)" section to `docs/adr/0003-runtime-entrypoints-and-module-resolution.md` recording the rule in a few sentences, without restructuring the rest of the ADR.

**RED for the new unit test** (`tests/unit/integration-helpers/boot-process-build-env.test.ts`, mocking `node:child_process`'s `spawnSync`): rather than physically reverting the already-fixed real file (forbidden git operations aside, doing so mid-task would have been risky), the pre-fix behaviour was verified honestly via `git show HEAD:...` against the commit that predates this plan's changes — confirmed the old `buildWorkspace()` called `spawnSync('pnpm', ['build'], { cwd: repoRoot, stdio: 'inherit' })` with no `env` key at all, so the new test's `expect.objectContaining({ env: expect.objectContaining(...) })` assertions would have failed against it (asserting on a field that plain didn't exist). This is the RED evidence for that specific unit test; the RED evidence for the task's own behaviour (the actual defect) is the two literal command failures quoted above, captured before any implementation code was touched, as the plan's `<action>` block required.

**GREEN:** `pnpm test -- tests/unit/integration-helpers/boot-process-build-env.test.ts` and `tests/unit/scripts/check-package-provenance-timeout.test.ts` together → `Test Files 118 passed (118) / Tests 1507 passed (1507)`.

**Final proof — real `pnpm test:boot` run, variable unset, real subprocesses:**

```
(unset NOODARA_API_ORIGIN; pnpm test:boot)
...
@noodara/web:build: ✓ Compiled successfully in 591ms
...
 Test Files  1 passed (1)
      Tests  7 passed (7)
   Duration  58.41s (tests 99%, import 1%)
EXIT_CODE=0
```

**Production rule still intact — bare `pnpm build` still fails, re-checked after the fix:**

```
(unset NOODARA_API_ORIGIN; pnpm build)
@noodara/web:build: Error: NOODARA_API_ORIGIN is required (...)
 Failed:    @noodara/web#build
EXIT_CODE=1
```

Acceptance checks:
- `grep -c "NOODARA_API_ORIGIN" tests/integration/helpers/boot-process.ts` → `5` (≥3 required: the existing boot-env line/comment, the new build-env default line, and the explanatory doc comment).
- `grep -c "\.\.\.process\.env" tests/integration/helpers/boot-process.ts` → `1` (≥1 required).
- `git status --short apps` → empty. `git status --short .env.example turbo.json` → empty.
- `pnpm typecheck` → green (`turbo run typecheck` + the two explicit `tsc -p tests/integration/ssh/tsconfig.json` / `tsc -p tests/e2e/tsconfig.json` invocations, exit code 0).
- `pnpm lint` → green.

Commit: `756fa99` — `fix(05-42): buildWorkspace supplies a test-only NOODARA_API_ORIGIN default`.

## Commands run and pass counts

| Command | Result |
|---|---|
| `node scripts/check-package-provenance.mjs` (baseline, before change) | `Coverage: 52/52`, `30.120s` |
| `pnpm test -- tests/unit/scripts/check-package-provenance-timeout.test.ts` (RED) | 3 failed, 1501 passed (1504) |
| `pnpm test -- tests/unit/scripts/check-package-provenance-timeout.test.ts tests/unit/scripts/check-package-provenance.test.ts` (GREEN) | 1504/1504 passed |
| `node scripts/check-package-provenance.mjs` (post-change, run 1, transient network issue) | `Coverage: 50/52`, `3:09.56` — 2 fetch-fallback failures, unrelated to the timeout change |
| `node scripts/check-package-provenance.mjs` (post-change, run 2, clean) | `Coverage: 52/52`, `27.153s` |
| `(unset NOODARA_API_ORIGIN; pnpm build)` (RED) | exit 1, `NOODARA_API_ORIGIN is required` |
| `(unset NOODARA_API_ORIGIN; pnpm test:boot)` (RED) | exit 1, `buildWorkspace` threw `pnpm build failed with exit code 1` |
| `pnpm test -- tests/unit/integration-helpers/boot-process-build-env.test.ts` (GREEN) | 1507/1507 passed |
| `(unset NOODARA_API_ORIGIN; pnpm test:boot)` (GREEN, final proof) | 7/7 passed, exit 0 |
| `(unset NOODARA_API_ORIGIN; pnpm build)` (re-checked after fix, still fails by design) | exit 1, same error |
| `pnpm test` (full unit suite, final) | 1507/1507 passed |
| `pnpm lint` | green (`turbo run lint`, 9/9 tasks) |
| `pnpm typecheck` | green (`turbo run typecheck` + 2 root `tsc -p` invocations) |

`git status --short apps .github` empty throughout. `git diff --name-only` across both commits lists exactly the three `files_modified` paths from the plan's frontmatter plus two new test files (see Deviations).

## Deviations from Plan

### Auto-fixed Issues

None — no bugs, missing functionality, or blockers were found beyond what the plan's two tasks already targeted.

### Additive, TDD-mandated test files (not in `files_modified`)

**1. [Rule 2 — CLAUDE.md/skill `noodara-tdd` mandate] Added two unit test files not listed in the plan's `files_modified`**
- **Reason:** `CLAUDE.md` section 2.1 and the `noodara-tdd` skill make RED→GREEN→REFACTOR mandatory for every behaviour change that is unit-testable; the executor's own hard rule 7 repeats this. Both of this plan's tasks change real subprocess-call behaviour (a bounded timeout with two different failure semantics; an env-default with override precedence) that is deterministically testable by mocking `node:child_process`, so tests were required even though the plan's frontmatter only listed the three files each task's `<action>` touches directly.
- **Files added:** `tests/unit/scripts/check-package-provenance-timeout.test.ts` (Task 1), `tests/unit/integration-helpers/boot-process-build-env.test.ts` (Task 2).
- **Commits:** folded into `dce7e7f` (Task 1) and `756fa99` (Task 2) — each test file was written and shown to fail (RED) before its corresponding implementation change (GREEN), then committed together with that change per this executor's task-level (not test/fix-split) commit granularity.

### Pre-existing repo characteristic, noted for completeness

**2. [Out of scope, not a regression] Neither `pnpm lint` nor a direct per-package `eslint` invocation covers `tests/unit/**`, `tests/integration/**`, or `scripts/**`**
- **Found during:** Task 1, while double-checking lint coverage on the newly added test files.
- **Detail:** `pnpm lint` (`turbo run lint`) only runs each workspace package's own `eslint` task; there is no root `eslint.config.js`. A direct `eslint --config packages/config/eslint.config.js` invocation against any file under `tests/**` or `scripts/**` (including the pre-existing `tests/unit/scripts/check-package-provenance.test.ts`, confirmed with the same error) fails with `Parsing error: ... was not found by the project service` — typescript-eslint's project service only scans files declared in a package's own `tsconfig.json` `include`. This is a pre-existing repository characteristic (the original `check-package-provenance.mjs` and its existing test predate this plan and have the same gap), not introduced or worsened by this plan.
- **Action:** None taken — out of scope per the executor's scope boundary (only fix issues directly caused by this plan's own changes). `pnpm lint` itself — the actual acceptance-criteria command — stays green because it never attempts to lint these paths either way. Logged here rather than silently left unmentioned.

## Threat Model Coverage

All six threats in `05-42-PLAN.md`'s STRIDE register were addressed:
- T-5G-42-01 (DoS, `npm view` hang): `timeout: 30_000`; verified the timeout path lands in the existing catch/fallback via a mocked-timeout unit test.
- T-5G-42-02 (DoS, `pnpm list` hang, no fallback): `timeout: 30_000` plus the actionable rethrown error; verified by the mocked-timeout unit test asserting the message contains the literal command and "timeout".
- T-5G-42-03 (tampering, silent pass on empty enumeration): no fallback/retry added to the enumeration path — confirmed by code review of the diff (a plain `try/catch { throw }`, no alternate return).
- T-5G-42-04 (tampering, production-rule weakening): the `NOODARA_API_ORIGIN` default lives only in `buildWorkspace`'s spawned `env`; `git status --short apps` was checked empty, and a bare `(unset NOODARA_API_ORIGIN; pnpm build)` was re-run after the fix and still fails, quoted above.
- T-5G-42-05 (information disclosure, accepted): no new secret was introduced into the spawned build env — only a non-secret localhost URL, already used elsewhere; `spawnSync`'s `stdio: 'inherit'` behaviour is unchanged.
- T-5-42-SC (supply chain): no `package.json` or `pnpm-lock.yaml` change; nothing installed; `node scripts/check-package-provenance.mjs` was re-run twice as this plan's own verification (52/52 both clean runs).

## Known Stubs

None. No hardcoded empty values, placeholder text, or unwired data sources were introduced.

## Threat Flags

None — this plan only tightens two existing operational controls (a subprocess timeout, a test-harness env default) already covered by `05-42-PLAN.md`'s own threat model; no new network endpoint, auth path, file access pattern, or schema change was introduced.

## Self-Check: PASSED

- `scripts/check-package-provenance.mjs` — FOUND
- `tests/integration/helpers/boot-process.ts` — FOUND
- `docs/adr/0003-runtime-entrypoints-and-module-resolution.md` — FOUND
- `tests/unit/scripts/check-package-provenance-timeout.test.ts` — FOUND
- `tests/unit/integration-helpers/boot-process-build-env.test.ts` — FOUND
- Commit `dce7e7f` (Task 1, GR-05) — FOUND in `git log --oneline --all`
- Commit `756fa99` (Task 2, F1) — FOUND in `git log --oneline --all`
