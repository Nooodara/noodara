// Concept C -- "Viewfinder".
//
// "The letter becomes a viewfinder -- brackets frame the subject and the centre ring is where it
// sharpens."
//
// Construction: the N's two stems, each closed by an inward return at the corner the diagonal
// leaves from, so the skeleton reads as the two corner brackets of a viewfinder. The diagonal
// runs between them and breaks open at the centre, where a small ring marks the point of focus.
//
//   frame      two full-height bars (STROKE wide) plus two returns, each STROKE + APERTURE_RADIUS
//              long and STROKE thick, at the top-left and bottom-right corners
//   diagonal   two diagonalBar segments leaving a gap of APERTURE_RADIUS centred on the grid
//   aperture   ring, outer APERTURE_RADIUS / 2 (so it exactly fills that gap), counter half a
//              stroke inside it

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

export const meta: ConceptMeta = conceptMeta('c');

export function parts(): readonly PathPart[] {
  const span = GRID - 2 * MARGIN;
  const centre = GRID / 2;
  const inset = MARGIN + STROKE / 2;
  const far = GRID - inset;
  const returnLength = STROKE + APERTURE_RADIUS;
  const apertureRadius = APERTURE_RADIUS / 2;
  // Half the gap, projected onto each axis: the diagonal runs at 45 degrees, and the ring's outer
  // edge is exactly where each segment stops.
  const stop = apertureRadius / Math.SQRT2;

  return [
    {
      part: 'frame',
      d: [
        bar(MARGIN, MARGIN, STROKE, span),
        bar(GRID - MARGIN - STROKE, MARGIN, STROKE, span),
        bar(MARGIN, MARGIN, returnLength, STROKE),
        bar(GRID - MARGIN - returnLength, GRID - MARGIN - STROKE, returnLength, STROKE),
      ].join(' '),
    },
    {
      part: 'diagonal',
      d: [
        diagonalBar(inset, inset, centre - stop, centre - stop, STROKE),
        diagonalBar(centre + stop, centre + stop, far, far, STROKE),
      ].join(' '),
    },
    { part: 'aperture', d: ring(centre, centre, apertureRadius, apertureRadius - STROKE / 2) },
  ];
}
