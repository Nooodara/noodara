---
phase: 05-ui-web
plan: 14
subsystem: ui
tags: [nextjs, react, tdd, e2e, vitest, playwright]

# Dependency graph
requires:
  - phase: 05-ui-web
    provides: "05-12's authenticated shell (ShellContext/useShellContext, the shared useServerEvents SSE hook, Toolbar.tsx's backLink precedent); 05-13's (shell)/servers/page.tsx fetch/onResync/subscribe pattern and its buildServer(overrides) test-fixture convention; 05-24's StatTile/LabelValue/CopyButton/RelativeTime; 05-22/05-23/05-09's StatusPill/Banner/EmptyState/Skeleton; 05-11's error-copy.ts/api-client.ts; 05-05's discovery read endpoint contract (not consumed by this plan, reserved for 05-18)"
provides:
  - "apps/web/src/lib/detail-state.ts: deriveDetailState/derivePrimaryAction, the pure status+lastErrorCode+hostname decision logic behind the detail screen's five states and its single toolbar action"
  - "apps/web/src/components/ServerFacts.tsx: the four stat tiles + System/Docker/Connection label-value groups, every value 'as of' the last discovery, with a dimmed variant and the UNSUPPORTED_OS/Docker-absent inline warnings"
  - "apps/web/src/components/ServerDetailToolbar.tsx: back link + server name at --text-display + inline StatusPill + the single status-driven primary action, posting to /connect or /discover and swallowing 409 ALREADY_CONNECTING"
  - "apps/web/src/app/(shell)/servers/[id]/page.tsx: the real server detail screen (DETL-01/DETL-02) replacing the bare route -- fetch/resync/SSE-patch-in-place, loading skeleton on first load only, NOT_FOUND handling, and documented seams for 05-18's Discovery section and 05-19's TOFU surfaces"
  - "packages/ui/src/StatTile.tsx: dimmed prop/data-dimmed, extending the DETL-02 attenuated-facts contract LabelValue already had to stat tiles too"
affects: [05-18 (mounts the Discovery section at this page's documented seam), 05-19 (replaces the HOST_KEY_CHANGED placeholder and adds the first-trust notice at this page's other documented seam), 05-20 (the critical-path E2E can now navigate list -> detail and land on a real screen; the one genuinely-CONNECTED-via-sshd case this plan deferred is exactly this later plan's job), 05-17 (the sheet's "Save and connect" navigates here after registering a server)]

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "detail-state.ts branches only on status/lastErrorCode/hostname, never an individual fact field -- the backend's mergeDiscoveryFacts guarantee (a known fact is never overwritten with null) means hostname non-null is sufficient proof the rest of a good discovery's facts are trustworthy too"
    - "UNSUPPORTED_OS is excluded from deriveDetailState's 'lastErrorCode set -> failed' rule -- statusForErrorCode('UNSUPPORTED_OS') lands the server on CONNECTED, so treating it as blocking would show the generic error banner over a server that actually succeeded (a bug in the plan's own literal Task 1 behaviour text, caught against 05-UI-SPEC.md SS5.1's own table before it shipped)"
    - "ServerDetailToolbar.tsx is a standalone toolbar, not built on the shared Toolbar.tsx -- that component's title is a plain string rendered at --text-title (20px), while 05-UI-SPEC.md SS2.5 requires the server's name at the larger --text-display (28px) with a StatusPill inline; duplicating the sticky-bar shell (StreamStatus, back link) here keeps Toolbar.tsx's simpler string-title contract intact for every other screen"
    - "ServerFacts.tsx never renders the no-passwordless-sudo/not-in-docker-group warnings SS5.5 lists -- ServerView/DiscoveryFacts carry no sudo/docker_group field at all; that state only exists inside a discovery run's own DiscoveryCheck records, reachable only through the read endpoint Plan 05-18's Discovery section owns"
    - "No shared Toast primitive exists yet in packages/ui -- ServerDetailToolbar's own connect/discover failure message renders as a small inline, cleared-on-next-click line near the button rather than new shared floating-toast infrastructure this one plan has no mandate to build (05-17/05-19 will need the same thing and can factor it out then)"

