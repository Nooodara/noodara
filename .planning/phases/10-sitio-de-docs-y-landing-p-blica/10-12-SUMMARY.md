---
phase: 10-sitio-de-docs-y-landing-p-blica
plan: 12
subsystem: landing
tags: [ux-review, approval-gate, landing-redesign, tabs-a11y, scroll-reveal, docs-nav]

requires:
  - phase: 10-11
    provides: "Landing.tsx composition, Hero/SiteHeader/SiteFooter/ScopeBlock/PillarCard/HowItWorksDiagram, the real / route"
  - phase: 10-03
    provides: "docs/ui/APPROVAL.md format (G1/G2/G3/Phase 9 block precedent)"
  - phase: 10-04
    provides: "scripts/ui/capture-site-review.ts, review-paths.ts's SITE_PAGES/siteReviewPngPath"
provides:
  - "docs/ui-reviews/public-site-2026-09.md: full nine-round UX/security review (initial audit + Round 1 redesign + orchestrator fix batch)"
  - "docs/ui/APPROVAL.md 'Phase 10 — Public site' block: approved 2026-09-28, 1 round"
  - "Redesigned landing: FeatureGrid (9 cells, apps/site/src/content/feature-grid.ts), ProductTour (6-tab role=tablist), compact numbered HowItWorksDiagram, FAQSection, ClosingCta, 4-column SiteFooter (apps/site/src/lib/docs-nav.ts)"
  - "apps/site/src/lib/use-scroll-reveal.ts: once-only, viewport-aware scroll reveal hook"
affects: [11, 13]

tech-stack:
  added: []
  patterns:
    - "Content arrays that must never end up ragged in a fixed-column CSS grid (FeatureGrid) declare their own cell count and column count as named exports (feature-grid.ts's FEATURE_GRID_CELLS/FEATURE_GRID_DESKTOP_COLUMNS) and throw at module load if the count stops dividing evenly -- a build-time guard, not just a test."
    - "A module read by both Vitest/tsx (unbundled ESM, import.meta.dirname works regardless of cwd) and next build (bundled Server Component graph, import.meta.dirname does not survive bundling) resolves its own directory by trying import.meta.dirname first, falling back to process.cwd(), and picking whichever exists on disk (docs-nav.ts) -- next.config.mjs's own import.meta.dirname use is safe only because Node runs that file directly, unbundled."
    - "A scroll-linked motion hook must never hide content that could plausibly never re-intersect (a static full-page screenshot capture, a no-scroll session, an environment where IntersectionObserver silently never fires): useScrollReveal only ever hides a node whose bounding rect already starts below the initial viewport, and prefers-reduced-motion skips hiding entirely -- the previous version's blanket hide-then-timer-reveal both flickered visible content and depended on the capture tool's own screenshot mechanics to ever un-hide anything."
    - "scripts/ui/capture-site-review.ts scrolls the page in fixed steps and back to top before every fullPage screenshot -- Playwright's fullPage capture renders content beyond the configured viewport without firing a real scroll/resize event, so any IntersectionObserver-driven UI needs this to be exercised honestly in a capture."

key-files:
  created:
    - apps/site/src/content/feature-grid.ts
    - apps/site/src/content/feature-grid.test.ts
    - apps/site/src/lib/docs-nav.ts
    - apps/site/src/lib/docs-nav.test.ts
    - apps/site/src/lib/use-scroll-reveal.ts
    - apps/site/src/lib/use-scroll-reveal.test.tsx
    - apps/site/src/components/landing/FeatureGrid.tsx
    - apps/site/src/components/landing/ProductTour.tsx
    - apps/site/src/components/landing/FAQSection.tsx
    - apps/site/src/components/landing/ClosingCta.tsx
    - apps/site/src/components/landing/CapabilityGlyph.tsx
    - apps/site/src/components/landing/RevealSection.tsx
    - .planning/phases/10-sitio-de-docs-y-landing-p-blica/10-12-ROUND1-BRIEF.md
  modified:
    - apps/site/src/components/landing/Landing.tsx
    - apps/site/src/components/landing/Hero.tsx
    - apps/site/src/components/landing/SiteFooter.tsx
    - apps/site/src/components/landing/HowItWorksDiagram.tsx
    - apps/site/src/components/landing/ScreenshotFrame.tsx
    - apps/site/src/content/scope.ts
    - apps/site/src/lib/site-facts.ts
    - apps/site/scripts/sync-site-assets.mjs
    - apps/site/src/app/global.css
    - scripts/ui/capture-site-review.ts
    - docs/ui/APPROVAL.md
    - docs/ui-reviews/public-site-2026-09.md
    - .planning/phases/10-sitio-de-docs-y-landing-p-blica/10-CONTEXT.md
    - .planning/phases/10-sitio-de-docs-y-landing-p-blica/10-UI-SPEC.md
  deleted:
    - apps/site/src/components/landing/PillarCard.tsx
    - apps/site/src/components/landing/PrinciplesBand.tsx

