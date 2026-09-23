// 07-08-PLAN.md Task 1 (D-15, BRAND-01): the construction sheet is GENERATED from the geometry,
// never drawn by hand.
//
// D-15's promise is that "cualquier persona reproduce el logo desde la hoja de construcción". A
// sheet drawn once by hand keeps that promise only until the first adjustment round retunes a
// constant, after which the document quietly lies about the mark the app actually renders. So the
// sheet is a pure function of `packages/ui/src/brand/geometry.ts` plus four caller-supplied
// colours, and the file committed under `docs/brand/` is diffed byte-for-byte against a fresh call
// to that function -- the same discipline `tests/unit/brand/brand-assets-accuracy.test.ts` applies
// to the 13 exported assets and `tests/unit/docs/install-docs-accuracy.test.ts` applies to
// `docs/install.md`.
//
// Nothing below is asserted by hand: every constant, part name and concept name comes from the
// module under test's own imports, and every colour is a sentinel the test itself passes in, so a
// colour literal appearing in the output could only have come from the builder.

import { readFileSync, statSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  APERTURE_RADIUS,
  BASELINE,
  CONCEPT_IDS,
  CONCEPT_META,
  DEFAULT_CONCEPT,
  GRID,
  MARGIN,
  STROKE,
  TERMINAL_RADIUS,
  monogramParts,
  type ConceptId,
} from '../../../packages/ui/src/brand/geometry.js';
import { parseTokensCss } from '../../../packages/ui/src/contrast.js';
import {
  CONSTRUCTION_SHEET_SIZE,
  constructionSheetOptions,
  constructionSvg,
} from '../../../scripts/brand/construction-sheet.js';

const TOKENS_CSS = readFileSync('packages/ui/tokens.css', 'utf8');
const SOURCE = readFileSync('scripts/brand/construction-sheet.ts', 'utf8');
const BOARD_SOURCE = readFileSync('scripts/brand/board-html.ts', 'utf8');
const COMMITTED_PATH = 'docs/brand/construction.svg';

/** Colours the design system could never produce, so anything real in the output is a literal the
 *  builder typed itself. */
const SENTINEL = {
  ink: 'sentinel-ink',
  hairline: 'sentinel-hairline',
  annotation: 'sentinel-annotation',
  font: 'sentinel-font',
} as const;

function sheet(concept: ConceptId = DEFAULT_CONCEPT): string {
  return constructionSvg({ concept, ...SENTINEL });
}

function committed(): string {
  return readFileSync(COMMITTED_PATH, 'utf8');
}

function count(haystack: string, needle: string): number {
  return haystack.split(needle).length - 1;
}

describe('constructionSvg document envelope', () => {
  it('is a standalone SVG on the 480 canvas', () => {
    const svg = sheet();
    expect(CONSTRUCTION_SHEET_SIZE).toBe(480);
    expect(svg.startsWith('<svg xmlns="http://www.w3.org/2000/svg"')).toBe(true);
    expect(svg).toContain(`viewBox="0 0 ${String(CONSTRUCTION_SHEET_SIZE)} ${String(CONSTRUCTION_SHEET_SIZE)}"`);
    expect(svg).toContain(`width="${String(CONSTRUCTION_SHEET_SIZE)}" height="${String(CONSTRUCTION_SHEET_SIZE)}"`);
    expect(svg.endsWith('</svg>\n')).toBe(true);
  });

  it('names the concept it drew, from CONCEPT_META rather than a typed string', () => {
    for (const concept of CONCEPT_IDS) {
      expect(constructionSvg({ concept, ...SENTINEL })).toContain(CONCEPT_META[concept].name);
    }
  });
});

describe('constructionSvg grid (D-15)', () => {
  it('carries the real grid size as a data attribute', () => {
    expect(sheet()).toContain('data-grid="24"');
    expect(sheet()).toContain(`data-grid="${String(GRID)}"`);
  });

  it('draws one line per grid unit on both axes, all in the hairline colour', () => {
    const svg = sheet();
    expect(count(svg, `stroke="${SENTINEL.hairline}"`)).toBe(2 * (GRID + 1));
    expect(count(svg, '<line')).toBeGreaterThanOrEqual(2 * (GRID + 1));
  });

  it('marks the margin box and the baseline as guides, in the annotation colour', () => {
    const svg = sheet();
    expect(svg).toContain('data-guide="margin"');
    expect(svg).toContain('data-guide="baseline"');
    expect(count(svg, `stroke="${SENTINEL.annotation}"`)).toBe(2);
  });
});

describe('constructionSvg mark', () => {
  it('places the real monogram render on the grid, exactly once', () => {
    expect(count(sheet(), '<g data-part="monogram">')).toBe(1);
  });

  it('exposes every part of the approved construction under its own data-part name', () => {
    const svg = sheet();
    const parts = monogramParts(DEFAULT_CONCEPT);
    expect(parts.length).toBeGreaterThan(0);
    for (const part of parts) {
      expect(svg).toContain(`data-part="${part.part}"`);
    }
    expect(svg).toContain('data-part="aperture"');
  });

  it('paints the mark with the caller ink and never sets a stroke on it', () => {
    const svg = sheet();
    expect(svg).toContain(`fill="${SENTINEL.ink}"`);
    // Every stroke in the sheet belongs to an annotation line (grid or guide); the mark itself is
    // filled outlines only.
    expect(count(svg, 'stroke=')).toBe(2 * (GRID + 1) + 2);
  });
});

