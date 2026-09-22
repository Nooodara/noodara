// Concept A -- "Aperture".
//
// Baseline construction (07-01 Task 1): a classic N built from two full-height stems and one
// diagonal, with the aperture ring at the centre of the diagonal. Task 2 turns the diagonal into
// the two interrupted segments the concept actually calls for.
//
// Constants: STROKE drives both stems and the diagonal; APERTURE_RADIUS drives the ring, whose
// counter is APERTURE_RADIUS - STROKE.

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
  const inset = MARGIN + STROKE / 2;
  const far = GRID - inset;
  return [
    { part: 'stem-left', d: bar(MARGIN, MARGIN, STROKE, span) },
    { part: 'stem-right', d: bar(GRID - MARGIN - STROKE, MARGIN, STROKE, span) },
    { part: 'diagonal', d: diagonalBar(inset, inset, far, far, STROKE) },
    { part: 'aperture', d: ring(GRID / 2, GRID / 2, APERTURE_RADIUS, APERTURE_RADIUS - STROKE) },
  ];
}
