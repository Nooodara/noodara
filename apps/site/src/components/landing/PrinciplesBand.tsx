// 10-12-PLAN.md Round 1 (D-02a). "How it's built" -- the four security-relevant facts that ship
// today, reusing DELIVERED_CAPABILITIES claims verbatim (never retyped): encrypted-credentials,
// fingerprint-trust, explicit-timeouts, connect-ssh (the "no agent" fact). Same glyph+title+claim
// discipline as FeatureGrid, on its own surface step for section rhythm.
import { CAPABILITY_TITLES, DELIVERED_CAPABILITIES, type CapabilityId } from '../../content/scope';
import { CapabilityGlyph } from './CapabilityGlyph';

const PRINCIPLE_IDS: readonly CapabilityId[] = ['encrypted-credentials', 'fingerprint-trust', 'explicit-timeouts', 'connect-ssh'];

function claimFor(id: CapabilityId): string {
  const entry = DELIVERED_CAPABILITIES.find((candidate) => candidate.id === id);
  if (entry === undefined) throw new Error(`PrinciplesBand: unknown capability id "${id}"`);
  return entry.claim;
}

export function PrinciplesBand() {
  return (
    <div data-testid="principles-band" className="flex flex-col gap-6">
      <h2 className="text-title font-semibold text-ink">How it&apos;s built</h2>
      <div className="grid grid-cols-1 gap-6 min-[900px]:grid-cols-2 min-[1280px]:grid-cols-4">
        {PRINCIPLE_IDS.map((id) => (
          <div key={id} className="flex flex-col gap-2">
            <CapabilityGlyph id={id} />
            <h3 className="text-headline font-semibold text-ink">{CAPABILITY_TITLES[id]}</h3>
            <p className="text-body font-normal text-ink-secondary">{claimFor(id)}</p>
          </div>
        ))}
      </div>
    </div>
  );
}
