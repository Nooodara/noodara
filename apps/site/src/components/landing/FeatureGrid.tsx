// 10-12-PLAN.md Round 1 (D-02a). Every DELIVERED_CAPABILITIES entry, once, in a Dokploy-style
// shared-hairline grid: adjoining cells share one 1px border (an outer border plus internal
// dividers), not N individually-rounded cards -- craft-floor.md's "same-size cards" anti-pattern
// is a grid of discrete elevated boxes; this is one continuous grid, no radius, no shadow, no
// per-cell surface step. Server component: no interaction, no motion of its own (Landing.tsx
// wraps it in RevealSection for the once-only scroll reveal, D-18a).
import { CAPABILITY_TITLES, DELIVERED_CAPABILITIES } from '../../content/scope';
import { CapabilityGlyph } from './CapabilityGlyph';

export function FeatureGrid() {
  return (
    <div
      data-testid="feature-grid"
      className="grid grid-cols-1 border border-hairline divide-y divide-[color:var(--hairline)] min-[900px]:grid-cols-2 min-[900px]:divide-x min-[1280px]:grid-cols-3"
    >
      {DELIVERED_CAPABILITIES.map((capability) => (
        <div key={capability.id} className="flex flex-col gap-2 p-6">
          <CapabilityGlyph id={capability.id} />
          <h3 className="text-headline font-semibold text-ink">{CAPABILITY_TITLES[capability.id]}</h3>
          <p className="text-body font-normal text-ink-secondary">{capability.claim}</p>
        </div>
      ))}
    </div>
  );
}
