---
phase: 05-ui-web
plan: 22
subsystem: ui
tags: [react, vitest, jsdom, testing-library, tailwind-v4, design-tokens, tdd]

# Dependency graph
requires:
  - phase: 05-ui-web
    provides: "05-06's @noodara/ui scaffold, renderUi/userEvent jsdom component-test harness (dom Vitest project) and tokens.css/theme.css token set"
provides:
  - "packages/ui/src/tone.ts: serverStatusTone/discoveryCheckTone (each declared satisfies Record<..., Tone>) and STATUS_WORDS, the one source of the 'state is never colour-only' word"
  - "packages/ui/src/cn.ts: hand-rolled class-name join helper (no clsx dependency)"
  - "packages/ui/src/Button.tsx: the first @noodara/ui component -- four variants, loading/disabled states, data-variant/data-filled test hooks"
  - "packages/ui/src/StatusPill.tsx: the second component -- dot + STATUS_WORDS word for all six ServerStatus values, data-testid/data-status/data-tone/data-pulsing"
  - "packages/ui now has a direct runtime dependency on @noodara/domain (pure-domain -> ui-components boundaries edge already allowed since Plan 05-06)"
affects: [05-ui-web remaining component plans (05-23, 05-24, 05-25 build on Button/StatusPill/cn/tone), apps/web (once scaffolded, consumes all four exports directly)]

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "Design-system components import ServerStatus/DiscoveryCheckStatus types (and, in tests, the domain package's own frozen status tuples) from @noodara/domain's server/discovery subpaths -- never re-declared locally, so a new domain status is both a tone.ts compile error and a failing StatusPill.test.tsx/tone.test.ts it.each iteration"
    - "Every status-driven component test iterates the imported SERVER_STATUSES/DISCOVERY_CHECK_STATUSES tuple with it.each, never a locally declared array of status literals"
    - "State-conveying components always emit data-* attributes (data-variant, data-filled, data-status, data-tone, data-pulsing) so both component tests and future Playwright specs can assert state without depending on colour"
    - "Tailwind utility classes are the only styling surface in components -- always bound to a --token via theme.css's @theme block (bg-accent, text-status-error, rounded-pill, etc.), never a literal hex/rgb/px value"
    - "CSS effects jsdom cannot compute (active:[transform:scale(0.97)], focus-visible outline) are written into the component but asserted by Playwright/noodara-ux-review later, never faked with a jsdom-only computed-style assertion"

key-files:
  created:
    - packages/ui/src/tone.ts
    - packages/ui/src/tone.test.ts
    - packages/ui/src/cn.ts
    - packages/ui/src/cn.test.ts
    - packages/ui/src/Button.tsx
    - packages/ui/src/Button.test.tsx
    - packages/ui/src/StatusPill.tsx
    - packages/ui/src/StatusPill.test.tsx
  modified:
    - packages/ui/src/index.ts
    - packages/ui/package.json
    - pnpm-lock.yaml

key-decisions:
  - "packages/ui gained a real 'dependencies' entry on @noodara/domain (workspace:*), not just a devDependency -- tone.ts/StatusPill.tsx import its ServerStatus/DiscoveryCheckStatus types at production-code paths, matching the existing packages/ssh precedent (pnpm boundaries requires the importing package to directly declare anything it imports, not just inherit reachability via the already-allowed pure-domain -> ui-components boundaries tag)"
  - "cn.test.ts's 'drops false' assertion routes the false literal through a tiny widen(value: boolean): boolean helper instead of writing 'false && ...' inline -- typescript-eslint's strict-type-checked preset statically flags a literal false && ... as always-falsy (no-constant-binary-expression / no-unnecessary-condition), and a const-with-wider-annotation trick doesn't survive TS's own control-flow narrowing, but crossing a declared-return-type function boundary does"
  - "StatusPill's CONNECTING pulse uses Tailwind's built-in motion-safe: variant (@media (prefers-reduced-motion: no-preference)) rather than a hand-written arbitrary keyframe -- functionally the same gate as '@media (prefers-reduced-motion: reduce) disables it', with no new @keyframes declaration needed outside this plan's file list"
  - "Button's aria-busy is rendered as aria-busy={loading ? true : undefined}, not aria-busy={loading} -- React stringifies an explicit boolean false into the literal DOM attribute aria-busy=\"false\", which would fail the 'disabled alone does not set aria-busy' behaviour; undefined omits the attribute entirely"

requirements-completed: []

# Metrics
duration: ~25min
completed: 2026-09-19
---

# Phase 5 Plan 22: Button, StatusPill and Their Two Pure Helpers Summary