key-decisions:
  - "D-02a (Round 1 amendment): the three-pillar section became a FeatureGrid (every DELIVERED_CAPABILITIES claim) plus a tabbed ProductTour over the six approved captures -- per the user's checkpoint feedback that the original landing was 'muy simplona', taking dokploy.com/coolify.io as structural references only (never their dark/glow visual language, banned by CLAUDE.md SS5)."
  - "D-18a (Round 1 amendment): more than one motion moment is now allowed (hero clip-path reveal, once-only scroll reveal, product-tour crossfade, connector stroke-dashoffset draw), all CSS-only, reduced-motion always leaves a static/gentler fallback, never a blank or stuck-hidden state."
  - "Two capabilities added to DELIVERED_CAPABILITIES with real evidence (encrypted-credentials -> credential-store.ts, explicit-timeouts -> exec-with-timeout.ts) rather than inventing landing copy with no backing claim."
  - "FeatureGrid merges appearance+account and encrypted-credentials+explicit-timeouts into one cell each (9 cells total) so the grid's column count always divides its cell count evenly at every breakpoint -- found and fixed only after the orchestrator viewed the actual captures, not caught by any automated gate."
  - "The standalone 'How it's built' PrinciplesBand was removed rather than reworded -- it repeated four FeatureGrid cells verbatim; HowItWorksDiagram absorbed the 'compact numbered sequence' requirement from the original brief instead."
  - "The human approved the redesigned site as an early version ('está en pañales'), explicitly not requesting further changes in this plan -- captured verbatim in the APPROVAL.md Phase 10 block rather than paraphrased."

requirements-completed: [SITE-03, SITE-01, SITE-02, DOCS-01]

duration: ~2h agent time across three work sessions (Task 1 audit, Round 1 redesign + fix batch, approval close-out), spanning a human checkpoint pause
completed: 2026-09-28
---

# Phase 10 Plan 12: Public site UX review, Round 1 redesign, and human approval Summary

**The public site's initial audit (9/9 dimensions PASS) was followed by a full landing redesign after the human found it "muy simplona" at checkpoint -- a hairline FeatureGrid, tabbed ProductTour, FAQ, and a compact numbered "How it works" replaced the original three-pillar layout -- then a second, orchestrator-driven fix batch corrected six defects only visible in the actual capture screenshots (reveal flicker, a ragged grid, a weak default tour tab, a duplicate content band, an oversized diagram, a one-link-per-group footer) before the human approved the site as an intentionally early version.**

## Performance

- **Duration:** ~2h agent time (see frontmatter note on session structure)
- **Completed:** 2026-09-28
- **Tasks:** 2/2 (Task 1: audit + gate; Task 2: human approval, extended through two redesign rounds before the human signed off)
- **Files modified:** 34 (13 created, 19 modified, 2 deleted)

## Accomplishments

