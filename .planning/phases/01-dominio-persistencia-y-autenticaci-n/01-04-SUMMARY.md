---
phase: 01-dominio-persistencia-y-autenticacion
plan: 04
subsystem: domain
tags: [state-machine, vitest, ssh, server, coverage]

# Dependency graph
requires:
  - phase: 01-dominio-persistencia-y-autenticacion
    provides: "packages/domain skeleton, server-state.ts/connection-result.ts stubs, server/index.ts barrel, 95%/95% coverage gate scoped to packages/domain/** (Plan 01-02)"
provides:
  - "packages/domain/src/server/server-state.ts: SERVER_STATUSES, ServerStatus, TransitionReason, canTransition(), transition(), InvalidTransitionError, MissingTransitionReasonError — the single authority over Server status changes (SERV-05)"
  - "packages/domain/src/server/connection-result.ts: SERVER_ERROR_CODES, ServerErrorCode, ConnectionResult, ServerConnectionState, statusForErrorCode(), applyConnectionResult() — every SSH outcome phase 2 can produce mapped to exactly one status"
  - "docs/domain/server-state-transitions.md: committed mirror of the transition table (D-16), since .claude/ is gitignored"
  - "Reason-gated edges implementing D-13 (CONNECTED->DISCONNECTED requires clean_close), D-14 (CONNECTED->PENDING requires identity_changed), D-15 (ERROR->PENDING requires fingerprint_trusted, HOST_KEY_CHANGED parks pending_fingerprint)"
affects: ["phase-2-ssh", "01-07", "01-09", "phase-3-application-services", "phase-4-http-routes-worker"]

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "State machine as a frozen, fully-typed lookup table (Record<ServerStatus, readonly ServerStatus[]>) plus a mechanically-generated 36-pair cross-product test (SERVER_STATUSES x SERVER_STATUSES) — adding a state or widening an edge without a matching test/table update fails the suite (RESEARCH Pattern 4, D-16)"
    - "Reason-gated transitions: a small Partial<Record<`${From}->${To}`, Reason>> map layered on top of the boolean transition table, checked only after canTransition() already confirmed the edge exists — keeps 'is this edge allowed' and 'does this edge need justification' as two independent, separately-testable concerns"
    - "Domain functions that need wall-clock time take `now: Date` as an explicit parameter (applyConnectionResult) instead of calling Date.now() — keeps packages/domain pure and assertions deterministic without fake timers"
    - "Error classes for domain-level validation failures carry structured fields (from/to/requiredReason), not just a formatted message, so callers can map them to an HTTP response later without parsing strings"

key-files:
  created:
    - packages/domain/src/server/server-state.test.ts
    - packages/domain/src/server/connection-result.test.ts
    - docs/domain/server-state-transitions.md
  modified:
    - packages/domain/src/server/server-state.ts
    - packages/domain/src/server/connection-result.ts
    - packages/domain/package.json
    - .planning/phases/01-dominio-persistencia-y-autenticaci-n/deferred-items.md
    - .claude/skills/noodara-domain-model/SKILL.md (local only, gitignored — not committed)

key-decisions:
  - "MissingTransitionReasonError is thrown uniformly for 'no reason given' and 'wrong reason given' on a reason-gated edge — the required reason is exact-match, not merely present, since D-13/D-14/D-15 each pair one specific reason with one specific edge"
  - "applyConnectionResult's CONNECTING-only guard is enforced as an explicit early check, not delegated entirely to transition()'s table: CONNECTED->ERROR is a generally valid edge (server drops after being connected), but a connection *result* may only ever be applied while a connect attempt is in flight, so the guard throws InvalidTransitionError(state.status, targetStatus) before calling transition() when state.status !== 'CONNECTING'"
  - "TOFU capture on success only sets hostFingerprint when it was previously null (`state.hostFingerprint ?? result.fingerprint`) — a successful reconnect never overwrites an already-trusted fingerprint; that only happens through the explicit D-15 'Trust new fingerprint' path in a later phase"
  - "TRANSITIONS/ERROR_CODE_STATUS use `satisfies Record<K, V>` instead of an explicit type annotation combined with Object.freeze on the array literals — an explicit `Readonly<Record<...>>` annotation on an object of `Object.freeze([...])` arrays widens each array to `readonly string[]` and fails typecheck; `satisfies` keeps the literal narrowing while still checking full-key coverage against the target type"

