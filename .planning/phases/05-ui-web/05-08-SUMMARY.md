---
phase: 05-ui-web
plan: 08
subsystem: ui
tags: [react, radix-ui, vitest, jsdom, testing-library, tailwind-v4, design-tokens, tdd, accessibility]

# Dependency graph
requires:
  - phase: 05-ui-web
    provides: "05-22's Button/StatusPill component conventions (cn/tone helpers, data-* state attributes, token-only styling) and 05-06's renderUi/jsdom component-test harness"
provides:
  - "packages/ui/src/Field.tsx: the label/control/help/error wrapper every form row in the product uses, with useId-generated ids, aria-describedby composition and aria-invalid wiring proven by a component test"
  - "packages/ui/src/Input.tsx and Textarea.tsx: 36px / rows-driven text controls with a verbatim autoComplete forwarding contract (T-5-32) and a proven no-value-duplication guarantee (T-5-41)"
  - "packages/ui/src/SegmentedControl.tsx: a Radix RadioGroup styled as segments, credential-type control for the add/edit server sheet (server-sheet-credential-type)"
  - "All seven Radix primitives the phase needs (dialog, tooltip, collapsible, radio-group, scroll-area, visually-hidden, checkbox) installed once into packages/ui at ADR-0000's pinned versions"
affects: [05-ui-web remaining component plans (05-23, 05-24, 05-25 consume dialog/tooltip/collapsible/scroll-area/checkbox), 05-11 and 05-17 (add/edit server sheet built from Field/Input/Textarea/SegmentedControl)]

# Tech tracking
tech-stack:
  added: ["@radix-ui/react-radio-group@1.4.7", "@radix-ui/react-dialog@1.1.23", "@radix-ui/react-visually-hidden@1.2.11", "@radix-ui/react-tooltip@1.2.16", "@radix-ui/react-collapsible@1.1.20", "@radix-ui/react-scroll-area@1.2.18", "@radix-ui/react-checkbox@1.3.11"]
  patterns:
    - "Field is a render-prop component (children: (controlProps) => ReactNode), not a cloneElement wrapper -- keeps it agnostic of which concrete control it wraps (a plain <input> in its own test, Input/Textarea in the sheet) and avoids fragile children-typing under exactOptionalPropertyTypes"
    - "aria-invalid/aria-describedby/data-mono follow the same true-or-undefined-never-false pattern Button's aria-busy established in 05-22 -- optional attributes are omitted via a conditional object spread, never assigned a literal false, so exactOptionalPropertyTypes stays satisfied and the DOM attribute is genuinely absent when unset"
    - "Component tests that assert 'no value duplication' (Input/Textarea) type a distinctive string with userEvent, then scan every element's every attribute in the render for that substring, excluding the control's own value attribute -- a behavioural proof, not a source grep, of T-5-41"
    - "SegmentedControl adds zero keyboard handling of its own (onKeyDown/tabIndex grep-gated at 0) -- roving tabindex, arrow keys and radiogroup/radio ARIA come entirely from Radix RadioGroup; onValueChange only fires on a genuine value change by construction (useControllableState), so re-clicking the selected segment needs no extra guard"

key-files:
  created:
    - packages/ui/src/Field.tsx
    - packages/ui/src/Field.test.tsx
    - packages/ui/src/Input.tsx
    - packages/ui/src/Input.test.tsx
    - packages/ui/src/Textarea.tsx
    - packages/ui/src/Textarea.test.tsx
    - packages/ui/src/SegmentedControl.tsx
    - packages/ui/src/SegmentedControl.test.tsx
  modified:
    - packages/ui/src/index.ts
    - packages/ui/package.json
    - pnpm-lock.yaml

