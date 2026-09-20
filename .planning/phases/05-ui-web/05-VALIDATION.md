---
phase: 5
slug: ui-web
status: confirmed
nyquist_compliant: true
wave_0_complete: true
created: 2026-09-18
updated: 2026-09-20
plans: 25
waves: 15
---

# Phase 5 — Validation Strategy

> Per-phase validation contract for feedback sampling during execution.
> Source: `05-RESEARCH.md` § Validation Architecture, `docs/adr/0005-ui-package-and-component-testing.md`.

---

## Test Infrastructure

| Property | Value |
|----------|-------|
| **Framework** | Vitest 5.0.0 (unit / component / integration) + Playwright 1.63.0 (E2E, net-new this phase) |
| **Vitest projects** | `root`, `packages`, `apps` (all existing, node environment, `*.test.ts`) + **`dom`** (net-new in Plan 05-06: `jsdom`, `setupFiles: vitest.setup.dom.ts`, matches `packages/ui/src/**/*.test.tsx` and `apps/web/src/**/*.test.tsx`) |
| **Component-test harness** | `@noodara/ui/testing` → `packages/ui/src/testing/render.tsx` (`renderUi`, `userEvent`, `screen`) — the single entry point for every component test in both `packages/ui` and `apps/web` |
| **Config files** | `vitest.config.ts`, `vitest.shared.ts`, `vitest.setup.dom.ts`, `vitest.integration.config.ts`; `playwright.config.ts` — none yet, Plan 05-10 creates it |
| **Quick run command** | `pnpm test` (all four Vitest projects) |
| **Full suite command** | `pnpm test:integration && pnpm test:e2e` (`test:e2e` is currently a placeholder — Plan 05-10 replaces it with a real Playwright invocation) |
| **Estimated runtime** | ~60–90 seconds quick (jsdom adds to the unit pass) / several minutes full (Testcontainers + Playwright) |

### Division of labour (ADR-0005)

| Verified by | What |
|-------------|------|
| **Vitest, `packages`/`apps` projects** | Pure modules: reducers, formatters, validators, state derivation, sentence/allowlist maps. Clock and I/O always injected. |
| **Vitest, `dom` project** | Component behaviour, **test-first**: variants, disabled/loading/active states, aria attributes, callback invocation, the three empty/loading/error states per screen, status words present in the DOM, and "no payload field reaches the DOM". |
| **Playwright** | Cross-screen flows, real-browser keyboard navigation and focus order, Radix focus-trap and Esc end to end, hover-reveal, theming and computed styles, request content types, storage, history, and the credential-leak surfaces. |
| **`noodara-ux-review` skill (manual)** | Visual conformance to the design system in both themes, and contrast. |

Every component task is `tdd="true"` and must record its RED observation in its SUMMARY (CLAUDE.md §2.1, `noodara-tdd` skill §1).

---

## Sampling Rate

- **After every task commit:** Run `pnpm test` plus `pnpm lint` / `pnpm typecheck` for any touched package
- **After every plan wave:** Run `pnpm test:integration` + `pnpm test:e2e` (once it exists); `pnpm security:scan-leaks` after any change touching credentials, SSE, or logging
- **Before `/gsd:verify-work`:** Full suite must be green — `pnpm test`, `pnpm test:integration`, `pnpm test:boot`, `pnpm test:e2e`, `pnpm security:scan-leaks`, `pnpm check:ui-safety`, `pnpm typecheck`, `pnpm lint`, `pnpm boundaries`, `node scripts/check-package-provenance.mjs`
- **Max feedback latency:** 60 seconds (quick run)

---

## Per-Task Verification Map

> Filled in at planning time from the final 25-plan set. Plan 05-21 Task 2 **confirms** these rows against what
> shipped and resolves each Status — it does not rewrite them. A row whose named command no longer exists or no
> longer matches what shipped is reported as a discrepancy, not silently edited.

