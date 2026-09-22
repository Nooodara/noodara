---
phase: 05-ui-web
plan: 15
subsystem: ui
tags: [nextjs, react, tdd, e2e, security, vitest, activity-log, pagination]

# Dependency graph
requires:
  - phase: 05-ui-web
    provides: "05-12's authenticated shell (ShellContext/useShellContext, Toolbar, the shared useServerEvents SSE hook's subscribe/registerResync); 05-13's apps/web .tsx Vitest transform fix and @noodara/ui/testing render harness precedent; 05-07's api-client.ts (apiGet, ServerView) and 05-11's error-copy.ts/require-session.ts; packages/domain/src/activity's AUTH_ACTIONS/SERVER_ACTIONS/ActivityAction union; packages/ui's Disclosure/RelativeTime/EmptyState/SkeletonRow/Banner/LabelValue/Button"
provides:
  - "apps/web/src/lib/activity-copy.ts: sentenceFor/curatedDetailFor -- the fourteen §5.6 sentence templates and the per-action curated metadata key allowlist, the one place any activity row's text comes from"
  - "apps/web/src/lib/activity-groups.ts: groupByDay/mergePage -- pure, clock-and-timezone-injected day grouping and cursor-page merging (append vs. refresh modes)"
  - "apps/web/src/components/ActivityRow.tsx / ActivityList.tsx: the D-14 sentence row with its conditional chevron and curated detail, and the screen body rendering loading/error/ready(day-grouped, paginated, incl. empty)"
  - "apps/web/src/app/(shell)/activity/page.tsx: the real activity log screen (ACT-02) -- fetches GET /api/activity, appends via the opaque nextCursor on Load older, refetches page 1 (merged, not reset) on tab focus and on server.updated/server.deleted SSE events, debounced"
  - "tests/e2e/activity.spec.ts: 8 @activity E2E behaviours proving the screen, pagination and the drop-unknown-keys guarantee in a real browser"
