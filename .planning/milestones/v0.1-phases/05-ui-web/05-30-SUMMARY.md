---
phase: 05-ui-web
plan: 30
subsystem: ui
tags: [zod, fastify-type-provider-zod, next.js, playwright, vitest, error-handling, security-headers]

# Dependency graph
requires:
  - phase: 05-ui-web
    provides: "error-copy.ts's ServiceErrorCode vocabulary and SS5.4 copy deck (05-11), the setup/login screens (05-11), the add/edit server sheet (05-17)"
provides:
  - "normalizeFieldPath in error-copy.ts, mapping the control plane's real AJV-shaped instancePath issue paths (/name, /credential/privateKey) to the form field keys the sheet and setup form actually render"
  - "setup/page.tsx's four-way failure branch (mappable field errors / admin-exists-or-unmappable-validation / network / everything else), replacing the single blanket invalid-link fallthrough"
  - "the one-time setup token stripped from the address bar/history right after mount"
  - "Referrer-Policy: no-referrer on every apps/web response"
  - "an E2E proving a server-rejected field renders highlighted in the add/edit sheet (05-VERIFICATION.md gap 5's literal requirement)"
affects: [05-31, 05-ui-web-verification]

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "normalizeFieldPath as the one place a raw backend instancePath is translated into a form field key, kept separate from the KNOWN_FORM_FIELD_PATHS allowlist so the allowlist stays a pure vocabulary of form keys"
    - "empirically probing @fastify/type-provider-zod's real validatorCompiler directly (a throwaway Node script against the real CreateServerBodySchema) instead of guessing the wire issue-path format"

key-files:
  created:
    - tests/e2e/setup.spec.ts
  modified:
    - apps/web/src/lib/error-copy.ts
    - apps/web/src/lib/error-copy.test.ts
    - apps/web/src/app/setup/page.tsx
    - apps/web/next.config.ts
    - tests/e2e/server-sheet.spec.ts

key-decisions:
  - "normalizeFieldPath collapses every /credential/* nested path (and the bare /credential root) onto the single 'credential' form key, since CredentialFields.tsx / ServerFormErrors render one shared inline error for the whole credential block, never a separate privateKey/passphrase/password field"
  - "KNOWN_FORM_FIELD_PATHS's pre-existing 'privateKey'/'passphrase' entries were dead (no ServerFormErrors field of that name exists) and were replaced by an explicit 'credential' entry rather than left in place, since the set's own stated invariant is 'every form-field key this UI can render' and those two entries violated it"
  - "setup/page.tsx treats only NOT_FOUND as the 'token-specific' code (the admin-exists gate) -- TOKEN_INVALID/ALREADY_USED/EXPIRED are not part of api-client.ts's known ServiceErrorCode vocabulary and are out of this plan's scope to add (api-client.ts is owned by a sibling plan, 05-28, this wave); they now decode to INTERNAL_ERROR and render that code's generic copy rather than the invalid-link message they got by accident under the old blanket-fallthrough bug (see Deviations)"
  - "Referrer-Policy is no-referrer, not same-origin -- strictest option, no legitimate cross-origin referrer use case in this app"
  - "the token-stripping effect uses window.history.replaceState directly, never router.replace -- a router-level navigation risked a re-render that could re-read the now-absent token query param"

requirements-completed: [UI-02, SET-01]

# Metrics
duration: ~35min
completed: 2026-09-20
---

# Phase 5 Plan 30: Field-error rendering and setup-token hardening Summary

**Backend field validation now renders inline (normalizeFieldPath maps real AJV instancePath issue paths to form keys), setup distinguishes a real 500/network failure from an expired link, the setup token no longer survives in the URL, and every response carries Referrer-Policy: no-referrer.**

## Performance

- **Duration:** ~35 min (research/probing + 3 tasks)
- **Started:** 2026-09-20T10:20:00-06:00 (approx, first Read calls)
- **Completed:** 2026-09-20T10:56:00-06:00
- **Tasks:** 3
- **Files modified:** 6 (1 created, 5 modified)

## Accomplishments

