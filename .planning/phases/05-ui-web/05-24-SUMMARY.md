---
phase: 05-ui-web
plan: 24
subsystem: ui
tags: [react, radix-ui, tooltip, clipboard, vitest, jsdom, testing-library, tailwind-v4, design-tokens, tdd, accessibility]

# Dependency graph
requires:
  - phase: 05-ui-web
    provides: "05-09's format.ts (formatRelativeTime/formatIso/PLACEHOLDER), 05-06's renderUi/userEvent jsdom component-test harness, 05-22's Button/cn conventions, 05-23's lucide-react precedent"
provides:
  - "packages/ui/src/Tooltip.tsx: Radix react-tooltip wrapper (TooltipProvider + Tooltip), --surface-3/--text-caption content, no keyboard/pointer/dismiss overrides, optional controlled `open` for a forced confirmation"
  - "packages/ui/src/RelativeTime.tsx: the single component every timestamp in the app renders through -- relative text + a <time dateTime> carrying the exact instant + an ISO tooltip, PLACEHOLDER for null, `now: Date` always a required caller-supplied prop"
  - "packages/ui/src/CopyButton.tsx: writes exactly the given value to navigator.clipboard.writeText, real accessible name, transient 'Copied' confirmation, silent failure with zero logging, documented as never for credential material"
  - "packages/ui/src/StatTile.tsx: the DETL-01 CPU/RAM/Disk/Uptime tile -- mono tabular-nums value with data-mono, PLACEHOLDER for null (never 0), optional as-of caption, optional 1px meter with data-fraction"
  - "packages/ui/src/LabelValue.tsx: label/value row for System/Docker/Connection/Settings groups -- mono, exactly one CopyButton when copyable, data-dimmed for DETL-02's attenuated last-good-discovery treatment, PLACEHOLDER for null"
  - "packages/ui/src/testing/render.tsx: renderUi now mounts TooltipProvider (delayDuration=0) so every component test picks it up automatically"
