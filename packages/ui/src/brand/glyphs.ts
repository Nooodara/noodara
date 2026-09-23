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
//
// An advance is a measure of INK, not of bounding box (see `advanceBeforeBowl`). Six of the seven
// letters are as wide at every height as they are at their widest, so for them the two measures
// agree; the "r" is not, and it carries an optical kern for that reason.

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

/** How far the next round letter's origin may stand from the "r"'s origin.
 *
 *  The "r" is the only letter here whose ink reaches its widest at a single height -- the
 *  shoulder's terminal, on the x-height line. Below that the letter falls back to its stem, so the
 *  pair "r" + "a" opens a wedge of white no other pair in the word has, and at every size the word
 *  reads "noodar a" (visible on all six 07-04 boards and in every in-app capture).
 *
 *  A bounding box cannot see that: it records the widest point as if the letter were that wide at
 *  every height. What the eye reads is the narrowest run of white between two inks, and for every
 *  other pair in "noodara" that run IS one LETTER_GAP -- two round flanks, or two straight stems,
 *  at their closest approach. So the "r" is spaced by the same measure instead of by its box, and
 *  this function returns the advance that leaves the pair exactly one LETTER_GAP of white where it
 *  comes closest (the wordmark assembly adds that LETTER_GAP itself).
 *
 *  Closed form, with the "r" at x = 0 and h measured up from the springline: the shoulder's right
 *  edge stands at `APERTURE_RADIUS - sqrt(counter^2 - h^2)` while it follows the counter, and at
 *  `APERTURE_RADIUS` above that; the following bowl's left flank stands
 *  `APERTURE_RADIUS - sqrt(APERTURE_RADIUS^2 - h^2)` right of its own origin. Their difference,
 *  `sqrt(APERTURE_RADIUS^2 - h^2) - sqrt(counter^2 - h^2)`, is largest exactly where the counter
 *  ends -- the terminal's inner corner, h = counter -- and there it is the aperture circle's own
 *  half-chord at that height. Equalising the white AREA between the pairs instead gives the same
 *  number to two decimals, so the two ways of reading the gap agree.
 *
 *  The result (5.196 units against the bounding box's 7.5 at the current constants) is a real
 *  negative kern: the "a" begins inside the "r"'s box, tucked under the shoulder, which is where
 *  this pair is set in geometric sans faces. That is what D-07's tight tracking means for the one
 *  pair whose boxes misreport its spacing. */
function advanceBeforeBowl(): number {
  const counter = counterRadius();
  return Math.sqrt(APERTURE_RADIUS * APERTURE_RADIUS - counter * counter);
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
    // In "noodara" the "r" is always followed by the final "a", so it is always followed by a
    // bowl. Were a flat-sided letter ever to follow it, this pair would need its own measure.
    advance: advanceBeforeBowl(),
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