- Closed 05-VERIFICATION.md gap 5 (SC1/UI-02): the control plane's real issue-path format (`/name`, `/credential/privateKey`) is now correctly translated to the sheet's form field keys, proven end to end by a new E2E that stubs a real-shaped `VALIDATION_FAILED` response and asserts the field is actually highlighted (`aria-invalid="true"` + visible message) with no orphan generic banner.
- Setup screen no longer mislabels a genuine 500 or a network failure as "This setup link is no longer valid" — four distinct outcomes now exist (mappable field errors, the admin-exists gate, network unreachable, everything else).
- The one-time setup token is stripped from the address bar/history immediately after mount (`history.replaceState`), without blanking the pre-filled field, closing item 1 of the setup-token-url-hardening todo.
- `Referrer-Policy: no-referrer` ships on every `apps/web` response, closing item 2 of the same todo.
- Confirmed item 3 of the todo (no web-side log line includes the query string) by direct inspection: `apps/web/src` has zero `console.*`/logger calls, and `apps/web/src/proxy.ts` (the one server-side network hook) never logs a request URL.

## Task Commits

Each task was committed atomically:

1. **Task 1: Normalise issue paths so server-side field errors actually render** - `2e59eb2` (fix)
2. **Task 2: Three distinct setup failures, and the token out of the URL** - `88d185f` (fix)
3. **Task 3: Referrer-Policy header + the UI-02 sheet E2E the gap explicitly asks for** - `31e6502` (feat)

**Plan metadata:** (this commit, next)

_Note: each task followed RED → GREEN — see "RED evidence" below for the literal failing output observed before each fix._

## Files Created/Modified

- `apps/web/src/lib/error-copy.ts` - Adds `normalizeFieldPath`; `fieldErrorsFromIssues` now routes every issue through it instead of comparing the raw backend path against a bare-name allowlist
- `apps/web/src/lib/error-copy.test.ts` - New fixtures using the real observed `instancePath` literals (`/name`, `/credential/privateKey`, `/credential/passphrase`, `/credential/type`, `/credential`, `/`) plus a dedicated `normalizeFieldPath` describe block
- `apps/web/src/app/setup/page.tsx` - Mount-only token-stripping effect; four-way failure branch replacing the single blanket `INVALID_TOKEN_MESSAGE` fallthrough
- `apps/web/next.config.ts` - Adds `Referrer-Policy: no-referrer` to the existing `headers()` entry
- `tests/e2e/setup.spec.ts` - New file: Referrer-Policy header assertion, token-URL-stripping (with pre-fill survival across a failed submit), 500-not-invalid-link, network-failure-not-invalid-link, and mappable-VALIDATION_FAILED-renders-field-not-banner
- `tests/e2e/server-sheet.spec.ts` - New case: a real-shaped `/name` `VALIDATION_FAILED` issue highlights the Name field inline with no orphan banner

## Real backend issue-path literals (as required by hard_rules #8)

Obtained two ways, both confirmed identical: (1) reading `apps/control-plane/src/routes/http-errors.test.ts`'s own fixtures (`{ instancePath: '/name', message: 'Required' }`), and (2) empirically invoking the real `@fastify/type-provider-zod` `validatorCompiler` directly against the real `CreateServerBodySchema` (a throwaway Node script run from `apps/control-plane`, deleted after use — never committed) with a malformed payload:

```json
[
  { "instancePath": "/name", "message": "Too small: expected string to have >=1 characters" },
  { "instancePath": "/credential/privateKey", "message": "Too small: expected string to have >=1 characters" }
]
```

Additional probes against the same real validator confirmed:
- A missing `credential.type` discriminator → `instancePath: "/credential/type"` (`invalid_union`).
- A wholly missing `credential` object → `instancePath: "/credential"` (`invalid_type`).
- An unrecognized top-level key (`.strict()` violation) → `instancePath: "/"` (`unrecognized_keys`).

So: top-level fields are a single leading-slash segment (`/name`, `/host`, `/sshPort`, `/sshUser`, and for the setup form `/token`, `/email`, `/password`); the nested credential union is two segments or the bare `/credential` root; an unrecognized key at the root is literally `/`. `normalizeFieldPath` handles all of these.

## Decisions Made

