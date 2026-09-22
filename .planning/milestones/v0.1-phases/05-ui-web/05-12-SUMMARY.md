---
phase: 05-ui-web
plan: 12
subsystem: ui
tags: [nextjs, react, sse, eventsource, tdd, e2e, security]

# Dependency graph
requires:
  - phase: 05-ui-web
    provides: "05-25's complete packages/ui component inventory (Tooltip, ThemeToggle, Button, TooltipProvider); 05-10's Playwright harness and stack fixture; 05-11's error-copy.ts, auth screens and the /servers redirect target; 05-04's server.discovery_progress SSE event and its DiscoveryCheck payload shape; 05-07's api-client.ts, same-origin proxy and root layout"
provides:
  - "apps/web/src/lib/server-events.ts: pure SSE frame parsing/reducer -- isKnownEventType/parseServerEventFrame/KNOWN_EVENT_TYPES, the client-side second allowlist over the three ServerEvent variants"
  - "apps/web/src/lib/use-server-events.ts: the one EventSource('/api/events') hook the shell instantiates exactly once -- per-type addEventListener, resync-on-open, bounded backoff for repeated pre-open 503 failures, close() for sign-out"
  - "apps/web/src/lib/shell-context.tsx: the ShellContext every shell component and future screen reads the shared stream/mobile-nav state from"
  - "apps/web/src/lib/require-session.ts: the shell's own client-side session guard"
  - "apps/web/src/app/(shell)/layout.tsx, Sidebar.tsx, Toolbar.tsx, SignOutButton.tsx, StreamStatus.tsx: the authenticated shell itself -- three fixed nav items, responsive icon rail/bottom sheet, reusable per-screen toolbar, sign-out that closes the stream client-side first"
  - "apps/web/src/app/api/events/route.ts: a dedicated streaming Route Handler for GET /api/events, fixing a real bug this plan's own security review found in next.config.ts's generic rewrites() proxy (it buffers a long-lived SSE response instead of streaming it)"
  - "apps/web/src/app/(shell)/servers/page.tsx: a minimal placeholder page so /servers is reachable and the shell renders for real navigation -- Plan 05-13 replaces it with the actual servers list screen"
affects: [05-13..05-21 (every later screen renders inside this shell, consumes useShellContext for the shared stream, and imports Toolbar), 05-20 (the full critical-path E2E now has a real, working shell and a real, verified SSE pipeline to build on)]

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "server-events.ts derives its known-check-id validation from DISCOVERY_CHECK_IDS imported from @noodara/domain/discovery, never a re-typed literal list; ServerEvent's three variants are hand-copied from apps/control-plane/src/events/server-event-publisher.ts, matching api-client.ts's own established hand-copy-never-import-across-the-apps-boundary convention"
    - "use-server-events.ts never implements a custom reconnect loop for an already-open-then-dropped connection (the browser's own EventSource honours the server's retry: 5000 field) -- the one exception is a bounded, explicit exponential backoff for the pre-open 503 SSE_LIMIT_REACHED case specifically, since a response that never reaches the retry: field gets no backoff from the browser's own default reconnection timing"
    - "ShellContext is a standalone module (apps/web/src/lib/shell-context.tsx), not defined inline in (shell)/layout.tsx -- Sidebar.tsx -> SignOutButton.tsx -> (context) and Toolbar.tsx -> (context) would otherwise import back into the route-group layout file itself, an import cycle through a file Next.js treats specially"
    - "Toolbar.tsx is a reusable per-screen component, not auto-rendered by (shell)/layout.tsx with fixed props -- each screen (starting with Plan 05-13) imports and renders its own <Toolbar> with its own title/actions, exactly like AuthCard is each unauthenticated screen's own chrome rather than the root layout's"
    - "GET /api/events is served by a literal Next.js Route Handler (app/api/events/route.ts), not the generic next.config.ts rewrites() proxy -- Next resolves filesystem routes (including Route Handlers) ahead of a plain rewrites() array for the same path, so this one handler intercepts /api/events while every other /api/* path keeps using the unchanged rewrite"

