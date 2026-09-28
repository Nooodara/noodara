// Round 1 fix batch (orchestrator review, item 2). RED: written before
// feature-grid.ts exists. Pins the "no ragged grid row" contract as a real test, not just a
// module-load throw: cell count divides evenly by the desktop column count, every
// DELIVERED_CAPABILITIES id is covered exactly once, and no invented (unevidenced) id sneaks in.
import { describe, expect, it } from 'vitest';
import { DELIVERED_CAPABILITIES } from './scope';
import { FEATURE_GRID_CELLS, FEATURE_GRID_DESKTOP_COLUMNS } from './feature-grid';

describe('FEATURE_GRID_CELLS', () => {
  it('has a cell count that is an exact multiple of FEATURE_GRID_DESKTOP_COLUMNS (no ragged row)', () => {
    expect(FEATURE_GRID_CELLS.length % FEATURE_GRID_DESKTOP_COLUMNS).toBe(0);
    expect(FEATURE_GRID_CELLS.length).toBeGreaterThan(0);
  });

  it('covers every DELIVERED_CAPABILITIES id exactly once across all cells', () => {
    const allIds = FEATURE_GRID_CELLS.flatMap((cell) => cell.capabilityIds);
    expect(new Set(allIds).size).toBe(allIds.length);
    expect(allIds.sort()).toEqual(DELIVERED_CAPABILITIES.map((c) => c.id).sort());
  });

  it('every cell has at least one capability id and a non-empty title', () => {
    for (const cell of FEATURE_GRID_CELLS) {
      expect(cell.capabilityIds.length).toBeGreaterThan(0);
      expect(cell.title.length).toBeGreaterThan(0);
    }
  });
});
