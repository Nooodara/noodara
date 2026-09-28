# 10-12 · Round 1 — Landing redesign brief

**Source:** user feedback at the 10-12 human checkpoint (2026-09-28): the site is correct but "muy simplona".
Use the **impeccable** skill and **Emil Kowalski's skills** to raise the design, taking **dokploy.com** and
**coolify.io** as references.

Scope: the landing at `/` (and the shared site header/footer). Docs pages keep Fumadocs; touch them only
through shared header/footer/tokens.

## What we take from the references (structure, rhythm, density — not their look)

Captured 2026-09-28 in the orchestrator scratchpad (`refs/dokploy-*.png`, `refs/coolify-*.png`).

- **Dokploy:** oversized centered display headline; eyebrow line; install command right in the hero; large
  product visual under the fold line; **hairline-bordered feature grid** (icon + title + two lines, 4 columns);
  **tabbed product tour** ("Comprehensive Control": tabs swap a big screenshot); FAQ accordion; closing CTA
  band; multi-column footer.
- **Coolify:** blunt one-line promise, dense 3-column icon feature list, open-source/self-hosted framing.
- **Not taken:** stars/download counters, sponsors, testimonials, pricing, cloud plans, comparisons, glows,
  gradient text, background grid glows. Noodara has none of those facts, and CLAUDE.md §5 bans the effects.

## Decisions this round amends (user direction overrides the locked text)

- **D-02 → D-02a.** Three pillars become: a **feature grid** of every capability in `DELIVERED_CAPABILITIES`
  (8–12 cells, hairline grid, own inline SVG glyphs in `currentColor` per D-05) **plus** a **tabbed product
  tour** over the six approved screens (setup, login, servers, server-detail, activity, settings). Still
  only approved captures (D-17), still only what ships.
- **D-18 → D-18a.** More than one motion moment is now allowed, under Emil's rules: purposeful, fast
  (150–300 ms UI, ≤ 500 ms reveals), `ease-out`/custom cubic-bezier, transform/opacity/clip-path only,
  interruptible CSS transitions, once-only scroll reveals (no parallax, no scroll-jacking), springs not
  needed. `prefers-reduced-motion` → no movement, opacity only or static. No motion library: CSS +
  `@starting-style` + one tiny `IntersectionObserver` client hook; no new dependency (provenance gate).
- **New sections allowed:** principles/"how it is built" band (security facts that ship: encrypted
  credentials at rest, verified host fingerprints, explicit timeouts, no agent), **FAQ** (facts only,
  answers tested against `scope.ts`/`site-facts.ts`), **closing CTA band** with the install command,
  **multi-column footer** (Docs groups, Project: GitHub/License/Version). D-06's facts stay (license from
  `LICENSE`, version read at build).

## Stays locked

CLAUDE.md §5 and the UI-SPEC core: one blue action color; semantic colors only for infra state; **no card
or button shadows**; **no decorative gradients, glows or gradient text**; hierarchy by surface step +
hairlines; system font (D-16) with mono for commands; dark and light both first-class (D-15); zero
third-party requests (D-14, `check-export.mjs`); approved captures only (D-17); honesty rules D-03/D-04/D-10
(`content-rules.ts`, `scope.ts`, `Landing.test.tsx`) — every new claim must come from
`DELIVERED_CAPABILITIES`/`site-facts.ts` and be asserted by a test. "What it does not do yet" stays.

## Direction (impeccable "Persuade" mode, `bolder` + `layout` + `typeset` + `animate`)

- **Hero:** display scale (fluid, ~56→88 px, tight tracking, 600 weight), eyebrow
  "Open source · Self-hosted · Apache-2.0"-style facts, one-sentence subhead, install command as the
  primary object, CTAs, then the Servers capture large and full-width below with a clip-path reveal and the
  Viewfinder focus moment (D-18 original motion kept).
- **Rhythm:** alternate surface steps between sections (`--surface-*` tokens) instead of one flat
  background; generous but deliberate vertical rhythm; section eyebrows in small caps/mono.
- **Product tour:** segmented tabs (keyboard: arrow keys, `role=tablist`), crossfade + slight translate
  between captures, `<picture>` light/dark, caption per tab from facts.
- **Feature grid:** Dokploy-style shared hairline borders (no gaps, no shadows), glyph + title + ≤ 2 lines.
- **How it works:** replace the oversized diagram with a compact three-step numbered sequence; the SVG
  connectors can draw once (stroke-dashoffset) on reveal.
- **Mobile 375:** everything stacks; tabs scroll horizontally inside their own row; no page overflow.

## Process

- Read before designing: impeccable `SKILL.md`, `reference/new-work.md` (or `bolder.md`, `layout.md`,
  `typeset.md`, `animate.md`), `reference/craft-floor.md` right before editing; Emil `emil-design-eng`,
  `animate`, `review-animations/STANDARDS.md`. Then the project skills `noodara-ux-apple` and `noodara-tdd`.
- Update `10-UI-SPEC.md` (amendment section "Round 1") and record D-02a/D-18a in `10-CONTEXT.md` first,
  then TDD: tests for new claims/sections/a11y first, then components.
- Bounded verification (impeccable): build, capture once (`pnpm ui:review:site`, desktop + 375, both
  themes, reduced motion), fix in one batch, confirm with at most one more capture round.
- Log this as **Round 1** in the Phase 10 block of `docs/ui/APPROVAL.md` (still `pending` approval) and
  update `docs/ui-reviews/public-site-2026-09.md` with a Round 1 section.

## Note for the human approver (unchanged, not in scope unless asked)

Approved captures show review-fixture names (`ui-review-error`, a long `axxx…` hostname). Fixing that needs a
new capture set and a new approval, so it is left for the user's call.