- **Task 1 (initial audit):** `docs/ui-reviews/public-site-2026-09.md` recorded a 12/12-dimension PASS against the landing as it existed after Plan 11, plus a full security review (workflow pins, credential/attribution scans, `security:scan-leaks`) and a complete gate run (lint, typecheck, 3231 unit tests, boundaries, `check:ui-safety`, provenance, site build, boot smoke, 174/175 E2E with one pre-existing flake logged). `docs/ui/APPROVAL.md` gained a pending "Phase 10 — Public site" block.
- **Checkpoint (Task 2, first pass):** the human viewed the captures and replied "esta muy simplona" (too plain), pointing at dokploy.com/coolify.io as structural references and naming the `impeccable`/Emil Kowalski skills. Not approved -- became Round 1.
- **Round 1 redesign:** replaced the three-pillar section with `FeatureGrid` (every `DELIVERED_CAPABILITIES` claim, hairline shared-border grid) and `ProductTour` (a `role="tablist"` of the six approved captures, arrow-key navigation); added `PrinciplesBand`, `FAQSection` (native `<details>`), `ClosingCta`; rebuilt `SiteFooter` to four columns; gave `Hero` a fact-based eyebrow, a fluid display size, and a one-shot clip-path screenshot reveal; wrapped below-fold sections in a new `RevealSection`/`useScrollReveal` once-only scroll reveal. A same-round fix batch corrected a Tailwind arbitrary-value bug (the hero's font-size was being parsed as a color utility), a missing FAQ disclosure affordance, and a reveal hook that left whole sections permanently invisible in the capture (added, then later removed, a 400ms fallback timer -- see next bullet).
- **Orchestrator review fix batch (second pass, before human re-review):** viewing the Round 1 captures directly surfaced six further defects no automated gate could catch: reveal flicker (rewrote `useScrollReveal` to only hide already-below-fold nodes and never hide under reduced motion, dropped the fallback timer, taught `capture-site-review.ts` to scroll the page for real before each `fullPage` screenshot); a ragged 11-cell/3-column FeatureGrid (merged two evidenced-capability pairs into one cell each, `feature-grid.ts`, reaching an even 9); ProductTour defaulting to the sparsest capture (`setup`) instead of the densest (`servers`), plus an unbounded panel frame and no mobile scroll affordance (reordered tabs, capped frame width, added a `mask-image` edge fade); a `PrinciplesBand` that duplicated four `FeatureGrid` cells verbatim (removed); an oversized `HowItWorksDiagram` still at full 1120px width (compacted to a centered `max-w-[520px]` numbered three-step sequence with once-only `stroke-dashoffset` connectors); and a footer showing one link per docs group (new `docs-nav.ts` reads every real page from `meta.json` + MDX frontmatter).
- **Human approval:** the human approved on 2026-09-28 with the verdict "esta en pañales... la vamos a ir mejorando" (early-stage, will keep improving) -- recorded verbatim in `docs/ui/APPROVAL.md`, not a request for further work in this plan.

## Task Commits

1. **Task 1: Audit, full gate, UX/security review report** -- `8fcd635` (test), `09803de` (feat), `6084fcd` (docs)
2. **Checkpoint feedback + Round 1 redesign:**
   - `afe4819` (docs: brief), `227b4f2` (docs: UI-SPEC amendment)
   - `451360a` (test: RED for Round 1), `90a1617`/`57cfb54` (feat: scroll-reveal hook), `1c99aca`/`991262a` (feat: GREEN, feature grid/tour/FAQ/footer), `f1a12f9` (fix: same-round capture defects)
   - `5384f63` (docs: Round 1 report)
3. **Orchestrator review fix batch:** `d8f2aaf` (test: RED for 6 defects), `72f3ad0` (fix: GREEN), `1626b65` (docs: fix-batch report)
4. **Human approval close-out:** `f3e307d` (docs: APPROVAL.md filled in), this plan's own metadata commit below

_TDD throughout: every behavior-adding change has a RED commit (failing test against the not-yet-built component/hook/content module) followed by a GREEN commit, confirmed by running the affected test files before writing implementation each time._

## Files Created/Modified

See `key-files` in the frontmatter for the full list. Highlights: `apps/site/src/content/feature-grid.ts` (the 9-cell, no-ragged-row grid content, with a module-load throw guard), `apps/site/src/lib/docs-nav.ts` (footer's per-group page lists, read from real `meta.json`/frontmatter), `apps/site/src/lib/use-scroll-reveal.ts` (the final, viewport-aware reveal hook), `apps/site/src/components/landing/ProductTour.tsx` (accessible tabs, visual-strength tab order), `docs/ui/APPROVAL.md` and `docs/ui-reviews/public-site-2026-09.md` (the full review/approval record).

## Decisions Made

See `key-decisions` in the frontmatter. In short: the redesign added structure (feature grid, tabs, FAQ) the user asked for while keeping every locked rule (one accent, no shadows/gradients, approved captures only, honesty-tested claims) intact; two new capabilities were added with real evidence rather than invented copy; every defect found by actually looking at the rendered captures (both rounds) was fixed in the same batch it was found, never deferred as a "known issue" when it was fixable within scope.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] Tailwind arbitrary-value ambiguity silently broke the hero's display size**
- **Found during:** Round 1 first capture round
- **Issue:** `text-[var(--site-hero-display-size)]` was parsed by Tailwind as a `color` utility (ambiguous inference between color/font-size for a bare `var()`), not `font-size` -- the fluid headline silently rendered at its old, small size with no build error.
- **Fix:** `text-[length:var(--site-hero-display-size)]`, confirmed against the built CSS output.
- **Files modified:** `apps/site/src/components/landing/Hero.tsx`
- **Committed in:** `f1a12f9`

**2. [Rule 1 - Bug] useScrollReveal left whole sections permanently invisible in the capture pipeline**
- **Found during:** Round 1 first capture round, then again (differently) in the orchestrator's own review of those captures
- **Issue:** The hook unconditionally hid every wrapped section on mount; Playwright's `fullPage` screenshot never fires a real scroll/resize event, so intersection never fired and content stayed hidden. First fix (a 400ms fallback timer) masked the symptom but also made every already-visible section flicker visible -> hidden -> visible. Second fix (orchestrator review) addressed the root cause.
- **Fix:** Only hide a node whose bounding rect starts below the initial viewport; skip hiding entirely under `prefers-reduced-motion`; teach the capture script to scroll the real page before each screenshot instead of relying on a timer.
- **Files modified:** `apps/site/src/lib/use-scroll-reveal.ts`, `scripts/ui/capture-site-review.ts`
- **Committed in:** `f1a12f9` (first fix), `72f3ad0` (root-cause fix)

**3. [Rule 1 - Bug] `next build` failed after adding docs-nav.ts's `import.meta.dirname` resolution**
- **Found during:** Building the footer fix (orchestrator review item 6)
- **Issue:** `import.meta.dirname` does not survive Next's own webpack/Turbopack bundling of this Server Component's module graph, unlike the same symbol's safe use in `next.config.mjs` (Node runs that file directly, unbundled) -- `next build` failed with `path.join(undefined, ...)`.
- **Fix:** Resolve `content/docs` by trying `import.meta.dirname` first (works under Vitest/tsx), falling back to `process.cwd()` (reliable under `next build`), picking whichever path exists on disk.
- **Files modified:** `apps/site/src/lib/docs-nav.ts`
- **Committed in:** `72f3ad0`

**4. [Rule 2 - Missing Critical] FAQ's `list-none` removed the only visible expand/collapse affordance**
- **Found during:** Round 1 first capture round
- **Issue:** `list-none` on `<summary>` correctly removed the browser's own disclosure triangle (per the design intent) but nothing replaced it -- the FAQ questions looked like static, non-interactive text.
- **Fix:** Added a visible chevron (`group-open:rotate-180`, CSS transition only).
- **Files modified:** `apps/site/src/components/landing/FAQSection.tsx`
- **Committed in:** `f1a12f9`

---

**Total deviations:** 4 auto-fixed (3 bugs, 1 missing-critical-affordance). All four were found by actually running the build/capture pipeline and looking at the result, not by any static gate -- every gate (lint/typecheck/unit/`check:ui-safety`) was already green when each defect was present, which is the reason this plan went through two full capture-and-fix rounds instead of one.
**Impact on plan:** No scope creep -- every fix was necessary for the shipped page to work/look as the plan and brief already specified, not new functionality.

## Issues Encountered

- 11 `DELIVERED_CAPABILITIES` is a prime number, so no fixed grid column count divides it evenly -- resolved by merging two real, evidenced-capability pairs into one cell each (not by inventing a 12th capability, which the orchestrator's own review explicitly ruled out).
- Two rounds of "build -> capture -> view -> fix" were needed because several defects (reveal flicker, ragged grid, weak default tab, duplicate band, oversized diagram, sparse footer) were only visible by looking at the rendered screenshots, not detectable by any of the automated gates (which stayed green throughout).

## User Setup Required

None -- no external service configuration required.

## Next Phase Readiness

- Phase 10 is complete and approved. `docs/ui/APPROVAL.md`'s "Phase 10 — Public site" block is filled in (Date 2026-09-28, Rounds used 1, Approver Pablo Gutierrez).
- Carried-over, explicitly not fixed in this plan (Rule 4 / architectural, left for the user's own future call, noted in both the APPROVAL.md block and the review report):
  1. Hero and ProductTour captures show Phase 8 fixture data (`ui-review-connected`, `ui-review-error`, a long `axxx…` hostname) -- the contractually required approved capture (D-17), not a new capture this plan may substitute.
  2. Footer reads `v0.1.0` (build-time from git tag / `package.json` fallback) while the in-progress milestone is v0.2 -- a release-process decision, not a code bug.
  3. The ProductTour's default `servers` tab and the Hero both show the same approved Servers capture -- intentional (both need the most populated screen), but means the same image appears twice on the page; revisiting this would mean either accepting the duplication or a new capture/approval round, outside this plan's scope.
- The human's own verdict is explicit: the site is an early version, expected to keep improving as future phases add real product surface (deploy engine, domains/HTTPS, observability) -- no action item from this plan, just documented expectation-setting for whoever revisits `apps/site` next.

---
*Phase: 10-sitio-de-docs-y-landing-p-blica*
*Completed: 2026-09-28*

## Self-Check: PASSED

All 13 key-files listed as created were verified present on disk; both deleted files
(`PillarCard.tsx`, `PrinciplesBand.tsx`) were verified absent. All 16 commit hashes cited above
were verified present in `git log --all`.
