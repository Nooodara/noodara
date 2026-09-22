// Noodara brand geometry -- the single geometric definition of the mark (07-01-PLAN.md, D-10,
// D-15).
//
// PURE MODULE, ZERO I/O. Nothing here reads a file, a path, an environment variable or the clock,
// and nothing here is React. That is deliberate: the same functions are imported by the React
// components that render the mark in the app (07-03), by the Node script that writes the static
// SVG/PNG/ICO/OG exports (07-06), by the construction sheet (07-08) and by this module's own
// tests. None of them may ever own a coordinate of its own -- D-10 requires one definition and
// only one, so a D-16 adjustment round is a constant edit here, not a hunt through artifacts.
//
// METHOD (D-15). Everything is built on a 24-unit grid from named constants using straight lines
// and circular arcs only -- no cubic or quadratic curves anywhere -- so a person can reproduce
// the logo from the construction sheet with a ruler and a compass. A coordinate that is not an
// expression of GRID / MARGIN / STROKE / APERTURE_RADIUS / TERMINAL_RADIUS is a bug.
//
// FILLED OUTLINES, NEVER STROKES (07-RESEARCH.md pitfall 4). Every shape here is a closed filled
// outline with the stroke weight baked into its own geometry. A consumer paints these paths with
// `fill="currentColor"` and must never set a `stroke` -- a live stroke width scales
// inconsistently between a 16px favicon raster and a 256px board render.
//
// FILL RULE: THE SVG DEFAULT (nonzero). Consumers must NOT set `fill-rule="evenodd"`. Parts
// overlap on purpose (a diagonal runs into a stem, a focal disc caps a stem), and under evenodd
// every overlap would punch a hole. The holes that ARE holes -- a ring's counter, a bowl's
// counter -- are cut by winding the inner circle against the outer one (see `ring`), which is
// exactly what the nonzero rule reads.
//
// PART NAMES ARE ANIMATION HOOKS. Each part carries a stable name that 07-03 renders as
// `data-part`. Phase 8 animates the mark (UI-08) by selecting `[data-part="aperture"]`; every
// concept therefore exposes an `aperture` part, and part order is fixed so DOM order is stable.
// Renaming or reordering a part is a breaking change for that animation, not a refactor.
//
// BYTE-STABLE OUTPUT. `fmt` caps every number at three decimals and normalises negative zero, so
// `renderToStaticMarkup` produces identical bytes on every machine and the generated-asset
// accuracy test (07-06) can diff exports byte-for-byte without an SVG minifier in the loop.

// The concept constructions this module dispatches to. They import the constants below, so the
// two files import each other; only function bindings cross the cycle, and only from inside a
// function body, so neither side can ever observe the other half-evaluated.
import { parts as conceptAParts } from './concepts/a.js';
import { parts as conceptBParts } from './concepts/b.js';
import { parts as conceptCParts } from './concepts/c.js';
// Same cycle, same rule: glyphs.ts reads the constants below, only from inside its own function
// bodies.
import { WORDMARK_GLYPHS } from './glyphs.js';

// --- Grid ------------------------------------------------------------------------------------

/** The design grid. Every coordinate in this module is expressed in these units (D-15). */
export const GRID = 24;

/** Breathing room inside the 24 box: no ink ever touches the edge of the viewBox. */
export const MARGIN = 1;

/** Stem, diagonal and wordmark stroke weight, baked into every filled outline (D-05 -- the
 *  wordmark carries the monogram's weight). Starting value for the D-16 adjustment rounds. */
export const STROKE = 3;

/** Outer radius of the monogram's aperture AND of the wordmark's "o" (D-08 -- the two are the
 *  same circle, which is the wordmark's typographic signature detail). Starting value for the
 *  D-16 adjustment rounds. */
export const APERTURE_RADIUS = 6;

/** Radius of a terminal cap -- half a stroke, so a capped stem ends flush with its own width. */
export const TERMINAL_RADIUS = STROKE / 2;

/** Wordmark x-height. It IS the aperture's diameter: the round lowercase letters are the
 *  monogram's aperture drawn at the same size (D-08), so the wordmark cannot drift from the
 *  symbol when a D-16 round retunes the aperture. */
export const X_HEIGHT = 2 * APERTURE_RADIUS;

/** Wordmark ascender height (the "d"). Chosen to sit just under the monogram's cap height in the
 *  lockup, so the ascender reads as related to the N rather than competing with it. */
export const ASCENDER = 18;

/** Side bearing between two glyphs -- tight tracking (D-07). */
export const LETTER_GAP = 2;

