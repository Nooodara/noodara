// Concept A -- "Aperture".
//
// "The diagonal opens into an aperture -- the mark is a lens, and infrastructure is what it
// brings into view."
//
// Construction: a capital N whose diagonal is interrupted at the centre of the grid by a ring.
// The two diagonal segments stop exactly on the ring's outer edge, so the ring is not decoration
// laid over the letter -- it is the opening the letter makes. That opening is the part Phase 8
// animates.
//
//   stem-left  / stem-right  bar, STROKE wide, MARGIN..GRID-MARGIN tall
//   diagonal   two diagonalBar segments, STROKE wide, running corner to corner on the stem
//              centrelines and stopping APERTURE_RADIUS short of the centre at both ends
//   aperture   ring, outer APERTURE_RADIUS, counter APERTURE_RADIUS - STROKE

import {
  APERTURE_RADIUS,
  GRID,
  MARGIN,
  STROKE,
  bar,
  conceptMeta,
  diagonalBar,
  ring,
  type ConceptMeta,
  type PathPart,
} from '../geometry.js';

export const meta: ConceptMeta = conceptMeta('a');

export function parts(): readonly PathPart[] {
  const span = GRID - 2 * MARGIN;
  const centre = GRID / 2;
  // The diagonal runs between the stems' own centrelines, so it meets each stem squarely.
  const inset = MARGIN + STROKE / 2;
  const far = GRID - inset;
  // Where the diagonal meets the ring: APERTURE_RADIUS from the centre, measured along the
  // diagonal itself (which is at 45 degrees, hence the projection onto each axis).
  const stop = APERTURE_RADIUS / Math.SQRT2;

  return [
    { part: 'stem-left', d: bar(MARGIN, MARGIN, STROKE, span) },
    { part: 'stem-right', d: bar(GRID - MARGIN - STROKE, MARGIN, STROKE, span) },
    {
      part: 'diagonal',
      d: [
        diagonalBar(inset, inset, centre - stop, centre - stop, STROKE),
        diagonalBar(centre + stop, centre + stop, far, far, STROKE),
      ].join(' '),
    },
    { part: 'aperture', d: ring(centre, centre, APERTURE_RADIUS, APERTURE_RADIUS - STROKE) },
  ];
}
