---
phase: 05-ui-web
plan: 07
subsystem: ui
tags: [nextjs, react, tailwind-v4, fetch, turborepo, vitest, tdd]

# Dependency graph
requires:
  - phase: 05-ui-web
    provides: "05-06's @noodara/ui scaffold (tokens.css/theme.css exports, dom Vitest project) and 05-22's Button/StatusPill components this app's globals.css/layout now consume"
provides:
  - "apps/web: a booting Next.js 16 App Router shell, proxying /api/* same-origin to NOODARA_API_ORIGIN via next.config.ts rewrites(), with X-Frame-Options/CSP frame-ancestors headers"
  - "apps/web/src/lib/api-client.ts: apiGet/apiSend, the one tested fetch wrapper every later screen plan uses to reach the control plane"
  - "apps/web/src/lib/theme-script.ts + layout.tsx: the no-flash theme bootstrap (localStorage noodara-theme, prefers-color-scheme fallback) wired into the root layout's single reviewed dangerouslySetInnerHTML"
  - "docs/adr/0006-web-app-same-origin-proxy-and-ports.md: the recorded origin/port/proxy contract"
  - "turbo.json/CI wiring so pnpm dev/pnpm build/pnpm test:boot all account for apps/web in the shared task graph"
affects: [05-ui-web remaining screen/component plans (every later plan imports apiGet/apiSend and renders inside this root layout), 05-12 (the authenticated shell route-group layout this plan deliberately leaves for later)]

# Tech tracking
tech-stack:
  added: [next@16.3.5, react@19.3.0 (already present, now also a apps/web dependency), react-dom@19.3.0, tailwindcss@4.3.3, "@tailwindcss/postcss@4.3.3"]
  patterns:
    - "apps/web reaches the control plane exclusively through relative /api/* fetches, proxied same-origin by next.config.ts's rewrites() -- no cross-origin fetch target anywhere, no CORS, cookies and EventSource need zero special configuration (docs/adr/0006)"
    - "apiGet<T>/apiSend<T> (apps/web/src/lib/api-client.ts) is the single fetch wrapper: asserts a relative /api/ path (throws before any fetch on an absolute URL), always credentials: 'same-origin', parses a failure body defensively into a fixed ApiErrorCode union, never echoes a raw response body or a caught exception's own message"
    - "Every apps/web tsconfig.json inherits @noodara/config/tsconfig.base.json but overrides moduleResolution to 'bundler' (Next.js requirement) -- relative imports inside apps/web are written WITHOUT a .js extension, unlike the rest of the repo's nodenext convention"
    - "Turborepo dispatches a task to every package whose package.json declares a script with that exact name -- apps/web's own 'dev' script needed no new turbo task or apps/web/turbo.json; it already joins the existing shared 'dev' task pnpm dev/pnpm test:boot already run"
    - "ServerView/ApiErrorCode in api-client.ts are hand-copied from the control plane's ServerView/ServiceErrorCode, never imported -- the browser bundle must never depend on a control-plane-internal module"

key-files:
  created:
    - apps/web/package.json
    - apps/web/tsconfig.json
    - apps/web/next.config.ts
    - apps/web/postcss.config.mjs
    - apps/web/src/app/layout.tsx
    - apps/web/src/app/globals.css
    - apps/web/src/lib/theme-script.ts
    - apps/web/src/lib/api-client.ts
    - apps/web/src/lib/api-client.test.ts
    - docs/adr/0006-web-app-same-origin-proxy-and-ports.md
  modified:
    - turbo.json
    - .env.example
    - .gitignore
    - pnpm-lock.yaml
    - packages/ui/tokens.css
    - packages/ui/theme.css
    - packages/config/eslint.config.js
    - .github/workflows/ci.yml
    - tests/integration/helpers/boot-process.ts

