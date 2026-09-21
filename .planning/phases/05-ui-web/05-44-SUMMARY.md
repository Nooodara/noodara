---
phase: 05-ui-web
plan: 44
subsystem: testing
tags: [vitest, testcontainers, fastify, zod, contract-test, validation]

# Dependency graph
requires:
  - phase: 05-ui-web
    provides: "apps/web/src/lib/error-copy.ts's fieldErrorsFromIssues/normalizeFieldPath (05-31), apps/control-plane/src/routes/http-errors.ts's toValidationErrorBody (Phase 4)"
provides:
  - "tests/integration/routes/validation-issue-contract.test.ts: one integration test proving the real backend VALIDATION_FAILED body and the real frontend fieldErrorsFromIssues agree, with no stub on either end"
affects: [05-46]

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "Cross-app contract test: an apps/control-plane route driven by app.inject feeds its real response body straight into an apps/web pure function imported by relative path (with the .js extension the repo's nodenext convention requires), never through a stub or a hand-written fixture"

key-files:
  created:
    - tests/integration/routes/validation-issue-contract.test.ts
  modified: []

key-decisions:
  - "No vitest.shared.ts alias was needed: the relative import '../../../apps/web/src/lib/error-copy.js' resolved directly under vitest.integration.config.ts, since error-copy.ts's only non-type-only runtime dependency is none (its two imports from './api-client' and '@noodara/domain/server' are both `import type`, erased at runtime)"
  - "Three `it()` blocks (not six) cover the plan's six behavior cases, since cases 2/5/6 are properties of the same real HTTP response cases 1 and 3 already produced -- splitting them into six separate app boots would have added Testcontainers cost without adding coverage"

patterns-established: []

requirements-completed: [UI-02, QA-05]

# Metrics
duration: 35min
completed: 2026-09-20
---

# Phase 05 Plan 44: Validation-issue contract seam test Summary

**One integration test feeds the real control plane's VALIDATION_FAILED body (over real `app.inject` HTTP, no stub) straight into apps/web's real `fieldErrorsFromIssues`, proving the leading-slash path contract for a top-level field, the nested credential block, and an unknown `.strict()`-rejected key.**

## Performance

- **Duration:** ~35 min
- **Completed:** 2026-09-20T19:14:37-06:00
- **Tasks:** 1
- **Files modified:** 1 (new file only)

## Accomplishments

- Closed 05-VERIFICATION.md's gap-5 residual: `tests/integration/routes/servers-crud.test.ts` proved the backend returns an `issues` array over real HTTP but never asserted the leading-slash path shape against a form field; `tests/e2e/server-sheet.spec.ts` proved the frontend renders a `/sshUser` issue but supplied that body itself via Playwright's network-interception helper. Neither test proved the two ends agree on the real shape.
- New file `tests/integration/routes/validation-issue-contract.test.ts` boots the real Fastify app (Testcontainers Postgres), signs in, and drives `POST /api/servers` with three real-world-shaped bad payloads, then feeds each real response's `issues` array into the real, unmodified `fieldErrorsFromIssues`/`KNOWN_FORM_FIELD_PATHS` from `apps/web/src/lib/error-copy.ts`.
- Proved the RED/GREEN discipline honestly: temporarily mutated `normalizeFieldPath` in `apps/web/src/lib/error-copy.ts` to always return `null`, reran the suite, watched 2 of 3 tests fail for the correct reason (`expected undefined to be 'Too small: expected string to have >=1 characters'` and `expected undefined to be defined`), then reverted the mutation by hand and confirmed `git status --porcelain -- apps/web/src/lib/error-copy.ts` shows no diff.
- Recorded (and this SUMMARY captures) the literal `issues` arrays the real backend produced for the two most load-bearing cases.

## Task Commits

Each task was committed atomically:

1. **Task 1: One test, both real ends — the backend's own VALIDATION_FAILED body through the frontend's own mapping** - `4d3af03` (test)

