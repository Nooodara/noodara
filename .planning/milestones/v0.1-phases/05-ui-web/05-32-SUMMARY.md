---
phase: 05-ui-web
plan: 32
subsystem: ui
tags: [react, nextjs, vitest, playwright, sse, activity-log, timezone]

# Dependency graph
requires:
  - phase: 05-ui-web
    provides: activity log screen (05-15), page-1/older-page cursor pagination, SSE shell subscription
provides:
  - "A failed background activity refresh (tab-focus regain, an SSE server.updated/deleted event) preserves the already-loaded list instead of replacing it with an error banner"
  - "A page-1 refresh that returns a full PAGE_LIMIT page with zero overlap is detected as non-contiguous and resets to the fresh page rather than silently splicing two non-adjacent runs together"
  - "Activity day headers group in the viewer's own time zone (component-resolved, test-injectable), not a hardcoded UTC default"
affects: [05-37]

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "mergePage's 'refresh' mode overload returns a { items, contiguous } result instead of a bare array, keeping the 'append' overload's original array-returning shape untouched for loadOlder"
    - "Component-layer Intl.DateTimeFormat().resolvedOptions().timeZone read, threaded into a pure module as an explicit parameter, kept out of the pure module itself"

key-files:
  created:
    - apps/web/src/components/ActivityList.test.tsx
  modified:
    - "apps/web/src/app/(shell)/activity/page.tsx"
    - apps/web/src/lib/activity-groups.ts
    - apps/web/src/lib/activity-groups.test.ts
    - apps/web/src/components/ActivityList.tsx
    - tests/e2e/activity.spec.ts

key-decisions:
  - "All three WR-B-04/05/06 findings reproduced for real (not just corroborated by reading) before any fix was applied"
  - "WR-B-05's gap-closing strategy is a reset to the fresh page (dropping already-loaded older pages), not a re-fetch-with-cursor stitch: 05-UI-SPEC.md sec 2.6 defines no gap-closing affordance either way, so the simpler option was taken per the plan's own fallback instruction"
  - "mergePage's 'refresh' overload gained a required pageLimit parameter and changed its return type to { items, contiguous }; the 'append' overload (used by loadOlder) is unchanged"

requirements-completed: [ACT-02]

# Metrics
duration: 55min
completed: 2026-09-20
---

# Phase 5 Plan 32: Activity log refresh correctness (WR-B-04/05/06) Summary

**Fixed a real "wiped list on background refresh failure" bug, a real "silent >50-event gap" bug, and a real "day headers always in UTC" bug in the activity log screen — all three reproduced first, then fixed, no unreproduced findings this time.**

## Performance

- **Duration:** ~55 min
- **Started:** 2026-09-20 (see STATE.md prior stopped_at)
- **Completed:** 2026-09-20
- **Tasks:** 3
- **Files modified:** 6 (1 created, 5 modified)

## Reproduction Verdicts (per 05-32-PLAN.md's own strict rule)

