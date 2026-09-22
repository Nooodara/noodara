---
phase: 05-ui-web
plan: 43
subsystem: infra
tags: [pino, logging, security, redaction, tdd]

# Dependency graph
requires:
  - phase: 05-ui-web (gap closure round 2, plan 42 and earlier)
    provides: the re-verified 05-VERIFICATION.md gaps_remaining list, including the WR-A-04
      residual this plan closes
provides:
  - A `hooks.logMethod` interceptor in `createLogger` (apps/control-plane/src/logger.ts) that
    rewrites any bare `Error` first argument into `{ err }` plus a literal fallback message, at
    every pino log level, without touching any call site
  - Twelve regression cases (six new + six pre-existing) in `logger.test.ts` proving the guard
    holds and the existing `{ err }`/redaction/serializer behaviour is untouched
  - An updated `server.test.ts` reproduction proving the WR-A-04 vulnerability it documented is
    now closed structurally, not just at the one call site 05-34 fixed
affects: [05-46 (closing gate — re-derives gaps_remaining), any future control-plane logging code]

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "Global logging guard via pino's hooks.logMethod, rather than a per-call-site convention or
      an ESLint rule, to make an entire class of leak structurally unreachable"

key-files:
  created: []
  modified:
    - apps/control-plane/src/logger.ts
    - apps/control-plane/src/logger.test.ts
    - apps/control-plane/src/server.test.ts

key-decisions:
  - "Fallback message for a bare Error with no caller-supplied message is the fixed literal
    'error logged without a message' — never err.message, never a template literal, never a
    String() coercion of the error, since any of those would reintroduce the exact leak this hook
    closes"
  - "server.test.ts's pre-existing WR-A-04 reproduction (05-34) is updated, not left broken: its
    first case used to pin the leak as expected pre-fix behaviour; now that the global guard
    exists, that same bare-Error call is safe, and the test is rewritten to assert the new,
    correct behaviour instead of skipping or deleting it"

