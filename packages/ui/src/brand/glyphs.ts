// The lowercase glyphs of the "noodara" wordmark, drawn from the monogram's own constants.
//
// The two "o" ARE the monogram's aperture: the same ring, at the same radius, with the same
// counter (D-08) -- the wordmark's signature detail is that the symbol's opening reappears inside
// the word, quietly, as a letter rather than as a pair of eyes. For the same reason the "n" stem
// is the monogram's stem: one STROKE, not a weight chosen for text (D-05). Nothing here depends
// on a font, so there is no licence to carry and no hinting to lose at 14px.
//
// Every glyph is a filled outline built from `bar`, `ring` and single arcs on the shared grid:
// baseline at BASELINE, x-height X_HEIGHT (which is the aperture's diameter), ascender ASCENDER.
// A glyph is drawn at an x origin and reports the advance to the next origin; the wordmark
// assembly in geometry.ts adds LETTER_GAP between advances and never touches a coordinate.
//
// Where a stem meets a curve (the "n", the "r") the stem starts at the springline -- the height
// where the curve's own outline takes over -- and not at the x-height line. A stem drawn to the
// x-height there would cover the arch with a flat-topped rectangle and leave a visible step in
// the outline instead of a shoulder.

import {
  APERTURE_RADIUS,
  ASCENDER,
  BASELINE,
  STROKE,
  X_HEIGHT,
  arcTo,
  bar,
  fmt,
  ring,
} from './geometry.js';

export interface Glyph {
  readonly part: `glyph-${string}`;
  readonly d: string;
  /** Distance from this glyph's x origin to the next one, before LETTER_GAP is added. */
  readonly advance: number;
}

/** The centre line of every round letter: half an x-height above the baseline, which puts the
 *  ring's top on the x-height line and its bottom on the baseline. */
function roundCentreY(): number {
  return BASELINE - X_HEIGHT / 2;
}

/** The height at which a curve takes over from a stem (the "n" shoulder, the "r" shoulder). */
function springline(): number {
  return roundCentreY();
}

/** The counter radius shared by every round letter -- one stroke inside the outer ring. */
function counterRadius(): number {
  return APERTURE_RADIUS - STROKE;
}

/** The bowl of o, d and a: the monogram's aperture ring (D-08). */
function bowl(x: number): string {
  return ring(x + APERTURE_RADIUS, roundCentreY(), APERTURE_RADIUS, counterRadius());
}

/** The straight right-hand stem of d and a, tangent to the bowl's counter. */
function rightStem(x: number, top: number): string {
  return bar(x + 2 * APERTURE_RADIUS - STROKE, top, STROKE, BASELINE - top);
}

export function glyphO(x: number): Glyph {
  return { part: 'glyph-o', d: bowl(x), advance: 2 * APERTURE_RADIUS };
}

export function glyphN(x: number): Glyph {
  const cy = springline();
  const inner = counterRadius();
  // Half an annulus: the outer arc from the left stem over the apex to the right stem, then back
  // along the counter. Its flat bottom edge meets both stems exactly, because the counter radius
  // is the outer radius less one stroke, which is where each stem's inner edge stands.
  const arch = [
    `M${fmt(x)} ${fmt(cy)}`,
    arcTo(APERTURE_RADIUS, 1, x + 2 * APERTURE_RADIUS, cy),
    `L${fmt(x + APERTURE_RADIUS + inner)} ${fmt(cy)}`,
    arcTo(inner, 0, x + APERTURE_RADIUS - inner, cy),
    'Z',
  ].join(' ');
  return {
    part: 'glyph-n',
    d: [bar(x, cy, STROKE, BASELINE - cy), bar(x + 2 * APERTURE_RADIUS - STROKE, cy, STROKE, BASELINE - cy), arch].join(
      ' ',
    ),
    advance: 2 * APERTURE_RADIUS,
  };
}

export function glyphD(x: number): Glyph {
  return {
    part: 'glyph-d',
    d: [bowl(x), rightStem(x, BASELINE - ASCENDER)].join(' '),
    advance: 2 * APERTURE_RADIUS,
  };
}

/** Single-storey, geometric: the bowl plus a straight stem at full x-height (no spur, no tail). */
export function glyphA(x: number): Glyph {
  return {
    part: 'glyph-a',
    d: [bowl(x), rightStem(x, BASELINE - X_HEIGHT)].join(' '),
    advance: 2 * APERTURE_RADIUS,
  };
}

export function glyphR(x: number): Glyph {
  const cy = springline();
  const inner = counterRadius();
  // The shoulder is the rising quarter of the n's arch, cut off at the top: it ends in a flat
  // vertical terminal on the x-height line.
  const shoulder = [
    `M${fmt(x)} ${fmt(cy)}`,
    arcTo(APERTURE_RADIUS, 1, x + APERTURE_RADIUS, cy - APERTURE_RADIUS),
    `L${fmt(x + APERTURE_RADIUS)} ${fmt(cy - inner)}`,
    arcTo(inner, 0, x + APERTURE_RADIUS - inner, cy),
    'Z',
  ].join(' ');
  return {
    part: 'glyph-r',
    d: [bar(x, cy, STROKE, BASELINE - cy), shoulder].join(' '),
    // The shoulder's ink stops at the terminal; the extra half stroke is this letter's own
    // trailing bearing, so the next letter does not sit under the overhang.
    advance: APERTURE_RADIUS + STROKE / 2,
  };
}

/** The word, left to right. The only place the letter order of "noodara" is written down. */
export const WORDMARK_GLYPHS: readonly ((x: number) => Glyph)[] = [
  glyphN,
  glyphO,
  glyphO,
  glyphD,
  glyphA,
  glyphR,
  glyphA,
];
