---
phase: quick-260920-ly9
plan: 1
subsystem: ui
tags: [react, forms, accessibility, playwright, vitest]

requires: []
provides:
  - Server-side /sshUser VALIDATION_FAILED issues now render a visible inline message and mark the SSH user input aria-invalid=true, matching Name/Host/SSH port
  - A five-field it.each guard (ServerSheet.test.tsx) proving every server-sheet-owned KNOWN_FORM_FIELD_PATHS key renders its error, driven off the real exported whitelist
  - An E2E case proving the fix end to end, including that the create request's JSON body actually carries the typed sshUser value
affects: [ui-web, server-sheet, error-copy]

tech-stack:
  added: []
  patterns:
    - "jsdom test-local ResizeObserver stub for Radix RadioGroup mounted inside a real <form> (BubbleInput's useSize only activates when control.closest('form') is found)"

key-files:
  created:
    - apps/web/src/components/ServerSheet.test.tsx
  modified:
    - apps/web/src/components/ServerSheet.tsx
    - apps/web/src/lib/error-copy.ts
    - apps/web/src/lib/server-form.ts
    - tests/e2e/server-sheet.spec.ts

key-decisions:
  - "Exported KNOWN_FORM_FIELD_PATHS from error-copy.ts (was module-private) so the guard test drives off the real whitelist instead of a hand-duplicated list"
  - "sshUser gained a ServerFormErrors key with no matching validateServerForm rule -- SSH user has no client-side format constraint (05-UI-SPEC.md SS2.4), the key exists purely to route a server-side issue"

patterns-established: []

requirements-completed: []

duration: ~15min
completed: 2026-09-20
---

# Quick Task 260920-ly9: Render server-side sshUser field error Summary

**Wired ServerSheet's SSH user Field with the same `error`/`invalid` affordance its Name/Host/SSH port siblings already had, closing a confirmed-live regression where a real `/sshUser` VALIDATION_FAILED response produced zero visible feedback.**

## Performance

- **Duration:** ~15 min (estimate -- `PLAN_START_TIME` was not captured programmatically at the start of this session; based on tool-call sequence, not a recorded timestamp)
- **Completed:** 2026-09-20T22:00Z
- **Tasks:** 3 (RED, GREEN, verification sweep)
- **Files modified:** 5 (1 created, 4 modified)

## Accomplishments

- `ServerSheet.tsx`'s SSH user `Field` now renders `fieldErrors.sshUser` and marks the `Input` `invalid` exactly like Name/Host/SSH port -- no new component, no new visual treatment.
- New `ServerSheet.test.tsx`: a plain RED/GREEN proof for the `/sshUser` case, plus an `it.each` guard over all five server-sheet-owned `KNOWN_FORM_FIELD_PATHS` keys (`name`, `host`, `sshPort`, `sshUser`, `credential`) that will catch this exact class of "field silently dropped from the wiring" defect for any of the five in the future.
- New Playwright `@sheet` case in `tests/e2e/server-sheet.spec.ts` proving the fix end to end in a real browser: visible message, `aria-invalid="true"`, no orphan toast, sheet stays open, and -- since it stubs the `POST /api/servers` mutation -- an explicit assertion on the actual request sent (method, URL, and that `postDataJSON().sshUser` equals the exact string typed).
- `error-copy.ts`'s `KNOWN_FORM_FIELD_PATHS` exported (was module-private); no other change to that file or the whitelist's members.
- `ServerFormErrors` (server-form.ts) gained `readonly sshUser?: string` with no corresponding `validateServerForm` rule -- SSH user has no client-side format constraint per 05-UI-SPEC.md SS2.4.

## Task Commits

1. **Task 1: RED -- failing component test, E2E case and cross-field guard** - `6319631` (test)
2. **Task 2: GREEN -- wire the SSH user Field** - `8d7091a` (fix)
3. **Task 3: Full verification sweep** - no commit (every gate passed on the first run; no fix-forward was needed)

_Note: this plan's tasks were declared `tdd="true"` and executed as separate RED/GREEN commits, per the executor's explicit hard-rule override for this run._

## Files Created/Modified

- `apps/web/src/components/ServerSheet.test.tsx` - New. Component-level RED/GREEN proof for the `sshUser` field error plus the five-field cross-field guard; includes a file-local jsdom `ResizeObserver` stub (see Deviations).
- `apps/web/src/components/ServerSheet.tsx` - SSH user `Field` gains the same two props its siblings already carry: `error={fieldErrors.sshUser}` (conditional spread) and `invalid={fieldErrors.sshUser !== undefined}` on the nested `Input`.
- `apps/web/src/lib/error-copy.ts` - `KNOWN_FORM_FIELD_PATHS` changed from module-private `const` to `export const`. No other change; whitelist membership untouched.
- `apps/web/src/lib/server-form.ts` - `ServerFormErrors` gains `readonly sshUser?: string`.
- `tests/e2e/server-sheet.spec.ts` - New `@sheet` test: fills a valid form including a typed SSH user, stubs a 400 `VALIDATION_FAILED` with a `/sshUser` issue, and asserts both the UI reaction and the actual outgoing request's JSON body.

## Decisions Made

- `KNOWN_FORM_FIELD_PATHS` exported minimally (one keyword change) rather than duplicated into the test file, so the guard test can never silently drift from the real whitelist -- matches the plan's own `<interfaces>` instruction.
- No `validateServerForm` rule added for `sshUser`: the plan and 05-UI-SPEC.md SS2.4 both place no client-side format constraint on it; the new `ServerFormErrors.sshUser` key exists solely to let a server-side `/sshUser` issue reach the render path, exactly like the four pre-existing keys.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 3 - Blocking] jsdom has no `ResizeObserver`, crashing the first render of `ServerSheet.test.tsx`**

