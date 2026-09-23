import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { STATIC_KINDS, renderStaticSvg, tileSvg } from './static-svg.js';
import { DEFAULT_CONCEPT, GRID, fmt } from './geometry.js';

// Tests for the static-export path (07-03-PLAN.md Task 2, D-10/D-11). The point of this module is
// that the README/site SVGs and the favicon tile are RENDERS OF THE SAME COMPONENTS the app
// mounts, with a colour injected -- never a second drawing. These tests assert that identity
// (same data-part hooks, same determinism) plus the two things a committed file needs that a
// React element does not: a standalone `xmlns` root and a literal ink colour.
//
// Colours are always the caller's: `static-svg.ts` itself must contain no colour literal, so the
// real callers (07-06's generator) can read `--ink`/`--canvas`/`--accent-fill`/`--on-accent` out
// of tokens.css with `parseTokensCss` and pass them in. The source-level assertions at the bottom
// of this file are what keep that true.

// Comment lines stripped exactly as scripts/check-ui-safety.mjs's own gate does -- a header that
// explains why a literal is banned must not itself count as one.
function codeOf(relPath: string): string {
  return readFileSync(relPath, 'utf8')
    .split('\n')
    .filter((line) => {
      const trimmed = line.trim();
      return !trimmed.startsWith('//') && !trimmed.startsWith('/*') && !trimmed.startsWith('*');
    })
    .join('\n');
}

const STATIC_SVG_SOURCE = codeOf('packages/ui/src/brand/static-svg.ts');

const FORBIDDEN_MARKUP: readonly RegExp[] = [/<script/i, /href=/i, /<foreignObject/i, /\son[a-z]+=/i, /style=/i];

// The tile's monogram occupies 62% of the tile, centred -- the same proportion for every icon
// size, so the mark's optical weight in a browser tab, a home screen and a PWA splash is
// identical. Declared here as the test's own expectation of the module's behaviour.
const TILE_MONOGRAM_RATIO = 0.62;

const TILE_SIZE = 512;
// --r-md (10px) on a 44px control, expressed as a ratio so the favicon's corner belongs to the
// same radius family as every other rounded surface in the system.
const TILE_RADIUS_RATIO = 10 / 44;

describe('STATIC_KINDS', () => {
  it('is exactly the three lockups D-04 defines', () => {
    expect(STATIC_KINDS).toEqual(['monogram', 'wordmark', 'lockup']);
  });
});

describe('renderStaticSvg', () => {
  it('produces a standalone SVG document with the injected ink and no currentColor', () => {
    const svg = renderStaticSvg({ kind: 'monogram', concept: 'a', color: 'black' });

    expect(svg.startsWith('<svg xmlns="http://www.w3.org/2000/svg"')).toBe(true);
    expect(svg.endsWith('</svg>\n')).toBe(true);
    expect(svg).toContain('fill="black"');
    expect(svg).not.toContain('currentColor');
  });

  it('renders decorative markup -- the accessible name belongs to the img tag that embeds it', () => {
    const svg = renderStaticSvg({ kind: 'lockup', concept: DEFAULT_CONCEPT, color: 'black' });

    expect(svg).toContain('aria-hidden="true"');
    expect(svg).not.toContain('<title>');
    expect(svg).not.toContain('role="img"');
  });

  it('renders the monogram kind from the Logo component, with its part hooks intact', () => {
    const svg = renderStaticSvg({ kind: 'monogram', concept: 'a', color: 'black' });

    expect(svg).toContain('data-part="monogram"');
    expect(svg).toContain('data-part="aperture"');
    expect(svg).not.toContain('data-part="wordmark"');
  });

  it('renders seven glyphs for the wordmark kind', () => {
    const svg = renderStaticSvg({ kind: 'wordmark', concept: DEFAULT_CONCEPT, color: 'black' });

    expect(svg.split('data-part="glyph-').length - 1).toBe(7);
  });

  it('renders both groups for the lockup kind', () => {
    const svg = renderStaticSvg({ kind: 'lockup', concept: DEFAULT_CONCEPT, color: 'black' });

    expect(svg).toContain('data-part="monogram"');
    expect(svg).toContain('data-part="wordmark"');
  });

  it('never emits a fill rule or a stroke -- the paths depend on the SVG default (nonzero) rule', () => {
    for (const kind of STATIC_KINDS) {
      const svg = renderStaticSvg({ kind, concept: DEFAULT_CONCEPT, color: 'black' });

      expect(svg).not.toContain('fill-rule');
      expect(svg).not.toContain('stroke');
    }
  });

  it('is deterministic and free of script, link, event handler and inline style', () => {
    for (const kind of STATIC_KINDS) {
      const svg = renderStaticSvg({ kind, concept: DEFAULT_CONCEPT, color: 'black' });

      expect(svg).toBe(renderStaticSvg({ kind, concept: DEFAULT_CONCEPT, color: 'black' }));
      for (const forbidden of FORBIDDEN_MARKUP) {
        expect(svg).not.toMatch(forbidden);
      }
    }
  });
});

