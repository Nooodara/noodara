// 10-12-PLAN.md Round 1 (D-02a), cell layout fixed in the orchestrator's Round 1 review batch
// (item 2). FEATURE_GRID_CELLS (apps/site/src/content/feature-grid.ts) covers every
// DELIVERED_CAPABILITIES claim across exactly 9 cells -- an exact multiple of the one column
// count this grid ever uses (3, at >=900px; deliberately no 2-column tablet tier, so the grid
// never ends a row short at any breakpoint). Dokploy-style shared-hairline grid: adjoining cells
// share one 1px border (an outer border plus internal dividers), not N individually-rounded
// cards -- craft-floor.md's "same-size cards" anti-pattern is a grid of discrete elevated boxes;
// this is one continuous grid, no radius, no shadow, no per-cell surface step. Server component:
// no interaction, no motion of its own (Landing.tsx wraps it in RevealSection for the once-only
// scroll reveal, D-18a).
import { DELIVERED_CAPABILITIES } from '../../content/scope';
import { FEATURE_GRID_CELLS } from '../../content/feature-grid';
import { CapabilityGlyph } from './CapabilityGlyph';

type FeatureCellIds = (typeof FEATURE_GRID_CELLS)[number]['capabilityIds'];

function claimsFor(ids: FeatureCellIds): string[] {
  return ids.map((id) => {
    const entry = DELIVERED_CAPABILITIES.find((candidate) => candidate.id === id);
    if (entry === undefined) throw new Error(`FeatureGrid: unknown capability id "${id}"`);
    return entry.claim;
  });
}

export function FeatureGrid() {
  return (
    <div
      data-testid="feature-grid"
      className="grid grid-cols-1 border border-hairline divide-y divide-[color:var(--hairline)] min-[900px]:grid-cols-3 min-[900px]:divide-x"
    >
      {FEATURE_GRID_CELLS.map((cell) => (
        <div key={cell.title} className="flex flex-col gap-2 p-6">
          <div className="flex items-center gap-2">
            {cell.capabilityIds.map((id) => (
              <CapabilityGlyph key={id} id={id} />
            ))}
          </div>
          <h3 className="text-headline font-semibold text-ink">{cell.title}</h3>
          {claimsFor(cell.capabilityIds).map((claim) => (
            <p key={claim} className="text-body font-normal text-ink-secondary">
              {claim}
            </p>
          ))}
        </div>
      ))}
    </div>
  );
}
