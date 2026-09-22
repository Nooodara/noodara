---
phase: 05-ui-web
plan: 18
subsystem: ui
tags: [nextjs, react, sse, discovery, tdd, e2e, accessibility]

# Dependency graph
requires:
  - phase: 05-ui-web
    provides: "05-14's server detail screen (deriveDetailState, ServerFacts, the page's documented Discovery seam and its `now`/warnings locals); 05-04's server.discovery_progress SSE event and its { serverId, check } payload; 05-05's GET /api/servers/:id/discovery read endpoint; 05-12's shared useServerEvents/ShellContext (subscribe/registerResync); 05-13's apps/web component-test setup (renderUi/@noodara/ui/testing, oxc.jsx fix); packages/domain's DISCOVERY_CHECK_IDS/DiscoveryCheck; packages/ui's Disclosure/Button/tone.ts"
provides:
  - "apps/web/src/lib/discovery-steps.ts: DISCOVERY_STEP_NAMES/CHECK_TO_STEP/STEP_LABELS -- the six-step grouping (D-06), CHECK_TO_STEP declared satisfies Record<DiscoveryCheckId, DiscoveryStepName> so a domain check id added/removed is a compile error"
  - "apps/web/src/lib/discovery-progress.ts: severityFor/buildChecklist/summarize -- the pure reducer turning received checks + settled snapshot + server status into per-step/per-check view state; buildChecklist ignores the settled snapshot entirely while CONNECTING (D-05)"
  - "apps/web/src/components/DiscoveryStep.tsx: one step row -- severity dot, status word, icon aria-label, expandable raw checks in mono, SS5.5 consequence line for a warning check"
  - "apps/web/src/components/DiscoverySection.tsx: the live/settled section -- cold-loads GET .../discovery on mount/resync, Re-run discovery (POST .../discover), aria-live announcements throttled to one per settled check"
  - "the detail page ((shell)/servers/[id]/page.tsx) now accumulates server.discovery_progress checks for the viewed server id, clearing the accumulator on a transition into CONNECTING, and mounts DiscoverySection at 05-14's reserved seam"
  - "tests/e2e/discovery.spec.ts: six @discovery route-interception behaviours plus one @ssh-live test driving a real connect-and-discover run against a real sshd Testcontainers fixture"
