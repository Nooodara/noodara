---
phase: 05-ui-web
plan: 23
subsystem: ui
tags: [react, radix-ui, vitest, jsdom, testing-library, tailwind-v4, design-tokens, tdd, accessibility, security]

# Dependency graph
requires:
  - phase: 05-ui-web
    provides: "05-08's Field/Input render-prop contract and no-value-duplication testing pattern, 05-22's Button data-variant/data-filled convention, 05-06's renderUi/userEvent jsdom component-test harness, and the seven Radix primitives (including dialog/visually-hidden) installed once for this phase"
provides:
  - "packages/ui/src/confirm-match.ts: isConfirmationMatch, the pure exact-match predicate every type-the-name destructive gate in the product shares"
  - "packages/ui/src/FileButton.tsx: the D-04 boundary where a private key first enters the product -- FileReader.readAsText into a caller callback only, proven by a component test that a selected file's text reaches neither storage nor any DOM attribute"
  - "packages/ui/src/Sheet.tsx: the 480px right-side panel on Radix Dialog every create/edit sheet in this phase builds on"
  - "packages/ui/src/Dialog.tsx: ConfirmDialog and DestructiveConfirmDialog -- the generic confirm and type-the-name destructive-confirm variants used for delete-server and trust-new-fingerprint (D-03)"