key-files:
  created:
    - apps/web/src/lib/detail-state.ts
    - apps/web/src/lib/detail-state.test.ts
    - apps/web/src/components/ServerFacts.tsx
    - apps/web/src/components/ServerFacts.test.tsx
    - apps/web/src/components/ServerDetailToolbar.tsx
    - tests/e2e/server-detail.spec.ts
  modified:
    - apps/web/src/app/(shell)/servers/[id]/page.tsx
    - packages/ui/src/StatTile.tsx
    - packages/ui/src/StatTile.test.tsx

key-decisions:
  - "deriveDetailState treats lastErrorCode === 'UNSUPPORTED_OS' as non-blocking (falls through to the hostname-based discovered/never-discovered branch) rather than the literal 'lastErrorCode set -> failed' rule Task 1's own behaviour text described -- a real conflict between that text and 05-UI-SPEC.md SS5.1/D-11's explicit 'never an error banner' requirement, resolved in the requirement's favor"
  - "DISCONNECTED (not named in 05-UI-SPEC.md SS2.5's per-status action table) gets PENDING's identical un-disabled Connect action in derivePrimaryAction's satisfies Record<ServerStatus, ...> map, since its only domain transition (DISCONNECTED -> CONNECTING) is the same single edge PENDING has"
  - "StatTile gained a dimmed prop/data-dimmed attribute (backward-compatible, default false) -- DETL-02's attenuated-facts treatment applies to the stat tile row too, not only LabelValue rows, and no existing StatTile caller is affected"
  - "The EmptyState 'Not discovered yet.' block never carries its own Connect/action button in never-discovered or failed-no-history -- the toolbar's own single primary action is the one action 05-UI-SPEC.md D-12 names, avoiding a second on-screen button with the same intent"
  - "Task 3's CONNECTED/ERROR-with-history/CONNECTING/UNSUPPORTED_OS E2E cases all use page.route interception rather than the real sshd fixture, matching Plan 05-13's servers-list.spec.ts precedent exactly (applyConnectionResult never sets lastSeenAt/facts without a real successful SSH connect, unreachable in this harness) -- a genuinely-CONNECTED-via-real-sshd case is deferred to Plan 05-20's critical-path E2E"

requirements-completed: [DETL-01, DETL-02]

# Metrics
duration: ~8min
completed: 2026-09-19
---

# Phase 5 Plan 14: Server Detail Screen (Facts and State) Summary

**The server detail screen at /servers/:id -- four stat tiles and three label/value groups all "as of" the last discovery, a pure detail-state/primary-action derivation module, and the two DETL-02 failure/empty states rendered distinctly, verified by 21 unit tests and 7 new E2E behaviours.**

## Performance

- **Duration:** ~8 min (commit span, `ca101fe`..`a419006`)
- **Completed:** 2026-09-19
- **Tasks:** 3 (Task 1 RED/GREEN; a standalone StatTile deviation RED/GREEN before Task 2; Task 2 RED/GREEN; Task 3 single test commit, genuine RED not separately recorded since the file/screen did not exist to run against)
- **Files modified:** 9 (7 new, 2 modified)

## Accomplishments