key-files:
  created:
    - apps/web/src/lib/server-events.ts
    - apps/web/src/lib/server-events.test.ts
    - apps/web/src/lib/use-server-events.ts
    - apps/web/src/lib/require-session.ts
    - apps/web/src/lib/shell-context.tsx
    - apps/web/src/app/(shell)/layout.tsx
    - apps/web/src/app/(shell)/servers/page.tsx
    - apps/web/src/app/api/events/route.ts
    - apps/web/src/components/Sidebar.tsx
    - apps/web/src/components/Toolbar.tsx
    - apps/web/src/components/SignOutButton.tsx
    - apps/web/src/components/StreamStatus.tsx
    - tests/e2e/shell.spec.ts
  modified:
    - apps/web/package.json
    - pnpm-lock.yaml

key-decisions:
  - "ShellContext split into its own apps/web/src/lib/shell-context.tsx module rather than defined inline in (shell)/layout.tsx -- avoids an import cycle (Sidebar -> SignOutButton -> layout -> Sidebar) that a plain sibling-module import sidesteps entirely"
  - "The shell's own client-side session guard (require-session.ts) calls GET /api/config (already session-protected, cheap, read-only) as its one lightweight authenticated fetch, bounded by an explicit 5s timeout that fails closed (treated exactly like a real 401) rather than ever leaving the shell looking reachable on a hung request -- reconciled with, not a replacement for, apps/web/src/proxy.ts's own earlier server-side redirect (both check the same underlying session state, both redirect to /login, neither is the real authorization boundary)"
  - "lucide-react promoted from packages/ui's dependencies to also being a direct apps/web dependency at the identical already-provenance-approved 1.47.0 pin -- Sidebar/Toolbar are the first apps/web files to import raw lucide icons (Server/History/Settings/Menu) directly rather than through a packages/ui wrapper; no new package was installed, pnpm resolved the addition entirely from the existing lockfile"
  - "A minimal apps/web/src/app/(shell)/servers/page.tsx placeholder was added even though it is not in this plan's own files_modified list -- without at least one real page inside the (shell) route group, /servers has no matching route, the shell layout never renders for a real navigation, and this plan's own must_haves/E2E coverage (six @shell behaviours, all requiring a real rendered shell) would be structurally unsatisfiable. Plan 05-13 replaces this file with the real servers list screen."
  - "GET /api/events moved off next.config.ts's generic rewrites() proxy onto its own Route Handler (apps/web/src/app/api/events/route.ts) -- a real bug found during this plan's own security review (see Deviations below), not a design preference"
  - "The new permanent SSE-through-proxy regression test is tagged @sse-live, deliberately never containing the substring \"@shell\", so a literal `--grep @shell` still selects exactly the plan's six documented behaviours (the acceptance criteria's own pinned count)"

requirements-completed: [UI-01]

# Metrics
duration: ~31min
completed: 2026-09-19
---

# Phase 5 Plan 12: Authenticated Shell and Live-Events Pipeline Summary

**The authenticated shell (sidebar, toolbar, sign-out, reconnecting indicator) and the single shared SSE pipeline every future screen will consume -- plus a real, previously-undetected bug found and fixed: Next.js's generic rewrites() proxy silently buffers the SSE stream, so `/api/events` now has its own dedicated streaming Route Handler.**

## Performance

- **Duration:** ~31 min (commit span; excludes file-reading/context-gathering time, the SSE-rewrite investigation, and the temporary move-files-aside RED verification, none of which produced a commit of their own)
- **Completed:** 2026-09-19
- **Tasks:** 3 (Task 1 RED/GREEN; Task 2 standalone `feat`; Task 3 RED/GREEN, GREEN folded into a `fix` commit once the SSE-rewrite bug was found and resolved)
- **Files modified:** 15 (13 new, 2 modified)

## Accomplishments

