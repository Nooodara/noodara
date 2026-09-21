---
status: partial
phase: 05-ui-web
source: [05-VERIFICATION.md, 05-GAP-CLOSURE-AUDIT.md, 05-46-GATE.md]
started: 2026-09-20T22:18:21Z
updated: 2026-09-21T00:00:00Z
---

## Current Test

[round 2 checkpoint answered — see below]

At the 05-37 checkpoint the user approved closing the gap-closure wave ("Approve y haz un gsd quick del
sshUser bug") without stating which items were checked. None was confirmed.

At the 05-46 (round 2 closing gate) checkpoint, 2026-09-21, the user answered verbatim: "aprueba la
ronda, y arregla el CR-01 y WR-01 por favor" — the round is APPROVED, and the user separately asked
for CR-01 and WR-01 (see `05-REVIEW.md`) to be fixed as a follow-up `/gsd-quick` task, not as part of
this round. The user did not enumerate which of the seven items below they personally checked; the
per-item results below reflect only what the orchestrator directly observed in a live session with the
user (screenshots of each step), per `05-46-GATE.md` Section 4. Nothing is marked passed beyond what
the user actually stated or visibly demonstrated.

## Tests

### 1. Real visual quality of the new contrast tokens (status pills, primary button/accent-fill, segmented control, tertiary text) on an actual display, in both dark and light themes
expected: Reads as calm, minimal, consistent with the noodara-ux-apple skill; new -text/-fill tokens are legible and not visually jarring
why_human: All figures were computed by contrast.ts/contrast.test.ts against literal hex values, never seen rendered by a human. The user's checkpoint answer ('Approve y haz un gsd quick del sshUser bug') did not confirm this was checked.
result: [pending] — NOT CONFIRMED at the 05-46 checkpoint either. All screenshots the user sent during the round-2 session were dark mode; the user made no statement about link colour or the destructive-confirm button in either theme. See 05-46-GATE.md Section 4, item 2.

### 2. Theme toggle behavior on reload with a stored non-default theme, in a real browser
expected: No visible flash/flicker of the wrong theme; the stored theme persists correctly across reload
why_human: The hydration-mismatch fix (WR-C-01) is proven by a jsdom hydrateRoot/onRecoverableError unit test, not a real-browser observation.
result: [pending] — NOT CONFIRMED at the 05-46 checkpoint. The user made no statement about theme persistence or flicker on reload. See 05-46-GATE.md Section 4, item 6.

### 3. A full live walkthrough: add-server -> connect -> watch discovery fill in check-by-check -> detail -> activity -> settings, with SSE actually visible, not through a buffering tunnel (e.g. locally or behind a real reverse proxy, not a Cloudflare Quick Tunnel)
expected: Live list insertion, live discovery progress, and live activity/detail updates are visibly smooth and correct to a human observer
why_human: The only human walkthrough so far used a Cloudflare Quick Tunnel that buffers SSE; live updates have only ever been proven by E2E assertions, never watched by a human.
result: [pending] — NOT CONFIRMED at the 05-46 checkpoint, though partially exercised. The round-2 session ran over plain localhost (no tunnel), and the add → connect → discovery → detail path visibly worked in front of the user during the item-1 walkthrough, but the user never stated whether updates appeared without a manual reload. See 05-46-GATE.md Section 4, item 4.

### 4. Trust-new-fingerprint end to end on a real host-key change, and the revoked-session redirect behavior in a second tab
expected: The Trust dialog shows exactly the fingerprint the admin saw when it opened, and promotion behaves correctly; a session revoked in one tab redirects a second open tab to /login without a manual reload
why_human: Both are proven by Playwright/integration tests with synthetic or stubbed conditions in places; a human pass against real hardware/sessions has not occurred. Independently, this verification found GR-01/GR-02 (see gaps) — a human tester attempting this walkthrough should be aware the backend does not yet fully bind promotion to the fingerprint's originating failure.
result: [partial] — split at the 05-46 checkpoint. Trust-new-fingerprint half: PARTIALLY VERIFIED BY THE USER with screenshots — add+connect (pass), the HOST_KEY_CHANGED banner appearing on a real rotated key with a fingerprint byte-identical to the one read inside the container (pass), and a manual trust returning the server to Connected (pass). The AUTH_FAILED-refusal negative case was NOT performed by hand (no UI path exists to drive it; test-covered only, 11/11 in trust-fingerprint-binding.test.ts). While exercising this flow the user also reproduced CR-01 by hand (editing Host while parked in HOST_KEY_CHANGED leaves the server stuck with no Trust and no Connect/Retry control anywhere on the page) — see Gaps below. Revoked-session-in-a-second-tab half: NOT CONFIRMED — not attempted in this session. See 05-46-GATE.md Section 4, items 1 and 7.

### 5. Sheet/Dialog/RowMenu elevation (flat + hairline + backdrop-blur, no floating shadow) against the design skill, on a real display
expected: A human judges whether flat + hairline reads as an acceptable substitute for the skill's specified floating shadow, or looks undifferentiated from the page behind it
why_human: Subjective visual conformance judgment; not verifiable from source or automated tests.
result: [pending] — NOT CONFIRMED at the 05-46 checkpoint. No statement from the user. See 05-46-GATE.md Section 4, item 5.

### 6. RowMenu with a real screen reader (VoiceOver/NVDA); responsive behavior below 1280px on real touch hardware; prefers-reduced-motion's felt effect
expected: Menu open/closed state and item selection announced correctly; sidebar collapse/bottom-sheet nav behaves correctly on real touch hardware; reduced-motion degradation feels genuinely instant/static
why_human: Static ARIA-attribute audits and Playwright viewport-resize assertions cannot substitute for a real assistive-technology or device pass.
result: [pending] — NOT CONFIRMED at the 05-46 checkpoint. No statement from the user. See 05-46-GATE.md Section 4, item 5.

### 7. First real CI run and first real nightly run once this repository has a git remote
expected: ci.yml's security job passes on a real PR (proving the playwright-install fix works in the real runner); nightly.yml's e2e-repeat job passes 20/20 and its canary job passes in the same scheduled/workflow_dispatch run
why_human: No GitHub Actions run — CI or nightly — has ever executed for this repository; git remote -v is empty (independently confirmed in this session). This is QA-04/QA-05, correctly still Pending in REQUIREMENTS.md, and cannot be closed from this sandbox.
result: [not done] — reconfirmed at the 05-46 checkpoint: no git remote exists (`git remote -v` empty). QA-04/QA-05 stay Pending. See 05-46-GATE.md Section 4, item 3.

## Summary

total: 7
passed: 0
issues: 1
pending: 6
skipped: 0
blocked: 0

Note: test 4 is counted once, under "issues" (the CR-01 reproduction it surfaced), not split across
buckets — its trust-flow half is otherwise partial and its revoked-session half is otherwise pending;
see the per-test `result:` line above for the full breakdown.

## Gaps

### CR-01 (CRITICAL, from 05-REVIEW.md) — reproduced by hand during test 4

While the user was exercising the trust-new-fingerprint flow (test 4), they edited the server's `Host`
field while it was parked in `ERROR`/`HOST_KEY_CHANGED`. The result, confirmed by the user verbatim
("sigue en rojo, y aparece en not available sin el boton de trust sin boton de connect"): the server is
left in `Error` with the `HOST_KEY_CHANGED` banner still showing, "Trusted: not available" and
"Observed: not available", no Trust button, and no Connect/Retry control anywhere on the page — a real
UI dead end reachable through ordinary product use, not a contrived edge case. The security half
behaves correctly (both fingerprints clear; nothing is promotable). This is the same CR-01 the code
review of the round-2 delta found independently in source (`05-REVIEW.md`, `apps/control-plane/src/
services/edit-server.ts:229-275`, `apps/web/src/lib/detail-state.ts:60-86`). **OPEN** at the time of
this UAT update. Fix requested by the user at the 05-46 checkpoint, scheduled as a separate
`/gsd-quick` task, not part of this round.

### WR-01 (WARNING, from 05-REVIEW.md) — confirmed in code, not observed live

`trustFingerprint`'s successful promote never clears `lastErrorCode`, so the `HOST_KEY_CHANGED` banner
can keep rendering after a correct trust until the next connect attempt. The user did not state whether
they saw this during test 4's manual-trust step (1c in `05-46-GATE.md` Section 4); it is confirmed only
in code (`apps/control-plane/src/services/trust-fingerprint.ts:134-151`,
`apps/web/src/lib/detail-state.ts:31-34`). **OPEN**, same follow-up `/gsd-quick` task as CR-01.

### Five of seven items remain unconfirmed

Items 2 (contrast on real display), 5 (elevation/screen-reader/touch/reduced-motion), 6 (theme toggle
on reload) and 7 (revoked session in a second tab) received no statement from the user in this session
and remain fully open for a future UAT pass. Item 3 (real CI run) cannot be attempted until a git
remote exists.
