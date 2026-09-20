---
phase: 05-ui-web
verified: 2026-09-20T23:00:00Z
status: gaps_found
score: "0/6 truths fully verified (2 partial, 4 failed) — see per-criterion verdicts"
overrides_applied: 0
gaps:
  - truth: "SC3 — El progreso del discovery se muestra check por check, nunca un spinner genérico ni progreso inventado"
    status: failed
    reason: "Confirmed by direct code reading: apps/web/src/lib/discovery-progress.ts's firstUnresolvedIndex assumes the page observed the run from its first check. A page that mounts mid-run (the normal 'Save and connect' navigation path, or any SSE reconnect mid-run) renders unseen-but-earlier checks as Running/Pass via aggregateSettledStepState, i.e. invents progress that was never received. Directly violates D-05 and the plan's own named rule ('la regla de no inventar progreso', 05-18-PLAN.md)."
    artifacts:
      - path: "apps/web/src/lib/discovery-progress.ts"
        issue: "firstUnresolvedIndex / aggregateSettledStepState render unseen earlier checks as resolved when the page joins mid-run (lines ~118-172, per 05-REVIEW.md WR-B-03)"
      - path: "apps/web/src/app/(shell)/servers/[id]/page.tsx"
        issue: "liveChecks is only cleared on the SSE-observed CONNECTING transition (line ~128-130), never when CONNECTING is learned from a GET snapshot, and never cleared on transition out of CONNECTING — a finished run's checks can render as the next run's live progress (05-REVIEW.md WR-B-02, confirmed by direct reading of lines 107-165: no clearing on the fetchServer branch)"
    missing:
      - "Compute lastReceivedIndex from the actually-received check ids; ids before it that were never received must render pending/unknown, never running/pass, and must be excluded from aggregation."
      - "Clear liveChecks on any transition out of CONNECTING, and route the fetch-branch CONNECTING transition through the same clearing logic as the SSE branch."
  - truth: "SC2 — El detalle del servidor muestra los hechos de forma fiable, distinguiendo 'aún no descubierto' de 'discovery falló' con una acción cada uno"
    status: failed
    reason: "Two confirmed, ordinary-interleaving bugs make the detail screen show wrong or permanently stuck state. (1) apps/web/src/app/(shell)/servers/[id]/page.tsx's fetchServer sets state from every GET unconditionally — no updatedAt guard, no latestRequestRef, no deletedRef (verified directly: lines 107-132 assign setState({kind:'ready', server: result.data}) with no comparison against the currently held server). A GET that races a live server.updated/server.deleted event can leave the page showing a stale 'Connecting...' forever, or resurrect a deleted server. (2) apps/control-plane/src/services/connect-and-discover.ts runs decodeCredential/parseFingerprint/session.close/TX2 with no try/catch after TX1 commits CONNECTING (verified directly: lines 286-345); the worker's 'failed' listener (connect-server-worker.ts:99-101) only logs and never calls failInFlightConnection — only the 'stalled' listener does that, which does not fire for a job that throws and fails outright. A credential-decode failure (e.g. after key rotation) therefore wedges the row in CONNECTING permanently (until a worker restart's sweep), which the UI renders as an endless spinner-equivalent 'Connecting...' with every mutation refused as SERVER_BUSY — neither of DETL-02's two named states."
    artifacts:
      - path: "apps/web/src/app/(shell)/servers/[id]/page.tsx"
        issue: "No snapshot-vs-event ordering guard (lines 107-165); confirmed by direct reading, contrasts with apps/web/src/app/(shell)/servers/page.tsx which does have reconcileSnapshot protection"
      - path: "apps/control-plane/src/services/connect-and-discover.ts"
        issue: "No try/catch around decodeCredential/parseFingerprint/session.close/TX2 after TX1 commits CONNECTING (lines 286-345)"
      - path: "apps/control-plane/src/queue/connect-server-worker.ts"
        issue: "'failed' listener (lines 99-101) only logs; failInFlightConnection is only reachable via 'stalled', not 'failed'"
    missing:
      - "A shared applyServer(next, source) on the detail page: keep latestRequestRef, drop a snapshot older than the held server's updatedAt, remember deletedRef."
      - "Wrap connect-and-discover.ts's post-TX1 work in try/catch that calls failInFlightConnection and rethrows; mirror in the worker's 'failed' listener."
  - truth: "SC5 — El E2E cubre el flujo crítico y el nightly lo repite 20/20 en el mismo run que el canary de secrets"
    status: failed
    reason: "REQUIREMENTS.md itself marks QA-04 and QA-05 as Pending, not Complete — the team's own bookkeeping agrees this criterion is not met. Verified independently: this repository has no git remote (git remote -v empty) and .github/workflows/nightly.yml's own header comment states the schedule trigger 'cannot actually fire yet' and 'has never executed as a real scheduled (or workflow_dispatch) GitHub Actions run.' The 20/20 and 100-connection evidence is a local simulation only, not a CI run. Worse, the CI security job that would run the canary on every PR is itself broken: verified directly that .github/workflows/ci.yml's security job (lines 156-243) never runs `pnpm exec playwright install`, while `pnpm security:scan-leaks` (package.json) runs `playwright test --grep @canary`, which requires a browser binary — first real run fails before testing anything. Additional CI defects (WR-C-12/13: no job-level permissions, no timeout-minutes on long jobs, unpinned actions, unchecked curl|tar) were not independently re-verified by this pass but are consistent with the confirmed pattern of an unexercised CI configuration."
    artifacts:
      - path: ".github/workflows/ci.yml"
        issue: "security job (lines 156-243) has no `playwright install` step before `pnpm security:scan-leaks`, which invokes `playwright test --grep @canary`; confirmed by grep — first CI run fails"
      - path: ".github/workflows/nightly.yml"
        issue: "on: schedule cannot fire — repository has no remote (verified: git remote -v empty); the workflow has never executed as a real GitHub Actions run, only via local simulation"
    missing:
      - "Add `pnpm exec playwright install --with-deps chromium` to the security job (mirrors the e2e/nightly jobs, which already have it)."
      - "Push the repository to a remote and let nightly.yml execute for real at least once before QA-04/QA-05 can honestly move to Complete; local simulation is not equivalent to the criterion's literal wording ('el nightly lo repite... en el mismo run')."
    deferred_note: "QA-04/QA-05 already correctly marked Pending by the team in REQUIREMENTS.md — this gap formalizes why, and adds the newly-found CI security-job defect that blocks even a first attempt."
  - truth: "CLAUDE.md §2.2/§2.3 Definition of Done bar (explicit part of this verification's scope per task instructions)"
    status: failed
    reason: "Multiple confirmed violations. (1) §2.3 'Timeouts explícitos en toda operación remota': apps/web/src/lib/api-client.ts has zero AbortController/AbortSignal/timeout usage — verified directly by grep; a hung control-plane response hangs the fetch indefinitely. This also contradicts what was told to the user in the wave-4 report per 05-REVIEW.md's own orchestrator spot-check. (2) 'Manejo de errores explícito. Ningún fallo de infraestructura... tumba la API' (extended in spirit to the UI not crashing on an environment condition): confirmed directly — packages/ui/src/CopyButton.tsx calls navigator.clipboard.writeText(...) unguarded; on any non-secure-context origin (Noodara's own explicit v0.1 target: plain-HTTP self-hosted, NOODARA_COOKIE_INSECURE exists for exactly this) navigator.clipboard is undefined and the call throws synchronously, before .catch can run. apps/web/src/app/(shell)/servers/[id]/page.tsx dereferences window.localStorage directly in render (line ~218) outside any try/catch; no apps/web/src/app/**/error.tsx exists (verified: find returned nothing) — a blocked-storage browser profile hard-crashes the detail screen with no recovery UI. (3) 'UX consistente con el design system': verified independently by recomputing WCAG relative luminance for --on-accent #ffffff on --accent #2997ff (the dark-mode, i.e. default, primary action color) = 3.02:1, below the 4.5:1 AA threshold — every primary button, selected segmented-control option and the skip link fails contrast in the theme every fresh install boots into. (4) 'altas [vulnerabilidades] solo con mitigación documentada': the trust-fingerprint display/action TOCTOU (.planning/todos/pending/2026-09-19-trust-fingerprint-toctou.md, priority: high) has only a partial client-side mitigation (re-GET-and-compare immediately before POST) that the todo's own text says 'cannot close it: only the backend can' — an open high-priority item with an admittedly incomplete mitigation is a judgment call, not a clean pass, and is flagged here rather than silently accepted."
    artifacts:
      - path: "apps/web/src/lib/api-client.ts"
        issue: "No AbortController/AbortSignal/timeout on the single shared fetch wrapper (verified: grep -i 'abortsignal|abortcontroller|timeout|signal' matches only error-code name strings)"
      - path: "packages/ui/src/CopyButton.tsx"
        issue: "navigator.clipboard.writeText(...) unguarded; throws synchronously when navigator.clipboard is undefined (non-secure-context origin)"
      - path: "apps/web/src/app/(shell)/servers/[id]/page.tsx"
        issue: "window.localStorage dereferenced directly in render, outside try/catch; no error.tsx boundary exists anywhere under apps/web/src/app"
      - path: "packages/ui/tokens.css"
        issue: "--on-accent #ffffff on --accent #2997ff (dark mode, the default theme) = 3.02:1, below WCAG AA 4.5:1 — independently recomputed and confirmed"
    missing:
      - "Add a request timeout (AbortSignal.timeout or manual AbortController) to api-client.ts's fetch wrapper."
      - "Guard navigator.clipboard access (feature-detect before calling, or wrap in try/catch) in CopyButton.tsx."
      - "Wrap window.localStorage access in a safe accessor (first-trust.ts already promises this; the promise is broken at the call site) and/or add an apps/web/src/app/(shell)/error.tsx boundary."
      - "Resolve the primary-button/segmented-control dark-mode contrast token, together with the already-accepted-for-gap-closure status-pill contrast issue."
      - "Either close the trust-fingerprint TOCTOU with the backend-side fix the todo describes, or explicitly document the partial client-side mitigation as an accepted interim state with a named owner and date."
  - truth: "SC1/UI-02 — every screen has a working error state: a server-side validation failure highlights the offending field (added by the orchestrator; confirmed defect the verifier verified in its body but left out of this gap list)"
    status: failed
    reason: "The control plane emits issue paths as instancePath ('/name', '/credential/privateKey'); apps/web/src/lib/error-copy.ts fieldErrorsFromIssues tests KNOWN_FORM_FIELD_PATHS.has(issue.path) against bare names, so no server-side field error ever renders. The add/edit sheet shows 'Check the highlighted fields' with nothing highlighted; setup shows 'This setup link is no longer valid' for an ordinary validation failure (05-REVIEW.md WR-B-07, WR-B-14; orchestrator-verified)."
    artifacts:
      - path: "apps/web/src/lib/error-copy.ts"
        issue: "fieldErrorsFromIssues compares '/name'-style instancePath against bare 'name' keys — never matches"
      - path: "apps/web/src/app/setup/page.tsx"
        issue: "Every non-issues[] failure, including network and 5xx, renders the 'link no longer valid' banner"
    missing:
      - "Normalise instancePath ('/credential/privateKey' -> the form's field key) in fieldErrorsFromIssues, test-first, with an E2E proving a server-rejected field is highlighted in the sheet."
      - "Distinguish invalid-token from validation/network/5xx failures on setup."
  - truth: "Host-key trust is bound to what the admin saw (CLAUDE.md §2.3, TOFU non-negotiable) (added by the orchestrator to group the three related findings)"
    status: failed
    reason: "Three linked defects. (1) POST /api/servers/:id/trust-fingerprint takes no body and promotes whatever pendingFingerprint the row holds at that instant (todo 2026-09-19-trust-fingerprint-toctou.md, priority high). (2) WR-A-02: the UF-01 fix assumes pendingFingerprint is non-null only in ERROR; applyConnectionResult keeps it across a successful connect and every non-HOST_KEY_CHANGED failure, so a fingerprint captured against the old identity survives an identity edit from CONNECTED/UNREACHABLE, and an identity edit outside CONNECTED guarantees a spurious HOST_KEY_CHANGED next connect (teaching the admin the warning is routine). (3) WR-B-12: TrustFingerprintDialog's pre-POST re-GET compares against the live SSE-updated prop, not the fingerprint displayed when the dialog opened, so a mid-review swap passes the check."
    artifacts:
      - path: "apps/control-plane/src/routes/servers.ts"
        issue: "trust-fingerprint route accepts no fingerprint to verify against"
      - path: "apps/control-plane/src/services/edit-server.ts"
        issue: "UF-01 branch only clears pendingFingerprint when status is ERROR"
      - path: "apps/web/src/components/TrustFingerprintDialog.tsx"
        issue: "compares re-GET result to the live prop instead of a snapshot taken on open"
    missing:
      - "Route accepts { fingerprint }, service promotes only via an atomic conditional update; 409 FINGERPRINT_MISMATCH otherwise (see the todo for the full test plan)."
      - "Clear pendingFingerprint (and reset hostFingerprint consistently) on every identity-changing edit regardless of status; reject trustFingerprint outside the states where it is meaningful instead of 500."
      - "Dialog snapshots the displayed fingerprint on open and sends exactly that value."
  - truth: "SC4/ACT-02 — the activity log stays correct while it refreshes (added by the orchestrator; the verifier rated SC4 PARTIAL but listed no gap)"
    status: partial
    reason: "WR-B-04: a failed background refresh replaces the loaded list (including older pages) with an error banner. WR-B-05: a page-1 refresh silently drops rows when more than 50 events arrived since the last one. WR-B-06: day headers are grouped in UTC, not the viewer's time zone. Reported by the code reviewer from reading; not independently reproduced."
    artifacts:
      - path: "apps/web/src/app/(shell)/activity/page.tsx"
        issue: "background refresh failure path and >50-new-events gap"
      - path: "apps/web/src/lib/activity-groups.ts"
        issue: "time zone used for day boundaries"
    missing:
      - "Keep the loaded list on a failed background refresh; detect and close the gap when a refresh returns a full page; group by the viewer's zone (injected, deterministic in tests)."
  - truth: "Remaining confirmed or high-value findings not tied to one success criterion (added by the orchestrator so gap planning can triage them; see 05-REVIEW.md for each)"
    status: partial
    reason: "WR-B-15 no '/' route — an authenticated visit to the bare origin is a 404 (verifier-confirmed). WR-C-01 ThemeToggle hydration mismatch for every user with a stored theme (reviewer-reproduced). WR-C-14 the 'non-bypassable' provenance gate checks a hardcoded list covering 27 of 52 dependencies (misses ssh2, argon2, better-auth, pg, fastify, pino, zod), checks 'latest' not the lockfile version, and trusts a publisher-asserted URL. WR-A-01 a throw after the first transaction wedges a server in CONNECTING until the worker restarts. WR-A-03 SSE writes unchecked: a half-open peer holds one of 32 slots until TCP gives up. WR-A-04 logger.error(err) with a bare Error bypasses the err serializer. WR-B-10 a revoked-session tab never redirects. Open todos: setup token lingers in URL/history + no Referrer-Policy; 04-SECURITY.md UF-02 (worker.ts main() without try/catch). Accessibility: status-pill contrast (user decision 2026-09-20: fix in gap closure), WR-C-08 --ink-tertiary content text down to 1.83:1, WR-C-04 focus not returned after Sheet/Dialog close, WR-C-05 RowMenu never closes on select and is invisible on touch, WR-C-09 the UI package's own focus-ring classes are inert under Tailwind v4."
    artifacts:
      - path: ".planning/phases/05-ui-web/05-REVIEW.md"
        issue: "37 warnings; the ones above are the orchestrator's triage of what should not be lost"
    missing:
      - "Triage in gap planning: which of these block v0.1 and which become backlog. The user decides the replacement status/text colours."
