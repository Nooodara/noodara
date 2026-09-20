---
phase: 05-ui-web
plan: 21
subsystem: testing
tags: [playwright, vitest, security, canary, ci, ux-review, wcag, gap-closure]

# Dependency graph
requires:
  - phase: 05-ui-web
    provides: "tests/integration/activity/canary-http.test.ts (05-01/05-02/05-05's backend canary extensions); tests/e2e/server-sheet.spec.ts's existing storage/request assertions; every screen plan (05-11..05-20) this canary and review walk through; playwright.config.ts and tests/e2e/fixtures/stack.ts (05-10, 05-20)"
provides:
  - "tests/e2e/canary-ui.spec.ts (@canary): a real-browser scan of rendered DOM, console, both storages, history and request URLs across setup/login/add-edit/four screens for two per-run canaries, folded into pnpm security:scan-leaks alongside the three existing Vitest canary suites"
  - "scripts/check-ui-safety.mjs (pnpm check:ui-safety): nine comment-filtered, repo-wide static gates (dangerouslySetInnerHTML count, JSON.stringify, hex/rgb literals, outline:none, Radix onEscapeKeyDown/onInteractOutside overrides, spinners, credentials:include, @noodara/ui/testing import boundary), wired into ci.yml's lint job"
  - "docs/ui-review-05.md: a full noodara-ux-review audit of every phase-5 screen/component in both themes (code+test evidence) plus one real human walkthrough record"
  - ".planning/phases/05-ui-web/05-VALIDATION.md: every per-task row resolved, nyquist_compliant true, wave_0_complete true, the Task 3 checkpoint resolved and recorded"
affects: ["Phase 6 (installer work) inherits a closed, honestly-recorded phase 5 with three named UX gaps still open", "the next gap-closure plan, which owns: light-mode status-pill contrast, the missing floating-elevation shadow, RowMenu's missing aria-expanded", "any future plan touching apps/web/src/app/(shell)/servers/[id]/page.tsx, activity/page.tsx or DiscoverySection.tsx (same stale-snapshot hazard the servers list had, not yet audited/fixed there)"]

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "canary-ui.spec.ts asserts on page.content() (serialized DOM) per screen rather than a single locator's text, so a hidden input or attribute would still be caught"
    - "response bodies for the browser-side canary are read on Playwright's requestfinished event, never on response (a request a navigation abandons mid-flight can leave response.text() pending forever -- see Finding A below)"
    - "check-ui-safety.mjs strips comment lines before any gate counts a match, so a comment describing or banning a pattern can never itself satisfy or invalidate that gate's count"
    - "security:scan-leaks is one command spanning two test runners (vitest run ... && playwright test --grep @canary), kept as a single command a developer can run by hand and the one name CI/nightly both call"

key-files:
  created:
    - tests/e2e/canary-ui.spec.ts
    - scripts/check-ui-safety.mjs
  modified:
    - package.json
    - .github/workflows/ci.yml
    - .github/workflows/nightly.yml
    - .planning/phases/05-ui-web/05-VALIDATION.md
    - .planning/phases/05-ui-web/deferred-items.md
    - docs/ui-review-05.md