- `apps/web/src/lib/server-events.ts`: `isKnownEventType`/`parseServerEventFrame`/`KNOWN_EVENT_TYPES` mirror the broadcaster's own allowlist and reject anything a foreign or malformed publisher could try to inject (T-5-50) -- near-miss types, a payload whose `type` disagrees with the listener it arrived under, malformed JSON, a `server.discovery_progress` payload with a missing or unknown `check`, and a `server.deleted` payload with no `id` are all rejected rather than trusted. 7 Vitest cases, all green.
- `apps/web/src/lib/use-server-events.ts`: one `EventSource('/api/events')` per shell mount, per-type `addEventListener` (no generic `onmessage`), a resync-registration API fired on every `open`, a `connected` boolean, and `close()` for sign-out. No custom reconnect loop for an already-open connection that drops (the browser's own reconnection honours the server's `retry: 5000`); a bounded, explicit exponential backoff (capped at 60s) only for the pre-open `SSE_LIMIT_REACHED` case, since that response never reaches the `retry:` field.
- The shell itself: `(shell)/layout.tsx` composes a skip-to-content link (first tab stop), `Sidebar` (exactly three items -- Servers/Activity/Settings, no v0.2+ placeholder), and a content region, instantiating `useServerEvents` exactly once and sharing it through `ShellContext`. `Toolbar.tsx` is a reusable per-screen 52px sticky bar with a `StreamStatus` slot and a mobile hamburger menu button. `SignOutButton.tsx` closes the shared stream before posting `/api/auth/sign-out` (T-5-51). `require-session.ts` is the shell's own fail-closed, explicitly-timed client-side session guard, reconciled with (not duplicating) `proxy.ts`'s earlier server-side redirect.
- **A real, previously-undetected bug found and fixed**: this plan's own security instructions required verifying that a real SSE event actually reaches the browser through the Next.js same-origin proxy, not just that the connection opens. It did not -- `next.config.ts`'s generic `rewrites()` proxy buffers a long-lived, chunked SSE response and never forwards any of it to the browser while the connection stays open (confirmed with a standalone diagnostic and then with a real Playwright test: a `retry: 5000` field written synchronously by the server never arrived after 8 full seconds through the rewrite, while the identical request against the control plane directly, or through a purpose-built `Response(ReadableStream)` Route Handler, streamed every chunk within milliseconds). `apps/web/src/app/api/events/route.ts` fixes this with a dedicated streaming Route Handler for this one path, which Next resolves ahead of the generic rewrite. Every other `/api/*` route is untouched.
- `tests/e2e/shell.spec.ts`: the plan's six documented `@shell` behaviours (focus order starting with the skip link, visible focus outline, keyboard-driven navigation, theme persistence across reload, the three responsive breakpoints, sign-out-then-redirect) plus one permanent regression test (`@sse-live`, deliberately not matching `--grep @shell`'s six-test count) proving a real `server.updated` frame from a real `POST /api/servers` call reaches the browser while the stream stays open.
- Genuine RED observed for both tdd-flagged tasks: Task 1's `server-events.test.ts` failed on `Cannot find module` before `server-events.ts` existed. Task 3's `shell.spec.ts` was run against a version of the tree with every Task 2 shell file temporarily moved aside (`Sidebar.tsx`, `Toolbar.tsx`, `SignOutButton.tsx`, `StreamStatus.tsx`, `shell-context.tsx`, `require-session.ts`, the whole `(shell)` route group) -- all 6 tests failed for the right reason (no sidebar, no theme toggle, no sign-out control, `/servers` rendering Next's own 404), then all 6 passed once the files were restored.
- `pnpm test` (1171 tests), `pnpm lint`, `pnpm typecheck`, `pnpm boundaries`, `pnpm build`, `node scripts/check-package-provenance.mjs` (29/29 OK, zero new packages) and `pnpm test:e2e` (18/18, all specs) are all green. No stray `noodara.test=true` container and no orphaned listener on ports 3000/3100 after any run.

## Task Commits

1. **Task 1 RED: failing server-events parser tests** - `01e3f4a` (test)
2. **Task 1 GREEN: server-events.ts and use-server-events.ts** - `b47c4df` (feat)
3. **Task 2: the shell -- layout, sidebar, toolbar, sign out, stream indicator, session guard** - `6264ae8` (feat)
4. **Task 3 RED: failing E2E coverage for the shell** - `cbfac27` (test)
5. **Task 3 GREEN + the SSE-rewrite bug fix** - `0abb524` (fix)

## Files Created/Modified

- `apps/web/src/lib/server-events.ts` / `server-events.test.ts` - `isKnownEventType`, `parseServerEventFrame`, `KNOWN_EVENT_TYPES`, `ServerEvent` union
- `apps/web/src/lib/use-server-events.ts` - `useServerEvents()` hook, the one `EventSource`
- `apps/web/src/lib/shell-context.tsx` - `ShellContext`, `useShellContext()`
- `apps/web/src/lib/require-session.ts` - `requireSession()`, the shell's own session guard
- `apps/web/src/app/(shell)/layout.tsx` - the authenticated route-group layout
- `apps/web/src/app/(shell)/servers/page.tsx` - minimal placeholder, replaced by Plan 05-13
- `apps/web/src/app/api/events/route.ts` - the streaming Route Handler fixing the rewrite-buffering bug
- `apps/web/src/components/Sidebar.tsx` / `Toolbar.tsx` / `SignOutButton.tsx` / `StreamStatus.tsx` - the shell's own components
- `tests/e2e/shell.spec.ts` - six `@shell` behaviours plus one permanent `@sse-live` regression test
- `apps/web/package.json` / `pnpm-lock.yaml` - `lucide-react` promoted to a direct dependency (already provenance-approved, no new install)

## Decisions Made

See `key-decisions` in frontmatter -- summarized: `ShellContext` lives in its own module to avoid an import cycle; `require-session.ts` uses `GET /api/config` as its lightweight session check, bounded by an explicit timeout that fails closed; `lucide-react` promoted to a direct `apps/web` dependency at its existing approved pin; a minimal `/servers` placeholder page was added (out of this plan's literal file list, but structurally required for the shell to be reachable at all); `GET /api/events` moved to its own Route Handler after a real buffering bug was found in `next.config.ts`'s generic proxy; the new SSE regression test is tagged `@sse-live` specifically so it never matches `--grep @shell`.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] `next.config.ts`'s generic `rewrites()` proxy buffers the SSE stream instead of streaming it**
- **Found during:** Task 3's own security-review verification step ("verify a real event arrives in the browser through the Next rewrite, not just that the connection opens")
- **Issue:** A standalone diagnostic (a fake origin writing `retry: 5000\n\n` immediately, then a named SSE frame 800ms later, kept open) proved the fake origin itself streamed correctly, but the identical request through `next start`'s rewrite either terminated the connection immediately after headers or, in a real Playwright browser `fetch`, never delivered a single byte within 8 seconds. This is a genuine limitation of Next.js's built-in `rewrites()` proxy for a long-lived, never-ending chunked response, not a bug in `apps/control-plane/src/routes/events.ts`.
- **Fix:** Added `apps/web/src/app/api/events/route.ts`, a Next.js Route Handler that manually forwards the request to the control plane and returns the upstream response's `ReadableStream` body directly (`new Response(upstream.body, {...})`), which Next.js Route Handlers support natively for streaming. Route Handlers are resolved by Next's filesystem router ahead of a plain `rewrites()` array for the same path, so this file intercepts `/api/events` specifically while every other `/api/*` path keeps using the unchanged `next.config.ts` rewrite.
- **Files modified:** `apps/web/src/app/api/events/route.ts` (new)
- **Verification:** A real Playwright test (kept permanently as `@sse-live`) opens `/api/events` through the real Next app, triggers a real `POST /api/servers` (which publishes a real `server.updated` SSE event server-side), and confirms the frame arrives in the browser (observed at +433ms in the verification run) while the connection stays open. Before the fix, the identical test timed out after 8s with zero bytes received.
- **Committed in:** `0abb524` (fix commit)

**2. [Rule 2/3 - Missing critical functionality / blocking] No real page existed inside the `(shell)` route group**
- **Found during:** Task 2, after building the shell components, before writing Task 3's E2E coverage
- **Issue:** This plan's own `files_modified` list names `(shell)/layout.tsx` but no page file. Without at least one `page.tsx` under `(shell)`, `/servers` (where login already redirects, per Plan 05-11) has no matching route -- Next.js falls back to the root `not-found` page, which is **not** wrapped by the `(shell)` layout at all. The shell (sidebar, toolbar, keyboard path, responsive breakpoints) would never render for a real navigation, making this plan's own must_haves and Task 3's entire E2E suite structurally unsatisfiable.
- **Fix:** Added a minimal `apps/web/src/app/(shell)/servers/page.tsx` rendering just `<Toolbar title="Servers" />` and an empty content area, explicitly commented as a temporary placeholder for Plan 05-13 to replace with the real servers list screen (05-UI-SPEC.md SS2.3).
- **Files modified:** `apps/web/src/app/(shell)/servers/page.tsx` (new)
- **Verification:** `pnpm build` compiles `/servers` as a real route; all six `@shell` E2E tests navigate through it successfully.
- **Committed in:** `6264ae8` (Task 2 commit)

---

**Total deviations:** 2 auto-fixed (1 Rule 1 bug -- a genuine, previously-undiscovered production bug in the SSE delivery path; 1 Rule 2/3 missing-functionality gap -- no real page existed for the shell to render against)
**Impact on plan:** The SSE-rewrite fix is the most significant finding of this plan: without it, `use-server-events.ts`'s entire real-time pipeline would have silently never delivered a single live event in production, despite every unit test, typecheck, lint, and even the six `@shell` E2E tests passing (none of them, before this fix, actually proved a real event's delivery -- they only proved UI open/close/keyboard behaviour). The placeholder `/servers` page is a necessary, explicitly-flagged stub that Plan 05-13 is expected to replace.