deferred: []
human_verification:
  - test: "Real visual quality in both themes on an actual display (color rendering, spacing feel, whether the Apple-inspired minimalism reads as intended)"
    expected: "Reads as calm, minimal, consistent with the noodara-ux-apple skill"
    why_human: "Subjective visual conformance; the human walkthrough on 2026-09-20 explicitly said 'No me gusta la UI' without naming specific defects, so this remains open per the user's own words"
  - test: "The missing floating-elevation shadow's actual visual impact on Sheet/Dialog/RowMenu (hairline + backdrop-blur only, vs. the skill's specified shadow)"
    expected: "A human judges whether flat + hairline reads as an acceptable substitute or looks undifferentiated from the page behind it"
    why_human: "docs/ui-review-05.md FLAG 2 explicitly defers this to a human on a real display"
  - test: "Light-mode status-pill contrast's real-world legibility (already routed to gap closure, not accepted — human input needed on the replacement text colors)"
    expected: "Legible status text in both themes at the chosen replacement colors"
    why_human: "docs/ui-review-05.md Accessibility FLAG 1; the user must choose the replacement design, not an executor"
  - test: "Responsive behavior below 1280px on an actual tablet/phone, not just a resized headless viewport"
    expected: "Sidebar collapse and bottom-sheet nav behave and feel correct on real touch hardware"
    why_human: "docs/ui-review-05.md 'Needs human review' item 4; Playwright only proves computed breakpoints, not device feel"
  - test: "prefers-reduced-motion's actual felt effect and the 320ms sheet transition / 120ms press micro-interaction's real timing"
    expected: "Motion feels appropriate and the reduced-motion degradation is genuinely instant/static"
    why_human: "CSS timing/feel cannot be judged by jsdom or Playwright assertions alone"
  - test: "RowMenu's real screen-reader announcement with an actual screen reader (VoiceOver/NVDA)"
    expected: "Menu open/closed state and item selection are announced correctly"
    why_human: "Static ARIA-attribute audits (already corrected once in this phase — the aria-expanded FLAG was found false) cannot substitute for a real assistive-technology pass"
  - test: "A full live walkthrough of add-server -> connect -> watch discovery fill in check-by-check -> detail -> activity -> settings, with SSE actually visible (not through a buffering tunnel)"
    expected: "Live list insertion and check-by-check discovery progress are visibly smooth and correct to a human observer"
    why_human: "The only human walkthrough so far (2026-09-20) used a Cloudflare Quick Tunnel that buffers SSE — live updates have never been seen by a human, only proven by E2E. docs/ui-review-05.md's own 'Human walkthrough' section confirms item 7 remains open."
  - test: "Confirm the nightly workflow and the CI security job actually succeed once the repository has a real git remote"
    expected: "nightly.yml's e2e-repeat job passes 20/20 and its canary job passes in the same run; ci.yml's security job passes after the playwright-install fix is applied"
    why_human: "No GitHub Actions run has ever executed for this repository (no remote); this cannot be verified from the sandbox and requires a human to push and observe a real run"
