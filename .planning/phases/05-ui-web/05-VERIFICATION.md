---
phase: 05-ui-web
verified: 2026-09-20T23:45:00Z
status: gaps_found
score: "7/8 previous gaps genuinely closed, 1 previous gap wrongly marked closed by the gap-closure audit — 1 new BLOCKER found by direct code reading"
overrides_applied: 0
re_verification:
  previous_status: gaps_found
  previous_score: "0/6 truths fully verified (2 partial, 4 failed)"
  gaps_closed:
    - "Gap 1 / SC3 / DISC-02 — discovery no longer invents progress for unseen mid-run checks (confirmed by direct read of discovery-progress.ts + applyServer's liveChecks clearing)"
    - "Gap 2 / SC2 / DETL-01 / DETL-02 — detail-page snapshot/event race fixed (detail-sync.ts reconcileDetailSnapshot, confirmed by direct read); backend CONNECTING wedge fixed (connect-and-discover.ts try/catch + worker 'failed' listener, confirmed by direct read)"
    - "Gap 5 (partial, named residual) — the live sshUser-field-silently-swallowed regression found by the gap-closure audit is now fixed by quick task 260920-ly9 (commits 6319631/8d7091a), confirmed by direct read of ServerSheet.tsx: fieldErrors.sshUser is now wired to both error and invalid props"
    - "Gap 7 / SC4 / ACT-02 — activity background-refresh-wipes-list, silent->50-event gap, and UTC-vs-viewer-timezone day grouping all fixed, confirmed by direct read of activity/page.tsx and ActivityList.tsx"
    - "Gap 8 (batch) — root '/' route, ThemeToggle hydration mismatch, SSE backpressure eviction, revoked-session redirect, setup-token URL/Referrer-Policy, worker.ts boot guard, provenance gate's lockfile-derived 52/52 coverage — all confirmed present by direct code reading, none disputed by the independent code review"
    - "DoD (§2.2/§2.3) blockers from the original gap 4 — api-client.ts request timeout (AbortSignal.timeout/AbortSignal.any), CopyButton's guarded clipboard access, and the (shell)/error.tsx boundary + safeLocalStorage — all confirmed present by direct code reading"
  gaps_remaining:
    - "SC5 / QA-04 / QA-05 — correctly still Pending; no git remote exists, no GitHub Actions run (CI or nightly) has ever executed for this repository. This is a human/infrastructure item, not a code gap."
    - "Contrast residuals (DoD §2.2, UI-01) — two real, currently-shipping AA text-contrast failures remain, both disclosed and deliberately out of this wave's authorised scope: light-mode --accent link text on --canvas (4.31:1) / --surface-3 (4.12:1), and Button.tsx's destructive-filled variant, white on --status-error (3.54:1 light / 3.40:1 dark)."
    - "Contract seam (gap 5 residual) — no single test proves the real backend's VALIDATION_FAILED body (over real HTTP) is consumed correctly by the real frontend in the same test; the E2E that proves the frontend fix stubs the response body via page.route. Each end is independently proven (unit test pins the backend shape, E2E proves frontend consumption of that shape), but the seam itself is unclosed."
    - "WR-A-04 (err serializer) — only the one found call site (server.ts) was fixed; no lint rule or hooks.logMethod interceptor guards against a future logger.error(err) bare-Error call reintroducing the leak. Confirmed still true by direct grep (0 current violations, 0 regression-test coverage of the bare-Error shape)."
    - "Local build/boot-smoke defect — pnpm build and pnpm test:boot fail in ~2s locally unless NOODARA_API_ORIGIN is exported; reproduced directly in this session. CI is unaffected (workflow-level env: block sets it), but this is a real, unfixed local-DX gap."
  regressions:
    - "GAP 6 / Host-key trust bound to what the admin saw — the gap-closure audit (05-GAP-CLOSURE-AUDIT.md) claims this is CLOSED. Confirmed FALSE by direct, first-hand reading of apps/control-plane/src/services/trust-fingerprint.ts and packages/domain/src/server/connection-result.ts in this session: trust-fingerprint.ts never reads row.lastErrorCode, and applyConnectionResult's success branch and every non-HOST_KEY_CHANGED failure branch carry pendingFingerprint forward unchanged. A fingerprint parked by an earlier, since-superseded HOST_KEY_CHANGED event remains promotable later, under an unrelated failure (e.g. AUTH_FAILED after a credential rotation). This is not a new defect introduced by this wave — it is a defect the audit incorrectly reported as fixed."
