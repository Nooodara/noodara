# Nightly e2e-repeat flakes under load: root causes (14-26)

## theme-first-paint.spec.ts:181, `serversResult.mutations` expected 0 (nightly 37807942623, it. 6)

Root cause: a test race. The product's first paint is correct.
- After the UI login, `/servers` mounts the shell's session store (`apps/web/src/lib/session-user.ts`, `ensureLoaded`). It sends `GET /api/account/preferences`. That response re-issues the `noodara-prefs` mirror cookie, and the store then calls `applyPreferences(server)`, which writes the cookie again.
- The test PATCHed the account to `dark.on.compact` right after the URL changed, while that GET could still be in flight. The GET had read the old `auto` value. When it landed after the PATCH, it rewrote the mirror cookie to `auto`.
- Two outcomes, depending on when the stale write landed:
  - Before the reload request: SSR has no `data-theme`, the bootstrap script sets `light`, then the reloaded store applies `dark`. Result: 2 mutations and a light-to-dark flash.
  - During the reload: SSR is dark, but the new page reads the stale mirror, sees it differs from the server, and re-applies `dark`. Result: 1 mutation (same value) and no visible flash.

Fix: before the PATCH, the test waits for `shell-account-menu-trigger` to have text. The store emits after both cookie writes, and the emit fills the trigger. This is the same signal `a11y-fallbacks.spec.ts` uses (13-07). The assertions are unchanged.

Proof:
- Deterministic RED: a temporary `page.route` probe held the store's GET until after the PATCH. 2 of 3 runs failed with `mutations: 2` and frames going from `rgb(245, 245, 247)` to `rgb(22, 22, 24)`. The third run passed because the store's GET was sent after the PATCH, so the probe released it at once.
- Load RED: 28 busy-loop containers on 14 vCPUs (load average 27) plus CDP `Emulation.setCPUThrottlingRate` 10. 1 of 15 runs failed with `mutations: 1` and all frames dark. Load alone (20 runs) and throttle 4 (15 runs) passed.
- The fix is tied to the GET: with the GET held, the new wait times out on an empty trigger.
- GREEN: same load plus throttle 10: 40/40 passed, all with `mutations: 0`.

## projects-dod.spec.ts, H1 service keyboard walk: every `nav-tree-*` item "unreachable" (full run 1, dark pass)

Root cause: a test race. The sidebar loads its Projects tree on its own (`Sidebar.tsx`, `useProjectNavTree`), after the page content the test waits for.
- Until `GET /api/projects` lands, Projects is a leaf link. The load turns it into a branch, and `NavTree` renders a branch with different DOM: a new link, a toggle and the project rows.
- When the load landed after the tab walk had passed the sidebar but before the reachability check, the check found the new nodes unstamped and listed the whole Projects branch as unreachable.
- Side finding (product a11y, out of scope): the leaf-to-branch remount also drops keyboard focus if it sits on Projects at that moment.

Fix: `sidebarTreeLoaded(page)` waits for `nav-tree-toggle-projects` before the walk. The toggle exists only after the load. The assertions are unchanged.

Proof:
- Deterministic RED: a temporary `page.route` probe held `GET /api/projects` until the walk was done, then let it land before the check. 2 of 2 runs failed with the full run's exact list of 9 items: Projects, its toggle, and every project, environment and service row with its toggle.
- A plain 8 s delay without the wait passed 3/3. The walk takes about 60 ms and the check runs right after it, so the failure needs the load to land inside that window. Under load that window grows.
- GREEN: with the 8 s delay and the wait, under load: 8/8 passed. The probe is removed.

## projects-dod.spec.ts, 14-13 H2 375 px: `apiResponse.text: Response has been disposed` (full run 1)

Root cause: a test race at teardown. `injectLongService` rewrites every services response through `route.fetch()`. The sidebar tree refetches services on every stream resync, so one of those requests can still be in the handler when the test ends and the page closes. The handler's `response.text()` or `route.fetch()` then throws (`Response has been disposed`, or `route.fetch: Test ended`) and fails a test whose assertions had all passed.

Fix: `test.afterEach` in the `@projects-dod` describe calls `page.unrouteAll({ behavior: 'ignoreErrors' })`. It drops handlers still in flight after the test body. Errors thrown during the test body are still reported.

Proof:
- Load RED: `-g "H2 no horizontal scroll at 375 and 1280" --repeat-each=8`, 5 of 8 failed (4 `Response has been disposed`, 1 `route.fetch: Test ended`).
- GREEN: same load and command: 8/8 passed (one run together with the H1 GREEN above, 16/16).

## servers-list.spec.ts:96, empty state: `getByText('No servers yet')` not found (full run 2 of pass 2)

Root cause: cross-spec pollution through the live stream. The test fakes `GET /api/servers` as empty, but the shell's `/api/events` stream is real and the stack is shared with earlier specs.
- `server-detail.spec.ts` (runs just before) leaves a server on a TEST-NET address in CONNECTING. Its SSH connect times out about 10 s later and the worker flips it to UNREACHABLE.
- That `server.updated` reached the servers page during the empty-state test. The store inserts an update for an unknown id as a new row (`server-store.ts`), so the page showed `late-get-after-event-… Unreachable` instead of the empty state. The failure's page snapshot shows exactly that row.
- Under load the 10 s timeout lands inside this test's window. Idle, it lands before or after.

Fix: `holdLiveStream(page)` routes `/api/events` to a request that never answers, in the four tests that fake the whole list (empty state, skeleton, two rows, scroll edge). The `@stagger` tests already did this. The assertions are unchanged.

Proof:
- Deterministic RED: a temporary probe created a real server while the empty list was on screen. 2 of 2 runs failed with the same `No servers yet` not found.
- GREEN: the same probe with the stream held: 2/2 passed. The whole spec with the fix: 34/34 (`--repeat-each=2`). The probe is removed.

## Full suite under the same load

See the table below (filled in from the 5 consecutive runs).