## Known Stubs

- `apps/web/src/app/(shell)/servers/page.tsx` renders `<Toolbar title="Servers" />` and an empty content area -- no server list, no data fetching, no empty/loading/error states. This is intentional scaffolding so the shell has a real page to render against; Plan 05-13 (Servers list screen, SERV-04) replaces this file entirely. Not a UI-02 regression since UI-02 was already Pending before this plan and stays Pending after it.

## Issues Encountered

None beyond the two deviations above, both resolved within this plan's own commits.

## User Setup Required

None -- no external service configuration required. `lucide-react` was already provenance-approved in `docs/adr/0000-package-legitimacy-approvals.md`'s Phase 5 additions table (installed by Plan 05-06); this plan only added it as a direct `apps/web` dependency at the identical pin. `node scripts/check-package-provenance.mjs` reports 29/29 OK, zero new packages.

## Next Phase Readiness

- **UI-01 is now Complete.** This plan's own shell (sidebar, toolbar, content region, dark/light mode via the existing token system, full keyboard navigation) satisfies REQUIREMENTS.md's literal UI-01 text end to end, proven by six passing `@shell` E2E behaviours plus the underlying build/lint/typecheck gates. (Inspector is explicitly optional per D-10 and intentionally unused in v0.1.)
- **UI-02 stays Pending.** This plan adds only a minimal `/servers` placeholder (no real list, no empty/loading/error states) -- the seven real screens UI-02 requires are Plans 05-11 (setup/login, already landed) through 05-13..05-21 (servers list, add/edit sheet, server detail, activity log, settings). Re-verify UI-02 once those land.
- `apps/web/src/lib/shell-context.tsx`'s `useShellContext()` is the one place every future screen reads `connected`/`subscribe`/`registerResync`/`close` from -- no screen should call `useServerEvents()` a second time.
- `apps/web/src/components/Toolbar.tsx` is ready for Plan 05-13 onward to import directly with real `primaryAction`/`secondaryActions`/`backLink` props; it already renders `StreamStatus` and the mobile menu button correctly.
- `apps/web/src/app/api/events/route.ts` is now the one path every future SSE consumer (the same `useServerEvents()` hook, unchanged) relies on for real event delivery -- no later plan needs to touch this file unless the control plane's own event contract changes.
- Every registered `registerResync` callback fires on the shell's `EventSource`'s `open` event (including reconnects) -- Plan 05-13's servers list is the first real consumer that should register one for its own `GET /api/servers` refetch.

