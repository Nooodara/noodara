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

## Full suite under the same load

See the table below (filled in from the 5 consecutive runs).
