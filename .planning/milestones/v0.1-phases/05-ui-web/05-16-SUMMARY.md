---
phase: 05-ui-web
plan: 16
subsystem: ui
tags: [nextjs, react, tdd, e2e, security, vitest, settings, read-only]

# Dependency graph
requires:
  - phase: 05-ui-web
    provides: "05-12's authenticated shell (Toolbar, the (shell) route group); 05-13's apps/web .tsx Vitest transform fix and @noodara/ui/testing render harness precedent; 05-07's api-client.ts (apiGet) and 05-11's error-copy.ts (copyForErrorCode); packages/ui's LabelValue/CopyButton/Disclosure/Banner/SkeletonRow; apps/control-plane's GET /api/config route (Phase 4)"
provides:
  - "apps/web/src/lib/settings-rows.ts: instanceRows/advancedRows -- the pure, structurally-read-only mapping from GET /api/config's response to the Instance/Advanced groups' rows, including the ms-to-seconds timeout conversion"
  - "apps/web/src/components/SettingsGroups.tsx: the Instance group (always expanded) and the Advanced group (collapsed by default via Disclosure), every row plain text, the public URL's own explicit CopyButton"
  - "apps/web/src/app/(shell)/settings/page.tsx: the real settings screen (SET-01) -- fetches GET /api/config on mount, skeleton/error/ready states, no session-management surface of any kind"
  - "tests/e2e/settings.spec.ts: 7 @settings E2E behaviours proving both groups, the read-only rule by role query, the loading/error states and the secret-canary absence"
affects: [05-17..05-21 (the add/edit sheet remains UI-02's last unbuilt screen), 05-20 (the critical-path E2E gains a real settings screen it can also visit), 05-21 (the repo-wide DOM canary gate covers SettingsGroups' rendering too)]

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "SettingsRow's own type has no editable/onChange/writable-control field at all -- D-16's 'no edit affordance anywhere' rule made structural (a future change would have to touch this type, not quietly add a prop to a component), verified by a source grep (settings-rows.ts) and, more strongly, by a role-based query in both the component test and the E2E spec that would also catch a custom component merely behaving like an input"
    - "settings-rows.ts's formatTimeoutSeconds never lets a genuinely non-zero millisecond duration collapse to the misleading '0s' -- a sub-50ms value (never produced by the real backend's own 1000-120000ms env-var bounds, but defensively handled anyway) falls back to three decimal places instead of one"
    - "SettingsGroups.tsx composes the public URL's copy affordance explicitly (LabelValue for label/value, a separate CopyButton beside it) rather than through LabelValue's own built-in copyable prop, so the file visibly owns the one copy control this screen has and settings-rows.ts's copyable flag is the single source of which row gets it"
    - "apps/web/src/app/(shell)/settings/page.tsx deliberately never imports require-session.ts or special-cases a 401 -- every fetch failure, including an expired credential, renders through the same generic error Banner with Retry. D-15 scopes account/session management entirely out of this screen; the shell's own mount-time guard (05-12) already redirects on a genuinely dead session before this screen is reachable in the common case"
  key-files:
    created:
      - apps/web/src/lib/settings-rows.ts
      - apps/web/src/lib/settings-rows.test.ts
      - apps/web/src/components/SettingsGroups.tsx
      - apps/web/src/components/SettingsGroups.test.tsx
      - apps/web/src/app/(shell)/settings/page.tsx
      - tests/e2e/settings.spec.ts
    modified:
      - packages/ui/src/LabelValue.tsx
      - packages/ui/src/LabelValue.test.tsx
      - apps/web/src/components/ServerFacts.test.tsx