- `normalizeFieldPath` collapses every `/credential/*` path onto the single `'credential'` form key (see key-decisions above) — verified with `CredentialFields.tsx` / `ServerFormErrors` (`server-form.ts`), which have exactly one shared inline error for the whole credential block, never a per-field one.
- Removed the dead `'privateKey'`/`'passphrase'` entries from `KNOWN_FORM_FIELD_PATHS` (no `ServerFormErrors` field of either name exists; they could never have been produced by any real caller) and added `'credential'` in their place — a Rule 1 fix, since the set's own comment claims to be "the full set of form-field paths any screen in this phase's forms can submit an issue against," which those two entries violated.
- `setup/page.tsx`'s four-way branch treats `NOT_FOUND` as the only "token-specific" code in `api-client.ts`'s known vocabulary. See Deviations below for the honest limitation this creates for `TOKEN_INVALID`/`ALREADY_USED`/`EXPIRED`.
- Token-URL stripping uses raw `history.replaceState`, not `router.replace`, to avoid a Next.js navigation re-render that could re-read the (now-stripped) `token` search param.
- `Referrer-Policy: no-referrer` (strictest option), not `same-origin`.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] Removed two dead entries from `KNOWN_FORM_FIELD_PATHS`, added `'credential'`**
- **Found during:** Task 1
- **Issue:** `'privateKey'`/`'passphrase'` were listed as allowlisted form-field keys but no such `ServerFormErrors` field exists (only a single `'credential'` field does) — these entries could never be produced by any real caller and violated the set's own documented invariant.
- **Fix:** Replaced both with `'credential'`.
- **Files modified:** `apps/web/src/lib/error-copy.ts`
- **Verification:** `apps/web/src/lib/error-copy.test.ts` asserts both `/credential/privateKey` and `/credential/passphrase` collapse onto `'credential'`; `pnpm test`, `pnpm exec playwright test tests/e2e/server-sheet.spec.ts` green.
- **Committed in:** `2e59eb2` (Task 1 commit)

### Known limitation (not a deviation — a documented scope boundary)

**`TOKEN_INVALID`/`ALREADY_USED`/`EXPIRED` are not distinguished from a genuine 500 on the setup screen.** The plan's own `<interfaces>` section explicitly forbids modifying `apps/web/src/lib/api-client.ts` in this wave (owned by sibling plan 05-28) and forbids adding a new `ServiceErrorCode`. `api-client.ts`'s `KNOWN_SERVICE_ERROR_CODES` set does not include these three real `setup-service.ts` codes, so they decode to `INTERNAL_ERROR` — indistinguishable, at the `ApiFailure` layer, from an actual unhandled server crash. Before this plan, a blanket-fallthrough bug happened to render all of these (correctly, if accidentally) as the friendly "This setup link is no longer valid" banner. After this plan's fix, they now render the generic "Something went wrong on our end" copy instead, since `INTERNAL_ERROR` (and any other unrecognised code) is handled uniformly and correctly for the case the gap actually named (a real 500 or a network failure). The only code this branch's `NOT_FOUND` special-case can safely catch is the admin-exists gate.

This is an honest trade-off, not silently accepted: distinguishing a genuinely bad/expired/used token from a real crash would require either extending `api-client.ts`'s vocabulary (out of scope: owned elsewhere this wave) or matching on the raw `message` string (rejected here as a fragile, undocumented heuristic outside this plan's explicit action list). **Recommend a follow-up todo:** extend `ApiErrorCode`/`KNOWN_SERVICE_ERROR_CODES` with `TOKEN_INVALID`/`ALREADY_USED`/`EXPIRED` (or a general recovery-token vocabulary, since `/api/recovery` shares the same codes) so `setup/page.tsx` can render its own dedicated copy for each.

---

**Total deviations:** 1 auto-fixed (Rule 1), 1 documented known limitation (not silently accepted).
**Impact on plan:** The auto-fix is necessary for `normalizeFieldPath`'s own correctness (the set must actually contain the key the function can produce). The known limitation does not regress the two concrete bugs 05-VERIFICATION.md's gap actually named (mislabelling a 500 and a network failure) — it is a pre-existing, now-explicit gap in a code path outside this plan's touchable scope.

## RED evidence (TDD, per task)

**Task 1** — `pnpm exec vitest run apps/web/src/lib/error-copy.test.ts` before the fix: **8 failed / 11 passed**, all 8 failing for the expected reason (bare-name comparison against real slash-prefixed paths never matches; `normalizeFieldPath is not a function`).

