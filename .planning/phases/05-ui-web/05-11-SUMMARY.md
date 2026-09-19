---
phase: 05-ui-web
plan: 11
subsystem: ui
tags: [nextjs, react, better-auth, playwright, tdd, error-copy]

# Dependency graph
requires:
  - phase: 05-ui-web
    provides: "05-25's complete packages/ui component inventory (Button, Field, Input, Banner, Notice); 05-10's Playwright harness (tests/e2e/fixtures/stack.ts) and its three test.fixme login-dependent smoke assertions; 05-07's apps/web scaffold, api-client.ts (apiGet/apiSend) and root layout"
provides:
  - "apps/web/src/lib/error-copy.ts: the app-wide ServiceErrorCode/ServerErrorCode copy map (05-UI-SPEC.md SS5.1/SS5.4) plus fieldErrorsFromIssues/fieldForErrorCode/formatRetryAfterDuration -- the one source of user-facing error text every later screen plan reuses"
  - "apps/web/src/components/AuthCard.tsx: the shared 400px centered-card wrapper for both unauthenticated screens"
  - "apps/web/src/app/setup/page.tsx and apps/web/src/app/login/page.tsx: the two unauthenticated screens (AUTH-01/AUTH-02), each with loading/error states and zero oracle for account/token existence"
  - "tests/e2e/auth.spec.ts: six E2E behaviours covering both screens' empty/error/theme states"
  - "smoke.spec.ts's three login-dependent test.fixme assertions activated and passing for real"
  - "packages/ui/src/Button.tsx: data-testid pass-through, matching every other packages/ui component"
affects: [05-12 (authenticated shell composes AuthCard's sibling layout and needs /servers to actually exist), 05-13..05-21 (every later screen plan reuses error-copy.ts's copyForErrorCode/fieldErrorsFromIssues), 05-20 (the full critical-path E2E now has a real login step to build on)]

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "error-copy.ts's two exhaustive maps (SERVICE_ERROR_COPY, SERVER_ERROR_TEMPLATE) are declared 'as const satisfies Record<Code, string>' against imported unions, never a hand-typed copy or a switch/default -- a new ServiceErrorCode/ServerErrorCode is a compile-time error here, not a silent runtime fallback"
    - "ServiceErrorCode is api-client.ts's own ApiErrorCode minus NETWORK_ERROR (reused, not re-typed a third time); ServerErrorCode is imported directly from @noodara/domain/server (pure, already a dependency), matching packages/ui/src/tone.ts's existing precedent for importing domain unions instead of re-typing them -- apps/web never imports across the apps/control-plane boundary"
    - "Both unauthenticated screens are Client Components wrapped in <Suspense> (Next.js 16 requires this for any component calling useSearchParams, confirmed via Context7 docs for /vercel/next.js/v16.2.9 -- a production build fails with 'Missing Suspense boundary' otherwise)"
    - "Every relative import inside apps/web/src omits the .js extension (apps/web/tsconfig.json's own documented bundler-moduleResolution exception) -- error-copy.ts/error-copy.test.ts initially used the repo-wide nodenext .js convention, which typechecked and unit-tested fine but broke the real next build; fixed before this plan's own build verification passed"
    - "login/page.tsx's <form> carries noValidate: the browser's native HTML5 email-format bubble is unstyled and would otherwise intercept the submit event before this screen's own validateEmail-driven Field error ever runs -- setup/page.tsx deliberately keeps native constraints (required/minLength/maxLength/type=email) instead, since /api/setup's real failure codes (EMAIL_INVALID, PASSWORD_TOO_SHORT, ...) never carry a VALIDATION_FAILED issues[] array for fieldErrorsFromIssues to route"

key-files:
  created:
    - apps/web/src/lib/error-copy.ts
    - apps/web/src/lib/error-copy.test.ts
    - apps/web/src/components/AuthCard.tsx
    - apps/web/src/app/setup/page.tsx
    - apps/web/src/app/login/page.tsx
    - tests/e2e/auth.spec.ts
  modified:
    - tests/e2e/smoke.spec.ts
    - packages/ui/src/Button.tsx
    - packages/ui/src/Button.test.tsx