affects: [05-11/05-12/05-13/05-14 (servers list/detail/activity/settings screens all compose RelativeTime for timestamps, StatTile/LabelValue for the detail page's stat row and label/value groups, CopyButton for the fingerprint/public-URL/ssh-keygen rows), 05-25 (ListRow reuses Tooltip for collapsed-sidebar labels)]

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "Tooltip's `open` prop is optional and controlled only when explicitly passed -- undefined leaves the Radix primitive's own uncontrolled hover/focus/Escape logic completely untouched (verified by a real Escape-closes-it test), while CopyButton conditionally spreads `{...(copied ? { open: true } : {})}` rather than ever passing `open={cond ? true : undefined}` directly, which trips `exactOptionalPropertyTypes` (a `boolean | undefined` value is not assignable to an optional `boolean` prop under that flag)"
    - "RelativeTime is now the one structural guarantee that a point-in-time snapshot can never be read as a live value without its exact instant one hover/focus away -- every timestamp renders relative text visibly while the ISO instant lives in both a `<time dateTime>` attribute (always present, assistive-tech and Playwright reachable without hovering) and a Tooltip's content (hover/focus reachable), and `now: Date` being a required prop is enforced at the type level, not by convention"
    - "CopyButton forces its own Tooltip open via the controlled `open` prop to show 'Copied' regardless of hover state, since Radix's TooltipTrigger explicitly suppresses its own onFocus-driven open when `isPointerDownRef` is true (a genuine click, unlike a hover, sets that ref) -- an uncontrolled Tooltip would never show a confirmation on click alone"
    - "packages/ui/src's nullish-coalescing lint rule (`@typescript-eslint/prefer-nullish-coalescing`) requires `value ?? PLACEHOLDER` over `value === null ? PLACEHOLDER : value` for every null-to-placeholder mapping -- StatTile and LabelValue both needed this fix before their GREEN commits, matching the ternary-vs-`??` distinction ESLint enforces project-wide"

key-files:
  created:
    - packages/ui/src/Tooltip.tsx
    - packages/ui/src/Tooltip.test.tsx
    - packages/ui/src/RelativeTime.tsx
    - packages/ui/src/RelativeTime.test.tsx
    - packages/ui/src/CopyButton.tsx
    - packages/ui/src/CopyButton.test.tsx
    - packages/ui/src/StatTile.tsx
    - packages/ui/src/StatTile.test.tsx
    - packages/ui/src/LabelValue.tsx
    - packages/ui/src/LabelValue.test.tsx
  modified:
    - packages/ui/src/testing/render.tsx
    - packages/ui/src/index.ts

key-decisions:
  - "Tooltip's controlled `open` prop is additive to the primitive's own uncontrolled default (undefined = untouched hover/focus/Escape logic), letting CopyButton force-show its 'Copied' confirmation without any custom keyboard/pointer/dismiss handler of Tooltip's own -- satisfies both the plan's 'in a Tooltip' instruction and its 'primitive behaviour untouched' constraint"
  - "renderUi wraps every component test in TooltipProvider with delayDuration={0} (not the primitive's real 700ms default) purely for test speed/determinism; apps/web's own root layout mounts the same TooltipProvider without that override for the real app, per the doc comment left in render.tsx"
  - "StatTile/LabelValue's null-to-placeholder mapping uses `??` per this package's own lint rule, not a ternary -- functionally identical, just the enforced idiom"

requirements-completed: []

# Metrics
duration: ~25min
completed: 2026-09-19
---

# Phase 5 Plan 24: Tooltip, RelativeTime, CopyButton, StatTile, LabelValue Summary

**The data-display half of the design system -- RelativeTime structurally guarantees every timestamp carries its exact instant, StatTile/LabelValue guarantee a null discovered fact never renders as a zero, and CopyButton is the one documented, tested copy affordance that never touches credential material.**

## Performance

- **Duration:** ~25 min
- **Started:** 2026-09-19T11:17:00Z
- **Completed:** 2026-09-19T11:23:40Z
- **Tasks:** 3 (each RED test committed separately from its GREEN implementation, per CLAUDE.md SS2.1)
- **Files modified:** 12 (10 new source/test files, `render.tsx`, `index.ts`)

## Accomplishments

- `packages/ui/src/Tooltip.tsx`: a `TooltipProvider` re-export plus a `Tooltip` component on `@radix-ui/react-tooltip` (`--surface-3` background, `--text-caption` content, `sideOffset={4}`). Adds zero `onKeyDown`/`onPointerDown`/custom dismiss handlers of its own -- hover/focus-open and Escape-close are entirely the primitive's own behaviour, proven by a real Escape-closes-the-tooltip test rather than assumed. An optional controlled `open` prop lets a caller (only `CopyButton`, so far) force the tooltip open without touching any of that untouched logic.
- `packages/ui/src/RelativeTime.tsx`: the single component every timestamp in the app now renders through. Renders `formatRelativeTime(value, now)` as visible text; for a non-null value, wraps a `<time dateTime={value}>` element in a `Tooltip` whose content is `formatIso(value)`, so the exact instant is always one hover/focus away *and* always present in the DOM via `dateTime`, reachable by Playwright/assistive tech with no interaction needed. A `null` value renders `PLACEHOLDER` in a plain `<span>` with no `<time>` element and no tooltip. `now: Date` is a required prop -- proven by a `@ts-expect-error` case `pnpm typecheck` actually enforces.
- `packages/ui/src/CopyButton.tsx`: an icon ghost `Button` (`Copy`/`Check` from `lucide-react`) that writes exactly the `value` prop to `navigator.clipboard.writeText`, nothing trimmed or wrapped. A rejected write is swallowed silently -- no throw, no confirmation, zero `console.*` calls (asserted with three separate spies: `error`/`warn`/`log`). A successful copy forces its own `Tooltip` open (via the controlled `open` prop) to show "Copied" for 1500ms, then reverts to the uncontrolled default; the pending `setTimeout` is cleared both before starting a new one and on unmount (verified via a `clearTimeout` spy). A doc comment restricts it to the fingerprint row, the public URL and the `ssh-keygen` command -- never credential material, which `ServerView` structurally cannot carry in the first place.
- `packages/ui/src/StatTile.tsx`: label at `--text-label`, value at `--text-display` mono with `tabular-nums` (`data-mono="true"`), an optional caption slot for the "as of {relative time}" line, and an optional 1px meter driven by a 0..1 `meterFraction` emitting `data-fraction` -- absent entirely when the fraction is `null`/omitted. A `null` value always renders `PLACEHOLDER`, never `0`.
- `packages/ui/src/LabelValue.tsx`: a label/value row supporting `mono` (technical values in `--text-mono`), `copyable` (renders exactly one `CopyButton`, click passes the exact value to the clipboard), and `dimmed` (DETL-02's attenuated last-good-discovery treatment -- `--ink-tertiary` text, always surfaced as `data-dimmed="true"|"false"` so it's assertable from the DOM without computing styles). `null` renders `PLACEHOLDER`.
- `packages/ui/src/testing/render.tsx`'s `renderUi` now mounts `TooltipProvider` (`delayDuration={0}` for test speed) around every rendered tree -- confirmed to regress none of the pre-existing 1093 tests.
- All five RED test files (`Tooltip.test.tsx`, `RelativeTime.test.tsx`, `CopyButton.test.tsx`, `StatTile.test.tsx`, `LabelValue.test.tsx`) were seen to fail for the correct reason (module-not-found) before their GREEN implementations existed -- see RED Observations below.
- `pnpm test` (1120 tests, up from 1093 before this plan across both this plan's 27 new tests and 05-09's own count, zero regressions), `pnpm build` (all 6 workspace packages), `pnpm lint`, `pnpm typecheck`, and `pnpm boundaries` are all green. Every acceptance-criteria grep reports the exact count required (see below).

## Task Commits

1. **Task 1 RED: failing Tooltip/RelativeTime tests** - `7cb3fd3` (test)
2. **Task 1 GREEN: Tooltip and RelativeTime** - `011aafa` (feat)
3. **Task 2 RED: failing CopyButton test** - `5839ef7` (test)
4. **Task 2 GREEN: CopyButton** - `7792d38` (feat)
5. **Task 3 RED: failing StatTile/LabelValue tests** - `099909d` (test)
6. **Task 3 GREEN: StatTile and LabelValue** - `ebfd7b2` (feat)

## RED Observations

- `Tooltip.test.tsx`: failed with `Failed to resolve import "./Tooltip.js" from "packages/ui/src/Tooltip.test.tsx". Does the file exist?` -- 0 tests ran, reported as an import-resolution failure, not an assertion failure.
- `RelativeTime.test.tsx`: failed identically, `Failed to resolve import "./RelativeTime.js"`, before the component existed.
- `CopyButton.test.tsx`: failed identically, `Failed to resolve import "./CopyButton.js"`, before the component existed.
- `StatTile.test.tsx`: failed identically, `Failed to resolve import "./StatTile.js"`, before the component existed.
- `LabelValue.test.tsx`: failed identically, `Failed to resolve import "./LabelValue.js"`, before the component existed.

All five RED failures were for the correct reason (missing implementation module), never a passing-when-it-shouldn't-be assertion -- the plan's own fail-fast rule was not triggered.

## Files Created/Modified

- `packages/ui/src/Tooltip.tsx` - `TooltipProvider`, `Tooltip`
- `packages/ui/src/Tooltip.test.tsx` - trigger rendering, aria-describedby association on hover, Escape-close, controlled `open`
- `packages/ui/src/RelativeTime.tsx` - `RelativeTime`
- `packages/ui/src/RelativeTime.test.tsx` - exact relative text, `dateTime` attribute, null placeholder with no `<time>`, ISO tooltip, required-`now` `@ts-expect-error`
- `packages/ui/src/CopyButton.tsx` - `CopyButton`
- `packages/ui/src/CopyButton.test.tsx` - exact `writeText` call, accessible name, transient confirmation, silent-failure/no-logging, value never duplicated into a DOM attribute, timer cleared on unmount
- `packages/ui/src/StatTile.tsx` - `StatTile`
- `packages/ui/src/StatTile.test.tsx` - mono/tabular-nums value, placeholder-not-zero, caption presence/absence, meter `data-fraction`/absence
- `packages/ui/src/LabelValue.tsx` - `LabelValue`
- `packages/ui/src/LabelValue.test.tsx` - label/value, mono, exactly-one-copy-button-when-copyable, `data-dimmed`, placeholder for null
- `packages/ui/src/testing/render.tsx` - `renderUi` now mounts `TooltipProvider`
- `packages/ui/src/index.ts` - now also exports `CopyButton`, `LabelValue`, `RelativeTime`, `StatTile`, `Tooltip`/`TooltipProvider` (alphabetical)

## Decisions Made

See `key-decisions` in frontmatter -- summarized: `Tooltip`'s controlled `open` prop is additive to (never a replacement for) the primitive's own uncontrolled hover/focus/Escape logic, letting `CopyButton` force its "Copied" confirmation open without any custom dismiss handling of its own; `renderUi` overrides `delayDuration` to `0` purely for test speed, `apps/web`'s real layout will mount `TooltipProvider` without that override; `StatTile`/`LabelValue` use `??` rather than a ternary for their null-to-placeholder mapping per this package's own lint rule.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] `CopyButton`'s conditional `open` prop violated `exactOptionalPropertyTypes`**
- **Found during:** Task 2, `pnpm build`
- **Issue:** `<Tooltip open={copied ? true : undefined}>` type-checked as `boolean | undefined`, which `exactOptionalPropertyTypes: true` rejects for an optional `open?: boolean` prop (`TS2375`) -- the flag requires the property, when present, to be exactly `boolean`, never explicitly `undefined`.
- **Fix:** Switched to a conditional prop spread, `{...(copied ? { open: true } : {})}`, matching the same pattern `Dialog.tsx`'s `error` prop already uses elsewhere in this package -- when not copied, no `open` prop is passed at all (genuinely omitted, not `undefined`-valued).
- **Files modified:** `packages/ui/src/CopyButton.tsx`
- **Verification:** `pnpm build` clean; `pnpm test packages/ui/src/CopyButton.test.tsx` still 6/6 green.
- **Committed in:** `7792d38` (Task 2 GREEN commit -- caught before the commit, no separate fix commit needed)

**2. [Rule 1 - Bug] `CopyButton.test.tsx`'s console spies used empty arrow functions, tripping `no-empty-function`**
- **Found during:** Task 2, `pnpm --filter @noodara/ui lint`
- **Issue:** `.mockImplementation(() => {})` on the three console spies (`error`/`warn`/`log`) triggered `@typescript-eslint/no-empty-function`.
- **Fix:** Changed to `.mockImplementation(() => undefined)`, matching the existing precedent in `apps/control-plane/src/queue/worker-heartbeat.test.ts`.
- **Files modified:** `packages/ui/src/CopyButton.test.tsx`
- **Verification:** `pnpm --filter @noodara/ui lint` clean; `pnpm test packages/ui/src/CopyButton.test.tsx` still 6/6.
- **Committed in:** `7792d38` (Task 2 GREEN commit -- caught before the commit, no separate fix commit needed)

**3. [Rule 1 - Bug] `StatTile`/`LabelValue`'s null-to-placeholder ternaries tripped `prefer-nullish-coalescing`, and a test's array-index access tripped `no-non-null-assertion`**
- **Found during:** Task 3, `pnpm --filter @noodara/ui lint`
- **Issue:** `value === null ? PLACEHOLDER : value` in both `StatTile.tsx` and `LabelValue.tsx` triggered `@typescript-eslint/prefer-nullish-coalescing`; `LabelValue.test.tsx`'s `buttons[0]!` triggered `@typescript-eslint/no-non-null-assertion` (this repo's ESLint config forbids both patterns everywhere, not just in these two files).
- **Fix:** Changed both components' placeholder mapping to `value ?? PLACEHOLDER`; changed the test to assert `getAllByRole('button')` has length 1 and then click the singular `getByRole('button')` instead of indexing into the array.
- **Files modified:** `packages/ui/src/StatTile.tsx`, `packages/ui/src/LabelValue.tsx`, `packages/ui/src/LabelValue.test.tsx`
- **Verification:** `pnpm --filter @noodara/ui lint` clean; `pnpm test packages/ui/src/StatTile.test.tsx packages/ui/src/LabelValue.test.tsx` still 12/12 green.
- **Committed in:** `ebfd7b2` (Task 3 GREEN commit -- caught before the commit, no separate fix commit needed)

