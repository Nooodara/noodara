// 10-11-PLAN.md Task 2 (D-01..D-06, D-18, SITE-01). Composes the landing at `/` from tested parts
// only: SiteHeader, Hero, the D-04 positioning line, three PillarCards (Connect/Discover/
// Understand, each capture+claim pair fixed by the plan's own interfaces mapping), "How it works"
// (HowItWorksDiagram), ScopeBlock, SiteFooter -- in a 1120px content column with the UI-SPEC's
// --space-8 / --site-section-gap-lg vertical rhythm. Landing.test.tsx proves the whole thing
// claims only what DELIVERED_CAPABILITIES/scope.ts already assert.
import { SiteHeader } from './SiteHeader';
import { Hero } from './Hero';
import { PillarCard } from './PillarCard';
import { HowItWorksDiagram } from './HowItWorksDiagram';
import { ScopeBlock } from './ScopeBlock';
import { SiteFooter } from './SiteFooter';

const SECTION_GAP_CLASSES = 'flex flex-col gap-8 py-8 min-[1280px]:gap-[var(--site-section-gap-lg)] min-[1280px]:py-[var(--site-section-gap-lg)]';

export function Landing() {
  return (
    <>
      <SiteHeader />
      <main className={`mx-auto max-w-[1120px] px-6 min-[900px]:px-8 ${SECTION_GAP_CLASSES}`}>
        <Hero />
        <p className="text-title font-semibold text-ink">
          Most panels manage your servers. Noodara helps you understand them.
        </p>
        <section className="grid grid-cols-1 gap-6 min-[1280px]:grid-cols-3">
          <PillarCard title="Connect" capability="connect-ssh" screen="login" />
          <PillarCard title="Discover" capability="discovery" screen="server-detail" />
          <PillarCard title="Understand" capability="activity-log" screen="activity" />
        </section>
        <section className="flex flex-col gap-6">
          <h2 className="text-title font-semibold text-ink text-center">How it works</h2>
          <HowItWorksDiagram />
        </section>
        <ScopeBlock />
      </main>
      <SiteFooter />
    </>
  );
}