**Test-first Button (4 variants, loading/disabled semantics, no spinner) and StatusPill (all 6 ServerStatus values, colour-never-alone) on top of new tone.ts/cn.ts helpers, all token-only styling.**

## Performance

- **Duration:** ~25 min
- **Completed:** 2026-09-19
- **Tasks:** 3 (each RED test committed separately from its GREEN implementation, per CLAUDE.md SS2.1)
- **Files modified:** 11 (8 new source/test files, index.ts, package.json, pnpm-lock.yaml)

## Accomplishments

- `packages/ui/src/tone.ts` maps every `ServerStatus`/`DiscoveryCheckStatus` to one of four `Tone`s via a `satisfies Record<...>` literal (compile-time exhaustiveness) and exposes `STATUS_WORDS`, the single source every later status-rendering component reads from so "state is never colour-only" is enforced once, not per-component.
- `packages/ui/src/cn.ts` is the deliberate hand-rolled `clsx` alternative (05-RESEARCH.md's Supporting table left this open) — drops falsy values, trims, collapses whitespace, ~10 lines, zero new dependency.
- `packages/ui/src/Button.tsx` is the first real `@noodara/ui` component: four variants (`primary`/`secondary`/`ghost`/`destructive`), a `loading` state that keeps the label unchanged and communicates purely through `disabled`+`aria-busy` (no spinner, machine-checked by a `[class*="animate-spin"]`/`role="progressbar"` absence assertion), and `data-variant`/`data-filled` attributes for both this plan's tests and future Playwright specs.
- `packages/ui/src/StatusPill.tsx` renders an `aria-hidden` dot plus the `STATUS_WORDS` word for all six `ServerStatus` values, with `data-testid`/`data-status`/`data-tone`/`data-pulsing` making every bit of state observable in the DOM without reading colour; it deliberately owns no `aria-live`/`role` of its own, deferring live-region behaviour to the discovery section a later plan builds.
- All four RED test files were seen to fail for the right reason (missing module) before their GREEN implementation existed, each as its own `test(05-22): ...` commit ahead of the matching `feat(05-22): ...` commit.
- `pnpm test` (964 tests, up from 902 before this plan, zero regressions), `pnpm build`, `pnpm lint`, `pnpm typecheck`, `pnpm boundaries` and `node scripts/check-package-provenance.mjs` are all green; `grep -rE "#[0-9a-fA-F]{3,8}|rgb\(" packages/ui/src` is empty.

## Task Commits

1. **Task 1 RED: failing tone/cn helper tests** - `eef0457` (test)
2. **Task 1 GREEN: tone and cn design-system helpers** - `225ce36` (feat)
3. **Task 2 RED: failing Button component test** - `408366c` (test)
4. **Task 2 GREEN: the Button component** - `2644fcc` (feat)
5. **Task 3 RED: failing StatusPill component test** - `f00097a` (test)
6. **Task 3 GREEN: the StatusPill component** - `f037442` (feat)

## Files Created/Modified

- `packages/ui/src/tone.ts` - `Tone` type, `serverStatusTone`, `discoveryCheckTone`, `STATUS_WORDS`
- `packages/ui/src/tone.test.ts` - iterates `SERVER_STATUSES`/`DISCOVERY_CHECK_STATUSES` from `@noodara/domain`, asserting every tone and word
- `packages/ui/src/cn.ts` - class-name join helper
- `packages/ui/src/cn.test.ts` - falsy-dropping, empty-call and whitespace-collapsing behaviour
- `packages/ui/src/Button.tsx` - the four-variant, loading/disabled-aware button
- `packages/ui/src/Button.test.tsx` - 12 tests across all documented behaviours
- `packages/ui/src/StatusPill.tsx` - the six-status pill, dot + word
- `packages/ui/src/StatusPill.test.tsx` - 26 tests, all `it.each(SERVER_STATUSES)`-driven
- `packages/ui/src/index.ts` - now exports `Button`, `StatusPill`, `cn`, `serverStatusTone`, `discoveryCheckTone`, `STATUS_WORDS`, `Tone` (alphabetical)
- `packages/ui/package.json` - new `dependencies.@noodara/domain: workspace:*`
- `pnpm-lock.yaml` - lockfile update for the new workspace dependency edge

## Decisions Made

See `key-decisions` in frontmatter — summarized: `@noodara/domain` promoted to a direct `dependencies` entry of `packages/ui` (not just inherited via the already-allowed boundaries tag); `cn.test.ts`'s falsy-`false` case routed through a declared-return-type `widen()` helper to survive typescript-eslint's constant-condition rules where a plain `false && ...` literal doesn't; `StatusPill`'s pulse uses Tailwind's built-in `motion-safe:` variant rather than a new custom keyframe; `Button`'s `aria-busy` uses `true : undefined` (never a literal `false`) so the attribute is genuinely absent, not stringified to `"false"`, when only `disabled` is set.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] `cn.test.ts`'s literal `false && 'b'` failed typescript-eslint's constant-condition rules**
- **Found during:** Task 1, `pnpm --filter @noodara/ui lint`
- **Issue:** `no-constant-binary-expression` and `@typescript-eslint/no-unnecessary-condition` both flagged the plan's own literal example `false && 'b'` as statically-known-falsy; a `const x: boolean = false` annotation trick still failed because TypeScript's control-flow analysis narrows a never-reassigned `const` to its literal initializer for exactly this kind of check, regardless of the declared wider annotation.
- **Fix:** Introduced a tiny `widen(value: boolean): boolean { return value; }` helper — crossing a function boundary with a declared (non-literal) return type defeats the narrowing, while the runtime behaviour under test (`cn('a', false && 'b', undefined, 'c') === 'a c'`) is unchanged.
- **Files modified:** `packages/ui/src/cn.test.ts`
- **Commit:** `225ce36`

