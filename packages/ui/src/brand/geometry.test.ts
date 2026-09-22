import { describe, expect, it } from 'vitest';
import type { ConceptId, PathPart } from './geometry.js';
import {
  APERTURE_RADIUS,
  ASCENDER,
  BASELINE,
  CONCEPT_IDS,
  CONCEPT_META,
  DEFAULT_CONCEPT,
  GRID,
  LETTER_GAP,
  LOCKUP_GAP,
  MARGIN,
  STROKE,
  TERMINAL_RADIUS,
  X_HEIGHT,
  bar,
  circle,
  diagonalBar,
  fmt,
  lockupLayout,
  lockupParts,
  monogramParts,
  monogramPath,
  ring,
  wordmarkParts,
  wordmarkPath,
  wordmarkWidth,
} from './geometry.js';
import { meta as metaA, parts as partsA } from './concepts/a.js';
import { meta as metaB, parts as partsB } from './concepts/b.js';
import { meta as metaC, parts as partsC } from './concepts/c.js';

// ---------------------------------------------------------------------------------------------
// Path-parsing helpers
//
// The plan's behaviour bullets are phrased as "every numeric token lies within [lo, hi]". That
// phrasing is only literally checkable for a path built from M/L/H/V, where every token IS a
// coordinate. An elliptical-arc command carries five non-coordinate tokens (rx, ry, x-axis
// rotation, large-arc flag, sweep flag) before its endpoint, so a raw token scan of any path
// containing an `A` measures radii and flags as if they were coordinates -- e.g.
// `ring(12, 12, 5, 3)` emits the tokens `5`, `3`, `0` and `1`, none of which is a point on the
// ring and none of which lies inside the ring's real bounding box of [7, 17].
//
// These helpers therefore parse the path properly and answer the question the bullets actually
// mean: where is the ink. `pathPoints` walks the command list and returns real points, expanding
// every arc into its endpoint plus whichever of the four axis extremes (0deg, 90deg, 180deg,
// 270deg) genuinely lies on the swept portion -- so the top of a semicircle is measured even
// though it is never an explicit coordinate in the `d` string. `pathBounds` reduces that to a
// bounding box. `numbersOf` is kept for the cases where the raw token set IS the subject (the
// T-07-01 character-set gate and the monogram's 0..GRID token range, where radii and flags are
// themselves inside the asserted range).
// ---------------------------------------------------------------------------------------------

interface Point {
  readonly x: number;
  readonly y: number;
}

interface Bounds {
  readonly minX: number;
  readonly maxX: number;
  readonly minY: number;
  readonly maxY: number;
}

const TOKEN_RE = /[A-Za-z]|-?\d*\.?\d+/g;
const NUMBER_RE = /-?\d*\.?\d+/g;
const COMMAND_RE = /[A-Za-z]/g;

function tokensOf(d: string): string[] {
  return d.match(TOKEN_RE) ?? [];
}

function numbersOf(d: string): number[] {
  return (d.match(NUMBER_RE) ?? []).map(Number);
}

function commandsOf(d: string): string[] {
  return d.match(COMMAND_RE) ?? [];
}

/** The axis extremes (and the endpoint) of a circular arc, derived from SVG's own endpoint-to-
 *  centre parameterisation. Only circular arcs (rx === ry, zero x-axis rotation) are handled --
 *  the brand geometry never emits any other kind. */