---
*Phase: 05-ui-web*
*Completed: 2026-09-19*

## Self-Check: PASSED

Verified on disk: `apps/web/src/lib/server-events.ts`, `server-events.test.ts`, `use-server-events.ts`,
`shell-context.tsx`, `require-session.ts`, `apps/web/src/app/(shell)/layout.tsx`,
`apps/web/src/app/(shell)/servers/page.tsx`, `apps/web/src/app/api/events/route.ts`,
`apps/web/src/components/Sidebar.tsx`, `Toolbar.tsx`, `SignOutButton.tsx`, `StreamStatus.tsx`,
`tests/e2e/shell.spec.ts`. All five commits (`01e3f4a`, `b47c4df`, `6264ae8`, `cbfac27`, `0abb524`)
confirmed present in `git log --oneline`. `pnpm test` (1171 tests), `pnpm lint`, `pnpm typecheck`,
`pnpm boundaries`, `NOODARA_API_ORIGIN=http://127.0.0.1:3100 pnpm build`,
`node scripts/check-package-provenance.mjs` (29/29 OK) and
`NOODARA_API_ORIGIN=http://127.0.0.1:3100 pnpm test:e2e` (18/18) all green, leaving no
`noodara.test=true` container and no orphaned listener on ports 3000/3100.