key-decisions:
  - "No separate tests/integration/activity/canary-ui-output.test.ts was created: this plan's Task 1 read canary-http.test.ts (already extended by 05-05 to the discovery event and read endpoint) and found the backend-side surfaces (logs, activity_events.metadata, discovery_snapshots.payload, /api/servers* bodies, discovery read endpoint) already fully covered -- creating a duplicate file would have doubled canary runtime for no additional assurance. This plan's files_modified entry for that file is unused by design."
  - "USER DECISION AT CHECKPOINT (2026-09-20): the light-mode status-pill contrast gap is NOT accepted as-is and does NOT hold the phase open -- routed to a follow-up gap-closure plan, verbatim 'Arreglar en gap-closure.' The missing floating-elevation shadow and RowMenu's missing aria-expanded (both newly found by this plan's own ux-review) are routed to the same gap-closure plan."
  - "USER DECISION AT CHECKPOINT (2026-09-20): the human walkthrough was done by the user themselves against a throwaway, orchestrator-provisioned instance behind a temporary Cloudflare Quick Tunnel (ephemeral Postgres/Redis, per-session random secrets, torn down afterwards) -- not the user's real .env, not the committed E2E credentials. The tunnel buffers SSE, so live updates (list insertion, discovery progress) were not observable in that session and remain covered only by E2E, not by human eyes."
  - "USER DECISION AT CHECKPOINT (2026-09-20), VERBATIM: 'No me gusta la UI pero la vamos a ir mejorando con el tiempo. Por el momento le doy approve.' This is approval to CLOSE THE PHASE, not a statement that the visual design is satisfactory -- the user explicitly dislikes the current UI and expects iterative improvement. No specific visual defect was named beyond what this document and docs/ui-review-05.md already recorded. This verdict is never to be paraphrased as 'UI approved' or 'design signed off.'"
  - "QA-05 stays Pending in REQUIREMENTS.md: its literal text ('Un job de CI y nightly siembra secrets canary y verifica que no aparecen en ninguna salida') requires a CI job AND a nightly job, not merely a passing local command -- and this repository has no git remote, so neither workflow has ever executed on GitHub Actions. Same reasoning and same missing-evidence shape as QA-04 (05-20)."
  - "ORCHESTRATOR FINDING: the @canary spec's original ~50% hang rate was misdiagnosed by the previous executor of this plan as 'correct but flaky under host memory pressure, not a code defect.' It was in fact a test-only defect (response.text() awaited on a response event for a request a navigation could abandon mid-flight, never settling) -- fixed in c41701a by reading bodies on requestfinished instead. This is the second time in this phase a real defect was written off as 'the machine' (the first: the SSE subscription race, 05-20). See Finding A below."

requirements-completed: []

# Metrics
duration: "~3h (Tasks 1-2, previous executor, 2026-09-19 22:07-23:16) + orchestrator investigation, checkpoint resolution and final verification (2026-09-19 23:17 - 2026-09-20, see Finding A and Numbers B below) + this continuation's documentation closure"
completed: 2026-09-20
---

# Phase 5 Plan 21: UI-Surface Secrets Canary, Repo-Wide UI Safety Gates, and Phase Close Summary

**One `pnpm security:scan-leaks` command now proves no per-run secret reaches any backend or browser output surface (DOM, console, storage, URL/history, request bodies, SSE); nine comment-filtered static gates make the phase's UI safety rules (single reviewed `dangerouslySetInnerHTML`, no `JSON.stringify` into output, no literal colours, no `outline:none`, no Radix escape/outside-click overrides, no spinners, no cross-origin credentials, `@noodara/ui/testing` reachable only from tests) CI-enforced instead of convention; the phase's own `@canary` E2E spec initially hung on ~half its runs from a real test-only defect that had first been misdiagnosed as host memory pressure, now fixed and verified 12/12; and the user closed the phase on a real, non-buffered-tunnel walkthrough with the honest verdict that they do not like the current UI and are routing three named UX gaps — contrast, floating-elevation shadow, `RowMenu` a11y — to a follow-up gap-closure plan rather than accepting or blocking on them.**

## Performance

- **Duration:** ~3h for Tasks 1-2 (previous executor, 2026-09-19 22:07-23:16) + the orchestrator's flake investigation, throwaway-instance walkthrough and final verification pass (2026-09-19 23:17 through 2026-09-20) + this continuation's documentation closure from the Task 3 checkpoint.
- **Tasks:** 3 of 3 complete. Task 3 (blocking human-verify checkpoint) is resolved per the user's explicit verdict recorded below — a decision about how to close the phase, not a statement of design satisfaction.
- **Files modified:** 8 across Tasks 1-2 (see `key-files`), plus this continuation's documentation-only edits to `05-VALIDATION.md`.

