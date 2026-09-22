---
phase: 05-ui-web
plan: 13
subsystem: ui
tags: [nextjs, react, sse, tdd, e2e, security, vitest, oxc]

# Dependency graph
requires:
  - phase: 05-ui-web
    provides: "05-12's authenticated shell (ShellContext/useShellContext, Toolbar, the shared useServerEvents SSE hook, its /servers placeholder page) and server-events.ts's ServerEvent union; 05-25's ListRow/RowMenu; 05-24's RelativeTime; 05-22/05-23/05-09's StatusPill/Banner/EmptyState/SkeletonRow; 05-11's error-copy.ts and its ApiErrorCode/apiGet contract; 05-07's api-client.ts's ServerView"
provides:
  - "apps/web/src/lib/server-store.ts: applyServerEvent/sortServers -- the pure list reducer folding server.updated/server.deleted onto a ServerView[] while preserving untouched entries' object identity"
  - "apps/web/src/components/ServerRow.tsx / ServerList.tsx: the D-09 row (ListRow + StatusPill + RelativeTime + RowMenu, Edit/Delete wired to Plan 05-17-named no-ops) and the screen body rendering loading/error/ready(incl. empty) with no spinner and no card"
  - "apps/web/src/app/(shell)/servers/page.tsx: the real servers list screen (SERV-04) replacing 05-12's placeholder -- fetches GET /api/servers, registers onResync, folds the shared SSE subscription through applyServerEvent, delegates an unauthorized fetch to the shell's own session guard"
  - "vitest.config.ts's oxc.jsx fix + apps/web/src/vitest-matchers.d.ts: apps/web's first-ever .tsx test file surfaced a real, previously-latent transform/typing gap for every future apps/web component test"