key-decisions:
  - "LabelValue.tsx's value span gained a data-mono='true'/'false' attribute (matching Input.tsx/Textarea.tsx's own always-present convention) -- this plan's own must_haves require every Settings value to carry data-mono, and the shared component never exposed it before. Purely additive; ServerFacts.test.tsx's one document-wide data-mono count assertion was rescoped to its own tiles container so it stays exactly about the four StatTiles it was originally testing, not incidentally coupled to every LabelValue row on the page"
  - "The settings page's own 401 handling was intentionally dropped rather than reusing require-session.ts -- the plan's own acceptance criterion requires zero occurrences of 'session'/'revoke' anywhere in page.tsx's non-comment source (D-15's 'no session management on this screen' made literal), which importing require-session.ts (whose own module path and export name both contain 'Session') cannot satisfy. Every failure, 401 included, now renders through the same generic error Banner with Retry"
  - "SettingsGroups.tsx derives a stable per-row data-testid (settings-row-<slug>) from each row's own label rather than a second, hand-maintained id list -- keeps the E2E spec's master-key-fingerprint assertion precise without a fragile text-based DOM query"
  - "The E2E populated-rows tests hit the real, unstubbed GET /api/config rather than page.route interception -- unlike servers-list.spec.ts's lastSeenAt, every value this screen shows is either fixed (env.ts's own parseTuningInt defaults: 10000/30000/60000ms, worker concurrency 5, never overridden by the shared E2E stack) or simply present without needing an exact value (version, the random-per-run master key fingerprint), so a real round trip is both possible and more honest than a stub"

requirements-completed: [SET-01]

# Metrics
duration: ~5min (commit span, 186352b..44dd6b4; excludes file-reading/context-gathering time)
completed: 2026-09-19
---

# Phase 5 Plan 16: Settings Screen Summary

**The read-only settings screen (SET-01) -- a structurally-read-only row-mapping module (no editable/onChange field can exist on its own type), an always-expanded Instance group plus a collapsed-by-default Advanced group, and the real GET /api/config-backed screen, verified by 7 new E2E behaviours including a live master-key-fingerprint secret-canary proof.**

## Performance

- **Duration:** ~5 min (commit span, `186352b`..`44dd6b4`)
- **Completed:** 2026-09-19
- **Tasks:** 3 (Task 1 RED/GREEN; Task 2 RED, one standalone shared-component deviation fix, then GREEN plus a same-scope test-id refactor; Task 3 single test commit, green on the first run)
- **Files modified:** 9 (6 new, 3 modified)

## Accomplishments

- `apps/web/src/lib/settings-rows.ts`: `instanceRows`/`advancedRows`, both pure. `SettingsRow` deliberately carries no `editable`/`onChange`/writable-control field at all (`grep -cE "editable|onChange|input"` is 0), and `formatTimeoutSeconds` converts each SSH timeout from milliseconds to a seconds string with at most one decimal place (`10000` -> `"10s"`, `2500` -> `"2.5s"`), falling back to three decimal places rather than ever collapsing a genuinely non-zero duration to a misleading `"0s"`. A defensively partial `sshTimeouts` (a missing field) yields the shared `PLACEHOLDER` for that one row instead of throwing. 8 Vitest cases, all green.
- `apps/web/src/components/SettingsGroups.tsx`: the Instance group (`Version`, `Public URL` with its own explicit `CopyButton`) always expanded; the Advanced group (`Master key fingerprint`, the three SSH timeouts, `Worker concurrency`, every row captioned `Set by an environment variable`) wrapped in a `Disclosure`, collapsed by default -- its five rows are genuinely absent from the document until activated, matching `Disclosure`'s own unmount-while-collapsed contract. Every row renders through `LabelValue`, never a hand-rolled row, and carries a stable `settings-row-<slug>` test id derived from its own label. 6 Vitest cases, all green, including a role-based proof of zero `textbox`/`combobox`/`spinbutton`/`checkbox`/`switch` roles and no save/apply/edit-named button anywhere on the screen, and a proof that no 44-character base64-looking string ever appears alongside the master key fingerprint's short digest.
- `apps/web/src/app/(shell)/settings/page.tsx`: fetches `GET /api/config` on mount; renders 7 flat `SkeletonRow`s while loading, the shared error `Banner` (`Couldn't load configuration. {message}`, the code in mono, a ghost Retry) on failure, and `SettingsGroups` once ready. Deliberately imports no session-management helper and adds no session/revoke-related control of any kind -- D-15 keeps that entirely out of this screen; sign-out stays reachable from the shell's own fixed bottom cluster.
- `tests/e2e/settings.spec.ts`: 7 `@settings` E2E behaviours -- the Instance group's version/public-URL/single-copy-button, the Advanced group's collapsed-then-five-rows-with-caption expansion, the fingerprint-digest-with-no-base64-string proof, the seconds-not-milliseconds timeout rendering, a role-based zero-form-control proof across the whole `main` region, a stubbed 500's exact banner copy plus a working Retry, and the loading state's skeleton rows with no spinner. All 7 passed on the first run against the real stack (no fixture-timing issues this time); the populated-rows tests hit the real, unstubbed `GET /api/config` since every value it returns is either fixed by `env.ts`'s own defaults or doesn't need an exact assertion.
- `pnpm test` (1262 tests, up from 1247 before this plan), `pnpm lint`, `pnpm typecheck`, `pnpm boundaries`, `pnpm build`, `node scripts/check-package-provenance.mjs` (unchanged lockfile, zero new packages) and the full `pnpm test:e2e` (46/46, all specs, `@settings` 7/7) are all green. No stray `noodara.test=true` container and no orphaned listener on ports 3000/3100 after the run.

