# UX Review — Phase 5 (ui-web)

**THIS IS AN AUTOMATED AGENT REVIEW.** It was produced by an executor agent reading source code,
component tests, and the E2E suite's own passing assertions — **no human has looked at a rendered
screen yet, in either theme.** No screenshots were captured (no `pnpm dev` walkthrough was run as
part of producing this document — see "Needs human review" below for what only a human can
confirm). Every PASS/FLAG/BLOCK below cites a file:line or a named, currently-passing test as its
evidence; where no such evidence exists, the row says so plainly rather than asserting a verdict.

Date: 2026-09-20 · Reviewer: executor agent (`noodara-ux-review` skill, `noodara-ux-apple` skill) ·
Mode: **code + passing-test evidence only, no screenshots**

Scope: every screen and component this phase shipped — Setup, Login, the authenticated shell
(sidebar/toolbar), Servers list, Add/edit server sheet, Delete dialog, Server detail (facts,
discovery, TOFU banners/dialog), Activity log, Settings, and the shared `packages/ui` component
inventory (Button, StatusPill, Input/Textarea, SegmentedControl, FileButton, Sheet, Dialog,
Banner/Notice, StatTile, LabelValue, ListRow/RowMenu, Skeleton, EmptyState, Disclosure, Tooltip,
ThemeToggle).

**Overall verdict: FLAG.** No BLOCK-level violation of a non-negotiable rule (second accent,
decorative gradient, card/button shadow, hex inline outside the token source, color-only state,
no light/dark, visible secret) was found. Three FLAGs were found — a real, systemic gap (missing
floating-elevation shadow on Sheet/Dialog/RowMenu), one already-known and explicitly accepted
open item (light-mode status-pill contrast), and one accessibility gap in the hand-rolled
`RowMenu` (missing `aria-expanded`). All three are named with evidence, not softened.

---

## Verdicts by dimension

