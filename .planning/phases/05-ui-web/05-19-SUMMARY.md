---
phase: 05-ui-web
plan: 19
subsystem: security
tags: [tofu, fingerprint, react, radix-ui, playwright, testcontainers, tdd, e2e]

# Dependency graph
requires:
  - phase: 05-ui-web
    provides: "05-14's server detail screen (deriveDetailState's host-key-changed state, ServerFacts's permanent fingerprint row, derivePrimaryAction's null action for ERROR/HOST_KEY_CHANGED); 05-01's UF-01 fix (editServer clearing pendingFingerprint on an identity-changing edit while ERROR); 05-23's DestructiveConfirmDialog/isConfirmationMatch/Notice/Banner/CopyButton/RelativeTime; 05-11's error-copy.ts/api-client.ts; 05-18's real sshd/@ssh-live E2E precedent"
provides:
  - "apps/web/src/lib/first-trust.ts: shouldShowFirstTrustNotice/dismissFirstTrustNotice, storage-injected pure decision logic for D-02's one-time notice -- stores only a fixed per-server marker, never a fingerprint or hostname"
  - "apps/web/src/components/FirstTrustNotice.tsx: the D-02 notice -- exact SS5.2 copy, the ssh-keygen -lf verification command, the fingerprint in full mono, Dismiss issuing no request"
  - "apps/web/src/components/HostKeyChangedBanner.tsx: the D-03 banner -- both fingerprints in full mono (never truncated), labelled Trusted/Observed with dates, the host:port they were observed against, the verification command, and the trust action hidden entirely once pendingFingerprint is null"
  - "apps/web/src/components/TrustFingerprintDialog.tsx: the type-the-name trust confirmation on DestructiveConfirmDialog, re-validating the pending fingerprint immediately before the real POST and refusing to send it if the value has changed, with no auto-connect"
  - "packages/ui/src/Dialog.tsx: DestructiveConfirmDialog gained an optional children slot (backward-compatible) so a caller can repeat rich content (mono fingerprints + copy buttons) above the confirm input"
  - "tests/e2e/host-key.spec.ts: 6 @hostkey E2E behaviours, the sixth driving a real, sequential pair of sshd Testcontainers fixtures on a fixed host:port to prove the UF-01 UI-level regression against the real API"
