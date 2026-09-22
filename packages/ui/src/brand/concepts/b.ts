// Concept B -- "Focus".
//
// Baseline construction (07-01 Task 1): the same N skeleton as concept A, with a focal disc of
// TERMINAL_RADIUS where the diagonal lands. Task 2 tapers the diagonal into that point and stops
// the right stem there.
//
// Constants: STROKE drives the stems and the wide end of the diagonal; TERMINAL_RADIUS drives the
// focal disc.

import {
  GRID,
  MARGIN,
  STROKE,
  TERMINAL_RADIUS,
  bar,
  circle,
  conceptMeta,
  diagonalBar,
  type ConceptMeta,
  type PathPart,
} from '../geometry.js';

export const meta: ConceptMeta = conceptMeta('b');

export function parts(): readonly PathPart[] {
  const span = GRID - 2 * MARGIN;
  const inset = MARGIN + STROKE / 2;
  const focal = GRID - inset;
  return [
    { part: 'stem-left', d: bar(MARGIN, MARGIN, STROKE, span) },
    { part: 'stem-right', d: bar(GRID - MARGIN - STROKE, MARGIN, STROKE, span) },
    { part: 'diagonal', d: diagonalBar(inset, inset, focal, focal, STROKE) },
    { part: 'aperture', d: circle(focal, focal, TERMINAL_RADIUS) },
  ];
}