affects: [05-14..05-21 (every remaining screen composes ListRow/RowMenu/ServerList-shaped state the same way, and inherits the now-fixed apps/web .tsx test transform), 05-17 (wires the real add/edit sheet and delete dialog onto ServerRow's RowMenu and the toolbar/empty-state Add server actions, both left as named no-ops here), 05-20 (the critical-path E2E now has a real servers list to land on after login)]

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "server-store.ts always returns the original array reference when nothing changed (unknown-id delete, discovery_progress) and always reuses every untouched entry's own object reference on an update, so a caller can skip a re-render cheaply and React never re-renders a sibling row"
    - "ServerRow wraps ListRow in its own data-testid=\"servers-row\"/data-server-name div rather than adding server-specific attributes to ListRow itself -- ListRow is a shared primitive future screens (activity) also need generic"
    - "ServerList's error/ready/loading is one discriminated ServerListState union, not a status/error/servers triple -- the servers page's own state literally is a ServerListState, so there is never a second shape to keep in sync with it"
    - "The toolbar's own primary Add server action is suppressed while the list is genuinely empty (ServerList's EmptyState already renders the one action for that state) -- 05-UI-SPEC.md SS2.3's empty state is explicit about a single button, and the toolbar's always-on primary action would otherwise double it"
    - "vitest.config.ts sets an explicit top-level oxc.jsx option (this project's vite@8.3.0 is rolldown-powered, oxc-transformed, not esbuild) so JSX transforms the same way in every project regardless of a package's own tsconfig jsx setting -- apps/web/tsconfig.json's Next.js-required \"preserve\" was silently breaking every .tsx test under apps/web/src before this fix, latent until this plan's ServerList.test.tsx became the first one to exist"
    - "apps/web/src/vitest-matchers.d.ts mirrors packages/ui/src/testing/vitest-matchers.d.ts's already-established /// <reference types=\"@testing-library/jest-dom/vitest\" /> fix, since apps/web's own tsconfig never includes the repo-root vitest.setup.dom.ts that registers jest-dom's matchers at runtime"

key-files:
  created:
    - apps/web/src/lib/server-store.ts
    - apps/web/src/lib/server-store.test.ts
    - apps/web/src/components/ServerRow.tsx
    - apps/web/src/components/ServerList.tsx
    - apps/web/src/components/ServerList.test.tsx
    - apps/web/src/vitest-matchers.d.ts
    - tests/e2e/servers-list.spec.ts
  modified:
    - apps/web/src/app/(shell)/servers/page.tsx
    - apps/web/package.json
    - vitest.config.ts
    - pnpm-lock.yaml

key-decisions:
  - "server-store.ts's applyServerEvent/sortServers take and return readonly ServerView[] rather than mutable arrays, so ServerListState's own readonly servers field needs no cast at the (shell)/servers/page.tsx call site"
  - "The toolbar's Add server action is hidden while the list is empty (page.tsx's own isEmpty check) -- discovered and fixed before writing Task 3's E2E, since 05-UI-SPEC.md's empty state and Task 3's own behaviour text both require exactly one Add server action on screen at once, and the toolbar's always-on primary action would otherwise double EmptyState's own button"
  - "Task 3's populated-rows E2E test sources its two servers from a stubbed GET /api/servers (full ServerView fixtures) rather than the real API: packages/domain/src/server/connection-result.ts's applyConnectionResult only ever sets lastSeenAt after a genuinely successful SSH connect, which this harness has no reachable sshd fixture to produce -- a freshly POST-registered server's lastSeenAt stays null forever here, so it can never carry the ISO tooltip that test needs to prove. The keyboard-navigation and row-menu tests still seed through the real POST/GET /api/servers round trip, so the spec still proves real data flows end to end"
  - "The ISO tooltip on a RelativeTime <time> element is proven by hover, not focus, in tests/e2e/servers-list.spec.ts -- a plain <time> carries no tabIndex, so a real browser's .focus() call on it is a silent no-op; packages/ui/src/RelativeTime.test.tsx already established hover as this component's own proven trigger, so the E2E spec follows that same precedent"
  - "vitest.config.ts gained a top-level oxc.jsx: { runtime: 'automatic' } option and apps/web gained its own vitest-matchers.d.ts + a direct @testing-library/jest-dom devDependency (existing, already-approved pin, no new package) -- apps/web's tsconfig.json's Next.js-required \"jsx\": \"preserve\" silently broke every .tsx Vitest test under apps/web/src via this project's rolldown-powered oxc transform; ServerList.test.tsx is the first such file to ever exist, so the break was real but previously undetected. apps/web/package.json's own test script also gained --project dom, which it was missing"

requirements-completed: [SERV-04]

# Metrics
duration: ~19min
completed: 2026-09-19
---

# Phase 5 Plan 13: Servers List Screen Summary

**The servers list screen (SERV-04) -- a pure list reducer, D-09's 44px row with its own action menu, and the real GET /api/servers-backed screen with live SSE patching, replacing Plan 05-12's placeholder and verified by 6 new E2E behaviours.**

## Performance

- **Duration:** ~19 min (commit span, `b6d54fd`..`df8dfd0`)
- **Completed:** 2026-09-19
- **Tasks:** 3 (Task 1 RED/GREEN; Task 2 RED/GREEN plus a standalone deviation fix; Task 3 single test commit, RED discovered and resolved within the same cycle)
- **Files modified:** 11 (7 new, 4 modified)

## Accomplishments

- `apps/web/src/lib/server-store.ts`: `applyServerEvent`/`sortServers`, a pure reducer with no React, no fetch, no `Date.now()` (`grep -cE "useState|useEffect|fetch\(|Date\.now"` reports 0). `server.updated` patches an existing entry in place while every other entry keeps its own object reference (`toBe` asserted); an unknown id inserts at the correct case-insensitive sorted position, matching the backend's own `lower(name)` index ordering; `server.deleted` removes a known id and returns the original array reference unchanged for an unknown one; `server.discovery_progress` is ignored (the detail screen's job) and also returns the original reference. 6 Vitest cases, all green.
- `apps/web/src/components/ServerRow.tsx`: the D-09 row -- `ListRow` (real `href="/servers/{id}"` activation) with the name, `host:port` in mono, a `StatusPill`, a `RelativeTime`, and a `RowMenu` whose Edit/Delete handlers are deliberate no-ops named for Plan 05-17. Wrapped in its own `data-testid="servers-row"`/`data-server-name` div rather than extending `ListRow` itself, keeping that shared primitive generic for the activity screen too.
- `apps/web/src/components/ServerList.tsx`: renders exactly one of loading (5 `SkeletonRow`s, zero spinner/progressbar/status roles)/error (`Banner` with the message, the code in a separate `data-mono` element, one Retry)/ready (either the rows or `EmptyState`'s "No servers yet" / "Connect your first Ubuntu server to let Noodara discover it." / one "Add server" button) from a single `ServerListState` discriminated union -- never a card, asserted at a count of one server too (D-09). 6 Vitest cases across all three states, all green, including a proof that an error payload's extra field (`requestId`) reaches no part of the rendered DOM (T-5-56).
- `apps/web/src/app/(shell)/servers/page.tsx`: fetches `GET /api/servers` on mount, registers its own refetch with the shell's `onResync` (a stream reconnect resyncs exactly like a fresh load, no event replay), subscribes to the shared SSE stream and folds `server.updated`/`server.deleted` through `applyServerEvent` only while the list is in its `ready` state, and delegates an `unauthorized` fetch failure to the shell's own `requireSession()` guard rather than redirecting itself. The toolbar's own "Add server" primary action (`servers-add-button`) is suppressed while the list is genuinely empty, since `EmptyState` already renders the one action 05-UI-SPEC.md's empty state requires.
- `tests/e2e/servers-list.spec.ts`: 6 `@servers` E2E tests -- empty/loading/error via `page.route` interception (ADR-0005), the row's name/host:port/status-pill/ISO-tooltip fields, keyboard row activation to `/servers/:id`, and the row menu's hover-reveal plus Edit/Delete exposure. Genuine RED observed on the first run: the populated-rows test failed for the right reason (`.focus()` on a plain, non-`tabIndex` `<time>` element is a silent no-op in a real browser, so no tooltip ever opened) before being fixed to `.hover()`, matching `RelativeTime.test.tsx`'s own already-established precedent.
- A real, previously-latent tooling gap found and fixed: this project's `vite@8.3.0` is rolldown-powered (oxc-transformed, not esbuild), and its JSX transform infers `jsx` from the nearest tsconfig -- `apps/web/tsconfig.json`'s Next.js-required `"jsx": "preserve"` silently broke every `.tsx` Vitest test file under `apps/web/src` (`ServerList.test.tsx` is the first one to ever exist). Fixed with an explicit top-level `oxc.jsx` option in `vitest.config.ts` plus `apps/web/src/vitest-matchers.d.ts` (mirroring `packages/ui`'s own already-established fix for the same class of gap: jest-dom's matcher types never reaching `apps/web`'s own `tsc` program).
- `pnpm test` (1183 tests, up from 1171 before this plan), `pnpm lint`, `pnpm typecheck`, `pnpm boundaries`, `pnpm build`, and `pnpm test:e2e` (24/24, all specs, `@servers` 6/6) are all green. No stray `noodara.test=true` container and no orphaned listener on ports 3000/3100 after the run.

## Task Commits

1. **Task 1 RED: failing server-store tests** - `b6d54fd` (test)
2. **Task 1 GREEN: server-store.ts reducer** - `5b5a8e7` (feat)
3. **Task 2 RED: failing ServerList screen-state tests** - `38ef1b2` (test)
4. **[deviation fix] apps/web .tsx test transform and matcher types** - `6eb2c5b` (fix)
5. **Task 2 GREEN: ServerRow, ServerList, the servers page** - `ff2056a` (feat)
6. **[deviation fix] suppress the toolbar's Add server button while empty** - `d7fd65e` (fix)
7. **Task 3: E2E coverage for the servers list** - `df8dfd0` (test)

## Files Created/Modified

- `apps/web/src/lib/server-store.ts` / `server-store.test.ts` - `applyServerEvent`, `sortServers`
- `apps/web/src/components/ServerRow.tsx` - the D-09 row
- `apps/web/src/components/ServerList.tsx` / `ServerList.test.tsx` - the three screen states
- `apps/web/src/app/(shell)/servers/page.tsx` - the real screen, replacing 05-12's placeholder
- `apps/web/src/vitest-matchers.d.ts` - jest-dom `Assertion` augmentation for `tsc`/ESLint
- `apps/web/package.json` - `@testing-library/jest-dom` devDependency, `test` script gains `--project dom`
- `vitest.config.ts` - top-level `oxc.jsx` option
- `tests/e2e/servers-list.spec.ts` - 6 `@servers` behaviours

## Decisions Made

See `key-decisions` in frontmatter -- summarized: `server-store.ts` is `readonly`-typed end to end so `ServerListState`'s own readonly `servers` field needs no cast; the toolbar's "Add server" action hides while the list is empty so the screen never shows two "Add server" buttons at once; Task 3's populated-rows test uses a stubbed `GET /api/servers` (not the real API) because the domain never sets `lastSeenAt` without a real successful SSH connect, which this harness cannot produce; the ISO tooltip is proven by hover (not focus, which is a no-op on a non-`tabIndex` `<time>`), matching `RelativeTime.test.tsx`'s own precedent; `vitest.config.ts`/`apps/web` gained a real fix for a previously-latent oxc/jest-dom-typing gap.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 3 - Blocking] apps/web's first .tsx test file could not be parsed by Vitest at all**
- **Found during:** Task 2, first `pnpm test apps/web/src/components/ServerList.test.tsx` run
- **Issue:** This project's `vite@8.3.0` is rolldown-powered, whose default transform engine is oxc (esbuild options are silently ignored once oxc options are also set, per Vite's own runtime warning). oxc's JSX transform infers its `jsx` runtime from the nearest tsconfig -- `apps/web/tsconfig.json` deliberately sets `"jsx": "preserve"` (required by Next.js's own build), which left every `<Foo />` untransformed, and Vitest's Rolldown-based module loader then failed with "Unexpected JSX expression" trying to parse the emitted JSX as plain JS. Separately, `tsc --noEmit`/ESLint's type-aware linting failed on every `jest-dom` matcher (`toBeInTheDocument`, ...) with "Property does not exist", since `apps/web/tsconfig.json`'s own `include` never reaches the repo-root `vitest.setup.dom.ts` that registers those matcher types.
- **Fix:** Added an explicit top-level `oxc: { jsx: { runtime: 'automatic' } }` to `vitest.config.ts` (wins over any per-package tsconfig's own `jsx` field); added `apps/web/src/vitest-matchers.d.ts` (a type-only `/// <reference types="@testing-library/jest-dom/vitest" />`, mirroring `packages/ui/src/testing/vitest-matchers.d.ts`'s own already-established fix for the identical class of gap); declared `@testing-library/jest-dom` directly in `apps/web/package.json` (already an approved, already-pinned `packages/ui` dependency at `7.0.1` -- no new package, `pnpm install --offline` resolved it entirely from the existing lockfile/store); added the missing `--project dom` to `apps/web/package.json`'s own package-scoped `test` script.
- **Files modified:** `vitest.config.ts`, `apps/web/src/vitest-matchers.d.ts` (new), `apps/web/package.json`, `pnpm-lock.yaml`
- **Verification:** `pnpm test apps/web/src/components/ServerList.test.tsx` (6/6), `pnpm --filter @noodara/web typecheck`/`lint` both clean, full `pnpm test` (1183/1183) unaffected.
- **Committed in:** `6eb2c5b` (standalone fix commit, before Task 2's GREEN)

**2. [Rule 1 - Bug] The screen would have shown two "Add server" buttons at once when empty**
- **Found during:** Task 2, reviewing the built screen against 05-UI-SPEC.md SS2.3 and Task 3's own upcoming "exactly one Add server action" acceptance criterion, before writing that E2E test
- **Issue:** `(shell)/servers/page.tsx`'s toolbar always rendered its own primary "Add server" action regardless of list state; `ServerList`'s `EmptyState` also renders its own "Add server" button when the list is empty. Rendered together, the empty screen would show two buttons with the identical accessible name -- a real bug against 05-UI-SPEC.md's explicit "single button" empty-state contract and against Task 3's planned E2E assertion.
- **Fix:** The toolbar's primary action is now conditionally omitted while `state.kind === 'ready' && state.servers.length === 0`, leaving `EmptyState`'s own button as the screen's one "Add server" affordance in that state; the toolbar shows its own copy in every other state (loading, error, populated).
- **Files modified:** `apps/web/src/app/(shell)/servers/page.tsx`
- **Verification:** `tests/e2e/servers-list.spec.ts`'s empty-state test asserts `getByRole('button', { name: 'Add server' })` has count 1; `pnpm test:e2e --grep @servers` (6/6).
- **Committed in:** `d7fd65e` (standalone fix commit, before Task 3)

---

**Total deviations:** 2 auto-fixed (1 Rule 3 blocking gap in shared tooling config -- a real, previously-latent transform/typing break every future `apps/web` component test would otherwise have hit; 1 Rule 1 bug -- a redundant-button contract violation caught before it reached the E2E RED cycle)
**Impact on plan:** The oxc/jest-dom fix is the more significant finding: without it, no `.tsx` test file under `apps/web/src` could ever run, silently blocking every remaining screen plan's own component-test tasks (05-14 onward) the moment they tried to add one. Neither fix changed this plan's own scope or architecture.

## Issues Encountered

None beyond the two deviations above, both resolved within this plan's own commits.

## User Setup Required

None -- no external service configuration required. `@testing-library/jest-dom` was already provenance-approved (`packages/ui`'s existing `7.0.1` pin); this plan only added it as a direct `apps/web` devDependency at the identical pin. No new packages were installed.

## Next Phase Readiness

- **SERV-04 is now Complete.** This plan alone delivers its literal text ("El admin ve la lista de servidores con nombre, host, status pill y last seen") end to end -- proven by 6 passing `@servers` E2E behaviours plus the underlying unit/build/lint/typecheck gates.
- **UI-02 stays Pending.** This plan adds only the third of the seven screens UI-02 requires (setup, login, servers list now done; sheet, server detail, activity log, settings remain -- Plans 05-14 through 05-21). Matches the same plan-frontmatter-artifact pattern already flagged in STATE.md for every prior UI-01/UI-02 plan this phase.
- `apps/web/src/lib/server-store.ts`'s `applyServerEvent`/`sortServers` are ready for the server-detail screen (Plan 05-14/05-15) if it ever needs the same live-patch shape for a single server rather than a list.
- `ServerRow.tsx`'s `onEdit`/`onDelete` props and `(shell)/servers/page.tsx`'s `noopAddServer` are the exact three seams Plan 05-17 wires to the real add/edit sheet and destructive delete dialog -- no structural change needed there, just replacing three no-op function bodies and passing the sheet's own open/close state through.
- The `vitest.config.ts` oxc/`apps/web/src/vitest-matchers.d.ts` fix is now in place for every future `apps/web` `.tsx` test file (05-14 onward) -- no later plan needs to rediscover or re-fix this.

---
*Phase: 05-ui-web*
*Completed: 2026-09-19*

## Self-Check: PASSED

Verified on disk: `apps/web/src/lib/server-store.ts`, `server-store.test.ts`,
`apps/web/src/components/ServerRow.tsx`, `ServerList.tsx`, `ServerList.test.tsx`,
`apps/web/src/vitest-matchers.d.ts`, `apps/web/src/app/(shell)/servers/page.tsx`,
`tests/e2e/servers-list.spec.ts`. All seven commits (`b6d54fd`, `5b5a8e7`, `38ef1b2`,
`6eb2c5b`, `ff2056a`, `d7fd65e`, `df8dfd0`) confirmed present in `git log --oneline --all`.
`pnpm test` (1183 tests), `pnpm lint`, `pnpm typecheck`, `pnpm boundaries`,
`NOODARA_API_ORIGIN=http://127.0.0.1:3100 pnpm build`, and
`NOODARA_API_ORIGIN=http://127.0.0.1:3100 pnpm test:e2e` (24/24, `@servers` 6/6) all green,
leaving no `noodara.test=true` container and no orphaned listener on ports 3000/3100.
