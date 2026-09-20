---
status: partial
phase: 05-ui-web
source: [05-VERIFICATION.md, 05-GAP-CLOSURE-AUDIT.md]
started: 2026-09-20T22:18:21Z
updated: 2026-09-20T22:18:21Z
---

## Current Test

[awaiting human testing]

At the 05-37 checkpoint the user approved closing the gap-closure wave ("Approve y haz un gsd quick del
sshUser bug") without stating which items were checked. None is confirmed.

## Tests

### 1. Real visual quality of the new contrast tokens (status pills, primary button/accent-fill, segmented control, tertiary text) on an actual display, in both dark and light themes
expected: Reads as calm, minimal, consistent with the noodara-ux-apple skill; new -text/-fill tokens are legible and not visually jarring
why_human: All figures were computed by contrast.ts/contrast.test.ts against literal hex values, never seen rendered by a human. The user's checkpoint answer ('Approve y haz un gsd quick del sshUser bug') did not confirm this was checked.
result: [pending]

### 2. Theme toggle behavior on reload with a stored non-default theme, in a real browser
expected: No visible flash/flicker of the wrong theme; the stored theme persists correctly across reload
why_human: The hydration-mismatch fix (WR-C-01) is proven by a jsdom hydrateRoot/onRecoverableError unit test, not a real-browser observation.
result: [pending]

### 3. A full live walkthrough: add-server -> connect -> watch discovery fill in check-by-check -> detail -> activity -> settings, with SSE actually visible, not through a buffering tunnel (e.g. locally or behind a real reverse proxy, not a Cloudflare Quick Tunnel)
expected: Live list insertion, live discovery progress, and live activity/detail updates are visibly smooth and correct to a human observer
why_human: The only human walkthrough so far used a Cloudflare Quick Tunnel that buffers SSE; live updates have only ever been proven by E2E assertions, never watched by a human.
result: [pending]

### 4. Trust-new-fingerprint end to end on a real host-key change, and the revoked-session redirect behavior in a second tab
expected: The Trust dialog shows exactly the fingerprint the admin saw when it opened, and promotion behaves correctly; a session revoked in one tab redirects a second open tab to /login without a manual reload
why_human: Both are proven by Playwright/integration tests with synthetic or stubbed conditions in places; a human pass against real hardware/sessions has not occurred. Independently, this verification found GR-01/GR-02 (see gaps) — a human tester attempting this walkthrough should be aware the backend does not yet fully bind promotion to the fingerprint's originating failure.
result: [pending]

### 5. Sheet/Dialog/RowMenu elevation (flat + hairline + backdrop-blur, no floating shadow) against the design skill, on a real display
expected: A human judges whether flat + hairline reads as an acceptable substitute for the skill's specified floating shadow, or looks undifferentiated from the page behind it
why_human: Subjective visual conformance judgment; not verifiable from source or automated tests.
result: [pending]

### 6. RowMenu with a real screen reader (VoiceOver/NVDA); responsive behavior below 1280px on real touch hardware; prefers-reduced-motion's felt effect
expected: Menu open/closed state and item selection announced correctly; sidebar collapse/bottom-sheet nav behaves correctly on real touch hardware; reduced-motion degradation feels genuinely instant/static
why_human: Static ARIA-attribute audits and Playwright viewport-resize assertions cannot substitute for a real assistive-technology or device pass.
result: [pending]

### 7. First real CI run and first real nightly run once this repository has a git remote
expected: ci.yml's security job passes on a real PR (proving the playwright-install fix works in the real runner); nightly.yml's e2e-repeat job passes 20/20 and its canary job passes in the same scheduled/workflow_dispatch run
why_human: No GitHub Actions run — CI or nightly — has ever executed for this repository; git remote -v is empty (independently confirmed in this session). This is QA-04/QA-05, correctly still Pending in REQUIREMENTS.md, and cannot be closed from this sandbox.
result: [pending]

## Summary

total: 7
passed: 0
issues: 0
pending: 7
skipped: 0
blocked: 0

## Gaps