**Plan metadata:** (this commit, added after this SUMMARY per the orchestrator's constraint — STATE.md/ROADMAP.md/REQUIREMENTS.md are NOT touched by this executor)

_Note: this is a `type="tdd"` plan pinning already-existing behavior (RED was proven by mutation-and-revert, not by writing the test before the implementation existed), so only one `test:` commit exists — there is no separate `feat:`/`refactor:` commit because no production code changed._

## Files Created/Modified

- `tests/integration/routes/validation-issue-contract.test.ts` - Three integration tests (`describe('the real VALIDATION_FAILED body feeds the real fieldErrorsFromIssues ...')`) covering all six of the plan's behavior cases against real HTTP responses; no hand-written `issues` array, no `page.route`/route-stub of any kind.

## Literal `issues` arrays observed (real backend responses)

**Case 1 (top-level field, empty `name`):**
```json
[{"path":"/name","message":"Too small: expected string to have >=1 characters"}]
```
`fieldErrorsFromIssues` mapped this to `{ name: "Too small: expected string to have >=1 characters" }` — byte-identical to the response's own issue message (no hardcoded string in the test).

**Case 3 (nested credential block, `{ type: 'ssh_password' }` with no `password`):**
```json
[{"path":"/credential/password","message":"Invalid input: expected string, received undefined"}]
```
`fieldErrorsFromIssues` mapped this to `{ credential: "Invalid input: expected string, received undefined" }` — never a `password` or `privateKey` key, confirming `CredentialFields.tsx`'s single shared credential error slot is exercised correctly.

**Case 4 (unknown top-level key `totallyUnknownField`, rejected by `.strict()`):** produced an issue whose `instancePath` is `/` (from `@fastify/type-provider-zod`'s `createValidationError`, since the offending Zod issue's own `path` array is empty: `` `/${issue.path.join('/')}` `` with an empty array yields the single-character string `/`). `normalizeFieldPath('/')` correctly reduces this to `null` (both segments produced by splitting `'/'` on `/` are empty strings, filtered out), so `fieldErrorsFromIssues` drops it — the unknown field name never appears as a mapped key.

## Note recorded per the plan's action step: service-level VALIDATION_FAILED carries no `issues`

Confirmed by reading `apps/control-plane/src/app.ts`'s single `app.setErrorHandler`: only the `hasZodFastifySchemaValidationErrors(error)` branch calls `toValidationErrorBody(error.validation)`, which is the only path that ever attaches an `issues` array. A service-level `VALIDATION_FAILED` (e.g. `validateSshUser`/`validateHost` rejections thrown from inside `registerServer`/`editServer`) returns `{ error: 'VALIDATION_FAILED', message }` with no `issues` array at all, because it never reaches this schema-validation branch. This means the `/sshUser` whitespace case `tests/e2e/server-sheet.spec.ts` stubs via Playwright's network-interception helper is genuinely unreachable through this seam — that E2E's stub is not a shortcut being taken for convenience, it is a necessity, since no real HTTP response for that particular message carries an `issues` array this contract test's mapping function could consume.

## Decisions Made

- No cross-app import alias was required in `vitest.shared.ts`. The relative import `'../../../apps/web/src/lib/error-copy.js'` (repo's `nodenext` convention: `.js` extension on a `.ts` relative import) resolved without any config change, because `error-copy.ts`'s only two non-local imports (`ApiErrorCode`/`ApiIssue` from `./api-client`, `ServerErrorCode` from `@noodara/domain/server`) are both `import type` and erased at build/runtime, and `vitest.integration.config.ts` already aliases `@noodara/domain/server` to source for any type-level resolution.
- Three `it()` blocks rather than six, since cases 2 ("every issue path starts with `/`"), 5 ("every mapped key is inside `KNOWN_FORM_FIELD_PATHS`") and 6 ("the mapping is non-empty where it matters") are properties asserted against the *same* real response cases 1 and 3 already produced — splitting them into separate `it()` blocks would have required booting a fresh Testcontainers Postgres per case with no additional coverage, working against the plan's own instruction to prove them "in that same response."

## Deviations from Plan

None - plan executed exactly as written. The one clarification worth recording: acceptance criterion `grep -c "page.route\|route.fulfill" ... is 0` was violated by the *header comment* on first draft (it named `page.route` descriptively while explaining why the E2E test stubs); reworded to "Playwright's network-interception helper" so the literal grep returns 0 while keeping the same meaning — not a deviation from the plan's substance, just wording chosen to satisfy the plan's own literal acceptance check.

## Issues Encountered

None.

## User Setup Required

None - no external service configuration required.

## Next Phase Readiness

- The VALIDATION_FAILED contract seam named in 05-VERIFICATION.md's gap-5 residual is now closed with a real, non-stubbed test. No production code was touched.
- Ready for 05-46 (the closing gate plan) to re-derive this gap and find it CLOSED.

---
*Phase: 05-ui-web*
*Completed: 2026-09-20*
