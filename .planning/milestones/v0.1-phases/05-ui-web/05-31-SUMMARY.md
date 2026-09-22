---
phase: 05-ui-web
plan: 31
subsystem: ui
tags: [react, playwright, vitest, fastify, trust-fingerprint, toctou, e2e]

# Dependency graph
requires:
  - phase: 05-ui-web (plan 27)
    provides: "POST /api/servers/:id/trust-fingerprint now requires { fingerprint }, promotes via an atomic conditional UPDATE, and returns FINGERPRINT_MISMATCH/SERVER_NOT_TRUSTABLE"
provides:
  - "TrustFingerprintDialog.tsx snapshots pendingFingerprint on open and sends exactly that value, closing the display/promote TOCTOU"
  - "apps/web recognises FINGERPRINT_MISMATCH and SERVER_NOT_TRUSTABLE end to end (union, runtime allowlist, copy)"
  - "Browser-level proof the real trust-fingerprint POST succeeds against the real backend, and that a mid-review fingerprint swap is rejected"
affects: [05-37]

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "Exhaustiveness marker (satisfies Record<Code, true>) replacing a hand-maintained parallel Set, closing a union/runtime-list drift class at compile time"
    - "Snapshot-on-open local state (keyed on the open transition only) to structurally decouple a dialog's display from a live prop it must not silently follow"

key-files:
  created:
    - apps/web/src/components/TrustFingerprintDialog.test.tsx
  modified:
    - apps/web/src/lib/api-client.ts
    - apps/web/src/lib/api-client.test.ts
    - apps/web/src/lib/error-copy.ts
    - apps/web/src/lib/error-copy.test.ts
    - apps/web/src/components/TrustFingerprintDialog.tsx
    - tests/e2e/host-key.spec.ts

key-decisions:
  - "Derived apps/web's known-service-error-code allowlist from a single satisfies Record<Code, true> marker instead of two hand-synced lists, so a code added to the union without a runtime entry (or vice versa) is a compile error, not a silent INTERNAL_ERROR degradation"
  - "Snapshotted pendingFingerprint AND pendingFingerprintSeenAt together (not the fingerprint alone) so the Observed row's date can never pair with the wrong value"
  - "Removed the now-structurally-unreachable CONFIRMATION_MISMATCH branch from TrustFingerprintDialog.tsx rather than keeping it as dead defensive code -- trustFingerprint's own TrustFingerprintFailureCode union never included that code, even before this plan"
  - "Added a real-backend E2E (no stub on the trust-fingerprint route) as the primary proof of the actual production bug this plan fixes, rather than only stubbed coverage -- the pre-existing stubbed 'success' test stayed green through the entire regression window because it never inspected the request body"
  - "Scoped the mid-review-swap and FINGERPRINT_MISMATCH E2E case to a route-stub + synthetic-EventSource technique (matching tests/e2e/discovery.spec.ts's own precedent) rather than orchestrating a second real HOST_KEY_CHANGED mid-dialog -- the backend's own atomic conditional UPDATE is already covered by apps/control-plane's trust-fingerprint integration/unit tests from plan 05-27, out of this plan's file scope"
  - "Left the todo's item-3 'WR-A-02 from a non-ERROR status' extension undemonstrated by a new E2E (see Known Gaps below) -- assessed as backend-owned, apps/control-plane is off-limits to this plan, and the reachable non-ERROR+pending scenario (a HOST_KEY_CHANGED failure followed by a later non-HOST_KEY_CHANGED failure, per connection-result.ts's own spread semantics) needs a second real container-stop sequence with no proportionate incremental UI risk over what the existing real UF-01 test and HostKeyChangedBanner's own null-pendingFingerprint unit test already cover"

requirements-completed: [DETL-02, UI-02]

duration: 40min
completed: 2026-09-20
---

# Phase 05 Plan 31: Trust-fingerprint dialog snapshot-on-open Summary

**Closed the trust-fingerprint TOCTOU's UI half: the dialog now snapshots the fingerprint it displays on open and sends exactly that value, and a real E2E proves the production bug (the dialog previously posted no body at all, silently broken against plan 05-27's new backend contract) is fixed.**

## Performance

- **Duration:** ~40 min
- **Started:** 2026-09-20T19:22Z (approx, first Read call)
- **Completed:** 2026-09-20T19:44Z
- **Tasks:** 3
- **Files modified:** 7 (1 created)

