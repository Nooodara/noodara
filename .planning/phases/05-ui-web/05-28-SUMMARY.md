---
phase: 05-ui-web
plan: 28
subsystem: ui
tags: [nextjs, fetch, abortsignal, clipboard, localstorage, error-boundary, playwright, dod-hardening]

# Dependency graph
requires:
  - phase: 05-ui-web
    provides: api-client.ts's performRequest choke point, CopyButton.tsx, first-trust.ts's StorageLike seam, the (shell) route group layout (all from earlier 05-ui-web plans)
provides:
  - "apps/web/src/lib/api-client.ts: every fetch bounded by AbortSignal.timeout(API_REQUEST_TIMEOUT_MS), composed with any caller signal via AbortSignal.any, abort mapped to the existing NETWORK_ERROR shape"
  - "packages/ui/src/CopyButton.tsx: feature-detected clipboard access, no unguarded navigator.clipboard.writeText call"
  - "apps/web/src/lib/safe-storage.ts: safeLocalStorage(), a Storage-shaped accessor that never throws"
  - "apps/web/src/app/(shell)/error.tsx: the (shell) segment's App Router error boundary"
  - "tests/e2e/dod-hardening.spec.ts: real-browser coverage for the insecure-context clipboard case; localStorage case fixme'd, handed to 05-29"
affects: [05-29 (must wire safeLocalStorage into servers/[id]/page.tsx and un-fixme the localStorage E2E case), 05-30 (owns error-copy.ts, not touched here), 05-VERIFICATION.md gap 4]

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "AbortSignal.timeout + AbortSignal.any composed in the one fetch choke point, never per-call-site timeouts"
    - "Feature-detect a DOM API via an explicit `as Type | undefined` cast when the lib.dom.d.ts type is more optimistic than an insecure-context runtime"
    - "safeLocalStorage(): try/catch around both the localStorage accessor and each operation, degrading to null/no-op rather than throwing"

key-files:
  created:
    - apps/web/src/lib/safe-storage.ts
    - apps/web/src/lib/safe-storage.test.ts
    - "apps/web/src/app/(shell)/error.tsx"
    - tests/e2e/dod-hardening.spec.ts
  modified:
    - apps/web/src/lib/api-client.ts
    - apps/web/src/lib/api-client.test.ts
    - packages/ui/src/CopyButton.tsx
    - packages/ui/src/CopyButton.test.tsx

key-decisions:
  - "API_REQUEST_TIMEOUT_MS = 15000: sized for the slowest real call the UI makes (GET /api/servers against a cold control plane) while staying well under any human patience threshold"
  - "AbortSignal.timeout does not respect vi.useFakeTimers() in this repo's Node/Vitest combo (verified empirically) -- both timeout tests spy on AbortSignal.timeout and drive an AbortController the test owns, instead of advancing fake time"
  - "safeLocalStorage exports getItem/setItem/removeItem (Pick<Storage, ...>), a structural superset of first-trust.ts's own StorageLike (getItem/setItem only) -- passes without a cast"
  - "error.tsx composed from EmptyState (title/body/one action), not Banner -- matches the plan's 'title, one sentence, one action' language for a whole-screen state, mirroring ServerList.tsx's own precedent for the narrower in-page Banner case"

patterns-established:
  - "A fetch-mock stand-in that only settles when its own signal aborts (hungFetchHonoringAbort) is the correct way to unit-test AbortSignal wiring without waiting out real wall-clock time"

requirements-completed: [UI-01, UI-02, SET-01]

# Metrics
duration: 28min
completed: 2026-09-20
---

# Phase 05 Plan 28: DoD Hardening (timeout, clipboard, storage, error boundary) Summary

**api-client's fetch wrapper gained a 15s AbortSignal.timeout, CopyButton feature-detects the clipboard instead of throwing on an insecure origin, and a new safeLocalStorage() + (shell)/error.tsx close the remaining two Definition-of-Done gaps from 05-VERIFICATION.md gap 4.**

## Performance