patterns-established:
  - "A structural, hook-level guard is preferred over a per-call-site fix or lint rule when the
    risk is a future developer forgetting a convention (see plan's own 'why a hook rather than an
    ESLint rule' rationale)"

requirements-completed: [QA-05]

duration: 6min
completed: 2026-09-20
---

# Phase 05 Plan 43: Bare-Error Logging Guard (WR-A-04 residual) Summary

**A `hooks.logMethod` interceptor in `createLogger` makes `logger.error(err)` structurally safe at every pino level, closing the WR-A-04 residual without editing any call site.**

## Performance

- **Duration:** 6 min (18:58 – 19:04 local, commit timestamps)
- **Started:** 2026-09-20T18:58:13-06:00
- **Completed:** 2026-09-20T19:03:46-06:00
- **Tasks:** 2 (both `type="tdd"`)
- **Files modified:** 3 (2 planned + 1 deviation — see below)

## Accomplishments

- Closed the WR-A-04 residual named in 05-VERIFICATION.md's `gaps_remaining`: a bare
  `logger.error(err)`/`warn`/`fatal` call anywhere in the codebase can no longer put an error's
  message on the wire, because the guard is now structural (a pino `hooks.logMethod`), not a
  per-call-site convention.
- Proved, against this repo's real pino 10.3.1 and the real `createLogger()`, both the pre-fix
  leak and the post-fix safe behaviour for the identical call (`logger.error(new Error(...))`) —
  literal records quoted below.
- Added a regression test that fails immediately if the guard is ever removed (pinned across
  `error`, `warn`, `fatal`, a custom Error subclass, and the untouched `{ err, ...metadata }` and
  non-Error shapes).

## Task Commits

Each task was committed atomically, RED then GREEN, plus one REFACTOR to satisfy a literal
grep-based acceptance check:

1. **Task 1: RED — pin the bare-Error leak in logger.test.ts** - `c453177` (test)
2. **Task 2: GREEN — hooks.logMethod interceptor** - `2281702` (fix)
3. **Task 2 (cont.): reword hook comment to avoid literal `err.message`/`String(` matches** -
   `acb03c9` (refactor)

_No separate plan-metadata commit was made — this executor's brief explicitly withholds
STATE.md/ROADMAP.md/REQUIREMENTS.md updates for the orchestrator to own._

## Files Created/Modified

- `apps/control-plane/src/logger.ts` — added `NO_MESSAGE_FALLBACK` literal and a
  `hooks.logMethod` entry to `LoggerOptions` that rewrites a leading `Error` argument into
  `{ err: <error> }` plus a never-derived message (the caller's own string second argument, or the
  literal fallback), leaving `redact`, `serializers`, `writableForTests` and the
  `options.destination` branch untouched.
- `apps/control-plane/src/logger.test.ts` — added a new describe block, "createLogger
  bare-Error-as-first-argument guard (WR-A-04, 05-VERIFICATION.md gaps_remaining)", with six
  cases: no-message leak, message-supplied, custom Error subclass, warn+fatal, existing
  `{ err, ...metadata }` shape untouched, non-Error first argument untouched.
- `apps/control-plane/src/server.test.ts` — updated the pre-existing WR-A-04 (05-34) pinned
  reproduction: its first case used to assert the bare-Error leak as documented pre-fix behaviour;
  it now asserts the same call is safe under the new global guard (see Deviations below).

## RED Output (literal, before the fix)

Command: `pnpm vitest run apps/control-plane/src/logger.test.ts`

```
Test Files  1 failed (1)
     Tests  3 failed | 9 passed (12)

 FAIL  createLogger bare-Error-as-first-argument guard ... > never puts a bare Error's message on the wire when no message argument is supplied
AssertionError: expected 'sk-live-CANARY-SECRET-VALUE' not to contain 'sk-live-CANARY-SECRET-VALUE'

 FAIL  createLogger bare-Error-as-first-argument guard ... > keeps a custom Error subclass name when passed bare, without the message
AssertionError: expected '[{"level":50,...,"err":{"name":"SecretTamperError"},"msg":"sk-live-CANARY-SECRET-VALUE"}]' not to contain 'sk-live-CANARY-SECRET-VALUE'

 FAIL  createLogger bare-Error-as-first-argument guard ... > applies the same bare-Error guard at warn and fatal levels, not only error
AssertionError: expected 'sk-live-CANARY-SECRET-VALUE' not to contain 'sk-live-CANARY-SECRET-VALUE'
```

Note: the plan's own must_haves text predicted "Tests 1-4 must fail today" (four cases). In the
real RED run only three of the six new cases failed — the "message-supplied" case (Test 2) already
passed pre-fix, because pino's own first-argument handling only overrides `msg` with the error's
own message when no message argument was supplied; when the caller does pass a message string,
pino already routes the error correctly under `err` and leaves the caller's `msg` alone. This is a
real, verified discrepancy from the plan's prediction, not a test-writing error — the three
failures that did occur are exactly the ones matching the plan's own empirically-verified example
(`logger.error(new Error('sk-live-LEAKED-SECRET-VALUE'))` → leak). Tests 5 and 6 (pinning existing,
correct behaviour) passed in RED as expected.

## Before / After: the same bare-Error call, real emitted records

Both captured by directly invoking the real `createLogger()`/`writableForTests()` (via `tsx`, same
non-secret env stand-ins vitest uses) against the pre-fix and post-fix `logger.ts`, for the literal
call `logger.error(new Error('sk-live-LEAKED-SECRET-VALUE'))`:

**Before (commit `c453177`, pre-fix `logger.ts`):**
```json
{"level":50,"time":1789952676870,"pid":34760,"hostname":"Pablos-MacBook-Pro.local","err":{"name":"Error"},"msg":"sk-live-LEAKED-SECRET-VALUE"}
```

**After (commit `acb03c9`, post-fix `logger.ts`):**
```json
{"level":50,"time":1789952650867,"pid":34362,"hostname":"Pablos-MacBook-Pro.local","err":{"name":"Error"},"msg":"error logged without a message"}
```

The `err` object was already safe both before and after (`serializers.err` reduces it to `{name}`
either way). The `msg` field is the one that changes: the raw secret before, a fixed literal after.

## Decisions Made

- Fallback message for a bare Error with no caller-supplied message is the fixed literal
  `'error logged without a message'` — never derived from the error in any way.
- Kept `server.test.ts`'s pre-existing WR-A-04 reproduction alive and updated rather than deleting
  it or leaving it red, since it is now directly exercising the guard this plan adds (see
  Deviations).
- Reworded the `hooks.logMethod` doc comment mid-task (REFACTOR commit) to avoid the literal
  substrings `err.message` and `String(` appearing in prose, since the plan's own acceptance
  criteria grep the whole file for those substrings.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug/test-writing] Subclass name test needed `this.name` set explicitly**
