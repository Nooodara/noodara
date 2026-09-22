---
phase: 05-ui-web
plan: 17
subsystem: ui
tags: [nextjs, react, radix-ui, ssh, credentials, tdd, e2e, security, tailwind-v4]

# Dependency graph
requires:
  - phase: 05-ui-web
    provides: "05-13's servers list screen/ServerRow (Edit/Delete no-ops this plan replaces), 05-23's FileButton/Sheet/DestructiveConfirmDialog/isConfirmationMatch, 05-11's error-copy.ts (copyForErrorCode/fieldForErrorCode/fieldErrorsFromIssues), 05-08's Field/Input/Textarea, apps/control-plane's CreateServerBodySchema/UpdateServerBodySchema/WireCredentialSchema"
provides:
  - "apps/web/src/lib/server-form.ts: buildCreateBody/buildUpdateBody/validateServerForm -- the pure, strict-schema-safe form-state to request-body builder every credential branch and optional field passes through explicit key assignment, never a whole-state spread"
  - "apps/web/src/components/CredentialFields.tsx: the D-04 credential block (SegmentedControl default Private key, mono Textarea + Choose file, passphrase, edit-mode dots+Replace), proven leak-free by both a component test and an E2E spec"
  - "apps/web/src/components/ServerSheet.tsx: the add/edit sheet -- D-01's Save and connect / Save without connecting / edit-only Save, inline field errors, a toast for non-field failures"
  - "apps/web/src/components/DeleteServerDialog.tsx: the type-the-name delete confirmation wired to DELETE /api/servers/:id"
  - "apps/web/src/app/(shell)/servers/page.tsx + ServerList.tsx + ServerRow.tsx: the toolbar's Add server action and each row's Edit/Delete menu items now open real UI instead of Plan 05-13's no-ops"
  - "packages/ui/src/FileButton.tsx: a 64KB max-file-size rejection before any read, closing 05-UI-SPEC.md SS10's file-load boundary"
  - "packages/ui/src/Sheet.tsx + apps/web/src/app/globals.css: two real, previously-latent bugs found and fixed (see Deviations) -- every future apps/web screen rendering a Sheet-shaped or otherwise packages/ui-unique-class component inherits both fixes"
