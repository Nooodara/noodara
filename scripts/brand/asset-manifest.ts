// The pure asset manifest for the brand's static export set (07-06-PLAN.md Task 1, D-10, D-11,
// D-12).
//
// PURE MODULE, NO I/O. Nothing here reads a file, a path or the clock -- the caller
// (`generate-brand-assets.ts`, this module's own test) reads `packages/ui/tokens.css` off disk
// and hands the parsed string in via `readBrandTokens`. That is what lets the exactness test
// (07-06 Task 3) call the exact same functions the generator calls and diff the result against
// the committed files, with no generator process in the loop.
//
// NO COLOUR LITERAL. Every colour in every asset this module builds comes from the `BrandTokens`
// the caller passed in, which itself comes from `packages/ui/tokens.css` via `parseTokensCss`
// (07-01/05-33's `contrast.ts`). This file contains no hex, no `rgb(` -- `check:ui-safety` does
// not scan `scripts/`, but this module's own acceptance gate (07-06-PLAN.md) greps it directly for
// the same reason: a literal colour here is a second, driftable copy of the design system.
//
// NO HAND-DRAWN VECTOR OUTLINE. `buildTextAssets` and `ogSvg` never emit an SVG path element of
// their own -- every mark is `renderStaticSvg`/`tileSvg` output from `packages/ui/src/brand/static-svg.ts`
// (07-03), which is itself a render of the live `Logo`/`Wordmark`/`Lockup` components (D-10: one
// render path for the app and every export). The only shapes this module assembles by hand are a
// full-bleed background `<rect>` (the OG canvas) and a `<text>` element (the OG tagline) -- neither
// is "the mark".

import path from 'node:path';
import { parseTokensCss } from '../../packages/ui/src/contrast.js';
import { lockupLayout, type ConceptId } from '../../packages/ui/src/brand/geometry.js';
import { renderStaticSvg, tileSvg } from '../../packages/ui/src/brand/static-svg.js';

/** `scripts/brand/` -> repo root, matching `write-if-changed.ts`'s and `review-paths.ts`'s own
 *  resolution -- paths come from this module's own location, never from the process's working
 *  directory. */
const REPO_ROOT = path.resolve(import.meta.dirname, '../..');

/** Where every committed brand asset lives. */
export const BRAND_DIR = path.join(REPO_ROOT, 'packages', 'ui', 'brand');

/** The 13 files `generate-brand-assets.ts` ever writes to `BRAND_DIR` -- nothing else, and this
 *  list is the only place that names them. */
export const ASSET_FILES = [
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
] as const;

export interface BrandTokens {
  readonly inkLight: string;
  readonly inkDark: string;
  readonly canvasDark: string;
  readonly accentFill: string;
  readonly onAccent: string;
  readonly fontSans: string;
}

const HEX_RE = /^#[0-9a-f]{6}$/i;

function requiredToken(tokens: Record<string, string>, name: string): string {
  const value = tokens[name];
  if (value === undefined) {
    throw new Error(`asset-manifest.ts: tokens.css declares no --${name}`);
  }
  return value;
}

/** Reads the five colour tokens and the system font stack out of a tokens.css-shaped string via
 *  `parseTokensCss`. `--accent-fill` and `--on-accent` are the same value in both themes (see
 *  tokens.css's own comments), so they are read from the light block; `--font-sans` is declared
 *  once, theme-independent, also under `:root`. Throws by name rather than silently producing an
 *  empty/undefined asset. */
export function readBrandTokens(tokensCss: string): BrandTokens {
  const { light, dark } = parseTokensCss(tokensCss);

  const inkLight = requiredToken(light, 'ink');
  const inkDark = requiredToken(dark, 'ink');
  const canvasDark = requiredToken(dark, 'canvas');
  const accentFill = requiredToken(light, 'accent-fill');
  const onAccent = requiredToken(light, 'on-accent');
  const fontSans = requiredToken(light, 'font-sans');

  const colourChecks: ReadonlyArray<readonly [string, string]> = [
    ['inkLight', inkLight],
    ['inkDark', inkDark],
    ['canvasDark', canvasDark],
    ['accentFill', accentFill],
    ['onAccent', onAccent],
  ];
  for (const [name, value] of colourChecks) {
    if (!HEX_RE.test(value)) {
      throw new Error(`asset-manifest.ts: ${name} ("${value}") is not a #rrggbb colour`);
    }
  }
  if (!fontSans.includes('Inter')) {
    throw new Error('asset-manifest.ts: --font-sans does not name Inter');
  }

  return { inkLight, inkDark, canvasDark, accentFill, onAccent, fontSans };
}