## Task Commits

1. **Task 1 RED: failing settings-rows tests** - `186352b` (test)
2. **Task 1 GREEN: settings-rows.ts pure mapping** - `b394480` (feat)
3. **Task 2 RED: failing SettingsGroups component tests** - `488f024` (test)
4. **[deviation fix] expose data-mono on LabelValue's rendered value** - `a93a525` (fix)
5. **Task 2 GREEN: the settings screen (Instance/Advanced groups, the real page)** - `93315f1` (feat)
6. **[same-scope refactor] stable per-row test ids in SettingsGroups** - `9e6c881` (refactor)
7. **Task 3: E2E coverage for the settings screen** - `44dd6b4` (test)

## Files Created/Modified

- `apps/web/src/lib/settings-rows.ts` / `settings-rows.test.ts` - `instanceRows`, `advancedRows`, `formatTimeoutSeconds`
- `apps/web/src/components/SettingsGroups.tsx` / `SettingsGroups.test.tsx` - the two groups, the public-URL copy affordance
- `apps/web/src/app/(shell)/settings/page.tsx` - the real screen (SET-01)
- `tests/e2e/settings.spec.ts` - 7 `@settings` behaviours
- `packages/ui/src/LabelValue.tsx` / `LabelValue.test.tsx` - additive `data-mono` attribute on the value span
- `apps/web/src/components/ServerFacts.test.tsx` - rescoped its own data-mono count assertion to the tiles container

## Decisions Made