affects: [05-18 (discovery checklist, mounts inside the server detail page this plan's sheet links to), 05-19 (trust-new-fingerprint dialog, built on the same DestructiveConfirmDialog pattern DeleteServerDialog establishes), 05-20 (critical-path E2E now has a real add/edit/delete flow to exercise), 05-21 (noodara-ux-review audit)]

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "CredentialFields owns its own local useState for every credential value (type/privateKey/passphrase/password) and reports the current CredentialFormValue to its parent via onChange on every change, rather than being a purely parent-controlled input -- this makes 'state cleared on unmount' a property of ordinary React unmounting, not something the component or its tests have to engineer separately, and it is what the plan's own 'unmount and remount renders empty fields' behaviour actually verifies"
    - "server-form.ts's WireCredential/CreateServerBody/UpdateServerBody are hand-typed to match apps/control-plane/src/routes/server-schemas.ts's Zod schemas exactly, never imported from there -- apps/web must never depend on a control-plane-internal module in the browser bundle, the same rule api-client.ts's ApiErrorCode/ServerView hand-copy already established"
    - "Every optional request-body field (sshPort, sshUser, passphrase, credential on update) is included via a conditional spread keyed on a named boolean/comparison, never a bare ...form or ...state -- the plan's own acceptance-criteria grep for that pattern passes by construction, not by discipline alone"
    - "ServerSheet's client-side validateServerForm errors are computed fresh from a small clientErrors() wrapper that drops the credential requirement entirely when editing without Replace -- a credential is never 'missing' just because the user chose not to touch it"
  patterns-established: []

key-files:
  created:
    - apps/web/src/lib/server-form.ts
    - apps/web/src/lib/server-form.test.ts
    - apps/web/src/components/CredentialFields.tsx
    - apps/web/src/components/CredentialFields.test.tsx
    - apps/web/src/components/ServerSheet.tsx
    - apps/web/src/components/DeleteServerDialog.tsx
    - tests/e2e/server-sheet.spec.ts
  modified:
    - apps/web/src/app/(shell)/servers/page.tsx
    - apps/web/src/components/ServerList.tsx
    - apps/web/src/components/ServerList.test.tsx
    - apps/web/src/components/ServerRow.tsx
    - packages/ui/src/Sheet.tsx
    - packages/ui/src/FileButton.tsx
    - packages/ui/src/FileButton.test.tsx
    - apps/web/src/app/globals.css

key-decisions:
  - "CredentialFields is uncontrolled (owns its own local state, reports out via onChange) rather than a controlled component the parent drives -- this is what makes the unmount-clears-state and no-cross-instance-leak claims true by construction rather than by careful parent-side resets"
  - "ServerSheet always renders (mounted) with `open` toggling, rather than the page conditionally mounting/unmounting it -- Radix's own Dialog.Content already unmounts the sheet's real content (including CredentialFields) when `open=false`, so the parent never needs a second mount/unmount mechanism; ServerSheet's own top-level formState is additionally reset on the open->false transition as defense in depth"
  - "The E2E spec generates a real, throwaway ed25519 key with the host's own ssh-keygen (matching packages/ssh/src/testing/generate-keys.ts's established precedent) rather than an obviously-fake string, because apps/control-plane/src/services/credential-store.ts's encodePrivateKey genuinely parses/validates a private key at registration time (@noodara/ssh's loadPrivateKey) -- a fake string is correctly rejected as INVALID_CREDENTIAL before a row ever exists, which the plan's own 'Choose file' and 'opening Edit' behaviours need not to happen"
  - "server-form.ts's WireCredential/CreateServerBody/UpdateServerBody are a second, hand-typed copy of server-schemas.ts's shapes (not imported), matching api-client.ts's own established apps/web-never-imports-control-plane-internals rule"

requirements-completed: [UI-02]

# Metrics
duration: ~55min
completed: 2026-09-19
---

# Phase 5 Plan 17: Add/Edit Server Sheet, Credential Block and Delete Dialog Summary

**D-01's "Save and connect" gesture and D-04's browser-only private-key file load, built on a strict-schema-safe pure body builder and proven leak-free by 9 real-browser `@sheet` E2E behaviours -- the seventh and final screen UI-02 required.**

## Performance

- **Duration:** ~55 min (commit span 14:24-15:12)
- **Started:** 2026-09-19T14:24:08-06:00
- **Completed:** 2026-09-19T15:11:48-06:00
- **Tasks:** 3 (Task 1 RED/GREEN; Task 2 RED/GREEN; Task 3 RED/GREEN plus two standalone deviation fixes and one closed test-coverage gap)
- **Files modified:** 15 (7 new, 8 modified)

## Accomplishments

- `apps/web/src/lib/server-form.ts`: `buildCreateBody`/`buildUpdateBody`/`validateServerForm`, all built by explicit key assignment with conditional spreads (`grep -cE "\.\.\.(form|state)\b"` is 0) -- `sshPort`/`sshUser`/`passphrase` omit entirely when blank rather than sending a default or empty string, a credential branch switch leaves zero residual keys from the other branch, `buildCreateBody`'s exact key set is asserted with `Object.keys(...).sort()`, and `buildUpdateBody` includes only genuinely changed fields plus `credential` only when Replace was used. `validateServerForm` reuses `@noodara/domain`'s own `validateSshPort` for the 1-65535 range check so the client rule can never drift from the server's. 18 Vitest cases, all green.
- `apps/web/src/components/CredentialFields.tsx`: the D-04 block -- `SegmentedControl` defaulting to Private key, a mono `Textarea` + `FileButton` ("Choose file") + optional passphrase `Input` in that branch, a single masked `Input` in the Password branch, `autoComplete="off"`/`spellCheck={false}`/`autoCapitalize="off"`/`autoCorrect="off"` on every credential-bearing input in both branches, and edit mode collapsing to a mono dots row plus "Replace" that only then renders the (always-empty) create-mode fields. Switching branches clears the other branch's own in-memory value as well as removing it from the DOM. 9 Vitest cases (RED then GREEN, all first-try passes), including the unmount/remount-renders-empty proof and the no-second-attribute-echo proof.
- `apps/web/src/components/ServerSheet.tsx`: create mode's primary "Save and connect" (`server-sheet-save-connect`) registers, best-effort connects, closes, and navigates to `/servers/:id`; the secondary "Save without connecting" registers and stays on the list with no navigation and no connect request; edit mode's single primary "Save" never connects; both modes carry a "Cancel" that discards all field state. `NAME_TAKEN`/`HOST_TAKEN`/`INVALID_CREDENTIAL` route to their fields via `error-copy.ts`'s `fieldForErrorCode`, with `{name}`/`{host}`/`{port}` substituted from the submitted values; any other failure (e.g. `SERVER_BUSY`) is a toast with the sheet staying open and input intact. `grep -c "jobId"` is 0 -- the connect response is never read.
- `apps/web/src/components/DeleteServerDialog.tsx`: `DestructiveConfirmDialog` wired to `DELETE /api/servers/:id`, surfacing a real `CONFIRMATION_MISMATCH` in the dialog's own error slot.
- `apps/web/src/app/(shell)/servers/page.tsx`/`ServerList.tsx`/`ServerRow.tsx`: the toolbar's "Add server", the empty state's own button, and each row's "Edit"/"Delete" menu items now open the real sheet/dialog instead of Plan 05-13's named no-ops.
- `tests/e2e/server-sheet.spec.ts`: 9 `@sheet` E2E behaviours against a real browser -- default selection and placeholders, a real client-side file read producing a JSON (never multipart) request with the key under `credential.privateKey`, Save-and-connect landing on the detail page, Save-without-connecting leaving a PENDING row with zero connect requests, `NAME_TAKEN` inline with input intact, a client-caught 70000 port never reaching the server, Edit's dots+Replace with zero key-text anywhere in the DOM, Delete's disabled-until-exact-match gate, and a full create/edit/cancel flow proven to leave no trace of the submitted key/password in `localStorage`/`sessionStorage`/the navigation URL.
- `pnpm test` (1292 tests), `pnpm lint`, `pnpm typecheck`, `pnpm boundaries`, `NOODARA_API_ORIGIN=... pnpm build`, `pnpm test:e2e` (55/55, all specs including this plan's 9 `@sheet`), and `NOODARA_API_ORIGIN=... pnpm security:scan-leaks` (3/3) are all green. No `noodara.test=true` container and no orphaned listener on 3000/3100 after any run.

## Security Item -> Test Mapping (sequential_execution's mandatory checklist)

| # | Item | Covered by |
|---|---|---|
| 1 | Credential lives only in local component state; cleared on submit/cancel/close/unmount | `CredentialFields.test.tsx`'s unmount/remount case (component-level); `server-sheet.spec.ts`'s final no-leak test (Cancel + storage/history scan, real browser) |
| 2 | Edit never pre-fills a credential | `CredentialFields.test.tsx`'s "no textbox until Replace, then empty fields"; `server-sheet.spec.ts`'s "opening Edit" test (dots+Replace, zero key text in `page.content()`) |
| 3a | `autoComplete="off"` on every credential input | `CredentialFields.test.tsx`, DOM-level query over `input, textarea` (not `getByRole('textbox')`, which silently excludes `type="password"`) |
| 3b | `spellCheck`/`autoCapitalize`/`autoCorrect` off | New `CredentialFields.test.tsx` case added this plan (closes a gap found during self-review; the attributes were already correct in the GREEN implementation) |
| 3c | Password input `type="password"`; no show-password toggle | `CredentialFields.test.tsx` asserts `type="password"` on the branch switch case; the absence of a toggle is by construction (never built), not independently tested |
| 4 | `FileReader.readAsText` only, never multipart; a sane max size before reading | `FileButton.test.tsx`'s existing no-leak/no-multipart-anywhere tests plus this plan's new 64KB-boundary RED->GREEN pair; `server-sheet.spec.ts`'s content-type assertion across every request in the create+file-load flow |
| 5 | Errors via `error-copy.ts`, never raw credential/server message; `INVALID_CREDENTIAL` keeps other fields | Implemented (`handleApiFailure` only ever renders `copyForErrorCode`/a pre-vetted `ApiFailure.message`); proven end to end for `NAME_TAKEN` (`server-sheet.spec.ts`); **not independently E2E-proven for `INVALID_CREDENTIAL`** specifically -- same `fieldForErrorCode` code path, not a distinct implementation, but no dedicated test submits a well-formed-but-server-rejected credential. Documented gap, not fixed in this plan. |
| 6 | Requests via `api-client.ts` (same-origin, timeouts); double-submit prevented | `apiSend`/`apiGet` are the only HTTP call sites (inherited, unchanged); `submitting` guard + `Button`'s `loading`-implies-`disabled` state prevent a second submit while one is in flight -- covered by construction, not a dedicated race-condition test |
| 7 | Delete via `DestructiveConfirmDialog`/`isConfirmationMatch`; real DELETE, no optimistic lie | `server-sheet.spec.ts`'s Delete test (disabled-until-match, then a real row removal after a real 200) |
| 8 | E2E fake creds; empty on reopen; HTML grep for the secret | `server-sheet.spec.ts`'s "opening Edit" (`page.content()` grep) and final no-leak test (storage + URL grep); every credential used in the spec is an obviously-fake, freshly-generated-per-run value |

## Task Commits

1. **Task 1 RED: failing server-form tests** - `f288b3f` (test)
2. **Task 1 GREEN: server-form pure body builder** - `c12b8d2` (feat)
3. **Task 2 RED: failing CredentialFields tests** - `02254b5` (test)
4. **Task 2 GREEN: sheet, credential block, delete dialog** - `c5d00fa` (feat)
5. **Task 3 RED: failing E2E coverage** - `6bf15eb` (test)
6. **[deviation fix] Sheet body scroll + apps/web Tailwind source scan** - `dba69d9` (fix)
7. **[deviation fix] no unconditional navigate, add Cancel** - `c3b6bdc` (fix)
8. **Task 3 GREEN: wire the list screen** - `aa19e83` (feat)
9. **[deviation] FileButton max-size RED** - `d44a2c5` (test)
10. **[deviation] FileButton max-size GREEN** - `8a7b8f8` (feat)
11. **[test-gap closure] spellcheck/autocapitalize/autocorrect assertions** - `ba199bd` (test)

## Files Created/Modified

- `apps/web/src/lib/server-form.ts` / `server-form.test.ts` - pure body builder + client validator
- `apps/web/src/components/CredentialFields.tsx` / `CredentialFields.test.tsx` - the D-04 credential block
- `apps/web/src/components/ServerSheet.tsx` - the add/edit sheet
- `apps/web/src/components/DeleteServerDialog.tsx` - the delete confirmation
- `apps/web/src/app/(shell)/servers/page.tsx` - real sheet/dialog state, replacing Plan 05-13's no-ops
- `apps/web/src/components/ServerList.tsx` / `ServerList.test.tsx` - `onEditServer`/`onDeleteServer` props replacing internal no-ops
- `apps/web/src/components/ServerRow.tsx` - doc-comment update only (props already required onEdit/onDelete)
- `packages/ui/src/Sheet.tsx` - `min-h-0` fix for real overflowing content
- `packages/ui/src/FileButton.tsx` / `FileButton.test.tsx` - 64KB max-size rejection
- `apps/web/src/app/globals.css` - `@source` directive for `packages/ui/src`
- `tests/e2e/server-sheet.spec.ts` - 9 `@sheet` E2E behaviours

## Decisions Made

See `key-decisions` in frontmatter -- summarized: `CredentialFields` is uncontrolled (own local state, reports via `onChange`) so the no-leak/unmount claims hold by construction; `ServerSheet` stays mounted with `open` toggling since `Sheet`'s own Radix `Content` already unmounts the real fields on close; the E2E spec generates a real throwaway ed25519 key via `ssh-keygen` because the backend genuinely validates key format at registration time; `server-form.ts`'s wire types are hand-copied, never imported from `apps/control-plane`.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] `Sheet.tsx`'s body never actually scrolled -- real overflowing content pushed the footer entirely off screen**
- **Found during:** Task 3, the first real E2E run against a real browser viewport (this plan is the first `apps/web` screen ever to render `Sheet` with enough content to overflow -- every prior `packages/ui` test used minimal fixtures)
- **Issue:** `BODY_CLASSES` was `flex-1 overflow-y-auto` with no `min-h-0`; a flex item's default `min-height: auto` let it grow to fit its content instead of being constrained by the panel's own height, so the segmented control, footer buttons, etc. rendered below the visible viewport with nothing to scroll (`overflow-y-auto` never activated). Every Playwright click on a control below the header timed out with "element is outside of the viewport" even at a 2000px-tall viewport, proving it was a real layout bug, not a scroll-target issue.
- **Fix:** Added `min-h-0` to `BODY_CLASSES`.
- **Files modified:** `packages/ui/src/Sheet.tsx`
- **Verification:** `getComputedStyle` on the sheet panel before/after showed `right`/`top`/`bottom` resolving to real `0px` and `width` to real `480px` only after the second fix below; `pnpm test packages/ui/src/Sheet.test.tsx` (5/5) unaffected; `pnpm test:e2e --grep @sheet` (9/9) after both fixes.
- **Committed in:** `dba69d9`

**2. [Rule 3 - Blocking] `apps/web`'s Tailwind v4 build never scanned `packages/ui/src` for utility classes**
- **Found during:** Task 3, the same E2E investigation -- `getComputedStyle` on the sheet panel showed `position: fixed` applied but `right`/`top`/`bottom`/`width` all resolving to auto/shrink-to-fit values (e.g. `width: 270.39px`, the segmented control's own natural width, not the intended `480px`)
- **Issue:** Tailwind v4's automatic source detection only scans downward from the stylesheet's own base path (`apps/web`) -- it never reaches a sibling workspace package. Every utility class `Sheet.tsx` uses that also happens to appear verbatim in some `apps/web` source file (`rounded-sm`, `border-hairline`, ...) was already present in the compiled CSS by coincidence; classes unique to `Sheet.tsx` (`w-[480px]`, `inset-y-0`, `data-[state=open]:translate-x-0`, `backdrop-saturate-[1.8]`, `rounded-l-lg`) were silently absent, since no `apps/web` source file had ever used them before. This is the first plan to render `Sheet` (or any `packages/ui` component with genuinely unique classes) inside a real `apps/web` page.
- **Fix:** Added `@source '../../../../packages/ui/src';` to `apps/web/src/app/globals.css`, per Tailwind v4's own documented `@source` directive for registering sources outside automatic detection (confirmed via Context7 docs).
- **Files modified:** `apps/web/src/app/globals.css`
- **Verification:** `getComputedStyle` after the fix showed `right: 0px`, `top: 0px`, `bottom: 0px`, `width: 480px` exactly; every subsequent `@sheet`/`@servers`/full `pnpm test:e2e` run green.
- **Committed in:** `dba69d9`

**3. [Rule 1 - Bug] "Save without connecting" always navigated to the detail page, and neither sheet mode had a Cancel button**
- **Found during:** Task 3's own E2E run, once the CSS fixes above let clicks actually land
- **Issue:** `ServerSheet.tsx`'s `handleSubmit`'s `router.push(...)` call sat outside the `if (connectAfter)` branch, so even the "Save without connecting" path navigated away -- contradicting 05-UI-SPEC.md SS2.4's own "registers and stays on the list". Separately, neither create nor edit mode rendered a "Cancel" button at all (05-UI-SPEC.md SS2.4 requires one in both modes; Task 2's own action text names it for create mode and edit mode both, and this plan's implementation had missed it in both).
- **Fix:** Moved `router.push`/the best-effort connect call inside `if (connectAfter)`; added a shared `cancelButton` (ghost, calls `onOpenChange(false)`) rendered in both modes' footers.
- **Files modified:** `apps/web/src/components/ServerSheet.tsx`
- **Verification:** `server-sheet.spec.ts`'s "Save without connecting" test (stays on `/servers`, zero connect requests) and the final no-leak test (uses the new Cancel button) both pass; `pnpm test:e2e` full suite green.
- **Committed in:** `c3b6bdc`

**4. [Rule 2 - Missing Critical] `FileButton` never enforced 05-UI-SPEC.md SS10/this plan's own mandatory max-file-size check**
- **Found during:** Self-review of the sequential_execution security checklist's item 4 ("enforce a sane max size before reading ... and reject with fixed copy") after Task 3's GREEN landed
- **Issue:** `FileButton.tsx` (a shared, already-shipped `packages/ui` component from Plan 05-23) read any selected file of any size directly into memory with no upper bound.
- **Fix:** Added a 64KB cap (private keys are a few KB even at RSA-4096) checked against `file.size` before `FileReader.readAsText` is ever called, rejecting with a fixed, non-leaking message via the existing `onError` callback.
- **Files modified:** `packages/ui/src/FileButton.tsx`, `FileButton.test.tsx` (RED then GREEN, 2 new cases: over-cap rejection, at-cap acceptance)
- **Verification:** `pnpm test packages/ui/src/FileButton.test.tsx` (10/10); `pnpm --filter @noodara/ui build/typecheck/lint` all green.
- **Committed in:** `d44a2c5` (RED), `8a7b8f8` (GREEN)

---

**Total deviations:** 4 auto-fixed (2 Rule 1 bugs in shared/already-shipped code first exercised for real by this plan, 1 Rule 1 bug in this plan's own new code, 1 Rule 2 missing-critical-security-item addition to shared code) -- plus 1 test-coverage gap closed (spellcheck/autocapitalize/autocorrect assertions, already-correct behaviour, no code change).
**Impact on plan:** The two `Sheet`/Tailwind fixes are the most significant findings of this plan -- without them, `Sheet` (and by extension every future screen that renders a `packages/ui` component with classes unique to that component) would silently render unstyled/unpositioned inside `apps/web`, a defect invisible to every prior `packages/ui`-only component test. Neither changed this plan's own scope; all four keep the plan's stated behaviour and security contract intact.

## Issues Encountered

The bulk of this plan's time went into diagnosing the `Sheet`/Tailwind issue (see Deviations 1-2) -- initial symptoms (Playwright's "element is outside of the viewport" on every click below the sheet's header) looked like a scroll-container bug, and only `getComputedStyle` inspection on the actual panel element revealed the real cause (missing Tailwind source registration, not a scroll bug at all, though the `min-h-0` fix was also independently real and necessary).

## User Setup Required

None -- no external service configuration required. No new packages were installed at any point in this plan.

## Next Phase Readiness

- **UI-02 is now Complete.** All seven screens the requirement names (setup, login, servers list, this plan's add/edit sheet, server detail, activity log, settings) exist, each with its own empty/loading/error handling, per the plan-by-plan `requirements-completed` trail: AUTH-01/AUTH-02 (05-11), SERV-04 (05-13), DETL-01/DETL-02 (05-14), ACT-02 (05-15), SET-01 (05-16), and this plan's own sheet/delete dialog.
- **SERV-01/SERV-02** (register/edit-with-credential-replace) were already marked Complete from Phase 3's backend service work; this plan is the UI consumer of that same contract, not a new completion of those IDs (the plan's own `requirements` frontmatter names only `UI-02`).
- `packages/ui/src/Sheet.tsx`'s `min-h-0` fix and `apps/web/src/app/globals.css`'s `@source` directive are now in place for every future plan (05-18 onward) that renders a `packages/ui` component with content that can overflow or with classes unique to that component -- neither class of bug needs rediscovery.
- The documented `INVALID_CREDENTIAL` E2E gap (see the mapping table) is a reasonable target for Plan 05-19 or 05-20's own critical-path spec, which already needs a real sshd fixture and could reuse it to submit a well-formed-but-rejected credential.
- `DeleteServerDialog.tsx` is the first real consumer of `DestructiveConfirmDialog` -- Plan 05-19's trust-new-fingerprint dialog (D-03, the same "type the name" friction) can follow this exact file's shape.

---
*Phase: 05-ui-web*
*Completed: 2026-09-19*

## Self-Check: PASSED

Verified on disk: `apps/web/src/lib/server-form.ts`, `server-form.test.ts`,
`apps/web/src/components/CredentialFields.tsx`, `CredentialFields.test.tsx`, `ServerSheet.tsx`,
`DeleteServerDialog.tsx`, `tests/e2e/server-sheet.spec.ts`,
`apps/web/src/app/(shell)/servers/page.tsx`, `apps/web/src/components/ServerList.tsx`,
`ServerList.test.tsx`, `ServerRow.tsx`, `packages/ui/src/Sheet.tsx`, `FileButton.tsx`,
`FileButton.test.tsx`, `apps/web/src/app/globals.css`. All eleven commits (`f288b3f`, `c12b8d2`,
`02254b5`, `c5d00fa`, `6bf15eb`, `dba69d9`, `c3b6bdc`, `aa19e83`, `d44a2c5`, `8a7b8f8`, `ba199bd`)
confirmed present in `git log --oneline --all`. `pnpm test` (1292 tests), `pnpm lint`,
`pnpm typecheck`, `pnpm boundaries`, `NOODARA_API_ORIGIN=http://127.0.0.1:3100 pnpm build`,
`pnpm test:e2e` (55/55, all specs), and
`NOODARA_API_ORIGIN=http://127.0.0.1:3100 pnpm security:scan-leaks` (3/3) all green, leaving no
`noodara.test=true` container and no orphaned listener on ports 3000/3100.