---

# Phase 5: UI web — Verification Report

**Phase Goal:** El admin completa de punta a punta el flujo login → Servers → add server → connect → discovery → detail usando el shell del design system Apple-inspired de Noodara, en dark y light, con estados vacío/carga/error en cada pantalla.

**Verified:** 2026-09-20
**Status:** gaps_found
**Re-verification:** No — initial verification

## Method

This report does not trust 05-*-SUMMARY.md claims. Every finding below marked "verified directly" was independently re-derived from the source tree in this session (grep, direct file reads, and — for the WCAG contrast figures — an independent re-computation of the WCAG 2.x relative-luminance formula against the literal hex values in `packages/ui/tokens.css`, which reproduced the code review's `3.02:1` figure exactly). Findings sourced from `.planning/phases/05-ui-web/05-REVIEW.md` that were *not* independently re-run in this session are marked as such and are treated as corroborating evidence, not primary evidence, consistent with this phase's own documented history of confident-but-wrong diagnoses (SSE subscriber race, canary-hang "memory pressure", the false `aria-expanded` FLAG).

`pnpm typecheck` was re-run in this session (all 8 cached tasks green). The long-running suites (`pnpm test:integration`, `pnpm test:e2e`) were **not** re-run per the orchestrator's instruction — their prior green results (487/0/1-skipped and 73/73) are accepted as given, but note they do not exercise the mid-run-mount discovery path, the CONNECTING-wedge path, or the plain-HTTP `navigator.clipboard`-undefined path found below — those required reading, not running.

## Goal Achievement

### Observable Truths

| # | Truth | Status | Evidence |
|---|-------|--------|----------|
| 1 | SC1 — shell funciona en dark/light con navegación por teclado; 7 pantallas con vacío/carga/error | ⚠ PARTIAL | Mechanically proven: `tests/e2e/shell.spec.ts` (keyboard tab order, focus outline, theme toggle + reload persistence, responsive collapse at 1024/900px) and per-screen 3-state E2E citations in `docs/ui-review-05.md`'s sign-off table, all reported passing (73/73 E2E, not re-run here). **But** confirmed directly in this session: (a) `packages/ui/src/CopyButton.tsx` throws synchronously on any non-secure-context origin (Noodara's own stated plain-HTTP v0.1 deployment target) — no test exercises `navigator.clipboard === undefined`; (b) `window.localStorage` is dereferenced unguarded in `servers/[id]/page.tsx` render with no `error.tsx` boundary anywhere under `apps/web/src/app` (verified: `find` returned nothing) — a blocked-storage browser hard-crashes the detail screen; (c) the dark-mode (default) primary button/segmented-control/skip-link text is 3.02:1 against AA's 4.5:1, independently recomputed from `tokens.css`'s literal `#2997ff`/`#ffffff` values. |
| 2 | SC2 — lista + detalle muestran los campos requeridos, distinguiendo "aún no descubierto" de "discovery falló" | ✗ FAILED | List fields (name, host:port, StatusPill, last seen) and detail fields (hostname/OS/CPU/RAM/disk/uptime/Docker/last seen/fingerprint) are all substantively present and wired (`ServerRow.tsx`, `ServerFacts.tsx`, verified by direct read) — the *data shape* truth holds. But two confirmed, ordinary-interleaving defects break reliability of what's shown: `servers/[id]/page.tsx`'s `fetchServer` sets state from every GET unconditionally, with no `updatedAt`/`latestRequestRef`/`deletedRef` guard (verified directly, lines 107-165) — unlike the servers list page, which has this protection (`reconcileSnapshot`, confirmed present by the code review and not disputed). A GET racing a live event can leave the page permanently on a stale "Connecting…" or resurrect a deleted server. Separately, `connect-and-discover.ts` runs `decodeCredential`/`parseFingerprint`/`session.close`/TX2 with no `try/catch` after TX1 commits `CONNECTING` (verified directly, lines 286-345), and the worker's `'failed'` listener only logs (verified directly, `connect-server-worker.ts:99-101`) — `failInFlightConnection` is reachable only via `'stalled'`, not `'failed'`. A credential-decode failure wedges the row in `CONNECTING` forever, which is neither of DETL-02's two named states and blocks every mutation as `SERVER_BUSY`. |
| 3 | SC3 — discovery check-by-check, nunca un spinner genérico, nunca progreso inventado | ✗ FAILED | Confirmed directly: `apps/web/src/lib/discovery-progress.ts`'s `firstUnresolvedIndex` assumes the page observed the run from check 1. A page mounted mid-run (the normal "Save and connect" navigation path, or any SSE reconnect mid-run) renders checks it never received as `Running`/`Pass` via `aggregateSettledStepState`. Separately, `liveChecks` is cleared only on the SSE-observed transition into `CONNECTING` (`servers/[id]/page.tsx:128-130`), never on the fetch-branch equivalent and never on transition *out of* `CONNECTING` — a finished run's 11 checks can render as the next run's live progress while the new run's real events are silently deduped away. This is a direct violation of the plan's own named rule ("la regla de no inventar progreso", 05-18-PLAN.md) and D-05. |
| 4 | SC4 — activity log cronológico inverso sin metadatos sensibles; settings con versión y URL pública | ⚠ PARTIAL | Core rendering, metadata allowlisting and cursor pagination are E2E-proven (`tests/e2e/activity.spec.ts`) and the metadata-curation code (`activity-groups.ts`) was reviewed and found sound by the code review's own "checked and found sound" list (not independently re-run here). Settings' Instance/Advanced groups exist and are read-only by construction (`SettingsGroups.tsx`, verified directly). Not independently re-run, but not disputed by this session's spot-checks: `activity/page.tsx`'s background-refresh failure branch does an unconditional `setState({kind:'error', ...})` even from `ready`, discarding loaded pages and scroll position on any transient network blip while backgrounded (05-REVIEW.md WR-B-04); a page-1 refresh silently drops rows when more than 50 events land between refreshes, with no gap indicator (WR-B-05). Both are edge-case (background/burst) rather than steady-state defects. |
| 5 | SC5 — E2E cubre el flujo; nightly 20/20 en CI; canary confirma en el mismo run | ✗ FAILED | REQUIREMENTS.md itself marks QA-04 and QA-05 `Pending`, not `Complete` — the team's own bookkeeping already agrees. Verified directly: this repo has no git remote (`git remote -v` empty); `.github/workflows/nightly.yml`'s own header states the schedule trigger "cannot actually fire yet" and has "never executed as a real scheduled (or workflow_dispatch) GitHub Actions run" — the 20/20 evidence is a local simulation, not a CI run. Verified directly: `.github/workflows/ci.yml`'s `security` job (lines 156-243) has no `playwright install` step, while `pnpm security:scan-leaks` (`package.json`) runs `playwright test --grep @canary`, which needs a browser binary — the very job meant to run the canary on every PR would fail before testing anything, on its first real run. |
| 6 | CLAUDE.md §2.2/§2.3 Definition of Done bar (in scope per this verification's explicit instructions) | ✗ FAILED | Verified directly: `api-client.ts` has zero timeout/AbortSignal/AbortController usage (§2.3 "Timeouts explícitos en toda operación remota") — this also contradicts what the orchestrator told the user in an earlier wave-4 report. Verified directly: `CopyButton.tsx` and the detail page's `window.localStorage` access can throw uncaught on realistic conditions (non-secure origin; blocked storage) with no `error.tsx` boundary anywhere — contradicts "manejo de errores explícito". Verified directly (independently recomputed): dark-mode (default theme) primary-action text is 3.02:1, below AA — contradicts "UX consistente con el design system". The open high-priority trust-fingerprint TOCTOU (`.planning/todos/pending/2026-09-19-trust-fingerprint-toctou.md`) has only a partial, explicitly-incomplete client-side mitigation — a judgment call on whether "altas... solo con mitigación documentada" is satisfied; flagged rather than silently accepted. |

**Score:** 0/6 truths fully clean (2 partial, 4 failed) — see per-truth evidence above; no truth is invented as failing beyond what was independently confirmed or directly corroborated.

### Required Artifacts

| Artifact | Expected | Status | Details |
|----------|----------|--------|---------|
| `apps/web/src/components/ServerRow.tsx` | list row: name, host:port, StatusPill, last seen | ✓ VERIFIED | Fields present and wired (`ListRow`, `StatusPill`, `RelativeTime`); race-protected by `servers/page.tsx`'s `reconcileSnapshot` |
| `apps/web/src/components/ServerFacts.tsx` | detail: hostname, OS, CPU, RAM, disk, uptime, Docker, last seen, fingerprint | ✓ VERIFIED (data shape) / ⚠ unreliable (see Truth 2) | All fields present (verified directly); values can go stale/stuck due to the page-level race in Truth 2 |
| `apps/web/src/lib/discovery-progress.ts` | check-by-check progress, no invented state | ✗ STUB-LIKE DEFECT | Substantive and wired, but confirmed to invent `Running`/`Pass` for unseen mid-run checks (Truth 3) |
| `apps/web/src/components/ActivityRow.tsx` / `activity-groups.ts` | reverse-chronological log, curated metadata only | ✓ VERIFIED (steady state) | Wired and metadata-curated; background-refresh edge cases open (Truth 4) |
| `apps/web/src/components/SettingsGroups.tsx` | version + public URL, read-only | ✓ VERIFIED | Present, wired, no defects found |
| `apps/web/src/lib/api-client.ts` | shared fetch wrapper with explicit timeouts | ✗ MISSING (timeout) | Wrapper exists and is wired everywhere, but has no timeout mechanism at all — verified directly |
| `.github/workflows/ci.yml` security job | canary runs green on PRs | ✗ WOULD FAIL FIRST RUN | Missing `playwright install`; verified directly by reading the job |
| `.github/workflows/nightly.yml` | 20/20 + canary, same run, on real CI | ✗ NEVER EXECUTED | No remote; self-documented as never having run for real |

### Key Link Verification

| From | To | Via | Status | Details |
|------|----|----|--------|---------|
| `servers/[id]/page.tsx` | `GET /api/servers/:id` + SSE `server.updated`/`server.deleted` | `fetchServer` + `subscribe` | ✗ NOT_WIRED (ordering) | No sequencing between the two sources — verified directly, no `updatedAt`/`latestRequestRef` guard, unlike the sibling servers-list page |
| `discovery-progress.ts` | SSE `server.discovery_progress` accumulation | `liveChecks` in `servers/[id]/page.tsx` | ⚠ PARTIAL | Wired, but the accumulator is not correctly reset across snapshot-learned transitions (Truth 3) |
| `connect-and-discover.ts` (worker) | `failInFlightConnection` | `worker.on('failed', ...)` | ✗ NOT_WIRED | The `'failed'` listener only logs; `failInFlightConnection` is reachable only from `'stalled'` — verified directly |
| `apps/web/src/app` | `/` root route | Next.js App Router | ✗ MISSING | No `page.tsx` at `apps/web/src/app/page.tsx`, no `middleware.ts` anywhere — an authenticated visit to the bare origin is a 404 (corroborates 05-REVIEW.md WR-B-15, verified directly) |
| `security:scan-leaks` script | Chromium binary | CI `security` job | ✗ NOT_WIRED | Script requires a browser (`playwright test --grep @canary`); job never installs one — verified directly |

### Data-Flow Trace (Level 4)

| Artifact | Data Variable | Source | Produces Real Data | Status |
|----------|---------------|--------|---------------------|--------|
| `servers/[id]/page.tsx` | `state.server` (`PageState.ready`) | `GET /api/servers/:id` (real DB read) + SSE `server.updated` | Yes, both sources are real | ⚠ HOLLOW under race — data is real but can be stale/wrong due to unordered writes (Truth 2) |
| `DiscoverySection` | `liveChecks` | SSE `server.discovery_progress` accumulation | Yes, but can represent checks that never actually resolved for the current viewer (invented, Truth 3) | ⚠ HOLLOW under mid-run mount |
| `SettingsGroups` | instance version / public URL | Real config read (per validation table T2/05-16) | Yes | ✓ FLOWING |
| `ActivityRow` list | activity events | Real cursor-paginated DB read | Yes | ✓ FLOWING (steady state) |

### Behavioral Spot-Checks

| Behavior | Command | Result | Status |
|----------|---------|--------|--------|
| api-client has no timeout mechanism | `grep -i "abortsignal\|abortcontroller\|timeout\|signal" apps/web/src/lib/api-client.ts` | Only matches are `ApiErrorCode` name strings (`CONNECT_TIMEOUT`, `COMMAND_TIMEOUT`) | ✓ CONFIRMED (gap) |
| Bare origin has no route | `find apps/web/src/app -maxdepth 1 -type d`, `ls apps/web/src/app/page.tsx` | No root `page.tsx`; no `middleware.ts` anywhere under `apps/web/src` | ✓ CONFIRMED (gap) |
| CI security job installs a browser before the canary | `awk '/^  security:/,/^  boot-smoke:/' .github/workflows/ci.yml \| grep "playwright install"` | No match | ✓ CONFIRMED (gap) |
| No git remote configured | `git remote -v` | Empty | ✓ CONFIRMED (nightly has never run for real) |
| Dark-mode primary contrast | Independent WCAG relative-luminance computation on `#ffffff` over `#2997ff` | 3.02:1 | ✓ CONFIRMED (matches code review's figure exactly) |
| No debt markers (TBD/FIXME/XXX) in phase-touched source | `grep -rn "TBD\|FIXME\|XXX" apps/web/src packages/ui/src apps/control-plane/src --include="*.ts" --include="*.tsx"` (excluding tests) | Zero matches | ✓ PASS (no debt-marker blocker) |
| `pnpm typecheck` | `pnpm typecheck` | 8/8 tasks green (cached) | ✓ PASS |

### Probe Execution

Not applicable — this is a UI/product phase, not a migration/tooling phase; no `scripts/*/tests/probe-*.sh` files exist and none are declared in the PLAN/SUMMARY files.

### Requirements Coverage

| Requirement | Source Plan(s) | Description | Status | Evidence |
|---|---|---|---|---|
| SERV-04 | 05-13 | Servers list: name, host, status pill, last seen | ✓ SATISFIED | Fields present, wired, and race-protected (`reconcileSnapshot`) — the one screen in this family with no confirmed correctness defect |
| DETL-01 | 05-14 | Detail shows hostname/status/OS/CPU/RAM/disk/uptime/Docker/last seen/fingerprint | ⚠ BLOCKED | Fields present (data-shape SATISFIED), but the page-level staleness race (Truth 2) means what's shown can be stuck or wrong in ordinary interleavings |
| DETL-02 | 05-01, 05-14, 05-19 | Distinguishes "aún no descubierto" / "discovery falló", one action each | ✗ BLOCKED | The state derivation itself (`deriveDetailState`) is sound, but a wedged `CONNECTING` (Truth 2 / WR-A-01) is neither named state and has no action at all (`SERVER_BUSY` everywhere) |
| ACT-02 | 05-15 | Reverse-chronological activity log, no sensitive metadata | ⚠ PARTIAL | Steady-state SATISFIED; background-refresh edge cases open (Truth 4) |
| SET-01 | 05-16 | Read-only settings: version, public URL | ✓ SATISFIED | No defects found against this requirement |
| UI-01 | 05-03, 05-06, 05-07, 05-08, 05-09, 05-12, 05-21, 05-22, 05-23, 05-24, 05-25 | Design-system shell, dark/light, keyboard nav | ✗ BLOCKED | Mechanically present, but confirmed AA contrast failure on the default theme's primary actions and confirmed unguarded browser-API crashes (Truth 1/6) |
| UI-02 | 05-07 … 05-19, 05-21 | Setup/login/list/sheet/detail/activity/settings, 3 states each | ⚠ PARTIAL | States exist and are E2E-proven; server-side field-validation errors never render (WR-B-07, corroborating evidence: `http-errors.ts`'s `normalizeIssuePath` returns AJV's `instancePath` — leading-slash form like `/name` — while `error-copy.ts`'s `KNOWN_FORM_FIELD_PATHS` contains bare names like `'name'`; `Set.has('/name')` against `'name'` never matches, verified directly by reading both files) |
| DISC-02 | 05-04, 05-05, 05-18 | Check-by-check discovery, never a generic spinner, never invented | ✗ BLOCKED | Truth 3 above — invented progress confirmed |
| QA-04 | 05-10, 05-20 | E2E flow + nightly 20/20 + 100-connection stress | ✗ BLOCKED (REQUIREMENTS.md agrees: Pending) | Never run on real CI infrastructure; no remote |
| QA-05 | 05-01, 05-02, 05-03, 05-05, 05-21 | CI + nightly canary secrets scan | ✗ BLOCKED (REQUIREMENTS.md agrees: Pending) | CI security job would fail its first real run (missing playwright install) |

**No orphaned requirements**: `grep -n "Phase 5" .planning/REQUIREMENTS.md` returns exactly the same 10 IDs declared across the 25 plans' `requirements:` frontmatter — full accounting confirmed.

### Anti-Patterns Found

| File | Line | Pattern | Severity | Impact |
|------|------|---------|----------|--------|
| `apps/web/src/lib/api-client.ts` | whole file | Missing timeout mechanism on the shared remote-call wrapper | 🛑 Blocker (DoD §2.3) | Every API call can hang indefinitely |
| `packages/ui/src/CopyButton.tsx` | 37-40 | Unguarded `navigator.clipboard` access | 🛑 Blocker (crashes on the project's own stated plain-HTTP target) | Copy buttons throw uncaught on insecure-context origins |
| `apps/web/src/app/(shell)/servers/[id]/page.tsx` | ~218 | `window.localStorage` dereferenced in render, no try/catch, no `error.tsx` anywhere | 🛑 Blocker | Blocked-storage browsers hard-crash the detail page |
| `apps/web/src/app/(shell)/servers/[id]/page.tsx` | 107-165 | No snapshot/event ordering guard | 🛑 Blocker | Stale/stuck/resurrected server detail under ordinary races |
| `apps/control-plane/src/services/connect-and-discover.ts` | 286-345 | No try/catch after TX1 commits `CONNECTING` | 🛑 Blocker | Permanent `CONNECTING` wedge on any post-TX1 throw |
| `apps/web/src/lib/discovery-progress.ts` | 118-172 | Invents resolved state for unseen mid-run checks | 🛑 Blocker (explicit named rule violated) | Violates D-05 / DISC-02 directly |
| `.github/workflows/ci.yml` | security job | Missing `playwright install` before a Playwright-dependent script | 🛑 Blocker | Merge-gate job fails on first real run |
| `packages/ui/tokens.css` | 139-141 | `--on-accent`/`--accent` dark pair fails WCAG AA (3.02:1) | ⚠️ Warning | Default-theme primary action text under-contrast |
| `apps/web/src/lib/error-copy.ts` | 69-92 | `KNOWN_FORM_FIELD_PATHS` compared against bare names vs. AJV's leading-slash `instancePath` | ⚠️ Warning | Server-side field validation errors never render inline |
| `apps/web/src/app/(shell)/activity/page.tsx` | 120-146 | Background refresh failure/gap handling | ⚠️ Warning | Loaded log can be wiped or silently gapped on background refresh |
| No TBD/FIXME/XXX debt markers found in phase-touched source | — | — | ℹ️ Info | Debt-marker gate does not trigger |

## Human Verification Required

See frontmatter `human_verification:` — 8 items, all sourced from `docs/ui-review-05.md`'s own "Needs human review" section plus one added by this verification (a real CI run confirming the nightly/canary jobs once a remote exists). None of these were rubber-stamped; each cites why grep/Playwright/jsdom cannot substitute.

## Gaps Summary

The phase shipped a large, mostly well-tested surface (73/73 E2E, 1381/1381 unit, 487/0/1-skipped integration, per the orchestrator's prior runs — not re-run here) and the *presence* of every named screen, field and state is real and substantively wired, not stubbed. The verification finds gaps_found rather than passed because, once the goal-backward lens is applied past "does the surface exist" to "does it behave correctly under ordinary use and meet the project's own non-negotiable bar":

1. **Live-data correctness on the detail/discovery screens is broken under entirely ordinary interleavings** — not exotic races. Clicking "Retry" on a server, or navigating to a server's detail page after starting a connect, are the most common actions an admin takes, and both can leave the page wrong or permanently stuck (SC2, SC3, DISC-02, DETL-02). This is functionally more severe than a UI polish issue: the "Connecting…" wedge cannot be cleared without restarting the worker.
2. **CI/nightly readiness for SC5/QA-04/QA-05 is not met**, and the team's own REQUIREMENTS.md already says so (Pending). This verification adds that even the *first* CI run of the security/canary job would fail, independent of the nightly-has-no-remote problem.
3. **The Definition of Done bar in CLAUDE.md §2.2/§2.3 has confirmed violations** — no request timeouts, uncaught-exception crash paths on the project's own explicitly-supported plain-HTTP deployment mode, and an AA contrast failure on the default theme's primary actions.
4. **Form error rendering is broken** (UI-02) — a path-format mismatch between the backend's AJV-shaped validation issues and the frontend's known-field allowlist means server-side field errors are silently dropped rather than shown inline.
5. Two requirements the team itself marked complete (DETL-01, DETL-02, UI-01, DISC-02) are re-classified above as BLOCKED given the confirmed defects; SERV-04 and SET-01 hold up cleanly.

None of these are new fabrications — every BLOCKER-level item above was either independently reproduced by direct code reading and/or computation in this session, or is corroborated by the phase's own code review (`05-REVIEW.md`) with a file:line citation this session re-checked. The human walkthrough approval ("le doy approve") explicitly authorized closing the phase's checkpoint, not a finding that these code-level defects are acceptable — the user never saw them; they were found by static review after the walkthrough.

**This does not look like an intentional deviation** — no override is suggested. These are execution gaps against the phase's own stated goal and the project's own non-negotiable engineering bar, not a documented alternative design.

---

_Verified: 2026-09-20_
_Verifier: Claude (gsd-verifier)_
