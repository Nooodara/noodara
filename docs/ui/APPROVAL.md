# UI redesign approval record

Per UI-12 (D-13), the phase's rediscovery of `docs/ui-build-prompt.md`'s Apple-grade surface
craft — floating elevation, materials, movement with purpose, the two authored moments — is
reviewed by a human at three blocking gates before it is considered done, each against the six
redesigned screens plus the `Sheet`/`Dialog`/`RowMenu`/`AccountMenu` overlays, in both themes, at
375/900/1280/1920px, captured by `pnpm ui:review` against real fixture data (D-12).

- **G1 — Baseline**: the six screens plus overlays, captured before a single line of CSS changes.
  Gives the before/after; the user's notes on this baseline feed the surfaces plans that follow.
- **G2 — Direction**: after P0, `InsetGroup` and the shell (floating elevation, `RowMenu` fixed,
  accessibility fallbacks, `AccountMenu`, `NavTree`, the `@inspector` slot). The visual direction
  is approved here, before any further investment in motion. Includes a real screen-reader pass
  and a live drag-feel review for whatever is already built (D-14).
- **G3 — Final**: after P1/P2 and the authored moments (Sheet drag-to-dismiss, the Viewfinder ring,
  `Fingerprint` diff, the full motion table), tested live in the running app.