## Accomplishments

- **`tests/e2e/canary-ui.spec.ts` (`@canary`)**: two per-run random canaries (password, passphrase) driven through the real add-server sheet; asserted absent from the serialized DOM of all four screens, every captured `console` message, both `localStorage`/`sessionStorage`, every browser history URL, every request URL, every inspected response body, and after a deliberately failed operation (invalid credential). Credential state is cleared from the DOM after the sheet closes, and re-opening the edit sheet shows no substring of either canary.
- **`pnpm security:scan-leaks` extended**: now runs the three existing Vitest canary suites *and* `playwright test --grep @canary` as one command, the same name CI's `security` job and nightly's `canary` job already call.
- **No duplicate integration file created** (`tests/integration/activity/canary-ui-output.test.ts`): `canary-http.test.ts`, already extended by Plan 05-05, was read first and found to already cover the backend surfaces this plan's Task 1 would otherwise have re-covered — logs, `activity_events.metadata`, `discovery_snapshots.payload`, every `/api/servers*` response body, and the discovery read endpoint. Documented as a deliberate decision, not a gap.
- **`scripts/check-ui-safety.mjs` (`pnpm check:ui-safety`)**: nine independently-reportable, comment-filtered gates across `apps/web/src` and `packages/ui/src`, wired into `ci.yml`'s lint job. Each gate strips `//`, `/*` and `*`-prefixed lines before counting a match, so a comment describing or forbidding a pattern (including this script's own header) can never satisfy or defeat it.
- **`docs/ui-review-05.md`**: a full `noodara-ux-review` audit of every phase-5 screen and shared component, in both themes, evidenced by file:line citations and named passing tests rather than screenshots (none were captured — recorded honestly as code+test-evidence-only). Overall verdict FLAG, zero BLOCK. Three FLAGs found: the already-known light-mode status-pill contrast gap (now with corrected, orchestrator-verified figures), a newly-found missing floating-elevation shadow on `Sheet`/`Dialog`/`RowMenu`, and a newly-found missing `aria-expanded` on `RowMenu`'s trigger.
- **`.planning/phases/05-ui-web/05-VALIDATION.md`**: every per-task row of the 25-plan phase confirmed against what actually shipped (not rewritten), `nyquist_compliant: true`, `wave_0_complete: true` set, and — as of this continuation — the T1 canary row and the T3 checkpoint row updated to reflect the real outcome (see below).

## Finding A: the `@canary` flake was misdiagnosed (orchestrator)

The previous executor of this plan recorded the new `@canary` spec's ~50% timeout rate as "correct but flaky under severe host memory pressure — not a code defect," and reported full E2E as "72/72 excluding the flaky `@canary`." **That was wrong.**

- **Reproduction:** the orchestrator reproduced the failure 2/6, then 4/6 runs. The pattern was **bimodal, not slow**: passing runs took ~2s, failing runs took exactly the 120s timeout, always reported at the final `shell-sign-out` click with `locator.click: Target page, context or browser has been closed`.
- **Ruled out with evidence:**
  - A stuck `pointer-events: none` on `<body>` from the RowMenu → Edit → Sheet → close sequence — a temporary diagnostic ran that sequence 100 times, probing `<body>` and the hit-test target under "Sign out" after each: never stuck.
  - Memory pressure itself — same machine, same load: 12/12 clean after the real fix.