patterns-established:
  - "Pattern: mechanically-generated exhaustive state-machine tests — SERVER_STATUSES.flatMap(...) x SERVER_STATUSES to build ALL_PAIRS, then it.each over that array with a hand-written ALLOWED_EDGES list as the test's own independent expectation; any future Deployment (v0.3) or other state machine should reuse this shape rather than hand-enumerating invalid pairs"

requirements-completed: [SERV-05, QA-02]

# Metrics
duration: 14min
completed: 2026-09-10
---

# Phase 1 Plan 4: Server Connection State Machine and Connection-Result Mapping Summary

**Frozen 6-state transition table (13 of 36 ordered pairs allowed) with three D-13/D-14/D-15 reason-gated edges, plus a pure connection-result-to-status mapping that routes every change through the state machine and parks a changed host key instead of trusting it.**

## Performance

- **Duration:** ~14 min
- **Started:** 2026-09-10T15:04:00-06:00
- **Completed:** 2026-09-10T15:17:44-06:00
- **Tasks:** 2 (both TDD)
- **Files modified:** 3 created, 5 modified (1 of the 5 — the local skill file — is gitignored and not committed)

## Accomplishments
- `server-state.ts`: `SERVER_STATUSES` (6-entry `as const` tuple), `canTransition()`/`transition()` as the only path to a new `ServerStatus`, `InvalidTransitionError`/`MissingTransitionReasonError` carrying `from`/`to` fields, and a frozen `TRANSITIONS` table with exactly 13 allowed edges out of the full 36-pair cross-product.
- `server-state.test.ts`: the cross-product (`SERVER_STATUSES x SERVER_STATUSES`) generated mechanically, asserted against a hand-written `ALLOWED_EDGES` list, for both `canTransition()` and `transition()` (valid pairs return the target status; invalid pairs throw `InvalidTransitionError` with the exact `Invalid transition: <FROM> -> <TO>` message) — 81 tests total, including explicit self-transition, reason-gated-edge, and error-field tests.
- `connection-result.ts`: `SERVER_ERROR_CODES` (7 codes), `statusForErrorCode()` as a table over every code, and `applyConnectionResult()` — pure, takes `now: Date` explicitly, only accepts a result while `status === 'CONNECTING'`, and returns a new object routed through `transition()`.
- `connection-result.test.ts`: table-driven `statusForErrorCode` assertions over `SERVER_ERROR_CODES`, TOFU-capture and already-trusted-fingerprint success cases, the `HOST_KEY_CHANGED` → `pendingFingerprint` parking case (D-15), a non-`CONNECTING`-source `InvalidTransitionError` case for every other status, and a deep-frozen-input purity/no-mutation test — 23 tests total.
- `docs/domain/server-state-transitions.md` created as the committed, versioned mirror of the transition table (states, allowed edges, the three reason-gated edges with their governing decision, and the connection-result mapping table) since `.claude/` is gitignored; `.claude/skills/noodara-domain-model/SKILL.md` §2.1 updated locally (not committed) to add the `CONNECTED → PENDING` and `ERROR → PENDING` rows per D-16.
- Verified live: temporarily adding a 7th entry to `SERVER_STATUSES` made 18 of 107 domain-server tests fail (confirming the mechanically-generated suite actually depends on the table), then reverted.
- Full command chain green after both tasks: `pnpm lint`, `pnpm typecheck`, `pnpm test` (148/148, up from 44), `pnpm exec turbo boundaries` (57 files, no issues). `packages/domain/src/server/{server-state,connection-result}.ts` both report 100% statement and branch coverage (well above the 95%/95% QA-02 gate).

## Task Commits

Each task was committed atomically (TDD tasks have separate RED/GREEN commits):

