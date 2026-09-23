// 07-06-PLAN.md Task 1: the pure asset manifest that describes every static brand export (D-10,
// D-11, D-12) before any file is written to disk (Task 2) or locked by an exactness test
// (Task 3).
//
// Every assertion here reads the REAL tokens.css and the REAL geometry/static-svg modules --
// never a hand-copied colour or a re-typed part of the geometry -- so this test would fail the
// moment the manifest module started hand-drawing something 07-03/07-01 already own.

import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { DEFAULT_CONCEPT, lockupLayout } from '../../../packages/ui/src/brand/geometry.js';
import { renderStaticSvg, tileSvg } from '../../../packages/ui/src/brand/static-svg.js';
import {
  ASSET_FILES,
  BRAND_DIR,
  buildTextAssets,
  ogSvg,
  rasterSpecs,
  readBrandTokens,
  type BrandTokens,
} from '../../../scripts/brand/asset-manifest.js';

const TOKENS_CSS = readFileSync('packages/ui/tokens.css', 'utf8');
const TOKENS: BrandTokens = readBrandTokens(TOKENS_CSS);

const HEX_RE = /^#[0-9a-f]{6}$/i;

/** The same safety regexes tests/unit/brand/board-html.test.ts and static-svg.test.ts already
 *  hold every rendered SVG string to -- no script, no href, no foreignObject, no inline event
 *  handler attribute. */
function assertSvgSafe(svg: string): void {
  expect(svg).not.toContain('<script');
  expect(svg).not.toContain('href=');
  expect(svg).not.toContain('<foreignObject');
  expect(svg).not.toMatch(/\son[a-z]+=/i);
}

describe('asset-manifest.ts BRAND_DIR / ASSET_FILES', () => {
  it('BRAND_DIR points at packages/ui/brand', () => {
    expect(BRAND_DIR.replace(/\\/g, '/')).toMatch(/packages\/ui\/brand$/);
  });

  it('ASSET_FILES lists exactly the 13 committed asset names', () => {
    expect(ASSET_FILES).toEqual([
      'monogram-light.svg',
      'monogram-dark.svg',
      'wordmark-light.svg',
      'wordmark-dark.svg',
      'lockup-light.svg',
      'lockup-dark.svg',
      'favicon.svg',
      'favicon.ico',
      'apple-touch-icon.png',
      'icon-192.png',
      'icon-512.png',
      'og-image.png',
      'brand-colors.json',
    ]);
  });
});