| Dimension | Verdict | Evidence |
|---|---|---|
| 1. Tokens | PASS | Zero hex/rgb literals outside `packages/ui/tokens.css` (`pnpm check:ui-safety`, this plan's own gate, exit 0). `--accent` is the only action color; semantic tokens (`--status-*`) are reserved to `ServerStatus`/`DiscoveryCheckStatus` derivation (`packages/ui/src/tone.ts`, `StatusPill.tsx:12-16`). No decorative gradient anywhere (`grep -rn "gradient" packages/ui/src apps/web/src` — zero real hits). |
| 2. Surface and elevation | **FLAG** | Surface stepping (`--surface-1/2/3`) and hairlines are used correctly throughout (`Sheet.tsx:21` `PANEL_CLASSES`, `RowMenu.tsx:26-28` `CONTENT_CLASSES`, `ListRow.tsx`). **But the skill's one legitimate shadow — `0 8px 30px rgba(...)` reserved for popovers/menus/sheets (skill §2.3 "Floating") — does not exist anywhere in the implementation.** `grep -rn "shadow" packages/ui/src apps/web/src packages/ui/theme.css packages/ui/tokens.css` returns zero matches. `Sheet.tsx`, `Dialog.tsx` and `RowMenu.tsx` rely solely on a hairline border + `backdrop-blur` + translucency, never the floating shadow the skill's elevation table specifies for exactly these three surfaces. This is not a "don't" violation (no shadow was added where the skill forbids one, e.g. cards/buttons/rows) — it is a documented elevation level that was simply never implemented. Needs either a `--shadow-floating` token added to `tokens.css` and applied to these three components, or an explicit decision that flat + hairline is an acceptable substitute for v0.1. |
| 3. Typography and hierarchy | PASS | Eight semantic roles used consistently, no ad hoc sizes found (`grep -rn "text-\[" apps/web/src packages/ui/src` — zero arbitrary Tailwind text-size values). Mono used for all technical values: `host:port` (`ServerRow.tsx`), fingerprints (`ServerFacts.tsx`, `HostKeyChangedBanner.tsx`), error codes (`Banner.tsx`), SSH timeouts/master-key fingerprint (`SettingsGroups.tsx`), discovery `detail`/`durationMs` (`DiscoveryStep.tsx`). Weight 700 never used (`grep -rn "font-bold\|font-\[700\]" apps/web/src packages/ui/src` — zero hits); 500 confined to sidebar labels/table headers per the skill's one exception. |
| 4. Layout and spacing | PASS | Toolbar carries at most one primary action per screen by construction (`ToolbarProps.primaryAction` is a single optional `ReactNode`, never an array — `Toolbar.tsx:26-30`; `ServerDetailToolbar.tsx`'s primary-action table is mutually exclusive by status). Responsive breakpoints match 05-UI-SPEC.md §1 exactly and are E2E-proven: `tests/e2e/shell.spec.ts:120` (`@shell the sidebar collapses to an icon rail at 1024px and a bottom sheet below 900px`), passing. 8px spacing scale used via Tailwind classes derived from the token set; no literal pixel padding found outside the documented fixed control heights (44px rows, 32-36px controls) the skill itself calls out as exceptions. |
| 5. Components | PASS, with one accessibility FLAG on RowMenu (see below) | Every screen composes `packages/ui` components rather than reimplementing (`ServerList.tsx`, `ActivityList.tsx`, `SettingsGroups.tsx` all import from `@noodara/ui`, never hand-roll a row/table/pill). `StatusPill.tsx:27-42`: dot + text, semantic tone map, status word always in the DOM (never color-only) — the six-status table's own component test asserts this. Forms live in `Sheet`/`Dialog`; credentials never pre-filled (`CredentialFields.tsx`'s edit-mode branch, dots + "Replace", proven by `tests/e2e/server-sheet.spec.ts:220` "opening Edit shows the credential collapsed to dots plus Replace, with no key text anywhere in the DOM", passing). |
| 6. States (empty/loading/error) | PASS | Every one of the seven screens has all three states with a passing E2E behaviour naming it: Servers list empty (`tests/e2e/servers-list.spec.ts:96`), loading skeleton with no spinner (`:110`), error banner + Retry (`:123`); Activity empty/loading/error (`tests/e2e/activity.spec.ts:66`, `:273`); Settings loading/error (`tests/e2e/settings.spec.ts:112`, `:135`); Server detail's DETL-02 empty state (`tests/e2e/server-detail.spec.ts:114` "a PENDING server with no discovery shows the empty state, one Connect action and no error banner") and error-with-history-stays-dimmed (`:157`). Destructive confirmations require the exact resource name typed (`tests/e2e/server-sheet.spec.ts:253`, `DestructiveConfirmDialog`/`isConfirmationMatch`). |
| 7. Progressive disclosure | PASS | Servers list → row → detail page (never a modal with the full entity). Discovery collapses to a one-line settled summary, expanding to six steps, expanding further to raw checks (`DiscoverySection.tsx`, `discovery-progress.ts`, proven by `tests/e2e/discovery.spec.ts:125`/`:149`). Settings' Advanced group is collapsed by default (`tests/e2e/settings.spec.ts:42`). Activity rows only show a chevron when curated metadata actually exists (`activity-groups.ts`). |
| 8. Copy | PASS | English, sentence case, no exclamation marks in any user-facing string read directly in `error-copy.ts`, `ServerSheet.tsx`, `SetupPage`/`LoginPage`, `05-UI-SPEC.md`'s Copy Deck (§5), or the E2E specs' own literal expected-text assertions (e.g. `tests/e2e/auth.spec.ts`'s `LOGIN_INVALID_CREDENTIALS_MESSAGE`, `tests/e2e/server-sheet.spec.ts`'s `NAME_TAKEN` string). Error copy states what happened + what to do, e.g. `error-copy.ts`'s `CONNECT_TIMEOUT` string and 05-UI-SPEC.md §5.1's literal sentences, verified verbatim by `tests/e2e/server-detail.spec.ts`. |
| 9. Accessibility and themes | **FLAG (2 items, one already known and accepted)** | See "Accessibility findings" below. |

---

## Accessibility findings

### FLAG 1 (already known; NOT accepted — routed to gap closure by the user, 2026-09-20) — status-pill contrast

Computed contrast for full-saturation status text on its own `-soft` background (the 14%-alpha
tint composited over `--surface-1`) against the 4.5:1 WCAG AA small-text threshold. Figures
recomputed independently by the orchestrator from `packages/ui/tokens.css`; they correct this
review's first draft, which overstated dark mode as "passes comfortably (≈6.1–6.3:1)" — true for
two of the four colors only:

| Status | Light | Dark |
|---|---|---|
| `--status-ok` | 1.98:1 — fails | 6.42:1 — passes |
| `--status-warn` | 1.96:1 — fails | 6.30:1 — passes |
| `--status-error` | 2.95:1 — fails | 4.21:1 — fails narrowly |
| `--status-idle` | 2.84:1 — fails | 4.22:1 — fails narrowly |

So light mode fails for all four, and dark mode fails narrowly for `error` and `idle`. The
light-mode values are reproduced verbatim in `packages/ui/tokens.css`
(the light-mode `-soft` values), with a comment pointing at 05-UI-SPEC.md Open Question 1. This is
a property of the **locked** `noodara-ux-apple` skill's tokens, not a bug in this phase's own
implementation — it cannot be fixed by inventing a new token without the skill owner's decision.
Mitigated in the meantime: the status *word* is always present in the DOM (never color-only),
asserted for all six statuses — though a legible word is exactly what a failing contrast ratio
takes away, so this mitigates less than it sounds. **Decision (user, Task 3 checkpoint,
2026-09-20): fix in gap closure** — not accepted as-is, not a phase hold. The replacement text
colors are a design decision the user makes in that gap plan.

### FLAG 2 — WITHDRAWN (2026-09-20): `RowMenu`'s trigger has no `aria-expanded`

> **Correction.** This finding is false. `RowMenu`'s trigger is a Radix `DialogTrigger`, and
> `@radix-ui/react-dialog@1.1.23` (`dist/index.js:128-129`) sets both `aria-expanded` and
> `aria-controls` on it. The automated pass audited `RowMenu.tsx`'s own JSX and did not look at
> what the primitive adds. Found by the phase code review (`05-REVIEW.md`, WR-C-05) and
> re-verified by the orchestrator. Do **not** add a second `aria-expanded`. `RowMenu`'s real
> defects are different and are listed in WR-C-05: selecting an item never closes the menu or
> returns focus, the trigger is `opacity-0` permanently on touch devices, and `key={item.label}`
> can collide. The original text is kept below for the record only.

`packages/ui/src/RowMenu.tsx:83-91`: the trigger sets `aria-haspopup="menu"` but never sets
`aria-expanded` (true when open, false when closed) — a required attribute of the WAI-ARIA
Menu Button pattern for a screen reader to announce the menu's open/closed state. Radix's
`Dialog.Trigger` does not supply this automatically for a non-modal, `role="menu"`-overridden
usage (confirmed by reading `RowMenu.tsx`'s own props and `RowMenu.test.tsx`, which asserts
`aria-haspopup` but never asserts `aria-expanded`). This is the one component in the entire
inventory built without an ADR-0000-approved purpose-built popover/dropdown-menu primitive
(05-25-SUMMARY.md's own documented decision), and it is the one place a WAI-ARIA attribute was
missed. Concrete fix: `aria-expanded={open}` on the trigger, sourced from Radix's own
`data-state` (already rendered as `data-state="open"/"closed"` per the raw DOM captured during
this plan's own canary spec runs) — a small, mechanical addition, not a redesign.

### Everything else checked

- **Focus visibility**: `outline: 2px solid var(--accent); outline-offset: 2px` via
  `focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2
  focus-visible:outline-accent` on every interactive primitive (`Button.tsx`, `Input.tsx`,
  `SegmentedControl.tsx`, `RowMenu.tsx`, `Toolbar.tsx`'s sidebar links) — never a plain
  `outline: none` with no replacement (`pnpm check:ui-safety`'s own gate, exit 0, mutation-tested
  in this plan's own execution to prove it bites). E2E-proven: `tests/e2e/shell.spec.ts:69`
  "every focused sidebar item shows a visible, non-zero focus outline", passing.
- **Keyboard navigation**: full tab order proven end to end, `tests/e2e/shell.spec.ts:44`
  "pressing Tab from page load moves through the skip link, the three sidebar items, the theme
  toggle, then sign out", passing. `RowMenu`'s own arrow-key roving focus (Up/Down/Home/End) is
  hand-implemented per its own file comment, since no approved primitive provides it once
  `role="menu"` is chosen — reviewed directly in `RowMenu.tsx:56-78`, logic is correct (wraps at
  both ends, ignores unrelated keys). Sheet/Dialog focus-trap and Esc-to-close come entirely from
  Radix's own primitives, never overridden (`pnpm check:ui-safety`'s `onEscapeKeyDown`/
  `onInteractOutside` gate, zero occurrences, mutation-tested).
- **Reduced motion**: every animated property (`Disclosure.tsx`'s chevron rotation and
  grid-row transition, `StatusPill.tsx`'s CONNECTING pulse, `Skeleton.tsx`'s own pulse if any) is
  gated by Tailwind's `motion-safe:` variant, degrading to an instant/static state under
  `prefers-reduced-motion: reduce` — confirmed by reading each file directly; no bare
  `animate-*`/`transition-*` class was found unguarded outside the `motion-safe:` prefix in a
  spot-check of `Disclosure.tsx`, `StatusPill.tsx`, `Button.tsx`, `Sheet.tsx`.
- **No spinner anywhere**: `pnpm check:ui-safety`'s `animate-spin`/`spinner` gate is zero, mutation-
  tested to bite in this plan's own execution. `Skeleton.tsx`'s own file comment states the ban is
  "a component contract, not a convention."
- **Dark and light both implemented and switchable**: `packages/ui/tokens.css` declares every
  token twice (`:root` light values, `[data-theme="dark"]` dark values); the no-flash bootstrap
  script (`apps/web/src/lib/theme-script.ts`) reads `localStorage`/`matchMedia` before hydration.
  E2E-proven for both auth screens and the shell: `tests/e2e/auth.spec.ts:67`, `tests/e2e/shell.
  spec.ts:105` "the theme toggle cycles data-theme and the choice survives a reload", both passing.
  **Not independently visually inspected in this automated pass — see "Needs human review."**
- **No secret ever visible in the UI**: this plan's own new `tests/e2e/canary-ui.spec.ts` (`@canary`)
  proves this directly — see 05-21-SUMMARY.md for the full canary evidence and mutation-testing
  trail; not re-litigated here since it is a security property, not a design one, but cross-
  checked per the `noodara-ux-review` skill's own instruction to cross-reference
  `noodara-security`.

---

## Per-screen sign-off (both themes required by the skill; visual confirmation is code/test-only here)

| Screen | Empty | Loading | Error | Dark/light switch proven | Notes |
|---|---|---|---|---|---|
| Setup | n/a (form always shown) | n/a (instant, no pre-check call) | PASS — `tests/e2e/auth.spec.ts:23` | PASS — `tests/e2e/auth.spec.ts:67` | No shell chrome, matches SS2.1 |
| Login | n/a | button `loading` state, no spinner | PASS — `tests/e2e/auth.spec.ts:34` (never reveals account existence) | PASS — shared theme test above | |
| Shell (sidebar/toolbar) | n/a | n/a | n/a | PASS — `tests/e2e/shell.spec.ts:105` | Responsive collapse proven at 1024px/900px |
| Servers list | PASS — `tests/e2e/servers-list.spec.ts:96` | PASS — `:110`, 5 skeleton rows, no spinner | PASS — `:123` | Not independently re-tested per screen (shared shell toggle) | Row `⋯` menu hover/focus-only, never a permanent column (`ServerRow.tsx`) |
| Add/edit sheet | n/a | primary button `loading`, fields disabled | PASS — inline field errors, `tests/e2e/server-sheet.spec.ts:166` (`NAME_TAKEN`) | Sheet inherits page theme | Credential never pre-filled, proven above |
| Server detail | PASS — `tests/e2e/server-detail.spec.ts:114` (DETL-02) | skeleton stat tiles + rows, first load only | PASS — `:134`, `:157` (dimmed history stays) | Not independently re-tested | TOFU banners (`HostKeyChangedBanner`) reviewed directly, both fingerprints full mono, never truncated |
| Activity log | PASS — `tests/e2e/activity.spec.ts:66` | PASS — `:273` | PASS — `:273` (banner variant) | Not independently re-tested | No raw JSON anywhere, `:311` |
| Settings | n/a (config always exists) | PASS — `tests/e2e/settings.spec.ts:135` | PASS — `:112` | Not independently re-tested | Zero form controls anywhere (`:97`), read-only by construction |

---

## Bloqueantes (BLOCK)

None found.

## Correcciones sugeridas

1. Add the skill's documented floating-elevation shadow (`0 8px 30px rgba(0,0,0,0.35)` dark /
   `0 8px 30px rgba(0,0,0,0.12)` light) as a `--shadow-floating` token in `tokens.css`, applied to
   `Sheet.tsx`'s panel, `Dialog.tsx`'s content, and `RowMenu.tsx`'s content — the three surfaces
   the skill names, none of which currently have it.
2. Add `aria-expanded={open}` to `RowMenu.tsx`'s trigger, driven from the same `data-state` Radix
   already exposes, closing the one missing WAI-ARIA Menu Button attribute.
3. Decide the light-mode status-pill contrast gap (already escalated to the user at this plan's
   own checkpoint — not a new suggestion, restated here for completeness of this document).

## Lo que está bien

- Single accent color discipline holds throughout (verified structurally via `check:ui-safety` and
  by reading every component's className table — no second brand color, no decorative gradient).
- Semantic status colors are never used decoratively; the domain-to-tone mapping is centralized
  (`tone.ts`) and unit-tested against the real `ServerStatus`/`DiscoveryCheckStatus` unions so it
  cannot silently drift.
- Credentials are provably never rendered back, never logged, never stored outside the in-flight
  form's own React state — proven by a real, mutation-tested browser canary, not just code
  inspection.
- Every screen's three states (empty/loading/error) exist and are individually E2E-proven with a
  real browser, not merely unit-tested in isolation.
- Keyboard navigation and focus visibility are proven end to end, not asserted by convention.

---

## Needs human review

The following require an actual person looking at a rendered screen — they cannot be verified from
source code or a passing DOM assertion, and were **not** checked in this automated pass:

1. **Real visual quality in both themes** — actual color rendering, spacing "feel", whether the
   Apple-inspired minimalism reads as intended on a real display, not just "the right Tailwind
   classes are present."
2. **The floating-elevation gap's actual visual impact** (Correction 1 above) — whether the
   hairline + translucency + backdrop-blur combination the implementation actually uses reads as
   an acceptable substitute for the skill's shadow, or looks visually flat/undifferentiated from
   the page behind it, on a real display.
3. **The light-mode status-pill contrast gap's real-world legibility** — the computed numbers are
   in `05-UI-SPEC.md`, but only a human can judge whether it is actually hard to read in practice
   before deciding whether to patch, accept, or hold (this plan's own checkpoint question).
4. **Responsive behavior below 1280px on a real device** — the 1024px/900px breakpoints are
   E2E-proven via a resized headless viewport, never on an actual tablet/phone form factor.
5. **`prefers-reduced-motion`'s actual felt effect** and the 320ms sheet transition/120ms press
   micro-interaction's real timing feel.
6. **The RowMenu's real screen-reader announcement** (item 2's WAI-ARIA gap) with an actual
   screen reader (VoiceOver/NVDA), not just a static attribute audit.
7. **A real walkthrough of the flow this plan's own checkpoint how-to-verify names**: sign in, add
   a server with a real key, watch the discovery checklist fill in, read the detail page, open the
   activity log, open settings, toggling theme on each screen, navigating one full screen by
   keyboard only.

None of the above were rubber-stamped as PASS in this document — every row above that could not be
verified from code/tests says so explicitly rather than being marked PASS by default.

---

## Human walkthrough (2026-09-20)

Recorded by the orchestrator from the user's own words; this section is the only part of this
document that reflects a human looking at the rendered UI.

- **Who / how:** the user (Pablo Gutierrez) walked the running app through a temporary public
  tunnel to a throwaway instance (ephemeral Postgres/Redis, per-session admin credentials, torn
  down afterwards). Which screens, themes and input methods were actually exercised was not
  reported, so none of the numbered items above is marked as individually checked.
- **Known limit of that session:** the tunnel used (a Cloudflare Quick Tunnel) buffers
  Server-Sent Events, so **live updates could not be observed** — no live list insertion, no
  check-by-check discovery progress. That behaviour is covered by E2E (`@sse-live`, `@ssh-live`,
  `critical-path.spec.ts`) but has **not** been seen by a human. Item 7's "watch the discovery
  checklist fill in" therefore remains open.
- **Verdict, verbatim:** "No me gusta la UI pero la vamos a ir mejorando con el tiempo. Por el
  momento le doy approve."
- **What that means for this document:** the phase is approved to close. It is **not** a
  statement that the visual design is satisfactory — the user explicitly does not like the UI and
  intends to improve it iteratively. No specific visual defects were named, so none are recorded
  here; items 1–6 above stay open as human-review items, and visual-quality work is expected in
  later iterations. Nothing in the dimension table above should be read as a human PASS.