/** The tile's corner radius as a fraction of its size: `--r-md` (10px) on a 44px control, so the
 *  favicon/app-icon corner belongs to the system's own radius family at every icon size (D-11). */
const TILE_RADIUS_RATIO = 10 / 44;

/** Every `.svg`/`.json` asset whose bytes can be produced with no rasterizer -- read back
 *  byte-for-byte by the Task 3 exactness test. */
export function buildTextAssets(tokens: BrandTokens, concept: ConceptId): ReadonlyMap<string, string> {
  const assets = new Map<string, string>();

  assets.set('monogram-light.svg', renderStaticSvg({ kind: 'monogram', concept, color: tokens.inkLight }));
  assets.set('monogram-dark.svg', renderStaticSvg({ kind: 'monogram', concept, color: tokens.inkDark }));
  assets.set('wordmark-light.svg', renderStaticSvg({ kind: 'wordmark', concept, color: tokens.inkLight }));
  assets.set('wordmark-dark.svg', renderStaticSvg({ kind: 'wordmark', concept, color: tokens.inkDark }));
  assets.set('lockup-light.svg', renderStaticSvg({ kind: 'lockup', concept, color: tokens.inkLight }));
  assets.set('lockup-dark.svg', renderStaticSvg({ kind: 'lockup', concept, color: tokens.inkDark }));
  // D-11: the favicon tile is the one surface that carries the accent blue.
  assets.set(
    'favicon.svg',
    tileSvg({
      concept,
      background: tokens.accentFill,
      ink: tokens.onAccent,
      size: 512,
      radiusRatio: TILE_RADIUS_RATIO,
    }),
  );
  assets.set(
    'brand-colors.json',
    `${JSON.stringify({ themeColor: tokens.accentFill, backgroundColor: tokens.canvasDark }, null, 2)}\n`,
  );

  return assets;
}

export interface RasterSpec {
  readonly filename: string;
  readonly svg: string;
  readonly width: number;
  readonly height: number;
  /** CSS colour to flatten the SVG onto before rasterizing (always set for an asset that must be
   *  fully opaque -- the rounded tile's corners and the OG canvas are otherwise transparent). */
  readonly background?: string;
  /** Set only for the three favicon tile sizes: `generate-brand-assets.ts` never writes these to
   *  `BRAND_DIR` on their own, it only packs them into the named `.ico` file (D-11). */
  readonly packInto?: string;
}

const OG_WIDTH = 1200;
const OG_HEIGHT = 630;

/** The three favicon-only raster sizes packed into `favicon.ico` (07-02's `pngsToIco`). */
const FAVICON_TILE_SIZES = [16, 32, 48] as const;

/** Every raster asset the generator produces: three opaque icon tiles, two transparent PWA icons,
 *  the opaque OG image, and the three tile sizes that only ever end up inside `favicon.ico`. */
export function rasterSpecs(tokens: BrandTokens, concept: ConceptId): readonly RasterSpec[] {
  const tile = (size: number) =>
    tileSvg({ concept, background: tokens.accentFill, ink: tokens.onAccent, size, radiusRatio: TILE_RADIUS_RATIO });

  const specs: RasterSpec[] = [
    // D-11: opaque -- an app icon with a transparent surround looks broken on a home screen.
    { filename: 'apple-touch-icon.png', svg: tile(180), width: 180, height: 180, background: tokens.accentFill },
    // PWA maskable is out of scope (07-06-PLAN.md) -- plain, transparent-cornered icons.
    { filename: 'icon-192.png', svg: tile(192), width: 192, height: 192 },
    { filename: 'icon-512.png', svg: tile(512), width: 512, height: 512 },
    // D-12: the OG canvas is opaque by definition -- a social card preview has no theme of its own.
    {
      filename: 'og-image.png',
      svg: ogSvg(tokens, concept),
      width: OG_WIDTH,
      height: OG_HEIGHT,
      background: tokens.canvasDark,
    },
  ];

  for (const size of FAVICON_TILE_SIZES) {
    specs.push({
      filename: `favicon-${String(size)}.png`,
      svg: tile(size),
      width: size,
      height: size,
      packInto: 'favicon.ico',
    });
  }

  return specs;
}

