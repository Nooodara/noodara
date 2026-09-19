---
phase: 05-ui-web
plan: 09
subsystem: ui
tags: [react, vitest, jsdom, testing-library, tailwind-v4, design-tokens, tdd, accessibility, intl, dates]

# Dependency graph
requires:
  - phase: 05-ui-web
    provides: "05-23's isConfirmationMatch/FileButton/Sheet/Dialog, 05-22's Button/StatusPill data-variant convention, 05-06's renderUi/userEvent jsdom component-test harness, tokens.css/theme.css's --status-error-soft and text-* Tailwind bindings"
provides:
  - "packages/ui/src/format.ts: formatRelativeTime, formatIso, formatMb, formatUptime, formatDiskUsage, PLACEHOLDER -- the one pure, clock-injected formatting module every screen's numbers/timestamps/byte-counts/durations render through"
  - "packages/ui/src/Banner.tsx: the error-state surface (message + separate mono errorCode + at most one action + a children slot), --status-error-soft background"
  - "packages/ui/src/Notice.tsx: the neutral, dismissible surface for D-02's first-trust notice, caller-owned dismissal, no semantic tone"
  - "packages/ui/src/EmptyState.tsx: title + one sentence + at most one action, action typed as a single object (not an array) so D-12 is a real type error, not a convention"
  - "packages/ui/src/Skeleton.tsx: Skeleton (explicit width/height block), SkeletonRow (44px, data-height attribute), SkeletonText -- no spinner, motion-safe pulse only"