describe('constructionSvg dimension labels', () => {
  it('labels every constant with the value geometry.ts actually exports', () => {
    const svg = sheet();
    const expected: readonly (readonly [string, number])[] = [
      ['GRID', GRID],
      ['MARGIN', MARGIN],
      ['STROKE', STROKE],
      ['APERTURE_RADIUS', APERTURE_RADIUS],
      ['TERMINAL_RADIUS', TERMINAL_RADIUS],
      ['BASELINE', BASELINE],
    ];
    for (const [name, value] of expected) {
      expect(svg).toContain(`${name} = ${String(value)}`);
    }
  });

  it('lists the parts in their DOM order, so the sheet names what it draws', () => {
    const svg = sheet();
    const names = monogramParts(DEFAULT_CONCEPT).map((part) => part.part);
    expect(svg).toContain(names.join(', '));
  });

  it('sets every label in the caller font', () => {
    expect(sheet()).toContain(`font-family="${SENTINEL.font}"`);
  });
});

describe('constructionSvg safety and determinism', () => {
  it('is inert markup: no script, no event handler, no foreignObject, no external reference', () => {
    for (const concept of CONCEPT_IDS) {
      const svg = constructionSvg({ concept, ...SENTINEL });
      expect(svg).not.toContain('<script');
      expect(svg).not.toContain('<foreignObject');
      expect(svg).not.toContain('href=');
      expect(svg).not.toContain('src=');
      expect(svg).not.toMatch(/\son[a-z]+\s*=/);
      expect(svg).not.toMatch(/url\(/);
    }
  });

  it('carries no colour of its own: every colour in the output is one the caller passed in', () => {
    const svg = sheet();
    expect(svg).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
    expect(svg).not.toMatch(/\brgba?\(/);
  });

  it('renders byte-identically for the same options, and differs per concept', () => {
    expect(sheet('c')).toBe(sheet('c'));
    expect(sheet('a')).not.toBe(sheet('b'));
    expect(sheet('b')).not.toBe(sheet('c'));
  });

  it('holds no colour literal and reads no working directory in its own source', () => {
    expect(SOURCE).not.toMatch(/#[0-9a-fA-F]{6}\b/);
    expect(SOURCE).not.toContain('process.cwd');
  });

  it('draws no geometry of its own: the mark comes from the real render path', () => {
    expect(SOURCE).not.toContain('<path');
    expect(SOURCE).toContain('renderStaticSvg');
  });
});

describe('constructionSheetOptions', () => {
  it('reads its four colours out of tokens.css, never out of a literal', () => {
    const { light } = parseTokensCss(TOKENS_CSS);
    const options = constructionSheetOptions(TOKENS_CSS, DEFAULT_CONCEPT);
    expect(options.concept).toBe(DEFAULT_CONCEPT);
    expect(options.ink).toBe(light.ink);
    expect(options.hairline).toBe(light['hairline-strong']);
    expect(options.annotation).toBe(light['ink-secondary']);
    expect(options.font).toBe(light['font-mono']);
  });

  it('throws by name when the tokens file declares no such token', () => {
    expect(() => constructionSheetOptions(':root {\n  --ink: sentinel;\n}\n', DEFAULT_CONCEPT)).toThrow(
      /hairline-strong/,
    );
  });
});

describe('docs/brand/construction.svg (the committed sheet)', () => {
  it('is exactly what the builder produces today for the approved concept', () => {
    expect(committed()).toBe(constructionSvg(constructionSheetOptions(TOKENS_CSS, DEFAULT_CONCEPT)));
  });

  it('is a real sheet, not a stub', () => {
    expect(statSync(COMMITTED_PATH).size).toBeGreaterThan(2048);
    expect(committed()).toContain('data-grid="24"');
    expect(committed()).toContain('data-part="aperture"');
  });

  it('carries the design system’s own ink rather than a colour of its own', () => {
    const { light } = parseTokensCss(TOKENS_CSS);
    expect(committed()).toContain(`fill="${String(light.ink)}"`);
  });
});

describe('one construction builder, not two', () => {
  it('the brand board draws its construction section with this same module', () => {
    expect(BOARD_SOURCE).toContain("from './construction-sheet.js'");
    expect(BOARD_SOURCE).toContain('constructionSvg');
  });

  it('pnpm brand:construction runs this script', () => {
    const pkg = JSON.parse(readFileSync('package.json', 'utf8')) as { scripts: Record<string, string> };
    expect(pkg.scripts).toHaveProperty('brand:construction');
    expect(pkg.scripts['brand:construction']).toContain('scripts/brand/construction-sheet.ts');
  });
});