**2. [Rule 3 - Blocking] `packages/ui` needed its own `@noodara/domain` dependency for `pnpm boundaries`/module resolution**
- **Found during:** Task 1, writing `tone.ts`'s `import type { ServerStatus } from '@noodara/domain/server'`
- **Issue:** `packages/ui/package.json` had no dependency on `@noodara/domain` at all — the `ui-components` boundaries tag already allows `pure-domain` (Plan 05-06), but that only permits the edge, it does not declare it; `pnpm boundaries`'s own rule (already documented for `@testing-library/*` in 05-06) requires a package to directly declare anything it imports.
- **Fix:** Added `"dependencies": { "@noodara/domain": "workspace:*" }` to `packages/ui/package.json`, mirroring `packages/ssh/package.json`'s identical pattern, and ran `pnpm install` to update the lockfile.
- **Files modified:** `packages/ui/package.json`, `pnpm-lock.yaml`
- **Commit:** `eef0457`

---

**Total deviations:** 2 auto-fixed (1 Rule 1 bug, 1 Rule 3 blocking)
**Impact on plan:** Both fixes were necessary to make the plan's own verification commands (`pnpm lint`, `pnpm boundaries`) actually pass; neither changed the plan's scope or intent.

## Issues Encountered

None beyond the auto-fixed deviations above.

## User Setup Required

None — no external service configuration required. No new packages were installed (ADR-0000's Phase 5 table already covers every dependency `packages/ui` currently uses; this plan added zero new ones, matching its own constraint).

## Next Phase Readiness

- `Button` and `StatusPill` are real, behaviourally-tested, token-only components other Phase 5 plans (05-23, 05-24, 05-25) can build on; `cn`/`tone`/`STATUS_WORDS` are the shared primitives every later status-rendering component should reuse rather than re-inventing a tone map.
- **UI-01 stays Pending in REQUIREMENTS.md.** This plan only adds two components and two helpers to `packages/ui` — no sidebar, toolbar, shell layout or `apps/web` exists yet. Matches the same plan-frontmatter-artifact pattern already flagged in STATE.md for SERV-06 (04-01), DETL-02/QA-05 (05-01/05-02/05-03), DISC-02/QA-05 (05-05) and UI-01 itself (05-06). Re-verify UI-01 against whichever later plan actually builds the shell (05-UI-SPEC.md SS1), not this plan's `requirements: [UI-01]` frontmatter field.
- `Button`'s focus-visible outline and `active:scale(0.97)` press effect, and `StatusPill`'s `motion-safe:` pulse gating, are written correctly but unverified by any Tailwind build in this plan (no `apps/web` yet consumes `theme.css` through an actual PostCSS/Tailwind pipeline) — first real visual verification happens once `apps/web` exists and again at Plan 05-21's `noodara-ux-review` audit.

---
*Phase: 05-ui-web*
*Completed: 2026-09-19*

## Self-Check: PASSED

Verified on disk: `packages/ui/src/tone.ts`, `tone.test.ts`, `cn.ts`, `cn.test.ts`, `Button.tsx`, `Button.test.tsx`, `StatusPill.tsx`, `StatusPill.test.tsx`, `index.ts`, `package.json`. All six task commits (`eef0457`, `225ce36`, `408366c`, `2644fcc`, `f00097a`, `f037442`) confirmed present in `git log --oneline`. `pnpm test` (964 tests), `pnpm build`, `pnpm lint`, `pnpm typecheck`, `pnpm boundaries` and `node scripts/check-package-provenance.mjs` all green; zero hex/`rgb(` literals in `packages/ui/src`.