| Task ID | Plan | Wave | Requirement | Threat Ref | Secure Behavior | Test Type | Automated Command | File Exists | Status |
|---------|------|------|-------------|------------|-----------------|-----------|-------------------|-------------|--------|
| T1 | 05-01 | 1 | D-17, DETL-02 | UF-01 | Editing host while `ERROR` clears `pendingFingerprint`; trust-fingerprint fails safely afterwards | integration | `pnpm test:integration tests/integration/services/edit-server.test.ts` | ✅ exists | ✅ green |
| T2 | 05-01 | 1 | D-17 | T-4-02 | `withSessionLookupTimeout` bounds `getSession` | unit | `pnpm test apps/control-plane/src/auth/session-lookup.test.ts` | ❌ new | ✅ green |
| T3 | 05-01 | 1 | D-17, QA-05 | T-4-02 | Both session lookups bounded, SSE route included | unit + integration | `pnpm test apps/control-plane/src/auth && pnpm test:integration tests/integration/routes/events-sse.test.ts` | ✅ exists | ✅ green |
| T1 | 05-02 | 1 | D-17, QA-05 | T-4-10 / T-4-38 | pino `err` serializer — `err.name` only, never a message or stack with secrets | unit | `pnpm test apps/control-plane/src/logger.test.ts` | ❌ new | ✅ green |
| T2 | 05-02 | 1 | D-17 | T-4-32 | Worker shutdown wrapped in try/catch, never leaves a connection open | unit | `pnpm test apps/control-plane/src/queue/worker-shutdown.test.ts` | ❌ new | ✅ green |
| T3 | 05-02 | 1 | D-17 | T-4-32 | Real boot still succeeds with the hardened shutdown | integration (boot) | `pnpm build && pnpm test:boot` | ✅ exists | ✅ green |
| T1 | 05-03 | 2 | UI-01, QA-05 | T-5-SC | Eight unaudited packages human-verified before any install | **blocking human checkpoint** | manual registry verification (no automated substitute) | n/a | ✅ green |
| T2 | 05-03 | 2 | UI-01, QA-05 | T-5-SC / T-5-09 | All 22 net-new packages pinned to an exact owner/repo; gate in CI | static gate | `node scripts/check-package-provenance.mjs` | ✅ exists | ✅ green |
| T3 | 05-03 | 2 | QA-05 | T-5-12 | Phase 4 security file closed only with per-threat evidence | static gate | `grep -c "threats_open: 0" .planning/phases/04-http-routes-worker-bullmq-y-sse/04-SECURITY.md` | ✅ exists | ✅ green |
| T1 | 05-04 | 2 | DISC-02 | — | `onCheck` callback is best-effort and never fails the run | unit | `pnpm test packages/ssh/src/run-discovery.test.ts` | ✅ exists | ✅ green |
| T2 | 05-04 | 2 | DISC-02 | — | `server.discovery_progress` added to the broadcaster allowlist explicitly | unit | `pnpm test apps/control-plane/src/events` | ✅ exists | ✅ green |
| T3 | 05-04 | 2 | DISC-02 | — | Progress published without ever failing `connectAndDiscover` | integration | `pnpm test:integration tests/integration/services/connect-and-discover.test.ts` | ✅ exists | ✅ green |
| T1 | 05-05 | 3 | DISC-02 | — | Read service returns session-scoped, allowlisted fields only | integration | `pnpm typecheck && pnpm test:integration tests/integration/services` | ✅ exists | ✅ green |
| T2 | 05-05 | 3 | DISC-02 | — | Response schema drift guard — `detail` only, never raw command output | unit | `pnpm test apps/control-plane/src/routes/server-schemas.test.ts` | ✅ exists | ✅ green |
| T3 | 05-05 | 3 | DISC-02, QA-05 | canary | Canary extended to the new SSE event and the new read endpoint | integration | `pnpm test:integration tests/integration/routes/servers-discovery-read.test.ts && pnpm security:scan-leaks` | ✅ exists | ✅ green |
| T1 | 05-06 | 3 | UI-01 | T-5-24 / T-5-SC | `ui-components` boundary tag; provenance re-run after install | static gate | `pnpm install && pnpm build && pnpm boundaries && node scripts/check-package-provenance.mjs` | ✅ exists | ✅ green |
| T2 | 05-06 | 3 | UI-01 | T-5-26 | DOM harness works and test-only code never reaches the barrel | **component (dom project, RED→GREEN)** | `pnpm test --project dom && pnpm lint && pnpm typecheck && pnpm build` | ❌ new | ✅ green |
| T3 | 05-06 | 3 | UI-01 | T-5-25 | Tokens reproduced verbatim; contrast gap flagged, not patched | static gate | comment-filtered grep gate in the task's `<automated>` | ❌ new | ✅ green |
| T1 | 05-22 | 4 | UI-01 | — | Status-to-tone map cannot drift from the domain unions | unit | `pnpm test packages/ui/src/tone.test.ts packages/ui/src/cn.test.ts` | ❌ new | ✅ green |
| T2 | 05-22 | 4 | UI-01 | T-5-27 | All four variants covered; a `loading` Button truly blocks `onClick` | **component** | `pnpm test packages/ui/src/Button.test.tsx` | ❌ new | ✅ green |
| T3 | 05-22 | 4 | UI-01 | T-5-25 | All six statuses render their status word — never colour-only | **component** | `pnpm test packages/ui/src/StatusPill.test.tsx` | ❌ new | ✅ green |
| T1 | 05-07 | 4 | UI-01, UI-02 | T-5-SC | Same-origin rewrites, no CORS; provenance re-run | static gate | `pnpm install && pnpm build && pnpm lint && pnpm typecheck && node scripts/check-package-provenance.mjs` | ✅ exists | ✅ green |
| T2 | 05-07 | 4 | UI-01 | T-5-99 | Exactly one reviewed `dangerouslySetInnerHTML` (the theme bootstrap) | static gate | `pnpm build && pnpm lint` + the one-occurrence gate in the task | ✅ exists | ✅ green |
| T3 | 05-07 | 4 | UI-02 | — | API client never sets `credentials: 'include'`, never builds absolute URLs | unit | `pnpm test apps/web/src/lib/api-client.test.ts` | ❌ new | ✅ green |
| T1 | 05-08 | 5 | UI-01, UI-02 | T-5-35 / T-5-SC | Label/help/error a11y wiring; error text rendered verbatim | **component** | `pnpm test packages/ui/src/Field.test.tsx` | ❌ new | ✅ green |
| T2 | 05-08 | 5 | UI-02 | T-5-32 / T-5-41 | `autoComplete` forwarded verbatim; typed value in no second attribute | **component** | `pnpm test packages/ui/src/Input.test.tsx packages/ui/src/Textarea.test.tsx` | ❌ new | ✅ green |
| T3 | 05-08 | 5 | UI-01 | T-5-34 | Radio semantics come from the primitive, not hand-rolled | **component** | `pnpm test packages/ui/src/SegmentedControl.test.tsx` | ❌ new | ✅ green |
| T1 | 05-10 | 5 | QA-04 | T-5-SC | Playwright installed through the provenance gate | static gate | `pnpm install && node scripts/check-package-provenance.mjs && pnpm typecheck && pnpm lint` | ✅ exists | ✅ green |
| T2 | 05-10 | 5 | QA-04 | — | Config discovers specs; global setup/teardown leaves no stray container | E2E (config) | `pnpm exec playwright test --list` | ❌ new | ✅ green |
| T3 | 05-10 | 5 | QA-04 | — | Unauthenticated redirect and sign-in work against the real stack | E2E | `pnpm test:e2e --grep @smoke` | ❌ new | ✅ green |
| T1 | 05-23 | 6 | UI-02 | T-5-31 / T-5-33 | File text reaches only `onText`; never storage, never a DOM attribute | unit + **component** | `pnpm test packages/ui/src/confirm-match.test.ts packages/ui/src/FileButton.test.tsx` | ❌ new | ✅ green |
| T2 | 05-23 | 6 | UI-01 | T-5-34 | Radix Dialog behaviour untouched; content absent when closed | **component** | `pnpm test packages/ui/src/Sheet.test.tsx` | ❌ new | ✅ green |
| T3 | 05-23 | 6 | UI-02 | T-5-33 / T-5-42 | Confirm disabled → enabled → disabled by typing; Cancel never destructive | **component** | `pnpm test packages/ui/src/Dialog.test.tsx` | ❌ new | ✅ green |
| T1 | 05-09 | 7 | UI-01 | — | Formatters are pure and clock-injected; no divide-by-zero | unit | `pnpm test packages/ui/src/format.test.ts` | ❌ new | ✅ green |
| T2 | 05-09 | 7 | UI-02 | T-5-39 | Banner message rendered verbatim; code kept out of the prose | **component** | `pnpm test packages/ui/src/Banner.test.tsx packages/ui/src/Notice.test.tsx` | ❌ new | ✅ green |
| T3 | 05-09 | 7 | UI-02 | T-5-40 / T-5-43 | No spinner anywhere; exactly one action per empty state | **component** | `pnpm test packages/ui/src/EmptyState.test.tsx packages/ui/src/Skeleton.test.tsx` | ❌ new | ✅ green |
| T1 | 05-24 | 8 | UI-01 | T-5-61 | Every timestamp carries its exact instant in `dateTime` | **component** | `pnpm test packages/ui/src/Tooltip.test.tsx packages/ui/src/RelativeTime.test.tsx` | ❌ new | ✅ green |
| T2 | 05-24 | 8 | UI-01 | T-5-37 | Clipboard receives exactly the `value`; nothing logged on failure | **component** | `pnpm test packages/ui/src/CopyButton.test.tsx` | ❌ new | ✅ green |
| T3 | 05-24 | 8 | UI-02 | T-5-44 / T-5-61 | Null facts render the placeholder, never a zero; `data-dimmed` observable | **component** | `pnpm test packages/ui/src/StatTile.test.tsx packages/ui/src/LabelValue.test.tsx` | ❌ new | ✅ green |
| T1 | 05-25 | 9 | UI-01, UI-02 | T-5-45 | Row is natively keyboard-activatable; trailing slot never navigates | **component** | `pnpm test packages/ui/src/ListRow.test.tsx packages/ui/src/RowMenu.test.tsx` | ❌ new | ✅ green |
| T2 | 05-25 | 9 | UI-02 | T-5-46 | Collapsed content is absent from the document, not hidden | **component** | `pnpm test packages/ui/src/Disclosure.test.tsx` | ❌ new | ✅ green |
| T3 | 05-25 | 9 | UI-01 | T-5-38 | Only `light`/`dark` ever reach `data-theme`; throwing storage survived | **component** | `pnpm test packages/ui/src/ThemeToggle.test.tsx` | ❌ new | ✅ green |
| T1 | 05-11 | 10 | UI-02 | — | Error copy is a closed map; no unknown code renders a raw string | unit | `pnpm test apps/web/src/lib/error-copy.test.ts` | ❌ new | ✅ green |
| T2 | 05-11 | 10 | UI-02 | — | Setup/login reveal no account existence; lockout copy is generic | E2E | `pnpm build && pnpm lint && pnpm typecheck && pnpm test:e2e --grep @smoke` | ✅ exists | ✅ green |
| T3 | 05-11 | 10 | UI-02 | — | Unauthenticated states verified in a real browser | E2E | `pnpm test:e2e --grep @auth` | ❌ new | ✅ green |
| T1 | 05-12 | 10 | UI-01, UI-02 | T-5-57 / T-5-82 | Client-side frame validation rejects unknown types and malformed payloads | unit (fake `EventSource`) | `pnpm test apps/web/src/lib/server-events.test.ts && pnpm typecheck` | ❌ new | ✅ green |
| T2 | 05-12 | 10 | UI-01 | — | Focus ring never removed (`outline: none` count is 0) | static gate | `pnpm build && pnpm lint && pnpm typecheck` + the `outline: none` gate in the task | ✅ exists | ✅ green |
| T3 | 05-12 | 10 | UI-01 | — | Shell keyboard navigation and both themes, in a real browser | E2E (a11y, dark + light) | `pnpm test:e2e --grep @shell` | ❌ new | ✅ green |
| T1 | 05-13 | 11 | SERV-04 | T-5-57 | Live patch preserves object identity; a forged row cannot persist | unit | `pnpm test apps/web/src/lib/server-store.test.ts` | ❌ new | ✅ green |
| T2 | 05-13 | 11 | **SERV-04, UI-02** | T-5-56 | All three states; no payload field reaches the DOM | **component** | `pnpm test apps/web/src/components/ServerList.test.tsx` | ❌ new | ✅ green |
| T3 | 05-13 | 11 | SERV-04, UI-02 | — | Hover-reveal row menu, keyboard row activation, ISO tooltip — real browser | E2E | `pnpm test:e2e --grep @servers` | ❌ new | ✅ green |
| T1 | 05-14 | 11 | DETL-02 | — | State derivation branches only on status/lastErrorCode/hostname | unit | `pnpm test apps/web/src/lib/detail-state.test.ts` | ❌ new | ✅ green |
| T2 | 05-14 | 11 | **DETL-01, DETL-02, UI-02** | T-5-60 / T-5-61 | Every fact labelled "as of"; host fingerprint shown, never credentials | **component** | `pnpm test apps/web/src/components/ServerFacts.test.tsx` | ❌ new | ✅ green |
| T3 | 05-14 | 11 | DETL-01, DETL-02 | T-5-61 | Dimmed-vs-discovered computed-style difference; 404 and CONNECTING states | E2E | `pnpm test:e2e --grep @detail` | ❌ new | ✅ green |
| T1 | 05-15 | 11 | ACT-02 | T-5-64 | Fourteen actions mapped; unknown action degrades safely | unit | `pnpm test apps/web/src/lib/activity-copy.test.ts` | ❌ new | ✅ green |
| T2 | 05-15 | 11 | **ACT-02, UI-02** | T-5-64 | Curated metadata only — an unknown key reaches no part of the row | unit + **component** | `pnpm test apps/web/src/lib/activity-groups.test.ts apps/web/src/components/ActivityRow.test.tsx` | ❌ new | ✅ green |
| T3 | 05-15 | 11 | ACT-02 | T-5-64 / T-5-67 | Opaque cursor pagination; no raw JSON anywhere on the page | E2E | `pnpm test:e2e --grep @activity` | ❌ new | ✅ green |
| T1 | 05-16 | 11 | SET-01 | T-5-70 | Row type cannot express an editable row; ms→s conversion | unit | `pnpm test apps/web/src/lib/settings-rows.test.ts` | ❌ new | ✅ green |
| T2 | 05-16 | 11 | **SET-01, UI-02** | T-5-69 / T-5-70 | Zero input-like roles by role query; no key material on screen | **component** | `pnpm test apps/web/src/components/SettingsGroups.test.tsx` | ❌ new | ✅ green |
| T3 | 05-16 | 11 | SET-01 | T-5-69 | Collapsed-by-default Advanced group in a real browser | E2E | `pnpm test:e2e --grep @settings` | ❌ new | ✅ green |
| T1 | 05-17 | 12 | UI-02 | T-5-78 / T-5-79 | Strict bodies; no residual key from the unselected credential branch | unit | `pnpm test apps/web/src/lib/server-form.test.ts` | ❌ new | ✅ green |
| T2 | 05-17 | 12 | **UI-02** | T-5-75 / T-5-76 | `autoComplete=off` on every credential input; edit mode never pre-filled | **component** | `pnpm test apps/web/src/components/CredentialFields.test.tsx` | ❌ new | ✅ green |
| T3 | 05-17 | 12 | UI-02 | T-5-73 / T-5-74 | JSON content type, never multipart; no credential in storage or history | E2E | `pnpm test:e2e --grep @sheet` | ❌ new | ✅ green |
| T1 | 05-18 | 12 | DISC-02 | — | Six-step grouping cannot lose or misplace a check id | unit | `pnpm test apps/web/src/lib/discovery-steps.test.ts` | ❌ new | ✅ green |
| T2 | 05-18 | 12 | DISC-02 | T-5-80 | Never shows progress that was not received (settled ignored while CONNECTING) | unit | `pnpm test apps/web/src/lib/discovery-progress.test.ts` | ❌ new | ✅ green |
| T3 | 05-18 | 12 | **DISC-02, UI-02** | T-5-81 / T-5-83 / T-5-85 | All seven severities render their status word; `detail` escaped as text; no job polling | **component** + E2E | `pnpm test apps/web/src/components/DiscoveryStep.test.tsx && pnpm test:e2e --grep @discovery` | ❌ new | ✅ green |
| T1 | 05-19 | 13 | DETL-02 | — | One-time notice decision is pure and cannot re-show after dismissal | unit | `pnpm test apps/web/src/lib/first-trust.test.ts` | ❌ new | ✅ green |
| T2 | 05-19 | 13 | DETL-02, UI-02 | — | Both fingerprints stacked in mono; trust requires typing the name | static gate | `pnpm build && pnpm lint && pnpm typecheck` (behaviour proven by T3 and by 05-23's tested `DestructiveConfirmDialog`) | ✅ exists | ✅ green |
| T3 | 05-19 | 13 | DETL-02, D-17 | UF-01 | UI-level regression: edit host in ERROR, then trust must fail safely | E2E | `pnpm test:e2e --grep @hostkey` | ❌ new | ✅ green |
| T1 | 05-20 | 14 | QA-04 | — | Full critical path against real api + worker + web + sshd | E2E | `pnpm test:e2e --grep @critical` | ❌ new | ✅ green |
| T2 | 05-20 | 14 | QA-04 | — | CI e2e job + nightly 20x and 100-connection stress; stray-container check | E2E (workflow) | `pnpm exec playwright test --list` + the workflow assertion in the task | ❌ new | ✅ green |
| T3 | 05-20 | 14 | QA-04 | — | 20/20 nightly repetition confirmed locally (repo has no remote) | **manual** — see Manual-Only Verifications | `pnpm test:e2e --grep @critical --repeat-each=20` run locally | n/a | ✅ green |
| T1 | 05-21 | 15 | QA-05 | T-5-97 / T-5-98 | No canary secret in rendered HTML, console, storage, URL, history, bodies, SSE, logs, activity | integration + E2E | `pnpm security:scan-leaks` | Partial — UI-output scan is this task | ⚠️ flaky (see 05-21-SUMMARY.md's own honest flakiness note) |
| T2 | 05-21 | 15 | QA-05 | T-5-99 / T-5-100 / T-5-103 | Repo-wide UI safety gates, comment-filtered, in CI | static gate | `pnpm check:ui-safety && pnpm lint && pnpm typecheck && pnpm boundaries && pnpm test && pnpm test:boot` | ❌ new | ✅ green |
| T3 | 05-21 | 15 | UI-01, UI-02 | T-5-101 | Design-system conformance in both themes + the contrast decision | **blocking human checkpoint** | manual `noodara-ux-review` audit → `docs/ui-review-05.md` | n/a | ⬜ pending |

*Status: ⬜ pending · ✅ green · ❌ red · ⚠️ flaky*
*File Exists: whether the named test file already exists in the repo at planning time.*

**Requirement coverage check:** every one of the phase's ten requirement IDs appears above — `SERV-04` (05-13), `DETL-01` (05-14), `DETL-02` (05-01, 05-14, 05-19), `DISC-02` (05-04, 05-05, 05-18), `ACT-02` (05-15), `SET-01` (05-16), `UI-01` (05-03, 05-06, 05-07, 05-08, 05-09, 05-12, 05-22, 05-23, 05-24, 05-25, 05-21), `UI-02` (05-07 … 05-19, 05-21), `QA-04` (05-10, 05-20), `QA-05` (05-01, 05-02, 05-03, 05-05, 05-21).

---

## Wave 0 Requirements

Waves 1–3 act as this phase's Wave 0: nothing in `packages/ui` or `apps/web` may start until they are green.

- [x] `edit-server.ts` UF-01 fix + integration test ("edit host in ERROR, then trust-fingerprint fails safely") — **security-blocking, precedes all other items** (Plan 05-01 T1)
- [x] Fixes for T-4-02 (bounded `getSession`), T-4-10 / T-4-38 (pino `err` serializer), T-4-32 (`worker.ts` shutdown try/catch) — Plans 05-01, 05-02
- [x] `scripts/check-package-provenance.mjs` `EXPECTED_PACKAGES` extended to 22 packages + ADR-0000 "Phase 5 additions" section + CI step — Plan 05-03 T2
- [x] Blocking human verification of the eight unaudited packages, including the five component-test DOM packages — Plan 05-03 T1
- [x] `04-SECURITY.md` closed with evidence (`status: verified`, `threats_open: 0`) — Plan 05-03 T3
- [x] Discovery `onCheck` callback + new SSE event type in `KNOWN_EVENT_TYPES` + new read endpoint — Plans 05-04, 05-05
- [x] `packages/ui` scaffold + **the `dom` Vitest project, `vitest.setup.dom.ts` and the `@noodara/ui/testing` harness** — Plan 05-06 (this is what makes every later component task test-first)
- [x] `apps/web` scaffold + turbo task-graph wiring (`dependsOn: ["^build"]`, `passThroughEnv` for new env vars) — Plan 05-07
- [x] `playwright.config.ts` + first E2E spec replacing the `test:e2e` placeholder — Plan 05-10
- [x] `.github/workflows/nightly.yml` — 20x E2E repetition + 100 consecutive connections + canary job — Plans 05-20, 05-21

---

## Manual-Only Verifications

| Behavior | Requirement | Why Manual | Test Instructions |
|----------|-------------|------------|-------------------|
| Visual fidelity to the Apple-inspired design system (surfaces, hairlines, spacing, single action color) in dark and light | UI-01, UI-02 | Subjective design-system conformance is not assertable | Run skill `noodara-ux-review` against each implemented screen in both themes; record PASS / FLAG / BLOCK per dimension in `docs/ui-review-05.md` (Plan 05-21 T3) |
| Light-mode status-pill contrast (full-saturation status text on its own `-soft` background, ≈2.0–3.1:1 vs. the required 4.5:1) | UI-01 | The values come from the locked `noodara-ux-apple` skill; patching them is a skill-owner decision, not an executor's | **Accepted, still open.** Reproduced verbatim in `packages/ui/tokens.css` with a comment pointing at 05-UI-SPEC.md Open Question 1 (threat `T-5-25`). Mitigated meanwhile by the status *word* always being in the DOM, asserted for all six statuses in `StatusPill.test.tsx`. The user decides at Plan 05-21's checkpoint: patch the skill, accept for v0.1, or hold the phase |
| Nightly 20/20 run on real CI | QA-04 | Repo has no remote yet; the workflow can only be validated locally | Run the nightly job's script locally in a loop; confirm 20/20 green and attach the output to `05-20-SUMMARY.md` |
| CSS-only effects: `scale(0.97)` active transform, focus-ring paint, skeleton pulse, sheet 320ms transition, `prefers-reduced-motion` degradation | UI-01 | jsdom computes no styles and Playwright cannot judge aesthetics | Playwright asserts computed-style *differences* where a difference is meaningful (the DETL-02 dimmed case); the rest is covered by the `noodara-ux-review` audit. ADR-0005 records this boundary so no executor drops a CSS property because a unit test cannot see it |

---

## Validation Sign-Off

- [x] All tasks have `<automated>` verify, or are one of the three declared blocking human checkpoints (05-03 T1, 05-20 T3, 05-21 T3)
- [x] Sampling continuity: no 3 consecutive tasks without automated verify
- [x] Every component-producing task recorded its RED observation in its SUMMARY (CLAUDE.md §2.1)
- [x] Wave 0 (waves 1–3) items all shipped
- [x] No watch-mode flags
- [x] Feedback latency < 60s for the quick run
- [x] `nyquist_compliant: true` set in frontmatter

**Approval:** Plan 05-21 Task 2 confirms every row above (2026-09-20) — every automated-verify task row is green except 05-21 T1 itself, which is correct-but-flaky under this session's own severe host memory pressure (see 05-21-SUMMARY.md). Task 3's checkpoint (the design-system review + the light-mode contrast decision) is the one remaining open item; the user's sign-off is still pending.