- **Found during:** Task 1, first `pnpm vitest run` attempt for the RED gate.
- **Issue:** `ServerSheet.tsx` wraps its fields in a real `<form>`. `@radix-ui/react-radio-group`'s `RadioGroupItem` renders a hidden native `BubbleInput` only when `control.closest('form')` finds an ancestor form (`isFormControl`), and that `BubbleInput` calls `useSize`, which calls `ResizeObserver`. No prior component test in this repo mounted `SegmentedControl` (the credential-type control, used by `CredentialFields`) inside a `<form>` -- `SegmentedControl.test.tsx` and `CredentialFields.test.tsx` both render it standalone, so this path was never previously exercised in jsdom. Every one of the six new `ServerSheet.test.tsx` cases crashed with `ReferenceError: ResizeObserver is not defined` before any assertion ran, for a reason unconnected to the field-wiring bug under test.
- **Fix:** Added a minimal, file-local `ResizeObserverStub` class (`observe`/`unobserve`/`disconnect` no-ops) and assigned it to `globalThis.ResizeObserver` only if absent, inside `ServerSheet.test.tsx` itself -- not in `vitest.setup.dom.ts`, whose own header comment states "No global mocks... those belong in an individual test file, not here."
- **Files modified:** `apps/web/src/components/ServerSheet.test.tsx` (test-only; no production code touched).
- **Verification:** After the stub, all six cases ran and failed for the correct field-wiring reason (`TestingLibraryElementError: Unable to find an element with the text: sshUser must not contain whitespace.` -- confirmed below), not an environment crash.
- **Committed in:** `6319631` (Task 1 / RED commit).

---

**Total deviations:** 1 auto-fixed (1 blocking).
**Impact on plan:** Necessary to make the RED gate runnable at all; scoped entirely to the new test file, no production code or shared test setup touched. No scope creep.

## RED Gate Evidence (quoted failing assertion output)

Before Task 2's fix, `pnpm vitest run apps/web/src/components/ServerSheet.test.tsx` failed exactly 2 of 6 cases -- both and only the `sshUser` ones, as the plan required:

```
❯ apps/web/src/components/ServerSheet.test.tsx (6 tests | 2 failed)
  × renders a visible error and marks the SSH user field invalid on a server-side /sshUser VALIDATION_FAILED issue
  × renders the server-side error for the sshUser field when the backend targets it
```

The plain-case failure reason (not an aria-invalid string mismatch, not a harness error -- the message was genuinely absent from the DOM):

```
TestingLibraryElementError: Unable to find an element with the text: sshUser must not contain whitespace.. This could be
because the text is broken up by multiple elements. In this case, you can provide a function for your text matcher to
make your matcher more flexible.
```

The other four `it.each` guard cases (`name`, `host`, `sshPort`, `credential`) passed in the same RED run, confirming they already worked and this plan did not touch their wiring.

After Task 2's fix, the same command: `6 tests | 6 passed`.

## Issues Encountered

None beyond the ResizeObserver blocker documented above.

## Full Verification Sweep (Task 3)

All gates green on the first run; no fix-forward was needed.

- `pnpm lint` -- 9/9 package lint tasks passed (turbo).
- `pnpm typecheck` -- 8/8 package typecheck tasks passed, including `tests/e2e/tsconfig.json`.
- `pnpm test` -- **1497/1497** unit tests passed (up from the 1491 baseline recorded in STATE.md by exactly the 6 new `ServerSheet.test.tsx` cases).
- `pnpm check:ui-safety` -- all 9 repo-wide UI safety gates held (no new hex/rgb literals, no new `outline: none`, no new `dangerouslySetInnerHTML`, etc.).
- `pnpm exec playwright test tests/e2e/server-sheet.spec.ts` -- run **twice**, back to back, standalone invocations (not `--repeat-each`):
  - Run 1: **11/11 passed** (17.5s), including the new `/sshUser` case (#7, 405ms).
  - Run 2: **11/11 passed** (12.0s), including the new `/sshUser` case (#7, 390ms).
  - No flake across the two runs.

## Known Stubs

None. No hardcoded empty values, placeholder text, or unwired data sources were introduced.

## Threat Flags

None. This plan's only change to trust-boundary-relevant code is which `Field` renders an already-existing, already-trusted `issue.message` string (T-quick-260920-ly9-01 in the plan's own threat register, disposition `accept`) -- identical risk shape to the three sibling fields it mirrors. No new endpoint, auth path, file access pattern, or schema change was introduced.

## User Setup Required

None - no external service configuration required.

## Next Phase Readiness

- The `sshUser` field-error regression recorded in STATE.md's 05-37 finding and `05-GAP-CLOSURE-AUDIT.md` gap 5's "latent second bug" is closed and proven both at the component and E2E level.
- Per STATE.md's own recorded next steps, Phase 05 is still not ready to be declared complete: code review, the regression gate, and phase verification remain pending after this fix. The six human-only verification items (real-display contrast, real CI run, live SSE walkthrough, Sheet/Dialog/RowMenu elevation, screen-reader pass, sub-1280px/reduced-motion feel) recorded as "pendiente" in `05-GAP-CLOSURE-AUDIT.md` section 3 are unaffected by this quick task and remain unconfirmed.

---
*Quick task: 260920-ly9*
*Completed: 2026-09-20*

## Self-Check: PASSED

All claimed files exist on disk and both task commit hashes (`6319631`, `8d7091a`) are present in `git log --oneline --all`.
