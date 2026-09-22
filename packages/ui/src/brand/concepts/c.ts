// Concept C -- "Viewfinder".
//
// Baseline construction (07-01 Task 1): the two stems as a single `frame` part, one diagonal, and
// a small ring at the centre. Task 2 adds the inward corner returns that make the frame read as
// viewfinder brackets and opens the gap in the diagonal the ring sits in.
//
// Constants: STROKE drives the frame and the diagonal; APERTURE_RADIUS / 2 drives the centre
// ring, whose counter is that radius less half a stroke.

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
  const inset = MARGIN + STROKE / 2;
  const far = GRID - inset;
  const apertureRadius = APERTURE_RADIUS / 2;
  return [
    {
      part: 'frame',
      d: [bar(MARGIN, MARGIN, STROKE, span), bar(GRID - MARGIN - STROKE, MARGIN, STROKE, span)].join(' '),
    },
    { part: 'diagonal', d: diagonalBar(inset, inset, far, far, STROKE) },
    { part: 'aperture', d: ring(GRID / 2, GRID / 2, apertureRadius, apertureRadius - STROKE / 2) },
  ];
}
