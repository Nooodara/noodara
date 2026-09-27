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