- **Root cause** (from a `--trace retain-on-failure` trace): the sign-out click never started. The spec hung one step earlier, in `await Promise.all(responseCaptures)`, on three `response.text()` calls that never settled. Bodies were read from Playwright's `response` event; a request a navigation abandons mid-flight (an RSC `?_rsc=` prefetch, an in-flight fetch — the trace's network log showed several at `status=-1`) can leave `.text()` pending forever. The reported failing line (the sign-out click) was misleading — it was merely the next statement when the 120s deadline fired.
- **Classification:** test-only defect. No product bug. No canary surface was ever actually leaking.
- **Fix (`c41701a`):** bodies are now read on Playwright's `requestfinished` event, which fires only once a body has fully arrived, so `.text()` resolves immediately; abandoned requests fire `requestfailed` and are never awaited; the long-lived SSE stream never finishes and is excluded by construction. No timeout, retry or skip was added — the widened `testInfo.setTimeout(120_000)` and its "machine-load flakiness" comment were removed (`38f01ca`); the flow fits the default 60s budget ~30x over.
- **Evidence:** before, 6/12 failed across two batches; after, 12/12 passed at 1.7-2.3s each. **Mutation check** on the changed surface: a temporary `page.route` echoing the password canary in `/api/config`'s response body failed the spec with `response from .../api/config leaked a canary`; reverted, tree clean.
- **Residual, accepted limitation:** a response whose request is aborted mid-flight is not inspected — it has no complete body to inspect. Every response the page actually consumed is inspected.
- **Process lesson (recorded in `deferred-items.md` and `STATE.md`):** "flaky under load" is a hypothesis, not a finding. A bimodal duration (fast pass / exact-timeout fail) points at a hang, and a trace names the pending `await` in minutes. This is the **second** time in this phase a real defect was written off as "the machine" — the first was the SSE subscription race documented in `05-20-SUMMARY.md`.

Full evidence trail: `.planning/phases/05-ui-web/deferred-items.md`'s "05-21: `tests/e2e/canary-ui.spec.ts` (`@canary`) hung on ~half its runs — RESOLVED (`c41701a`)" entry.

## Task 1-2 mutation-testing trail (as built by the previous executor)

`docs/ui-review-05.md`'s own accessibility findings cite several `pnpm check:ui-safety` gates as "mutation-tested in this plan's own execution to prove it bites" (the `outline: none` gate, the `onEscapeKeyDown`/`onInteractOutside` gate, the `animate-spin`/`spinner` gate) and point back here for the full trail. That trail lives in the already-committed artifacts rather than being re-derived in this continuation (which does not re-run any test suite, per its own scope): Task 2's own acceptance criteria required the `@noodara/ui/testing` import-boundary gate to be verified "once by a deliberate temporary edit, then reverted," and the committed script's own comments record the `outline: none` gate's exact shape — `/outline:\s*['"]?none['"]?/g`, deliberately requiring the colon form so it never matches Tailwind's legitimate `outline-none` utility class (used throughout `packages/ui` for the required focus-visible ring) — which is the signature of a gate whose first, naive form would have false-positived against that utility class and was narrowed after mutation testing surfaced it.

## Numbers B: final verified state (orchestrator-run, on final code)

- Full `pnpm test:e2e`: **73/73** including `@canary` (1.4m).
- Full `pnpm test`: **1381/1381** (107 files).
- `pnpm check:ui-safety`: exit 0.
- `pnpm boundaries`: exit 0.
- `pnpm lint` and `pnpm typecheck`: exit 0.
- Full `pnpm test:integration`: **487 passed / 0 failed / 1 skipped** (the env-gated `NOODARA_STRESS` suite, justified) — run once by the previous executor of this plan (2082s) and once more by the orchestrator (1855s); harness left clean (0 test containers, nothing on 3000/3100) both times.
- The nightly **20× E2E repeat was 20/20** (three invocations, 7+7+6) — but this was run **before** `@canary` existed as a 73rd spec; it was **not** re-run with the canary included. Stated honestly as a gap, not rounded up.

## The checkpoint: what was presented, and what the user decided

Per Task 3's own instructions, the design-system review and the phase-gate results were presented for sign-off, including the light-mode contrast decision.

**1. Contrast decision — "Arreglar en gap-closure."** The status-pill contrast is **not accepted as-is** and is **not** a phase hold; it is routed to a follow-up gap-closure plan. Orchestrator-verified figures (14%-alpha soft tint composited over `--surface-1`, against the 4.5:1 WCAG AA threshold):

| Status | Light | Dark |
|---|---|---|
| `--status-ok` | 1.98:1 — fails | 6.42:1 — passes |
| `--status-warn` | 1.96:1 — fails | 6.30:1 — passes |
| `--status-error` | 2.95:1 — fails | 4.21:1 — fails narrowly |
| `--status-idle` | 2.84:1 — fails | 4.22:1 — fails narrowly |

`docs/ui-review-05.md`'s first draft overstated dark mode as "passes comfortably (≈6.1-6.3:1)" — true for only two of the four colors; corrected in `6905a46`. The other two review FLAGs (no floating-elevation shadow implemented anywhere; `RowMenu`'s trigger lacks `aria-expanded`) are routed to the same gap-closure plan.