key-decisions:
  - "No apps/web/turbo.json and no root package.json 'dev' script change: Turborepo dispatches a task to every package whose package.json declares a matching script name, so apps/web's own 'dev' script (next dev --port 3000) automatically joins the existing shared root 'dev' task the moment it exists -- verified empirically with 'turbo run dev dev:worker --dry-run=json' before relying on it, and again by the real clean-tree pnpm dev boot-smoke test passing"
  - "next.config.ts's rewrites()/headers() are declared as plain (non-async) functions, not async with no await -- @typescript-eslint/require-await rejected the plan's own implied async shape since neither function awaits anything; Next.js's NextConfig type accepts both sync and async return shapes"
  - "packages/ui/tokens.css and theme.css had literal '*/' substrings inside prose comments (describing Tailwind's --text-*/--text-*--line-height namespace pattern), which prematurely terminated the CSS comment -- tokens.css hard-failed the very first real Tailwind build this phase runs through the pipeline (05-06/05-22 never built apps/web, so this was undetected); reworded both comments to avoid the literal '*/' sequence, no functional change"
  - "buildValidBootEnv() (tests/integration/helpers/boot-process.ts) and CI's workflow-level env both gained NOODARA_API_ORIGIN: once apps/web's 'dev' script joins the shared task, the real clean-tree 'pnpm dev' boot-smoke test and pnpm test:integration's global build setup both now build/boot apps/web too, and next.config.ts's fail-fast throws without it -- same class of gap Plan 04-07 already fixed for REDIS_URL in the same function"
  - "The shared eslint config gained a '**/.next/**' ignore entry -- apps/web is the first package to produce build output eslint's own ignore list didn't already cover (dist/coverage/node_modules were listed, .next was not), and without it eslint attempted to lint compiled/minified Next.js output as source"

requirements-completed: []

# Metrics
duration: ~35min
completed: 2026-09-19
---

# Phase 5 Plan 7: apps/web Scaffold, Same-Origin Proxy, No-Flash Theme, API Client Summary