/** Lifts one lockup part group out of a rendered lockup, matching `static-svg.ts`'s own
 *  `MONOGRAM_GROUP_RE` non-greedy-to-first-closing-tag approach -- exact because neither group
 *  nests another `<g>` inside it (see `Lockup.tsx`). */
function extractLockupGroup(lockupMarkup: string, part: 'monogram' | 'wordmark'): string {
  const re =
    part === 'monogram'
      ? /<g data-part="monogram">[\s\S]*?<\/g>/
      : /<g data-part="wordmark"[\s\S]*?<\/g>/;
  const match = re.exec(lockupMarkup);
  if (match === null) {
    // Fail loud: a silent fallback here would ship an OG image with a missing mark.
    throw new Error(`asset-manifest.ts: the lockup render carried no "${part}" group to place on the OG image`);
  }
  return match[0];
}

/** How wide the lockup renders on the 1200x630 OG canvas, and where its left edge sits (D-12:
 *  centred horizontally, well clear of the canvas edge on every side). */
const OG_LOCKUP_WIDTH = 560;
const OG_LOCKUP_X = (OG_WIDTH - OG_LOCKUP_WIDTH) / 2;
const OG_LOCKUP_Y = 230;

/** The tagline (D-12). Named once, here, so a grep for it across this file always finds exactly
 *  one occurrence. */
const OG_TAGLINE = 'Your infrastructure, understood.';
const OG_TAGLINE_Y = 420;
const OG_TAGLINE_FONT_SIZE = 40;
// The display type role's own tracking (`--text-display-tracking: -0.02em`, tokens.css) applied
// in absolute px at this font size -- not re-read from tokens.css (BrandTokens carries colours and
// the font stack only), but the same ratio the system's `display` role uses everywhere else.
const OG_TAGLINE_LETTER_SPACING = OG_TAGLINE_FONT_SIZE * -0.02;

/** The D-12 Open Graph image: the dark canvas, the approved lockup in light ink (lifted out of a
 *  real `renderStaticSvg({kind:'lockup', ...})` render, never redrawn), and the tagline in the
 *  system font stack. No gradient, no glow, no shadow, no filter -- brief SS9's hard prohibitions,
 *  restated by 07-CONTEXT.md D-12. */
export function ogSvg(tokens: BrandTokens, concept: ConceptId): string {
  const lockupMarkup = renderStaticSvg({ kind: 'lockup', concept, color: tokens.inkDark });
  const monogram = extractLockupGroup(lockupMarkup, 'monogram');
  const wordmark = extractLockupGroup(lockupMarkup, 'wordmark');

  const layout = lockupLayout(concept);
  const scale = OG_LOCKUP_WIDTH / layout.width;

  return [
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${String(OG_WIDTH)} ${String(OG_HEIGHT)}" width="${String(OG_WIDTH)}" height="${String(OG_HEIGHT)}">`,
    `<rect width="${String(OG_WIDTH)}" height="${String(OG_HEIGHT)}" fill="${tokens.canvasDark}"/>`,
    `<g transform="translate(${String(OG_LOCKUP_X)} ${String(OG_LOCKUP_Y)}) scale(${String(scale)})" fill="${tokens.inkDark}">`,
    monogram,
    wordmark,
    '</g>',
    `<text x="${String(OG_LOCKUP_X)}" y="${String(OG_TAGLINE_Y)}" text-anchor="start" font-family="${tokens.fontSans}" font-size="${String(OG_TAGLINE_FONT_SIZE)}" letter-spacing="${String(OG_TAGLINE_LETTER_SPACING)}" fill="${tokens.inkDark}">${OG_TAGLINE}</text>`,
    '</svg>',
    '',
  ].join('\n');
}