Each gate allows up to two adjustment rounds (D-13, mirroring Phase 7's D-16 ceiling). Until a
gate is actually approved, its block below carries `pending` in the Date/Rounds used/Approver
cells — `tests/unit/ui/approval-record.test.ts` only requires the rows to exist and be
well-formed, never that they are filled, so this record is green from this plan onward and stays
green as the gate plans (08-02, 08-11, 08-19) fill each block in.

## G1 — Baseline

| Field | Value |
| --- | --- |
| Gate | G1 — Baseline |
| Date | 2026-09-25 |
| Rounds used | 0 |
| Approver | Pablo Gutierrez |
| Evidence | docs/ui/approved/ — the six screens, both themes, at 1280px, copied from the 54-capture review round (48 screens + 6 overlays, all four widths, both themes) in `docs/ui/review/` |

### Adjustment log

- **Round 1: none — approved on the first pass.**
- **Round 2: none.**

## G2 — Direction

| Field | Value |
| --- | --- |
| Gate | G2 — Direction |
| Date | 2026-09-26 |
| Rounds used | 1 |
| Approver | Pablo Gutierrez |
| Evidence | docs/ui/approved/ — the six screens, both themes, at 1280px, copied from the post-round-1 review round (56-capture round in `docs/ui/review/`); 118/118 E2E and 2686/2686 unit tests green at approval time |

### Adjustment log

- **Round 1: three display defects found during the pre-gate pixel audit, fixed and re-verified.**
  1. `Toolbar.tsx` scoped its motion-safe transition to `border-color` only (was
     `transition-colors`, which bundled `background-color` into the theme-switch fade — a stray
     grey/near-white band across the toolbar in dark-theme captures, P17). RED `f4c06fc`, GREEN
     `b5c26f6`.
  2. `ServerDetailToolbar.tsx`'s title wrapper and its `h1` gained `min-w-0` so the flex item
     participates correctly in the shrink calculation next to `StatusPill`/the primary action
     button. RED `f4c06fc`, GREEN `b5c26f6`. Re-capture confirms the same truncation depth
     persists at 375px for this fixture's 19-character name — the real constraint is the space
     already claimed by the back link, `StatusPill` and the primary action button at that width,
     not a min-width computation bug; see `deferred-items.md` for the residual note and follow-up.
  3. `ServerFacts.tsx`'s stat tile grid stacks to a single column below 480px
     (`min-[480px]:grid-cols-2 sm:grid-cols-4`, was a fixed `grid-cols-2`), so the widest mono
     value ("176.3 GB of 910.7 GB") fits on one line at 375px instead of wrapping across three.
     RED `f4c06fc`, GREEN `b5c26f6`.
- **Round 2: none.**

### Screen reader

Not performed by the user at this gate — the delegated "G2 adjust, then approved" resolution
covered the recommended visual-defect round only. UI-04's screen-reader pass on `RowMenu` and
`AccountMenu` remains open and is deferred to G3 (see `08-HUMAN-UAT.md` §G2 and
`.planning/phases/08-redise-o-de-la-app/deferred-items.md`).

## G3 — Final

| Field | Value |
| --- | --- |
| Gate | G3 — final |
| Date | 2026-09-26 |
| Rounds used | 1 |
| Approver | Pablo Gutierrez |
| Evidence | docs/ui/approved/ — the six screens, both themes, at 1280px, copied from the post-round-1 review round in `docs/ui/review/`; 143/143 E2E and `pnpm test:e2e:repeat` 20/20 green at approval time |

**Brand-swap verdict**: not supplied in words; the user approved after a live session of the
production build (discovery narration and Fingerprint block both on screen, reached through a
public tunnel per `08-HUMAN-UAT.md`'s local-stack recipe). No explicit per-moment verdict was
recorded — see `08-HUMAN-UAT.md` §G3 and `deferred-items.md` for the honest accounting.

**Drag calibration**: `DRAG_CLOSE_VELOCITY_PX_PER_S = 110` (px/s) and `dragElastic={0.15}`
(`packages/ui/src/Sheet.tsx`) — the final, unchanged values from before this gate. These are
measured, not derived: `tests/e2e/server-sheet.spec.ts`'s `@sheet-drag` suite exercises the real
spring/rubber-band behaviour against genuine timestamped `pointermove` samples (progressive
resistance, a short fast flick closing below the half-width threshold, a slow short drag snapping
back, and mid-flight re-grab resuming from the panel's current position) — all green in the
143/143 E2E run at this gate. No retune was requested or applied in the G3 adjustment round.

### Adjustment log

- **Round 1: five layout/shell items from the user's live "G3 adjust" reply, applied and
  re-verified (commits `9666793`…`94f141a`):**
  1. `ServerFacts.tsx`/`SettingsGroups.tsx` rows gained a `px-4` inset to match `InsetGroup`'s own
     convention on server detail and settings. RED `9666793`/`9c43137`, GREEN `afbb79f`.
  2. The sidebar gained `sticky` positioning instead of scrolling away with the page. RED
     `f0144e2`, GREEN `ad64e23`.
  3. The `DiscoverySection` moved above the stat tiles on `/servers/:id` so the discovery
     narration is the first thing on screen. RED `f0464e5`, GREEN `5dc5b32`.
  4. The account-menu trigger's hover state was re-centred on the avatar in the icon rail. RED
     `077d4bd`, GREEN `82391b0`.
  5. D-05 changed: Appearance moved out of `AccountMenu` into a new Appearance `InsetGroup` on
     `/settings` (see "Decisions changed at G3" in `deferred-items.md`). RED `db18531`/`0ad9d98`,
     GREEN `efe90da`/`9b7f447`/`040e4b7`, recorded `94f141a`.
- **Round 2: none.**

## Phase 9 — Settings editables

| Field | Value |
| --- | --- |
| Gate | Phase 9 — Settings editables |
| Date | 2026-09-27 |
| Rounds used | 1 |
| Approver | Pablo Gutierrez |
| Evidence | `docs/ui/review/` — settings and login captures in both themes at 375/900/1280/1920px, plus sheet-open (Name/Email/Password) and account-menu-open captures; `docs/ui-reviews/settings-editables-2026-09.md` (nine-dimension PASS verdict, one FLAG found and fixed pre-approval) |

### Adjustment log

- **Round 1: three mobile-only defects found by the reviewer on a real iPhone 16 Pro Max (440x956) after the initial approval request, fixed and re-verified (commits `48e2d35`..`5faf1b2`, `3cbb884`, `461245d`):**
  1. `RowMenu.tsx`'s open content was clipped by `InsetGroup`'s `overflow-hidden` ancestor at 440px, appearing to hide the row. Fixed by rendering the menu content through a `DialogPrimitive.Portal` at a `position: fixed`, viewport-aware coordinate measured from the trigger. RED `451be64`, GREEN `a186e66`.
  2. `Sheet.tsx`'s panel was a fixed `w-[480px]`, overflowing a 440px viewport and cutting off labels. Fixed to `w-full max-w-[480px]`, with the drag-dismiss threshold reading the panel's real measured width instead of the hardcoded constant. RED `93ef31b`, GREEN `1c339bb`.
  3. `NavTree.tsx` hid labels below 1280px, including the <900px hamburger drawer, when the hidden range was only meant to cover the 900-1279px icon rail. Fixed to show the label by default, hidden only in the 900-1279px rail. RED `48e2d35`, GREEN `6f522c8`.
  - Three new/updated E2E specs (`5faf1b2`) were written for the three fixes and confirmed passing in the full `pnpm test:e2e` run; the report's adjustment-round section was updated (`3cbb884`), and one spec's row-menu assertion was corrected to match the row's exact primary text (`461245d`).
  - Reviewer's final reply: "Listo, todo bien ahora. De lujo" (approved).
- **Open, deferred (not a defect of this phase, no action taken):** at 440px the server row truncates the name to "t…" and the status pill to "Unreac" — a Phase 8 row-layout constraint, not introduced by this plan.
- **Round 2: none.**

## Phase 10 — Public site

| Field | Value |
| --- | --- |
| Gate | Phase 10 — Public site |
| Date | pending |
| Rounds used | pending |
| Approver | pending |
| Evidence | `docs/ui/review/site/` — landing and docs captures in both themes at 375/900/1280/1920px, plus a reduced-motion landing capture, produced by `pnpm ui:review:site`; `docs/ui-reviews/public-site-2026-09.md` (per-dimension PASS/FLAG/BLOCK verdicts) |

### Adjustment log

- **Round 1: landing redesign per user feedback at the human checkpoint ("muy simplona"),
  applying `impeccable`/Emil Kowalski's skills with dokploy.com/coolify.io as structural
  references (`10-12-ROUND1-BRIEF.md`, D-02a/D-18a, commits `227b4f2`…`f1a12f9`):**
  1. Three-pillar section replaced by a hairline `FeatureGrid` over all 11
     `DELIVERED_CAPABILITIES` (two new: `encrypted-credentials`, `explicit-timeouts`) and a tabbed
     `ProductTour` over the six approved captures (`setup`/`login`/`servers`/`server-detail`/
     `activity`/`settings`, `role=tablist` with arrow-key navigation). RED `451360a`, GREEN
     `1c99aca`/`991262a`.
  2. Added `PrinciplesBand` ("How it's built"), a native `<details>` `FAQSection`, and a
     `ClosingCta` band re-rendering the install command (now appears twice on the page).
  3. Hero: fact-based eyebrow line, a fluid hero-only display size (local CSS var, `--space`-scale
     token set unchanged), a one-shot clip-path reveal on the screenshot.
  4. `SiteFooter` rebuilt to four columns (one per D-08 docs group + the original Project column).
  5. Once-only scroll reveal via a new `useScrollReveal` hook (`apps/site/src/lib/`, kept out of
     `components/landing/` so the source scan stays meaningful) wrapping below-fold sections.
  6. Fix batch found in the first `pnpm ui:review:site` capture round, applied in the same round
     per the bounded-verification process (commit `f1a12f9`): the hero's fluid size was being
     parsed as a Tailwind color utility instead of font-size (fixed with a `length:` type hint);
     `useScrollReveal` gained a 400ms fallback timer after full-page captures showed whole
     sections staying invisible (Playwright's `fullPage` screenshot never fires a real
     scroll/resize event, so an unconditional hide-until-intersect left them permanently hidden);
     the FAQ's `list-none` had removed the native `<details>` disclosure triangle with no
     replacement, so a visible rotating chevron was added.
  7. Full gate re-run green after the fix batch (see `docs/ui-reviews/public-site-2026-09.md`'s
     Round 1 section for the exact commands/results).
- **Round 2: none.**

## What this record gates

D-13: no gate's own wave of work is considered complete until its block above is filled in with a
real date, approver and rounds count, and `tests/unit/ui/approval-record.test.ts` keeps this file
and the real `docs/ui/approved/` contents in agreement. `docs/ui/review/` is regenerated scratch
by `pnpm ui:review` and is gitignored.