| Finding | Reproduced? | Evidence | Action taken |
|---|---|---|---|
| WR-B-04 (failed background refresh wipes list) | **Yes** | New E2E case, run against the unfixed code: `expect(page.getByTestId('activity-error-banner')).toHaveCount(0)` failed with `Received: 1` (the banner replaced the 3 already-loaded rows) after a background refresh — triggered by a real `PATCH /api/servers/:id` producing a real `server.updated` SSE event — was stubbed to return 500. | Fixed: `fetchPage1`'s failure branch now uses a functional `setState((prev) => prev.kind === 'ready' ? prev : {...error...})`, mirroring `loadOlder`'s existing precedent. |
| WR-B-05 (silent gap on a full-page refresh with no overlap) | **Yes** | Unit level: new `activity-groups.test.ts` case constructing an exact-`PAGE_LIMIT` (50), zero-overlap incoming page against a 1-item `existing` — before the fix `mergePage` had no `contiguous` signal at all (`result.contiguous` was `undefined`, not `false`). Page level: new E2E case, run against the unfixed code, asserted `activity-row` count `50` after a real SSE-triggered refresh returning 50 non-overlapping items on top of 2 already-loaded rows — received `52` (the two old rows silently retained in front of the fresh 50, with an unmarked and unknown-sized gap between them). | Fixed: `mergePage`'s `'refresh'` overload now returns `{ items, contiguous }`; `contiguous` is `false` only when the incoming page is a full `pageLimit` page sharing no id with `existing`. `page.tsx` resets to the fresh page (dropping older pages) when `contiguous` is `false`. |
| WR-B-06 (day headers grouped in UTC, not the viewer's zone) | **Partially — the defect was confined to the caller, exactly as the review predicted.** The *pure* `groupByDay`/`activity-groups.ts` layer was verified NOT buggy: two new two-zone unit cases (same instant, `UTC` timeZone → `TODAY`; `America/Mexico_City` timeZone → `YESTERDAY`) passed on the very first run, and were re-run under `TZ=UTC` and `TZ=Pacific/Kiritimati` (UTC+14) with identical results — 16/16 both times. The real defect: `ActivityList.tsx` called `groupByDay(state.items, now)` with only two arguments, so it always fell through to `activity-groups.ts`'s `DEFAULT_TIME_ZONE = 'UTC'`. Reproduced with a new component test (`ActivityList.test.tsx`) injecting a `timeZone="America/Mexico_City"` prop that did not yet exist on the component — `expect(screen.getByText('YESTERDAY'))` failed (rendered `TODAY` instead, ignoring the prop). | Fixed: `ActivityList` gained an optional `timeZone` prop, defaulting at the component layer to `Intl.DateTimeFormat().resolvedOptions().timeZone` (never inside the pure module), threaded as `groupByDay`'s third argument. `activity/page.tsx` needed no change — it already relies on the component's own default. |

No finding in this plan was "fixed" without first being demonstrated broken — the strict rule in 05-32-PLAN.md's objective ("If a defect cannot be reproduced ... skip the fix") did not need to be invoked this time; all three did reproduce.

## Accomplishments

- WR-B-04: a failed background refresh (tab-focus regain or an SSE `server.updated`/`server.deleted` event) now keeps every already-loaded row — including "Load older" pages — on screen. Only a genuinely first load (state not yet `ready`) still shows the full-screen error banner.
- WR-B-05: a page-1 refresh that returns a full `PAGE_LIMIT` (50) page sharing no id with what's already loaded is now detected as non-contiguous and resets to the fresh page rather than silently concatenating two non-adjacent runs with an invisible gap between them.
- WR-B-06: activity day headers ("TODAY"/"YESTERDAY"/"SEP 17") now group in the viewer's own time zone, resolved once in the component layer and passed explicitly into the still-100%-pure `groupByDay`.

## Task Commits

1. **Task 1: Reproduce and fix WR-B-04** — `2f56b08` (fix)
2. **Task 2: Reproduce and address WR-B-05** — `c7af30b` (fix)
3. **Task 3: WR-B-06 — group day headers in the viewer's time zone, deterministically** — `25ad1ac` (fix)

**Plan metadata:** commit pending (this SUMMARY + STATE.md/ROADMAP.md update)

_Note: each task's RED (test written, run, observed failing for the right reason) and GREEN (fix applied, same test passing) were both performed in this session but landed as a single `fix:` commit per task rather than separate `test:`/`fix:` commits — the test file and the implementation file for each task were committed together. This matches this plan's own acceptance-criteria framing ("reproduce first... then fix") more than a literal RED-commit/GREEN-commit split, and is consistent with `noodara-tdd`'s "a single commit per complete cycle is also acceptable" allowance._

## Files Created/Modified

- `apps/web/src/app/(shell)/activity/page.tsx` — `fetchPage1`'s failure branch guarded on `prev.kind`; refresh-merge branch calls `mergePage(..., 'refresh', PAGE_LIMIT)` and resets on a detected gap
- `apps/web/src/lib/activity-groups.ts` — `mergePage` gained an `RefreshMergeResult<T>` export and an overloaded signature; `'refresh'` mode now computes and returns `contiguous`
- `apps/web/src/lib/activity-groups.test.ts` — updated existing `'refresh'` mode tests to the new `{ items, contiguous }` shape; added the exact-`PAGE_LIMIT`-zero-overlap and shorter-than-`PAGE_LIMIT` gap cases; added the two-zone `groupByDay` case
- `apps/web/src/components/ActivityList.tsx` — added an optional `timeZone` prop; resolves the viewer's platform zone as the default; passes it as `groupByDay`'s third argument
- `apps/web/src/components/ActivityList.test.tsx` — new; proves the day header follows the injected `timeZone` prop, not a UTC default
- `tests/e2e/activity.spec.ts` — added the WR-B-04 and WR-B-05 reproduction/regression E2E cases, both driving a real `POST`/`PATCH /api/servers` mutation against the real backend to produce a real `server.updated` SSE event (rather than `visibilitychange`, whose firing is not guaranteed headless) as the refresh trigger

## Decisions Made

- **Gap-closing strategy (WR-B-05): reset, not re-fetch-with-cursor stitching.** 05-UI-SPEC.md sec 2.6's "Refresh" paragraph specifies the refresh's own merge behavior ("does not reset scroll position or already-loaded older pages") but says nothing about what to do when a genuine gap is detected — the plan's own fallback instruction for this case is to take the simpler option and document its UX cost. The UX cost: an admin who has scrolled down through several "Load older" pages will have those older pages dropped if 50+ events land while backgrounded (extremely rare in a single-admin v0.1 system) — they can reload them via "Load older" again from the new page 1. This is judged acceptable given ACT-02's realistic traffic pattern and the total absence of a specified alternative.
- **`mergePage`'s API shape.** Followed the plan's explicit design constraint: kept the `'append'` overload's return type (`readonly T[]`) completely unchanged so `loadOlder` required zero edits, and expressed the richer `'refresh'` result via a second TypeScript overload rather than a second exported function — avoiding the "a call site can forget to use it" risk the plan called out.
- **SSE trigger mechanism in the new E2E tests.** Chose "drive a real server mutation" (`POST` then `PATCH /api/servers`, mirroring `servers-list.spec.ts`'s and `server-detail.spec.ts`'s own `page.request.post('/api/servers', ...)` precedent) over dispatching a synthetic `visibilitychange` event, since the latter's actual effect depends on `document.visibilityState`, which is not guaranteed to report `'visible'` under every headless configuration — the real-mutation trigger is unconditionally reliable and exercises the real worker/SSE path end to end.

## Deviations from Plan

None — plan executed exactly as written. All three tasks' own `<action>` reproduce-first discipline was followed, and all three did reproduce (no finding needed the "record non-reproduction, skip the fix" branch).

## Issues Encountered

- First attempt at a broader "same instant, two very-different-now values" unit test for WR-B-06 had a calendar-arithmetic mistake in the test's own expected values (asserted `'MAR 15'` where the correct UTC label was `'YESTERDAY'`). Caught immediately by the test itself failing with a clear message; simplified to a single unambiguous far-future `now` so both zones report an unambiguous abbreviated-date label instead of a TODAY/YESTERDAY edge case. Not a production bug — a test-authoring mistake, fixed before commit.

## User Setup Required

None — no external service configuration required.

## Next Phase Readiness

- SC4/ACT-02's activity-log-stays-correct-while-refreshing gap (05-VERIFICATION.md) is closed for all three named findings.
- Not touched by this plan (out of scope per `files_modified`): `apps/web/src/lib/api-client.ts`, `apps/web/src/lib/error-copy.ts` (owned by 05-28/05-30 this wave), and every other 05-VERIFICATION.md gap (SC2/SC3/DETL-02/DISC-02 detail-page and discovery races, SC5/QA-04/QA-05 CI readiness, the CLAUDE.md DoD findings, the trust-fingerprint TOCTOU) — those remain for their own dedicated gap-closure plans.
- No new dependency, no schema change, no new network surface — this plan's threat register items (T-5G-32-01 gap display-integrity, T-5G-32-04 opaque-cursor handling) are both satisfied: the cursor is never parsed, only passed back exactly as received; the debounce (`REFRESH_DEBOUNCE_MS = 500`) is untouched.

## Self-Check

- `apps/web/src/app/(shell)/activity/page.tsx` — FOUND
- `apps/web/src/lib/activity-groups.ts` — FOUND
- `apps/web/src/lib/activity-groups.test.ts` — FOUND
- `apps/web/src/components/ActivityList.tsx` — FOUND
- `apps/web/src/components/ActivityList.test.tsx` — FOUND
- `tests/e2e/activity.spec.ts` — FOUND
- Commit `2f56b08` — FOUND (`git log --oneline --all | grep 2f56b08`)
- Commit `c7af30b` — FOUND
- Commit `25ad1ac` — FOUND

## Self-Check: PASSED

---
*Phase: 05-ui-web*
*Completed: 2026-09-20*