/** Gap between the monogram and the wordmark in the horizontal lockup (D-04). */
export const LOCKUP_GAP = 6;

/** The wordmark's baseline, which is also the monogram's bottom edge -- the line the lockup
 *  aligns on. */
export const BASELINE = GRID - MARGIN;

// --- Types -----------------------------------------------------------------------------------

export const CONCEPT_IDS = ['a', 'b', 'c'] as const;
export type ConceptId = (typeof CONCEPT_IDS)[number];

/** Placeholder until docs/brand/APPROVAL.md records the chosen concept (07-05). */
export const DEFAULT_CONCEPT: ConceptId = 'a';

export type MonogramPartName = 'stem-left' | 'diagonal' | 'stem-right' | 'aperture' | 'frame';

export interface PathPart {
  readonly part: MonogramPartName | `glyph-${string}`;
  readonly d: string;
}

export interface ConceptMeta {
  readonly id: ConceptId;
  readonly name: string;
  /** One sentence, in English, on how this construction says "seeing clearly" (D-02). Quoted
   *  verbatim by the brand board (07-04) and the brand kit (07-08). */
  readonly meaning: string;
}

/** The three concepts' names and meanings, returned from a function rather than read off a
 *  module-level object on purpose: `geometry.ts` and `concepts/*.ts` import each other (the
 *  dispatcher needs the constructions, the constructions need the constants), and a function
 *  declaration is initialised before any module body runs, so neither side can observe the other
 *  half-evaluated no matter which file the import graph is entered from. */
export function conceptMeta(id: ConceptId): ConceptMeta {
  switch (id) {
    case 'a':
      return {
        id,
        name: 'Aperture',
        meaning:
          'The diagonal opens into an aperture -- the mark is a lens, and infrastructure is what it brings into view.',
      };
    case 'b':
      return {
        id,
        name: 'Focus',
        meaning: 'Two strokes converge on a single point: the moment a scattered signal resolves into something clear.',
      };
    case 'c':
      return {
        id,
        name: 'Viewfinder',
        meaning: 'The letter becomes a viewfinder -- brackets frame the subject and the centre ring is where it sharpens.',
      };
  }
}

export const CONCEPT_META: Readonly<Record<ConceptId, ConceptMeta>> = Object.freeze({
  a: conceptMeta('a'),
  b: conceptMeta('b'),
  c: conceptMeta('c'),
});

// --- Primitives ------------------------------------------------------------------------------

/** Formats a coordinate: at most three decimals, no trailing zeros, no negative zero. This is
 *  what makes the rendered SVG byte-identical on every machine (see the module header). */
export function fmt(n: number): string {
  const rounded = Number(n.toFixed(3));
  return Object.is(rounded, -0) ? '0' : String(rounded);
}

/** An axis-aligned filled rectangle, wound clockwise on screen so it unions (never cancels) with
 *  every other part under the nonzero fill rule. */
export function bar(x: number, y: number, w: number, h: number): string {
  return `M${fmt(x)} ${fmt(y)} H${fmt(x + w)} V${fmt(y + h)} H${fmt(x)} Z`;
}

/** A full circle as two half-circle arc commands (no cubic approximation, D-15). `sweep` 1 winds it with
 *  `bar`, so it fills; `sweep` 0 winds it against, so it cuts a hole out of whatever it sits
 *  inside. */
export function circle(cx: number, cy: number, r: number, sweep: 0 | 1 = 1): string {
  const left = fmt(cx - r);
  const right = fmt(cx + r);
  const y = fmt(cy);
  const radius = fmt(r);
  const flag = String(sweep);
  return `M${left} ${y} A${radius} ${radius} 0 1 ${flag} ${right} ${y} A${radius} ${radius} 0 1 ${flag} ${left} ${y} Z`;
}

/** A ring: an outer circle with an inner circle wound against it, so the counter is a real hole
 *  under the default (nonzero) fill rule. Arcs only -- four of them. */
export function ring(cx: number, cy: number, rOuter: number, rInner: number): string {
  return `${circle(cx, cy, rOuter, 1)} ${circle(cx, cy, rInner, 0)}`;
}

/** A filled quadrilateral along the segment (x1,y1)-(x2,y2), `widthStart` wide at the first end
 *  and `widthEnd` wide at the second, offset perpendicular to the segment by half the width at
 *  each end. Vertex order runs down one side and back up the other so the winding matches `bar`
 *  whatever direction the segment points in. */
