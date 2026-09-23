// 07-04-PLAN.md Task 1: the brand board (D-14) as a pure string builder.
//
// The board is what the user reads in 07-05 next to the in-app captures, so every element D-14
// names has to actually be on it -- three lockups, a construction sheet on the real 24 grid, the
// 16/32/64/256 scale ladder, the favicon tile on two SIMULATED tab strips (Pitfall 2: Playwright
// cannot screenshot the browser's own chrome, so the board says so in words) and the D-12 OG
// preview.
//
// The board draws NOTHING of its own: every mark on it is `renderStaticSvg`/`tileSvg` output from
// 07-03, i.e. a render of the very components the app mounts. The only colour literals it may
// carry outside the inlined tokens block are the four the caller passed in (the tile's two, the
// OG's two); everything else is a `var(--token)` reference, so the board is the design system
// rendering itself rather than a copy of it.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  APERTURE_RADIUS,
  CONCEPT_IDS,
  CONCEPT_META,
  GRID,
  MARGIN,
  STROKE,
  type ConceptId,
} from '../../../packages/ui/src/brand/geometry.js';
import { parseTokensCss } from '../../../packages/ui/src/contrast.js';
import { BOARD_SCALES, buildBoardHtml, type BoardOptions } from '../../../scripts/brand/board-html.js';

const SOURCE = readFileSync('scripts/brand/board-html.ts', 'utf8');
const TOKENS_CSS = readFileSync('packages/ui/tokens.css', 'utf8');
const TOKENS = parseTokensCss(TOKENS_CSS);

function tokenValue(theme: 'light' | 'dark', name: string): string {
  const value = TOKENS[theme][name];
  if (value === undefined) throw new Error(`board-html.test.ts: tokens.css has no --${name} in the ${theme} theme`);
  return value;
}

const TILE = { background: tokenValue('light', 'accent-fill'), ink: tokenValue('light', 'on-accent') } as const;
const OG = { canvas: tokenValue('dark', 'canvas'), ink: tokenValue('dark', 'ink') } as const;

function options(concept: ConceptId, theme: 'light' | 'dark'): BoardOptions {
  return { concept, theme, tokensCss: TOKENS_CSS, tile: TILE, og: OG };
}

function board(concept: ConceptId = 'a', theme: 'light' | 'dark' = 'light'): string {
  return buildBoardHtml(options(concept, theme));
}

/** Everything the board says outside its `<style>` elements. Every colour literal the board is
 *  allowed to carry lives inside those elements (the inlined tokens, plus the light-theme block
 *  derived from them for the simulated tab strip) -- the four caller-supplied values are the only
 *  hexes that may appear in the markup itself. */
function markupWithoutStyles(html: string): string {
  return html.replace(/<style[^>]*>[\s\S]*?<\/style>/g, '');
}

function section(html: string, name: string): string {
  const match = new RegExp(`<section data-board-section="${name}"[\\s\\S]*?</section>`).exec(html);
  if (match === null) throw new Error(`board-html.test.ts: no <section data-board-section="${name}"> on the board`);
  return match[0];
}

function lockupItem(html: string, kind: string): string {
  const match = new RegExp(`<figure data-board-lockup="${kind}"[\\s\\S]*?</figure>`).exec(html);
  if (match === null) throw new Error(`board-html.test.ts: no <figure data-board-lockup="${kind}"> on the board`);
  return match[0];
}

function count(haystack: string, needle: string): number {
  return haystack.split(needle).length - 1;
}

