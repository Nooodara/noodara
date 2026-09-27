# Phase 9: Settings editables - Deferred Items

## Pre-existing failure found during 09-08 verification (out of scope, not fixed)

- **`tests/e2e/canary-ui.spec.ts` (`pnpm security:scan-leaks`)**: the setup-token canary leaks
  into the rendered `/setup?token=...` HTML because `apps/web/src/app/setup/page.tsx` echoes the
  `token` query param straight into the `Token` input's `value` attribute. Last touched by
  `88d185f fix(05-30): distinguish setup failures and strip token from URL` (phase 05), not by
  09-08's work (preferences service/cookie/routes only). Confirmed pre-existing by `git log` on
  the file before this plan's own commits. Not auto-fixed per the scope-boundary rule (only
  auto-fix issues directly caused by the current task's changes) -- needs its own fix (likely:
  strip the token from the rendered input value the same way `88d185f` already stripped it from
  the URL/history, or mask it) in a follow-up plan or a dedicated fix task.