gaps:
  - truth: "Host-key trust is bound to what the admin saw, and that binding is enforced by the backend, not only by the UI (CLAUDE.md §2.3 non-negotiable; TOFU security control)"
    status: failed
    reason: "GR-01 (05-REVIEW.md), independently confirmed by direct code reading in this session. apps/control-plane/src/services/trust-fingerprint.ts's trustFingerprint gates promotion only on status !== 'CONNECTING', pendingFingerprint !== null, and canTrustFingerprint(status) — it never reads row.lastErrorCode (confirmed: no occurrence of 'lastErrorCode' anywhere in the file). packages/domain/src/server/connection-result.ts's applyConnectionResult: the ok:true branch (lines 75-82) returns `{...state, ...}` with no `pendingFingerprint: null`, so a pendingFingerprint parked by an earlier HOST_KEY_CHANGED survives a later successful connect; the failure branch (lines 85-93) only overwrites pendingFingerprint when the new errorCode is HOST_KEY_CHANGED, and falls through to `state.pendingFingerprint` for every other code (AUTH_FAILED, COMMAND_TIMEOUT, etc.) — so a stale fingerprint also survives an unrelated later failure. The frontend (apps/web/src/lib/detail-state.ts:32,82) gates the entire Trust-fingerprint UI affordance on `lastErrorCode === 'HOST_KEY_CHANGED'` — this is exactly the 'restriction enforced only by the UI, never the backend' pattern CLAUDE.md §2.3 explicitly forbids relying on alone. Concrete scenario: server ERROR/HOST_KEY_CHANGED (pendingFingerprint=F_new, admin does not click Trust) -> a second attempt fails for an unrelated reason (e.g. AUTH_FAILED after a credential rotation) -> status stays ERROR, pendingFingerprint stays F_new, lastErrorCode becomes AUTH_FAILED -> the UI now hides the Trust button (gated on HOST_KEY_CHANGED), but POST /api/servers/:id/trust-fingerprint {fingerprint: F_new} still succeeds against the real backend, since the route only checks status===ERROR and pendingFingerprint===input.fingerprint. Also confirmed: tests/integration/services/trust-fingerprint.test.ts has no test case exercising a non-HOST_KEY_CHANGED lastErrorCode at promotion time — zero regression coverage for this exact scenario. The gap-closure audit's gap-6 verdict ('CLOSED... all three linked defects are fixed') is incorrect for this sub-case; only item (1) of the original WR-A-02 three-part fix (edit-server.ts's identity-change pendingFingerprint clear) was actually implemented. GR-02 (05-REVIEW.md, also independently plausible from the same files) is a related but lower-severity gap: edit-server.ts's identityChanged branch still only clears hostFingerprint inside the CONNECTED branch, so editing host/port from ERROR/UNREACHABLE/DISCONNECTED/PENDING leaves a stale hostFingerprint attached to a re-pointed row, guaranteeing a spurious HOST_KEY_CHANGED on the next connect (fails closed, but trains the admin to treat the warning as routine noise, undermining the same signal GR-01 is about)."
    artifacts:
      - path: "apps/control-plane/src/services/trust-fingerprint.ts"
        issue: "trustFingerprint never reads row.lastErrorCode; promotion is gated only on status/pendingFingerprint-equality, so a stale fingerprint parked by a resolved HOST_KEY_CHANGED event is promotable under any later ERROR-status failure"
      - path: "packages/domain/src/server/connection-result.ts"
        issue: "applyConnectionResult's ok:true branch (lines ~75-82) does not clear pendingFingerprint; the failure branch (lines ~85-93) only overwrites it for HOST_KEY_CHANGED, carrying it forward unchanged for every other error code"
      - path: "apps/control-plane/src/services/edit-server.ts"
        issue: "GR-02: identityChanged clears pendingFingerprint unconditionally but only clears hostFingerprint inside the status==='CONNECTED' branch (lines ~213-251), so an identity edit outside CONNECTED leaves a stale hostFingerprint attached to a re-pointed host"
      - path: "tests/integration/services/trust-fingerprint.test.ts"
        issue: "no test case exercises promotion attempted while lastErrorCode is not HOST_KEY_CHANGED — zero regression coverage for this exact bypass"
    missing:
      - "In trustFingerprint, refuse promotion unless row.lastErrorCode === 'HOST_KEY_CHANGED' (a new or reused failure code, e.g. SERVER_NOT_TRUSTABLE), before the conditional UPDATE."
      - "In applyConnectionResult's ok:true branch, clear pendingFingerprint (and pendingFingerprintSeenAt) — a stale parked fingerprint must not survive a successful connect."
      - "In applyConnectionResult's failure branch, clear pendingFingerprint when the new errorCode is not HOST_KEY_CHANGED, once the connection reaches a terminal outcome for a different reason."
      - "In edit-server.ts's identityChanged block, clear hostFingerprint/hostFingerprintCapturedAt unconditionally (not only inside the CONNECTED branch) — GR-02."
      - "Add an integration test: HOST_KEY_CHANGED parks F_new -> a second connect fails AUTH_FAILED -> POST /trust-fingerprint with F_new must return 409/SERVER_NOT_TRUSTABLE, not 200."
      - "Re-open .planning/todos/completed/2026-09-19-trust-fingerprint-toctou.md (currently marked closable/completed) — its disposition is not correct given this finding."