affects: [05-19 (TOFU surfaces mount at this same page's other seam; the Discovery section's own layout position is now occupied and must not be disturbed), 05-20 (the critical-path E2E can now exercise a real discovery run through the UI, following this plan's @ssh-live precedent), 05-21 (repo-wide gates -- no dangerouslySetInnerHTML, no spinner/animate-spin -- already hold for these two new components)]

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "discovery-steps.ts/discovery-progress.ts never import DISCOVERY_CHECK_IDS a second time by hand -- both import the tuple from @noodara/domain/discovery and iterate it directly, so a domain check addition is either a compile error (CHECK_TO_STEP's satisfies) or a structural test failure (the completeness test iterates the same tuple)"
    - "buildChecklist's CONNECTING branch never reads its own settled argument -- an explicit early branch, commented with the D-05/Pitfall-3 citation, so the mid-run discard rule cannot be silently 'optimised' away in a later edit"
    - "DiscoveryStep is purely presentational -- every severity/word/consequence-line decision is already resolved by discovery-progress.ts's pure functions before it ever reaches this component; the seven-word vocabulary (Pass/Warning/Fail/Not applicable/Skipped/Pending/Running) is a single satisfies Record<CheckState, string> table, never a conditional chain"
    - "the live checklist itself is never an aria-live region (that would announce every intermediate render) -- a separate, hidden aria-live=\"polite\" region is updated exactly once per newly-received check, via a ref-tracked previous-count comparison"
    - "the Discovery section's own Re-run discovery button (D-07: 'vive en esa sección') is a second, independent POST /discover call site from the toolbar's own Re-run discovery action (05-14) -- disambiguated with its own discovery-rerun-button testid so neither hides the other from an accessible-name query"
    - "the detail page accumulates server.discovery_progress checks in its own page state (never inside DiscoverySection itself), matching the plan's own explicit design -- DiscoverySection only ever renders what it is handed, never subscribes to the SSE stream directly"

key-files:
  created:
    - apps/web/src/lib/discovery-steps.ts
    - apps/web/src/lib/discovery-steps.test.ts
    - apps/web/src/lib/discovery-progress.ts
    - apps/web/src/lib/discovery-progress.test.ts
    - apps/web/src/components/DiscoveryStep.tsx
    - apps/web/src/components/DiscoveryStep.test.tsx
    - apps/web/src/components/DiscoverySection.tsx
    - tests/e2e/discovery.spec.ts
  modified:
    - apps/web/src/app/(shell)/servers/[id]/page.tsx

key-decisions:
  - "CHECK_TO_STEP's keys are quoted string literals ('hostname': 'os', ...), not bare identifiers -- the plan's own acceptance criterion (`grep -c \"'hostname'\"` is 1) requires the literal quoted substring to appear exactly once, as a map key only"
  - "severityFor/buildChecklist collapse the domain's four DiscoveryCheckStatus values into a seven-word CheckState union (pass/warning/fail/not_applicable/skipped/pending/running) rather than the plan's own looser 'idle for skipped and not_applicable' phrasing -- keeping the two distinct lets DiscoveryStep render the correct one of SS4.2's seven words at both check and step granularity, never a collapsed 'idle' bucket with no matching word in the vocabulary table"
  - "a discovery-group check only ever shows running once at least one check has actually been received for the current run (receivedChecks.length > 0) -- the plan's own first behaviour example (zero received checks -> all four discovery steps pending) would otherwise fail, since discovery only starts after the connection itself succeeds and no check is 'next in line' before that"
  - "DiscoverySection renders nothing (returns null) when the server has never been discovered and is not currently CONNECTING -- 05-14's 'Not discovered yet' empty state already owns that case, and a '0 of 0 passed' summary here would be meaningless; not in the plan's own literal text but required for the section to make sense at every reachable server state, not just the ones the plan's examples covered"
  - "a run settling (a transition out of CONNECTING) auto-collapses the section to its one-line summary, matching D-07's 'al terminar se asienta en un resumen de una línea' -- tracked via a ref comparing the previous serverStatus, not re-derived from every render"
  - "the Discovery section's Re-run discovery button carries its own discovery-rerun-button testid, distinct from the toolbar's server-detail-primary-action -- both can render the identical accessible name 'Re-run discovery' simultaneously for a CONNECTED server (05-14's toolbar action plus this plan's own section action, per D-07), and a bare accessible-name query would otherwise be ambiguous"

requirements-completed: [DISC-02, UI-02]

# Metrics
duration: ~55min
completed: 2026-09-19
---

# Phase 5 Plan 18: Discovery Progress Narrative Summary

**Six named discovery steps (SSH reachable → Authenticated → OS → Resources → Docker → Access) with honest pass/warning/fail severities, a settled one-line summary, and live per-check SSE progress proven end to end against a real sshd fixture -- no spinner, no invented progress, no job polling.**

## Performance

- **Duration:** ~55 min (commit span, `842d25e`..`af61320`)
- **Completed:** 2026-09-19
- **Tasks:** 3 (Task 1 RED/GREEN; Task 2 RED/GREEN; Task 3 RED/GREEN for `DiscoveryStep.test.tsx`, then `DiscoverySection.tsx`/page-wiring as an implementation commit, then a single E2E test commit)
- **Files modified:** 9 (8 new, 1 modified)

## Accomplishments

- `apps/web/src/lib/discovery-steps.ts`: `DISCOVERY_STEP_NAMES`/`CHECK_TO_STEP`/`STEP_LABELS`, `CHECK_TO_STEP` declared `as const satisfies Record<DiscoveryCheckId, DiscoveryStepName>` against the imported `DISCOVERY_CHECK_IDS` tuple -- a domain check id added or removed is a compile error here, never a silently unplaced check. 6 Vitest cases, all green, the completeness assertion iterating the imported tuple directly.
- `apps/web/src/lib/discovery-progress.ts`: `severityFor`/`buildChecklist`/`summarize`, the pure reducer behind every rendering decision about progress. `buildChecklist` structurally ignores its own `settled` argument while `serverStatus === 'CONNECTING'` (D-05/05-RESEARCH.md Pitfall 3), proven by a dedicated test supplying a fully populated previous run and asserting zero resolved discovery steps regardless. 14 Vitest cases, all green; `grep -cE "Date\.now\(\)|new Date\(\)|fetch\("` is 0.
- `apps/web/src/components/DiscoveryStep.tsx`: one step row -- a severity dot/icon (`aria-label` repeating the visible word), the status word itself in text, and a `Disclosure`-wrapped raw-checks list (id + status word + `detail`/`durationMs` in mono, genuinely absent from the DOM until activated). SS5.5's consequence line renders per warning check. 19 component-test behaviours (a loop over all seven `CheckState` values twice, plus disclosure/escaping/consequence-line/no-checks cases), all green.
- `apps/web/src/components/DiscoverySection.tsx`: cold-loads `GET /api/servers/:id/discovery` on mount and on every shell resync, folds it plus the page's own accumulated live checks through `buildChecklist`, renders the "A new discovery run is in progress" caption while `CONNECTING`, the `discovery-summary` one-line settled summary, a dedicated `discovery-rerun-button` posting `POST .../discover` (swallowing `409 ALREADY_CONNECTING`), and a hidden `aria-live="polite"` region announcing exactly one line per newly-received check.
- `apps/web/src/app/(shell)/servers/[id]/page.tsx`: now accumulates `server.discovery_progress` events for the viewed server id in its own state, clearing the accumulator the instant a transition into `CONNECTING` is observed, and mounts `DiscoverySection` at 05-14's reserved seam.
- `tests/e2e/discovery.spec.ts`: six `@discovery` behaviours (settled summary + expand, per-check mono detail/duration, the D-05 mid-run regression proving none of a stale previous run's results leak through, the Docker-warning-stays-Connected-no-banner case, every step's status word in text, and Re-run discovery issuing exactly one `POST .../discover` with zero `/jobs/` requests) plus one `@ssh-live` test (see below).
- `pnpm test` (1331 tests), `pnpm lint`, `pnpm typecheck` (including `tests/e2e/tsconfig.json`), `pnpm boundaries`, `pnpm build`, and `pnpm test:e2e` (62/62, all specs; `@discovery` exactly 6/6; the full file including `@ssh-live` 7/7) are all green. No stray `noodara.test=true` container and no orphaned listener on ports 3000/3100 after any run.

## DISC-02: the live-in-browser evidence

The plan's own instructions require DISC-02 to be marked Complete only with proof that a user sees per-check progress arrive **live** in the browser, not just the settled end state after a reload -- and explicitly permit leaving it Pending if the E2E harness cannot produce a real discovery run against a reachable SSH target.

It can: `tests/integration/helpers/ssh.ts`'s `startSshd` Testcontainers fixture (the same one `tests/integration/ssh/**` and the QA-03 suite already use) is a plain, importable module with no Vitest-runner coupling beyond one already-safe `expect` import inside an unrelated helper, and `@noodara/domain` is already a root devDependency reachable from `tests/e2e/**`. The new `@ssh-live` test in `discovery.spec.ts`:

1. Starts a real `sshd-ubuntu-24.04` Testcontainers fixture (no Docker CLI installed on it, matching the default).
2. Logs in, opens the real Add-server sheet, and registers a server against the fixture's real host/port using the **`pwuser`** account (password auth, non-root, no sudoers entry, not in the `docker` group -- `tests/integration/images/sshd-common/setup-users.sh`) and clicks **"Save and connect"**.
3. Stays on the **same, already-mounted** page instance from that click through full settlement -- no reload anywhere in the test. If the live SSE pipeline were broken, this page would stay stuck on its initial `CONNECTING`/pending render forever; instead it reaches `CONNECTED` with a real `discovery-summary`.
4. Independently instruments the browser's own `EventSource` (a subclass added via `page.addInitScript`, registering its own listener alongside, never replacing, the app's real one) to record every genuine `server.discovery_progress` frame's arrival time and check id.
5. Asserts the eleven checks arrived as **eleven distinct SSE frames**, in the real `DISCOVERY_CHECK_IDS` order, with **more than one distinct arrival timestamp** -- real, measured evidence of incremental delivery, not a single settle payload standing in for a stream.
6. Asserts the rendered UI reflects `pwuser`'s real facts: **Access renders `warning`** (no passwordless sudo, not in the docker group) and **OS renders `pass`** (a genuinely supported Ubuntu 24.04) -- the browser's DOM, not a stub, produced these values from the real run.

This ran in ~3-29s depending on Docker layer-cache warmth (28.5s cold in an isolated run of the file, 3.2s warm as part of the full suite) -- comfortably inside Playwright's 60s per-test budget. **DISC-02 is marked Complete** on this evidence: a real SSH connection, a real multi-check discovery run, real time-separated SSE frames reaching a real browser's real `EventSource`, and a real, unreloaded page rendering the correct, run-specific result.

What this does **not** prove, and was deliberately not attempted to avoid introducing timing-race flakiness (the harness-hygiene "zero known flaky tests" bar): a frame-by-frame correlation between each SSE event's arrival and the exact DOM mutation React committed in response (React's asynchronous commit scheduling makes that race-prone to assert deterministically). The "no reload, single mounted page, genuine incremental SSE" evidence above is the structural substitute the plan's own text anticipated ("prove what you can").