affects: [05-ui-web remaining screen plans (05-11/05-17 add/edit server sheet consumes FileButton+Sheet, delete/trust-fingerprint flows consume DestructiveConfirmDialog), 05-24/05-25 (Tooltip/Collapsible/ScrollArea/Checkbox, unaffected by this plan's files)]

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "A credential-adjacent component (FileButton) proves its no-leak contract with a real component test: select a File via userEvent.upload, then scan every localStorage/sessionStorage key and every rendered element's every attribute for the file's exact text -- the same no-value-duplication technique 05-08's Input/Textarea established, applied to a file-read path instead of a keystroke path"
    - "A read failure never surfaces the underlying FileReader error or the file's own contents -- FileButton.onerror always calls onError with one fixed generic sentence, asserted by mocking FileReader.prototype.readAsText to synchronously invoke the reader's own onerror handler rather than relying on jsdom's real (and much slower) file-read machinery for the failure path"
    - "Grep-gated absence checks (localStorage/sessionStorage/console./FormData/multipart in FileButton.tsx; onEscapeKeyDown/onInteractOutside/outline: none across packages/ui/src) apply to comments as well as code -- a doc comment that names the very APIs it says it never calls trips its own gate, so prose describing 'what this component does not do' has to avoid the literal forbidden substrings, not just the real API calls"
    - "DestructiveConfirmDialog's typed-name state is local and uncontrolled (useState, reset via a useEffect keyed on `open`), not a prop the caller drives -- isConfirmationMatch(requiredName, typed) is recomputed on every render from that local state, and onConfirm(typedValue) hands the exact typed string back to the caller for the API request body Task's own CONFIRMATION_MISMATCH check validates"
    - "aria-describedby={undefined} on Sheet's Dialog.Content is Radix's own documented escape hatch for 'this dialog genuinely has no separate Description beyond its Title and caller-composed body' -- confirmed against Radix Primitives' own source (DescriptionWarning only fires when aria-describedby resolves to an id with no matching element in the DOM, which an explicit undefined never produces) rather than assumed"

key-files:
  created:
    - packages/ui/src/confirm-match.ts
    - packages/ui/src/confirm-match.test.ts
    - packages/ui/src/FileButton.tsx
    - packages/ui/src/FileButton.test.tsx
    - packages/ui/src/Sheet.tsx
    - packages/ui/src/Sheet.test.tsx
    - packages/ui/src/Dialog.tsx
    - packages/ui/src/Dialog.test.tsx
  modified:
    - packages/ui/src/index.ts
    - packages/ui/package.json
    - pnpm-lock.yaml

key-decisions:
  - "lucide-react moved from packages/ui's devDependencies to dependencies -- it was installed (and provenance-approved) in Plan 05-08 as a devDependency, but Sheet.tsx is the first component to actually import it at runtime (the header's close-button X icon), so it needed to be a real runtime dependency, matching the same devDependency-to-dependency fix Plan 05-22 made for @noodara/domain"
  - "DialogShellProps's internal 'data-testid' field is typed `string | undefined` explicitly (not just `?: string`) -- exactOptionalPropertyTypes rejected passing a destructured-optional `string | undefined` local variable into a sibling component's own `data-testid?: string` prop (a real tsc error caught by this plan's own `pnpm build` verify step, not by lint), the same class of issue 05-08's Field.tsx worked around with conditional object spreads"
  - "DestructiveConfirmDialog's onConfirm signature is `(typedValue: string) => void`, not a no-arg callback -- the disabled-until-match gate already guarantees typedValue equals requiredName whenever it fires, but the caller (a later plan's delete/trust-fingerprint flow) needs the exact typed string to send in the API request body the server's own CONFIRMATION_MISMATCH check validates, so handing it back avoids the caller re-deriving or re-storing it separately"

requirements-completed: []

# Metrics
duration: ~20min
completed: 2026-09-19
---

# Phase 5 Plan 23: confirm-match, FileButton, Sheet and Dialog Summary

**Test-first isConfirmationMatch, FileButton (D-04's private-key-never-leaves-memory boundary), Sheet, and ConfirmDialog/DestructiveConfirmDialog (D-03's type-the-name gate) on top of Radix Dialog/VisuallyHidden, with every no-leak and disabled-until-match claim proven by a component test rather than a source grep.**

## Performance

- **Duration:** ~20 min
- **Started:** 2026-09-19T10:47:00Z
- **Completed:** 2026-09-19T10:52:07Z
- **Tasks:** 3 (each RED test committed separately from its GREEN implementation, per CLAUDE.md SS2.1)
- **Files modified:** 11 (8 new source/test files, index.ts, package.json, pnpm-lock.yaml)

## Accomplishments

- `packages/ui/src/confirm-match.ts` exports `isConfirmationMatch(required, typed)`: exact-equality with a non-empty-typed guard, documented as a UX pre-check only -- the API's own `CONFIRMATION_MISMATCH` stays the enforced source of truth, named in the file's own comment.
- `packages/ui/src/FileButton.tsx` is D-04's boundary: a ghost `Button` triggers a `@radix-ui/react-visually-hidden`-wrapped native file input, reads the selected file with `FileReader.readAsText`, and hands the result to the caller's `onText` callback -- proven by a component test that selects a real `File` via `userEvent.upload` and then scans every `localStorage`/`sessionStorage` key and every rendered element's every attribute for the file's exact text, finding it nowhere but the callback argument. A failing read (simulated by mocking `FileReader.prototype.readAsText`) invokes `onError` with one fixed generic sentence that contains neither the file's contents nor the raw `FileReader` error. Selecting the same file twice fires `onText` twice, proving the input's value is reset after every read.
- `packages/ui/src/Sheet.tsx` is a 480px right-side panel on Radix `Dialog`: `open={false}` renders nothing (content is genuinely absent from the document, not hidden), `open={true}` renders content inside a `role="dialog"` element whose accessible name is the `title` prop via the primitive's own `Title`, the caller's body/footer children compose freely, and the header's close button invokes `onOpenChange(false)` exactly once -- the component never manages `open` itself. No custom focus-trap, Esc, or outside-click handling exists anywhere in the file; a comment explicitly defers that verification to Plan 05-17's Playwright `@sheet` spec, since jsdom does not implement the layout/focus mechanics Radix's `FocusScope` depends on.
- `packages/ui/src/Dialog.tsx` exports `ConfirmDialog` (generic confirm/cancel, both wired through Radix `Title`/`Description`) and `DestructiveConfirmDialog` (adds a `requiredName`, a type-the-name `Input` wrapped in `Field`, and an optional `error` slot). The destructive confirm button starts `disabled`, becomes enabled only on the exact typed name (asserted as a three-step transition: disabled -> typed exactly -> enabled -> one backspace -> disabled again), stays disabled for a case-variant or whitespace-padded name, and carries `data-variant="destructive"`/`data-filled="true"` while Cancel always carries `data-variant="ghost"` -- a destructive-styled Cancel would fail the test. A supplied `error` string renders inside `Field`'s existing `role="alert"` slot, the same place the API's `CONFIRMATION_MISMATCH` message will land. The typed value is proven to appear in no DOM attribute other than the input's own `value`, mirroring 05-08's Input/Textarea no-duplication test technique.
- All four RED test files (`confirm-match.test.ts`, `FileButton.test.tsx`, `Sheet.test.tsx`, `Dialog.test.tsx`) were seen to fail for the correct reason (missing module, "Cannot find module"/"Failed to resolve import") before their GREEN implementation existed -- see RED Observations below.
- `pnpm test` (1032 tests, up from 1017 before this plan, zero regressions), `pnpm build` (including `apps/web`'s real Tailwind/Next.js pipeline), `pnpm lint`, `pnpm typecheck`, `pnpm boundaries` and `node scripts/check-package-provenance.mjs` are all green. Every grep gate this plan's acceptance criteria names reports 0: `localStorage|sessionStorage|console\.|FormData|multipart` in `FileButton.tsx`; `onEscapeKeyDown|onInteractOutside|outline: *none` across all of `packages/ui/src`.

## Task Commits

1. **Task 1 RED: failing confirm-match and FileButton tests** - `87d547b` (test)
2. **Task 1 GREEN: isConfirmationMatch and FileButton** - `9a2636d` (feat)
3. **Task 2 RED: failing Sheet test** - `f52b95a` (test)
4. **Task 2 GREEN: Sheet on Radix Dialog** - `e4d8cd6` (feat)
5. **Task 3 RED: failing ConfirmDialog/DestructiveConfirmDialog tests** - `32daee3` (test)
6. **Task 3 GREEN: ConfirmDialog and DestructiveConfirmDialog** - `5de2aa0` (feat)

## RED Observations

- `confirm-match.test.ts`: failed with `Cannot find module './confirm-match.js' imported from .../confirm-match.test.ts` -- 0 tests ran, the whole suite reported as a failed import, not an assertion failure.
- `FileButton.test.tsx`: failed with `Failed to resolve import "./FileButton.js" from "packages/ui/src/FileButton.test.tsx". Does the file exist?` before `FileButton.tsx` existed.
- `Sheet.test.tsx`: failed identically, `Failed to resolve import "./Sheet.js"`, before the component existed.
- `Dialog.test.tsx`: failed identically, `Failed to resolve import "./Dialog.js"`, before the component existed.

All four RED failures were for the correct reason (missing implementation module), never a passing-when-it-shouldn't-be assertion -- the plan's own fail-fast rule was not triggered.

## Files Created/Modified

- `packages/ui/src/confirm-match.ts` - `isConfirmationMatch(required, typed)`, the exact-match predicate
- `packages/ui/src/confirm-match.test.ts` - exact match, whitespace rejection (leading/trailing), case rejection, empty-typed rejection, partial-prefix rejection
- `packages/ui/src/FileButton.tsx` - `FileButtonProps`, the `FileButton` component (ghost Button + visually-hidden file input + FileReader wiring)
- `packages/ui/src/FileButton.test.tsx` - accessible name (default/custom label), hidden-input clip styling, accept forwarding, onText wiring, no-storage/no-attribute leak, double-select reset, onError fixed-message behaviour
- `packages/ui/src/Sheet.tsx` - `SheetProps`, the `Sheet` component on `@radix-ui/react-dialog`
- `packages/ui/src/Sheet.test.tsx` - closed-absent, open-accessible-name, body/footer composition, close-affordance-calls-onOpenChange-once, data-testid forwarding
- `packages/ui/src/Dialog.tsx` - `DialogShell` (internal), `ConfirmDialogProps`/`ConfirmDialog`, `DestructiveConfirmDialogProps`/`DestructiveConfirmDialog`
- `packages/ui/src/Dialog.test.tsx` - ConfirmDialog's title/body/confirm/cancel wiring; DestructiveConfirmDialog's disabled-transition, case/whitespace rejection, data-variant/data-filled, error alert slot, no-value-leak
- `packages/ui/src/index.ts` - now also exports `ConfirmDialog`, `DestructiveConfirmDialog`, `FileButton`, `Sheet`, `isConfirmationMatch` (alphabetical)
- `packages/ui/package.json` - `lucide-react` moved from `devDependencies` to `dependencies`
- `pnpm-lock.yaml` - lockfile update reflecting the dependency-section move (no new package, no version change)

## Decisions Made

See `key-decisions` in frontmatter -- summarized: `lucide-react` promoted to a real `dependencies` entry (Sheet's close icon is the first runtime use); `DialogShellProps['data-testid']` explicitly typed `string | undefined` to satisfy `exactOptionalPropertyTypes` when forwarding a destructured-optional prop into a sibling internal component; `DestructiveConfirmDialog.onConfirm` receives the typed value (not just a signal) since the caller needs it for the API request body.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] Sheet.tsx's own explanatory comment tripped its own grep gate**
- **Found during:** Task 2, running the acceptance-criteria grep `onEscapeKeyDown|onInteractOutside|outline: *none` against `packages/ui/src/Sheet.tsx`
- **Issue:** The doc comment explaining "this component adds none of that itself" literally named `onEscapeKeyDown`/`onInteractOutside` as the APIs it doesn't call -- the grep gate matches text, not intent, so the comment tripped the same check it was trying to document compliance with.
- **Fix:** Reworded the comment to describe the behaviour ("dismiss-event handlers or focus-style overrides") without using the literal prop-name substrings.
- **Files modified:** `packages/ui/src/Sheet.tsx`
- **Verification:** `grep -rcE "onEscapeKeyDown|onInteractOutside|outline: *none" packages/ui/src/Sheet.tsx` returns 0; re-ran `pnpm test packages/ui/src/Sheet.test.tsx` and `pnpm --filter @noodara/ui lint` after the edit, both still green.
- **Committed in:** `e4d8cd6` (Task 2 GREEN commit -- caught before the commit, no separate fix commit needed)

**2. [Rule 3 - Blocking] lucide-react needed to move from devDependencies to dependencies**
- **Found during:** Task 2, writing `Sheet.tsx`'s import of the `X` icon
- **Issue:** `lucide-react` was installed (provenance-approved, ADR-0000) as a `devDependency` of `packages/ui` in Plan 05-08, but no component had used it at runtime until this plan's `Sheet.tsx` -- a devDependency is not guaranteed to be present for a consumer of the built package.
- **Fix:** Moved the existing `"lucide-react": "1.47.0"` entry from `devDependencies` to `dependencies` in `packages/ui/package.json` and ran `pnpm install` to update the lockfile. No new package, no version change.
- **Files modified:** `packages/ui/package.json`, `pnpm-lock.yaml`
- **Verification:** `node scripts/check-package-provenance.mjs` still reports `OK lucide-react@1.47.0`; `pnpm build`/`pnpm boundaries` green afterward.
- **Committed in:** `e4d8cd6` (Task 2 GREEN commit)

**3. [Rule 1 - Bug] DialogShellProps's internal data-testid prop failed exactOptionalPropertyTypes**
- **Found during:** Task 3, `pnpm --filter @noodara/ui build`
- **Issue:** `ConfirmDialog`/`DestructiveConfirmDialog` forward their own destructured-optional `'data-testid'?: string` prop (type `string | undefined`) into the internal `DialogShell` component's `'data-testid'?: string` prop; under `exactOptionalPropertyTypes: true` this is a real `tsc` error (`Type 'string | undefined' is not assignable to type 'string'`), not a lint issue -- the same class of problem 05-08's `Field.tsx` already worked around for its own optional-prop forwarding.
- **Fix:** Widened `DialogShellProps['data-testid']` to `string | undefined` explicitly (rather than adding a conditional-spread at each of the two call sites), since the internal shell component genuinely accepts either value uniformly.
- **Files modified:** `packages/ui/src/Dialog.tsx`
- **Verification:** `pnpm --filter @noodara/ui build` and `pnpm --filter @noodara/ui typecheck` both pass afterward; `pnpm test packages/ui/src/Dialog.test.tsx` unaffected (10/10 still passing).
- **Committed in:** `5de2aa0` (Task 3 GREEN commit -- caught before the commit, no separate fix commit needed)

---

**Total deviations:** 3 auto-fixed (2 Rule 1 bugs caught by this plan's own verify commands before either GREEN commit landed, 1 Rule 3 blocking dependency-declaration fix)
**Impact on plan:** All three were necessary to make the plan's own verification commands (`pnpm build`, `pnpm lint`, the acceptance-criteria greps) actually pass; none changed what any test asserts, what any component does, or the plan's scope.

## Issues Encountered

None beyond the auto-fixed deviations above.

## User Setup Required

None -- no external service configuration required. No new packages were installed; `lucide-react` was already provenance-approved and installed (as a devDependency) in Plan 05-08, this plan only corrected its `package.json` section and re-ran the provenance gate.

## Next Phase Readiness

- `FileButton`, `Sheet`, `ConfirmDialog`, `DestructiveConfirmDialog` and `isConfirmationMatch` are real, behaviourally-tested, token-only pieces the add/edit server sheet (05-UI-SPEC.md SS2.4, a later plan) and the delete-server/trust-new-fingerprint flows (SS5.7, D-03) build directly on -- `FileButton` for the private-key file-load path, `Sheet` for the create/edit panel, `DestructiveConfirmDialog` for both destructive confirmations.
- **UI-01 and UI-02 stay Pending in REQUIREMENTS.md.** This plan adds four more `packages/ui` components and one pure helper -- no shell, screen, sheet wiring or `apps/web` route consumes them yet. Matches the same plan-frontmatter-artifact pattern already flagged in STATE.md for SERV-06 (04-01), DETL-02/QA-05 (05-01/05-02/05-03), DISC-02/QA-05 (05-05), and UI-01/UI-02 itself (05-06, 05-22, 05-07, 05-08). Re-verify UI-01/UI-02 against whichever later plan actually builds the shell and screens (05-UI-SPEC.md SS1-2).
- `Sheet`'s translucent-surface treatment (`bg-surface-1/72 backdrop-blur-xl backdrop-saturate-[1.8]`) and its overlay's `bg-canvas/72` scrim are this plan's own reasonable implementation of skill SS2.3's "Translucent" elevation level -- no dedicated overlay-scrim token exists yet in `tokens.css`, so this is a component-level choice, not a new design-system token; first real visual verification happens once `apps/web` actually renders a `Sheet` and again at Plan 05-21's `noodara-ux-review` audit.
- `Dialog.tsx`'s `DialogShell` is intentionally unexported (an internal composition helper for `ConfirmDialog`/`DestructiveConfirmDialog` only) -- later plans should compose new dialog variants through `ConfirmDialog`/`DestructiveConfirmDialog` themselves, not reach into `DialogShell` directly.

---
*Phase: 05-ui-web*
*Completed: 2026-09-19*

## Self-Check: PASSED

Verified on disk: `packages/ui/src/confirm-match.ts`, `confirm-match.test.ts`, `FileButton.tsx`, `FileButton.test.tsx`, `Sheet.tsx`, `Sheet.test.tsx`, `Dialog.tsx`, `Dialog.test.tsx`. All six task commits (`87d547b`, `9a2636d`, `f52b95a`, `e4d8cd6`, `32daee3`, `5de2aa0`) confirmed present in `git log --oneline`. `pnpm test` (1032 tests), `pnpm build`, `pnpm lint`, `pnpm typecheck`, `pnpm boundaries` and `node scripts/check-package-provenance.mjs` all green; every acceptance-criteria grep gate reports 0.