affects: [05-11/05-12/05-13/05-14 (servers list/detail/activity/settings screens all compose Banner/Notice/EmptyState/Skeleton for their empty/loading/error states and format.ts for every displayed number/timestamp), 05-17/05-19 (add/edit sheet and HOST_KEY_CHANGED banner reuse Banner's children slot), 05-25 (ListRow's 44px geometry must match SkeletonRow's)]

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "formatRelativeTime/formatIso never read the platform clock -- `now: Date` is always an explicit caller-supplied parameter, matching packages/domain's own now:Date discipline; this is what keeps the formatter test suite (and every screen that calls it) deterministic regardless of the machine's TZ or locale"
    - "Intl.RelativeTimeFormat('en', { numeric: 'always' }) replaces hand-rolled pluralization for relative time (1 minute ago / 5 minutes ago / 3 hours ago / 2 days ago / in 5 minutes), with a hand-coded <60s 'just now' threshold Intl has no equivalent for; Intl.NumberFormat needs useGrouping:false explicitly or it silently inserts thousands separators (1,023 MB instead of 1023 MB) that the spec's literal copy never wants"
    - "formatUptime never mixes seconds into a day/hour/minute pair -- below 60s it renders the whole-second count directly ('45 seconds'), at or above it takes the largest two non-zero units from {day, hour, minute} only, so '1 day, 2 hours' never grows a stray ', 4 seconds' and '1 minute' never degrades to a dangling '1 minute, 0 seconds'"
    - "EmptyState's action prop is typed as a single optional object, never an array, verified by a @ts-expect-error case placed directly above the offending object-literal property line (not above the whole object literal) -- tsc reports the type mismatch on the property's own line, so the suppression comment has to sit there or `pnpm typecheck` reports 'Unused @ts-expect-error directive' instead of proving the constraint"
    - "Skeleton/SkeletonRow/SkeletonText's only motion is Tailwind's motion-safe:animate-pulse variant (compiles to @media (prefers-reduced-motion: no-preference)) -- no bespoke prefers-reduced-motion branch needed, mirroring StatusPill's existing motion-safe: precedent from Plan 05-22"

key-files:
  created:
    - packages/ui/src/format.ts
    - packages/ui/src/format.test.ts
    - packages/ui/src/Banner.tsx
    - packages/ui/src/Banner.test.tsx
    - packages/ui/src/Notice.tsx
    - packages/ui/src/Notice.test.tsx
    - packages/ui/src/EmptyState.tsx
    - packages/ui/src/EmptyState.test.tsx
    - packages/ui/src/Skeleton.tsx
    - packages/ui/src/Skeleton.test.tsx
  modified:
    - packages/ui/src/index.ts

key-decisions:
  - "Intl.RelativeTimeFormat's own numeric:'always' output ('1 minute ago', '3 hours ago', 'in 5 minutes') matches the plan's literal expected strings exactly once thresholds are picked correctly (day >= 86400s, hour >= 3600s, minute >= 60s, else 'just now'), so no hand-rolled pluralization helper was needed for relative time -- only for formatUptime, which Intl.RelativeTimeFormat cannot express (it has no 'day, hour' compound duration mode)"
  - "SkeletonRow defaults its own data-testid to 'skeleton-row' (overridable) rather than requiring every caller to pass one, so Plan 05-13's 5-row list-loading state can render five instances and count them via a single querySelectorAll without threading unique ids through each"
  - "Banner keeps role=\"alert\" on its root even though no acceptance criterion required it -- an error surface should announce itself to assistive tech, and no test asserts its absence"

requirements-completed: []

# Metrics
duration: ~15min
completed: 2026-09-19
---

# Phase 5 Plan 09: Formatters, Banner, Notice, EmptyState, Skeleton Summary

**Pure clock-injected format.ts (relative time, ISO, MB/GB, uptime, disk-used-of-total) plus the four state-vocabulary components -- Banner, Notice, EmptyState, Skeleton -- every screen's empty/loading/error state composes from, each proven by a component test rather than assumed from convention.**

## Performance

- **Duration:** ~15 min
- **Started:** 2026-09-19T11:00:00Z
- **Completed:** 2026-09-19T11:07:00Z
- **Tasks:** 3 (each RED test committed separately from its GREEN implementation, per CLAUDE.md SS2.1)
- **Files modified:** 11 (10 new source/test files, index.ts)

## Accomplishments

- `packages/ui/src/format.ts` exports five pure formatters plus `PLACEHOLDER` (an em dash, `—`): `formatRelativeTime(value, now)` ("just now" under a 60s window, otherwise `Intl.RelativeTimeFormat('en', { numeric: 'always' })` for minute/hour/day, both past ("X ago") and future ("in X")); `formatIso(value)`; `formatMb(mb)` (MB below the 1024 boundary, GB at/above it, `useGrouping:false` so no thousands separators leak into the UI); `formatUptime(seconds)` (largest two of day/hour/minute, or the raw second count below 60s, never a mixed seconds tail); `formatDiskUsage(usedMb, totalMb)` (a human string plus a 0..1 meter fraction, `null` on either null input, `null` fraction -- never `NaN` -- when total is 0). No function reads `Date.now()`/`new Date()` internally (grep-gated at 0); `now` is always the caller's own clock.
- `packages/ui/src/Banner.tsx`: hairline-bordered `--status-error-soft` block. `message` renders verbatim; an optional `errorCode` renders in its own `data-mono="true"` element, never concatenated into the message text; at most one action `Button` (a `action` prop typed as a single object, never an array); a `children` slot for the `HOST_KEY_CHANGED` banner's two stacked mono fingerprint rows (a later plan).
- `packages/ui/src/Notice.tsx`: the neutral, dismissible D-02 first-trust surface -- default surface colour, no `data-tone` attribute anywhere, `onDismiss` invoked exactly once per click when supplied (no button at all when absent), no internally-managed dismissed state, a `children` slot for the verification command + fingerprint.
- `packages/ui/src/EmptyState.tsx`: title + one sentence + at most one action button, no `img`/`svg` anywhere. D-12's "una sola accion" is a real type constraint -- `action?: EmptyStateAction` (a single object), not `EmptyStateAction[]` -- proven by a `@ts-expect-error` case in the test file that `pnpm typecheck` actually enforces, not just documents.
- `packages/ui/src/Skeleton.tsx` exports `Skeleton` (explicit width/height block), `SkeletonRow` (fixed 44px, height also exposed as a `data-height="44"` attribute so it's assertable without computing styles, matching `ListRow`'s real row geometry for Plan 05-13/05-25), and `SkeletonText` (single line). None renders `role="progressbar"`, `role="status"` or an `animate-spin` class anywhere; the only motion is Tailwind's `motion-safe:animate-pulse`, which degrades to a fully static block under `prefers-reduced-motion` with no extra branching.
- All five RED test files (`format.test.ts`, `Banner.test.tsx`, `Notice.test.tsx`, `EmptyState.test.tsx`, `Skeleton.test.tsx`) were seen to fail for the correct reason before their GREEN implementation existed -- see RED Observations below.
- `pnpm test` (1093 tests, up from 1032 before this plan, zero regressions), `pnpm build` (all 6 workspace packages including `apps/web`'s real Next.js/Tailwind pipeline), `pnpm lint`, `pnpm typecheck`, and `pnpm boundaries` are all green. Every grep gate named in the plan's own acceptance criteria reports the exact count it requires (see Deviations for the one gate whose literal scope needed correcting).

## Task Commits

1. **Task 1 RED: failing format.ts test** - `2bb2346` (test)
2. **Task 1 GREEN: pure clock-injected formatters** - `200eba5` (feat)
3. **Task 2 RED: failing Banner/Notice tests** - `f2c9c22` (test)
4. **Task 2 GREEN: Banner and Notice** - `029581f` (feat)
5. **Task 3 RED: failing EmptyState/Skeleton tests** - `3dc5eee` (test)
6. **Task 3 GREEN: EmptyState and Skeleton** - `f47e8e2` (feat)

## RED Observations

- `format.test.ts`: failed with `Cannot find module './format.js' imported from .../format.test.ts` -- 0 tests ran, reported as a failed import, not an assertion failure.
- `Banner.test.tsx`: failed with `Failed to resolve import "./Banner.js" from "packages/ui/src/Banner.test.tsx". Does the file exist?` before `Banner.tsx` existed.
- `Notice.test.tsx`: failed identically, `Failed to resolve import "./Notice.js"`, before the component existed.
- `EmptyState.test.tsx`: failed identically, `Failed to resolve import "./EmptyState.js"`, before the component existed.
- `Skeleton.test.tsx`: failed identically, `Failed to resolve import "./Skeleton.js"`, before the component existed.

All five RED failures were for the correct reason (missing implementation module), never a passing-when-it-shouldn't-be assertion -- the plan's own fail-fast rule was not triggered.

## Files Created/Modified

- `packages/ui/src/format.ts` - `formatRelativeTime`, `formatIso`, `formatMb`, `formatUptime`, `formatDiskUsage`, `PLACEHOLDER`
- `packages/ui/src/format.test.ts` - all six behaviour groups from the plan, including every null case, the 1023/1024 MB boundary, the divide-by-zero disk-usage case, and NaN/Infinity/negative guards
- `packages/ui/src/Banner.tsx` - `BannerProps`, `BannerAction`, the `Banner` component
- `packages/ui/src/Banner.test.tsx` - message verbatim, separate mono errorCode, action button count (0/1), children slot, click wiring
- `packages/ui/src/Notice.tsx` - `NoticeProps`, the `Notice` component
- `packages/ui/src/Notice.test.tsx` - message, dismiss button wiring (present/absent), children slot, no self-managed dismissed state, no `data-tone`
- `packages/ui/src/EmptyState.tsx` - `EmptyStateProps`, `EmptyStateAction`, the `EmptyState` component
- `packages/ui/src/EmptyState.test.tsx` - title/body, action button count (0/1), click wiring, no illustration, `@ts-expect-error` array-rejection case
- `packages/ui/src/Skeleton.tsx` - `Skeleton`, `SkeletonRow`, `SkeletonText`
- `packages/ui/src/Skeleton.test.tsx` - explicit width/height, no progressbar/status role, no animate-spin, `SkeletonRow`'s `data-height="44"`, five-rows-yields-five-elements
- `packages/ui/src/index.ts` - now also exports `Banner`, `EmptyState`, the five `format.ts` functions plus `PLACEHOLDER`/`DiskUsage`, `Notice`, `Skeleton`/`SkeletonRow`/`SkeletonText` (alphabetical)

## Decisions Made

See `key-decisions` in frontmatter -- summarized: `Intl.RelativeTimeFormat`'s own `numeric:'always'` output matched the plan's literal expected strings once the minute/hour/day thresholds were ordered correctly, so no hand-rolled pluralization was needed there (only `formatUptime` needed hand-rolled logic, since `Intl` has no compound day+hour duration mode); `SkeletonRow` defaults its own `data-testid` to `'skeleton-row'` so a caller rendering five in a row doesn't have to thread unique ids through each; `Banner` keeps `role="alert"` as a reasonable accessibility default even though untested.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] `Intl.NumberFormat`'s default grouping inserted thousands separators `formatMb` never wanted**
- **Found during:** Task 1, `pnpm test packages/ui/src/format.test.ts`
- **Issue:** `formatMb(1023)` rendered `"1,023 MB"` instead of `"1023 MB"` -- `Intl.NumberFormat('en', {...})` groups by thousands by default, which the plan's own literal copy examples (`"2 GB"`, `"512 MB"`) never show.
- **Fix:** Added `useGrouping: false` to both the MB and GB `Intl.NumberFormat` instances.
- **Files modified:** `packages/ui/src/format.ts`
- **Verification:** `pnpm test packages/ui/src/format.test.ts` -- all 33 tests green, including the 1023/1024 MB boundary and the very-large-value case.
- **Committed in:** `200eba5` (Task 1 GREEN commit -- caught before the commit, no separate fix commit needed)

**2. [Rule 1 - Bug] format.ts's own doc comments tripped the plan's `Date.now()`/`new Date()` grep gate**
- **Found during:** Task 1, running the acceptance-criteria grep `Date\.now\(\)|new Date\(\)` against `packages/ui/src/format.ts`
- **Issue:** Two doc comments explained the module's own "never reads the clock" discipline by literally naming `Date.now()` as the thing it avoids -- the same self-referential-comment trap Plan 05-23 documented for `Sheet.tsx`'s `onEscapeKeyDown`/`onInteractOutside` mention. The grep gate matches text, not intent.
- **Fix:** Reworded both comments to describe the behaviour ("takes `now: Date` as a parameter instead of reading the platform clock directly", "Never reads the platform clock itself") without the literal `Date.now()`/`new Date()` substrings.
- **Files modified:** `packages/ui/src/format.ts`
- **Verification:** `grep -cE "Date\.now\(\)|new Date\(\)" packages/ui/src/format.ts` returns 0; re-ran the full test suite afterward, still 33/33 green.
- **Committed in:** `200eba5` (Task 1 GREEN commit -- caught before the commit, no separate fix commit needed)

**3. [Rule 1 - Bug] `pluralize`'s template literal failed `@typescript-eslint/restrict-template-expressions` on a bare number**
- **Found during:** Task 1, `pnpm --filter @noodara/ui lint`
- **Issue:** `` `${count} ${label}...` `` interpolated a `number` directly, which this repo's ESLint config forbids (no `allowNumber` override anywhere in `packages/config/eslint.config.js`).
- **Fix:** Changed to `` `${count.toString(10)} ${label}...` ``.
- **Files modified:** `packages/ui/src/format.ts`
- **Verification:** `pnpm --filter @noodara/ui lint` clean; `pnpm test packages/ui/src/format.test.ts` still 33/33.
- **Committed in:** `200eba5` (Task 1 GREEN commit -- caught before the commit, no separate fix commit needed)

**4. [Rule 1 - Bug] `EmptyState.test.tsx`'s `@ts-expect-error` was on the wrong line, itself becoming a `tsc` error**
- **Found during:** Task 3, `pnpm --filter @noodara/ui typecheck`
- **Issue:** The suppression comment sat directly above `const invalidProps: EmptyStateProps = {`, but `tsc` reports the actual type-mismatch diagnostic on the `action: [...]` property line three lines further down (inside the multi-line object literal), not on the object's opening line -- so the directive suppressed nothing on its own line and `tsc` flagged it as `TS2578: Unused '@ts-expect-error' directive`, while the real type error on the `action` line went unsuppressed.
- **Fix:** Moved the `@ts-expect-error` comment to sit directly above the `action: [...]` property line itself.
- **Files modified:** `packages/ui/src/EmptyState.test.tsx`
- **Verification:** `pnpm --filter @noodara/ui typecheck` clean; the directive now genuinely suppresses the one real type error, proving D-12's array-rejection constraint.
- **Committed in:** `f47e8e2` (Task 3 GREEN commit -- caught before the commit, no separate fix commit needed)

**5. [Rule 1 - Bug] The plan's own `animate-spin` grep gate over-matched legitimate negative-assertion test code**
- **Found during:** Task 3, running the acceptance-criteria grep `dangerouslySetInnerHTML|JSON.stringify|animate-spin` across all of `packages/ui/src/**/*.tsx` (including test files)
- **Issue:** The literal grep command in the plan's own `<verify>` block scans `--include="*.tsx"` with no test-file exclusion. `Skeleton.test.tsx` necessarily contains the literal string `animate-spin` inside `.not.toMatch(/animate-spin/)` assertions -- the only way to test the spinner ban's absence is to name the forbidden class in the test. `Button.test.tsx` (committed in Plan 05-22, unmodified by this plan) already contained the same pattern in a `querySelector('[class*="animate-spin"]')` negative assertion, confirming this scope issue predates this plan and is not something this plan's own code introduced. The acceptance criteria's own narrower grep (`dangerouslySetInnerHTML|JSON.stringify` only, no `animate-spin`) does not have this problem and reports 0 as required.
- **Fix:** Verified the actual intent -- zero `animate-spin`/`dangerouslySetInnerHTML`/`JSON.stringify` in *production* source -- by re-running the grep excluding `*.test.tsx` files (`find packages/ui/src -name "*.tsx" ! -name "*.test.tsx" | xargs grep -cE "..."`), which reports 0. No source file changed; this is a verification-command scoping issue, not a code defect, documented rather than silently worked around.
- **Files modified:** none (verification-only; the pre-existing `Button.test.tsx` occurrence is out of scope per the deviation rules' scope boundary)
- **Verification:** `find packages/ui/src -name "*.tsx" ! -name "*.test.tsx" -print0 | xargs -0 grep -cE "dangerouslySetInnerHTML|JSON.stringify|animate-spin"` totals 0; the acceptance criteria's own literal grep (`dangerouslySetInnerHTML|JSON.stringify` only, over all of `packages/ui/src`) also totals 0.
- **Committed in:** n/a (documentation-only finding, no code change)

---

**Total deviations:** 5 auto-fixed (4 Rule 1 bugs caught by this plan's own verify commands before their GREEN commits landed, 1 Rule 1 documentation-only finding about a pre-existing verify-command scoping gap)
**Impact on plan:** All four code fixes were necessary to make the plan's own verification commands actually pass; none changed what any test asserts, what any component does, or the plan's scope. The fifth item is a verify-command scoping note, not a code change -- production source has zero `animate-spin`/`dangerouslySetInnerHTML`/`JSON.stringify` occurrences, which is the actual security/UX property the gate exists to protect.

## Issues Encountered

None beyond the auto-fixed deviations above.

## User Setup Required

None -- no external service configuration required. No new packages were installed (ADR-0000: `format.ts` uses only hand-written logic plus `Intl`, no `date-fns`/`dayjs`/`pretty-bytes`).

## Next Phase Readiness

- `Banner`, `Notice`, `EmptyState`, `Skeleton`/`SkeletonRow`/`SkeletonText` and `format.ts` are real, behaviourally-tested, token-only pieces every one of 05-UI-SPEC.md's seven screens (SS2.1-SS2.7) composes its empty/loading/error state and every displayed number/timestamp from -- no shell, screen or `apps/web` route consumes them yet.
- **UI-01 and UI-02 stay Pending in REQUIREMENTS.md.** This plan adds five more `packages/ui` modules -- no shell, screen or `apps/web` route wiring lands here. Matches the same plan-frontmatter-artifact pattern already flagged in STATE.md for SERV-06 (04-01), DETL-02/QA-05 (05-01/05-02/05-03), DISC-02/QA-05 (05-05), and UI-01/UI-02 itself (05-06, 05-22, 05-07, 05-08, 05-23). Re-verify UI-01/UI-02 against whichever later plan actually builds the shell and screens (05-UI-SPEC.md SS1-2).
- `SkeletonRow`'s 44px height and `ListRow` (Plan 05-25, not yet built) must stay in lockstep -- both this plan's `SkeletonRow` and 05-UI-SPEC.md's own spacing table hardcode 44px for desktop table/list rows, so a future change to `ListRow`'s row height must update `SkeletonRow`'s `ROW_HEIGHT_PX` constant too.
- `formatDiskUsage`'s fraction is intentionally unclamped (can exceed 1 if `usedMb > totalMb`) -- 05-UI-SPEC.md's stat tile meter consumer (a later plan) should clamp for rendering if that case is ever reachable in practice; not addressed here since the plan's own behaviour spec never named an over-100% case.

---
*Phase: 05-ui-web*
*Completed: 2026-09-19*

## Self-Check: PASSED

Verified on disk: `packages/ui/src/format.ts`, `format.test.ts`, `Banner.tsx`, `Banner.test.tsx`, `Notice.tsx`, `Notice.test.tsx`, `EmptyState.tsx`, `EmptyState.test.tsx`, `Skeleton.tsx`, `Skeleton.test.tsx`. All six task commits (`2bb2346`, `200eba5`, `f2c9c22`, `029581f`, `3dc5eee`, `f47e8e2`) confirmed present in `git log --oneline`. `pnpm test` (1093 tests), `pnpm build`, `pnpm lint`, `pnpm typecheck` and `pnpm boundaries` all green; the acceptance-criteria greps (`Date\.now\(\)|new Date\(\)`, `--status-error-soft`, `dangerouslySetInnerHTML|JSON.stringify`, `prefers-reduced-motion`) all report their required counts.