## Task Commits

1. **Task 1 RED: failing discovery-steps test** - `842d25e` (test)
2. **Task 1 GREEN: discovery-steps.ts step grouping** - `43b76a6` (feat)
3. **Task 2 RED: failing discovery-progress test** - `65bd143` (test)
4. **Task 2 GREEN: discovery-progress.ts reducer** - `6064cd8` (feat)
5. **Task 3 RED: failing DiscoveryStep component test** - `fdb4752` (test)
6. **Task 3 GREEN: DiscoveryStep.tsx** - `17d5d64` (feat)
7. **Task 3: DiscoverySection.tsx + detail-page wiring** - `41e6abb` (feat)
8. **Task 3: E2E coverage (6 @discovery + 1 @ssh-live)** - `af61320` (test)

**Plan metadata:** (this commit, docs: complete plan)

## Files Created/Modified

- `apps/web/src/lib/discovery-steps.ts` / `discovery-steps.test.ts` - `DISCOVERY_STEP_NAMES`, `CHECK_TO_STEP`, `STEP_LABELS`
- `apps/web/src/lib/discovery-progress.ts` / `discovery-progress.test.ts` - `severityFor`, `buildChecklist`, `summarize`
- `apps/web/src/components/DiscoveryStep.tsx` / `DiscoveryStep.test.tsx` - one step row
- `apps/web/src/components/DiscoverySection.tsx` - the live/settled section
- `apps/web/src/app/(shell)/servers/[id]/page.tsx` - accumulates live checks, mounts the section
- `tests/e2e/discovery.spec.ts` - 6 `@discovery` + 1 `@ssh-live` behaviours