- `apps/web/src/lib/detail-state.ts`: `deriveDetailState` (five states: `never-discovered`/`failed-no-history`/`failed-with-history`/`discovered`/`host-key-changed`) and `derivePrimaryAction` (`satisfies Record<ServerStatus, PrimaryAction | null>`, so a new domain status is a compile error), branching only on `status`/`lastErrorCode`/`hostname` per the backend's `mergeDiscoveryFacts` guarantee. 13 Vitest cases, all six statuses covered exhaustively for `derivePrimaryAction`.
- `apps/web/src/components/ServerFacts.tsx`: the four `StatTile`s (CPU cores, RAM via `formatMb`, disk via `formatDiskUsage` with its 1px meter, uptime via `formatUptime`) plus System/Docker/Connection `LabelValue` groups, every tile and row carrying an "as of {relative time}" caption, the fingerprint row carrying its own "captured {relative time}" caption instead, a `dimmed` prop forwarding to every child, and the `UNSUPPORTED_OS`/Docker-absent inline amber warnings. 8 component-test behaviours, all green.
- `apps/web/src/components/ServerDetailToolbar.tsx`: the back link, the server name at `--text-display` with an inline `StatusPill`, and the single `data-testid="server-detail-primary-action"` button from `derivePrimaryAction`, posting to `/connect` or `/discover` and swallowing a `409 ALREADY_CONNECTING` response as a state confirmation (no toast).
- `apps/web/src/app/(shell)/servers/[id]/page.tsx`: fetches `GET /api/servers/:id` (id always `encodeURIComponent`-wrapped), registers the shell's `onResync`, patches in place from `server.updated`/`server.deleted` SSE events without re-skeletonizing after the first load, and renders `NOT_FOUND` as "This server no longer exists." + a working link back. Documented, un-stubbed seams for Plan 05-18's Discovery section and Plan 05-19's first-trust notice/real `HOST_KEY_CHANGED` banner — the latter renders only a neutral placeholder naming that plan, never the generic error banner.
- `packages/ui/src/StatTile.tsx`: gained a `dimmed`/`data-dimmed` contract matching `LabelValue`'s own already-established one, since DETL-02's attenuated treatment applies to the stat tile row too (Rule 2 deviation, its own RED/GREEN cycle).
- `tests/e2e/server-detail.spec.ts`: 7 `@detail` E2E behaviours — PENDING/never-discovered (real API-seeded), `AUTH_FAILED` no-history, `CONNECT_TIMEOUT` with-history (dimmed facts, proven by a real computed-color comparison against a plain `CONNECTED` fixture, not a literal value), a fully `CONNECTED` server's four formatted tiles + fingerprint copy button, `CONNECTING`'s disabled primary action, a stubbed 404, and the `UNSUPPORTED_OS` warning staying `CONNECTED` with no error banner. All 7 passed on the first real run.
- `pnpm test` (1205 tests), `pnpm lint`, `pnpm typecheck`, `pnpm boundaries`, `pnpm build`, and `pnpm test:e2e` (31/31, all specs, `@detail` 7/7) are all green. No stray `noodara.test=true` container and no orphaned listener on ports 3000/3100 after any run.

## Task Commits

1. **Task 1 RED: failing detail-state tests** - `ca101fe` (test)
2. **Task 1 GREEN: detail-state.ts derivation module** - `53d47d2` (feat)
3. **[deviation] RED: failing StatTile dimmed test** - `c2bbe13` (test)
4. **[deviation] GREEN: StatTile gains dimmed/data-dimmed** - `f91c19c` (feat)
5. **Task 2 RED: failing ServerFacts tests** - `24fa7e0` (test)
6. **Task 2 GREEN: ServerFacts, ServerDetailToolbar, the detail page** - `f05fc3e` (feat)
7. **Task 3: E2E coverage for the server detail screen** - `a419006` (test)

## Files Created/Modified

- `apps/web/src/lib/detail-state.ts` / `detail-state.test.ts` - `deriveDetailState`, `derivePrimaryAction`
- `apps/web/src/components/ServerFacts.tsx` / `ServerFacts.test.tsx` - the four tiles + three groups
- `apps/web/src/components/ServerDetailToolbar.tsx` - the detail screen's own toolbar
- `apps/web/src/app/(shell)/servers/[id]/page.tsx` - the real screen
- `packages/ui/src/StatTile.tsx` / `StatTile.test.tsx` - `dimmed`/`data-dimmed`
- `tests/e2e/server-detail.spec.ts` - 7 `@detail` behaviours

## Decisions Made

