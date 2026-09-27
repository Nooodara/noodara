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