1. **Task 1 (RED): failing server-state.test.ts** - `9780b25` (test)
   **Task 1 (GREEN): implement server-state.ts + docs mirror** - `be50838` (feat)
2. **Task 2 (RED): failing connection-result.test.ts** - `418c18b` (test)
   **Task 2 (GREEN): implement connection-result.ts** - `e8aba8f` (feat)
3. **Deviation fix: domain's `test` script `--root` flag** - `b994d26` (fix)

**Plan metadata:** _(final metadata commit follows this summary)_

## Files Created/Modified
- `packages/domain/src/server/server-state.ts` - `SERVER_STATUSES`, `ServerStatus`, `TransitionReason`, frozen `TRANSITIONS`/`REASON_REQUIRED` tables, `canTransition()`, `transition()`, `InvalidTransitionError`, `MissingTransitionReasonError`
- `packages/domain/src/server/server-state.test.ts` - Exhaustive 36-pair cross-product plus explicit reason-gated-edge and error-field tests (81 tests)
- `packages/domain/src/server/connection-result.ts` - `SERVER_ERROR_CODES`, `ServerErrorCode`, `ConnectionResult`, `ServerConnectionState`, `statusForErrorCode()`, `applyConnectionResult()`
- `packages/domain/src/server/connection-result.test.ts` - Table-driven error-code mapping, TOFU/HOST_KEY_CHANGED/invariant/purity tests (23 tests)
- `docs/domain/server-state-transitions.md` - Committed mirror of the transition table, reason-gated edges (with D-13/D-14/D-15 names), and the connection-result mapping table
- `packages/domain/package.json` - `test` script now `vitest run --root ../.. --project packages` (deviation fix)
- `.planning/phases/01-dominio-persistencia-y-autenticaci-n/deferred-items.md` - Marked the pre-existing `pnpm --filter @noodara/domain test` bug resolved
- `.claude/skills/noodara-domain-model/SKILL.md` - §2.1 table extended with `CONNECTED → PENDING`/`ERROR → PENDING` rows and a note pointing to `docs/domain/server-state-transitions.md` (local edit only; `.claude/` is gitignored, not committed)

## Decisions Made
See `key-decisions` in the frontmatter for the four decisions with the most downstream impact (uniform `MissingTransitionReasonError` on missing-or-wrong reason, the explicit CONNECTING-only guard in `applyConnectionResult`, TOFU-capture-only-when-null, and the `satisfies` fix for the frozen lookup tables).

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] `Readonly<Record<...>>` annotation on frozen array literals widened to `string[]`**
- **Found during:** Task 1, first `pnpm exec tsc --noEmit` after GREEN
- **Issue:** `const TRANSITIONS: Readonly<Record<ServerStatus, readonly ServerStatus[]>> = Object.freeze({ PENDING: Object.freeze(['CONNECTING']), ... })` failed to typecheck: TypeScript inferred each inner `Object.freeze([...])` array as `readonly string[]`, which isn't assignable to `readonly ServerStatus[]`.
- **Fix:** Dropped the redundant inner `Object.freeze()` calls and the explicit outer type annotation in favor of `} satisfies Record<ServerStatus, readonly ServerStatus[]>)`, which keeps the object's literal member types narrowed while still statically verifying every `ServerStatus` key is present with a `ServerStatus[]` value. Applied the same pattern to `connection-result.ts`'s `ERROR_CODE_STATUS`.
- **Files modified:** packages/domain/src/server/server-state.ts, packages/domain/src/server/connection-result.ts
- **Verification:** `pnpm exec tsc --noEmit -p packages/domain/tsconfig.json` exits 0.
- **Committed in:** `be50838` (Task 1), `e8aba8f` (Task 2)

