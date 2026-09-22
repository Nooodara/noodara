// Concept B -- "Focus".
//
// "Two strokes converge on a single point: the moment a scattered signal resolves into something
// clear."
//
// Construction: a capital N whose diagonal narrows as it descends, from a full stroke at the
// top-left to a terminal at the bottom-right, where the right stem also ends. Everything in the
// letter arrives at that one point, and a small filled disc marks it -- the beam coming into
// focus. The disc is this concept's `aperture` part, so Phase 8 animates the same idea here as in
// the other two.
//
//   stem-left   bar, STROKE wide, full height
//   stem-right  bar, STROKE wide, from the top down to the focal point (not to the box edge)
//   diagonal    one taperedBar, STROKE wide at the top-left, TERMINAL_RADIUS wide at the focus
//   aperture    circle of TERMINAL_RADIUS at the focal point

import {
  GRID,
  MARGIN,
  STROKE,
  TERMINAL_RADIUS,
  bar,
  circle,
  conceptMeta,
  taperedBar,
  type ConceptMeta,
  type PathPart,
} from '../geometry.js';

export const meta: ConceptMeta = conceptMeta('b');

export function parts(): readonly PathPart[] {
  const span = GRID - 2 * MARGIN;
  const inset = MARGIN + STROKE / 2;
  // The focal point sits on the right stem's centreline, one margin above the box edge -- the
  // disc drawn there reaches the baseline without crossing it.
  const focal = GRID - inset;

  return [
    { part: 'stem-left', d: bar(MARGIN, MARGIN, STROKE, span) },
    { part: 'stem-right', d: bar(GRID - MARGIN - STROKE, MARGIN, STROKE, focal - MARGIN) },
    { part: 'diagonal', d: taperedBar(inset, inset, focal, focal, STROKE, TERMINAL_RADIUS) },
    { part: 'aperture', d: circle(focal, focal, TERMINAL_RADIUS) },
  ];
}