- **Found during:** Task 1 (RED)
- **Issue:** My first draft of "Test 3" used `class SecretTamperError extends Error {}` with no
  constructor. In real JS, a subclass that doesn't explicitly set `this.name` inherits `'Error'`
  from `Error.prototype`, not its own class name — this codebase's real `SecretTamperError`
  (`packages/domain/src/security/envelope.ts`) does set `this.name` explicitly for exactly this
  reason. My test would have failed for the wrong reason (a JS gotcha, not the leak under test).
- **Fix:** Added a constructor that calls `super(message)` then `this.name = 'SecretTamperError'`,
  matching the codebase's real convention.
- **Files modified:** apps/control-plane/src/logger.test.ts
- **Verification:** Re-ran RED; the test now fails for the correct reason (canary leaked), passes
  after the GREEN fix.
- **Committed in:** c453177 (Task 1 RED commit, before it was ever pushed elsewhere)

**2. [Rule 1 - Bug] Two `Array<T>` lint violations in the new RED test block**
- **Found during:** Task 2 (`pnpm lint` after GREEN)
- **Issue:** Two new test assertions used `Array<{ ... }>` instead of the project's required
  `{ ... }[]` form (`@typescript-eslint/array-type`), failing `pnpm lint`.
- **Fix:** Changed both to the `T[]` form.
- **Files modified:** apps/control-plane/src/logger.test.ts
- **Verification:** `pnpm lint` green.
- **Committed in:** 2281702 (Task 2 GREEN commit)

**3. [Rule 1 - Bug] `server.test.ts`'s pinned WR-A-04 reproduction broke as a direct consequence of the fix**
- **Found during:** Task 2 (`pnpm test` after GREEN, before this plan's `pnpm vitest run` scoped
  command was widened to the full suite per the plan's own verification step 2)
- **Issue:** `apps/control-plane/src/server.test.ts` (from plan 05-34) contains a test that
  intentionally pinned the pre-fix leak as documentation: "a bare Error as the first argument
  leaks its raw message into msg (the shape server.ts used to use)". Once the global
  `hooks.logMethod` guard from this plan landed, that call is no longer leaky, so the test's own
  assertion (`expect(...).toContain(secretMessage)`) started failing — not because of a regression,
  but because the very vulnerability it documented is now closed at the framework level.
- **Fix:** Rewrote the test's name and body to assert the new, correct behaviour (no leak, `err`
  key present with the right name, `msg` is the fixed fallback literal), and extended the file's
  header comment to explain that 05-43's global guard now supersedes the need for `server.ts`'s
  own call-site-specific `{ err }` fix from 05-34 (which remains in place and is unaffected).
- **Files modified:** apps/control-plane/src/server.test.ts
- **Verification:** `pnpm vitest run apps/control-plane/src/server.test.ts` green (2/2); full
  `pnpm test` green (1513/1513).
- **Committed in:** 2281702 (Task 2 GREEN commit)
- **Scope note:** This file is outside the plan's declared `files_modified` (only `logger.ts` and
  `logger.test.ts` were named). It was touched only because this task's own change directly broke
  it — not an unrelated pre-existing issue — and leaving it red would violate the plan's own
  Task 2 acceptance criterion ("`pnpm test` green") and the project's zero-flaky/zero-unjustified-
  skip DoD. The plan's overall verification step 4 ("`git diff --name-only` lists exactly the two
  files in `files_modified`") is therefore not literally satisfied; documented here rather than
  silently worked around.

**4. [Rule 1 - Bug] Comment reworded to satisfy the plan's own literal grep acceptance checks**
- **Found during:** Task 2, after GREEN, while verifying the stated acceptance criteria
  `grep -c "err.message" apps/control-plane/src/logger.ts` is 0 and no `String(` call on the error.