key-decisions:
  - "Field's child control is a render-prop function, not a cloned React element -- the plan's own note ('using a plain <input> as the child control') and the fact that Input/Textarea don't exist until Task 2 made a render-prop signature (children: (controlProps: FieldControlProps) => ReactNode) the only way Task 1's test could exercise Field's wiring against a bare <input> while staying the same shape Input/Textarea consume in later screens"
  - "Field generates its own control id via useId rather than accepting a caller-supplied htmlFor -- simpler and collision-free; the plan's 'htmlFor-linked child control' phrasing describes the label/control relationship Field produces internally, not a required prop on Field itself"
  - "SegmentedControl's onValueChange forwarding needed no extra 'don't re-fire on the same value' guard -- Radix RadioGroup's useControllableState only calls onChange when the value actually changes, so 'clicking the already-selected option does not invoke it again' held with zero additional code, confirmed by the RED-then-GREEN test rather than assumed"

requirements-completed: []

# Metrics
duration: ~8min
completed: 2026-09-19
---

# Phase 5 Plan 8: Field, Input, Textarea, SegmentedControl and the Radix Install Summary

**Test-first Field/Input/Textarea/SegmentedControl on top of a one-time install of the phase's seven Radix primitives, with the label/help/error a11y contract and the credential-autofill/no-duplication rules both proven by component tests.**

## Performance

- **Duration:** ~8 min
- **Started:** 2026-09-19T16:07:38Z
- **Completed:** 2026-09-19T16:14:42Z
- **Tasks:** 3 (each RED test committed separately from its GREEN implementation, per CLAUDE.md §2.1; the Radix install landed as its own preceding `chore` commit)
- **Files modified:** 11 (8 new source/test files, index.ts, package.json, pnpm-lock.yaml)

## Accomplishments

