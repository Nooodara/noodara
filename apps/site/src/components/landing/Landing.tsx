// 10-11-PLAN.md Task 2 (D-01..D-06, D-18, SITE-01), redesigned 10-12-PLAN.md Round 1 (D-02a/
// D-18a). Composes the landing at `/` from tested parts only: SiteHeader, Hero, the D-04
// positioning line, FeatureGrid (every DELIVERED_CAPABILITIES claim), ProductTour (the six
// approved captures), PrinciplesBand ("how it's built"), "How it works" (HowItWorksDiagram),
// FAQSection, ScopeBlock, ClosingCta, SiteFooter -- alternating --canvas/--surface-1 section
// backgrounds instead of one flat page, within the UI-SPEC's --space-8 / --site-section-gap-lg
// vertical rhythm. Landing.test.tsx proves the whole thing claims only what
// DELIVERED_CAPABILITIES/scope.ts already assert.
//
// RevealSection wraps the sections below the fold in the once-only scroll reveal (D-18a) -- the
// hero and positioning line stay unwrapped (already on screen at first paint, nothing to reveal).
import { SiteHeader } from './SiteHeader';
import { Hero } from './Hero';
import { FeatureGrid } from './FeatureGrid';
import { ProductTour } from './ProductTour';
import { PrinciplesBand } from './PrinciplesBand';
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
            <Hero />
            <p className="text-title font-semibold text-ink">
              Most panels manage your servers. Noodara helps you understand them.
            </p>
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
              <PrinciplesBand />
            </RevealSection>
            <section className="flex flex-col gap-6">
              <h2 className="text-title font-semibold text-ink text-center">How it works</h2>
              <HowItWorksDiagram />
            </section>
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