deferred: []
human_verification:
  - test: "Real visual quality of the new contrast tokens (status pills, primary button/accent-fill, segmented control, tertiary text) on an actual display, in both dark and light themes"
    expected: "Reads as calm, minimal, consistent with the noodara-ux-apple skill; new -text/-fill tokens are legible and not visually jarring"
    why_human: "All figures were computed by contrast.ts/contrast.test.ts against literal hex values, never seen rendered by a human. The user's checkpoint answer ('Approve y haz un gsd quick del sshUser bug') did not confirm this was checked."
  - test: "Theme toggle behavior on reload with a stored non-default theme, in a real browser"
    expected: "No visible flash/flicker of the wrong theme; the stored theme persists correctly across reload"
    why_human: "The hydration-mismatch fix (WR-C-01) is proven by a jsdom hydrateRoot/onRecoverableError unit test, not a real-browser observation."
  - test: "A full live walkthrough: add-server -> connect -> watch discovery fill in check-by-check -> detail -> activity -> settings, with SSE actually visible, not through a buffering tunnel (e.g. locally or behind a real reverse proxy, not a Cloudflare Quick Tunnel)"
    expected: "Live list insertion, live discovery progress, and live activity/detail updates are visibly smooth and correct to a human observer"
    why_human: "The only human walkthrough so far used a Cloudflare Quick Tunnel that buffers SSE; live updates have only ever been proven by E2E assertions, never watched by a human."
  - test: "Trust-new-fingerprint end to end on a real host-key change, and the revoked-session redirect behavior in a second tab"
    expected: "The Trust dialog shows exactly the fingerprint the admin saw when it opened, and promotion behaves correctly; a session revoked in one tab redirects a second open tab to /login without a manual reload"
    why_human: "Both are proven by Playwright/integration tests with synthetic or stubbed conditions in places; a human pass against real hardware/sessions has not occurred. Independently, this verification found GR-01/GR-02 (see gaps) — a human tester attempting this walkthrough should be aware the backend does not yet fully bind promotion to the fingerprint's originating failure."
  - test: "Sheet/Dialog/RowMenu elevation (flat + hairline + backdrop-blur, no floating shadow) against the design skill, on a real display"
    expected: "A human judges whether flat + hairline reads as an acceptable substitute for the skill's specified floating shadow, or looks undifferentiated from the page behind it"
    why_human: "Subjective visual conformance judgment; not verifiable from source or automated tests."
  - test: "RowMenu with a real screen reader (VoiceOver/NVDA); responsive behavior below 1280px on real touch hardware; prefers-reduced-motion's felt effect"
    expected: "Menu open/closed state and item selection announced correctly; sidebar collapse/bottom-sheet nav behaves correctly on real touch hardware; reduced-motion degradation feels genuinely instant/static"
    why_human: "Static ARIA-attribute audits and Playwright viewport-resize assertions cannot substitute for a real assistive-technology or device pass."
  - test: "First real CI run and first real nightly run once this repository has a git remote"
    expected: "ci.yml's security job passes on a real PR (proving the playwright-install fix works in the real runner); nightly.yml's e2e-repeat job passes 20/20 and its canary job passes in the same scheduled/workflow_dispatch run"
    why_human: "No GitHub Actions run — CI or nightly — has ever executed for this repository; git remote -v is empty (independently confirmed in this session). This is QA-04/QA-05, correctly still Pending in REQUIREMENTS.md, and cannot be closed from this sandbox."
---

# Phase 5: UI web — Re-verification Report (after gap closure)

**Phase Goal:** El admin completa de punta a punta el flujo login → Servers → add server → connect → discovery → detail usando el shell del design system Apple-inspired de Noodara, en dark y light, con estados vacío/carga/error en cada pantalla.

**Verified:** 2026-09-20
**Status:** gaps_found
**Re-verification:** Yes — after gap closure (05-26 … 05-37 plans, plus quick task 260920-ly9)

## Method

This report trusts no SUMMARY.md, no 05-GAP-CLOSURE-AUDIT.md verdict, and no prior code-review conclusion at face value. Every claim below marked "confirmed by direct read" was independently re-derived in this session by opening the named file and reading the cited lines, or by running the cited command myself. Where a finding matches the gap-closure audit's own claim, that is noted; where it contradicts it (gap 6), the contradiction is the headline finding of this re-verification.

Commands actually run in this session (not quoted from any prior report): `git remote -v` (empty), `git log --oneline -5` (HEAD = `86c2bbd`, matches the task's stated HEAD, tree clean for this repo), `pnpm lint` (9/9 cached, green), `pnpm typecheck` (8/8 cached, green), `pnpm test` (1497/1497 passed, 116 files — matches the quick-task SUMMARY's claimed post-fix count exactly), `pnpm boundaries` (613 files, 6 packages, no issues), `pnpm check:ui-safety` (9/9 gates OK), `(unset NOODARA_API_ORIGIN; pnpm build)` (reproduced the claimed F1 local-DX failure verbatim). The 36-minute integration suite and the ~1.5-minute-plus-stack-boot E2E suite were **not** re-run in this session, per the task's own instruction not to re-run the long integration suite; their prior results are treated as corroborating, not primary, evidence, except where this session's own direct source reading independently confirms the behavior they claim to test (gaps 1, 2, 5, 7, 8, and the DoD items below all have direct-read confirmation independent of any test run).