- Installed all seven `@radix-ui/react-*` packages this phase needs (`radio-group`, `dialog`, `visually-hidden`, `tooltip`, `collapsible`, `scroll-area`, `checkbox`) into `packages/ui` at the exact versions ADR-0000's Phase 5 additions table pins, each re-verified with `npm view <pkg> version` immediately before install and re-confirmed afterward by `node scripts/check-package-provenance.mjs` (all 28 tracked packages, including these seven, pass).
- `packages/ui/src/Field.tsx`: the label/control/help/error wrapper every form row inherits from. Six behaviours proven in `Field.test.tsx` — label programmatically associated with the control (`getByLabelText`), help id present in `aria-describedby` with the help text rendered, `aria-invalid`+`role="alert"` error wiring, absence of both when no error, both ids referenced together when help and error coexist, and the error text rendered verbatim (never composed or reformatted, per 05-UI-SPEC.md §10).
- `packages/ui/src/Input.tsx` and `Textarea.tsx`: 36px / rows-driven text controls sharing one contract — `autoComplete` forwarded verbatim (`off` and `current-password` both render exactly, T-5-32), `mono`/`invalid` observable via `data-mono`/`aria-invalid` without computing a style, disabled blocks typed input, and a typed distinctive string never leaks into any DOM attribute other than the control's own `value` (T-5-41, asserted by scanning every attribute of every element in the render).
- `packages/ui/src/SegmentedControl.tsx`: a Radix `RadioGroup` styled as segments — two `radio` roles inside one `radiogroup`, `aria-checked` tracks `value`, visible label text per option, `data-testid` forwarded to the group element (ready for Plan 05-17's `server-sheet-credential-type`), and zero `onKeyDown`/`tabIndex` in the file (grep-gated at 0) since roving tabindex and arrow-key handling come entirely from the primitive.
- All four RED test files were seen to fail for the right reason (missing module) before their GREEN implementation existed, each as its own `test(05-08): ...` commit ahead of the matching `feat(05-08): ...` commit; the Radix install itself landed first as a `chore(05-08): ...` commit since it is infrastructure, not behaviour.
- `pnpm test` (1003 tests, up from 964 before this plan), `pnpm build`, `pnpm lint`, `pnpm typecheck`, `pnpm boundaries` and `node scripts/check-package-provenance.mjs` are all green; `grep -rE "#[0-9a-fA-F]{3,8}|rgb\(" packages/ui/src/Input.tsx packages/ui/src/Textarea.tsx` and `grep -cE "onKeyDown|tabIndex" packages/ui/src/SegmentedControl.tsx` both confirm 0.

## Task Commits

1. **Radix install (precedes Task 1's RED, infrastructure not behaviour)** - `2a66076` (chore)
2. **Task 1 RED: failing Field test** - `1f80e2c` (test)
3. **Task 1 GREEN: the Field component** - `94d8e9a` (feat)
4. **Task 2 RED: failing Input/Textarea tests** - `f6aeda9` (test)
5. **Task 2 GREEN: the Input and Textarea components** - `db913f6` (feat)
6. **Task 3 RED: failing SegmentedControl test** - `8aba5bd` (test)
7. **Task 3 GREEN: the SegmentedControl component** - `9187e25` (feat)

## RED Observations

- `Field.test.tsx`: failed with `Failed to resolve import "./Field.js"` (module did not exist) before `Field.tsx` was created — 0 tests ran, suite reported as a failed import, not an assertion failure.
- `Input.test.tsx` / `Textarea.test.tsx`: both failed identically with `Failed to resolve import "./Input.js"` / `"./Textarea.js"` before either component existed.
- `SegmentedControl.test.tsx`: failed with `Failed to resolve import "./SegmentedControl.js"` before the component existed.

All four RED failures were for the correct reason (missing implementation module), never a passing-when-it-shouldn't-be assertion — the fail-fast rule in this plan's TDD guidance was not triggered.

## Files Created/Modified

- `packages/ui/src/Field.tsx` - `FieldControlProps`, `FieldProps`, the `Field` render-prop wrapper
- `packages/ui/src/Field.test.tsx` - six behaviours: label association, help wiring, error wiring, error-absent state, both-present state, verbatim error text
- `packages/ui/src/Input.tsx` - the 36px text input, `mono`/`invalid` props, verbatim `autoComplete` forwarding
- `packages/ui/src/Input.test.tsx` - textbox role/typing/onChange, autoComplete (off/current-password), data-mono, aria-invalid, disabled blocks typing, no value duplication
- `packages/ui/src/Textarea.tsx` - the rows-driven textarea sharing Input's contract
- `packages/ui/src/Textarea.test.tsx` - same behaviour set as Input plus the `rows` prop
- `packages/ui/src/SegmentedControl.tsx` - `SegmentedControlOption`, `SegmentedControlProps`, the `SegmentedControl` component on `@radix-ui/react-radio-group`
- `packages/ui/src/SegmentedControl.test.tsx` - two-radio/one-radiogroup, checked state, visible labels, onValueChange semantics, data-testid forwarding
- `packages/ui/src/index.ts` - now exports `Field`, `Input`, `SegmentedControl`, `Textarea` (and their prop/option types) alphabetically alongside the existing `Button`/`StatusPill`/`cn`/`tone` exports
- `packages/ui/package.json` - seven new `@radix-ui/react-*` `dependencies` entries at ADR-0000's pinned versions
- `pnpm-lock.yaml` - lockfile update for the seven new dependency edges

## Decisions Made

See `key-decisions` in frontmatter — summarized: `Field`'s children prop is a render function rather than a cloned element, since the plan's own Task 1 test uses a bare `<input>` and later tasks pass `Input`/`Textarea`, and a render-prop signature is the only shape that stays agnostic of the concrete control across both; `Field` generates its own `id` via `useId` rather than requiring a caller-supplied `htmlFor`, since nothing in the six required behaviours needs the caller to control the id and doing so internally is simpler and collision-free; `SegmentedControl` needed no extra guard against re-firing `onValueChange` on the already-selected option, since Radix's own `useControllableState` already only calls `onChange` on an actual value change — confirmed by the RED-then-GREEN cycle rather than assumed from documentation.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] SegmentedControl.test.tsx's own empty arrow functions failed lint**
- **Found during:** Task 3, `pnpm --filter @noodara/ui lint` (run as part of Task 3's own verify command, before the GREEN commit)
- **Issue:** `@typescript-eslint/no-empty-function` flagged the test file's four `onValueChange={() => {}}` no-op callbacks (used in tests that don't assert on the callback itself)
- **Fix:** Replaced each empty arrow function with `vi.fn()` (already imported in the file for the two tests that do assert on the callback) — same no-op runtime behaviour, satisfies the lint rule
- **Files modified:** `packages/ui/src/SegmentedControl.test.tsx`
- **Committed in:** `9187e25` (Task 3 GREEN commit — the test file was already staged as part of GREEN verification, no separate commit needed since RED had already landed with the original empty-arrow-function version and this is a same-behaviour fix to the not-yet-passing-lint test file)

---

**Total deviations:** 1 auto-fixed (1 Rule 1 bug, lint-only, no behavioural or test-assertion change)
**Impact on plan:** Fix was necessary to make the plan's own verification command (`pnpm lint`) pass; did not change what any test asserts or what SegmentedControl does.

## Issues Encountered

None beyond the auto-fixed deviation above.

## User Setup Required

None — no external service configuration required. All seven newly-installed Radix packages were already provenance-verified and pinned in `docs/adr/0000-package-legitimacy-approvals.md`'s Phase 5 additions table; this plan only performed the actual `pnpm add` and re-ran the gate.

## Next Phase Readiness

- `Field`, `Input`, `Textarea` and `SegmentedControl` are real, behaviourally-tested, token-only components — everything the add/edit server sheet (05-UI-SPEC.md §2.4, built in a later plan) needs for its non-credential-type-selector fields and the credential-type segmented control itself.
- All seven Radix primitives this phase needs now exist in `packages/ui`'s dependencies; Plans 05-23, 05-24 and 05-25 consume `dialog`/`visually-hidden` (Sheet), `tooltip`, `collapsible` and `scroll-area`/`checkbox` without any further install step.
- **UI-01 and UI-02 stay Pending in REQUIREMENTS.md**, per this plan's own instructions and the established plan-frontmatter-artifact pattern already flagged in STATE.md for SERV-06 (04-01), DETL-02/QA-05 (05-01/05-02/05-03), DISC-02/QA-05 (05-05) and UI-01 itself (05-06, 05-22, 05-07): this plan adds four more design-system components, not a shell, screen or navigation. Re-verify UI-01/UI-02 against whichever later plan actually builds the shell and screens (05-UI-SPEC.md §1–2).
- Field's render-prop pattern and Input/Textarea's `autoComplete`-verbatim/no-duplication contract are the pieces the add/edit server sheet's credential fields (private key textarea, passphrase, password) most directly depend on for T-5-32/T-5-41 — both already proven here, not left for the sheet's own plan to re-derive.

---
*Phase: 05-ui-web*
*Completed: 2026-09-19*

## Self-Check: PASSED

Verified on disk: `packages/ui/src/Field.tsx`, `Field.test.tsx`, `Input.tsx`, `Input.test.tsx`, `Textarea.tsx`, `Textarea.test.tsx`, `SegmentedControl.tsx`, `SegmentedControl.test.tsx`. All seven commits (`2a66076`, `1f80e2c`, `94d8e9a`, `f6aeda9`, `db913f6`, `8aba5bd`, `9187e25`) confirmed present in `git log --oneline`. `pnpm test` (1003 tests), `pnpm build`, `pnpm lint`, `pnpm typecheck`, `pnpm boundaries` and `node scripts/check-package-provenance.mjs` all green; zero hex/`rgb(` literals in `Input.tsx`/`Textarea.tsx`; zero `onKeyDown`/`tabIndex` in `SegmentedControl.tsx`.