affects: [05-16..05-21 (settings and the add/edit sheet are the remaining UI-02 screens), 05-20 (the critical-path E2E now has a real activity log to visit), 05-21 (the repo-wide no-raw-HTML/DOM-canary gate covers ActivityRow's curated rendering too)]

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "activity-copy.ts's allowlist is structural, not conventional: every metadata read goes through a named, type-checked accessor (stringField/numberField/booleanField/stringArrayField) that looks up exactly one key -- there is no code path in the module that enumerates metadata's own keys (no Object.keys, no spread, no full-object serialization), so an unrecognised key cannot reach sentenceFor's or curatedDetailFor's output by construction, not by review discipline"
    - "the frozen ACTIVITY_COPY table is declared `satisfies Record<ActivityAction, ActivityCopyEntry>`, importing the action union from @noodara/domain/activity rather than re-typing the fourteen literals -- a domain action added without a matching table entry is a compile-time error"
    - "activity-groups.ts's groupByDay takes an explicit `timeZone` parameter (Intl.DateTimeFormat throughout, en-CA locale for a directly-diffable YYYY-MM-DD day key) in addition to the already-established `now: Date` injection pattern, so TODAY/YESTERDAY/midnight-boundary/DST-day grouping is deterministic across the host's own TZ and locale, not just its clock"
    - "mergePage's two modes (append/refresh) share one dedup-by-id filter and only differ in prepend-vs-append direction, and both return the caller's own array reference unchanged when nothing new arrives -- letting the activity page skip a re-render on a no-op refresh and never disturb an expanded row's uncontrolled Disclosure state or the user's scroll position"
    - "ActivityRow never reads item.metadata directly -- every visible string comes from sentenceFor/curatedDetailFor, so the component itself cannot compose prose or leak a field the copy module doesn't already know how to render"
    - "the activity page's SSE-triggered refresh is coalesced through one 500ms debounce (a timer ref, cleared and rescheduled per event) rather than refetching once per event -- an event burst (e.g. several discovery checks completing in quick succession) produces one request, not one per event"

key-files:
  created:
    - apps/web/src/lib/activity-copy.ts
    - apps/web/src/lib/activity-copy.test.ts
    - apps/web/src/lib/activity-groups.ts
    - apps/web/src/lib/activity-groups.test.ts
    - apps/web/src/components/ActivityRow.tsx
    - apps/web/src/components/ActivityRow.test.tsx
    - apps/web/src/components/ActivityList.tsx
    - apps/web/src/app/(shell)/activity/page.tsx
    - tests/e2e/activity.spec.ts

key-decisions:
  - "Server-name resolution (05-UI-SPEC.md §5.6) is split between an injected `ServerLookup` (the live-servers-list match, owned by the page) and activity-copy.ts's own three-tier fallback (live link -> metadata.name plain text -> entity id's first 8 chars mono) -- the module itself performs no fetching, but the fallback *logic* lives in one place rather than being re-implemented per call site"
  - "A page-1 refresh (tab focus regain or a server SSE event) merges new items into the existing list but deliberately never overwrites `nextCursor` -- that cursor marks the boundary of whatever older page the user already loaded via 'Load older', and a fresh top-50 fetch says nothing about that boundary; only `mergePage`'s 'append' path (Load older itself) ever advances the cursor"
  - "curatedDetailFor(item) takes the whole ActivityItem, not just metadata -- `errorCode` (a top-level field, never inside metadata per the domain's own comment) is what §5.6's 'Error: {errorCode}' curated pairs for connection_attempted/discovery_completed failures actually read, so the function signature has to see the full item"
  - "activity-groups.test.ts's Load-older E2E fixture needed explicit, deliberately-ordered `occurredAt` timestamps rather than `new Date()` at each fixture's own construction time -- a real bug in the *test fixture* (not production code) surfaced this: page 2's fixture is built inside the route handler, which only runs after 'Load older' is clicked (later in wall-clock time than page 1's fixtures), so an unordered `new Date()` made the appended item sort newest-first ahead of the already-loaded rows. Fixed with explicit offset timestamps; `groupByDay`'s own strict occurredAt-descending sort is correct and unchanged"
  - "activity.spec.ts's 'only the admin's sign-in' test stubs GET /api/activity (via page.route) rather than asserting against the raw shared E2E stack, even though the plan's own action text named the real stack for this one case -- the shared stack boots with NOODARA_ADMIN_EMAIL/NOODARA_ADMIN_PASSWORD set (tests/e2e/fixtures/stack.ts), which writes its own real auth.admin_preseeded activity event during boot, before any spec's login. 'Only the sign-in' is therefore structurally false against the unstubbed backend regardless of file execution order, matching the exact reasoning 05-13-SUMMARY.md already documented for its own populated-rows E2E test needing interception instead of the real API"

requirements-completed: [ACT-02]

# Metrics
duration: ~10min (commit span, `63e3893`..`7fb9858`; excludes file-reading/context-gathering time)
completed: 2026-09-19
---

# Phase 5 Plan 15: Activity Log Screen Summary

**The activity log screen (ACT-02) -- a structurally-enforced client-side metadata allowlist (fourteen sentence templates, per-action curated keys, zero JSON.stringify), pure day-grouping/cursor-merge helpers, and the real GET /api/activity-backed screen with opaque-cursor pagination and debounced SSE/focus refresh, verified by 8 new E2E behaviours including a live secret-canary proof.**

## Performance

- **Duration:** ~10 min (commit span, `63e3893`..`7fb9858`)
- **Completed:** 2026-09-19
- **Tasks:** 3 (Task 1 RED/GREEN; Task 2 RED/GREEN; Task 3 single test commit, one fixture-timing bug found and fixed before the final green run)
- **Files modified:** 9 (9 new)

## Accomplishments

- `apps/web/src/lib/activity-copy.ts`: `sentenceFor`/`curatedDetailFor`, a single frozen `ACTIVITY_COPY` table (`satisfies Record<ActivityAction, ActivityCopyEntry>`, importing the action union from `@noodara/domain/activity`) encoding all fourteen 05-UI-SPEC.md §5.6 sentences and their curated metadata key lists. Every metadata read goes through a named, type-checked accessor (`stringField`/`numberField`/`booleanField`/`stringArrayField`) that looks up exactly one key -- the module never enumerates `metadata`'s own keys, which is what makes "an unrecognised key never reaches the output" structural rather than a habit (T-5-64). An unknown action degrades to a generic, non-revealing sentence that never interpolates the raw action string. 22 Vitest cases across all seven behaviour groups, all green, including the explicit extra-keys-dropped assertion (`{ host, sshPort, secretish }` yields only the Host pair, `secretish`'s name and value nowhere in the output).
- `apps/web/src/lib/activity-groups.ts`: `groupByDay(items, now, timeZone?)`/`mergePage(existing, incoming, mode)`, both pure and clock-injected -- `groupByDay` additionally takes an explicit `timeZone` (`Intl.DateTimeFormat` throughout, never the host's own default), correctly labelling TODAY/YESTERDAY/an abbreviated date across a midnight boundary and a real US DST-change day (`America/New_York`, verified). `mergePage`'s `'append'`/`'refresh'` modes share one dedup-by-id filter and both return the caller's own array reference unchanged when nothing new arrives. 12 Vitest cases, all green.
- `apps/web/src/components/ActivityRow.tsx`: the sentence from `sentenceFor` (never composed itself), the server name as an accent link when the resolver supplies a target or plain text otherwise, `errorCode` in a `data-mono` element for failures only, a `RelativeTime`, and a `Disclosure` rendered **only** when `curatedDetailFor` returns a non-empty list -- so an action with no curated keys (`auth.logout`/`session_revoked`/`password_reset`) shows no expand control at all. 8 Vitest component cases, all green, including a case proving an unknown metadata key's name and value appear nowhere in the expanded row and a case proving no rendered text in any scenario contains `{"`.
- `apps/web/src/components/ActivityList.tsx`: day headers at `--text-label` over the grouped rows, the ghost `activity-load-older` button shown only while `nextCursor` is non-null, the "No activity yet" / "Actions you take will show up here." empty state, ten `SkeletonRow`s under one skeleton day header for loading, and the error `Banner` with the message, code in mono and Retry.
- `apps/web/src/app/(shell)/activity/page.tsx`: fetches `GET /api/activity?limit=50` on mount; "Load older" appends using the opaque `nextCursor` exactly as returned (URL-encoded, never parsed or reconstructed); refetches page 1 -- merging via `mergePage('refresh', ...)`, never resetting scroll or discarding older pages, and never moving `nextCursor` -- on `visibilitychange` (tab regains focus) and on any `server.updated`/`server.deleted` SSE event, both coalesced through one 500ms debounce so an event burst produces one request, not one per event. Resolves server names from a best-effort `GET /api/servers` fetch. No filter, no search, no `offset=`/`page=` anywhere in the file (asserted).
- `tests/e2e/activity.spec.ts`: 8 `@activity` E2E behaviours -- sign-in-only/TODAY-header/no-Load-older, Load-older pagination retaining prior rows in order, expanding a `server.created` row with a planted secret-looking canary field that never appears in the page text, failure-vs-success `errorCode` mono rendering, `auth.logout`'s missing chevron, a deleted-server reference rendering plain text with no link, loading (ten skeletons, no spinner) + error (exact banner copy, working Retry), and a page-wide proof that no rendered text anywhere contains a raw-JSON-object signature (`{"`). All authenticate through the real login flow (a real session cookie is required to reach `/activity`) but intercept `GET /api/activity` for determinism.
- `pnpm test` (1247 tests, up from 1183 before 05-13/05-14/05-15), `pnpm lint`, `pnpm typecheck`, `pnpm boundaries`, `pnpm build`, `node scripts/check-package-provenance.mjs` (unchanged lockfile, zero new packages) and the full `pnpm test:e2e` (39/39, all specs, `@activity` 8/8) are all green. No stray `noodara.test=true` container and no orphaned listener on ports 3000/3100 after the run.

## Task Commits

1. **Task 1 RED: failing activity-copy tests** - `63e3893` (test)
2. **Task 1 GREEN: activity-copy.ts sentence templates and allowlist** - `81d88f3` (feat)
3. **Task 2 RED: failing activity-groups and ActivityRow tests** - `bd05365` (test)
4. **Task 2 GREEN: activity-groups.ts, ActivityRow, ActivityList, the activity page** - `98191eb` (feat)
5. **Task 3: E2E coverage for the activity log** - `7fb9858` (test)

## Files Created/Modified

- `apps/web/src/lib/activity-copy.ts` / `activity-copy.test.ts` - `sentenceFor`, `curatedDetailFor`, the fourteen-action allowlist
- `apps/web/src/lib/activity-groups.ts` / `activity-groups.test.ts` - `groupByDay`, `mergePage`
- `apps/web/src/components/ActivityRow.tsx` / `ActivityRow.test.tsx` - the D-14 row
- `apps/web/src/components/ActivityList.tsx` - the three screen states, day headers, Load older
- `apps/web/src/app/(shell)/activity/page.tsx` - the real screen (ACT-02)
- `tests/e2e/activity.spec.ts` - 8 `@activity` behaviours

## Decisions Made

See `key-decisions` in frontmatter -- summarized: server-name resolution splits an injected live-lookup from the module's own three-tier fallback logic; a page-1 refresh never moves `nextCursor` (only "Load older" does); `curatedDetailFor` takes the whole item because `errorCode` lives outside `metadata`; the Load-older E2E fixture needed explicit, ordered timestamps after a real (test-only) timing bug surfaced during the first run; the "only the sign-in" E2E case uses stubbing rather than the real stack, matching 05-13's own precedent, since the shared stack's boot-time admin preseed already writes its own activity event before any spec logs in.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] The Load-older E2E fixture's own timestamps produced the wrong row order**
- **Found during:** Task 3, first `pnpm test:e2e --grep @activity` run
- **Issue:** The pagination test's page-2 fixture called `buildActivityItemFixture` (default `occurredAt: new Date().toISOString()`) inside the `page.route` handler, which only executes *after* the test clicks "Load older" -- later in real wall-clock time than page 1's own fixtures, built at test start. `groupByDay`'s correct, strict occurredAt-descending sort therefore placed the "older" page-2 item *first*, not last, failing the row-order assertion. This was a test-fixture timing bug, not a production ordering bug.
- **Fix:** Gave each of the three fixture items an explicit, deliberately-ordered `occurredAt` (alpha newest, gamma oldest, one second apart) instead of relying on construction-time `new Date()`.
- **Files modified:** `tests/e2e/activity.spec.ts`
- **Verification:** `pnpm test:e2e --grep @activity` (8/8, including the pagination test) after the fix.
- **Committed in:** `7fb9858` (part of Task 3's single test commit -- the fix was made before the first green run, not as a separate follow-up commit)

---

**Total deviations:** 1 auto-fixed (1 Rule 1 bug, confined to the new E2E test's own fixture data -- no production code was affected)
**Impact on plan:** None on scope or architecture. The fix confirms `groupByDay`'s own sort behaviour is correct: a caller must supply real, correctly-ordered timestamps for pagination to render as expected, exactly as a real backend always would.

## Issues Encountered

None beyond the one deviation above, resolved within Task 3's own commit before any green run.

## User Setup Required

None -- no external service configuration required. `node scripts/check-package-provenance.mjs` output is unchanged from 05-14 (no new packages; `pnpm-lock.yaml` has no diff for this plan).

## Next Phase Readiness

- **ACT-02 is now Complete.** This plan alone delivers its literal text ("El admin ve el activity log como lista cronológica inversa con actor, entidad, acción y timestamp; los metadatos nunca contienen valores sensibles") end to end -- proven by 22+12+8 passing unit/component tests plus 8 passing `@activity` E2E behaviours, including a live secret-canary proof that an unrecognised metadata field never reaches the rendered page.
- **UI-02 stays Pending.** This plan adds the sixth of the seven screens UI-02 requires (setup, login, servers list, server detail, activity log now done; the add/edit server sheet and settings remain -- Plans 05-16 through 05-21). Matches the same plan-frontmatter-artifact pattern already flagged in STATE.md for every prior UI-01/UI-02 plan this phase.
- `apps/web/src/lib/activity-copy.ts`'s `sentenceFor`/`curatedDetailFor` and `activity-groups.ts`'s `groupByDay`/`mergePage` are standalone, dependency-free pure modules -- no later plan needs to touch them unless the domain's action union or the activity wire shape changes.
- `apps/web/src/app/(shell)/activity/page.tsx`'s debounced-refresh pattern (a timer ref, cleared and rescheduled per triggering event) is available as a precedent for any future screen that also needs to coalesce a burst of SSE events into one refetch.

---
*Phase: 05-ui-web*
*Completed: 2026-09-19*

## Self-Check: PASSED

Verified on disk: `apps/web/src/lib/activity-copy.ts`, `activity-copy.test.ts`, `activity-groups.ts`,
`activity-groups.test.ts`, `apps/web/src/components/ActivityRow.tsx`, `ActivityRow.test.tsx`,
`ActivityList.tsx`, `apps/web/src/app/(shell)/activity/page.tsx`, `tests/e2e/activity.spec.ts`.
All five commits (`63e3893`, `81d88f3`, `bd05365`, `98191eb`, `7fb9858`) confirmed present in
`git log --oneline`. `pnpm test` (1247 tests), `pnpm lint`, `pnpm typecheck`, `pnpm boundaries`,
`NOODARA_API_ORIGIN=http://127.0.0.1:3100 pnpm build`, `node scripts/check-package-provenance.mjs`
(no new packages) and `NOODARA_API_ORIGIN=http://127.0.0.1:3100 pnpm test:e2e` (39/39, `@activity`
8/8) all green, leaving no `noodara.test=true` container and no orphaned listener on ports
3000/3100.