- **Issue:** My first draft of the hook's doc comment used the literal substrings `` `err.message` ``
  and `` `String(err)` `` in prose explaining what the hook must never do — which made the
  whole-file grep count 2 and 2 respectively, failing the literal acceptance check even though no
  actual code derived a message from the error.
- **Fix:** Reworded the comment to describe the same prohibitions without using those literal
  substrings (e.g. "the error's own message property" instead of `` `err.message` ``).
- **Files modified:** apps/control-plane/src/logger.ts
- **Verification:** `grep -c "err.message"` and `grep -c '\${'` both 0 after the reword;
  `pnpm vitest run`, `pnpm lint`, `pnpm typecheck` all still green.
- **Committed in:** acb03c9 (separate refactor commit, tests unchanged throughout)
- **Residual note:** `grep -c 'String(' apps/control-plane/src/logger.ts` is still 1 after this
  fix — the one match is `chunks.push(chunk.toString())` inside the pre-existing
  `writableForTests()` helper (added in Phase 1, commit `cfd24ef`, unrelated to error handling: it
  serializes a stream chunk, not an error). This is a pre-existing, out-of-scope match the plan's
  literal whole-file grep does not distinguish from a real `String(err)` call; not modified, since
  it is unrelated production code with a legitimate, unrelated use of `.toString()`.

---

**Total deviations:** 4 auto-fixed (Rule 1 in every case — a bug in my own test writing, a lint
violation, a directly-broken pre-existing test, and a literal-grep-vs-prose mismatch).
**Impact on plan:** All four were direct, necessary consequences of implementing and verifying
this task correctly. No scope creep, no call site was edited to "fix" it (the acceptance criterion
this plan cares most about), and `server.ts` itself was not touched.

## Issues Encountered

None beyond the four deviations above.

## Verification Commands Run (with results)

1. `pnpm vitest run apps/control-plane/src/logger.test.ts` — 12/12 passed.
2. `pnpm vitest run apps/control-plane/src/server.test.ts apps/control-plane/src/logger.test.ts` —
   14/14 passed (both files together, post-fix).
3. `pnpm test` (full unit suite) — 1513/1513 passed, 118/118 test files passed.
4. `pnpm lint` — clean, all 9 turbo tasks succeeded (0 errors after the two Array<T> fixes above).
5. `pnpm typecheck` — clean, all 8 turbo tasks succeeded (no `any`, no new `eslint-disable`).
6. `pnpm security:scan-leaks` — green: 3/3 Vitest integration canary tests
   (`tests/integration/activity/canary.test.ts`, `canary-full-flow.test.ts`, `canary-http.test.ts`)
   plus 1/1 Playwright `@canary` test (`tests/e2e/canary-ui.spec.ts`), no canary secret observed
   in any output across API responses, logs, activity log, or rendered HTML/console/storage.
7. `grep -c "logMethod" apps/control-plane/src/logger.ts` — 1.
8. `grep -c "err.message" apps/control-plane/src/logger.ts` — 0.
9. `grep -c '\${' apps/control-plane/src/logger.ts` — 0 (no template literal in the file).
10. `grep -c 'String(' apps/control-plane/src/logger.ts` — 1, unrelated pre-existing
    `chunk.toString()` (see Deviation 4's residual note); no `String(err)` call anywhere.
11. `git diff --name-only` across the plan's three commits — `apps/control-plane/src/logger.ts`,
    `apps/control-plane/src/logger.test.ts`, `apps/control-plane/src/server.test.ts` (the third is
    the documented deviation above); `package.json` and `pnpm-lock.yaml` untouched.

## User Setup Required

None — no external service configuration required.

## Next Phase Readiness

- WR-A-04 residual from 05-VERIFICATION.md's `gaps_remaining` is closed: the bare-Error leak is
  now structurally impossible at the logging layer, proven by a real emitted-record before/after
  comparison and a regression suite that fails if the guard regresses.
- No blockers for 05-44/05-45/05-46. The closing gate (05-46) should re-derive this gap as CLOSED
  and can additionally spot-check the before/after records quoted above against its own
  independent reproduction.

---
*Phase: 05-ui-web*
*Completed: 2026-09-20*