**Next.js 16 App Router shell that proxies /api/* same-origin to the control plane, boots inside the monorepo's turbo dev/build graph, renders with a no-flash theme bootstrap, and ships one tested fetch wrapper (apiGet/apiSend) every later screen plan will call.**

## Performance

- **Duration:** ~35 min
- **Completed:** 2026-09-19
- **Tasks:** 3 (Task 3 split RED/GREEN into two commits per CLAUDE.md SS2.1)
- **Files modified:** 19 (10 new, 9 modified)

## Accomplishments

- `apps/web` builds (`next build` produces a valid production build), lints, and typechecks clean inside the monorepo's task graph -- `packages/domain`/`@noodara/ssh`/`@noodara/ui` build first via `^build`, matching ADR-0003's contract.
- `next.config.ts`'s `rewrites()` proxies `/api/:path*` to `NOODARA_API_ORIGIN` with no fallback literal (fails fast, naming the variable, mirroring `apps/control-plane/src/env.ts`'s posture); `headers()` adds `X-Frame-Options: DENY` and `Content-Security-Policy: frame-ancestors 'none'` on every route -- the first clickjacking control this phase's admin UI gets.
- `apps/web/src/lib/api-client.ts`'s `apiGet`/`apiSend` are the one tested fetch wrapper: nine Vitest cases (written and observed failing on "Cannot find module './api-client'" before the file existed) prove all eight documented behaviours -- 200 pass-through, 400 `VALIDATION_FAILED` with `issues` preserved, 404 `NOT_FOUND` with `issues` absent, 401 setting `unauthorized: true`, 503 `Retry-After` parsed into `retryAfterSeconds`, a non-JSON/empty body degrading to a generic `INTERNAL_ERROR`, `credentials: 'same-origin'` plus an absolute-URL throwing before any `fetch()` call, and a rejected `fetch` resolving to `NETWORK_ERROR` without echoing the thrown error's own message.
- The root layout (`apps/web/src/app/layout.tsx`) renders `<html suppressHydrationWarning>` with the theme bootstrap script (`theme-script.ts`, a module-level string constant, zero interpolation) as the sole, reviewed `dangerouslySetInnerHTML` occurrence in the codebase, running before hydration so there is no theme flash; `globals.css` imports Tailwind then `@noodara/ui/tokens.css`/`theme.css` with only token-bound base styles.
- `pnpm dev` (unchanged command) now starts api, worker and web together -- verified via `turbo run dev dev:worker --dry-run=json` (Turborepo's script-name dispatch picks up `apps/web`'s own `dev` script automatically) and via the real clean-tree boot-smoke test (`tests/integration/boot/boot-command.test.ts`'s "reaches Server listening after turbo runs ^build on a tree with no dist" case), which now also boots and tears down a real `next dev` process.
- `pnpm install`, `pnpm build`, `pnpm lint`, `pnpm typecheck`, `pnpm boundaries`, `node scripts/check-package-provenance.mjs`, `pnpm test` (973 tests, up from 964, zero regressions) and `pnpm test:boot` (6/6) are all green.

## Task Commits

1. **Task 1: Scaffold apps/web and its monorepo wiring** - `a31ba5c` (feat)
2. **Task 2: Root layout, token stylesheet and the no-flash theme bootstrap** - `3c1ae30` (feat)
3. **Task 3 RED: failing api-client test** - `a6111b2` (test)
4. **Task 3 GREEN: the api-client fetch wrapper** - `cfbfcfd` (feat)

## Files Created/Modified

- `apps/web/package.json` - `@noodara/web`, `next`/`react`/`react-dom` dependencies, `tailwindcss`/`@tailwindcss/postcss` devDependencies, `dev`/`build`/`start`/`lint`/`typecheck`/`test` scripts
- `apps/web/tsconfig.json` - extends `@noodara/config/tsconfig.base.json`, overrides `moduleResolution: "bundler"` (documented as a deliberate, repo-wide-convention-breaking exception at the top of the file)
- `apps/web/next.config.ts` - `rewrites()` proxying `/api/:path*` to `NOODARA_API_ORIGIN`, fail-fast on missing var, `headers()` with `X-Frame-Options`/CSP `frame-ancestors`
- `apps/web/postcss.config.mjs` - registers `@tailwindcss/postcss`
- `apps/web/src/app/layout.tsx` - root Server Component layout, theme bootstrap script, `globals.css` import
- `apps/web/src/app/globals.css` - Tailwind + tokens.css + theme.css imports, token-bound base styles only
- `apps/web/src/lib/theme-script.ts` - `THEME_BOOTSTRAP_SCRIPT` string constant
- `apps/web/src/lib/api-client.ts` - `apiGet`/`apiSend`, `ApiResult`/`ApiFailure`/`ApiErrorCode`/`ServerView` types
- `apps/web/src/lib/api-client.test.ts` - nine behaviour tests
- `docs/adr/0006-web-app-same-origin-proxy-and-ports.md` - the recorded proxy/port/CSP decision
- `turbo.json` - `NOODARA_API_ORIGIN` in the `dev` task's `passThroughEnv` and the `build` task's `env`; `build`'s cacheable `outputs` widened to include `.next/**`
- `.env.example` - `NOODARA_API_ORIGIN` plus the `NOODARA_PUBLIC_URL` dev-port pairing note
- `.gitignore` - `.next/`, `next-env.d.ts`, `*.tsbuildinfo`
- `packages/ui/tokens.css` / `theme.css` - reworded two doc comments to remove an accidental literal `*/` that broke/warned during the first real Tailwind build (Rule 1 bug fix, no functional change)
- `packages/config/eslint.config.js` - added `**/.next/**` to the shared ignore list (Rule 3 blocking fix)
- `.github/workflows/ci.yml` - added `NOODARA_API_ORIGIN` to the workflow-level `env` block (Rule 3 blocking fix, needed by `boot-smoke`'s `pnpm build` and `integration`'s `pnpm test:integration` global build setup)
- `tests/integration/helpers/boot-process.ts` - `buildValidBootEnv()` now also sets `NOODARA_API_ORIGIN` (Rule 3 blocking fix, same class of gap Plan 04-07 fixed for `REDIS_URL`)

## Decisions Made

See `key-decisions` in frontmatter — summarized: relied on Turborepo's script-name task dispatch instead of adding a new `dev:web` task or `apps/web/turbo.json` (verified with a dry-run before committing to it); `next.config.ts`'s `rewrites()`/`headers()` are non-async (ESLint's `require-await` rejected an async shape with no `await`); fixed two pre-existing literal-`*/`-in-comment bugs in `packages/ui`'s CSS files that this plan's first real Tailwind build surfaced; propagated `NOODARA_API_ORIGIN` to the boot-test harness and CI now that `apps/web` participates in the shared `dev`/`build` task graph; added a `.next/**` eslint ignore.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] `packages/ui/tokens.css`'s doc comment had a literal `*/` prematurely closing the CSS comment**
- **Found during:** Task 1, first `next build` through the real Tailwind/PostCSS pipeline (05-06/05-22 never built `apps/web`, so this was undetected until now)
- **Issue:** A comment describing Tailwind's namespace pattern read `"...--text-*/--text-*--line-height..."`, which contains the literal two-character sequence `*/` — PostCSS's tokenizer treated it as the comment's actual terminator, so everything after it (including the apostrophe in "Apple's own" two lines later) was parsed as raw CSS and hard-failed the build with `Unterminated string`.
- **Fix:** Reworded the comment to describe the same namespace pattern without an embedded `*/` sequence. No token values or functional CSS changed.
- **Files modified:** `packages/ui/tokens.css`
- **Verification:** `next build` compiles successfully with no warnings; `grep -n '\*/' packages/ui/tokens.css` shows only legitimate comment terminators.
- **Committed in:** `a31ba5c` (Task 1 commit)

**2. [Rule 1 - Bug] `packages/ui/theme.css`'s doc comment had the same literal-`*/` bug (two occurrences)**
- **Found during:** Task 1, same build run — this one only produced a build *warning* ("Unexpected token Delim('*')"), not a hard failure, since the stray content landed differently relative to the `@theme` block.
- **Issue:** Same root cause as #1: `"bg-*/text-*/border-*"` and `"--text-*/--text-*--line-height"` in the header comment each contain a literal `*/`.
- **Fix:** Reworded both phrases (e.g. `"bg-*, text-* and border-*"`) to remove every embedded `*/` sequence.
- **Files modified:** `packages/ui/theme.css`
- **Verification:** `next build` produces zero warnings after the fix.
- **Committed in:** `a31ba5c` (Task 1 commit)

**3. [Rule 3 - Blocking] Shared eslint config had no `.next/**` ignore**
- **Found during:** Task 1, `pnpm --filter @noodara/web lint` after a successful build
- **Issue:** `apps/web` is the first package in this repo to produce build output eslint's own ignore list (`dist`/`.turbo`/`coverage`/`node_modules`) didn't already cover; ESLint attempted to lint Next.js's compiled/minified `.next/static/chunks/*.js` and generated `.next/types/*.d.ts` as source, producing ~850 unrelated errors.
- **Fix:** Added `'**/.next/**'` to `packages/config/eslint.config.js`'s shared `ignores` array.
- **Files modified:** `packages/config/eslint.config.js`
- **Verification:** `pnpm --filter @noodara/web lint` exits 0.
- **Committed in:** `a31ba5c` (Task 1 commit)

**4. [Rule 1 - Bug] `next.config.ts`'s `rewrites()`/`headers()` failed `@typescript-eslint/require-await` as async functions**
- **Found during:** Task 1, `pnpm --filter @noodara/web lint`
- **Issue:** Both functions were written `async` per the common Next.js example shape, but neither awaits anything internally, tripping the strict-type-checked `require-await` rule.
- **Fix:** Removed `async` from both; Next.js's `NextConfig` type accepts a synchronous return just as well (confirmed by `tsc --noEmit` passing unchanged).
- **Files modified:** `apps/web/next.config.ts`
- **Verification:** `pnpm --filter @noodara/web lint` and `typecheck` both exit 0.
- **Committed in:** `a31ba5c` (Task 1 commit)

**5. [Rule 3 - Blocking] `buildValidBootEnv()` and CI both needed `NOODARA_API_ORIGIN` once `apps/web` joined the shared `dev`/`build` tasks**
- **Found during:** Task 1's plan-level verification (`pnpm test:boot`), after Tasks 1–3 were otherwise complete
- **Issue:** Two distinct failures, same root cause: (a) `boot-command.test.ts`'s real, clean-tree, turbo-driven `pnpm dev` test now also starts `next dev` (Turborepo's script-name dispatch), which throws immediately without `NOODARA_API_ORIGIN` in the spawned child's env — `buildValidBootEnv()` builds a curated env object that didn't include it; (b) `pnpm test:integration`'s own `globalSetup` (`tests/integration/global-setup.ts`) runs a real `pnpm build`, which now also runs `next build` for `apps/web`, and CI's workflow had no `NOODARA_API_ORIGIN` set anywhere for that spawned build to inherit.
- **Fix:** Added `env.NOODARA_API_ORIGIN = 'http://localhost:3100'` to `buildValidBootEnv()` (mirroring the exact precedent already recorded there for `REDIS_URL`, Plan 04-07); added `NOODARA_API_ORIGIN: 'http://localhost:3100'` to `.github/workflows/ci.yml`'s workflow-level `env` block (covers both the `boot-smoke` and `integration` jobs' `pnpm build`/`pnpm test:integration` steps).
- **Files modified:** `tests/integration/helpers/boot-process.ts`, `.github/workflows/ci.yml`
- **Verification:** `pnpm test:boot` (6/6, including the clean-tree `pnpm dev` case) passes with `NOODARA_API_ORIGIN` exported in the invoking shell, matching how CI now provides it via the workflow env.
- **Committed in:** `a31ba5c` (Task 1 commit)

**6. [Rule 1 - Bug] `api-client.ts`'s `raw as RawFailureBody` cast was flagged as unnecessary**
- **Found during:** Task 3 GREEN, `pnpm --filter @noodara/web lint`
- **Issue:** `@typescript-eslint/no-unnecessary-type-assertion` — `RawFailureBody`'s three fields are all optional and `unknown`-typed, so any narrowed `object` value (from the `typeof parsed === 'object' && parsed !== null` guard) is already structurally assignable without an explicit `as` cast.
- **Fix:** Removed the redundant `as RawFailureBody` cast; the ternary's type still checks correctly via structural assignability.
- **Files modified:** `apps/web/src/lib/api-client.ts`
- **Verification:** `pnpm --filter @noodara/web lint` exits 0; all nine tests still pass.
- **Committed in:** `cfbfcfd` (Task 3 GREEN commit)

---

**Total deviations:** 6 auto-fixed (2 Rule 1 CSS-comment bugs, 1 Rule 1 lint-shape bug, 1 Rule 3 blocking eslint-ignore gap, 1 Rule 3 blocking env-propagation gap, 1 Rule 1 unnecessary-assertion lint bug)
**Impact on plan:** Every fix was necessary to make the plan's own verification commands (`pnpm build`, `pnpm lint`, `pnpm test:boot`) actually pass; none changed the plan's scope, architecture, or intent. The two CSS-comment bugs were pre-existing defects in `packages/ui` (Plans 05-06/05-22) that had never been exercised by a real Tailwind build pipeline until this plan created one — they are fixed here because this is the first plan positioned to discover them, not because this plan's own code introduced them.

## Issues Encountered

`pnpm security:scan-leaks` (not part of this plan's own required verification list, run as extra diligence per CLAUDE.md's Definition of Done) intermittently fails on `tests/integration/activity/canary-http.test.ts`'s SSE-frame assertion when run together with the suite's other two files, with repeated `"sse broadcaster subscriber redis error"` log lines preceding the failure. Re-run in isolation (`vitest run --config vitest.integration.config.ts tests/integration/activity/canary-http.test.ts`), it passes cleanly every time. This matches the exact "shared dev machine Docker/Redis subscriber contention" pattern already documented multiple times in STATE.md (e.g. the `events-sse.test.ts` entry from Phase 4) — not caused by any file this plan touches (no SSE/Redis/broadcaster code was modified). Not re-fixed here; out of this plan's scope per the deviation rules' scope boundary.

## User Setup Required

None — no external service configuration required. All packages installed (`next`, `react`, `react-dom`, `tailwindcss`, `@tailwindcss/postcss`) were already provenance-verified and recorded in `docs/adr/0000-package-legitimacy-approvals.md`'s Phase 5 additions table; this plan only performed the actual `pnpm add`/install.

## Next Phase Readiness

- `apps/web` boots, builds, and proxies the API correctly; every later phase-5 screen/component plan can render inside this root layout and call `apiGet`/`apiSend` without re-deriving the proxy, credentials, or error-parsing rules.
- **UI-01/UI-02 stay Pending in REQUIREMENTS.md.** This plan builds the app shell's *infrastructure* (proxy, theme bootstrap, fetch client) — no sidebar, toolbar, navigation, or any of the seven screens 05-UI-SPEC.md describes exist yet (Plan 05-12 adds the authenticated shell route-group layout this plan deliberately leaves for later). Matches the same plan-frontmatter-artifact pattern already flagged in STATE.md for SERV-06 (04-01), DETL-02/QA-05 (05-01/05-02/05-03), DISC-02/QA-05 (05-05), and UI-01 itself (05-06, 05-22). Re-verify UI-01/UI-02 against whichever later plan actually builds the shell and screens, not this plan's `requirements: [UI-01, UI-02]` frontmatter field.
- `apps/web/src/app/layout.tsx` intentionally renders no shell chrome (`{children}` only inside `<body>`) — `/setup` and `/login` (05-CONTEXT.md, no sidebar) and the authenticated shell (Plan 05-12) both build directly on top of this bare root layout without needing to override anything here.
- The `pnpm security:scan-leaks` flakiness noted above is pre-existing and machine-specific; a clean CI runner (or a machine with less concurrent Docker load) should not reproduce it, consistent with every prior occurrence of this same pattern in STATE.md.

---
*Phase: 05-ui-web*
*Completed: 2026-09-19*

## Self-Check: PASSED

Verified on disk: `apps/web/package.json`, `tsconfig.json`, `next.config.ts`, `postcss.config.mjs`,
`src/app/layout.tsx`, `src/app/globals.css`, `src/lib/theme-script.ts`, `src/lib/api-client.ts`,
`src/lib/api-client.test.ts`; `docs/adr/0006-web-app-same-origin-proxy-and-ports.md`; modified
`turbo.json`, `.env.example`, `.gitignore`, `packages/ui/tokens.css`, `packages/ui/theme.css`,
`packages/config/eslint.config.js`, `.github/workflows/ci.yml`,
`tests/integration/helpers/boot-process.ts`. All four task commits (`a31ba5c`, `3c1ae30`,
`a6111b2`, `cfbfcfd`) confirmed present in `git log --oneline`. `pnpm build`, `pnpm lint`,
`pnpm typecheck`, `pnpm boundaries`, `node scripts/check-package-provenance.mjs`, `pnpm test`
(973 tests) and `pnpm test:boot` (6/6) all green with `NOODARA_API_ORIGIN` set.