export function taperedBar(
  x1: number,
  y1: number,
  x2: number,
  y2: number,
  widthStart: number,
  widthEnd: number,
): string {
  const dx = x2 - x1;
  const dy = y2 - y1;
  const length = Math.hypot(dx, dy);
  if (length === 0) {
    throw new Error('brand geometry: a zero-length segment has no direction to offset from');
  }
  const nx = -dy / length;
  const ny = dx / length;
  const hs = widthStart / 2;
  const he = widthEnd / 2;
  return [
    `M${fmt(x1 - nx * hs)} ${fmt(y1 - ny * hs)}`,
    `L${fmt(x2 - nx * he)} ${fmt(y2 - ny * he)}`,
    `L${fmt(x2 + nx * he)} ${fmt(y2 + ny * he)}`,
    `L${fmt(x1 + nx * hs)} ${fmt(y1 + ny * hs)}`,
    'Z',
  ].join(' ');
}

/** A filled bar of constant width along the segment (x1,y1)-(x2,y2). */
export function diagonalBar(x1: number, y1: number, x2: number, y2: number, width: number): string {
  return taperedBar(x1, y1, x2, y2, width, width);
}

/** A single circular arc command to (x,y), radius `r`, no x-axis rotation. */
export function arcTo(r: number, sweep: 0 | 1, x: number, y: number, largeArc: 0 | 1 = 0): string {
  return `A${fmt(r)} ${fmt(r)} 0 ${String(largeArc)} ${String(sweep)} ${fmt(x)} ${fmt(y)}`;
}

// --- Monogram --------------------------------------------------------------------------------

/** The parts of one concept's monogram, in stable DOM order (stems or frame first, then the
 *  diagonal, then the aperture -- see the module header on animation hooks). */
export function monogramParts(concept: ConceptId): readonly PathPart[] {
  switch (concept) {
    case 'a':
      return conceptAParts();
    case 'b':
      return conceptBParts();
    case 'c':
      return conceptCParts();
  }
}

/** The whole monogram as one `d` string -- the parts joined by a single space. Safe because every
 *  part is a closed subpath and the fill rule is nonzero. */
export function monogramPath(concept: ConceptId): string {
  return monogramParts(concept)
    .map((part) => part.d)
    .join(' ');
}

// --- Wordmark --------------------------------------------------------------------------------

/** Lays "noodara" out left to right from x = 0, advancing by each glyph's own advance plus one
 *  LETTER_GAP, and measures the result. One function so the parts and the width can never
 *  disagree. */
function layoutWordmark(): { readonly parts: readonly PathPart[]; readonly width: number } {
  const parts: PathPart[] = [];
  let x = 0;
  for (const build of WORDMARK_GLYPHS) {
    const glyph = build(x);
    parts.push({ part: glyph.part, d: glyph.d });
    x += glyph.advance + LETTER_GAP;
  }
  // The last advance carries no gap after it: the word ends at its last letter (D-07).
  return { parts, width: x - LETTER_GAP };
}

// The wordmark is the same for all three concepts: D-05 ties it to the shared constants (stroke,
// aperture radius, grid), not to any one concept's construction. The parameter is kept because
// 07-05's approved concept may introduce a per-concept terminal on the "n", and every downstream
// caller already passes the concept it is rendering.

export function wordmarkParts(_concept: ConceptId): readonly PathPart[] {
  return layoutWordmark().parts;
}

export function wordmarkPath(concept: ConceptId): string {
  return wordmarkParts(concept)
    .map((part) => part.d)
    .join(' ');
}

/** The width of the word in grid units, measured to the last letter's ink. */
export function wordmarkWidth(_concept: ConceptId): number {
  return layoutWordmark().width;
}

// --- Lockup ----------------------------------------------------------------------------------

export interface LockupLayout {
  readonly width: number;
  readonly height: number;
  readonly monogramX: number;
  readonly wordmarkX: number;
  readonly wordmarkY: number;
}

/** Where the two elements of the horizontal lockup sit, in grid units (D-04). */
export function lockupLayout(concept: ConceptId): LockupLayout {
  const wordmarkX = GRID + LOCKUP_GAP;
  return {
    width: wordmarkX + wordmarkWidth(concept),
    height: GRID,
    monogramX: 0,
    wordmarkX,
    // The glyph builders already draw on BASELINE (= GRID - MARGIN), which is the monogram's own
    // bottom edge, so the wordmark needs no vertical translation inside the lockup.
    wordmarkY: 0,
  };
}

/** The lockup's own parts. The N in the lockup IS the monogram -- never a second drawing of it
 *  (D-05). */
export function lockupParts(concept: ConceptId): {
  readonly monogram: readonly PathPart[];
  readonly wordmark: readonly PathPart[];
} {
  return { monogram: monogramParts(concept), wordmark: wordmarkParts(concept) };
}
