// 10-09-PLAN.md Task 2 (D-02, T-10-04). One pillar (Connect/Discover/Understand) -- a heading,
// one sentence read from DELIVERED_CAPABILITIES by id (never retyped, so the claim can only ever
// say what 10-06's scope.ts already proves), and one approved capture.
import { DELIVERED_CAPABILITIES, type CapabilityId } from '../../content/scope';
import { ScreenshotFrame } from './ScreenshotFrame';
import type { ApprovedScreen } from '../../lib/site-facts';

export interface PillarCardProps {
  readonly title: string;
  readonly capability: CapabilityId;
  readonly screen: ApprovedScreen;
}

function claimFor(capability: CapabilityId): string {
  const entry = DELIVERED_CAPABILITIES.find((candidate) => candidate.id === capability);
  if (entry === undefined) {
    throw new Error(`PillarCard: unknown capability id "${capability}"`);
  }
  return entry.claim;
}

export function PillarCard({ title, capability, screen }: PillarCardProps) {
  return (
    <div className="rounded-lg border border-hairline bg-surface-1 p-6">
      <h3 className="text-headline font-semibold text-ink">{title}</h3>
      <p className="mt-2 text-body font-normal text-ink-secondary">{claimFor(capability)}</p>
      <div className="mt-4">
        <ScreenshotFrame screen={screen} alt={`${title}: ${claimFor(capability)}`} />
      </div>
    </div>
  );
}