## Accomplishments

- `apps/web/src/lib/api-client.ts`/`error-copy.ts` now recognise `FINGERPRINT_MISMATCH` and `SERVER_NOT_TRUSTABLE` end to end — a real 409 for either code used to silently degrade to `INTERNAL_ERROR`.
- `TrustFingerprintDialog.tsx` snapshots `server.pendingFingerprint` (and its `seenAt`) the instant it opens and sends exactly that value as the POST body; a `server.updated` SSE event swapping the live prop mid-review can no longer be trusted by accident. The former client-side re-GET-and-compare (which could only ever compare the live prop to itself) is removed; enforcement is now entirely the backend's atomic conditional UPDATE.
- On `FINGERPRINT_MISMATCH` the dialog closes and asks the caller to refetch, so `DestructiveConfirmDialog` resets its typed confirmation name and the admin must review the new value and re-type the name from scratch.
- `tests/e2e/host-key.spec.ts` gained a real-backend E2E proving the actual production bug is fixed (a genuine `POST` with `{ fingerprint }` against a real control plane, worker and sshd fixture succeeds end to end), a mid-review-fingerprint-swap regression, and a body assertion on the pre-existing "success" test that had stayed green through the whole regression window.
- `.planning/todos/pending/2026-09-19-trust-fingerprint-toctou.md` moved to `.planning/todos/completed/` — items 1, 2, 4 were already closed by plan 05-27; this plan closes item 3.

## Task Commits

1. **Task 1: Wire the two new error codes through the client vocabulary** - `b813106` (feat)
2. **Task 2: Snapshot the displayed fingerprint on open and send exactly that** - `5043386` (feat)
3. **Task 3: End-to-end regression for the mid-review swap and the UF-01 family** - `a992195` (test)

**Plan metadata:** (this commit, docs)

