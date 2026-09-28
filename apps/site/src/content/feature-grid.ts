// Round 1 fix batch (orchestrator review, item 2). 11 DELIVERED_CAPABILITIES in a
// 3-column grid left a ragged, unfinished-looking hole in the last row (11 is prime -- no column
// count divides it evenly except 1 and 11). Fixed by merging two closely-related pairs into one
// cell each (never inventing a new, unevidenced capability): appearance+account become one
// "Personalize your account" cell, encrypted-credentials+explicit-timeouts become one "Secure by
// default" cell. Both merges keep every underlying claim's exact text -- nothing is reworded or
// dropped, a merged cell just lists two claims under one shared title/glyph pairing instead of
// two separate cells. 9 cells is an exact multiple of the one column count FeatureGrid ever uses
// (3, at >=900px) and of 1 (mobile) -- no ragged row at any breakpoint (FeatureGrid.tsx
// deliberately has no 2-column tablet tier for this reason).
import { CAPABILITY_TITLES, DELIVERED_CAPABILITIES, type CapabilityId } from './scope';

export interface FeatureCell {
  readonly title: string;
  readonly capabilityIds: readonly CapabilityId[];
}

export const FEATURE_GRID_DESKTOP_COLUMNS = 3;

export const FEATURE_GRID_CELLS: readonly FeatureCell[] = [
  { title: CAPABILITY_TITLES.install, capabilityIds: ['install'] },
  { title: CAPABILITY_TITLES['connect-ssh'], capabilityIds: ['connect-ssh'] },
  { title: CAPABILITY_TITLES['fingerprint-trust'], capabilityIds: ['fingerprint-trust'] },
  { title: CAPABILITY_TITLES.discovery, capabilityIds: ['discovery'] },
  { title: CAPABILITY_TITLES['server-detail'], capabilityIds: ['server-detail'] },
  { title: CAPABILITY_TITLES['activity-log'], capabilityIds: ['activity-log'] },
  { title: 'Personalize your account', capabilityIds: ['appearance', 'account'] },
  { title: CAPABILITY_TITLES['upgrade-rollback'], capabilityIds: ['upgrade-rollback'] },
  { title: 'Secure by default', capabilityIds: ['encrypted-credentials', 'explicit-timeouts'] },
];

// Fixture-bug guards, checked at module load (mirrors PillarCard/ProductTour's own
// "throw on unknown id" discipline) rather than only in a test -- a future edit to either array
// fails the build immediately instead of silently drifting.
const allCellIds = FEATURE_GRID_CELLS.flatMap((cell) => cell.capabilityIds);
const uniqueCellIds = new Set(allCellIds);
if (uniqueCellIds.size !== allCellIds.length) {
  throw new Error('feature-grid.ts: a capability id appears in more than one FEATURE_GRID_CELLS entry');
}
const allCapabilityIds = new Set(DELIVERED_CAPABILITIES.map((c) => c.id));
for (const id of allCapabilityIds) {
  if (!uniqueCellIds.has(id)) {
    throw new Error(`feature-grid.ts: DELIVERED_CAPABILITIES id "${id}" is missing from FEATURE_GRID_CELLS`);
  }
}
for (const id of uniqueCellIds) {
  if (!allCapabilityIds.has(id)) {
    throw new Error(`feature-grid.ts: FEATURE_GRID_CELLS references unknown capability id "${id}"`);
  }
}
if (FEATURE_GRID_CELLS.length % FEATURE_GRID_DESKTOP_COLUMNS !== 0) {
  throw new Error('feature-grid.ts: FEATURE_GRID_CELLS.length must be an exact multiple of FEATURE_GRID_DESKTOP_COLUMNS');
}