- **Duration:** ~28 min
- **Started:** 2026-09-20T16:19:00Z (approx, following 05-27's completion)
- **Completed:** 2026-09-20T16:37:00Z
- **Tasks:** 3
- **Files modified:** 8 (4 created, 4 modified)

## Accomplishments

- Every request `apiGet`/`apiSend` makes is now bounded by `AbortSignal.timeout(API_REQUEST_TIMEOUT_MS)` (15000ms), composed with any caller-supplied signal via `AbortSignal.any` so a future caller's own signal is never silently discarded. A timed-out or aborted request resolves to the existing `NETWORK_ERROR` shape — never an `AbortError` message, never a hang.
- `CopyButton.tsx` no longer dereferences `navigator.clipboard.writeText` unguarded — a missing Clipboard API (Noodara's own plain-HTTP v0.1 target) is feature-detected and swallowed silently, matching the behavior its own doc comment had incorrectly claimed for over a plan cycle.
- `apps/web/src/lib/safe-storage.ts` adds `safeLocalStorage()`, a `Storage`-shaped accessor that never throws regardless of *why* `localStorage` is unavailable (no `window`, a blocked-storage accessor throwing `SecurityError`, or `setItem` throwing on a full quota) — structurally assignable to `first-trust.ts`'s existing `StorageLike` parameter with no cast and no widening to `any`.
- `apps/web/src/app/(shell)/error.tsx` gives the authenticated shell a real App Router error boundary: a calm `EmptyState` (title, one sentence, one "Try again" action wired to `reset()`), never `error.message`/`stack`/`digest`.
- `tests/e2e/dod-hardening.spec.ts` proves the clipboard case in a real browser with `navigator.clipboard` removed via `page.addInitScript`; the localStorage case is `test.fixme`, explicitly handed to plan 05-29 (which owns the detail page's `window.localStorage` call site).

## Task Commits

1. **Task 1: Explicit request timeout in the one fetch wrapper** — `f284487` (feat)
2. **Task 2: Clipboard feature detection and the safe storage accessor** — `abe2b78` (fix)
3. **Task 3: Shell error boundary + E2E for the two environment conditions** — `9fa7191` (feat, also carries lint/type fixes surfaced by the full workspace build — see Deviations)

_TDD note: all three tasks followed RED → GREEN in a single commit per task (this plan's own convention, matching the "acceptable to have one commit per full cycle" allowance in the TDD skill) — see "RED evidence" below for each._

## RED Evidence

- **Task 1:** Before the fix, `pnpm exec vitest run apps/web/src/lib/api-client.test.ts` failed both new timeout tests with clean assertion failures (`expected 'timed-out' not to be 'timed-out'` and `expected undefined to be defined`), each bounded to a real ~2s guard rather than hanging — confirmed the fetch wrapper genuinely had no timeout.
- **Task 2 (CopyButton):** Before the fix, clicking the button with `navigator.clipboard` deleted threw an uncaught `TypeError: Cannot read properties of undefined (reading 'writeText')` from `handleClick` — Vitest reported it as an "Unhandled Errors" / "Uncaught Exception", exactly the synchronous throw the plan's objective described (the doc comment's prior claim that this case was already handled was false).
- **Task 2 (safe-storage):** Before the file existed, `pnpm exec vitest run apps/web/src/lib/safe-storage.test.ts` failed the whole suite with `Error: Cannot find module './safe-storage'`.
- **Task 3:** `error.tsx` and the E2E spec are new files with no pre-existing broken behavior to reproduce a RED against at the unit level; the RED evidence for *why* this task exists is Task 1/2's own RED findings plus 05-VERIFICATION.md's independently re-verified finding that no `error.tsx` existed anywhere under `apps/web/src/app` (`find apps/web/src/app -name error.tsx` returned nothing before this task).

## Files Created/Modified

- `apps/web/src/lib/api-client.ts` — `API_REQUEST_TIMEOUT_MS` export + `composeSignal()` wiring `AbortSignal.timeout`/`AbortSignal.any` into `performRequest`.
- `apps/web/src/lib/api-client.test.ts` — two new timeout tests (spy-based, see Decisions) + a budget-value test; `fetchMock`'s type instantiated to `typeof fetch` explicitly (see Deviations).
- `packages/ui/src/CopyButton.tsx` — `handleClick` feature-detects `navigator.clipboard?.writeText` via an explicit `Clipboard | undefined` cast before calling it.
- `packages/ui/src/CopyButton.test.tsx` — new test: clicking with `navigator.clipboard` deleted neither throws, confirms, nor logs.
- `apps/web/src/lib/safe-storage.ts` (new) — `safeLocalStorage()`.
- `apps/web/src/lib/safe-storage.test.ts` (new) — three unavailability modes + a structural-assignability compile check.
- `apps/web/src/app/(shell)/error.tsx` (new) — the shell's App Router error boundary.
- `tests/e2e/dod-hardening.spec.ts` (new) — real-browser clipboard case + fixme'd localStorage case.

## Decisions Made

- `API_REQUEST_TIMEOUT_MS = 15000` — sized for the slowest real call the UI makes (`GET /api/servers` against a cold control plane) while staying under any human patience threshold; documented in a comment in `api-client.ts`.
- `AbortSignal.timeout` does **not** respect `vi.useFakeTimers()` on this repo's Node 24 / Vitest 5 combo — verified empirically by spiking multiple durations (1000ms happened to "pass" by coincidentally racing two *real* timers of equal length; 1500ms+ consistently failed). Both timeout tests therefore spy on `AbortSignal.timeout` directly and drive an `AbortController` the test owns, simulating "the budget elapsed" deterministically and instantly rather than waiting out real or fake time.
- `safeLocalStorage()` returns `Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>` (all three, matching the plan's literal type signature) even though `first-trust.ts`'s own `StorageLike` only requires `getItem`/`setItem` — the wider shape is a structural superset and passes without a cast or widening.
- `error.tsx` is composed from `EmptyState` (title + body + one action) rather than `Banner` (message + optional action) — `EmptyState`'s shape matches the plan's own "title, one sentence, one action" language for a whole-screen state; `Banner` remains the narrower in-page pattern `ServerList.tsx` already uses for its own error state.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] `api-client.test.ts`'s `fetchMock` type was silently widened by an uninstantiated generic**
- **Found during:** Task 3's full-workspace `pnpm build` (Next.js's own stricter TypeScript pass caught what a scoped `tsc --noEmit -p .` run had, at that point, already caught too, once re-run after the fix below).
- **Issue:** `let fetchMock: ReturnType<typeof vi.fn>;` (no explicit type argument) resolves `vi.fn`'s generic `T` to its full constraint `Procedure | Constructable`, not the `Procedure` default. This made `mockImplementationOnce`'s parameter type a union that includes a `void`-returning construct-signature member, which trips `@typescript-eslint/no-misused-promises` the moment a Promise-returning implementation (needed for the two new timeout tests) is passed to it, and separately let the mock's first parameter narrow to a bare `string` instead of `string | URL | Request` (real `fetch`'s actual type), which `next build`'s TypeScript pass rejected.
- **Fix:** Instantiated the generic explicitly (`vi.fn<typeof fetch>()`), and widened the two new fetch-stand-in function signatures to `(input: string | URL | Request, init?: RequestInit)`.
- **Files modified:** `apps/web/src/lib/api-client.test.ts`
- **Verification:** `pnpm --filter @noodara/web exec tsc --noEmit -p .`, `pnpm turbo run lint --filter=@noodara/web`, and `pnpm exec vitest run apps/web/src/lib/api-client.test.ts` all clean; `pnpm build` (via the E2E run) completed successfully afterward.
- **Committed in:** `9fa7191` (Task 3 commit)

**2. [Rule 1 - Bug] `CopyButton.tsx`'s feature-detection needed a type cast to satisfy strict lint**
- **Found during:** Task 2, `pnpm turbo run lint --filter=@noodara/ui`.
- **Issue:** `lib.dom.d.ts` declares `Navigator.clipboard` as always-present (`Clipboard`, not optional), so `navigator.clipboard?.writeText` read into a local variable tripped both `@typescript-eslint/no-unnecessary-condition` (the optional chain looks pointless to `tsc`'s type view) and `@typescript-eslint/unbound-method` (extracting a method reference as a standalone value).
- **Fix:** Cast `navigator.clipboard as Clipboard | undefined` to make the type honestly reflect insecure-context reality, and kept the feature-detection check (`typeof clipboard?.writeText !== 'function'`) without ever extracting the method itself as a bound-losing variable — the eventual call is `clipboard.writeText(value)`, directly on the object.
- **Files modified:** `packages/ui/src/CopyButton.tsx`
- **Verification:** `pnpm turbo run lint --filter=@noodara/ui` clean; `pnpm exec vitest run packages/ui/src/CopyButton.test.tsx` (7/7 pass); `pnpm check:ui-safety` clean.
- **Committed in:** `abe2b78` (Task 2 commit, discovered and fixed within the same task before commit)

**3. [Rule 1 - Bug] `safe-storage.test.ts`'s quota-exceeded test used a dynamic `delete`**
- **Found during:** Task 2, `pnpm turbo run lint --filter=@noodara/web`.
- **Issue:** `delete writes[key]` on a `Record<string, string>` with a dynamic key trips `@typescript-eslint/no-dynamic-delete`.
- **Fix:** Switched the in-memory fixture from a plain object to a `Map<string, string>` (`writes.delete(key)`).
- **Files modified:** `apps/web/src/lib/safe-storage.test.ts`
- **Verification:** `pnpm turbo run lint --filter=@noodara/web` clean; test still passes.
- **Committed in:** `abe2b78` (Task 2 commit, discovered and fixed within the same task before commit)

---

**Total deviations:** 3 auto-fixed (all Rule 1 — bugs/lint errors introduced by this plan's own new test/component code, fixed inline before each task's commit or, for deviation 1, before Task 3's commit once the full-workspace build surfaced it).
**Impact on plan:** All three are typing/lint corrections with no behavior change to what Tasks 1–2 already implemented and verified. No scope creep — no file outside the plan's `files_modified` list was touched.

## Issues Encountered

- `AbortSignal.timeout` does not respect `vi.useFakeTimers()` in this repo's Node 24/Vitest 5 environment. Spent time spiking several durations (1000/1500/2000/5000/15000ms) before confirming this empirically and redesigning the two timeout tests around spying on `AbortSignal.timeout` itself plus a test-owned `AbortController`, rather than advancing virtual time. This is documented in both the test file's own comment and in `key-decisions` above so a future test in this codebase doesn't repeat the investigation.
- The full-workspace `pnpm build` (triggered indirectly by running the new Playwright E2E spec, whose `globalSetup` builds the whole monorepo before booting the real stack) surfaced two lint/type issues that a scoped `pnpm --filter @noodara/web exec tsc --noEmit -p .` run, taken in isolation right after editing, had NOT yet caught (I had not re-run it after the `fetchMock` type change) — see Deviation 1. Running `pnpm lint && pnpm typecheck && pnpm test` at the plan's own verification step (after all three tasks) confirmed everything is clean.

## User Setup Required

None — no external service configuration required.

## Next Phase Readiness

- Plan 05-29 can now import `safeLocalStorage` from `apps/web/src/lib/safe-storage.ts` and swap it into `servers/[id]/page.tsx`'s `shouldShowFirstTrustNotice(window.localStorage, ...)` call site — the seam (`first-trust.ts`'s `StorageLike` parameter) already accepts it with no cast.
- `tests/e2e/dod-hardening.spec.ts`'s `test.fixme` localStorage case names 05-29 explicitly in its own comment; un-fixme-ing it (and seeing it pass) is an explicit acceptance criterion for that plan, not something to delete.
- Plan 05-30 (owns `error-copy.ts`) is unaffected — `error.tsx` deliberately hardcodes its one sentence rather than touching that file, per this plan's own constraint.
- No blockers for the remaining gap-closure plans in this wave.

---
*Phase: 05-ui-web*
*Completed: 2026-09-20*

## Self-Check: PASSED

All 6 created/modified files confirmed present on disk; all 3 task commits (`f284487`, `abe2b78`, `9fa7191`) confirmed present in `git log`.