affects: [05-20 (the critical-path E2E can reuse this plan's real-sshd HOST_KEY_CHANGED precedent if it wants a genuine TOFU assertion of its own), any future plan touching trust-fingerprint.ts/edit-server.ts or the detail page's layout]

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "TrustFingerprintDialog re-fetches GET /api/servers/:id immediately before its real POST and compares the freshly-fetched pendingFingerprint against the one this dialog displayed, refusing to send the trust request at all on any mismatch (including a value that became null) -- narrows, but per the route's own no-body contract cannot fully eliminate, the display-versus-promote race; documented plainly as a residual finding rather than hidden"
    - "HostKeyChangedBanner/TrustFingerprintDialog treat pendingFingerprint === null as a real, reachable state (not defensive-only): once editServer's UF-01 fix clears it, the Trust new fingerprint action disappears structurally rather than becoming an unreachable dead click"
    - "Both fingerprint-bearing components use break-all, never Tailwind's truncate/text-overflow: ellipsis, so a fingerprint can never be silently cut off on screen"
    - "first-trust.ts's decision/persistence functions take an injected storage-like accessor (never localStorage directly), matching ThemeToggle.tsx's own try/catch-guarded pattern, so a throwing storage backend degrades to showing the notice rather than crashing the detail page"

key-files:
  created:
    - apps/web/src/lib/first-trust.ts
    - apps/web/src/lib/first-trust.test.ts
    - apps/web/src/components/FirstTrustNotice.tsx
    - apps/web/src/components/FirstTrustNotice.test.tsx
    - apps/web/src/components/HostKeyChangedBanner.tsx
    - apps/web/src/components/HostKeyChangedBanner.test.tsx
    - apps/web/src/components/TrustFingerprintDialog.tsx
    - tests/e2e/host-key.spec.ts
    - .planning/phases/05-ui-web/deferred-items.md
  modified:
    - apps/web/src/app/(shell)/servers/[id]/page.tsx
    - packages/ui/src/Dialog.tsx
    - packages/ui/src/Dialog.test.tsx
    - tests/e2e/server-detail.spec.ts

key-decisions:
  - "The real POST /api/servers/:id/trust-fingerprint route (read directly from routes/servers.ts + trust-fingerprint.ts before wiring) takes NO request body at all -- no confirmName, no fingerprint value, only :id. TrustFingerprintDialog therefore cannot structurally couple 'what it displayed' to 'what gets promoted' the way DeleteServerDialog's confirmName does; it closes as much of that gap as the API allows via an immediate re-GET-and-compare right before the real request, and documents the residual race in its own file-level comment rather than hiding it"
  - "CONFIRMATION_MISMATCH handling in TrustFingerprintDialog is real but structurally unreachable against the current backend (the route has no field to mismatch) -- kept as defensive handling per the plan's own acceptance criteria, explicitly commented as such"
  - "DestructiveConfirmDialog (packages/ui) gained an optional children slot (Rule 2, its own RED/GREEN cycle) so the trust dialog can repeat both fingerprints in mono above the input per SS5.7 -- backward-compatible, delete-server's own dialog is unaffected"
  - "HostKeyChangedBanner additionally renders 'Host: {host}:{port}' -- not literally in 05-UI-SPEC.md SS5.3's copy, but required by the executor's own security instructions (item 1: 'plus the host:port they were observed against') so an admin reviewing two fingerprints always knows which server they belong to"

requirements-completed: []

# Metrics
duration: ~50min
completed: 2026-09-19
---

# Phase 5 Plan 19: TOFU Surfaces (First-Trust Notice, HOST_KEY_CHANGED Banner, Trust Dialog) Summary

**The three TOFU-critical surfaces on the server detail screen -- D-02's one-time first-trust notice, D-03's dedicated HOST_KEY_CHANGED banner with both fingerprints in full mono, and a type-the-name trust dialog that re-validates the pending fingerprint immediately before sending it -- proven end to end against a real, sequential pair of sshd fixtures for the UF-01 regression.**

## Performance

- **Duration:** ~50 min
- **Completed:** 2026-09-19
- **Tasks:** 3 (Task 1 RED/GREEN; a standalone Dialog children-slot RED/GREEN before Task 2; Task 2 component-test RED/GREEN for the two pure presentational pieces, then the implementation + page-wiring commit; Task 3 E2E commit, plus one Rule 1 fix to a pre-existing E2E test)
- **Files modified:** 13 (9 new, 4 modified)

## Security Requirements Traceability

Per the executor's own numbered security requirements, mapped to implementation and proof:

1. **Both fingerprints shown in full, mono, never truncated, each copyable, labelled, plus host:port** -- `HostKeyChangedBanner.tsx` (Trusted:/Observed: rows, `break-all`, individual `CopyButton`s, `Host: {host}:{port}` row) and `TrustFingerprintDialog.tsx` (same rows repeated above the input via the new `children` slot). Proven by `HostKeyChangedBanner.test.tsx`'s "both fingerprints in full... with the host:port" test and `tests/e2e/host-key.spec.ts`'s banner-rendering `@hostkey` test.
2. **Copy states plainly what a changed key can mean, verify out-of-band, calm tone** -- the exact SS5.3 sentence (reinstalled/interception, verify on the server itself) renders verbatim; proven by the same E2E test asserting the full sentence text.
3. **Type-the-name via DestructiveConfirmDialog + isConfirmationMatch, exact match, Enter cannot bypass** -- `TrustFingerprintDialog` is built directly on the existing, already-tested `DestructiveConfirmDialog` (05-23), whose confirm button stays `disabled` until an exact match and has no separate Enter-submit path (`Dialog.test.tsx`'s own pre-existing coverage). Proven for this dialog specifically by `tests/e2e/host-key.spec.ts`'s disabled/near-miss `@hostkey` test.
4. **The trust action sends only what the backend expects; display and action cannot diverge; residual race documented plainly** -- the real route takes no body at all (confirmed by reading `routes/servers.ts`/`trust-fingerprint.ts` directly). `TrustFingerprintDialog` re-fetches the server immediately before the real POST and refuses to send it if the fetched `pendingFingerprint` no longer matches what was displayed. This narrows, but cannot fully close, the display-versus-promote race, since the server always promotes whatever is pending *at commit time*, a few milliseconds after this check -- documented as a residual finding in the file's own doc comment, not hidden. A backend change (the route accepting and verifying the exact fingerprint) would close this fully; out of this plan's scope.
5. **Server-driven state after trusting, never optimistic-survives-failure** -- on success the dialog closes and calls `onSettled` (the page's `fetchServer`), which refetches from the server; on failure the dialog stays open with the mapped error, no local "trusted" state is set anywhere. Proven by `tests/e2e/host-key.spec.ts`'s trust-success test asserting the real refetched `PENDING` status via the status pill.
6. **HOST_KEY_CHANGED banner persistent, no second competing primary action** -- `derivePrimaryAction` (05-14) already returns `null` for `ERROR`/`HOST_KEY_CHANGED`, unchanged by this plan; the banner is the only action surface for that state, and its own action disappears entirely once `pendingFingerprint` is cleared (UF-01 aftermath) rather than becoming a dead click. Proven by `tests/e2e/host-key.spec.ts`'s UF-01 regression test.
7. **First-trust notice: informational, full fingerprint, mono, copyable, dismissal is a non-sensitive per-server flag in try/catch** -- `first-trust.ts`/`FirstTrustNotice.tsx`, proven by `first-trust.test.ts` (8 unit tests, including the throwing-storage case) and `FirstTrustNotice.test.tsx`.
8. **No console logging of server-derived strings; single shared SSE connection** -- neither new component logs anything; the detail page's existing single `useServerEvents`/`subscribe` wiring is untouched, no new SSE subscription was added.

## UF-01 UI-Level Regression: What Was Actually Proven

`tests/e2e/host-key.spec.ts`'s sixth `@hostkey` test drives the real backend end to end, not a stub:

1. Starts a real `sshd-ubuntu-24.04` fixture on a fixed host port (`42544`, distinct from `tests/integration/ssh/host-key-changed.test.ts`'s `42522` and `connection-loss.test.ts`'s `42533`).
2. Registers a server against it through the real Add-server sheet ("Save and connect") and waits for a genuine `CONNECTED` status -- a real fingerprint is captured.
3. Stops that container and starts a second one on the exact same host:port (the fixture's entrypoint regenerates host keys on every start, matching `tests/integration/ssh/host-key-changed.test.ts`'s own established pattern).
4. Clicks "Re-run discovery" (the real toolbar primary action for `CONNECTED`), which drives a genuinely fresh SSH handshake (`connectAndDiscover` always re-establishes the session) -- this **really** fails with `HOST_KEY_CHANGED`, observed via the real banner appearing.
5. Edits the server's `host` field through the real edit sheet (navigating to `/servers`, opening the row menu, "Edit", changing Host, "Save") -- the identity-changing edit UF-01's own server-side fix (05-01) guards.
6. Navigates back to the detail page and asserts, against the **real API response**: the "Trust new fingerprint" button no longer exists anywhere on the page (the affordance is structurally gone, not merely disabled), the banner's Observed row reads "not available", and `GET /api/servers/:id` shows `hostFingerprint` unchanged from before the edit and `pendingFingerprint: null`.

This is the UI-level counterpart D-17 required, exercising the real `editServer` code path (not a mock), the real `trustFingerprint` route's absence of any promotable value, and the real detail-page rendering rule -- not just 05-01's own service-level regression test.

## Task Commits

1. **Task 1 RED: failing first-trust.ts test** - `08117cc` (test)
2. **Task 1 GREEN: first-trust.ts** - `2790a96` (feat)
3. **[deviation] RED: failing DestructiveConfirmDialog children-slot test** - `47fe27d` (test)
4. **[deviation] GREEN: DestructiveConfirmDialog gains an optional children slot** - `853c253` (feat)
5. **Task 2 RED: failing FirstTrustNotice/HostKeyChangedBanner component tests** - `b7d8c03` (test)
6. **Task 2 GREEN: the three components + detail-page wiring** - `c129e56` (feat)
7. **Task 3: E2E coverage (6 @hostkey behaviours incl. the real UF-01 regression)** - `1dddd11` (test)
8. **[fix] Scope the pre-existing CONNECTED fingerprint assertion to the Connection group** - `ded9f54` (fix)

**Plan metadata:** (this commit, docs: complete plan)

## Files Created/Modified

- `apps/web/src/lib/first-trust.ts` / `first-trust.test.ts` - `shouldShowFirstTrustNotice`/`dismissFirstTrustNotice`
- `apps/web/src/components/FirstTrustNotice.tsx` / `.test.tsx` - the D-02 notice
- `apps/web/src/components/HostKeyChangedBanner.tsx` / `.test.tsx` - the D-03 banner
- `apps/web/src/components/TrustFingerprintDialog.tsx` - the type-the-name trust confirmation
- `apps/web/src/app/(shell)/servers/[id]/page.tsx` - wires all three at the two remaining documented seams
- `packages/ui/src/Dialog.tsx` / `.test.tsx` - `DestructiveConfirmDialog`'s new `children` slot
- `tests/e2e/host-key.spec.ts` - 6 `@hostkey` behaviours
- `tests/e2e/server-detail.spec.ts` - scoped a pre-existing assertion to avoid a new, legitimate ambiguity
- `.planning/phases/05-ui-web/deferred-items.md` - the one out-of-scope flake found during verification

## Decisions Made

See `key-decisions` in frontmatter -- summarized: the trust-fingerprint route's real no-body contract meant display and action cannot be structurally coupled the way delete's `confirmName` is, so the dialog re-validates via a fresh GET immediately before the real POST and documents the residual race rather than hiding it; `CONFIRMATION_MISMATCH` handling is real but currently unreachable, kept defensively; `DestructiveConfirmDialog` gained a backward-compatible `children` slot; the banner additionally shows `Host: {host}:{port}`, beyond SS5.3's literal copy, per the executor's own security instructions.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 2 - Missing critical functionality] `DestructiveConfirmDialog` had no way to render rich content (fingerprints + copy buttons) above the confirm input**
- **Found during:** Planning Task 2, reading SS5.7's "fingerprints repeated in mono above the input" requirement against `Dialog.tsx`'s existing `body: string`-only contract
- **Issue:** The component's `body` prop is a plain string rendered as the Radix `Description` -- there was no seam for JSX content (mono fingerprint rows, individual `CopyButton`s) between the description and the type-the-name input, which the trust dialog's own security requirement (item 1: both fingerprints copyable, in full, above the input) needs.
- **Fix:** Added an optional, backward-compatible `children?: ReactNode` prop to `DestructiveConfirmDialogProps`, rendered between the description and the `Field`. `DeleteServerDialog`'s own usage (no `children` passed) is unaffected.
- **Files modified:** `packages/ui/src/Dialog.tsx`, `packages/ui/src/Dialog.test.tsx`
- **Verification:** `pnpm --filter @noodara/ui test src/Dialog.test.tsx` (11/11); `pnpm --filter @noodara/ui lint`/`typecheck` clean
- **Committed in:** `47fe27d` (test), `853c253` (feat)

**2. [Rule 1 - Bug] A pre-existing `server-detail.spec.ts` test became ambiguous once the first-trust notice existed**
- **Found during:** Final `pnpm test:e2e` verification pass (full suite, not `--grep @hostkey`)
- **Issue:** `tests/e2e/server-detail.spec.ts`'s CONNECTED test's own fixture already sets `hostFingerprintCapturedAt` (via `DISCOVERED_FACTS`), which now legitimately satisfies D-02's condition for showing the first-trust notice too -- the same fingerprint string appears twice on the page (once in the new notice, once in the permanent Connection-group row), and the test's bare page-wide `page.getByText('SHA256:...')` became a genuine Playwright strict-mode ambiguity.
- **Fix:** Scoped both the fingerprint-text and copy-button assertions to the `server-facts-connection` testid, matching `tests/e2e/host-key.spec.ts`'s own established disambiguation pattern.
- **Files modified:** `tests/e2e/server-detail.spec.ts`
- **Verification:** `pnpm test:e2e --grep @detail` (7/7); full `pnpm test:e2e` (68/68) afterward
- **Committed in:** `ded9f54` (fix)

---

**Total deviations:** 2 auto-fixed (1 Rule 2 missing-functionality gap in a shared `packages/ui` component this plan's own security requirements required, 1 Rule 1 bug in a pre-existing E2E test that this plan's new, correct behaviour legitimately exposed)
**Impact on plan:** Both were necessary for D-02/D-03 to hold as specified and for the full E2E suite to stay green; neither changed this plan's own scope or architecture.

## Known Stubs

None. Every surface this plan's `must_haves` names is real and wired to the real backend: the notice, the banner, the dialog, and the UF-01 regression all reach genuine API responses (the dialog's `@hostkey` success test uses `page.route` interception for the rendering/interaction proof, matching this phase's own established ADR-0005 precedent, but the UF-01 regression itself is 100% real, no stubs).

## Issues Encountered

- **Pre-existing, out-of-scope E2E flake found during verification:** `tests/e2e/servers-list.spec.ts`'s `"a row's actions menu is absent until opened..."` test timed out once in a full-suite run (after many real servers had accumulated in the shared stack from earlier specs, including this plan's own UF-01 real-server test) but passed in under a second when run in isolation against a fresh stack. Confirmed not caused by this plan (it never touches the servers-list screen or `ServerRow.tsx`/`ServerList.tsx`) -- logged to `.planning/phases/05-ui-web/deferred-items.md` per the scope-boundary rule, not fixed here. A second full-suite run afterward passed all 68 tests including this one.
- **Pre-existing Redis pub-sub subscriber flake in `pnpm security:scan-leaks`:** one run showed `"sse broadcaster subscriber redis error"`/`"sse broadcaster failed to start within the boot window"` and a resulting SSE-stream assertion failure in `canary-http.test.ts` -- the same class of machine-specific Docker/Redis pub-sub timing issue 05-01-SUMMARY.md already documented as pre-existing and unrelated to that plan's own scope. A second run immediately after passed 3/3 cleanly. Not caused by this plan (it touches no Redis/SSE-broadcaster wiring).

## User Setup Required

None -- no external service configuration required, no new packages installed (ADR-0000's provenance gate was never invoked; this plan needed nothing beyond what 05-01/05-11/05-14/05-18/05-23 already provide).

## Next Phase Readiness

- D-02 and D-03's TOFU surfaces are real, wired, and E2E-verified, including a genuine UF-01 UI-level regression against a real, sequential pair of sshd fixtures.
- **DETL-02 and UI-02 stay Complete** (already marked Complete by Plans 05-14/05-18) -- this plan replaces 05-14's own documented placeholder for the `host-key-changed` state with the real surfaces, but does not independently complete either requirement's own literal text for the first time; no new `requirements mark-complete` call was needed.
- The residual display-versus-promote race documented in `TrustFingerprintDialog.tsx`'s own file-level comment (item 4) is a genuine, narrow finding: closing it fully needs `POST /api/servers/:id/trust-fingerprint` to accept and verify the exact fingerprint being trusted, a backend change out of this plan's scope. Worth revisiting if a future plan touches `trust-fingerprint.ts`/`routes/servers.ts` for another reason.
- Plan 05-20's critical-path E2E can reuse this plan's real-sshd `HOST_KEY_CHANGED`-via-fixed-port precedent (`FIXED_HOST_PORT`, stop-then-restart-on-the-same-port) if it wants its own genuine TOFU assertion, following 05-18's `@ssh-live`/this plan's `@hostkey` established pattern.
- The two flakes noted under "Issues Encountered" remain open, pre-existing, and unrelated to this plan's own scope -- logged for whichever plan next touches the servers-list screen or the SSE broadcaster's Redis wiring.

---
*Phase: 05-ui-web*
*Completed: 2026-09-19*

## Self-Check: PASSED

Verified on disk: `apps/web/src/lib/first-trust.ts`, `first-trust.test.ts`,
`apps/web/src/components/FirstTrustNotice.tsx`, `FirstTrustNotice.test.tsx`,
`HostKeyChangedBanner.tsx`, `HostKeyChangedBanner.test.tsx`, `TrustFingerprintDialog.tsx`,
`apps/web/src/app/(shell)/servers/[id]/page.tsx`, `packages/ui/src/Dialog.tsx`, `Dialog.test.tsx`,
`tests/e2e/host-key.spec.ts`, `tests/e2e/server-detail.spec.ts`,
`.planning/phases/05-ui-web/deferred-items.md`. All eight task commits (`08117cc`, `2790a96`,
`47fe27d`, `853c253`, `b7d8c03`, `c129e56`, `1dddd11`, `ded9f54`) confirmed present in
`git log --oneline --all`. `pnpm test` (1348 tests), `pnpm lint`, `pnpm typecheck` (including
`tests/integration/ssh/tsconfig.json` and `tests/e2e/tsconfig.json`), `pnpm boundaries`,
`NOODARA_API_ORIGIN=http://127.0.0.1:3100 pnpm build`, and
`NOODARA_API_ORIGIN=http://127.0.0.1:3100 pnpm test:e2e` (68/68, `@hostkey` exactly 6/6, `@detail`
7/7) all green on a fresh run. `pnpm test:integration tests/integration/services/edit-server.test.ts`
(27/27, the UF-01 service regression) green. `pnpm security:scan-leaks` green on its second run
(see Issues Encountered for the pre-existing, unrelated first-run Redis flake). No stray
`noodara.test=true` container and no orphaned listener on ports 3000/3100 after any run.