**2. [Rule 3 - Blocking, orchestrator-authorized] `packages/domain`'s `test` script fails under `pnpm --filter`**
- **Found during:** Post-Task-2 verification, matching the pre-logged `deferred-items.md` entry
- **Issue:** `packages/domain/package.json`'s `test` script (`vitest run --project packages`) failed with `Error: No projects matched the filter "packages"` when run via `pnpm --filter @noodara/domain test`, because Vitest's cwd inside the package has no local `vitest.config.ts` and never finds the root config defining the `packages` project. Logged as a deferred item in Plan 01-03 (out of that plan's file scope) and explicitly authorized for this plan by the orchestrator.
- **Fix:** Added `--root ../..`, mirroring the identical fix already applied to `apps/control-plane/package.json` in Plan 01-03: `"test": "vitest run --root ../.. --project packages"`.
- **Files modified:** packages/domain/package.json, .planning/phases/01-dominio-persistencia-y-autenticaci-n/deferred-items.md (marked resolved)
- **Verification:** `pnpm --filter @noodara/domain test` now exits 0 (3 test files, 107 tests, includes `purity.test.ts`).
- **Committed in:** `b994d26`

---

**Total deviations:** 2 (1 bug fix required for the plan's own typecheck gate, 1 orchestrator-authorized scope-boundary fix). No scope creep beyond Tasks 1–2's declared `<files>` plus the explicitly authorized package.json fix.

## Issues Encountered

None beyond what is captured in Deviations from Plan above.

## User Setup Required

None - no external service configuration required.

## Next Phase Readiness
- `packages/domain/src/server/{server-state,connection-result}.ts` are fully implemented and exported through the existing `server/index.ts` barrel (untouched, per Plan 01-02's "barrels are fixed" convention) — phase 2's SSH adapter, phase 3's application services, and phase 4's HTTP routes/worker should import `transition()`/`applyConnectionResult()` from `@noodara/domain/server`, never assign `status` directly.
- `applyConnectionResult()`'s `ServerConnectionState` type (`status`, `lastErrorCode`, `hostFingerprint`, `pendingFingerprint`, `lastSeenAt`) is the exact field subset phase 2's SSH result handler needs to read/write; the Drizzle `Server` schema (Plan 01-07/01-09) should use matching column names/types so mapping between the DB row and this domain type stays trivial.
- D-15's "Trust new fingerprint" action (copying `pendingFingerprint` to `hostFingerprint` and calling `transition('ERROR', 'PENDING', { reason: 'fingerprint_trusted' })`) and D-14's identity-changed edit path are both fully supported by this plan's `transition()`/`applyConnectionResult()`; the HTTP endpoint and UI for both are explicitly deferred to phases 4 and 5 per `01-CONTEXT.md`.
- `packages/domain/package.json`'s `test` script now matches `apps/control-plane`'s pattern; any future package added under `packages/*` with its own `vitest run --project <name>` script should ship with `--root ../..` from the start to avoid re-discovering this bug.
- Full command chain (`pnpm lint && pnpm typecheck && pnpm test && pnpm exec turbo boundaries`) verified green after every commit in this plan; `packages/domain/src/server/**` at 100%/100% statement/branch coverage.

---
*Phase: 01-dominio-persistencia-y-autenticacion*
*Completed: 2026-09-10*

## Self-Check: PASSED

- FOUND: packages/domain/src/server/server-state.ts
- FOUND: packages/domain/src/server/server-state.test.ts
- FOUND: packages/domain/src/server/connection-result.ts
- FOUND: packages/domain/src/server/connection-result.test.ts
- FOUND: docs/domain/server-state-transitions.md
- FOUND: packages/domain/package.json
- FOUND: .planning/phases/01-dominio-persistencia-y-autenticaci-n/deferred-items.md
- FOUND commit: `9780b25` (Task 1 RED)
- FOUND commit: `be50838` (Task 1 GREEN)
- FOUND commit: `418c18b` (Task 2 RED)
- FOUND commit: `e8aba8f` (Task 2 GREEN)
- FOUND commit: `b994d26` (deviation fix)
- FOUND commit: `ae2373a` (docs: summary)
- Re-verified independently: `pnpm lint`, `pnpm typecheck`, `pnpm test` (148/148), `pnpm exec turbo boundaries` all exit 0; `packages/domain/src/server/{server-state,connection-result}.ts` both report 100% statement/branch coverage.