key-decisions:
  - "Login always redirects to /servers on success, never an originally-requested-path query parameter: apps/web/src/proxy.ts (out of this plan's files_modified, and the only place that could set such a parameter) does not currently set one, and this plan's own must_haves/truths and Task 3 acceptance criteria (exactly six E2E tests) name only 'lands on /servers' -- implementing an unreachable, untested redirect-target reader would have added a real open-redirect surface with no way to exercise or prove it safe. Deferred to whichever plan (likely 05-12) has proxy.ts in scope."
  - "Setup's per-field validation-error path (fieldErrorsFromIssues) is real but structurally unreachable today for weak-password/invalid-email: POST /api/setup's real failure codes (read directly from apps/control-plane/src/services/setup-service.ts and routes/setup.ts) are flat { error: CODE, message } bodies (TOKEN_INVALID, ALREADY_USED, EXPIRED, EMAIL_INVALID, PASSWORD_TOO_SHORT, ADMIN_EXISTS, ...), never VALIDATION_FAILED-with-issues[] except for a genuine Zod-schema-shape violation (e.g. an empty token bypassing the field's own required attribute). Every one of those flat codes is outside api-client.ts's known ServiceErrorCode vocabulary and decodes to the same generic INTERNAL_ERROR fallback -- so the screen renders the single opaque SS2.1 banner for all of them (correct per 05-CONTEXT.md's never-reveal-which-condition rule) and relies on native browser constraints (required/minLength/maxLength/type=email) for the common weak-password/malformed-email cases instead of a network round trip. Not a bug in this plan's own diff -- a pre-existing backend/UI-SPEC copy-deck mismatch, left unmodified since fixing it means touching setup-service.ts, outside this plan's scope."
  - "Better Auth's POST /api/auth/sign-in/email error body is { message, code } (better-call's own wire shape, confirmed by reading node_modules/better-call/dist/to-response.mjs), never this app's { error, message } D-16 vocabulary -- so login never renders ApiFailure.message for a 401/429; only the HTTP status (unauthorized flag, retryAfterSeconds derived from the Retry-After header) drives which of the two fixed banners renders."
  - "packages/ui/src/Button.tsx gained a 'data-testid'?: string | undefined prop (forwarded via the existing ...rest spread, zero body changes) -- every other packages/ui component (Banner, Notice, CopyButton, SegmentedControl, ...) already had this; Button was the one gap, discovered while wiring login-submit."

requirements-completed: []

# Metrics
duration: ~35min
completed: 2026-09-19
---

# Phase 5 Plan 11: Setup and Login Screens, Error-Copy Module Summary

**The two unauthenticated screens (AUTH-01 setup, AUTH-02 login) plus the app-wide error-copy module every later screen reuses -- both screens verified end to end in a real browser with zero oracle for account or setup-token existence.**

## Performance