function arcPoints(from: Point, to: Point, radius: number, largeArc: boolean, sweep: boolean): Point[] {
  const points: Point[] = [to];
  const hx = (from.x - to.x) / 2;
  const hy = (from.y - to.y) / 2;
  const chordHalf = Math.hypot(hx, hy);
  if (chordHalf === 0) return points;
  const r = chordHalf > radius ? chordHalf : radius;
  const factor = Math.sqrt(Math.max(0, r * r - chordHalf * chordHalf) / (chordHalf * chordHalf));
  const sign = largeArc === sweep ? -1 : 1;
  const cx = sign * factor * hy + (from.x + to.x) / 2;
  const cy = sign * factor * -hx + (from.y + to.y) / 2;

  const startAngle = Math.atan2(from.y - cy, from.x - cx);
  const endAngle = Math.atan2(to.y - cy, to.x - cx);
  let delta = endAngle - startAngle;
  if (sweep && delta < 0) delta += 2 * Math.PI;
  if (!sweep && delta > 0) delta -= 2 * Math.PI;

  for (const quadrant of [0, 1, 2, 3]) {
    const angle = (quadrant * Math.PI) / 2;
    const raw = sweep ? angle - startAngle : startAngle - angle;
    const travelled = ((raw % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI);
    if (travelled <= Math.abs(delta) + 1e-9) {
      points.push({ x: cx + r * Math.cos(angle), y: cy + r * Math.sin(angle) });
    }
  }
  return points;
}

/** Every point the ink of `d` actually reaches (see the block comment above). */
function pathPoints(d: string): Point[] {
  const tokens = tokensOf(d);
  const points: Point[] = [];
  let index = 0;
  const next = (): number => Number(tokens[index++]);
  let current: Point = { x: 0, y: 0 };
  let subpathStart: Point = current;

  while (index < tokens.length) {
    const command = tokens[index++];
    switch (command) {
      case 'M':
        current = { x: next(), y: next() };
        subpathStart = current;
        points.push(current);
        break;
      case 'L':
        current = { x: next(), y: next() };
        points.push(current);
        break;
      case 'H':
        current = { x: next(), y: current.y };
        points.push(current);
        break;
      case 'V':
        current = { x: current.x, y: next() };
        points.push(current);
        break;
      case 'A': {
        const radius = next();
        next(); // ry -- always equal to rx in this module
        next(); // x-axis rotation -- always 0 in this module
        const largeArc = next() === 1;
        const sweep = next() === 1;
        const endpoint = { x: next(), y: next() };
        points.push(...arcPoints(current, endpoint, radius, largeArc, sweep));
        current = endpoint;
        break;
      }
      case 'Z':
        current = subpathStart;
        break;
      default:
        throw new Error(`unexpected path command "${String(command)}" in "${d}"`);
    }
  }
  return points;
}

function pathBounds(d: string): Bounds {
  const points = pathPoints(d);
  const xs = points.map((p) => p.x);
  const ys = points.map((p) => p.y);
  return { minX: Math.min(...xs), maxX: Math.max(...xs), minY: Math.min(...ys), maxY: Math.max(...ys) };
}

/** The sweep flag of every `A` command, in order -- the mechanism that makes a ring's hole a hole
 *  under SVG's default (nonzero) fill rule: the inner circle must wind against the outer one. */
function sweepFlagsOf(d: string): number[] {
  const tokens = tokensOf(d);
  const flags: number[] = [];
  for (let i = 0; i < tokens.length; i += 1) {
    if (tokens[i] === 'A') flags.push(Number(tokens[i + 5]));
  }
  return flags;
}

function distance(a: Point, b: Point): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

function midpoint(a: Point, b: Point): Point {
  return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
}

/** The closed subpaths of `d` -- one per `M`. */
function subpathsOf(d: string): string[] {
  return d
    .split(/(?=M)/)
    .map((segment) => segment.trim())
    .filter((segment) => segment.length > 0);
}

/** The radius of every `A` command, in order. */
function arcRadiiOf(d: string): number[] {
  const tokens = tokensOf(d);
  const radii: number[] = [];
  for (let i = 0; i < tokens.length; i += 1) {
    if (tokens[i] === 'A') radii.push(Number(tokens[i + 1]));
  }
  return radii;
}

function partFor(concept: ConceptId, name: string): PathPart {
  const found = monogramParts(concept).find((part) => part.part === name);
  if (found === undefined) throw new Error(`concept ${concept} has no part "${name}"`);
  return found;
}

function glyphFor(name: string): PathPart {
  const found = wordmarkParts(DEFAULT_CONCEPT).find((part) => part.part === name);
  if (found === undefined) throw new Error(`the wordmark has no part "${name}"`);
  return found;
}

function partNames(concept: ConceptId): string[] {
  return monogramParts(concept).map((part) => part.part);
}

const CENTRE: Point = { x: GRID / 2, y: GRID / 2 };

/** The mid-point of the two vertices of `segment` closest to `CENTRE` -- i.e. where that segment
 *  of a split diagonal stops. */
function innerEnd(segment: string): Point {
  const sorted = [...pathPoints(segment)].sort((a, b) => distance(a, CENTRE) - distance(b, CENTRE));
  const [first, second] = sorted;
  if (first === undefined || second === undefined) throw new Error(`"${segment}" has fewer than two points`);
  return midpoint(first, second);
}

function pointAt(d: string, index: number): Point {
  const point = pathPoints(d)[index];
  if (point === undefined) throw new Error(`no point at index ${String(index)} in "${d}"`);
  return point;
}

// ---------------------------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------------------------

describe('grid constants', () => {
  it('is a 24-unit grid (D-15 -- never change)', () => {
    expect(GRID).toBe(24);
  });

  it('keeps MARGIN, STROKE and APERTURE_RADIUS positive integers that fit the grid', () => {
    for (const [name, value] of [
      ['MARGIN', MARGIN],
      ['STROKE', STROKE],
      ['APERTURE_RADIUS', APERTURE_RADIUS],
    ] as const) {
      expect(Number.isInteger(value), `${name} must be an integer grid unit`).toBe(true);
      expect(value, `${name} must be positive`).toBeGreaterThan(0);
    }
    expect(2 * MARGIN + STROKE).toBeLessThan(GRID);
  });

  it('derives TERMINAL_RADIUS from STROKE and puts the baseline one margin above the box', () => {
    expect(TERMINAL_RADIUS).toBe(STROKE / 2);
    expect(BASELINE).toBe(GRID - MARGIN);
  });
});

// ---------------------------------------------------------------------------------------------
// Primitives
// ---------------------------------------------------------------------------------------------

describe('fmt', () => {
  it('prints an integer with no decimal part', () => {
    expect(fmt(12)).toBe('12');
  });

  it('keeps a meaningful fraction', () => {
    expect(fmt(1.5)).toBe('1.5');
  });

  it('caps at three decimals so output is byte-stable across machines', () => {
    expect(fmt(0.12345)).toBe('0.123');
  });

  it('never emits negative zero', () => {
    expect(fmt(-0)).toBe('0');
    expect(fmt(-0.0001)).toBe('0');
  });
});

describe('bar', () => {
  const d = bar(0, 0, 4, 24);

  it('is a closed rectangle drawn with axis-aligned commands only', () => {
    expect(d.startsWith('M')).toBe(true);
    expect(d.endsWith('Z')).toBe(true);
    expect(new Set(commandsOf(d))).toEqual(new Set(['M', 'H', 'V', 'Z']));
    for (const command of commandsOf(d)) {
      expect('MLHVZ').toContain(command);
    }
  });

  it('spans exactly the requested box', () => {
    expect(pathBounds(d)).toEqual({ minX: 0, maxX: 4, minY: 0, maxY: 24 });
  });
});

describe('ring', () => {
  const d = ring(12, 12, 5, 3);

  it('is two concentric arc subpaths -- four arcs, two closepaths, no curves', () => {
    expect(commandsOf(d).filter((c) => c === 'A')).toHaveLength(4);
    expect(commandsOf(d).filter((c) => c === 'Z')).toHaveLength(2);
    expect(d).not.toMatch(/[CQSTcqst]/);
  });

  it('stays inside the circle it describes', () => {
    expect(pathBounds(d)).toEqual({ minX: 7, maxX: 17, minY: 7, maxY: 17 });
  });

  it('winds the inner circle against the outer one so the hole is a hole under the default fill rule', () => {
    expect(sweepFlagsOf(d)).toEqual([1, 1, 0, 0]);
  });
});

describe('circle', () => {
  it('is a filled disc -- two arcs, one closepath, no inner hole', () => {
    const d = circle(12, 12, 2);
    expect(commandsOf(d).filter((c) => c === 'A')).toHaveLength(2);
    expect(commandsOf(d).filter((c) => c === 'Z')).toHaveLength(1);
    expect(pathBounds(d)).toEqual({ minX: 10, maxX: 14, minY: 10, maxY: 14 });
  });
});

describe('diagonalBar', () => {
  const d = diagonalBar(0, 0, 24, 24, 4);

  it('is a closed four-vertex polygon', () => {
    expect(commandsOf(d)).toEqual(['M', 'L', 'L', 'L', 'Z']);
  });

  it('offsets each end perpendicular to the segment by half the width', () => {
    const points = pathPoints(d);
    expect(points).toHaveLength(4);
    for (const point of points) {
      expect(point.x).toBeGreaterThanOrEqual(-3);
      expect(point.x).toBeLessThanOrEqual(27);
      expect(point.y).toBeGreaterThanOrEqual(-3);
      expect(point.y).toBeLessThanOrEqual(27);
    }
    // Tolerance is 3 decimals because that is exactly what `fmt` keeps -- a measured width can
    // never be closer to its nominal value than the coordinate quantisation allows.
    expect(distance(pointAt(d, 0), pointAt(d, 3))).toBeCloseTo(4, 2);
    expect(distance(pointAt(d, 1), pointAt(d, 2))).toBeCloseTo(4, 2);
  });

  it('refuses a zero-length segment rather than emitting NaN coordinates', () => {
    expect(() => diagonalBar(12, 12, 12, 12, 4)).toThrow('zero-length');
  });
});

// ---------------------------------------------------------------------------------------------
// Monogram contract -- true for every concept
// ---------------------------------------------------------------------------------------------

describe('monogram contract (every concept)', () => {
  it.each(CONCEPT_IDS)('concept %s draws a non-empty path that starts with a moveto', (concept) => {
    const d = monogramPath(concept);
    expect(d.length).toBeGreaterThan(0);
    expect(d).toMatch(/^M/);
  });

  it.each(CONCEPT_IDS)('concept %s uses lines and arcs only, never a curve (D-15)', (concept) => {
    expect(monogramPath(concept)).not.toMatch(/[CQSTcqst]/);
  });

  // T-07-01: the path string is interpolated straight into an SVG `d` attribute by 07-03/07-06,
  // so no markup-significant character may ever reach it.
  it.each(CONCEPT_IDS)('concept %s emits path characters only (T-07-01)', (concept) => {
    expect(monogramPath(concept)).toMatch(/^[MLHVAZmlhvaz0-9.\s-]+$/);
  });

  it.each(CONCEPT_IDS)('concept %s keeps every numeric token inside the 24 box', (concept) => {
    for (const value of numbersOf(monogramPath(concept))) {
      expect(value).toBeGreaterThanOrEqual(0);
      expect(value).toBeLessThanOrEqual(GRID);
    }
  });

  it.each(CONCEPT_IDS)('concept %s exposes an aperture part and a diagonal part', (concept) => {
    const names = monogramParts(concept).map((part) => part.part);
    expect(names).toContain('aperture');
    expect(names).toContain('diagonal');
  });

  it.each(CONCEPT_IDS)('concept %s is deterministic -- two calls return the same string', (concept) => {
    expect(monogramPath(concept)).toBe(monogramPath(concept));
  });

  it('draws three different marks (D-13)', () => {
    const paths = CONCEPT_IDS.map((concept) => monogramPath(concept));
    expect(new Set(paths).size).toBe(CONCEPT_IDS.length);
  });

  it('joins the parts into the path with a single space and nothing else', () => {
    for (const concept of CONCEPT_IDS) {
      expect(monogramPath(concept)).toBe(
        monogramParts(concept)
          .map((part) => part.d)
          .join(' '),
      );
    }
  });
});

describe('monogram part order and bounds (every concept)', () => {
  it.each(CONCEPT_IDS)('concept %s draws the stems or frame first, then the diagonal, then the aperture', (concept) => {
    const names = partNames(concept);
    expect(names[names.length - 1]).toBe('aperture');
    const diagonalIndex = names.indexOf('diagonal');
    expect(diagonalIndex).toBeGreaterThan(0);
    expect(diagonalIndex).toBe(names.length - 2);
    for (const name of names.slice(0, diagonalIndex)) {
      expect(['stem-left', 'stem-right', 'frame']).toContain(name);
    }
  });

  it.each(CONCEPT_IDS)('concept %s keeps every part inside the margin -- nothing touches the box edge', (concept) => {
    for (const part of monogramParts(concept)) {
      const bounds = pathBounds(part.d);
      expect(bounds.minX, `${concept}/${part.part} minX`).toBeGreaterThanOrEqual(MARGIN - 1e-9);
      expect(bounds.minY, `${concept}/${part.part} minY`).toBeGreaterThanOrEqual(MARGIN - 1e-9);
      expect(bounds.maxX, `${concept}/${part.part} maxX`).toBeLessThanOrEqual(GRID - MARGIN + 1e-9);
      expect(bounds.maxY, `${concept}/${part.part} maxY`).toBeLessThanOrEqual(GRID - MARGIN + 1e-9);
    }
  });

  it.each(CONCEPT_IDS)('concept %s keeps the stems full height so the mark still reads as an N', (concept) => {
    const skeleton = monogramParts(concept).filter((part) => part.part !== 'aperture' && part.part !== 'diagonal');
    const bounds = skeleton.map((part) => pathBounds(part.d));
    expect(Math.min(...bounds.map((b) => b.minY))).toBeCloseTo(MARGIN, 6);
    expect(Math.min(...bounds.map((b) => b.minX))).toBeCloseTo(MARGIN, 6);
    expect(Math.max(...bounds.map((b) => b.maxX))).toBeCloseTo(GRID - MARGIN, 6);
  });
});

describe("concept a -- 'Aperture'", () => {
  it('is two stems, an interrupted diagonal and the aperture ring', () => {
    expect(partNames('a')).toEqual(['stem-left', 'stem-right', 'diagonal', 'aperture']);
  });

  it('opens the diagonal at the ring: two segments that stop APERTURE_RADIUS from the centre', () => {
    const segments = subpathsOf(partFor('a', 'diagonal').d);
    expect(segments).toHaveLength(2);
    for (const segment of segments) {
      expect(pathPoints(segment)).toHaveLength(4);
      expect(distance(innerEnd(segment), CENTRE)).toBeCloseTo(APERTURE_RADIUS, 2);
    }
  });

  it('centres the aperture on the diagonal with the counter one stroke inside it', () => {
    const aperture = partFor('a', 'aperture');
    expect(pathBounds(aperture.d)).toEqual({
      minX: CENTRE.x - APERTURE_RADIUS,
      maxX: CENTRE.x + APERTURE_RADIUS,
      minY: CENTRE.y - APERTURE_RADIUS,
      maxY: CENTRE.y + APERTURE_RADIUS,
    });
    expect(arcRadiiOf(aperture.d)).toEqual([
      APERTURE_RADIUS,
      APERTURE_RADIUS,
      APERTURE_RADIUS - STROKE,
      APERTURE_RADIUS - STROKE,
    ]);
  });
});

describe("concept b -- 'Focus'", () => {
  const focal = GRID - MARGIN - STROKE / 2;

  it('is two stems, a converging diagonal and the focal disc', () => {
    expect(partNames('b')).toEqual(['stem-left', 'stem-right', 'diagonal', 'aperture']);
  });

  it('tapers the diagonal from a full stroke down to the focal point', () => {
    const segments = subpathsOf(partFor('b', 'diagonal').d);
    expect(segments).toHaveLength(1);
    const points = pathPoints(partFor('b', 'diagonal').d);
    expect(points).toHaveLength(4);
    const widthAtStart = distance(pointAt(partFor('b', 'diagonal').d, 0), pointAt(partFor('b', 'diagonal').d, 3));
    const widthAtEnd = distance(pointAt(partFor('b', 'diagonal').d, 1), pointAt(partFor('b', 'diagonal').d, 2));
    expect(widthAtStart).toBeCloseTo(STROKE, 2);
    expect(widthAtEnd).toBeLessThanOrEqual(TERMINAL_RADIUS * 2);
    expect(widthAtEnd).toBeLessThan(widthAtStart);
  });

  it('caps the convergence with a filled disc, not a ring', () => {
    const aperture = partFor('b', 'aperture');
    expect(commandsOf(aperture.d).filter((c) => c === 'A')).toHaveLength(2);
    expect(commandsOf(aperture.d).filter((c) => c === 'Z')).toHaveLength(1);
    expect(arcRadiiOf(aperture.d)).toEqual([TERMINAL_RADIUS, TERMINAL_RADIUS]);
    expect(pathBounds(aperture.d)).toEqual({
      minX: focal - TERMINAL_RADIUS,
      maxX: focal + TERMINAL_RADIUS,
      minY: focal - TERMINAL_RADIUS,
      maxY: focal + TERMINAL_RADIUS,
    });
  });

  it('runs the right stem down to the focal point, where the beam lands', () => {
    const bounds = pathBounds(partFor('b', 'stem-right').d);
    expect(bounds.maxY).toBeCloseTo(focal, 6);
    expect(bounds.minY).toBeCloseTo(MARGIN, 6);
  });
});

describe("concept c -- 'Viewfinder'", () => {
  const apertureRadius = APERTURE_RADIUS / 2;
  const returnLength = STROKE + APERTURE_RADIUS;

  it('is a bracket frame, a split diagonal and the centre ring', () => {
    expect(partNames('c')).toEqual(['frame', 'diagonal', 'aperture']);
  });

  // The returns sit on the two corners the diagonal does NOT touch. Put them on the diagonal's
  // own corners instead and the return plus the diagonal read as an arrowhead at each end -- the
  // mark stops being an N and becomes a double-headed arrow (checked by rasterising both at
  // 16/24/32px, 07-01 SUMMARY).
  it('closes the frame with an inward return at the top-right and the bottom-left corner', () => {
    const segments = subpathsOf(partFor('c', 'frame').d);
    expect(segments).toHaveLength(4);
    const boxes = segments.map((segment) => pathBounds(segment));
    expect(boxes).toContainEqual({
      minX: GRID - MARGIN - returnLength,
      maxX: GRID - MARGIN,
      minY: MARGIN,
      maxY: MARGIN + STROKE,
    });
    expect(boxes).toContainEqual({
      minX: MARGIN,
      maxX: MARGIN + returnLength,
      minY: GRID - MARGIN - STROKE,
      maxY: GRID - MARGIN,
    });
  });

  it('splits the diagonal around a gap of APERTURE_RADIUS at the centre', () => {
    const segments = subpathsOf(partFor('c', 'diagonal').d);
    expect(segments).toHaveLength(2);
    for (const segment of segments) {
      expect(distance(innerEnd(segment), CENTRE)).toBeCloseTo(APERTURE_RADIUS / 2, 2);
    }
  });

  it('sits a small ring in that gap', () => {
    const aperture = partFor('c', 'aperture');
    expect(arcRadiiOf(aperture.d)).toEqual([
      apertureRadius,
      apertureRadius,
      apertureRadius - STROKE / 2,
      apertureRadius - STROKE / 2,
    ]);
    expect(pathBounds(aperture.d)).toEqual({
      minX: CENTRE.x - apertureRadius,
      maxX: CENTRE.x + apertureRadius,
      minY: CENTRE.y - apertureRadius,
      maxY: CENTRE.y + apertureRadius,
    });
  });
});

describe('concept metadata', () => {
  it.each(CONCEPT_IDS)('concept %s is named and its meaning is about seeing clearly (D-02)', (concept) => {
    const meta = CONCEPT_META[concept];
    expect(meta.id).toBe(concept);
    expect(meta.name.length).toBeGreaterThan(0);
    expect(meta.meaning.length).toBeGreaterThan(0);
    // D-02 excludes "connecting" and "order over complexity" as the ideas the mark encodes.
    expect(meta.meaning.toLowerCase()).not.toContain('connect');
    expect(meta.meaning.toLowerCase()).not.toContain('order');
  });

  it('each concept module re-exports its own entry of the table', () => {
    expect(metaA).toEqual(CONCEPT_META.a);
    expect(metaB).toEqual(CONCEPT_META.b);
    expect(metaC).toEqual(CONCEPT_META.c);
  });

  it('dispatches to the concept module that owns the construction', () => {
    expect(monogramParts('a')).toEqual(partsA());
    expect(monogramParts('b')).toEqual(partsB());
    expect(monogramParts('c')).toEqual(partsC());
  });

  it('defaults to a real concept until 07-05 records the approved one', () => {
    expect(CONCEPT_IDS).toContain(DEFAULT_CONCEPT);
  });
});

// ---------------------------------------------------------------------------------------------
// Wordmark
// ---------------------------------------------------------------------------------------------

describe('wordmark "noodara"', () => {
  it('spells the word in lowercase, one part per letter (D-06)', () => {
    expect(wordmarkParts(DEFAULT_CONCEPT).map((part) => part.part)).toEqual([
      'glyph-n',
      'glyph-o',
      'glyph-o',
      'glyph-d',
      'glyph-a',
      'glyph-r',
      'glyph-a',
    ]);
  });

  it('draws both "o" with the monogram\'s own aperture ring -- same radius, same stroke (D-08)', () => {
    const rounds = wordmarkParts('a').filter((part) => part.part === 'glyph-o');
    expect(rounds).toHaveLength(2);
    for (const round of rounds) {
      expect(commandsOf(round.d).filter((c) => c === 'A')).toHaveLength(4);
      expect(arcRadiiOf(round.d)).toEqual([
        APERTURE_RADIUS,
        APERTURE_RADIUS,
        APERTURE_RADIUS - STROKE,
        APERTURE_RADIUS - STROKE,
      ]);
      // The literal link to the symbol: the "o" is the aperture, drawn at the same size.
      expect(arcRadiiOf(round.d)).toEqual(arcRadiiOf(partFor('a', 'aperture').d));
    }
  });

  it("draws the n's stem at the monogram's stroke weight (D-05)", () => {
    const stem = subpathsOf(glyphFor('glyph-n').d)[0];
    if (stem === undefined) throw new Error('the n has no first subpath');
    const bounds = pathBounds(stem);
    expect(bounds.maxX - bounds.minX).toBeCloseTo(STROKE, 6);
    const monogramStem = pathBounds(partFor('a', 'stem-left').d);
    expect(bounds.maxX - bounds.minX).toBeCloseTo(monogramStem.maxX - monogramStem.minX, 6);
  });

  it('sets every letter on the baseline, at the x-height, with only the "d" ascending', () => {
    for (const part of wordmarkParts(DEFAULT_CONCEPT)) {
      const bounds = pathBounds(part.d);
      const top = part.part === 'glyph-d' ? BASELINE - ASCENDER : BASELINE - X_HEIGHT;
      expect(bounds.maxY, `${part.part} sits on the baseline`).toBeCloseTo(BASELINE, 6);
      expect(bounds.minY, `${part.part} reaches its own top line`).toBeCloseTo(top, 6);
    }
  });

  it('tracks the letters tight -- one LETTER_GAP between the round letters (D-07)', () => {
    const boxes = wordmarkParts(DEFAULT_CONCEPT).map((part) => pathBounds(part.d));
    for (let i = 1; i < boxes.length; i += 1) {
      const previous = boxes[i - 1];
      const current = boxes[i];
      if (previous === undefined || current === undefined) throw new Error('missing glyph box');
      expect(current.minX - previous.maxX).toBeGreaterThanOrEqual(LETTER_GAP - 1e-9);
    }
    // The two "o" are the same shape, so their gap is the tracking itself, with no bearing of
    // the glyph's own mixed in.
    const [, firstO, secondO] = boxes;
    if (firstO === undefined || secondO === undefined) throw new Error('missing the "oo"');
    expect(secondO.minX - firstO.maxX).toBeCloseTo(LETTER_GAP, 6);
  });

  it('measures its width to the last letter, with no trailing bearing', () => {
    for (const concept of CONCEPT_IDS) {
      const boxes = wordmarkParts(concept).map((part) => pathBounds(part.d));
      expect(wordmarkWidth(concept)).toBeCloseTo(Math.max(...boxes.map((box) => box.maxX)), 6);
      expect(wordmarkWidth(concept)).toBeGreaterThan(6 * (2 * APERTURE_RADIUS));
      expect(wordmarkWidth(concept)).toBeLessThan(7 * GRID);
    }
  });

  it.each(CONCEPT_IDS)('concept %s: the wordmark is lines and arcs only, inside its own box', (concept) => {
    const d = wordmarkPath(concept);
    expect(d).not.toMatch(/[CQSTcqst]/);
    expect(d).toMatch(/^[MLHVAZmlhvaz0-9.\s-]+$/);
    const bounds = pathBounds(d);
    expect(bounds.minX).toBeGreaterThanOrEqual(-1e-9);
    expect(bounds.maxX).toBeLessThanOrEqual(wordmarkWidth(concept) + 1e-9);
    expect(bounds.minY).toBeGreaterThanOrEqual(-1e-9);
    expect(bounds.maxY).toBeLessThanOrEqual(GRID + 1e-9);
  });

  it('is built from the shared constants, so every concept spells it identically', () => {
    const tail = (concept: ConceptId): string =>
      wordmarkParts(concept)
        .slice(1)
        .map((part) => part.d)
        .join(' ');
    expect(tail('a')).toBe(tail('b'));
    expect(tail('a')).toBe(tail('c'));
  });
});

// ---------------------------------------------------------------------------------------------
// Lockup
// ---------------------------------------------------------------------------------------------

describe('lockup', () => {
  it.each(CONCEPT_IDS)('concept %s: the lockup carries the wordmark as built (D-05)', (concept) => {
    expect(lockupParts(concept).wordmark).toEqual(wordmarkParts(concept));
  });

  it.each(CONCEPT_IDS)('concept %s: the lockup is as wide as the monogram, the gap and the word', (concept) => {
    expect(lockupLayout(concept).width).toBeCloseTo(GRID + LOCKUP_GAP + wordmarkWidth(concept), 6);
  });

  it.each(CONCEPT_IDS)("concept %s: the lockup's N is the monogram itself (D-05)", (concept) => {
    expect(lockupParts(concept).monogram).toEqual(monogramParts(concept));
  });

  it.each(CONCEPT_IDS)('concept %s places the monogram at the origin and the wordmark after the gap', (concept) => {
    const layout = lockupLayout(concept);
    expect(layout.monogramX).toBe(0);
    expect(layout.wordmarkX).toBe(GRID + LOCKUP_GAP);
    expect(layout.height).toBe(GRID);
    // The glyph builders already draw on the shared baseline (GRID - MARGIN), so the wordmark
    // needs no vertical translation to sit on the monogram's bottom edge.
    expect(layout.wordmarkY).toBe(0);
  });
});