describe('tileSvg', () => {
  const tile = () =>
    tileSvg({
      concept: 'a',
      background: 'blue',
      ink: 'white',
      size: TILE_SIZE,
      radiusRatio: TILE_RADIUS_RATIO,
    });

  it('is a square document at the requested size', () => {
    const svg = tile();

    expect(svg.startsWith('<svg xmlns="http://www.w3.org/2000/svg"')).toBe(true);
    expect(svg).toContain(`viewBox="0 0 ${String(TILE_SIZE)} ${String(TILE_SIZE)}"`);
    expect(svg).toContain(`width="${String(TILE_SIZE)}"`);
    expect(svg).toContain(`height="${String(TILE_SIZE)}"`);
    expect(svg.endsWith('</svg>\n')).toBe(true);
  });

  it('opens with the rounded background rect, its corner radius derived from the ratio', () => {
    const svg = tile();
    const radius = Math.round(TILE_SIZE * TILE_RADIUS_RATIO);

    expect(svg).toContain(
      `<rect width="${String(TILE_SIZE)}" height="${String(TILE_SIZE)}" rx="${String(radius)}" ry="${String(radius)}" fill="blue"/>`,
    );
    expect(svg.indexOf('<rect')).toBeLessThan(svg.indexOf('data-part="monogram"'));
  });

  it('centres the monogram at 62% of the tile via one transform', () => {
    const svg = tile();
    const scale = (TILE_SIZE * TILE_MONOGRAM_RATIO) / GRID;
    const offset = (TILE_SIZE - TILE_SIZE * TILE_MONOGRAM_RATIO) / 2;

    expect(svg).toContain(`transform="translate(${fmt(offset)} ${fmt(offset)}) scale(${fmt(scale)})"`);
  });

  it('paints the monogram in the injected ink and never in currentColor', () => {
    const svg = tile();

    expect(svg).toContain('fill="white"');
    expect(svg).toContain('data-part="monogram"');
    expect(svg).not.toContain('currentColor');
  });

  it('reuses the Logo component parts, not a redrawn mark', () => {
    const svg = tile();

    expect(svg).toContain('data-part="aperture"');
    expect(svg).toContain('data-part="stem-left"');
  });

  it('is deterministic and free of script, link, event handler and inline style', () => {
    expect(tile()).toBe(tile());
    for (const forbidden of FORBIDDEN_MARKUP) {
      expect(tile()).not.toMatch(forbidden);
    }
  });
});

describe('static-svg.ts source', () => {
  it('contains no colour literal of any form -- every colour is a caller argument', () => {
    expect(STATIC_SVG_SOURCE).not.toContain('#');
    expect(STATIC_SVG_SOURCE).not.toContain('rgb(');
    expect(STATIC_SVG_SOURCE).not.toContain('currentColor');
  });

  it('draws nothing by hand -- the mark comes from the components', () => {
    expect(STATIC_SVG_SOURCE).toContain('renderToStaticMarkup');
    expect(STATIC_SVG_SOURCE).not.toContain('<path');
  });
});