**Task 2** — `pnpm exec playwright test tests/e2e/setup.spec.ts` before the fix: **3 failed / 1 passed** (the 4th case, mappable-VALIDATION_FAILED, already passed because Task 1 landed first). The URL-strip case timed out waiting for `token=` to leave the URL; the 500 and network-failure cases both rendered the literal invalid-link banner instead of their own copy.

**Task 3 (Referrer-Policy)** — Temporarily removed the `Referrer-Policy` entry from `next.config.ts`, ran the new header-assertion test: **1 failed** (`received: undefined` for the `referrer-policy` response header). Restored the header, reran: green.

**Task 3 (sheet field highlight)** — Task 1 was already committed, so per the plan's own instruction, `apps/web/src/lib/error-copy.ts` and `error-copy.test.ts` were temporarily replaced with their pre-Task-1 (`a8d3a2e`) content, and the new server-sheet case was run in isolation: **1 failed** — `Name`'s `aria-invalid` stayed absent (`null`) instead of `"true"`, exactly reproducing gap 5. Both files were then restored via `git show`/`cp` back to the committed Task 1 state (`git diff` confirmed byte-identical to HEAD afterward, no `git checkout`/`git stash` used).

## Issues Encountered

None beyond the documented known limitation above.

## User Setup Required

None - no external service configuration required.

## Verification (plan's own `<verification>` block)

1. `pnpm lint && pnpm typecheck && pnpm test` — all exit 0 (lint: 9/9 tasks; typecheck: 8/8 tasks + `tests/e2e/tsconfig.json` + `tests/integration/ssh/tsconfig.json`; unit: 1408/1408 tests, 108/108 files).
2. `pnpm exec playwright test tests/e2e/setup.spec.ts tests/e2e/server-sheet.spec.ts` — 15/15 passed (5 in `setup.spec.ts`, 10 in `server-sheet.spec.ts`, including the pre-existing 9 with no regressions).
3. `git status` — no modified file under `apps/control-plane` or `apps/web/src/lib/api-client.ts` at any point in this plan.

`tests/e2e/auth.spec.ts` (existing setup/login coverage this plan did not modify) was also re-run to check for regressions: 6/6 passed.

## Setup-token-url-hardening todo disposition

`.planning/todos/pending/2026-09-19-setup-token-url-hardening.md` → moved to `.planning/todos/completed/2026-09-19-setup-token-url-hardening.md`. All three items closed:

1. Token stripped from the address bar/history after mount — closed (Task 2), proven by E2E.
2. `Referrer-Policy: no-referrer` sent — closed (Task 3), proven by E2E.
3. No web-side log line includes the query string — confirmed by inspection (zero `console.*`/logger calls anywhere in `apps/web/src`; `proxy.ts`, the one server-side network hook, never logs a request URL). No canary extension was needed since there is no logging code path to leak through.

## Next Phase Readiness

- Gap 5 (SC1/UI-02) is closed with real end-to-end proof against the actual backend wire shape.
- The setup-token-url-hardening todo is fully closed.
- Plan 05-31 (per the orchestrator's own note in this plan's `<hard_rules>`) will also edit `apps/web/src/lib/error-copy.ts` for the `TrustFingerprintDialog`/host-key work — no conflict expected, since this plan only added `normalizeFieldPath` and did not touch anything host-key-related.
- Known limitation carried forward: `TOKEN_INVALID`/`ALREADY_USED`/`EXPIRED` still render the generic 500 copy on `/setup`, not a token-specific one — flagged as a recommended follow-up todo above, not fixed here (blocked by this plan's explicit `api-client.ts`/control-plane scope boundary).

---
*Phase: 05-ui-web*
*Completed: 2026-09-20*

## Self-Check: PASSED

All 7 files referenced above (`error-copy.ts`, `error-copy.test.ts`, `setup/page.tsx`,
`next.config.ts`, `tests/e2e/setup.spec.ts`, `tests/e2e/server-sheet.spec.ts`, the moved todo)
confirmed present on disk. All 3 task commit hashes (`2e59eb2`, `88d185f`, `31e6502`) confirmed
present in `git log`.