describe('buildBoardHtml document envelope', () => {
  it('is a standalone HTML document', () => {
    expect(board().startsWith('<!doctype html>')).toBe(true);
  });

  it('names the theme on the root element, explicitly in both themes', () => {
    expect(board('a', 'dark')).toContain('<html lang="en" data-theme="dark">');
    expect(board('a', 'light')).toContain('<html lang="en" data-theme="light">');
  });

  it('inlines the tokens CSS verbatim inside a style element', () => {
    const html = board();
    expect(html).toContain(TOKENS_CSS);
    const styles = html.match(/<style[^>]*>[\s\S]*?<\/style>/g) ?? [];
    expect(styles.some((style) => style.includes(TOKENS_CSS))).toBe(true);
  });

  it('paints itself from the tokens, never from a literal', () => {
    const html = board();
    expect(html).toContain('background: var(--canvas)');
    expect(html).toContain('color: var(--ink)');
  });

  it('carries no colour literal beyond the four the caller passed in', () => {
    for (const theme of ['light', 'dark'] as const) {
      const hexes = new Set(markupWithoutStyles(board('b', theme)).match(/#[0-9a-fA-F]{6}/g) ?? []);
      expect([...hexes].sort()).toEqual([...new Set([TILE.background, TILE.ink, OG.canvas, OG.ink])].sort());
    }
  });
});

describe('buildBoardHtml header', () => {
  it('names the concept and quotes its meaning verbatim', () => {
    for (const concept of CONCEPT_IDS) {
      const html = board(concept);
      expect(html).toContain(CONCEPT_META[concept].name);
      expect(html).toContain(CONCEPT_META[concept].meaning);
    }
  });
});

describe('buildBoardHtml lockups section (D-04)', () => {
  it('shows exactly the three lockups', () => {
    const lockups = section(board(), 'lockups');
    expect(count(lockups, 'data-board-lockup="')).toBe(3);
    for (const kind of ['monogram', 'lockup', 'wordmark']) {
      expect(lockups).toContain(`data-board-lockup="${kind}"`);
    }
  });

  it('renders the monogram alone, the wordmark alone and the lockup as both groups', () => {
    const html = board();
    const monogram = lockupItem(html, 'monogram');
    expect(count(monogram, 'data-part="monogram"')).toBe(1);
    expect(count(monogram, 'data-part="wordmark"')).toBe(0);

    const wordmark = lockupItem(html, 'wordmark');
    expect(count(wordmark, 'data-part="wordmark"')).toBe(1);
    expect(count(wordmark, 'data-part="glyph-')).toBe(7);
    expect(count(wordmark, 'data-part="monogram"')).toBe(0);

    const lockup = lockupItem(html, 'lockup');
    expect(count(lockup, 'data-part="monogram"')).toBe(1);
    expect(count(lockup, 'data-part="wordmark"')).toBe(1);
    expect(count(lockup, 'data-part="glyph-')).toBe(7);
  });

  it('lets the lockups inherit the board ink rather than baking a colour into them', () => {
    expect(section(board(), 'lockups')).toContain('fill="currentColor"');
  });
});

describe('buildBoardHtml construction sheet (D-15)', () => {
  it('draws the mark over a real 24-unit grid', () => {
    const construction = section(board(), 'construction');
    expect(construction).toContain('data-grid="24"');
    expect(construction).toContain(`data-grid="${String(GRID)}"`);
    expect(construction).toContain('stroke="var(--hairline-strong)"');
    expect(count(construction, 'data-part="monogram"')).toBe(1);
  });

  it('labels the constants with the values geometry.ts actually exports', () => {
    const construction = section(board(), 'construction');
    expect(construction).toContain(`GRID = ${String(GRID)}`);
    expect(construction).toContain(`MARGIN = ${String(MARGIN)}`);
    expect(construction).toContain(`STROKE = ${String(STROKE)}`);
    expect(construction).toContain(`APERTURE_RADIUS = ${String(APERTURE_RADIUS)}`);
  });
});

describe('buildBoardHtml scale ladder (D-14)', () => {
  it('exposes the four review scales', () => {
    expect([...BOARD_SCALES]).toEqual([16, 32, 64, 256]);
  });

  it('renders one monogram per scale, at that scale', () => {
    const scales = section(board(), 'scales');
    expect(count(scales, 'data-part="monogram"')).toBe(BOARD_SCALES.length);
    for (const scale of BOARD_SCALES) {
      expect(scales).toContain(`width="${String(scale)}" height="${String(scale)}"`);
    }
  });
});

describe('buildBoardHtml simulated tab strips (Pitfall 2)', () => {
  it('shows the favicon tile at 16 and 32 px on a light and a dark bar', () => {
    const strips = section(board(), 'tab-strips');
    expect(strips).toContain('data-strip="light"');
    expect(strips).toContain('data-strip="dark"');
    // Two bars x two sizes, each one a real `tileSvg` render carrying the caller's tile colours.
    expect(count(strips, `fill="${TILE.background}"`)).toBe(4);
    expect(count(strips, `fill="${TILE.ink}"`)).toBe(4);
    expect(count(strips, 'width="16" height="16"')).toBe(2);
    expect(count(strips, 'width="32" height="32"')).toBe(2);
  });

  it('says in words that this is a simulation, on every bar', () => {
    const strips = section(board(), 'tab-strips');
    expect(count(strips, 'Simulated browser tab — verify the real tab manually')).toBe(2);
  });
});

describe('buildBoardHtml OG preview (D-12)', () => {
  it('is a 1200x630 box in the OG canvas colour with the lockup in the OG ink', () => {
    const og = section(board(), 'og-preview');
    expect(og).toContain('data-board-og="1200x630"');
    expect(og).toContain(`background: ${OG.canvas}`);
    expect(og).toContain(`fill="${OG.ink}"`);
    expect(count(og, 'data-part="monogram"')).toBe(1);
    expect(count(og, 'data-part="wordmark"')).toBe(1);
  });

  it('carries the tagline verbatim', () => {
    expect(section(board(), 'og-preview')).toContain('Your infrastructure, understood.');
  });
});

describe('buildBoardHtml safety and determinism', () => {
  it('is inert markup: no script, no event handler, no foreignObject, no external reference', () => {
    for (const concept of CONCEPT_IDS) {
      for (const theme of ['light', 'dark'] as const) {
        const html = board(concept, theme);
        expect(html).not.toContain('<script');
        expect(markupWithoutStyles(html)).not.toMatch(/\son[a-z]+\s*=/);
        expect(html).not.toContain('<foreignObject');
        expect(html).not.toContain('href=');
        expect(html).not.toContain('src=');
        expect(html).not.toMatch(/url\(/);
      }
    }
  });

  it('carries no emoji (docs/ui-build-prompt.md §9)', () => {
    expect(board()).not.toMatch(/[\u{1F300}-\u{1FAFF}]/u);
  });

  it('renders byte-identically for the same options', () => {
    expect(board('c', 'dark')).toBe(board('c', 'dark'));
  });

  it('differs per concept', () => {
    expect(board('a')).not.toBe(board('b'));
    expect(board('b')).not.toBe(board('c'));
  });

  it('draws no geometry of its own and reads no working directory', () => {
    expect(SOURCE).not.toContain('process.cwd');
    expect(SOURCE).not.toContain('<path');
  });

  it('states the tagline and the tab-simulation disclaimer exactly once each in its own source', () => {
    expect(count(SOURCE, 'Your infrastructure, understood.')).toBe(1);
    expect(count(SOURCE, 'Simulated browser tab')).toBe(1);
  });
});