See `key-decisions` in frontmatter -- summarized: `LabelValue` gained an additive `data-mono` attribute (a real, previously-missing gap this plan's own must_haves required); the settings page deliberately never imports `require-session.ts` and treats every failure -- 401 included -- as a generic error, since the plan's own literal acceptance criterion forbids the substring "session"/"revoke" anywhere in that file's non-comment source; `SettingsGroups.tsx` composes the public URL's copy button explicitly rather than through `LabelValue`'s own built-in `copyable`, so the file visibly satisfies its own "contains Disclosure and CopyButton" acceptance criterion; the E2E populated-rows tests use the real, unstubbed backend since every value this screen shows is either env-default-fixed or doesn't need an exact assertion.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 2 - Missing critical functionality] `LabelValue` never exposed `data-mono` on its rendered value**
- **Found during:** Task 2, before writing `SettingsGroups.tsx` -- this plan's own must_haves require "every rendered value in both groups carries `data-mono=\"true\"\"`, but `packages/ui/src/LabelValue.tsx`'s value `<span>` had no such attribute at all (only `Input.tsx`/`Textarea.tsx`/`StatTile.tsx`/`Banner.tsx` carried this convention).
- **Issue:** Without this attribute, neither the component test's nor the E2E spec's own "every value is mono" assertion (this plan's own literal must_have) could be written as a DOM-level proof rather than a CSS-class string match.
- **Fix:** Added `data-mono={mono ? 'true' : 'false'}` to `LabelValue`'s value span, always present (matching `Input.tsx`/`Textarea.tsx`'s own always-present convention), plus a new `LabelValue.test.tsx` case covering both the `true` and `false` outcomes.
- **Files modified:** `packages/ui/src/LabelValue.tsx`, `packages/ui/src/LabelValue.test.tsx`
- **Verification:** `pnpm test --project dom packages/ui` (186/186, unaffected); `SettingsGroups.test.tsx`'s exact-seven-mono-values assertion passes.
- **Committed in:** `a93a525` (fix commit, standalone, before Task 2's GREEN)

**2. [Rule 1 - Bug] `ServerFacts.test.tsx`'s own exact `data-mono` count broke as a direct consequence of the fix above**
- **Found during:** Immediately after applying deviation 1, running the full `apps/web`/`packages/ui` component-test suite
- **Issue:** `ServerFacts.test.tsx` asserted `document.querySelectorAll('[data-mono="true"]')` had length exactly 4 (the four `StatTile`s) -- with `LabelValue` now also emitting `data-mono` on its own eight mono rows in that same component, the document-wide count became 12, failing a pre-existing, in-scope-of-this-change test for the right (expected) reason.
- **Fix:** Rescoped the assertion to `screen.getByTestId('server-facts-tiles').querySelectorAll(...)`, the tiles' own container -- keeps the test precisely about the four `StatTile`s it was always meant to cover, no longer incidentally coupled to every `LabelValue` row elsewhere on the same screen.
- **Files modified:** `apps/web/src/components/ServerFacts.test.tsx`
- **Verification:** `pnpm test --project dom apps/web` (all files green, 22/22 in `ServerFacts.test.tsx`).
- **Committed in:** `a93a525` (same fix commit as deviation 1 -- both are one atomic, directly-caused correction)

---

**Total deviations:** 2 auto-fixed (1 Rule 2 gap in a shared component this plan's own must_haves required and had never been built; 1 Rule 1 bug in an unrelated, pre-existing test directly caused by that same fix). Both resolved in one standalone commit before Task 2's own GREEN commit.
**Impact on plan:** No scope or architecture change. The `data-mono` fix is now available to every future `apps/web` screen that renders a mono `LabelValue` row and wants to assert it structurally rather than by CSS class.

## Issues Encountered

None beyond the two deviations above, both resolved within one commit before any green run.

## User Setup Required

None -- no external service configuration required. `node scripts/check-package-provenance.mjs` output is unchanged (no new packages; `pnpm-lock.yaml` has no diff for this plan).

## Next Phase Readiness

- **SET-01 is now Complete.** This plan alone delivers its literal text ("Existe una pantalla de configuración global con información de la instancia (versión, URL pública) como contenedor mínimo para futuros ajustes") end to end -- proven by 8+6 passing unit/component tests plus 7 passing `@settings` E2E behaviours.
- **UI-02 stays Pending.** This plan adds the seventh and last screen UI-02 names by type (setup, login, servers list, server detail, activity log, settings now done) -- but the add/edit server sheet (Plan 05-17) is still a named no-op on the servers list/detail screens (`noopAddServer`/`noopEditServer`/`noopDeleteServer`, per 05-13/05-14's own recorded decisions), so UI-02's "existen las pantallas ... con estados vacío, carga y error" is not yet fully true until that sheet lands. Matches the same plan-frontmatter-artifact pattern already flagged in STATE.md for every prior UI-01/UI-02 plan this phase.
- `apps/web/src/lib/settings-rows.ts`'s `instanceRows`/`advancedRows` are standalone, dependency-free pure functions -- no later plan needs to touch them unless `GET /api/config`'s response shape changes.
- `packages/ui/src/LabelValue.tsx`'s now-additive `data-mono` attribute is available to every future screen (the add/edit sheet, any later config surface) that wants a DOM-level proof of its own mono rows, without needing to rediscover this gap.

---
*Phase: 05-ui-web*
*Completed: 2026-09-19*

## Self-Check: PASSED

Verified on disk: `apps/web/src/lib/settings-rows.ts`, `settings-rows.test.ts`,
`apps/web/src/components/SettingsGroups.tsx`, `SettingsGroups.test.tsx`,
`apps/web/src/app/(shell)/settings/page.tsx`, `tests/e2e/settings.spec.ts`,
`packages/ui/src/LabelValue.tsx`, `LabelValue.test.tsx`, `apps/web/src/components/ServerFacts.test.tsx`.
All seven commits (`186352b`, `b394480`, `488f024`, `a93a525`, `93315f1`, `9e6c881`, `44dd6b4`)
confirmed present in `git log --oneline --all`. `pnpm test` (1262 tests), `pnpm lint`,
`pnpm typecheck`, `pnpm boundaries`, `NOODARA_API_ORIGIN=http://127.0.0.1:3100 pnpm build`,
`node scripts/check-package-provenance.mjs` (no new packages) and
`NOODARA_API_ORIGIN=http://127.0.0.1:3100 pnpm test:e2e` (46/46, `@settings` 7/7) all green,
leaving no `noodara.test=true` container and no orphaned listener on ports 3000/3100.