## Goal Achievement

### Re-derived verdict per previous gap (1–8)

| # | Previous gap | Audit's claim | This session's independent verdict | Evidence |
|---|---|---|---|---|
| 1 | SC3/DISC-02 — discovery invents progress on mid-run mount | CLOSED | **CLOSED — confirmed** | Direct read of `apps/web/src/lib/discovery-progress.ts:160-225`: `settled` is never referenced inside the `CONNECTING` branch; `lastReceivedIndex` (highest actually-received id) drives `hasUnresolvedEarlierCheck`, and `aggregateLiveStepState` (:138-145) returns `pending` — never `pass`/`running` — for any step with an unresolved earlier gap. `applyServer` in `servers/[id]/page.tsx:122-150` clears `liveChecks` on any transition into *or* out of `CONNECTING`, from either source. |
| 2 | SC2/DETL-01/DETL-02 — detail-page race + CONNECTING wedge | CLOSED | **CLOSED — confirmed** | Direct read of `apps/web/src/lib/detail-sync.ts` (`reconcileDetailSnapshot`, full read) and `servers/[id]/page.tsx:122-150` (`applyServer` is the single write path onto `state:{kind:'ready'}` — confirmed `grep -c "setState({ kind: 'ready'"` → 1). Direct read of `apps/control-plane/src/services/connect-and-discover.ts`: post-TX1 work is wrapped in try/catch that calls `failInFlightConnection` and rethrows; `connect-server-worker.ts`'s `'failed'` listener also calls it as a second line of defense (`grep -c "worker_job_failed"` → 1). |
| 3 | SC5/QA-04/QA-05 — CI/nightly never really run | OPEN by design | **OPEN — confirmed, correctly still Pending** | `git remote -v` empty (re-confirmed in this session). `docs/ci-readiness.md` (read in full) makes no completion claim. REQUIREMENTS.md still lists both Pending. This is a human/infrastructure item, not a code gap — see human_verification. |
| 4 | CLAUDE.md §2.2/§2.3 DoD bar | PARTIAL (4 named blockers closed, 2 residuals) | **PARTIAL — confirmed, matches audit** | Direct read confirms: `api-client.ts:238-245` has `AbortSignal.timeout`/`AbortSignal.any` (`composeSignal`); `CopyButton.tsx:37-45` feature-detects `clipboard?.writeText` before calling; `(shell)/error.tsx` exists and `servers/[id]/page.tsx` uses `safeLocalStorage()`. Residuals independently re-confirmed real: destructive-filled Button contrast (`Button.tsx:42-45`, `bg-status-error text-on-accent`) and `--accent`-as-link-text contrast (`docs/contrast-decision-05.md` §3/§5, independently cross-checked against the doc's own re-measured figures) remain unfixed by explicit, disclosed scope decision. |
| 5 | SC1/UI-02 — server-side field errors not rendered; sshUser latent bug found live by the audit | PARTIAL (named defect fixed; sshUser residual open, routed to a separate quick task) | **CLOSED for the named sshUser regression; contract seam remains as a disclosed residual, not a blocker** | Direct read of `apps/web/src/lib/error-copy.ts` (`normalizeFieldPath`) confirms the `/name`-style instancePath normalization. Direct read of `apps/web/src/components/ServerSheet.tsx:296-303` (post quick-task commits `6319631`/`8d7091a`) confirms the SSH user `Field` now renders `error={fieldErrors.sshUser}` and `invalid={fieldErrors.sshUser !== undefined}`, matching Name/Host/SSH port. Quick-task SUMMARY's RED evidence (`TestingLibraryElementError: Unable to find an element with the text: sshUser must not contain whitespace.`) is consistent with a genuine pre-fix failure. Residual seam (not a blocker): no single test proves the real backend's VALIDATION_FAILED body over real HTTP is rendered by the real frontend in the same test — confirmed by reading `tests/e2e/server-sheet.spec.ts:239-291` (response body supplied via `page.route`, a stub) and `tests/integration/routes/servers-crud.test.ts` (proves `issues` array exists over real HTTP but does not assert the leading-slash path shape against a form-field render). |
| 6 | Host-key trust bound to what the admin saw (TOFU) | CLOSED | **NOT CLOSED — FALSE CLAIM, confirmed by direct code reading** | See "Gaps" below. `trust-fingerprint.ts` never reads `lastErrorCode`; `connection-result.ts`'s `applyConnectionResult` carries a parked `pendingFingerprint` through a later success or a later non-HOST_KEY_CHANGED failure. The frontend hides the affordance based on `lastErrorCode`, but the backend does not enforce the same restriction — exactly the "UI-only permission restriction" CLAUDE.md §2.3 forbids relying on alone. |
| 7 | SC4/ACT-02 — activity refresh correctness | CLOSED | **CLOSED — confirmed** | Direct read of `apps/web/src/app/(shell)/activity/page.tsx:130-168`: the failure branch is `prev.kind === 'ready' ? prev : {kind:'error',...}` (keeps the loaded list on a background failure); `mergePage`'s `'refresh'` overload returns `{items, contiguous}` and resets to the fresh page when `contiguous` is false (closes the silent >50-event gap). `ActivityList.tsx` calls `groupByDay(state.items, now, viewerTimeZone)` with a real `Intl.DateTimeFormat().resolvedOptions().timeZone` default, closing the UTC-vs-viewer mismatch. |
| 8 | Triage batch (root route, hydration, SSE backpressure, err serializer, revoked-session, setup-token, worker boot guard, provenance) | 7/8 CLOSED, 1 PARTIAL (err serializer) | **Confirmed as claimed** | `apps/web/src/app/page.tsx` exists (`redirect('/servers')`); `ThemeToggle.tsx` uses an environment-independent initial `useState<Mode>('system')`; `events.ts` has `SSE_MAX_BUFFERED_BYTES`/`safeWrite`/`evict()`; `worker.ts:122-125` wraps `main()` in `.catch(...)`, `server.ts`'s equivalent is disclosed as knowingly untouched; `check-package-provenance.mjs` enumerates from the real locked tree (52/52, re-run in this session's spirit via the audit's own log, not independently re-executed here — the 28s provenance script was not re-run in this session, only its cited output was cross-checked against `package.json`/`pnpm-lock.yaml` shape). `logger.ts` still has no `hooks.logMethod` interceptor — PARTIAL confirmed as claimed, zero current violations but no future-regression guard (GR-05/GR-03/GR-04 add further minor, non-blocking residuals — see below). |

### New finding: GR-01 confirmed as a BLOCKER, not a WARNING

The task's prompt already told the orchestrator's own direct code read had confirmed GR-01's two central code facts. This verification independently re-derived both from scratch (not by trusting the prompt) by opening `apps/control-plane/src/services/trust-fingerprint.ts` and `packages/domain/src/server/connection-result.ts` in full:

- `trustFingerprint` (trust-fingerprint.ts:50-120) checks `row.status !== 'CONNECTING'`, `row.pendingFingerprint !== null`, and `canTrustFingerprint(row.status)` — **no occurrence of `lastErrorCode` anywhere in the file** (confirmed by reading the entire ~150-line file, not just grepping).
- `applyConnectionResult` (connection-result.ts:62-94): the `result.ok` branch (75-82) spreads `...state` and sets `lastErrorCode: null`, `hostFingerprint`, `lastSeenAt` — **no `pendingFingerprint: null`**, so a parked value survives a successful reconnect. The failure branch (85-93) sets `pendingFingerprint` to the new observed fingerprint only when `result.errorCode === 'HOST_KEY_CHANGED'`; the ternary's else-branch is `state.pendingFingerprint` — unconditional carry-forward for every other error code.
- The frontend's own gating (`apps/web/src/lib/detail-state.ts:32,82`) proves the UI-only nature of the current restriction: `primaryAction` returns `null` for the Trust action unless `lastErrorCode === 'HOST_KEY_CHANGED'`. The backend service has no equivalent check.
- `tests/integration/services/trust-fingerprint.test.ts` (all `it(...)` blocks read) has no case exercising promotion with a non-`HOST_KEY_CHANGED` `lastErrorCode` — zero regression coverage.

This is a genuine, concrete, exploitable-without-an-attacker sequence (see the gaps YAML for the exact scenario), not a theoretical edge case, and it directly contradicts `05-GAP-CLOSURE-AUDIT.md`'s "All three linked defects are fixed... exactly as WR-A-02's fix required" verdict for gap 6. Per CLAUDE.md §2.3 ("Toda restricción de permisos... se aplica en backend, nunca solo por prompt o UI"), this is classified **FAILED / BLOCKER**, not a residual warning.

### GR-02 … GR-05 assessment

| Finding | Verdict | Severity | Notes |
|---|---|---|---|
| GR-02 — `edit-server.ts`'s identity-change fix clears `pendingFingerprint` unconditionally but only clears `hostFingerprint` inside the `CONNECTED` branch | Confirmed real (direct read of `edit-server.ts:213-251`) | Warning — fails closed, but trains the admin to treat `HOST_KEY_CHANGED` as routine noise on an unrelated host re-point, undermining the GR-01 signal further | Bundled into the gap-6 gap entry below since both are part of the same "trust bound to what the admin saw" truth |
| GR-03 — a `failInFlightConnection` recovery-call failure inside `connectAndDiscover`'s catch is swallowed with no log line | Plausible from the description; not independently re-read line-by-line in this session (not blocking to phase goal) | Warning — CLAUDE.md §2.2 "logs adecuados" | Not structured as a separate gap; note for a future plan |
| GR-04 — SSE backpressure's 1 MiB budget bounds a heartbeat-only stuck peer only after ~9 days in the worst case, looser than the ~15-minute default TCP retransmission timeout it was meant to beat | Plausible arithmetic, not independently re-derived | Info/Warning — real fix, incomplete for the stated worst case; not a regression from a working state (no bound existed before) | Not structured as a separate gap |
| GR-05 — `check-package-provenance.mjs`'s `execFileSync` calls still lack the `timeout: 30_000` the original fix text named | Confirmed plausible; not independently re-read in this session | Warning — a 40-minute job-level `timeout-minutes` is a coarse backstop for what should be a fast per-call timeout | Not structured as a separate gap |

None of GR-02 through GR-05 block the phase's observable truths on their own; GR-02 is folded into the gap-6 structured gap below because it degrades the same trust signal.

## Required Artifacts (delta from initial verification)

| Artifact | Expected | Status | Details |
|----------|----------|--------|---------|
| `apps/web/src/lib/discovery-progress.ts` | check-by-check, no invented state, resets across run boundaries | ✓ VERIFIED | Confirmed fixed (gap 1) |
| `apps/web/src/lib/detail-sync.ts` | snapshot-vs-event ordering guard for the detail page | ✓ VERIFIED (new file) | Confirmed present and wired as the single write path |
| `apps/control-plane/src/services/connect-and-discover.ts` | no unrecoverable CONNECTING wedge on post-TX1 throw | ✓ VERIFIED | try/catch + `failInFlightConnection`, confirmed |
| `apps/control-plane/src/services/trust-fingerprint.ts` | promotion bound to the fingerprint's originating HOST_KEY_CHANGED failure | ✗ MISSING (this check) | Confirmed: no `lastErrorCode` check anywhere in the file — see gaps |
| `packages/domain/src/server/connection-result.ts` | pendingFingerprint cleared on success / non-host-key terminal failure | ✗ MISSING | Confirmed: `...state` carries it forward in both cases — see gaps |
| `apps/web/src/components/ServerSheet.tsx` | every `KNOWN_FORM_FIELD_PATHS` key renders its server-side error | ✓ VERIFIED | `sshUser` now wired (quick task 260920-ly9), confirmed by direct read |
| `apps/web/src/app/(shell)/activity/page.tsx` | background refresh keeps loaded list; no silent >50-event gap | ✓ VERIFIED | Confirmed |
| `apps/web/src/lib/api-client.ts` | explicit request timeout | ✓ VERIFIED | `AbortSignal.timeout`/`AbortSignal.any`, confirmed |
| `packages/ui/src/CopyButton.tsx` | guarded clipboard access | ✓ VERIFIED | Feature-detected before calling, confirmed |
| `apps/web/src/app/(shell)/error.tsx` | route-group error boundary | ✓ VERIFIED | Exists, confirmed |
| `apps/web/src/app/page.tsx` | root route | ✓ VERIFIED | Exists, `redirect('/servers')`, confirmed |
| `.github/workflows/ci.yml` / `nightly.yml` | playwright install before canary; never actually executed as real CI | ✓ VERIFIED (fix) / ✗ STILL UNPROVEN (real run) | Fix confirmed present; no remote exists, so no real run has occurred — correctly still human/QA-gated |

## Behavioral Spot-Checks (run in this session)

| Behavior | Command | Result | Status |
|----------|---------|--------|--------|
| Lint | `pnpm lint` | 9/9 tasks green (cached, FULL TURBO) | ✓ PASS |
| Typecheck | `pnpm typecheck` | 8/8 tasks green (cached, FULL TURBO) | ✓ PASS |
| Unit tests | `pnpm test` | 116 files, **1497/1497** passed, 6.80s | ✓ PASS — matches quick-task SUMMARY's claimed post-sshUser-fix count exactly |
| Boundaries | `pnpm boundaries` | "Checked 613 files in 6 packages, no issues found" | ✓ PASS |
| UI safety gates | `pnpm check:ui-safety` | 9/9 gates OK | ✓ PASS |
| No debt markers in phase-touched source | `grep -rn "TBD\|FIXME\|XXX"` across `apps/web/src`, `packages/ui/src`, `apps/control-plane/src`, `packages/domain/src` (excluding `*.test.*`) | 0 matches | ✓ PASS |
| Local build fails without `NOODARA_API_ORIGIN` | `(unset NOODARA_API_ORIGIN; pnpm build)` | `Error: NOODARA_API_ORIGIN is required...`, exit 1 | ✓ CONFIRMED (real, pre-existing local-DX gap; does not affect CI, which sets the var at workflow level) |
| `trust-fingerprint.ts` never reads `lastErrorCode` | Full read of the file + `grep -n "lastErrorCode" apps/control-plane/src/services/trust-fingerprint.ts` | No output | ✓ CONFIRMED (BLOCKER — see gaps) |
| `git remote -v` | `git remote -v` | empty | ✓ CONFIRMED — QA-04/QA-05 correctly Pending |
| Git tree state | `git log --oneline -5`, `git status --short` (scoped to `noodara/code`) | HEAD `86c2bbd` matches task's stated HEAD; tree clean for this repo | ✓ CONFIRMED |

The 36-minute integration suite and the full E2E suite were not re-run in this session (per instruction not to re-run the long integration suite; the E2E suite requires the same Testcontainers stack boot and was treated the same way for consistency). Every claim above that depends on integration/E2E evidence is corroborated instead by direct source reading in this session, which is a stronger form of evidence for the specific defects/fixes in question (a passing test proves the tested path works; direct reading proves the code does or does not contain the described logic at all).

### TDD process (item 8 of the task)

Plans 05-28, 05-30, 05-32, 05-34, 05-35 each combine their RED test and GREEN fix into a single commit per task rather than separate `test:`/`fix:` commits. Checked against `.claude/skills/noodara-tdd/SKILL.md:22`: **"también es aceptable un solo commit por ciclo completo"** (a single commit per full cycle is also acceptable) is an explicit, documented project allowance — this is **not** a TDD violation. Each of the five plans' SUMMARY.md files quotes the literal RED failure output observed before the fix (e.g. 05-30's normalize-path RED, 05-34's SSE-backpressure RED, 05-35's hydration-mismatch RED via `onRecoverableError`), which is consistent with a real RED→GREEN cycle having occurred even though it landed in one commit. **Verdict: compliant, no gap.**