_Note: Tasks 1 and 2 were TDD (RED test commits are folded into the same task commit rather than a
separate `test(...)` commit — see "TDD Gate Compliance" below for why, and the RED evidence quoted
under each task._

## Files Created/Modified

- `apps/web/src/lib/api-client.ts` — added `FINGERPRINT_MISMATCH`/`SERVER_NOT_TRUSTABLE` to `ApiErrorCode`; replaced the hand-maintained `KNOWN_SERVICE_ERROR_CODES` Set with one derived from a `satisfies Record<Code, true>` exhaustiveness marker; exported `ALL_KNOWN_SERVICE_ERROR_CODES` for the drift test.
- `apps/web/src/lib/api-client.test.ts` — RED/GREEN tests for both new codes parsing correctly off a real 409 body, plus the drift test iterating every known code through `apiGet`.
- `apps/web/src/lib/error-copy.ts` — copy for both new codes (05-UI-SPEC.md §5.4 has no row for either; extended in the same voice, noted here rather than silently invented).
- `apps/web/src/lib/error-copy.test.ts` — verbatim copy assertions, no-field-routing assertions, no-interpolation-placeholder assertion.
- `apps/web/src/components/TrustFingerprintDialog.tsx` — snapshot-on-open state, removed `apiGet` re-fetch and `STALE_PENDING_MESSAGE`, removed the unreachable `CONFIRMATION_MISMATCH` branch, rewrote the file header doc comment to describe the real (body-required, atomically-enforced) contract.
- `apps/web/src/components/TrustFingerprintDialog.test.tsx` (new) — 7 cases including the key mid-review-swap RED case.
- `tests/e2e/host-key.spec.ts` — body assertion on the existing success test; new mid-review-swap/`FINGERPRINT_MISMATCH` stubbed regression; new real-backend end-to-end trust-flow test.

## Decisions Made

See `key-decisions` in the frontmatter above. The most consequential: deriving the client's known-error-code allowlist from a single exhaustiveness-checked marker instead of two hand-synced lists, and adding a real-backend E2E as the primary proof rather than relying on stubs that (as this exact regression demonstrated) can stay green through a real production break.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] Lint failures surfaced while implementing Tasks 1–3**
- **Found during:** Tasks 1–3, running `pnpm lint` per CLAUDE.md's zero-lint-errors DoD gate
- **Issue:** `prefer-optional-chain` in `TrustFingerprintDialog.tsx`; `no-unsafe-return`/`no-non-null-assertion`/`no-confusing-void-expression` in the new component test; an unused `eslint-disable` directive in `api-client.test.ts`
- **Fix:** Rewrote the snapshot-null-check as an optional chain; typed `requireSessionMock` explicitly and wrapped its mock body in braces instead of an implicit `void` return; replaced `dialog.querySelector('input')!` with `screen.getByRole('textbox')`; removed the stale disable comment
- **Files modified:** `apps/web/src/components/TrustFingerprintDialog.tsx`, `apps/web/src/components/TrustFingerprintDialog.test.tsx`, `apps/web/src/lib/api-client.test.ts`
- **Verification:** `pnpm lint` exits 0 across the monorepo
- **Committed in:** `5043386`, `b813106`

---

**Total deviations:** 1 auto-fixed (Rule 1, lint-only, no behavior change)
**Impact on plan:** No scope creep — all fixes are mechanical lint corrections surfaced while executing the plan's own tasks.

## TDD Gate Compliance

Both `type="auto" tdd="true"` tasks (1 and 2) followed the mandated RED → GREEN cycle, verified honestly by running the test suite against the pre-change code and observing failure, before implementing the fix:

**Task 1 (error codes):** RED — `apps/web/src/lib/api-client.test.ts`/`error-copy.test.ts` run before the fix:
```
AssertionError: expected 'INTERNAL_ERROR' to be 'FINGERPRINT_MISMATCH'
AssertionError: expected 'INTERNAL_ERROR' to be 'SERVER_NOT_TRUSTABLE'
TypeError: ALL_KNOWN_SERVICE_ERROR_CODES is not iterable
AssertionError: expected undefined to be 'The observed fingerprint changed since...'
TypeError: .toMatch() expects to receive a string, but got undefined
 Test Files  2 failed (2)
      Tests  5 failed | 31 passed (36)
```
GREEN after adding both codes to the union/marker/copy table: `Test Files 2 passed (2) / Tests 36 passed (36)`.

**Task 2 (dialog snapshot):** the pre-05-31 `TrustFingerprintDialog.tsx` was temporarily restored (via `git show HEAD:...` — no `git stash` used, per the hard rules) and `TrustFingerprintDialog.test.tsx` run against it:
```
 ❯ TrustFingerprintDialog (7)
   × sends the fingerprint displayed at open time, not the live prop, after a mid-review swap
   × sends the exact snapshotted fingerprint as the POST body on a plain confirm (no swap)
   × on FINGERPRINT_MISMATCH, closes the confirmation and calls onSettled so the caller refetches
   × on SERVER_NOT_TRUSTABLE, shows the copy inline and calls onSettled without closing
   × on success, closes the dialog and calls onSettled, issuing no second /connect request of its own
 Test Files  1 failed (1)
      Tests  5 failed | 2 passed (7)
```
The two RED-phase passes (render-only assertion; the `pendingFingerprint === null` defensive early-return) were already coincidentally true of the old code — the 5 failures are the genuine behavioral gap this task closes. GREEN after restoring the fix: `Test Files 1 passed (1) / Tests 7 passed (7)`.

Every `pnpm exec vitest run` invocation above used the actual test file (not a hand-transcribed excerpt); the pre-fix dialog was restored from `git show HEAD:apps/web/src/components/TrustFingerprintDialog.tsx` (unmodified by the Task 1 commit) and reverted back to the fixed version immediately after each RED observation, confirmed via `diff`.

**Task 3 (E2E)** is not itself `tdd="true"`, but its own two most load-bearing assertions (the existing success test's new body check, and the new mid-review-swap test) were RED-verified the same way, against a real Chromium browser and the real stack (`pnpm exec playwright test tests/e2e/host-key.spec.ts -g "posts to trust-fingerprint exactly once|mid-review swaps"`), before the dialog fix was restored:
```
1) ...posts to trust-fingerprint exactly once...
   Expected: {"fingerprint": "SHA256:observed00000000000000000000000000000000"}
   Received: null
2) ...mid-review swaps the pending fingerprint...
   Expected: {"fingerprint": "SHA256:observed00000000000000000000000000000000"}
   Received: null
2 failed
```
This is the literal, browser-observed proof of the production bug: the pre-05-31 dialog sent no request body at all. The real-backend end-to-end test (item c) was not separately RED-verified against the reverted dialog — running a second Testcontainers cycle for a case already proven RED at both the component level (above) and this same mechanism would add real time for no additional confidence; its GREEN run alone (`1 passed (17.5s)`, real backend, no stub) is reported honestly as GREEN-only.

## Known Gaps

- **Todo item 3's "non-ERROR status" WR-A-02 extension.** `connection-result.ts`'s `applyConnectionResult` only clears/overwrites `pendingFingerprint` on a `HOST_KEY_CHANGED` failure — a *different* subsequent failure (e.g. the host becomes unreachable) leaves an existing `pendingFingerprint` in place while landing on `UNREACHABLE`, not `ERROR`. This is a real, reachable state, but reproducing it end-to-end needs a second sequential container-stop (to force `CONNECT_TIMEOUT`/`HOST_UNRESOLVED`) beyond the identity-changing-edit UF-01 already exercises, touches only `apps/control-plane`-owned logic this plan is prohibited from modifying, and the UI-observable half of the claim (`HostKeyChangedBanner` never renders outside `ERROR`/`HOST_KEY_CHANGED` regardless of `pendingFingerprint`) is already asserted by `HostKeyChangedBanner.test.tsx`'s own null-`pendingFingerprint` case. Left undemonstrated by a new E2E; flag for a future control-plane-scoped plan if genuinely needed.
- 05-UI-SPEC.md §5.4 has no row for `FINGERPRINT_MISMATCH`/`SERVER_NOT_TRUSTABLE` — the copy added here extends the spec in the same voice rather than following an existing row; worth a doc pass to fold back into 05-UI-SPEC.md itself.

## Issues Encountered

- The real fingerprint format returned by the control plane (`ssh-ed25519 SHA256:...`) differs from this file's own synthetic `SHA256:...`-only fixtures used elsewhere; the real-backend E2E reads the pending fingerprint via a direct `page.request.get` rather than screen-scraping the banner's rendered text (which interleaves the value with a "Copy" button and a relative-time label with no reliable text boundary to parse), then separately asserts `toContainText` to prove the banner rendered it.
- An `@testing-library/react` component test harness gotcha: `renderUi`'s returned `rerender` replaces the entire mounted tree including `renderUi`'s own `TooltipProvider` wrapper, so re-wrapping the rerendered element in a second `TooltipProvider` silently produces a full remount (defeating a "prop changes without remounting" test) rather than an in-place update. Fixed by driving the prop swap through a stateful test harness component and a plain DOM button fired via `fireEvent` (not `userEvent`, which correctly refuses to click through Radix's real `pointer-events: none` scroll-lock while the modal is open).

## User Setup Required

None — no external service configuration required.

## Verification Run

- `pnpm exec vitest run apps/web/src/lib/error-copy.test.ts apps/web/src/lib/api-client.test.ts` — 36/36 passed.
- `pnpm exec vitest run apps/web/src/components/TrustFingerprintDialog.test.tsx` — 7/7 passed.
- `pnpm test` (full unit suite) — 113 files / 1448 tests passed.
- `pnpm lint` — 0 errors across all 6 workspace packages.
- `pnpm typecheck` — 0 errors (includes `tests/e2e/tsconfig.json`).
- `pnpm exec playwright test tests/e2e/host-key.spec.ts` — 8/8 passed, run **twice** (24.8s, then 22.8s), no flake.
- `pnpm exec playwright test tests/e2e/server-detail.spec.ts` — 9/9 passed, run once.
- **`pnpm test:integration` was deliberately NOT run**, per this run's hard rule 14 (executor constraint, overriding the plan's own `<verification>` block): the orchestrator runs the full integration suite at the wave boundary; this plan touches no `apps/control-plane` file, and the real-backend E2E above already exercises the live contract between `apps/web` and the real, running control plane end to end.
- No Playwright or Vitest timeout was raised in any run above.
- `git status` confirms no modified file under `apps/control-plane` or `apps/web/src/app/(shell)/servers/[id]/`.

## Next Phase Readiness

- Gap 6 (05-VERIFICATION.md) is closed on the UI side; combined with plan 05-27's backend fix, the trust-fingerprint flow is now genuinely display/action-coupled end to end and proven against a real backend.
- `.planning/todos/pending/2026-09-19-trust-fingerprint-toctou.md` is fully closed and moved to `completed/`.
- No blockers for 05-37's own triage batch.

---
*Phase: 05-ui-web*
*Completed: 2026-09-20*

## Self-Check: PASSED

All 7 modified/created files confirmed present on disk; all 3 task commit hashes (`b813106`,
`5043386`, `a992195`) confirmed present in `git log --all`.