**2. Walkthrough.** The user chose to do it themselves. The orchestrator stood up a throwaway instance (ephemeral Postgres/Redis, per-session random secrets and admin password — **not** the user's `.env` and **not** the committed E2E credentials) behind a temporary Cloudflare Quick Tunnel, verified it end to end through the public URL, and tore it all down afterwards (processes, containers, secrets; the URL confirmed dead). **Limit:** Cloudflare Quick Tunnels buffer Server-Sent Events (verified: the local stream delivers `retry: 5000` immediately; through the tunnel, 0 bytes in 10s), so live updates (live list insertion, check-by-check discovery progress) could **not** be observed by the human in that session. They remain covered by E2E (`@sse-live`, `@ssh-live`, `critical-path.spec.ts`) but are unseen by human eyes. Which screens/themes/input methods the user exercised beyond that was not reported.

**3. Verdict, verbatim:** **"No me gusta la UI pero la vamos a ir mejorando con el tiempo. Por el momento le doy approve."** Meaning: approved to **close the phase**. This is explicitly **not** a statement that the visual design is satisfactory — the user does not like the UI and intends to improve it iteratively. No specific visual defects were named beyond what is already recorded here and in `docs/ui-review-05.md`. This verdict is never to be paraphrased as "UI approved" or "design signed off."

## QA-05 status: stays Pending

**QA-05's literal text** (`REQUIREMENTS.md`): "Un job de CI y nightly siembra secrets canary y verifica que no aparecen en ninguna salida" (a CI job and a nightly job seed secrets canaries and verify they appear in no output).

The canary itself is real and now proven across both the backend and browser surfaces: `pnpm security:scan-leaks` (three Vitest suites + `@canary`) is green, both locally and as job bodies syntax-validated inside `.github/workflows/ci.yml`'s `security` job and `.github/workflows/nightly.yml`'s `canary` job.

**QA-05 is left Pending in `.planning/REQUIREMENTS.md`** (no change made to its checkbox — it was already correctly Pending), because the requirement's own wording names **a CI job and a nightly job**, not a locally-run command. **This repository has no git remote.** Neither workflow file has ever actually executed on GitHub Actions. This is the identical reasoning and the identical missing-evidence shape `05-20-SUMMARY.md` already applied to QA-04.

**Evidence still missing before QA-05 can be marked Complete:**
- A first green `security` job run inside `.github/workflows/ci.yml` on a real pull request or push to `main`, including the `@canary` spec.
- A first green `nightly.yml` `canary` job run (via `workflow_dispatch` or its schedule) as a real GitHub Actions job, not a local invocation.

## Open at phase close

Carried forward honestly rather than declared closed. None of the items below were fixed or hidden by this plan or this continuation.

**Routed to the gap-closure plan (user decision, Task 3 checkpoint):**
- Light-mode status-pill contrast fails WCAG AA for all four status colors (1.96-2.95:1 vs. 4.5:1 required); dark mode fails narrowly for `error`/`idle` (4.21/4.22:1). A property of the locked `noodara-ux-apple` skill's tokens — the replacement text colors are a design decision, not an executor call.
- No floating-elevation shadow (`0 8px 30px rgba(...)`) implemented anywhere on `Sheet`/`Dialog`/`RowMenu`, despite being a documented elevation level in the skill.
- `RowMenu`'s trigger has `aria-haspopup="menu"` but never `aria-expanded` — the one missing WAI-ARIA Menu Button attribute in the whole component inventory.

**`docs/ui-review-05.md`'s "Needs human review" items 1-6, still open (not checked in this automated pass, and not resolved by the one walkthrough that did happen):**
1. Real visual quality in both themes (color rendering, spacing "feel").
2. The floating-elevation gap's actual visual impact.
3. The light-mode contrast gap's real-world legibility.
4. Responsive behavior below 1280px on a real device (only headless-viewport-resize tested).
5. `prefers-reduced-motion`'s actual felt effect and the 320ms/120ms transition timing feel.
6. `RowMenu`'s real screen-reader announcement with an actual screen reader (VoiceOver/NVDA).

**Item 7 — live updates never seen by a human.** The one walkthrough that did happen went through a Cloudflare Quick Tunnel that buffers SSE; live list insertion and check-by-check discovery progress were not observable there. Covered by E2E only.

**Open security/robustness todos** (`.planning/todos/pending/`, referenced not re-described):
- `2026-09-19-trust-fingerprint-toctou.md` (priority: high) — `POST /api/servers/:id/trust-fingerprint` takes no request body and promotes whatever `pendingFingerprint` the row holds at request time, with no binding to the fingerprint the admin actually saw. Needs a backend change (conditional UPDATE / atomic compare).
- `2026-09-19-setup-token-url-hardening.md` — the one-time setup token lingers in the URL/browser history after being read; no `Referrer-Policy` set for the web app.

**From `04-SECURITY.md`:** UF-02 — `worker.ts`'s `main()` has no top-level try/catch, so a boot failure can print a raw error (potentially including `DATABASE_URL`/`REDIS_URL`) to stderr. Still open.

**From `05-20`'s debug session, still open:** `apps/web/src/app/(shell)/servers/[id]/page.tsx` has the same stale-snapshot-overwrites-a-newer-event hazard the servers list page had before its own fix — found by reading, not observed failing, not fixed. `activity/page.tsx` and `DiscoverySection.tsx` were not audited for the same hazard at all.

**QA-04 and QA-05:** both stay Pending — the missing evidence in both cases is the same: a first real green run on GitHub Actions, which this repository (no remote) cannot yet produce.

**The 20× nightly repeat was never re-run with the `@canary` spec included** (it existed before `@canary` was added as spec #73) — stated honestly under Numbers B above.

**Commit hygiene:** ~10 commits across this phase have subjects of 73-86 characters (limit 72); left as-is rather than rewriting history. Zero attribution trailers landed across the phase (several executors added one and amended it away before anything else built on top).

## Task Commits

1. **Task 1: UI-surface secrets canary** — `fce9eec` (test), fix `c41701a`, doc correction `38f01ca` — canary-ui.spec.ts, security:scan-leaks extended, the flake investigation and fix documented above.
2. **Task 2: Repo-wide UI safety gates, phase-gate suite run, validation sign-off** — `1bb74c1` (feat), `faaef73` (docs) — check-ui-safety.mjs, 05-VALIDATION.md confirmed against what shipped.
3. **Task 3 (checkpoint prep): automated UX review** — `a6869c4` (docs), corrected `6905a46` (docs) — docs/ui-review-05.md.
4. **Task 3 (checkpoint resolution, this continuation):** documentation-only closure — this file, plus targeted `05-VALIDATION.md` updates to the T1 canary row (flaky → green, with the real cause) and the T3 checkpoint row (pending → resolved, with the user's verdict quoted verbatim).

## Files Created/Modified

- `tests/e2e/canary-ui.spec.ts` — the browser-side secrets canary (`@canary`)
- `scripts/check-ui-safety.mjs` — nine repo-wide, comment-filtered UI safety gates
- `package.json` — `security:scan-leaks` extended, `check:ui-safety` added
- `.github/workflows/ci.yml` — `check:ui-safety` wired into the lint job; comments confirm the extended canary coverage
- `.github/workflows/nightly.yml` — comments confirm the extended canary coverage the shared script picks up
- `docs/ui-review-05.md` — full per-screen, per-dimension UX review in both themes, corrected contrast figures, human walkthrough record
- `.planning/phases/05-ui-web/05-VALIDATION.md` — every per-task row confirmed; this continuation additionally resolved the T1 canary row's status and the T3 checkpoint row/approval line
- `.planning/phases/05-ui-web/deferred-items.md` — the `@canary` flake's full misdiagnosis-then-correction trail
- `.planning/phases/05-ui-web/05-21-SUMMARY.md` — this file

## Decisions Made

See `key-decisions` in frontmatter above.

## Deviations from Plan

### Auto-fixed Issues (by the previous executor and the orchestrator, before this continuation began)

**1. [Rule 1 - Bug] `@canary`'s hang on navigation-abandoned requests**
- **Found during:** Task 1's own verification, then re-investigated by the orchestrator after the previous executor's misdiagnosis.
- **Issue:** `response.text()` awaited on Playwright's `response` event never settles for a request a navigation abandons mid-flight.
- **Fix:** read bodies on `requestfinished`; strengthen the non-vacuity check to assert BY NAME that `/api/setup`, `/api/servers` and a `/api/servers/:id` response were inspected.
- **Files modified:** `tests/e2e/canary-ui.spec.ts`
- **Verification:** 12/12 clean at ~2s each; mutation check (a temporary canary-echoing `page.route` on `/api/config`) failed the spec as expected, then reverted.
- **Committed in:** `c41701a`

This continuation introduced no new deviations — it is documentation-only, per its own scope (no product code, no test changes, no test suite re-run).

---

**Total deviations:** 1 auto-fixed (Rule 1), landed before this continuation began.
**Impact on plan:** Necessary for correctness of the canary itself; no scope creep, no product surface touched.

## Issues Encountered

The previous executor's own flakiness diagnosis ("host memory pressure, not a code defect") was wrong — see Finding A above. This is recorded as a process lesson in `deferred-items.md` and `STATE.md`, not repeated in full here.

## User Setup Required

None — no external service configuration required.

## Known Stubs

None. This plan's deliverables (a test spec, a static-gate script, and documentation) have no rendered-UI data-wiring surface of their own to stub.

## Next Phase Readiness

Phase 5 (`ui-web`) is closed: all 25 plans executed, the phase gate recorded, and the user has approved closing the phase (with the explicit understanding that the UI's visual design is not yet satisfactory to them and will be iterated on). Three named UX gaps (contrast, floating-elevation shadow, `RowMenu` `aria-expanded`) and the security/robustness items above are the explicit carry-forward for a gap-closure plan before or alongside Phase 6. QA-04 and QA-05 both stay Pending pending a first real green GitHub Actions run once this repository gets a remote. Phase 6 (installer work) can proceed on top of a fully closed, honestly-recorded Phase 5.

---
*Phase: 05-ui-web*
*Completed: 2026-09-20*

## Self-Check: PASSED

All referenced files confirmed present: `tests/e2e/canary-ui.spec.ts`, `scripts/check-ui-safety.mjs`, `docs/ui-review-05.md`, `.planning/phases/05-ui-web/05-VALIDATION.md`, `.planning/phases/05-ui-web/deferred-items.md`, both `.planning/todos/pending/` files referenced. All referenced commit hashes confirmed present in `git log --oneline --all`: `fce9eec`, `1bb74c1`, `faaef73`, `8237bb5`, `a6869c4`, `c41701a`, `38f01ca`, `6905a46`.
