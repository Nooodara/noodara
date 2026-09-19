# ADR 0005: `packages/ui` scaffold and component-verification strategy

## Status

Accepted — 2026-09-19

## Context

Phase 5 needs a design system package (`packages/ui`) that every screen in
`apps/web` draws from, and CLAUDE.md §2.1 requires every behaviour-carrying
component in it to be developed test-first (RED → GREEN → REFACTOR), not
"implement then add tests." An earlier draft of `05-06-PLAN.md` declined the
jsdom/Testing Library stack entirely, verifying components only through
Playwright, to avoid four extra dependencies. That traded away CLAUDE.md
§2.1 for every component this phase builds, which is non-negotiable — the
draft was reversed during plan review. The five test-only packages this
decision requires (`jsdom`, `@testing-library/dom`,
`@testing-library/react`, `@testing-library/jest-dom`,
`@testing-library/user-event`) went through the existing
`docs/adr/0000-package-legitimacy-approvals.md` provenance gate and
`05-03-PLAN.md`'s Task 1 blocking human checkpoint — this ADR does not open a
new checkpoint, it records the decision that checkpoint already resolved.

## Decision

### (a) No shadcn/ui, no `components.json`

`packages/ui` is a hand-built design system on Radix UI primitives
(`@radix-ui/react-*`), per `05-UI-SPEC.md`'s own "Design System" table. There
is no shadcn registry, no generated component scaffold — every component is
authored directly against the tokens this package also owns.

### (b) Component-verification strategy: test-first Vitest component tests

Component behaviour — variants, disabled/loading/active/focus states, aria
attributes, callback invocation, the three empty/loading/error states per
screen, and the "state is never colour-only" rule (the status *word* must be
present in the DOM, not just a colour) — is verified with **colocated Vitest
component tests** (`X.test.tsx` next to `X.tsx`), running in the `dom`
Vitest project (jsdom environment). Every component task writes the failing
test first and records the RED observation (the exact failure message seen
before the component existed) in its own plan's SUMMARY, per CLAUDE.md §2.1
and the `noodara-tdd` skill's RED→GREEN→REFACTOR cycle. A test that passes
before the component exists is a wrongly-written test, not a shortcut.

### (c) What Playwright owns instead

jsdom cannot honestly verify: cross-screen user flows, real-browser keyboard
navigation and focus order, Radix's own focus-trap and `Esc` behaviour end
to end, theme switching and *computed* styles (contrast, actual pixel
values), and every credential-leak surface (DOM serialization, `console.*`,
storage, URLs, request bodies) — these stay in `tests/e2e/*.spec.ts`
(Playwright), per the `noodara-tdd` skill's own test-type table. Screen-state
E2E specs use `page.route` interception to force loading/error states
without a real backend — that convention, established here, is referenced by
Plans 05-13 onward.

### (d) The five test-only packages

| Package | Why |
|---|---|
| `jsdom` | The DOM environment Vitest's `dom` project runs component tests in — Testing Library needs a real (simulated) DOM, not Node's bare `globalThis`. |
| `@testing-library/dom` | A **hard peerDependency** of `@testing-library/react` — not an optional extra. It supplies the query engine (`getByRole`, `getByLabelText`, …) that `@testing-library/react`'s `render()` wraps. |
| `@testing-library/react` | Mounts a React tree into jsdom and exposes Testing Library's query/interaction API scoped to that tree. |
| `@testing-library/jest-dom` | Registers the `toBeInTheDocument()`/`toBeDisabled()`/etc. matcher set globally for the `dom` project via `vitest.setup.dom.ts`, so no component test file needs its own matcher import. |
| `@testing-library/user-event` | Drives real keystroke/click/focus sequences (not a single synthetic `fireEvent.click`), needed for the type-the-name confirm gate and credential fields' keystroke-level behaviour. |

All five are `devDependencies` of the workspace root only (see
`docs/adr/0000-package-legitimacy-approvals.md`'s Phase 5 additions
section) — none of them ever reaches a browser bundle.

`@vitejs/plugin-react` was considered and declined: Vite's esbuild
transform already honours `jsx: "react-jsx"` (set in
`packages/ui/tsconfig.json`), so no separate React JSX transform plugin is
needed to run `.tsx` component tests under Vitest.

### (e) Reversal record

An earlier draft of this plan declined the jsdom/Testing Library stack in
favour of Playwright-only component verification, to keep the dependency
tree smaller. That was reversed during plan review because it relaxed
CLAUDE.md §2.1 (TDD is not optional) for every component in this phase. The
five packages this reversal requires entered through the pre-existing
`docs/adr/0000-package-legitimacy-approvals.md` gate and
`05-03-PLAN.md`'s Task 1 blocking human checkpoint (approved by Pablo
Gutierrez, 2026-09-19) — no new checkpoint was opened for this ADR.

### (f) The `ui-components` boundaries tag

`packages/ui` gets its own Turborepo boundaries tag, `ui-components`, rather
than reusing `pure-domain`. `packages/ui` is not pure — it has real I/O-free
UI logic but also renders to the DOM and reads `env`-free browser APIs
(`localStorage`, `matchMedia`), which is a different contract than
`packages/domain`'s "no I/O at all" purity guarantee. `ui-components`'s
allow list (`turbo.json`) is `["ui-components", "@noodara/config",
"pure-domain", "ssh-adapter"]` — `pure-domain` so `packages/ui` may import
domain types/enums (e.g. `ServerStatus`) for `StatusPill`'s variant mapping,
`ssh-adapter` because Turborepo's boundaries check is undirected against
pnpm's hoisted `node_modules` (an already-established property of this
repo's boundaries setup — `pure-domain`'s own allow list needed the same
`ssh-adapter` addition in Phase 2 for the identical hoisting reason, not
because `packages/domain` imports `@noodara/ssh`). `pure-domain`'s own allow
list gained `ui-components` in the same commit, since these lists behave
undirectedly.

### (g) `dangerouslySetInnerHTML` prohibition

No component in `packages/ui` may use `dangerouslySetInnerHTML` — the design
system never renders raw/untrusted HTML (logs, error messages, and AI output
are always rendered as text nodes). This is a repo-wide rule enforced by
Plan 05-21's grep-based `check:ui-safety` gate, not by lint alone.

## Consequences

- Every component task in this phase writes `X.test.tsx` before `X.tsx`,
  running it once to observe the RED failure before implementing, and
  records that failure message in its plan's SUMMARY.
- `packages/ui/src/testing/render.tsx` (`renderUi`, Plan 05-06 Task 2) is the
  single, shared component-test entry point for both `packages/ui` and the
  future `apps/web` — no test file imports `@testing-library/react`
  directly, so a later shared provider (e.g. Radix `Tooltip.Provider`,
  Plan 05-24) is added in exactly one place.
- `pnpm test` gains a fourth Vitest project (`dom`, jsdom environment)
  alongside `root`/`packages`/`apps` — a component test failing does not
  block or slow the existing node-environment suites, since they run as
  separate projects.
- Playwright E2E specs (`tests/e2e/*.spec.ts`) are the only place this
  phase verifies real browser keyboard navigation, computed contrast, and
  credential-leak surfaces at the DOM-serialization level.