## Requirements Coverage

| Requirement | REQUIREMENTS.md | This re-verification | Evidence |
|---|---|---|---|
| SERV-04 | Complete | ✓ SATISFIED | No defect ever found against this requirement |
| DETL-01 | Complete | ✓ SATISFIED | Gap 2 fix confirmed by direct read; no longer BLOCKED |
| DETL-02 | Complete | ✓ SATISFIED | Same — `deriveDetailState` always lands on one of the two named states now that the CONNECTING wedge is fixed |
| ACT-02 | Complete | ✓ SATISFIED | Gap 7 fix confirmed by direct read |
| SET-01 | Complete | ✓ SATISFIED | No defect ever found |
| UI-01 | Complete | ⚠ SATISFIED WITH DISCLOSED RESIDUALS | Shell/dark/light/keyboard-nav all present; two real, disclosed AA-contrast residuals remain (--accent link text, destructive-filled button) — do not block the literal requirement text but are a real DoD §2.2 gap |
| UI-02 | Complete | ✓ SATISFIED (sshUser regression now fixed) | Field-error rendering fixed for all 5 KNOWN_FORM_FIELD_PATHS keys; contract seam noted as residual, not a blocker |
| DISC-02 | Complete | ✓ SATISFIED | Gap 1 fix confirmed by direct read |
| QA-04 | Pending | **Pending — correct, confirmed** | No git remote, no real CI/nightly run has ever occurred |
| QA-05 | Pending | **Pending — correct, confirmed** | Same reason; local `security:scan-leaks` fix is necessary but unobserved on real CI |

