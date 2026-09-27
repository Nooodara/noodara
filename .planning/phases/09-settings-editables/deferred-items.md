# Phase 9: Settings editables - Deferred Items

## Resolved during wave 3 (orchestrator post-merge gate)

- **`pnpm security:scan-leaks` canary: setup token in the `/setup?token=...` HTML response.**
  Found by 09-08's verification and first logged here as pre-existing; it was NOT: 09-07's
  `await cookies()` in the root layout made `/setup` render dynamically, and any dynamic render
  embeds the request's search params in the RSC flight payload of the document (segment key
  `__PAGE__?{"token":...}`, `serverProvidedParams.searchParams`). Fixed in wave 3 by pinning the
  `/setup` segment back to static (`apps/web/src/app/setup/layout.tsx`, `dynamic = 'force-static'`)
  and reading the token on the client only (`setup/page.tsx`, no `useSearchParams`). RED/GREEN:
  `tests/e2e/setup.spec.ts` "the server-rendered /setup?token=... document never echoes the token",
  plus `canary-ui.spec.ts` and `theme-first-paint.spec.ts` (15/15). Cost: /setup paints the OS
  theme until the bootstrap script runs (no account exists yet at that point).

## Logged during 09-09 — RESOLVED by the orchestrator in wave 4 (`@testing-library/react` declared in `apps/web/package.json`, `pnpm boundaries` clean: 735 files, 0 issues)

- **`pnpm boundaries` fails on `apps/web/src/lib/session-user.test.ts`: `@testing-library/react`
  imported dynamically but not declared as a dependency of `@noodara/web`.** Introduced by 09-10
  (`bb44602 feat(09-10): turn session-user into a shared store with server-wins preferences`),
  which pre-dates 09-09's own file set (`apps/control-plane/src/auth/*`, `apps/control-plane/src/
  services/change-account-password.ts`, `apps/control-plane/src/routes/account.ts`,
  `tests/integration/account/password.test.ts`, `tests/integration/activity/canary-account.test.ts`,
  `package.json`'s `security:scan-leaks` script, `apps/control-plane/src/logger.ts`) — confirmed via
  `git log --oneline -1 -- apps/web/src/lib/session-user.test.ts`. 8 boundary violations, all the
  same root cause (missing `@testing-library/react` devDependency entry in `apps/web/package.json`).
  Not fixed here per the scope-boundary rule (only auto-fix issues directly caused by the current
  task's own changes). Fix: add `@testing-library/react` to `apps/web/package.json`'s
  `devDependencies` (it is already installed transitively, per pnpm's lockfile, but not declared).

## Logged during 09-12 — pre-existing, NOT caused by this plan (confirmed via a clean `9a25fdc`
   worktree, fresh e2e stack, 3/3 deterministic failures on the unmodified baseline)

- **`tests/e2e/theme-first-paint.spec.ts`'s `@theme-first-paint no theme flash on reload for dark
  and light, on /login and on /servers after login` fails deterministically (`mutations: 1`,
  expected `0`) on a freshly seeded e2e stack, independent of any 09-12 change.** Root cause:
  `session-user.ts`'s D-10 "server wins" reconciliation (`bb44602 feat(09-10)`) runs on every page
  `Sidebar` mounts on (via `useSessionUser` -> the shared `ensureLoaded()` store, which always
  fetches `/api/account/preferences` too, regardless of which hook triggered it) — including
  `/servers`, which this test reloads after login. The test manufactures a `noodara-prefs` cookie
  (`dark.on.compact`) the E2E admin's real DB row was never actually given (no real
  `PATCH /api/account/preferences` ever ran for that value), so the mirror-vs-server mismatch D-10
  is designed to catch fires for real, `applyPreferences(server)` overwrites the cookie-driven
  `data-theme` back to the server's true default (`auto`), and the `MutationObserver` this test
  installs correctly records that as a mutation. This is a genuine product/test mismatch introduced
  by 09-10 (this spec file was last touched in 09-07, before D-10 existed) — not something 09-12
  touches (`session-user.ts` and `theme-first-paint.spec.ts` are both outside this plan's
  `files_modified`). Confirmed pre-existing by running the identical test against the unmodified
  `9a25fdc` commit in a separate git worktree with a brand-new e2e stack: 3/3 failures, same
  `mutations: 1` symptom. Not fixed here per the scope-boundary rule. Fix (future plan): either the
  test should drive the cookie through a real `PATCH` first (so server and mirror agree before the
  no-flash assertion), or D-10's reconciliation should skip the write when the only observed
  divergence is "cookie says an explicit value the server has never been told," to avoid a false
  "flash" on any page a freshly-cookied browser visits before ever opening `/settings`.
