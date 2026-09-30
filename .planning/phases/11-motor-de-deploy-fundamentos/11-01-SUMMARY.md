---
phase: 11-motor-de-deploy-fundamentos
plan: 01
subsystem: domain
tags: [deployment, state-machine, domain, tdd]
requires: []
provides:
  - "@noodara/domain/deployment subpath (DEPLOYMENT_STATUSES, NON_TERMINAL/TERMINAL tuples, transitionDeployment, DEPLOYMENT_ERROR_CODES, deriveServiceStatus, parseRepositoryFeatureProbe)"
affects: [11-05, 11-10, 11-11, 11-13]
tech-stack:
  added: []
  patterns: ["frozen tuple + satisfies transition table (server-state analog)", "closed-key line parser returning discriminated union"]
key-files:
  created:
    - packages/domain/src/deployment/deployment-state.ts
    - packages/domain/src/deployment/deployment-error.ts
    - packages/domain/src/deployment/service-status.ts
    - packages/domain/src/deployment/repository-features.ts
    - packages/domain/src/deployment/index.ts
    - packages/domain/src/deployment/*.test.ts (4)
  modified:
    - packages/domain/src/index.ts
    - packages/domain/package.json
    - vitest.shared.ts
decisions:
  - "isTerminalDeploymentStatus is derived from the transition table (no outgoing edges), so there is no second list to drift"
  - "Probe parser tolerates exactly one trailing newline; blank lines, spaces around '=', duplicates and unknown keys are unparseable"
  - "unsupportedRepositoryFeatureError labels features as 'Git LFS' / 'Git submodules' from a closed map"
metrics:
  duration: "~10 min"
  completed: 2026-09-29
  tasks: 3
  files: 13
---

# Phase 11 Plan 01: Deployment domain foundations Summary

Pure `@noodara/domain/deployment` module: seven-state Deployment FSM with an exhaustive 49-pair test, a closed 20-code error vocabulary, `deriveServiceStatus` (32-row table, UNKNOWN distinct from STOPPED) and an LFS/submodules probe parser that maps to `UNSUPPORTED_REPOSITORY_FEATURE`.

## Tasks

| Task | RED | GREEN |
|------|-----|-------|
| 1 Deployment state machine | 685e92e | 632e977 |
| 2 Error codes + deriveServiceStatus | 227f562 | 0a2ba34 |
| 3 Probe parser, subpath export, Vitest alias | e5463a2 | 25242e6 |

## Verification

- `pnpm exec vitest run packages/domain tests/unit/scripts/vitest-aliases.test.ts`: 25 files, 692 tests passed (includes purity.test.ts).
- Coverage `packages/domain/src/deployment/**`: 100% statements, 100% branches, 100% functions.
- `pnpm --filter @noodara/domain build` produces `dist/deployment/index.js`.
- `pnpm lint`, `pnpm typecheck`: green. `pnpm test`: 205 files, 3450 tests passed.

## Deviations from Plan

- The Task 3 RED test also imports `@noodara/domain/deployment` to assert the subpath re-exports, so the alias/exports wiring is itself test-driven. Not a behavior change.

Otherwise plan executed as written.

## TDD Gate Compliance

RED (`test(11-01)`) and GREEN (`feat(11-01)`) commits are separate for all three tasks. No refactor commits were needed.

## Self-Check: PASSED