---

**Total deviations:** 4 auto-fixed (all Rule 1 bugs caught by this plan's own build/lint gates before their GREEN commits landed)
**Impact on plan:** All four fixes were necessary to make the plan's own verification commands (`pnpm build`, `pnpm lint`) actually pass; none changed what any test asserts, what any component does, or the plan's scope.

## Issues Encountered

None beyond the auto-fixed deviations above. One implementation note worth flagging: Radix Tooltip's `TooltipTrigger` explicitly suppresses its own `onFocus`-driven open when a pointer-down just occurred (`isPointerDownRef.current`), which a real mouse click always sets before firing `onFocus` -- meaning a plain `userEvent.click()` on a `CopyButton` would never open an uncontrolled Tooltip on its own. `CopyButton`'s controlled `open` prop exists specifically to route around that, confirmed correct by this plan's own passing test suite rather than assumed from reading the primitive's source.

## User Setup Required

None -- no external service configuration required. No new packages were installed (per the plan's own ADR-0000 note: `@radix-ui/react-tooltip` was already a dependency from Plan 05-06/05-08's install wave; `lucide-react`'s `Copy`/`Check` icons were already available from Plan 05-23's promotion to a runtime dependency).

## Next Phase Readiness

- `Tooltip`, `RelativeTime`, `CopyButton`, `StatTile`, `LabelValue` are real, behaviourally-tested, token-only pieces every one of 05-UI-SPEC.md's server-detail and settings screens (SS2.5, SS2.7) composes its stat-tile row, label/value groups and timestamp display from -- no shell, screen or `apps/web` route consumes them yet.
- **UI-01 and UI-02 stay Pending in REQUIREMENTS.md.** This plan adds five more `packages/ui` modules -- no shell, screen or `apps/web` route wiring lands here. Matches the same plan-frontmatter-artifact pattern already flagged in STATE.md for SERV-06 (04-01), DETL-02/QA-05 (05-01/05-02/05-03), DISC-02/QA-05 (05-05), and UI-01/UI-02 itself (05-06, 05-22, 05-07, 05-08, 05-23, 05-09). Re-verify UI-01/UI-02 against whichever later plan actually builds the shell and screens (05-UI-SPEC.md SS1-2).
- `DETL-01` (this plan's own frontmatter requirement, alongside `UI-01`/`UI-02`) is likewise not marked complete here for the same reason: `StatTile`'s "mono tabular value, optional as-of caption and optional 1px meter" and `LabelValue`'s "always accept an as-of caption" are real, tested component contracts, but DETL-01's actual user-visible behavior (the server detail page rendering four real stat tiles wired to real discovery data) is Plan 05-14's job, not this one's.
- `CopyButton`'s forced-`open` Tooltip pattern (conditional prop spread, never `open={cond ? true : undefined}` directly) is the precedent any future component needing a controlled Tooltip should follow, given `exactOptionalPropertyTypes` rejects the more obvious ternary form.

---
*Phase: 05-ui-web*
*Completed: 2026-09-19*

## Self-Check: PASSED

Verified on disk: `packages/ui/src/Tooltip.tsx`, `Tooltip.test.tsx`, `RelativeTime.tsx`, `RelativeTime.test.tsx`, `CopyButton.tsx`, `CopyButton.test.tsx`, `StatTile.tsx`, `StatTile.test.tsx`, `LabelValue.tsx`, `LabelValue.test.tsx`. All six task commits (`7cb3fd3`, `011aafa`, `5839ef7`, `7792d38`, `099909d`, `ebfd7b2`) confirmed present in `git log --oneline`. `pnpm test` (1120 tests), `pnpm build`, `pnpm lint`, `pnpm typecheck` and `pnpm boundaries` all green; the acceptance-criteria greps (`onKeyDown|onPointerDown` on `Tooltip.tsx` = 0, `console\.` on `CopyButton.tsx` = 0, `tabular-nums`/`PLACEHOLDER` present in `StatTile.tsx`, `#[0-9a-fA-F]{3,8}|rgb\(` across `packages/ui/src` = 0, `dangerouslySetInnerHTML|JSON.stringify` = 0 in every file this plan touched) all report their required counts.