**No orphaned requirements**: `grep -n "Phase 5" .planning/REQUIREMENTS.md` returns exactly the same 10 IDs declared in the phase's frontmatter (`SERV-04, DETL-01, DETL-02, ACT-02, SET-01, UI-01, UI-02, DISC-02, QA-04, QA-05`) — full accounting confirmed, re-checked in this session.

**Note on REQUIREMENTS.md accuracy**: REQUIREMENTS.md's `Complete` markings for DETL-01/DETL-02/ACT-02/DISC-02/UI-01/UI-02 are now substantively earned (the underlying defects this verification's predecessor found are genuinely fixed). None of the 10 requirement IDs literally names "host-key trust" or "TOFU" as their text — the GR-01/gap-6 finding is scoped by this verification as a CLAUDE.md §2.3 Definition-of-Done violation and a direct contradiction of the phase's own gap-closure audit, not as a requirement-ID regression. It is still a BLOCKER for declaring the phase's security posture sound.

## Anti-Patterns Found (delta)

| File | Line | Pattern | Severity | Impact |
|------|------|---------|----------|--------|
| `apps/control-plane/src/services/trust-fingerprint.ts` | 50-120 | No `lastErrorCode` gate before promoting a pending fingerprint | 🛑 Blocker | A stale fingerprint parked by a resolved HOST_KEY_CHANGED event remains promotable under an unrelated later failure — backend does not independently enforce the TOFU binding the UI assumes |
| `packages/domain/src/server/connection-result.ts` | 75-93 | `pendingFingerprint` not cleared on success or on a non-host-key failure | 🛑 Blocker | Root cause of the above; also means the field is never cleared by the domain layer at all except via `trustFingerprint` itself or an identity-changing edit |
| `apps/control-plane/src/services/edit-server.ts` | 213-251 | `hostFingerprint` only cleared inside the `CONNECTED` branch of an identity-changing edit | ⚠️ Warning | GR-02 — guarantees a spurious `HOST_KEY_CHANGED` on next connect after a non-CONNECTED identity edit, training admins to ignore the signal |
| `apps/web/src/components/ServerSheet.tsx` / `tests/e2e/server-sheet.spec.ts` | n/a | No single test proves real-backend VALIDATION_FAILED shape rendered by the real frontend in one test (E2E stubs the response body) | ⚠️ Warning | Contract seam — each end is independently proven, not jointly |
| `packages/ui/src/Button.tsx` | 42-45 | `DESTRUCTIVE_FILLED_CLASSES` (white on `--status-error`) fails AA (3.54:1 light / 3.40:1 dark) | ⚠️ Warning | Delete-confirmation button text under-contrast; disclosed, unfixed, never in any gap-closure plan's scope |
| `packages/ui/tokens.css` (`--accent`) | n/a | `--accent` as link-text foreground on `--canvas`/`--surface-3` fails AA in light mode (4.31/4.12:1) | ⚠️ Warning | Real render sites in `ActivityRow.tsx` and `servers/[id]/page.tsx`; disclosed, deliberately deferred per user's D2 decision |
| `apps/control-plane/src/logger.ts` | 40-44 | No `hooks.logMethod` interceptor guarding future bare-`Error`-as-first-arg log calls | ℹ️ Info | WR-A-04 residual — 0 current violations, no regression guard against a future one |
| `apps/web`, `apps/control-plane` (workspace-level) | n/a | `pnpm build`/`pnpm test:boot` fail in ~2s locally without `NOODARA_API_ORIGIN` exported | ⚠️ Warning | Real local-DX defect, reproduced directly in this session; CI unaffected |
| No TBD/FIXME/XXX debt markers found in phase-touched source | — | — | ℹ️ Info | Confirmed, re-run in this session |

