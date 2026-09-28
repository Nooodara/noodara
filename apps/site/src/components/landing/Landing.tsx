// 10-11-PLAN.md Task 2 (D-01..D-06, D-18, SITE-01), redesigned 10-12-PLAN.md Round 1 (D-02a/
// D-18a), further fixed in the orchestrator's Round 1 review batch (items 1/3/4/5 -- see each
// component's own file for detail). Composes the landing at `/` from tested parts only:
// SiteHeader, Hero (now including the D-04 positioning line in its own tight rhythm, not a
// separately-gapped floating paragraph), FeatureGrid (every DELIVERED_CAPABILITIES claim across 9
// cells), ProductTour (the six approved captures, ordered by visual strength), "How it works"
// (HowItWorksDiagram, now a compact numbered sequence -- the standalone "How it's built" band was
// removed, it repeated four FeatureGrid cells word for word), FAQSection, ScopeBlock, ClosingCta,
// SiteFooter -- alternating --canvas/--surface-1 section backgrounds instead of one flat page,
// within the UI-SPEC's --space-8 / --site-section-gap-lg vertical rhythm. Landing.test.tsx proves
// the whole thing claims only what DELIVERED_CAPABILITIES/scope.ts already assert, and that no
// claim's exact text is duplicated by a second full section.
//
// RevealSection wraps the sections below the fold in the once-only scroll reveal (D-18a) -- the
// hero and positioning line stay unwrapped (already on screen at first paint, nothing to reveal).
import { SiteHeader } from './SiteHeader';
import { Hero } from './Hero';
import { FeatureGrid } from './FeatureGrid';
import { ProductTour } from './ProductTour';
import { HowItWorksDiagram } from './HowItWorksDiagram';
import { FAQSection } from './FAQSection';
import { ScopeBlock } from './ScopeBlock';
import { ClosingCta } from './ClosingCta';
import { SiteFooter } from './SiteFooter';
import { RevealSection } from './RevealSection';

const SECTION_GAP_CLASSES =
  'flex flex-col gap-8 py-8 min-[1280px]:gap-[var(--site-section-gap-lg)] min-[1280px]:py-[var(--site-section-gap-lg)]';

export function Landing() {
  return (
    <>
      <SiteHeader />
      <main>
        <div className="bg-canvas">
          <div className={`mx-auto max-w-[1120px] px-6 min-[900px]:px-8 ${SECTION_GAP_CLASSES}`}>
            <div className="flex flex-col gap-6">
              <Hero />
              <p className="text-title font-semibold text-ink">
                Most panels manage your servers. Noodara helps you understand them.
              </p>
            </div>
          </div>
        </div>
        <div className="bg-surface-1">
          <div className={`mx-auto max-w-[1120px] px-6 min-[900px]:px-8 ${SECTION_GAP_CLASSES}`}>
            <RevealSection>
              <FeatureGrid />
            </RevealSection>
          </div>
        </div>
        <div className="bg-canvas">
          <div className={`mx-auto max-w-[1120px] px-6 min-[900px]:px-8 ${SECTION_GAP_CLASSES}`}>
            <RevealSection>
              <section className="flex flex-col gap-6">
                <h2 className="text-title font-semibold text-ink">Comprehensive control</h2>
                <ProductTour />
              </section>
            </RevealSection>
            <RevealSection>
              <section className="flex flex-col gap-6">
                <h2 className="text-title font-semibold text-ink text-center">How it works</h2>
                <HowItWorksDiagram />
              </section>
            </RevealSection>
          </div>
        </div>
        <div className="bg-surface-1">
          <div className={`mx-auto max-w-[1120px] px-6 min-[900px]:px-8 ${SECTION_GAP_CLASSES}`}>
            <RevealSection>
              <FAQSection />
            </RevealSection>
          </div>
        </div>
        <div className="bg-canvas">
          <div className={`mx-auto max-w-[1120px] px-6 min-[900px]:px-8 ${SECTION_GAP_CLASSES}`}>
            <ScopeBlock />
            <ClosingCta />
          </div>
        </div>
      </main>
      <SiteFooter />
    </>
  );
}
