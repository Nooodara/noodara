// 07-06-PLAN.md Task 3: locks the 13 committed files under `packages/ui/brand/` to the geometry
// they were generated from (D-10). Every text asset is diffed byte-for-byte against a fresh call
// to `asset-manifest.ts`'s own pure functions -- the same discipline
// `tests/unit/docs/install-docs-accuracy.test.ts` applies to `docs/install.md` against
// `install.sh` -- and every raster asset is checked by decoded shape (07-02's own PNG/ICO bytes
// are not portable across `sharp`/libvips versions, see `generate-brand-assets.ts`'s header).

import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { DEFAULT_CONCEPT } from '../../../packages/ui/src/brand/geometry.js';
import { BRAND_DIR, buildTextAssets, readBrandTokens } from '../../../scripts/brand/asset-manifest.js';
import { pngMetadata } from '../../../scripts/brand/raster.js';

const TOKENS_CSS = readFileSync('packages/ui/tokens.css', 'utf8');
const TOKENS = readBrandTokens(TOKENS_CSS);
const TEXT_ASSETS = buildTextAssets(TOKENS, DEFAULT_CONCEPT);

function brandFile(name: string): Buffer {
  return readFileSync(path.join(BRAND_DIR, name));
}

function brandFileText(name: string): string {
  return brandFile(name).toString('utf8');
}

describe('committed text assets equal a fresh buildTextAssets() call', () => {
  for (const name of [
    'monogram-light.svg',
    'monogram-dark.svg',
    'wordmark-light.svg',
    'wordmark-dark.svg',
    'lockup-light.svg',
    'lockup-dark.svg',
    'favicon.svg',
    'brand-colors.json',
  ]) {
    it(`${name} on disk is byte-identical to buildTextAssets()'s own output`, () => {
      const expected = TEXT_ASSETS.get(name);
      expect(expected, `asset-manifest.ts produced no entry named ${name}`).toBeDefined();
      expect(brandFileText(name)).toBe(expected);
    });
  }
});

describe('raster asset shapes (dimensions + alpha, never raw bytes -- see header)', () => {
  it('apple-touch-icon.png is 180x180 and opaque', async () => {
    const meta = await pngMetadata(brandFile('apple-touch-icon.png'));
    expect(meta.width).toBe(180);
    expect(meta.height).toBe(180);
    expect(meta.hasAlpha).toBe(false);
  });

  it('icon-192.png is 192x192', async () => {
    const meta = await pngMetadata(brandFile('icon-192.png'));
    expect(meta.width).toBe(192);
    expect(meta.height).toBe(192);
  });

  it('icon-512.png is 512x512', async () => {
    const meta = await pngMetadata(brandFile('icon-512.png'));
    expect(meta.width).toBe(512);
    expect(meta.height).toBe(512);
  });

  it('og-image.png is 1200x630 and opaque', async () => {
    const meta = await pngMetadata(brandFile('og-image.png'));
    expect(meta.width).toBe(1200);
    expect(meta.height).toBe(630);
    expect(meta.hasAlpha).toBe(false);
  });
});

describe('favicon.ico', () => {
  const ico = brandFile('favicon.ico');

  it('starts with the ICO magic header 00 00 01 00', () => {
    expect(ico.subarray(0, 4)).toEqual(Buffer.from([0x00, 0x00, 0x01, 0x00]));
  });

  it('has exactly 3 directory entries', () => {
    expect(ico.readUInt16LE(4)).toBe(3);
  });

  it('the 3 entries are the 16/32/48 tile sizes (ICO width byte: 0 means 256)', () => {
    const widths: number[] = [];
    for (let i = 0; i < 3; i++) {
      const entryOffset = 6 + i * 16;
      const widthByte = ico.readUInt8(entryOffset);
      widths.push(widthByte === 0 ? 256 : widthByte);
    }
    expect(widths.sort((a, b) => a - b)).toEqual([16, 32, 48]);
  });
});

describe('SVG markup safety (T-07-16)', () => {
  const svgFiles = readdirSync(BRAND_DIR).filter((f) => f.endsWith('.svg'));

  it('found the 7 committed SVG files', () => {
    expect(svgFiles.length).toBe(7);
  });

  for (const name of [
    'monogram-light.svg',
    'monogram-dark.svg',
    'wordmark-light.svg',
    'wordmark-dark.svg',
    'lockup-light.svg',
    'lockup-dark.svg',
    'favicon.svg',
  ]) {
    it(`${name} contains no <script, href=, <foreignObject, inline event handler, <linearGradient or <filter`, () => {
      const svg = brandFileText(name);
      expect(svg).not.toContain('<script');
      expect(svg).not.toContain('href=');
      expect(svg).not.toContain('<foreignObject');
      expect(svg).not.toMatch(/\son[a-z]+=/i);
      expect(svg).not.toContain('<linearGradient');
      expect(svg).not.toContain('<filter');
    });
  }
});

describe('accent blue is committed in exactly one place (D-11)', () => {
  it('favicon.svg contains the accent-fill hex', () => {
    expect(brandFileText('favicon.svg')).toContain(TOKENS.accentFill);
  });

  it('no other committed .svg carries the accent-fill hex', () => {
    const svgFiles = readdirSync(BRAND_DIR).filter((f) => f.endsWith('.svg') && f !== 'favicon.svg');
    expect(svgFiles.length).toBeGreaterThan(0);
    for (const name of svgFiles) {
      expect(brandFileText(name), `${name} unexpectedly contains the accent colour`).not.toContain(TOKENS.accentFill);
    }
  });
});