## Human Verification Required

See frontmatter `human_verification:` — 7 items. None can be marked checked: the user's verbatim checkpoint answer ("Approve y haz un gsd quick del sshUser bug") approved closing the wave and requested the sshUser fix, but did not confirm which (if any) of the visual/live/accessibility/CI items were personally verified. All 7 remain open, consistent with the gap-closure audit's own honest recording of this fact.

## Gaps Summary

This re-verification confirms **7 of the 8** previous gaps are genuinely closed by direct, independent code reading — the gap-closure wave's engineering work on discovery invented-progress, the detail-page race, the CONNECTING wedge, activity-refresh correctness, the root route, theme-toggle hydration, SSE backpressure, the revoked-session redirect, setup-token hardening, the provenance gate, and the core DoD hardening (timeouts, clipboard, storage, error boundary) is real, substantive, and — where checked — correctly test-proven against real backends/browsers rather than stubs.

**One previous gap — gap 6, host-key trust bound to what the admin saw — is not closed**, despite `05-GAP-CLOSURE-AUDIT.md` explicitly asserting it is ("All three linked defects are fixed... exactly as WR-A-02's fix required, including the sshUser case"). This verification independently re-derived, from a cold read of the two files involved, that the backend never checks `lastErrorCode` before promoting a pending fingerprint, and the domain layer never clears a parked fingerprint on success or on an unrelated later failure. The only implemented part of the original three-part WR-A-02 fix is the `edit-server.ts` identity-change clear. This is a BLOCKER per CLAUDE.md §2.3's non-negotiable rule that permission/trust restrictions must be enforced in the backend, not only by the UI — and the UI here does exactly that: it hides the Trust affordance based on `lastErrorCode`, while the backend enforces no equivalent check.

QA-04/QA-05 remain correctly Pending — this is not a code gap this verification can close, only a human action (push to a remote, observe a real CI/nightly run) can. Two disclosed, real AA-contrast residuals and one disclosed logging-guard residual remain, all explicitly out of this wave's authorised scope and known to the team; they do not block the phase's core observable truths but are noted for completeness per the DoD bar.

**This does not look like an intentional deviation for gap 6.** The gap-closure audit's CLOSED verdict was a mistake (confirmed independently, not merely re-asserting the code review's finding), not a documented, accepted trade-off — no override is suggested. Given the phase's own documented history of confident-but-wrong subagent claims (this is now at least the second time a security-relevant gap-6-class finding was declared closed prematurely, after the SSE subscriber race and the canary "memory pressure" misattribution earlier in this phase), the recommended next step is a focused gap-closure plan touching exactly `trust-fingerprint.ts`, `connection-result.ts`, `connection-result.test.ts`, and `edit-server.ts`, with a new integration test pinning the exact bypass scenario before it is called closed again.

---

_Verified: 2026-09-20_
_Verifier: Claude (gsd-verifier)_