See `key-decisions` in frontmatter — summarized: `UNSUPPORTED_OS` is deliberately excluded from the generic-failure branch of `deriveDetailState` (a real bug in the plan's own literal Task 1 text, caught against 05-UI-SPEC.md SS5.1/D-11 before it shipped); `DISCONNECTED` (absent from the SS2.5 per-status table) gets `PENDING`'s identical Connect action since both share the same single domain transition; `StatTile` gained a backward-compatible `dimmed` prop; the `EmptyState` block never duplicates the toolbar's own single action button; Task 3's harder-to-produce states all use `page.route` interception (matching Plan 05-13's own precedent), deferring one genuinely-`CONNECTED`-via-sshd case to Plan 05-20.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] `deriveDetailState`'s literal Task 1 behaviour text would have shown the generic error banner over a healthy, `CONNECTED` server with an `UNSUPPORTED_OS` warning**
- **Found during:** Task 1, implementing `deriveDetailState` against 05-UI-SPEC.md SS5.1's own table (not just the plan's own `<behavior>` block)
- **Issue:** `packages/domain/src/server/connection-result.ts`'s `statusForErrorCode('UNSUPPORTED_OS')` lands the server on `CONNECTED` (the connection and discovery both genuinely succeeded), but still records `'UNSUPPORTED_OS'` in `lastErrorCode` purely as a warning. Task 1's own literal `<behavior>` text ("returns failed-with-history when lastErrorCode is set and hostname is non-null") does not exclude this code, and the plan's own `must_haves.truths` explicitly requires "UNSUPPORTED_OS renders as an amber inline warning under the OS line with the server still shown as CONNECTED — never an error banner" — a direct contradiction within the plan itself.
- **Fix:** `deriveDetailState` special-cases `lastErrorCode === 'UNSUPPORTED_OS'` as non-blocking, falling through to the ordinary hostname-based `discovered`/`never-discovered` branch instead of the generic `failed-*` branches. A dedicated unit test (`detail-state.test.ts`) and an E2E behaviour (`server-detail.spec.ts`) both assert the server stays on the `discovered` layout with no error banner.
- **Files modified:** `apps/web/src/lib/detail-state.ts`, `apps/web/src/lib/detail-state.test.ts`
- **Verification:** `pnpm test apps/web/src/lib/detail-state.test.ts` (13/13); `tests/e2e/server-detail.spec.ts`'s UNSUPPORTED_OS case (1/1)
- **Committed in:** `53d47d2` (Task 1 GREEN commit)

**2. [Rule 2 - Missing critical functionality] `StatTile` had no way to render DETL-02's dimmed treatment**
- **Found during:** Task 2, before writing `ServerFacts.test.tsx`'s dimmed-flip behaviour
- **Issue:** The plan's own must_haves and Task 2 acceptance criteria require "every tile and every group value carries `data-dimmed`" when the screen shows facts from a prior good discovery under a failure banner — but `packages/ui/src/StatTile.tsx` had no `dimmed` prop at all (only `LabelValue` did).
- **Fix:** Added a backward-compatible `dimmed?: boolean` prop (default `false`) rendering `data-dimmed` and a dimmed value color, mirroring `LabelValue`'s own already-established contract. No existing `StatTile` caller is affected.
- **Files modified:** `packages/ui/src/StatTile.tsx`, `packages/ui/src/StatTile.test.tsx`
- **Verification:** `pnpm test packages/ui/src/StatTile.test.tsx` (7/7); `pnpm --filter @noodara/ui typecheck`/`lint` clean
- **Committed in:** `c2bbe13` (test), `f91c19c` (feat) — a standalone RED/GREEN pair before Task 2's own

---

**Total deviations:** 2 auto-fixed (1 Rule 1 bug — a genuine internal contradiction in the plan's own Task 1 text, resolved in the requirement's favor; 1 Rule 2 missing-functionality gap in a shared `packages/ui` component this plan's own acceptance criteria required)
**Impact on plan:** Both fixes were necessary for DETL-01/DETL-02 to actually hold as specified; neither changed this plan's own scope or architecture. The `StatTile` fix is reusable by any future dimmed-tile need.

## Known Stubs / Deferred Surfaces

- **`ServerDetailToolbar`'s own error message** is a small inline, cleared-on-next-click line rather than a floating toast — no shared `Toast` primitive exists yet in `packages/ui` (Plans 05-17/05-19 will need the same thing). Not a stub in the sense of missing data; it is a real, functioning failure notice, just not the eventual shared component shape.
- **The `no-passwordless-sudo`/`not-in-docker-group` warnings** from 05-UI-SPEC.md SS5.5 are not rendered by `ServerFacts` — `ServerView`/`DiscoveryFacts` carry no `sudo`/`docker_group` field; that state only exists inside a discovery run's own `DiscoveryCheck` records, reachable through the read endpoint Plan 05-18's Discovery section owns. Rendering them here would mean fabricating data this component was never given.
- **The `host-key-changed` detail state** renders only a neutral placeholder block (named for Plan 05-19, which replaces it with the real SS5.3 banner and the trust-new-fingerprint dialog) — by design, per this plan's own scope boundary.
- **The Discovery section** (SS2.5 layout position 6) and **the first-trust notice** (layout position 1) are not present at all, not even stubbed — documented comment seams only, per D-05's "never invent progress" discipline and this plan's explicit scope boundary (Plans 05-18/05-19).

None of these prevent DETL-01/DETL-02 from being genuinely satisfied by this plan alone — they are the seams for the plans that already own that later work.

## Issues Encountered

None beyond the two deviations above, both resolved within this plan's own commits. One test-authoring mistake was caught and fixed before landing (not a deviation): `ServerFacts.test.tsx`'s dimmed-flip test initially used RTL's `rerender`, which throws "Tooltip must be used within TooltipProvider" once the fingerprint row's `CopyButton` pulls in a `Tooltip` — `rerender` replaces the tree directly, dropping `renderUi`'s outer `TooltipProvider` wrapper (unlike `render`'s `options.wrapper`). Fixed by using two independent `renderUi` calls instead, matching no prior precedent in this codebase (the first component test needing this).

## User Setup Required

None — no external service configuration required, no new packages installed (`ADR-0000`'s provenance gate was never invoked; this plan needed nothing new).

## Next Phase Readiness

- **DETL-01 is now Complete.** This plan alone delivers its literal text (hostname, status, OS, CPU, RAM, disk, uptime, Docker, last seen, host fingerprint, conforming to the design system) end to end — proven by 8 passing component-test behaviours plus 4 E2E behaviours exercising the same fields in a real browser.
- **DETL-02 is now Complete.** Both named states ("aún no descubierto" and "discovery falló") are distinct, each with exactly one action, with prior facts preserved and dimmed when a history exists — proven by 5 `deriveDetailState` unit-test groups plus 3 dedicated E2E behaviours (`AUTH_FAILED` no-history, `CONNECT_TIMEOUT` with-history, the never-discovered empty state).
- **UI-02 stays Pending.** This plan adds the fourth of the seven screens UI-02 requires (setup, login, servers list, server detail now done; add/edit sheet, activity log, settings remain — Plans 05-17, 05-16/05-21, matching the same plan-frontmatter-artifact pattern already flagged in STATE.md for every prior UI-01/UI-02 plan this phase).
- Plan 05-18 (Discovery section) has a documented, empty seam in `(shell)/servers/[id]/page.tsx` immediately after the label/value groups, and `ServerFacts`'s own `warnings` prop is ready to receive richer data once that plan wires the discovery read endpoint.
- Plan 05-19 (TOFU surfaces) has a documented seam at the top of the content column for the first-trust notice, and the `host-key-changed` detail state's placeholder block is the exact spot its real SS5.3 banner + trust dialog replaces — `derivePrimaryAction` already returns `null` for that status/code pair, so the toolbar structurally has no competing action once that plan lands.
- `ServerDetailToolbar`'s inline error line is a known, intentionally minimal stand-in — Plan 05-17 or 05-19 (whichever needs a toast first) should factor out a real shared `Toast` primitive rather than duplicating this pattern a third time.

---
*Phase: 05-ui-web*
*Completed: 2026-09-19*

## Self-Check: PASSED

Verified on disk: `apps/web/src/lib/detail-state.ts`, `detail-state.test.ts`,
`apps/web/src/components/ServerFacts.tsx`, `ServerFacts.test.tsx`, `ServerDetailToolbar.tsx`,
`apps/web/src/app/(shell)/servers/[id]/page.tsx`, `packages/ui/src/StatTile.tsx`,
`StatTile.test.tsx`, `tests/e2e/server-detail.spec.ts`. All seven task commits (`ca101fe`,
`53d47d2`, `c2bbe13`, `f91c19c`, `24fa7e0`, `f05fc3e`, `a419006`) confirmed present in
`git log --oneline --all`. `pnpm test` (1205 tests), `pnpm lint`, `pnpm typecheck`,
`pnpm boundaries`, `NOODARA_API_ORIGIN=http://127.0.0.1:3100 pnpm build`, and
`NOODARA_API_ORIGIN=http://127.0.0.1:3100 pnpm test:e2e` (31/31, `@detail` 7/7) all green,
leaving no `noodara.test=true` container and no orphaned listener on ports 3000/3100.