- **Duration:** ~35 min
- **Completed:** 2026-09-19
- **Tasks:** 3 (Task 1 RED/GREEN; Tasks 2+3 combined RED/GREEN per the orchestrator's E2E-as-RED instruction, since the plan's own Task 3 behaviours are what prove Task 2's screens)
- **Files modified:** 9 (7 new, 2 modified) plus one standalone Button.tsx fix (2 files)

## Accomplishments

- `apps/web/src/lib/error-copy.ts`: `copyForErrorCode`/`copyForServerErrorCode` are exhaustive, `satisfies Record<...>`-checked lookups over the 15 `ServiceErrorCode`s (SS5.4) and 7 `ServerErrorCode`s (SS5.1) -- a new code added to either union anywhere in the app is a compile error here, never a silent fallback. `fieldErrorsFromIssues`/`fieldForErrorCode` implement SS2.4's per-field routing (NAME_TAKEN -> name, HOST_TAKEN -> host, INVALID_CREDENTIAL -> credential). `formatRetryAfterDuration(120)` renders `"in 2 minutes"`, never `"120"`. 12 Vitest cases across six behaviour groups, all green.
- `/setup` (AUTH-01): mono Token field pre-filled from `?token=`, Email, Password (help text states the 12-128 char policy, no strength meter). Redeems `POST /api/setup`; every token-related failure -- bad/expired/used/already-consumed token and the 404 that fires once an admin exists -- renders the identical SS2.1 banner text, with a code comment recording why distinguishing them would leak whether an admin already exists (T-5-46).
- `/login` (AUTH-02): Email/Password with `autoComplete="username"`/`"current-password"`, primary Button carrying `data-testid="login-submit"`. Posts to `/api/auth/sign-in/email`; a 401 always renders `"That email or password isn't right."` (T-5-45, asserted in E2E to never contain the submitted email or the words "no account"); a 429 renders the lockout banner with `Retry-After` formatted as a relative duration. On success, navigates to `/servers`.
- `tests/e2e/auth.spec.ts` (6 tests, all `@auth`-tagged) plus `smoke.spec.ts`'s three previously-`test.fixme`'d login assertions (now active, `@smoke`-tagged) -- 11/11 E2E tests pass against the real Playwright stack (Postgres, Redis, the API, the worker, the built web app).
- Genuine RED observed before GREEN: Task 1's `error-copy.test.ts` failed on `Cannot find module` before `error-copy.ts` existed; the combined Task 2+3 RED run showed 8/11 E2E tests failing (missing `/setup`/`/login` pages -- `getByLabel('Email')` timeouts, 404s) before the screens existed.
- `pnpm test` (1164 tests), `pnpm lint`, `pnpm typecheck`, `pnpm boundaries`, `pnpm build`, `node scripts/check-package-provenance.mjs` (28/28 OK, zero new packages) and `pnpm test:e2e` (11/11) are all green. No stray `noodara.test=true` container and no orphaned listener on ports 3000/3100 after any run.

## Task Commits

1. **[standalone fix] Button.tsx data-testid forwarding** - `e88dfd2` (fix)
2. **Task 1 RED: failing error-copy test** - `fa5d217` (test)
3. **Task 1 GREEN: error-copy module** - `1770ba8` (feat)
4. **Tasks 2+3 RED: failing E2E coverage for setup/login** - `e472e54` (test)
5. **Tasks 2+3 GREEN: setup and login screens** - `a8d3a2e` (feat)
6. **[fix] smoke.spec.ts fixme-grep false positive** - `919592e` (fix)

## Files Created/Modified

- `apps/web/src/lib/error-copy.ts` - `copyForErrorCode`, `copyForServerErrorCode`, `fieldErrorsFromIssues`, `fieldForErrorCode`, `formatRetryAfterDuration`
- `apps/web/src/lib/error-copy.test.ts` - 12 tests across six behaviour groups
- `apps/web/src/components/AuthCard.tsx` - shared 400px centered-card wrapper
- `apps/web/src/app/setup/page.tsx` - the setup screen
- `apps/web/src/app/login/page.tsx` - the login screen
- `tests/e2e/auth.spec.ts` - six `@auth` E2E behaviours
- `tests/e2e/smoke.spec.ts` - three login-dependent assertions activated
- `packages/ui/src/Button.tsx` / `Button.test.tsx` - `data-testid` pass-through

## Decisions Made

See `key-decisions` in frontmatter -- summarized: login always redirects to `/servers` (no originally-requested-path parameter, since `proxy.ts` doesn't set one and adding an unreachable, untested redirect-target reader would be a real open-redirect surface with no way to prove it safe); setup's per-field validation errors are real but structurally unreachable against the current backend (which returns flat, non-`issues[]` codes for weak-password/invalid-email), so native browser constraints cover those cases instead; Better Auth's `{ message, code }` error body is never rendered directly, only the HTTP status drives the two fixed login banners; `Button` gained `data-testid` forwarding to match every other `packages/ui` component.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 3 - Blocking] `packages/ui/src/Button.tsx` had no `data-testid` pass-through**
- **Found during:** Task 2 planning, wiring `login-submit`
- **Issue:** Every other `packages/ui` component (`Banner`, `Notice`, `CopyButton`, `SegmentedControl`, `Dialog`, `Disclosure`, ...) already declares `'data-testid'?: string`; `Button` -- the component this plan's own `login-submit`/`setup-submit` hooks need -- was the one gap. Passing `data-testid` to an untyped custom component prop fails TypeScript's excess-property check.
- **Fix:** Added `'data-testid'?: string | undefined` to `ButtonProps` (the `| undefined` required by `exactOptionalPropertyTypes`, matching `CopyButton`/`ThemeToggle`'s own already-`string | undefined`-typed forwarding call sites); no change to the component body since the existing `...rest` spread already forwards it.
- **Files modified:** `packages/ui/src/Button.tsx`, `packages/ui/src/Button.test.tsx` (added a forwarding test)
- **Verification:** `pnpm test packages/ui/src/Button.test.tsx` (13/13), `pnpm --filter @noodara/ui typecheck`/`lint` both clean.
- **Committed in:** `e88dfd2` (standalone fix commit, before Task 1)

**2. [Rule 1 - Bug] `error-copy.ts`/`error-copy.test.ts` used `.js`-suffixed relative imports, breaking the real `next build`**
- **Found during:** Tasks 2+3 GREEN, first `pnpm build` after the screens imported `error-copy.ts`
- **Issue:** `apps/web/tsconfig.json` documents an explicit, deliberate exception (`moduleResolution: "bundler"`, required by Next.js) under which relative imports must omit the `.js` extension -- the repo-wide `nodenext` convention every other package uses. Task 1's own files used `.js` suffixes (matching the rest of the monorepo), which typechecked and unit-tested fine (Vitest tolerates both forms) but Next.js's Turbopack build could not resolve `./api-client.js` to the sibling `.ts` source, failing with `Module not found`.
- **Fix:** Dropped `.js` from every relative import in `error-copy.ts`/`error-copy.test.ts`, and used extension-less imports from the start in every apps/web/src file this plan added (`AuthCard`, `setup/page.tsx`, `login/page.tsx`).
- **Files modified:** `apps/web/src/lib/error-copy.ts`, `apps/web/src/lib/error-copy.test.ts`
- **Verification:** `pnpm build` compiles `/login` and `/setup` as static routes with zero errors; `pnpm test`/`typecheck`/`lint` unaffected.
- **Committed in:** `a8d3a2e` (Tasks 2+3 GREEN commit)

**3. [Rule 1 - Bug] Login's native HTML5 email-format validation intercepted the submit event before the screen's own inline field error could render**
- **Found during:** Tasks 2+3 GREEN, the E2E run for "an invalid email on the login form renders an inline field error, not a banner"
- **Issue:** With `type="email"` and `required` on the Email input and no `noValidate` on the `<form>`, the browser's own native constraint-validation bubble blocked the submit event entirely before `handleSubmit`/`validateEmail` ever ran -- the test's expected Field error text never appeared (a real UX bug: this screen's design-system Field error is the intended validation UI, not an unstyled browser popup).
- **Fix:** Added `noValidate` to login's `<form>`, making `validateEmail` (the same domain validator the backend uses) the one source of truth for this screen's inline email error; `setup`'s form deliberately keeps native constraints since it has no equivalent client-side check to fall back on.
- **Files modified:** `apps/web/src/app/login/page.tsx`
- **Verification:** `pnpm test:e2e --grep @auth` -- the invalid-email test passes; the E2E snapshot confirms `Field`'s own `role="alert"` paragraph renders the expected text.
- **Committed in:** `a8d3a2e` (Tasks 2+3 GREEN commit)

**4. [Rule 1 - Bug] `smoke.spec.ts`'s own updated comment tripped this plan's `test.fixme` grep gate**
- **Found during:** Final plan-level verification pass, running the Task 3 acceptance-criteria grep commands
- **Issue:** The comment describing the history of the three activated assertions used the literal substring `` `test.fixme` `` to name what they used to be, which the acceptance criterion's `grep -c "test.fixme"` (intended to catch a leftover marker, not prose) matched as a false positive.
- **Fix:** Reworded the comment to describe the same history without the literal token (`` `test.fixme`d `` -> "marked expected-failing").
- **Files modified:** `tests/e2e/smoke.spec.ts`
- **Verification:** `grep -c "test.fixme" tests/e2e/smoke.spec.ts` reports `0`; `pnpm test:e2e` still 11/11.
- **Committed in:** `919592e` (standalone fix commit)

---

**Total deviations:** 4 auto-fixed (1 Rule 3 blocking gap in a shared component, 3 Rule 1 bugs -- an import-convention mismatch, a native-vs-custom-validation conflict, and a comment-vs-grep false positive)
**Impact on plan:** All four were necessary to make the plan's own stated verification commands (`pnpm build`, the Task 3 E2E suite, the Task 3 acceptance-criteria greps) actually pass; none changed the plan's scope, architecture, or intent.

## Issues Encountered

None beyond the auto-fixed deviations above.

## User Setup Required

None -- no external service configuration required. No new packages were installed; `node scripts/check-package-provenance.mjs` reports the same 28 previously-approved packages.

## Next Phase Readiness

- `/setup` and `/login` are real, E2E-verified screens. **UI-02 stays Pending in REQUIREMENTS.md** -- it requires all seven screens (setup, login, servers list, sheet, detail, activity log, settings); this plan builds 2 of 7. Matches the same plan-frontmatter-artifact pattern already flagged in STATE.md for SERV-06 (04-01) through every prior `packages/ui`-only plan this phase (05-06 through 05-25). Re-verify UI-02 once Plans 05-12 through 05-21 land the remaining five screens and the authenticated shell.
- `error-copy.ts`'s `copyForErrorCode`/`copyForServerErrorCode`/`fieldErrorsFromIssues`/`fieldForErrorCode` are the one place every later screen plan (05-13 onward) should source error text from -- no screen should invent its own copy for a `ServiceErrorCode`/`ServerErrorCode` this file already maps.
- `login/page.tsx`'s success path navigates to `/servers`, which does not exist yet (Plan 05-12) -- the URL updates correctly (Next.js client-side navigation), rendering the framework's default not-found page until 05-12 lands. `smoke.spec.ts`'s own "signing in ends on /servers" assertion only checks the URL, not the rendered content, so this is not a regression risk for that test.
- `AuthCard.tsx` is deliberately unauthenticated-screen-only (no shell); Plan 05-12's authenticated shell (sidebar/toolbar route-group layout) is a separate component this plan does not touch or anticipate beyond leaving `/servers`/`/login`/`/setup` reachable.
- Setup's per-field validation gap (see key-decisions) is worth revisiting if a future plan touches `setup-service.ts`/`routes/setup.ts` for another reason -- adding a `VALIDATION_FAILED`-with-`issues[]` path for `EMAIL_INVALID`/`PASSWORD_TOO_SHORT`/etc. would let this screen's already-built `fieldErrorsFromIssues` branch actually fire, but that is a backend change out of this plan's own scope.

---
*Phase: 05-ui-web*
*Completed: 2026-09-19*

## Self-Check: PASSED

Verified on disk: `apps/web/src/lib/error-copy.ts`, `error-copy.test.ts`,
`apps/web/src/components/AuthCard.tsx`, `apps/web/src/app/setup/page.tsx`,
`apps/web/src/app/login/page.tsx`, `tests/e2e/auth.spec.ts`, `tests/e2e/smoke.spec.ts`,
`packages/ui/src/Button.tsx`. All six commits (`e88dfd2`, `fa5d217`, `1770ba8`, `e472e54`,
`a8d3a2e`, `919592e`) confirmed present in `git log --oneline --all`. `pnpm test` (1164 tests),
`pnpm lint`, `pnpm typecheck`, `pnpm boundaries`, `NOODARA_API_ORIGIN=http://127.0.0.1:3100 pnpm build`,
`node scripts/check-package-provenance.mjs` (28/28 OK) and
`NOODARA_API_ORIGIN=http://127.0.0.1:3100 pnpm test:e2e` (11/11) all green, leaving no
`noodara.test=true` container and no orphaned listener on ports 3000/3100.