## Decisions Made

See `key-decisions` in frontmatter -- summarized: `CHECK_TO_STEP`'s keys are quoted to satisfy the plan's own literal grep; the seven-word `CheckState` union stays ungrouped (never collapsed to a generic "idle") so every rendered word matches SS4.2's vocabulary exactly; a discovery check only shows `running` once the run has actually started (at least one check received); `DiscoverySection` renders nothing for a server that has never been discovered and isn't connecting; a settling run auto-collapses to its summary; the section's own Re-run discovery button is deliberately a second, independently-testid'd action alongside the toolbar's.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] The literal "zero received checks -> all four discovery steps pending" behaviour would have shown the first pending check as `running`**
- **Found during:** Task 2, first GREEN run of `discovery-progress.test.ts`
- **Issue:** The initial `buildChecklist` implementation always computed "the next unresolved check in `DISCOVERY_CHECK_IDS` order" and marked it `running`, even when zero checks had been received yet -- showing `hostname` as `running` before the connection itself had even succeeded, which invents progress the run has not actually started producing.
- **Fix:** The "next unresolved" computation is now skipped entirely (`firstUnresolvedIndex = -1`) unless at least one check has been received, matching SS4.3's own rule that discovery only starts after a successful, authenticated connection.
- **Files modified:** `apps/web/src/lib/discovery-progress.ts`
- **Verification:** `pnpm test apps/web/src/lib/discovery-progress.test.ts` (14/14)
- **Committed in:** `6064cd8` (Task 2 GREEN commit)