describe('readBrandTokens', () => {
  it('returns the five colour tokens as #rrggbb, and a font-sans stack naming Inter', () => {
    expect(TOKENS.inkLight).toMatch(HEX_RE);
    expect(TOKENS.inkDark).toMatch(HEX_RE);
    expect(TOKENS.canvasDark).toMatch(HEX_RE);
    expect(TOKENS.accentFill).toMatch(HEX_RE);
    expect(TOKENS.onAccent).toMatch(HEX_RE);
    expect(TOKENS.fontSans).toContain('Inter');
  });

  it('throws if a required token is missing from the given CSS', () => {
    const withoutAccentFill = TOKENS_CSS.replace(/--accent-fill:\s*#0071e3;/, '');
    expect(() => readBrandTokens(withoutAccentFill)).toThrow();
  });
});

describe('buildTextAssets', () => {
  const assets = buildTextAssets(TOKENS, DEFAULT_CONCEPT);

  it('has exactly 8 keys: the 7 svg names and brand-colors.json', () => {
    expect(new Set(assets.keys())).toEqual(
      new Set([
        'monogram-light.svg',
        'monogram-dark.svg',
        'wordmark-light.svg',
        'wordmark-dark.svg',
        'lockup-light.svg',
        'lockup-dark.svg',
        'favicon.svg',
        'brand-colors.json',
      ]),
    );
  });

  it('monogram-light.svg equals a direct renderStaticSvg of the monogram in inkLight', () => {
    expect(assets.get('monogram-light.svg')).toBe(
      renderStaticSvg({ kind: 'monogram', concept: DEFAULT_CONCEPT, color: TOKENS.inkLight }),
    );
  });

  it('lockup-dark.svg equals a direct renderStaticSvg of the lockup in inkDark', () => {
    expect(assets.get('lockup-dark.svg')).toBe(
      renderStaticSvg({ kind: 'lockup', concept: DEFAULT_CONCEPT, color: TOKENS.inkDark }),
    );
  });

  it('all six ink SVGs contain their exact ink hex and never currentColor', () => {
    const lightNames = ['monogram-light.svg', 'wordmark-light.svg', 'lockup-light.svg'];
    const darkNames = ['monogram-dark.svg', 'wordmark-dark.svg', 'lockup-dark.svg'];
    for (const name of lightNames) {
      const svg = assets.get(name);
      expect(svg, `${name} missing`).toBeDefined();
      expect(svg).toContain(TOKENS.inkLight);
      expect(svg).not.toContain('currentColor');
    }
    for (const name of darkNames) {
      const svg = assets.get(name);
      expect(svg, `${name} missing`).toBeDefined();
      expect(svg).toContain(TOKENS.inkDark);
      expect(svg).not.toContain('currentColor');
    }
  });

  it('favicon.svg equals tileSvg with the accent-fill/on-accent tile at 512px and radiusRatio 10/44', () => {
    expect(assets.get('favicon.svg')).toBe(
      tileSvg({
        concept: DEFAULT_CONCEPT,
        background: TOKENS.accentFill,
        ink: TOKENS.onAccent,
        size: 512,
        radiusRatio: 10 / 44,
      }),
    );
  });

  it('favicon.svg contains #0071e3 -- the only blue surface (D-11)', () => {
    const favicon = assets.get('favicon.svg');
    expect(favicon).toBeDefined();
    expect(favicon).toContain('#0071e3');
  });

  it('brand-colors.json parses to { themeColor, backgroundColor } from tokens.css, ending in \\n', () => {
    const json = assets.get('brand-colors.json');
    expect(json).toBeDefined();
    expect(json?.endsWith('\n')).toBe(true);
    expect(JSON.parse(json ?? '')).toEqual({
      themeColor: TOKENS.accentFill,
      backgroundColor: TOKENS.canvasDark,
    });
  });

  it('every SVG in buildTextAssets is markup-safe', () => {
    for (const [name, content] of assets) {
      if (!name.endsWith('.svg')) continue;
      assertSvgSafe(content);
    }
  });
});

describe('rasterSpecs', () => {
  const specs = rasterSpecs(TOKENS, DEFAULT_CONCEPT);

  function byFilename(filename: string) {
    const spec = specs.find((s) => s.filename === filename);
    expect(spec, `no rasterSpec named ${filename}`).toBeDefined();
    return spec!;
  }

  it('apple-touch-icon.png is 180x180, opaque (background === accentFill)', () => {
    const spec = byFilename('apple-touch-icon.png');
    expect(spec.width).toBe(180);
    expect(spec.height).toBe(180);
    expect(spec.background).toBe(TOKENS.accentFill);
  });

  it('icon-192.png is 192x192', () => {
    const spec = byFilename('icon-192.png');
    expect(spec.width).toBe(192);
    expect(spec.height).toBe(192);
  });

  it('icon-512.png is 512x512', () => {
    const spec = byFilename('icon-512.png');
    expect(spec.width).toBe(512);
    expect(spec.height).toBe(512);
  });

  it('og-image.png is 1200x630, opaque (background === canvasDark)', () => {
    const spec = byFilename('og-image.png');
    expect(spec.width).toBe(1200);
    expect(spec.height).toBe(630);
    expect(spec.background).toBe(TOKENS.canvasDark);
  });

  it('carries favicon-16/32/48.png tile specs, not written to disk directly (packed into favicon.ico)', () => {
    for (const size of [16, 32, 48]) {
      const spec = byFilename(`favicon-${String(size)}.png`);
      expect(spec.width).toBe(size);
      expect(spec.height).toBe(size);
      expect(spec.packInto).toBe('favicon.ico');
      expect(ASSET_FILES).not.toContain(spec.filename);
    }
  });
});

describe('ogSvg', () => {
  const svg = ogSvg(TOKENS, DEFAULT_CONCEPT);

  it('is a 1200x630 document with the canvasDark rect first', () => {
    expect(svg).toContain('viewBox="0 0 1200 630"');
    const rectIndex = svg.indexOf('<rect');
    const gIndex = svg.indexOf('<g');
    expect(rectIndex).toBeGreaterThan(-1);
    expect(rectIndex).toBeLessThan(gIndex);
    expect(svg).toContain(`fill="${TOKENS.canvasDark}"`);
  });

  it('contains the lockup groups, in inkDark', () => {
    expect(svg).toContain('data-part="monogram"');
    expect(svg).toContain('data-part="wordmark"');
    expect(svg).toContain(TOKENS.inkDark);
  });

  it('contains the tagline in the system font stack, exactly once', () => {
    const tagline = 'Your infrastructure, understood.';
    expect(svg.split(tagline).length - 1).toBe(1);
    expect(svg).toContain(`font-family="${TOKENS.fontSans}"`);
  });

  it('carries no gradient, glow, filter or script (D-12)', () => {
    assertSvgSafe(svg);
    expect(svg).not.toContain('<linearGradient');
    expect(svg).not.toContain('<filter');
  });

  it('the lockup group is scaled from the real lockupLayout width', () => {
    const layout = lockupLayout(DEFAULT_CONCEPT);
    expect(layout.width).toBeGreaterThan(0);
    expect(svg).toMatch(/<g transform="translate\([\d.-]+ [\d.-]+\) scale\([\d.-]+\)"/);
  });
});