**2. [Rule 3 - Blocking] `onClick={() => setExpanded((prev) => !prev)}` failed `pnpm lint`**
- **Found during:** Task 3, `pnpm --filter @noodara/web lint` after writing `DiscoverySection.tsx`
- **Issue:** `@typescript-eslint/no-confusing-void-expression` forbids an arrow-function shorthand body that implicitly returns a `void`-typed expression (`setExpanded`'s return type) inside a JSX event handler.
- **Fix:** Wrapped the handler body in braces.
- **Files modified:** `apps/web/src/components/DiscoverySection.tsx`
- **Verification:** `pnpm --filter @noodara/web lint` clean
- **Committed in:** `41e6abb` (folded into the same commit, no separate lint-fix commit needed since it preceded any commit of this file)

**3. [Rule 2 - Missing critical functionality] Two simultaneous "Re-run discovery" buttons with the identical accessible name**
- **Found during:** Task 3, writing the `@discovery` Re-run-discovery E2E test, before it ran
- **Issue:** D-07 requires the Discovery section to carry its own "Re-run discovery" action, but 05-14's toolbar already renders an identically-labelled primary action for a `CONNECTED` server -- `page.getByRole('button', { name: 'Re-run discovery' })` would match two elements and throw a Playwright strict-mode violation.
- **Fix:** Added a dedicated `discovery-rerun-button` testid to the section's own button, leaving the toolbar's `server-detail-primary-action` untouched; the E2E test targets the new testid directly.
- **Files modified:** `apps/web/src/components/DiscoverySection.tsx`, `tests/e2e/discovery.spec.ts`
- **Verification:** `pnpm test:e2e --grep @discovery` (6/6)
- **Committed in:** `41e6abb` (component), `af61320` (test)

---

**Total deviations:** 3 auto-fixed (1 Rule 1 bug caught by the plan's own test before it ever shipped; 1 Rule 3 blocking lint violation; 1 Rule 2 missing-disambiguation gap caught before the E2E test was even run). None changed this plan's own scope or architecture.

## Known Stubs

None. Every surface this plan's own `must_haves` names is real: live per-check progress, the six-step grouping, the mid-run discard, the settled summary, and Re-run discovery all reach a real backend and a real (in the `@ssh-live` case) SSH server.

## Issues Encountered

None beyond the three deviations above, all resolved within this plan's own commits.

## User Setup Required

None -- no external service configuration required, no new packages installed (this plan needed nothing beyond what 05-04/05-05/05-12/05-13/05-14 already provide).

## Next Phase Readiness

- **DISC-02 is now Complete.** See the dedicated section above for the live-in-browser evidence this requirement specifically demanded.
- **UI-02 was already Complete** (all seven screens existed as of Plan 05-17); this plan only extends the server detail screen's own Discovery section, which was already one of its documented, un-stubbed seams.
- Plan 05-19 (TOFU surfaces) mounts at the detail page's *other* documented seam (the first-trust notice, above the label/value groups) -- this plan's own Discovery section, at the bottom of the page, is untouched by that plan's scope.
- Plan 05-20's critical-path E2E can now follow this plan's `@ssh-live` precedent directly (the same `startSshd` fixture, the same "stay on one mounted page, never reload" discipline) if it wants a real, non-stubbed discovery assertion of its own.
- Plan 05-21's repo-wide `check:ui-safety`/DOM-canary gates already hold for `DiscoveryStep.tsx`/`DiscoverySection.tsx`: zero `dangerouslySetInnerHTML`, zero `spinner`/`animate-spin` outside comments (grep-verified), `detail` renders as escaped text only.

---
*Phase: 05-ui-web*
*Completed: 2026-09-19*

## Self-Check: PASSED

Verified on disk: `apps/web/src/lib/discovery-steps.ts`, `discovery-steps.test.ts`,
`discovery-progress.ts`, `discovery-progress.test.ts`, `apps/web/src/components/DiscoveryStep.tsx`,
`DiscoveryStep.test.tsx`, `DiscoverySection.tsx`, `apps/web/src/app/(shell)/servers/[id]/page.tsx`,
`tests/e2e/discovery.spec.ts`. All eight task commits (`842d25e`, `43b76a6`, `65bd143`, `6064cd8`,
`fdb4752`, `17d5d64`, `41e6abb`, `af61320`) confirmed present in `git log --oneline --all`.
`pnpm test` (1331 tests), `pnpm lint`, `pnpm typecheck` (including `tests/e2e/tsconfig.json`),
`pnpm boundaries`, `NOODARA_API_ORIGIN=http://127.0.0.1:3100 pnpm build`, and
`NOODARA_API_ORIGIN=http://127.0.0.1:3100 pnpm test:e2e` (62/62, `@discovery` exactly 6/6, the full
`discovery.spec.ts` file including `@ssh-live` 7/7) all green, leaving no `noodara.test=true`
container and no orphaned listener on ports 3000/3100.
